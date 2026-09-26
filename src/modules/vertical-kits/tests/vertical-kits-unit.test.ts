// Unit tests for the vertical-kits module's pure logic (W092) — no
// database: the shipped kit registry's conformance against every
// contract it rides, the fail-closed validation rules (the hostile
// manifest/footprint probes), the pure derivation helpers, the honest
// pending-w088 edge rendering, and the recipe→W084 composition seam.
// The integration behavior (install/upgrade/remove end to end through
// the marketplace + extensions contracts) is
// vertical-kits-service.test.ts; the repository-scan core-independence
// probe is core-independence.test.ts.

import { describe, expect, it } from 'vitest';
import {
  BROKER_PROVIDERS,
} from '@/modules/connection-broker/contract';
import {
  CAPABILITY_CLASSES,
  CAPABILITY_CLASS_KEYS,
} from '@/modules/integration-intelligence/contract';
import {
  EDGE_EXECUTION_STATUS,
  KIT_REGISTRY,
  composeDeepActionInput,
  edgeExecutionInfoOf,
  getKitDefinition,
  kitManifestSubject,
  listKitCatalog,
  normalizeKitManifest,
  unionPermissionsOf,
  validateKitDefinition,
  type VerticalKitDefinition,
} from '../contract';
import { VerticalKitsError } from '../errors';

// ---------------------------------------------------------------------------
// The shipped registry (W092's two starter kits as registered DATA)
// ---------------------------------------------------------------------------

describe('the shipped starter-kit registry', () => {
  it('carries exactly the two W092 starter kits', () => {
    const keys = [...new Set(KIT_REGISTRY.map((kit) => kit.kitKey))];
    expect(keys.sort()).toEqual(['logistics-operations', 'professional-services']);
  });

  it('every registered record passes the fail-closed validation (kits are contract-valid DATA)', () => {
    for (const kit of KIT_REGISTRY) {
      expect(() => validateKitDefinition(kit), `${kit.kitKey} ${kit.version}`).not.toThrow();
    }
  });

  it('each starter kit carries at least two extension manifests and one deep-action recipe', () => {
    for (const kit of KIT_REGISTRY) {
      expect(kit.extensionManifests.length, kit.kitKey).toBeGreaterThanOrEqual(2);
      expect(kit.deepActionRecipes.length, kit.kitKey).toBeGreaterThanOrEqual(1);
      expect(kit.connectionRequirements.length, kit.kitKey).toBeGreaterThanOrEqual(1);
    }
  });

  it('professional-services ships as two versions (1.0.0 and the 1.1.0 minor upgrade)', () => {
    const versions = KIT_REGISTRY.filter((kit) => kit.kitKey === 'professional-services')
      .map((kit) => kit.version)
      .sort();
    expect(versions).toEqual(['1.0.0', '1.1.0']);
  });

  it('the catalog serves the latest version of each kit, generically', () => {
    const catalog = listKitCatalog();
    expect(catalog.map((kit) => kit.kitKey).sort()).toEqual([
      'logistics-operations',
      'professional-services',
    ]);
    const ps = catalog.find((kit) => kit.kitKey === 'professional-services')!;
    expect(ps.version).toBe('1.1.0');
  });

  it('getKitDefinition resolves exact versions and refuses unknown ones', () => {
    expect(getKitDefinition('professional-services', '1.0.0').version).toBe('1.0.0');
    expect(getKitDefinition('professional-services').version).toBe('1.1.0');
    expect(() => getKitDefinition('professional-services', '2.0.0')).toThrowError(
      VerticalKitsError,
    );
    expect(() => getKitDefinition('no-such-kit')).toThrowError(VerticalKitsError);
  });
});

// ---------------------------------------------------------------------------
// The permission footprint (fail-closed, exactly the union)
// ---------------------------------------------------------------------------

