// Pure validation/normalization logic of the learning module (no database).
// Everything a caller may put into an outcome, a measurement, a
// realization or a company-learning feedback record crosses these guards
// first; the SQL CHECK constraints in migrations/001-outcomes.sql and
// migrations/002-company-learning.sql mirror the load-bearing rules as
// defense in depth.
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
// The W041 guards keep the same discipline for company learnings: no
// caller can smuggle `id`, `tenantId`, `learningId`, `version`, `isCurrent`,
// `status`, `validFrom`, `recordedAt`, `recordedByPrincipal` — and above all
// NOT `authoritative`: a learned assertion is never authoritative (lock 14,
// ADR-0016 — "Explicit policy remains authoritative over learned
// preference"), so the read model's `authoritative: false` constant is
// system-minted and the input surface cannot even express a policy claim.
//
// Every shared primitive takes the error factory of its calling context, so
// a bad field reports the operation's own error code (invalid_outcome_input
// on definitions, invalid_measurement_input on measurements,
// invalid_learning_input on company-learning feedback, and so on) — the
// same discipline the missions module applies per operation.
//
// `assessRealization` is the single definition of expected-versus-realized:
// the deterministic math the service freezes onto the terminal realization
// row at settle time (unit-tested in isolation; W054/W055 consume the
// frozen result, never a re-derivation). `deriveLearningStatus` is the
// single definition of a company learning chain's read-time validity.

import type { TenantContext } from '@/infra/tenant';
import { LearningError } from './errors';
import type {
  LearningFeedbackChannel,
  LearningStatus,
  LearningTargetKind,
  OutcomeAssessment,
  OutcomeDirection,
  OutcomeEvidenceKind,
  OutcomePartyKind,
  OutcomeStatus,
  OutcomeSubjectKind,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001;
// the W041 vocabularies by those in migrations/002)
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
// W041 — Company Learning (versioned usefulness/preferences)
// ---------------------------------------------------------------------------

/** What a company-specific usefulness/preference is versioned for. */
export const LEARNING_TARGET_KINDS = [
  'source',
  'person',
  'agent',
  'extension',
  'mission',
  'channel',
  'process',
  'capability',
] as const;

/** The feedback legs that may produce a version (the item's three channels). */
export const LEARNING_FEEDBACK_CHANNELS = ['explicit', 'behavioral', 'outcome'] as const;

/** The derived read-time validity of a chain's current version. */
export const LEARNING_STATUSES = ['active', 'expired'] as const;

/**
 * Aspects are slugs: lowercase first, then letters/digits/dots/dashes/
 * underscores, at most 100 characters — queryable keys, not prose (W053's
 * CompanyModel owns the taxonomy).
 */
const ASPECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Learned assertion payloads stay modest; large artifacts belong to object storage. */
export const MAX_LEARNING_VALUE_BYTES = 16_384;

/** Aspects are capped by the slug pattern; the explicit constant mirrors it. */
export const MAX_ASPECT_LENGTH = 100;

const RECORD_LEARNING_INPUT_KEYS = [
  'target',
  'aspect',
  'value',
  'confidence',
  'channel',
  'reason',
  'evidence',
  'outcomeId',
  'validUntil',
  'actor',
] as const;

const LEARNING_TARGET_KEYS = ['kind', 'id', 'label'] as const;

const LIST_LEARNINGS_QUERY_KEYS = [
  'targetKind',
  'targetId',
  'aspect',
  'channel',
  'validity',
  'limit',
] as const;

const LIST_LEARNING_VERSIONS_QUERY_KEYS = ['learningId'] as const;

// ---------------------------------------------------------------------------
// W041 type guards
// ---------------------------------------------------------------------------

export function isLearningTargetKind(value: unknown): value is LearningTargetKind {
  return isOneOf(value, LEARNING_TARGET_KINDS);
}

export function isLearningFeedbackChannel(value: unknown): value is LearningFeedbackChannel {
  return isOneOf(value, LEARNING_FEEDBACK_CHANNELS);
}

export function isLearningStatus(value: unknown): value is LearningStatus {
  return isOneOf(value, LEARNING_STATUSES);
}

// ---------------------------------------------------------------------------
// W041 input validation
// ---------------------------------------------------------------------------

function learningInputError(message: string): LearningError {
  return new LearningError('invalid_learning_input', message);
}

/**
 * The subject a company-specific usefulness/preference is versioned for:
 * one of the target kinds plus the target record's REQUIRED uuid id (the
 * tie must be precise — the W040 subject rule) and an optional human
 * label. The reference is deliberately opaque: the owning module remains
 * the verification point — no cross-module foreign key, no contract
 * import (the W040 subject precedent).
 */
function validateLearningTarget(target: unknown, err: Err): ValidatedLearningTarget {
  if (!isPlainObject(target)) throw err('target must be an object');
  rejectUnknownKeys(target, LEARNING_TARGET_KEYS, 'target', err);
  if (!isLearningTargetKind(target.kind)) {
    throw err(
      `target.kind must be one of ${LEARNING_TARGET_KINDS.join(', ')} (got '${String(target.kind)}')`,
    );
  }
  const id = requireUuid(target.id, 'target.id', err);
  const label = optionalTrimmed(target.label, 'target.label', MAX_SUBJECT_LABEL_LENGTH, err);
  return { kind: target.kind, id, label };
}

/**
 * The aspect being versioned: trimmed, lowercased and matched against the
 * slug pattern (mirror of the migration 002 CHECK).
 */
function requireAspect(value: unknown, err: Err): string {
  const text = requireString(value, 'aspect', err).toLowerCase();
  if (!ASPECT_PATTERN.test(text)) {
    throw err(
      `aspect must be a slug (lowercase letters, digits, '.', '-', '_', at most ${MAX_ASPECT_LENGTH} characters; got '${text}')`,
    );
  }
  return text;
}

/**
 * The learned assertion's content: any non-null plain JSON value (the deep
 * check rejects class instances and non-JSON types), bounded in serialized
 * size so a preference assertion never becomes an artifact.
 */
function checkLearnedValue(value: unknown, err: Err): void {
  if (value === undefined || value === null) {
    throw err('value must be a non-null JSON value — the learned assertion needs content');
  }
  deepCheckJson(value, 'value', 0, err);
  const serialized = JSON.stringify(value) ?? '';
  if (serialized.length > MAX_LEARNING_VALUE_BYTES) {
    throw err(
      `value exceeds the maximum of ${MAX_LEARNING_VALUE_BYTES} bytes (${serialized.length}); large artifacts belong to object storage`,
    );
  }
}

/** Deep JSON check for learned values (same discipline as W040 payloads, local to this module). */
function deepCheckJson(value: unknown, where: string, depth: number, err: Err): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw err(`${where} must be finite (got ${String(value)})`);
    return;
  }
  if (type === 'undefined' || type === 'bigint' || type === 'symbol' || type === 'function') {
    throw err(`${where} contains a non-JSON value of type ${type}`);
  }
  if (depth > 64) {
    throw err(`${where} exceeds the maximum nesting depth of 64`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      deepCheckJson(entry, `${where}[${index}]`, depth + 1, err);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw err(`${where} must be a plain JSON value (no class instances)`);
  }
  for (const key of Object.keys(value)) {
    deepCheckJson(value[key], `${where}.${key}`, depth + 1, err);
  }
}

