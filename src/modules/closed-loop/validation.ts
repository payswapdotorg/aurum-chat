// Validation + the deterministic loop math of the closed-loop module.
//
// Two responsibilities, both pure (unit-testable without a database):
//
//   1. INPUT VALIDATION — the class-specific deviation shapes (the
//      acceptance-clause-1 law made mechanical): a reality deviation
//      input MUST carry expected/observed and MUST NOT carry
//      severity/snapshotId; a knowledge deviation input MUST carry
//      severity and MUST NOT carry expected/observed/planId. Excess
//      keys of the OTHER class are rejected explicitly, so the two
//      classes can never be recorded through each other's shape — the
//      structural non-interchangeability the unit suite locks.
//
//   2. THE DETERMINISTIC ADJUSTMENT + METRIC MATH (the
//      acceptance-clause-3 machinery): the single definition of how
//      recorded ranking signals adjust a base score, how the
//      calibration error is measured, how gap closure and recurrence
//      are derived, and how the improvement verdict is decided —
//      exported for verification and consumed by the service (never a
//      re-derivation; the outcomes/learning discipline).
//
// The policy-authority law (acceptance clause 2) lives here too: the
// signal-target vocabulary is exactly the three ranking input channels,
// and any policy/settings/authority-shaped target is refused with the
// dedicated typed code before anything is recorded.

