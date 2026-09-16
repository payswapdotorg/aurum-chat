// Pure validation/normalization logic of the attention module (no
// database). Everything a caller may put into a discovery, a policy or a
// query crosses these guards first; the SQL CHECK constraints in
// migrations/001-attention.sql mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `status`, `recordedAt`, `recordedByPrincipal`,
// `materiality`, `materialization` or `confidenceGap` into a discovery —
// identity, tenancy, commit time, the deterministic materiality verdict
// and the lifecycle are minted by the system (discovery is auditable, and
// audit fields are not caller-forgeable). The proposer may PROPOSE
// content (ADR-0017's bounded-reasoning seam) but never the decision:
// `status` does not exist on the input surface at all.
//
// The confidence-gap rule (requiredConfidence > currentConfidence) is
// enforced here AND in storage: a "gap" without a confidence shortfall is
// not a gap, and a materialized mission must satisfy the missions
// module's target > current rule by construction.

import type { TenantContext } from '@/infra/tenant';
import { AttentionError } from './errors';
import type {
  CandidateUnknownStatus,
  DiscoverGoalGapInput,
  GapProposer,
  GapProposerKind,
  GapUrgency,
  GetCandidateUnknownQuery,
  ListCandidateUnknownsQuery,
  MaterializeCandidateInput,
  MissionPolicyMode,
  SetDiscoveryPolicyInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const CANDIDATE_UNKNOWN_STATUSES = [
  'immaterial',
  'material',
  'materialized',
] as const;

export const MISSION_POLICY_MODES = ['auto', 'manual'] as const;

/** Urgency vocabulary — mirrors the missions module's MISSION_URGENCIES. */
export const GAP_URGENCIES = ['critical', 'high', 'medium', 'low'] as const;

/** Acquisition-path kinds — mirrors the missions module's candidate kinds. */
export const ACQUISITION_PATH_KINDS = [
  'person',
  'system',
  'document',
  'external',
  'agent',
  'analysis',
] as const;

/** Proposer kinds — the same party vocabulary the goals/missions modules use. */
export const GAP_PROPOSER_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** Authority claim that manages the tenant's discovery policy. */
export const ATTENTION_AUTHORITY_ADMINISTER = 'attention:administer';

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

/** Mirrors the epistemics module's unknown-question cap (the future unknown's question). */
export const MAX_MISSING_KNOWLEDGE_CHARS = 2048;
/** Mirrors the epistemics module's unknown-consequence cap. */
export const MAX_IMPACT_DESCRIPTION_CHARS = 2048;
/** Mirrors the epistemics module's note cap. */
export const MAX_PROPOSER_NOTE_CHARS = 2048;
/** Mirrors the missions module's MAX_METRIC-name-style bounded label cap. */
export const MAX_METRIC_NAME_CHARS = 200;
export const MAX_PROPOSER_LABEL_CHARS = 200;
export const MAX_SEARCH_CHARS = 200;
/** Mirrors the epistemics/freshness evidence-observation cap (16). */
export const MAX_EVIDENCE_OBSERVATIONS = 16;
export const MAX_EVIDENCE_CLAIMS = 16;
export const MAX_ACQUISITION_PATHS = 16;
/** Budget amounts are integer minor units up to JS safe-integer range. */
export const MAX_BUDGET_AMOUNT = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const DISCOVERY_INPUT_KEYS = [
  'goalId',
  'metricName',
  'missingKnowledge',
  'impactDescription',
  'decisionImpact',
  'informationValue',
  'urgency',
  'currentConfidence',
  'requiredConfidence',
  'evidenceObservationIds',
  'evidenceClaimIds',
  'acquisitionPaths',
  'proposer',
  'executionId',
  'proposerNote',
] as const;

const POLICY_INPUT_KEYS = [
  'minDecisionImpact',
  'minInformationValue',
  'missionPolicy',
  'investigationBudget',
  'rewardBudget',
] as const;

const PROPOSER_KEYS = ['kind', 'id', 'label'] as const;
const PATH_KEYS = ['kind', 'id', 'label'] as const;
const BUDGET_KEYS = ['amount', 'currency'] as const;

const GET_QUERY_KEYS = ['candidateId'] as const;
const MATERIALIZE_INPUT_KEYS = ['candidateId'] as const;
const LIST_QUERY_KEYS = [
  'status',
  'goalId',
  'urgency',
  'proposerKind',
  'proposerId',
  'executionId',
  'search',
  'limit',
] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isCandidateUnknownStatus(value: unknown): value is CandidateUnknownStatus {
  return isOneOf(value, CANDIDATE_UNKNOWN_STATUSES);
}

export function isMissionPolicyMode(value: unknown): value is MissionPolicyMode {
  return isOneOf(value, MISSION_POLICY_MODES);
}

export function isGapUrgency(value: unknown): value is GapUrgency {
  return isOneOf(value, GAP_URGENCIES);
}

export function isAcquisitionPathKind(
  value: unknown,
): value is (typeof ACQUISITION_PATH_KINDS)[number] {
  return isOneOf(value, ACQUISITION_PATH_KINDS);
}

export function isGapProposerKind(value: unknown): value is GapProposerKind {
  return isOneOf(value, GAP_PROPOSER_KINDS);
}

/** Uuid shape guard; malformed ids are "not found"/"invalid reference" upstream. */
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
export function assertAttentionTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AttentionError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AttentionError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new AttentionError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

/** True when `ctx` carries the discovery-policy administration claim. */
export function canAdministerDiscoveryPolicy(ctx: TenantContext): boolean {
  return ctx.authority.includes(ATTENTION_AUTHORITY_ADMINISTER);
}

// ---------------------------------------------------------------------------
// Shared primitive guards
// ---------------------------------------------------------------------------

function inputError(message: string): AttentionError {
  return new AttentionError('invalid_discovery_input', message);
}

function policyError(message: string): AttentionError {
  return new AttentionError('invalid_policy_input', message);
}

function queryError(message: string): AttentionError {
  return new AttentionError('invalid_query', message);
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
  code: AttentionError['code'],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new AttentionError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  code: AttentionError['code'],
  where: string,
): string {
  if (typeof value !== 'string') {
    throw new AttentionError(code, `${field} on ${where} must be a string`);
  }
  const text = value.trim();
  if (text === '') {
    throw new AttentionError(code, `${field} on ${where} must be a non-empty string`);
  }
  if (text.length > maxLength) {
    throw new AttentionError(
      code,
      `${field} on ${where} must be at most ${maxLength} characters (got ${text.length})`,
    );
  }
  return text;
}

function optionalTrimmed(
  value: unknown,
  field: string,
  maxLength: number,
  code: AttentionError['code'],
  where: string,
): string | null {
  if (value === undefined || value === null) return null;
  return requireBoundedString(value, field, maxLength, code, where);
}

function requireUuid(value: unknown, field: string, code: AttentionError['code']): string {
  if (typeof value !== 'string') {
    throw new AttentionError(code, `${field} must be a uuid string`);
  }
  const text = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) {
    throw new AttentionError(code, `${field} must be a uuid (got '${value}')`);
  }
  return text;
}

