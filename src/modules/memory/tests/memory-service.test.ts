// Integration tests for the memory module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W010 acceptance:
// "evidence-backed organizational knowledge and transactive memory."
//
//  * evidence gate — nothing enters memory without supporting observations
//    that exist in this tenant and are readable by the recording principal
//    (verified through the observations module's contract; lock 11);
//  * append-only — the contract exposes no mutation operation, and
//    PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE (triggers), so what
//    the organization remembered cannot be silently rewritten; contradictory
//    entries coexist untouched (lock 12) and entries carry no truth
//    semantics of their own (lock 10 — beliefs are W007's, derived on top);
//  * retrieval — kind/topic (any-of)/entity/evidence-citation/text/window
//    filters, deterministic recency ordering, limits;
//  * transactive memory — the ARCHITECTURE.md §7 "who knows/owns/decides/
//    has-experience-with/influences/can-perform" assertions, retrievable by
//    topic ("who knows about X"), by relation and by actor;
//  * evidence resolution — a partial view honoring principal-scoped
//    observations (restricted evidence is omitted, never leaked);
//  * tenant isolation (ADR-0001) — cross-tenant memory and evidence are
//    uniformly not-found / invalid-provenance.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as memoryContract from '../contract';
import { recordObservation, type Observation } from '@/modules/observations/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { MemoryError } from '../errors';
import type {
  RecordKnowledgeEntryInput,
  RecordTransactiveEntryInput,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getKnowledgeEntry,
  getKnowledgeEntryEvidence,
  getTransactiveEntry,
  getTransactiveEntryEvidence,
  listKnowledgeEntries,
  listTransactiveEntries,
  recordKnowledgeEntry,
  recordTransactiveEntry,
} = memoryContract;

const tenantA = newId();
const tenantB = newId();
const tenantList = newId(); // dedicated tenants so filter/ordering tests
const tenantWho = newId(); // see only the data they create themselves

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

let evidenceCounter = 0;

/** Records one tenant-visible observation to cite as evidence. */
async function recordEvidence(ctx: TenantContext, observedAt = '2026-09-14T09:15:00Z'): Promise<Observation> {
  evidenceCounter += 1;
  return recordObservation(ctx, {
    kind: 'channel.message',
    payload: { text: `evidence payload #${evidenceCounter}` },
    observedAt,
    source: { kind: 'person', label: 'office-manager' },
    channel: 'whatsapp',
    confidence: { value: 0.9, method: 'source_trust', basis: 'first-hand report' },
  });
}

function knowledgeInput(evidenceObservationIds: string[]): RecordKnowledgeEntryInput {
  return {
    kind: 'fact',
    title: 'Northwind renewal was lost',
    summary: 'Northwind chose the competitor on price; the renewal was lost in September.',
    topics: ['customers', 'churn'],
    entities: [{ kind: 'customer', label: 'Northwind' }],
    evidenceObservationIds,
    notes: 'recorded from the account review thread',
  };
}

