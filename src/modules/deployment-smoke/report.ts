// Smoke report assembly (pure): summary, exit code, serialization.
//
// The exit-code contract (what `bun run smoke:dogfood` returns):
//   0 — every executed check passed (skipped checks do not fail a run);
//   1 — at least one FAIL (the target violated its contract);
//   2 — no failures, but BLOCKED checks remain (a documented external
//       precondition is missing — operator attention; `--allow-blocked`
//       acknowledges a known gap and returns 0 instead).
//
// Markdown rendering groups results by acceptance bullet so the report
// reads like the W078 acceptance list it proves.

import { W078_ACCEPTANCE_BULLETS } from './catalog';
import type { SmokeCheckResult, SmokeReport, SmokeSummary } from './types';

/** Roll up results into the summary counters. */
export function summarize(results: readonly SmokeCheckResult[]): SmokeSummary {
  const summary: SmokeSummary = { total: results.length, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const result of results) {
    if (result.status === 'pass') summary.passed += 1;
    else if (result.status === 'fail') summary.failed += 1;
    else if (result.status === 'blocked') summary.blocked += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/** The process exit code for a summary (see file header). */
export function smokeExitCode(summary: SmokeSummary, allowBlocked = false): number {
  if (summary.failed > 0) return 1;
  if (summary.blocked > 0 && !allowBlocked) return 2;
  return 0;
}

/** Serialize a report to JSON (stable field order, human-readable). */
export function reportToJson(report: SmokeReport): string {
  return JSON.stringify(report, null, 2);
}

function statusMark(status: SmokeCheckResult['status']): string {
  if (status === 'pass') return 'PASS';
  if (status === 'fail') return 'FAIL';
  if (status === 'blocked') return 'BLOCKED';
  return 'SKIP';
}

/** Render the human-readable markdown report. */
export function reportToMarkdown(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push(`# W078 post-deployment smoke report — ${report.label}`);
  lines.push('');
  lines.push(`- **Target:** ${report.target}`);
  lines.push(`- **Profile:** ${report.profile}`);
  lines.push(
    `- **Run:** ${report.startedAt} → ${report.finishedAt} (${(report.durationMs / 1000).toFixed(1)}s)`,
  );
  lines.push(
    `- **Expected environment:** ${report.expectedEnvironment ?? '(not configured)'}`,
  );
  if (report.health !== null) {
    lines.push(
      `- **Observed health:** ${report.health.status} (HTTP ${report.health.httpStatus}, env '${report.health.environment ?? '?'}', db ${report.health.dbBackend ?? '?'})`,
    );
  }
  const s = report.summary;
  lines.push(
    `- **Summary:** ${s.passed} passed · ${s.failed} failed · ${s.blocked} blocked · ${s.skipped} skipped (${s.total} checks)`,
  );
  lines.push('');
  for (const bullet of W078_ACCEPTANCE_BULLETS) {
    const results = report.results.filter((result) => result.acceptance === bullet);
    if (results.length === 0) continue;
    lines.push(`## ${bullet}`);
    lines.push('');
    lines.push('| Verdict | Check | Observation |');
    lines.push('| --- | --- | --- |');
    for (const result of results) {
      const detail = result.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${statusMark(result.status)} | \`${result.id}\` | ${detail} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
