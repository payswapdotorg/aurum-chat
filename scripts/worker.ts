// The long-running cognition worker (W069 — the seam IMPLEMENTATION-STACK
// §2/§5 charters: "scripts/worker.ts process consuming infra/queue jobs";
// the plan §7 "Worker deployment requirement" that closed the repository
// gap). Dev/self-hosted/Profile B resident process; the serverless twin
// of the exact same core is the /api/worker HTTP seam.
//
// Usage:
//   bun run worker                  # continuous poll loop (default)
//   bun run worker --once           # drain ONE guarded batch, then exit
//   bun run worker --batch 25       # per-batch job limit (≤ guardrail)
//   bun run worker --interval 5000  # poll interval ms
//
// Startup contract (GOVERNACE-grade honesty, no prose over evidence):
//   * prints the resolved deployment profile (environment, backends,
//     guardrails, dogfood notice) — an operator sees exactly what the
//     process is wired to;
//   * production readiness is ENFORCED: any refusal note (embedded db in
//     production, missing WORKER_TOKEN) exits non-zero before a single
//     job runs — misconfigured production fails closed;
//   * SIGINT/SIGTERM drain gracefully: the current job finishes, the
//     queue and database connections close, exit 0.
//
// The worker itself owns NO domain semantics: one dequeued job = one
// bounded canonical stage advanced through the W013 contract, with
// idempotency/retry/dead-letter decisions in src/infra/worker.ts.
// PostgreSQL stays the only source of domain truth (lock 35/36).

import { closeDb } from '../src/infra/db';
import { closeQueue } from '../src/infra/queue';
import {
  assertProductionReadiness,
  describeDeployment,
  resolveDeploymentProfile,
} from '../src/infra/deployment';
import { runWorkerBatch, workerQueueDepth } from '../src/infra/worker';

interface WorkerArgs {
  once: boolean;
  batch: number | null;
  intervalMs: number | null;
}

function parseArgs(argv: string[]): WorkerArgs {
  const args: WorkerArgs = { once: false, batch: null, intervalMs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--once') {
      args.once = true;
    } else if (arg === '--batch') {
      const value = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) args.batch = value;
      i += 1;
    } else if (arg === '--interval') {
      const value = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(value) && value >= 100) args.intervalMs = value;
      i += 1;
    } else {
      console.error(`unknown flag: ${arg} (expected --once | --batch N | --interval Ms)`);
      process.exit(2);
    }
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stopping = false;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const profile = resolveDeploymentProfile();

  console.log('aurum worker — starting');
  for (const line of describeDeployment(profile)) console.log(`  ${line}`);

  const refusals = assertProductionReadiness(profile).filter((note) => note.level === 'refusal');
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`REFUSAL: ${refusal.message}`);
    process.exitCode = 1;
    return;
  }

  const batchLimit = args.batch ?? profile.guardrails.workerBatchLimit;
  const intervalMs = args.intervalMs ?? profile.guardrails.workerPollIntervalMs;

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`received ${signal} — draining after current job`);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (args.once) {
    const batch = await runWorkerBatch(batchLimit);
    console.log(
      `worker batch complete — processed ${batch.processed} job(s), queue depth ${batch.queueDepth}`,
    );
    return;
  }

  console.log(
    `polling queue 'cognition' every ${intervalMs}ms (batch ≤ ${batchLimit}) — Ctrl+C to stop`,
  );
  // The loop IS the process; Ctrl+C/SIGTERM flips `stopping`.
  while (!stopping) {
    const batch = await runWorkerBatch(batchLimit);
    if (batch.processed === 0) {
      await sleep(intervalMs);
    } else {
      // Work was available — drain immediately, then pace to let retries
      // scheduled by this batch interleave.
      await sleep(Math.min(intervalMs, 250));
    }
  }
  const depth = await workerQueueDepth();
  console.log(`worker stopped — remaining queue depth ${depth}`);
}

main()
  .catch((error: unknown) => {
    console.error('worker failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void (async () => {
      await closeQueue().catch(() => undefined);
      await closeDb().catch(() => undefined);
    })();
  });
