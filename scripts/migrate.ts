// Migration runner (W000).
//
// Discovers `src/modules/*/migrations/NNN-*.sql`, orders modules by a
// topological sort of contract-import edges (an import of
// `from '@/modules/<m>/contract'` makes the importer depend on <m>;
// dependencies are applied before their dependents; modules that are
// simultaneously ready sort alphabetically), applies each file inside its
// own transaction, and records it in `_migrations`. Already-recorded files
// are skipped, so the runner is idempotent. A dependency cycle is a hard
// error, as is an import of an unknown module's contract.
//
// Runs against the standard db port (embedded by default; DATABASE_URL for
// staging/production — see src/infra/db.ts). Handles an absent or empty
// src/modules/ gracefully.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb, type DbPort } from '../src/infra/db';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODULES_DIR = path.join(REPO_ROOT, 'src', 'modules');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MIGRATION_FILE_PATTERN = /^\d+-.*\.sql$/;

export interface MigrationFile {
  module: string;
  file: string;
  /** Stable migration identity: `<module>/<file>`. */
  name: string;
  path: string;
}

export interface MigrationReport {
  /** Modules in migration order (dependencies before dependents). */
  order: string[];
  applied: string[];
  skipped: string[];
}

/**
 * Split a .sql document into individual statements, preserving string
 * literals ('...' with '' escaping), quoted identifiers ("..."), line/block
 * comments and dollar-quoted bodies ($$ ... $$, $tag$ ... $tag$) — so
 * semicolons inside those constructs never split a statement.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? len : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = sql.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? len : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tagMatch !== null) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? len : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      const statement = current.trim();
      if (statement !== '') statements.push(statement);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail !== '') statements.push(tail);
  return statements;
}

async function listFilesRecursively(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursively(entryPath)));
    else if (entry.isFile()) out.push(entryPath);
  }
  return out;
}

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

/** Module directories present under `modulesDir` (sorted; [] when absent). */
export async function listModules(modulesDir: string = DEFAULT_MODULES_DIR): Promise<string[]> {
  if (!existsSync(modulesDir)) return [];
  const entries = await readdir(modulesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Module names imported by `code` through `... from '@/modules/<m>/contract'`. */
export function contractImports(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/['"]@\/modules\/([A-Za-z0-9-]+)\/contract['"]/g)) {
    found.push(match[1]!);
  }
  return found;
}

/**
 * Module migration order: topological sort of contract-import edges.
 * A module that imports another module's contract is applied after it;
 * among simultaneously ready modules the order is alphabetical. Cycles are
 * hard errors.
 */
export async function computeModuleOrder(
  modulesDir: string = DEFAULT_MODULES_DIR,
): Promise<string[]> {
  const modules = await listModules(modulesDir);
  if (modules.length === 0) return [];
  const dependencies = new Map<string, Set<string>>();
  for (const moduleName of modules) dependencies.set(moduleName, new Set<string>());
  for (const moduleName of modules) {
    const files = (await listFilesRecursively(path.join(modulesDir, moduleName))).filter(isSourceFile);
    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const imported of contractImports(code)) {
        if (imported === moduleName) continue; // self-imports are not edges
        if (!dependencies.has(imported)) {
          throw new Error(
            `module '${moduleName}' imports the contract of unknown module '${imported}' (${path.relative(REPO_ROOT, file)})`,
          );
        }
        dependencies.get(moduleName)!.add(imported);
      }
    }
  }
  const pending = new Set(modules);
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((moduleName) => {
        for (const dep of dependencies.get(moduleName)!) {
          if (pending.has(dep)) return false;
        }
        return true;
      })
      .sort();
    if (ready.length === 0) {
      throw new Error(`dependency cycle detected between modules: ${[...pending].sort().join(', ')}`);
    }
    for (const moduleName of ready) {
      order.push(moduleName);
      pending.delete(moduleName);
    }
  }
  return order;
}

async function moduleMigrationsInOrder(modulesDir: string): Promise<{ order: string[]; migrations: MigrationFile[] }> {
  const order = await computeModuleOrder(modulesDir);
  const migrations: MigrationFile[] = [];
  for (const moduleName of order) {
    const moduleMigrationsDir = path.join(modulesDir, moduleName, 'migrations');
    if (!existsSync(moduleMigrationsDir)) continue;
    const files = (await readdir(moduleMigrationsDir))
      .filter((file) => MIGRATION_FILE_PATTERN.test(file))
      .sort();
    for (const file of files) {
      migrations.push({
        module: moduleName,
        file,
        name: `${moduleName}/${file}`,
        path: path.join(moduleMigrationsDir, file),
      });
    }
  }
  return { order, migrations };
}

/** Every migration file of every module, in module order then filename order. */
export async function discoverMigrations(
  modulesDir: string = DEFAULT_MODULES_DIR,
): Promise<MigrationFile[]> {
  return (await moduleMigrationsInOrder(modulesDir)).migrations;
}

/**
 * Apply all pending migrations against `db`:
 * `_migrations` bookkeeping table, then each new file inside its own
 * transaction (statements executed one by one, split quote-aware).
 * Idempotent — already-recorded migrations are skipped.
 */
export async function runMigrations(
  db: DbPort,
  modulesDir: string = DEFAULT_MODULES_DIR,
): Promise<MigrationReport> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       name text NOT NULL UNIQUE,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied = await db.query<{ name: string }>(`SELECT name FROM _migrations`);
  const alreadyApplied = new Set(applied.rows.map((row) => row.name));
  const { order, migrations } = await moduleMigrationsInOrder(modulesDir);
  const report: MigrationReport = { order, applied: [], skipped: [] };
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.name)) {
      report.skipped.push(migration.name);
      continue;
    }
    const sql = await readFile(migration.path, 'utf8');
    const statements = splitSqlStatements(sql);
    await db.transaction(async (tx) => {
      for (const statement of statements) {
        await tx.query(statement);
      }
      await tx.query(`INSERT INTO _migrations (name) VALUES ($1)`, [migration.name]);
    });
    report.applied.push(migration.name);
  }
  return report;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const db = getDb();
  const report = await runMigrations(db);
  const order = report.order.length > 0 ? report.order.join(' -> ') : '(no modules found)';
  console.log(`module order: ${order}`);
  console.log(`applied ${report.applied.length} migration(s), skipped ${report.skipped.length}`);
  for (const name of report.applied) console.log(`  + ${name}`);
}

if (invokedDirectly) {
  void (async () => {
    try {
      await main();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      await closeDb().catch(() => undefined);
    }
  })();
}
