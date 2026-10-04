// Integration tests for the company-query module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W126
// acceptance (spec/POST-W123-COVERAGE-DAG-2026-10-04.md "W126" +
// COMPANY-COVERAGE-ARCHITECTURE.md §6/§7):
//
//   * TENANT/PRINCIPAL SCOPING — tenant A's query never sees tenant B's
//     evidence, epistemics, sources or knowledge; the audit row lands in
//     the asking tenant only (ADR-0001 — the mandatory isolation evidence);
//   * PROVENANCE + FRESHNESS — every material claim (observed fact, derived
//     belief) carries ≥1 provenance chip with observation id, source label,
//     observed/recorded timestamps and a freshness classification;
//   * CONTRADICTIONS PRESERVED END-TO-END — a registered contradiction
//     renders with BOTH sides and both sides' provenance, never merged;
//   * UNKNOWNS SURFACED — open unknowns ride the answer with question AND
//     consequence;
//   * COVERAGE CONTEXT IN EVERY RESPONSE — every surface in scope carries a
//     §5 state, contributing sources and an explanation; a configured
//     source with no evidence is 'unknown', never 'covered' (§7);
//   * LLM-NEVER-AUTHORITATIVE — with the LLM layer UNAVAILABLE (no tenant
//     account/transport) the full structured answer stands; with the LLM
//     MOCKED to "hallucinate", the structured answer is byte-identical to
//     the LLM-less run and the hallucination only ever appears inside the
//     presentation-only `answer.llm` field;
//   * §7 HONESTY — "How much of our customer support history can you see?"
//     answers from the real derived coverage state;
//   * the append-only audit — mutation rejected at the storage level.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

// The LLM contract is MOCKED (module-level, hoisted) with a controllable
// stand-in so the never-authoritative proof can run the SAME query with
// the LLM disabled and with a hallucinating LLM.
const llmMockState: { mode: 'unavailable' | 'hallucinate' } = { mode: 'unavailable' };
vi.mock('@/modules/llm/contract', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/llm/contract')>();
  return {
    ...original,
    invokeLlm: async () => {
      if (llmMockState.mode === 'unavailable') {
        throw new (original.LlmError)('provider_unavailable', 'no transport wired (mock)');
      }
      return {
        id: newId(),
        tenantId: 'mock',
        purpose: 'invocation',
        capability: 'text-generation',
        provider: 'openai',
        model: 'gpt-4o',
        accountId: 'mock-account',
        status: 'completed',
        errorCode: null,
        errorDetail: null,
        result: { kind: 'text-generation', text: 'Revenue is 99 trillion dollars and growing.' },
        inputTokens: 10,
        outputTokens: 10,
        costMinor: 0,
        costCurrency: 'USD' as const,
        latencyMs: 1,
        providerExecutionId: null,
        policy: null,
        routing: {} as never,
        invokedBy: 'mock',
        invokedAt: new Date().toISOString(),
      } satisfies Awaited<ReturnType<typeof original.invokeLlm>>;
    },
  };
});

import { runCompanyQuery } from '../contract';
import { recordObservation } from '@/modules/observations/contract';
import { registerSource } from '@/modules/sources/contract';
import type { Source } from '@/modules/sources/contract';
import {
  formBelief,
  recordClaim,
  recordHypothesis,
  recordUnknown,
  registerContradiction,
} from '@/modules/epistemics/contract';
import { recordKnowledgeEntry } from '@/modules/memory/contract';
import { createEntity } from '@/modules/world/contract';

const T0 = '2026-09-30T10:00:00.000Z';
const T_STALE = '2026-08-01T10:00:00.000Z';

function member(tenantId: string, principalId = newId()): TenantContext {
  return { tenantId, principalId: principalId ?? newId(), authority: [] };
}

const tenantA = newId();
const tenantB = newId();
const principalA = newId();
const principalB = newId();

let zendeskA: Source;
let obsSupportA1: Awaited<ReturnType<typeof recordObservation>>;
let obsSupportA2: Awaited<ReturnType<typeof recordObservation>>;


