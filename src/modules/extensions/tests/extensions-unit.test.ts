// Unit tests for the extensions module's pure logic (no database): the
// semver order and compatibility range, the permission/capability/
// quota rule set (including cron and https-origin validation), the
// lifecycle state machine, the verification checks and derived state,
// and the full validation/normalization surface of manifest
// registrations, transitions and queries. Storage-level guarantees
// (immutability triggers, append-only evidence, tenant scoping) are
// covered by extensions-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  EXTENSION_LIFECYCLE_STATES,
  EXTENSION_TRANSITIONS,
  canTransitionExtension,
  isExtensionLifecycleState,
  isExtensionTransition,
  targetLifecycleState,
} from '../lifecycle';
import {
  EXTENSION_PERMISSIONS,
  EXTENSION_STATE_SCOPES,
  EXTENSION_UI_SURFACES,
  capabilityDeclarationProblems,
  capabilityPermissionProblems,
  capabilityQuotaProblems,
  isEventTopic,
  isExtensionPermission,
  isExtensionStateScope,
  isExtensionUiSurface,
  isHttpsOrigin,
  isValidCronExpression,
  requiredPermissionsForCapabilities,
  type ExtensionCapabilities,
  type ExtensionQuotas,
} from '../manifest-rules';
import {
  checkHostRuntimeCompatibility,
  compareSemver,
  formatSemver,
  isSemver,
  parseSemver,
} from '../semver';
import {
  EXTENSION_VERIFICATION_CHECKS,
  EXTENSION_VERIFICATION_STATES,
  MANIFEST_SCHEMA_VERSIONS,
  deriveVerificationState,
  isExtensionVerificationCheck,
  isExtensionVerificationState,
  isSupportedManifestSchemaVersion,
  runManifestVerificationChecks,
  summarizeVerificationRun,
  verificationOutcomeFor,
  type ManifestVerificationSubject,
} from '../verification';
import { ExtensionsError } from '../errors';
import {
  assertExtensionsTenantContext,
  validateCheckManifestCompatibilityQuery,
  validateGetExtensionQuery,
  validateListExtensionLifecycleEventsQuery,
  validateListExtensionsQuery,
  validateListManifestsQuery,
  validateRegisterExtensionManifestInput,
  validateTransitionExtensionInput,
} from '../validation';
import type { RegisterExtensionManifestInput } from '../types';

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionsError);
    expect((error as ExtensionsError).code).toBe(code);
  }
}

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [], ...overrides };
}

/** A consistent capability declaration exercising every capability area. */
function fullCapabilities(): ExtensionCapabilities {
  return {
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [
      { label: 'Invoices API', origin: 'https://api.invoices.example.com' },
    ],
    telemetry: true,
  };
}

function fullQuotas(): ExtensionQuotas {
  return {
    maxStateBytes: 1_048_576,
    maxScheduleInvocationsPerDay: 24,
    maxExternalCallsPerDay: 1_000,
  };
}

/** A fully consistent registration input. */
function validManifest(overrides: Partial<RegisterExtensionManifestInput> = {}): RegisterExtensionManifestInput {
  return {
    extensionKey: 'invoice-ocr',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [
      { label: 'Invoices API', origin: 'https://api.invoices.example.com' },
    ],
    telemetry: true,
    quotas: fullQuotas(),
    hostRuntime: { minVersion: '1.2.0', maxVersion: '2.0.0' },
    ...overrides,
  };
}

/** The verification subject of a stored, consistent manifest. */
function validSubject(): ManifestVerificationSubject {
  return {
    manifestSchemaVersion: 1,
    requestedPermissions: [...(validManifest().requestedPermissions ?? [])],
    capabilities: fullCapabilities(),
    quotas: fullQuotas(),
    hostCompatibility: { minVersion: '1.2.0', maxVersion: '2.0.0' },
  };
}

// ---------------------------------------------------------------------------
// Semver (the version order and the compatibility range)
// ---------------------------------------------------------------------------

