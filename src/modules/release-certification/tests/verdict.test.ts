// W079/W101 — the verdict engine's unit proof: every branch of the G1/G3
// evaluations, the run summary, the two-run same-revision rule, the W101
// honest BLOCKED channel and the rollback-evidence gate — including the
// BLOCKED-vs-FAILED discipline (contract §2/§11).

import { describe, expect, it } from 'vitest';
import {
  finalVerdict,
  gateOneReasons,
  gateThreeReasons,
  journeyResultsFromDigest,
  quickSignInOffReasons,
  rollbackEvidenceReasons,
  runVerdict,
  summarizeRun,
  w078RerunReasons,
  workerAuthorizationReasons,
} from '../verdict';
import type {
  BrowserRunDigest,
  CertificationCheck,
  CertificationRunResult,
  G1HealthObservation,
} from '../types';

/** A green production health observation. */
function greenHealth(overrides: Partial<G1HealthObservation> = {}): G1HealthObservation {
  return {
    httpStatus: 200,
    healthStatus: 'ok',
    environment: 'production',
    hostedOnVercel: true,
    dbBackend: 'postgres',
    dbMigrations: 91,
    dbError: null,
    queueBackend: 'redis',
    cacheBackend: 'redis',
    lockBackend: 'redis',
    emailBackend: 'resend',
    blobBackend: 'vercel-blob',
    refusals: [],
    warnings: [],
    workerMetrics: {},
    ...overrides,
  };
}

describe('G1 — the production runtime is genuinely production', () => {
  it('passes on the green production health contract', () => {
    expect(gateOneReasons(greenHealth())).toEqual([]);
  });

  it('fails when the environment is not production', () => {
    const reasons = gateOneReasons(greenHealth({ environment: 'preview' }));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("environment label is 'preview'");
  });

  it('fails when the database is the embedded runtime (lock 35)', () => {
    const reasons = gateOneReasons(greenHealth({ dbBackend: 'embedded' }));
    expect(reasons[0]).toContain("database backend is 'embedded'");
  });

  it('fails when queue/cache/lock are not the production redis path', () => {
    const reasons = gateOneReasons(greenHealth({ queueBackend: 'memory' }));
    expect(reasons[0]).toContain("queue backend is 'memory'");
  });

  it('fails on readiness refusals and warnings (the honest-refusal contract)', () => {
    const reasons = gateOneReasons(
      greenHealth({ refusals: ['db not ready'], warnings: ['queue durability'] }),
    );
    expect(reasons).toHaveLength(2);
  });

  it('fails on a non-200 health endpoint before anything else', () => {
    expect(gateOneReasons(greenHealth({ httpStatus: 503 }))).toEqual([
      'expected HTTP 200 from /api/health (got 503)',
    ]);
  });
});

describe('G1 — quick-sign-in and worker authorization probes', () => {
  it('accepts the honest production refusal (404) of quick-sign-in', () => {
    expect(quickSignInOffReasons(404, '{"error":"not_available"}')).toEqual([]);
    expect(quickSignInOffReasons(405, '')).toEqual([]);
  });

  it('fails when quick-sign-in is live in production', () => {
    const reasons = quickSignInOffReasons(200, '{"session":{}}');
    expect(reasons[0]).toContain('production demo credentials must be OFF');
  });

  it('verifies the worker seam fail-closed auth and the valid token', () => {
    expect(
      workerAuthorizationReasons({
        noTokenStatus: 401,
        badTokenStatus: 401,
        validStatus: 200,
        environment: 'production',
        metrics: true,
      }),
    ).toEqual([]);
  });

  it('fails when the seam is not token-gated', () => {
    const reasons = workerAuthorizationReasons({
      noTokenStatus: 200,
      badTokenStatus: 401,
      validStatus: 200,
      environment: 'production',
      metrics: true,
    });
    expect(reasons[0]).toContain('fail-closed');
  });

  it('fails when the valid token cannot read the snapshot', () => {
    const reasons = workerAuthorizationReasons({
      noTokenStatus: 401,
      badTokenStatus: 401,
      validStatus: 401,
      environment: 'production',
      metrics: false,
    });
    expect(reasons.join(' ')).toContain('with the valid token');
  });
});