import type { TenantContext } from '@/infra/tenant';
import { ClosedLoopError } from './errors';
import type {
  KnowledgeDeviationInput,
  LoopCycleStatus,
  RankingSignal,
  RankingTargetSeam,
  RealityDeviationInput,
  SignalBasis,
  SignalDirection,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (frozen; the single home of every union's runtime form)
// ---------------------------------------------------------------------------

export const REALITY_DEVIATION_SOURCE_KINDS = [
  'execution_run',
  'fabric_lease',
  'org_calibration',
  'goal_metric',
] as const;

export const KNOWLEDGE_DEVIATION_SOURCE_KINDS = [
  'coverage_gap',
  'learning_update',
] as const;

export const RANKING_TARGET_SEAMS = [
  'info_strategy',
  'org_lab',
  'company_model',
] as const;

/**
 * The policy/settings/authority-shaped words a signal target may NEVER
 * address — the typed-refusal vocabulary of the policy-authority law
 * (acceptance clause 2). These are not ranking input channels; a signal
 * aimed at any of them is refused with `policy_mutation_refused`.
 */
export const POLICY_SURFACE_WORDS = [
  'action_policy',
  'authority',
  'authority_policy',
  'policy',
  'settings',
  'actions',
] as const;

export const SIGNAL_DIRECTIONS = ['raise', 'lower'] as const;

export const SIGNAL_BASES = ['reality_deviation', 'knowledge_deviation'] as const;

export const LOOP_CYCLE_STATUSES = ['open', 'closed'] as const;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const MAX_DEVIATIONS_PER_CLASS = 32;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_REF_LENGTH = 256;

/**
 * The deterministic per-signal adjustment step: one full-magnitude
 * signal moves the base score by a quarter of the remaining scale —
 * bounded convergence, never a jump to an extreme.
 */
export const SIGNAL_STEP = 0.25;

/** The score granularity of every frozen metric (the W053 precedent). */
export const SCORE_DECIMALS = 4;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isRealityDeviationSourceKind(value: unknown): value is RealityDeviationInput['sourceKind'] {
  return (
    typeof value === 'string' &&
    (REALITY_DEVIATION_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isKnowledgeDeviationSourceKind(value: unknown): value is KnowledgeDeviationInput['sourceKind'] {
  return (
    typeof value === 'string' &&
    (KNOWLEDGE_DEVIATION_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isRankingTargetSeam(value: unknown): value is RankingTargetSeam {
  return (
    typeof value === 'string' &&
    (RANKING_TARGET_SEAMS as readonly string[]).includes(value)
  );
}

export function isPolicySurfaceWord(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (POLICY_SURFACE_WORDS as readonly string[]).includes(value)
  );
}

export function isSignalDirection(value: unknown): value is SignalDirection {
  return typeof value === 'string' && (SIGNAL_DIRECTIONS as readonly string[]).includes(value);
}

export function isSignalBasis(value: unknown): value is SignalBasis {
  return typeof value === 'string' && (SIGNAL_BASES as readonly string[]).includes(value);
}

export function isLoopCycleStatus(value: unknown): value is LoopCycleStatus {
  return typeof value === 'string' && (LOOP_CYCLE_STATUSES as readonly string[]).includes(value);
}

export function assertClosedLoopTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.tenantId !== 'string' ||
    ctx.tenantId.length === 0 ||
    typeof ctx.principalId !== 'string' ||
    ctx.principalId.length === 0 ||
    !Array.isArray(ctx.authority)
  ) {
    throw new ClosedLoopError(
      'invalid_context',
      'an explicit TenantContext with tenant and principal is required',
    );
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rounds to 4 decimals — the score granularity of every loop metric. */
export function round4(value: number): number {
  return Math.round(value * 10 ** SCORE_DECIMALS) / 10 ** SCORE_DECIMALS;
}

function boundedScore(value: unknown, field: string, code: 'invalid_cycle_input' | 'invalid_deviation_input'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ClosedLoopError(code, `${field} must be a finite number in [0,1]`);
  }
  return round4(value);
}

function nonEmptyString(value: unknown, field: string, max: number, code: ClosedLoopError['code']): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new ClosedLoopError(code, `${field} must be a string of 1..${max} characters`);
  }
  return value;
}

function optionalUuid(value: unknown, field: string, code: ClosedLoopError['code']): string | null {
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) {
    throw new ClosedLoopError(code, `${field} must be a uuid when present`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The deviation-class input validators (the structural distinction)
// ---------------------------------------------------------------------------

export interface ValidatedRealityDeviation {
  sourceKind: RealityDeviationInput['sourceKind'];
  sourceRef: string;
  planRef: string | null;
  expected: number;
  observed: number;
  note: string;
}

export interface ValidatedKnowledgeDeviation {
  sourceKind: KnowledgeDeviationInput['sourceKind'];
  sourceRef: string;
  snapshotRef: string | null;
  severity: number;
  note: string;
}

/**
 * Validates ONE reality deviation. `goalId` is the cycle's subject goal
 * (a goal_metric deviation must measure the loop's own goal). Rejects
 * the KNOWLEDGE-class fields (`severity`, `snapshotId`) explicitly —
 * the classes are structurally non-interchangeable.
 */
export function validateRealityDeviationInput(
  input: unknown,
  goalId: string,
): ValidatedRealityDeviation {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_deviation_input', 'a reality deviation must be an object');
  }
  // The class lock: knowledge-class keys are refused here.
  if ('severity' in input || 'snapshotId' in input) {
    throw new ClosedLoopError(
      'invalid_deviation_input',
      'a reality deviation carries expected/observed, never severity/snapshotId — the knowledge-deviation shape belongs to the other class (W140 acceptance clause 1)',
    );
  }
  if (!isRealityDeviationSourceKind(input.sourceKind)) {
    throw new ClosedLoopError(
      'invalid_deviation_input',
      `sourceKind must be one of ${REALITY_DEVIATION_SOURCE_KINDS.join(', ')}`,
    );
  }
  const sourceRef = nonEmptyString(input.sourceRef, 'sourceRef', MAX_REF_LENGTH, 'invalid_deviation_input');
  const expected = boundedScore(input.expected, 'expected', 'invalid_deviation_input');
  const observed = boundedScore(input.observed, 'observed', 'invalid_deviation_input');
  const note = nonEmptyString(input.note, 'note', MAX_NOTE_LENGTH, 'invalid_deviation_input');

  let planRef: string | null = null;
  if (input.sourceKind === 'execution_run') {
    planRef = optionalUuid(input.planId, 'planId', 'invalid_deviation_input');
    if (planRef === null) {
      throw new ClosedLoopError(
        'invalid_deviation_input',
        'an execution_run deviation requires the planId that owns the run (run lookups are plan-scoped)',
      );
    }
  } else if (input.planId !== undefined && input.planId !== null) {
    throw new ClosedLoopError(
      'invalid_deviation_input',
      'planId is legal only on execution_run deviations',
    );
  }
  if (input.sourceKind === 'goal_metric' && sourceRef !== goalId) {
    throw new ClosedLoopError(
      'invalid_deviation_input',
      'a goal_metric deviation must cite the cycle goal itself (sourceRef must equal goalId)',
    );
  }

  return { sourceKind: input.sourceKind, sourceRef, planRef, expected, observed, note };
}

/**
 * Validates ONE knowledge deviation. Rejects the REALITY-class fields
 * (`expected`, `observed`, `planId`) explicitly — the classes are
 * structurally non-interchangeable.
 */
export function validateKnowledgeDeviationInput(input: unknown): ValidatedKnowledgeDeviation {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_deviation_input', 'a knowledge deviation must be an object');
  }
  // The class lock: reality-class keys are refused here.
  if ('expected' in input || 'observed' in input || 'planId' in input) {
    throw new ClosedLoopError(
      'invalid_deviation_input',
      'a knowledge deviation carries severity, never expected/observed/planId — the reality-deviation shape belongs to the other class (W140 acceptance clause 1)',
    );
  }
  if (!isKnowledgeDeviationSourceKind(input.sourceKind)) {
    throw new ClosedLoopError(
      'invalid_deviation_input',
      `sourceKind must be one of ${KNOWLEDGE_DEVIATION_SOURCE_KINDS.join(', ')}`,
    );
  }
  const sourceRef = nonEmptyString(input.sourceRef, 'sourceRef', MAX_REF_LENGTH, 'invalid_deviation_input');
  const note = nonEmptyString(input.note, 'note', MAX_NOTE_LENGTH, 'invalid_deviation_input');

  const severityRaw = input.severity;
  if (
    typeof severityRaw !== 'number' ||
    !Number.isFinite(severityRaw) ||
    severityRaw <= 0 ||
    severityRaw > 1
  ) {
    throw new ClosedLoopError('invalid_deviation_input', 'severity must be a finite number in (0,1]');
  }

  let snapshotRef: string | null = null;
  if (input.sourceKind === 'coverage_gap') {
    snapshotRef = optionalUuid(input.snapshotId, 'snapshotId', 'invalid_deviation_input');
    if (snapshotRef === null) {
      throw new ClosedLoopError(
        'invalid_deviation_input',
        'a coverage_gap deviation requires the snapshotId that detected the gap',
      );
    }
  } else if (input.snapshotId !== undefined && input.snapshotId !== null) {
    throw new ClosedLoopError(
      'invalid_deviation_input',
      'snapshotId is legal only on coverage_gap deviations',
    );
  }

  return { sourceKind: input.sourceKind, sourceRef, snapshotRef, severity: round4(severityRaw), note };
}

// ---------------------------------------------------------------------------
// Operation input validators
// ---------------------------------------------------------------------------

export interface ValidatedRecordLoopCycleInput {
  goalId: string;
  predictedScore: number;
  realityDeviations: ValidatedRealityDeviation[];
  knowledgeDeviations: ValidatedKnowledgeDeviation[];
  rationale: string;
}

export function validateRecordLoopCycleInput(input: unknown): ValidatedRecordLoopCycleInput {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_cycle_input', 'recordLoopCycle input must be an object');
  }
  const goalId = input.goalId;
  if (!isUuid(goalId)) {
    throw new ClosedLoopError('invalid_cycle_input', 'goalId must be a uuid');
  }
  const predictedScore = boundedScore(input.predictedScore, 'predictedScore', 'invalid_cycle_input');
  const rationale = nonEmptyString(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, 'invalid_cycle_input');

  const realityRaw = input.realityDeviations ?? [];
  if (!Array.isArray(realityRaw) || realityRaw.length > MAX_DEVIATIONS_PER_CLASS) {
    throw new ClosedLoopError(
      'invalid_cycle_input',
      `realityDeviations must be an array of at most ${MAX_DEVIATIONS_PER_CLASS} entries`,
    );
  }
  const knowledgeRaw = input.knowledgeDeviations ?? [];
  if (!Array.isArray(knowledgeRaw) || knowledgeRaw.length > MAX_DEVIATIONS_PER_CLASS) {
    throw new ClosedLoopError(
      'invalid_cycle_input',
      `knowledgeDeviations must be an array of at most ${MAX_DEVIATIONS_PER_CLASS} entries`,
    );
  }

  return {
    goalId,
    predictedScore,
    realityDeviations: realityRaw.map((one) => validateRealityDeviationInput(one, goalId)),
    knowledgeDeviations: knowledgeRaw.map((one) => validateKnowledgeDeviationInput(one)),
    rationale,
  };
}

export interface ValidatedApplyRankingSignalInput {
  cycleId: string;
  targetSeam: RankingTargetSeam;
  targetRef: string;
  direction: SignalDirection;
  magnitude: number;
  basis: SignalBasis;
  rationale: string;
}

export function validateApplyRankingSignalInput(input: unknown): ValidatedApplyRankingSignalInput {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_signal_input', 'applyRankingSignal input must be an object');
  }
  if (!isUuid(input.cycleId)) {
    throw new ClosedLoopError('invalid_signal_input', 'cycleId must be a uuid');
  }
  // THE POLICY-AUTHORITY REFUSAL (acceptance clause 2, typed + test-locked):
  // a policy/settings/authority-shaped target is refused before anything
  // is recorded — the loop can never mutate or override policy.
  if (isPolicySurfaceWord(input.targetSeam)) {
    throw new ClosedLoopError(
      'policy_mutation_refused',
      `a ranking signal may never address '${String(input.targetSeam)}' — policy and settings surfaces are authoritative over learned signals (W140 acceptance clause 2)`,
    );
  }
  if (!isRankingTargetSeam(input.targetSeam)) {
    throw new ClosedLoopError(
      'invalid_signal_input',
      `targetSeam must be one of ${RANKING_TARGET_SEAMS.join(', ')}`,
    );
  }
  const targetRef = nonEmptyString(input.targetRef, 'targetRef', MAX_REF_LENGTH, 'invalid_signal_input');
  if (!isSignalDirection(input.direction)) {
    throw new ClosedLoopError('invalid_signal_input', `direction must be one of ${SIGNAL_DIRECTIONS.join(', ')}`);
  }
  const magnitude = input.magnitude;
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude <= 0 || magnitude > 1) {
    throw new ClosedLoopError('invalid_signal_input', 'magnitude must be a finite number in (0,1]');
  }
  if (!isSignalBasis(input.basis)) {
    throw new ClosedLoopError('invalid_signal_input', `basis must be one of ${SIGNAL_BASES.join(', ')}`);
  }
  const rationale = nonEmptyString(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, 'invalid_signal_input');
  return {
    cycleId: input.cycleId,
    targetSeam: input.targetSeam,
    targetRef,
    direction: input.direction,
    magnitude: round4(magnitude),
    basis: input.basis,
    rationale,
  };
}

export interface ValidatedCloseLoopCycleInput {
  cycleId: string;
  note: string;
}

export function validateCloseLoopCycleInput(input: unknown): ValidatedCloseLoopCycleInput {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_close_input', 'closeLoopCycle input must be an object');
  }
  if (!isUuid(input.cycleId)) {
    throw new ClosedLoopError('invalid_close_input', 'cycleId must be a uuid');
  }
  const note = nonEmptyString(input.note, 'note', MAX_NOTE_LENGTH, 'invalid_close_input');
  return { cycleId: input.cycleId, note };
}

