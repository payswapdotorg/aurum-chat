// Pure validation/normalization logic of the suppliers module (no
// database). Everything a caller may put into a registration, revision,
// assessment or query crosses these guards first; the SQL CHECK
// constraints in migrations/001-suppliers.sql mirror the load-bearing
// rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `changeKind`, lifecycle `status` of the *identity*,
// commit times or acting principals into an input — identity, tenancy,
// version number, change classification and audit fields are minted by the
// system (the goals/processes/capabilities discipline: supplier records are
// auditable, and audit fields are not caller-forgeable). The supplier's
// name and kind are IMMUTABLE identity content — the revise inputs do not
// even accept those keys, so a different name or kind can only ever be
// expressed as a new record, never by rewriting one.
//
// Scores are validated per dimension in [0, 1] or null (unscored); the
// first assessment must score at least one dimension (mirrored by the
// storage CHECK). Weight sets are validated as read-time analysis
// parameters only.

import type { TenantContext } from '@/infra/tenant';
import { SuppliersError, type SuppliersErrorCode } from './errors';
import type {
  GetScorecardVersionQuery,
  GetSupplierVersionQuery,
  ListScorecardVersionsQuery,
  ListSupplierVersionsQuery,
  ListSuppliersQuery,
  RankSuppliersQuery,
  GetSupplierIntelligenceQuery,
  RecordScorecardInput,
  ReviseScorecardInput,
  ReviseSupplierInput,
  RegisterSupplierInput,
  ScoreDimension,
  ScoreWeightSet,
  SupplierDimensionScores,
  SupplierPartyKind,
  SupplierKind,
  SupplierRecordStatus,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/** The two record flavors the W020 work item names verbatim. */
export const SUPPLIER_KINDS = ['supplier', 'subcontractor'] as const;

/** Audit-actor kinds (the events envelope's actor vocabulary minus `source`). */
export const SUPPLIER_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

export const SUPPLIER_RECORD_STATUSES = ['active', 'retired'] as const;

export const SUPPLIER_CHANGE_KINDS = ['created', 'revised', 'retired', 'reactivated'] as const;

export const SCORECARD_CHANGE_KINDS = ['assessed', 'reassessed'] as const;

/**
 * The eight scoring dimensions the W020 work item names verbatim, in
 * canonical work-item order.
 */
export const SCORE_DIMENSIONS = [
  'price',
  'quality',
  'reliability',
  'capacity',
  'compliance',
  'geography',
  'switching_cost',
  'alternatives',
] as const;

/**
 * The scorecard field of each dimension (snake_case dimension → camelCase
 * field of `SupplierDimensionScores`).
 */
export const DIMENSION_FIELD: Record<ScoreDimension, keyof SupplierDimensionScores> = {
  price: 'price',
  quality: 'quality',
  reliability: 'reliability',
  capacity: 'capacity',
  compliance: 'compliance',
  geography: 'geography',
  switching_cost: 'switchingCost',
  alternatives: 'alternatives',
};

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_NAME_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2000; // description / note / rationale
export const MAX_PARTY_LENGTH = 200; // party id / label
export const MAX_SEARCH_LENGTH = 200;

/** Evidence observation references per scorecard version (deduplicated). */
export const MAX_EVIDENCE_REFS = 32;

/**
 * Intelligence-analysis supply window: the alternatives analysis reads the
 * tenant's current capability supplies through the capabilities contract
 * (W017) in ONE bounded window of this many supplies (their
 * MAX_LIST_LIMIT; canonical capability/kind/key order — the observations
 * module's documented bounded-window precedent).
 */
export const MAX_ANALYSIS_SUPPLIES = 500;

/**
 * Intelligence-analysis capability bound: at most this many of the
 * supplier's distinct supplied capabilities are analyzed per call
 * (deterministic first-seen order in the supply window).
 */
export const MAX_ANALYSIS_CAPABILITIES = 100;

/**
 * Ranking candidate bound: the ranking loads current records for at most
 * this many active assessed suppliers per call (deterministic name/id
 * order — the capabilities module's documented bounded-window precedent;
 * the result `limit` applies after the deterministic ranking).
 */
export const MAX_RANK_CANDIDATES = 500;

/** Weight bounds: finite numbers in [0, MAX_WEIGHT] (defaults are 1). */
export const MAX_WEIGHT = 1_000_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Guards and helpers
// ---------------------------------------------------------------------------

export function isSupplierKind(value: unknown): value is SupplierKind {
  return typeof value === 'string' && (SUPPLIER_KINDS as readonly string[]).includes(value);
}

export function isSupplierPartyKind(value: unknown): value is SupplierPartyKind {
  return (
    typeof value === 'string' && (SUPPLIER_PARTY_KINDS as readonly string[]).includes(value)
  );
}

export function isSupplierRecordStatus(value: unknown): value is SupplierRecordStatus {
  return (
    typeof value === 'string' && (SUPPLIER_RECORD_STATUSES as readonly string[]).includes(value)
  );
}

export function isScoreDimension(value: unknown): value is ScoreDimension {
  return typeof value === 'string' && (SCORE_DIMENSIONS as readonly string[]).includes(value);
}

/** UUID shape guard (ids crossing the contract are uuids). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Case-insensitive ILIKE wildcard escaping (the missions module's helper). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertSuppliersTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new SuppliersError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new SuppliersError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new SuppliersError(
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
  code: SuppliersErrorCode,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new SuppliersError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function inputError(
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
  message: string,
): SuppliersError {
  return new SuppliersError(code, message);
}

function queryError(message: string): SuppliersError {
  return new SuppliersError('invalid_query', message);
}

function requireString(
  value: unknown,
  field: string,
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
): string {
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
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, code);
  if (text.length > max) {
    throw inputError(code, `${field} must be at most ${max} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(
  value: unknown,
  field: string,
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
): string {
  const text = requireString(value, field, code);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(code, `${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/** A dimension score: finite number in [0, 1], or null (unscored). */
function requireScore(
  value: unknown,
  field: string,
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw inputError(
      code,
      `${field} must be null (unscored) or a finite number in [0, 1] (got ${String(value)})`,
    );
  }
  return value;
}

