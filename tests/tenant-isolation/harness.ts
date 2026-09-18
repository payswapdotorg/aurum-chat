// W044 — Tenant Isolation Verification · shared harness for the cross-module
// tenant-isolation sweeps (tests/tenant-isolation/**).
//
// IMPLEMENTATION-STACK §7: "Cross-cutting fixtures live in `tests/` at repo
// root (tenant isolation sweeps W044, ...)". This file holds the helpers
// every sweep file reuses; it is NOT a test file (vitest testMatch picks up
// only `**/*.test.ts`).
//
// Sweep doctrine (W044 + ADR-0001 + GOVERNANCE.md "tenant isolation is tested
// at repository and application boundaries"):
//   * application boundary — every module contract is driven for two tenants;
//     cross-tenant reads/writes must fail with the module's uniform
//     not-found code (indistinguishable from a missing record — no existence
//     leaks), lists must stay per-tenant, and writes must never mutate
//     another tenant's rows;
//   * repository boundary — the migrated schema itself is swept (tenant_id
//     presence/type/nullability, per-tenant unique namespaces, tenant-safe
//     foreign keys) plus a row-partition integrity check over every
//     tenant-scoped table after the fixtures ran.
//
// Scope rules honored here: module code is imported ONLY through
// `@/modules/<m>/contract` (never internals); infra ports (`@/infra/*`) and
// the migration runner are shared infrastructure, not domain modules.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export { runMigrations };

// ---------------------------------------------------------------------------
// Context factories
// ---------------------------------------------------------------------------

/** A plain member context of `tenantId` (fresh principal, no claims). */
export function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** A member context of `tenantId` carrying `claims`. */
export function memberWith(tenantId: string, claims: string[]): TenantContext {
  return { tenantId, principalId: newId(), authority: claims };
}

/**
 * Every authority claim any module of this repository checks today. Used by
 * the "claims never bypass tenant scope" probe (ADR-0001 / organizations
 * doctrine): a principal holding ALL claims of tenant B must still be blind
 * to tenant A — authority authorizes operations, never tenant scope.
 */
export const OMNIPOTENT_AUTHORITY: string[] = [
  'organizations:provision',
  'identity:attest',
  'identity:link',
  'actions:administer',
  'actions:approve',
  'actions:approve:agent-execution',
  'actions:approve:extension-deployment',
  'actions:approve:notification-delivery',
  'actions:approve:llm-invocation',
  'actions:approve:employee-messaging',
  'agents:administer',
  'extensions:administer',
  'llm:administer',
  'notifications:administer',
];

/** A principal of `tenantId` holding every claim in the repository. */
export function omnipotent(tenantId: string): TenantContext {
  return memberWith(tenantId, [...OMNIPOTENT_AUTHORITY]);
}

// ---------------------------------------------------------------------------
// Error assertions
// ---------------------------------------------------------------------------

/**
 * Assert `fn` rejects with a typed module error whose `code` is exactly
 * `code`. All Aurum module errors are `Error` subclasses exposing a public
 * readonly string `code` — asserting on the code (not the message) keeps the
 * sweep stable across message rewording while still proving the rejection is
 * a deliberate domain error, never an unhandled driver crash.
 */
export async function expectErrorCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  let succeeded = false;
  try {
    await fn();
    succeeded = true;
  } catch (error) {
    caught = error;
  }
  expect(succeeded, `expected a typed error with code '${code}' but the call succeeded`).toBe(false);
  expect(caught, `expected an Error with code '${code}'`).toBeInstanceOf(Error);
  const typed = caught as { code?: unknown };
  expect(typed.code, `expected error code '${code}'`).toBe(code);
}

/**
 * The ADR-0001 no-existence-leak probe: a FOREIGN record id and a MISSING
 * record id must reject with the SAME code (a cross-tenant record is
 * indistinguishable from one that never existed).
 */
export async function expectUniformNotFound(
  code: string,
  foreign: () => Promise<unknown>,
  missing: () => Promise<unknown>,
): Promise<void> {
  await expectErrorCode(code, foreign);
  await expectErrorCode(code, missing);
}

