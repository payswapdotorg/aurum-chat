// W079 — the verdict engine (PURE). Every gate evaluation and the final
// certification verdict is a total, deterministic function of the
// observations the driver records — the same discipline the W078
// expectations module applies. Nothing here performs I/O; the unit tests
// pin every branch, including the BLOCKED-vs-FAILED discipline the
// contract demands (§2: never convert BLOCKED to PASS; a fabricated green
// run is the only truly failing outcome for the WORKER, a real defect is
// a FAILED system).

import type {
  BrowserRunDigest,
  CertificationCheck,
  CertificationProgram,
  CertificationRunResult,
  CertificationStatus,
  CertificationVerdictKind,
  G1HealthObservation,
  JourneyResult,
  RunSummary,
} from './types';
import { journeySpec, programJourneys, requiredBrowserTests } from './matrix';

/**
 * G1 — the production runtime is genuinely production (contract §4 G1).
 * PASS requires the health contract to hold on the live target and the
 * environment to be exactly 'production' with an external PostgreSQL.
 */
export function gateOneReasons(health: G1HealthObservation): string[] {
  const reasons: string[] = [];
  if (health.httpStatus !== 200) {
    reasons.push(`expected HTTP 200 from /api/health (got ${health.httpStatus})`);
    return reasons;
  }
  if (health.healthStatus !== 'ok') {
    reasons.push(`the target reports status '${health.healthStatus}' (expected 'ok')`);
  }
  if (health.environment !== 'production') {
    reasons.push(`the environment label is '${health.environment}' (expected 'production')`);
  }
  if (health.hostedOnVercel !== true) {
    reasons.push('the target does not report itself as hosted on Vercel');
  }
  if (health.dbBackend !== 'postgres') {
    reasons.push(
      `the database backend is '${health.dbBackend}' (expected 'postgres' — the embedded filesystem database is not a production runtime)`,
    );
  }
  if (health.dbMigrations !== null && health.dbMigrations < 1) {
    reasons.push(`the database reports ${health.dbMigrations} applied migrations (expected > 0)`);
  }
  if (health.dbError !== null) {
    reasons.push(`the database reports an error: ${health.dbError}`);
  }
  for (const [name, backend] of [
    ['queue', health.queueBackend],
    ['cache', health.cacheBackend],
    ['lock', health.lockBackend],
  ] as const) {
    if (backend !== 'redis') {
      reasons.push(`the ${name} backend is '${backend}' (expected 'redis' — no local substitute)`);
    }
  }
  if (health.emailBackend === null || health.emailBackend === 'none') {
    reasons.push(`the email backend is '${health.emailBackend}' (expected a configured provider)`);
  }
  if (health.blobBackend === null || health.blobBackend === 'none') {
    reasons.push(`the blob backend is '${health.blobBackend}' (expected a configured provider)`);
  }
  if (health.refusals.length > 0) {
    reasons.push(`the target reports ${health.refusals.length} readiness refusal(s)`);
  }
  if (health.warnings.length > 0) {
    reasons.push(`the target reports ${health.warnings.length} readiness warning(s)`);
  }
  return reasons;
}

/**
 * The quick-sign-in availability probe (G1: production quick-sign-in/demo
 * credentials remain OFF). POST /api/auth/quick-sign-in must be refused.
 */
export function quickSignInOffReasons(
  status: number,
  bodyText: string,
): string[] {
  const reasons: string[] = [];
  if (status === 200) {
    reasons.push(
      `quick-sign-in answered HTTP 200 (${bodyText.slice(0, 120)}) — production demo credentials must be OFF`,
    );
  } else if (status !== 404 && status !== 405) {
    // A 404 (route disabled at build time) or 405 (method refused) is the
    // honest "off"; anything else (403 from an active route) is still a
    // refusal, but 200 would mean the panel is live.
    reasons.push(
      `quick-sign-in answered HTTP ${status} — expected a refusal (404/405) or an auth-style denial, never 200`,
    );
  }
  return reasons;
}

/**
 * The worker seam probe (G1: WORKER_TOKEN exists and authorization works).
 * Observations: unauthenticated status, valid-token status, body shape.
 */
