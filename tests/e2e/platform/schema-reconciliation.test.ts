// W102 — Production Schema Reconciliation (tests/e2e/platform/).
//
// The incident this suite pins: production Neon carried a COMPLETE
// _migrations ledger while missing 14 current-generation tables across
// provider-preferences, vertical-kits and edge-connector — vercel.json's
// buildCommand had run `bun run migrate` against the SHARED production
// DATABASE_URL from preview deployments of superseded parallel-lineage
// branches, whose DDL created DIFFERENT tables under the SAME migration
// FILE names; the name-keyed ledger then skipped the merged generation's
// files forever, and /ai/preferences served 500s while /api/health
// reported a green ledger count.
//
// The repair landed in two coordinated generations (never duplicated):
//   * PR #122 + #123 (merged) — 002-repair-migration-name-collision.sql
//     per module: rename the superseded generation's tables, indexes,
//     triggers and constraint-indexes to __orphaned_pre_w0XX names
//     (renames only, nothing dropped, all audited 0 rows in production),
//     then CREATE TABLE IF NOT EXISTS the current schema beside the
//     debris. Production is repaired and serving 200s.
//   * W102 (this work) — the systemic completion: 003-drop-orphaned-
//     debris.sql per module (drop the preserved empty debris so the
//     production census equals every fresh environment), the migrate.ts
//     post-migration verification pass (build-time drift guard) and the
//     /api/health table census (runtime drift guard).
//
// Proofs in this file:
//
//   1. THE DIVERGED STATE, FAITHFULLY SIMULATED: a database built in the
//      audited production shape — ledger entries for the three 001s
//      (the lie), the 12 orphan tables in their audited shapes,
//      including the constraint-index collisions PR #123 found (orphan
//      tables carrying CURRENT-generation pkey/unique index names) and
//      the regular index and trigger namesakes. The build-time drift
//      guard FAILS on this state — the ledger-lies class is caught
//      before any deploy serves a single request.
//   2. THE 42P07 COLLISION CLASS, PROVEN PRESENT: on the diverged
//      database, taking the colliding index names fails with "already
//      exists" — the exact error class that broke #122's first
//      production application, which earlier PGlite simulations had
//      missed and #123 fixed.
//   3. CONVERGENCE: running the migration runner — the same
//      `bun run migrate` every deploy runs — applies the three 002
//      repairs and the three 003 debris drops and converges the
//      database to the current schema: the 14 missing tables created,
//      the 4 same-name orphans replaced by their current shapes, every
//      colliding constraint/index/trigger name owned by the
//      current-generation table, the 12 debris tables dropped, census
//      exactly at the health expectation.
//   4. IDEMPOTENCE: a second runner pass applies nothing.
//   5. APPEND-ONLY enforcement holds on the repaired tables.
//   6. DRIFT GUARD (unit): extractCreatedTableNames survives IF NOT
//      EXISTS, public. prefixes, quoted identifiers, comments, string
//      literals and dollar-quoted function bodies; a fake schema
//      missing a table fails loudly, naming the table and the migration
//      that expects it.
//   7. DRIFT GUARD (integration): a converged database with a dropped
//      table fails verification loudly — the missing-table class, now
//      caught at build time instead of serving 500s at runtime.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb, type DbPort, type DbResult, type DbRow, type Queryable } from '@/infra/db';
import {
  discoverMigrations,
  extractCreatedTableNames,
  runMigrations,
  splitSqlStatements,
  verifyMigratedSchema,
} from '../../../scripts/migrate';

const { EXPECTED_TABLE_CENSUS } = await import('../../../src/app/api/health/lib');

// ---------------------------------------------------------------------------
// The verified production state (W101 deployment-integrity audit + direct
// Postgres inspection, 2026-09-26) this suite reconstructs.
// ---------------------------------------------------------------------------

/** The 14 current-generation tables production was MISSING. */
const MISSING_IN_PRODUCTION = [
  'provider_preference_settings',
  'provider_personal_preferences',
  'provider_technical_overrides',
  'provider_selection_explanations',
  'vertical_kit_versions',
  'vertical_kit_installations',
  'vertical_kit_invocations',
  'vertical_kit_verifications',
  'vertical_kit_edge_actions',
  'edge_runtimes',
  'edge_events',
  'edge_heartbeats',
  'edge_auth_nonces',
  'edge_capability_allowlist',
];

