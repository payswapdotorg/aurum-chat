// Integration tests for the llm module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W034 acceptance:
// "Provider/model registry, tenant-owned AI provider accounts, routing,
// availability, performance, cost, policy and hot-swap verification."
//
//  * accounts (BYOA) — claim-gated registration (idempotent), tenant-scoped
//    reads with the uniform cross-tenant not-found discipline (ADR-0001),
//    filtered listing and management-control updates (including budget
//    clearing and enable/disable);
//  * policy — every invocation passes the W009 authority gate (kind
//    'llm-invocation', level ANALYZE): the built-in default allows, a
//    tenant policy can forbid (invocation_forbidden) or gate behind human
//    approval (invocation_approval_required → decideApproval → retry with
//    the same idempotency key replays the SAME request and proceeds);
//  * routing — scope / capability / data-policy / budget / model-output
//    eligibility checks against real tenant state, deterministic priority
//    ordering, pinned targets and the registry-verified model set;
//  * invocation — the canonical path through a recording transport:
//    provider/model metadata, canonical results, deterministic
//    integer-minor-unit cost, measured latency, the frozen routing
//    snapshot and the recorded action request;
//  * availability — automatic failure cooldowns (append-only events),
//    failover to the next ordered candidate, manual overrides, effective
//    expiry and success-triggered recovery;
//  * hot-swap verification — the SAME canonical request through two
//    different (provider, model) targets with a deterministic structural
//    comparison (equivalent / completed-divergent / failed), including an
//    embedding-capability swap;
//  * storage discipline — llm_executions, llm_availability_events and
//    llm_hot_swap_verifications are append-only (PostgreSQL triggers
//    reject UPDATE/DELETE); accounts are mutable configuration only.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as llmContract from '../contract';
import {
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { LlmError } from '../errors';
import { setLlmTransport } from '../service';
import type { InvokeLlmInput, LlmTransport, LlmTransportReceipt, LlmTransportRequest } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getAiAvailability,
  getAiProviderAccount,
  getAiProviderAccountSpend,
  getHotSwapVerification,
  getLlmExecution,
  getLlmTransport,
  getLlmUsageSummary,
  invokeLlm,
  listAiProviderAccounts,
  listLlmExecutions,
  registerAiProviderAccount,
  setAiAvailability,
  updateAiProviderAccount,
  verifyProviderHotSwap,
} = llmContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantAccounts = newId();
const tenantPolicy = newId();
const tenantForbid = newId();
const tenantGate = newId();
const tenantInvoke = newId();
const tenantEligibility = newId();
const tenantBudget = newId();
const tenantFailover = newId();
const tenantPinRecovery = newId();
const tenantHotSwap = newId();
const tenantImmutable = newId();
const tenantIsolation = newId();
const tenantOther = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function llmAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['llm:administer'] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer', 'llm:administer'] };
}

function approver(tenantId: string): TenantContext {
  // A DIFFERENT principal with the actions approval claim (separation of duties).
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectCode(
  code: LlmError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected LlmError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// A recording fake transport that speaks every provider dialect
// ---------------------------------------------------------------------------

interface FakeResponse {
  text?: string;
  vector?: number[];
  inputTokens?: number;
  outputTokens?: number;
}

class FakeLlmTransport implements LlmTransport {
  readonly requests: LlmTransportRequest[] = [];
  private readonly responses = new Map<string, FakeResponse>();
  private readonly failures: Array<{
    match: (request: LlmTransportRequest) => boolean;
    status: 'rejected' | 'failed';
    detail: string;
  }> = [];
  private static counter = 0;

  configure(provider: string, response: FakeResponse): void {
    this.responses.set(provider, response);
  }

  configureGlobal(response: FakeResponse): void {
    this.responses.set('*', response);
  }

  failWhere(
    match: (request: LlmTransportRequest) => boolean,
    status: 'rejected' | 'failed' = 'failed',
    detail = 'simulated provider failure',
  ): void {
    this.failures.push({ match, status, detail });
  }

  clearFailures(): void {
    this.failures.length = 0;
  }

  async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
    this.requests.push(request);
    for (const rule of this.failures) {
      if (rule.match(request)) {
        return { status: rule.status, payload: null, providerExecutionId: null, detail: rule.detail };
      }
    }
    const response = this.responses.get(request.provider) ?? this.responses.get('*') ?? {};
    FakeLlmTransport.counter += 1;
    const executionId = `fake-${String(FakeLlmTransport.counter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: this.payloadFor(request.provider, request.kind, response, executionId),
      providerExecutionId: executionId,
      detail: null,
    };
  }

  /** Builds a provider-NATIVE payload for the adapter to parse (dialect realism). */
  private payloadFor(
    provider: string,
    kind: 'completion' | 'embedding',
    response: FakeResponse,
    executionId: string,
  ): unknown {
    const text = response.text ?? 'The canonical answer.';
    const vector = response.vector ?? [0.25, 0.5, 0.75];
    const inputTokens = response.inputTokens ?? 10;
    const outputTokens = response.outputTokens ?? 5;
    switch (provider) {
      case 'anthropic':
        return {
          id: `msg_${executionId}`,
          content: [{ type: 'text', text }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };
      case 'google':
        return kind === 'completion'
          ? {
              responseId: `resp_${executionId}`,
              candidates: [{ content: { parts: [{ text }] } }],
              usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: outputTokens },
            }
          : {
              responseId: `resp_${executionId}`,
              embedding: { values: vector },
              usageMetadata: { tokenCount: inputTokens },
            };
      case 'cohere':
        return kind === 'completion'
          ? { id: `coh_${executionId}`, text, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
          : {
              id: `coh_${executionId}`,
              embeddings: { float: [vector] },
              meta: { billed_units: { input_tokens: inputTokens } },
            };
      case 'mistral':
        return kind === 'completion'
          ? {
              id: `mist_${executionId}`,
              choices: [{ message: { content: text } }],
              usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
            }
          : { id: `mist_${executionId}`, data: [{ embedding: vector }], usage: { prompt_tokens: inputTokens } };
      default:
        // openai + the OpenAI-compatible providers (deepseek, groq)
        return kind === 'completion'
          ? {
              id: `chat_${executionId}`,
              choices: [{ message: { content: text } }],
              usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
            }
          : { id: `emb_${executionId}`, data: [{ embedding: vector }], usage: { prompt_tokens: inputTokens } };
    }
  }
}

let transport: FakeLlmTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setLlmTransport(null);
  await closeDb();
});

beforeEach(() => {
  transport = new FakeLlmTransport();
  setLlmTransport(transport);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface AccountSpec {
  provider: 'openai' | 'anthropic' | 'google' | 'mistral' | 'cohere' | 'deepseek' | 'groq';
  label: string;
  scopes?: string[];
  capabilities?: string[];
  maxDataClassification?: 'public' | 'internal' | 'restricted';
  priority?: number;
  budgetMinor?: number | null;
}

async function registerAccount(ctx: TenantContext, spec: AccountSpec) {
  const result = await registerAiProviderAccount(ctx, {
    provider: spec.provider,
    label: spec.label,
    credentialRef: `secret-store://${spec.provider}/${spec.label}`,
    scopes: (spec.scopes ?? ['cognition', 'conversation', 'analysis', 'background']) as never,
    capabilities: (spec.capabilities ?? ['text-generation', 'embedding']) as never,
    maxDataClassification: spec.maxDataClassification ?? 'restricted',
    priority: spec.priority ?? 100,
    budgetMinor: spec.budgetMinor ?? null,
  });
  return result.account;
}

