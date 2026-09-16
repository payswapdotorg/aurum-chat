// Pure inefficiency-detection logic (no database): the deterministic
// function from a reconstructed model (+ detection options) to the five
// finding kinds W016 names — bottlenecks, duplication, handoffs, manual
// effort and errors.
//
// Every finding is:
//   * DETERMINISTIC — the same model + options always produce the same
//     findings, in the same canonical order (kind rank, then subject);
//   * EVIDENCE-BACKED — it cites the exact occurrences (event/observation
//     ids) that justify it, most recent first, capped;
//   * CONFIDENCE-CALIBRATED BY SUPPORT — min(0.9, 0.5 + 0.1 × support):
//     one supporting instance is a half-believed observation, four are
//     near-certain; findings never reach 1.0 (lock 10 — derived
//     intelligence is never authoritative truth);
//   * ABOUT WORK, NOT WORKERS — a manual-effort finding says an activity is
//     human-performed, never that a person is slow or redundant; workforce
//     intelligence (W019) owns assessments, with alternative explanations.
//
// The five detectors:
//   * bottleneck   — an edge (directly-follows pair) with at least
//     `minEdgeInstances` instances whose average wait is ≥ the threshold:
//     the caller's explicit seconds, or (default) twice the median average
//     wait of the qualifying edges — the flow's own pace defines "slow",
//     so no magic constant decides it;
//   * duplication  — an activity type that occurs more than once within a
//     single case (rework / repeated entry); any observed repetition is
//     reported (instances and affected cases scale the confidence);
//   * handoff      — a ping-pong pattern: three consecutive steps in one
//     case where the first and third share an actor and the middle does
//     not — work leaves an actor and immediately returns, the classic
//     unnecessary-handoff signature (ARCHITECTURE.md §13 "unnecessary
//     handoffs"; a plain actor change is a necessary handoff most of the
//     time, so it is counted in stats but not flagged);
//   * manual_effort — an activity type with ≥ 2 instances whose person
//     share is ≥ the manual share threshold (default 0.5);
//   * error        — an activity type classified as an error: it ends with
//     `.failed`, `.error` or `.rejected`, or the caller declared it.

import {
  DEFAULT_ERROR_ACTIVITY_SUFFIXES,
  MAX_FINDING_EVIDENCE_REFS,
} from './validation';
import type {
  ProcessFindingKind,
  ReconstructionOptions,
} from './types';
import {
  actorKeyOf,
  occurrenceCompare,
  type ActivityOccurrence,
  type ReconstructedModel,
} from './reconstruction';

/** A detected finding before persistence (no ids/audit — the service adds those). */
export interface DetectedFinding {
  kind: ProcessFindingKind;
  subject: string;
  summary: string;
  metrics: Record<string, unknown>;
  evidenceEventIds: string[];
  evidenceObservationIds: string[];
  confidence: number;
}

/** The detection result: findings in canonical order + the derived error count. */
export interface DetectionResult {
  findings: DetectedFinding[];
  /** Occurrences of error-classified activity types (feeds stats.errorCount). */
  errorCount: number;
}

/** Kind rank for the canonical finding order (also the storage/read order). */
export const FINDING_KIND_RANK: Record<ProcessFindingKind, number> = {
  bottleneck: 1,
  duplication: 2,
  handoff: 3,
  manual_effort: 4,
  error: 5,
};

