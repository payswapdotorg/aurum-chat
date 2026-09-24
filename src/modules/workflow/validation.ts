// Pure input validation for the workflow module's public operations
// (W080) — the house discipline: every service entrypoint validates its
// input through one of these before touching the database, and the
// contract surface mirrors the limits as exported constants.
//
// Size/shape caps follow the module vocabulary: idempotency keys reuse
// the agents module's shared cap (W021/W034 vocabulary — imported
// through the agents CONTRACT, not forked); JSON payloads cap at
// MAX_PAYLOAD_BYTES; step/definition keys are slug-shaped.

import { MAX_IDEMPOTENCY_KEY_LENGTH } from '@/modules/agents/contract';
import { WorkflowError } from './errors';
import { parseCron } from './cron';
import type {
  CancelRunInput,
  CreateScheduleInput,
  DispatchWorkflowEventInput,
  GetRunQuery,
  GetWorkflowDefinitionQuery,
  GetWorkflowEventQuery,
  ListRunStepAttemptsQuery,
  ListRunStepsQuery,
  ListRunsQuery,
  ListSchedulesQuery,
  ListWorkflowDefinitionsQuery,
  RegisterWorkflowInput,
  ResumeRunInput,
  SetScheduleActiveInput,
  StartRunInput,
  WorkflowStepSpec,
} from './types';
import {
  isRunStatus,
  isTriggerKind,
  runStatusAfterCancelRequest,
} from './machine';

// ---------------------------------------------------------------------------
// Exported limits
// ---------------------------------------------------------------------------

/** Shared with the W021/W034 vocabulary (agents contract). */
export const MAX_IDEM_KEY_LENGTH = MAX_IDEMPOTENCY_KEY_LENGTH;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_STEPS = 50;
export const MAX_EVENT_TRIGGERS = 20;
export const MAX_DEFINITION_KEY_LENGTH = 128;
export const MAX_STEP_KEY_LENGTH = 64;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_REASON_LENGTH = 2000;
export const MAX_EVENT_TYPE_LENGTH = 128;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_MAX_ATTEMPTS = 20;
export const DEFAULT_RETRY_BACKOFF_SECONDS = 30;
export const MAX_RETRY_BACKOFF_SECONDS = 86_400;
export const DEFAULT_LEASE_SECONDS = 3600;
export const MIN_LEASE_SECONDS = 5;
export const MAX_LEASE_SECONDS = 2_592_000; // 30 days — checkpointed long-running cognition
export const MAX_SCHEDULE_OCCURRENCES_PER_SWEEP = 100;

