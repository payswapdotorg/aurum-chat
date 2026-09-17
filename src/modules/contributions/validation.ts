// Pure validation/normalization logic of the contributions module (no
// database). Everything a caller may put into a contribution, a
// validation or a measured impact crosses these guards first; the SQL
// CHECK constraints in migrations/001-contributions.sql mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `missionId`, `contributor`, `question`,
// `evidenceObservationId`, `budgetCurrency`, `status`, `validation`,
// `validationCount`, `impact`, `recordedAt`, `knowledgeGain` or principal
// fields into an input — the contribution's identity, tenancy, the
// plan-derived fields (mission, contributor, question, evidence
// observation, budget currency), derived lifecycle, commit times, the
// frozen knowledge gain and the acting principal are minted by the
// system (contribution records are auditable, and audit fields are not
// caller-forgeable). There is also deliberately NO revision input at all:
// definitions are immutable, validations append and impacts are one-shot.
//
// Every shared primitive takes the error factory of its calling context,
// so a bad field reports the operation's own error code
// (invalid_contribution_input on definitions, invalid_validation_input
// on validations, and so on) — the same discipline the missions and
// learning modules apply per operation.
//
// `assessKnowledgeGain` is the single definition of the knowledge gain:
// the deterministic math the service freezes onto the measured impact row
// at record time (unit-tested in isolation; W043 Rewards and W053
// CompanyModel consume the FROZEN record, never a re-derivation).
//
// `AVOIDED_PATH_ACTIONS` is derived from the knowledge-acquisition
// contract's `ACQUISITION_ACTION_KINDS` (the sanctioned W012 → W042
// dependency) — the avoided-path vocabulary is, by construction, the set
// of acquisition actions that no longer need to run, and it cannot drift
// from the planner's own vocabulary.

import type { TenantContext } from '@/infra/tenant';
import { ACQUISITION_ACTION_KINDS } from '@/modules/knowledge-acquisition/contract';
import { ContributionsError } from './errors';
import type {
  AvoidedPathAction,
  ContributionEvidenceKind,
  ContributionPartyKind,
  ContributionStatus,
  ContributionValidationOutcome,
  MissionImpactKind,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/** Derived lifecycle (never stored on the definition row). */
export const CONTRIBUTION_STATUSES = [
  'pending',
  'validated',
  'contradicted',
  'rejected',
  'measured',
] as const;

/** The evidence-quality assessment outcomes (§8 "validation outcome"). */
export const VALIDATION_OUTCOMES = ['validated', 'contradicted', 'rejected'] as const;

/** What a contribution did to the mission it served. */
export const MISSION_IMPACT_KINDS = ['advanced', 'resolved', 'no_effect'] as const;

/** Kinds of parties that can make contribution changes (the missions vocabulary). */
export const CONTRIBUTION_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** Where validation evidence came from (opaque reference kinds). */
export const CONTRIBUTION_EVIDENCE_KINDS = [
  'observation',
  'event',
  'document',
  'report',
  'system',
  'metric',
] as const;

/**
 * The acquisition actions an avoided investigation path can name — the
 * knowledge-acquisition planner's own action vocabulary (W012), imported
 * from its contract so the two can never drift.
 */
export const AVOIDED_PATH_ACTIONS = ACQUISITION_ACTION_KINDS;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const MAX_SUMMARY_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_QUESTION_LENGTH = 2000;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;
export const MAX_EVIDENCE_REFS = 8;
export const MAX_AFFECTED_GOALS = 16;
export const MAX_AVOIDED_PATHS = 8;
export const MAX_AVOIDED_PATH_LABEL_LENGTH = 200;
/** Money and confidence bounds. */
export const MAX_COST_AMOUNT = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECORD_INPUT_KEYS = ['planId', 'summary', 'note', 'actor'] as const;

const VALIDATION_INPUT_KEYS = [
  'contributionId',
  'outcome',
  'quality',
  'evidence',
  'note',
  'actor',
] as const;

const IMPACT_INPUT_KEYS = [
  'contributionId',
  'missionImpact',
  'confidenceBefore',
  'confidenceAfter',
  'affectedGoals',
  'avoidedCost',
  'avoidedPaths',
  'outcomeId',
  'note',
  'actor',
] as const;

const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const GOAL_REF_KEYS = ['goalId', 'label'] as const;
const EVIDENCE_KEYS = ['kind', 'id', 'label'] as const;
const AVOIDED_PATH_KEYS = ['action', 'label', 'estimatedCost'] as const;

const LIST_QUERY_KEYS = [
  'missionId',
  'personId',
  'status',
  'missionImpact',
  'search',
  'limit',
] as const;

const VALIDATIONS_QUERY_KEYS = ['contributionId'] as const;

const SUMMARIZE_QUERY_KEYS = ['personId'] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isContributionStatus(value: unknown): value is ContributionStatus {
  return isOneOf(value, CONTRIBUTION_STATUSES);
}

export function isValidationOutcome(value: unknown): value is ContributionValidationOutcome {
  return isOneOf(value, VALIDATION_OUTCOMES);
}

export function isMissionImpactKind(value: unknown): value is MissionImpactKind {
  return isOneOf(value, MISSION_IMPACT_KINDS);
}

export function isContributionPartyKind(value: unknown): value is ContributionPartyKind {
  return isOneOf(value, CONTRIBUTION_PARTY_KINDS);
}

export function isContributionEvidenceKind(value: unknown): value is ContributionEvidenceKind {
  return isOneOf(value, CONTRIBUTION_EVIDENCE_KINDS);
}

/** Avoided-path action guard: membership in the acquisition action vocabulary. */
export function isAvoidedPathAction(value: unknown): value is AvoidedPathAction {
  return isOneOf(value, AVOIDED_PATH_ACTIONS);
}

/** Contribution/validation-id shape guard (uuid); malformed ids are simply "not found". */
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
export function assertContributionsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ContributionsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ContributionsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ContributionsError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// Shared primitive guards (each takes its calling context's error factory)
// ---------------------------------------------------------------------------

/** The error factory of one validation context. */
type Err = (message: string) => ContributionsError;

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
 * A confidence or quality score: any finite number in [0, 1] — the
 * missions confidence scale and the assessed evidence-quality scale.
 */
function requireUnitScore(value: unknown, field: string, err: Err): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw err(`${field} must be a finite number in [0, 1] (got ${String(value)})`);
  }
  if (value < 0 || value > 1) {
    throw err(`${field} must be within [0, 1] (got ${value})`);
  }
  return value;
}

