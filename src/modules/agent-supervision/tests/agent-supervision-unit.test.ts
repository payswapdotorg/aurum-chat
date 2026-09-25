// Unit tests for the agent-supervision module's pure logic (W098 — no
// database, no context, no clock): the policy vocabulary, the
// deterministic admission/budget arithmetic, the review-schedule date
// math, the causation-identity discipline, the health assessment and
// the input guards.
//
// The purity IS the acceptance property: every function here is a
// total, deterministic function of its durable inputs — which is why
// any worker (fresh or long-lived) makes the same supervision decision
// from the same state. "Independent of worker lifetime" is testable
// exactly because none of this depends on who evaluates it.

import { describe, expect, it } from 'vitest';
import type { AgentExecutionStatus, AgentPermissionScope } from '@/modules/agents/contract';
import type { RegisterSupervisedAgentInput, SubmitSupervisedExecutionInput } from '../types';
import {
  AGENTS_AUTHORITY_ADMINISTER,
  SUPERVISION_STATUSES,
  SUPERVISION_WAITING,
  budgetRemainingMinor,
  canAdministerSupervision,
  isBudgetExhausted,
  isHealthObservationDue,
  isReviewDue,
  isSupervisedExecution,
  isSupervisionReviewOutcome,
  isSupervisionStatus,
  isTerminalSupervisionStatus,
  isWaitingSupervisionStatus,
  missingCeilingScope,
  nextReviewAfterCompletion,
  statusAfterReview,
  supervisionCausationKey,
  supervisionIdOfCausation,
} from '../policy';
import {
  DEGRADED_FAILURE_RATE,
  MIN_DECIDED_FOR_RATIO,
  STALE_UNHEALTHY_THRESHOLD,
  UNHEALTHY_FAILURE_RATE,
  UNHEALTHY_MIN_DECIDED,
  assessAgentHealth,
  defaultHealthWindow,
} from '../health';
import {
  DEFAULT_HEALTH_INTERVAL_SECONDS,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_REVIEW_INTERVAL_SECONDS,
  MAX_MINOR_UNITS,
  SUPERVISION_EVENT_KINDS,
  isSupervisionEventKind,
} from '../validation';
import { AgentSupervisionError } from '../errors';
import {
  validateCompleteSupervisionReviewInput,
  validateGrantSupervisionBudgetInput,
  validateRegisterSupervisedAgentInput,
  validateSubmitSupervisedExecutionInput,
} from '../validation';

const T0 = Date.parse('2026-09-24T12:00:00Z');

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

describe('supervision lifecycle vocabulary', () => {
  it('enumerates exactly the six supervision statuses', () => {
    expect([...SUPERVISION_STATUSES]).toEqual([
      'active',
      'waiting_review',
      'paused_budget',
      'suspended',
      'waiting_termination',
      'terminated',
    ]);
  });

  it('partitions waiting and terminal statuses without overlap with active', () => {
    for (const status of SUPERVISION_WAITING) {
      expect(isWaitingSupervisionStatus(status)).toBe(true);
      expect(isTerminalSupervisionStatus(status)).toBe(false);
    }
    expect(isWaitingSupervisionStatus('active')).toBe(false);
    expect(isTerminalSupervisionStatus('active')).toBe(false);
    expect(isTerminalSupervisionStatus('terminated')).toBe(true);
    expect(isWaitingSupervisionStatus('terminated')).toBe(false);
  });

  it('validates status and review-outcome words', () => {
    expect(isSupervisionStatus('paused_budget')).toBe(true);
    expect(isSupervisionStatus('paused')).toBe(false);
    expect(isSupervisionReviewOutcome('terminate_proposal')).toBe(true);
    expect(isSupervisionReviewOutcome('terminate')).toBe(false);
  });

  it('maps each review outcome to its target supervision status', () => {
    expect(statusAfterReview('continue')).toBe('active');
    expect(statusAfterReview('adjust')).toBe('active');
    expect(statusAfterReview('suspend')).toBe('suspended');
    // The load-bearing one: supervision NEVER terminates — it waits on
    // the W024 decision (the lifecycle control stays authoritative).
    expect(statusAfterReview('terminate_proposal')).toBe('waiting_termination');
  });
});

// ---------------------------------------------------------------------------
// Admission, budget and schedule arithmetic
// ---------------------------------------------------------------------------