// ---------------------------------------------------------------------------
// Query validators
// ---------------------------------------------------------------------------

function validateLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new ClosedLoopError('invalid_query', `limit must be an integer in 1..${MAX_LIST_LIMIT}`);
  }
  return value;
}

export interface ValidatedGetLoopCycleQuery {
  cycleId: string;
}

export function validateGetLoopCycleQuery(input: unknown): ValidatedGetLoopCycleQuery {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_query', 'getLoopCycle query must be an object');
  }
  if (!isUuid(input.cycleId)) {
    throw new ClosedLoopError('invalid_query', 'cycleId must be a uuid');
  }
  return { cycleId: input.cycleId };
}

export interface ValidatedListLoopCyclesQuery {
  goalId: string | null;
  status: LoopCycleStatus | null;
  limit: number;
}

export function validateListLoopCyclesQuery(input: unknown): ValidatedListLoopCyclesQuery {
  const query = input ?? {};
  if (!isRecord(query)) {
    throw new ClosedLoopError('invalid_query', 'listLoopCycles query must be an object');
  }
  const goalId = optionalUuid(query.goalId, 'goalId', 'invalid_query');
  let status: LoopCycleStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isLoopCycleStatus(query.status)) {
      throw new ClosedLoopError('invalid_query', `status must be one of ${LOOP_CYCLE_STATUSES.join(', ')}`);
    }
    status = query.status;
  }
  return { goalId, status, limit: validateLimit(query.limit) };
}

