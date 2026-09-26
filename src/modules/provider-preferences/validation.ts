// Pure validation/normalization logic of the provider-preferences
// module (no database, no clock, no network). Everything a caller may
// put into this module's operations crosses these guards first; the
// SQL CHECK constraints in migrations/001 mirror the load-bearing rules
// as defense in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller
// can never smuggle `id`, `tenantId`, `principalId`, timestamps or
// provider identity into records — identity, tenancy and audit fields
// are minted by the system from the validated context.
//
// OPEN VOCABULARIES: `gateway`, `capability` and `provider` keys are
// SHAPE-checked only (the provider-billing discipline): the owning
// gateway's vocabulary is validated where it is known — this module
// never hard-codes a provider list, so no provider is privileged
// (lock 30) and wiring a new gateway requires no migration here.

import type { TenantContext } from '@/infra/tenant';
import type { DbRow } from '@/infra/db';
import { ProviderPreferencesError } from './errors';
import type {
  PersonalPreference,
  ProviderCandidate,
  ProviderPreferenceEventType,
  ProviderPreferenceOutcome,
  SelectionDecision,
  SelectionExplanationRecord,
  SelectionExplanationView,
  TenantPreference,
  TechnicalOverride,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const PROVIDER_PREFERENCE_OUTCOMES = [
  'cost',
  'privacy',
  'quality',
  'speed',
] as const;

export const PREFERENCE_SOURCES = [
  'organizational-policy',
  'tenant-priority',
  'personal-preference',
  'default',
] as const;

export const SELECTION_DECISIONS = [
  'technical-override',
  'preference',
  'single-choice',
  'no-choice',
] as const;

export const TECHNICAL_OVERRIDE_STATUSES = ['active', 'retired'] as const;

export const PROVIDER_PREFERENCE_EVENT_TYPES = [
  'tenant-preference-set',
  'personal-preference-set',
  'personal-preference-cleared',
  'override-set',
  'override-cleared',
] as const;

/**
 * The documented balanced default outcome order (see policy.ts — a
 * default, never a privilege; the first preference anyone sets
 * replaces it).
 */
export const DEFAULT_OUTCOME_PRIORITY: readonly ProviderPreferenceOutcome[] = [
  'quality',
  'speed',
  'cost',
  'privacy',
];

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_CANDIDATES = 16;
export const MAX_REASON_LENGTH = 2000;
export const MIN_REASON_LENGTH = 1;
export const MAX_EXPLANATION_LENGTH = 2000;
export const MAX_DEDUPE_KEY_LENGTH = 200;
export const MAX_ACCOUNT_REF_LENGTH = 255;
/** Outcome signal bounds (finite numbers; lower is better). */
export const MIN_OUTCOME_SIGNAL = -1_000_000_000_000;
export const MAX_OUTCOME_SIGNAL = 1_000_000_000_000;
/** Projected cost bounds (integer minor units; matches provider-billing). */
export const MAX_PROJECTED_COST_MINOR = 1_000_000_000_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEDUPE_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/;
const ACCOUNT_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,253})$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isProviderPreferenceOutcome(
  value: unknown,
): value is ProviderPreferenceOutcome {
  return (
    typeof value === 'string' &&
    (PROVIDER_PREFERENCE_OUTCOMES as readonly string[]).includes(value)
  );
}

export function isPreferenceSource(value: unknown): value is (typeof PREFERENCE_SOURCES)[number] {
  return (
    typeof value === 'string' && (PREFERENCE_SOURCES as readonly string[]).includes(value)
  );
}

export function isSelectionDecision(value: unknown): value is SelectionDecision {
  return (
    typeof value === 'string' && (SELECTION_DECISIONS as readonly string[]).includes(value)
  );
}

export function isTechnicalOverrideStatus(
  value: unknown,
): value is (typeof TECHNICAL_OVERRIDE_STATUSES)[number] {
  return (
    typeof value === 'string' &&
    (TECHNICAL_OVERRIDE_STATUSES as readonly string[]).includes(value)
  );
}

