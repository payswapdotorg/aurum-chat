// Implementation of the agent-supervision module's operations (W098 —
// see contract.ts for the public surface). Conventions
// (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port with
// `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and
// are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`supervision_not_found` / `review_not_found`
// / `session_not_found` — no existence leak).
//
// W098 acceptance properties carried here:
//   * DURABILITY — every supervision fact (status, health, review
//     schedule, budget envelope and spend, permission ceiling, waiting
//     states, decision links) is a row in PostgreSQL. The supervisor
//     "instance" is stateless code; a fresh worker resumes by reading
//     these rows. No supervision state is held only in worker memory.
//   * EXACTLY-ONCE ACCOUNTING — budget consumption ledgers W021
//     attempts under a UNIQUE (tenant, attempt) key; a crashed,
//     restarted or duplicated pump can neither double-count nor lose
//     spend. Review firing and every status transition are guarded
//     optimistic UPDATEs — a racing pump changes nothing.
//   * WORKER-LIFETIME EVIDENCE — supervisor sessions are durable lease
//     rows; `beginSupervisorSession` recovers expired sessions and
//     records the recovery; the pump refuses to run under a dead
//     session's identity.
//   * AUTHORITATIVE CONTROLS — supervision never terminates an agent:
//     a terminate_proposal defers to the W024 lifecycle decision (read
//     through its contract), and enforcement of suspensions/
//     terminations cancels live supervised work through the agents
//     module's PUBLIC contract only.
//
// Cross-module reads (agents/agent-teams/agent-evaluation contracts)
// happen BEFORE SQL transactions open — the embedded database pins a
// single connection, and the agents module's own pump documents the
// starvation hazard of base reads inside open transactions.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  AgentEvaluationError,
  getAgentEvaluation,
  getAgentLifecycleDecision,
  listAgentEvaluations,
} from '@/modules/agent-evaluation/contract';
import { listTeams } from '@/modules/agent-teams/contract';
import {
  AgentsError,
  cancelAgentExecution,
  getAgent,
  listAgentExecutionAttempts,
  listAgentExecutions,
  submitAgentExecution,
} from '@/modules/agents/contract';
import type { AgentExecution, AgentPermissionScope } from '@/modules/agents/contract';
import { assessAgentHealth, defaultHealthWindow } from './health';
import { AgentSupervisionError } from './errors';
import {
  budgetRemainingMinor,
  canAdministerSupervision,
  isBudgetExhausted,
  isHealthObservationDue,
  isReviewDue,
  isSupervisedExecution,
  missingCeilingScope,
  nextReviewAfterCompletion,
  statusAfterReview,
  supervisionCausationKey,
} from './policy';
import {
  assertSupervisionTenantContext,
  BUDGET_SCAN_EXECUTION_LIMIT,
  EVIDENCE_SCAN_LIMIT,
  validateBeginSupervisorSessionInput,
  validateCompleteSupervisionReviewInput,
  validateEndSupervisorSessionInput,
  validateGetSupervisionQuery,
  validateGetSupervisionReviewQuery,
  validateGetSupervisorSessionQuery,
  validateGrantSupervisionBudgetInput,
  validateHeartbeatSupervisorSessionInput,
  validateListSupervisionBudgetEntriesQuery,
  validateListSupervisionEventsQuery,
  validateListSupervisionReviewsQuery,
  validateListSupervisionsQuery,
  validateListSupervisorSessionsQuery,
  validateRegisterSupervisedAgentInput,
  validateResumeSupervisionInput,
  validateSubmitSupervisedExecutionInput,
  validateSupervisionPumpInput,
  validateSuspendSupervisionInput,
  validateUpdateSupervisionInput,
  type ValidatedRegisterInput,
} from './validation';
import type {
  AgentSupervisionEvent,
  AgentSupervisionEventKind,
  AgentSupervisionRecord,
  AgentSupervisionReview,
  AgentSupervisorSession,
  AgentSupervisionBudgetEntry,
  BeginSupervisorSessionInput,
  CompleteSupervisionReviewInput,
  EndSupervisorSessionInput,
  GetSupervisionQuery,
  GrantSupervisionBudgetInput,
  HeartbeatSupervisorSessionInput,
  ListSupervisionBudgetEntriesQuery,
  ListSupervisionEventsQuery,
  ListSupervisionReviewsQuery,
  ListSupervisionsQuery,
  ListSupervisorSessionsQuery,
  RegisterSupervisedAgentInput,
  ResumeSupervisionInput,
  SubmitSupervisedExecutionInput,
  SupervisionPumpInput,
  SupervisionPumpOutcome,
  SupervisionPumpStatus,
  SupervisionReviewContext,
  SupervisionReviewOutcome,
  SuspendSupervisionInput,
  UpdateSupervisionInput,
} from './types';

// ---------------------------------------------------------------------------
// Row shapes and mappers
// ---------------------------------------------------------------------------

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function toCount(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toCountOrNull(value: string | number | null): number | null {
  return value === null ? null : toCount(value);
}

interface RecordRow extends DbRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  owner_principal: string;
  status: AgentSupervisionRecord['status'];
  health_state: AgentSupervisionRecord['healthState'];
  health_detail: string | null;
  health_observed_at: Date | string | null;
  review_interval_seconds: number;
  health_interval_seconds: number;
  next_review_at: Date | string;
  last_review_at: Date | string | null;
  review_count: number;
  budget_minor: string | number | null;
  budget_spent_minor: string | number;
  permitted_scopes: AgentPermissionScope[];
  termination_decision_id: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRecord(row: RecordRow): AgentSupervisionRecord {
  const budgetMinor = toCountOrNull(row.budget_minor);
  const budgetSpentMinor = toCount(row.budget_spent_minor);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    ownerPrincipal: row.owner_principal,
    status: row.status,
    healthState: row.health_state,
    healthDetail: row.health_detail,
    healthObservedAt: toIsoOrNull(row.health_observed_at),
    reviewIntervalSeconds: Number(row.review_interval_seconds),
    healthIntervalSeconds: Number(row.health_interval_seconds),
    nextReviewAt: toIso(row.next_review_at),
    lastReviewAt: toIsoOrNull(row.last_review_at),
    reviewCount: Number(row.review_count),
    budgetMinor,
    budgetSpentMinor,
    budgetRemainingMinor: budgetRemainingMinor(budgetMinor, budgetSpentMinor),
    permittedScopes: [...(row.permitted_scopes ?? [])],
    terminationDecisionId: row.termination_decision_id,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  supervision_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  kind: AgentSupervisionEventKind;
  detail: string;
  data: unknown;
  recorded_by: string;
  recorded_at: Date | string;
}

function mapEvent(row: EventRow): AgentSupervisionEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    supervisionId: row.supervision_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    kind: row.kind,
    detail: row.detail,
    data: row.data,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

interface ReviewRow extends DbRow {
  id: string;
  tenant_id: string;
  supervision_id: string;
  agent_id: string;
  outcome: SupervisionReviewOutcome;
  rationale: string;
  evaluation_id: string | null;
  decision_id: string | null;
  adjustments: unknown;
  reviewed_by: string;
  reviewed_at: Date | string;
}

function mapReview(row: ReviewRow): AgentSupervisionReview {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    supervisionId: row.supervision_id,
    agentId: row.agent_id,
    outcome: row.outcome,
    rationale: row.rationale,
    evaluationId: row.evaluation_id,
    decisionId: row.decision_id,
    adjustments: (row.adjustments ?? null) as AgentSupervisionReview['adjustments'],
    reviewedBy: row.reviewed_by,
    reviewedAt: toIso(row.reviewed_at),
  };
}

