// Intelligence discovery (W061) — the proactive findings composition.
//
// THE WORK ITEM'S PROACTIVE CORE: "proactive findings enter chat and Today",
// "severity/urgency is legible", "'why this matters' and 'what Aurum needs
// next' are always visible". A PROACTIVE finding is intelligence Aurum
// produced WITHOUT being asked:
//
//   * goal-gap discoveries (W051 attention) — a material gap between an
//     active goal and its evidence promoted an unknown + a learning mission;
//   * loop analysis findings (W013 cognition traces) — risk, opportunity and
//     capability-gap statements the risk-opportunity-capability-analysis
//     stage recorded, each with its evidence and affected goals;
//   * retained contradictions (W007 epistemics) — two pieces of evidence
//     that disagree and are both kept (lock 12).
//
// Everything is DERIVED intelligence read through module contracts only
// (lock 31/32/34): nothing is persisted here, no finding is invented, and
// every finding carries the two mandatory reading aids — whyThisMatters
// (the consequence of the gap / the finding statement / the conflict) and
// whatNext (the mission underway, the confidence gap being closed, or the
// decision the finding waits on).
//
// Every family read degrades QUIETLY and independently (the chat composer's
// safeRead discipline): a failing family yields fewer findings plus a
// degraded note — the briefing never pretends missing data is empty data.

import type { TenantContext } from '@/infra/tenant';
import { now } from '@/infra/clock';
import {
  getDiscoveryRun,
  listDiscoveryRuns,
} from '@/modules/attention/contract';
import type {
  DiscoveryCandidate,
  DiscoveryRun,
} from '@/modules/attention/contract';
import type { CandidateUrgency } from '@/modules/attention/contract';
import { listContradictions } from '@/modules/epistemics/contract';
import type { Contradiction } from '@/modules/epistemics/contract';
import { collectTraceFindings } from '../../chat/lib/answers';
import type { TraceFindingLite } from '../../chat/lib/answers';
import type { PillTone } from '../../lib/states';

// ---------------------------------------------------------------------------
// The finding model
// ---------------------------------------------------------------------------

/** Where a proactive finding came from (the discovery feed's provenance). */
export type FindingSource = 'discovery' | 'analysis' | 'contradiction';

/**
 * A proactive finding's kind — the domain vocabulary it derives from. The
 * names deliberately mirror the domain concepts (unknown W007, the W013
 * analysis finding kinds, the W007 contradiction) so nothing is re-invented.
 */
export type FindingKind =
  | 'unknown'
  | 'risk'
  | 'opportunity'
  | 'capability-gap'
  | 'contradiction';

/**
 * Severity/urgency, made LEGIBLE (the acceptance): a canonical urgency band
 * plus the derived pill tone. Color never carries meaning alone — every
 * rendering pairs the tone with the urgency label.
 */
export interface FindingSeverity {
  /** The urgency band the finding carries (null = not banded). */
  urgency: CandidateUrgency | null;
  /** The pill tone for the urgency band. */
  tone: PillTone;
  /** Human copy for the band (e.g. 'Critical urgency'). */
  label: string;
}

/** One proactive finding — the unit of Today's briefing and the chat card. */
export interface ProactiveFinding {
  /** The domain record id (unknown id, execution id, contradiction id). */
  id: string;
  kind: FindingKind;
  source: FindingSource;
  /** What Aurum found, in one line. */
  title: string;
  /** WHY THIS MATTERS — the consequence of the gap / the finding itself. */
  whyThisMatters: string;
  /** WHAT AURUM NEEDS NEXT — the underway or required next move. */
  whatNext: string;
  severity: FindingSeverity;
  /** Decision impact in [0,1] when the derivation carries one (ADR-0017). */
  impact: number | null;
  /** Expected information value in [0,1] when the derivation carries one. */
  informationValue: number | null;
  /** The learning mission the finding launched/waits on, when there is one. */
  missionId: string | null;
  /** ISO 8601 — when the finding was recorded. */
  detectedAt: string;
  /** The intelligence workflow page the finding drills into. */
  href: string;
  /** The observations underpinning the finding (the evidence trail). */
  evidenceObservationIds: string[];
  /** The goals the finding affects (the chain's anchor, when known). */
  affectedGoalIds: string[];
}

// ---------------------------------------------------------------------------
// Severity mapping (pure — the unit-test seam)
// ---------------------------------------------------------------------------

/** The urgency bands in severity order (critical first). */
export const SEVERITY_ORDER: readonly CandidateUrgency[] = [
  'critical',
  'high',
  'medium',
  'low',
];

