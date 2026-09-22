// Public types of the deployment-smoke module (W078 — Post-Deployment
// Smoke and Operations Proof).
//
// This module is a VERIFICATION HARNESS in the W068-demo / W070-journey-
// proof sense: it owns no tables, exposes no HTTP surface, adds no
// authority vocabulary and no product behavior. What it owns is the
// typed proof material that turns the W078 acceptance list (spec/
// POST-W070-JOURNEY-UX-DEPLOYMENT-PLAN-2026-09-21.md §5, work item
// W078) into machine-checkable obligations executed against a HOSTED
// deployment over real HTTP:
//
//   * the CHECK CATALOG — every acceptance bullet mapped to concrete
//     checks with ids, categories and layers (hosted / journey / repo);
//   * the EXPECTATION MODEL — pure evaluators over the observed HTTP
//     evidence (health contract shape, worker-seam dispositions, chat
//     turn/thread state, session steps, routing gates);
//   * the DRIVER — one `runDeploymentSmoke()` pass over a target base
//     URL: liveness, routing, health/readiness, real authentication,
//     onboarding, chat, seeded demo journeys, durable-execution
//     duplicate/dead-letter/not-found semantics, queue/worker
//     observability, release/rollback and environment-separation checks;
//   * the REPORT — a structured verdict per check (pass | fail |
//     blocked | skipped) with evidence, a summary and markdown/JSON
//     serialization.
//
// VERDICT DISCIPLINE (the honesty rule of this module):
//   * PASS   — the deployed target demonstrably satisfies the check;
//   * FAIL   — the deployed target violates its own contract;
//   * BLOCKED — a documented external precondition is missing (e.g. the
//     W077 §11 operator steps: Neon DATABASE_URL / Upstash), so the
//     check cannot execute on this target today. Blocked is never used
//     to launder a contract violation: the target's own health endpoint
//     must be reporting the gap honestly for a check to be blocked.
//   * SKIPPED — the check does not apply to this target/profile.
//
// Everything here is PURE or transport-only (global fetch / node:fs
// reads in repo.ts): no react/next/db imports (IMPLEMENTATION-STACK §2).

// ---------------------------------------------------------------------------
// Verdicts, categories, layers
// ---------------------------------------------------------------------------

/** The verdict of one smoke check. */
export type SmokeCheckStatus = 'pass' | 'fail' | 'blocked' | 'skipped';

/**
 * The acceptance area a check proves. One per W078 acceptance bullet
 * family (plan §5 W078): routing/chat-root, health/readiness,
 * authentication/onboarding, seeded journeys, durable execution,
 * observability, release/rollback, environment separation.
 */
export type SmokeCategory =
  | 'routing'
  | 'health-readiness'
  | 'authentication-onboarding'
  | 'seeded-journeys'
  | 'durable-execution'
  | 'observability'
  | 'release-rollback'
  | 'environment-separation';

/**
 * Where a check executes:
 *   * hosted — any reachable deployment (no credentials beyond the
 *     optional worker token); proves the hosted surface itself;
 *   * journey — needs a database-backed ready target (authentication,
 *     onboarding, chat, seeded journeys, worker execution semantics);
 *   * repo — read-only verification of the repository's operations
 *     surface (rollback runbook, CI gates, deployment configuration).
 */
export type SmokeLayer = 'hosted' | 'journey' | 'repo';

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

/** One executed check: the catalog entry plus the observed verdict. */
export interface SmokeCheckResult {
  id: string;
  title: string;
  category: SmokeCategory;
  acceptance: string;
  layer: SmokeLayer;
  status: SmokeCheckStatus;
  /** Human-readable verdict detail (what was observed, precisely). */
  detail: string;
  /** Compact observed evidence (never secrets; bodies trimmed). */
  evidence?: Record<string, unknown>;
}

/** Roll-up of a run's results. */
export interface SmokeSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

