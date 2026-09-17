// Pure validation/normalization logic of the environment module (no
// database). Everything a caller may put into a watchlist, a watch entry,
// a watch freshness policy, a signal or a query crosses these guards
// first; the SQL CHECK constraints in migrations/001 mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `status`, `createdBy`, `createdAt`, `updatedAt`,
// `recordedBy`, `recordedAt`, `observedAt` or `escalated` into a write —
// a watch's identity, tenancy, lifecycle minting and bookkeeping
// timestamps are the system's (the observations/world/freshness
// discipline). Update shapes likewise reject `kind`/`entityKind` — the
// watched SUBJECT is immutable identity: turning a competitor into a
// topic is a different watch (remove, re-add).

import type { TenantContext } from '@/infra/tenant';
import { EnvironmentError } from './errors';
import type {
  AddWatchEntryInput,
  CreateWatchlistInput,
  EscalateStaleWatchesQuery,
  EvaluateWatchFreshnessQuery,
  GetWatchEntryQuery,
  GetWatchEscalationQuery,
  GetWatchlistQuery,
  GetWatchSignalQuery,
  ListWatchEntriesQuery,
  ListWatchEscalationsQuery,
  ListWatchSignalsQuery,
  ListWatchlistsQuery,
  RecordWatchSignalInput,
  ResolveWatchFreshnessPolicyQuery,
  SetWatchEntryStatusInput,
  SetWatchFreshnessPolicyInput,
  SetWatchlistStatusInput,
  UpdateWatchEntryInput,
  UpdateWatchlistInput,
  WatchEntityKind,
  WatchEntryKind,
  WatchEntryStatus,
  WatchPartyKind,
  WatchSeverity,
  WatchlistStatus,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (frozen; TEXT + CHECK in storage, §8 conventions)
// ---------------------------------------------------------------------------

export const WATCHLIST_STATUSES = ['active', 'archived'] as const;
export const WATCH_ENTRY_KINDS = ['entity', 'topic', 'geography'] as const;
export const WATCH_ENTITY_KINDS = [
  'competitor',
  'regulator',
  'government_body',
  'supplier',
  'law',
  'technology',
  'market',
  'industry',
] as const;
export const WATCH_ENTRY_STATUSES = ['active', 'paused', 'archived'] as const;
export const WATCH_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const ESCALATION_TRIGGERS = ['signal', 'stale'] as const;
export const WATCH_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/**
 * The freshness subject kind under which watch stale-after policies live
 * (W006's shared subject-kind namespace — the freshness contract
 * anticipates "W014 its watch rules" here). Entry-specific policies key
 * on (this kind, entry id); the kind-wide default keys on (this kind,
 * null) and governs every entry without its own policy.
 */
export const WATCH_SUBJECT_KIND = 'environment.watch';

// ---------------------------------------------------------------------------
// Limits (mirrored by the storage CHECKs where shape-relevant)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_PUMP_LIMIT = 100;
export const MAX_PUMP_LIMIT = 500;
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_NOTE_LENGTH = 2_000;
export const MAX_SUMMARY_LENGTH = 2_000;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_NOTIFY_PARTIES = 8;
export const MAX_SCOPES = 16; // geographies[] / topics[] per entry
export const MAX_SCOPE_LENGTH = 64;
/** PostgreSQL `integer` bound — policy/grace seconds must fit the column. */
export const MAX_POLICY_SECONDS = 2_147_483_647;
/** Staleness grace is bounded to 30 days — a stale watch must re-demand attention within a month. */
export const MAX_STALE_GRACE_SECONDS = 2_592_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Canonical geography/topic slugs, e.g. `EU`, `US-CA`, `ai-regulation`. */
const SCOPE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Strict ISO 8601 with an explicit offset — evaluation instants are unambiguous (§8). */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const CREATE_WATCHLIST_KEYS = ['name', 'description', 'escalationPolicy'] as const;
const UPDATE_WATCHLIST_KEYS = ['watchlistId', 'name', 'description', 'escalationPolicy'] as const;
const SET_WATCHLIST_STATUS_KEYS = ['watchlistId', 'status'] as const;
const ADD_ENTRY_KEYS = [
  'watchlistId',
  'kind',
  'entityKind',
  'name',
  'description',
  'worldEntityId',
  'geographies',
  'topics',
  'escalationPolicy',
] as const;
const UPDATE_ENTRY_KEYS = [
  'watchEntryId',
  'name',
  'description',
  'worldEntityId',
  'geographies',
  'topics',
  'escalationPolicy',
] as const;
const SET_ENTRY_STATUS_KEYS = ['watchEntryId', 'status'] as const;
const RECORD_SIGNAL_KEYS = [
  'watchEntryId',
  'observationId',
  'severity',
  'note',
  'originExecutionId',
] as const;
const GET_WATCHLIST_KEYS = ['watchlistId'] as const;
const LIST_WATCHLISTS_KEYS = ['status', 'search', 'limit'] as const;
const GET_ENTRY_KEYS = ['watchEntryId'] as const;
const LIST_ENTRIES_KEYS = [
  'watchlistId',
  'kind',
  'entityKind',
  'status',
  'geography',
  'topic',
  'search',
  'limit',
] as const;
const GET_SIGNAL_KEYS = ['watchSignalId'] as const;
const LIST_SIGNALS_KEYS = ['watchEntryId', 'watchlistId', 'minSeverity', 'limit'] as const;
const GET_ESCALATION_KEYS = ['watchEscalationId'] as const;
const LIST_ESCALATIONS_KEYS = [
  'watchEntryId',
  'watchlistId',
  'trigger',
  'minSeverity',
  'limit',
] as const;
const SET_FRESHNESS_POLICY_KEYS = [
  'watchEntryId',
  'staleAfterSeconds',
  'agingAfterSeconds',
  'maxLatencySeconds',
  'note',
] as const;
const RESOLVE_FRESHNESS_POLICY_KEYS = ['watchEntryId'] as const;
const EVALUATE_FRESHNESS_KEYS = ['watchEntryId', 'asOf'] as const;
const PUMP_KEYS = ['watchlistId', 'limit'] as const;

const POLICY_KEYS = [
  'signalSeverityFloor',
  'staleGraceSeconds',
  'staleSeverity',
  'notifyParties',
  'proposeMission',
] as const;
const PARTY_KEYS = ['kind', 'id', 'label'] as const;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isWatchlistStatus(value: unknown): value is WatchlistStatus {
  return (
    typeof value === 'string' && (WATCHLIST_STATUSES as readonly string[]).includes(value)
  );
}

export function isWatchEntryKind(value: unknown): value is WatchEntryKind {
  return typeof value === 'string' && (WATCH_ENTRY_KINDS as readonly string[]).includes(value);
}

export function isWatchEntityKind(value: unknown): value is WatchEntityKind {
  return typeof value === 'string' && (WATCH_ENTITY_KINDS as readonly string[]).includes(value);
}

export function isWatchEntryStatus(value: unknown): value is WatchEntryStatus {
  return (
    typeof value === 'string' && (WATCH_ENTRY_STATUSES as readonly string[]).includes(value)
  );
}

export function isWatchSeverity(value: unknown): value is WatchSeverity {
  return typeof value === 'string' && (WATCH_SEVERITIES as readonly string[]).includes(value);
}

export function isEscalationTrigger(value: unknown): value is (typeof ESCALATION_TRIGGERS)[number] {
  return typeof value === 'string' && (ESCALATION_TRIGGERS as readonly string[]).includes(value);
}

export function isWatchPartyKind(value: unknown): value is WatchPartyKind {
  return typeof value === 'string' && (WATCH_PARTY_KINDS as readonly string[]).includes(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertEnvironmentTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new EnvironmentError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new EnvironmentError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new EnvironmentError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** Uuid shape guard; malformed ids surface as typed errors upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Escapes SQL LIKE metacharacters (callers use ILIKE ... ESCAPE '\'). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Shared string/array helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** True for control characters (incl. DEL) — rejected in names/descriptions. */
function hasControlCharacters(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new EnvironmentError(
        'invalid_watch_query',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalText(
  value: unknown,
  field: string,
  maxChars: number,
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (hasControlCharacters(text)) {
    throw inputError(`${field} must not contain control characters`);
  }
  if (text.length > maxChars) {
    throw inputError(`${field} must be at most ${maxChars} characters`);
  }
  return text === '' ? null : text;
}

function requireName(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (hasControlCharacters(text)) {
    throw inputError(`${field} must not contain control characters`);
  }
  if (text.length > MAX_NAME_LENGTH) {
    throw inputError(`${field} must be at most ${MAX_NAME_LENGTH} characters`);
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

function requireIsoInstant(value: unknown, field: string): Date {
  const text = requireString(value, field);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new EnvironmentError(
      'invalid_watch_query',
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${text}')`,
    );
  }
  return new Date(text);
}

/**
 * Canonicalizes a scope list (geographies/topics): validates each slug,
 * deduplicates and sorts — canonical storage makes containment filters and
 * snapshot comparisons deterministic.
 */
function requireScopeList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw inputError(`${field} must be an array of slugs`);
  if (value.length > MAX_SCOPES) {
    throw inputError(`${field} must hold at most ${MAX_SCOPES} slugs`);
  }
  const slugs: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw inputError(`${field} entries must be strings`);
    const slug = entry.trim();
    if (slug === '' || slug.length > MAX_SCOPE_LENGTH || !SCOPE_SLUG_PATTERN.test(slug)) {
      throw inputError(
        `${field} entries must be canonical slugs matching ${SCOPE_SLUG_PATTERN.source} (got '${slug}')`,
      );
    }
    slugs.push(slug);
  }
  return [...new Set(slugs)].sort();
}

function requireLimit(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
  error: (message: string) => EnvironmentError,
): number {
  const limit = value === undefined ? fallback : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > max) {
    throw error(`${field} must be an integer in [1, ${max}] (got ${String(limit)})`);
  }
  return limit;
}

function inputError(message: string): EnvironmentError {
  return new EnvironmentError('invalid_watchlist_input', message);
}

function entryInputError(message: string): EnvironmentError {
  return new EnvironmentError('invalid_watch_entry_input', message);
}

function signalError(message: string): EnvironmentError {
  return new EnvironmentError('invalid_signal_input', message);
}

function queryError(message: string): EnvironmentError {
  return new EnvironmentError('invalid_watch_query', message);
}

function policyError(message: string): EnvironmentError {
  return new EnvironmentError('invalid_policy_input', message);
}

/** Re-labels an input-shaped error with the escalation-policy code context. */
function withEntryCode(error: EnvironmentError): EnvironmentError {
  if (error.code === 'invalid_watchlist_input') {
    return new EnvironmentError('invalid_watch_entry_input', error.message);
  }
  return error;
}

// ---------------------------------------------------------------------------
// Escalation policy
// ---------------------------------------------------------------------------

/** Fully validated form of one notify party. */
export interface ValidatedParty {
  kind: WatchPartyKind;
  id: string | null;
  label: string | null;
}

/** Fully validated form of `WatchEscalationPolicyInput`. */
export interface ValidatedEscalationPolicy {
  signalSeverityFloor: WatchSeverity;
  staleGraceSeconds: number | null;
  staleSeverity: WatchSeverity | null;
  notifyParties: ValidatedParty[];
  proposeMission: boolean;
}

function validateParty(value: unknown, field: string): ValidatedParty {
  if (!isPlainObject(value)) throw inputError(`${field} must be an object`);
  rejectUnknownKeys(value, PARTY_KEYS, field);
  const kind = value.kind;
  if (!isWatchPartyKind(kind)) {
    throw inputError(
      `${field}.kind must be one of ${WATCH_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id =
    value.id === undefined || value.id === null ? null : requireUuid(value.id, `${field}.id`);
  const label =
    value.label === undefined || value.label === null
      ? null
      : (() => {
          const text = requireString(value.label, `${field}.label`);
          if (text.length > MAX_PARTY_LABEL_LENGTH) {
            throw inputError(`${field}.label must be at most ${MAX_PARTY_LABEL_LENGTH} characters`);
          }
          return text;
        })();
  if (id === null && label === null) {
    throw inputError(`${field} must carry an id and/or a label — the audience must be traceable`);
  }
  return { kind, id, label };
}

/** Validates one escalation policy (full snapshot; identical on write and read). */
export function validateEscalationPolicy(
  value: unknown,
  error: (message: string) => EnvironmentError,
): ValidatedEscalationPolicy {
  if (!isPlainObject(value)) throw error('escalationPolicy must be an object');
  rejectUnknownKeysWith(value, POLICY_KEYS, 'escalationPolicy', error);
  const signalSeverityFloor = value.signalSeverityFloor;
  if (!isWatchSeverity(signalSeverityFloor)) {
    throw error(
      `escalationPolicy.signalSeverityFloor must be one of ${WATCH_SEVERITIES.join(', ')} (got '${String(signalSeverityFloor)}')`,
    );
  }
  const staleGraceSeconds =
    value.staleGraceSeconds === undefined || value.staleGraceSeconds === null
      ? null
      : requirePositiveSeconds(value.staleGraceSeconds, 'escalationPolicy.staleGraceSeconds', error, MAX_STALE_GRACE_SECONDS);
  let staleSeverity: WatchSeverity | null = null;
  if (value.staleSeverity !== undefined && value.staleSeverity !== null) {
    if (!isWatchSeverity(value.staleSeverity)) {
      throw error(
        `escalationPolicy.staleSeverity must be one of ${WATCH_SEVERITIES.join(', ')} (got '${String(value.staleSeverity)}')`,
      );
    }
    staleSeverity = value.staleSeverity;
  }
  // Coherence (the notifications module's escalation-coherence rule): the
  // staleness arm carries both its grace and its severity, or neither.
  if (staleGraceSeconds === null && staleSeverity !== null) {
    throw error(
      'escalationPolicy.staleSeverity must be null when staleGraceSeconds is null (disarmed staleness arm carries no inert configuration)',
    );
  }
  if (staleGraceSeconds !== null && staleSeverity === null) {
    throw error(
      'escalationPolicy.staleSeverity is required when staleGraceSeconds is set (an armed staleness arm must declare its severity)',
    );
  }
  const parties = value.notifyParties;
  if (!Array.isArray(parties) || parties.length < 1) {
    throw error('escalationPolicy.notifyParties must be a non-empty array of parties');
  }
  if (parties.length > MAX_NOTIFY_PARTIES) {
    throw error(`escalationPolicy.notifyParties must hold at most ${MAX_NOTIFY_PARTIES} parties`);
  }
  const notifyParties = parties.map((party, index) =>
    validateParty(party, `escalationPolicy.notifyParties[${index}]`),
  );
  const proposeMission = value.proposeMission;
  if (typeof proposeMission !== 'boolean') {
    throw error(
      `escalationPolicy.proposeMission must be a boolean (got ${String(proposeMission)})`,
    );
  }
  return { signalSeverityFloor, staleGraceSeconds, staleSeverity, notifyParties, proposeMission };
}

function requirePositiveSeconds(
  value: unknown,
  field: string,
  error: (message: string) => EnvironmentError,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw error(`${field} must be a positive integer of seconds (got ${String(value)})`);
  }
  if (value > max) {
    throw error(`${field} must not exceed ${max} seconds`);
  }
  return value;
}

function rejectUnknownKeysWith(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  error: (message: string) => EnvironmentError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw error(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

/** Fully validated form of `CreateWatchlistInput`. */
export interface ValidatedCreateWatchlistInput {
  name: string;
  description: string | null;
  escalationPolicy: ValidatedEscalationPolicy;
}

export function validateCreateWatchlistInput(
  input: CreateWatchlistInput,
): ValidatedCreateWatchlistInput {
  if (!isPlainObject(input)) throw inputError('input must be an object');
  rejectUnknownKeysWith(input, CREATE_WATCHLIST_KEYS, 'the input', inputError);
  const name = requireName(input.name, 'name');
  const description = optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  const escalationPolicy = validateEscalationPolicy(input.escalationPolicy, inputError);
  return { name, description, escalationPolicy };
}

/** Fully validated form of `UpdateWatchlistInput`. */
export interface ValidatedUpdateWatchlistInput {
  watchlistId: string;
  name: string | null;
  setDescription: boolean;
  description: string | null;
  setEscalationPolicy: boolean;
  escalationPolicy: ValidatedEscalationPolicy | null;
}

export function validateUpdateWatchlistInput(
  input: UpdateWatchlistInput,
): ValidatedUpdateWatchlistInput {
  if (!isPlainObject(input)) throw inputError('input must be an object');
  rejectUnknownKeysWith(input, UPDATE_WATCHLIST_KEYS, 'the input', inputError);
  const watchlistId = requireUuid(input.watchlistId, 'watchlistId');
  const name = input.name === undefined ? null : requireName(input.name, 'name');
  const setDescription = input.description !== undefined;
  const description = setDescription
    ? optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH)
    : null;
  const setEscalationPolicy = input.escalationPolicy !== undefined;
  const escalationPolicy = setEscalationPolicy
    ? validateEscalationPolicy(input.escalationPolicy, inputError)
    : null;
  if (name === null && !setDescription && !setEscalationPolicy) {
    throw inputError('nothing to update — provide name, description or escalationPolicy');
  }
  return { watchlistId, name, setDescription, description, setEscalationPolicy, escalationPolicy };
}

/** Fully validated form of `SetWatchlistStatusInput`. */
export interface ValidatedSetWatchlistStatusInput {
  watchlistId: string;
  status: WatchlistStatus;
}

export function validateSetWatchlistStatusInput(
  input: SetWatchlistStatusInput,
): ValidatedSetWatchlistStatusInput {
  if (!isPlainObject(input)) throw inputError('input must be an object');
  rejectUnknownKeysWith(input, SET_WATCHLIST_STATUS_KEYS, 'the input', inputError);
  const watchlistId = requireUuid(input.watchlistId, 'watchlistId');
  if (!isWatchlistStatus(input.status)) {
    throw inputError(
      `status must be one of ${WATCHLIST_STATUSES.join(', ')} (got '${String(input.status)}')`,
    );
  }
  return { watchlistId, status: input.status };
}

// ---------------------------------------------------------------------------
// Watch entries
// ---------------------------------------------------------------------------

/** Fully validated form of `AddWatchEntryInput`. */
export interface ValidatedAddWatchEntryInput {
  watchlistId: string;
  kind: WatchEntryKind;
  entityKind: WatchEntityKind | null;
  name: string;
  description: string | null;
  worldEntityId: string | null;
  geographies: string[];
  topics: string[];
  escalationPolicy: ValidatedEscalationPolicy | null;
}

export function validateAddWatchEntryInput(input: AddWatchEntryInput): ValidatedAddWatchEntryInput {
  if (!isPlainObject(input)) throw entryInputError('input must be an object');
  // String guards below throw the watchlist code by default (shared
  // helpers); entry inputs re-label everything to their own code.
  try {
    return validateAddWatchEntryBody(input);
  } catch (error) {
    if (error instanceof EnvironmentError) throw withEntryCode(error);
    throw error;
  }
}

function validateAddWatchEntryBody(input: Record<string, unknown>): ValidatedAddWatchEntryInput {
  rejectUnknownKeysWith(input, ADD_ENTRY_KEYS, 'the input', entryInputError);
  const watchlistId = requireUuid(input.watchlistId, 'watchlistId');
  const kind = input.kind;
  if (!isWatchEntryKind(kind)) {
    throw entryInputError(
      `kind must be one of ${WATCH_ENTRY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  // Identity coherence: an entity entry names its §12 entity kind; topic
  // and geography entries must not carry one (a topic is not a competitor).
  if (kind === 'entity') {
    if (!isWatchEntityKind(input.entityKind)) {
      throw entryInputError(
        `entityKind is required for entity entries and must be one of ${WATCH_ENTITY_KINDS.join(', ')} (got '${String(input.entityKind)}')`,
      );
    }
  } else if (input.entityKind !== undefined && input.entityKind !== null) {
    throw entryInputError(
      `entityKind is forbidden for ${kind} entries (only entity entries carry an entityKind)`,
    );
  }
  const name = requireName(input.name, 'name');
  const description = optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  const worldEntityId =
    input.worldEntityId === undefined || input.worldEntityId === null
      ? null
      : requireUuid(input.worldEntityId, 'worldEntityId');
  const geographies = requireScopeList(input.geographies, 'geographies');
  // A geography entry IS the geography — scoping it by further geographies
  // is redundant configuration, rejected here and by a storage CHECK.
  if (kind === 'geography' && geographies.length > 0) {
    throw entryInputError(
      'geographies must be empty for geography entries (the entry itself is the geography; use topics to focus it)',
    );
  }
  const topics = requireScopeList(input.topics, 'topics');
  const escalationPolicy =
    input.escalationPolicy === undefined || input.escalationPolicy === null
      ? null
      : validateEscalationPolicy(input.escalationPolicy, inputError);
  return {
    watchlistId,
    kind,
    entityKind: kind === 'entity' ? (input.entityKind as WatchEntityKind) : null,
    name,
    description,
    worldEntityId,
    geographies,
    topics,
    escalationPolicy,
  };
}

/** Fully validated form of `UpdateWatchEntryInput`. */
export interface ValidatedUpdateWatchEntryInput {
  watchEntryId: string;
  name: string | null;
  setDescription: boolean;
  description: string | null;
  setWorldEntityId: boolean;
  worldEntityId: string | null;
  geographies: string[] | null;
  topics: string[] | null;
  setEscalationPolicy: boolean;
  escalationPolicy: ValidatedEscalationPolicy | null;
}

export function validateUpdateWatchEntryInput(
  input: UpdateWatchEntryInput,
): ValidatedUpdateWatchEntryInput {
  if (!isPlainObject(input)) throw entryInputError('input must be an object');
  // NOTE: 'kind'/'entityKind' are deliberately absent from UPDATE_ENTRY_KEYS:
  // the watched subject is immutable identity (remove + re-add instead).
  // String guards below throw the watchlist code by default (shared
  // helpers); entry inputs re-label everything to their own code.
  try {
    return validateUpdateWatchEntryBody(input);
  } catch (error) {
    if (error instanceof EnvironmentError) throw withEntryCode(error);
    throw error;
  }
}

function validateUpdateWatchEntryBody(
  input: Record<string, unknown>,
): ValidatedUpdateWatchEntryInput {
  rejectUnknownKeysWith(input, UPDATE_ENTRY_KEYS, 'the input', entryInputError);
  const watchEntryId = requireUuid(input.watchEntryId, 'watchEntryId');
  const name = input.name === undefined ? null : requireName(input.name, 'name');
  const setDescription = input.description !== undefined;
  const description = setDescription
    ? optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH)
    : null;
  const setWorldEntityId = input.worldEntityId !== undefined;
  const worldEntityId = setWorldEntityId
    ? input.worldEntityId === null
      ? null
      : requireUuid(input.worldEntityId, 'worldEntityId')
    : null;
  // A non-empty geographies list is only legal for non-geography entries;
  // the service re-checks that identity-dependent rule against the STORED
  // kind (an update cannot smuggle scopes onto a geography entry).
  const geographies =
    input.geographies === undefined ? null : requireScopeList(input.geographies, 'geographies');
  const topics = input.topics === undefined ? null : requireScopeList(input.topics, 'topics');
  const setEscalationPolicy = input.escalationPolicy !== undefined;
  const escalationPolicy = setEscalationPolicy
    ? input.escalationPolicy === null
      ? null
      : validateEscalationPolicy(input.escalationPolicy, inputError)
    : null;
  if (
    name === null &&
    !setDescription &&
    !setWorldEntityId &&
    geographies === null &&
    topics === null &&
    !setEscalationPolicy
  ) {
    throw entryInputError(
      'nothing to update — provide name, description, worldEntityId, geographies, topics or escalationPolicy',
    );
  }
  return {
    watchEntryId,
    name,
    setDescription,
    description,
    setWorldEntityId,
    worldEntityId,
    geographies,
    topics,
    setEscalationPolicy,
    escalationPolicy,
  };
}

/** Fully validated form of `SetWatchEntryStatusInput`. */
export interface ValidatedSetWatchEntryStatusInput {
  watchEntryId: string;
  status: WatchEntryStatus;
}

export function validateSetWatchEntryStatusInput(
  input: SetWatchEntryStatusInput,
): ValidatedSetWatchEntryStatusInput {
  if (!isPlainObject(input)) throw entryInputError('input must be an object');
  rejectUnknownKeysWith(input, SET_ENTRY_STATUS_KEYS, 'the input', entryInputError);
  const watchEntryId = requireUuid(input.watchEntryId, 'watchEntryId');
  if (!isWatchEntryStatus(input.status)) {
    throw entryInputError(
      `status must be one of ${WATCH_ENTRY_STATUSES.join(', ')} (got '${String(input.status)}')`,
    );
  }
  return { watchEntryId, status: input.status };
}

// ---------------------------------------------------------------------------
// Freshness wiring
// ---------------------------------------------------------------------------

/** Fully validated form of `SetWatchFreshnessPolicyInput`. */
export interface ValidatedSetWatchFreshnessPolicyInput {
  watchEntryId: string | null;
  staleAfterSeconds: number;
  agingAfterSeconds: number | null;
  maxLatencySeconds: number | null;
  note: string | null;
}

export function validateSetWatchFreshnessPolicyInput(
  input: SetWatchFreshnessPolicyInput,
): ValidatedSetWatchFreshnessPolicyInput {
  if (!isPlainObject(input)) throw policyError('input must be an object');
  rejectUnknownKeysWith(input, SET_FRESHNESS_POLICY_KEYS, 'the input', policyError);
  const watchEntryId =
    input.watchEntryId === undefined || input.watchEntryId === null
      ? null
      : requirePolicyUuid(input.watchEntryId, 'watchEntryId');
  const staleAfterSeconds = requirePositiveSeconds(
    input.staleAfterSeconds,
    'staleAfterSeconds',
    policyError,
    MAX_POLICY_SECONDS,
  );
  const agingAfterSeconds =
    input.agingAfterSeconds === undefined || input.agingAfterSeconds === null
      ? null
      : requirePositiveSeconds(input.agingAfterSeconds, 'agingAfterSeconds', policyError, MAX_POLICY_SECONDS);
  if (agingAfterSeconds !== null && agingAfterSeconds >= staleAfterSeconds) {
    throw policyError('agingAfterSeconds must be strictly below staleAfterSeconds');
  }
  const maxLatencySeconds =
    input.maxLatencySeconds === undefined || input.maxLatencySeconds === null
      ? null
      : requirePositiveSeconds(input.maxLatencySeconds, 'maxLatencySeconds', policyError, MAX_POLICY_SECONDS);
  const note = optionalPolicyNote(input.note);
  return { watchEntryId, staleAfterSeconds, agingAfterSeconds, maxLatencySeconds, note };
}

function requirePolicyUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw policyError(`${field} must be a string`);
  const text = value.trim();
  if (!UUID_PATTERN.test(text)) throw policyError(`${field} must be a uuid (got '${text}')`);
  return text.toLowerCase();
}

function optionalPolicyNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw policyError('note must be a string');
  const text = value.trim();
  if (text === '') return null;
  if (text.length > MAX_NOTE_LENGTH) {
    throw policyError(`note must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return text;
}

/** Fully validated form of `ResolveWatchFreshnessPolicyQuery`. */
export interface ValidatedResolveWatchFreshnessPolicyQuery {
  watchEntryId: string;
}

export function validateResolveWatchFreshnessPolicyQuery(
  query: ResolveWatchFreshnessPolicyQuery,
): ValidatedResolveWatchFreshnessPolicyQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, RESOLVE_FRESHNESS_POLICY_KEYS, 'the query');
  try {
    return { watchEntryId: requireUuid(query.watchEntryId, 'watchEntryId') };
  } catch (error) {
    throw relabel(error, queryError);
  }
}

/** Fully validated form of `EvaluateWatchFreshnessQuery`. */
export interface ValidatedEvaluateWatchFreshnessQuery {
  watchEntryId: string;
  asOf: Date | null;
}

export function validateEvaluateWatchFreshnessQuery(
  query: EvaluateWatchFreshnessQuery,
): ValidatedEvaluateWatchFreshnessQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, EVALUATE_FRESHNESS_KEYS, 'the query');
  let watchEntryId: string;
  try {
    watchEntryId = requireUuid(query.watchEntryId, 'watchEntryId');
  } catch (error) {
    throw relabel(error, queryError);
  }
  const asOf =
    query.asOf === undefined || query.asOf === null
      ? null
      : requireIsoInstant(query.asOf, 'asOf');
  return { watchEntryId, asOf };
}

function relabel(error: unknown, to: (message: string) => EnvironmentError): EnvironmentError {
  if (error instanceof EnvironmentError && error.code === 'invalid_watchlist_input') {
    return to(error.message);
  }
  return error instanceof EnvironmentError ? error : to(String(error));
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Fully validated form of `RecordWatchSignalInput`. */
export interface ValidatedRecordSignalInput {
  watchEntryId: string;
  observationId: string;
  severity: WatchSeverity;
  note: string | null;
  originExecutionId: string | null;
}

export function validateRecordSignalInput(input: RecordWatchSignalInput): ValidatedRecordSignalInput {
  if (!isPlainObject(input)) throw signalError('input must be an object');
  rejectUnknownKeysWith(input, RECORD_SIGNAL_KEYS, 'the input', signalError);
  const watchEntryId = requireSignalUuid(input.watchEntryId, 'watchEntryId');
  const observationId = requireSignalUuid(input.observationId, 'observationId');
  if (!isWatchSeverity(input.severity)) {
    throw signalError(
      `severity must be one of ${WATCH_SEVERITIES.join(', ')} (got '${String(input.severity)}')`,
    );
  }
  const note =
    input.note === undefined || input.note === null
      ? null
      : (() => {
          if (typeof input.note !== 'string') throw signalError('note must be a string');
          const text = input.note.trim();
          if (text === '') return null;
          if (text.length > MAX_NOTE_LENGTH) {
            throw signalError(`note must be at most ${MAX_NOTE_LENGTH} characters`);
          }
          return text;
        })();
  const originExecutionId =
    input.originExecutionId === undefined || input.originExecutionId === null
      ? null
      : requireSignalUuid(input.originExecutionId, 'originExecutionId');
  return { watchEntryId, observationId, severity: input.severity, note, originExecutionId };
}

function requireSignalUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw signalError(`${field} must be a string`);
  const text = value.trim();
  if (!UUID_PATTERN.test(text)) throw signalError(`${field} must be a uuid (got '${text}')`);
  return text.toLowerCase();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated form of the id-shaped get queries. */
export interface ValidatedIdQuery {
  id: string;
}

export function validateGetWatchlistQuery(query: GetWatchlistQuery): ValidatedIdQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, GET_WATCHLIST_KEYS, 'the query');
  return { id: queryUuid(query.watchlistId, 'watchlistId') };
}

export function validateGetWatchEntryQuery(query: GetWatchEntryQuery): ValidatedIdQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, GET_ENTRY_KEYS, 'the query');
  return { id: queryUuid(query.watchEntryId, 'watchEntryId') };
}

export function validateGetWatchSignalQuery(query: GetWatchSignalQuery): ValidatedIdQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, GET_SIGNAL_KEYS, 'the query');
  return { id: queryUuid(query.watchSignalId, 'watchSignalId') };
}

export function validateGetWatchEscalationQuery(query: GetWatchEscalationQuery): ValidatedIdQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, GET_ESCALATION_KEYS, 'the query');
  return { id: queryUuid(query.watchEscalationId, 'watchEscalationId') };
}

function queryUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw queryError(`${field} must be a string`);
  const text = value.trim();
  if (!UUID_PATTERN.test(text)) throw queryError(`${field} must be a uuid (got '${text}')`);
  return text.toLowerCase();
}

/** Fully validated form of `ListWatchlistsQuery`. */
export interface ValidatedListWatchlistsQuery {
  status: WatchlistStatus | null;
  search: string | null;
  limit: number;
}

export function validateListWatchlistsQuery(query: ListWatchlistsQuery): ValidatedListWatchlistsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, LIST_WATCHLISTS_KEYS, 'the query');
  const status =
    query.status === undefined || query.status === null
      ? null
      : isWatchlistStatus(query.status)
        ? query.status
        : null;
  if (query.status !== undefined && query.status !== null && status === null) {
    throw queryError(
      `status must be one of ${WATCHLIST_STATUSES.join(', ')} (got '${String(query.status)}')`,
    );
  }
  const search = optionalSearch(query.search);
  const limit = requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError);
  return { status, search, limit };
}

/** Fully validated form of `ListWatchEntriesQuery`. */
export interface ValidatedListEntriesQuery {
  watchlistId: string | null;
  kind: WatchEntryKind | null;
  entityKind: WatchEntityKind | null;
  status: WatchEntryStatus | null;
  geography: string | null;
  topic: string | null;
  search: string | null;
  limit: number;
}

export function validateListWatchEntriesQuery(
  query: ListWatchEntriesQuery,
): ValidatedListEntriesQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, LIST_ENTRIES_KEYS, 'the query');
  const watchlistId =
    query.watchlistId === undefined || query.watchlistId === null
      ? null
      : queryUuid(query.watchlistId, 'watchlistId');
  const kind =
    query.kind === undefined || query.kind === null
      ? null
      : isWatchEntryKind(query.kind)
        ? query.kind
        : null;
  if (query.kind !== undefined && query.kind !== null && kind === null) {
    throw queryError(`kind must be one of ${WATCH_ENTRY_KINDS.join(', ')} (got '${String(query.kind)}')`);
  }
  const entityKind =
    query.entityKind === undefined || query.entityKind === null
      ? null
      : isWatchEntityKind(query.entityKind)
        ? query.entityKind
        : null;
  if (query.entityKind !== undefined && query.entityKind !== null && entityKind === null) {
    throw queryError(
      `entityKind must be one of ${WATCH_ENTITY_KINDS.join(', ')} (got '${String(query.entityKind)}')`,
    );
  }
  const status =
    query.status === undefined || query.status === null
      ? null
      : isWatchEntryStatus(query.status)
        ? query.status
        : null;
  if (query.status !== undefined && query.status !== null && status === null) {
    throw queryError(
      `status must be one of ${WATCH_ENTRY_STATUSES.join(', ')} (got '${String(query.status)}')`,
    );
  }
  const geography =
    query.geography === undefined || query.geography === null ? null : requireScopeSlug(query.geography, 'geography');
  const topic =
    query.topic === undefined || query.topic === null ? null : requireScopeSlug(query.topic, 'topic');
  const search = optionalSearch(query.search);
  const limit = requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError);
  return { watchlistId, kind, entityKind, status, geography, topic, search, limit };
}

function requireScopeSlug(value: unknown, field: string): string {
  if (typeof value !== 'string') throw queryError(`${field} must be a string`);
  const slug = value.trim();
  if (slug === '' || slug.length > MAX_SCOPE_LENGTH || !SCOPE_SLUG_PATTERN.test(slug)) {
    throw queryError(`${field} must be a canonical slug (got '${slug}')`);
  }
  return slug;
}

function optionalSearch(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw queryError('search must be a string');
  const text = value.trim();
  if (text === '') return null;
  if (text.length > MAX_NAME_LENGTH) {
    throw queryError(`search must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return text;
}

/** Fully validated form of `ListWatchSignalsQuery`. */
export interface ValidatedListSignalsQuery {
  watchEntryId: string | null;
  watchlistId: string | null;
  minSeverity: WatchSeverity | null;
  limit: number;
}

export function validateListWatchSignalsQuery(query: ListWatchSignalsQuery): ValidatedListSignalsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, LIST_SIGNALS_KEYS, 'the query');
  const watchEntryId =
    query.watchEntryId === undefined || query.watchEntryId === null
      ? null
      : queryUuid(query.watchEntryId, 'watchEntryId');
  const watchlistId =
    query.watchlistId === undefined || query.watchlistId === null
      ? null
      : queryUuid(query.watchlistId, 'watchlistId');
  const minSeverity = optionalSeverity(query.minSeverity, 'minSeverity');
  const limit = requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError);
  return { watchEntryId, watchlistId, minSeverity, limit };
}

/** Fully validated form of `ListWatchEscalationsQuery`. */
export interface ValidatedListEscalationsQuery {
  watchEntryId: string | null;
  watchlistId: string | null;
  trigger: (typeof ESCALATION_TRIGGERS)[number] | null;
  minSeverity: WatchSeverity | null;
  limit: number;
}

export function validateListWatchEscalationsQuery(
  query: ListWatchEscalationsQuery,
): ValidatedListEscalationsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, LIST_ESCALATIONS_KEYS, 'the query');
  const watchEntryId =
    query.watchEntryId === undefined || query.watchEntryId === null
      ? null
      : queryUuid(query.watchEntryId, 'watchEntryId');
  const watchlistId =
    query.watchlistId === undefined || query.watchlistId === null
      ? null
      : queryUuid(query.watchlistId, 'watchlistId');
  const trigger =
    query.trigger === undefined || query.trigger === null
      ? null
      : isEscalationTrigger(query.trigger)
        ? query.trigger
        : null;
  if (query.trigger !== undefined && query.trigger !== null && trigger === null) {
    throw queryError(
      `trigger must be one of ${ESCALATION_TRIGGERS.join(', ')} (got '${String(query.trigger)}')`,
    );
  }
  const minSeverity = optionalSeverity(query.minSeverity, 'minSeverity');
  const limit = requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError);
  return { watchEntryId, watchlistId, trigger, minSeverity, limit };
}

function optionalSeverity(value: unknown, field: string): WatchSeverity | null {
  if (value === undefined || value === null) return null;
  if (!isWatchSeverity(value)) {
    throw queryError(`${field} must be one of ${WATCH_SEVERITIES.join(', ')} (got '${String(value)}')`);
  }
  return value;
}

/** Fully validated form of `EscalateStaleWatchesQuery`. */
export interface ValidatedPumpQuery {
  watchlistId: string | null;
  limit: number;
}

export function validateEscalateStaleWatchesQuery(
  query: EscalateStaleWatchesQuery,
): ValidatedPumpQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, PUMP_KEYS, 'the query');
  const watchlistId =
    query.watchlistId === undefined || query.watchlistId === null
      ? null
      : queryUuid(query.watchlistId, 'watchlistId');
  const limit = requireLimit(query.limit, 'limit', DEFAULT_PUMP_LIMIT, MAX_PUMP_LIMIT, queryError);
  return { watchlistId, limit };
}
