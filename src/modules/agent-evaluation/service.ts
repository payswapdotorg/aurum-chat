// Implementation of the agent-evaluation module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) or by `newId()` where a gate idempotency key
// must exist before the row; timestamps come from the injectable clock
// and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`evaluation_not_found` /
// `decision_not_found`).
//
// W024 acceptance — "Measure outcome, cost, quality, utilization,
// security and replacement options; lifecycle changes follow policy" —
// is carried by these deliberate properties, all tested:
//
//   1. MEASURED, NOT ASSERTED: every number on an evaluation row is
//      computed by measurement.ts from CONTRACT state — the agents
//      module's executions/attempts (W021), the learning module's
//      outcomes (W040) — never from caller input and never from another
//      module's tables. A caller can only name the agent and supply the
//      replacement options' own estimates; the six measured dimensions
//      are minted by the system.
//   2. APPEND-ONLY EVIDENCE: evaluations and replacement options are
//      immutable from birth (storage triggers reject UPDATE/DELETE/
//      TRUNCATE); decisions freeze their substantive content and move
//      only their lifecycle state forward (§24; lock 37).
//   3. POLICY-GATED TERMINATION: every terminate decision passes
//      through the W009 authority matrix — kind 'agent-termination' at
//      level EXECUTE (§20/lock 23) — before anything is applied. The
//      built-in default gates EXECUTE behind a human decision, so out
//      of the box no agent is terminated without one; a tenant may
//      allow or forbid through setAuthorityPolicy. Retain/modify
//      decisions are recorded evidence (their actual mutations flow
//      through the agents module's own claim-gated controls).
//   4. EVIDENCE-LINKED DECISIONS: a decision always cites the measured
//      evaluation it follows from (a FK the storage layer enforces),
//      and a terminate decision may cite exactly one of THAT
//      evaluation's replacement options — never a foreign one.
//   5. THE PUMP DISCIPLINE (lock 36): applying a termination is a
//      separate, idempotent, retryable step (`settleAgentLifecycle-
//      Decision`) that resolves the gate by reading the linked action
//      request, applies the approved change through the agents module's
//      public contract (`updateAgent` → status 'disabled'), and then
//      moves the decision to its terminal 'applied' state. An
//      interrupted apply leaves the decision 'approved' — retrying
//      settle completes it.
//
// Claim-gated writes: recording evaluations is open to tenant members
// (measurement is derived intelligence — lock 34); deciding and applying
// lifecycle changes requires the agents module's 'agents:administer'
// claim (managing the agent workforce is a management action, the W021
// discipline).

