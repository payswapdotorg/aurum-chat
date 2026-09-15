// Pure validation/normalization logic of the llm module (no database, no
// adapters, no clock). Everything a caller may put into an AI provider
// account, an invocation, a hot-swap verification or an availability
// override crosses these guards first; the SQL CHECK constraints in
// migrations/001..004 mirror the load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `createdAt`, `updatedAt`, `provider`-swaps or `createdBy`
// into a record call — the account's identity, tenancy and commit time are
// minted by the system.
//
// Provider-specific normalization lives in `adapters/`, NOT here (the
// channels module's discipline): validation is provider-neutral by
// construction; adapter output is re-validated before anything is
// persisted (defense in depth).

import type { TenantContext } from '@/infra/tenant';
import { LlmError } from './errors';
import {
  LLM_CAPABILITIES,
  isLlmCapability,
  isLlmProvider,
  type LlmCapability,
  type LlmProvider,
} from './registry';
import type {
  AiProviderAccountStatus,
  CanonicalLlmMessage,
  CanonicalLlmMessageRole,
  DataClassification,
  HotSwapTarget,
  InvokeLlmInput,
  ListAiProviderAccountsQuery,
  ListLlmExecutionsQuery,
  LlmAvailabilityState,
  LlmExecutionPurpose,
  LlmExecutionStatus,
  LlmScope,
  RegisterAiProviderAccountInput,
  SetAiAvailabilityInput,
  UpdateAiProviderAccountInput,
  VerifyProviderHotSwapInput,
} from './types';
import { DATA_CLASSIFICATIONS, LLM_SCOPES } from './types';

// ---------------------------------------------------------------------------
// Bounds (mirrored by migrations where SQL can express them)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_LABEL_LENGTH = 100;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 1_000;
export const MAX_BUDGET_MINOR = 2_000_000_000;

export const MAX_MESSAGES = 64;
export const MAX_MESSAGE_CONTENT_LENGTH = 32_768;
export const MAX_EMBEDDING_INPUT_LENGTH = 65_536;
export const MAX_TEMPERATURE = 2;
export const MAX_OUTPUT_TOKENS = 32_768;
/** Canonical requests stay well under the payload caps the sibling modules apply. */
export const MAX_REQUEST_BYTES = 262_144;
export const MAX_RESULT_TEXT_LENGTH = 262_144;
export const MAX_EMBEDDING_DIMENSIONS = 4_096;

export const MAX_REASON_LENGTH = 500;
export const MAX_ERROR_DETAIL_LENGTH = 500;
export const MAX_PROVIDER_EXECUTION_ID_LENGTH = 255;
export const MAX_MODEL_ID_LENGTH = 255;

