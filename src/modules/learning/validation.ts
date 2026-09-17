// Pure validation/normalization logic of the learning module (no database).
// Everything a caller may put into an outcome, a measurement or a
// realization crosses these guards first; the SQL CHECK constraints in
// migrations/001-outcomes.sql mirror the load-bearing rules as defense in
// depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `status`, `realization`, `measurementCount`,
// `latestMeasurement`, `recordedAt`, `settledAt` or principal fields into
// an input — the outcome's identity, tenancy, derived lifecycle, commit
// times and acting principal are minted by the system (outcome records are
// auditable, and audit fields are not caller-forgeable). There is also
// deliberately NO revision input at all: an outcome definition is immutable
// (see types.ts) — the only writes after definition are the measurement
// series and the one terminal realization.
//
// Every shared primitive takes the error factory of its calling context, so
// a bad field reports the operation's own error code (invalid_outcome_input
// on definitions, invalid_measurement_input on measurements, and so on) —
// the same discipline the missions module applies per operation.
//
// `assessRealization` is the single definition of expected-versus-realized:
// the deterministic math the service freezes onto the terminal realization
// row at settle time (unit-tested in isolation; W054/W055 consume the
// frozen result, never a re-derivation).

import type { TenantContext } from '@/infra/tenant';
import { LearningError } from './errors';
import type {
  AppliedPrior,
  AssertionDisposition,
  AssertionProvenanceKind,
  CandidateDomain,
  CompanyModelArea,
  CompanyModelAssertionStatus,
  CompanyModelSubjectKind,
  OutcomeAssessment,
  OutcomeDirection,
  OutcomeEvidenceKind,
  OutcomePartyKind,
  OutcomeStatus,
  OutcomeSubjectKind,
  RankedCandidate,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/** The subjects W040 ties to measurable outcomes (the catalog entry's list). */
export const OUTCOME_SUBJECT_KINDS = ['recommendation', 'agent', 'extension', 'mission'] as const;

export const OUTCOME_DIRECTIONS = ['at_least', 'at_most'] as const;

/** Derived lifecycle (never stored on the definition row). */
export const OUTCOME_STATUSES = ['open', 'settled', 'abandoned'] as const;

/** The deterministic realized-versus-expected verdicts. */
export const OUTCOME_ASSESSMENTS = ['met', 'exceeded', 'missed'] as const;

/** Kinds of parties that can make outcome changes (the missions vocabulary). */
export const OUTCOME_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** Where an observed value came from (opaque reference kinds). */
export const OUTCOME_EVIDENCE_KINDS = [
  'observation',
  'event',
  'document',
  'report',
  'system',
  'metric',
] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const MAX_AFFECTED_GOALS = 16;
export const MAX_EVIDENCE_REFS = 8;
export const MAX_METRIC_NAME_LENGTH = 200;
export const MAX_METRIC_UNIT_LENGTH = 100;
export const MAX_SUBJECT_LABEL_LENGTH = 200;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_REASON_LENGTH = 2000;
export const MAX_SEARCH_LENGTH = 200;
/** Metric values are finite doubles within the JS safe-integer envelope. */
export const MAX_METRIC_VALUE = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const DEFINE_INPUT_KEYS = [
  'subject',
  'metricName',
  'metricUnit',
  'direction',
  'baseline',
  'expected',
  'horizon',
  'affectedGoals',
  'originExecutionId',
  'actor',
  'rationale',
] as const;

const MEASUREMENT_INPUT_KEYS = ['outcomeId', 'value', 'note', 'evidence', 'actor'] as const;

const SETTLE_INPUT_KEYS = ['outcomeId', 'measurementId', 'note', 'actor'] as const;

const ABANDON_INPUT_KEYS = ['outcomeId', 'reason', 'actor'] as const;

const SUBJECT_KEYS = ['kind', 'id', 'label'] as const;
const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const GOAL_REF_KEYS = ['goalId', 'label'] as const;
const EVIDENCE_KEYS = ['kind', 'id', 'label'] as const;

const LIST_QUERY_KEYS = [
  'subjectKind',
  'subjectId',
  'status',
  'assessment',
  'affectedGoalId',
  'originExecutionId',
  'search',
  'limit',
] as const;

const MEASUREMENTS_QUERY_KEYS = ['outcomeId'] as const;

const SUMMARIZE_QUERY_KEYS = ['subjectKind'] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isOutcomeSubjectKind(value: unknown): value is OutcomeSubjectKind {
  return isOneOf(value, OUTCOME_SUBJECT_KINDS);
}

export function isOutcomeDirection(value: unknown): value is OutcomeDirection {
  return isOneOf(value, OUTCOME_DIRECTIONS);
}

export function isOutcomeStatus(value: unknown): value is OutcomeStatus {
  return isOneOf(value, OUTCOME_STATUSES);
}

export function isOutcomeAssessment(value: unknown): value is OutcomeAssessment {
  return isOneOf(value, OUTCOME_ASSESSMENTS);
}

export function isOutcomePartyKind(value: unknown): value is OutcomePartyKind {
  return isOneOf(value, OUTCOME_PARTY_KINDS);
}

export function isOutcomeEvidenceKind(value: unknown): value is OutcomeEvidenceKind {
  return isOneOf(value, OUTCOME_EVIDENCE_KINDS);
}

/** Outcome/measurement-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Escapes LIKE/ILIKE metacharacters (`%`, `_`, `\`) in caller-supplied
 * search text so `search` is an exact substring, never a wildcard pattern.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertLearningTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new LearningError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new LearningError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new LearningError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// Shared primitive guards (each takes its calling context's error factory)
// ---------------------------------------------------------------------------

/** The error factory of one validation context. */
type Err = (message: string) => LearningError;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  err: Err,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw err(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireString(value: unknown, field: string, err: Err): string {
  if (typeof value !== 'string') throw err(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw err(`${field} must be a non-empty string`);
  return text;
}

function requireBoundedString(value: unknown, field: string, maxLength: number, err: Err): string {
  const text = requireString(value, field, err);
  if (text.length > maxLength) {
    throw err(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function optionalTrimmed(value: unknown, field: string, maxLength: number, err: Err): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, err);
  if (text.length > maxLength) {
    throw err(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(value: unknown, field: string, err: Err): string {
  const text = requireString(value, field, err);
  if (!UUID_PATTERN.test(text)) {
    throw err(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/**
 * A metric value: any finite double within the JS safe-integer envelope —
 * percentages, counts, durations, money in minor units, scores. The unit
 * gives it meaning; the envelope keeps it storable and comparable.
 */
function requireMetricValue(value: unknown, field: string, err: Err): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw err(`${field} must be a finite number (got ${String(value)})`);
  }
  if (Math.abs(value) > MAX_METRIC_VALUE) {
    throw err(`${field} must be within ±${MAX_METRIC_VALUE} (got ${value})`);
  }
  return value;
}

/** An optional ISO calendar date (YYYY-MM-DD) that is a real calendar day. */
function optionalIsoDate(value: unknown, field: string, err: Err): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, err);
  if (!ISO_DATE_PATTERN.test(text)) {
    throw err(`${field} must be an ISO date YYYY-MM-DD (got '${text}')`);
  }
  // Round-trip through UTC: rejects 2027-02-29 and friends (Date.parse
  // normalizes overflow dates, so the round trip exposes them).
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw err(`${field} must be a real calendar date (got '${text}')`);
  }
  return text;
}

function inputError(message: string): LearningError {
  return new LearningError('invalid_outcome_input', message);
}

function measurementError(message: string): LearningError {
  return new LearningError('invalid_measurement_input', message);
}

function settlementError(message: string): LearningError {
  return new LearningError('invalid_settlement_input', message);
}

function abandonmentError(message: string): LearningError {
  return new LearningError('invalid_abandonment_input', message);
}

function queryError(message: string): LearningError {
  return new LearningError('invalid_query', message);
}

// ---------------------------------------------------------------------------
// Subjects, parties, goal refs, evidence refs
// ---------------------------------------------------------------------------

export interface ValidatedParty {
  kind: OutcomePartyKind;
  id: string | null;
  label: string | null;
}

export interface ValidatedSubject {
  kind: OutcomeSubjectKind;
  id: string;
  label: string | null;
}

export interface ValidatedGoalRef {
  goalId: string;
  label: string | null;
}

export interface ValidatedEvidenceRef {
  kind: OutcomeEvidenceKind;
  id: string | null;
  label: string | null;
}

/**
 * Shared shape guard for actors: a provider-neutral kind plus an opaque
 * uuid id and/or a human-readable label (at least one — the party must be
 * traceable). Ids are uuids because they reference records of the owning
 * modules (people/persons, world entities, agents, actions, missions).
 */
function validateParty(party: unknown, where: string, err: Err): ValidatedParty {
  if (!isPlainObject(party)) throw err(`${where} must be an object`);
  rejectUnknownKeys(party, PARTY_KEYS, where, err);
  const kind = party.kind;
  if (!isOutcomePartyKind(kind)) {
    throw err(`${where}.kind must be one of ${OUTCOME_PARTY_KINDS.join(', ')} (got '${String(kind)}')`);
  }
  const id =
    party.id === undefined || party.id === null ? null : requireUuid(party.id, `${where}.id`, err);
  const label = optionalTrimmed(party.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH, err);
  if (id === null && label === null) {
    throw err(`${where} must carry an id or a label — the party must be traceable`);
  }
  return { kind, id, label };
}

/**
 * The subject tie: one of the four W040 subject kinds plus the subject
 * record's REQUIRED uuid id (the tie must be precise — a label alone is
 * not a tie) and an optional human label. The reference is deliberately
 * opaque: the owning module (actions for recommendations, agents,
 * extensions, missions) remains the verification point — no cross-module
 * foreign key, no contract import (the missions module's affected-goals
 * precedent).
 */
function validateSubject(subject: unknown, err: Err): ValidatedSubject {
  if (!isPlainObject(subject)) throw err('subject must be an object');
  rejectUnknownKeys(subject, SUBJECT_KEYS, 'subject', err);
  if (!isOutcomeSubjectKind(subject.kind)) {
    throw err(
      `subject.kind must be one of ${OUTCOME_SUBJECT_KINDS.join(', ')} (got '${String(subject.kind)}')`,
    );
  }
  const id = requireUuid(subject.id, 'subject.id', err);
  const label = optionalTrimmed(subject.label, 'subject.label', MAX_SUBJECT_LABEL_LENGTH, err);
  return { kind: subject.kind, id, label };
}

/** One affected-goal reference: a required goals-module uuid plus an optional label. */
function validateGoalRef(ref: unknown, where: string, err: Err): ValidatedGoalRef {
  if (!isPlainObject(ref)) throw err(`${where} must be an object`);
  rejectUnknownKeys(ref, GOAL_REF_KEYS, where, err);
  const goalId = requireUuid(ref.goalId, `${where}.goalId`, err);
  const label = optionalTrimmed(ref.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH, err);
  return { goalId, label };
}

function validateAffectedGoals(value: unknown, err: Err): ValidatedGoalRef[] {
  if (!Array.isArray(value)) throw err('affectedGoals must be an array');
  if (value.length > MAX_AFFECTED_GOALS) {
    throw err(`affectedGoals must hold at most ${MAX_AFFECTED_GOALS} entries (got ${value.length})`);
  }
  const refs = value.map((entry, index) => validateGoalRef(entry, `affectedGoals[${index}]`, err));
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.goalId)) {
      throw err(`affected goals must be unique (duplicate '${ref.goalId}')`);
    }
    seen.add(ref.goalId);
  }
  return refs;
}

/**
 * One measurement evidence reference: a provider-neutral kind plus an
 * opaque uuid id and/or a human-readable label (at least one — evidence
 * must be traceable). Deliberately unvalidated beyond shape: no sanctioned
 * contract owns these references for the learning module.
 */
function validateEvidenceRef(ref: unknown, where: string, err: Err): ValidatedEvidenceRef {
  if (!isPlainObject(ref)) throw err(`${where} must be an object`);
  rejectUnknownKeys(ref, EVIDENCE_KEYS, where, err);
  const kind = ref.kind;
  if (!isOutcomeEvidenceKind(kind)) {
    throw err(`${where}.kind must be one of ${OUTCOME_EVIDENCE_KINDS.join(', ')} (got '${String(kind)}')`);
  }
  const id = ref.id === undefined || ref.id === null ? null : requireUuid(ref.id, `${where}.id`, err);
  const label = optionalTrimmed(ref.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH, err);
  if (id === null && label === null) {
    throw err(`${where} must carry an id or a label — evidence references must be traceable`);
  }
  return { kind, id, label };
}

function validateEvidenceRefs(value: unknown, err: Err): ValidatedEvidenceRef[] {
  if (!Array.isArray(value)) throw err('evidence must be an array');
  if (value.length > MAX_EVIDENCE_REFS) {
    throw err(`evidence supports at most ${MAX_EVIDENCE_REFS} references (got ${value.length})`);
  }
  return value.map((entry, index) => validateEvidenceRef(entry, `evidence[${index}]`, err));
}

// ---------------------------------------------------------------------------
// defineOutcome
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `defineOutcome`'s input. */
export interface ValidatedDefineInput {
  subject: ValidatedSubject;
  metricName: string;
  metricUnit: string;
  direction: OutcomeDirection;
  baseline: number;
  expected: number;
  horizon: string | null;
  affectedGoals: ValidatedGoalRef[];
  originExecutionId: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateDefineOutcomeInput(input: unknown): ValidatedDefineInput {
  const err = inputError;
  if (!isPlainObject(input)) throw err('define input must be an object');
  rejectUnknownKeys(input, DEFINE_INPUT_KEYS, 'the define input', err);

  const subject = validateSubject(input.subject, err);
  const metricName = requireBoundedString(input.metricName, 'metricName', MAX_METRIC_NAME_LENGTH, err);
  const metricUnit = requireBoundedString(input.metricUnit, 'metricUnit', MAX_METRIC_UNIT_LENGTH, err);

  if (!isOutcomeDirection(input.direction)) {
    throw err(`direction must be one of ${OUTCOME_DIRECTIONS.join(', ')} (got '${String(input.direction)}')`);
  }

  const baseline = requireMetricValue(input.baseline, 'baseline', err);
  const expected = requireMetricValue(input.expected, 'expected', err);
  const horizon = optionalIsoDate(input.horizon, 'horizon', err);
  const affectedGoals = validateAffectedGoals(input.affectedGoals ?? [], err);
  const originExecutionId =
    input.originExecutionId === undefined || input.originExecutionId === null
      ? null
      : requireUuid(input.originExecutionId, 'originExecutionId', err);
  const actor = validateParty(input.actor, 'actor', err);
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, err);

  return {
    subject,
    metricName,
    metricUnit,
    direction: input.direction,
    baseline,
    expected,
    horizon,
    affectedGoals,
    originExecutionId,
    actor,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// recordMeasurement
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `recordMeasurement`'s input. */
export interface ValidatedMeasurementInput {
  outcomeId: string;
  value: number;
  note: string | null;
  evidence: ValidatedEvidenceRef[];
  actor: ValidatedParty;
}

export function validateRecordMeasurementInput(input: unknown): ValidatedMeasurementInput {
  const err = measurementError;
  if (!isPlainObject(input)) throw err('measurement input must be an object');
  rejectUnknownKeys(input, MEASUREMENT_INPUT_KEYS, 'the measurement input', err);

  const outcomeId = requireUuid(input.outcomeId, 'outcomeId', err);
  const value = requireMetricValue(input.value, 'value', err);
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_LENGTH, err);
  const evidence = validateEvidenceRefs(input.evidence ?? [], err);
  const actor = validateParty(input.actor, 'actor', err);

  return { outcomeId, value, note, evidence, actor };
}

// ---------------------------------------------------------------------------
// settleOutcome
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `settleOutcome`'s input. */
export interface ValidatedSettleInput {
  outcomeId: string;
  measurementId: string;
  note: string | null;
  actor: ValidatedParty;
}

export function validateSettleOutcomeInput(input: unknown): ValidatedSettleInput {
  const err = settlementError;
  if (!isPlainObject(input)) throw err('settlement input must be an object');
  rejectUnknownKeys(input, SETTLE_INPUT_KEYS, 'the settlement input', err);

  const outcomeId = requireUuid(input.outcomeId, 'outcomeId', err);
  const measurementId = requireUuid(input.measurementId, 'measurementId', err);
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);

  return { outcomeId, measurementId, note, actor };
}

// ---------------------------------------------------------------------------
// abandonOutcome
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `abandonOutcome`'s input. */
export interface ValidatedAbandonInput {
  outcomeId: string;
  reason: string;
  actor: ValidatedParty;
}

export function validateAbandonOutcomeInput(input: unknown): ValidatedAbandonInput {
  const err = abandonmentError;
  if (!isPlainObject(input)) throw err('abandonment input must be an object');
  rejectUnknownKeys(input, ABANDON_INPUT_KEYS, 'the abandonment input', err);

  const outcomeId = requireUuid(input.outcomeId, 'outcomeId', err);
  const reason = requireBoundedString(input.reason, 'reason', MAX_REASON_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);

  return { outcomeId, reason, actor };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `listOutcomes`' query. */
export interface ValidatedListQuery {
  subjectKind: OutcomeSubjectKind | null;
  subjectId: string | null;
  status: OutcomeStatus | null;
  assessment: OutcomeAssessment | null;
  affectedGoalId: string | null;
  originExecutionId: string | null;
  search: string | null;
  limit: number;
}

export function validateListOutcomesQuery(query: unknown): ValidatedListQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('list query must be an object');
  rejectUnknownKeys(query, LIST_QUERY_KEYS, 'the list query', err);

  let subjectKind: OutcomeSubjectKind | null = null;
  if (query.subjectKind !== undefined) {
    if (!isOutcomeSubjectKind(query.subjectKind)) {
      throw err(
        `subjectKind must be one of ${OUTCOME_SUBJECT_KINDS.join(', ')} (got '${String(query.subjectKind)}')`,
      );
    }
    subjectKind = query.subjectKind;
  }

  let subjectId: string | null = null;
  if (query.subjectId !== undefined) {
    subjectId = requireUuid(query.subjectId, 'subjectId', err);
    if (subjectKind === null) {
      throw err('subjectId requires subjectKind — a subject id is meaningless without its kind');
    }
  }

  let status: OutcomeStatus | null = null;
  if (query.status !== undefined) {
    if (!isOutcomeStatus(query.status)) {
      throw err(`status must be one of ${OUTCOME_STATUSES.join(', ')} (got '${String(query.status)}')`);
    }
    status = query.status;
  }

  let assessment: OutcomeAssessment | null = null;
  if (query.assessment !== undefined) {
    if (!isOutcomeAssessment(query.assessment)) {
      throw err(
        `assessment must be one of ${OUTCOME_ASSESSMENTS.join(', ')} (got '${String(query.assessment)}')`,
      );
    }
    assessment = query.assessment;
    if (status !== null && status !== 'settled') {
      throw err("assessment only applies to settled outcomes (filter with status 'settled')");
    }
  }

  const affectedGoalId =
    query.affectedGoalId === undefined ? null : requireUuid(query.affectedGoalId, 'affectedGoalId', err);
  const originExecutionId =
    query.originExecutionId === undefined
      ? null
      : requireUuid(query.originExecutionId, 'originExecutionId', err);

  const search =
    query.search === undefined
      ? null
      : requireBoundedString(query.search, 'search', MAX_SEARCH_LENGTH, err);

  let limit = DEFAULT_LIST_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'number' || !Number.isInteger(query.limit) || query.limit < 1) {
      throw err(`limit must be a positive integer (got ${String(query.limit)})`);
    }
    if (query.limit > MAX_LIST_LIMIT) {
      throw err(`limit must be at most ${MAX_LIST_LIMIT} (got ${query.limit})`);
    }
    limit = query.limit;
  }

  return { subjectKind, subjectId, status, assessment, affectedGoalId, originExecutionId, search, limit };
}

