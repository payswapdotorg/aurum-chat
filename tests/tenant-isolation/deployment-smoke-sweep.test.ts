// W044 — Tenant Isolation Verification · the deployment-smoke sweep (W078).
//
// The deployment-smoke module (W078 — Post-Deployment Smoke and
// Operations Proof) is a VERIFICATION HARNESS in the demo/journey-proof
// sense: it owns NO tables, NO migrations, NO HTTP surface of its own and
// NO domain records. Its public surface is the smoke check catalog, the
// pure expectation evaluators, the repo-surface checks (read-only file
// verification of the operations runbook), the HTTP driver and the report
// model — the artifacts `bun run smoke:dogfood` runs against a HOSTED
// deployment.
//
// This sweep proves the tenant boundary holds at both W044 doctrines:
//   * REPOSITORY BOUNDARY — the module owns no migrations and no tables:
//     after running every migration of the repository against a fresh
//     embedded database, no table exists that the module created (and its
//     migrations folder does not exist at all);
//   * APPLICATION BOUNDARY — the module cannot touch tenant-scoped state:
//     no file under src/modules/deployment-smoke/ imports the db port or
//     any database driver. The module's single cross-module dependency is
//     the demo module's PUBLIC CONTRACT (the manifest constants + the
//     pure seed-gate function — the same public surface the auth API
//     consumes); its file reads (repo.ts) target the repository's own
//     operations documents, never tenant data; its HTTP client talks to
//     deployments, not to the database.
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
const MODULE_DIR = path.join(REPO_ROOT, 'src', 'modules', 'deployment-smoke');

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(entryPath)));
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(entryPath);
  }
  return out.sort();
}

describe('W044 sweep — deployment-smoke (W078 verification harness)', () => {
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
    const owned = tables.filter(
      (table) => table.startsWith('smoke') || table.startsWith('deployment_smoke'),
    );
    expect(owned).toEqual([]);
    await closeDb();
  });

  it('cannot touch tenant-scoped state (no db port, no drivers; contracts only through the demo public surface)', async () => {
    const files = await listSourceFiles(MODULE_DIR);
    expect(files.length).toBeGreaterThan(0);
    const banned =
      /from\s+['"]@\/infra\/db['"]|from\s+['"]pg['"]|from\s+['"]@electric-sql\/pglite['"]|from\s+['"]ioredis['"]|from\s+['"]@\/infra\/queue['"]|from\s+['"]@\/infra\/cache['"]/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (banned.test(source)) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);

    // The single legal cross-module dependency is the demo module's public
    // contract (manifest constants + the pure seed gate) — pinned exactly.
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const contractImports = [...source.matchAll(/from\s+['"](@\/modules\/[^/]+\/contract)['"]/g)].map(
        (match) => match[1],
      );
      for (const specifier of contractImports) {
        expect(
          specifier,
          `${path.relative(REPO_ROOT, file)} imports ${specifier} — the smoke harness may depend only on the demo manifest contract`,
        ).toBe('@/modules/demo/contract');
      }
    }
  });
});
