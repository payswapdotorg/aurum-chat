// W044 — Tenant Isolation Verification · the provider-preferences sweep
// (W091).
//
// The provider-preferences module (W091 — User-Friendly Provider Choice
// UX) owns tenant-scoped tables for its concepts: the company-wide
// outcome priority with its organizational-policy posture, the
// per-member personal preferences, the authorization-gated technical
// overrides, and the append-only selection-explanation ledger with its
// ordinary/advanced projection seam.
//
// This sweep proves the tenant boundary at the APPLICATION level, per
// the W044 doctrine — two tenants side by side, zero leakage:
//   * preferences (both levels), overrides and explanation records of
//     one tenant are invisible to the other: every read and every
//     management call through another tenant's ids is uniformly
//     not-found (no existence leak);
//   * the ordinary explanation feed of one tenant never contains
//     another tenant's choices — and never contains technical identity
//     at all (the jargon discipline holds under two-tenant load);
//   * cross-tenant management cannot touch another tenant's state
//     before the not-found/unauthorized refusal (the tenant preference
//     and override state never move);
//   * each tenant's listings show exactly its own rows.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/provider-preferences/tests/); this sweep is the
// two-tenant proof the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import * as preferences from '@/modules/provider-preferences/contract';
import { ProviderPreferencesError } from '@/modules/provider-preferences/errors';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: ProviderPreferencesError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ProviderPreferencesError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ProviderPreferencesError)) throw error;
    expect(error.code).toBe(code);
  }
}

