// Pure validation/normalization logic of the agent-recruitment module
// (no database). Everything a caller may put into a recruitment
// proposal, an approval request, a settlement, a withdrawal or a query
// crosses these guards first; the SQL CHECK constraints and triggers in
// migrations/001 mirror the load-bearing rules as defense in depth (the
// actions/agents/capabilities discipline).
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `status`, `approval`, `createdBy`, `createdAt` or
// `withdrawnAt` into a proposal — a proposal's identity, tenancy,
// lifecycle state, gate snapshot and audit quartet are minted by the
// system (the submission is history the moment it is recorded; only the
// lifecycle state may move).
//
// The comparison rules W022 lives on, enforced here and pinned by tests:
//  * a proposal compares 2..6 alternatives with DISTINCT kinds (one per
//    acquisition channel — a comparison needs comparing, and the same
//    channel assessed twice is two arguments, not two alternatives);
//  * at most ONE alternative is `recommended`;
//  * `agentPermissions` (the agents module's closed scope vocabulary,
//    reused through its contract) may appear on 'recruit' alternatives
//    only;
//  * money follows the house convention: integer minor units paired
//    with an ISO 4217 code (defaulted to 'USD' when a cost is given
//    without one).

import type { AgentPermissionScope } from '@/modules/agents/contract';
import {
  AGENT_PERMISSION_SCOPES,
  isAgentPermissionScope,
} from '@/modules/agents/contract';
import type { TenantContext } from '@/infra/tenant';
import { AgentRecruitmentError } from './errors';
import {
  isRecruitmentAlternativeKind,
  isRecruitmentProposalStatus,
  RECRUITMENT_ALTERNATIVE_KINDS,
} from './comparison';
import type {
  CreateRecruitmentProposalInput,
  GetRecruitmentProposalQuery,
  ListRecruitmentProposalsQuery,
  RecruitmentAlternativeInput,
  RecruitmentAlternativeKind,
  RecruitmentProposalStatus,
  RequestRecruitmentApprovalInput,
  SettleRecruitmentProposalInput,
  WithdrawRecruitmentProposalInput,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (module-owned constants, re-exported through the contract)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_TITLE_CHARS = 200;
export const MAX_TEXT_CHARS = 2_000;
/** The actions module's justification bound — the gate records it verbatim. */
export const MAX_JUSTIFICATION_CHARS = 512;
export const MAX_REASON_CHARS = 512;
/** Evidence observation ids are opaque, but bounded (the capabilities precedent). */
export const MAX_EVIDENCE_REFS = 32;
export const MAX_REF_CHARS = 200;
/** A comparison compares the six channels at most once each — and at least two. */
export const MIN_ALTERNATIVES = 2;
export const MAX_ALTERNATIVES = 6;
/** Money ceiling in integer minor units (10^15 ≈ 10 major-unit quadrillions). */
export const MAX_COST_MINOR = 1_000_000_000_000_000;
/** Ten years of whole weeks — beyond that a "timeline" is fiction. */
export const MAX_WEEKS = 520;
/** The capabilities module's capacity bound, mirrored for contribution estimates. */
export const MAX_CAPACITY = 1_000_000_000;
export const MAX_PERMISSIONS = 6;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const CREATE_INPUT_KEYS = [
  'title',
  'capabilityId',
  'rationale',
  'evidenceObservationIds',
  'alternatives',
] as const;
const ALTERNATIVE_INPUT_KEYS = [
  'kind',
  'summary',
  'note',
  'estimatedCostMinor',
  'estimatedCostCurrency',
  'estimatedWeeks',
  'expectedLevel',
  'expectedCapacity',
  'recommended',
  'agentPermissions',
] as const;
const REQUEST_APPROVAL_INPUT_KEYS = ['proposalId', 'justification'] as const;
const SETTLE_INPUT_KEYS = ['proposalId'] as const;
const WITHDRAW_INPUT_KEYS = ['proposalId', 'reason'] as const;
const GET_QUERY_KEYS = ['proposalId'] as const;
const LIST_QUERY_KEYS = ['status', 'capabilityId', 'recommendedKind', 'limit'] as const;

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAgentRecruitmentTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new AgentRecruitmentError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AgentRecruitmentError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AgentRecruitmentError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority) || !ctx.authority.every((claim) => typeof claim === 'string')) {
    throw new AgentRecruitmentError(
      'invalid_context',
      'TenantContext.authority must be an array of claim strings',
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
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw inputError(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > maxChars) {
    throw inputError(`${field} must be at most ${maxChars} characters`);
  }
  return text === '' ? null : text;
}

function requireBoundedString(value: unknown, field: string, maxChars: number): string {
  const text = requireString(value, field);
  if (text.length > maxChars) {
    throw inputError(`${field} must be at most ${maxChars} characters (got ${text.length})`);
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

function requireLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_LIST_LIMIT : value;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw queryError(`query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }
  return limit;
}

function inputError(message: string): AgentRecruitmentError {
  return new AgentRecruitmentError('invalid_proposal_input', message);
}

function queryError(message: string): AgentRecruitmentError {
  return new AgentRecruitmentError('invalid_query', message);
}

/** The shared string guards throw input-flavored errors; a query deserves `invalid_query`. */
function wrapQueryError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AgentRecruitmentError && error.code === 'invalid_proposal_input') {
      throw new AgentRecruitmentError('invalid_query', error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Alternatives
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of one `RecruitmentAlternativeInput`. */
export interface ValidatedAlternative {
  kind: RecruitmentAlternativeKind;
  summary: string;
  note: string | null;
  estimatedCostMinor: number | null;
  estimatedCostCurrency: string | null;
  estimatedWeeks: number | null;
  expectedLevel: number | null;
  expectedCapacity: number | null;
  recommended: boolean;
  /** Present on 'recruit' alternatives only; canonically ordered, deduplicated. */
  agentPermissions: AgentPermissionScope[] | null;
}

function requireKind(value: unknown): RecruitmentAlternativeKind {
  if (!isRecruitmentAlternativeKind(value)) {
    throw inputError(
      `alternatives[].kind must be one of ${RECRUITMENT_ALTERNATIVE_KINDS.join(', ')} (got '${String(value)}')`,
    );
  }
  return value;
}

/** Boolean normalization: only a literal `true`/`false` (no truthy coercion). */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw inputError(`${field} must be a boolean (got '${String(value)}')`);
  }
  return value;
}

function optionalCostMinor(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COST_MINOR) {
    throw inputError(
      `alternatives[].estimatedCostMinor must be an integer in [0, ${MAX_COST_MINOR}] (got ${String(value)})`,
    );
  }
  return value;
}

function optionalCurrency(value: unknown, costPresent: boolean): string | null {
  if (value === undefined || value === null) {
    // A cost without a currency defaults to USD; a currency without a
    // cost is a modeling error (nothing to price).
    if (costPresent) return 'USD';
    return null;
  }
  if (!costPresent) {
    throw inputError(
      'alternatives[].estimatedCostCurrency requires estimatedCostMinor (a currency without a cost prices nothing)',
    );
  }
  const text = requireString(value, 'alternatives[].estimatedCostCurrency');
  if (!CURRENCY_PATTERN.test(text)) {
    throw inputError(
      `alternatives[].estimatedCostCurrency must be an ISO 4217 code matching ${CURRENCY_PATTERN.source} (got '${text}')`,
    );
  }
  return text;
}

function optionalWeeks(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_WEEKS) {
    throw inputError(
      `alternatives[].estimatedWeeks must be an integer in [1, ${MAX_WEEKS}] (got ${String(value)})`,
    );
  }
  return value;
}

function optionalLevel(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw inputError(
      `alternatives[].expectedLevel must be a number in [0, 1] (got ${String(value)})`,
    );
  }
  return value;
}

function optionalCapacity(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_CAPACITY
  ) {
    throw inputError(
      `alternatives[].expectedCapacity must be a number in [0, ${MAX_CAPACITY}] (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * Normalizes an agent-permission grant: must be a non-empty array from
 * the agents module's closed vocabulary; returned deduplicated and in
 * canonical §20 order, so equal grants always serialize identically
 * (determinism — the agents module's own `normalizeScopes` discipline,
 * reused through its contract).
 */
function normalizeAgentPermissions(
  value: unknown,
  field: string,
): AgentPermissionScope[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw inputError(`${field} must be an array of permission scopes`);
  }
  if (value.length === 0) {
    throw inputError(`${field} must contain at least one permission scope`);
  }
  if (value.length > MAX_PERMISSIONS) {
    throw inputError(`${field} must contain at most ${MAX_PERMISSIONS} permission scopes`);
  }
  const out: AgentPermissionScope[] = [];
  for (const entry of value) {
    if (!isAgentPermissionScope(entry)) {
      throw inputError(
        `${field} entries must be one of ${AGENT_PERMISSION_SCOPES.join(', ')} (got '${String(entry)}')`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  out.sort((a, b) => AGENT_PERMISSION_SCOPES.indexOf(a) - AGENT_PERMISSION_SCOPES.indexOf(b));
  return out;
}

function validateAlternative(
  value: RecruitmentAlternativeInput,
  index: number,
): ValidatedAlternative {
  const where = `alternatives[${index}]`;
  if (!isPlainObject(value)) {
    throw inputError(`${where} must be an object`);
  }
  rejectUnknownKeys(value, ALTERNATIVE_INPUT_KEYS, where);

  const kind = requireKind(value.kind);
  const summary = requireBoundedString(value.summary, `${where}.summary`, MAX_TEXT_CHARS);
  const note = optionalTrimmed(value.note, `${where}.note`, MAX_TEXT_CHARS);
  const estimatedCostMinor = optionalCostMinor(value.estimatedCostMinor);
  const estimatedCostCurrency = optionalCurrency(
    value.estimatedCostCurrency,
    estimatedCostMinor !== null,
  );
  const estimatedWeeks = optionalWeeks(value.estimatedWeeks);
  const expectedLevel = optionalLevel(value.expectedLevel);
  const expectedCapacity = optionalCapacity(value.expectedCapacity);
  const recommended =
    value.recommended === undefined ? false : requireBoolean(value.recommended, `${where}.recommended`);

  // The future agent's grant is visible only on the alternative that
  // would create an agent; every other channel prices a human, a
  // reallocation, software or a marketplace package.
  if (value.agentPermissions !== undefined && value.agentPermissions !== null && kind !== 'recruit') {
    throw inputError(
      `${where}.agentPermissions may only appear on 'recruit' alternatives (kind is '${kind}')`,
    );
  }
  const agentPermissions = normalizeAgentPermissions(value.agentPermissions, `${where}.agentPermissions`);

  return {
    kind,
    summary,
    note,
    estimatedCostMinor,
    estimatedCostCurrency,
    estimatedWeeks,
    expectedLevel,
    expectedCapacity,
    recommended,
    agentPermissions,
  };
}

// ---------------------------------------------------------------------------
// Proposal creation
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CreateRecruitmentProposalInput`. */
export interface ValidatedCreateInput {
  title: string;
  capabilityId: string;
  rationale: string;
  evidenceObservationIds: string[];
  alternatives: ValidatedAlternative[];
}

export function validateCreateRecruitmentProposalInput(
  input: CreateRecruitmentProposalInput,
): ValidatedCreateInput {
  if (!isPlainObject(input)) {
    throw inputError('proposal input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!(CREATE_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the proposal input (allowed: ${CREATE_INPUT_KEYS.join(', ')})`,
      );
    }
  }

  const title = requireBoundedString(input.title, 'title', MAX_TITLE_CHARS);
  const capabilityId = requireUuid(input.capabilityId, 'capabilityId');
  const rationale = requireBoundedString(input.rationale, 'rationale', MAX_TEXT_CHARS);

  // Evidence observation ids: opaque forward references to the
  // observations module (W004), bounded like the capabilities module
  // bounds its evidence lists.
  let evidenceObservationIds: string[] = [];
  if (input.evidenceObservationIds !== undefined && input.evidenceObservationIds !== null) {
    if (!Array.isArray(input.evidenceObservationIds)) {
      throw inputError('evidenceObservationIds must be an array of observation ids');
    }
    if (input.evidenceObservationIds.length > MAX_EVIDENCE_REFS) {
      throw inputError(
        `evidenceObservationIds must contain at most ${MAX_EVIDENCE_REFS} entries (got ${input.evidenceObservationIds.length})`,
      );
    }
    evidenceObservationIds = input.evidenceObservationIds.map((entry, index) =>
      requireBoundedString(entry, `evidenceObservationIds[${index}]`, MAX_REF_CHARS),
    );
  }

  if (!Array.isArray(input.alternatives)) {
    throw inputError('alternatives must be an array');
  }
  if (input.alternatives.length < MIN_ALTERNATIVES || input.alternatives.length > MAX_ALTERNATIVES) {
    throw inputError(
      `alternatives must contain between ${MIN_ALTERNATIVES} and ${MAX_ALTERNATIVES} entries — a recruitment proposal compares acquisition channels (got ${input.alternatives.length})`,
    );
  }
  const alternatives: ValidatedAlternative[] = input.alternatives.map((entry, index) =>
    validateAlternative(entry, index),
  );

  // Distinct kinds: each acquisition channel is assessed at most once —
  // the comparison is over channels, not over arguments.
  const kinds = new Set<string>();
  for (const alternative of alternatives) {
    if (kinds.has(alternative.kind)) {
      throw inputError(
        `alternatives compare kind '${alternative.kind}' twice — each acquisition channel appears at most once`,
      );
    }
    kinds.add(alternative.kind);
  }

  // At most one recommendation (zero is legal: "no clear winner yet").
  const recommendedCount = alternatives.filter((alternative) => alternative.recommended).length;
  if (recommendedCount > 1) {
    throw inputError(
      `at most one alternative may be recommended (got ${recommendedCount}) — an approver approves ONE course of action`,
    );
  }

  return { title, capabilityId, rationale, evidenceObservationIds, alternatives };
}

// ---------------------------------------------------------------------------
// Approval request, settlement, withdrawal
// ---------------------------------------------------------------------------

/** Fully validated form of `RequestRecruitmentApprovalInput`. */
export interface ValidatedRequestApprovalInput {
  proposalId: string;
  justification: string | null;
}

export function validateRequestRecruitmentApprovalInput(
  input: RequestRecruitmentApprovalInput,
): ValidatedRequestApprovalInput {
  if (!isPlainObject(input)) {
    throw inputError('approval request must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!(REQUEST_APPROVAL_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the approval request (allowed: ${REQUEST_APPROVAL_INPUT_KEYS.join(', ')})`,
      );
    }
  }
  const proposalId = requireUuid(input.proposalId, 'proposalId');
  const justification = optionalTrimmed(input.justification, 'justification', MAX_JUSTIFICATION_CHARS);
  return { proposalId, justification };
}

/** Fully validated form of `SettleRecruitmentProposalInput`. */
export interface ValidatedSettleInput {
  proposalId: string;
}

export function validateSettleRecruitmentProposalInput(
  input: SettleRecruitmentProposalInput,
): ValidatedSettleInput {
  if (!isPlainObject(input)) throw queryError('settle input must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(input, SETTLE_INPUT_KEYS, 'the settle input');
    return { proposalId: requireUuid(input.proposalId, 'settle input .proposalId') };
  });
}

/** Fully validated form of `WithdrawRecruitmentProposalInput`. */
export interface ValidatedWithdrawInput {
  proposalId: string;
  reason: string;
}

export function validateWithdrawRecruitmentProposalInput(
  input: WithdrawRecruitmentProposalInput,
): ValidatedWithdrawInput {
  if (!isPlainObject(input)) {
    throw inputError('withdrawal must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!(WITHDRAW_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the withdrawal (allowed: ${WITHDRAW_INPUT_KEYS.join(', ')})`,
      );
    }
  }
  const proposalId = requireUuid(input.proposalId, 'proposalId');
  const reason = requireBoundedString(input.reason, 'reason', MAX_REASON_CHARS);
  return { proposalId, reason };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated form of `GetRecruitmentProposalQuery`. */
export interface ValidatedGetQuery {
  proposalId: string;
}

export function validateGetRecruitmentProposalQuery(
  query: GetRecruitmentProposalQuery,
): ValidatedGetQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, GET_QUERY_KEYS, 'the query');
    return { proposalId: requireUuid(query.proposalId, 'query.proposalId') };
  });
}

