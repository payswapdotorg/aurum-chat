// Pure validation/normalization logic of the computer-use module (no
// database, no clock, no network). Everything a caller may put into this
// module's operations crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller
// can never smuggle `id`, `tenantId`, timestamps, receipts or evidence
// links into records — identity, tenancy and the per-step outcome links
// are minted by the system from validated state.
//
// THE ALLOWLIST IS VALIDATED TWICE HERE: the allowlist itself must be a
// well-formed governed-automation surface (bounded glob set, verb
// subset), AND the whole plan must be allowlist-conformant at creation —
// a task whose steps could never dispatch is refused before it exists
// (governed automation starts at planning time, not at run time).

import type { TenantContext } from '@/infra/tenant';
import { ComputerUseError } from './errors';
import type {
  BrowserAllowlist,
  BrowserSessionStatus,
  BrowserStepState,
  BrowserTaskEventType,
  BrowserTaskStatus,
  BrowserVerb,
} from './types';
import { BROWSER_VERBS } from './types';
import { urlMatchesGlob } from './verify';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const BROWSER_TASK_STATUSES = [
  'draft',
  'suspended',
  'failed',
  'completed',
  'mismatched',
  'aborted',
] as const;

export const BROWSER_STEP_STATES = [
  'pending',
  'verified',
  'mismatched',
  'failed',
  'refused',
  'blocked',
] as const;

export const BROWSER_SESSION_STATUSES = [
  'running',
  'completed',
  'interrupted',
  'failed',
  'mismatched',
  'aborted',
] as const;