export function isProviderPreferenceEventType(
  value: unknown,
): value is ProviderPreferenceEventType {
  return (
    typeof value === 'string' &&
    (PROVIDER_PREFERENCE_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertProviderPreferencesTenantContext(ctx: TenantContext): TenantContext {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ProviderPreferencesError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ProviderPreferencesError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ProviderPreferencesError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
  return ctx;
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
      throw new ProviderPreferencesError(
        'invalid_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'${field}' must be a lowercase key (letters, digits, '.', '_', '-', 1..64 chars)`,
    );
  }
  return value;
}

function requireOptionalKey(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireKey(value, field);
}

function requireDedupeKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DEDUPE_KEY_PATTERN.test(value)) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'${field}' must be 2..200 chars: letters, digits, '.', '_', ':', '-'`,
    );
  }
  return value;
}

/** Validate an ordered outcome priority: 1..4 entries, vocabulary, no duplicates. */
function requireOutcomePriority(value: unknown, field: string): ProviderPreferenceOutcome[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PROVIDER_PREFERENCE_OUTCOMES.length) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'${field}' must be an ordered array of 1..${PROVIDER_PREFERENCE_OUTCOMES.length} outcomes`,
    );
  }
  const seen = new Set<string>();
  const out: ProviderPreferenceOutcome[] = [];
  for (const entry of value) {
    if (!isProviderPreferenceOutcome(entry)) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `'${field}' entry '${String(entry)}' is not one of: ${PROVIDER_PREFERENCE_OUTCOMES.join(', ')}`,
      );
    }
    if (seen.has(entry)) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `'${field}' lists '${entry}' twice — a priority orders each outcome exactly once`,
      );
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function requireLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new ProviderPreferencesError(
      'invalid_query',
      `'${field}' must be an integer between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Validated input shapes (exported for the service's narrow typing)
// ---------------------------------------------------------------------------

export interface ValidatedSetTenantPreferenceInput {
  outcomePriority: ProviderPreferenceOutcome[];
  policyFirst: boolean;
}

export interface ValidatedSetPersonalPreferenceInput {
  outcomePriority: ProviderPreferenceOutcome[];
}

export interface ValidatedSetOverrideInput {
  gateway: string;
  capability: string | null;
  provider: string;
  reason: string;
}

export interface ValidatedClearOverrideInput {
  gateway: string;
  capability: string | null;
}

export interface ValidatedResolveChoiceInput {
  gateway: string;
  capability: string;
  candidates: ProviderCandidate[];
  dedupeKey: string;
}

export interface ValidatedRecordExplanationInput {
  gateway: string;
  capability: string;
  chosenProvider: string | null;
  chosenAccountRef: string | null;
  decision: SelectionDecision;
  preferenceSource: (typeof PREFERENCE_SOURCES)[number];
  decidingOutcome: ProviderPreferenceOutcome | null;
  candidatesConsidered: number;
  budgetExcludedCount: number;
  overrideUnavailable: boolean;
  dedupeKey: string;
}

export interface ValidatedListExplanationsQuery {
  capability: string | null;
  limit: number;
}

export interface ValidatedGetExplanationQuery {
  explanationId: string;
}

export interface ValidatedListOverridesQuery {
  gateway: string | null;
  status: (typeof TECHNICAL_OVERRIDE_STATUSES)[number] | null;
  limit: number;
}

export interface ValidatedGetOverrideQuery {
  gateway: string;
  capability: string | null;
}

export interface ValidatedListEventsQuery {
  limit: number;
}

// ---------------------------------------------------------------------------
// Operation validators
// ---------------------------------------------------------------------------

export function validateSetTenantPreferenceInput(
  input: unknown,
): ValidatedSetTenantPreferenceInput {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(input, ['outcomePriority', 'policyFirst'], 'setTenantPreference');
  if (typeof input.policyFirst !== 'boolean') {
    throw new ProviderPreferencesError('invalid_input', "'policyFirst' must be a boolean");
  }
  return {
    outcomePriority: requireOutcomePriority(input.outcomePriority, 'outcomePriority'),
    policyFirst: input.policyFirst,
  };
}

export function validateSetPersonalPreferenceInput(
  input: unknown,
): ValidatedSetPersonalPreferenceInput {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(input, ['outcomePriority'], 'setPersonalPreference');
  return { outcomePriority: requireOutcomePriority(input.outcomePriority, 'outcomePriority') };
}

/** Canonical scope key of an override ('g' | 'g:c' — the provider-billing encoding). */
export function overrideScopeKey(gateway: string, capability: string | null): string {
  return capability === null ? `g:${gateway}` : `g:${gateway}:c:${capability}`;
}

export function validateSetTechnicalOverrideInput(
  input: unknown,
): ValidatedSetOverrideInput {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(
    input,
    ['gateway', 'capability', 'provider', 'reason'],
    'setTechnicalOverride',
  );
  const reason = input.reason;
  if (
    typeof reason !== 'string' ||
    reason.trim().length < MIN_REASON_LENGTH ||
    reason.length > MAX_REASON_LENGTH
  ) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'reason' must be 1..${MAX_REASON_LENGTH} chars of human language (why the override exists)`,
    );
  }
  return {
    gateway: requireKey(input.gateway, 'gateway'),
    capability: requireOptionalKey(input.capability, 'capability'),
    provider: requireKey(input.provider, 'provider'),
    reason: reason.trim(),
  };
}

