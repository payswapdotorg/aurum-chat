// Pure validation/normalization logic of the extensions module (no
// database). Everything a caller may put into a manifest registration,
// a lifecycle transition, a runtime input or a query crosses these
// guards first; the SQL CHECK constraints and the triggers in
// migrations/002 and migrations/005+ mirror the load-bearing rules as
// defense in depth.
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
// checks enforce — one rule set, three enforcers, no drift. The W026
// runtime inputs reuse that discipline: the UI document validator runs
// the same shared uiDocumentProblems (runtime.ts), and the payload
// guards are the quota/accounting prelude of the service.

import type { TenantContext } from '@/infra/tenant';
import { EXTENSION_BUILD_PHASES, isExtensionBuildPhase } from './builder';
import type { ExtensionBuildPhase } from './builder';
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
import {
  byteLength,
  DEFAULT_INSTALL_KEY,
  EXTENSION_HTTP_METHODS,
  EXTENSION_UI_BLOCK_TYPES,
  isExtensionHttpMethod,
  isExtensionUiBlockType,
  isExternalPath,
  isInstallKey,
  isStateKey,
  isTelemetryName,
  jsonByteLength,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EXTERNAL_BODY_BYTES,
  MAX_EXTERNAL_HEADER_COUNT,
  MAX_EXTERNAL_HEADER_NAME_CHARS,
  MAX_EXTERNAL_HEADER_VALUE_CHARS,
  MAX_EXTERNAL_PATH_CHARS,
  MAX_STATE_VALUE_BYTES,
  MAX_TELEMETRY_PAYLOAD_BYTES,
  MAX_UI_LIST_ITEMS,
  MAX_UI_TABLE_COLUMNS,
  MAX_UI_TABLE_ROWS,
  MAX_UI_TEXT_CHARS,
  uiDocumentProblems,
  type ExtensionHttpMethod,
  type ExtensionUiBlock,
  type ExtensionUiDocument,
} from './runtime';
import { compareSemver, isSemver, parseSemver, type SemverParts } from './semver';
import { isSupportedManifestSchemaVersion } from './verification';
import type {
  CancelExtensionBuildInput,
  CheckManifestCompatibilityQuery,
  DeployExtensionVersionInput,
  DeploymentQuery,
  DispatchExtensionEventInput,
  EmitExtensionTelemetryInput,
  ExecuteExtensionExternalCallInput,
  GetExtensionBuildQuery,
  GetExtensionQuery,
  GetExtensionUiQuery,
  GetManifestQuery,
  ListExtensionBuildArtifactsQuery,
  ListExtensionBuildsQuery,
  ListExtensionDeploymentsQuery,
  ListExtensionEventDeliveriesQuery,
  ListExtensionExternalCallsQuery,
  ListExtensionLifecycleEventsQuery,
  ListExtensionScheduleRunsQuery,
  ListExtensionTelemetryEventsQuery,
  ListExtensionsQuery,
  ListManifestsQuery,
  ListManifestVerificationsQuery,
  PublishExtensionUiInput,
  ReadExtensionStateQuery,
  RegisterExtensionManifestInput,
  RequestExtensionBuildInput,
  RollbackExtensionDeploymentInput,
  RunExtensionBuildInput,
  RunManifestVerificationQuery,
  TransitionExtensionInput,
  TriggerExtensionScheduleInput,
  WriteExtensionStateInput,
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

// ---------------------------------------------------------------------------
// W026 — General-Purpose Extension Runtime inputs and queries
//
// The house discipline carried over: unknown keys are rejected (a
// caller can never smuggle identity or timestamps), lists normalize to
// canonical order (equal inputs serialize identically), and every
// bounded vocabulary is checked here BEFORE the service touches state —
// with the storage CHECKs/trigger (migrations 005+) as defense in depth
// for writes that bypass the service.
// ---------------------------------------------------------------------------

const DEPLOY_INPUT_KEYS = [
  'extensionId',
  'extensionKey',
  'manifestId',
  'version',
  'installKey',
  'grantedPermissions',
  'idempotencyKey',
] as const;
const ROLLBACK_INPUT_KEYS = [
  'extensionId',
  'extensionKey',
  'targetDeploymentId',
  'installKey',
  'idempotencyKey',
] as const;
const DEPLOYMENT_QUERY_KEYS = ['extensionId', 'extensionKey', 'installKey'] as const;
const LIST_DEPLOYMENTS_QUERY_KEYS = [...DEPLOYMENT_QUERY_KEYS, 'limit'] as const;
const READ_STATE_QUERY_KEYS = [...DEPLOYMENT_QUERY_KEYS, 'key'] as const;
const WRITE_STATE_INPUT_KEYS = [...READ_STATE_QUERY_KEYS, 'value'] as const;
const PUBLISH_UI_INPUT_KEYS = ['extensionId', 'extensionKey', 'surface', 'document'] as const;
const GET_UI_QUERY_KEYS = ['extensionId', 'extensionKey', 'surface'] as const;
const TRIGGER_SCHEDULE_INPUT_KEYS = [...DEPLOYMENT_QUERY_KEYS, 'scheduleName'] as const;
const LIST_ACTIVITY_QUERY_KEYS = [...DEPLOYMENT_QUERY_KEYS, 'limit'] as const;
const DISPATCH_EVENT_INPUT_KEYS = ['topic', 'payload'] as const;
const EXTERNAL_CALL_INPUT_KEYS = [
  'extensionId',
  'extensionKey',
  'installKey',
  'origin',
  'method',
  'path',
  'body',
  'headers',
] as const;
const EMIT_TELEMETRY_INPUT_KEYS = [...DEPLOYMENT_QUERY_KEYS, 'name', 'payload'] as const;

/** The install key a query/input carries, defaulted to the primary install. */
function resolveInstallKey(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_INSTALL_KEY;
  const text = requireString(value, 'installKey');
  if (!isInstallKey(text)) {
    throw inputError(
      `installKey must be a slug of at most 64 characters ([A-Za-z0-9._:-]; got '${text}')`,
    );
  }
  return text;
}

function requireExtensionUiSurface(value: unknown): ExtensionUiSurface {
  const text = requireString(value, 'surface');
  if (!isExtensionUiSurface(text)) {
    throw inputError(
      `surface must be one of ${EXTENSION_UI_SURFACES.join(', ')} (got '${text}')`,
    );
  }
  return text;
}

/** Validate + normalize the declarative UI document (shared pure rules). */
function requireUiDocument(value: unknown): ExtensionUiDocument {
  const document = value === undefined || value === null ? {} : value;
  if (!isPlainObject(document)) {
    throw inputError('document must be an object with title and blocks');
  }
  rejectUnknownKeys(document, ['title', 'blocks'], 'the UI document');
  const title =
    document['title'] === undefined || document['title'] === null
      ? null
      : requireString(document['title'], 'document.title');
  if (title !== null && title.length > MAX_UI_TEXT_CHARS) {
    throw inputError(`document.title must be at most ${MAX_UI_TEXT_CHARS} characters`);
  }
  const rawBlocks = document['blocks'] === undefined || document['blocks'] === null ? [] : document['blocks'];
  if (!Array.isArray(rawBlocks)) {
    throw inputError('document.blocks must be an array of UI blocks');
  }
  const blocks: ExtensionUiBlock[] = rawBlocks.map((block: unknown, index: number) => {
    if (!isPlainObject(block)) {
      throw inputError(`document.blocks[${index}] must be an object`);
    }
    const type = block['type'];
    if (!isExtensionUiBlockType(type)) {
      throw inputError(
        `document.blocks[${index}].type '${String(type)}' is not a known UI block type (${EXTENSION_UI_BLOCK_TYPES.join(', ')})`,
      );
    }
    const text = (field: string): string => {
      const value = block[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw inputError(`document.blocks[${index}] (${type}) needs a non-empty ${field}`);
      }
      if (value.length > MAX_UI_TEXT_CHARS) {
        throw inputError(
          `document.blocks[${index}] (${type}) ${field} must be at most ${MAX_UI_TEXT_CHARS} characters`,
        );
      }
      return value;
    };
    switch (type) {
      case 'heading':
        return { type, text: text('text') };
      case 'text':
        return { type, text: text('text') };
      case 'metric':
        return { type, label: text('label'), value: text('value') };
      case 'divider':
        return { type };
      case 'list': {
        const items = block['items'];
        if (!Array.isArray(items)) {
          throw inputError(`document.blocks[${index}] (list) needs an items array`);
        }
        if (items.length > MAX_UI_LIST_ITEMS) {
          throw inputError(
            `document.blocks[${index}] (list) must declare at most ${MAX_UI_LIST_ITEMS} items (got ${items.length})`,
          );
        }
        return { type, items: items.map((item: unknown) => text2(item, `document.blocks[${index}].items[]`)) };
      }
      case 'table': {
        const columns = block['columns'];
        const rows = block['rows'];
        if (!Array.isArray(columns) || columns.length === 0) {
          throw inputError(`document.blocks[${index}] (table) needs a non-empty columns array`);
        }
        if (columns.length > MAX_UI_TABLE_COLUMNS) {
          throw inputError(
            `document.blocks[${index}] (table) must declare at most ${MAX_UI_TABLE_COLUMNS} columns (got ${columns.length})`,
          );
        }
        if (!Array.isArray(rows)) {
          throw inputError(`document.blocks[${index}] (table) needs a rows array`);
        }
        if (rows.length > MAX_UI_TABLE_ROWS) {
          throw inputError(
            `document.blocks[${index}] (table) must declare at most ${MAX_UI_TABLE_ROWS} rows (got ${rows.length})`,
          );
        }
        const normalizedColumns = columns.map((column: unknown) =>
          text2(column, `document.blocks[${index}].columns[]`),
        );
        const normalizedRows = rows.map((row: unknown) => {
          if (!Array.isArray(row)) {
            throw inputError(`document.blocks[${index}] (table) rows must be arrays`);
          }
          if (row.length !== normalizedColumns.length) {
            throw inputError(
              `document.blocks[${index}] (table) rows must have exactly ${normalizedColumns.length} cells`,
            );
          }
          return row.map((cell: unknown) => text2(cell, `document.blocks[${index}] rows cells`));
        });
        return { type, columns: normalizedColumns, rows: normalizedRows };
      }
    }
  });
  const document2: ExtensionUiDocument = { title, blocks };
  const problems = uiDocumentProblems(document2);
  if (problems.length > 0) {
    throw inputError(`the UI document is not renderable: ${problems.join('; ')}`);
  }
  return document2;
}

function text2(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw inputError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_UI_TEXT_CHARS) {
    throw inputError(`${field} must be at most ${MAX_UI_TEXT_CHARS} characters`);
  }
  return value;
}

