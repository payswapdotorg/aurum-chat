// W079 — the verdict engine's unit proof: every branch of the G1/G3
// evaluations, the run summary, and the two-run same-revision rule,
// including the BLOCKED-vs-FAILED discipline (contract §2/§11).

import { describe, expect, it } from 'vitest';
import {
  finalVerdict,
  gateOneReasons,
  gateThreeReasons,
  journeyResultsFromDigest,
  quickSignInOffReasons,
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

/** A fully-green browser digest. */
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

describe('G3 — the browser proof', () => {
  it('passes on the complete, green, evidenced digest', () => {
    expect(gateThreeReasons(greenDigest())).toEqual([]);
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
function greenRun(label: 'A' | 'B', deploymentId = 'dpl_x', commitSha = 'sha-1'): CertificationRunResult {
  return {
    runLabel: label,
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
