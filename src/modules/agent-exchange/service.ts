// Implementation of the agent-exchange module's public operations (see
// contract.ts).
//
// W136 — Agent Exchange + Execution Plan + Cross-Agent Relay (spec/
// work-items/WORK-ITEM-CATALOG.md §W136): the durable orchestration
// projection linking goal → tasks → agent organization → handoffs →
// approvals → execution runs → results/outcomes. Everything here is a
// RECORD or a READ — the "no second execution authority" acceptance law
// is structural: no operation submits, dispatches, retries or cancels
// an agents-module execution, installs a marketplace package, recruits
// an agent or decides an approval. Those authorities stay with the
// agents module (W021), the marketplace (W028), agent recruitment
// (W022) and the actions matrix (W009); the exchange PROVES its links
// against their real records at write time and then holds the durable
// projection.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding — the house law at
// src/modules/agents/service.ts:1325-1331): PGlite is single-connection,
// so a base-connection read inside an open `db.transaction(...)` starves
// the embedded database. EVERY cross-module read (goals, context,
// info-strategy, org-lab, agent-teams, agent-body, agents, marketplace,
// agent-recruitment, actions, learning — all of which execute on the
// base connection through their own getDb()) and every evidence gate
// therefore runs BEFORE the transaction opens; each mutation then keeps
// its append + lifecycle transitions atomic in ONE transaction whose
// statements touch only this module's tables:
//
//   * createExecutionPlan — every link gate first (goal ACTIVE +
//     version snapshot, fingerprint readable + goal-matched, strategy
//     readable, recommendation readable + goal-matched, team ACTIVE,
//     member refs per kind, recruitment provenance approved), then ONE
//     transaction appending the plan pointer + every task row + every
//     member row;
//   * completeExecutionPlan / abandonExecutionPlan — uniform not-found
//     + lifecycle pre-checks on the base connection, then ONE
//     transaction re-checking the one-way transition under a FOR UPDATE
//     row lock (the immutable-version staleness re-check — a racing
//     transition that committed first owns the terminal state);
//   * recordHandoff / recordApproval / recordExecutionRun — every gate
//     first (plan readable and, for handoffs/runs, ACTIVE; task/member
//     keys resolved against the plan's own immutable decomposition; the
//     routed context package validated goal-matched and plan-coherent;
//     the W021 execution readable and assignee-governed; the action
//     request readable and TERMINAL; the outcome link readable and
//     OPEN), then a SINGLE append (one INSERT — atomic by itself, the
//     registerCandidate precedent). The plan-ACTIVE check is
//     deliberately pre-statement, not under a lock: a run or handoff
//     landing in the instant a concurrent abandonment commits is still
//     honest evidence about a real execution/relay (recorded honestly,
//     never rewritten) — the lifecycle law governs the PROJECTION's
//     spine, not the append-only evidence tail.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by newId(); semantic
// timestamps come from the injectable clock and are never
// caller-supplied; principals (`createdBy`, `recordedBy`) are
// system-captured from the explicit TenantContext; every statement is
// scoped by tenant (ADR-0001) — cross-tenant access is indistinguishable
// from missing records (uniform typed not-found, no existence leak).
//
// Deterministic orders (test-locked): plans newest first (created_at
// DESC, id DESC); tasks by their monotonic position; members by
// member_key ASC; handoffs, approvals and runs by (recorded_at ASC,
// id ASC) — the evidence-timeline order.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getGoal, GoalsError } from '@/modules/goals/contract';
import { getFingerprint, ContextError } from '@/modules/context/contract';
import { getStrategy, InfoStrategyError } from '@/modules/info-strategy/contract';
import { getRecommendation, OrgLabError } from '@/modules/org-lab/contract';
import { getTeam, AgentTeamsError } from '@/modules/agent-teams/contract';
import { AgentBodyError, getAgentBody } from '@/modules/agent-body/contract';
import { getAgent, getAgentExecution, AgentsError } from '@/modules/agents/contract';
import { getPackage, MarketplaceError } from '@/modules/marketplace/contract';
import {
  getRecruitmentProposal,
  AgentRecruitmentError,
} from '@/modules/agent-recruitment/contract';
import { getActionRequest, ActionsError } from '@/modules/actions/contract';
import { getOutcome, LearningError } from '@/modules/learning/contract';
import { AgentExchangeError } from './errors';
import {
  assertAgentExchangeTenantContext,
  validateAbandonExecutionPlanInput,
  validateCompleteExecutionPlanInput,
  validateCreateExecutionPlanInput,
  validateGetExecutionPlanQuery,
  validateListApprovalsQuery,
  validateListExecutionPlansQuery,
  validateListExecutionRunsQuery,
  validateListHandoffsQuery,
  validateRecordApprovalInput,
  validateRecordExecutionRunInput,
  validateRecordHandoffInput,
} from './validation';
import type {
  ValidatedAbandonExecutionPlanInput,
  ValidatedCompleteExecutionPlanInput,
  ValidatedContextPackage,
  ValidatedCreateExecutionPlanInput,
  ValidatedMember,
  ValidatedRecordApprovalInput,
  ValidatedRecordExecutionRunInput,
  ValidatedRecordHandoffInput,
} from './validation';
import type {
  AbandonExecutionPlanInput,
  ApprovalDecisionSnapshot,
  CompleteExecutionPlanInput,
  ContextPackage,
  CreateExecutionPlanInput,
  ExecutionPlan,
  ExecutionPlanSummary,
  ExecutionRun,
  ExchangeMember,
  GetExecutionPlanQuery,
  ListApprovalsQuery,
  ListExecutionPlansQuery,
  ListExecutionRunsQuery,
  ListHandoffsQuery,
  PlanApproval,
  PlanTask,
  RecordApprovalInput,
  RecordExecutionRunInput,
  RecordHandoffInput,
  RelayHandoff,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface PlanRow extends DbRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  goal_version: number | string;
  fingerprint_id: string | null;
  strategy_id: string | null;
  recommendation_id: string | null;
  team_id: string | null;
  objective: string;
  status: string;
  note: string | null;
  created_by: string;
  created_at: Date | string;
  completed_at: Date | string | null;
  abandoned_at: Date | string | null;
  lifecycle_note: string | null;
}

