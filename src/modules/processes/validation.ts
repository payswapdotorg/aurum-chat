// Pure validation/normalization logic of the processes module (no
// database). Everything a caller may put into a reconstruction or query
// crosses these guards first; the SQL CHECK constraints in
// migrations/001-processes.sql mirror the load-bearing rules as defense in
// depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `changeKind`, `recordedAt`, `detectedAt`,
// `detectedByPrincipal` or `changedByPrincipal` into an input — the
// process's identity, tenancy, version number, change classification,
// commit time and acting principal are minted by the system (process
// reconstructions are auditable, and audit fields are not caller-forgeable).
//
// Activity classifications (event `type`s, observation `kind`s, error
// activity types) are validated against the SAME pattern the events and
// observations modules enforce (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`), so
// every validated scope provably passes the sibling contracts' own query
// validation — the read path can never fail on a shape this module accepted.

import type { TenantContext } from '@/infra/tenant';
import { ProcessesError } from './errors';
import type {
  GetProcessFindingQuery,
  GetProcessVersionQuery,
  ListProcessFindingsQuery,
  ListProcessesQuery,
  ListProcessVersionsQuery,
  ProcessFindingKind,
  ProcessPartyKind,
  ProcessScope,
  ReconstructProcessInput,
  ReconstructionOptions,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const PROCESS_FINDING_KINDS = [
  'bottleneck',
  'duplication',
  'handoff',
  'manual_effort',
  'error',
] as const;

export const PROCESS_CHANGE_KINDS = ['created', 'reconstructed'] as const;

/** Kinds of parties that can trigger a reconstruction (audit actor). */
export const PROCESS_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** Default error-activity suffixes (detection.ts owns the matching logic). */
export const DEFAULT_ERROR_ACTIVITY_SUFFIXES = ['.failed', '.error', '.rejected'] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_NAME_LENGTH = 200;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;

/** Event types / observation kinds per scope (each; the union may be both). */
export const MAX_ACTIVITY_TYPES = 32;
/** Caller-declared extra error activity types. */
export const MAX_ERROR_ACTIVITY_TYPES = 64;
/** Payload case-key candidates (priority-ordered). */
export const MAX_CASE_KEY_CANDIDATES = 8;
/** Case-key name: a JSON payload property name (JS-identifier-shaped). */
export const MAX_CASE_KEY_LENGTH = 64;

export const DEFAULT_MAX_EVENTS = 2000;
export const MAX_MAX_EVENTS = 5000;
export const DEFAULT_MIN_EDGE_INSTANCES = 2;
export const MAX_MIN_EDGE_INSTANCES = 100;
export const DEFAULT_MANUAL_SHARE_THRESHOLD = 0.5;
/** Evidence refs cited per finding (most recent first beyond the cap). */
export const MAX_FINDING_EVIDENCE_REFS = 32;
/** Findings per version (a broader scope is refused, never truncated). */
export const MAX_FINDINGS_PER_VERSION = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Identical to the events module's TYPE_PATTERN and the observations
// module's KIND_PATTERN — see the file header.
const ACTIVITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CASE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Strict ISO 8601 with an explicit offset (IMPLEMENTATION-STACK §8) — the
// same shape the events/observations query guards accept.
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const RECONSTRUCT_INPUT_KEYS = [
  'name',
  'scope',
  'expectedVersion',
  'options',
  'actor',
  'rationale',
] as const;
const SCOPE_KEYS = [
  'eventTypes',
  'observationKinds',
  'caseKeyCandidates',
  'occurredFrom',
  'occurredTo',
  'worldEntityId',
] as const;
const OPTIONS_KEYS = [
  'bottleneckThresholdSeconds',
  'minEdgeInstances',
  'manualShareThreshold',
  'errorActivityTypes',
  'maxEvents',
] as const;
const PARTY_KEYS = ['kind', 'id', 'label'] as const;

export function isProcessFindingKind(value: unknown): value is ProcessFindingKind {
  return (
    typeof value === 'string' &&
    (PROCESS_FINDING_KINDS as readonly string[]).includes(value)
  );
}

export function isProcessPartyKind(value: unknown): value is ProcessPartyKind {
  return (
    typeof value === 'string' &&
    (PROCESS_PARTY_KINDS as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertProcessTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ProcessesError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ProcessesError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ProcessesError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
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
      throw new ProcessesError(
        'invalid_reconstruction_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function inputError(message: string): ProcessesError {
  return new ProcessesError('invalid_reconstruction_input', message);
}

function queryError(message: string): ProcessesError {
  return new ProcessesError('invalid_process_query', message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  return text === '' ? null : text;
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/** Case-insensitive ILIKE wildcard escaping (the missions module's helper). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

/** One validated activity classification (event type / observation kind). */
function requireActivityType(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!ACTIVITY_PATTERN.test(text)) {
    throw inputError(
      `${field} must be a canonical activity classification matching ${ACTIVITY_PATTERN.source} (got '${text}')`,
    );
  }
  return text;
}

/**
 * A validated, deduplicated activity-type list. `sorted` keeps the stored
 * scope canonical (event types, observation kinds, error types); the
 * case-key candidates keep CALLER order (priority semantics: first match
 * wins) and are deduplicated only.
 */
function requireActivityTypeList(
  value: unknown,
  field: string,
  max: number,
): string[] {
  if (!Array.isArray(value)) {
    throw inputError(`${field} must be an array of activity classifications`);
  }
  if (value.length > max) {
    throw inputError(`${field} supports at most ${max} entries (got ${value.length})`);
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const normalized = requireActivityType(entry, `${field}[${index}]`);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Party (audit actor)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ProcessParty`. */
export interface ValidatedParty {
  kind: ProcessPartyKind;
  id: string | null;
  label: string | null;
}

function validateParty(value: unknown, where: string): ValidatedParty {
  if (!isPlainObject(value)) {
    throw inputError(`${where} must be an object`);
  }
  rejectUnknownKeys(value, PARTY_KEYS, where);
  if (!isProcessPartyKind(value.kind)) {
    throw inputError(
      `${where}.kind must be one of ${PROCESS_PARTY_KINDS.join(', ')} (got '${String(value.kind)}')`,
    );
  }
  const id = optionalTrimmed(value.id, `${where}.id`);
  const label = optionalTrimmed(value.label, `${where}.label`);
  if (label !== null && label.length > MAX_PARTY_LABEL_LENGTH) {
    throw inputError(`${where}.label must be at most ${MAX_PARTY_LABEL_LENGTH} characters`);
  }
  if (id === null && label === null) {
    throw inputError(`${where} must carry an id or a label — audit actors are traceable`);
  }
  return { kind: value.kind, id, label };
}

// ---------------------------------------------------------------------------
// reconstructProcess input
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ReconstructProcessInput`. */
export interface ValidatedReconstructionInput {
  name: string;
  scope: ProcessScope;
  expectedVersion: number | null;
  options: ReconstructionOptions;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReconstructProcessInput(
  input: ReconstructProcessInput,
): ValidatedReconstructionInput {
  if (!isPlainObject(input)) {
    throw inputError('reconstruction input must be an object');
  }
  rejectUnknownKeys(input, RECONSTRUCT_INPUT_KEYS, 'the reconstruction input');

  const name = requireString(input.name, 'name');
  if (name.length > MAX_NAME_LENGTH) {
    throw inputError(`name must be at most ${MAX_NAME_LENGTH} characters (got ${name.length})`);
  }

  // --- scope (the evidence declaration) ---
  if (!isPlainObject(input.scope)) {
    throw inputError('scope must be an object');
  }
  rejectUnknownKeys(input.scope, SCOPE_KEYS, 'scope');

  const eventTypes =
    input.scope.eventTypes === undefined
      ? []
      : requireActivityTypeList(input.scope.eventTypes, 'scope.eventTypes', MAX_ACTIVITY_TYPES);
  const observationKinds =
    input.scope.observationKinds === undefined
      ? []
      : requireActivityTypeList(
          input.scope.observationKinds,
          'scope.observationKinds',
          MAX_ACTIVITY_TYPES,
        );
  if (eventTypes.length === 0 && observationKinds.length === 0) {
    throw inputError(
      'scope must declare at least one event type or observation kind — a reconstruction declares its evidence, it never trawls the whole log',
    );
  }

  const caseKeyCandidates: string[] = [];
  if (input.scope.caseKeyCandidates !== undefined) {
    if (!Array.isArray(input.scope.caseKeyCandidates)) {
      throw inputError('scope.caseKeyCandidates must be an array of payload key names');
    }
    if (input.scope.caseKeyCandidates.length > MAX_CASE_KEY_CANDIDATES) {
      throw inputError(
        `scope.caseKeyCandidates supports at most ${MAX_CASE_KEY_CANDIDATES} entries`,
      );
    }
    for (const [index, candidate] of input.scope.caseKeyCandidates.entries()) {
      if (typeof candidate !== 'string' || !CASE_KEY_PATTERN.test(candidate)) {
        throw inputError(
          `scope.caseKeyCandidates[${index}] must be a payload key name matching ${CASE_KEY_PATTERN.source} (got '${String(candidate)}')`,
        );
      }
      if (!caseKeyCandidates.includes(candidate)) caseKeyCandidates.push(candidate);
    }
  }

  const occurredFrom =
    input.scope.occurredFrom === undefined || input.scope.occurredFrom === null
      ? null
      : requireIsoInstant(input.scope.occurredFrom, 'scope.occurredFrom');
  const occurredTo =
    input.scope.occurredTo === undefined || input.scope.occurredTo === null
      ? null
      : requireIsoInstant(input.scope.occurredTo, 'scope.occurredTo');
  if (occurredFrom !== null && occurredTo !== null && occurredFrom > occurredTo) {
    throw inputError('scope.occurredFrom must not be after scope.occurredTo');
  }

  const worldEntityId =
    input.scope.worldEntityId === undefined || input.scope.worldEntityId === null
      ? null
      : requireUuid(input.scope.worldEntityId, 'scope.worldEntityId');

  const scope: ProcessScope = {
    // Canonical storage order for the reference sets (case keys keep caller
    // priority order — see requireActivityTypeList).
    eventTypes: [...eventTypes].sort(),
    observationKinds: [...observationKinds].sort(),
    caseKeyCandidates,
    occurredFrom,
    occurredTo,
    worldEntityId,
  };

  // --- optimistic concurrency ---
  let expectedVersion: number | null = null;
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    if (
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw inputError(
        `expectedVersion must be an integer ≥ 1 (got ${String(input.expectedVersion)})`,
      );
    }
    expectedVersion = input.expectedVersion;
  }

  // --- detection options ---
  const optionsRaw = input.options === undefined ? {} : input.options;
  if (!isPlainObject(optionsRaw)) {
    throw inputError('options must be an object');
  }
  rejectUnknownKeys(optionsRaw, OPTIONS_KEYS, 'options');

  let bottleneckThresholdSeconds: number | null = null;
  if (
    optionsRaw.bottleneckThresholdSeconds !== undefined &&
    optionsRaw.bottleneckThresholdSeconds !== null
  ) {
    const value = optionsRaw.bottleneckThresholdSeconds;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw inputError(
        `options.bottleneckThresholdSeconds must be a finite number > 0, or null for the derived default (got ${String(value)})`,
      );
    }
    bottleneckThresholdSeconds = value;
  }

  let minEdgeInstances = DEFAULT_MIN_EDGE_INSTANCES;
  if (optionsRaw.minEdgeInstances !== undefined && optionsRaw.minEdgeInstances !== null) {
    const value = optionsRaw.minEdgeInstances;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_MIN_EDGE_INSTANCES
    ) {
      throw inputError(
        `options.minEdgeInstances must be an integer in [1, ${MAX_MIN_EDGE_INSTANCES}] (got ${String(value)})`,
      );
    }
    minEdgeInstances = value;
  }

  let manualShareThreshold = DEFAULT_MANUAL_SHARE_THRESHOLD;
  if (optionsRaw.manualShareThreshold !== undefined && optionsRaw.manualShareThreshold !== null) {
    const value = optionsRaw.manualShareThreshold;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
      throw inputError(
        `options.manualShareThreshold must be a finite number in (0, 1] (got ${String(value)})`,
      );
    }
    manualShareThreshold = value;
  }

  const errorActivityTypes =
    optionsRaw.errorActivityTypes === undefined
      ? []
      : requireActivityTypeList(
          optionsRaw.errorActivityTypes,
          'options.errorActivityTypes',
          MAX_ERROR_ACTIVITY_TYPES,
        ).sort();

  let maxEvents = DEFAULT_MAX_EVENTS;
  if (optionsRaw.maxEvents !== undefined && optionsRaw.maxEvents !== null) {
    const value = optionsRaw.maxEvents;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_MAX_EVENTS
    ) {
      throw inputError(
        `options.maxEvents must be an integer in [1, ${MAX_MAX_EVENTS}] (got ${String(value)})`,
      );
    }
    maxEvents = value;
  }

  const options: ReconstructionOptions = {
    bottleneckThresholdSeconds,
    minEdgeInstances,
    manualShareThreshold,
    errorActivityTypes,
    maxEvents,
  };

  // --- audit ---
  const actor = validateParty(input.actor, 'actor');
  const rationale = optionalTrimmed(input.rationale, 'rationale');
  if (rationale !== null && rationale.length > MAX_RATIONALE_LENGTH) {
    throw inputError(`rationale must be at most ${MAX_RATIONALE_LENGTH} characters`);
  }

  return { name, scope, expectedVersion, options, actor, rationale };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

function requireQueryUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw queryError(`${field} must be a uuid (got '${String(value)}')`);
  }
  return value.toLowerCase();
}

function requireQueryInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw queryError(`${field} must be an integer in [${min}, ${max}] (got ${String(value)})`);
  }
  return value;
}

