// The PURE fingerprint derivation of the context module (W134).
//
// `deriveFingerprint` turns (identity seed + task + observable context
// input) into a ContextFingerprint with ZERO fabrication: every dimension
// of the output comes from the input, and an absent dimension stays ABSENT
// (null) — the NULL-SIGNAL LAW. There is deliberately no default season,
// no assumed workload, no guessed staffing: the fingerprint records what is
// known, so downstream strategy selection (info-strategy W134) and
// organization selection (the Lab, W135) can condition on MEASURED context
// instead of hardcoded industry priors (the contextual rule, binding).
//
// `summarizeFingerprint` renders the human-readable summary: a headline
// composed only from KNOWN dimensions and the known/absent dimension
// report — the null signal made visible.
//
// THE CONTEXTUAL RULE (binding, restated for this file): nothing here
// interprets dimension VALUES. 'spring' is not "construction season", a
// novice-heavy crew is not "needs junior-friendly sources" — deriving
// meaning from context is the strategy layer's HYPOTHESIS to test with
// outcome learning, never this module's job. This file only copies,
// orders and formats what it was told.

import type {
  ContextDimensionKey,
  ContextFingerprint,
  ContextFingerprintSummary,
  ContextObservationsInput,
  ContextTask,
} from './types';
import { CONTEXT_DIMENSIONS } from './types';

/** Maximum headline length before ellipsis (bound the log/UI surface). */
export const MAX_HEADLINE_CHARS = 240;

/**
 * The system-minted identity parts of a fingerprint — everything the PURE
 * derivation cannot invent: the caller (service) supplies id, tenant,
 * goal, task, evidence refs and derivation time; the derivation adds only
 * the observed dimensions.
 */
export interface FingerprintDerivationSeed {
  readonly fingerprintId: string;
  readonly tenantId: string;
  readonly goalId: string;
  readonly task: ContextTask | null;
  readonly derivedFrom: readonly string[];
  /** ISO 8601 — service-clock derivation time. */
  readonly derivedAt: string;
}

/**
 * Derive a ContextFingerprint. Pure: same seed + observations →
 * deep-equal fingerprint; the inputs are never mutated; absent dimensions
 * are absent (null), never faked.
 */
export function deriveFingerprint(
  seed: FingerprintDerivationSeed,
  observations: ContextObservationsInput | null | undefined,
): ContextFingerprint {
  const observed = observations ?? {};
  const signals = observed.additionalSignals ?? {};
  return {
    fingerprintId: seed.fingerprintId,
    tenantId: seed.tenantId,
    goalId: seed.goalId,
    task: seed.task,
    season: observed.season ?? null,
    duration: observed.duration ?? null,
    staffing: observed.staffing ?? null,
    workload: observed.workload ?? null,
    capabilities: observed.capabilities ?? null,
    environment: observed.environment ?? null,
    constraints: observed.constraints ?? null,
    evidenceFreshness: observed.evidenceFreshness ?? null,
    additionalSignals: { ...signals },
    derivedFrom: [...seed.derivedFrom],
    derivedAt: seed.derivedAt,
  };
}

/** Which of the eight typed dimensions this fingerprint actually knows. */
export function knownDimensionKeys(fingerprint: ContextFingerprint): ContextDimensionKey[] {
  const known: ContextDimensionKey[] = [];
  for (const key of CONTEXT_DIMENSIONS) {
    if (fingerprint[key] !== null) known.push(key);
  }
  return known;
}

/** Which of the eight typed dimensions are honestly ABSENT (the null signal). */
export function absentDimensionKeys(fingerprint: ContextFingerprint): ContextDimensionKey[] {
  const known = new Set(knownDimensionKeys(fingerprint));
  return CONTEXT_DIMENSIONS.filter((key) => !known.has(key));
}

/**
 * The staffing phrase of a headline: the dominant experience level when the
 * mix is known ('novice-heavy crew'), else the headcount ('5-person crew').
 * Deterministic — ties break by the canonical novice/intermediate/expert
 * order (first of the co-dominant levels wins).
 */
export function staffingHeadlinePhrase(staffing: NonNullable<ContextFingerprint['staffing']>): string | null {
  const mix = staffing.experienceMix;
  if (mix !== null) {
    const levels = ['novice', 'intermediate', 'expert'] as const;
    let dominant: (typeof levels)[number] | null = null;
    let dominantCount = 0;
    for (const level of levels) {
      const count = mix[level] ?? 0;
      if (count > dominantCount) {
        dominant = level;
        dominantCount = count;
      }
    }
    if (dominant !== null) return `${dominant}-heavy crew`;
  }
  if (staffing.headcount !== null) return `${staffing.headcount}-person crew`;
  return null;
}

/**
 * The duration phrase of a headline: the human-readable span when known
 * ('~6 weeks'), else the duration class ('short' / 'medium' / 'long' /
 * 'ongoing').
 */
export function durationHeadlinePhrase(
  duration: NonNullable<ContextFingerprint['duration']>,
): string | null {
  return duration.estimatedSpan ?? duration.durationClass;
}

/**
 * The constraint phrase of a headline: the risk tolerance, when stated.
 */
export function constraintHeadlinePhrase(
  constraints: NonNullable<ContextFingerprint['constraints']>,
): string | null {
  return constraints.riskTolerance;
}

/**
 * Render the human-readable summary of a fingerprint: a headline composed
 * ONLY from known dimensions (canonical order, '·'-separated) plus the
 * known/absent dimension report. With nothing known the headline states
 * exactly that — the null signal stays visible, never papered over.
 */
export function summarizeFingerprint(fingerprint: ContextFingerprint): ContextFingerprintSummary {
  const parts: string[] = [];
  if (fingerprint.season !== null) parts.push(fingerprint.season.window);
  if (fingerprint.task !== null && fingerprint.task.kind !== null) {
    parts.push(fingerprint.task.kind);
  }
  if (fingerprint.duration !== null) {
    const phrase = durationHeadlinePhrase(fingerprint.duration);
    if (phrase !== null) parts.push(phrase);
  }
  if (fingerprint.staffing !== null) {
    const phrase = staffingHeadlinePhrase(fingerprint.staffing);
    if (phrase !== null) parts.push(phrase);
  }
  if (fingerprint.workload !== null) parts.push(`${fingerprint.workload} workload`);
  if (fingerprint.constraints !== null) {
    const phrase = constraintHeadlinePhrase(fingerprint.constraints);
    if (phrase !== null) parts.push(phrase);
  }
  if (fingerprint.environment !== null && fingerprint.environment.factors.length > 0) {
    parts.push(fingerprint.environment.factors[0]!);
  }
  const signalCount = Object.keys(fingerprint.additionalSignals).length;
  if (signalCount > 0) parts.push(`+${signalCount} signal${signalCount === 1 ? '' : 's'}`);

  let headline: string;
  if (parts.length === 0) {
    headline = 'no known context dimensions';
  } else {
    headline = parts.join(' · ');
    if (headline.length > MAX_HEADLINE_CHARS) {
      headline = `${headline.slice(0, MAX_HEADLINE_CHARS - 1)}…`;
    }
  }

  return {
    fingerprintId: fingerprint.fingerprintId,
    headline,
    knownDimensions: knownDimensionKeys(fingerprint),
    absentDimensions: absentDimensionKeys(fingerprint),
  };
}
