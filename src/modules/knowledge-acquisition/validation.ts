// Pure validation/normalization logic of the knowledge-acquisition module
// (no database). Everything a caller may put into a plan or an outcome
// crosses these guards first; the SQL CHECK constraints in
// migrations/001-knowledge-acquisition.sql mirror the load-bearing rules
// as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `decision`, `chosen`, `action`, `question`,
// `askPolicy`, `ranked`, `budgetRemaining`, `estimatedCost`,
// `missionVersion`, `recordedAt` or `plannedByPrincipal` into a plan —
// the plan's identity, tenancy, decision, chosen action, composed
// question, ranking rationale, budget accounting and audit fields are
// minted by the system (ADR-0018's rationale is evidence, and evidence is
// not caller-forgeable). Likewise an outcome input carries no
// `evidenceObservationId`, `recordedByPrincipal` or `recordedAt`.
//
// Signal coverage (every candidate in the mission's CURRENT menu must be
// scored, and no others) is a service-level check — it needs the mission
// — and is covered by the service tests.

import type { TenantContext } from '@/infra/tenant';
import {
  isMissionCandidateKind,
  isMissionPartyKind,
  type MissionCandidateKind,
  type MissionPartyKind,
} from '@/modules/missions/contract';
import { candidateKey, isAcquisitionActionKind } from './ranking';
import { KnowledgeAcquisitionError } from './errors';
import type {
  AccessScope,
  AcquisitionOutcomeKind,
  ListAcquisitionPlansQuery,
  PlanDecision,
  PlanNextAcquisitionInput,
  RecordAcquisitionOutcomeInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const PLAN_DECISIONS = ['selected', 'no_candidate'] as const;

export const ACCESS_SCOPES = ['allowed', 'approval_required', 'forbidden'] as const;

export const ACQUISITION_OUTCOME_KINDS = ['answered', 'unavailable', 'failed'] as const;

export const EXCLUSION_REASONS = [
  'already_attempted',
  'access_forbidden',
  'person_unresolvable',
  'employee_inactive',
  'person_unreachable',
  'ask_policy_forbidden',
  'over_budget',
] as const;

export function isPlanDecision(value: unknown): value is PlanDecision {
  return typeof value === 'string' && (PLAN_DECISIONS as readonly string[]).includes(value);
}

export function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === 'string' && (ACCESS_SCOPES as readonly string[]).includes(value);
}