describe('the permission footprint rule (fail-closed)', () => {
  it('the declared footprint is EXACTLY the union of the manifests\' requested sets, for every shipped kit', () => {
    for (const kit of KIT_REGISTRY) {
      expect(kit.permissionFootprint, `${kit.kitKey} ${kit.version}`).toEqual(
        unionPermissionsOf(kit),
      );
    }
  });

  it('rejects a kit whose footprint declares a permission NO manifest requests (the hostile footprint probe)', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    kit.permissionFootprint = [...kit.permissionFootprint, 'telemetry:emit'];
    expect(() => validateKitDefinition(kit)).toThrowError(/fail-closed/);
  });

  it('rejects a kit whose footprint OMITS a permission a manifest requests (under-declared grants misrepresent the install)', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    kit.permissionFootprint = kit.permissionFootprint.filter(
      (permission) => permission !== 'ui:render',
    );
    expect(() => validateKitDefinition(kit)).toThrowError(/footprint must be EXACTLY/);
  });

  it('rejects a footprint entry outside the closed extension permission vocabulary', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    (kit.permissionFootprint as string[]).push('root:everything');
    expect(() => validateKitDefinition(kit)).toThrowError(/not a known extension permission/);
  });
});

// ---------------------------------------------------------------------------
// Manifest validation (the extensions module's own rules, re-run)
// ---------------------------------------------------------------------------

describe('kit manifest validation (composed from the extensions contract)', () => {
  it('normalizes requested permissions into the extensions module\'s canonical order', () => {
    const kit = getKitDefinition('professional-services', '1.0.0');
    const manifest = kit.extensionManifests[0]!.manifest;
    const normalized = normalizeKitManifest({
      ...manifest,
      requestedPermissions: [...(manifest.requestedPermissions ?? [])].reverse(),
    });
    expect(normalized.requestedPermissions).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'events:subscribe',
      'external:participate',
    ]);
  });

  it('rejects a manifest requesting a permission NOT justified by its declared capabilities (the hostile manifest probe)', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    // The engagement sync declares no schedules and no telemetry: smuggling
    // those permissions in is a scope-hoarding probe the extensions
    // module's own consistency rule refuses.
    kit.extensionManifests[0]!.manifest = {
      ...kit.extensionManifests[0]!.manifest,
      requestedPermissions: [
        ...(kit.extensionManifests[0]!.manifest.requestedPermissions ?? []),
        'telemetry:emit',
      ],
    };
    expect(() => validateKitDefinition(kit)).toThrowError(/permission\/capability inconsistency/);
  });

  it('rejects a manifest whose capability lacks its justifying permission (undeclared capability)', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    kit.extensionManifests[0]!.manifest = {
      ...kit.extensionManifests[0]!.manifest,
      requestedPermissions: ['state:read', 'state:write', 'ui:render'],
    };
    expect(() => validateKitDefinition(kit)).toThrowError(/requires permission/);
  });

  it('rejects a manifest with a quota missing for a declared capability', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    kit.extensionManifests[1]!.manifest = {
      ...kit.extensionManifests[1]!.manifest,
      quotas: { maxStateBytes: 1, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 10 },
    };
    expect(() => validateKitDefinition(kit)).toThrowError(/quota inconsistency/);
  });

  it('rejects a manifest with an invalid cron expression', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    kit.extensionManifests[1]!.manifest = {
      ...kit.extensionManifests[1]!.manifest,
      schedules: [{ name: 'daily-timesheet-pull', cron: 'not-a-cron' }],
    };
    expect(() => validateKitDefinition(kit)).toThrowError(/cron/);
  });

  it('rejects a manifest with a non-https external participant origin', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    kit.extensionManifests[0]!.manifest = {
      ...kit.extensionManifests[0]!.manifest,
      externalParticipants: [{ label: 'Order SOR', origin: 'http://insecure.example.test' }],
    };
    expect(() => validateKitDefinition(kit)).toThrowError(/https origin/);
  });

  it('rejects a manifest with an unsupported manifest schema version', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    kit.extensionManifests[0]!.manifest = {
      ...kit.extensionManifests[0]!.manifest,
      manifestSchemaVersion: 99,
    };
    expect(() => validateKitDefinition(kit)).toThrowError(/manifestSchemaVersion/);
  });

  it('rejects a kit whose manifest rides an unknown connection requirement', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    kit.extensionManifests[0]!.connectionKey = 'no-such-connection';
    expect(() => validateKitDefinition(kit)).toThrowError(/connectionKey/);
  });

  it('the manifest subject equals the marketplace package subject shape (frozen-content discipline)', () => {
    const kit = getKitDefinition('professional-services', '1.0.0');
    const subject = kitManifestSubject(kit.extensionManifests[0]!.manifest);
    expect(subject).toMatchObject({
      manifestSchemaVersion: 1,
      requestedPermissions: [
        'state:read',
        'state:write',
        'ui:render',
        'events:subscribe',
        'external:participate',
      ],
    });
    expect(subject.capabilities.stateScope).toBe('tenant');
    expect(subject.quotas.maxExternalCallsPerDay).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Connection-class requirements (the W082 + W081 closed vocabularies)
// ---------------------------------------------------------------------------

describe('connection-class requirements (broker providers + capability classes)', () => {
  it('every shipped connection rides the closed broker provider vocabulary', () => {
    for (const kit of KIT_REGISTRY) {
      for (const connection of kit.connectionRequirements) {
        expect((BROKER_PROVIDERS as readonly string[]), connection.key).toContain(
          connection.brokerProvider,
        );
      }
    }
  });

  it('every shipped connection\'s classes are W081 registry keys', () => {
    for (const kit of KIT_REGISTRY) {
      for (const connection of kit.connectionRequirements) {
        for (const classKey of connection.capabilityClasses) {
          expect((CAPABILITY_CLASS_KEYS as readonly string[]), `${kit.kitKey}/${classKey}`).toContain(classKey);
        }
      }
    }
  });

  it('rejects an unknown broker provider', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    kit.connectionRequirements[0]!.brokerProvider = 'a-private-tms' as never;
    expect(() => validateKitDefinition(kit)).toThrowError(/closed provider vocabulary/);
  });

  it('rejects an unknown capability class', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    kit.connectionRequirements[0]!.capabilityClasses = ['inventory-levels'];
    expect(() => validateKitDefinition(kit)).toThrowError(/capability class key/);
  });
});

