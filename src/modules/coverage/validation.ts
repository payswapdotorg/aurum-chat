// Pure validation/normalization/measurement logic of the coverage module
// (no database, no cross-module reads). Everything a caller may put into
// the coverage registry crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// identity, tenancy or evaluation times into coverage state — ids,
// tenant, `evaluatedAt` and `evaluatedBy` are minted by the system, and
// §2's "coverage must not become another organizational database" starts
// at the input surface.
//
// NO CREDENTIALS IN COVERAGE STATE (§3/§13, load-bearing acceptance):
// credential-shaped INPUT KEYS are rejected outright, and source `ref`
// VALUES that look like raw provider credentials are refused — coverage
// records opaque registry references, never secrets.
//
// Also pure, and unit-tested in isolation (the W125 measurement model —
// COMPANY-COVERAGE-ARCHITECTURE.md §3/§4):
//  * `rollupSurfaces`  — the per-surface state rollup from latest claims;
//  * `measureDimensions` — the nine §4 dimensions, measured separately
//    (never one percentage), with honest UNKNOWN for the dimensions this
//    layer cannot see yet (identity continuity needs W095 verification
//    state, outcome completeness needs W040 outcome linkage, goal
//    sufficiency needs W127 goal-impact machinery — each says so);
//  * `deriveGaps`     — the §3 CoverageGap derivation (a gap is an
//    attention input: material when evidence exists but is deficient).

import type { TenantContext } from '@/infra/tenant';
import { CoverageError } from './errors';
import {
  COVERAGE_DIMENSIONS,
  COVERAGE_SOURCE_REGISTRIES,
  COVERAGE_STATES,
  EVIDENCE_COVERAGE_STATES,
  POLICY_COVERAGE_STATES,
} from './types';
import type {
  CoverageClaim,
  CoverageDimension,
  CoverageSnapshot,
  CoverageState,
  CoverageSourceRegistry,
  DimensionMeasurement,
  SurfaceSummary,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies and limits
// ---------------------------------------------------------------------------

export { COVERAGE_DIMENSIONS, COVERAGE_SOURCE_REGISTRIES, COVERAGE_STATES };
export type { CoverageDimension, CoverageSourceRegistry, CoverageState };

/** Surface-key grammar — canonical lowercase slug. */
const SURFACE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Basis-kind / general slug grammar (epistemics/audit precedent). */
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Strict ISO 8601 with an explicit offset (timestamptz; IMPLEMENTATION-STACK §8). */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Credential-shaped INPUT keys — never part of coverage state (§3/§13). */
const CREDENTIAL_KEY_PATTERN = /credential|secret|token|passphrase|password|api[-_]?key/i;
/** Raw-credential-looking source refs — opaque registry references only. */
const CREDENTIAL_VALUE_PATTERN =
  /^(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|xox[baprs]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export const MAX_LABEL_CHARS = 128;
export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_REF_CHARS = 256;
export const MAX_REASON_CHARS = 2048;
export const MAX_BASIS_IDS = 256;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;
/**
 * The registry-level DEPTH proxy: a surface's evidence basis is considered
 * full-depth at this many distinct evidence ids. Documented proxy — §4
 * depth ("how much of the relevant object graph is observable") becomes
 * per-object-graph real with W129's interaction adapters; until then the
 * basis size is the honest, stated proxy.
 */
export const DEPTH_BASIS_TARGET = 10;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isCoverageState(value: unknown): value is CoverageState {
  return typeof value === 'string' && (COVERAGE_STATES as readonly string[]).includes(value);
}

export function isCoverageDimension(value: unknown): value is CoverageDimension {
  return typeof value === 'string' && (COVERAGE_DIMENSIONS as readonly string[]).includes(value);
}

export function isCoverageSourceRegistry(
  value: unknown,
): value is CoverageSourceRegistry {
  return (
    typeof value === 'string' &&
    (COVERAGE_SOURCE_REGISTRIES as readonly string[]).includes(value)
  );
}

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertCoverageTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new CoverageError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new CoverageError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new CoverageError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// Shared field guards
// ---------------------------------------------------------------------------

type InputCode = 'invalid_surface_input' | 'invalid_source_input' | 'invalid_claim_input';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: InputCode | 'invalid_query',
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new CoverageError(
        code,
        `coverage state never carries credentials (§13): field '${key}' is rejected on ${where}`,
      );
    }
    if (!(allowed as readonly string[]).includes(key)) {
      throw new CoverageError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  code: InputCode | 'invalid_query',
): string {
  if (typeof value !== 'string') throw new CoverageError(code, `${field} must be a string`);
  const text = value.trim();
  if (text === '') throw new CoverageError(code, `${field} must be a non-empty string`);
  return text;
}

function optionalInstant(
  value: unknown,
  field: string,
  code: InputCode | 'invalid_query',
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
    throw new CoverageError(
      code,
      `${field} must be a strict ISO 8601 instant with an explicit offset`,
    );
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new CoverageError(code, `${field} is not a valid instant`);
  }
  return value;
}

