// Pure validation/normalization logic of the briefings module (no
// database, no clock). Everything a caller may put into a briefing
// generation, a policy, or a query crosses these guards first; the SQL
// CHECK constraints in migrations/001 and /002 mirror the load-bearing
// rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `generatedAt`, `status` or `generatedBy` into a
// generation call — the briefing's identity, tenancy and commit time are
// minted by the system.
//
// Delivery-recipient coherence is enforced HERE and in the database: only
// the tenant-wide DEFAULT row (sectionKind null) may carry a delivery
// recipient — the briefing-level push configuration lives in exactly one
// addressable place.

import type { TenantContext } from '@/infra/tenant';
import { CHANNEL_PROVIDERS, isChannelProvider } from '@/modules/identity/contract';
import { BriefingsError } from './errors';
import {
  isBriefingSectionKind,
  isBriefingTriggerKind,
  BRIEFINGS_AUTHORITY_ADMINISTER,
  MAX_BRIEFING_WINDOW_SECONDS,
} from './policy';
import type {
  BriefingRecipient,
  BriefingTriggerKind,
  GetBriefingQuery,
  ResolvePolicyQuery,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (mirrored by the SQL CHECK constraints where load-bearing)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MIN_MAX_ITEMS = 1;
export const MAX_MAX_ITEMS = 50;
export const MIN_WINDOW_SECONDS = 60;
export const MAX_WINDOW_SECONDS = 2_592_000; // 30 days
/** Serialized `items` jsonb bound per section (defense in depth). */
export const MAX_SECTION_ITEMS_BYTES = 262_144; // 256 KiB

export const MAX_TRIGGER_LABEL_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with explicit offset (the goals module's pattern).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// Emitter-supplied keys — the actions module's idempotency-key pattern.
const EMITTER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
// Opaque provider-minted strings — printable, no control characters.
const PRINTABLE_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;

const GENERATE_KEYS = ['trigger', 'windowFrom', 'windowTo', 'idempotencyKey'] as const;
const TRIGGER_KEYS = ['kind', 'label'] as const;
const POLICY_KEYS = [
  'sectionKind',
  'enabled',
  'maxItems',
  'windowSeconds',
  'deliveryRecipient',
  'note',
] as const;
const RECIPIENT_KEYS = ['provider', 'providerAccountId', 'displayName'] as const;
const POLICY_SUBJECT_KEYS = ['sectionKind'] as const;
const POLICY_LIST_KEYS = ['limit'] as const;
const RESOLVE_POLICY_KEYS = ['sectionKind'] as const;
const GET_BRIEFING_KEYS = ['briefingId'] as const;
const LIST_BRIEFINGS_KEYS = ['triggerKind', 'windowFrom', 'windowTo', 'limit'] as const;

// ---------------------------------------------------------------------------
// Validated shapes (what the service layer receives)
// ---------------------------------------------------------------------------

export interface ValidatedPolicyInput {
  sectionKind: string | null;
  enabled: boolean;
  maxItems: number;
  windowSeconds: number;
  deliveryRecipient: BriefingRecipient | null;
  note: string | null;
}

export interface ValidatedGenerateInput {
  trigger: { kind: BriefingTriggerKind; label: string | null };
  windowFrom: string | null;
  windowTo: string | null;
  idempotencyKey: string | null;
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertBriefingsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new BriefingsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new BriefingsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new BriefingsError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** May these authority claims manage the tenant's briefing policies? */
export function canAdministerBriefingPolicies(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(BRIEFINGS_AUTHORITY_ADMINISTER);
}

/** Uuid shape guard. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
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

function inputError(message: string): BriefingsError {
  return new BriefingsError('invalid_briefing_input', message);
}

function policyInputError(message: string): BriefingsError {
  return new BriefingsError('invalid_policy_input', message);
}

function queryError(message: string): BriefingsError {
  return new BriefingsError('invalid_briefing_query', message);
}

function policyQueryError(message: string): BriefingsError {
  return new BriefingsError('invalid_policy_query', message);
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

function requireIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw policyInputError(`${field} must be an integer in [${min}, ${max}] (got ${String(value)})`);
  }
  return value;
}

/** Remaps the error code thrown by `fn` (shared guards throw input-flavored errors). */
function remapError<T>(fn: () => T, code: BriefingsError['code']): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof BriefingsError) {
      throw new BriefingsError(code, error.message);
    }
    throw error;
  }
}

function requireIsoInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw inputError(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${String(value)}')`,
    );
  }
  return value;
}

function optionalIsoInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field);
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw queryError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

// ---------------------------------------------------------------------------
// Delivery recipient (canonical channel party — ADR-0015)
// ---------------------------------------------------------------------------

/**
 * Validate a delivery recipient: a canonical channel party. Throws
 * `invalid_policy_input` (policy-shaped field) with the house messages.
 */
export function validateBriefingRecipient(
  value: unknown,
  where: string,
): BriefingRecipient {
  if (!isPlainObject(value)) {
    throw policyInputError(`${where} must be an object with provider, providerAccountId and optional displayName`);
  }
  rejectUnknownKeys(value, RECIPIENT_KEYS, where);
  const provider = value['provider'];
  if (!isChannelProvider(provider)) {
    throw policyInputError(
      `${where}.provider must be one of ${CHANNEL_PROVIDERS.join(', ')} (got '${String(provider)}')`,
    );
  }
  const accountId = value['providerAccountId'];
  if (typeof accountId !== 'string' || !PRINTABLE_ID_PATTERN.test(accountId)) {
    throw policyInputError(
      `${where}.providerAccountId must be 1..${MAX_PROVIDER_ACCOUNT_ID_LENGTH} printable characters without control characters`,
    );
  }
  const displayNameRaw = value['displayName'];
  let displayName: string | null = null;
  if (displayNameRaw !== undefined && displayNameRaw !== null) {
    if (typeof displayNameRaw !== 'string') {
      throw policyInputError(`${where}.displayName must be a string when present`);
    }
    const trimmed = displayNameRaw.trim();
    if (trimmed !== '') {
      if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
        throw policyInputError(
          `${where}.displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters (got ${trimmed.length})`,
        );
      }
      displayName = trimmed;
    }
  }
  return { provider, providerAccountId: accountId, displayName };
}

// ---------------------------------------------------------------------------
// Policy inputs and queries
// ---------------------------------------------------------------------------

/** Validate + normalize `setBriefingPolicy` input (upsert by kind key). */
export function validateSetBriefingPolicyInput(input: unknown): ValidatedPolicyInput {
  return remapError(() => validateSetBriefingPolicyInputInner(input), 'invalid_policy_input');
}

function validateSetBriefingPolicyInputInner(input: unknown): ValidatedPolicyInput {
  if (!isPlainObject(input)) {
    throw policyInputError('policy input must be an object');
  }
  rejectUnknownKeys(input, POLICY_KEYS, 'policy input');

  const sectionKindRaw = input['sectionKind'];
  let sectionKind: string | null = null;
  if (sectionKindRaw !== undefined && sectionKindRaw !== null) {
    if (!isBriefingSectionKind(sectionKindRaw)) {
      throw policyInputError(
        `sectionKind must be one of the briefing section kinds or null for the default row (got '${String(sectionKindRaw)}')`,
      );
    }
    sectionKind = sectionKindRaw;
  }

  const enabled = input['enabled'] === undefined ? true : requireBoolean(input['enabled']);

  const maxItems =
    input['maxItems'] === undefined ? 20 : requireIntInRange(input['maxItems'], 'maxItems', MIN_MAX_ITEMS, MAX_MAX_ITEMS);

  const windowSeconds =
    input['windowSeconds'] === undefined
      ? 86_400
      : requireIntInRange(input['windowSeconds'], 'windowSeconds', MIN_WINDOW_SECONDS, MAX_WINDOW_SECONDS);

  const recipientRaw = input['deliveryRecipient'];
  let deliveryRecipient: BriefingRecipient | null = null;
  if (recipientRaw !== undefined && recipientRaw !== null) {
    if (sectionKind !== null) {
      throw policyInputError(
        'deliveryRecipient is briefing-level configuration: it may only be set on the default row (sectionKind null)',
      );
    }
    deliveryRecipient = validateBriefingRecipient(recipientRaw, 'deliveryRecipient');
  }

  const noteRaw = optionalTrimmed(input['note'], 'note');
  if (noteRaw !== null && noteRaw.length > MAX_NOTE_LENGTH) {
    throw policyInputError(`note must be at most ${MAX_NOTE_LENGTH} characters (got ${noteRaw.length})`);
  }

  return { sectionKind, enabled, maxItems, windowSeconds, deliveryRecipient, note: noteRaw };
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw policyInputError(`enabled must be a boolean (got '${String(value)}')`);
  return value;
}

