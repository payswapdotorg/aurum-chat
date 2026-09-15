// Unit tests for the llm module's pure logic (no database): the
// provider/model registry, input validation/normalization, the
// deterministic router, cost accounting and EVERY provider adapter's
// build/parse behavior.
//
// W034 acceptance covered here:
//  * the registry is a closed, provider-neutral catalog — every provider
//    has an adapter, every model declares capabilities/prices, and the
//    registry confers no routing privilege (ordering comes from tenant
//    account facts only);
//  * inputs validate strictly (unknown keys, vocabularies, shapes, bounds)
//    with canonical error codes;
//  * eligibility/routing is deterministic and explainable — each §18
//    concern (scope, capability permission, data policy, budget, model
//    output limit, availability, pin) yields its own machine reason;
//  * cost accounting is deterministic integer minor units;
//  * adapters normalize provider dialects both ways and fail loudly
//    (provider_malformed_response) on unparseable payloads — provider
//    isolation is structural (adapter files are reachable only inside the
//    module; the contract never exposes them).

import { describe, expect, it } from 'vitest';
import { allLlmAdapters, getLlmAdapter } from '../adapters';
import { anthropicAdapter } from '../adapters/anthropic';
import { cohereAdapter } from '../adapters/cohere';
import { googleAdapter } from '../adapters/google';
import { mistralAdapter } from '../adapters/mistral';
import { openaiAdapter } from '../adapters/openai';
import { LlmError } from '../errors';
import {
  LLM_PROVIDERS,
  findLlmModel,
  type LlmModelDescriptor,
  type LlmProvider,
  isValidModelDescriptor,
  listLlmModels,
  listLlmProviders,
} from '../registry';
import {
  CLASSIFICATION_RANK,
  availabilityKey,
  costMinorForUsage,
  isEffectivelyUnavailable,
  monthStartUtc,
  routeLlmRequest,
  type AccountForRouting,
  type AvailabilityForRouting,
  type RouteLlmRequestInput,
} from '../routing';
import type {
  InvokeLlmInput,
  RegisterAiProviderAccountInput,
  VerifyProviderHotSwapInput,
} from '../types';
import {
  assertLlmTenantContext,
  isUuid,
  validateInvokeLlmInput,
  validateListAiProviderAccountsQuery,
  validateRegisterAiProviderAccountInput,
  validateSetAiAvailabilityInput,
  validateUpdateAiProviderAccountInput,
  validateVerifyProviderHotSwapInput,
} from '../validation';

function expectCode(code: LlmError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected LlmError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe(code);
  }
}

const GOOD_CONTEXT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  authority: [] as string[],
};

