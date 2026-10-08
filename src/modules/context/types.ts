// ============================================================================
// context — TL-frozen shared type vocabulary (W124b)
//
// FROZEN CONTRACT SURFACE enabling W134 (Goal/Context-conditioned Information
// Strategy) and W135 (Contextual Organizational Lab) to share one context
// representation. Derived from the operator's Contextual Lab rule and
// spec/MASTER-ROADMAP-2026-10-04.md W134/W135 definitions.
//
// THE CONTEXTUAL RULE (binding): do NOT hardcode one organization or one
// information strategy per industry or task. The Lab and the strategy layer
// evaluate goal + task + CURRENT CONTEXT, where context may include season/
// time window, project duration, staffing, staff experience, workload,
// capability availability, tools, environment, budget, SLA, quality, risk,
// verification requirements, external conditions and evidence freshness.
// These are HYPOTHESES FOR EXPERIMENTATION AND OUTCOME LEARNING, not fixed
// rules.
//
// Ownership law:
//   * W134 owns src/modules/context/** implementation (fingerprint
//     derivation from goal + task + observable context) and may extend these
//     types additively.
//   * W135 (and every other module) imports ONLY through
//     '@/modules/context/contract'.
//   * Semantic changes require TL integration approval.
// ============================================================================

// ----------------------------------------------------------------------------
// Context dimensions — the axes a fingerprint may carry. Every field is
// OPTIONAL: a fingerprint records what is known, not a fixed schema of
// required answers. Unknown dimensions are absent, never faked.
// ----------------------------------------------------------------------------

/** Season / time window context (e.g. 'spring', 'Q4', 'monsoon-season'). */
export interface SeasonalContext {
  readonly window: string;
  readonly note: string | null;
}

/** Project duration class (the same goal short vs long may organize differently). */
export type DurationClass = 'short' | 'medium' | 'long' | 'ongoing';

export interface DurationContext {
  readonly durationClass: DurationClass;
  readonly estimatedSpan: string | null; // human-readable, e.g. '~6 weeks'
}

/** Staffing composition. */
export interface StaffingContext {
  readonly headcount: number | null;
  /** Mix of experience levels present, e.g. { novice: 5, expert: 1 }. */
  readonly experienceMix: Readonly<Record<'novice' | 'intermediate' | 'expert', number>> | null;
  readonly note: string | null;
}

/** Workload pressure. */
export type WorkloadLevel = 'light' | 'normal' | 'heavy' | 'overloaded';

/** Capability availability (tools/skills present or absent). */
export interface CapabilityAvailabilityContext {
  readonly available: readonly string[];
  readonly missing: readonly string[];
}

/** Environment / external conditions (site, weather, regulatory, market...). */
export interface EnvironmentContext {
  readonly factors: readonly string[];
}

/** Budget / SLA / quality / risk / verification constraints. */
export interface ConstraintContext {
  readonly budgetNote: string | null;
  readonly slaNote: string | null;
  readonly qualityTarget: string | null;
  readonly riskTolerance: 'risk-averse' | 'balanced' | 'risk-tolerant' | null;
  readonly verificationRequirements: readonly string[];
}

/** Evidence freshness expectations relevant to the goal. */
export interface EvidenceFreshnessContext {
  readonly maxEvidenceAge: string | null; // human-readable, e.g. '48h'
  readonly criticalFreshSurfaces: readonly string[];
}

// ----------------------------------------------------------------------------
// ContextFingerprint — the derived, comparable representation of the context
// a goal/task runs in. Fingerprints are HYPOTHESES INPUTS: the Lab and the
// strategy layer may select different organizations/strategies for the same
// subject when the measured context differs.
// ----------------------------------------------------------------------------