/** Fully validated form of `ListRecruitmentProposalsQuery`. */
export interface ValidatedListQuery {
  status: RecruitmentProposalStatus | null;
  capabilityId: string | null;
  recommendedKind: RecruitmentAlternativeKind | null;
  limit: number;
}

export function validateListRecruitmentProposalsQuery(
  query: ListRecruitmentProposalsQuery,
): ValidatedListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_QUERY_KEYS, 'the query');
    let status: RecruitmentProposalStatus | null = null;
    if (query.status !== undefined && query.status !== null) {
      if (!isRecruitmentProposalStatus(query.status)) {
        throw queryError(
          `query.status must be one of proposed, awaiting_approval, approved, rejected, withdrawn (got '${String(query.status)}')`,
        );
      }
      status = query.status;
    }
    let capabilityId: string | null = null;
    if (query.capabilityId !== undefined && query.capabilityId !== null) {
      capabilityId = requireUuid(query.capabilityId, 'query.capabilityId');
    }
    let recommendedKind: RecruitmentAlternativeKind | null = null;
    if (query.recommendedKind !== undefined && query.recommendedKind !== null) {
      if (!isRecruitmentAlternativeKind(query.recommendedKind)) {
        throw queryError(
          `query.recommendedKind must be one of ${RECRUITMENT_ALTERNATIVE_KINDS.join(', ')} (got '${String(query.recommendedKind)}')`,
        );
      }
      recommendedKind = query.recommendedKind;
    }
    return { status, capabilityId, recommendedKind, limit: requireLimit(query.limit) };
  });
}