/** A bounded JSON payload (events, telemetry, state, external bodies). */
function requireJsonPayload(value: unknown, field: string, maxBytes: number): unknown {
  const size = jsonByteLength(value);
  if (size === null) {
    throw inputError(`${field} must be a JSON value (got a non-serializable ${typeof value})`);
  }
  if (size > maxBytes) {
    throw inputError(`${field} must serialize to at most ${maxBytes} bytes (got ${size})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Deployment and rollback
// ---------------------------------------------------------------------------

/** Fully validated form of `DeployExtensionVersionInput`. */
export interface ValidatedDeployInput {
  extensionId: string | null;
  extensionKey: string | null;
  /** Exactly one of manifestId / version is set (the service resolves). */
  manifestId: string | null;
  version: string | null;
  installKey: string;
  /** Normalized grant, or null to deploy the manifest's full requested set. */
  grantedPermissions: ExtensionPermission[] | null;
  idempotencyKey: string | null;
}

export function validateDeployExtensionVersionInput(
  input: DeployExtensionVersionInput,
): ValidatedDeployInput {
  if (!isPlainObject(input)) throw inputError('deploy input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, DEPLOY_INPUT_KEYS, 'the deploy input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    const hasManifestId = input['manifestId'] !== undefined;
    const hasVersion = input['version'] !== undefined;
    if (hasManifestId === hasVersion) {
      throw inputError('exactly one of manifestId / version must be given');
    }
    const manifestId = hasManifestId ? requireUuid(input['manifestId'], 'manifestId') : null;
    let version: string | null = null;
    if (hasVersion) {
      const text = requireString(input['version'], 'version');
      if (!isSemver(text)) {
        throw inputError(`version must be a release semver (got '${text}')`);
      }
      version = text;
    }
    const grantsRaw = input['grantedPermissions'];
    const grantedPermissions =
      grantsRaw === undefined || grantsRaw === null ? null : normalizePermissions(grantsRaw);
    return {
      extensionId,
      extensionKey,
      manifestId,
      version,
      installKey: resolveInstallKey(input['installKey']),
      grantedPermissions,
      idempotencyKey: optionalIdempotencyKey(input['idempotencyKey']),
    };
  }, 'invalid_input');
}

/** Fully validated form of `RollbackExtensionDeploymentInput`. */
export interface ValidatedRollbackInput {
  extensionId: string | null;
  extensionKey: string | null;
  targetDeploymentId: string;
  installKey: string;
  idempotencyKey: string | null;
}

export function validateRollbackExtensionDeploymentInput(
  input: RollbackExtensionDeploymentInput,
): ValidatedRollbackInput {
  if (!isPlainObject(input)) throw inputError('rollback input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, ROLLBACK_INPUT_KEYS, 'the rollback input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    return {
      extensionId,
      extensionKey,
      targetDeploymentId: requireUuid(input['targetDeploymentId'], 'targetDeploymentId'),
      installKey: resolveInstallKey(input['installKey']),
      idempotencyKey: optionalIdempotencyKey(input['idempotencyKey']),
    };
  }, 'invalid_input');
}

/** Fully validated form of the deployment queries. */
export interface ValidatedDeploymentQuery {
  extensionId: string | null;
  extensionKey: string | null;
  installKey: string;
}

export function validateDeploymentQuery(query: DeploymentQuery): ValidatedDeploymentQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, DEPLOYMENT_QUERY_KEYS, 'the query');
    const { extensionId, extensionKey } = resolveSelector(query, 'exactly_one', 'invalid_query');
    return { extensionId, extensionKey, installKey: resolveInstallKey(query['installKey']) };
  });
}

export function validateListExtensionDeploymentsQuery(
  query: ListExtensionDeploymentsQuery,
): ValidatedDeploymentQuery & { limit: number } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_DEPLOYMENTS_QUERY_KEYS, 'the query');
    const { extensionId, extensionKey } = resolveSelector(query, 'exactly_one', 'invalid_query');
    return {
      extensionId,
      extensionKey,
      installKey: resolveInstallKey(query['installKey']),
      limit: requireLimit(query['limit']),
    };
  });
}

// ---------------------------------------------------------------------------
// Persistent scoped state
// ---------------------------------------------------------------------------

export function validateReadExtensionStateQuery(
  query: ReadExtensionStateQuery,
): ValidatedDeploymentQuery & { key: string; installKeyGiven: string | null } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, READ_STATE_QUERY_KEYS, 'the query');
    const { extensionId, extensionKey } = resolveSelector(query, 'exactly_one', 'invalid_query');
    const key = requireString(query['key'], 'query.key');
    if (!isStateKey(key)) {
      throw queryError(`query.key must be a state key of at most 128 characters (got '${key}')`);
    }
    const installKeyGiven =
      query['installKey'] === undefined || query['installKey'] === null
        ? null
        : resolveInstallKey(query['installKey']);
    return {
      extensionId,
      extensionKey,
      installKey: installKeyGiven ?? DEFAULT_INSTALL_KEY,
      installKeyGiven,
      key,
    };
  });
}

/** Fully validated form of `WriteExtensionStateInput`. */
export interface ValidatedWriteStateInput extends ValidatedDeploymentQuery {
  key: string;
  value: unknown;
  /** Serialized byte length of `value` (precomputed once). */
  valueBytes: number;
  /** Install key as given — null when the caller supplied none (scope check). */
  installKeyGiven: string | null;
}

export function validateWriteExtensionStateInput(input: WriteExtensionStateInput): ValidatedWriteStateInput {
  if (!isPlainObject(input)) throw inputError('state write input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, WRITE_STATE_INPUT_KEYS, 'the state write input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    const key = requireString(input['key'], 'key');
    if (!isStateKey(key)) {
      throw inputError(`key must be a state key of at most 128 characters (got '${key}')`);
    }
    if (!('value' in input)) {
      throw inputError('value is required (use null to clear while keeping the key)');
    }
    const value = requireJsonPayload(input['value'], 'value', MAX_STATE_VALUE_BYTES);
    const installKeyGiven =
      input['installKey'] === undefined || input['installKey'] === null
        ? null
        : resolveInstallKey(input['installKey']);
    return {
      extensionId,
      extensionKey,
      installKey: installKeyGiven ?? DEFAULT_INSTALL_KEY,
      installKeyGiven,
      key,
      value,
      valueBytes: jsonByteLength(value)!,
    };
  }, 'invalid_input');
}

// ---------------------------------------------------------------------------
// Declarative UI
// ---------------------------------------------------------------------------

/** Fully validated form of `PublishExtensionUiInput`. */
export interface ValidatedPublishUiInput {
  extensionId: string | null;
  extensionKey: string | null;
  surface: ExtensionUiSurface;
  document: ExtensionUiDocument;
}

export function validatePublishExtensionUiInput(input: PublishExtensionUiInput): ValidatedPublishUiInput {
  if (!isPlainObject(input)) throw inputError('UI publish input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, PUBLISH_UI_INPUT_KEYS, 'the UI publish input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    return {
      extensionId,
      extensionKey,
      surface: requireExtensionUiSurface(input['surface']),
      document: requireUiDocument(input['document']),
    };
  }, 'invalid_input');
}

export function validateGetExtensionUiQuery(
  query: GetExtensionUiQuery,
): Omit<ValidatedPublishUiInput, 'document'> {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, GET_UI_QUERY_KEYS, 'the query');
    const { extensionId, extensionKey } = resolveSelector(query, 'exactly_one', 'invalid_query');
    return { extensionId, extensionKey, surface: requireExtensionUiSurface(query['surface']) };
  });
}

// ---------------------------------------------------------------------------
// Schedules, event dispatch, external calls, telemetry
// ---------------------------------------------------------------------------

export function validateTriggerExtensionScheduleInput(
  input: TriggerExtensionScheduleInput,
): ValidatedDeploymentQuery & { scheduleName: string } {
  if (!isPlainObject(input)) throw inputError('schedule trigger input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, TRIGGER_SCHEDULE_INPUT_KEYS, 'the schedule trigger input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    const scheduleName = requireString(input['scheduleName'], 'scheduleName');
    if (!isNameSlug(scheduleName)) {
      throw inputError(`scheduleName must be a slug of at most 64 characters (got '${scheduleName}')`);
    }
    return { extensionId, extensionKey, installKey: resolveInstallKey(input['installKey']), scheduleName };
  }, 'invalid_input');
}

export function validateActivityListQuery(
  query:
    | ListExtensionScheduleRunsQuery
    | ListExtensionEventDeliveriesQuery
    | ListExtensionExternalCallsQuery
    | ListExtensionTelemetryEventsQuery,
): ValidatedDeploymentQuery & {
  limit: number;
} {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_ACTIVITY_QUERY_KEYS, 'the query');
    const { extensionId, extensionKey } = resolveSelector(query, 'exactly_one', 'invalid_query');
    return {
      extensionId,
      extensionKey,
      installKey: resolveInstallKey(query['installKey']),
      limit: requireLimit(query['limit']),
    };
  });
}

/** Fully validated form of `DispatchExtensionEventInput`. */
export interface ValidatedDispatchEventInput {
  topic: string;
  payload: unknown;
}

export function validateDispatchExtensionEventInput(
  input: DispatchExtensionEventInput,
): ValidatedDispatchEventInput {
  if (!isPlainObject(input)) throw inputError('event dispatch input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, DISPATCH_EVENT_INPUT_KEYS, 'the event dispatch input');
    const topic = requireString(input['topic'], 'topic');
    if (!isEventTopic(topic)) {
      throw inputError(`topic must be a canonical topic slug (got '${topic}')`);
    }
    // An omitted payload is a legal "no payload" dispatch (null); a
    // PRESENT payload must be a bounded JSON value.
    const payload =
      input['payload'] === undefined ? null : requireJsonPayload(input['payload'], 'payload', MAX_EVENT_PAYLOAD_BYTES);
    return { topic, payload };
  }, 'invalid_input');
}

/** Fully validated form of `ExecuteExtensionExternalCallInput`. */
export interface ValidatedExternalCallInput extends ValidatedDeploymentQuery {
  origin: string;
  method: ExtensionHttpMethod;
  path: string;
  bodyText: string | null;
  bodyBytes: number;
  headers: Record<string, string>;
}

export function validateExecuteExtensionExternalCallInput(
  input: ExecuteExtensionExternalCallInput,
): ValidatedExternalCallInput {
  if (!isPlainObject(input)) throw inputError('external call input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, EXTERNAL_CALL_INPUT_KEYS, 'the external call input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    const origin = requireString(input['origin'], 'origin');
    if (!isHttpsOrigin(origin)) {
      throw inputError(`origin must be a plain https origin (https://host[:port]; got '${origin}')`);
    }
    const method = input['method'];
    if (!isExtensionHttpMethod(method)) {
      throw inputError(
        `method must be one of ${EXTENSION_HTTP_METHODS.join(', ')} (got '${String(method)}')`,
      );
    }
    const path = requireString(input['path'], 'path');
    if (!isExternalPath(path)) {
      throw inputError(`path must start with '/' and be at most ${MAX_EXTERNAL_PATH_CHARS} characters with no fragment (got '${path}')`);
    }
    let bodyText: string | null = null;
    let bodyBytes = 0;
    const body = input['body'];
    if (body !== undefined && body !== null) {
      if (method === 'GET' || method === 'DELETE') {
        throw inputError(`method ${method} cannot carry a body`);
      }
      const payload = requireJsonPayload(body, 'body', MAX_EXTERNAL_BODY_BYTES);
      bodyText = JSON.stringify(payload);
      bodyBytes = byteLength(bodyText);
    }
    const headersRaw = input['headers'];
    const headers: Record<string, string> = {};
    if (headersRaw !== undefined && headersRaw !== null) {
      if (!isPlainObject(headersRaw)) {
        throw inputError('headers must be an object of string header names to string values');
      }
      const entries = Object.entries(headersRaw);
      if (entries.length > MAX_EXTERNAL_HEADER_COUNT) {
        throw inputError(`headers must declare at most ${MAX_EXTERNAL_HEADER_COUNT} entries (got ${entries.length})`);
      }
      for (const [name, value] of entries) {
        if (name.length === 0 || name.length > MAX_EXTERNAL_HEADER_NAME_CHARS) {
          throw inputError(`header names must be 1..${MAX_EXTERNAL_HEADER_NAME_CHARS} characters`);
        }
        if (typeof value !== 'string') {
          throw inputError(`header '${name}' must have a string value`);
        }
        if (value.length > MAX_EXTERNAL_HEADER_VALUE_CHARS) {
          throw inputError(`header '${name}' value must be at most ${MAX_EXTERNAL_HEADER_VALUE_CHARS} characters`);
        }
        headers[name] = value;
      }
    }
    return {
      extensionId,
      extensionKey,
      installKey: resolveInstallKey(input['installKey']),
      origin,
      method,
      path,
      bodyText,
      bodyBytes,
      headers,
    };
  }, 'invalid_input');
}