beforeAll(async () => {
  await runMigrations(getDb());

  // --- tenant A: a real, observable support/sales footprint ---------------
  const ownerA = member(tenantA, principalA);
  zendeskA = (
    await registerSource(ownerA, {
      provider: 'zendesk',
      providerAccountId: 'ACME-ZENDESK-1',
      displayName: 'Acme Zendesk',
      authKind: 'oauth',
      credentialRef: 'secret-store://zendesk-acme',
      oauthScopes: ['read'],
    })
  ).source;
  const salesforceA = (
    await registerSource(ownerA, {
      provider: 'salesforce',
      providerAccountId: 'ACME-SF-1',
      displayName: 'Acme Salesforce',
      authKind: 'credentials',
      credentialRef: 'secret-store://sf-acme',
    })
  ).source;

  obsSupportA1 = await recordObservation(ownerA, {
    kind: 'support.ticket.created',
    payload: { subject: 'Cannot sign in', priority: 'high' },
    observedAt: T0,
    source: { kind: 'source', id: zendeskA.id },
    channel: 'api',
    confidence: { value: 0.95, method: 'source_trust', basis: 'connector' },
  });
  obsSupportA2 = await recordObservation(ownerA, {
    kind: 'support.ticket.updated',
    payload: { status: 'solved', resolution: 'password reset' },
    observedAt: T0,
    source: { kind: 'source', id: zendeskA.id },
    channel: 'api',
    confidence: { value: 0.95, method: 'source_trust', basis: 'connector' },
  });
  await recordObservation(ownerA, {
    kind: 'crm.deal.created',
    payload: { name: 'Big renewal', amount: 25000 },
    observedAt: T0,
    source: { kind: 'source', id: salesforceA.id },
    channel: 'api',
    confidence: { value: 0.9, method: 'source_trust', basis: 'connector' },
  });
  // One observation from BEFORE the stale-after window (30d default).
  await recordObservation(ownerA, {
    kind: 'support.ticket.created',
    payload: { subject: 'Legacy export fails', priority: 'low' },
    observedAt: T_STALE,
    source: { kind: 'source', id: zendeskA.id },
    channel: 'api',
    confidence: { value: 0.9, method: 'source_trust', basis: 'connector' },
  });

  // Epistemics: a claim, an active belief, a hypothesis, a contradiction, an unknown.
  const claimA = await recordClaim(ownerA, {
    proposition: 'Two support tickets were created from the Zendesk stream',
    evidenceObservationIds: [obsSupportA1.id, obsSupportA2.id],
    confidence: { value: 0.9, method: 'evidence_count', basis: 'two corroborating observations' },
    subject: { kind: 'company-query.surface', id: newId() },
  });
  await formBelief(ownerA, {
    proposition: 'The support queue is healthy: the newest tickets resolve within a day',
    confidence: { value: 0.7, method: 'manual_assessment', basis: 'ticket lifecycle evidence' },
    supportingObservationIds: [obsSupportA2.id],
    validFrom: T0,
    alternatives: ['resolution times may have regressed since the last observation'],
    disconfirmation: 'a new open ticket older than 24h without resolution',
    subject: { kind: 'company-query.surface', id: newId() },
  });
  await recordHypothesis(ownerA, {
    proposition: 'The sign-in failures correlate with the SSO rollout',
    supportingObservationIds: [obsSupportA1.id],
    note: 'both started the same morning',
  });
  await registerContradiction(ownerA, {
    left: { kind: 'observation', id: obsSupportA1.id },
    right: { kind: 'claim', id: claimA.id },
    note: 'the ticket says high priority; the claim counts it as routine volume',
  });
  await recordUnknown(ownerA, {
    question: 'Which customer conversations happen outside the connected Zendesk channel?',
    consequence: 'support coverage claims may overstate what Aurum can actually see',
  });

  // Memory + world: knowledge entry citing evidence, and a world entity.
  await recordKnowledgeEntry(ownerA, {
    kind: 'fact',
    title: 'Password resets resolve most sign-in tickets',
    summary: 'Every sampled sign-in ticket in the window closed with a password reset.',
    evidenceObservationIds: [obsSupportA2.id],
    topics: ['support'],
  });
  await createEntity(ownerA, {
    name: 'Acme Support Team',
    kind: 'team',
    description: 'The customer support team',
  });

  // --- tenant B: a private footprint that must never surface --------------
  const ownerB = member(tenantB, principalB);
  const zendeskB = (
    await registerSource(ownerB, {
      provider: 'zendesk',
      providerAccountId: 'GLOBEX-ZENDESK-1',
      displayName: 'Globex Zendesk',
      authKind: 'oauth',
      credentialRef: 'secret-store://zendesk-globex',
      oauthScopes: ['read'],
    })
  ).source;
  await recordObservation(ownerB, {
    kind: 'support.ticket.created',
    payload: { subject: 'TENANT-B-SECRET-MARKER' },
    observedAt: T0,
    source: { kind: 'source', id: zendeskB.id },
    channel: 'api',
    confidence: { value: 0.9, method: 'source_trust', basis: 'connector' },
  });
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Tenant/principal scoping (the mandatory isolation evidence)
// ---------------------------------------------------------------------------

describe('runCompanyQuery — tenant scoping', () => {
  it('answers within tenant A and never surfaces tenant B state', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'How many support tickets are open?',
    });

    // No tenant B evidence anywhere in the answer.
    const claimTexts = response.answer.claims.map((claim) => claim.text).join(' ');
    expect(claimTexts).not.toContain('TENANT-B-SECRET-MARKER');
    expect(claimTexts).not.toContain('Globex');

    // No tenant B sources in the coverage context.
    const sourceNames = response.coverageContext.surfaces
      .flatMap((summary) => summary.contributingSources.map((source) => source.displayName ?? ''))
      .join(' ');
    expect(sourceNames).not.toContain('Globex');

    // The audit row landed in tenant A only.
    const audit = await getDb().query(
      'SELECT tenant_id, principal_id, question FROM company_query_log',
    );
    const rows = audit.rows as { tenant_id: string; principal_id: string; question: string }[];
    expect(rows.every((row) => row.tenant_id === tenantA)).toBe(true);
    expect(rows.at(-1)!.principal_id).toBe(principalA);
    expect(rows.at(-1)!.question).toBe('How many support tickets are open?');
  });

  it('tenant B querying sees only its own (different) answer', async () => {
    const response = await runCompanyQuery(member(tenantB, principalB), {
      question: 'How many support tickets are open?',
    });
    const claimTexts = response.answer.claims.map((claim) => claim.text).join(' ');
    expect(claimTexts).toContain('TENANT-B-SECRET-MARKER');
    expect(claimTexts).not.toContain('Cannot sign in');
    const audit = await getDb().query<{ tenant_id: string }>(
      'SELECT tenant_id FROM company_query_log WHERE tenant_id = $1',
      [tenantB],
    );
    expect(audit.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provenance + freshness on material claims (§6 steps 5-6)
// ---------------------------------------------------------------------------

describe('runCompanyQuery — provenance and freshness', () => {
  it('attaches ≥1 provenance chip with source, timestamps and freshness to every material claim', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What is happening in support and sales?',
    });
    expect(response.answer.claims.length).toBeGreaterThan(3);
    for (const claim of response.answer.claims) {
      if (claim.kind === 'observed-fact' || claim.kind === 'derived-belief') {
        expect(claim.provenance.length).toBeGreaterThanOrEqual(1);
        for (const chip of claim.provenance) {
          expect(chip.observationId).toMatch(/^[0-9a-f-]{36}$/);
          expect(chip.sourceLabel.length).toBeGreaterThan(0);
          expect(chip.channel).toBe('api');
          expect(chip.observedAt).toMatch(/^2026-/);
          expect(chip.recordedAt).toMatch(/^2026-/);
          expect(['current', 'aging', 'stale', 'unknown']).toContain(chip.freshness);
        }
      }
    }

    // The stale observation's claim is classified stale against the
    // default 30-day policy (its observedAt is 2026-08-01).
    const staleClaims = response.answer.claims.filter(
      (claim) =>
        claim.text.includes('Legacy export fails') &&
        claim.provenance.some((chip) => chip.observedAt === T_STALE),
    );
    expect(staleClaims).toHaveLength(1);
    expect(staleClaims[0]!.provenance[0]!.freshness).toBe('stale');
  });

  it('distinguishes the four epistemic classes (§6 step 5)', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What is happening in support?',
    });
    const kinds = new Set(response.answer.claims.map((claim) => claim.kind));
    expect(kinds.has('observed-fact')).toBe(true); // observations + the claim + knowledge entry
    expect(kinds.has('derived-belief')).toBe(true); // the active belief
    expect(kinds.has('hypothesis')).toBe(true); // the SSO hypothesis
    expect(response.answer.unknowns.length).toBeGreaterThan(0); // the unknown
  });
});

