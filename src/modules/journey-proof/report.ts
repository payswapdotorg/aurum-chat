// The proof-report assembly (W070). The execution suites push
// JourneyProofResult entries as they walk journeys and run audits; the
// final gate test asserts the report is COMPLETE (every acceptance
// bullet proven, nothing failed). The report type lives in types.ts;
// this file owns the evaluation.

import type { JourneyProofReport, JourneyProofResult, JourneyId, PageLinkProof } from './types';
import { JOURNEY_IDS } from './matrix';

/** Is every matrix entry covered by at least one PASSING result, with no failures? */
export function reportComplete(report: JourneyProofReport): {
  complete: boolean;
  missing: JourneyId[];
  failed: JourneyId[];
} {
  const passed = new Set<JourneyId>();
  const failed = new Set<JourneyId>();
  for (const result of report.results) {
    if (result.passed) passed.add(result.journeyId);
    else failed.add(result.journeyId);
  }
  const missing: JourneyId[] = [];
  for (const id of JOURNEY_IDS) {
    if (!passed.has(id) && !failed.has(id)) missing.push(id);
  }
  return { complete: missing.length === 0 && failed.size === 0, missing, failed: [...failed] };
}

/** A compact human summary line of a report (evidence output). */
export function reportSummary(report: JourneyProofReport): string {
  const passed = report.results.filter((result) => result.passed).length;
  const { complete, missing, failed } = reportComplete(report);
  const parts = [
    `journeys proven: ${passed}/${report.results.length} results`,
    `pages audited: ${report.pagesAudited.length}`,
    `capabilities covered: ${report.capabilitiesCovered.length}`,
  ];
  if (complete) parts.push('COMPLETE');
  else {
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
    if (failed.length > 0) parts.push(`failed: ${failed.join(', ')}`);
  }
  return parts.join(' · ');
}

/** Record one passing journey result. */
export function passingResult(
  journeyId: JourneyId,
  viewport: JourneyProofResult['viewport'],
  actor: JourneyProofResult['actor'],
  detail: string,
): JourneyProofResult {
  return { journeyId, viewport, actor, passed: true, failedStep: null, detail };
}

/** Record one failing journey result. */
export function failingResult(
  journeyId: JourneyId,
  viewport: JourneyProofResult['viewport'],
  actor: JourneyProofResult['actor'],
  failedStep: string,
  detail: string,
): JourneyProofResult {
  return { journeyId, viewport, actor, passed: false, failedStep, detail };
}

/**
 * Evaluate the no-dead-end obligation over collected page proofs: every
 * rendered page must (a) exist in the route catalog, (b) carry at least
 * one onward in-app link, and (c) emit no link to a route that does not
 * exist. Returns the violations (empty = the acceptance holds).
 */
export function deadEndViolations(proofs: readonly PageLinkProof[]): string[] {
  const violations: string[] = [];
  for (const proof of proofs) {
    for (const broken of proof.broken) {
      violations.push(`${proof.route}: broken link → ${broken.resolved} (“${broken.accessibleName}”)`);
    }
    if (proof.onward.length === 0) {
      violations.push(`${proof.route}: no onward in-app link (dead end)`);
    }
  }
  return violations;
}