/** Fully validated + normalized form of `listMeasurements`' query. */
export interface ValidatedMeasurementsQuery {
  outcomeId: string;
}

export function validateListMeasurementsQuery(query: unknown): ValidatedMeasurementsQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('measurements query must be an object');
  rejectUnknownKeys(query, MEASUREMENTS_QUERY_KEYS, 'the measurements query', err);
  return { outcomeId: requireUuid(query.outcomeId, 'outcomeId', err) };
}

/** Fully validated + normalized form of `summarizeRealization`' query. */
export interface ValidatedSummarizeQuery {
  subjectKind: OutcomeSubjectKind | null;
}

export function validateSummarizeRealizationQuery(query: unknown): ValidatedSummarizeQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('summarize query must be an object');
  rejectUnknownKeys(query, SUMMARIZE_QUERY_KEYS, 'the summarize query', err);
  if (query.subjectKind === undefined) return { subjectKind: null };
  if (!isOutcomeSubjectKind(query.subjectKind)) {
    throw err(
      `subjectKind must be one of ${OUTCOME_SUBJECT_KINDS.join(', ')} (got '${String(query.subjectKind)}')`,
    );
  }
  return { subjectKind: query.subjectKind };
}

// ---------------------------------------------------------------------------
// The expected-versus-realized math (single definition, frozen at settle)
// ---------------------------------------------------------------------------

