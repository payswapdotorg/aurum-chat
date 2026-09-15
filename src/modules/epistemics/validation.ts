// Pure validation/normalization logic of the epistemics module (no
// database). Everything a caller may put into a claim, contradiction,
// hypothesis, unknown, belief or query crosses these guards first; the SQL
// CHECK constraints in migrations/001 mirror the load-bearing rules as
// defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `recordedAt`, `status`, `resolvedAt` or derived fields into a
// record call — identity, tenancy, commit times, version numbers and
// lifecycle state are minted by the system (part of the "conflicting
// evidence is retained" acceptance of W007: nothing that exists can be
// rewritten through the input surface).
//
// Belief statements are validated to the exact JSON shape the temporal
// machinery will store (including the freshness module's state-size cap), so
// the freshness contract can never reject a statement this module accepted.

import type { TenantContext } from '@/infra/tenant';
import { MAX_PROVENANCE_OBSERVATIONS, MAX_STATE_BYTES } from '@/modules/freshness/contract';
import { EpistemicsError } from './errors';
import type {
  BeliefInput,
  BeliefStatement,
  ContradictionStatus,
  EvidenceRef,
  EvidenceRefKind,
  GetBeliefQuery,
  GetClaimQuery,
  GetContradictionQuery,
  GetHypothesisQuery,
  GetUnknownQuery,
  HypothesisStatus,
  ListBeliefsQuery,
  ListBeliefHistoryQuery,
  ListClaimsQuery,
  ListContradictionsQuery,
  ListHypothesesQuery,
  ListUnknownsQuery,
  RecordClaimInput,
  RecordHypothesisInput,
  RecordUnknownInput,
  RegisterContradictionInput,
  ResolutionRef,
  ResolutionRefKind,
  ResolveContradictionInput,
  ResolveHypothesisInput,
  ResolveUnknownInput,
  RetireBeliefInput,
  ReviseBeliefInput,
  SubjectRef,
  UnknownStatus,
  BeliefStatus,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies and limits
// ---------------------------------------------------------------------------

/** Lifecycle states of a belief anchor. */
export const BELIEF_STATUSES = ['active', 'retired'] as const;
/** Lifecycle states of a hypothesis. */
export const HYPOTHESIS_STATUSES = ['open', 'confirmed', 'refuted'] as const;
/** Lifecycle states of an unknown. */
export const UNKNOWN_STATUSES = ['open', 'resolved'] as const;
/** Lifecycle states of a contradiction. */
export const CONTRADICTION_STATUSES = ['open', 'resolved'] as const;
/** The two kinds of evidence an epistemic record can reference. */
export const EVIDENCE_REF_KINDS = ['observation', 'claim'] as const;
/** What may resolve a contradiction / unknown. */
export const RESOLUTION_REF_KINDS = ['belief', 'claim', 'observation'] as const;

/**
 * The temporal-state subject kind beliefs are versioned under (W006
 * machinery). Exported so tenants key their belief stale-after policies
 * (`setFreshnessPolicy({ subjectKind: 'epistemics.belief', ... })`)
 * identically — the freshness module's SOURCE_SUBJECT_KIND precedent.
 */
export const BELIEF_SUBJECT_KIND = 'epistemics.belief';

export const MAX_PROPOSITION_CHARS = 2048;
export const MAX_QUESTION_CHARS = 2048;
export const MAX_CONSEQUENCE_CHARS = 2048;
/** Free-text explanatory notes (contradictions, hypotheses, unknowns, retirement). */
export const MAX_NOTE_CHARS = 2048;
/** Derivation rationales (claims, belief versions) — mirrors freshness's rationale bound. */
export const MAX_RATIONALE_CHARS = 512;
export const MAX_ALTERNATIVES = 8;
export const MAX_ALTERNATIVE_CHARS = 512;
export const MAX_DISCONFIRMATION_CHARS = 1024;
/**
 * Observation evidence per record. Mirrors the freshness module's
 * MAX_PROVENANCE_OBSERVATIONS because belief-version provenance flows into
 * temporal revisions; claims/hypotheses/unknowns share the same bound for a
 * uniform contract.
 */
export const MAX_EVIDENCE_OBSERVATIONS = MAX_PROVENANCE_OBSERVATIONS;
export const MAX_EVIDENCE_CLAIMS = 16;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;
/**
 * Serialized belief-statement size cap — the freshness module's MAX_STATE_BYTES
 * (the statement travels as a temporal revision's `state` JSON).
 */
export const MAX_BELIEF_STATE_BYTES = MAX_STATE_BYTES;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors the freshness module's subject-kind grammar so `epistemics.*`
// subject references share one canonical vocabulary.
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Strict ISO 8601 with an explicit offset — temporal instants are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const CONFIDENCE_METHOD_MAX = 64;
const CONFIDENCE_BASIS_MAX = 512;

export function isBeliefStatus(value: unknown): value is BeliefStatus {
  return typeof value === 'string' && (BELIEF_STATUSES as readonly string[]).includes(value);
}

export function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return typeof value === 'string' && (HYPOTHESIS_STATUSES as readonly string[]).includes(value);
}

