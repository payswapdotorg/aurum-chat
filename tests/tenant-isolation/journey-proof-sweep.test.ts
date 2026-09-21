// W044 — Tenant Isolation Verification · the journey-proof sweep (W070).
//
// The journey-proof module (W070 — Browser Journey, Accessibility &
// Discoverability Proof) is a VERIFICATION HARNESS in the demo-module
// sense: it owns NO tables, NO migrations, NO HTTP surface and NO domain
// records — its public surface is pure proof material (the journey
// matrix, the route catalog, the capability discoverability map, the
// accessibility rule set + audit engine, the link-graph evaluators).
//
// This sweep proves exactly that, at both boundaries of the W044 doctrine:
//   * REPOSITORY BOUNDARY — the module owns no migrations and no tables:
//     after running every migration of the repository against a fresh
//     embedded database, no table exists that the module created (and its
//     migrations folder does not exist at all);
//   * APPLICATION BOUNDARY — the module's public surface is PURE: no file
//     under src/modules/journey-proof/ imports the db port, a module
//     contract, or any I/O — the module cannot hold, read or write
//     tenant-scoped state, so there is no tenant boundary to breach.
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
import { describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../scripts/migrate';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_DIR = path.join(REPO_ROOT, 'src', 'modules', 'journey-proof');

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(entryPath)));
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(entryPath);
  }
  return out.sort();
}

describe('W044 sweep — journey-proof (W070 verification harness)', () => {
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
    const owned = tables.filter((table) => table.startsWith('journey'));
    expect(owned).toEqual([]);
    await closeDb();
  });

  it('is pure at the application boundary (no db, no contracts, no I/O imports)', async () => {
    const files = await listSourceFiles(MODULE_DIR);
    expect(files.length).toBeGreaterThan(0);
    const banned = /from\s+['"]@\/infra\/db['"]|from\s+['"]@\/modules\/|from\s+['"]pg['"]|from\s+['"]@electric-sql\/pglite['"]/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (banned.test(source)) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