export function isAcquisitionOutcomeKind(value: unknown): value is AcquisitionOutcomeKind {
  return (
    typeof value === 'string' &&
    (ACQUISITION_OUTCOME_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Size caps (mirrors of the missions module's caps where the vocabulary
// is shared)
// ---------------------------------------------------------------------------

/** The mission menu is capped at 16 candidates (missions W011); so is the signal set. */
export const MAX_PLAN_CANDIDATES = 16;
export const MAX_LABEL_LENGTH = 200;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_QUESTION_LENGTH = 4000;
export const MAX_CONFIDENCE_METHOD_LENGTH = 64;
export const MAX_COST_AMOUNT = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with an explicit offset — evidence timestamps are
// unambiguous (mirrors the observations module's rule).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const PLAN_INPUT_KEYS = ['missionId', 'candidates', 'actor', 'rationale'] as const;
const CANDIDATE_KEYS = [
  'kind',
  'id',
  'label',
  'relevance',
  'reliability',
  'freshness',
  'authority',
  'expectedQuality',
  'priorContributionValue',
  'cost',
  'access',
] as const;
const ACTOR_KEYS = ['kind', 'id', 'label'] as const;
const OUTCOME_INPUT_KEYS = ['planId', 'outcome', 'note', 'evidence'] as const;
const EVIDENCE_KEYS = ['payload', 'confidence', 'observedAt'] as const;
const CONFIDENCE_KEYS = ['value', 'method', 'basis'] as const;
const LIST_QUERY_KEYS = ['missionId', 'decision', 'action', 'limit'] as const;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAcquisitionTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new KnowledgeAcquisitionError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new KnowledgeAcquisitionError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new KnowledgeAcquisitionError(
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
  error: (message: string) => KnowledgeAcquisitionError = planError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw error(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function planError(message: string): KnowledgeAcquisitionError {
  return new KnowledgeAcquisitionError('invalid_plan_input', message);
}

function outcomeError(message: string): KnowledgeAcquisitionError {
  return new KnowledgeAcquisitionError('invalid_outcome_input', message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw planError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw planError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw planError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw planError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/** A comparable score in [0, 1] (finite). */
function requireScore(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw planError(`${field} must be a finite number in [0, 1] (got ${String(value)})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Plan input
// ---------------------------------------------------------------------------

/** Fully validated + normalized candidate signal set. */
export interface ValidatedCandidateSignals {
  kind: MissionCandidateKind;
  id: string | null;
  label: string | null;
  relevance: number;
  reliability: number;
  freshness: number;
  authority: number;
  expectedQuality: number;
  priorContributionValue: number;
  cost: number;
  access: AccessScope;
}

/** Fully validated + normalized plan input. */
export interface ValidatedPlanInput {
  missionId: string;
  candidates: ValidatedCandidateSignals[];
  actor: { kind: MissionPartyKind; id: string | null; label: string | null };
  rationale: string | null;
}

function validateCandidateEntry(entry: unknown, where: string): ValidatedCandidateSignals {
  if (!isPlainObject(entry)) throw planError(`${where} must be an object`);
  rejectUnknownKeys(entry, CANDIDATE_KEYS, where);

  const kind = entry.kind;
  if (!isMissionCandidateKind(kind)) {
    throw planError(
      `${where}.kind must be one of person, system, document, external, agent, analysis (got '${String(kind)}')`,
    );
  }
  const id =
    entry.id === undefined || entry.id === null ? null : requireUuid(entry.id, `${where}.id`);
  const label = optionalTrimmed(entry.label, `${where}.label`, MAX_LABEL_LENGTH);
  if (id === null && label === null) {
    throw planError(
      `${where} must carry an id or a label — the scored candidate must be traceable`,
    );
  }

  return {
    kind,
    id,
    label,
    relevance: requireScore(entry.relevance, `${where}.relevance`),
    reliability: requireScore(entry.reliability, `${where}.reliability`),
    freshness: requireScore(entry.freshness, `${where}.freshness`),
    authority: requireScore(entry.authority, `${where}.authority`),
    expectedQuality: requireScore(entry.expectedQuality, `${where}.expectedQuality`),
    priorContributionValue: requireScore(
      entry.priorContributionValue,
      `${where}.priorContributionValue`,
    ),
    cost: validateCost(entry.cost, `${where}.cost`),
    access: validateAccess(entry.access, `${where}.access`),
  };
}

function validateCost(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw planError(`${field} must be a non-negative integer amount of minor units`);
  }
  if (value > MAX_COST_AMOUNT) {
    throw planError(`${field} must not exceed ${MAX_COST_AMOUNT} minor units (got ${value})`);
  }
  return value;
}

function validateAccess(value: unknown, field: string): AccessScope {
  if (!isAccessScope(value)) {
    throw planError(
      `${field} must be one of ${ACCESS_SCOPES.join(', ')} (got '${String(value)}')`,
    );
  }
  return value;
}

/** Fully validated + normalized form of `PlanNextAcquisitionInput`. */
export function validatePlanNextAcquisitionInput(input: PlanNextAcquisitionInput): ValidatedPlanInput {
  if (!isPlainObject(input)) throw planError('plan input must be an object');
  rejectUnknownKeys(input, PLAN_INPUT_KEYS, 'the plan input');

  const missionId = requireUuid(input.missionId, 'missionId');

  const candidatesRaw = input.candidates;
  if (!Array.isArray(candidatesRaw)) {
    throw planError('candidates must be an array of candidate signal sets');
  }
  if (candidatesRaw.length > MAX_PLAN_CANDIDATES) {
    throw planError(
      `candidates must hold at most ${MAX_PLAN_CANDIDATES} entries (got ${candidatesRaw.length})`,
    );
  }
  const candidates = candidatesRaw.map((entry, index) =>
    validateCandidateEntry(entry, `candidates[${index}]`),
  );
  // A caller must score each candidate exactly once (the same candidate
  // twice would make the ranking ambiguous).
  const seenKeys = new Set<string>();
  for (const entry of candidates) {
    const key = candidateKey(entry);
    if (seenKeys.has(key)) {
      throw planError(
        `duplicate ranking signals for candidate '${key}' — score each candidate once`,
      );
    }
    seenKeys.add(key);
  }

  if (!isPlainObject(input.actor)) throw planError('actor must be an object');
  rejectUnknownKeys(input.actor, ACTOR_KEYS, 'actor');
  const actorKind = input.actor.kind;
  if (!isMissionPartyKind(actorKind)) {
    throw planError(
      `actor.kind must be one of person, team, agent, system, external (got '${String(actorKind)}')`,
    );
  }
  const actorId =
    input.actor.id === undefined || input.actor.id === null
      ? null
      : requireUuid(input.actor.id, 'actor.id');
  const actorLabel = optionalTrimmed(input.actor.label, 'actor.label', MAX_LABEL_LENGTH);
  if (actorId === null && actorLabel === null) {
    throw planError('actor must carry an id or a label — the planning party must be traceable');
  }

  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH);

  return { missionId, candidates, actor: { kind: actorKind, id: actorId, label: actorLabel }, rationale };
}

// ---------------------------------------------------------------------------
// Outcome input
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RecordAcquisitionOutcomeInput`. */
export interface ValidatedOutcomeInput {
  planId: string;
  outcome: AcquisitionOutcomeKind;
  note: string | null;
  evidence: {
    payload: unknown;
    confidence: { value: number; method: string; basis: string | null };
    observedAt: string | null;
  } | null;
}

export function validateRecordAcquisitionOutcomeInput(
  input: RecordAcquisitionOutcomeInput,
): ValidatedOutcomeInput {
  if (!isPlainObject(input)) throw outcomeError('outcome input must be an object');
  rejectUnknownKeys(input, OUTCOME_INPUT_KEYS, 'the outcome input');

  const planId = ((): string => {
    if (typeof input.planId !== 'string') throw outcomeError('planId must be a string');
    const text = input.planId.trim();
    if (!UUID_PATTERN.test(text)) {
      throw outcomeError(`planId must be a uuid (got '${text}')`);
    }
    return text.toLowerCase();
  })();

  if (!isAcquisitionOutcomeKind(input.outcome)) {
    throw outcomeError(
      `outcome must be one of ${ACQUISITION_OUTCOME_KINDS.join(', ')} (got '${String(input.outcome)}')`,
    );
  }
  const outcome = input.outcome;

  // --- note: required on the non-answer terminal outcomes ---
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') throw outcomeError('note must be a string');
    const text = input.note.trim();
    if (text === '') {
      throw outcomeError('note must be a non-empty string when present');
    }
    if (text.length > MAX_NOTE_LENGTH) {
      throw outcomeError(`note must be at most ${MAX_NOTE_LENGTH} characters (got ${text.length})`);
    }
    note = text;
  }
  if (outcome !== 'answered' && note === null) {
    throw outcomeError(`outcome '${outcome}' requires a note — terminal outcomes record their why`);
  }

  // --- evidence: required on 'answered', forbidden otherwise ---
  if (outcome !== 'answered' && input.evidence !== undefined && input.evidence !== null) {
    throw outcomeError(
      `evidence may only be recorded on an 'answered' outcome (got '${outcome}')`,
    );
  }
  let evidence: ValidatedOutcomeInput['evidence'] = null;
  if (outcome === 'answered') {
    if (!isPlainObject(input.evidence)) {
      throw outcomeError(
        "an 'answered' outcome requires evidence — acquired knowledge enters as evidence",
      );
    }
    rejectUnknownKeys(input.evidence, EVIDENCE_KEYS, 'evidence', outcomeError);
    if (input.evidence.payload === undefined || input.evidence.payload === null) {
      throw outcomeError('evidence.payload must be a non-null JSON value');
    }
    if (!isPlainObject(input.evidence.confidence)) {
      throw outcomeError('evidence.confidence must be an object');
    }
    rejectUnknownKeys(input.evidence.confidence, CONFIDENCE_KEYS, 'evidence.confidence', outcomeError);
    const value = input.evidence.confidence.value;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw outcomeError(
        `evidence.confidence.value must be a finite number in [0, 1] (got ${String(value)})`,
      );
    }
    if (typeof input.evidence.confidence.method !== 'string') {
      throw outcomeError('evidence.confidence.method must be a string');
    }
    const method = input.evidence.confidence.method.trim();
    if (method === '') {
      throw outcomeError('evidence.confidence.method must be a non-empty string');
    }
    if (method.length > MAX_CONFIDENCE_METHOD_LENGTH) {
      throw outcomeError(
        `evidence.confidence.method must be at most ${MAX_CONFIDENCE_METHOD_LENGTH} characters (got ${method.length})`,
      );
    }
    let basis: string | null = null;
    if (
      input.evidence.confidence.basis !== undefined &&
      input.evidence.confidence.basis !== null
    ) {
      if (typeof input.evidence.confidence.basis !== 'string') {
        throw outcomeError('evidence.confidence.basis must be a string');
      }
      const text = input.evidence.confidence.basis.trim();
      basis = text === '' ? null : text;
    }
    let observedAt: string | null = null;
    if (input.evidence.observedAt !== undefined && input.evidence.observedAt !== null) {
      if (typeof input.evidence.observedAt !== 'string') {
        throw outcomeError('evidence.observedAt must be a string');
      }
      if (!ISO_INSTANT_PATTERN.test(input.evidence.observedAt)) {
        throw outcomeError(
          `evidence.observedAt must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${input.evidence.observedAt}')`,
        );
      }
      observedAt = input.evidence.observedAt;
    }
    evidence = { payload: input.evidence.payload, confidence: { value, method, basis }, observedAt };
  }

  return { planId, outcome, note, evidence };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ListAcquisitionPlansQuery`. */
export interface ValidatedListQuery {
  missionId: string | null;
  decision: PlanDecision | null;
  action: ListAcquisitionPlansQuery['action'] | null;
  limit: number;
}

export function validateListAcquisitionPlansQuery(query: ListAcquisitionPlansQuery): ValidatedListQuery {
  try {
    return validateListAcquisitionPlansQueryInner(query);
  } catch (error) {
    // The shared string guards throw `invalid_plan_input`; for a query the
    // correct code is `invalid_query` (the missions module's remapping
    // precedent).
    if (
      error instanceof KnowledgeAcquisitionError &&
      error.code === 'invalid_plan_input'
    ) {
      throw new KnowledgeAcquisitionError('invalid_query', error.message);
    }
    throw error;
  }
}

function validateListAcquisitionPlansQueryInner(query: ListAcquisitionPlansQuery): ValidatedListQuery {
  if (!isPlainObject(query)) {
    throw new KnowledgeAcquisitionError('invalid_query', 'query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new KnowledgeAcquisitionError(
      'invalid_query',
      `unknown query field '${unknown[0]}' (allowed: ${LIST_QUERY_KEYS.join(', ')})`,
    );
  }

  const missionId =
    query.missionId === undefined || query.missionId === null
      ? null
      : requireUuid(query.missionId, 'query.missionId');
  const decision =
    query.decision === undefined || query.decision === null ? null : query.decision;
  if (decision !== null && !isPlanDecision(decision)) {
    throw new KnowledgeAcquisitionError(
      'invalid_query',
      `query.decision must be one of ${PLAN_DECISIONS.join(', ')} (got '${String(decision)}')`,
    );
  }
  const action = query.action === undefined || query.action === null ? null : query.action;
  if (action !== null && !isAcquisitionActionKind(action)) {
    throw new KnowledgeAcquisitionError(
      'invalid_query',
      `query.action must be one of ask-person, query-system, retrieve-document, fetch-external, commission-agent, run-analysis (got '${String(action)}')`,
    );
  }
  const limit =
    query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new KnowledgeAcquisitionError(
      'invalid_query',
      `query.limit must be an integer between 1 and ${MAX_LIST_LIMIT} (got ${String(query.limit)})`,
    );
  }

  return { missionId, decision, action, limit };
}