export interface ValidatedListRankingSignalsQuery {
  cycleId: string | null;
  goalId: string | null;
  targetSeam: RankingTargetSeam | null;
  basis: SignalBasis | null;
  limit: number;
}

export function validateListRankingSignalsQuery(input: unknown): ValidatedListRankingSignalsQuery {
  const query = input ?? {};
  if (!isRecord(query)) {
    throw new ClosedLoopError('invalid_query', 'listRankingSignals query must be an object');
  }
  const cycleId = optionalUuid(query.cycleId, 'cycleId', 'invalid_query');
  const goalId = optionalUuid(query.goalId, 'goalId', 'invalid_query');
  let targetSeam: RankingTargetSeam | null = null;
  if (query.targetSeam !== undefined && query.targetSeam !== null) {
    if (isPolicySurfaceWord(query.targetSeam)) {
      throw new ClosedLoopError(
        'policy_mutation_refused',
        `a ranking-signal query may never address '${String(query.targetSeam)}' — policy surfaces are not ranking input channels (W140 acceptance clause 2)`,
      );
    }
    if (!isRankingTargetSeam(query.targetSeam)) {
      throw new ClosedLoopError('invalid_query', `targetSeam must be one of ${RANKING_TARGET_SEAMS.join(', ')}`);
    }
    targetSeam = query.targetSeam;
  }
  let basis: SignalBasis | null = null;
  if (query.basis !== undefined && query.basis !== null) {
    if (!isSignalBasis(query.basis)) {
      throw new ClosedLoopError('invalid_query', `basis must be one of ${SIGNAL_BASES.join(', ')}`);
    }
    basis = query.basis;
  }
  return { cycleId, goalId, targetSeam, basis, limit: validateLimit(query.limit) };
}