interface BudgetEntryRow extends DbRow {
  id: string;
  tenant_id: string;
  supervision_id: string;
  agent_id: string;
  execution_id: string;
  attempt_id: string;
  cost_minor: string | number;
  cost_currency: 'USD';
  recorded_by: string;
  recorded_at: Date | string;
}

function mapBudgetEntry(row: BudgetEntryRow): AgentSupervisionBudgetEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    supervisionId: row.supervision_id,
    agentId: row.agent_id,
    executionId: row.execution_id,
    attemptId: row.attempt_id,
    costMinor: toCount(row.cost_minor),
    costCurrency: 'USD',
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

interface SessionRow extends DbRow {
  id: string;
  tenant_id: string;
  started_by: string;
  lease_seconds: number;
  started_at: Date | string;
  last_heartbeat_at: Date | string | null;
  lease_expires_at: Date | string;
  ended_at: Date | string | null;
  end_reason: AgentSupervisorSession['endReason'];
  recovered_by_session_id: string | null;
}

function mapSession(row: SessionRow): AgentSupervisorSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    startedBy: row.started_by,
    leaseSeconds: Number(row.lease_seconds),
    startedAt: toIso(row.started_at),
    lastHeartbeatAt: toIsoOrNull(row.last_heartbeat_at),
    leaseExpiresAt: toIso(row.lease_expires_at),
    endedAt: toIsoOrNull(row.ended_at),
    endReason: row.end_reason,
    recoveredBySessionId: row.recovered_by_session_id,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function notFound(agentId: string): AgentSupervisionError {
  return new AgentSupervisionError(
    'supervision_not_found',
    `no supervision record for agent '${agentId}' exists in this tenant`,
  );
}

async function findRecordRow(
  db: Queryable,
  ctx: TenantContext,
  agentId: string,
): Promise<RecordRow | null> {
  const rows = await db.query<RecordRow>(
    `SELECT * FROM agent_supervision_records WHERE tenant_id = $1 AND agent_id = $2`,
    [ctx.tenantId, agentId],
  );
  return rows.rows[0] ?? null;
}

async function requireRecord(
  db: Queryable,
  ctx: TenantContext,
  agentId: string,
): Promise<RecordRow> {
  const row = await findRecordRow(db, ctx, agentId);
  if (row === null) throw notFound(agentId);
  return row;
}

/** Appends one supervision event (inside a transaction or on the base connection). */
async function appendEvent(
  db: Queryable,
  ctx: TenantContext,
  event: {
    supervisionId?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    kind: AgentSupervisionEventKind;
    detail: string;
    data?: unknown;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO agent_supervision_events (
       tenant_id, supervision_id, agent_id, session_id, kind, detail, data, recorded_by, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      ctx.tenantId,
      event.supervisionId ?? null,
      event.agentId ?? null,
      event.sessionId ?? null,
      event.kind,
      event.detail,
      event.data === undefined ? null : JSON.stringify(event.data),
      ctx.principalId,
      now(),
    ],
  );
}

/** Reads an agent through the agents contract, mapping the uniform not-found. */
async function readAgentOrThrow(ctx: TenantContext, agentId: string) {
  try {
    return await getAgent(ctx, { agentId });
  } catch (error) {
    if (error instanceof AgentsError && error.code === 'agent_not_found') {
      throw new AgentSupervisionError(
        'agent_not_found',
        `no agent '${agentId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

function requireAdmin(ctx: TenantContext): void {
  if (!canAdministerSupervision(ctx.authority)) {
    throw new AgentSupervisionError(
      'forbidden',
      `this operation requires the 'agents:administer' authority claim`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registration (idempotent per agent — the registerAgent discipline)
// ---------------------------------------------------------------------------

export async function registerSupervisedAgent(
  ctx: TenantContext,
  input: RegisterSupervisedAgentInput,
): Promise<{ supervision: AgentSupervisionRecord; created: boolean }> {
  assertSupervisionTenantContext(ctx);
  requireAdmin(ctx);
  const valid: ValidatedRegisterInput = validateRegisterSupervisedAgentInput(input);

  // The supervised actor — validated readable through the agents
  // contract at write time (the agent-teams member precedent; no
  // cross-module foreign key).
  const agent = await readAgentOrThrow(ctx, valid.agentId);
  const permittedScopes = valid.permittedScopes ?? agent.permissions;

  const at = now();
  const nextReviewAt = new Date(at.getTime() + valid.reviewIntervalSeconds * 1000);

  return getDb().transaction(async (tx) => {
    const inserted = await tx.query<RecordRow>(
      `INSERT INTO agent_supervision_records (
         tenant_id, agent_id, owner_principal, status,
         health_state, health_detail, health_observed_at,
         review_interval_seconds, health_interval_seconds,
         next_review_at, last_review_at, review_count,
         budget_minor, budget_spent_minor, permitted_scopes,
         termination_decision_id, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active',
                 'unknown', NULL, NULL,
                 $4, $5,
                 $6, NULL, 0,
                 $7, 0, $8::jsonb,
                 NULL, $9, $10, $10)
       ON CONFLICT (tenant_id, agent_id) DO NOTHING
       RETURNING *`,
      [
        ctx.tenantId,
        valid.agentId,
        valid.ownerPrincipal ?? ctx.principalId,
        valid.reviewIntervalSeconds,
        valid.healthIntervalSeconds,
        nextReviewAt,
        valid.budgetMinor,
        JSON.stringify(permittedScopes),
        ctx.principalId,
        at,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) {
      await appendEvent(tx, ctx, {
        supervisionId: row.id,
        agentId: row.agent_id,
        kind: 'registered',
        detail: `supervision registered for agent '${agent.slug}' (review every ${valid.reviewIntervalSeconds}s, budget ${valid.budgetMinor === null ? 'unlimited' : `${valid.budgetMinor} minor`})`,
        data: {
          reviewIntervalSeconds: valid.reviewIntervalSeconds,
          healthIntervalSeconds: valid.healthIntervalSeconds,
          budgetMinor: valid.budgetMinor,
          permittedScopes,
        },
      });
      return { supervision: mapRecord(row), created: true };
    }
    // First write wins: replay the existing registration unchanged.
    const existing = await requireRecord(tx, ctx, valid.agentId);
    await appendEvent(tx, ctx, {
      supervisionId: existing.id,
      agentId: existing.agent_id,
      kind: 'registration_replayed',
      detail: `supervision for this agent already exists — the first registration stands`,
    });
    return { supervision: mapRecord(existing), created: false };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getSupervision(
  ctx: TenantContext,
  query: GetSupervisionQuery,
): Promise<AgentSupervisionRecord> {
  assertSupervisionTenantContext(ctx);
  const valid = validateGetSupervisionQuery(query);
  const row = await findRecordRow(getDb(), ctx, valid.agentId);
  if (row === null) throw notFound(valid.agentId);
  return mapRecord(row);
}

export async function listSupervisions(
  ctx: TenantContext,
  query: ListSupervisionsQuery,
): Promise<AgentSupervisionRecord[]> {
  assertSupervisionTenantContext(ctx);
  const valid = validateListSupervisionsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.healthState !== null) {
    params.push(valid.healthState);
    conditions.push(`health_state = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<RecordRow>(
    `SELECT * FROM agent_supervision_records WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapRecord);
}

// ---------------------------------------------------------------------------
// Management controls
// ---------------------------------------------------------------------------

export async function updateSupervision(
  ctx: TenantContext,
  input: UpdateSupervisionInput,
): Promise<AgentSupervisionRecord> {
  assertSupervisionTenantContext(ctx);
  requireAdmin(ctx);
  const valid = validateUpdateSupervisionInput(input);

  const existing = await requireRecord(getDb(), ctx, valid.agentId);
  const at = now();

  return getDb().transaction(async (tx) => {
    // A cadence change re-arms the review schedule from now (the
    // durable cursor is recomputed so the new cadence is meaningful).
    const nextReviewAt =
      valid.reviewIntervalSeconds !== null
        ? new Date(at.getTime() + valid.reviewIntervalSeconds * 1000)
        : new Date(Date.parse(toIso(existing.next_review_at)));

    const updated = await tx.query<RecordRow>(
      `UPDATE agent_supervision_records
         SET owner_principal = COALESCE($3, owner_principal),
             review_interval_seconds = COALESCE($4, review_interval_seconds),
             health_interval_seconds = COALESCE($5, health_interval_seconds),
             permitted_scopes = COALESCE($6::jsonb, permitted_scopes),
             next_review_at = $7,
             updated_at = $8
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        ctx.tenantId,
        existing.id,
        valid.ownerPrincipal,
        valid.reviewIntervalSeconds,
        valid.healthIntervalSeconds,
        valid.permittedScopes === null ? null : JSON.stringify(valid.permittedScopes),
        nextReviewAt,
        at,
      ],
    );
    const row = updated.rows[0]!;
    await appendEvent(tx, ctx, {
      supervisionId: row.id,
      agentId: row.agent_id,
      kind: 'updated',
      detail: `supervision controls updated (owner${valid.ownerPrincipal !== null ? ' → ' + valid.ownerPrincipal : ''}${valid.reviewIntervalSeconds !== null ? `, review cadence → ${valid.reviewIntervalSeconds}s` : ''}${valid.healthIntervalSeconds !== null ? `, health cadence → ${valid.healthIntervalSeconds}s` : ''}${valid.permittedScopes !== null ? `, ceiling → [${valid.permittedScopes.join(', ')}]` : ''})`,
      data: {
        ownerPrincipal: valid.ownerPrincipal,
        reviewIntervalSeconds: valid.reviewIntervalSeconds,
        healthIntervalSeconds: valid.healthIntervalSeconds,
        permittedScopes: valid.permittedScopes,
      },
    });
    return mapRecord(row);
  });
}

