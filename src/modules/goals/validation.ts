// Pure validation/normalization logic of the goals module (no database).
// Everything a caller may put into a goal crosses these guards first; the
// SQL CHECK constraints in migrations/001-goals.sql mirror the load-bearing
// rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `status` (on create), `changeKind`, `recordedAt`
// or `changedByPrincipal` into an input — the goal's identity, tenancy,
// version number, lifecycle on creation, change classification, commit time
// and acting principal are minted by the system (part of the W008
// acceptance: goal changes are auditable, and audit fields are not
// caller-forgeable).
//
// Revision patches are validated as SHAPES here; cross-field invariants
// that span the patch and the current version (horizon start < end) are
// re-checked by the service on the MERGED snapshot via
// `validateGoalContent` — the same validator create uses, so a revised goal
// is exactly as well-formed as a freshly created one.

import type { TenantContext } from '@/infra/tenant';
import { GoalsError } from './errors';
import type {
  CreateGoalInput,
  GetGoalVersionQuery,
  GoalChangeKind,
  GoalEvidenceSourceKind,
  GoalMetricDirection,
  GoalPartyKind,
  GoalPriority,
  GoalStatus,
  ListGoalsQuery,
  ListGoalVersionsQuery,
  ReviseGoalInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const GOAL_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export const GOAL_STATUSES = ['active', 'archived'] as const;

export const GOAL_CHANGE_KINDS = ['created', 'revised', 'archived', 'reactivated'] as const;

/** Kinds of parties that can own goals or make goal changes. */
export const GOAL_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** Goal evidence-source kinds — the observations module's source vocabulary. */
export const GOAL_EVIDENCE_SOURCE_KINDS = [
  'source',
  'person',
  'agent',
  'system',
  'external',
] as const;

export const GOAL_METRIC_DIRECTIONS = ['at_least', 'at_most', 'in_range'] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const MAX_METRICS_PER_GOAL = 16;
export const MAX_EVIDENCE_SOURCES = 16;
export const MAX_TITLE_LENGTH = 200;
export const MAX_OBJECTIVE_LENGTH = 2000;
export const MAX_DESIRED_STATE_LENGTH = 4000;
export const MAX_SUCCESS_CRITERIA_LENGTH = 4000;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_METRIC_NAME_LENGTH = 100;
export const MAX_METRIC_UNIT_LENGTH = 50;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METRIC_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// Strict ISO 8601 with an explicit offset — goal timestamps are unambiguous
// (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const CREATE_INPUT_KEYS = [
  'title',
  'objective',
  'desiredState',
  'metrics',
  'horizonStart',
  'horizonEnd',
  'owner',
  'priority',
  'evidenceSources',
  'successCriteria',
  'actor',
  'rationale',
] as const;

const REVISION_INPUT_KEYS = [
  'goalId',
  'title',
  'objective',
  'desiredState',
  'metrics',
  'horizonStart',
  'horizonEnd',
  'owner',
  'priority',
  'evidenceSources',
  'successCriteria',
  'status',
  'actor',
  'rationale',
] as const;

// The patch fields of a revision are tracked dynamically (the `changed`
// list below) as they are validated, so a revision must change at least one
// of them, and a `status` change must be the only one (surgical lifecycle).

const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const METRIC_KEYS = ['name', 'unit', 'direction', 'threshold', 'lowerBound', 'upperBound'] as const;
const LIST_QUERY_KEYS = [
  'status',
  'priority',
  'ownerKind',
  'ownerId',
  'horizonEndFrom',
  'horizonEndTo',
  'search',
  'limit',
] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isGoalPriority(value: unknown): value is GoalPriority {
  return isOneOf(value, GOAL_PRIORITIES);
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return isOneOf(value, GOAL_STATUSES);
}

export function isGoalChangeKind(value: unknown): value is GoalChangeKind {
  return isOneOf(value, GOAL_CHANGE_KINDS);
}

export function isGoalPartyKind(value: unknown): value is GoalPartyKind {
  return isOneOf(value, GOAL_PARTY_KINDS);
}

export function isGoalEvidenceSourceKind(value: unknown): value is GoalEvidenceSourceKind {
  return isOneOf(value, GOAL_EVIDENCE_SOURCE_KINDS);
}