export function isUnknownStatus(value: unknown): value is UnknownStatus {
  return typeof value === 'string' && (UNKNOWN_STATUSES as readonly string[]).includes(value);
}

export function isContradictionStatus(value: unknown): value is ContradictionStatus {
  return typeof value === 'string' && (CONTRADICTION_STATUSES as readonly string[]).includes(value);
}

export function isEvidenceRefKind(value: unknown): value is EvidenceRefKind {
  return typeof value === 'string' && (EVIDENCE_REF_KINDS as readonly string[]).includes(value);
}

export function isResolutionRefKind(value: unknown): value is ResolutionRefKind {
  return typeof value === 'string' && (RESOLUTION_REF_KINDS as readonly string[]).includes(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertEpistemicsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new EpistemicsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new EpistemicsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new EpistemicsError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shared field guards
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
  code: EpistemicsError['code'],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new EpistemicsError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new EpistemicsError('invalid_query', `${field} must be a string`);
  const text = value.trim();
  if (text === '') throw new EpistemicsError('invalid_query', `${field} must be a non-empty string`);
  return text;
}

function boundedString(
  value: unknown,
  field: string,
  maxChars: number,
): string {
  const text = requireString(value, field);
  if (text.length > maxChars) {
    throw new EpistemicsError('invalid_query', `${field} must be at most ${maxChars} characters`);
  }
  return text;
}

function optionalBounded(
  value: unknown,
  field: string,
  maxChars: number,
): string | null {
  if (value === undefined || value === null) return null;
  const text = boundedString(value, field, maxChars);
  return text === '' ? null : text;
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw new EpistemicsError('invalid_query', `${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireIsoInstant(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new EpistemicsError(
      'invalid_query',
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${text}')`,
    );
  }
  return text;
}

/** Optional strict ISO instant → Date | null (null = "use the service clock"). */
function optionalAsOf(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  return new Date(requireIsoInstant(value, field));
}

function requireSubjectRef(value: unknown, field: string): SubjectRef {
  if (!isPlainObject(value)) {
    throw new EpistemicsError('invalid_query', `${field} must be an object { kind, id }`);
  }
  rejectUnknownKeys(value, ['kind', 'id'], 'invalid_query', field);
  const kind = requireString(value.kind, `${field}.kind`);
  if (!KIND_PATTERN.test(kind)) {
    throw new EpistemicsError(
      'invalid_query',
      `${field}.kind must be a canonical subject kind matching ${KIND_PATTERN.source} (got '${kind}')`,
    );
  }
  return { kind, id: requireUuid(value.id, `${field}.id`) };
}

function optionalSubjectRef(value: unknown, field: string): SubjectRef | null {
  if (value === undefined || value === null) return null;
  return requireSubjectRef(value, field);
}

/**
 * Normalized, deduplicated, sorted observation-id list, bounded by
 * MAX_EVIDENCE_OBSERVATIONS. `minOne` enforces "derived from evidence"
 * (claims, belief versions); hypotheses and unknowns may cite none.
 */
function observationIdList(value: unknown, field: string, minOne: boolean): string[] {
  if (!Array.isArray(value)) {
    throw new EpistemicsError('invalid_query', `${field} must be an array of observation uuids`);
  }
  if (minOne && value.length === 0) {
    throw new EpistemicsError(
      'invalid_query',
      `${field} must cite at least one observation — epistemic records here are never derived from nothing`,
    );
  }
  if (value.length > MAX_EVIDENCE_OBSERVATIONS) {
    throw new EpistemicsError(
      'invalid_query',
      `${field} supports at most ${MAX_EVIDENCE_OBSERVATIONS} observations`,
    );
  }
  const ids: string[] = [];
  for (const [index, id] of value.entries()) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new EpistemicsError('invalid_query', `${field}[${index}] must be an observation uuid`);
    }
    const normalized = id.toLowerCase();
    if (!ids.includes(normalized)) ids.push(normalized);
  }
  ids.sort();
  return ids;
}

/** Same as `observationIdList` but for claim references (this module's own records). */
function claimIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new EpistemicsError('invalid_query', `${field} must be an array of claim uuids`);
  }
  if (value.length > MAX_EVIDENCE_CLAIMS) {
    throw new EpistemicsError('invalid_query', `${field} supports at most ${MAX_EVIDENCE_CLAIMS} claims`);
  }
  const ids: string[] = [];
  for (const [index, id] of value.entries()) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new EpistemicsError('invalid_query', `${field}[${index}] must be a claim uuid`);
    }
    const normalized = id.toLowerCase();
    if (!ids.includes(normalized)) ids.push(normalized);
  }
  ids.sort();
  return ids;
}

