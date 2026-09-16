// Integration tests for the sources module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W036 acceptance:
// "Provider-independent inbound connectors with OAuth/credentials
// isolation, polling/webhooks, checkpointing, replay and dedupe."
//
//  * registration — creation, idempotent re-registration as the
//    re-authorization path (authorization fields move, identity does
//    not), account normalization, uniform cross-tenant not-found
//    discipline (ADR-0001);
//  * polling — fetch through the provider-neutral transport port, records
//    becoming immutable observations through the observations contract
//    (W004: lineage `connector`, provenance `{ kind: 'source', id }`,
//    provider key as channel), checkpoint advance + append-only history,
//    request parameters (cursor, maxRecords, opaque credentialRef);
//  * dedupe — webhook redelivery, poll re-fetch of the same window and
//    poll/webhook overlap all suppress against the ingestion ledger:
//    one observation per provider record id, ever;
//  * checkpointing — fetch failures leave the cursor unchanged (the
//    retry re-fetches the same window), exhausted windows keep the last
//    cursor, unchanged cursors add no history;
//  * replay — rewinding to a recorded checkpoint (or to the start) makes
//    the next poll reprocess that window under dedupe: duplicates are
//    suppressed, missed records are picked up; every rewind is audited;
//  * webhooks — envelope → adapter → tenant's registered source; foreign
//    accounts are uniformly not found (no cross-tenant leak); disabled
//    sources refuse ingestion; mode gates reject the wrong path;
//  * OAuth/credentials isolation — credential VALUES never cross the
//    contract (only the opaque reference does); lapsed grants fail fast;
//    transport-reported refreshes update the recorded expiry;
//  * tenant isolation — another tenant's sources, checkpoints and replay
//    targets are indistinguishable from missing;
//  * storage discipline — the ingestion ledger is append-only with a
//    one-way observation link; checkpoint history is append-only;
//    checkpoints may only move their cursor;
//  * crash recovery — a claim that never linked is re-observed when the
//    provider delivers the record again;
//  * serialization — a concurrent ingestion pass on the same source fails
//    explicitly with `ingestion_busy`.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as sourcesContract from '../contract';
import { listObservations } from '@/modules/observations/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { getLock } from '@/infra/lock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { SourcesError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';
import type { SourceFetchRequest, SourceFetchResult, SourceTransport } from '../types';

const {
  getSource,
  getSourceCheckpoint,
  getSourceTransport,
  listSourceCheckpoints,
  listSources,
  pollSource,
  receiveSourceWebhook,
  registerSource,
  replaySource,
  setSourceStatus,
  setSourceTransport,
} = sourcesContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantRegister = newId();
const tenantPoll = newId();
const tenantDedupe = newId();
const tenantCheckpoint = newId();
const tenantReplay = newId();
const tenantWebhook = newId();
const tenantAuth = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantRecovery = newId();
const tenantBusy = newId();
const tenantB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: SourcesError['code'], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected SourcesError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof SourcesError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** Canonical record factory for scripted fetches. */
function rec(id: string, extra: Record<string, unknown> = {}) {
  return {
    providerRecordId: id,
    kind: 'crm.opportunity.updated',
    payload: { recordId: id, ...extra },
    occurredAt: '2026-09-14T10:15:00Z',
  };
}

function batch(records: ReturnType<typeof rec>[], nextCursor: string | null, hasMore = false): SourceFetchResult {
  return { records, nextCursor, hasMore };
}

/** A provider-neutral transport that records every fetch request. */
class ScriptedTransport implements SourceTransport {
  readonly requests: SourceFetchRequest[] = [];
  private scripted: (SourceFetchResult | Error)[] = [];

  /** Queue exact results/throws (consumed in order); unscripted fetches return an empty exhausted window. */
  script(...results: (SourceFetchResult | Error)[]): void {
    this.scripted.push(...results);
  }

  async fetch(request: SourceFetchRequest): Promise<SourceFetchResult> {
    this.requests.push(request);
    const next = this.scripted.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

let transport: ScriptedTransport;

const BASE_TIME = Date.parse('2026-09-14T08:00:00Z');
let clockMs = BASE_TIME;

function advance(seconds: number): void {
  clockMs += seconds * 1_000;
}

let accountCounter = 0;
async function registerSalesforce(
  tenantId: string,
  overrides: Partial<Parameters<typeof registerSource>[1]> = {},
): Promise<string> {
  // Default account ids are unique per call so every test owns a fresh
  // source even inside a shared tenant (fixed accounts are passed
  // explicitly where a webhook envelope must resolve onto the source).
  accountCounter += 1;
  const { source } = await registerSource(member(tenantId), {
    provider: 'salesforce',
    providerAccountId: `00Dxx${String(accountCounter).padStart(12, '0')}`,
    displayName: 'Acme CRM',
    authKind: 'oauth',
    credentialRef: 'secret-store://salesforce/acme',
    oauthScopes: ['crm.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
    ...overrides,
  });
  return source.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setSourceTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  transport = new ScriptedTransport();
  setSourceTransport(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSourceTransport(null);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('source registration', () => {
  it('creates a source with canonical account id and derived modes', async () => {
    const { source, created } = await registerSource(member(tenantRegister), {
      provider: 'github',
      providerAccountId: '  Acme-Ops ',
      authKind: 'oauth',
      credentialRef: 'secret-store://github/acme',
      oauthScopes: ['repo.read'],
      oauthExpiresAt: '2027-06-01T00:00:00Z',
    });
    expect(created).toBe(true);
    expect(source.provider).toBe('github');
    expect(source.providerAccountId).toBe('acme-ops');
    expect(source.status).toBe('active');
    expect(source.modes).toEqual(['polling', 'webhook']);
    expect(source.oauthScopes).toEqual(['repo.read']);
    expect(source.oauthExpiresAt).toBe('2027-06-01T00:00:00.000Z');
    // Credential ISOLATION: only the opaque reference exists, never a value.
    expect(source.credentialRef).toBe('secret-store://github/acme');

    const read = await getSource(member(tenantRegister), source.id);
    expect(read.id).toBe(source.id);
  });

  it('re-registration is the re-authorization path (identity immutable, authorization moves)', async () => {
    const ctx = member(tenantRegister);
    const first = await registerSource(ctx, {
      provider: 'stripe',
      providerAccountId: 'acct_9',
      authKind: 'credentials',
      credentialRef: 'secret-store://stripe/acme',
    });
    expect(first.created).toBe(true);
    advance(60);
    const second = await registerSource(ctx, {
      provider: 'stripe',
      providerAccountId: 'ACCT_9',
      authKind: 'oauth',
      credentialRef: 'secret-store://stripe/acme-v2',
      oauthScopes: ['charges.read'],
      oauthExpiresAt: '2027-03-01T00:00:00Z',
      displayName: 'ignored on re-registration',
    });
    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);
    expect(second.source.authKind).toBe('oauth');
    expect(second.source.credentialRef).toBe('secret-store://stripe/acme-v2');
    expect(second.source.oauthScopes).toEqual(['charges.read']);
    expect(second.source.oauthExpiresAt).toBe('2027-03-01T00:00:00.000Z');
    // Identity and first-registration metadata never change.
    expect(second.source.providerAccountId).toBe('acct_9');
    expect(second.source.displayName).toBe(first.source.displayName);
    expect(second.source.createdBy).toBe(first.source.createdBy);
    expect(second.source.createdAt).toBe(first.source.createdAt);
  });

  it('lists with filters and flips status', async () => {
    const tenantLists = newId(); // fresh tenant: list assertions stay exact
    const ctx = member(tenantLists);
    await registerSalesforce(tenantLists);
    advance(1); // distinct created_at keeps list ordering deterministic
    const { source: gh } = await registerSource(ctx, {
      provider: 'github',
      providerAccountId: 'acme-ops',
      authKind: 'credentials',
      credentialRef: 'secret-store://github/acme',
    });
    expect((await listSources(ctx, {})).map((s) => s.provider)).toEqual(['github', 'salesforce']);
    expect(await listSources(ctx, { provider: 'salesforce' })).toHaveLength(1);
    const disabled = await setSourceStatus(ctx, { sourceId: gh.id, status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    expect(await listSources(ctx, { status: 'disabled' })).toHaveLength(1);
    expect(await listSources(ctx, { status: 'active' })).toHaveLength(1);
    await expectCode('source_not_found', () =>
      setSourceStatus(ctx, { sourceId: newId(), status: 'active' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe('polling ingestion', () => {
  it('fails explicitly without a wired transport', async () => {
    setSourceTransport(null);
    const sourceId = await registerSalesforce(tenantPoll);
    await expectCode('provider_unavailable', () => pollSource(member(tenantPoll), { sourceId }));
  });

  it('fetches from the checkpoint, records observations and advances the cursor', async () => {
    const ctx = member(tenantPoll);
    const sourceId = await registerSalesforce(tenantPoll, {
      providerAccountId: '00Dxx0000000001',
    });
    transport.script(
      batch([rec('sf-1'), rec('sf-2', { stage: 'Discovery' })], 'cursor-2', true),
      batch([rec('sf-3')], null, false),
    );

    const first = await pollSource(ctx, { sourceId });
    expect(first.fetched).toBe(2);
    expect(first.ingested).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.checkpoint?.cursor).toBe('cursor-2');
    // The fetch request carried the opaque credential reference, the
    // canonical account id, the null (beginning) cursor and the default cap.
    expect(transport.requests[0]).toEqual({
      provider: 'salesforce',
      tenantId: tenantPoll,
      sourceId,
      providerAccountId: '00DXX0000000001',
      credentialRef: 'secret-store://salesforce/acme',
      cursor: null,
      maxRecords: 50,
    });

    // The records became observations with full provenance (W004).
    const observations = await listObservations(ctx, { sourceKind: 'source', sourceId });
    expect(observations).toHaveLength(2);
    const observation = observations.find(
      (o) => (o.payload as { recordId?: string }).recordId === 'sf-1',
    )!;
    expect(observation.kind).toBe('crm.opportunity.updated');
    expect(observation.observedAt).toBe('2026-09-14T10:15:00.000Z');
    expect(observation.source).toEqual({ kind: 'source', id: sourceId, label: null });
    expect(observation.channel).toBe('salesforce');
    expect(observation.lineage.method).toBe('connector');
    expect(observation.lineage.parents).toEqual([]);
    expect(observation.confidence.method).toBe('source_gateway');
    expect(observation.permissions.visibility).toBe('tenant');

    // The ledger links every ingested record to its observation.
    const ledger = await getDb().query<{ provider_record_id: string; ingested_via: string; observation_id: string }>(
      `SELECT provider_record_id, ingested_via, observation_id FROM source_records
         WHERE tenant_id = $1 AND source_id = $2 ORDER BY provider_record_id`,
      [tenantPoll, sourceId],
    );
    expect(ledger.rows.map((r) => r.provider_record_id)).toEqual(['sf-1', 'sf-2']);
    for (const row of ledger.rows) {
      expect(row.ingested_via).toBe('polling');
      expect(row.observation_id).not.toBeNull();
      expect(first.observations.some((o) => o.observationId === row.observation_id)).toBe(true);
    }

    const second = await pollSource(ctx, { sourceId, maxRecords: 25 });
    expect(second.ingested).toBe(1);
    expect(second.checkpoint?.cursor).toBe('cursor-2'); // null next cursor keeps the last cursor
    expect(second.hasMore).toBe(false);
    expect(transport.requests[1]!.cursor).toBe('cursor-2');
    expect(transport.requests[1]!.maxRecords).toBe(25);

    const history = await listSourceCheckpoints(ctx, { sourceId });
    expect(history.map((entry) => [entry.cursor, entry.origin])).toEqual([
      ['cursor-2', 'poll'],
    ]);
    expect(history[0]!.recordedBy).toBe(ctx.principalId);
  });

  it('missing or disabled sources poll nowhere', async () => {
    const sourceId = await registerSalesforce(tenantPoll);
    await setSourceStatus(member(tenantPoll), { sourceId, status: 'disabled' });
    await expectCode('source_disabled', () => pollSource(member(tenantPoll), { sourceId }));
    await expectCode('source_not_found', () => pollSource(member(tenantPoll), { sourceId: newId() }));
    await expectCode('source_not_found', () => pollSource(member(tenantB), { sourceId }));
  });

  it('webhook-only providers reject polling', async () => {
    const { source } = await registerSource(member(tenantPoll), {
      provider: 'zapier',
      providerAccountId: 'sub-1',
      authKind: 'credentials',
      credentialRef: 'secret-store://zapier/acme',
    });
    await expectCode('ingestion_mode_unsupported', () => pollSource(member(tenantPoll), { sourceId: source.id }));
  });
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe('ingestion dedupe', () => {
  it('re-fetching the same window suppresses already-observed records', async () => {
    const ctx = member(tenantDedupe);
    const sourceId = await registerSalesforce(tenantDedupe);
    transport.script(
      batch([rec('d-1'), rec('d-2')], 'cursor-1'),
      batch([rec('d-1'), rec('d-2'), rec('d-3')], 'cursor-2'), // re-delivery + one new
    );
    const first = await pollSource(ctx, { sourceId });
    expect(first.ingested).toBe(2);
    const second = await pollSource(ctx, { sourceId });
    expect(second.fetched).toBe(3);
    expect(second.ingested).toBe(1);
    expect(second.duplicates).toBe(2);
    const observations = await listObservations(ctx, { sourceKind: 'source', sourceId });
    expect(observations).toHaveLength(3); // one observation per record id, ever
  });

  it('webhook redelivery and poll/webhook overlap dedupe on the same ledger', async () => {
    const ctx = member(tenantDedupe);
    const sourceId = await registerSalesforce(tenantDedupe, {
      providerAccountId: '00Dxx0000000001',
    });
    transport.script(batch([rec('w-1'), rec('w-2')], null));

    const polled = await pollSource(ctx, { sourceId });
    expect(polled.ingested).toBe(2);

    const envelope = (events: Array<{ id: string }>) => ({
      organizationId: '00Dxx0000000001',
      events: events.map((event) => ({
        id: event.id,
        changeType: 'UPDATE',
        entity: 'Opportunity',
        occurredAt: '2026-09-14T10:15:00Z',
        record: { recordId: event.id },
      })),
    });
    const delivered = await receiveSourceWebhook(ctx, {
      provider: 'salesforce',
      payload: envelope([{ id: 'w-1' }, { id: 'w-3' }]),
    });
    expect(delivered.source.id).toBe(sourceId);
    expect(delivered.fetched).toBe(2);
    expect(delivered.ingested).toBe(1);
    expect(delivered.duplicates).toBe(1);

    const redelivered = await receiveSourceWebhook(ctx, {
      provider: 'salesforce',
      payload: envelope([{ id: 'w-1' }, { id: 'w-3' }]),
    });
    expect(redelivered.ingested).toBe(0);
    expect(redelivered.duplicates).toBe(2);

    const ledger = await getDb().query<{ provider_record_id: string; ingested_via: string }>(
      `SELECT provider_record_id, ingested_via FROM source_records
         WHERE tenant_id = $1 AND source_id = $2 AND provider_record_id LIKE 'w-%'
         ORDER BY provider_record_id`,
      [tenantDedupe, sourceId],
    );
    expect(ledger.rows.map((r) => [r.provider_record_id, r.ingested_via])).toEqual([
      ['w-1', 'polling'],
      ['w-2', 'polling'],
      ['w-3', 'webhook'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Checkpointing
// ---------------------------------------------------------------------------

describe('checkpointing', () => {
  it('a failed fetch leaves the cursor unchanged so the retry re-fetches the window', async () => {
    const ctx = member(tenantCheckpoint);
    const sourceId = await registerSalesforce(tenantCheckpoint);
    expect(await getSourceCheckpoint(ctx, { sourceId })).toBeNull();

    transport.script(new Error('provider 503'), batch([rec('c-1')], 'cursor-1'));
    await expectCode('fetch_failed', () => pollSource(ctx, { sourceId }));
    expect(await getSourceCheckpoint(ctx, { sourceId })).toBeNull();

    const retry = await pollSource(ctx, { sourceId });
    expect(retry.ingested).toBe(1);
    expect(retry.checkpoint?.cursor).toBe('cursor-1');
    expect(transport.requests[1]!.cursor).toBeNull(); // same window re-fetched
  });

  it('an unchanged cursor adds no history; a fresh cursor does', async () => {
    const ctx = member(tenantCheckpoint);
    const sourceId = await registerSalesforce(tenantCheckpoint);
    transport.script(
      batch([rec('k-1')], 'cursor-1'),
      batch([], 'cursor-1'), // provider says "still current"
      batch([rec('k-2')], 'cursor-2'),
    );
    await pollSource(ctx, { sourceId });
    advance(1);
    await pollSource(ctx, { sourceId });
    expect(await listSourceCheckpoints(ctx, { sourceId })).toHaveLength(1);
    advance(1);
    await pollSource(ctx, { sourceId });
    const history = await listSourceCheckpoints(ctx, { sourceId });
    expect(history.map((entry) => entry.cursor)).toEqual(['cursor-2', 'cursor-1']);
  });

  it('an exhausted window (null cursor) keeps the last recorded cursor', async () => {
    const ctx = member(tenantCheckpoint);
    const sourceId = await registerSalesforce(tenantCheckpoint);
    transport.script(batch([rec('e-1')], 'cursor-9'), batch([], null));
    await pollSource(ctx, { sourceId });
    const second = await pollSource(ctx, { sourceId });
    expect(second.checkpoint?.cursor).toBe('cursor-9');
    expect(await listSourceCheckpoints(ctx, { sourceId })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe('replay', () => {
  it('rewinds to a recorded checkpoint; the next poll reprocesses under dedupe', async () => {
    const ctx = member(tenantReplay);
    const sourceId = await registerSalesforce(tenantReplay);
    transport.script(
      batch([rec('r-1'), rec('r-2')], 'cursor-1'),
      batch([rec('r-3')], 'cursor-2'),
      // The replayed window: the two originals plus one record the first
      // pass never delivered (a delivery gap the rewind now closes).
      batch([rec('r-1'), rec('r-2'), rec('r-missed')], 'cursor-2'),
    );
    await pollSource(ctx, { sourceId });
    advance(1);
    await pollSource(ctx, { sourceId });
    expect(await listObservations(ctx, { sourceKind: 'source', sourceId })).toHaveLength(3);

    const history = await listSourceCheckpoints(ctx, { sourceId });
    expect(history.map((entry) => [entry.cursor, entry.origin])).toEqual([
      ['cursor-2', 'poll'],
      ['cursor-1', 'poll'],
    ]);

    advance(1);
    const replayed = await replaySource(ctx, { sourceId, checkpointId: history[1]!.id });
    expect(replayed.rewoundTo?.cursor).toBe('cursor-1');
    expect(replayed.checkpoint.cursor).toBe('cursor-1');
    expect(replayed.source.id).toBe(sourceId);

    advance(1);
    const reprocessed = await pollSource(ctx, { sourceId });
    expect(transport.requests[2]!.cursor).toBe('cursor-1');
    expect(reprocessed.fetched).toBe(3);
    expect(reprocessed.duplicates).toBe(2);
    expect(reprocessed.ingested).toBe(1); // only the missed record
    expect(reprocessed.checkpoint?.cursor).toBe('cursor-2');

    const observations = await listObservations(ctx, { sourceKind: 'source', sourceId });
    expect(observations).toHaveLength(4); // no duplicates, gap closed

    const historyAfter = await listSourceCheckpoints(ctx, { sourceId });
    expect(historyAfter.map((entry) => [entry.cursor, entry.origin])).toEqual([
      ['cursor-2', 'poll'],
      ['cursor-1', 'replay'],
      ['cursor-2', 'poll'],
      ['cursor-1', 'poll'],
    ]);
  });

  it('replays to the beginning of the provider history (fromStart)', async () => {
    const ctx = member(tenantReplay);
    const sourceId = await registerSalesforce(tenantReplay);
    transport.script(batch([rec('s-1')], 'cursor-1'), batch([], null));
    await pollSource(ctx, { sourceId });
    advance(1);
    const replayed = await replaySource(ctx, { sourceId, fromStart: true });
    expect(replayed.rewoundTo).toBeNull();
    expect(replayed.checkpoint.cursor).toBeNull();
    advance(1);
    await pollSource(ctx, { sourceId });
    expect(transport.requests[1]!.cursor).toBeNull();
    expect((await listSourceCheckpoints(ctx, { sourceId }))[0]).toMatchObject({
      cursor: null,
      origin: 'replay',
    });
  });

  it('replay targets are tenant-scoped and source-scoped (uniform not-found)', async () => {
    const ctxA = member(tenantReplay);
    const sourceA = await registerSalesforce(tenantReplay);
    transport.script(batch([rec('t-1')], 'cursor-1'));
    await pollSource(ctxA, { sourceId: sourceA });
    const history = await listSourceCheckpoints(ctxA, { sourceId: sourceA });

    await expectCode('checkpoint_not_found', () =>
      replaySource(ctxA, { sourceId: sourceA, checkpointId: newId() }),
    );
    // Another tenant sees neither the source nor its checkpoints.
    await expectCode('source_not_found', () =>
      replaySource(member(tenantB), { sourceId: sourceA, checkpointId: history[0]!.id }),
    );
    // A second source in the SAME tenant cannot use the first source's targets.
    const { source: sourceB } = await registerSource(ctxA, {
      provider: 'salesforce',
      providerAccountId: '00Dxx0000000002',
      authKind: 'credentials',
      credentialRef: 'secret-store://salesforce/other',
    });
    await expectCode('checkpoint_not_found', () =>
      replaySource(ctxA, { sourceId: sourceB.id, checkpointId: history[0]!.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

describe('webhook ingestion', () => {
  const stripeEnvelope = (eventId: string, account = 'acct_9', type = 'invoice.paid') => ({
    id: eventId,
    account,
    created: 1760000000,
    type,
    data: { object: { invoice: `in_${eventId}`, amount_paid: 4200 } },
  });

  it('ingests pushed envelopes and links them via webhook', async () => {
    const ctx = member(tenantWebhook);
    await registerSource(ctx, {
      provider: 'stripe',
      providerAccountId: 'ACCT_9',
      authKind: 'credentials',
      credentialRef: 'secret-store://stripe/acme',
    });
    const result = await receiveSourceWebhook(ctx, {
      provider: 'stripe',
      payload: stripeEnvelope('evt_1'),
    });
    expect(result.fetched).toBe(1);
    expect(result.ingested).toBe(1);
    expect(result.observations[0]!.providerRecordId).toBe('evt_1');
    const observations = await listObservations(ctx, { sourceKind: 'source', sourceId: result.source.id });
    expect(observations[0]!.kind).toBe('invoice.paid');
    expect(observations[0]!.channel).toBe('stripe');
  });

  it('unknown accounts and foreign tenants are uniformly not found', async () => {
    const ctx = member(tenantWebhook);
    await registerSource(ctx, {
      provider: 'stripe',
      providerAccountId: 'acct_9',
      authKind: 'credentials',
      credentialRef: 'secret-store://stripe/acme',
    });
    await expectCode('source_not_found', () =>
      receiveSourceWebhook(ctx, { provider: 'stripe', payload: stripeEnvelope('evt_x', 'acct_unknown', 'customer.updated') }),
    );
    // Tenant B receives the same envelope: tenant A's connector does not exist there.
    await expectCode('source_not_found', () =>
      receiveSourceWebhook(member(tenantB), { provider: 'stripe', payload: stripeEnvelope('evt_9') }),
    );
  });

  it('disabled sources, malformed envelopes and non-record events fail canonically', async () => {
    const ctx = member(tenantWebhook);
    const sourceId = await registerSalesforce(tenantWebhook, {
      providerAccountId: '00Dxx0000000001',
    });
    const envelope = (id: string) => ({
      organizationId: '00Dxx0000000001',
      events: [
        { id, changeType: 'UPDATE', entity: 'Opportunity', occurredAt: '2026-09-14T10:15:00Z', record: {} },
      ],
    });

    await setSourceStatus(ctx, { sourceId, status: 'disabled' });
    await expectCode('source_disabled', () =>
      receiveSourceWebhook(ctx, { provider: 'salesforce', payload: envelope('x-1') }),
    );
    await setSourceStatus(ctx, { sourceId, status: 'active' });

    await expectCode('invalid_provider_payload', () =>
      receiveSourceWebhook(ctx, { provider: 'salesforce', payload: { organizationId: '00Dxx0000000001' } }),
    );
    await expectCode('unsupported_provider_event', () =>
      receiveSourceWebhook(ctx, { provider: 'salesforce', payload: { organizationId: '00Dxx0000000001', handshake: 'ready' } }),
    );
  });

  it('polling-only providers reject webhooks; the payload itself stays at the edge', async () => {
    const ctx = member(tenantWebhook);
    await registerSource(ctx, {
      provider: 'notion',
      providerAccountId: 'workspace-1',
      authKind: 'credentials',
      credentialRef: 'secret-store://notion/acme',
    });
    await expectCode('ingestion_mode_unsupported', () =>
      receiveSourceWebhook(ctx, { provider: 'notion', payload: { anything: true } }),
    );
  });
});

// ---------------------------------------------------------------------------
// OAuth / credentials isolation
// ---------------------------------------------------------------------------

describe('authorization state', () => {
  it('a lapsed OAuth grant fails ingestion fast on both paths', async () => {
    const ctx = member(tenantAuth);
    const sourceId = await registerSalesforce(tenantAuth, {
      providerAccountId: '00Dxx0000000001',
      oauthExpiresAt: '2026-09-14T09:00:00Z', // lapses at BASE_TIME + 1h
    });
    advance(2 * 3_600); // now past the grant
    await expectCode('source_authorization_expired', () => pollSource(ctx, { sourceId }));
    const envelope = {
      organizationId: '00Dxx0000000001',
      events: [
        { id: 'a-1', changeType: 'UPDATE', entity: 'Opportunity', occurredAt: '2026-09-14T10:15:00Z', record: {} },
      ],
    };
    await expectCode('source_authorization_expired', () =>
      receiveSourceWebhook(ctx, { provider: 'salesforce', payload: envelope }),
    );
    expect(transport.requests).toHaveLength(0); // failed fast, no fetch attempted
  });

  it('a transport-reported grant refresh updates the recorded expiry', async () => {
    const ctx = member(tenantAuth);
    const sourceId = await registerSalesforce(tenantAuth, {
      oauthExpiresAt: '2026-09-14T09:00:00Z',
    });
    // Re-authorize before the lapse, then let the transport report a refresh.
    advance(1_800); // 08:30 — before the 09:00 expiry
    transport.script({
      records: [rec('auth-1')],
      nextCursor: null,
      hasMore: false,
      authorizationExpiresAt: '2026-09-21T09:00:00Z',
    });
    const polled = await pollSource(ctx, { sourceId });
    expect(polled.source.oauthExpiresAt).toBe('2026-09-21T09:00:00.000Z');
    expect((await getSource(ctx, sourceId)).oauthExpiresAt).toBe('2026-09-21T09:00:00.000Z');
    advance(2 * 3_600); // past the ORIGINAL expiry, inside the refreshed one
    transport.script(batch([], null));
    const still = await pollSource(ctx, { sourceId });
    expect(still.ingested).toBe(0);
  });

  it('re-registration (re-authorization) unblocks a lapsed grant', async () => {
    const ctx = member(tenantAuth);
    const sourceId = await registerSalesforce(tenantAuth, {
      providerAccountId: '00Dxx0000000002',
      oauthExpiresAt: '2026-09-14T09:00:00Z',
    });
    advance(2 * 3_600);
    await expectCode('source_authorization_expired', () => pollSource(ctx, { sourceId }));
    const reauthorized = await registerSource(ctx, {
      provider: 'salesforce',
      providerAccountId: '00Dxx0000000002',
      authKind: 'oauth',
      credentialRef: 'secret-store://salesforce/acme-v2',
      oauthScopes: ['crm.read'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    expect(reauthorized.created).toBe(false);
    transport.script(batch([rec('auth-2')], null));
    const polled = await pollSource(ctx, { sourceId });
    expect(polled.ingested).toBe(1);
  });

  it('credentials-authorized sources reject transport-reported grant expiries loudly', async () => {
    const ctx = member(tenantAuth);
    const { source } = await registerSource(ctx, {
      provider: 'salesforce',
      providerAccountId: '00Dxx0000000003',
      authKind: 'credentials',
      credentialRef: 'secret-store://salesforce/pure',
    });
    transport.script({
      records: [],
      nextCursor: null,
      hasMore: false,
      authorizationExpiresAt: '2027-01-01T00:00:00Z',
    });
    await expect(pollSource(ctx, { sourceId: source.id })).rejects.toThrow(/internal invariant violation/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation sweep
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it("another tenant's sources, checkpoints and operations are invisible", async () => {
    const ctxA = member(tenantIsolation);
    const sourceId = await registerSalesforce(tenantIsolation);
    transport.script(batch([rec('iso-1')], 'cursor-1'));
    await pollSource(ctxA, { sourceId });

    const b = member(tenantB);
    await expectCode('source_not_found', () => getSource(b, sourceId));
    await expectCode('source_not_found', () => pollSource(b, { sourceId }));
    await expectCode('source_not_found', () => getSourceCheckpoint(b, { sourceId }));
    await expectCode('source_not_found', () => listSourceCheckpoints(b, { sourceId }));
    await expectCode('source_not_found', () =>
      replaySource(b, { sourceId, fromStart: true }),
    );
    expect(await listSources(b, {})).toEqual([]);
    expect(await listObservations(b, { sourceKind: 'source', sourceId })).toEqual([]);

    // The wired transport is shared infrastructure; tenant A's poll under
    // tenant B's context never reaches it.
    const requestsBefore = transport.requests.length;
    await expectCode('source_not_found', () => pollSource(b, { sourceId }));
    expect(transport.requests.length).toBe(requestsBefore);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('the sources table rejects credentials rows with OAuth state (CHECK)', async () => {
    await expect(
      getDb().query(
        `INSERT INTO sources (
           tenant_id, provider, provider_account_id, auth_kind, credential_ref,
           oauth_scopes, oauth_expires_at, created_by
         ) VALUES ($1, 'jira', 'k', 'credentials', 'r', '["read"]'::jsonb, NULL, $2)`,
        [tenantStorage, member(tenantStorage).principalId],
      ),
    ).rejects.toThrow(/sources_credentials_have_no_oauth_state/);
  });

  it('the ingestion ledger is append-only with a one-way observation link', async () => {
    const ctx = member(tenantStorage);
    const sourceId = await registerSalesforce(tenantStorage);
    transport.script(batch([rec('st-1')], 'cursor-1'));
    await pollSource(ctx, { sourceId });

    const row = await getDb().query<{ id: string }>(
      `SELECT id FROM source_records WHERE tenant_id = $1 AND source_id = $2`,
      [tenantStorage, sourceId],
    );
    const ledgerId = row.rows[0]!.id;
    await expect(
      getDb().query(`UPDATE source_records SET claimed_at = now() WHERE id = $1`, [ledgerId]),
    ).rejects.toThrow(/append-only ingestion ledger/);
    await expect(
      getDb().query(`UPDATE source_records SET ingested_via = 'webhook' WHERE id = $1`, [ledgerId]),
    ).rejects.toThrow(/append-only ingestion ledger/);
    await expect(
      getDb().query(`DELETE FROM source_records WHERE id = $1`, [ledgerId]),
    ).rejects.toThrow(/append-only ingestion ledger/);
    await expect(getDb().query(`TRUNCATE source_records`)).rejects.toThrow(/append-only ingestion ledger/);
  });

  it('checkpoint history is append-only; checkpoints move only their cursor', async () => {
    const ctx = member(tenantStorage);
    const sourceId = await registerSalesforce(tenantStorage);
    transport.script(batch([rec('st-2')], 'cursor-1'));
    await pollSource(ctx, { sourceId });

    const history = await getDb().query<{ id: string }>(
      `SELECT id FROM source_checkpoint_history WHERE tenant_id = $1 AND source_id = $2`,
      [tenantStorage, sourceId],
    );
    const entryId = history.rows[0]!.id;
    await expect(
      getDb().query(`UPDATE source_checkpoint_history SET cursor = 'tampered' WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/append-only checkpoint audit/);
    await expect(
      getDb().query(`DELETE FROM source_checkpoint_history WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/append-only checkpoint audit/);

    const checkpoint = await getDb().query<{ id: string }>(
      `SELECT id FROM source_checkpoints WHERE tenant_id = $1 AND source_id = $2`,
      [tenantStorage, sourceId],
    );
    const checkpointId = checkpoint.rows[0]!.id;
    await expect(
      getDb().query(`DELETE FROM source_checkpoints WHERE id = $1`, [checkpointId]),
    ).rejects.toThrow(/live ingestion state/);
    await expect(
      getDb().query(`UPDATE source_checkpoints SET source_id = $1 WHERE id = $2`, [newId(), checkpointId]),
    ).rejects.toThrow(/live ingestion state/);
  });
});

// ---------------------------------------------------------------------------
// Crash recovery + serialization
// ---------------------------------------------------------------------------

describe('crash recovery and serialization', () => {
  it('an unlinked claim (crash between claim and observation) is re-observed on redelivery', async () => {
    const ctx = member(tenantRecovery);
    const sourceId = await registerSalesforce(tenantRecovery);
    // Simulate the crash window: a claimed record whose observation never
    // linked (written directly, exactly as the crashed pass would have left it).
    await getDb().query(
      `INSERT INTO source_records (
         tenant_id, source_id, provider_record_id, ingested_via, claimed_at
       ) VALUES ($1, $2, 'crash-1', 'polling', now())`,
      [tenantRecovery, sourceId],
    );
    transport.script(batch([rec('crash-1'), rec('crash-2')], null));
    const polled = await pollSource(ctx, { sourceId });
    expect(polled.fetched).toBe(2);
    expect(polled.ingested).toBe(2); // the crashed claim is recovered, the sibling ingested
    expect(polled.duplicates).toBe(0);
    const ledger = await getDb().query<{ provider_record_id: string; observation_id: string | null }>(
      `SELECT provider_record_id, observation_id FROM source_records
         WHERE tenant_id = $1 AND source_id = $2 ORDER BY provider_record_id`,
      [tenantRecovery, sourceId],
    );
    expect(ledger.rows.map((r) => r.observation_id !== null)).toEqual([true, true]);
    expect(await listObservations(ctx, { sourceKind: 'source', sourceId })).toHaveLength(2);
  });

  it('a concurrent ingestion pass on the same source fails explicitly', async () => {
    const ctx = member(tenantBusy);
    const sourceId = await registerSalesforce(tenantBusy);
    const lock = getLock();
    const key = `sources:ingest:${sourceId}`;
    const token = await lock.acquire(key, 5_000);
    expect(token).not.toBeNull();
    // The busy attempt fetches (fetch precedes the lock) but ingests nothing;
    // the retry re-fetches the same window.
    transport.script(batch([rec('busy-1')], null), batch([rec('busy-1')], null));
    try {
      await expectCode('ingestion_busy', () => pollSource(ctx, { sourceId }));
      expect(await listObservations(ctx, { sourceKind: 'source', sourceId })).toEqual([]);
    } finally {
      await lock.release(key, token!);
    }
    const retried = await pollSource(ctx, { sourceId });
    expect(retried.ingested).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Contract surface sanity
// ---------------------------------------------------------------------------

describe('contract surface', () => {
  it('exposes the transport port and no default transport is wired', async () => {
    // The beforeEach of each test wires a fresh scripted transport; the
    // afterEach unwinds it. Between tests the default state is "none".
    expect(getSourceTransport()).toBe(transport); // wired for THIS test
    setSourceTransport(null);
    expect(getSourceTransport()).toBeNull();
  });
});
