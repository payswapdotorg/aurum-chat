// Unit tests for the vertical-kits module's PURE surfaces (no database):
// the lifecycle state machine, the signed-manifest digest, the
// deterministic verification checks, the input validation guards and the
// denial-reason builders — plus the well-formedness of the module's own
// shipped starter kits (the first-class content must pass the very
// verification tenants run).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_LEDGER_ERP_KIT,
  LEGAL_CASE_MANAGEMENT_KIT,
  STARTER_KITS,
} from '../kits';
import {
  availableInstallationTransitions,
  canTransitionInstallation,
  holdsKitAuthority,
  isKitUsableState,
  isTerminalInstallationState,
  KIT_AUTHORITY_HOLDING_STATES,
  targetInstallationState,
} from '../lifecycle';
import {
  canonicalKitJson,
  digestKitManifest,
  isManifestDigest,
} from '../digest';
import {
  agentDefinitionProblemsForKit,
  capabilityDeclarationProblemsForKit,
  extensionDefinitionProblemsForKit,
  integrationReferenceProblems,
  KIT_VERIFICATION_CHECKS,
  manifestShapeProblems,
  schemaHintProblemsForKit,
  verifyKitManifest,
} from '../verification';
import {
  buildInactiveInstallationReason,
  buildMissingGrantReason,
  joinAnd,
  taskPhrase,
} from '../reason';
import {
  assertVerticalKitsTenantContext,
  parseKitSemver,
} from '../validation';
import { VerticalKitsError } from '../errors';
import type { KitTaskContext, VerticalKitManifest } from '../types';

// ---------------------------------------------------------------------------
// The lifecycle state machine
// ---------------------------------------------------------------------------