/** Calibrated confidence in a proposition: value ∈ [0,1], method, optional basis. */
function requireConfidence(value: unknown, field: string): {
  value: number;
  method: string;
  basis: string | null;
} {
  if (!isPlainObject(value)) {
    throw new EpistemicsError('invalid_query', `${field} must be an object { value, method, basis? }`);
  }
  rejectUnknownKeys(value, ['value', 'method', 'basis'], 'invalid_query', field);
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    throw new EpistemicsError('invalid_query', `${field}.value must be a finite number in [0, 1]`);
  }
  if (value.value < 0 || value.value > 1) {
    throw new EpistemicsError('invalid_query', `${field}.value must be within [0, 1] (got ${String(value.value)})`);
  }
  const method = boundedString(value.method, `${field}.method`, CONFIDENCE_METHOD_MAX);
  const basis = optionalBounded(value.basis, `${field}.basis`, CONFIDENCE_BASIS_MAX);
  return { value: value.value, method, basis };
}

function listLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_LIST_LIMIT : value;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw new EpistemicsError(
      'invalid_query',
      `query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`,
    );
  }
  return limit;
}

/** Rewrites a guard's `invalid_query` into the caller's input error code. */
function withCode<T>(code: EpistemicsError['code'], fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof EpistemicsError && error.code === 'invalid_query') {
      throw new EpistemicsError(code, error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIM_INPUT_KEYS = [
  'proposition',
  'subject',
  'confidence',
  'evidenceObservationIds',
  'rationale',
] as const;
const CLAIM_LIST_QUERY_KEYS = ['subjectKind', 'subjectId', 'evidenceObservationId', 'limit'] as const;

/** Fully validated + normalized form of `RecordClaimInput`. */
export interface ValidatedRecordClaimInput {
  proposition: string;
  subject: SubjectRef | null;
  confidence: { value: number; method: string; basis: string | null };
  evidenceObservationIds: string[];
  rationale: string | null;
}

export function validateRecordClaimInput(input: RecordClaimInput): ValidatedRecordClaimInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_claim_input', 'claim input must be an object');
  }
  return withCode('invalid_claim_input', () => {
    rejectUnknownKeys(input, CLAIM_INPUT_KEYS, 'invalid_claim_input', 'the claim input');
    const proposition = boundedString(input.proposition, 'proposition', MAX_PROPOSITION_CHARS);
    const subject = optionalSubjectRef(input.subject, 'subject');
    const confidence = requireConfidence(input.confidence, 'confidence');
    const evidenceObservationIds = observationIdList(
      input.evidenceObservationIds,
      'evidenceObservationIds',
      true,
    );
    const rationale = optionalBounded(input.rationale, 'rationale', MAX_RATIONALE_CHARS);
    return { proposition, subject, confidence, evidenceObservationIds, rationale };
  });
}

/** Fully validated form of `ListClaimsQuery`. */
export interface ValidatedListClaimsQuery {
  subjectKind: string | null;
  subjectId: string | null;
  evidenceObservationId: string | null;
  limit: number;
}

export function validateListClaimsQuery(query: ListClaimsQuery): ValidatedListClaimsQuery {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, CLAIM_LIST_QUERY_KEYS, 'invalid_query', 'the query');
  return {
    subjectKind:
      query.subjectKind === undefined || query.subjectKind === null
        ? null
        : withCode('invalid_query', () =>
            boundedString(query.subjectKind, 'query.subjectKind', 128),
          ),
    subjectId:
      query.subjectId === undefined || query.subjectId === null
        ? null
        : requireUuid(query.subjectId, 'query.subjectId'),
    evidenceObservationId:
      query.evidenceObservationId === undefined || query.evidenceObservationId === null
        ? null
        : requireUuid(query.evidenceObservationId, 'query.evidenceObservationId'),
    limit: listLimit(query.limit),
  };
}

// ---------------------------------------------------------------------------
// Simple id queries (getClaim / getContradiction / getHypothesis / getUnknown)
// ---------------------------------------------------------------------------

/** Validates a `{ <field>: uuid }` query with unknown-key rejection. */
function requireIdQuery(query: object, field: string): string {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, [field], 'invalid_query', 'the query');
  return requireUuid((query as Record<string, unknown>)[field], `query.${field}`);
}

/** Fully validated form of `GetClaimQuery` (the claim id). */
export type ValidatedGetClaimQuery = string;

export function validateGetClaimQuery(query: GetClaimQuery): ValidatedGetClaimQuery {
  return requireIdQuery(query, 'claimId');
}

/** Fully validated form of `GetContradictionQuery` (the contradiction id). */
export type ValidatedGetContradictionQuery = string;

export function validateGetContradictionQuery(
  query: GetContradictionQuery,
): ValidatedGetContradictionQuery {
  return requireIdQuery(query, 'contradictionId');
}

