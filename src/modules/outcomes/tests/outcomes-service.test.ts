// Integration tests for the outcomes module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W054 acceptance:
//
//  * THE CHAIN: every intervention ties to exactly ONE measuring learning
//    outcome (validated readable through the learning contract; foreign and
//    missing outcome ids uniformly invalid_outcome_ref — no existence
//    leak), snapshots the outcome's immutable definition (metric,
//    direction, baseline, expected) at record time, and composes the
//    observed leg live through the learning contract. Recording against a
//    settled or abandoned outcome is refused (the record commits BEFORE
//    realization), and a second intervention on the same outcome is
//    refused (the 1:1 measuring tie).
//  * REALIZED VALUE AND VARIANCE RECORDED: realizeIntervention requires
//    the outcome to have settled and consumes the learning module's FROZEN
//    realization — realized value, variance vs expected, improvement vs
//    baseline, assessment, grounding measurement — never a re-derivation;
//    the evidence polarity is the assessment's shadow (met/exceeded →
//    positive, missed → negative). Terminal states are dead ends; a raced
//    terminal write loses cleanly.
//  * NEGATIVE EVIDENCE RETAINED: failed interventions stay realized with
//    polarity 'negative', stay queryable (polarity filter), and can never
//    be abandoned once the measuring outcome settled (no evidence
//    suppression). The storage layer rejects UPDATE/DELETE/TRUNCATE on all
//    three tables outright (triggers).
//  * LEARNED PRIORS: realizeIntervention appends exactly one versioned
//    prior per realization — the deterministic aggregate over every
//    realized intervention of the (kind, capability key) with full
//    provenance (triggering intervention, evidence ids, principal). The
//    current-prior read returns the highest version per key; the version
//    history ascends; priors are per (kind, key) and per tenant.
//  * NO LEAK: settling outcomes without realizing interventions moves
//    NOTHING on the recommendation-facing prior surface; outcome-side
//    labels (measurement/settlement notes) never appear in prior rows.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).
//  * the listing surfaces: kind/key/status/polarity/outcome/search/limit
//    filters over the derived current views, newest first.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as learning from '@/modules/learning/contract';
import type { Outcome } from '@/modules/learning/contract';
import { OutcomesError } from '../errors';
import * as outcomes from '../contract';
import type { Intervention, RecordInterventionInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  defineOutcome,
  getOutcome: getLearningOutcome,
  recordMeasurement,
  settleOutcome,
  abandonOutcome: abandonLearningOutcome,
} = learning;

const {
  abandonIntervention,
  getIntervention,
  getInterventionPriors,
  listInterventionPriorVersions,
  listInterventions,
  realizeIntervention,
  recordIntervention,
} = outcomes;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId();
const tenantB = newId();
const tenantIso = newId();
const tenantOutcome = newId();
const tenantLifecycle = newId();
const tenantPriors = newId();
const tenantPriorsIso = newId();
const tenantStorage = newId();
const tenantList = newId();
const tenantNoLeak = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const GOAL_ID = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const RECOMMENDATION_ID = '7f9a5b3d-8c1e-4d4f-9e2b-3a5c7d9e1f3a';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OutcomesError);
    expect((error as OutcomesError).code).toBe(code);
  }
}

/** A full W040 measuring outcome, parameterized for the suites below. */
function outcomeInput(overrides: Partial<learning.DefineOutcomeInput> = {}): learning.DefineOutcomeInput {
  return {
    subject: { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'AP automation play' },
    metricName: 'invoices processed per week',
    metricUnit: 'invoices',
    direction: 'at_least',
    baseline: 120,
    expected: 150,
    horizon: null,
    affectedGoals: [{ goalId: GOAL_ID, label: 'AP efficiency' }],
    originExecutionId: null,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'cognition capability-gap cycle',
    ...overrides,
  };
}