// ---------------------------------------------------------------------------
// Contradictions preserved end-to-end (§6 step 8)
// ---------------------------------------------------------------------------

describe('runCompanyQuery — contradictions stay visible', () => {
  it('renders the registered disagreement with provenance on BOTH sides', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What is our support situation?',
    });
    const contradiction = response.answer.contradictions.find((entry) =>
      entry.note.includes('high priority'),
    );
    expect(contradiction).toBeDefined();
    expect(contradiction!.status).toBe('open');
    // The epistemics contract canonicalizes the pair order — assert by
    // evidence kind, never by registration order.
    const sides = [contradiction!.sideA, contradiction!.sideB];
    const observationSide = sides.find((side) => side.evidenceKind === 'observation')!;
    const claimSide = sides.find((side) => side.evidenceKind === 'claim')!;
    expect(observationSide.text).toContain('Cannot sign in');
    expect(observationSide.provenance).toHaveLength(1);
    expect(observationSide.provenance[0]!.sourceLabel).toBe('Acme Zendesk');
    expect(claimSide.text).toContain('Two support tickets');
    expect(claimSide.provenance.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Unknowns surfaced (§6 step 5/8)
// ---------------------------------------------------------------------------

describe('runCompanyQuery — unknowns surfaced', () => {
  it('carries the question AND its consequence', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What should I know about customers?',
    });
    const unknown = response.answer.unknowns.find((entry) =>
      entry.question.includes('outside the connected Zendesk'),
    );
    expect(unknown).toBeDefined();
    expect(unknown!.status).toBe('open');
    expect(unknown!.consequence).toContain('overstate');
  });
});

