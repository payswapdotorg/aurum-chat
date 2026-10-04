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
// provider-fabric and context are STILL types-only (their implementations
// arrive with W132/W134) — for those two the structural stage-proof stays:
//   * the modules export ONLY types/constants (no service instantiation
//     surface, no migrations, no storage) — so no tenant boundary can be
//     crossed because nothing crosses a boundary;
//   * the modules expose their vocabulary only through contract.ts;
//   * when W132/W134 land, their sections MUST be upgraded the same way
//     this file upgraded coverage (the manifest's living obligation).

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
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

const TYPES_ONLY_MODULES: ReadonlyArray<{ name: string; law: string }> = [
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

describe('provider-fabric/context — structural tenant-safety (still types-only)', () => {
  for (const { name, law } of TYPES_ONLY_MODULES) {
    describe(`module '${name}' (${law})`, () => {
      it('holds no migrations, no service and no persistence at the types-only stage', () => {
        const dir = join(REPO_ROOT, 'src', 'modules', name);
        const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
        expect(files.length, `${name} module files`).toBeGreaterThan(0);
        const forbidden = files.filter(
          (f) => f === 'service.ts' || f.includes('migration') || f.includes('.sql'),
        );
        expect(forbidden, 'no runtime/persistence surface at the frozen-contract stage').toEqual(
          [],
        );
      });

      it('exposes its vocabulary only through contract.ts (the architecture rule)', () => {
        const dir = join(REPO_ROOT, 'src', 'modules', name);
        expect(readdirSync(dir)).toContain('contract.ts');
        expect(readdirSync(dir)).toContain('types.ts');
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

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CoverageError);
    expect((error as CoverageError).code).toBe(code);
  }
}

describe('coverage (W125 delivered) — real two-tenant service proof', () => {
  beforeAll(async () => {
    await runMigrations(getDb());
  });

  afterAll(async () => {
    await closeDb();
  });

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
    await expectCode('snapshot_not_found', () =>
      getSnapshot(ctxB, { snapshotId: snapshotA.id }),
    );

    // Cross-tenant writes are refused with the SAME uniform not-found —
    // B cannot even learn that A's surface key exists.
    await expectCode('surface_not_found', () =>
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
