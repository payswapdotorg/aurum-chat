// Pure validation/normalization logic of the audit module (no database,
// no cross-module reads). Everything a caller may put into an audit
// record or a query crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `principalId` or `recordedAt` into an audit record —
// identity, tenancy, the recording principal and commit times are minted
// by the system (part of the append-only acceptance of W046: an audit
// record that exists cannot be rewritten through the input surface, and
// nobody can forge WHO recorded it).
//
// Also pure, and unit-tested in isolation:
//  * `chainCompleteness` — the per-§24-link presence report of a
//    reconstructed chain (what is absent is stated, never silent);
//  * `deriveExtractors` — the model/provider attribution from a set of
//    observations' lineages (§24 model/provider);
//  * `executionIdFromIdempotencyKey` — recognition of the cognition
//    contract's documented stable key `cognition:<executionId>:action`,
//    which links a directly-anchored action request back to the driving
//    cognitive execution.

import type { TenantContext } from '@/infra/tenant';
import { AuditError } from './errors';
import { CHAIN_STAGES } from './types';
import type {
  ChainStage,
  DecisionAnchor,
  DecisionChain,
  EvidenceObservation,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies and limits
// ---------------------------------------------------------------------------

export { CHAIN_STAGES };
export type { ChainStage };

/** Subject-kind / event grammar — the canonical slug vocabulary (epistemics precedent). */
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Strict ISO 8601 with an explicit offset (timestamptz; IMPLEMENTATION-STACK §8). */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** The cognition contract's stable per-execution action key. */
const COGNITION_ACTION_KEY_PATTERN = /^cognition:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):action$/;

export const MAX_SUMMARY_CHARS = 2048;
export const MAX_SUBJECT_KIND_CHARS = 128;
export const MAX_EVENT_CHARS = 64;
/** Serialized `detail` size cap — audit snapshots are bounded evidence. */
export const MAX_DETAIL_BYTES = 32768;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

/** The well-known audit subject kinds of the current repository surfaces. */
export const AUDIT_SUBJECT_AUTHORITY_POLICY = 'actions.policy';
export const AUDIT_SUBJECT_ACTION_REQUEST = 'actions.request';
export const AUDIT_SUBJECT_COGNITIVE_EXECUTION = 'cognition.execution';