// ---------------------------------------------------------------------------
// Deep-action recipe templates (DATA shaped after the W084 contract)
// ---------------------------------------------------------------------------

describe('deep-action recipe templates (W084-shaped DATA)', () => {
  it('every shipped recipe operation rides a connection + a W081 write capability that connection offers', () => {
    const writeKeysByClass = new Map(
      CAPABILITY_CLASSES.map((entry) => [
        entry.key,
        entry.writeCapabilities.map((capability) => capability.key),
      ]),
    );
    for (const kit of KIT_REGISTRY) {
      const connections = new Map(kit.connectionRequirements.map((c) => [c.key, c]));
      for (const recipe of kit.deepActionRecipes) {
        expect(recipe.operations.length, recipe.recipeKey).toBeGreaterThanOrEqual(1);
        expect(recipe.operations.length).toBeLessThanOrEqual(16);
        for (const operation of recipe.operations) {
          const connection = connections.get(operation.connectionKey)!;
          expect(connection).toBeDefined();
          const offered = connection.capabilityClasses.flatMap(
            (classKey) => writeKeysByClass.get(classKey) ?? [],
          );
          expect(offered, `${recipe.recipeKey}/${operation.key}`).toContain(
            operation.capabilityKey,
          );
          expect(operation.capabilityKey.startsWith('write.')).toBe(true);
        }
      }
    }
  });

  it('rejects a recipe operation riding a capability the connection does not offer', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    // the financial SOR offers accounting-finance + billing-payments writes,
    // not project-tracking writes:
    kit.deepActionRecipes[0]!.operations[0]!.capabilityKey = 'write.project-tracking';
    expect(() => validateKitDefinition(kit)).toThrowError(/not offered by connection/);
  });

  it('rejects a recipe with an unknown connection key', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    kit.deepActionRecipes[0]!.operations[0]!.connectionKey = 'some-other-connection';
    expect(() => validateKitDefinition(kit)).toThrowError(/connectionKey/);
  });

  it('rejects a recipe with duplicate operation keys', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    kit.deepActionRecipes[0]!.operations[1] = {
      ...kit.deepActionRecipes[0]!.operations[1]!,
      key: kit.deepActionRecipes[0]!.operations[0]!.key,
    };
    expect(() => validateKitDefinition(kit)).toThrowError(/duplicate operations key/);
  });

  it('rejects a non-object payload', () => {
    const kit = clone(getKitDefinition('professional-services', '1.0.0'));
    (kit.deepActionRecipes[0]!.operations[0] as { payload: unknown }).payload = 'not-an-object';
    expect(() => validateKitDefinition(kit)).toThrowError(/plain JSON object/);
  });

  it('composes a real recipe into the deep-actions gateway input shape (pure, no execution)', () => {
    const kit = getKitDefinition('professional-services', '1.0.0');
    const recipe = kit.deepActionRecipes[0]!;
    const input = composeDeepActionInput(kit, recipe, {
      'ps-financial-sor': '6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e',
    });
    expect(input.taskContext.description).toBe(recipe.description);
    expect(input.operations).toHaveLength(2);
    expect(input.operations[0]).toEqual({
      key: 'post-month-timesheets',
      connectionId: '6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e',
      capabilityKey: 'write.accounting-finance',
      target: 'ledger/engagements/:engagementId/month/:period',
      payload: { entryKind: 'timesheet-batch', status: 'finalized' },
      expectation: { postingStatus: 'posted', reviewState: 'locked' },
    });
    expect(input.operations[1]!.capabilityKey).toBe('write.billing-payments');
  });

  it('refuses to compose when a referenced connection is unresolved (fail-closed)', () => {
    const kit = getKitDefinition('logistics-operations');
    const recipe = kit.deepActionRecipes[0]!;
    expect(() => composeDeepActionInput(kit, recipe, {})).toThrowError(/no resolved broker connection/);
    expect(() =>
      composeDeepActionInput(kit, recipe, { 'shipment-order-sor': 'conn-1' }),
    ).toThrowError(/no resolved broker connection/);
  });
});

