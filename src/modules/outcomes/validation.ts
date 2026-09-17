// Pure validation/normalization logic of the outcomes module (no database).
// Everything a caller may put into an intervention, a realization, an
// abandonment or a prior query crosses these guards first; the SQL CHECK
// constraints in migrations/001-intervention-learning.sql mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `status`, `polarity`, `realization`, `abandonment`,
// `outcomeSummary`, `capabilityKey`, `metric`, `createdAt` or principal
// fields into a record input — the intervention's identity, tenancy,
// derived lifecycle, similarity key, definition snapshot and commit times
// are minted by the system (intervention records are auditable, and audit
// fields are not caller-forgeable). There is also deliberately NO revision
// input at all: an intervention definition is immutable (see types.ts) —
// the only writes after recording are the one terminal realization and,
// through it, the appended prior versions.
//
// Every shared primitive takes the error factory of its calling context, so
// a bad field reports the operation's own error code (the learning module's
// discipline).
//
// `computePriorUpdate` is the single definition of the intervention prior —
// the deterministic aggregate the service appends as one versioned learning
// update per realization (unit-tested in isolation; recommendations consume
// the RECORDED prior, never a re-derivation). `priorRecommendationSignal`
// is the single deterministic definition of the recommendation-quality
// signal a later similar recommendation derives from a recorded prior.