export function isChainStage(value: unknown): value is ChainStage {
  return typeof value === 'string' && (CHAIN_STAGES as readonly string[]).includes(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAuditTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AuditError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AuditError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new AuditError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
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
  code: 'invalid_record_input' | 'invalid_query',
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new AuditError(code, `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  code: 'invalid_record_input' | 'invalid_query',
): string {
  if (typeof value !== 'string') throw new AuditError(code, `${field} must be a string`);
  const text = value.trim();
  if (text === '') throw new AuditError(code, `${field} must be a non-empty string`);
  return text;
}

function parseInstant(
  value: unknown,
  field: string,
): Date {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
    throw new AuditError(
      'invalid_query',
      `${field} must be a strict ISO 8601 instant with an explicit offset`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AuditError('invalid_query', `${field} is not a valid instant`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// recordAudit
// ---------------------------------------------------------------------------

export interface ValidatedRecordAuditInput {
  subjectKind: string;
  subjectId: string | null;
  event: string;
  chainStage: ChainStage;
  correlationId: string | null;
  summary: string;
  detail: Record<string, unknown>;
}

export function validateRecordAuditInput(input: unknown): ValidatedRecordAuditInput {
  if (!isPlainObject(input)) {
    throw new AuditError('invalid_record_input', 'recordAudit input must be a plain object');
  }
  rejectUnknownKeys(
    input,
    ['subjectKind', 'subjectId', 'event', 'chainStage', 'correlationId', 'summary', 'detail'],
    'invalid_record_input',
    'recordAudit input',
  );

  const subjectKind = requireString(input.subjectKind, 'subjectKind', 'invalid_record_input');
  if (subjectKind.length > MAX_SUBJECT_KIND_CHARS || !KIND_PATTERN.test(subjectKind)) {
    throw new AuditError(
      'invalid_record_input',
      `subjectKind must match the canonical slug grammar (1..${MAX_SUBJECT_KIND_CHARS} chars)`,
    );
  }

  let subjectId: string | null = null;
  if (input.subjectId !== undefined && input.subjectId !== null) {
    if (!isUuid(input.subjectId)) {
      throw new AuditError('invalid_record_input', 'subjectId must be a uuid or null');
    }
    subjectId = input.subjectId;
  }

  const event = requireString(input.event, 'event', 'invalid_record_input');
  if (event.length > MAX_EVENT_CHARS || !KIND_PATTERN.test(event)) {
    throw new AuditError(
      'invalid_record_input',
      `event must match the canonical slug grammar (1..${MAX_EVENT_CHARS} chars)`,
    );
  }

  if (!isChainStage(input.chainStage)) {
    throw new AuditError(
      'invalid_record_input',
      `chainStage must be one of the §24 chain stages: ${CHAIN_STAGES.join(', ')}`,
    );
  }

  let correlationId: string | null = null;
  if (input.correlationId !== undefined && input.correlationId !== null) {
    if (!isUuid(input.correlationId)) {
      throw new AuditError('invalid_record_input', 'correlationId must be a uuid or null');
    }
    correlationId = input.correlationId;
  }

  const summary = requireString(input.summary, 'summary', 'invalid_record_input');
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new AuditError(
      'invalid_record_input',
      `summary must be at most ${MAX_SUMMARY_CHARS} characters`,
    );
  }

  let detail: Record<string, unknown> = {};
  if (input.detail !== undefined && input.detail !== null) {
    if (!isPlainObject(input.detail)) {
      throw new AuditError('invalid_record_input', 'detail must be a plain JSON object');
    }
    const serialized = JSON.stringify(input.detail);
    if (serialized === undefined || serialized.length > MAX_DETAIL_BYTES) {
      throw new AuditError(
        'invalid_record_input',
        `detail must serialize to at most ${MAX_DETAIL_BYTES} bytes`,
      );
    }
    detail = input.detail;
  }

  return { subjectKind, subjectId, event, chainStage: input.chainStage, correlationId, summary, detail };
}

// ---------------------------------------------------------------------------
// getAuditRecord / listAuditRecords
// ---------------------------------------------------------------------------

export interface ValidatedGetAuditRecordQuery {
  recordId: string;
}

export function validateGetAuditRecordQuery(query: unknown): ValidatedGetAuditRecordQuery {
  if (!isPlainObject(query)) {
    throw new AuditError('invalid_query', 'audit-record query must be a plain object');
  }
  rejectUnknownKeys(query, ['recordId'], 'invalid_query', 'audit-record query');
  if (!isUuid(query.recordId)) {
    throw new AuditError('invalid_query', 'recordId must be a uuid');
  }
  return { recordId: query.recordId };
}

export interface ValidatedListAuditRecordsQuery {
  subjectKind: string | null;
  subjectId: string | null;
  /** True when the caller explicitly filtered on a NULL subject id (tenant-wide subjects). */
  subjectIdIsNull: boolean;
  correlationId: string | null;
  chainStage: ChainStage | null;
  event: string | null;
  recordedFrom: Date | null;
  recordedTo: Date | null;
  limit: number;
}

export function validateListAuditRecordsQuery(query: unknown): ValidatedListAuditRecordsQuery {
  if (!isPlainObject(query)) {
    throw new AuditError('invalid_query', 'audit-records query must be a plain object');
  }
  rejectUnknownKeys(
    query,
    ['subjectKind', 'subjectId', 'correlationId', 'chainStage', 'event', 'recordedFrom', 'recordedTo', 'limit'],
    'invalid_query',
    'audit-records query',
  );

  let subjectKind: string | null = null;
  if (query.subjectKind !== undefined && query.subjectKind !== null && query.subjectKind !== '') {
    subjectKind = requireString(query.subjectKind, 'subjectKind', 'invalid_query');
    if (subjectKind.length > MAX_SUBJECT_KIND_CHARS || !KIND_PATTERN.test(subjectKind)) {
      throw new AuditError(
        'invalid_query',
        `subjectKind must match the canonical slug grammar (1..${MAX_SUBJECT_KIND_CHARS} chars)`,
      );
    }
  }

  let subjectId: string | null = null;
  let subjectIdIsNull = false;
  if (query.subjectId !== undefined) {
    if (query.subjectId === null) {
      if (subjectKind === null) {
        throw new AuditError('invalid_query', 'subjectId (null) requires subjectKind');
      }
      subjectIdIsNull = true;
    } else {
      if (subjectKind === null) {
        throw new AuditError('invalid_query', 'subjectId requires subjectKind');
      }
      if (!isUuid(query.subjectId)) {
        throw new AuditError('invalid_query', 'subjectId must be a uuid or null');
      }
      subjectId = query.subjectId;
    }
  }

  let correlationId: string | null = null;
  if (query.correlationId !== undefined && query.correlationId !== null && query.correlationId !== '') {
    if (!isUuid(query.correlationId)) {
      throw new AuditError('invalid_query', 'correlationId must be a uuid');
    }
    correlationId = query.correlationId;
  }

  let chainStage: ChainStage | null = null;
  if (query.chainStage !== undefined && query.chainStage !== null && query.chainStage !== '') {
    if (!isChainStage(query.chainStage)) {
      throw new AuditError(
        'invalid_query',
        `chainStage must be one of the §24 chain stages: ${CHAIN_STAGES.join(', ')}`,
      );
    }
    chainStage = query.chainStage;
  }

  let event: string | null = null;
  if (query.event !== undefined && query.event !== null && query.event !== '') {
    event = requireString(query.event, 'event', 'invalid_query');
    if (event.length > MAX_EVENT_CHARS || !KIND_PATTERN.test(event)) {
      throw new AuditError(
        'invalid_query',
        `event must match the canonical slug grammar (1..${MAX_EVENT_CHARS} chars)`,
      );
    }
  }

  let recordedFrom: Date | null = null;
  if (query.recordedFrom !== undefined && query.recordedFrom !== null && query.recordedFrom !== '') {
    recordedFrom = parseInstant(query.recordedFrom, 'recordedFrom');
  }
  let recordedTo: Date | null = null;
  if (query.recordedTo !== undefined && query.recordedTo !== null && query.recordedTo !== '') {
    recordedTo = parseInstant(query.recordedTo, 'recordedTo');
  }
  if (recordedFrom !== null && recordedTo !== null && recordedTo < recordedFrom) {
    throw new AuditError('invalid_query', 'recordedTo must not precede recordedFrom');
  }

  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw new AuditError('invalid_query', `limit must be an integer in 1..${MAX_LIST_LIMIT}`);
  }

  return { subjectKind, subjectId, subjectIdIsNull, correlationId, chainStage, event, recordedFrom, recordedTo, limit };
}

// ---------------------------------------------------------------------------
// reconstructDecision
// ---------------------------------------------------------------------------

export interface ValidatedReconstructDecisionQuery {
  anchor: DecisionAnchor;
}

export function validateReconstructDecisionQuery(query: unknown): ValidatedReconstructDecisionQuery {
  if (!isPlainObject(query)) {
    throw new AuditError('invalid_query', 'reconstructDecision query must be a plain object');
  }
  rejectUnknownKeys(
    query,
    ['executionId', 'actionRequestId', 'correlationId'],
    'invalid_query',
    'reconstructDecision query',
  );
  const supplied: { field: 'executionId' | 'actionRequestId' | 'correlationId'; value: string }[] = [];
  for (const field of ['executionId', 'actionRequestId', 'correlationId'] as const) {
    const value = query[field];
    if (value === undefined || value === null || value === '') continue;
    if (!isUuid(value)) {
      throw new AuditError('invalid_query', `${field} must be a uuid`);
    }
    supplied.push({ field, value });
  }
  if (supplied.length === 0) {
    throw new AuditError(
      'invalid_anchor',
      'reconstructDecision requires exactly one anchor: executionId, actionRequestId or correlationId',
    );
  }
  if (supplied.length > 1) {
    throw new AuditError(
      'invalid_anchor',
      `reconstructDecision takes exactly one anchor (got: ${supplied.map((s) => s.field).join(', ')})`,
    );
  }
  const first = supplied[0]!;
  const anchor: DecisionAnchor =
    first.field === 'executionId'
      ? { kind: 'execution', id: first.value }
      : first.field === 'actionRequestId'
        ? { kind: 'action-request', id: first.value }
        : { kind: 'correlation', id: first.value };
  return { anchor };
}

/**
 * The cognition contract's documented stable idempotency key is
 * `cognition:<executionId>:action` (the per-execution action key). Given
 * an action request's key, this returns the driving execution's id, or
 * null when the key was minted by any other emitter (a direct
 * authorization carries no execution link).
 */
export function executionIdFromIdempotencyKey(key: string | null): string | null {
  if (key === null) return null;
  const match = COGNITION_ACTION_KEY_PATTERN.exec(key);
  return match === null ? null : match[1]!;
}

// ---------------------------------------------------------------------------
// Pure chain derivations (unit-tested in isolation)
// ---------------------------------------------------------------------------

/**
 * The §24 model/provider attribution: the distinct provider/model
 * extractors found in a set of observations' lineages, each with the
 * observations they extracted. Pure and total.
 */
export function deriveExtractors(observations: EvidenceObservation[]): {
  provider: string;
  model: string;
  observationIds: string[];
}[] {
  const byKey = new Map<string, { provider: string; model: string; observationIds: string[] }>();
  for (const observation of observations) {
    if (observation.unreadable || observation.extractor === null) continue;
    const key = `${observation.extractor.provider}\u0000${observation.extractor.model}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        provider: observation.extractor.provider,
        model: observation.extractor.model,
        observationIds: [observation.id],
      });
    } else if (!existing.observationIds.includes(observation.id)) {
      existing.observationIds.push(observation.id);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}

