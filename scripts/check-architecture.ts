// Architecture gate (W000). Exits non-zero on any violation:
//
//  (a) any file under src/modules/** importing `next`, `next/*`, `react`,
//      `react-dom`, `pg`, `@electric-sql/pglite` or `ioredis`;
//  (b) a module importing another module's internals — the only legal
//      cross-module import is exactly `@/modules/<m>/contract`;
//  (c) any file under src/app/** or src/mcp/** importing another module's
//      internals — module contracts only;
//  (d) after running all migrations against a fresh embedded (`:memory:`)
//      database, every table except the `scripts/arch-allowlist.json` names
//      and `_migrations` must carry a `tenant_id` column (violation lists
//      the table and the migration file that created it).
//
// Handles an absent src/modules/ and src/mcp/ gracefully (W000 ships
// neither).

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '../src/infra/db';
import { discoverMigrations, runMigrations } from './migrate';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const MODULES_DIR = path.join(SRC_DIR, 'modules');
const APP_DIR = path.join(SRC_DIR, 'app');
const MCP_DIR = path.join(SRC_DIR, 'mcp');
const ALLOWLIST_PATH = path.join(SCRIPT_DIR, 'arch-allowlist.json');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const BANNED_IN_MODULES = new Set([
  'next',
  'react',
  'react-dom',
  'pg',
  '@electric-sql/pglite',
  'ioredis',
]);

interface ArchAllowlist {
  tables: string[];
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file);
}

async function listSourceFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(entryPath);
    }
  };
  await walk(dir);
  return out.sort();
}

/** All import specifiers used by a source file (from-clauses, side-effect, dynamic, require). */
function importSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const match of code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1]!);
  for (const match of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1]!);
  for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]!);
  for (const match of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]!);
  return specifiers;
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0]!;
}

function isAlias(specifier: string): boolean {
  return specifier.startsWith('@/');
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function moduleNameOfModuleFile(file: string): string {
  return path.relative(MODULES_DIR, file).split(path.sep)[0]!;
}

/** Is `resolved` (a real path) the contract file of a module under src/modules? */
function isModuleContractPath(resolved: string): boolean {
  const relative = path.relative(MODULES_DIR, resolved);
  if (relative.startsWith('..')) return false;
  const parts = relative.split(path.sep);
  if (parts.length < 2) return false;
  const ext = path.extname(parts[1]!);
  const second = ext === '' ? parts[1]! : parts[1]!.slice(0, -ext.length);
  if (parts.length === 2 && second === 'contract') return true;
  if (parts.length === 3 && second === 'contract' && parts[2] === `index${ext}` && ext !== '') {
    return true;
  }
  return false;
}

/**
 * If `specifier` is an illegal cross-module import from `file`, return the
 * violation message; otherwise null. `ownModule` is the importing module
 * (null for files under src/app/** or src/mcp/**), `rule` is 'b' or 'c'.
 */
function crossModuleImport(
  file: string,
  specifier: string,
  ownModule: string | null,
  rule: 'b' | 'c',
): string | null {
  const aliasMatch = /^@\/modules\/([^/]+)(?:\/([^/].*))?$/.exec(specifier);
  if (aliasMatch !== null) {
    const targetModule = aliasMatch[1]!;
    if (targetModule === ownModule) return null;
    if (aliasMatch[2] === 'contract') return null; // exactly '@/modules/<m>/contract'
    return `(${rule}) ${rel(file)} imports '${specifier}' — cross-module imports must target '@/modules/${targetModule}/contract' only`;
  }
  if (isRelative(specifier)) {
    const resolved = path.normalize(path.resolve(path.dirname(file), specifier));
    const relative = path.relative(MODULES_DIR, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const targetModule = relative.split(path.sep)[0]!;
    if (targetModule === ownModule) return null;
    if (isModuleContractPath(resolved)) return null;
    return `(${rule}) ${rel(file)} imports '${specifier}' — cross-module imports must target ${targetModule}'s contract only`;
  }
  return null;
}

/** Rule (a): framework/driver packages are banned inside domain modules. */
function bannedPackageImport(file: string, specifier: string): string | null {
  if (isAlias(specifier) || isRelative(specifier) || specifier.startsWith('/')) return null;
  const pkg = packageName(specifier);
  if (BANNED_IN_MODULES.has(pkg)) {
    return `(a) ${rel(file)} imports banned package '${pkg}' (domain modules must stay framework- and driver-free)`;
  }
  return null;
}

/** Rule (d): migrate a fresh embedded db, then require tenant_id on every non-exempt table. */
async function checkTenantColumns(violations: string[]): Promise<number> {
  // Force a fresh, isolated embedded `:memory:` database — never dev data.
  process.env.AURUM_DB = 'embedded';
  process.env.AURUM_DB_MEMORY = '1';
  delete process.env.DATABASE_URL;
  const db = getDb();
  await runMigrations(db);

  // Map each table to the migration file that created it (for messages).
  const creators = new Map<string, string>();
  for (const migration of await discoverMigrations()) {
    const sql = await readFile(migration.path, 'utf8');
    for (const match of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi,
    )) {
      const table = match[1]!.toLowerCase();
      if (!creators.has(table)) creators.set(table, migration.name);
    }
  }

  const allowlist = JSON.parse(await readFile(ALLOWLIST_PATH, 'utf8')) as ArchAllowlist;
  const exempt = new Set<string>([...allowlist.tables.map((t) => t.toLowerCase()), '_migrations']);

  const tables = (
    await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )
  ).rows.map((row) => row.table_name);

  let checked = 0;
  for (const table of tables) {
    if (exempt.has(table.toLowerCase())) continue;
    checked += 1;
    const columns = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
    ).rows.map((row) => row.column_name.toLowerCase());
    if (!columns.includes('tenant_id')) {
      const createdBy = creators.get(table.toLowerCase());
      const origin = createdBy === undefined ? '' : ` (created by ${createdBy})`;
      violations.push(
        `(d) table '${table}'${origin} has no tenant_id column — every domain table must be tenant-scoped`,
      );
    }
  }
  await closeDb();
  return checked;
}

async function main(): Promise<void> {
  const violations: string[] = [];

  // (a) + (b): domain modules are framework-free and import contracts only.
  const moduleFiles = await listSourceFiles(MODULES_DIR);
  for (const file of moduleFiles) {
    const ownModule = moduleNameOfModuleFile(file);
    const code = await readFile(file, 'utf8');
    for (const specifier of importSpecifiers(code)) {
      const banned = bannedPackageImport(file, specifier);
      if (banned !== null) violations.push(banned);
      const cross = crossModuleImport(file, specifier, ownModule, 'b');
      if (cross !== null) violations.push(cross);
    }
  }

  // (c): app/mcp surfaces may import module contracts only.
  let surfaceFiles = 0;
  for (const dir of [APP_DIR, MCP_DIR]) {
    const files = await listSourceFiles(dir);
    surfaceFiles += files.length;
    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const specifier of importSpecifiers(code)) {
        const cross = crossModuleImport(file, specifier, null, 'c');
        if (cross !== null) violations.push(cross);
      }
    }
  }

  // (d): tenant scoping after migrations.
  const tablesChecked = await checkTenantColumns(violations);

  if (violations.length > 0) {
    for (const violation of violations) console.error(`ARCH VIOLATION: ${violation}`);
    console.error(
      `architecture check FAILED (${violations.length} violation${violations.length === 1 ? '' : 's'})`,
    );
    process.exit(1);
  }
  console.log(
    `architecture check passed — module files: ${moduleFiles.length}, app/mcp files: ${surfaceFiles}, tables checked: ${tablesChecked}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