const AT = new Date('2026-09-14T12:00:00Z');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('llm registry — the closed provider/model catalog', () => {
  it('lists exactly the canonical providers, each with models and an adapter', () => {
    expect(listLlmProviders()).toEqual([...LLM_PROVIDERS]);
    for (const provider of listLlmProviders()) {
      const models = listLlmModels(provider);
      expect(models.length).toBeGreaterThan(0);
      expect(getLlmAdapter(provider).provider).toBe(provider);
    }
    expect(allLlmAdapters()).toHaveLength(LLM_PROVIDERS.length);
  });

  it('every registry model is a valid descriptor with unique ids per provider', () => {
    const all = listLlmModels();
    expect(all.length).toBeGreaterThan(0);
    for (const model of all) {
      expect(isValidModelDescriptor(model)).toBe(true);
    }
    for (const provider of listLlmProviders()) {
      const ids = listLlmModels(provider).map((model) => model.modelId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('finds models by (provider, modelId) and returns null for unknown ones', () => {
    expect(findLlmModel('openai', 'gpt-4o')?.capabilities).toEqual(['text-generation']);
    expect(findLlmModel('openai', 'text-embedding-3-small')?.capabilities).toEqual(['embedding']);
    expect(findLlmModel('openai', 'no-such-model')).toBeNull();
    expect(findLlmModel('anthropic', 'gpt-4o')).toBeNull();
  });

  it('findLlmModel hands out defensive copies (callers cannot mutate the registry)', () => {
    const model = findLlmModel('openai', 'gpt-4o')!;
    model.priceInputMinorPerMillion = 0;
    expect(findLlmModel('openai', 'gpt-4o')!.priceInputMinorPerMillion).toBe(250);
  });

  it('getLlmAdapter rejects unknown providers', () => {
    expectCode('unsupported_provider', () => getLlmAdapter('carrier-pigeon'));
  });

  it('embeddings exist for at least two providers and generation for all (routing discrimination is real)', () => {
    const embeddingProviders = new Set(
      listLlmModels()
        .filter((model) => model.capabilities.includes('embedding'))
        .map((model) => model.provider),
    );
    expect(embeddingProviders.size).toBeGreaterThanOrEqual(2);
    for (const provider of listLlmProviders()) {
      expect(
        listLlmModels(provider).some((model) => model.capabilities.includes('text-generation')),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation — context, accounts, invocations
// ---------------------------------------------------------------------------

describe('llm validation — context and guards', () => {
  it('accepts a well-formed TenantContext and rejects malformed ones', () => {
    expect(() => assertLlmTenantContext(GOOD_CONTEXT)).not.toThrow();
    expectCode('invalid_context', () => assertLlmTenantContext({ ...GOOD_CONTEXT, tenantId: '  ' }));
    expectCode('invalid_context', () => assertLlmTenantContext({ ...GOOD_CONTEXT, principalId: '' }));
    expectCode('invalid_context', () =>
      assertLlmTenantContext({ ...GOOD_CONTEXT, authority: 'admin' as unknown as string[] }),
    );
  });

  it('isUuid accepts uuids only', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('llm validation — account registration', () => {
  const good: RegisterAiProviderAccountInput = {
    provider: 'openai',
    label: '  Ops OpenAI  ',
    credentialRef: 'secret-store://openai/ops',
    scopes: ['cognition', 'analysis'],
    capabilities: ['text-generation', 'embedding'],
    maxDataClassification: 'internal',
    priority: 10,
    budgetMinor: 5_000,
  };

  it('normalizes a valid registration', () => {
    const valid = validateRegisterAiProviderAccountInput(good);
    expect(valid).toEqual({
      provider: 'openai',
      label: 'Ops OpenAI',
      credentialRef: 'secret-store://openai/ops',
      scopes: ['cognition', 'analysis'],
      capabilities: ['text-generation', 'embedding'],
      maxDataClassification: 'internal',
      priority: 10,
      budgetMinor: 5_000,
    });
  });

  it('rejects unknown fields, bad providers, vocabularies and shapes', () => {
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, tenantId: GOOD_CONTEXT.tenantId } as never),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, provider: 'carrier-pigeon' as never }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, scopes: [] }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, scopes: ['cognition', 'cognition'] }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, scopes: ['dreaming' as never] }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, capabilities: ['vision' as never] }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, maxDataClassification: 'secret' as never }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, priority: -1 }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, priority: 1_001 }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, budgetMinor: 0 }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, label: '' }),
    );
    expectCode('invalid_llm_input', () =>
      validateRegisterAiProviderAccountInput({ ...good, credentialRef: '   ' }),
    );
  });

  it('a null budget means uncapped', () => {
    const valid = validateRegisterAiProviderAccountInput({ ...good, budgetMinor: null });
    expect(valid.budgetMinor).toBeNull();
  });
});

describe('llm validation — account update', () => {
  const accountId = '33333333-3333-4333-8333-333333333333';

  it('validates present fields and requires at least one', () => {
    const valid = validateUpdateAiProviderAccountInput({ accountId, priority: 5 });
    expect(valid.priority).toBe(5);
    expect(valid.scopes).toBeNull();
    expectCode('invalid_llm_input', () => validateUpdateAiProviderAccountInput({ accountId }));
    expectCode('invalid_llm_input', () =>
      validateUpdateAiProviderAccountInput({ accountId, provider: 'groq' } as never),
    );
    expectCode('invalid_llm_input', () =>
      validateUpdateAiProviderAccountInput({ accountId, status: 'paused' as never }),
    );
  });

  it('distinguishes a cleared budget (null) from an absent one (undefined)', () => {
    const cleared = validateUpdateAiProviderAccountInput({ accountId, budgetMinor: null });
    expect(cleared.budgetProvided).toBe(true);
    expect(cleared.budgetMinor).toBeNull();
    const set = validateUpdateAiProviderAccountInput({ accountId, budgetMinor: 1_000 });
    expect(set.budgetProvided).toBe(true);
    expect(set.budgetMinor).toBe(1_000);
  });
});