describe('admission and budget arithmetic', () => {
  it('finds the first requested scope the ceiling does not cover', () => {
    expect(missingCeilingScope(['observe', 'analyze'], ['observe'])).toBeNull();
    expect(missingCeilingScope(['observe'], ['observe', 'analyze'])).toBe('analyze');
    expect(missingCeilingScope([], ['observe'])).toBe('observe');
  });

  it('computes the budget remainder with a zero clamp and unlimited passthrough', () => {
    expect(budgetRemainingMinor(null, 10_000)).toBeNull();
    expect(budgetRemainingMinor(100, 40)).toBe(60);
    expect(budgetRemainingMinor(100, 100)).toBe(0);
    // In-flight work may overshoot — the remainder clamps at zero.
    expect(budgetRemainingMinor(100, 240)).toBe(0);
  });

  it('detects exhaustion only for finite envelopes', () => {
    expect(isBudgetExhausted({ budgetMinor: null, budgetSpentMinor: 1_000_000 })).toBe(false);
    expect(isBudgetExhausted({ budgetMinor: 100, budgetSpentMinor: 99 })).toBe(false);
    expect(isBudgetExhausted({ budgetMinor: 100, budgetSpentMinor: 100 })).toBe(true);
    expect(isBudgetExhausted({ budgetMinor: 100, budgetSpentMinor: 101 })).toBe(true);
  });

  it('schedules the next review after a completed review', () => {
    expect(nextReviewAfterCompletion(T0, 60)).toBe(T0 + 60_000);
    expect(nextReviewAfterCompletion(T0, 2_592_000)).toBe(T0 + 2_592_000_000);
  });

  it('fires review due exactly when the cursor has lapsed', () => {
    const due = new Date(T0).toISOString();
    expect(isReviewDue(due, T0)).toBe(true); // due now
    expect(isReviewDue(due, T0 - 1)).toBe(false); // one ms early
    expect(isReviewDue(new Date(T0 - 86_400_000).toISOString(), T0)).toBe(true);
  });

  it('marks health observations due when never observed or stale', () => {
    expect(isHealthObservationDue({ healthObservedAt: null }, 3_600, T0)).toBe(true);
    const recent = new Date(T0 - 60_000).toISOString();
    const stale = new Date(T0 - 3_600_000).toISOString();
    expect(isHealthObservationDue({ healthObservedAt: recent }, 3_600, T0)).toBe(false);
    expect(isHealthObservationDue({ healthObservedAt: stale }, 3_600, T0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The supervision causation identity
// ---------------------------------------------------------------------------

describe('the supervision causation identity', () => {
  it('round-trips between supervision ids and causation keys', () => {
    const id = '7b8387d7-0ccd-96da-7bbd-7daaa1748419';
    const key = supervisionCausationKey(id);
    expect(key).toBe(`agent-supervision:${id}`);
    expect(supervisionIdOfCausation(key)).toBe(id);
    expect(supervisionIdOfCausation('some-other-causation')).toBeNull();
    expect(supervisionIdOfCausation(null)).toBeNull();
  });

  it('recognizes exactly its own supervised executions', () => {
    const id = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a';
    const key = supervisionCausationKey(id);
    expect(isSupervisedExecution(key, id)).toBe(true);
    expect(isSupervisedExecution(key, '11111111-1111-1111-1111-111111111111')).toBe(false);
    expect(isSupervisedExecution(null, id)).toBe(false);
    expect(isSupervisedExecution('agent-supervision:other', id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

describe('the administration claim', () => {
  it('gates supervision management on the W021 agents administer claim', () => {
    expect(canAdministerSupervision([])).toBe(false);
    expect(canAdministerSupervision(['agents:administer'])).toBe(true);
    expect(canAdministerSupervision(['actions:approve', 'agents:administer'])).toBe(true);
    expect(AGENTS_AUTHORITY_ADMINISTER).toBe('agents:administer');
  });
});

// ---------------------------------------------------------------------------
// Health assessment (the pure deterministic core of durable health)
// ---------------------------------------------------------------------------

describe('health assessment', () => {
  const DAY = 86_400_000;
  const from = T0 - 7 * DAY;

  function evidence(items: { status: string; ageMs: number }[]) {
    return items.map((item) => ({
      status: item.status as AgentExecutionStatus,
      submittedAt: new Date(T0 - item.ageMs).toISOString(),
    }));
  }

  it('reports unknown when no executions fall in the window (lock 7: unknown is first-class)', () => {
    const none = assessAgentHealth(evidence([{ status: 'succeeded', ageMs: 8 * DAY }]), from, T0);
    expect(none.state).toBe('unknown');
    expect(assessAgentHealth([], from, T0).state).toBe('unknown');
  });

  it('reports healthy for recent decided work without failures', () => {
    const healthy = assessAgentHealth(
      evidence([
        { status: 'succeeded', ageMs: 1_000 },
        { status: 'succeeded', ageMs: 2_000 },
        { status: 'succeeded', ageMs: 3_000 },
      ]),
      from,
      T0,
    );
    expect(healthy.state).toBe('healthy');
  });

  it('degrades above the degraded failure rate with the minimum sample', () => {
    // 1/2 failed = 0.5 > DEGRADED_FAILURE_RATE but below the unhealthy
    // minimum decided sample (3) → degraded, not unhealthy.
    const degraded = assessAgentHealth(
      evidence([
        { status: 'succeeded', ageMs: 1_000 },
        { status: 'failed', ageMs: 2_000 },
      ]),
      from,
      T0,
    );
    expect(degraded.state).toBe('degraded');
    expect(DEGRADED_FAILURE_RATE).toBe(0.25);
    expect(MIN_DECIDED_FOR_RATIO).toBe(2);
  });

  it('condemns above the unhealthy failure rate with the unhealthy sample size', () => {
    const unhealthy = assessAgentHealth(
      evidence([
        { status: 'failed', ageMs: 1_000 },
        { status: 'failed', ageMs: 2_000 },
        { status: 'succeeded', ageMs: 3_000 },
      ]),
      from,
      T0,
    );
    expect(unhealthy.state).toBe('unhealthy');
    expect(UNHEALTHY_FAILURE_RATE).toBe(0.5);
    expect(UNHEALTHY_MIN_DECIDED).toBe(3);
  });

  it('a single blip never condemns an actor below the minimum sample', () => {
    // 1/1 failed — ratio 1.0, but only ONE decided execution: the ratio
    // gates require the minimum sample, so this is degraded at most...
    // with exactly one decided and no stale, it is healthy-with-one-
    // failure? No: 1/1 = 1.0 > 0.25 but decided(1) < MIN(2) → no ratio
    // degradation; no stale → healthy. Deterministic and documented.
    const single = assessAgentHealth(evidence([{ status: 'failed', ageMs: 1_000 }]), from, T0);
    expect(single.state).toBe('healthy');
  });

  it('degrades on stale live work and condemns when chronic', () => {
    const staleAt = 2 * DAY; // older than the 1-day stale threshold
    const one = assessAgentHealth(
      evidence([
        { status: 'queued', ageMs: staleAt },
        { status: 'succeeded', ageMs: 1_000 },
      ]),
      from,
      T0,
    );
    expect(one.state).toBe('degraded');

    const chronic = assessAgentHealth(
      evidence([
        { status: 'queued', ageMs: staleAt },
        { status: 'awaiting_approval', ageMs: staleAt + 1 },
        { status: 'queued', ageMs: staleAt + 2 },
      ]),
      from,
      T0,
    );
    expect(chronic.state).toBe('unhealthy');
    expect(STALE_UNHEALTHY_THRESHOLD).toBe(3);
  });

  it('treats cancelled and refused executions as management outcomes, not failures', () => {
    const assessed = assessAgentHealth(
      evidence([
        { status: 'cancelled', ageMs: 1_000 },
        { status: 'refused', ageMs: 2_000 },
      ]),
      from,
      T0,
    );
    expect(assessed.state).toBe('healthy'); // no decided failures, no stale
  });

  it('honors an explicit stale threshold', () => {
    const assessed = assessAgentHealth(
      evidence([{ status: 'queued', ageMs: 2 * DAY }]),
      from,
      T0,
      3 * DAY, // stale only after 3 days
    );
    expect(assessed.state).toBe('healthy');
  });

  it('derives the default 7-day window', () => {
    const window = defaultHealthWindow(T0);
    expect(window.toMs).toBe(T0);
    expect(window.fromMs).toBe(T0 - 7 * 86_400_000);
  });
});

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

describe('validation guards', () => {
  const AGENT = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a';

  function expectCode(code: AgentSupervisionError['code'], fn: () => unknown): void {
    try {
      fn();
      throw new Error(`expected AgentSupervisionError('${code}') but the call succeeded`);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSupervisionError);
      expect((error as AgentSupervisionError).code).toBe(code);
    }
  }

  it('registers with defaults and normalizes the ceiling canonically', () => {
    const valid = validateRegisterSupervisedAgentInput({
      agentId: AGENT,
      permittedScopes: ['analyze', 'observe', 'analyze'],
    });
    expect(valid.reviewIntervalSeconds).toBe(DEFAULT_REVIEW_INTERVAL_SECONDS);
    expect(valid.healthIntervalSeconds).toBe(DEFAULT_HEALTH_INTERVAL_SECONDS);
    expect(valid.budgetMinor).toBeNull();
    expect(valid.permittedScopes).toEqual(['observe', 'analyze']); // canonical order, deduplicated
  });

  it('rejects out-of-bounds cadences, budgets and unknown fields', () => {
    expectCode('invalid_input', () =>
      validateRegisterSupervisedAgentInput({ agentId: AGENT, reviewIntervalSeconds: 59 }),
    );
    expectCode('invalid_input', () =>
      validateRegisterSupervisedAgentInput({
        agentId: AGENT,
        reviewIntervalSeconds: 31_536_001,
      }),
    );
    expectCode('invalid_input', () =>
      validateRegisterSupervisedAgentInput({ agentId: AGENT, budgetMinor: -1 }),
    );
    expectCode('invalid_input', () =>
      validateRegisterSupervisedAgentInput({ agentId: AGENT, budgetMinor: 1.5 }),
    );
    expectCode('invalid_input', () =>
      validateRegisterSupervisedAgentInput({ agentId: 'not-a-uuid' }),
    );
    expectCode('invalid_input', () =>
      validateRegisterSupervisedAgentInput({ agentId: AGENT, ownerPrincipal: '' }),
    );
    expectCode('invalid_input', () =>
      validateRegisterSupervisedAgentInput({ agentId: AGENT, sneaky: true } as RegisterSupervisedAgentInput),
    );
    expect(MAX_MINOR_UNITS).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('requires a positive grant', () => {
    expectCode('invalid_input', () =>
      validateGrantSupervisionBudgetInput({ agentId: AGENT, additionalMinor: 0 }),
    );
    expect(
      validateGrantSupervisionBudgetInput({ agentId: AGENT, additionalMinor: 500 }).additionalMinor,
    ).toBe(500);
  });

  it('keeps submissions non-null and within the closed scope vocabulary', () => {
    expectCode('invalid_input', () =>
      validateSubmitSupervisedExecutionInput({
        agentId: AGENT,
        task: null,
        requestedPermissions: ['observe'],
      }),
    );
    expectCode('invalid_input', () =>
      validateSubmitSupervisedExecutionInput({
        agentId: AGENT,
        task: { ok: true },
        requestedPermissions: [],
      }),
    );
    expectCode('invalid_input', () =>
      validateSubmitSupervisedExecutionInput({
        agentId: AGENT,
        task: { ok: true },
        requestedPermissions: ['observe', 'obliterate'] as unknown as AgentPermissionScope[],
      } as SubmitSupervisedExecutionInput),
    );
  });

  it('disciplines review outcomes: adjustments only on adjust, decisions only on proposals', () => {
    expectCode('invalid_input', () =>
      validateCompleteSupervisionReviewInput({
        agentId: AGENT,
        outcome: 'continue',
        rationale: 'fine',
        adjustments: { ownerPrincipal: 'owner-2' },
      }),
    );
    expectCode('invalid_input', () =>
      validateCompleteSupervisionReviewInput({
        agentId: AGENT,
        outcome: 'adjust',
        rationale: 'tighten',
      }),
    );
    expectCode('invalid_input', () =>
      validateCompleteSupervisionReviewInput({
        agentId: AGENT,
        outcome: 'terminate_proposal',
        rationale: 'done',
      }),
    );
    const valid = validateCompleteSupervisionReviewInput({
      agentId: AGENT,
      outcome: 'terminate_proposal',
      rationale: 'measured evidence says stop',
      decisionId: '1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b',
    });
    expect(valid.decisionId).toBe('1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b');
  });

  it('enumerates the event vocabulary and its guard', () => {
    expect(SUPERVISION_EVENT_KINDS).toContain('session_recovered');
    expect(SUPERVISION_EVENT_KINDS).toContain('budget_consumed');
    expect(isSupervisionEventKind('session_recovered')).toBe(true);
    expect(isSupervisionEventKind('session_died')).toBe(false);
    expect(DEFAULT_LEASE_SECONDS).toBe(300);
  });
});
