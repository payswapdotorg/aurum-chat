// Pure validation/normalization logic of the cognition module (no
// database). Everything a caller may put into a cognitive execution or a
// stage advance crosses these guards first; the SQL CHECK constraints in
// migrations/001-cognition.sql mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys on the module's OWN surface: a
// caller can never smuggle `id`, `tenantId`, `state`, `completedStages`,
// `outcome`, `recordedAt`, `startedByPrincipal` or per-step audit fields
// into an input — the execution's identity, tenancy, lifecycle, position,
// outcome-kind derivation and commit metadata are minted by the system
// (cognitive executions are traceable, and trace fields are not
// caller-forgeable).
//
// Stage payloads that CARRY sibling-contract content (observation intake,
// claim derivations, unknown derivations, mission launches, world-model
// updates, belief updates, action proposals, learning captures) are
// shape-checked here and validated AUTHORITATIVELY by the owning module
// at write time — the loop is the orchestrator, not a second validator
// of its siblings' domains. Shape checks still bound what is persisted
// into the step's input snapshot (sizes, counts, enums), so the trace
// cannot be bloated past the caps below.

import type { TenantContext } from '@/infra/tenant';
import { CognitionError } from './errors';
import {
  EXECUTION_CAUSATION_KINDS,
  EXECUTION_STATES,
  EXECUTION_TRIGGER_KINDS,
  LOOP_STAGES,
  isExecutionCausationKind,
  isExecutionState,
  isExecutionTriggerKind,
  isLoopStage,
  type ExecutionState,
  type ExecutionTriggerKind,
  type LoopStage,
} from './loop';
import type {
  AbandonExecutionInput,
  ActionProposalInput,
  AdvanceExecutionInput,
  AnalysisFindingInput,
  BeliefUpdateInput,
  ClaimDerivationInput,
  ExecutionCausation,
  LearningCaptureInput,
  ListExecutionsQuery,
  MissionLaunchInput,
  ObservationIntakeInput,
  StartExecutionInput,
  UnknownDerivationInput,
  WorldModelUpdateInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** Kinds of parties that can drive the loop (mission-party vocabulary). */
export const EXECUTION_ACTOR_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** Finding kinds of the risk/opportunity/capability analysis stage. */
export const ANALYSIS_FINDING_KINDS = ['risk', 'opportunity', 'capability-gap'] as const;

/** Candidate-source kinds a launched mission may name (W011 vocabulary). */
const MISSION_CANDIDATE_KINDS = ['person', 'system', 'document', 'external', 'agent', 'analysis'] as const;

/** Mission urgencies a launched mission may carry (W011 vocabulary). */
const MISSION_URGENCIES = ['critical', 'high', 'medium', 'low'] as const;

/** The §20 authority levels (actions-module vocabulary, mirrored read-only). */
const AUTHORITY_LEVELS = ['OBSERVE', 'ANALYZE', 'RECOMMEND', 'ASK', 'PROPOSE', 'EXECUTE'] as const;

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

export const MAX_FOCUS_TOPICS = 16;
export const MAX_FOCUS_ENTITIES = 16;
export const MAX_RECORDED_OBSERVATIONS = 8;
export const MAX_REFERENCED_OBSERVATIONS = 16;
export const MAX_CLAIMS_PER_STAGE = 8;
export const MAX_RELATED_GOALS = 16;
export const MAX_UNKNOWNS_PER_STAGE = 8;
export const MAX_MISSIONS_PER_STAGE = 4;
export const MAX_FINDINGS_PER_STAGE = 16;
export const MAX_EVIDENCE_REFS = 16;
export const MAX_TOPIC_LENGTH = 64;
export const MAX_LABEL_LENGTH = 200;
export const MAX_KIND_LENGTH = 200;
export const MAX_RATIONALE_LENGTH = 2000;
export const MAX_REASON_LENGTH = 2000;
export const MAX_SUMMARY_LENGTH = 4000;
export const MAX_STATEMENT_LENGTH = 2000;
export const MAX_PROPOSITION_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 200;
export const MAX_JUSTIFICATION_LENGTH = 512;
export const MAX_CHANNEL_LENGTH = 64;
export const MAX_METHOD_LENGTH = 64;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_ALTERNATIVES = 16;
/** Whole-payload serialized cap (matches the actions/observations payload cap). */
export const MAX_STAGE_INPUT_BYTES = 1_048_576;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACTION_KIND_PATTERN = /^[a-z][a-z0-9-]{0,199}$/;

// ---------------------------------------------------------------------------
// Validated shapes (the normalized payloads the service works with; the
// step's input snapshot persists exactly these)
// ---------------------------------------------------------------------------

export interface ValidatedStartInput {
  trigger: { kind: ExecutionTriggerKind; id: string | null; label: string | null };
  focus: { topics: string[]; entities: { kind: string; id: string | null; label: string | null }[] };
  actor: { kind: (typeof EXECUTION_ACTOR_KINDS)[number]; id: string | null; label: string | null };
  correlationId: string | null;
  causation: ExecutionCausation | null;
  rationale: string | null;
}

export type ValidatedAdvance =
  | { stage: 'observation'; record: ObservationIntakeInput[]; reference: string[] }
  | { stage: 'evidence-memory' }
  | { stage: 'world-update'; update: WorldModelUpdateInput | null }
  | { stage: 'epistemic-evaluation'; claims: ClaimDerivationInput[] }
  | { stage: 'goal-evaluation'; relatedGoalIds: string[] }
  | { stage: 'unknown-mission-evaluation'; unknowns: UnknownDerivationInput[]; missions: MissionLaunchInput[] }
  | { stage: 'knowledge-acquisition'; missionId: string | null }
  | { stage: 'model-update'; belief: BeliefUpdateInput | null }
  | { stage: 'risk-opportunity-capability-analysis'; findings: AnalysisFindingInput[] }
  | { stage: 'recommendation-ask-proposal-action'; action: ActionProposalInput | null }
  | { stage: 'outcome'; summary: string }
  | { stage: 'learning'; knowledge: LearningCaptureInput | null };

export interface ValidatedAbandonInput {
  executionId: string;
  reason: string;
}

export interface ValidatedStepQuery {
  executionId: string;
  stage: LoopStage;
}

export interface ValidatedListQuery {
  state: ExecutionState | null;
  triggerKind: ExecutionTriggerKind | null;
  correlationId: string | null;
  limit: number;
}

// ---------------------------------------------------------------------------
// Primitives (fail always throws — typed `never`, the memory-module pattern)
// ---------------------------------------------------------------------------

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startFail(message: string): never {
  throw new CognitionError('invalid_start_input', message);
}

function stageFail(message: string): never {
  throw new CognitionError('invalid_stage_input', message);
}

function queryFail(message: string): never {
  throw new CognitionError('invalid_query', message);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  fail: (m: string) => never,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail(`${field} carries unknown key '${key}' — only ${keys.join(', ')} are accepted`);
    }
  }
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  fail: (m: string) => never,
  min = 1,
): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const text = (value as string).trim();
  if (text.length < min || text.length > max) {
    fail(`${field} must be ${min}..${max} characters (got ${text.length})`);
  }
  return text;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  max: number,
  fail: (m: string) => never,
): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, field, max, fail);
}

