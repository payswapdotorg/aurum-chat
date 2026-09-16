// Pure validation/normalization logic of the extensions module (no
// database). Everything a caller may put into a manifest registration,
// a lifecycle transition or a query crosses these guards first; the SQL
// CHECK constraints and the trigger in migrations/002 mirror the
// load-bearing permission-consistency rule as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `registeredBy`, `registeredAt` or a manifest's
// identity into registration — the system mints those. Normalization
// (deduplication + canonical ordering of every list) means two equal
// registrations always serialize identically — determinism the
// verification checks and the marketplace review (W028) rely on.
//
// The final consistency pass runs the SAME shared pure rule set
// (manifest-rules.ts) that the storage trigger and the verification
// checks enforce — one rule set, three enforcers, no drift.

import type { TenantContext } from '@/infra/tenant';
import { ExtensionsError } from './errors';
import {
  isExtensionTransition,
  targetLifecycleState,
  type ExtensionLifecycleState,
  type ExtensionTransition,
} from './lifecycle';
import {
  capabilityDeclarationProblems,
  capabilityPermissionProblems,
  capabilityQuotaProblems,
  EXTENSION_PERMISSIONS,
  EXTENSION_STATE_SCOPES,
  EXTENSION_UI_SURFACES,
  isEventTopic,
  isExtensionPermission,
  isExtensionStateScope,
  isExtensionUiSurface,
  isHttpsOrigin,
  isNameSlug,
  isValidCronExpression,
  MAX_EVENT_TOPICS,
  MAX_EXTERNAL_PARTICIPANTS,
  MAX_SCHEDULES,
  type ExtensionCapabilities,
  type ExtensionExternalParticipant,
  type ExtensionPermission,
  type ExtensionQuotas,
  type ExtensionScheduleDeclaration,
  type ExtensionStateScope,
  type ExtensionUiSurface,
} from './manifest-rules';
import { compareSemver, isSemver, parseSemver, type SemverParts } from './semver';
import { isSupportedManifestSchemaVersion } from './verification';
import type {
  CheckManifestCompatibilityQuery,
  GetExtensionQuery,
  GetManifestQuery,
  ListExtensionLifecycleEventsQuery,
  ListExtensionsQuery,
  ListManifestsQuery,
  ListManifestVerificationsQuery,
  RegisterExtensionManifestInput,
  RunManifestVerificationQuery,
  TransitionExtensionInput,
} from './types';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_DISPLAY_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_PARTICIPANT_LABEL_CHARS = 120;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Stable extension identity: lowercase slug, 1–63 chars, no leading/trailing hyphen. */
const EXTENSION_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const LIFECYCLE_STATES = ['REGISTERED', 'ACTIVE', 'SUSPENDED', 'DEPRECATED'] as const;

