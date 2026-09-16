// End-to-end synthetic proof for W051 — ADR-0017's "Required verification":
//
//   "A synthetic company fixture where a hidden consequential variable
//    causes an unprompted mission: no operator question exists anywhere
//    in the transcript, yet goal + evidence evaluation produces the
//    unknown, the mission and the acquisition plan."
//
// The synthetic company: Northwind Synthetic, a B2B SaaS tenant with a
// CRITICAL churn-reduction goal (monthly churn at most 6 percent) whose
// evidence sources name the Billing CRM. The HIDDEN consequential
// variable: a recent onboarding redesign quietly broke activation, which
// is what actually drives churn up. Aurum never sees the variable
// directly — its observations carry only the SYMPTOMS (the churn number,
// the support-ticket spike). No operator question is asked anywhere:
//
//   1. a canonical cognitive execution (W013) ingests the evidence
//      (observation stage), derives the claims (epistemic-evaluation
//      stage) and evaluates the goal (goal-evaluation stage);
//   2. the UNPROMPTED discovery pass runs BETWEEN the loop's stages —
//      triggered as a cognitive-execution pass linked to that execution,
//      carrying ONLY a metric reading (8.4, per the recorded claim) and
//      its claim provenance. There is no question field anywhere in the
//      input; the unknown's question is DERIVED by the application;
//   3. goal + evidence evaluation produced the unknown (epistemics), the
//      mission (missions, linked to goal + unknown) —
//   4. — and the acquisition plan: the same execution's
//      knowledge-acquisition stage drives the W012 planner over the
//      discovery-launched mission and suspends awaiting its input, with
//      the persisted plan selecting the Billing CRM (the goal's own
//      evidence source, mapped onto the mission's candidate menu).
//
// The chain is asserted end to end by linked ids:
// candidate → unknown → mission → plan ← execution.pending, plus
// run.originExecution → execution. Everything is reconstructable.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runNextStage, startExecution } from '@/modules/cognition/contract';
import type { CognitiveExecutionTrace } from '@/modules/cognition/contract';
import { getUnknown, listUnknowns } from '@/modules/epistemics/contract';
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { listAcquisitionPlans } from '@/modules/knowledge-acquisition/contract';
import { getMission, listMissions } from '@/modules/missions/contract';
import { runGoalGapDiscovery } from '../contract';
import { runMigrations } from '../../../../scripts/migrate';

const tenant = newId(); // Northwind Synthetic — dedicated tenant
const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

function member(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [] };
}

