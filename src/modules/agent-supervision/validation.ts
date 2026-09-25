// Pure validation/normalization logic of the agent-supervision module
// (no database). Everything a caller may put into a supervision
// registration, control update, budget grant, suspension, review,
// admission, session or query crosses these guards first; the SQL
// CHECK constraints and triggers in migrations/001–005 mirror the
// load-bearing rules as defense in depth (the agents/actions
// discipline).
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `status`, `healthState`, `budgetSpentMinor`,
// `reviewCount`, `createdBy` or timestamps into a record — identity,
// tenancy, lifecycle state and accounting are minted by the system.
// Omitted optional fields are normalized to null so the service layer
// applies one uniform "unset means unchanged / default" discipline.

import type { TenantContext } from '@/infra/tenant';
import { AGENT_PERMISSION_SCOPES, isAgentPermissionScope } from '@/modules/agents/contract';
import type { AgentPermissionScope } from '@/modules/agents/contract';
import { AgentSupervisionError } from './errors';
import {
  isSupervisionHealthState,
  isSupervisionReviewOutcome,
  isSupervisionStatus,
} from './policy';
import type {
  AgentSupervisionEventKind,
  BeginSupervisorSessionInput,
  CompleteSupervisionReviewInput,
  EndSupervisorSessionInput,
  GetSupervisionQuery,
  GetSupervisionReviewQuery,
  GetSupervisorSessionQuery,
  GrantSupervisionBudgetInput,
  HeartbeatSupervisorSessionInput,
  ListSupervisionBudgetEntriesQuery,
  ListSupervisionEventsQuery,
  ListSupervisionReviewsQuery,
  ListSupervisionsQuery,
  ListSupervisorSessionsQuery,
  RegisterSupervisedAgentInput,
  ResumeSupervisionInput,
  SubmitSupervisedExecutionInput,
  SupervisionPumpInput,
  SupervisionReviewAdjustments,
  SuspendSupervisionInput,
  UpdateSupervisionInput,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (module-owned constants, re-exported through the contract)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
/** Review cadence: 1 minute .. 365 days; default 30 days. */
export const MIN_REVIEW_INTERVAL_SECONDS = 60;
export const MAX_REVIEW_INTERVAL_SECONDS = 31_536_000;
export const DEFAULT_REVIEW_INTERVAL_SECONDS = 2_592_000;
/** Health observation cadence: 1 minute .. 30 days; default 1 hour. */
export const MIN_HEALTH_INTERVAL_SECONDS = 60;
export const MAX_HEALTH_INTERVAL_SECONDS = 2_592_000;
export const DEFAULT_HEALTH_INTERVAL_SECONDS = 3_600;
/** Supervisor lease: 30 seconds .. 1 day; default 5 minutes. */
export const MIN_LEASE_SECONDS = 30;
export const MAX_LEASE_SECONDS = 86_400;
export const DEFAULT_LEASE_SECONDS = 300;
/** Budget arithmetic stays inside the JS safe-integer range. */
export const MAX_MINOR_UNITS = Number.MAX_SAFE_INTEGER;
export const MAX_RATIONALE_CHARS = 2_000;
export const MAX_REASON_CHARS = 512;
export const MAX_NOTE_CHARS = 512;
export const MAX_OWNER_PRINCIPAL_CHARS = 255;
export const MAX_PERMISSIONS = 6;
/** The budget-consumption scan bound: executions examined per pump call. */
export const BUDGET_SCAN_EXECUTION_LIMIT = 50;
/** The evidence bound for health observation and enforcement scans. */
export const EVIDENCE_SCAN_LIMIT = 500;

// The supervision event vocabulary (mirrored by migrations/002 CHECK).
export const SUPERVISION_EVENT_KINDS = [
  'registered',
  'registration_replayed',
  'updated',
  'review_due',
  'review_completed',
  'budget_granted',
  'budget_consumed',
  'budget_exhausted',
  'budget_resumed',
  'suspended',
  'resumed',
  'health_observed',
  'termination_proposed',
  'termination_applied',
  'termination_refused',
  'live_work_cancelled',
  'session_started',
  'session_heartbeat',
  'session_ended',
  'session_recovered',
] as const;

export function isSupervisionEventKind(value: unknown): value is AgentSupervisionEventKind {
  return (
    typeof value === 'string' &&
    (SUPERVISION_EVENT_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Context and primitive guards
// ---------------------------------------------------------------------------

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertSupervisionTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new AgentSupervisionError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AgentSupervisionError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AgentSupervisionError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority) || !ctx.authority.every((claim) => typeof claim === 'string')) {
    throw new AgentSupervisionError(
      'invalid_context',
      'TenantContext.authority must be an array of claim strings',
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function requireUuid(
  value: unknown,
  field: string,
): string {
  if (!isUuid(value)) {
    throw new AgentSupervisionError(
      'invalid_input',
      `${field} must be a uuid (got ${typeof value})`,
    );
  }
  return value;
}

function optionalUuid(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, field);
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new AgentSupervisionError(
        'invalid_input',
        `unknown field '${key}' — the accepted fields are: ${allowed.join(', ')}`,
      );
    }
  }
}

function boundedText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new AgentSupervisionError(
      'invalid_input',
      `${field} must be a string of ${min}..${max} characters`,
    );
  }
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, field, min, max);
}