function confidenceOf(support: number): number {
  return Math.round(Math.min(0.9, 0.5 + 0.1 * support) * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** True when the activity type is error-classified (suffixes + declared set). */
export function isErrorActivity(
  activityType: string,
  declaredErrorTypes: readonly string[],
): boolean {
  if ((declaredErrorTypes as readonly string[]).includes(activityType)) return true;
  return DEFAULT_ERROR_ACTIVITY_SUFFIXES.some((suffix) => activityType.endsWith(suffix));
}

/** rounds seconds to millisecond precision (stable JSON representation). */
function secondsRounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Pick the evidence of `occurrences` for a finding: the most recent
 * `MAX_FINDING_EVIDENCE_REFS` by occurrence time (ties by evidence id),
 * split into event ids and observation ids.
 */
function pickEvidence(occurrences: ActivityOccurrence[]): {
  evidenceEventIds: string[];
  evidenceObservationIds: string[];
} {
  const ordered = [...occurrences].sort((a, b) =>
    a.occurredAtMs !== b.occurredAtMs
      ? b.occurredAtMs - a.occurredAtMs
      : a.evidenceId < b.evidenceId
        ? -1
        : a.evidenceId > b.evidenceId
          ? 1
          : 0,
  );
  const evidenceEventIds: string[] = [];
  const evidenceObservationIds: string[] = [];
  for (const occurrence of ordered) {
    if (occurrence.evidenceKind === 'event') {
      if (evidenceEventIds.length < MAX_FINDING_EVIDENCE_REFS) {
        evidenceEventIds.push(occurrence.evidenceId);
      }
    } else if (evidenceObservationIds.length < MAX_FINDING_EVIDENCE_REFS) {
      evidenceObservationIds.push(occurrence.evidenceId);
    }
    if (
      evidenceEventIds.length >= MAX_FINDING_EVIDENCE_REFS &&
      evidenceObservationIds.length >= MAX_FINDING_EVIDENCE_REFS
    ) {
      break;
    }
  }
  return { evidenceEventIds, evidenceObservationIds };
}

/** Group occurrences into per-case traces, each in canonical order (sorted copy). */
function tracesOf(occurrences: ActivityOccurrence[]): ActivityOccurrence[][] {
  const byCase = new Map<string, ActivityOccurrence[]>();
  for (const occurrence of occurrences) {
    const bucket = byCase.get(occurrence.caseId);
    if (bucket === undefined) byCase.set(occurrence.caseId, [occurrence]);
    else bucket.push(occurrence);
  }
  const traces: ActivityOccurrence[][] = [];
  for (const caseId of [...byCase.keys()].sort()) {
    traces.push([...byCase.get(caseId)!].sort(occurrenceCompare));
  }
  return traces;
}

/**
 * Detect all five finding kinds over the reconstructed model.
 *
 * `occurrences` is the same evidence the model was reconstructed from
 * (detection needs the raw occurrences for evidence refs and actor
 * patterns; the model alone does not carry them).
 */
export function detectFindings(
  model: ReconstructedModel,
  occurrences: ActivityOccurrence[],
  options: ReconstructionOptions,
): DetectionResult {
  const findings: DetectedFinding[] = [];

  // -----------------------------------------------------------------------
  // Shared indexes (one pass)
  // -----------------------------------------------------------------------

  const occurrencesByActivity = new Map<string, ActivityOccurrence[]>();
  let errorCount = 0;
  for (const occurrence of occurrences) {
    const bucket = occurrencesByActivity.get(occurrence.activityType);
    if (bucket === undefined) occurrencesByActivity.set(occurrence.activityType, [occurrence]);
    else bucket.push(occurrence);
    if (isErrorActivity(occurrence.activityType, options.errorActivityTypes)) {
      errorCount += 1;
    }
  }

  const traces = tracesOf(occurrences);

  // -----------------------------------------------------------------------
  // 1) Bottlenecks — qualifying edges with an average wait ≥ threshold
  // -----------------------------------------------------------------------

  const qualifyingEdges = model.edges.filter(
    (edge) => edge.instances >= options.minEdgeInstances,
  );
  const thresholdSeconds =
    options.bottleneckThresholdSeconds ??
    (() => {
      const medianAvg = median(qualifyingEdges.map((edge) => edge.avgWaitSeconds));
      if (medianAvg === null || medianAvg <= 0) return null;
      return 2 * medianAvg;
    })();

  if (thresholdSeconds !== null) {
    for (const edge of qualifyingEdges) {
      if (edge.avgWaitSeconds < thresholdSeconds) continue;
      // Evidence: the occurrence pairs of this edge — the wait lives
      // between the from-occurrence and the to-occurrence.
      const pairOccurrences: ActivityOccurrence[] = [];
      for (const trace of traces) {
        for (let index = 1; index < trace.length; index += 1) {
          const previous = trace[index - 1]!;
          const current = trace[index]!;
          if (
            previous.activityType === edge.fromActivity &&
            current.activityType === edge.toActivity
          ) {
            pairOccurrences.push(previous, current);
          }
        }
      }
      findings.push({
        kind: 'bottleneck',
        subject: `edge:${edge.fromActivity}->${edge.toActivity}`,
        summary: `flow ${edge.fromActivity} -> ${edge.toActivity} waits ${edge.avgWaitSeconds}s on average (threshold ${secondsRounded(thresholdSeconds)}s) across ${edge.instances} transitions`,
        metrics: {
          fromActivity: edge.fromActivity,
          toActivity: edge.toActivity,
          instances: edge.instances,
          avgWaitSeconds: edge.avgWaitSeconds,
          maxWaitSeconds: edge.maxWaitSeconds,
          thresholdSeconds: secondsRounded(thresholdSeconds),
        },
        confidence: confidenceOf(edge.instances),
        ...pickEvidence(pairOccurrences),
      });
    }
  }

  // -----------------------------------------------------------------------
  // 2) Duplication — activity types repeated within a single case
  // -----------------------------------------------------------------------

  const duplicationByActivity = new Map<
    string,
    { cases: number; extra: number; evidence: ActivityOccurrence[] }
  >();
  for (const trace of traces) {
    const byActivity = new Map<string, ActivityOccurrence[]>();
    for (const occurrence of trace) {
      const bucket = byActivity.get(occurrence.activityType);
      if (bucket === undefined) byActivity.set(occurrence.activityType, [occurrence]);
      else bucket.push(occurrence);
    }
    for (const [activityType, bucket] of byActivity) {
      if (bucket.length <= 1) continue;
      const entry = duplicationByActivity.get(activityType);
      if (entry === undefined) {
        duplicationByActivity.set(activityType, {
          cases: 1,
          extra: bucket.length - 1,
          evidence: [...bucket],
        });
      } else {
        entry.cases += 1;
        entry.extra += bucket.length - 1;
        entry.evidence.push(...bucket);
      }
    }
  }
  for (const activityType of [...duplicationByActivity.keys()].sort()) {
    const entry = duplicationByActivity.get(activityType)!;
    findings.push({
      kind: 'duplication',
      subject: `step:${activityType}`,
      summary: `activity '${activityType}' repeats within a single case in ${entry.cases} case(s) — ${entry.extra} extra occurrence(s) beyond the first (rework or duplicated entry)`,
      metrics: {
        activityType,
        casesWithRepetition: entry.cases,
        extraOccurrences: entry.extra,
      },
      confidence: confidenceOf(entry.cases),
      ...pickEvidence(entry.evidence),
    });
  }

  // -----------------------------------------------------------------------
  // 3) Handoffs — ping-pong actor patterns on consecutive steps (A → B → A)
  // -----------------------------------------------------------------------

  const pingPongByTriple = new Map<
    string,
    {
      fromActivity: string;
      midActivity: string;
      toActivity: string;
      instances: number;
      evidence: ActivityOccurrence[];
      exampleFromActor: string;
      exampleMidActor: string;
    }
  >();
  for (const trace of traces) {
    if (trace.length < 3) continue;
    for (let index = 0; index + 2 < trace.length; index += 1) {
      const first = trace[index]!;
      const middle = trace[index + 1]!;
      const last = trace[index + 2]!;
      const firstActor = actorKeyOf(first);
      const midActor = actorKeyOf(middle);
      if (firstActor === midActor) continue; // no handoff at all
      if (firstActor !== actorKeyOf(last)) continue; // not a bounce-back
      const key = `${first.activityType}\u0000${middle.activityType}\u0000${last.activityType}`;
      const entry = pingPongByTriple.get(key);
      if (entry === undefined) {
        pingPongByTriple.set(key, {
          fromActivity: first.activityType,
          midActivity: middle.activityType,
          toActivity: last.activityType,
          instances: 1,
          evidence: [first, middle, last],
          exampleFromActor: firstActor,
          exampleMidActor: midActor,
        });
      } else {
        entry.instances += 1;
        entry.evidence.push(first, middle, last);
      }
    }
  }
  const pingPongs = [...pingPongByTriple.values()].sort((a, b) =>
    a.fromActivity !== b.fromActivity
      ? a.fromActivity.localeCompare(b.fromActivity)
      : a.midActivity !== b.midActivity
        ? a.midActivity.localeCompare(b.midActivity)
        : a.toActivity.localeCompare(b.toActivity),
  );
  for (const entry of pingPongs) {
    findings.push({
      kind: 'handoff',
      subject: `ping-pong:${entry.fromActivity}->${entry.midActivity}->${entry.toActivity}`,
      summary: `work bounces back: ${entry.fromActivity} -> ${entry.midActivity} (different actor) -> ${entry.toActivity} returns to the original actor in ${entry.instances} case segment(s) — an unnecessary handoff candidate`,
      metrics: {
        fromActivity: entry.fromActivity,
        midActivity: entry.midActivity,
        toActivity: entry.toActivity,
        instances: entry.instances,
        fromActor: entry.exampleFromActor,
        midActor: entry.exampleMidActor,
      },
      confidence: confidenceOf(entry.instances),
      ...pickEvidence(entry.evidence),
    });
  }

  // -----------------------------------------------------------------------
  // 4) Manual effort — steps predominantly performed by humans
  // -----------------------------------------------------------------------

  for (const step of model.steps) {
    if (step.instances < 2) continue;
    const personInstances = step.actorCounts.person;
    if (personInstances === 0) continue;
    const manualShare = personInstances / step.instances;
    if (manualShare < options.manualShareThreshold) continue;
    findings.push({
      kind: 'manual_effort',
      subject: `step:${step.activityType}`,
      summary: `activity '${step.activityType}' is ${Math.round(manualShare * 100)}% human-performed (${personInstances} of ${step.instances} occurrences; threshold ${Math.round(options.manualShareThreshold * 100)}%) — manual-effort candidate`,
      metrics: {
        activityType: step.activityType,
        instances: step.instances,
        personInstances,
        manualShare: Math.round(manualShare * 1000) / 1000,
        manualShareThreshold: options.manualShareThreshold,
      },
      confidence: confidenceOf(personInstances),
      ...pickEvidence(occurrencesByActivity.get(step.activityType) ?? []),
    });
  }

  // -----------------------------------------------------------------------
  // 5) Errors — occurrences of error-classified activity types
  // -----------------------------------------------------------------------

  for (const step of model.steps) {
    if (!isErrorActivity(step.activityType, options.errorActivityTypes)) continue;
    const evidence = occurrencesByActivity.get(step.activityType) ?? [];
    const affectedCases = new Set(evidence.map((occurrence) => occurrence.caseId)).size;
    findings.push({
      kind: 'error',
      subject: `step:${step.activityType}`,
      summary: `activity '${step.activityType}' is error-classified with ${step.instances} occurrence(s) across ${affectedCases} case(s)`,
      metrics: {
        activityType: step.activityType,
        instances: step.instances,
        affectedCases,
      },
      confidence: confidenceOf(step.instances),
      ...pickEvidence(evidence),
    });
  }

  // -----------------------------------------------------------------------
  // Canonical order: kind rank, then subject (the storage/read order)
  // -----------------------------------------------------------------------

  findings.sort((a, b) =>
    FINDING_KIND_RANK[a.kind] !== FINDING_KIND_RANK[b.kind]
      ? FINDING_KIND_RANK[a.kind] - FINDING_KIND_RANK[b.kind]
      : a.subject < b.subject
        ? -1
        : a.subject > b.subject
          ? 1
          : 0,
  );

  return { findings, errorCount };
}
