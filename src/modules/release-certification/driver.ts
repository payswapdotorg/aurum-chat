// W079 — the certification driver: ONE full pass over the production
// deployment (Run A or Run B), composing the W076 browser layer and the
// W078 smoke driver exactly as the canonical contract mandates.
//
// THE PASS (spec/PRODUCTION-JOURNEY-CERTIFICATION-2026-09-23.md):
//   G1 — read-only infrastructure verification over public HTTP: the
//        health contract, quick-sign-in OFF, the worker seam's fail-closed
//        auth + token observability, and the deployment identity (the
//        read-only Vercel deployments listing — identifiers only, never
//        secrets). The A-lane is CLOSED; this driver VERIFIES, never
//        provisions.
//   G2 — the repository gates (typecheck/test/arch/lint), recorded with
//        command + exit code + summary line.
//   G3 — the W078 hosted smoke rerun (full profile, embedded as the
//        §8 operations proof) and the J01–J15 browser matrix over real
//        Chromium against the hosted production URL (a Playwright
//        subprocess; the browser suite lives in tests/browser/production
//        and reuses the W076 layer).
//
// The evidence is written by the SAME execution that produces the
// verdict (contract §9): run-result.json, deployment-identity.json,
// command-manifest.json, run-report.md, the browser digest, and the
// W078 reports land under the run directory; the browser fixture writes
// transcripts/screenshots/error captures beside them.
//
// SECRETS: the worker token and the Vercel API token arrive as FILE
// PATHS, are read once, live in memory only, and never enter any
// artifact. The browser matrix authenticates through the real
// production sign-up flow only (G3: no quick-login, no API/token
// bypass, no seeded demo tenant).

import { execFile } from 'node:child_process';
import type { ExecException } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runDeploymentSmoke } from '@/modules/deployment-smoke/contract';
import type { SmokeReport } from '@/modules/deployment-smoke/contract';
import { deploymentFromListing, deploymentIdentity, identityVerificationReasons, observeG1Health } from './identity';
import { JOURNEY_MATRIX, matrixConsistency } from './matrix';
import {
  commandManifestToJson,
  identityManifestToJson,
  runReportToMarkdown,
  runResultToJson,
} from './report';
import type {
  BrowserRunDigest,
  CertificationCheck,
  CertificationRunResult,
  G1HealthObservation,
  JourneyResult,
  RunSummary,
} from './types';
import {
  G2_REPO_GATES,
  gateOneReasons,
  gateThreeReasons,
  journeyResultsFromDigest,
  quickSignInOffReasons,
  runVerdict,
  summarizeRun,
  w078RerunReasons,
  workerAuthorizationReasons,
} from './verdict';

