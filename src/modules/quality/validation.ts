// Pure validation/normalization logic of the quality module (no database).
// Everything a caller may put into a judgment or a snapshot computation
// crosses these guards first; the SQL CHECK constraints in
// migrations/001-quality-metrics.sql mirror the load-bearing rules as
// defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `recordedAt` or principal fields into an input — judgment
// and snapshot identity, tenancy, commit times and acting principals are
// minted by the system (records are auditable, and audit fields are not
// caller-forgeable).
//
// Timestamps are strict ISO 8601 instants with an explicit offset (the
// observations module's rule — timestamptz is unambiguous,
// IMPLEMENTATION-STACK §8). Windows are inclusive on both bounds and must
// be non-empty (from <= to is legal for point windows on judgments; a
// snapshot window must satisfy from < to).

import type { TenantContext } from '@/infra/tenant';
import { QualityError } from './errors';
import type {
  JudgmentKind,
  QualityMetricKind,
  QualityParty,
  QualityPartyKind,
  SourceSelectionVerdict,
  UnknownConsequentialityVerdict,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/** The nine metric families, in canonical (storage/return) order. */
export const QUALITY_METRIC_KINDS = [
  'unknown-discovery',
  'source-selection',
  'mission-resolution-efficiency',
  'evidence-quality',
  'recommendation-calibration',
  'intervention-success',
  'realized-value',
  'investigation-cost',
  'time-to-useful-understanding',
] as const;

export const JUDGMENT_KINDS = ['unknown-consequentiality', 'source-selection'] as const;

export const UNKNOWN_VERDICTS = ['consequential', 'not_consequential'] as const;

export const SELECTION_VERDICTS = ['correct', 'incorrect'] as const;

export const QUALITY_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

// ---------------------------------------------------------------------------
// Size caps and fetch bounds
// ---------------------------------------------------------------------------

export const MAX_GAP_KEY_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_METRIC_KINDS = QUALITY_METRIC_KINDS.length;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
/**
 * The bounded fetch caps one snapshot computation applies per source (the
 * honest-bounds discipline: a fetch that returns exactly its cap is named
 * in the snapshot's input audit as truncated, and consumers know the
 * numbers were computed over a bounded prefix).
 */
export const SOURCE_FETCH_LIMIT = 500;
export const JUDGMENTS_FETCH_LIMIT = 5000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with an explicit offset (the observations module's rule).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const UNKNOWN_JUDGMENT_KEYS = [
  'kind',
  'gapKey',
  'candidateId',
  'windowFrom',
  'windowTo',
  'verdict',
  'evaluator',
  'note',
] as const;

const SELECTION_JUDGMENT_KEYS = ['kind', 'planId', 'verdict', 'evaluator', 'note'] as const;

const SNAPSHOT_INPUT_KEYS = [
  'windowFrom',
  'windowTo',
  'metricKinds',
  'originExecutionId',
  'actor',
  'rationale',
] as const;

const PARTY_KEYS = ['kind', 'id', 'label'] as const;

const GET_JUDGMENT_QUERY_KEYS = ['judgmentId'] as const;
const LIST_JUDGMENTS_QUERY_KEYS = ['kind', 'gapKey', 'planId', 'limit'] as const;
const GET_SNAPSHOT_QUERY_KEYS = ['snapshotId'] as const;
const LIST_SNAPSHOTS_QUERY_KEYS = ['metricKind', 'limit'] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isQualityMetricKind(value: unknown): value is QualityMetricKind {
  return isOneOf(value, QUALITY_METRIC_KINDS);
}

export function isJudgmentKind(value: unknown): value is JudgmentKind {
  return isOneOf(value, JUDGMENT_KINDS);
}

export function isUnknownVerdict(value: unknown): value is UnknownConsequentialityVerdict {
  return isOneOf(value, UNKNOWN_VERDICTS);
}

export function isSelectionVerdict(value: unknown): value is SourceSelectionVerdict {
  return isOneOf(value, SELECTION_VERDICTS);
}

export function isQualityPartyKind(value: unknown): value is QualityPartyKind {
  return isOneOf(value, QUALITY_PARTY_KINDS);
}

/** Id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  err: (message: string) => QualityError,
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw err(`${what}: unknown key '${key}' is not accepted`);
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  err: (message: string) => QualityError,
  { min = 1, max }: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string') throw err(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw err(`${field} must not be empty`);
  if (max !== undefined && trimmed.length > max) {
    throw err(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  field: string,
  err: (message: string) => QualityError,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, err, { min: 1, max });
}

/** Strict ISO 8601 instant with explicit offset; returns epoch milliseconds. */
function requireIsoInstant(
  value: unknown,
  field: string,
  err: (message: string) => QualityError,
): number {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw err(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z`,
    );
  }
  return Date.parse(value);
}

function optionalIsoInstant(
  value: unknown,
  field: string,
  err: (message: string) => QualityError,
): number | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field, err);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertQualityTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new QualityError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new QualityError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new QualityError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

/** A traceable party: kind + (uuid id and/or human label), nothing else. */
function validateParty(
  value: unknown,
  err: (message: string) => QualityError,
  field: string,
): QualityParty {
  if (!isPlainObject(value)) throw err(`${field} must be an object`);
  assertKeys(value, PARTY_KEYS, err, field);
  if (!isQualityPartyKind(value.kind)) {
    throw err(`${field}.kind must be one of ${QUALITY_PARTY_KINDS.join(', ')}`);
  }
  const id = value.id === undefined || value.id === null ? null : requireString(value.id, `${field}.id`, err, { max: 200 });
  if (id !== null && !UUID_PATTERN.test(id)) {
    throw err(`${field}.id must be a uuid`);
  }
  const label = optionalString(value.label, `${field}.label`, err, MAX_PARTY_LABEL_LENGTH);
  if (id === null && label === null) {
    throw err(`${field} must carry an id and/or a label — the party must be traceable`);
  }
  return { kind: value.kind, id, label };
}

/** List-limit guard: 1..500, default 50. */
function requireLimit(value: unknown, err: (message: string) => QualityError): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw err(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// recordJudgment
// ---------------------------------------------------------------------------

/** The normalized shape of one judgment input (kind-discriminated). */
export type ValidatedJudgmentInput =
  | {
      kind: 'unknown-consequentiality';
      gapKey: string;
      candidateId: string | null;
      windowFromMs: number | null;
      windowToMs: number | null;
      verdict: UnknownConsequentialityVerdict;
      evaluator: QualityParty;
      note: string | null;
    }
  | {
      kind: 'source-selection';
      planId: string;
      verdict: SourceSelectionVerdict;
      evaluator: QualityParty;
      note: string | null;
    };

export function validateRecordJudgmentInput(input: unknown): ValidatedJudgmentInput {
  const err = (message: string): QualityError =>
    new QualityError('invalid_judgment_input', message);
  if (!isPlainObject(input)) throw err('judgment input must be an object');
  if (input.kind === 'unknown-consequentiality') {
    assertKeys(input, UNKNOWN_JUDGMENT_KEYS, err, 'judgment input');
    const gapKey = requireString(input.gapKey, 'gapKey', err, { min: 1, max: MAX_GAP_KEY_LENGTH });
    const candidateId =
      input.candidateId === undefined || input.candidateId === null
        ? null
        : requireString(input.candidateId, 'candidateId', err, { max: 100 });
    if (candidateId !== null && !UUID_PATTERN.test(candidateId)) {
      throw err('candidateId must be a uuid');
    }
    const windowFromMs = optionalIsoInstant(input.windowFrom, 'windowFrom', err);
    const windowToMs = optionalIsoInstant(input.windowTo, 'windowTo', err);
    if (windowFromMs !== null && windowToMs !== null && windowFromMs > windowToMs) {
      throw err('windowFrom must not be after windowTo');
    }
    if (!isUnknownVerdict(input.verdict)) {
      throw err(`verdict must be one of ${UNKNOWN_VERDICTS.join(', ')}`);
    }
    return {
      kind: 'unknown-consequentiality',
      gapKey,
      candidateId,
      windowFromMs,
      windowToMs,
      verdict: input.verdict,
      evaluator: validateParty(input.evaluator, err, 'evaluator'),
      note: optionalString(input.note, 'note', err, MAX_NOTE_LENGTH),
    };
  }
  if (input.kind === 'source-selection') {
    assertKeys(input, SELECTION_JUDGMENT_KEYS, err, 'judgment input');
    const planId = requireString(input.planId, 'planId', err, { max: 100 });
    if (!UUID_PATTERN.test(planId)) {
      throw err('planId must be a uuid');
    }
    if (!isSelectionVerdict(input.verdict)) {
      throw err(`verdict must be one of ${SELECTION_VERDICTS.join(', ')}`);
    }
    return {
      kind: 'source-selection',
      planId: planId.toLowerCase(),
      verdict: input.verdict,
      evaluator: validateParty(input.evaluator, err, 'evaluator'),
      note: optionalString(input.note, 'note', err, MAX_NOTE_LENGTH),
    };
  }
  throw err('kind must be one of unknown-consequentiality, source-selection');
}

// ---------------------------------------------------------------------------
// computeQualitySnapshot
// ---------------------------------------------------------------------------

export interface ValidatedSnapshotInput {
  windowFromMs: number;
  windowToMs: number;
  /** Canonical order, deduplicated. */
  metricKinds: QualityMetricKind[];
  originExecutionId: string | null;
  actor: QualityParty;
  rationale: string | null;
}

export function validateComputeSnapshotInput(input: unknown): ValidatedSnapshotInput {
  const err = (message: string): QualityError => new QualityError('invalid_snapshot_input', message);
  if (!isPlainObject(input)) throw err('snapshot input must be an object');
  assertKeys(input, SNAPSHOT_INPUT_KEYS, err, 'snapshot input');

  const windowFromMs = requireIsoInstant(input.windowFrom, 'windowFrom', err);
  const windowToMs = requireIsoInstant(input.windowTo, 'windowTo', err);
  if (windowFromMs >= windowToMs) {
    throw err('windowFrom must be strictly before windowTo');
  }

  if (!Array.isArray(input.metricKinds) || input.metricKinds.length < 1) {
    throw err('metricKinds must be a non-empty array of metric kinds');
  }
  if (input.metricKinds.length > MAX_METRIC_KINDS) {
    throw err(`metricKinds accepts at most ${MAX_METRIC_KINDS} kinds`);
  }
  const requested = new Set<string>();
  for (const kind of input.metricKinds) {
    if (!isQualityMetricKind(kind)) {
      throw err(`metricKinds entries must be one of ${QUALITY_METRIC_KINDS.join(', ')}`);
    }
    requested.add(kind);
  }
  // Canonical order — results are stored and returned deterministically.
  const metricKinds = QUALITY_METRIC_KINDS.filter((kind) => requested.has(kind));

  let originExecutionId: string | null = null;
  if (input.originExecutionId !== undefined && input.originExecutionId !== null) {
    originExecutionId = requireString(input.originExecutionId, 'originExecutionId', err, { max: 100 });
    if (!UUID_PATTERN.test(originExecutionId)) {
      throw err('originExecutionId must be a uuid');
    }
    originExecutionId = originExecutionId.toLowerCase();
  }

  return {
    windowFromMs,
    windowToMs,
    metricKinds,
    originExecutionId,
    actor: validateParty(input.actor, err, 'actor'),
    rationale: optionalString(input.rationale, 'rationale', err, MAX_RATIONALE_LENGTH),
  };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

export interface ValidatedGetJudgmentQuery {
  judgmentId: string;
}

export function validateGetJudgmentQuery(input: unknown): ValidatedGetJudgmentQuery {
  const err = (message: string): QualityError => new QualityError('invalid_judgment_query', message);
  if (!isPlainObject(input)) throw err('judgment query must be an object');
  assertKeys(input, GET_JUDGMENT_QUERY_KEYS, err, 'judgment query');
  const judgmentId = requireString(input.judgmentId, 'judgmentId', err, { max: 100 });
  if (!UUID_PATTERN.test(judgmentId)) throw err('judgmentId must be a uuid');
  return { judgmentId: judgmentId.toLowerCase() };
}

export interface ValidatedListJudgmentsQuery {
  kind: JudgmentKind | null;
  gapKey: string | null;
  planId: string | null;
  limit: number;
}

export function validateListJudgmentsQuery(input: unknown): ValidatedListJudgmentsQuery {
  const err = (message: string): QualityError => new QualityError('invalid_judgment_query', message);
  if (!isPlainObject(input)) throw err('judgment list query must be an object');
  assertKeys(input, LIST_JUDGMENTS_QUERY_KEYS, err, 'judgment list query');
  let kind: JudgmentKind | null = null;
  if (input.kind !== undefined && input.kind !== null) {
    if (!isJudgmentKind(input.kind)) {
      throw err(`kind must be one of ${JUDGMENT_KINDS.join(', ')}`);
    }
    kind = input.kind;
  }
  const gapKey = optionalString(input.gapKey, 'gapKey', err, MAX_GAP_KEY_LENGTH);
  let planId: string | null = null;
  if (input.planId !== undefined && input.planId !== null) {
    planId = requireString(input.planId, 'planId', err, { max: 100 });
    if (!UUID_PATTERN.test(planId)) throw err('planId must be a uuid');
    planId = planId.toLowerCase();
  }
  return { kind, gapKey, planId, limit: requireLimit(input.limit, err) };
}

export interface ValidatedGetSnapshotQuery {
  snapshotId: string;
}

export function validateGetSnapshotQuery(input: unknown): ValidatedGetSnapshotQuery {
  const err = (message: string): QualityError => new QualityError('invalid_snapshot_query', message);
  if (!isPlainObject(input)) throw err('snapshot query must be an object');
  assertKeys(input, GET_SNAPSHOT_QUERY_KEYS, err, 'snapshot query');
  const snapshotId = requireString(input.snapshotId, 'snapshotId', err, { max: 100 });
  if (!UUID_PATTERN.test(snapshotId)) throw err('snapshotId must be a uuid');
  return { snapshotId: snapshotId.toLowerCase() };
}

export interface ValidatedListSnapshotsQuery {
  metricKind: QualityMetricKind | null;
  limit: number;
}

export function validateListSnapshotsQuery(input: unknown): ValidatedListSnapshotsQuery {
  const err = (message: string): QualityError => new QualityError('invalid_snapshot_query', message);
  if (!isPlainObject(input)) throw err('snapshot list query must be an object');
  assertKeys(input, LIST_SNAPSHOTS_QUERY_KEYS, err, 'snapshot list query');
  let metricKind: QualityMetricKind | null = null;
  if (input.metricKind !== undefined && input.metricKind !== null) {
    if (!isQualityMetricKind(input.metricKind)) {
      throw err(`metricKind must be one of ${QUALITY_METRIC_KINDS.join(', ')}`);
    }
    metricKind = input.metricKind;
  }
  return { metricKind, limit: requireLimit(input.limit, err) };
}