/**
 * The per-link completeness report of a reconstructed chain, in §24
 * order. Each link reports whether it carries content and how many
 * items support it — a mid-flight decision (an execution suspended
 * awaiting approval) reconstructs honestly with its later links absent,
 * never silently missing.
 */
export function chainCompleteness(chain: DecisionChain): {
  stage: ChainStage;
  present: boolean;
  itemCount: number;
}[] {
  const counts: Record<ChainStage, number> = {
    input: (chain.input.trigger !== null ? 1 : 0) + (chain.input.observation !== null ? 1 : 0),
    evidence: chain.evidence.observations.length + chain.evidence.knowledge.length + chain.evidence.transactive.length,
    'claims-beliefs': chain.claimsBeliefs.claims.length + chain.claimsBeliefs.beliefs.length,
    'unknown-mission': chain.unknownMission.unknowns.length + chain.unknownMission.missions.length,
    policy: (chain.policy.authorityEvaluation !== null ? 1 : 0) + chain.policy.events.length,
    'model-provider': chain.modelProvider.extractors.length + chain.modelProvider.events.length,
    recommendation: chain.recommendation.actionRequest !== null ? 1 : 0,
    approval: chain.approval.decisions.length,
    execution: chain.execution.executions.length + (chain.execution.directAuthorization ? 1 : 0),
    result:
      (chain.result.gate !== null ? 1 : 0) +
      (chain.result.resolution !== null ? 1 : 0) +
      (chain.result.requestStatus !== null ? 1 : 0),
    outcome: chain.outcome.outcomes.length,
    learning: chain.learning.knowledge.length,
  };
  return CHAIN_STAGES.map((stage) => ({
    stage,
    present: counts[stage] > 0,
    itemCount: counts[stage],
  }));
}
