// Integration tests for the environment module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port, including the
// cross-module integrations with the world (W005), freshness (W006),
// observations (W004) and cognition (W013) contracts. Covers the W014
// acceptance — "company-specific external watchlists with entities, topics,
// geography, regulators, competitors, suppliers, freshness and escalation
// policy":
//
//  * COMPANY-SPECIFIC: watchlists/entries/signals/escalations are
//      tenant-scoped at every surface, with uniform not-found semantics
//      (no existence leaks), and the composite storage keys make
//      cross-tenant rows unrepresentable;
//  * THE THREE AXES: entity entries across the §12 vocabulary
//      (competitor/regulator/supplier/…), topic entries, geography
//      entries, plus geography/topic scoping and the immutable identity
//      rules;
//  * FRESHNESS: watch stale-after policies keyed under
//      'environment.watch' through the freshness contract (entry-specific
//      + kind default), evaluated current/aging/stale/unknown with the
//      staleness-escalation schedule;
//  * ESCALATION POLICY: the signal arm (immediate, floor-driven,
//      policy-snapshotted) and the staleness arm (the explicit pump:
//      fresh → unknown → disarmed → notDue → deduplicated accounting, one
//      escalation per episode, new-evidence re-arming), plus the
//      storage-level append-only guarantees.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as environmentContract from '../contract';
import { EnvironmentError } from '../errors';
import { getExecution, startExecution } from '@/modules/cognition/contract';
import { getFreshnessPolicy } from '@/modules/freshness/contract';
import { recordObservation } from '@/modules/observations/contract';
import { createEntity } from '@/modules/world/contract';
import { runMigrations } from '../../../../scripts/migrate';
import type { WatchEscalationPolicyInput } from '../types';

const {
  addWatchEntry,
  createWatchlist,
  escalateStaleWatches,
  evaluateWatchFreshness,
  getWatchEscalation,
  getWatchEntry,
  getWatchSignal,
  getWatchlist,
  listWatchEntries,
  listWatchEscalations,
  listWatchSignals,
  listWatchlists,
  recordWatchSignal,
  resolveWatchFreshnessPolicy,
  setWatchEntryStatus,
  setWatchFreshnessPolicy,
  setWatchlistStatus,
  updateWatchEntry,
  updateWatchlist,
  WATCH_SUBJECT_KIND,
} = environmentContract;

// Dedicated tenants keep each concern's data (and freshness policies!)
// isolated from the others, so every assertion below sees only what it
// created itself.
const tenantA = newId();
const tenantB = newId();
const tenantEntries = newId();
const tenantWorld = newId();
const tenantFresh = newId();
const tenantEval = newId();
const tenantSignal = newId();
const tenantPump = newId();
const tenantFilters = newId();
const tenantStorage = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** A minimal valid escalation policy, parameterized on the load-bearing fields. */
function policy(overrides: Partial<WatchEscalationPolicyInput> = {}): WatchEscalationPolicyInput {
  return {
    signalSeverityFloor: 'medium',
    staleGraceSeconds: 3600,
    staleSeverity: 'high',
    notifyParties: [{ kind: 'person', label: 'coo' }],
    proposeMission: true,
    ...overrides,
  };
}