function requireConfidence(value: unknown, code: InputCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new CoverageError(code, 'confidenceValue must be a number in 0..1');
  }
  return value;
}

function optionalPositiveInt(
  value: unknown,
  field: string,
  code: InputCode,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 2_592_000
  ) {
    throw new CoverageError(
      code,
      `${field} must be a positive integer of seconds (1..2592000) or null`,
    );
  }
  return value;
}

function parseLimit(
  query: Record<string, unknown>,
  code: 'invalid_query',
): number {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw new CoverageError(code, `limit must be an integer in 1..${MAX_LIST_LIMIT}`);
  }
  return limit;
}

// ---------------------------------------------------------------------------
// registerSurface / listSurfaces
// ---------------------------------------------------------------------------

export interface ValidatedRegisterSurfaceInput {
  key: string;
  label: string;
  description: string | null;
}

export function validateRegisterSurfaceInput(
  input: unknown,
): ValidatedRegisterSurfaceInput {
  if (!isPlainObject(input)) {
    throw new CoverageError('invalid_surface_input', 'registerSurface input must be a plain object');
  }
  rejectUnknownKeys(
    input,
    ['key', 'label', 'description'],
    'invalid_surface_input',
    'registerSurface input',
  );

  const key = requireString(input.key, 'key', 'invalid_surface_input');
  if (!SURFACE_KEY_PATTERN.test(key)) {
    throw new CoverageError(
      'invalid_surface_input',
      'key must match the canonical surface slug grammar (lowercase, 1..64 chars)',
    );
  }

  const label = requireString(input.label, 'label', 'invalid_surface_input');
  if (label.length > MAX_LABEL_CHARS) {
    throw new CoverageError(
      'invalid_surface_input',
      `label must be at most ${MAX_LABEL_CHARS} characters`,
    );
  }

  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    description = requireString(input.description, 'description', 'invalid_surface_input');
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new CoverageError(
        'invalid_surface_input',
        `description must be at most ${MAX_DESCRIPTION_CHARS} characters`,
      );
    }
  }

  return { key, label, description };
}

export interface ValidatedListSurfacesQuery {
  limit: number;
}

export function validateListSurfacesQuery(query: unknown): ValidatedListSurfacesQuery {
  if (query === undefined || query === null) return { limit: DEFAULT_LIST_LIMIT };
  if (!isPlainObject(query)) {
    throw new CoverageError('invalid_query', 'listSurfaces query must be a plain object');
  }
  rejectUnknownKeys(query, ['limit'], 'invalid_query', 'listSurfaces query');
  return { limit: parseLimit(query, 'invalid_query') };
}

// ---------------------------------------------------------------------------
// registerSource / listSources
// ---------------------------------------------------------------------------

export interface ValidatedRegisterSourceInput {
  registry: CoverageSourceRegistry;
  ref: string;
  label: string | null;
}

