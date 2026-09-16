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
  validateDeployExtensionVersionInput,
  validateDispatchExtensionEventInput,
  validateEmitExtensionTelemetryInput,
  validateExecuteExtensionExternalCallInput,
  validateGetExtensionQuery,
  validateListExtensionLifecycleEventsQuery,
  validateListExtensionsQuery,
  validateListManifestsQuery,
  validatePublishExtensionUiInput,
  validateReadExtensionStateQuery,
  validateRegisterExtensionManifestInput,
  validateRollbackExtensionDeploymentInput,
  validateTransitionExtensionInput,
  validateTriggerExtensionScheduleInput,
  validateWriteExtensionStateInput,
} from '../validation';
import {
  DEFAULT_INSTALL_KEY,
  EXTENSION_RUNTIME_HOST_VERSION,
  isExtensionHttpMethod,
  isExternalPath,
  isInstallKey,
  isStateKey,
  isTelemetryName,
  jsonByteLength,
  participantForOrigin,
  uiDocumentProblems,
  utcDayStart,
  type ExtensionUiDocument,
} from '../runtime';
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

// ---------------------------------------------------------------------------
// W026 — General-Purpose Extension Runtime (pure rules + validation)
// ---------------------------------------------------------------------------

describe('runtime pure rules (W026)', () => {
  it('pins the runtime host version and it parses as a release semver', () => {
    expect(EXTENSION_RUNTIME_HOST_VERSION).toBe('2.1.0');
    expect(parseSemver(EXTENSION_RUNTIME_HOST_VERSION)).toEqual({ major: 2, minor: 1, patch: 0 });
  });

  it('validates install keys, state keys and telemetry names', () => {
    expect(DEFAULT_INSTALL_KEY).toBe('default');
    expect(isInstallKey('default')).toBe(true);
    expect(isInstallKey('workspace-emea')).toBe(true);
    expect(isInstallKey('')).toBe(false);
    expect(isInstallKey('-nope')).toBe(false);
    expect(isInstallKey('a'.repeat(65))).toBe(false);

    expect(isStateKey('user:prefs:theme')).toBe(true);
    expect(isStateKey('0')).toBe(true);
    expect(isStateKey('has space')).toBe(false);
    expect(isStateKey('')).toBe(false);
    expect(isStateKey('x'.repeat(129))).toBe(false);

    expect(isTelemetryName('run.completed')).toBe(true);
    expect(isTelemetryName('bad name')).toBe(false);
  });

  it('validates the external participation grammar: methods and paths', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isExtensionHttpMethod(method)).toBe(true);
    }
    expect(isExtensionHttpMethod('HEAD')).toBe(false);
    expect(isExtensionHttpMethod('get')).toBe(false);

    expect(isExternalPath('/')).toBe(true);
    expect(isExternalPath('/invoices?status=paid')).toBe(true);
    expect(isExternalPath('/a/b/c')).toBe(true);
    expect(isExternalPath('no-slash')).toBe(false);
    expect(isExternalPath('/frag#ment')).toBe(false);
    expect(isExternalPath('/space here')).toBe(false);
    expect(isExternalPath('/\x00')).toBe(false);
    expect(isExternalPath(`/${'a'.repeat(512)}`)).toBe(false);
  });

  it('matches participant origins by EXACT equality — never prefix or suffix', () => {
    const capabilities: ExtensionCapabilities = {
      ...fullCapabilities(),
      externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    };
    expect(participantForOrigin(capabilities, 'https://api.invoices.example.com')).toEqual({
      label: 'Invoices API',
      origin: 'https://api.invoices.example.com',
    });
    // none of these authorize, though they all "contain" the declared host
    expect(participantForOrigin(capabilities, 'https://api.invoices.example.com.evil.io')).toBeNull();
    expect(participantForOrigin(capabilities, 'https://api.invoices.example.com:8443')).toBeNull();
    expect(participantForOrigin(capabilities, 'https://api.invoices.example.com/extra')).toBeNull();
    expect(participantForOrigin(capabilities, 'https://evil.example.com')).toBeNull();
  });

  it('computes the UTC quota-day start deterministically', () => {
    // 2026-09-14T23:30:00Z and 2026-09-15T00:30:00Z straddle the UTC day
    const late = utcDayStart(new Date('2026-09-14T23:30:00Z'));
    const early = utcDayStart(new Date('2026-09-15T00:30:00Z'));
    expect(late.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(early.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    // a UTC-midnight instant is its own day start
    expect(utcDayStart(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('measures JSON payloads in UTF-8 bytes and rejects non-JSON values', () => {
    expect(jsonByteLength(null)).toBe(4);
    expect(jsonByteLength({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
    expect(jsonByteLength('héllo')).toBe(8); // JSON quotes + the 2-byte é
    expect(jsonByteLength(undefined)).toBeNull();
    expect(jsonByteLength(Symbol('nope'))).toBeNull();
    expect(jsonByteLength(() => 1)).toBeNull();
  });
});

describe('declarative UI document rules (W026)', () => {
  it('accepts a document exercising every block type', () => {
    const document: ExtensionUiDocument = {
      title: 'Invoice OCR status',
      blocks: [
        { type: 'heading', text: 'Pipeline' },
        { type: 'text', text: 'Nightly reconciliation summary' },
        { type: 'metric', label: 'Invoices processed', value: '1,204' },
        { type: 'list', items: ['Northwind', 'Contoso'] },
        {
          type: 'table',
          columns: ['Bucket', 'Count'],
          rows: [
            ['paid', '800'],
            ['open', '404'],
          ],
        },
        { type: 'divider' },
      ],
    };
    expect(uiDocumentProblems(document)).toEqual([]);
  });

  it('reports every malformed shape and bound violation with reasons', () => {
    expect(uiDocumentProblems(null as never)).toEqual([
      'the UI document must be an object with blocks',
    ]);
    expect(uiDocumentProblems({ title: 'x', blocks: 'nope' } as never)).toEqual([
      'blocks must be an array',
    ]);
    expect(uiDocumentProblems({ blocks: [{ type: 'iframe', src: 'https://evil' }] } as never)).toEqual(
      [`block #0 has type 'iframe' which is not a known UI block type`],
    );
    expect(
      uiDocumentProblems({ blocks: [{ type: 'heading', text: '' }] } as never),
    ).toEqual([`block #0 (heading) needs a non-empty text`]);
    expect(
      uiDocumentProblems({ blocks: [{ type: 'metric', label: 'L', value: '' }] } as never),
    ).toEqual([`block #0 (metric) needs a non-empty value`]);
    expect(uiDocumentProblems({ blocks: [{ type: 'list' }] } as never)).toEqual([
      `block #0 (list) needs an items array`,
    ]);
    expect(uiDocumentProblems({ blocks: [{ type: 'list', items: ['a', 5] }] } as never)).toEqual([
      `block #0 (list) items must be non-empty strings of at most 500 characters`,
    ]);
    expect(
      uiDocumentProblems({
        blocks: [{ type: 'table', columns: ['A'], rows: [['1', '2']] }],
      } as never),
    ).toEqual([`block #0 (table) rows must have exactly 1 cells`]);
    // bounds
    expect(
      uiDocumentProblems({ title: 't'.repeat(501), blocks: [] } as never),
    ).toEqual([`title must be at most 500 characters`]);
    expect(
      uiDocumentProblems({
        blocks: Array.from({ length: 33 }, () => ({ type: 'divider' })),
      } as never),
    ).toEqual([`blocks must declare at most 32 blocks (got 33)`]);
    expect(
      uiDocumentProblems({ blocks: [{ type: 'heading', text: 'x'.repeat(501) }] } as never),
    ).toEqual([`block #0 (heading) text must be at most 500 characters`]);
  });
});

describe('runtime input validation (W026)', () => {
  const extensionId = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
  const manifestId = '1c2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
  const deploymentId = '2d3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

  it('validates deploy inputs: selectors, manifest/version, grants, install keys', () => {
    const byVersion = validateDeployExtensionVersionInput({
      extensionKey: 'invoice-ocr',
      version: '1.2.3',
    });
    expect(byVersion).toMatchObject({
      extensionKey: 'invoice-ocr',
      manifestId: null,
      version: '1.2.3',
      installKey: 'default',
      grantedPermissions: null,
      idempotencyKey: null,
    });
    const byId = validateDeployExtensionVersionInput({
      extensionId,
      manifestId,
      installKey: 'workspace-emea',
      grantedPermissions: ['state:write', 'state:read', 'state:write'],
      idempotencyKey: 'deploy:1',
    });
    expect(byId).toMatchObject({ extensionId, manifestId, version: null, installKey: 'workspace-emea' });
    // normalized canonical order + dedupe
    expect(byId.grantedPermissions).toEqual(['state:read', 'state:write']);
    expect(byId.idempotencyKey).toBe('deploy:1');

    expectCode('invalid_input', () => validateDeployExtensionVersionInput({} as never));
    expectCode('invalid_input', () =>
      validateDeployExtensionVersionInput({ extensionKey: 'invoice-ocr' } as never),
    );
    expectCode('invalid_input', () =>
      validateDeployExtensionVersionInput({
        extensionKey: 'invoice-ocr',
        manifestId,
        version: '1.2.3',
      }),
    );
    expectCode('invalid_input', () =>
      validateDeployExtensionVersionInput({ extensionKey: 'invoice-ocr', version: '1.2' }),
    );
    expectCode('invalid_input', () =>
      validateDeployExtensionVersionInput({
        extensionKey: 'invoice-ocr',
        version: '1.2.3',
        installKey: 'not a key!',
      }),
    );
    expectCode('invalid_input', () =>
      validateDeployExtensionVersionInput({
        extensionKey: 'invoice-ocr',
        version: '1.2.3',
        grantedPermissions: ['root:system' as never],
      }),
    );
    expectCode('invalid_input', () =>
      validateDeployExtensionVersionInput({ extensionId, version: '1.2.3', extra: 1 } as never),
    );
  });

  it('validates rollback inputs', () => {
    const valid = validateRollbackExtensionDeploymentInput({
      extensionKey: 'invoice-ocr',
      targetDeploymentId: deploymentId,
    });
    expect(valid).toMatchObject({
      extensionKey: 'invoice-ocr',
      targetDeploymentId: deploymentId,
      installKey: 'default',
    });
    expectCode('invalid_input', () =>
      validateRollbackExtensionDeploymentInput({ targetDeploymentId: deploymentId } as never),
    );
    expectCode('invalid_input', () =>
      validateRollbackExtensionDeploymentInput({
        extensionKey: 'invoice-ocr',
        targetDeploymentId: 'not-a-uuid',
      }),
    );
  });

  it('validates state reads and writes, tracking whether an install key was supplied', () => {
    const read = validateReadExtensionStateQuery({ extensionKey: 'invoice-ocr', key: 'prefs' });
    expect(read).toMatchObject({ key: 'prefs', installKey: 'default', installKeyGiven: null });
    const readInstall = validateReadExtensionStateQuery({
      extensionKey: 'invoice-ocr',
      installKey: 'emea',
      key: 'prefs',
    });
    expect(readInstall).toMatchObject({ installKey: 'emea', installKeyGiven: 'emea' });
    expectCode('invalid_query', () =>
      validateReadExtensionStateQuery({ extensionKey: 'invoice-ocr', key: 'has space' }),
    );

    const write = validateWriteExtensionStateInput({
      extensionKey: 'invoice-ocr',
      key: 'prefs',
      value: { theme: 'dark' },
    });
    expect(write.value).toEqual({ theme: 'dark' });
    expect(write.valueBytes).toBe(JSON.stringify({ theme: 'dark' }).length);
    expect(write.installKeyGiven).toBeNull();
    // a JSON value of null is a legal CLEAR; a missing value is an error
    expect(validateWriteExtensionStateInput({ extensionKey: 'e', key: 'k', value: null }).value).toBeNull();
    expectCode('invalid_input', () =>
      validateWriteExtensionStateInput({ extensionKey: 'e', key: 'k' } as never),
    );
    expectCode('invalid_input', () =>
      validateWriteExtensionStateInput({ extensionKey: 'e', key: 'k', value: undefined }),
    );
    expectCode('invalid_input', () =>
      validateWriteExtensionStateInput({ extensionKey: 'e', key: 'k', value: 'x'.repeat(262_145) }),
    );
  });

  it('validates UI publish inputs against the shared document rules', () => {
    const valid = validatePublishExtensionUiInput({
      extensionKey: 'invoice-ocr',
      surface: 'control-tower-panel',
      document: { title: 'Status', blocks: [{ type: 'text', text: 'All good' }] },
    });
    expect(valid).toMatchObject({ extensionKey: 'invoice-ocr', surface: 'control-tower-panel' });
    expect(valid.document).toEqual({ title: 'Status', blocks: [{ type: 'text', text: 'All good' }] });

    expectCode('invalid_input', () =>
      validatePublishExtensionUiInput({
        extensionKey: 'invoice-ocr',
        surface: 'admin-dashboard' as never,
        document: { title: null, blocks: [] },
      }),
    );
    expectCode('invalid_input', () =>
      validatePublishExtensionUiInput({
        extensionKey: 'invoice-ocr',
        surface: 'chat-panel',
        document: { blocks: [{ type: 'script' as never, code: 'alert(1)' }] } as never,
      }),
    );
    expectCode('invalid_input', () =>
      validatePublishExtensionUiInput({
        extensionKey: 'invoice-ocr',
        surface: 'chat-panel',
        document: { title: null, blocks: [], extra: true } as never,
      }),
    );
  });

  it('validates schedule triggers, telemetry and event dispatch', () => {
    expect(
      validateTriggerExtensionScheduleInput({ extensionKey: 'e', scheduleName: 'nightly-sync' }),
    ).toMatchObject({ installKey: 'default', scheduleName: 'nightly-sync' });
    expectCode('invalid_input', () =>
      validateTriggerExtensionScheduleInput({ extensionKey: 'e', scheduleName: 'not a slug!' }),
    );

    const dispatch = validateDispatchExtensionEventInput({ topic: 'invoice.paid', payload: { n: 1 } });
    expect(dispatch).toEqual({ topic: 'invoice.paid', payload: { n: 1 } });
    // omitted payload is null; a non-slug topic is rejected
    expect(validateDispatchExtensionEventInput({ topic: 'invoice.paid' })).toEqual({
      topic: 'invoice.paid',
      payload: null,
    });
    expectCode('invalid_input', () => validateDispatchExtensionEventInput({ topic: 'nope!' }));
    expectCode('invalid_input', () =>
      validateDispatchExtensionEventInput({ topic: 'invoice.paid', payload: 'x'.repeat(65_537) }),
    );

    expect(
      validateEmitExtensionTelemetryInput({ extensionKey: 'e', name: 'run.completed', payload: [1] }),
    ).toMatchObject({ installKey: 'default', name: 'run.completed', payload: [1] });
    expectCode('invalid_input', () =>
      validateEmitExtensionTelemetryInput({ extensionKey: 'e', name: 'bad name' }),
    );
  });

  it('validates external participation calls: origins, methods, paths, bodies, headers', () => {
    const valid = validateExecuteExtensionExternalCallInput({
      extensionKey: 'invoice-ocr',
      origin: 'https://api.invoices.example.com',
      method: 'POST',
      path: '/v1/invoices',
      body: { number: 'INV-1' },
      headers: { Authorization: 'Bearer tok' },
    });
    expect(valid).toMatchObject({
      installKey: 'default',
      origin: 'https://api.invoices.example.com',
      method: 'POST',
      path: '/v1/invoices',
    });
    expect(valid.bodyText).toBe(JSON.stringify({ number: 'INV-1' }));
    expect(valid.bodyBytes).toBe(JSON.stringify({ number: 'INV-1' }).length);
    expect(valid.headers).toEqual({ Authorization: 'Bearer tok' });

    expectCode('invalid_input', () =>
      validateExecuteExtensionExternalCallInput({
        extensionKey: 'e',
        origin: 'http://insecure.example.com',
        method: 'GET',
        path: '/',
      }),
    );
    expectCode('invalid_input', () =>
      validateExecuteExtensionExternalCallInput({
        extensionKey: 'e',
        origin: 'https://api.example.com',
        method: 'HEAD' as never,
        path: '/',
      }),
    );
    expectCode('invalid_input', () =>
      validateExecuteExtensionExternalCallInput({
        extensionKey: 'e',
        origin: 'https://api.example.com',
        method: 'GET',
        path: 'no-leading-slash',
      }),
    );
    expectCode('invalid_input', () =>
      validateExecuteExtensionExternalCallInput({
        extensionKey: 'e',
        origin: 'https://api.example.com',
        method: 'GET',
        path: '/',
        body: { nope: true }, // GET cannot carry a body
      }),
    );
    expectCode('invalid_input', () =>
      validateExecuteExtensionExternalCallInput({
        extensionKey: 'e',
        origin: 'https://api.example.com',
        method: 'POST',
        path: '/',
        headers: { 'X-Over': 'x'.repeat(257) },
      }),
    );
  });
});