function uuidList(value: unknown, field: string, max: number, fail: (m: string) => never): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of uuids`);
  const items = value as unknown[];
  if (items.length > max) fail(`${field} may carry at most ${max} entries (got ${items.length})`);
  const out: string[] = [];
  for (const item of items) {
    if (!isUuid(item)) fail(`${field} entries must be uuids (got '${String(item)}')`);
    out.push(item as string);
  }
  return [...new Set(out)].sort();
}

function confidenceObject(
  value: unknown,
  field: string,
  fail: (m: string) => never,
): { value: number; method: string; basis: string | null } {
  if (!isPlainObject(value)) fail(`${field} must be a confidence object {value, method, basis?}`);
  hasOnlyKeys(value, ['value', 'method', 'basis'], fail, field);
  const confValue = value.value;
  if (typeof confValue !== 'number' || !Number.isFinite(confValue) || confValue < 0 || confValue > 1) {
    fail(`${field}.value must be a number in [0, 1]`);
  }
  const method = boundedString(value.method, `${field}.method`, MAX_METHOD_LENGTH, fail);
  const basis = optionalBoundedString(value.basis, `${field}.basis`, MAX_NOTE_LENGTH, fail);
  return { value: confValue, method, basis };
}

function subjectRef(
  value: unknown,
  field: string,
  fail: (m: string) => never,
): { kind: string; id: string } | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail(`${field} must be a subject reference {kind, id}`);
  hasOnlyKeys(value, ['kind', 'id'], fail, field);
  const kind = boundedString(value.kind, `${field}.kind`, MAX_KIND_LENGTH, fail);
  if (!isUuid(value.id)) fail(`${field}.id must be a uuid`);
  return { kind, id: value.id as string };
}

function partyRef(
  value: unknown,
  field: string,
  kinds: readonly string[],
  fail: (m: string) => never,
  requireTraceable: boolean,
): { kind: string; id: string | null; label: string | null } {
  if (!isPlainObject(value)) fail(`${field} must be an object`);
  hasOnlyKeys(value, ['kind', 'id', 'label'], fail, field);
  if (typeof value.kind !== 'string' || !kinds.includes(value.kind)) {
    fail(`${field}.kind must be one of ${kinds.join(', ')}`);
  }
  let id: string | null = null;
  if (value.id !== undefined && value.id !== null) {
    if (!isUuid(value.id)) fail(`${field}.id must be a uuid`);
    id = value.id as string;
  }
  const label = optionalBoundedString(value.label, `${field}.label`, MAX_LABEL_LENGTH, fail);
  if (requireTraceable && id === null && label === null) {
    fail(`${field} must carry an id or a label — provenance must be traceable`);
  }
  return { kind: value.kind as string, id, label };
}

/** Serializable, non-null, within the byte cap (§24 snapshots stay bounded). */
function jsonPayload(value: unknown, field: string, fail: (m: string) => never): unknown {
  if (value === undefined || value === null) fail(`${field} must be a non-null JSON value`);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(`${field} must be JSON-serializable`);
  }
  if (serialized === undefined) fail(`${field} must be JSON-serializable`);
  if (serialized.length > MAX_STAGE_INPUT_BYTES) {
    fail(
      `${field} exceeds the maximum of ${MAX_STAGE_INPUT_BYTES} bytes (${serialized.length}); large artifacts belong in object storage`,
    );
  }
  return value;
}

function isoTimestamp(value: unknown, field: string, fail: (m: string) => never): string {
  const text = boundedString(value, field, 64, fail);
  if (Number.isNaN(Date.parse(text))) fail(`${field} must be a strict ISO 8601 timestamp (got '${text}')`);
  return text;
}

function topics(value: unknown, field: string, fail: (m: string) => never): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of topics`);
  const items = value as unknown[];
  if (items.length < 1 || items.length > MAX_FOCUS_TOPICS) {
    fail(`${field} must carry 1..${MAX_FOCUS_TOPICS} topics (got ${items.length})`);
  }
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || !SLUG_PATTERN.test(item)) {
      fail(`${field} entries must be lowercase slugs matching ${SLUG_PATTERN.source} (got '${String(item)}')`);
    }
    out.push(item);
  }
  return [...new Set(out)].sort();
}

// ---------------------------------------------------------------------------
// TenantContext
// ---------------------------------------------------------------------------

export function assertCognitionTenantContext(ctx: TenantContext): void {
  if (
    !isPlainObject(ctx) ||
    typeof ctx.tenantId !== 'string' ||
    ctx.tenantId.trim().length === 0 ||
    ctx.tenantId.length > 128 ||
    typeof ctx.principalId !== 'string' ||
    ctx.principalId.trim().length === 0 ||
    ctx.principalId.length > 128 ||
    !Array.isArray(ctx.authority)
  ) {
    throw new CognitionError(
      'invalid_context',
      'a valid TenantContext (tenantId, principalId, authority) is required',
    );
  }
}

// ---------------------------------------------------------------------------
// startExecution
// ---------------------------------------------------------------------------

const START_INPUT_KEYS = ['trigger', 'focus', 'actor', 'correlationId', 'causation', 'rationale'] as const;