describe('semver (release-only, total order)', () => {
  it('parses well-formed release semvers', () => {
    expect(parseSemver('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('2147483647.0.0')).not.toBeNull();
  });

  it('rejects malformed versions', () => {
    for (const bad of [
      '', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', '1.2.3-beta',
      '1.2.3+build', 'v1.2.3', ' 1.2.3', '1.2.x', '-1.2.3', '2147483648.0.0',
    ]) {
      expect(isSemver(bad)).toBe(false);
      expect(parseSemver(bad)).toBeNull();
    }
    expect(isSemver(1)).toBe(false);
    expect(isSemver(null)).toBe(false);
  });

  it('orders numerically, never lexicographically', () => {
    expect(compareSemver(parseSemver('1.2.10')!, parseSemver('1.2.9')!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver('1.10.0')!, parseSemver('1.9.9')!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver('2.0.0')!, parseSemver('1.99.99')!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver('1.2.3')!, parseSemver('1.2.3')!)).toBe(0);
    expect(compareSemver(parseSemver('0.99.99')!, parseSemver('1.0.0')!)).toBeLessThan(0);
  });

  it('round-trips through formatSemver', () => {
    expect(formatSemver(parseSemver('12.34.56')!)).toBe('12.34.56');
  });

  it('checks host runtime compatibility against the declared range', () => {
    const range = { minVersion: parseSemver('1.2.0')!, maxVersion: parseSemver('2.0.0')! };
    expect(checkHostRuntimeCompatibility('1.2.0', range)).toEqual({ compatible: true, reasons: [] });
    expect(checkHostRuntimeCompatibility('1.5.0', range)).toEqual({ compatible: true, reasons: [] });
    expect(checkHostRuntimeCompatibility('2.0.0', range)).toEqual({ compatible: true, reasons: [] });
    expect(checkHostRuntimeCompatibility('1.1.9', range)).toEqual({
      compatible: false,
      reasons: ['host_below_minimum'],
    });
    expect(checkHostRuntimeCompatibility('2.0.1', range)).toEqual({
      compatible: false,
      reasons: ['host_above_maximum'],
    });
    // unbounded above
    const open = { minVersion: parseSemver('1.0.0')!, maxVersion: null };
    expect(checkHostRuntimeCompatibility('99.0.0', open)).toEqual({ compatible: true, reasons: [] });
    // malformed host version never passes silently
    expect(checkHostRuntimeCompatibility('one.two.three', open)).toEqual({
      compatible: false,
      reasons: ['malformed_host_version'],
    });
  });
});

// ---------------------------------------------------------------------------
// Manifest rules (permissions, capabilities, quotas, field validators)
// ---------------------------------------------------------------------------

describe('permission vocabulary (§17 capability areas → closed scopes)', () => {
  it('declares exactly the seven permission scopes, no duplicates', () => {
    expect([...EXTENSION_PERMISSIONS]).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ]);
    expect(new Set(EXTENSION_PERMISSIONS).size).toBe(EXTENSION_PERMISSIONS.length);
    for (const permission of EXTENSION_PERMISSIONS) expect(isExtensionPermission(permission)).toBe(true);
    expect(isExtensionPermission('root:system')).toBe(false);
    expect(isExtensionPermission('state:admin')).toBe(false);
  });

  it('anchors the UI surface and state scope vocabularies', () => {
    expect([...EXTENSION_UI_SURFACES]).toEqual([
      'control-tower-panel',
      'briefing-card',
      'chat-panel',
      'settings-form',
    ]);
    expect([...EXTENSION_STATE_SCOPES]).toEqual(['none', 'tenant', 'install']);
    expect(isExtensionUiSurface('chat-panel')).toBe(true);
    expect(isExtensionUiSurface('iframe')).toBe(false);
    expect(isExtensionStateScope('install')).toBe(true);
    expect(isExtensionStateScope('global')).toBe(false);
  });

  it('derives the required permissions of a capability declaration', () => {
    expect(
      requiredPermissionsForCapabilities({
        stateScope: 'none',
        uiSurfaces: [],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [],
        telemetry: false,
      }),
    ).toEqual([]);
    expect(
      requiredPermissionsForCapabilities({
        stateScope: 'install',
        uiSurfaces: [],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [],
        telemetry: false,
      }),
    ).toEqual(['state:read', 'state:write']);
    expect(
      requiredPermissionsForCapabilities({
        stateScope: 'none',
        uiSurfaces: ['briefing-card'],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [],
        telemetry: false,
      }),
    ).toEqual(['ui:render']);
    expect(requiredPermissionsForCapabilities(fullCapabilities())).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ]);
  });

  it('flags permission/capability inconsistency in BOTH directions', () => {
    const caps = fullCapabilities();
    expect(capabilityPermissionProblems(caps, requiredPermissionsForCapabilities(caps))).toEqual([]);

    // capability without its permission (undeclared capability — least privilege)
    expect(
      capabilityPermissionProblems(caps, requiredPermissionsForCapabilities(caps).filter((p) => p !== 'schedule:run')),
    ).toEqual(["capability declaration requires permission 'schedule:run' which is not requested"]);

    // permission without its capability (scope hoarding)
    expect(
      capabilityPermissionProblems(
        { ...caps, uiSurfaces: [] },
        requiredPermissionsForCapabilities(caps),
      ),
    ).toEqual(["requested permission 'ui:render' is not justified by any declared capability"]);

    // unknown permission is never justified
    expect(capabilityPermissionProblems(caps, [...requiredPermissionsForCapabilities(caps), 'root:system'])).toEqual([
      "requested permission 'root:system' is not justified by any declared capability",
    ]);
  });
});