/** Normalizes a permission-scope list: 1..6 closed-vocabulary, deduplicated, canonically ordered. */
function normalizeScopes(
  value: unknown,
  field: string,
): AgentPermissionScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PERMISSIONS) {
    throw new AgentSupervisionError(
      'invalid_input',
      `${field} must be an array of 1..${MAX_PERMISSIONS} permission scopes`,
    );
  }
  const canonical: AgentPermissionScope[] = [];
  for (const scope of value) {
    if (!isAgentPermissionScope(scope)) {
      throw new AgentSupervisionError(
        'invalid_input',
        `${field} contains '${String(scope)}' — the closed vocabulary is ${AGENT_PERMISSION_SCOPES.join(', ')}`,
      );
    }
    if (!canonical.includes(scope)) canonical.push(scope);
  }
  canonical.sort((a, b) => AGENT_PERMISSION_SCOPES.indexOf(a) - AGENT_PERMISSION_SCOPES.indexOf(b));
  return canonical;
}

function optionalScopes(
  value: unknown,
  field: string,
): AgentPermissionScope[] | null {
  if (value === undefined || value === null) return null;
  return normalizeScopes(value, field);
}

function optionalInterval(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new AgentSupervisionError(
      'invalid_input',
      `${field} must be an integer of ${min}..${max} seconds`,
    );
  }
  return value;
}

function optionalMinorUnits(
  value: unknown,
  field: string,
  allowZero: boolean,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > MAX_MINOR_UNITS
  ) {
    throw new AgentSupervisionError(
      'invalid_input',
      `${field} must be an integer of ${allowZero ? 0 : 1}..${MAX_MINOR_UNITS} minor units`,
    );
  }
  return value;
}

function listLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new AgentSupervisionError(
      'invalid_query',
      `limit must be an integer of 1..${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Registration and control updates
// ---------------------------------------------------------------------------

export interface ValidatedRegisterInput {
  agentId: string;
  ownerPrincipal: string | null;
  reviewIntervalSeconds: number;
  healthIntervalSeconds: number;
  budgetMinor: number | null;
  permittedScopes: AgentPermissionScope[] | null;
}

export function validateRegisterSupervisedAgentInput(
  input: RegisterSupervisedAgentInput,
): ValidatedRegisterInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the registration input must be an object');
  }
  rejectUnknownKeys(input, [
    'agentId',
    'ownerPrincipal',
    'reviewIntervalSeconds',
    'healthIntervalSeconds',
    'budgetMinor',
    'permittedScopes',
  ]);
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    ownerPrincipal: optionalText(input.ownerPrincipal, 'ownerPrincipal', 1, MAX_OWNER_PRINCIPAL_CHARS),
    reviewIntervalSeconds:
      optionalInterval(
        input.reviewIntervalSeconds,
        'reviewIntervalSeconds',
        MIN_REVIEW_INTERVAL_SECONDS,
        MAX_REVIEW_INTERVAL_SECONDS,
      ) ?? DEFAULT_REVIEW_INTERVAL_SECONDS,
    healthIntervalSeconds:
      optionalInterval(
        input.healthIntervalSeconds,
        'healthIntervalSeconds',
        MIN_HEALTH_INTERVAL_SECONDS,
        MAX_HEALTH_INTERVAL_SECONDS,
      ) ?? DEFAULT_HEALTH_INTERVAL_SECONDS,
    budgetMinor: optionalMinorUnits(input.budgetMinor, 'budgetMinor', true),
    permittedScopes: optionalScopes(input.permittedScopes, 'permittedScopes'),
  };
}

export interface ValidatedUpdateInput {
  agentId: string;
  ownerPrincipal: string | null;
  reviewIntervalSeconds: number | null;
  healthIntervalSeconds: number | null;
  permittedScopes: AgentPermissionScope[] | null;
}

export function validateUpdateSupervisionInput(
  input: UpdateSupervisionInput,
): ValidatedUpdateInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the update input must be an object');
  }
  rejectUnknownKeys(input, [
    'agentId',
    'ownerPrincipal',
    'reviewIntervalSeconds',
    'healthIntervalSeconds',
    'permittedScopes',
  ]);
  if (Object.keys(input).length === 1) {
    throw new AgentSupervisionError(
      'invalid_input',
      'the update input carries no changes — supply at least one control field',
    );
  }
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    ownerPrincipal: optionalText(input.ownerPrincipal, 'ownerPrincipal', 1, MAX_OWNER_PRINCIPAL_CHARS),
    reviewIntervalSeconds: optionalInterval(
      input.reviewIntervalSeconds,
      'reviewIntervalSeconds',
      MIN_REVIEW_INTERVAL_SECONDS,
      MAX_REVIEW_INTERVAL_SECONDS,
    ),
    healthIntervalSeconds: optionalInterval(
      input.healthIntervalSeconds,
      'healthIntervalSeconds',
      MIN_HEALTH_INTERVAL_SECONDS,
      MAX_HEALTH_INTERVAL_SECONDS,
    ),
    permittedScopes: optionalScopes(input.permittedScopes, 'permittedScopes'),
  };
}

export interface ValidatedGrantInput {
  agentId: string;
  additionalMinor: number;
  note: string | null;
}

export function validateGrantSupervisionBudgetInput(
  input: GrantSupervisionBudgetInput,
): ValidatedGrantInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the grant input must be an object');
  }
  rejectUnknownKeys(input, ['agentId', 'additionalMinor', 'note']);
  if (input.additionalMinor === undefined || input.additionalMinor === null) {
    throw new AgentSupervisionError('invalid_input', 'additionalMinor is required');
  }
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    additionalMinor: optionalMinorUnits(input.additionalMinor, 'additionalMinor', false)!,
    note: optionalText(input.note, 'note', 1, MAX_NOTE_CHARS),
  };
}

export interface ValidatedSuspendInput {
  agentId: string;
  reason: string;
}

export function validateSuspendSupervisionInput(
  input: SuspendSupervisionInput,
): ValidatedSuspendInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the suspension input must be an object');
  }
  rejectUnknownKeys(input, ['agentId', 'reason']);
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    reason: boundedText(input.reason, 'reason', 1, MAX_REASON_CHARS),
  };
}

export interface ValidatedResumeInput {
  agentId: string;
  note: string | null;
}

export function validateResumeSupervisionInput(
  input: ResumeSupervisionInput,
): ValidatedResumeInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the resume input must be an object');
  }
  rejectUnknownKeys(input, ['agentId', 'note']);
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    note: optionalText(input.note, 'note', 1, MAX_NOTE_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Supervision-gated admission
// ---------------------------------------------------------------------------

export interface ValidatedSubmitInput {
  agentId: string;
  task: unknown;
  requestedPermissions: AgentPermissionScope[];
  maxAttempts: number | null;
  correlationId: string | null;
  idempotencyKey: string | null;
}

export function validateSubmitSupervisedExecutionInput(
  input: SubmitSupervisedExecutionInput,
): ValidatedSubmitInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the submission input must be an object');
  }
  rejectUnknownKeys(input, [
    'agentId',
    'task',
    'requestedPermissions',
    'maxAttempts',
    'correlationId',
    'idempotencyKey',
  ]);
  if (input.task === undefined || input.task === null) {
    throw new AgentSupervisionError('invalid_input', 'task must be a non-null plain JSON value');
  }
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    task: input.task,
    requestedPermissions: normalizeScopes(input.requestedPermissions, 'requestedPermissions'),
    maxAttempts:
      input.maxAttempts === undefined || input.maxAttempts === null
        ? null
        : input.maxAttempts,
    correlationId: optionalText(input.correlationId, 'correlationId', 1, 128),
    idempotencyKey: optionalText(input.idempotencyKey, 'idempotencyKey', 1, 200),
  };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function validateAdjustments(
  value: unknown,
): SupervisionReviewAdjustments | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new AgentSupervisionError(
      'invalid_input',
      'adjustments must be an object of supervision control changes',
    );
  }
  rejectUnknownKeys(value, [
    'ownerPrincipal',
    'reviewIntervalSeconds',
    'healthIntervalSeconds',
    'permittedScopes',
    'budgetAdditionalMinor',
  ]);
  const adjustments: SupervisionReviewAdjustments = {};
  if (value.ownerPrincipal !== undefined && value.ownerPrincipal !== null) {
    adjustments.ownerPrincipal = boundedText(
      value.ownerPrincipal,
      'adjustments.ownerPrincipal',
      1,
      MAX_OWNER_PRINCIPAL_CHARS,
    );
  }
  if (value.reviewIntervalSeconds !== undefined && value.reviewIntervalSeconds !== null) {
    const interval = optionalInterval(
      value.reviewIntervalSeconds,
      'adjustments.reviewIntervalSeconds',
      MIN_REVIEW_INTERVAL_SECONDS,
      MAX_REVIEW_INTERVAL_SECONDS,
    );
    if (interval !== null) adjustments.reviewIntervalSeconds = interval;
  }
  if (value.healthIntervalSeconds !== undefined && value.healthIntervalSeconds !== null) {
    const interval = optionalInterval(
      value.healthIntervalSeconds,
      'adjustments.healthIntervalSeconds',
      MIN_HEALTH_INTERVAL_SECONDS,
      MAX_HEALTH_INTERVAL_SECONDS,
    );
    if (interval !== null) adjustments.healthIntervalSeconds = interval;
  }
  if (value.permittedScopes !== undefined && value.permittedScopes !== null) {
    adjustments.permittedScopes = normalizeScopes(
      value.permittedScopes,
      'adjustments.permittedScopes',
    );
  }
  if (value.budgetAdditionalMinor !== undefined && value.budgetAdditionalMinor !== null) {
    const minor = optionalMinorUnits(
      value.budgetAdditionalMinor,
      'adjustments.budgetAdditionalMinor',
      false,
    );
    if (minor !== null) adjustments.budgetAdditionalMinor = minor;
  }
  return adjustments;
}

export interface ValidatedReviewInput {
  agentId: string;
  outcome: 'continue' | 'adjust' | 'suspend' | 'terminate_proposal';
  rationale: string;
  evaluationId: string | null;
  decisionId: string | null;
  adjustments: SupervisionReviewAdjustments | null;
}

export function validateCompleteSupervisionReviewInput(
  input: CompleteSupervisionReviewInput,
): ValidatedReviewInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the review input must be an object');
  }
  rejectUnknownKeys(input, [
    'agentId',
    'outcome',
    'rationale',
    'evaluationId',
    'decisionId',
    'adjustments',
  ]);
  if (!isSupervisionReviewOutcome(input.outcome)) {
    throw new AgentSupervisionError(
      'invalid_input',
      `outcome '${String(input.outcome)}' is not one of: continue, adjust, suspend, terminate_proposal`,
    );
  }
  const adjustments = validateAdjustments(input.adjustments);
  if (input.outcome === 'adjust' && adjustments === null) {
    throw new AgentSupervisionError(
      'invalid_input',
      "an outcome of 'adjust' requires adjustments — supply at least one control change",
    );
  }
  if (input.outcome !== 'adjust' && adjustments !== null) {
    throw new AgentSupervisionError(
      'invalid_input',
      `adjustments are only accepted on outcome 'adjust' (not '${input.outcome}')`,
    );
  }
  if (input.outcome === 'terminate_proposal') {
    if (typeof input.decisionId !== 'string' || !isUuid(input.decisionId)) {
      throw new AgentSupervisionError(
        'invalid_input',
        "outcome 'terminate_proposal' requires decisionId — the cited agent-evaluation lifecycle decision",
      );
    }
  }
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    outcome: input.outcome,
    rationale: boundedText(input.rationale, 'rationale', 1, MAX_RATIONALE_CHARS),
    evaluationId: optionalUuid(input.evaluationId, 'evaluationId'),
    decisionId: optionalUuid(input.decisionId, 'decisionId'),
    adjustments,
  };
}

// ---------------------------------------------------------------------------
// Sessions and the pump
// ---------------------------------------------------------------------------

export interface ValidatedBeginSessionInput {
  leaseSeconds: number;
}

export function validateBeginSupervisorSessionInput(
  input: BeginSupervisorSessionInput,
): ValidatedBeginSessionInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the session input must be an object');
  }
  rejectUnknownKeys(input, ['leaseSeconds']);
  return {
    leaseSeconds:
      optionalInterval(input.leaseSeconds, 'leaseSeconds', MIN_LEASE_SECONDS, MAX_LEASE_SECONDS) ??
      DEFAULT_LEASE_SECONDS,
  };
}

export interface ValidatedHeartbeatInput {
  sessionId: string;
}

export function validateHeartbeatSupervisorSessionInput(
  input: HeartbeatSupervisorSessionInput,
): ValidatedHeartbeatInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the heartbeat input must be an object');
  }
  rejectUnknownKeys(input, ['sessionId']);
  return { sessionId: requireUuid(input.sessionId, 'sessionId') };
}

export interface ValidatedEndSessionInput {
  sessionId: string;
  reason: string | null;
}

export function validateEndSupervisorSessionInput(
  input: EndSupervisorSessionInput,
): ValidatedEndSessionInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the end-session input must be an object');
  }
  rejectUnknownKeys(input, ['sessionId', 'reason']);
  return {
    sessionId: requireUuid(input.sessionId, 'sessionId'),
    reason: optionalText(input.reason, 'reason', 1, MAX_REASON_CHARS),
  };
}

export interface ValidatedPumpInput {
  agentId: string;
  sessionId: string | null;
}

export function validateSupervisionPumpInput(input: SupervisionPumpInput): ValidatedPumpInput {
  if (!isPlainObject(input)) {
    throw new AgentSupervisionError('invalid_input', 'the pump input must be an object');
  }
  rejectUnknownKeys(input, ['agentId', 'sessionId']);
  return {
    agentId: requireUuid(input.agentId, 'agentId'),
    sessionId: optionalUuid(input.sessionId, 'sessionId'),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ValidatedGetQuery {
  agentId: string;
}

export function validateGetSupervisionQuery(query: GetSupervisionQuery): ValidatedGetQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the supervision query must be an object');
  }
  rejectUnknownKeys(query, ['agentId']);
  return { agentId: requireUuid(query.agentId, 'agentId') };
}

export interface ValidatedListQuery {
  status: string | null;
  healthState: string | null;
  limit: number;
}

export function validateListSupervisionsQuery(query: ListSupervisionsQuery): ValidatedListQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the supervision list query must be an object');
  }
  rejectUnknownKeys(query, ['status', 'healthState', 'limit']);
  if (query.status !== undefined && query.status !== null && !isSupervisionStatus(query.status)) {
    throw new AgentSupervisionError(
      'invalid_query',
      `status '${String(query.status)}' is not a supervision status`,
    );
  }
  if (
    query.healthState !== undefined &&
    query.healthState !== null &&
    !isSupervisionHealthState(query.healthState)
  ) {
    throw new AgentSupervisionError(
      'invalid_query',
      `healthState '${String(query.healthState)}' is not a supervision health state`,
    );
  }
  return {
    status: query.status ?? null,
    healthState: query.healthState ?? null,
    limit: listLimit(query.limit),
  };
}

export interface ValidatedListEventsQuery {
  agentId: string | null;
  supervisionId: string | null;
  sessionId: string | null;
  kind: string | null;
  limit: number;
}

export function validateListSupervisionEventsQuery(
  query: ListSupervisionEventsQuery,
): ValidatedListEventsQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the event list query must be an object');
  }
  rejectUnknownKeys(query, ['agentId', 'supervisionId', 'sessionId', 'kind', 'limit']);
  if (query.kind !== undefined && query.kind !== null && !isSupervisionEventKind(query.kind)) {
    throw new AgentSupervisionError(
      'invalid_query',
      `kind '${String(query.kind)}' is not a supervision event kind`,
    );
  }
  return {
    agentId: optionalUuid(query.agentId, 'agentId'),
    supervisionId: optionalUuid(query.supervisionId, 'supervisionId'),
    sessionId: optionalUuid(query.sessionId, 'sessionId'),
    kind: query.kind ?? null,
    limit: listLimit(query.limit),
  };
}

export interface ValidatedListReviewsQuery {
  agentId: string | null;
  limit: number;
}

export function validateListSupervisionReviewsQuery(
  query: ListSupervisionReviewsQuery,
): ValidatedListReviewsQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the review list query must be an object');
  }
  rejectUnknownKeys(query, ['agentId', 'limit']);
  return {
    agentId: optionalUuid(query.agentId, 'agentId'),
    limit: listLimit(query.limit),
  };
}

export interface ValidatedGetReviewQuery {
  reviewId: string;
}

export function validateGetSupervisionReviewQuery(
  query: GetSupervisionReviewQuery,
): ValidatedGetReviewQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the review query must be an object');
  }
  rejectUnknownKeys(query, ['reviewId']);
  return { reviewId: requireUuid(query.reviewId, 'reviewId') };
}

export interface ValidatedListBudgetEntriesQuery {
  agentId: string | null;
  limit: number;
}

export function validateListSupervisionBudgetEntriesQuery(
  query: ListSupervisionBudgetEntriesQuery,
): ValidatedListBudgetEntriesQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the budget-entry list query must be an object');
  }
  rejectUnknownKeys(query, ['agentId', 'limit']);
  return {
    agentId: optionalUuid(query.agentId, 'agentId'),
    limit: listLimit(query.limit),
  };
}

export interface ValidatedGetSessionQuery {
  sessionId: string;
}

export function validateGetSupervisorSessionQuery(
  query: GetSupervisorSessionQuery,
): ValidatedGetSessionQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the session query must be an object');
  }
  rejectUnknownKeys(query, ['sessionId']);
  return { sessionId: requireUuid(query.sessionId, 'sessionId') };
}

export interface ValidatedListSessionsQuery {
  live: boolean | null;
  limit: number;
}

export function validateListSupervisorSessionsQuery(
  query: ListSupervisorSessionsQuery,
): ValidatedListSessionsQuery {
  if (!isPlainObject(query)) {
    throw new AgentSupervisionError('invalid_query', 'the session list query must be an object');
  }
  rejectUnknownKeys(query, ['live', 'limit']);
  let live: boolean | null = null;
  if (query.live !== undefined && query.live !== null) {
    if (typeof query.live !== 'boolean') {
      throw new AgentSupervisionError('invalid_query', 'live must be a boolean');
    }
    live = query.live;
  }
  return { live, limit: listLimit(query.limit) };
}

export { isUuid };