function entityRef(
  value: unknown,
  field: string,
  fail: (m: string) => never,
): { kind: string; id: string | null; label: string | null } {
  if (!isPlainObject(value)) fail(`${field} must be an object {kind, id?, label?}`);
  hasOnlyKeys(value, ['kind', 'id', 'label'], fail, field);
  const kind = boundedString(value.kind, `${field}.kind`, MAX_KIND_LENGTH, fail);
  let id: string | null = null;
  if (value.id !== undefined && value.id !== null) {
    if (!isUuid(value.id)) fail(`${field}.id must be a uuid`);
    id = value.id as string;
  }
  const label = optionalBoundedString(value.label, `${field}.label`, MAX_LABEL_LENGTH, fail);
  return { kind, id, label };
}

export function validateStartExecutionInput(input: unknown): ValidatedStartInput {

  if (!isPlainObject(input)) startFail('start input must be an object');
  hasOnlyKeys(input, START_INPUT_KEYS, startFail, 'start input');

  // --- trigger ---
  if (!isPlainObject(input.trigger)) startFail('trigger must be an object {kind, id?, label?}');
  hasOnlyKeys(input.trigger, ['kind', 'id', 'label'], startFail, 'trigger');
  if (!isExecutionTriggerKind(input.trigger.kind)) {
    startFail(`trigger.kind must be one of ${EXECUTION_TRIGGER_KINDS.join(', ')}`);
  }
  let triggerId: string | null = null;
  if (input.trigger.id !== undefined && input.trigger.id !== null) {
    if (!isUuid(input.trigger.id)) startFail('trigger.id must be a uuid');
    triggerId = input.trigger.id as string;
  }
  const triggerLabel = optionalBoundedString(input.trigger.label, 'trigger.label', MAX_LABEL_LENGTH, startFail);
  if (input.trigger.kind === 'observation' && triggerId === null) {
    startFail('an observation trigger must carry the observation uuid (trigger.id)');
  }
  if (triggerId === null && triggerLabel === null) {
    startFail('trigger must carry an id or a label — provenance must be traceable');
  }
  const trigger = { kind: input.trigger.kind as ExecutionTriggerKind, id: triggerId, label: triggerLabel };

  // --- focus ---
  if (!isPlainObject(input.focus)) startFail('focus must be an object {topics, entities?}');
  hasOnlyKeys(input.focus, ['topics', 'entities'], startFail, 'focus');
  const focusTopics = topics(input.focus.topics, 'focus.topics', startFail);
  let focusEntities: { kind: string; id: string | null; label: string | null }[] = [];
  if (input.focus.entities !== undefined && input.focus.entities !== null) {
    if (!Array.isArray(input.focus.entities)) startFail('focus.entities must be an array');
    const items = input.focus.entities as unknown[];
    if (items.length > MAX_FOCUS_ENTITIES) {
      startFail(`focus.entities may carry at most ${MAX_FOCUS_ENTITIES} entries (got ${items.length})`);
    }
    focusEntities = items.map((item, index) => entityRef(item, `focus.entities[${index}]`, startFail));
  }

  // --- actor ---
  const actor = partyRef(input.actor, 'actor', EXECUTION_ACTOR_KINDS, startFail, true) as ValidatedStartInput['actor'];

  // --- correlation / causation ---
  let correlationId: string | null = null;
  if (input.correlationId !== undefined && input.correlationId !== null) {
    if (!isUuid(input.correlationId)) startFail('correlationId must be a uuid');
    correlationId = input.correlationId as string;
  }
  let causation: ExecutionCausation | null = null;
  if (input.causation !== undefined && input.causation !== null) {
    if (!isPlainObject(input.causation)) startFail('causation must be an object {kind, id}');
    hasOnlyKeys(input.causation, ['kind', 'id'], startFail, 'causation');
    if (!isExecutionCausationKind(input.causation.kind)) {
      startFail(`causation.kind must be one of ${EXECUTION_CAUSATION_KINDS.join(', ')}`);
    }
    if (!isUuid(input.causation.id)) startFail('causation.id must be a uuid');
    causation = { kind: input.causation.kind, id: input.causation.id as string };
  }

  const rationale = optionalBoundedString(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, startFail);

  return { trigger, focus: { topics: focusTopics, entities: focusEntities }, actor, correlationId, causation, rationale };
}

// ---------------------------------------------------------------------------
// runNextStage — per-stage payload validation
// ---------------------------------------------------------------------------

const ADVANCE_KEYS_BY_STAGE: Record<LoopStage, readonly string[]> = {
  observation: ['executionId', 'stage', 'record', 'reference'],
  'evidence-memory': ['executionId', 'stage'],
  'world-update': ['executionId', 'stage', 'update'],
  'epistemic-evaluation': ['executionId', 'stage', 'claims'],
  'goal-evaluation': ['executionId', 'stage', 'relatedGoalIds'],
  'unknown-mission-evaluation': ['executionId', 'stage', 'unknowns', 'missions'],
  'knowledge-acquisition': ['executionId', 'stage', 'missionId'],
  'model-update': ['executionId', 'stage', 'belief'],
  'risk-opportunity-capability-analysis': ['executionId', 'stage', 'findings'],
  'recommendation-ask-proposal-action': ['executionId', 'stage', 'action'],
  outcome: ['executionId', 'stage', 'summary'],
  learning: ['executionId', 'stage', 'knowledge'],
};