export function validateEmitExtensionTelemetryInput(
  input: EmitExtensionTelemetryInput,
): ValidatedDeploymentQuery & { name: string; payload: unknown } {
  if (!isPlainObject(input)) throw inputError('telemetry input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, EMIT_TELEMETRY_INPUT_KEYS, 'the telemetry input');
    const { extensionId, extensionKey } = resolveSelector(input, 'exactly_one', 'invalid_input');
    const name = requireString(input['name'], 'name');
    if (!isTelemetryName(name)) {
      throw inputError(`name must be a slug of at most 64 characters (got '${name}')`);
    }
    const payload =
      input['payload'] === undefined
        ? null
        : requireJsonPayload(input['payload'], 'payload', MAX_TELEMETRY_PAYLOAD_BYTES);
    return {
      extensionId,
      extensionKey,
      installKey: resolveInstallKey(input['installKey']),
      name,
      payload,
    };
  }, 'invalid_input');
}

// ---------------------------------------------------------------------------
// W027 — Extension Builder inputs and queries
//
// The house discipline carried over once more: unknown keys are rejected
// (a caller can never smuggle identity, provenance or timestamps), the
// brief carries its own bound, and the target version is a release
// semver — the registry's monotonicity rule is re-checked at request
// time against the tenant's current registry state by the service.
// ---------------------------------------------------------------------------