const DEFINITION_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const STEP_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,62}[A-Za-z0-9])?$/;
const EVENT_TYPE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireString(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowError('invalid_query', `${field} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new WorkflowError('invalid_query', `${field} must be at most ${max} characters (got ${value.length})`);
  }
  return value;
}

function optionalText(field: string, value: unknown, max: number, code: WorkflowError['code']): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowError(code, `${field} must be a non-empty string when present`);
  }
  if (value.length > max) {
    throw new WorkflowError(code, `${field} must be at most ${max} characters (got ${value.length})`);
  }
  return value;
}

/** JSON-serialize and size-cap a payload; returns the value to persist. */
function checkPayload(field: string, value: unknown, code: WorkflowError['code']): unknown {
  if (value === undefined || value === null) return {};
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new WorkflowError(code, `${field} must be JSON-serializable`);
  }
  if (serialized === undefined) {
    throw new WorkflowError(code, `${field} must be JSON-serializable`);
  }
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    throw new WorkflowError(code, `${field} exceeds the payload cap (${MAX_PAYLOAD_BYTES} bytes)`);
  }
  return value;
}

function optionalIdempotencyKey(value: unknown, code: WorkflowError['code']): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowError(code, 'idempotencyKey must be a non-empty string when present');
  }
  if (value.length > MAX_IDEM_KEY_LENGTH) {
    throw new WorkflowError(
      code,
      `idempotencyKey must be at most ${MAX_IDEM_KEY_LENGTH} characters (got ${value.length})`,
    );
  }
  return value;
}

function listLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new WorkflowError('invalid_query', `limit must be an integer in 1..${MAX_LIST_LIMIT}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

export interface AssertedTenantContext {
  tenantId: string;
  principalId: string;
  authority: string[];
}

export function assertWorkflowTenantContext(ctx: {
  tenantId: unknown;
  principalId: unknown;
  authority: unknown;
}): AssertedTenantContext {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '' || ctx.tenantId.length > 128) {
    throw new WorkflowError('invalid_context', 'tenantId must be a non-empty string (≤128 chars)');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '' || ctx.principalId.length > 128) {
    throw new WorkflowError('invalid_context', 'principalId must be a non-empty string (≤128 chars)');
  }
  if (!Array.isArray(ctx.authority) || ctx.authority.some((claim) => typeof claim !== 'string')) {
    throw new WorkflowError('invalid_context', 'authority must be an array of claim strings');
  }
  return { tenantId: ctx.tenantId, principalId: ctx.principalId, authority: ctx.authority as string[] };
}

// ---------------------------------------------------------------------------
// Definition registration
// ---------------------------------------------------------------------------

export interface ValidatedStepSpec {
  key: string;
  title: string | null;
  maxAttempts: number;
  retryBackoffSeconds: number;
  leaseSeconds: number;
}

export interface ValidatedWorkflowSpec {
  steps: ValidatedStepSpec[];
  eventTriggers: string[];
}

export interface ValidatedRegisterInput {
  key: string;
  title: string;
  description: string | null;
  spec: ValidatedWorkflowSpec;
}

function validateStepSpec(index: number, raw: unknown): ValidatedStepSpec {
  if (typeof raw !== 'object' || raw === null) {
    throw new WorkflowError('invalid_definition_input', `steps[${index}] must be an object`);
  }
  const candidate = raw as Partial<WorkflowStepSpec>;
  const key = candidate.key;
  if (typeof key !== 'string' || !STEP_KEY_PATTERN.test(key)) {
    throw new WorkflowError(
      'invalid_definition_input',
      `steps[${index}].key must match ${STEP_KEY_PATTERN.source} (got '${String(key)}')`,
    );
  }
  const maxAttempts = candidate.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_MAX_ATTEMPTS
  ) {
    throw new WorkflowError(
      'invalid_definition_input',
      `steps[${index}].maxAttempts must be an integer in 1..${MAX_MAX_ATTEMPTS}`,
    );
  }
  const retryBackoffSeconds = candidate.retryBackoffSeconds ?? DEFAULT_RETRY_BACKOFF_SECONDS;
  if (
    typeof retryBackoffSeconds !== 'number' ||
    !Number.isInteger(retryBackoffSeconds) ||
    retryBackoffSeconds < 0 ||
    retryBackoffSeconds > MAX_RETRY_BACKOFF_SECONDS
  ) {
    throw new WorkflowError(
      'invalid_definition_input',
      `steps[${index}].retryBackoffSeconds must be an integer in 0..${MAX_RETRY_BACKOFF_SECONDS}`,
    );
  }
  const leaseSeconds = candidate.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (
    typeof leaseSeconds !== 'number' ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < MIN_LEASE_SECONDS ||
    leaseSeconds > MAX_LEASE_SECONDS
  ) {
    throw new WorkflowError(
      'invalid_definition_input',
      `steps[${index}].leaseSeconds must be an integer in ${MIN_LEASE_SECONDS}..${MAX_LEASE_SECONDS}`,
    );
  }
  const title = candidate.title === undefined || candidate.title === null
    ? null
    : requireString(`steps[${index}].title`, candidate.title, MAX_TITLE_LENGTH);
  return { key, title, maxAttempts, retryBackoffSeconds, leaseSeconds };
}