export function validateRegisterSourceInput(
  input: unknown,
): ValidatedRegisterSourceInput {
  if (!isPlainObject(input)) {
    throw new CoverageError('invalid_source_input', 'registerSource input must be a plain object');
  }
  rejectUnknownKeys(
    input,
    ['registry', 'ref', 'label'],
    'invalid_source_input',
    'registerSource input',
  );

  if (!isCoverageSourceRegistry(input.registry)) {
    throw new CoverageError(
      'invalid_source_input',
      `registry must be one of the §3 registries: ${COVERAGE_SOURCE_REGISTRIES.join(', ')}`,
    );
  }

  const ref = requireString(input.ref, 'ref', 'invalid_source_input');
  if (ref.length > MAX_REF_CHARS) {
    throw new CoverageError(
      'invalid_source_input',
      `ref must be at most ${MAX_REF_CHARS} characters`,
    );
  }
  if (CREDENTIAL_VALUE_PATTERN.test(ref)) {
    throw new CoverageError(
      'invalid_source_input',
      'ref must be an opaque registry reference — raw credentials never enter coverage state (§13)',
    );
  }

  let label: string | null = null;
  if (input.label !== undefined && input.label !== null) {
    label = requireString(input.label, 'label', 'invalid_source_input');
    if (label.length > MAX_LABEL_CHARS) {
      throw new CoverageError(
        'invalid_source_input',
        `label must be at most ${MAX_LABEL_CHARS} characters`,
      );
    }
  }

  return { registry: input.registry, ref, label };
}

export interface ValidatedListSourcesQuery {
  registry: CoverageSourceRegistry | null;
  limit: number;
}