// ---------------------------------------------------------------------------
// Coverage context in every response (§6 step 4 + §7)
// ---------------------------------------------------------------------------

describe('runCompanyQuery — the coverage context', () => {
  it('is present and complete for every surface in scope', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What is the company state?',
    });
    expect(response.coverageContext.derivation).toBe('query-side-conservative');
    expect(response.coverageContext.surfaces).toHaveLength(13);
    for (const summary of response.coverageContext.surfaces) {
      expect(summary.state).toMatch(/^(covered|partial|stale|unavailable|unauthorized|excluded|unknown)$/);
      expect(summary.explanation.length).toBeGreaterThan(0);
    }

    const support = response.coverageContext.surfaces.find((s) => s.surface === 'support-tickets')!;
    expect(support.contributingSources.map((s) => s.displayName)).toContain('Acme Zendesk');
    expect(support.observationCount).toBeGreaterThanOrEqual(3);
    expect(['partial', 'covered']).toContain(support.state);

    const meetings = response.coverageContext.surfaces.find((s) => s.surface === 'meetings')!;
    expect(meetings.state).toBe('unavailable'); // nothing connected
    expect(meetings.explanation).toContain('no authorized source');
  });

  it('marks the material gap for a surface the question names (§6 step 7)', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'Which meetings from the last 30 days are represented?',
    });
    const meetingGap = response.coverageContext.materialGaps.find(
      (gap) => gap.surface === 'meetings',
    );
    expect(meetingGap).toBeDefined();
    expect(meetingGap!.kind).toBe('missing');
    expect(meetingGap!.why).toContain('could change the answer');
  });

  it('answers the §7 honesty question from real coverage state', async () => {
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'How much of our customer support history can you see?',
    });
    expect(response.coverageContext.honesty).not.toBeNull();
    // "customer support history" names both the interaction and the ticket
    // surface — the honesty answer covers each named surface honestly.
    expect(response.coverageContext.honesty!.surfaces).toContain('support-tickets');
    const text = response.coverageContext.honesty!.text;
    expect(text).toContain('support tickets');
    expect(text).toContain('Acme Zendesk');
    expect(text).toContain('observation(s)');
    expect(text).toContain('never claims universal capture');
  });
});

