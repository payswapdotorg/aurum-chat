// Pure validation/normalization logic of the agent-evaluation module
// (no database). Everything a caller may put into an evaluation or a
// lifecycle decision crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `status`, `policy`, `recordedAt`, `appliedAt` or
// principal fields into an input — an evaluation's identity, tenancy,
// computed measurements and audit fields are minted by the system
// (evaluations and decisions are evidence; audit fields are not
// caller-forgeable).
//
// The measurements themselves are NEVER inputs: `recordAgentEvaluation`
// accepts only the agent id and the replacement options — outcome,
// cost, quality, utilization and security are computed from contract
// state by measurement.ts, which is the whole point of "measure ...;
// lifecycle changes follow policy" (a caller cannot hand-craft the
// evidence a termination decision will cite).

import type { TenantContext } from '@/infra/tenant';
import { AgentEvaluationError } from './errors';
import {
  AGENT_DECISION_STATUSES,
  AGENT_LIFECYCLE_CHANGES,
  AGENT_REPLACEMENT_KINDS,
  isAgentDecisionStatus,
  isAgentLifecycleChange,
  isAgentReplacementKind,
} from './policy';
import type {
  AgentDecisionStatusWord,
  AgentLifecycleChangeWord,
  AgentReplacementKindWord,
} from './policy';
import type {
  DecideAgentLifecycleInput,
  GetAgentEvaluationQuery,
  GetAgentLifecycleDecisionQuery,
  ListAgentEvaluationsQuery,
  ListAgentLifecycleDecisionsQuery,
  RecordAgentEvaluationInput,
  SettleAgentLifecycleDecisionInput,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (module-owned constants, re-exported through the contract)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
/** An evaluation compares 1..9 replacement options (distinct kinds). */
export const MAX_REPLACEMENT_OPTIONS = 9;
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_NOTE_CHARS = 2000;
export const MAX_RATIONALE_CHARS = 2000;
export const MAX_MODIFICATION_SUMMARY_CHARS = 2000;
export const MAX_WEEKS = 520; // ten years
export const MAX_COST_MINOR = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const RECORD_EVALUATION_KEYS = ['agentId', 'replacementOptions'] as const;
const OPTION_KEYS = [
  'kind',
  'summary',
  'note',
  'estimatedCostMinor',
  'estimatedCostCurrency',
  'estimatedWeeks',
  'recommended',
] as const;
const DECIDE_KEYS = [
  'evaluationId',
  'change',
  'rationale',
  'note',
  'modificationSummary',
  'replacementOptionId',
] as const;
const SETTLE_KEYS = ['decisionId'] as const;
const GET_EVALUATION_KEYS = ['evaluationId'] as const;
const LIST_EVALUATIONS_KEYS = ['agentId', 'limit'] as const;
const GET_DECISION_KEYS = ['decisionId'] as const;
const LIST_DECISIONS_KEYS = ['agentId', 'change', 'status', 'limit'] as const;

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Validated shapes (the service consumes these)
// ---------------------------------------------------------------------------

export interface ValidatedOption {
  kind: AgentReplacementKindWord;
  summary: string;
  note: string | null;
  estimatedCostMinor: number | null;
  estimatedCostCurrency: string | null;
  estimatedWeeks: number | null;
  recommended: boolean;
}

export interface ValidatedRecordEvaluationInput {
  agentId: string;
  replacementOptions: ValidatedOption[];
}

export interface ValidatedDecideInput {
  evaluationId: string;
  change: AgentLifecycleChangeWord;
  rationale: string;
  note: string | null;
  modificationSummary: string | null;
  replacementOptionId: string | null;
}

export interface ValidatedSettleInput {
  decisionId: string;
}

export interface ValidatedGetEvaluationQuery {
  evaluationId: string;
}

export interface ValidatedListEvaluationsQuery {
  agentId: string | null;
  limit: number;
}

export interface ValidatedGetDecisionQuery {
  decisionId: string;
}

export interface ValidatedListDecisionsQuery {
  agentId: string | null;
  change: AgentLifecycleChangeWord | null;
  status: AgentDecisionStatusWord | null;
  limit: number;
}

// ---------------------------------------------------------------------------
// Primitives
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
      throw new AgentEvaluationError(
        'invalid_evaluation_input',
        `${where}: unknown key '${key}' (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  error: (message: string) => AgentEvaluationError,
): string {
  if (typeof value !== 'string') {
    throw error(`${field} must be a string`);
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  error: (message: string) => AgentEvaluationError,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw error(`${field} must be a string or null`);
  if (value.length > maxLength) {
    throw error(`${field} must be at most ${maxLength} characters`);
  }
  return value;
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAgentEvaluationTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new AgentEvaluationError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AgentEvaluationError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AgentEvaluationError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority) || !ctx.authority.every((claim) => typeof claim === 'string')) {
    throw new AgentEvaluationError(
      'invalid_context',
      'TenantContext.authority must be an array of claim strings',
    );
  }
}

// ---------------------------------------------------------------------------
// recordAgentEvaluation
// ---------------------------------------------------------------------------

export function validateRecordAgentEvaluationInput(
  input: RecordAgentEvaluationInput,
): ValidatedRecordEvaluationInput {
  const error = (message: string): AgentEvaluationError =>
    new AgentEvaluationError('invalid_evaluation_input', message);
  if (!isPlainObject(input)) throw error('the evaluation input must be an object');
  rejectUnknownKeys(input, RECORD_EVALUATION_KEYS, 'recordAgentEvaluation');

  const agentId = requireString(input.agentId, 'agentId', error);
  if (!isUuid(agentId)) {
    // Malformed ids are uniformly not-found (the house discipline).
    throw new AgentEvaluationError(
      'agent_not_found',
      `no agent '${agentId}' exists in this tenant`,
    );
  }

  if (!Array.isArray(input.replacementOptions)) {
    throw error('replacementOptions must be an array (1..9 options, distinct kinds)');
  }
  if (input.replacementOptions.length < 1 || input.replacementOptions.length > MAX_REPLACEMENT_OPTIONS) {
    throw error(
      `replacementOptions must contain 1..${MAX_REPLACEMENT_OPTIONS} options (an evaluation always measures its replacement options)`,
    );
  }

  const kinds = new Set<string>();
  let recommendedSeen = false;
  const options: ValidatedOption[] = input.replacementOptions.map((raw, index) => {
    const where = `replacementOptions[${index}]`;
    if (!isPlainObject(raw)) throw error(`${where} must be an object`);
    rejectUnknownKeys(raw, OPTION_KEYS, where);

    const kind = raw.kind;
    if (!isAgentReplacementKind(kind)) {
      throw error(
        `${where}.kind must be one of: ${AGENT_REPLACEMENT_KINDS.join(', ')}`,
      );
    }
    if (kinds.has(kind)) {
      throw error(`${where}.kind '${kind}' appears twice — option kinds must be distinct`);
    }
    kinds.add(kind);

    const summary = requireString(raw.summary, `${where}.summary`, error).trim();
    if (summary.length < 1 || summary.length > MAX_SUMMARY_CHARS) {
      throw error(`${where}.summary must be 1..${MAX_SUMMARY_CHARS} characters`);
    }
    const note = optionalString(raw.note, `${where}.note`, MAX_NOTE_CHARS, error);

    let estimatedCostMinor: number | null = null;
    if (raw.estimatedCostMinor !== undefined && raw.estimatedCostMinor !== null) {
      if (
        typeof raw.estimatedCostMinor !== 'number' ||
        !Number.isSafeInteger(raw.estimatedCostMinor) ||
        raw.estimatedCostMinor < 0 ||
        raw.estimatedCostMinor > MAX_COST_MINOR
      ) {
        throw error(
          `${where}.estimatedCostMinor must be a non-negative safe integer (integer minor units)`,
        );
      }
      estimatedCostMinor = raw.estimatedCostMinor;
    }

    let estimatedCostCurrency: string | null = null;
    if (raw.estimatedCostCurrency !== undefined && raw.estimatedCostCurrency !== null) {
      if (
        typeof raw.estimatedCostCurrency !== 'string' ||
        !CURRENCY_PATTERN.test(raw.estimatedCostCurrency)
      ) {
        throw error(`${where}.estimatedCostCurrency must be an ISO 4217 code (e.g. 'USD')`);
      }
      estimatedCostCurrency = raw.estimatedCostCurrency;
    }

    let estimatedWeeks: number | null = null;
    if (raw.estimatedWeeks !== undefined && raw.estimatedWeeks !== null) {
      if (
        typeof raw.estimatedWeeks !== 'number' ||
        !Number.isFinite(raw.estimatedWeeks) ||
        raw.estimatedWeeks <= 0 ||
        raw.estimatedWeeks > MAX_WEEKS
      ) {
        throw error(`${where}.estimatedWeeks must be a positive number ≤ ${MAX_WEEKS}`);
      }
      estimatedWeeks = raw.estimatedWeeks;
    }

    let recommended = false;
    if (raw.recommended !== undefined && raw.recommended !== null) {
      if (typeof raw.recommended !== 'boolean') {
        throw error(`${where}.recommended must be a boolean`);
      }
      recommended = raw.recommended;
      if (recommended) {
        if (recommendedSeen) {
          throw error('at most one replacement option may be recommended');
        }
        recommendedSeen = true;
      }
    }

    return {
      kind,
      summary,
      note,
      estimatedCostMinor,
      estimatedCostCurrency,
      estimatedWeeks,
      recommended,
    };
  });

  return { agentId, replacementOptions: options };
}

// ---------------------------------------------------------------------------
// decideAgentLifecycle
// ---------------------------------------------------------------------------

export function validateDecideAgentLifecycleInput(
  input: DecideAgentLifecycleInput,
): ValidatedDecideInput {
  const error = (message: string): AgentEvaluationError =>
    new AgentEvaluationError('invalid_decision_input', message);
  if (!isPlainObject(input)) throw error('the decision input must be an object');
  rejectUnknownKeys(input, DECIDE_KEYS, 'decideAgentLifecycle');

  const evaluationId = requireString(input.evaluationId, 'evaluationId', error);
  if (!isUuid(evaluationId)) {
    throw new AgentEvaluationError(
      'evaluation_not_found',
      `no agent evaluation '${evaluationId}' exists in this tenant`,
    );
  }

  const change = input.change;
  if (!isAgentLifecycleChange(change)) {
    throw error(`change must be one of: ${AGENT_LIFECYCLE_CHANGES.join(', ')}`);
  }

  const rationale = requireString(input.rationale, 'rationale', error).trim();
  if (rationale.length < 1 || rationale.length > MAX_RATIONALE_CHARS) {
    throw error(`rationale must be 1..${MAX_RATIONALE_CHARS} characters`);
  }
  const note = optionalString(input.note, 'note', MAX_NOTE_CHARS, error);

  let modificationSummary: string | null = null;
  if (input.modificationSummary !== undefined && input.modificationSummary !== null) {
    modificationSummary = optionalString(
      input.modificationSummary,
      'modificationSummary',
      MAX_MODIFICATION_SUMMARY_CHARS,
      error,
    );
  }
  if (change === 'modify' && (modificationSummary === null || modificationSummary.trim() === '')) {
    throw error('modificationSummary is required for modify decisions (what will be changed)');
  }
  if (change !== 'modify' && modificationSummary !== null) {
    throw error('modificationSummary is only meaningful for modify decisions');
  }

  let replacementOptionId: string | null = null;
  if (input.replacementOptionId !== undefined && input.replacementOptionId !== null) {
    const value = requireString(input.replacementOptionId, 'replacementOptionId', error);
    if (!isUuid(value)) {
      throw error('replacementOptionId must be a uuid (a replacement option of the linked evaluation)');
    }
    replacementOptionId = value.toLowerCase();
  }
  if (change !== 'terminate' && replacementOptionId !== null) {
    throw error('replacementOptionId is only meaningful for terminate decisions');
  }

  return { evaluationId, change, rationale, note, modificationSummary, replacementOptionId };
}

// ---------------------------------------------------------------------------
// settleAgentLifecycleDecision
// ---------------------------------------------------------------------------

export function validateSettleAgentLifecycleDecisionInput(
  input: SettleAgentLifecycleDecisionInput,
): ValidatedSettleInput {
  const error = (message: string): AgentEvaluationError =>
    new AgentEvaluationError('invalid_decision_input', message);
  if (!isPlainObject(input)) throw error('the settle input must be an object');
  rejectUnknownKeys(input, SETTLE_KEYS, 'settleAgentLifecycleDecision');
  const decisionId = requireString(input.decisionId, 'decisionId', error);
  if (!isUuid(decisionId)) {
    throw new AgentEvaluationError(
      'decision_not_found',
      `no agent lifecycle decision '${decisionId}' exists in this tenant`,
    );
  }
  return { decisionId };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function validateLimit(
  value: unknown,
  error: (message: string) => AgentEvaluationError,
): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw error('limit must be an integer');
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw error(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function validateOptionalAgentId(
  value: unknown,
  error: (message: string) => AgentEvaluationError,
): string | null {
  if (value === undefined || value === null) return null;
  const agentId = requireString(value, 'agentId', error);
  if (!isUuid(agentId)) {
    // A filtered listing over a malformed id is uniformly empty.
    return '00000000-0000-0000-0000-000000000000';
  }
  return agentId.toLowerCase();
}

export function validateGetAgentEvaluationQuery(
  query: GetAgentEvaluationQuery,
): ValidatedGetEvaluationQuery {
  const error = (message: string): AgentEvaluationError =>
    new AgentEvaluationError('invalid_query', message);
  if (!isPlainObject(query)) throw error('the query must be an object');
  rejectUnknownKeys(query, GET_EVALUATION_KEYS, 'getAgentEvaluation');
  const evaluationId = requireString(query.evaluationId, 'evaluationId', error);
  if (!isUuid(evaluationId)) {
    throw new AgentEvaluationError(
      'evaluation_not_found',
      `no agent evaluation '${evaluationId}' exists in this tenant`,
    );
  }
  return { evaluationId: evaluationId.toLowerCase() };
}

export function validateListAgentEvaluationsQuery(
  query: ListAgentEvaluationsQuery,
): ValidatedListEvaluationsQuery {
  const error = (message: string): AgentEvaluationError =>
    new AgentEvaluationError('invalid_query', message);
  if (!isPlainObject(query)) throw error('the query must be an object');
  rejectUnknownKeys(query, LIST_EVALUATIONS_KEYS, 'listAgentEvaluations');
  return {
    agentId: validateOptionalAgentId(query.agentId, error),
    limit: validateLimit(query.limit, error),
  };
}

export function validateGetAgentLifecycleDecisionQuery(
  query: GetAgentLifecycleDecisionQuery,
): ValidatedGetDecisionQuery {
  const error = (message: string): AgentEvaluationError =>
    new AgentEvaluationError('invalid_query', message);
  if (!isPlainObject(query)) throw error('the query must be an object');
  rejectUnknownKeys(query, GET_DECISION_KEYS, 'getAgentLifecycleDecision');
  const decisionId = requireString(query.decisionId, 'decisionId', error);
  if (!isUuid(decisionId)) {
    throw new AgentEvaluationError(
      'decision_not_found',
      `no agent lifecycle decision '${decisionId}' exists in this tenant`,
    );
  }
  return { decisionId: decisionId.toLowerCase() };
}

export function validateListAgentLifecycleDecisionsQuery(
  query: ListAgentLifecycleDecisionsQuery,
): ValidatedListDecisionsQuery {
  const error = (message: string): AgentEvaluationError =>
    new AgentEvaluationError('invalid_query', message);
  if (!isPlainObject(query)) throw error('the query must be an object');
  rejectUnknownKeys(query, LIST_DECISIONS_KEYS, 'listAgentLifecycleDecisions');
  const change =
    query.change === undefined || query.change === null
      ? null
      : isAgentLifecycleChange(query.change)
        ? query.change
        : (() => {
            throw error(`change must be one of: ${AGENT_LIFECYCLE_CHANGES.join(', ')}`);
          })();
  const status =
    query.status === undefined || query.status === null
      ? null
      : isAgentDecisionStatus(query.status)
        ? query.status
        : (() => {
            throw error(`status must be one of: ${AGENT_DECISION_STATUSES.join(', ')}`);
          })();
  return {
    agentId: validateOptionalAgentId(query.agentId, error),
    change,
    status,
    limit: validateLimit(query.limit, error),
  };
}