describe('quota rules (present exactly when the capability is declared)', () => {
  it('accepts a consistent declaration and rejects every inconsistency', () => {
    expect(capabilityQuotaProblems(fullCapabilities(), fullQuotas())).toEqual([]);

    // missing quota for a declared capability
    expect(
      capabilityQuotaProblems(fullCapabilities(), { ...fullQuotas(), maxStateBytes: 0 }),
    ).toEqual(['stateScope is declared but quotas.maxStateBytes is not']);

    // over ceiling
    expect(
      capabilityQuotaProblems(fullCapabilities(), { ...fullQuotas(), maxScheduleInvocationsPerDay: 1441 }),
    ).toEqual([
      'quotas.maxScheduleInvocationsPerDay exceeds the ceiling of 1440 (got 1441)',
    ]);
    expect(
      capabilityQuotaProblems(fullCapabilities(), { ...fullQuotas(), maxExternalCallsPerDay: 100_001 }),
    ).toEqual([
      'quotas.maxExternalCallsPerDay exceeds the ceiling of 100000 (got 100001)',
    ]);

    // unjustified quota (no capability behind it)
    const inert: ExtensionCapabilities = {
      stateScope: 'none',
      uiSurfaces: [],
      schedules: [],
      eventSubscriptions: [],
      externalParticipants: [],
      telemetry: false,
    };
    expect(
      capabilityQuotaProblems(inert, { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 }),
    ).toEqual(['quotas.maxStateBytes is set without a state capability (stateScope must not be none)']);
    expect(capabilityQuotaProblems(inert, { maxStateBytes: 0, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 })).toEqual([]);
  });
});

describe('cron validation (five fields, numeric tokens)', () => {
  it('accepts well-formed expressions', () => {
    for (const good of [
      '* * * * *',
      '0 9 * * 1-5',
      '*/15 8-18 * * 1-5,7',
      '30 14 1 * 0',
      '0 0 29 2 *',
      '59 23 31 12 7',
      '0 0 1 1 0',
      '5,35 */6 * * 2',
      '1-30/7 * * * *',
    ]) {
      expect(isValidCronExpression(good), good).toBe(true);
    }
  });

  it('rejects malformed expressions', () => {
    for (const bad of [
      '', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *',
      '* * 32 * *', '* * * 13 *', '* * * * 8', 'a * * * *', 'MON * * * *',
      '1/0 * * * *', '5-1 * * * *', '*/ * * * *', '1--2 * * * *', '*  *  *  *  *  *',
    ]) {
      expect(isValidCronExpression(bad), bad).toBe(false);
    }
    // whitespace around the expression is trimmed — the grammar is what matters
    expect(isValidCronExpression('  0 9 * * 1-5  ')).toBe(true);
    // day-of-week 0 and 7 are both Sunday — both valid
    expect(isValidCronExpression('0 0 * * 7')).toBe(true);
  });
});

