// The ADR-0019 Required-verification fixture for W054 — Capability Outcome
// Learning. ADR-0019's normative verification clause, verbatim:
//
//   "A fixture must show a successful and a failed intervention each
//    changing future recommendation quality without changing policy, and
//    prove no direct path from outcome labels to recommendations bypasses
//    the recorded learning update."
//
// Scenario — one synthetic tenant (the "company"), a test-side
// RECOMMENDATION PRODUCER that mimics exactly what a later similar
// recommendation (the W013 cognition / W053 CompanyModel consumption path)
// is architecturally allowed to do: consult the outcomes module's prior
// surface (`getInterventionPriors`) and derive the deterministic
// `priorRecommendationSignal`. Everything else the fixture drives through
// the real module contracts:
//
//   1. WITHOUT CHANGING POLICY — the tenant's action-authority policy
//      (the actions module W009 owns it) is seeded with a real row and
//      snapshotted before and after the whole learning cycle; the
//      snapshots are deep-equal. The learning cycle touches no policy
//      surface at all — the improvement is attributable to the recorded
//      learning updates only (lock 14: learning cannot silently override
//      policy).
//   2. A SUCCESSFUL INTERVENTION — recruit_agent on 'invoice processing'
//      (baseline 120, expected 150, realized 175): before learning the
//      recommendation for that (kind, capability) is cold
//      (insufficient-evidence, unadjusted expectation); after the recorded
//      learning update it is evidence-informed (stance 'favor', the
//      learned +25 mean-variance correction applied to the next
//      expectation).
//   3. A FAILED INTERVENTION — build_extension on 'report generation'
//      (baseline 9, expected 8 at_most, realized 12): after the recorded
//      learning update the recommendation turns cautious (stance
//      'caution', successRate 0) AND THE FAILED INTERVENTION IS RETAINED
//      as negative evidence (still queryable, polarity 'negative',
//      counted in the prior's failures) — the storage layer refuses
//      UPDATE/DELETE/TRUNCATE, so the retention is enforced, not promised.
//      A second failed intervention (build_extension on 'invoice
//      processing') lets a later recommendation COMPARE acquisition
//      options by learned priors: recruit_agent (favor) outranks
//      build_extension (caution) for the same capability.
//   4. NO DIRECT PATH FROM OUTCOME LABELS TO RECOMMENDATIONS — three
//      proofs:
//        a. an outcome is defined, measured and SETTLED but the learning
//           update is not committed: the recommendation surface for that
//           key does not move (settling alone changes nothing);
//        b. only `realizeIntervention` — the explicit, evidence-linked
//           learning update — opens the channel, and the version row
//           carries its provenance (triggering intervention, evidence ids);
//        c. a synthetic HIDDEN GROUND-TRUTH LABEL (the simulator-style
//           secret, planted as outcome-side note text where a leak would
//           surface) never appears in the recommendation-facing rows, and
//           those rows carry aggregates + evidence references only — no
//           per-intervention assessment strings at all.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  listAuthorityPolicies,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import * as learning from '@/modules/learning/contract';
import type { DefineOutcomeInput } from '@/modules/learning/contract';
import * as outcomes from '../contract';
import type { Intervention, InterventionKind } from '../types';
import { priorRecommendationSignal } from '../validation';
import { runMigrations } from '../../../../scripts/migrate';

const { defineOutcome, recordMeasurement, settleOutcome } = learning;
const { getIntervention, getInterventionPriors, realizeIntervention, recordIntervention } = outcomes;

const TENANT = newId();
const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const GOAL_ID = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const RECOMMENDATION_ID = '7f9a5b3d-8c1e-4d4f-9e2b-3a5c7d9e1f3a';

/** The synthetic company's hidden ground truth — lives ONLY in the simulator (this test). */
const HIDDEN_TRUTH_LABEL = 'GROUND-TRUTH::success=false::simulator-secret-3f9a';

function member(): TenantContext {
  return { tenantId: TENANT, principalId: newId(), authority: [] };
}

