// Input validation of the provider-preferences module — the house pattern:
// a validate* function per public operation, returning fully-typed validated
// inputs, throwing ProviderPreferencesError('invalid_input' |
// 'invalid_query') otherwise. Pure: no DB, no clock.
//
// The technical-override validation mirrors the llm contract's own
// vocabulary constants (LLM_SCOPES / LLM_CAPABILITIES /
// DATA_CLASSIFICATIONS / MIN_PRIORITY / MAX_PRIORITY / MAX_BUDGET_MINOR) so
// this surface can never send the llm service an input its own validation
// would reject — the contract re-validates authoritatively either way.

import {
  DATA_CLASSIFICATIONS,
  LLM_CAPABILITIES,
  LLM_SCOPES,
  MAX_BUDGET_MINOR,
  MAX_PRIORITY,
  MIN_PRIORITY,
} from '@/modules/llm/contract';
import type {
  AiProviderAccountStatus,
  DataClassification,
  LlmCapability,
  LlmScope,
} from '@/modules/llm/contract';
import { ProviderPreferencesError } from './errors';
import type {
  PreferenceChangeEventKind,
  ProviderPreferenceKind,
} from './types';

// ---------------------------------------------------------------------------
// Shared vocabularies + limits
// ---------------------------------------------------------------------------

export const PREFERENCE_KINDS: readonly ProviderPreferenceKind[] = [
  'privacy-first',
  'lowest-cost',
  'fastest',
  'most-reliable',
  'balanced',
];

/** The honest default when a tenant has saved no choice. */
export const DEFAULT_PREFERENCE: ProviderPreferenceKind = 'balanced';

export const CHANGE_EVENT_KINDS: readonly PreferenceChangeEventKind[] = [
  'preference-saved',
  'preference-applied',
  'technical-override',
];

export const MAX_NOTE_LENGTH = 2000;
export const MAX_EVENT_SUMMARY_LENGTH = 2000;
export const MAX_BASIS_LENGTH = 500;
export const MAX_MAPPED_ACCOUNTS = 100;
export const DEFAULT_EVENT_LIMIT = 20;
export const MAX_EVENT_LIMIT = 500;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isProviderPreferenceKind(value: unknown): value is ProviderPreferenceKind {
  return (
    typeof value === 'string' &&
    (PREFERENCE_KINDS as readonly string[]).includes(value)
  );
}