function requireProbability(value: unknown, field: string, code: AttentionError['code']): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AttentionError(code, `${field} must be a finite number (got ${String(value)})`);
  }
  if (value < 0 || value > 1) {
    throw new AttentionError(code, `${field} must be within [0, 1] (got ${value})`);
  }
  return value;
}

/** Sorted, deduplicated uuid list of bounded size. */
function requireUuidList(
  value: unknown,
  field: string,
  code: AttentionError['code'],
  max: number,
  min: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new AttentionError(code, `${field} must be an array of uuids`);
  }
  const ids: string[] = [];
  for (const item of value) {
    ids.push(requireUuid(item, `${field} entries`, code));
  }
  const unique = [...new Set(ids)].sort();
  if (unique.length < min || unique.length > max) {
    throw new AttentionError(
      code,
      `${field} must contain between ${min} and ${max} unique ids (got ${unique.length})`,
    );
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Parties, paths and budgets
// ---------------------------------------------------------------------------

function validateProposer(value: unknown, where: string): GapProposer {
  if (!isPlainObject(value)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(value, PROPOSER_KEYS, 'invalid_discovery_input', where);
  const kind = value.kind;
  if (!isGapProposerKind(kind)) {
    throw inputError(
      `${where}.kind must be one of ${GAP_PROPOSER_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id =
    value.id === undefined || value.id === null
      ? null
      : requireUuid(value.id, `${where}.id`, 'invalid_discovery_input');
  const label = optionalTrimmed(
    value.label,
    `${where}.label`,
    MAX_PROPOSER_LABEL_CHARS,
    'invalid_discovery_input',
    where,
  );
  if (id === null && label === null) {
    throw inputError(`${where} must carry an id or a label — the proposer must be traceable`);
  }
  return { kind, id, label };
}

function validateAcquisitionPaths(
  value: unknown,
): { kind: (typeof ACQUISITION_PATH_KINDS)[number]; id: string | null; label: string | null }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw inputError('acquisitionPaths must be an array');
  }
  if (value.length > MAX_ACQUISITION_PATHS) {
    throw inputError(
      `acquisitionPaths supports at most ${MAX_ACQUISITION_PATHS} paths (got ${value.length})`,
    );
  }
  return value.map((item, index) => {
    const where = `acquisitionPaths[${index}]`;
    if (!isPlainObject(item)) throw inputError(`${where} must be an object`);
    rejectUnknownKeys(item, PATH_KEYS, 'invalid_discovery_input', where);
    const kind = item.kind;
    if (!isAcquisitionPathKind(kind)) {
      throw inputError(
        `${where}.kind must be one of ${ACQUISITION_PATH_KINDS.join(', ')} (got '${String(kind)}')`,
      );
    }
    const id =
      item.id === undefined || item.id === null
        ? null
        : requireUuid(item.id, `${where}.id`, 'invalid_discovery_input');
    const label = optionalTrimmed(
      item.label,
      `${where}.label`,
      MAX_PROPOSER_LABEL_CHARS,
      'invalid_discovery_input',
      where,
    );
    if (id === null && label === null) {
      throw inputError(`${where} must carry an id or a label — a candidate path must be traceable`);
    }
    return { kind, id, label };
  });
}

function validateBudget(
  value: unknown,
  where: string,
): { amount: number; currency: string } {
  if (!isPlainObject(value)) throw policyError(`${where} must be an object`);
  rejectUnknownKeys(value, BUDGET_KEYS, 'invalid_policy_input', where);
  const amount = value.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw policyError(`${where}.amount must be a finite number (got ${String(amount)})`);
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw policyError(
      `${where}.amount must be a non-negative integer number of minor units (got ${amount})`,
    );
  }
  if (amount > MAX_BUDGET_AMOUNT) {
    throw policyError(`${where}.amount must not exceed ${MAX_BUDGET_AMOUNT} minor units (got ${amount})`);
  }
  const currency = value.currency;
  if (typeof currency !== 'string') {
    throw policyError(`${where}.currency must be a string`);
  }
  const currencyText = currency.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(currencyText)) {
    throw policyError(
      `${where}.currency must be a 3-letter ISO 4217 currency code, e.g. 'EUR' (got '${currency}')`,
    );
  }
  return { amount, currency: currencyText };
}

// ---------------------------------------------------------------------------
// Discovery input
// ---------------------------------------------------------------------------

export interface ValidatedDiscoveryInput {
  goalId: string;
  metricName: string | null;
  missingKnowledge: string;
  impactDescription: string;
  decisionImpact: number;
  informationValue: number;
  urgency: GapUrgency;
  currentConfidence: number;
  requiredConfidence: number;
  evidenceObservationIds: string[];
  evidenceClaimIds: string[];
  acquisitionPaths: { kind: (typeof ACQUISITION_PATH_KINDS)[number]; id: string | null; label: string | null }[];
  proposer: GapProposer;
  executionId: string | null;
  proposerNote: string | null;
}

/** Validates `DiscoverGoalGapInput` (throws `invalid_discovery_input`). */
export function validateDiscoveryInput(input: DiscoverGoalGapInput): ValidatedDiscoveryInput {
  if (!isPlainObject(input)) {
    throw inputError('discovery input must be an object');
  }
  rejectUnknownKeys(input, DISCOVERY_INPUT_KEYS, 'invalid_discovery_input', 'the discovery input');

  const goalId = requireUuid(input.goalId, 'goalId', 'invalid_discovery_input');

  const metricName =
    input.metricName === undefined || input.metricName === null
      ? null
      : requireBoundedString(
          input.metricName,
          'metricName',
          MAX_METRIC_NAME_CHARS,
          'invalid_discovery_input',
          'the discovery input',
        );

  const missingKnowledge = requireBoundedString(
    input.missingKnowledge,
    'missingKnowledge',
    MAX_MISSING_KNOWLEDGE_CHARS,
    'invalid_discovery_input',
    'the discovery input',
  );
  const impactDescription = requireBoundedString(
    input.impactDescription,
    'impactDescription',
    MAX_IMPACT_DESCRIPTION_CHARS,
    'invalid_discovery_input',
    'the discovery input',
  );

  const decisionImpact = requireProbability(
    input.decisionImpact,
    'decisionImpact',
    'invalid_discovery_input',
  );
  const informationValue = requireProbability(
    input.informationValue,
    'informationValue',
    'invalid_discovery_input',
  );

  const urgency = input.urgency;
  if (!isGapUrgency(urgency)) {
    throw inputError(`urgency must be one of ${GAP_URGENCIES.join(', ')} (got '${String(urgency)}')`);
  }

  const currentConfidence = requireProbability(
    input.currentConfidence,
    'currentConfidence',
    'invalid_discovery_input',
  );
  const requiredConfidence = requireProbability(
    input.requiredConfidence,
    'requiredConfidence',
    'invalid_discovery_input',
  );
  // The gap rule: a gap without a confidence shortfall is not a gap — and a
  // materialized mission must satisfy targetConfidence > currentConfidence
  // by construction (the missions module enforces the same rule there).
  if (requiredConfidence <= currentConfidence) {
    throw inputError(
      `requiredConfidence must exceed currentConfidence — a gap without a confidence shortfall is not a gap (got current ${currentConfidence}, required ${requiredConfidence})`,
    );
  }

  const evidenceObservationIds = requireUuidList(
    input.evidenceObservationIds,
    'evidenceObservationIds',
    'invalid_discovery_input',
    MAX_EVIDENCE_OBSERVATIONS,
    1,
  );
  const evidenceClaimIds = requireUuidList(
    input.evidenceClaimIds ?? [],
    'evidenceClaimIds',
    'invalid_discovery_input',
    MAX_EVIDENCE_CLAIMS,
    0,
  );

  const acquisitionPaths = validateAcquisitionPaths(input.acquisitionPaths);
  const proposer = validateProposer(input.proposer, 'proposer');

  const executionId =
    input.executionId === undefined || input.executionId === null
      ? null
      : requireUuid(input.executionId, 'executionId', 'invalid_discovery_input');

  const proposerNote = optionalTrimmed(
    input.proposerNote,
    'proposerNote',
    MAX_PROPOSER_NOTE_CHARS,
    'invalid_discovery_input',
    'the discovery input',
  );

  return {
    goalId,
    metricName,
    missingKnowledge,
    impactDescription,
    decisionImpact,
    informationValue,
    urgency,
    currentConfidence,
    requiredConfidence,
    evidenceObservationIds,
    evidenceClaimIds,
    acquisitionPaths,
    proposer,
    executionId,
    proposerNote,
  };
}

// ---------------------------------------------------------------------------
// Policy input
// ---------------------------------------------------------------------------

export interface ValidatedPolicyInput {
  minDecisionImpact: number;
  minInformationValue: number;
  missionPolicy: MissionPolicyMode;
  investigationBudget: { amount: number; currency: string };
  rewardBudget: { amount: number; currency: string };
}

/** Validates `SetDiscoveryPolicyInput` (throws `invalid_policy_input`). */
export function validatePolicyInput(input: SetDiscoveryPolicyInput): ValidatedPolicyInput {
  if (!isPlainObject(input)) {
    throw policyError('policy input must be an object');
  }
  rejectUnknownKeys(input, POLICY_INPUT_KEYS, 'invalid_policy_input', 'the policy input');
  const minDecisionImpact = requireProbability(
    input.minDecisionImpact,
    'minDecisionImpact',
    'invalid_policy_input',
  );
  const minInformationValue = requireProbability(
    input.minInformationValue,
    'minInformationValue',
    'invalid_policy_input',
  );
  const missionPolicy = input.missionPolicy;
  if (!isMissionPolicyMode(missionPolicy)) {
    throw policyError(
      `missionPolicy must be one of ${MISSION_POLICY_MODES.join(', ')} (got '${String(missionPolicy)}')`,
    );
  }
  const investigationBudget = validateBudget(input.investigationBudget, 'investigationBudget');
  const rewardBudget = validateBudget(input.rewardBudget, 'rewardBudget');
  return {
    minDecisionImpact,
    minInformationValue,
    missionPolicy,
    investigationBudget,
    rewardBudget,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Validates `GetCandidateUnknownQuery` (throws `invalid_query`). */
export function validateGetQuery(input: GetCandidateUnknownQuery): { candidateId: string } {
  if (!isPlainObject(input)) throw queryError('get query must be an object');
  rejectUnknownKeys(input, GET_QUERY_KEYS, 'invalid_query', 'the get query');
  return { candidateId: requireUuid(input.candidateId, 'candidateId', 'invalid_query') };
}

/** Validates `MaterializeCandidateInput` (throws `invalid_query`). */
export function validateMaterializeInput(input: MaterializeCandidateInput): {
  candidateId: string;
} {
  if (!isPlainObject(input)) throw queryError('materialize input must be an object');
  rejectUnknownKeys(input, MATERIALIZE_INPUT_KEYS, 'invalid_query', 'the materialize input');
  return { candidateId: requireUuid(input.candidateId, 'candidateId', 'invalid_query') };
}

export interface ValidatedListQuery {
  status?: CandidateUnknownStatus;
  goalId?: string;
  urgency?: GapUrgency;
  proposerKind?: GapProposerKind;
  proposerId?: string;
  executionId?: string;
  search?: string;
  limit: number;
}

/** Validates `ListCandidateUnknownsQuery` (throws `invalid_query`). */
export function validateListQuery(input: ListCandidateUnknownsQuery): ValidatedListQuery {
  if (!isPlainObject(input)) throw queryError('list query must be an object');
  rejectUnknownKeys(input, LIST_QUERY_KEYS, 'invalid_query', 'the list query');
  const query: ValidatedListQuery = { limit: DEFAULT_LIST_LIMIT };

  if (input.status !== undefined) {
    if (!isCandidateUnknownStatus(input.status)) {
      throw queryError(
        `status must be one of ${CANDIDATE_UNKNOWN_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    query.status = input.status;
  }
  if (input.goalId !== undefined) {
    query.goalId = requireUuid(input.goalId, 'goalId', 'invalid_query');
  }
  if (input.urgency !== undefined) {
    if (!isGapUrgency(input.urgency)) {
      throw queryError(
        `urgency must be one of ${GAP_URGENCIES.join(', ')} (got '${String(input.urgency)}')`,
      );
    }
    query.urgency = input.urgency;
  }
  if (input.proposerKind !== undefined) {
    if (!isGapProposerKind(input.proposerKind)) {
      throw queryError(
        `proposerKind must be one of ${GAP_PROPOSER_KINDS.join(', ')} (got '${String(input.proposerKind)}')`,
      );
    }
    query.proposerKind = input.proposerKind;
    if (input.proposerId !== undefined) {
      query.proposerId = requireUuid(input.proposerId, 'proposerId', 'invalid_query');
    }
  } else if (input.proposerId !== undefined) {
    throw queryError('proposerId requires proposerKind (an id is meaningless without its kind)');
  }
  if (input.executionId !== undefined) {
    query.executionId = requireUuid(input.executionId, 'executionId', 'invalid_query');
  }
  if (input.search !== undefined && input.search !== null) {
    const search = requireBoundedString(
      input.search,
      'search',
      MAX_SEARCH_CHARS,
      'invalid_query',
      'the list query',
    );
    query.search = search;
  }
  if (input.limit !== undefined) {
    const limit = input.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit)) {
      throw queryError(`limit must be an integer (got ${String(limit)})`);
    }
    if (limit < 1 || limit > MAX_LIST_LIMIT) {
      throw queryError(`limit must be between 1 and ${MAX_LIST_LIMIT} (got ${limit})`);
    }
    query.limit = limit;
  }
  return query;
}
