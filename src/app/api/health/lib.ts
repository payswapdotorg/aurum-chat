// The health/readiness endpoint's handling logic (W069). Tested directly
// without booting Next.js; route.ts is a thin NextResponse adapter.
//
// Unauthenticated by design (readiness probes must not depend on
// sessions) and safe because it exposes ONLY deployment shape: component
// backend labels, guardrail numbers, db liveness and the applied
// migration count. No tenant data, no secrets, no domain content.
//
//   status 'ok'       200 — db answers, no production-readiness refusals.
//   status 'degraded' 200 — db answers, but production-readiness notes
//                          exist (e.g. missing REDIS_URL warning) — the
//                          app serves, the operator should look.
//   status 'error'    503 — the domain-truth database does not answer,
//                          or the schema is not applied (not ready).
//
// The db check is `SELECT 1`, the `_migrations` count, and — since W102
// — a TABLE CENSUS: the `_migrations` ledger proves only that migration
// NAMES were recorded, never that their content produced the schema (the
// W102 incident: preview deployments of superseded parallel-lineage
// branches ran different DDL under the same migration filenames against
// the shared production database; the ledger stayed complete while the
// surfaces served 500s). The census counts public BASE TABLEs and checks
// a small representative set, so a diverged database reports NOT READY
// instead of a green-but-broken `ok`.

import { now } from '@/infra/clock';
import { getDb } from '@/infra/db';
import { assertProductionReadiness, resolveDeploymentProfile } from '@/infra/deployment';
import { getWorkerMetrics } from '@/infra/worker';

/**
 * The number of public BASE TABLEs a fully-migrated database must carry:
 * every distinct table created by the module migration files (the
 * migrate.ts verification pass guards the same expectation at build
 * time) plus the `_migrations` ledger itself. A stale value fails the
 * health suite, which re-migrates a fresh embedded database and asserts
 * the census — extend it whenever a migration adds a table.
 */
export const EXPECTED_TABLE_CENSUS = 256;

/**
 * A small representative set spanning the incident's modules and the
 * core product/auth path — belt-and-braces under the census: even a
 * census that adds up must hold these specific tables.
 */
export const REPRESENTATIVE_TABLES = [
  'provider_preference_settings', // W091 — the /ai/preferences surface
  'vertical_kit_versions', // W092 — vertical extension kits
  'edge_runtimes', // W088 — the edge connector
  'conversations', // the core product loop
  'auth_users', // the auth path
] as const;

interface HealthDbTables {
  census: number;
  expected: number;
  missing: string[];
}

interface HealthDbState {
  ok: boolean;
  migrations: number | null;
  tables: HealthDbTables | null;
  error: string | null;
}

async function checkDb(): Promise<HealthDbState> {
  try {
    const db = getDb();
    await db.query('SELECT 1');
    let migrations: number | null = null;
    try {
      const applied = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM _migrations`,
      );
      const parsed = Number.parseInt(applied.rows[0]?.count ?? '0', 10);
      migrations = Number.isFinite(parsed) ? parsed : null;
    } catch {
      // Database answers but the schema is not applied — not ready.
      return {
        ok: false,
        migrations: null,
        tables: null,
        error: '_migrations table missing — run the migration runner (bun run migrate)',
      };
    }
    // W102 table census: one cheap information_schema read carries both
    // the count and the representative presence check.
    const present = new Set(
      (
        await db.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        )
      ).rows.map((row) => row.table_name.toLowerCase()),
    );
    const missing = REPRESENTATIVE_TABLES.filter((table) => !present.has(table));
    const census = present.size;
    if (census !== EXPECTED_TABLE_CENSUS || missing.length > 0) {
      const problems: string[] = [];
      if (census !== EXPECTED_TABLE_CENSUS) {
        problems.push(`table census ${census} differs from the expected ${EXPECTED_TABLE_CENSUS}`);
      }
      if (missing.length > 0) problems.push(`missing core tables: ${missing.join(', ')}`);
      return {
        ok: false,
        migrations,
        tables: { census, expected: EXPECTED_TABLE_CENSUS, missing: [...missing] },
        error:
          `schema drift — ${problems.join('; ')}; the _migrations ledger is complete ` +
          `but the schema is not (run the migration runner; see W102)`,
      };
    }
    return {
      ok: true,
      migrations,
      tables: { census, expected: EXPECTED_TABLE_CENSUS, missing: [] },
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      migrations: null,
      tables: null,
      error: error instanceof Error ? error.message.slice(0, 200) : 'database unreachable',
    };
  }
}

export interface HealthResult {
  status: number;
  body: Record<string, unknown>;
}

/** GET /api/health — readiness + deployment shape (no tenant data). */
export async function handleHealthGet(): Promise<HealthResult> {
  const profile = resolveDeploymentProfile();
  const db = await checkDb();
  const notes = assertProductionReadiness(profile);
  const refusals = notes.filter((note) => note.level === 'refusal');
  const warnings = notes.filter((note) => note.level === 'warning');

  const status = !db.ok ? 'error' : notes.length > 0 ? 'degraded' : 'ok';
  const httpStatus = status === 'error' ? 503 : 200;

  return {
    status: httpStatus,
    body: {
      status,
      checkedAt: now().toISOString(),
      environment: {
        environment: profile.environment,
        hostedOnVercel: profile.hostedOnVercel,
        commercial: profile.commercial,
        dogfoodNotice: profile.dogfood
          ? 'internal/non-commercial dogfood while the free tier is used (plan §7)'
          : null,
      },
      components: {
        db: { backend: profile.backends.db, ...db },
        queue: { backend: profile.backends.queue },
        cache: { backend: profile.backends.cache },
        lock: { backend: profile.backends.lock },
        email: { backend: profile.backends.email },
        blob: { backend: profile.backends.blob },
      },
      guardrails: profile.guardrails,
      readiness: {
        refusals: refusals.map((note) => note.message),
        warnings: warnings.map((note) => note.message),
      },
      worker: getWorkerMetrics(),
      processUptimeSeconds: Math.round(process.uptime()),
    },
  };
}