/** A fully-green W079 browser digest (the frozen fifteen + the J14 mobile pair). */
function greenDigest(overrides: Partial<BrowserRunDigest> = {}): BrowserRunDigest {
  const tests = [
    ...Array.from({ length: 15 }, (_, index) => ({
      testId: `j${String(index + 1).padStart(2, '0')}-x:desktop`,
      journeyId: `J${String(index + 1).padStart(2, '0')}` as BrowserRunDigest['tests'][number]['journeyId'],
      context: 'desktop' as const,
      status: 'pass' as const,
      title: `J${String(index + 1).padStart(2, '0')} desktop`,
      file: 'tests/browser/production/x.spec.ts',
      durationMs: 1000,
      error: null,
    })),
    {
      testId: 'j14-x:mobile',
      journeyId: 'J14' as const,
      context: 'mobile' as const,
      status: 'pass' as const,
      title: 'J14 mobile',
      file: 'tests/browser/production/x.spec.ts',
      durationMs: 1000,
      error: null,
    },
  ];
  return {
    total: 16,
    passed: 16,
    failed: 0,
    flaky: 0,
    skipped: 0,
    tests,
    violations: [],
    evidence: {
      transcripts: ['production-run-a/transcripts/j01.json'],
      screenshots: ['production-run-a/screens/j01.png'],
      errorCaptures: ['production-run-a/errors/j01.json'],
      results: [],
    },
    ...overrides,
  };
}

/**
 * A fully-green W101 browser digest: the twenty-one desktop tests
 * (J01–J13, J15–J22) plus the J14 mobile pair — optionally carrying the
 * honest BLOCKED channel on the post-S002 journeys that name surfaces
 * missing from the deployed revision.
 */
function greenW101Digest(
  blockedJourneys: readonly string[] = [],
  overrides: Partial<BrowserRunDigest> = {},
): BrowserRunDigest {
  const desktop = [
    ...Array.from({ length: 13 }, (_, index) => `J${String(index + 1).padStart(2, '0')}`),
    'J15', 'J16', 'J17', 'J18', 'J19', 'J20', 'J21', 'J22',
  ];
  const tests: BrowserRunDigest['tests'] = desktop.map((journeyId) => ({
    testId: `${journeyId.toLowerCase()}-x:desktop`,
    journeyId: journeyId as BrowserRunDigest['tests'][number]['journeyId'],
    context: 'desktop' as const,
    status: 'pass' as const,
    title: `${journeyId} desktop`,
    file: 'tests/browser/production/x.spec.ts',
    durationMs: 1000,
    error: null,
    ...(blockedJourneys.includes(journeyId)
      ? {
          blockedReasons: [
            `the ${journeyId} surface does not exist in the deployed revision (probe evidence recorded)`,
          ],
          blockedEvidence: { probe: `${journeyId}-absent` },
        }
      : {}),
  }));
  tests.push({
    testId: 'j14-x:mobile',
    journeyId: 'J14' as const,
    context: 'mobile' as const,
    status: 'pass' as const,
    title: 'J14 mobile',
    file: 'tests/browser/production/x.spec.ts',
    durationMs: 1000,
    error: null,
  });
  return {
    total: tests.length,
    passed: tests.length,
    failed: 0,
    flaky: 0,
    skipped: 0,
    tests,
    violations: [],
    evidence: {
      transcripts: ['production-run-a/transcripts/j01.json'],
      screenshots: ['production-run-a/screens/j01.png'],
      errorCaptures: ['production-run-a/errors/j01.json'],
      results: [],
    },
    ...overrides,
  };
}