/** A full W054 intervention record input, parameterized for the suites below. */
function recordInput(overrides: Partial<RecordInterventionInput> = {}): RecordInterventionInput {
  return {
    kind: 'recruit_agent',
    capabilityLabel: 'Invoice Processing',
    target: { kind: 'recruitment_proposal', label: 'Proposal #12' },
    originGoalIds: [{ goalId: GOAL_ID, label: 'AP efficiency' }],
    originRecommendationId: RECOMMENDATION_ID,
    authorizationRef: { kind: 'action_request', label: 'approval #7' },
    originExecutionId: null,
    outcomeId: newId(), // callers override with the seeded outcome
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'close the AP capability gap',
    ...overrides,
  };
}

/**
 * Seeds the full chain for one intervention: an OPEN outcome, the
 * intervention recorded against it, and (when `realized` is given) one
 * measurement, the settlement and the explicit learning update. Returns
 * the intervention's CURRENT view plus the measuring outcome's view.
 */
async function seedIntervention(
  ctx: TenantContext,
  opts: {
    kind?: RecordInterventionInput['kind'];
    label?: string;
    direction?: 'at_least' | 'at_most';
    baseline?: number;
    expected?: number;
    realized?: number;
    note?: string;
  } = {},
): Promise<{ intervention: Intervention; outcome: Outcome }> {
  const direction = opts.direction ?? 'at_least';
  const expected = opts.expected ?? 150;
  const baseline = opts.baseline ?? 120;
  const outcome = await defineOutcome(ctx, outcomeInput({ direction, baseline, expected }));
  const intervention = await recordIntervention(
    ctx,
    recordInput({
      kind: opts.kind ?? 'recruit_agent',
      capabilityLabel: opts.label ?? 'Invoice Processing',
      outcomeId: outcome.id,
    }),
  );
  if (opts.realized === undefined) {
    return { intervention, outcome: await getLearningOutcome(ctx, outcome.id) };
  }
  const measurement = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value: opts.realized,
    note: opts.note,
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  const settled = await settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: measurement.id,
    actor: { kind: 'person', id: PERSON_ID },
  });
  const realizedView = await realizeIntervention(ctx, {
    interventionId: intervention.id,
    actor: { kind: 'person', id: PERSON_ID },
  });
  return { intervention: realizedView, outcome: settled };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// recordIntervention — the chain's tie and snapshot
// ---------------------------------------------------------------------------

