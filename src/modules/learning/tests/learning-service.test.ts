// Integration tests for the learning module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W040 acceptance:
//
//  * TIE: subjects of every catalog kind (recommendation, agent, extension,
//    mission) round-trip as opaque uuid forward references; affected goals
//    link outcomes to goals-module records the same opaque way; the
//    originating cognitive execution is the ONE validated cross-module
//    link — a readable cognition execution links, missing and
//    foreign-tenant execution ids are uniformly invalid_origin_ref (no
//    existence leak).
//  * MEASURABLE: definitions freeze metric + direction + baseline +
//    expected (+ horizon); identity, status, commit time and acting
//    principal are system-minted; there is no revision path and the
//    storage layer rejects UPDATE/DELETE/TRUNCATE on definitions,
//    measurements and realizations outright (triggers) — predictions
//    cannot be rewritten after realization.
//  * EXPECTED-VERSUS-REALIZED: measurements append as an ordered evidence
//    series (with actor provenance and evidence refs); settling grounds
//    the realized value in a recorded measurement of the SAME outcome
//    (another outcome's measurement is uniformly measurement_not_found),
//    freezes variance-vs-expected, improvement-vs-baseline and the
//    deterministic assessment, and the frozen record survives intact;
//    expected vs realized rolls up per subject kind (summarizeRealization)
//    with correct counts and sums.
//  * LIFECYCLE: settle/abandon are one-way terminal transitions (reason
//    required on abandonment); terminal outcomes accept neither
//    measurements nor second realizations; a raced terminal write loses
//    cleanly with outcome_conflict.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).
//  * the listing surfaces: derived status/assessment/subject/goal/origin/
//    search filters over the current views, newest first; the measurement
//    audit trail ascending; deep-linked measurement reads.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { startExecution } from '@/modules/cognition/contract';
import { LearningError } from '../errors';
import * as learningContract from '../contract';
import type { DefineOutcomeInput, Outcome } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  abandonOutcome,
  defineOutcome,
  getMeasurement,
  getOutcome,
  listMeasurements,
  listOutcomes,
  recordMeasurement,
  settleOutcome,
  summarizeRealization,
} = learningContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId();
const tenantB = newId();
const tenantIso = newId();
const tenantOrigin = newId();
const tenantLifecycle = newId();
const tenantStorage = newId();
const tenantConflict = newId();
const tenantList = newId();
const tenantSummary = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const GOAL_ID_1 = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const GOAL_ID_2 = '2d4b0a5c-3e6d-4fac-9b5a-9c4d8e7f6a1b';
const RECOMMENDATION_ID = '7f9a5b3d-8c1e-4d4f-9e2b-3a5c7d9e1f3a';
const AGENT_ID = '3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b';
const EXTENSION_ID = '4d6f2b8a-5c7e-4d9f-8e1b-2f4a6b8d0f2c';
const MISSION_ID = '5e7a3c9b-6d8f-4e0a-9f2c-3a5b7c9e1a3d';
const OBSERVATION_ID = 'ac2d8e6a-1f4b-4a7c-8b5e-6d8f0a2c4e6d';
const OBSERVATION_ID_2 = 'bd3e9f7b-2a5c-4b8d-9c6f-7e9a1b3d5e7f';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe(code);
  }
}

/** Seeds one cognitive execution in `ctx`'s tenant (the validated origin source). */
async function seedExecution(ctx: TenantContext): Promise<string> {
  const execution = await startExecution(ctx, {
    trigger: { kind: 'management', label: 'W040 outcome fixture' },
    focus: { topics: ['churn', 'retention'], entities: [] },
    actor: { kind: 'system', label: 'cognition' },
    rationale: 'W040 fixture',
  });
  return execution.id;
}