export function workerAuthorizationReasons(observations: {
  noTokenStatus: number;
  badTokenStatus: number;
  validStatus: number;
  environment: string | null;
  metrics: boolean;
}): string[] {
  const reasons: string[] = [];
  if (observations.noTokenStatus !== 401) {
    reasons.push(
      `the worker seam answered ${observations.noTokenStatus} without a token (expected 401 — fail-closed)`,
    );
  }
  if (observations.badTokenStatus !== 401) {
    reasons.push(`the worker seam answered ${observations.badTokenStatus} with a bad token (expected 401)`);
  }
  if (observations.validStatus !== 200) {
    reasons.push(
      `the worker seam answered ${observations.validStatus} with the valid token (expected 200 — the production WORKER_TOKEN must authorize observability)`,
    );
  }
  if (observations.environment !== 'production') {
    reasons.push(
      `the worker snapshot reports environment '${observations.environment}' (expected 'production')`,
    );
  }
  if (!observations.metrics) {
    reasons.push('the worker snapshot carries no metrics registry');
  }
  return reasons;
}

/**
 * G3 — the browser proof used the hosted production URL (contract §4 G3):
 * the run digest must show the required desktop+mobile coverage, real
 * journeys with evidence, and the zero-violation discipline. W101 note:
 * a journey whose tests carry the honest blockedReasons channel does NOT
 * fail this gate — the gate proves the matrix RAN with evidence; the
 * block surfaces through the journey status and the run verdict (which
 * can never be CERTIFIED READY with a blocked journey).
 */
export function gateThreeReasons(
  digest: BrowserRunDigest,
  program: CertificationProgram = 'W079',
): string[] {
  const reasons: string[] = [];
  const required = requiredBrowserTests(program);
  for (const pair of required) {
    const test = digest.tests.find(
      (candidate) => candidate.journeyId === pair.journeyId && candidate.context === pair.context,
    );
    if (test === undefined) {
      reasons.push(`${pair.journeyId} has no ${pair.context} browser test in the run`);
    }
  }
  for (const test of digest.tests) {
    if (test.status === 'skipped') {
      reasons.push(`${test.testId} was skipped — a mandatory journey cannot be skipped`);
    }
  }
  if (digest.flaky > 0) {
    reasons.push(`${digest.flaky} browser test(s) were flaky — the matrix requires determinism`);
  }
  if (digest.evidence.transcripts.length === 0) {
    reasons.push('the run produced no journey transcripts');
  }
  if (digest.evidence.screenshots.length === 0) {
    reasons.push('the run produced no decisive-checkpoint screenshots');
  }
  if (digest.evidence.errorCaptures.length === 0) {
    reasons.push('the run produced no browser error captures (the zero-violation record)');
  }
  const withViolations = digest.violations.filter((entry) => entry.violations > 0);
  if (withViolations.length > 0) {
    reasons.push(
      `${withViolations.length} browser journey(s) captured console/network violations: ${withViolations
        .map((entry) => `${entry.testId}(${entry.violations})`)
        .join(', ')}`,
    );
  }
  return reasons;
}

/**
 * Fold a Playwright digest into per-journey results (program-scoped).
 *
 * The W101 honest BLOCKED channel: a test that PASSED at the Playwright
 * level may carry non-empty `blockedReasons` (machine-checkable reasons a
 * mandatory surface of the journey does not exist in the deployed
 * revision). Such a journey folds to status 'blocked' with those reasons —
 * never 'pass' (the run verdict stays BLOCKED) and never a silent skip. A
 * FAILING test still dominates: a real defect is FAILED, not BLOCKED.
 */