/** Maximum length of the free-form build brief. */
export const MAX_BRIEF_CHARS = 4_000;
/** Maximum length of a cancellation reason (the agents module's bound). */
export const MAX_CANCEL_REASON_CHARS = 512;

const REQUEST_BUILD_INPUT_KEYS = [
  'extensionKey',
  'version',
  'brief',
  'agentId',
  'idempotencyKey',
] as const;
const RUN_BUILD_INPUT_KEYS = ['buildId'] as const;
const CANCEL_BUILD_INPUT_KEYS = ['buildId', 'reason'] as const;
const GET_BUILD_QUERY_KEYS = ['buildId'] as const;
const LIST_BUILDS_QUERY_KEYS = ['extensionKey', 'phase', 'limit'] as const;
const LIST_BUILD_ARTIFACTS_QUERY_KEYS = ['buildId'] as const;

/** Fully validated form of `RequestExtensionBuildInput`. */
export interface ValidatedRequestBuildInput {
  extensionKey: string;
  version: string;
  brief: string;
  agentId: string;
  idempotencyKey: string | null;
}

export function validateRequestExtensionBuildInput(
  input: RequestExtensionBuildInput,
): ValidatedRequestBuildInput {
  if (!isPlainObject(input)) throw inputError('build request input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, REQUEST_BUILD_INPUT_KEYS, 'the build request input');
    const extensionKey = requireExtensionKey(input['extensionKey']);
    const version = requireString(input['version'], 'version');
    if (!isSemver(version)) {
      throw inputError(`version must be a release semver (got '${version}')`);
    }
    const brief = requireString(input['brief'], 'brief');
    if (brief.length > MAX_BRIEF_CHARS) {
      throw inputError(`brief must be at most ${MAX_BRIEF_CHARS} characters (got ${brief.length})`);
    }
    return {
      extensionKey,
      version,
      brief,
      agentId: requireUuid(input['agentId'], 'agentId'),
      idempotencyKey: optionalIdempotencyKey(input['idempotencyKey']),
    };
  }, 'invalid_input');
}

