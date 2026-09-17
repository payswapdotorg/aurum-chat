// Pure measurement logic of the agent-evaluation module (W024 — Agent
// Evaluation and Termination). No database, no context, no time — every
// function here is a total, deterministic function of the CONTRACT data
// it is handed, which is exactly what "measure outcome, cost, quality,
// utilization, security and replacement options" demands: the same
// authoritative module state always yields the same measurement, with no
// LLM, randomness or hidden state in the path (lock 10 mirrored —
// evaluation is application-owned arithmetic over recorded evidence).
//
// The inputs are the PUBLIC SHAPES of the measured modules (agents W021
// executions/attempts, learning W040 outcomes), fetched through their
// contracts by the service; the functions below never touch a table,
// never mutate their inputs and never see a TenantContext. That keeps
// the entire six-dimension math unit-testable in isolation and pins the
// deterministic definitions the service freezes onto the append-only
// evaluation rows (what was computed is what is stored — §24).
//
// Rounding discipline: every derived ratio is rounded to a fixed
// precision (4 decimals for rates/intensities, whole minor units for
// money, whole ms for latency) so a stored measurement is byte-stable
// across recomputations — a frozen record must never depend on
// floating-point presentation.

import type {
  AgentExecution,
  AgentExecutionAttempt,
  AgentPermissionScope,
} from '@/modules/agents/contract';
import type { Outcome } from '@/modules/learning/contract';
import type {
  AgentCostMetrics,
  AgentOutcomeMetrics,
  AgentQualityMetrics,
  AgentSecurityFinding,
  AgentSecurityMetrics,
  AgentUtilizationMetrics,
  ReplacementCostComparison,
} from './types';

/** The live execution statuses (the agents module's partition). */
const LIVE_EXECUTION_STATUSES = new Set(['awaiting_approval', 'queued']);

/** Rounds to 4 decimal places (the fixed precision of stored rates). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Whole-number rounding for money and latency. */
function roundWhole(value: number): number {
  return Math.round(value);
}

/** The UTC calendar date (YYYY-MM-DD) of an ISO timestamp. */
function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// The OUTCOME dimension (W040 — expected versus realized)
// ---------------------------------------------------------------------------

/**
 * Measures the agent's tied outcomes (subject kind 'agent'): lifecycle
 * counts, settled assessments and the arithmetic expected/realized
 * sums. Sums cross metric units arithmetically (the learning module's
 * summarizeRealization caveat — comparing across metrics is the reader's
 * interpretation); an empty basis measures all zeros, which is an honest
 * "nothing was ever tied to this agent".
 */