/** Fully validated form of `GetHypothesisQuery` (the hypothesis id). */
export type ValidatedGetHypothesisQuery = string;

export function validateGetHypothesisQuery(
  query: GetHypothesisQuery,
): ValidatedGetHypothesisQuery {
  return requireIdQuery(query, 'hypothesisId');
}

/** Fully validated form of `GetUnknownQuery` (the unknown id). */
export type ValidatedGetUnknownQuery = string;

export function validateGetUnknownQuery(query: GetUnknownQuery): ValidatedGetUnknownQuery {
  return requireIdQuery(query, 'unknownId');
}

// ---------------------------------------------------------------------------
// Evidence references and contradictions
// ---------------------------------------------------------------------------

/** Parses one `{ kind, id }` evidence reference (observation or claim). */
function requireEvidenceRef(value: unknown, field: string): EvidenceRef {
  if (!isPlainObject(value)) {
    throw new EpistemicsError('invalid_query', `${field} must be an object { kind, id }`);
  }
  rejectUnknownKeys(value, ['kind', 'id'], 'invalid_query', field);
  const kind = value.kind;
  if (!isEvidenceRefKind(kind)) {
    throw new EpistemicsError(
      'invalid_query',
      `${field}.kind must be one of ${EVIDENCE_REF_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  return { kind, id: requireUuid(value.id, `${field}.id`) };
}

/** Parses one `{ kind, id }` resolution reference (belief, claim or observation). */
function requireResolutionRef(value: unknown, field: string): ResolutionRef {
  if (!isPlainObject(value)) {
    throw new EpistemicsError('invalid_query', `${field} must be an object { kind, id }`);
  }
  rejectUnknownKeys(value, ['kind', 'id'], 'invalid_query', field);
  const kind = value.kind;
  if (!isResolutionRefKind(kind)) {
    throw new EpistemicsError(
      'invalid_query',
      `${field}.kind must be one of ${RESOLUTION_REF_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  return { kind, id: requireUuid(value.id, `${field}.id`) };
}

/**
 * Canonical order of an evidence pair: lexicographic by (kind, id) — the
 * same ordering the SQL canonical-order CHECK enforces via row comparison,
 * so one unordered pair maps to exactly one stored row.
 */
export function orderEvidenceRefs(left: EvidenceRef, right: EvidenceRef): [EvidenceRef, EvidenceRef] {
  if (left.kind === right.kind) {
    return left.id < right.id ? [left, right] : [right, left];
  }
  return left.kind < right.kind ? [left, right] : [right, left];
}

const CONTRADICTION_INPUT_KEYS = ['left', 'right', 'note'] as const;
const CONTRADICTION_RESOLUTION_KEYS = ['contradictionId', 'resolvedBy', 'note'] as const;
const CONTRADICTION_LIST_QUERY_KEYS = ['evidenceRef', 'status', 'limit'] as const;

/** Fully validated + normalized form of `RegisterContradictionInput`. */
export interface ValidatedRegisterContradictionInput {
  left: EvidenceRef;
  right: EvidenceRef;
  note: string;
}

export function validateRegisterContradictionInput(
  input: RegisterContradictionInput,
): ValidatedRegisterContradictionInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_contradiction_input', 'contradiction input must be an object');
  }
  return withCode('invalid_contradiction_input', () => {
    rejectUnknownKeys(
      input,
      CONTRADICTION_INPUT_KEYS,
      'invalid_contradiction_input',
      'the contradiction input',
    );
    const left = requireEvidenceRef(input.left, 'left');
    const right = requireEvidenceRef(input.right, 'right');
    if (left.kind === right.kind && left.id === right.id) {
      throw new EpistemicsError(
        'invalid_contradiction_input',
        'a contradiction needs two DISTINCT evidence references — one record cannot contradict itself',
      );
    }
    const note = boundedString(input.note, 'note', MAX_NOTE_CHARS);
    return { left, right, note };
  });
}

/** Fully validated form of `ResolveContradictionInput`. */
export interface ValidatedResolveContradictionInput {
  contradictionId: string;
  resolvedBy: ResolutionRef | null;
  note: string;
}

export function validateResolveContradictionInput(
  input: ResolveContradictionInput,
): ValidatedResolveContradictionInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_resolution', 'resolution input must be an object');
  }
  return withCode('invalid_resolution', () => {
    rejectUnknownKeys(input, CONTRADICTION_RESOLUTION_KEYS, 'invalid_resolution', 'the resolution input');
    const contradictionId = requireUuid(input.contradictionId, 'contradictionId');
    const resolvedBy =
      input.resolvedBy === undefined || input.resolvedBy === null
        ? null
        : requireResolutionRef(input.resolvedBy, 'resolvedBy');
    const note = boundedString(input.note, 'note', MAX_NOTE_CHARS);
    return { contradictionId, resolvedBy, note };
  });
}