// ---------------------------------------------------------------------------
// The honest pending-W088 edge declaration
// ---------------------------------------------------------------------------

describe('the edge-execution declaration (honest, PENDING W088)', () => {
  it('renders the single honest status for every kit — never an execution claim', () => {
    for (const kit of KIT_REGISTRY) {
      const info = edgeExecutionInfoOf(kit);
      expect(info.status).toBe(EDGE_EXECUTION_STATUS);
      expect(info.status).toBe('pending-w088');
    }
  });

  it('the logistics kit declares its latency-sensitive recipe; the professional-services kit declares none', () => {
    const logistics = edgeExecutionInfoOf(getKitDefinition('logistics-operations'));
    expect(logistics.recipes).toEqual(['expedite-shipment-replan']);
    const ps = edgeExecutionInfoOf(getKitDefinition('professional-services', '1.1.0'));
    expect(ps.recipes).toEqual([]);
  });

  it('rejects an edge declaration referencing an unknown recipe', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    kit.edgeExecution.recipeKeys = ['no-such-recipe'];
    expect(() => validateKitDefinition(kit)).toThrowError(/not a recipe of this kit/);
  });
});

// ---------------------------------------------------------------------------
// Honest metadata
// ---------------------------------------------------------------------------

describe('honest kit metadata', () => {
  it('every shipped kit declares its industry, outcomes AND an explicit not-included boundary', () => {
    for (const kit of KIT_REGISTRY) {
      expect(kit.metadata.industry.length).toBeGreaterThan(0);
      expect(kit.metadata.outcomes.length).toBeGreaterThanOrEqual(1);
      expect(kit.metadata.notIncluded.length).toBeGreaterThanOrEqual(1);
      expect(
        kit.metadata.notIncluded.some((entry) => entry.toLowerCase().includes('pending w088')),
        `${kit.kitKey} ${kit.version} must state the pending-edge boundary honestly`,
      ).toBe(true);
    }
  });

  it('rejects metadata without the honest not-included boundary', () => {
    const kit = clone(getKitDefinition('logistics-operations'));
    kit.metadata.notIncluded = [];
    expect(() => validateKitDefinition(kit)).toThrowError(/notIncluded/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clone(kit: VerticalKitDefinition): VerticalKitDefinition {
  return JSON.parse(JSON.stringify(kit)) as VerticalKitDefinition;
}