describe('G3 — the browser proof', () => {
  it('passes on the complete, green, evidenced digest', () => {
    expect(gateThreeReasons(greenDigest())).toEqual([]);
  });

  it('passes on the complete W101 digest (the J01–J22 inventory)', () => {
    expect(gateThreeReasons(greenW101Digest(), 'W101')).toEqual([]);
  });

  it('the W101 gate tolerates the honest BLOCKED channel (the block surfaces through the journey status)', () => {
    const digest = greenW101Digest(['J17', 'J18']);
    expect(gateThreeReasons(digest, 'W101')).toEqual([]);
  });

  it('the W079 gate does not demand the post-S002 journeys (the frozen program)', () => {
    const reasons = gateThreeReasons(greenDigest(), 'W079');
    expect(reasons).toEqual([]);
    const w101Reasons = gateThreeReasons(greenDigest(), 'W101');
    expect(w101Reasons.join(' ')).toContain('J16 has no desktop browser test');
  });

  it('fails when a journey context is missing from the run', () => {
    const digest = greenDigest();
    digest.tests = digest.tests.filter((test) => test.journeyId !== 'J07');
    const reasons = gateThreeReasons(digest);
    expect(reasons[0]).toContain('J07 has no desktop browser test');
  });

  it('fails when a mandatory journey was skipped', () => {
    const digest = greenDigest();
    digest.tests[6] = { ...digest.tests[6]!, status: 'skipped' };
    const reasons = gateThreeReasons(digest);
    expect(reasons.join(' ')).toContain('cannot be skipped');
  });

  it('fails on flaky tests (the matrix requires determinism)', () => {
    const reasons = gateThreeReasons(greenDigest({ flaky: 1 }));
    expect(reasons[0]).toContain('flaky');
  });

  it('fails when any journey captured console/network violations', () => {
    const reasons = gateThreeReasons(
      greenDigest({ violations: [{ testId: 'j02-x:desktop', violations: 3 }] }),
    );
    expect(reasons[0]).toContain('j02-x:desktop(3)');
  });

  it('fails when the run produced no evidence artifacts', () => {
    const reasons = gateThreeReasons(
      greenDigest({ evidence: { transcripts: [], screenshots: [], errorCaptures: [], results: [] } }),
    );
    expect(reasons).toEqual([
      'the run produced no journey transcripts',
      'the run produced no decisive-checkpoint screenshots',
      'the run produced no browser error captures (the zero-violation record)',
    ]);
  });
});

describe('the journey folding and run summary', () => {
  it('folds a green digest into fifteen passing journeys', () => {
    const journeys = journeyResultsFromDigest(greenDigest());
    expect(journeys).toHaveLength(15);
    expect(journeys.every((journey) => journey.status === 'pass')).toBe(true);
    expect(journeys[0]!.detail).toContain('anonymous → sign-in → onboarding');
  });

  it('folds a failing test into a failing journey with the failure detail', () => {
    const digest = greenDigest();
    digest.tests[1] = { ...digest.tests[1]!, status: 'fail', error: 'selector not found' };
    const journeys = journeyResultsFromDigest(digest);
    expect(journeys[1]!.status).toBe('fail');
    expect(journeys[1]!.detail).toContain('selector not found');
  });

  it('folds the W101 digest into twenty-two journeys', () => {
    const journeys = journeyResultsFromDigest(greenW101Digest(), 'W101');
    expect(journeys).toHaveLength(22);
    expect(journeys.every((journey) => journey.status === 'pass')).toBe(true);
  });

  it('folds the honest BLOCKED channel into blocked journeys carrying the exact reason', () => {
    const digest = greenW101Digest(['J16', 'J17', 'J18', 'J22']);
    const journeys = journeyResultsFromDigest(digest, 'W101');
    expect(journeys).toHaveLength(22);
    const blocked = journeys.filter((journey) => journey.status === 'blocked');
    expect(blocked.map((journey) => journey.journeyId)).toEqual(['J16', 'J17', 'J18', 'J22']);
    for (const journey of blocked) {
      expect(journey.detail).toContain('does not exist in the deployed revision');
      expect(journey.contexts[0]!.status).toBe('blocked');
    }
    const passing = journeys.filter((journey) => journey.status === 'pass');
    expect(passing).toHaveLength(18);
  });

  it('a FAILING test dominates recorded blocked reasons (a real defect is FAILED, never BLOCKED)', () => {
    const digest = greenW101Digest(['J17']);
    const j17 = digest.tests.find((test) => test.journeyId === 'J17')!;
    digest.tests[digest.tests.indexOf(j17)] = { ...j17, status: 'fail', error: 'boom' };
    const journeys = journeyResultsFromDigest(digest, 'W101');
    const failing = journeys.find((journey) => journey.journeyId === 'J17')!;
    expect(failing.status).toBe('fail');
    expect(failing.detail).toContain('boom');
  });

  it('summarizes a blocked-journey run as BLOCKED (never green)', () => {
    const journeys = journeyResultsFromDigest(greenW101Digest(['J16', 'J17', 'J18', 'J22']), 'W101');
    const summary = summarizeRun(journeys, []);
    expect(summary).toEqual({ passed: 18, failed: 0, blocked: 4, flaky: 0, unexpected: 0 });
    expect(runVerdict(summary)).toBe('BLOCKED');
  });

  it('summarizes gates and journeys together', () => {
    const journeys = journeyResultsFromDigest(greenDigest()).map((journey) => ({
      ...journey,
      status: journey.journeyId === 'J04' ? ('blocked' as const) : journey.status,
    }));
    const gates: CertificationCheck[] = [
      { id: 'g1.health', title: 'health', status: 'pass', detail: 'ok' },
      { id: 'g1.worker', title: 'worker', status: 'fail', detail: 'no token' },
    ];
    const summary = summarizeRun(journeys, gates);
    expect(summary).toEqual({ passed: 14, failed: 1, blocked: 1, flaky: 0, unexpected: 0 });
  });

  it('runs the verdict vocabulary exactly (FAILED > BLOCKED > CERTIFIED READY)', () => {
    expect(runVerdict({ passed: 15, failed: 0, blocked: 0, flaky: 0, unexpected: 0 })).toBe(
      'CERTIFIED READY',
    );
    expect(runVerdict({ passed: 14, failed: 0, blocked: 1, flaky: 0, unexpected: 0 })).toBe('BLOCKED');
    expect(runVerdict({ passed: 14, failed: 1, blocked: 0, flaky: 0, unexpected: 0 })).toBe('FAILED');
  });
});