export function isGoalMetricDirection(value: unknown): value is GoalMetricDirection {
  return isOneOf(value, GOAL_METRIC_DIRECTIONS);
}

/** Goal-id shape guard (uuid); malformed ids are simply "not found". */
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
export function assertGoalTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new GoalsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new GoalsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new GoalsError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// Shared primitive guards
// ---------------------------------------------------------------------------

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
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new GoalsError(
        'invalid_goal_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function optionalTrimmed(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireIsoInstant(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw inputError(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${text}')`,
    );
  }
  return text;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw inputError(`${field} must be a finite number (got ${String(value)})`);
  }
  return value;
}

function inputError(message: string): GoalsError {
  return new GoalsError('invalid_goal_input', message);
}

function revisionError(message: string): GoalsError {
  return new GoalsError('invalid_revision_input', message);
}

function queryError(message: string): GoalsError {
  return new GoalsError('invalid_query', message);
}

// ---------------------------------------------------------------------------
// Parties (owner/actor) and evidence sources
// ---------------------------------------------------------------------------

export interface ValidatedParty {
  kind: GoalPartyKind;
  id: string | null;
  label: string | null;
}

export interface ValidatedEvidenceSource {
  kind: GoalEvidenceSourceKind;
  id: string | null;
  label: string | null;
}

/**
 * Shared shape guard for owner/actor parties: a provider-neutral kind plus
 * an opaque uuid id and/or a human-readable label (at least one — the
 * party must be traceable). Ids are uuids because they reference records
 * of the owning modules (people/persons, world entities, agents, sources).
 */
function validateParty(party: unknown, where: string): ValidatedParty {
  if (!isPlainObject(party)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(party, PARTY_KEYS, where);
  const kind = party.kind;
  if (!isGoalPartyKind(kind)) {
    throw inputError(
      `${where}.kind must be one of ${GOAL_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id =
    party.id === undefined || party.id === null ? null : requireUuid(party.id, `${where}.id`);
  const label = optionalTrimmed(party.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH);
  if (id === null && label === null) {
    throw inputError(`${where} must carry an id or a label — the party must be traceable`);
  }
  return { kind, id, label };
}