export function journeyResultsFromDigest(
  digest: BrowserRunDigest,
  program: CertificationProgram = 'W079',
): JourneyResult[] {
  const results: JourneyResult[] = [];
  for (const spec of programJourneys(program)) {
    const tests = digest.tests.filter((test) => test.journeyId === spec.id);
    const contexts = spec.contexts.map((context) => {
      const test = tests.find((candidate) => candidate.context === context);
      if (test === undefined) {
        return {
          context,
          status: 'fail' as CertificationStatus,
          detail: `no ${context} test ran for ${spec.id}`,
        };
      }
      if (test.status === 'pass') {
        const reasons = test.blockedReasons ?? [];
        if (reasons.length > 0) {
          return {
            context,
            status: 'blocked' as CertificationStatus,
            detail: reasons.join('; ').slice(0, 400),
          };
        }
        return { context, status: 'pass' as CertificationStatus, detail: `${test.testId} green` };
      }
      if (test.status === 'flaky') {
        return { context, status: 'fail' as CertificationStatus, detail: `${test.testId} was flaky` };
      }
      return {
        context,
        status: 'fail' as CertificationStatus,
        detail: `${test.testId} failed: ${test.error ?? 'no failure detail'}`.slice(0, 400),
      };
    });
    const failing = contexts.filter((entry) => entry.status === 'fail');
    const blocked = contexts.filter((entry) => entry.status === 'blocked');
    results.push({
      journeyId: spec.id,
      status: failing.length > 0 ? 'fail' : blocked.length > 0 ? 'blocked' : 'pass',
      contexts,
      testIds: tests.map((test) => test.testId),
      transcripts: digest.evidence.transcripts.filter((path) => path.includes(spec.id.toLowerCase())),
      screenshots: digest.evidence.screenshots.filter((path) => path.includes(spec.id.toLowerCase())),
      errorCaptures: digest.evidence.errorCaptures.filter((path) =>
        path.includes(spec.id.toLowerCase()),
      ),
      detail:
        failing.length > 0
          ? failing.map((entry) => entry.detail).join('; ').slice(0, 400)
          : blocked.length > 0
            ? `a mandatory surface does not exist in the deployed revision: ${blocked
                .map((entry) => entry.detail)
                .join('; ').slice(0, 400)}`
            : `observed as specified: ${spec.mandatoryProof}`,
    });
  }
  return results;
}

/** The run summary (contract §7's four zeros + the passed count). */
export function summarizeRun(
  journeys: JourneyResult[],
  gates: CertificationCheck[],
): RunSummary {
  const failed = journeys.filter((journey) => journey.status === 'fail').length;
  const blocked = journeys.filter((journey) => journey.status === 'blocked').length;
  const gateFailures = gates.filter((gate) => gate.status === 'fail').length;
  const gateBlocks = gates.filter((gate) => gate.status === 'blocked').length;
  return {
    passed: journeys.filter((journey) => journey.status === 'pass').length,
    failed: failed + gateFailures,
    blocked: blocked + gateBlocks,
    flaky: 0,
    unexpected: 0,
  };
}

/**
 * The W078 hosted smoke rerun gate: the production rerun must be green
 * with zero blocked (the completion rule's second precondition). A FAIL
 * in the smoke is a deployment defect; a BLOCKED check is an external
 * precondition gap.
 */
export function w078RerunReasons(summary: {
  failed: number;
  blocked: number;
}): string[] {
  const reasons: string[] = [];
  if (summary.failed > 0) {
    reasons.push(
      `the W078 hosted smoke rerun reported ${summary.failed} failed check(s) — the deployment violates its own contract`,
    );
  }
  if (summary.blocked > 0) {
    reasons.push(
      `the W078 hosted smoke rerun reported ${summary.blocked} blocked check(s) — an external precondition is missing`,
    );
  }
  return reasons;
}

/**
 * The single-run verdict (contract §2/§11):
 *   FAIL    — a real defect (any journey/gate failed);
 *   BLOCKED — a documented external precondition is missing (and nothing failed);
 *   PASS    — everything green (the run-level precondition for the two-run rule).
 */
export function runVerdict(summary: RunSummary): CertificationVerdictKind {
  if (summary.failed > 0) return 'FAILED';
  if (summary.blocked > 0) return 'BLOCKED';
  return 'CERTIFIED READY';
}

/**
 * The final two-run certification verdict (contract §7): CERTIFIED READY
 * only when BOTH runs are fully green AND the two runs agree on the
 * journey matrix and the deployment identity (the same deployment
 * revision — a second run against a newly deployed revision does not
 * count as the deterministic rerun). Missing runs stay BLOCKED (the
 * honest external state), never silently green. W101: both runs must
 * belong to the SAME program, and every BLOCKED journey's exact reason
 * is carried into the final reasons (the acceptance names the blocker,
 * never a vague count).
 */