const REGISTER_INPUT_KEYS = [
  'extensionKey',
  'version',
  'manifestSchemaVersion',
  'displayName',
  'description',
  'requestedPermissions',
  'stateScope',
  'uiSurfaces',
  'schedules',
  'eventSubscriptions',
  'externalParticipants',
  'telemetry',
  'quotas',
  'hostRuntime',
] as const;
const TRANSITION_INPUT_KEYS = ['extensionId', 'extensionKey', 'transition', 'idempotencyKey'] as const;
const GET_EXTENSION_QUERY_KEYS = ['extensionId', 'extensionKey'] as const;
const LIST_EXTENSIONS_QUERY_KEYS = ['lifecycleState', 'limit'] as const;
const GET_MANIFEST_QUERY_KEYS = ['manifestId'] as const;
const LIST_MANIFESTS_QUERY_KEYS = ['extensionId', 'extensionKey', 'limit'] as const;
const LIST_VERIFICATIONS_QUERY_KEYS = ['manifestId', 'limit'] as const;
const RUN_VERIFICATION_QUERY_KEYS = ['manifestId'] as const;
const COMPATIBILITY_QUERY_KEYS = ['manifestId', 'hostVersion'] as const;
const LIST_EVENTS_QUERY_KEYS = ['extensionId', 'extensionKey', 'limit'] as const;

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertExtensionsTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new ExtensionsError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ExtensionsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ExtensionsError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority) || !ctx.authority.every((claim) => typeof claim === 'string')) {
    throw new ExtensionsError('invalid_context', 'TenantContext.authority must be an array of claim strings');
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

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function inputError(message: string): ExtensionsError {
  return new ExtensionsError('invalid_input', message);
}

function queryError(message: string): ExtensionsError {
  return new ExtensionsError('invalid_query', message);
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

/** Resolve the (at most one) extension selector on a query/input. */
function resolveSelector(
  query: Record<string, unknown>,
  mode: 'exactly_one' | 'at_most_one',
  errorKind: 'invalid_query' | 'invalid_input',
): { extensionId: string | null; extensionKey: string | null } {
  const fail = (message: string): ExtensionsError =>
    errorKind === 'invalid_query' ? queryError(message) : inputError(message);
  const hasId = query['extensionId'] !== undefined;
  const hasKey = query['extensionKey'] !== undefined;
  if (mode === 'exactly_one' && hasId === hasKey) {
    throw fail('exactly one of extensionId / extensionKey must be given');
  }
  if (mode === 'at_most_one' && hasId && hasKey) {
    throw fail('at most one of extensionId / extensionKey may be given');
  }
  return {
    extensionId: hasId ? requireUuid(query['extensionId'], 'extensionId') : null,
    extensionKey: hasKey ? requireExtensionKey(query['extensionKey'], 'extensionKey') : null,
  };
}

function requireExtensionKey(value: unknown, field = 'extensionKey'): string {
  const text = requireString(value, field);
  if (!EXTENSION_KEY_PATTERN.test(text)) {
    throw inputError(
      `${field} must be a lowercase slug of 1-63 characters ([a-z0-9-], no leading/trailing hyphen; got '${text}')`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// Manifest registration
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RegisterExtensionManifestInput`. */
export interface ValidatedRegisterInput {
  extensionKey: string;
  version: string;
  versionParts: SemverParts;
  manifestSchemaVersion: number;
  displayName: string;
  description: string | null;
  requestedPermissions: ExtensionPermission[];
  capabilities: ExtensionCapabilities;
  quotas: ExtensionQuotas;
  hostCompatibility: { minVersion: string; maxVersion: string | null };
}

/** Normalize a permission list: known vocabulary, deduped, canonically ordered. */
function normalizePermissions(value: unknown): ExtensionPermission[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw inputError('requestedPermissions must be an array of extension permissions');
  }
  const out: ExtensionPermission[] = [];
  for (const entry of value) {
    if (!isExtensionPermission(entry)) {
      throw inputError(
        `requestedPermissions entry '${String(entry)}' is not a known extension permission`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  // canonical order (the EXTENSION_PERMISSIONS declaration order)
  return [...EXTENSION_PERMISSIONS].filter((permission) =>
    (out as readonly string[]).includes(permission),
  );
}

/** Normalize a UI-surface list: known vocabulary, deduped, canonically ordered. */
function normalizeSurfaces(value: unknown): ExtensionUiSurface[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw inputError('uiSurfaces must be an array of declarative UI surfaces');
  }
  const out: ExtensionUiSurface[] = [];
  for (const entry of value) {
    if (!isExtensionUiSurface(entry)) {
      throw inputError(`uiSurfaces entry '${String(entry)}' is not a known declarative UI surface`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return (EXTENSION_UI_SURFACES as readonly string[]).filter((surface) =>
    (out as readonly string[]).includes(surface),
  ) as ExtensionUiSurface[];
}

function normalizeSchedules(value: unknown): ExtensionScheduleDeclaration[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw inputError('schedules must be an array of { name, cron } declarations');
  }
  if (value.length > MAX_SCHEDULES) {
    throw inputError(`schedules must declare at most ${MAX_SCHEDULES} triggers (got ${value.length})`);
  }
  const out: ExtensionScheduleDeclaration[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      throw inputError('each schedule must be an object with name and cron');
    }
    const name = requireString(entry['name'], 'schedules[].name');
    if (!isNameSlug(name)) {
      throw inputError(`schedules[].name '${name}' must be a slug of at most 64 characters`);
    }
    if (names.has(name)) {
      throw inputError(`duplicate schedule name '${name}' — schedule names must be unique within a manifest`);
    }
    names.add(name);
    const cron = requireString(entry['cron'], `schedules['${name}'].cron`);
    if (!isValidCronExpression(cron)) {
      throw inputError(
        `schedules['${name}'].cron must be a five-field cron expression (minute hour day-of-month month day-of-week; got '${cron}')`,
      );
    }
    out.push({ name, cron });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function normalizeTopics(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw inputError('eventSubscriptions must be an array of event topic slugs');
  }
  if (value.length > MAX_EVENT_TOPICS) {
    throw inputError(`eventSubscriptions must declare at most ${MAX_EVENT_TOPICS} topics (got ${value.length})`);
  }
  const out: string[] = [];
  for (const entry of value) {
    const topic = requireString(entry, 'eventSubscriptions[]');
    if (!isEventTopic(topic)) {
      throw inputError(`event subscription topic '${topic}' is not a canonical topic slug`);
    }
    if (!out.includes(topic)) out.push(topic);
  }
  return out.sort();
}

function normalizeParticipants(value: unknown): ExtensionExternalParticipant[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw inputError('externalParticipants must be an array of { label, origin } declarations');
  }
  if (value.length > MAX_EXTERNAL_PARTICIPANTS) {
    throw inputError(
      `externalParticipants must declare at most ${MAX_EXTERNAL_PARTICIPANTS} participants (got ${value.length})`,
    );
  }
  const out: ExtensionExternalParticipant[] = [];
  const origins = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      throw inputError('each external participant must be an object with label and origin');
    }
    const label = requireString(entry['label'], 'externalParticipants[].label');
    if (label.length > MAX_PARTICIPANT_LABEL_CHARS) {
      throw inputError(
        `externalParticipants[].label must be at most ${MAX_PARTICIPANT_LABEL_CHARS} characters`,
      );
    }
    const origin = requireString(entry['origin'], `externalParticipants['${label}'].origin`);
    if (!isHttpsOrigin(origin)) {
      throw inputError(
        `externalParticipants['${label}'].origin must be a plain https origin (https://host[:port]; got '${origin}')`,
      );
    }
    if (origins.has(origin)) {
      throw inputError(`duplicate external participant origin '${origin}' — origins must be unique within a manifest`);
    }
    origins.add(origin);
    out.push({ label, origin });
  }
  out.sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
  return out;
}

function normalizeQuotas(value: unknown): ExtensionQuotas {
  const source = value === undefined || value === null ? {} : value;
  if (!isPlainObject(source)) {
    throw inputError('quotas must be an object with maxStateBytes, maxScheduleInvocationsPerDay, maxExternalCallsPerDay');
  }
  rejectUnknownKeys(
    source,
    ['maxStateBytes', 'maxScheduleInvocationsPerDay', 'maxExternalCallsPerDay'],
    'the quotas declaration',
  );
  const read = (field: string): number => {
    const raw = source[field];
    if (raw === undefined || raw === null) return 0;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw inputError(`quotas.${field} must be a non-negative integer (got '${String(raw)}')`);
    }
    return raw;
  };
  return {
    maxStateBytes: read('maxStateBytes'),
    maxScheduleInvocationsPerDay: read('maxScheduleInvocationsPerDay'),
    maxExternalCallsPerDay: read('maxExternalCallsPerDay'),
  };
}

export function validateRegisterExtensionManifestInput(
  input: RegisterExtensionManifestInput,
): ValidatedRegisterInput {
  if (!isPlainObject(input)) {
    throw inputError('manifest registration input must be an object');
  }
  rejectUnknownKeys(input, REGISTER_INPUT_KEYS, 'the manifest registration input');

  const extensionKey = requireExtensionKey(input['extensionKey']);
  const version = requireString(input['version'], 'version');
  if (!isSemver(version)) {
    throw inputError(
      `version must be a release semver MAJOR.MINOR.PATCH, no prerelease tags (got '${version}')`,
    );
  }
  const versionParts = parseSemver(version)!;

  if (!isSupportedManifestSchemaVersion(input['manifestSchemaVersion'])) {
    throw inputError(
      `manifestSchemaVersion must be one of the supported manifest format versions (got '${String(input['manifestSchemaVersion'])}')`,
    );
  }

  const displayName = requireString(input['displayName'], 'displayName');
  if (displayName.length > MAX_DISPLAY_NAME_CHARS) {
    throw inputError(`displayName must be at most ${MAX_DISPLAY_NAME_CHARS} characters`);
  }
  const description = optionalTrimmed(input['description'], 'description', MAX_DESCRIPTION_CHARS);

  const requestedPermissions = normalizePermissions(input['requestedPermissions']);

  const stateScopeRaw = input['stateScope'] === undefined || input['stateScope'] === null
    ? 'none'
    : input['stateScope'];
  if (!isExtensionStateScope(stateScopeRaw)) {
    throw inputError(`stateScope must be one of ${EXTENSION_STATE_SCOPES.join(', ')} (got '${String(stateScopeRaw)}')`);
  }
  const stateScope: ExtensionStateScope = stateScopeRaw;

  const uiSurfaces = normalizeSurfaces(input['uiSurfaces']);
  const schedules = normalizeSchedules(input['schedules']);
  const eventSubscriptions = normalizeTopics(input['eventSubscriptions']);
  const externalParticipants = normalizeParticipants(input['externalParticipants']);
  const telemetry = input['telemetry'] === undefined || input['telemetry'] === null
    ? false
    : input['telemetry'];
  if (typeof telemetry !== 'boolean') {
    throw inputError('telemetry must be a boolean');
  }

  const capabilities: ExtensionCapabilities = {
    stateScope,
    uiSurfaces,
    schedules,
    eventSubscriptions,
    externalParticipants,
    telemetry,
  };

  const quotas = normalizeQuotas(input['quotas']);

  const hostRuntime = input['hostRuntime'];
  if (!isPlainObject(hostRuntime)) {
    throw inputError('hostRuntime must be an object with minVersion and optional maxVersion');
  }
  rejectUnknownKeys(hostRuntime, ['minVersion', 'maxVersion'], 'the hostRuntime declaration');
  const minVersion = requireString(hostRuntime['minVersion'], 'hostRuntime.minVersion');
  if (!isSemver(minVersion)) {
    throw inputError(`hostRuntime.minVersion must be a release semver (got '${minVersion}')`);
  }
  let maxVersion: string | null = null;
  const maxVersionRaw = hostRuntime['maxVersion'];
  if (maxVersionRaw !== undefined && maxVersionRaw !== null) {
    maxVersion = requireString(maxVersionRaw, 'hostRuntime.maxVersion');
    if (!isSemver(maxVersion)) {
      throw inputError(`hostRuntime.maxVersion must be a release semver or null (got '${maxVersion}')`);
    }
    if (compareSemver(parseSemver(minVersion)!, parseSemver(maxVersion)!) > 0) {
      throw inputError(
        `hostRuntime range is inverted: minVersion ${minVersion} is newer than maxVersion ${maxVersion}`,
      );
    }
  }

  // The single source of truth: the shared pure rule set (mirrored by
  // the storage trigger and re-run by the verification checks).
  const problems = [
    ...capabilityPermissionProblems(capabilities, requestedPermissions),
    ...capabilityQuotaProblems(capabilities, quotas),
    ...capabilityDeclarationProblems(capabilities),
  ];
  if (problems.length > 0) {
    throw inputError(`the manifest declaration is inconsistent: ${problems.join('; ')}`);
  }

  return {
    extensionKey,
    version,
    versionParts,
    manifestSchemaVersion: input['manifestSchemaVersion'],
    displayName,
    description,
    requestedPermissions,
    capabilities,
    quotas,
    hostCompatibility: { minVersion, maxVersion },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/** Fully validated form of `TransitionExtensionInput`. */
export interface ValidatedTransitionInput {
  extensionId: string | null;
  extensionKey: string | null;
  transition: ExtensionTransition;
  targetState: ExtensionLifecycleState;
  idempotencyKey: string | null;
}

export function validateTransitionExtensionInput(
  input: TransitionExtensionInput,
): ValidatedTransitionInput {
  if (!isPlainObject(input)) {
    throw inputError('transition input must be an object');
  }
  return wrapError(() => {
    rejectUnknownKeys(input, TRANSITION_INPUT_KEYS, 'the transition input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    const transition = input['transition'];
    if (!isExtensionTransition(transition)) {
      throw inputError(
        `transition must be one of activate, suspend, resume, deprecate (got '${String(transition)}')`,
      );
    }
    const idempotencyKey = optionalIdempotencyKey(input['idempotencyKey']);
    return {
      extensionId,
      extensionKey,
      transition,
      targetState: targetLifecycleState(transition),
      idempotencyKey,
    };
  }, 'invalid_input');
}

function optionalIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, 'idempotencyKey');
  if (text.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw inputError(
      `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (got ${text.length})`,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(text)) {
    throw inputError(`idempotencyKey must match ${IDEMPOTENCY_KEY_PATTERN.source} (got '${text}')`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated form of `GetExtensionQuery`. */
export interface ValidatedExtensionSelector {
  extensionId: string | null;
  extensionKey: string | null;
}

export function validateGetExtensionQuery(query: GetExtensionQuery): ValidatedExtensionSelector {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, GET_EXTENSION_QUERY_KEYS, 'the query');
    return resolveSelector(query, 'exactly_one', 'invalid_query');
  });
}

/** Fully validated form of `ListExtensionsQuery`. */
export interface ValidatedListExtensionsQuery {
  lifecycleState: ExtensionLifecycleState | null;
  limit: number;
}

export function validateListExtensionsQuery(query: ListExtensionsQuery): ValidatedListExtensionsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_EXTENSIONS_QUERY_KEYS, 'the query');
    const state = query['lifecycleState'];
    if (state !== undefined && state !== null && !(LIFECYCLE_STATES as readonly string[]).includes(state as string)) {
      throw queryError(
        `query.lifecycleState must be one of ${LIFECYCLE_STATES.join(', ')} (got '${String(state)}')`,
      );
    }
    return {
      lifecycleState: (state ?? null) as ExtensionLifecycleState | null,
      limit: requireLimit(query['limit']),
    };
  });
}

