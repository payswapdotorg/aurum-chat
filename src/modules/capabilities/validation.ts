// Pure validation/normalization logic of the capabilities module (no
// database). Everything a caller may put into a registration, revision or
// query crosses these guards first; the SQL CHECK constraints in
// migrations/001-capabilities.sql mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `changeKind`, `status` of the *identity*, commit
// times or acting principals into an input — identity, tenancy, version
// number, change classification and audit fields are minted by the system
// (the goals/processes discipline: capability-graph records are auditable,
// and audit fields are not caller-forgeable). The supplier of a supply and
// the source of a requirement are IMMUtable identity content — the revise
// inputs do not even accept those keys, so a different supplier/source can
// only ever be expressed as a new record, never by rewriting one.
//
// Parties (suppliers, requirement sources, audit actors) are opaque
// provider-neutral references (lock 16): free-form ids (uuids where the
// owning module uses them) and/or labels — unverified here by design (the
// events/observations precedent; the owning modules stay non-dependencies).
// `worldEntityId` and `evidenceObservationIds` are shape-checked uuid
// forward references the same way.

import type { TenantContext } from '@/infra/tenant';
import { CapabilitiesError, type CapabilitiesErrorCode } from './errors';
import type {
  AnalyzeGapsQuery,
  CapabilityPartyKind,
  CapabilityRecordStatus,
  CapabilitySupplierKind,
  GetCapabilityVersionQuery,
  GetRequirementVersionQuery,
  GetSupplyVersionQuery,
  GapStatus,
  ListCapabilitiesQuery,
  ListCapabilityVersionsQuery,
  ListRequirementsQuery,
  ListRequirementVersionsQuery,
  ListSupplyVersionsQuery,
  ListSuppliesQuery,
  RegisterCapabilityInput,
  RegisterRequirementInput,
  RegisterSupplyInput,
  RequirementSourceKind,
  ReviseCapabilityInput,
  ReviseRequirementInput,
  ReviseSupplyInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/** The six supplier kinds the W017 work item names verbatim. */
export const CAPABILITY_SUPPLIER_KINDS = [
  'employee',
  'team',
  'agent',
  'software',
  'supplier',
  'partner',
] as const;

/** The five demand-source kinds (see types.ts). */
export const REQUIREMENT_SOURCE_KINDS = [
  'goal',
  'process',
  'project',
  'opportunity',
  'manual',
] as const;

/** Audit-actor kinds (the events envelope's actor vocabulary minus `source`). */
export const CAPABILITY_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

export const CAPABILITY_RECORD_STATUSES = ['active', 'retired'] as const;

export const GAP_STATUSES = [
  'uncovered',
  'level_shortfall',
  'capacity_shortfall',
  'covered',
] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_NAME_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2000; // description / note / rationale
export const MAX_PARTY_LENGTH = 200; // party id / label
export const MAX_SEARCH_LENGTH = 200;

/** Evidence observation references per supply (deduplicated). */
export const MAX_EVIDENCE_REFS = 32;

/**
 * Gap-analysis candidate bound: the analysis loads current records for at
 * most this many demand-bearing capabilities per call (deterministic
 * name/id order — the observations module's documented bounded-window
 * precedent; the result `limit` applies after the status filter).
 */
export const MAX_ANALYSIS_CAPABILITIES = 500;

/** Capacity bounds: null = undeclared, else a finite number in [0, MAX_CAPACITY]. */
export const MAX_CAPACITY = 1_000_000_000;

/** Supply level default: full strength unless stated otherwise. */
export const DEFAULT_SUPPLY_LEVEL = 1;
/** Requirement level default: presence suffices (no minimum proficiency). */
export const DEFAULT_REQUIREMENT_LEVEL = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Guards and helpers
// ---------------------------------------------------------------------------

export function isCapabilitySupplierKind(value: unknown): value is CapabilitySupplierKind {
  return (
    typeof value === 'string' &&
    (CAPABILITY_SUPPLIER_KINDS as readonly string[]).includes(value)
  );
}

export function isRequirementSourceKind(value: unknown): value is RequirementSourceKind {
  return (
    typeof value === 'string' &&
    (REQUIREMENT_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isCapabilityPartyKind(value: unknown): value is CapabilityPartyKind {
  return (
    typeof value === 'string' &&
    (CAPABILITY_PARTY_KINDS as readonly string[]).includes(value)
  );
}

export function isCapabilityRecordStatus(value: unknown): value is CapabilityRecordStatus {
  return (
    typeof value === 'string' &&
    (CAPABILITY_RECORD_STATUSES as readonly string[]).includes(value)
  );
}

export function isGapStatus(value: unknown): value is GapStatus {
  return typeof value === 'string' && (GAP_STATUSES as readonly string[]).includes(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertCapabilitiesTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new CapabilitiesError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new CapabilitiesError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new CapabilitiesError(
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
  code: CapabilitiesErrorCode,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new CapabilitiesError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function inputError(
  code: 'invalid_capability_input' | 'invalid_supply_input' | 'invalid_requirement_input',
  message: string,
): CapabilitiesError {
  return new CapabilitiesError(code, message);
}

function queryError(message: string): CapabilitiesError {
  return new CapabilitiesError('invalid_query', message);
}

function requireString(value: unknown, field: string, code: Parameters<typeof inputError>[0]): string {
  if (typeof value !== 'string') throw inputError(code, `${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(code, `${field} must be a non-empty string`);
  return text;
}

/** Nullable text: undefined/null → null; else trimmed non-empty ≤ max chars. */
function optionalText(
  value: unknown,
  field: string,
  max: number,
  code: Parameters<typeof inputError>[0],
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, code);
  if (text.length > max) {
    throw inputError(code, `${field} must be at most ${max} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(value: unknown, field: string, code: Parameters<typeof inputError>[0]): string {
  const text = requireString(value, field, code);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(code, `${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/** Case-insensitive ILIKE wildcard escaping (the missions module's helper). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Proficiency level in [0, 1]. */
function requireLevel(
  value: unknown,
  field: string,
  code: Parameters<typeof inputError>[0],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw inputError(code, `${field} must be a finite number in [0, 1] (got ${String(value)})`);
  }
  return value;
}

/** Capacity: null = undeclared, else a finite number in [0, MAX_CAPACITY]. */
function requireCapacity(
  value: unknown,
  field: string,
  code: Parameters<typeof inputError>[0],
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_CAPACITY
  ) {
    throw inputError(
      code,
      `${field} must be null (undeclared) or a finite number in [0, ${MAX_CAPACITY}] (got ${String(value)})`,
    );
  }
  return value;
}

/** Evidence observation ids: uuids, ≤ MAX_EVIDENCE_REFS, deduplicated in order. */
function requireEvidenceIds(
  value: unknown,
  field: string,
  code: Parameters<typeof inputError>[0],
): string[] {
  if (!Array.isArray(value)) {
    throw inputError(code, `${field} must be an array of observation uuids`);
  }
  if (value.length > MAX_EVIDENCE_REFS) {
    throw inputError(
      code,
      `${field} supports at most ${MAX_EVIDENCE_REFS} references (got ${value.length})`,
    );
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const id = requireUuid(entry, `${field}[${index}]`, code);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parties (audit actors, suppliers, requirement sources)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of a party (kind + id/label, ≥ one present). */
export interface ValidatedParty {
  kind: string;
  id: string | null;
  label: string | null;
}

const PARTY_KEYS = ['kind', 'id', 'label'] as const;

function validateParty(
  value: unknown,
  where: string,
  kinds: readonly string[],
  code: Parameters<typeof inputError>[0],
): ValidatedParty {
  if (!isPlainObject(value)) throw inputError(code, `${where} must be an object`);
  rejectUnknownKeys(value, PARTY_KEYS, where, code);
  const kind = value.kind;
  if (typeof kind !== 'string' || !kinds.includes(kind)) {
    throw inputError(code, `${where}.kind must be one of ${kinds.join(', ')} (got '${String(kind)}')`);
  }
  const id = optionalText(value.id, `${where}.id`, MAX_PARTY_LENGTH, code);
  const label = optionalText(value.label, `${where}.label`, MAX_PARTY_LENGTH, code);
  if (id === null && label === null) {
    throw inputError(
      code,
      `${where} must carry an id or a label — suppliers, demand sources and audit actors are traceable`,
    );
  }
  return { kind, id, label };
}

/** The storage key of a validated party: its id, else its label. */
export function partyKeyOf(party: ValidatedParty): string {
  return party.id ?? party.label!;
}

function validateActor(value: unknown, code: Parameters<typeof inputError>[0]): ValidatedParty {
  return validateParty(value, 'actor', CAPABILITY_PARTY_KINDS, code);
}

function validateSupplier(value: unknown): ValidatedParty {
  return validateParty(value, 'supplier', CAPABILITY_SUPPLIER_KINDS, 'invalid_supply_input');
}

function validateSource(value: unknown): ValidatedParty {
  return validateParty(value, 'source', REQUIREMENT_SOURCE_KINDS, 'invalid_requirement_input');
}

// ---------------------------------------------------------------------------
// Capability register / revise
// ---------------------------------------------------------------------------

const REGISTER_CAPABILITY_KEYS = ['name', 'description', 'worldEntityId', 'actor', 'rationale'] as const;
const REVISE_CAPABILITY_KEYS = [
  'capabilityId',
  'description',
  'worldEntityId',
  'status',
  'actor',
  'rationale',
] as const;

/** Fully validated + normalized form of `RegisterCapabilityInput`. */
export interface ValidatedRegisterCapabilityInput {
  name: string;
  description: string | null;
  worldEntityId: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRegisterCapabilityInput(
  input: RegisterCapabilityInput,
): ValidatedRegisterCapabilityInput {
  const code = 'invalid_capability_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'capability registration must be an object');
  rejectUnknownKeys(input, REGISTER_CAPABILITY_KEYS, 'the capability registration', code);

  const name = requireString(input.name, 'name', code);
  if (name.length > MAX_NAME_LENGTH) {
    throw inputError(code, `name must be at most ${MAX_NAME_LENGTH} characters (got ${name.length})`);
  }
  const description = optionalText(input.description, 'description', MAX_TEXT_LENGTH, code);
  const worldEntityId =
    input.worldEntityId === undefined || input.worldEntityId === null
      ? null
      : requireUuid(input.worldEntityId, 'worldEntityId', code);

  return {
    name,
    description,
    worldEntityId,
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

/** The validated patch fields of a capability revision (undefined = carry over). */
export interface ValidatedCapabilityPatch {
  /** Tri-state: undefined = unchanged, null = cleared, string = set. */
  description?: string | null;
  /** Tri-state: undefined = unchanged, null = cleared, uuid = set. */
  worldEntityId?: string | null;
  status?: CapabilityRecordStatus;
}

/** Fully validated + normalized form of `ReviseCapabilityInput`. */
export interface ValidatedReviseCapabilityInput {
  capabilityId: string;
  patch: ValidatedCapabilityPatch;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseCapabilityInput(
  input: ReviseCapabilityInput,
): ValidatedReviseCapabilityInput {
  const code = 'invalid_capability_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'capability revision must be an object');
  rejectUnknownKeys(input, REVISE_CAPABILITY_KEYS, 'the capability revision', code);

  const capabilityId = requireUuid(input.capabilityId, 'capabilityId', code);

  const patch: ValidatedCapabilityPatch = {};
  const changed: string[] = [];
  if (input.description !== undefined) {
    patch.description = optionalText(input.description, 'description', MAX_TEXT_LENGTH, code);
    changed.push('description');
  }
  if (input.worldEntityId !== undefined) {
    patch.worldEntityId =
      input.worldEntityId === null
        ? null
        : requireUuid(input.worldEntityId, 'worldEntityId', code);
    changed.push('worldEntityId');
  }
  if (input.status !== undefined) {
    if (!isCapabilityRecordStatus(input.status)) {
      throw inputError(
        code,
        `status must be one of ${CAPABILITY_RECORD_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    patch.status = input.status;
    changed.push('status');
  }
  assertSurgicalRevision(changed, patch.status, code, 'description, worldEntityId or status');

  return {
    capabilityId,
    patch,
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

// ---------------------------------------------------------------------------
// Supply register / revise
// ---------------------------------------------------------------------------

const REGISTER_SUPPLY_KEYS = [
  'capabilityId',
  'supplier',
  'level',
  'capacity',
  'evidenceObservationIds',
  'note',
  'actor',
  'rationale',
] as const;
const REVISE_SUPPLY_KEYS = [
  'supplyId',
  'level',
  'capacity',
  'status',
  'evidenceObservationIds',
  'note',
  'actor',
  'rationale',
] as const;

/** Fully validated + normalized form of `RegisterSupplyInput`. */
export interface ValidatedRegisterSupplyInput {
  capabilityId: string;
  supplier: ValidatedParty;
  level: number;
  capacity: number | null;
  evidenceObservationIds: string[];
  note: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRegisterSupplyInput(
  input: RegisterSupplyInput,
): ValidatedRegisterSupplyInput {
  const code = 'invalid_supply_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'supply registration must be an object');
  rejectUnknownKeys(input, REGISTER_SUPPLY_KEYS, 'the supply registration', code);

  const capabilityId = requireUuid(input.capabilityId, 'capabilityId', code);
  const level =
    input.level === undefined ? DEFAULT_SUPPLY_LEVEL : requireLevel(input.level, 'level', code);
  const capacity = requireCapacity(input.capacity, 'capacity', code);
  const evidenceObservationIds =
    input.evidenceObservationIds === undefined
      ? []
      : requireEvidenceIds(input.evidenceObservationIds, 'evidenceObservationIds', code);

  return {
    capabilityId,
    supplier: validateSupplier(input.supplier),
    level,
    capacity,
    evidenceObservationIds,
    note: optionalText(input.note, 'note', MAX_TEXT_LENGTH, code),
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

/** The validated patch fields of a supply revision (undefined = carry over). */
export interface ValidatedSupplyPatch {
  level?: number;
  /** Tri-state: undefined = unchanged, null = cleared, number = set. */
  capacity?: number | null;
  status?: CapabilityRecordStatus;
  /** Replaces the previous evidence list wholesale. */
  evidenceObservationIds?: string[];
  /** Tri-state: undefined = unchanged, null = cleared, string = set. */
  note?: string | null;
}

/** Fully validated + normalized form of `ReviseSupplyInput`. */
export interface ValidatedReviseSupplyInput {
  supplyId: string;
  patch: ValidatedSupplyPatch;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseSupplyInput(input: ReviseSupplyInput): ValidatedReviseSupplyInput {
  const code = 'invalid_supply_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'supply revision must be an object');
  rejectUnknownKeys(input, REVISE_SUPPLY_KEYS, 'the supply revision', code);

  const supplyId = requireUuid(input.supplyId, 'supplyId', code);

  const patch: ValidatedSupplyPatch = {};
  const changed: string[] = [];
  if (input.level !== undefined) {
    patch.level = requireLevel(input.level, 'level', code);
    changed.push('level');
  }
  if (input.capacity !== undefined) {
    patch.capacity = requireCapacity(input.capacity, 'capacity', code);
    changed.push('capacity');
  }
  if (input.status !== undefined) {
    if (!isCapabilityRecordStatus(input.status)) {
      throw inputError(
        code,
        `status must be one of ${CAPABILITY_RECORD_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    patch.status = input.status;
    changed.push('status');
  }
  if (input.evidenceObservationIds !== undefined) {
    patch.evidenceObservationIds = requireEvidenceIds(
      input.evidenceObservationIds,
      'evidenceObservationIds',
      code,
    );
    changed.push('evidenceObservationIds');
  }
  if (input.note !== undefined) {
    patch.note = optionalText(input.note, 'note', MAX_TEXT_LENGTH, code);
    changed.push('note');
  }
  assertSurgicalRevision(
    changed,
    patch.status,
    code,
    'level, capacity, evidenceObservationIds, note or status',
  );

  return {
    supplyId,
    patch,
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

// ---------------------------------------------------------------------------
// Requirement register / revise
// ---------------------------------------------------------------------------

const REGISTER_REQUIREMENT_KEYS = [
  'capabilityId',
  'source',
  'level',
  'capacity',
  'note',
  'actor',
  'rationale',
] as const;
const REVISE_REQUIREMENT_KEYS = [
  'requirementId',
  'level',
  'capacity',
  'status',
  'note',
  'actor',
  'rationale',
] as const;

/** Fully validated + normalized form of `RegisterRequirementInput`. */
export interface ValidatedRegisterRequirementInput {
  capabilityId: string;
  source: ValidatedParty;
  level: number;
  capacity: number | null;
  note: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRegisterRequirementInput(
  input: RegisterRequirementInput,
): ValidatedRegisterRequirementInput {
  const code = 'invalid_requirement_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'requirement registration must be an object');
  rejectUnknownKeys(input, REGISTER_REQUIREMENT_KEYS, 'the requirement registration', code);

  const capabilityId = requireUuid(input.capabilityId, 'capabilityId', code);
  const level =
    input.level === undefined
      ? DEFAULT_REQUIREMENT_LEVEL
      : requireLevel(input.level, 'level', code);
  const capacity = requireCapacity(input.capacity, 'capacity', code);

  return {
    capabilityId,
    source: validateSource(input.source),
    level,
    capacity,
    note: optionalText(input.note, 'note', MAX_TEXT_LENGTH, code),
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

/** The validated patch fields of a requirement revision (undefined = carry over). */
export interface ValidatedRequirementPatch {
  level?: number;
  /** Tri-state: undefined = unchanged, null = cleared, number = set. */
  capacity?: number | null;
  status?: CapabilityRecordStatus;
  /** Tri-state: undefined = unchanged, null = cleared, string = set. */
  note?: string | null;
}

/** Fully validated + normalized form of `ReviseRequirementInput`. */
export interface ValidatedReviseRequirementInput {
  requirementId: string;
  patch: ValidatedRequirementPatch;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseRequirementInput(
  input: ReviseRequirementInput,
): ValidatedReviseRequirementInput {
  const code = 'invalid_requirement_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'requirement revision must be an object');
  rejectUnknownKeys(input, REVISE_REQUIREMENT_KEYS, 'the requirement revision', code);

  const requirementId = requireUuid(input.requirementId, 'requirementId', code);

  const patch: ValidatedRequirementPatch = {};
  const changed: string[] = [];
  if (input.level !== undefined) {
    patch.level = requireLevel(input.level, 'level', code);
    changed.push('level');
  }
  if (input.capacity !== undefined) {
    patch.capacity = requireCapacity(input.capacity, 'capacity', code);
    changed.push('capacity');
  }
  if (input.status !== undefined) {
    if (!isCapabilityRecordStatus(input.status)) {
      throw inputError(
        code,
        `status must be one of ${CAPABILITY_RECORD_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    patch.status = input.status;
    changed.push('status');
  }
  if (input.note !== undefined) {
    patch.note = optionalText(input.note, 'note', MAX_TEXT_LENGTH, code);
    changed.push('note');
  }
  assertSurgicalRevision(changed, patch.status, code, 'level, capacity, note or status');

  return {
    requirementId,
    patch,
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

/**
 * The goals module's revision discipline: a revision must change at least
 * one field, and a status change must be the ONLY change — lifecycle
 * transitions are surgical so the audit trail never conflates them with
 * content revisions.
 */
function assertSurgicalRevision(
  changed: string[],
  status: CapabilityRecordStatus | undefined,
  code: Parameters<typeof inputError>[0],
  fields: string,
): void {
  if (changed.length === 0) {
    throw inputError(code, `a revision must change at least one field (${fields})`);
  }
  if (status !== undefined && changed.length > 1) {
    throw inputError(
      code,
      `a status change must be the only change in its revision (also changed: ${changed
        .filter((field) => field !== 'status')
        .join(', ')}) — lifecycle transitions are surgical so the audit trail never conflates them with content revisions`,
    );
  }
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

function requireQueryInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw queryError(`${field} must be an integer in [${min}, ${max}] (got ${String(value)})`);
  }
  return value;
}

function requireQueryLimit(value: unknown): number {
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

function requireQueryStatus(value: unknown, field: string): CapabilityRecordStatus {
  if (!isCapabilityRecordStatus(value)) {
    throw queryError(
      `${field} must be one of ${CAPABILITY_RECORD_STATUSES.join(', ')} (got '${String(value)}')`,
    );
  }
  return value;
}

function requireQueryText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw queryError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > MAX_PARTY_LENGTH) {
    throw queryError(`${field} must be at most ${MAX_PARTY_LENGTH} characters`);
  }
  return text;
}

function rejectQueryUnknownKeys(query: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(query).filter((key) => !(allowed as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: ${allowed.join(', ')})`);
  }
}

/** Fully validated + normalized form of `ListCapabilitiesQuery`. */
export interface ValidatedListCapabilitiesQuery {
  name: string | null;
  search: string | null;
  status: CapabilityRecordStatus | null;
  limit: number;
}

const LIST_CAPABILITIES_KEYS = ['name', 'search', 'status', 'limit'] as const;

export function validateListCapabilitiesQuery(
  query: ListCapabilitiesQuery,
): ValidatedListCapabilitiesQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, LIST_CAPABILITIES_KEYS);
  let name: string | null = null;
  if (query.name !== undefined && query.name !== null) {
    name = requireQueryText(query.name, 'query.name');
    if (name.length > MAX_NAME_LENGTH) {
      throw queryError(`query.name must be at most ${MAX_NAME_LENGTH} characters`);
    }
  }
  let search: string | null = null;
  if (query.search !== undefined && query.search !== null) {
    search = requireQueryText(query.search, 'query.search');
    if (search.length > MAX_SEARCH_LENGTH) {
      throw queryError(`query.search must be at most ${MAX_SEARCH_LENGTH} characters`);
    }
  }
  return {
    name,
    search,
    status: query.status === undefined || query.status === null
      ? null
      : requireQueryStatus(query.status, 'query.status'),
    limit: requireQueryLimit(query.limit),
  };
}

/** Fully validated + normalized form of `ListSuppliesQuery`. */
export interface ValidatedListSuppliesQuery {
  capabilityId: string | null;
  supplierKind: CapabilitySupplierKind | null;
  supplierId: string | null;
  status: CapabilityRecordStatus | null;
  limit: number;
}

const LIST_SUPPLIES_KEYS = ['capabilityId', 'supplierKind', 'supplierId', 'status', 'limit'] as const;

export function validateListSuppliesQuery(query: ListSuppliesQuery): ValidatedListSuppliesQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, LIST_SUPPLIES_KEYS);
  let supplierKind: CapabilitySupplierKind | null = null;
  if (query.supplierKind !== undefined && query.supplierKind !== null) {
    if (!isCapabilitySupplierKind(query.supplierKind)) {
      throw queryError(
        `query.supplierKind must be one of ${CAPABILITY_SUPPLIER_KINDS.join(', ')} (got '${String(query.supplierKind)}')`,
      );
    }
    supplierKind = query.supplierKind;
  }
  return {
    capabilityId:
      query.capabilityId === undefined || query.capabilityId === null
        ? null
        : requireQueryUuid(query.capabilityId, 'query.capabilityId'),
    supplierKind,
    supplierId:
      query.supplierId === undefined || query.supplierId === null
        ? null
        : requireQueryText(query.supplierId, 'query.supplierId'),
    status:
      query.status === undefined || query.status === null
        ? null
        : requireQueryStatus(query.status, 'query.status'),
    limit: requireQueryLimit(query.limit),
  };
}

/** Fully validated + normalized form of `ListRequirementsQuery`. */
export interface ValidatedListRequirementsQuery {
  capabilityId: string | null;
  sourceKind: RequirementSourceKind | null;
  sourceId: string | null;
  status: CapabilityRecordStatus | null;
  limit: number;
}

const LIST_REQUIREMENTS_KEYS = [
  'capabilityId',
  'sourceKind',
  'sourceId',
  'status',
  'limit',
] as const;

export function validateListRequirementsQuery(
  query: ListRequirementsQuery,
): ValidatedListRequirementsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, LIST_REQUIREMENTS_KEYS);
  let sourceKind: RequirementSourceKind | null = null;
  if (query.sourceKind !== undefined && query.sourceKind !== null) {
    if (!isRequirementSourceKind(query.sourceKind)) {
      throw queryError(
        `query.sourceKind must be one of ${REQUIREMENT_SOURCE_KINDS.join(', ')} (got '${String(query.sourceKind)}')`,
      );
    }
    sourceKind = query.sourceKind;
  }
  return {
    capabilityId:
      query.capabilityId === undefined || query.capabilityId === null
        ? null
        : requireQueryUuid(query.capabilityId, 'query.capabilityId'),
    sourceKind,
    sourceId:
      query.sourceId === undefined || query.sourceId === null
        ? null
        : requireQueryText(query.sourceId, 'query.sourceId'),
    status:
      query.status === undefined || query.status === null
        ? null
        : requireQueryStatus(query.status, 'query.status'),
    limit: requireQueryLimit(query.limit),
  };
}

/** Fully validated + normalized form of the three version queries. */
export interface ValidatedVersionQuery {
  capabilityId?: string;
  supplyId?: string;
  requirementId?: string;
  version: number;
}

export function validateCapabilityVersionQuery(
  query: GetCapabilityVersionQuery,
): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, ['capabilityId', 'version']);
  return {
    capabilityId: requireQueryUuid(query.capabilityId, 'query.capabilityId'),
    version: requireQueryInt(query.version, 'query.version', 1, Number.MAX_SAFE_INTEGER),
  };
}

export function validateSupplyVersionQuery(query: GetSupplyVersionQuery): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, ['supplyId', 'version']);
  return {
    supplyId: requireQueryUuid(query.supplyId, 'query.supplyId'),
    version: requireQueryInt(query.version, 'query.version', 1, Number.MAX_SAFE_INTEGER),
  };
}

export function validateRequirementVersionQuery(
  query: GetRequirementVersionQuery,
): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, ['requirementId', 'version']);
  return {
    requirementId: requireQueryUuid(query.requirementId, 'query.requirementId'),
    version: requireQueryInt(query.version, 'query.version', 1, Number.MAX_SAFE_INTEGER),
  };
}

/** Fully validated + normalized form of the three history queries. */
export interface ValidatedHistoryQuery {
  capabilityId?: string;
  supplyId?: string;
  requirementId?: string;
}

export function validateCapabilityHistoryQuery(
  query: ListCapabilityVersionsQuery,
): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, ['capabilityId']);
  return { capabilityId: requireQueryUuid(query.capabilityId, 'query.capabilityId') };
}

export function validateSupplyHistoryQuery(query: ListSupplyVersionsQuery): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, ['supplyId']);
  return { supplyId: requireQueryUuid(query.supplyId, 'query.supplyId') };
}

export function validateRequirementHistoryQuery(
  query: ListRequirementVersionsQuery,
): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, ['requirementId']);
  return { requirementId: requireQueryUuid(query.requirementId, 'query.requirementId') };
}

/** Fully validated + normalized form of `AnalyzeGapsQuery`. */
export interface ValidatedAnalyzeGapsQuery {
  capabilityId: string | null;
  status: GapStatus | null;
  limit: number;
}

const ANALYZE_GAPS_KEYS = ['capabilityId', 'status', 'limit'] as const;

export function validateAnalyzeGapsQuery(query: AnalyzeGapsQuery): ValidatedAnalyzeGapsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectQueryUnknownKeys(query, ANALYZE_GAPS_KEYS);
  let status: GapStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isGapStatus(query.status)) {
      throw queryError(
        `query.status must be one of ${GAP_STATUSES.join(', ')} (got '${String(query.status)}')`,
      );
    }
    status = query.status;
  }
  return {
    capabilityId:
      query.capabilityId === undefined || query.capabilityId === null
        ? null
        : requireQueryUuid(query.capabilityId, 'query.capabilityId'),
    status,
    limit: requireQueryLimit(query.limit),
  };
}

/** Record-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