/** One certification pass configuration. */
export interface CertificationRunConfig {
  /** The production target (https://aurum-chat-livid.vercel.app). */
  target: string;
  /** 'A' or 'B' — the two-run rule's label. */
  runLabel: 'A' | 'B';
  /** The expected deployment identity (operator-declared, verified read-only). */
  expectedDeployment: {
    deploymentId: string;
    commitSha: string;
    /** ISO date (or its date prefix) the deployment was created. */
    createdAt: string;
  };
  /**
   * The worker seam token's file path (the production secret — read once,
   * held in memory, never written to any artifact).
   */
  workerTokenFile: string | null;
  /**
   * The Vercel API token's file path (read-only deployment identity
   * verification — never written to any artifact).
   */
  vercelTokenFile: string | null;
  /** Repository root (repo gates + evidence paths). */
  repoRoot: string;
  /** Where the evidence tree lands (absolute or repo-root-relative). */
  evidenceRoot: string;
  /** The exact command line (contract §3.9). */
  command: string;
  /** Skip the browser matrix (used by the dev harness ONLY — never certification). */
  skipBrowser?: boolean;
  /** Skip the repo gates (G2 runs in the finalizer instead). */
  skipRepoGates?: boolean;
  /** Injectable fetch for the integration tests. */
  fetchImpl?: typeof fetch;
  /** Injectable child-process runner for the integration tests. */
  execImpl?: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Read a secret from its file (trimmed; null when absent/empty). */
async function readSecret(file: string | null): Promise<string | null> {
  if (file === null) return null;
  try {
    const raw = await readFile(file, 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/** Run one repo gate, returning the command + exit code + summary tail. */
async function runRepoGate(
  gate: { command: string; label: string },
  repoRoot: string,
  execImpl: NonNullable<CertificationRunConfig['execImpl']>,
): Promise<{ command: string; exitCode: number | null; summary: string }> {
  try {
    const result = await execImpl('bun', gate.command.replace(/^bun run /, '').split(' '), {
      cwd: repoRoot,
      env: { ...process.env, CI: '1' },
    });
    const tail = (result.stdout + result.stderr).trim().split(/\r?\n/).slice(-3).join(' ⏎ ');
    return { command: gate.command, exitCode: result.code, summary: tail.slice(0, 400) };
  } catch (error) {
    return {
      command: gate.command,
      exitCode: null,
      summary: `the gate could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
    };
  }
}

/** Fetch the current production deployment entry (read-only, identifiers only). */
async function fetchDeploymentListing(
  config: CertificationRunConfig,
  vercelToken: string | null,
): Promise<{ deploymentId: string | null; readyState: string | null; createdAt: string | null; commitSha: string | null } | null> {
  if (vercelToken === null) return null;
  const url =
    'https://api.vercel.com/v6/deployments?projectId=prj_PljFx5DnZ1MCqQ5bA1uK6G1o8gFy' +
    '&teamId=team_4KOoA5CgtYaOF85yFXPeMXLt&target=production&limit=1';
  const response = await (config.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${vercelToken}` },
  });
  if (response.status !== 200) return null;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null || !Array.isArray(body['deployments']) || body['deployments'].length === 0) {
    return null;
  }
  return deploymentFromListing(body['deployments'][0]);
}

/** The G1 probes (pure observations over public HTTP, read-only). */
async function probeG1(
  config: CertificationRunConfig,
  workerToken: string | null,
): Promise<{
  health: G1HealthObservation;
  checks: CertificationCheck[];
  workerObservation: {
    seamTokenGated: boolean | null;
    snapshotReachable: boolean | null;
    environment: string | null;
    queueDepth: number | null;
  };
}> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const record = (id: string, title: string, status: CertificationCheck['status'], detail: string, evidence?: Record<string, unknown>) => {
    checks.push({ id, title, status, detail, evidence });
  };
  const checks: CertificationCheck[] = [];

  // The health contract (G1 core).
  const healthResponse = await fetchImpl(`${config.target}/api/health`, {
    headers: { 'cache-control': 'no-cache' },
  });
  const healthBody = await healthResponse.json().catch(() => null);
  const health = observeG1Health(healthResponse.status, healthBody);
  const healthReasons = gateOneReasons(health);
  record(
    'g1.health',
    'the production runtime is genuinely production (health contract)',
    healthReasons.length === 0 ? 'pass' : 'fail',
    healthReasons.length === 0
      ? `/api/health status ok · environment production · db ${health.dbBackend} (${health.dbMigrations} migrations) · queue/cache/lock ${health.queueBackend} · ${health.refusals.length} refusals · ${health.warnings.length} warnings`
      : healthReasons.join('; '),
    {
      httpStatus: health.httpStatus,
      healthStatus: health.healthStatus,
      environment: health.environment,
      backends: {
        db: health.dbBackend,
        queue: health.queueBackend,
        cache: health.cacheBackend,
        lock: health.lockBackend,
        email: health.emailBackend,
        blob: health.blobBackend,
      },
    },
  );

  // Quick-sign-in/demo credentials OFF (G1).
  const quickSignInResponse = await fetchImpl(`${config.target}/api/auth/quick-sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona: 'manager' }),
  });
  const quickSignInBody = await quickSignInResponse.text();
  const quickSignInReasonsList = quickSignInOffReasons(quickSignInResponse.status, quickSignInBody);
  record(
    'g1.quick-sign-in-off',
    'production quick-sign-in/demo credentials remain OFF',
    quickSignInReasonsList.length === 0 ? 'pass' : 'fail',
    quickSignInReasonsList.length === 0
      ? `POST /api/auth/quick-sign-in answered ${quickSignInResponse.status} — the quick-access panel is off in the production runtime`
      : quickSignInReasonsList.join('; '),
    { status: quickSignInResponse.status },
  );

  // The worker seam's fail-closed auth + valid-token observability (G1).
  const noToken = await fetchImpl(`${config.target}/api/worker`);
  const badToken = await fetchImpl(`${config.target}/api/worker`, {
    headers: { 'x-worker-token': 'definitely-not-the-token' },
  });
  let validStatus = -1;
  let workerEnvironment: string | null = null;
  let queueDepth: number | null = null;
  let metricsPresent = false;
  if (workerToken !== null) {
    const valid = await fetchImpl(`${config.target}/api/worker`, {
      headers: { 'x-worker-token': workerToken },
    });
    validStatus = valid.status;
    const validBody = (await valid.json().catch(() => null)) as Record<string, unknown> | null;
    if (validBody !== null) {
      workerEnvironment = typeof validBody['environment'] === 'string' ? validBody['environment'] : null;
      queueDepth = typeof validBody['queueDepth'] === 'number' ? validBody['queueDepth'] : null;
      metricsPresent =
        typeof validBody['metrics'] === 'object' && validBody['metrics'] !== null;
    }
  }
  const seamTokenGated = noToken.status === 401;
  const workerReasons = workerAuthorizationReasons({
    noTokenStatus: noToken.status,
    badTokenStatus: badToken.status,
    validStatus: workerToken === null ? -1 : validStatus,
    environment: workerEnvironment,
    metrics: metricsPresent,
  });
  const workerBlocked = workerToken === null;
  record(
    'g1.worker-authorization',
    'WORKER_TOKEN exists and worker authorization works',
    workerBlocked ? 'blocked' : workerReasons.length === 0 ? 'pass' : 'fail',
    workerBlocked
      ? 'the worker seam token was not supplied (provide --worker-token-file) — the production observability probes cannot run'
      : workerReasons.length === 0
        ? `the seam is fail-closed (401 no/bad token) and the valid token reads the snapshot (environment ${workerEnvironment}, queue depth ${queueDepth})`
        : workerReasons.join('; '),
    {
      noTokenStatus: noToken.status,
      badTokenStatus: badToken.status,
      validStatus: workerToken === null ? null : validStatus,
      snapshotEnvironment: workerEnvironment,
    },
  );

  return {
    health,
    checks,
    workerObservation: {
      seamTokenGated,
      snapshotReachable: workerToken !== null && validStatus === 200,
      environment: workerEnvironment,
      queueDepth,
    },
  };
}

/** Run the W078 hosted smoke rerun (full profile, production target). */
async function runW078(
  config: CertificationRunConfig,
  workerToken: string | null,
  runDir: string,
): Promise<SmokeReport | null> {
  try {
    const report = await runDeploymentSmoke({
      target: config.target,
      profile: 'full',
      expectedEnvironment: 'production',
      workerToken,
      expectQuickSignIn: 'off',
      repoRoot: null,
      label: `production-certification-run-${config.runLabel.toLowerCase()}`,
      fetchImpl: config.fetchImpl,
    });
    const w078Dir = path.join(runDir, 'w078');
    await mkdir(w078Dir, { recursive: true });
    await writeFile(
      path.join(w078Dir, 'smoke-report.json'),
      `${JSON.stringify(
        {
          label: report.label,
          target: report.target,
          profile: report.profile,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          expectedEnvironment: report.expectedEnvironment,
          summary: report.summary,
          results: report.results,
          health: report.health,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return report;
  } catch (error) {
    return {
      label: 'w078-rerun-failed',
      target: config.target,
      profile: 'full',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      expectedEnvironment: 'production',
      results: [
        {
          id: 'w078.rerun',
          title: 'the W078 hosted smoke rerun',
          category: 'hosted',
          layer: 'hosted',
          acceptance: 'operations proof',
          status: 'fail',
          detail: `the smoke driver threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
          evidence: undefined,
        },
      ],
      summary: { total: 1, passed: 0, failed: 1, blocked: 0, skipped: 0 },
      health: null,
    } as unknown as SmokeReport;
  }
}

/** Run the J01–J15 browser matrix (the Playwright subprocess). */
async function runBrowserMatrix(
  config: CertificationRunConfig,
  runDir: string,
  secretsScratchDir: string,
): Promise<{ digest: BrowserRunDigest | null; error: string | null }> {
  const execImpl = config.execImpl ?? defaultExec;

  const digestPath = path.join(runDir, 'browser-run-digest.json');
  const env: Record<string, string> = {
    ...process.env,
    W079_BASE_URL: config.target,
    W079_RUN_DIR: runDir,
    W079_RUN_LABEL: config.runLabel,
    W079_SECRETS_DIR: secretsScratchDir,
    W079_PLAYWRIGHT_JSON: path.join(runDir, 'playwright-results.json'),
    CI: '1',
  };
  try {
    // The config (playwright.certification.config.ts) owns the reporters:
    // the list reporter for the console and the JSON reporter writing the
    // full Playwright results to the run directory (W079_PLAYWRIGHT_JSON).
    const result = await execImpl(
      'node',
      ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.certification.config.ts'],
      { cwd: config.repoRoot, env },
    );
    // The digest is assembled by the suite's global teardown (fixture-side
    // aggregation); read it back after the run.
    const digestRaw = await readFile(digestPath, 'utf8').catch(() => null);
    if (digestRaw === null) {
      return {
        digest: null,
        error: `the browser matrix did not write its digest (playwright exit ${result.code}; tail: ${(result.stdout + result.stderr).slice(-500)})`,
      };
    }
    return { digest: JSON.parse(digestRaw) as BrowserRunDigest, error: null };
  } catch (error) {
    return {
      digest: null,
      error: `the browser matrix could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    };
  }
}

/** One full certification pass. */
export async function runCertificationPass(
  config: CertificationRunConfig,
): Promise<CertificationRunResult> {
  const startedAt = new Date().toISOString();
  const runDir = path.resolve(
    config.repoRoot,
    config.evidenceRoot,
    `production-run-${config.runLabel.toLowerCase()}`,
  );
  await mkdir(runDir, { recursive: true });
  // The run directory is THIS run's evidence: wipe any prior content so
  // recycled evidence is structurally impossible (the W076 discipline).
  for (const entry of ['browser-run-digest.json', 'deployment-identity.json', 'command-manifest.json', 'run-report.md', 'run-result.json']) {
    await rm(path.join(runDir, entry), { force: true });
  }
  const secretsScratchDir = path.join(runDir, '.scratch-secrets');
  await rm(secretsScratchDir, { recursive: true, force: true });

  const workerToken = await readSecret(config.workerTokenFile);
  const vercelToken = await readSecret(config.vercelTokenFile);
  const gates: CertificationCheck[] = [];

  // The matrix itself must be consistent before anything runs.
  const matrixReasons = matrixConsistency();
  gates.push({
    id: 'matrix.consistency',
    title: 'the J01–J15 matrix is the contract matrix',
    status: matrixReasons.length === 0 ? 'pass' : 'fail',
    detail:
      matrixReasons.length === 0
        ? `all ${JOURNEY_MATRIX.length} journeys declared with their mandatory proofs`
        : matrixReasons.join('; '),
  });

  // G1 — the read-only infrastructure probes.
  const g1 = await probeG1(config, workerToken);
  gates.push(...g1.checks);

  // The deployment identity (read-only listing + verification).
  const listing = await fetchDeploymentListing(config, vercelToken);
  const identityReasons =
    listing === null
      ? ['the read-only deployment listing could not be fetched (provide --vercel-token-file) — the deployment identity cannot be verified']
      : identityVerificationReasons(config.expectedDeployment, listing);
  gates.push({
    id: 'g1.deployment-identity',
    title: 'the target is the expected production deployment (identity manifest)',
    status: identityReasons.length === 0 ? 'pass' : 'blocked',
    detail:
      identityReasons.length === 0
        ? `the live production deployment is ${config.expectedDeployment.deploymentId} @ ${config.expectedDeployment.commitSha} (READY, created ${listing?.createdAt})`
        : identityReasons.join('; '),
    evidence: {
      expectedDeploymentId: config.expectedDeployment.deploymentId,
      expectedCommitSha: config.expectedDeployment.commitSha,
      observedDeploymentId: listing?.deploymentId ?? null,
      observedReadyState: listing?.readyState ?? null,
      observedCommitSha: listing?.commitSha ?? null,
      observedCreatedAt: listing?.createdAt ?? null,
    },
  });

  // G2 — the repository gates.
  const repoGates: { command: string; exitCode: number | null; summary: string }[] = config.skipRepoGates
    ? G2_REPO_GATES.map((gate) => ({ command: gate.command, exitCode: null, summary: 'deferred to the finalizer (--skip-repo-gates)' }))
    : [];
  if (!config.skipRepoGates) {
    for (const gate of G2_REPO_GATES) {
      repoGates.push(await runRepoGate(gate, config.repoRoot, config.execImpl ?? defaultExec));
    }
  }

  // G3a — the W078 hosted smoke rerun.
  const w078 = await runW078(config, workerToken, runDir);
  const w078Reasons = w078 === null ? ['the W078 rerun did not run'] : w078RerunReasons(w078.summary);
  const w078HasFailures = w078 !== null && w078.summary.failed > 0;
  gates.push({
    id: 'g3.w078-rerun',
    title: 'the W078 hosted smoke rerun is green with zero blocked',
    // A FAIL in the smoke is a deployment defect; a BLOCKED check is an
    // external precondition gap (contract §2 — never laundered either way).
    status: w078Reasons.length === 0 ? 'pass' : w078 === null ? 'blocked' : w078HasFailures ? 'fail' : 'blocked',
    detail:
      w078Reasons.length === 0 && w078 !== null
        ? `${w078.summary.passed} passed · ${w078.summary.failed} failed · ${w078.summary.blocked} blocked · ${w078.summary.skipped} skipped (the seeded demo checks are inapplicable on production — the demo gate keeps the production runtime demo-free by design)`
        : w078Reasons.join('; '),
    evidence: w078 === null ? undefined : { summary: w078.summary },
  });

  // G3b — the browser matrix.
  let journeys: JourneyResult[];
  if (config.skipBrowser === true) {
    journeys = JOURNEY_MATRIX.map((spec) => ({
      journeyId: spec.id,
      status: 'blocked' as const,
      contexts: spec.contexts.map((context) => ({
        context,
        status: 'blocked' as const,
        detail: 'the browser matrix was skipped (development harness mode — never certification)',
      })),
      testIds: [],
      transcripts: [],
      screenshots: [],
      errorCaptures: [],
      detail: 'the browser matrix did not run',
    }));
    gates.push({
      id: 'g3.browser-matrix',
      title: 'the J01–J15 browser matrix runs against the hosted production URL',
      status: 'blocked',
      detail: 'the browser matrix was skipped — this is a development harness pass, not certification evidence',
    });
  } else {
    const browser = await runBrowserMatrix(config, runDir, secretsScratchDir);
    const gate3Reasons =
      browser.digest === null
        ? [browser.error ?? 'the browser matrix produced no digest']
        : gateThreeReasons(browser.digest);
    gates.push({
      id: 'g3.browser-matrix',
      title: 'the J01–J15 browser matrix runs against the hosted production URL (desktop + mobile)',
      status: gate3Reasons.length === 0 ? 'pass' : 'fail',
      detail:
        gate3Reasons.length === 0 && browser.digest !== null
          ? `${browser.digest.passed}/${browser.digest.total} browser tests green across ${browser.digest.tests.length} journey-context pairs — real production auth, zero-violation record attached`
          : gate3Reasons.join('; ').slice(0, 500),
    });
    journeys = browser.digest === null ? [] : journeyResultsFromDigest(browser.digest);
  }

  // The summary + verdict for this run.
  const summary: RunSummary = summarizeRun(journeys, gates);
  const verdict = runVerdict(summary);
  const finishedAt = new Date().toISOString();

  const identity = deploymentIdentity({
    hostname: new URL(config.target).host,
    deploymentId: config.expectedDeployment.deploymentId,
    commitSha: config.expectedDeployment.commitSha,
    deploymentCreatedAt: config.expectedDeployment.createdAt,
    certificationStartedAt: startedAt,
    health: g1.health,
    worker: g1.workerObservation,
    command: config.command,
    git: {
      remote: 'https://github.com/payswapdotorg/aurum-chat.git',
      branch: 'work/w079-production-certification',
      baseCommit: 'c0ea5f78f8979d46029ac6124eff2bf0ebd6d988',
      headCommit: await currentCommit(config.repoRoot),
    },
  });

  const run: CertificationRunResult = {
    runLabel: config.runLabel,
    startedAt,
    finishedAt,
    target: config.target,
    identity,
    gates,
    repoGates,
    w078:
      w078 === null
        ? null
        : {
            label: w078.label,
            summary: w078.summary,
            reportPath: path.relative(config.repoRoot, path.join(runDir, 'w078', 'smoke-report.json')),
          },
    journeys,
    summary,
    verdict,
    command: config.command,
    evidenceDir: path.relative(config.repoRoot, runDir),
  };

  // The evidence tree (contract §9) — written by THIS execution.
  await writeFile(path.join(runDir, 'run-result.json'), runResultToJson(run), 'utf8');
  await writeFile(path.join(runDir, 'deployment-identity.json'), identityManifestToJson(run), 'utf8');
  await writeFile(path.join(runDir, 'command-manifest.json'), commandManifestToJson(run), 'utf8');
  await writeFile(path.join(runDir, 'run-report.md'), runReportToMarkdown(run), 'utf8');
  await rm(secretsScratchDir, { recursive: true, force: true });
  return run;
}

/** The default child-process runner (bun, quiet, CI). */
const defaultExec: NonNullable<CertificationRunConfig['execImpl']> = async (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env as unknown as NodeJS.ProcessEnv, encoding: 'utf8' },
      (error: ExecException | null, stdout: string, stderr: string) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        if (error !== null && code === 0) {
          reject(error);
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
  });
};

/** The repository's current HEAD commit (short-circuit to a placeholder when git is unavailable). */
async function currentCommit(repoRoot: string): Promise<string> {
  try {
    const { execSync } = await import('node:child_process');
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