export function isPreferenceChangeEventKind(
  value: unknown,
): value is PreferenceChangeEventKind {
  return (
    typeof value === 'string' &&
    (CHANGE_EVENT_KINDS as readonly string[]).includes(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function invalid(message: string): never {
  throw new ProviderPreferencesError('invalid_input', message);
}

function invalidQuery(message: string): never {
  throw new ProviderPreferencesError('invalid_query', message);
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(`${where} must be an object`);
  return value;
}

function optionalNote(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid(`${where} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') invalid(`${where} must not be blank`);
  if (trimmed.length > MAX_NOTE_LENGTH) {
    invalid(`${where} must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return trimmed;
}

function requirePositiveInteger(
  value: unknown,
  where: string,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    invalidQuery(`${where} must be an integer between 1 and ${max}`);
  }
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

export function assertProviderPreferencesTenantContext(
  ctx: unknown,
): ValidatedTenantContext {
  if (!isPlainObject(ctx)) {
    throw new ProviderPreferencesError(
      'invalid_context',
      'a TenantContext object is required',
    );
  }
  if (typeof ctx.tenantId !== 'string' || !isUuid(ctx.tenantId)) {
    throw new ProviderPreferencesError('invalid_context', 'ctx.tenantId must be a uuid');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ProviderPreferencesError(
      'invalid_context',
      'ctx.principalId must be a non-empty string',
    );
  }
  if (
    !Array.isArray(ctx.authority) ||
    ctx.authority.some((claim) => typeof claim !== 'string')
  ) {
    throw new ProviderPreferencesError(
      'invalid_context',
      'ctx.authority must be an array of strings',
    );
  }
  return {
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
    authority: ctx.authority,
  };
}

// ---------------------------------------------------------------------------
// Operation validators
// ---------------------------------------------------------------------------

export interface ValidatedSavePreferenceInput {
  preference: ProviderPreferenceKind;
  note: string | null;
}

export function validateSavePreferenceInput(
  input: unknown,
): ValidatedSavePreferenceInput {
  const value = requireObject(input, 'savePreferenceProfile input');
  if (!isProviderPreferenceKind(value.preference)) {
    invalid(
      `preference must be one of ${PREFERENCE_KINDS.map((kind) => `'${kind}'`).join(', ')}`,
    );
  }
  const note = optionalNote(value.note, 'note');
  return { preference: value.preference, note };
}

export interface ValidatedListChangeEventsQuery {
  limit: number;
}

export function validateListChangeEventsQuery(
  input: unknown,
): ValidatedListChangeEventsQuery {
  const value = isPlainObject(input) ? input : {};
  const limit = requirePositiveInteger(
    value.limit,
    'limit',
    MAX_EVENT_LIMIT,
    DEFAULT_EVENT_LIMIT,
  );
  return { limit };
}

export interface ValidatedExplainQuery {
  executionId: string | null;
}

export function validateExplainQuery(input: unknown): ValidatedExplainQuery {
  const value = isPlainObject(input) ? input : {};
  if (value.executionId === undefined || value.executionId === null) {
    return { executionId: null };
  }
  if (typeof value.executionId !== 'string' || !isUuid(value.executionId)) {
    invalidQuery('executionId must be a uuid when provided');
  }
  return { executionId: value.executionId };
}

export interface ValidatedTechnicalOverrideInput {
  accountId: string;
  priority: number | null;
  status: AiProviderAccountStatus | null;
  scopes: LlmScope[] | null;
  capabilities: LlmCapability[] | null;
  maxDataClassification: DataClassification | null;
  budgetMinor: number | null;
  budgetProvided: boolean;
}

function optionalVocabularyArray<T extends string>(
  value: unknown,
  where: string,
  vocabulary: readonly string[],
): T[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) invalid(`${where} must be an array`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !vocabulary.includes(entry)) {
      invalid(`${where} entries must be one of ${vocabulary.join(', ')}`);
    }
    if (seen.has(entry)) invalid(`${where} must not repeat '${entry}'`);
    seen.add(entry);
  }
  if (value.length === 0) invalid(`${where} must carry at least one entry`);
  return value as T[];
}

export function validateTechnicalOverrideInput(
  input: unknown,
): ValidatedTechnicalOverrideInput {
  const value = requireObject(input, 'updateProviderAccountControls input');
  if (!isUuid(value.accountId)) {
    invalid('accountId must be a uuid');
  }

  let priority: number | null = null;
  if (value.priority !== undefined && value.priority !== null) {
    if (
      typeof value.priority !== 'number' ||
      !Number.isInteger(value.priority) ||
      value.priority < MIN_PRIORITY ||
      value.priority > MAX_PRIORITY
    ) {
      invalid(`priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY}`);
    }
    priority = value.priority;
  }

  let status: AiProviderAccountStatus | null = null;
  if (value.status !== undefined && value.status !== null) {
    if (value.status !== 'active' && value.status !== 'disabled') {
      invalid("status must be 'active' or 'disabled'");
    }
    status = value.status;
  }

  const scopes = optionalVocabularyArray<LlmScope>(value.scopes, 'scopes', LLM_SCOPES);
  const capabilities = optionalVocabularyArray<LlmCapability>(
    value.capabilities,
    'capabilities',
    LLM_CAPABILITIES,
  );

  let maxDataClassification: DataClassification | null = null;
  if (
    value.maxDataClassification !== undefined &&
    value.maxDataClassification !== null
  ) {
    const classification = value.maxDataClassification;
    if (
      typeof classification !== 'string' ||
      !(DATA_CLASSIFICATIONS as readonly string[]).includes(classification)
    ) {
      invalid(
        `maxDataClassification must be one of ${DATA_CLASSIFICATIONS.join(', ')}`,
      );
    }
    maxDataClassification = classification as DataClassification;
  }

  let budgetMinor: number | null = null;
  let budgetProvided = false;
  if (value.budgetMinor !== undefined) {
    budgetProvided = true;
    if (value.budgetMinor !== null) {
      if (
        typeof value.budgetMinor !== 'number' ||
        !Number.isInteger(value.budgetMinor) ||
        value.budgetMinor < 1 ||
        value.budgetMinor > MAX_BUDGET_MINOR
      ) {
        invalid(`budgetMinor must be null or an integer between 1 and ${MAX_BUDGET_MINOR}`);
      }
      budgetMinor = value.budgetMinor;
    }
  }

  const carriesChange =
    priority !== null ||
    status !== null ||
    scopes !== null ||
    capabilities !== null ||
    maxDataClassification !== null ||
    budgetProvided;
  if (!carriesChange) {
    invalid(
      'the override must change at least one control (priority, status, scopes, capabilities, maxDataClassification, budgetMinor)',
    );
  }

  return {
    accountId: value.accountId,
    priority,
    status,
    scopes,
    capabilities,
    maxDataClassification,
    budgetMinor,
    budgetProvided,
  };
}
