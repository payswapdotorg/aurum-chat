// Pure scoring logic of the suppliers module (no database) — the
// deterministic function from a supplier's current scorecard to the derived
// intelligence: the per-dimension view, the weighted overall and the
// ranking (W020's first half). Never persisted: recomputed on every read,
// so the derived layer can never drift from the records it summarizes
// (lock 10 — derived intelligence, never authoritative truth).
//
// Documented invariants, all tested:
//  * The eight dimensions are the work item's verbatim list, in canonical
//    work-item order (price, quality, reliability, capacity, compliance,
//    geography, switching_cost, alternatives).
//  * An unscored dimension (null) is EXCLUDED from the overall's numerator
//    AND denominator — missing data never drags an average down and never
//    silently masquerades as a failing grade; `completeness` keeps the
//    thinness visible (scoredDimensions / 8).
//  * A zero weight excludes a SCORED dimension from the overall the same
//    way (the caller explicitly does not care about it for this read).
//  * Weights are read-time parameters only; the default is 1 per dimension,
//    so the default overall is the plain arithmetic mean of the scored
//    dimensions. Nothing about a weighting is ever persisted on a
//    scorecard (the scorecard records the assessment, not a policy).
//  * `overall` is null when no dimension carries BOTH a score and a
//    positive weight (nothing to aggregate). Stored scorecard versions
//    always score ≥ 1 dimension (CHECK), so under default weights the
//    overall of a stored snapshot is never null.
//  * The ranking is deterministic: overall DESC, then name ASC, then id
//    ASC; ranks are 1-based and gapless over the RETURNED entries (entries
//    with a null overall are skipped before ranking — they cannot be
//    ranked).

import { DIMENSION_FIELD, SCORE_DIMENSIONS } from './validation';
import type {
  DimensionScore,
  ScoreDimension,
  ScoreWeightSet,
  ScoringSummary,
  SupplierDimensionScores,
  SupplierKind,
  SupplierRanking,
  SupplierRecordStatus,
} from './types';

/** The default weight of every dimension: 1 (the overall becomes the plain mean of the scored dimensions). */
export const DEFAULT_SCORE_WEIGHTS: Record<ScoreDimension, number> = {
  price: 1,
  quality: 1,
  reliability: 1,
  capacity: 1,
  compliance: 1,
  geography: 1,
  switching_cost: 1,
  alternatives: 1,
};

/** The effective weights: the read-time set over the defaults (omitted → 1). */
export function effectiveWeights(weights?: ScoreWeightSet): Record<ScoreDimension, number> {
  const effective: Record<ScoreDimension, number> = { ...DEFAULT_SCORE_WEIGHTS };
  if (weights === undefined || weights === null) return effective;
  for (const dimension of SCORE_DIMENSIONS) {
    const weight = weights[dimension];
    if (weight !== undefined) effective[dimension] = weight;
  }
  return effective;
}

/**
 * The derived scoring summary of one scorecard snapshot: the eight
 * dimensions in canonical order (score + effective weight), the weighted
 * overall over the dimensions that carry both a score and a positive
 * weight, and the completeness of the snapshot.
 */
export function computeScoring(
  scores: SupplierDimensionScores,
  weights?: ScoreWeightSet,
): ScoringSummary {
  const effective = effectiveWeights(weights);
  const dimensions: DimensionScore[] = SCORE_DIMENSIONS.map((dimension) => ({
    dimension,
    score: scores[DIMENSION_FIELD[dimension]],
    weight: effective[dimension],
  }));

  let numerator = 0;
  let denominator = 0;
  let scored = 0;
  for (const entry of dimensions) {
    if (entry.score === null) continue;
    scored += 1;
    if (entry.weight > 0) {
      numerator += entry.score * entry.weight;
      denominator += entry.weight;
    }
  }

  return {
    dimensions,
    overall: denominator > 0 ? numerator / denominator : null,
    scoredDimensions: scored,
    totalDimensions: SCORE_DIMENSIONS.length,
    completeness: scored / SCORE_DIMENSIONS.length,
  };
}

/** The derived overall alone (the weighted mean; null when there is nothing to aggregate). */
export function computeOverall(
  scores: SupplierDimensionScores,
  weights?: ScoreWeightSet,
): number | null {
  return computeScoring(scores, weights).overall;
}

/**
 * Deterministic ranking comparison: overall DESC, then name ASC, then id
 * ASC. A null overall sorts AFTER every non-null overall (defensive — the
 * ranking skips null-overall entries before comparing; kept honest for
 * direct callers too).
 */
export function rankingCompare(
  a: { overall: number | null; name: string; id: string },
  b: { overall: number | null; name: string; id: string },
): number {
  if (a.overall === null && b.overall === null) {
    return a.name !== b.name
      ? a.name < b.name
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
  }
  if (a.overall === null) return 1;
  if (b.overall === null) return -1;
  if (a.overall !== b.overall) return a.overall > b.overall ? -1 : 1;
  return a.name !== b.name
    ? a.name < b.name
      ? -1
      : 1
    : a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0;
}

/** One ranking input record: the lightweight supplier + scorecard references and the current scores. */
export interface RankingRecord {
  supplier: {
    id: string;
    tenantId: string;
    name: string;
    kind: SupplierKind;
    status: SupplierRecordStatus;
  };
  scorecard: { id: string; version: number; assessedAt: string };
  scores: SupplierDimensionScores;
}

/**
 * Builds the derived ranking over the given current records: entries whose
 * overall is null under the effective weights are skipped (they cannot be
 * ranked); the rest sort by overall DESC, name ASC, id ASC and receive
 * gapless 1-based ranks. Never persisted.
 */
export function buildRanking(
  records: RankingRecord[],
  weights?: ScoreWeightSet,
): SupplierRanking[] {
  const entries = records
    .map((record) => ({ record, scoring: computeScoring(record.scores, weights) }))
    .filter((entry) => entry.scoring.overall !== null)
    .sort((a, b) =>
      rankingCompare(
        {
          overall: a.scoring.overall,
          name: a.record.supplier.name,
          id: a.record.supplier.id,
        },
        {
          overall: b.scoring.overall,
          name: b.record.supplier.name,
          id: b.record.supplier.id,
        },
      ),
    );
  return entries.map((entry, index) => ({
    rank: index + 1,
    supplier: entry.record.supplier,
    scorecard: entry.record.scorecard,
    scoring: entry.scoring,
  }));
}