function admin(): TenantContext {
  return { tenantId: TENANT, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
}

function outcomeInput(overrides: Partial<DefineOutcomeInput> = {}): DefineOutcomeInput {
  return {
    subject: { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'capability-gap play' },
    metricName: 'value per week',
    metricUnit: 'units',
    direction: 'at_least',
    baseline: 120,
    expected: 150,
    horizon: null,
    affectedGoals: [{ goalId: GOAL_ID, label: 'operational efficiency' }],
    originExecutionId: null,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'capability-gap cycle',
    ...overrides,
  };
}

/**
 * Runs one intervention through the full ADR-0019 chain — baseline →
 * expected → intervention record → observed → realized → learning update —
 * unless `withholdLearningUpdate` is set, in which case the chain stops
 * after the outcome settles (the no-leak control arm).
 */
async function runIntervention(
  ctx: TenantContext,
  opts: {
    kind: InterventionKind;
    capabilityLabel: string;
    direction: 'at_least' | 'at_most';
    baseline: number;
    expected: number;
    realized: number;
    withholdLearningUpdate?: boolean;
    hiddenTruthInNotes?: boolean;
  },
): Promise<Intervention> {
  const outcome = await defineOutcome(ctx, outcomeInput({
    direction: opts.direction,
    baseline: opts.baseline,
    expected: opts.expected,
    metricName: `${opts.capabilityLabel} value per week`,
  }));
  const intervention = await recordIntervention(ctx, {
    kind: opts.kind,
    capabilityLabel: opts.capabilityLabel,
    target: null,
    originGoalIds: [{ goalId: GOAL_ID, label: 'operational efficiency' }],
    originRecommendationId: RECOMMENDATION_ID,
    authorizationRef: { kind: 'action_request', label: 'human approval #1' },
    originExecutionId: null,
    outcomeId: outcome.id,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'close the capability gap',
  });
  const measurement = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value: opts.realized,
    // the simulator's hidden truth is planted where a leak would surface:
    // outcome-side note text
    note: opts.hiddenTruthInNotes === true ? HIDDEN_TRUTH_LABEL : null,
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  await settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: measurement.id,
    note: opts.hiddenTruthInNotes === true ? HIDDEN_TRUTH_LABEL : null,
    actor: { kind: 'person', id: PERSON_ID },
  });
  if (opts.withholdLearningUpdate === true) {
    return getIntervention(ctx, intervention.id);
  }
  return realizeIntervention(ctx, {
    interventionId: intervention.id,
    actor: { kind: 'person', id: PERSON_ID },
  });
}

/**
 * THE RECOMMENDATION PRODUCER — the test-side stand-in for the sanctioned
 * consumption path (what W013/W053/W056 do for a later similar
 * recommendation): consult the RECORDED prior surface and derive the
 * deterministic signal. It reads NOTHING else from the outcomes module —
 * that is the architectural claim under test.
 */
function recommend(
  ctx: TenantContext,
  kind: InterventionKind,
  capabilityLabel: string,
  baseExpected: number,
): () => Promise<{
  stance: 'insufficient_evidence' | 'favor' | 'mixed' | 'caution';
  adjustedExpected: number;
  successRate: number | null;
  evidenceInterventionIds: string[];
}> {
  return async () => {
    const priors = await getInterventionPriors(ctx, {
      interventionKind: kind,
      capabilityKey: capabilityLabel,
    });
    const prior = priors[0] ?? null;
    if (prior === null) {
      return {
        stance: 'insufficient_evidence',
        adjustedExpected: baseExpected,
        successRate: null,
        evidenceInterventionIds: [],
      };
    }
    const signal = priorRecommendationSignal(prior);
    return {
      stance: signal.stance,
      adjustedExpected: baseExpected + signal.meanVariance,
      successRate: signal.successRate,
      evidenceInterventionIds: prior.evidenceInterventionIds,
    };
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
  // A real tenant policy row, so "without changing policy" is proven
  // against actual state, not an empty tenant: agent recruitment stays
  // approval-gated throughout the fixture.
  await setAuthorityPolicy(admin(), {
    actionKind: 'agent-recruitment',
    approvalLevels: ['EXECUTE'],
    note: 'fixture baseline policy — approval-gated recruitment',
  });
});

