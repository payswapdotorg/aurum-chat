// W044 — Tenant Isolation Verification · the execution sweep (W131).
//
// The execution module (W131 — Execution Platform and Cross-Platform
// Architecture Study) is a FROZEN CONTRACT SURFACE in the journey-proof
// sense: it owns NO tables, NO migrations, NO HTTP surface and NO domain
// records — its public surface is pure types (the frozen vocabulary for
// interchangeable execution environments, durable task workers,
// browser/computer sessions, the shared client/runtime surface and
// cross-device continuity that W137/W139 build against).
//
// This sweep proves exactly that, at both boundaries of the W044 doctrine
// (the journey-proof precedent for verification-harness modules):
//   * REPOSITORY BOUNDARY — the module owns no migrations and no tables:
//     after running every migration of the repository against a fresh
//     embedded database, no table exists that the module created (and its
//     migrations folder does not exist at all);
//   * APPLICATION BOUNDARY — the module is PURE: no file under
//     src/modules/execution/ imports the db port, another module's
//     contract, or any I/O — the module cannot hold, read or write
//     tenant-scoped state, so there is no tenant boundary to breach.
//
// The frozen contracts additionally bake tenant isolation INTO THE TYPES
// (SessionIsolationProperties.tenantIsolated is the literal `true` — a
// non-tenant-isolated session is inexpressible), asserted here so the
// claim is tested, not stated.
//
// The coverage tripwire (coverage-manifest.test.ts) keeps this claim
// honest: if the module ever gains state, this sweep must be replaced by
// a real two-tenant contract sweep.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../scripts/migrate';
import type { SessionIsolationProperties } from '@/modules/execution/contract';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_DIR = path.join(REPO_ROOT, 'src', 'modules', 'execution');

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(entryPath)));
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(entryPath);
  }
  return out.sort();
}

describe('W044 sweep — execution (W131 frozen contract surface)', () => {
  it('owns no migrations (the repository boundary has nothing from this module)', () => {
    expect(existsSync(path.join(MODULE_DIR, 'migrations'))).toBe(false);
  });

  it('creates no tables (a fresh migrated schema has none from this module)', async () => {
    await runMigrations(getDb());
    const tables = (
      await getDb().query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).rows.map((row) => row.table_name.toLowerCase());
    // W136 integration (2026-10-08): the prefix heuristic needs a scoped
    // exclusion — the agent-exchange module (W136, a DIFFERENT module: the
    // orchestration projection) legitimately owns the six execution_plan*
    // tables. The claim proven here is unchanged: the EXECUTION module
    // (W131, this frozen contract surface) still owns no migrations and no
    // tables of its own; the six excluded tables belong to agent-exchange
    // and carry their own REAL two-tenant service proof in
    // tests/tenant-isolation/agent-exchange-sweep.test.ts (manifest v10).
    const ownedByAgentExchange = new Set([
      'execution_plans',
      'execution_plan_tasks',
      'execution_plan_members',
      'execution_plan_handoffs',
      'execution_plan_approvals',
      'execution_plan_runs',
    ]);
    const owned = tables.filter(
      (table) => table.startsWith('execution') && !ownedByAgentExchange.has(table),
    );
    expect(owned).toEqual([]);
    await closeDb();
  });

  it('is pure at the application boundary (no db, no contracts, no I/O imports)', async () => {
    const files = await listSourceFiles(MODULE_DIR);
    expect(files.length).toBeGreaterThan(0);
    const banned =
      /from\s+['"]@\/infra\/db['"]|from\s+['"]@\/modules\/|from\s+['"]pg['"]|from\s+['"]@electric-sql\/pglite['"]|from\s+['"]ioredis['"]/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (banned.test(source)) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('bakes tenant isolation into the frozen types (the literal `true`)', () => {
    expectTypeOf<SessionIsolationProperties['tenantIsolated']>().toEqualTypeOf<true>();
    expectTypeOf<SessionIsolationProperties['credentialHandling']>().toEqualTypeOf<'opaque-ref-only'>();
  });
});