export interface ValidatedGetLoopTrajectoryQuery {
  goalId: string;
}

export function validateGetLoopTrajectoryQuery(input: unknown): ValidatedGetLoopTrajectoryQuery {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_query', 'getLoopTrajectory query must be an object');
  }
  if (!isUuid(input.goalId)) {
    throw new ClosedLoopError('invalid_query', 'goalId must be a uuid');
  }
  return { goalId: input.goalId };
}

export interface ValidatedSummarizeLoopImprovementQuery {
  goalId: string;
}

export function validateSummarizeLoopImprovementQuery(
  input: unknown,
): ValidatedSummarizeLoopImprovementQuery {
  if (!isRecord(input)) {
    throw new ClosedLoopError('invalid_query', 'summarizeLoopImprovement query must be an object');
  }
  if (!isUuid(input.goalId)) {
    throw new ClosedLoopError('invalid_query', 'goalId must be a uuid');
  }
  return { goalId: input.goalId };
}

// ---------------------------------------------------------------------------
// The deterministic loop math (the single definition, exported for
// verification; the service consumes, never re-derives)
// ---------------------------------------------------------------------------

/** The deterministic magnitude of one deviation: |observed − expected|. */
export function magnitudeOf(expected: number, observed: number): number {
  return round4(Math.abs(observed - expected));
}