/** Fully validated form of `ListContradictionsQuery`. */
export interface ValidatedListContradictionsQuery {
  evidenceRef: EvidenceRef | null;
  status: ContradictionStatus | null;
  limit: number;
}

export function validateListContradictionsQuery(
  query: ListContradictionsQuery,
): ValidatedListContradictionsQuery {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, CONTRADICTION_LIST_QUERY_KEYS, 'invalid_query', 'the query');
  return {
    evidenceRef:
      query.evidenceRef === undefined || query.evidenceRef === null
        ? null
        : requireEvidenceRef(query.evidenceRef, 'query.evidenceRef'),
    status:
      query.status === undefined || query.status === null
        ? null
        : withCode('invalid_query', () => {
            if (!isContradictionStatus(query.status)) {
              throw new EpistemicsError(
                'invalid_query',
                `query.status must be one of ${CONTRADICTION_STATUSES.join(', ')} (got '${String(query.status)}')`,
              );
            }
            return query.status;
          }),
    limit: listLimit(query.limit),
  };
}

// ---------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------

const HYPOTHESIS_INPUT_KEYS = [
  'proposition',
  'subject',
  'supportingObservationIds',
  'note',
] as const;
const HYPOTHESIS_RESOLUTION_KEYS = [
  'hypothesisId',
  'outcome',
  'evidenceObservationIds',
  'evidenceClaimIds',
  'note',
] as const;
const HYPOTHESIS_LIST_QUERY_KEYS = ['status', 'subjectKind', 'subjectId', 'limit'] as const;

/** Fully validated + normalized form of `RecordHypothesisInput`. */
export interface ValidatedRecordHypothesisInput {
  proposition: string;
  subject: SubjectRef | null;
  supportingObservationIds: string[];
  note: string | null;
}

export function validateRecordHypothesisInput(
  input: RecordHypothesisInput,
): ValidatedRecordHypothesisInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_hypothesis_input', 'hypothesis input must be an object');
  }
  return withCode('invalid_hypothesis_input', () => {
    rejectUnknownKeys(
      input,
      HYPOTHESIS_INPUT_KEYS,
      'invalid_hypothesis_input',
      'the hypothesis input',
    );
    const proposition = boundedString(input.proposition, 'proposition', MAX_PROPOSITION_CHARS);
    const subject = optionalSubjectRef(input.subject, 'subject');
    const supportingObservationIds = observationIdList(
      input.supportingObservationIds ?? [],
      'supportingObservationIds',
      false,
    );
    const note = optionalBounded(input.note, 'note', MAX_NOTE_CHARS);
    return { proposition, subject, supportingObservationIds, note };
  });
}

/** Fully validated form of `ResolveHypothesisInput`. */
export interface ValidatedResolveHypothesisInput {
  hypothesisId: string;
  outcome: 'confirmed' | 'refuted';
  evidenceObservationIds: string[];
  evidenceClaimIds: string[];
  note: string;
}

export function validateResolveHypothesisInput(
  input: ResolveHypothesisInput,
): ValidatedResolveHypothesisInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_resolution', 'resolution input must be an object');
  }
  return withCode('invalid_resolution', () => {
    rejectUnknownKeys(input, HYPOTHESIS_RESOLUTION_KEYS, 'invalid_resolution', 'the resolution input');
    const hypothesisId = requireUuid(input.hypothesisId, 'hypothesisId');
    if (input.outcome !== 'confirmed' && input.outcome !== 'refuted') {
      throw new EpistemicsError(
        'invalid_resolution',
        `outcome must be 'confirmed' or 'refuted' (got '${String(input.outcome)}')`,
      );
    }
    const evidenceObservationIds = observationIdList(
      input.evidenceObservationIds ?? [],
      'evidenceObservationIds',
      false,
    );
    const evidenceClaimIds = claimIdList(input.evidenceClaimIds ?? [], 'evidenceClaimIds');
    const note = boundedString(input.note, 'note', MAX_NOTE_CHARS);
    return { hypothesisId, outcome: input.outcome, evidenceObservationIds, evidenceClaimIds, note };
  });
}

/** Fully validated form of `ListHypothesesQuery`. */
export interface ValidatedListHypothesesQuery {
  status: HypothesisStatus | null;
  subjectKind: string | null;
  subjectId: string | null;
  limit: number;
}

export function validateListHypothesesQuery(
  query: ListHypothesesQuery,
): ValidatedListHypothesesQuery {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, HYPOTHESIS_LIST_QUERY_KEYS, 'invalid_query', 'the query');
  return {
    status:
      query.status === undefined || query.status === null
        ? null
        : withCode('invalid_query', () => {
            if (!isHypothesisStatus(query.status)) {
              throw new EpistemicsError(
                'invalid_query',
                `query.status must be one of ${HYPOTHESIS_STATUSES.join(', ')} (got '${String(query.status)}')`,
              );
            }
            return query.status;
          }),
    subjectKind:
      query.subjectKind === undefined || query.subjectKind === null
        ? null
        : withCode('invalid_query', () => boundedString(query.subjectKind, 'query.subjectKind', 128)),
    subjectId:
      query.subjectId === undefined || query.subjectId === null
        ? null
        : requireUuid(query.subjectId, 'query.subjectId'),
    limit: listLimit(query.limit),
  };
}