export const BROWSER_TASK_EVENT_TYPES = [
  'created',
  'started',
  'resumed',
  'step-executed',
  'step-verified',
  'step-failed',
  'step-blocked',
  'step-refused',
  'step-mismatch-detected',
  'suspended',
  'completed',
  'aborted',
  'mismatched',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
/** The step budget: a governed plan is bounded at creation. */
export const MAX_STEPS_PER_TASK = 32;
/**
 * The per-session hard guard (defense in depth): a session can never
 * perform more actions than this, whatever the plan's shape. The plan
 * itself is bounded by MAX_STEPS_PER_TASK and verified steps are never
 * re-executed, so a healthy run cannot reach the guard — it exists to
 * bound pathological loops loudly.
 */
export const MAX_SESSION_STEPS = 64;

export const MAX_STEP_KEY_LENGTH = 128;
export const MAX_URL_LENGTH = 2048;
export const MAX_SELECTOR_LENGTH = 512;
export const MAX_TYPED_VALUE_LENGTH = 2000;
export const MAX_SECRET_FIELD_LENGTH = 128;
export const MAX_URL_GLOBS = 32;
export const MAX_URL_GLOB_LENGTH = 512;
export const MIN_TASK_DESCRIPTION_LENGTH = 1;
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
export const MAX_REQUESTED_FOR_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 512;
export const MAX_RECEIPT_ID_LENGTH = 200;
export const MAX_RECEIPT_DETAIL_LENGTH = 500;
export const MAX_SCREENSHOT_REF_LENGTH = 512;
/** Canonical payload/expectation/trace size cap (256 KiB — modest jsonb). */
export const MAX_VALUE_BYTES = 262_144;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEP_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/;
const SECRET_FIELD_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isBrowserTaskStatus(value: unknown): value is BrowserTaskStatus {
  return (
    typeof value === 'string' && (BROWSER_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function isBrowserStepState(value: unknown): value is BrowserStepState {
  return (
    typeof value === 'string' && (BROWSER_STEP_STATES as readonly string[]).includes(value)
  );
}

export function isBrowserSessionStatus(value: unknown): value is BrowserSessionStatus {
  return (
    typeof value === 'string' && (BROWSER_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isBrowserTaskEventType(value: unknown): value is BrowserTaskEventType {
  return (
    typeof value === 'string' && (BROWSER_TASK_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isBrowserVerb(value: unknown): value is BrowserVerb {
  return typeof value === 'string' && (BROWSER_VERBS as readonly string[]).includes(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertComputerUseTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ComputerUseError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ComputerUseError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ComputerUseError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

// ---------------------------------------------------------------------------
// Primitive helpers (house pattern)
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
      throw new ComputerUseError(
        'invalid_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new ComputerUseError('invalid_input', `'${field}' must be a uuid`);
  }
  return value;
}

function optionalIdempotencyKey(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must match ${IDEMPOTENCY_KEY_PATTERN.source}`,
    );
  }
  return value;
}

function optionalLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ComputerUseError('invalid_input', `'${field}' must be an integer`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must be between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

/**
 * A bounded plain JSON value: JSON-serializable, non-null, and within the
 * module's canonical value cap (expectations and observed states stay
 * modest; screenshots and large artifacts belong in object storage behind
 * opaque references — the W004 discipline).
 */
function requireBoundedJsonValue(value: unknown, field: string): unknown {
  if (value === undefined || value === null) {
    throw new ComputerUseError('invalid_input', `'${field}' must be a non-null JSON value`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must be JSON-serializable (a provider object, class instance or cycle cannot cross the boundary)`,
    );
  }
  if (serialized === undefined) {
    throw new ComputerUseError('invalid_input', `'${field}' must be JSON-serializable`);
  }
  if (serialized.length > MAX_VALUE_BYTES) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' exceeds the maximum of ${MAX_VALUE_BYTES} bytes (${serialized.length}); large artifacts belong in object storage behind opaque references`,
    );
  }
  return value;
}

function requirePlainJsonObject(value: unknown, field: string): Record<string, unknown> {
  const bounded = requireBoundedJsonValue(value, field);
  if (!isPlainObject(bounded)) {
    throw new ComputerUseError('invalid_input', `'${field}' must be a plain JSON object`);
  }
  return bounded;
}

// ---------------------------------------------------------------------------
// Task contexts (mirrors the W083/W084 shape — the frozen what-and-why)
// ---------------------------------------------------------------------------

const TASK_CONTEXT_KEYS = ['description', 'requestedFor'] as const;

export interface ValidatedTaskContext {
  description: string;
  requestedFor: string | null;
}

/** Validates a concrete-task context (the what-and-why evidence carries). */
export function validateBrowserTaskContext(
  value: unknown,
  field: string,
): ValidatedTaskContext {
  if (!isPlainObject(value)) {
    throw new ComputerUseError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, TASK_CONTEXT_KEYS, field);
  const description = value.description;
  if (
    typeof description !== 'string' ||
    description.trim().length < MIN_TASK_DESCRIPTION_LENGTH ||
    description.trim().length > MAX_TASK_DESCRIPTION_LENGTH
  ) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.description' must be a non-empty string of at most ${MAX_TASK_DESCRIPTION_LENGTH} characters`,
    );
  }
  let requestedFor: string | null = null;
  if (value.requestedFor !== undefined && value.requestedFor !== null) {
    if (
      typeof value.requestedFor !== 'string' ||
      value.requestedFor.trim().length === 0 ||
      value.requestedFor.length > MAX_REQUESTED_FOR_LENGTH
    ) {
      throw new ComputerUseError(
        'invalid_input',
        `'${field}.requestedFor' must be a non-empty string of at most ${MAX_REQUESTED_FOR_LENGTH} characters`,
      );
    }
    requestedFor = value.requestedFor.trim();
  }
  return { description: description.trim(), requestedFor };
}

// ---------------------------------------------------------------------------
// The allowlist (the governed-automation surface)
// ---------------------------------------------------------------------------

const ALLOWLIST_KEYS = ['urlGlobs', 'verbs'] as const;

export interface ValidatedAllowlist {
  urlGlobs: string[];
  verbs: BrowserVerb[];
}

function requireUrlGlob(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URL_GLOB_LENGTH ||
    !/^https?:\/\/[^/\s]*\S*$/.test(value) ||
    /\s/.test(value)
  ) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must be an absolute http(s) URL glob of at most ${MAX_URL_GLOB_LENGTH} characters without whitespace (e.g. 'https://vendor.example.com/app/*')`,
    );
  }
  return value;
}

/** Validates the governed-automation allowlist. */
export function validateAllowlist(value: unknown, field: string): ValidatedAllowlist {
  if (!isPlainObject(value)) {
    throw new ComputerUseError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, ALLOWLIST_KEYS, field);
  if (!Array.isArray(value.urlGlobs) || value.urlGlobs.length < 1) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.urlGlobs' must be an array of 1..${MAX_URL_GLOBS} URL globs — an ungoverned browser task cannot exist`,
    );
  }
  if (value.urlGlobs.length > MAX_URL_GLOBS) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.urlGlobs' must hold at most ${MAX_URL_GLOBS} globs (got ${value.urlGlobs.length})`,
    );
  }
  const urlGlobs = value.urlGlobs.map((entry, index) =>
    requireUrlGlob(entry, `${field}.urlGlobs[${index}]`),
  );
  const seen = new Set<string>();
  for (const glob of urlGlobs) {
    if (seen.has(glob)) {
      throw new ComputerUseError(
        'invalid_input',
        `duplicate URL glob '${glob}' in ${field}.urlGlobs`,
      );
    }
    seen.add(glob);
  }
  if (!Array.isArray(value.verbs) || value.verbs.length < 1) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.verbs' must be a non-empty array of the governed verbs (${BROWSER_VERBS.join(', ')})`,
    );
  }
  const verbs: BrowserVerb[] = [];
  const verbSeen = new Set<string>();
  for (const entry of value.verbs) {
    if (!isBrowserVerb(entry)) {
      throw new ComputerUseError(
        'invalid_input',
        `'${field}.verbs' entries must be governed verbs (${BROWSER_VERBS.join(', ')}) — '${String(entry)}' is not one`,
      );
    }
    if (verbSeen.has(entry)) {
      throw new ComputerUseError(
        'invalid_input',
        `duplicate verb '${entry}' in ${field}.verbs`,
      );
    }
    verbSeen.add(entry);
    verbs.push(entry);
  }
  return { urlGlobs, verbs };
}

