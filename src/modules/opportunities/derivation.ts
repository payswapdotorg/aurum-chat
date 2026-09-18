// The DETERMINISTIC core of the opportunity engine — pure and total, no
// database (the attention module's discovery.ts and the processes module's
// detection.ts precedent). Everything here is the application's own
// computation over validated inputs: no caller and no LLM supplies any of
// these values (lock 10 — derived intelligence is application-owned).
//
//   * deriveConfidence     — the evidence-derived confidence of an
//     opportunity: an opportunity is never more certain than its weakest
//     cited evidence (the §12 chain's custody: signal → observation →
//     claim → … → opportunity is as strong as its weakest link), and each
//     additional DISTINCT piece of corroborating evidence nudges the
//     confidence up by a bounded step — capped below certainty, like the
//     processes module's findings (derived understanding never claims
//     > 0.9). The confidence snapshot stored on each version makes the
//     derivation reconstructable without re-reading the (immutable, so
//     re-readable anyway) evidence.
//
//   * evidenceFingerprintOf — the canonical identity of a SIGNAL SET: the
//     sorted, deduplicated observation and claim ids, canonical-form
//     composed. Two conversion candidates citing the same evidence have the
//     same fingerprint — that is the duplicate-detection key (a live
//     opportunity already carrying the exact signal set is a REVISION
//     target, not a second record).
//
//   * evaluateRecordability — the policy gate: which candidates become
//     opportunities under the run's snapshotted thresholds. Deterministic
//     order: currency comparability first (a value gate set in one currency
//     cannot judge a candidate valued in another), then confidence, then
//     value. The reason strings are part of the audit record.

import type {
  CandidateDisposition,
  ConversionPolicy,
  EvidenceConfidenceSnapshot,
  Money,
} from './types';

/**
 * The ceiling of derived confidence — identical to the processes module's
 * findings cap: derived intelligence never claims certainty.
 */
export const CONFIDENCE_CAP = 0.9;

/**
 * The corroboration step: how much each additional DISTINCT evidence
 * reference adds to the weakest evidence confidence.
 */
export const CORROBORATION_STEP = 0.05;

/** Rounding granularity of derived scores (the attention module's round4). */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The deterministic evidence-derived confidence:
 * `min(CONFIDENCE_CAP, weakest + CORROBORATION_STEP × (support − 1))`,
 * rounded to 4 decimals. With zero evidence the confidence is 0 (the
 * validation layer refuses that case; the function stays total).
 */
export function deriveConfidence(confidences: readonly EvidenceConfidenceSnapshot[]): number {
  if (confidences.length === 0) return 0;
  let weakest = confidences[0]!.value;
  for (const snapshot of confidences) {
    if (snapshot.value < weakest) weakest = snapshot.value;
  }
  return round4(Math.min(CONFIDENCE_CAP, weakest + CORROBORATION_STEP * (confidences.length - 1)));
}

/**
 * The deterministic signal-set fingerprint:
 * `obs:<sorted observation ids>|claims:<sorted claim ids>` over the
 * already-validated, sorted, deduplicated id lists. Order-insensitive and
 * stable across calls — the same signal set always fingerprints the same.
 */
export function evidenceFingerprintOf(
  observationIds: readonly string[],
  claimIds: readonly string[],
): string {
  return `obs:${[...observationIds].sort().join(',')}|claims:${[...claimIds].sort().join(',')}`;
}

/** The pure output of the recordability gate. */
export interface RecordabilityDecision {
  disposition: CandidateDisposition;
  /** null when eligible; the deterministic reason otherwise. */
  reason: string | null;
}

/**
 * The recordability policy gate — deterministic, in a fixed order:
 *  1. `currency_mismatch` when a value gate is set but the candidate's
 *     estimated value is in a different currency (not comparable — never
 *     silently converted, never silently passed);
 *  2. `below_threshold` when the derived confidence is below the policy's
 *     minimum;
 *  3. `below_threshold` when the value gate is set and the estimated
 *     value is below it;
 *  4. otherwise `converted` (eligible).
 */
export function evaluateRecordability(
  policy: ConversionPolicy,
  confidence: number,
  estimatedValue: Money,
): RecordabilityDecision {
  if (
    policy.minValue !== null &&
    estimatedValue.currency !== policy.minValue.currency
  ) {
    return {
      disposition: 'currency_mismatch',
      reason: `the value gate is set in ${policy.minValue.currency} but the candidate is valued in ${estimatedValue.currency} — not comparable`,
    };
  }
  if (confidence < policy.minConfidence) {
    return {
      disposition: 'below_threshold',
      reason: `derived confidence ${confidence} is below the policy minimum ${policy.minConfidence}`,
    };
  }
  if (policy.minValue !== null && estimatedValue.amount < policy.minValue.amount) {
    return {
      disposition: 'below_threshold',
      reason: `estimated value ${estimatedValue.amount} ${estimatedValue.currency} is below the policy minimum ${policy.minValue.amount} ${policy.minValue.currency}`,
    };
  }
  return { disposition: 'converted', reason: null };
}
