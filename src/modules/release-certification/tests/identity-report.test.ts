// W079 — the identity adapters and evidence renderers: the ten-field
// deployment identity, the health observation, the read-only Vercel
// listing adapter, the identity verification gate, and the exact JSON /
// markdown artifacts the evidence tree commits (contract §3/§9).

import { describe, expect, it } from 'vitest';
import {
  deploymentFromListing,
  deploymentIdentity,
  identityVerificationReasons,
  observeG1Health,
} from '../identity';
import {
  finalCertificationToMarkdown,
  finalVerdictToJson,
  runReportToMarkdown,
  runResultToJson,
} from '../report';
import type { CertificationRunResult } from '../types';

const HEALTH_BODY = {
  status: 'ok',
  environment: { environment: 'production', hostedOnVercel: true },
  components: {
    db: { backend: 'postgres', ok: true, migrations: 91, error: null },
    queue: { backend: 'redis' },
    cache: { backend: 'redis' },
    lock: { backend: 'redis' },
    email: { backend: 'resend' },
    blob: { backend: 'vercel-blob' },
  },
  readiness: { refusals: [], warnings: [] },
  worker: { jobsProcessed: 3 },
};

describe('the G1 health observation', () => {
  it('reads the documented health contract defensively', () => {
    const observation = observeG1Health(200, HEALTH_BODY);
    expect(observation).toMatchObject({
      httpStatus: 200,
      healthStatus: 'ok',
      environment: 'production',
      hostedOnVercel: true,
      dbBackend: 'postgres',
      dbMigrations: 91,
      queueBackend: 'redis',
      emailBackend: 'resend',
      blobBackend: 'vercel-blob',
    });
    expect(observation.refusals).toEqual([]);
  });

  it('reads absence as null — never invents fields', () => {
    const observation = observeG1Health(503, null);
    expect(observation).toMatchObject({
      httpStatus: 503,
      healthStatus: null,
      environment: null,
      dbBackend: null,
      workerMetrics: null,
    });
  });

  it('reads readiness refusals verbatim', () => {
    const observation = observeG1Health(200, {
      ...HEALTH_BODY,
      readiness: { refusals: ['embedded database refuses production serving'], warnings: [] },
    });
    expect(observation.refusals).toEqual(['embedded database refuses production serving']);
  });
});

describe('the deployment listing adapter and identity gate', () => {
  it('extracts the identity fields of a production deployment entry', () => {
    const entry = {
      uid: 'dpl_42N21dKzTM',
      readyState: 'READY',
      createdAt: 1790136926369,
      meta: { githubCommitSha: 'c0ea5f78f8979d46029ac6124eff2bf0ebd6d988' },
    };
    expect(deploymentFromListing(entry)).toEqual({
      deploymentId: 'dpl_42N21dKzTM',
      readyState: 'READY',
      createdAt: '2026-09-23T04:15:26.369Z',
      commitSha: 'c0ea5f78f8979d46029ac6124eff2bf0ebd6d988',
    });
  });

  it('accepts the expected live deployment', () => {
    expect(
      identityVerificationReasons(
        { deploymentId: 'dpl_1', commitSha: 'sha-1', createdAt: '2026-09-23T04:15:26Z' },
        { deploymentId: 'dpl_1', readyState: 'READY', createdAt: '2026-09-23T04:15:26.369Z', commitSha: 'sha-1' },
      ),
    ).toEqual([]);
  });

  it('refuses a different deployment, a non-READY state, or a different SHA', () => {
    const reasons = identityVerificationReasons(
      { deploymentId: 'dpl_1', commitSha: 'sha-1', createdAt: '2026-09-23T04:15:26Z' },
      { deploymentId: 'dpl_2', readyState: 'BUILDING', createdAt: '2026-09-24T00:00:00Z', commitSha: 'sha-2' },
    );
    expect(reasons).toHaveLength(4);
  });
});

describe('the deployment identity manifest (the ten contract fields)', () => {
  it('carries hostname, deployment id, commit SHA, timestamps, environment, backend class, worker state, command, repository', () => {
    const identity = deploymentIdentity({
      hostname: 'aurum-chat-livid.vercel.app',
      deploymentId: 'dpl_42N21dKzTM',
      commitSha: 'c0ea5f78',
      deploymentCreatedAt: '2026-09-23T04:15:26Z',
      certificationStartedAt: '2026-09-23T10:00:00Z',
      health: observeG1Health(200, HEALTH_BODY),
      worker: { seamTokenGated: true, snapshotReachable: true, environment: 'production', queueDepth: 0 },
      command: 'bun run cert:production -- --run a',
      git: {
        remote: 'https://github.com/payswapdotorg/aurum-chat.git',
        branch: 'work/w079-production-certification',
        baseCommit: 'c0ea5f78',
        headCommit: 'def456',
      },
    });
    expect(identity.hostname).toBe('aurum-chat-livid.vercel.app');
    expect(identity.deploymentId).toBe('dpl_42N21dKzTM');
    expect(identity.commitSha).toBe('c0ea5f78');
    expect(identity.environmentLabel).toBe('production');
    expect(identity.databaseBackendClass).toBe('postgres');
    expect(identity.workerRuntimeState.seamTokenGated).toBe(true);
    expect(identity.repository.branch).toBe('work/w079-production-certification');
  });
});

