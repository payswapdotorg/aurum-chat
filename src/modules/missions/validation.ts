// Pure validation/normalization logic of the missions module (no database).
// Everything a caller may put into a mission crosses these guards first; the
// SQL CHECK constraints in migrations/001-missions.sql mirror the load-bearing
// rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `status` (on create), `changeKind`, `completion`,
// `recordedAt` or `changedByPrincipal` into an input — the mission's
// identity, tenancy, version number, lifecycle on creation, change
// classification, completion record, commit time and acting principal are
// minted by the system (mission changes are auditable, and audit fields
// are not caller-forgeable). Revisions carry no `status` at all —
// lifecycle transitions are the dedicated completeMission / abandonMission
// operations, so a caller cannot smuggle a transition past its gate.
//
// Revision patches are validated as SHAPES here; cross-field invariants
// that span the patch and the current version (the confidence gap rule
// targetConfidence > currentConfidence) are re-checked by the service on
// the MERGED snapshot via `validateMissionContent` — the same validator
// create uses, so a revised mission is exactly as well-formed as a
// freshly created one.

import type { TenantContext } from '@/infra/tenant';
import { MissionsError } from './errors';
import type {
  AbandonMissionInput,
  CompleteMissionInput,
  CreateMissionInput,
  GetMissionVersionQuery,
  ListMissionVersionsQuery,
  ListMissionsQuery,
  MissionCandidateKind,
  MissionChangeKind,
  MissionPartyKind,
  MissionStatus,
  MissionUrgency,
  ReviseMissionInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const MISSION_URGENCIES = ['critical', 'high', 'medium', 'low'] as const;

export const MISSION_STATUSES = ['active', 'completed', 'abandoned'] as const;

export const MISSION_CHANGE_KINDS = ['created', 'revised', 'completed', 'abandoned'] as const;

/** Kinds of parties that can make mission changes. */
export const MISSION_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/**
 * Kinds of candidate knowledge sources — the acquisition menu of §7
 * (employees/managers → `person`, internal systems, documents, external
 * sources, agents, temporary analyses).
 */
export const MISSION_CANDIDATE_KINDS = [
  'person',
  'system',
  'document',
  'external',
  'agent',
  'analysis',
] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const MAX_AFFECTED_GOALS = 16;
export const MAX_UNKNOWN_REFS = 16;
export const MAX_CANDIDATE_SOURCES = 16;
export const MAX_TITLE_LENGTH = 200;
export const MAX_KNOWLEDGE_OBJECTIVE_LENGTH = 2000;
export const MAX_COMPLETION_CRITERIA_LENGTH = 4000;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_REWARD_TERMS_LENGTH = 2000;
export const MAX_OUTCOME_LENGTH = 4000;
export const MAX_REASON_LENGTH = 2000;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;
/** Budget amounts are integer minor units up to JS safe-integer range. */
export const MAX_BUDGET_AMOUNT = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const CREATE_INPUT_KEYS = [
  'title',
  'knowledgeObjective',
  'affectedGoals',
  'unknownIds',
  'informationValue',
  'urgency',
  'currentConfidence',
  'targetConfidence',
  'investigationBudget',
  'rewardBudget',
  'rewardTerms',
  'candidateSources',
  'completionCriteria',
  'actor',
  'rationale',
] as const;

const REVISION_INPUT_KEYS = [
  'missionId',
  'title',
  'knowledgeObjective',
  'affectedGoals',
  'unknownIds',
  'informationValue',
  'urgency',
  'currentConfidence',
  'targetConfidence',
  'investigationBudget',
  'rewardBudget',
  'rewardTerms',
  'candidateSources',
  'completionCriteria',
  'actor',
  'rationale',
] as const;

const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const GOAL_REF_KEYS = ['goalId', 'label'] as const;
const BUDGET_KEYS = ['amount', 'currency'] as const;
const LIST_QUERY_KEYS = [
  'status',
  'urgency',
  'affectedGoalId',
  'unknownId',
  'candidateKind',
  'candidateId',
  'search',
  'limit',
] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isMissionUrgency(value: unknown): value is MissionUrgency {
  return isOneOf(value, MISSION_URGENCIES);
}

export function isMissionStatus(value: unknown): value is MissionStatus {
  return isOneOf(value, MISSION_STATUSES);
}

export function isMissionChangeKind(value: unknown): value is MissionChangeKind {
  return isOneOf(value, MISSION_CHANGE_KINDS);
}

export function isMissionPartyKind(value: unknown): value is MissionPartyKind {
  return isOneOf(value, MISSION_PARTY_KINDS);
}

export function isMissionCandidateKind(value: unknown): value is MissionCandidateKind {
  return isOneOf(value, MISSION_CANDIDATE_KINDS);
}

/** Mission-id shape guard (uuid); malformed ids are simply "not found". */
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
export function assertMissionTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new MissionsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new MissionsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new MissionsError('invalid_context', 'TenantContext.authority must be an array of claims');
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
      throw new MissionsError(
        'invalid_mission_input',
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

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw inputError(`${field} must be a finite number (got ${String(value)})`);
  }
  return value;
}

