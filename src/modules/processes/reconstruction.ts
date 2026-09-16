// Pure process-reconstruction logic (no database, no contract reads — the
// service feeds it activity occurrences gathered through the events and
// observations contracts, then stores the result).
//
// The reconstruction is DETERMINISTIC: the same occurrences always produce
// the same model (stable orderings, stable tie-breaks), so a stored version
// is exactly what re-reading the same immutable evidence reproduces.
//
// Model (process-mining vocabulary over the evidence):
//   * a CASE is one run of the process — an event correlation flow (W003
//     guarantees the correlation id groups every event of one logical flow)
//     or an observation grouped by a payload case key; an observation
//     without a resolvable case key is its own single-activity case;
//   * an ACTIVITY is a canonical classification (event `type` / observation
//     `kind`);
//   * a STEP aggregates every occurrence of one activity type;
//   * an EDGE (directly-follows relation) counts consecutive activity pairs
//     within a case, with the occurrence-time distance between the pair
//     (the WAIT — events and observations are instantaneous records, so a
//     step's residency time is unmeasurable; the wait between activities
//     is the honest, measurable flow time);
//   * a VARIANT is one observed activity sequence.
//
// Case ordering: by occurrence time; ties break events before observations
// (the happening precedes the encounter with evidence of it), then by event
// sequence (the per-tenant commit order), then by evidence id — fully
// deterministic even for identical timestamps.

import { ProcessesError } from './errors';
import type {
  ActivityActorKind,
  ProcessEdge,
  ProcessStats,
  ProcessStep,
  ProcessVariant,
} from './types';

/** Where one occurrence came from. */
export type EvidenceKind = 'event' | 'observation';

/**
 * One activity occurrence — the unified atom both evidence surfaces map to.
 * Minted by the service from an Event or an Observation; never persisted
 * (the evidence ids are persisted, on findings).
 */
export interface ActivityOccurrence {
  caseId: string;
  activityType: string;
  actorKind: ActivityActorKind;
  actorId: string | null;
  actorLabel: string | null;
  /** Epoch milliseconds (occurrence time — event occurredAt / observation observedAt). */
  occurredAtMs: number;
  /** ISO 8601 occurrence timestamp (kept for stable first/last reporting). */
  occurredAtIso: string;
  evidenceKind: EvidenceKind;
  /** The evidence record id (event id / observation id). */
  evidenceId: string;
  /** Events only: the per-tenant sequence number (commit order tie-break). */
  eventSequence: number | null;
}

/** Model size caps (a broader scope is refused, never silently truncated). */
export const MAX_MODEL_ACTIVITY_TYPES = 200;
export const MAX_MODEL_EDGES = 1000;
/** Variants stored per version (top N by instances; the true count is kept). */
export const MAX_VARIANTS_STORED = 25;

/**
 * The actor identity of one occurrence: kind + id, or kind + label, or kind
 * alone (both events and observations guarantee at least one of id/label —
 * provenance must be traceable — so this never degrades further).
 */
export function actorKeyOf(occurrence: ActivityOccurrence): string {
  if (occurrence.actorId !== null) {
    return `${occurrence.actorKind}:${occurrence.actorId}`;
  }
  if (occurrence.actorLabel !== null) {
    return `${occurrence.actorKind}:${occurrence.actorLabel}`;
  }
  return `${occurrence.actorKind}:<unattributed>`;
}

/** rounds seconds to millisecond precision (stable JSON representation). */
function secondsRounded(ms: number): number {
  return Math.round((ms / 1000) * 1000) / 1000;
}

/** Deterministic occurrence order within a case (see file header). */
export function occurrenceCompare(a: ActivityOccurrence, b: ActivityOccurrence): number {
  if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
  const kindRankA = a.evidenceKind === 'event' ? 0 : 1;
  const kindRankB = b.evidenceKind === 'event' ? 0 : 1;
  if (kindRankA !== kindRankB) return kindRankA - kindRankB;
  if (a.evidenceKind === 'event' && b.evidenceKind === 'event') {
    const seqA = a.eventSequence ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.eventSequence ?? Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
  }
  return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0;
}

/** The completed reconstruction of one process version. */
export interface ReconstructedModel {
  steps: ProcessStep[];
  edges: ProcessEdge[];
  variants: ProcessVariant[];
  stats: ProcessStats;
}

