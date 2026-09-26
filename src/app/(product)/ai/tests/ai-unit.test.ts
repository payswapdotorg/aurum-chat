// Unit tests for the AI-providers product surface's PURE logic (W066):
// the label/tone/format vocabularies, the client-safe vocabulary copies
// (locked to the llm contract), the API body parsers, the error mapping,
// the idempotency/gate-id derivations, and the command-registry
// destination. No database (the integration suite covers the contract
// compositions).

import { describe, expect, it } from 'vitest';
import {
  AI_CLASSIFICATIONS,
  AI_SCOPES,
  CLASSIFICATION_RANK,
  ACCOUNT_TEST_PROMPT,
  CREDENTIAL_NOTE,
  EMBEDDING_TEST_INPUT,
  HOT_SWAP_PROMPT,
  NO_PRIVILEGED_PROVIDER_NOTE,
  REVOKE_NOTE,
  ageLabel,
  availabilityLabel,
  availabilityTone,
  capabilityLabel,
  classificationLabel,
  formatLatency,
  formatPricePerMillion,
  formatTokens,
  formatUsdMinor,
  hotSwapOutcomeExplanation,
  hotSwapOutcomeLabel,
  hotSwapOutcomeTone,
  providerLabel,
  providerOptions,
  routingRejectionLabel,
  scopeLabel,
  suggestedHotSwapParameters,
} from '../lib/labels';
import {
  AI_ACTIONS,
  accountTestIdempotencyKey,
  extractGateActionRequestId,
  hotSwapIdempotencyKey,
  isAiAction,
  parseActionBody,
  pickTestCapability,
  pickTestScope,
} from '../lib/actions';
import { aiApiError, verificationIdFromRequest } from '../lib/api';
import { accountModelRows } from '../lib/views';
import { AI_DESTINATIONS, buildShellCommands } from '../../lib/command-registry';
import {
  DATA_CLASSIFICATIONS,
  LLM_CAPABILITIES,
  LLM_PROVIDERS,
  LLM_SCOPES,
  listLlmModels,
} from '@/modules/llm/contract';
import type { AiProviderAccount, LlmModelDescriptor } from '@/modules/llm/contract';

// ---------------------------------------------------------------------------
// The vocabularies (totals: every domain value has human copy)
// ---------------------------------------------------------------------------

