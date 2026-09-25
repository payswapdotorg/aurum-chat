// Input validation of the provider-billing module — the house pattern: a
// validate* function per public operation, returning fully-typed validated
// inputs, throwing ProviderBillingError('invalid_input' | 'invalid_query')
// otherwise. Pure: no DB, no clock.

import { ProviderBillingError } from './errors';
import type {
  BudgetScope,
  PaymentArrangementKind,
  PaymentArrangementStatus,
} from './types';

// ---------------------------------------------------------------------------
// Shared vocabularies + limits
// ---------------------------------------------------------------------------

export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEDUPE_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
export const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export const MAX_COST_MINOR = 1_000_000_000_000; // 10,000,000.00 USD in minor units
export const MAX_QUANTITY = 1_000_000_000_000;
export const MAX_BUDGET_MINOR = 1_000_000_000_000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_SETTLEMENT_WINDOWS = 50;
/** Longest settleable window: 400 days (loose upper bound; a future exact-year cap can tighten it). */
export const MAX_WINDOW_SECONDS = 400 * 24 * 3600;
/** Settlement charge lease: a 'settling' row may be re-driven after this. */
export const SETTLEMENT_LEASE_SECONDS = 600;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_LLM_IMPORT_LIMIT = 100;
export const MAX_LLM_IMPORT_LIMIT = 500;

const BUDGET_SCOPES: readonly BudgetScope[] = ['tenant', 'gateway', 'provider', 'capability'];
const ARRANGEMENT_KINDS: readonly PaymentArrangementKind[] = ['aurum-mediated', 'direct-customer'];
const ARRANGEMENT_STATUSES: readonly PaymentArrangementStatus[] = ['active', 'retired'];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isPaymentArrangementKind(value: unknown): value is PaymentArrangementKind {
  return ARRANGEMENT_KINDS.includes(value as PaymentArrangementKind);
}

export function isPaymentArrangementStatus(value: unknown): value is PaymentArrangementStatus {
  return ARRANGEMENT_STATUSES.includes(value as PaymentArrangementStatus);
}

