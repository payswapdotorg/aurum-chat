// Pure validation/normalization logic of the opportunities module (no
// database). Everything a caller may put into a conversion pass, a revision
// or a query crosses these guards first; the SQL CHECK constraints in
// migrations/001-opportunities.sql mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `changeKind`, `confidence`, `support`,
// `evidenceFingerprint`, `recordedAt` or `changedByPrincipal` into an
// input — the opportunity's identity, tenancy, version number, change
// classification, DERIVED confidence and commit time are minted by the
// system (audit fields are not caller-forgeable, and the derived
// confidence is never caller-suppliable — lock 10).
//
// Evidence ids, goal ids and execution ids are validated as uuids here and
// existence/tenancy/readability through their owning contracts in the
// service (the missions/attention precedent).

import type { TenantContext } from '@/infra/tenant';
import { OpportunitiesError } from './errors';
import type {
  ConvertSignalsInput,
  ConversionTriggerKind,
  GetConversionCandidateQuery,
  GetConversionRunQuery,
  GetOpportunityVersionQuery,
  ListConversionRunsQuery,
  ListOpportunitiesQuery,
  ListOpportunityVersionsQuery,
  Money,
  NextActionKind,
  OpportunityPartyKind,
  OpportunityStatus,
  ReviseOpportunityInput,
  SignalOrigin,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const SIGNAL_ORIGINS = ['external', 'internal'] as const;

export const OPPORTUNITY_STATUSES = ['open', 'pursued', 'dismissed'] as const;

export const OPPORTUNITY_CHANGE_KINDS = [
  'created',
  'revised',
  'pursued',
  'dismissed',
  'reactivated',
] as const;

export const CONVERSION_TRIGGER_KINDS = [
  'cognitive-execution',
  'scheduled',
  'manual',
] as const;

export const CANDIDATE_DISPOSITIONS = [
  'converted',
  'below_threshold',
  'currency_mismatch',
  'duplicate',
] as const;

export const NEXT_ACTION_KINDS = ['monitor', 'investigate', 'recommend'] as const;

/** Kinds of parties that can drive a conversion pass or a revision. */
export const OPPORTUNITY_PARTY_KINDS = [
  'person',
  'team',
  'agent',
  'system',
  'external',
] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MAX_STATEMENT_LENGTH = 2000;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;

/** Evidence references per list (observations, claims — the claim cap). */
export const MAX_EVIDENCE_REFS = 16;
/** Candidates per conversion pass (the run is bounded, never a trawl). */
export const MAX_CANDIDATES_PER_RUN = 50;
/** Affected goals per opportunity version (the missions cap). */
export const MAX_AFFECTED_GOALS = 16;
/** Required capabilities per opportunity version. */
export const MAX_CAPABILITY_REFS = 16;
/** World entity references per opportunity version. */
export const MAX_WORLD_ENTITY_REFS = 16;

/** Money: integer minor units, capped at Number.MAX_SAFE_INTEGER (missions). */
export const MAX_VALUE_AMOUNT = 9_007_199_254_740_991;

/** Longest deterministic evidence fingerprint (2 × 16 uuids + separators). */
export const MAX_FINGERPRINT_LENGTH = 2048;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

export function isSignalOrigin(value: unknown): value is SignalOrigin {
  return typeof value === 'string' && (SIGNAL_ORIGINS as readonly string[]).includes(value);
}

export function isOpportunityStatus(value: unknown): value is OpportunityStatus {
  return (
    typeof value === 'string' && (OPPORTUNITY_STATUSES as readonly string[]).includes(value)
  );
}

export function isConversionTriggerKind(value: unknown): value is ConversionTriggerKind {
  return (
    typeof value === 'string' &&
    (CONVERSION_TRIGGER_KINDS as readonly string[]).includes(value)
  );
}

export function isNextActionKind(value: unknown): value is NextActionKind {
  return typeof value === 'string' && (NEXT_ACTION_KINDS as readonly string[]).includes(value);
}

export function isOpportunityPartyKind(value: unknown): value is OpportunityPartyKind {
  return (
    typeof value === 'string' &&
    (OPPORTUNITY_PARTY_KINDS as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertOpportunitiesTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new OpportunitiesError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new OpportunitiesError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new OpportunitiesError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

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
  error: (message: string) => OpportunitiesError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw error(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function inputError(message: string): OpportunitiesError {
  return new OpportunitiesError('invalid_conversion_input', message);
}

function revisionError(message: string): OpportunitiesError {
  return new OpportunitiesError('invalid_revision_input', message);
}

function queryError(message: string): OpportunitiesError {
  return new OpportunitiesError('invalid_query', message);
}

function requireString(
  value: unknown,
  field: string,
  error: (message: string) => OpportunitiesError,
): string {
  if (typeof value !== 'string') throw error(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw error(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(
  value: unknown,
  field: string,
  error: (message: string) => OpportunitiesError,
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, error);
  return text === '' ? null : text;
}

function requireUuid(
  value: unknown,
  field: string,
  error: (message: string) => OpportunitiesError,
): string {
  const text = requireString(value, field, error);
  if (!UUID_PATTERN.test(text)) {
    throw error(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/** Case-insensitive ILIKE wildcard escaping (the missions module's helper). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function requireListLimit(value: unknown, error: (m: string) => OpportunitiesError): number {
  const limit = value === undefined ? DEFAULT_LIST_LIMIT : value;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw error(`query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }
  return limit;
}

function requireQueryUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw queryError(`${field} must be a uuid (got '${String(value)}')`);
  }
  return value.toLowerCase();
}

/** Id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Party (audit actor)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `OpportunityParty`. */
export interface ValidatedParty {
  kind: OpportunityPartyKind;
  id: string | null;
  label: string | null;
}

const PARTY_KEYS = ['kind', 'id', 'label'] as const;

function validateParty(
  value: unknown,
  where: string,
  error: (message: string) => OpportunitiesError,
): ValidatedParty {
  if (!isPlainObject(value)) throw error(`${where} must be an object`);
  rejectUnknownKeys(value, PARTY_KEYS, where, error);
  if (!isOpportunityPartyKind(value.kind)) {
    throw error(
      `${where}.kind must be one of ${OPPORTUNITY_PARTY_KINDS.join(', ')} (got '${String(value.kind)}')`,
    );
  }
  const id = optionalTrimmed(value.id, `${where}.id`, error);
  const label = optionalTrimmed(value.label, `${where}.label`, error);
  if (label !== null && label.length > MAX_PARTY_LABEL_LENGTH) {
    throw error(`${where}.label must be at most ${MAX_PARTY_LABEL_LENGTH} characters`);
  }
  if (id === null && label === null) {
    throw error(`${where} must carry an id or a label — audit actors are traceable`);
  }
  return { kind: value.kind, id, label };
}

// ---------------------------------------------------------------------------
// Money + reference lists
// ---------------------------------------------------------------------------

const MONEY_KEYS = ['amount', 'currency'] as const;

/** Fully validated + normalized form of `Money`. */
export function validateMoney(
  value: unknown,
  where: string,
  error: (message: string) => OpportunitiesError,
): Money {
  if (!isPlainObject(value)) throw error(`${where} must be an object {amount, currency}`);
  rejectUnknownKeys(value, MONEY_KEYS, where, error);
  const amount = value.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
    throw error(
      `${where}.amount must be a non-negative integer number of minor units (got ${String(amount)})`,
    );
  }
  if (amount > MAX_VALUE_AMOUNT) {
    throw error(`${where}.amount must not exceed ${MAX_VALUE_AMOUNT} minor units (got ${amount})`);
  }
  const currency = requireString(value.currency, `${where}.currency`, error);
  if (!CURRENCY_PATTERN.test(currency)) {
    throw error(
      `${where}.currency must be a 3-letter ISO 4217 currency code, e.g. 'EUR' (got '${currency}')`,
    );
  }
  return { amount, currency };
}

/** A validated, sorted, deduplicated uuid list. */
function requireUuidList(
  value: unknown,
  field: string,
  max: number,
  error: (message: string) => OpportunitiesError,
): string[] {
  if (!Array.isArray(value)) throw error(`${field} must be an array of uuids`);
  if (value.length > max) {
    throw error(`${field} supports at most ${max} entries (got ${value.length})`);
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const normalized = requireUuid(entry, `${field}[${index}]`, error);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Goal / capability / world-entity references
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `OpportunityGoalRefInput`. */
export interface ValidatedGoalRefInput {
  goalId: string;
  label: string | null;
}

const GOAL_REF_KEYS = ['goalId', 'label'] as const;

function validateGoalRef(
  value: unknown,
  where: string,
  error: (message: string) => OpportunitiesError,
): ValidatedGoalRefInput {
  if (!isPlainObject(value)) throw error(`${where} must be an object {goalId, label?}`);
  rejectUnknownKeys(value, GOAL_REF_KEYS, where, error);
  const goalId = requireUuid(value.goalId, `${where}.goalId`, error);
  const label = optionalTrimmed(value.label, `${where}.label`, error);
  if (label !== null && label.length > MAX_PARTY_LABEL_LENGTH) {
    throw error(`${where}.label must be at most ${MAX_PARTY_LABEL_LENGTH} characters`);
  }
  return { goalId, label };
}

/** Fully validated + normalized form of `CapabilityRefInput`. */
export interface ValidatedCapabilityRefInput {
  capabilityId: string;
  label: string | null;
}

const CAPABILITY_REF_KEYS = ['capabilityId', 'label'] as const;

function validateCapabilityRef(
  value: unknown,
  where: string,
  error: (message: string) => OpportunitiesError,
): ValidatedCapabilityRefInput {
  if (!isPlainObject(value)) throw error(`${where} must be an object {capabilityId, label?}`);
  rejectUnknownKeys(value, CAPABILITY_REF_KEYS, where, error);
  const capabilityId = requireUuid(value.capabilityId, `${where}.capabilityId`, error);
  const label = optionalTrimmed(value.label, `${where}.label`, error);
  if (label !== null && label.length > MAX_PARTY_LABEL_LENGTH) {
    throw error(`${where}.label must be at most ${MAX_PARTY_LABEL_LENGTH} characters`);
  }
  return { capabilityId, label };
}

/** Fully validated + normalized form of `WorldEntityRefInput`. */
export interface ValidatedWorldEntityRefInput {
  entityId: string;
  label: string | null;
}

const WORLD_ENTITY_REF_KEYS = ['entityId', 'label'] as const;

function validateWorldEntityRef(
  value: unknown,
  where: string,
  error: (message: string) => OpportunitiesError,
): ValidatedWorldEntityRefInput {
  if (!isPlainObject(value)) throw error(`${where} must be an object {entityId, label?}`);
  rejectUnknownKeys(value, WORLD_ENTITY_REF_KEYS, where, error);
  const entityId = requireUuid(value.entityId, `${where}.entityId`, error);
  const label = optionalTrimmed(value.label, `${where}.label`, error);
  if (label !== null && label.length > MAX_PARTY_LABEL_LENGTH) {
    throw error(`${where}.label must be at most ${MAX_PARTY_LABEL_LENGTH} characters`);
  }
  return { entityId, label };
}

// ---------------------------------------------------------------------------
// The judgment fields shared by candidates and revisions
// ---------------------------------------------------------------------------

/** The validated evidence basis input: sorted, deduplicated, ≥1 total. */
export interface ValidatedEvidenceInput {
  observationIds: string[];
  claimIds: string[];
}

const EVIDENCE_KEYS = ['observationIds', 'claimIds'] as const;

function validateEvidence(
  value: unknown,
  where: string,
  error: (message: string) => OpportunitiesError,
): ValidatedEvidenceInput {
  if (!isPlainObject(value)) throw error(`${where} must be an object {observationIds?, claimIds?}`);
  rejectUnknownKeys(value, EVIDENCE_KEYS, where, error);
  const observationIds =
    value.observationIds === undefined ? [] : requireUuidList(value.observationIds, `${where}.observationIds`, MAX_EVIDENCE_REFS, error);
  const claimIds =
    value.claimIds === undefined ? [] : requireUuidList(value.claimIds, `${where}.claimIds`, MAX_EVIDENCE_REFS, error);
  if (observationIds.length === 0 && claimIds.length === 0) {
    throw inputError(
      `${where} must cite at least one observation or claim — an opportunity is never derived from nothing`,
    );
  }
  return { observationIds, claimIds };
}

/** Fully validated + normalized form of `RecommendedNextActionInput`. */
export interface ValidatedNextAction {
  kind: NextActionKind;
  statement: string;
}

const NEXT_ACTION_KEYS = ['kind', 'statement'] as const;

function validateNextAction(
  value: unknown,
  where: string,
  error: (message: string) => OpportunitiesError,
): ValidatedNextAction {
  if (!isPlainObject(value)) throw error(`${where} must be an object {kind, statement}`);
  rejectUnknownKeys(value, NEXT_ACTION_KEYS, where, error);
  if (!isNextActionKind(value.kind)) {
    throw error(
      `${where}.kind must be one of ${NEXT_ACTION_KINDS.join(', ')} (got '${String(value.kind)}')`,
    );
  }
  const statement = requireString(value.statement, `${where}.statement`, error);
  if (statement.length > MAX_STATEMENT_LENGTH) {
    throw error(
      `${where}.statement must be at most ${MAX_STATEMENT_LENGTH} characters (got ${statement.length})`,
    );
  }
  return { kind: value.kind, statement };
}

/**
 * The validated judgment core shared by conversion candidates and revision
 * patches: everything except signalOrigin (candidates) and status
 * (revisions), which their own validators own.
 */
export interface ValidatedJudgment {
  title: string;
  description: string;
  estimatedValue: Money;
  affectedGoals: ValidatedGoalRefInput[];
  requiredCapabilities: ValidatedCapabilityRefInput[];
  worldEntities: ValidatedWorldEntityRefInput[];
  recommendedNextAction: ValidatedNextAction;
}

function validateJudgment(
  value: Record<string, unknown>,
  where: string,
  error: (message: string) => OpportunitiesError,
): ValidatedJudgment {
  const title = requireString(value.title, `${where}.title`, error);
  if (title.length > MAX_TITLE_LENGTH) {
    throw error(`${where}.title must be at most ${MAX_TITLE_LENGTH} characters (got ${title.length})`);
  }
  const description = requireString(value.description, `${where}.description`, error);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw error(
      `${where}.description must be at most ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length})`,
    );
  }
  const estimatedValue = validateMoney(value.estimatedValue, `${where}.estimatedValue`, error);
  const nextAction = validateNextAction(value.recommendedNextAction, `${where}.recommendedNextAction`, error);

  const affectedGoals: ValidatedGoalRefInput[] = [];
  if (value.affectedGoals !== undefined && value.affectedGoals !== null) {
    if (!Array.isArray(value.affectedGoals)) {
      throw error(`${where}.affectedGoals must be an array`);
    }
    if (value.affectedGoals.length > MAX_AFFECTED_GOALS) {
      throw error(
        `${where}.affectedGoals supports at most ${MAX_AFFECTED_GOALS} entries (got ${value.affectedGoals.length})`,
      );
    }
    for (const [index, entry] of (value.affectedGoals as unknown[]).entries()) {
      affectedGoals.push(validateGoalRef(entry, `${where}.affectedGoals[${index}]`, error));
    }
  }

  const requiredCapabilities: ValidatedCapabilityRefInput[] = [];
  if (value.requiredCapabilities !== undefined && value.requiredCapabilities !== null) {
    if (!Array.isArray(value.requiredCapabilities)) {
      throw error(`${where}.requiredCapabilities must be an array`);
    }
    if (value.requiredCapabilities.length > MAX_CAPABILITY_REFS) {
      throw error(
        `${where}.requiredCapabilities supports at most ${MAX_CAPABILITY_REFS} entries (got ${value.requiredCapabilities.length})`,
      );
    }
    for (const [index, entry] of (value.requiredCapabilities as unknown[]).entries()) {
      requiredCapabilities.push(
        validateCapabilityRef(entry, `${where}.requiredCapabilities[${index}]`, error),
      );
    }
  }

  const worldEntities: ValidatedWorldEntityRefInput[] = [];
  if (value.worldEntities !== undefined && value.worldEntities !== null) {
    if (!Array.isArray(value.worldEntities)) {
      throw error(`${where}.worldEntities must be an array`);
    }
    if (value.worldEntities.length > MAX_WORLD_ENTITY_REFS) {
      throw error(
        `${where}.worldEntities supports at most ${MAX_WORLD_ENTITY_REFS} entries (got ${value.worldEntities.length})`,
      );
    }
    for (const [index, entry] of (value.worldEntities as unknown[]).entries()) {
      worldEntities.push(validateWorldEntityRef(entry, `${where}.worldEntities[${index}]`, error));
    }
  }

  return {
    title,
    description,
    estimatedValue,
    affectedGoals,
    requiredCapabilities,
    worldEntities,
    recommendedNextAction: nextAction,
  };
}

// ---------------------------------------------------------------------------
// The recordability policy
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_CONFIDENCE = 0.5;

const POLICY_KEYS = ['minConfidence', 'minValue'] as const;

/** Fully validated + normalized form of `ConversionPolicyInput`. */
export interface ValidatedPolicy {
  minConfidence: number;
  minValue: Money | null;
}

export function validatePolicy(
  value: ConvertSignalsInput['policy'],
  error: (message: string) => OpportunitiesError,
): ValidatedPolicy {
  const raw = value === undefined || value === null ? {} : value;
  if (!isPlainObject(raw)) throw error('policy must be an object');
  rejectUnknownKeys(raw, POLICY_KEYS, 'policy', error);

  let minConfidence = DEFAULT_MIN_CONFIDENCE;
  if (raw.minConfidence !== undefined && raw.minConfidence !== null) {
    const value2 = raw.minConfidence;
    if (typeof value2 !== 'number' || !Number.isFinite(value2) || value2 < 0 || value2 > 1) {
      throw error(
        `policy.minConfidence must be a finite number in [0, 1] (got ${String(value2)})`,
      );
    }
    minConfidence = value2;
  }

  const minValue =
    raw.minValue === undefined || raw.minValue === null
      ? null
      : validateMoney(raw.minValue, 'policy.minValue', error);

  return { minConfidence, minValue };
}

// ---------------------------------------------------------------------------
// convertSignals input
// ---------------------------------------------------------------------------

const TRIGGER_KEYS = ['kind'] as const;

const CANDIDATE_KEYS = [
  'title',
  'description',
  'signalOrigin',
  'evidence',
  'estimatedValue',
  'affectedGoals',
  'requiredCapabilities',
  'worldEntities',
  'recommendedNextAction',
] as const;

const RUN_INPUT_KEYS = [
  'trigger',
  'originatingExecutionId',
  'policy',
  'candidates',
  'actor',
  'rationale',
] as const;

/** Fully validated + normalized form of one `SignalCandidateInput`. */
export interface ValidatedCandidateInput {
  signalOrigin: SignalOrigin;
  evidence: ValidatedEvidenceInput;
  judgment: ValidatedJudgment;
}

/** Fully validated + normalized form of `ConvertSignalsInput`. */
export interface ValidatedRunInput {
  triggerKind: ConversionTriggerKind;
  originatingExecutionId: string | null;
  policy: ValidatedPolicy;
  candidates: ValidatedCandidateInput[];
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateConvertSignalsInput(input: ConvertSignalsInput): ValidatedRunInput {
  if (!isPlainObject(input)) throw inputError('conversion input must be an object');
  rejectUnknownKeys(input, RUN_INPUT_KEYS, 'the conversion input', inputError);

  // --- trigger ---
  if (!isPlainObject(input.trigger)) throw inputError('trigger must be an object');
  rejectUnknownKeys(input.trigger, TRIGGER_KEYS, 'trigger', inputError);
  if (!isConversionTriggerKind(input.trigger.kind)) {
    throw inputError(
      `trigger.kind must be one of ${CONVERSION_TRIGGER_KINDS.join(', ')} (got '${String(input.trigger.kind)}')`,
    );
  }
  const triggerKind = input.trigger.kind;

  // --- originating execution link ---
  const originatingExecutionId =
    input.originatingExecutionId === undefined || input.originatingExecutionId === null
      ? null
      : requireUuid(input.originatingExecutionId, 'originatingExecutionId', inputError);
  if (triggerKind === 'cognitive-execution' && originatingExecutionId === null) {
    throw inputError(
      "trigger.kind 'cognitive-execution' requires originatingExecutionId — the loop linkage is the trigger",
    );
  }

  // --- policy ---
  const policy = validatePolicy(input.policy, inputError);

  // --- candidates ---
  if (!Array.isArray(input.candidates)) throw inputError('candidates must be an array');
  if (input.candidates.length === 0) {
    throw inputError('candidates must hold at least one entry — a pass converts signals, it is not a no-op');
  }
  if (input.candidates.length > MAX_CANDIDATES_PER_RUN) {
    throw inputError(
      `candidates supports at most ${MAX_CANDIDATES_PER_RUN} entries (got ${input.candidates.length})`,
    );
  }
  const candidates: ValidatedCandidateInput[] = input.candidates.map((raw, index) => {
    const where = `candidates[${index}]`;
    if (!isPlainObject(raw)) throw inputError(`${where} must be an object`);
    rejectUnknownKeys(raw, CANDIDATE_KEYS, where, inputError);
    if (!isSignalOrigin(raw.signalOrigin)) {
      throw inputError(
        `${where}.signalOrigin must be one of ${SIGNAL_ORIGINS.join(', ')} (got '${String(raw.signalOrigin)}')`,
      );
    }
    const evidence = validateEvidence(raw.evidence, `${where}.evidence`, inputError);
    const judgment = validateJudgment(raw, where, inputError);
    return { signalOrigin: raw.signalOrigin, evidence, judgment };
  });

  // --- audit ---
  const actor = validateParty(input.actor, 'actor', inputError);
  const rationale = optionalTrimmed(input.rationale, 'rationale', inputError);
  if (rationale !== null && rationale.length > MAX_RATIONALE_LENGTH) {
    throw inputError(`rationale must be at most ${MAX_RATIONALE_LENGTH} characters`);
  }

  return { triggerKind, originatingExecutionId, policy, candidates, actor, rationale };
}

// ---------------------------------------------------------------------------
// reviseOpportunity input
// ---------------------------------------------------------------------------

const REVISION_INPUT_KEYS = [
  'opportunityId',
  'title',
  'description',
  'evidence',
  'estimatedValue',
  'affectedGoals',
  'requiredCapabilities',
  'worldEntities',
  'recommendedNextAction',
  'status',
  'expectedVersion',
  'actor',
  'rationale',
] as const;

/**
 * Fully validated + normalized form of `ReviseOpportunityInput`: either a
 * surgical `status` transition (nothing else set) or a content patch
 * (status absent). The service merges the patch over the current version
 * and re-validates the merged judgment through `validateJudgmentContent`.
 */
export interface ValidatedRevisionPatch {
  opportunityId: string;
  status: OpportunityStatus | null;
  expectedVersion: number | null;
  title: string | null;
  description: string | null;
  evidence: ValidatedEvidenceInput | null;
  estimatedValue: Money | null;
  affectedGoals: ValidatedGoalRefInput[] | null;
  requiredCapabilities: ValidatedCapabilityRefInput[] | null;
  worldEntities: ValidatedWorldEntityRefInput[] | null;
  recommendedNextAction: ValidatedNextAction | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseOpportunityInput(input: ReviseOpportunityInput): ValidatedRevisionPatch {
  if (!isPlainObject(input)) throw revisionError('revision input must be an object');
  rejectUnknownKeys(input, REVISION_INPUT_KEYS, 'the revision input', revisionError);

  const opportunityId = requireUuid(input.opportunityId, 'opportunityId', revisionError);

  // --- lifecycle (surgical when present) ---
  let status: ReviseOpportunityInput['status'] | null = null;
  if (input.status !== undefined && input.status !== null) {
    if (!isOpportunityStatus(input.status)) {
      throw revisionError(
        `status must be one of ${OPPORTUNITY_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    status = input.status;
  }

  // --- optimistic concurrency ---
  let expectedVersion: number | null = null;
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    if (
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw revisionError(
        `expectedVersion must be an integer ≥ 1 (got ${String(input.expectedVersion)})`,
      );
    }
    expectedVersion = input.expectedVersion;
  }

  const contentPresent =
    (input.title !== undefined && input.title !== null) ||
    (input.description !== undefined && input.description !== null) ||
    input.evidence !== undefined ||
    input.estimatedValue !== undefined ||
    input.affectedGoals !== undefined ||
    input.requiredCapabilities !== undefined ||
    input.worldEntities !== undefined ||
    input.recommendedNextAction !== undefined;
  if (status !== null && contentPresent) {
    throw revisionError(
      "a status change must be the revision's only change — lifecycle transitions are surgical (no title, description, evidence, estimatedValue, affectedGoals, requiredCapabilities, worldEntities or recommendedNextAction alongside it)",
    );
  }

  const title = optionalTrimmed(input.title, 'title', revisionError);
  if (title !== null && title.length > MAX_TITLE_LENGTH) {
    throw revisionError(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  const description = optionalTrimmed(input.description, 'description', revisionError);
  if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
    throw revisionError(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const evidence =
    input.evidence === undefined || input.evidence === null
      ? null
      : validateEvidence(input.evidence, 'evidence', revisionError);
  const estimatedValue =
    input.estimatedValue === undefined || input.estimatedValue === null
      ? null
      : validateMoney(input.estimatedValue, 'estimatedValue', revisionError);

  let affectedGoals: ValidatedGoalRefInput[] | null = null;
  if (input.affectedGoals !== undefined && input.affectedGoals !== null) {
    if (!Array.isArray(input.affectedGoals)) {
      throw revisionError('affectedGoals must be an array');
    }
    if (input.affectedGoals.length > MAX_AFFECTED_GOALS) {
      throw revisionError(
        `affectedGoals supports at most ${MAX_AFFECTED_GOALS} entries (got ${input.affectedGoals.length})`,
      );
    }
    affectedGoals = (input.affectedGoals as unknown[]).map((entry, index) =>
      validateGoalRef(entry, `affectedGoals[${index}]`, revisionError),
    );
  }

  let requiredCapabilities: ValidatedCapabilityRefInput[] | null = null;
  if (input.requiredCapabilities !== undefined && input.requiredCapabilities !== null) {
    if (!Array.isArray(input.requiredCapabilities)) {
      throw revisionError('requiredCapabilities must be an array');
    }
    if (input.requiredCapabilities.length > MAX_CAPABILITY_REFS) {
      throw revisionError(
        `requiredCapabilities supports at most ${MAX_CAPABILITY_REFS} entries (got ${input.requiredCapabilities.length})`,
      );
    }
    requiredCapabilities = (input.requiredCapabilities as unknown[]).map((entry, index) =>
      validateCapabilityRef(entry, `requiredCapabilities[${index}]`, revisionError),
    );
  }

  let worldEntities: ValidatedWorldEntityRefInput[] | null = null;
  if (input.worldEntities !== undefined && input.worldEntities !== null) {
    if (!Array.isArray(input.worldEntities)) {
      throw revisionError('worldEntities must be an array');
    }
    if (input.worldEntities.length > MAX_WORLD_ENTITY_REFS) {
      throw revisionError(
        `worldEntities supports at most ${MAX_WORLD_ENTITY_REFS} entries (got ${input.worldEntities.length})`,
      );
    }
    worldEntities = (input.worldEntities as unknown[]).map((entry, index) =>
      validateWorldEntityRef(entry, `worldEntities[${index}]`, revisionError),
    );
  }

  const recommendedNextAction =
    input.recommendedNextAction === undefined || input.recommendedNextAction === null
      ? null
      : validateNextAction(input.recommendedNextAction, 'recommendedNextAction', revisionError);

  const actor = validateParty(input.actor, 'actor', revisionError);
  const rationale = optionalTrimmed(input.rationale, 'rationale', revisionError);
  if (rationale !== null && rationale.length > MAX_RATIONALE_LENGTH) {
    throw revisionError(`rationale must be at most ${MAX_RATIONALE_LENGTH} characters`);
  }

  return {
    opportunityId,
    status,
    expectedVersion,
    title,
    description,
    evidence,
    estimatedValue,
    affectedGoals,
    requiredCapabilities,
    worldEntities,
    recommendedNextAction,
    actor,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `GetOpportunityVersionQuery`. */
export interface ValidatedVersionQuery {
  opportunityId: string;
  version: number;
}

export function validateVersionQuery(query: GetOpportunityVersionQuery): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(['opportunityId', 'version'] as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: opportunityId, version)`);
  }
  const version = query.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw queryError(`query.version must be an integer ≥ 1 (got ${String(version)})`);
  }
  return {
    opportunityId: requireQueryUuid(query.opportunityId, 'query.opportunityId'),
    version,
  };
}

/** Fully validated + normalized form of `ListOpportunityVersionsQuery`. */
export interface ValidatedHistoryQuery {
  opportunityId: string;
}

export function validateHistoryQuery(query: ListOpportunityVersionsQuery): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'opportunityId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: opportunityId)`);
  }
  return { opportunityId: requireQueryUuid(query.opportunityId, 'query.opportunityId') };
}

const LIST_QUERY_KEYS = [
  'status',
  'signalOrigin',
  'minConfidence',
  'goalId',
  'capabilityId',
  'worldEntityId',
  'search',
  'limit',
] as const;

/** Fully validated + normalized form of `ListOpportunitiesQuery`. */
export interface ValidatedListQuery {
  status: OpportunityStatus | null;
  signalOrigin: SignalOrigin | null;
  minConfidence: number;
  goalId: string | null;
  capabilityId: string | null;
  worldEntityId: string | null;
  search: string | null;
  limit: number;
}

export function validateListOpportunitiesQuery(query: ListOpportunitiesQuery): ValidatedListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_QUERY_KEYS.join(', ')})`,
    );
  }

  let status: ValidatedListQuery['status'] = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isOpportunityStatus(query.status)) {
      throw queryError(
        `query.status must be one of ${OPPORTUNITY_STATUSES.join(', ')} (got '${String(query.status)}')`,
      );
    }
    status = query.status;
  }

  let signalOrigin: SignalOrigin | null = null;
  if (query.signalOrigin !== undefined && query.signalOrigin !== null) {
    if (!isSignalOrigin(query.signalOrigin)) {
      throw queryError(
        `query.signalOrigin must be one of ${SIGNAL_ORIGINS.join(', ')} (got '${String(query.signalOrigin)}')`,
      );
    }
    signalOrigin = query.signalOrigin;
  }

  let minConfidence = 0;
  if (query.minConfidence !== undefined && query.minConfidence !== null) {
    const value = query.minConfidence;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw queryError(
        `query.minConfidence must be a finite number in [0, 1] (got ${String(value)})`,
      );
    }
    minConfidence = value;
  }

  const goalId =
    query.goalId === undefined || query.goalId === null
      ? null
      : requireQueryUuid(query.goalId, 'query.goalId');
  const capabilityId =
    query.capabilityId === undefined || query.capabilityId === null
      ? null
      : requireQueryUuid(query.capabilityId, 'query.capabilityId');
  const worldEntityId =
    query.worldEntityId === undefined || query.worldEntityId === null
      ? null
      : requireQueryUuid(query.worldEntityId, 'query.worldEntityId');

  const search = optionalTrimmed(query.search, 'query.search', queryError);
  if (search !== null && search.length > MAX_SEARCH_LENGTH) {
    throw queryError(`query.search must be at most ${MAX_SEARCH_LENGTH} characters`);
  }

  return {
    status,
    signalOrigin,
    minConfidence,
    goalId,
    capabilityId,
    worldEntityId,
    search,
    limit: requireListLimit(query.limit, queryError),
  };
}

/** Fully validated + normalized form of `GetConversionRunQuery`. */
export interface ValidatedRunQuery {
  runId: string;
}

export function validateRunQuery(query: GetConversionRunQuery): ValidatedRunQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'runId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: runId)`);
  }
  return { runId: requireQueryUuid(query.runId, 'query.runId') };
}

const RUN_LIST_QUERY_KEYS = ['triggerKind', 'originatingExecutionId', 'limit'] as const;

/** Fully validated + normalized form of `ListConversionRunsQuery`. */
export interface ValidatedRunListQuery {
  triggerKind: ConversionTriggerKind | null;
  originatingExecutionId: string | null;
  limit: number;
}

export function validateRunListQuery(query: ListConversionRunsQuery): ValidatedRunListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(RUN_LIST_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${RUN_LIST_QUERY_KEYS.join(', ')})`,
    );
  }

  let triggerKind: ValidatedRunListQuery['triggerKind'] = null;
  if (query.triggerKind !== undefined && query.triggerKind !== null) {
    if (!isConversionTriggerKind(query.triggerKind)) {
      throw queryError(
        `query.triggerKind must be one of ${CONVERSION_TRIGGER_KINDS.join(', ')} (got '${String(query.triggerKind)}')`,
      );
    }
    triggerKind = query.triggerKind;
  }

  const originatingExecutionId =
    query.originatingExecutionId === undefined || query.originatingExecutionId === null
      ? null
      : requireQueryUuid(query.originatingExecutionId, 'query.originatingExecutionId');

  return { triggerKind, originatingExecutionId, limit: requireListLimit(query.limit, queryError) };
}

/** Fully validated + normalized form of `GetConversionCandidateQuery`. */
export interface ValidatedCandidateQuery {
  candidateId: string;
}

export function validateCandidateQuery(query: GetConversionCandidateQuery): ValidatedCandidateQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'candidateId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: candidateId)`);
  }
  return { candidateId: requireQueryUuid(query.candidateId, 'query.candidateId') };
}