interface TaskRow extends DbRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  task_key: string;
  title: string;
  detail: string | null;
  depends_on: string[];
  assignee_member_key: string | null;
  position: number | string;
}

interface MemberRow extends DbRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  member_key: string;
  kind: string;
  role: string;
  ref: string | null;
  label: string | null;
  recruitment_proposal_id: string | null;
}

interface HandoffRow extends DbRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  task_key: string;
  from_member_key: string;
  to_member_key: string;
  context: ContextPackage;
  note: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

interface ApprovalRow extends DbRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  task_key: string | null;
  action_request_id: string;
  decision: ApprovalDecisionSnapshot;
  recorded_by: string;
  recorded_at: Date | string;
}

interface RunRow extends DbRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  task_key: string;
  agent_id: string;
  agent_execution_id: string;
  context: ContextPackage;
  execution_status: string;
  result_summary: string | null;
  cost_minor: number | string;
  attempts_count: number | string;
  execution_completed_at: Date | string | null;
  outcome_id: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toCount(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapTask(row: TaskRow): PlanTask {
  return {
    taskId: row.id,
    taskKey: row.task_key,
    title: row.title,
    detail: row.detail,
    dependsOn: row.depends_on ?? [],
    assigneeMemberKey: row.assignee_member_key,
    position: toCount(row.position),
  };
}

function mapMember(row: MemberRow): ExchangeMember {
  return {
    memberKey: row.member_key,
    kind: row.kind as ExchangeMember['kind'],
    role: row.role,
    ref: row.ref,
    label: row.label,
    recruitmentProposalId: row.recruitment_proposal_id,
  };
}

function mapHandoff(row: HandoffRow): RelayHandoff {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    taskKey: row.task_key,
    fromMemberKey: row.from_member_key,
    toMemberKey: row.to_member_key,
    context: {
      fingerprintId: row.context?.fingerprintId ?? null,
      evidenceRefs: row.context?.evidenceRefs ?? [],
      note: row.context?.note ?? null,
    },
    note: row.note,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapApproval(row: ApprovalRow): PlanApproval {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    taskKey: row.task_key,
    decision: row.decision,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapRun(row: RunRow): ExecutionRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    taskKey: row.task_key,
    agentId: row.agent_id,
    agentExecutionId: row.agent_execution_id,
    context: {
      fingerprintId: row.context?.fingerprintId ?? null,
      evidenceRefs: row.context?.evidenceRefs ?? [],
      note: row.context?.note ?? null,
    },
    executionStatus: row.execution_status as ExecutionRun['executionStatus'],
    resultSummary: row.result_summary,
    costMinor: toCount(row.cost_minor),
    attemptsCount: toCount(row.attempts_count),
    executionCompletedAt:
      row.execution_completed_at === null ? null : toIso(row.execution_completed_at),
    outcomeId: row.outcome_id,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// Tenant-scoped loaders (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function findPlanRow(
  db: Queryable,
  ctx: TenantContext,
  planId: string,
  forUpdate: boolean,
): Promise<PlanRow | null> {
  const result = await db.query<PlanRow>(
    `SELECT * FROM execution_plans WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, planId],
  );
  return result.rows[0] ?? null;
}

async function loadPlanRow(
  db: Queryable,
  ctx: TenantContext,
  planId: string,
  forUpdate: boolean,
): Promise<PlanRow> {
  const row = await findPlanRow(db, ctx, planId, forUpdate);
  if (row === null) {
    throw new AgentExchangeError(
      'plan_not_found',
      `no execution plan '${planId}' exists in this tenant`,
    );
  }
  return row;
}

async function loadTaskRows(
  db: Queryable,
  ctx: TenantContext,
  planId: string,
): Promise<TaskRow[]> {
  const result = await db.query<TaskRow>(
    `SELECT * FROM execution_plan_tasks
       WHERE tenant_id = $1 AND plan_id = $2
       ORDER BY position ASC`,
    [ctx.tenantId, planId],
  );
  return result.rows;
}

async function loadMemberRows(
  db: Queryable,
  ctx: TenantContext,
  planId: string,
): Promise<MemberRow[]> {
  const result = await db.query<MemberRow>(
    `SELECT * FROM execution_plan_members
       WHERE tenant_id = $1 AND plan_id = $2
       ORDER BY member_key ASC`,
    [ctx.tenantId, planId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Cross-module evidence gates — ALWAYS before a transaction/append (see
// the header's transaction-discipline law). Failure posture: a missing,
// foreign or unreadable reference reads uniformly as its typed
// not-found code, never leaking existence (the org-lab discipline).
// ---------------------------------------------------------------------------

/**
 * The subject goal must exist and be ACTIVE in this tenant. Returns the
 * goal so callers can snapshot its current version (the §11-style
 * revision pin).
 */
async function requireActiveGoal(
  ctx: TenantContext,
  goalId: string,
): Promise<{ version: number }> {
  let goal;
  try {
    goal = await getGoal(ctx, goalId);
  } catch (error) {
    if (error instanceof GoalsError) {
      throw new AgentExchangeError(
        'goal_not_found',
        `goal '${goalId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (goal.content.status !== 'active') {
    throw new AgentExchangeError(
      'goal_not_found',
      `goal '${goalId}' is ${goal.content.status} — the exchange serves current direction only`,
    );
  }
  return { version: goal.version };
}

/**
 * A context fingerprint must be readable in this tenant AND derived FOR
 * the subject goal — routing goal G's work on goal H's context is
 * incoherent (W134 owns derivation; this layer only consumes).
 */
async function requireFingerprintForGoal(
  ctx: TenantContext,
  fingerprintId: string,
  goalId: string,
): Promise<void> {
  let fingerprint;
  try {
    fingerprint = await getFingerprint(ctx, { fingerprintId });
  } catch (error) {
    if (error instanceof ContextError) {
      throw new AgentExchangeError(
        'fingerprint_not_found',
        `context fingerprint '${fingerprintId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (fingerprint.goalId !== goalId) {
    throw new AgentExchangeError(
      'fingerprint_goal_mismatch',
      `context fingerprint '${fingerprintId}' was derived for a different goal — route work on a fingerprint of goal '${goalId}'`,
    );
  }
}

/**
 * The context package routed with a handoff or run (acceptance law 2):
 * when it carries a fingerprint, the fingerprint must be readable,
 * goal-matched to the plan's goal, AND — when the plan itself is
 * conditioned on a fingerprint — the SAME one (routing a plan's work on
 * a divergent context is incoherent with the plan's declared
 * conditioning). An absent fingerprint is legal: the minimal package
 * may be evidence-only.
 */
async function requireRoutedContext(
  ctx: TenantContext,
  context: ValidatedContextPackage,
  plan: PlanRow,
): Promise<void> {
  if (context.fingerprintId === null) return;
  await requireFingerprintForGoal(ctx, context.fingerprintId, plan.goal_id);
  if (plan.fingerprint_id !== null && context.fingerprintId !== plan.fingerprint_id) {
    throw new AgentExchangeError(
      'fingerprint_plan_mismatch',
      `the routed context fingerprint '${context.fingerprintId}' differs from the fingerprint the plan is conditioned on — route this plan's work on its own context`,
    );
  }
}

/** The optional W134 info-strategy link must be readable (opaque after). */
async function requireStrategy(ctx: TenantContext, strategyId: string): Promise<void> {
  try {
    await getStrategy(ctx, { strategyId });
  } catch (error) {
    if (error instanceof InfoStrategyError) {
      throw new AgentExchangeError(
        'strategy_not_found',
        `info strategy '${strategyId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/**
 * The optional W135 org-lab recommendation link must be readable AND
 * recorded for the SAME goal the plan executes — a plan executing goal G
 * on an organization recommended for goal H is incoherent.
 */
async function requireRecommendationForGoal(
  ctx: TenantContext,
  recommendationId: string,
  goalId: string,
): Promise<void> {
  let recommendation;
  try {
    recommendation = await getRecommendation(ctx, { recommendationId });
  } catch (error) {
    if (error instanceof OrgLabError) {
      throw new AgentExchangeError(
        'recommendation_not_found',
        `org-lab recommendation '${recommendationId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (recommendation.goalId !== goalId) {
    throw new AgentExchangeError(
      'recommendation_goal_mismatch',
      `org-lab recommendation '${recommendationId}' was recorded for a different goal — execute goal '${goalId}' on an organization recommended for it`,
    );
  }
}

/** The optional W023 agent-team link must be readable and ACTIVE. */
async function requireActiveTeam(ctx: TenantContext, teamId: string): Promise<void> {
  let team;
  try {
    team = await getTeam(ctx, { teamId });
  } catch (error) {
    if (error instanceof AgentTeamsError) {
      throw new AgentExchangeError(
        'team_not_found',
        `agent team '${teamId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (team.status !== 'active') {
    throw new AgentExchangeError(
      'team_not_found',
      `agent team '${teamId}' is ${team.status} — a fresh plan organizes on active teams`,
    );
  }
}

/**
 * The governed member references (acceptance law 1 + the org-lab §5
 * seam): agent-body refs validate readable + ACTIVE through the
 * agent-body contract (W133); tenant-agent refs validate readable +
 * ACTIVE through the agents contract (W021); marketplace package refs
 * validate visible + INSTALLABLE through the marketplace contract (W028
 * — locks 26/27); human capabilities and external specialists stay
 * opaque (their registries own them). Every member's recruitment
 * provenance, when present, must reference a readable AND APPROVED
 * agent-recruitment proposal (W022) — the exchange records
 * organizations formed through real approved acquisitions only.
 */
async function validateMemberRefs(
  ctx: TenantContext,
  members: readonly ValidatedMember[],
): Promise<void> {
  for (const member of members) {
    if (member.kind === 'agent-body') {
      let body;
      try {
        body = await getAgentBody(ctx, { bodyId: member.ref! });
      } catch (error) {
        if (error instanceof AgentBodyError) {
          throw new AgentExchangeError(
            'body_ref_not_found',
            `organization member '${member.memberKey}' references a body that is not available in this tenant to this principal`,
          );
        }
        throw error;
      }
      if (body.status !== 'active') {
        throw new AgentExchangeError(
          'body_ref_inactive',
          `organization member '${member.memberKey}' references a retired body — a fresh organization references live bodies`,
        );
      }
    } else if (member.kind === 'tenant-agent') {
      let agent;
      try {
        agent = await getAgent(ctx, { agentId: member.ref! });
      } catch (error) {
        if (error instanceof AgentsError) {
          throw new AgentExchangeError(
            'agent_ref_not_found',
            `organization member '${member.memberKey}' references an agent that is not available in this tenant to this principal`,
          );
        }
        throw error;
      }
      if (agent.status !== 'active') {
        throw new AgentExchangeError(
          'agent_ref_inactive',
          `organization member '${member.memberKey}' references a disabled agent`,
        );
      }
    } else if (
      member.kind === 'marketplace-agent-package' ||
      member.kind === 'marketplace-extension-package'
    ) {
      let pkg;
      try {
        pkg = await getPackage(ctx, { packageId: member.ref! });
      } catch (error) {
        if (error instanceof MarketplaceError) {
          throw new AgentExchangeError(
            'marketplace_ref_not_found',
            `organization member '${member.memberKey}' references a marketplace package that is not available to this tenant`,
          );
        }
        throw error;
      }
      if (pkg.state !== 'INSTALLABLE') {
        throw new AgentExchangeError(
          'marketplace_ref_not_found',
          `organization member '${member.memberKey}' references marketplace package '${member.ref}' in state ${pkg.state} — only INSTALLABLE packages may join an organization (platform approval is mandatory)`,
        );
      }
    }

    if (member.recruitmentProposalId !== null) {
      let proposal;
      try {
        proposal = await getRecruitmentProposal(ctx, {
          proposalId: member.recruitmentProposalId,
        });
      } catch (error) {
        if (error instanceof AgentRecruitmentError) {
          throw new AgentExchangeError(
            'recruitment_ref_not_found',
            `organization member '${member.memberKey}' cites a recruitment proposal that is not available in this tenant to this principal`,
          );
        }
        throw error;
      }
      if (proposal.status !== 'approved') {
        throw new AgentExchangeError(
          'recruitment_not_approved',
          `organization member '${member.memberKey}' cites recruitment proposal '${member.recruitmentProposalId}' in status '${proposal.status}' — the exchange records organizations formed through APPROVED acquisitions only`,
        );
      }
    }
  }
}

/**
 * The run's execution reference (acceptance law 3): a REAL agents-module
 * execution, readable in this tenant. Returns the execution so the
 * caller freezes its normalized state verbatim (status, result summary,
 * cost, attempts, completion time) — the canonical result stays owned
 * by the agents module.
 */
async function requireAgentExecution(
  ctx: TenantContext,
  agentExecutionId: string,
): Promise<Awaited<ReturnType<typeof getAgentExecution>>> {
  try {
    return await getAgentExecution(ctx, { executionId: agentExecutionId });
  } catch (error) {
    if (error instanceof AgentsError) {
      throw new AgentExchangeError(
        'execution_not_found',
        `agent execution '${agentExecutionId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/**
 * The governed approval (acceptance law 4, the approvals half): a REAL
 * actions-module request, readable in this tenant, whose status is
 * TERMINAL — the authority system has decided (approved or rejected;
 * both are retained evidence). Returns the frozen decision snapshot,
 * consumed verbatim. A still-pending request refuses: the exchange
 * records decisions, it never anticipates them.
 */
async function requireTerminalActionRequest(
  ctx: TenantContext,
  actionRequestId: string,
): Promise<ApprovalDecisionSnapshot> {
  let request;
  try {
    request = await getActionRequest(ctx, { requestId: actionRequestId });
  } catch (error) {
    if (error instanceof ActionsError) {
      throw new AgentExchangeError(
        'approval_not_found',
        `action request '${actionRequestId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (request.status === 'pending') {
    throw new AgentExchangeError(
      'approval_not_decided',
      `action request '${actionRequestId}' is still pending — the exchange records authority decisions after the authority system makes them`,
    );
  }
  return {
    actionRequestId: request.id,
    actionKind: request.actionKind,
    authorityLevel: request.authorityLevel,
    status: request.status,
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt,
    decidedAt: request.decidedAt ?? request.requestedAt,
  };
}

/**
 * The run's outcome link must be a readable OPEN learning-module outcome
 * — the run commits to its expected value BEFORE realization (the W054
 * prediction-hygiene discipline, the org-lab inheritance). A settled,
 * abandoned, foreign or missing outcome is uniformly
 * `invalid_outcome_ref` (no existence leak).
 */
async function requireOpenOutcome(ctx: TenantContext, outcomeId: string): Promise<void> {
  let outcome;
  try {
    outcome = await getOutcome(ctx, outcomeId);
  } catch (error) {
    if (error instanceof LearningError) {
      throw new AgentExchangeError(
        'invalid_outcome_ref',
        `linked outcome '${outcomeId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (outcome.status !== 'open') {
    throw new AgentExchangeError(
      'invalid_outcome_ref',
      `linked outcome '${outcomeId}' is ${outcome.status} — a run may only commit to outcomes that are still OPEN`,
    );
  }
}

// ---------------------------------------------------------------------------
// createExecutionPlan — the projection's spine
// ---------------------------------------------------------------------------

export async function createExecutionPlan(
  ctx: TenantContext,
  input: CreateExecutionPlanInput,
): Promise<ExecutionPlan> {
  assertAgentExchangeTenantContext(ctx);
  const valid: ValidatedCreateExecutionPlanInput = validateCreateExecutionPlanInput(input);

  // ---- EVERY link gate BEFORE the transaction (the W134/W135 law) ----
  const goal = await requireActiveGoal(ctx, valid.goalId);
  if (valid.fingerprintId !== null) {
    await requireFingerprintForGoal(ctx, valid.fingerprintId, valid.goalId);
  }
  if (valid.strategyId !== null) {
    await requireStrategy(ctx, valid.strategyId);
  }
  if (valid.recommendationId !== null) {
    await requireRecommendationForGoal(ctx, valid.recommendationId, valid.goalId);
  }
  if (valid.teamId !== null) {
    await requireActiveTeam(ctx, valid.teamId);
  }
  await validateMemberRefs(ctx, valid.members);

  const planId = newId();
  const createdAt = now();

  // ---- ONE transaction: pointer + every task row + every member row --
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO execution_plans
         (id, tenant_id, goal_id, goal_version, fingerprint_id, strategy_id,
          recommendation_id, team_id, objective, status, note, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $12)`,
      [
        planId,
        ctx.tenantId,
        valid.goalId,
        goal.version,
        valid.fingerprintId,
        valid.strategyId,
        valid.recommendationId,
        valid.teamId,
        valid.objective,
        valid.note,
        ctx.principalId,
        createdAt,
      ],
    );

    let position = 0;
    for (const task of valid.tasks) {
      position += 1;
      await tx.query(
        `INSERT INTO execution_plan_tasks
           (id, tenant_id, plan_id, task_key, title, detail, depends_on,
            assignee_member_key, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newId(),
          ctx.tenantId,
          planId,
          task.taskKey,
          task.title,
          task.detail,
          task.dependsOn,
          task.assigneeMemberKey,
          position,
        ],
      );
    }

    for (const member of valid.members) {
      await tx.query(
        `INSERT INTO execution_plan_members
           (id, tenant_id, plan_id, member_key, kind, role, ref, label,
            recruitment_proposal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newId(),
          ctx.tenantId,
          planId,
          member.memberKey,
          member.kind,
          member.role,
          member.ref,
          member.label,
          member.recruitmentProposalId,
        ],
      );
    }
  });

  return getExecutionPlan(ctx, { planId });
}

// ---------------------------------------------------------------------------
// completeExecutionPlan / abandonExecutionPlan — the one-way lifecycle
// ---------------------------------------------------------------------------

export async function completeExecutionPlan(
  ctx: TenantContext,
  input: CompleteExecutionPlanInput,
): Promise<ExecutionPlan> {
  assertAgentExchangeTenantContext(ctx);
  const valid: ValidatedCompleteExecutionPlanInput = validateCompleteExecutionPlanInput(input);
  const db = getDb();

  // Pre-transaction: uniform not-found + lifecycle posture.
  const existing = await loadPlanRow(db, ctx, valid.planId, false);
  if (existing.status !== 'active') {
    throw new AgentExchangeError(
      'plan_already_terminal',
      `execution plan '${valid.planId}' is already ${existing.status} — the lifecycle is one-way, terminal`,
    );
  }

  const completedAt = now();

  // ---- ONE transaction: staleness re-check under the lock, stamp -----
  await db.transaction(async (tx) => {
    const row = await loadPlanRow(tx, ctx, valid.planId, true);
    if (row.status !== 'active') {
      // The immutable-version staleness re-check (the W134 lesson): a
      // racing transition that committed first owns the terminal state.
      throw new AgentExchangeError(
        'plan_already_terminal',
        `execution plan '${valid.planId}' is already ${row.status} — the lifecycle is one-way, terminal`,
      );
    }
    await tx.query(
      `UPDATE execution_plans
         SET status = 'completed', completed_at = $3, lifecycle_note = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.planId, completedAt, valid.note],
    );
  });

  return getExecutionPlan(ctx, { planId: valid.planId });
}

export async function abandonExecutionPlan(
  ctx: TenantContext,
  input: AbandonExecutionPlanInput,
): Promise<ExecutionPlan> {
  assertAgentExchangeTenantContext(ctx);
  const valid: ValidatedAbandonExecutionPlanInput = validateAbandonExecutionPlanInput(input);
  const db = getDb();

  const existing = await loadPlanRow(db, ctx, valid.planId, false);
  if (existing.status !== 'active') {
    throw new AgentExchangeError(
      'plan_already_terminal',
      `execution plan '${valid.planId}' is already ${existing.status} — the lifecycle is one-way, terminal`,
    );
  }

  const abandonedAt = now();

  await db.transaction(async (tx) => {
    const row = await loadPlanRow(tx, ctx, valid.planId, true);
    if (row.status !== 'active') {
      throw new AgentExchangeError(
        'plan_already_terminal',
        `execution plan '${valid.planId}' is already ${row.status} — the lifecycle is one-way, terminal`,
      );
    }
    await tx.query(
      `UPDATE execution_plans
         SET status = 'abandoned', abandoned_at = $3, lifecycle_note = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.planId, abandonedAt, valid.reason],
    );
  });

  return getExecutionPlan(ctx, { planId: valid.planId });
}

// ---------------------------------------------------------------------------
// recordHandoff — the cross-agent relay
// ---------------------------------------------------------------------------

export async function recordHandoff(
  ctx: TenantContext,
  input: RecordHandoffInput,
): Promise<RelayHandoff> {
  assertAgentExchangeTenantContext(ctx);
  const valid: ValidatedRecordHandoffInput = validateRecordHandoffInput(input);
  const db = getDb();

  // ---- Gates on the base connection, before the append ----
  const plan = await loadPlanRow(db, ctx, valid.planId, false);
  if (plan.status !== 'active') {
    throw new AgentExchangeError(
      'plan_not_active',
      `execution plan '${valid.planId}' is ${plan.status} — the relay serves in-flight plans only`,
    );
  }
  await requirePlanTask(db, ctx, valid.planId, valid.taskKey);
  await requirePlanMember(db, ctx, valid.planId, valid.fromMemberKey);
  await requirePlanMember(db, ctx, valid.planId, valid.toMemberKey);
  await requireRoutedContext(ctx, valid.context, plan);

  const handoffId = newId();
  const recordedAt = now();
  await db.query(
    `INSERT INTO execution_plan_handoffs
       (id, tenant_id, plan_id, task_key, from_member_key, to_member_key,
        context, note, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
    [
      handoffId,
      ctx.tenantId,
      valid.planId,
      valid.taskKey,
      valid.fromMemberKey,
      valid.toMemberKey,
      JSON.stringify(valid.context),
      valid.note,
      ctx.principalId,
      recordedAt,
    ],
  );

  const row = await db.query<HandoffRow>(
    `SELECT * FROM execution_plan_handoffs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, handoffId],
  );
  return mapHandoff(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// recordApproval — the governed authority record
// ---------------------------------------------------------------------------

export async function recordApproval(
  ctx: TenantContext,
  input: RecordApprovalInput,
): Promise<PlanApproval> {
  assertAgentExchangeTenantContext(ctx);
  const valid: ValidatedRecordApprovalInput = validateRecordApprovalInput(input);
  const db = getDb();

  // ---- Gates on the base connection, before the append ----
  await loadPlanRow(db, ctx, valid.planId, false);
  if (valid.taskKey !== null) {
    await requirePlanTask(db, ctx, valid.planId, valid.taskKey);
  }
  const decision = await requireTerminalActionRequest(ctx, valid.actionRequestId);

  const approvalId = newId();
  const recordedAt = now();
  await db.query(
    `INSERT INTO execution_plan_approvals
       (id, tenant_id, plan_id, task_key, action_request_id, decision,
        recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      approvalId,
      ctx.tenantId,
      valid.planId,
      valid.taskKey,
      valid.actionRequestId,
      JSON.stringify(decision),
      ctx.principalId,
      recordedAt,
    ],
  );

  const row = await db.query<ApprovalRow>(
    `SELECT * FROM execution_plan_approvals WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, approvalId],
  );
  return mapApproval(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// recordExecutionRun — progress/results through normalized contracts
// ---------------------------------------------------------------------------

export async function recordExecutionRun(
  ctx: TenantContext,
  input: RecordExecutionRunInput,
): Promise<ExecutionRun> {
  assertAgentExchangeTenantContext(ctx);
  const valid: ValidatedRecordExecutionRunInput = validateRecordExecutionRunInput(input);
  const db = getDb();

  // ---- Gates on the base connection, before the append ----
  const plan = await loadPlanRow(db, ctx, valid.planId, false);
  if (plan.status !== 'active') {
    throw new AgentExchangeError(
      'plan_not_active',
      `execution plan '${valid.planId}' is ${plan.status} — execution observations serve in-flight plans only`,
    );
  }
  const task = await requirePlanTask(db, ctx, valid.planId, valid.taskKey);

  // Assignee governance: when the task's slot names a tenant-agent
  // member, the referenced execution must belong to THAT agent — runs
  // serve the organization the plan declared, not arbitrary agents.
  let assigneeAgentId: string | null = null;
  if (task.assignee_member_key !== null) {
    const member = await requirePlanMember(db, ctx, valid.planId, task.assignee_member_key);
    if (member.kind === 'tenant-agent' && member.ref !== null) {
      assigneeAgentId = member.ref;
    }
  }

  const execution = await requireAgentExecution(ctx, valid.agentExecutionId);
  if (assigneeAgentId !== null && execution.agentId !== assigneeAgentId) {
    throw new AgentExchangeError(
      'execution_agent_mismatch',
      `the execution belongs to agent '${execution.agentId}' but task '${valid.taskKey}' is assigned to member '${task.assignee_member_key}' (agent '${assigneeAgentId}') — runs serve the plan's declared organization`,
    );
  }

  await requireRoutedContext(ctx, valid.context, plan);
  if (valid.outcomeId !== null) {
    await requireOpenOutcome(ctx, valid.outcomeId);
  }

  // The normalized freeze (acceptance law 3): status, result summary,
  // cost, attempts and completion time consumed VERBATIM from the
  // agents module's contract at record time — the canonical result
  // stays owned there.
  const runId = newId();
  const recordedAt = now();
  await db.query(
    `INSERT INTO execution_plan_runs
       (id, tenant_id, plan_id, task_key, agent_id, agent_execution_id,
        context, execution_status, result_summary, cost_minor, attempts_count,
        execution_completed_at, outcome_id, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      runId,
      ctx.tenantId,
      valid.planId,
      valid.taskKey,
      execution.agentId,
      valid.agentExecutionId,
      JSON.stringify(valid.context),
      execution.status,
      execution.result === null ? null : execution.result.summary,
      execution.costMinor,
      execution.attemptsCount,
      execution.completedAt === null ? null : execution.completedAt,
      valid.outcomeId,
      ctx.principalId,
      recordedAt,
    ],
  );

  const row = await db.query<RunRow>(
    `SELECT * FROM execution_plan_runs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, runId],
  );
  return mapRun(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// Shared plan-scoped resolvers (uniform typed not-founds)
// ---------------------------------------------------------------------------

async function requirePlanTask(
  db: Queryable,
  ctx: TenantContext,
  planId: string,
  taskKey: string,
): Promise<TaskRow> {
  const result = await db.query<TaskRow>(
    `SELECT * FROM execution_plan_tasks
       WHERE tenant_id = $1 AND plan_id = $2 AND task_key = $3`,
    [ctx.tenantId, planId, taskKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AgentExchangeError(
      'task_not_found',
      `task '${taskKey}' does not exist in execution plan '${planId}'`,
    );
  }
  return row;
}

async function requirePlanMember(
  db: Queryable,
  ctx: TenantContext,
  planId: string,
  memberKey: string,
): Promise<MemberRow> {
  const result = await db.query<MemberRow>(
    `SELECT * FROM execution_plan_members
       WHERE tenant_id = $1 AND plan_id = $2 AND member_key = $3`,
    [ctx.tenantId, planId, memberKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AgentExchangeError(
      'member_not_found',
      `organization member '${memberKey}' does not exist in execution plan '${planId}'`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getExecutionPlan(
  ctx: TenantContext,
  query: GetExecutionPlanQuery,
): Promise<ExecutionPlan> {
  assertAgentExchangeTenantContext(ctx);
  const valid = validateGetExecutionPlanQuery(query);
  const db = getDb();
  const plan = await loadPlanRow(db, ctx, valid.planId, false);
  const tasks = await loadTaskRows(db, ctx, valid.planId);
  const members = await loadMemberRows(db, ctx, valid.planId);

  return {
    id: plan.id,
    tenantId: plan.tenant_id,
    goalId: plan.goal_id,
    goalVersion: toCount(plan.goal_version),
    fingerprintId: plan.fingerprint_id,
    strategyId: plan.strategy_id,
    recommendationId: plan.recommendation_id,
    teamId: plan.team_id,
    objective: plan.objective,
    status: plan.status as ExecutionPlan['status'],
    note: plan.note,
    createdBy: plan.created_by,
    createdAt: toIso(plan.created_at),
    completedAt: plan.completed_at === null ? null : toIso(plan.completed_at),
    abandonedAt: plan.abandoned_at === null ? null : toIso(plan.abandoned_at),
    lifecycleNote: plan.lifecycle_note,
    tasks: tasks.map(mapTask),
    members: members.map(mapMember),
  };
}

export async function listExecutionPlans(
  ctx: TenantContext,
  query?: ListExecutionPlansQuery,
): Promise<ExecutionPlanSummary[]> {
  assertAgentExchangeTenantContext(ctx);
  const valid = validateListExecutionPlansQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT p.*,
       (SELECT COUNT(*) FROM execution_plan_tasks t
         WHERE t.tenant_id = p.tenant_id AND t.plan_id = p.id) AS task_count,
       (SELECT COUNT(*) FROM execution_plan_members m
         WHERE m.tenant_id = p.tenant_id AND m.plan_id = p.id) AS member_count
     FROM execution_plans p
     WHERE p.tenant_id = $1`;
  if (valid.goalId !== null) {
    params.push(valid.goalId);
    sql += ` AND p.goal_id = $${params.length}`;
  }
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND p.status = $${params.length}`;
  }
  if (valid.recommendationId !== null) {
    params.push(valid.recommendationId);
    sql += ` AND p.recommendation_id = $${params.length}`;
  }
  params.push(valid.limit);
  // Newest first, deterministic tiebreak.
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;

  const rows = await getDb().query<PlanRow & { task_count: number | string; member_count: number | string }>(
    sql,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    goalVersion: toCount(row.goal_version),
    fingerprintId: row.fingerprint_id,
    recommendationId: row.recommendation_id,
    teamId: row.team_id,
    status: row.status as ExecutionPlanSummary['status'],
    taskCount: toCount(row.task_count),
    memberCount: toCount(row.member_count),
    objective: row.objective,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    abandonedAt: row.abandoned_at === null ? null : toIso(row.abandoned_at),
  }));
}

export async function listExecutionRuns(
  ctx: TenantContext,
  query: ListExecutionRunsQuery,
): Promise<ExecutionRun[]> {
  assertAgentExchangeTenantContext(ctx);
  const valid = validateListExecutionRunsQuery(query);
  const params: unknown[] = [ctx.tenantId, valid.planId];
  let sql = `SELECT * FROM execution_plan_runs
     WHERE tenant_id = $1 AND plan_id = $2`;
  if (valid.taskKey !== null) {
    params.push(valid.taskKey);
    sql += ` AND task_key = $${params.length}`;
  }
  params.push(valid.limit);
  // The evidence-timeline order: oldest first, deterministic tiebreak.
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;

  const rows = await getDb().query<RunRow>(sql, params);
  return rows.rows.map(mapRun);
}

export async function listHandoffs(
  ctx: TenantContext,
  query: ListHandoffsQuery,
): Promise<RelayHandoff[]> {
  assertAgentExchangeTenantContext(ctx);
  const valid = validateListHandoffsQuery(query);
  const params: unknown[] = [ctx.tenantId, valid.planId];
  let sql = `SELECT * FROM execution_plan_handoffs
     WHERE tenant_id = $1 AND plan_id = $2`;
  if (valid.taskKey !== null) {
    params.push(valid.taskKey);
    sql += ` AND task_key = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;

  const rows = await getDb().query<HandoffRow>(sql, params);
  return rows.rows.map(mapHandoff);
}

export async function listApprovals(
  ctx: TenantContext,
  query: ListApprovalsQuery,
): Promise<PlanApproval[]> {
  assertAgentExchangeTenantContext(ctx);
  const valid = validateListApprovalsQuery(query);
  const params: unknown[] = [ctx.tenantId, valid.planId];
  let sql = `SELECT * FROM execution_plan_approvals
     WHERE tenant_id = $1 AND plan_id = $2`;
  if (valid.taskKey !== null) {
    params.push(valid.taskKey);
    sql += ` AND task_key = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;

  const rows = await getDb().query<ApprovalRow>(sql, params);
  return rows.rows.map(mapApproval);
}