// ---------------------------------------------------------------------------
// Actions (the canonical envelope) + steps (the frozen plan)
// ---------------------------------------------------------------------------

const ACTION_KEYS = ['verb', 'url', 'selector', 'value', 'secretField'] as const;

export interface ValidatedAction {
  verb: BrowserVerb;
  url: string;
  selector: string | null;
  value: string | null;
  secretField: string | null;
}

function requireActionUrl(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    !/^https?:\/\//.test(value) ||
    /\s/.test(value)
  ) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must be an absolute http(s) URL of at most ${MAX_URL_LENGTH} characters without whitespace`,
    );
  }
  return value;
}

function optionalSelector(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_SELECTOR_LENGTH) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must be a non-empty CSS selector of at most ${MAX_SELECTOR_LENGTH} characters`,
    );
  }
  return value.trim();
}

/** Validates one canonical action envelope (per-verb shape rules). */
export function validateAction(value: unknown, field: string): ValidatedAction {
  if (!isPlainObject(value)) {
    throw new ComputerUseError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, ACTION_KEYS, field);
  const verb = value.verb;
  if (!isBrowserVerb(verb)) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.verb' must be one of the governed verbs (${BROWSER_VERBS.join(', ')})`,
    );
  }
  const url = requireActionUrl(value.url, `${field}.url`);
  const selector = optionalSelector(value.selector, `${field}.selector`);

  let typedValue: string | null = null;
  if (value.value !== undefined && value.value !== null) {
    if (typeof value.value !== 'string' || value.value.length > MAX_TYPED_VALUE_LENGTH) {
      throw new ComputerUseError(
        'invalid_input',
        `'${field}.value' must be a string of at most ${MAX_TYPED_VALUE_LENGTH} characters`,
      );
    }
    typedValue = value.value;
  }
  let secretField: string | null = null;
  if (value.secretField !== undefined && value.secretField !== null) {
    if (
      typeof value.secretField !== 'string' ||
      !SECRET_FIELD_PATTERN.test(value.secretField)
    ) {
      throw new ComputerUseError(
        'invalid_input',
        `'${field}.secretField' must match ${SECRET_FIELD_PATTERN.source} (the credential field name — never the secret value)`,
      );
    }
    secretField = value.secretField;
  }

  // Per-verb shape rules — the envelope is governed by construction.
  if (verb === 'goto') {
    if (selector !== null) {
      throw new ComputerUseError(
        'invalid_input',
        `'${field}.selector' must be null for a 'goto' action — goto navigates, it does not select`,
      );
    }
  } else if (selector === null) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.selector' is required for a '${verb}' action`,
    );
  }
  if (verb !== 'type' && (typedValue !== null || secretField !== null)) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.value'/'${field}.secretField' only exist on 'type' actions — '${verb}' types nothing`,
    );
  }
  if (verb === 'type') {
    if (typedValue !== null && secretField !== null) {
      throw new ComputerUseError(
        'invalid_input',
        `'${field}.value' and '${field}.secretField' are mutually exclusive — type either a literal or a credential field, never both`,
      );
    }
    if (typedValue === null && secretField === null) {
      throw new ComputerUseError(
        'invalid_input',
        `a 'type' action needs '${field}.value' (a literal) or '${field}.secretField' (a credential field)`,
      );
    }
  }
  return { verb, url, selector, value: typedValue, secretField };
}