/**
 * The 4 same-name tables the superseded lineage DID create — in ORPHAN
 * shapes (the W101 audit's column signatures, mirrored by the 002 repair
 * guards): these are what the 002 shape-collision renames act on.
 */
const SAME_NAME_ORPHANS = [
  'provider_preference_events',
  'vertical_kit_events',
  'vertical_kit_grants',
  'edge_jobs',
] as const;

/** The 8 unambiguous debris tables of the superseded generation. */
const DEBRIS_TABLES = [
  'provider_preference_profiles',
  'provider_preference_mappings',
  'vertical_kit_installs',
  'vertical_kit_recipe_references',
  'edge_registrations',
  'edge_allowlist_events',
  'edge_health_events',
  'edge_job_events',
];

/** All 12 orphans, as the 002 repairs rename them (the 003 drops them). */
const ORPHANED_RENAMES: Readonly<Record<string, string>> = {
  provider_preference_events: 'provider_preference_events__orphaned_pre_w091',
  provider_preference_profiles: 'provider_preference_profiles__orphaned_pre_w091',
  provider_preference_mappings: 'provider_preference_mappings__orphaned_pre_w091',
  vertical_kit_events: 'vertical_kit_events__orphaned_pre_w092',
  vertical_kit_grants: 'vertical_kit_grants__orphaned_pre_w092',
  vertical_kit_installs: 'vertical_kit_installs__orphaned_pre_w092',
  vertical_kit_recipe_references: 'vertical_kit_recipe_references__orphaned_pre_w092',
  edge_jobs: 'edge_jobs__orphaned_pre_w088',
  edge_registrations: 'edge_registrations__orphaned_pre_w088',
  edge_allowlist_events: 'edge_allowlist_events__orphaned_pre_w088',
  edge_health_events: 'edge_health_events__orphaned_pre_w088',
  edge_job_events: 'edge_job_events__orphaned_pre_w088',
};

const LEDGER_PRETEND_APPLIED = [
  'provider-preferences/001-provider-preferences.sql',
  'vertical-kits/001-vertical-kits.sql',
  'edge-connector/001-edge-connector.sql',
];

const REPAIR_MIGRATIONS = [
  'provider-preferences/002-repair-migration-name-collision.sql',
  'vertical-kits/002-repair-migration-name-collision.sql',
  'edge-connector/002-repair-migration-name-collision.sql',
  'provider-preferences/003-drop-orphaned-debris.sql',
  'vertical-kits/003-drop-orphaned-debris.sql',
  'edge-connector/003-drop-orphaned-debris.sql',
];

/**
 * The superseded generation's audited shapes. Faithfulness notes:
 *   * provider_preference_events and edge_jobs carry PRIMARY KEYs and
 *     named UNIQUE constraints whose index names are CURRENT-generation
 *     names — the 42P07 collision class PR #123 found and fixed
 *     (PostgreSQL keeps constraint index names through a table rename).
 *   * vertical_kit_events and vertical_kit_grants carry NO primary keys
 *     and no current-generation constraint names — the audited reason
 *     the vertical-kits module needed no #123 fix.
 *   * the regular index (provider_preference_events_tenant_idx) and the
 *     append-only trigger names mirror what the 002 renames act on.
 */
