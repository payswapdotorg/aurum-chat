// Deployment profile: environment separation + usage guardrails (W069).
//
// Provider-neutral, side-effect free environment resolution shared by the
// worker seam (scripts/worker.ts + /api/worker), the health/readiness
// route (/api/health) and CI. It answers exactly three questions:
//
//   1. WHICH ENVIRONMENT are we in (development | preview | staging |
//      production)? Resolution order: an explicit DEPLOYMENT_ENV always
//      wins (validated — an unknown value is a hard misconfiguration,
//      never silently folded into another environment); then VERCEL_ENV
//      (production/preview on the Vercel platform); then NODE_ENV.
//      Vercel has no native staging environment: staging is a dedicated
//      branch/project that sets DEPLOYMENT_ENV=staging (docs/DEPLOYMENT.md).
//   2. WHICH BACKEND is each infrastructure port on? The ports themselves
//      (db/queue/cache/lock) and the W069 adapters (email/blob) pick their
//      backend from the environment once; this module only LABELS the
//      resulting combination so operators and health checks see one
//      consistent picture.
//   3. WHICH GUARDRAILS apply? The free-tier dogfood profile (plan §7)
//      runs on scoped free plans, so the deployment itself enforces the
//      usage budget: worker retry/batch caps, a transactional-email daily
//      limit (Resend Free), an object-size cap (Vercel Blob Hobby) and a
//      connection-pool cap sized for Neon Free. Defaults are the free-tier
//      budgets; every cap is env-overridable within hard clamps so
//      Profile B (commercial) can raise them without code changes.
//
// The non-commercial dogfood notice: while the web surface runs on Vercel
// Hobby (plan §7 Profile A), the deployment is internal/non-commercial
// dogfood. AURUM_COMMERCIAL=1 marks the commercial profile (paid host +
// raised budgets); the flag is surfaced by health and worker banners.
//
// RULES (implementation-stack §3/§4, plan §7):
//   * PostgreSQL is domain truth — production MUST run on the external
//     postgres backend (DATABASE_URL). The embedded PGlite backend is a
//     dev/test runtime; `assertProductionReadiness` refuses it loudly.
//   * Redis is never domain truth — a missing redis seam (REDIS_URL, or
//     W077's UPSTASH_REDIS_REST_URL/TOKEN / KV_REST_API_URL/TOKEN) degrades
//     queue/cache/lock to the in-process memory backend (legal, lock 35)
//     and is reported as a warning, never a refusal.
//   * Nothing here throws at import time (config discipline); the one
//     throwing surface is `resolveDeploymentProfile`, and only for a
//     malformed explicit DEPLOYMENT_ENV.

import { envFlag, envString, getAurumDb, getDatabaseUrl, getRedisRestConfig, getRedisUrl } from './config';

/** The four separated deployment environments (plan §7 deployment pipeline). */
export type DeploymentEnvironment = 'development' | 'preview' | 'staging' | 'production';

/** Which backend each infrastructure port resolved to. */
export interface DeploymentBackends {
  db: 'embedded' | 'postgres';
  queue: 'memory' | 'redis';
  cache: 'memory' | 'redis';
  lock: 'memory' | 'redis';
  email: 'memory' | 'resend';
  blob: 'memory' | 'vercel-blob';
}

/** Free-tier usage budgets (env-overridable within hard clamps). */
export interface DeploymentGuardrails {
  /** Max delivery attempts per cognition job before dead-lettering. */
  workerMaxAttempts: number;
  /** Max jobs one worker batch/invocation processes. */
  workerBatchLimit: number;
  /** Worker poll interval in milliseconds (continuous mode). */
  workerPollIntervalMs: number;
  /** Max transactional emails per UTC day (0 = unlimited). */
  emailDailyLimit: number;
  /** Max object size accepted by the blob port, in bytes. */
  blobMaxBytes: number;
  /** Max node-postgres pool connections (Neon Free budget). */
  dbPoolMax: number;
}