export function isBudgetScope(value: unknown): value is BudgetScope {
  return BUDGET_SCOPES.includes(value as BudgetScope);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function invalid(message: string): never {
  throw new ProviderBillingError('invalid_input', message);
}

function invalidQuery(message: string): never {
  throw new ProviderBillingError('invalid_query', message);
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(`${where} must be an object`);
  return value;
}

function optionalString(value: unknown, where: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid(`${where} must be a string`);
  if (value.trim() === '' || value.length > max) {
    invalid(`${where} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function requireKey(value: unknown, where: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    invalid(`${where} must match ${pattern.source}`);
  }
  return value;
}

function requireIsoInstant(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    invalid(`${where} must be a strict ISO 8601 timestamp with explicit offset`);
  }
  return value;
}

function optionalIsoInstant(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, where);
}

function requireNonNegativeInteger(value: unknown, where: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    invalid(`${where} must be an integer between 0 and ${max}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, where: string, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    invalid(`${where} must be an integer between 1 and ${max}`);
  }
  return value;
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') invalid(`${where} must be a boolean`);
  return value;
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

export interface ValidatedTenantContext {
  tenantId: string;
  principalId: string;
  authority: string[];
}

export function assertBillingTenantContext(ctx: unknown): ValidatedTenantContext {
  if (!isPlainObject(ctx)) {
    throw new ProviderBillingError('invalid_context', 'a TenantContext object is required');
  }
  if (typeof ctx.tenantId !== 'string' || !isUuid(ctx.tenantId)) {
    throw new ProviderBillingError('invalid_context', 'ctx.tenantId must be a uuid');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ProviderBillingError('invalid_context', 'ctx.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority) || ctx.authority.some((claim) => typeof claim !== 'string')) {
    throw new ProviderBillingError('invalid_context', 'ctx.authority must be an array of strings');
  }
  return { tenantId: ctx.tenantId, principalId: ctx.principalId, authority: ctx.authority };
}

// ---------------------------------------------------------------------------
// Arrangements
// ---------------------------------------------------------------------------

export interface ValidatedRegisterArrangementInput {
  gateway: string;
  provider: string;
  arrangement: PaymentArrangementKind;
  settlementAdapterKey: string | null;
  directBillingNote: string | null;
}

export function validateRegisterArrangementInput(
  input: unknown,
): ValidatedRegisterArrangementInput {
  const value = requireObject(input, 'registerPaymentArrangement input');
  const gateway = requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const provider = requireKey(value.provider, 'provider', KEY_PATTERN);
  if (!isPaymentArrangementKind(value.arrangement)) {
    invalid("arrangement must be 'aurum-mediated' or 'direct-customer'");
  }
  const adapterKey = optionalString(value.settlementAdapterKey, 'settlementAdapterKey', 64);
  const note = optionalString(value.directBillingNote, 'directBillingNote', MAX_NOTE_LENGTH);
  if (value.arrangement === 'aurum-mediated') {
    if (adapterKey === null) {
      invalid("settlementAdapterKey is required when arrangement is 'aurum-mediated'");
    }
    if (note !== null) invalid("directBillingNote must be null when arrangement is 'aurum-mediated'");
  } else {
    if (note === null) {
      invalid(
        "directBillingNote is required when arrangement is 'direct-customer' (the external billing requirement must be explicit)",
      );
    }
    if (adapterKey !== null) {
      invalid("settlementAdapterKey must be null when arrangement is 'direct-customer'");
    }
  }
  return { gateway, provider, arrangement: value.arrangement, settlementAdapterKey: adapterKey, directBillingNote: note };
}

export interface ValidatedArrangementQuery {
  gateway: string;
  provider: string;
}

export function validateArrangementQuery(input: unknown): ValidatedArrangementQuery {
  const value = requireObject(input, 'arrangement query');
  return {
    gateway: requireKey(value.gateway, 'gateway', KEY_PATTERN),
    provider: requireKey(value.provider, 'provider', KEY_PATTERN),
  };
}

export interface ValidatedListArrangementsQuery {
  gateway: string | null;
  arrangement: PaymentArrangementKind | null;
  status: PaymentArrangementStatus | null;
  limit: number;
}

export function validateListArrangementsQuery(input: unknown): ValidatedListArrangementsQuery {
  const value = isPlainObject(input) ? input : {};
  const gateway =
    value.gateway === undefined || value.gateway === null
      ? null
      : requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const arrangement =
    value.arrangement === undefined || value.arrangement === null
      ? null
      : isPaymentArrangementKind(value.arrangement)
        ? value.arrangement
        : invalidQuery('arrangement must be an arrangement kind when provided');
  const status =
    value.status === undefined || value.status === null
      ? null
      : isPaymentArrangementStatus(value.status)
        ? value.status
        : invalidQuery('status must be an arrangement status when provided');
  const limit = requirePositiveInteger(value.limit, 'limit', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  return { gateway, arrangement, status, limit };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface ValidatedRecordUsageInput {
  gateway: string;
  provider: string;
  capability: string;
  executionRef: string | null;
  accountRef: string | null;
  costMinor: number;
  quantity: number | null;
  unit: string | null;
  source: string;
  dedupeKey: string;
  occurredAt: string | null;
}

export function validateRecordUsageInput(input: unknown): ValidatedRecordUsageInput {
  const value = requireObject(input, 'recordProviderUsage input');
  const gateway = requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const provider = requireKey(value.provider, 'provider', KEY_PATTERN);
  const capability = requireKey(value.capability, 'capability', CAPABILITY_PATTERN);
  const executionRef = optionalString(value.executionRef, 'executionRef', 255);
  const accountRef = optionalString(value.accountRef, 'accountRef', 255);
  const costMinor = requireNonNegativeInteger(value.costMinor, 'costMinor', MAX_COST_MINOR);
  const quantity =
    value.quantity === undefined || value.quantity === null
      ? null
      : requireNonNegativeInteger(value.quantity, 'quantity', MAX_QUANTITY);
  const unit = optionalString(value.unit, 'unit', 64);
  const source = optionalString(value.source, 'source', 64) ?? 'gateway';
  if (typeof value.dedupeKey !== 'string' || !DEDUPE_KEY_PATTERN.test(value.dedupeKey)) {
    invalid('dedupeKey must be 1..200 printable ASCII characters');
  }
  const occurredAt = optionalIsoInstant(value.occurredAt, 'occurredAt');
  return {
    gateway,
    provider,
    capability,
    executionRef,
    accountRef,
    costMinor,
    quantity,
    unit,
    source,
    dedupeKey: value.dedupeKey,
    occurredAt,
  };
}

export interface ValidatedListUsageQuery {
  gateway: string | null;
  provider: string | null;
  capability: string | null;
  executionRef: string | null;
  accountRef: string | null;
  since: string | null;
  until: string | null;
  limit: number;
}

export function validateListUsageQuery(input: unknown): ValidatedListUsageQuery {
  const value = isPlainObject(input) ? input : {};
  const opt = (name: string, pattern: RegExp): string | null =>
    value[name] === undefined || value[name] === null
      ? null
      : requireKey(value[name], name, pattern);
  const executionRef = optionalString(value.executionRef, 'executionRef', 255);
  const accountRef = optionalString(value.accountRef, 'accountRef', 255);
  const since = optionalIsoInstant(value.since, 'since');
  const until = optionalIsoInstant(value.until, 'until');
  if (since !== null && until !== null && Date.parse(until) <= Date.parse(since)) {
    invalidQuery('until must be after since when both are provided');
  }
  const limit = requirePositiveInteger(value.limit, 'limit', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  return {
    gateway: opt('gateway', KEY_PATTERN),
    provider: opt('provider', KEY_PATTERN),
    capability: opt('capability', CAPABILITY_PATTERN),
    executionRef,
    accountRef,
    since,
    until,
    limit,
  };
}

export interface ValidatedUsageSummaryQuery {
  gateway: string | null;
  provider: string | null;
  capability: string | null;
  since: string | null;
  until: string | null;
}

export function validateUsageSummaryQuery(input: unknown): ValidatedUsageSummaryQuery {
  const listed = validateListUsageQuery(input);
  return {
    gateway: listed.gateway,
    provider: listed.provider,
    capability: listed.capability,
    since: listed.since,
    until: listed.until,
  };
}

export interface ValidatedUsageRecordQuery {
  usageId: string;
}

export function validateUsageRecordQuery(input: unknown): ValidatedUsageRecordQuery {
  const value = requireObject(input, 'usage record query');
  if (!isUuid(value.usageId)) invalidQuery('usageId must be a uuid');
  return { usageId: value.usageId };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface ValidatedSetBudgetInput {
  scope: BudgetScope;
  gateway: string | null;
  provider: string | null;
  capability: string | null;
  budgetMinor: number;
  enforcement: 'block' | 'observe';
  note: string | null;
}

export function validateSetBudgetInput(input: unknown): ValidatedSetBudgetInput {
  const value = requireObject(input, 'setProviderBudget input');
  if (!isBudgetScope(value.scope)) {
    invalid("scope must be one of 'tenant', 'gateway', 'provider', 'capability'");
  }
  const gateway =
    value.gateway === undefined || value.gateway === null ? null : requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const provider =
    value.provider === undefined || value.provider === null
      ? null
      : requireKey(value.provider, 'provider', KEY_PATTERN);
  const capability =
    value.capability === undefined || value.capability === null
      ? null
      : requireKey(value.capability, 'capability', CAPABILITY_PATTERN);
  const budgetMinor = requireNonNegativeInteger(value.budgetMinor, 'budgetMinor', MAX_BUDGET_MINOR);
  if (value.enforcement !== 'block' && value.enforcement !== 'observe') {
    invalid("enforcement must be 'block' or 'observe'");
  }
  const note = optionalString(value.note, 'note', MAX_NOTE_LENGTH);
  // Scope-shape consistency: a row must carry exactly its scope's columns.
  if (value.scope === 'tenant' && (gateway !== null || provider !== null || capability !== null)) {
    invalid("a 'tenant' budget must not carry gateway/provider/capability");
  }
  if (value.scope === 'gateway' && (gateway === null || provider !== null || capability !== null)) {
    invalid("a 'gateway' budget requires gateway and must not carry provider/capability");
  }
  if (value.scope === 'provider' && (gateway === null || provider === null || capability !== null)) {
    invalid("a 'provider' budget requires gateway and provider and must not carry capability");
  }
  if (value.scope === 'capability' && (gateway === null || provider === null || capability === null)) {
    invalid("a 'capability' budget requires gateway, provider and capability");
  }
  return { scope: value.scope, gateway, provider, capability, budgetMinor, enforcement: value.enforcement, note };
}

export interface ValidatedListBudgetsQuery {
  status: 'active' | 'retired' | null;
  gateway: string | null;
  limit: number;
}

export function validateListBudgetsQuery(input: unknown): ValidatedListBudgetsQuery {
  const value = isPlainObject(input) ? input : {};
  const status =
    value.status === undefined || value.status === null
      ? null
      : value.status === 'active' || value.status === 'retired'
        ? value.status
        : invalidQuery("status must be 'active' or 'retired' when provided");
  const gateway =
    value.gateway === undefined || value.gateway === null
      ? null
      : requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const limit = requirePositiveInteger(value.limit, 'limit', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  return { status, gateway, limit };
}

export interface ValidatedEnforceBudgetInput {
  gateway: string;
  provider: string;
  capability: string;
  projectedCostMinor: number;
}

export function validateEnforceBudgetInput(input: unknown): ValidatedEnforceBudgetInput {
  const value = requireObject(input, 'enforceProviderBudget input');
  const gateway = requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const provider = requireKey(value.provider, 'provider', KEY_PATTERN);
  const capability = requireKey(value.capability, 'capability', CAPABILITY_PATTERN);
  const projectedCostMinor = requireNonNegativeInteger(
    value.projectedCostMinor,
    'projectedCostMinor',
    MAX_COST_MINOR,
  );
  return { gateway, provider, capability, projectedCostMinor };
}

export interface ValidatedRouteCandidate {
  gateway: string;
  provider: string;
  capability: string;
  projectedCostMinor: number;
}

export function validateRouteCandidates(input: unknown): ValidatedRouteCandidate[] {
  if (!Array.isArray(input) || input.length === 0) {
    invalid('routeWithinBudget requires a non-empty array of candidates');
  }
  if (input.length > MAX_LIST_LIMIT) {
    invalid(`routeWithinBudget supports at most ${MAX_LIST_LIMIT} candidates`);
  }
  const seen = new Set<string>();
  return input.map((candidate, index) => {
    const value = requireObject(candidate, `candidates[${index}]`);
    const gateway = requireKey(value.gateway, `candidates[${index}].gateway`, KEY_PATTERN);
    const provider = requireKey(value.provider, `candidates[${index}].provider`, KEY_PATTERN);
    const capability = requireKey(value.capability, `candidates[${index}].capability`, CAPABILITY_PATTERN);
    const projectedCostMinor = requireNonNegativeInteger(
      value.projectedCostMinor,
      `candidates[${index}].projectedCostMinor`,
      MAX_COST_MINOR,
    );
    const key = `${gateway}:${provider}:${capability}`;
    if (seen.has(key)) invalid(`candidates must be unique (duplicate '${key}')`);
    seen.add(key);
    return { gateway, provider, capability, projectedCostMinor };
  });
}

export interface ValidatedListBudgetEventsQuery {
  budgetId: string | null;
  event: string | null;
  limit: number;
}

export function validateListBudgetEventsQuery(input: unknown): ValidatedListBudgetEventsQuery {
  const value = isPlainObject(input) ? input : {};
  const budgetId =
    value.budgetId === undefined || value.budgetId === null ? null : (isUuid(value.budgetId) ? value.budgetId : invalidQuery('budgetId must be a uuid when provided'));
  const event = optionalString(value.event, 'event', 64);
  const limit = requirePositiveInteger(value.limit, 'limit', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  return { budgetId, event, limit };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface ValidatedSettleInput {
  gateway: string;
  provider: string;
  windowFrom: string;
  windowTo: string;
  idempotencyKey: string | null;
}

export function validateSettleInput(input: unknown): ValidatedSettleInput {
  const value = requireObject(input, 'settleProviderUsage input');
  const gateway = requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const provider = requireKey(value.provider, 'provider', KEY_PATTERN);
  const windowFrom = requireIsoInstant(value.windowFrom, 'windowFrom');
  const windowTo = requireIsoInstant(value.windowTo, 'windowTo');
  if (Date.parse(windowTo) <= Date.parse(windowFrom)) {
    invalid('windowTo must be after windowFrom');
  }
  if (Date.parse(windowTo) - Date.parse(windowFrom) > MAX_WINDOW_SECONDS * 1000) {
    invalid(`a settlement window may span at most ${MAX_WINDOW_SECONDS} days`);
  }
  const idempotencyKey = optionalString(value.idempotencyKey, 'idempotencyKey', 200);
  return { gateway, provider, windowFrom, windowTo, idempotencyKey };
}

export interface ValidatedSettlementQuery {
  settlementId: string;
}

export function validateSettlementQuery(input: unknown): ValidatedSettlementQuery {
  const value = requireObject(input, 'settlement query');
  if (!isUuid(value.settlementId)) invalidQuery('settlementId must be a uuid');
  return { settlementId: value.settlementId };
}

export interface ValidatedListSettlementsQuery {
  gateway: string | null;
  provider: string | null;
  status: 'settling' | 'settled' | 'failed' | null;
  limit: number;
}

export function validateListSettlementsQuery(input: unknown): ValidatedListSettlementsQuery {
  const value = isPlainObject(input) ? input : {};
  const gateway =
    value.gateway === undefined || value.gateway === null
      ? null
      : requireKey(value.gateway, 'gateway', KEY_PATTERN);
  const provider =
    value.provider === undefined || value.provider === null
      ? null
      : requireKey(value.provider, 'provider', KEY_PATTERN);
  const status =
    value.status === undefined || value.status === null
      ? null
      : value.status === 'settling' || value.status === 'settled' || value.status === 'failed'
        ? value.status
        : invalidQuery("status must be 'settling', 'settled' or 'failed' when provided");
  const limit = requirePositiveInteger(value.limit, 'limit', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  return { gateway, provider, status, limit };
}

export interface ValidatedListSettlementEventsQuery {
  settlementId: string;
  limit: number;
}

export function validateListSettlementEventsQuery(input: unknown): ValidatedListSettlementEventsQuery {
  const value = requireObject(input, 'settlement events query');
  if (!isUuid(value.settlementId)) invalidQuery('settlementId must be a uuid');
  const limit = requirePositiveInteger(value.limit, 'limit', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  return { settlementId: value.settlementId, limit };
}

// ---------------------------------------------------------------------------
// The llm import bridge
// ---------------------------------------------------------------------------

export interface ValidatedImportLlmInput {
  limit: number;
}

export function validateImportLlmInput(input: unknown): ValidatedImportLlmInput {
  const value = isPlainObject(input) ? input : {};
  const limit = requirePositiveInteger(value.limit, 'limit', MAX_LLM_IMPORT_LIMIT, DEFAULT_LLM_IMPORT_LIMIT);
  return { limit };
}

// ---------------------------------------------------------------------------
// The settlement workflow bridge input
// ---------------------------------------------------------------------------

export interface ValidatedSettlementRunInput {
  windows: Array<{ gateway: string; provider: string; windowFrom: string; windowTo: string }>;
}

export function validateSettlementRunInput(input: unknown): ValidatedSettlementRunInput {
  const value = requireObject(input, 'settlement run input');
  if (!Array.isArray(value.windows) || value.windows.length === 0) {
    invalid('the settlement run input requires a non-empty windows array');
  }
  if (value.windows.length > MAX_SETTLEMENT_WINDOWS) {
    invalid(`a settlement run settles at most ${MAX_SETTLEMENT_WINDOWS} windows`);
  }
  const windows = value.windows.map((window, index) => {
    const entry = requireObject(window, `windows[${index}]`);
    const gateway = requireKey(entry.gateway, `windows[${index}].gateway`, KEY_PATTERN);
    const provider = requireKey(entry.provider, `windows[${index}].provider`, KEY_PATTERN);
    const windowFrom = requireIsoInstant(entry.windowFrom, `windows[${index}].windowFrom`);
    const windowTo = requireIsoInstant(entry.windowTo, `windows[${index}].windowTo`);
    if (Date.parse(windowTo) <= Date.parse(windowFrom)) {
      invalid(`windows[${index}].windowTo must be after windowFrom`);
    }
    if (Date.parse(windowTo) - Date.parse(windowFrom) > MAX_WINDOW_SECONDS * 1000) {
      invalid(`windows[${index}] may span at most ${MAX_WINDOW_SECONDS} days`);
    }
    return { gateway, provider, windowFrom, windowTo };
  });
  return { windows };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function validateBoolean(value: unknown, where: string): boolean {
  return requireBoolean(value, where);
}
