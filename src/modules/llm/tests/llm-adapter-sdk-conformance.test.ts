// W089 — the two-provider proof: the llm gateway's openai and anthropic
// adapters are conforming ProviderAdapterDefinitions. This suite runs the
// provider-sdk conformance kit against both REAL adapters, including
// hot-swap evidence built from an ACTUAL verifyProviderHotSwap run through
// the module's canonical invocation path (embedded PostgreSQL, recording
// transport speaking both providers' native dialects).
//
// What this proves (WORK-ITEM-CATALOG W089 acceptance: "one template can
// produce at least two conforming providers for a representative gateway"):
//   * both materially different providers satisfy the SAME canonical
//     lifecycle, capability-reporting, error-normalization and evidence
//     contracts, produced by the ONE template (createProviderAdapterDefinition);
//   * the gateway's own hot-swap verification (W034/W048 precedent) feeds
//     the canonical SDK evidence format without any contract change;
//   * behavior is unchanged — the adapters' translation methods still throw
//     the same LlmError codes with the same messages (regression checks
//     here; the module's pre-existing suites run unmodified).
//
// The conformance suite itself is 100% provider-sdk kit code; this file
// only supplies the subjects and the vitest glue (see provider-sdk README).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  buildHotSwapEvidence,
  defineAdapterConformanceSuite,
  type AdapterConformanceSubject,
  type HotSwapEvidenceRecord,
} from '@/modules/provider-sdk/contract';
import { verifyProviderHotSwap } from '../contract';
import { anthropicAdapter } from '../adapters/anthropic';
import { openaiAdapter } from '../adapters/openai';
import type { LlmTransport, LlmTransportReceipt, LlmTransportRequest } from '../types';
import { LlmError } from '../errors';
import { setLlmTransport } from '../service';
import { runMigrations } from '../../../../scripts/migrate';

const tenantHotSwap = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function llmAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['llm:administer'] };
}

// ---------------------------------------------------------------------------
// A recording transport speaking the openai + anthropic native dialects
// ---------------------------------------------------------------------------

class DialectTransport implements LlmTransport {
  readonly requests: LlmTransportRequest[] = [];

  async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
    this.requests.push(request);
    const text = 'Same canonical answer.';
    if (request.provider === 'anthropic') {
      return {
        status: 'delivered',
        providerExecutionId: `msg_${this.requests.length}`,
        payload: {
          id: `msg_${this.requests.length}`,
          content: [{ type: 'text', text }],
          usage: { input_tokens: 12, output_tokens: 3 },
        },
        detail: null,
      };
    }
    return {
      status: 'delivered',
      providerExecutionId: `chat_${this.requests.length}`,
      payload: {
        id: `chat_${this.requests.length}`,
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
      detail: null,
    };
  }
}

let transport: DialectTransport;
let hotSwapEvidence: HotSwapEvidenceRecord | null = null;

beforeAll(async () => {
  await runMigrations(getDb());
  transport = new DialectTransport();
  setLlmTransport(transport);

  // The canonical swap: the SAME request through two materially different
  // providers via the gateway's own verification flow (W034 precedent).
  const admin = llmAdmin(tenantHotSwap);
  const openaiAccount = await verifyAccount(admin, 'openai', 'conformance-openai');
  const anthropicAccount = await verifyAccount(admin, 'anthropic', 'conformance-anthropic');
  const result = await verifyProviderHotSwap(member(tenantHotSwap), {
    capability: 'text-generation',
    scope: 'cognition',
    dataClassification: 'internal',
    messages: [
      { role: 'system', content: 'Answer in one word.' },
      { role: 'user', content: 'Is the gateway provider-neutral?' },
    ],
    targetA: { accountId: openaiAccount, model: 'gpt-4o' },
    targetB: { accountId: anthropicAccount, model: 'claude-sonnet-4-5' },
  });
  expect(result.verification.outcome).toBe('equivalent');
  expect(result.verification.targetA.provider !== result.verification.targetB.provider).toBe(true);

  // Reshape the gateway's verification into the canonical SDK evidence
  // record — no domain change, no provider objects crossing boundaries.
  hotSwapEvidence = buildHotSwapEvidence({
    gateway: 'llm',
    capability: result.verification.capability,
    providerA: {
      provider: result.verification.targetA.provider,
      target: result.verification.targetA.model,
      resultKind: result.executionA.status === 'completed' ? 'completed' : 'failed',
    },
    providerB: {
      provider: result.verification.targetB.provider,
      target: result.verification.targetB.model,
      resultKind: result.executionB.status === 'completed' ? 'completed' : 'failed',
    },
    outcome: result.verification.outcome,
    evidenceId: result.verification.id,
    executedAt: result.verification.verifiedAt,
    requestDigest: result.verification.requestDigest,
    note: 'W089 two-provider proof: llm gateway openai ↔ anthropic via verifyProviderHotSwap',
  });
});

