// Unit tests for the agents module's W035 surface — the code-owned runtime
// registry (capabilities, centralized pricing, the exact preservation of
// the W021 adapters' historical cost arithmetic), the pure deterministic
// dispatch router (every rejection reason, ordering, availability expiry)
// and the runtime-account/availability input guards. Pure logic only —
// no database, no clock, no transport.

import { describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_CAPABILITIES,
  agentRuntimeCostMinor,
  findAgentRuntime,
  isAgentRuntimeCapability,
  isValidAgentRuntimeDescriptor,
  listAgentRuntimes,
  registryCoversVocabulary,
} from '../registry';
import { isEffectivelyUnavailable, routeAgentRuntimeDispatch } from '../routing';
import type { AgentRuntimeAccountForRouting } from '../routing';
import { AGENT_RUNTIME_PROVIDERS } from '../policy';
import { allAgentRuntimeAdapters } from '../adapters';
import {
  validateGetAgentRuntimeAvailabilityQuery,
  validateListAgentRuntimeAccountsQuery,
  validateRegisterAgentRuntimeAccountInput,
  validateSetAgentRuntimeAvailabilityInput,
  validateUpdateAgentRuntimeAccountInput,
} from '../validation';
import { AgentsError } from '../errors';
import type { RegisterAgentRuntimeAccountInput } from '../types';

// ---------------------------------------------------------------------------
// The registry (code-owned platform reference data)
// ---------------------------------------------------------------------------