export function finalVerdict(
  runA: CertificationRunResult | null,
  runB: CertificationRunResult | null,
): { verdict: CertificationVerdictKind; reasons: string[]; checks: CertificationCheck[] } {
  const reasons: string[] = [];
  const checks: CertificationCheck[] = [];
  const record = (id: string, title: string, failed: boolean, detail: string) => {
    checks.push({ id, title, status: failed ? 'fail' : 'pass', detail });
  };

  if (runA === null) {
    reasons.push('Run A is missing — the first full certification run has not completed');
    record('runs.a-present', 'Run A exists', false, 'Run A is present');
  } else {
    record('runs.a-present', 'Run A exists', false, 'Run A is present');
  }
  if (runB === null) {
    reasons.push('Run B is missing — the deterministic rerun has not completed');
    record('runs.b-present', 'Run B exists', false, 'Run B is present');
  } else {
    record('runs.b-present', 'Run B exists', false, 'Run B is present');
  }
  if (runA === null || runB === null) {
    return { verdict: 'BLOCKED', reasons, checks };
  }

  // Both runs must belong to the same certification program.
  const programOf = (run: CertificationRunResult): CertificationProgram => run.program ?? 'W079';
  const sameProgram = programOf(runA) === programOf(runB);
  record(
    'runs.program-agreement',
    'the runs certify the same program',
    !sameProgram,
    `Run A program ${programOf(runA)} · Run B program ${programOf(runB)}`,
  );
  if (!sameProgram) {
    reasons.push(
      `the runs do not certify the same program (Run A ${programOf(runA)} vs Run B ${programOf(runB)}) — a W079 pass and a W101 pass cannot pair into one two-run verdict`,
    );
  }
  const program = programOf(runA);

  // Both runs must be fully green on their own.
  for (const run of [runA, runB]) {
    const green =
      run.summary.failed === 0 &&
      run.summary.blocked === 0 &&
      run.summary.flaky === 0 &&
      run.summary.unexpected === 0;
    record(
      `runs.${run.runLabel.toLowerCase()}-green`,
      `Run ${run.runLabel} is 0 failed · 0 blocked · 0 flaky · 0 unexpected`,
      !green,
      `Run ${run.runLabel}: ${run.summary.passed} passed · ${run.summary.failed} failed · ${run.summary.blocked} blocked · ${run.summary.flaky} flaky · ${run.summary.unexpected} unexpected`,
    );
    if (!green) {
      reasons.push(
        `Run ${run.runLabel} is not fully green (${run.summary.failed} failed · ${run.summary.blocked} blocked · ${run.summary.flaky} flaky · ${run.summary.unexpected} unexpected)`,
      );
      // The exact per-journey reasons — FAILED journeys name the first
      // reproducible failure (contract §11); BLOCKED journeys name the
      // exact missing surface (never a bare count).
      for (const journey of run.journeys) {
        if (journey.status === 'fail') {
          reasons.push(`Run ${run.runLabel} journey ${journey.journeyId} FAILED: ${journey.detail}`);
        } else if (journey.status === 'blocked') {
          reasons.push(`Run ${run.runLabel} journey ${journey.journeyId} is BLOCKED: ${journey.detail}`);
        }
      }
    }
  }

  // The same deployment revision (contract §7: deployment id + commit SHA
  // + environment label must agree).
  const identityPairs: [string, string | null, string | null][] = [
    ['deployment id', runA.identity.deploymentId, runB.identity.deploymentId],
    ['commit SHA', runA.identity.commitSha, runB.identity.commitSha],
    ['environment label', runA.identity.environmentLabel, runB.identity.environmentLabel],
    ['database backend class', runA.identity.databaseBackendClass, runB.identity.databaseBackendClass],
    ['hostname', runA.identity.hostname, runB.identity.hostname],
  ];
  for (const [name, a, b] of identityPairs) {
    const agree = a !== null && a === b;
    record(
      `identity.${name.replace(/[^a-z0-9]+/gi, '-')}`,
      `the runs agree on the ${name}`,
      !agree,
      `Run A ${name}: ${a} · Run B ${name}: ${b}`,
    );
    if (!agree) {
      reasons.push(
        `the runs do not share the same deployment revision (Run A ${name} '${a}' vs Run B '${b}') — a second run against a newly deployed revision does not count as the deterministic rerun`,
      );
    }
  }

  // The journey matrix verdicts must agree (the program's mandatory set).
  const disagreement: string[] = [];
  for (const spec of programJourneys(program)) {
    const a = runA.journeys.find((journey) => journey.journeyId === spec.id);
    const b = runB.journeys.find((journey) => journey.journeyId === spec.id);
    if (a === undefined || b === undefined) {
      disagreement.push(`${spec.id} missing from a run`);
    } else if (a.status !== b.status) {
      disagreement.push(`${spec.id}: ${a.status} vs ${b.status}`);
    }
  }
  record(
    'matrix.agreement',
    'the two runs agree on the journey matrix',
    disagreement.length > 0,
    disagreement.length === 0
      ? `all ${program} journey statuses identical across Run A and Run B`
      : disagreement.join('; ').slice(0, 300),
  );
  if (disagreement.length > 0) {
    reasons.push(`the two runs disagree on the journey matrix: ${disagreement.join('; ')}`);
  }

  if (reasons.length > 0) {
    const anyFailed =
      runA.summary.failed > 0 || runB.summary.failed > 0 || disagreement.length > 0;
    // A real defect in either run (or a matrix disagreement between two
    // completed green-shaped runs) is FAILED; a missing external
    // precondition is BLOCKED.
    return { verdict: anyFailed ? 'FAILED' : 'BLOCKED', reasons, checks };
  }
  return { verdict: 'CERTIFIED READY', reasons: [], checks };
}

