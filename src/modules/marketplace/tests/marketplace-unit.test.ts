// Unit tests for the marketplace module's pure logic (no database): the
// package lifecycle state machine (DRAFT → … → INSTALLABLE), the
// AUTOMATED_VERIFICATION check sets for both package kinds (including
// the one-semantics guarantee with the extensions module's own checks),
// the shared run outcome/summary helpers, and the full validation/
// normalization surface for package creation, transitions, reviews and
// queries. Storage-level guarantees (immutability triggers, append-only
// evidence, platform-catalog visibility) are covered by
// marketplace-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  EXTENSION_VERIFICATION_CHECKS,
  runManifestVerificationChecks,
  type ManifestVerificationSubject,
} from '@/modules/extensions/contract';
import {
  AGENT_PACKAGE_CHECKS,
  EXTENSION_PACKAGE_CHECKS,
  MAX_PACKAGE_VERIFICATION_SUMMARY_CHARS,
  isAgentPackageCheck,
  packageVerificationOutcomeFor,
  runAgentPackageVerificationChecks,
  summarizePackageVerificationRun,
  type AgentSubjectLike,
} from '../verification';
import {
  MARKETPLACE_PACKAGE_STATES,
  MARKETPLACE_PACKAGE_TRANSITIONS,
  MARKETPLACE_POST_APPROVAL_STATES,
  MARKETPLACE_PRE_APPROVAL_STATES,
  MARKETPLACE_PUBLIC_STATES,
  MARKETPLACE_REVIEW_QUEUE_STATES,
  availableTransitions,
  canTransitionPackage,
  isMarketplacePackageState,
  isMarketplacePackageTransition,
  isTerminalPackageState,
  targetPackageState,
} from '../lifecycle';
import { MarketplaceError } from '../errors';
import {
  assertMarketplaceTenantContext,
  isPackageKey,
  validateCreatePackageInput,
  validateEvidenceQuery,
  validateGetPackageQuery,
  validateListKindQuery,
  validateListPackagesQuery,
  validateMakePackageInstallableInput,
  validatePublishPackageInput,
  validateReviewPackageInput,
  validateRunPackageVerificationInput,
  validateSubmitPackageInput,
} from '../validation';

const MANIFEST_ID = '3f1c2a4b-5d6e-4f8a-9b0c-1d2e3f4a5b6c';
const PACKAGE_ID = 'a7b8c9d0-e1f2-4a3b-8c5d-6e7f8a9b0c1d';

function ctx(): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [] };
}

/** Sync error-code assertion for the pure validators. */
function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).code).toBe(code);
  }
}

