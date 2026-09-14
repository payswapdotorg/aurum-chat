// Integration tests for the freshness module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port, including the
// cross-module integration with the observations contract. Covers the W006
// acceptance:
//
//  * VERSIONING of mutable state ("version mutable relationships/beliefs"):
//      - append-only revision chains per (tenant, subject kind, subject id)
//        with strictly increasing valid time; derived valid intervals and
//        current flag; asOf resolution ("what did we believe as of <t>");
//      - history is never rewritten: no mutation operation on the contract,
//        PostgreSQL rejects UPDATE/DELETE/TRUNCATE (triggers), and
//        version/recordedAt/validTo/current are system-minted (smuggled
//        fields rejected);
//      - every revision carries provenance — supporting observations must
//        exist in the tenant and be readable by the recording principal.
//  * TRACKING observation latency, source freshness and stale-after policy:
//      - latency = recordedAt − observedAt (clamped at skew), with the
//        policy's max-latency alarm;
//      - source freshness = age of a source's newest evidence (not merely
//        the newest commit) with per-window latency aggregates;
//      - temporal-state freshness = age of the newest readable supporting
//        evidence behind the version valid at asOf;
//      - deterministic current/aging/stale classification against
//        tenant-scoped policies, with resolution order (specific → default).
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as freshnessContract from '../contract';
import * as observationsContract from '@/modules/observations/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ObservationsError } from '@/modules/observations/contract';
import { FreshnessError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const {
  evaluateObservationFreshness,
  evaluateSourceFreshness,
  evaluateTemporalStateFreshness,
  getFreshnessPolicy,
  getTemporalState,
  listFreshnessPolicies,
  listTemporalHistory,
  recordTemporalRevision,
  resolveFreshnessPolicy,
  setFreshnessPolicy,
} = freshnessContract;
const { recordObservation } = observationsContract;

// Dedicated tenants keep each concern's data (and policies!) isolated from
// the others, so every assertion below sees only what it created itself.
const tenantA = newId();
const tenantB = newId();
const tenantPolicy = newId();
const tenantEval = newId();
const tenantLatency = newId();
const tenantSource = newId();
const tenantSourceLatency = newId();
const tenantState = newId();

const T0 = '2026-09-14T09:15:00.000Z'; // .000Z — the format instants round-trip in
const T0_PLUS = (seconds: number): string =>
  new Date(Date.parse(T0) + seconds * 1000).toISOString();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/** A minimal observation input, parameterized on observedAt/source. */
function observationInput(observedAt: string): Parameters<typeof recordObservation>[1] {
  return {
    kind: 'metric.sample',
    payload: { metric: 'dso', value: 41.5 },
    observedAt,
    source: { kind: 'person', label: 'office-manager' },
    channel: 'ingestion',
    confidence: { value: 0.9, method: 'source_trust' },
  };
}

async function seedObservation(
  ctx: TenantContext,
  observedAt: string,
): Promise<{ id: string; observedAt: string; recordedAt: string }> {
  const recorded = await recordObservation(ctx, { ...observationInput(observedAt) });
  return { id: recorded.id, observedAt: recorded.observedAt, recordedAt: recorded.recordedAt };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', async () => {
    // There is deliberately no updateTemporalRevision, no
    // deleteTemporalRevision, no supersedInPlace, and no removePolicy:
    // superseding is appending; policy lifecycle beyond upsert is not
    // W006 scope.
    expect(Object.keys(freshnessContract).sort()).toEqual([
      'DEFAULT_POLICY_LIST_LIMIT',
      'FRESHNESS_STATUSES',
      'FreshnessError',
      'MAX_POLICY_LIST_LIMIT',
      'MAX_PROVENANCE_OBSERVATIONS',
      'MAX_STATE_BYTES',
      'SOURCE_SUBJECT_KIND',
      'classifyFreshness',
      'evaluateObservationFreshness',
      'evaluateSourceFreshness',
      'evaluateTemporalStateFreshness',
      'evidenceAgeSeconds',
      'getFreshnessPolicy',
      'getTemporalState',
      'isFreshnessStatus',
      'listFreshnessPolicies',
      'listTemporalHistory',
      'observationLatencySeconds',
      'recordTemporalRevision',
      'resolveFreshnessPolicy',
      'setFreshnessPolicy',
    ]);
  });
});