function validateObservationIntake(value: unknown, index: number, fail: (m: string) => never): ObservationIntakeInput {
  const field = `record[${index}]`;
  if (!isPlainObject(value)) fail(`${field} must be an observation object`);
  hasOnlyKeys(
    value,
    ['kind', 'payload', 'observedAt', 'source', 'channel', 'lineage', 'permissions', 'confidence'],
    fail,
    field,
  );
  const kind = boundedString(value.kind, `${field}.kind`, MAX_KIND_LENGTH, fail);
  const payload = jsonPayload(value.payload, `${field}.payload`, fail);
  const observedAt = isoTimestamp(value.observedAt, `${field}.observedAt`, fail);
  if (!isPlainObject(value.source)) fail(`${field}.source must be an object {kind, id?, label?}`);
  hasOnlyKeys(value.source, ['kind', 'id', 'label'], fail, `${field}.source`);
  const sourceKind = boundedString(value.source.kind, `${field}.source.kind`, MAX_KIND_LENGTH, fail);
  let sourceId: string | null = null;
  if (value.source.id !== undefined && value.source.id !== null) {
    if (!isUuid(value.source.id)) fail(`${field}.source.id must be a uuid`);
    sourceId = value.source.id as string;
  }
  const sourceLabel = optionalBoundedString(value.source.label, `${field}.source.label`, MAX_LABEL_LENGTH, fail);
  if (sourceId === null && sourceLabel === null) {
    fail(`${field}.source must carry an id or a label — provenance must be traceable`);
  }
  const channel = boundedString(value.channel, `${field}.channel`, MAX_CHANNEL_LENGTH, fail);
  let lineage: ObservationIntakeInput['lineage'];
  if (value.lineage === undefined || value.lineage === null) {
    lineage = undefined;
  } else {
    if (!isPlainObject(value.lineage)) fail(`${field}.lineage must be an object {method, parents?, extractor?}`);
    const method = boundedString(value.lineage.method, `${field}.lineage.method`, MAX_KIND_LENGTH, fail);
    const parents = uuidList(value.lineage.parents, `${field}.lineage.parents`, MAX_EVIDENCE_REFS, fail);
    let extractor: { provider: string; model: string; notes: string | null } | null = null;
    if (value.lineage.extractor !== undefined && value.lineage.extractor !== null) {
      if (!isPlainObject(value.lineage.extractor)) fail(`${field}.lineage.extractor must be an object {provider, model, notes?}`);
      const provider = boundedString(value.lineage.extractor.provider, `${field}.lineage.extractor.provider`, MAX_KIND_LENGTH, fail);
      const model = boundedString(value.lineage.extractor.model, `${field}.lineage.extractor.model`, MAX_KIND_LENGTH, fail);
      const notes = optionalBoundedString(value.lineage.extractor.notes, `${field}.lineage.extractor.notes`, MAX_NOTE_LENGTH, fail);
      extractor = { provider, model, notes };
    }
    lineage = { method, parents, extractor };
  }
  let permissions: ObservationIntakeInput['permissions'];
  if (value.permissions === undefined || value.permissions === null) {
    permissions = undefined;
  } else {
    if (!isPlainObject(value.permissions)) {
      fail(`${field}.permissions must be an object {visibility?, workspaceId?, principalId?, usage?}`);
    }
    hasOnlyKeys(value.permissions, ['visibility', 'workspaceId', 'principalId', 'usage'], fail, `${field}.permissions`);
    let visibility: string | undefined;
    if (value.permissions.visibility !== undefined && value.permissions.visibility !== null) {
      if (
        typeof value.permissions.visibility !== 'string' ||
        !['tenant', 'workspace', 'principal'].includes(value.permissions.visibility)
      ) {
        fail(`${field}.permissions.visibility must be one of tenant, workspace, principal`);
      }
      visibility = value.permissions.visibility;
    }
    let workspaceId: string | null | undefined;
    if (value.permissions.workspaceId !== undefined && value.permissions.workspaceId !== null) {
      if (!isUuid(value.permissions.workspaceId)) fail(`${field}.permissions.workspaceId must be a uuid`);
      workspaceId = value.permissions.workspaceId as string;
    }
    let principalId: string | null | undefined;
    if (value.permissions.principalId !== undefined && value.permissions.principalId !== null) {
      const pid = boundedString(value.permissions.principalId, `${field}.permissions.principalId`, 128, fail);
      principalId = pid;
    }
    const usage =
      value.permissions.usage === undefined || value.permissions.usage === null
        ? []
        : Array.isArray(value.permissions.usage)
          ? (value.permissions.usage as string[])
          : fail(`${field}.permissions.usage must be an array of tags`);
    permissions = { visibility, workspaceId, principalId, usage };
  }
  const confidence = confidenceObject(value.confidence, `${field}.confidence`, fail);
  return {
    kind,
    payload,
    observedAt,
    source: { kind: sourceKind, id: sourceId, label: sourceLabel },
    channel,
    lineage,
    permissions,
    confidence,
  };
}

function validateClaimDerivation(value: unknown, index: number, fail: (m: string) => never): ClaimDerivationInput {
  const field = `claims[${index}]`;
  if (!isPlainObject(value)) fail(`${field} must be a claim object`);
  hasOnlyKeys(value, ['proposition', 'subject', 'confidence', 'evidenceObservationIds', 'rationale'], fail, field);
  const proposition = boundedString(value.proposition, `${field}.proposition`, MAX_PROPOSITION_LENGTH, fail);
  const subject = subjectRef(value.subject, `${field}.subject`, fail);
  const confidence = confidenceObject(value.confidence, `${field}.confidence`, fail);
  const evidenceObservationIds = uuidList(
    value.evidenceObservationIds,
    `${field}.evidenceObservationIds`,
    MAX_EVIDENCE_REFS,
    fail,
  );
  if (evidenceObservationIds.length < 1) {
    fail(`${field}.evidenceObservationIds must cite at least one observation — claims are derived FROM evidence`);
  }
  const rationale = optionalBoundedString(value.rationale, `${field}.rationale`, MAX_RATIONALE_LENGTH, fail);
  return { proposition, subject, confidence, evidenceObservationIds, rationale };
}

function validateUnknownDerivation(value: unknown, index: number, fail: (m: string) => never): UnknownDerivationInput {
  const field = `unknowns[${index}]`;
  if (!isPlainObject(value)) fail(`${field} must be an unknown object`);
  hasOnlyKeys(
    value,
    ['question', 'consequence', 'subject', 'relatedObservationIds', 'relatedClaimIds', 'relatedBeliefIds', 'note'],
    fail,
    field,
  );
  const question = boundedString(value.question, `${field}.question`, MAX_PROPOSITION_LENGTH, fail);
  const consequence = boundedString(value.consequence, `${field}.consequence`, MAX_SUMMARY_LENGTH, fail);
  const subject = subjectRef(value.subject, `${field}.subject`, fail);
  const relatedObservationIds = uuidList(value.relatedObservationIds, `${field}.relatedObservationIds`, MAX_EVIDENCE_REFS, fail);
  const relatedClaimIds = uuidList(value.relatedClaimIds, `${field}.relatedClaimIds`, MAX_EVIDENCE_REFS, fail);
  const relatedBeliefIds = uuidList(value.relatedBeliefIds, `${field}.relatedBeliefIds`, MAX_EVIDENCE_REFS, fail);
  const note = optionalBoundedString(value.note, `${field}.note`, MAX_NOTE_LENGTH, fail);
  return { question, consequence, subject, relatedObservationIds, relatedClaimIds, relatedBeliefIds, note };
}