// ---------------------------------------------------------------------------
// LLM-never-authoritative (§6 steps 9-10; lock 10)
// ---------------------------------------------------------------------------

describe('runCompanyQuery — the LLM is presentation, never authority', () => {
  const structured = (
    response: Awaited<ReturnType<typeof runCompanyQuery>>,
  ): unknown => {
    const { answer } = response;
    return { ...answer, llm: undefined };
  };

  it('serves the complete structured answer with the LLM unavailable', async () => {
    llmMockState.mode = 'unavailable';
    const response = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What is our support situation?',
    });
    expect(response.answer.llm.used).toBe(false);
    expect(response.answer.llm.text).toBeNull();
    expect(response.answer.summary.length).toBeGreaterThan(0);
    expect(response.answer.claims.length).toBeGreaterThan(3);
    expect(response.answer.contradictions.length).toBeGreaterThan(0);
    expect(response.answer.unknowns.length).toBeGreaterThan(0);
  });

  it('keeps the structured answer identical when the LLM hallucinates', async () => {
    llmMockState.mode = 'unavailable';
    const withoutLlm = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What is our support situation?',
    });

    llmMockState.mode = 'hallucinate';
    const withLlm = await runCompanyQuery(member(tenantA, principalA), {
      question: 'What is our support situation?',
    });

    expect(withLlm.answer.llm.used).toBe(true);
    expect(withLlm.answer.llm.text).toContain('99 trillion');
    // The hallucination reached ONLY the presentation field: every
    // authoritative field is byte-identical to the LLM-less run.
    expect(structured(withLlm)).toEqual(structured(withoutLlm));
    expect(withLlm.coverageContext.materialGaps).toEqual(withoutLlm.coverageContext.materialGaps);
    // And it never became a claim.
    expect(
      withLlm.answer.claims.some((claim) => claim.text.includes('99 trillion')),
    ).toBe(false);

    llmMockState.mode = 'unavailable';
  });
});

// ---------------------------------------------------------------------------
// The append-only audit (this module's only persistence)
// ---------------------------------------------------------------------------

describe('the company_query_log audit', () => {
  it('rejects mutation at the storage level', async () => {
    await expect(
      getDb().query("UPDATE company_query_log SET question = 'rewritten'"),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query('DELETE FROM company_query_log')).rejects.toThrow(/append-only/);
    await expect(getDb().query('TRUNCATE company_query_log')).rejects.toThrow(/append-only/);
  });

  it('records what was asked and how strong the answer was', async () => {
    const before = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM company_query_log WHERE tenant_id = $1',
      [tenantA],
    );
    await runCompanyQuery(member(tenantA, principalA), { question: 'Audit probe?' });
    const after = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM company_query_log WHERE tenant_id = $1',
      [tenantA],
    );
    expect(Number(after.rows[0]!.count)).toBe(Number(before.rows[0]!.count) + 1);
  });
});