describe('llm validation — invocation input', () => {
  const good: InvokeLlmInput = {
    capability: 'text-generation',
    scope: 'cognition',
    dataClassification: 'internal',
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Summarize the quarterly risk list.' },
    ],
    temperature: 0.2,
    maxOutputTokens: 512,
    idempotencyKey: 'llm:test-key-1',
  };

  it('normalizes a valid text-generation invocation', () => {
    const valid = validateInvokeLlmInput(good);
    expect(valid.messages).toEqual(good.messages);
    expect(valid.temperature).toBe(0.2);
    expect(valid.pinnedAccountId).toBeNull();
  });

  it('rejects wrong/missing canonical fields per capability', () => {
    expectCode('invalid_llm_input', () => validateInvokeLlmInput({ ...good, capability: 'vision' as never }));
    expectCode('invalid_llm_input', () => validateInvokeLlmInput({ ...good, scope: 'dreaming' as never }));
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({ ...good, dataClassification: 'secret' as never }),
    );
    expectCode('invalid_llm_input', () => validateInvokeLlmInput({ ...good, messages: [] }));
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({ ...good, messages: [{ role: 'robot' as never, content: 'x' }] }),
    );
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({ ...good, messages: [{ role: 'user', content: '  ' }] }),
    );
    expectCode('invalid_llm_input', () => validateInvokeLlmInput({ ...good, temperature: 3 }));
    expectCode('invalid_llm_input', () => validateInvokeLlmInput({ ...good, maxOutputTokens: 0 }));
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({ ...good, messages: undefined }),
    );
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({ ...good, unknownField: true } as never),
    );
  });

  it('embedding invocations take embeddingInput and no sampling parameters', () => {
    const valid = validateInvokeLlmInput({
      capability: 'embedding',
      scope: 'background',
      dataClassification: 'public',
      embeddingInput: 'the text to embed',
    });
    expect(valid.embeddingInput).toBe('the text to embed');
    expect(valid.messages).toBeNull();
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({
        capability: 'embedding',
        scope: 'background',
        dataClassification: 'public',
        embeddingInput: 'x',
        temperature: 0.5,
      }),
    );
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({
        capability: 'embedding',
        scope: 'background',
        dataClassification: 'public',
      }),
    );
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({
        capability: 'text-generation',
        scope: 'cognition',
        dataClassification: 'internal',
        messages: [{ role: 'user', content: 'x' }],
        embeddingInput: 'not for text-generation',
      }),
    );
  });

  it('a model pin requires its account pin; ids and keys are shape-checked', () => {
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({ ...good, pinnedModel: 'gpt-4o' }),
    );
    expectCode('invalid_llm_input', () =>
      validateInvokeLlmInput({ ...good, pinnedAccountId: 'not-a-uuid' }),
    );
    expectCode('invalid_llm_input', () => validateInvokeLlmInput({ ...good, idempotencyKey: ' spaced key' }));
    const valid = validateInvokeLlmInput({
      ...good,
      pinnedAccountId: '33333333-3333-4333-8333-333333333333',
      pinnedModel: 'gpt-4o',
    });
    expect(valid.pinnedModel).toBe('gpt-4o');
  });

  it('hot-swap verification validates the same canonical fields and rejects identical targets', () => {
    const base: VerifyProviderHotSwapInput = {
      capability: 'text-generation',
      scope: 'cognition',
      dataClassification: 'internal',
      messages: [{ role: 'user', content: 'Reply with the word: ready' }],
      targetA: { accountId: '33333333-3333-4333-8333-333333333333', model: 'gpt-4o' },
      targetB: { accountId: '44444444-4444-4444-8444-444444444444', model: 'claude-sonnet-4-5' },
    };
    expect(validateVerifyProviderHotSwapInput(base).targetA.model).toBe('gpt-4o');
    expectCode('invalid_llm_input', () =>
      validateVerifyProviderHotSwapInput({ ...base, targetB: base.targetA }),
    );
    expectCode('invalid_llm_input', () =>
      validateVerifyProviderHotSwapInput({ ...base, targetB: { accountId: 'x', model: 'y' } }),
    );
  });
});