function validateMissionLaunch(value: unknown, index: number, fail: (m: string) => never): MissionLaunchInput {
  const field = `missions[${index}]`;
  if (!isPlainObject(value)) fail(`${field} must be a mission object`);
  hasOnlyKeys(
    value,
    [
      'title',
      'knowledgeObjective',
      'affectedGoals',
      'unknownIds',
      'informationValue',
      'urgency',
      'currentConfidence',
      'targetConfidence',
      'investigationBudget',
      'rewardBudget',
      'rewardTerms',
      'candidateSources',
      'completionCriteria',
      'rationale',
    ],
    fail,
    field,
  );
  const title = boundedString(value.title, `${field}.title`, MAX_TITLE_LENGTH, fail);
  const knowledgeObjective = boundedString(value.knowledgeObjective, `${field}.knowledgeObjective`, MAX_SUMMARY_LENGTH * 2, fail);
  let affectedGoals: { goalId: string; label: string | null }[] = [];
  if (value.affectedGoals !== undefined && value.affectedGoals !== null) {
    if (!Array.isArray(value.affectedGoals)) fail(`${field}.affectedGoals must be an array`);
    if ((value.affectedGoals as unknown[]).length > MAX_RELATED_GOALS) {
      fail(`${field}.affectedGoals may carry at most ${MAX_RELATED_GOALS} entries`);
    }
    affectedGoals = (value.affectedGoals as unknown[]).map((goal, i) => {
      if (!isPlainObject(goal)) fail(`${field}.affectedGoals[${i}] must be an object {goalId, label?}`);
      hasOnlyKeys(goal, ['goalId', 'label'], fail, `${field}.affectedGoals[${i}]`);
      if (!isUuid(goal.goalId)) fail(`${field}.affectedGoals[${i}].goalId must be a uuid`);
      const label = optionalBoundedString(goal.label, `${field}.affectedGoals[${i}].label`, MAX_LABEL_LENGTH, fail);
      return { goalId: goal.goalId as string, label };
    });
  }
  const unknownIds = uuidList(value.unknownIds, `${field}.unknownIds`, MAX_EVIDENCE_REFS, fail);
  if (typeof value.informationValue !== 'number' || !Number.isFinite(value.informationValue) || value.informationValue < 0 || value.informationValue > 1) {
    fail(`${field}.informationValue must be a number in [0, 1]`);
  }
  if (typeof value.urgency !== 'string' || !(MISSION_URGENCIES as readonly string[]).includes(value.urgency)) {
    fail(`${field}.urgency must be one of ${MISSION_URGENCIES.join(', ')}`);
  }
  let currentConfidence = 0;
  if (value.currentConfidence !== undefined && value.currentConfidence !== null) {
    if (typeof value.currentConfidence !== 'number' || !Number.isFinite(value.currentConfidence) || value.currentConfidence < 0 || value.currentConfidence > 1) {
      fail(`${field}.currentConfidence must be a number in [0, 1]`);
    }
    currentConfidence = value.currentConfidence;
  }
  if (typeof value.targetConfidence !== 'number' || !Number.isFinite(value.targetConfidence) || value.targetConfidence <= 0 || value.targetConfidence > 1) {
    fail(`${field}.targetConfidence must be a number in (0, 1]`);
  }
  if (value.targetConfidence <= currentConfidence) {
    fail(`${field}.targetConfidence must exceed currentConfidence — a mission closes a confidence gap`);
  }
  for (const budgetField of ['investigationBudget', 'rewardBudget'] as const) {
    const budget = value[budgetField];
    if (!isPlainObject(budget)) fail(`${field}.${budgetField} must be an object {amount, currency}`);
    hasOnlyKeys(budget, ['amount', 'currency'], fail, `${field}.${budgetField}`);
    if (typeof budget.amount !== 'number' || !Number.isInteger(budget.amount) || budget.amount < 0) {
      fail(`${field}.${budgetField}.amount must be a non-negative integer (minor units)`);
    }
    if (typeof budget.currency !== 'string' || !/^[A-Z]{3}$/.test(budget.currency)) {
      fail(`${field}.${budgetField}.currency must be an ISO 4217-shaped code`);
    }
  }
  const rewardTerms = optionalBoundedString(value.rewardTerms, `${field}.rewardTerms`, MAX_RATIONALE_LENGTH, fail);
  let candidateSources: MissionLaunchInput['candidateSources'] = [];
  if (value.candidateSources !== undefined && value.candidateSources !== null) {
    if (!Array.isArray(value.candidateSources)) fail(`${field}.candidateSources must be an array`);
    if ((value.candidateSources as unknown[]).length > MAX_FOCUS_ENTITIES) {
      fail(`${field}.candidateSources may carry at most ${MAX_FOCUS_ENTITIES} entries`);
    }
    candidateSources = (value.candidateSources as unknown[]).map((candidate, i) =>
      partyRef(candidate, `${field}.candidateSources[${i}]`, MISSION_CANDIDATE_KINDS, fail, true),
    ) as MissionLaunchInput['candidateSources'];
  }
  const completionCriteria = boundedString(value.completionCriteria, `${field}.completionCriteria`, MAX_SUMMARY_LENGTH * 2, fail);
  const rationale = optionalBoundedString(value.rationale, `${field}.rationale`, MAX_RATIONALE_LENGTH, fail);
  return {
    title,
    knowledgeObjective,
    affectedGoals,
    unknownIds,
    informationValue: value.informationValue,
    urgency: value.urgency as MissionLaunchInput['urgency'],
    currentConfidence,
    targetConfidence: value.targetConfidence,
    investigationBudget: {
      amount: (value.investigationBudget as { amount: number }).amount,
      currency: (value.investigationBudget as { currency: string }).currency,
    },
    rewardBudget: {
      amount: (value.rewardBudget as { amount: number }).amount,
      currency: (value.rewardBudget as { currency: string }).currency,
    },
    rewardTerms,
    candidateSources: candidateSources as MissionLaunchInput['candidateSources'],
    completionCriteria,
    rationale,
  };
}