import { createHash } from 'node:crypto';
import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  getAgent,
  listAgentExecutionAttempts,
  listAgentExecutions,
  updateAgent,
  MAX_LIST_LIMIT as AGENTS_MAX_LIST_LIMIT,
} from '@/modules/agents/contract';
import { AgentsError } from '@/modules/agents/contract';
import type { AgentDefinition, AgentExecution, AgentExecutionAttempt } from '@/modules/agents/contract';
import {
  authorizeAction,
  getActionRequest,
  listApprovalDecisions,
} from '@/modules/actions/contract';
import { ActionsError } from '@/modules/actions/contract';
import type { ActionRequest, ApprovalDecision } from '@/modules/actions/contract';
import { listOutcomes, LearningError, MAX_LIST_LIMIT as LEARNING_MAX_LIST_LIMIT } from '@/modules/learning/contract';
import type { Outcome } from '@/modules/learning/contract';
import { AgentEvaluationError } from './errors';
import {
  compareReplacementCost,
  computeCostMetrics,
  computeOutcomeMetrics,
  computeQualityMetrics,
  computeSecurityMetrics,
  computeUtilizationMetrics,
  deriveWindow,
} from './measurement';
import {
  AGENT_TERMINATION_ACTION_KIND,
  AGENT_TERMINATION_AUTHORITY_LEVEL,
  canDecideAgentLifecycle,
  AGENTS_AUTHORITY_ADMINISTER,
  isMatrixGated,
  statusForGateOutcome,
} from './policy';
import {
  assertAgentEvaluationTenantContext,
  validateDecideAgentLifecycleInput,
  validateGetAgentEvaluationQuery,
  validateGetAgentLifecycleDecisionQuery,
  validateListAgentEvaluationsQuery,
  validateListAgentLifecycleDecisionsQuery,
  validateRecordAgentEvaluationInput,
  validateSettleAgentLifecycleDecisionInput,
  type ValidatedRecordEvaluationInput,
} from './validation';
import type {
  AgentEvaluation,
  AgentLifecycleDecision,
  AgentSecurityFinding,
  DecisionPolicySnapshot,
  DecideAgentLifecycleInput,
  GetAgentEvaluationQuery,
  GetAgentLifecycleDecisionQuery,
  ListAgentEvaluationsQuery,
  ListAgentLifecycleDecisionsQuery,
  RecordAgentEvaluationInput,
  ReplacementOption,
  SettleAgentLifecycleDecisionInput,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants (re-exported through the contract)
// ---------------------------------------------------------------------------

/** The W009 action kind every agent termination passes through (§20). */
export const AGENT_TERMINATION_KIND = AGENT_TERMINATION_ACTION_KIND;

/** The §20 level a termination is authorized at. */
export const AGENT_TERMINATION_LEVEL = AGENT_TERMINATION_AUTHORITY_LEVEL;

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface EvaluationRow extends DbRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_slug: string;
  agent_role: string;
  agent_provider: string;
  agent_status: string;
  agent_permissions: unknown;
  window_from: Date | string;
  window_to: Date | string;
  outcome_total: number;
  outcome_open: number;
  outcome_settled: number;
  outcome_abandoned: number;
  outcome_met: number;
  outcome_exceeded: number;
  outcome_missed: number;
  outcome_settled_expected_total: number;
  outcome_settled_realized_total: number;
  outcome_net_variance: number;
  cost_executions_included: number;
  cost_executions_truncated: boolean;
  cost_total_minor: string | number;
  cost_currency: string;
  cost_succeeded_minor: string | number;
  cost_per_succeeded_minor: string | number | null;
  cost_attempts_included: number;
  cost_input_tokens_total: string | number | null;
  cost_output_tokens_total: string | number | null;
  cost_operations_total: string | number | null;
  quality_succeeded: number;
  quality_failed: number;
  quality_refused: number;
  quality_cancelled: number;
  quality_terminal_count: number;
  quality_success_rate: number | null;
  quality_dispatch_failed_attempts: number;
  quality_dispatch_rejected_attempts: number;
  quality_result_invalid_attempts: number;
  quality_retryable_attempts: number;
  quality_average_latency_ms: number | null;
  utilization_submissions: number;
  utilization_live: number;
  utilization_distinct_principals: number;
  utilization_distinct_active_days: number;
  utilization_window_days: number;
  utilization_submissions_per_day: number;
  utilization_first_submission_at: Date | string | null;
  utilization_last_submission_at: Date | string | null;
  security_requested_scope_counts: unknown;
  security_over_granted_scopes: unknown;
  security_approval_gated: number;
  security_policy_refusals: number;
  security_approval_rejections: number;
  security_findings: unknown;
  basis_attempts_included: number;
  basis_outcomes_included: number;
  basis_outcomes_truncated: boolean;
  recorded_by: string;
  recorded_at: Date | string;
}

interface OptionRow extends DbRow {
  id: string;
  tenant_id: string;
  evaluation_id: string;
  kind: string;
  summary: string;
  note: string | null;
  estimated_cost_minor: string | number | null;
  estimated_cost_currency: string | null;
  estimated_weeks: number | null;
  recommended: boolean;
  cost_delta_minor: string | number | null;
  cost_comparison: string;
}

interface DecisionRow extends DbRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_slug: string;
  evaluation_id: string;
  change: string;
  rationale: string;
  note: string | null;
  modification_summary: string | null;
  replacement_option_id: string | null;
  status: string;
  action_request_id: string | null;
  policy_outcome: string | null;
  policy_resolved_via: string | null;
  submitted_by: string | null;
  submitted_at: Date | string | null;
  decided_by: string | null;
  decided_by_principal: string | null;
  decided_at: Date | string | null;
  applied_at: Date | string | null;
  applied_by_principal: string | null;
  recorded_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toCount(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toCountOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function mapOption(row: OptionRow): ReplacementOption {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    evaluationId: row.evaluation_id,
    kind: row.kind as ReplacementOption['kind'], // CHECK-constrained
    summary: row.summary,
    note: row.note,
    estimatedCostMinor: toCountOrNull(row.estimated_cost_minor),
    estimatedCostCurrency: row.estimated_cost_currency,
    estimatedWeeks: row.estimated_weeks,
    recommended: row.recommended,
    costDeltaMinor: toCountOrNull(row.cost_delta_minor),
    costComparison: row.cost_comparison as ReplacementOption['costComparison'], // CHECK-constrained
  };
}