describe('runtime registry (W035)', () => {
  it('covers exactly the canonical provider vocabulary, one descriptor each', () => {
    expect(registryCoversVocabulary()).toBe(true);
    const runtimes = listAgentRuntimes();
    expect(runtimes.map((runtime) => runtime.provider).sort()).toEqual(
      [...AGENT_RUNTIME_PROVIDERS].sort(),
    );
    for (const runtime of runtimes) {
      expect(findAgentRuntime(runtime.provider)?.label).toBe(runtime.label);
      expect(isValidAgentRuntimeDescriptor(runtime)).toBe(true);
    }
    // Lookups are stable copies, not live references.
    const first = findAgentRuntime('crewai');
    const second = findAgentRuntime('crewai');
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(findAgentRuntime('no-such-runtime' as never)).toBeNull();
  });

  it('serves at least one capability and no runtime is privileged by position', () => {
    for (const runtime of listAgentRuntimes()) {
      expect(runtime.capabilities.length).toBeGreaterThan(0);
      expect(runtime.capabilities.every((capability) => isAgentRuntimeCapability(capability))).toBe(
        true,
      );
    }
    expect(AGENT_RUNTIME_CAPABILITIES).toContain('task-execution');
    expect(isAgentRuntimeCapability('task-execution')).toBe(true);
    expect(isAgentRuntimeCapability('telepathy')).toBe(false);
    expect(isAgentRuntimeCapability(42)).toBe(false);
  });

  it('carries the W021 adapters\' historical list prices verbatim (centralized, unchanged)', () => {
    // The interim adapter constants, pinned here so the registry move can
    // never silently change pricing (W035's exactness contract).
    expect(findAgentRuntime('openai-assistants')?.pricing).toEqual({
      inputMinorPerMillion: 250,
      outputMinorPerMillion: 1_000,
      operationMinorPerThousand: null,
      currency: 'USD',
    });
    expect(findAgentRuntime('langgraph')?.pricing).toEqual({
      inputMinorPerMillion: 250,
      outputMinorPerMillion: 1_000,
      operationMinorPerThousand: 20,
      currency: 'USD',
    });
    expect(findAgentRuntime('crewai')?.pricing).toEqual({
      inputMinorPerMillion: 150,
      outputMinorPerMillion: 600,
      operationMinorPerThousand: 10_000,
      currency: 'USD',
    });
    expect(findAgentRuntime('autogen')?.pricing).toEqual({
      inputMinorPerMillion: 300,
      outputMinorPerMillion: 900,
      operationMinorPerThousand: null,
      currency: 'USD',
    });
    expect(findAgentRuntime('semantic-kernel')?.pricing).toEqual({
      inputMinorPerMillion: 200,
      outputMinorPerMillion: 800,
      operationMinorPerThousand: 5_000,
      currency: 'USD',
    });
  });

  it('costs usage exactly as the adapters always did (byte-for-byte arithmetic)', () => {
    for (const adapter of allAgentRuntimeAdapters()) {
      const runtime = findAgentRuntime(adapter.provider);
      expect(runtime).not.toBeNull();
      const cases: Array<{ inputTokens: number | null; outputTokens: number | null; operations: number | null }> = [
        { inputTokens: null, outputTokens: null, operations: null },
        { inputTokens: 0, outputTokens: 0, operations: 0 },
        { inputTokens: 1_000_000, outputTokens: 0, operations: null },
        { inputTokens: 0, outputTokens: 1_000_000, operations: null },
        { inputTokens: 1_200, outputTokens: 800, operations: 3 },
        { inputTokens: 2_500_000, outputTokens: 400_000, operations: 12 },
        { inputTokens: 1600, outputTokens: 0, operations: 20 },
        { inputTokens: 999_999, outputTokens: 999_999, operations: 999 },
      ];
      for (const usage of cases) {
        expect(agentRuntimeCostMinor(runtime!.pricing, usage)).toBe(adapter.costForUsage(usage));
      }
    }
  });

  it('cost accounting is deterministic, non-negative and treats null usage as zero', () => {
    const pricing = findAgentRuntime('langgraph')!.pricing;
    const usage = { inputTokens: 1_234_567, outputTokens: 765_432, operations: 45 };
    expect(agentRuntimeCostMinor(pricing, usage)).toBe(agentRuntimeCostMinor(pricing, usage));
    expect(agentRuntimeCostMinor(pricing, usage)).toBeGreaterThanOrEqual(0);
    expect(agentRuntimeCostMinor(pricing, { inputTokens: null, outputTokens: null, operations: null })).toBe(0);
    // Null operations are free for runtimes that do not bill them.
    const tokenOnly = findAgentRuntime('openai-assistants')!.pricing;
    expect(
      agentRuntimeCostMinor(tokenOnly, { inputTokens: 1_000_000, outputTokens: 0, operations: 5 }),
    ).toBe(250);
  });

  it('rejects malformed descriptors (the honest-edit guard)', () => {
    const good = findAgentRuntime('crewai')!;
    expect(
      isValidAgentRuntimeDescriptor({ ...good, provider: 'not-a-runtime' as never }),
    ).toBe(false);
    expect(isValidAgentRuntimeDescriptor({ ...good, label: '' })).toBe(false);
    expect(
      isValidAgentRuntimeDescriptor({ ...good, capabilities: [] as never }),
    ).toBe(false);
    expect(
      isValidAgentRuntimeDescriptor({
        ...good,
        pricing: { ...good.pricing, inputMinorPerMillion: -1 },
      }),
    ).toBe(false);
    expect(
      isValidAgentRuntimeDescriptor({
        ...good,
        pricing: { ...good.pricing, operationMinorPerThousand: -5 },
      }),
    ).toBe(false);
    expect(
      isValidAgentRuntimeDescriptor({ ...good, pricing: { ...good.pricing, currency: 'EUR' as never } }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The deterministic router (pure — every rejection reason, ordering)
// ---------------------------------------------------------------------------

function account(overrides: Partial<AgentRuntimeAccountForRouting> & { id: string }): AgentRuntimeAccountForRouting {
  return {
    provider: 'crewai',
    status: 'active',
    capabilities: ['task-execution'],
    maxAuthorityLevel: 'EXECUTE',
    priority: 100,
    createdAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

const AT = new Date('2026-09-14T12:00:00.000Z');

function route(accounts: AgentRuntimeAccountForRouting[], overrides: Partial<Parameters<typeof routeAgentRuntimeDispatch>[0]> = {}) {
  return routeAgentRuntimeDispatch({
    provider: 'crewai',
    capability: 'task-execution',
    authorityLevel: 'ANALYZE',
    accounts,
    availability: new Map(),
    at: AT,
    ...overrides,
  });
}

describe('dispatch routing (W035, pure)', () => {
  it('routes to the single eligible account and records the full candidate snapshot', () => {
    const only = account({ id: 'a1' });
    const decision = route([only]);
    expect(decision.orderedEligible).toEqual([{ accountId: 'a1', provider: 'crewai' }]);
    expect(decision.snapshot).toEqual({
      routed: true,
      provider: 'crewai',
      candidates: [{ accountId: 'a1', provider: 'crewai', eligible: true, reason: null }],
      chosen: { accountId: 'a1', provider: 'crewai' },
    });
  });

  it('names every rejection reason (lock 24: neutral facts, never semantics)', () => {
    const decision = route([
      account({ id: 'foreign', provider: 'langgraph' }),
      account({ id: 'off', status: 'disabled' }),
      account({ id: 'nocap', capabilities: [] as never }),
      account({ id: 'low-ceiling', maxAuthorityLevel: 'OBSERVE' }),
      account({ id: 'cooling' }),
    ], {
      availability: new Map([
        ['cooling', { state: 'unavailable', expiresAt: '2026-09-14T12:30:00.000Z' }],
      ]),
    });
    const byId = new Map(decision.snapshot.candidates.map((candidate) => [candidate.accountId, candidate]));
    expect(byId.get('foreign')?.reason).toBe('provider_mismatch');
    expect(byId.get('off')?.reason).toBe('account_disabled');
    expect(byId.get('nocap')?.reason).toBe('capability_not_permitted');
    expect(byId.get('low-ceiling')?.reason).toBe('authority_exceeds_account_policy');
    expect(byId.get('cooling')?.reason).toBe('unavailable');
    expect(decision.orderedEligible).toEqual([]);
    expect(decision.snapshot.chosen).toBeNull();
    expect(decision.snapshot.routed).toBe(false);
  });

  it('orders eligible accounts by priority, then creation time, then id — never registry position', () => {
    const decision = route([
      account({ id: 'late-b', priority: 10, createdAt: '2026-09-15T00:00:00.000Z' }),
      account({ id: 'early', priority: 10, createdAt: '2026-09-14T00:00:00.000Z' }),
      account({ id: 'best', priority: 0 }),
      account({ id: 'worst', priority: 1000 }),
      account({ id: 'tie-a', priority: 10, createdAt: '2026-09-14T00:00:00.000Z' }),
      account({ id: 'tie-b', priority: 10, createdAt: '2026-09-14T00:00:00.000Z' }),
    ]);
    expect(decision.orderedEligible.map((candidate) => candidate.accountId)).toEqual([
      'best',
      'early',
      'tie-a',
      'tie-b',
      'late-b',
      'worst',
    ]);
  });

  it('is a total deterministic function: same facts, same decision', () => {
    const accounts = [
      account({ id: 'x', priority: 5 }),
      account({ id: 'y', priority: 5 }),
    ];
    expect(route(accounts)).toEqual(route(accounts));
  });

  it('availability: expired cooldowns read as available; indefinite does not', () => {
    expect(isEffectivelyUnavailable(undefined, AT)).toBe(false);
    expect(isEffectivelyUnavailable({ state: 'available', expiresAt: null }, AT)).toBe(false);
    expect(
      isEffectivelyUnavailable({ state: 'unavailable', expiresAt: null }, AT),
    ).toBe(true);
    expect(
      isEffectivelyUnavailable(
        { state: 'unavailable', expiresAt: '2026-09-14T11:59:59.999Z' },
        AT,
      ),
    ).toBe(false);
    expect(
      isEffectivelyUnavailable(
        { state: 'unavailable', expiresAt: '2026-09-14T12:00:00.001Z' },
        AT,
      ),
    ).toBe(true);
    // An expired cooldown is routable again.
    const decision = route([account({ id: 'back' })], {
      availability: new Map([
        ['back', { state: 'unavailable', expiresAt: '2026-09-14T11:00:00.000Z' }],
      ]),
    });
    expect(decision.orderedEligible.map((candidate) => candidate.accountId)).toEqual(['back']);
  });

  it('the authority ceiling compares §20 levels, not strings', () => {
    // ASK > ANALYZE: an ANALYZE-ceiling account may not serve an ASK dispatch.
    const ask = route([account({ id: 'cap', maxAuthorityLevel: 'ANALYZE' })], {
      authorityLevel: 'ASK',
    });
    expect(ask.snapshot.candidates[0]?.reason).toBe('authority_exceeds_account_policy');
    // EXECUTE ceiling serves every level.
    const observe = route([account({ id: 'cap', maxAuthorityLevel: 'EXECUTE' })], {
      authorityLevel: 'EXECUTE',
    });
    expect(observe.snapshot.candidates[0]?.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation — runtime accounts and availability (W035 input guards)
// ---------------------------------------------------------------------------

const ACCOUNT: RegisterAgentRuntimeAccountInput = {
  provider: 'langgraph',
  label: 'self-hosted',
  credentialRef: 'secret-store://langgraph/self-hosted',
  capabilities: ['task-execution'],
  maxAuthorityLevel: 'EXECUTE',
  priority: 10,
};

function expectInputError(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected an AgentsError but the call succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentsError);
    expect((error as AgentsError).code).toBe('invalid_agent_input');
  }
}

describe('validation — runtime accounts (W035)', () => {
  it('normalizes a valid registration', () => {
    const valid = validateRegisterAgentRuntimeAccountInput({
      ...ACCOUNT,
      capabilities: ['task-execution', 'task-execution'],
    });
    expect(valid).toEqual(ACCOUNT);
  });

  it('rejects malformed providers, labels and credential references', () => {
    expectInputError(() => validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, provider: 'skynet' as never }));
    expectInputError(() => validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, label: '' }));
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, label: 'x'.repeat(101) }),
    );
    expectInputError(() => validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, credentialRef: '' }));
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, credentialRef: `bad${' '}ref` }),
    );
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, credentialRef: 'x'.repeat(256) }),
    );
  });

  it('rejects capability lists outside the closed vocabulary, empty or oversized', () => {
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, capabilities: [] as never }),
    );
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, capabilities: ['mind-reading'] as never }),
    );
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, capabilities: 'task-execution' as never }),
    );
  });

  it('bounds the authority ceiling and the priority', () => {
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, maxAuthorityLevel: 'SUPER' as never }),
    );
    expectInputError(() => validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, priority: -1 }));
    expectInputError(() => validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, priority: 1001 }));
    expectInputError(() => validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, priority: 1.5 }));
  });

  it('rejects unknown fields (identity, tenancy and accounting are minted)', () => {
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, id: 'smuggled' } as never),
    );
    expectInputError(() =>
      validateRegisterAgentRuntimeAccountInput({ ...ACCOUNT, status: 'active' } as never),
    );
  });

  it('updates require a uuid and at least one mutable change', () => {
    const valid = validateUpdateAgentRuntimeAccountInput({
      accountId: '00000000-0000-4000-8000-000000000001',
      priority: 5,
      status: 'disabled',
    });
    expect(valid.priority).toBe(5);
    expect(valid.status).toBe('disabled');
    expectInputError(() =>
      validateUpdateAgentRuntimeAccountInput({ accountId: 'nope' } as never),
    );
    expectInputError(() =>
      validateUpdateAgentRuntimeAccountInput({
        accountId: '00000000-0000-4000-8000-000000000001',
      } as never),
    );
    expectInputError(() =>
      validateUpdateAgentRuntimeAccountInput({
        accountId: '00000000-0000-4000-8000-000000000001',
        status: 'paused' as never,
      }),
    );
  });

  it('list queries validate filters and limits', () => {
    expect(
      validateListAgentRuntimeAccountsQuery({ provider: 'crewai', status: 'disabled', limit: 10 }),
    ).toEqual({ provider: 'crewai', status: 'disabled', limit: 10 });
    expect(validateListAgentRuntimeAccountsQuery({})).toEqual({
      provider: null,
      status: null,
      limit: 50,
    });
    expect(() =>
      validateListAgentRuntimeAccountsQuery({ provider: 'nope' as never }),
    ).toThrow(AgentsError);
    expect(() =>
      validateListAgentRuntimeAccountsQuery({ limit: 0 }),
    ).toThrow(AgentsError);
    expect(() =>
      validateListAgentRuntimeAccountsQuery({ rogue: true } as never),
    ).toThrow(/unknown field/);
  });
});