describe('https origin validation (scoped external participation)', () => {
  it('accepts plain https origins only', () => {
    for (const good of [
      'https://api.example.com',
      'https://api.example.com:8443',
      'https://localhost',
      'https://127.0.0.1:3000',
      'https://[2001:db8::1]:9443',
      'https://sub.domain.example.co.uk',
    ]) {
      expect(isHttpsOrigin(good), good).toBe(true);
    }
    for (const bad of [
      'http://api.example.com',
      'https://api.example.com/',
      'https://api.example.com/path',
      'https://api.example.com?q=1',
      'https://api.example.com#frag',
      'https://user@api.example.com',
      'https://',
      'ftp://example.com',
      'example.com',
      'api.example.com:8443',
      'https://api.example.com:99999',
      'https://api..example.com',
      `https://${'a'.repeat(250)}.com`,
    ]) {
      expect(isHttpsOrigin(bad), bad).toBe(false);
    }
  });

  it('validates event topics as canonical slugs', () => {
    expect(isEventTopic('invoice.received')).toBe(true);
    expect(isEventTopic('goal:drifted')).toBe(true);
    expect(isEventTopic('observation-recorded-v2')).toBe(true);
    expect(isEventTopic('')).toBe(false);
    expect(isEventTopic('has space')).toBe(false);
    expect(isEventTopic('.starts-with-dot')).toBe(false);
    expect(isEventTopic('x'.repeat(129))).toBe(false);
  });
});