// ---------------------------------------------------------------------------
// Unknowns
// ---------------------------------------------------------------------------

const UNKNOWN_INPUT_KEYS = [
  'question',
  'consequence',
  'subject',
  'relatedObservationIds',
  'relatedClaimIds',
  'relatedBeliefIds',
  'note',
] as const;
const UNKNOWN_RESOLUTION_KEYS = ['unknownId', 'resolution', 'note'] as const;
const UNKNOWN_LIST_QUERY_KEYS = ['status', 'subjectKind', 'subjectId', 'limit'] as const;

/** Fully validated + normalized form of `RecordUnknownInput`. */
export interface ValidatedRecordUnknownInput {
  question: string;
  consequence: string;
  subject: SubjectRef | null;
  relatedObservationIds: string[];
  relatedClaimIds: string[];
  relatedBeliefIds: string[];
  note: string | null;
}

export function validateRecordUnknownInput(
  input: RecordUnknownInput,
): ValidatedRecordUnknownInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_unknown_input', 'unknown input must be an object');
  }
  return withCode('invalid_unknown_input', () => {
    rejectUnknownKeys(input, UNKNOWN_INPUT_KEYS, 'invalid_unknown_input', 'the unknown input');
    const question = boundedString(input.question, 'question', MAX_QUESTION_CHARS);
    const consequence = boundedString(input.consequence, 'consequence', MAX_CONSEQUENCE_CHARS);
    const subject = optionalSubjectRef(input.subject, 'subject');
    const relatedObservationIds = observationIdList(
      input.relatedObservationIds ?? [],
      'relatedObservationIds',
      false,
    );
    const relatedClaimIds = claimIdList(input.relatedClaimIds ?? [], 'relatedClaimIds');
    const relatedBeliefIds = claimIdList(input.relatedBeliefIds ?? [], 'relatedBeliefIds');
    const note = optionalBounded(input.note, 'note', MAX_NOTE_CHARS);
    return {
      question,
      consequence,
      subject,
      relatedObservationIds,
      relatedClaimIds,
      relatedBeliefIds,
      note,
    };
  });
}

/** Fully validated form of `ResolveUnknownInput`. */
export interface ValidatedResolveUnknownInput {
  unknownId: string;
  resolution: ResolutionRef | null;
  note: string;
}

export function validateResolveUnknownInput(
  input: ResolveUnknownInput,
): ValidatedResolveUnknownInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_resolution', 'resolution input must be an object');
  }
  return withCode('invalid_resolution', () => {
    rejectUnknownKeys(input, UNKNOWN_RESOLUTION_KEYS, 'invalid_resolution', 'the resolution input');
    const unknownId = requireUuid(input.unknownId, 'unknownId');
    const resolution =
      input.resolution === undefined || input.resolution === null
        ? null
        : requireResolutionRef(input.resolution, 'resolution');
    const note = boundedString(input.note, 'note', MAX_NOTE_CHARS);
    return { unknownId, resolution, note };
  });
}

/** Fully validated form of `ListUnknownsQuery`. */
export interface ValidatedListUnknownsQuery {
  status: UnknownStatus | null;
  subjectKind: string | null;
  subjectId: string | null;
  limit: number;
}

export function validateListUnknownsQuery(query: ListUnknownsQuery): ValidatedListUnknownsQuery {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, UNKNOWN_LIST_QUERY_KEYS, 'invalid_query', 'the query');
  return {
    status:
      query.status === undefined || query.status === null
        ? null
        : withCode('invalid_query', () => {
            if (!isUnknownStatus(query.status)) {
              throw new EpistemicsError(
                'invalid_query',
                `query.status must be one of ${UNKNOWN_STATUSES.join(', ')} (got '${String(query.status)}')`,
              );
            }
            return query.status;
          }),
    subjectKind:
      query.subjectKind === undefined || query.subjectKind === null
        ? null
        : withCode('invalid_query', () => boundedString(query.subjectKind, 'query.subjectKind', 128)),
    subjectId:
      query.subjectId === undefined || query.subjectId === null
        ? null
        : requireUuid(query.subjectId, 'query.subjectId'),
    limit: listLimit(query.limit),
  };
}

// ---------------------------------------------------------------------------
// Beliefs
// ---------------------------------------------------------------------------

