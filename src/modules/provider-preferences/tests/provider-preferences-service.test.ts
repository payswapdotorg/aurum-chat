// Integration tests for the provider-preferences module against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port. Covers
// the W091 acceptance: "ordinary user never needs provider jargon;
// preference can be changed at any time; system explains why a provider
// was selected; technical override remains available to authorized
// advanced users."
//
//   * preferences — the tenant level (claim-gated; changeable any time)
//     and the personal level (any member; the principal comes from the
//     context); the resolved-profile fold with its source attribution,
//     including the honest policy-first case where a recorded personal
//     preference does NOT become the routing source;
//   * the "why" ledger — resolveProviderChoice end to end: the
//     preference ranking, the honest single-choice and no-choice cases,
//     the W090 budget-policy consult (a provider-billing budget blocks a
//     priced candidate; the explanation counts the exclusion), the
//     override-wins path, the override-unavailable path, and the
//     idempotent dedupe replay (first write wins);
//   * jargon discipline — the ORDINARY projection carries no technical
//     identity even when the underlying records name providers; the
//     FULL record is behind the administer claim;
//   * the override — claim-gated set/clear, reversible (set again after
//     clear re-activates the scope), audited on the append-only feed
//     (which storage-level triggers keep append-only);
//   * recordSelectionExplanation — the standalone recorder builds the
//     same jargon-free language from structured fields;
//   * authority boundaries — the unauthorized cases throw 'unauthorized'
//     (tenant preference, override set/clear, technical detail read).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { recordProviderUsage, setProviderBudget } from '@/modules/provider-billing/contract';
import { ProviderPreferencesError } from '../errors';
import * as contract from '../contract';

const {
  clearPersonalPreference,
  clearTechnicalOverride,
  getPersonalPreference,
  getResolvedPreference,
  getSelectionExplanation,
  getTechnicalOverride,
  getTenantPreference,
  listProviderPreferenceEvents,
  listSelectionExplanations,
  listTechnicalOverrides,
  PROVIDER_PREFERENCE_OUTCOMES,
  recordSelectionExplanation,
  resolveProviderChoice,
  setPersonalPreference,
  setTechnicalOverride,
  setTenantPreference,
} = contract;

const ADMIN_CLAIM = 'provider-preferences:administer';