export async function grantSupervisionBudget(
  ctx: TenantContext,
  input: GrantSupervisionBudgetInput,
): Promise<AgentSupervisionRecord> {
  assertSupervisionTenantContext(ctx);
  requireAdmin(ctx);
  const valid = validateGrantSupervisionBudgetInput(input);

  const existing = await requireRecord(getDb(), ctx, valid.agentId);
  if (existing.budget_minor === null) {
    throw new AgentSupervisionError(
      'unlimited_budget',
      `supervision for agent '${valid.agentId}' has an unlimited budget envelope — grants apply only to finite envelopes`,
    );
  }
  const from = toCount(existing.budget_minor);
  const to = from + valid.additionalMinor;
  const at = now();

  return getDb().transaction(async (tx) => {
    // The grant lifts the envelope; a paused_budget actor resumes (the
    // budget waiting state's recovery authority is exactly this grant).
    const updated = await tx.query<RecordRow>(
      `UPDATE agent_supervision_records
         SET budget_minor = budget_minor + $3,
             status = CASE WHEN status = 'paused_budget' THEN 'active' ELSE status END,
             updated_at = $4
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [ctx.tenantId, existing.id, valid.additionalMinor, at],
    );
    const row = updated.rows[0]!;
    await appendEvent(tx, ctx, {
      supervisionId: row.id,
      agentId: row.agent_id,
      kind: 'budget_granted',
      detail: `budget envelope granted ${valid.additionalMinor} minor units (${from} → ${to})${valid.note !== null ? ` — ${valid.note}` : ''}`,
      data: { additionalMinor: valid.additionalMinor, fromMinor: from, toMinor: to },
    });
    if (existing.status === 'paused_budget') {
      await appendEvent(tx, ctx, {
        supervisionId: row.id,
        agentId: row.agent_id,
        kind: 'budget_resumed',
        detail: `the budget waiting state recovered — the grant lifted the envelope above ledgered spend`,
        data: { envelopeMinor: to },
      });
    }
    return mapRecord(row);
  });
}

export async function suspendSupervision(
  ctx: TenantContext,
  input: SuspendSupervisionInput,
): Promise<AgentSupervisionRecord> {
  assertSupervisionTenantContext(ctx);
  requireAdmin(ctx);
  const valid = validateSuspendSupervisionInput(input);

  const existing = await requireRecord(getDb(), ctx, valid.agentId);
  if (existing.status !== 'active') {
    throw new AgentSupervisionError(
      'invalid_transition',
      `supervision for agent '${valid.agentId}' is ${existing.status} — only an active actor can be suspended (waiting states recover through their own authority; a terminated actor is history)`,
    );
  }
  const at = now();

  return getDb().transaction(async (tx) => {
    const updated = await tx.query<RecordRow>(
      `UPDATE agent_supervision_records
         SET status = 'suspended', updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'active'
       RETURNING *`,
      [ctx.tenantId, existing.id, at],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new AgentSupervisionError(
        'invalid_transition',
        `supervision for agent '${valid.agentId}' moved while the suspension was being recorded`,
      );
    }
    await appendEvent(tx, ctx, {
      supervisionId: row.id,
      agentId: row.agent_id,
      kind: 'suspended',
      detail: `supervision suspended — ${valid.reason}`,
      data: { reason: valid.reason },
    });
    return mapRecord(row);
  });
}

export async function resumeSupervision(
  ctx: TenantContext,
  input: ResumeSupervisionInput,
): Promise<AgentSupervisionRecord> {
  assertSupervisionTenantContext(ctx);
  requireAdmin(ctx);
  const valid = validateResumeSupervisionInput(input);

  const existing = await requireRecord(getDb(), ctx, valid.agentId);
  if (existing.status !== 'suspended') {
    throw new AgentSupervisionError(
      'invalid_transition',
      `supervision for agent '${valid.agentId}' is ${existing.status} — only a suspended actor can be resumed`,
    );
  }
  const at = now();

  return getDb().transaction(async (tx) => {
    const updated = await tx.query<RecordRow>(
      `UPDATE agent_supervision_records
         SET status = 'active', updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'suspended'
       RETURNING *`,
      [ctx.tenantId, existing.id, at],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new AgentSupervisionError(
        'invalid_transition',
        `supervision for agent '${valid.agentId}' moved while the resume was being recorded`,
      );
    }
    await appendEvent(tx, ctx, {
      supervisionId: row.id,
      agentId: row.agent_id,
      kind: 'resumed',
      detail: `supervision resumed${valid.note !== null ? ` — ${valid.note}` : ''} (the review cadence still applies: a lapsed cursor fires a review before full duty returns)`,
      data: { note: valid.note },
    });
    return mapRecord(row);
  });
}

// ---------------------------------------------------------------------------
// Supervision-gated work admission
// ---------------------------------------------------------------------------

export async function submitSupervisedExecution(
  ctx: TenantContext,
  input: SubmitSupervisedExecutionInput,
): Promise<AgentExecution> {
  assertSupervisionTenantContext(ctx);
  const valid = validateSubmitSupervisedExecutionInput(input);

  const record = mapRecord(await requireRecord(getDb(), ctx, valid.agentId));

  // Admission — evaluated against the CURRENT durable supervision
  // contract, before anything reaches the gateway (the W021
  // permission_not_granted discipline: a refused admission records
  // nothing).
  if (record.status !== 'active') {
    const recovery =
      record.status === 'terminated'
        ? 'the actor is terminated (history)'
        : `recovery authority: ${record.status === 'waiting_review' ? 'completeSupervisionReview' : record.status === 'paused_budget' ? 'grantSupervisionBudget' : record.status === 'suspended' ? 'resumeSupervision' : 'the cited agent-evaluation lifecycle decision'}`;
    throw new AgentSupervisionError(
      'not_active',
      `supervision for agent '${valid.agentId}' is ${record.status} — supervised work is not admitted while the actor waits (${recovery})`,
    );
  }
  const missing = missingCeilingScope(record.permittedScopes, valid.requestedPermissions);
  if (missing !== null) {
    throw new AgentSupervisionError(
      'scope_not_permitted',
      `supervision permits only [${record.permittedScopes.join(', ')}] — the request exceeds the ceiling with '${missing}'`,
    );
  }
  if (isBudgetExhausted(record)) {
    throw new AgentSupervisionError(
      'budget_exhausted',
      `supervision budget exhausted — ledgered spend ${record.budgetSpentMinor} has reached the envelope ${record.budgetMinor}; grant budget to resume admissions`,
    );
  }

  // Delegation — the W021 gateway unchanged: grant check, W009
  // authority gate, idempotency. The supervision causation identity
  // makes the execution attributable (and enforceable) by supervision.
  return submitAgentExecution(ctx, {
    agentId: valid.agentId,
    task: valid.task,
    requestedPermissions: valid.requestedPermissions,
    maxAttempts: valid.maxAttempts ?? undefined,
    correlationId: valid.correlationId ?? undefined,
    causationId: supervisionCausationKey(record.id),
    idempotencyKey: valid.idempotencyKey ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Reviews (the review authority)
// ---------------------------------------------------------------------------

export async function completeSupervisionReview(
  ctx: TenantContext,
  input: CompleteSupervisionReviewInput,
): Promise<AgentSupervisionReview> {
  assertSupervisionTenantContext(ctx);
  requireAdmin(ctx);
  const valid = validateCompleteSupervisionReviewInput(input);

  const existing = await requireRecord(getDb(), ctx, valid.agentId);
  if (existing.status !== 'waiting_review') {
    throw new AgentSupervisionError(
      'review_not_due',
      `supervision for agent '${valid.agentId}' is ${existing.status} — reviews complete from the waiting_review state (the pump fires due reviews)`,
    );
  }

  // The cited evaluation, validated readable through the W024 contract.
  if (valid.evaluationId !== null) {
    try {
      const evaluation = await getAgentEvaluation(ctx, { evaluationId: valid.evaluationId });
      if (evaluation.agentId !== existing.agent_id) {
        throw new AgentSupervisionError(
          'invalid_evaluation_link',
          `evaluation '${valid.evaluationId}' measures a different agent — a review may cite only its own agent's evidence`,
        );
      }
    } catch (error) {
      if (error instanceof AgentEvaluationError && error.code === 'evaluation_not_found') {
        throw new AgentSupervisionError(
          'invalid_evaluation_link',
          `no agent evaluation '${valid.evaluationId}' exists in this tenant`,
        );
      }
      throw error;
    }
  }

  // The cited W024 termination decision — the lifecycle control that
  // stays authoritative. Supervision only defers to it.
  if (valid.outcome === 'terminate_proposal') {
    let decision;
    try {
      decision = await getAgentLifecycleDecision(ctx, { decisionId: valid.decisionId! });
    } catch (error) {
      if (error instanceof AgentEvaluationError && error.code === 'decision_not_found') {
        throw new AgentSupervisionError(
          'invalid_decision_link',
          `no agent lifecycle decision '${valid.decisionId}' exists in this tenant`,
        );
      }
      throw error;
    }
    if (decision.change !== 'terminate') {
      throw new AgentSupervisionError(
        'invalid_decision_link',
        `lifecycle decision '${decision.id}' is a '${decision.change}' decision — a termination proposal must cite a terminate decision`,
      );
    }
    if (decision.agentId !== existing.agent_id) {
      throw new AgentSupervisionError(
        'invalid_decision_link',
        `lifecycle decision '${decision.id}' belongs to a different agent — supervision may not terminate through a foreign decision`,
      );
    }
  }

  // Adjustments that touch the budget require a finite envelope.
  if (valid.adjustments?.budgetAdditionalMinor != null && existing.budget_minor === null) {
    throw new AgentSupervisionError(
      'unlimited_budget',
      `supervision for agent '${valid.agentId}' has an unlimited budget envelope — budget adjustments apply only to finite envelopes`,
    );
  }

  const at = now();
  const target = statusAfterReview(valid.outcome);
  const nextInterval =
    valid.adjustments?.reviewIntervalSeconds ?? Number(existing.review_interval_seconds);
  const nextReviewAt = new Date(nextReviewAfterCompletion(at.getTime(), nextInterval));

  return getDb().transaction(async (tx) => {
    const updated = await tx.query<RecordRow>(
      `UPDATE agent_supervision_records
         SET status = $3,
             last_review_at = $4,
             review_count = review_count + 1,
             next_review_at = $5,
             owner_principal = COALESCE($6, owner_principal),
             review_interval_seconds = COALESCE($7, review_interval_seconds),
             health_interval_seconds = COALESCE($8, health_interval_seconds),
             permitted_scopes = COALESCE($9::jsonb, permitted_scopes),
             budget_minor = budget_minor + COALESCE($10, 0),
             termination_decision_id = COALESCE($11, termination_decision_id)
       WHERE tenant_id = $1 AND id = $2 AND status = 'waiting_review'
       RETURNING *`,
      [
        ctx.tenantId,
        existing.id,
        target,
        at,
        nextReviewAt,
        valid.adjustments?.ownerPrincipal ?? null,
        valid.adjustments?.reviewIntervalSeconds ?? null,
        valid.adjustments?.healthIntervalSeconds ?? null,
        valid.adjustments?.permittedScopes == null
          ? null
          : JSON.stringify(valid.adjustments.permittedScopes),
        valid.adjustments?.budgetAdditionalMinor ?? null,
        valid.outcome === 'terminate_proposal' ? valid.decisionId : null,
      ],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new AgentSupervisionError(
        'review_not_due',
        `supervision for agent '${valid.agentId}' moved while the review was being completed`,
      );
    }

    const inserted = await tx.query<ReviewRow>(
      `INSERT INTO agent_supervision_reviews (
         tenant_id, supervision_id, agent_id, outcome, rationale,
         evaluation_id, decision_id, adjustments, reviewed_by, reviewed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING *`,
      [
        ctx.tenantId,
        existing.id,
        existing.agent_id,
        valid.outcome,
        valid.rationale,
        valid.evaluationId,
        valid.outcome === 'terminate_proposal' ? valid.decisionId : null,
        valid.adjustments === null ? null : JSON.stringify(valid.adjustments),
        ctx.principalId,
        at,
      ],
    );

    await appendEvent(tx, ctx, {
      supervisionId: row.id,
      agentId: row.agent_id,
      kind: 'review_completed',
      detail: `review completed with outcome '${valid.outcome}' — the actor is now ${target}`,
      data: { outcome: valid.outcome, target, evaluationId: valid.evaluationId, decisionId: valid.decisionId },
    });
    if (valid.outcome === 'terminate_proposal') {
      await appendEvent(tx, ctx, {
        supervisionId: row.id,
        agentId: row.agent_id,
        kind: 'termination_proposed',
        detail: `termination proposed, deferring to agent-evaluation lifecycle decision '${valid.decisionId}' (supervision never terminates — the W024 decision trail is authoritative)`,
        data: { decisionId: valid.decisionId },
      });
    }

    return mapReview(inserted.rows[0]!);
  });
}

