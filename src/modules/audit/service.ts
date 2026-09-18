// Implementation of the audit module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); semantic timestamps (`recorded_at`) come from
// the injectable clock and are never caller-supplied; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access
// is indistinguishable from a missing record (`audit_record_not_found`,
// `execution_not_found`, `action_request_not_found` — no existence leak).
//
// W046 acceptance — "end-to-end reconstruction of
// input→evidence→belief/mission→policy→recommendation→approval→
// execution→outcome→learning" — is carried by these deliberate
// properties, all tested:
//   1. the audit trail is APPEND-ONLY from the domain perspective: no
//      update/delete operation exists on the contract and PostgreSQL
//      triggers reject UPDATE/DELETE/TRUNCATE outright (migrations/001);
//   2. `reconstructDecision` assembles the full §24 chain for one
//      consequential decision from the REAL records of the owning
//      modules — read ONLY through their public contracts (cognition
//      W013, actions W009, epistemics W007, memory W010, missions W011,
//      observations W004) plus this module's own trail — so the document
//      is evidence, not prose (lock 41);
//   3. every §24 link reports its presence: a mid-flight decision (an
//      execution suspended awaiting approval) reconstructs honestly with
//      its later links absent, never silently missing;
//   4. links the calling principal may not read are reported as
//      unreadable in place — a reconstruction never fails because one
//      link is restricted (partial view, the observations module's
//      lineage precedent); it fails only when the anchor itself is
//      absent, uniformly `execution_not_found` / `action_request_not_found`.
//
// Cross-module error mapping (documented for consumers): anchor
// resolution maps `execution_not_found` (cognition) and
// `action_request_not_found` (actions) onto this module's identical
// codes; any other sibling error cannot occur through this contract
// (queries are validated first) and is never swallowed. Deep-link reads
// map their owning module's not-found/restriction errors to unreadable
// markers or skips — see the per-link builders below.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  CognitionError,
  getExecution,
  listExecutions,
  MAX_LIST_LIMIT as COGNITION_MAX_LIST_LIMIT,
  type CognitiveExecution,
  type CognitiveExecutionStep,
  type CognitiveExecutionTrace,
  type LoopStage,
  type StageResult,
} from '@/modules/cognition/contract';
import {
  ActionsError,
  getActionRequest,
  listApprovalDecisions,
  type ActionRequest,
} from '@/modules/actions/contract';
import { getObservation, ObservationsError } from '@/modules/observations/contract';
import { EpistemicsError, getBelief, getClaim, getUnknown } from '@/modules/epistemics/contract';
import { getKnowledgeEntry, getTransactiveEntry, MemoryError } from '@/modules/memory/contract';
import { getMission, MissionsError } from '@/modules/missions/contract';
import { AuditError } from './errors';
import {
  assertAuditTenantContext,
  AUDIT_SUBJECT_ACTION_REQUEST,
  AUDIT_SUBJECT_COGNITIVE_EXECUTION,
  chainCompleteness,
  deriveExtractors,
  executionIdFromIdempotencyKey,
  MAX_LIST_LIMIT,
  validateGetAuditRecordQuery,
  validateListAuditRecordsQuery,
  validateRecordAuditInput,
  validateReconstructDecisionQuery,
  type ValidatedListAuditRecordsQuery,
  type ValidatedRecordAuditInput,
} from './validation';
import type {
  AuditRecord,
  ChainEvidence,
  DecisionAnchor,
  DecisionChain,
  DecisionEvidence,
  DecisionExecution,
  EvidenceObservation,
  ListAuditRecordsQuery,
  RecordAuditInput,
  ReconstructDecisionQuery,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface AuditRecordRow extends DbRow {
  id: string;
  tenant_id: string;
  subject_kind: string;
  subject_id: string | null;
  event: string;
  chain_stage: string;
  correlation_id: string | null;
  summary: string;
  detail: Record<string, unknown>;
  principal_id: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapAuditRecord(row: AuditRecordRow): AuditRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: { kind: row.subject_kind, id: row.subject_id },
    event: row.event,
    chainStage: row.chain_stage as AuditRecord['chainStage'],
    correlationId: row.correlation_id,
    summary: row.summary,
    detail: row.detail ?? {},
    principalId: row.principal_id,
    recordedAt: toIso(row.recorded_at),
  };
}

