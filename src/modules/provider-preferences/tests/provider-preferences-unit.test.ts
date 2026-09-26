// Unit tests for the provider-preferences module's PURE policy core and
// validation (W091) — no database, no clock, no network:
//
//   * resolvePreferenceProfile — the deterministic two-level fold and
//     its honest precedence (policy-first → personal → tenant → the
//     documented balanced default);
//   * rankProviderCandidates — the deterministic outcome-priority
//     ranker: primary outcome first, tie-breaks down the priority,
//     missing signals are worst, full ties preserve input order, and
//     the deciding outcome is the one that separated winner from
//     runner-up;
//   * buildSelectionExplanation — the jargon-free sentence builder:
//     every decision/source shape carries user language, and NO output
//     ever contains a provider key (the acceptance's first clause,
//     enforced at the pure core);
//   * the validation guards (vocabularies, unknown keys, shapes).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTCOME_PRIORITY,
  buildSelectionExplanation,
  outcomePhrase,
  preferenceSourcePhrase,
  rankProviderCandidates,
  resolvePreferenceProfile,
  selectionDecisionLabel,
  toOrdinaryExplanationView,
} from '../policy';
import {
  DEFAULT_OUTCOME_PRIORITY as VALIDATED_DEFAULT,
  MAX_CANDIDATES,
  PROVIDER_PREFERENCE_OUTCOMES,
  overrideScopeKey,
  validateListSelectionExplanationsQuery,
  validateRecordSelectionExplanationInput,
  validateResolveProviderChoiceInput,
  validateSetPersonalPreferenceInput,
  validateSetTechnicalOverrideInput,
  validateSetTenantPreferenceInput,
} from '../validation';
import { ProviderPreferencesError } from '../errors';
import type { ProviderCandidate, ProviderPreferenceOutcome } from '../types';

// ---------------------------------------------------------------------------
// resolvePreferenceProfile — the two-level fold
// ---------------------------------------------------------------------------

describe('resolvePreferenceProfile', () => {
  it('nothing set → the documented balanced default, source "default"', () => {
    const profile = resolvePreferenceProfile(null, null);
    expect(profile.outcomePriority).toEqual([...DEFAULT_OUTCOME_PRIORITY]);
    expect(profile.source).toBe('default');
    expect(profile.policyFirst).toBe(false);
  });

  it('tenant set (not policy-first), no personal → tenant priority, source "tenant-priority"', () => {
    const profile = resolvePreferenceProfile(
      { outcomePriority: ['cost', 'quality', 'speed', 'privacy'], policyFirst: false },
      null,
    );
    expect(profile.outcomePriority).toEqual(['cost', 'quality', 'speed', 'privacy']);
    expect(profile.source).toBe('tenant-priority');
    expect(profile.policyFirst).toBe(false);
  });

  it('personal set (tenant not policy-first) → the member’s own priority wins the default', () => {
    const profile = resolvePreferenceProfile(
      { outcomePriority: ['cost', 'quality', 'speed', 'privacy'], policyFirst: false },
      { outcomePriority: ['privacy', 'quality', 'speed', 'cost'] },
    );
    expect(profile.outcomePriority).toEqual(['privacy', 'quality', 'speed', 'cost']);
    expect(profile.source).toBe('personal-preference');
  });

  it('policy-first → company policy decides even when a personal preference exists (the honest fold)', () => {
    const profile = resolvePreferenceProfile(
      { outcomePriority: ['privacy', 'cost', 'quality', 'speed'], policyFirst: true },
      { outcomePriority: ['speed', 'cost', 'quality', 'privacy'] },
    );
    expect(profile.outcomePriority).toEqual(['privacy', 'cost', 'quality', 'speed']);
    expect(profile.source).toBe('organizational-policy');
    expect(profile.policyFirst).toBe(true);
  });

  it('personal set, no tenant → personal priority', () => {
    const profile = resolvePreferenceProfile(null, {
      outcomePriority: ['speed', 'cost'],
    });
    expect(profile.outcomePriority).toEqual(['speed', 'cost']);
    expect(profile.source).toBe('personal-preference');
  });

  it('priorities are copied, not shared (mutation safety)', () => {
    const tenantPriority: ProviderPreferenceOutcome[] = ['cost', 'speed', 'quality', 'privacy'];
    const profile = resolvePreferenceProfile(
      { outcomePriority: tenantPriority, policyFirst: false },
      null,
    );
    tenantPriority[0] = 'privacy';
    expect(profile.outcomePriority[0]).toBe('cost');
  });

  it('the default is the validated default (the two constants are one)', () => {
    expect([...DEFAULT_OUTCOME_PRIORITY]).toEqual([...VALIDATED_DEFAULT]);
    expect(new Set(DEFAULT_OUTCOME_PRIORITY)).toEqual(new Set(PROVIDER_PREFERENCE_OUTCOMES));
  });
});