export function validateClearTechnicalOverrideInput(
  input: unknown,
): ValidatedClearOverrideInput {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(input, ['gateway', 'capability'], 'clearTechnicalOverride');
  return {
    gateway: requireKey(input.gateway, 'gateway'),
    capability: requireOptionalKey(input.capability, 'capability'),
  };
}

function validateCandidate(
  value: unknown,
  position: number,
  knownProviders: Set<string>,
): ProviderCandidate {
  const where = `candidates[${position}]`;
  if (!isPlainObject(value)) {
    throw new ProviderPreferencesError('invalid_input', `${where} must be an object`);
  }
  rejectUnknownKeys(value, ['provider', 'accountRef', 'projectedCostMinor', 'outcomes'], where);
  const provider = requireKey(value.provider, `${where}.provider`);
  if (knownProviders.has(provider)) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `${where}.provider '${provider}' appears twice — one candidate per provider`,
    );
  }
  knownProviders.add(provider);
  let accountRef: string | null = null;
  if (value.accountRef !== undefined && value.accountRef !== null) {
    if (
      typeof value.accountRef !== 'string' ||
      !ACCOUNT_REF_PATTERN.test(value.accountRef)
    ) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `${where}.accountRef must be 1..${MAX_ACCOUNT_REF_LENGTH} chars of opaque reference`,
      );
    }
    accountRef = value.accountRef;
  }
  let projectedCostMinor: number | null = null;
  if (value.projectedCostMinor !== undefined && value.projectedCostMinor !== null) {
    if (
      typeof value.projectedCostMinor !== 'number' ||
      !Number.isInteger(value.projectedCostMinor) ||
      value.projectedCostMinor < 0 ||
      value.projectedCostMinor > MAX_PROJECTED_COST_MINOR
    ) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `${where}.projectedCostMinor must be an integer in minor units (0..${MAX_PROJECTED_COST_MINOR})`,
      );
    }
    projectedCostMinor = value.projectedCostMinor;
  }
  if (!isPlainObject(value.outcomes)) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `${where}.outcomes must be an object of outcome signals (lower is better)`,
    );
  }
  rejectUnknownKeys(value.outcomes, PROVIDER_PREFERENCE_OUTCOMES as unknown as string[], `${where}.outcomes`);
  const outcomes: Partial<Record<ProviderPreferenceOutcome, number>> = {};
  for (const [outcome, signal] of Object.entries(value.outcomes)) {
    if (
      typeof signal !== 'number' ||
      !Number.isFinite(signal) ||
      signal < MIN_OUTCOME_SIGNAL ||
      signal > MAX_OUTCOME_SIGNAL
    ) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `${where}.outcomes.${outcome} must be a finite number (${MIN_OUTCOME_SIGNAL}..${MAX_OUTCOME_SIGNAL}; lower is better)`,
      );
    }
    outcomes[outcome as ProviderPreferenceOutcome] = signal;
  }
  return { provider, accountRef, projectedCostMinor, outcomes };
}