function validateEvidenceSource(source: unknown, where: string): ValidatedEvidenceSource {
  if (!isPlainObject(source)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(source, PARTY_KEYS, where);
  const kind = source.kind;
  if (!isGoalEvidenceSourceKind(kind)) {
    throw inputError(
      `${where}.kind must be one of ${GOAL_EVIDENCE_SOURCE_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id =
    source.id === undefined || source.id === null
      ? null
      : requireUuid(source.id, `${where}.id`);
  const label = optionalTrimmed(source.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH);
  if (id === null && label === null) {
    throw inputError(`${where} must carry an id or a label — evidence sources must be traceable`);
  }
  return { kind, id, label };
}

function validateEvidenceSources(value: unknown): ValidatedEvidenceSource[] {
  if (!Array.isArray(value)) throw inputError('evidenceSources must be an array');
  if (value.length > MAX_EVIDENCE_SOURCES) {
    throw inputError(
      `evidenceSources must hold at most ${MAX_EVIDENCE_SOURCES} entries (got ${value.length})`,
    );
  }
  return value.map((entry, index) => validateEvidenceSource(entry, `evidenceSources[${index}]`));
}

// ---------------------------------------------------------------------------
// Metrics / thresholds
// ---------------------------------------------------------------------------

export interface ValidatedMetric {
  name: string;
  unit: string | null;
  direction: GoalMetricDirection;
  threshold: number | null;
  lowerBound: number | null;
  upperBound: number | null;
}

function validateMetric(metric: unknown, where: string): ValidatedMetric {
  if (!isPlainObject(metric)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(metric, METRIC_KEYS, where);

  const name = requireString(metric.name, `${where}.name`);
  if (!METRIC_NAME_PATTERN.test(name)) {
    throw inputError(
      `${where}.name must be a canonical metric key matching ${METRIC_NAME_PATTERN.source} (got '${name}')`,
    );
  }

  const unit =
    metric.unit === undefined || metric.unit === null
      ? null
      : requireBoundedString(metric.unit, `${where}.unit`, MAX_METRIC_UNIT_LENGTH);

  const direction = metric.direction;
  if (!isGoalMetricDirection(direction)) {
    throw inputError(
      `${where}.direction must be one of ${GOAL_METRIC_DIRECTIONS.join(', ')} (got '${String(direction)}')`,
    );
  }

  const hasThreshold = metric.threshold !== undefined && metric.threshold !== null;
  const hasLower = metric.lowerBound !== undefined && metric.lowerBound !== null;
  const hasUpper = metric.upperBound !== undefined && metric.upperBound !== null;

  if (direction === 'in_range') {
    if (hasThreshold) {
      throw inputError(`${where}: an in_range metric takes bounds, not a threshold`);
    }
    if (!hasLower || !hasUpper) {
      throw inputError(`${where}: an in_range metric requires both lowerBound and upperBound`);
    }
    const lowerBound = requireFiniteNumber(metric.lowerBound, `${where}.lowerBound`);
    const upperBound = requireFiniteNumber(metric.upperBound, `${where}.upperBound`);
    if (lowerBound > upperBound) {
      throw inputError(
        `${where}.lowerBound must not exceed ${where}.upperBound (${lowerBound} > ${upperBound})`,
      );
    }
    return { name, unit, direction, threshold: null, lowerBound, upperBound };
  }

  if (hasLower || hasUpper) {
    throw inputError(
      `${where}: a ${direction} metric takes a threshold, not bounds — use direction 'in_range' for a window`,
    );
  }
  if (!hasThreshold) {
    throw inputError(`${where}: a ${direction} metric requires a threshold`);
  }
  const threshold = requireFiniteNumber(metric.threshold, `${where}.threshold`);
  return { name, unit, direction, threshold, lowerBound: null, upperBound: null };
}

function validateMetrics(value: unknown): ValidatedMetric[] {
  if (!Array.isArray(value)) throw inputError('metrics must be an array');
  if (value.length > MAX_METRICS_PER_GOAL) {
    throw inputError(
      `metrics must hold at most ${MAX_METRICS_PER_GOAL} entries (got ${value.length})`,
    );
  }
  const metrics = value.map((entry, index) => validateMetric(entry, `metrics[${index}]`));
  const seen = new Set<string>();
  for (const metric of metrics) {
    if (seen.has(metric.name)) {
      throw inputError(`metric names must be unique within a goal (duplicate '${metric.name}')`);
    }
    seen.add(metric.name);
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Full content (shared by create and by the service's merged-revision path)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of a goal's content fields. */
export interface ValidatedGoalContent {
  title: string;
  objective: string;
  desiredState: string;
  metrics: ValidatedMetric[];
  horizonStart: string | null;
  horizonEnd: string;
  owner: ValidatedParty;
  priority: GoalPriority;
  evidenceSources: ValidatedEvidenceSource[];
  successCriteria: string;
}

const CONTENT_KEYS = [
  'title',
  'objective',
  'desiredState',
  'metrics',
  'horizonStart',
  'horizonEnd',
  'owner',
  'priority',
  'evidenceSources',
  'successCriteria',
] as const;

/**
 * Validates a FULL goal content object (no actor/rationale — those belong to
 * the change, not the content). Used directly by `createGoal` and by the
 * service on the merged (current ⊕ patch) snapshot of a revision, so a
 * revised goal is exactly as well-formed as a freshly created one.
 */
export function validateGoalContent(content: unknown): ValidatedGoalContent {
  if (!isPlainObject(content)) throw inputError('goal content must be an object');
  rejectUnknownKeys(content, CONTENT_KEYS, 'the goal content');

  const title = requireBoundedString(content.title, 'title', MAX_TITLE_LENGTH);
  const objective = requireBoundedString(content.objective, 'objective', MAX_OBJECTIVE_LENGTH);
  const desiredState = requireBoundedString(
    content.desiredState,
    'desiredState',
    MAX_DESIRED_STATE_LENGTH,
  );
  const successCriteria = requireBoundedString(
    content.successCriteria,
    'successCriteria',
    MAX_SUCCESS_CRITERIA_LENGTH,
  );

  const metrics = validateMetrics(content.metrics);

  const horizonStart =
    content.horizonStart === undefined || content.horizonStart === null
      ? null
      : requireIsoInstant(content.horizonStart, 'horizonStart');
  const horizonEnd = requireIsoInstant(content.horizonEnd, 'horizonEnd');
  if (horizonStart !== null && Date.parse(horizonStart) >= Date.parse(horizonEnd)) {
    throw inputError(
      `horizonStart must be strictly before horizonEnd (${horizonStart} >= ${horizonEnd})`,
    );
  }

  const owner = validateParty(content.owner, 'owner');
  if (!isGoalPriority(content.priority)) {
    throw inputError(
      `priority must be one of ${GOAL_PRIORITIES.join(', ')} (got '${String(content.priority)}')`,
    );
  }
  const evidenceSources = validateEvidenceSources(content.evidenceSources);

  return {
    title,
    objective,
    desiredState,
    metrics,
    horizonStart,
    horizonEnd,
    owner,
    priority: content.priority,
    evidenceSources,
    successCriteria,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CreateGoalInput`. */
export interface ValidatedCreateGoalInput {
  content: ValidatedGoalContent;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateCreateGoalInput(input: CreateGoalInput): ValidatedCreateGoalInput {
  if (!isPlainObject(input)) throw inputError('goal input must be an object');
  rejectUnknownKeys(input, CREATE_INPUT_KEYS, 'the goal input');

  const content = validateGoalContent({
    title: input.title,
    objective: input.objective,
    desiredState: input.desiredState,
    metrics: input.metrics ?? [],
    horizonStart: input.horizonStart ?? null,
    horizonEnd: input.horizonEnd,
    owner: input.owner,
    priority: input.priority,
    evidenceSources: input.evidenceSources ?? [],
    successCriteria: input.successCriteria,
  });
  const actor = validateParty(input.actor, 'actor');
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH);
  return { content, actor, rationale };
}

// ---------------------------------------------------------------------------
// Revise (patch shape; the service merges and re-validates the content)
// ---------------------------------------------------------------------------

/** The validated patch fields of a revision (undefined = carry over). */
export interface ValidatedRevisionPatch {
  title?: string;
  objective?: string;
  desiredState?: string;
  metrics?: ValidatedMetric[];
  /** Tri-state: undefined = unchanged, null = cleared, string = set. */
  horizonStart?: string | null;
  horizonEnd?: string;
  owner?: ValidatedParty;
  priority?: GoalPriority;
  evidenceSources?: ValidatedEvidenceSource[];
  successCriteria?: string;
  status?: GoalStatus;
}

/** Fully validated + normalized form of `ReviseGoalInput`. */
export interface ValidatedRevisionInput {
  goalId: string;
  patch: ValidatedRevisionPatch;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseGoalInput(input: ReviseGoalInput): ValidatedRevisionInput {
  try {
    return validateReviseGoalInputInner(input);
  } catch (error) {
    // The shared field guards throw `invalid_goal_input`; for a revision
    // the correct code is `invalid_revision_input` (the events module's
    // query-wrapper precedent for code remapping).
    if (error instanceof GoalsError && error.code === 'invalid_goal_input') {
      throw new GoalsError('invalid_revision_input', error.message);
    }
    throw error;
  }
}

function validateReviseGoalInputInner(input: ReviseGoalInput): ValidatedRevisionInput {
  if (!isPlainObject(input)) throw revisionError('revision input must be an object');
  rejectRevisionUnknownKeys(input);

  const goalId = requireUuid(input.goalId, 'goalId');

  const patch: ValidatedRevisionPatch = {};
  const changed: string[] = [];

  if (input.title !== undefined) {
    patch.title = requireBoundedString(input.title, 'title', MAX_TITLE_LENGTH);
    changed.push('title');
  }
  if (input.objective !== undefined) {
    patch.objective = requireBoundedString(input.objective, 'objective', MAX_OBJECTIVE_LENGTH);
    changed.push('objective');
  }
  if (input.desiredState !== undefined) {
    patch.desiredState = requireBoundedString(
      input.desiredState,
      'desiredState',
      MAX_DESIRED_STATE_LENGTH,
    );
    changed.push('desiredState');
  }
  if (input.metrics !== undefined) {
    patch.metrics = validateMetrics(input.metrics);
    changed.push('metrics');
  }
  if (input.horizonStart !== undefined) {
    // Tri-state: null clears the horizon start; a string sets it. The
    // start < end invariant is checked on the MERGED content by the service.
    patch.horizonStart =
      input.horizonStart === null ? null : requireIsoInstant(input.horizonStart, 'horizonStart');
    changed.push('horizonStart');
  }
  if (input.horizonEnd !== undefined) {
    patch.horizonEnd = requireIsoInstant(input.horizonEnd, 'horizonEnd');
    changed.push('horizonEnd');
  }
  if (input.owner !== undefined) {
    patch.owner = validateParty(input.owner, 'owner');
    changed.push('owner');
  }
  if (input.priority !== undefined) {
    if (!isGoalPriority(input.priority)) {
      throw revisionError(
        `priority must be one of ${GOAL_PRIORITIES.join(', ')} (got '${String(input.priority)}')`,
      );
    }
    patch.priority = input.priority;
    changed.push('priority');
  }
  if (input.evidenceSources !== undefined) {
    patch.evidenceSources = validateEvidenceSources(input.evidenceSources);
    changed.push('evidenceSources');
  }
  if (input.successCriteria !== undefined) {
    patch.successCriteria = requireBoundedString(
      input.successCriteria,
      'successCriteria',
      MAX_SUCCESS_CRITERIA_LENGTH,
    );
    changed.push('successCriteria');
  }
  if (input.status !== undefined) {
    if (!isGoalStatus(input.status)) {
      throw revisionError(
        `status must be one of ${GOAL_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    patch.status = input.status;
    changed.push('status');
  }

  if (changed.length === 0) {
    throw revisionError(
      'a revision must change at least one field (title, objective, desiredState, metrics, horizon, owner, priority, evidenceSources, successCriteria or status)',
    );
  }
  if (patch.status !== undefined && changed.length > 1) {
    throw revisionError(
      `a status change must be the only change in its revision (also changed: ${changed
        .filter((field) => field !== 'status')
        .join(', ')}) — lifecycle transitions are surgical so the audit trail never conflates them with content revisions`,
    );
  }

  const actor = validateParty(input.actor, 'actor');
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH);
  return { goalId, patch, actor, rationale };
}

/**
 * Unknown-key rejection for revisions uses `invalid_revision_input` (the
 * input IS a revision), including the system-minted fields a caller must
 * never supply: version, changeKind, recordedAt, changedByPrincipal.
 */
function rejectRevisionUnknownKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!(REVISION_INPUT_KEYS as readonly string[]).includes(key)) {
      throw new GoalsError(
        'invalid_revision_input',
        `unknown field '${key}' on the revision input (allowed: ${REVISION_INPUT_KEYS.join(', ')})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Change-kind derivation (pure)
// ---------------------------------------------------------------------------

/**
 * Derives the change kind of a new version from the status transition.
 * Version 1 is always 'created'; an active → archived transition is
 * 'archived'; archived → active is 'reactivated'; anything else is a
 * content 'revised' change. (With only two statuses this is exhaustive.)
 */
export function deriveChangeKind(
  previousStatus: GoalStatus | null,
  nextStatus: GoalStatus,
): GoalChangeKind {
  if (previousStatus === null) return 'created';
  if (previousStatus === nextStatus) return 'revised';
  return previousStatus === 'active' && nextStatus === 'archived' ? 'archived' : 'reactivated';
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ListGoalsQuery`. */
export interface ValidatedListQuery {
  status: GoalStatus | null;
  priority: GoalPriority | null;
  ownerKind: GoalPartyKind | null;
  ownerId: string | null;
  horizonEndFrom: Date | null;
  horizonEndTo: Date | null;
  search: string | null;
  limit: number;
}

export function validateListGoalsQuery(query: ListGoalsQuery): ValidatedListQuery {
  try {
    return validateListGoalsQueryInner(query);
  } catch (error) {
    if (error instanceof GoalsError && error.code === 'invalid_goal_input') {
      throw new GoalsError('invalid_query', error.message);
    }
    throw error;
  }
}

function validateListGoalsQueryInner(query: ListGoalsQuery): ValidatedListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_QUERY_KEYS.join(', ')})`,
    );
  }

  const status =
    query.status === undefined ? null : requireQueryEnum(query.status, 'query.status', GOAL_STATUSES);
  const priority =
    query.priority === undefined
      ? null
      : requireQueryEnum(query.priority, 'query.priority', GOAL_PRIORITIES);
  const ownerKind =
    query.ownerKind === undefined
      ? null
      : requireQueryEnum(query.ownerKind, 'query.ownerKind', GOAL_PARTY_KINDS);

  const ownerIdRaw = query.ownerId === undefined ? null : requireString(query.ownerId, 'query.ownerId');
  if (ownerIdRaw !== null && ownerKind === null) {
    throw queryError(
      'query.ownerId requires query.ownerKind (an id is meaningless without its kind)',
    );
  }
  const ownerId = ownerIdRaw === null ? null : requireUuid(ownerIdRaw, 'query.ownerId');

  const horizonEndFrom =
    query.horizonEndFrom === undefined
      ? null
      : requireIsoInstant(query.horizonEndFrom, 'query.horizonEndFrom');
  const horizonEndTo =
    query.horizonEndTo === undefined
      ? null
      : requireIsoInstant(query.horizonEndTo, 'query.horizonEndTo');
  if (
    horizonEndFrom !== null &&
    horizonEndTo !== null &&
    Date.parse(horizonEndFrom) > Date.parse(horizonEndTo)
  ) {
    throw queryError('query.horizonEndFrom must not be after query.horizonEndTo');
  }

  const search =
    query.search === undefined ? null : requireBoundedString(query.search, 'query.search', MAX_SEARCH_LENGTH);

  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw queryError(
      `query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`,
    );
  }

  return {
    status,
    priority,
    ownerKind,
    ownerId,
    horizonEndFrom: horizonEndFrom === null ? null : new Date(horizonEndFrom),
    horizonEndTo: horizonEndTo === null ? null : new Date(horizonEndTo),
    search,
    limit,
  };
}

function requireQueryEnum<T extends string>(value: unknown, field: string, list: readonly T[]): T {
  if (!isOneOf(value, list)) {
    throw queryError(`${field} must be one of ${list.join(', ')} (got '${String(value)}')`);
  }
  return value;
}

/** Fully validated + normalized form of `GetGoalVersionQuery`. */
export interface ValidatedVersionQuery {
  goalId: string;
  version: number;
}

export function validateVersionQuery(query: GetGoalVersionQuery): ValidatedVersionQuery {
  try {
    return validateVersionQueryInner(query);
  } catch (error) {
    if (error instanceof GoalsError && error.code === 'invalid_goal_input') {
      throw new GoalsError('invalid_query', error.message);
    }
    throw error;
  }
}

function validateVersionQueryInner(query: GetGoalVersionQuery): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'goalId' && key !== 'version');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: goalId, version)`);
  }
  const goalId = requireUuid(query.goalId, 'query.goalId');
  if (
    typeof query.version !== 'number' ||
    !Number.isInteger(query.version) ||
    query.version < 1
  ) {
    throw queryError(`query.version must be an integer >= 1 (got ${String(query.version)})`);
  }
  return { goalId, version: query.version };
}

/** Fully validated + normalized form of `ListGoalVersionsQuery`. */
export interface ValidatedHistoryQuery {
  goalId: string;
}

export function validateHistoryQuery(query: ListGoalVersionsQuery): ValidatedHistoryQuery {
  try {
    return validateHistoryQueryInner(query);
  } catch (error) {
    if (error instanceof GoalsError && error.code === 'invalid_goal_input') {
      throw new GoalsError('invalid_query', error.message);
    }
    throw error;
  }
}

function validateHistoryQueryInner(query: ListGoalVersionsQuery): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'goalId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: goalId)`);
  }
  return { goalId: requireUuid(query.goalId, 'query.goalId') };
}