/** Validate `getBriefingPolicy`'s subject query (exact key; null = default row). */
export function validatePolicySubjectQuery(query: unknown): { sectionKind: string | null } {
  return remapError(() => validatePolicySubjectQueryInner(query), 'invalid_policy_query');
}

function validatePolicySubjectQueryInner(query: unknown): { sectionKind: string | null } {
  if (!isPlainObject(query)) {
    throw policyQueryError('policy subject query must be an object');
  }
  rejectUnknownKeys(query, POLICY_SUBJECT_KEYS, 'policy subject query');
  const raw = query['sectionKind'];
  if (raw === undefined || raw === null) return { sectionKind: null };
  if (!isBriefingSectionKind(raw)) {
    throw policyQueryError(
      `sectionKind must be one of the briefing section kinds or null for the default row (got '${String(raw)}')`,
    );
  }
  return { sectionKind: raw };
}

/** Validate `resolveBriefingPolicy`'s query (a section kind). */
export function validateResolvePolicyQuery(query: unknown): {
  sectionKind: Exclude<ResolvePolicyQuery['sectionKind'], undefined>;
} {
  return remapError(() => validateResolvePolicyQueryInner(query), 'invalid_policy_query');
}

function validateResolvePolicyQueryInner(query: unknown): {
  sectionKind: Exclude<ResolvePolicyQuery['sectionKind'], undefined>;
} {
  if (!isPlainObject(query)) {
    throw policyQueryError('resolve policy query must be an object');
  }
  rejectUnknownKeys(query, RESOLVE_POLICY_KEYS, 'resolve policy query');
  const raw = query['sectionKind'];
  if (!isBriefingSectionKind(raw)) {
    throw policyQueryError(
      `sectionKind must be one of the briefing section kinds (got '${String(raw)}')`,
    );
  }
  return { sectionKind: raw };
}

/** Validate `listBriefingPolicies`'s query. */
export function validateListBriefingPoliciesQuery(query: unknown): { limit: number } {
  return remapError(() => validateListBriefingPoliciesQueryInner(query), 'invalid_policy_query');
}

function validateListBriefingPoliciesQueryInner(query: unknown): { limit: number } {
  if (query === undefined || query === null) return { limit: DEFAULT_LIST_LIMIT };
  if (!isPlainObject(query)) {
    throw policyQueryError('policy list query must be an object');
  }
  rejectUnknownKeys(query, POLICY_LIST_KEYS, 'policy list query');
  const limit =
    query['limit'] === undefined
      ? DEFAULT_LIST_LIMIT
      : requireIntInRange(query['limit'], 'limit', 1, MAX_LIST_LIMIT);
  return { limit };
}

// ---------------------------------------------------------------------------
// Briefing generation input
// ---------------------------------------------------------------------------