/** The typed stage-result of one canonical step, or null when not yet run. */
type StepResultOf<S extends LoopStage> = Extract<StageResult, { stage: S }>;

function resultOf<S extends LoopStage>(
  trace: CognitiveExecutionTrace,
  stage: S,
): StepResultOf<S> | null {
  const step: CognitiveExecutionStep | undefined = trace.steps.find((entry) => entry.stage === stage);
  return step === undefined ? null : (step.result as StepResultOf<S>);
}

function toDecisionExecution(trace: CognitiveExecutionTrace): DecisionExecution {
  return {
    id: trace.id,
    trigger: { kind: trace.trigger.kind, id: trace.trigger.id, label: trace.trigger.label },
    focus: trace.focus,
    actor: trace.actor,
    correlationId: trace.correlationId,
    causation: trace.causation,
    state: trace.state,
    completedStages: trace.completedStages,
    outcome:
      trace.outcome === null
        ? null
        : {
            kind: trace.outcome.kind,
            summary: trace.outcome.summary,
            actionRequestId: trace.outcome.actionRequestId,
            recordedAt: trace.outcome.recordedAt,
          },
    abandonment: trace.abandonment,
    rationale: trace.rationale,
    startedByPrincipal: trace.startedByPrincipal,
    createdAt: trace.createdAt,
    completedAt: trace.completedAt,
  };
}

// ---------------------------------------------------------------------------
// recordAudit
// ---------------------------------------------------------------------------

export async function recordAudit(
  ctx: TenantContext,
  input: RecordAuditInput,
): Promise<AuditRecord> {
  assertAuditTenantContext(ctx);
  const valid: ValidatedRecordAuditInput = validateRecordAuditInput(input);
  const result = await getDb().query<AuditRecordRow>(
    `INSERT INTO audit_records
       (tenant_id, subject_kind, subject_id, event, chain_stage,
        correlation_id, summary, detail, principal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.subjectKind,
      valid.subjectId,
      valid.event,
      valid.chainStage,
      valid.correlationId,
      valid.summary,
      JSON.stringify(valid.detail),
      ctx.principalId,
    ],
  );
  return mapAuditRecord(result.rows[0]!);
}

// ---------------------------------------------------------------------------
// getAuditRecord / listAuditRecords
// ---------------------------------------------------------------------------

export async function getAuditRecord(
  ctx: TenantContext,
  query: { recordId: string },
): Promise<AuditRecord> {
  assertAuditTenantContext(ctx);
  const valid = validateGetAuditRecordQuery(query);
  const result = await getDb().query<AuditRecordRow>(
    `SELECT * FROM audit_records WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.recordId],
  );
  if (result.rows.length === 0) {
    throw new AuditError(
      'audit_record_not_found',
      `no audit record '${valid.recordId}' exists in this tenant`,
    );
  }
  return mapAuditRecord(result.rows[0]!);
}

