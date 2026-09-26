// Unit tests for the provider-preferences module's PURE logic — the
// preference catalog, the deterministic preference → routing-order mapping
// core (mappings.ts) and the input validators (validation.ts). No database,
// no clock, no adapters: same inputs must always produce the same plan
// (W091's deterministic-mapping acceptance), and every default-surface
// string must stay jargon-free (no provider/model names, no machine codes —
// the central W091 probe).

import { describe, expect, it } from 'vitest';
import {
  DATA_CLASSIFICATIONS,
  LLM_CAPABILITIES,
  LLM_PROVIDERS,
  LLM_SCOPES,
  listLlmModels,
} from '@/modules/llm/contract';
import type { LlmRoutingCandidateSnapshot, LlmRoutingSnapshot } from '@/modules/llm/contract';
import { ProviderPreferencesError } from '../errors';
import {
  DEFAULT_PREFERENCE,
  PREFERENCE_OPTIONS,
  REJECTION_REASON_PHRASES,
  allExplanationLines,
  computePreferenceOrder,
  evidenceByProvider,
  explainRoutingSnapshot,
  preferenceLineFor,
  preferenceOption,
} from '../mappings';
import {
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  MAX_NOTE_LENGTH,
  PREFERENCE_KINDS,
  assertProviderPreferencesTenantContext,
  validateExplainQuery,
  validateListChangeEventsQuery,
  validateSavePreferenceInput,
  validateTechnicalOverrideInput,
} from '../validation';
import type {
  AccountPreferenceFacts,
  PreferenceAssignment,
  PreferenceEvidence,
  PreferenceOrderPlan,
  ProviderPreferenceKind,
  PreferenceOutcomeDimension,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_DIMENSIONS: readonly PreferenceOutcomeDimension[] = [
  'privacy',
  'cost',
  'speed',
  'quality',
  'policy',
];

const REJECTION_REASONS = [
  'account_disabled',
  'scope_not_permitted',
  'capability_not_permitted',
  'data_classification_exceeds_account_policy',
  'budget_exhausted',
  'capability_not_supported_by_model',
  'model_output_limit',
  'unavailable',
  'not_pinned_target',
] as const;

function account(
  overrides: Partial<AccountPreferenceFacts> & Pick<AccountPreferenceFacts, 'accountId' | 'provider'>,
): AccountPreferenceFacts {
  return {
    priority: 100,
    maxDataClassification: 'internal',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Three options over three providers with three different data-policy
 * ceilings and interleaved priorities; google (gamma) carries NO measured
 * evidence at all. Base order (priority ASC): alpha(10), gamma(15), beta(20).
 */
const FIXTURE_ACCOUNTS: readonly AccountPreferenceFacts[] = [
  account({
    accountId: 'acc-alpha',
    provider: 'openai',
    priority: 10,
    maxDataClassification: 'restricted',
    createdAt: '2026-01-01T00:00:00.000Z',
  }),
  account({
    accountId: 'acc-gamma',
    provider: 'google',
    priority: 15,
    maxDataClassification: 'public',
    createdAt: '2026-01-03T00:00:00.000Z',
  }),
  account({
    accountId: 'acc-beta',
    provider: 'anthropic',
    priority: 20,
    maxDataClassification: 'internal',
    createdAt: '2026-01-02T00:00:00.000Z',
  }),
];

/**
 * Mixed evidence coverage:
 *  * openai — a W090 billing attribution row (avg $4.00/task, 4 executions)
 *    PLUS its own usage row (avg $0.50/task): the billing tier must win;
 *    usage also records latency 1000 ms and 3/4 completion;
 *  * anthropic — usage only (two rows: avg $0.75/task, weighted latency
 *    (100×1 + 500×3)/4 = 400 ms, 4/4 completion);
 *  * google — nothing.
 */
const FIXTURE_EVIDENCE: PreferenceEvidence = {
  usage: [
    {
      provider: 'openai',
      executions: 4,
      completed: 3,
      failed: 1,
      costMinor: 200,
      avgLatencyMs: 1000,
    },
    {
      provider: 'anthropic',
      executions: 1,
      completed: 1,
      failed: 0,
      costMinor: 50,
      avgLatencyMs: 100,
    },
    {
      provider: 'anthropic',
      executions: 3,
      completed: 3,
      failed: 0,
      costMinor: 250,
      avgLatencyMs: 500,
    },
  ],
  billing: [
    {
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
      records: 1,
      costMinor: 1600,
      quantity: null,
      executions: 4,
    },
  ],
};

function planOrder(plan: { assignments: { accountId: string }[] }): string[] {
  return plan.assignments.map((assignment) => assignment.accountId);
}

function findAssignment(plan: PreferenceOrderPlan, accountId: string): PreferenceAssignment {
  const found = plan.assignments.find((assignment) => assignment.accountId === accountId);
  if (found === undefined) {
    throw new Error(`fixture account '${accountId}' missing from the plan`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The jargon vocabulary (built from the llm contract — the machine layer)
// ---------------------------------------------------------------------------

/** Every machine token the DEFAULT surface must never render. */
const JARGON_TOKENS: readonly string[] = [
  ...LLM_PROVIDERS,
  ...listLlmModels().map((model) => model.modelId),
  ...LLM_CAPABILITIES,
  ...LLM_SCOPES,
  ...DATA_CLASSIFICATIONS,
  ...REJECTION_REASONS,
  'maxDataClassification',
  'llm',
  'byoa',
  'priority',
];

function expectJargonFree(text: string, where: string): void {
  const haystack = text.toLowerCase();
  for (const token of JARGON_TOKENS) {
    expect(
      haystack.includes(token.toLowerCase()),
      `jargon token '${token}' leaked into ${where}: ${JSON.stringify(text)}`,
    ).toBe(false);
  }
}

/** Every basis/note string the mapping core produces under `preference`. */
function planCopy(preference: ProviderPreferenceKind): string[] {
  const plan = computePreferenceOrder(preference, FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
  return [
    ...plan.assignments.map((assignment) => assignment.basis),
    ...plan.notes,
  ];
}

// ---------------------------------------------------------------------------
// The preference catalog
// ---------------------------------------------------------------------------

describe('provider-preferences unit — the preference catalog', () => {
  it('offers exactly the five contract kinds with unique plain labels', () => {
    expect(PREFERENCE_OPTIONS).toHaveLength(5);
    const kinds = PREFERENCE_OPTIONS.map((option) => option.kind);
    expect(new Set(kinds).size).toBe(5);
    expect([...kinds].sort()).toEqual([...PREFERENCE_KINDS].sort());
    const labels = PREFERENCE_OPTIONS.map((option) => option.label);
    expect(new Set(labels).size).toBe(5);
    for (const option of PREFERENCE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
      expect(VALID_DIMENSIONS).toContain(option.dimension);
    }
  });

  it('defaults to the balanced organizational order', () => {
    expect(DEFAULT_PREFERENCE).toBe('balanced');
    expect(PREFERENCE_KINDS).toContain(DEFAULT_PREFERENCE);
  });

  it('resolves every kind and throws on an unknown one', () => {
    for (const kind of PREFERENCE_KINDS) {
      const option = preferenceOption(kind);
      expect(option.kind).toBe(kind);
    }
    expect(() => preferenceOption('cheapest' as ProviderPreferenceKind)).toThrow(
      /unknown provider preference/,
    );
  });
});

// ---------------------------------------------------------------------------
// The central W091 probe — no machine vocabulary on the default surface
// ---------------------------------------------------------------------------

describe('provider-preferences unit — jargon-free default-surface copy', () => {
  it('keeps provider names, model ids, enum codes and machine reasons out of every catalog string', () => {
    for (const option of PREFERENCE_OPTIONS) {
      expectJargonFree(option.label, `the '${option.kind}' label`);
      expectJargonFree(option.description, `the '${option.kind}' description`);
    }
  });

  it('keeps machine vocabulary out of every rejection phrase and preference line', () => {
    for (const [reason, phrase] of Object.entries(REJECTION_REASON_PHRASES)) {
      expectJargonFree(phrase, `the '${reason}' rejection phrase`);
    }
    for (const kind of PREFERENCE_KINDS) {
      expectJargonFree(preferenceLineFor(kind), `the '${kind}' preference line`);
    }
  });

  it('keeps machine vocabulary out of every basis and note the mapping core produces (all five preferences)', () => {
    for (const kind of PREFERENCE_KINDS) {
      for (const text of planCopy(kind)) {
        expectJargonFree(text, `the '${kind}' mapping copy`);
      }
    }
  });

  it('keeps machine vocabulary out of every routing-explanation line', () => {
    // A snapshot carrying real provider/model names and every machine reason:
    // its plain rendering must still speak only outcomes.
    const snapshot: LlmRoutingSnapshot = {
      pinned: false,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
        { accountId: 'a2', provider: 'anthropic', model: 'claude-sonnet-4-5', eligible: false, reason: 'account_disabled' },
        { accountId: 'a3', provider: 'google', model: 'gemini-2.5-flash', eligible: false, reason: 'made-up-reason' as never },
      ],
      chosen: { accountId: 'a1', provider: 'openai', model: 'gpt-4o' },
    };
    const explanation = explainRoutingSnapshot(snapshot);
    for (const line of allExplanationLines(explanation)) {
      expectJargonFree(line.text, 'a routing explanation line');
    }
  });
});

// ---------------------------------------------------------------------------
// computePreferenceOrder — the deterministic mapping
// ---------------------------------------------------------------------------

describe('provider-preferences unit — computePreferenceOrder', () => {
  it('balanced keeps the organization’s configured order exactly (changed=false)', () => {
    const plan = computePreferenceOrder('balanced', FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
    expect(planOrder(plan)).toEqual(['acc-alpha', 'acc-gamma', 'acc-beta']);
    expect(plan.changed).toBe(false);
    expect(plan.assignments.map((assignment) => assignment.position)).toEqual([1, 2, 3]);
    // The organization's own order is itself the evidence (administrator-set).
    for (const assignment of plan.assignments) {
      expect(assignment.evidenceAvailable).toBe(true);
    }
    expect(plan.notes.length).toBeGreaterThan(0);
  });

  it('privacy-first orders most restrictive data policy first with the base order breaking ties', () => {
    const plan = computePreferenceOrder('privacy-first', FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
    // public ceiling first, then internal, then restricted.
    expect(planOrder(plan)).toEqual(['acc-gamma', 'acc-beta', 'acc-alpha']);
    expect(plan.changed).toBe(true);

    // Stable tiebreak: two options with the SAME ceiling keep the tenant's
    // own order (priority ASC, then creation time).
    const ties = [
      account({ accountId: 'tie-a', provider: 'openai', priority: 5, maxDataClassification: 'internal', createdAt: '2026-02-02T00:00:00.000Z' }),
      account({ accountId: 'tie-b', provider: 'mistral', priority: 3, maxDataClassification: 'internal', createdAt: '2026-02-01T00:00:00.000Z' }),
      account({ accountId: 'tie-c', provider: 'cohere', priority: 4, maxDataClassification: 'public', createdAt: '2026-02-03T00:00:00.000Z' }),
    ];
    const tied = computePreferenceOrder('privacy-first', ties, { usage: [], billing: [] });
    // tie-c (public) first; then tie-b (priority 3) before tie-a (priority 5).
    expect(planOrder(tied)).toEqual(['tie-c', 'tie-b', 'tie-a']);
  });

  it('lowest-cost prefers the billing attribution over recorded usage and parks unevidenced options after', () => {
    const plan = computePreferenceOrder('lowest-cost', FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
    // anthropic $0.75 (usage tier) < openai $4.00 (billing tier beats its own
    // $0.50 usage average); google has no cost evidence and keeps its
    // configured place AFTER the evidenced options.
    expect(planOrder(plan)).toEqual(['acc-beta', 'acc-alpha', 'acc-gamma']);
    expect(plan.changed).toBe(true);

    const beta = findAssignment(plan, 'acc-beta');
    expect(beta.evidenceAvailable).toBe(true);
    expect(beta.basis).toContain('$0.75');
    expect(beta.basis).toContain('recorded usage');

    const alpha = findAssignment(plan, 'acc-alpha');
    expect(alpha.evidenceAvailable).toBe(true);
    expect(alpha.basis).toContain('$4.00');
    expect(alpha.basis).toContain('billing records');

    const gamma = findAssignment(plan, 'acc-gamma');
    expect(gamma.evidenceAvailable).toBe(false);
    expect(gamma.basis).toContain('no cost evidence recorded yet');

    // The notes name the unevidenced option and the honesty rule.
    expect(plan.notes.join(' ')).toContain('no recorded evidence');
    expect(plan.notes.join(' ')).toContain('never from guessed ratings');
  });

  it('fastest orders by execution-weighted average latency', () => {
    const plan = computePreferenceOrder('fastest', FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
    // anthropic weighted latency (100×1 + 500×3)/4 = 400 ms < openai 1000 ms;
    // google unevidenced stays after.
    expect(planOrder(plan)).toEqual(['acc-beta', 'acc-alpha', 'acc-gamma']);
    expect(findAssignment(plan, 'acc-beta').basis).toContain('400 ms');
    expect(findAssignment(plan, 'acc-alpha').basis).toContain('1000 ms');
    expect(findAssignment(plan, 'acc-gamma').basis).toContain('no response times recorded yet');
  });

  it('most-reliable orders by completion share, highest first', () => {
    const plan = computePreferenceOrder('most-reliable', FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
    // anthropic 4/4 = 100% > openai 3/4 = 75%; google unevidenced stays after.
    expect(planOrder(plan)).toEqual(['acc-beta', 'acc-alpha', 'acc-gamma']);
    expect(findAssignment(plan, 'acc-beta').basis).toContain('100%');
    expect(findAssignment(plan, 'acc-alpha').basis).toContain('75%');
    expect(findAssignment(plan, 'acc-gamma').basis).toContain('no completion record yet');
  });

  it('is deterministic: the same facts and evidence always produce the same plan', () => {
    for (const kind of PREFERENCE_KINDS) {
      const first = computePreferenceOrder(kind, FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
      const second = computePreferenceOrder(kind, FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
      expect(second).toEqual(first);
    }
  });

  it('assigns priority = position × 10 (capped at 1000)', () => {
    const plan = computePreferenceOrder('privacy-first', FIXTURE_ACCOUNTS, FIXTURE_EVIDENCE);
    for (const assignment of plan.assignments) {
      expect(assignment.assignedPriority).toBe(assignment.position * 10);
    }
    // The cap: 101+ options cap the assigned priority at 1000.
    const many: AccountPreferenceFacts[] = [];
    for (let index = 0; index < 105; index += 1) {
      many.push(
        account({
          accountId: `acc-${String(index).padStart(3, '0')}`,
          provider: 'openai',
          priority: index,
          createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index).toISOString(),
        }),
      );
    }
    const capped = computePreferenceOrder('balanced', many, { usage: [], billing: [] });
    expect(capped.assignments).toHaveLength(105);
    for (const assignment of capped.assignments) {
      expect(assignment.assignedPriority).toBe(Math.min(1000, assignment.position * 10));
    }
    const last = capped.assignments[104]!;
    expect(last.assignedPriority).toBe(1000);
  });

  it('reports changed=false when a measured preference cannot move anything', () => {
    // No evidence at all: every option keeps its configured place, so even
    // 'fastest' changes nothing.
    const plan = computePreferenceOrder('fastest', FIXTURE_ACCOUNTS, { usage: [], billing: [] });
    expect(planOrder(plan)).toEqual(['acc-alpha', 'acc-gamma', 'acc-beta']);
    expect(plan.changed).toBe(false);
    expect(plan.assignments.every((assignment) => !assignment.evidenceAvailable)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evidenceByProvider — the two cost tiers
// ---------------------------------------------------------------------------

describe('provider-preferences unit — evidenceByProvider', () => {
  it('billing rows with zero executions create no cost evidence', () => {
    const evidence: PreferenceEvidence = {
      usage: [],
      billing: [
        {
          gateway: 'llm',
          provider: 'mistral',
          capability: 'text-generation',
          records: 3,
          costMinor: 900,
          quantity: null,
          executions: 0,
        },
      ],
    };
    const byProvider = evidenceByProvider(evidence);
    expect(byProvider.has('mistral')).toBe(false);
  });

  it('prefers the billing attribution and fills cost from usage only when billing is absent', () => {
    const evidence: PreferenceEvidence = {
      usage: [
        { provider: 'openai', executions: 2, completed: 2, failed: 0, costMinor: 100, avgLatencyMs: 400 },
        { provider: 'cohere', executions: 4, completed: 4, failed: 0, costMinor: 200, avgLatencyMs: 250 },
      ],
      billing: [
        {
          gateway: 'llm',
          provider: 'openai',
          capability: 'text-generation',
          records: 1,
          costMinor: 500,
          quantity: null,
          executions: 5,
        },
      ],
    };
    const byProvider = evidenceByProvider(evidence);

    // openai: billing tier wins (500/5 = 100) even though usage says 50.
    const openai = byProvider.get('openai');
    expect(openai?.cost).toEqual({ avgCostMinor: 100, source: 'billing-attribution' });
    expect(openai?.avgLatencyMs).toBe(400);
    expect(openai?.completionShare).toBe(1);

    // cohere: no billing row → the usage tier fills in (200/4 = 50).
    const cohere = byProvider.get('cohere');
    expect(cohere?.cost).toEqual({ avgCostMinor: 50, source: 'recorded-usage' });
    expect(cohere?.avgLatencyMs).toBe(250);
    expect(cohere?.completionShare).toBe(1);
  });

  it('leaves latency and completion honestly absent when nothing was recorded', () => {
    const byProvider = evidenceByProvider({
      usage: [{ provider: 'groq', executions: 0, completed: 0, failed: 0, costMinor: 0, avgLatencyMs: null }],
      billing: [],
    });
    const groq = byProvider.get('groq');
    expect(groq?.cost).toBeNull();
    expect(groq?.avgLatencyMs).toBeNull();
    expect(groq?.completionShare).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// explainRoutingSnapshot — machine reasons → plain language
// ---------------------------------------------------------------------------

describe('provider-preferences unit — explainRoutingSnapshot', () => {
  const CHOSEN = { accountId: 'a1', provider: 'openai', model: 'gpt-4o' } as const;

  it('renders the chosen line (pinned and non-pinned variants)', () => {
    const snapshot: LlmRoutingSnapshot = {
      pinned: false,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
      ],
      chosen: { ...CHOSEN },
    };
    const plain = explainRoutingSnapshot(snapshot);
    expect(plain.pinned).toBe(false);
    expect(plain.chosen?.kind).toBe('chosen');
    expect(plain.chosen?.text).toContain('passed every check');
    expect(plain.chosen?.text).toContain('your choice');

    const pinned = explainRoutingSnapshot({
      pinned: true,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
      ],
      chosen: { ...CHOSEN },
    });
    expect(pinned.chosen?.text).toContain('a specific option was requested');
    expect(pinned.chosen?.text).not.toContain('your choice');
  });

  it('renders the eligible-but-tried-later line for candidates that passed every check', () => {
    const snapshot: LlmRoutingSnapshot = {
      pinned: false,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
        { accountId: 'a2', provider: 'google', model: 'gemini-2.5-flash', eligible: true, reason: null },
      ],
      chosen: { ...CHOSEN },
    };
    const plain = explainRoutingSnapshot(snapshot);
    expect(plain.chosen).not.toBeNull();
    expect(plain.rejected).toHaveLength(1);
    expect(plain.rejected[0]!.kind).toBe('rejected');
    expect(plain.rejected[0]!.text).toContain('passed every check but was tried after the chosen option');
    expect(plain.unexplained).toEqual([]);
  });

  it('renders exactly one rejected line for EVERY machine rejection reason', () => {
    const candidates: LlmRoutingCandidateSnapshot[] = REJECTION_REASONS.map((reason, index) => ({
      accountId: `rejected-${String(index)}`,
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-5',
      eligible: false,
      reason,
    }));
    const snapshot: LlmRoutingSnapshot = {
      pinned: false,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
        ...candidates,
      ],
      chosen: { ...CHOSEN },
    };
    const plain = explainRoutingSnapshot(snapshot);
    expect(plain.rejected).toHaveLength(REJECTION_REASONS.length);
    expect(plain.unexplained).toEqual([]);
    for (const reason of REJECTION_REASONS) {
      const expected = `Not used: ${REJECTION_REASON_PHRASES[reason]}.`;
      expect(
        plain.rejected.some((line) => line.text === expected),
        `missing the plain line for '${reason}': ${expected}`,
      ).toBe(true);
    }
  });

  it('renders an honest unexplained line for an unknown machine reason', () => {
    const snapshot: LlmRoutingSnapshot = {
      pinned: false,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
        {
          accountId: 'a2',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          eligible: false,
          reason: 'made-up-reason' as never,
        },
      ],
      chosen: { ...CHOSEN },
    };
    const plain = explainRoutingSnapshot(snapshot);
    expect(plain.unexplained).toHaveLength(1);
    expect(plain.unexplained[0]!.kind).toBe('unexplained');
    expect(plain.unexplained[0]!.text).toContain('cannot explain');
    expect(plain.rejected).toEqual([]);
  });

  it('renders no chosen line when nothing was chosen, and every candidate still gets a line', () => {
    const snapshot: LlmRoutingSnapshot = {
      pinned: false,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
        { accountId: 'a2', provider: 'anthropic', model: 'claude-sonnet-4-5', eligible: false, reason: 'budget_exhausted' },
      ],
      chosen: null,
    };
    const plain = explainRoutingSnapshot(snapshot);
    expect(plain.chosen).toBeNull();
    expect(plain.rejected).toHaveLength(2);
    expect(plain.unexplained).toEqual([]);
    const texts = plain.rejected.map((line) => line.text);
    expect(texts.some((text) => text.includes('passed every check but was tried after'))).toBe(true);
    expect(texts.some((text) => text.includes('over budget'))).toBe(true);
  });

  it('gives the chosen candidate no extra line and flattens lines in reading order', () => {
    const snapshot: LlmRoutingSnapshot = {
      pinned: false,
      candidates: [
        { accountId: 'a1', provider: 'openai', model: 'gpt-4o', eligible: true, reason: null },
        { accountId: 'a2', provider: 'google', model: 'gemini-2.5-flash', eligible: true, reason: null },
        { accountId: 'a3', provider: 'anthropic', model: 'claude-sonnet-4-5', eligible: false, reason: 'account_disabled' },
      ],
      chosen: { ...CHOSEN },
    };
    const plain = explainRoutingSnapshot(snapshot);
    const lines = allExplanationLines(plain);
    expect(lines).toHaveLength(snapshot.candidates.length);
    expect(lines[0]!.kind).toBe('chosen');
    expect(lines.slice(1).every((line) => line.kind === 'rejected')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation (pure guards)
// ---------------------------------------------------------------------------

describe('provider-preferences unit — tenant context validation', () => {
  const GOOD = { tenantId: '0f0e0d0c-1111-4222-8333-444455556666', principalId: 'user-1', authority: ['llm:administer'] };

  it('accepts a well-formed context and echoes it', () => {
    expect(assertProviderPreferencesTenantContext(GOOD)).toEqual(GOOD);
    expect(assertProviderPreferencesTenantContext({ ...GOOD, authority: [] })).toEqual({
      ...GOOD,
      authority: [],
    });
  });

  it('rejects every malformed shape with invalid_context', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'member-of-tenant',
      42,
      [],
      {},
      { ...GOOD, tenantId: 'not-a-uuid' },
      { ...GOOD, tenantId: 7 },
      { ...GOOD, principalId: '' },
      { ...GOOD, principalId: '   ' },
      { ...GOOD, principalId: null },
      { ...GOOD, authority: 'llm:administer' },
      { ...GOOD, authority: ['llm:administer', 3] },
      { ...GOOD, authority: null },
    ];
    for (const shape of bad) {
      try {
        assertProviderPreferencesTenantContext(shape);
        throw new Error(`expected invalid_context for ${JSON.stringify(shape)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderPreferencesError);
        expect((error as ProviderPreferencesError).code).toBe('invalid_context');
      }
    }
  });
});

describe('provider-preferences unit — input validation', () => {
  it('validateSavePreferenceInput: unknown preference rejected, note trimmed, long note rejected', () => {
    expect(validateSavePreferenceInput({ preference: 'fastest' })).toEqual({
      preference: 'fastest',
      note: null,
    });
    expect(validateSavePreferenceInput({ preference: 'balanced', note: '  quarterly review  ' })).toEqual({
      preference: 'balanced',
      note: 'quarterly review',
    });
    expect(validateSavePreferenceInput({ preference: 'balanced', note: null })).toEqual({
      preference: 'balanced',
      note: null,
    });

    const bad: unknown[] = [
      null,
      'fastest',
      {},
      { preference: 'cheapest' },
      { preference: 3 },
      { preference: 'balanced', note: '' },
      { preference: 'balanced', note: '   ' },
      { preference: 'balanced', note: 5 },
      { preference: 'balanced', note: 'x'.repeat(MAX_NOTE_LENGTH + 1) },
    ];
    for (const shape of bad) {
      try {
        validateSavePreferenceInput(shape);
        throw new Error(`expected invalid_input for ${JSON.stringify(shape)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderPreferencesError);
        expect((error as ProviderPreferencesError).code).toBe('invalid_input');
      }
    }
  });

  it('validateListChangeEventsQuery: bounds and default', () => {
    expect(validateListChangeEventsQuery({})).toEqual({ limit: DEFAULT_EVENT_LIMIT });
    expect(validateListChangeEventsQuery(undefined)).toEqual({ limit: DEFAULT_EVENT_LIMIT });
    expect(validateListChangeEventsQuery(null)).toEqual({ limit: DEFAULT_EVENT_LIMIT });
    expect(validateListChangeEventsQuery({ limit: 1 })).toEqual({ limit: 1 });
    expect(validateListChangeEventsQuery({ limit: MAX_EVENT_LIMIT })).toEqual({ limit: MAX_EVENT_LIMIT });

    const bad: unknown[] = [
      { limit: 0 },
      { limit: -1 },
      { limit: MAX_EVENT_LIMIT + 1 },
      { limit: 2.5 },
      { limit: 'ten' },
    ];
    for (const shape of bad) {
      try {
        validateListChangeEventsQuery(shape);
        throw new Error(`expected invalid_query for ${JSON.stringify(shape)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderPreferencesError);
        expect((error as ProviderPreferencesError).code).toBe('invalid_query');
      }
    }
  });

  it('validateExplainQuery: uuid check with an optional execution id', () => {
    expect(validateExplainQuery({})).toEqual({ executionId: null });
    expect(validateExplainQuery(undefined)).toEqual({ executionId: null });
    expect(validateExplainQuery(null)).toEqual({ executionId: null });
    expect(validateExplainQuery({ executionId: null })).toEqual({ executionId: null });
    const id = '0f0e0d0c-1111-4222-8333-444455556666';
    expect(validateExplainQuery({ executionId: id })).toEqual({ executionId: id });

    const bad: unknown[] = [{ executionId: 'not-a-uuid' }, { executionId: 42 }, { executionId: '' }];
    for (const shape of bad) {
      try {
        validateExplainQuery(shape);
        throw new Error(`expected invalid_query for ${JSON.stringify(shape)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderPreferencesError);
        expect((error as ProviderPreferencesError).code).toBe('invalid_query');
      }
    }
  });

  it('validateTechnicalOverrideInput: priority range, status enum, vocabularies, duplicates, budget clearing, no-change refusal', () => {
    const accountId = '0f0e0d0c-1111-4222-8333-444455556666';

    // Accepts each control in isolation.
    expect(validateTechnicalOverrideInput({ accountId, priority: 0 })).toMatchObject({ priority: 0 });
    expect(validateTechnicalOverrideInput({ accountId, priority: 1000 })).toMatchObject({ priority: 1000 });
    expect(validateTechnicalOverrideInput({ accountId, status: 'disabled' })).toMatchObject({ status: 'disabled' });
    expect(validateTechnicalOverrideInput({ accountId, scopes: ['conversation', 'analysis'] })).toMatchObject({
      scopes: ['conversation', 'analysis'],
    });
    expect(validateTechnicalOverrideInput({ accountId, capabilities: ['text-generation'] })).toMatchObject({
      capabilities: ['text-generation'],
    });
    expect(validateTechnicalOverrideInput({ accountId, maxDataClassification: 'restricted' })).toMatchObject({
      maxDataClassification: 'restricted',
    });
    // budgetMinor: null is a REAL change (it clears the budget).
    expect(validateTechnicalOverrideInput({ accountId, budgetMinor: null })).toEqual({
      accountId,
      priority: null,
      status: null,
      scopes: null,
      capabilities: null,
      maxDataClassification: null,
      budgetMinor: null,
      budgetProvided: true,
    });
    expect(validateTechnicalOverrideInput({ accountId, budgetMinor: 500 })).toMatchObject({
      budgetMinor: 500,
      budgetProvided: true,
    });

    const bad: unknown[] = [
      null,
      'override',
      {},
      { priority: 55 }, // no accountId
      { accountId: 'not-a-uuid', priority: 55 },
      { accountId, priority: -1 },
      { accountId, priority: 1001 },
      { accountId, priority: 10.5 },
      { accountId, priority: 'high' },
      { accountId, status: 'paused' },
      { accountId, scopes: 'conversation' },
      { accountId, scopes: [] },
      { accountId, scopes: ['conversation', 'nonsense'] },
      { accountId, scopes: ['conversation', 'conversation'] },
      { accountId, capabilities: ['text-generation', 'text-generation'] },
      { accountId, capabilities: ['mind-reading'] },
      { accountId, maxDataClassification: 'secret' },
      { accountId, budgetMinor: 0 },
      { accountId, budgetMinor: -5 },
      { accountId, budgetMinor: 2.5 },
      // A well-formed input that changes NOTHING is refused.
      { accountId },
    ];
    for (const shape of bad) {
      try {
        validateTechnicalOverrideInput(shape);
        throw new Error(`expected invalid_input for ${JSON.stringify(shape)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderPreferencesError);
        expect((error as ProviderPreferencesError).code).toBe('invalid_input');
      }
    }
  });
});