/** A well-formed agent-package subject. */
function agentSubject(overrides: Partial<AgentSubjectLike> = {}): AgentSubjectLike {
  return {
    role: 'Invoice reconciler',
    instructions: 'Reconcile invoices against ledger entries; flag mismatches.',
    provider: 'langgraph',
    permissions: ['observe', 'analyze'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The lifecycle state machine
// ---------------------------------------------------------------------------

describe('marketplace package lifecycle (pure)', () => {
  it('declares the governed chain exactly as ARCHITECTURE.md §17 pins it through INSTALLABLE', () => {
    expect(MARKETPLACE_PACKAGE_STATES).toEqual([
      'DRAFT',
      'SUBMITTED',
      'AUTOMATED_VERIFICATION',
      'PENDING_REVIEW',
      'APPROVED',
      'REJECTED',
      'PUBLISHED',
      'INSTALLABLE',
    ]);
    expect(MARKETPLACE_PACKAGE_TRANSITIONS).toEqual([
      'submit',
      'verify',
      'verification-passed',
      'verification-failed',
      'approve',
      'reject',
      'publish',
      'make-installable',
    ]);
  });

  it('guards the vocabularies', () => {
    for (const state of MARKETPLACE_PACKAGE_STATES) {
      expect(isMarketplacePackageState(state)).toBe(true);
    }
    expect(isMarketplacePackageState('ACTIVE')).toBe(false); // W025's extension tail, not W028's package chain
    expect(isMarketplacePackageState('DEPRECATED')).toBe(false);
    expect(isMarketplacePackageState('pending')).toBe(false);
    expect(isMarketplacePackageState(42)).toBe(false);

    for (const transition of MARKETPLACE_PACKAGE_TRANSITIONS) {
      expect(isMarketplacePackageTransition(transition)).toBe(true);
    }
    expect(isMarketplacePackageTransition('activate')).toBe(false);
    expect(isMarketplacePackageTransition('install')).toBe(false); // W026/W047 scope, not W028
  });

  it('allows exactly the eight legal transitions and targets the right state', () => {
    const legal: Array<[MarketplacePackageStateOf, MarketplaceTransitionOf]> = [
      ['DRAFT', 'submit'],
      ['SUBMITTED', 'verify'],
      ['AUTOMATED_VERIFICATION', 'verification-passed'],
      ['AUTOMATED_VERIFICATION', 'verification-failed'],
      ['PENDING_REVIEW', 'approve'],
      ['PENDING_REVIEW', 'reject'],
      ['APPROVED', 'publish'],
      ['PUBLISHED', 'make-installable'],
    ];
    for (const [from, transition] of legal) {
      expect(canTransitionPackage(from, transition)).toBe(true);
    }
    expect(targetPackageState('submit')).toBe('SUBMITTED');
    expect(targetPackageState('verify')).toBe('AUTOMATED_VERIFICATION');
    expect(targetPackageState('verification-passed')).toBe('PENDING_REVIEW');
    expect(targetPackageState('verification-failed')).toBe('REJECTED');
    expect(targetPackageState('approve')).toBe('APPROVED');
    expect(targetPackageState('reject')).toBe('REJECTED');
    expect(targetPackageState('publish')).toBe('PUBLISHED');
    expect(targetPackageState('make-installable')).toBe('INSTALLABLE');
  });

  it('rejects every illegal transition — no skips, no bypasses, no resurrection', () => {
    const illegal: Array<[MarketplacePackageStateOf, MarketplaceTransitionOf]> = [
      // No skipping the platform pipeline.
      ['DRAFT', 'verify'],
      ['DRAFT', 'approve'],
      ['DRAFT', 'publish'],
      ['DRAFT', 'make-installable'],
      ['SUBMITTED', 'approve'],
      ['SUBMITTED', 'verification-passed'],
      ['SUBMITTED', 'publish'],
      ['AUTOMATED_VERIFICATION', 'approve'],
      ['AUTOMATED_VERIFICATION', 'publish'],
      // Platform approval is mandatory: APPROVED only from PENDING_REVIEW.
      ['PENDING_REVIEW', 'publish'],
      ['PENDING_REVIEW', 'make-installable'],
      ['PENDING_REVIEW', 'submit'],
      ['APPROVED', 'make-installable'], // publication precedes installability
      ['APPROVED', 'reject'],           // approval is not revocable in place
      ['APPROVED', 'approve'],
      // REJECTED is terminal (both arrival routes) — no un-reject.
      ['REJECTED', 'submit'],
      ['REJECTED', 'verify'],
      ['REJECTED', 'approve'],
      ['REJECTED', 'publish'],
      // PUBLISHED only advances to INSTALLABLE; no un-publish.
      ['PUBLISHED', 'publish'],
      ['PUBLISHED', 'approve'],
      ['PUBLISHED', 'submit'],
      // INSTALLABLE hands over to the installation story (W026/W047) — nothing left here.
      ['INSTALLABLE', 'make-installable'],
      ['INSTALLABLE', 'submit'],
      ['INSTALLABLE', 'approve'],
    ];
    for (const [from, transition] of illegal) {
      expect(canTransitionPackage(from, transition)).toBe(false);
    }
  });

  it('exposes available transitions and the terminal ends of the governed chain', () => {
    expect(availableTransitions('DRAFT')).toEqual(['submit']);
    expect(availableTransitions('SUBMITTED')).toEqual(['verify']);
    expect(availableTransitions('AUTOMATED_VERIFICATION')).toEqual([
      'verification-passed',
      'verification-failed',
    ]);
    expect(availableTransitions('PENDING_REVIEW')).toEqual(['approve', 'reject']);
    expect(availableTransitions('APPROVED')).toEqual(['publish']);
    expect(availableTransitions('PUBLISHED')).toEqual(['make-installable']);
    // The two ends: a dead end here, the installation hand-off there.
    expect(availableTransitions('REJECTED')).toEqual([]);
    expect(availableTransitions('INSTALLABLE')).toEqual([]);
    expect(isTerminalPackageState('REJECTED')).toBe(true);
    expect(isTerminalPackageState('INSTALLABLE')).toBe(true);
    for (const state of ['DRAFT', 'SUBMITTED', 'AUTOMATED_VERIFICATION', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED'] as const) {
      expect(isTerminalPackageState(state)).toBe(false);
    }
  });

  it('partitions the states by governance posture', () => {
    // Pre-approval: everything a tenant could never install (lock 27).
    expect(MARKETPLACE_PRE_APPROVAL_STATES).toEqual([
      'DRAFT',
      'SUBMITTED',
      'AUTOMATED_VERIFICATION',
      'PENDING_REVIEW',
      'REJECTED',
    ]);
    expect(MARKETPLACE_POST_APPROVAL_STATES).toEqual(['APPROVED', 'PUBLISHED', 'INSTALLABLE']);
    // The public catalog: exactly the two post-publication states (lock 26 —
    // publication never implies installation, but nothing pre-publication
    // is catalog-visible either).
    expect(MARKETPLACE_PUBLIC_STATES).toEqual(['PUBLISHED', 'INSTALLABLE']);
    expect(MARKETPLACE_REVIEW_QUEUE_STATES).toEqual([
      'SUBMITTED',
      'AUTOMATED_VERIFICATION',
      'PENDING_REVIEW',
    ]);
    for (const state of MARKETPLACE_PRE_APPROVAL_STATES) {
      expect((MARKETPLACE_PUBLIC_STATES as readonly string[]).includes(state)).toBe(false);
    }
  });
});

// Local aliases so the tables above stay readable.
type MarketplacePackageStateOf = (typeof MARKETPLACE_PACKAGE_STATES)[number];
type MarketplaceTransitionOf = (typeof MARKETPLACE_PACKAGE_TRANSITIONS)[number];

// ---------------------------------------------------------------------------
// The AUTOMATED_VERIFICATION checks
// ---------------------------------------------------------------------------

describe('agent-package verification checks (pure)', () => {
  it('declares the closed four-check vocabulary', () => {
    expect(AGENT_PACKAGE_CHECKS).toEqual([
      'agent-schema',
      'provider-known',
      'permission-scopes',
      'instructions-bounds',
    ]);
    expect(isAgentPackageCheck('agent-schema')).toBe(true);
    expect(isAgentPackageCheck('manifest-schema')).toBe(false); // extension vocabulary
  });

  it('passes a well-formed agent package on every check', () => {
    const results = runAgentPackageVerificationChecks(agentSubject());
    expect(results.map((result) => result.check)).toEqual([...AGENT_PACKAGE_CHECKS]);
    expect(results.every((result) => result.outcome === 'pass')).toBe(true);
    expect(results.every((result) => result.detail === null)).toBe(true);
    expect(packageVerificationOutcomeFor(results)).toBe('verified');
    expect(summarizePackageVerificationRun(results)).toBe('4/4 checks passed');
  });

  it('fails provider-known for a provider the agent gateway does not know', () => {
    const results = runAgentPackageVerificationChecks(
      agentSubject({ provider: 'some-vendor-runtime' as AgentSubjectLike['provider'] }),
    );
    const failed = results.find((result) => result.check === 'provider-known')!;
    expect(failed.outcome).toBe('fail');
    expect(failed.detail).toContain('provider must be one of');
    expect(packageVerificationOutcomeFor(results)).toBe('failed');
    expect(summarizePackageVerificationRun(results)).toBe('3/4 checks passed — failed: provider-known');
  });

  it('fails permission-scopes for unknown scopes, duplicates, over-sized and empty grants', () => {
    const unknown = runAgentPackageVerificationChecks(
      agentSubject({ permissions: ['observe', 'root'] }),
    );
    expect(unknown.find((r) => r.check === 'permission-scopes')!.detail).toContain(
      "unknown permission scope 'root'",
    );

    const duplicated = runAgentPackageVerificationChecks(
      agentSubject({ permissions: ['observe', 'observe'] }),
    );
    expect(duplicated.find((r) => r.check === 'permission-scopes')!.detail).toContain(
      "duplicate permission scope 'observe'",
    );

    const tooMany = runAgentPackageVerificationChecks(
      agentSubject({ permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose', 'execute', 'observe'] }),
    );
    expect(tooMany.find((r) => r.check === 'permission-scopes')!.detail).toContain('at most 6');

    const empty = runAgentPackageVerificationChecks(agentSubject({ permissions: [] }));
    expect(empty.find((r) => r.check === 'permission-scopes')!.detail).toContain(
      'at least one permission scope',
    );
    expect(packageVerificationOutcomeFor(empty)).toBe('failed');
  });

  it('fails agent-schema for structurally malformed subjects', () => {
    const results = runAgentPackageVerificationChecks({
      role: 7,
      instructions: null,
      provider: 42,
      permissions: 'observe',
    });
    const schema = results.find((r) => r.check === 'agent-schema')!;
    expect(schema.outcome).toBe('fail');
    expect(schema.detail).toContain('role must be a non-empty string');
    expect(schema.detail).toContain('instructions must be a non-empty string');
    expect(schema.detail).toContain('provider must be a string');
    expect(schema.detail).toContain('permissions must be an array');
    // A malformed subject still produces a total, deterministic verdict.
    expect(packageVerificationOutcomeFor(results)).toBe('failed');
  });

  it('fails instructions-bounds for oversized role and instructions', () => {
    const results = runAgentPackageVerificationChecks(
      agentSubject({ role: 'x'.repeat(129), instructions: 'y'.repeat(32769) }),
    );
    const bounds = results.find((r) => r.check === 'instructions-bounds')!;
    expect(bounds.outcome).toBe('fail');
    expect(bounds.detail).toContain('role must be at most 128 characters');
    expect(bounds.detail).toContain('instructions must be at most 32768 characters');
  });

  it('bounds the run summary deterministically', () => {
    const results = runAgentPackageVerificationChecks(
      agentSubject({ role: 'x'.repeat(129) }),
    );
    const summary = summarizePackageVerificationRun(results);
    expect(summary.length).toBeLessThanOrEqual(MAX_PACKAGE_VERIFICATION_SUMMARY_CHARS);
    expect(summary).toBe('3/4 checks passed — failed: instructions-bounds');
  });
});

describe('extension-package verification vocabulary (one semantics)', () => {
  it('uses EXACTLY the extensions module\'s own check vocabulary — no drift', () => {
    expect([...EXTENSION_PACKAGE_CHECKS]).toEqual([...EXTENSION_VERIFICATION_CHECKS]);
  });

  it('runs the same five checks the registry runs over a manifest subject', () => {
    // A subject with an inverted host-compatibility range: the extensions
    // module's own pure checks fail it — and the marketplace phase runs
    // those same checks, so the outcomes are identical.
    const subject: ManifestVerificationSubject = {
      manifestSchemaVersion: 1,
      requestedPermissions: ['state:read', 'state:write'],
      capabilities: {
        stateScope: 'tenant',
        uiSurfaces: [],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [],
        telemetry: false,
      },
      quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      hostCompatibility: { minVersion: '2.0.0', maxVersion: '1.0.0' },
    };
    const registryResults = runManifestVerificationChecks(subject);
    expect(registryResults.find((r) => r.check === 'compatibility-bounds')!.outcome).toBe('fail');
    expect(registryResults.find((r) => r.check === 'compatibility-bounds')!.detail).toContain(
      'inverted',
    );
    // The marketplace's vocabulary is the same list, so the same subject
    // fails identically through the marketplace phase.
    expect(packageVerificationOutcomeFor(registryResults)).toBe('failed');
    expect(summarizePackageVerificationRun(registryResults)).toBe(
      '4/5 checks passed — failed: compatibility-bounds',
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('createPackage input validation (pure)', () => {
  it('validates an extension package creation input', () => {
    const valid = validateCreatePackageInput({ kind: 'extension', manifestId: MANIFEST_ID });
    expect(valid).toEqual({ kind: 'extension', manifestId: MANIFEST_ID, packageKey: null });
    const keyed = validateCreatePackageInput({
      kind: 'extension',
      manifestId: MANIFEST_ID,
      packageKey: 'acme-connector',
    });
    expect(keyed).toEqual({
      kind: 'extension',
      manifestId: MANIFEST_ID,
      packageKey: 'acme-connector',
    });
  });

  it('rejects malformed extension creation inputs', () => {
    expectCode('invalid_input', () => validateCreatePackageInput({ kind: 'extension' }));
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ kind: 'extension', manifestId: 'not-a-uuid' }),
    );
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ kind: 'extension', manifestId: MANIFEST_ID, packageKey: 'Not A Slug' }),
    );
    // Unknown keys can never smuggle system-owned fields.
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ kind: 'extension', manifestId: MANIFEST_ID, state: 'PUBLISHED' }),
    );
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ kind: 'extension', manifestId: MANIFEST_ID, id: newId() }),
    );
    expectCode('invalid_input', () => validateCreatePackageInput({ kind: 'plugin' }));
    expectCode('invalid_input', () => validateCreatePackageInput(null));
  });

  it('validates and normalizes an agent package creation input', () => {
    const valid = validateCreatePackageInput({
      kind: 'agent',
      packageKey: 'invoice-reconciler',
      version: '1.2.3',
      displayName: 'Invoice Reconciler',
      description: 'Reconciles invoices against the ledger.',
      role: 'Invoice reconciler',
      instructions: 'Reconcile invoices; flag mismatches.',
      provider: 'crewai',
      permissions: ['analyze', 'observe', 'observe'],
    });
    expect(valid).toEqual({
      kind: 'agent',
      packageKey: 'invoice-reconciler',
      version: '1.2.3',
      versionParts: { major: 1, minor: 2, patch: 3 },
      displayName: 'Invoice Reconciler',
      description: 'Reconciles invoices against the ledger.',
      role: 'Invoice reconciler',
      instructions: 'Reconcile invoices; flag mismatches.',
      provider: 'crewai',
      permissions: ['observe', 'analyze'], // deduplicated + canonical §20 order
    });
  });

  it('rejects malformed agent creation inputs field by field', () => {
    const base = {
      kind: 'agent',
      packageKey: 'invoice-reconciler',
      version: '1.0.0',
      displayName: 'Invoice Reconciler',
      role: 'Invoice reconciler',
      instructions: 'Reconcile invoices.',
      provider: 'crewai',
      permissions: ['observe'],
    } as const;

    expectCode('invalid_input', () =>
      validateCreatePackageInput({ ...base, packageKey: 'UPPER' }),
    );
    expectCode('invalid_input', () => validateCreatePackageInput({ ...base, version: '1.0' }));
    expectCode('invalid_input', () => validateCreatePackageInput({ ...base, version: '1.0.0-rc1' }));
    expectCode('invalid_input', () => validateCreatePackageInput({ ...base, displayName: '   ' }));
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ ...base, displayName: 'x'.repeat(121) }),
    );
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ ...base, description: 'd'.repeat(2001) }),
    );
    expectCode('invalid_input', () => validateCreatePackageInput({ ...base, role: '' }));
    expectCode('invalid_input', () => validateCreatePackageInput({ ...base, role: 'r'.repeat(129) }));
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ ...base, instructions: 'i'.repeat(32769) }),
    );
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ ...base, provider: 'vendor-runtime' }),
    );
    expectCode('invalid_input', () => validateCreatePackageInput({ ...base, permissions: [] }));
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ ...base, permissions: ['observe', 'root'] }),
    );
    expectCode('invalid_input', () =>
      validateCreatePackageInput({
        ...base,
        permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose', 'execute', 'ask'],
      }),
    );
    // Unknown keys can never smuggle system-owned fields.
    expectCode('invalid_input', () =>
      validateCreatePackageInput({ ...base, state: 'INSTALLABLE' }),
    );
    expectCode('invalid_input', () => validateCreatePackageInput({ ...base, vendorTenant: newId() }));
  });
});

