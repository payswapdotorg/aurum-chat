// W044 — Tenant Isolation Verification · repository-boundary sweep.
//
// GOVERNANCE.md: "tenant isolation is tested at repository and application
// boundaries". This file sweeps the REPOSITORY boundary: after applying every
// module migration to a fresh embedded PostgreSQL (`:memory:` PGlite), the
// schema itself must make multi-tenancy safe —
//
//   (1) every domain table is tenant-scoped (tenant_id present); the only
//       exempt tables are exactly the platform allow-list
//       (scripts/arch-allowlist.json) plus `_migrations`;
//   (2) every tenant_id column is a NOT NULL uuid — the partition key can
//       never be absent or ambiguous;
//   (3) unique constraints preserve per-tenant namespaces: a UNIQUE
//       constraint on a tenant table either includes tenant_id, or consists
//       solely of globally-unique surrogate uuid references (id/*_id) — a
//       natural-key UNIQUE without tenant_id would let tenant B's inserts
//       collide with tenant A's business identity (denial/overwrite);
//   (4) foreign keys cannot bridge tenants: an FK between tenant tables is
//       either tenant-consistent (tenant_id on BOTH sides, composite) or
//       references a globally-unique surrogate (`id`) — so no child row can
//       ever point at another tenant's parent.
//
// This complements scripts/check-architecture.ts rule (d) (which the arch
// gate already enforces) with type/nullability, namespace and referential
// depth, and — unlike the gate — fails the `bun run test` suite directly.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, type DbRow } from '@/infra/db';
import {
  baseTables,
  platformAllowlistTables,
  runMigrations,
  tableColumns,
} from './harness';

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 repository boundary — migrated schema tenant scoping', () => {
  it('scopes every domain table with a tenant_id column (platform allow-list only)', async () => {
    const [tables, columns, exempt] = await Promise.all([
      baseTables(),
      tableColumns(),
      platformAllowlistTables(),
    ]);
    expect(tables.length).toBeGreaterThan(0);

    const tenantOf = new Set(
      columns.filter((column) => column.column_name === 'tenant_id').map((column) => column.table_name),
    );
    const unscoped = tables.filter((table) => !tenantOf.has(table));
    const exemptMissing = [...exempt].filter((table) => !tables.includes(table));

    // Exactly the allow-listed platform/bookkeeping tables may lack tenant_id.
    expect(unscoped.sort()).toEqual([...exempt].sort());
    // ...and the allow-list must not drift into naming nonexistent tables.
    expect(exemptMissing).toEqual([]);
  });

  it('types every tenant_id column as a NOT NULL uuid partition key', async () => {
    const columns = (await tableColumns()).filter((column) => column.column_name === 'tenant_id');
    expect(columns.length).toBeGreaterThan(0);
    const bad = columns.filter(
      (column) => column.data_type !== 'uuid' || column.is_nullable !== 'NO',
    );
    expect(
      bad.map((column) => `${column.table_name} (${column.data_type}, nullable=${column.is_nullable})`),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unique namespaces
// ---------------------------------------------------------------------------

interface UniqueConstraintRow extends DbRow {
  conname: string;
  relname: string;
  columns: string;
  types: string;
}

/**
 * Unique constraints without tenant_id that are legitimate: technical
 * monotonic sequence numbers. `llm_executions.seq` /
 * `llm_availability_events.seq` are global serials whose values are minted
 * per ROW by the database (never caller-supplied natural keys), so two
 * tenants can never collide on them. They carry no cross-tenant business
 * meaning. Everything else must either include tenant_id or be a surrogate
 * uuid reference set.
 */
const TECHNICAL_UNIQUE_COLUMNS = new Set(['llm_executions.seq', 'llm_availability_events.seq']);

function isSurrogateUuidReference(column: string, type: string): boolean {
  return type === 'uuid' && (column === 'id' || column.endsWith('_id'));
}

describe('W044 repository boundary — unique namespaces stay per-tenant', () => {
  it('includes tenant_id (or only globally-unique surrogate uuids) in every UNIQUE constraint', async () => {
    const db = getDb();
    const constraints = await db.query<UniqueConstraintRow>(
      `SELECT con.conname, rel.relname,
              string_agg(a.attname, ',' ORDER BY x.ord) AS columns,
              string_agg(format_type(a.atttypid, a.atttypmod), ',' ORDER BY x.ord) AS types
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = x.attnum
        WHERE ns.nspname = 'public' AND con.contype = 'u'
        GROUP BY con.conname, rel.relname
        ORDER BY rel.relname, con.conname`,
    );
    expect(constraints.rows.length).toBeGreaterThan(0);

    const exempt = await platformAllowlistTables();
    const violations: string[] = [];
    for (const constraint of constraints.rows) {
      if (exempt.has(constraint.relname.toLowerCase())) continue; // platform tables
      const columns = constraint.columns.split(',');
      const types = constraint.types.split(',');
      if (columns.includes('tenant_id')) continue; // per-tenant namespace
      if (columns.every((column, index) => isSurrogateUuidReference(column, types[index] ?? ''))) {
        continue; // globally-unique surrogate references only
      }
      if (columns.every((column) => TECHNICAL_UNIQUE_COLUMNS.has(`${constraint.relname}.${column}`))) {
        continue; // documented technical monotonic sequences
      }
      violations.push(`${constraint.relname}.${constraint.conname} (${constraint.columns})`);
    }
    expect(violations, `unique constraints without a per-tenant namespace: ${violations.join('; ')}`).toEqual(
      [],
    );
  });

  it('includes tenant_id in every standalone UNIQUE index (including partial/expression indexes)', async () => {
    const db = getDb();
    const indexes = await db.query<{ indexname: string; tablename: string; indexdef: string }>(
      `SELECT i.indexname, i.tablename, i.indexdef
         FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname
         LEFT JOIN pg_constraint con ON con.conindid = c.oid
        WHERE i.schemaname = 'public' AND con.oid IS NULL AND i.indexdef LIKE 'CREATE UNIQUE%'
        ORDER BY i.tablename, i.indexname`,
    );
    expect(indexes.rows.length).toBeGreaterThan(0);

    const exempt = await platformAllowlistTables();
    const violations: string[] = [];
    for (const index of indexes.rows) {
      if (exempt.has(index.tablename.toLowerCase())) continue;
      // Column expression list sits between "USING <method> (" and the
      // closing paren before an optional WHERE clause. The greedy `.*`
      // correctly spans nested parens (e.g. COALESCE(install_key, '')).
      const match = /USING\s+\w+\s*\((.*)\)\s*(?:WHERE|$)/.exec(index.indexdef);
      if (match === null) {
        violations.push(`${index.tablename}.${index.indexname} (unparsable: ${index.indexdef})`);
        continue;
      }
      const expressions = match[1]!.split(',').map((part) => part.trim());
      // Expression indexes (e.g. COALESCE(...)) are only accepted when they
      // also partition by tenant_id explicitly.
      if (expressions.some((expression) => expression === 'tenant_id')) continue;
      if (expressions.every((expression) => /^"?[a-z_][a-z0-9_]*"?$/.test(expression))) {
        const columns = expressions.map((expression) => expression.replace(/"/g, ''));
        if (columns.every((column) => column === 'id' || column.endsWith('_id'))) continue;
      }
      violations.push(`${index.tablename}.${index.indexname} (${match[1]})`);
    }
    expect(violations, `unique indexes without a per-tenant namespace: ${violations.join('; ')}`).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Referential integrity across tenants
// ---------------------------------------------------------------------------

interface ForeignKeyRow extends DbRow {
  conname: string;
  src: string;
  dst: string;
  src_cols: string;
  dst_cols: string;
}

describe('W044 repository boundary — foreign keys cannot bridge tenants', () => {
  it('keeps FKs tenant-consistent or anchored on globally-unique surrogates', async () => {
    const db = getDb();
    const fks = await db.query<ForeignKeyRow>(
      `SELECT con.conname,
              src.relname AS src, dst.relname AS dst,
              (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS src_cols,
              (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS dst_cols
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_class dst ON dst.oid = con.confrelid
         JOIN pg_namespace ns ON ns.oid = src.relnamespace
        WHERE ns.nspname = 'public' AND con.contype = 'f'
        ORDER BY src.relname, con.conname`,
    );
    expect(fks.rows.length).toBeGreaterThan(0);

    const exempt = await platformAllowlistTables();
    const violations: string[] = [];
    for (const fk of fks.rows) {
      if (exempt.has(fk.src.toLowerCase()) || exempt.has(fk.dst.toLowerCase())) continue;
      const srcCols = fk.src_cols.split(',');
      const dstCols = fk.dst_cols.split(',');
      if (srcCols.includes('tenant_id')) {
        // Tenant-consistent composite: tenant_id must travel to the target too.
        if (!dstCols.includes('tenant_id')) {
          violations.push(`${fk.src}.${fk.conname}: tenant_id not matched on target ${fk.dst}`);
        }
        continue;
      }
      // No tenant_id in the source: only a single uuid surrogate reference to
      // the parent's globally-unique `id` is acceptable.
      const surrogateOk =
        srcCols.length === 1 && srcCols[0]!.endsWith('_id') && dstCols.length === 1 && dstCols[0] === 'id';
      if (!surrogateOk) {
        violations.push(`${fk.src}.${fk.conname} (${fk.src_cols}) -> ${fk.dst} (${fk.dst_cols})`);
      }
    }
    expect(violations, `foreign keys that could bridge tenants: ${violations.join('; ')}`).toEqual([]);
  });
});