/** The resolved deployment profile (pure data — safe to expose via /api/health). */
export interface DeploymentProfile {
  environment: DeploymentEnvironment;
  /** True when running on the Vercel platform (VERCEL_ENV present). */
  hostedOnVercel: boolean;
  /** True when AURUM_COMMERCIAL=1 (plan §7 Profile B — paid host). */
  commercial: boolean;
  /** Internal/non-commercial dogfood while the Hobby tier is used (plan §7). */
  dogfood: boolean;
  backends: DeploymentBackends;
  guardrails: DeploymentGuardrails;
}

/** A production-readiness problem (refusal) or warning (degradation). */
export interface DeploymentNote {
  level: 'refusal' | 'warning';
  message: string;
}

const DEPLOYMENT_ENVIRONMENTS: readonly DeploymentEnvironment[] = [
  'development',
  'preview',
  'staging',
  'production',
];

function isDeploymentEnvironment(value: string): value is DeploymentEnvironment {
  return (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value);
}

function resolveEnvironment(): DeploymentEnvironment {
  const explicit = envString('DEPLOYMENT_ENV')?.toLowerCase();
  if (explicit !== undefined) {
    if (!isDeploymentEnvironment(explicit)) {
      throw new Error(
        `DEPLOYMENT_ENV must be one of ${DEPLOYMENT_ENVIRONMENTS.join('|')} (got '${explicit}')`,
      );
    }
    return explicit;
  }
  const vercel = envString('VERCEL_ENV')?.toLowerCase();
  if (vercel === 'production' || vercel === 'preview') return vercel;
  return envString('NODE_ENV') === 'production' ? 'production' : 'development';
}