/** Evidence observation ids: uuids, ≤ MAX_EVIDENCE_REFS, deduplicated in order. */
function requireEvidenceIds(
  value: unknown,
  field: string,
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
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
// Parties (audit actors)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of an audit actor (kind + id/label, ≥ one present). */
export interface ValidatedParty {
  kind: string;
  id: string | null;
  label: string | null;
}

const PARTY_KEYS = ['kind', 'id', 'label'] as const;

function validateActor(
  value: unknown,
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
): ValidatedParty {
  if (!isPlainObject(value)) throw inputError(code, 'actor must be an object');
  rejectUnknownKeys(value, PARTY_KEYS, 'actor', code);
  const kind = value.kind;
  if (typeof kind !== 'string' || !(SUPPLIER_PARTY_KINDS as readonly string[]).includes(kind)) {
    throw inputError(
      code,
      `actor.kind must be one of ${SUPPLIER_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = optionalText(value.id, 'actor.id', MAX_PARTY_LENGTH, code);
  const label = optionalText(value.label, 'actor.label', MAX_PARTY_LENGTH, code);
  if (id === null && label === null) {
    throw inputError(
      code,
      'actor must carry an id or a label — audit actors are traceable',
    );
  }
  return { kind, id, label };
}

// ---------------------------------------------------------------------------
// Supplier register / revise
// ---------------------------------------------------------------------------

const REGISTER_SUPPLIER_KEYS = [
  'name',
  'kind',
  'description',
  'worldEntityId',
  'actor',
  'rationale',
] as const;
const REVISE_SUPPLIER_KEYS = [
  'supplierId',
  'description',
  'worldEntityId',
  'status',
  'actor',
  'rationale',
] as const;

/** Fully validated + normalized form of `RegisterSupplierInput`. */
export interface ValidatedRegisterSupplierInput {
  name: string;
  kind: SupplierKind;
  description: string | null;
  worldEntityId: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRegisterSupplierInput(
  input: RegisterSupplierInput,
): ValidatedRegisterSupplierInput {
  const code = 'invalid_supplier_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'supplier registration must be an object');
  rejectUnknownKeys(input, REGISTER_SUPPLIER_KEYS, 'the supplier registration', code);

  const name = requireString(input.name, 'name', code);
  if (name.length > MAX_NAME_LENGTH) {
    throw inputError(
      code,
      `name must be at most ${MAX_NAME_LENGTH} characters (got ${name.length})`,
    );
  }
  if (!isSupplierKind(input.kind)) {
    throw inputError(
      code,
      `kind must be one of ${SUPPLIER_KINDS.join(', ')} (got '${String(input.kind)}')`,
    );
  }
  const description = optionalText(input.description, 'description', MAX_TEXT_LENGTH, code);
  const worldEntityId =
    input.worldEntityId === undefined || input.worldEntityId === null
      ? null
      : requireUuid(input.worldEntityId, 'worldEntityId', code);

  return {
    name,
    kind: input.kind,
    description,
    worldEntityId,
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

/** The validated patch fields of a supplier revision (undefined = carry over). */
export interface ValidatedSupplierPatch {
  /** Tri-state: undefined = unchanged, null = cleared, string = set. */
  description?: string | null;
  /** Tri-state: undefined = unchanged, null = cleared, uuid = set. */
  worldEntityId?: string | null;
  status?: SupplierRecordStatus;
}

/**
 * Lifecycle transitions are surgical so the audit trail never conflates
 * them with content revisions, and a revision must change at least one
 * field (the capabilities module's discipline).
 */
function assertSurgicalRevision(
  changed: string[],
  status: SupplierRecordStatus | undefined,
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
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

/** Fully validated + normalized form of `ReviseSupplierInput`. */
export interface ValidatedReviseSupplierInput {
  supplierId: string;
  patch: ValidatedSupplierPatch;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseSupplierInput(
  input: ReviseSupplierInput,
): ValidatedReviseSupplierInput {
  const code = 'invalid_supplier_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'supplier revision must be an object');
  rejectUnknownKeys(input, REVISE_SUPPLIER_KEYS, 'the supplier revision', code);

  const supplierId = requireUuid(input.supplierId, 'supplierId', code);
  const patch: ValidatedSupplierPatch = {};
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
    if (!isSupplierRecordStatus(input.status)) {
      throw inputError(
        code,
        `status must be one of ${SUPPLIER_RECORD_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    patch.status = input.status;
    changed.push('status');
  }
  assertSurgicalRevision(changed, patch.status, code, 'description, worldEntityId or status');

  return {
    supplierId,
    patch,
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

// ---------------------------------------------------------------------------
// Scorecard record / revise
// ---------------------------------------------------------------------------

const SCORE_KEYS = [
  'price',
  'quality',
  'reliability',
  'capacity',
  'compliance',
  'geography',
  'switchingCost',
  'alternatives',
] as const;

const RECORD_SCORECARD_KEYS = [
  'supplierId',
  'scores',
  'evidenceObservationIds',
  'note',
  'actor',
  'rationale',
] as const;
const REVISE_SCORECARD_KEYS = [
  'scorecardId',
  'scores',
  'evidenceObservationIds',
  'note',
  'actor',
  'rationale',
] as const;

/**
 * A validated score patch: ONLY the explicitly provided dimension fields
 * (each a score in [0, 1] or null = unscored). Presence in the record means
 * "explicitly stated" — undefined/omitted means "carry over" for revisions
 * and "unscored" for first assessments.
 */
export type ValidatedScorePatch = Partial<SupplierDimensionScores>;

function validateScorePatch(
  value: unknown,
  where: string,
  code: 'invalid_supplier_input' | 'invalid_scorecard_input',
): ValidatedScorePatch {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw inputError(code, `${where} must be an object`);
  rejectUnknownKeys(value, SCORE_KEYS, where, code);
  const patch: ValidatedScorePatch = {};
  for (const field of SCORE_KEYS) {
    const raw = value[field];
    if (raw === undefined) continue;
    patch[field as keyof SupplierDimensionScores] = requireScore(
      raw,
      `${where}.${field}`,
      code,
    );
  }
  return patch;
}

/** Folds a patch into a full score snapshot (explicit values win; rest stay null). */
function snapshotOf(patch: ValidatedScorePatch): SupplierDimensionScores {
  return {
    price: patch.price ?? null,
    quality: patch.quality ?? null,
    reliability: patch.reliability ?? null,
    capacity: patch.capacity ?? null,
    compliance: patch.compliance ?? null,
    geography: patch.geography ?? null,
    switchingCost: patch.switchingCost ?? null,
    alternatives: patch.alternatives ?? null,
  };
}

/** How many of the eight dimensions a full snapshot scores. */
export function scoredDimensionCount(scores: SupplierDimensionScores): number {
  return SCORE_DIMENSIONS.reduce(
    (count, dimension) => count + (scores[DIMENSION_FIELD[dimension]] !== null ? 1 : 0),
    0,
  );
}

/** Fully validated + normalized form of `RecordScorecardInput`. */
export interface ValidatedRecordScorecardInput {
  supplierId: string;
  scores: SupplierDimensionScores;
  evidenceObservationIds: string[];
  note: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRecordScorecardInput(
  input: RecordScorecardInput,
): ValidatedRecordScorecardInput {
  const code = 'invalid_scorecard_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'scorecard recording must be an object');
  rejectUnknownKeys(input, RECORD_SCORECARD_KEYS, 'the scorecard recording', code);

  const supplierId = requireUuid(input.supplierId, 'supplierId', code);
  const scores = snapshotOf(validateScorePatch(input.scores, 'scores', code));
  if (scoredDimensionCount(scores) === 0) {
    throw inputError(
      code,
      'scores must score at least one of the eight dimensions (price, quality, reliability, capacity, compliance, geography, switchingCost, alternatives)',
    );
  }

  return {
    supplierId,
    scores,
    evidenceObservationIds:
      input.evidenceObservationIds === undefined
        ? []
        : requireEvidenceIds(input.evidenceObservationIds, 'evidenceObservationIds', code),
    note: optionalText(input.note, 'note', MAX_TEXT_LENGTH, code),
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

/** Fully validated + normalized form of `ReviseScorecardInput`. */
export interface ValidatedReviseScorecardInput {
  scorecardId: string;
  patch: ValidatedScorePatch;
  /** Undefined = carry the previous evidence list forward. */
  evidenceObservationIds?: string[];
  /** Tri-state note: undefined = unchanged, null = cleared, string = set. */
  note?: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseScorecardInput(
  input: ReviseScorecardInput,
): ValidatedReviseScorecardInput {
  const code = 'invalid_scorecard_input' as const;
  if (!isPlainObject(input)) throw inputError(code, 'scorecard revision must be an object');
  rejectUnknownKeys(input, REVISE_SCORECARD_KEYS, 'the scorecard revision', code);

  const scorecardId = requireUuid(input.scorecardId, 'scorecardId', code);
  const patch = validateScorePatch(input.scores, 'scores', code);

  const out: ValidatedReviseScorecardInput = {
    scorecardId,
    patch,
    actor: validateActor(input.actor, code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
  if (input.evidenceObservationIds !== undefined) {
    out.evidenceObservationIds = requireEvidenceIds(
      input.evidenceObservationIds,
      'evidenceObservationIds',
      code,
    );
  }
  if (input.note !== undefined) {
    out.note = optionalText(input.note, 'note', MAX_TEXT_LENGTH, code);
  }
  return out;
}

/** Merges a validated revision patch into a current full snapshot. */
export function mergeScorePatch(
  current: SupplierDimensionScores,
  patch: ValidatedScorePatch,
): SupplierDimensionScores {
  return {
    price: patch.price !== undefined ? patch.price : current.price,
    quality: patch.quality !== undefined ? patch.quality : current.quality,
    reliability: patch.reliability !== undefined ? patch.reliability : current.reliability,
    capacity: patch.capacity !== undefined ? patch.capacity : current.capacity,
    compliance: patch.compliance !== undefined ? patch.compliance : current.compliance,
    geography: patch.geography !== undefined ? patch.geography : current.geography,
    switchingCost: patch.switchingCost !== undefined ? patch.switchingCost : current.switchingCost,
    alternatives: patch.alternatives !== undefined ? patch.alternatives : current.alternatives,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function requireLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw queryError(`limit must be an integer between 1 and ${MAX_LIST_LIMIT} (got ${String(value)})`);
  }
  return value;
}

/** Query-level text: non-empty, trimmed (query problems are `invalid_query` — the capabilities module's discipline). */
function requireQueryText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw queryError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/** Query-level uuid (query problems are `invalid_query`). */
function requireQueryUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw queryError(`${field} must be a uuid (got '${String(value)}')`);
  }
  return value.toLowerCase();
}

/** Validates a read-time weight set (unknown dimensions rejected; ≥ 0 finite). */
function validateWeightSet(value: unknown): ScoreWeightSet {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw queryError('weights must be an object keyed by dimension');
  const allowed = SCORE_DIMENSIONS as readonly string[];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw queryError(
        `unknown weight dimension '${key}' (allowed: ${SCORE_DIMENSIONS.join(', ')})`,
      );
    }
  }
  const weights: ScoreWeightSet = {};
  for (const dimension of SCORE_DIMENSIONS) {
    const raw = value[dimension];
    if (raw === undefined) continue;
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      raw < 0 ||
      raw > MAX_WEIGHT
    ) {
      throw queryError(
        `weights.${dimension} must be a finite number in [0, ${MAX_WEIGHT}] (got ${String(raw)})`,
      );
    }
    weights[dimension] = raw;
  }
  // The EFFECTIVE weight set (defaults 1) must carry at least one positive
  // weight — an all-zero set ranks nothing and scores nothing, which is a
  // caller mistake, not an empty analysis.
  let positive = 0;
  for (const dimension of SCORE_DIMENSIONS) {
    if ((weights[dimension] ?? 1) > 0) positive += 1;
  }
  if (positive === 0) {
    throw queryError('the effective weight set must carry at least one positive weight');
  }
  return weights;
}

/** Fully validated + normalized form of `ListSuppliersQuery`. */
export interface ValidatedListSuppliersQuery {
  name: string | null;
  search: string | null;
  kind: SupplierKind | null;
  status: SupplierRecordStatus | null;
  limit: number;
}

export function validateListSuppliersQuery(query: ListSuppliersQuery): ValidatedListSuppliersQuery {
  if (!isPlainObject(query)) throw queryError('the supplier listing query must be an object');
  rejectUnknownKeys(
    query,
    ['name', 'search', 'kind', 'status', 'limit'],
    'the supplier listing query',
    'invalid_query',
  );

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
  let kind: SupplierKind | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (!isSupplierKind(query.kind)) {
      throw queryError(`kind must be one of ${SUPPLIER_KINDS.join(', ')} (got '${String(query.kind)}')`);
    }
    kind = query.kind;
  }
  let status: SupplierRecordStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isSupplierRecordStatus(query.status)) {
      throw queryError(
        `status must be one of ${SUPPLIER_RECORD_STATUSES.join(', ')} (got '${String(query.status)}')`,
      );
    }
    status = query.status;
  }

  return { name, search, kind, status, limit: requireLimit(query.limit) };
}

/** Fully validated + normalized form of `GetSupplierVersionQuery`. */
export interface ValidatedVersionQuery {
  id: string;
  version: number;
}

export function validateSupplierVersionQuery(query: GetSupplierVersionQuery): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('the version query must be an object');
  rejectUnknownKeys(query, ['supplierId', 'version'], 'the version query', 'invalid_query');
  const id = requireQueryUuid(query.supplierId, 'query.supplierId');
  const version = query.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw queryError(`version must be an integer ≥ 1 (got ${String(version)})`);
  }
  return { id, version };
}

/** Fully validated + normalized form of `ListSupplierVersionsQuery`. */
export interface ValidatedHistoryQuery {
  id: string;
}

export function validateSupplierHistoryQuery(
  query: ListSupplierVersionsQuery,
): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('the history query must be an object');
  rejectUnknownKeys(query, ['supplierId'], 'the history query', 'invalid_query');
  return { id: requireQueryUuid(query.supplierId, 'query.supplierId') };
}