// ---------------------------------------------------------------------------
// rankProviderCandidates — the deterministic ranker
// ---------------------------------------------------------------------------

function candidate(
  provider: string,
  outcomes: Partial<Record<ProviderPreferenceOutcome, number>>,
  extra: Partial<ProviderCandidate> = {},
): ProviderCandidate {
  return { provider, outcomes, ...extra };
}

describe('rankProviderCandidates', () => {
  const candidates = [
    candidate('alpha', { cost: 100, speed: 900, quality: 2, privacy: 3 }),
    candidate('beta', { cost: 200, speed: 500, quality: 2, privacy: 3 }),
    candidate('gamma', { cost: 150, speed: 700, quality: 1, privacy: 2 }),
  ];

  it('ranks by the FIRST outcome of the priority', () => {
    const ranking = rankProviderCandidates(candidates, ['cost', 'speed', 'quality', 'privacy']);
    expect(ranking.ordered.map((entry) => entry.candidate.provider)).toEqual([
      'alpha',
      'gamma',
      'beta',
    ]);
    expect(ranking.decidingOutcome).toBe('cost');
  });

  it('a different first outcome re-orders (the tenant’s priority drives ranking, nothing else)', () => {
    const ranking = rankProviderCandidates(candidates, ['speed', 'cost', 'quality', 'privacy']);
    expect(ranking.ordered.map((entry) => entry.candidate.provider)).toEqual([
      'beta',
      'gamma',
      'alpha',
    ]);
    expect(ranking.decidingOutcome).toBe('speed');
  });

  it('ties fall through to the next prioritized outcome', () => {
    // alpha and beta tie on quality (2) and privacy (3); the priority
    // says quality first, then cost — alpha (cost 100) beats beta (200).
    const ranking = rankProviderCandidates(candidates, ['quality', 'cost', 'privacy', 'speed']);
    expect(ranking.ordered.map((entry) => entry.candidate.provider)).toEqual([
      'gamma',
      'alpha',
      'beta',
    ]);
    expect(ranking.decidingOutcome).toBe('quality');
  });

  it('a missing signal is unknown = worst for that outcome', () => {
    const withMissing = [
      candidate('alpha', { cost: 100 }),
      candidate('beta', { cost: 200, privacy: 1 }),
    ];
    const byPrivacy = rankProviderCandidates(withMissing, ['privacy', 'cost', 'quality', 'speed']);
    expect(byPrivacy.ordered.map((entry) => entry.candidate.provider)).toEqual(['beta', 'alpha']);
    expect(byPrivacy.decidingOutcome).toBe('privacy');
  });

  it('a full tie preserves input order (the ranker privileges nothing)', () => {
    const twins = [
      candidate('first', { cost: 100 }),
      candidate('second', { cost: 100 }),
      candidate('third', { cost: 100 }),
    ];
    const ranking = rankProviderCandidates(twins, ['cost', 'speed', 'quality', 'privacy']);
    expect(ranking.ordered.map((entry) => entry.candidate.provider)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(ranking.decidingOutcome).toBeNull();
  });

  it('positions are 1-based and the ranking is total', () => {
    const ranking = rankProviderCandidates(candidates, ['cost', 'speed', 'quality', 'privacy']);
    expect(ranking.ordered.map((entry) => entry.position)).toEqual([1, 2, 3]);
  });

  it('fewer than two candidates → no deciding outcome', () => {
    expect(rankProviderCandidates([], ['cost']).decidingOutcome).toBeNull();
    expect(
      rankProviderCandidates([candidate('only', { cost: 1 })], ['cost']).decidingOutcome,
    ).toBeNull();
  });

  it('a SHORT priority still ties-breaks deterministically (canonical tail completes it)', () => {
    const pair = [
      candidate('left', { cost: 50, privacy: 2 }),
      candidate('right', { cost: 50, privacy: 1 }),
    ];
    // Priority mentions only cost; the canonical tail breaks the tie on
    // privacy (right wins) — deterministic without privileging anyone.
    const ranking = rankProviderCandidates(pair, ['cost']);
    expect(ranking.ordered.map((entry) => entry.candidate.provider)).toEqual(['right', 'left']);
    expect(ranking.decidingOutcome).toBe('privacy');
  });

  it('non-finite signals are treated as unknown (worst)', () => {
    const pair = [
      candidate('bad', { cost: Number.POSITIVE_INFINITY }),
      candidate('good', { cost: 1_000_000 }),
    ];
    const ranking = rankProviderCandidates(pair, ['cost']);
    expect(ranking.ordered[0]!.candidate.provider).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// buildSelectionExplanation — the jargon-free sentence builder
// ---------------------------------------------------------------------------

/** Every provider-ish token that must NEVER appear in an explanation. */
const FORBIDDEN_TECHNICAL_TOKENS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'cohere',
  'deepseek',
  'groq',
  'llm',
  'api',
  'sdk',
  'model',
  'account',
  'gpt',
  'claude',
  'gemini',
  'gateway',
  'adapter',
  'endpoint',
];

describe('buildSelectionExplanation', () => {
  const matrix: Array<{
    name: string;
    input: Parameters<typeof buildSelectionExplanation>[0];
  }> = [
    {
      name: 'personal preference with a deciding outcome',
      input: {
        decision: 'preference',
        preferenceSource: 'personal-preference',
        decidingOutcome: 'cost',
        candidatesConsidered: 3,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'tenant priority',
      input: {
        decision: 'preference',
        preferenceSource: 'tenant-priority',
        decidingOutcome: 'privacy',
        candidatesConsidered: 2,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'organizational policy (policy-first)',
      input: {
        decision: 'preference',
        preferenceSource: 'organizational-policy',
        decidingOutcome: 'quality',
        candidatesConsidered: 4,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'the balanced default',
      input: {
        decision: 'preference',
        preferenceSource: 'default',
        decidingOutcome: 'speed',
        candidatesConsidered: 2,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'full tie falls back to input order',
      input: {
        decision: 'preference',
        preferenceSource: 'personal-preference',
        decidingOutcome: null,
        candidatesConsidered: 2,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'technical override',
      input: {
        decision: 'technical-override',
        preferenceSource: 'tenant-priority',
        decidingOutcome: null,
        candidatesConsidered: 3,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'single choice',
      input: {
        decision: 'single-choice',
        preferenceSource: 'default',
        decidingOutcome: null,
        candidatesConsidered: 1,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'no choice',
      input: {
        decision: 'no-choice',
        preferenceSource: 'default',
        decidingOutcome: null,
        candidatesConsidered: 0,
        budgetExcludedCount: 0,
        overrideUnavailable: false,
      },
    },
    {
      name: 'budget exclusions appended',
      input: {
        decision: 'preference',
        preferenceSource: 'tenant-priority',
        decidingOutcome: 'cost',
        candidatesConsidered: 5,
        budgetExcludedCount: 2,
        overrideUnavailable: false,
      },
    },
    {
      name: 'override named an unavailable option',
      input: {
        decision: 'preference',
        preferenceSource: 'personal-preference',
        decidingOutcome: 'speed',
        candidatesConsidered: 2,
        budgetExcludedCount: 1,
        overrideUnavailable: true,
      },
    },
    {
      name: 'single choice after budget exclusions',
      input: {
        decision: 'single-choice',
        preferenceSource: 'organizational-policy',
        decidingOutcome: null,
        candidatesConsidered: 3,
        budgetExcludedCount: 2,
        overrideUnavailable: false,
      },
    },
  ];

  it('every decision/source shape produces non-empty user language', () => {
    for (const { name, input } of matrix) {
      const sentence = buildSelectionExplanation(input);
      expect(sentence.length, name).toBeGreaterThan(20);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });

  it('NO explanation ever contains technical identity (jargon-free by construction)', () => {
    for (const { input } of matrix) {
      const sentence = buildSelectionExplanation(input).toLowerCase();
      for (const token of FORBIDDEN_TECHNICAL_TOKENS) {
        expect(sentence.includes(token), `explanation leaked '${token}': ${sentence}`).toBe(false);
      }
    }
  });

  it('says who set the priority in plain words', () => {
    const personal = buildSelectionExplanation({
      decision: 'preference',
      preferenceSource: 'personal-preference',
      decidingOutcome: 'cost',
      candidatesConsidered: 2,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
    });
    expect(personal).toContain('You asked for');
    const tenant = buildSelectionExplanation({
      decision: 'preference',
      preferenceSource: 'tenant-priority',
      decidingOutcome: 'cost',
      candidatesConsidered: 2,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
    });
    expect(tenant).toContain('Your company');
    const policy = buildSelectionExplanation({
      decision: 'preference',
      preferenceSource: 'organizational-policy',
      decidingOutcome: 'cost',
      candidatesConsidered: 2,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
    });
    expect(policy).toContain('Company policy decides');
    const fallback = buildSelectionExplanation({
      decision: 'preference',
      preferenceSource: 'default',
      decidingOutcome: 'cost',
      candidatesConsidered: 2,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
    });
    expect(fallback).toContain('balanced default');
  });

  it('the honest cases say exactly what happened', () => {
    const single = buildSelectionExplanation({
      decision: 'single-choice',
      preferenceSource: 'default',
      decidingOutcome: null,
      candidatesConsidered: 1,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
    });
    expect(single).toContain('Only one option was available');
    const none = buildSelectionExplanation({
      decision: 'no-choice',
      preferenceSource: 'default',
      decidingOutcome: null,
      candidatesConsidered: 0,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
    });
    expect(none).toContain('No option was available');
    const override = buildSelectionExplanation({
      decision: 'technical-override',
      preferenceSource: 'default',
      decidingOutcome: null,
      candidatesConsidered: 2,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
    });
    expect(override).toContain('authorized technical override');
    expect(override).toContain('reversed');
  });

  it('budget exclusions are counted honestly (one vs many)', () => {
    const one = buildSelectionExplanation({
      decision: 'preference',
      preferenceSource: 'tenant-priority',
      decidingOutcome: 'cost',
      candidatesConsidered: 3,
      budgetExcludedCount: 1,
      overrideUnavailable: false,
    });
    expect(one).toContain('excluded one other option');
    const many = buildSelectionExplanation({
      decision: 'preference',
      preferenceSource: 'tenant-priority',
      decidingOutcome: 'cost',
      candidatesConsidered: 4,
      budgetExcludedCount: 3,
      overrideUnavailable: false,
    });
    expect(many).toContain('excluded 3 other options');
  });

  it('an override that could not be applied says so', () => {
    const sentence = buildSelectionExplanation({
      decision: 'preference',
      preferenceSource: 'personal-preference',
      decidingOutcome: 'speed',
      candidatesConsidered: 2,
      budgetExcludedCount: 0,
      overrideUnavailable: true,
    });
    expect(sentence).toContain('was not available');
  });

  it('outcome and source phrases are complete over the vocabularies', () => {
    for (const outcome of PROVIDER_PREFERENCE_OUTCOMES) {
      expect(outcomePhrase(outcome).length).toBeGreaterThan(5);
    }
    for (const source of [
      'organizational-policy',
      'tenant-priority',
      'personal-preference',
      'default',
    ] as const) {
      expect(preferenceSourcePhrase(source).length).toBeGreaterThan(5);
    }
    for (const decision of [
      'technical-override',
      'preference',
      'single-choice',
      'no-choice',
    ] as const) {
      expect(selectionDecisionLabel(decision).length).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// toOrdinaryExplanationView — the projection seam
// ---------------------------------------------------------------------------

describe('toOrdinaryExplanationView', () => {
  it('strips the technical identity (provider, account, gateway, tenant)', () => {
    const view = toOrdinaryExplanationView({
      id: '00000000-0000-4000-8000-000000000001',
      capability: 'text-generation',
      decision: 'preference',
      preferenceSource: 'personal-preference',
      decidingOutcome: 'cost',
      candidatesConsidered: 2,
      budgetExcludedCount: 0,
      overrideUnavailable: false,
      explanation: 'You asked for the lowest cost first — this option ranked best on that among 2 available options.',
      recordedAt: '2026-10-05T12:00:00.000Z',
    });
    expect(view).not.toHaveProperty('chosenProvider');
    expect(view).not.toHaveProperty('chosenAccountRef');
    expect(view).not.toHaveProperty('gateway');
    expect(view).not.toHaveProperty('tenantId');
    expect(view.occurredAt).toBe('2026-10-05T12:00:00.000Z');
    expect(Object.keys(view).sort()).toEqual(
      [
        'id',
        'capability',
        'decision',
        'preferenceSource',
        'decidingOutcome',
        'candidatesConsidered',
        'budgetExcludedCount',
        'overrideUnavailable',
        'explanation',
        'occurredAt',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  async function expectCode(
    code: ProviderPreferencesError['code'],
    fn: () => unknown,
  ): Promise<void> {
    try {
      fn();
      throw new Error(`expected ProviderPreferencesError('${code}') but the call succeeded`);
    } catch (error) {
      if (!(error instanceof ProviderPreferencesError)) throw error;
      expect(error.code).toBe(code);
    }
  }

  it('setTenantPreference: validates the priority (vocab, duplicates, length) and the posture', async () => {
    expect(
      validateSetTenantPreferenceInput({ outcomePriority: ['cost'], policyFirst: false }),
    ).toEqual({ outcomePriority: ['cost'], policyFirst: false });
    await expectCode('invalid_input', () =>
      validateSetTenantPreferenceInput({ outcomePriority: ['cost'], policyFirst: 'yes' }),
    );
    await expectCode('invalid_input', () =>
      validateSetTenantPreferenceInput({ outcomePriority: ['thrift'], policyFirst: false }),
    );
    await expectCode('invalid_input', () =>
      validateSetTenantPreferenceInput({ outcomePriority: ['cost', 'cost'], policyFirst: false }),
    );
    await expectCode('invalid_input', () =>
      validateSetTenantPreferenceInput({ outcomePriority: [], policyFirst: false }),
    );
    await expectCode('invalid_input', () =>
      validateSetTenantPreferenceInput({
        outcomePriority: ['cost', 'speed', 'quality', 'privacy', 'cost'],
        policyFirst: false,
      }),
    );
    await expectCode('invalid_input', () =>
      validateSetTenantPreferenceInput({ outcomePriority: ['cost'], policyFirst: false, extra: 1 }),
    );
  });

  it('setPersonalPreference: same priority rules, no posture field', async () => {
    expect(validateSetPersonalPreferenceInput({ outcomePriority: ['speed'] })).toEqual({
      outcomePriority: ['speed'],
    });
    await expectCode('invalid_input', () =>
      validateSetPersonalPreferenceInput({ outcomePriority: 'speed' }),
    );
    await expectCode('invalid_input', () =>
      validateSetPersonalPreferenceInput({ outcomePriority: ['speed'], policyFirst: false }),
    );
  });

  it('setTechnicalOverride: requires a reason and well-formed keys', async () => {
    expect(
      validateSetTechnicalOverrideInput({
        gateway: 'llm',
        capability: 'text-generation',
        provider: 'openai',
        reason: '  Compliance requires the EU-hosted option. ',
      }),
    ).toEqual({
      gateway: 'llm',
      capability: 'text-generation',
      provider: 'openai',
      reason: 'Compliance requires the EU-hosted option.',
    });
    expect(
      validateSetTechnicalOverrideInput({
        gateway: 'llm',
        capability: null,
        provider: 'anthropic',
        reason: 'Whole-gateway pin.',
      }).capability,
    ).toBeNull();
    await expectCode('invalid_input', () =>
      validateSetTechnicalOverrideInput({
        gateway: 'llm',
        provider: 'openai',
        reason: '',
      }),
    );
    await expectCode('invalid_input', () =>
      validateSetTechnicalOverrideInput({
        gateway: 'LLM',
        provider: 'openai',
        reason: 'Uppercase gateway.',
      }),
    );
    await expectCode('invalid_input', () =>
      validateSetTechnicalOverrideInput({
        gateway: 'llm',
        provider: 'openai',
        reason: 'x'.repeat(2001),
      }),
    );
  });

  it('overrideScopeKey: canonical encoding of the two scope shapes', () => {
    expect(overrideScopeKey('llm', null)).toBe('g:llm');
    expect(overrideScopeKey('llm', 'text-generation')).toBe('g:llm:c:text-generation');
  });

  it('resolveProviderChoice: validates candidates (shapes, signals, duplicates, cap)', async () => {
    const valid = validateResolveProviderChoiceInput({
      gateway: 'llm',
      capability: 'text-generation',
      dedupeKey: 'route-1',
      candidates: [
        {
          provider: 'alpha',
          accountRef: 'acct-alpha',
          projectedCostMinor: 120,
          outcomes: { cost: 120, speed: 300 },
        },
        { provider: 'beta', outcomes: { cost: 90 } },
      ],
    });
    expect(valid.candidates).toHaveLength(2);
    expect(valid.candidates[0]!.projectedCostMinor).toBe(120);
    expect(valid.candidates[1]!.accountRef).toBeNull();
    await expectCode('invalid_input', () =>
      validateResolveProviderChoiceInput({
        gateway: 'llm',
        capability: 'text-generation',
        dedupeKey: 'route-1',
        candidates: [{ provider: 'alpha', outcomes: { cost: 'cheap' } }],
      }),
    );
    await expectCode('invalid_input', () =>
      validateResolveProviderChoiceInput({
        gateway: 'llm',
        capability: 'text-generation',
        dedupeKey: 'route-1',
        candidates: [
          { provider: 'alpha', outcomes: {} },
          { provider: 'alpha', outcomes: {} },
        ],
      }),
    );
    await expectCode('invalid_input', () =>
      validateResolveProviderChoiceInput({
        gateway: 'llm',
        capability: 'text-generation',
        dedupeKey: 'route-1',
        candidates: Array.from({ length: MAX_CANDIDATES + 1 }, (_, index) => ({
          provider: `p-${index}`,
          outcomes: {},
        })),
      }),
    );
    await expectCode('invalid_input', () =>
      validateResolveProviderChoiceInput({
        gateway: 'llm',
        capability: 'text-generation',
        dedupeKey: 'route-1',
        candidates: [
          {
            provider: 'alpha',
            outcomes: { cost: 1 },
            projectedCostMinor: -5,
          },
        ],
      }),
    );
  });

  it('recordSelectionExplanation: no-choice records must record nothing chosen', async () => {
    await expectCode('invalid_input', () =>
      validateRecordSelectionExplanationInput({
        gateway: 'llm',
        capability: 'text-generation',
        chosenProvider: 'openai',
        decision: 'no-choice',
        preferenceSource: 'default',
        candidatesConsidered: 0,
        dedupeKey: 'x-1',
      }),
    );
    await expectCode('invalid_input', () =>
      validateRecordSelectionExplanationInput({
        gateway: 'llm',
        capability: 'text-generation',
        decision: 'preference',
        preferenceSource: 'default',
        candidatesConsidered: 2,
        dedupeKey: 'x-1',
      }),
    );
    const valid = validateRecordSelectionExplanationInput({
      gateway: 'llm',
      capability: 'text-generation',
      chosenProvider: null,
      decision: 'no-choice',
      preferenceSource: 'default',
      candidatesConsidered: 0,
      dedupeKey: 'x-1',
    });
    expect(valid.decision).toBe('no-choice');
    expect(valid.chosenProvider).toBeNull();
    expect(valid.budgetExcludedCount).toBe(0);
    expect(valid.overrideUnavailable).toBe(false);
  });

  it('list queries: limits and optional filters', async () => {
    expect(validateListSelectionExplanationsQuery(undefined)).toEqual({
      capability: null,
      limit: 50,
    });
    expect(
      validateListSelectionExplanationsQuery({ capability: 'text-generation', limit: 10 }),
    ).toEqual({ capability: 'text-generation', limit: 10 });
    await expectCode('invalid_query', () =>
      validateListSelectionExplanationsQuery({ limit: 0 }),
    );
    await expectCode('invalid_query', () => validateListSelectionExplanationsQuery({ limit: 501 }));
  });
});