/** Confidence: a finite double in [0, 1] (ADR-0016 confidence metadata). */
function requireConfidence(value: unknown, err: Err): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw err(`confidence must be a finite number (got ${String(value)})`);
  }
  if (value < 0 || value > 1) {
    throw err(`confidence must be between 0 and 1 inclusive (got ${value})`);
  }
  return value;
}

/** Fully validated + normalized form of `recordCompanyLearning`'s input. */
export interface ValidatedRecordLearningInput {
  target: ValidatedLearningTarget;
  aspect: string;
  value: unknown;
  confidence: number;
  channel: LearningFeedbackChannel;
  reason: string;
  evidence: ValidatedEvidenceRef[];
  outcomeId: string | null;
  validUntil: string | null;
  actor: ValidatedParty;
}

/** Fully validated + normalized form of a learning target. */
export interface ValidatedLearningTarget {
  kind: LearningTargetKind;
  id: string;
  label: string | null;
}

export function validateRecordCompanyLearningInput(input: unknown): ValidatedRecordLearningInput {
  const err = learningInputError;
  if (!isPlainObject(input)) throw err('company learning input must be an object');
  rejectUnknownKeys(input, RECORD_LEARNING_INPUT_KEYS, 'the company learning input', err);

  const target = validateLearningTarget(input.target, err);
  const aspect = requireAspect(input.aspect, err);
  checkLearnedValue(input.value, err);
  const confidence = requireConfidence(input.confidence, err);

  if (!isLearningFeedbackChannel(input.channel)) {
    throw err(
      `channel must be one of ${LEARNING_FEEDBACK_CHANNELS.join(', ')} (got '${String(input.channel)}')`,
    );
  }
  const channel = input.channel;

  const reason = requireBoundedString(input.reason, 'reason', MAX_REASON_LENGTH, err);
  const evidence = validateEvidenceRefs(input.evidence ?? [], err);

  // The channel shapes (mirrored by migration 002 CHECKs): outcome feedback
  // is grounded in a settled W040 outcome; explicit feedback is a statement;
  // behavioral feedback is evidence-linked observed behavior.
  let outcomeId: string | null;
  if (input.outcomeId === undefined || input.outcomeId === null) {
    outcomeId = null;
  } else {
    outcomeId = requireUuid(input.outcomeId, 'outcomeId', err);
  }
  if (channel === 'outcome' && outcomeId === null) {
    throw err(
      'outcome feedback requires outcomeId — the settled outcome the feedback is grounded in',
    );
  }
  if (channel !== 'outcome' && outcomeId !== null) {
    throw err("outcomeId applies only to outcome feedback (channel 'outcome')");
  }
  if (channel === 'behavioral' && evidence.length === 0) {
    throw err(
      'behavioral feedback must cite at least one evidence reference — observed behavior is only learnable from evidence',
    );
  }

  const validUntil = optionalIsoDate(input.validUntil, 'validUntil', err);
  const actor = validateParty(input.actor, 'actor', err);

  return { target, aspect, value: input.value, confidence, channel, reason, evidence, outcomeId, validUntil, actor };
}