describe('llm validation — queries and availability overrides', () => {
  it('account list queries validate', () => {
    expect(validateListAiProviderAccountsQuery({}).limit).toBe(50);
    expect(validateListAiProviderAccountsQuery({ provider: 'groq', limit: 1 }).provider).toBe('groq');
    expectCode('invalid_llm_query', () => validateListAiProviderAccountsQuery({ limit: 0 }));
    expectCode('invalid_llm_query', () => validateListAiProviderAccountsQuery({ limit: 501 }));
    expectCode('invalid_llm_query', () =>
      validateListAiProviderAccountsQuery({ provider: 'nope' } as never),
    );
  });

  it('availability overrides validate (expiry only on unavailable)', () => {
    const valid = validateSetAiAvailabilityInput({
      accountId: '33333333-3333-4333-8333-333333333333',
      model: 'gpt-4o',
      state: 'unavailable',
      reason: 'incident 42',
      expiresAt: '2026-09-14T13:00:00Z',
    });
    expect(valid.expiresAt).toBe('2026-09-14T13:00:00Z');
    expectCode('invalid_llm_input', () =>
      validateSetAiAvailabilityInput({
        accountId: '33333333-3333-4333-8333-333333333333',
        model: 'gpt-4o',
        state: 'available',
        expiresAt: '2026-09-14T13:00:00Z',
      }),
    );
    expectCode('invalid_llm_input', () =>
      validateSetAiAvailabilityInput({
        accountId: '33333333-3333-4333-8333-333333333333',
        model: 'gpt-4o',
        state: 'unavailable',
        expiresAt: '2026-09-14 13:00',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Routing (pure)
// ---------------------------------------------------------------------------

function routingAccount(overrides: Partial<AccountForRouting> = {}): AccountForRouting {
  return {
    id: 'account-1',
    provider: 'openai',
    status: 'active',
    scopes: ['cognition'],
    capabilities: ['text-generation', 'embedding'],
    maxDataClassification: 'internal',
    priority: 100,
    budgetMinor: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function routingInput(overrides: Partial<RouteLlmRequestInput> = {}): RouteLlmRequestInput {
  return {
    capability: 'text-generation',
    scope: 'cognition',
    dataClassification: 'internal',
    accounts: [routingAccount()],
    availability: new Map(),
    spendMinorByAccount: new Map(),
    providerModels: providerModels(),
    at: AT,
    pinnedAccountId: null,
    pinnedModel: null,
    maxOutputTokens: null,
    ...overrides,
  };
}

function providerModels(): Map<LlmProvider, LlmModelDescriptor[]> {
  const map = new Map<LlmProvider, LlmModelDescriptor[]>();
  for (const model of listLlmModels()) {
    const bucket = map.get(model.provider) ?? [];
    bucket.push(model);
    map.set(model.provider, bucket);
  }
  return map;
}

function reasonsOf(decision: ReturnType<typeof routeLlmRequest>): string[] {
  return decision.snapshot.candidates
    .filter((c) => !c.eligible)
    .map((c) => c.reason as string);
}

describe('llm routing — eligibility, ordering, pins, availability', () => {
  it('routes an eligible account to its registry-ordered models and records the choice', () => {
    const decision = routeLlmRequest(routingInput());
    // The account permits text-generation; openai carries two such models —
    // both eligible, registry order breaks the same-account tie.
    expect(decision.orderedEligible).toEqual([
      { accountId: 'account-1', provider: 'openai', model: 'gpt-4o' },
      { accountId: 'account-1', provider: 'openai', model: 'gpt-4o-mini' },
    ]);
    expect(decision.snapshot.chosen?.model).toBe('gpt-4o');
    expect(decision.snapshot.candidates).toHaveLength(3); // all openai models considered
    expect(decision.snapshot.candidates.every((c) => c.eligible)).toBe(false); // embedding models rejected
  });

  it('each eligibility concern yields its own machine reason', () => {
    expect(
      reasonsOf(
        routeLlmRequest(routingInput({ accounts: [routingAccount({ status: 'disabled' })] })),
      ),
    ).toEqual(
      expect.arrayContaining(['account_disabled']),
    );

    expect(
      reasonsOf(routeLlmRequest(routingInput({ accounts: [routingAccount({ scopes: ['conversation'] })] }))),
    ).toEqual(expect.arrayContaining(['scope_not_permitted']));

    expect(
      reasonsOf(
        routeLlmRequest(routingInput({ accounts: [routingAccount({ capabilities: ['embedding'] })] })),
      ),
    ).toEqual(expect.arrayContaining(['capability_not_permitted']));

    expect(
      reasonsOf(
        routeLlmRequest(routingInput({ dataClassification: 'restricted' })),
      ),
    ).toEqual(expect.arrayContaining(['data_classification_exceeds_account_policy']));

    expect(
      reasonsOf(
        routeLlmRequest(
          routingInput({
            accounts: [routingAccount({ budgetMinor: 500 })],
            spendMinorByAccount: new Map([['account-1', 500]]),
          }),
        ),
      ),
    ).toEqual(expect.arrayContaining(['budget_exhausted']));

    expect(
      reasonsOf(
        routeLlmRequest(routingInput({ maxOutputTokens: 32_768 })),
      ),
    ).toEqual(expect.arrayContaining(['model_output_limit', 'capability_not_supported_by_model']));
  });

  it('orders eligible candidates by priority, then creation time (deterministic)', () => {
    const first = routingAccount({ id: 'a-first', priority: 0, createdAt: '2026-01-01T00:00:00Z' });
    const second = routingAccount({ id: 'b-second', priority: 0, createdAt: '2026-02-01T00:00:00Z' });
    const third = routingAccount({ id: 'c-third', priority: 5, createdAt: '2025-01-01T00:00:00Z' });
    const decision = routeLlmRequest(routingInput({ accounts: [third, second, first] }));
    // Two text-generation models per account: priority, then creation
    // time, then registry order within the winning account.
    expect(decision.orderedEligible.map((c) => [c.accountId, c.model])).toEqual([
      ['a-first', 'gpt-4o'],
      ['a-first', 'gpt-4o-mini'],
      ['b-second', 'gpt-4o'],
      ['b-second', 'gpt-4o-mini'],
      ['c-third', 'gpt-4o'],
      ['c-third', 'gpt-4o-mini'],
    ]);
  });

  it('pinned invocations consider only the pinned account (and model)', () => {
    const account = routingAccount();
    const other = routingAccount({ id: 'account-2', priority: 0 });
    const decision = routeLlmRequest(
      routingInput({
        accounts: [account, other],
        pinnedAccountId: 'account-1',
      }),
    );
    expect(decision.snapshot.pinned).toBe(true);
    expect(decision.orderedEligible.every((c) => c.accountId === 'account-1')).toBe(true);
    expect(decision.snapshot.candidates.every((c) => c.accountId === 'account-1')).toBe(true);

    const pinnedModel = routeLlmRequest(
      routingInput({ accounts: [account], pinnedAccountId: 'account-1', pinnedModel: 'gpt-4o-mini' }),
    );
    expect(pinnedModel.orderedEligible).toEqual([
      { accountId: 'account-1', provider: 'openai', model: 'gpt-4o-mini' },
    ]);
    // The other models of the pinned account are rejected with their own
    // first applicable reasons (registry order).
    expect(pinnedModel.snapshot.candidates.map((c) => `${c.model}:${c.reason}`)).toEqual([
      'gpt-4o:not_pinned_target',
      'gpt-4o-mini:null',
      'text-embedding-3-small:capability_not_supported_by_model',
    ]);
  });

  it('automatic routing skips unavailable candidates until their cooldown expires; pins bypass', () => {
    const availability = new Map<string, AvailabilityForRouting>([
      [availabilityKey('account-1', 'gpt-4o'), { state: 'unavailable', expiresAt: '2999-01-01T00:00:00Z' }],
      [availabilityKey('account-1', 'gpt-4o-mini'), { state: 'unavailable', expiresAt: '2020-01-01T00:00:00Z' }],
    ]);
    const decision = routeLlmRequest(routingInput({ availability }));
    // gpt-4o is cooling down; gpt-4o-mini's cooldown has lapsed; embedding
    // models are capability-rejected — exactly one eligible candidate.
    expect(decision.orderedEligible.map((c) => c.model)).toEqual(['gpt-4o-mini']);

    // An explicit pin overrides the availability heuristic.
    const pinned = routeLlmRequest(
      routingInput({ availability, pinnedAccountId: 'account-1', pinnedModel: 'gpt-4o' }),
    );
    expect(pinned.orderedEligible.map((c) => c.model)).toEqual(['gpt-4o']);
  });

  it('indefinite unavailability has no expiry and is always skipped', () => {
    const availability = new Map<string, AvailabilityForRouting>([
      [availabilityKey('account-1', 'gpt-4o'), { state: 'unavailable', expiresAt: null }],
    ]);
    const decision = routeLlmRequest(routingInput({ availability }));
    expect(decision.orderedEligible.map((c) => c.model)).toEqual(['gpt-4o-mini']);
  });

  it('isEffectivelyUnavailable evaluates cooldown expiry directly', () => {
    expect(
      isEffectivelyUnavailable({ state: 'unavailable', expiresAt: null }, AT),
    ).toBe(true);
    expect(
      isEffectivelyUnavailable({ state: 'unavailable', expiresAt: '2999-01-01T00:00:00Z' }, AT),
    ).toBe(true);
    expect(
      isEffectivelyUnavailable({ state: 'unavailable', expiresAt: '2020-01-01T00:00:00Z' }, AT),
    ).toBe(false);
    expect(isEffectivelyUnavailable({ state: 'available', expiresAt: null }, AT)).toBe(false);
    expect(isEffectivelyUnavailable(undefined, AT)).toBe(false);
  });

  it('classification ranking is ordered public < internal < restricted', () => {
    expect(CLASSIFICATION_RANK.public).toBeLessThan(CLASSIFICATION_RANK.internal);
    expect(CLASSIFICATION_RANK.internal).toBeLessThan(CLASSIFICATION_RANK.restricted);
  });
});

// ---------------------------------------------------------------------------
// Cost accounting (pure)
// ---------------------------------------------------------------------------

describe('llm cost accounting — deterministic integer minor units', () => {
  it('computes per-direction ceil over the registry list price', () => {
    const gpt4o = findLlmModel('openai', 'gpt-4o')!; // 250 in / 1_000 out minor per million
    // 1M in / 1M out → exactly the list price.
    expect(costMinorForUsage(gpt4o, 1_000_000, 1_000_000)).toBe(1_250);
    // Fractional micro-minor rounds UP per direction.
    expect(costMinorForUsage(gpt4o, 1, 1)).toBe(2); // ceil(0.00025)=1 + ceil(0.001)=1
    expect(costMinorForUsage(gpt4o, 0, 0)).toBe(0);
    // Deterministic across calls.
    expect(costMinorForUsage(gpt4o, 123_456, 654_321)).toBe(
      costMinorForUsage(gpt4o, 123_456, 654_321),
    );
    expect(costMinorForUsage(gpt4o, 123_456, 654_321)).toBe(
      Math.ceil((123_456 * 250) / 1_000_000) + Math.ceil((654_321 * 1_000) / 1_000_000),
    );
  });

  it('monthStartUtc truncates to the first day of the UTC month', () => {
    expect(monthStartUtc(new Date('2026-09-14T12:00:00Z')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(monthStartUtc(new Date('2026-01-01T00:00:00.001Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});

// ---------------------------------------------------------------------------
// Adapters (pure dialect translation)
// ---------------------------------------------------------------------------

const COMPLETION_INPUT: import('../adapters/types').WireCompletionInput = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi.' },
    { role: 'user', content: 'Summarize.' },
  ],
  temperature: 0.4,
  maxOutputTokens: 256,
};

describe('llm adapters — completion dialects build and parse symmetrically', () => {
  it('openai builds chat-completions bodies and parses responses', () => {
    const body = openaiAdapter.buildCompletionRequest(COMPLETION_INPUT) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.4);
    expect(body.messages).toEqual(COMPLETION_INPUT.messages.map((m) => ({ role: m.role, content: m.content })));

    const parsed = openaiAdapter.parseCompletionResponse({
      id: 'chatcmpl-1',
      choices: [{ message: { content: '  Ready.  ' } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    });
    expect(parsed.text).toBe('  Ready.  ');
    expect(parsed.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
    expect(parsed.providerExecutionId).toBe('chatcmpl-1');

    expectCode('provider_malformed_response', () =>
      openaiAdapter.parseCompletionResponse({ choices: [] }),
    );
    expectCode('provider_malformed_response', () =>
      openaiAdapter.parseCompletionResponse({ choices: [{ message: { content: 5 } }], usage: {} }),
    );
  });

  it('anthropic hoists system prompts into the system field and joins text blocks', () => {
    const body = anthropicAdapter.buildCompletionRequest(COMPLETION_INPUT) as Record<string, unknown>;
    expect(body.system).toBe('Be terse.');
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Summarize.' }] },
    ]);

    const parsed = anthropicAdapter.parseCompletionResponse({
      id: 'msg_1',
      content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    expect(parsed.text).toBe('AB');
    expect(parsed.usage).toEqual({ inputTokens: 7, outputTokens: 2 });

    expectCode('invalid_llm_input', () =>
      anthropicAdapter.buildCompletionRequest({
        ...COMPLETION_INPUT,
        messages: [{ role: 'system', content: 'only system' }],
      }),
    );
  });

  it('google maps roles (system → systemInstruction, assistant → model)', () => {
    const body = googleAdapter.buildCompletionRequest(COMPLETION_INPUT) as Record<string, unknown>;
    expect((body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text).toBe(
      'Be terse.',
    );
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi.' }] },
      { role: 'user', parts: [{ text: 'Summarize.' }] },
    ]);
    expect((body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(256);

    const parsed = googleAdapter.parseCompletionResponse({
      candidates: [{ content: { parts: [{ text: 'ok' }, { text: '!' }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
    });
    expect(parsed.text).toBe('ok!');
    expect(parsed.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
  });

  it('mistral and cohere build/parse their dialects', () => {
    const mistralBody = mistralAdapter.buildCompletionRequest(COMPLETION_INPUT) as Record<
      string,
      unknown
    >;
    expect(mistralBody.messages).toHaveLength(4);

    const mistralParsed = mistralAdapter.parseCompletionResponse({
      id: 'm-1',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    expect(mistralParsed.text).toBe('ok');

    const cohereBody = cohereAdapter.buildCompletionRequest(COMPLETION_INPUT) as Record<
      string,
      unknown
    >;
    expect(cohereBody.model).toBe('test-model');
    const cohereParsed = cohereAdapter.parseCompletionResponse({
      id: 'c-1',
      text: 'fine',
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    expect(cohereParsed.text).toBe('fine');
    expectCode('provider_malformed_response', () => cohereAdapter.parseCompletionResponse({}));
  });

  it('deepseek and groq reuse the openai-compatible dialect (hot-swap by construction)', () => {
    const deepseek = getLlmAdapter('deepseek');
    const groq = getLlmAdapter('groq');
    const body = deepseek.buildCompletionRequest(COMPLETION_INPUT);
    expect(body).toEqual(openaiAdapter.buildCompletionRequest(COMPLETION_INPUT));
    expect(deepseek.provider).toBe('deepseek');
    expect(groq.provider).toBe('groq');
    expect(deepseek.buildCompletionRequest(COMPLETION_INPUT)).toEqual(
      groq.buildCompletionRequest(COMPLETION_INPUT),
    );
  });
});

describe('llm adapters — embedding dialects', () => {
  const VECTOR = [0.1, -0.2, 0.3];

  it('openai parses data[0].embedding', () => {
    const parsed = openaiAdapter.parseEmbeddingResponse({
      data: [{ embedding: VECTOR }],
      usage: { prompt_tokens: 2 },
    });
    expect(parsed.vector).toEqual(VECTOR);
    expect(parsed.usage).toEqual({ inputTokens: 2, outputTokens: 0 });
    expectCode('provider_malformed_response', () =>
      openaiAdapter.parseEmbeddingResponse({ data: [], usage: {} }),
    );
  });

  it('google parses embedding.values; mistral parses data[0].embedding; cohere parses embeddings.float', () => {
    expect(
      googleAdapter.parseEmbeddingResponse({
        embedding: { values: VECTOR },
        usageMetadata: { tokenCount: 2 },
      }).vector,
    ).toEqual(VECTOR);
    expect(
      mistralAdapter.parseEmbeddingResponse({
        data: [{ embedding: VECTOR }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }).vector,
    ).toEqual(VECTOR);
    expect(
      cohereAdapter.parseEmbeddingResponse({
        embeddings: { float: [VECTOR] },
        meta: { billed_units: { input_tokens: 2 } },
      }).vector,
    ).toEqual(VECTOR);
  });

  it('rejects malformed vectors (non-finite entries, oversized, empty)', () => {
    expectCode('provider_malformed_response', () =>
      openaiAdapter.parseEmbeddingResponse({
        data: [{ embedding: [0.1, Number.NaN] }],
        usage: { prompt_tokens: 1 },
      }),
    );
    expectCode('provider_malformed_response', () =>
      openaiAdapter.parseEmbeddingResponse({ data: [{ embedding: [] }], usage: {} }),
    );
    const tooBig = Array.from({ length: 4_097 }, (_, index) => index / 4_097);
    expectCode('provider_malformed_response', () =>
      openaiAdapter.parseEmbeddingResponse({
        data: [{ embedding: tooBig }],
        usage: { prompt_tokens: 1 },
      }),
    );
  });
});