/** The G2 repository gates the certification must run and record (§4 G2). */
export const G2_REPO_GATES: readonly { command: string; label: string }[] = [
  { command: 'bun run typecheck', label: 'typecheck' },
  { command: 'bun run test', label: 'tests' },
  { command: 'bun run arch', label: 'architecture' },
  { command: 'bun run lint', label: 'lint' },
];

/** The certification's journey-count invariant (the program's mandatory set, all present). */
export function journeyInventoryReasons(
  journeys: JourneyResult[],
  program: CertificationProgram = 'W079',
): string[] {
  const reasons: string[] = [];
  for (const spec of programJourneys(program)) {
    if (!journeys.some((journey) => journey.journeyId === spec.id)) {
      reasons.push(`${spec.id} (${journeySpec(spec.id).title}) is missing from the run`);
    }
  }
  return reasons;
}

/**
 * The W101 rollback-evidence gate (the acceptance's rollback dimension).
 * PURE evaluation over the observations the driver records: the
 * deployment/health/worker seams' recorded state a rollback would
 * preserve/restore, the prior READY production deployment (the known-good
 * rollback target), and the committed rollback runbook + W078 operations
 * evidence this certification links (never restates — contract §8). A
 * missing precondition is BLOCKED (an external evidence gap), never a
 * deployment defect.
 */
export function rollbackEvidenceReasons(input: {
  healthSnapshot: { environment: string | null; dbBackend: string | null; dbMigrations: number | null } | null;
  workerSnapshot: { environment: string | null; queueDepth: number | null; reachable: boolean } | null;
  rollbackTarget: { deploymentId: string | null; commitSha: string | null; readyState: string | null } | null;
  runbookPresent: boolean;
  w078EvidencePresent: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.healthSnapshot === null) {
    reasons.push('the health seam snapshot was not recorded — the state a rollback preserves is unproven');
  } else {
    if (input.healthSnapshot.environment !== 'production') {
      reasons.push(
        `the health seam records environment '${input.healthSnapshot.environment}' (expected 'production' — the recorded state must be the production posture a rollback restores)`,
      );
    }
    if (input.healthSnapshot.dbBackend !== 'postgres') {
      reasons.push(
        `the health seam records database backend '${input.healthSnapshot.dbBackend}' (expected 'postgres')`,
      );
    }
    if (input.healthSnapshot.dbMigrations !== null && input.healthSnapshot.dbMigrations < 1) {
      reasons.push(
        `the health seam records ${input.healthSnapshot.dbMigrations} applied migrations (expected > 0)`,
      );
    }
  }
  if (input.workerSnapshot === null || !input.workerSnapshot.reachable) {
    reasons.push('the worker seam snapshot was not recorded (authorized observability is unreachable)');
  } else if (input.workerSnapshot.environment !== 'production') {
    reasons.push(
      `the worker seam records environment '${input.workerSnapshot.environment}' (expected 'production')`,
    );
  }
  if (
    input.rollbackTarget === null ||
    input.rollbackTarget.deploymentId === null ||
    input.rollbackTarget.readyState !== 'READY'
  ) {
    reasons.push(
      'no prior READY production deployment is on record — the known-good rollback target is unproven',
    );
  }
  if (!input.runbookPresent) {
    reasons.push('the rollback runbook (docs/DEPLOYMENT.md §12) is not present in the repository');
  }
  if (!input.w078EvidencePresent) {
    reasons.push(
      'the committed W078 operations evidence tree (docs/productization-evidence/W078/) is not present — the rollback/operations records this certification links are missing',
    );
  }
  return reasons;
}