import type { TenantContext } from '@/infra/tenant';
import { OutcomesError } from './errors';
import type {
  EvidencePolarity,
  InterventionAssessment,
  InterventionKind,
  InterventionStatus,
  InterventionPartyKind,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/**
 * The intervention kinds — ARCHITECTURE.md §13's acquisition options
 * ("train employee; reassign work; hire human capability; recruit agent;
 * recruit agent team; install marketplace extension; build new extension;
 * outsource"), the vocabulary W018/W022/W023/W027's records hang off.
 */
export const INTERVENTION_KINDS = [
  'train_employee',
  'reassign_work',
  'hire_human',
  'recruit_agent',
  'recruit_agent_team',
  'install_extension',
  'build_extension',
  'outsource',
] as const;

/** Derived lifecycle (never stored on the definition row). */
export const INTERVENTION_STATUSES = ['active', 'realized', 'abandoned'] as const;

/** The learning module's frozen verdict vocabulary, consumed as-is. */
export const INTERVENTION_ASSESSMENTS = ['met', 'exceeded', 'missed'] as const;

/** The evidence polarity of a realized intervention. */
export const EVIDENCE_POLARITIES = ['positive', 'negative'] as const;

/** Kinds of parties that can make intervention changes (the missions vocabulary). */
export const INTERVENTION_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const MAX_GOAL_REFS = 16;
export const MAX_CAPABILITY_LABEL_LENGTH = 200;
export const MAX_CAPABILITY_KEY_LENGTH = 120;
export const MAX_REF_KIND_LENGTH = 60;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_TARGET_LABEL_LENGTH = 200;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_REASON_LENGTH = 2000;
export const MAX_SEARCH_LENGTH = 200;
/** Metric values are finite doubles within the JS safe-integer envelope. */
export const MAX_METRIC_VALUE = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
/**
 * Envelope for prior aggregates (sums over a sample): accommodates far more
 * than any realistic same-key sample of individually capped variances.
 */
export const MAX_AGGREGATE_VALUE = 9e18;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECORD_INPUT_KEYS = [
  'kind',
  'capabilityLabel',
  'target',
  'originGoalIds',
  'originRecommendationId',
  'authorizationRef',
  'originExecutionId',
  'outcomeId',
  'actor',
  'rationale',
] as const;

const REALIZE_INPUT_KEYS = ['interventionId', 'note', 'actor'] as const;

const ABANDON_INPUT_KEYS = ['interventionId', 'reason', 'actor'] as const;

const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const TARGET_KEYS = ['kind', 'id', 'label'] as const;
const GOAL_REF_KEYS = ['goalId', 'label'] as const;
const AUTHORIZATION_KEYS = ['kind', 'id', 'label'] as const;

const LIST_INTERVENTIONS_QUERY_KEYS = [
  'interventionKind',
  'capabilityKey',
  'status',
  'polarity',
  'outcomeId',
  'search',
  'limit',
] as const;

const PRIORS_QUERY_KEYS = ['interventionKind', 'capabilityKey', 'limit'] as const;

const PRIOR_VERSIONS_QUERY_KEYS = ['interventionKind', 'capabilityKey', 'limit'] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isInterventionKind(value: unknown): value is InterventionKind {
  return isOneOf(value, INTERVENTION_KINDS);
}

export function isInterventionStatus(value: unknown): value is InterventionStatus {
  return isOneOf(value, INTERVENTION_STATUSES);
}

export function isInterventionAssessment(value: unknown): value is InterventionAssessment {
  return isOneOf(value, INTERVENTION_ASSESSMENTS);
}

export function isEvidencePolarity(value: unknown): value is EvidencePolarity {
  return isOneOf(value, EVIDENCE_POLARITIES);
}

export function isInterventionPartyKind(value: unknown): value is InterventionPartyKind {
  return isOneOf(value, INTERVENTION_PARTY_KINDS);
}

/** Intervention-id shape guard (uuid); malformed ids are simply "not found". */
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

/**
 * The deterministic capability-similarity normalizer — the ONE way an
 * intervention's `capabilityKey` (and every query key) is formed, so later
 * similar recommendations compute the same key earlier interventions
 * learned under: trim, lowercase, whitespace/underscore runs → single
 * hyphens, collapsed, edge-stripped. Idempotent by construction.
 */
export function normalizeCapabilityKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertOutcomesTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new OutcomesError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new OutcomesError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new OutcomesError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// Shared primitive guards (each takes its calling context's error factory)
// ---------------------------------------------------------------------------

/** The error factory of one validation context. */
type Err = (message: string) => OutcomesError;

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

function requireLimit(value: unknown, err: Err): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw err(`limit must be a positive integer (got ${String(value)})`);
  }
  if (value > MAX_LIST_LIMIT) {
    throw err(`limit must be at most ${MAX_LIST_LIMIT} (got ${value})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Parties, targets, goal refs, authorization refs
// ---------------------------------------------------------------------------

export interface ValidatedParty {
  kind: InterventionPartyKind;
  id: string | null;
  label: string | null;
}

export interface ValidatedTarget {
  kind: string;
  id: string | null;
  label: string | null;
}

export interface ValidatedGoalRef {
  goalId: string;
  label: string | null;
}

export interface ValidatedAuthorizationRef {
  kind: string;
  id: string | null;
  label: string | null;
}

/**
 * Shared shape guard for actors: a provider-neutral kind plus an opaque
 * uuid id and/or a human-readable label (at least one — the party must be
 * traceable).
 */
function validateParty(party: unknown, where: string, err: Err): ValidatedParty {
  if (!isPlainObject(party)) throw err(`${where} must be an object`);
  rejectUnknownKeys(party, PARTY_KEYS, where, err);
  const kind = party.kind;
  if (!isInterventionPartyKind(kind)) {
    throw err(
      `${where}.kind must be one of ${INTERVENTION_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
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
 * The intervention's target: an opaque forward reference to the acted-on
 * module record (W018/W021/W022/W023/W025/W027/… own the verification
 * point). `kind` is the owner's open slug; at least one of id/label must
 * be present so the reference is traceable.
 */
function validateTarget(target: unknown, err: Err): ValidatedTarget {
  if (!isPlainObject(target)) throw err('target must be an object');
  rejectUnknownKeys(target, TARGET_KEYS, 'target', err);
  const kind = requireBoundedString(target.kind, 'target.kind', MAX_REF_KIND_LENGTH, err);
  const id =
    target.id === undefined || target.id === null
      ? null
      : requireUuid(target.id, 'target.id', err);
  const label = optionalTrimmed(target.label, 'target.label', MAX_TARGET_LABEL_LENGTH, err);
  if (id === null && label === null) {
    throw err('target must carry an id or a label — the reference must be traceable');
  }
  return { kind, id, label };
}

/** One originating-goal reference: a required goals-module uuid plus an optional label. */
function validateGoalRef(ref: unknown, where: string, err: Err): ValidatedGoalRef {
  if (!isPlainObject(ref)) throw err(`${where} must be an object`);
  rejectUnknownKeys(ref, GOAL_REF_KEYS, where, err);
  const goalId = requireUuid(ref.goalId, `${where}.goalId`, err);
  const label = optionalTrimmed(ref.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH, err);
  return { goalId, label };
}

function validateGoalRefs(value: unknown, err: Err): ValidatedGoalRef[] {
  if (!Array.isArray(value)) throw err('originGoalIds must be an array');
  if (value.length > MAX_GOAL_REFS) {
    throw err(`originGoalIds must hold at most ${MAX_GOAL_REFS} entries (got ${value.length})`);
  }
  const refs = value.map((entry, index) => validateGoalRef(entry, `originGoalIds[${index}]`, err));
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.goalId)) {
      throw err(`originating goals must be unique (duplicate '${ref.goalId}')`);
    }
    seen.add(ref.goalId);
  }
  return refs;
}