export async function listAuditRecords(
  ctx: TenantContext,
  query: ListAuditRecordsQuery,
): Promise<AuditRecord[]> {
  assertAuditTenantContext(ctx);
  const valid: ValidatedListAuditRecordsQuery = validateListAuditRecordsQuery(query);

  const conditions = [`tenant_id = $1`];
  const params: unknown[] = [ctx.tenantId];
  if (valid.subjectKind !== null) {
    params.push(valid.subjectKind);
    conditions.push(`subject_kind = $${params.length}`);
    if (valid.subjectIdIsNull) {
      conditions.push(`subject_id IS NULL`);
    } else if (valid.subjectId !== null) {
      params.push(valid.subjectId);
      conditions.push(`subject_id = $${params.length}`);
    }
  }
  if (valid.correlationId !== null) {
    params.push(valid.correlationId);
    conditions.push(`correlation_id = $${params.length}`);
  }
  if (valid.chainStage !== null) {
    params.push(valid.chainStage);
    conditions.push(`chain_stage = $${params.length}`);
  }
  if (valid.event !== null) {
    params.push(valid.event);
    conditions.push(`event = $${params.length}`);
  }
  if (valid.recordedFrom !== null) {
    params.push(valid.recordedFrom.toISOString());
    conditions.push(`recorded_at >= $${params.length}`);
  }
  if (valid.recordedTo !== null) {
    params.push(valid.recordedTo.toISOString());
    conditions.push(`recorded_at <= $${params.length}`);
  }
  params.push(valid.limit);

  const rows = await getDb().query<AuditRecordRow>(
    `SELECT * FROM audit_records
       WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at ASC, id ASC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapAuditRecord);
}

// ---------------------------------------------------------------------------
// reconstructDecision — anchor resolution (cross-module error mapping)
// ---------------------------------------------------------------------------

/** Resolves one cognitive execution trace; maps the uniform not-found. */
async function loadExecution(ctx: TenantContext, executionId: string): Promise<CognitiveExecutionTrace> {
  try {
    return await getExecution(ctx, { executionId });
  } catch (error) {
    if (error instanceof CognitionError && error.code === 'execution_not_found') {
      throw new AuditError(
        'execution_not_found',
        `no decision '${executionId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

/** Resolves one action request; maps the uniform not-found. */
async function loadActionRequest(ctx: TenantContext, requestId: string): Promise<ActionRequest> {
  try {
    return await getActionRequest(ctx, { requestId });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'action_request_not_found') {
      throw new AuditError(
        'action_request_not_found',
        `no action request '${requestId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// reconstructDecision — deep-link readers (partial views, never leaks)
// ---------------------------------------------------------------------------

/** Reads one observation; an unreadable one is an in-place marker, never an error. */
async function readObservation(ctx: TenantContext, observationId: string): Promise<EvidenceObservation> {
  try {
    const observation = await getObservation(ctx, observationId);
    return {
      id: observation.id,
      unreadable: false,
      kind: observation.kind,
      observedAt: observation.observedAt,
      recordedAt: observation.recordedAt,
      channel: observation.channel,
      sourceLabel: observation.source.label ?? null,
      confidenceValue: observation.confidence.value,
      payload: observation.payload,
      extractor:
        observation.lineage.extractor === null
          ? null
          : {
              provider: observation.lineage.extractor.provider,
              model: observation.lineage.extractor.model,
            },
    };
  } catch (error) {
    if (error instanceof ObservationsError) {
      return { id: observationId, unreadable: true };
    }
    throw error;
  }
}

/** Reads many observations, first-seen order, deduplicated. */
async function readObservations(
  ctx: TenantContext,
  ids: readonly string[],
): Promise<EvidenceObservation[]> {
  const seen = new Set<string>();
  const out: EvidenceObservation[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(await readObservation(ctx, id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// reconstructDecision — the §24 chain assembly
// ---------------------------------------------------------------------------

/** The decision's audit history: records about its subjects or its flow. */
async function loadDecisionAuditRecords(
  ctx: TenantContext,
  correlationId: string | null,
  executionIds: readonly string[],
  requestIds: readonly string[],
): Promise<AuditRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [ctx.tenantId];
  if (correlationId !== null) {
    params.push(correlationId);
    conditions.push(`correlation_id = $${params.length}`);
  }
  if (executionIds.length > 0) {
    params.push(AUDIT_SUBJECT_COGNITIVE_EXECUTION);
    const kindIndex = params.length;
    params.push([...executionIds]);
    conditions.push(`(subject_kind = $${kindIndex} AND subject_id = ANY($${params.length}))`);
  }
  if (requestIds.length > 0) {
    params.push(AUDIT_SUBJECT_ACTION_REQUEST);
    const kindIndex = params.length;
    params.push([...requestIds]);
    conditions.push(`(subject_kind = $${kindIndex} AND subject_id = ANY($${params.length}))`);
  }
  if (conditions.length === 0) return [];
  params.push(MAX_LIST_LIMIT);
  const rows = await getDb().query<AuditRecordRow>(
    `SELECT * FROM audit_records
       WHERE tenant_id = $1 AND (${conditions.join(' OR ')})
       ORDER BY recorded_at ASC, id ASC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapAuditRecord);
}

export async function reconstructDecision(
  ctx: TenantContext,
  query: ReconstructDecisionQuery,
): Promise<DecisionEvidence> {
  assertAuditTenantContext(ctx);
  const { anchor }: { anchor: DecisionAnchor } = validateReconstructDecisionQuery(query);

  // ----- anchor resolution: the driving executions and/or request --------
  let traces: CognitiveExecutionTrace[] = [];
  let anchoredRequest: ActionRequest | null = null;

  if (anchor.kind === 'execution') {
    traces = [await loadExecution(ctx, anchor.id)];
  } else if (anchor.kind === 'action-request') {
    anchoredRequest = await loadActionRequest(ctx, anchor.id);
    // A cognition-gated request carries the documented stable key
    // `cognition:<executionId>:action`; resolve the driving execution
    // through it. A foreign-format key (or an unreadable execution)
    // reconstructs the direct-authorization view — no leak.
    const executionId = executionIdFromIdempotencyKey(anchoredRequest.idempotencyKey);
    if (executionId !== null) {
      try {
        traces = [await getExecution(ctx, { executionId })];
      } catch (error) {
        if (!(error instanceof CognitionError && error.code === 'execution_not_found')) throw error;
      }
    }
  } else {
    const listed: CognitiveExecution[] = await listExecutions(ctx, {
      correlationId: anchor.id,
      limit: COGNITION_MAX_LIST_LIMIT,
    });
    for (const execution of listed) {
      traces.push(await loadExecution(ctx, execution.id));
    }
    // listExecutions is newest-first; the reconstruction reads the flow
    // chronologically (the ROOT execution's trigger is the flow's input,
    // the LAST proposed action is its terminal decision).
    traces.sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
    );
    if (traces.length === 0) {
      // A correlation anchor with no executions reconstructs only when
      // the flow left audit history; otherwise there is nothing here.
      const history = await loadDecisionAuditRecords(ctx, anchor.id, [], []);
      if (history.length === 0) {
        throw new AuditError(
          'execution_not_found',
          `no decision flow '${anchor.id}' exists in this tenant`,
        );
      }
    }
  }

  const correlationId =
    anchor.kind === 'correlation'
      ? anchor.id
      : traces.length > 0
        ? traces[0]!.correlationId
        : null;

  // ----- collect the flow's action requests ------------------------------
  const requestIds: string[] = [];
  for (const trace of traces) {
    const gate = resultOf(trace, 'recommendation-ask-proposal-action');
    if (gate !== null && gate.actionRequest !== null && !requestIds.includes(gate.actionRequest.id)) {
      requestIds.push(gate.actionRequest.id);
    }
    // A suspension at the approval gate: the pending request is the
    // in-flight recommendation — the step has not committed yet, but the
    // proposal, its policy evaluation and its (empty) decision trail are
    // exactly what a mid-flight reconstruction must show.
    if (trace.pending.requestId !== null && !requestIds.includes(trace.pending.requestId)) {
      requestIds.push(trace.pending.requestId);
    }
  }
  if (anchoredRequest !== null && !requestIds.includes(anchoredRequest.id)) {
    requestIds.push(anchoredRequest.id);
  }
  const requests = new Map<string, ActionRequest>();
  for (const requestId of requestIds) {
    requests.set(requestId, await loadActionRequest(ctx, requestId));
  }
  // The terminal request: the anchored one, else the last proposed in flow
  // order (a multi-execution correlation flow's consequential decision).
  const terminalRequestId =
    anchoredRequest !== null ? anchoredRequest.id : (requestIds.at(-1) ?? null);
  const terminalRequest = terminalRequestId === null ? null : (requests.get(terminalRequestId) ?? null);

  // ----- §24 `input` — what started the decision -------------------------
  const firstTrigger = traces.length > 0 ? traces[0]!.trigger : null;
  const inputObservation: EvidenceObservation | null =
    firstTrigger !== null && firstTrigger.kind === 'observation' && firstTrigger.id !== null
      ? await readObservation(ctx, firstTrigger.id)
      : null;
  const input = {
    trigger:
      firstTrigger === null
        ? null
        : { kind: firstTrigger.kind, id: firstTrigger.id, label: firstTrigger.label },
    observation: inputObservation,
  };

  // ----- §24 `evidence` — what the decision rests on ---------------------
  const evidenceObservationIds: string[] = [];
  const addObservationId = (id: string): void => {
    if (!evidenceObservationIds.includes(id)) evidenceObservationIds.push(id);
  };
  if (inputObservation !== null) addObservationId(inputObservation.id);
  const evidence: ChainEvidence = { observations: [], knowledge: [], transactive: [] };
  const knowledgeIds: string[] = [];
  const claimIds: string[] = [];
  const unknownIds: string[] = [];
  const missionIds: string[] = [];
  const beliefIds: string[] = [];
  const learningKnowledgeIds: string[] = [];

  for (const trace of traces) {
    const observationStep = resultOf(trace, 'observation');
    if (observationStep !== null) {
      for (const id of observationStep.observationIds) addObservationId(id);
    }
    const memoryStep = resultOf(trace, 'evidence-memory');
    if (memoryStep !== null) {
      for (const id of memoryStep.knowledgeEntryIds) {
        if (!knowledgeIds.includes(id)) knowledgeIds.push(id);
      }
      for (const id of memoryStep.transactiveEntryIds) {
        try {
          const entry = await getTransactiveEntry(ctx, id);
          if (!evidence.transactive.some((existing) => existing.id === entry.id)) {
            evidence.transactive.push({
              id: entry.id,
              relation: entry.relation,
              subjectLabel: entry.subjectLabel,
              actor: { kind: entry.actor.kind, id: entry.actor.id ?? null, label: entry.actor.label ?? null },
            });
          }
        } catch (error) {
          if (!(error instanceof MemoryError)) throw error; // skip unreadable, keep assembling
        }
      }
    }
    const epistemicStep = resultOf(trace, 'epistemic-evaluation');
    if (epistemicStep !== null) {
      for (const id of epistemicStep.claimIds) {
        if (!claimIds.includes(id)) claimIds.push(id);
      }
    }
    const unknownMissionStep = resultOf(trace, 'unknown-mission-evaluation');
    if (unknownMissionStep !== null) {
      for (const id of unknownMissionStep.unknownIds) {
        if (!unknownIds.includes(id)) unknownIds.push(id);
      }
      for (const id of unknownMissionStep.missionIds) {
        if (!missionIds.includes(id)) missionIds.push(id);
      }
    }
    const acquisitionStep = resultOf(trace, 'knowledge-acquisition');
    if (acquisitionStep !== null && acquisitionStep.missionId !== null) {
      if (!missionIds.includes(acquisitionStep.missionId)) missionIds.push(acquisitionStep.missionId);
    }
    const modelStep = resultOf(trace, 'model-update');
    if (modelStep !== null && modelStep.beliefId !== null) {
      if (!beliefIds.includes(modelStep.beliefId)) beliefIds.push(modelStep.beliefId);
    }
    const learningStep = resultOf(trace, 'learning');
    if (learningStep !== null && learningStep.knowledgeEntryId !== null) {
      if (!learningKnowledgeIds.includes(learningStep.knowledgeEntryId)) {
        learningKnowledgeIds.push(learningStep.knowledgeEntryId);
      }
    }
  }

  // Claim/belief/learning evidence citations extend the evidence base.
  for (const claimId of claimIds) {
    try {
      const claim = await getClaim(ctx, { claimId });
      for (const id of claim.evidenceObservationIds) addObservationId(id);
    } catch (error) {
      if (!(error instanceof EpistemicsError)) throw error;
    }
  }
  for (const beliefId of beliefIds) {
    try {
      const belief = await getBelief(ctx, { beliefId });
      for (const id of belief.provenance.observationIds) addObservationId(id);
    } catch (error) {
      if (!(error instanceof EpistemicsError)) throw error;
    }
  }
  for (const knowledgeId of learningKnowledgeIds) {
    try {
      const entry = await getKnowledgeEntry(ctx, knowledgeId);
      for (const id of entry.evidenceObservationIds) addObservationId(id);
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
    }
  }
  evidence.observations = await readObservations(ctx, evidenceObservationIds);
  for (const knowledgeId of knowledgeIds) {
    try {
      const entry = await getKnowledgeEntry(ctx, knowledgeId);
      if (!evidence.knowledge.some((existing) => existing.id === entry.id)) {
        evidence.knowledge.push({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          summary: entry.summary,
          evidenceObservationIds: [...entry.evidenceObservationIds],
        });
      }
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
    }
  }

  // ----- §24 `claims/beliefs` — what was derived and concluded ------------
  const claimsBeliefs: DecisionChain['claimsBeliefs'] = { claims: [], beliefs: [] };
  for (const claimId of claimIds) {
    try {
      const claim = await getClaim(ctx, { claimId });
      if (!claimsBeliefs.claims.some((existing) => existing.id === claim.id)) {
        claimsBeliefs.claims.push({
          id: claim.id,
          proposition: claim.proposition,
          confidenceValue: claim.confidence.value,
          evidenceObservationIds: [...claim.evidenceObservationIds],
        });
      }
    } catch (error) {
      if (!(error instanceof EpistemicsError)) throw error;
    }
  }
  for (const beliefId of beliefIds) {
    try {
      const belief = await getBelief(ctx, { beliefId });
      if (!claimsBeliefs.beliefs.some((existing) => existing.id === belief.id)) {
        claimsBeliefs.beliefs.push({
          id: belief.id,
          version: belief.version,
          proposition: belief.statement.proposition,
          confidenceValue: belief.statement.confidence.value,
          alternatives: [...belief.statement.alternatives],
          status: belief.status,
          validFrom: belief.validFrom,
        });
      }
    } catch (error) {
      if (!(error instanceof EpistemicsError)) throw error;
    }
  }

  // ----- §24 `unknown/mission` — the gap and the response ----------------
  const unknownMission: DecisionChain['unknownMission'] = { unknowns: [], missions: [] };
  for (const unknownId of unknownIds) {
    try {
      const unknown = await getUnknown(ctx, { unknownId });
      if (!unknownMission.unknowns.some((existing) => existing.id === unknown.id)) {
        unknownMission.unknowns.push({
          id: unknown.id,
          question: unknown.question,
          consequence: unknown.consequence,
          status: unknown.status,
        });
      }
    } catch (error) {
      if (!(error instanceof EpistemicsError)) throw error;
    }
  }
  for (const missionId of missionIds) {
    try {
      const mission = await getMission(ctx, missionId);
      if (unknownMission.missions.some((existing) => existing.id === mission.id)) continue;
      // The acquisition the cycle drove for this mission, when it did (W012).
      let acquisition: DecisionChain['unknownMission']['missions'][number]['acquisition'] = null;
      for (const trace of traces) {
        const step = resultOf(trace, 'knowledge-acquisition');
        if (step !== null && step.missionId === mission.id) {
          acquisition = {
            outcomeKind: step.outcome === null ? null : step.outcome.kind,
            confidence: step.missionConfidence,
            completed: step.missionCompleted,
          };
          break;
        }
      }
      unknownMission.missions.push({
        id: mission.id,
        title: mission.content.title,
        knowledgeObjective: mission.content.knowledgeObjective,
        status: mission.content.status,
        currentConfidence: mission.content.currentConfidence,
        targetConfidence: mission.content.targetConfidence,
        achievedConfidence: mission.completion === null ? null : mission.completion.achievedConfidence,
        acquisition,
      });
    } catch (error) {
      if (!(error instanceof MissionsError)) throw error;
    }
  }

  // ----- audit history + the stage-filtered link events ------------------
  const auditRecords = await loadDecisionAuditRecords(
    ctx,
    correlationId,
    traces.map((trace) => trace.id),
    requestIds,
  );
  const policyEvents = auditRecords.filter((record) => record.chainStage === 'policy');
  const modelProviderEvents = auditRecords.filter((record) => record.chainStage === 'model-provider');

  // ----- §24 `policy` — which rules governed the decision ----------------
  const policy: DecisionChain['policy'] = {
    authorityEvaluation:
      terminalRequest === null
        ? null
        : {
            actionKind: terminalRequest.actionKind,
            authorityLevel: terminalRequest.authorityLevel,
            outcome: terminalRequest.evaluation.outcome,
            resolvedVia: terminalRequest.evaluation.resolvedVia,
            policyNote: terminalRequest.evaluation.policy === null ? null : terminalRequest.evaluation.policy.note,
          },
    events: policyEvents,
  };

  // ----- §24 `model/provider` — which models produced the evidence -------
  const modelProvider: DecisionChain['modelProvider'] = {
    extractors: deriveExtractors(evidence.observations),
    events: modelProviderEvents,
  };

  // ----- §24 `recommendation` — what was proposed -------------------------
  const recommendation: DecisionChain['recommendation'] = {
    actionRequest:
      terminalRequest === null
        ? null
        : {
            id: terminalRequest.id,
            actionKind: terminalRequest.actionKind,
            authorityLevel: terminalRequest.authorityLevel,
            payload: terminalRequest.payload,
            justification: terminalRequest.justification,
            requestedBy: terminalRequest.requestedBy,
            requestedAt: terminalRequest.requestedAt,
            idempotencyKey: terminalRequest.idempotencyKey,
            status: terminalRequest.status,
          },
  };

  // ----- §24 `approval` — who decided, when, and how ---------------------
  const approval: DecisionChain['approval'] = { decisions: [] };
  for (const requestId of requestIds) {
    try {
      const decisions = await listApprovalDecisions(ctx, { requestId });
      for (const decision of decisions) {
        approval.decisions.push({
          id: decision.id,
          requestId: decision.requestId,
          decision: decision.decision,
          decidedBy: decision.decidedBy,
          principalId: decision.principalId,
          note: decision.note,
          decidedAt: decision.decidedAt,
        });
      }
    } catch (error) {
      if (!(error instanceof ActionsError)) throw error;
    }
  }

  // ----- §24 `execution` — what actually executed -------------------------
  const executionLink: DecisionChain['execution'] = {
    executions: traces.map(toDecisionExecution),
    directAuthorization: anchoredRequest !== null && traces.length === 0,
  };

  // ----- §24 `result` — what the gate produced ----------------------------
  let gate: DecisionChain['result']['gate'] = null;
  let resolution: DecisionChain['result']['resolution'] = null;
  if (terminalRequestId !== null) {
    for (const trace of traces) {
      const step = resultOf(trace, 'recommendation-ask-proposal-action');
      if (step !== null && step.actionRequest !== null && step.actionRequest.id === terminalRequestId) {
        gate = step.gate;
        resolution = step.resolution;
        break;
      }
    }
    if (gate === null && terminalRequest !== null) {
      // A directly-anchored request never ran through a cognition stage:
      // the recorded evaluation snapshot IS its gate.
      gate = terminalRequest.evaluation.outcome;
    }
  }
  const result: DecisionChain['result'] = {
    gate,
    resolution,
    requestStatus: terminalRequest === null ? null : terminalRequest.status,
    decidedAt: terminalRequest === null ? null : terminalRequest.decidedAt,
  };

  // ----- §24 `outcome` — what the cycle recorded as its result ------------
  const outcome: DecisionChain['outcome'] = {
    outcomes: traces
      .filter((trace) => trace.outcome !== null)
      .map((trace) => ({
        executionId: trace.id,
        kind: trace.outcome!.kind,
        summary: trace.outcome!.summary,
        actionRequestId: trace.outcome!.actionRequestId,
        recordedAt: trace.outcome!.recordedAt,
      })),
  };

  // ----- §24 `learning` — what was durably learned -------------------------
  const learning: DecisionChain['learning'] = { knowledge: [] };
  for (const knowledgeId of learningKnowledgeIds) {
    try {
      const entry = await getKnowledgeEntry(ctx, knowledgeId);
      if (!learning.knowledge.some((existing) => existing.id === entry.id)) {
        learning.knowledge.push({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          summary: entry.summary,
          topics: [...entry.topics],
          evidenceObservationIds: [...entry.evidenceObservationIds],
        });
      }
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
    }
  }

  // ----- assemble ----------------------------------------------------------
  const chain: DecisionChain = {
    input,
    evidence,
    claimsBeliefs,
    unknownMission,
    policy,
    modelProvider,
    recommendation,
    approval,
    execution: executionLink,
    result,
    outcome,
    learning,
  };

  return {
    tenantId: ctx.tenantId,
    anchor,
    correlationId,
    reconstructedAt: now().toISOString(),
    chain,
    completeness: chainCompleteness(chain),
    auditRecords,
  };
}