describe('provider and vocabulary labels', () => {
  it('labels every registry provider (labels only — never a ranking)', () => {
    for (const provider of LLM_PROVIDERS) {
      expect(providerLabel(provider).length).toBeGreaterThan(0);
    }
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('anthropic')).toBe('Anthropic');
  });

  it('the client-safe vocabulary copies are locked to the llm contract (no drift)', () => {
    // The navigation.ts discipline: client components cannot import the
    // contract at runtime, so the local copies are the lock.
    expect([...AI_SCOPES]).toEqual([...LLM_SCOPES]);
    expect([...AI_CLASSIFICATIONS]).toEqual([...DATA_CLASSIFICATIONS]);
  });

  it('labels every scope, classification and capability', () => {
    for (const scope of LLM_SCOPES) expect(scopeLabel(scope).length).toBeGreaterThan(0);
    for (const classification of DATA_CLASSIFICATIONS) {
      expect(classificationLabel(classification).length).toBeGreaterThan(0);
    }
    for (const capability of LLM_CAPABILITIES) {
      expect(capabilityLabel(capability).length).toBeGreaterThan(0);
    }
  });

  it('classification rank orders public < internal < restricted', () => {
    expect(CLASSIFICATION_RANK.public).toBeLessThan(CLASSIFICATION_RANK.internal);
    expect(CLASSIFICATION_RANK.internal).toBeLessThan(CLASSIFICATION_RANK.restricted);
  });

  it('labels every routing rejection reason a snapshot can carry', () => {
    const reasons = [
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
    for (const reason of reasons) {
      expect(routingRejectionLabel(reason).length).toBeGreaterThan(4);
    }
  });

  it('availability and hot-swap outcomes map to tones and human copy', () => {
    expect(availabilityTone('available')).toBe('positive');
    expect(availabilityTone('unavailable')).toBe('error');
    expect(availabilityLabel('unavailable')).toBe('Unavailable');
    expect(hotSwapOutcomeTone('equivalent')).toBe('positive');
    expect(hotSwapOutcomeTone('completed-divergent')).toBe('info');
    expect(hotSwapOutcomeTone('failed')).toBe('error');
    for (const outcome of ['equivalent', 'completed-divergent', 'failed'] as const) {
      expect(hotSwapOutcomeLabel(outcome).length).toBeGreaterThan(3);
      expect(hotSwapOutcomeExplanation(outcome).length).toBeGreaterThan(30);
    }
  });

  it('the standing notes state the invariants (lock 30, credentials, revocation)', () => {
    expect(NO_PRIVILEGED_PROVIDER_NOTE).toContain('never participates');
    expect(CREDENTIAL_NOTE).toContain('never the credential value');
    expect(REVOKE_NOTE).toContain('Revoking disables routing');
  });

  it('provider options are alphabetical — display order can never read as preference', () => {
    const options = providerOptions(LLM_PROVIDERS);
    const values = options.map((option) => option.value);
    expect(values).toEqual([...values].sort((left, right) => left.localeCompare(right)));
    expect(values[0]).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('formats integer minor units as USD', () => {
    expect(formatUsdMinor(0)).toBe('$0.00');
    expect(formatUsdMinor(1)).toBe('$0.01');
    expect(formatUsdMinor(1234)).toBe('$12.34');
    expect(formatUsdMinor(1_000_000)).toBe('$10,000.00');
    expect(formatUsdMinor(-5)).toBe('-$0.05');
  });

  it('formats per-million list prices, latency and token counts', () => {
    expect(formatPricePerMillion(250)).toBe('$2.50 / 1M tokens');
    expect(formatPricePerMillion(25)).toBe('$0.25 / 1M tokens');
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(812)).toBe('812 ms');
    expect(formatLatency(1_411)).toBe('1.4 s');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_100)).toBe('1.1k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });

  it('renders relative ages without locale data', () => {
    const now = '2026-10-10T12:00:00.000Z';
    expect(ageLabel('2026-10-10T11:59:45.000Z', now)).toBe('15s ago');
    expect(ageLabel('2026-10-10T11:30:00.000Z', now)).toBe('30m ago');
    expect(ageLabel('2026-10-09T12:00:00.000Z', now)).toBe('1d ago');
    expect(ageLabel('not-a-date', now)).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// Body parsing (the whole action vocabulary)
// ---------------------------------------------------------------------------

const VALID_REGISTER = {
  action: 'account.register',
  provider: 'openai',
  label: 'Primary workspace key',
  credentialRef: 'secret-store://byoa/openai/primary',
  scopes: ['conversation', 'analysis'],
  capabilities: ['text-generation'],
  maxDataClassification: 'internal',
  priority: 100,
};

describe('parseActionBody', () => {
  it('rejects non-object bodies and unknown actions', () => {
    expect(parseActionBody(null).ok).toBe(false);
    expect(parseActionBody('x').ok).toBe(false);
    expect(parseActionBody({ action: 'nope' }).ok).toBe(false);
    expect(parseActionBody({}).ok).toBe(false);
    const rejected = parseActionBody({ action: 'nope' });
    if (!rejected.ok) {
      expect(rejected.error).toContain(AI_ACTIONS.join(', '));
    }
    expect(isAiAction('account.test')).toBe(true);
    expect(isAiAction('account.delete')).toBe(false);
  });

  it('parses a complete account.register body', () => {
    const parsed = parseActionBody({ ...VALID_REGISTER, budgetMinor: 5_000 });
    expect(parsed).toEqual({
      ok: true,
      value: {
        action: 'account.register',
        provider: 'openai',
        label: 'Primary workspace key',
        credentialRef: 'secret-store://byoa/openai/primary',
        scopes: ['conversation', 'analysis'],
        capabilities: ['text-generation'],
        maxDataClassification: 'internal',
        priority: 100,
        budgetMinor: 5_000,
      },
    });
  });

  it('account.register rejects bad providers, empty vocabularies, bad priorities and budgets', () => {
    expect(parseActionBody({ ...VALID_REGISTER, provider: 'skynet' }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, scopes: [] }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, scopes: ['nope'] }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, capabilities: [] }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, capabilities: 'text-generation' }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, maxDataClassification: 'secret' }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, priority: -1 }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, priority: 1_001 }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, priority: 'low' }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, budgetMinor: 0 }).ok).toBe(false);
    expect(parseActionBody({ ...VALID_REGISTER, budgetMinor: 2_000_000_001 }).ok).toBe(false);
    // null budget is legal (no cap).
    expect(parseActionBody({ ...VALID_REGISTER, budgetMinor: null }).ok).toBe(true);
  });

  it('account.update parses partial fields and distinguishes a cleared budget', () => {
    const partial = parseActionBody({
      action: 'account.update',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      priority: 5,
    });
    expect(partial.ok).toBe(true);
    if (partial.ok && partial.value.action === 'account.update') {
      expect(partial.value.priority).toBe(5);
    }

    const cleared = parseActionBody({
      action: 'account.update',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      budgetMinor: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok && cleared.value.action === 'account.update') {
      expect(cleared.value.budgetProvided).toBe(true);
      expect(cleared.value.budgetMinor).toBeNull();
    }

    // Absent budget is "no change" (budgetProvided false).
    const untouched = parseActionBody({
      action: 'account.update',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      scopes: ['analysis'],
    });
    expect(untouched.ok).toBe(true);
    if (untouched.ok && untouched.value.action === 'account.update') {
      expect(untouched.value.budgetProvided).toBe(false);
    }

    // Nothing to change → 400.
    expect(
      parseActionBody({ action: 'account.update', accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff' }).ok,
    ).toBe(false);
  });

  it('account.setStatus parses both directions and rejects others', () => {
    const disable = parseActionBody({
      action: 'account.setStatus',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      status: 'disabled',
    });
    expect(disable.ok).toBe(true);
    if (disable.ok && disable.value.action === 'account.setStatus') {
      expect(disable.value.status).toBe('disabled');
    }
    expect(
      parseActionBody({
        action: 'account.setStatus',
        accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
        status: 'archived',
      }).ok,
    ).toBe(false);
  });

  it('account.test parses with optional model/capability/scope', () => {
    const minimal = parseActionBody({
      action: 'account.test',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    });
    expect(minimal.ok).toBe(true);
    if (minimal.ok && minimal.value.action === 'account.test') {
      expect(minimal.value.model).toBeNull();
    }
    const pinned = parseActionBody({
      action: 'account.test',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      model: 'gpt-4o-mini',
      capability: 'text-generation',
      scope: 'analysis',
    });
    expect(pinned.ok).toBe(true);
    if (pinned.ok && pinned.value.action === 'account.test') {
      expect(pinned.value.model).toBe('gpt-4o-mini');
    }
    expect(parseActionBody({ action: 'account.test' }).ok).toBe(false);
  });

  it('availability.set validates state, expiry semantics and ISO instants', () => {
    const hold = parseActionBody({
      action: 'availability.set',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      model: 'gpt-4o',
      state: 'unavailable',
      reason: 'rotation',
      expiresAt: '2026-10-11T00:00:00.000Z',
    });
    expect(hold.ok).toBe(true);
    expect(parseActionBody({
      action: 'availability.set',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      model: 'gpt-4o',
      state: 'paused',
    }).ok).toBe(false);
    // An expiry on an available release makes no sense → rejected.
    expect(parseActionBody({
      action: 'availability.set',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      model: 'gpt-4o',
      state: 'available',
      expiresAt: '2026-10-11T00:00:00.000Z',
    }).ok).toBe(false);
    expect(parseActionBody({
      action: 'availability.set',
      accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      model: 'gpt-4o',
      state: 'unavailable',
      expiresAt: 'tomorrow',
    }).ok).toBe(false);
  });

  it('hotswap.verify parses targets, vocabulary fields and the optional prompt', () => {
    const body = {
      action: 'hotswap.verify',
      targetA: { accountId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff', model: 'gpt-4o-mini' },
      targetB: { accountId: '0d5aa616-8b86-d011-b42d-00cf4fc964ff', model: 'claude-haiku-4-5' },
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'public',
    };
    const parsed = parseActionBody(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.action === 'hotswap.verify') {
      expect(parsed.value.prompt).toBeNull();
    }
    expect(parseActionBody({ ...body, prompt: '  ' }).ok).toBe(true);
    expect(parseActionBody({ ...body, prompt: 'x'.repeat(501) }).ok).toBe(false);
    expect(parseActionBody({ ...body, capability: 'vision' }).ok).toBe(false);
    expect(parseActionBody({ ...body, scope: 'everywhere' }).ok).toBe(false);
    expect(parseActionBody({ ...body, dataClassification: 'top-secret' }).ok).toBe(false);
    expect(parseActionBody({ ...body, targetA: 'openai' }).ok).toBe(false);
    expect(parseActionBody({ ...body, targetB: { accountId: 'x' } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test-target picking (pure halves of the connection test)
// ---------------------------------------------------------------------------

const ACCOUNT: AiProviderAccount = {
  id: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
  tenantId: 'tenant',
  provider: 'openai',
  label: 'Primary',
  credentialRef: 'secret-store://byoa/openai/primary',
  status: 'active',
  scopes: ['conversation', 'analysis'],
  capabilities: ['text-generation'],
  maxDataClassification: 'internal',
  priority: 10,
  budgetMinor: null,
  budgetCurrency: 'USD',
  createdBy: 'creator',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('pickTestCapability and pickTestScope', () => {
  it('defaults to the account’s first permitted, registry-served capability', () => {
    const picked = pickTestCapability(ACCOUNT, null);
    expect('capability' in picked && picked.capability).toBe('text-generation');
    const scoped = pickTestScope(ACCOUNT, null);
    expect(scoped.scope).toBe('conversation');
    expect(scoped.error).toBeNull();
  });

  it('rejects capabilities the account does not permit or the registry does not serve', () => {
    expect('error' in pickTestCapability(ACCOUNT, 'embedding')).toBe(true);
    expect('error' in pickTestCapability(ACCOUNT, 'telepathy')).toBe(true);
    const embeddingOnly: AiProviderAccount = {
      ...ACCOUNT,
      provider: 'anthropic',
      capabilities: ['embedding'],
    };
    // Anthropic's registry models carry no embedding capability.
    expect('error' in pickTestCapability(embeddingOnly, null)).toBe(true);
  });

  it('picks the requested scope when permitted, else errors; defaults to the first permitted', () => {
    expect(pickTestScope(ACCOUNT, 'analysis').scope).toBe('analysis');
    expect(pickTestScope(ACCOUNT, 'cognition').error).not.toBeNull();
    expect(pickTestScope(ACCOUNT, null).scope).toBe('conversation');
    const scopeless: AiProviderAccount = { ...ACCOUNT, scopes: [] };
    expect(pickTestScope(scopeless, null).error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deterministic keys + gate-id extraction (the approval replay path)
// ---------------------------------------------------------------------------

describe('idempotency keys and gate extraction', () => {
  it('derives deterministic, pattern-legal connection-test keys', () => {
    const key = accountTestIdempotencyKey(ACCOUNT.id, 'gpt-4o', 'text-generation');
    expect(key).toBe(`ai-test:${ACCOUNT.id}:gpt-4o:text-generation`);
    expect(accountTestIdempotencyKey(ACCOUNT.id, null, 'embedding')).toBe(
      `ai-test:${ACCOUNT.id}:auto:embedding`,
    );
    expect(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(key)).toBe(true);
  });

  it('derives deterministic hot-swap keys', () => {
    const key = hotSwapIdempotencyKey(
      { accountId: 'a', model: 'gpt-4o' },
      { accountId: 'b', model: 'claude-haiku-4-5' },
      'text-generation',
    );
    expect(key).toBe('ai-hotswap:a:gpt-4o:b:claude-haiku-4-5:text-generation');
  });

  it('extracts the gate action request id from the module’s own message', () => {
    const id = '3f2a8c41-9d7e-4b6a-a111-223344556677';
    expect(extractGateActionRequestId(`action request '${id}' (kind 'llm-invocation', level ANALYZE) awaits a human approval decision`)).toBe(id);
    expect(extractGateActionRequestId('some other failure')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The API layer’s pure halves
// ---------------------------------------------------------------------------

describe('aiApiError mapping', () => {
  it('maps authority, not-found, transport and input codes to honest statuses', () => {
    const forbidden = aiApiError({ code: 'forbidden', message: 'no claim' });
    expect(forbidden.status).toBe(403);
    const notFound = aiApiError({ code: 'account_not_found', message: 'missing' });
    expect(notFound.status).toBe(404);
    const transport = aiApiError({ code: 'provider_unavailable', message: 'no transport' });
    expect(transport.status).toBe(503);
    const gated = aiApiError({ code: 'invocation_approval_required', message: 'waiting' });
    expect(gated.status).toBe(409);
    const badInput = aiApiError({ code: 'invalid_llm_input', message: 'shape' });
    expect(badInput.status).toBe(400);
    const internal = aiApiError(new Error('boom'));
    expect(internal.status).toBe(500);
    expect(internal.body.error).toBe('internal');
  });
});

describe('verificationIdFromRequest', () => {
  it('accepts uuids, rejects garbage, returns null when absent', () => {
    const request = (query: string): Request =>
      new Request(`https://aurum.test/api/product/ai${query}`);
    expect(verificationIdFromRequest(request(''))).toBeNull();
    expect(
      verificationIdFromRequest(request('?verification=3f2a8c41-9d7e-4b6a-a111-223344556677')),
    ).toBe('3f2a8c41-9d7e-4b6a-a111-223344556677');
    expect(verificationIdFromRequest(request('?verification=not-a-uuid'))).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// View-shaping pure halves
// ---------------------------------------------------------------------------

describe('accountModelRows', () => {
  const models: LlmModelDescriptor[] = [
    {
      provider: 'openai',
      modelId: 'gpt-4o',
      capabilities: ['text-generation'],
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      priceInputMinorPerMillion: 250,
      priceOutputMinorPerMillion: 1_000,
      currency: 'USD',
    },
    {
      provider: 'openai',
      modelId: 'text-embedding-3-small',
      capabilities: ['embedding'],
      contextWindowTokens: 8_191,
      maxOutputTokens: 0,
      priceInputMinorPerMillion: 2,
      priceOutputMinorPerMillion: 0,
      currency: 'USD',
    },
  ];

  it('marks the (account, model) intersections and carries availability through', () => {
    const rows = accountModelRows(ACCOUNT, models, new Map());
    expect(rows).toHaveLength(2);
    expect(rows[0]!.modelId).toBe('gpt-4o');
    expect(rows[0]!.accountPermits).toBe(true);
    expect(rows[0]!.usableCapabilities).toEqual(['text-generation']);
    expect(rows[1]!.modelId).toBe('text-embedding-3-small');
    expect(rows[1]!.accountPermits).toBe(false);
    expect(rows[1]!.usableCapabilities).toEqual([]);
    expect(rows[0]!.availability).toBeNull();
  });

  it('mirrors the live registry for a real provider (self-consistency)', () => {
    const rows = accountModelRows(ACCOUNT, listLlmModels('openai'), new Map());
    expect(rows.map((row) => row.modelId)).toEqual(
      listLlmModels('openai').map((model) => model.modelId),
    );
  });
});

// ---------------------------------------------------------------------------
// Suggested hot-swap parameters
// ---------------------------------------------------------------------------

describe('suggestedHotSwapParameters', () => {
  it('picks a shared scope and the stricter ceiling', () => {
    const suggestion = suggestedHotSwapParameters(
      { scopes: ['conversation', 'analysis'], maxDataClassification: 'internal' },
      { scopes: ['analysis', 'background'], maxDataClassification: 'restricted' },
    );
    expect(suggestion).toEqual({ scope: 'analysis', dataClassification: 'internal' });
  });

  it('returns null when no scope is shared', () => {
    expect(
      suggestedHotSwapParameters(
        { scopes: ['conversation'], maxDataClassification: 'public' },
        { scopes: ['analysis'], maxDataClassification: 'public' },
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Command-search discoverability (the shell’s own registry)
// ---------------------------------------------------------------------------

describe('AI destination in the shell command registry', () => {
  it('the BYOA destination rides the shared registry exactly once (W091 added the preferences destinations)', () => {
    // W091 extended the AI area's keyboard destinations with the
    // outcome-oriented preferences surface and its authorized advanced
    // settings. The W066 lock keeps its intent: the BYOA destination
    // itself is registered EXACTLY ONCE — no duplicate registration.
    expect(AI_DESTINATIONS.filter((destination) => destination.href === '/ai')).toHaveLength(1);
    expect(AI_DESTINATIONS.map((destination) => destination.href)).toEqual([
      '/ai/preferences',
      '/ai/preferences/advanced',
      '/ai',
    ]);
    const commands = buildShellCommands();
    const aiCommands = commands.filter((command) => command.id.startsWith('ai:'));
    expect(aiCommands).toHaveLength(3);
    expect(aiCommands.map((command) => (command.target as { href: string }).href)).toEqual([
      '/ai/preferences',
      '/ai/preferences/advanced',
      '/ai',
    ]);
    // Keyboard-reachable by the names a manager would actually type.
    for (const query of ['byoa', 'provider', 'hot-swap', 'routing', 'ai']) {
      const matches = commands.filter(
        (command) =>
          command.title.toLowerCase().includes(query) ||
          command.keywords.some((keyword) => keyword.includes(query)),
      );
      expect(matches.map((command) => command.id)).toContain('ai:byoa');
    }
    // The registry keeps its unique-id invariant with the new commands.
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });

  it('the canonical test prompts are fixed public payloads', () => {
    expect(ACCOUNT_TEST_PROMPT).toContain('ready');
    expect(HOT_SWAP_PROMPT).toContain('provider swap verified');
    expect(EMBEDDING_TEST_INPUT).toBe('aurum provider connection test');
  });
});