/** Map an urgency band to a legible pill tone (never color alone). */
export function urgencyTone(urgency: CandidateUrgency | null): PillTone {
  switch (urgency) {
    case 'critical':
      return 'error';
    case 'high':
      return 'warning';
    case 'medium':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Human copy for an urgency band (the pill text). */
export function urgencyLabel(urgency: CandidateUrgency | null): string {
  if (urgency === null) return 'Unbanded';
  switch (urgency) {
    case 'critical':
      return 'Critical urgency';
    case 'high':
      return 'High urgency';
    case 'medium':
      return 'Medium urgency';
    case 'low':
      return 'Low urgency';
  }
}

/** The severity of a finding from its urgency band (null = unbanded). */
export function findingSeverity(urgency: CandidateUrgency | null): FindingSeverity {
  return { urgency, tone: urgencyTone(urgency), label: urgencyLabel(urgency) };
}

/** Severity rank for ordering (critical first; unbanded last). */
export function severityRank(urgency: CandidateUrgency | null): number {
  if (urgency === null) return SEVERITY_ORDER.length;
  return SEVERITY_ORDER.indexOf(urgency);
}

/**
 * Order findings the way a briefing reads: severity band first, then
 * newest first within a band (the attention feed discipline).
 */
export function sortFindings(findings: ProactiveFinding[]): ProactiveFinding[] {
  return [...findings].sort((left, right) => {
    const bySeverity = severityRank(left.severity.urgency) - severityRank(right.severity.urgency);
    if (bySeverity !== 0) return bySeverity;
    return right.detectedAt.localeCompare(left.detectedAt);
  });
}

/** Render a [0,1] score as a percentage line, or null when absent. */
export function percentLine(value: number | null, label: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${label} ${(Math.round(value * 100)).toFixed(0)}%`;
}

/** Which chat card kind a finding renders as (the W060 seven-kind set). */
export type FindingChatCardKind = 'unknown' | 'risk' | 'opportunity';

/** Map a finding kind onto the chat card vocabulary. */
export function findingChatCardKind(kind: FindingKind): FindingChatCardKind {
  switch (kind) {
    case 'unknown':
      return 'unknown';
    case 'opportunity':
      return 'opportunity';
    default:
      return 'risk';
  }
}

// ---------------------------------------------------------------------------
// Family derivations (pure mappings from domain records to findings)
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The confidence-gap line of a promoted discovery candidate. */
function confidenceGapLine(candidate: DiscoveryCandidate): string {
  const from = `${(candidate.currentConfidence * 100).toFixed(0)}%`;
  const to = `${(candidate.requiredConfidence * 100).toFixed(0)}%`;
  return `Close the confidence gap ${from} → ${to}`;
}

/** One promoted goal-gap candidate as a proactive finding. */
export function discoveryFinding(
  candidate: DiscoveryCandidate,
  detectedAt: string,
): ProactiveFinding {
  const unknownId = candidate.epistemicsUnknownId;
  return {
    id: unknownId ?? candidate.id,
    kind: 'unknown',
    source: 'discovery',
    title: clip(candidate.missingKnowledge, 160),
    whyThisMatters: clip(candidate.consequence, 400),
    whatNext:
      candidate.missionId === null
        ? 'No learning mission is active for this gap yet — the next step is a mission.'
        : `${confidenceGapLine(candidate)} — the learning mission is underway.`,
    severity: findingSeverity(candidate.urgency),
    impact: candidate.decisionImpact,
    informationValue: candidate.informationValue,
    missionId: candidate.missionId,
    detectedAt,
    href: unknownId === null ? '/intelligence' : `/intelligence/unknowns/${unknownId}`,
    evidenceObservationIds: [],
    affectedGoalIds: candidate.affectedGoals.map((goal) => goal.goalId),
  };
}

/** One loop analysis finding (from a W013 trace) as a proactive finding.
 *
 * `seq` disambiguates multiple findings of the same kind on one trace
 * (the loop records up to 16 per execution): the finding's identity is
 * `executionId:kind:seq`, so two risk findings on one trace stay distinct
 * — in the feed's keys AND in the delivery digest (a newly added finding
 * changes the digest, not just the count).
 */
export function analysisFinding(finding: TraceFindingLite, seq = 0): ProactiveFinding {
  const isOpportunity = finding.kind === 'opportunity';
  return {
    id: `${finding.executionId}:${finding.kind}:${seq}`,
    kind: finding.kind,
    source: 'analysis',
    title: clip(finding.statement, 160),
    whyThisMatters: clip(finding.statement, 400),
    whatNext: isOpportunity
      ? 'Weigh the opportunity against affected goals — turn it into a recommendation when it clears policy.'
      : 'Address the affected goal\'s exposure — the evidence trail below is the starting point.',
    severity: findingSeverity(null),
    impact: null,
    informationValue: null,
    missionId: null,
    detectedAt: finding.detectedAt,
    href:
      finding.affectedGoalIds[0] !== undefined
        ? `/intelligence/goals/${finding.affectedGoalIds[0]!}`
        : '/intelligence',
    evidenceObservationIds: [...finding.evidenceObservationIds],
    affectedGoalIds: [...finding.affectedGoalIds],
  };
}

/** One retained contradiction as a proactive finding. */
export function contradictionFinding(contradiction: Contradiction): ProactiveFinding {
  return {
    id: contradiction.id,
    kind: 'contradiction',
    source: 'contradiction',
    title: clip(contradiction.note, 160),
    whyThisMatters: `${clip(contradiction.note, 300)} — two pieces of evidence disagree, and both are retained.`,
    whatNext: 'Weigh the conflicting evidence: resolve the contradiction or gather a deciding observation.',
    severity: findingSeverity('high'),
    impact: null,
    informationValue: null,
    missionId: null,
    detectedAt: contradiction.detectedAt,
    href: '/intelligence',
    evidenceObservationIds: [],
    affectedGoalIds: [],
  };
}

// ---------------------------------------------------------------------------
// The composition (contract reads, quietly degrading per family)
// ---------------------------------------------------------------------------

/** How many recent discovery runs the briefing scans. */
export const DISCOVERY_SCAN_RUNS = 5;

/** How many recent executions the briefing scans for analysis findings. */
export const FINDING_SCAN_EXECUTIONS = 12;

/** The briefing's finding cap (a Today view, not an archive). */
export const MAX_FINDINGS = 8;

/** The composed briefing feed (findings + the honest degradation note). */
export interface ProactiveFindingsResult {
  findings: ProactiveFinding[];
  /** Families whose contract read failed (rendered explicitly, never hidden). */
  degraded: string[];
  generatedAt: string;
}

async function safeFamily<T>(
  family: string,
  degraded: string[],
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

/**
 * Compose the tenant's proactive findings — what Aurum found on its own,
 * severity-ordered, why-this-matters and what-next attached to every item.
 * Derived intelligence only (lock 34): nothing is written.
 */
export async function buildProactiveFindings(
  ctx: TenantContext,
): Promise<ProactiveFindingsResult> {
  const degraded: string[] = [];
  const findings: ProactiveFinding[] = [];

  // Family 1 — promoted goal-gap candidates (the unprompted unknowns, W051).
  const runs = await safeFamily('discovery', degraded, () =>
    listDiscoveryRuns(ctx, { limit: DISCOVERY_SCAN_RUNS }),
  );
  if (runs !== null) {
    for (const summary of runs) {
      const run: DiscoveryRun | null = await safeFamily('discovery', degraded, () =>
        getDiscoveryRun(ctx, { runId: summary.id }),
      );
      if (run === null) continue;
      for (const candidate of run.candidates) {
        if (candidate.disposition !== 'promoted') continue;
        findings.push(discoveryFinding(candidate, candidate.recordedAt));
      }
    }
  }

  // Family 2 — the loop's analysis findings (W013 traces).
  const traceFindings = await safeFamily('analysis', degraded, () =>
    collectTraceFindings(ctx, FINDING_SCAN_EXECUTIONS),
  );
  if (traceFindings !== null) {
    // Multiple findings of one kind can share a trace — sequence them so
    // every finding keeps a distinct identity (keys + digest).
    const sequence = new Map<string, number>();
    for (const finding of traceFindings) {
      const key = `${finding.executionId}:${finding.kind}`;
      const seq = sequence.get(key) ?? 0;
      sequence.set(key, seq + 1);
      findings.push(analysisFinding(finding, seq));
    }
  }

  // Family 3 — retained contradictions (W007, lock 12).
  const contradictions = await safeFamily('contradictions', degraded, () =>
    listContradictions(ctx, { status: 'open', limit: 5 }),
  );
  if (contradictions !== null) {
    for (const contradiction of contradictions) {
      findings.push(contradictionFinding(contradiction));
    }
  }

  return {
    findings: sortFindings(findings).slice(0, MAX_FINDINGS),
    degraded: [...new Set(degraded)],
    generatedAt: now().toISOString(),
  };
}