/** Validate + normalize `generateBriefing`'s input. */
export function validateGenerateBriefingInput(input: unknown): ValidatedGenerateInput {
  if (input === undefined || input === null) input = {};
  if (!isPlainObject(input)) {
    throw inputError('generate input must be an object');
  }
  rejectUnknownKeys(input, GENERATE_KEYS, 'generate input');

  const triggerRaw = input['trigger'];
  let trigger: { kind: BriefingTriggerKind; label: string | null };
  if (triggerRaw === undefined || triggerRaw === null) {
    trigger = { kind: 'on_demand', label: null };
  } else {
    if (!isPlainObject(triggerRaw)) {
      throw inputError('trigger must be an object with kind and optional label');
    }
    rejectUnknownKeys(triggerRaw, TRIGGER_KEYS, 'trigger');
    const kind = triggerRaw['kind'] === undefined ? 'on_demand' : triggerRaw['kind'];
    if (!isBriefingTriggerKind(kind)) {
      throw inputError(
        `trigger.kind must be one of ${'on_demand, scheduled, system'} (got '${String(kind)}')`,
      );
    }
    const labelRaw = optionalTrimmed(triggerRaw['label'], 'trigger.label');
    if (labelRaw !== null && labelRaw.length > MAX_TRIGGER_LABEL_LENGTH) {
      throw inputError(
        `trigger.label must be at most ${MAX_TRIGGER_LABEL_LENGTH} characters (got ${labelRaw.length})`,
      );
    }
    trigger = { kind, label: labelRaw };
  }

  const windowFrom = optionalIsoInstant(input['windowFrom'], 'windowFrom');
  const windowTo = optionalIsoInstant(input['windowTo'], 'windowTo');
  if (windowFrom !== null && windowTo !== null) {
    const fromMs = Date.parse(windowFrom);
    const toMs = Date.parse(windowTo);
    if (fromMs >= toMs) {
      throw inputError('windowFrom must be strictly before windowTo');
    }
    if (toMs - fromMs > MAX_BRIEFING_WINDOW_SECONDS * 1_000) {
      throw inputError(
        `the briefing window must span at most ${MAX_BRIEFING_WINDOW_SECONDS} seconds (got ${(toMs - fromMs) / 1_000})`,
      );
    }
  }

  const keyRaw = optionalTrimmed(input['idempotencyKey'], 'idempotencyKey');
  if (keyRaw !== null) {
    if (keyRaw.length > MAX_IDEMPOTENCY_KEY_LENGTH || !EMITTER_KEY_PATTERN.test(keyRaw)) {
      throw inputError(
        `idempotencyKey must match ${EMITTER_KEY_PATTERN} (got '${keyRaw}')`,
      );
    }
  }

  return { trigger, windowFrom, windowTo, idempotencyKey: keyRaw };
}

// ---------------------------------------------------------------------------
// Briefing read queries
// ---------------------------------------------------------------------------

/** Validate `getBriefing`'s query. */
export function validateGetBriefingQuery(query: unknown): GetBriefingQuery {
  return remapError(() => validateGetBriefingQueryInner(query), 'invalid_briefing_query');
}

function validateGetBriefingQueryInner(query: unknown): GetBriefingQuery {
  if (!isPlainObject(query)) {
    throw queryError('get briefing query must be an object');
  }
  rejectUnknownKeys(query, GET_BRIEFING_KEYS, 'get briefing query');
  return { briefingId: requireUuid(query['briefingId'], 'briefingId') };
}

/** Validate + normalize `listBriefings`'s query. */
export function validateListBriefingsQuery(query: unknown): {
  triggerKind: BriefingTriggerKind | null;
  windowFrom: string | null;
  windowTo: string | null;
  limit: number;
} {
  return remapError(() => validateListBriefingsQueryInner(query), 'invalid_briefing_query');
}

function validateListBriefingsQueryInner(query: unknown): {
  triggerKind: BriefingTriggerKind | null;
  windowFrom: string | null;
  windowTo: string | null;
  limit: number;
} {
  if (query === undefined || query === null) {
    return { triggerKind: null, windowFrom: null, windowTo: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(query)) {
    throw queryError('list briefings query must be an object');
  }
  rejectUnknownKeys(query, LIST_BRIEFINGS_KEYS, 'list briefings query');

  const triggerRaw = query['triggerKind'];
  if (triggerRaw !== undefined && triggerRaw !== null && !isBriefingTriggerKind(triggerRaw)) {
    throw queryError(
      `triggerKind must be one of on_demand, scheduled, system (got '${String(triggerRaw)}')`,
    );
  }

  const windowFrom = optionalIsoInstant(query['windowFrom'], 'windowFrom');
  const windowTo = optionalIsoInstant(query['windowTo'], 'windowTo');

  const limit =
    query['limit'] === undefined
      ? DEFAULT_LIST_LIMIT
      : requireIntInRange(query['limit'], 'limit', 1, MAX_LIST_LIMIT);

  return {
    triggerKind: triggerRaw ?? null,
    windowFrom,
    windowTo,
    limit,
  };
}