const STEP_INPUT_KEYS = ['key', 'action', 'expectation'] as const;

export interface ValidatedStepInput {
  key: string;
  action: ValidatedAction;
  expectation: Record<string, unknown>;
}

function requireStepKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !STEP_KEY_PATTERN.test(value)) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must match ${STEP_KEY_PATTERN.source}`,
    );
  }
  return value;
}

/** Validates one governed step of the plan. */
export function validateStepInput(value: unknown, field: string): ValidatedStepInput {
  if (!isPlainObject(value)) {
    throw new ComputerUseError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, STEP_INPUT_KEYS, field);
  const key = requireStepKey(value.key, `${field}.key`);
  const action = validateAction(value.action, `${field}.action`);
  const expectation = requirePlainJsonObject(value.expectation, `${field}.expectation`);
  if (Object.keys(expectation).length === 0) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}.expectation' must hold at least one expected field — an unverifiable step is not a governed step (observed state is verified before it counts as a result)`,
    );
  }
  return { key, action, expectation };
}

// ---------------------------------------------------------------------------
// The allowlist decision (pure — the same computation at creation & dispatch)
// ---------------------------------------------------------------------------

export interface AllowlistDecision {
  allowed: boolean;
  verb: BrowserVerb;
  url: string;
  matchedGlob: string | null;
  reason: string;
}

/**
 * The twice-checked allowlist decision (pure): a step is dispatchable
 * exactly when its URL matches at least one glob AND its verb is
 * permitted. The SAME computation runs at creation (whole plan), at
 * dispatch (every step) and — with its own copy — inside the driver.
 */
export function allowlistDecisionFor(
  allowlist: BrowserAllowlist,
  action: { verb: BrowserVerb; url: string },
): AllowlistDecision {
  const matchedGlob =
    allowlist.urlGlobs.find((glob) => urlMatchesGlob(action.url, glob)) ?? null;
  const verbPermitted = allowlist.verbs.includes(action.verb);
  if (matchedGlob === null && !verbPermitted) {
    return {
      allowed: false,
      verb: action.verb,
      url: action.url,
      matchedGlob: null,
      reason: `the URL '${action.url}' matches no allowlist glob and the verb '${action.verb}' is not permitted (allowed verbs: ${allowlist.verbs.join(', ')})`,
    };
  }
  if (matchedGlob === null) {
    return {
      allowed: false,
      verb: action.verb,
      url: action.url,
      matchedGlob: null,
      reason: `the URL '${action.url}' matches no allowlist glob (${allowlist.urlGlobs.join(', ')})`,
    };
  }
  if (!verbPermitted) {
    return {
      allowed: false,
      verb: action.verb,
      url: action.url,
      matchedGlob,
      reason: `the verb '${action.verb}' is not permitted (allowed verbs: ${allowlist.verbs.join(', ')})`,
    };
  }
  return {
    allowed: true,
    verb: action.verb,
    url: action.url,
    matchedGlob,
    reason: `allowed by glob '${matchedGlob}' with permitted verb '${action.verb}'`,
  };
}

// ---------------------------------------------------------------------------
// createBrowserTask
// ---------------------------------------------------------------------------

const CREATE_INPUT_KEYS = [
  'taskContext',
  'allowlist',
  'steps',
  'credentialRef',
  'idempotencyKey',
] as const;

export interface ValidatedCreateInput {
  taskContext: ValidatedTaskContext;
  allowlist: ValidatedAllowlist;
  steps: ValidatedStepInput[];
  credentialRef: string | null;
  idempotencyKey: string | null;
}

function optionalCredentialRef(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_CREDENTIAL_REF_LENGTH) {
    throw new ComputerUseError(
      'invalid_input',
      `'${field}' must be an OPAQUE credential reference of at most ${MAX_CREDENTIAL_REF_LENGTH} characters (the W082 discipline: a reference, never a secret value)`,
    );
  }
  return value.trim();
}

