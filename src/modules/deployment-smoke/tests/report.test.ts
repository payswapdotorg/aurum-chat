// Unit tests for the W078 report model: summary roll-up, the exit-code
// contract (pass / fail / blocked) and the markdown rendering.

import { describe, expect, it } from 'vitest';
import { reportToJson, reportToMarkdown, smokeExitCode, summarize } from '../report';
import type { SmokeCheckResult, SmokeReport } from '../types';

function result(status: SmokeCheckResult['status'], id = 'x'): SmokeCheckResult {
  return {
    id,
    title: `check ${id}`,
    category: 'health-readiness',
    acceptance: 'health endpoint is green',
    layer: 'hosted',
    status,
    detail: 'detail',
  };
}

describe('summary + exit codes', () => {
  it('rolls up the four verdicts', () => {
    const summary = summarize([
      result('pass', 'a'),
      result('pass', 'b'),
      result('fail', 'c'),
      result('blocked', 'd'),
      result('skipped', 'e'),
    ]);
    expect(summary).toEqual({ total: 5, passed: 2, failed: 1, blocked: 1, skipped: 1 });
  });

  it('maps verdicts to exit codes: 0 pass, 1 fail, 2 blocked-attention', () => {
    expect(smokeExitCode(summarize([result('pass')]))).toBe(0);
    expect(smokeExitCode(summarize([result('pass'), result('skipped')]))).toBe(0);
    expect(smokeExitCode(summarize([result('pass'), result('fail')]))).toBe(1);
    expect(smokeExitCode(summarize([result('pass'), result('blocked')]))).toBe(2);
    expect(smokeExitCode(summarize([result('pass'), result('blocked')]), true)).toBe(0);
    // A failure is a failure even with blocked acknowledged.
    expect(smokeExitCode(summarize([result('fail'), result('blocked')]), true)).toBe(1);
  });
});

describe('serialization', () => {
  const report: SmokeReport = {
    label: 'unit',
    target: 'https://dogfood.test',
    profile: 'full',
    startedAt: '2026-09-22T17:00:00.000Z',
    finishedAt: '2026-09-22T17:00:05.000Z',
    durationMs: 5000,
    expectedEnvironment: 'preview',
    results: [
      result('pass', 'health.contract'),
      result('blocked', 'health.green'),
    ],
    summary: { total: 2, passed: 1, failed: 0, blocked: 1, skipped: 0 },
    health: null,
  };

  it('serializes to self-contained JSON', () => {
    const parsed = JSON.parse(reportToJson(report)) as SmokeReport;
    expect(parsed.summary.total).toBe(2);
    expect(parsed.results[0]?.id).toBe('health.contract');
    expect(parsed.results[1]?.status).toBe('blocked');
  });

  it('renders markdown grouped by acceptance bullet', () => {
    const markdown = reportToMarkdown(report);
    expect(markdown).toContain('# W078 post-deployment smoke report — unit');
    expect(markdown).toContain('## health endpoint is green');
    expect(markdown).toContain('`health.contract`');
    expect(markdown).toContain('BLOCKED');
    expect(markdown).toContain('1 passed · 0 failed · 1 blocked · 0 skipped (2 checks)');
  });
});