export function validateRunExtensionBuildInput(
  input: RunExtensionBuildInput,
): { buildId: string } {
  if (!isPlainObject(input)) throw inputError('build pump input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, RUN_BUILD_INPUT_KEYS, 'the build pump input');
    return { buildId: requireUuid(input['buildId'], 'buildId') };
  }, 'invalid_input');
}

export function validateCancelExtensionBuildInput(
  input: CancelExtensionBuildInput,
): { buildId: string; reason: string } {
  if (!isPlainObject(input)) throw inputError('build cancel input must be an object');
  return wrapError(() => {
    rejectUnknownKeys(input, CANCEL_BUILD_INPUT_KEYS, 'the build cancel input');
    const reason = requireString(input['reason'], 'reason');
    if (reason.length > MAX_CANCEL_REASON_CHARS) {
      throw inputError(
        `reason must be at most ${MAX_CANCEL_REASON_CHARS} characters (got ${reason.length})`,
      );
    }
    return { buildId: requireUuid(input['buildId'], 'buildId'), reason };
  }, 'invalid_input');
}

export function validateGetExtensionBuildQuery(query: GetExtensionBuildQuery): { buildId: string } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, GET_BUILD_QUERY_KEYS, 'the query');
    return { buildId: requireUuid(query['buildId'], 'query.buildId') };
  });
}