describe('transition and review input validation (pure)', () => {
  it('validates the single-package-id inputs', () => {
    for (const validate of [
      validateSubmitPackageInput,
      validateRunPackageVerificationInput,
      validatePublishPackageInput,
      validateMakePackageInstallableInput,
    ]) {
      expect(validate({ packageId: PACKAGE_ID })).toEqual({ packageId: PACKAGE_ID });
      expectCode('invalid_input', () => validate({}));
      expectCode('invalid_input', () => validate({ packageId: 'nope' }));
      expectCode('invalid_input', () => validate({ packageId: PACKAGE_ID, extra: 1 }));
    }
  });

  it('requires a reason on rejection, allows one on approval', () => {
    expect(
      validateReviewPackageInput({ packageId: PACKAGE_ID, decision: 'approve' }),
    ).toEqual({ packageId: PACKAGE_ID, decision: 'approve', reason: null });
    expect(
      validateReviewPackageInput({
        packageId: PACKAGE_ID,
        decision: 'approve',
        reason: 'Looks good',
      }),
    ).toEqual({ packageId: PACKAGE_ID, decision: 'approve', reason: 'Looks good' });
    const rejected = validateReviewPackageInput({
      packageId: PACKAGE_ID,
      decision: 'reject',
      reason: 'Permissions hoarding',
    });
    expect(rejected.reason).toBe('Permissions hoarding');
    expectCode('invalid_input', () =>
      validateReviewPackageInput({ packageId: PACKAGE_ID, decision: 'reject' }),
    );
    expectCode('invalid_input', () =>
      validateReviewPackageInput({ packageId: PACKAGE_ID, decision: 'reject', reason: '' }),
    );
    expectCode('invalid_input', () =>
      validateReviewPackageInput({ packageId: PACKAGE_ID, decision: 'maybe' }),
    );
    expectCode('invalid_input', () =>
      validateReviewPackageInput({ packageId: 'nope', decision: 'approve' }),
    );
    expectCode('invalid_input', () =>
      validateReviewPackageInput({ packageId: PACKAGE_ID, decision: 'approve', verdict: 'yes' }),
    );
    expectCode('invalid_input', () =>
      validateReviewPackageInput({
        packageId: PACKAGE_ID,
        decision: 'reject',
        reason: 'r'.repeat(2001),
      }),
    );
  });
});