function sweepCandidates(tenantKey: 'a' | 'b') {
  return [
    {
      provider: `sweep-${tenantKey}-one`,
      accountRef: `acct-${tenantKey}-1`,
      projectedCostMinor: 100,
      outcomes: { cost: 100, speed: 300, quality: 1, privacy: 1 },
    },
    {
      provider: `sweep-${tenantKey}-two`,
      accountRef: `acct-${tenantKey}-2`,
      projectedCostMinor: 300,
      outcomes: { cost: 300, speed: 100, quality: 2, privacy: 2 },
    },
  ];
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 sweep — provider-preferences (W091)', () => {
  it('runs both tenants side by side with zero leakage', async () => {
    const adminA = memberOf(tenantA, ['provider-preferences:administer']);
    const adminB = memberOf(tenantB, ['provider-preferences:administer']);
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    // Each tenant sets its own preference posture and resolves its own
    // choice (A cost-first, B speed-first — deliberately different).
    await preferences.setTenantPreference(adminA, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    await preferences.setTenantPreference(adminB, {
      outcomePriority: ['speed', 'cost', 'quality', 'privacy'],
      policyFirst: false,
    });
    const resolvedA = await preferences.resolveProviderChoice(memberA, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: sweepCandidates('a'),
      dedupeKey: 'sweep-a-1',
    });
    const resolvedB = await preferences.resolveProviderChoice(memberB, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: sweepCandidates('b'),
      dedupeKey: 'sweep-b-1',
    });
    // A (cost-first) picks its cheaper option; B (speed-first) its faster one.
    expect(resolvedA.chosen!.provider).toBe('sweep-a-one');
    expect(resolvedB.chosen!.provider).toBe('sweep-b-two');

    // The listings are disjoint and each tenant sees exactly its own rows.
    const feedA = await preferences.listSelectionExplanations(memberA, {});
    const feedB = await preferences.listSelectionExplanations(memberB, {});
    expect(feedA).toHaveLength(1);
    expect(feedB).toHaveLength(1);
    expect(feedA[0]!.id).not.toBe(feedB[0]!.id);
    expect(feedA[0]!.explanation).not.toBe(feedB[0]!.explanation);
    // The ordinary feeds stay jargon-free (no technical identity of
    // EITHER tenant crosses).
    for (const entry of [...feedA, ...feedB]) {
      expect(entry).not.toHaveProperty('chosenProvider');
      expect(entry.explanation).not.toContain('sweep-a-one');
      expect(entry.explanation).not.toContain('sweep-b-two');
    }

    // Cross-tenant reads of A's record through B's context are
    // uniformly not-found — including the claim-gated technical detail
    // (an authorized B cannot read A's record: not-found, not leakage).
    await expectCode('explanation_not_found', () =>
      preferences.getSelectionExplanation(adminB, { explanationId: resolvedA.record.id }),
    );
    await expectCode('explanation_not_found', () =>
      preferences.getSelectionExplanation(adminA, { explanationId: resolvedB.record.id }),
    );
    // An unauthorized member is refused at the claim gate BEFORE any
    // id resolves (the documented order: gate first, then tenant scope).
    await expectCode('unauthorized', () =>
      preferences.getSelectionExplanation(memberA, { explanationId: resolvedB.record.id }),
    );

    // Personal preferences stay per (tenant, principal): A's member
    // never sees B's member row, and each resolves over their own fold.
    await preferences.setPersonalPreference(memberA, {
      outcomePriority: ['privacy', 'quality'],
    });
    await preferences.setPersonalPreference(memberB, {
      outcomePriority: ['cost'],
    });
    expect((await preferences.getPersonalPreference(memberA))!.outcomePriority).toEqual([
      'privacy',
      'quality',
    ]);
    expect((await preferences.getPersonalPreference(memberB))!.outcomePriority).toEqual(['cost']);
    const profileA = await preferences.getResolvedPreference(memberA);
    const profileB = await preferences.getResolvedPreference(memberB);
    expect(profileA.source).toBe('personal-preference');
    expect(profileB.source).toBe('personal-preference');
    expect(profileA.outcomePriority).not.toEqual(profileB.outcomePriority);
  });

  it('cross-tenant management cannot touch another tenant’s state (uniform refusals, no movement)', async () => {
    const adminA = memberOf(tenantA, ['provider-preferences:administer']);
    const adminB = memberOf(tenantB, ['provider-preferences:administer']);
    const memberA = memberOf(tenantA);

    // A sets an override; B's authorized admin can neither see nor
    // clear it (scope keys are tenant-scoped — B sees its own absence).
    const set = await preferences.setTechnicalOverride(adminA, {
      gateway: 'llm',
      capability: 'text-generation',
      provider: 'sweep-a-one',
      reason: 'Sweep tenant A pin.',
    });
    expect(set.override.status).toBe('active');
    await expectCode('override_not_found', () =>
      preferences.getTechnicalOverride(adminB, {
        gateway: 'llm',
        capability: 'text-generation',
      }),
    );
    await expectCode('override_not_found', () =>
      preferences.clearTechnicalOverride(adminB, {
        gateway: 'llm',
        capability: 'text-generation',
      }),
    );
    // A's override is untouched by B's attempt.
    const stillActive = await preferences.getTechnicalOverride(adminA, {
      gateway: 'llm',
      capability: 'text-generation',
    });
    expect(stillActive.id).toBe(set.override.id);
    expect(stillActive.status).toBe('active');

    // The override lists are disjoint.
    const overridesA = await preferences.listTechnicalOverrides(adminA, {});
    const overridesB = await preferences.listTechnicalOverrides(adminB, {});
    expect(overridesA.map((override) => override.id)).not.toContain(
      overridesB.map((override) => override.id)[0],
    );
    expect(overridesA).toHaveLength(1);
    expect(overridesB).toHaveLength(0);

    // A tenant id from B never influences A's resolution: A's next
    // resolve with the same dedupe key replays A's own record only.
    const replay = await preferences.resolveProviderChoice(memberA, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: sweepCandidates('a'),
      dedupeKey: 'sweep-a-1',
    });
    expect(replay.created).toBe(false);
    expect(replay.chosen!.provider).toBe('sweep-a-one');

    // The audit feeds stay per-tenant (B saw no events of A's changes).
    const eventsA = await preferences.listProviderPreferenceEvents(memberA, {});
    const eventsB = await preferences.listProviderPreferenceEvents(
      memberOf(tenantB),
      {},
    );
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.filter((event) => event.tenantId === tenantA)).toHaveLength(0);
  });
});