/** One metric observation intake for the observation stage. */
function metricIntake(payload: Record<string, unknown>) {
  return {
    kind: 'metric.sample',
    payload,
    observedAt: new Date().toISOString(),
    source: { kind: 'source', label: 'billing-crm' },
    channel: 'ingestion',
    confidence: { value: 0.85, method: 'crm-export', basis: 'nightly metric export' },
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W051 end-to-end — the hidden consequential variable', () => {
  it('produces the unknown, the mission and the acquisition plan with no operator question', async () => {
    const ctx = member();

    // -----------------------------------------------------------------
    // The synthetic company: a critical churn goal against evidence
    // sources the tenant actually has (the Billing CRM).
    // -----------------------------------------------------------------
    const goal: Goal = await createGoal(ctx, {
      title: 'Reduce monthly churn',
      objective: 'Bring monthly customer churn under control this half.',
      desiredState: 'Monthly churn at or below 6 percent',
      metrics: [{ name: 'monthly-churn-rate', unit: 'percent', direction: 'at_most', threshold: 6 }],
      horizonEnd: new Date(Date.now() + 45 * 86_400_000).toISOString(), // 45 days out
      owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
      priority: 'critical',
      evidenceSources: [{ kind: 'source', label: 'Billing CRM' }],
      successCriteria: 'Monthly churn at or below 6 percent for one full quarter',
      actor: { kind: 'person', id: PERSON_ID, label: 'COO' },
      rationale: 'board target for the half',
    });

    // -----------------------------------------------------------------
    // A canonical cognitive cycle ingests the symptoms (W013). The
    // HIDDEN variable — the broken onboarding redesign — is nowhere in
    // the inputs; only its effects are.
    // -----------------------------------------------------------------
    let trace: CognitiveExecutionTrace = await startExecution(ctx, {
      trigger: { kind: 'schedule', label: 'nightly goal-evaluation cycle' },
      focus: { topics: ['churn', 'onboarding', 'retention'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'nightly evaluation of active goals against evidence',
    });
    const executionId = trace.id;

    // Stage 1 — observation: the churn report and the ticket spike.
    trace = await runNextStage(ctx, {
      executionId,
      stage: 'observation',
      record: [
        metricIntake({ metric: 'monthly-churn-rate', value: 8.4, period: '2026-11' }),
        metricIntake({ metric: 'support-tickets-mentioning-onboarding', value: 312, change: '3x MoM', period: '2026-11' }),
      ],
    });
    const [churnObservationId, ticketObservationId] = (
      trace.steps.find((step) => step.stage === 'observation')!.result as {
        observationIds: string[];
      }
    ).observationIds;
    expect(churnObservationId).toBeDefined();
    expect(ticketObservationId).toBeDefined();

    // Stages 2-3 — remember, no world change this cycle.
    await runNextStage(ctx, { executionId, stage: 'evidence-memory' });
    await runNextStage(ctx, { executionId, stage: 'world-update', update: null });

    // Stage 4 — epistemic evaluation: the claims the evidence supports
    // (what the numbers ARE — still no statement about WHY).
    trace = await runNextStage(ctx, {
      executionId,
      stage: 'epistemic-evaluation',
      claims: [
        {
          proposition: 'Monthly churn rate is 8.4 percent',
          subject: { kind: 'goals.goal', id: goal.id },
          confidence: { value: 0.85, method: 'crm-export', basis: 'nightly metric export' },
          evidenceObservationIds: [churnObservationId!],
          rationale: 'direct metric reading',
        },
        {
          proposition: 'Support tickets mentioning onboarding tripled month over month',
          subject: { kind: 'goals.goal', id: goal.id },
          confidence: { value: 0.8, method: 'crm-export', basis: 'ticket counts' },
          evidenceObservationIds: [ticketObservationId!],
          rationale: 'direct metric reading',
        },
      ],
    });
    const claimIds = (
      trace.steps.find((step) => step.stage === 'epistemic-evaluation')!.result as {
        claimIds: string[];
      }
    ).claimIds;
    expect(claimIds).toHaveLength(2);
    const churnClaimId = claimIds[0]!;

    // Stage 5 — goal evaluation: the focus relates to the active goal.
    trace = await runNextStage(ctx, {
      executionId,
      stage: 'goal-evaluation',
      relatedGoalIds: [goal.id],
    });
    const goalStep = trace.steps.find((step) => step.stage === 'goal-evaluation')!.result as {
      goalIds: string[];
      activeGoalCount: number;
    };
    expect(goalStep.goalIds).toEqual([goal.id]);
    expect(goalStep.activeGoalCount).toBeGreaterThanOrEqual(1);

    // -----------------------------------------------------------------
    // THE UNPROMPTED DISCOVERY PASS — between goal evaluation and
    // unknown/mission evaluation. The input carries a trigger, budgets,
    // an actor, the loop linkage and ONE metric reading with its claim
    // provenance. There is no question field — structurally, the input
    // type has none to fill.
    // -----------------------------------------------------------------
    const run = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'cognitive-execution', label: 'nightly goal-evaluation cycle' },
      originExecutionId: executionId,
      goalIds: [goal.id],
      readings: [
        {
          goalId: goal.id,
          metricName: 'monthly-churn-rate',
          value: 8.4,
          driverConfidence: 0, // the evidence says nothing about WHY
          evidenceClaimIds: [churnClaimId],
        },
      ],
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      rewardBudget: { amount: 100_00, currency: 'EUR' },
      actor: { kind: 'system', label: 'aurum-attention' },
      rationale: 'unprompted goal-gap sweep of the nightly cycle',
    });

    // The decision: one derived, material, previously-uncovered gap.
    expect(run.counts).toEqual({ total: 1, promoted: 1, dismissed: 0, alreadyCovered: 0 });
    const candidate = run.candidates[0]!;
    expect(candidate.source).toBe('derived');
    expect(candidate.gapKind).toBe('driver');
    expect(candidate.disposition).toBe('promoted');
    expect(run.originExecutionId).toBe(executionId);

    // THE UNKNOWN — derived by the application, not asked by an operator:
    // the deterministic template, verbatim.
    expect(candidate.missingKnowledge).toBe(
      "What is driving monthly-churn-rate to 8.4 instead of at most 6 for goal 'Reduce monthly churn'?",
    );
    const unknown = await getUnknown(ctx, { unknownId: candidate.epistemicsUnknownId! });
    expect(unknown.status).toBe('open');
    expect(unknown.question).toBe(candidate.missingKnowledge);
    expect(unknown.subject).toEqual({ kind: 'goals.goal', id: goal.id });
    expect(unknown.relatedClaimIds).toEqual([churnClaimId]);
    expect(unknown.note).toContain(run.id);

    // THE MISSION — launched through the missions contract, goal-driven.
    const mission = await getMission(ctx, candidate.missionId!);
    expect(mission.content.status).toBe('active');
    expect(mission.content.unknownIds).toEqual([unknown.id]);
    expect(mission.content.affectedGoals).toEqual([{ goalId: goal.id, label: 'Reduce monthly churn' }]);
    expect(mission.content.knowledgeObjective).toBe(candidate.missingKnowledge);
    expect(mission.content.urgency).toBe('critical');
    expect(mission.content.currentConfidence).toBe(0);
    expect(mission.content.targetConfidence).toBe(0.9);
    expect(mission.content.informationValue).toBe(0.63);
    // the acquisition menu came from the goal's own evidence sources
    expect(mission.content.candidateSources).toEqual([{ kind: 'system', id: null, label: 'Billing CRM' }]);

    // Exactly one unknown and one mission exist for this goal — nothing
    // else manufactured anything.
    expect(await listUnknowns(ctx, { subjectKind: 'goals.goal', subjectId: goal.id })).toHaveLength(1);
    expect(await listMissions(ctx, { affectedGoalId: goal.id })).toHaveLength(1);

    // -----------------------------------------------------------------
    // THE ACQUISITION PLAN — the same execution's knowledge-acquisition
    // stage drives the W012 planner over the discovery-launched mission
    // (stage 6 records nothing: the discovery pass between the stages
    // already identified the unknown and launched the mission).
    // -----------------------------------------------------------------
    await runNextStage(ctx, {
      executionId,
      stage: 'unknown-mission-evaluation',
      unknowns: [],
      missions: [],
    });
    trace = await runNextStage(ctx, {
      executionId,
      stage: 'knowledge-acquisition',
      missionId: mission.id,
    });

    // The execution suspended awaiting the acquisition's input — the
    // plan exists and is linked.
    expect(trace.state).toBe('awaiting_input');
    expect(trace.pending.planId).not.toBeNull();
    const plans = await listAcquisitionPlans(ctx, { missionId: mission.id });
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.id).toBe(trace.pending.planId);
    expect(plan.decision).toBe('selected');
    expect(plan.action).toBe('query-system');
    expect(plan.chosen).toEqual({ kind: 'system', id: null, label: 'Billing CRM' });
    expect(plan.missionId).toBe(mission.id);
    expect(plan.ranked).toHaveLength(1);
    expect(plan.ranked[0]!.status).toBe('eligible');

    // -----------------------------------------------------------------
    // The chain, asserted end to end by linked ids: every consequential
    // step is reconstructable (§24) —
    //   execution → (goal evaluation) → discovery run → candidate →
    //   unknown + mission → acquisition plan ← execution.pending
    // -----------------------------------------------------------------
    expect(run.originExecutionId).toBe(executionId);
    expect(candidate.runId).toBe(run.id);
    expect(mission.content.unknownIds).toContain(candidate.epistemicsUnknownId);
    expect(plan.missionId).toBe(candidate.missionId);
    expect(trace.pending.planId).toBe(plan.id);
    // and the evidence basis of the unknown traces back to the cycle's
    // own observations through the claim (claims cite observations).
    const claimStep = trace.steps.find((step) => step.stage === 'epistemic-evaluation')!;
    expect((claimStep.result as { claimIds: string[] }).claimIds).toContain(
      unknown.relatedClaimIds[0]!,
    );
  });
});