describe('validation — runtime availability (W035)', () => {
  const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';

  it('normalizes a valid manual override', () => {
    const valid = validateSetAgentRuntimeAvailabilityInput({
      accountId: ACCOUNT_ID,
      state: 'unavailable',
      reason: 'planned maintenance',
      expiresAt: '2026-09-14T13:00:00Z',
    });
    expect(valid).toEqual({
      accountId: ACCOUNT_ID,
      state: 'unavailable',
      reason: 'planned maintenance',
      expiresAt: '2026-09-14T13:00:00Z',
    });
  });

  it('expiresAt applies to the unavailable state only; instants must be strict ISO 8601', () => {
    expectInputError(() =>
      validateSetAgentRuntimeAvailabilityInput({
        accountId: ACCOUNT_ID,
        state: 'available',
        expiresAt: '2026-09-14T13:00:00Z',
      }),
    );
    expectInputError(() =>
      validateSetAgentRuntimeAvailabilityInput({
        accountId: ACCOUNT_ID,
        state: 'unavailable',
        expiresAt: '2026-09-14 13:00:00',
      }),
    );
    expectInputError(() =>
      validateSetAgentRuntimeAvailabilityInput({
        accountId: ACCOUNT_ID,
        state: 'weird' as never,
      }),
    );
    expectInputError(() =>
      validateSetAgentRuntimeAvailabilityInput({ accountId: 'nope', state: 'available' }),
    );
    expect(() =>
      validateSetAgentRuntimeAvailabilityInput({ rogue: true } as never),
    ).toThrow(/unknown field/);
  });

  it('availability queries take an optional uuid account filter', () => {
    expect(validateGetAgentRuntimeAvailabilityQuery({})).toEqual({ accountId: null });
    expect(validateGetAgentRuntimeAvailabilityQuery({ accountId: ACCOUNT_ID })).toEqual({
      accountId: ACCOUNT_ID,
    });
    expect(() => validateGetAgentRuntimeAvailabilityQuery({ accountId: 'nope' })).toThrow(
      AgentsError,
    );
  });
});