/** Fully validated + normalized form of `GetProcessVersionQuery`. */
export interface ValidatedVersionQuery {
  processId: string;
  version: number;
}

export function validateVersionQuery(query: GetProcessVersionQuery): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(['processId', 'version'] as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: processId, version)`);
  }
  return {
    processId: requireQueryUuid(query.processId, 'query.processId'),
    version: requireQueryInt(query.version, 'query.version', 1, Number.MAX_SAFE_INTEGER),
  };
}

/** Fully validated + normalized form of `ListProcessVersionsQuery`. */
export interface ValidatedHistoryQuery {
  processId: string;
}

export function validateHistoryQuery(query: ListProcessVersionsQuery): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'processId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: processId)`);
  }
  return { processId: requireQueryUuid(query.processId, 'query.processId') };
}

/** Fully validated + normalized form of `ListProcessFindingsQuery`. */
export interface ValidatedFindingsQuery {
  processId: string;
  /** null = the process's current version. */
  version: number | null;
  kind: ProcessFindingKind | null;
  minConfidence: number;
  limit: number;
}

const FINDINGS_QUERY_KEYS = [
  'processId',
  'version',
  'kind',
  'minConfidence',
  'limit',
] as const;

export function validateFindingsQuery(query: ListProcessFindingsQuery): ValidatedFindingsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(FINDINGS_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${FINDINGS_QUERY_KEYS.join(', ')})`,
    );
  }

  const processId = requireQueryUuid(query.processId, 'query.processId');
  const version =
    query.version === undefined || query.version === null
      ? null
      : requireQueryInt(query.version, 'query.version', 1, Number.MAX_SAFE_INTEGER);

  let kind: ProcessFindingKind | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (!isProcessFindingKind(query.kind)) {
      throw queryError(
        `query.kind must be one of ${PROCESS_FINDING_KINDS.join(', ')} (got '${String(query.kind)}')`,
      );
    }
    kind = query.kind;
  }

  let minConfidence = 0;
  if (query.minConfidence !== undefined && query.minConfidence !== null) {
    const value = query.minConfidence;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw queryError(
        `query.minConfidence must be a finite number in [0, 1] (got ${String(value)})`,
      );
    }
    minConfidence = value;
  }

  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw queryError(`query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }

  return { processId, version, kind, minConfidence, limit };
}

/** Fully validated + normalized form of `GetProcessFindingQuery`. */
export interface ValidatedFindingQuery {
  findingId: string;
}

export function validateFindingQuery(query: GetProcessFindingQuery): ValidatedFindingQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'findingId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: findingId)`);
  }
  return { findingId: requireQueryUuid(query.findingId, 'query.findingId') };
}

/** Fully validated + normalized form of `ListProcessesQuery`. */
export interface ValidatedListQuery {
  name: string | null;
  search: string | null;
  limit: number;
}

const LIST_QUERY_KEYS = ['name', 'search', 'limit'] as const;

export function validateListProcessesQuery(query: ListProcessesQuery): ValidatedListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: ${LIST_QUERY_KEYS.join(', ')})`);
  }

  const name = optionalTrimmed(query.name, 'query.name');
  if (name !== null && name.length > MAX_NAME_LENGTH) {
    throw queryError(`query.name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  const search = optionalTrimmed(query.search, 'query.search');
  if (search !== null && search.length > MAX_SEARCH_LENGTH) {
    throw queryError(`query.search must be at most ${MAX_SEARCH_LENGTH} characters`);
  }
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw queryError(`query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }
  return { name, search, limit };
}

/** Process-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