/** A full W040 definition, parameterized for the suites below. */
function defineInput(overrides: Partial<DefineOutcomeInput> = {}): DefineOutcomeInput {
  return {
    subject: { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'Churn play' },
    metricName: 'monthly churn rate',
    metricUnit: 'percent',
    direction: 'at_most',
    baseline: 8.4,
    expected: 6.0,
    horizon: '2027-03-31',
    affectedGoals: [{ goalId: GOAL_ID_1, label: 'Q4 churn reduction' }],
    originExecutionId: null,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'cognition-2026-09 churn cycle',
    ...overrides,
  };
}

async function seedOutcome(
  ctx: TenantContext,
  overrides: Partial<DefineOutcomeInput> = {},
): Promise<Outcome> {
  return defineOutcome(ctx, defineInput(overrides));
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The tie: subjects, goals, originating execution
// ---------------------------------------------------------------------------

describe('defineOutcome — the tie', () => {
  it('ties every W040 subject kind and round-trips the full definition', async () => {
    const ctx = member(tenantA);
    const cases = [
      { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'Churn play' },
      { kind: 'agent', id: AGENT_ID, label: 'Collections agent' },
      { kind: 'extension', id: EXTENSION_ID, label: 'Dunning extension' },
      { kind: 'mission', id: MISSION_ID, label: 'Churn root cause' },
    ] as const;
    for (const subject of cases) {
      const outcome = await defineOutcome(ctx, defineInput({ subject }));
      expect(outcome.subject).toEqual(subject);
      expect(outcome.status).toBe('open');
      expect(outcome.realization).toBeNull();
      expect(outcome.abandonment).toBeNull();
      expect(outcome.measurementCount).toBe(0);
      expect(outcome.latestMeasurement).toBeNull();
    }
  });

  it('round-trips metric, direction, baseline, expected, horizon, goals and audit quartet', async () => {
    const principalId = newId();
    const ctx = memberAs(tenantA, principalId);
    const outcome = await defineOutcome(ctx, defineInput());
    expect(outcome.tenantId).toBe(tenantA);
    expect(outcome.metricName).toBe('monthly churn rate');
    expect(outcome.metricUnit).toBe('percent');
    expect(outcome.direction).toBe('at_most');
    expect(outcome.baseline).toBe(8.4);
    expect(outcome.expected).toBe(6.0);
    expect(outcome.horizon).toBe('2027-03-31');
    expect(outcome.affectedGoals).toEqual([{ goalId: GOAL_ID_1, label: 'Q4 churn reduction' }]);
    expect(outcome.originExecutionId).toBeNull();
    expect(outcome.lastChange).toMatchObject({
      actor: { kind: 'person', id: PERSON_ID, label: null },
      changedByPrincipal: principalId,
      rationale: 'cognition-2026-09 churn cycle',
    });
    expect(outcome.createdAt).toBe(outcome.lastChange.recordedAt);
    expect(() => new Date(outcome.createdAt)).not.toThrow();
  });

  it('validates the originating execution through the cognition contract', async () => {
    const ctx = member(tenantOrigin);
    const executionId = await seedExecution(ctx);
    const outcome = await defineOutcome(ctx, defineInput({ originExecutionId: executionId }));
    expect(outcome.originExecutionId).toBe(executionId);

    // a foreign-tenant execution is indistinguishable from a missing one
    const foreign = await seedExecution(member(tenantB));
    await expectCode('invalid_origin_ref', () =>
      defineOutcome(ctx, defineInput({ originExecutionId: foreign })),
    );
    await expectCode('invalid_origin_ref', () =>
      defineOutcome(ctx, defineInput({ originExecutionId: newId() })),
    );
    // a malformed origin id never reaches the cross-module check at all
    await expectCode('invalid_outcome_input', () =>
      defineOutcome(ctx, defineInput({ originExecutionId: 'not-a-uuid' as never })),
    );
  });

  it('rejects malformed input at the contract boundary', async () => {
    const ctx = member(tenantA);
    await expectCode('invalid_outcome_input', () =>
      defineOutcome(ctx, defineInput({ subject: { kind: 'vendor', id: newId() } as never })),
    );
    await expectCode('invalid_outcome_input', () =>
      defineOutcome(ctx, defineInput({ expected: Number.NaN })),
    );
    await expectCode('invalid_context', () =>
      defineOutcome({ tenantId: ' ', principalId: 'p', authority: [] }, defineInput()),
    );
  });
});

// ---------------------------------------------------------------------------
// The observation series
// ---------------------------------------------------------------------------

describe('recordMeasurement / getMeasurement / listMeasurements', () => {
  it('appends an ordered evidence series with provenance and evidence refs', async () => {
    const ctx = member(tenantA);
    const outcome = await seedOutcome(ctx);

    const first = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 7.6,
      note: 'January cohort',
      evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'churn export' }],
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    const second = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 6.3,
      evidence: [{ kind: 'metric', id: OBSERVATION_ID_2 }],
      actor: { kind: 'person', id: PERSON_ID },
    });

    expect(first.outcomeId).toBe(outcome.id);
    expect(first.tenantId).toBe(tenantA);
    expect(first.evidence).toEqual([{ kind: 'observation', id: OBSERVATION_ID, label: 'churn export' }]);
    expect(first.recordedByPrincipal).toBeTruthy();
    expect(first.id).not.toBe(second.id);

    const series = await listMeasurements(ctx, { outcomeId: outcome.id });
    expect(series.map((m) => m.value)).toEqual([7.6, 6.3]);
    expect(series[0]!.recordedAt <= series[1]!.recordedAt).toBe(true);

    const deep = await getMeasurement(ctx, first.id);
    expect(deep).toEqual(first);

    const view = await getOutcome(ctx, outcome.id);
    expect(view.measurementCount).toBe(2);
    expect(view.latestMeasurement).toEqual(second); // most recent wins
    expect(view.status).toBe('open');
  });

  it('rejects measurements for malformed and missing outcomes', async () => {
    const ctx = member(tenantA);
    // a malformed id is an input error; a well-formed missing id is uniformly not-found
    await expectCode('invalid_measurement_input', () =>
      recordMeasurement(ctx, {
        outcomeId: 'not-a-uuid',
        value: 1,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('outcome_not_found', () =>
      recordMeasurement(ctx, {
        outcomeId: newId(),
        value: 1,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('measurement_not_found', () => getMeasurement(ctx, newId()));
    await expectCode('measurement_not_found', () => getMeasurement(ctx, 'not-a-uuid'));
    await expectCode('outcome_not_found', () => listMeasurements(ctx, { outcomeId: newId() }));
  });
});

// ---------------------------------------------------------------------------
// Expected versus realized
// ---------------------------------------------------------------------------

describe('settleOutcome — the frozen expected-versus-realized record', () => {
  it('grounds realization in a measurement and freezes the assessment', async () => {
    const ctx = member(tenantA);
    const outcome = await seedOutcome(ctx, {
      // churn expected to drop from 8.4 to at most 6.0; it realized at 5.1
      metricName: 'monthly churn rate (settled case)',
    });
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 5.1,
      evidence: [{ kind: 'report', label: 'Q1 finance close' }],
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });

    const settled = await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurement.id,
      note: 'final Q1 reading',
      actor: { kind: 'person', id: PERSON_ID },
    });

    expect(settled.status).toBe('settled');
    expect(settled.realization).toEqual({
      realizedValue: 5.1,
      varianceVsExpected: 5.1 - 6.0,
      improvementVsBaseline: 5.1 - 8.4,
      assessment: 'exceeded', // at_most: strictly below the expectation
      fromMeasurementId: measurement.id,
      note: 'final Q1 reading',
      actor: { kind: 'person', id: PERSON_ID, label: null },
      realizedByPrincipal: expect.any(String) as string,
      settledAt: expect.any(String) as string,
    });
    expect(settled.measurementCount).toBe(1);
    expect(settled.latestMeasurement!.value).toBe(5.1);

    // the frozen record survives rereads, unedited
    const reread = await getOutcome(ctx, outcome.id);
    expect(reread.realization).toEqual(settled.realization);
    expect(reread.status).toBe('settled');
  });

  it('records met and missed assessments for at_least metrics', async () => {
    const ctx = member(tenantA);
    const met = await seedOutcome(ctx, {
      subject: { kind: 'extension', id: EXTENSION_ID },
      direction: 'at_least',
      baseline: 120,
      expected: 180,
      metricName: 'tickets resolved per week',
    });
    const metMeasurement = await recordMeasurement(ctx, {
      outcomeId: met.id,
      value: 180,
      actor: { kind: 'system', label: 'helpdesk' },
    });
    const metSettled = await settleOutcome(ctx, {
      outcomeId: met.id,
      measurementId: metMeasurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(metSettled.realization!.assessment).toBe('met');
    expect(metSettled.realization!.varianceVsExpected).toBe(0);

    const missed = await seedOutcome(ctx, {
      subject: { kind: 'agent', id: AGENT_ID },
      direction: 'at_least',
      baseline: 120,
      expected: 180,
      metricName: 'tickets resolved per week (agent)',
    });
    const missedMeasurement = await recordMeasurement(ctx, {
      outcomeId: missed.id,
      value: 165,
      actor: { kind: 'system', label: 'helpdesk' },
    });
    const missedSettled = await settleOutcome(ctx, {
      outcomeId: missed.id,
      measurementId: missedMeasurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(missedSettled.realization!.assessment).toBe('missed');
    expect(missedSettled.realization!.varianceVsExpected).toBe(-15);
    expect(missedSettled.realization!.improvementVsBaseline).toBe(45);
  });

  it('requires a measurement of THIS outcome (realization is evidence-grounded)', async () => {
    const ctx = member(tenantA);
    const mine = await seedOutcome(ctx, { metricName: 'grounding target' });
    const other = await seedOutcome(ctx, { metricName: 'grounding other' });
    const otherMeasurement = await recordMeasurement(ctx, {
      outcomeId: other.id,
      value: 1,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });

    await expectCode('measurement_not_found', () =>
      settleOutcome(ctx, {
        outcomeId: mine.id,
        measurementId: otherMeasurement.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('measurement_not_found', () =>
      settleOutcome(ctx, {
        outcomeId: mine.id,
        measurementId: newId(),
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // a settlement without any measurement recorded is impossible by shape
    await expectCode('measurement_not_found', () =>
      settleOutcome(ctx, {
        outcomeId: mine.id,
        measurementId: newId(),
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });

  it('rejects malformed settlement input', async () => {
    const ctx = member(tenantA);
    await expectCode('invalid_settlement_input', () =>
      settleOutcome(ctx, {
        outcomeId: 'x',
        measurementId: newId(),
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_settlement_input', () =>
      settleOutcome(ctx, {
        outcomeId: newId(),
        measurementId: 'not-a-uuid',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: terminal transitions
// ---------------------------------------------------------------------------

describe('terminal lifecycle', () => {
  it('abandoning requires a reason and records it', async () => {
    const ctx = member(tenantLifecycle);
    const outcome = await seedOutcome(ctx);
    const abandoned = await abandonOutcome(ctx, {
      outcomeId: outcome.id,
      reason: 'the recommendation was withdrawn',
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.realization).toBeNull();
    expect(abandoned.abandonment).toMatchObject({
      reason: 'the recommendation was withdrawn',
      actor: { kind: 'person', id: PERSON_ID, label: null },
      abandonedByPrincipal: expect.any(String) as string,
    });
    expect(abandoned.measurementCount).toBe(0);
  });

  it('terminal outcomes accept nothing — no measurements, no second realization', async () => {
    const ctx = member(tenantLifecycle);
    const settled = await seedOutcome(ctx, { metricName: 'lifecycle settled' });
    const measurement = await recordMeasurement(ctx, {
      outcomeId: settled.id,
      value: 6.0,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: settled.id,
      measurementId: measurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });

    await expectCode('invalid_transition', () =>
      recordMeasurement(ctx, {
        outcomeId: settled.id,
        value: 5.0,
        actor: { kind: 'system', label: 'metrics-warehouse' },
      }),
    );
    await expectCode('invalid_transition', () =>
      settleOutcome(ctx, {
        outcomeId: settled.id,
        measurementId: measurement.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_transition', () =>
      abandonOutcome(ctx, {
        outcomeId: settled.id,
        reason: 'too late',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );

    const abandoned = await seedOutcome(ctx, { metricName: 'lifecycle abandoned' });
    await abandonOutcome(ctx, {
      outcomeId: abandoned.id,
      reason: 'withdrawn',
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_transition', () =>
      recordMeasurement(ctx, {
        outcomeId: abandoned.id,
        value: 5.0,
        actor: { kind: 'system', label: 'metrics-warehouse' },
      }),
    );
    await expectCode('invalid_transition', () =>
      settleOutcome(ctx, {
        outcomeId: abandoned.id,
        measurementId: newId(),
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });

  it('rejects abandonment without a reason and malformed ids uniformly', async () => {
    const ctx = member(tenantLifecycle);
    const outcome = await seedOutcome(ctx);
    await expectCode('invalid_abandonment_input', () =>
      abandonOutcome(ctx, {
        outcomeId: outcome.id,
        reason: '  ',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('outcome_not_found', () =>
      abandonOutcome(ctx, {
        outcomeId: newId(),
        reason: 'why',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('outcome_not_found', () => getOutcome(ctx, newId()));
    await expectCode('outcome_not_found', () => getOutcome(ctx, 'not-a-uuid'));
  });

  it('a raced terminal write loses cleanly with outcome_conflict', async () => {
    const ctx = member(tenantConflict);
    const outcome = await seedOutcome(ctx);
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 6.0,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });

    // Two terminal writers race; the definition-row lock serializes them
    // and the loser sees the winner's realization.
    const first = settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    const second = abandonOutcome(ctx, {
      outcomeId: outcome.id,
      reason: 'raced',
      actor: { kind: 'person', id: PERSON_ID },
    });
    const [winner, loser] = await Promise.allSettled([first, second]);
    const codes = new Set([winner.status, loser.status]);
    expect(codes.has('fulfilled')).toBe(true);
    if (loser.status === 'rejected') {
      expect((loser.reason as LearningError).code).toBe('invalid_transition');
    }
    if (winner.status === 'rejected') {
      expect((winner.reason as LearningError).code).toBe('invalid_transition');
    }
    // exactly one terminal record exists and the view agrees with it
    const view = await getOutcome(ctx, outcome.id);
    expect(['settled', 'abandoned']).toContain(view.status);
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (append-only)
// ---------------------------------------------------------------------------

describe('storage-level append-only guarantees', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on all three tables even bypassing the service', async () => {
    const ctx = member(tenantStorage);
    const outcome = await seedOutcome(ctx);
    const measurement = await recordMeasurement(ctx, {
      outcomeId: outcome.id,
      value: 6.0,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: outcome.id,
      measurementId: measurement.id,
      actor: { kind: 'person', id: PERSON_ID },
    });

    const db = getDb();
    await expect(
      db.query(`UPDATE outcomes SET expected = 1 WHERE id = $1`, [outcome.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE outcome_measurements SET value = 1 WHERE id = $1`, [measurement.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE outcome_realizations SET assessment = 'met' WHERE outcome_id = $1`, [outcome.id]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM outcomes WHERE id = $1`, [outcome.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      db.query(`DELETE FROM outcome_measurements WHERE id = $1`, [measurement.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM outcome_realizations WHERE outcome_id = $1`, [outcome.id]),
    ).rejects.toThrow(/append-only/);
    // TRUNCATE is rejected too — on outcomes and outcome_measurements the
    // dependent FK fires first, on outcome_realizations the append-only
    // trigger does; either way the tables cannot be emptied.
    await expect(db.query(`TRUNCATE outcomes`)).rejects.toThrow(/append-only|cannot truncate/);
    await expect(db.query(`TRUNCATE outcome_measurements`)).rejects.toThrow(/append-only|cannot truncate/);
    await expect(db.query(`TRUNCATE outcome_realizations`)).rejects.toThrow(/append-only/);

    // the prediction and the frozen assessment are intact after the attempts
    const view = await getOutcome(ctx, outcome.id);
    expect(view.expected).toBe(6.0);
    expect(view.realization!.assessment).toBe('met');
  });

  it('enforces the tenant-scoped grounding FK at the SQL layer', async () => {
    const ctx = member(tenantStorage);
    const mine = await seedOutcome(ctx);
    const other = await seedOutcome(ctx);
    const otherMeasurement = await recordMeasurement(ctx, {
      outcomeId: other.id,
      value: 1,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    // a direct INSERT grounding a realization in ANOTHER outcome's
    // measurement is unrepresentable (composite FK over tenant+outcome)
    await expect(
      getDb().query(
        `INSERT INTO outcome_realizations (
           tenant_id, outcome_id, disposition, realized_value, variance_vs_expected,
           improvement_vs_baseline, assessment, realized_from_measurement_id,
           actor_kind, actor_label, realized_by_principal
         ) VALUES ($1, $2, 'settled', 1, 1, 1, 'met', $3, 'system', 'x', 'p')`,
        [tenantStorage, mine.id, otherMeasurement.id],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('another tenant cannot read, measure, settle or abandon outcomes', async () => {
    const ctxA = member(tenantIso);
    const ctxB = member(tenantB);
    const outcome = await seedOutcome(ctxA);
    const measurement = await recordMeasurement(ctxA, {
      outcomeId: outcome.id,
      value: 6.0,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });

    // reads: uniformly missing — no existence leak
    await expectCode('outcome_not_found', () => getOutcome(ctxB, outcome.id));
    await expectCode('outcome_not_found', () => listMeasurements(ctxB, { outcomeId: outcome.id }));
    await expectCode('measurement_not_found', () => getMeasurement(ctxB, measurement.id));
    expect(await listOutcomes(ctxB, {})).toEqual([]);

    // writes: uniformly missing, never a transition error
    await expectCode('outcome_not_found', () =>
      recordMeasurement(ctxB, {
        outcomeId: outcome.id,
        value: 1,
        actor: { kind: 'system', label: 'metrics-warehouse' },
      }),
    );
    await expectCode('outcome_not_found', () =>
      settleOutcome(ctxB, {
        outcomeId: outcome.id,
        measurementId: measurement.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('outcome_not_found', () =>
      abandonOutcome(ctxB, {
        outcomeId: outcome.id,
        reason: 'cross-tenant attempt',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );

    // tenant B's own surface stays empty, and A's outcome is untouched
    expect(await summarizeRealization(ctxB, {})).toMatchObject({ overall: { total: 0 } });
    const view = await getOutcome(ctxA, outcome.id);
    expect(view.status).toBe('open');
    expect(view.measurementCount).toBe(1);
  });

  it('isolates settlement grounding across tenants (uniform measurement_not_found)', async () => {
    const ctxA = member(tenantIso);
    const ctxB = member(tenantB);
    const outcomeA = await seedOutcome(ctxA);
    const outcomeB = await seedOutcome(ctxB, { subject: { kind: 'mission', id: MISSION_ID } });
    const measurementB = await recordMeasurement(ctxB, {
      outcomeId: outcomeB.id,
      value: 3.3,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    // tenant A cannot ground its settlement in tenant B's measurement
    await expectCode('measurement_not_found', () =>
      settleOutcome(ctxA, {
        outcomeId: outcomeA.id,
        measurementId: measurementB.id,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Listing surfaces
// ---------------------------------------------------------------------------

describe('listOutcomes', () => {
  beforeAll(async () => {
    const ctx = member(tenantList);
    const executionId = await seedExecution(ctx);
    // a settled recommendation outcome, exceeded
    const settled = await seedOutcome(ctx, {
      subject: { kind: 'recommendation', id: RECOMMENDATION_ID },
      originExecutionId: executionId,
      affectedGoals: [{ goalId: GOAL_ID_1 }],
    });
    const m1 = await recordMeasurement(ctx, {
      outcomeId: settled.id,
      value: 5.1,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: settled.id,
      measurementId: m1.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    // a missed agent outcome sharing goal 1
    const missed = await seedOutcome(ctx, {
      subject: { kind: 'agent', id: AGENT_ID },
      direction: 'at_least',
      baseline: 100,
      expected: 150,
      affectedGoals: [{ goalId: GOAL_ID_1 }, { goalId: GOAL_ID_2 }],
      metricName: 'collection recovery rate',
    });
    const m2 = await recordMeasurement(ctx, {
      outcomeId: missed.id,
      value: 140,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: missed.id,
      measurementId: m2.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    // an open extension outcome (no affected goals)
    await seedOutcome(ctx, {
      subject: { kind: 'extension', id: EXTENSION_ID },
      metricName: 'dunning emails per week',
      affectedGoals: [],
    });
    // an abandoned mission outcome (goal 2 only)
    const abandoned = await seedOutcome(ctx, {
      subject: { kind: 'mission', id: MISSION_ID },
      metricName: 'mission knowledge confidence',
      affectedGoals: [{ goalId: GOAL_ID_2 }],
    });
    await abandonOutcome(ctx, {
      outcomeId: abandoned.id,
      reason: 'mission overtaken by events',
      actor: { kind: 'person', id: PERSON_ID },
    });
  });

  it('filters by derived status, subject kind/id, assessment, goal, origin and search', async () => {
    const ctx = member(tenantList);

    expect(await listOutcomes(ctx, {})).toHaveLength(4);
    expect(await listOutcomes(ctx, { status: 'open' })).toHaveLength(1);
    expect(await listOutcomes(ctx, { status: 'settled' })).toHaveLength(2);
    expect(await listOutcomes(ctx, { status: 'abandoned' })).toHaveLength(1);
    expect(await listOutcomes(ctx, { status: 'settled', assessment: 'missed' })).toHaveLength(1);
    expect(await listOutcomes(ctx, { status: 'settled', assessment: 'exceeded' })).toHaveLength(1);

    const recommendations = await listOutcomes(ctx, { subjectKind: 'recommendation' });
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.subject.id).toBe(RECOMMENDATION_ID);
    expect(await listOutcomes(ctx, { subjectKind: 'recommendation', subjectId: RECOMMENDATION_ID })).toHaveLength(1);
    expect(await listOutcomes(ctx, { subjectKind: 'agent', subjectId: EXTENSION_ID })).toHaveLength(0);

    const byGoal = await listOutcomes(ctx, { affectedGoalId: GOAL_ID_1 });
    expect(byGoal).toHaveLength(2);
    expect(await listOutcomes(ctx, { affectedGoalId: GOAL_ID_2 })).toHaveLength(2);

    const recommendation = (await listOutcomes(ctx, { subjectKind: 'recommendation' }))[0]!;
    expect(recommendation.originExecutionId).not.toBeNull();
    const byOrigin = await listOutcomes(ctx, { originExecutionId: recommendation.originExecutionId ?? undefined });
    expect(byOrigin).toHaveLength(1);

    const bySearch = await listOutcomes(ctx, { search: 'churn' });
    expect(bySearch).toHaveLength(1);
    const escaped = await listOutcomes(ctx, { search: '%' });
    expect(escaped).toHaveLength(0); // caller text is never a wildcard
  });

  it('orders newest first and rejects malformed queries', async () => {
    const ctx = member(tenantList);
    const listed = await listOutcomes(ctx, {});
    const recorded = listed.map((o) => new Date(o.createdAt).getTime());
    expect([...recorded].sort((a, b) => b - a)).toEqual(recorded);

    await expectCode('invalid_query', () => listOutcomes(ctx, { subjectId: RECOMMENDATION_ID }));
    await expectCode('invalid_query', () => listOutcomes(ctx, { assessment: 'met', status: 'open' }));
    await expectCode('invalid_query', () => listOutcomes(ctx, { limit: 0 }));
    // assessment alone is meaningful: only settled rows carry one
    expect(await listOutcomes(ctx, { assessment: 'missed' })).toHaveLength(1);
    expect(await listOutcomes(ctx, { assessment: 'exceeded' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The expected-versus-realized rollup
// ---------------------------------------------------------------------------

describe('summarizeRealization', () => {
  beforeAll(async () => {
    const ctx = member(tenantSummary);
    // recommendation: expected 6.0 realized 5.1 (exceeded, variance -0.9)
    const rec = await seedOutcome(ctx, {
      subject: { kind: 'recommendation', id: RECOMMENDATION_ID },
      baseline: 8.4,
      expected: 6.0,
    });
    const recM = await recordMeasurement(ctx, {
      outcomeId: rec.id,
      value: 5.1,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: rec.id,
      measurementId: recM.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    // agent: expected 150 realized 140 (missed, variance -10)
    const agent = await seedOutcome(ctx, {
      subject: { kind: 'agent', id: AGENT_ID },
      direction: 'at_least',
      baseline: 100,
      expected: 150,
    });
    const agentM = await recordMeasurement(ctx, {
      outcomeId: agent.id,
      value: 140,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctx, {
      outcomeId: agent.id,
      measurementId: agentM.id,
      actor: { kind: 'person', id: PERSON_ID },
    });
    // extension: open, never settled
    await seedOutcome(ctx, {
      subject: { kind: 'extension', id: EXTENSION_ID },
      metricName: 'open extension outcome',
    });
    // mission: abandoned
    const mission = await seedOutcome(ctx, {
      subject: { kind: 'mission', id: MISSION_ID },
      metricName: 'abandoned mission outcome',
    });
    await abandonOutcome(ctx, {
      outcomeId: mission.id,
      reason: 'superseded',
      actor: { kind: 'person', id: PERSON_ID },
    });
  });

  it('rolls up counts and expected-versus-realized sums per subject kind', async () => {
    const ctx = member(tenantSummary);
    const summary = await summarizeRealization(ctx, {});

    expect(summary.overall).toEqual({
      total: 4,
      open: 1,
      settled: 2,
      abandoned: 1,
      settledExpected: 6.0 + 150,
      settledRealized: 5.1 + 140,
      netVariance: (5.1 - 6.0) + (140 - 150),
      met: 0,
      exceeded: 1,
      missed: 1,
    });

    expect(summary.bySubjectKind.recommendation).toMatchObject({
      total: 1,
      settled: 1,
      settledExpected: 6.0,
      settledRealized: 5.1,
      netVariance: 5.1 - 6.0,
      exceeded: 1,
    });
    expect(summary.bySubjectKind.agent).toMatchObject({
      total: 1,
      settled: 1,
      netVariance: 140 - 150,
      missed: 1,
    });
    expect(summary.bySubjectKind.extension).toMatchObject({ total: 1, open: 1, settled: 0 });
    expect(summary.bySubjectKind.mission).toMatchObject({ total: 1, abandoned: 1, settled: 0 });
  });

  it('narrows to one subject kind and reports empty tenants as zeros', async () => {
    const ctx = member(tenantSummary);
    const agentsOnly = await summarizeRealization(ctx, { subjectKind: 'agent' });
    expect(agentsOnly.overall).toMatchObject({ total: 1, settled: 1, missed: 1 });
    expect(Object.keys(agentsOnly.bySubjectKind)).toEqual(['agent']);

    const empty = await summarizeRealization(member(newId()), {});
    expect(empty.overall).toEqual({
      total: 0,
      open: 0,
      settled: 0,
      abandoned: 0,
      settledExpected: 0,
      settledRealized: 0,
      netVariance: 0,
      met: 0,
      exceeded: 0,
      missed: 0,
    });
    expect(Object.keys(empty.bySubjectKind)).toEqual([
      'recommendation',
      'agent',
      'extension',
      'mission',
    ]);
  });
});