const BELIEF_INPUT_KEYS = [
  'proposition',
  'confidence',
  'supportingObservationIds',
  'supportingClaimIds',
  'alternatives',
  'disconfirmation',
  'subject',
  'validFrom',
  'rationale',
] as const;
const REVISE_BELIEF_INPUT_KEYS = [...BELIEF_INPUT_KEYS, 'beliefId'] as const;
const RETIRE_BELIEF_INPUT_KEYS = ['beliefId', 'rationale'] as const;
const BELIEF_QUERY_KEYS = ['beliefId', 'asOf'] as const;
const BELIEF_LIST_QUERY_KEYS = ['status', 'subjectKind', 'subjectId', 'limit'] as const;
const BELIEF_HISTORY_QUERY_KEYS = ['beliefId'] as const;

/**
 * Fully validated + normalized form of a belief statement input — the exact
 * JSON that travels as the temporal revision's `state`.
 */
export interface ValidatedBeliefInput {
  /** The belief anchor's subject (v1 only; revisions keep the anchor's subject). */
  subject: SubjectRef | null;
  validFrom: string;
  rationale: string | null;
  /** The statement, fully validated; observations ride the revision's provenance. */
  statement: BeliefStatement;
  /** Supporting observations — the revision's provenance (1..16). */
  supportingObservationIds: string[];
}

export function validateBeliefInput(input: BeliefInput): ValidatedBeliefInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_belief_input', 'belief input must be an object');
  }
  return withCode('invalid_belief_input', () => {
    rejectUnknownKeys(input, BELIEF_INPUT_KEYS, 'invalid_belief_input', 'the belief input');
    return validateBeliefStatementFields(input);
  });
}

function validateBeliefStatementFields(input: Record<string, unknown>): ValidatedBeliefInput {
  const proposition = boundedString(input.proposition, 'proposition', MAX_PROPOSITION_CHARS);
  const confidence = requireConfidence(input.confidence, 'confidence');
  const supportingObservationIds = observationIdList(
    input.supportingObservationIds,
    'supportingObservationIds',
    true,
  );
  const supportingClaimIds = claimIdList(input.supportingClaimIds ?? [], 'supportingClaimIds');

  const alternatives: string[] = [];
  if (input.alternatives !== undefined && input.alternatives !== null) {
    if (!Array.isArray(input.alternatives)) {
      throw new EpistemicsError('invalid_belief_input', 'alternatives must be an array of strings');
    }
    if (input.alternatives.length > MAX_ALTERNATIVES) {
      throw new EpistemicsError(
        'invalid_belief_input',
        `alternatives supports at most ${MAX_ALTERNATIVES} entries`,
      );
    }
    for (const [index, alternative] of input.alternatives.entries()) {
      const text = boundedString(alternative, `alternatives[${index}]`, MAX_ALTERNATIVE_CHARS);
      if (alternatives.includes(text)) continue; // deduplicate identical phrasings
      alternatives.push(text);
    }
  }

  const disconfirmation =
    input.disconfirmation === undefined || input.disconfirmation === null
      ? null
      : boundedString(input.disconfirmation, 'disconfirmation', MAX_DISCONFIRMATION_CHARS);

  const subject = optionalSubjectRef(input.subject, 'subject');
  const validFrom = requireIsoInstant(input.validFrom, 'validFrom');
  const rationale = optionalBounded(input.rationale, 'rationale', MAX_RATIONALE_CHARS);

  const statement: BeliefStatement = {
    proposition,
    confidence,
    alternatives,
    disconfirmation,
    supportingClaimIds,
  };
  const serializedLength = JSON.stringify(statement)?.length ?? 0;
  if (serializedLength > MAX_BELIEF_STATE_BYTES) {
    throw new EpistemicsError(
      'invalid_belief_input',
      `the belief statement exceeds the maximum of ${MAX_BELIEF_STATE_BYTES} bytes (${serializedLength}); large artifacts belong in object storage`,
    );
  }
  return { subject, validFrom, rationale, statement, supportingObservationIds };
}

/** Fully validated form of `ReviseBeliefInput`. */
export interface ValidatedReviseBeliefInput extends ValidatedBeliefInput {
  beliefId: string;
}

export function validateReviseBeliefInput(input: ReviseBeliefInput): ValidatedReviseBeliefInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_belief_input', 'belief input must be an object');
  }
  return withCode('invalid_belief_input', () => {
    rejectUnknownKeys(input, REVISE_BELIEF_INPUT_KEYS, 'invalid_belief_input', 'the belief input');
    const beliefId = requireUuid(input.beliefId, 'beliefId');
    const fields = validateBeliefStatementFields(input);
    return { beliefId, ...fields };
  });
}

/** Fully validated form of `RetireBeliefInput`. */
export interface ValidatedRetireBeliefInput {
  beliefId: string;
  rationale: string;
}