export async function getSupervisionReview(
  ctx: TenantContext,
  query: { reviewId: string },
): Promise<AgentSupervisionReview> {
  assertSupervisionTenantContext(ctx);
  const valid = validateGetSupervisionReviewQuery(query);
  const rows = await getDb().query<ReviewRow>(
    `SELECT * FROM agent_supervision_reviews WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.reviewId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AgentSupervisionError(
      'review_not_found',
      `no supervision review '${valid.reviewId}' exists in this tenant`,
    );
  }
  return mapReview(row);
}

export async function listSupervisionReviews(
  ctx: TenantContext,
  query: ListSupervisionReviewsQuery,
): Promise<AgentSupervisionReview[]> {
  assertSupervisionTenantContext(ctx);
  const valid = validateListSupervisionReviewsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.agentId !== null) {
    params.push(valid.agentId);
    conditions.push(`agent_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<ReviewRow>(
    `SELECT * FROM agent_supervision_reviews WHERE ${conditions.join(' AND ')}
       ORDER BY reviewed_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapReview);
}

export async function listSupervisionEvents(
  ctx: TenantContext,
  query: ListSupervisionEventsQuery,
): Promise<AgentSupervisionEvent[]> {
  assertSupervisionTenantContext(ctx);
  const valid = validateListSupervisionEventsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.agentId !== null) {
    params.push(valid.agentId);
    conditions.push(`agent_id = $${params.length}`);
  }
  if (valid.supervisionId !== null) {
    params.push(valid.supervisionId);
    conditions.push(`supervision_id = $${params.length}`);
  }
  if (valid.sessionId !== null) {
    params.push(valid.sessionId);
    conditions.push(`session_id = $${params.length}`);
  }
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM agent_supervision_events WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapEvent);
}

export async function listSupervisionBudgetEntries(
  ctx: TenantContext,
  query: ListSupervisionBudgetEntriesQuery,
): Promise<AgentSupervisionBudgetEntry[]> {
  assertSupervisionTenantContext(ctx);
  const valid = validateListSupervisionBudgetEntriesQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.agentId !== null) {
    params.push(valid.agentId);
    conditions.push(`agent_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<BudgetEntryRow>(
    `SELECT * FROM agent_supervision_budget_entries WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapBudgetEntry);
}

// ---------------------------------------------------------------------------
// Health observation
// ---------------------------------------------------------------------------

export async function observeSupervisedAgentHealth(
  ctx: TenantContext,
  query: { agentId: string },
): Promise<AgentSupervisionRecord> {
  assertSupervisionTenantContext(ctx);
  const valid = validateGetSupervisionQuery(query);
  const existing = await requireRecord(getDb(), ctx, valid.agentId);
  if (existing.status === 'terminated') {
    throw new AgentSupervisionError(
      'invalid_transition',
      `supervision for agent '${valid.agentId}' is terminated — a terminated actor's health is history`,
    );
  }

  // Evidence through the agents contract only (never another module's
  // tables), assessed by the pure function — any worker computes the
  // same health from the same durable evidence.
  const executions = await listAgentExecutions(ctx, {
    agentId: valid.agentId,
    limit: EVIDENCE_SCAN_LIMIT,
  });
  const atMs = now().getTime();
  const window = defaultHealthWindow(atMs);
  const assessment = assessAgentHealth(
    executions.map((execution) => ({
      status: execution.status,
      submittedAt: execution.submittedAt,
    })),
    window.fromMs,
    window.toMs,
  );

  return getDb().transaction(async (tx) => {
    const updated = await tx.query<RecordRow>(
      `UPDATE agent_supervision_records
         SET health_state = $3, health_detail = $4, health_observed_at = $5, updated_at = $5
       WHERE tenant_id = $1 AND id = $2
         AND health_observed_at IS NOT DISTINCT FROM $6
       RETURNING *`,
      [
        ctx.tenantId,
        existing.id,
        assessment.state,
        assessment.detail,
        new Date(atMs),
        existing.health_observed_at,
      ],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      // A racing observation won — its evidence stands; report it.
      const current = await requireRecord(tx, ctx, valid.agentId);
      return mapRecord(current);
    }
    await appendEvent(tx, ctx, {
      supervisionId: row.id,
      agentId: row.agent_id,
      kind: 'health_observed',
      detail: `health observed: ${assessment.state} (${assessment.detail})`,
      data: { state: assessment.state, windowFrom: new Date(window.fromMs).toISOString() },
    });
    return mapRecord(row);
  });
}

// ---------------------------------------------------------------------------
// The composed review context (W021 + W023 + W024, contracts only)
// ---------------------------------------------------------------------------

export async function getSupervisionReviewContext(
  ctx: TenantContext,
  query: GetSupervisionQuery,
): Promise<SupervisionReviewContext> {
  assertSupervisionTenantContext(ctx);
  const valid = validateGetSupervisionQuery(query);
  const supervision = mapRecord(await requireRecord(getDb(), ctx, valid.agentId));

  const agent = await readAgentOrThrow(ctx, valid.agentId);

  const teams = await listTeams(ctx, { limit: 500 });
  const memberships = teams
    .filter((team) => team.status !== 'dissolved')
    .flatMap((team) =>
      team.content.members
        .filter((member) => member.agentId === valid.agentId)
        .map((member) => ({
          teamId: team.id,
          slug: team.slug,
          status: team.status,
          version: team.version,
          role: member.role,
        })),
    );

  const evaluations = await listAgentEvaluations(ctx, { agentId: valid.agentId, limit: 1 });
  const latest = evaluations[0] ?? null;

  return {
    supervision,
    agent: {
      agentId: agent.id,
      slug: agent.slug,
      role: agent.role,
      status: agent.status,
      provider: agent.provider,
      permissions: agent.permissions,
    },
    teams: memberships,
    latestEvaluation:
      latest === null
        ? null
        : {
            evaluationId: latest.id,
            recordedAt: latest.recordedAt,
            windowFrom: latest.windowFrom,
            windowTo: latest.windowTo,
            totalCostMinor: latest.cost.totalCostMinor,
            executionsIncluded: latest.cost.executionsIncluded,
          },
  };
}

// ---------------------------------------------------------------------------
// Supervisor sessions (the durable worker-lifetime ledger)
// ---------------------------------------------------------------------------

export async function beginSupervisorSession(
  ctx: TenantContext,
  input: BeginSupervisorSessionInput,
): Promise<AgentSupervisorSession> {
  assertSupervisionTenantContext(ctx);
  const valid = validateBeginSupervisorSessionInput(input);
  const at = now();
  const leaseExpiresAt = new Date(at.getTime() + valid.leaseSeconds * 1000);

  return getDb().transaction(async (tx) => {
    const inserted = await tx.query<SessionRow>(
      `INSERT INTO agent_supervisor_sessions (
         tenant_id, started_by, lease_seconds, started_at, last_heartbeat_at,
         lease_expires_at, ended_at, end_reason, recovered_by_session_id
       ) VALUES ($1, $2, $3, $4, NULL, $5, NULL, NULL, NULL)
       RETURNING *`,
      [ctx.tenantId, ctx.principalId, valid.leaseSeconds, at, leaseExpiresAt],
    );
    const session = inserted.rows[0]!;

    // RECOVERY — a dead worker's session (live row, expired lease) is
    // recovered HERE, durably: the takeover is recorded on the dead
    // session and in the append-only event trail. Supervision state
    // itself never lived in the session, so nothing else moves.
    const expired = await tx.query<SessionRow>(
      `UPDATE agent_supervisor_sessions
         SET ended_at = $3, end_reason = 'lease_expired_recovered', recovered_by_session_id = $2
       WHERE tenant_id = $1 AND ended_at IS NULL AND lease_expires_at <= $3
       RETURNING *`,
      [ctx.tenantId, session.id, at],
    );
    for (const dead of expired.rows) {
      await appendEvent(tx, ctx, {
        sessionId: dead.id,
        kind: 'session_recovered',
        detail: `supervisor session '${dead.id}' (lease expired) recovered by session '${session.id}' — durable supervision state continues unaffected`,
        data: { deadSessionId: dead.id, bySessionId: session.id },
      });
    }

    await appendEvent(tx, ctx, {
      sessionId: session.id,
      kind: 'session_started',
      detail: `supervisor session started by ${ctx.principalId} (lease ${valid.leaseSeconds}s)${expired.rows.length > 0 ? `; recovered ${expired.rows.length} expired session(s)` : ''}`,
      data: { leaseSeconds: valid.leaseSeconds, recovered: expired.rows.length },
    });
    return mapSession(session);
  });
}

export async function heartbeatSupervisorSession(
  ctx: TenantContext,
  input: HeartbeatSupervisorSessionInput,
): Promise<AgentSupervisorSession> {
  assertSupervisionTenantContext(ctx);
  const valid = validateHeartbeatSupervisorSessionInput(input);
  const at = now();

  return getDb().transaction(async (tx) => {
    // The lease extension is anchored to the CURRENT time, never the
    // old expiry — a long-dead session cannot be resurrected by a late
    // heartbeat (the W080 lease discipline).
    const updated = await tx.query<SessionRow>(
      `UPDATE agent_supervisor_sessions
         SET last_heartbeat_at = $3,
             lease_expires_at = $4::timestamptz + (lease_seconds * interval '1 second')
       WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL AND lease_expires_at > $3
       RETURNING *`,
      [ctx.tenantId, valid.sessionId, at, at],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      const existing = await tx.query<SessionRow>(
        `SELECT * FROM agent_supervisor_sessions WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.sessionId],
      );
      if (existing.rows[0] === undefined) {
        throw new AgentSupervisionError(
          'session_not_found',
          `no supervisor session '${valid.sessionId}' exists in this tenant`,
        );
      }
      throw new AgentSupervisionError(
        'session_not_live',
        `supervisor session '${valid.sessionId}' is not live — begin a fresh session (recovery) to continue supervising`,
      );
    }
    await appendEvent(tx, ctx, {
      sessionId: valid.sessionId,
      kind: 'session_heartbeat',
      detail: `supervisor session heartbeat — lease extended to ${toIso(row.lease_expires_at)}`,
    });
    return mapSession(row);
  });
}

export async function endSupervisorSession(
  ctx: TenantContext,
  input: EndSupervisorSessionInput,
): Promise<AgentSupervisorSession> {
  assertSupervisionTenantContext(ctx);
  const valid = validateEndSupervisorSessionInput(input);
  const at = now();

  return getDb().transaction(async (tx) => {
    const updated = await tx.query<SessionRow>(
      `UPDATE agent_supervisor_sessions
         SET ended_at = $3, end_reason = 'ended'
       WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL
       RETURNING *`,
      [ctx.tenantId, valid.sessionId, at],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      const existing = await tx.query<SessionRow>(
        `SELECT * FROM agent_supervisor_sessions WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.sessionId],
      );
      if (existing.rows[0] === undefined) {
        throw new AgentSupervisionError(
          'session_not_found',
          `no supervisor session '${valid.sessionId}' exists in this tenant`,
        );
      }
      throw new AgentSupervisionError(
        'session_not_live',
        `supervisor session '${valid.sessionId}' is already ended (${existing.rows[0]!.end_reason})`,
      );
    }
    await appendEvent(tx, ctx, {
      sessionId: valid.sessionId,
      kind: 'session_ended',
      detail: `supervisor session ended${valid.reason !== null ? ` — ${valid.reason}` : ''}`,
      data: { reason: valid.reason },
    });
    return mapSession(row);
  });
}