function memberOf(tenantId: string, authority: string[] = [], principalId = newId()): TenantContext {
  return { tenantId, principalId, authority };
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

/** Every provider-ish token that must never appear in ordinary language. */
const FORBIDDEN = ['alpha-corp', 'beta-labs', 'openai', 'anthropic', 'mistral', 'acct-alpha'];

function candidates() {
  return [
    {
      provider: 'alpha-corp',
      accountRef: 'acct-alpha',
      projectedCostMinor: 500,
      outcomes: { cost: 500, speed: 900, quality: 2, privacy: 3 },
    },
    {
      provider: 'beta-labs',
      accountRef: 'acct-beta',
      projectedCostMinor: 900,
      outcomes: { cost: 900, speed: 300, quality: 2, privacy: 3 },
    },
    {
      provider: 'openai',
      accountRef: 'acct-openai',
      projectedCostMinor: 700,
      outcomes: { cost: 700, speed: 600, quality: 1, privacy: 1 },
    },
  ];
}

let clockMs: number;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  clockMs = Date.parse('2026-10-05T12:00:00Z');
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Preferences — both levels, changeable any time
// ---------------------------------------------------------------------------

describe('preferences (tenant level + personal level)', () => {
  const tenant = newId();
  const admin = memberOf(tenant, [ADMIN_CLAIM]);
  const plain = memberOf(tenant);

  it('starts honest: nothing set → the documented balanced default', async () => {
    expect(await getTenantPreference(plain)).toBeNull();
    expect(await getPersonalPreference(plain)).toBeNull();
    const profile = await getResolvedPreference(plain);
    expect(profile.source).toBe('default');
    expect(profile.outcomePriority).toEqual(contract.DEFAULT_OUTCOME_PRIORITY);
  });

  it('the tenant preference is claim-gated (an ordinary member cannot set company policy)', async () => {
    await expectCode('unauthorized', () =>
      setTenantPreference(plain, { outcomePriority: ['cost'], policyFirst: false }),
    );
    const set = await setTenantPreference(admin, {
      outcomePriority: ['cost', 'quality', 'speed', 'privacy'],
      policyFirst: false,
    });
    expect(set.outcomePriority).toEqual(['cost', 'quality', 'speed', 'privacy']);
    expect(set.policyFirst).toBe(false);
    expect(await getTenantPreference(plain)).toEqual(set);
  });

  it('the tenant preference can be CHANGED at any time; every change lands on the audit feed', async () => {
    const first = await setTenantPreference(admin, {
      outcomePriority: ['cost'],
      policyFirst: false,
    });
    clockMs += 1_000;
    const second = await setTenantPreference(admin, {
      outcomePriority: ['privacy', 'speed'],
      policyFirst: true,
    });
    expect(second.outcomePriority).toEqual(['privacy', 'speed']);
    expect(second.policyFirst).toBe(true);
    expect(first.updatedAt).not.toBe(second.updatedAt);
    const events = await listProviderPreferenceEvents(plain, {});
    const tenantSets = events.filter((event) => event.event === 'tenant-preference-set');
    expect(tenantSets.length).toBeGreaterThanOrEqual(2);
    expect(tenantSets[0]!.detail).toContain('privacy > speed');
    expect(tenantSets[0]!.detail).toContain('organizational policy decides');
  });

  it('the personal preference needs no claim (any member, any time, their own row only)', async () => {
    const set = await setPersonalPreference(plain, {
      outcomePriority: ['speed', 'cost', 'quality', 'privacy'],
    });
    expect(set.outcomePriority).toEqual(['speed', 'cost', 'quality', 'privacy']);
    // A different member of the SAME tenant sees nothing of it.
    const other = memberOf(tenant);
    expect(await getPersonalPreference(other)).toBeNull();
    // Changeable any time.
    clockMs += 1_000;
    const changed = await setPersonalPreference(plain, { outcomePriority: ['privacy'] });
    expect(changed.outcomePriority).toEqual(['privacy']);
    const events = await listProviderPreferenceEvents(plain, {});
    expect(events.filter((event) => event.event === 'personal-preference-set').length).toBe(2);
    // Clearing returns the member to the company/default fold.
    await clearPersonalPreference(plain);
    expect(await getPersonalPreference(plain)).toBeNull();
    const after = await getResolvedPreference(plain);
    expect(after.source).toBe('organizational-policy');
    const afterEvents = await listProviderPreferenceEvents(plain, {});
    expect(
      afterEvents.filter((event) => event.event === 'personal-preference-cleared').length,
    ).toBe(1);
  });

  it('the resolved profile folds honestly: personal wins the company default; policy-first wins everything', async () => {
    const tenant2 = newId();
    const admin2 = memberOf(tenant2, [ADMIN_CLAIM]);
    const member2 = memberOf(tenant2);
    await setTenantPreference(admin2, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    await setPersonalPreference(member2, { outcomePriority: ['quality'] });
    const personal = await getResolvedPreference(member2);
    expect(personal.source).toBe('personal-preference');
    expect(personal.outcomePriority).toEqual(['quality']);
    // Company goes policy-first: the recorded personal preference no
    // longer bends routing — the honest "policy decided" case.
    await setTenantPreference(admin2, {
      outcomePriority: ['privacy', 'cost'],
      policyFirst: true,
    });
    const policy = await getResolvedPreference(member2);
    expect(policy.source).toBe('organizational-policy');
    expect(policy.outcomePriority).toEqual(['privacy', 'cost']);
    expect(policy.policyFirst).toBe(true);
    // The personal preference itself is still there, still changeable.
    expect((await getPersonalPreference(member2))!.outcomePriority).toEqual(['quality']);
  });
});

// ---------------------------------------------------------------------------
// resolveProviderChoice — the composed policy resolution + the "why" ledger
// ---------------------------------------------------------------------------

describe('resolveProviderChoice', () => {
  /** A fresh tenant per case: every resolution is independent state. */
  function fresh(authority: string[] = [ADMIN_CLAIM, 'provider-billing:administer']): {
    admin: TenantContext;
    plain: TenantContext;
  } {
    const tenant = newId();
    return {
      admin: memberOf(tenant, authority),
      plain: memberOf(tenant),
    };
  }

  it('ranks by the resolved preference and records the jargon-free explanation', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-cost-1',
    });
    // cost-first: alpha-corp (500) beats openai (700) beats beta-labs (900).
    expect(resolved.chosen!.provider).toBe('alpha-corp');
    expect(resolved.chosen!.accountRef).toBe('acct-alpha');
    expect(resolved.decision).toBe('preference');
    expect(resolved.preferenceSource).toBe('tenant-priority');
    expect(resolved.decidingOutcome).toBe('cost');
    expect(resolved.explanation).toContain('lowest cost');
    expect(resolved.explanation).toContain('Your company');
    for (const token of FORBIDDEN) {
      expect(resolved.explanation.toLowerCase().includes(token)).toBe(false);
    }
  });

  it('a personal preference changes the ranking (the member steers their own routing)', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    const speedFirst = plain;
    await setPersonalPreference(speedFirst, { outcomePriority: ['speed', 'cost'] });
    const resolved = await resolveProviderChoice(speedFirst, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-speed-1',
    });
    // speed-first: beta-labs (300) wins.
    expect(resolved.chosen!.provider).toBe('beta-labs');
    expect(resolved.preferenceSource).toBe('personal-preference');
    expect(resolved.decidingOutcome).toBe('speed');
    expect(resolved.explanation).toContain('You asked for');
    expect(resolved.explanation).toContain('fastest response');
  });

  it('policy-first: the company posture decides even against a personal preference', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['privacy', 'quality', 'cost', 'speed'],
      policyFirst: true,
    });
    await setPersonalPreference(plain, { outcomePriority: ['speed'] });
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-policy-1',
    });
    // privacy-first: openai (privacy 1) wins, and company policy is the
    // honest attribution — not the member's recorded speed preference.
    expect(resolved.chosen!.provider).toBe('openai');
    expect(resolved.preferenceSource).toBe('organizational-policy');
    expect(resolved.decidingOutcome).toBe('privacy');
    expect(resolved.explanation).toContain('Company policy decides');
  });

  it('the honest single-choice case: one option says so; the preference is still recorded', async () => {
    const { plain } = fresh();
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'embedding',
      candidates: [candidates()[1]!],
      dedupeKey: 'route-single-1',
    });
    expect(resolved.decision).toBe('single-choice');
    expect(resolved.chosen!.provider).toBe('beta-labs');
    expect(resolved.explanation).toContain('Only one option was available');
    expect(resolved.record.decision).toBe('single-choice');
    expect(resolved.created).toBe(true);
  });

  it('the honest no-choice case: nothing chosen, the moment recorded (never swallowed)', async () => {
    const { plain } = fresh();
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: [],
      dedupeKey: 'route-none-1',
    });
    expect(resolved.chosen).toBeNull();
    expect(resolved.decision).toBe('no-choice');
    expect(resolved.explanation).toContain('No option was available');
    const feed = await listSelectionExplanations(plain, { capability: 'text-generation' });
    const none = feed.find((entry) => entry.decision === 'no-choice');
    expect(none).toBeDefined();
    expect(none!.explanation).toContain('No option was available');
  });

  it('W090 budget policy excludes a priced candidate; the explanation counts the exclusion', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    // A tenant budget of 1100 minor with 400 already attributed this
    // month: alpha-corp (projected 500 → 900 total, allowed), openai
    // (700 → 1100, allowed), beta-labs (900 → 1300, BLOCKED by the
    // billing gateway's own routing read).
    await setProviderBudget(admin, {
      scope: 'tenant',
      budgetMinor: 1_100,
      enforcement: 'block',
    });
    await recordProviderUsage(plain, {
      gateway: 'llm',
      provider: 'alpha-corp',
      capability: 'text-generation',
      costMinor: 400,
      dedupeKey: 'seed-usage-1',
    });
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-budget-1',
    });
    expect(resolved.budgetExcludedCount).toBe(1);
    expect(resolved.explanation).toContain('spending limit');
    expect(resolved.explanation).toContain('excluded one other option');
    // The blocked candidate never becomes the chosen option.
    expect(resolved.chosen!.provider).toBe('alpha-corp');
  });

  it('an active technical override WINS among available options (audited, advanced-only)', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    await setTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'text-generation',
      provider: 'openai',
      reason: 'Regulated workload must stay on the contracted option.',
    });
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-override-1',
    });
    // cost-first would pick alpha-corp (500); the authorized pin wins.
    expect(resolved.decision).toBe('technical-override');
    expect(resolved.chosen!.provider).toBe('openai');
    expect(resolved.explanation).toContain('authorized technical override');
    // The override does not leak into ordinary language.
    for (const token of FORBIDDEN) {
      expect(resolved.explanation.toLowerCase().includes(token)).toBe(false);
    }
  });

  it('an override naming an UNAVAILABLE option says so and the preference chooses instead', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    await setTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'embedding',
      provider: 'anthropic',
      reason: 'Pinned option for embeddings.',
    });
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'embedding',
      candidates: candidates(),
      dedupeKey: 'route-override-unavailable-1',
    });
    expect(resolved.decision).toBe('preference');
    expect(resolved.chosen!.provider).toBe('alpha-corp');
    expect(resolved.overrideUnavailable).toBe(true);
    expect(resolved.explanation).toContain('was not available');
  });

  it('idempotent by dedupe key: a replay returns the ORIGINAL resolution (first write wins)', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    const first = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-replay-1',
    });
    // Preferences change afterwards…
    await setTenantPreference(admin, {
      outcomePriority: ['privacy'],
      policyFirst: false,
    });
    const replay = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-replay-1',
    });
    expect(replay.created).toBe(false);
    expect(first.created).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(replay.chosen!.provider).toBe(first.chosen!.provider);
    expect(replay.explanation).toBe(first.explanation);
    // Only one record exists for the key.
    const feed = await listSelectionExplanations(plain, {});
    expect(feed.filter((entry) => entry.id === first.record.id)).toHaveLength(1);
  });

  it('the ORDINARY feed carries no technical identity even though the records name providers', async () => {
    const { plain } = fresh();
    await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-feed-1',
    });
    const feed = await listSelectionExplanations(plain, {});
    expect(feed.length).toBeGreaterThan(0);
    for (const entry of feed) {
      expect(entry).not.toHaveProperty('chosenProvider');
      expect(entry).not.toHaveProperty('chosenAccountRef');
      expect(entry).not.toHaveProperty('gateway');
      for (const token of FORBIDDEN) {
        expect(entry.explanation.toLowerCase().includes(token)).toBe(false);
      }
    }
    // Every deciding outcome of the feed is within vocabulary.
    for (const entry of feed) {
      if (entry.decidingOutcome !== null) {
        expect(PROVIDER_PREFERENCE_OUTCOMES).toContain(entry.decidingOutcome);
      }
    }
  });

  it('the FULL record (technical identity included) is claim-gated', async () => {
    const { admin, plain } = fresh();
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'route-detail-1',
    });
    await expectCode('unauthorized', () =>
      getSelectionExplanation(plain, { explanationId: resolved.record.id }),
    );
    const full = await getSelectionExplanation(admin, {
      explanationId: resolved.record.id,
    });
    expect(full.chosenProvider).toBe(resolved.chosen!.provider);
    expect(full.chosenAccountRef).toBe(resolved.chosen!.accountRef);
    expect(full.gateway).toBe('llm');
    expect(full.explanation).toBe(resolved.explanation);
    await expectCode('explanation_not_found', () =>
      getSelectionExplanation(admin, { explanationId: newId() }),
    );
  });

  it('candidates without a projected cost are never budget-blocked (the billing gateway only blocks what it can price)', async () => {
    const { admin, plain } = fresh();
    await setTenantPreference(admin, {
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    // A crushing budget — but the candidates carry no projected cost.
    await setProviderBudget(admin, {
      scope: 'tenant',
      budgetMinor: 1,
      enforcement: 'block',
    });
    const unpriced = candidates().map((candidate) => ({
      provider: candidate.provider,
      accountRef: candidate.accountRef,
      outcomes: candidate.outcomes,
    }));
    const resolved = await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: unpriced,
      dedupeKey: 'route-unpriced-1',
    });
    expect(resolved.budgetExcludedCount).toBe(0);
    expect(resolved.chosen!.provider).toBe('alpha-corp');
  });
});