export function validateResolveProviderChoiceInput(
  input: unknown,
): ValidatedResolveChoiceInput {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(
    input,
    ['gateway', 'capability', 'candidates', 'dedupeKey'],
    'resolveProviderChoice',
  );
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'candidates' must be an array of at most ${MAX_CANDIDATES} options`,
    );
  }
  const knownProviders = new Set<string>();
  const candidates = input.candidates.map((candidate, position) =>
    validateCandidate(candidate, position, knownProviders),
  );
  return {
    gateway: requireKey(input.gateway, 'gateway'),
    capability: requireKey(input.capability, 'capability'),
    candidates,
    dedupeKey: requireDedupeKey(input.dedupeKey, 'dedupeKey'),
  };
}

export function validateRecordSelectionExplanationInput(
  input: unknown,
): ValidatedRecordExplanationInput {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(
    input,
    [
      'gateway',
      'capability',
      'chosenProvider',
      'chosenAccountRef',
      'decision',
      'preferenceSource',
      'decidingOutcome',
      'candidatesConsidered',
      'budgetExcludedCount',
      'overrideUnavailable',
      'dedupeKey',
    ],
    'recordSelectionExplanation',
  );
  if (!isSelectionDecision(input.decision)) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'decision' must be one of: ${SELECTION_DECISIONS.join(', ')}`,
    );
  }
  if (!isPreferenceSource(input.preferenceSource)) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'preferenceSource' must be one of: ${PREFERENCE_SOURCES.join(', ')}`,
    );
  }
  if (input.decision === 'no-choice' && input.chosenProvider != null) {
    throw new ProviderPreferencesError(
      'invalid_input',
      "a 'no-choice' decision records that NOTHING was chosen — chosenProvider must be null",
    );
  }
  if (input.decision !== 'no-choice' && typeof input.chosenProvider !== 'string') {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'chosenProvider' is required for a '${input.decision}' decision`,
    );
  }
  let decidingOutcome: ProviderPreferenceOutcome | null = null;
  if (input.decidingOutcome !== undefined && input.decidingOutcome !== null) {
    if (!isProviderPreferenceOutcome(input.decidingOutcome)) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `'decidingOutcome' must be one of: ${PROVIDER_PREFERENCE_OUTCOMES.join(', ')}`,
      );
    }
    decidingOutcome = input.decidingOutcome;
  }
  if (
    typeof input.candidatesConsidered !== 'number' ||
    !Number.isInteger(input.candidatesConsidered) ||
    input.candidatesConsidered < 0 ||
    input.candidatesConsidered > MAX_CANDIDATES
  ) {
    throw new ProviderPreferencesError(
      'invalid_input',
      `'candidatesConsidered' must be an integer (0..${MAX_CANDIDATES})`,
    );
  }
  let budgetExcludedCount = 0;
  if (input.budgetExcludedCount !== undefined && input.budgetExcludedCount !== null) {
    if (
      typeof input.budgetExcludedCount !== 'number' ||
      !Number.isInteger(input.budgetExcludedCount) ||
      input.budgetExcludedCount < 0 ||
      input.budgetExcludedCount > MAX_CANDIDATES
    ) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `'budgetExcludedCount' must be an integer (0..${MAX_CANDIDATES})`,
      );
    }
    budgetExcludedCount = input.budgetExcludedCount;
  }
  let chosenAccountRef: string | null = null;
  if (input.chosenAccountRef !== undefined && input.chosenAccountRef !== null) {
    if (
      typeof input.chosenAccountRef !== 'string' ||
      !ACCOUNT_REF_PATTERN.test(input.chosenAccountRef)
    ) {
      throw new ProviderPreferencesError(
        'invalid_input',
        `'chosenAccountRef' must be 1..${MAX_ACCOUNT_REF_LENGTH} chars of opaque reference`,
      );
    }
    chosenAccountRef = input.chosenAccountRef;
  }
  return {
    gateway: requireKey(input.gateway, 'gateway'),
    capability: requireKey(input.capability, 'capability'),
    chosenProvider:
      input.chosenProvider === undefined || input.chosenProvider === null
        ? null
        : requireKey(input.chosenProvider, 'chosenProvider'),
    chosenAccountRef,
    decision: input.decision,
    preferenceSource: input.preferenceSource,
    decidingOutcome,
    candidatesConsidered: input.candidatesConsidered,
    budgetExcludedCount,
    overrideUnavailable:
      input.overrideUnavailable === undefined ? false : input.overrideUnavailable === true,
    dedupeKey: requireDedupeKey(input.dedupeKey, 'dedupeKey'),
  };
}