/** Mirrors the actions module's idempotency-key pattern (W009) so forwarded keys always pass its gate. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with an explicit offset (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// Opaque provider-minted strings — printable (control characters excluded).
const PRINTABLE_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;

const REGISTER_ACCOUNT_KEYS = [
  'provider',
  'label',
  'credentialRef',
  'scopes',
  'capabilities',
  'maxDataClassification',
  'priority',
  'budgetMinor',
] as const;
const UPDATE_ACCOUNT_KEYS = [
  'accountId',
  'credentialRef',
  'scopes',
  'capabilities',
  'maxDataClassification',
  'priority',
  'budgetMinor',
  'status',
] as const;
const INVOKE_KEYS = [
  'capability',
  'scope',
  'dataClassification',
  'messages',
  'embeddingInput',
  'temperature',
  'maxOutputTokens',
  'pinnedAccountId',
  'pinnedModel',
  'idempotencyKey',
] as const;
const VERIFY_HOT_SWAP_KEYS = [
  'capability',
  'scope',
  'dataClassification',
  'messages',
  'embeddingInput',
  'temperature',
  'maxOutputTokens',
  'targetA',
  'targetB',
  'idempotencyKey',
] as const;
const TARGET_KEYS = ['accountId', 'model'] as const;
const SET_AVAILABILITY_KEYS = ['accountId', 'model', 'state', 'reason', 'expiresAt'] as const;
const LIST_ACCOUNTS_KEYS = ['provider', 'status', 'limit'] as const;
const LIST_EXECUTIONS_KEYS = [
  'provider',
  'model',
  'accountId',
  'capability',
  'status',
  'purpose',
  'limit',
] as const;
const USAGE_SUMMARY_KEYS = ['provider', 'accountId', 'since', 'until'] as const;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isLlmScope(value: unknown): value is LlmScope {
  return typeof value === 'string' && (LLM_SCOPES as readonly string[]).includes(value);
}

export function isDataClassification(value: unknown): value is DataClassification {
  return (
    typeof value === 'string' &&
    (DATA_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

export function isAiProviderAccountStatus(value: unknown): value is AiProviderAccountStatus {
  return (
    typeof value === 'string' && (['active', 'disabled'] as const).includes(value as never)
  );
}

export function isLlmAvailabilityState(value: unknown): value is LlmAvailabilityState {
  return (
    typeof value === 'string' && (['available', 'unavailable'] as const).includes(value as never)
  );
}

export function isLlmExecutionStatus(value: unknown): value is LlmExecutionStatus {
  return (
    typeof value === 'string' && (['completed', 'failed'] as const).includes(value as never)
  );
}

export function isLlmExecutionPurpose(value: unknown): value is LlmExecutionPurpose {
  return (
    typeof value === 'string' &&
    (['invocation', 'hot-swap-verification'] as const).includes(value as never)
  );
}

// ---------------------------------------------------------------------------
// Small helpers (the channels module's proven shapes)
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
      throw inputError(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function inputError(message: string): LlmError {
  return new LlmError('invalid_llm_input', message);
}

function queryError(message: string): LlmError {
  return new LlmError('invalid_llm_query', message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw inputError(`${field} must be a string when present`);
  const text = value.trim();
  return text === '' ? null : text;
}

function boundedOptionalText(value: unknown, field: string, maxLength: number): string | null {
  const text = optionalTrimmed(value, field);
  if (text !== null && text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function requirePrintable(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  if (!PRINTABLE_ID_PATTERN.test(text)) {
    throw inputError(
      `${field} must be 1..${maxLength} printable characters without control characters`,
    );
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

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, field);
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

function optionalIsoInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field);
}

function requireIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, 'idempotencyKey');
  if (!IDEMPOTENCY_KEY_PATTERN.test(text)) {
    throw inputError(
      `idempotencyKey must match ${IDEMPOTENCY_KEY_PATTERN.source} (got '${text}')`,
    );
  }
  return text;
}

/** Validates a non-empty, duplicate-free array of vocabulary values. */
function requireVocabularyArray<T extends string>(
  value: unknown,
  field: string,
  guard: (entry: unknown) => entry is T,
  vocabulary: readonly T[],
): T[] {
  if (!Array.isArray(value)) {
    throw inputError(`${field} must be an array of ${vocabulary.join(', ')}`);
  }
  if (value.length === 0) {
    throw inputError(`${field} must contain at least one of ${vocabulary.join(', ')}`);
  }
  if (value.length > vocabulary.length) {
    throw inputError(`${field} may contain at most ${vocabulary.length} entries`);
  }
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of value) {
    if (!guard(entry)) {
      throw inputError(
        `${field} entries must be one of ${vocabulary.join(', ')} (got '${String(entry)}')`,
      );
    }
    if (seen.has(entry)) {
      throw inputError(`${field} must not contain duplicates (duplicate: '${entry}')`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw inputError(`${field} must be an integer (got ${String(value)})`);
  }
  if (value < min || value > max) {
    throw inputError(`${field} must be between ${min} and ${max} (got ${String(value)})`);
  }
  return value;
}

/** Optional enum-typed field: undefined → null; invalid → throws. */
function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  guard: (entry: unknown) => entry is T,
  vocabulary: readonly T[],
): T | null {
  if (value === undefined) return null;
  if (!guard(value)) {
    throw inputError(`${field} must be one of ${vocabulary.join(', ')} (got '${String(value)}')`);
  }
  return value;
}