function validateWorldUpdate(value: unknown, fail: (m: string) => never): WorldModelUpdateInput {
  if (!isPlainObject(value)) fail('update must be an object');
  if (value.kind === 'create-entity') {
    hasOnlyKeys(value, ['kind', 'entity'], fail, 'update');
    if (!isPlainObject(value.entity)) fail('update.entity must be an object');
    hasOnlyKeys(value.entity, ['kind', 'name', 'description', 'attributes', 'externalRef'], fail, 'update.entity');
    const kind = boundedString(value.entity.kind, 'update.entity.kind', MAX_KIND_LENGTH, fail);
    const name = boundedString(value.entity.name, 'update.entity.name', MAX_TITLE_LENGTH, fail);
    const description = optionalBoundedString(value.entity.description, 'update.entity.description', MAX_SUMMARY_LENGTH * 2, fail);
    const attributes =
      value.entity.attributes === undefined ? {} : jsonPayload(value.entity.attributes, 'update.entity.attributes', fail);
    let externalRef: { module: string; id: string } | null = null;
    if (value.entity.externalRef !== undefined && value.entity.externalRef !== null) {
      if (!isPlainObject(value.entity.externalRef)) fail('update.entity.externalRef must be an object {module, id}');
      hasOnlyKeys(value.entity.externalRef, ['module', 'id'], fail, 'update.entity.externalRef');
      const moduleSlug = boundedString(value.entity.externalRef.module, 'update.entity.externalRef.module', MAX_TOPIC_LENGTH, fail);
      if (!isUuid(value.entity.externalRef.id)) fail('update.entity.externalRef.id must be a uuid');
      externalRef = { module: moduleSlug, id: value.entity.externalRef.id as string };
    }
    return { kind: 'create-entity', entity: { kind, name, description, attributes, externalRef } };
  }
  if (value.kind === 'update-entity') {
    hasOnlyKeys(value, ['kind', 'entityId', 'name', 'description', 'attributes'], fail, 'update');
    if (!isUuid(value.entityId)) fail('update.entityId must be a uuid');
    const name = value.name === undefined ? undefined : boundedString(value.name, 'update.name', MAX_TITLE_LENGTH, fail);
    const description =
      value.description === undefined
        ? undefined
        : optionalBoundedString(value.description, 'update.description', MAX_SUMMARY_LENGTH * 2, fail);
    const attributes =
      value.attributes === undefined ? undefined : jsonPayload(value.attributes, 'update.attributes', fail);
    return { kind: 'update-entity', entityId: value.entityId, name, description, attributes };
  }
  if (value.kind === 'create-relationship') {
    hasOnlyKeys(value, ['kind', 'relationship'], fail, 'update');
    if (!isPlainObject(value.relationship)) fail('update.relationship must be an object');
    hasOnlyKeys(value.relationship, ['type', 'fromEntityId', 'toEntityId', 'attributes'], fail, 'update.relationship');
    const type = boundedString(value.relationship.type, 'update.relationship.type', MAX_KIND_LENGTH, fail);
    if (!isUuid(value.relationship.fromEntityId)) fail('update.relationship.fromEntityId must be a uuid');
    if (!isUuid(value.relationship.toEntityId)) fail('update.relationship.toEntityId must be a uuid');
    const attributes =
      value.relationship.attributes === undefined
        ? {}
        : jsonPayload(value.relationship.attributes, 'update.relationship.attributes', fail);
    return {
      kind: 'create-relationship',
      relationship: {
        type,
        fromEntityId: value.relationship.fromEntityId as string,
        toEntityId: value.relationship.toEntityId as string,
        attributes,
      },
    };
  }
  fail("update.kind must be 'create-entity', 'update-entity' or 'create-relationship'");
}

function validateBeliefUpdate(value: unknown, fail: (m: string) => never): BeliefUpdateInput {
  if (!isPlainObject(value)) fail('belief must be an object');
  hasOnlyKeys(
    value,
    [
      'beliefId',
      'proposition',
      'confidence',
      'supportingObservationIds',
      'supportingClaimIds',
      'alternatives',
      'disconfirmation',
      'subject',
      'validFrom',
      'rationale',
    ],
    fail,
    'belief',
  );
  let beliefId: string | null = null;
  if (value.beliefId !== undefined && value.beliefId !== null) {
    if (!isUuid(value.beliefId)) fail('belief.beliefId must be a uuid');
    beliefId = value.beliefId as string;
  }
  const proposition = boundedString(value.proposition, 'belief.proposition', MAX_PROPOSITION_LENGTH, fail);
  const confidence = confidenceObject(value.confidence, 'belief.confidence', fail);
  const supportingObservationIds = uuidList(
    value.supportingObservationIds,
    'belief.supportingObservationIds',
    MAX_EVIDENCE_REFS,
    fail,
  );
  if (supportingObservationIds.length < 1) {
    fail('belief.supportingObservationIds must cite at least one observation — every belief version carries provenance');
  }
  const supportingClaimIds = uuidList(value.supportingClaimIds, 'belief.supportingClaimIds', MAX_EVIDENCE_REFS, fail);
  let alternatives: string[] = [];
  if (value.alternatives !== undefined && value.alternatives !== null) {
    if (!Array.isArray(value.alternatives)) fail('belief.alternatives must be an array of strings');
    if ((value.alternatives as unknown[]).length > MAX_ALTERNATIVES) {
      fail(`belief.alternatives may carry at most ${MAX_ALTERNATIVES} entries`);
    }
    alternatives = (value.alternatives as unknown[]).map((alt, i) =>
      boundedString(alt, `belief.alternatives[${i}]`, MAX_SUMMARY_LENGTH, fail),
    );
  }
  const disconfirmation = optionalBoundedString(value.disconfirmation, 'belief.disconfirmation', MAX_SUMMARY_LENGTH, fail);
  const subject = subjectRef(value.subject, 'belief.subject', fail);
  const validFrom = isoTimestamp(value.validFrom, 'belief.validFrom', fail);
  const rationale = optionalBoundedString(value.rationale, 'belief.rationale', MAX_RATIONALE_LENGTH, fail);
  return {
    beliefId,
    proposition,
    confidence,
    supportingObservationIds,
    supportingClaimIds,
    alternatives,
    disconfirmation,
    subject,
    validFrom,
    rationale,
  };
}

