// Integration tests for the W053 CompanyModel against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the ADR-0016
// acceptance:
//
//  * DURABLE + VERSIONED: a learning update mints a tenant-monotonic model
//    version and appends assertion versions that supersede their chain
//    heads (supersedes links, per-chain versions, derived statuses); the
//    effective model (getCompanyModel) always shows the current heads;
//    superseded and retracted versions remain as auditable history; all ten
//    ADR-0016 knowledge areas are storable and readable.
//  * PROVENANCE / CONFIDENCE / VALIDITY / VERSION on EVERY assertion:
//    evidence refs and/or a tenant-scoped outcome link are mandatory at the
//    boundary AND at the SQL layer; the outcome link is validated against
//    this module's outcomes (missing and foreign-tenant ids are uniformly
//    invalid_outcome_ref); validity intervals derive pending/expired
//    statuses and gate the effective model.
//  * LEARNED PREFERENCE NEVER OVERRIDES POLICY: rankCandidates only ever
//    reorders caller-supplied candidates — policy-excluded kinds sink
//    regardless of learned scores, policy kind precedence is a hard sort
//    key, and the surface never adds or removes candidates.
//  * PROVIDER/MODEL REPLACEMENT PRESERVES LEARNED STATE: the two tables
//    carry no provider/model identity (exact column-set assertions) and
//    the derived model view and rankings are stable and deterministic.
//  * Storage guarantees: both tables are append-only (UPDATE/DELETE/
//    TRUNCATE rejected by triggers); concurrency backstops (unique model
//    version per tenant, unique version per chain) reject duplicates at
//    the SQL layer; raced writers lose cleanly with update_conflict.
//  * Tenant isolation (ADR-0001) with uniform not-found semantics across
//    every surface.
//  * The audit surfaces: assertion deep reads + status/topic/outcome/
//    update/search filters, the learning-update feed with its deltas and
//    linked outcomes.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { LearningError } from '../errors';
import * as learningContract from '../contract';
import type {
  AssertionDeltaInput,
  DefineOutcomeInput,
  Outcome,
  RankCandidatesInput,
  RecordLearningUpdateInput,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  defineOutcome,
  getCompanyModel,
  getCompanyModelAssertion,
  getLearningUpdate,
  listCompanyModelAssertions,
  listLearningUpdates,
  rankCandidates,
  recordLearningUpdate,
} = learningContract;

// Dedicated tenants keep each concern's data isolated from the others.
const tenantModel = newId();
const tenantAreas = newId();
const tenantMulti = newId();
const tenantVersion = newId();
const tenantRetract = newId();
const tenantValidity = newId();
const tenantProv = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantIsoRankA = newId();
const tenantIsoRankB = newId();
const tenantRank = newId();
const tenantStorage = newId();
const tenantConflict = newId();
const tenantFeed = newId();
const tenantProvider = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const SOURCE_CRM = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const SOURCE_WIKI = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a';
const SOURCE_SHEETS = 'e3f4a5b6-c7d8-4e9f-8a0b-2c3d4e5f6a7b';
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

/** A W040 outcome in `ctx`'s tenant — the completed work a learning update can be linked to. */
async function seedOutcome(ctx: TenantContext, overrides: Partial<DefineOutcomeInput> = {}): Promise<Outcome> {
  return defineOutcome(ctx, {
    subject: { kind: 'mission', id: newId(), label: 'Churn root cause' },
    metricName: 'investigation evidence quality',
    metricUnit: 'quality-points',
    direction: 'at_least',
    baseline: 0,
    expected: 1.2,
    horizon: null,
    affectedGoals: [],
    originExecutionId: null,
    actor: { kind: 'system', label: 'cognition' },
    rationale: 'W053 fixture mission',
    ...overrides,
  });
}

/** A reliability delta for one source, parameterized for the suites below. */
function reliabilityDelta(overrides: Partial<AssertionDeltaInput> = {}): AssertionDeltaInput {
  return {
    area: 'source_reliability',
    subject: { kind: 'source', id: SOURCE_CRM, label: 'CRM' },
    topic: 'reliability',
    statement: { score: 0.85, note: '17 of 20 answers correct' },
    confidence: 0.8,
    disposition: 'asserted',
    validFrom: null,
    validUntil: null,
    evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'crm answer audit' }],
    outcomeId: null,
    ...overrides,
  };
}