/** Fully validated form of `ListExtensionBuildsQuery`. */
export interface ValidatedListBuildsQuery {
  extensionKey: string | null;
  phase: ExtensionBuildPhase | null;
  limit: number;
}

export function validateListExtensionBuildsQuery(
  query: ListExtensionBuildsQuery,
): ValidatedListBuildsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_BUILDS_QUERY_KEYS, 'the query');
    const extensionKey =
      query['extensionKey'] === undefined || query['extensionKey'] === null
        ? null
        : requireExtensionKey(query['extensionKey'], 'query.extensionKey');
    const phase = query['phase'];
    if (phase !== undefined && phase !== null && !isExtensionBuildPhase(phase)) {
      throw queryError(
        `query.phase must be one of ${EXTENSION_BUILD_PHASES.join(', ')} (got '${String(phase)}')`,
      );
    }
    return {
      extensionKey,
      phase: (phase ?? null) as ExtensionBuildPhase | null,
      limit: requireLimit(query['limit']),
    };
  });
}

export function validateListExtensionBuildArtifactsQuery(
  query: ListExtensionBuildArtifactsQuery,
): { buildId: string } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_BUILD_ARTIFACTS_QUERY_KEYS, 'the query');
    return { buildId: requireUuid(query['buildId'], 'query.buildId') };
  });
}
