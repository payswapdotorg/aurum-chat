// W044 — Tenant Isolation Verification · application-boundary sweep for the
// company-query module (W126 — the query plane over authorized evidence).
//
// The query plane COMPOSES other modules' contracts, so its isolation proof
// is the composition boundary itself: two tenants with private evidence,
// sources, epistemics and world state; a query in tenant A must answer
// ONLY from tenant A's state (no claims, provenance, contradictions,
// unknowns, coverage sources or honesty wording from tenant B), and the
// append-only query audit must land only in the asking tenant. There is
// deliberately no id-bearing lookup on this surface (the query scope IS
// the TenantContext), so the no-existence-leak discipline is asserted at
// the listing/derivation layer: uniform emptiness, disjoint listings, and
// a CoverageGap that never reveals another tenant's data (the
// architecture's §13 rule).
//
// All cross-module imports go through `@/modules/<m>/contract` only.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

import { runCompanyQuery } from '@/modules/company-query/contract';
import { recordObservation } from '@/modules/observations/contract';
import { registerSource } from '@/modules/sources/contract';
import { recordClaim, recordUnknown } from '@/modules/epistemics/contract';

const T0 = '2026-09-30T10:00:00.000Z';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

const tenantA = newId();
const tenantB = newId();

const A_MARKER = 'ISOLATION-A-MARKER';
const B_MARKER = 'ISOLATION-B-MARKER';

beforeAll(async () => {
  await runMigrations(getDb());

  for (const [tenantId, marker] of [
    [tenantA, A_MARKER],
    [tenantB, B_MARKER],
  ] as const) {
    const who = member(tenantId);
    const zendesk = (
      await registerSource(who, {
        provider: 'zendesk',
        providerAccountId: `ZENDESK-${marker}`,
        displayName: `Zendesk ${marker}`,
        authKind: 'credentials',
        credentialRef: `secret-store://zendesk-${marker}`,
      })
    ).source;
    const observation = await recordObservation(who, {
      kind: 'support.ticket.created',
      payload: { subject: marker },
      observedAt: T0,
      source: { kind: 'source', id: zendesk.id },
      channel: 'api',
      confidence: { value: 0.9, method: 'source_trust', basis: 'connector' },
    });
    await recordClaim(who, {
      proposition: `One support ticket carrying ${marker} was observed`,
      evidenceObservationIds: [observation.id],
      confidence: { value: 0.9, method: 'evidence_count', basis: 'one observation' },
    });
    await recordUnknown(who, {
      question: `Which conversations about ${marker} happen outside Zendesk?`,
      consequence: 'coverage claims may overstate what is visible',
    });
  }
});

afterAll(async () => {
  await closeDb();
});

describe('W126 company-query — tenant isolation at the composition boundary', () => {
  it('answers tenant A only from tenant A state (claims, provenance, unknowns)', async () => {
    const response = await runCompanyQuery(member(tenantA), {
      question: 'What is happening in support?',
    });
    const serialized = JSON.stringify(response);
    expect(serialized).toContain(A_MARKER);
    expect(serialized).not.toContain(B_MARKER);
    // Every provenance chip resolves to tenant A's observation.
    for (const claim of response.answer.claims) {
      for (const chip of claim.provenance) {
        expect(chip.sourceLabel).toBe(`Zendesk ${A_MARKER}`);
      }
    }
    expect(response.answer.unknowns.every((unknown) => unknown.question.includes(A_MARKER))).toBe(
      true,
    );
  });

  it('answers tenant B only from tenant B state (disjoint listings)', async () => {
    const response = await runCompanyQuery(member(tenantB), {
      question: 'What is happening in support?',
    });
    const serialized = JSON.stringify(response);
    expect(serialized).toContain(B_MARKER);
    expect(serialized).not.toContain(A_MARKER);
  });

  it('coverage context never reveals the other tenant (sources + gaps, §13)', async () => {
    const response = await runCompanyQuery(member(tenantA), {
      question: 'How much of our customer support history can you see?',
    });
    const support = response.coverageContext.surfaces.find(
      (summary) => summary.surface === 'support-tickets',
    )!;
    expect(support.contributingSources.map((source) => source.displayName)).toEqual([
      `Zendesk ${A_MARKER}`,
    ]);
    // A gap names the SURFACE and the reason — never another tenant's data.
    for (const gap of response.coverageContext.materialGaps) {
      expect(JSON.stringify(gap)).not.toContain(B_MARKER);
    }
    expect(response.coverageContext.honesty).not.toBeNull();
    expect(response.coverageContext.honesty!.text).not.toContain(B_MARKER);
  });

  it('the append-only audit lands only in the asking tenant', async () => {
    await runCompanyQuery(member(tenantA), { question: 'Audit isolation A?' });
    await runCompanyQuery(member(tenantB), { question: 'Audit isolation B?' });
    const rows = (await getDb().query<{ tenant_id: string; question: string }>(
      'SELECT tenant_id, question FROM company_query_log',
    )).rows;
    expect(rows.filter((row) => row.tenant_id === tenantA).length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((row) => row.tenant_id === tenantB).length).toBeGreaterThanOrEqual(1);
    expect(
      rows.filter((row) => row.tenant_id === tenantA).every((row) => !row.question.includes('B?')),
    ).toBe(true);
  });
});