/**
 * The authorization reference: an opaque forward reference to the approval
 * decision that authorized execution (the actions module W009 owns the
 * authority matrix; it is not a declared W054 dependency, so the reference
 * is deliberately unvalidated beyond shape and traceability).
 */
function validateAuthorizationRef(ref: unknown, err: Err): ValidatedAuthorizationRef {
  if (!isPlainObject(ref)) throw err('authorizationRef must be an object');
  rejectUnknownKeys(ref, AUTHORIZATION_KEYS, 'authorizationRef', err);
  const kind = requireBoundedString(
    ref.kind,
    'authorizationRef.kind',
    MAX_REF_KIND_LENGTH,
    err,
  );
  const id =
    ref.id === undefined || ref.id === null
      ? null
      : requireUuid(ref.id, 'authorizationRef.id', err);
  const label = optionalTrimmed(ref.label, 'authorizationRef.label', MAX_PARTY_LABEL_LENGTH, err);
  if (id === null && label === null) {
    throw err('authorizationRef must carry an id or a label — the reference must be traceable');
  }
  return { kind, id, label };
}

// ---------------------------------------------------------------------------
// recordIntervention
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `recordIntervention`'s input. */
export interface ValidatedRecordInput {
  kind: InterventionKind;
  capabilityLabel: string;
  capabilityKey: string;
  target: ValidatedTarget | null;
  originGoalIds: ValidatedGoalRef[];
  originRecommendationId: string | null;
  authorizationRef: ValidatedAuthorizationRef | null;
  originExecutionId: string | null;
  outcomeId: string;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRecordInterventionInput(input: unknown): ValidatedRecordInput {
  const err = (message: string): OutcomesError =>
    new OutcomesError('invalid_intervention_input', message);
  if (!isPlainObject(input)) throw err('record input must be an object');
  rejectUnknownKeys(input, RECORD_INPUT_KEYS, 'the record input', err);

  if (!isInterventionKind(input.kind)) {
    throw err(`kind must be one of ${INTERVENTION_KINDS.join(', ')} (got '${String(input.kind)}')`);
  }
  const capabilityLabel = requireBoundedString(
    input.capabilityLabel,
    'capabilityLabel',
    MAX_CAPABILITY_LABEL_LENGTH,
    err,
  );
  const capabilityKey = normalizeCapabilityKey(capabilityLabel);
  if (capabilityKey === '') {
    throw err('capabilityLabel must normalize to a non-empty capability key');
  }
  if (capabilityKey.length > MAX_CAPABILITY_KEY_LENGTH) {
    throw err(
      `capabilityLabel must normalize to at most ${MAX_CAPABILITY_KEY_LENGTH} characters (got ${capabilityKey.length})`,
    );
  }

  const target =
    input.target === undefined || input.target === null ? null : validateTarget(input.target, err);
  const originGoalIds = validateGoalRefs(input.originGoalIds ?? [], err);
  const originRecommendationId =
    input.originRecommendationId === undefined || input.originRecommendationId === null
      ? null
      : requireUuid(input.originRecommendationId, 'originRecommendationId', err);
  const authorizationRef =
    input.authorizationRef === undefined || input.authorizationRef === null
      ? null
      : validateAuthorizationRef(input.authorizationRef, err);
  const originExecutionId =
    input.originExecutionId === undefined || input.originExecutionId === null
      ? null
      : requireUuid(input.originExecutionId, 'originExecutionId', err);
  const outcomeId = requireUuid(input.outcomeId, 'outcomeId', err);
  const actor = validateParty(input.actor, 'actor', err);
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, err);