export async function getSupervisorSession(
  ctx: TenantContext,
  query: { sessionId: string },
): Promise<AgentSupervisorSession> {
  assertSupervisionTenantContext(ctx);
  const valid = validateGetSupervisorSessionQuery(query);
  const rows = await getDb().query<SessionRow>(
    `SELECT * FROM agent_supervisor_sessions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.sessionId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AgentSupervisionError(
      'session_not_found',
      `no supervisor session '${valid.sessionId}' exists in this tenant`,
    );
  }
  return mapSession(row);
}

export async function listSupervisorSessions(
  ctx: TenantContext,
  query: ListSupervisorSessionsQuery,
): Promise<AgentSupervisorSession[]> {
  assertSupervisionTenantContext(ctx);
  const valid = validateListSupervisorSessionsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.live !== null) {
    // The boolean is inlined as NULL-ness (no bind parameter — the
    // filter is a literal IS NULL / IS NOT NULL predicate).
    conditions.push(`ended_at IS ${valid.live ? 'NULL' : 'NOT NULL'}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<SessionRow>(
    `SELECT * FROM agent_supervisor_sessions WHERE ${conditions.join(' AND ')}
       ORDER BY started_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapSession);
}

// ---------------------------------------------------------------------------
// The pump (ONE bounded durable unit per call — the W080 discipline)
// ---------------------------------------------------------------------------

/** Loads and validates a live session for pump attribution (null when none given). */
async function requireLiveSession(
  ctx: TenantContext,
  sessionId: string | null,
): Promise<string | null> {
  if (sessionId === null) return null;
  const rows = await getDb().query<SessionRow>(
    `SELECT * FROM agent_supervisor_sessions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, sessionId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AgentSupervisionError(
      'session_not_found',
      `no supervisor session '${sessionId}' exists in this tenant`,
    );
  }
  if (row.ended_at !== null || new Date(row.lease_expires_at).getTime() <= now().getTime()) {
    throw new AgentSupervisionError(
      'session_not_live',
      `supervisor session '${sessionId}' is not live — begin a fresh session (recovery) to continue supervising`,
    );
  }
  return sessionId;
}

export async function pumpSupervision(
  ctx: TenantContext,
  input: SupervisionPumpInput,
): Promise<SupervisionPumpOutcome> {
  assertSupervisionTenantContext(ctx);
  const valid = validateSupervisionPumpInput(input);
  const sessionId = await requireLiveSession(ctx, valid.sessionId);
  const record = mapRecord(await requireRecord(getDb(), ctx, valid.agentId));
  const at = now();

  // Priority order (deterministic — tests rely on it):
  //   1. settle a waiting_termination from the W024 decision;
  //   2. enforce suspension/termination on live supervised work;
  //   3. fire a due review;
  //   4. ledger one un-ledgered attempt into the budget;
  //   5. fire budget exhaustion;
  //   6. refresh a stale health observation.
  const units: readonly ((
    record: AgentSupervisionRecord,
  ) => Promise<SupervisionPumpOutcome | null>)[] = [
    settleTerminationUnit(ctx, sessionId, at),
    cancelLiveWorkUnit(ctx, sessionId),
    reviewDueUnit(ctx, sessionId, at),
    budgetConsumptionUnit(ctx, sessionId, at),
    budgetExhaustionUnit(ctx, sessionId, at),
    healthObservationUnit(ctx, sessionId, at),
  ];

  for (const unit of units) {
    const outcome = await unit(record);
    if (outcome !== null) return outcome;
  }
  return {
    status: 'idle',
    agentId: valid.agentId,
    supervisionStatus: record.status,
    detail: 'nothing durable to advance for this agent',
  };
}

type PumpUnit = (
  record: AgentSupervisionRecord,
) => Promise<SupervisionPumpOutcome | null>;

function outcome(
  agentId: string,
  status: SupervisionPumpStatus,
  supervisionStatus: AgentSupervisionRecord['status'],
  detail: string,
): SupervisionPumpOutcome {
  return { status, agentId, supervisionStatus, detail };
}

/** Unit 1 — settle waiting_termination from the authoritative W024 decision. */
function settleTerminationUnit(ctx: TenantContext, sessionId: string | null, at: Date): PumpUnit {
  return async (record) => {
    if (record.status !== 'waiting_termination' || record.terminationDecisionId === null) {
      return null;
    }
    // The lifecycle control stays authoritative: the decision is read
    // through the W024 contract (BEFORE any SQL transaction — the
    // embedded-db single-connection discipline).
    let decision;
    try {
      decision = await getAgentLifecycleDecision(ctx, {
        decisionId: record.terminationDecisionId,
      });
    } catch (error) {
      if (error instanceof AgentEvaluationError && error.code === 'decision_not_found') {
        throw new Error(
          `supervision '${record.id}' cites lifecycle decision '${record.terminationDecisionId}' that is not readable in this tenant (internal invariant violation)`,
          { cause: error },
        );
      }
      throw error;
    }

    if (decision.status === 'applied') {
      return getDb().transaction(async (tx) => {
        const updated = await tx.query<RecordRow>(
          `UPDATE agent_supervision_records
             SET status = 'terminated', updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'waiting_termination'
           RETURNING *`,
          [ctx.tenantId, record.id, at],
        );
        const row = updated.rows[0];
        if (row === undefined) return null;
        await appendEvent(tx, ctx, {
          supervisionId: row.id,
          agentId: row.agent_id,
          sessionId,
          kind: 'termination_applied',
          detail: `the cited agent-evaluation lifecycle decision '${decision.id}' was applied — the organizational actor's supervision is terminated (the agent definition was disabled through the agents contract by that decision's settlement)`,
          data: { decisionId: decision.id },
        });
        return outcome(
          record.agentId,
          'termination_settled',
          'terminated',
          `termination applied per lifecycle decision '${decision.id}'`,
        );
      });
    }

    if (decision.status === 'refused') {
      return getDb().transaction(async (tx) => {
        const nextReviewAt = new Date(
          nextReviewAfterCompletion(at.getTime(), record.reviewIntervalSeconds),
        );
        const updated = await tx.query<RecordRow>(
          `UPDATE agent_supervision_records
             SET status = 'active', termination_decision_id = NULL,
                 next_review_at = $4, updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'waiting_termination'
           RETURNING *`,
          [ctx.tenantId, record.id, at, nextReviewAt],
        );
        const row = updated.rows[0];
        if (row === undefined) return null;
        await appendEvent(tx, ctx, {
          supervisionId: row.id,
          agentId: row.agent_id,
          sessionId,
          kind: 'termination_refused',
          detail: `the cited agent-evaluation lifecycle decision '${decision.id}' was refused — the actor continues under supervision with a fresh review cadence`,
          data: { decisionId: decision.id },
        });
        return outcome(
          record.agentId,
          'termination_settled',
          'active',
          `termination refused per lifecycle decision '${decision.id}' — the actor continues`,
        );
      });
    }

    // Still pending (or approved-but-unapplied): the W024 settlement
    // pump owns that transition — nothing for this unit to do.
    return null;
  };
}

/** Unit 2 — enforce suspension/termination on live supervised work. */
function cancelLiveWorkUnit(ctx: TenantContext, sessionId: string | null): PumpUnit {
  return async (record) => {
    if (record.status !== 'suspended' && record.status !== 'terminated') return null;

    for (const status of ['awaiting_approval', 'queued'] as const) {
      const executions = await listAgentExecutions(ctx, {
        agentId: record.agentId,
        status,
        limit: EVIDENCE_SCAN_LIMIT,
      });
      const supervised = executions.filter((execution) =>
        isSupervisedExecution(execution.causationId, record.id),
      );
      for (const target of supervised) {
        try {
          await cancelAgentExecution(ctx, {
            executionId: target.id,
            reason:
              record.status === 'terminated'
                ? `agent supervision terminated — supervised execution cancelled by enforcement`
                : `agent supervision suspended — supervised execution cancelled by enforcement`,
          });
        } catch (error) {
          if (error instanceof AgentsError && error.code === 'not_cancellable') {
            continue; // raced to a terminal state — nothing to enforce
          }
          throw error;
        }
        await appendEvent(getDb(), ctx, {
          supervisionId: record.id,
          agentId: record.agentId,
          sessionId,
          kind: 'live_work_cancelled',
          detail: `live supervised execution '${target.id}' cancelled by ${record.status} enforcement (through the agents module's public contract)`,
          data: { executionId: target.id, supervisionStatus: record.status },
        });
        return outcome(
          record.agentId,
          'live_work_cancelled',
          record.status,
          `cancelled live supervised execution '${target.id}' (${record.status} enforcement)`,
        );
      }
    }
    return null;
  };
}

/** Unit 3 — fire a due review (active → waiting_review, exactly once). */
function reviewDueUnit(ctx: TenantContext, sessionId: string | null, at: Date): PumpUnit {
  return async (record) => {
    if (record.status !== 'active' || !isReviewDue(record.nextReviewAt, at.getTime())) {
      return null;
    }
    return getDb().transaction(async (tx) => {
      const updated = await tx.query<RecordRow>(
        `UPDATE agent_supervision_records
           SET status = 'waiting_review', updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND next_review_at <= $3
         RETURNING *`,
        [ctx.tenantId, record.id, at, at],
      );
      const row = updated.rows[0];
      if (row === undefined) return null;
      await appendEvent(tx, ctx, {
        supervisionId: row.id,
        agentId: row.agent_id,
        sessionId,
        kind: 'review_due',
        detail: `the review schedule lapsed — the actor waits for the owner to complete the review (supervised work is not admitted while waiting)`,
        data: { dueAt: record.nextReviewAt },
      });
      return outcome(
        record.agentId,
        'review_due',
        'waiting_review',
        `review fired (was due ${record.nextReviewAt}) — the actor waits for completeSupervisionReview`,
      );
    });
  };
}

/** Unit 4 — ledger ONE un-ledgered W021 attempt into the budget (exactly once). */
function budgetConsumptionUnit(ctx: TenantContext, sessionId: string | null, at: Date): PumpUnit {
  return async (record) => {
    const executions = await listAgentExecutions(ctx, {
      agentId: record.agentId,
      limit: BUDGET_SCAN_EXECUTION_LIMIT,
    });
    // Chronological order (the contract lists newest-first): the oldest
    // un-ledgered attempt is ledgered first, so spend converges in
    // submission order across restarts.
    const chronological = [...executions].reverse();
    for (const execution of chronological) {
      const attempts = await listAgentExecutionAttempts(ctx, { executionId: execution.id });
      if (attempts.length === 0) continue;
      const ledgered = await getDb().query<{ attempt_id: string }>(
        `SELECT attempt_id FROM agent_supervision_budget_entries
          WHERE tenant_id = $1 AND execution_id = $2`,
        [ctx.tenantId, execution.id],
      );
      const seen = new Set(ledgered.rows.map((row) => row.attempt_id));
      const unledgered = attempts.filter((attempt) => !seen.has(attempt.id));
      if (unledgered.length === 0) continue;
      const attempt = unledgered[0]!;

      const result = await getDb().transaction(async (tx) => {
        const inserted = await tx.query<BudgetEntryRow>(
          `INSERT INTO agent_supervision_budget_entries (
             tenant_id, supervision_id, agent_id, execution_id, attempt_id,
             cost_minor, cost_currency, recorded_by, recorded_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8)
           ON CONFLICT (tenant_id, attempt_id) DO NOTHING
           RETURNING *`,
          [
            ctx.tenantId,
            record.id,
            record.agentId,
            execution.id,
            attempt.id,
            attempt.costMinor,
            ctx.principalId,
            at,
          ],
        );
        if (inserted.rows[0] === undefined) return null; // a racing pump won
        const updated = await tx.query<RecordRow>(
          `UPDATE agent_supervision_records
             SET budget_spent_minor = budget_spent_minor + $3, updated_at = $4
           WHERE tenant_id = $1 AND id = $2
           RETURNING *`,
          [ctx.tenantId, record.id, attempt.costMinor, at],
        );
        await appendEvent(tx, ctx, {
          supervisionId: record.id,
          agentId: record.agentId,
          sessionId,
          kind: 'budget_consumed',
          detail: `attempt '${attempt.id}' of execution '${execution.id}' ledgered for ${attempt.costMinor} minor units`,
          data: { attemptId: attempt.id, executionId: execution.id, costMinor: attempt.costMinor },
        });
        return mapRecord(updated.rows[0]!);
      });
      if (result === null) continue; // raced — try the next candidate
      return outcome(
        record.agentId,
        'budget_consumed',
        result.status,
        `ledgered attempt '${attempt.id}' (${attempt.costMinor} minor) — spend is now ${result.budgetSpentMinor}`,
      );
    }
    return null;
  };
}

/** Unit 5 — fire budget exhaustion (active → paused_budget, exactly once). */
function budgetExhaustionUnit(ctx: TenantContext, sessionId: string | null, at: Date): PumpUnit {
  return async (record) => {
    if (record.status !== 'active' || !isBudgetExhausted(record)) return null;
    return getDb().transaction(async (tx) => {
      const updated = await tx.query<RecordRow>(
        `UPDATE agent_supervision_records
           SET status = 'paused_budget', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'active'
           AND budget_minor IS NOT NULL AND budget_spent_minor >= budget_minor
         RETURNING *`,
        [ctx.tenantId, record.id, at],
      );
      const row = updated.rows[0];
      if (row === undefined) return null;
      await appendEvent(tx, ctx, {
        supervisionId: row.id,
        agentId: row.agent_id,
        sessionId,
        kind: 'budget_exhausted',
        detail: `ledgered spend ${record.budgetSpentMinor} reached the envelope ${record.budgetMinor} — the actor pauses until a budget grant`,
        data: { envelopeMinor: record.budgetMinor, spentMinor: record.budgetSpentMinor },
      });
      return outcome(
        record.agentId,
        'budget_exhausted',
        'paused_budget',
        `budget exhausted (spent ${record.budgetSpentMinor} of ${record.budgetMinor}) — waiting for grantSupervisionBudget`,
      );
    });
  };
}

/** Unit 6 — refresh a stale health observation. */
function healthObservationUnit(ctx: TenantContext, sessionId: string | null, at: Date): PumpUnit {
  return async (record) => {
    if (record.status === 'terminated') return null;
    if (!isHealthObservationDue(record, record.healthIntervalSeconds, at.getTime())) return null;
    const refreshed = await observeSupervisedAgentHealth(ctx, { agentId: record.agentId });
    return outcome(
      record.agentId,
      'health_observed',
      refreshed.status,
      `health observed: ${refreshed.healthState} (${refreshed.healthDetail})`,
    );
  };
}
