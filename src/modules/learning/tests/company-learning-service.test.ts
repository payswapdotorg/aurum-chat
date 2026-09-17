// Integration tests for the learning module's W041 company-learning surface
// against the embedded PostgreSQL (PGlite, `:memory:`) through the db port.
// Covers the W041 acceptance:
//
//  * VERSIONED: one company-specific (target, aspect) chain per tenant;
//    every feedback event appends ONE version (1-based, monotonic); the
//    current version is the maximum (derived); the previous version is
//    retained intact with the required reason, so "what changed and why"
//    (ADR-0016's learning invariant) is visible on every read; a second
//    aspect or a second tenant is a different chain.
//  * THREE FEEDBACK LEGS: explicit (a statement), behavioral (observed
//    behavior — evidence required), and outcome (grounded in a SETTLED
//    W040 outcome of the same tenant, its frozen assessment snapshotted
//    onto the version; open/abandoned/missing/foreign-tenant outcomes are
//    rejected uniformly).
//  * WITHOUT MUTATING POLICY SILENTLY: every version read mints
//    authoritative === false, the input surface cannot express a policy
//    claim (`authoritative` is an unknown key), and recording feedback of
//    every channel leaves the tenant's authority policy rows untouched
//    (verified through the actions contract — the same row, same
//    updatedAt); storage-level append-only triggers reject
//    UPDATE/DELETE/TRUNCATE on both company-learning tables, so nothing
//    changes silently under a policy that consumed an earlier version.
//  * VALIDITY: a future validity window holds; an elapsed one cannot be
//    born; the derived read-time status ('active' | 'expired') is exposed
//    and filterable.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks) — the chain key includes
//    tenant_id, so the same target+aspect in two tenants is two chains.
//  * the listing surfaces: target/aspect/channel/validity filters over the
//    derived current views, most recently learned first; the version audit
//    trail ascending; deep-linked version reads.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getAuthorityPolicy, setAuthorityPolicy } from '@/modules/actions/contract';
import { LearningError } from '../errors';
import * as learningContract from '../contract';
import type {
  CompanyLearning,
  CompanyLearningVersion,
  DefineOutcomeInput,
  Outcome,
  RecordCompanyLearningInput,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  defineOutcome,
  abandonOutcome,
  recordMeasurement,
  settleOutcome,
  getCompanyLearning,
  getCompanyLearningVersion,
  listCompanyLearnings,
  listCompanyLearningVersions,
  recordCompanyLearning,
} = learningContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId();
const tenantB = newId();
const tenantChain = newId();
const tenantChannels = newId();
const tenantValidity = newId();
const tenantIso = newId();
const tenantPolicy = newId();
const tenantStorage = newId();
const tenantList = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const SOURCE_ID = '1e3f5a7c-9b2d-4c6e-8d0a-2f4a6b8c0d2e';
const SOURCE_ID_2 = '2f4a6b8c-0d2e-4f6a-8c1b-3e5a7c9e1b3d';
const AGENT_ID = '3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b';
const EXTENSION_ID = '4d6f2b8a-5c7e-4d9f-8e1b-2f4a6b8d0f2c';
const CHANNEL_ID = '5e7a3c9b-6d8f-4e0a-9f2c-3a5b7c9e1a3d';
const OBSERVATION_ID = 'ac2d8e6a-1f4b-4a7c-8b5e-6d8f0a2c4e6d';
const OBSERVATION_ID_2 = 'bd3e9f7b-2a5c-4b8d-9c6f-7e9a1b3d5e7f';
const RECOMMENDATION_ID = '7f9a5b3d-8c1e-4d4f-9e2b-3a5c7d9e1f3a';
const CAPABILITY_ID = '6f8b4d2c-7a9e-4f1b-8d3c-4e6a8c0d2b4f';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/** An admin context for the actions policy probe (claim-gated writes). */
function policyAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
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