function transactiveInput(evidenceObservationIds: string[]): RecordTransactiveEntryInput {
  return {
    actor: { kind: 'person', id: newId(), label: 'alice' },
    relation: 'knows',
    subjectLabel: 'HVAC maintenance contracts',
    topics: ['hvac', 'facilities'],
    entities: [{ kind: 'process', label: 'facilities maintenance' }],
    evidenceObservationIds,
    notes: 'she ran the vendor selection in 2025',
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('recording evidence-backed organizational knowledge', () => {
  it('persists and returns every recorded attribute, canonically normalized', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    const recorded = await recordKnowledgeEntry(ctx, {
      kind: 'procedure',
      title: '  Procurement approval flow  ',
      summary: '  Purchases above 5000 require CFO sign-off.  ',
      topics: ['procurement', 'procurement', ' finance'],
      entities: [
        { kind: 'process', label: 'procurement' },
        { kind: 'person', id: newId() },
        { kind: 'process', label: 'procurement' },
      ],
      evidenceObservationIds: [evidence.id.toUpperCase(), evidence.id],
      notes: '  from the finance handbook  ',
    });

    expect(recorded.tenantId).toBe(tenantA);
    expect(recorded.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded.kind).toBe('procedure');
    expect(recorded.title).toBe('Procurement approval flow');
    expect(recorded.summary).toBe('Purchases above 5000 require CFO sign-off.');
    expect(recorded.topics).toEqual(['finance', 'procurement']); // dedup + sorted
    expect(recorded.entities).toEqual([
      expect.objectContaining({ kind: 'person' }),
      expect.objectContaining({ kind: 'process', label: 'procurement' }),
    ]);
    expect(recorded.evidenceObservationIds).toEqual([evidence.id]);
    expect(recorded.notes).toBe('from the finance handbook');
    expect(recorded.recordedAt).toBeTruthy();

    const read = await getKnowledgeEntry(ctx, recorded.id);
    expect(read).toEqual(recorded);
  });

  it('mints recordedAt itself — the caller cannot supply identity, tenancy or commit time', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    const before = new Date();
    const recorded = await recordKnowledgeEntry(ctx, knowledgeInput([evidence.id]));
    const after = new Date();
    expect(Date.parse(recorded.recordedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(recorded.recordedAt)).toBeLessThanOrEqual(after.getTime());

    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'authoritative']) {
      await expect(
        recordKnowledgeEntry(ctx, {
          ...knowledgeInput([evidence.id]),
          [smuggled]: newId(),
        } as never),
      ).rejects.toMatchObject({ code: 'invalid_knowledge_input' });
    }
  });

  it('gates on evidence: missing, cross-tenant and restricted observations are rejected uniformly', async () => {
    const ctx = member(tenantA);
    // a plain uuid that was never recorded as an observation
    await expect(
      recordKnowledgeEntry(ctx, knowledgeInput([newId()])),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });

    // another tenant's observation exists — but must be indistinguishable
    const foreign = await recordEvidence(member(tenantB));
    await expect(
      recordKnowledgeEntry(ctx, knowledgeInput([foreign.id])),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });

    // principal-restricted evidence of another principal is unavailable too
    const owner = newId();
    const restricted = await recordObservation(memberAs(tenantA, owner), {
      kind: 'channel.message',
      payload: { text: 'salary band feedback' },
      observedAt: '2026-09-14T09:15:00Z',
      source: { kind: 'person', label: 'office-manager' },
      channel: 'whatsapp',
      confidence: { value: 0.9, method: 'source_trust' },
      permissions: { visibility: 'principal', principalId: owner },
    });
    await expect(
      recordKnowledgeEntry(ctx, knowledgeInput([restricted.id])),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });

    // …while the owner may build memory on their own restricted evidence
    const own = await recordKnowledgeEntry(memberAs(tenantA, owner), knowledgeInput([restricted.id]));
    expect(own.evidenceObservationIds).toEqual([restricted.id]);
  });

  it('rejects invalid inputs and malformed contexts', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    await expect(
      recordKnowledgeEntry(ctx, { ...knowledgeInput([evidence.id]), kind: 'belief' } as never),
    ).rejects.toMatchObject({ code: 'invalid_knowledge_input' });
    await expect(
      recordKnowledgeEntry(ctx, { ...knowledgeInput([evidence.id]), topics: [] }),
    ).rejects.toMatchObject({ code: 'invalid_knowledge_input' });
    await expect(
      recordKnowledgeEntry(ctx, knowledgeInput([])),
    ).rejects.toMatchObject({ code: 'invalid_knowledge_input' });
    await expect(
      recordKnowledgeEntry({ tenantId: '', principalId: newId(), authority: [] }, knowledgeInput([evidence.id])),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });
});