describe('the kit installation lifecycle state machine', () => {
  it('the canonical chain: pending-review → (rejected | granted) → active ⇄ suspended → removed', () => {
    expect(canTransitionInstallation('pending-review', 'review-approve')).toBe(true);
    expect(canTransitionInstallation('pending-review', 'review-reject')).toBe(true);
    expect(targetInstallationState('review-approve')).toBe('granted');
    expect(targetInstallationState('review-reject')).toBe('rejected');
    expect(canTransitionInstallation('granted', 'activate')).toBe(true);
    expect(targetInstallationState('activate')).toBe('active');
    expect(canTransitionInstallation('active', 'suspend')).toBe(true);
    expect(canTransitionInstallation('suspended', 'resume')).toBe(true);
    expect(canTransitionInstallation('active', 'resume')).toBe(false);
    expect(canTransitionInstallation('granted', 'activate')).toBe(true);
    expect(canTransitionInstallation('granted', 'suspend')).toBe(false);
    expect(canTransitionInstallation('rejected', 'activate')).toBe(false);
  });

  it('removal is legal from every live state and terminal once removed', () => {
    for (const state of ['pending-review', 'rejected', 'granted', 'active', 'suspended'] as const) {
      expect(canTransitionInstallation(state, 'remove')).toBe(true);
    }
    expect(canTransitionInstallation('removed', 'remove')).toBe(false);
    expect(isTerminalInstallationState('removed')).toBe(true);
    expect(isTerminalInstallationState('rejected')).toBe(false); // may still be removed
    expect(availableInstallationTransitions('removed')).toEqual([]);
  });

  it('authority is held exactly by granted/active/suspended; only active is usable', () => {
    expect(KIT_AUTHORITY_HOLDING_STATES).toEqual(['granted', 'active', 'suspended']);
    expect(holdsKitAuthority('granted')).toBe(true);
    expect(holdsKitAuthority('active')).toBe(true);
    expect(holdsKitAuthority('suspended')).toBe(true);
    expect(holdsKitAuthority('pending-review')).toBe(false);
    expect(holdsKitAuthority('rejected')).toBe(false);
    expect(holdsKitAuthority('removed')).toBe(false);
    expect(isKitUsableState('active')).toBe(true);
    expect(isKitUsableState('granted')).toBe(false);
    expect(isKitUsableState('suspended')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The signed-manifest digest
// ---------------------------------------------------------------------------

describe('the signed-manifest digest', () => {
  it('canonical JSON is deterministic: key order does not change the digest', () => {
    const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } };
    const b = { a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalKitJson(a)).toBe(canonicalKitJson(b));
    expect(digestKitManifest(a)).toBe(digestKitManifest(b));
  });

  it('any content change changes the digest (tamper evidence)', () => {
    const manifest = { ...LEGAL_CASE_MANAGEMENT_KIT };
    const original = digestKitManifest(manifest);
    const tampered: VerticalKitManifest = {
      ...manifest,
      requiredCapabilities: manifest.requiredCapabilities.slice(0, -1),
    };
    expect(digestKitManifest(tampered)).not.toBe(original);
  });

  it('the digest is a 64-char lowercase hex string and the guard knows it', () => {
    const digest = digestKitManifest(LEGAL_CASE_MANAGEMENT_KIT);
    expect(isManifestDigest(digest)).toBe(true);
    expect(isManifestDigest('not-a-digest')).toBe(false);
    expect(isManifestDigest(digest.toUpperCase())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The deterministic verification checks
// ---------------------------------------------------------------------------

describe('the deterministic kit verification', () => {
  it('both shipped starter kits pass every check (the first-class content is verified by its own rules)', () => {
    for (const kit of STARTER_KITS) {
      const outcome = verifyKitManifest(kit, digestKitManifest(kit));
      expect(outcome.outcome).toBe('verified');
      expect(outcome.checks.map((entry) => entry.check)).toEqual([...KIT_VERIFICATION_CHECKS]);
      for (const check of outcome.checks) {
        expect(check.passed, `${kit.kitKey}: ${check.check}`).toBe(true);
      }
    }
  });

  it('a tampered stored row fails the manifest-integrity check loudly', () => {
    const digest = digestKitManifest(LEGAL_CASE_MANAGEMENT_KIT);
    const tampered = {
      ...LEGAL_CASE_MANAGEMENT_KIT,
      displayName: 'Tampered Kit',
    };
    const outcome = verifyKitManifest(tampered, digest);
    expect(outcome.outcome).toBe('failed');
    const integrity = outcome.checks.find((entry) => entry.check === 'manifest-integrity')!;
    expect(integrity.passed).toBe(false);
    expect(integrity.detail).toContain('modified outside the service');
  });

  it('malformed shapes are caught by their own checks', () => {
    expect(manifestShapeProblems('nope')).toContain('the manifest must be a JSON object');
    expect(manifestShapeProblems({ ...LEGAL_CASE_MANAGEMENT_KIT, kitSchemaVersion: 2 }).length).toBeGreaterThan(0);
    expect(manifestShapeProblems({ ...LEGAL_CASE_MANAGEMENT_KIT, version: '1.0' }).join(' ')).toContain('semver');
    expect(manifestShapeProblems({ ...LEGAL_CASE_MANAGEMENT_KIT, kitKey: 'Bad Key' }).join(' ')).toContain('kitKey');
    expect(
      capabilityDeclarationProblemsForKit([
        { key: 'write.matter', label: 'x', dataCategories: [], mode: 'read' }, // mode/keys mismatch
        { key: 'read.matter', label: 'x', dataCategories: [], mode: 'read' },
        { key: 'read.matter', label: 'x', dataCategories: [], mode: 'read' }, // duplicate
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mode 'read' does not match"),
        expect.stringContaining('declared more than once'),
      ]),
    );
    expect(capabilityDeclarationProblemsForKit([])).toContain(
      'a kit must declare at least one required capability',
    );
  });

  it('extension definitions are judged by the extensions module’s own consistency rules', () => {
    const [definition] = LEGAL_CASE_MANAGEMENT_KIT.extensionDefinitions;
    // Least privilege: dropping a required permission is a problem.
    const broken = {
      ...definition!,
      requestedPermissions: definition!.requestedPermissions.filter((p) => p !== 'state:write'),
    };
    const problems = extensionDefinitionProblemsForKit([broken]);
    expect(problems.some((p) => p.includes('requires permission'))).toBe(true);
    // Scope hoarding: adding an unjustified permission is a problem.
    const hoarding = {
      ...definition!,
      requestedPermissions: [...definition!.requestedPermissions, 'telemetry:emit'],
    };
    expect(
      extensionDefinitionProblemsForKit([hoarding]).some((p) => p.includes('justif')),
    ).toBe(true);
    // Unknown vocabulary is a problem.
    const unknown = {
      ...definition!,
      capabilities: { ...definition!.capabilities, uiSurfaces: ['hologram'] },
    };
    expect(
      extensionDefinitionProblemsForKit([unknown]).some((p) => p.includes('declarative UI surface')),
    ).toBe(true);
    // Well-formed kit definitions pass.
    expect(extensionDefinitionProblemsForKit(LEGAL_CASE_MANAGEMENT_KIT.extensionDefinitions)).toEqual([]);
  });

  it('agent definitions are judged by the agents module’s own vocabularies', () => {
    const [definition] = LEGAL_CASE_MANAGEMENT_KIT.agentDefinitions;
    const broken = { ...definition!, provider: 'skynet' };
    expect(
      agentDefinitionProblemsForKit([broken]).some((p) => p.includes('runtime provider')),
    ).toBe(true);
    const badScope = { ...definition!, permissions: ['observe', 'teleport'] };
    expect(
      agentDefinitionProblemsForKit([badScope]).some((p) => p.includes('not a known scope')),
    ).toBe(true);
    expect(agentDefinitionProblemsForKit(LEGAL_CASE_MANAGEMENT_KIT.agentDefinitions)).toEqual([]);
    expect(agentDefinitionProblemsForKit(ACCOUNTING_LEDGER_ERP_KIT.agentDefinitions)).toEqual([]);
  });

  it('edge integrations must reference declared capabilities and hint entities', () => {
    const kit = LEGAL_CASE_MANAGEMENT_KIT;
    const dangling = {
      ...kit,
      edgeIntegrations: [
        ...kit.edgeIntegrations,
        {
          ...kit.edgeIntegrations[0]!,
          integrationKey: 'dangling-sor',
          readCapabilityKey: 'read.nonexistent-entity',
          writeCapabilityKey: 'write.also-nonexistent',
          schemaHintEntities: ['not-an-entity'],
        },
      ],
    };
    const problems = integrationReferenceProblems(
      dangling.edgeIntegrations,
      dangling.requiredCapabilities,
      dangling.dataSchemaHints,
    );
    expect(problems.some((p) => p.includes('readCapabilityKey'))).toBe(true);
    expect(problems.some((p) => p.includes('writeCapabilityKey'))).toBe(true);
    expect(problems.some((p) => p.includes('unknown schema hint entity'))).toBe(true);
    // Same read and write key is a problem (the paths must differ).
    const same = [
      { ...kit.edgeIntegrations[0]!, readCapabilityKey: 'read.case-matters', writeCapabilityKey: 'read.case-matters' },
    ];
    expect(
      integrationReferenceProblems(same, kit.requiredCapabilities, kit.dataSchemaHints).some((p) =>
        p.includes('must differ'),
      ),
    ).toBe(true);
    expect(
      integrationReferenceProblems(kit.edgeIntegrations, kit.requiredCapabilities, kit.dataSchemaHints),
    ).toEqual([]);
  });

  it('schema hints must be unique, non-empty and fielded', () => {
    const kit = ACCOUNTING_LEDGER_ERP_KIT;
    const duplicated = [
      ...kit.dataSchemaHints,
      { ...kit.dataSchemaHints[0]! },
    ];
    expect(
      schemaHintProblemsForKit(duplicated).some((p) => p.includes('appears more than once')),
    ).toBe(true);
    const empty = [...kit.dataSchemaHints, { entity: 'empty', label: 'Empty', fields: [] }];
    expect(
      schemaHintProblemsForKit(empty).some((p) => p.includes('at least one field')),
    ).toBe(true);
    expect(schemaHintProblemsForKit(kit.dataSchemaHints)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The denial-reason builders (deterministic, task-grounded)
// ---------------------------------------------------------------------------

describe('the deterministic denial reasons', () => {
  const task: KitTaskContext = {
    description: 'Close the matter intake for client Acme',
    requestedFor: 'matter onboarding',
  };

  it('joinAnd produces plain organizational English', () => {
    expect(joinAnd([])).toBe('none');
    expect(joinAnd(['a'])).toBe('a');
    expect(joinAnd(['a', 'b'])).toBe('a and b');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('taskPhrase grounds the reason in the concrete task', () => {
    expect(taskPhrase(task)).toBe(
      "for task 'Close the matter intake for client Acme' (for matter onboarding)",
    );
  });

  it('an inactive installation names its state verbatim', () => {
    const reason = buildInactiveInstallationReason('suspended', task);
    expect(reason).toContain("'suspended'");
    expect(reason).toContain('require an active installation');
    expect(reason).toContain('Close the matter intake');
  });

  it('a missing grant names the exact missing scope and the exact covered scope', () => {
    const reason = buildMissingGrantReason(
      'write.billing-records',
      ['read.case-matters', 'write.case-matters'],
      'active',
      task,
    );
    expect(reason).toContain("capability 'write.billing-records'");
    expect(reason).toContain('exactly: read.case-matters and write.case-matters');
    expect(buildMissingGrantReason('write.billing-records', [], 'active', task)).toContain(
      'no active capability grants',
    );
  });
});

// ---------------------------------------------------------------------------
// Validation guards + semver parsing
// ---------------------------------------------------------------------------

describe('validation guards', () => {
  const ctx = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    principalId: '00000000-0000-4000-8000-000000000002',
    authority: [],
  };

  it('the tenant-context guard accepts real contexts and refuses garbage', () => {
    expect(() => assertVerticalKitsTenantContext(ctx)).not.toThrow();
    expect(() => assertVerticalKitsTenantContext({ ...ctx, tenantId: 'nope' })).toThrow(VerticalKitsError);
    expect(() => assertVerticalKitsTenantContext(null as never)).toThrow(VerticalKitsError);
    try {
      assertVerticalKitsTenantContext({ ...ctx, principalId: 'nope' });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as VerticalKitsError).code).toBe('invalid_context');
    }
  });

  it('kit semver parsing is numeric and strict', () => {
    expect(parseKitSemver('1.2.10')).toEqual({ major: 1, minor: 2, patch: 10 });
    expect(parseKitSemver('1.02.3')).toBeNull(); // no leading zeros
    expect(parseKitSemver('1.2')).toBeNull();
    expect(parseKitSemver('v1.2.3')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The shipped content itself
// ---------------------------------------------------------------------------

describe('the two shipped starter kits (first-class content)', () => {
  it('two system-of-record-heavy verticals ship, each self-contained', () => {
    expect(STARTER_KITS).toHaveLength(2);
    expect(STARTER_KITS.map((kit) => kit.kitKey)).toEqual([
      'legal-case-management',
      'accounting-ledger-erp',
    ]);
    for (const kit of STARTER_KITS) {
      expect(kit.version).toBe('1.0.0');
      expect(kit.kitSchemaVersion).toBe(1);
      expect(kit.requiredCapabilities.length).toBeGreaterThanOrEqual(5);
      expect(kit.extensionDefinitions.length).toBeGreaterThanOrEqual(3);
      expect(kit.agentDefinitions.length).toBeGreaterThanOrEqual(2);
      expect(kit.dataSchemaHints.length).toBeGreaterThanOrEqual(4);
      expect(kit.edgeIntegrations.length).toBeGreaterThanOrEqual(2);
      // Every integration reference resolves (verified above; restated as
      // content-level acceptance).
      expect(
        integrationReferenceProblems(kit.edgeIntegrations, kit.requiredCapabilities, kit.dataSchemaHints),
      ).toEqual([]);
    }
  });

  it('the legal kit carries the legal vertical; the accounting kit the ledger vertical', () => {
    expect(LEGAL_CASE_MANAGEMENT_KIT.verticalKey).toBe('legal');
    expect(
      LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.map((c) => c.key),
    ).toEqual(
      expect.arrayContaining(['read.case-matters', 'write.case-matters', 'read.docket-calendar']),
    );
    expect(ACCOUNTING_LEDGER_ERP_KIT.verticalKey).toBe('accounting');
    expect(
      ACCOUNTING_LEDGER_ERP_KIT.requiredCapabilities.map((c) => c.key),
    ).toEqual(
      expect.arrayContaining(['read.ledger-accounts', 'write.journal-entries']),
    );
    // The read-only integration declares no write capability (least privilege).
    const arAging = ACCOUNTING_LEDGER_ERP_KIT.edgeIntegrations.find(
      (entry) => entry.integrationKey === 'ar-aging-sor',
    )!;
    expect(arAging.writeCapabilityKey).toBeNull();
  });
});
