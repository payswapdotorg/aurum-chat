// Pure health-assessment logic of the agent-supervision module (W098 —
// "durable agent health"). No database, no context: the assessment is
// a total, deterministic function of the agents module's EXECUTION
// EVIDENCE (read through its contract) and an explicit observation
// window — so any worker, fresh or long-lived, computes the same
// health from the same durable evidence. That determinism IS the
// "independent of worker lifetime" property for health.
//
// Semantics (an organizational actor's operational health, not a
// runtime ping): within the observation window,
//   * no executions at all        → `unknown`  (lock 7: unknown is
//                                    first-class — absence of evidence
//                                    is not health);
//   * live work gone stale        → degraded, or unhealthy when
//                                    chronic (≥ STALE_UNHEALTHY_THRESHOLD);
//   * decided-failure ratio       → degraded above DEGRADED_FAILURE_RATE,
//                                    unhealthy above UNHEALTHY_FAILURE_RATE
//                                    (with minimum sample sizes, so a
//                                    single blip never condemns an actor);
//   * otherwise                   → `healthy`.
//
// Cancelled/refused executions are deliberately NOT failures: they are
// management outcomes (a caller cancelling, a policy refusing), not
// evidence about the actor's operational health.

import type { AgentExecutionStatus } from '@/modules/agents/contract';
import type { AgentHealthState } from './types';

/** One unit of execution evidence (the W021 contract's fields we assess). */
export interface AgentHealthEvidence {
  status: AgentExecutionStatus;
  /** ISO 8601 submission time. */
  submittedAt: string;
}

/** The deterministic health assessment of one observation. */
export interface AgentHealthAssessment {
  state: AgentHealthState;
  detail: string;
}

/** A live execution older than this within the window counts as stale. */
export const STALE_LIVE_AFTER_SECONDS = 86_400; // 1 day
/** Stale live work at or above this count is chronic → unhealthy. */
export const STALE_UNHEALTHY_THRESHOLD = 3;
/** Minimum decided executions before a failure ratio is meaningful. */
export const MIN_DECIDED_FOR_RATIO = 2;
/** Failure ratios (over decided executions) that degrade / condemn. */
export const DEGRADED_FAILURE_RATE = 0.25;
export const UNHEALTHY_FAILURE_RATE = 0.5;
export const UNHEALTHY_MIN_DECIDED = 3;

/** The statuses that count as decided operational outcomes. */
const DECIDED_STATUSES: readonly AgentExecutionStatus[] = ['succeeded', 'failed'];
const LIVE_STATUSES: readonly AgentExecutionStatus[] = ['awaiting_approval', 'queued'];

/**
 * Assess one organizational actor's health from its execution evidence.
 *
 * @param evidence  the actor's executions (any superset of the window —
 *                  out-of-window rows are ignored deterministically);
 * @param windowFromMs inclusive window start (epoch ms);
 * @param windowToMs   inclusive window end (epoch ms; the observation
 *                    instant — work submitted AT the observation moment
 *                    counts);
 * @param staleAfterMs how old a live execution may be before it is stale.
 */
export function assessAgentHealth(
  evidence: readonly AgentHealthEvidence[],
  windowFromMs: number,
  windowToMs: number,
  staleAfterMs: number = STALE_LIVE_AFTER_SECONDS * 1000,
): AgentHealthAssessment {
  const inWindow = evidence.filter((item) => {
    const at = Date.parse(item.submittedAt);
    return at >= windowFromMs && at <= windowToMs;
  });

  const total = inWindow.length;
  if (total === 0) {
    return {
      state: 'unknown',
      detail: 'no executions observed in the health window',
    };
  }

  const decided = inWindow.filter((item) =>
    (DECIDED_STATUSES as readonly string[]).includes(item.status),
  );
  const failed = decided.filter((item) => item.status === 'failed');
  const live = inWindow.filter((item) =>
    (LIVE_STATUSES as readonly string[]).includes(item.status),
  );
  const stale = live.filter(
    (item) => windowToMs - Date.parse(item.submittedAt) > staleAfterMs,
  );

  const summary = `${total} execution(s) in window, ${failed.length}/${decided.length} decided failed, ${stale.length} stale live`;

  if (stale.length >= STALE_UNHEALTHY_THRESHOLD) {
    return { state: 'unhealthy', detail: `${stale.length} live executions stale — ${summary}` };
  }
  if (decided.length >= UNHEALTHY_MIN_DECIDED && failed.length / decided.length > UNHEALTHY_FAILURE_RATE) {
    return {
      state: 'unhealthy',
      detail: `failure rate ${(failed.length / decided.length).toFixed(2)} over ${decided.length} decided — ${summary}`,
    };
  }
  if (
    decided.length >= MIN_DECIDED_FOR_RATIO &&
    failed.length / decided.length > DEGRADED_FAILURE_RATE
  ) {
    return {
      state: 'degraded',
      detail: `failure rate ${(failed.length / decided.length).toFixed(2)} over ${decided.length} decided — ${summary}`,
    };
  }
  if (stale.length >= 1) {
    return { state: 'degraded', detail: `${stale.length} live execution(s) stale — ${summary}` };
  }
  return { state: 'healthy', detail: summary };
}

/** The default observation window (7 days) as epoch-ms bounds. */
export function defaultHealthWindow(nowMs: number): { fromMs: number; toMs: number } {
  const HEALTH_WINDOW_SECONDS = 604_800; // 7 days
  return {
    fromMs: nowMs - HEALTH_WINDOW_SECONDS * 1000,
    toMs: nowMs,
  };
}