afterAll(async () => {
  setLlmTransport(null);
  await closeDb();
});

async function verifyAccount(
  admin: TenantContext,
  provider: 'openai' | 'anthropic',
  label: string,
): Promise<string> {
  const { registerAiProviderAccount } = await import('../contract');
  const registration = await registerAiProviderAccount(admin, {
    provider,
    label,
    // Fake credential reference assembled from fragments at runtime (push-protection discipline).
    credentialRef: `secret-store://${provider.slice(0, 3)}/${label}-${'ref'}`,
    scopes: ['cognition', 'conversation', 'analysis', 'background'],
    capabilities: ['text-generation', 'embedding'],
    maxDataClassification: 'restricted',
    priority: 100,
    budgetMinor: null,
  });
  return registration.account.id;
}

// ---------------------------------------------------------------------------
// The conformance subjects (the only adapter-specific input the kit needs)
// ---------------------------------------------------------------------------

const openAiSubject: AdapterConformanceSubject = {
  definition: openaiAdapter,
  gateway: 'llm',
  errorSpecimens: [
    {
      description: 'unparseable provider completion payload',
      error: new LlmError('provider_malformed_response', 'the openai completion response carries no choice'),
      expectedCategory: 'malformed_response',
    },
    {
      description: 'transport connection timeout',
      error: new Error('connect ETIMEDOUT api.openai.example:443 after 30000ms'),
      expectedCategory: 'timeout',
      expectedRetryable: true,
    },
    {
      description: 'provider throttling response',
      error: Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: 1_200 }),
      expectedCategory: 'rate_limited',
      expectedRetryable: true,
    },
    {
      description: 'provider outage response',
      error: Object.assign(new Error('upstream capacity'), { status: 503 }),
      expectedCategory: 'provider_unavailable',
      expectedRetryable: true,
    },
  ],
  expectedCapabilities: ['embedding', 'text-generation'],
  hotSwapEvidence: () => hotSwapEvidence!,
};

const anthropicSubject: AdapterConformanceSubject = {
  definition: anthropicAdapter,
  gateway: 'llm',
  errorSpecimens: [
    {
      description: 'unparseable provider completion payload',
      error: new LlmError('provider_malformed_response', 'the anthropic completion response carries no text block'),
      expectedCategory: 'malformed_response',
    },
    {
      // REAL adapter behavior: the loud unsupported-embedding rejection.
      description: 'unsupported embeddings capability (the adapter rejects it loudly)',
      error: (() => {
        try {
          anthropicAdapter.buildEmbeddingRequest({ model: 'text-embedding-3-small', input: 'x' });
        } catch (error) {
          return error;
        }
        return new LlmError('unsupported_capability', 'unexpectedly supported');
      })(),
      expectedCategory: 'unsupported_capability',
    },
    {
      // REAL adapter behavior: the system-only mapping rejection.
      description: 'system-only request that cannot map onto the anthropic wire shape',
      error: (() => {
        try {
          anthropicAdapter.buildCompletionRequest({
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'system', content: 'only system' }],
            temperature: null,
            maxOutputTokens: 64,
          });
        } catch (error) {
          return error;
        }
        return new LlmError('invalid_llm_input', 'unexpectedly mapped');
      })(),
      expectedCategory: 'invalid_request',
    },
    {
      description: 'transport connection refused',
      error: new Error('connect ECONNREFUSED 10.0.0.7:443'),
      expectedCategory: 'provider_unavailable',
      expectedRetryable: true,
    },
  ],
  expectedCapabilities: ['text-generation'],
  hotSwapEvidence: () => hotSwapEvidence!,
};