describe('capability declaration problems (the capability-declarations check core)', () => {
  it('accepts a well-formed declaration and rejects each malformation', () => {
    expect(capabilityDeclarationProblems(fullCapabilities())).toEqual([]);

    expect(capabilityDeclarationProblems({ ...fullCapabilities(), stateScope: 'galaxy' as never }).length).toBe(1);
    expect(capabilityDeclarationProblems({ ...fullCapabilities(), uiSurfaces: ['iframe' as never] }).length).toBe(1);
    expect(
      capabilityDeclarationProblems({
        ...fullCapabilities(),
        schedules: [{ name: 'bad', cron: '99 * * * *' }],
      }),
    ).toEqual(["schedule 'bad' has an invalid five-field cron expression ('99 * * * *')"]);
    expect(
      capabilityDeclarationProblems({
        ...fullCapabilities(),
        eventSubscriptions: ['not a topic'],
      }).length,
    ).toBe(1);
    expect(
      capabilityDeclarationProblems({
        ...fullCapabilities(),
        externalParticipants: [{ label: 'API', origin: 'http://insecure.example.com' }],
      }),
    ).toEqual(["external participant 'API' origin 'http://insecure.example.com' is not a plain https origin"]);
    expect(capabilityDeclarationProblems({ ...fullCapabilities(), telemetry: 'yes' as never }).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (the pure state machine)
// ---------------------------------------------------------------------------

describe('lifecycle (REGISTERED → ACTIVE ⇄ SUSPENDED → DEPRECATED, terminal)', () => {
  it('declares the states and transitions', () => {
    expect([...EXTENSION_LIFECYCLE_STATES]).toEqual(['REGISTERED', 'ACTIVE', 'SUSPENDED', 'DEPRECATED']);
    expect([...EXTENSION_TRANSITIONS]).toEqual(['activate', 'suspend', 'resume', 'deprecate']);
    for (const state of EXTENSION_LIFECYCLE_STATES) expect(isExtensionLifecycleState(state)).toBe(true);
    for (const transition of EXTENSION_TRANSITIONS) expect(isExtensionTransition(transition)).toBe(true);
    expect(isExtensionLifecycleState('PUBLISHED')).toBe(false); // marketplace state — W028, not W025
    expect(isExtensionTransition('publish')).toBe(false);
  });

  it('maps each transition to its target state', () => {
    expect(targetLifecycleState('activate')).toBe('ACTIVE');
    expect(targetLifecycleState('suspend')).toBe('SUSPENDED');
    expect(targetLifecycleState('resume')).toBe('ACTIVE');
    expect(targetLifecycleState('deprecate')).toBe('DEPRECATED');
  });

  it('is the entire state machine: legal pairs pass, everything else fails', () => {
    const legal: Array<[ExtensionCapabilities['stateScope'] | string, string]> = [];
    void legal;
    expect(canTransitionExtension('REGISTERED', 'activate')).toBe(true);
    expect(canTransitionExtension('REGISTERED', 'deprecate')).toBe(true);
    expect(canTransitionExtension('ACTIVE', 'suspend')).toBe(true);
    expect(canTransitionExtension('ACTIVE', 'deprecate')).toBe(true);
    expect(canTransitionExtension('SUSPENDED', 'resume')).toBe(true);
    expect(canTransitionExtension('SUSPENDED', 'deprecate')).toBe(true);

    // everything else is illegal
    expect(canTransitionExtension('REGISTERED', 'suspend')).toBe(false);
    expect(canTransitionExtension('REGISTERED', 'resume')).toBe(false);
    expect(canTransitionExtension('ACTIVE', 'activate')).toBe(false);
    expect(canTransitionExtension('SUSPENDED', 'suspend')).toBe(false);
    // DEPRECATED is terminal — nothing leaves it
    for (const transition of EXTENSION_TRANSITIONS) {
      expect(canTransitionExtension('DEPRECATED', transition)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Verification (the checks and the derived state)
// ---------------------------------------------------------------------------

describe('verification checks (deterministic, total)', () => {
  it('pins the check vocabulary and the derived states', () => {
    expect([...EXTENSION_VERIFICATION_CHECKS]).toEqual([
      'manifest-schema',
      'permissions-consistency',
      'capability-declarations',
      'quota-bounds',
      'compatibility-bounds',
    ]);
    expect([...EXTENSION_VERIFICATION_STATES]).toEqual(['UNVERIFIED', 'VERIFIED', 'FAILED']);
    expect([...MANIFEST_SCHEMA_VERSIONS]).toEqual([1]);
    expect(isSupportedManifestSchemaVersion(1)).toBe(true);
    expect(isSupportedManifestSchemaVersion(2)).toBe(false);
    expect(isSupportedManifestSchemaVersion('1')).toBe(false);
    for (const check of EXTENSION_VERIFICATION_CHECKS) expect(isExtensionVerificationCheck(check)).toBe(true);
    expect(isExtensionVerificationCheck('penetration-test')).toBe(false);
    for (const state of EXTENSION_VERIFICATION_STATES) expect(isExtensionVerificationState(state)).toBe(true);
    expect(isExtensionVerificationState('PENDING_REVIEW')).toBe(false); // marketplace state — W028
  });

  it('passes a consistent manifest in canonical check order', () => {
    const results = runManifestVerificationChecks(validSubject());
    expect(results.map((result) => result.check)).toEqual([...EXTENSION_VERIFICATION_CHECKS]);
    expect(results.every((result) => result.outcome === 'pass')).toBe(true);
    expect(results.every((result) => result.detail === null)).toBe(true);
    expect(verificationOutcomeFor(results)).toBe('verified');
    expect(summarizeVerificationRun(results)).toBe('5/5 checks passed');
  });

  it('fails each check for its own corruption', () => {
    const fails = (subject: ManifestVerificationSubject, check: string): void => {
      const results = runManifestVerificationChecks(subject);
      const target = results.find((result) => result.check === check)!;
      expect(target.outcome).toBe('fail');
      expect(target.detail).not.toBeNull();
      expect(verificationOutcomeFor(results)).toBe('failed');
    };

    fails({ ...validSubject(), manifestSchemaVersion: 2 }, 'manifest-schema');
    fails(
      {
        ...validSubject(),
        requestedPermissions: validSubject().requestedPermissions.filter((p) => p !== 'schedule:run'),
      },
      'permissions-consistency',
    );
    fails(
      {
        ...validSubject(),
        requestedPermissions: [...validSubject().requestedPermissions, 'root:system'],
      },
      'permissions-consistency',
    );
    fails(
      {
        ...validSubject(),
        capabilities: {
          ...fullCapabilities(),
          schedules: [{ name: 'nightly-sync', cron: 'not cron' }],
        },
      },
      'capability-declarations',
    );
    fails({ ...validSubject(), quotas: { ...fullQuotas(), maxStateBytes: 0 } }, 'quota-bounds');
    fails(
      { ...validSubject(), hostCompatibility: { minVersion: '2.0.0', maxVersion: '1.0.0' } },
      'compatibility-bounds',
    );
  });

  it('fails — never throws — on catastrophically corrupt subjects', () => {
    const results = runManifestVerificationChecks({
      manifestSchemaVersion: 1,
      requestedPermissions: [],
      capabilities: 'garbage' as unknown as ExtensionCapabilities,
      quotas: 'garbage' as unknown as ExtensionQuotas,
      hostCompatibility: 'garbage' as unknown as { minVersion: string; maxVersion: string | null },
    });
    expect(results.every((result) => result.outcome === 'fail')).toBe(true);
    expect(verificationOutcomeFor(results)).toBe('failed');

    // a check that throws mid-evaluation records the failure, it does not propagate
    const thrown = runManifestVerificationChecks({
      manifestSchemaVersion: 1,
      requestedPermissions: ['state:read'],
      capabilities: { stateScope: 'tenant' } as unknown as ExtensionCapabilities,
      quotas: fullQuotas(),
      hostCompatibility: { minVersion: '1.0.0', maxVersion: null },
    });
    const permissions = thrown.find((result) => result.check === 'permissions-consistency')!;
    expect(permissions.outcome).toBe('fail');
    expect(permissions.detail).toContain('could not be evaluated');
  });

  it('summarizes failures and truncates long summaries', () => {
    const results = runManifestVerificationChecks({
      manifestSchemaVersion: 7,
      requestedPermissions: [],
      capabilities: 'garbage' as unknown as ExtensionCapabilities,
      quotas: 'garbage' as unknown as ExtensionQuotas,
      hostCompatibility: 'garbage' as unknown as { minVersion: string; maxVersion: string | null },
    });
    const summary = summarizeVerificationRun(results);
    expect(summary).toContain('0/5 checks passed');
    expect(summary).toContain('failed:');
    expect(summary.length).toBeLessThanOrEqual(512);
  });
});

describe('derived verification state (the latest run decides)', () => {
  it('folds empty, verified and failed histories', () => {
    expect(deriveVerificationState([])).toBe('UNVERIFIED');
    expect(
      deriveVerificationState([{ id: 'a', ranAt: '2026-01-01T00:00:00Z', outcome: 'verified' }]),
    ).toBe('VERIFIED');
    expect(
      deriveVerificationState([{ id: 'a', ranAt: '2026-01-01T00:00:00Z', outcome: 'failed' }]),
    ).toBe('FAILED');
  });

  it('uses the LATEST run, ties broken by id descending (total and deterministic)', () => {
    expect(
      deriveVerificationState([
        { id: 'a', ranAt: '2026-01-01T00:00:00Z', outcome: 'verified' },
        { id: 'b', ranAt: '2026-01-02T00:00:00Z', outcome: 'failed' },
      ]),
    ).toBe('FAILED');
    expect(
      deriveVerificationState([
        { id: 'a', ranAt: '2026-01-02T00:00:00Z', outcome: 'verified' },
        { id: 'b', ranAt: '2026-01-01T00:00:00Z', outcome: 'failed' },
      ]),
    ).toBe('VERIFIED');
    // recovery: a later passing run re-verifies a failed manifest
    expect(
      deriveVerificationState([
        { id: 'a', ranAt: '2026-01-01T00:00:00Z', outcome: 'failed' },
        { id: 'b', ranAt: '2026-01-02T00:00:00Z', outcome: 'failed' },
        { id: 'c', ranAt: '2026-01-03T00:00:00Z', outcome: 'verified' },
      ]),
    ).toBe('VERIFIED');
    // same timestamp: the greater id decides
    expect(
      deriveVerificationState([
        { id: 'a', ranAt: '2026-01-01T00:00:00Z', outcome: 'verified' },
        { id: 'b', ranAt: '2026-01-01T00:00:00Z', outcome: 'failed' },
      ]),
    ).toBe('FAILED');
  });
});

// ---------------------------------------------------------------------------
// Validation / normalization (registration, transitions, queries)
// ---------------------------------------------------------------------------

describe('manifest registration validation', () => {
  it('accepts a minimal inert manifest and applies the defaults', () => {
    const valid = validateRegisterExtensionManifestInput({
      extensionKey: 'tiny',
      version: '0.1.0',
      manifestSchemaVersion: 1,
      displayName: 'Tiny',
      hostRuntime: { minVersion: '1.0.0' },
    });
    expect(valid.capabilities.stateScope).toBe('none');
    expect(valid.requestedPermissions).toEqual([]);
    expect(valid.capabilities).toEqual({
      stateScope: 'none',
      uiSurfaces: [],
      schedules: [],
      eventSubscriptions: [],
      externalParticipants: [],
      telemetry: false,
    });
    expect(valid.quotas).toEqual({
      maxStateBytes: 0,
      maxScheduleInvocationsPerDay: 0,
      maxExternalCallsPerDay: 0,
    });
    expect(valid.hostCompatibility).toEqual({ minVersion: '1.0.0', maxVersion: null });
    expect(valid.description).toBeNull();
  });

  it('normalizes lists into canonical order and strips duplicates', () => {
    const valid = validateRegisterExtensionManifestInput(
      validManifest({
        requestedPermissions: [
          'telemetry:emit',
          'state:write',
          'state:read',
          'state:write',
          'ui:render',
          'events:subscribe',
          'external:participate',
          'schedule:run',
        ],
        eventSubscriptions: ['invoice.paid', 'invoice.received', 'invoice.paid'],
        uiSurfaces: ['settings-form', 'control-tower-panel', 'settings-form'],
      }),
    );
    expect(valid.requestedPermissions).toEqual([...EXTENSION_PERMISSIONS]);
    expect(valid.capabilities.eventSubscriptions).toEqual(['invoice.paid', 'invoice.received']);
    expect(valid.capabilities.uiSurfaces).toEqual(['control-tower-panel', 'settings-form']);
    expect(valid.capabilities.schedules.map((schedule) => schedule.name)).toEqual(['nightly-sync']);
  });

  it('rejects unknown fields — identity and audit fields are minted, never supplied', () => {
    for (const smuggled of ['id', 'tenantId', 'registeredBy', 'registeredAt', 'lifecycleState']) {
      expectCode('invalid_input', () =>
        validateRegisterExtensionManifestInput(validManifest({ [smuggled]: 'x' } as never)),
      );
    }
  });

  it('enforces the extension key grammar', () => {
    expect(validateRegisterExtensionManifestInput(validManifest({ extensionKey: 'a' })).extensionKey).toBe('a');
    expect(
      validateRegisterExtensionManifestInput(validManifest({ extensionKey: 'x'.repeat(63) })).extensionKey,
    ).toBe('x'.repeat(63));
    for (const key of ['InvoiceOcr', '-invoice', 'invoice-', 'in voice', 'x'.repeat(64), '']) {
      expectCode('invalid_input', () =>
        validateRegisterExtensionManifestInput(validManifest({ extensionKey: key })),
      );
    }
  });

  it('rejects malformed versions and unsupported manifest schema versions', () => {
    expectCode('invalid_input', () => validateRegisterExtensionManifestInput(validManifest({ version: '1.0' })));
    expectCode('invalid_input', () => validateRegisterExtensionManifestInput(validManifest({ version: '1.0.0-beta' })));
    expectCode('invalid_input', () => validateRegisterExtensionManifestInput(validManifest({ version: '01.0.0' })));
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(validManifest({ manifestSchemaVersion: 2 })),
    );
  });

  it('rejects inconsistent declarations through the shared rule set', () => {
    // capability without permission
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({ requestedPermissions: validManifest().requestedPermissions?.filter((p) => p !== 'ui:render') }),
      ),
    );
    // permission without capability
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({ uiSurfaces: [] }),
      ),
    );
    // missing quota for declared capability
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(validManifest({ quotas: { ...fullQuotas(), maxStateBytes: 0 } })),
    );
    // unjustified quota
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({
          stateScope: 'none',
          requestedPermissions: validManifest().requestedPermissions?.filter(
            (p) => p !== 'state:read' && p !== 'state:write',
          ),
          quotas: fullQuotas(),
        }),
      ),
    );
    // over-ceiling quota
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({ quotas: { ...fullQuotas(), maxScheduleInvocationsPerDay: 1441 } }),
      ),
    );
    // bad cron
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({ schedules: [{ name: 'nightly-sync', cron: '99 * * * *' }] }),
      ),
    );
    // duplicate schedule names
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({
          schedules: [
            { name: 'nightly-sync', cron: '0 2 * * *' },
            { name: 'nightly-sync', cron: '0 3 * * *' },
          ],
        }),
      ),
    );
    // insecure external origin
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({
          externalParticipants: [{ label: 'API', origin: 'http://api.example.com' }],
        }),
      ),
    );
    // duplicate origins
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({
          externalParticipants: [
            { label: 'One', origin: 'https://api.example.com' },
            { label: 'Two', origin: 'https://api.example.com' },
          ],
        }),
      ),
    );
    // bad event topic
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(validManifest({ eventSubscriptions: ['not a topic'] })),
    );
    // inverted host range
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(
        validManifest({ hostRuntime: { minVersion: '2.0.0', maxVersion: '1.0.0' } }),
      ),
    );
    // hostRuntime is required (§17 compatibility is a first-class declaration)
    expectCode('invalid_input', () => {
      const { hostRuntime: _hostRuntime, ...rest } = validManifest();
      validateRegisterExtensionManifestInput(rest as RegisterExtensionManifestInput);
    });
    // display name bounds
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(validManifest({ displayName: 'x'.repeat(121) })),
    );
    expectCode('invalid_input', () =>
      validateRegisterExtensionManifestInput(validManifest({ displayName: '   ' })),
    );
  });
});

