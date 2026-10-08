// W444-equivalent (W124 era) — Tenant Isolation Verification · sweep for
// the TL-frozen contract-vocabulary modules: coverage (W124), provider-
// fabric (W124b) and context (W124b).
//
// v2 (W125 integration, 2026-10-04): coverage LANDED its implementation —
// the registry/measurement service, five tenant-scoped tables and the
// 001-coverage migration. Per this file's own living-obligation rule
// ("when coverage/provider-fabric/context gain services and migrations,
// this sweep MUST be upgraded to drive them for two tenants"), the
// coverage section now DRIVES THE REAL SERVICE for two tenants: tenant A
// builds registry + claim + snapshot state; tenant B must see none of it
// (empty lists everywhere), cross-tenant reads must be uniform
// `snapshot_not_found`, cross-tenant writes must be uniform
// `surface_not_found`, and B's own evaluation must be independent of A's.
//
// v3 (WB2 integration, 2026-10-07): the SAME obligation is HONORED for
// provider-fabric (W132 delivered) and context (W134 delivered). The
// types-only structural stage-proof for those two is RETIRED — each now
// drives its real service for two tenants:
//   * provider-fabric — tenant A connects a known provider, registers a
//     catalog model and attaches a model binding; tenant B sees none of
//     it (empty definitions/catalog/bindings), a foreign definition id
//     reads uniformly `definition_not_found`, a cross-tenant binding
//     attach is refused with the same uniform not-found, and the same
//     provider slug coexists independently in both tenants;
//   * context — tenant A derives a fingerprint for a real goal; tenant B
//     sees none of it, a foreign fingerprint id reads uniformly
//     `fingerprint_not_found`, cross-tenant derivation on A's goal reads
//     uniformly `goal_not_found`, and the same observation content
//     coexists as independent fingerprints per tenant.
// Each delivered module also carries the inverse structural pin (service
// + migration + contract-only vocabulary) so the sweep always reflects
// the module's real surface, exactly like the coverage section's.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CoverageError,
  evaluateSnapshot,
  getSnapshot,
  listClaims,
  listGaps,
  listSnapshots,
  listSources,
  listSurfaces,
  recordClaim,
  registerSource,
  registerSurface,
} from '@/modules/coverage/contract';
import {
  ProviderFabricError,
  attachModelBinding,
  connectKnownProvider,
  getProviderDefinition,
  listModelBindings,
  listModelCatalog,
  listProviderDefinitions,
  registerModelManually,
} from '@/modules/provider-fabric/contract';
import {
  ContextError,
  deriveFingerprint,
  getFingerprint,
  listFingerprints,
} from '@/modules/context/contract';
import { createGoal } from '@/modules/goals/contract';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