async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof EnvironmentError) {
      expect(error.code).toBe(code);
      return;
    }
    throw new Error(`expected EnvironmentError('${code}'), got: ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error(`expected EnvironmentError('${code}'), but nothing was thrown`);
}

/** One observation seeded through the observations contract (the evidence path). */
async function seedObservation(ctx: TenantContext, observedAt: string): Promise<string> {
  const recorded = await recordObservation(ctx, {
    kind: 'external.signal',
    payload: { headline: 'watch fixture' },
    observedAt,
    source: { kind: 'external', label: 'watch-fixture' },
    channel: 'ingestion',
    confidence: { value: 0.9, method: 'source_trust' },
  });
  return recorded.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', async () => {
    // There is deliberately no deleteWatchlist/deleteWatchEntry, no
    // updateWatchSignal, no updateWatchEscalation: signals/escalations
    // are append-only; watchlists/entries retire via status.
    expect(Object.keys(environmentContract).sort()).toEqual([
      'DEFAULT_LIST_LIMIT',
      'DEFAULT_PUMP_LIMIT',
      'ESCALATION_TRIGGERS',
      'EnvironmentError',
      'MAX_LIST_LIMIT',
      'MAX_NAME_LENGTH',
      'MAX_NOTE_LENGTH',
      'MAX_NOTIFY_PARTIES',
      'MAX_PARTY_LABEL_LENGTH',
      'MAX_PUMP_LIMIT',
      'MAX_SCOPES',
      'MAX_STALE_GRACE_SECONDS',
      'MAX_SUMMARY_LENGTH',
      'WATCHLIST_STATUSES',
      'WATCH_ENTITY_KINDS',
      'WATCH_ENTRY_KINDS',
      'WATCH_ENTRY_STATUSES',
      'WATCH_PARTY_KINDS',
      'WATCH_SEVERITIES',
      'WATCH_SUBJECT_KIND',
      'addWatchEntry',
      'createWatchlist',
      'escalateStaleWatches',
      'escapeLike',
      'evaluateWatchFreshness',
      'getWatchEntry',
      'getWatchEscalation',
      'getWatchSignal',
      'getWatchlist',
      'isEscalationTrigger',
      'isStaleEpisodeEscalated',
      'isUuid',
      'isWatchEntityKind',
      'isWatchEntryKind',
      'isWatchEntryStatus',
      'isWatchPartyKind',
      'isWatchSeverity',
      'isWatchlistStatus',
      'listWatchEntries',
      'listWatchEscalations',
      'listWatchSignals',
      'listWatchlists',
      'recordWatchSignal',
      'resolveEscalationPolicy',
      'resolveWatchFreshnessPolicy',
      'setWatchEntryStatus',
      'setWatchFreshnessPolicy',
      'setWatchlistStatus',
      'severitiesAtOrAbove',
      'severityMeetsFloor',
      'severityRank',
      'signalEscalationSummary',
      'staleEscalationSummary',
      'stalenessDue',
      'stalenessSchedule',
      'updateWatchEntry',
      'updateWatchlist',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

describe('watchlists', () => {
  it('creates, gets and lists with derived entry counts', async () => {
    const ctx = member(tenantA);
    const created = await createWatchlist(ctx, {
      name: 'EU Regulatory Watch',
      description: 'Regulatory movements that touch us',
      escalationPolicy: policy(),
    });
    expect(created.status).toBe('active');
    expect(created.entryCounts).toEqual({ active: 0, paused: 0, archived: 0 });
    expect(created.escalationPolicy.signalSeverityFloor).toBe('medium');
    expect(created.createdBy).toBe(ctx.principalId);

    await addWatchEntry(ctx, {
      watchlistId: created.id,
      kind: 'entity',
      entityKind: 'regulator',
      name: 'EBA',
    });
    await addWatchEntry(ctx, {
      watchlistId: created.id,
      kind: 'topic',
      name: 'AI regulation',
    });
    const paused = await addWatchEntry(ctx, {
      watchlistId: created.id,
      kind: 'entity',
      entityKind: 'law',
      name: 'EU AI Act',
    });
    await setWatchEntryStatus(ctx, { watchEntryId: paused.id, status: 'paused' });

    const got = await getWatchlist(ctx, { watchlistId: created.id });
    expect(got.entryCounts).toEqual({ active: 2, paused: 1, archived: 0 });

    const listed = await listWatchlists(ctx, { search: 'regulat' });
    expect(listed.map((list) => list.name)).toContain('EU Regulatory Watch');
    expect(await listWatchlists(ctx, { status: 'archived' })).toEqual([]);
  });

  it('rejects duplicate names within one tenant, allows them across tenants', async () => {
    const ctx = member(tenantA);
    await createWatchlist(ctx, { name: 'Competitive Landscape', escalationPolicy: policy() });
    await expectCode('watchlist_name_conflict', () =>
      createWatchlist(ctx, { name: 'Competitive Landscape', escalationPolicy: policy() }),
    );
    // the same name in another tenant is a different programme
    const foreign = await createWatchlist(member(tenantB), {
      name: 'Competitive Landscape',
      escalationPolicy: policy(),
    });
    expect(foreign.tenantId).toBe(tenantB);
  });

  it('updates name/description/policy wholesale and flips status reversibly', async () => {
    const ctx = member(tenantA);
    const created = await createWatchlist(ctx, {
      name: 'Supply Chain Watch',
      escalationPolicy: policy({ signalSeverityFloor: 'low' }),
    });
    const updated = await updateWatchlist(ctx, {
      watchlistId: created.id,
      name: 'Supply Chain & Tariffs',
      description: 'tariffs, shipping, suppliers',
      escalationPolicy: policy({ signalSeverityFloor: 'critical', staleGraceSeconds: null, staleSeverity: null }),
    });
    expect(updated.name).toBe('Supply Chain & Tariffs');
    expect(updated.escalationPolicy.signalSeverityFloor).toBe('critical');
    expect(updated.escalationPolicy.staleGraceSeconds).toBeNull();

    const cleared = await updateWatchlist(ctx, {
      watchlistId: created.id,
      description: null,
    });
    expect(cleared.description).toBeNull();

    const archived = await setWatchlistStatus(ctx, {
      watchlistId: created.id,
      status: 'archived',
    });
    expect(archived.status).toBe('archived');
    await expectCode('watchlist_status_conflict', () =>
      setWatchlistStatus(ctx, { watchlistId: created.id, status: 'archived' }),
    );
    const reactivated = await setWatchlistStatus(ctx, {
      watchlistId: created.id,
      status: 'active',
    });
    expect(reactivated.status).toBe('active');
  });

  it('an archived list accepts no new entries', async () => {
    const ctx = member(tenantA);
    const created = await createWatchlist(ctx, {
      name: 'Dormant Watch',
      escalationPolicy: policy(),
    });
    await setWatchlistStatus(ctx, { watchlistId: created.id, status: 'archived' });
    await expectCode('watchlist_archived', () =>
      addWatchEntry(ctx, {
        watchlistId: created.id,
        kind: 'topic',
        name: 'anything',
      }),
    );
  });

  it('is tenant-isolated with uniform not-found semantics', async () => {
    const ctx = member(tenantA);
    const created = await createWatchlist(ctx, {
      name: 'Isolation Fixture',
      escalationPolicy: policy(),
    });
    const foreign = member(tenantB);
    await expectCode('watchlist_not_found', () =>
      getWatchlist(foreign, { watchlistId: created.id }),
    );
    await expectCode('watchlist_not_found', () =>
      updateWatchlist(foreign, { watchlistId: created.id, name: 'stolen' }),
    );
    await expectCode('watchlist_not_found', () =>
      setWatchlistStatus(foreign, { watchlistId: created.id, status: 'archived' }),
    );
    // and the other tenant's list feed never shows tenant A's programme
    // (tenantB carries its own fixtures from earlier tests — only absence
    // of tenant A's programme is asserted)
    const foreignFeed = await listWatchlists(foreign, {});
    expect(foreignFeed.map((list) => list.id)).not.toContain(created.id);
    expect(foreignFeed.every((list) => list.tenantId === tenantB)).toBe(true);
    expect(await getWatchlist(ctx, { watchlistId: created.id })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Watch entries — the three axes
// ---------------------------------------------------------------------------

describe('watch entries (entities, topics, geography)', () => {
  it('creates entries across the §12 entity vocabulary with scoping and bindings', async () => {
    const ctx = member(tenantEntries);
    const list = await createWatchlist(ctx, {
      name: 'Full Spectrum',
      escalationPolicy: policy(),
    });
    for (const entityKind of [
      'competitor',
      'regulator',
      'government_body',
      'supplier',
      'law',
      'technology',
      'market',
      'industry',
    ] as const) {
      const entry = await addWatchEntry(ctx, {
        watchlistId: list.id,
        kind: 'entity',
        entityKind,
        name: `watched ${entityKind}`,
        geographies: ['EU'],
      });
      expect(entry.entityKind).toBe(entityKind);
      expect(entry.kind).toBe('entity');
      expect(entry.resolvedEscalationPolicy.source).toBe('watchlist');
    }
    const topic = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'topic',
      name: 'AI regulation',
      geographies: ['EU', 'US'],
      topics: ['drafts'],
    });
    expect(topic.geographies).toEqual(['EU', 'US']);
    const geography = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'geography',
      name: 'European Union',
      topics: ['ai-regulation'],
    });
    expect(geography.geographies).toEqual([]);
  });

  it('binds entries to world entities validated through the world contract (uniform, no leak)', async () => {
    const ctx = member(tenantWorld);
    const list = await createWatchlist(ctx, {
      name: 'World-bound watch',
      escalationPolicy: policy(),
    });
    const worldEntity = await createEntity(ctx, {
      kind: 'competitor',
      name: 'Acme Corp',
      description: 'The competitor we watch closest',
    });
    const bound = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme Corp',
      worldEntityId: worldEntity.id,
    });
    expect(bound.worldEntityId).toBe(worldEntity.id);

    // a foreign-tenant world entity is indistinguishable from a missing one
    const foreignEntity = await createEntity(member(tenantB), {
      kind: 'competitor',
      name: 'Foreign Competitor',
    });
    await expectCode('invalid_world_ref', () =>
      addWatchEntry(ctx, {
        watchlistId: list.id,
        kind: 'entity',
        entityKind: 'competitor',
        name: 'Foreign Competitor',
        worldEntityId: foreignEntity.id,
      }),
    );
    await expectCode('invalid_world_ref', () =>
      addWatchEntry(ctx, {
        watchlistId: list.id,
        kind: 'entity',
        entityKind: 'competitor',
        name: 'Ghost',
        worldEntityId: newId(),
      }),
    );
    // re-binding and clearing are legal updates
    const other = await createEntity(ctx, { kind: 'competitor', name: 'Beta Ltd' });
    const rebound = await updateWatchEntry(ctx, {
      watchEntryId: bound.id,
      worldEntityId: other.id,
    });
    expect(rebound.worldEntityId).toBe(other.id);
    const cleared = await updateWatchEntry(ctx, {
      watchEntryId: bound.id,
      worldEntityId: null,
    });
    expect(cleared.worldEntityId).toBeNull();
  });

  it('rejects identity collisions within one watchlist, allows them across lists', async () => {
    const ctx = member(tenantEntries);
    const listA = await createWatchlist(ctx, { name: 'List A', escalationPolicy: policy() });
    const listB = await createWatchlist(ctx, { name: 'List B', escalationPolicy: policy() });
    await addWatchEntry(ctx, {
      watchlistId: listA.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme',
    });
    await expectCode('watch_entry_conflict', () =>
      addWatchEntry(ctx, {
        watchlistId: listA.id,
        kind: 'entity',
        entityKind: 'competitor',
        name: 'Acme',
      }),
    );
    // same name + different entity kind = a different watched subject
    await addWatchEntry(ctx, {
      watchlistId: listA.id,
      kind: 'entity',
      entityKind: 'supplier',
      name: 'Acme',
    });
    // the same subject in another list is fine (independent programmes)
    await addWatchEntry(ctx, {
      watchlistId: listB.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme',
    });
    // renaming into a collision is a conflict too — a topic entry collides
    // with another TOPIC (kinds differ from the entity 'Acme' above)
    const entry = await addWatchEntry(ctx, {
      watchlistId: listA.id,
      kind: 'topic',
      name: 'Unique topic',
    });
    await addWatchEntry(ctx, {
      watchlistId: listA.id,
      kind: 'topic',
      name: 'Occupied topic',
    });
    await updateWatchEntry(ctx, { watchEntryId: entry.id, name: 'Renamed topic' });
    await expectCode('watch_entry_conflict', () =>
      updateWatchEntry(ctx, { watchEntryId: entry.id, name: 'Occupied topic' }),
    );
  });

  it('updates mutable scoping and per-entry policy overrides; identity stays immutable', async () => {
    const ctx = member(tenantEntries);
    const list = await createWatchlist(ctx, { name: 'Update Fixture', escalationPolicy: policy() });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Gamma',
      geographies: ['EU'],
    });
    const updated = await updateWatchEntry(ctx, {
      watchEntryId: entry.id,
      name: 'Gamma Holdings',
      geographies: ['EU', 'APAC'],
      topics: ['pricing'],
      escalationPolicy: policy({ signalSeverityFloor: 'critical' }),
    });
    expect(updated.name).toBe('Gamma Holdings');
    expect(updated.geographies).toEqual(['APAC', 'EU']);
    expect(updated.escalationPolicy?.signalSeverityFloor).toBe('critical');
    expect(updated.resolvedEscalationPolicy.source).toBe('entry');
    expect(updated.resolvedEscalationPolicy.policy.signalSeverityFloor).toBe('critical');

    // clearing the override falls back to the watchlist default
    const inherited = await updateWatchEntry(ctx, {
      watchEntryId: entry.id,
      escalationPolicy: null,
    });
    expect(inherited.escalationPolicy).toBeNull();
    expect(inherited.resolvedEscalationPolicy.source).toBe('watchlist');
    expect(inherited.resolvedEscalationPolicy.policy.signalSeverityFloor).toBe('medium');

    // geography entries cannot gain geographies via update
    const geo = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'geography',
      name: 'APAC',
    });
    await expectCode('invalid_watch_entry_input', () =>
      updateWatchEntry(ctx, { watchEntryId: geo.id, geographies: ['JP'] }),
    );

    // lifecycle: pause and archive are reversible control transitions
    const paused = await setWatchEntryStatus(ctx, { watchEntryId: entry.id, status: 'paused' });
    expect(paused.status).toBe('paused');
    await expectCode('watch_entry_status_conflict', () =>
      setWatchEntryStatus(ctx, { watchEntryId: entry.id, status: 'paused' }),
    );
    const active = await setWatchEntryStatus(ctx, { watchEntryId: entry.id, status: 'active' });
    expect(active.status).toBe('active');
  });

  it('lists entries with every filter, and stays tenant-isolated', async () => {
    // a dedicated tenant: earlier fixtures in shared tenants would match
    // the unscoped geography/topic/search filters
    const ctx = member(tenantFilters);
    const list = await createWatchlist(ctx, { name: 'Filter Fixture', escalationPolicy: policy() });
    const competitor = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Delta Corp',
      geographies: ['EU'],
      topics: ['pricing'],
      description: 'discounts heavyweight',
    });
    await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'regulator',
      name: 'FINMA',
      geographies: ['CH'],
    });
    await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'topic',
      name: 'tariffs',
      geographies: ['US'],
    });

    expect((await listWatchEntries(ctx, { watchlistId: list.id })).length).toBe(3);
    expect(
      (await listWatchEntries(ctx, { watchlistId: list.id, kind: 'entity', entityKind: 'competitor' })).map((e) => e.name),
    ).toEqual(['Delta Corp']);
    expect((await listWatchEntries(ctx, { geography: 'CH' })).map((e) => e.name)).toEqual(['FINMA']);
    expect((await listWatchEntries(ctx, { topic: 'pricing' })).map((e) => e.name)).toEqual(['Delta Corp']);
    expect((await listWatchEntries(ctx, { search: 'discount' })).map((e) => e.name)).toEqual(['Delta Corp']);
    expect((await listWatchEntries(ctx, { watchlistId: list.id, status: 'paused' }))).toEqual([]);

    // tenant isolation
    const foreign = member(tenantB);
    await expectCode('watch_entry_not_found', () =>
      getWatchEntry(foreign, { watchEntryId: competitor.id }),
    );
    await expectCode('watch_entry_not_found', () =>
      updateWatchEntry(foreign, { watchEntryId: competitor.id, name: 'stolen' }),
    );
    await expectCode('watch_entry_not_found', () =>
      setWatchEntryStatus(foreign, { watchEntryId: competitor.id, status: 'archived' }),
    );
    expect(await listWatchEntries(foreign, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Freshness wiring (W006 — subject kind 'environment.watch')
// ---------------------------------------------------------------------------

describe('watch freshness policies and evaluation (W006 wiring)', () => {
  it('keys entry-specific and default policies under the watch subject kind', async () => {
    const ctx = member(tenantFresh);
    const list = await createWatchlist(ctx, { name: 'Fresh Fixture', escalationPolicy: policy() });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme',
    });

    // entry-specific policy — visible through the FRESHNESS contract
    const specific = await setWatchFreshnessPolicy(ctx, {
      watchEntryId: entry.id,
      staleAfterSeconds: 600,
      agingAfterSeconds: 300,
      note: 'competitors move fast',
    });
    expect(specific.subjectKind).toBe(WATCH_SUBJECT_KIND);
    expect(specific.subjectId).toBe(entry.id);
    const viaFreshness = await getFreshnessPolicy(ctx, {
      subjectKind: WATCH_SUBJECT_KIND,
      subjectId: entry.id,
    });
    expect(viaFreshness?.staleAfterSeconds).toBe(600);

    // the kind default (no entry id)
    const kindDefault = await setWatchFreshnessPolicy(ctx, { staleAfterSeconds: 86_400 });
    expect(kindDefault.subjectId).toBeNull();
    expect(kindDefault.subjectKind).toBe(WATCH_SUBJECT_KIND);

    // resolution: exact first, then default
    expect((await resolveWatchFreshnessPolicy(ctx, { watchEntryId: entry.id }))?.staleAfterSeconds).toBe(600);
    const other = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'topic',
      name: 'something else',
    });
    expect((await resolveWatchFreshnessPolicy(ctx, { watchEntryId: other.id }))?.staleAfterSeconds).toBe(86_400);

    // a specific policy must reference an existing entry (uniform, no leak)
    const foreignList = await createWatchlist(member(tenantB), {
      name: 'Foreign',
      escalationPolicy: policy(),
    });
    const foreignEntry = await addWatchEntry(member(tenantB), {
      watchlistId: foreignList.id,
      kind: 'topic',
      name: 'foreign topic',
    });
    await expectCode('watch_entry_not_found', () =>
      setWatchFreshnessPolicy(ctx, { watchEntryId: foreignEntry.id, staleAfterSeconds: 60 }),
    );
    await expectCode('watch_entry_not_found', () =>
      resolveWatchFreshnessPolicy(ctx, { watchEntryId: foreignEntry.id }),
    );
  });

  it('evaluates current/aging/stale/unknown with the escalation schedule', async () => {
    // a dedicated tenant: the kind-default policy set by the earlier test
    // must not leak into this test's no-policy case
    const ctx = member(tenantEval);
    const list = await createWatchlist(ctx, { name: 'Eval Fixture', escalationPolicy: policy() });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'regulator',
      name: 'EBA',
    });

    // unknown: no policy and no evidence yet
    const nothing = await evaluateWatchFreshness(ctx, { watchEntryId: entry.id });
    expect(nothing.status).toBe('unknown');
    expect(nothing.ageSeconds).toBeNull();
    expect(nothing.policy).toBeNull();
    expect(nothing.latestSignalId).toBeNull();

    // policy but still no evidence: still unknown (never-observed ≠ stale)
    await setWatchFreshnessPolicy(ctx, {
      watchEntryId: entry.id,
      staleAfterSeconds: 600,
      agingAfterSeconds: 300,
    });
    const noEvidence = await evaluateWatchFreshness(ctx, { watchEntryId: entry.id });
    expect(noEvidence.status).toBe('unknown');

    // evidence lands (observed 100s before the fixed evaluation instant)
    const asOf = '2026-09-14T12:00:00Z';
    const observationId = await seedObservation(ctx, '2026-09-14T11:58:20Z');
    await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId,
      severity: 'low', // below the watchlist floor — no escalation here
    });

    const fresh = await evaluateWatchFreshness(ctx, { watchEntryId: entry.id, asOf });
    expect(fresh.status).toBe('current'); // 100s < 300s aging threshold → current
    expect(fresh.ageSeconds).toBeCloseTo(100, 3);
    expect(fresh.latestObservedAt).toBe('2026-09-14T11:58:20.000Z');
    expect(fresh.escalationPolicy.source).toBe('watchlist');
    expect(fresh.escalationDueAt).toBe('2026-09-14T13:08:20.000Z'); // +600s stale +3600s grace

    const aging = await evaluateWatchFreshness(ctx, {
      watchEntryId: entry.id,
      asOf: '2026-09-14T12:05:00Z', // 400s old: aging
    });
    expect(aging.status).toBe('aging');

    const notYetStale = await evaluateWatchFreshness(ctx, {
      watchEntryId: entry.id,
      asOf: '2026-09-14T12:08:20Z', // exactly 600s old: strict boundary → current/aging, NOT stale
    });
    expect(notYetStale.status).not.toBe('stale');

    const stale = await evaluateWatchFreshness(ctx, {
      watchEntryId: entry.id,
      asOf: '2026-09-14T13:00:00Z', // 3700s old: stale, 3100s past boundary
    });
    expect(stale.status).toBe('stale');
    expect(stale.staleSince).toBe('2026-09-14T12:08:20.000Z');
    expect(stale.staleForSeconds).toBeCloseTo(3100, 3);
    expect(stale.staleEscalationRecorded).toBe(false);
    expect(stale.escalationDueAt).toBe('2026-09-14T13:08:20.000Z');

    // tenant isolation on evaluation
    await expectCode('watch_entry_not_found', () =>
      evaluateWatchFreshness(member(tenantB), { watchEntryId: entry.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Signals + the signal escalation arm
// ---------------------------------------------------------------------------

describe('recordWatchSignal (evidence-linked hits)', () => {
  it('links observations through the observations contract and fires the floor', async () => {
    const ctx = member(tenantSignal);
    const list = await createWatchlist(ctx, {
      name: 'Signal Fixture',
      escalationPolicy: policy({ signalSeverityFloor: 'medium' }),
    });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme',
    });
    const observationId = await seedObservation(ctx, '2026-09-14T10:00:00Z');

    // below the floor: recorded, no escalation
    const quiet = await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId,
      severity: 'low',
      note: 'minor pricing tweak',
    });
    expect(quiet.signal.escalated).toBe(false);
    expect(quiet.escalation).toBeNull();
    // denormalized from the observation (.000Z — the format instants round-trip in)
    expect(quiet.signal.observedAt).toBe('2026-09-14T10:00:00.000Z');
    expect(quiet.signal.recordedBy).toBe(ctx.principalId);

    // at the floor (inclusive): escalates immediately with the snapshot
    const loud = await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId: await seedObservation(ctx, '2026-09-14T11:00:00Z'),
      severity: 'medium',
      note: 'flagship product discontinued',
      originExecutionId: (
        await startExecution(ctx, {
          trigger: { kind: 'system', label: 'W014 fixture' },
          focus: { topics: ['competitors'], entities: [] },
          actor: { kind: 'system', label: 'aurum-cognition' },
          rationale: 'W014 fixture',
        })
      ).id,
    });
    expect(loud.signal.escalated).toBe(true);
    expect(loud.escalation?.trigger).toBe('signal');
    expect(loud.escalation?.severity).toBe('medium');
    expect(loud.escalation?.signalId).toBe(loud.signal.id);
    expect(loud.escalation?.summary).toBe('flagship product discontinued');
    expect(loud.escalation?.policySnapshot.source).toBe('watchlist');
    expect(loud.escalation?.policySnapshot.policy.signalSeverityFloor).toBe('medium');
    expect(loud.signal.escalationId).toBe(loud.escalation?.id);
    // the denormalized execution linkage round-trips
    const signal = await getWatchSignal(ctx, { watchSignalId: loud.signal.id });
    expect(signal.originExecutionId).not.toBeNull();
    expect(signal.escalationId).toBe(loud.escalation?.id);
  });

  it('dedupes per (entry, observation) — one signal ever, across entries is fine', async () => {
    const ctx = member(tenantSignal);
    const list = await createWatchlist(ctx, { name: 'Dedupe Fixture', escalationPolicy: policy() });
    const entryA = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme',
    });
    const entryB = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'topic',
      name: 'pricing wars',
    });
    const observationId = await seedObservation(ctx, '2026-09-14T10:00:00Z');
    await recordWatchSignal(ctx, { watchEntryId: entryA.id, observationId, severity: 'low' });
    await expectCode('signal_conflict', () =>
      recordWatchSignal(ctx, { watchEntryId: entryA.id, observationId, severity: 'critical' }),
    );
    // the same observation hitting a different entry is a different signal
    const other = await recordWatchSignal(ctx, {
      watchEntryId: entryB.id,
      observationId,
      severity: 'low',
    });
    expect(other.signal.watchEntryId).toBe(entryB.id);
  });

  it('validates the observation and execution references (uniform, no leak)', async () => {
    const ctx = member(tenantSignal);
    const list = await createWatchlist(ctx, { name: 'Ref Fixture', escalationPolicy: policy() });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'topic',
      name: 'ref target',
    });
    await expectCode('invalid_observation_ref', () =>
      recordWatchSignal(ctx, {
        watchEntryId: entry.id,
        observationId: newId(),
        severity: 'low',
      }),
    );
    const foreignObservation = await seedObservation(member(tenantB), '2026-09-14T10:00:00Z');
    await expectCode('invalid_observation_ref', () =>
      recordWatchSignal(ctx, {
        watchEntryId: entry.id,
        observationId: foreignObservation,
        severity: 'low',
      }),
    );
    const observationId = await seedObservation(ctx, '2026-09-14T10:00:00Z');
    const foreignExecution = await startExecution(member(tenantB), {
      trigger: { kind: 'system', label: 'foreign' },
      focus: { topics: ['x'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await expectCode('invalid_execution_ref', () =>
      recordWatchSignal(ctx, {
        watchEntryId: entry.id,
        observationId,
        severity: 'low',
        originExecutionId: foreignExecution.id,
      }),
    );
    // a valid execution is accepted and readable through the cognition contract
    const execution = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'W014 fixture' },
      focus: { topics: ['x'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    const ok = await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId,
      severity: 'low',
      originExecutionId: execution.id,
    });
    expect(ok.signal.originExecutionId).toBe(execution.id);
    await expect(getExecution(ctx, { executionId: execution.id })).toBeDefined();
  });

  it('only ACTIVE entries on ACTIVE lists collect signals', async () => {
    const ctx = member(tenantSignal);
    const list = await createWatchlist(ctx, { name: 'Inactive Fixture', escalationPolicy: policy() });
    const pausedEntry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'topic',
      name: 'paused target',
    });
    await setWatchEntryStatus(ctx, { watchEntryId: pausedEntry.id, status: 'paused' });
    await expectCode('watch_entry_inactive', async () =>
      recordWatchSignal(ctx, {
        watchEntryId: pausedEntry.id,
        observationId: await seedObservation(ctx, '2026-09-14T10:00:00Z'),
        severity: 'low',
      }),
    );

    const dormantList = await createWatchlist(ctx, {
      name: 'Dormant Signal Fixture',
      escalationPolicy: policy(),
    });
    const entry = await addWatchEntry(ctx, {
      watchlistId: dormantList.id,
      kind: 'topic',
      name: 'dormant target',
    });
    await setWatchlistStatus(ctx, { watchlistId: dormantList.id, status: 'archived' });
    await expectCode('watch_entry_inactive', async () =>
      recordWatchSignal(ctx, {
        watchEntryId: entry.id,
        observationId: await seedObservation(ctx, '2026-09-14T10:00:00Z'),
        severity: 'low',
      }),
    );
  });

  it('lists signals with watchlist/entry/severity filters; tenant isolation', async () => {
    const ctx = member(tenantSignal);
    const list = await createWatchlist(ctx, { name: 'List Fixture', escalationPolicy: policy() });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'topic',
      name: 'filter target',
    });
    const low = await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId: await seedObservation(ctx, '2026-09-14T10:00:00Z'),
      severity: 'low',
    });
    const critical = await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId: await seedObservation(ctx, '2026-09-14T10:05:00Z'),
      severity: 'critical',
    });
    const all = await listWatchSignals(ctx, { watchlistId: list.id });
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe(critical.signal.id); // newest first
    expect((await listWatchSignals(ctx, { minSeverity: 'high' })).map((s) => s.id)).toEqual([
      critical.signal.id,
    ]);
    expect((await listWatchSignals(ctx, { watchEntryId: entry.id, minSeverity: 'high' })).length).toBe(1);
    expect((await listWatchSignals(ctx, { watchEntryId: entry.id, minSeverity: 'low' })).length).toBe(2);

    await expectCode('watch_signal_not_found', () =>
      getWatchSignal(member(tenantB), { watchSignalId: low.signal.id }),
    );
    expect(await listWatchSignals(member(tenantB), {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The staleness arm — escalateStaleWatches (the explicit pump)
// ---------------------------------------------------------------------------

describe('escalateStaleWatches (the staleness arm pump)', () => {
  // The pump evaluates at the service clock; a controllable clock makes
  // the schedule deterministic (the notifications/sources test precedent).
  let clockMs = 0;
  const BASE = Date.parse('2026-09-14T12:00:00Z');

  beforeAll(() => {
    clockMs = BASE;
    vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  async function fixture(overrides: {
    staleAfterSeconds?: number;
    escalationPolicy?: WatchEscalationPolicyInput;
    observedAt?: string | null;
    withPolicy?: boolean;
  }) {
    const ctx = member(tenantPump);
    const list = await createWatchlist(ctx, {
      name: `Pump ${newId()}`,
      escalationPolicy:
        overrides.escalationPolicy ??
        policy({ staleGraceSeconds: 600, staleSeverity: 'high' }),
    });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: `watched ${newId()}`,
    });
    if (overrides.withPolicy !== false) {
      await setWatchFreshnessPolicy(ctx, {
        watchEntryId: entry.id,
        staleAfterSeconds: overrides.staleAfterSeconds ?? 600,
      });
    }
    if (overrides.observedAt !== null && overrides.observedAt !== undefined) {
      await recordWatchSignal(ctx, {
        watchEntryId: entry.id,
        observationId: await seedObservation(ctx, overrides.observedAt),
        severity: 'low',
      });
    }
    return { ctx, list, entry };
  }

  it('accounts fresh, unknown, disarmed, notDue skips without recording anything', async () => {
    // fresh: evidence 100s old, stale after 600s
    const fresh = await fixture({ observedAt: '2026-09-14T11:58:20Z' });
    // unknown: policy but never any evidence
    const unknown = await fixture({ observedAt: null });
    // unknown: evidence but no policy
    const noPolicy = await fixture({
      observedAt: '2026-09-14T06:00:00Z',
      withPolicy: false,
    });
    // disarmed: stale but the policy disarms the staleness arm
    const disarmed = await fixture({
      observedAt: '2026-09-14T06:00:00Z',
      escalationPolicy: policy({ staleGraceSeconds: null, staleSeverity: null }),
    });
    // not due: stale since 11:55, grace 600s → due at 12:05, now is 12:00
    const notDue = await fixture({ observedAt: '2026-09-14T11:45:00Z' });

    const run = await escalateStaleWatches(member(tenantPump), {});
    expect(run.considered).toBeGreaterThanOrEqual(5);
    expect(run.recorded).toEqual([]);
    expect(run.counts.fresh).toBeGreaterThanOrEqual(1);
    expect(run.counts.unknown).toBeGreaterThanOrEqual(2);
    expect(run.counts.disarmed).toBeGreaterThanOrEqual(1);
    expect(run.counts.notDue).toBeGreaterThanOrEqual(1);
    expect(run.counts.deduplicated).toBe(0);
    // considered = fresh + unknown + disarmed + notDue + deduplicated + recorded
    expect(
      run.considered,
    ).toBe(
      run.counts.fresh +
        run.counts.unknown +
        run.counts.disarmed +
        run.counts.notDue +
        run.counts.deduplicated +
        run.recorded.length,
    );
    void fresh;
    void unknown;
    void noPolicy;
    void disarmed;
    void notDue;
  });

  it('records a stale escalation when due, with severity/snapshot/summary', async () => {
    // stale after 600s, grace 600s: observed at 10:00, due at 11:10 — now 12:00
    const { ctx, entry } = await fixture({ observedAt: '2026-09-14T10:00:00Z' });
    const run = await escalateStaleWatches(ctx, {});
    expect(run.recorded.length).toBe(1);
    const escalation = run.recorded[0]!;
    expect(escalation.trigger).toBe('stale');
    expect(escalation.severity).toBe('high'); // the policy's staleSeverity
    expect(escalation.signalId).toBeNull();
    expect(escalation.policySnapshot.policy.staleGraceSeconds).toBe(600);
    expect(escalation.policySnapshot.policy.proposeMission).toBe(true);
    expect(escalation.summary).toContain('2026-09-14T10:00:00.000Z');
    expect(escalation.recordedBy).toBe(ctx.principalId);

    // the evaluation now reports the episode as escalated
    const evaluation = await evaluateWatchFreshness(ctx, { watchEntryId: entry.id });
    expect(evaluation.status).toBe('stale');
    expect(evaluation.staleEscalationRecorded).toBe(true);
  });

  it('deduplicates per episode and re-arms on fresh evidence', async () => {
    const { ctx, list, entry } = await fixture({ observedAt: '2026-09-14T10:00:00Z' });
    // every pass scoped to this fixture's list: earlier pump fixtures in
    // the shared tenant must not pollute the counts
    const scope = { watchlistId: list.id };

    // first pass records
    const first = await escalateStaleWatches(ctx, scope);
    expect(first.recorded.length).toBe(1);
    // second pass: same episode → deduplicated
    const second = await escalateStaleWatches(ctx, scope);
    expect(second.recorded.length).toBe(0);
    expect(second.counts.deduplicated).toBe(1);

    // fresh evidence re-anchors the episode: not stale anymore
    await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId: await seedObservation(ctx, '2026-09-14T11:55:00Z'),
      severity: 'low',
    });
    const freshRun = await escalateStaleWatches(ctx, scope);
    expect(freshRun.recorded.length).toBe(0);
    expect(freshRun.counts.fresh).toBe(1);

    // time advances past the new episode's due instant (11:55 + 600 + 600 = 12:15)
    clockMs = Date.parse('2026-09-14T12:20:00Z');
    try {
      const third = await escalateStaleWatches(ctx, scope);
      expect(third.recorded.length).toBe(1); // a NEW episode escalates again
      const escalations = await listWatchEscalations(ctx, {
        watchEntryId: entry.id,
        trigger: 'stale',
      });
      expect(escalations.length).toBe(2);
    } finally {
      clockMs = BASE;
    }
  });

  it('skips paused entries and entries on archived lists; scopes to a watchlist', async () => {
    const { ctx, list, entry } = await fixture({ observedAt: '2026-09-14T10:00:00Z' });
    await setWatchEntryStatus(ctx, { watchEntryId: entry.id, status: 'paused' });
    const pausedRun = await escalateStaleWatches(ctx, { watchlistId: list.id });
    expect(pausedRun.considered).toBe(0);
    expect(pausedRun.recorded).toEqual([]);

    await setWatchEntryStatus(ctx, { watchEntryId: entry.id, status: 'active' });
    await setWatchlistStatus(ctx, { watchlistId: list.id, status: 'archived' });
    const archivedRun = await escalateStaleWatches(ctx, { watchlistId: list.id });
    expect(archivedRun.considered).toBe(0);

    // the pump validates the watchlist reference (uniform, no leak)
    await expectCode('watchlist_not_found', () =>
      escalateStaleWatches(ctx, { watchlistId: newId() }),
    );
  });

  it('respects the per-pass limit (oldest entries first)', async () => {
    const ctx = member(tenantPump);
    const list = await createWatchlist(ctx, { name: 'Limit Fixture', escalationPolicy: policy({ staleGraceSeconds: 600, staleSeverity: 'high' }) });
    const entries = [];
    for (let i = 0; i < 3; i += 1) {
      const entry = await addWatchEntry(ctx, {
        watchlistId: list.id,
        kind: 'entity',
        entityKind: 'competitor',
        name: `limit-${i}`,
      });
      await setWatchFreshnessPolicy(ctx, { watchEntryId: entry.id, staleAfterSeconds: 600 });
      await recordWatchSignal(ctx, {
        watchEntryId: entry.id,
        observationId: await seedObservation(ctx, '2026-09-14T10:00:00Z'),
        severity: 'low',
      });
      entries.push(entry);
    }
    const run = await escalateStaleWatches(ctx, { watchlistId: list.id, limit: 2 });
    expect(run.considered).toBe(2);
    expect(run.recorded.length).toBe(2); // the two considered entries, both due
    // all three entries share one mocked clock millisecond, so WHICH two
    // are considered first is unspecified under the (created_at, id) tie —
    // the honest limit assertion is: two of the three, never more.
    const recordedIds = run.recorded.map((e) => e.watchEntryId);
    expect(new Set(recordedIds).size).toBe(2);
    for (const id of recordedIds) {
      expect(entries.map((e) => e.id)).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Escalation reads + snapshot immutability
// ---------------------------------------------------------------------------

describe('escalation reads and policy-snapshot immutability', () => {
  it('reads and filters escalations; later policy edits never rewrite snapshots', async () => {
    const ctx = member(tenantSignal);
    const list = await createWatchlist(ctx, {
      name: 'Snapshot Fixture',
      escalationPolicy: policy({ signalSeverityFloor: 'medium' }),
    });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme',
    });
    const fired = await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId: await seedObservation(ctx, '2026-09-14T10:00:00Z'),
      severity: 'high',
    });
    const escalationId = fired.escalation!.id;

    // read it back
    const escalation = await getWatchEscalation(ctx, { watchEscalationId: escalationId });
    expect(escalation.trigger).toBe('signal');
    expect(escalation.policySnapshot.policy.notifyParties).toEqual([
      { kind: 'person', id: null, label: 'coo' },
    ]);

    // list filters (scoped: the shared tenant carries escalations from
    // earlier tests, e.g. the list-filters fixture's critical signal)
    expect((await listWatchEscalations(ctx, { watchlistId: list.id })).length).toBe(1);
    expect((await listWatchEscalations(ctx, { watchlistId: list.id, trigger: 'stale' })).length).toBe(0);
    expect((await listWatchEscalations(ctx, { watchlistId: list.id, minSeverity: 'critical' })).length).toBe(0);
    expect((await listWatchEscalations(ctx, { watchEntryId: entry.id, minSeverity: 'high' })).length).toBe(1);

    // the watchlist policy changes wholesale — the recorded snapshot does not
    await updateWatchlist(ctx, {
      watchlistId: list.id,
      escalationPolicy: policy({
        signalSeverityFloor: 'critical',
        staleGraceSeconds: null,
        staleSeverity: null,
        notifyParties: [{ kind: 'team', label: 'exec-team' }],
      }),
    });
    const afterEdit = await getWatchEscalation(ctx, { watchEscalationId: escalationId });
    expect(afterEdit.policySnapshot.policy.signalSeverityFloor).toBe('medium');
    expect(afterEdit.policySnapshot.policy.notifyParties).toEqual([
      { kind: 'person', id: null, label: 'coo' },
    ]);

    // tenant isolation
    await expectCode('watch_escalation_not_found', () =>
      getWatchEscalation(member(tenantB), { watchEscalationId: escalationId }),
    );
    expect(await listWatchEscalations(member(tenantB), {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (triggers)
// ---------------------------------------------------------------------------

describe('storage-level guarantees (append-only and anti-erasure triggers)', () => {
  it('rejects UPDATE/DELETE on signals and escalations, DELETE/TRUNCATE on lists and entries', async () => {
    const ctx = member(tenantStorage);
    const list = await createWatchlist(ctx, { name: 'Storage Fixture', escalationPolicy: policy() });
    const entry = await addWatchEntry(ctx, {
      watchlistId: list.id,
      kind: 'entity',
      entityKind: 'supplier',
      name: 'Omega Supplies',
    });
    const observationId = await seedObservation(ctx, '2026-09-14T10:00:00Z');
    const fired = await recordWatchSignal(ctx, {
      watchEntryId: entry.id,
      observationId,
      severity: 'critical', // above the floor → signal escalation
    });
    const signalId = fired.signal.id;
    const escalationId = fired.escalation!.id;

    await expect(
      getDb().query(`UPDATE watch_signals SET severity = 'low' WHERE id = $1`, [signalId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM watch_signals WHERE id = $1`, [signalId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`UPDATE watch_escalations SET severity = 'low' WHERE id = $1`, [escalationId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM watch_escalations WHERE id = $1`, [escalationId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM watchlists WHERE id = $1`, [list.id]),
    ).rejects.toThrow(/cannot be erased/);
    await expect(
      getDb().query(`DELETE FROM watch_entries WHERE id = $1`, [entry.id]),
    ).rejects.toThrow(/cannot be erased/);
    // (TRUNCATE of watch_signals/watchlists is blocked by the FK graph
    // before the anti-erasure triggers even fire — either rejection
    // proves the point: the tables cannot be emptied)
    await expect(getDb().query(`TRUNCATE watch_signals`)).rejects.toThrow();
    await expect(getDb().query(`TRUNCATE watchlists`)).rejects.toThrow();
  });

  it('holds the storage CHECKs: policy shape, kind coherence and tenant-consistent keys', async () => {
    const ctx = member(tenantStorage);
    const list = await createWatchlist(ctx, { name: 'Checks Fixture', escalationPolicy: policy() });

    // a malformed policy cannot be smuggled past the service into storage
    await expect(
      getDb().query(
        `INSERT INTO watchlists (tenant_id, name, escalation_policy, created_by_principal)
         VALUES ($1, 'bad', $2::jsonb, 'x')`,
        [ctx.tenantId, JSON.stringify({ signalSeverityFloor: 'medium' })],
      ),
    ).rejects.toThrow();
    // an entity entry without its entity kind is unrepresentable
    await expect(
      getDb().query(
        `INSERT INTO watch_entries (tenant_id, watchlist_id, kind, name, created_by_principal)
         VALUES ($1, $2, 'entity', 'bad', 'x')`,
        [ctx.tenantId, list.id],
      ),
    ).rejects.toThrow();
    // a geography entry carrying geographies is unrepresentable
    await expect(
      getDb().query(
        `INSERT INTO watch_entries (tenant_id, watchlist_id, kind, name, geographies, created_by_principal)
         VALUES ($1, $2, 'geography', 'bad', '["EU"]'::jsonb, 'x')`,
        [ctx.tenantId, list.id],
      ),
    ).rejects.toThrow();
    // a cross-tenant entry (foreign watchlist) is unrepresentable
    await expect(
      getDb().query(
        `INSERT INTO watch_entries (tenant_id, watchlist_id, kind, name, created_by_principal)
         VALUES ($1, $2, 'topic', 'cross-tenant', 'x')`,
        [newId(), list.id],
      ),
    ).rejects.toThrow();
  });
});