/** A comparable score in the inclusive interval [0, 1] (confidences, information value). */
function requireUnitInterval(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field);
  if (number < 0 || number > 1) {
    throw inputError(`${field} must be within [0, 1] (got ${number})`);
  }
  return number;
}

function inputError(message: string): MissionsError {
  return new MissionsError('invalid_mission_input', message);
}

function revisionError(message: string): MissionsError {
  return new MissionsError('invalid_revision_input', message);
}

function queryError(message: string): MissionsError {
  return new MissionsError('invalid_query', message);
}

// ---------------------------------------------------------------------------
// Parties (actors), affected-goal refs, unknown refs and candidates
// ---------------------------------------------------------------------------

export interface ValidatedParty {
  kind: MissionPartyKind;
  id: string | null;
  label: string | null;
}

export interface ValidatedGoalRef {
  goalId: string;
  label: string | null;
}

export interface ValidatedCandidate {
  kind: MissionCandidateKind;
  id: string | null;
  label: string | null;
}

/**
 * Shared shape guard for actors: a provider-neutral kind plus an opaque
 * uuid id and/or a human-readable label (at least one — the party must be
 * traceable). Ids are uuids because they reference records of the owning
 * modules (people/persons, world entities, agents, sources).
 */
function validateParty(party: unknown, where: string): ValidatedParty {
  if (!isPlainObject(party)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(party, PARTY_KEYS, where);
  const kind = party.kind;
  if (!isMissionPartyKind(kind)) {
    throw inputError(
      `${where}.kind must be one of ${MISSION_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
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

/** One affected-goal reference: a required goals-module uuid plus an optional label. */
function validateGoalRef(ref: unknown, where: string): ValidatedGoalRef {
  if (!isPlainObject(ref)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(ref, GOAL_REF_KEYS, where);
  const goalId = requireUuid(ref.goalId, `${where}.goalId`);
  const label = optionalTrimmed(ref.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH);
  return { goalId, label };
}

function validateAffectedGoals(value: unknown): ValidatedGoalRef[] {
  if (!Array.isArray(value)) throw inputError('affectedGoals must be an array');
  if (value.length > MAX_AFFECTED_GOALS) {
    throw inputError(
      `affectedGoals must hold at most ${MAX_AFFECTED_GOALS} entries (got ${value.length})`,
    );
  }
  const refs = value.map((entry, index) => validateGoalRef(entry, `affectedGoals[${index}]`));
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.goalId)) {
      throw inputError(`affected goals must be unique (duplicate '${ref.goalId}')`);
    }
    seen.add(ref.goalId);
  }
  return refs;
}

/**
 * Normalized, deduplicated, sorted unknown-id list, bounded by
 * MAX_UNKNOWN_REFS (the epistemics module's related-id precedent). The
 * epistemics contract — never this module — verifies existence and
 * readability at write time.
 */
function validateUnknownRefs(value: unknown): string[] {
  if (!Array.isArray(value)) throw inputError('unknownIds must be an array of unknown uuids');
  if (value.length > MAX_UNKNOWN_REFS) {
    throw inputError(
      `unknownIds supports at most ${MAX_UNKNOWN_REFS} unknowns (got ${value.length})`,
    );
  }
  const ids: string[] = [];
  for (const [index, id] of value.entries()) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw inputError(`unknownIds[${index}] must be an unknown uuid`);
    }
    const normalized = id.toLowerCase();
    if (!ids.includes(normalized)) ids.push(normalized);
  }
  ids.sort();
  return ids;
}

/**
 * One candidate knowledge source: a provider-neutral kind plus an opaque
 * uuid id and/or a human-readable label (at least one — a candidate must
 * be traceable). Candidates are deliberately unverified references: the
 * W012 planner resolves them when it drives acquisition.
 */
function validateCandidate(candidate: unknown, where: string): ValidatedCandidate {
  if (!isPlainObject(candidate)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(candidate, PARTY_KEYS, where);
  const kind = candidate.kind;
  if (!isMissionCandidateKind(kind)) {
    throw inputError(
      `${where}.kind must be one of ${MISSION_CANDIDATE_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id =
    candidate.id === undefined || candidate.id === null
      ? null
      : requireUuid(candidate.id, `${where}.id`);
  const label = optionalTrimmed(candidate.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH);
  if (id === null && label === null) {
    throw inputError(
      `${where} must carry an id or a label — candidate sources must be traceable`,
    );
  }
  return { kind, id, label };
}

function validateCandidateSources(value: unknown): ValidatedCandidate[] {
  if (!Array.isArray(value)) throw inputError('candidateSources must be an array');
  if (value.length > MAX_CANDIDATE_SOURCES) {
    throw inputError(
      `candidateSources must hold at most ${MAX_CANDIDATE_SOURCES} entries (got ${value.length})`,
    );
  }
  return value.map((entry, index) => validateCandidate(entry, `candidateSources[${index}]`));
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface ValidatedBudget {
  amount: number;
  currency: string;
}

/**
 * A mission budget: an integer amount in minor units (0 = nothing may be
 * spent/offered) plus an ISO-4217-shaped 3-letter currency code
 * (IMPLEMENTATION-STACK §8 — integer minor units + ISO currency code).
 */
function validateBudget(budget: unknown, where: string): ValidatedBudget {
  if (!isPlainObject(budget)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(budget, BUDGET_KEYS, where);
  const amount = requireFiniteNumber(budget.amount, `${where}.amount`);
  if (!Number.isInteger(amount) || amount < 0) {
    throw inputError(
      `${where}.amount must be a non-negative integer number of minor units (got ${amount})`,
    );
  }
  if (amount > MAX_BUDGET_AMOUNT) {
    throw inputError(
      `${where}.amount must not exceed ${MAX_BUDGET_AMOUNT} minor units (got ${amount})`,
    );
  }
  const currency = requireBoundedString(budget.currency, `${where}.currency`, 3);
  if (!CURRENCY_PATTERN.test(currency)) {
    throw inputError(
      `${where}.currency must be a 3-letter ISO 4217 currency code, e.g. 'EUR' (got '${currency}')`,
    );
  }
  return { amount, currency };
}

// ---------------------------------------------------------------------------
// Full content (shared by create and by the service's merged-revision path)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of a mission's content fields. */
export interface ValidatedMissionContent {
  title: string;
  knowledgeObjective: string;
  affectedGoals: ValidatedGoalRef[];
  unknownIds: string[];
  informationValue: number;
  urgency: MissionUrgency;
  currentConfidence: number;
  targetConfidence: number;
  investigationBudget: ValidatedBudget;
  rewardBudget: ValidatedBudget;
  rewardTerms: string | null;
  candidateSources: ValidatedCandidate[];
  completionCriteria: string;
}

const CONTENT_KEYS = [
  'title',
  'knowledgeObjective',
  'affectedGoals',
  'unknownIds',
  'informationValue',
  'urgency',
  'currentConfidence',
  'targetConfidence',
  'investigationBudget',
  'rewardBudget',
  'rewardTerms',
  'candidateSources',
  'completionCriteria',
] as const;

/**
 * Validates a FULL mission content object (no actor/rationale — those belong
 * to the change, not the content). Used directly by `createMission` and by
 * the service on the merged (current ⊕ patch) snapshot of a revision, so a
 * revised mission is exactly as well-formed as a freshly created one.
 *
 * The confidence gap rule (§6: current + target confidence) is a content
 * invariant: targetConfidence must be strictly greater than
 * currentConfidence on EVERY version — a mission that has closed its gap
 * is completed (completeMission records the achieved confidence), never
 * silently revised past its target.
 */
export function validateMissionContent(content: unknown): ValidatedMissionContent {
  if (!isPlainObject(content)) throw inputError('mission content must be an object');
  rejectUnknownKeys(content, CONTENT_KEYS, 'the mission content');

  const title = requireBoundedString(content.title, 'title', MAX_TITLE_LENGTH);
  const knowledgeObjective = requireBoundedString(
    content.knowledgeObjective,
    'knowledgeObjective',
    MAX_KNOWLEDGE_OBJECTIVE_LENGTH,
  );
  const completionCriteria = requireBoundedString(
    content.completionCriteria,
    'completionCriteria',
    MAX_COMPLETION_CRITERIA_LENGTH,
  );

  const affectedGoals = validateAffectedGoals(content.affectedGoals);
  const unknownIds = validateUnknownRefs(content.unknownIds);
  const candidateSources = validateCandidateSources(content.candidateSources);

  const informationValue = requireUnitInterval(content.informationValue, 'informationValue');

  if (!isMissionUrgency(content.urgency)) {
    throw inputError(
      `urgency must be one of ${MISSION_URGENCIES.join(', ')} (got '${String(content.urgency)}')`,
    );
  }

  const currentConfidence = requireUnitInterval(content.currentConfidence, 'currentConfidence');
  const targetConfidence = requireUnitInterval(content.targetConfidence, 'targetConfidence');
  if (targetConfidence <= currentConfidence) {
    throw inputError(
      `targetConfidence must be strictly greater than currentConfidence — a mission must close a confidence gap (${targetConfidence} <= ${currentConfidence})`,
    );
  }

  const investigationBudget = validateBudget(content.investigationBudget, 'investigationBudget');
  const rewardBudget = validateBudget(content.rewardBudget, 'rewardBudget');
  const rewardTerms = optionalTrimmed(content.rewardTerms, 'rewardTerms', MAX_REWARD_TERMS_LENGTH);

  return {
    title,
    knowledgeObjective,
    affectedGoals,
    unknownIds,
    informationValue,
    urgency: content.urgency,
    currentConfidence,
    targetConfidence,
    investigationBudget,
    rewardBudget,
    rewardTerms,
    candidateSources,
    completionCriteria,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CreateMissionInput`. */
export interface ValidatedCreateMissionInput {
  content: ValidatedMissionContent;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateCreateMissionInput(input: CreateMissionInput): ValidatedCreateMissionInput {
  if (!isPlainObject(input)) throw inputError('mission input must be an object');
  rejectUnknownKeys(input, CREATE_INPUT_KEYS, 'the mission input');

  const content = validateMissionContent({
    title: input.title,
    knowledgeObjective: input.knowledgeObjective,
    affectedGoals: input.affectedGoals ?? [],
    unknownIds: input.unknownIds ?? [],
    informationValue: input.informationValue,
    urgency: input.urgency,
    currentConfidence: input.currentConfidence ?? 0,
    targetConfidence: input.targetConfidence,
    investigationBudget: input.investigationBudget,
    rewardBudget: input.rewardBudget,
    rewardTerms: input.rewardTerms ?? null,
    candidateSources: input.candidateSources ?? [],
    completionCriteria: input.completionCriteria,
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
  knowledgeObjective?: string;
  affectedGoals?: ValidatedGoalRef[];
  unknownIds?: string[];
  informationValue?: number;
  urgency?: MissionUrgency;
  currentConfidence?: number;
  targetConfidence?: number;
  investigationBudget?: ValidatedBudget;
  rewardBudget?: ValidatedBudget;
  /** Tri-state: undefined = unchanged, null = cleared, string = set. */
  rewardTerms?: string | null;
  candidateSources?: ValidatedCandidate[];
  completionCriteria?: string;
}

/** Fully validated + normalized form of `ReviseMissionInput`. */
export interface ValidatedRevisionInput {
  missionId: string;
  patch: ValidatedRevisionPatch;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseMissionInput(input: ReviseMissionInput): ValidatedRevisionInput {
  try {
    return validateReviseMissionInputInner(input);
  } catch (error) {
    // The shared field guards throw `invalid_mission_input`; for a revision
    // the correct code is `invalid_revision_input` (the events module's
    // query-wrapper precedent for code remapping).
    if (error instanceof MissionsError && error.code === 'invalid_mission_input') {
      throw new MissionsError('invalid_revision_input', error.message);
    }
    throw error;
  }
}

function validateReviseMissionInputInner(input: ReviseMissionInput): ValidatedRevisionInput {
  if (!isPlainObject(input)) throw revisionError('revision input must be an object');
  rejectRevisionUnknownKeys(input);

  const missionId = requireUuid(input.missionId, 'missionId');

  const patch: ValidatedRevisionPatch = {};
  const changed: string[] = [];

  if (input.title !== undefined) {
    patch.title = requireBoundedString(input.title, 'title', MAX_TITLE_LENGTH);
    changed.push('title');
  }
  if (input.knowledgeObjective !== undefined) {
    patch.knowledgeObjective = requireBoundedString(
      input.knowledgeObjective,
      'knowledgeObjective',
      MAX_KNOWLEDGE_OBJECTIVE_LENGTH,
    );
    changed.push('knowledgeObjective');
  }
  if (input.affectedGoals !== undefined) {
    patch.affectedGoals = validateAffectedGoals(input.affectedGoals);
    changed.push('affectedGoals');
  }
  if (input.unknownIds !== undefined) {
    patch.unknownIds = validateUnknownRefs(input.unknownIds);
    changed.push('unknownIds');
  }
  if (input.informationValue !== undefined) {
    patch.informationValue = requireUnitInterval(input.informationValue, 'informationValue');
    changed.push('informationValue');
  }
  if (input.urgency !== undefined) {
    if (!isMissionUrgency(input.urgency)) {
      throw revisionError(
        `urgency must be one of ${MISSION_URGENCIES.join(', ')} (got '${String(input.urgency)}')`,
      );
    }
    patch.urgency = input.urgency;
    changed.push('urgency');
  }
  if (input.currentConfidence !== undefined) {
    patch.currentConfidence = requireUnitInterval(input.currentConfidence, 'currentConfidence');
    changed.push('currentConfidence');
  }
  if (input.targetConfidence !== undefined) {
    patch.targetConfidence = requireUnitInterval(input.targetConfidence, 'targetConfidence');
    changed.push('targetConfidence');
  }
  if (input.investigationBudget !== undefined) {
    patch.investigationBudget = validateBudget(input.investigationBudget, 'investigationBudget');
    changed.push('investigationBudget');
  }
  if (input.rewardBudget !== undefined) {
    patch.rewardBudget = validateBudget(input.rewardBudget, 'rewardBudget');
    changed.push('rewardBudget');
  }
  if (input.rewardTerms !== undefined) {
    // Tri-state: null clears the reward terms; a string sets them.
    patch.rewardTerms =
      input.rewardTerms === null ? null : requireBoundedString(input.rewardTerms, 'rewardTerms', MAX_REWARD_TERMS_LENGTH);
    changed.push('rewardTerms');
  }
  if (input.candidateSources !== undefined) {
    patch.candidateSources = validateCandidateSources(input.candidateSources);
    changed.push('candidateSources');
  }
  if (input.completionCriteria !== undefined) {
    patch.completionCriteria = requireBoundedString(
      input.completionCriteria,
      'completionCriteria',
      MAX_COMPLETION_CRITERIA_LENGTH,
    );
    changed.push('completionCriteria');
  }

  if (changed.length === 0) {
    throw revisionError(
      'a revision must change at least one field (title, knowledgeObjective, affectedGoals, unknownIds, informationValue, urgency, currentConfidence, targetConfidence, investigationBudget, rewardBudget, rewardTerms, candidateSources or completionCriteria)',
    );
  }

  const actor = validateParty(input.actor, 'actor');
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH);
  return { missionId, patch, actor, rationale };
}

/**
 * Unknown-key rejection for revisions uses `invalid_revision_input` (the
 * input IS a revision), including the system-minted fields a caller must
 * never supply: version, changeKind, completion, recordedAt,
 * changedByPrincipal — and `status`, because lifecycle transitions are the
 * dedicated completeMission / abandonMission operations, never content
 * revisions.
 */
function rejectRevisionUnknownKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!(REVISION_INPUT_KEYS as readonly string[]).includes(key)) {
      throw new MissionsError(
        'invalid_revision_input',
        `unknown field '${key}' on the revision input (allowed: ${REVISION_INPUT_KEYS.join(', ')})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Complete / abandon (terminal-transition inputs)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CompleteMissionInput`. */
export interface ValidatedCompletionInput {
  missionId: string;
  achievedConfidence: number;
  outcome: string;
  actor: ValidatedParty;
}

export function validateCompleteMissionInput(input: CompleteMissionInput): ValidatedCompletionInput {
  try {
    return validateCompleteMissionInputInner(input);
  } catch (error) {
    // The shared field guards throw `invalid_mission_input`; for a completion
    // the correct code is `invalid_completion_input` (the events module's
    // query-wrapper precedent for code remapping).
    if (error instanceof MissionsError && error.code === 'invalid_mission_input') {
      throw new MissionsError('invalid_completion_input', error.message);
    }
    throw error;
  }
}

function validateCompleteMissionInputInner(input: CompleteMissionInput): ValidatedCompletionInput {
  if (!isPlainObject(input)) {
    throw new MissionsError('invalid_completion_input', 'completion input must be an object');
  }
  rejectCompletionUnknownKeys(input);
  const missionId = requireUuid(input.missionId, 'missionId');
  const achievedConfidence = requireUnitInterval(input.achievedConfidence, 'achievedConfidence');
  const outcome = requireBoundedString(input.outcome, 'outcome', MAX_OUTCOME_LENGTH);
  const actor = validateParty(input.actor, 'actor');
  return { missionId, achievedConfidence, outcome, actor };
}

const COMPLETION_INPUT_KEYS = ['missionId', 'achievedConfidence', 'outcome', 'actor'] as const;

function rejectCompletionUnknownKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!(COMPLETION_INPUT_KEYS as readonly string[]).includes(key)) {
      throw new MissionsError(
        'invalid_completion_input',
        `unknown field '${key}' on the completion input (allowed: ${COMPLETION_INPUT_KEYS.join(', ')})`,
      );
    }
  }
}

/** Fully validated + normalized form of `AbandonMissionInput`. */
export interface ValidatedAbandonmentInput {
  missionId: string;
  reason: string;
  actor: ValidatedParty;
}

export function validateAbandonMissionInput(input: AbandonMissionInput): ValidatedAbandonmentInput {
  try {
    return validateAbandonMissionInputInner(input);
  } catch (error) {
    // The shared field guards throw `invalid_mission_input`; for an
    // abandonment the correct code is `invalid_abandonment_input`.
    if (error instanceof MissionsError && error.code === 'invalid_mission_input') {
      throw new MissionsError('invalid_abandonment_input', error.message);
    }
    throw error;
  }
}

function validateAbandonMissionInputInner(input: AbandonMissionInput): ValidatedAbandonmentInput {
  if (!isPlainObject(input)) {
    throw new MissionsError('invalid_abandonment_input', 'abandonment input must be an object');
  }
  rejectAbandonmentUnknownKeys(input);
  const missionId = requireUuid(input.missionId, 'missionId');
  const reason = requireBoundedString(input.reason, 'reason', MAX_REASON_LENGTH);
  const actor = validateParty(input.actor, 'actor');
  return { missionId, reason, actor };
}

const ABANDONMENT_INPUT_KEYS = ['missionId', 'reason', 'actor'] as const;

function rejectAbandonmentUnknownKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!(ABANDONMENT_INPUT_KEYS as readonly string[]).includes(key)) {
      throw new MissionsError(
        'invalid_abandonment_input',
        `unknown field '${key}' on the abandonment input (allowed: ${ABANDONMENT_INPUT_KEYS.join(', ')})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ListMissionsQuery`. */
export interface ValidatedListQuery {
  status: MissionStatus | null;
  urgency: MissionUrgency | null;
  affectedGoalId: string | null;
  unknownId: string | null;
  candidateKind: MissionCandidateKind | null;
  candidateId: string | null;
  search: string | null;
  limit: number;
}

export function validateListMissionsQuery(query: ListMissionsQuery): ValidatedListQuery {
  try {
    return validateListMissionsQueryInner(query);
  } catch (error) {
    if (error instanceof MissionsError && error.code === 'invalid_mission_input') {
      throw new MissionsError('invalid_query', error.message);
    }
    throw error;
  }
}

function validateListMissionsQueryInner(query: ListMissionsQuery): ValidatedListQuery {
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
    query.status === undefined
      ? null
      : requireQueryEnum(query.status, 'query.status', MISSION_STATUSES);
  const urgency =
    query.urgency === undefined
      ? null
      : requireQueryEnum(query.urgency, 'query.urgency', MISSION_URGENCIES);

  const affectedGoalId =
    query.affectedGoalId === undefined
      ? null
      : requireUuid(query.affectedGoalId, 'query.affectedGoalId');
  const unknownId =
    query.unknownId === undefined ? null : requireUuid(query.unknownId, 'query.unknownId');

  const candidateKind =
    query.candidateKind === undefined
      ? null
      : requireQueryEnum(query.candidateKind, 'query.candidateKind', MISSION_CANDIDATE_KINDS);
  const candidateIdRaw =
    query.candidateId === undefined ? null : requireString(query.candidateId, 'query.candidateId');
  if (candidateIdRaw !== null && candidateKind === null) {
    throw queryError(
      'query.candidateId requires query.candidateKind (an id is meaningless without its kind)',
    );
  }
  const candidateId = candidateIdRaw === null ? null : requireUuid(candidateIdRaw, 'query.candidateId');

  const search =
    query.search === undefined
      ? null
      : requireBoundedString(query.search, 'query.search', MAX_SEARCH_LENGTH);

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
    urgency,
    affectedGoalId,
    unknownId,
    candidateKind,
    candidateId,
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

/** Fully validated + normalized form of `GetMissionVersionQuery`. */
export interface ValidatedVersionQuery {
  missionId: string;
  version: number;
}

export function validateVersionQuery(query: GetMissionVersionQuery): ValidatedVersionQuery {
  try {
    return validateVersionQueryInner(query);
  } catch (error) {
    if (error instanceof MissionsError && error.code === 'invalid_mission_input') {
      throw new MissionsError('invalid_query', error.message);
    }
    throw error;
  }
}

function validateVersionQueryInner(query: GetMissionVersionQuery): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'missionId' && key !== 'version');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: missionId, version)`);
  }
  const missionId = requireUuid(query.missionId, 'query.missionId');
  if (
    typeof query.version !== 'number' ||
    !Number.isInteger(query.version) ||
    query.version < 1
  ) {
    throw queryError(`query.version must be an integer >= 1 (got ${String(query.version)})`);
  }
  return { missionId, version: query.version };
}

/** Fully validated + normalized form of `ListMissionVersionsQuery`. */
export interface ValidatedHistoryQuery {
  missionId: string;
}

export function validateHistoryQuery(query: ListMissionVersionsQuery): ValidatedHistoryQuery {
  try {
    return validateHistoryQueryInner(query);
  } catch (error) {
    if (error instanceof MissionsError && error.code === 'invalid_mission_input') {
      throw new MissionsError('invalid_query', error.message);
    }
    throw error;
  }
}

function validateHistoryQueryInner(query: ListMissionVersionsQuery): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'missionId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: missionId)`);
  }
  return { missionId: requireUuid(query.missionId, 'query.missionId') };
}