describe('append-only: organizational memory cannot be rewritten', () => {
  it('exposes no mutation or promotion operation on the contract surface', async () => {
    // The ONLY public surface of the module is contract.ts; its export set
    // is pinned here: record + read + list + evidence resolution for both
    // concepts, errors/types/vocabularies. There is deliberately no
    // updateKnowledgeEntry, no deleteKnowledgeEntry, no supersedeEntry, no
    // promoteToBelief, no verify/authoritative flag.
    expect(Object.keys(memoryContract).sort()).toEqual([
      'DEFAULT_LIST_LIMIT',
      'KNOWLEDGE_ENTRY_KINDS',
      'MAX_ENTITIES',
      'MAX_EVIDENCE_OBSERVATIONS',
      'MAX_LABEL_LENGTH',
      'MAX_LIST_LIMIT',
      'MAX_NOTES_LENGTH',
      'MAX_SUMMARY_LENGTH',
      'MAX_TEXT_QUERY_LENGTH',
      'MAX_TITLE_LENGTH',
      'MAX_TOPICS',
      'MemoryError',
      'TRANSACTIVE_ACTOR_KINDS',
      'TRANSACTIVE_RELATIONS',
      'getKnowledgeEntry',
      'getKnowledgeEntryEvidence',
      'getTransactiveEntry',
      'getTransactiveEntryEvidence',
      'isKnowledgeEntryKind',
      'isTransactiveActorKind',
      'isTransactiveRelation',
      'listKnowledgeEntries',
      'listTransactiveEntries',
      'recordKnowledgeEntry',
      'recordTransactiveEntry',
    ]);
  });

  it('carries no truth/confidence/authoritative field on the record shape (lock 10)', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    const recorded = await recordKnowledgeEntry(ctx, knowledgeInput([evidence.id]));
    expect(Object.keys(recorded).sort()).toEqual([
      'entities',
      'evidenceObservationIds',
      'id',
      'kind',
      'notes',
      'recordedAt',
      'summary',
      'tenantId',
      'title',
      'topics',
    ]);
  });

  it('rejects UPDATE, DELETE and TRUNCATE on knowledge entries at the storage layer', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    const recorded = await recordKnowledgeEntry(ctx, knowledgeInput([evidence.id]));

    await expect(
      getDb().query(`UPDATE memory_knowledge_entries SET summary = 'tampered' WHERE id = $1`, [
        recorded.id,
      ]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      getDb().query(`DELETE FROM memory_knowledge_entries WHERE id = $1`, [recorded.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(getDb().query(`TRUNCATE memory_knowledge_entries`)).rejects.toThrow(/append-only/i);

    const after = await getKnowledgeEntry(ctx, recorded.id);
    expect(after.summary).toBe(knowledgeInput([evidence.id]).summary);
  });

  it('rejects UPDATE, DELETE and TRUNCATE on transactive entries as well', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    const recorded = await recordTransactiveEntry(ctx, transactiveInput([evidence.id]));

    await expect(
      getDb().query(`UPDATE memory_transactive_entries SET subject_label = 'tampered' WHERE id = $1`, [
        recorded.id,
      ]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      getDb().query(`DELETE FROM memory_transactive_entries WHERE id = $1`, [recorded.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(getDb().query(`TRUNCATE memory_transactive_entries`)).rejects.toThrow(/append-only/i);

    const after = await getTransactiveEntry(ctx, recorded.id);
    expect(after.subjectLabel).toBe('HVAC maintenance contracts');
  });

  it('retains contradictory knowledge instead of merging or overwriting (lock 12)', async () => {
    const ctx = member(newId()); // dedicated tenant: this test sees only its own churn entries
    const evidenceLost = await recordEvidence(ctx, '2026-09-10T09:15:00Z');
    const evidenceWon = await recordEvidence(ctx, '2026-09-20T09:15:00Z');
    const first = await recordKnowledgeEntry(ctx, {
      ...knowledgeInput([evidenceLost.id]),
      title: 'Northwind renewal was lost',
      summary: 'The renewal was lost; the competitor won on price.',
    });
    const contradiction = await recordKnowledgeEntry(ctx, {
      ...knowledgeInput([evidenceWon.id]),
      title: 'Northwind renewal was re-won',
      summary: 'The customer reversed the decision after a price match; the renewal holds.',
    });

    const readFirst = await getKnowledgeEntry(ctx, first.id);
    const readSecond = await getKnowledgeEntry(ctx, contradiction.id);
    expect(readFirst.summary).toBe('The renewal was lost; the competitor won on price.');
    expect(readSecond.summary).toBe(
      'The customer reversed the decision after a price match; the renewal holds.',
    );
    // both sides remain retrievable — memory does not adjudicate
    const both = await listKnowledgeEntries(ctx, { topics: ['churn'] });
    expect(both.map((entry) => entry.id).sort()).toEqual([first.id, contradiction.id].sort());
  });

  it('keeps LLM-derived knowledge as evidence-cited memory, never authoritative (lock 10)', async () => {
    const ctx = member(tenantA);
    const raw = await recordEvidence(ctx);
    const extracted = await recordObservation(ctx, {
      kind: 'document.note',
      payload: { fact: 'Northwind account churn risk is high', reason: 'competitor underbid' },
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
    const remembered = await recordKnowledgeEntry(ctx, {
      kind: 'insight',
      title: 'Northwind churn risk is high',
      summary: 'A competitor underbid; churn risk assessed high by the extraction pipeline.',
      topics: ['churn', 'risk'],
      evidenceObservationIds: [extracted.id],
    });

    // The entry stays a plain, evidence-cited record: no truth flag, no
    // promotion — the observation it cites carries the lineage and the
    // confidence, and epistemics (W007) will weigh it on top of this.
    const resolved = await getKnowledgeEntryEvidence(ctx, remembered.id);
    expect(resolved.evidence).toHaveLength(1);
    expect(resolved.evidence[0]!.lineage.extractor).toEqual({
      provider: 'llm-a',
      model: 'reasoning-model-1',
      notes: 'structured extraction',
    });
    expect(resolved.evidence[0]!.confidence.value).toBe(0.72);
  });
});

describe('retrieval: listKnowledgeEntries', () => {
  it('filters by kind, topics (any-of), entity, evidence citation, text and recorded window', async () => {
    const ctx = member(tenantList);
    const customerProcessId = newId();
    const evidenceProcedure = await recordEvidence(ctx, '2026-09-01T09:15:00Z');
    const procedure = await recordKnowledgeEntry(ctx, {
      kind: 'procedure',
      title: 'Procurement approval flow',
      summary: 'Purchases above 5000 require CFO sign-off.',
      topics: ['procurement', 'finance'],
      entities: [{ kind: 'process', id: customerProcessId, label: 'procurement' }],
      evidenceObservationIds: [evidenceProcedure.id],
    });
    const evidenceChurn = await recordEvidence(ctx, '2026-09-10T09:15:00Z');
    const churn = await recordKnowledgeEntry(ctx, {
      kind: 'fact',
      title: 'Growth was 12% last quarter',
      summary: 'Net revenue retention dipped; churn concentrated in SMB.',
      topics: ['churn', 'finance'],
      entities: [{ kind: 'metric', label: 'nrr' }],
      evidenceObservationIds: [evidenceChurn.id],
    });
    // wildcard traps: if ILIKE metacharacters were NOT escaped, '12%' would
    // match '121' and 'Plan_Q1' would match 'PlanXQ1'
    await recordKnowledgeEntry(ctx, {
      kind: 'fact',
      title: 'Growth was 121 percent',
      summary: 'A different, unquoted figure from another quarter.',
      topics: ['growth'],
      evidenceObservationIds: [evidenceChurn.id],
    });
    const underscored = await recordKnowledgeEntry(ctx, {
      kind: 'context',
      title: 'Plan_Q1 approved by the board',
      summary: 'The board approved the plan in the September session.',
      topics: ['planning'],
      evidenceObservationIds: [evidenceChurn.id],
    });
    await recordKnowledgeEntry(ctx, {
      kind: 'context',
      title: 'PlanXQ1 was rejected',
      summary: 'The board rejected the alternative plan.',
      topics: ['planning'],
      evidenceObservationIds: [evidenceChurn.id],
    });

    // kind
    expect((await listKnowledgeEntries(ctx, { kind: 'procedure' })).map((e) => e.id)).toEqual([
      procedure.id,
    ]);
    // topics any-of (a multi-topic entry matches a single query topic)
    expect((await listKnowledgeEntries(ctx, { topics: ['finance'] })).map((e) => e.id).sort()).toEqual(
      [procedure.id, churn.id].sort(),
    );
    // entity kind only / kind + id
    expect((await listKnowledgeEntries(ctx, { entityKind: 'process' })).map((e) => e.id)).toEqual([
      procedure.id,
    ]);
    expect(
      (await listKnowledgeEntries(ctx, { entityKind: 'process', entityId: customerProcessId })).map(
        (e) => e.id,
      ),
    ).toEqual([procedure.id]);
    expect(
      (await listKnowledgeEntries(ctx, { entityKind: 'process', entityId: newId() })).map((e) => e.id),
    ).toEqual([]);
    // evidence citation (provenance tracing)
    expect(
      (await listKnowledgeEntries(ctx, { evidenceObservationId: evidenceProcedure.id })).map((e) => e.id),
    ).toEqual([procedure.id]);
    // text: case-insensitive over title AND summary
    expect((await listKnowledgeEntries(ctx, { text: 'CFO SIGN-OFF' })).map((e) => e.id)).toEqual([
      procedure.id,
    ]);
    expect((await listKnowledgeEntries(ctx, { text: 'SMB' })).map((e) => e.id)).toEqual([churn.id]);
    // text: ILIKE metacharacters are matched literally (escaped)
    expect((await listKnowledgeEntries(ctx, { text: '12%' })).map((e) => e.id)).toEqual([churn.id]);
    expect((await listKnowledgeEntries(ctx, { text: '%' })).map((e) => e.id)).toEqual([churn.id]);
    expect((await listKnowledgeEntries(ctx, { text: 'Plan_Q1' })).map((e) => e.id)).toEqual([
      underscored.id,
    ]);
    expect((await listKnowledgeEntries(ctx, { text: '_' })).map((e) => e.id)).toEqual([underscored.id]);
    expect((await listKnowledgeEntries(ctx, { text: 'PlanXQ1' })).map((e) => e.id)).toHaveLength(1);
    // recorded window (inclusive bounds, service-minted recordedAt)
    const all = await listKnowledgeEntries(ctx, {});
    expect(all.length).toBe(5);
    const from = new Date(Date.parse(all[all.length - 1]!.recordedAt) - 1).toISOString();
    const to = new Date(Date.parse(all[0]!.recordedAt) + 1).toISOString();
    expect((await listKnowledgeEntries(ctx, { recordedFrom: from, recordedTo: to })).length).toBe(5);
    expect((await listKnowledgeEntries(ctx, { recordedTo: from })).map((e) => e.id)).toEqual([]);
  });

  it('orders by recordedAt descending and honors the limit', async () => {
    const ctx = member(tenantList);
    for (let i = 0; i < 3; i += 1) {
      const evidence = await recordEvidence(ctx, `2026-09-1${i}T00:00:00Z`);
      await recordKnowledgeEntry(ctx, {
        ...knowledgeInput([evidence.id]),
        title: `sequence ${i}`,
      });
    }
    const feed = await listKnowledgeEntries(ctx, {});
    expect(feed.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < feed.length; i += 1) {
      expect(Date.parse(feed[i]!.recordedAt)).toBeLessThanOrEqual(Date.parse(feed[i - 1]!.recordedAt));
    }
    const limited = await listKnowledgeEntries(ctx, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((e) => e.id)).toEqual(feed.slice(0, 2).map((e) => e.id));

    await expect(listKnowledgeEntries(ctx, { limit: 0 } as never)).rejects.toMatchObject({
      code: 'invalid_knowledge_query',
    });
  });
});

describe('transactive memory: who knows what (ARCHITECTURE.md §7)', () => {
  it('persists and returns every recorded attribute of an assertion', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    const alice = newId();
    const recorded = await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: alice, label: 'alice' },
      relation: 'has_experience_with',
      subjectLabel: 'Northwind contract negotiations',
      topics: ['sales', 'northwind'],
      entities: [{ kind: 'customer', label: 'Northwind' }],
      evidenceObservationIds: [evidence.id],
      notes: 'led the 2025 negotiation',
    });

    expect(recorded.tenantId).toBe(tenantA);
    expect(recorded.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded.actor).toEqual({ kind: 'person', id: alice, label: 'alice' });
    expect(recorded.relation).toBe('has_experience_with');
    expect(recorded.subjectLabel).toBe('Northwind contract negotiations');
    expect(recorded.topics).toEqual(['northwind', 'sales']);
    expect(recorded.entities).toEqual([{ kind: 'customer', id: null, label: 'Northwind' }]);
    expect(recorded.evidenceObservationIds).toEqual([evidence.id]);
    expect(recorded.notes).toBe('led the 2025 negotiation');
    expect(recorded.recordedAt).toBeTruthy();

    expect(await getTransactiveEntry(ctx, recorded.id)).toEqual(recorded);
  });

  it('requires a traceable actor and valid evidence like the knowledge side', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    await expect(
      recordTransactiveEntry(ctx, {
        ...transactiveInput([evidence.id]),
        actor: { kind: 'person' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_transactive_input' });
    await expect(
      recordTransactiveEntry(ctx, transactiveInput([newId()])),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });
    await expect(
      recordTransactiveEntry(ctx, transactiveInput([])),
    ).rejects.toMatchObject({ code: 'invalid_transactive_input' });
  });

  it('answers who-knows-what by topic, relation, actor and text', async () => {
    const ctx = member(tenantWho);
    const alice = newId();
    const bob = newId();
    const carol = newId();

    const evidenceHvac = await recordEvidence(ctx, '2026-09-01T09:15:00Z');
    const aliceKnowsHvac = await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: alice, label: 'alice' },
      relation: 'knows',
      subjectLabel: 'HVAC maintenance contracts',
      topics: ['hvac', 'facilities'],
      evidenceObservationIds: [evidenceHvac.id],
    });
    const evidenceOwns = await recordEvidence(ctx, '2026-09-02T09:15:00Z');
    const bobOwnsHvac = await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: bob, label: 'bob' },
      relation: 'owns',
      subjectLabel: 'the facilities maintenance budget',
      topics: ['hvac', 'budget'],
      evidenceObservationIds: [evidenceOwns.id],
    });
    const evidencePayroll = await recordEvidence(ctx, '2026-09-03T09:15:00Z');
    const carolKnowsPayroll = await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: carol, label: 'carol' },
      relation: 'knows',
      subjectLabel: 'payroll cut-off rules',
      topics: ['payroll'],
      evidenceObservationIds: [evidencePayroll.id],
      notes: 'processes the monthly run',
    });

    // who knows about HVAC (any-of topics)
    expect((await listTransactiveEntries(ctx, { topics: ['hvac'] })).map((e) => e.id).sort()).toEqual(
      [aliceKnowsHvac.id, bobOwnsHvac.id].sort(),
    );
    // …specifically who OWNS something in that area
    expect((await listTransactiveEntries(ctx, { topics: ['hvac'], relation: 'owns' })).map((e) => e.id)).toEqual([
      bobOwnsHvac.id,
    ]);
    // everything asserted about one actor
    expect(
      (await listTransactiveEntries(ctx, { actorKind: 'person', actorId: alice })).map((e) => e.id),
    ).toEqual([aliceKnowsHvac.id]);
    // text over subjectLabel and notes
    expect((await listTransactiveEntries(ctx, { text: 'PAYROLL' })).map((e) => e.id)).toEqual([
      carolKnowsPayroll.id,
    ]);
    expect((await listTransactiveEntries(ctx, { text: 'monthly run' })).map((e) => e.id)).toEqual([
      carolKnowsPayroll.id,
    ]);
    // evidence citation tracing
    expect(
      (await listTransactiveEntries(ctx, { evidenceObservationId: evidencePayroll.id })).map((e) => e.id),
    ).toEqual([carolKnowsPayroll.id]);
    // recency ordering with limit (ties on recordedAt break by id DESC —
    // the same ORDER BY serves both the feed and the limited query)
    const feed = await listTransactiveEntries(ctx, {});
    expect(new Set(feed.map((e) => e.id))).toEqual(
      new Set([carolKnowsPayroll.id, bobOwnsHvac.id, aliceKnowsHvac.id]),
    );
    for (let i = 1; i < feed.length; i += 1) {
      expect(Date.parse(feed[i]!.recordedAt)).toBeLessThanOrEqual(Date.parse(feed[i - 1]!.recordedAt));
    }
    const limited = await listTransactiveEntries(ctx, { limit: 2 });
    expect(limited.map((e) => e.id)).toEqual(feed.slice(0, 2).map((e) => e.id));
  });
});