function validateFinding(value: unknown, index: number, fail: (m: string) => never): AnalysisFindingInput {
  const field = `findings[${index}]`;
  if (!isPlainObject(value)) fail(`${field} must be a finding object`);
  hasOnlyKeys(value, ['kind', 'statement', 'evidenceObservationIds', 'affectedGoalIds'], fail, field);
  if (
    typeof value.kind !== 'string' ||
    !(ANALYSIS_FINDING_KINDS as readonly string[]).includes(value.kind)
  ) {
    fail(`${field}.kind must be one of ${ANALYSIS_FINDING_KINDS.join(', ')}`);
  }
  const statement = boundedString(value.statement, `${field}.statement`, MAX_STATEMENT_LENGTH, fail);
  const evidenceObservationIds = uuidList(
    value.evidenceObservationIds,
    `${field}.evidenceObservationIds`,
    MAX_EVIDENCE_REFS,
    fail,
  );
  const affectedGoalIds = uuidList(value.affectedGoalIds, `${field}.affectedGoalIds`, MAX_RELATED_GOALS, fail);
  return { kind: value.kind as AnalysisFindingInput['kind'], statement, evidenceObservationIds, affectedGoalIds };
}

function validateActionProposal(value: unknown, fail: (m: string) => never): ActionProposalInput {
  if (!isPlainObject(value)) fail('action must be an object');
  hasOnlyKeys(value, ['actionKind', 'authorityLevel', 'payload', 'justification'], fail, 'action');
  const actionKind = boundedString(value.actionKind, 'action.actionKind', MAX_KIND_LENGTH, fail);
  if (!ACTION_KIND_PATTERN.test(actionKind)) {
    fail(`action.actionKind must be a canonical slug matching ${ACTION_KIND_PATTERN.source} (got '${actionKind}')`);
  }
  if (
    typeof value.authorityLevel !== 'string' ||
    !(AUTHORITY_LEVELS as readonly string[]).includes(value.authorityLevel)
  ) {
    fail(`action.authorityLevel must be one of ${AUTHORITY_LEVELS.join(', ')}`);
  }
  const payload = jsonPayload(value.payload, 'action.payload', fail);
  const justification = optionalBoundedString(value.justification, 'action.justification', MAX_JUSTIFICATION_LENGTH, fail);
  return { actionKind, authorityLevel: value.authorityLevel as ActionProposalInput['authorityLevel'], payload, justification };
}

function validateLearningCapture(value: unknown, fail: (m: string) => never): LearningCaptureInput {
  if (!isPlainObject(value)) fail('knowledge must be an object');
  hasOnlyKeys(value, ['title', 'summary', 'topics'], fail, 'knowledge');
  const title = boundedString(value.title, 'knowledge.title', MAX_TITLE_LENGTH, fail);
  const summary = boundedString(value.summary, 'knowledge.summary', MAX_SUMMARY_LENGTH, fail);
  const captureTopics = topics(value.topics, 'knowledge.topics', fail);
  return { title, summary, topics: captureTopics };
}

/**
 * Validate and normalize one `runNextStage` input. `expectedStage` is the
 * execution's next (or suspended) canonical stage — the input's `stage`
 * discriminator must match it exactly (the loop's order is not
 * negotiable), which is what makes stage skipping/reordering
 * unrepresentable at the contract boundary.
 */