const ORPHAN_DDL = `
CREATE FUNCTION __w102_orphan_reject_mutation() RETURNS trigger AS $orphan_fn$
BEGIN
  RAISE EXCEPTION 'orphan generation table is frozen';
END
$orphan_fn$ LANGUAGE plpgsql;

-- W091 · provider-preferences: the events SHAPE collision (summary /
-- preference / actor) + the #123 constraint-index collision class.
CREATE TABLE provider_preference_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  preference jsonb NOT NULL,
  summary text NOT NULL,
  actor text NOT NULL,
  CONSTRAINT provider_preference_events_id_tenant_unique UNIQUE (id, tenant_id)
);
CREATE INDEX provider_preference_events_tenant_idx ON provider_preference_events (tenant_id);
CREATE TRIGGER provider_preference_events_immutable
  BEFORE UPDATE OR DELETE ON provider_preference_events
  FOR EACH ROW EXECUTE FUNCTION __w102_orphan_reject_mutation();
CREATE TRIGGER provider_preference_events_immutable_truncate
  BEFORE TRUNCATE ON provider_preference_events
  FOR EACH STATEMENT EXECUTE FUNCTION __w102_orphan_reject_mutation();

-- W091 · unambiguous debris.
CREATE TABLE provider_preference_profiles (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, profile jsonb NOT NULL);
CREATE TABLE provider_preference_mappings (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, profile_id uuid NOT NULL, slot text NOT NULL);

-- W092 · vertical-kits: the events SHAPE collision (kit_key /
-- event_type / from_version) — no PK, no colliding constraint names.
CREATE TABLE vertical_kit_events (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  kit_key text NOT NULL,
  event_type text NOT NULL,
  from_version text
);
CREATE TRIGGER vertical_kit_events_immutable
  BEFORE UPDATE OR DELETE ON vertical_kit_events
  FOR EACH ROW EXECUTE FUNCTION __w102_orphan_reject_mutation();
CREATE TRIGGER vertical_kit_events_immutable_truncate
  BEFORE TRUNCATE ON vertical_kit_events
  FOR EACH STATEMENT EXECUTE FUNCTION __w102_orphan_reject_mutation();

-- W092 · the grants SHAPE collision (install_id / extension_key) — no
-- PK, no colliding constraint names.
CREATE TABLE vertical_kit_grants (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  install_id uuid NOT NULL,
  extension_key text NOT NULL
);
CREATE TRIGGER vertical_kit_grants_immutable
  BEFORE UPDATE OR DELETE ON vertical_kit_grants
  FOR EACH ROW EXECUTE FUNCTION __w102_orphan_reject_mutation();

-- W092 · unambiguous debris.
CREATE TABLE vertical_kit_installs (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, kit_key text NOT NULL);
CREATE TABLE vertical_kit_recipe_references (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, install_id uuid NOT NULL, recipe text NOT NULL);

-- W088 · edge-connector: the jobs SHAPE collision (envelope /
-- system_class / edge_key) + the #123 constraint-index collision class.
CREATE TABLE edge_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  envelope jsonb NOT NULL,
  system_class text NOT NULL,
  edge_key text NOT NULL,
  CONSTRAINT edge_jobs_id_tenant_unique UNIQUE (id, tenant_id)
);

-- W088 · unambiguous debris.
CREATE TABLE edge_registrations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL);
CREATE TABLE edge_allowlist_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, registration_id uuid NOT NULL);
CREATE TABLE edge_health_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, registration_id uuid NOT NULL);
CREATE TABLE edge_job_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, registration_id uuid NOT NULL);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function publicTables(): Promise<Set<string>> {
  const db = getDb();
  const rows = (
    await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )
  ).rows;
  return new Set(rows.map((row) => row.table_name.toLowerCase()));
}

/** The table owning the named index (null when the index is absent). */
async function indexOwner(indexName: string): Promise<string | null> {
  const db = getDb();
  const rows = (
    await db.query<{ table_name: string }>(
      `SELECT tbl.relname AS table_name
         FROM pg_class idx
         JOIN pg_index ix ON ix.indexrelid = idx.oid
         JOIN pg_class tbl ON tbl.oid = ix.indrelid
        WHERE idx.relname = $1`,
      [indexName],
    )
  ).rows;
  return rows[0]?.table_name ?? null;
}

/** The table hosting the named trigger (null when the trigger is absent). */
async function triggerHost(triggerName: string): Promise<string | null> {
  const db = getDb();
  const rows = (
    await db.query<{ table_name: string }>(
      `SELECT tbl.relname AS table_name
         FROM pg_trigger trg
         JOIN pg_class tbl ON tbl.oid = trg.tgrelid
        WHERE trg.tgname = $1 AND NOT trg.tgisinternal`,
      [triggerName],
    )
  ).rows;
  return rows[0]?.table_name ?? null;
}

async function tableHasColumn(table: string, column: string): Promise<boolean> {
  const db = getDb();
  const rows = (
    await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS present`,
      [table, column],
    )
  ).rows;
  return rows[0]?.present === true;
}