/** The deterministic result `assessRealization` produces. */
export interface RealizationAssessment {
  /** realized − expected (signed, in metric units). */
  varianceVsExpected: number;
  /** realized − baseline (signed, in metric units). */
  improvementVsBaseline: number;
  /** met = exactly meets the expectation, exceeded = strictly better, missed = worse. */
  assessment: OutcomeAssessment;
}

/**
 * The single definition of expected-versus-realized (W040's core):
 * deterministic, pure, direction-aware. The service freezes this onto the
 * terminal realization row at settle time; W054 (capability outcome
 * learning) and W055 (quality measurement) consume the frozen record.
 *
 *  * 'at_least' (higher is better): realized > expected → 'exceeded',
 *    realized = expected → 'met', realized < expected → 'missed';
 *  * 'at_most' (lower is better): realized < expected → 'exceeded',
 *    realized = expected → 'met', realized > expected → 'missed'.
 */
export function assessRealization(
  direction: OutcomeDirection,
  baseline: number,
  expected: number,
  realized: number,
): RealizationAssessment {
  let assessment: OutcomeAssessment;
  if (direction === 'at_least') {
    assessment = realized > expected ? 'exceeded' : realized === expected ? 'met' : 'missed';
  } else {
    assessment = realized < expected ? 'exceeded' : realized === expected ? 'met' : 'missed';
  }
  return {
    varianceVsExpected: realized - expected,
    improvementVsBaseline: realized - baseline,
    assessment,
  };
}

