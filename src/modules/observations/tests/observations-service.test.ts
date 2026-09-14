// Integration tests for the observations module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W004
// acceptance:
//
//  * recording immutable observations with source, channel, timestamps,
//    extraction lineage, permissions and confidence;
//  * the observation CANNOT be mutated into authoritative truth:
//      - the contract exposes no mutation/promotion operation,
//      - PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE (triggers),
//      - caller-supplied identity/tenancy/commit-time fields are rejected,
//      - corrections/contradictions are new observations and both sides are
//        retained (lock 12),
//      - LLM-extracted evidence stays evidence with lineage and confidence
//        (lock 10);
//  * tenant isolation (ADR-0001), including lineage parents;
//  * recorded permissions are honored on every read path (principal scope)
//    and derivation cannot build on restricted evidence.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as observationsContract from '../contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ObservationsError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const { getObservation, getObservationLineage, listObservations, recordObservation } =
  observationsContract;

const tenantA = newId();
const tenantB = newId();
const tenantList = newId(); // dedicated tenants so filter/ordering tests see
const tenantOrder = newId(); // only the data they create themselves

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

function baseInput(): Parameters<typeof recordObservation>[1] {
  return {
    kind: 'channel.message',
    payload: { text: 'the printer on floor 3 is broken' },
    observedAt: '2026-09-14T09:15:00Z',
    source: { kind: 'person', label: 'office-manager' },
    channel: 'whatsapp',
    confidence: { value: 0.9, method: 'source_trust', basis: 'first-hand report' },
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('recording observations (W004: provenance-bearing evidence)', () => {
  it('persists and returns every recorded attribute unchanged', async () => {
    const ctx = member(tenantA);
    const recorded = await recordObservation(ctx, {
      kind: 'metric.sample',
      payload: { metric: 'dso', value: 41.5, unit: 'day' },
      observedAt: '2026-09-14T08:00:00+02:00',
      source: { kind: 'source', id: newId(), label: 'billing system' },
      channel: 'ingestion',
      lineage: { method: 'connector' },
      permissions: { visibility: 'workspace', workspaceId: newId(), usage: ['no-export'] },
      confidence: { value: 0.97, method: 'source_trust', basis: 'system of record export' },
    });

    expect(recorded.tenantId).toBe(tenantA);
    expect(recorded.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded.kind).toBe('metric.sample');
    expect(recorded.payload).toEqual({ metric: 'dso', value: 41.5, unit: 'day' });
    expect(recorded.observedAt).toBe('2026-09-14T06:00:00.000Z'); // normalized to UTC
    expect(recorded.source).toEqual({ kind: 'source', id: expect.any(String), label: 'billing system' });
    expect(recorded.channel).toBe('ingestion');
    expect(recorded.lineage).toEqual({ method: 'connector', parents: [], extractor: null });
    expect(recorded.permissions).toEqual({
      visibility: 'workspace',
      workspaceId: expect.any(String),
      principalId: null,
      usage: ['no-export'],
    });
    expect(recorded.confidence).toEqual({ value: 0.97, method: 'source_trust', basis: 'system of record export' });
    expect(recorded.recordedAt).toBeTruthy();

    const read = await getObservation(ctx, recorded.id);
    expect(read).toEqual(recorded);
  });

  it('sets recordedAt itself — the caller cannot supply identity, tenancy or commit time', async () => {
    const ctx = member(tenantA);
    const before = new Date();
    const recorded = await recordObservation(ctx, baseInput());
    const after = new Date();
    expect(Date.parse(recorded.recordedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(recorded.recordedAt)).toBeLessThanOrEqual(after.getTime());

    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'authoritative']) {
      await expect(
        recordObservation(ctx, { ...baseInput(), [smuggled]: newId() } as never),
      ).rejects.toMatchObject({ code: 'invalid_observation_input' });
    }
  });

  it('rejects invalid inputs and malformed contexts', async () => {
    const ctx = member(tenantA);
    await expect(recordObservation(ctx, { ...baseInput(), payload: null })).rejects.toMatchObject({
      code: 'invalid_observation_input',
    });
    await expect(recordObservation(ctx, { ...baseInput(), channel: 'WhatsApp' })).rejects.toMatchObject({
      code: 'invalid_observation_input',
    });
    await expect(recordObservation(ctx, { ...baseInput(), observedAt: '2026-09-14' })).rejects.toMatchObject({
      code: 'invalid_observation_input',
    });
    await expect(
      recordObservation(ctx, { ...baseInput(), confidence: { value: 1.5, method: 'x_method' } }),
    ).rejects.toMatchObject({ code: 'invalid_observation_input' });
    await expect(
      recordObservation({ tenantId: '', principalId: newId(), authority: [] }, baseInput()),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });

  it('records the observation latency ingredients (observedAt vs recordedAt)', async () => {
    const ctx = member(tenantA);
    const recorded = await recordObservation(ctx, {
      ...baseInput(),
      observedAt: '2026-09-14T06:00:00Z',
    });
    // W006 (freshness) derives latency from these two; both must be present
    // and distinct where the source clock lags.
    expect(Date.parse(recorded.recordedAt)).toBeGreaterThan(Date.parse(recorded.observedAt));
  });
});

describe('immutability: an observation cannot be mutated into authoritative truth', () => {
  it('exposes no mutation or promotion operation on the contract surface', async () => {
    // The ONLY public surface of the module is contract.ts; its export set is
    // pinned here: record + read + list + lineage + errors/types/vocabularies.
    // There is deliberately no updateObservation, no deleteObservation, no
    // correctObservation, no promoteToBelief, no verify/authoritative flag.
    expect(Object.keys(observationsContract).sort()).toEqual([
      'DEFAULT_LIST_LIMIT',
      'DERIVING_LINEAGE_METHODS',
      'LINEAGE_METHODS',
      'MAX_LINEAGE_PARENTS',
      'MAX_LIST_LIMIT',
      'MAX_USAGE_TAGS',
      'OBSERVATION_SOURCE_KINDS',
      'OBSERVATION_VISIBILITIES',
      'ObservationsError',
      'getObservation',
      'getObservationLineage',
      'isLineageMethod',
      'isObservationSourceKind',
      'isObservationVisibility',
      'listObservations',
      'recordObservation',
    ]);
  });

  it('carries no authoritative/truth field on the record shape', async () => {
    const ctx = member(tenantA);
    const recorded = await recordObservation(ctx, baseInput());
    expect(Object.keys(recorded).sort()).toEqual([
      'channel',
      'confidence',
      'id',
      'kind',
      'lineage',
      'observedAt',
      'payload',
      'permissions',
      'recordedAt',
      'source',
      'tenantId',
    ]);
  });

  it('rejects UPDATE and DELETE on observations at the storage layer (lock 5)', async () => {
    const ctx = member(tenantA);
    const recorded = await recordObservation(ctx, {
      ...baseInput(),
      payload: { text: 'original evidence' },
    });

    await expect(
      getDb().query(`UPDATE observations SET payload = '{"text":"tampered"}'::jsonb WHERE id = $1`, [
        recorded.id,
      ]),
    ).rejects.toThrow(/immutable/i);

    await expect(
      getDb().query(`UPDATE observations SET confidence_value = 1 WHERE id = $1`, [recorded.id]),
    ).rejects.toThrow(/immutable/i);

    await expect(getDb().query(`DELETE FROM observations WHERE id = $1`, [recorded.id])).rejects.toThrow(
      /immutable/i,
    );

    // TRUNCATE is blocked twice over: the immutability trigger AND the
    // foreign key from observation_lineage (truncating a referenced table
    // requires CASCADE). Either way, evidence cannot be bulk-erased.
    await expect(getDb().query(`TRUNCATE observations`)).rejects.toThrow(
      /immutable|cannot truncate/i,
    );

    // the evidence survived all four attempts untouched
    const after = await getObservation(ctx, recorded.id);
    expect(after.payload).toEqual({ text: 'original evidence' });
    expect(after.confidence.value).toBe(0.9);
  });

  it('rejects UPDATE, DELETE and TRUNCATE on the lineage edges as well', async () => {
    const ctx = member(tenantA);
    const parent = await recordObservation(ctx, baseInput());
    const child = await recordObservation(ctx, {
      ...baseInput(),
      kind: 'document.note',
      payload: { note: 'extracted fact' },
      lineage: { method: 'extraction', parents: [parent.id] },
    });

    await expect(
      getDb().query(`UPDATE observation_lineage SET parent_observation_id = $1`, [child.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(getDb().query(`DELETE FROM observation_lineage`)).rejects.toThrow(/immutable/i);
    await expect(getDb().query(`TRUNCATE observation_lineage`)).rejects.toThrow(/immutable/i);

    const lineage = await getObservationLineage(ctx, child.id);
    expect(lineage.edges).toEqual([
      { observationId: child.id, parentObservationId: parent.id },
    ]);
  });

  it('retains contradictory evidence instead of merging or overwriting (lock 12)', async () => {
    const ctx = member(tenantA);
    const first = await recordObservation(ctx, {
      ...baseInput(),
      payload: { text: 'the printer on floor 3 is broken' },
      confidence: { value: 0.9, method: 'source_trust' },
    });
    const contradiction = await recordObservation(ctx, {
      ...baseInput(),
      payload: { text: 'the printer on floor 3 was fixed this morning' },
      observedAt: '2026-09-14T10:00:00Z',
      confidence: { value: 0.4, method: 'source_trust' },
    });

    const readFirst = await getObservation(ctx, first.id);
    const readSecond = await getObservation(ctx, contradiction.id);
    expect(readFirst.payload).toEqual({ text: 'the printer on floor 3 is broken' });
    expect(readSecond.payload).toEqual({ text: 'the printer on floor 3 was fixed this morning' });
    expect(readFirst.confidence.value).toBe(0.9);
    expect(readSecond.confidence.value).toBe(0.4);
  });

  it('keeps LLM-extracted observations as evidence with lineage, never authoritative (lock 10)', async () => {
    const ctx = member(tenantA);
    const raw = await recordObservation(ctx, {
      ...baseInput(),
      kind: 'channel.message',
      payload: { text: 'we lost the Northwind renewal, they chose the competitor' },
    });
    const extracted = await recordObservation(ctx, {
      kind: 'document.note',
      payload: { fact: 'Northwind account churned', reason: 'competitor selected' },
      observedAt: '2026-09-14T09:15:30Z',
      source: { kind: 'system', label: 'aurum-cognition' },
      channel: 'internal',
      lineage: {
        method: 'inference',
        parents: [raw.id],
        extractor: { provider: 'llm-a', model: 'reasoning-model-1', notes: 'structured extraction' },
      },
      confidence: { value: 0.72, method: 'extraction_model', basis: 'single message, no confirmation' },
    });

    // It stays a plain observation: same record shape, no truth flag,
    // confidence explicitly below 1 and the extractor recorded for audit.
    expect(extracted.lineage.method).toBe('inference');
    expect(extracted.lineage.parents).toEqual([raw.id]);
    expect(extracted.lineage.extractor).toEqual({
      provider: 'llm-a',
      model: 'reasoning-model-1',
      notes: 'structured extraction',
    });
    expect(extracted.confidence.value).toBe(0.72);

    const read = await getObservation(ctx, extracted.id);
    expect(read).toEqual(extracted);
    // and the raw evidence it was derived from remains intact
    const rawAfter = await getObservation(ctx, raw.id);
    expect(rawAfter.payload).toEqual({
      text: 'we lost the Northwind renewal, they chose the competitor',
    });
  });
});

describe('extraction lineage', () => {
  it('records and walks transitive lineage chains', async () => {
    const ctx = member(tenantA);
    const level0 = await recordObservation(ctx, {
      ...baseInput(),
      payload: { text: 'raw signal' },
    });
    const level1 = await recordObservation(ctx, {
      ...baseInput(),
      kind: 'document.note',
      payload: { note: 'normalized fact' },
      lineage: { method: 'extraction', parents: [level0.id] },
    });
    const level2 = await recordObservation(ctx, {
      ...baseInput(),
      kind: 'document.note',
      payload: { note: 'derived insight' },
      lineage: { method: 'transformation', parents: [level1.id] },
    });

    const lineage = await getObservationLineage(ctx, level2.id);
    expect(lineage.observation.id).toBe(level2.id);
    expect(new Set(lineage.edges)).toEqual(
      new Set([
        { observationId: level2.id, parentObservationId: level1.id },
        { observationId: level1.id, parentObservationId: level0.id },
      ]),
    );
    expect(lineage.ancestors.map((o) => o.id).sort()).toEqual([level0.id, level1.id].sort());
    // each ancestor carries its own parents, so the chain is navigable
    const ancestor1 = lineage.ancestors.find((o) => o.id === level1.id);
    expect(ancestor1?.lineage.parents).toEqual([level0.id]);

    // a direct observation has an empty lineage
    expect(await getObservationLineage(ctx, level0.id)).toEqual({
      observation: await getObservation(ctx, level0.id),
      edges: [],
      ancestors: [],
    });
  });

  it('supports multi-parent derivation (merge of evidence)', async () => {
    const ctx = member(tenantA);
    const left = await recordObservation(ctx, { ...baseInput(), payload: { left: 1 } });
    const right = await recordObservation(ctx, {
      ...baseInput(),
      payload: { right: 1 },
      observedAt: '2026-09-14T10:00:00Z',
    });
    const merged = await recordObservation(ctx, {
      ...baseInput(),
      kind: 'document.note',
      payload: { merged: true },
      lineage: { method: 'transformation', parents: [left.id, right.id] },
    });

    const read = await getObservation(ctx, merged.id);
    expect(read.lineage.parents).toEqual([left.id, right.id]);

    const lineage = await getObservationLineage(ctx, merged.id);
    expect(lineage.ancestors.map((o) => o.id).sort()).toEqual([left.id, right.id].sort());
  });

  it('rejects structurally invalid lineage at record time', async () => {
    const ctx = member(tenantA);
    const parent = await recordObservation(ctx, baseInput());

    await expect(
      recordObservation(ctx, { ...baseInput(), lineage: { method: 'direct', parents: [parent.id] } }),
    ).rejects.toMatchObject({ code: 'invalid_lineage' });
    await expect(
      recordObservation(ctx, { ...baseInput(), lineage: { method: 'extraction', parents: [] } }),
    ).rejects.toMatchObject({ code: 'invalid_lineage' });
    await expect(
      recordObservation(ctx, {
        ...baseInput(),
        lineage: { method: 'extraction', parents: [parent.id, parent.id] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_lineage' });
    await expect(
      recordObservation(ctx, { ...baseInput(), lineage: { method: 'extraction', parents: ['nope'] } }),
    ).rejects.toMatchObject({ code: 'invalid_lineage' });
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('hides observations across tenants with a uniform not-found', async () => {
    const inA = await recordObservation(member(tenantA), { ...baseInput(), payload: { secret: 'A' } });
    await expect(getObservation(member(tenantB), inA.id)).rejects.toMatchObject({
      code: 'observation_not_found',
    });
    // a malformed id is indistinguishable from a missing one
    await expect(getObservation(member(tenantA), 'not-a-uuid')).rejects.toMatchObject({
      code: 'observation_not_found',
    });
    // lineage of another tenant's observation is equally invisible
    await expect(getObservationLineage(member(tenantB), inA.id)).rejects.toMatchObject({
      code: 'observation_not_found',
    });
  });

  it('never lists one tenant\'s evidence in another tenant\'s feed', async () => {
    await recordObservation(member(tenantA), { ...baseInput(), payload: { text: 'A-only' } });
    const bFeed = await listObservations(member(tenantB), {});
    expect(bFeed.map((o) => o.tenantId)).not.toContain(tenantA);
    const aFeed = await listObservations(member(tenantA), {});
    expect(aFeed.length).toBeGreaterThan(0);
  });

  it('rejects cross-tenant lineage parents without leaking their existence', async () => {
    const foreign = await recordObservation(member(tenantB), baseInput());
    await expect(
      recordObservation(member(tenantA), {
        ...baseInput(),
        lineage: { method: 'extraction', parents: [foreign.id] },
      }),
    ).rejects.toMatchObject({ code: 'observation_not_found' });
  });
});

describe('recorded permissions are honored on read paths', () => {
  it('restricts principal-scoped evidence to its principal', async () => {
    const owner = newId();
    const recorded = await recordObservation(memberAs(tenantA, owner), {
      ...baseInput(),
      payload: { text: 'salary band feedback' },
      permissions: { visibility: 'principal', principalId: owner },
    });

    expect((await getObservation(memberAs(tenantA, owner), recorded.id)).id).toBe(recorded.id);
    await expect(getObservation(member(tenantA), recorded.id)).rejects.toMatchObject({
      code: 'observation_forbidden',
    });
    // another tenant sees the uniform not-found (no existence leak)
    await expect(getObservation(member(tenantB), recorded.id)).rejects.toMatchObject({
      code: 'observation_not_found',
    });
  });

  it('keeps principal-scoped evidence out of other principals\' lists', async () => {
    const owner = newId();
    const scoped = await recordObservation(memberAs(tenantA, owner), {
      ...baseInput(),
      payload: { text: 'confidential' },
      permissions: { visibility: 'principal', principalId: owner },
    });

    const asOwner = await listObservations(memberAs(tenantA, owner), {});
    expect(asOwner.map((o) => o.id)).toContain(scoped.id);
    const asOther = await listObservations(member(tenantA), {});
    expect(asOther.map((o) => o.id)).not.toContain(scoped.id);
  });

  it('forbids deriving new evidence from unreadable parents', async () => {
    const owner = newId();
    const restricted = await recordObservation(memberAs(tenantA, owner), {
      ...baseInput(),
      permissions: { visibility: 'principal', principalId: owner },
    });

    await expect(
      recordObservation(member(tenantA), {
        ...baseInput(),
        lineage: { method: 'extraction', parents: [restricted.id] },
      }),
    ).rejects.toMatchObject({ code: 'observation_forbidden' });

    // the owner may derive from their own restricted evidence
    const derived = await recordObservation(memberAs(tenantA, owner), {
      ...baseInput(),
      kind: 'document.note',
      payload: { note: 'derived in private scope' },
      lineage: { method: 'extraction', parents: [restricted.id] },
    });
    expect(derived.lineage.parents).toEqual([restricted.id]);
  });

  it('hides unreadable ancestors in lineage views (partial, no leak)', async () => {
    const owner = newId();
    const restrictedParent = await recordObservation(memberAs(tenantA, owner), {
      ...baseInput(),
      permissions: { visibility: 'principal', principalId: owner },
    });
    // the owner derives a tenant-visible observation from restricted evidence
    const derived = await recordObservation(memberAs(tenantA, owner), {
      ...baseInput(),
      kind: 'document.note',
      payload: { note: 'aggregated, tenant-shareable' },
      permissions: { visibility: 'tenant' },
      lineage: { method: 'transformation', parents: [restrictedParent.id] },
    });

    // the owner sees the full lineage…
    const asOwner = await getObservationLineage(memberAs(tenantA, owner), derived.id);
    expect(asOwner.ancestors.map((o) => o.id)).toEqual([restrictedParent.id]);
    expect(asOwner.edges).toEqual([
      { observationId: derived.id, parentObservationId: restrictedParent.id },
    ]);

    // …while another member sees only the (readable) derived observation
    const asOther = await getObservationLineage(member(tenantA), derived.id);
    expect(asOther.ancestors).toEqual([]);
    expect(asOther.edges).toEqual([]);
    expect(asOther.observation.id).toBe(derived.id);
  });

  it('records workspace scoping for the policy layer (W009)', async () => {
    const workspaceId = newId();
    const recorded = await recordObservation(member(tenantA), {
      ...baseInput(),
      permissions: { visibility: 'workspace', workspaceId, usage: ['no-llm', 'no-export'] },
    });
    const read = await getObservation(member(tenantA), recorded.id);
    expect(read.permissions).toEqual({
      visibility: 'workspace',
      workspaceId,
      principalId: null,
      usage: ['no-export', 'no-llm'],
    });
  });
});

describe('listObservations', () => {
  it('filters by kind, channel, source and observed window', async () => {
    const ctx = member(tenantList);
    const personId = newId();
    const wanted = await recordObservation(ctx, {
      kind: 'metric.sample',
      payload: { metric: 'arr', value: 100 },
      observedAt: '2026-09-10T12:00:00Z',
      source: { kind: 'person', id: personId },
      channel: 'ingestion',
      confidence: { value: 0.9, method: 'source_trust' },
    });
    await recordObservation(ctx, {
      ...baseInput(),
      observedAt: '2026-09-20T12:00:00Z', // outside the window below
    });
    await recordObservation(ctx, {
      ...baseInput(),
      kind: 'channel.message',
      channel: 'slack',
    });

    const byKind = await listObservations(ctx, { kind: 'metric.sample' });
    expect(byKind.map((o) => o.id)).toEqual([wanted.id]);

    const bySource = await listObservations(ctx, { sourceKind: 'person', sourceId: personId });
    expect(bySource.map((o) => o.id)).toEqual([wanted.id]);

    const byWindow = await listObservations(ctx, {
      observedFrom: '2026-09-09T00:00:00Z',
      observedTo: '2026-09-11T00:00:00Z',
    });
    expect(byWindow.map((o) => o.id)).toEqual([wanted.id]);

    const byChannel = await listObservations(ctx, { channel: 'slack' });
    expect(byChannel.every((o) => o.channel === 'slack')).toBe(true);
    expect(byChannel.map((o) => o.id)).not.toContain(wanted.id);
  });

  it('orders by recordedAt descending and honors the limit', async () => {
    const ctx = member(tenantOrder); // fresh tenant for a clean feed
    for (let i = 0; i < 5; i += 1) {
      await recordObservation(ctx, {
        ...baseInput(),
        payload: { seq: i },
        observedAt: `2026-09-1${i}T00:00:00Z`,
      });
    }
    const feed = await listObservations(ctx, {});
    expect(feed).toHaveLength(5);
    for (let i = 1; i < feed.length; i += 1) {
      expect(Date.parse(feed[i]!.recordedAt)).toBeLessThanOrEqual(Date.parse(feed[i - 1]!.recordedAt));
    }
    const limited = await listObservations(ctx, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((o) => o.id)).toEqual(feed.slice(0, 2).map((o) => o.id));

    await expect(listObservations(ctx, { limit: 0 } as never)).rejects.toMatchObject({
      code: 'invalid_observation_query',
    });
  });
});

describe('error type', () => {
  it('carries the module error name and code', () => {
    const error = new ObservationsError('observation_not_found', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ObservationsError');
    expect(error.code).toBe('observation_not_found');
  });
});