/** Fully validated form of `GetManifestQuery`. */
export interface ValidatedManifestIdQuery {
  manifestId: string;
}

export function validateGetManifestQuery(query: GetManifestQuery): ValidatedManifestIdQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, GET_MANIFEST_QUERY_KEYS, 'the query');
    return { manifestId: requireUuid(query['manifestId'], 'query.manifestId') };
  });
}

/** Fully validated form of `ListManifestsQuery`. */
export interface ValidatedListManifestsQuery {
  extensionId: string | null;
  extensionKey: string | null;
  limit: number;
}

export function validateListManifestsQuery(query: ListManifestsQuery): ValidatedListManifestsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_MANIFESTS_QUERY_KEYS, 'the query');
    const { extensionId, extensionKey } = resolveSelector(query, 'at_most_one', 'invalid_query');
    return { extensionId, extensionKey, limit: requireLimit(query['limit']) };
  });
}

/** Fully validated form of `ListManifestVerificationsQuery`. */
export interface ValidatedListVerificationsQuery {
  manifestId: string;
  limit: number;
}

export function validateListManifestVerificationsQuery(
  query: ListManifestVerificationsQuery,
): ValidatedListVerificationsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_VERIFICATIONS_QUERY_KEYS, 'the query');
    return { manifestId: requireUuid(query['manifestId'], 'query.manifestId'), limit: requireLimit(query['limit']) };
  });
}