export interface ContextFingerprint {
  readonly fingerprintId: string; // system-minted
  readonly tenantId: string;
  /** The goal this context was fingerprinted for (opaque goals-module ref). */
  readonly goalId: string;
  /**
   * The task the fingerprint was derived for (W134 additive field). Absent
   * (null) when the task was unknown at derivation time — never faked.
   */
  readonly task: ContextTask | null;
  readonly season: SeasonalContext | null;
  readonly duration: DurationContext | null;
  readonly staffing: StaffingContext | null;
  readonly workload: WorkloadLevel | null;
  readonly capabilities: CapabilityAvailabilityContext | null;
  readonly environment: EnvironmentContext | null;
  readonly constraints: ConstraintContext | null;
  readonly evidenceFreshness: EvidenceFreshnessContext | null;
  /** Free-form context signals not covered by the typed dimensions. */
  readonly additionalSignals: Readonly<Record<string, string>>;
  /** Which dimensions were actually known at derivation time. */
  readonly derivedFrom: readonly string[]; // evidence refs, opaque
  readonly derivedAt: string; // ISO
}

/** Human-readable summary of a fingerprint (for UI + logging). */
export interface ContextFingerprintSummary {
  readonly fingerprintId: string;
  readonly headline: string; // e.g. 'spring · 6-week build · novice-heavy crew'
  readonly knownDimensions: readonly string[];
  readonly absentDimensions: readonly string[];
}

// ----------------------------------------------------------------------------
// W134 additive extension — fingerprint DERIVATION over the frozen vocabulary
// ----------------------------------------------------------------------------
//
// Everything below this marker is the W134 implementation surface added ON
// TOP of the frozen stage above. The frozen types and their semantics are
// unchanged; the derivation layer only ADDS input/read shapes for turning a
// goal + task + observable context input into a stored ContextFingerprint.

/**
 * The eight typed context dimensions of a fingerprint, in canonical order —
 * the vocabulary `knownDimensions` / `absentDimensions` report against (the
 * null signal made visible: every key is either known or honestly absent).
 * `task` and `additionalSignals` are deliberately NOT in this list: the task
 * is the derivation subject's work descriptor, not a context dimension, and
 * additionalSignals is the free-form catch-all (a non-empty map is surfaced
 * in the headline as '+N signals').
 */
export const CONTEXT_DIMENSIONS = [
  'season',
  'duration',
  'staffing',
  'workload',
  'capabilities',
  'environment',
  'constraints',
  'evidenceFreshness',
] as const;

export type ContextDimensionKey = (typeof CONTEXT_DIMENSIONS)[number];

/**
 * The task descriptor a fingerprint was derived for. The architecture
 * conditions strategy on goal + task + CURRENT CONTEXT ("not only a task
 * type"), so the derivation records the task it was told about — absent
 * (null) when unknown, never faked. Both fields are optional; at least one
 * must be present when the task itself is known.
 */
export interface ContextTask {
  readonly title: string | null;
  readonly kind: string | null;
}

/** Input shape of `ContextTask` (either field, at least one). */
export interface ContextTaskInput {
  title?: string | null;
  kind?: string | null;
}

/**
 * The observable context input of a derivation — every dimension OPTIONAL.
 * THE NULL-SIGNAL LAW: an absent dimension is ABSENT in the derived
 * fingerprint, never defaulted or guessed; the fingerprint records what is
 * known. Callers assert only what their evidence actually shows.
 */
export interface ContextObservationsInput {
  season?: SeasonalContext | null;
  duration?: DurationContext | null;
  staffing?: StaffingContext | null;
  workload?: WorkloadLevel | null;
  capabilities?: CapabilityAvailabilityContext | null;
  environment?: EnvironmentContext | null;
  constraints?: ConstraintContext | null;
  evidenceFreshness?: EvidenceFreshnessContext | null;
  additionalSignals?: Readonly<Record<string, string>>;
}

/** Input shape of `deriveFingerprint`. */
export interface DeriveFingerprintInput {
  /** The goal this context is fingerprinted for (validated ACTIVE, W008). */
  goalId: string;
  /** What the goal's work is, when known. */
  task?: ContextTaskInput | null;
  /** The observable context (every dimension optional — null-signal law). */
  observations?: ContextObservationsInput;
  /** Opaque evidence refs the derivation is based on. */
  derivedFrom?: string[];
}

/** Query shape of `getFingerprint`. */
export interface GetFingerprintQuery {
  fingerprintId: string;
}

/** Query shape of `listFingerprints`. */
export interface ListFingerprintsQuery {
  /** Only fingerprints derived for this goal. */
  goalId?: string;
  limit?: number;
}