describe('recordIntervention — the tie, the snapshot, the observed leg', () => {
  it('ties the intervention to one open outcome and snapshots its definition', async () => {
    const ctx = member(tenantA);
    const outcome = await defineOutcome(ctx, outcomeInput({ baseline: 90, expected: 130 }));
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));

    expect(intervention.tenantId).toBe(tenantA);
    expect(intervention.status).toBe('active');
    expect(intervention.outcomeId).toBe(outcome.id);
    expect(intervention.metric).toEqual({
      metricName: 'invoices processed per week',
      metricUnit: 'invoices',
      direction: 'at_least',
      baseline: 90,
      expected: 130,
    });
    expect(intervention.capabilityKey).toBe('invoice-processing');
    expect(intervention.capabilityLabel).toBe('Invoice Processing');
    expect(intervention.target).toEqual({ kind: 'recruitment_proposal', id: null, label: 'Proposal #12' });
    expect(intervention.originGoalIds).toEqual([{ goalId: GOAL_ID, label: 'AP efficiency' }]);
    expect(intervention.originRecommendationId).toBe(RECOMMENDATION_ID);
    expect(intervention.authorizationRef).toEqual({ kind: 'action_request', id: null, label: 'approval #7' });
    expect(intervention.realization).toBeNull();
    expect(intervention.abandonment).toBeNull();
    expect(intervention.outcomeSummary).toMatchObject({
      outcomeId: outcome.id,
      status: 'open',
      measurementCount: 0,
      latestObservedValue: null,
    });
    expect(intervention.recordedByPrincipal).toBeTruthy();
    expect(() => new Date(intervention.createdAt)).not.toThrow();
  });

  it('composes the observed leg live through the learning contract', async () => {
    const ctx = member(tenantA);
    const outcome = await defineOutcome(ctx, outcomeInput());
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));

    await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 135,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    const viewed = await getIntervention(ctx, intervention.id);
    expect(viewed.outcomeSummary).toMatchObject({
      status: 'open',
      measurementCount: 1,
      latestObservedValue: 135,
    });
  });

  it('is a 1:1 measuring tie — a second intervention on the same outcome conflicts', async () => {
    const ctx = member(tenantA);
    const outcome = await defineOutcome(ctx, outcomeInput());
    await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));
    await expectCode('intervention_conflict', () =>
      recordIntervention(ctx, recordInput({ outcomeId: outcome.id, capabilityLabel: 'Other' })),
    );
  });

  it('refuses settled and abandoned outcomes — the record commits BEFORE realization', async () => {
    const ctx = member(tenantA);
    const settled = await defineOutcome(ctx, outcomeInput());
    const measurement = await recordMeasurement(ctx, {
      outcomeId: settled.id,
      value: 160,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: settled.id,
      measurementId: measurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_transition', () =>
      recordIntervention(ctx, recordInput({ outcomeId: settled.id })),
    );

    const abandoned = await defineOutcome(ctx, outcomeInput());
    await abandonLearningOutcome(ctx, {
      outcomeId: abandoned.id,
      reason: 'measurement plan withdrawn',
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_transition', () =>
      recordIntervention(ctx, recordInput({ outcomeId: abandoned.id })),
    );
  });

  it('validates the outcome through the learning contract — no existence leak', async () => {
    const ctx = member(tenantOutcome);
    // foreign-tenant outcome
    const foreign = await defineOutcome(member(tenantB), outcomeInput());
    await expectCode('invalid_outcome_ref', () =>
      recordIntervention(ctx, recordInput({ outcomeId: foreign.id })),
    );
    // missing outcome
    await expectCode('invalid_outcome_ref', () =>
      recordIntervention(ctx, recordInput({ outcomeId: newId() })),
    );
    // malformed outcome never reaches the cross-module check at all
    await expectCode('invalid_intervention_input', () =>
      recordIntervention(ctx, recordInput({ outcomeId: 'not-a-uuid' as never })),
    );
  });

  it('rejects malformed input at the contract boundary', async () => {
    const ctx = member(tenantA);
    const outcome = await defineOutcome(ctx, outcomeInput());
    await expectCode('invalid_intervention_input', () =>
      recordIntervention(ctx, recordInput({ outcomeId: outcome.id, kind: 'reorg' as never })),
    );
    await expectCode('invalid_intervention_input', () =>
      recordIntervention(ctx, recordInput({ outcomeId: outcome.id, capabilityLabel: '  ' })),
    );
    await expectCode('invalid_intervention_input', () =>
      recordIntervention(ctx, { ...recordInput({ outcomeId: outcome.id }), smuggled: true } as never),
    );
    await expectCode('invalid_context', () =>
      recordIntervention({ tenantId: ' ', principalId: 'p', authority: [] }, recordInput()),
    );
  });
});

// ---------------------------------------------------------------------------
// realizeIntervention — the frozen record and the learning update
// ---------------------------------------------------------------------------