/**
 * A money amount in integer MINOR UNITS (IMPLEMENTATION-STACK §8): a
 * non-negative integer within the JS safe-integer envelope — the W012
 * cost convention.
 */
function requireMinorUnits(value: unknown, field: string, err: Err): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw err(`${field} must be an integer amount of minor units (got ${String(value)})`);
  }
  if (value < 0) {
    throw err(`${field} must not be negative (got ${value})`);
  }
  if (value > MAX_COST_AMOUNT) {
    throw err(`${field} must not exceed ${MAX_COST_AMOUNT} minor units (got ${value})`);
  }
  return value;
}

function contributionError(message: string): ContributionsError {
  return new ContributionsError('invalid_contribution_input', message);
}

function validationError(message: string): ContributionsError {
  return new ContributionsError('invalid_validation_input', message);
}

function impactError(message: string): ContributionsError {
  return new ContributionsError('invalid_impact_input', message);
}

function queryError(message: string): ContributionsError {
  return new ContributionsError('invalid_query', message);
}

// ---------------------------------------------------------------------------
// Parties, evidence refs, goal refs, avoided paths
// ---------------------------------------------------------------------------

export interface ValidatedParty {
  kind: ContributionPartyKind;
  id: string | null;
  label: string | null;
}

export interface ValidatedGoalRef {
  goalId: string;
  label: string | null;
}

export interface ValidatedEvidenceRef {
  kind: ContributionEvidenceKind;
  id: string | null;
  label: string | null;
}

export interface ValidatedAvoidedPath {
  action: AvoidedPathAction;
  label: string;
  estimatedCost: number;
}

/**
 * Shared shape guard for actors: a provider-neutral kind plus an opaque
 * uuid id and/or a human-readable label (at least one — the party must be
 * traceable). Ids are uuids because they reference records of the owning
 * modules (people/persons, world entities, agents, missions).
 */