export function validateRunManifestVerificationQuery(
  query: RunManifestVerificationQuery,
): ValidatedManifestIdQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, RUN_VERIFICATION_QUERY_KEYS, 'the query');
    return { manifestId: requireUuid(query['manifestId'], 'query.manifestId') };
  });
}

/** Fully validated form of `CheckManifestCompatibilityQuery`. */
export interface ValidatedCompatibilityQuery {
  manifestId: string;
  hostVersion: string;
}

export function validateCheckManifestCompatibilityQuery(
  query: CheckManifestCompatibilityQuery,
): ValidatedCompatibilityQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, COMPATIBILITY_QUERY_KEYS, 'the query');
    const manifestId = requireUuid(query['manifestId'], 'query.manifestId');
    const hostVersion = requireString(query['hostVersion'], 'query.hostVersion');
    if (!isSemver(hostVersion)) {
      throw queryError(`query.hostVersion must be a release semver (got '${hostVersion}')`);
    }
    return { manifestId, hostVersion };
  });
}

/** Fully validated form of `ListExtensionLifecycleEventsQuery`. */
export interface ValidatedListEventsQuery {
  extensionId: string | null;
  extensionKey: string | null;
  limit: number;
}

export function validateListExtensionLifecycleEventsQuery(
  query: ListExtensionLifecycleEventsQuery,
): ValidatedListEventsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_EVENTS_QUERY_KEYS, 'the query');
    const { extensionId, extensionKey } = resolveSelector(query, 'exactly_one', 'invalid_query');
    return { extensionId, extensionKey, limit: requireLimit(query['limit']) };
  });
}

/** The shared string guards throw input-flavored errors; a query deserves `invalid_query`. */
function wrapQueryError<T>(fn: () => T): T {
  return wrapError(fn, 'invalid_query');
}

function wrapError<T>(fn: () => T, code: 'invalid_query' | 'invalid_input'): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ExtensionsError && error.code === 'invalid_input' && code === 'invalid_query') {
      throw new ExtensionsError('invalid_query', error.message);
    }
    throw error;
  }
}