describe('the W078 rerun gate', () => {
  it('passes on a green zero-blocked rerun', () => {
    expect(w078RerunReasons({ failed: 0, blocked: 0 })).toEqual([]);
  });

  it('separates deployment defects from external preconditions', () => {
    expect(w078RerunReasons({ failed: 2, blocked: 0 })[0]).toContain('deployment violates');
    expect(w078RerunReasons({ failed: 0, blocked: 2 })[0]).toContain('external precondition');
  });
});

/** A minimal green run result for the two-run rule. */
function greenRun(
  label: 'A' | 'B',
  deploymentId = 'dpl_x',
  commitSha = 'sha-1',
): CertificationRunResult {
  return {
    runLabel: label,
    program: 'W079',
    startedAt: '2026-09-23T10:00:00Z',
    finishedAt: '2026-09-23T11:00:00Z',
    target: 'https://aurum-chat-livid.vercel.app',
    identity: {
      hostname: 'aurum-chat-livid.vercel.app',
      deploymentId,
      commitSha,
      deploymentCreatedAt: '2026-09-23T04:15:26Z',
      certificationStartedAt: '2026-09-23T10:00:00Z',
      environmentLabel: 'production',
      databaseBackendClass: 'postgres',
      workerRuntimeState: {
        seamTokenGated: true,
        snapshotReachable: true,
        environment: 'production',
        queueDepth: 0,
      },
      command: 'bun run cert:production -- --run a',
      repository: {
        remote: 'https://github.com/payswapdotorg/aurum-chat.git',
        branch: 'work/w079-production-certification',
        baseCommit: 'c0ea5f78',
        headCommit: 'abc123',
      },
    },
    gates: [],
    repoGates: [],
    w078: null,
    journeys: journeyResultsFromDigest(greenDigest()),
    summary: { passed: 15, failed: 0, blocked: 0, flaky: 0, unexpected: 0 },
    verdict: 'CERTIFIED READY',
    command: 'bun run cert:production -- --run a',
    evidenceDir: `docs/productization-evidence/W079/production-run-${label.toLowerCase()}`,
  };
}