export function validateRegisterWorkflowInput(input: RegisterWorkflowInput): ValidatedRegisterInput {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowError('invalid_definition_input', 'input must be an object');
  }
  const candidate = input as Partial<RegisterWorkflowInput>;
  const key = candidate.key;
  if (typeof key !== 'string' || !DEFINITION_KEY_PATTERN.test(key)) {
    throw new WorkflowError(
      'invalid_definition_input',
      `key must match ${DEFINITION_KEY_PATTERN.source} (got '${String(key)}')`,
    );
  }
  const title = requireString('title', candidate.title, MAX_TITLE_LENGTH);
  const description = optionalText('description', candidate.description, MAX_DESCRIPTION_LENGTH, 'invalid_definition_input');
  if (typeof candidate.spec !== 'object' || candidate.spec === null) {
    throw new WorkflowError('invalid_definition_input', 'spec must be an object');
  }
  const specCandidate = candidate.spec as { steps?: unknown; eventTriggers?: unknown };
  if (!Array.isArray(specCandidate.steps) || specCandidate.steps.length < 1) {
    throw new WorkflowError('invalid_definition_input', 'spec.steps must be a non-empty array');
  }
  if (specCandidate.steps.length > MAX_STEPS) {
    throw new WorkflowError('invalid_definition_input', `spec.steps must hold at most ${MAX_STEPS} steps`);
  }
  const steps = specCandidate.steps.map((step, index) => validateStepSpec(index, step));
  const stepKeys = new Set<string>();
  for (const step of steps) {
    if (stepKeys.has(step.key)) {
      throw new WorkflowError('invalid_definition_input', `duplicate step key '${step.key}'`);
    }
    stepKeys.add(step.key);
  }
  let eventTriggers: string[] = [];
  if (specCandidate.eventTriggers !== undefined && specCandidate.eventTriggers !== null) {
    if (!Array.isArray(specCandidate.eventTriggers)) {
      throw new WorkflowError('invalid_definition_input', 'spec.eventTriggers must be an array of event types');
    }
    if (specCandidate.eventTriggers.length > MAX_EVENT_TRIGGERS) {
      throw new WorkflowError('invalid_definition_input', `spec.eventTriggers must hold at most ${MAX_EVENT_TRIGGERS} entries`);
    }
    for (const entry of specCandidate.eventTriggers) {
      if (typeof entry !== 'string' || !EVENT_TYPE_PATTERN.test(entry)) {
        throw new WorkflowError(
          'invalid_definition_input',
          `spec.eventTriggers entries must match ${EVENT_TYPE_PATTERN.source} (got '${String(entry)}')`,
        );
      }
    }
    eventTriggers = [...new Set(specCandidate.eventTriggers as string[])];
  }
  return { key, title, description, spec: { steps, eventTriggers } };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface ValidatedStartRunInput {
  definitionKey: string;
  input: unknown;
  idempotencyKey: string | null;
  triggerReference: string | null;
}

export function validateStartRunInput(input: StartRunInput): ValidatedStartRunInput {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowError('invalid_run_input', 'input must be an object');
  }
  const candidate = input as Partial<StartRunInput>;
  const definitionKey = candidate.definitionKey;
  if (typeof definitionKey !== 'string' || !DEFINITION_KEY_PATTERN.test(definitionKey)) {
    throw new WorkflowError(
      'invalid_run_input',
      `definitionKey must match ${DEFINITION_KEY_PATTERN.source} (got '${String(definitionKey)}')`,
    );
  }
  const payload = checkPayload('input', candidate.input, 'invalid_run_input');
  const idempotencyKey = optionalIdempotencyKey(candidate.idempotencyKey, 'invalid_run_input');
  const triggerReference = optionalText(
    'triggerReference',
    candidate.triggerReference,
    MAX_NOTE_LENGTH,
    'invalid_run_input',
  );
  return { definitionKey, input: payload, idempotencyKey, triggerReference };
}

export interface ValidatedCancelInput {
  runId: string;
  reason: string;
}

export function validateCancelRunInput(input: CancelRunInput): ValidatedCancelInput {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowError('invalid_cancel_input', 'input must be an object');
  }
  const candidate = input as Partial<CancelRunInput>;
  if (!isUuid(candidate.runId)) {
    throw new WorkflowError('invalid_cancel_input', 'runId must be a uuid');
  }
  const reason = requireString('reason', candidate.reason, MAX_REASON_LENGTH);
  return { runId: candidate.runId, reason };
}

export interface ValidatedResumeInput {
  runId: string;
  payload: unknown;
  note: string | null;
}

export function validateResumeRunInput(input: ResumeRunInput): ValidatedResumeInput {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowError('invalid_resume_input', 'input must be an object');
  }
  const candidate = input as Partial<ResumeRunInput>;
  if (!isUuid(candidate.runId)) {
    throw new WorkflowError('invalid_resume_input', 'runId must be a uuid');
  }
  const payload = checkPayload('payload', candidate.payload, 'invalid_resume_input');
  const note = optionalText('note', candidate.note, MAX_NOTE_LENGTH, 'invalid_resume_input');
  return { runId: candidate.runId, payload, note };
}