/** A minimal run for the renderer tests. */
function sampleRun(): CertificationRunResult {
  return {
    runLabel: 'A',
    startedAt: '2026-09-23T10:00:00Z',
    finishedAt: '2026-09-23T11:00:00Z',
    target: 'https://aurum-chat-livid.vercel.app',
    identity: deploymentIdentity({
      hostname: 'aurum-chat-livid.vercel.app',
      deploymentId: 'dpl_42N21dKzTM',
      commitSha: 'c0ea5f78f8979d46029ac6124eff2bf0ebd6d988',
      deploymentCreatedAt: '2026-09-23T04:15:26Z',
      certificationStartedAt: '2026-09-23T10:00:00Z',
      health: observeG1Health(200, HEALTH_BODY),
      worker: { seamTokenGated: true, snapshotReachable: true, environment: 'production', queueDepth: 0 },
      command: 'bun run cert:production -- --run a',
      git: {
        remote: 'https://github.com/payswapdotorg/aurum-chat.git',
        branch: 'work/w079-production-certification',
        baseCommit: 'c0ea5f78',
        headCommit: 'def456',
      },
    }),
    gates: [
      { id: 'g1.health', title: 'the production runtime is genuinely production', status: 'pass', detail: 'status ok · environment production' },
    ],
    repoGates: [{ command: 'bun run typecheck', exitCode: 0, summary: 'tsc --noEmit — clean' }],
    w078: {
      label: 'production-certification-run-a',
      summary: { total: 40, passed: 32, failed: 0, blocked: 0, skipped: 8 },
      reportPath: 'docs/productization-evidence/W079/production-run-a/w078/smoke-report.json',
    },
    journeys: [
      {
        journeyId: 'J01',
        status: 'pass',
        contexts: [{ context: 'desktop', status: 'pass', detail: 'j01-entry:desktop green' }],
        testIds: ['j01-entry:desktop'],
        transcripts: ['docs/productization-evidence/W079/production-run-a/transcripts/j01-entry.json'],
        screenshots: ['docs/productization-evidence/W079/production-run-a/screens/j01-entry.png'],
        errorCaptures: ['docs/productization-evidence/W079/production-run-a/errors/j01-entry.json'],
        detail: 'observed as specified: anonymous → sign-in → onboarding → company → Chat',
      },
    ],
    summary: { passed: 15, failed: 0, blocked: 0, flaky: 0, unexpected: 0 },
    verdict: 'CERTIFIED READY',
    command: 'bun run cert:production -- --run a',
    evidenceDir: 'docs/productization-evidence/W079/production-run-a',
  };
}

describe('the evidence renderers (contract §9)', () => {
  it('serializes the run result as parseable JSON', () => {
    const run = sampleRun();
    const parsed = JSON.parse(runResultToJson(run)) as CertificationRunResult;
    expect(parsed.runLabel).toBe('A');
    expect(parsed.identity.deploymentId).toBe('dpl_42N21dKzTM');
    expect(parsed.summary.failed).toBe(0);
  });

  it('renders the run report with the verdict, gates and journey table', () => {
    const markdown = runReportToMarkdown(sampleRun());
    expect(markdown).toContain('# W079 production journey certification — Run A');
    expect(markdown).toContain('dpl_42N21dKzTM');
    expect(markdown).toContain('**J01** First-time manager');
    expect(markdown).toContain('Run verdict: **CERTIFIED READY**');
    expect(markdown).toContain('W078 hosted smoke rerun');
  });

  it('renders the final certification document with the two-run record', () => {
    const run = sampleRun();
    const markdown = finalCertificationToMarkdown({
      verdict: 'CERTIFIED READY',
      runA: run,
      runB: { ...run, runLabel: 'B' },
      reasons: [],
      checks: [{ id: 'identity.deployment-id', title: 'the runs agree on the deployment id', status: 'pass', detail: 'dpl_42N21dKzTM' }],
      generatedAt: '2026-09-23T12:00:00Z',
    });
    expect(markdown).toContain('**Verdict:** ✅ **CERTIFIED READY**');
    expect(markdown).toContain('## The two-run rule (contract §7)');
    expect(markdown).toContain('**Run A:**');
    expect(markdown).toContain('**Run B:**');
    expect(markdown).toContain('bun run cert:production');
  });

  it('names the blockers when the verdict is BLOCKED', () => {
    const markdown = finalCertificationToMarkdown({
      verdict: 'BLOCKED',
      runA: null,
      runB: null,
      reasons: ['Run A is missing — the first full certification run has not completed'],
      checks: [],
      generatedAt: '2026-09-23T12:00:00Z',
    });
    expect(markdown).toContain('**Verdict:** ⛔ **BLOCKED**');
    expect(markdown).toContain('Run A is missing');
  });

  it('serializes the final verdict with the check trail', () => {
    const json = finalVerdictToJson({
      verdict: 'CERTIFIED READY',
      runA: null,
      runB: null,
      reasons: [],
      checks: [],
      generatedAt: '2026-09-23T12:00:00Z',
    });
    expect(JSON.parse(json).verdict).toBe('CERTIFIED READY');
  });
});
