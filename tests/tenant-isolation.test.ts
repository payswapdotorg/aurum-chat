// W044 — Tenant Isolation Verification (spec/work-items/WORK-ITEM-CATALOG.md):
// "Automated authorization and integration tests proving every
//  information-bearing module is tenant-safe."
//
// One integration file drives every module's PUBLIC CONTRACT against the
// embedded PostgreSQL (PGlite, `:memory:`) and enforces ADR-0001 uniformly:
//
//  1. Exhaustiveness — the probe registry must cover every module that owns
//     migrations (nothing information-bearing ships unprobed), and each
//     probed module must own tenant-scoped tables (the storage sweep has
//     teeth).
//  2. Storage layer — every non-exempt table carries a NOT NULL tenant_id
//     with no default: no anonymous rows, no ambient tenant identity.
//  3. Per module, through the contracts only:
//       - reads:  another tenant's record is indistinguishable from a
//                 missing one (uniform not-found) while the owning tenant
//                 still resolves it;
//       - lists:  each tenant sees its own records and never the other's;
//       - writes: referencing another tenant's records fails exactly like
//                 referencing missing ones, leaves storage untouched (row
//                 counts per tenant unchanged) and the target tenant's data
//                 intact;
//       - every contract call validates its TenantContext before any data
//                 access (`invalid_context`);
//       - module-specific invariants (same natural key in two tenants,
//                 policy/vocabulary isolation, …) as named checks.
//
// The protocol is module-independent on purpose: adding a module or an
// operation that breaks any of these invariants fails here the same way,
// with a message naming the module and the attempt.
//
// Fixtures are prepared at module-evaluation time (top-level await) so the
// per-check `it`s can be registered with real names; the database env is
// pinned before the first getDb() call exactly like the sibling module
// tests, and the provider-seam fake transports are installed once for the
// whole file.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../scripts/migrate';
import { setChannelTransport } from '@/modules/channels/contract';
import { setLlmTransport } from '@/modules/llm/contract';
import { PROBES } from './tenant-isolation';
import {
  discoverInformationModules,
  moduleTables,
  tenantCounts,
  w044ChannelTransport,
  w044LlmTransport,
  type ModuleProbe,
  type ModuleScene,
} from './tenant-isolation/harness';

// One file, seventeen module setups, one embedded database: allow the long
// haul without weakening the per-test default anywhere else.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'arch-allowlist.json');

// ---------------------------------------------------------------------------
// Uniform assertion helpers (clear, attempt-named failures)
// ---------------------------------------------------------------------------

/** `promise` must reject with exactly `code`; anything else is a failure naming the attempt. */
async function expectRejection(
  promise: Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const actual = (error as { code?: unknown }).code;
    if (actual !== code) {
      throw new Error(
        `W044 ${label}: expected error code '${code}', got '${String(actual)}' (${String(error)})`,
        { cause: error },
      );
    }
    return;
  }
  throw new Error(`W044 ${label}: expected error code '${code}', but the call resolved`);
}

/** The id values of `keys` in `ids` (the records the checks look for). */
function idValuesOf(ids: Record<string, string>, keys: string[]): string[] {
  return keys.map((key) => ids[key]).filter((value): value is string => value !== undefined);
}