const CHAT_REQUEST: InvokeLlmInput = {
  capability: 'text-generation',
  scope: 'cognition',
  dataClassification: 'internal',
  messages: [
    { role: 'system', content: 'Answer in one word.' },
    { role: 'user', content: 'Is the gateway provider-neutral?' },
  ],
};

// ---------------------------------------------------------------------------
// Accounts (BYOA)
// ---------------------------------------------------------------------------

describe('llm service — tenant-owned AI provider accounts', () => {
  it('registers accounts idempotently and claim-gates the writes', async () => {
    const admin = llmAdmin(tenantAccounts);
    const first = await registerAccount(admin, { provider: 'openai', label: 'ops', priority: 0 });
    expect(first.status).toBe('active');
    expect(first.scopes).toEqual(['cognition', 'conversation', 'analysis', 'background']);
    expect(first.budgetMinor).toBeNull();

    const again = await registerAiProviderAccount(admin, {
      provider: 'openai',
      label: 'ops',
      credentialRef: 'secret-store://openai/ops-v2',
      scopes: ['cognition'],
      capabilities: ['text-generation'],
      maxDataClassification: 'public',
      priority: 999,
      budgetMinor: 42,
    });
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(first.id);
    // First registration wins.
    expect(again.account.credentialRef).toBe('secret-store://openai/ops');
    expect(again.account.priority).toBe(0);

    await expectCode('forbidden', () =>
      registerAiProviderAccount(member(tenantAccounts), {
        provider: 'openai',
        label: 'rogue',
        credentialRef: 'secret-store://openai/rogue',
        scopes: ['cognition'],
        capabilities: ['text-generation'],
        maxDataClassification: 'public',
        priority: 0,
      }),
    );
  });

  it('reads are tenant-scoped with the uniform not-found discipline', async () => {
    const admin = llmAdmin(tenantAccounts);
    const account = await registerAccount(admin, { provider: 'anthropic', label: 'research' });

    const found = await getAiProviderAccount(member(tenantAccounts), { accountId: account.id });
    expect(found.id).toBe(account.id);

    await expectCode('account_not_found', () =>
      getAiProviderAccount(member(tenantOther), { accountId: account.id }),
    );
    await expectCode('account_not_found', () =>
      getAiProviderAccount(member(tenantAccounts), { accountId: newId() }),
    );
    await expectCode('account_not_found', () =>
      getAiProviderAccount(member(tenantAccounts), { accountId: 'not-a-uuid' }),
    );

    const otherList = await listAiProviderAccounts(member(tenantOther), {});
    expect(otherList).toEqual([]);
  });

  it('lists with filters and orders by routing priority', async () => {
    const admin = llmAdmin(tenantAccounts);
    await registerAccount(admin, { provider: 'google', label: 'g1', priority: 5 });
    await registerAccount(admin, { provider: 'mistral', label: 'm1', priority: 1 });
    const listed = await listAiProviderAccounts(member(tenantAccounts), {});
    const labels = listed.map((account) => account.label);
    expect(labels.indexOf('m1')).toBeLessThan(labels.indexOf('g1')); // priority 1 before 5

    const onlyGoogle = await listAiProviderAccounts(member(tenantAccounts), { provider: 'google' });
    expect(onlyGoogle.map((account) => account.label)).toEqual(['g1']);
  });

  it('updates the mutable management controls (including clearing a budget and disabling)', async () => {
    const admin = llmAdmin(tenantAccounts);
    const account = await registerAccount(admin, {
      provider: 'groq',
      label: 'fast',
      budgetMinor: 1_000,
      maxDataClassification: 'internal',
    });

    const updated = await updateAiProviderAccount(admin, {
      accountId: account.id,
      budgetMinor: null,
      maxDataClassification: 'restricted',
      priority: 7,
    });
    expect(updated.budgetMinor).toBeNull();
    expect(updated.maxDataClassification).toBe('restricted');
    expect(updated.priority).toBe(7);
    expect(updated.updatedAt >= account.updatedAt).toBe(true);

    const disabled = await updateAiProviderAccount(admin, { accountId: account.id, status: 'disabled' });
    expect(disabled.status).toBe('disabled');

    await expectCode('forbidden', () =>
      updateAiProviderAccount(member(tenantAccounts), { accountId: account.id, priority: 1 }),
    );
    await expectCode('account_not_found', () =>
      updateAiProviderAccount(llmAdmin(tenantOther), { accountId: account.id, priority: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// The W009 authority gate
// ---------------------------------------------------------------------------

describe('llm service — the authority gate (W009 integration)', () => {
  it('records an approved action request for every invocation and links it on the execution', async () => {
    const admin = llmAdmin(tenantPolicy);
    const account = await registerAccount(admin, { provider: 'openai', label: 'ops', priority: 0 });

    const execution = await invokeLlm(member(tenantPolicy), { ...CHAT_REQUEST });
    expect(execution.status).toBe('completed');
    expect(execution.policy).not.toBeNull();

    const requests = await listActionRequests(member(tenantPolicy), { actionKind: 'llm-invocation' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('approved');
    expect(requests[0]!.authorityLevel).toBe('ANALYZE');
    expect(requests[0]!.evaluation.outcome).toBe('allowed');
    expect(requests[0]!.requestedBy).not.toBe('');
    expect(execution.policy!.actionRequestId).toBe(requests[0]!.id);
    expect(account.id).toBe(execution.accountId);
  });

  it('a tenant policy can forbid llm invocation outright', async () => {
    const admin = actionsAdmin(tenantForbid);
    await registerAccount(admin, { provider: 'openai', label: 'ops2', priority: 0 });
    await setAuthorityPolicy(admin, {
      actionKind: 'llm-invocation',
      forbiddenLevels: ['ANALYZE'],
    });

    await expectCode('invocation_forbidden', () =>
      invokeLlm(member(tenantForbid), { ...CHAT_REQUEST }),
    );
    // No execution was admitted.
    expect(await listLlmExecutions(member(tenantForbid), {})).toEqual([]);
  });

  it('a gated invocation waits for a human approval, then replays the same request', async () => {
    const admin = actionsAdmin(tenantGate);
    await registerAccount(admin, { provider: 'openai', label: 'gated-ops', priority: 0 });
    await setAuthorityPolicy(admin, {
      actionKind: 'llm-invocation',
      forbiddenLevels: [],
      approvalLevels: ['ANALYZE'],
    });

    const invoking = member(tenantGate);
    await expectCode('invocation_approval_required', () =>
      invokeLlm(invoking, { ...CHAT_REQUEST, idempotencyKey: 'llm:approval-flow-1' }),
    );

    const pending = await listActionRequests(invoking, { actionKind: 'llm-invocation', status: 'pending' });
    expect(pending).toHaveLength(1);
    const request = pending[0]!;

    // The invoking principal may never decide its own request.
    await expect(decideApproval(invoking, { requestId: request.id, decision: 'approve' })).rejects.toThrow();

    await decideApproval(approver(tenantGate), { requestId: request.id, decision: 'approve' });

    // Retry with the SAME idempotency key: the gate replays the approved
    // request (no second one) and the invocation proceeds.
    const execution = await invokeLlm(invoking, {
      ...CHAT_REQUEST,
      idempotencyKey: 'llm:approval-flow-1',
    });
    expect(execution.status).toBe('completed');
    expect(execution.policy!.outcome).toBe('approval_required'); // frozen matrix snapshot
    expect(execution.policy!.actionRequestId).toBe(request.id);

    // The retry REPLAYED the approved request: no new one was created.
    const all = await listActionRequests(invoking, { actionKind: 'llm-invocation' });
    expect(all.every((entry) => entry.id === request.id || entry.status !== 'pending')).toBe(true);
    expect(all.filter((entry) => entry.id === request.id)).toHaveLength(1);

    // Restore the default for later groups.
    await setAuthorityPolicy(admin, {
      actionKind: 'llm-invocation',
      forbiddenLevels: [],
      approvalLevels: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Invocation (the canonical gateway path)
// ---------------------------------------------------------------------------

describe('llm service — invocation, cost and evidence', () => {
  it('fails explicitly with no transport wired and with no accounts', async () => {
    setLlmTransport(null);
    const admin = llmAdmin(tenantInvoke);
    await registerAccount(admin, { provider: 'openai', label: 'ops', priority: 0 });
    await expectCode('provider_unavailable', () => invokeLlm(member(tenantInvoke), { ...CHAT_REQUEST }));
    expect(getLlmTransport()).toBeNull();

    // Restore the fake; with no accounts the failure is eligibility, not wiring.
    setLlmTransport(transport);
    await expectCode('no_eligible_account', () =>
      invokeLlm(member(tenantOther), { ...CHAT_REQUEST }),
    );
  });

  it('executes through the routed account with canonical evidence', async () => {
    const admin = llmAdmin(tenantInvoke);
    const account = await registerAccount(admin, { provider: 'openai', label: 'ops', priority: 0 });
    transport.configureGlobal({
      text: '  Yes.  ',
      inputTokens: 100_000,
      outputTokens: 50_000,
    });

    const execution = await invokeLlm(member(tenantInvoke), {
      ...CHAT_REQUEST,
      temperature: 0.1,
      maxOutputTokens: 1_000,
    });
    expect(execution.provider).toBe('openai');
    expect(execution.model).toBe('gpt-4o');
    expect(execution.accountId).toBe(account.id);
    expect(execution.status).toBe('completed');
    expect(execution.result).toEqual({ kind: 'text-generation', text: '  Yes.  ' });
    expect(execution.inputTokens).toBe(100_000);
    expect(execution.outputTokens).toBe(50_000);
    // Deterministic cost from the registry list price (250 in / 1000 out per M).
    expect(execution.costMinor).toBe(25 + 50);
    expect(execution.costCurrency).toBe('USD');
    expect(execution.latencyMs).toBeGreaterThanOrEqual(0);
    expect(execution.providerExecutionId).toMatch(/^(chat|msg|resp|coh|mist|emb)_fake-\d{6}$/);
    expect(execution.routing.pinned).toBe(false);
    expect(execution.routing.chosen).toEqual({ accountId: account.id, provider: 'openai', model: 'gpt-4o' });
    // Every registry model of the account's provider was considered.
    expect(execution.routing.candidates.map((c) => c.model)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'text-embedding-3-small',
    ]);
    expect(execution.purpose).toBe('invocation');
    expect(execution.errorCode).toBeNull();

    // The transport saw a provider-native openai body (dialect realism).
    const sent = transport.requests.at(-1)!;
    expect(sent.kind).toBe('completion');
    const body = sent.body as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o');
    expect(body.max_tokens).toBe(1_000);
    expect(body.temperature).toBe(0.1);

    // The execution is retrievable evidence.
    const fetched = await getLlmExecution(member(tenantInvoke), { executionId: execution.id });
    expect(fetched.id).toBe(execution.id);
    await expectCode('execution_not_found', () =>
      getLlmExecution(member(tenantOther), { executionId: execution.id }),
    );

    // A second identical invocation produces a second evidence row.
    const second = await invokeLlm(member(tenantInvoke), { ...CHAT_REQUEST, temperature: 0.1, maxOutputTokens: 1_000 });
    expect(second.id).not.toBe(execution.id);
    expect(second.model).toBe('gpt-4o');
  });

  it('routes embeddings through embedding-capable models only', async () => {
    const admin = llmAdmin(tenantInvoke);
    const account = await registerAccount(admin, { provider: 'openai', label: 'embed', priority: 0 });
    transport.configure('openai', { vector: [1, 2, 3], inputTokens: 6 });

    const execution = await invokeLlm(member(tenantInvoke), {
      capability: 'embedding',
      scope: 'background',
      dataClassification: 'public',
      embeddingInput: 'hello world',
    });
    expect(execution.model).toBe('text-embedding-3-small');
    expect(execution.result).toEqual({ kind: 'embedding', vector: [1, 2, 3] });
    expect(execution.outputTokens).toBe(0);
    // text-embedding-3-small lists 2 minor per million input tokens → ceil(6*2/1e6)=1.
    expect(execution.costMinor).toBe(1);
    expect(account.provider).toBe('openai');

    // A chat request cannot route to an account that permits only
    // embedding — even pinned explicitly.
    const embedOnlyAccount = await registerAccount(admin, {
      provider: 'openai',
      label: 'embed-only',
      priority: 0,
      capabilities: ['embedding'],
    });
    await expectCode('no_eligible_account', () =>
      invokeLlm(member(tenantInvoke), {
        ...CHAT_REQUEST,
        pinnedAccountId: embedOnlyAccount.id,
      }),
    );
  });

  it('pinning selects an explicit account and model', async () => {
    const admin = llmAdmin(tenantInvoke);
    const account = await registerAccount(admin, { provider: 'openai', label: 'pin-me', priority: 50 });
    await registerAccount(admin, { provider: 'openai', label: 'preferred', priority: 0 });

    const execution = await invokeLlm(member(tenantInvoke), {
      ...CHAT_REQUEST,
      pinnedAccountId: account.id,
      pinnedModel: 'gpt-4o-mini',
    });
    expect(execution.accountId).toBe(account.id);
    expect(execution.model).toBe('gpt-4o-mini');
    expect(execution.routing.pinned).toBe(true);

    // Pinning an unknown account or model fails precisely.
    await expectCode('account_not_found', () =>
      invokeLlm(member(tenantInvoke), { ...CHAT_REQUEST, pinnedAccountId: newId() }),
    );
    await expectCode('unsupported_model', () =>
      invokeLlm(member(tenantInvoke), {
        ...CHAT_REQUEST,
        pinnedAccountId: account.id,
        pinnedModel: 'gpt-5-turbo',
      }),
    );
    await expectCode('account_disabled', async () => {
      await updateAiProviderAccount(admin, { accountId: account.id, status: 'disabled' });
      return invokeLlm(member(tenantInvoke), {
        ...CHAT_REQUEST,
        pinnedAccountId: account.id,
        pinnedModel: 'gpt-4o',
      });
    });
    await updateAiProviderAccount(admin, { accountId: account.id, status: 'active' });
  });

  it('eligibility is enforced per concern against real tenant state', async () => {
    const admin = llmAdmin(tenantEligibility);

    const scoped = await registerAccount(admin, {
      provider: 'openai',
      label: 'cognition-only',
      scopes: ['cognition'],
    });
    const execution = await invokeLlm(member(tenantEligibility), { ...CHAT_REQUEST, pinnedAccountId: scoped.id, pinnedModel: 'gpt-4o' });
    expect(execution.status).toBe('completed');

    await expectCode('no_eligible_account', () =>
      invokeLlm(member(tenantEligibility), {
        ...CHAT_REQUEST,
        scope: 'conversation',
        pinnedAccountId: scoped.id,
      }),
    );

    const restrictedPolicy = await registerAccount(admin, {
      provider: 'anthropic',
      label: 'internal-only',
      maxDataClassification: 'internal',
    });
    await expectCode('no_eligible_account', () =>
      invokeLlm(member(tenantEligibility), {
        ...CHAT_REQUEST,
        dataClassification: 'restricted',
        pinnedAccountId: restrictedPolicy.id,
        pinnedModel: 'claude-sonnet-4-5',
      }),
    );

    // Model output limits are eligibility too: claude-haiku-4-5 caps at 8_192.
    await expectCode('no_eligible_account', () =>
      invokeLlm(member(tenantEligibility), {
        ...CHAT_REQUEST,
        maxOutputTokens: 32_768,
        pinnedAccountId: restrictedPolicy.id,
        pinnedModel: 'claude-haiku-4-5',
      }),
    );

    let caught: unknown;
    try {
      await invokeLlm(member(tenantEligibility), {
        ...CHAT_REQUEST,
        dataClassification: 'restricted',
        maxOutputTokens: 32_768,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).message).toContain('data_classification_exceeds_account_policy');
  });

  it('budgets gate routing once recorded spend reaches the cap', async () => {
    const admin = llmAdmin(tenantBudget);
    // gpt-4o lists 250 minor per million input tokens: 400_000 input tokens cost exactly 100.
    const account = await registerAccount(admin, {
      provider: 'openai',
      label: 'capped',
      budgetMinor: 100,
    });
    transport.configure('openai', { text: 'ok', inputTokens: 400_000, outputTokens: 0 });

    const first = await invokeLlm(member(tenantBudget), { ...CHAT_REQUEST, pinnedAccountId: account.id, pinnedModel: 'gpt-4o' });
    expect(first.costMinor).toBe(100);

    const spend = await getAiProviderAccountSpend(member(tenantBudget), { accountId: account.id });
    expect(spend.budgetMinor).toBe(100);
    expect(spend.spendMinor).toBe(100);
    expect(spend.executions).toBe(1);
    expect(Date.parse(spend.periodStart)).toBeLessThanOrEqual(Date.parse(first.invokedAt));

    await expectCode('no_eligible_account', () =>
      invokeLlm(member(tenantBudget), { ...CHAT_REQUEST, pinnedAccountId: account.id, pinnedModel: 'gpt-4o' }),
    );
    await expectCode('account_not_found', () =>
      getAiProviderAccountSpend(member(tenantOther), { accountId: account.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Availability + failover
// ---------------------------------------------------------------------------

describe('llm service — availability, failover and recovery', () => {
  it('fails over to the next ordered candidate and records the outage', async () => {
    const admin = llmAdmin(tenantFailover);
    const primary = await registerAccount(admin, { provider: 'openai', label: 'primary', priority: 0 });
    const secondary = await registerAccount(admin, {
      provider: 'anthropic',
      label: 'secondary',
      priority: 1,
    });
    transport.failWhere((request) => request.accountId === primary.id);

    const execution = await invokeLlm(member(tenantFailover), { ...CHAT_REQUEST });
    expect(execution.accountId).toBe(secondary.id);
    expect(execution.provider).toBe('anthropic');
    expect(execution.model).toBe('claude-sonnet-4-5');
    expect(execution.status).toBe('completed');

    // Both attempts on the primary (its two chat models) failed before the
    // failover completed — three evidence rows, newest first.
    const executions = await listLlmExecutions(member(tenantFailover), {});
    expect(executions).toHaveLength(3);
    expect(executions[0]!.status).toBe('completed');
    expect(executions[0]!.accountId).toBe(secondary.id);
    expect(executions[1]!.status).toBe('failed');
    expect(executions[1]!.accountId).toBe(primary.id);
    expect(executions[1]!.model).toBe('gpt-4o-mini');
    expect(executions[1]!.errorCode).toBe('invocation_failed');
    expect(executions[1]!.costMinor).toBe(0);
    expect(executions[1]!.result).toBeNull();
    expect(executions[2]!.model).toBe('gpt-4o');

    // The outage was observed: BOTH primary chat pairs are cooling down.
    const availability = await getAiAvailability(member(tenantFailover), { accountId: primary.id });
    for (const model of ['gpt-4o', 'gpt-4o-mini']) {
      const cooled = availability.find((entry) => entry.model === model)!;
      expect(cooled.state).toBe('unavailable');
      expect(cooled.source).toBe('execution');
      expect(cooled.expiresAt).not.toBeNull();
      expect(Date.parse(cooled.expiresAt!)).toBeGreaterThan(Date.now());
    }

    // Automatic routing skips the cooling pair.
    const next = await invokeLlm(member(tenantFailover), { ...CHAT_REQUEST });
    expect(next.accountId).toBe(secondary.id);

    // A manual override restores the primary (and the outage is over)…
    const adminCtx = admin;
    await setAiAvailability(adminCtx, {
      accountId: primary.id,
      model: 'gpt-4o',
      state: 'available',
      reason: 'false alarm',
    });
    transport.clearFailures();
    const restored = await invokeLlm(member(tenantFailover), { ...CHAT_REQUEST });
    expect(restored.accountId).toBe(primary.id);
    expect(restored.status).toBe('completed');

    // …and the effective state reflects it.
    const after = await getAiAvailability(member(tenantFailover), { accountId: primary.id });
    expect(after.find((entry) => entry.model === 'gpt-4o')!.state).toBe('available');

    // Claim gate + uniform not-found on the manual override.
    await expectCode('forbidden', () =>
      setAiAvailability(member(tenantFailover), {
        accountId: primary.id,
        model: 'gpt-4o',
        state: 'unavailable',
      }),
    );
    await expectCode('account_not_found', () =>
      setAiAvailability(llmAdmin(tenantOther), {
        accountId: primary.id,
        model: 'gpt-4o',
        state: 'unavailable',
      }),
    );
    await expectCode('unsupported_model', () =>
      setAiAvailability(adminCtx, {
        accountId: primary.id,
        model: 'nonexistent-model',
        state: 'unavailable',
      }),
    );
    await expectCode('account_not_found', () =>
      getAiAvailability(member(tenantOther), { accountId: primary.id }),
    );
  });

  it('a pinned invocation on a cooling target succeeds and records the recovery', async () => {
    const admin = llmAdmin(tenantPinRecovery);
    const account = await registerAccount(admin, {
      provider: 'google',
      label: 'pinned-recovery',
      priority: 0,
    });
    // Manual indefinite outage on the (account, gemini-2.5-pro) pair.
    await setAiAvailability(admin, {
      accountId: account.id,
      model: 'gemini-2.5-pro',
      state: 'unavailable',
      reason: 'planned maintenance',
    });
    transport.configure('google', { text: 'back online', inputTokens: 3, outputTokens: 2 });

    // Automatic routing skips it entirely (the account's other model serves).
    const auto = await invokeLlm(member(tenantPinRecovery), { ...CHAT_REQUEST });
    expect(auto.model).toBe('gemini-2.5-flash');

    // An explicit pin overrides the availability heuristic and its success
    // records the recovery transition.
    const pinned = await invokeLlm(member(tenantPinRecovery), {
      ...CHAT_REQUEST,
      pinnedAccountId: account.id,
      pinnedModel: 'gemini-2.5-pro',
    });
    expect(pinned.model).toBe('gemini-2.5-pro');
    expect(pinned.status).toBe('completed');

    const availability = await getAiAvailability(member(tenantPinRecovery), { accountId: account.id });
    const pro = availability.find((entry) => entry.model === 'gemini-2.5-pro')!;
    expect(pro.state).toBe('available');
    expect(pro.source).toBe('execution');
    expect(pro.reason).toContain('recovered');
  });

  it('an exhausted candidate list reports the last failure categorically', async () => {
    const admin = llmAdmin(tenantFailover);
    const account = await registerAccount(admin, { provider: 'mistral', label: 'rejecting', priority: 0 });
    transport.failWhere(
      (request) => request.accountId === account.id,
      'rejected',
      'content policy violation',
    );
    await expectCode('invocation_rejected', () =>
      invokeLlm(member(tenantFailover), { ...CHAT_REQUEST, pinnedAccountId: account.id, pinnedModel: 'mistral-large-latest' }),
    );
    const executions = await listLlmExecutions(member(tenantFailover), { accountId: account.id });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe('failed');
    expect(executions[0]!.errorCode).toBe('invocation_rejected');
    expect(executions[0]!.errorDetail).toContain('content policy violation');
  });
});

// ---------------------------------------------------------------------------
// Hot-swap verification
// ---------------------------------------------------------------------------

describe('llm service — provider hot-swap verification', () => {
  it('runs the same canonical request through two providers and compares structurally', async () => {
    const ctx = member(tenantHotSwap);
    const admin = llmAdmin(tenantHotSwap);
    const openaiAccount = await registerAccount(admin, { provider: 'openai', label: 'a', priority: 0 });
    const anthropicAccount = await registerAccount(admin, { provider: 'anthropic', label: 'b', priority: 1 });
    transport.configure('openai', { text: '  Same\n canonical  answer. ', inputTokens: 10, outputTokens: 4 });
    transport.configure('anthropic', { text: 'Same canonical answer.', inputTokens: 12, outputTokens: 3 });

    const result = await verifyProviderHotSwap(ctx, {
      ...CHAT_REQUEST,
      targetA: { accountId: openaiAccount.id, model: 'gpt-4o' },
      targetB: { accountId: anthropicAccount.id, model: 'claude-sonnet-4-5' },
    });
    expect(result.verification.outcome).toBe('equivalent');
    expect(result.verification.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verification.targetA.provider).toBe('openai');
    expect(result.verification.targetB.provider).toBe('anthropic');
    expect(result.executionA.provider).toBe('openai');
    expect(result.executionA.model).toBe('gpt-4o');
    expect(result.executionB.provider).toBe('anthropic');
    expect(result.executionB.model).toBe('claude-sonnet-4-5');
    expect(result.executionA.purpose).toBe('hot-swap-verification');
    expect(result.executionB.purpose).toBe('hot-swap-verification');
    // One action request gated BOTH executions.
    expect(result.executionA.policy!.actionRequestId).toBe(result.executionB.policy!.actionRequestId);

    const fetched = await getHotSwapVerification(ctx, { verificationId: result.verification.id });
    expect(fetched.id).toBe(result.verification.id);
    await expectCode('verification_not_found', () =>
      getHotSwapVerification(member(tenantOther), { verificationId: result.verification.id }),
    );
  });

  it('reports divergent completions without failing the swap', async () => {
    const admin = llmAdmin(tenantHotSwap);
    const openaiAccount = await registerAccount(admin, { provider: 'openai', label: 'a2', priority: 0 });
    const googleAccount = await registerAccount(admin, { provider: 'google', label: 'b2', priority: 1 });
    transport.configure('openai', { text: 'first answer', inputTokens: 5, outputTokens: 2 });
    transport.configure('google', { text: 'a different answer', inputTokens: 5, outputTokens: 2 });

    const result = await verifyProviderHotSwap(member(tenantHotSwap), {
      ...CHAT_REQUEST,
      targetA: { accountId: openaiAccount.id, model: 'gpt-4o' },
      targetB: { accountId: googleAccount.id, model: 'gemini-2.5-pro' },
    });
    expect(result.verification.outcome).toBe('completed-divergent');
    expect(result.executionA.status).toBe('completed');
    expect(result.executionB.status).toBe('completed');
  });

  it('records a failed outcome when one target fails (both attempts stay evidence)', async () => {
    const admin = llmAdmin(tenantHotSwap);
    const cohereAccount = await registerAccount(admin, { provider: 'cohere', label: 'a3', priority: 0 });
    const groqAccount = await registerAccount(admin, { provider: 'groq', label: 'b3', priority: 1 });
    transport.configure('cohere', { text: 'fine', inputTokens: 5, outputTokens: 2 });
    transport.failWhere((request) => request.accountId === groqAccount.id);

    const result = await verifyProviderHotSwap(member(tenantHotSwap), {
      ...CHAT_REQUEST,
      targetA: { accountId: cohereAccount.id, model: 'command-r-plus' },
      targetB: { accountId: groqAccount.id, model: 'llama-3.3-70b-versatile' },
    });
    expect(result.verification.outcome).toBe('failed');
    expect(result.executionA.status).toBe('completed');
    expect(result.executionB.status).toBe('failed');
    expect(result.executionB.errorCode).toBe('invocation_failed');
  });

  it('verifies the embedding capability across providers too', async () => {
    const admin = llmAdmin(tenantHotSwap);
    const openaiAccount = await registerAccount(admin, { provider: 'openai', label: 'e1', priority: 0 });
    const googleAccount = await registerAccount(admin, { provider: 'google', label: 'e2', priority: 1 });
    const vector = [0.5, -0.25, 0.125];
    transport.configure('openai', { vector, inputTokens: 7 });
    transport.configure('google', { vector, inputTokens: 7 });

    const result = await verifyProviderHotSwap(member(tenantHotSwap), {
      capability: 'embedding',
      scope: 'background',
      dataClassification: 'public',
      embeddingInput: 'swap me',
      targetA: { accountId: openaiAccount.id, model: 'text-embedding-3-small' },
      targetB: { accountId: googleAccount.id, model: 'gemini-embedding-001' },
    });
    expect(result.verification.outcome).toBe('equivalent');
    expect(result.executionA.model).toBe('text-embedding-3-small');
    expect(result.executionB.model).toBe('gemini-embedding-001');
  });

  it('rejects identical targets, unknown models and foreign accounts precisely', async () => {
    const admin = llmAdmin(tenantHotSwap);
    const account = await registerAccount(admin, { provider: 'openai', label: 'a4', priority: 0 });

    await expectCode('invalid_llm_input', () =>
      verifyProviderHotSwap(member(tenantHotSwap), {
        ...CHAT_REQUEST,
        targetA: { accountId: account.id, model: 'gpt-4o' },
        targetB: { accountId: account.id, model: 'gpt-4o' },
      }),
    );
    await expectCode('unsupported_model', () =>
      verifyProviderHotSwap(member(tenantHotSwap), {
        ...CHAT_REQUEST,
        targetA: { accountId: account.id, model: 'gpt-4o' },
        targetB: { accountId: account.id, model: 'made-up' },
      }),
    );
    await expectCode('account_not_found', () =>
      verifyProviderHotSwap(member(tenantHotSwap), {
        ...CHAT_REQUEST,
        targetA: { accountId: newId(), model: 'gpt-4o' },
        targetB: { accountId: account.id, model: 'gpt-4o-mini' },
      }),
    );
    await expectCode('account_not_found', () =>
      verifyProviderHotSwap(member(tenantOther), {
        ...CHAT_REQUEST,
        targetA: { accountId: account.id, model: 'gpt-4o' },
        targetB: { accountId: account.id, model: 'gpt-4o-mini' },
      }),
    );
    // targetB's model does not support the requested capability at all.
    await expectCode('unsupported_capability', () =>
      verifyProviderHotSwap(member(tenantHotSwap), {
        ...CHAT_REQUEST,
        targetA: { accountId: account.id, model: 'gpt-4o' },
        targetB: { accountId: account.id, model: 'text-embedding-3-small' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Usage summary (performance + cost)
// ---------------------------------------------------------------------------

describe('llm service — usage summary', () => {
  it('aggregates executions per (provider, model, capability)', async () => {
    const ctx = member(tenantInvoke);
    const summary = await getLlmUsageSummary(ctx, {});
    expect(summary.length).toBeGreaterThan(0);

    const openaiChat = summary.find(
      (row) => row.provider === 'openai' && row.model === 'gpt-4o',
    )!;
    expect(openaiChat.capability).toBe('text-generation');
    expect(openaiChat.executions).toBeGreaterThanOrEqual(2);
    expect(openaiChat.completed).toBeGreaterThanOrEqual(2);
    expect(openaiChat.inputTokens).toBeGreaterThanOrEqual(100_000);
    expect(openaiChat.costMinor).toBeGreaterThanOrEqual(75);
    expect(openaiChat.costCurrency).toBe('USD');
    expect(openaiChat.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(openaiChat.maxLatencyMs).toBeGreaterThanOrEqual(openaiChat.avgLatencyMs ?? 0);

    const byProvider = await getLlmUsageSummary(ctx, { provider: 'openai' });
    expect(byProvider.every((row) => row.provider === 'openai')).toBe(true);
    expect(byProvider.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (append-only evidence)
// ---------------------------------------------------------------------------

describe('llm service — append-only evidence stores', () => {
  it('rejects UPDATE and DELETE on executions, availability events and verifications', async () => {
    const admin = llmAdmin(tenantImmutable);
    const account = await registerAccount(admin, { provider: 'openai', label: 'immutable', priority: 0 });
    const execution = await invokeLlm(member(tenantImmutable), { ...CHAT_REQUEST });
    await setAiAvailability(admin, {
      accountId: account.id,
      model: 'gpt-4o',
      state: 'unavailable',
      reason: 'test outage',
    });
    const verification = await verifyProviderHotSwap(member(tenantImmutable), {
      ...CHAT_REQUEST,
      targetA: { accountId: account.id, model: 'gpt-4o' },
      targetB: { accountId: account.id, model: 'gpt-4o-mini' },
    });

    const db = getDb();
    await expect(db.query(`UPDATE llm_executions SET cost_minor = 0 WHERE id = $1`, [execution.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM llm_executions WHERE id = $1`, [execution.id])).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE llm_availability_events SET state = 'available' WHERE tenant_id = $1`, [tenantImmutable]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM llm_availability_events WHERE tenant_id = $1`, [tenantImmutable]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE llm_hot_swap_verifications SET outcome = 'equivalent' WHERE id = $1`, [verification.verification.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM llm_hot_swap_verifications WHERE id = $1`, [verification.verification.id]),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation sweep (ADR-0001)
// ---------------------------------------------------------------------------

describe('llm service — tenant isolation', () => {
  it('another tenant sees none of this tenant\'s llm state', async () => {
    const admin = llmAdmin(tenantIsolation);
    const account = await registerAccount(admin, { provider: 'openai', label: 'isolated', priority: 0 });
    const execution = await invokeLlm(member(tenantIsolation), { ...CHAT_REQUEST });
    const verification = await verifyProviderHotSwap(member(tenantIsolation), {
      ...CHAT_REQUEST,
      targetA: { accountId: account.id, model: 'gpt-4o' },
      targetB: { accountId: account.id, model: 'gpt-4o-mini' },
    });

    const other = member(tenantOther);
    await expectCode('account_not_found', () => getAiProviderAccount(other, { accountId: account.id }));
    expect(await listAiProviderAccounts(other, {})).toEqual([]);
    expect(await listLlmExecutions(other, {})).toEqual([]);
    expect(await getAiAvailability(other, {})).toEqual([]);
    expect(await getLlmUsageSummary(other, {})).toEqual([]);
    await expectCode('execution_not_found', () => getLlmExecution(other, { executionId: execution.id }));
    await expectCode('verification_not_found', () =>
      getHotSwapVerification(other, { verificationId: verification.verification.id }),
    );
    await expectCode('account_not_found', () =>
      getAiProviderAccountSpend(other, { accountId: account.id }),
    );

    // And the tenant itself still sees everything.
    expect((await listLlmExecutions(member(tenantIsolation), {})).length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Contract surface (provider isolation, structural)
// ---------------------------------------------------------------------------

describe('llm contract — the public surface is provider-neutral', () => {
  it('exports no adapter symbols or provider-native helpers', () => {
    const names = Object.keys(llmContract);
    expect(names.some((name) => /adapter/i.test(name))).toBe(false);
    expect(names).toContain('invokeLlm');
    expect(names).toContain('verifyProviderHotSwap');
    expect(names).toContain('listLlmModels');
    expect(names).toContain('LLM_AUTHORITY_ADMINISTER');
    expect(names).toContain('LlmError');
    // Registry reads are pure reference data (no TenantContext needed).
    expect(llmContract.findLlmModel('openai', 'gpt-4o')!.provider).toBe('openai');
    expect(llmContract.findLlmModel('openai', 'nope')).toBeNull();
  });

  it('the registry catalog is complete and consistently priced through the contract', () => {
    const models = llmContract.listLlmModels();
    expect(models.length).toBeGreaterThanOrEqual(10);
    for (const model of models) {
      expect(Number.isSafeInteger(model.priceInputMinorPerMillion)).toBe(true);
      expect(model.priceInputMinorPerMillion).toBeGreaterThanOrEqual(0);
      expect(model.priceOutputMinorPerMillion).toBeGreaterThanOrEqual(0);
      expect(model.currency).toBe('USD');
      expect(model.capabilities.length).toBeGreaterThan(0);
    }
    expect(llmContract.listLlmProviders().length).toBe(models.length > 0 ? 7 : 0);
  });
});