afterAll(async () => {
  await closeDb();
});

describe('ADR-0019 verification — capability outcome learning', () => {
  it('a successful and a failed intervention each change future recommendation quality without changing policy, and no outcome label bypasses the recorded learning update', async () => {
    const ctx = member();

    // ---- 0. the policy baseline (before any learning) -------------------
    const policyBefore = await listAuthorityPolicies(admin(), { limit: 500 });

    // ---- 1. cold start: no learned evidence anywhere -------------------
    const laterInvoiceAgent = recommend(ctx, 'recruit_agent', 'Invoice Processing', 150);
    const laterReportBuild = recommend(ctx, 'build_extension', 'Report Generation', 8);
    const laterInvoiceBuild = recommend(ctx, 'build_extension', 'Invoice Processing', 150);

    const coldInvoiceAgent = await laterInvoiceAgent();
    const coldReportBuild = await laterReportBuild();
    const coldInvoiceBuild = await laterInvoiceBuild();
    for (const cold of [coldInvoiceAgent, coldReportBuild, coldInvoiceBuild]) {
      expect(cold.stance).toBe('insufficient_evidence');
      expect(cold.successRate).toBeNull();
      expect(cold.evidenceInterventionIds).toEqual([]);
    }
    expect(coldInvoiceAgent.adjustedExpected).toBe(150);

    // ---- 2. a SUCCESSFUL intervention (recruit_agent, invoice) ----------
    const success = await runIntervention(ctx, {
      kind: 'recruit_agent',
      capabilityLabel: 'Invoice Processing',
      direction: 'at_least',
      baseline: 120,
      expected: 150,
      realized: 175,
    });
    expect(success.status).toBe('realized');
    expect(success.realization!.assessment).toBe('exceeded');
    expect(success.realization!.polarity).toBe('positive');

    // ...changes future recommendation quality for that (kind, capability):
    const learnedInvoiceAgent = await laterInvoiceAgent();
    expect(learnedInvoiceAgent.stance).toBe('favor');
    expect(learnedInvoiceAgent.successRate).toBe(1);
    expect(learnedInvoiceAgent.adjustedExpected).toBe(175); // 150 + learned +25
    expect(learnedInvoiceAgent.evidenceInterventionIds).toEqual([success.id]);

    // ---- 3. a FAILED intervention (build_extension, reports) ------------
    const failure = await runIntervention(ctx, {
      kind: 'build_extension',
      capabilityLabel: 'Report Generation',
      direction: 'at_most',
      baseline: 9,
      expected: 8,
      realized: 12,
      hiddenTruthInNotes: true, // the hidden ground truth stays outcome-side
    });
    expect(failure.status).toBe('realized');
    expect(failure.realization!.assessment).toBe('missed');
    expect(failure.realization!.polarity).toBe('negative');

    // ...changes future recommendation quality for that (kind, capability):
    const learnedReportBuild = await laterReportBuild();
    expect(learnedReportBuild.stance).toBe('caution');
    expect(learnedReportBuild.successRate).toBe(0);
    expect(learnedReportBuild.adjustedExpected).toBe(12); // 8 + learned +4 (worse)

    // ...and the failed intervention is RETAINED as negative evidence:
    const retained = await getIntervention(ctx, failure.id);
    expect(retained.realization!.polarity).toBe('negative');
    const reportPrior = (
      await getInterventionPriors(ctx, {
        interventionKind: 'build_extension',
        capabilityKey: 'report-generation',
      })
    )[0]!;
    expect(reportPrior.failures).toBe(1);
    expect(reportPrior.evidenceInterventionIds).toContain(failure.id);
    // retention is ENFORCED, not promised: the storage layer refuses erasure
    await expect(
      getDb().query(`DELETE FROM interventions WHERE tenant_id = $1 AND id = $2`, [TENANT, failure.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM intervention_priors WHERE tenant_id = $1`, [TENANT]),
    ).rejects.toThrow(/append-only/);

    // ---- 4. a second failed intervention lets later recommendations ----
    // ---- compare acquisition options BY LEARNED PRIORS -----------------
    await runIntervention(ctx, {
      kind: 'build_extension',
      capabilityLabel: 'Invoice Processing',
      direction: 'at_least',
      baseline: 120,
      expected: 150,
      realized: 80,
    });
    const invoiceOptions = await getInterventionPriors(ctx, {
      capabilityKey: 'Invoice Processing',
    });
    expect(invoiceOptions).toHaveLength(2);
    const ranked = [...invoiceOptions].sort((a, b) => b.successRate - a.successRate);
    expect(ranked[0]!.interventionKind).toBe('recruit_agent'); // favor
    expect(ranked[0]!.successRate).toBe(1);
    expect(ranked[1]!.interventionKind).toBe('build_extension'); // caution
    expect(ranked[1]!.successRate).toBe(0);
    const learnedInvoiceBuild = await laterInvoiceBuild();
    expect(learnedInvoiceBuild.stance).toBe('caution');
    expect(learnedInvoiceBuild.adjustedExpected).toBe(80); // 150 + learned −70

    // ---- 5. NO DIRECT PATH FROM OUTCOME LABELS --------------------------
    // A third intervention's outcome is defined, measured and SETTLED, but
    // the explicit learning update is withheld: the recommendation surface
    // for its key does not move — settling alone changes nothing.
    const withheld = await runIntervention(ctx, {
      kind: 'train_employee',
      capabilityLabel: 'CRM Data Entry',
      direction: 'at_least',
      baseline: 40,
      expected: 55,
      realized: 70,
      withholdLearningUpdate: true,
    });
    expect(withheld.outcomeSummary.status).toBe('settled'); // the evidence exists…
    expect(
      await getInterventionPriors(ctx, { capabilityKey: 'crm-data-entry' }),
    ).toHaveLength(0); // …but the recommendation surface stays cold
    const coldWithheld = await recommend(ctx, 'train_employee', 'CRM Data Entry', 55)();
    expect(coldWithheld.stance).toBe('insufficient_evidence');

    // Only the explicit, evidence-linked learning update opens the channel…
    await realizeIntervention(ctx, {
      interventionId: withheld.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    const openedPriors = await getInterventionPriors(ctx, { capabilityKey: 'crm-data-entry' });
    expect(openedPriors).toHaveLength(1);
    expect(openedPriors[0]!.triggeredByInterventionId).toBe(withheld.id);
    expect(openedPriors[0]!.evidenceInterventionIds).toEqual([withheld.id]);
    expect(openedPriors[0]!.priorVersion).toBe(1);

    // …and the recommendation-facing rows carry aggregates + evidence
    // REFERENCES only: the hidden ground-truth label planted in outcome-side
    // notes never leaks, and no per-intervention assessment strings appear.
    const allPriors = await getInterventionPriors(ctx, {});
    expect(allPriors.length).toBeGreaterThanOrEqual(4);
    const serialized = JSON.stringify(allPriors);
    expect(serialized).not.toContain(HIDDEN_TRUTH_LABEL);
    expect(serialized).not.toContain('GROUND-TRUTH');
    expect(serialized).not.toContain('simulator-secret');
    expect(serialized).not.toContain('assessment');
    expect(serialized).not.toContain('missed');
    expect(serialized).not.toContain('exceeded');
    expect(serialized).not.toContain('realizedValue');
    // the hidden label lives on the outcome side (evidence surface), where
    // it belongs — proving the assertion above is not vacuous
    const outcomeSide = await learning.getOutcome(ctx, failure.outcomeId);
    expect(JSON.stringify(outcomeSide)).toContain(HIDDEN_TRUTH_LABEL);

    // ---- 6. WITHOUT CHANGING POLICY --------------------------------------
    const policyAfter = await listAuthorityPolicies(admin(), { limit: 500 });
    expect(policyAfter).toEqual(policyBefore);
    expect(policyAfter.length).toBeGreaterThan(0); // proven against real rows
  });
});