describe('transition and query validation', () => {
  it('requires exactly one extension selector', () => {
    const id = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
    expect(
      validateTransitionExtensionInput({ extensionId: id, transition: 'activate' }).extensionId,
    ).toBe(id);
    expect(
      validateTransitionExtensionInput({ extensionKey: 'invoice-ocr', transition: 'suspend' }).extensionKey,
    ).toBe('invoice-ocr');
    expectCode('invalid_input', () => validateTransitionExtensionInput({ transition: 'activate' } as never));
    expectCode('invalid_input', () =>
      validateTransitionExtensionInput({ extensionId: id, extensionKey: 'invoice-ocr', transition: 'activate' }),
    );
    expectCode('invalid_input', () =>
      validateTransitionExtensionInput({ extensionKey: 'invoice-ocr', transition: 'publish' } as never),
    );
    const withKey = validateTransitionExtensionInput({
      extensionKey: 'invoice-ocr',
      transition: 'activate',
      idempotencyKey: 'activate:invoice-ocr:1',
    });
    expect(withKey.idempotencyKey).toBe('activate:invoice-ocr:1');
    expect(withKey.targetState).toBe('ACTIVE');
    expectCode('invalid_input', () =>
      validateTransitionExtensionInput({
        extensionKey: 'invoice-ocr',
        transition: 'activate',
        idempotencyKey: 'not a key!',
      }),
    );
  });

  it('validates the read queries', () => {
    const id = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
    expect(validateGetExtensionQuery({ extensionId: id }).extensionId).toBe(id);
    expectCode('invalid_query', () => validateGetExtensionQuery({} as never));
    expectCode('invalid_query', () => validateGetExtensionQuery({ extensionId: 'nope' } as never));

    expect(validateListExtensionsQuery({}).limit).toBe(50);
    expectCode('invalid_query', () => validateListExtensionsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListExtensionsQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListExtensionsQuery({ lifecycleState: 'PUBLISHED' } as never));
    expect(validateListExtensionsQuery({ lifecycleState: 'ACTIVE' }).lifecycleState).toBe('ACTIVE');

    expect(validateListManifestsQuery({ extensionKey: 'invoice-ocr' }).extensionKey).toBe('invoice-ocr');
    expectCode('invalid_query', () =>
      validateListManifestsQuery({ extensionId: id, extensionKey: 'invoice-ocr' }),
    );

    expectCode('invalid_query', () =>
      validateCheckManifestCompatibilityQuery({ manifestId: id, hostVersion: '1.2' }),
    );
    expect(
      validateCheckManifestCompatibilityQuery({ manifestId: id, hostVersion: '1.2.3' }).hostVersion,
    ).toBe('1.2.3');

    expectCode('invalid_query', () => validateListExtensionLifecycleEventsQuery({} as never));
    expect(
      validateListExtensionLifecycleEventsQuery({ extensionId: id, limit: 10 }).limit,
    ).toBe(10);
  });

  it('validates the TenantContext shape', () => {
    expectCode('invalid_context', () => assertExtensionsTenantContext(null as never));
    expectCode('invalid_context', () =>
      assertExtensionsTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertExtensionsTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertExtensionsTenantContext({ tenantId: 't', principalId: 'p', authority: 'admin' } as never),
    );
    expect(() => assertExtensionsTenantContext(context())).not.toThrow();
  });
});