/** A learning update input, parameterized for the suites below. */
function updateInput(
  overrides: Partial<RecordLearningUpdateInput> = {},
  deltaOverrides: Partial<AssertionDeltaInput> = {},
): RecordLearningUpdateInput {
  return {
    changes: [reliabilityDelta(deltaOverrides)],
    rationale: 'mission cycle: CRM answers audited',
    actor: { kind: 'person', id: PERSON_ID },
    ...overrides,
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// recordLearningUpdate — durability, versioning, provenance
// ---------------------------------------------------------------------------

describe('recordLearningUpdate — the recorded learning update', () => {
  it('mints model version 1 and round-trips the full assertion record', async () => {
    const principalId = newId();
    const ctx = memberAs(tenantModel, principalId);
    const outcome = await seedOutcome(ctx);
    const update = await recordLearningUpdate(
      ctx,
      updateInput(
        {},
        {
          statement: { score: 0.9 },
          confidence: 0.75,
          evidence: [],
          outcomeId: outcome.id,
        },
      ),
    );

    expect(update.tenantId).toBe(tenantModel);
    expect(update.modelVersion).toBe(1);
    expect(update.rationale).toBe('mission cycle: CRM answers audited');
    expect(update.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expect(update.recordedByPrincipal).toBe(principalId);
    expect(update.linkedOutcomeIds).toEqual([outcome.id]);
    expect(update.changes).toHaveLength(1);
    expect(update.changes[0]).toMatchObject({
      area: 'source_reliability',
      subject: { kind: 'source', key: `source:${SOURCE_CRM}`, label: 'CRM' },
      topic: 'reliability',
      version: 1,
      disposition: 'asserted',
    });

    // The deep read carries the full ADR-0016 metadata.
    const assertionId = update.changes[0]!.assertionId;
    const assertion = await getCompanyModelAssertion(ctx, assertionId);
    expect(assertion.statement).toEqual({ score: 0.9 });
    expect(assertion.confidence).toBe(0.75);
    expect(assertion.status).toBe('active');
    expect(assertion.version).toBe(1);
    expect(assertion.supersedesId).toBeNull();
    expect(assertion.updateId).toBe(update.id);
    expect(assertion.provenance).toEqual({ evidence: [], outcomeId: outcome.id });
    expect(assertion.validFrom).toBe(assertion.recordedAt);
    expect(assertion.validUntil).toBeNull();
    expect(assertion.change).toMatchObject({
      updateId: update.id,
      modelVersion: 1,
      rationale: 'mission cycle: CRM answers audited',
      actor: { kind: 'person', id: PERSON_ID, label: null },
      changedByPrincipal: principalId,
    });
  });

  it('round-trips caller-supplied validity intervals and evidence provenance', async () => {
    const ctx = member(tenantModel);
    const update = await recordLearningUpdate(
      ctx,
      updateInput(
        {},
        {
          validFrom: '2026-01-01',
          validUntil: '2027-01-01T00:00:00Z',
          evidence: [
            { kind: 'observation', id: OBSERVATION_ID, label: 'audit a' },
            { kind: 'interaction', label: 'confirmed with controller' },
          ],
        },
      ),
    );
    const assertion = await getCompanyModelAssertion(ctx, update.changes[0]!.assertionId);
    expect(assertion.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(assertion.validUntil).toBe('2027-01-01T00:00:00.000Z');
    expect(assertion.provenance.evidence).toEqual([
      { kind: 'observation', id: OBSERVATION_ID, label: 'audit a' },
      { kind: 'interaction', id: null, label: 'confirmed with controller' },
    ]);
  });

  it('stores and reads assertions across all ten ADR-0016 knowledge areas', async () => {
    const ctx = member(tenantAreas);
    const areas: Array<[AssertionDeltaInput['area'], AssertionDeltaInput['subject']]> = [
      ['vocabulary', { kind: 'term', name: 'ARR', label: 'ARR' }],
      ['organization', { kind: 'employee', id: PERSON_ID, label: 'Dana' }],
      ['process_exception', { kind: 'process', id: newId(), label: 'Expense approval' }],
      ['source_reliability', { kind: 'source', id: SOURCE_WIKI, label: 'Wiki' }],
      ['employee_expertise', { kind: 'employee', id: PERSON_ID, label: 'Dana' }],
      ['capability_pattern', { kind: 'capability', id: newId(), label: 'Collections ops' }],
      ['goal_interpretation', { kind: 'goal', id: newId(), label: 'Reduce churn' }],
      ['investigation_preference', { kind: 'source', id: SOURCE_CRM, label: 'CRM' }],
      ['intervention_prior', { kind: 'intervention', name: 'dunning-escalation' }],
      ['organizational_norm', { kind: 'company' }],
    ];
    const changes: AssertionDeltaInput[] = areas.map(([area, subject]) => ({
      area,
      subject,
      topic: 'fixture',
      statement: { learned: area },
      confidence: 0.5,
      evidence: [{ kind: 'observation', label: `${area} evidence` }],
    }));
    const update = await recordLearningUpdate(ctx, {
      changes,
      rationale: 'one assertion per ADR-0016 knowledge area',
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(update.changes).toHaveLength(10);

    const model = await getCompanyModel(ctx, {});
    expect(model.modelVersion).toBe(1);
    expect(model.assertionCount).toBe(10);
    expect(model.areas).toHaveLength(10);
    for (const [area] of areas) {
      expect(model.areas).toContain(area);
      expect(model.assertions.filter((assertion) => assertion.area === area)).toHaveLength(1);
    }
  });

  it('records multi-change updates atomically under one model version', async () => {
    const ctx = member(tenantMulti);
    const update = await recordLearningUpdate(ctx, {
      changes: [
        reliabilityDelta({ statement: { score: 0.4 }, confidence: 0.6 }),
        reliabilityDelta({
          subject: { kind: 'source', id: SOURCE_WIKI, label: 'Wiki' },
          statement: { score: 0.7 },
          confidence: 0.55,
        }),
        reliabilityDelta({
          subject: { kind: 'source', id: SOURCE_SHEETS, label: 'Spreadsheets' },
          statement: { score: 0.25 },
          confidence: 0.5,
        }),
      ],
      rationale: 'three sources audited in one cycle',
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(update.modelVersion).toBe(1);
    expect(update.changes).toHaveLength(3);
    for (const change of update.changes) {
      expect(change.version).toBe(1);
    }
    const model = await getCompanyModel(ctx, { areas: ['source_reliability'] });
    expect(model.assertionCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Versioning: supersession, retraction, validity
// ---------------------------------------------------------------------------

describe('CompanyModel versioning', () => {
  it('supersedes chain heads: version+1, supersedes links, derived statuses', async () => {
    const ctx = member(tenantVersion);
    const first = await recordLearningUpdate(
      ctx,
      updateInput({}, { statement: { score: 0.2 }, confidence: 0.4 }),
    );
    const second = await recordLearningUpdate(
      ctx,
      updateInput({}, { statement: { score: 0.9 }, confidence: 0.9 }),
    );
    const third = await recordLearningUpdate(
      ctx,
      updateInput({}, { statement: { score: 0.95 }, confidence: 0.95 }),
    );

    expect(second.modelVersion).toBe(first.modelVersion + 1);
    expect(third.modelVersion).toBe(second.modelVersion + 1);

    const v1 = await getCompanyModelAssertion(ctx, first.changes[0]!.assertionId);
    const v2 = await getCompanyModelAssertion(ctx, second.changes[0]!.assertionId);
    const v3 = await getCompanyModelAssertion(ctx, third.changes[0]!.assertionId);
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('superseded');
    expect(v2.version).toBe(2);
    expect(v2.supersedesId).toBe(v1.id);
    expect(v2.status).toBe('superseded');
    expect(v3.version).toBe(3);
    expect(v3.supersedesId).toBe(v2.id);
    expect(v3.status).toBe('active');

    // The effective model shows only the current head.
    const model = await getCompanyModel(ctx, {});
    expect(model.assertionCount).toBe(1);
    expect(model.assertions[0]!.statement).toEqual({ score: 0.95 });
    expect(model.modelVersion).toBe(third.modelVersion);

    // History is fully retained (lock 12 — contradictory evidence included).
    const superseded = await listCompanyModelAssertions(ctx, { status: 'superseded' });
    expect(superseded).toHaveLength(2);
  });

  it('retraction closes a chain while retaining its history', async () => {
    const ctx = member(tenantRetract);
    const first = await recordLearningUpdate(ctx, updateInput());
    const retraction = await recordLearningUpdate(ctx, {
      changes: [
        reliabilityDelta({ disposition: 'retracted', statement: {}, confidence: 1 }),
      ],
      rationale: 'CRM replaced by a new system — the learned reliability no longer applies',
      actor: { kind: 'person', id: PERSON_ID },
    });

    const model = await getCompanyModel(ctx, {});
    const keys = model.assertions.map((assertion) => assertion.subject.key);
    expect(keys).not.toContain(`source:${SOURCE_CRM}`);

    const head = await getCompanyModelAssertion(ctx, retraction.changes[0]!.assertionId);
    expect(head.status).toBe('retracted');
    expect(head.version).toBe(2);
    expect(head.supersedesId).toBe(first.changes[0]!.assertionId);

    const history = await listCompanyModelAssertions(ctx, { status: 'retracted' });
    expect(history.map((assertion) => assertion.id)).toContain(head.id);
    const superseded = await getCompanyModelAssertion(ctx, first.changes[0]!.assertionId);
    expect(superseded.status).toBe('superseded');
  });

  it('derives pending and expired statuses from the validity interval', async () => {
    const ctx = member(tenantValidity);
    const expiredUpdate = await recordLearningUpdate(
      ctx,
      updateInput(
        {},
        {
          subject: { kind: 'source', id: SOURCE_WIKI, label: 'Wiki' },
          validFrom: '2019-01-01T00:00:00Z',
          validUntil: '2020-01-01T00:00:00Z',
        },
      ),
    );
    const pendingUpdate = await recordLearningUpdate(
      ctx,
      updateInput(
        {},
        {
          subject: { kind: 'source', id: SOURCE_SHEETS, label: 'Spreadsheets' },
          validFrom: '2030-01-01T00:00:00Z',
        },
      ),
    );
    const activeUpdate = await recordLearningUpdate(ctx, updateInput());

    const expired = await getCompanyModelAssertion(ctx, expiredUpdate.changes[0]!.assertionId);
    const pending = await getCompanyModelAssertion(ctx, pendingUpdate.changes[0]!.assertionId);
    expect(expired.status).toBe('expired');
    expect(pending.status).toBe('pending');

    // The effective model holds only the active assertion…
    const model = await getCompanyModel(ctx, {});
    expect(model.assertions.map((assertion) => assertion.status)).toEqual(['active']);
    expect(model.assertions[0]!.id).toBe(activeUpdate.changes[0]!.assertionId);

    // …and includeInactive surfaces the inactive heads for audit.
    const withInactive = await getCompanyModel(ctx, { includeInactive: true });
    expect(withInactive.assertionCount).toBe(3);
    expect(withInactive.assertions.map((assertion) => assertion.status).sort()).toEqual([
      'active',
      'expired',
      'pending',
    ]);

    const expiredList = await listCompanyModelAssertions(ctx, { status: 'expired' });
    expect(expiredList.map((assertion) => assertion.id)).toEqual([expired.id]);
    const pendingList = await listCompanyModelAssertions(ctx, { status: 'pending' });
    expect(pendingList.map((assertion) => assertion.id)).toEqual([pending.id]);
  });
});

// ---------------------------------------------------------------------------
// Provenance: the outcome link and the evidence-or-outcome requirement
// ---------------------------------------------------------------------------

describe('learned-assertion provenance', () => {
  it('validates the outcome link against this module\u2019s outcomes (uniform invalid_outcome_ref)', async () => {
    const ctx = member(tenantProv);
    const mine = await seedOutcome(ctx);
    const update = await recordLearningUpdate(
      ctx,
      updateInput({}, { evidence: [], outcomeId: mine.id }),
    );
    expect(update.linkedOutcomeIds).toEqual([mine.id]);

    await expectCode('invalid_outcome_ref', () =>
      recordLearningUpdate(ctx, updateInput({}, { evidence: [], outcomeId: newId() })),
    );
    // a foreign-tenant outcome is indistinguishable from a missing one
    const foreign = await seedOutcome(member(tenantIsoB));
    await expectCode('invalid_outcome_ref', () =>
      recordLearningUpdate(ctx, updateInput({}, { evidence: [], outcomeId: foreign.id })),
    );
    // malformed ids never reach the check at all
    await expectCode('invalid_update_input', () =>
      recordLearningUpdate(ctx, updateInput({}, { evidence: [], outcomeId: 'not-a-uuid' })),
    );
  });

  it('requires evidence references or an outcome link on every delta', async () => {
    const ctx = member(tenantProv);
    await expectCode('invalid_update_input', () =>
      recordLearningUpdate(ctx, updateInput({}, { evidence: [], outcomeId: null })),
    );
    await expectCode('invalid_update_input', () =>
      recordLearningUpdate(ctx, {
        changes: [
          reliabilityDelta(),
          reliabilityDelta({
            subject: { kind: 'source', id: SOURCE_WIKI },
            evidence: [],
            outcomeId: null,
          }),
        ],
        rationale: 'one proven delta and one free-floating delta',
        actor: { kind: 'system', label: 'cognition' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage guarantees and concurrency backstops
// ---------------------------------------------------------------------------

describe('storage-level guarantees', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on both CompanyModel tables even bypassing the service', async () => {
    const ctx = member(tenantStorage);
    const update = await recordLearningUpdate(ctx, updateInput());
    const db = getDb();

    await expect(
      db.query(`UPDATE company_model_assertions SET confidence = 1 WHERE id = $1`, [
        update.changes[0]!.assertionId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE company_model_updates SET rationale = 'rewritten' WHERE id = $1`, [update.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM company_model_assertions WHERE tenant_id = $1`, [tenantStorage]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM company_model_updates WHERE tenant_id = $1`, [tenantStorage]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE company_model_assertions`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE company_model_updates`)).rejects.toThrow(/append-only|cannot truncate/);

    // the learned state is intact after the attempts
    const model = await getCompanyModel(ctx, {});
    expect(model.assertionCount).toBe(1);
  });

  it('enforces the tenant-scoped outcome FK at the SQL layer', async () => {
    const ctx = member(tenantStorage);
    const update = await recordLearningUpdate(ctx, updateInput());
    // a direct INSERT grounding an assertion in ANOTHER tenant's outcome is
    // unrepresentable (composite FK over tenant+outcome)
    const foreign = await seedOutcome(member(tenantIsoB));
    await expect(
      getDb().query(
        `INSERT INTO company_model_assertions (
           tenant_id, area, subject_kind, subject_key, topic, statement, confidence,
           disposition, valid_from, valid_until, version, update_id, evidence, outcome_id,
           recorded_by_principal
         ) VALUES ($1, 'vocabulary', 'company', 'company', 'x', '{}', 0.5,
           'asserted', now(), NULL, 1, $2, $3::jsonb, $4, 'p')`,
        [
          tenantStorage,
          update.id,
          JSON.stringify([{ kind: 'observation', label: 'fk probe' }]),
          foreign.id,
        ],
      ),
    ).rejects.toThrow();
  });

  it('enforces the unique model version and chain version at the SQL layer', async () => {
    const ctx = member(tenantStorage);
    const update = await recordLearningUpdate(ctx, updateInput());
    const db = getDb();

    // same tenant, same model_version → duplicate key
    await expect(
      db.query(
        `INSERT INTO company_model_updates (tenant_id, model_version, rationale, actor_kind, actor_label, recorded_by_principal)
         VALUES ($1, $2, 'duplicate', 'system', 'x', 'p')`,
        [tenantStorage, update.modelVersion],
      ),
    ).rejects.toThrow(/duplicate key/i);

    // same chain, same version → duplicate key (evidence must be non-empty:
    // the provenance-present CHECK is tested above and would fire first)
    await expect(
      db.query(
        `INSERT INTO company_model_assertions (
           tenant_id, area, subject_kind, subject_key, topic, statement, confidence,
           disposition, valid_from, valid_until, version, update_id, evidence,
           recorded_by_principal
         ) VALUES ($1, 'source_reliability', 'source', $2, 'reliability', '{}', 0.5,
           'asserted', now(), NULL, 1, $3, $4::jsonb, 'p')`,
        [
          tenantStorage,
          `source:${SOURCE_CRM}`,
          update.id,
          JSON.stringify([{ kind: 'observation', label: 'dup probe' }]),
        ],
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('a raced learning update loses cleanly with update_conflict or serializes correctly', async () => {
    const ctx = member(tenantConflict);
    // Two writers race on the same chain; the chain-head lock and the
    // uniqueness backstops keep the model consistent either way.
    const first = recordLearningUpdate(ctx, updateInput({}, { statement: { score: 0.6 } }));
    const second = recordLearningUpdate(ctx, updateInput({}, { statement: { score: 0.7 } }));
    const [a, b] = await Promise.allSettled([first, second]);
    const failures = [a, b].filter((result) => result.status === 'rejected');
    for (const failure of failures) {
      expect((failure.reason as LearningError).code).toBe('update_conflict');
    }
    // the chain is consistent: versions are contiguous from 1
    const history = await listCompanyModelAssertions(ctx, { subjectKey: `source:${SOURCE_CRM}` });
    const versions = history.map((assertion) => assertion.version).sort((x, y) => x - y);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
    const model = await getCompanyModel(ctx, {});
    expect(model.assertionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('another tenant cannot read or learn across tenants', async () => {
    const ctxA = member(tenantIsoA);
    const ctxB = member(tenantIsoB);
    const outcomeA = await seedOutcome(ctxA);
    const updateA = await recordLearningUpdate(
      ctxA,
      updateInput({}, { evidence: [], outcomeId: outcomeA.id }),
    );
    const assertionA = updateA.changes[0]!.assertionId;

    // reads: uniform not-found, no existence leak
    await expectCode('assertion_not_found', () => getCompanyModelAssertion(ctxB, assertionA));
    await expectCode('learning_update_not_found', () => getLearningUpdate(ctxB, updateA.id));
    await expectCode('assertion_not_found', () => getCompanyModelAssertion(ctxB, 'not-a-uuid'));
    await expectCode('learning_update_not_found', () => getLearningUpdate(ctxB, 'not-a-uuid'));

    // the other tenant's model and feeds are empty
    const modelB = await getCompanyModel(ctxB, {});
    expect(modelB.modelVersion).toBe(0);
    expect(modelB.assertions).toEqual([]);
    expect(await listCompanyModelAssertions(ctxB, {})).toEqual([]);
    expect(await listLearningUpdates(ctxB, {})).toEqual([]);

    // a cross-tenant outcome link is rejected at write time (uniform)
    await expectCode('invalid_outcome_ref', () =>
      recordLearningUpdate(ctxB, updateInput({}, { evidence: [], outcomeId: outcomeA.id })),
    );

    // tenant A's data is untouched by tenant B's probes
    const modelA = await getCompanyModel(ctxA, {});
    expect(modelA.modelVersion).toBe(1);
    expect(modelA.assertions[0]!.provenance.outcomeId).toBe(outcomeA.id);
  });

  it('one tenant\u2019s learned priors never influence another tenant\u2019s rankings', async () => {
    const ctxA = member(tenantIsoRankA);
    const ctxB = member(tenantIsoRankB);
    await recordLearningUpdate(
      ctxA,
      updateInput({}, { statement: { score: 0.99 }, confidence: 0.99 }),
    );
    const input: RankCandidatesInput = {
      domain: 'source_selection',
      candidates: [
        { kind: 'source', id: SOURCE_CRM, label: 'CRM', baseScore: 0.5 },
        { kind: 'source', id: SOURCE_WIKI, label: 'Wiki', baseScore: 0.5 },
      ],
    };
    const rankingA = await rankCandidates(ctxA, input);
    const rankingB = await rankCandidates(ctxB, input);
    expect(rankingA.modelVersion).toBe(1);
    expect(rankingA.candidates[0]!.key).toBe(`source:${SOURCE_CRM}`);
    expect(rankingB.modelVersion).toBe(0);
    expect(rankingB.candidates[0]!.key).toBe(`source:${SOURCE_CRM}`); // input order, no priors
    expect(rankingB.candidates.every((candidate) => candidate.appliedPrior === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Listing surfaces
// ---------------------------------------------------------------------------

describe('listing surfaces', () => {
  it('filters assertions by area, subject, topic, outcome, update and search', async () => {
    const ctx = member(tenantFeed);
    const outcome = await seedOutcome(ctx);
    const update1 = await recordLearningUpdate(ctx, {
      changes: [
        reliabilityDelta({ statement: { score: 0.9 }, evidence: [], outcomeId: outcome.id }),
        reliabilityDelta({
          subject: { kind: 'source', id: SOURCE_WIKI, label: 'Company Wiki' },
          statement: { score: 0.5 },
        }),
      ],
      rationale: 'cycle one: crm and wiki audited',
      actor: { kind: 'system', label: 'cognition' },
    });
    const update2 = await recordLearningUpdate(ctx, {
      changes: [
        {
          area: 'vocabulary',
          subject: { kind: 'term', name: 'Churn Rate', label: 'Churn Rate' },
          topic: 'definition',
          statement: { definition: 'monthly logo churn' },
          confidence: 0.7,
          evidence: [{ kind: 'document', label: 'finance glossary' }],
        },
      ],
      rationale: 'cycle two: learned the churn vocabulary',
      actor: { kind: 'system', label: 'cognition' },
    });

    const byArea = await listCompanyModelAssertions(ctx, { area: 'source_reliability' });
    expect(byArea).toHaveLength(2);
    const bySubject = await listCompanyModelAssertions(ctx, { subjectKey: `source:${SOURCE_CRM}` });
    expect(bySubject).toHaveLength(1);
    const byTopic = await listCompanyModelAssertions(ctx, { topic: 'definition' });
    expect(byTopic).toHaveLength(1);
    expect(byTopic[0]!.subject.key).toBe('term:churn-rate');
    const byOutcome = await listCompanyModelAssertions(ctx, { outcomeId: outcome.id });
    expect(byOutcome).toHaveLength(1);
    expect(byOutcome[0]!.provenance.outcomeId).toBe(outcome.id);
    const byUpdate = await listCompanyModelAssertions(ctx, { updateId: update1.id });
    expect(byUpdate).toHaveLength(2);
    const bySearch = await listCompanyModelAssertions(ctx, { search: 'wiki' });
    expect(bySearch.map((assertion) => assertion.subject.key)).toEqual([`source:${SOURCE_WIKI}`]);
    const byKind = await listCompanyModelAssertions(ctx, { subjectKind: 'term' });
    expect(byKind).toHaveLength(1);
    expect(await listCompanyModelAssertions(ctx, { limit: 1 })).toHaveLength(1);

    // the update feed: newest first, with deltas and linked outcomes
    const feed = await listLearningUpdates(ctx, {});
    expect(feed.map((update) => update.id)).toEqual([update2.id, update1.id]);
    expect(feed[0]!.changes[0]!.subject.key).toBe('term:churn-rate');
    expect(feed[1]!.linkedOutcomeIds).toEqual([outcome.id]);
    const searched = await listLearningUpdates(ctx, { search: 'churn vocabulary' });
    expect(searched.map((update) => update.id)).toEqual([update2.id]);

    // deep link
    const deep = await getLearningUpdate(ctx, update1.id);
    expect(deep.changes).toHaveLength(2);
    expect(deep.modelVersion).toBeLessThan(feed[0]!.modelVersion);
  });

  it('rejects malformed queries at the boundary', async () => {
    const ctx = member(tenantFeed);
    await expectCode('invalid_query', () => listCompanyModelAssertions(ctx, { status: 'zombie' as never }));
    await expectCode('invalid_query', () => listCompanyModelAssertions(ctx, { limit: 999 }));
    await expectCode('invalid_query', () => listLearningUpdates(ctx, { limit: 0 }));
    await expectCode('invalid_query', () => getCompanyModel(ctx, { areas: ['gossip' as never] }));
  });
});

// ---------------------------------------------------------------------------
// rankCandidates — the application surface
// ---------------------------------------------------------------------------

describe('rankCandidates', () => {
  const input = (policy?: RankCandidatesInput['policy']): RankCandidatesInput => ({
    domain: 'source_selection',
    candidates: [
      { kind: 'source', id: SOURCE_WIKI, label: 'Wiki', baseScore: 0.5 },
      { kind: 'source', id: SOURCE_CRM, label: 'CRM', baseScore: 0.5 },
      { kind: 'source', id: SOURCE_SHEETS, label: 'Spreadsheets', baseScore: 0.5 },
      { kind: 'agent', id: '3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b', label: 'Research agent', baseScore: 0.5 },
    ],
    ...(policy !== undefined ? { policy } : {}),
  });

  it('cold start: no learned state — deterministic input order, no priors', async () => {
    const ctx = member(tenantRank);
    const ranking = await rankCandidates(ctx, input());
    expect(ranking.modelVersion).toBe(0);
    expect(ranking.candidates.map((candidate) => candidate.key)).toEqual([
      `source:${SOURCE_WIKI}`,
      `source:${SOURCE_CRM}`,
      `source:${SOURCE_SHEETS}`,
      'agent:3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b',
    ]);
    expect(ranking.candidates.every((candidate) => candidate.appliedPrior === null)).toBe(true);
    expect(ranking.candidates.every((candidate) => candidate.score === 0.5)).toBe(true);
  });

  it('learned state reorders candidates through recorded, attributed deltas only', async () => {
    const ctx = member(tenantRank);
    const outcome = await seedOutcome(ctx);
    // Before learning: Wiki first.
    const before = await rankCandidates(ctx, input());
    expect(before.candidates[0]!.key).toBe(`source:${SOURCE_WIKI}`);

    // A completed mission's outcome now teaches CRM reliability.
    await recordLearningUpdate(ctx, {
      changes: [
        reliabilityDelta({ statement: { score: 0.95 }, confidence: 0.9, evidence: [], outcomeId: outcome.id }),
      ],
      rationale: 'mission outcome: CRM answers proved reliable',
      actor: { kind: 'system', label: 'cognition' },
    });

    const after = await rankCandidates(ctx, input());
    expect(after.modelVersion).toBe(1);
    expect(after.candidates[0]!.key).toBe(`source:${SOURCE_CRM}`);
    expect(after.candidates[0]!.score).toBeCloseTo(0.5 * 0.1 + 0.95 * 0.9, 6);

    // The improvement is attributable: the applied prior resolves to the
    // recorded assertion version, its update and its linked outcome.
    const prior = after.candidates[0]!.appliedPrior!;
    expect(prior).not.toBeNull();
    const assertion = await getCompanyModelAssertion(ctx, prior.assertionId);
    expect(assertion.version).toBe(prior.version);
    expect(assertion.provenance.outcomeId).toBe(outcome.id);
    const update = await getLearningUpdate(ctx, assertion.updateId);
    expect(update.rationale).toBe('mission outcome: CRM answers proved reliable');
    expect(update.linkedOutcomeIds).toEqual([outcome.id]);
  });

  it('policy exclusion and precedence hold regardless of learned preference', async () => {
    const ctx = member(tenantRank);
    const outcome = await seedOutcome(ctx);
    // Even the research AGENT learns to be excellent…
    await recordLearningUpdate(ctx, {
      changes: [
        {
          area: 'source_reliability',
          subject: { kind: 'agent', id: '3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b', label: 'Research agent' },
          topic: 'reliability',
          statement: { score: 0.99 },
          confidence: 1,
          evidence: [],
          outcomeId: outcome.id,
        },
      ],
      rationale: 'the research agent proved excellent (but policy still forbids it here)',
      actor: { kind: 'system', label: 'cognition' },
    });
    // …and the CRM learns highly too.
    await recordLearningUpdate(ctx, {
      changes: [
        reliabilityDelta({
          statement: { score: 0.9 },
          confidence: 0.9,
          evidence: [],
          outcomeId: outcome.id,
        }),
      ],
      rationale: 'CRM reliability update',
      actor: { kind: 'system', label: 'cognition' },
    });

    const policy = Object.freeze({
      allowedKinds: Object.freeze(['source']),
      kindPrecedence: Object.freeze(['source']),
    });
    const ranking = await rankCandidates(ctx, input(policy));
    // the agent is excluded despite its perfect learned score
    const agent = ranking.candidates.find((candidate) => candidate.kind === 'agent')!;
    expect(agent.policyExcluded).toBe(true);
    expect(ranking.candidates[ranking.candidates.length - 1]!.key).toBe(agent.key);
    // and the sources are ordered by learned reliability within the policy tier
    expect(ranking.candidates[0]!.key).toBe(`source:${SOURCE_CRM}`);
    expect(Object.isFrozen(policy)).toBe(true); // the explicit policy was never mutated
  });

  it('rejects malformed input at the boundary', async () => {
    const ctx = member(tenantRank);
    await expectCode('invalid_rank_input', () => rankCandidates(ctx, { domain: 'gossip' as never, candidates: [] }));
    await expectCode('invalid_rank_input', () =>
      rankCandidates(ctx, {
        domain: 'source_selection',
        candidates: [{ kind: 'source', id: 'no' }],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Provider independence (ADR-0016: learned state survives model/provider
// replacement) — objective evidence at the storage and read layers.
// ---------------------------------------------------------------------------

describe('provider/model replacement preserves learned state', () => {
  it('the CompanyModel tables carry no provider/model identity (exact column sets)', async () => {
    const columns = await getDb().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('company_model_assertions', 'company_model_updates')
        ORDER BY table_name, ordinal_position`,
    );
    const byTable = new Map<string, string[]>();
    for (const row of columns.rows) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(row.column_name);
      byTable.set(row.table_name, list);
    }
    expect(byTable.get('company_model_updates')).toEqual([
      'id',
      'tenant_id',
      'model_version',
      'rationale',
      'actor_kind',
      'actor_id',
      'actor_label',
      'recorded_by_principal',
      'recorded_at',
    ]);
    expect(byTable.get('company_model_assertions')).toEqual([
      'id',
      'tenant_id',
      'area',
      'subject_kind',
      'subject_key',
      'subject_label',
      'topic',
      'statement',
      'confidence',
      'disposition',
      'valid_from',
      'valid_until',
      'version',
      'supersedes_id',
      'update_id',
      'evidence',
      'outcome_id',
      'recorded_by_principal',
      'recorded_at',
    ]);
    // No provider/model identity anywhere in the column names.
    for (const [, names] of byTable) {
      for (const name of names) {
        expect(name).not.toMatch(/provider|vendor|openai|anthropic|gemini|mistral|cohere|api_key|endpoint/i);
      }
    }
  });

  it('the derived model and rankings are identical across a simulated provider swap', async () => {
    const ctx = member(tenantProvider);
    const outcome = await seedOutcome(ctx);
    // Learning recorded under an actor driven by "provider A".
    await recordLearningUpdate(ctx, {
      changes: [
        reliabilityDelta({ statement: { score: 0.88 }, confidence: 0.8, evidence: [], outcomeId: outcome.id }),
      ],
      rationale: 'learned under model alpha',
      actor: { kind: 'agent', label: 'assistant-alpha' },
    });
    const modelBefore = await getCompanyModel(ctx, {});
    const rankingBefore = await rankCandidates(ctx, {
      domain: 'source_selection',
      candidates: [
        { kind: 'source', id: SOURCE_CRM, label: 'CRM' },
        { kind: 'source', id: SOURCE_WIKI, label: 'Wiki' },
      ],
    });

    // A provider/model replacement touches the LLM gateway only (W048's
    // scope) — nothing in the learning module participates. The learned
    // state is durable PostgreSQL rows; re-deriving the model and the
    // ranking must return byte-identical results.
    const modelAfter = await getCompanyModel(ctx, {});
    const rankingAfter = await rankCandidates(ctx, {
      domain: 'source_selection',
      candidates: [
        { kind: 'source', id: SOURCE_CRM, label: 'CRM' },
        { kind: 'source', id: SOURCE_WIKI, label: 'Wiki' },
      ],
    });
    expect(modelAfter).toEqual({ ...modelBefore, generatedAt: modelAfter.generatedAt });
    expect(rankingAfter).toEqual(rankingBefore);

    // And further learning under the swapped provider continues the same
    // model lineage — same chain, next version, no provider-migration step.
    const continued = await recordLearningUpdate(ctx, {
      changes: [
        reliabilityDelta({
          statement: { score: 0.91 },
          confidence: 0.85,
          evidence: [{ kind: 'observation', id: OBSERVATION_ID_2, label: 'post-swap re-audit' }],
        }),
      ],
      rationale: 're-audited under model beta after the swap',
      actor: { kind: 'agent', label: 'assistant-beta' },
    });
    const head = await getCompanyModelAssertion(ctx, continued.changes[0]!.assertionId);
    expect(head.version).toBe(2);
    expect(head.supersedesId).toBe(modelBefore.assertions[0]!.id);
    expect(head.change.actor.label).toBe('assistant-beta');
  });
});