// ---------------------------------------------------------------------------
// Seed the diverged production state (the repair deploy happens in the
// convergence describe's beforeAll, AFTER the pre-state proofs).
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const db = getDb();
  // 1. The ledger exactly as production had it: the three 001s recorded
  //    (by the superseded preview deployments) at the verified
  //    timestamp — so the runner skips them by name, forever.
  await db.query(`CREATE TABLE _migrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of LEDGER_PRETEND_APPLIED) {
    await db.query(
      `INSERT INTO _migrations (name, applied_at) VALUES ($1, '2026-09-26T02:21:43Z'::timestamptz)`,
      [name],
    );
  }
  // 2. The superseded generation's tables, indexes and triggers in their
  //    audited shapes.
  for (const statement of splitSqlStatements(ORPHAN_DDL)) {
    await db.query(statement);
  }
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// 1. The diverged state, faithfully simulated (pre-repair proofs)
// ---------------------------------------------------------------------------

describe('W102 — the diverged production state, faithfully simulated', () => {
  it('carries a COMPLETE ledger for the three 001s — the lie the incident rode on', async () => {
    const ledger = (
      await getDb().query<{ name: string }>(`SELECT name FROM _migrations`)
    ).rows.map((row) => row.name);
    for (const name of LEDGER_PRETEND_APPLIED) {
      expect(ledger).toContain(name);
    }
    expect(ledger).toHaveLength(3);
  });

  it('is missing the 14 current-generation tables', async () => {
    const tables = await publicTables();
    for (const table of MISSING_IN_PRODUCTION) {
      expect(tables.has(table)).toBe(false);
    }
  });

  it('carries the 12 orphan tables in their audited shapes', async () => {
    const tables = await publicTables();
    for (const table of [...SAME_NAME_ORPHANS, ...DEBRIS_TABLES]) {
      expect(tables.has(table)).toBe(true);
    }
    // The audited shape signatures the 002 repair guards key on.
    expect(await tableHasColumn('provider_preference_events', 'summary')).toBe(true);
    expect(await tableHasColumn('provider_preference_events', 'position')).toBe(false);
    expect(await tableHasColumn('vertical_kit_events', 'kit_key')).toBe(true);
    expect(await tableHasColumn('vertical_kit_events', 'position')).toBe(false);
    expect(await tableHasColumn('vertical_kit_grants', 'install_id')).toBe(true);
    expect(await tableHasColumn('vertical_kit_grants', 'installation_id')).toBe(false);
    expect(await tableHasColumn('edge_jobs', 'envelope')).toBe(true);
    expect(await tableHasColumn('edge_jobs', 'payload')).toBe(false);
  });

  it('holds the #123 collision class — current-generation constraint index names on orphan tables', async () => {
    // At this point the named tables ARE the orphans (proven by the
    // shape signatures above): their pkey/unique constraint indexes own
    // the CURRENT-generation names — exactly what made #122's first
    // production application fail with 42P07 and what #123's guarded
    // renames free up.
    expect(await indexOwner('edge_jobs_pkey')).toBe('edge_jobs');
    expect(await indexOwner('edge_jobs_id_tenant_unique')).toBe('edge_jobs');
    expect(await indexOwner('provider_preference_events_pkey')).toBe('provider_preference_events');
    expect(await indexOwner('provider_preference_events_id_tenant_unique')).toBe(
      'provider_preference_events',
    );
  });

  it('reproduces the 42P07 failure — taking those names fails with "already exists"', async () => {
    // The direct proof that the simulation covers the class #123 found:
    // a CREATE TABLE edge_jobs (id uuid PRIMARY KEY …) — the repair's
    // move — would need these index names; they are taken.
    const db = getDb();
    await expect(
      db.query(`CREATE INDEX edge_jobs_pkey ON edge_jobs (id)`),
    ).rejects.toThrow(/already exists/);
    await expect(
      db.query(`CREATE INDEX provider_preference_events_pkey ON provider_preference_events (id)`),
    ).rejects.toThrow(/already exists/);
  });

  it('holds the regular index and trigger namesakes on the orphan tables', async () => {
    expect(await indexOwner('provider_preference_events_tenant_idx')).toBe(
      'provider_preference_events',
    );
    expect(await triggerHost('provider_preference_events_immutable')).toBe(
      'provider_preference_events',
    );
    expect(await triggerHost('provider_preference_events_immutable_truncate')).toBe(
      'provider_preference_events',
    );
    expect(await triggerHost('vertical_kit_events_immutable')).toBe('vertical_kit_events');
    expect(await triggerHost('vertical_kit_grants_immutable')).toBe('vertical_kit_grants');
  });

  it('is caught by the drift guard — the ledger-lies class fails loudly at build time', async () => {
    // The W102 incident state itself: ledger complete, schema absent.
    // The verification pass must refuse to vouch for this database,
    // naming the missing tables and the migrations that expect them.
    await expect(verifyMigratedSchema(getDb())).rejects.toThrow(
      // The missing list is sorted alphabetically: edge < provider < vertical.
      new RegExp(
        [
          'schema verification FAILED',
          'edge_runtimes \\(expected by edge-connector/001-edge-connector\\.sql\\)',
          'provider_preference_settings \\(expected by provider-preferences/001-provider-preferences\\.sql\\)',
          'vertical_kit_versions \\(expected by vertical-kits/001-vertical-kits\\.sql\\)',
        ].join('[\\s\\S]*'),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The repair deploy converges the diverged database
// ---------------------------------------------------------------------------

describe('W102 — the repair deploy converges the diverged database', () => {
  let repair: Awaited<ReturnType<typeof runMigrations>>;

  beforeAll(async () => {
    // The same `bun run migrate` every deploy runs: the ledger already
    // holds the three 001 names, so the runner skips them — exactly the
    // production deploy flow — and applies everything else, including
    // both repair generations.
    repair = await runMigrations(getDb());
  });

  it('skipped exactly the three name-recorded 001s — the production deploy flow', async () => {
    // Module order (dependency-topological) decides the sequence; the
    // SET of skipped migrations is exactly the three name-recorded 001s.
    expect(repair.skipped).toHaveLength(3);
    expect([...repair.skipped].sort()).toEqual([...LEDGER_PRETEND_APPLIED].sort());
  });

  it('applied the three 002 repairs and the three 003 debris drops', async () => {
    for (const name of REPAIR_MIGRATIONS) {
      expect(repair.applied).toContain(name);
    }
    // Everything else in the repo applied too (the other modules' real
    // migrations): 130 files total — 133 discovered minus the 3 skips.
    expect(repair.applied).toHaveLength(130);
  });

  it('the discovered migration set carries both repair generations', async () => {
    const names = (await discoverMigrations()).map((migration) => migration.name);
    for (const name of REPAIR_MIGRATIONS) {
      expect(names).toContain(name);
    }
    expect(names).toHaveLength(133);
  });

  it('created the 14 tables production was missing', async () => {
    const tables = await publicTables();
    for (const table of MISSING_IN_PRODUCTION) {
      expect(tables.has(table)).toBe(true);
    }
  });

  it('replaced the 4 same-name orphans with their current-generation shapes', async () => {
    const tables = await publicTables();
    for (const table of SAME_NAME_ORPHANS) {
      expect(tables.has(table)).toBe(true);
    }
    // The current-generation shape signatures (the 002 repair guards'
    // "other side"): the columns the orphans carried are gone, the
    // current generation's columns are present.
    expect(await tableHasColumn('provider_preference_events', 'position')).toBe(true);
    expect(await tableHasColumn('provider_preference_events', 'summary')).toBe(false);
    expect(await tableHasColumn('vertical_kit_events', 'position')).toBe(true);
    expect(await tableHasColumn('vertical_kit_events', 'kit_key')).toBe(false);
    expect(await tableHasColumn('vertical_kit_grants', 'installation_id')).toBe(true);
    expect(await tableHasColumn('vertical_kit_grants', 'install_id')).toBe(false);
    expect(await tableHasColumn('edge_jobs', 'payload')).toBe(true);
    expect(await tableHasColumn('edge_jobs', 'envelope')).toBe(false);
  });

  it('re-homed every colliding constraint and index name onto the current tables', async () => {
    expect(await indexOwner('edge_jobs_pkey')).toBe('edge_jobs');
    expect(await indexOwner('edge_jobs_id_tenant_unique')).toBe('edge_jobs');
    expect(await indexOwner('provider_preference_events_pkey')).toBe('provider_preference_events');
    expect(await indexOwner('provider_preference_events_id_tenant_unique')).toBe(
      'provider_preference_events',
    );
    expect(await indexOwner('provider_preference_events_tenant_idx')).toBe(
      'provider_preference_events',
    );
  });

  it('moved the append-only triggers onto the current-generation tables', async () => {
    expect(await triggerHost('provider_preference_events_immutable')).toBe(
      'provider_preference_events',
    );
    expect(await triggerHost('provider_preference_events_immutable_truncate')).toBe(
      'provider_preference_events',
    );
    expect(await triggerHost('vertical_kit_events_immutable')).toBe('vertical_kit_events');
    // The grants ledger trigger name RETIRES with the orphan: the
    // current generation keeps grants as live workflow state (only the
    // events/invocations/verifications ledgers are append-only), so no
    // current-generation trigger takes the name back.
    expect(await triggerHost('vertical_kit_grants_immutable')).toBe(null);
  });

  it('dropped the 12 orphaned debris tables — production census equals fresh', async () => {
    const tables = await publicTables();
    for (const renamed of Object.values(ORPHANED_RENAMES)) {
      expect(tables.has(renamed)).toBe(false);
    }
    // No orphan-named object survives anywhere: the renamed constraint
    // indexes and triggers died with their tables.
    const db = getDb();
    const strayIndex = (
      await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_indexes WHERE indexname LIKE '%orphaned%'`,
      )
    ).rows[0]?.count;
    expect(strayIndex).toBe('0');
    const strayTrigger = (
      await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_trigger
          WHERE tgname LIKE '%orphaned%' AND NOT tgisinternal`,
      )
    ).rows[0]?.count;
    expect(strayTrigger).toBe('0');
  });

  it('passes the build-time drift guard with the full expectation', async () => {
    const verification = await verifyMigratedSchema(getDb());
    expect(verification.missingTables).toEqual([]);
    expect(verification.expectedTables).toEqual(expect.arrayContaining(MISSING_IN_PRODUCTION));
    expect(verification.expectedTables).toHaveLength(EXPECTED_TABLE_CENSUS - 1);
  });

  it('the table census equals the health endpoint expectation', async () => {
    const tables = await publicTables();
    expect(tables.size).toBe(EXPECTED_TABLE_CENSUS);
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotence
// ---------------------------------------------------------------------------

describe('W102 — the reconciliation is idempotent', () => {
  it('a second runner pass applies nothing and the schema still verifies', async () => {
    const report = await runMigrations(getDb());
    expect(report.applied).toEqual([]);
    expect(report.skipped).toHaveLength(133);
    const verification = await verifyMigratedSchema(getDb());
    expect(verification.missingTables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The append-only guarantees hold on the repaired tables
// ---------------------------------------------------------------------------

describe('W102 — append-only ledgers are enforced after the repair', () => {
  it('provider-preferences: inserts pass, mutations are rejected', async () => {
    const db = getDb();
    const tenant = '11111111-1111-4111-8111-111111111111';
    await db.query(
      `INSERT INTO provider_selection_explanations
         (tenant_id, gateway, capability, decision, preference_source, candidates_considered,
          explanation, dedupe_key, recorded_by, recorded_at)
       VALUES ($1, 'openrouter', 'chat.standard', 'preference', 'default', 1,
          'cheapest available option matched the priority', 'w102-1', 'w102-test', now())`,
      [tenant],
    );
    await db.query(
      `INSERT INTO provider_preference_events
         (tenant_id, position, event, detail, recorded_by, recorded_at)
       VALUES ($1, 1, 'tenant-preference-set', 'repaired ledger', 'w102-test', now())`,
      [tenant],
    );
    await expect(
      db.query(`UPDATE provider_selection_explanations SET explanation = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE provider_preference_events SET detail = 'tampered'`),
    ).rejects.toThrow(/append-only/);
  });

  it('vertical-kits: inserts pass, mutations are rejected', async () => {
    const db = getDb();
    await db.query(
      `INSERT INTO vertical_kit_invocations
         (tenant_id, installation_id, capability_key, outcome, basis, denial_reason,
          task_context, invoked_by, invoked_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'read.crm', 'denied', 'grant-missing',
          'no active grant', '{}'::jsonb, 'w102-test', now())`,
    );
    await expect(
      db.query(`UPDATE vertical_kit_invocations SET outcome = 'allowed'`),
    ).rejects.toThrow(/append-only/);
  });

  it('edge-connector: inserts pass, mutations are rejected', async () => {
    const db = getDb();
    await db.query(
      `INSERT INTO edge_heartbeats
         (tenant_id, edge_id, position, reported_version, reported_capabilities,
          reported_pending_jobs, received_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), 1, '1.2.3', '[]'::jsonb, 0, now())`,
    );
    await expect(db.query(`UPDATE edge_heartbeats SET position = 2`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// 5. The drift guard (unit — a fake schema; integration below)
// ---------------------------------------------------------------------------

/** A DbPort stub whose information_schema answers with a fixed table set. */
class FakeSchemaDb implements DbPort {
  constructor(private readonly tables: string[]) {}

  async query<T extends DbRow>(sql: string): Promise<DbResult<T>> {
    if (sql.includes('information_schema.tables')) {
      const rows = this.tables.map((name) => ({ table_name: name })) as unknown as T[];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`FakeSchemaDb: unexpected query: ${sql}`);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const FIXTURE_MODULES_DIR = fileURLToPath(new URL('../fixtures/schema-drift', import.meta.url));

describe('W102 — the migrate.ts verification pass (unit)', () => {
  it('extractCreatedTableNames parses the DDL variants and ignores prose', () => {
    expect(extractCreatedTableNames('CREATE TABLE plain_one (id int);')).toEqual(['plain_one']);
    expect(extractCreatedTableNames('create table if not exists Guarded_Two (id int);')).toEqual([
      'guarded_two',
    ]);
    expect(extractCreatedTableNames('CREATE TABLE public."Quoted_Three" (id int);')).toEqual([
      'quoted_three',
    ]);
    // Comment prose mentioning tables must never count as DDL.
    expect(
      extractCreatedTableNames(`-- the drift_alpha table is documented here