function validateParty(party: unknown, where: string, err: Err): ValidatedParty {
  if (!isPlainObject(party)) throw err(`${where} must be an object`);
  rejectUnknownKeys(party, PARTY_KEYS, where, err);
  const kind = party.kind;
  if (!isContributionPartyKind(kind)) {
    throw err(
      `${where}.kind must be one of ${CONTRIBUTION_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
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
 * One validation evidence reference: a provider-neutral kind plus an
 * opaque uuid id and/or a human-readable label (at least one — evidence
 * must be traceable). Deliberately unvalidated beyond shape: no
 * sanctioned contract owns these references for the contributions module.
 */
function validateEvidenceRef(ref: unknown, where: string, err: Err): ValidatedEvidenceRef {
  if (!isPlainObject(ref)) throw err(`${where} must be an object`);
  rejectUnknownKeys(ref, EVIDENCE_KEYS, where, err);
  const kind = ref.kind;
  if (!isContributionEvidenceKind(kind)) {
    throw err(
      `${where}.kind must be one of ${CONTRIBUTION_EVIDENCE_KINDS.join(', ')} (got '${String(kind)}')`,
    );
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

/**
 * One avoided investigation path: an acquisition action that no longer
 * needs to run (the W012 vocabulary), its human label and its estimated
 * cost in integer minor units of the contribution's budget currency.
 */
function validateAvoidedPath(path: unknown, where: string, err: Err): ValidatedAvoidedPath {
  if (!isPlainObject(path)) throw err(`${where} must be an object`);
  rejectUnknownKeys(path, AVOIDED_PATH_KEYS, where, err);
  if (!isAvoidedPathAction(path.action)) {
    throw err(
      `${where}.action must be one of ${AVOIDED_PATH_ACTIONS.join(', ')} (got '${String(path.action)}')`,
    );
  }
  const label = requireBoundedString(path.label, `${where}.label`, MAX_AVOIDED_PATH_LABEL_LENGTH, err);
  const estimatedCost = requireMinorUnits(path.estimatedCost, `${where}.estimatedCost`, err);
  return { action: path.action, label, estimatedCost };
}

function validateAvoidedPaths(value: unknown, err: Err): ValidatedAvoidedPath[] {
  if (!Array.isArray(value)) throw err('avoidedPaths must be an array');
  if (value.length > MAX_AVOIDED_PATHS) {
    throw err(`avoidedPaths supports at most ${MAX_AVOIDED_PATHS} entries (got ${value.length})`);
  }
  return value.map((entry, index) => validateAvoidedPath(entry, `avoidedPaths[${index}]`, err));
}

// ---------------------------------------------------------------------------
// recordContribution
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `recordContribution`'s input. */
export interface ValidatedRecordInput {
  planId: string;
  summary: string;
  note: string | null;
  actor: ValidatedParty;
}

export function validateRecordContributionInput(input: unknown): ValidatedRecordInput {
  const err = contributionError;
  if (!isPlainObject(input)) throw err('record input must be an object');
  rejectUnknownKeys(input, RECORD_INPUT_KEYS, 'the record input', err);

  const planId = requireUuid(input.planId, 'planId', err);
  const summary = requireBoundedString(input.summary, 'summary', MAX_SUMMARY_LENGTH, err);
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);

  return { planId, summary, note, actor };
}

// ---------------------------------------------------------------------------
// validateContribution
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `validateContribution`'s input. */
export interface ValidatedValidationInput {
  contributionId: string;
  outcome: ContributionValidationOutcome;
  quality: number;
  evidence: ValidatedEvidenceRef[];
  note: string | null;
  actor: ValidatedParty;
}

export function validateValidateContributionInput(input: unknown): ValidatedValidationInput {
  const err = validationError;
  if (!isPlainObject(input)) throw err('validation input must be an object');
  rejectUnknownKeys(input, VALIDATION_INPUT_KEYS, 'the validation input', err);

  const contributionId = requireUuid(input.contributionId, 'contributionId', err);
  if (!isValidationOutcome(input.outcome)) {
    throw err(
      `outcome must be one of ${VALIDATION_OUTCOMES.join(', ')} (got '${String(input.outcome)}')`,
    );
  }
  const quality = requireUnitScore(input.quality, 'quality', err);
  const evidence = validateEvidenceRefs(input.evidence ?? [], err);
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);

  return { contributionId, outcome: input.outcome, quality, evidence, note, actor };
}

// ---------------------------------------------------------------------------
// recordImpact
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `recordImpact`'s input. */
export interface ValidatedImpactInput {
  contributionId: string;
  missionImpact: MissionImpactKind;
  confidenceBefore: number;
  confidenceAfter: number;
  affectedGoals: ValidatedGoalRef[];
  avoidedCost: number;
  avoidedPaths: ValidatedAvoidedPath[];
  outcomeId: string | null;
  note: string | null;
  actor: ValidatedParty;
}

export function validateRecordImpactInput(input: unknown): ValidatedImpactInput {
  const err = impactError;
  if (!isPlainObject(input)) throw err('impact input must be an object');
  rejectUnknownKeys(input, IMPACT_INPUT_KEYS, 'the impact input', err);

  const contributionId = requireUuid(input.contributionId, 'contributionId', err);
  if (!isMissionImpactKind(input.missionImpact)) {
    throw err(
      `missionImpact must be one of ${MISSION_IMPACT_KINDS.join(', ')} (got '${String(input.missionImpact)}')`,
    );
  }
  const confidenceBefore = requireUnitScore(input.confidenceBefore, 'confidenceBefore', err);
  const confidenceAfter = requireUnitScore(input.confidenceAfter, 'confidenceAfter', err);
  const affectedGoals = validateAffectedGoals(input.affectedGoals ?? [], err);
  const avoidedCost = requireMinorUnits(input.avoidedCost, 'avoidedCost', err);
  const avoidedPaths = validateAvoidedPaths(input.avoidedPaths ?? [], err);
  const outcomeId =
    input.outcomeId === undefined || input.outcomeId === null
      ? null
      : requireUuid(input.outcomeId, 'outcomeId', err);
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_LENGTH, err);
  const actor = validateParty(input.actor, 'actor', err);

  return {
    contributionId,
    missionImpact: input.missionImpact,
    confidenceBefore,
    confidenceAfter,
    affectedGoals,
    avoidedCost,
    avoidedPaths,
    outcomeId,
    note,
    actor,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `listContributions`' query. */
export interface ValidatedListQuery {
  missionId: string | null;
  personId: string | null;
  status: ContributionStatus | null;
  missionImpact: MissionImpactKind | null;
  search: string | null;
  limit: number;
}

export function validateListContributionsQuery(query: unknown): ValidatedListQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('list query must be an object');
  rejectUnknownKeys(query, LIST_QUERY_KEYS, 'the list query', err);

  const missionId =
    query.missionId === undefined ? null : requireUuid(query.missionId, 'missionId', err);
  const personId =
    query.personId === undefined ? null : requireUuid(query.personId, 'personId', err);

  let status: ContributionStatus | null = null;
  if (query.status !== undefined) {
    if (!isContributionStatus(query.status)) {
      throw err(`status must be one of ${CONTRIBUTION_STATUSES.join(', ')} (got '${String(query.status)}')`);
    }
    status = query.status;
  }

  let missionImpact: MissionImpactKind | null = null;
  if (query.missionImpact !== undefined) {
    if (!isMissionImpactKind(query.missionImpact)) {
      throw err(
        `missionImpact must be one of ${MISSION_IMPACT_KINDS.join(', ')} (got '${String(query.missionImpact)}')`,
      );
    }
    missionImpact = query.missionImpact;
  }

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

  return { missionId, personId, status, missionImpact, search, limit };
}

/** Fully validated + normalized form of `listValidations`' query. */
export interface ValidatedValidationsQuery {
  contributionId: string;
}

export function validateListValidationsQuery(query: unknown): ValidatedValidationsQuery {
  const err = queryError;
  if (!isPlainObject(query)) throw err('validations query must be an object');
  rejectUnknownKeys(query, VALIDATIONS_QUERY_KEYS, 'the validations query', err);
  return { contributionId: requireUuid(query.contributionId, 'contributionId', err) };
}

/** Fully validated + normalized form of `summarizeContributions`' query. */
export interface ValidatedSummarizeQuery {
  personId: string | null;
}

export function validateSummarizeContributionsQuery(query: unknown): ValidatedSummarizeQuery {
  if (query === undefined || query === null) return { personId: null };
  const err = queryError;
  if (!isPlainObject(query)) throw err('summarize query must be an object');
  rejectUnknownKeys(query, SUMMARIZE_QUERY_KEYS, 'the summarize query', err);
  const personId =
    query.personId === undefined ? null : requireUuid(query.personId, 'personId', err);
  return { personId };
}

// ---------------------------------------------------------------------------
// The knowledge-gain math (single definition, frozen at record time)
// ---------------------------------------------------------------------------

/** The deterministic result `assessKnowledgeGain` produces. */
export interface KnowledgeGainAssessment {
  /** confidenceAfter − confidenceBefore (signed, on the missions scale). */
  knowledgeGain: number;
  /** Which way the confidence moved: gain, loss or flat. */
  direction: 'gain' | 'loss' | 'flat';
}

/**
 * The single definition of the knowledge gain (W042's core): deterministic
 * and pure — the mission's confidence after minus before. The service
 * freezes this onto the measured impact row at record time; W043
 * (Rewards) and W053 (CompanyModel) consume the frozen record, never a
 * re-derivation. A negative gain is a legal, recordable outcome (a
 * contribution can REDUCE confidence — e.g. when validation contradicted
 * the prior working answer).
 */
export function assessKnowledgeGain(
  confidenceBefore: number,
  confidenceAfter: number,
): KnowledgeGainAssessment {
  const knowledgeGain = confidenceAfter - confidenceBefore;
  const direction: KnowledgeGainAssessment['direction'] =
    knowledgeGain > 0 ? 'gain' : knowledgeGain < 0 ? 'loss' : 'flat';
  return { knowledgeGain, direction };
}
