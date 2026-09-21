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
// The db check is `SELECT 1` plus a `_migrations` count: the second
// proves the migration runner has actually applied the schema to THIS
// database (a deployed function talking to an empty database is "live"
// but not ready).

import { now } from '@/infra/clock';
import { getDb } from '@/infra/db';
import { assertProductionReadiness, resolveDeploymentProfile } from '@/infra/deployment';
import { getWorkerMetrics } from '@/infra/worker';

interface HealthDbState {
  ok: boolean;
  migrations: number | null;
  error: string | null;
}

async function checkDb(): Promise<HealthDbState> {
  try {
    const db = getDb();
    await db.query('SELECT 1');
    try {
      const applied = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM _migrations`,
      );
      const migrations = Number.parseInt(applied.rows[0]?.count ?? '0', 10);
      return { ok: true, migrations: Number.isFinite(migrations) ? migrations : null, error: null };
    } catch {
      // Database answers but the schema is not applied — not ready.
      return {
        ok: false,
        migrations: null,
        error: '_migrations table missing — run the migration runner (bun run migrate)',
      };
    }
  } catch (error) {
    return {
      ok: false,
      migrations: null,
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