/* create table drift_beta (id int); inside a block comment */
CREATE TABLE drift_alpha (id int);`),
    ).toEqual(['drift_alpha']);
    // String literals and dollar-quoted function bodies are not DDL.
    expect(
      extractCreatedTableNames(`CREATE TABLE real_one (id int);
DO $$ BEGIN EXECUTE 'CREATE TABLE fake_two (id int)'; END $$;
SELECT 'create table fake_three (id int)' AS memo;`),
    ).toEqual(['real_one']);
    // Duplicate declarations collapse to one name.
    expect(
      extractCreatedTableNames('CREATE TABLE dup_one (id int);\nCREATE TABLE IF NOT EXISTS dup_one (id int);'),
    ).toEqual(['dup_one']);
  });

  it('a fake schema missing a table FAILS the check, naming the table and its migration', async () => {
    await expect(
      verifyMigratedSchema(new FakeSchemaDb(['drift_alpha']), FIXTURE_MODULES_DIR),
    ).rejects.toThrow(
      /schema verification FAILED[\s\S]*drift_beta \(expected by drift-fixture\/001-fixture-tables\.sql\)/,
    );
  });

  it('a complete fake schema passes and reports the census', async () => {
    const verification = await verifyMigratedSchema(
      new FakeSchemaDb(['drift_alpha', 'drift_beta']),
      FIXTURE_MODULES_DIR,
    );
    expect(verification.missingTables).toEqual([]);
    expect(verification.expectedTables).toEqual(['drift_alpha', 'drift_beta']);
    expect(verification.tableCensus).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. The drift guard (integration — the missing-table class)
// ---------------------------------------------------------------------------

describe('W102 — the drift guard catches the production failure mode', () => {
  // LAST in this file: dropping a table leaves the shared database
  // diverged — nothing after this test may rely on schema health.
  it('a converged database with a dropped table fails verification loudly', async () => {
    const db = getDb();
    await db.query(`DROP TABLE edge_auth_nonces`);
    await expect(verifyMigratedSchema(db)).rejects.toThrow(
      /schema verification FAILED[\s\S]*edge_auth_nonces \(expected by edge-connector\/001-edge-connector\.sql\)/,
    );
  });
});