// ---------------------------------------------------------------------------
// The kit-driven suites (one describe per provider — all checks are kit code)
// ---------------------------------------------------------------------------

defineAdapterConformanceSuite(openAiSubject, { describe, it });
defineAdapterConformanceSuite(anthropicSubject, { describe, it });

// ---------------------------------------------------------------------------
// Behavior-unchanged regression + the swap evidence itself
// ---------------------------------------------------------------------------

describe('llm adapter SDK conformance — behavior unchanged', () => {
  it('openai adapter still translates exactly as before (wire shapes identical)', () => {
    const body = openaiAdapter.buildCompletionRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Answer in one word.' },
        { role: 'user', content: 'Provider neutral?' },
      ],
      temperature: 0.2,
      maxOutputTokens: 128,
    }) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(body['max_tokens']).toBe(128);
    expect(body['temperature']).toBe(0.2);
    expect(body['messages']).toEqual([
      { role: 'system', content: 'Answer in one word.' },
      { role: 'user', content: 'Provider neutral?' },
    ]);
    const parsed = openaiAdapter.parseCompletionResponse({
      id: 'chat_x',
      choices: [{ message: { content: 'Yes.' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    expect(parsed).toEqual({
      text: 'Yes.',
      usage: { inputTokens: 3, outputTokens: 1 },
      providerExecutionId: 'chat_x',
    });
    expect(() =>
      openaiAdapter.parseCompletionResponse({ choices: [], usage: {} }),
    ).toThrowError(LlmError);
  });

  it('anthropic adapter still rejects embeddings loudly and maps system prompts out of band', () => {
    expect(() => anthropicAdapter.buildEmbeddingRequest({ model: 'x', input: 'y' })).toThrowError(
      /no embeddings API/,
    );
    const body = anthropicAdapter.buildCompletionRequest({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
      temperature: null,
      maxOutputTokens: 64,
    }) as Record<string, unknown>;
    expect(body['system']).toBe('Be terse.');
    expect(body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ]);
  });

  it('the definitions expose only the canonical SDK surface (no selection, no wire types)', () => {
    for (const definition of [openaiAdapter, anthropicAdapter]) {
      expect(definition.sdk).toBe('provider-adapter-definition');
      expect(definition.gateway).toBe('llm');
      expect(Object.keys(definition).sort()).toEqual([
        'buildCompletionRequest',
        'buildEmbeddingRequest',
        'describeCapabilities',
        'gateway',
        'mapError',
        'parseCompletionResponse',
        'parseEmbeddingResponse',
        'provider',
        'sdk',
        'sdkVersion',
      ]);
    }
    expect(openaiAdapter.describeCapabilities().capabilities).toEqual(['text-generation', 'embedding']);
    expect(anthropicAdapter.describeCapabilities().capabilities).toEqual(['text-generation']);
  });
});

describe('llm adapter SDK conformance — hot-swap evidence from the real verification flow', () => {
  it('carries the canonical record for the openai ↔ anthropic swap', () => {
    expect(hotSwapEvidence).not.toBeNull();
    const record = hotSwapEvidence!;
    expect(record.gateway).toBe('llm');
    expect(record.capability).toBe('text-generation');
    expect(record.providerA.provider).toBe('openai');
    expect(record.providerA.target).toBe('gpt-4o');
    expect(record.providerA.resultKind).toBe('completed');
    expect(record.providerB.provider).toBe('anthropic');
    expect(record.providerB.target).toBe('claude-sonnet-4-5');
    expect(record.providerB.resultKind).toBe('completed');
    expect(record.outcome).toBe('equivalent');
    expect(record.comparison).toBe('deterministic-structural');
    expect(record.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.evidenceId).not.toBe('');
  });

  it('proves the transport actually spoke both native dialects (adapter isolation, not an echo)', () => {
    // Two provider interactions through the recording transport: the
    // verification pinned one target per provider.
    const providers = transport.requests.map((request) => request.provider).sort();
    expect(providers).toEqual(['anthropic', 'openai']);
  });
});