export function validateAdvanceInput(
  input: unknown,
  expectedStage: LoopStage,
): { executionId: string; payload: ValidatedAdvance } {

  if (!isPlainObject(input)) stageFail('advance input must be an object');
  if (!isLoopStage(input.stage)) {
    stageFail(`stage must be one of the canonical loop stages (${LOOP_STAGES.join(', ')})`);
  }
  const stage = input.stage as LoopStage;
  if (stage !== expectedStage) {
    throw new CognitionError(
      'stage_mismatch',
      `this execution's next canonical stage is '${expectedStage}' — the loop cannot advance to '${stage}' (canonical order, ARCHITECTURE.md §19)`,
    );
  }
  if (!isUuid(input.executionId)) stageFail('executionId must be a uuid');
  const executionId = input.executionId as string;
  hasOnlyKeys(input, ADVANCE_KEYS_BY_STAGE[stage], stageFail, 'advance input');

  switch (stage) {
    case 'observation': {
      let record: ObservationIntakeInput[] = [];
      if (input.record !== undefined && input.record !== null) {
        if (!Array.isArray(input.record)) stageFail('record must be an array of observations');
        if ((input.record as unknown[]).length > MAX_RECORDED_OBSERVATIONS) {
          stageFail(
            `record may carry at most ${MAX_RECORDED_OBSERVATIONS} observations (got ${(input.record as unknown[]).length})`,
          );
        }
        record = (input.record as unknown[]).map((item, index) => validateObservationIntake(item, index, stageFail));
      }
      const reference = uuidList(input.reference, 'reference', MAX_REFERENCED_OBSERVATIONS, stageFail);
      return { executionId, payload: { stage, record, reference } };
    }
    case 'evidence-memory':
      return { executionId, payload: { stage } };
    case 'world-update': {
      const update =
        input.update === undefined || input.update === null ? null : validateWorldUpdate(input.update, stageFail);
      return { executionId, payload: { stage, update } };
    }
    case 'epistemic-evaluation': {
      let claims: ClaimDerivationInput[] = [];
      if (input.claims !== undefined && input.claims !== null) {
        if (!Array.isArray(input.claims)) stageFail('claims must be an array');
        if ((input.claims as unknown[]).length > MAX_CLAIMS_PER_STAGE) {
          stageFail(`claims may carry at most ${MAX_CLAIMS_PER_STAGE} derivations`);
        }
        claims = (input.claims as unknown[]).map((item, index) => validateClaimDerivation(item, index, stageFail));
      }
      return { executionId, payload: { stage, claims } };
    }
    case 'goal-evaluation': {
      const relatedGoalIds = uuidList(input.relatedGoalIds, 'relatedGoalIds', MAX_RELATED_GOALS, stageFail);
      return { executionId, payload: { stage, relatedGoalIds } };
    }
    case 'unknown-mission-evaluation': {
      let unknowns: UnknownDerivationInput[] = [];
      if (input.unknowns !== undefined && input.unknowns !== null) {
        if (!Array.isArray(input.unknowns)) stageFail('unknowns must be an array');
        if ((input.unknowns as unknown[]).length > MAX_UNKNOWNS_PER_STAGE) {
          stageFail(`unknowns may carry at most ${MAX_UNKNOWNS_PER_STAGE} derivations`);
        }
        unknowns = (input.unknowns as unknown[]).map((item, index) => validateUnknownDerivation(item, index, stageFail));
      }
      let missions: MissionLaunchInput[] = [];
      if (input.missions !== undefined && input.missions !== null) {
        if (!Array.isArray(input.missions)) stageFail('missions must be an array');
        if ((input.missions as unknown[]).length > MAX_MISSIONS_PER_STAGE) {
          stageFail(`missions may carry at most ${MAX_MISSIONS_PER_STAGE} launches per cycle`);
        }
        missions = (input.missions as unknown[]).map((item, index) => validateMissionLaunch(item, index, stageFail));
      }
      return { executionId, payload: { stage, unknowns, missions } };
    }
    case 'knowledge-acquisition': {
      let missionId: string | null = null;
      if (input.missionId !== undefined && input.missionId !== null) {
        if (!isUuid(input.missionId)) stageFail('missionId must be a uuid');
        missionId = input.missionId as string;
      }
      return { executionId, payload: { stage, missionId } };
    }
    case 'model-update': {
      const belief = input.belief === undefined || input.belief === null ? null : validateBeliefUpdate(input.belief, stageFail);
      return { executionId, payload: { stage, belief } };
    }
    case 'risk-opportunity-capability-analysis': {
      let findings: AnalysisFindingInput[] = [];
      if (input.findings !== undefined && input.findings !== null) {
        if (!Array.isArray(input.findings)) stageFail('findings must be an array');
        if ((input.findings as unknown[]).length > MAX_FINDINGS_PER_STAGE) {
          stageFail(`findings may carry at most ${MAX_FINDINGS_PER_STAGE} entries`);
        }
        findings = (input.findings as unknown[]).map((item, index) => validateFinding(item, index, stageFail));
      }
      return { executionId, payload: { stage, findings } };
    }
    case 'recommendation-ask-proposal-action': {
      const action =
        input.action === undefined || input.action === null ? null : validateActionProposal(input.action, stageFail);
      return { executionId, payload: { stage, action } };
    }
    case 'outcome': {
      const summary = boundedString(input.summary, 'summary', MAX_SUMMARY_LENGTH, stageFail);
      return { executionId, payload: { stage, summary } };
    }
    case 'learning': {
      const knowledge =
        input.knowledge === undefined || input.knowledge === null ? null : validateLearningCapture(input.knowledge, stageFail);
      return { executionId, payload: { stage, knowledge } };
    }
  }
}

// ---------------------------------------------------------------------------
// abandon / reads
// ---------------------------------------------------------------------------

export function validateAbandonInput(input: unknown): ValidatedAbandonInput {

  if (!isPlainObject(input)) stageFail('abandon input must be an object');
  hasOnlyKeys(input, ['executionId', 'reason'], stageFail, 'abandon input');
  if (!isUuid(input.executionId)) stageFail('executionId must be a uuid');
  const reason = boundedString(input.reason, 'reason', MAX_REASON_LENGTH, stageFail);
  return { executionId: input.executionId as string, reason };
}

export function validateStepQuery(input: unknown): ValidatedStepQuery {

  if (!isPlainObject(input)) queryFail('step query must be an object');
  hasOnlyKeys(input, ['executionId', 'stage'], queryFail, 'step query');
  if (!isUuid(input.executionId)) queryFail('executionId must be a uuid');
  if (!isLoopStage(input.stage)) {
    queryFail(`stage must be one of the canonical loop stages (${LOOP_STAGES.join(', ')})`);
  }
  return { executionId: input.executionId as string, stage: input.stage as LoopStage };
}

const LIST_QUERY_KEYS = ['state', 'triggerKind', 'correlationId', 'limit'] as const;

export function validateListExecutionsQuery(input: unknown): ValidatedListQuery {

  if (!isPlainObject(input)) queryFail('list query must be an object');
  hasOnlyKeys(input, LIST_QUERY_KEYS, queryFail, 'list query');
  let state: ExecutionState | null = null;
  if (input.state !== undefined && input.state !== null) {
    if (!isExecutionState(input.state)) queryFail(`state must be one of ${EXECUTION_STATES.join(', ')}`);
    state = input.state as ExecutionState;
  }
  let triggerKind: ExecutionTriggerKind | null = null;
  if (input.triggerKind !== undefined && input.triggerKind !== null) {
    if (!isExecutionTriggerKind(input.triggerKind)) {
      queryFail(`triggerKind must be one of ${EXECUTION_TRIGGER_KINDS.join(', ')}`);
    }
    triggerKind = input.triggerKind as ExecutionTriggerKind;
  }
  let correlationId: string | null = null;
  if (input.correlationId !== undefined && input.correlationId !== null) {
    if (!isUuid(input.correlationId)) queryFail('correlationId must be a uuid');
    correlationId = input.correlationId as string;
  }
  let limit = DEFAULT_LIST_LIMIT;
  if (input.limit !== undefined && input.limit !== null) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIST_LIMIT) {
      queryFail(`limit must be an integer in 1..${MAX_LIST_LIMIT}`);
    }
    limit = input.limit;
  }
  return { state, triggerKind, correlationId, limit };
}

export type {
  AbandonExecutionInput,
  AdvanceExecutionInput,
  ListExecutionsQuery,
  StartExecutionInput,
};