// ---------------------------------------------------------------------------
// W053 — CompanyModel Learning (ADR-0016)
//
// Everything a caller may put into a recorded learning update or a ranking
// request crosses these guards first; the SQL CHECK constraints in
// migrations/002-company-model.sql mirror the load-bearing rules as defense
// in depth. As with the W040 operations, callers can never smuggle
// system-minted fields (assertion ids, versions, supersedes links, model
// versions, commit times, principals) into an input, and there is NO
// operation to edit or delete a learned assertion version: the CompanyModel
// advances only through `recordLearningUpdate`, which appends new versions
// (ADR-0016's "recorded learning update" is the ONLY channel from evidence
// and outcomes to future behavior).
//
// `scoreCandidateSet` is the single deterministic definition of how learned
// priors reorder policy-vetted candidates — pure, provider-independent, and
// structurally incapable of overriding explicit policy (lock 14): it never
// adds or removes candidates, policy-excluded kinds always sink, and policy
// kind precedence is a hard sort key ahead of every learned score.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CompanyModel vocabularies (mirrored by the CHECK constraints in migration 002)
// ---------------------------------------------------------------------------

/** The ten ADR-0016 knowledge areas of the CompanyModel. */
export const COMPANY_MODEL_AREAS = [
  'vocabulary',
  'organization',
  'process_exception',
  'source_reliability',
  'employee_expertise',
  'capability_pattern',
  'goal_interpretation',
  'investigation_preference',
  'intervention_prior',
  'organizational_norm',
] as const;

/** What a CompanyModel assertion can be about (provider-neutral kinds). */
export const COMPANY_MODEL_SUBJECT_KINDS = [
  'company',
  'term',
  'employee',
  'team',
  'role',
  'source',
  'process',
  'capability',
  'goal',
  'intervention',
  'agent',
] as const;

/** Whether an assertion version states knowledge or retracts it. */
export const ASSERTION_DISPOSITIONS = ['asserted', 'retracted'] as const;

/**
 * Provenance kinds of a learned assertion: the W040 evidence kinds plus
 * 'interaction' (validated interactions) and 'contribution' (employee
 * knowledge contributions — W042's future records, opaque for now).
 */
export const ASSERTION_PROVENANCE_KINDS = [
  'observation',
  'event',
  'document',
  'report',
  'system',
  'metric',
  'interaction',
  'contribution',
] as const;

/** The derived lifecycle statuses of an assertion version. */
export const COMPANY_MODEL_STATUSES = [
  'active',
  'pending',
  'expired',
  'retracted',
  'superseded',
] as const;

/** The application domains of `rankCandidates`. */
export const CANDIDATE_DOMAINS = ['source_selection', 'intervention'] as const;

/**
 * The canonical assertion families `rankCandidates` consumes: per domain,
 * the (area, topic) whose current active assertions carry a machine-readable
 * `statement.score` in [0, 1] — the learned prior for that candidate.
 */
export const RANK_DOMAIN_FAMILIES: Record<
  CandidateDomain,
  { area: CompanyModelArea; topic: string; scoreField: 'score' }
> = {
  source_selection: { area: 'source_reliability', topic: 'reliability', scoreField: 'score' },
  intervention: { area: 'intervention_prior', topic: 'effectiveness', scoreField: 'score' },
};

// ---------------------------------------------------------------------------
// CompanyModel size caps
// ---------------------------------------------------------------------------

export const MAX_CHANGES_PER_UPDATE = 16;
export const MAX_SUBJECT_NAME_LENGTH = 120;
export const MAX_SUBJECT_KEY_LENGTH = 160;
export const MAX_SUBJECT_SLUG_LENGTH = 80;
export const MAX_TOPIC_LENGTH = 100;
export const MAX_STATEMENT_JSON_LENGTH = 4096;
export const MAX_STATEMENT_KEYS = 16;
export const MAX_STATEMENT_KEY_LENGTH = 64;
export const MAX_PROVENANCE_REFS = 8;
export const MAX_RANK_CANDIDATES = 32;
export const MAX_POLICY_KINDS = 16;
export const MAX_POLICY_KIND_LENGTH = 40;
/** The base score a candidate without a caller-supplied base carries. */
export const DEFAULT_CANDIDATE_BASE_SCORE = 0.5;
/** Scores are rounded to 6 decimals so orderings are deterministic. */
export const SCORE_DECIMALS = 6;

// ---------------------------------------------------------------------------
// CompanyModel type guards
// ---------------------------------------------------------------------------

export function isCompanyModelArea(value: unknown): value is CompanyModelArea {
  return isOneOf(value, COMPANY_MODEL_AREAS);
}

export function isCompanyModelSubjectKind(value: unknown): value is CompanyModelSubjectKind {
  return isOneOf(value, COMPANY_MODEL_SUBJECT_KINDS);
}

export function isAssertionDisposition(value: unknown): value is AssertionDisposition {
  return isOneOf(value, ASSERTION_DISPOSITIONS);
}

export function isAssertionProvenanceKind(value: unknown): value is AssertionProvenanceKind {
  return isOneOf(value, ASSERTION_PROVENANCE_KINDS);
}