describe('evidence resolution (partial view, never a leak)', () => {
  it('resolves readable supporting observations, ordered by observedAt', async () => {
    const ctx = member(tenantA);
    const older = await recordEvidence(ctx, '2026-09-01T09:15:00Z');
    const newer = await recordEvidence(ctx, '2026-09-10T09:15:00Z');
    const recorded = await recordKnowledgeEntry(ctx, {
      ...knowledgeInput([newer.id, older.id]),
      title: 'cited by two observations',
    });

    const resolved = await getKnowledgeEntryEvidence(ctx, recorded.id);
    expect(resolved.entry.id).toBe(recorded.id);
    expect(resolved.evidence.map((o) => o.id)).toEqual([older.id, newer.id]); // observedAt ascending
    expect(resolved.evidence[0]!.observedAt).toBe('2026-09-01T09:15:00.000Z');
  });

  it('omits another principal\'s restricted evidence but keeps the full id set on the entry', async () => {
    const owner = newId();
    const ownerCtx = memberAs(tenantA, owner);
    const visible = await recordEvidence(ownerCtx, '2026-09-01T09:15:00Z');
    const restricted = await recordObservation(ownerCtx, {
      kind: 'channel.message',
      payload: { text: 'confidential context' },
      observedAt: '2026-09-02T09:15:00Z',
      source: { kind: 'person', label: 'office-manager' },
      channel: 'whatsapp',
      confidence: { value: 0.9, method: 'source_trust' },
      permissions: { visibility: 'principal', principalId: owner },
    });
    const recorded = await recordKnowledgeEntry(ownerCtx, {
      ...knowledgeInput([visible.id, restricted.id]),
      title: 'partially restricted provenance',
    });

    // the owner resolves both pieces of evidence
    const asOwner = await getKnowledgeEntryEvidence(ownerCtx, recorded.id);
    expect(asOwner.evidence.map((o) => o.id)).toEqual([visible.id, restricted.id]);

    // another member of the SAME tenant sees a partial view: the entry and
    // its full evidence id set, but only the evidence they may read
    const asOther = await getKnowledgeEntryEvidence(member(tenantA), recorded.id);
    expect(asOther.entry.evidenceObservationIds).toEqual([visible.id, restricted.id]);
    expect(asOther.evidence.map((o) => o.id)).toEqual([visible.id]);
  });

  it('resolves transactive evidence with the same partial-view semantics', async () => {
    const owner = newId();
    const ownerCtx = memberAs(tenantA, owner);
    const visible = await recordEvidence(ownerCtx);
    const restricted = await recordObservation(ownerCtx, {
      kind: 'channel.message',
      payload: { text: 'confidential context' },
      observedAt: '2026-09-02T09:15:00Z',
      source: { kind: 'person', label: 'office-manager' },
      channel: 'whatsapp',
      confidence: { value: 0.9, method: 'source_trust' },
      permissions: { visibility: 'principal', principalId: owner },
    });
    const recorded = await recordTransactiveEntry(ownerCtx, {
      ...transactiveInput([visible.id, restricted.id]),
    });

    const asOwner = await getTransactiveEntryEvidence(ownerCtx, recorded.id);
    expect(asOwner.evidence).toHaveLength(2);
    const asOther = await getTransactiveEntryEvidence(member(tenantA), recorded.id);
    expect(asOther.evidence.map((o) => o.id)).toEqual([visible.id]);
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('hides knowledge and transactive entries across tenants with a uniform not-found', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    const knowledge = await recordKnowledgeEntry(ctx, knowledgeInput([evidence.id]));
    const transactive = await recordTransactiveEntry(ctx, transactiveInput([evidence.id]));

    await expect(getKnowledgeEntry(member(tenantB), knowledge.id)).rejects.toMatchObject({
      code: 'knowledge_entry_not_found',
    });
    await expect(getTransactiveEntry(member(tenantB), transactive.id)).rejects.toMatchObject({
      code: 'transactive_entry_not_found',
    });
    // malformed ids are indistinguishable from missing ones
    await expect(getKnowledgeEntry(ctx, 'not-a-uuid')).rejects.toMatchObject({
      code: 'knowledge_entry_not_found',
    });
    await expect(getTransactiveEntry(ctx, 'not-a-uuid')).rejects.toMatchObject({
      code: 'transactive_entry_not_found',
    });
    // evidence resolution of another tenant's entry is equally invisible
    await expect(getKnowledgeEntryEvidence(member(tenantB), knowledge.id)).rejects.toMatchObject({
      code: 'knowledge_entry_not_found',
    });
  });

  it('never lists one tenant\'s memory in another tenant\'s retrieval', async () => {
    const ctx = member(tenantA);
    const evidence = await recordEvidence(ctx);
    await recordKnowledgeEntry(ctx, { ...knowledgeInput([evidence.id]), topics: ['shared-topic'] });
    await recordTransactiveEntry(ctx, {
      ...transactiveInput([evidence.id]),
      topics: ['shared-topic'],
    });

    const bKnowledge = await listKnowledgeEntries(member(tenantB), { topics: ['shared-topic'] });
    expect(bKnowledge).toEqual([]);
    const bTransactive = await listTransactiveEntries(member(tenantB), { topics: ['shared-topic'] });
    expect(bTransactive).toEqual([]);
    // …even when tracing by the observation id cited in tenant A
    const bByEvidence = await listKnowledgeEntries(member(tenantB), {
      evidenceObservationId: evidence.id,
    });
    expect(bByEvidence).toEqual([]);
    const aKnowledge = await listKnowledgeEntries(ctx, { topics: ['shared-topic'] });
    expect(aKnowledge.length).toBeGreaterThan(0);
  });
});

describe('error type', () => {
  it('carries the module error name and code', () => {
    const error = new MemoryError('knowledge_entry_not_found', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MemoryError');
    expect(error.code).toBe('knowledge_entry_not_found');
  });
});
