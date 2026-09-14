// Integration tests for the events module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W003 acceptance:
//
//  * the immutable VERSIONED domain event envelope with tenant, actor,
//    source, correlation and causation fields;
//  * ORDERING METADATA: per-tenant strictly increasing sequences (the
//    canonical replay order), per-tenant independence, replay direction
//    and sequence cursors;
//  * IDEMPOTENCY KEYS: same key replays the original event (first write
//    wins), consumes no sequence number, and is tenant-scoped;
//  * correlation completeness (explicit > inherited > self) and the
//    causation chain up to the root;
//  * immutability (lock 5): no mutation operation on the contract, and
//    PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on events — the
//    counters may increment but can never be removed;
//  * tenant isolation (ADR-0001), including causation references.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as eventsContract from '../contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { EventsError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const { appendEvent, getEvent, getEventCausationChain, listEvents } = eventsContract;

const tenantA = newId();
const tenantB = newId();
const tenantOrder = newId(); // dedicated tenants so ordering/idempotency/
const tenantKeys = newId();  // filter tests see only the data they create
const tenantList = newId();  // themselves
const tenantCounter = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function baseInput(): Parameters<typeof appendEvent>[1] {
  return {
    type: 'channel.message.received',
    payload: { text: 'the printer on floor 3 is broken' },
    occurredAt: '2026-09-14T09:15:00Z',
    actor: { kind: 'person', label: 'office-manager' },
    source: { kind: 'channel', label: 'whatsapp' },
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('appending events (W003: the versioned immutable envelope)', () => {
  it('persists and returns every recorded attribute unchanged', async () => {
    const ctx = member(tenantA);
    const explicitCorrelation = newId();
    const recorded = await appendEvent(ctx, {
      type: 'channel.message.received',
      typeVersion: 2,
      payload: { text: 'the printer on floor 3 is broken' },
      occurredAt: '2026-09-14T08:00:00+02:00',
      actor: { kind: 'person', id: newId(), label: 'office manager' },
      source: { kind: 'source', id: newId(), label: 'billing' },
      correlationId: explicitCorrelation,
      idempotencyKey: 'wa-msg-1042',
    });

    expect(recorded.tenantId).toBe(tenantA);
    expect(recorded.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded.envelopeVersion).toBe(eventsContract.ENVELOPE_VERSION);
    expect(recorded.type).toBe('channel.message.received');
    expect(recorded.typeVersion).toBe(2);
    expect(recorded.payload).toEqual({ text: 'the printer on floor 3 is broken' });
    expect(recorded.occurredAt).toBe('2026-09-14T06:00:00.000Z'); // normalized to UTC
    expect(recorded.actor).toEqual({ kind: 'person', id: expect.any(String), label: 'office manager' });
    expect(recorded.source).toEqual({ kind: 'source', id: expect.any(String), label: 'billing' });
    expect(recorded.correlationId).toBe(explicitCorrelation);
    expect(recorded.causationId).toBeNull();
    expect(recorded.idempotencyKey).toBe('wa-msg-1042');
    expect(recorded.sequence).toBe(1); // first event of this tenant
    expect(recorded.recordedAt).toBeTruthy();

    const read = await getEvent(ctx, recorded.id);
    expect(read).toEqual(recorded);
  });

  it('stamps recordedAt, sequence and envelopeVersion itself — the caller cannot smuggle them', async () => {
    const ctx = member(tenantA);
    const before = new Date();
    const recorded = await appendEvent(ctx, baseInput());
    const after = new Date();
    expect(Date.parse(recorded.recordedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(recorded.recordedAt)).toBeLessThanOrEqual(after.getTime());
    expect(recorded.sequence).toBeGreaterThan(0);

    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'sequence', 'envelopeVersion']) {
      await expect(
        appendEvent(ctx, { ...baseInput(), [smuggled]: newId() } as never),
      ).rejects.toMatchObject({ code: 'invalid_event_input' });
    }
  });

  it('rejects invalid inputs and malformed contexts', async () => {
    const ctx = member(tenantA);
    await expect(appendEvent(ctx, { ...baseInput(), payload: null })).rejects.toMatchObject({
      code: 'invalid_event_input',
    });
    await expect(appendEvent(ctx, { ...baseInput(), type: 'has space' })).rejects.toMatchObject({
      code: 'invalid_event_input',
    });
    await expect(appendEvent(ctx, { ...baseInput(), typeVersion: 0 })).rejects.toMatchObject({
      code: 'invalid_event_input',
    });
    await expect(appendEvent(ctx, { ...baseInput(), occurredAt: '2026-09-14' })).rejects.toMatchObject({
      code: 'invalid_event_input',
    });
    await expect(
      appendEvent(ctx, { ...baseInput(), actor: { kind: 'employee' as unknown as 'person' } }),
    ).rejects.toMatchObject({ code: 'invalid_event_input' });
    await expect(
      appendEvent(ctx, { ...baseInput(), source: { kind: 'api' } }), // no id, no label
    ).rejects.toMatchObject({ code: 'invalid_event_input' });
    await expect(
      appendEvent(ctx, { ...baseInput(), idempotencyKey: 'not a key!' }),
    ).rejects.toMatchObject({ code: 'invalid_event_input' });
    await expect(
      appendEvent({ tenantId: '', principalId: newId(), authority: [] }, baseInput()),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });

  it('keeps occurredAt (source clock) and recordedAt (commit clock) distinct when the source lags', async () => {
    const ctx = member(tenantA);
    const recorded = await appendEvent(ctx, {
      ...baseInput(),
      occurredAt: '2026-09-14T06:00:00Z',
    });
    expect(Date.parse(recorded.recordedAt)).toBeGreaterThan(Date.parse(recorded.occurredAt));
  });
});

describe('envelope versioning', () => {
  it('stamps the current envelope version on every event and refuses caller choice', async () => {
    const ctx = member(tenantA);
    for (let i = 0; i < 2; i += 1) {
      const event = await appendEvent(ctx, { ...baseInput(), payload: { i } });
      expect(event.envelopeVersion).toBe(eventsContract.ENVELOPE_VERSION);
    }
  });

  it('defaults the type version to 1 and lets payload versions coexist per type', async () => {
    const ctx = member(tenantA);
    const v1 = await appendEvent(ctx, { ...baseInput(), type: 'invoice.registered' });
    const v2 = await appendEvent(ctx, { ...baseInput(), type: 'invoice.registered', typeVersion: 2 });
    expect(v1.typeVersion).toBe(1);
    expect(v2.typeVersion).toBe(2);

    const onlyV2 = await listEvents(ctx, { type: 'invoice.registered', typeVersion: 2 });
    expect(onlyV2.map((e) => e.id)).toEqual([v2.id]);
    const onlyV1 = await listEvents(ctx, { type: 'invoice.registered', typeVersion: 1 });
    expect(onlyV1.map((e) => e.id)).toEqual([v1.id]);
    const all = await listEvents(ctx, { type: 'invoice.registered' });
    expect(all.map((e) => e.id)).toEqual([v1.id, v2.id]);
  });
});

describe('ordering metadata (W003 acceptance)', () => {
  it('assigns strictly increasing, unique sequences — the canonical replay order', async () => {
    const ctx = member(tenantOrder); // fresh tenant: sequences start at 1
    const sequences: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const event = await appendEvent(ctx, {
        ...baseInput(),
        payload: { seq: i },
        occurredAt: `2026-09-1${i}T00:00:00Z`,
      });
      sequences.push(event.sequence);
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(sequences).size).toBe(sequences.length);

    const feed = await listEvents(ctx, {});
    expect(feed.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(feed.map((e) => (e.payload as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4]);
    // commit time never goes backwards along the canonical order
    for (let i = 1; i < feed.length; i += 1) {
      expect(Date.parse(feed[i]!.recordedAt)).toBeGreaterThanOrEqual(
        Date.parse(feed[i - 1]!.recordedAt),
      );
    }
  });

  it('numbers tenants independently', async () => {
    const b1 = await appendEvent(member(tenantB), baseInput());
    const b2 = await appendEvent(member(tenantB), baseInput());
    expect(b1.sequence).toBe(1);
    expect(b2.sequence).toBe(2);
  });

  it('replays in ascending order by default and descending on request, honoring the limit', async () => {
    const ctx = member(tenantOrder);
    const asc = await listEvents(ctx, {});
    expect(asc.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    const desc = await listEvents(ctx, { order: 'desc' });
    expect(desc.map((e) => e.sequence)).toEqual([5, 4, 3, 2, 1]);
    const limited = await listEvents(ctx, { limit: 2 });
    expect(limited.map((e) => e.sequence)).toEqual([1, 2]);
    const latest = await listEvents(ctx, { order: 'desc', limit: 2 });
    expect(latest.map((e) => e.sequence)).toEqual([5, 4]);
  });

  it('supports sequence cursors for paginated replay', async () => {
    const ctx = member(tenantOrder);
    const window = await listEvents(ctx, { sequenceFrom: 2, sequenceTo: 4 });
    expect(window.map((e) => e.sequence)).toEqual([2, 3, 4]);
    const page = await listEvents(ctx, { order: 'desc', sequenceTo: 3, limit: 2 });
    expect(page.map((e) => e.sequence)).toEqual([3, 2]);
    const tail = await listEvents(ctx, { sequenceFrom: 4 });
    expect(tail.map((e) => e.sequence)).toEqual([4, 5]);
  });
});

describe('idempotency keys (W003 acceptance)', () => {
  it('re-appending a recorded key replays the original event — no duplicate, no sequence consumed', async () => {
    const ctx = member(tenantKeys); // fresh tenant
    const first = await appendEvent(ctx, { ...baseInput(), idempotencyKey: 'billing:INV-17' });
    expect(first.sequence).toBe(1);

    // identical retry: same envelope, same id, same commit time
    const replay = await appendEvent(ctx, { ...baseInput(), idempotencyKey: 'billing:INV-17' });
    expect(replay).toEqual(first);

    // divergent retry: first write wins, history is not rewritten
    const divergent = await appendEvent(ctx, {
      ...baseInput(),
      payload: { text: 'tampered' },
      idempotencyKey: 'billing:INV-17',
    });
    expect(divergent.id).toBe(first.id);
    expect(divergent.payload).toEqual(first.payload);

    const all = await listEvents(ctx, {});
    expect(all).toHaveLength(1);

    // the replays consumed no sequence number
    const next = await appendEvent(ctx, { ...baseInput(), type: 'invoice.paid' });
    expect(next.sequence).toBe(2);

    // events without a key never dedupe (SQL UNIQUE treats NULLs as distinct)
    const k1 = await appendEvent(ctx, { ...baseInput(), type: 'heartbeat.tick' });
    const k2 = await appendEvent(ctx, { ...baseInput(), type: 'heartbeat.tick' });
    expect(k1.id).not.toBe(k2.id);
    expect(k2.sequence).toBe(k1.sequence + 1);
  });

  it('scopes idempotency keys per tenant', async () => {
    const domestic = (await listEvents(member(tenantKeys), { idempotencyKey: 'billing:INV-17' }))[0]!;
    const foreign = await appendEvent(member(tenantB), {
      ...baseInput(),
      idempotencyKey: 'billing:INV-17', // already recorded in tenantKeys
    });
    expect(foreign.id).not.toBe(domestic.id);
    expect(foreign.tenantId).toBe(tenantB);
    expect(domestic.tenantId).toBe(tenantKeys);
    // both tenants keep exactly one event under the shared key
    expect(await listEvents(member(tenantKeys), { idempotencyKey: 'billing:INV-17' })).toHaveLength(1);
    expect(await listEvents(member(tenantB), { idempotencyKey: 'billing:INV-17' })).toHaveLength(1);
  });

  it('locates a single event by its idempotency key', async () => {
    const ctx = member(tenantKeys);
    const found = await listEvents(ctx, { idempotencyKey: 'billing:INV-17' });
    expect(found).toHaveLength(1);
    expect(found[0]!.sequence).toBe(1);
  });
});

describe('correlation and causation (ARCHITECTURE.md §25)', () => {
  it('correlates a root event to itself when no explicit id is given', async () => {
    const ctx = member(tenantA);
    const root = await appendEvent(ctx, { ...baseInput() });
    expect(root.correlationId).toBe(root.id);
    expect(root.causationId).toBeNull();
  });

  it('keeps an explicitly supplied correlation id on a root event', async () => {
    const ctx = member(tenantA);
    const flow = newId();
    const root = await appendEvent(ctx, { ...baseInput(), correlationId: flow });
    expect(root.correlationId).toBe(flow);
  });

  it('lets a caused event inherit the cause\'s correlation id', async () => {
    const ctx = member(tenantA);
    const root = await appendEvent(ctx, { ...baseInput() });
    const caused = await appendEvent(ctx, {
      ...baseInput(),
      type: 'observation.recorded',
      causationId: root.id,
    });
    expect(caused.causationId).toBe(root.id);
    expect(caused.correlationId).toBe(root.correlationId); // inherited
  });

  it('prefers an explicit correlation id over inheritance', async () => {
    const ctx = member(tenantA);
    const root = await appendEvent(ctx, { ...baseInput() });
    const otherFlow = newId();
    const caused = await appendEvent(ctx, {
      ...baseInput(),
      causationId: root.id,
      correlationId: otherFlow,
    });
    expect(caused.correlationId).toBe(otherFlow);
    expect(caused.causationId).toBe(root.id);
  });

  it('rejects missing and cross-tenant causes without leaking their existence', async () => {
    const ctx = member(tenantA);
    await expect(
      appendEvent(ctx, { ...baseInput(), causationId: newId() }),
    ).rejects.toMatchObject({ code: 'event_not_found' });

    const foreign = await appendEvent(member(tenantB), baseInput());
    await expect(
      appendEvent(ctx, { ...baseInput(), causationId: foreign.id }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });

  it('walks the causation chain up to the root', async () => {
    const ctx = member(tenantA);
    const root = await appendEvent(ctx, { ...baseInput() });
    const mid = await appendEvent(ctx, {
      ...baseInput(),
      type: 'observation.recorded',
      causationId: root.id,
    });
    const leaf = await appendEvent(ctx, {
      ...baseInput(),
      type: 'belief.updated',
      causationId: mid.id,
    });

    const chain = await getEventCausationChain(ctx, leaf.id);
    expect(chain.event.id).toBe(leaf.id);
    expect(chain.causes.map((e) => e.id)).toEqual([mid.id, root.id]); // immediate cause first, root last
    expect(chain.causes[1]!.causationId).toBeNull(); // the root has no cause

    const rootChain = await getEventCausationChain(ctx, root.id);
    expect(rootChain.event.id).toBe(root.id);
    expect(rootChain.causes).toEqual([]);
  });

  it('lists whole flows by correlation id and direct children by causation id', async () => {
    const ctx = member(tenantA);
    const root = await appendEvent(ctx, { ...baseInput() });
    const mid = await appendEvent(ctx, {
      ...baseInput(),
      type: 'observation.recorded',
      causationId: root.id,
    });
    const leaf = await appendEvent(ctx, {
      ...baseInput(),
      type: 'belief.updated',
      causationId: mid.id,
    });

    const flow = await listEvents(ctx, { correlationId: root.correlationId });
    expect(flow).toHaveLength(3);
    expect(flow.map((e) => e.id).sort()).toEqual([root.id, mid.id, leaf.id].sort());

    const children = await listEvents(ctx, { causationId: root.id });
    expect(children.map((e) => e.id)).toEqual([mid.id]);
  });
});

describe('immutability (lock 5)', () => {
  it('exposes no mutation or replay-overwrite operation on the contract surface', async () => {
    // The ONLY public surface of the module is contract.ts; its export set
    // is pinned here: append + read + list + causation chain +
    // errors/types/vocabularies. There is deliberately no updateEvent, no
    // deleteEvent, no correctEvent, no reposition/resequence operation.
    expect(Object.keys(eventsContract).sort()).toEqual([
      'DEFAULT_LIST_LIMIT',
      'ENVELOPE_VERSION',
      'EVENT_ACTOR_KINDS',
      'EVENT_SOURCE_KINDS',
      'EventsError',
      'MAX_IDEMPOTENCY_KEY_LENGTH',
      'MAX_LIST_LIMIT',
      'appendEvent',
      'getEvent',
      'getEventCausationChain',
      'isEventActorKind',
      'isEventSourceKind',
      'listEvents',
    ]);
  });

  it('carries exactly the envelope fields on the record shape', async () => {
    const ctx = member(tenantA);
    const recorded = await appendEvent(ctx, baseInput());
    expect(Object.keys(recorded).sort()).toEqual([
      'actor',
      'causationId',
      'correlationId',
      'envelopeVersion',
      'id',
      'idempotencyKey',
      'occurredAt',
      'payload',
      'recordedAt',
      'sequence',
      'source',
      'tenantId',
      'type',
      'typeVersion',
    ]);
  });

  it('rejects UPDATE, DELETE and TRUNCATE on events at the storage layer (lock 5)', async () => {
    const ctx = member(tenantA);
    const recorded = await appendEvent(ctx, {
      ...baseInput(),
      payload: { text: 'original history' },
    });

    await expect(
      getDb().query(`UPDATE events SET payload = '{"text":"tampered"}'::jsonb WHERE id = $1`, [
        recorded.id,
      ]),
    ).rejects.toThrow(/immutable/i);

    await expect(
      getDb().query(`UPDATE events SET sequence = sequence + 100 WHERE id = $1`, [recorded.id]),
    ).rejects.toThrow(/immutable/i);

    await expect(getDb().query(`DELETE FROM events WHERE id = $1`, [recorded.id])).rejects.toThrow(
      /immutable/i,
    );

    // TRUNCATE is blocked twice over: the immutability trigger AND the
    // self-referencing foreign key (truncating a referenced table requires
    // CASCADE). Either way, history cannot be bulk-erased.
    await expect(getDb().query(`TRUNCATE events`)).rejects.toThrow(
      /immutable|cannot truncate/i,
    );

    // the event survived all four attempts untouched
    const after = await getEvent(ctx, recorded.id);
    expect(after.payload).toEqual({ text: 'original history' });
    expect(after.sequence).toBe(recorded.sequence);
  });

  it('protects the per-tenant sequence counters from removal, but not from increments', async () => {
    const ctx = member(tenantCounter); // fresh tenant
    const first = await appendEvent(ctx, baseInput());
    expect(first.sequence).toBe(1);

    await expect(
      getDb().query(`DELETE FROM event_sequences WHERE tenant_id = $1`, [tenantCounter]),
    ).rejects.toThrow(/cannot be removed/i);
    await expect(getDb().query(`TRUNCATE event_sequences`)).rejects.toThrow(
      /cannot be removed/i,
    );

    // the counter's job is to be incremented: a manual bump is legal and
    // merely leaves a gap — ordering stays strictly increasing
    await getDb().query(
      `UPDATE event_sequences SET last_sequence = last_sequence + 10 WHERE tenant_id = $1`,
      [tenantCounter],
    );
    const afterBump = await appendEvent(ctx, baseInput());
    expect(afterBump.sequence).toBe(12);
    const afterNext = await appendEvent(ctx, baseInput());
    expect(afterNext.sequence).toBe(13);
    expect(afterNext.sequence).toBeGreaterThan(first.sequence);
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('hides events across tenants with a uniform not-found', async () => {
    const inA = await appendEvent(member(tenantA), { ...baseInput(), payload: { secret: 'A' } });
    await expect(getEvent(member(tenantB), inA.id)).rejects.toMatchObject({
      code: 'event_not_found',
    });
    // a malformed id is indistinguishable from a missing one
    await expect(getEvent(member(tenantA), 'not-a-uuid')).rejects.toMatchObject({
      code: 'event_not_found',
    });
    // the causation chain of another tenant's event is equally invisible
    await expect(getEventCausationChain(member(tenantB), inA.id)).rejects.toMatchObject({
      code: 'event_not_found',
    });
  });

  it('never lists one tenant\'s history in another tenant\'s feed', async () => {
    await appendEvent(member(tenantA), { ...baseInput(), payload: { text: 'A-only' } });
    const bFeed = await listEvents(member(tenantB), {});
    expect(bFeed.map((e) => e.tenantId)).not.toContain(tenantA);
    expect(bFeed.length).toBeGreaterThan(0);
    const aFeed = await listEvents(member(tenantA), {});
    expect(aFeed.every((e) => e.tenantId === tenantA)).toBe(true);
  });
});

describe('listEvents filters', () => {
  it('filters by type, actor, source and occurred window', async () => {
    const ctx = member(tenantList); // fresh tenant for a clean feed
    const actorId = newId();
    const sourceId = newId();
    const wanted = await appendEvent(ctx, {
      type: 'metric.sampled',
      payload: { metric: 'dso', value: 41.5 },
      occurredAt: '2026-09-10T12:00:00Z',
      actor: { kind: 'person', id: actorId },
      source: { kind: 'source', id: sourceId, label: 'billing' },
    });
    await appendEvent(ctx, {
      ...baseInput(),
      occurredAt: '2026-09-20T12:00:00Z', // outside the window below
    });
    await appendEvent(ctx, { ...baseInput(), type: 'channel.message.sent' });

    const byType = await listEvents(ctx, { type: 'metric.sampled' });
    expect(byType.map((e) => e.id)).toEqual([wanted.id]);

    const byActor = await listEvents(ctx, { actorKind: 'person', actorId });
    expect(byActor.map((e) => e.id)).toEqual([wanted.id]);

    const bySource = await listEvents(ctx, { sourceKind: 'source', sourceId });
    expect(bySource.map((e) => e.id)).toEqual([wanted.id]);

    const byWindow = await listEvents(ctx, {
      occurredFrom: '2026-09-09T00:00:00Z',
      occurredTo: '2026-09-11T00:00:00Z',
    });
    expect(byWindow.map((e) => e.id)).toEqual([wanted.id]);

    const bySourceKind = await listEvents(ctx, { sourceKind: 'channel' });
    expect(bySourceKind.map((e) => e.id)).not.toContain(wanted.id);
  });

  it('rejects invalid queries', async () => {
    const ctx = member(tenantList);
    await expect(listEvents(ctx, { order: 'sideways' } as never)).rejects.toMatchObject({
      code: 'invalid_event_query',
    });
    await expect(listEvents(ctx, { actorId: newId() } as never)).rejects.toMatchObject({
      code: 'invalid_event_query',
    });
    await expect(listEvents(ctx, { typeVersion: 2 } as never)).rejects.toMatchObject({
      code: 'invalid_event_query',
    });
    await expect(listEvents(ctx, { limit: 0 } as never)).rejects.toMatchObject({
      code: 'invalid_event_query',
    });
    await expect(
      listEvents(ctx, { sequenceFrom: 5, sequenceTo: 2 } as never),
    ).rejects.toMatchObject({ code: 'invalid_event_query' });
    await expect(
      listEvents(ctx, { nope: 1 } as never),
    ).rejects.toMatchObject({ code: 'invalid_event_query' });
  });
});

describe('error type', () => {
  it('carries the module error name and code', () => {
    const error = new EventsError('event_not_found', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EventsError');
    expect(error.code).toBe('event_not_found');
  });
});