export function validateListSourcesQuery(query: unknown): ValidatedListSourcesQuery {
  if (query === undefined || query === null) {
    return { registry: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(query)) {
    throw new CoverageError('invalid_query', 'listSources query must be a plain object');
  }
  rejectUnknownKeys(query, ['registry', 'limit'], 'invalid_query', 'listSources query');

  let registry: CoverageSourceRegistry | null = null;
  const value = query.registry;
  if (value !== undefined && value !== null && value !== '') {
    if (!isCoverageSourceRegistry(value)) {
      throw new CoverageError(
        'invalid_query',
        `registry must be one of the §3 registries: ${COVERAGE_SOURCE_REGISTRIES.join(', ')}`,
      );
    }
    registry = value;
  }

  return { registry, limit: parseLimit(query, 'invalid_query') };
}

// ---------------------------------------------------------------------------
// recordClaim / listClaims
// ---------------------------------------------------------------------------

export interface ValidatedRecordClaimInput {
  surfaceKey: string;
  sourceRegistry: CoverageSourceRegistry;
  sourceRef: string;
  basisKind: string;
  basisIds: string[];
  lastObservedAt: string | null;
  state: CoverageState;
  lastUsableAt: string | null;
  policyMaxAgeSeconds: number | null;
  confidenceValue: number;
  reason: string;
}

export function validateRecordClaimInput(input: unknown): ValidatedRecordClaimInput {
  if (!isPlainObject(input)) {
    throw new CoverageError('invalid_claim_input', 'recordClaim input must be a plain object');
  }
  rejectUnknownKeys(
    input,
    ['surfaceKey', 'source', 'observationBasis', 'state', 'freshness', 'confidenceValue', 'reason'],
    'invalid_claim_input',
    'recordClaim input',
  );

  const surfaceKey = requireString(input.surfaceKey, 'surfaceKey', 'invalid_claim_input');
  if (!SURFACE_KEY_PATTERN.test(surfaceKey)) {
    throw new CoverageError(
      'invalid_claim_input',
      'surfaceKey must match the canonical surface slug grammar (lowercase, 1..64 chars)',
    );
  }

  if (!isPlainObject(input.source)) {
    throw new CoverageError('invalid_claim_input', 'source must be a plain object');
  }
  rejectUnknownKeys(input.source, ['registry', 'ref'], 'invalid_claim_input', 'recordClaim source');
  if (!isCoverageSourceRegistry(input.source.registry)) {
    throw new CoverageError(
      'invalid_claim_input',
      `source.registry must be one of the §3 registries: ${COVERAGE_SOURCE_REGISTRIES.join(', ')}`,
    );
  }
  const sourceRef = requireString(input.source.ref, 'source.ref', 'invalid_claim_input');
  if (sourceRef.length > MAX_REF_CHARS) {
    throw new CoverageError(
      'invalid_claim_input',
      `source.ref must be at most ${MAX_REF_CHARS} characters`,
    );
  }
  if (CREDENTIAL_VALUE_PATTERN.test(sourceRef)) {
    throw new CoverageError(
      'invalid_claim_input',
      'source.ref must be an opaque registry reference — credentials never enter coverage state (§13)',
    );
  }

  if (!isPlainObject(input.observationBasis)) {
    throw new CoverageError('invalid_claim_input', 'observationBasis must be a plain object');
  }
  rejectUnknownKeys(
    input.observationBasis,
    ['kind', 'ids', 'lastObservedAt'],
    'invalid_claim_input',
    'recordClaim observationBasis',
  );
  const basisKind = requireString(
    input.observationBasis.kind,
    'observationBasis.kind',
    'invalid_claim_input',
  );
  if (!KIND_PATTERN.test(basisKind)) {
    throw new CoverageError(
      'invalid_claim_input',
      'observationBasis.kind must match the canonical slug grammar (1..64 chars)',
    );
  }

  const basisIds: string[] = [];
  if (
    input.observationBasis.ids !== undefined &&
    input.observationBasis.ids !== null
  ) {
    if (!Array.isArray(input.observationBasis.ids)) {
      throw new CoverageError('invalid_claim_input', 'observationBasis.ids must be an array of uuids');
    }
    if (input.observationBasis.ids.length > MAX_BASIS_IDS) {
      throw new CoverageError(
        'invalid_claim_input',
        `observationBasis.ids must hold at most ${MAX_BASIS_IDS} evidence references`,
      );
    }
    for (const id of input.observationBasis.ids) {
      if (!isUuid(id)) {
        throw new CoverageError(
          'invalid_claim_input',
          'observationBasis.ids must hold uuids (opaque evidence references)',
        );
      }
      basisIds.push(id);
    }
  }

  const lastObservedAt = optionalInstant(
    input.observationBasis.lastObservedAt,
    'observationBasis.lastObservedAt',
    'invalid_claim_input',
  );

  if (!isCoverageState(input.state)) {
    throw new CoverageError(
      'invalid_claim_input',
      `state must be one of the §5 coverage states: ${COVERAGE_STATES.join(', ')}`,
    );
  }

  let lastUsableAt: string | null = null;
  let policyMaxAgeSeconds: number | null = null;
  if (input.freshness !== undefined && input.freshness !== null) {
    if (!isPlainObject(input.freshness)) {
      throw new CoverageError('invalid_claim_input', 'freshness must be a plain object');
    }
    rejectUnknownKeys(
      input.freshness,
      ['lastUsableAt', 'policyMaxAgeSeconds'],
      'invalid_claim_input',
      'recordClaim freshness',
    );
    lastUsableAt = optionalInstant(
      input.freshness.lastUsableAt,
      'freshness.lastUsableAt',
      'invalid_claim_input',
    );
    policyMaxAgeSeconds = optionalPositiveInt(
      input.freshness.policyMaxAgeSeconds,
      'freshness.policyMaxAgeSeconds',
      'invalid_claim_input',
    );
  }

  const confidenceValue = requireConfidence(input.confidenceValue, 'invalid_claim_input');

  const reason = requireString(input.reason, 'reason', 'invalid_claim_input');
  if (reason.length > MAX_REASON_CHARS) {
    throw new CoverageError(
      'invalid_claim_input',
      `reason must be at most ${MAX_REASON_CHARS} characters`,
    );
  }

  return {
    surfaceKey,
    sourceRegistry: input.source.registry,
    sourceRef,
    basisKind,
    basisIds,
    lastObservedAt,
    state: input.state,
    lastUsableAt,
    policyMaxAgeSeconds,
    confidenceValue,
    reason,
  };
}

export interface ValidatedListClaimsQuery {
  surfaceKey: string | null;
  state: CoverageState | null;
  sourceRef: string | null;
  limit: number;
}

export function validateListClaimsQuery(query: unknown): ValidatedListClaimsQuery {
  if (query === undefined || query === null) {
    return { surfaceKey: null, state: null, sourceRef: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(query)) {
    throw new CoverageError('invalid_query', 'listClaims query must be a plain object');
  }
  rejectUnknownKeys(
    query,
    ['surfaceKey', 'state', 'sourceRef', 'limit'],
    'invalid_query',
    'listClaims query',
  );

  let surfaceKey: string | null = null;
  if (query.surfaceKey !== undefined && query.surfaceKey !== null && query.surfaceKey !== '') {
    surfaceKey = requireString(query.surfaceKey, 'surfaceKey', 'invalid_query');
    if (!SURFACE_KEY_PATTERN.test(surfaceKey)) {
      throw new CoverageError(
        'invalid_query',
        'surfaceKey must match the canonical surface slug grammar',
      );
    }
  }

  let state: CoverageState | null = null;
  if (query.state !== undefined && query.state !== null && query.state !== '') {
    if (!isCoverageState(query.state)) {
      throw new CoverageError(
        'invalid_query',
        `state must be one of the §5 coverage states: ${COVERAGE_STATES.join(', ')}`,
      );
    }
    state = query.state;
  }

  let sourceRef: string | null = null;
  if (query.sourceRef !== undefined && query.sourceRef !== null && query.sourceRef !== '') {
    sourceRef = requireString(query.sourceRef, 'sourceRef', 'invalid_query');
    if (sourceRef.length > MAX_REF_CHARS) {
      throw new CoverageError('invalid_query', `sourceRef must be at most ${MAX_REF_CHARS} characters`);
    }
  }

  return { surfaceKey, state, sourceRef, limit: parseLimit(query, 'invalid_query') };
}

// ---------------------------------------------------------------------------
// evaluateSnapshot / getSnapshot / listSnapshots / listGaps
// ---------------------------------------------------------------------------

export interface ValidatedEvaluateSnapshotQuery {
  surfaceKeys: string[] | null;
}

export function validateEvaluateSnapshotQuery(
  query: unknown,
): ValidatedEvaluateSnapshotQuery {
  if (query === undefined || query === null) return { surfaceKeys: null };
  if (!isPlainObject(query)) {
    throw new CoverageError('invalid_query', 'evaluateSnapshot query must be a plain object');
  }
  rejectUnknownKeys(query, ['surfaceKeys'], 'invalid_query', 'evaluateSnapshot query');
  if (query.surfaceKeys === undefined || query.surfaceKeys === null) {
    return { surfaceKeys: null };
  }
  if (!Array.isArray(query.surfaceKeys) || query.surfaceKeys.length === 0) {
    throw new CoverageError(
      'invalid_query',
      'surfaceKeys must be a non-empty array of surface keys when provided',
    );
  }
  const keys: string[] = [];
  for (const key of query.surfaceKeys) {
    if (typeof key !== 'string' || !SURFACE_KEY_PATTERN.test(key)) {
      throw new CoverageError(
        'invalid_query',
        'surfaceKeys must hold canonical surface keys (lowercase slugs)',
      );
    }
    keys.push(key);
  }
  return { surfaceKeys: keys };
}

export interface ValidatedGetSnapshotQuery {
  snapshotId: string;
}

export function validateGetSnapshotQuery(query: unknown): ValidatedGetSnapshotQuery {
  if (!isPlainObject(query)) {
    throw new CoverageError('invalid_query', 'getSnapshot query must be a plain object');
  }
  rejectUnknownKeys(query, ['snapshotId'], 'invalid_query', 'getSnapshot query');
  if (!isUuid(query.snapshotId)) {
    throw new CoverageError('invalid_query', 'snapshotId must be a uuid');
  }
  return { snapshotId: query.snapshotId };
}

export interface ValidatedListSnapshotsQuery {
  limit: number;
}

export function validateListSnapshotsQuery(
  query: unknown,
): ValidatedListSnapshotsQuery {
  if (query === undefined || query === null) return { limit: DEFAULT_LIST_LIMIT };
  if (!isPlainObject(query)) {
    throw new CoverageError('invalid_query', 'listSnapshots query must be a plain object');
  }
  rejectUnknownKeys(query, ['limit'], 'invalid_query', 'listSnapshots query');
  return { limit: parseLimit(query, 'invalid_query') };
}

export interface ValidatedListGapsQuery {
  snapshotId: string | null;
  surfaceKey: string | null;
  dimension: CoverageDimension | null;
  material: boolean | null;
  limit: number;
}

export function validateListGapsQuery(query: unknown): ValidatedListGapsQuery {
  if (query === undefined || query === null) {
    return { snapshotId: null, surfaceKey: null, dimension: null, material: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(query)) {
    throw new CoverageError('invalid_query', 'listGaps query must be a plain object');
  }
  rejectUnknownKeys(
    query,
    ['snapshotId', 'surfaceKey', 'dimension', 'material', 'limit'],
    'invalid_query',
    'listGaps query',
  );

  let snapshotId: string | null = null;
  if (query.snapshotId !== undefined && query.snapshotId !== null && query.snapshotId !== '') {
    if (!isUuid(query.snapshotId)) {
      throw new CoverageError('invalid_query', 'snapshotId must be a uuid');
    }
    snapshotId = query.snapshotId;
  }

  let surfaceKey: string | null = null;
  if (query.surfaceKey !== undefined && query.surfaceKey !== null && query.surfaceKey !== '') {
    surfaceKey = requireString(query.surfaceKey, 'surfaceKey', 'invalid_query');
    if (!SURFACE_KEY_PATTERN.test(surfaceKey)) {
      throw new CoverageError('invalid_query', 'surfaceKey must match the canonical surface slug grammar');
    }
  }

  let dimension: CoverageDimension | null = null;
  if (query.dimension !== undefined && query.dimension !== null && query.dimension !== '') {
    if (!isCoverageDimension(query.dimension)) {
      throw new CoverageError(
        'invalid_query',
        `dimension must be one of the §4 dimensions: ${COVERAGE_DIMENSIONS.join(', ')}`,
      );
    }
    dimension = query.dimension;
  }

  let material: boolean | null = null;
  if (query.material !== undefined && query.material !== null) {
    if (typeof query.material !== 'boolean') {
      throw new CoverageError('invalid_query', 'material must be a boolean');
    }
    material = query.material;
  }

  return { snapshotId, surfaceKey, dimension, material, limit: parseLimit(query, 'invalid_query') };
}

// ---------------------------------------------------------------------------
// The W125 measurement model (pure; §3/§4 of the coverage architecture)
// ---------------------------------------------------------------------------

/** Round to 3 decimals — deterministic, testable measurements. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fraction(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round3(numerator / denominator);
}

function fractionMeasurement(
  dimension: CoverageDimension,
  value: number | null,
  basis: string,
): DimensionMeasurement {
  if (value === null) {
    return { dimension, value: null, state: 'UNKNOWN', basis };
  }
  const state: CoverageState = value >= 1 ? 'COVERED' : 'PARTIAL';
  return { dimension, value, state, basis };
}

/**
 * §5 rollup precedence among EVIDENCE states: one sufficient source makes
 * the surface COVERED; partial evidence beats stale; stale beats nothing;
 * UNAVAILABLE beats UNKNOWN only when a source claims it. Policy states
 * (UNAUTHORIZED/EXCLUDED) never roll up — they are stated as policy
 * restrictions, not blind spots.
 */
const ROLLUP_PRECEDENCE: readonly CoverageState[] = [
  'COVERED',
  'PARTIAL',
  'STALE',
  'UNAVAILABLE',
];

/**
 * Rolls the latest claims up into per-surface summaries. `surfaces` are
 * the REGISTERED surfaces to consider (in registration order);
 * `latestClaims` are the current claims (latest per surface+source).
 * Surfaces without claims roll up UNKNOWN with zero contributing sources.
 */
export function rollupSurfaces(
  surfaces: readonly { key: string }[],
  latestClaims: readonly CoverageClaim[],
): SurfaceSummary[] {
  return surfaces.map((surface) => {
    const claims = latestClaims.filter((claim) => claim.surfaceKey === surface.key);
    const evidence = claims.filter(
      (claim) => EVIDENCE_COVERAGE_STATES.includes(claim.state),
    );

    let state: CoverageState = 'UNKNOWN';
    for (const candidate of ROLLUP_PRECEDENCE) {
      if (evidence.some((claim) => claim.state === candidate)) {
        state = candidate;
        break;
      }
    }

    const confidenceValue =
      evidence.length === 0
        ? 0
        : round3(evidence.reduce((sum, claim) => sum + claim.confidenceValue, 0) / evidence.length);

    let lastUsableAt: string | null = null;
    for (const claim of evidence) {
      const usable = claim.freshness.lastUsableAt;
      if (usable !== null && (lastUsableAt === null || usable > lastUsableAt)) {
        lastUsableAt = usable;
      }
    }

    return {
      surfaceKey: surface.key,
      state,
      contributingSources: claims.length,
      confidenceValue,
      lastUsableAt,
    };
  });
}

/** True when the claim is within its recorded freshness policy. */
function claimWithinPolicy(claim: CoverageClaim, referenceTime: string): boolean {
  const { lastUsableAt, policyMaxAgeSeconds } = claim.freshness;
  if (lastUsableAt === null || policyMaxAgeSeconds === null) return false;
  const ageSeconds =
    (new Date(referenceTime).getTime() - new Date(lastUsableAt).getTime()) / 1000;
  return ageSeconds <= policyMaxAgeSeconds;
}

export interface DimensionMeasurementInput {
  /** The registered surfaces in scope (evaluation subset or all). */
  surfaces: readonly { key: string }[];
  /** The current claims (latest per surface+source). */
  latestClaims: readonly CoverageClaim[];
  /** The registered sources in scope (for permission completeness). */
  sourceCount: number;
  /** ISO 8601 — the snapshot evaluation reference time. */
  referenceTime: string;
}

/**
 * Measures the nine §4 dimensions SEPARATELY from the current claims —
 * never one percentage. Dimensions this registry layer cannot see yet
 * measure null/UNKNOWN with their basis saying exactly what is missing:
 * identity continuity (needs W095 verification state), outcome
 * completeness (needs W040 outcome linkage) and goal sufficiency (needs
 * W127 goal-impact machinery) — the honest answer is UNKNOWN, not a
 * fabricated number.
 */
export function measureDimensions(input: DimensionMeasurementInput): DimensionMeasurement[] {
  const { surfaces, latestClaims, sourceCount, referenceTime } = input;
  const evidence = latestClaims.filter(
    (claim) => EVIDENCE_COVERAGE_STATES.includes(claim.state),
  );

  // breadth — what company domains are represented at all.
  const represented = surfaces.filter((surface) =>
    evidence.some(
      (claim) => claim.surfaceKey === surface.key && claim.observationBasis.ids.length > 0,
    ),
  ).length;
  const breadth = fraction(represented, surfaces.length);

  // depth — evidence-basis size per represented surface (documented proxy
  // until W129's per-object-graph depth).
  const representedSurfaces = surfaces.filter((surface) =>
    evidence.some(
      (claim) => claim.surfaceKey === surface.key && claim.observationBasis.ids.length > 0,
    ),
  );
  let depth: number | null = null;
  if (representedSurfaces.length > 0) {
    const perSurface = representedSurfaces.map((surface) => {
      const best = Math.max(
        0,
        ...evidence
          .filter((claim) => claim.surfaceKey === surface.key)
          .map((claim) => claim.observationBasis.ids.length),
      );
      return Math.min(1, best / DEPTH_BASIS_TARGET);
    });
    depth = round3(perSurface.reduce((sum, value) => sum + value, 0) / perSurface.length);
  }

  // freshness — claims WITH a policy that are within it.
  const withPolicy = evidence.filter(
    (claim) => claim.freshness.policyMaxAgeSeconds !== null,
  );
  const withinPolicy = withPolicy.filter((claim) => claimWithinPolicy(claim, referenceTime));
  const freshness = fraction(withinPolicy.length, withPolicy.length);

  // provenance completeness — material claims that trace to evidence.
  const provenance = fraction(
    evidence.filter((claim) => claim.observationBasis.ids.length > 0).length,
    evidence.length,
  );

  // temporal completeness — claims with more than one evidence id
  // (history, not only latest state; documented proxy).
  const temporal = fraction(
    evidence.filter((claim) => claim.observationBasis.ids.length >= 2).length,
    evidence.length,
  );

  // permission completeness — registered sources with at least one
  // non-UNAUTHORIZED current claim.
  const unauthorizedRefs = new Set(
    latestClaims
      .filter((claim) => claim.state === 'UNAUTHORIZED')
      .map((claim) => claim.source.ref),
  );
  const sourceRefsWithClaims = new Set(latestClaims.map((claim) => claim.source.ref));
  const permitted = [...sourceRefsWithClaims].filter(
    (ref) => !unauthorizedRefs.has(ref),
  ).length;
  const permission = fraction(permitted, sourceCount);

  return [
    fractionMeasurement(
      'breadth',
      breadth,
      `${represented} of ${surfaces.length} considered surfaces have at least one evidence-bearing claim`,
    ),
    fractionMeasurement(
      'depth',
      depth,
      representedSurfaces.length === 0
        ? 'no evidence-bearing surface — depth not measurable'
        : `mean evidence-basis depth per represented surface, normalized to ${DEPTH_BASIS_TARGET} ids (registry proxy until W129 object-graph depth)`,
    ),
    fractionMeasurement(
      'freshness',
      freshness,
      withPolicy.length === 0
        ? 'no current claim carries a freshness policy — freshness not measurable'
        : `${withinPolicy.length} of ${withPolicy.length} policy-carrying claims are within their freshness policy`,
    ),
    {
      dimension: 'identity-continuity',
      value: null,
      state: 'UNKNOWN',
      basis: 'requires W095 cross-source identity-verification state — not derivable from the coverage registry',
    },
    fractionMeasurement(
      'provenance-completeness',
      provenance,
      `${evidence.filter((c) => c.observationBasis.ids.length > 0).length} of ${evidence.length} current evidence claims carry evidence ids`,
    ),
    fractionMeasurement(
      'temporal-completeness',
      temporal,
      `${evidence.filter((c) => c.observationBasis.ids.length >= 2).length} of ${evidence.length} current evidence claims carry more than one evidence id (history proxy)`,
    ),
    {
      dimension: 'outcome-completeness',
      value: null,
      state: 'UNKNOWN',
      basis: 'requires W040 outcome linkage of observed actions — not derivable from the coverage registry',
    },
    fractionMeasurement(
      'permission-completeness',
      permission,
      sourceCount === 0
        ? 'no registered source — permission completeness not measurable'
        : `${permitted} of ${sourceCount} registered sources currently contribute non-UNAUTHORIZED claims`,
    ),
    {
      dimension: 'goal-sufficiency',
      value: null,
      state: 'UNKNOWN',
      basis: 'requires goal/decision impact (W127 coverage-to-goal attention) — the most product-facing dimension arrives with goal linkage',
    },
  ];
}

/** A derived gap before the service mints identity and detection time. */
export interface GapDraft {
  surfaceKey: string;
  dimension: CoverageDimension;
  state: CoverageState;
  reason: string;
  material: boolean;
}

/**
 * Derives the §3 CoverageGaps from a surface rollup. Materiality rule
 * (documented, tested): evidence exists but is deficient (PARTIAL/STALE)
 * → material gap (a business risk per §8's knowledge-deviation class);
 * no evidence (UNKNOWN/UNAVAILABLE) → immaterial at this layer —
 * materiality against goals is W127's judgement. Policy states
 * (UNAUTHORIZED/EXCLUDED) produce NO gaps: intentional absence is stated
 * as a policy restriction, not a blind spot.
 */
export function deriveGaps(rollups: readonly SurfaceSummary[]): GapDraft[] {
  const gaps: GapDraft[] = [];
  for (const rollup of rollups) {
    switch (rollup.state) {
      case 'PARTIAL':
        gaps.push({
          surfaceKey: rollup.surfaceKey,
          dimension: 'depth',
          state: 'PARTIAL',
          reason: 'some expected evidence exists, but material portions are missing',
          material: true,
        });
        break;
      case 'STALE':
        gaps.push({
          surfaceKey: rollup.surfaceKey,
          dimension: 'freshness',
          state: 'STALE',
          reason: 'evidence exists but has exceeded its freshness policy',
          material: true,
        });
        break;
      case 'UNAVAILABLE':
        gaps.push({
          surfaceKey: rollup.surfaceKey,
          dimension: 'breadth',
          state: 'UNAVAILABLE',
          reason: 'the contributing source cannot currently be accessed',
          material: false,
        });
        break;
      case 'UNKNOWN':
        gaps.push({
          surfaceKey: rollup.surfaceKey,
          dimension: 'breadth',
          state: 'UNKNOWN',
          reason: 'no usable evidence classifies this surface yet',
          material: false,
        });
        break;
      default:
        break;
    }
  }
  return gaps;
}

/** The §3 policy restrictions: intentional absences, stated calmly. */
export function derivePolicyRestrictions(
  latestClaims: readonly CoverageClaim[],
): { surfaceKey: string; note: string }[] {
  const restrictions: { surfaceKey: string; note: string }[] = [];
  const seen = new Set<string>();
  for (const claim of latestClaims) {
    if (!POLICY_COVERAGE_STATES.includes(claim.state)) continue;
    const dedupeKey = `${claim.surfaceKey}:${claim.state}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    restrictions.push({ surfaceKey: claim.surfaceKey, note: claim.reason });
  }
  return restrictions;
}

/** The stored snapshot document (identity lives on the row's columns). */
export type SnapshotDocument = Omit<CoverageSnapshot, 'id' | 'tenantId' | 'evaluatedAt'>;