/** Positive integer env knob clamped into [min, max]; `fallback` when unset/invalid. */
function clampedInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = envString(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function resolveGuardrails(): DeploymentGuardrails {
  return {
    // 5 attempts (1 original + 4 retries) covers transient provider blips
    // without hammering a free-tier backend.
    workerMaxAttempts: clampedInt('AURUM_WORKER_MAX_ATTEMPTS', 5, 1, 50),
    workerBatchLimit: clampedInt('AURUM_WORKER_BATCH_LIMIT', 10, 1, 100),
    workerPollIntervalMs: clampedInt('AURUM_WORKER_POLL_INTERVAL_MS', 2000, 100, 600_000),
    // Resend Free: 100/day (3 000/month). 0 explicitly disables the cap.
    emailDailyLimit: clampedInt('AURUM_EMAIL_DAILY_LIMIT', 100, 0, 10_000),
    // Vercel Blob Hobby total budget is 1 GB — cap each object at 8 MiB so a
    // single upload cannot crowd out the store.
    blobMaxBytes: clampedInt('AURUM_BLOB_MAX_BYTES', 8 * 1024 * 1024, 1, 512 * 1024 * 1024),
    // Neon Free allows few dozen connections; leave headroom for previews.
    dbPoolMax: clampedInt('AURUM_DB_POOL_MAX', 5, 1, 20),
  };
}

function resolveBackends(): DeploymentBackends {
  const db: DeploymentBackends['db'] =
    (getAurumDb() ?? (getDatabaseUrl() !== undefined ? 'postgres' : 'embedded')) === 'postgres'
      ? 'postgres'
      : 'embedded';
  const redis = getRedisUrl() !== undefined || getRedisRestConfig() !== undefined;
  return {
    db,
    queue: redis ? 'redis' : 'memory',
    cache: redis ? 'redis' : 'memory',
    lock: redis ? 'redis' : 'memory',
    email: envString('RESEND_API_KEY') !== undefined ? 'resend' : 'memory',
    blob: envString('BLOB_READ_WRITE_TOKEN') !== undefined ? 'vercel-blob' : 'memory',
  };
}

/**
 * Resolve the deployment profile from the current environment. Throws only
 * for a malformed explicit DEPLOYMENT_ENV (a misconfiguration must never be
 * silently re-labeled).
 */
export function resolveDeploymentProfile(): DeploymentProfile {
  const environment = resolveEnvironment();
  const hostedOnVercel = envString('VERCEL_ENV') !== undefined;
  const commercial = envFlag('AURUM_COMMERCIAL');
  return {
    environment,
    hostedOnVercel,
    commercial,
    // Plan §7: "The deployment must be treated as internal/non-commercial
    // dogfood while Vercel Hobby is used" — anything not opted into the
    // commercial profile is dogfood.
    dogfood: !commercial,
    backends: resolveBackends(),
    guardrails: resolveGuardrails(),
  };
}

/**
 * Production readiness: hard refusals (configuration that must never serve
 * the production environment) and warnings (legal degradations an operator
 * should still see). Refusals are enforced by the worker startup and the
 * HTTP worker seam; /api/health reports both.
 */
export function assertProductionReadiness(profile: DeploymentProfile): DeploymentNote[] {
  const notes: DeploymentNote[] = [];
  if (profile.environment !== 'production') return notes;

  if (profile.backends.db !== 'postgres') {
    notes.push({
      level: 'refusal',
      message:
        'production requires the external PostgreSQL backend (DATABASE_URL) — the embedded PGlite runtime is dev/test only (lock 35: PostgreSQL is authoritative domain state)',
    });
  }
  if (envString('WORKER_TOKEN') === undefined) {
    notes.push({
      level: 'refusal',
      message:
        'production requires WORKER_TOKEN — the HTTP worker seam must not accept unauthenticated job processing',
    });
  }
  if (profile.backends.queue !== 'redis') {
    notes.push({
      level: 'warning',
      message:
        'no redis seam is configured (REDIS_URL for the redis protocol, or UPSTASH_REDIS_REST_URL/TOKEN / KV_REST_API_URL/TOKEN for redis-over-HTTP) — queue/cache/lock run on the in-process memory backend; queue jobs cannot survive restarts or span instances (legal while Redis is never domain truth, but not durable)',
    });
  }
  if (profile.backends.email !== 'resend') {
    notes.push({
      level: 'warning',
      message:
        'RESEND_API_KEY is not set — transactional email stays on the memory backend (nothing is delivered)',
    });
  }
  if (profile.backends.blob !== 'vercel-blob') {
    notes.push({
      level: 'warning',
      message:
        'BLOB_READ_WRITE_TOKEN is not set — object storage stays on the memory backend (objects do not survive the process)',
    });
  }
  return notes;
}

/** Operator-facing startup banner lines for the profile (no secrets). */
export function describeDeployment(profile: DeploymentProfile): string[] {
  const b = profile.backends;
  const lines = [
    `environment: ${profile.environment}${profile.hostedOnVercel ? ' (vercel)' : ''}`,
    `profile: ${profile.commercial ? 'commercial (B)' : 'free-tier dogfood (A)'}`,
    profile.dogfood
      ? 'notice: internal/non-commercial dogfood while the Hobby tier is used (plan §7)'
      : 'notice: commercial deployment profile',
    `db: ${b.db} · queue: ${b.queue} · cache: ${b.cache} · lock: ${b.lock}`,
    `email: ${b.email} · blob: ${b.blob}`,
    `guardrails: worker attempts≤${profile.guardrails.workerMaxAttempts} batch≤${profile.guardrails.workerBatchLimit} poll=${profile.guardrails.workerPollIntervalMs}ms · email/day≤${profile.guardrails.emailDailyLimit} · blob/object≤${profile.guardrails.blobMaxBytes}B · pool≤${profile.guardrails.dbPoolMax}`,
  ];
  for (const note of assertProductionReadiness(profile)) {
    lines.push(`${note.level === 'refusal' ? 'REFUSAL' : 'WARNING'}: ${note.message}`);
  }
  return lines;
}