/** A full W041 feedback record, parameterized for the suites below. */
function learningInput(overrides: Partial<RecordCompanyLearningInput> = {}): RecordCompanyLearningInput {
  return {
    target: { kind: 'source', id: SOURCE_ID, label: 'CRM export' },
    aspect: 'source-reliability',
    value: { usefulness: 0.8 },
    confidence: 0.7,
    channel: 'explicit',
    reason: 'ops lead stated CRM exports answered every churn question',
    evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'churn export' }],
    outcomeId: null,
    validUntil: null,
    actor: { kind: 'person', id: PERSON_ID },
    ...overrides,
  };
}

/** Seeds one SETTLED W040 outcome (the grounding for outcome feedback). */
async function seedSettledOutcome(
  ctx: TenantContext,
  overrides: Partial<DefineOutcomeInput> = {},
): Promise<Outcome> {
  const outcome = await defineOutcome(ctx, {
    subject: { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'Churn play' },
    metricName: 'monthly churn rate',
    metricUnit: 'percent',
    direction: 'at_most',
    baseline: 8.4,
    expected: 6.0,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'W041 outcome-feedback fixture',
    ...overrides,
  });
  const measurement = await recordMeasurement(ctx, {
    outcomeId: outcome.id,
    value: 5.1,
    evidence: [{ kind: 'report', label: 'Q1 finance close' }],
    actor: { kind: 'system', label: 'metrics-warehouse' },
  });
  return settleOutcome(ctx, {
    outcomeId: outcome.id,
    measurementId: measurement.id,
    actor: { kind: 'person', id: PERSON_ID },
  });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Versioning — the item's core verb
// ---------------------------------------------------------------------------

describe('recordCompanyLearning — the versioned chain', () => {
  it('mints version 1 on a fresh chain with the full ADR-0016 metadata', async () => {
    const principalId = newId();
    const ctx = memberAs(tenantChain, principalId);
    const { learning, version } = await recordCompanyLearning(ctx, learningInput());

    expect(version.id).toBeTruthy();
    expect(version.tenantId).toBe(tenantChain);
    expect(version.learningId).toBe(learning.id);
    expect(version.version).toBe(1);
    expect(version.isCurrent).toBe(true);
    expect(version.channel).toBe('explicit');
    expect(version.value).toEqual({ usefulness: 0.8 });
    expect(version.confidence).toBe(0.7);
    expect(version.evidence).toEqual([{ kind: 'observation', id: OBSERVATION_ID, label: 'churn export' }]);
    expect(version.outcomeId).toBeNull();
    expect(version.outcomeAssessment).toBeNull();
    expect(version.reason).toBe('ops lead stated CRM exports answered every churn question');
    expect(version.validFrom).toEqual(version.recordedAt);
    expect(version.validUntil).toBeNull();
    expect(version.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expect(version.recordedByPrincipal).toBe(principalId);
    // A learned assertion is NEVER authoritative (lock 14, ADR-0016).
    expect(version.authoritative).toBe(false);

    expect(learning.tenantId).toBe(tenantChain);
    expect(learning.target).toEqual({ kind: 'source', id: SOURCE_ID, label: 'CRM export' });
    expect(learning.aspect).toBe('source-reliability');
    expect(learning.status).toBe('active');
    expect(learning.versionCount).toBe(1);
    expect(learning.currentVersion).toEqual(version);
    expect(learning.previousVersion).toBeNull();
    expect(learning.createdAt).toBe(learning.currentVersion.recordedAt);
    expect(learning.lastUpdatedAt).toBe(learning.currentVersion.recordedAt);
    expect(() => new Date(learning.createdAt)).not.toThrow();
  });

  it('appends version 2 without rewriting version 1 (what changed and why)', async () => {
    const ctx = member(tenantChain);
    const first = await recordCompanyLearning(
      ctx,
      learningInput({ aspect: 'source-reliability-probe' }),
    );
    const { learning, version } = await recordCompanyLearning(
      ctx,
      learningInput({
        aspect: 'source-reliability-probe',
        value: { usefulness: 0.5 },
        confidence: 0.9,
        channel: 'behavioral',
        reason: 'three investigations went to the CRM export first and were answered',
        evidence: [{ kind: 'observation', id: OBSERVATION_ID_2, label: 'acquisition trace' }],
      }),
    );

    expect(version.version).toBe(2);
    expect(version.isCurrent).toBe(true);
    expect(learning.versionCount).toBe(2);
    expect(learning.currentVersion).toEqual(version);

    // the previous version is retained intact — the "what changed" half
    const previous = learning.previousVersion!;
    expect(previous.id).toBe(first.version.id);
    expect(previous.version).toBe(1);
    expect(previous.isCurrent).toBe(false);
    expect(previous.value).toEqual({ usefulness: 0.8 });
    expect(previous.confidence).toBe(0.7);
    // the "why" half is the new version's required reason
    expect(version.reason).toBe('three investigations went to the CRM export first and were answered');

    // the deep read of the old version agrees
    const deepFirst = await getCompanyLearningVersion(ctx, first.version.id);
    expect(deepFirst.isCurrent).toBe(false);
    expect(deepFirst.value).toEqual({ usefulness: 0.8 });

    // and the chain read is stable
    const reread = await getCompanyLearning(ctx, learning.id);
    expect(reread.versionCount).toBe(2);
    expect(reread.currentVersion.version).toBe(2);
    expect(reread.previousVersion!.version).toBe(1);
  });

  it('versions monotonically and exposes the ascending audit trail', async () => {
    const ctx = member(tenantChain);
    const target = { kind: 'channel', id: CHANNEL_ID, label: '#ops' } as const;
    await recordCompanyLearning(ctx, learningInput({ target, aspect: 'preferred-channel', value: 'email' }));
    await recordCompanyLearning(ctx, learningInput({ target, aspect: 'preferred-channel', value: 'slack' }));
    await recordCompanyLearning(
      ctx,
      learningInput({ target, aspect: 'preferred-channel', value: 'slack-dm', confidence: 0.95 }),
    );

    const chains = await listCompanyLearnings(ctx, { targetKind: 'channel', targetId: CHANNEL_ID });
    expect(chains).toHaveLength(1);
    const chain = chains[0]!;
    expect(chain.versionCount).toBe(3);
    expect(chain.currentVersion.version).toBe(3);
    expect(chain.currentVersion.value).toBe('slack-dm');
    expect(chain.previousVersion!.version).toBe(2);

    const history = await listCompanyLearningVersions(ctx, { learningId: chain.id });
    expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(history.map((v) => v.value)).toEqual(['email', 'slack', 'slack-dm']);
    expect(history.filter((v) => v.isCurrent).map((v) => v.version)).toEqual([3]);
    expect(history.map((v) => v.authoritative)).toEqual([false, false, false]);
  });

  it('separates chains by aspect (same target) and keeps versioning per chain', async () => {
    const ctx = member(tenantChain);
    const a = await recordCompanyLearning(ctx, learningInput({ aspect: 'aspect-a' }));
    const b = await recordCompanyLearning(ctx, learningInput({ aspect: 'aspect-b' }));
    expect(a.learning.id).not.toBe(b.learning.id);
    expect(a.learning.versionCount).toBe(1);
    expect(b.learning.versionCount).toBe(1);

    // a second feedback on aspect-b does not touch aspect-a
    await recordCompanyLearning(ctx, learningInput({ aspect: 'aspect-b', value: 2 }));
    const aReread = await getCompanyLearning(ctx, a.learning.id);
    expect(aReread.versionCount).toBe(1);
    const bReread = await getCompanyLearning(ctx, b.learning.id);
    expect(bReread.versionCount).toBe(2);
  });

  it('accepts every target kind as an opaque forward reference', async () => {
    const ctx = member(tenantChain);
    const cases = [
      { kind: 'source', id: SOURCE_ID, label: 'CRM export' },
      { kind: 'person', id: PERSON_ID, label: 'Ops lead' },
      { kind: 'agent', id: AGENT_ID, label: 'Collections agent' },
      { kind: 'extension', id: EXTENSION_ID, label: 'Dunning extension' },
      { kind: 'mission', id: OBSERVATION_ID, label: 'Churn root cause' },
      { kind: 'channel', id: CHANNEL_ID, label: '#ops' },
      { kind: 'process', id: SOURCE_ID_2, label: 'Order-to-cash' },
      { kind: 'capability', id: OBSERVATION_ID_2, label: 'Collections' },
    ] as const;
    for (const [index, target] of cases.entries()) {
      const { learning } = await recordCompanyLearning(
        ctx,
        learningInput({ target, aspect: `usefulness-${index}` }),
      );
      expect(learning.target).toEqual(target);
    }
  });

  it('rejects malformed input at the contract boundary', async () => {
    const ctx = member(tenantChain);
    await expectCode('invalid_learning_input', () =>
      recordCompanyLearning(ctx, learningInput({ channel: 'implicit' as never })),
    );
    await expectCode('invalid_learning_input', () =>
      recordCompanyLearning(ctx, learningInput({ confidence: 1.5 })),
    );
    await expectCode('invalid_learning_input', () =>
      recordCompanyLearning(ctx, learningInput({ value: null })),
    );
    // a caller cannot even express a policy claim (lock 14)
    await expectCode('invalid_learning_input', () =>
      recordCompanyLearning(ctx, learningInput({ authoritative: true } as never)),
    );
    await expectCode('invalid_context', () =>
      recordCompanyLearning({ tenantId: ' ', principalId: 'p', authority: [] }, learningInput()),
    );
  });
});

// ---------------------------------------------------------------------------
// The three feedback legs
// ---------------------------------------------------------------------------

describe('the three feedback channels', () => {
  it('explicit feedback is a statement — no evidence or outcome link required', async () => {
    const ctx = member(tenantChannels);
    const { version } = await recordCompanyLearning(
      ctx,
      learningInput({ channel: 'explicit', evidence: [], outcomeId: null }),
    );
    expect(version.channel).toBe('explicit');
    expect(version.evidence).toEqual([]);
    expect(version.outcomeId).toBeNull();
    expect(version.outcomeAssessment).toBeNull();
  });

  it('behavioral feedback requires evidence and round-trips it', async () => {
    const ctx = member(tenantChannels);
    await expectCode('invalid_learning_input', () =>
      recordCompanyLearning(ctx, learningInput({ channel: 'behavioral', evidence: [] })),
    );
    const { version } = await recordCompanyLearning(
      ctx,
      learningInput({
        channel: 'behavioral',
        evidence: [{ kind: 'event', id: OBSERVATION_ID, label: 'opened within 2 minutes' }],
        value: { usefulness: 0.9 },
      }),
    );
    expect(version.evidence).toEqual([{ kind: 'event', id: OBSERVATION_ID, label: 'opened within 2 minutes' }]);
  });

  it('outcome feedback is grounded in a settled outcome and freezes its assessment', async () => {
    const ctx = member(tenantChannels);
    const settled = await seedSettledOutcome(ctx); // churn 8.4 → ≤6.0, realized 5.1 → exceeded

    const { learning, version } = await recordCompanyLearning(
      ctx,
      learningInput({
        target: { kind: 'capability', id: CAPABILITY_ID, label: 'Churn play' },
        aspect: 'intervention-prior',
        channel: 'outcome',
        outcomeId: settled.id,
        value: { prior: 'exceeded', expectedVsRealized: settled.realization!.varianceVsExpected },
        confidence: 0.95,
        reason: 'the churn play realized 5.1% against a 6.0% expectation — record the prior',
      }),
    );
    expect(version.channel).toBe('outcome');
    expect(version.outcomeId).toBe(settled.id);
    expect(version.outcomeAssessment).toBe('exceeded');
    expect(learning.currentVersion.outcomeAssessment).toBe('exceeded');

    // the deep read is self-contained (the frozen snapshot travels with the version)
    const deep = await getCompanyLearningVersion(ctx, version.id);
    expect(deep.outcomeId).toBe(settled.id);
    expect(deep.outcomeAssessment).toBe('exceeded');
  });

  it('rejects outcome feedback that is not grounded in a settled outcome', async () => {
    const ctx = member(tenantChannels);
    // an open outcome cannot be outcome feedback yet
    const open = await defineOutcome(ctx, {
      subject: { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'Open play' },
      metricName: 'open metric',
      metricUnit: 'percent',
      direction: 'at_least',
      baseline: 1,
      expected: 2,
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_outcome_ref', () =>
      recordCompanyLearning(ctx, learningInput({ channel: 'outcome', outcomeId: open.id })),
    );

    // an abandoned outcome is equally ungrounded
    const abandoned = await defineOutcome(ctx, {
      subject: { kind: 'mission', id: OBSERVATION_ID, label: 'Overtaken mission' },
      metricName: 'abandoned metric',
      metricUnit: 'percent',
      direction: 'at_least',
      baseline: 1,
      expected: 2,
      actor: { kind: 'person', id: PERSON_ID },
    });
    await abandonOutcome(ctx, {
      outcomeId: abandoned.id,
      reason: 'overtaken by events',
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_outcome_ref', () =>
      recordCompanyLearning(ctx, learningInput({ channel: 'outcome', outcomeId: abandoned.id })),
    );

    // missing and malformed ids are uniform (no existence leak)
    await expectCode('outcome_not_found', () =>
      recordCompanyLearning(ctx, learningInput({ channel: 'outcome', outcomeId: newId() })),
    );
    await expectCode('invalid_learning_input', () =>
      recordCompanyLearning(ctx, learningInput({ channel: 'outcome', outcomeId: 'not-a-uuid' })),
    );
  });
});

// ---------------------------------------------------------------------------
// Validity windows
// ---------------------------------------------------------------------------

describe('validity windows', () => {
  it('accepts a future validity end and reports the chain active', async () => {
    const ctx = member(tenantValidity);
    const { learning } = await recordCompanyLearning(
      ctx,
      learningInput({ validUntil: '2099-12-31' }),
    );
    expect(learning.currentVersion.validUntil).toBe('2099-12-31');
    expect(learning.status).toBe('active');
  });

  it('rejects a validity window that is already elapsed', async () => {
    const ctx = member(tenantValidity);
    await expectCode('invalid_learning_input', () =>
      recordCompanyLearning(ctx, learningInput({ validUntil: '2020-01-01' })),
    );
  });

  it('derives the expired status at read time and filters by it', async () => {
    const ctx = member(tenantValidity);
    // one active chain through the service
    const active = await recordCompanyLearning(ctx, learningInput({ aspect: 'active-aspect' }));

    // one expired chain, seeded at the storage level (the service refuses to
    // mint born-expired assertions, so the fixture bypasses it — the same
    // discipline the W040 suite applies to trigger probes)
    const seededHead = await getDb().query<{ id: string }>(
      `INSERT INTO company_learnings (tenant_id, target_kind, target_id, target_label, aspect)
         VALUES ($1, 'source', $2, 'CRM export', 'expired-aspect') RETURNING id`,
      [tenantValidity, SOURCE_ID],
    );
    const seededId = seededHead.rows[0]!.id;
    await getDb().query(
      `INSERT INTO company_learning_versions (
         tenant_id, company_learning_id, version, channel, value, confidence,
         evidence, reason, valid_from, valid_until,
         actor_kind, actor_label, recorded_by_principal
       ) VALUES (
         $1, $2, 1, 'explicit', $3::jsonb, 0.5,
         '[]'::jsonb, 'seeded expired validity', now(), '2020-01-01',
         'system', 'w041-fixture', 'fixture-principal'
       )`,
      [tenantValidity, seededId, JSON.stringify({ usefulness: 0.1 })],
    );

    const expired = await getCompanyLearning(ctx, seededId);
    expect(expired.status).toBe('expired');
    expect(expired.currentVersion.validUntil).toBe('2020-01-01');
    expect(expired.currentVersion.authoritative).toBe(false);

    const actives = await listCompanyLearnings(ctx, { validity: 'active' });
    expect(actives.map((c) => c.id)).toContain(active.learning.id);
    expect(actives.map((c) => c.id)).not.toContain(seededId);

    const expiredOnly = await listCompanyLearnings(ctx, { validity: 'expired' });
    expect(expiredOnly.map((c) => c.id)).toEqual([seededId]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('keeps chains, versions and outcome groundings tenant-scoped', async () => {
    const ctxA = member(tenantIso);
    const ctxB = member(tenantB);
    const { learning, version } = await recordCompanyLearning(ctxA, learningInput());
    const settledA = await seedSettledOutcome(ctxA);

    // B sees neither the chain nor the version
    await expectCode('learning_not_found', () => getCompanyLearning(ctxB, learning.id));
    await expectCode('learning_version_not_found', () => getCompanyLearningVersion(ctxB, version.id));
    await expectCode('learning_not_found', () =>
      listCompanyLearningVersions(ctxB, { learningId: learning.id }),
    );
    expect(await listCompanyLearnings(ctxB, {})).toHaveLength(0);

    // B cannot ground its outcome feedback in A's settled outcome
    await expectCode('outcome_not_found', () =>
      recordCompanyLearning(ctxB, learningInput({ channel: 'outcome', outcomeId: settledA.id })),
    );

    // the same target+aspect in B is an INDEPENDENT chain (the chain key
    // includes tenant_id): version numbering starts fresh
    const inB = await recordCompanyLearning(ctxB, learningInput({ value: 'other company' }));
    expect(inB.learning.id).not.toBe(learning.id);
    expect(inB.version.version).toBe(1);
    expect(inB.learning.versionCount).toBe(1);

    // and A's chain is untouched by B's learning
    const aReread = await getCompanyLearning(ctxA, learning.id);
    expect(aReread.versionCount).toBe(1);
    expect(aReread.currentVersion.value).toEqual({ usefulness: 0.8 });
  });

  it('reports malformed and missing ids uniformly', async () => {
    const ctx = member(tenantIso);
    await expectCode('learning_not_found', () => getCompanyLearning(ctx, 'not-a-uuid'));
    await expectCode('learning_not_found', () => getCompanyLearning(ctx, newId()));
    await expectCode('learning_version_not_found', () => getCompanyLearningVersion(ctx, 'not-a-uuid'));
    await expectCode('learning_version_not_found', () => getCompanyLearningVersion(ctx, newId()));
    await expectCode('invalid_query', () =>
      listCompanyLearningVersions(ctx, { learningId: 'not-a-uuid' }),
    );
    await expectCode('learning_not_found', () =>
      listCompanyLearningVersions(ctx, { learningId: newId() }),
    );
  });
});

// ---------------------------------------------------------------------------
// Without mutating policy silently (the item's constraint, lock 14)
// ---------------------------------------------------------------------------

describe('without mutating policy silently', () => {
  it('records feedback of every channel without touching authority policy', async () => {
    const ctx = member(tenantPolicy);
    const admin = policyAdmin(tenantPolicy);

    // a concrete tenant policy row exists before any learning happens
    const before = await setAuthorityPolicy(admin, {
      actionKind: 'company-learning-policy-probe',
      approvalLevels: ['EXECUTE'],
      forbiddenLevels: [],
      note: 'W041 policy mutation probe',
    });

    const settled = await seedSettledOutcome(ctx);
    await recordCompanyLearning(ctx, learningInput({ aspect: 'probe-explicit' }));
    await recordCompanyLearning(
      ctx,
      learningInput({
        aspect: 'probe-behavioral',
        channel: 'behavioral',
        evidence: [{ kind: 'observation', id: OBSERVATION_ID }],
      }),
    );
    await recordCompanyLearning(
      ctx,
      learningInput({ aspect: 'probe-outcome', channel: 'outcome', outcomeId: settled.id }),
    );

    // the policy row is untouched — same row, same updatedAt, same levels
    const after = await getAuthorityPolicy(ctx, { actionKind: 'company-learning-policy-probe' });
    expect(after).toEqual(before);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('exposes authoritative === false on every read surface', async () => {
    const ctx = member(tenantPolicy);
    const settled = await seedSettledOutcome(ctx);
    const { learning, version } = await recordCompanyLearning(
      ctx,
      learningInput({ aspect: 'authority-probe', channel: 'outcome', outcomeId: settled.id }),
    );
    await recordCompanyLearning(ctx, learningInput({ aspect: 'authority-probe', value: 'v2' }));

    const chain = await getCompanyLearning(ctx, learning.id);
    expect(chain.currentVersion.authoritative).toBe(false);
    expect(chain.previousVersion!.authoritative).toBe(false);
    const deep = await getCompanyLearningVersion(ctx, version.id);
    expect(deep.authoritative).toBe(false);
    const history = await listCompanyLearningVersions(ctx, { learningId: learning.id });
    expect(history.every((v) => v.authoritative === false)).toBe(true);
    const listed = await listCompanyLearnings(ctx, {});
    expect(listed.every((c) => c.currentVersion.authoritative === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Storage-level append-only (the silent-mutation backstop)
// ---------------------------------------------------------------------------

describe('storage is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on both company-learning tables', async () => {
    const ctx = member(tenantStorage);
    const { learning } = await recordCompanyLearning(ctx, learningInput());

    const attempts: Array<() => Promise<unknown>> = [
      () => getDb().query(`UPDATE company_learnings SET aspect = 'smuggled' WHERE id = $1`, [learning.id]),
      () => getDb().query(`DELETE FROM company_learnings WHERE id = $1`, [learning.id]),
      () => getDb().query(`TRUNCATE company_learnings`),
      () =>
        getDb().query(
          `UPDATE company_learning_versions SET confidence = 1 WHERE tenant_id = $1 AND company_learning_id = $2`,
          [tenantStorage, learning.id],
        ),
      () =>
        getDb().query(
          `DELETE FROM company_learning_versions WHERE tenant_id = $1 AND company_learning_id = $2`,
          [tenantStorage, learning.id],
        ),
      () => getDb().query(`TRUNCATE company_learning_versions`),
    ];
    for (const attempt of attempts) {
      // TRUNCATE may be stopped either by the append-only triggers or by
      // PostgreSQL's own foreign-key protection (the W040 suite's rule)
      await expect(attempt()).rejects.toThrow(/append-only|cannot truncate/);
    }

    // the chain survived every attempt, intact
    const reread = await getCompanyLearning(ctx, learning.id);
    expect(reread.aspect).toBe('source-reliability');
    expect(reread.currentVersion.confidence).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// Listing surfaces
// ---------------------------------------------------------------------------

describe('listCompanyLearnings', () => {
  let extensionChain: CompanyLearning;

  beforeAll(async () => {
    const ctx = member(tenantList);
    const settled = await seedSettledOutcome(ctx);

    await recordCompanyLearning(
      ctx,
      learningInput({ aspect: 'source-reliability', channel: 'explicit' }),
    );
    await recordCompanyLearning(
      ctx,
      learningInput({
        target: { kind: 'source', id: SOURCE_ID_2, label: 'Ticket export' },
        aspect: 'source-reliability',
        channel: 'behavioral',
        evidence: [{ kind: 'observation', id: OBSERVATION_ID }],
      }),
    );
    await recordCompanyLearning(
      ctx,
      learningInput({
        target: { kind: 'person', id: PERSON_ID, label: 'Ops lead' },
        aspect: 'expertise',
        channel: 'outcome',
        outcomeId: settled.id,
      }),
    );
    const extensionFirst = await recordCompanyLearning(
      ctx,
      learningInput({
        target: { kind: 'extension', id: EXTENSION_ID, label: 'Dunning extension' },
        aspect: 'source-reliability',
        channel: 'explicit',
        value: 'v1',
      }),
    );
    extensionChain = (
      await recordCompanyLearning(
        ctx,
        learningInput({
          target: { kind: 'extension', id: EXTENSION_ID, label: 'Dunning extension' },
          aspect: 'source-reliability',
          channel: 'explicit',
          value: 'v2',
        }),
      )
    ).learning;
    expect(extensionFirst.learning.id).toBe(extensionChain.id);
  });

  it('filters by target kind/id, aspect, current channel and validity', async () => {
    const ctx = member(tenantList);

    expect(await listCompanyLearnings(ctx, {})).toHaveLength(4);
    const sources = await listCompanyLearnings(ctx, { targetKind: 'source' });
    expect(sources).toHaveLength(2);
    expect(await listCompanyLearnings(ctx, { targetKind: 'source', targetId: SOURCE_ID })).toHaveLength(1);
    expect(await listCompanyLearnings(ctx, { targetKind: 'source', targetId: AGENT_ID })).toHaveLength(0);

    expect(await listCompanyLearnings(ctx, { aspect: 'expertise' })).toHaveLength(1);
    expect((await listCompanyLearnings(ctx, { aspect: 'expertise' }))[0]!.target.kind).toBe('person');

    // channel filters on the CURRENT version — the extension chain's two
    // explicit versions and the source chain's explicit feedback match;
    // behavioral and outcome channels each surface their own
    expect(await listCompanyLearnings(ctx, { channel: 'explicit' })).toHaveLength(2);
    expect(await listCompanyLearnings(ctx, { channel: 'behavioral' })).toHaveLength(1);
    expect(await listCompanyLearnings(ctx, { channel: 'outcome' })).toHaveLength(1);

    expect(await listCompanyLearnings(ctx, { validity: 'active' })).toHaveLength(4);
    expect(await listCompanyLearnings(ctx, { validity: 'expired' })).toHaveLength(0);
  });

  it('orders most recently learned first and bounds the limit', async () => {
    const ctx = member(tenantList);
    const listed = await listCompanyLearnings(ctx, {});
    const updated = listed.map((c) => new Date(c.lastUpdatedAt).getTime());
    expect([...updated].sort((a, b) => b - a)).toEqual(updated);

    expect(await listCompanyLearnings(ctx, { limit: 2 })).toHaveLength(2);
    await expectCode('invalid_query', () => listCompanyLearnings(ctx, { limit: 0 }));
    await expectCode('invalid_query', () => listCompanyLearnings(ctx, { targetId: SOURCE_ID }));
    await expectCode('invalid_query', () => listCompanyLearnings(ctx, { validity: 'terminal' as never }));
  });
});

// ---------------------------------------------------------------------------
// Deep version reads
// ---------------------------------------------------------------------------

describe('getCompanyLearningVersion', () => {
  it('deep-links one version with the correct derived isCurrent', async () => {
    const ctx = member(tenantA);
    const first = await recordCompanyLearning(ctx, learningInput());
    const second = await recordCompanyLearning(ctx, learningInput({ value: 'v2' }));

    const deep1 = await getCompanyLearningVersion(ctx, first.version.id);
    expect(deep1.version).toBe(1);
    expect(deep1.isCurrent).toBe(false);
    expect(deep1.value).toEqual({ usefulness: 0.8 });

    const deep2 = await getCompanyLearningVersion(ctx, second.version.id);
    expect(deep2.version).toBe(2);
    expect(deep2.isCurrent).toBe(true);
    expect(deep2.learningId).toBe(first.learning.id);
    expect(deep2.authoritative).toBe(false);
  });

  it('round-trips every field of a version', async () => {
    const ctx = member(tenantA);
    const principalId = newId();
    const settled = await seedSettledOutcome(ctx);
    const { version } = await recordCompanyLearning(
      memberAs(tenantA, principalId),
      learningInput({
        aspect: 'deep-round-trip',
        channel: 'outcome',
        outcomeId: settled.id,
        confidence: 0.42,
        validUntil: '2099-06-30',
        reason: 'deep-read round trip',
      }),
    );
    const deep: CompanyLearningVersion = await getCompanyLearningVersion(ctx, version.id);
    expect(deep).toEqual({
      id: version.id,
      tenantId: tenantA,
      learningId: version.learningId,
      version: 1,
      isCurrent: true,
      channel: 'outcome',
      value: { usefulness: 0.8 },
      confidence: 0.42,
      evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'churn export' }],
      outcomeId: settled.id,
      outcomeAssessment: 'exceeded',
      reason: 'deep-read round trip',
      validFrom: version.validFrom,
      validUntil: '2099-06-30',
      actor: { kind: 'person', id: PERSON_ID, label: null },
      recordedByPrincipal: principalId,
      recordedAt: version.recordedAt,
      authoritative: false,
    });
  });
});