function mapEvaluation(row: EvaluationRow, options: readonly OptionRow[]): AgentEvaluation {
  const permissions = Array.isArray(row.agent_permissions)
    ? (row.agent_permissions as string[])
    : [];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agent: {
      slug: row.agent_slug,
      role: row.agent_role,
      provider: row.agent_provider,
      status: row.agent_status,
      permissions: [...permissions],
    },
    windowFrom: toIso(row.window_from),
    windowTo: toIso(row.window_to),
    outcome: {
      outcomesTotal: row.outcome_total,
      open: row.outcome_open,
      settled: row.outcome_settled,
      abandoned: row.outcome_abandoned,
      met: row.outcome_met,
      exceeded: row.outcome_exceeded,
      missed: row.outcome_missed,
      settledExpectedTotal: row.outcome_settled_expected_total,
      settledRealizedTotal: row.outcome_settled_realized_total,
      netVarianceVsExpected: row.outcome_net_variance,
    },
    cost: {
      executionsIncluded: row.cost_executions_included,
      executionsTruncated: row.cost_executions_truncated,
      totalCostMinor: toCount(row.cost_total_minor),
      costCurrency: 'USD',
      succeededCostMinor: toCount(row.cost_succeeded_minor),
      costPerSucceededMinor: toCountOrNull(row.cost_per_succeeded_minor),
      attemptsIncluded: row.cost_attempts_included,
      inputTokensTotal: toCountOrNull(row.cost_input_tokens_total),
      outputTokensTotal: toCountOrNull(row.cost_output_tokens_total),
      operationsTotal: toCountOrNull(row.cost_operations_total),
    },
    quality: {
      succeeded: row.quality_succeeded,
      failed: row.quality_failed,
      refused: row.quality_refused,
      cancelled: row.quality_cancelled,
      terminalCount: row.quality_terminal_count,
      successRate: row.quality_success_rate,
      dispatchFailedAttempts: row.quality_dispatch_failed_attempts,
      dispatchRejectedAttempts: row.quality_dispatch_rejected_attempts,
      resultInvalidAttempts: row.quality_result_invalid_attempts,
      retryableAttempts: row.quality_retryable_attempts,
      averageLatencyMs: row.quality_average_latency_ms,
    },
    utilization: {
      submissions: row.utilization_submissions,
      live: row.utilization_live,
      distinctPrincipals: row.utilization_distinct_principals,
      distinctActiveDays: row.utilization_distinct_active_days,
      windowDays: row.utilization_window_days,
      submissionsPerDay: row.utilization_submissions_per_day,
      firstSubmissionAt:
        row.utilization_first_submission_at === null
          ? null
          : toIso(row.utilization_first_submission_at),
      lastSubmissionAt:
        row.utilization_last_submission_at === null ? null : toIso(row.utilization_last_submission_at),
    },
    security: {
      grantedPermissions: [...permissions],
      requestedScopeCounts:
        row.security_requested_scope_counts !== null &&
        typeof row.security_requested_scope_counts === 'object'
          ? { ...(row.security_requested_scope_counts as Record<string, number>) }
          : {},
      overGrantedScopes: Array.isArray(row.security_over_granted_scopes)
        ? [...(row.security_over_granted_scopes as string[])]
        : [],
      approvalGated: row.security_approval_gated,
      policyRefusals: row.security_policy_refusals,
      approvalRejections: row.security_approval_rejections,
      findings: Array.isArray(row.security_findings)
        ? [...(row.security_findings as AgentSecurityFinding[])]
        : [],
    },
    basis: {
      executionsIncluded: row.cost_executions_included,
      attemptsIncluded: row.basis_attempts_included,
      outcomesIncluded: row.basis_outcomes_included,
      executionsTruncated: row.cost_executions_truncated,
      outcomesTruncated: row.basis_outcomes_truncated,
    },
    replacementOptions: options.map(mapOption),
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapDecision(row: DecisionRow): AgentLifecycleDecision {
  const gated = row.action_request_id !== null;
  const policy: DecisionPolicySnapshot | null = gated
    ? {
        actionRequestId: row.action_request_id!,
        policyOutcome: row.policy_outcome as DecisionPolicySnapshot['policyOutcome'], // CHECK-constrained
        policyResolvedVia: row.policy_resolved_via as DecisionPolicySnapshot['policyResolvedVia'], // CHECK-constrained
        submittedBy: row.submitted_by!,
        submittedAt: toIso(row.submitted_at!),
        decidedBy: (row.decided_by ?? null) as DecisionPolicySnapshot['decidedBy'],
        decidedByPrincipal: row.decided_by_principal,
        decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
      }
    : null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentSlug: row.agent_slug,
    evaluationId: row.evaluation_id,
    change: row.change as AgentLifecycleDecision['change'], // CHECK-constrained
    rationale: row.rationale,
    note: row.note,
    modificationSummary: row.modification_summary,
    replacementOptionId: row.replacement_option_id,
    status: row.status as AgentLifecycleDecision['status'], // CHECK-constrained
    policy,
    appliedAt: row.applied_at === null ? null : toIso(row.applied_at),
    appliedByPrincipal: row.applied_by_principal,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Cross-module reads (contract-only — never another module's tables)
// ---------------------------------------------------------------------------

/**
 * Reads one agent through the agents contract (the sanctioned W021
 * surface): a missing, malformed or foreign-tenant agent id is uniformly
 * `agent_not_found` (the agents module's own discipline, surfaced as
 * this module's).
 */
async function readAgent(
  ctx: TenantContext,
  agentId: string,
): Promise<AgentDefinition> {
  try {
    return await getAgent(ctx, { agentId });
  } catch (error) {
    if (error instanceof AgentsError) {
      if (error.code === 'agent_not_found') {
        throw new AgentEvaluationError(
          'agent_not_found',
          `no agent '${agentId}' exists in this tenant`,
        );
      }
      if (error.code === 'invalid_context') {
        throw new AgentEvaluationError('invalid_context', error.message);
      }
      if (error.code === 'invalid_query') {
        throw new AgentEvaluationError('invalid_query', error.message);
      }
      throw new Error(
        `the agents contract rejected an agent read (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** The agent's executions through the agents contract (most recent first, ceiling-bounded). */
async function readAgentExecutions(
  ctx: TenantContext,
  agentId: string,
): Promise<AgentExecution[]> {
  try {
    return await listAgentExecutions(ctx, { agentId, limit: AGENTS_MAX_LIST_LIMIT });
  } catch (error) {
    if (error instanceof AgentsError && error.code === 'invalid_query') {
      throw new AgentEvaluationError('invalid_query', error.message);
    }
    throw error;
  }
}

/** One execution's append-only attempt evidence through the agents contract. */
async function readExecutionAttempts(
  ctx: TenantContext,
  executionId: string,
): Promise<AgentExecutionAttempt[]> {
  try {
    return await listAgentExecutionAttempts(ctx, { executionId });
  } catch (error) {
    if (error instanceof AgentsError && error.code === 'execution_not_found') {
      // The execution was readable a moment ago; attempts are append-only.
      throw new Error(
        `execution '${executionId}' is no longer readable while its attempts are being measured (internal invariant violation)`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** The outcomes tied to this agent through the learning contract (W040). */
async function readAgentOutcomes(ctx: TenantContext, agentId: string): Promise<Outcome[]> {
  try {
    return await listOutcomes(ctx, {
      subjectKind: 'agent',
      subjectId: agentId,
      limit: LEARNING_MAX_LIST_LIMIT,
    });
  } catch (error) {
    if (error instanceof LearningError) {
      throw new Error(
        `the learning contract rejected an outcome listing (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// recordAgentEvaluation (the measurement)
// ---------------------------------------------------------------------------

const EVALUATION_INSERT_SQL = `INSERT INTO agent_evaluations (
  tenant_id, agent_id, agent_slug, agent_role, agent_provider, agent_status,
  agent_permissions, window_from, window_to,
  outcome_total, outcome_open, outcome_settled, outcome_abandoned,
  outcome_met, outcome_exceeded, outcome_missed,
  outcome_settled_expected_total, outcome_settled_realized_total, outcome_net_variance,
  cost_executions_included, cost_executions_truncated, cost_total_minor,
  cost_currency, cost_succeeded_minor, cost_per_succeeded_minor,
  cost_attempts_included, cost_input_tokens_total, cost_output_tokens_total, cost_operations_total,
  quality_succeeded, quality_failed, quality_refused, quality_cancelled,
  quality_terminal_count, quality_success_rate,
  quality_dispatch_failed_attempts, quality_dispatch_rejected_attempts,
  quality_result_invalid_attempts, quality_retryable_attempts, quality_average_latency_ms,
  utilization_submissions, utilization_live, utilization_distinct_principals,
  utilization_distinct_active_days, utilization_window_days, utilization_submissions_per_day,
  utilization_first_submission_at, utilization_last_submission_at,
  security_requested_scope_counts, security_over_granted_scopes,
  security_approval_gated, security_policy_refusals, security_approval_rejections,
  security_findings,
  basis_attempts_included, basis_outcomes_included, basis_outcomes_truncated,
  recorded_by, recorded_at
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7::jsonb, $8::timestamptz, $9::timestamptz,
  $10, $11, $12, $13,
  $14, $15, $16,
  $17, $18, $19,
  $20, $21, $22,
  'USD', $23, $24,
  $25, $26, $27, $28,
  $29, $30, $31, $32,
  $33, $34,
  $35, $36,
  $37, $38, $39,
  $40, $41, $42,
  $43, $44, $45,
  $46::timestamptz, $47::timestamptz,
  $48::jsonb, $49::jsonb,
  $50, $51, $52,
  $53::jsonb,
  $54, $55, $56,
  $57, $58
) RETURNING *`;

export async function recordAgentEvaluation(
  ctx: TenantContext,
  input: RecordAgentEvaluationInput,
): Promise<AgentEvaluation> {
  assertAgentEvaluationTenantContext(ctx);
  const valid: ValidatedRecordEvaluationInput = validateRecordAgentEvaluationInput(input);

  // The measured agent — decision-time snapshot via the agents contract.
  const agent = await readAgent(ctx, valid.agentId);

  // The measurement basis: contract reads only (never another module's
  // tables). Executions arrive most-recent-first; the derived window is
  // the earliest → latest included submission.
  const executions = await readAgentExecutions(ctx, valid.agentId);
  const attemptsByExecution: AgentExecutionAttempt[][] = [];
  for (const execution of executions) {
    attemptsByExecution.push(await readExecutionAttempts(ctx, execution.id));
  }
  const attempts = attemptsByExecution.flat();
  const outcomes = await readAgentOutcomes(ctx, valid.agentId);

  const evaluatedAt = now();
  const { windowFrom, windowTo } = deriveWindow(
    executions,
    evaluatedAt.toISOString(),
  );
  const outcomeMetrics = computeOutcomeMetrics(outcomes);
  const costMetrics = computeCostMetrics(
    executions,
    attempts,
    executions.length >= AGENTS_MAX_LIST_LIMIT,
  );
  const qualityMetrics = computeQualityMetrics(executions, attempts);
  const utilizationMetrics = computeUtilizationMetrics(executions, windowFrom, windowTo);
  const securityMetrics = computeSecurityMetrics(agent.permissions, executions);

  // The deterministic comparison of every replacement option against
  // the MEASURED window cost (measurement.ts — never caller-supplied).
  const assessed = valid.replacementOptions.map((option) => ({
    option,
    comparison: compareReplacementCost(
      option.estimatedCostMinor,
      option.estimatedCostCurrency,
      costMetrics.totalCostMinor,
      costMetrics.costCurrency,
    ),
  }));

  const windowFromDate = new Date(windowFrom);
  const windowToDate = new Date(windowTo);

  return getDb().transaction(async (tx) => {
    const inserted = await tx.query<EvaluationRow>(
      EVALUATION_INSERT_SQL,
      [
        ctx.tenantId,
        agent.id,
        agent.slug,
        agent.role,
        agent.provider,
        agent.status,
        JSON.stringify(agent.permissions),
        windowFromDate,
        windowToDate,
        // outcome
        outcomeMetrics.outcomesTotal,
        outcomeMetrics.open,
        outcomeMetrics.settled,
        outcomeMetrics.abandoned,
        outcomeMetrics.met,
        outcomeMetrics.exceeded,
        outcomeMetrics.missed,
        outcomeMetrics.settledExpectedTotal,
        outcomeMetrics.settledRealizedTotal,
        outcomeMetrics.netVarianceVsExpected,
        // cost
        costMetrics.executionsIncluded,
        costMetrics.executionsTruncated,
        costMetrics.totalCostMinor,
        costMetrics.succeededCostMinor,
        costMetrics.costPerSucceededMinor,
        costMetrics.attemptsIncluded,
        costMetrics.inputTokensTotal,
        costMetrics.outputTokensTotal,
        costMetrics.operationsTotal,
        // quality
        qualityMetrics.succeeded,
        qualityMetrics.failed,
        qualityMetrics.refused,
        qualityMetrics.cancelled,
        qualityMetrics.terminalCount,
        qualityMetrics.successRate,
        qualityMetrics.dispatchFailedAttempts,
        qualityMetrics.dispatchRejectedAttempts,
        qualityMetrics.resultInvalidAttempts,
        qualityMetrics.retryableAttempts,
        qualityMetrics.averageLatencyMs,
        // utilization
        utilizationMetrics.submissions,
        utilizationMetrics.live,
        utilizationMetrics.distinctPrincipals,
        utilizationMetrics.distinctActiveDays,
        utilizationMetrics.windowDays,
        utilizationMetrics.submissionsPerDay,
        utilizationMetrics.firstSubmissionAt === null
          ? null
          : new Date(utilizationMetrics.firstSubmissionAt),
        utilizationMetrics.lastSubmissionAt === null
          ? null
          : new Date(utilizationMetrics.lastSubmissionAt),
        // security
        JSON.stringify(securityMetrics.requestedScopeCounts),
        JSON.stringify(securityMetrics.overGrantedScopes),
        securityMetrics.approvalGated,
        securityMetrics.policyRefusals,
        securityMetrics.approvalRejections,
        JSON.stringify(securityMetrics.findings),
        // basis
        costMetrics.attemptsIncluded,
        outcomes.length,
        outcomes.length >= LEARNING_MAX_LIST_LIMIT,
        // audit
        ctx.principalId,
        evaluatedAt,
      ],
    );
    const row = inserted.rows[0]!;

    const optionRows: OptionRow[] = [];
    for (const { option, comparison } of [...assessed].sort((a, b) =>
      a.option.kind < b.option.kind ? -1 : a.option.kind > b.option.kind ? 1 : 0,
    )) {
      const insertedOption = await tx.query<OptionRow>(
        `INSERT INTO agent_evaluation_replacement_options (
           tenant_id, evaluation_id, kind, summary, note,
           estimated_cost_minor, estimated_cost_currency, estimated_weeks,
           recommended, cost_delta_minor, cost_comparison
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          ctx.tenantId,
          row.id,
          option.kind,
          option.summary,
          option.note,
          option.estimatedCostMinor,
          option.estimatedCostCurrency,
          option.estimatedWeeks,
          option.recommended,
          comparison.costDeltaMinor,
          comparison.costComparison,
        ],
      );
      optionRows.push(insertedOption.rows[0]!);
    }

    return mapEvaluation(row, optionRows);
  });
}

// ---------------------------------------------------------------------------
// Evaluation reads
// ---------------------------------------------------------------------------

async function findEvaluationRow(
  db: Queryable,
  ctx: TenantContext,
  evaluationId: string,
): Promise<EvaluationRow | null> {
  const rows = await db.query<EvaluationRow>(
    `SELECT * FROM agent_evaluations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, evaluationId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

async function findOptionRows(
  db: Queryable,
  ctx: TenantContext,
  evaluationId: string,
): Promise<OptionRow[]> {
  const rows = await db.query<OptionRow>(
    `SELECT * FROM agent_evaluation_replacement_options
       WHERE tenant_id = $1 AND evaluation_id = $2
       ORDER BY kind ASC`,
    [ctx.tenantId, evaluationId],
  );
  return rows.rows;
}

export async function getAgentEvaluation(
  ctx: TenantContext,
  query: GetAgentEvaluationQuery,
): Promise<AgentEvaluation> {
  assertAgentEvaluationTenantContext(ctx);
  const valid = validateGetAgentEvaluationQuery(query);
  const row = await findEvaluationRow(getDb(), ctx, valid.evaluationId);
  if (row === null) {
    throw new AgentEvaluationError(
      'evaluation_not_found',
      `no agent evaluation '${valid.evaluationId}' exists in this tenant`,
    );
  }
  const options = await findOptionRows(getDb(), ctx, valid.evaluationId);
  return mapEvaluation(row, options);
}

export async function listAgentEvaluations(
  ctx: TenantContext,
  query: ListAgentEvaluationsQuery,
): Promise<AgentEvaluation[]> {
  assertAgentEvaluationTenantContext(ctx);
  const valid = validateListAgentEvaluationsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.agentId !== null) {
    params.push(valid.agentId);
    conditions.push(`agent_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<EvaluationRow>(
    `SELECT * FROM agent_evaluations WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );

  const evaluations: AgentEvaluation[] = [];
  for (const row of rows.rows) {
    const options = await findOptionRows(getDb(), ctx, row.id);
    evaluations.push(mapEvaluation(row, options));
  }
  return evaluations;
}

// ---------------------------------------------------------------------------
// decideAgentLifecycle (the policy gate)
// ---------------------------------------------------------------------------

async function findDecisionRow(
  db: Queryable,
  ctx: TenantContext,
  decisionId: string,
): Promise<DecisionRow | null> {
  const rows = await db.query<DecisionRow>(
    `SELECT * FROM agent_lifecycle_decisions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, decisionId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

/** The human decision that resolved a gated request, if one landed (the append-only trail). */
async function readPrincipalDecision(
  ctx: TenantContext,
  requestId: string,
): Promise<{ principalId: string; decidedAt: string } | null> {
  const decisions: ApprovalDecision[] = await listApprovalDecisions(ctx, { requestId });
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const decision = decisions[i]!;
    if (decision.decidedBy === 'principal' && decision.principalId !== null) {
      return { principalId: decision.principalId, decidedAt: decision.decidedAt };
    }
  }
  return null;
}

export async function decideAgentLifecycle(
  ctx: TenantContext,
  input: DecideAgentLifecycleInput,
): Promise<AgentLifecycleDecision> {
  assertAgentEvaluationTenantContext(ctx);
  // Deciding the agent workforce is a management action (the W021
  // claim discipline — authorization before parsing, so an
  // unauthorized caller learns nothing about shapes).
  if (!canDecideAgentLifecycle(ctx.authority)) {
    throw new AgentEvaluationError(
      'forbidden',
      `this operation requires the '${AGENTS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateDecideAgentLifecycleInput(input);

  // The measured evidence this decision follows from (tenant-scoped;
  // a foreign evaluation reads the same as a missing one).
  const evaluation = await findEvaluationRow(getDb(), ctx, valid.evaluationId);
  if (evaluation === null) {
    throw new AgentEvaluationError(
      'evaluation_not_found',
      `no agent evaluation '${valid.evaluationId}' exists in this tenant`,
    );
  }

  // A cited replacement option must belong to THAT evaluation — the
  // decision basis is the evidence it cites, never a foreign option.
  if (valid.replacementOptionId !== null) {
    const option = await getDb().query<OptionRow>(
      `SELECT id FROM agent_evaluation_replacement_options
         WHERE tenant_id = $1 AND evaluation_id = $2 AND id = $3`,
      [ctx.tenantId, valid.evaluationId, valid.replacementOptionId],
    );
    if (option.rows[0] === undefined) {
      throw new AgentEvaluationError(
        'invalid_replacement_option',
        `replacement option '${valid.replacementOptionId}' is not one of evaluation '${valid.evaluationId}'s options`,
      );
    }
  }

  // The decided agent, re-read through the agents contract (decision-time
  // snapshot; validates the agent still exists in this tenant).
  const agent = await readAgent(ctx, evaluation.agent_id);

  const recordedAt = now();

  // RETAIN / MODIFY — recorded management decisions (evidence only; the
  // modify mutation itself is applied through the agents module's own
  // claim-gated controls by management).
  if (!isMatrixGated(valid.change)) {
    const inserted = await getDb().query<DecisionRow>(
      `INSERT INTO agent_lifecycle_decisions (
         tenant_id, agent_id, agent_slug, evaluation_id, change,
         rationale, note, modification_summary, replacement_option_id,
         status, recorded_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL,
                 'recorded', $9, $10, $10)
       RETURNING *`,
      [
        ctx.tenantId,
        agent.id,
        agent.slug,
        valid.evaluationId,
        valid.change,
        valid.rationale,
        valid.note,
        valid.modificationSummary,
        ctx.principalId,
        recordedAt,
      ],
    );
    return mapDecision(inserted.rows[0]!);
  }

  // TERMINATE — the consequential §20 action: through the W009 authority
  // matrix, kind 'agent-termination' at level EXECUTE. The payload names
  // what is being approved; the rationale's digest travels with the
  // request (§24 reconstructability).
  const decisionId = newId();
  const rationaleDigest = createHash('sha256').update(valid.rationale).digest('hex');
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind: AGENT_TERMINATION_ACTION_KIND,
      authorityLevel: AGENT_TERMINATION_AUTHORITY_LEVEL,
      payload: {
        agentId: agent.id,
        agentSlug: agent.slug,
        evaluationId: valid.evaluationId,
        change: valid.change,
        replacementOptionId: valid.replacementOptionId,
        rationaleDigest,
      },
      idempotencyKey: `agent-evaluation:${decisionId}`,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      if (error.code === 'invalid_context') {
        throw new AgentEvaluationError('invalid_context', error.message);
      }
      if (error.code === 'invalid_action_input') {
        throw new AgentEvaluationError('invalid_decision_input', error.message);
      }
      throw new Error(
        `the authority gate rejected a pre-validated agent termination (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }

  // The deterministic routing of the gate outcome onto the lifecycle
  // (policy.ts — the agents module's submission routing, applied to the
  // §15 tail). The decision fields freeze who decided and when.
  const status = statusForGateOutcome(request.evaluation.outcome);
  const decidedBy: 'policy' | null = request.status === 'pending' ? null : 'policy';
  const decidedAt = request.status === 'pending' ? null : recordedAt;

  const inserted = await getDb().query<DecisionRow>(
    `INSERT INTO agent_lifecycle_decisions (
       tenant_id, agent_id, agent_slug, evaluation_id, change,
       rationale, note, modification_summary, replacement_option_id,
       status, action_request_id, policy_outcome, policy_resolved_via,
       submitted_by, submitted_at, decided_by, decided_by_principal, decided_at,
       recorded_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'terminate',
               $5, $6, NULL, $7,
               $8, $9, $10, $11,
               $12, $13, $14, NULL, $15,
               $16, $17, $17)
     RETURNING *`,
    [
      ctx.tenantId,
      agent.id,
      agent.slug,
      valid.evaluationId,
      valid.rationale,
      valid.note,
      valid.replacementOptionId,
      status,
      request.id,
      request.evaluation.outcome,
      request.evaluation.resolvedVia,
      ctx.principalId,
      recordedAt,
      decidedBy,
      decidedAt,
      ctx.principalId,
      recordedAt,
    ],
  );
  return mapDecision(inserted.rows[0]!);
}

// ---------------------------------------------------------------------------
// settleAgentLifecycleDecision (the pump — resolve the gate, apply)
// ---------------------------------------------------------------------------

export async function settleAgentLifecycleDecision(
  ctx: TenantContext,
  input: SettleAgentLifecycleDecisionInput,
): Promise<AgentLifecycleDecision> {
  assertAgentEvaluationTenantContext(ctx);
  // Applying a termination mutates the agent definition through the
  // agents contract — the same management claim its updateAgent demands.
  if (!canDecideAgentLifecycle(ctx.authority)) {
    throw new AgentEvaluationError(
      'forbidden',
      `this operation requires the '${AGENTS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateSettleAgentLifecycleDecisionInput(input);

  let row = await findDecisionRow(getDb(), ctx, valid.decisionId);
  if (row === null) {
    throw new AgentEvaluationError(
      'decision_not_found',
      `no agent lifecycle decision '${valid.decisionId}' exists in this tenant`,
    );
  }

  // Terminal states (and recorded retain/modify decisions) are reads —
  // settling is idempotent.
  if (row.status !== 'awaiting_approval' && row.status !== 'approved') {
    return mapDecision(row);
  }

  // --- resolve the gate (the agents module's pump precedent: the linked
  // request is read BEFORE any state move, and its decision is terminal).
  if (row.status === 'awaiting_approval') {
    const requestId = row.action_request_id!;
    let request: ActionRequest;
    try {
      request = await getActionRequest(ctx, { requestId });
    } catch (error) {
      if (error instanceof ActionsError && error.code === 'action_request_not_found') {
        throw new Error(
          `decision '${row.id}' links action request '${requestId}' that is not readable in this tenant (internal invariant violation)`,
          { cause: error },
        );
      }
      throw error;
    }

    if (request.status === 'pending') {
      // Still gated — the decision waits for a human; the caller
      // re-pumps after decideApproval.
      return mapDecision(row);
    }

    if (request.status === 'rejected') {
      const principalDecision = await readPrincipalDecision(ctx, requestId);
      const refused = await getDb().query<DecisionRow>(
        `UPDATE agent_lifecycle_decisions
           SET status = 'refused',
               decided_by = 'principal',
               decided_by_principal = $3,
               decided_at = $4,
               updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'
         RETURNING *`,
        [
          ctx.tenantId,
          row.id,
          principalDecision?.principalId ?? 'unknown',
          principalDecision !== null ? toDate(principalDecision.decidedAt) : now(),
          now(),
        ],
      );
      if (refused.rows[0] !== undefined) return mapDecision(refused.rows[0]);
      row = (await findDecisionRow(getDb(), ctx, valid.decisionId))!;
      if (row.status !== 'awaiting_approval' && row.status !== 'approved') return mapDecision(row);
      throw new AgentEvaluationError(
        'invalid_transition',
        `decision '${row.id}' moved while its rejection was being recorded (now '${row.status}')`,
      );
    }

    // request.status === 'approved': a human approved the gated
    // termination — freeze the decision trail, then apply below.
    const principalDecision = await readPrincipalDecision(ctx, requestId);
    const approved = await getDb().query<DecisionRow>(
      `UPDATE agent_lifecycle_decisions
         SET status = 'approved',
             decided_by = 'principal',
             decided_by_principal = $3,
             decided_at = $4,
             updated_at = $5
       WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'
       RETURNING *`,
      [
        ctx.tenantId,
        row.id,
        principalDecision?.principalId ?? 'unknown',
        principalDecision !== null ? toDate(principalDecision.decidedAt) : now(),
        now(),
      ],
    );
    if (approved.rows[0] !== undefined) {
      row = approved.rows[0];
    } else {
      row = (await findDecisionRow(getDb(), ctx, valid.decisionId))!;
      if (row.status !== 'approved') {
        // Another settler moved it (refused, or already applied).
        return mapDecision(row);
      }
    }
  }

  // --- apply the approved termination through the agents contract
  // (public surface only; our principal holds the administering claim).
  // The disable is idempotent, so an interrupted apply is safely
  // retryable — the decision stays 'approved' until this move lands.
  try {
    await updateAgent(ctx, { agentId: row.agent_id, status: 'disabled' });
  } catch (error) {
    if (error instanceof AgentsError && error.code === 'agent_not_found') {
      throw new Error(
        `decision '${row.id}' references agent '${row.agent_id}' that no longer exists (internal invariant violation)`,
        { cause: error },
      );
    }
    throw error;
  }

  const appliedAt = now();
  const applied = await getDb().query<DecisionRow>(
    `UPDATE agent_lifecycle_decisions
       SET status = 'applied', applied_at = $3, applied_by_principal = $4, updated_at = $3
     WHERE tenant_id = $1 AND id = $2 AND status = 'approved'
     RETURNING *`,
    [ctx.tenantId, row.id, appliedAt, ctx.principalId],
  );
  if (applied.rows[0] === undefined) {
    // A racing settler applied it first — its state stands.
    const current = await findDecisionRow(getDb(), ctx, valid.decisionId);
    return mapDecision(current!);
  }
  return mapDecision(applied.rows[0]);
}

// ---------------------------------------------------------------------------
// Decision reads
// ---------------------------------------------------------------------------

export async function getAgentLifecycleDecision(
  ctx: TenantContext,
  query: GetAgentLifecycleDecisionQuery,
): Promise<AgentLifecycleDecision> {
  assertAgentEvaluationTenantContext(ctx);
  const valid = validateGetAgentLifecycleDecisionQuery(query);
  const row = await findDecisionRow(getDb(), ctx, valid.decisionId);
  if (row === null) {
    throw new AgentEvaluationError(
      'decision_not_found',
      `no agent lifecycle decision '${valid.decisionId}' exists in this tenant`,
    );
  }
  return mapDecision(row);
}

export async function listAgentLifecycleDecisions(
  ctx: TenantContext,
  query: ListAgentLifecycleDecisionsQuery,
): Promise<AgentLifecycleDecision[]> {
  assertAgentEvaluationTenantContext(ctx);
  const valid = validateListAgentLifecycleDecisionsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.agentId !== null) add('agent_id = $#', valid.agentId);
  if (valid.change !== null) add('change = $#', valid.change);
  if (valid.status !== null) add('status = $#', valid.status);

  params.push(valid.limit);
  const rows = await getDb().query<DecisionRow>(
    `SELECT * FROM agent_lifecycle_decisions WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapDecision);
}