/**
 * Applies recorded ranking signals to a base score — the single
 * deterministic definition of how learning changes future ranking.
 * Each signal moves the score by `direction * magnitude * SIGNAL_STEP`,
 * in recorded order, clamped to [0,1], rounded to 4 decimals. Pure:
 * the same base and the same signal sequence always produce the same
 * adjusted score.
 */
export function applyRankingSignals(
  baseScore: number,
  signals: readonly Pick<RankingSignal, 'direction' | 'magnitude'>[],
): number {
  let score = baseScore;
  for (const signal of signals) {
    const step = (signal.direction === 'raise' ? 1 : -1) * signal.magnitude * SIGNAL_STEP;
    score = Math.min(1, Math.max(0, score + step));
  }
  return round4(score);
}

/** The prediction-vs-outcome calibration error: |prediction − observed|. */
export function calibrationErrorOf(prediction: number, observed: number): number {
  return round4(Math.abs(prediction - observed));
}

/**
 * The deterministic observed score of one cycle: the mean of the
 * reality deviations' observed values (null when the cycle recorded
 * none — honestly unmeasured, never defaulted).
 */
export function observedScoreOf(observedValues: readonly number[]): number | null {
  if (observedValues.length === 0) return null;
  const sum = observedValues.reduce((acc, one) => acc + one, 0);
  return round4(sum / observedValues.length);
}

/**
 * The signal direction implied by one calibration gap: the world
 * outperformed the prediction → raise the ranking weight; the world
 * underperformed → lower it.
 */
export function deriveSignalDirection(predicted: number, observed: number): SignalDirection {
  return observed > predicted ? 'raise' : 'lower';
}

/** The signal magnitude implied by one calibration gap, in (0,1]. */
export function deriveSignalMagnitude(predicted: number, observed: number): number {
  return Math.min(1, round4(Math.abs(observed - predicted)) || 0.0001);
}

/**
 * The knowledge gap-closure rate between two consecutive cycles:
 * 1 − (previous knowledge sources that recur this cycle / previous
 * count). Null when the previous cycle held no knowledge deviations
 * (nothing to close — absence stated, not defaulted).
 */
export function gapClosureRateOf(
  previousSources: readonly string[],
  currentSources: readonly string[],
): number | null {
  if (previousSources.length === 0) return null;
  const current = new Set(currentSources);
  const recurring = previousSources.filter((one) => current.has(one)).length;
  return round4(1 - recurring / previousSources.length);
}

/**
 * The reality-deviation recurrence between two consecutive cycles: the
 * share of THIS cycle's reality sources that already deviated in the
 * previous cycle. Null when there was no previous cycle; 0 when none
 * recur.
 */
export function deviationRecurrenceOf(
  previousSources: readonly string[] | null,
  currentSources: readonly string[],
): number | null {
  if (previousSources === null) return null;
  if (currentSources.length === 0) return 0;
  const previous = new Set(previousSources);
  const recurring = currentSources.filter((one) => previous.has(one)).length;
  return round4(recurring / currentSources.length);
}

/**
 * The honest improvement verdict over a trajectory's calibration
 * errors: needs at least two MEASURED points; 'improved' only when the
 * last error is strictly smaller than the first; 'flat' when equal;
 * 'degraded' when larger. Unmeasured trajectories are
 * 'insufficient_evidence' — never a fabricated improvement.
 */
export function improvementVerdictOf(errors: readonly (number | null)[]): 'improved' | 'flat' | 'degraded' | 'insufficient_evidence' {
  const measured = errors.filter((one): one is number => one !== null);
  if (measured.length < 2) return 'insufficient_evidence';
  const first = measured[0] as number;
  const last = measured[measured.length - 1] as number;
  if (last < first) return 'improved';
  if (last === first) return 'flat';
  return 'degraded';
}