// ---------------------------------------------------------------------------
// Query validators
// ---------------------------------------------------------------------------

export function validateListSelectionExplanationsQuery(
  input: unknown,
): ValidatedListExplanationsQuery {
  if (input === undefined || input === null) {
    return { capability: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(input, ['capability', 'limit'], 'listSelectionExplanations');
  return {
    capability: requireOptionalKey(input.capability, 'capability'),
    limit: requireLimit(input.limit, 'limit'),
  };
}

export function validateGetSelectionExplanationQuery(
  input: unknown,
): ValidatedGetExplanationQuery {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(input, ['explanationId'], 'getSelectionExplanation');
  if (!isUuid(input.explanationId)) {
    throw new ProviderPreferencesError('invalid_query', "'explanationId' must be a uuid");
  }
  return { explanationId: input.explanationId };
}

export function validateListTechnicalOverridesQuery(
  input: unknown,
): ValidatedListOverridesQuery {
  if (input === undefined || input === null) {
    return { gateway: null, status: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(input, ['gateway', 'status', 'limit'], 'listTechnicalOverrides');
  let status: (typeof TECHNICAL_OVERRIDE_STATUSES)[number] | null = null;
  if (input.status !== undefined && input.status !== null) {
    if (!isTechnicalOverrideStatus(input.status)) {
      throw new ProviderPreferencesError(
        'invalid_query',
        `'status' must be one of: ${TECHNICAL_OVERRIDE_STATUSES.join(', ')}`,
      );
    }
    status = input.status;
  }
  return {
    gateway: requireOptionalKey(input.gateway, 'gateway'),
    status,
    limit: requireLimit(input.limit, 'limit'),
  };
}

export function validateGetTechnicalOverrideQuery(
  input: unknown,
): ValidatedGetOverrideQuery {
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(input, ['gateway', 'capability'], 'getTechnicalOverride');
  return {
    gateway: requireKey(input.gateway, 'gateway'),
    capability: requireOptionalKey(input.capability, 'capability'),
  };
}

export function validateListProviderPreferenceEventsQuery(
  input: unknown,
): ValidatedListEventsQuery {
  if (input === undefined || input === null) {
    return { limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(input)) {
    throw new ProviderPreferencesError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(input, ['limit'], 'listProviderPreferenceEvents');
  return { limit: requireLimit(input.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Row mappers (snake_case rows → domain shapes; pure)
// ---------------------------------------------------------------------------

function outcomePriorityFromJsonb(value: unknown): ProviderPreferenceOutcome[] {
  if (!Array.isArray(value)) return [...DEFAULT_OUTCOME_PRIORITY];
  const out = value.filter(isProviderPreferenceOutcome);
  return out.length === 0 ? [...DEFAULT_OUTCOME_PRIORITY] : out;
}

export function mapTenantPreferenceRow(row: {
  id: string;
  tenant_id: string;
  outcome_priority: unknown;
  policy_first: boolean;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}): TenantPreference {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    outcomePriority: outcomePriorityFromJsonb(row.outcome_priority),
    policyFirst: row.policy_first === true,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapPersonalPreferenceRow(row: {
  id: string;
  tenant_id: string;
  principal_id: string;
  outcome_priority: unknown;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}): PersonalPreference {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    outcomePriority: outcomePriorityFromJsonb(row.outcome_priority),
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapTechnicalOverrideRow(row: {
  id: string;
  tenant_id: string;
  gateway: string;
  capability: string | null;
  scope_key: string;
  provider: string;
  reason: string;
  status: string;
  set_by: string;
  set_at: Date | string;
  retired_by: string | null;
  retired_at: Date | string | null;
}): TechnicalOverride {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    gateway: row.gateway,
    capability: row.capability,
    scopeKey: row.scope_key,
    provider: row.provider,
    reason: row.reason,
    status: isTechnicalOverrideStatus(row.status) ? row.status : 'retired',
    setBy: row.set_by,
    setAt: toIso(row.set_at),
    retiredBy: row.retired_by,
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
  };
}

export interface ExplanationRow extends DbRow {
  id: string;
  tenant_id: string;
  gateway: string;
  capability: string;
  chosen_provider: string | null;
  chosen_account_ref: string | null;
  decision: string;
  preference_source: string;
  deciding_outcome: string | null;
  candidates_considered: number;
  budget_excluded_count: number;
  override_unavailable: boolean;
  explanation: string;
  dedupe_key: string;
  recorded_by: string;
  recorded_at: Date | string;
}

export function mapExplanationRow(row: ExplanationRow): SelectionExplanationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    gateway: row.gateway,
    capability: row.capability,
    chosenProvider: row.chosen_provider,
    chosenAccountRef: row.chosen_account_ref,
    decision: isSelectionDecision(row.decision) ? row.decision : 'preference',
    preferenceSource: isPreferenceSource(row.preference_source)
      ? row.preference_source
      : 'default',
    decidingOutcome: isProviderPreferenceOutcome(row.deciding_outcome)
      ? row.deciding_outcome
      : null,
    candidatesConsidered: row.candidates_considered,
    budgetExcludedCount: row.budget_excluded_count,
    overrideUnavailable: row.override_unavailable === true,
    explanation: row.explanation,
    occurredAt: toIso(row.recorded_at),
    recordedBy: row.recorded_by,
  };
}

export function mapExplanationRowToView(row: ExplanationRow): SelectionExplanationView {
  return {
    id: row.id,
    capability: row.capability,
    decision: isSelectionDecision(row.decision) ? row.decision : 'preference',
    preferenceSource: isPreferenceSource(row.preference_source)
      ? row.preference_source
      : 'default',
    decidingOutcome: isProviderPreferenceOutcome(row.deciding_outcome)
      ? row.deciding_outcome
      : null,
    candidatesConsidered: row.candidates_considered,
    budgetExcludedCount: row.budget_excluded_count,
    overrideUnavailable: row.override_unavailable === true,
    explanation: row.explanation,
    occurredAt: toIso(row.recorded_at),
  };
}

export function mapEventRow(row: {
  id: string;
  tenant_id: string;
  principal_id: string | null;
  position: number;
  event: string;
  detail: string;
  recorded_by: string;
  recorded_at: Date | string;
}): {
  id: string;
  tenantId: string;
  principalId: string | null;
  position: number;
  event: ProviderPreferenceEventType;
  detail: string;
  recordedBy: string;
  recordedAt: string;
} {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    position: row.position,
    event: isProviderPreferenceEventType(row.event) ? row.event : 'tenant-preference-set',
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