describe('query validation (pure)', () => {
  it('validates getPackage and the evidence queries', () => {
    expect(validateGetPackageQuery({ packageId: PACKAGE_ID })).toEqual({ packageId: PACKAGE_ID });
    expect(validateEvidenceQuery({ packageId: PACKAGE_ID, limit: 10 })).toEqual({
      packageId: PACKAGE_ID,
      limit: 10,
    });
    expect(validateEvidenceQuery({ packageId: PACKAGE_ID })).toEqual({
      packageId: PACKAGE_ID,
      limit: 50,
    });
    expectCode('invalid_query', () => validateGetPackageQuery({ packageId: 'x' }));
    expectCode('invalid_query', () => validateEvidenceQuery({ packageId: PACKAGE_ID, limit: 0 }));
    expectCode('invalid_query', () => validateEvidenceQuery({ packageId: PACKAGE_ID, limit: 501 }));
    expectCode('invalid_query', () => validateEvidenceQuery({ packageId: PACKAGE_ID, limit: 1.5 }));
    expectCode('invalid_query', () => validateEvidenceQuery({ packageId: PACKAGE_ID, kind: 'agent' }));
  });

  it('validates the vendor list query (kind, states, limit)', () => {
    expect(validateListPackagesQuery({})).toEqual({ kind: null, states: null, limit: 50 });
    expect(
      validateListPackagesQuery({ kind: 'agent', states: ['DRAFT', 'SUBMITTED'], limit: 500 }),
    ).toEqual({ kind: 'agent', states: ['DRAFT', 'SUBMITTED'], limit: 500 });
    expectCode('invalid_query', () => validateListPackagesQuery({ kind: 'plugin' }));
    expectCode('invalid_query', () => validateListPackagesQuery({ states: [] }));
    expectCode('invalid_query', () => validateListPackagesQuery({ states: ['ACTIVE'] }));
    expectCode('invalid_query', () => validateListPackagesQuery({ states: ['DRAFT', 'DRAFT'] }));
    expectCode('invalid_query', () =>
      validateListPackagesQuery({ states: [...MARKETPLACE_PACKAGE_STATES, 'DRAFT'] }),
    );
    expectCode('invalid_query', () => validateListPackagesQuery({ limit: -1 }));
    expectCode('invalid_query', () => validateListPackagesQuery({ vendorTenant: newId() }));
  });

  it('validates the catalog/review-queue list queries', () => {
    expect(validateListKindQuery({})).toEqual({ kind: null, limit: 50 });
    expect(validateListKindQuery({ kind: 'extension', limit: 1 })).toEqual({
      kind: 'extension',
      limit: 1,
    });
    expectCode('invalid_query', () => validateListKindQuery({ kind: 'plugin' }));
    expectCode('invalid_query', () => validateListKindQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListKindQuery({ states: ['DRAFT'] }));
  });
});

describe('tenant context guard (pure)', () => {
  it('accepts a well-formed context and rejects malformed ones', () => {
    expect(() => assertMarketplaceTenantContext(ctx())).not.toThrow();
    expectCode('invalid_context', () =>
      assertMarketplaceTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertMarketplaceTenantContext({ tenantId: newId(), principalId: ' ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertMarketplaceTenantContext({ tenantId: newId(), principalId: 'p', authority: 'nope' } as unknown as TenantContext),
    );
  });
});

describe('catalog key rule (pure)', () => {
  it('accepts lowercase kebab slugs and rejects everything else', () => {
    expect(isPackageKey('invoice-reconciler')).toBe(true);
    expect(isPackageKey('a')).toBe(true);
    expect(isPackageKey('x'.repeat(63))).toBe(true);
    expect(isPackageKey('X'.repeat(64))).toBe(false);
    expect(isPackageKey('-leading')).toBe(false);
    expect(isPackageKey('trailing-')).toBe(false);
    expect(isPackageKey('under_score')).toBe(false);
    expect(isPackageKey('dot.name')).toBe(false);
    expect(isPackageKey('')).toBe(false);
    expect(isPackageKey(42)).toBe(false);
  });
});