describe('versioning mutable state (append-only revision chains)', () => {
  const kind = 'world.relationship';
  const subjectId = newId();

  it('records revisions with system-minted version, commit time and provenance', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);

    const before = new Date();
    const v1 = await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId,
      state: { strength: 'strong', tier: 'primary' },
      validFrom: T0,
      observationIds: [evidence.id],
      rationale: 'initial supplier assessment',
    });
    const after = new Date();

    expect(v1.tenantId).toBe(tenantA);
    expect(v1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(v1.version).toBe(1);
    expect(v1.state).toEqual({ strength: 'strong', tier: 'primary' });
    expect(v1.validFrom).toBe(T0);
    expect(v1.validTo).toBeNull();
    expect(v1.current).toBe(true);
    expect(v1.provenance.observationIds).toEqual([evidence.id]);
    expect(v1.rationale).toBe('initial supplier assessment');
    expect(Date.parse(v1.recordedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(v1.recordedAt)).toBeLessThanOrEqual(after.getTime());
  });

  it('rejects caller-smuggled identity/version/tenancy/derived fields', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0_PLUS(60));
    const base = {
      subjectKind: kind,
      subjectId: newId(),
      state: { x: 1 },
      validFrom: T0_PLUS(120),
      observationIds: [evidence.id],
    };
    for (const smuggled of ['id', 'tenantId', 'version', 'recordedAt', 'validTo', 'current']) {
      await expect(
        recordTemporalRevision(ctx, {
          ...base,
          [smuggled]: smuggled === 'version' || smuggled === 'current' ? 2 : newId(),
        } as never),
      ).rejects.toMatchObject({ code: 'invalid_revision_input' });
    }
  });

  it('builds the chain: superseding appends and never rewrites history', async () => {
    const ctx = member(tenantA);
    const chainSubject = newId(); // dedicated subject for a clean chain
    const evidence1 = await seedObservation(ctx, T0);
    const evidence2 = await seedObservation(ctx, T0_PLUS(1800));
    const evidence3 = await seedObservation(ctx, T0_PLUS(5400));

    const v1 = await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: chainSubject,
      state: { strength: 'strong' },
      validFrom: T0,
      observationIds: [evidence1.id],
    });
    const v2 = await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: chainSubject,
      state: { strength: 'weak', reason: 'delivery slips' },
      validFrom: T0_PLUS(3600),
      observationIds: [evidence2.id],
      rationale: 'quarterly review contradicted the prior assessment',
    });
    const v3 = await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: chainSubject,
      state: { strength: 'recovering' },
      validFrom: T0_PLUS(7200),
      observationIds: [evidence3.id, evidence2.id], // provenance is a set: deduped + sorted
    });

    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    // every append is the open-ended current until the next one lands
    expect(v1.current).toBe(true);
    expect(v3.current).toBe(true);

    const history = await listTemporalHistory(ctx, { subjectKind: kind, subjectId: chainSubject });
    expect(history.map((revision) => revision.version)).toEqual([1, 2, 3]);
    // derived intervals: [validFrom_i, validFrom_{i+1})
    expect(history[0]!.validTo).toBe(T0_PLUS(3600));
    expect(history[1]!.validTo).toBe(T0_PLUS(7200));
    expect(history[2]!.validTo).toBeNull();
    expect(history.map((revision) => revision.current)).toEqual([false, false, true]);
    // per-version provenance is retained (the contradiction chain stays auditable)
    expect(history[0]!.provenance.observationIds).toEqual([evidence1.id]);
    expect(history[1]!.provenance.observationIds).toEqual([evidence2.id]);
    expect(history[2]!.provenance.observationIds).toEqual([evidence2.id, evidence3.id].sort());
    // and the original version's state is exactly as recorded
    expect(history[0]!.state).toEqual({ strength: 'strong' });
  });

  it('resolves the version valid at an asOf instant (inclusive start, exclusive end)', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);
    const subject = newId();
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { phase: 'one' },
      validFrom: T0,
      observationIds: [evidence.id],
    });
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { phase: 'two' },
      validFrom: T0_PLUS(3600),
      observationIds: [evidence.id],
    });

    // before the first version: nothing valid yet
    await expect(
      getTemporalState(ctx, { subjectKind: kind, subjectId: subject, asOf: T0_PLUS(-1) }),
    ).rejects.toMatchObject({ code: 'temporal_state_not_found' });

    // at exactly validFrom: valid (inclusive)
    const atStart = await getTemporalState(ctx, {
      subjectKind: kind,
      subjectId: subject,
      asOf: T0,
    });
    expect(atStart.state).toEqual({ phase: 'one' });
    expect(atStart.validTo).toBe(T0_PLUS(3600));
    expect(atStart.current).toBe(false);

    // inside the first interval
    const mid = await getTemporalState(ctx, {
      subjectKind: kind,
      subjectId: subject,
      asOf: T0_PLUS(1800),
    });
    expect(mid.version).toBe(1);

    // at exactly the second start: the second version (previous ends here)
    const atSwitch = await getTemporalState(ctx, {
      subjectKind: kind,
      subjectId: subject,
      asOf: T0_PLUS(3600),
    });
    expect(atSwitch.version).toBe(2);
    expect(atSwitch.current).toBe(true);

    // after everything: still the latest
    const late = await getTemporalState(ctx, {
      subjectKind: kind,
      subjectId: subject,
      asOf: T0_PLUS(86400),
    });
    expect(late.version).toBe(2);
  });

  it('defaults asOf to the service clock (now resolves the latest past version)', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);
    const subject = newId();
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { phase: 'past' },
      validFrom: T0,
      observationIds: [evidence.id],
    });
    const now = await getTemporalState(ctx, { subjectKind: kind, subjectId: subject });
    expect(now.version).toBe(1); // T0 is comfortably in the past for any run
    expect(now.current).toBe(true);
  });

  it('treats a future validFrom as not-yet-valid (scheduled understanding)', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);
    const subject = newId();
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { phase: 'now' },
      validFrom: T0,
      observationIds: [evidence.id],
    });
    const v2 = await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { phase: 'scheduled' },
      validFrom: T0_PLUS(86_400), // tomorrow
      observationIds: [evidence.id],
    });
    expect(v2.version).toBe(2);

    const today = await getTemporalState(ctx, {
      subjectKind: kind,
      subjectId: subject,
      asOf: T0_PLUS(3600),
    });
    expect(today.version).toBe(1);
    expect(today.validTo).toBe(T0_PLUS(86_400)); // open-ended for resolution…
    expect(today.current).toBe(false); // …but NOT the latest recorded version

    const tomorrow = await getTemporalState(ctx, {
      subjectKind: kind,
      subjectId: subject,
      asOf: T0_PLUS(86_400),
    });
    expect(tomorrow.version).toBe(2);
    expect(tomorrow.current).toBe(true);
  });

  it('keeps subject kinds as independent chains for the same subject id', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);
    const subject = newId();
    await recordTemporalRevision(ctx, {
      subjectKind: 'world.relationship',
      subjectId: subject,
      state: { a: 1 },
      validFrom: T0,
      observationIds: [evidence.id],
    });
    await recordTemporalRevision(ctx, {
      subjectKind: 'epistemics.belief',
      subjectId: subject,
      state: { b: 2 },
      validFrom: T0,
      observationIds: [evidence.id],
    });
    const relationships = await listTemporalHistory(ctx, {
      subjectKind: 'world.relationship',
      subjectId: subject,
    });
    const beliefs = await listTemporalHistory(ctx, {
      subjectKind: 'epistemics.belief',
      subjectId: subject,
    });
    expect(relationships).toHaveLength(1);
    expect(beliefs).toHaveLength(1);
    expect(relationships[0]!.state).toEqual({ a: 1 });
    expect(beliefs[0]!.state).toEqual({ b: 2 });
  });

  it('enforces the strictly increasing valid-time chain', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);
    const subject = newId();
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { v: 1 },
      validFrom: T0_PLUS(3600),
      observationIds: [evidence.id],
    });
    // equal validFrom
    await expect(
      recordTemporalRevision(ctx, {
        subjectKind: kind,
        subjectId: subject,
        state: { v: 2 },
        validFrom: T0_PLUS(3600),
        observationIds: [evidence.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_revision_input' });
    // back-dated validFrom (no late-arriving out-of-order versions at W006)
    await expect(
      recordTemporalRevision(ctx, {
        subjectKind: kind,
        subjectId: subject,
        state: { v: 2 },
        validFrom: T0,
        observationIds: [evidence.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_revision_input' });

    const history = await listTemporalHistory(ctx, { subjectKind: kind, subjectId: subject });
    expect(history).toHaveLength(1); // nothing was appended
  });
});

describe('history is never rewritten (storage-level append-only)', () => {
  const kind = 'world.relationship';

  it('rejects UPDATE, DELETE and TRUNCATE on temporal revisions at the storage layer', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);
    const subject = newId();
    const revision = await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { strength: 'strong' },
      validFrom: T0,
      observationIds: [evidence.id],
    });

    await expect(
      getDb().query(`UPDATE temporal_revisions SET state = '{"strength":"tampered"}'::jsonb WHERE id = $1`, [
        revision.id,
      ]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      getDb().query(`DELETE FROM temporal_revisions WHERE id = $1`, [revision.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(getDb().query(`TRUNCATE temporal_revisions`)).rejects.toThrow(/append-only/i);

    // the revision survived all three attempts untouched
    const after = await getTemporalState(ctx, { subjectKind: kind, subjectId: subject, asOf: T0 });
    expect(after.state).toEqual({ strength: 'strong' });
    expect(after.version).toBe(1);
  });

  it('backs the chain invariants with unique constraints (race backstop)', async () => {
    const ctx = member(tenantA);
    const evidence = await seedObservation(ctx, T0);
    const subject = newId();
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId: subject,
      state: { v: 1 },
      validFrom: T0,
      observationIds: [evidence.id],
    });
    // same version number
    await expect(
      getDb().query(
        `INSERT INTO temporal_revisions (tenant_id, subject_kind, subject_id, version, state, valid_from, provenance_observation_ids)
           VALUES ($1, $2, $3, 1, '{"v":"forged"}'::jsonb, $4, '[]'::jsonb)`,
        [tenantA, kind, subject, new Date(T0_PLUS(60))],
      ),
    ).rejects.toThrow(/duplicate key/i);
    // same valid_from (different version)
    await expect(
      getDb().query(
        `INSERT INTO temporal_revisions (tenant_id, subject_kind, subject_id, version, state, valid_from, provenance_observation_ids)
           VALUES ($1, $2, $3, 99, '{"v":"forged"}'::jsonb, $4, '[]'::jsonb)`,
        [tenantA, kind, subject, new Date(T0)],
      ),
    ).rejects.toThrow(/duplicate key/i);

    const history = await listTemporalHistory(ctx, { subjectKind: kind, subjectId: subject });
    expect(history).toHaveLength(1);
    expect(history[0]!.state).toEqual({ v: 1 });
  });
});

describe('provenance enforcement (no versioned understanding without evidence)', () => {
  const kind = 'epistemics.belief';

  it('requires at least one supporting observation', async () => {
    const ctx = member(tenantA);
    await expect(
      recordTemporalRevision(ctx, {
        subjectKind: kind,
        subjectId: newId(),
        state: { p: 0.5 },
        validFrom: T0,
        observationIds: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_revision_input' });
  });

  it('rejects missing and cross-tenant supporting observations uniformly (no leak)', async () => {
    const ctxA = member(tenantA);
    const foreign = await seedObservation(member(tenantB), T0);

    await expect(
      recordTemporalRevision(ctxA, {
        subjectKind: kind,
        subjectId: newId(),
        state: { p: 0.5 },
        validFrom: T0,
        observationIds: [newId()], // does not exist anywhere
      }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });
    await expect(
      recordTemporalRevision(ctxA, {
        subjectKind: kind,
        subjectId: newId(),
        state: { p: 0.5 },
        validFrom: T0,
        observationIds: [foreign.id], // exists — in another tenant
      }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });
  });

  it('rejects deriving versions from principal-restricted evidence (but the owner may)', async () => {
    const owner = newId();
    const restricted = await recordObservation(memberAs(tenantA, owner), {
      ...observationInput(T0),
      payload: { metric: 'salary-band-feedback' },
      permissions: { visibility: 'principal', principalId: owner },
    });

    await expect(
      recordTemporalRevision(member(tenantA), {
        subjectKind: kind,
        subjectId: newId(),
        state: { p: 0.5 },
        validFrom: T0,
        observationIds: [restricted.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });

    const byOwner = await recordTemporalRevision(memberAs(tenantA, owner), {
      subjectKind: kind,
      subjectId: newId(),
      state: { p: 0.5 },
      validFrom: T0,
      observationIds: [restricted.id],
    });
    expect(byOwner.provenance.observationIds).toEqual([restricted.id]);
  });
});

describe('stale-after policies', () => {
  it('sets, gets, lists and upserts kind-default and subject-specific policies', async () => {
    const ctx = member(tenantPolicy);
    const subjectId = newId();

    const created = await setFreshnessPolicy(ctx, {
      subjectKind: 'source',
      staleAfterSeconds: 3600,
      agingAfterSeconds: 600,
      note: 'billing-system exports',
    });
    expect(created.tenantId).toBe(tenantPolicy);
    expect(created.subjectKind).toBe('source');
    expect(created.subjectId).toBeNull();
    expect(created.staleAfterSeconds).toBe(3600);
    expect(created.agingAfterSeconds).toBe(600);
    expect(created.maxLatencySeconds).toBeNull();
    expect(created.note).toBe('billing-system exports');
    expect(created.createdAt).toBeTruthy();

    const specific = await setFreshnessPolicy(ctx, {
      subjectKind: 'source',
      subjectId,
      staleAfterSeconds: 60,
      maxLatencySeconds: 30,
    });
    expect(specific.subjectId).toBe(subjectId);
    expect(specific.agingAfterSeconds).toBeNull();

    // upsert: same key → same row, new thresholds
    const updated = await setFreshnessPolicy(ctx, {
      subjectKind: 'source',
      staleAfterSeconds: 7200,
      agingAfterSeconds: 1800,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.staleAfterSeconds).toBe(7200);
    expect(updated.agingAfterSeconds).toBe(1800);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(updated.createdAt));

    // exact get
    const readDefault = await getFreshnessPolicy(ctx, { subjectKind: 'source' });
    expect(readDefault.staleAfterSeconds).toBe(7200);
    const readSpecific = await getFreshnessPolicy(ctx, { subjectKind: 'source', subjectId });
    expect(readSpecific.staleAfterSeconds).toBe(60);

    // list: defaults sort before specifics; filters by kind
    const listed = await listFreshnessPolicies(ctx, { subjectKind: 'source' });
    expect(listed.map((policy) => policy.subjectId)).toEqual([null, subjectId]);
    const limited = await listFreshnessPolicies(ctx, { subjectKind: 'source', limit: 1 });
    expect(limited).toHaveLength(1);
    expect((await listFreshnessPolicies(ctx, {})).length).toBeGreaterThanOrEqual(2);

    await expect(
      getFreshnessPolicy(ctx, { subjectKind: 'source', subjectId: newId() }),
    ).rejects.toMatchObject({ code: 'policy_not_found' });
    await expect(
      getFreshnessPolicy(ctx, { subjectKind: 'world.relationship' }),
    ).rejects.toMatchObject({ code: 'policy_not_found' });
  });

  it('resolves specific over the kind default, and null when nothing applies', async () => {
    const ctx = member(tenantPolicy);
    const subjectId = newId();
    const otherId = newId();

    await setFreshnessPolicy(ctx, { subjectKind: 'metric.sample', staleAfterSeconds: 86_400 });
    await setFreshnessPolicy(ctx, {
      subjectKind: 'metric.sample',
      subjectId,
      staleAfterSeconds: 300,
    });

    const specific = await resolveFreshnessPolicy(ctx, {
      subjectKind: 'metric.sample',
      subjectId,
    });
    expect(specific?.staleAfterSeconds).toBe(300);

    // unknown subject id falls back to the kind default
    const fallback = await resolveFreshnessPolicy(ctx, {
      subjectKind: 'metric.sample',
      subjectId: otherId,
    });
    expect(fallback?.staleAfterSeconds).toBe(86_400);

    // no default either → null (the caller decides what "unknown" means)
    expect(
      await resolveFreshnessPolicy(ctx, { subjectKind: 'channel.message', subjectId: otherId }),
    ).toBeNull();
    expect(await resolveFreshnessPolicy(ctx, { subjectKind: 'channel.message' })).toBeNull();
  });

  it('validates policy inputs and context shape', async () => {
    const ctx = member(tenantPolicy);
    await expect(
      setFreshnessPolicy(ctx, {
        subjectKind: 'source',
        staleAfterSeconds: 600,
        agingAfterSeconds: 600, // not strictly below
      }),
    ).rejects.toMatchObject({ code: 'invalid_policy_input' });
    await expect(
      setFreshnessPolicy(ctx, { subjectKind: 'source', staleAfterSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_policy_input' });
    await expect(
      setFreshnessPolicy(ctx, { subjectKind: 'has space', staleAfterSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'invalid_policy_input' });
    await expect(
      listFreshnessPolicies(ctx, { limit: 0 } as never),
    ).rejects.toMatchObject({ code: 'invalid_query' });
    await expect(
      setFreshnessPolicy({ tenantId: '', principalId: newId(), authority: [] }, {
        subjectKind: 'source',
        staleAfterSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });
});

describe('observation latency and staleness (evaluateObservationFreshness)', () => {
  it('classifies an observation against its kind policy with strict stale-after bounds', async () => {
    const ctx = member(tenantEval);
    await setFreshnessPolicy(ctx, {
      subjectKind: 'metric.sample',
      staleAfterSeconds: 3600,
      agingAfterSeconds: 600,
    });

    const observation = await recordObservation(ctx, observationInput(T0));

    const current = await evaluateObservationFreshness(ctx, {
      observationId: observation.id,
      asOf: T0_PLUS(300),
    });
    expect(current.status).toBe('current');
    expect(current.ageSeconds).toBe(300);
    expect(current.policy?.staleAfterSeconds).toBe(3600);

    const atAgingBound = await evaluateObservationFreshness(ctx, {
      observationId: observation.id,
      asOf: T0_PLUS(600),
    });
    expect(atAgingBound.status).toBe('current'); // inclusive bound

    const aging = await evaluateObservationFreshness(ctx, {
      observationId: observation.id,
      asOf: T0_PLUS(601),
    });
    expect(aging.status).toBe('aging');

    const atStaleBound = await evaluateObservationFreshness(ctx, {
      observationId: observation.id,
      asOf: T0_PLUS(3600),
    });
    expect(atStaleBound.status).toBe('aging'); // stale-after is strict

    const stale = await evaluateObservationFreshness(ctx, {
      observationId: observation.id,
      asOf: T0_PLUS(3601),
    });
    expect(stale.status).toBe('stale');
    expect(stale.evaluatedAt).toBe(T0_PLUS(3601));
  });

  it('reports unknown when no policy applies (and still derives latency and age)', async () => {
    const ctx = member(tenantEval);
    const observation = await recordObservation(ctx, {
      ...observationInput(T0),
      kind: 'document.note', // no policy for this kind exists in this tenant
    });
    const evaluated = await evaluateObservationFreshness(ctx, {
      observationId: observation.id,
      asOf: T0_PLUS(120),
    });
    expect(evaluated.status).toBe('unknown');
    expect(evaluated.policy).toBeNull();
    expect(evaluated.ageSeconds).toBe(120);
    expect(evaluated.latencySeconds).toBeGreaterThan(0); // recorded after observed
    expect(evaluated.latencyExceeded).toBe(false);
    expect(evaluated.observedAt).toBe(T0);
    expect(evaluated.kind).toBe('document.note');
  });

  it('prefers the source-specific policy over the observation-kind default', async () => {
    const ctx = member(tenantEval);
    const subjectId = newId();
    await setFreshnessPolicy(ctx, { subjectKind: 'metric.sample', staleAfterSeconds: 3600 });
    await setFreshnessPolicy(ctx, {
      subjectKind: 'source',
      subjectId,
      staleAfterSeconds: 60,
    });

    const fromSource = await recordObservation(ctx, {
      ...observationInput(T0),
      source: { kind: 'source', id: subjectId, label: 'billing system' },
    });
    const withoutSource = await recordObservation(ctx, {
      ...observationInput(T0),
      // same kind, but person-labeled evidence: no source policy can apply,
      // so the metric.sample kind default (3600s) governs
    });

    const viaSource = await evaluateObservationFreshness(ctx, {
      observationId: fromSource.id,
      asOf: T0_PLUS(120),
    });
    expect(viaSource.status).toBe('stale'); // the tight source policy wins
    expect(viaSource.policy?.subjectId).toBe(subjectId);

    const viaKind = await evaluateObservationFreshness(ctx, {
      observationId: withoutSource.id,
      asOf: T0_PLUS(120),
    });
    expect(viaKind.status).toBe('current'); // falls back to the kind default
    expect(viaKind.policy?.subjectKind).toBe('metric.sample');
  });

  it('flags latency against the policy max-latency alarm (and its boundaries)', async () => {
    const ctx = member(tenantLatency);
    await setFreshnessPolicy(ctx, {
      subjectKind: 'telemetry.ping',
      staleAfterSeconds: 86400,
      maxLatencySeconds: 60,
    });

    const slow = await recordObservation(ctx, {
      ...observationInput(new Date(Date.now() - 90_000).toISOString()),
      kind: 'telemetry.ping',
    });
    const slowResult = await evaluateObservationFreshness(ctx, { observationId: slow.id });
    expect(slowResult.latencySeconds).toBeGreaterThanOrEqual(89); // ~90s of ingestion latency
    expect(slowResult.latencySeconds).toBeLessThan(120);
    expect(slowResult.latencyExceeded).toBe(true); // > 60s max latency

    const fast = await recordObservation(ctx, {
      ...observationInput(new Date(Date.now() - 30_000).toISOString()),
      kind: 'telemetry.ping',
    });
    const fastResult = await evaluateObservationFreshness(ctx, { observationId: fast.id });
    expect(fastResult.latencySeconds).toBeGreaterThanOrEqual(29);
    expect(fastResult.latencySeconds).toBeLessThan(60);
    expect(fastResult.latencyExceeded).toBe(false);
    expect(fastResult.status).toBe('current'); // fresh evidence, generous stale-after
  });

  it('propagates the observations contract errors (tenant-scoped, permission-honoring)', async () => {
    const ctx = member(tenantEval);
    const foreign = await recordObservation(member(tenantB), observationInput(T0));
    await expect(
      evaluateObservationFreshness(ctx, { observationId: foreign.id }),
    ).rejects.toMatchObject({ code: 'observation_not_found' });
    await expect(
      evaluateObservationFreshness(ctx, { observationId: 'not-a-uuid' } as never),
    ).rejects.toMatchObject({ code: 'invalid_query' });

    const owner = newId();
    const restricted = await recordObservation(memberAs(tenantEval, owner), {
      ...observationInput(T0),
      permissions: { visibility: 'principal', principalId: owner },
    });
    await expect(
      evaluateObservationFreshness(member(tenantEval), { observationId: restricted.id }),
    ).rejects.toBeInstanceOf(ObservationsError);
    const asOwner = await evaluateObservationFreshness(memberAs(tenantEval, owner), {
      observationId: restricted.id,
    });
    expect(asOwner.observationId).toBe(restricted.id);
  });
});

describe('source freshness (evaluateSourceFreshness)', () => {
  it('ages a source by its newest OBSERVED evidence, not the newest commit', async () => {
    const ctx = member(tenantSource);
    const sourceId = newId();
    await setFreshnessPolicy(ctx, {
      subjectKind: 'source',
      subjectId: sourceId,
      staleAfterSeconds: 7200,
      agingAfterSeconds: 1800,
    });

    // the NEWER evidence is committed FIRST — the older evidence is the
    // latest commit. Source freshness must follow observedAt.
    const newer = await recordObservation(ctx, {
      ...observationInput(T0_PLUS(7200)),
      source: { kind: 'source', id: sourceId },
    });
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct commit times
    const older = await recordObservation(ctx, {
      ...observationInput(T0_PLUS(3600)),
      source: { kind: 'source', id: sourceId },
    });
    // a different source must not count
    await recordObservation(ctx, {
      ...observationInput(T0_PLUS(9999)),
      source: { kind: 'source', id: newId() },
    });
    // and neither must person-labeled evidence
    await recordObservation(ctx, observationInput(T0_PLUS(9999)));

    const evaluated = await evaluateSourceFreshness(ctx, {
      sourceKind: 'source',
      sourceId,
      asOf: T0_PLUS(9000),
    });
    expect(evaluated.latestObservationId).toBe(newer.id);
    expect(evaluated.latestObservedAt).toBe(T0_PLUS(7200));
    expect(evaluated.latestRecordedAt).toBe(newer.recordedAt); // from the newest-observed sample
    expect(Date.parse(older.recordedAt)).toBeGreaterThan(Date.parse(newer.recordedAt));
    expect(evaluated.observationsConsidered).toBe(2);
    expect(evaluated.ageSeconds).toBe(1800);
    expect(evaluated.status).toBe('current'); // 1800 <= agingAfter bound

    const aging = await evaluateSourceFreshness(ctx, {
      sourceKind: 'source',
      sourceId,
      asOf: T0_PLUS(7200 + 1801),
    });
    expect(aging.status).toBe('aging');

    const atStaleBound = await evaluateSourceFreshness(ctx, {
      sourceKind: 'source',
      sourceId,
      asOf: T0_PLUS(7200 + 7200),
    });
    expect(atStaleBound.status).toBe('aging'); // strict stale-after

    const stale = await evaluateSourceFreshness(ctx, {
      sourceKind: 'source',
      sourceId,
      asOf: T0_PLUS(7200 + 7201),
    });
    expect(stale.status).toBe('stale');
    expect(stale.policy?.subjectId).toBe(sourceId);
  });

  it('aggregates observation latency across the source window', async () => {
    const ctx = member(tenantSourceLatency);
    const sourceId = newId();
    const fresh = await recordObservation(ctx, {
      ...observationInput(new Date(Date.now() - 30_000).toISOString()),
      source: { kind: 'source', id: sourceId },
    });
    await recordObservation(ctx, {
      ...observationInput(new Date(Date.now() - 60_000).toISOString()),
      source: { kind: 'source', id: sourceId },
    });

    const evaluated = await evaluateSourceFreshness(ctx, {
      sourceKind: 'source',
      sourceId,
    });
    expect(evaluated.observationsConsidered).toBe(2);
    expect(evaluated.latestObservedAt).toBe(fresh.observedAt);
    expect(evaluated.maxObservedLatencySeconds).toBeGreaterThanOrEqual(59); // ~60s
    expect(evaluated.maxObservedLatencySeconds).toBeLessThan(120);
    expect(evaluated.avgObservedLatencySeconds).toBeGreaterThanOrEqual(44); // ~45s
    expect(evaluated.avgObservedLatencySeconds).toBeLessThan(120);
    expect(evaluated.status).toBe('unknown'); // latency tracking works without a policy too
  });

  it('falls back to the source kind default policy', async () => {
    const ctx = member(tenantSource);
    const sourceId = newId();
    await setFreshnessPolicy(ctx, { subjectKind: 'source', staleAfterSeconds: 3600 });
    await recordObservation(ctx, {
      ...observationInput(T0),
      source: { kind: 'source', id: sourceId },
    });
    const evaluated = await evaluateSourceFreshness(ctx, {
      sourceKind: 'source',
      sourceId,
      asOf: T0_PLUS(1800),
    });
    expect(evaluated.status).toBe('current');
    expect(evaluated.policy?.subjectId).toBeNull(); // the kind default
  });

  it('reports unknown for a source with no evidence and for an unpolicied source', async () => {
    const ctx = member(tenantSource);
    // never delivered anything
    const silent = await evaluateSourceFreshness(ctx, {
      sourceKind: 'source',
      sourceId: newId(),
      asOf: T0_PLUS(100),
    });
    expect(silent.latestObservationId).toBeNull();
    expect(silent.latestObservedAt).toBeNull();
    expect(silent.ageSeconds).toBeNull();
    expect(silent.observationsConsidered).toBe(0);
    expect(silent.maxObservedLatencySeconds).toBeNull();
    expect(silent.avgObservedLatencySeconds).toBeNull();
    expect(silent.status).toBe('unknown');

    // delivered evidence but no policy at all for it (tenantState has no
    // 'source' policies — only world.relationship ones)
    const unpoliciedSource = newId();
    await recordObservation(member(tenantState), {
      ...observationInput(T0),
      source: { kind: 'source', id: unpoliciedSource },
    });
    const unpolicied = await evaluateSourceFreshness(member(tenantState), {
      sourceKind: 'source',
      sourceId: unpoliciedSource,
      asOf: T0_PLUS(100),
    });
    expect(unpolicied.observationsConsidered).toBe(1);
    expect(unpolicied.latestObservationId).not.toBeNull();
    expect(unpolicied.policy).toBeNull();
    expect(unpolicied.status).toBe('unknown'); // evidence exists, nothing to classify against
  });

  it('never sees another tenant\'s source feed (no leak)', async () => {
    const sourceId = newId();
    await recordObservation(member(tenantSource), {
      ...observationInput(T0),
      source: { kind: 'source', id: sourceId },
    });
    const asForeign = await evaluateSourceFreshness(member(tenantB), {
      sourceKind: 'source',
      sourceId,
      asOf: T0_PLUS(100),
    });
    expect(asForeign.observationsConsidered).toBe(0);
    expect(asForeign.latestObservationId).toBeNull();
    expect(asForeign.status).toBe('unknown');
  });
});

describe('temporal-state freshness (evaluateTemporalStateFreshness)', () => {
  const kind = 'world.relationship';

  it('ages the current understanding by its newest readable supporting evidence', async () => {
    const ctx = member(tenantState);
    const subjectId = newId();
    await setFreshnessPolicy(ctx, {
      subjectKind: kind,
      subjectId,
      staleAfterSeconds: 7200,
      agingAfterSeconds: 3600,
    });

    const early = await seedObservation(ctx, T0);
    const middle = await seedObservation(ctx, T0_PLUS(1800));
    const late = await seedObservation(ctx, T0_PLUS(2700));

    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId,
      state: { strength: 'strong' },
      validFrom: T0,
      observationIds: [early.id],
    });
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId,
      state: { strength: 'weakening' },
      validFrom: T0_PLUS(3600),
      observationIds: [middle.id, late.id], // newest evidence is `late` (T0+45m)
    });

    const evaluated = await evaluateTemporalStateFreshness(ctx, {
      subjectKind: kind,
      subjectId,
      asOf: T0_PLUS(5400), // 45m after the newest supporting evidence
    });
    expect(evaluated.revision.version).toBe(2);
    expect(evaluated.revision.state).toEqual({ strength: 'weakening' });
    expect(evaluated.evidenceObservedAt).toBe(T0_PLUS(2700));
    expect(evaluated.supportingObservations).toBe(2);
    expect(evaluated.recordedObservations).toBe(2);
    expect(evaluated.ageSeconds).toBe(2700);
    expect(evaluated.status).toBe('current'); // 2700 <= aging bound 3600

    const aging = await evaluateTemporalStateFreshness(ctx, {
      subjectKind: kind,
      subjectId,
      asOf: T0_PLUS(2700 + 3601),
    });
    expect(aging.status).toBe('aging');

    const stale = await evaluateTemporalStateFreshness(ctx, {
      subjectKind: kind,
      subjectId,
      asOf: T0_PLUS(2700 + 7201),
    });
    expect(stale.status).toBe('stale');
    expect(stale.policy?.subjectId).toBe(subjectId);
  });

  it('evaluates the version valid at asOf (older evidence when asOf is older)', async () => {
    const ctx = member(tenantState);
    const subjectId = newId();
    await setFreshnessPolicy(ctx, { subjectKind: kind, staleAfterSeconds: 86_400 });

    const early = await seedObservation(ctx, T0);
    const late = await seedObservation(ctx, T0_PLUS(3600));
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId,
      state: { phase: 'one' },
      validFrom: T0,
      observationIds: [early.id],
    });
    await recordTemporalRevision(ctx, {
      subjectKind: kind,
      subjectId,
      state: { phase: 'two' },
      validFrom: T0_PLUS(7200),
      observationIds: [late.id],
    });

    const atMid = await evaluateTemporalStateFreshness(ctx, {
      subjectKind: kind,
      subjectId,
      asOf: T0_PLUS(3600), // between the versions → v1 with ITS evidence
    });
    expect(atMid.revision.version).toBe(1);
    expect(atMid.evidenceObservedAt).toBe(T0);
    expect(atMid.ageSeconds).toBe(3600);

    await expect(
      evaluateTemporalStateFreshness(ctx, {
        subjectKind: kind,
        subjectId,
        asOf: T0_PLUS(-1),
      }),
    ).rejects.toMatchObject({ code: 'temporal_state_not_found' });
  });

  it('skips unreadable provenance (partial view) and reports unknown without readable evidence', async () => {
    const ctx = member(tenantState);
    const subjectId = newId();
    await setFreshnessPolicy(ctx, { subjectKind: kind, staleAfterSeconds: 86_400 });

    const owner = newId();
    const restricted = await recordObservation(memberAs(tenantState, owner), {
      ...observationInput(T0),
      permissions: { visibility: 'principal', principalId: owner },
    });
    await recordTemporalRevision(memberAs(tenantState, owner), {
      subjectKind: kind,
      subjectId,
      state: { phase: 'private' },
      validFrom: T0,
      observationIds: [restricted.id],
    });

    const asOwner = await evaluateTemporalStateFreshness(memberAs(tenantState, owner), {
      subjectKind: kind,
      subjectId,
      asOf: T0_PLUS(60),
    });
    expect(asOwner.supportingObservations).toBe(1);
    expect(asOwner.recordedObservations).toBe(1);
    expect(asOwner.evidenceObservedAt).toBe(T0);
    expect(asOwner.status).toBe('current');

    // another member sees the revision but not the restricted evidence:
    // a partial view — never a leak, never a failure
    const asOther = await evaluateTemporalStateFreshness(member(tenantState), {
      subjectKind: kind,
      subjectId,
      asOf: T0_PLUS(60),
    });
    expect(asOther.revision.version).toBe(1); // the revision itself is tenant-visible
    expect(asOther.supportingObservations).toBe(0);
    expect(asOther.recordedObservations).toBe(1);
    expect(asOther.evidenceObservedAt).toBeNull();
    expect(asOther.ageSeconds).toBeNull();
    expect(asOther.status).toBe('unknown');
  });
});

describe('tenant isolation (ADR-0001)', () => {
  const kind = 'world.relationship';

  it('hides temporal state across tenants with a uniform not-found', async () => {
    const subjectId = newId();
    const evidence = await seedObservation(member(tenantA), T0);
    await recordTemporalRevision(member(tenantA), {
      subjectKind: kind,
      subjectId,
      state: { secret: 'A' },
      validFrom: T0,
      observationIds: [evidence.id],
    });
    await expect(
      getTemporalState(member(tenantB), { subjectKind: kind, subjectId, asOf: T0 }),
    ).rejects.toMatchObject({ code: 'temporal_state_not_found' });
    await expect(
      evaluateTemporalStateFreshness(member(tenantB), {
        subjectKind: kind,
        subjectId,
        asOf: T0,
      }),
    ).rejects.toMatchObject({ code: 'temporal_state_not_found' });
    // a malformed id is indistinguishable from a missing one
    await expect(
      getTemporalState(member(tenantA), { subjectKind: kind, subjectId: 'nope' } as never),
    ).rejects.toMatchObject({ code: 'invalid_query' });
    // history of a foreign subject is simply empty — no leak
    expect(
      await listTemporalHistory(member(tenantB), { subjectKind: kind, subjectId }),
    ).toEqual([]);
  });

  it('keeps independent revision chains for the same subject key per tenant', async () => {
    const subjectId = newId();
    const evidenceA = await seedObservation(member(tenantA), T0);
    const evidenceB = await seedObservation(member(tenantB), T0);

    await recordTemporalRevision(member(tenantA), {
      subjectKind: kind,
      subjectId,
      state: { chain: 'A-v1' },
      validFrom: T0,
      observationIds: [evidenceA.id],
    });
    await recordTemporalRevision(member(tenantA), {
      subjectKind: kind,
      subjectId,
      state: { chain: 'A-v2' },
      validFrom: T0_PLUS(3600),
      observationIds: [evidenceA.id],
    });
    await recordTemporalRevision(member(tenantB), {
      subjectKind: kind,
      subjectId,
      state: { chain: 'B-v1' },
      validFrom: T0,
      observationIds: [evidenceB.id],
    });

    const historyA = await listTemporalHistory(member(tenantA), { subjectKind: kind, subjectId });
    const historyB = await listTemporalHistory(member(tenantB), { subjectKind: kind, subjectId });
    expect(historyA.map((revision) => revision.state)).toEqual([
      { chain: 'A-v1' },
      { chain: 'A-v2' },
    ]);
    expect(historyB.map((revision) => revision.state)).toEqual([{ chain: 'B-v1' }]);
  });

  it('scopes policies per tenant (same key, independent values)', async () => {
    const subjectId = newId();
    await setFreshnessPolicy(member(tenantA), {
      subjectKind: 'source',
      subjectId,
      staleAfterSeconds: 60,
    });
    await setFreshnessPolicy(member(tenantB), {
      subjectKind: 'source',
      subjectId,
      staleAfterSeconds: 86_400,
    });

    const inA = await getFreshnessPolicy(member(tenantA), {
      subjectKind: 'source',
      subjectId,
    });
    const inB = await getFreshnessPolicy(member(tenantB), {
      subjectKind: 'source',
      subjectId,
    });
    expect(inA.tenantId).toBe(tenantA);
    expect(inA.staleAfterSeconds).toBe(60);
    expect(inB.tenantId).toBe(tenantB);
    expect(inB.staleAfterSeconds).toBe(86_400);
    expect(inA.id).not.toBe(inB.id);

    // a third tenant resolves neither A's nor B's specific policy: it can
    // only ever see its OWN policies (tenantPolicy's 'source' default is
    // 7200s — never 60s or 86400s)
    const third = await resolveFreshnessPolicy(member(tenantPolicy), {
      subjectKind: 'source',
      subjectId,
    });
    expect(third?.tenantId).toBe(tenantPolicy);
    expect(third?.staleAfterSeconds).toBe(7200);
    // and for a kind with no policy at all in that tenant: null
    expect(
      await resolveFreshnessPolicy(member(tenantPolicy), {
        subjectKind: 'world.relationship',
        subjectId,
      }),
    ).toBeNull();
  });
});

describe('error type', () => {
  it('carries the module error name and code', () => {
    const error = new FreshnessError('temporal_state_not_found', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FreshnessError');
    expect(error.code).toBe('temporal_state_not_found');
  });
});