const DELIVERED_MODULES: ReadonlyArray<{ name: string; law: string }> = [
  {
    name: 'coverage',
    law: 'coverage is a derived view over existing state, never a second organizational truth store',
  },
  {
    name: 'provider-fabric',
    law: 'provider definitions/catalogs/bindings reference credentials only through the credentialRef mechanism',
  },
  {
    name: 'context',
    law: 'context fingerprints record known context dimensions and never fabricate absent ones',
  },
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The delivered-persistence pin (the inverse of the retired types-only
// proof): every module this sweep claims has landed its implementation and
// owns exactly the runtime/persistence surface the two-tenant proofs
// below drive for real.
// ---------------------------------------------------------------------------

describe('coverage/provider-fabric/context — the delivered persistence surface', () => {
  for (const { name, law } of DELIVERED_MODULES) {
    describe(`module '${name}' (${law})`, () => {
      it('holds the delivered runtime/persistence surface: service + migration + contract-only vocabulary', () => {
        // The v3 structural claim — pinned so the sweep always reflects
        // the module's real surface: the module NOW owns a service, a
        // migration directory with at least one .sql file, and exposes its
        // vocabulary through contract.ts (the architecture rule).
        const dir = join(REPO_ROOT, 'src', 'modules', name);
        const entries = readdirSync(dir);
        expect(entries).toContain('contract.ts');
        expect(entries).toContain('types.ts');
        expect(entries).toContain('service.ts');
        expect(entries).toContain('migrations');
        const sqlFiles = readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql'));
        expect(sqlFiles.length).toBeGreaterThanOrEqual(1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// coverage — the W125-delivered registry/measurement service, driven for
// two tenants (the v2 upgrade of this sweep's living obligation).
// ---------------------------------------------------------------------------

const tenantSweepA = newId();
const tenantSweepB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

const UUID_SWEEP_SOURCE = '3e4a8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e77';
const UUID_SWEEP_BASIS = '4f5b8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e78';

async function expectCoverageCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CoverageError);
    expect((error as CoverageError).code).toBe(code);
  }
}

describe('coverage (W125 delivered) — real two-tenant service proof', () => {
  it("tenant A's registry, claims and snapshots are invisible to tenant B", async () => {
    const ctxA = member(tenantSweepA);
    const ctxB = member(tenantSweepB);

    // Tenant A builds real state through the public contract.
    await registerSurface(ctxA, { key: 'support-tickets', label: 'A tickets' });
    await registerSource(ctxA, {
      registry: 'source',
      ref: UUID_SWEEP_SOURCE,
      label: 'A source',
    });
    await recordClaim(ctxA, {
      surfaceKey: 'support-tickets',
      source: { registry: 'source', ref: UUID_SWEEP_SOURCE },
      observationBasis: { kind: 'observation-set', ids: [UUID_SWEEP_BASIS] },
      state: 'COVERED',
      confidenceValue: 0.9,
      reason: 'sweep tenant A claim',
    });
    const snapshotA = await evaluateSnapshot(ctxA);
    expect(snapshotA.tenantId).toBe(ctxA.tenantId);
    expect(snapshotA.surfaces.map((s) => s.surfaceKey)).toContain('support-tickets');

    // Tenant B's own registry is empty — none of A's state is visible.
    expect(await listSurfaces(ctxB)).toHaveLength(0);
    expect(await listSources(ctxB)).toHaveLength(0);
    expect(await listClaims(ctxB)).toHaveLength(0);
    expect(await listSnapshots(ctxB)).toHaveLength(0);
    expect(await listGaps(ctxB)).toHaveLength(0);

    // Cross-tenant reads are indistinguishable from missing records.
    await expectCoverageCode('snapshot_not_found', () =>
      getSnapshot(ctxB, { snapshotId: snapshotA.id }),
    );

    // Cross-tenant writes are refused with the SAME uniform not-found —
    // B cannot even learn that A's surface key exists.
    await expectCoverageCode('surface_not_found', () =>
      recordClaim(ctxB, {
        surfaceKey: 'support-tickets',
        source: { registry: 'source', ref: UUID_SWEEP_SOURCE },
        observationBasis: { kind: 'observation-set', ids: [UUID_SWEEP_BASIS] },
        state: 'COVERED',
        confidenceValue: 0.9,
        reason: 'sweep tenant B claiming on A surface',
      }),
    );

    // B's own evaluation is independent of A's state.
    const snapshotB = await evaluateSnapshot(ctxB);
    expect(snapshotB.tenantId).toBe(ctxB.tenantId);
    expect(snapshotB.surfaces).toHaveLength(0);
  });

  it('holds the delivered persistence surface: service + migration + contract-only vocabulary', () => {
    // The v2 structural claim — the inverse of the types-only proof, pinned
    // so the sweep always reflects the module's real surface: coverage NOW
    // owns exactly one service, one migration directory, and exposes its
    // vocabulary through contract.ts (the architecture rule).
    const dir = join(REPO_ROOT, 'src', 'modules', 'coverage');
    const entries = readdirSync(dir);
    expect(entries).toContain('contract.ts');
    expect(entries).toContain('types.ts');
    expect(entries).toContain('service.ts');
    expect(entries).toContain('migrations');
    const sqlFiles = readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// provider-fabric — the W132-delivered definition/catalog/binding service,
// driven for two tenants (the v3 upgrade of this sweep's living
// obligation).
// ---------------------------------------------------------------------------

async function expectFabricCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderFabricError);
    expect((error as ProviderFabricError).code).toBe(code);
  }
}

describe('provider-fabric (W132 delivered) — real two-tenant service proof', () => {
  it("tenant A's definitions, catalog and bindings are invisible to tenant B — and the same provider slug coexists in both", async () => {
    const ctxA = member(tenantSweepA);
    const ctxB = member(tenantSweepB);

    // Tenant A connects a real known provider, registers a catalog model
    // and attaches a model binding — all through the public contract.
    const definitionA = await connectKnownProvider(ctxA, { provider: 'openai' });
    expect(definitionA.tenantId).toBe(tenantSweepA);
    const entryA = await registerModelManually(ctxA, {
      definitionId: definitionA.definitionId,
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
    });
    expect(entryA.tenantId).toBe(tenantSweepA);
    const attachedA = await attachModelBinding(ctxA, {
      purpose: 'cognition',
      definitionId: definitionA.definitionId,
      modelId: 'gpt-4o-mini',
      accountId: newId(), // opaque W034 BYOA account reference
    });
    expect(attachedA.binding.tenantId).toBe(tenantSweepA);
    expect(attachedA.binding.status).toBe('active');

    // Tenant B's own fabric is empty — none of A's state is visible.
    expect(await listProviderDefinitions(ctxB, {})).toHaveLength(0);
    expect(await listModelCatalog(ctxB, {})).toHaveLength(0);
    expect(await listModelBindings(ctxB, {})).toHaveLength(0);

    // Cross-tenant reads are indistinguishable from missing records: a
    // FOREIGN definition id and a MISSING one reject identically.
    await expectFabricCode('definition_not_found', () =>
      getProviderDefinition(ctxB, { definitionId: definitionA.definitionId }),
    );
    await expectFabricCode('definition_not_found', () =>
      getProviderDefinition(ctxB, { definitionId: newId() }),
    );

    // Cross-tenant writes are refused with the SAME uniform not-found —
    // B cannot bind against A's definition (not even its catalog).
    await expectFabricCode('definition_not_found', () =>
      attachModelBinding(ctxB, {
        purpose: 'cognition',
        definitionId: definitionA.definitionId,
        modelId: 'gpt-4o-mini',
        accountId: newId(),
      }),
    );

    // The same natural key (the known-provider slug) coexists per tenant:
    // B connects its OWN 'openai' definition independently of A's.
    const definitionB = await connectKnownProvider(ctxB, { provider: 'openai' });
    expect(definitionB.definitionId).not.toBe(definitionA.definitionId);
    expect(definitionB.tenantId).toBe(tenantSweepB);
    expect((await listProviderDefinitions(ctxB, {})).map((d) => d.definitionId)).toEqual([
      definitionB.definitionId,
    ]);
    // And A's catalog still holds exactly its own entry.
    expect((await listModelCatalog(ctxA, {})).map((e) => e.modelId)).toEqual(['gpt-4o-mini']);
  });
});

// ---------------------------------------------------------------------------
// context — the W134-delivered fingerprint derivation service, driven for
// two tenants (the v3 upgrade of this sweep's living obligation).
// ---------------------------------------------------------------------------

async function expectContextCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextError);
    expect((error as ContextError).code).toBe(code);
  }
}

function sweepGoalInput(title: string) {
  return {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team' as const, label: 'operations' },
    priority: 'high' as const,
    successCriteria: 'Measurable success',
    actor: { kind: 'system' as const, label: 'wb2-sweep' },
  };
}

function sweepObservations() {
  return {
    season: { window: 'spring', note: 'clear weather forecast' },
    duration: { durationClass: 'short' as const, estimatedSpan: '~6 weeks' },
    staffing: {
      headcount: 6,
      experienceMix: { novice: 5, intermediate: 1, expert: 0 },
      note: null,
    },
    workload: 'light' as const,
  };
}

describe('context (W134 delivered) — real two-tenant service proof', () => {
  it("tenant A's fingerprints are invisible to tenant B — and the same observation content coexists per tenant", async () => {
    const ctxA = member(tenantSweepA);
    const ctxB = member(tenantSweepB);

    // Tenant A derives a real fingerprint for a real goal of its own.
    const goalA = await createGoal(ctxA, sweepGoalInput('WB2 sweep context goal'));
    const fingerprintA = await deriveFingerprint(ctxA, {
      goalId: goalA.id,
      observations: sweepObservations(),
      derivedFrom: ['wb2-sweep-obs-1'],
    });
    expect(fingerprintA.tenantId).toBe(tenantSweepA);
    expect(fingerprintA.goalId).toBe(goalA.id);

    // Tenant B's own fingerprint history is empty — none of A's state is
    // visible (list filters stay per-tenant).
    expect(await listFingerprints(ctxB, {})).toHaveLength(0);

    // Cross-tenant reads are indistinguishable from missing records: a
    // FOREIGN fingerprint id and a MISSING one reject identically.
    await expectContextCode('fingerprint_not_found', () =>
      getFingerprint(ctxB, { fingerprintId: fingerprintA.fingerprintId }),
    );
    await expectContextCode('fingerprint_not_found', () =>
      getFingerprint(ctxB, { fingerprintId: newId() }),
    );

    // Cross-tenant derivation is refused with the SAME uniform not-found
    // mapped from the goals contract — B cannot fingerprint A's goal (and
    // cannot even learn it exists).
    await expectContextCode('goal_not_found', () =>
      deriveFingerprint(ctxB, { goalId: goalA.id, observations: sweepObservations() }),
    );

    // The same natural key (the same goal title, the same observation
    // content) coexists per tenant: B derives its OWN fingerprint for its
    // OWN goal, independent of A's.
    const goalB = await createGoal(ctxB, sweepGoalInput('WB2 sweep context goal'));
    const fingerprintB = await deriveFingerprint(ctxB, {
      goalId: goalB.id,
      observations: sweepObservations(),
      derivedFrom: ['wb2-sweep-obs-1'],
    });
    expect(fingerprintB.fingerprintId).not.toBe(fingerprintA.fingerprintId);
    expect(fingerprintB.tenantId).toBe(tenantSweepB);
    expect((await listFingerprints(ctxB, {})).map((f) => f.fingerprintId)).toEqual([
      fingerprintB.fingerprintId,
    ]);
    // And A's history still holds exactly its own fingerprint.
    expect((await listFingerprints(ctxA, {})).map((f) => f.fingerprintId)).toEqual([
      fingerprintA.fingerprintId,
    ]);
  });
});