/** Id / shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertLlmTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new LlmError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new LlmError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new LlmError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// Accounts (BYOA)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RegisterAiProviderAccountInput`. */
export interface ValidatedRegisterAccountInput {
  provider: LlmProvider;
  label: string;
  credentialRef: string;
  scopes: LlmScope[];
  capabilities: LlmCapability[];
  maxDataClassification: DataClassification;
  priority: number;
  budgetMinor: number | null;
}

export function validateRegisterAiProviderAccountInput(
  input: RegisterAiProviderAccountInput,
): ValidatedRegisterAccountInput {
  if (!isPlainObject(input)) throw inputError('account input must be an object');
  rejectUnknownKeys(input, REGISTER_ACCOUNT_KEYS, 'the account input');

  if (!isLlmProvider(input.provider)) {
    throw inputError(`provider must be one of the registry providers (got '${String(input.provider)}')`);
  }
  const label = requirePrintable(input.label, 'label', MAX_LABEL_LENGTH);
  const credentialRef = requirePrintable(
    input.credentialRef,
    'credentialRef',
    MAX_CREDENTIAL_REF_LENGTH,
  );
  const scopes = requireVocabularyArray(input.scopes, 'scopes', isLlmScope, LLM_SCOPES);
  const capabilities = requireVocabularyArray(
    input.capabilities,
    'capabilities',
    isLlmCapability,
    LLM_CAPABILITIES,
  );
  if (!isDataClassification(input.maxDataClassification)) {
    throw inputError(
      `maxDataClassification must be one of ${DATA_CLASSIFICATIONS.join(', ')} (got '${String(input.maxDataClassification)}')`,
    );
  }
  const priority = requireBoundedInteger(input.priority, 'priority', MIN_PRIORITY, MAX_PRIORITY);
  let budgetMinor: number | null = null;
  if (input.budgetMinor !== undefined && input.budgetMinor !== null) {
    budgetMinor = requireBoundedInteger(input.budgetMinor, 'budgetMinor', 1, MAX_BUDGET_MINOR);
  }
  return {
    provider: input.provider,
    label,
    credentialRef,
    scopes,
    capabilities,
    maxDataClassification: input.maxDataClassification,
    priority,
    budgetMinor,
  };
}

/** Fully validated + normalized form of `UpdateAiProviderAccountInput` (only present fields). */
export interface ValidatedUpdateAccountInput {
  accountId: string;
  credentialRef: string | null;
  scopes: LlmScope[] | null;
  capabilities: LlmCapability[] | null;
  maxDataClassification: DataClassification | null;
  priority: number | null;
  budgetMinor: number | null;
  /** present=true with null value means "clear the budget". */
  budgetProvided: boolean;
  status: AiProviderAccountStatus | null;
}