export function computeOutcomeMetrics(outcomes: readonly Outcome[]): AgentOutcomeMetrics {
  const metrics: AgentOutcomeMetrics = {
    outcomesTotal: outcomes.length,
    open: 0,
    settled: 0,
    abandoned: 0,
    met: 0,
    exceeded: 0,
    missed: 0,
    settledExpectedTotal: 0,
    settledRealizedTotal: 0,
    netVarianceVsExpected: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.status === 'open') metrics.open += 1;
    else if (outcome.status === 'settled') metrics.settled += 1;
    else metrics.abandoned += 1;
    const realization = outcome.realization;
    if (outcome.status === 'settled' && realization !== null) {
      if (realization.assessment === 'met') metrics.met += 1;
      else if (realization.assessment === 'exceeded') metrics.exceeded += 1;
      else metrics.missed += 1;
      metrics.settledExpectedTotal += outcome.expected;
      metrics.settledRealizedTotal += realization.realizedValue;
      metrics.netVarianceVsExpected += realization.varianceVsExpected;
    }
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// The COST dimension (W021 — measured spend)
// ---------------------------------------------------------------------------

/**
 * Measures the agent's execution cost over the included basis: total
 * integer-minor-unit spend, spend over succeeded executions, the
 * per-succeeded average and the normalized usage sums. `truncated`
 * flags a basis that hit the agents contract's list ceiling, so a
 * reader knows older executions may exist outside the measurement.
 */
export function computeCostMetrics(
  executions: readonly AgentExecution[],
  attempts: readonly AgentExecutionAttempt[],
  truncated: boolean,
): AgentCostMetrics {
  let totalCostMinor = 0;
  let succeededCostMinor = 0;
  let succeeded = 0;
  for (const execution of executions) {
    totalCostMinor += execution.costMinor;
    if (execution.status === 'succeeded') {
      succeeded += 1;
      succeededCostMinor += execution.costMinor;
    }
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let operations = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawOperations = false;
  for (const attempt of attempts) {
    if (attempt.usage.inputTokens !== null) {
      sawInput = true;
      inputTokens += attempt.usage.inputTokens;
    }
    if (attempt.usage.outputTokens !== null) {
      sawOutput = true;
      outputTokens += attempt.usage.outputTokens;
    }
    if (attempt.usage.operations !== null) {
      sawOperations = true;
      operations += attempt.usage.operations;
    }
  }
  return {
    executionsIncluded: executions.length,
    executionsTruncated: truncated,
    totalCostMinor,
    costCurrency: 'USD',
    succeededCostMinor,
    costPerSucceededMinor: succeeded > 0 ? roundWhole(totalCostMinor / succeeded) : null,
    attemptsIncluded: attempts.length,
    inputTokensTotal: sawInput ? inputTokens : null,
    outputTokensTotal: sawOutput ? outputTokens : null,
    operationsTotal: sawOperations ? operations : null,
  };
}

// ---------------------------------------------------------------------------
// The QUALITY dimension (W021 — how well executions land)
// ---------------------------------------------------------------------------

/**
 * Measures execution quality: the terminal-outcome distribution, the
 * success rate over terminal executions (null when nothing terminated —
 * an honest no-basis rather than a fabricated zero), the canonical
 * failure-classification counts over attempts and the mean dispatch
 * latency.
 */
export function computeQualityMetrics(
  executions: readonly AgentExecution[],
  attempts: readonly AgentExecutionAttempt[],
): AgentQualityMetrics {
  let succeeded = 0;
  let failed = 0;
  let refused = 0;
  let cancelled = 0;
  for (const execution of executions) {
    if (execution.status === 'succeeded') succeeded += 1;
    else if (execution.status === 'failed') failed += 1;
    else if (execution.status === 'refused') refused += 1;
    else if (execution.status === 'cancelled') cancelled += 1;
  }
  const terminalCount = succeeded + failed + refused + cancelled;
  let dispatchFailed = 0;
  let dispatchRejected = 0;
  let resultInvalid = 0;
  let retryable = 0;
  let latencySum = 0;
  for (const attempt of attempts) {
    if (attempt.errorCode === 'dispatch_failed') dispatchFailed += 1;
    else if (attempt.errorCode === 'dispatch_rejected') dispatchRejected += 1;
    else if (attempt.errorCode === 'result_invalid') resultInvalid += 1;
    if (attempt.retryable) retryable += 1;
    latencySum += attempt.latencyMs;
  }
  return {
    succeeded,
    failed,
    refused,
    cancelled,
    terminalCount,
    successRate: terminalCount > 0 ? round4(succeeded / terminalCount) : null,
    dispatchFailedAttempts: dispatchFailed,
    dispatchRejectedAttempts: dispatchRejected,
    resultInvalidAttempts: resultInvalid,
    retryableAttempts: retryable,
    averageLatencyMs: attempts.length > 0 ? roundWhole(latencySum / attempts.length) : null,
  };
}

// ---------------------------------------------------------------------------
// The UTILIZATION dimension (W021 — how much the agent is used)
// ---------------------------------------------------------------------------

/**
 * Derives the measured window: the earliest → latest included
 * submission, or the evaluation instant when the agent was never
 * submitted to (an honest point-in-time window — zero-length, so the
 * intensity denominators stay total).
 */
export function deriveWindow(
  executions: readonly AgentExecution[],
  evaluatedAt: string,
): { windowFrom: string; windowTo: string } {
  if (executions.length === 0) return { windowFrom: evaluatedAt, windowTo: evaluatedAt };
  let first = executions[0]!.submittedAt;
  let last = executions[0]!.submittedAt;
  for (const execution of executions) {
    if (execution.submittedAt < first) first = execution.submittedAt;
    if (execution.submittedAt > last) last = execution.submittedAt;
  }
  return { windowFrom: first, windowTo: last };
}

/**
 * Measures utilization: submissions, live share, distinct submitting
 * principals, distinct active UTC days and the submission intensity
 * over the measured window (whole days, minimum one, so the division is
 * always defined).
 */
export function computeUtilizationMetrics(
  executions: readonly AgentExecution[],
  windowFrom: string,
  windowTo: string,
): AgentUtilizationMetrics {
  const principals = new Set<string>();
  const days = new Set<string>();
  let live = 0;
  for (const execution of executions) {
    principals.add(execution.submittedBy);
    days.add(utcDate(execution.submittedAt));
    if (LIVE_EXECUTION_STATUSES.has(execution.status)) live += 1;
  }
  const spanMs = Math.max(
    0,
    new Date(windowTo).getTime() - new Date(windowFrom).getTime(),
  );
  const windowDays = Math.max(1, Math.ceil(spanMs / 86_400_000));
  return {
    submissions: executions.length,
    live,
    distinctPrincipals: principals.size,
    distinctActiveDays: days.size,
    windowDays,
    submissionsPerDay: round4(executions.length / windowDays),
    firstSubmissionAt: executions.length > 0 ? windowFrom : null,
    lastSubmissionAt: executions.length > 0 ? windowTo : null,
  };
}

// ---------------------------------------------------------------------------
// The SECURITY dimension (W021 + the W009 evidence it records)
// ---------------------------------------------------------------------------

/**
 * Measures the security posture: the granted-versus-requested permission
 * analysis and the authority interactions recorded on the executions
 * (matrix refusals, approval gating, human rejections — the W009
 * evidence the W021 gateway persists). Findings are computed, never
 * caller-supplied, and the list may be empty — a clean bill is an
 * honest measurement, not a missing one.
 */
export function computeSecurityMetrics(
  grantedPermissions: readonly AgentPermissionScope[],
  executions: readonly AgentExecution[],
): AgentSecurityMetrics {
  const requestedScopeCounts: Record<string, number> = {};
  let approvalGated = 0;
  let policyRefusals = 0;
  let approvalRejections = 0;
  for (const execution of executions) {
    for (const scope of execution.requestedPermissions) {
      requestedScopeCounts[scope] = (requestedScopeCounts[scope] ?? 0) + 1;
    }
    if (execution.policy.outcome === 'approval_required') approvalGated += 1;
    if (execution.errorCode === 'execution_forbidden') policyRefusals += 1;
    if (execution.errorCode === 'approval_rejected') approvalRejections += 1;
  }
  const granted = [...grantedPermissions];
  const overGranted = granted
    .filter((scope) => (requestedScopeCounts[scope] ?? 0) === 0)
    .sort();

  const findings: AgentSecurityFinding[] = [];
  for (const scope of overGranted) {
    findings.push({
      code: 'over_granted_scope',
      subject: scope,
      detail: `the agent is granted the '${scope}' permission scope but no measured execution ever requested it (least-privilege signal)`,
    });
  }
  if (granted.includes('execute')) {
    findings.push({
      code: 'execute_scope_granted',
      subject: 'execute',
      detail: "the agent is granted the 'execute' permission scope — the highest §20 authority level an agent may hold",
    });
  }
  if (policyRefusals > 0) {
    findings.push({
      code: 'policy_refusals_present',
      subject: null,
      detail: `the tenant authority policy forbade ${policyRefusals} measured submission(s)`,
    });
  }
  if (approvalRejections > 0) {
    findings.push({
      code: 'approval_rejections_present',
      subject: null,
      detail: `a human rejected ${approvalRejections} approval-gated submission(s)`,
    });
  }

  return {
    grantedPermissions: granted,
    requestedScopeCounts,
    overGrantedScopes: overGranted,
    approvalGated,
    policyRefusals,
    approvalRejections,
    findings,
  };
}

// ---------------------------------------------------------------------------
// The REPLACEMENT OPTIONS dimension (the deterministic comparison)
// ---------------------------------------------------------------------------

/**
 * The deterministic cost comparison of one replacement option against
 * the agent's measured window cost: the signed delta (estimated −
 * measured, integer minor units) and the classification. `unknown` is
 * returned when the option carries no estimate or nothing was measured —
 * never a fabricated comparison (the loud-failure discipline).
 *
 * Cross-currency comparisons are deliberately `unknown`: the measured
 * cost is canonical USD (the agents module's convention) and an option
 * estimated in another currency is not arithmetically comparable
 * without an exchange rate this module does not own.
 */
export function compareReplacementCost(
  estimatedCostMinor: number | null,
  estimatedCostCurrency: string | null,
  measuredCostMinor: number,
  measuredCostCurrency: string,
): { costDeltaMinor: number | null; costComparison: ReplacementCostComparison } {
  const comparable =
    estimatedCostMinor !== null &&
    (estimatedCostCurrency === null || estimatedCostCurrency === measuredCostCurrency);
  if (!comparable) return { costDeltaMinor: null, costComparison: 'unknown' };
  const delta = estimatedCostMinor! - measuredCostMinor;
  const comparison: ReplacementCostComparison =
    delta < 0 ? 'lower_cost' : delta === 0 ? 'equal_cost' : 'higher_cost';
  return { costDeltaMinor: delta, costComparison: comparison };
}