// ---------------------------------------------------------------------------
// recordSelectionExplanation — the standalone recorder
// ---------------------------------------------------------------------------

describe('recordSelectionExplanation', () => {
  const tenant = newId();
  const gatewayCaller = memberOf(tenant);

  it('builds the same jargon-free language from structured fields (a gateway that chose on its own)', async () => {
    const { record, created } = await recordSelectionExplanation(gatewayCaller, {
      gateway: 'llm',
      capability: 'text-generation',
      chosenProvider: 'anthropic',
      chosenAccountRef: 'acct-anthropic',
      decision: 'preference',
      preferenceSource: 'personal-preference',
      decidingOutcome: 'privacy',
      candidatesConsidered: 2,
      dedupeKey: 'gateway-choice-1',
    });
    expect(created).toBe(true);
    expect(record.chosenProvider).toBe('anthropic');
    expect(record.explanation).toContain('strongest data protection');
    for (const token of FORBIDDEN) {
      expect(record.explanation.toLowerCase().includes(token)).toBe(false);
    }
    // The ordinary feed shows the same moment without the identity.
    const feed = await listSelectionExplanations(gatewayCaller, {});
    const view = feed.find((entry) => entry.id === record.id);
    expect(view).toBeDefined();
    expect(view!.explanation).toBe(record.explanation);
    expect(view).not.toHaveProperty('chosenProvider');
    // Idempotent replay.
    const replay = await recordSelectionExplanation(gatewayCaller, {
      gateway: 'llm',
      capability: 'text-generation',
      chosenProvider: 'openai',
      decision: 'preference',
      preferenceSource: 'default',
      candidatesConsidered: 2,
      dedupeKey: 'gateway-choice-1',
    });
    expect(replay.created).toBe(false);
    expect(replay.record.chosenProvider).toBe('anthropic');
  });

  it('rejects a no-choice record that claims a provider (nothing chosen is nothing)', async () => {
    await expectCode('invalid_input', () =>
      recordSelectionExplanation(gatewayCaller, {
        gateway: 'llm',
        capability: 'text-generation',
        chosenProvider: 'openai',
        decision: 'no-choice',
        preferenceSource: 'default',
        candidatesConsidered: 0,
        dedupeKey: 'gateway-none-1',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The technical override — gated, reversible, audited
// ---------------------------------------------------------------------------

describe('technical overrides', () => {
  const tenant = newId();
  const admin = memberOf(tenant, [ADMIN_CLAIM]);
  const plain = memberOf(tenant);

  it('set/clear/list/get are claim-gated (the authorization gate)', async () => {
    await expectCode('unauthorized', () =>
      setTechnicalOverride(plain, {
        gateway: 'llm',
        provider: 'openai',
        reason: 'No.',
      }),
    );
    await expectCode('unauthorized', () => clearTechnicalOverride(plain, { gateway: 'llm' }));
    await expectCode('unauthorized', () => listTechnicalOverrides(plain, {}));
    await expectCode('unauthorized', () => getTechnicalOverride(plain, { gateway: 'llm' }));
  });

  it('set → clear → set again is reversible and every step is audited', async () => {
    const set1 = await setTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'text-generation',
      provider: 'openai',
      reason: 'Contractual commitment until Q4.',
    });
    expect(set1.created).toBe(true);
    expect(set1.override.status).toBe('active');
    expect(set1.override.reason).toBe('Contractual commitment until Q4.');

    clockMs += 1_000;
    const cleared = await clearTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'text-generation',
    });
    expect(cleared.status).toBe('retired');
    expect(cleared.retiredBy).toBe(admin.principalId);
    expect(cleared.retiredAt).not.toBeNull();
    // Clearing again is not-found (already retired).
    await expectCode('override_not_found', () =>
      clearTechnicalOverride(admin, { gateway: 'llm', capability: 'text-generation' }),
    );

    clockMs += 1_000;
    const set2 = await setTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'text-generation',
      provider: 'anthropic',
      reason: 'Switched pin after review.',
    });
    expect(set2.created).toBe(false);
    expect(set2.override.status).toBe('active');
    expect(set2.override.provider).toBe('anthropic');
    expect(set2.override.retiredAt).toBeNull();
    expect(set2.override.setBy).toBe(admin.principalId);

    const events = await listProviderPreferenceEvents(plain, {});
    const overrideEvents = events.filter((event) => event.event.startsWith('override-'));
    expect(overrideEvents.map((event) => event.event)).toEqual([
      'override-set',
      'override-cleared',
      'override-set',
    ]);
    // The audit detail stays jargon-free (the technical identity lives
    // on the claim-gated override rows, not in the audit language).
    for (const event of overrideEvents) {
      for (const token of ['openai', 'anthropic']) {
        expect(event.detail.includes(token)).toBe(false);
      }
    }
  });

  it('scopes are distinct per capability; gateway-wide is its own scope', async () => {
    await setTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'text-generation',
      provider: 'openai',
      reason: 'Text pin.',
    });
    await setTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'embedding',
      provider: 'mistral',
      reason: 'Embedding pin.',
    });
    await setTechnicalOverride(admin, {
      gateway: 'agents',
      capability: null,
      provider: 'anthropic',
      reason: 'Whole-gateway pin.',
    });
    const all = await listTechnicalOverrides(admin, {});
    expect(all.filter((override) => override.status === 'active')).toHaveLength(3);
    const byGateway = await listTechnicalOverrides(admin, { gateway: 'llm' });
    expect(byGateway).toHaveLength(2);
    const text = await getTechnicalOverride(admin, {
      gateway: 'llm',
      capability: 'text-generation',
    });
    expect(text.provider).toBe('openai');
    await expectCode('override_not_found', () =>
      getTechnicalOverride(admin, { gateway: 'llm', capability: 'vision' }),
    );
  });

  it('reason is required human language', async () => {
    await expectCode('invalid_input', () =>
      setTechnicalOverride(admin, { gateway: 'llm', provider: 'openai', reason: '' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage discipline — the append-only ledgers
// ---------------------------------------------------------------------------

describe('storage discipline (append-only ledgers)', () => {
  const tenant = newId();
  const admin = memberOf(tenant, [ADMIN_CLAIM]);
  const plain = memberOf(tenant);

  it('UPDATE/DELETE on the audit and explanation ledgers is refused by the storage layer', async () => {
    await setTenantPreference(admin, { outcomePriority: ['cost'], policyFirst: false });
    await resolveProviderChoice(plain, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: candidates(),
      dedupeKey: 'ledger-1',
    });
    await expect(
      getDb().query(`UPDATE provider_preference_events SET detail = 'rewritten' WHERE tenant_id = $1`, [
        tenant,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM provider_selection_explanations WHERE tenant_id = $1`, [tenant]),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE provider_preference_events`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('the audit feed orders deterministically (recorded_at DESC, position DESC)', async () => {
    const before = await listProviderPreferenceEvents(plain, { limit: 3 });
    expect(before.length).toBeLessThanOrEqual(3);
    const positions = before.map((event) => event.position);
    expect([...positions].sort((a, b) => b - a)).toEqual(positions);
  });
});