  // ADR-0019: interventions are linked to their origin. At least one
  // originating link (goal, recommendation, authorization, execution) or a
  // precise target must be present — an intervention must be traceable to
  // where it came from.
  if (
    originGoalIds.length === 0 &&
    originRecommendationId === null &&
    authorizationRef === null &&
    originExecutionId === null &&
    target === null
  ) {
    throw err(
      'the intervention must carry at least one originating link (originGoalIds, originRecommendationId, authorizationRef, originExecutionId) or a target',
    );
  }

  return {
    kind: input.kind,
    capabilityLabel,
    capabilityKey,
    target,
    originGoalIds,
    originRecommendationId,
    authorizationRef,
    originExecutionId,
    outcomeId,
    actor,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// realizeIntervention / abandonIntervention
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `realizeIntervention`'s input. */
export interface ValidatedRealizeInput {
  interventionId: string;
  note: string | null;
  actor: ValidatedParty;
}

export function validateRealizeInterventionInput(input: unknown): ValidatedRealizeInput {
  const err = (message: string): OutcomesError =>
    new OutcomesError('invalid_realization_input', message);
  if (!isPlainObject(input)) throw err('realize input must be an object');
  rejectUnknownKeys(input, REALIZE_INPUT_KEYS, 'the realize input', err);
  const interventionId = requireUuid(input.interventionId, 'interventionId', err);
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);
  return { interventionId, note, actor };
}

/** Fully validated + normalized form of `abandonIntervention`'s input. */
export interface ValidatedAbandonInput {
  interventionId: string;
  reason: string;
  actor: ValidatedParty;
}

export function validateAbandonInterventionInput(input: unknown): ValidatedAbandonInput {
  const err = (message: string): OutcomesError =>
    new OutcomesError('invalid_abandonment_input', message);
  if (!isPlainObject(input)) throw err('abandonment input must be an object');
  rejectUnknownKeys(input, ABANDON_INPUT_KEYS, 'the abandonment input', err);
  const interventionId = requireUuid(input.interventionId, 'interventionId', err);
  const reason = requireBoundedString(input.reason, 'reason', MAX_REASON_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);
  return { interventionId, reason, actor };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `listInterventions`' query. */
export interface ValidatedListInterventionsQuery {
  interventionKind: InterventionKind | null;
  capabilityKey: string | null;
  status: InterventionStatus | null;
  polarity: EvidencePolarity | null;
  outcomeId: string | null;
  search: string | null;
  limit: number;
}

export function validateListInterventionsQuery(query: unknown): ValidatedListInterventionsQuery {
  const err = (message: string): OutcomesError => new OutcomesError('invalid_query', message);
  if (!isPlainObject(query)) throw err('list query must be an object');
  rejectUnknownKeys(query, LIST_INTERVENTIONS_QUERY_KEYS, 'the list query', err);

  let interventionKind: InterventionKind | null = null;
  if (query.interventionKind !== undefined) {
    if (!isInterventionKind(query.interventionKind)) {
      throw err(
        `interventionKind must be one of ${INTERVENTION_KINDS.join(', ')} (got '${String(query.interventionKind)}')`,
      );
    }
    interventionKind = query.interventionKind;
  }

  let capabilityKey: string | null = null;
  if (query.capabilityKey !== undefined) {
    const raw = requireBoundedString(
      query.capabilityKey,
      'capabilityKey',
      MAX_CAPABILITY_LABEL_LENGTH,
      err,
    );
    capabilityKey = normalizeCapabilityKey(raw);
    if (capabilityKey === '') {
      throw err('capabilityKey must normalize to a non-empty key');
    }
  }

  let status: InterventionStatus | null = null;
  if (query.status !== undefined) {
    if (!isInterventionStatus(query.status)) {
      throw err(`status must be one of ${INTERVENTION_STATUSES.join(', ')} (got '${String(query.status)}')`);
    }
    status = query.status;
  }

  let polarity: EvidencePolarity | null = null;
  if (query.polarity !== undefined) {
    if (!isEvidencePolarity(query.polarity)) {
      throw err(`polarity must be one of ${EVIDENCE_POLARITIES.join(', ')} (got '${String(query.polarity)}')`);
    }
    polarity = query.polarity;
    if (status !== null && status !== 'realized') {
      throw err("polarity only applies to realized interventions (filter with status 'realized')");
    }
  }

  const outcomeId =
    query.outcomeId === undefined ? null : requireUuid(query.outcomeId, 'outcomeId', err);
  const search =
    query.search === undefined
      ? null
      : requireBoundedString(query.search, 'search', MAX_SEARCH_LENGTH, err);
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : requireLimit(query.limit, err);

  return {
    interventionKind,
    capabilityKey,
    status,
    polarity,
    outcomeId,
    search,
    limit,
  };
}

/** Fully validated + normalized form of `getInterventionPriors`' query. */
export interface ValidatedPriorsQuery {
  interventionKind: InterventionKind | null;
  capabilityKey: string | null;
  limit: number;
}

export function validateGetInterventionPriorsQuery(query: unknown): ValidatedPriorsQuery {
  const err = (message: string): OutcomesError => new OutcomesError('invalid_query', message);
  if (!isPlainObject(query)) throw err('priors query must be an object');
  rejectUnknownKeys(query, PRIORS_QUERY_KEYS, 'the priors query', err);

  let interventionKind: InterventionKind | null = null;
  if (query.interventionKind !== undefined) {
    if (!isInterventionKind(query.interventionKind)) {
      throw err(
        `interventionKind must be one of ${INTERVENTION_KINDS.join(', ')} (got '${String(query.interventionKind)}')`,
      );
    }
    interventionKind = query.interventionKind;
  }

  let capabilityKey: string | null = null;
  if (query.capabilityKey !== undefined) {
    const raw = requireBoundedString(
      query.capabilityKey,
      'capabilityKey',
      MAX_CAPABILITY_LABEL_LENGTH,
      err,
    );
    capabilityKey = normalizeCapabilityKey(raw);
    if (capabilityKey === '') {
      throw err('capabilityKey must normalize to a non-empty key');
    }
  }

  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : requireLimit(query.limit, err);
  return { interventionKind, capabilityKey, limit };
}

/** Fully validated + normalized form of `listInterventionPriorVersions`' query. */
export interface ValidatedPriorVersionsQuery {
  interventionKind: InterventionKind;
  capabilityKey: string;
  limit: number;
}

export function validateListInterventionPriorVersionsQuery(
  query: unknown,
): ValidatedPriorVersionsQuery {
  const err = (message: string): OutcomesError => new OutcomesError('invalid_query', message);
  if (!isPlainObject(query)) throw err('prior-versions query must be an object');
  rejectUnknownKeys(query, PRIOR_VERSIONS_QUERY_KEYS, 'the prior-versions query', err);

  if (!isInterventionKind(query.interventionKind)) {
    throw err(
      `interventionKind must be one of ${INTERVENTION_KINDS.join(', ')} (got '${String(query.interventionKind)}')`,
    );
  }
  const rawKey = requireBoundedString(
    query.capabilityKey,
    'capabilityKey',
    MAX_CAPABILITY_LABEL_LENGTH,
    err,
  );
  const capabilityKey = normalizeCapabilityKey(rawKey);
  if (capabilityKey === '') {
    throw err('capabilityKey must normalize to a non-empty key');
  }
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : requireLimit(query.limit, err);
  return { interventionKind: query.interventionKind, capabilityKey, limit };
}

// ---------------------------------------------------------------------------
// The intervention prior (single definition, appended per realization)
// ---------------------------------------------------------------------------

/** One realized intervention's contribution to a prior sample. */
export interface PriorSampleEntry {
  interventionId: string;
  assessment: InterventionAssessment;
  expected: number;
  realizedValue: number;
  varianceVsExpected: number;
}

/** The deterministic aggregate `computePriorUpdate` produces. */
export interface PriorAggregate {
  sampleSize: number;
  successes: number;
  failures: number;
  successRate: number;
  expectedSum: number;
  realizedSum: number;
  netVariance: number;
  meanVariance: number;
  evidenceInterventionIds: string[];
}

function boundedAggregate(value: number, field: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_AGGREGATE_VALUE) {
    throw new OutcomesError(
      'invalid_realization_input',
      `the prior aggregate's ${field} leaves the storable envelope (±${MAX_AGGREGATE_VALUE}) — the sample is not representable`,
    );
  }
  return value;
}

/**
 * The single definition of the intervention prior (W054's learning
 * update): deterministic, pure, polarity-aware. `realizeIntervention`
 * appends this as one versioned `intervention_priors` row per realization;
 * recommendations consume the RECORDED prior, never a re-derivation.
 *
 *  * successes  — assessments 'met'/'exceeded' (positive evidence);
 *  * failures   — assessments 'missed' (RETAINED negative evidence);
 *  * successRate — successes / sampleSize, in [0, 1];
 *  * netVariance / meanVariance — Σ(realized − expected) and its mean, the
 *    learned expected-value correction (arithmetic over the sample's metric
 *    values; comparing across metrics is the caller's interpretation — the
 *    W040 summarizeRealization precedent).
 *
 * Abandoned interventions never enter the sample: nothing was realized, so
 * there is no evidence to aggregate (they stay retained as records).
 */
export function computePriorUpdate(samples: readonly PriorSampleEntry[]): PriorAggregate {
  if (samples.length === 0) {
    throw new OutcomesError(
      'invalid_realization_input',
      'a prior update requires at least one realized intervention in the sample',
    );
  }
  let successes = 0;
  let failures = 0;
  let expectedSum = 0;
  let realizedSum = 0;
  let netVariance = 0;
  const evidenceInterventionIds: string[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (!isUuid(sample.interventionId)) {
      throw new OutcomesError(
        'invalid_realization_input',
        'a prior sample entry must carry a uuid interventionId',
      );
    }
    if (seen.has(sample.interventionId)) {
      throw new OutcomesError(
        'invalid_realization_input',
        `a prior sample must hold each intervention once (duplicate '${sample.interventionId}')`,
      );
    }
    seen.add(sample.interventionId);
    if (sample.assessment === 'missed') failures += 1;
    else successes += 1;
    expectedSum += sample.expected;
    realizedSum += sample.realizedValue;
    netVariance += sample.varianceVsExpected;
    evidenceInterventionIds.push(sample.interventionId);
  }
  const sampleSize = samples.length;
  return {
    sampleSize,
    successes,
    failures,
    successRate: successes / sampleSize,
    expectedSum: boundedAggregate(expectedSum, 'expectedSum'),
    realizedSum: boundedAggregate(realizedSum, 'realizedSum'),
    netVariance: boundedAggregate(netVariance, 'netVariance'),
    meanVariance: boundedAggregate(netVariance / sampleSize, 'meanVariance'),
    evidenceInterventionIds,
  };
}

// ---------------------------------------------------------------------------
// The recommendation signal (single deterministic definition)
// ---------------------------------------------------------------------------

/** The deterministic recommendation-quality signal derived from a prior. */
export interface PriorRecommendationSignal {
  /** favor > 50% success, mixed = 50%, caution < 50%. */
  stance: 'favor' | 'mixed' | 'caution';
  /** Evidence strength by sample size: 1, 2–4, 5–19, 20+. */
  strength: 'single_observation' | 'weak' | 'moderate' | 'strong';
  sampleSize: number;
  successRate: number;
  /** The learned expected-value correction (metric units — see computePriorUpdate). */
  meanVariance: number;
}

/**
 * The single deterministic definition of the recommendation-quality signal
 * a later similar recommendation derives from a RECORDED intervention
 * prior — the sanctioned consumption of learned evidence (ADR-0019:
 * "Future recommendations may improve only through explicit, evidence-
 * linked learning updates"). Pure and advisory-only: it informs
 * recommendation quality and never overrides policy (lock 14 — the W009
 * authority matrix stays the gate).
 */
export function priorRecommendationSignal(prior: {
  sampleSize: number;
  successes: number;
  failures: number;
  successRate: number;
  meanVariance: number;
}): PriorRecommendationSignal {
  if (
    !Number.isInteger(prior.sampleSize) ||
    prior.sampleSize < 1 ||
    !Number.isInteger(prior.successes) ||
    !Number.isInteger(prior.failures) ||
    prior.successes + prior.failures !== prior.sampleSize
  ) {
    throw new OutcomesError(
      'invalid_query',
      'a recommendation signal requires a consistent prior sample (successes + failures = sampleSize, sampleSize ≥ 1)',
    );
  }
  const stance: PriorRecommendationSignal['stance'] =
    prior.successRate > 0.5 ? 'favor' : prior.successRate === 0.5 ? 'mixed' : 'caution';
  const strength: PriorRecommendationSignal['strength'] =
    prior.sampleSize >= 20
      ? 'strong'
      : prior.sampleSize >= 5
        ? 'moderate'
        : prior.sampleSize >= 2
          ? 'weak'
          : 'single_observation';
  return {
    stance,
    strength,
    sampleSize: prior.sampleSize,
    successRate: prior.successRate,
    meanVariance: prior.meanVariance,
  };
}