// ---------------------------------------------------------------------------
// Repository-boundary helpers
// ---------------------------------------------------------------------------

/** Tables the arch allow-list (scripts/arch-allowlist.json) exempts. */
export async function platformAllowlistTables(): Promise<Set<string>> {
  const raw = JSON.parse(
    await readFile(path.join(REPO_ROOT, 'scripts', 'arch-allowlist.json'), 'utf8'),
  ) as { tables: string[] };
  return new Set<string>([...raw.tables.map((t) => t.toLowerCase()), '_migrations']);
}

interface TableColumnsRow extends DbRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/** All columns of every base table in `public` (migrated schema). */
export async function tableColumns(): Promise<TableColumnsRow[]> {
  const rows = await getDb().query<TableColumnsRow>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
  );
  return rows.rows;
}

/** Names of all base tables in `public` (the migrated schema). */
export async function baseTables(): Promise<string[]> {
  const rows = await getDb().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
  );
  return rows.rows.map((row) => row.table_name);
}

/** Module directories that exist under src/modules (the coverage universe). */
export async function existingModules(): Promise<string[]> {
  const entries = await readdir(path.join(REPO_ROOT, 'src', 'modules'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Does `relativePath` (relative to repo root) exist on disk? */
export function repoFileExists(relativePath: string): boolean {
  return existsSync(path.join(REPO_ROOT, relativePath));
}

// ---------------------------------------------------------------------------
// Row-partition integrity sweep
// ---------------------------------------------------------------------------

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * After a sweep file's fixtures ran, assert the storage partition itself is
 * intact: NO row in ANY tenant-scoped table may carry a tenant_id outside
 * `tenantIds` (or NULL). This catches ambient-tenant writes — a module that
 * persisted under a wrong/fabricated tenant id, or wrote NULL tenant rows —
 * which per-query filters would otherwise hide.
 *
 * Table names come from the system catalog, not user input, and are pinned
 * against `SAFE_IDENTIFIER` before interpolation (identifiers cannot be
 * parameterized in SQL; values always are).
 */
export async function assertTenantPartition(tenantIds: string[]): Promise<void> {
  expect(tenantIds.length).toBeGreaterThanOrEqual(2);
  const tables = (await baseTables()).filter((table) => SAFE_IDENTIFIER.test(table));
  const columns = await tableColumns();
  const tenantTables = tables.filter((table) =>
    columns.some((column) => column.table_name === table && column.column_name === 'tenant_id'),
  );
  expect(
    tenantTables.length,
    'expected the migrated schema to contain tenant-scoped tables',
  ).toBeGreaterThan(0);

  const placeholders = tenantIds.map((_, index) => `$${index + 1}`).join(', ');
  const offenders: string[] = [];
  for (const table of tenantTables) {
    const result = await getDb().query<{ bad: string }>(
      `SELECT count(*)::text AS bad FROM ${table} WHERE tenant_id IS NULL OR tenant_id NOT IN (${placeholders})`,
      tenantIds,
    );
    if (result.rows[0]?.bad !== '0') offenders.push(table);
  }
  expect(offenders, `rows with a tenant_id outside the sweep tenants in: ${offenders.join(', ')}`).toEqual(
    [],
  );
}

/** Row count of `table` (catalog-derived name; see assertTenantPartition). */
export async function rowCount(table: string): Promise<number> {
  if (!SAFE_IDENTIFIER.test(table)) throw new Error(`unsafe table name '${table}'`);
  const result = await getDb().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(result.rows[0]?.n ?? '0');
}

/** The single tenant_id a row was stored under (NULL becomes '<null>'). */
export async function storedTenantId(table: string, id: string): Promise<string> {
  if (!SAFE_IDENTIFIER.test(table)) throw new Error(`unsafe table name '${table}'`);
  const result = await getDb().query<{ tenant_id: string | null }>(
    `SELECT tenant_id FROM ${table} WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no ${table} row for id ${id}`);
  return row.tenant_id ?? '<null>';
}