describe('the two-run same-revision rule (contract §7)', () => {
  it('stays BLOCKED while either run is missing', () => {
    const missingA = finalVerdict(null, greenRun('B'));
    expect(missingA.verdict).toBe('BLOCKED');
    expect(missingA.reasons[0]).toContain('Run A is missing');
    const missingB = finalVerdict(greenRun('A'), null);
    expect(missingB.verdict).toBe('BLOCKED');
    expect(missingB.reasons[0]).toContain('Run B is missing');
    expect(finalVerdict(null, null).verdict).toBe('BLOCKED');
  });

  it('certifies two green runs against the same deployment revision', () => {
    const outcome = finalVerdict(greenRun('A'), greenRun('B'));
    expect(outcome.verdict).toBe('CERTIFIED READY');
    expect(outcome.reasons).toEqual([]);
    expect(outcome.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('stays BLOCKED when the second run hit a different deployment revision', () => {
    const outcome = finalVerdict(greenRun('A'), greenRun('B', 'dpl_y', 'sha-2'));
    expect(outcome.verdict).toBe('BLOCKED');
    expect(outcome.reasons[0]).toContain('do not share the same deployment revision');
  });

  it('is FAILED when either run has a real defect', () => {
    const failing = greenRun('A');
    failing.summary = { ...failing.summary, failed: 1 };
    const outcome = finalVerdict(failing, greenRun('B'));
    expect(outcome.verdict).toBe('FAILED');
    expect(outcome.reasons[0]).toContain('Run A is not fully green');
  });

  it('is FAILED when the two runs disagree on a journey', () => {
    const runB = greenRun('B');
    runB.journeys = runB.journeys.map((journey) =>
      journey.journeyId === 'J09' ? { ...journey, status: 'fail' } : journey,
    );
    const outcome = finalVerdict(greenRun('A'), runB);
    expect(outcome.verdict).toBe('FAILED');
    expect(outcome.reasons.join(' ')).toContain('J09');
  });

  it('a blocked run keeps the verdict honest (BLOCKED, never green)', () => {
    const blocked = greenRun('A');
    blocked.summary = { ...blocked.summary, blocked: 2 };
    const outcome = finalVerdict(blocked, greenRun('B'));
    expect(outcome.verdict).toBe('BLOCKED');
    expect(outcome.reasons[0]).toContain('Run A is not fully green');
  });
});

describe('the W101 two-run rule (the post-S002 program)', () => {
  /** A W101 run folded from the digest (with the honest BLOCKED channel). */
  function w101Run(
    label: 'A' | 'B',
    blockedJourneys: readonly string[] = ['J16', 'J17', 'J18', 'J22'],
  ): CertificationRunResult {
    const base = greenRun(label);
    const journeys = journeyResultsFromDigest(greenW101Digest(blockedJourneys), 'W101');
    const passed = journeys.filter((journey) => journey.status === 'pass').length;
    const blocked = journeys.filter((journey) => journey.status === 'blocked').length;
    return {
      ...base,
      program: 'W101',
      journeys,
      summary: { passed, failed: 0, blocked, flaky: 0, unexpected: 0 },
      verdict: blocked > 0 ? 'BLOCKED' : 'CERTIFIED READY',
      evidenceDir: `docs/productization-evidence/W101/production-run-${label.toLowerCase()}`,
    };
  }

  it('is BLOCKED with the EXACT per-journey reasons when the post-S002 surfaces are missing', () => {
    const outcome = finalVerdict(w101Run('A'), w101Run('B'));
    expect(outcome.verdict).toBe('BLOCKED');
    const joined = outcome.reasons.join(' ');
    expect(joined).toContain('Run A is not fully green (0 failed · 4 blocked');
    expect(joined).toContain('Run A journey J17 is BLOCKED');
    expect(joined).toContain('the J17 surface does not exist in the deployed revision');
    expect(joined).toContain('Run B journey J22 is BLOCKED');
    // The program agreement check passes (both runs are W101).
    expect(
      outcome.checks.find((check) => check.id === 'runs.program-agreement')?.status,
    ).toBe('pass');
  });

  it('names the FAILED journey’s reproducible detail (contract §11)', () => {
    const runA = w101Run('A');
    const runB = w101Run('B');
    for (const run of [runA, runB]) {
      run.journeys = run.journeys.map((journey) =>
        journey.journeyId === 'J20'
          ? {
              ...journey,
              status: 'fail' as const,
              detail: 'the /ai/preferences surface answers HTTP 200 in production — expected 200, received 500',
            }
          : journey,
      );
      run.summary = { ...run.summary, failed: 1, blocked: 3 };
    }
    const outcome = finalVerdict(runA, runB);
    expect(outcome.verdict).toBe('FAILED');
    const joined = outcome.reasons.join(' ');
    expect(joined).toContain('Run A journey J20 FAILED: the /ai/preferences surface answers HTTP 200');
    expect(joined).toContain('Run B journey J20 FAILED:');
    expect(joined).toContain('Run A journey J16 is BLOCKED');
  });

  it('certifies READY when both W101 runs are fully green (no blocked journeys)', () => {
    const outcome = finalVerdict(w101Run('A', []), w101Run('B', []));
    expect(outcome.verdict).toBe('CERTIFIED READY');
    expect(outcome.reasons).toEqual([]);
  });

  it('stays BLOCKED when a W079 pass is paired with a W101 pass (program mismatch)', () => {
    const outcome = finalVerdict(greenRun('A'), w101Run('B'));
    expect(outcome.verdict).toBe('BLOCKED');
    expect(outcome.reasons.join(' ')).toContain('do not certify the same program');
  });

  it('a missing program field reads as the frozen W079 program (historical runs)', () => {
    const runA = greenRun('A');
    const runB = greenRun('B');
    delete (runA as Partial<CertificationRunResult>).program;
    const outcome = finalVerdict(runA as CertificationRunResult, runB);
    expect(
      outcome.checks.find((check) => check.id === 'runs.program-agreement')?.status,
    ).toBe('pass');
    expect(outcome.verdict).toBe('CERTIFIED READY');
  });
});

describe('the W101 rollback-evidence gate', () => {
  const greenInput = {
    healthSnapshot: { environment: 'production', dbBackend: 'postgres', dbMigrations: 91 },
    workerSnapshot: { environment: 'production', queueDepth: 0, reachable: true },
    rollbackTarget: { deploymentId: 'dpl_prior', commitSha: 'sha-prior', readyState: 'READY' },
    runbookPresent: true,
    w078EvidencePresent: true,
  };

  it('passes when the seam state, the rollback target, the runbook and the W078 link are on record', () => {
    expect(rollbackEvidenceReasons(greenInput)).toEqual([]);
  });

  it('is blocked when the health seam state is not the production posture', () => {
    const reasons = rollbackEvidenceReasons({
      ...greenInput,
      healthSnapshot: { environment: 'preview', dbBackend: 'postgres', dbMigrations: 91 },
    });
    expect(reasons[0]).toContain("environment 'preview'");
  });

  it('is blocked when the worker seam snapshot is unreachable', () => {
    const reasons = rollbackEvidenceReasons({
      ...greenInput,
      workerSnapshot: { environment: null, queueDepth: null, reachable: false },
    });
    expect(reasons[0]).toContain('worker seam snapshot was not recorded');
  });

  it('is blocked when no prior READY production deployment is on record (no rollback target)', () => {
    const reasons = rollbackEvidenceReasons({
      ...greenInput,
      rollbackTarget: { deploymentId: null, commitSha: null, readyState: null },
    });
    expect(reasons[0]).toContain('no prior READY production deployment');
  });

  it('is blocked when the rollback runbook or the W078 evidence tree is missing', () => {
    const reasons = rollbackEvidenceReasons({ ...greenInput, runbookPresent: false });
    expect(reasons[0]).toContain('docs/DEPLOYMENT.md §12');
    const reasons2 = rollbackEvidenceReasons({ ...greenInput, w078EvidencePresent: false });
    expect(reasons2[0]).toContain('docs/productization-evidence/W078/');
  });
});