/** The full smoke run report (self-contained: config + results). */
export interface SmokeReport {
  label: string;
  target: string;
  profile: SmokeProfile;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  expectedEnvironment: string | null;
  results: SmokeCheckResult[];
  summary: SmokeSummary;
  /** The health observation that gated the journey layer (null if unreachable). */
  health: HealthObservation | null;
}

// ---------------------------------------------------------------------------
// Run configuration
// ---------------------------------------------------------------------------

/** `hosted` runs the hosted+repo layers; `full` adds the journey layer. */
export type SmokeProfile = 'hosted' | 'full';

/**
 * How the demo quick-access surface is expected to answer on this target:
 * production runtimes must answer 404 not_available (NODE_ENV=production —
 * environment separation), development runtimes offer it.
 */
export type QuickSignInExpectation = 'off' | 'on' | 'unchecked';

export interface SmokeRunConfig {
  /** Base URL of the deployment under test (no trailing path). */
  target: string;
  /** `hosted` (liveness/routing/health/repo) or `full` (everything). */
  profile: SmokeProfile;
  /** The environment label the target must report (production/preview/…). */
  expectedEnvironment?: string;
  /**
   * The worker-seam token, when the target configures WORKER_TOKEN
   * (production always does; the preview artifact may). Null leaves the
   * seam unauthenticated — legal only outside production.
   */
  workerToken?: string | null;
  /** Expected availability of /api/auth/quick-sign-in on this target. */
  expectQuickSignIn?: QuickSignInExpectation;
  /** Repository root for the repo-layer checks (null disables them). */
  repoRoot?: string | null;
  /** A short run label for the report (default: the target host). */
  label?: string;
  /** Per-request HTTP timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Unique run id (default: derived from the start time). */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Observed HTTP shapes (defensive views over real response bodies)
// ---------------------------------------------------------------------------

/** The worker metrics registry, as surfaced by /api/health and /api/worker. */
export interface WorkerCounters {
  jobsEnqueued: number | null;
  jobsProcessed: number | null;
  jobsSuspended: number | null;
  jobsDuplicate: number | null;
  jobsConflict: number | null;
  jobsNotFound: number | null;
  jobsRetried: number | null;
  jobsDeadLettered: number | null;
  idlePolls: number | null;
  batches: number | null;
  lastActivityAt: string | null;
}

/** The deployment guardrails both observability surfaces expose. */
export interface GuardrailObservation {
  workerMaxAttempts: number | null;
  workerBatchLimit: number | null;
  workerPollIntervalMs: number | null;
}

/** The /api/health observation the driver starts from. */
export interface HealthObservation {
  httpStatus: number;
  status: 'ok' | 'degraded' | 'error' | 'unknown';
  environment: string | null;
  hostedOnVercel: boolean | null;
  dogfoodNotice: string | null;
  dbBackend: string | null;
  dbOk: boolean | null;
  migrations: number | null;
  dbError: string | null;
  queueBackend: string | null;
  cacheBackend: string | null;
  lockBackend: string | null;
  emailBackend: string | null;
  blobBackend: string | null;
  refusals: string[];
  warnings: string[];
  workerMetricsPresent: boolean;
  workerMetrics: WorkerCounters;
  guardrails: GuardrailObservation;
  cacheControl: string | null;
  /** Transport failure (unreachable/timeout) when the request could not be made. */
  fetchError: string | null;
}

/** The /api/worker GET observation (queue depth + metrics + guardrails). */
export interface WorkerSnapshotObservation {
  httpStatus: number;
  environment: string | null;
  queueDepth: number | null;
  metrics: WorkerCounters;
  guardrails: GuardrailObservation;
}

/** One pushed job's disposition from POST /api/worker (push mode). */
export interface WorkerPushObservation {
  httpStatus: number;
  mode: string | null;
  processed: number | null;
  outcomeStatuses: string[];
  outcomeDetails: string[];
  queueDepth: number | null;
}