// ---------------------------------------------------------------------------
// W041 queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `listCompanyLearnings`' query. */
export interface ValidatedListLearningsQuery {
  targetKind: LearningTargetKind | null;
  targetId: string | null;
  aspect: string | null;
  channel: LearningFeedbackChannel | null;
  validity: LearningStatus | null;
  limit: number;
}

export function validateListCompanyLearningsQuery(query: unknown): ValidatedListLearningsQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('company learnings query must be an object');
  rejectUnknownKeys(query, LIST_LEARNINGS_QUERY_KEYS, 'the company learnings query', err);

  let targetKind: LearningTargetKind | null = null;
  if (query.targetKind !== undefined) {
    if (!isLearningTargetKind(query.targetKind)) {
      throw err(
        `targetKind must be one of ${LEARNING_TARGET_KINDS.join(', ')} (got '${String(query.targetKind)}')`,
      );
    }
    targetKind = query.targetKind;
  }

  let targetId: string | null = null;
  if (query.targetId !== undefined) {
    targetId = requireUuid(query.targetId, 'targetId', err);
    if (targetKind === null) {
      throw err('targetId requires targetKind — a target id is meaningless without its kind');
    }
  }

  let aspect: string | null = null;
  if (query.aspect !== undefined) {
    aspect = requireAspect(query.aspect, err);
  }

  let channel: LearningFeedbackChannel | null = null;
  if (query.channel !== undefined) {
    if (!isLearningFeedbackChannel(query.channel)) {
      throw err(
        `channel must be one of ${LEARNING_FEEDBACK_CHANNELS.join(', ')} (got '${String(query.channel)}')`,
      );
    }
    channel = query.channel;
  }

  let validity: LearningStatus | null = null;
  if (query.validity !== undefined) {
    if (!isLearningStatus(query.validity)) {
      throw err(`validity must be one of ${LEARNING_STATUSES.join(', ')} (got '${String(query.validity)}')`);
    }
    validity = query.validity;
  }

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

  return { targetKind, targetId, aspect, channel, validity, limit };
}

/** Fully validated + normalized form of `listCompanyLearningVersions`' query. */
export interface ValidatedListLearningVersionsQuery {
  learningId: string;
}

export function validateListCompanyLearningVersionsQuery(
  query: unknown,
): ValidatedListLearningVersionsQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('company learning versions query must be an object');
  rejectUnknownKeys(query, LIST_LEARNING_VERSIONS_QUERY_KEYS, 'the versions query', err);
  return { learningId: requireUuid(query.learningId, 'learningId', err) };
}

// ---------------------------------------------------------------------------
// The read-time validity derivation (single definition)
// ---------------------------------------------------------------------------

/**
 * The single definition of a chain's read-time validity: a null valid_until
 * holds forever; a dated one holds through the END of its day (UTC), then
 * the chain is 'expired'. Expired is not terminal — new feedback appends a
 * new version (see types.ts). The service applies this with the service
 * clock; unit tests exercise it in isolation.
 */
export function deriveLearningStatus(validUntil: string | null, at: Date): LearningStatus {
  if (validUntil === null) return 'active';
  const today = at.toISOString().slice(0, 10);
  return validUntil >= today ? 'active' : 'expired';
}