/** A copy of `ids` with every idKey value replaced by a fresh uuid (the missing-id pass). */
function withMissingIds(idKeys: string[], ids: Record<string, string>): Record<string, string> {
  const missing: Record<string, string> = { ...ids };
  for (const key of idKeys) {
    if (missing[key] !== undefined) missing[key] = newId();
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Fixtures: migrations once, provider-seam transports once, every scene once
// ---------------------------------------------------------------------------

await runMigrations(getDb());
setChannelTransport(w044ChannelTransport);
setLlmTransport(w044LlmTransport);

const scenes: Array<{ probe: ModuleProbe; scene: ModuleScene }> = [];
for (const probe of PROBES) {
  scenes.push({ probe, scene: await probe.setup() });
}

afterAll(async () => {
  setChannelTransport(null);
  setLlmTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// 1) Exhaustiveness + 2) storage layer
// ---------------------------------------------------------------------------

describe('W044 — exhaustiveness: every information-bearing module is probed', () => {
  it('the probe registry covers exactly the modules that own migrations', () => {
    const discovered = discoverInformationModules();
    const probed = PROBES.map((probe) => probe.module).sort();
    expect(probed).toEqual(discovered);
  });

  it('every probed module owns at least one tenant-scoped table (the storage sweep has teeth)', async () => {
    for (const probe of PROBES) {
      const tables = await moduleTables(probe.module);
      expect(
        tables.length,
        `module '${probe.module}' owns no tenant-scoped tables`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('W044 — storage layer: tenant scoping is structural', () => {
  it('every non-exempt table carries a NOT NULL tenant_id with no default', async () => {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as { tables: string[] };
    const exempt = new Set<string>([
      ...allowlist.tables.map((table) => table.toLowerCase()),
      '_migrations',
    ]);
    const tables = (
      await getDb().query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).rows.map((row) => row.table_name);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      if (exempt.has(table.toLowerCase())) continue;
      const columns = await getDb().query<{ is_nullable: string; column_default: string | null }>(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(
        columns.rows,
        `table '${table}' has no tenant_id column — every domain table must be tenant-scoped`,
      ).toHaveLength(1);
      expect(columns.rows[0]!.is_nullable, `tenant_id of '${table}' must be NOT NULL`).toBe('NO');
      expect(
        columns.rows[0]!.column_default,
        `tenant_id of '${table}' must have no default — tenant identity always comes from the caller's context`,
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 3) The uniform per-module sweep
// ---------------------------------------------------------------------------

for (const { probe, scene } of scenes) {
  describe(`W044 tenant isolation — module '${probe.module}'`, () => {
    it('cross-tenant reads are the uniform not-found: foreign ≡ missing, own resolves', async () => {
      expect(scene.reads.length).toBeGreaterThan(0);
      for (const read of scene.reads) {
        const label = `${probe.module}/${read.name}`;
        await expectRejection(read.run(scene.ctxB, scene.ids), read.code, `${label} [foreign]`);
        await expectRejection(
          read.run(scene.ctxB, withMissingIds(scene.idKeys, scene.ids)),
          read.code,
          `${label} [missing]`,
        );
        // positive control: the owning tenant performs the same read without error
        await read.run(scene.ctxA, scene.ids);
      }
    });

    it('cross-tenant lists never surface the other tenant\'s records', async () => {
      expect(scene.lists.length).toBeGreaterThan(0);
      const ownIds = idValuesOf(scene.ids, scene.idKeys);
      const ownIdsB = idValuesOf(scene.idsB, scene.idKeys);
      for (const list of scene.lists) {
        const label = `${probe.module}/${list.name}`;
        const own = await list.run(scene.ctxA, scene.ids);
        const ownJson = JSON.stringify(own);
        if (!ownIds.some((id) => ownJson.includes(id))) {
          throw new Error(
            `W044 ${label} [own-A]: seeded ids never surfaced in ${ownJson.slice(0, 400)}`,
          );
        }
        const ownB = await list.run(scene.ctxB, scene.idsB);
        const ownBJson = JSON.stringify(ownB);
        if (!ownIdsB.some((id) => ownBJson.includes(id))) {
          throw new Error(
            `W044 ${label} [own-B]: seeded ids never surfaced in ${ownBJson.slice(0, 400)}`,
          );
        }
        const foreign = await list.run(scene.ctxB, scene.ids);
        const foreignJson = JSON.stringify(foreign);
        const leaked = ownIds.filter((id) => foreignJson.includes(id));
        if (leaked.length > 0) {
          throw new Error(
            `W044 ${label} [foreign]: tenant A ids leaked into tenant B's results (${leaked.join(', ')})`,
          );
        }
      }
    });

    it('cross-tenant writes fail (foreign ≡ missing) and leave storage untouched', async () => {
      expect(scene.writes.length).toBeGreaterThan(0);
      const tables = await moduleTables(probe.module);
      const tenants = [scene.ctxA.tenantId, scene.ctxB.tenantId];
      const before = await tenantCounts(tables, tenants);
      for (const write of scene.writes) {
        const label = `${probe.module}/${write.name}`;
        await expectRejection(write.run(scene.ctxB, scene.ids), write.code, `${label} [foreign]`);
        await expectRejection(
          write.run(scene.ctxB, withMissingIds(scene.idKeys, scene.ids)),
          write.code,
          `${label} [missing]`,
        );
      }
      const after = await tenantCounts(tables, tenants);
      expect(after).toEqual(before);
      // integrity: the target tenant's records are all still readable
      for (const read of scene.reads) {
        await read.run(scene.ctxA, scene.ids);
      }
    });

    it('rejects a malformed tenant context before any data access', async () => {
      const malformed: TenantContext = { ...scene.ctxB, tenantId: '' };
      await expectRejection(
        scene.contextProbe(malformed),
        'invalid_context',
        `${probe.module}/context`,
      );
    });

    for (const check of scene.checks) {
      it(check.name, check.run);
    }
  });
}