/** The cancel transition implied by the CURRENT status (pure pre-check). */
export function cancelTransitionFor(status: string): 'cancelled' | 'cancelling' | null {
  if (!isRunStatus(status)) return null;
  const next = runStatusAfterCancelRequest(status);
  return next === 'cancelled' || next === 'cancelling' ? next : null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ValidatedDispatchEventInput {
  eventType: string;
  payload: unknown;
  idempotencyKey: string | null;
  domainEventId: string | null;
}

export function validateDispatchEventInput(input: DispatchWorkflowEventInput): ValidatedDispatchEventInput {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowError('invalid_event_input', 'input must be an object');
  }
  const candidate = input as Partial<DispatchWorkflowEventInput>;
  const eventType = candidate.eventType;
  if (typeof eventType !== 'string' || !EVENT_TYPE_PATTERN.test(eventType)) {
    throw new WorkflowError(
      'invalid_event_input',
      `eventType must match ${EVENT_TYPE_PATTERN.source} (got '${String(eventType)}')`,
    );
  }
  const payload = checkPayload('payload', candidate.payload, 'invalid_event_input');
  const idempotencyKey = optionalIdempotencyKey(candidate.idempotencyKey, 'invalid_event_input');
  const domainEventId = candidate.domainEventId ?? null;
  if (domainEventId !== null && !isUuid(domainEventId)) {
    throw new WorkflowError('invalid_event_input', 'domainEventId must be a uuid when present');
  }
  return { eventType, payload, idempotencyKey, domainEventId };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export interface ValidatedCreateScheduleInput {
  definitionKey: string;
  cron: string;
  input: unknown;
  active: boolean;
}

export function validateCreateScheduleInput(input: CreateScheduleInput): ValidatedCreateScheduleInput {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowError('invalid_schedule_input', 'input must be an object');
  }
  const candidate = input as Partial<CreateScheduleInput>;
  const definitionKey = candidate.definitionKey;
  if (typeof definitionKey !== 'string' || !DEFINITION_KEY_PATTERN.test(definitionKey)) {
    throw new WorkflowError(
      'invalid_schedule_input',
      `definitionKey must match ${DEFINITION_KEY_PATTERN.source} (got '${String(definitionKey)}')`,
    );
  }
  const cron = candidate.cron;
  if (typeof cron !== 'string') {
    throw new WorkflowError('invalid_schedule_input', 'cron must be a string');
  }
  try {
    parseCron(cron);
  } catch (error) {
    throw new WorkflowError(
      'invalid_schedule_input',
      `cron is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  const payload = checkPayload('input', candidate.input, 'invalid_schedule_input');
  const active = candidate.active ?? true;
  if (typeof active !== 'boolean') {
    throw new WorkflowError('invalid_schedule_input', 'active must be a boolean when present');
  }
  return { definitionKey, cron: cron.trim(), input: payload, active };
}

export interface ValidatedSetScheduleActiveInput {
  scheduleId: string;
  active: boolean;
}

export function validateSetScheduleActiveInput(input: SetScheduleActiveInput): ValidatedSetScheduleActiveInput {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowError('invalid_schedule_input', 'input must be an object');
  }
  const candidate = input as Partial<SetScheduleActiveInput>;
  if (!isUuid(candidate.scheduleId)) {
    throw new WorkflowError('invalid_schedule_input', 'scheduleId must be a uuid');
  }
  if (typeof candidate.active !== 'boolean') {
    throw new WorkflowError('invalid_schedule_input', 'active must be a boolean');
  }
  return { scheduleId: candidate.scheduleId, active: candidate.active };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ValidatedDefinitionQuery {
  key: string;
}

export function validateDefinitionQuery(query: GetWorkflowDefinitionQuery): ValidatedDefinitionQuery {
  const key = (query as Partial<GetWorkflowDefinitionQuery>).key;
  if (typeof key !== 'string' || !DEFINITION_KEY_PATTERN.test(key)) {
    throw new WorkflowError('invalid_query', `key must match ${DEFINITION_KEY_PATTERN.source}`);
  }
  return { key };
}

export interface ValidatedListDefinitionsQuery {
  status: 'active' | 'retired' | null;
  limit: number;
}

export function validateListDefinitionsQuery(query: ListWorkflowDefinitionsQuery): ValidatedListDefinitionsQuery {
  if (typeof query !== 'object' || query === null) {
    throw new WorkflowError('invalid_query', 'query must be an object');
  }
  const candidate = query as Partial<ListWorkflowDefinitionsQuery>;
  let status: 'active' | 'retired' | null = null;
  if (candidate.status !== undefined && candidate.status !== null) {
    if (candidate.status !== 'active' && candidate.status !== 'retired') {
      throw new WorkflowError('invalid_query', "status must be 'active' or 'retired'");
    }
    status = candidate.status;
  }
  return { status, limit: listLimit(candidate.limit) };
}

export interface ValidatedRunQuery {
  runId: string;
}

export function validateRunQuery(query: GetRunQuery): ValidatedRunQuery {
  const runId = (query as Partial<GetRunQuery>).runId;
  if (!isUuid(runId)) {
    throw new WorkflowError('invalid_query', 'runId must be a uuid');
  }
  return { runId };
}

export interface ValidatedListRunsQuery {
  definitionKey: string | null;
  status: string | null;
  trigger: string | null;
  limit: number;
}

export function validateListRunsQuery(query: ListRunsQuery): ValidatedListRunsQuery {
  if (typeof query !== 'object' || query === null) {
    throw new WorkflowError('invalid_query', 'query must be an object');
  }
  const candidate = query as Partial<ListRunsQuery>;
  let definitionKey: string | null = null;
  if (candidate.definitionKey !== undefined && candidate.definitionKey !== null) {
    if (typeof candidate.definitionKey !== 'string' || !DEFINITION_KEY_PATTERN.test(candidate.definitionKey)) {
      throw new WorkflowError('invalid_query', `definitionKey must match ${DEFINITION_KEY_PATTERN.source}`);
    }
    definitionKey = candidate.definitionKey;
  }
  let status: string | null = null;
  if (candidate.status !== undefined && candidate.status !== null) {
    if (!isRunStatus(candidate.status)) {
      throw new WorkflowError('invalid_query', `status must be one of the run statuses`);
    }
    status = candidate.status;
  }
  let trigger: string | null = null;
  if (candidate.trigger !== undefined && candidate.trigger !== null) {
    if (!isTriggerKind(candidate.trigger)) {
      throw new WorkflowError('invalid_query', `trigger must be one of the trigger kinds`);
    }
    trigger = candidate.trigger;
  }
  return { definitionKey, status, trigger, limit: listLimit(candidate.limit) };
}

export interface ValidatedRunStepsQuery {
  runId: string;
}

export function validateRunStepsQuery(query: ListRunStepsQuery): ValidatedRunStepsQuery {
  const runId = (query as Partial<ListRunStepsQuery>).runId;
  if (!isUuid(runId)) {
    throw new WorkflowError('invalid_query', 'runId must be a uuid');
  }
  return { runId };
}

export interface ValidatedRunStepAttemptsQuery {
  runId: string;
  stepNumber: number | null;
}

export function validateRunStepAttemptsQuery(query: ListRunStepAttemptsQuery): ValidatedRunStepAttemptsQuery {
  if (typeof query !== 'object' || query === null) {
    throw new WorkflowError('invalid_query', 'query must be an object');
  }
  const candidate = query as Partial<ListRunStepAttemptsQuery>;
  if (!isUuid(candidate.runId)) {
    throw new WorkflowError('invalid_query', 'runId must be a uuid');
  }
  let stepNumber: number | null = null;
  if (candidate.stepNumber !== undefined && candidate.stepNumber !== null) {
    if (typeof candidate.stepNumber !== 'number' || !Number.isInteger(candidate.stepNumber) || candidate.stepNumber < 1) {
      throw new WorkflowError('invalid_query', 'stepNumber must be a positive integer when present');
    }
    stepNumber = candidate.stepNumber;
  }
  return { runId: candidate.runId, stepNumber };
}

export interface ValidatedListSchedulesQuery {
  activeOnly: boolean;
  limit: number;
}

export function validateListSchedulesQuery(query: ListSchedulesQuery): ValidatedListSchedulesQuery {
  if (typeof query !== 'object' || query === null) {
    throw new WorkflowError('invalid_query', 'query must be an object');
  }
  const candidate = query as Partial<ListSchedulesQuery>;
  const activeOnly = candidate.activeOnly ?? false;
  if (typeof activeOnly !== 'boolean') {
    throw new WorkflowError('invalid_query', 'activeOnly must be a boolean when present');
  }
  return { activeOnly, limit: listLimit(candidate.limit) };
}

export interface ValidatedEventQuery {
  eventId: string;
}

export function validateEventQuery(query: GetWorkflowEventQuery): ValidatedEventQuery {
  const eventId = (query as Partial<GetWorkflowEventQuery>).eventId;
  if (!isUuid(eventId)) {
    throw new WorkflowError('invalid_query', 'eventId must be a uuid');
  }
  return { eventId };
}