export function validateUpdateAiProviderAccountInput(
  input: UpdateAiProviderAccountInput,
): ValidatedUpdateAccountInput {
  if (!isPlainObject(input)) throw inputError('account update must be an object');
  rejectUnknownKeys(input, UPDATE_ACCOUNT_KEYS, 'the account update');
  const accountId = requireUuid(input.accountId, 'accountId');

  const credentialRef =
    input.credentialRef === undefined
      ? null
      : requirePrintable(input.credentialRef, 'credentialRef', MAX_CREDENTIAL_REF_LENGTH);
  const scopes =
    input.scopes === undefined ? null : requireVocabularyArray(input.scopes, 'scopes', isLlmScope, LLM_SCOPES);
  const capabilities =
    input.capabilities === undefined
      ? null
      : requireVocabularyArray(input.capabilities, 'capabilities', isLlmCapability, LLM_CAPABILITIES);
  const maxDataClassification = optionalEnum(
    input.maxDataClassification,
    'maxDataClassification',
    isDataClassification,
    DATA_CLASSIFICATIONS,
  );
  const priority =
    input.priority === undefined
      ? null
      : requireBoundedInteger(input.priority, 'priority', MIN_PRIORITY, MAX_PRIORITY);
  let budgetMinor: number | null = null;
  const budgetProvided = input.budgetMinor !== undefined;
  if (budgetProvided && input.budgetMinor !== null) {
    budgetMinor = requireBoundedInteger(input.budgetMinor, 'budgetMinor', 1, MAX_BUDGET_MINOR);
  }
  const status = optionalEnum(input.status, 'status', isAiProviderAccountStatus, ['active', 'disabled']);

  const touched =
    credentialRef !== null ||
    scopes !== null ||
    capabilities !== null ||
    maxDataClassification !== null ||
    priority !== null ||
    budgetProvided ||
    status !== null;
  if (!touched) {
    throw inputError(
      'account update must change at least one field (credentialRef, scopes, capabilities, maxDataClassification, priority, budgetMinor, status)',
    );
  }
  return {
    accountId,
    credentialRef,
    scopes,
    capabilities,
    maxDataClassification,
    priority,
    budgetMinor,
    budgetProvided,
    status,
  };
}

export interface ValidatedListAccountsQuery {
  provider: LlmProvider | null;
  status: AiProviderAccountStatus | null;
  limit: number;
}

export function validateListAiProviderAccountsQuery(
  query: ListAiProviderAccountsQuery,
): ValidatedListAccountsQuery {
  if (!isPlainObject(query)) throw queryError('account query must be an object');
  rejectUnknownKeys(query, LIST_ACCOUNTS_KEYS, 'the account query');
  if (query.provider !== undefined && query.provider !== null && !isLlmProvider(query.provider)) {
    throw queryError(`provider must be one of the registry providers (got '${String(query.provider)}')`);
  }
  if (query.status !== undefined && query.status !== null && !isAiProviderAccountStatus(query.status)) {
    throw queryError(`status must be 'active' or 'disabled' (got '${String(query.status)}')`);
  }
  const limit =
    query.limit === undefined || query.limit === null
      ? DEFAULT_LIST_LIMIT
      : requireListLimit(query.limit);
  return {
    provider: query.provider ?? null,
    status: query.status ?? null,
    limit,
  };
}

function requireListLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw queryError(`limit must be an integer (got ${String(value)})`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw queryError(`limit must be between 1 and ${MAX_LIST_LIMIT} (got ${String(value)})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Canonical invocation requests
// ---------------------------------------------------------------------------

/** Shared canonical request fields once validated (both invoke and hot-swap verification produce this). */
export interface ValidatedCanonicalRequest {
  capability: LlmCapability;
  scope: LlmScope;
  dataClassification: DataClassification;
  messages: CanonicalLlmMessage[] | null;
  embeddingInput: string | null;
  temperature: number | null;
  maxOutputTokens: number | null;
}

function validateCanonicalRequestFields(value: Record<string, unknown>): ValidatedCanonicalRequest {
  if (!isLlmCapability(value.capability)) {
    throw inputError(
      `capability must be one of text-generation, embedding (got '${String(value.capability)}')`,
    );
  }
  if (!isLlmScope(value.scope)) {
    throw inputError(`scope must be one of ${LLM_SCOPES.join(', ')} (got '${String(value.scope)}')`);
  }
  if (!isDataClassification(value.dataClassification)) {
    throw inputError(
      `dataClassification must be one of ${DATA_CLASSIFICATIONS.join(', ')} (got '${String(value.dataClassification)}')`,
    );
  }

  let temperature: number | null = null;
  if (value.temperature !== undefined && value.temperature !== null) {
    if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)) {
      throw inputError(`temperature must be a finite number (got ${String(value.temperature)})`);
    }
    if (value.temperature < 0 || value.temperature > MAX_TEMPERATURE) {
      throw inputError(
        `temperature must be between 0 and ${MAX_TEMPERATURE} (got ${String(value.temperature)})`,
      );
    }
    temperature = value.temperature;
  }

  let maxOutputTokens: number | null = null;
  if (value.maxOutputTokens !== undefined && value.maxOutputTokens !== null) {
    maxOutputTokens = requireBoundedInteger(
      value.maxOutputTokens,
      'maxOutputTokens',
      1,
      MAX_OUTPUT_TOKENS,
    );
  }

  let messages: CanonicalLlmMessage[] | null = null;
  let embeddingInput: string | null = null;

  if (value.capability === 'text-generation') {
    if (value.embeddingInput !== undefined && value.embeddingInput !== null) {
      throw inputError('embeddingInput belongs to the embedding capability, not text-generation');
    }
    if (!Array.isArray(value.messages)) {
      throw inputError('messages must be an array for the text-generation capability');
    }
    if (value.messages.length === 0) {
      throw inputError('messages must contain at least one message');
    }
    if (value.messages.length > MAX_MESSAGES) {
      throw inputError(`messages must contain at most ${MAX_MESSAGES} entries (got ${value.messages.length})`);
    }
    messages = value.messages.map((entry, index) => validateCanonicalMessage(entry, `messages[${index}]`));
  } else {
    if (value.messages !== undefined && value.messages !== null) {
      throw inputError('messages belong to the text-generation capability, not embedding');
    }
    if (typeof value.embeddingInput !== 'string' || value.embeddingInput.trim() === '') {
      throw inputError('embeddingInput must be a non-empty string for the embedding capability');
    }
    if (value.embeddingInput.length > MAX_EMBEDDING_INPUT_LENGTH) {
      throw inputError(
        `embeddingInput must be at most ${MAX_EMBEDDING_INPUT_LENGTH} characters (got ${value.embeddingInput.length})`,
      );
    }
    embeddingInput = value.embeddingInput;
  }

  if (temperature !== null && value.capability !== 'text-generation') {
    throw inputError('temperature applies to text-generation only');
  }
  if (maxOutputTokens !== null && value.capability !== 'text-generation') {
    throw inputError('maxOutputTokens applies to text-generation only');
  }

  const serialized = JSON.stringify({ messages, embeddingInput }) ?? '';
  if (serialized.length > MAX_REQUEST_BYTES) {
    throw inputError(
      `the canonical request exceeds ${MAX_REQUEST_BYTES} bytes (${serialized.length}); large artifacts belong in object storage`,
    );
  }
  return {
    capability: value.capability,
    scope: value.scope,
    dataClassification: value.dataClassification,
    messages,
    embeddingInput,
    temperature,
    maxOutputTokens,
  };
}

const MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;

function validateCanonicalMessage(value: unknown, where: string): CanonicalLlmMessage {
  if (!isPlainObject(value)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(value, ['role', 'content'], where);
  const role = value.role;
  if (typeof role !== 'string' || !(MESSAGE_ROLES as readonly string[]).includes(role)) {
    throw inputError(`${where}.role must be one of ${MESSAGE_ROLES.join(', ')} (got '${String(role)}')`);
  }
  if (typeof value.content !== 'string' || value.content.trim() === '') {
    throw inputError(`${where}.content must be a non-empty string`);
  }
  if (value.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    throw inputError(
      `${where}.content must be at most ${MAX_MESSAGE_CONTENT_LENGTH} characters (got ${value.content.length})`,
    );
  }
  return { role: role as CanonicalLlmMessageRole, content: value.content };
}

/** Fully validated + normalized form of `InvokeLlmInput`. */
export interface ValidatedInvokeInput extends ValidatedCanonicalRequest {
  pinnedAccountId: string | null;
  pinnedModel: string | null;
  idempotencyKey: string | null;
}

export function validateInvokeLlmInput(input: InvokeLlmInput): ValidatedInvokeInput {
  if (!isPlainObject(input)) throw inputError('invocation input must be an object');
  rejectUnknownKeys(input, INVOKE_KEYS, 'the invocation input');
  const canonical = validateCanonicalRequestFields(input);

  const pinnedAccountId = optionalUuid(input.pinnedAccountId, 'pinnedAccountId');
  let pinnedModel: string | null = null;
  if (input.pinnedModel !== undefined && input.pinnedModel !== null) {
    pinnedModel = requirePrintable(input.pinnedModel, 'pinnedModel', MAX_MODEL_ID_LENGTH);
  }
  if (pinnedModel !== null && pinnedAccountId === null) {
    throw inputError('pinnedModel requires pinnedAccountId — a model pin needs its account');
  }
  return {
    ...canonical,
    pinnedAccountId,
    pinnedModel,
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
  };
}

/** Fully validated + normalized form of `VerifyProviderHotSwapInput`. */
export interface ValidatedVerifyHotSwapInput extends ValidatedCanonicalRequest {
  targetA: HotSwapTarget;
  targetB: HotSwapTarget;
  idempotencyKey: string | null;
}

export function validateVerifyProviderHotSwapInput(
  input: VerifyProviderHotSwapInput,
): ValidatedVerifyHotSwapInput {
  if (!isPlainObject(input)) throw inputError('hot-swap verification input must be an object');
  rejectUnknownKeys(input, VERIFY_HOT_SWAP_KEYS, 'the hot-swap verification input');
  const canonical = validateCanonicalRequestFields(input);
  const targetA = validateHotSwapTarget(input.targetA, 'targetA');
  const targetB = validateHotSwapTarget(input.targetB, 'targetB');
  if (targetA.accountId === targetB.accountId && targetA.model === targetB.model) {
    throw inputError(
      'targetA and targetB are identical — a hot-swap verification needs two different (account, model) targets',
    );
  }
  return {
    ...canonical,
    targetA,
    targetB,
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
  };
}

function validateHotSwapTarget(value: unknown, where: string): HotSwapTarget {
  if (!isPlainObject(value)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(value, TARGET_KEYS, where);
  return {
    accountId: requireUuid(value.accountId, `${where}.accountId`),
    model: requirePrintable(value.model, `${where}.model`, MAX_MODEL_ID_LENGTH),
  };
}

// ---------------------------------------------------------------------------
// Availability overrides
// ---------------------------------------------------------------------------

export interface ValidatedSetAvailabilityInput {
  accountId: string;
  model: string;
  state: LlmAvailabilityState;
  reason: string | null;
  expiresAt: string | null;
}

export function validateSetAiAvailabilityInput(
  input: SetAiAvailabilityInput,
): ValidatedSetAvailabilityInput {
  if (!isPlainObject(input)) throw inputError('availability input must be an object');
  rejectUnknownKeys(input, SET_AVAILABILITY_KEYS, 'the availability input');
  const accountId = requireUuid(input.accountId, 'accountId');
  const model = requirePrintable(input.model, 'model', MAX_MODEL_ID_LENGTH);
  if (!isLlmAvailabilityState(input.state)) {
    throw inputError(`state must be 'available' or 'unavailable' (got '${String(input.state)}')`);
  }
  const reason = boundedOptionalText(input.reason, 'reason', MAX_REASON_LENGTH);
  const expiresAt = optionalIsoInstant(input.expiresAt, 'expiresAt');
  if (expiresAt !== null && input.state !== 'unavailable') {
    throw inputError('expiresAt applies to the unavailable state only');
  }
  return { accountId, model, state: input.state, reason, expiresAt };
}

export interface ValidatedGetAvailabilityQuery {
  accountId: string | null;
}

export function validateGetAiAvailabilityQuery(query: {
  accountId?: string | null;
}): ValidatedGetAvailabilityQuery {
  if (!isPlainObject(query)) throw queryError('availability query must be an object');
  const accountId = query.accountId;
  if (accountId !== undefined && accountId !== null && !isUuid(accountId)) {
    throw queryError('accountId must be a uuid when present');
  }
  return { accountId: accountId ?? null };
}

// ---------------------------------------------------------------------------
// Execution reads
// ---------------------------------------------------------------------------

export interface ValidatedListExecutionsQuery {
  provider: LlmProvider | null;
  model: string | null;
  accountId: string | null;
  capability: LlmCapability | null;
  status: LlmExecutionStatus | null;
  purpose: LlmExecutionPurpose | null;
  limit: number;
}

export function validateListLlmExecutionsQuery(
  query: ListLlmExecutionsQuery,
): ValidatedListExecutionsQuery {
  if (!isPlainObject(query)) throw queryError('execution query must be an object');
  rejectUnknownKeys(query, LIST_EXECUTIONS_KEYS, 'the execution query');
  if (query.provider !== undefined && query.provider !== null && !isLlmProvider(query.provider)) {
    throw queryError(`provider must be one of the registry providers (got '${String(query.provider)}')`);
  }
  if (query.capability !== undefined && query.capability !== null && !isLlmCapability(query.capability)) {
    throw queryError(`capability must be one of text-generation, embedding (got '${String(query.capability)}')`);
  }
  if (query.status !== undefined && query.status !== null && !isLlmExecutionStatus(query.status)) {
    throw queryError(`status must be 'completed' or 'failed' (got '${String(query.status)}')`);
  }
  if (query.purpose !== undefined && query.purpose !== null && !isLlmExecutionPurpose(query.purpose)) {
    throw queryError(`purpose must be 'invocation' or 'hot-swap-verification' (got '${String(query.purpose)}')`);
  }
  return {
    provider: query.provider ?? null,
    model:
      query.model === undefined || query.model === null
        ? null
        : requirePrintable(query.model, 'model', MAX_MODEL_ID_LENGTH),
    accountId: optionalUuid(query.accountId, 'accountId'),
    capability: query.capability ?? null,
    status: query.status ?? null,
    purpose: query.purpose ?? null,
    limit:
      query.limit === undefined || query.limit === null ? DEFAULT_LIST_LIMIT : requireListLimit(query.limit),
  };
}

export interface ValidatedUsageSummaryQuery {
  provider: LlmProvider | null;
  accountId: string | null;
  since: string | null;
  until: string | null;
}

export function validateUsageSummaryQuery(query: {
  provider?: LlmProvider;
  accountId?: string;
  since?: string | null;
  until?: string | null;
}): ValidatedUsageSummaryQuery {
  if (!isPlainObject(query)) throw queryError('usage summary query must be an object');
  rejectUnknownKeys(query, USAGE_SUMMARY_KEYS, 'the usage summary query');
  if (query.provider !== undefined && query.provider !== null && !isLlmProvider(query.provider)) {
    throw queryError(`provider must be one of the registry providers (got '${String(query.provider)}')`);
  }
  const accountId = optionalUuid(query.accountId, 'accountId');
  const since = optionalIsoInstant(query.since, 'since');
  const until = optionalIsoInstant(query.until, 'until');
  if (since !== null && until !== null && Date.parse(until) < Date.parse(since)) {
    throw queryError('until must not precede since');
  }
  return { provider: query.provider ?? null, accountId, since, until };
}

export interface ValidatedAccountRefQuery {
  accountId: string;
}

export function validateAccountRefQuery(query: {
  accountId: string;
}): ValidatedAccountRefQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  // Shape only: malformed ids flow to the service's uniform not-found
  // (no existence leak through validation errors).
  if (typeof query.accountId !== 'string' || query.accountId.trim() === '') {
    throw queryError('query.accountId must be a non-empty string');
  }
  return { accountId: query.accountId };
}

export interface ValidatedExecutionRefQuery {
  executionId: string;
}

export function validateExecutionRefQuery(query: {
  executionId: string;
}): ValidatedExecutionRefQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  if (typeof query.executionId !== 'string' || query.executionId.trim() === '') {
    throw queryError('query.executionId must be a non-empty string');
  }
  return { executionId: query.executionId };
}