/** Per-case working state. */
interface CaseAccumulator {
  occurrences: ActivityOccurrence[];
}

/** Per-step aggregation state. */
interface StepAccumulator {
  activityType: string;
  instances: number;
  cases: Set<string>;
  actorCounts: Record<ActivityActorKind, number>;
  firstOccurredAtIso: string;
  lastOccurredAtIso: string;
}

/** Per-edge aggregation state. */
interface EdgeAccumulator {
  fromActivity: string;
  toActivity: string;
  instances: number;
  totalWaitMs: number;
  maxWaitMs: number;
}

/**
 * Reconstruct the process model from activity occurrences.
 *
 * Throws `reconstruction_too_large` when the model would exceed its size
 * caps (too many distinct activity types or edges): the remedy is a narrower
 * evidence scope, never a silently truncated model. Variant storage is
 * capped to the top `MAX_VARIANTS_STORED` by instances (a summary), while
 * `stats.variantCount` keeps the true count.
 */
export function reconstructProcessModel(
  occurrences: ActivityOccurrence[],
  observationWindowTruncated: boolean,
): ReconstructedModel {
  // --- cases ---
  const cases = new Map<string, CaseAccumulator>();
  for (const occurrence of occurrences) {
    const bucket = cases.get(occurrence.caseId);
    if (bucket === undefined) {
      cases.set(occurrence.caseId, { occurrences: [occurrence] });
    } else {
      bucket.occurrences.push(occurrence);
    }
  }
  // Deterministic case processing order (stable variant aggregation).
  const caseIds = [...cases.keys()].sort();

  // --- steps / edges / variants / stats accumulators ---
  const steps = new Map<string, StepAccumulator>();
  const edges = new Map<string, EdgeAccumulator>();
  const variants = new Map<string, { sequence: string[]; instances: number }>();

  let handoffCount = 0;
  const caseDurationsMs: number[] = [];

  for (const caseId of caseIds) {
    const sorted = [...cases.get(caseId)!.occurrences].sort(occurrenceCompare);

    // steps
    const stepCasesSeen = new Set<string>();
    for (const occurrence of sorted) {
      let step = steps.get(occurrence.activityType);
      if (step === undefined) {
        const actorCounts = {
          person: 0,
          agent: 0,
          system: 0,
          external: 0,
          source: 0,
        } as Record<ActivityActorKind, number>;
        step = {
          activityType: occurrence.activityType,
          instances: 0,
          cases: new Set<string>(),
          actorCounts,
          firstOccurredAtIso: occurrence.occurredAtIso,
          lastOccurredAtIso: occurrence.occurredAtIso,
        };
        steps.set(occurrence.activityType, step);
      }
      step.instances += 1;
      step.actorCounts[occurrence.actorKind] += 1;
      step.firstOccurredAtIso =
        step.firstOccurredAtIso <= occurrence.occurredAtIso
          ? step.firstOccurredAtIso
          : occurrence.occurredAtIso;
      step.lastOccurredAtIso =
        step.lastOccurredAtIso >= occurrence.occurredAtIso
          ? step.lastOccurredAtIso
          : occurrence.occurredAtIso;
      if (!stepCasesSeen.has(occurrence.activityType)) {
        stepCasesSeen.add(occurrence.activityType);
        step.cases.add(caseId);
      }
    }

    // edges (+ handoff count) and the variant sequence
    const sequence: string[] = [];
    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index]!;
      sequence.push(current.activityType);
      if (index === 0) continue;
      const previous = sorted[index - 1]!;

      const edgeKey = `${previous.activityType}\u0000${current.activityType}`;
      let edge = edges.get(edgeKey);
      if (edge === undefined) {
        edge = {
          fromActivity: previous.activityType,
          toActivity: current.activityType,
          instances: 0,
          totalWaitMs: 0,
          maxWaitMs: 0,
        };
        edges.set(edgeKey, edge);
      }
      edge.instances += 1;
      const waitMs = current.occurredAtMs - previous.occurredAtMs;
      edge.totalWaitMs += waitMs;
      edge.maxWaitMs = Math.max(edge.maxWaitMs, waitMs);

      if (actorKeyOf(previous) !== actorKeyOf(current)) handoffCount += 1;
    }

    // variant (single-activity cases are variants too — a real observation)
    const variantKey = JSON.stringify(sequence);
    const variant = variants.get(variantKey);
    if (variant === undefined) {
      variants.set(variantKey, { sequence, instances: 1 });
    } else {
      variant.instances += 1;
    }

    // case duration (population: cases with ≥ 2 occurrences)
    if (sorted.length >= 2) {
      caseDurationsMs.push(
        sorted[sorted.length - 1]!.occurredAtMs - sorted[0]!.occurredAtMs,
      );
    }
  }

  // --- size guards (refuse, never truncate: a partial model would be
  // misleading intelligence) ---
  if (steps.size > MAX_MODEL_ACTIVITY_TYPES) {
    throw new ProcessesError(
      'reconstruction_too_large',
      `the evidence in scope produced ${steps.size} distinct activity types (cap ${MAX_MODEL_ACTIVITY_TYPES}) — narrow the event types, observation kinds or occurrence window`,
    );
  }
  if (edges.size > MAX_MODEL_EDGES) {
    throw new ProcessesError(
      'reconstruction_too_large',
      `the evidence in scope produced ${edges.size} distinct flow edges (cap ${MAX_MODEL_EDGES}) — narrow the event types, observation kinds or occurrence window`,
    );
  }

  // --- mapped steps (activity type asc — stable) ---
  const mappedSteps: ProcessStep[] = [...steps.values()]
    .sort((a, b) => a.activityType.localeCompare(b.activityType))
    .map((step) => ({
      activityType: step.activityType,
      instances: step.instances,
      cases: step.cases.size,
      actorCounts: { ...step.actorCounts },
      manualShare: step.instances === 0 ? 0 : step.actorCounts.person / step.instances,
      firstOccurredAt: step.firstOccurredAtIso,
      lastOccurredAt: step.lastOccurredAtIso,
    }));

  // --- mapped edges (from, then to — stable) ---
  const mappedEdges: ProcessEdge[] = [...edges.values()]
    .sort((a, b) =>
      a.fromActivity === b.fromActivity
        ? a.toActivity.localeCompare(b.toActivity)
        : a.fromActivity.localeCompare(b.fromActivity),
    )
    .map((edge) => ({
      fromActivity: edge.fromActivity,
      toActivity: edge.toActivity,
      instances: edge.instances,
      avgWaitSeconds: secondsRounded(edge.totalWaitMs / edge.instances),
      maxWaitSeconds: secondsRounded(edge.maxWaitMs),
    }));

  // --- stored variants: top N by instances, ties by sequence (stable) ---
  const storedVariants: ProcessVariant[] = [...variants.values()]
    .sort((a, b) =>
      b.instances !== a.instances
        ? b.instances - a.instances
        : JSON.stringify(a.sequence) < JSON.stringify(b.sequence)
          ? -1
          : 1,
    )
    .slice(0, MAX_VARIANTS_STORED)
    .map((variant) => ({ sequence: [...variant.sequence], instances: variant.instances }));

  // --- stats ---
  const occurrenceCount = occurrences.length;
  let eventCount = 0;
  let observationCount = 0;
  let personCount = 0;
  for (const occurrence of occurrences) {
    if (occurrence.evidenceKind === 'event') eventCount += 1;
    else observationCount += 1;
    if (occurrence.actorKind === 'person') personCount += 1;
  }

  const avgCaseDurationSeconds =
    caseDurationsMs.length === 0
      ? null
      : secondsRounded(
          caseDurationsMs.reduce((sum, duration) => sum + duration, 0) / caseDurationsMs.length,
        );
  const minCaseDurationSeconds =
    caseDurationsMs.length === 0 ? null : secondsRounded(Math.min(...caseDurationsMs));
  const maxCaseDurationSeconds =
    caseDurationsMs.length === 0 ? null : secondsRounded(Math.max(...caseDurationsMs));

  const stats: ProcessStats = {
    caseCount: cases.size,
    occurrenceCount,
    eventCount,
    observationCount,
    distinctActivityTypes: steps.size,
    distinctEdges: edges.size,
    variantCount: variants.size,
    variantsStored: storedVariants.length,
    manualShare: occurrenceCount === 0 ? 0 : personCount / occurrenceCount,
    handoffCount,
    errorCount: 0, // detection.ts owns error classification; set by the caller
    avgCaseDurationSeconds,
    minCaseDurationSeconds,
    maxCaseDurationSeconds,
    observationWindowTruncated,
  };

  return { steps: mappedSteps, edges: mappedEdges, variants: storedVariants, stats };
}