export function isCompanyModelStatus(value: unknown): value is CompanyModelAssertionStatus {
  return isOneOf(value, COMPANY_MODEL_STATUSES);
}

export function isCandidateDomain(value: unknown): value is CandidateDomain {
  return isOneOf(value, CANDIDATE_DOMAINS);
}

// ---------------------------------------------------------------------------
// Subject keys
// ---------------------------------------------------------------------------

/**
 * Deterministically slugifies a subject name: NFC-normalized, lowercased,
 * non-alphanumerics collapsed to single dashes, trimmed of edge dashes.
 * Pure — the same name always yields the same key.
 */
export function slugifySubjectName(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derives the normalized stable subject key of a CompanyModel subject:
 *  * kind 'company' — no id, no name → 'company';
 *  * every other kind — exactly one of a uuid `id` ('<kind>:<uuid>') or a
 *    name ('<kind>:<slug>'), never both, never neither.
 * The key is the chain dimension: two assertions about the same subject
 * must agree on how they address it (record-backed subjects by uuid).
 */
export function deriveSubjectKey(
  kind: CompanyModelSubjectKind,
  id: string | null,
  name: string | null,
  err: Err,
): string {
  if (kind === 'company') {
    if (id !== null || name !== null) {
      throw err("subject kind 'company' is company-wide — it carries neither id nor name");
    }
    return 'company';
  }
  if (id !== null && name !== null) {
    throw err(`subject of kind '${kind}' carries either an id or a name, not both`);
  }
  if (id !== null) {
    if (!UUID_PATTERN.test(id)) {
      throw err(`subject.id must be a uuid (got '${id}')`);
    }
    return `${kind}:${id.toLowerCase()}`;
  }
  if (name !== null) {
    const slug = slugifySubjectName(name);
    if (slug === '') {
      throw err(`subject.name must contain at least one alphanumeric character (got '${name}')`);
    }
    if (slug.length > MAX_SUBJECT_SLUG_LENGTH) {
      throw err(`subject.name must slugify to at most ${MAX_SUBJECT_SLUG_LENGTH} characters`);
    }
    return `${kind}:${slug}`;
  }
  throw err(`subject of kind '${kind}' must carry an id or a name`);
}

// ---------------------------------------------------------------------------
// recordLearningUpdate
// ---------------------------------------------------------------------------

const UPDATE_INPUT_KEYS = ['changes', 'rationale', 'actor'] as const;

const DELTA_KEYS = [
  'area',
  'subject',
  'topic',
  'statement',
  'confidence',
  'disposition',
  'validFrom',
  'validUntil',
  'evidence',
  'outcomeId',
] as const;

const SUBJECT_INPUT_KEYS = ['kind', 'id', 'name', 'label'] as const;
const PROVENANCE_KEYS = ['kind', 'id', 'label'] as const;

function updateError(message: string): LearningError {
  return new LearningError('invalid_update_input', message);
}

function rankError(message: string): LearningError {
  return new LearningError('invalid_rank_input', message);
}

/** A validated subject reference, with its derived stable key. */
export interface ValidatedCompanyModelSubject {
  kind: CompanyModelSubjectKind;
  key: string;
  label: string | null;
}

/** A validated provenance reference (traceable: uuid id and/or label). */
export interface ValidatedProvenanceRef {
  kind: AssertionProvenanceKind;
  id: string | null;
  label: string | null;
}

/** Fully validated + normalized form of one learning-update delta. */
export interface ValidatedAssertionDelta {
  area: CompanyModelArea;
  subject: ValidatedCompanyModelSubject;
  topic: string;
  statement: Record<string, unknown>;
  confidence: number;
  disposition: AssertionDisposition;
  validFrom: string | null;
  validUntil: string | null;
  evidence: ValidatedProvenanceRef[];
  outcomeId: string | null;
}

/** Fully validated + normalized form of `recordLearningUpdate`'s input. */
export interface ValidatedUpdateInput {
  changes: ValidatedAssertionDelta[];
  rationale: string;
  actor: ValidatedParty;
}

/**
 * An ISO 8601 date or date-time (UTC date-only reads as UTC midnight).
 * Captures the calendar components so overflow dates can be rejected.
 */
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * An optional ISO 8601 timestamp that must be a real instant. Date-only
 * forms mean UTC midnight; offsets are preserved verbatim (PostgreSQL
 * parses them). Overflow dates (2026-02-30 …) are rejected by a Date.UTC
 * round trip — JS engines silently normalize them, so a plain Date parse
 * would accept nonsense days.
 */
function optionalIsoTimestamp(value: unknown, field: string, err: Err): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, err);
  const match = ISO_TIMESTAMP_PATTERN.exec(text);
  if (match === null) {
    throw err(`${field} must be an ISO 8601 date or date-time (got '${text}')`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    throw err(`${field} must be a real calendar date (got '${text}')`);
  }
  const hours = match[4] === undefined ? 0 : Number(match[4]);
  const minutes = match[5] === undefined ? 0 : Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  if (day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) {
    throw err(`${field} must be a real ISO 8601 instant (got '${text}')`);
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw err(`${field} must be a real calendar date (got '${text}')`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw err(`${field} must be a real ISO 8601 instant (got '${text}')`);
  }
  return text;
}

/**
 * The learned assertion payload: a plain, bounded JSON object. The store is
 * deliberately generic — the application surface interprets only the two
 * canonical score fields (see RANK_DOMAIN_FAMILIES); everything else is
 * provider-neutral company knowledge for the model's readers.
 */
function validateStatement(value: unknown, err: Err): Record<string, unknown> {
  if (!isPlainObject(value)) throw err('statement must be a JSON object');
  const keys = Object.keys(value);
  if (keys.length > MAX_STATEMENT_KEYS) {
    throw err(`statement must hold at most ${MAX_STATEMENT_KEYS} keys (got ${keys.length})`);
  }
  for (const key of keys) {
    if (key.length > MAX_STATEMENT_KEY_LENGTH) {
      throw err(`statement keys must be at most ${MAX_STATEMENT_KEY_LENGTH} characters`);
    }
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > MAX_STATEMENT_JSON_LENGTH) {
    throw err(`statement must serialize to at most ${MAX_STATEMENT_JSON_LENGTH} characters`);
  }
  return value;
}

function validateProvenanceRef(ref: unknown, where: string, err: Err): ValidatedProvenanceRef {
  if (!isPlainObject(ref)) throw err(`${where} must be an object`);
  rejectUnknownKeys(ref, PROVENANCE_KEYS, where, err);
  const kind = ref.kind;
  if (!isAssertionProvenanceKind(kind)) {
    throw err(
      `${where}.kind must be one of ${ASSERTION_PROVENANCE_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = ref.id === undefined || ref.id === null ? null : requireUuid(ref.id, `${where}.id`, err);
  const label = optionalTrimmed(ref.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH, err);
  if (id === null && label === null) {
    throw err(`${where} must carry an id or a label — provenance references must be traceable`);
  }
  return { kind, id, label };
}

function validateProvenanceRefs(value: unknown, err: Err): ValidatedProvenanceRef[] {
  if (!Array.isArray(value)) throw err('evidence must be an array');
  if (value.length > MAX_PROVENANCE_REFS) {
    throw err(`evidence supports at most ${MAX_PROVENANCE_REFS} references (got ${value.length})`);
  }
  return value.map((entry, index) => validateProvenanceRef(entry, `evidence[${index}]`, err));
}

/** Validates one delta of a learning update (see `ValidatedAssertionDelta`). */
function validateAssertionDelta(delta: unknown, err: Err): ValidatedAssertionDelta {
  if (!isPlainObject(delta)) throw err('each change must be an object');
  rejectUnknownKeys(delta, DELTA_KEYS, 'a change', err);

  if (!isCompanyModelArea(delta.area)) {
    throw err(
      `change.area must be one of ${COMPANY_MODEL_AREAS.join(', ')} (got '${String(delta.area)}')`,
    );
  }
  const area = delta.area;

  if (!isPlainObject(delta.subject)) throw err('change.subject must be an object');
  rejectUnknownKeys(delta.subject, SUBJECT_INPUT_KEYS, 'change.subject', err);
  if (!isCompanyModelSubjectKind(delta.subject.kind)) {
    throw err(
      `change.subject.kind must be one of ${COMPANY_MODEL_SUBJECT_KINDS.join(', ')} (got '${String(delta.subject.kind)}')`,
    );
  }
  const id =
    delta.subject.id === undefined || delta.subject.id === null
      ? null
      : requireUuid(delta.subject.id, 'change.subject.id', err);
  const name =
    delta.subject.name === undefined || delta.subject.name === null
      ? null
      : requireBoundedString(delta.subject.name, 'change.subject.name', MAX_SUBJECT_NAME_LENGTH, err);
  const subjectLabel = optionalTrimmed(
    delta.subject.label,
    'change.subject.label',
    MAX_SUBJECT_LABEL_LENGTH,
    err,
  );
  const key = deriveSubjectKey(delta.subject.kind, id, name, err);

  const topic = requireBoundedString(delta.topic, 'change.topic', MAX_TOPIC_LENGTH, err);
  const statement = validateStatement(delta.statement, err);

  if (typeof delta.confidence !== 'number' || !Number.isFinite(delta.confidence)) {
    throw err(`change.confidence must be a finite number (got ${String(delta.confidence)})`);
  }
  if (delta.confidence < 0 || delta.confidence > 1) {
    throw err(`change.confidence must be within [0, 1] (got ${delta.confidence})`);
  }

  let disposition: AssertionDisposition = 'asserted';
  if (delta.disposition !== undefined && delta.disposition !== null) {
    if (!isAssertionDisposition(delta.disposition)) {
      throw err(
        `change.disposition must be one of ${ASSERTION_DISPOSITIONS.join(', ')} (got '${String(delta.disposition)}')`,
      );
    }
    disposition = delta.disposition;
  }

  const validFrom = optionalIsoTimestamp(delta.validFrom, 'change.validFrom', err);
  const validUntil = optionalIsoTimestamp(delta.validUntil, 'change.validUntil', err);
  if (validFrom !== null && validUntil !== null && validUntil <= validFrom) {
    throw err('change.validUntil must be strictly after change.validFrom');
  }

  const evidence = validateProvenanceRefs(delta.evidence ?? [], err);
  const outcomeId =
    delta.outcomeId === undefined || delta.outcomeId === null
      ? null
      : requireUuid(delta.outcomeId, 'change.outcomeId', err);

  // ADR-0016: the model is "derived from evidence, outcomes and validated
  // interactions" — an assertion that cites nothing is not learnable.
  if (evidence.length === 0 && outcomeId === null) {
    throw err('each change must cite evidence references or link an outcome (provenance required)');
  }

  return { area, subject: { kind: delta.subject.kind, key, label: subjectLabel }, topic, statement, confidence: delta.confidence, disposition, validFrom, validUntil, evidence, outcomeId };
}

export function validateRecordLearningUpdateInput(input: unknown): ValidatedUpdateInput {
  const err = updateError;
  if (!isPlainObject(input)) throw err('learning update input must be an object');
  rejectUnknownKeys(input, UPDATE_INPUT_KEYS, 'the learning update input', err);

  if (!Array.isArray(input.changes)) throw err('changes must be an array');
  if (input.changes.length === 0) throw err('changes must hold at least one assertion delta');
  if (input.changes.length > MAX_CHANGES_PER_UPDATE) {
    throw err(`changes must hold at most ${MAX_CHANGES_PER_UPDATE} deltas (got ${input.changes.length})`);
  }
  const changes = input.changes.map((delta) => validateAssertionDelta(delta, err));

  // Two deltas of one update may not touch the same chain — the update's
  // meaning ("what changed") would be ambiguous.
  const seen = new Set<string>();
  for (const delta of changes) {
    const chain = `${delta.area}|${delta.subject.key}|${delta.topic}`;
    if (seen.has(chain)) {
      throw err(
        `two changes touch the same assertion chain (${delta.area} / ${delta.subject.key} / ${delta.topic}) — record them as separate versions in separate updates or merge them`,
      );
    }
    seen.add(chain);
  }

  const rationale = requireBoundedString(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);

  return { changes, rationale, actor };
}

// ---------------------------------------------------------------------------
// CompanyModel queries
// ---------------------------------------------------------------------------

const MODEL_QUERY_KEYS = ['areas', 'includeInactive'] as const;

const ASSERTION_LIST_QUERY_KEYS = [
  'area',
  'subjectKind',
  'subjectKey',
  'topic',
  'status',
  'outcomeId',
  'updateId',
  'search',
  'limit',
] as const;

const UPDATES_LIST_QUERY_KEYS = ['search', 'limit'] as const;

/** Fully validated + normalized form of `getCompanyModel`'s query. */
export interface ValidatedModelQuery {
  areas: CompanyModelArea[] | null;
  includeInactive: boolean;
}

export function validateGetCompanyModelQuery(query: unknown): ValidatedModelQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('company model query must be an object');
  rejectUnknownKeys(query, MODEL_QUERY_KEYS, 'the company model query', err);

  let areas: CompanyModelArea[] | null = null;
  if (query.areas !== undefined) {
    if (!Array.isArray(query.areas) || query.areas.length === 0) {
      throw err('areas must be a non-empty array when present');
    }
    if (query.areas.length > COMPANY_MODEL_AREAS.length) {
      throw err(`areas must hold at most ${COMPANY_MODEL_AREAS.length} entries`);
    }
    areas = query.areas.map((area) => {
      if (!isCompanyModelArea(area)) {
        throw err(`areas entries must be one of ${COMPANY_MODEL_AREAS.join(', ')} (got '${String(area)}')`);
      }
      return area;
    });
    if (new Set(areas).size !== areas.length) {
      throw err('areas must be unique');
    }
  }

  let includeInactive = false;
  if (query.includeInactive !== undefined) {
    if (typeof query.includeInactive !== 'boolean') {
      throw err(`includeInactive must be a boolean (got '${String(query.includeInactive)}')`);
    }
    includeInactive = query.includeInactive;
  }

  return { areas, includeInactive };
}

/** Fully validated + normalized form of `listCompanyModelAssertions`'s query. */
export interface ValidatedAssertionListQuery {
  area: CompanyModelArea | null;
  subjectKind: CompanyModelSubjectKind | null;
  subjectKey: string | null;
  topic: string | null;
  status: CompanyModelAssertionStatus | null;
  outcomeId: string | null;
  updateId: string | null;
  search: string | null;
  limit: number;
}

export function validateListCompanyAssertionsQuery(query: unknown): ValidatedAssertionListQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('assertion list query must be an object');
  rejectUnknownKeys(query, ASSERTION_LIST_QUERY_KEYS, 'the assertion list query', err);

  let area: CompanyModelArea | null = null;
  if (query.area !== undefined) {
    if (!isCompanyModelArea(query.area)) {
      throw err(`area must be one of ${COMPANY_MODEL_AREAS.join(', ')} (got '${String(query.area)}')`);
    }
    area = query.area;
  }

  let subjectKind: CompanyModelSubjectKind | null = null;
  if (query.subjectKind !== undefined) {
    if (!isCompanyModelSubjectKind(query.subjectKind)) {
      throw err(
        `subjectKind must be one of ${COMPANY_MODEL_SUBJECT_KINDS.join(', ')} (got '${String(query.subjectKind)}')`,
      );
    }
    subjectKind = query.subjectKind;
  }

  const subjectKey =
    query.subjectKey === undefined
      ? null
      : requireBoundedString(query.subjectKey, 'subjectKey', MAX_SUBJECT_KEY_LENGTH, err);
  const topic =
    query.topic === undefined ? null : requireBoundedString(query.topic, 'topic', MAX_TOPIC_LENGTH, err);

  let status: CompanyModelAssertionStatus | null = null;
  if (query.status !== undefined) {
    if (!isCompanyModelStatus(query.status)) {
      throw err(`status must be one of ${COMPANY_MODEL_STATUSES.join(', ')} (got '${String(query.status)}')`);
    }
    status = query.status;
  }

  const outcomeId =
    query.outcomeId === undefined ? null : requireUuid(query.outcomeId, 'outcomeId', err);
  const updateId =
    query.updateId === undefined ? null : requireUuid(query.updateId, 'updateId', err);
  const search =
    query.search === undefined ? null : requireBoundedString(query.search, 'search', MAX_SEARCH_LENGTH, err);

  let limit = DEFAULT_LIST_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'number' || !Number.isInteger(query.limit) || query.limit < 1) {
      throw err(`limit must be a positive integer (got ${String(query.limit)})`);
    }
    if (query.limit > MAX_LIST_LIMIT) {
      throw err(`limit must be at most ${MAX_LIST_LIMIT} (got ${query.limit})`);
    }
    limit = query.limit;
  }

  return { area, subjectKind, subjectKey, topic, status, outcomeId, updateId, search, limit };
}

/** Fully validated + normalized form of `listLearningUpdates`'s query. */
export interface ValidatedUpdatesListQuery {
  search: string | null;
  limit: number;
}

export function validateListLearningUpdatesQuery(query: unknown): ValidatedUpdatesListQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('learning updates query must be an object');
  rejectUnknownKeys(query, UPDATES_LIST_QUERY_KEYS, 'the learning updates query', err);

  const search =
    query.search === undefined ? null : requireBoundedString(query.search, 'search', MAX_SEARCH_LENGTH, err);
  let limit = DEFAULT_LIST_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'number' || !Number.isInteger(query.limit) || query.limit < 1) {
      throw err(`limit must be a positive integer (got ${String(query.limit)})`);
    }
    if (query.limit > MAX_LIST_LIMIT) {
      throw err(`limit must be at most ${MAX_LIST_LIMIT} (got ${query.limit})`);
    }
    limit = query.limit;
  }
  return { search, limit };
}

// ---------------------------------------------------------------------------
// rankCandidates — input validation
// ---------------------------------------------------------------------------

const RANK_INPUT_KEYS = ['domain', 'candidates', 'policy'] as const;
const RANK_CANDIDATE_KEYS = ['kind', 'id', 'name', 'label', 'baseScore'] as const;
const RANK_POLICY_KEYS = ['allowedKinds', 'kindPrecedence'] as const;

/** A validated ranking candidate, with its derived subject key. */
export interface ValidatedRankCandidate {
  kind: CompanyModelSubjectKind;
  key: string;
  label: string | null;
  baseScore: number;
}

/** Validated explicit policy constraints (lock 14 — always authoritative). */
export interface ValidatedRankPolicy {
  allowedKinds: string[] | null;
  kindPrecedence: string[] | null;
}

/** Fully validated + normalized form of `rankCandidates`'s input. */
export interface ValidatedRankInput {
  domain: CandidateDomain;
  candidates: ValidatedRankCandidate[];
  policy: ValidatedRankPolicy;
}

function validatePolicyKindList(value: unknown, field: string, err: Err): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw err(`${field} must be a non-empty array when present`);
  }
  if (value.length > MAX_POLICY_KINDS) {
    throw err(`${field} must hold at most ${MAX_POLICY_KINDS} kinds (got ${value.length})`);
  }
  const kinds = value.map((kind) =>
    requireBoundedString(kind, `${field} entries`, MAX_POLICY_KIND_LENGTH, err),
  );
  if (new Set(kinds).size !== kinds.length) {
    throw err(`${field} must be unique`);
  }
  return kinds;
}

export function validateRankCandidatesInput(input: unknown): ValidatedRankInput {
  const err = rankError;
  if (!isPlainObject(input)) throw err('rank input must be an object');
  rejectUnknownKeys(input, RANK_INPUT_KEYS, 'the rank input', err);

  if (!isCandidateDomain(input.domain)) {
    throw err(`domain must be one of ${CANDIDATE_DOMAINS.join(', ')} (got '${String(input.domain)}')`);
  }
  const domain = input.domain;

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw err('candidates must be a non-empty array');
  }
  if (input.candidates.length > MAX_RANK_CANDIDATES) {
    throw err(`candidates must hold at most ${MAX_RANK_CANDIDATES} entries (got ${input.candidates.length})`);
  }
  const candidates = input.candidates.map((candidate, index) => {
    const where = `candidates[${index}]`;
    if (!isPlainObject(candidate)) throw err(`${where} must be an object`);
    rejectUnknownKeys(candidate, RANK_CANDIDATE_KEYS, where, err);
    if (!isCompanyModelSubjectKind(candidate.kind)) {
      throw err(
        `${where}.kind must be one of ${COMPANY_MODEL_SUBJECT_KINDS.join(', ')} (got '${String(candidate.kind)}')`,
      );
    }
    const id =
      candidate.id === undefined || candidate.id === null
        ? null
        : requireUuid(candidate.id, `${where}.id`, err);
    const name =
      candidate.name === undefined || candidate.name === null
        ? null
        : requireBoundedString(candidate.name, `${where}.name`, MAX_SUBJECT_NAME_LENGTH, err);
    const key = deriveSubjectKey(candidate.kind, id, name, err);
    const label = optionalTrimmed(candidate.label, `${where}.label`, MAX_SUBJECT_LABEL_LENGTH, err);
    let baseScore = DEFAULT_CANDIDATE_BASE_SCORE;
    if (candidate.baseScore !== undefined && candidate.baseScore !== null) {
      if (
        typeof candidate.baseScore !== 'number' ||
        !Number.isFinite(candidate.baseScore) ||
        candidate.baseScore < 0 ||
        candidate.baseScore > 1
      ) {
        throw err(`${where}.baseScore must be a finite number within [0, 1] (got ${String(candidate.baseScore)})`);
      }
      baseScore = candidate.baseScore;
    }
    return { kind: candidate.kind, key, label, baseScore };
  });

  const keys = new Set(candidates.map((candidate) => candidate.key));
  if (keys.size !== candidates.length) {
    throw err('candidates must be unique — two candidates derive the same subject key');
  }

  let allowedKinds: string[] | null = null;
  let kindPrecedence: string[] | null = null;
  if (input.policy !== undefined && input.policy !== null) {
    if (!isPlainObject(input.policy)) throw err('policy must be an object');
    rejectUnknownKeys(input.policy, RANK_POLICY_KEYS, 'policy', err);
    if (input.policy.allowedKinds !== undefined && input.policy.allowedKinds !== null) {
      allowedKinds = validatePolicyKindList(input.policy.allowedKinds, 'policy.allowedKinds', err);
    }
    if (input.policy.kindPrecedence !== undefined && input.policy.kindPrecedence !== null) {
      kindPrecedence = validatePolicyKindList(input.policy.kindPrecedence, 'policy.kindPrecedence', err);
    }
  }

  return { domain, candidates, policy: { allowedKinds, kindPrecedence } };
}

// ---------------------------------------------------------------------------
// scoreCandidateSet — the single deterministic definition (W053's core)
// ---------------------------------------------------------------------------

/**
 * The minimal assertion shape `scoreCandidateSet` consumes: the current
 * head of a chain, as loaded by the service (or synthesized by a test).
 */
export interface ScoreableAssertion {
  id: string;
  area: CompanyModelArea;
  subjectKey: string;
  topic: string;
  statement: Record<string, unknown>;
  confidence: number;
  disposition: AssertionDisposition;
  /** ISO 8601 — active during [validFrom, validUntil). */
  validFrom: string;
  validUntil: string | null;
  version: number;
}

/** True when the assertion's validity interval covers `nowIso`. */
function isValidAt(assertion: ScoreableAssertion, nowIso: string): boolean {
  return assertion.validFrom <= nowIso && (assertion.validUntil === null || assertion.validUntil > nowIso);
}

function roundScore(value: number): number {
  const factor = 10 ** SCORE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * The single deterministic definition of how the CompanyModel reorders
 * policy-vetted candidates (ADR-0016/ADR-0018: deterministic at the
 * policy/workflow level — the same inputs and the same learned state
 * produce the same ordering):
 *
 *  1. LEARNED PRIOR: the current active assertion of the domain's canonical
 *     family (see RANK_DOMAIN_FAMILIES) matching the candidate's subject
 *     key contributes its statement.score — when that score is a finite
 *     number in [0, 1]; anything else is stored knowledge the surface does
 *     not interpret (no prior applies).
 *  2. BLEND: score = base·(1 − confidence) + learnedScore·confidence — the
 *     assertion's confidence is exactly how much the learned value moves
 *     the score. Without a prior, score = base.
 *  3. POLICY IS AUTHORITATIVE (lock 14): a candidate whose kind is not in
 *     policy.allowedKinds is policyExcluded and sinks to the bottom —
 *     no learned score can rescue it. policy.kindPrecedence is a hard sort
 *     key BEFORE the score: a precedence-favored kind always outranks a
 *     lower one regardless of learning. Learned preference only reorders
 *     candidates within what explicit policy permits.
 *  4. TOTAL ORDER: policyExcluded → policyTier → score (rounded to
 *     ${SCORE_DECIMALS} decimals) → input position. Every candidate keeps
 *     its attribution (which assertion version, confidence and learned
 *     score produced its learnedScore) so ranking changes are always
 *     reconstructable from recorded CompanyModel deltas.
 *
 * Pure: no database, no clock, no provider — the service loads the active
 * assertions and passes `nowIso` from the injectable clock.
 */
export function scoreCandidateSet(
  assertions: ScoreableAssertion[],
  input: ValidatedRankInput,
  nowIso: string,
): Array<Omit<RankedCandidate, 'rank'>> {
  const family = RANK_DOMAIN_FAMILIES[input.domain];
  const byKey = new Map<string, ScoreableAssertion>();
  for (const assertion of assertions) {
    if (assertion.area !== family.area || assertion.topic !== family.topic) continue;
    if (assertion.disposition !== 'asserted' || !isValidAt(assertion, nowIso)) continue;
    const current = byKey.get(assertion.subjectKey);
    if (current === undefined || assertion.version > current.version) {
      byKey.set(assertion.subjectKey, assertion);
    }
  }

  const allowed = input.policy.allowedKinds !== null ? new Set(input.policy.allowedKinds) : null;
  const precedence = input.policy.kindPrecedence;

  const scored = input.candidates.map((candidate, index) => {
    const assertion = byKey.get(candidate.key) ?? null;
    let learnedScore: number | null = null;
    let appliedPrior: AppliedPrior | null = null;
    if (assertion !== null) {
      const raw = assertion.statement[family.scoreField];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
        learnedScore = raw;
        appliedPrior = {
          assertionId: assertion.id,
          version: assertion.version,
          confidence: assertion.confidence,
          learnedScore: raw,
        };
      }
    }
    const score =
      learnedScore === null || appliedPrior === null
        ? roundScore(candidate.baseScore)
        : roundScore(candidate.baseScore * (1 - appliedPrior.confidence) + learnedScore * appliedPrior.confidence);

    const policyExcluded = allowed !== null && !allowed.has(candidate.kind);
    const policyTier =
      precedence !== null
        ? precedence.indexOf(candidate.kind) >= 0
          ? precedence.indexOf(candidate.kind)
          : precedence.length
        : 0;

    return {
      key: candidate.key,
      kind: candidate.kind,
      label: candidate.label,
      baseScore: candidate.baseScore,
      score,
      learnedScore,
      appliedPrior,
      policyTier,
      policyExcluded,
      inputIndex: index,
    };
  });

  const ordered = [...scored].sort((a, b) => {
    if (a.policyExcluded !== b.policyExcluded) return a.policyExcluded ? 1 : -1;
    if (a.policyTier !== b.policyTier) return a.policyTier - b.policyTier;
    if (a.score !== b.score) return b.score - a.score;
    return a.inputIndex - b.inputIndex;
  });

  return ordered.map(({ inputIndex: _inputIndex, ...rest }) => rest);
}