export function validateCreateBrowserTaskInput(input: unknown): ValidatedCreateInput {
  if (!isPlainObject(input)) {
    throw new ComputerUseError('invalid_input', 'the browser-task input must be an object');
  }
  rejectUnknownKeys(input, CREATE_INPUT_KEYS, 'the browser-task input');
  const taskContext = validateBrowserTaskContext(input.taskContext, 'taskContext');
  const allowlist = validateAllowlist(input.allowlist, 'allowlist');
  if (!Array.isArray(input.steps) || input.steps.length < 1) {
    throw new ComputerUseError(
      'invalid_input',
      `'steps' must be an array of 1..${MAX_STEPS_PER_TASK} governed steps — a browser task does at least one thing`,
    );
  }
  if (input.steps.length > MAX_STEPS_PER_TASK) {
    throw new ComputerUseError(
      'invalid_input',
      `'steps' must hold at most ${MAX_STEPS_PER_TASK} steps — the step budget is part of governed automation (got ${input.steps.length})`,
    );
  }
  const steps = input.steps.map((entry, index) => validateStepInput(entry, `steps[${index}]`));
  const keys = new Set<string>();
  for (const step of steps) {
    if (keys.has(step.key)) {
      throw new ComputerUseError(
        'invalid_input',
        `duplicate step key '${step.key}' — step keys are unique within a task`,
      );
    }
    keys.add(step.key);
  }
  // A step that names a credential field needs a credential reference to
  // materialize it from — the plan is refused before it exists.
  const credentialRef = optionalCredentialRef(input.credentialRef, 'credentialRef');
  if (credentialRef === null && steps.some((step) => step.action.secretField !== null)) {
    throw new ComputerUseError(
      'invalid_input',
      `'credentialRef' is required when a step types a credential field (secretField) — the reference is materialized inside the isolated session, never persisted as a value`,
    );
  }
  // THE PLAN IS ALLOWLIST-CONFORMANT AT CREATION: governed automation
  // starts at planning time — a task that could never dispatch is refused.
  for (const [index, step] of steps.entries()) {
    const decision = allowlistDecisionFor(allowlist, step.action);
    if (!decision.allowed) {
      throw new ComputerUseError(
        'invalid_input',
        `steps[${index}] ('${step.key}') violates the allowlist: ${decision.reason}`,
      );
    }
  }
  const idempotencyKey = optionalIdempotencyKey(input.idempotencyKey, 'idempotencyKey');
  return { taskContext, allowlist, steps, credentialRef, idempotencyKey };
}

// ---------------------------------------------------------------------------
// Run/reads inputs (uniform taskId shape)
// ---------------------------------------------------------------------------

const TASK_ID_INPUT_KEYS = ['taskId'] as const;

export interface ValidatedTaskIdInput {
  taskId: string;
}

function validateTaskIdInput(input: unknown): ValidatedTaskIdInput {
  if (!isPlainObject(input)) {
    throw new ComputerUseError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(input, TASK_ID_INPUT_KEYS, 'the input');
  return { taskId: requireUuid(input.taskId, 'taskId') };
}

export function validateStartBrowserTaskInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

export function validateResumeBrowserTaskInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ValidatedGetQuery {
  taskId: string;
}

export function validateGetBrowserTaskQuery(input: unknown): ValidatedGetQuery {
  if (!isPlainObject(input)) {
    throw new ComputerUseError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(input, ['taskId'], 'the query');
  return { taskId: requireUuid(input.taskId, 'taskId') };
}

export interface ValidatedListQuery {
  status: BrowserTaskStatus | null;
  limit: number;
}

export function validateListBrowserTasksQuery(input: unknown): ValidatedListQuery {
  if (input === undefined || input === null) {
    return { status: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(input)) {
    throw new ComputerUseError('invalid_query', 'the list query must be an object');
  }
  rejectUnknownKeys(input, ['status', 'limit'], 'the list query');
  let status: BrowserTaskStatus | null = null;
  if (input.status !== undefined && input.status !== null) {
    if (!isBrowserTaskStatus(input.status)) {
      throw new ComputerUseError(
        'invalid_query',
        `'status' must be one of ${BROWSER_TASK_STATUSES.join(', ')}`,
      );
    }
    status = input.status;
  }
  return { status, limit: optionalLimit(input.limit, 'limit') };
}

export interface ValidatedListEventsQuery {
  taskId: string;
  limit: number;
}

export function validateListBrowserTaskEventsQuery(input: unknown): ValidatedListEventsQuery {
  if (!isPlainObject(input)) {
    throw new ComputerUseError('invalid_query', 'the events query must be an object');
  }
  rejectUnknownKeys(input, ['taskId', 'limit'], 'the events query');
  return {
    taskId: requireUuid(input.taskId, 'taskId'),
    limit: optionalLimit(input.limit, 'limit'),
  };
}