export function validateScorecardVersionQuery(
  query: GetScorecardVersionQuery,
): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('the version query must be an object');
  rejectUnknownKeys(query, ['scorecardId', 'version'], 'the version query', 'invalid_query');
  const id = requireQueryUuid(query.scorecardId, 'query.scorecardId');
  const version = query.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw queryError(`version must be an integer ≥ 1 (got ${String(version)})`);
  }
  return { id, version };
}

export function validateScorecardHistoryQuery(
  query: ListScorecardVersionsQuery,
): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('the history query must be an object');
  rejectUnknownKeys(query, ['scorecardId'], 'the history query', 'invalid_query');
  return { id: requireQueryUuid(query.scorecardId, 'query.scorecardId') };
}

/** Fully validated + normalized form of `RankSuppliersQuery`. */
export interface ValidatedRankSuppliersQuery {
  kind: SupplierKind | null;
  weights: ScoreWeightSet;
  limit: number;
}

export function validateRankSuppliersQuery(query: RankSuppliersQuery): ValidatedRankSuppliersQuery {
  if (!isPlainObject(query)) throw queryError('the ranking query must be an object');
  rejectUnknownKeys(
    query,
    ['kind', 'weights', 'limit'],
    'the ranking query',
    'invalid_query',
  );
  let kind: SupplierKind | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (!isSupplierKind(query.kind)) {
      throw queryError(`kind must be one of ${SUPPLIER_KINDS.join(', ')} (got '${String(query.kind)}')`);
    }
    kind = query.kind;
  }
  return { kind, weights: validateWeightSet(query.weights), limit: requireLimit(query.limit) };
}

/** Fully validated + normalized form of `GetSupplierIntelligenceQuery`. */
export interface ValidatedIntelligenceQuery {
  supplierId: string;
  weights: ScoreWeightSet;
}

export function validateSupplierIntelligenceQuery(
  query: GetSupplierIntelligenceQuery,
): ValidatedIntelligenceQuery {
  if (!isPlainObject(query)) throw queryError('the intelligence query must be an object');
  rejectUnknownKeys(
    query,
    ['supplierId', 'weights'],
    'the intelligence query',
    'invalid_query',
  );
  const supplierId = requireQueryUuid(query.supplierId, 'query.supplierId');
  return { supplierId, weights: validateWeightSet(query.weights) };
}