export function validateRetireBeliefInput(input: RetireBeliefInput): ValidatedRetireBeliefInput {
  if (!isPlainObject(input)) {
    throw new EpistemicsError('invalid_belief_input', 'retirement input must be an object');
  }
  return withCode('invalid_belief_input', () => {
    rejectUnknownKeys(input, RETIRE_BELIEF_INPUT_KEYS, 'invalid_belief_input', 'the retirement input');
    const beliefId = requireUuid(input.beliefId, 'beliefId');
    const rationale = boundedString(input.rationale, 'rationale', MAX_NOTE_CHARS);
    return { beliefId, rationale };
  });
}

/** Fully validated form of `GetBeliefQuery` / `EvaluateBeliefFreshnessQuery`. */
export interface ValidatedGetBeliefQuery {
  beliefId: string;
  asOf: Date | null;
}

export function validateGetBeliefQuery(query: GetBeliefQuery): ValidatedGetBeliefQuery {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, BELIEF_QUERY_KEYS, 'invalid_query', 'the query');
  return {
    beliefId: requireUuid(query.beliefId, 'query.beliefId'),
    asOf: optionalAsOf(query.asOf, 'query.asOf'),
  };
}

/** Fully validated form of `ListBeliefsQuery`. */
export interface ValidatedListBeliefsQuery {
  status: BeliefStatus | null;
  subjectKind: string | null;
  subjectId: string | null;
  limit: number;
}

export function validateListBeliefsQuery(query: ListBeliefsQuery): ValidatedListBeliefsQuery {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, BELIEF_LIST_QUERY_KEYS, 'invalid_query', 'the query');
  return {
    status:
      query.status === undefined || query.status === null
        ? null
        : withCode('invalid_query', () => {
            if (!isBeliefStatus(query.status)) {
              throw new EpistemicsError(
                'invalid_query',
                `query.status must be one of ${BELIEF_STATUSES.join(', ')} (got '${String(query.status)}')`,
              );
            }
            return query.status;
          }),
    subjectKind:
      query.subjectKind === undefined || query.subjectKind === null
        ? null
        : withCode('invalid_query', () => boundedString(query.subjectKind, 'query.subjectKind', 128)),
    subjectId:
      query.subjectId === undefined || query.subjectId === null
        ? null
        : requireUuid(query.subjectId, 'query.subjectId'),
    limit: listLimit(query.limit),
  };
}

/** Fully validated form of `ListBeliefHistoryQuery`. */
export interface ValidatedListBeliefHistoryQuery {
  beliefId: string;
}

export function validateListBeliefHistoryQuery(
  query: ListBeliefHistoryQuery,
): ValidatedListBeliefHistoryQuery {
  if (!isPlainObject(query)) throw new EpistemicsError('invalid_query', 'query must be an object');
  rejectUnknownKeys(query, BELIEF_HISTORY_QUERY_KEYS, 'invalid_query', 'the query');
  return { beliefId: requireUuid(query.beliefId, 'query.beliefId') };
}

// ---------------------------------------------------------------------------
// Belief statement parsing (reading back what the module wrote)
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === 'string')
  );
}

/**
 * Parses a temporal revision's `state` JSON back into a `BeliefStatement`,
 * enforcing this module's invariants. The revision chain is writable through
 * the freshness contract by anyone, so a foreign/garbage state must surface
 * as `belief_state_corrupt` rather than leak malformed data through this
 * contract.
 */
export function parseBeliefStatement(state: unknown): BeliefStatement {
  if (!isPlainObject(state)) {
    throw new EpistemicsError('belief_state_corrupt', 'a belief version state is not an object');
  }
  const { proposition, confidence, alternatives, disconfirmation, supportingClaimIds } = state;
  if (typeof proposition !== 'string' || proposition.trim() === '') {
    throw new EpistemicsError('belief_state_corrupt', 'a belief version state has no proposition');
  }
  if (
    !isPlainObject(confidence) ||
    typeof confidence.value !== 'number' ||
    typeof confidence.method !== 'string'
  ) {
    throw new EpistemicsError('belief_state_corrupt', 'a belief version state has no confidence');
  }
  if (!isStringArray(alternatives)) {
    throw new EpistemicsError('belief_state_corrupt', 'a belief version state has malformed alternatives');
  }
  if (disconfirmation !== null && typeof disconfirmation !== 'string') {
    throw new EpistemicsError('belief_state_corrupt', 'a belief version state has a malformed disconfirmation');
  }
  if (!isStringArray(supportingClaimIds)) {
    throw new EpistemicsError('belief_state_corrupt', 'a belief version state has malformed supporting claim ids');
  }
  const basis: unknown = isPlainObject(confidence) ? confidence.basis : undefined;
  return {
    proposition,
    confidence: {
      value: confidence.value,
      method: confidence.method,
      basis: typeof basis === 'string' ? basis : null,
    },
    alternatives,
    disconfirmation: disconfirmation === null ? null : disconfirmation,
    supportingClaimIds,
  };
}