describe('realizeIntervention — realized value, variance and the prior', () => {
  it('consumes the learning module\u2019s FROZEN realization — never a re-derivation', async () => {
    const ctx = member(tenantLifecycle);
    // at_least: realized 175 > expected 150 → exceeded; variance +25
    const { intervention, outcome } = await seedIntervention(ctx, { realized: 175 });

    expect(intervention.status).toBe('realized');
    expect(intervention.realization).not.toBeNull();
    expect(intervention.realization!.realizedValue).toBe(outcome.realization!.realizedValue);
    expect(intervention.realization!.varianceVsExpected).toBe(
      outcome.realization!.varianceVsExpected,
    );
    expect(intervention.realization!.varianceVsExpected).toBe(25);
    expect(intervention.realization!.improvementVsBaseline).toBe(
      outcome.realization!.improvementVsBaseline,
    );
    expect(intervention.realization!.assessment).toBe('exceeded');
    expect(intervention.realization!.polarity).toBe('positive');
    expect(intervention.realization!.fromMeasurementId).toBe(
      outcome.realization!.fromMeasurementId,
    );
    expect(intervention.realization!.outcomeSettledAt).toBe(outcome.realization!.settledAt);
    expect(intervention.realization!.realizedByPrincipal).toBeTruthy();
    expect(intervention.outcomeSummary.status).toBe('settled');
    expect(intervention.outcomeSummary.measurementCount).toBe(1);
  });

  it('maps missed settlements to RETAINED negative evidence', async () => {
    const ctx = member(tenantLifecycle);
    const { intervention } = await seedIntervention(ctx, { realized: 100 }); // < expected 150
    expect(intervention.realization!.assessment).toBe('missed');
    expect(intervention.realization!.polarity).toBe('negative');
    expect(intervention.realization!.varianceVsExpected).toBe(-50);

    // negative evidence stays first-class queryable
    const negative = await listInterventions(ctx, { polarity: 'negative' });
    expect(negative.some((i) => i.id === intervention.id)).toBe(true);
  });

  it('requires the measuring outcome to have settled', async () => {
    const ctx = member(tenantLifecycle);
    const outcome = await defineOutcome(ctx, outcomeInput());
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));
    await expectCode('invalid_transition', () =>
      realizeIntervention(ctx, { interventionId: intervention.id, actor: { kind: 'person', id: PERSON_ID } }),
    );

    const abandonedOutcome = await defineOutcome(ctx, outcomeInput());
    const abandonedIntervention = await recordIntervention(
      ctx,
      recordInput({ outcomeId: abandonedOutcome.id }),
    );
    await abandonLearningOutcome(ctx, {
      outcomeId: abandonedOutcome.id,
      reason: 'measurement plan withdrawn',
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_transition', () =>
      realizeIntervention(ctx, {
        interventionId: abandonedIntervention.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });

  it('is terminal — second realizations and post-terminal abandons refuse', async () => {
    const ctx = member(tenantLifecycle);
    const { intervention } = await seedIntervention(ctx, { realized: 160 });
    await expectCode('invalid_transition', () =>
      realizeIntervention(ctx, {
        interventionId: intervention.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_transition', () =>
      abandonIntervention(ctx, {
        interventionId: intervention.id,
        reason: 'too late',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });

  it('a raced terminal write loses cleanly', async () => {
    const ctx = member(tenantLifecycle);
    const outcome = await defineOutcome(ctx, outcomeInput());
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 155,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });

    // Two realizations race; the definition-row lock serializes them and
    // the loser sees the winner's terminal record.
    const first = realizeIntervention(ctx, {
      interventionId: intervention.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    const second = realizeIntervention(ctx, {
      interventionId: intervention.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    const [winner, loser] = await Promise.allSettled([first, second]);
    const codes = new Set([winner.status, loser.status]);
    expect(codes.has('fulfilled')).toBe(true);
    expect(codes.has('rejected')).toBe(true);
    if (loser.status === 'rejected') {
      expect((loser.reason as OutcomesError).code).toBe('invalid_transition');
    }
    if (winner.status === 'rejected') {
      expect((winner.reason as OutcomesError).code).toBe('invalid_transition');
    }
    const view = await getIntervention(ctx, intervention.id);
    expect(view.status).toBe('realized');
    // exactly one prior version was appended for THIS intervention (the
    // race loser appended none)
    const versions = await listInterventionPriorVersions(ctx, {
      interventionKind: 'recruit_agent',
      capabilityKey: 'invoice-processing',
    });
    expect(
      versions.filter((v) => v.triggeredByInterventionId === intervention.id),
    ).toHaveLength(1);
    expect(versions[versions.length - 1]!.evidenceInterventionIds).toContain(intervention.id);
  });
});

// ---------------------------------------------------------------------------
// abandonIntervention — terminal, reason-gated, no evidence suppression
// ---------------------------------------------------------------------------

describe('abandonIntervention', () => {
  it('terminates with a required reason and contributes NO prior evidence', async () => {
    const ctx = member(tenantLifecycle);
    const outcome = await defineOutcome(ctx, outcomeInput());
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));

    const abandoned = await abandonIntervention(ctx, {
      interventionId: intervention.id,
      reason: 'vendor contract withdrawn',
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.abandonment).toMatchObject({ reason: 'vendor contract withdrawn' });
    expect(abandoned.realization).toBeNull();

    // terminal: nothing more accepts this intervention
    await expectCode('invalid_transition', () =>
      abandonIntervention(ctx, {
        interventionId: intervention.id,
        reason: 'again',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_transition', () =>
      realizeIntervention(ctx, {
        interventionId: intervention.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );

    // an abandonment never writes a prior (nothing was realized)
    const priors = await getInterventionPriors(ctx, { capabilityKey: 'invoice-processing' });
    expect(priors.filter((p) => p.triggeredByInterventionId === intervention.id)).toHaveLength(0);
  });

  it('cannot suppress settled evidence — abandonment after settlement refuses', async () => {
    const ctx = member(tenantLifecycle);
    const outcome = await defineOutcome(ctx, outcomeInput());
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 90, // a miss
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_transition', () =>
      abandonIntervention(ctx, {
        interventionId: intervention.id,
        reason: 'make the failure disappear',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // the failed evidence must still be realizable and retained
    const realized = await realizeIntervention(ctx, {
      interventionId: intervention.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(realized.realization!.polarity).toBe('negative');
  });

  it('requires a reason and validates input shape', async () => {
    const ctx = member(tenantLifecycle);
    const outcome = await defineOutcome(ctx, outcomeInput());
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));
    await expectCode('invalid_abandonment_input', () =>
      abandonIntervention(ctx, {
        interventionId: intervention.id,
        reason: '   ',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_abandonment_input', () =>
      abandonIntervention(ctx, {
        interventionId: 'not-a-uuid',
        reason: 'x',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The learned priors
// ---------------------------------------------------------------------------

describe('the learned priors — versioned, aggregated, provenance-carrying', () => {
  it('appends one version per realization with the full deterministic aggregate', async () => {
    const ctx = member(tenantPriors);
    const first = await seedIntervention(ctx, { realized: 175, label: 'Invoice Processing' }); // exceeded
    const second = await seedIntervention(ctx, { realized: 150, label: 'invoice processing' }); // met (same key)
    const third = await seedIntervention(ctx, { realized: 100, label: 'Invoice  Processing' }); // missed (same key)

    const current = await getInterventionPriors(ctx, { capabilityKey: 'Invoice Processing' });
    expect(current).toHaveLength(1);
    const prior = current[0]!;
    expect(prior.interventionKind).toBe('recruit_agent');
    expect(prior.capabilityKey).toBe('invoice-processing');
    expect(prior.priorVersion).toBe(3);
    expect(prior.sampleSize).toBe(3);
    expect(prior.successes).toBe(2);
    expect(prior.failures).toBe(1);
    expect(prior.successRate).toBeCloseTo(2 / 3, 12);
    expect(prior.expectedSum).toBe(450);
    expect(prior.realizedSum).toBe(425);
    expect(prior.netVariance).toBe(-25);
    expect(prior.meanVariance).toBeCloseTo(-25 / 3, 12);
    expect(prior.triggeredByInterventionId).toBe(third.intervention.id);
    expect(prior.evidenceInterventionIds).toEqual([
      first.intervention.id,
      second.intervention.id,
      third.intervention.id,
    ]);
    expect(prior.updatedByPrincipal).toBeTruthy();
    expect(() => new Date(prior.updatedAt)).not.toThrow();

    const history = await listInterventionPriorVersions(ctx, {
      interventionKind: 'recruit_agent',
      capabilityKey: 'invoice-processing',
    });
    expect(history.map((v) => v.priorVersion)).toEqual([1, 2, 3]);
    expect(history[0]!.sampleSize).toBe(1);
    expect(history[1]!.sampleSize).toBe(2);
    expect(history[2]!.sampleSize).toBe(3);
    expect(history.map((v) => v.triggeredByInterventionId)).toEqual([
      first.intervention.id,
      second.intervention.id,
      third.intervention.id,
    ]);
  });

  it('keys priors per (kind, capability) — different kinds learn separately', async () => {
    const ctx = member(tenantPriors);
    await seedIntervention(ctx, { kind: 'recruit_agent', label: 'Report Generation', realized: 160 });
    await seedIntervention(ctx, { kind: 'build_extension', label: 'Report Generation', realized: 90 });
    await seedIntervention(ctx, { kind: 'build_extension', label: 'Report  Generation', realized: 155 });

    const forCapability = await getInterventionPriors(ctx, { capabilityKey: 'report generation' });
    expect(forCapability.map((p) => p.interventionKind).sort()).toEqual([
      'build_extension',
      'recruit_agent',
    ]);
    const agents = await getInterventionPriors(ctx, {
      interventionKind: 'recruit_agent',
      capabilityKey: 'Report Generation',
    });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.sampleSize).toBe(1);
    const builds = await getInterventionPriors(ctx, {
      interventionKind: 'build_extension',
      capabilityKey: 'report-generation',
    });
    expect(builds).toHaveLength(1);
    expect(builds[0]!.sampleSize).toBe(2);
    expect(builds[0]!.successes).toBe(1);
    expect(builds[0]!.failures).toBe(1);
  });

  it('returns the CURRENT prior per key (highest version), newest update first', async () => {
    const ctx = member(tenantPriors);
    await seedIntervention(ctx, { label: 'Churn Play', realized: 160 });
    await seedIntervention(ctx, { label: 'Churn Play', realized: 100 });
    const priors = await getInterventionPriors(ctx, {});
    // churn-play's v2 update is the most recent learning event in this tenant
    expect(priors[0]!.capabilityKey).toBe('churn-play');
    expect(priors[0]!.priorVersion).toBe(2);
    expect(priors[0]!.failures).toBe(1);
  });

  it('treats at_most directions correctly through the frozen assessment', async () => {
    const ctx = member(tenantPriors);
    // at_most: realized 6 < expected 8 → exceeded (lower is better)
    const { intervention } = await seedIntervention(ctx, {
      direction: 'at_most',
      baseline: 9,
      expected: 8,
      realized: 6,
      label: 'Error Rate Reduction',
    });
    expect(intervention.realization!.assessment).toBe('exceeded');
    expect(intervention.realization!.polarity).toBe('positive');
    const prior = (await getInterventionPriors(ctx, { capabilityKey: 'error rate reduction' }))[0]!;
    expect(prior.successes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No-leak: only the recorded learning update moves the recommendation surface
// ---------------------------------------------------------------------------

describe('no hidden outcome labels leak into recommendations', () => {
  it('settling an outcome without the learning update moves NOTHING on the prior surface', async () => {
    const ctx = member(tenantNoLeak);
    const outcome = await defineOutcome(ctx, outcomeInput());
    const intervention = await recordIntervention(ctx, recordInput({ outcomeId: outcome.id }));
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 999, // a wild observed value
      note: 'MARKER_OUTCOME_SIDE_NOTE',
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurement.id,
      note: 'MARKER_SETTLEMENT_NOTE',
      actor: { kind: 'person', id: PERSON_ID },
    });

    // The outcome is settled, the evidence exists — but the recorded
    // learning update has NOT happened, so the recommendation-facing
    // surface is still cold for this key.
    const cold = await getInterventionPriors(ctx, { capabilityKey: 'invoice-processing' });
    expect(cold).toHaveLength(0);

    // Only the explicit learning update opens the channel…
    await realizeIntervention(ctx, {
      interventionId: intervention.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    const warm = await getInterventionPriors(ctx, { capabilityKey: 'invoice-processing' });
    expect(warm).toHaveLength(1);
    expect(warm[0]!.sampleSize).toBe(1);
    expect(warm[0]!.triggeredByInterventionId).toBe(intervention.id);

    // …and the prior surface carries aggregates + evidence references only:
    // the outcome-side labels (notes) never appear in it.
    const serialized = JSON.stringify(warm);
    expect(serialized).not.toContain('MARKER_OUTCOME_SIDE_NOTE');
    expect(serialized).not.toContain('MARKER_SETTLEMENT_NOTE');
    expect(serialized).not.toContain('assessment');
    expect(serialized).not.toContain('missed');
    expect(serialized).not.toContain('exceeded');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('keeps every surface tenant-scoped with uniform not-found semantics', async () => {
    const ctxA = member(tenantIso);
    const ctxB = member(tenantB);
    const { intervention } = await seedIntervention(ctxA, { realized: 160 });

    // reads
    await expectCode('intervention_not_found', () => getIntervention(ctxB, intervention.id));
    await expectCode('intervention_not_found', () => getIntervention(ctxB, 'not-a-uuid'));
    // writes by foreign-tenant intervention id
    await expectCode('intervention_not_found', () =>
      realizeIntervention(ctxB, {
        interventionId: intervention.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('intervention_not_found', () =>
      abandonIntervention(ctxB, {
        interventionId: intervention.id,
        reason: 'cross-tenant',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // listings and priors never cross tenants
    expect(await listInterventions(ctxB, {})).toHaveLength(0);
    expect(await getInterventionPriors(ctxB, {})).toHaveLength(0);
    const own = await listInterventions(ctxA, {});
    expect(own.some((i) => i.id === intervention.id)).toBe(true);

    // tenant B learns its own, separate prior for the same key
    await seedIntervention(ctxB, { realized: 100 });
    const priorsA = await getInterventionPriors(ctxA, { capabilityKey: 'invoice-processing' });
    const priorsB = await getInterventionPriors(ctxB, { capabilityKey: 'invoice-processing' });
    expect(priorsA).toHaveLength(1);
    expect(priorsB).toHaveLength(1);
    expect(priorsA[0]!.id).not.toBe(priorsB[0]!.id);
    expect(priorsA[0]!.evidenceInterventionIds).toContain(intervention.id);
    expect(priorsB[0]!.evidenceInterventionIds).not.toContain(intervention.id);
  });

  it('scopes prior version histories per tenant', async () => {
    const ctxA = member(tenantPriorsIso);
    const ctxB = member(tenantB);
    await seedIntervention(ctxA, { label: 'Iso Check', realized: 160 });
    await seedIntervention(ctxA, { label: 'Iso Check', realized: 100 });
    expect(
      (await listInterventionPriorVersions(ctxA, {
        interventionKind: 'recruit_agent',
        capabilityKey: 'iso-check',
      })).length,
    ).toBe(2);
    expect(
      await listInterventionPriorVersions(ctxB, {
        interventionKind: 'recruit_agent',
        capabilityKey: 'iso-check',
      }),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Listing surfaces
// ---------------------------------------------------------------------------

describe('listInterventions', () => {
  beforeAll(async () => {
    const ctx = member(tenantList);
    await seedIntervention(ctx, {
      kind: 'recruit_agent',
      label: 'Invoice Processing',
      realized: 175,
    });
    await seedIntervention(ctx, {
      kind: 'recruit_agent',
      label: 'Invoice Processing',
      realized: 100,
    });
    await seedIntervention(ctx, {
      kind: 'build_extension',
      label: 'Report Generation',
      realized: 90,
    });
    await seedIntervention(ctx, { kind: 'train_employee', label: 'Invoice Processing' }); // stays active
  });

  it('filters by kind, key, status, polarity, outcome and search', async () => {
    const ctx = member(tenantList);
    const byKind = await listInterventions(ctx, { interventionKind: 'recruit_agent' });
    expect(byKind).toHaveLength(2);
    expect(byKind.every((i) => i.kind === 'recruit_agent')).toBe(true);

    const byKey = await listInterventions(ctx, { capabilityKey: 'Invoice Processing' });
    expect(byKey).toHaveLength(3);

    const active = await listInterventions(ctx, { status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0]!.kind).toBe('train_employee');

    const realized = await listInterventions(ctx, { status: 'realized' });
    expect(realized).toHaveLength(3);

    const negative = await listInterventions(ctx, { status: 'realized', polarity: 'negative' });
    expect(negative).toHaveLength(2);
    expect(negative.every((i) => i.realization!.polarity === 'negative')).toBe(true);

    const byOutcome = await listInterventions(ctx, { outcomeId: realized[0]!.outcomeId });
    expect(byOutcome).toHaveLength(1);

    const bySearch = await listInterventions(ctx, { search: 'report' });
    expect(bySearch).toHaveLength(1);
    expect(bySearch[0]!.capabilityLabel).toBe('Report Generation');
  });

  it('lists newest first and honors the limit', async () => {
    const ctx = member(tenantList);
    const all = await listInterventions(ctx, {});
    expect(all).toHaveLength(4);
    for (let index = 1; index < all.length; index += 1) {
      expect(all[index - 1]!.createdAt >= all[index]!.createdAt).toBe(true);
    }
    const limited = await listInterventions(ctx, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((i) => i.id)).toEqual(all.slice(0, 2).map((i) => i.id));
  });

  it('validates query shape', async () => {
    const ctx = member(tenantList);
    await expectCode('invalid_query', () => listInterventions(ctx, { status: 'active', polarity: 'negative' }));
    await expectCode('invalid_query', () => listInterventions(ctx, { limit: 0 }));
    await expectCode('invalid_query', () => listInterventions(ctx, { interventionKind: 'reorg' as never }));
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (append-only)
// ---------------------------------------------------------------------------

describe('storage-level append-only guarantees', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on all three tables even bypassing the service', async () => {
    const ctx = member(tenantStorage);
    const { intervention } = await seedIntervention(ctx, { realized: 160 });

    // TRUNCATE is rejected too — on interventions and
    // intervention_realizations the dependent FK fires first, on
    // intervention_priors the append-only trigger does; either way the
    // tables cannot be emptied.
    const attempts: Array<() => Promise<unknown>> = [
      () => getDb().query(`UPDATE interventions SET capability_label = 'tampered' WHERE tenant_id = $1`, [tenantStorage]),
      () => getDb().query(`DELETE FROM interventions WHERE tenant_id = $1`, [tenantStorage]),
      () => getDb().query(`TRUNCATE interventions`),
      () => getDb().query(`UPDATE intervention_realizations SET realized_value = 0 WHERE tenant_id = $1`, [tenantStorage]),
      () => getDb().query(`DELETE FROM intervention_realizations WHERE tenant_id = $1`, [tenantStorage]),
      () => getDb().query(`TRUNCATE intervention_realizations`),
      () => getDb().query(`UPDATE intervention_priors SET success_rate = 1 WHERE tenant_id = $1`, [tenantStorage]),
      () => getDb().query(`DELETE FROM intervention_priors WHERE tenant_id = $1`, [tenantStorage]),
      () => getDb().query(`TRUNCATE intervention_priors`),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(/append-only|cannot truncate/);
    }

    // the record survived every attempt untouched
    const view = await getIntervention(ctx, intervention.id);
    expect(view.capabilityLabel).toBe('Invoice Processing');
    expect(view.realization!.realizedValue).toBe(160);
  });
});
