// W048 — Provider Hot-Swap Verification (cross-module verification suite).
//
// WORK-ITEM-CATALOG W048: "Run the same capability against multiple AI
// providers/models and agent runtimes without semantic migration or
// business code rewrite."
//
// GOVERNANCE.md "Provider swap evidence" — the three clauses this suite
// verifies end-to-end against the embedded PostgreSQL (PGlite,
// `:memory:`) through the db port:
//
//   1. "The same provider-independent AI capability must execute through
//      at least two providers/models."
//         → the SAME business capability (`capability.ts`, written once,
//           provider-agnostic by construction) runs through EVERY provider
//           in the llm registry — all seven for text-generation, all four
//           embedding-capable providers for the embedding capability — and
//           through multiple models of one provider, and through a pure
//           tenant-preference flip (management-control update, zero code
//           change).
//
//   2. "The same agent contract must execute through at least two
//      runtime/provider adapters where available."
//         → the same agent contract (role/instructions/permissions/task)
//           executes through ALL FIVE runtime adapters of the agents
//           gateway (openai-assistants, langgraph, crewai, autogen,
//           semantic-kernel) with identical canonical results, identical
//           async lifecycle and per-runtime append-only evidence.
//
//   3. "Domain semantics and persisted authoritative state must remain
//      unchanged."
//         → whole-schema snapshots around each swap: only the gateways'
//           append-only evidence tables grow; every other domain table
//         (all 80+) is digest-identical; pre-existing evidence rows are
//         untouched; the derived domain outcomes are deep-equal.
//
// The same canonical input producing DIFFERENT provider-native wire bodies
// but IDENTICAL canonical outputs is asserted per provider/runtime
// (dialect realism) — that is the "no semantic migration" mechanism:
// translation lives in the gateways' adapters, semantics in the contracts.
//
// Scope discipline: this is a verification item — its owned surface is
// tests/provider-hotswap/** (IMPLEMENTATION-STACK §7 cross-cutting
// fixtures). Every module import below goes through the module's
// contract.ts exactly (enforced structurally by the final describe group).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

// Module contracts — the ONLY legal cross-module surface (rule enforced
// by the boundary scan at the bottom of this file).
import {
  LlmError,
  getHotSwapVerification,
  getLlmExecution,
  invokeLlm,
  listLlmModels,
  listLlmProviders,
  registerAiProviderAccount,
  setLlmTransport,
  updateAiProviderAccount,
  verifyProviderHotSwap,
} from '@/modules/llm/contract';
import type {
  AiProviderAccount,
  LlmCapability,
  LlmExecution,
  LlmProvider,
  LlmScope,
  LlmTransportRequest,
} from '@/modules/llm/contract';
import {
  AGENT_RUNTIME_PROVIDERS,
  getAgentExecution,
  listAgentExecutionAttempts,
  listAgentExecutions,
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
} from '@/modules/agents/contract';
import type {
  AgentExecution,
  AgentPermissionScope,
  AgentRuntimeProvider,
  AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';

// The object under verification: provider-independent business code.
import {
  delegateTriageToAgent,
  deriveTriageFinding,
  embedConversationSummary,
  triageConversationFinding,
} from './capability';
import type {
  DelegationOutcome,
  EmbeddedSummary,
  TriageFinding,
} from './capability';
import {
  RecordingAgentRuntimeTransport,
  RecordingLlmTransport,
  fakeCredentialRef,
} from './fakes';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const llmGateway = { invokeLlm };
const agentGateway = { submitAgentExecution, runAgentExecution };

// Dedicated tenants per group so row-count assertions stay deterministic.
const tenantSweep = newId();
const tenantModelSwap = newId();
const tenantPrefSwap = newId();
const tenantEmbed = newId();
const tenantVerify = newId();
const tenantAgentSweep = newId();
const tenantState = newId();
const tenantOther = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function llmAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['llm:administer'] };
}

function agentsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

async function expectLlmError(
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

/**
 * Strips the per-run opaque evidence pointer from a derived outcome so
 * outcomes from different providers/runtimes can be compared on their
 * DOMAIN semantics (the pointer differs by design — every execution is
 * its own evidence row).
 */
function semantic<T extends { evidenceExecutionId: string }>(
  outcome: T,
): Omit<T, 'evidenceExecutionId'> {
  const { evidenceExecutionId: _evidence, ...rest } = outcome;
  return rest;
}

const ALL_LLM_SCOPES: LlmScope[] = ['cognition', 'conversation', 'analysis', 'background'];
const ALL_LLM_CAPABILITIES: LlmCapability[] = ['text-generation', 'embedding'];

async function registerLlmAccount(
  admin: TenantContext,
  provider: LlmProvider,
  label: string,
  priority: number,
): Promise<AiProviderAccount> {
  const result = await registerAiProviderAccount(admin, {
    provider,
    label,
    credentialRef: fakeCredentialRef(provider, label),
    scopes: ALL_LLM_SCOPES,
    capabilities: ALL_LLM_CAPABILITIES,
    maxDataClassification: 'restricted',
    priority,
  });
  return result.account;
}

/** The registry's first model of `provider` serving `capability`. */
function firstModelOf(provider: LlmProvider, capability: LlmCapability): string {
  const model = listLlmModels(provider).find((entry) =>
    (entry.capabilities as readonly string[]).includes(capability),
  );
  if (model === undefined) {
    throw new Error(`registry carries no ${capability} model for ${provider}`);
  }
  return model.modelId;
}

// The canonical business inputs every provider/runtime must serve.
const CANONICAL_TRIAGE_TEXT =
  'The customer needs an urgent invoice copy before Friday; triage as billing and routine.';
const DIVERGENT_TRIAGE_TEXT =
  'A polite acknowledgement was sent with the invoice attached.';
const EMBED_TEXT =
  'Customer requests an invoice resend before the Friday payment run.';
const CANONICAL_VECTOR = [0.5, 0.25, 0.125, -0.0625];
const AGENT_VERDICT = { triaged: true, category: 'billing', needsHuman: false };
const AGENT_SUMMARY = 'Triaged as billing; no human needed.';
const SYSTEM_PROMPT = 'Triage the conversation excerpt. Answer in one short sentence.';
const SWEEP_EXCERPT =
  'Customer writes: please resend the invoice; our payment run closes on Friday.';
const AGENT_CONVERSATION_ID = 'conv-w048-agent';
const AGENT_CORRELATION_ID = 'w048-runtime-sweep';

// The agent contract — identical for every runtime (only the runtime
// binding differs, which is tenant configuration, not business code).
const TRIAGE_AGENT_ROLE = 'conversation triage';
const TRIAGE_AGENT_INSTRUCTIONS =
  'Triage the conversation and propose the next action.';
const TRIAGE_AGENT_PERMISSIONS: AgentPermissionScope[] = ['observe', 'analyze', 'recommend'];
const RUNTIME_CONFIGS: Record<AgentRuntimeProvider, unknown> = {
  'openai-assistants': { assistantId: 'asst_w048' },
  langgraph: { assistantId: 'graph_w048' },
  crewai: { crewName: 'crew_w048' },
  autogen: { teamId: 'team_w048' },
  'semantic-kernel': { agentId: 'kernel_w048' },
};

async function registerTriageAgent(
  admin: TenantContext,
  runtime: AgentRuntimeProvider,
  slug: string,
): Promise<{ id: string }> {
  const result = await registerAgent(admin, {
    slug,
    displayName: `Triage via ${runtime}`,
    role: TRIAGE_AGENT_ROLE,
    description: 'W048 hot-swap verification fixture agent.',
    provider: runtime,
    instructions: TRIAGE_AGENT_INSTRUCTIONS,
    permissions: TRIAGE_AGENT_PERMISSIONS,
    runtimeConfig: RUNTIME_CONFIGS[runtime],
  });
  return result.agent;
}

let llmTransport: RecordingLlmTransport;
let agentTransport: RecordingAgentRuntimeTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setLlmTransport(null);
  setAgentTransport(null);
  await closeDb();
});

beforeEach(() => {
  llmTransport = new RecordingLlmTransport();
  agentTransport = new RecordingAgentRuntimeTransport();
  setLlmTransport(llmTransport);
  setAgentTransport(agentTransport);
});

function lastLlmRequestFor(provider: string): LlmTransportRequest {
  const matches = llmTransport.requests.filter((request) => request.provider === provider);
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1]!;
}

function lastAgentRequestFor(runtime: string): AgentRuntimeTransportRequest {
  const matches = agentTransport.requests.filter((request) => request.provider === runtime);
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1]!;
}

// ---------------------------------------------------------------------------
// Dialect realism — the same canonical input must reach each provider in
// THAT provider's native wire shape (translation happened inside the
// gateway), while the canonical output comes back identical.
// ---------------------------------------------------------------------------

function assertNativeCompletionDialect(
  request: LlmTransportRequest,
  provider: string,
  modelId: string,
): void {
  expect(request.kind).toBe('completion');
  const body = request.body as Record<string, unknown>;
  switch (provider) {
    case 'anthropic': {
      expect(body.model).toBe(modelId);
      expect(body.max_tokens).toBe(512);
      // Anthropic carries the system prompt OUT of the message list.
      expect(body.system).toBe(SYSTEM_PROMPT);
      const messages = body.messages as Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.content[0]!.type).toBe('text');
      expect(messages.every((message) => message.role !== 'system')).toBe(true);
      expect(body.contents).toBeUndefined();
      break;
    }
    case 'google': {
      expect(body.model).toBe(modelId);
      // Google: systemInstruction + contents(user/model) + generationConfig.
      expect((body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text).toBe(
        SYSTEM_PROMPT,
      );
      const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
      expect(contents[0]!.role).toBe('user');
      expect(contents.every((entry) => entry.role !== 'assistant' && entry.role !== 'system')).toBe(
        true,
      );
      const config = body.generationConfig as { maxOutputTokens: number; temperature: number };
      expect(config.maxOutputTokens).toBe(512);
      expect(config.temperature).toBe(0);
      expect(body.messages).toBeUndefined();
      break;
    }
    default: {
      // The OpenAI-shaped dialect family: openai, mistral, cohere,
      // deepseek, groq — flat messages WITH the system role, max_tokens.
      expect(body.model).toBe(modelId);
      expect(body.max_tokens).toBe(512);
      expect(body.temperature).toBe(0);
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages[0]!.role).toBe('system');
      expect(messages[0]!.content).toBe(SYSTEM_PROMPT);
      expect(messages[1]!.role).toBe('user');
      expect(body.system).toBeUndefined();
      expect(body.contents).toBeUndefined();
      break;
    }
  }
}

function assertNativeEmbeddingDialect(
  request: LlmTransportRequest,
  provider: string,
  modelId: string,
): void {
  expect(request.kind).toBe('embedding');
  const body = request.body as Record<string, unknown>;
  expect(body.model).toBe(modelId);
  switch (provider) {
    case 'google':
      expect((body.content as { parts: Array<{ text: string }> }).parts[0]!.text).toBe(EMBED_TEXT);
      break;
    case 'cohere': {
      expect(body.texts).toEqual([EMBED_TEXT]);
      expect(body.input_type).toBe('search_document');
      break;
    }
    case 'mistral':
      expect(body.input).toEqual([EMBED_TEXT]);
      break;
    default: // openai (and any OpenAI-compatible embedding provider)
      expect(body.input).toBe(EMBED_TEXT);
      break;
  }
}

function assertAgentRuntimeDialect(
  request: AgentRuntimeTransportRequest,
  runtime: AgentRuntimeProvider,
): void {
  const body = request.body as Record<string, unknown>;
  // Every runtime nests the SAME canonical task payload — in its own shape.
  const taskCarries = (holder: unknown): void => {
    const task = holder as { conversationId?: unknown; goal?: unknown; kind?: unknown };
    expect(task.conversationId).toBe(AGENT_CONVERSATION_ID);
    expect(task.goal).toBe('draft a reply for review');
    expect(task.kind).toBe('conversation-triage');
  };
  switch (runtime) {
    case 'openai-assistants': {
      expect(request.runtimeAgentRef).toBe('asst_w048');
      expect(body.assistant_id).toBe('asst_w048');
      expect(body.instructions).toBe(TRIAGE_AGENT_INSTRUCTIONS);
      const input = body.input as Array<{ role: string; content: string }>;
      expect(input[0]!.role).toBe('user');
      const parsed = JSON.parse(input[0]!.content) as {
        task: unknown;
        permissions: string[];
      };
      taskCarries(parsed.task);
      expect(parsed.permissions).toEqual(['observe', 'analyze']);
      break;
    }
    case 'langgraph': {
      expect(request.runtimeAgentRef).toBe('graph_w048');
      expect(body.assistant_id).toBe('graph_w048');
      const input = body.input as { task: unknown; instructions: string; permissions: string[] };
      taskCarries(input.task);
      expect(input.instructions).toBe(TRIAGE_AGENT_INSTRUCTIONS);
      expect(input.permissions).toEqual(['observe', 'analyze']);
      break;
    }
    case 'crewai': {
      expect(request.runtimeAgentRef).toBe('crew_w048');
      expect(body.crew).toBe('crew_w048');
      const inputs = body.inputs as { task: unknown; instructions: string; permissions: string[] };
      taskCarries(inputs.task);
      expect(inputs.instructions).toBe(TRIAGE_AGENT_INSTRUCTIONS);
      expect(inputs.permissions).toEqual(['observe', 'analyze']);
      break;
    }
    case 'autogen': {
      expect(request.runtimeAgentRef).toBe('team_w048');
      expect(body.team).toBe('team_w048');
      const task = body.task as { payload: unknown; instructions: string; permissions: string[] };
      taskCarries(task.payload);
      expect(task.instructions).toBe(TRIAGE_AGENT_INSTRUCTIONS);
      expect(task.permissions).toEqual(['observe', 'analyze']);
      break;
    }
    case 'semantic-kernel': {
      expect(request.runtimeAgentRef).toBe('kernel_w048');
      expect(body.agentId).toBe('kernel_w048');
      const args = body.arguments as { task: unknown; instructions: string; permissions: string[] };
      taskCarries(args.task);
      expect(args.instructions).toBe(TRIAGE_AGENT_INSTRUCTIONS);
      expect(args.permissions).toEqual(['observe', 'analyze']);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-schema snapshots (clause 3 — authoritative state unchanged)
// ---------------------------------------------------------------------------

class SchemaSnapshot {
  constructor(
    readonly entries: ReadonlyMap<string, { rows: number; digest: string }>,
  ) {}

  tableNames(): string[] {
    return [...this.entries.keys()].sort();
  }

  rows(table: string): number {
    return this.entries.get(table)?.rows ?? -1;
  }
}

async function snapshotPublicTables(): Promise<SchemaSnapshot> {
  const db = getDb();
  const tables = (
    await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    )
  ).rows.map((row) => row.table_name);
  const entries = new Map<string, { rows: number; digest: string }>();
  for (const table of tables) {
    const result = await db.query<{ row_count: string; digest: string }>(
      `SELECT count(*)::text AS row_count,
              md5(coalesce(string_agg(row_text, '|' ORDER BY row_text), '')) AS digest
         FROM (SELECT t::text AS row_text FROM "public"."${table}" AS t) AS s`,
    );
    const row = result.rows[0]!;
    entries.set(table, { rows: Number(row.row_count), digest: row.digest });
  }
  return new SchemaSnapshot(entries);
}

/** Tables whose row count or content digest moved between two snapshots. */
function changedTables(before: SchemaSnapshot, after: SchemaSnapshot): string[] {
  const changed: string[] = [];
  for (const table of before.tableNames()) {
    const a = before.entries.get(table)!;
    const b = after.entries.get(table);
    if (b === undefined || a.rows !== b.rows || a.digest !== b.digest) {
      changed.push(table);
    }
  }
  for (const table of after.tableNames()) {
    if (!before.entries.has(table)) changed.push(`+${table}`);
  }
  return changed.sort();
}

// ---------------------------------------------------------------------------
// Clause 1 — the same AI capability through multiple providers/models
// ---------------------------------------------------------------------------

describe('W048 — one AI capability through every LLM provider (no rewrite)', () => {
  it('derives the identical domain finding through every registered provider', async () => {
    const admin = llmAdmin(tenantSweep);
    const ctx = member(tenantSweep);

    const textProviders = listLlmProviders().filter((provider) =>
      listLlmModels(provider).some((model) =>
        (model.capabilities as readonly string[]).includes('text-generation'),
      ),
    );
    // GOVERNANCE minimum: at least two providers for the same capability.
    expect(textProviders.length).toBeGreaterThanOrEqual(2);

    const findings: TriageFinding[] = [];
    const byProvider = new Map<
      string,
      { finding: TriageFinding; execution: LlmExecution }
    >();

    // The SAME business function object runs against every provider —
    // nothing about the capability changes between iterations.
    for (const provider of textProviders) {
      const modelId = firstModelOf(provider, 'text-generation');
      llmTransport.serve(provider, { text: CANONICAL_TRIAGE_TEXT });
      const account = await registerLlmAccount(admin, provider, `sweep-${provider}`, 0);
      const finding = await triageConversationFinding(llmGateway, ctx, {
        conversationId: 'conv-w048-sweep',
        transcriptExcerpt: SWEEP_EXCERPT,
        routing: { pinnedAccountId: account.id, pinnedModel: modelId },
      });
      findings.push(finding);
      byProvider.set(provider, {
        finding,
        execution: await getLlmExecution(ctx, { executionId: finding.evidenceExecutionId }),
      });
    }

    // (a) Identical domain semantics through every provider.
    for (const finding of findings) {
      expect(semantic(finding)).toEqual(semantic(findings[0]!));
    }
    expect(findings[0]!.headline).toBe(CANONICAL_TRIAGE_TEXT);
    expect(findings[0]!.priority).toBe('high');
    expect(findings[0]!.derivedFrom).toBe('text-generation');

    // (b) The swap genuinely happened: distinct provider evidence rows
    //     with identical canonical results.
    const providerExecutionIds = new Set<string>();
    for (const provider of textProviders) {
      const entry = byProvider.get(provider)!;
      expect(entry.execution.provider).toBe(provider);
      expect(entry.execution.model).toBe(firstModelOf(provider, 'text-generation'));
      expect(entry.execution.status).toBe('completed');
      expect(entry.execution.purpose).toBe('invocation');
      expect(entry.execution.result).toEqual({
        kind: 'text-generation',
        text: CANONICAL_TRIAGE_TEXT,
      });
      expect(entry.execution.routing.pinned).toBe(true);
      expect(entry.execution.routing.chosen).toMatchObject({ provider });
      expect(entry.execution.costCurrency).toBe('USD');
      providerExecutionIds.add(entry.execution.providerExecutionId ?? '');
    }
    expect(providerExecutionIds.size).toBe(textProviders.length);

    // (c) Each provider received ITS OWN native wire dialect for the same
    //     canonical request — translation happened inside the gateway.
    for (const provider of textProviders) {
      assertNativeCompletionDialect(
        lastLlmRequestFor(provider),
        provider,
        firstModelOf(provider, 'text-generation'),
      );
    }
    expect(llmTransport.requests).toHaveLength(textProviders.length);
  });

  it('swaps MODELS within one provider with identical semantics', async () => {
    const admin = llmAdmin(tenantModelSwap);
    const ctx = member(tenantModelSwap);
    const account = await registerLlmAccount(admin, 'openai', 'model-swap', 0);
    const models = listLlmModels('openai')
      .filter((model) => (model.capabilities as readonly string[]).includes('text-generation'))
      .map((model) => model.modelId);
    expect(models.length).toBeGreaterThanOrEqual(2); // at least two models
    llmTransport.serve('openai', { text: CANONICAL_TRIAGE_TEXT });

    const findings: TriageFinding[] = [];
    for (const modelId of models) {
      findings.push(
        await triageConversationFinding(llmGateway, ctx, {
          conversationId: 'conv-w048-model-swap',
          transcriptExcerpt: SWEEP_EXCERPT,
          routing: { pinnedAccountId: account.id, pinnedModel: modelId },
        }),
      );
    }
    for (const finding of findings.slice(1)) {
      expect(semantic(finding)).toEqual(semantic(findings[0]!));
    }

    const executions: LlmExecution[] = [];
    for (const finding of findings) {
      executions.push(await getLlmExecution(ctx, { executionId: finding.evidenceExecutionId }));
    }
    expect(executions.map((execution) => execution.model)).toEqual(models);
    expect(executions.every((execution) => execution.provider === 'openai')).toBe(true);
    expect(new Set(executions.map((execution) => JSON.stringify(execution.result))).size).toBe(1);
  });
});

describe('W048 — tenant-preference hot-swap (configuration, not code)', () => {
  it('flips the serving provider via a management-control update alone', async () => {
    const admin = llmAdmin(tenantPrefSwap);
    const ctx = member(tenantPrefSwap);
    const primary = await registerLlmAccount(admin, 'openai', 'primary', 0);
    const backup = await registerLlmAccount(admin, 'anthropic', 'backup', 10);
    llmTransport.serve('openai', { text: CANONICAL_TRIAGE_TEXT });
    llmTransport.serve('anthropic', { text: CANONICAL_TRIAGE_TEXT });

    // No routing pin at all: the tenant's account preferences decide.
    const businessInput = {
      conversationId: 'conv-w048-pref-swap',
      transcriptExcerpt: SWEEP_EXCERPT,
    };
    const before = await triageConversationFinding(llmGateway, ctx, businessInput);
    const beforeExecution = await getLlmExecution(ctx, {
      executionId: before.evidenceExecutionId,
    });
    expect(beforeExecution.provider).toBe('openai');
    expect(beforeExecution.model).toBe(firstModelOf('openai', 'text-generation'));
    expect(beforeExecution.routing.pinned).toBe(false);
    expect(beforeExecution.routing.chosen).toMatchObject({
      accountId: primary.id,
      provider: 'openai',
    });

    // THE HOT-SWAP: two priority updates — tenant configuration only.
    await updateAiProviderAccount(admin, { accountId: primary.id, priority: 20 });
    await updateAiProviderAccount(admin, { accountId: backup.id, priority: 1 });

    // The SAME business code, the SAME input, the SAME call site.
    const after = await triageConversationFinding(llmGateway, ctx, businessInput);
    const afterExecution = await getLlmExecution(ctx, {
      executionId: after.evidenceExecutionId,
    });
    expect(afterExecution.provider).toBe('anthropic');
    expect(afterExecution.model).toBe(firstModelOf('anthropic', 'text-generation'));
    expect(afterExecution.routing.chosen).toMatchObject({
      accountId: backup.id,
      provider: 'anthropic',
    });

    // Domain semantics survived the swap untouched.
    expect(semantic(after)).toEqual(semantic(before));
    expect(afterExecution.result).toEqual(beforeExecution.result);
  });
});

describe('W048 — the embedding capability across providers', () => {
  it('derives identical embedding semantics through every embedding-capable provider', async () => {
    const admin = llmAdmin(tenantEmbed);
    const ctx = member(tenantEmbed);
    const providers = listLlmProviders().filter((provider) =>
      listLlmModels(provider).some((model) =>
        (model.capabilities as readonly string[]).includes('embedding'),
      ),
    );
    expect(providers.length).toBeGreaterThanOrEqual(2);

    const summaries: EmbeddedSummary[] = [];
    const byProvider = new Map<string, { summary: EmbeddedSummary; execution: LlmExecution }>();
    for (const provider of providers) {
      const modelId = firstModelOf(provider, 'embedding');
      llmTransport.serve(provider, { vector: CANONICAL_VECTOR });
      const account = await registerLlmAccount(admin, provider, `embed-${provider}`, 0);
      const summary = await embedConversationSummary(llmGateway, ctx, {
        conversationId: 'conv-w048-embed',
        summaryText: EMBED_TEXT,
        routing: { pinnedAccountId: account.id, pinnedModel: modelId },
      });
      summaries.push(summary);
      byProvider.set(provider, {
        summary,
        execution: await getLlmExecution(ctx, { executionId: summary.evidenceExecutionId }),
      });
    }

    for (const summary of summaries) {
      expect(semantic(summary)).toEqual(semantic(summaries[0]!));
    }
    expect(summaries[0]!.dimensions).toBe(CANONICAL_VECTOR.length);
    expect(summaries[0]!.firstComponent).toBe(CANONICAL_VECTOR[0]!);
    expect(summaries[0]!.derivedFrom).toBe('embedding');

    for (const provider of providers) {
      const entry = byProvider.get(provider)!;
      expect(entry.execution.capability).toBe('embedding');
      expect(entry.execution.provider).toBe(provider);
      expect(entry.execution.model).toBe(firstModelOf(provider, 'embedding'));
      expect(entry.execution.result).toEqual({ kind: 'embedding', vector: CANONICAL_VECTOR });
      assertNativeEmbeddingDialect(
        lastLlmRequestFor(provider),
        provider,
        firstModelOf(provider, 'embedding'),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The contract-owned verification path (W034 seed) — end-to-end
// ---------------------------------------------------------------------------

describe('W048 — verifyProviderHotSwap end-to-end', () => {
  const VERIFY_REQUEST = {
    capability: 'text-generation' as const,
    scope: 'analysis' as const,
    dataClassification: 'internal' as const,
    messages: [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      {
        role: 'user' as const,
        content: 'Conversation conv-w048-verify: customer asks for an urgent invoice copy.',
      },
    ],
    temperature: 0,
    maxOutputTokens: 512,
  };

  it("runs one canonical request through two providers and proves 'equivalent'", async () => {
    const admin = llmAdmin(tenantVerify);
    const ctx = member(tenantVerify);
    const openai = await registerLlmAccount(admin, 'openai', 'verify-a', 0);
    const anthropic = await registerLlmAccount(admin, 'anthropic', 'verify-b', 1);
    llmTransport.serve('openai', { text: CANONICAL_TRIAGE_TEXT });
    // Whitespace variance on the second provider: the structural
    // comparison normalizes; the swap still proves.
    llmTransport.serve('anthropic', { text: `  ${CANONICAL_TRIAGE_TEXT}  ` });

    const result = await verifyProviderHotSwap(ctx, {
      ...VERIFY_REQUEST,
      targetA: { accountId: openai.id, model: 'gpt-4o' },
      targetB: { accountId: anthropic.id, model: 'claude-sonnet-4-5' },
    });

    expect(result.verification.outcome).toBe('equivalent');
    expect(result.verification.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verification.targetA).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    expect(result.verification.targetB).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(result.executionA.purpose).toBe('hot-swap-verification');
    expect(result.executionB.purpose).toBe('hot-swap-verification');
    expect(result.executionA.provider).toBe('openai');
    expect(result.executionB.provider).toBe('anthropic');
    expect(result.executionA.status).toBe('completed');
    expect(result.executionB.status).toBe('completed');
    // ONE authority decision gated BOTH sides of the swap.
    expect(result.executionA.policy!.actionRequestId).toBe(
      result.executionB.policy!.actionRequestId,
    );

    // The business layer derives the SAME finding from both sides.
    const findingA = deriveTriageFinding(
      { conversationId: 'conv-w048-verify', transcriptExcerpt: SWEEP_EXCERPT },
      result.executionA,
    );
    const findingB = deriveTriageFinding(
      { conversationId: 'conv-w048-verify', transcriptExcerpt: SWEEP_EXCERPT },
      result.executionB,
    );
    expect(semantic(findingA)).toEqual(semantic(findingB));

    // The verification record is retrievable evidence; foreign tenants
    // cannot see it.
    const fetched = await getHotSwapVerification(ctx, { verificationId: result.verification.id });
    expect(fetched.id).toBe(result.verification.id);
    await expectLlmError('verification_not_found', () =>
      getHotSwapVerification(member(tenantOther), { verificationId: result.verification.id }),
    );
  });

  it('binds the request digest to the canonical request, not to the targets', async () => {
    const admin = llmAdmin(tenantVerify);
    const ctx = member(tenantVerify);
    const openai = await registerLlmAccount(admin, 'openai', 'digest-a', 0);
    const anthropic = await registerLlmAccount(admin, 'anthropic', 'digest-b', 1);
    const google = await registerLlmAccount(admin, 'google', 'digest-c', 2);
    const mistral = await registerLlmAccount(admin, 'mistral', 'digest-d', 3);
    for (const provider of ['openai', 'anthropic', 'google', 'mistral']) {
      llmTransport.serve(provider, { text: CANONICAL_TRIAGE_TEXT });
    }

    const first = await verifyProviderHotSwap(ctx, {
      ...VERIFY_REQUEST,
      targetA: { accountId: openai.id, model: 'gpt-4o' },
      targetB: { accountId: anthropic.id, model: 'claude-sonnet-4-5' },
    });
    // Same canonical request, DIFFERENT target pair → same digest: the
    // persisted proof binds "the same semantic request", not the targets.
    const second = await verifyProviderHotSwap(ctx, {
      ...VERIFY_REQUEST,
      targetA: { accountId: google.id, model: 'gemini-2.5-pro' },
      targetB: { accountId: mistral.id, model: 'mistral-large-latest' },
    });
    expect(second.verification.requestDigest).toBe(first.verification.requestDigest);
    expect(second.verification.outcome).toBe('equivalent');

    // A different canonical request must digest differently.
    const third = await verifyProviderHotSwap(ctx, {
      ...VERIFY_REQUEST,
      messages: [
        ...VERIFY_REQUEST.messages,
        { role: 'user' as const, content: 'Also check the billing address.' },
      ],
      targetA: { accountId: google.id, model: 'gemini-2.5-pro' },
      targetB: { accountId: mistral.id, model: 'mistral-large-latest' },
    });
    expect(third.verification.requestDigest).not.toBe(first.verification.requestDigest);
  });

  it("reports 'completed-divergent' without failing — semantic judgment stays with the caller", async () => {
    const admin = llmAdmin(tenantVerify);
    const ctx = member(tenantVerify);
    const openai = await registerLlmAccount(admin, 'openai', 'divergent-a', 0);
    const google = await registerLlmAccount(admin, 'google', 'divergent-b', 1);
    llmTransport.serve('openai', { text: CANONICAL_TRIAGE_TEXT });
    llmTransport.serve('google', { text: DIVERGENT_TRIAGE_TEXT });

    const result = await verifyProviderHotSwap(ctx, {
      ...VERIFY_REQUEST,
      targetA: { accountId: openai.id, model: 'gpt-4o' },
      targetB: { accountId: google.id, model: 'gemini-2.5-pro' },
    });

    expect(result.verification.outcome).toBe('completed-divergent');
    expect(result.executionA.status).toBe('completed');
    expect(result.executionB.status).toBe('completed');

    // The caller keeps the semantic judgment: the two sides of the swap
    // genuinely answered differently at the business level.
    const findingA = deriveTriageFinding(
      { conversationId: 'conv-w048-divergent', transcriptExcerpt: SWEEP_EXCERPT },
      result.executionA,
    );
    const findingB = deriveTriageFinding(
      { conversationId: 'conv-w048-divergent', transcriptExcerpt: SWEEP_EXCERPT },
      result.executionB,
    );
    expect(semantic(findingA)).not.toEqual(semantic(findingB));
    expect(findingA.priority).toBe('high');
    expect(findingB.priority).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// Clause 2 — the same agent contract through every runtime adapter
// ---------------------------------------------------------------------------

describe('W048 — one agent contract through every runtime adapter', () => {
  it('executes the same delegation through all runtimes with identical outcomes', async () => {
    const admin = agentsAdmin(tenantAgentSweep);
    const ctx = member(tenantAgentSweep);
    // GOVERNANCE minimum: at least two runtime adapters where available —
    // the agents module ships five.
    expect(AGENT_RUNTIME_PROVIDERS.length).toBeGreaterThanOrEqual(2);

    const outcomes: DelegationOutcome[] = [];
    const byRuntime = new Map<
      string,
      { outcome: DelegationOutcome; execution: AgentExecution; providerTaskId: string }
    >();

    // The SAME business function, the SAME task semantics — only the
    // tenant's agent binding (which runtime the definition points at)
    // changes between iterations.
    for (const runtime of AGENT_RUNTIME_PROVIDERS) {
      agentTransport.serve(runtime, { output: AGENT_VERDICT, summary: AGENT_SUMMARY });
      const agent = await registerTriageAgent(admin, runtime, `triage-${runtime}`);
      const outcome = await delegateTriageToAgent(agentGateway, ctx, {
        agentId: agent.id,
        conversationId: AGENT_CONVERSATION_ID,
        goal: 'draft a reply for review',
        correlationId: AGENT_CORRELATION_ID,
      });
      outcomes.push(outcome);
      const execution = await getAgentExecution(ctx, {
        executionId: outcome.evidenceExecutionId,
      });
      const attempts = await listAgentExecutionAttempts(ctx, { executionId: execution.id });
      byRuntime.set(runtime, {
        outcome,
        execution,
        providerTaskId: attempts[0]?.providerTaskId ?? '',
      });
    }

    // (a) Identical domain outcomes through every runtime.
    for (const outcome of outcomes) {
      expect(semantic(outcome)).toEqual(semantic(outcomes[0]!));
    }
    expect(outcomes[0]!.status).toBe('succeeded');
    expect(outcomes[0]!.triaged).toBe(true);
    expect(outcomes[0]!.category).toBe('billing');
    expect(outcomes[0]!.needsHuman).toBe(false);
    expect(outcomes[0]!.summary).toBe(AGENT_SUMMARY);
    expect(outcomes[0]!.attempts).toBe(1);

    // (b) Each runtime normalized its native payload to the SAME canonical
    //     result; the swap is visible only as provider evidence.
    for (const runtime of AGENT_RUNTIME_PROVIDERS) {
      const entry = byRuntime.get(runtime)!;
      expect(entry.execution.provider).toBe(runtime);
      expect(entry.execution.status).toBe('succeeded');
      expect(entry.execution.authorityLevel).toBe('ANALYZE');
      expect(entry.execution.result).toEqual({ output: AGENT_VERDICT, summary: AGENT_SUMMARY });
      expect(entry.execution.costCurrency).toBe('USD');
      expect(entry.execution.costMinor).toBeGreaterThan(0);
      expect(entry.providerTaskId).not.toBe('');
    }
    expect(
      new Set(AGENT_RUNTIME_PROVIDERS.map((runtime) => byRuntime.get(runtime)!.providerTaskId))
        .size,
    ).toBe(AGENT_RUNTIME_PROVIDERS.length);

    // (c) Each runtime received ITS OWN native wire dialect for the same
    //     canonical task.
    for (const runtime of AGENT_RUNTIME_PROVIDERS) {
      assertAgentRuntimeDialect(lastAgentRequestFor(runtime), runtime);
    }
    expect(agentTransport.requests).toHaveLength(AGENT_RUNTIME_PROVIDERS.length);

    // (d) The trace surface correlates the whole sweep.
    const correlated = await listAgentExecutions(ctx, { correlationId: AGENT_CORRELATION_ID });
    expect(correlated).toHaveLength(AGENT_RUNTIME_PROVIDERS.length);
    expect(new Set(correlated.map((execution) => execution.provider))).toEqual(
      new Set([...AGENT_RUNTIME_PROVIDERS]),
    );
  });

  it('keeps the async lifecycle identical across runtimes (submit records, pump dispatches)', async () => {
    const admin = agentsAdmin(tenantAgentSweep);
    const ctx = member(tenantAgentSweep);
    const runtimes: AgentRuntimeProvider[] = ['langgraph', 'crewai'];
    for (const runtime of runtimes) {
      agentTransport.serve(runtime, { output: AGENT_VERDICT, summary: AGENT_SUMMARY });
      const agent = await registerTriageAgent(admin, runtime, `lifecycle-${runtime}`);
      const submitted = await submitAgentExecution(ctx, {
        agentId: agent.id,
        task: {
          conversationId: 'conv-w048-lifecycle',
          goal: 'draft a reply for review',
          kind: 'conversation-triage',
        },
        requestedPermissions: ['observe', 'analyze'],
      });
      // Submission is asynchronous: it records and returns without
      // dispatching — identical semantics on every runtime.
      expect(submitted.status).toBe('queued');
      expect(submitted.provider).toBe(runtime);
      expect(submitted.attemptsCount).toBe(0);
      expect(
        agentTransport.requests.filter((request) => request.provider === runtime),
      ).toHaveLength(0);

      const run = await runAgentExecution(ctx, { executionId: submitted.id });
      expect(run.status).toBe('succeeded');
      expect(run.attemptsCount).toBe(1);
      expect(run.result).toEqual({ output: AGENT_VERDICT, summary: AGENT_SUMMARY });
      expect(
        agentTransport.requests.filter((request) => request.provider === runtime),
      ).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Clause 3 — domain semantics and persisted authoritative state unchanged
// ---------------------------------------------------------------------------

describe('W048 — persisted authoritative state is untouched by provider swaps', () => {
  it('an LLM provider swap appends evidence rows and changes nothing else', async () => {
    const admin = llmAdmin(tenantState);
    const ctx = member(tenantState);
    const openai = await registerLlmAccount(admin, 'openai', 'state-a', 0);
    const anthropic = await registerLlmAccount(admin, 'anthropic', 'state-b', 1);
    llmTransport.serve('openai', { text: CANONICAL_TRIAGE_TEXT });
    llmTransport.serve('anthropic', { text: CANONICAL_TRIAGE_TEXT });

    const businessInput = {
      conversationId: 'conv-w048-state',
      transcriptExcerpt: SWEEP_EXCERPT,
    };

    const before = await snapshotPublicTables();
    const viaOpenai = await triageConversationFinding(llmGateway, ctx, {
      ...businessInput,
      routing: { pinnedAccountId: openai.id, pinnedModel: 'gpt-4o' },
    });
    const executionOpenai = await getLlmExecution(ctx, {
      executionId: viaOpenai.evidenceExecutionId,
    });
    const mid = await snapshotPublicTables();
    const viaAnthropic = await triageConversationFinding(llmGateway, ctx, {
      ...businessInput,
      routing: { pinnedAccountId: anthropic.id, pinnedModel: 'claude-sonnet-4-5' },
    });
    const after = await snapshotPublicTables();

    // The same business semantics through both providers.
    expect(semantic(viaAnthropic)).toEqual(semantic(viaOpenai));
    expect(viaAnthropic.evidenceExecutionId).not.toBe(viaOpenai.evidenceExecutionId);

    // ONLY the gateway's append-only evidence grew — one execution row and
    // its one authority-gate decision pair (action request + policy
    // approval decision) per run.
    expect(changedTables(before, mid)).toEqual([
      'action_approval_decisions',
      'action_requests',
      'llm_executions',
    ]);
    expect(changedTables(mid, after)).toEqual([
      'action_approval_decisions',
      'action_requests',
      'llm_executions',
    ]);
    expect(mid.rows('llm_executions') - before.rows('llm_executions')).toBe(1);
    expect(mid.rows('action_requests') - before.rows('action_requests')).toBe(1);
    expect(mid.rows('action_approval_decisions') - before.rows('action_approval_decisions')).toBe(
      1,
    );
    expect(after.rows('llm_executions') - mid.rows('llm_executions')).toBe(1);

    // No table was created or dropped — a provider swap is not a semantic
    // migration; the whole domain schema stayed byte-identical.
    expect(mid.tableNames()).toEqual(before.tableNames());
    expect(after.tableNames()).toEqual(before.tableNames());
    expect(before.tableNames().length).toBeGreaterThanOrEqual(80);

    // The first run's evidence row is untouched by the second run
    // (append-only discipline end-to-end).
    const reread = await getLlmExecution(ctx, { executionId: viaOpenai.evidenceExecutionId });
    expect(reread).toEqual(executionOpenai);
  });

  it('an agent runtime swap appends evidence rows and changes nothing else', async () => {
    const admin = agentsAdmin(tenantState);
    const ctx = member(tenantState);
    const langgraphAgent = await registerTriageAgent(admin, 'langgraph', 'state-langgraph');
    const crewaiAgent = await registerTriageAgent(admin, 'crewai', 'state-crewai');
    agentTransport.serve('langgraph', { output: AGENT_VERDICT, summary: AGENT_SUMMARY });
    agentTransport.serve('crewai', { output: AGENT_VERDICT, summary: AGENT_SUMMARY });

    const businessInput = {
      conversationId: 'conv-w048-agent-state',
      goal: 'draft a reply for review',
    };

    const before = await snapshotPublicTables();
    const viaLanggraph = await delegateTriageToAgent(agentGateway, ctx, {
      ...businessInput,
      agentId: langgraphAgent.id,
    });
    const executionLanggraph = await getAgentExecution(ctx, {
      executionId: viaLanggraph.evidenceExecutionId,
    });
    const mid = await snapshotPublicTables();
    const viaCrewai = await delegateTriageToAgent(agentGateway, ctx, {
      ...businessInput,
      agentId: crewaiAgent.id,
    });
    const after = await snapshotPublicTables();

    // The same business semantics through both runtimes.
    expect(semantic(viaCrewai)).toEqual(semantic(viaLanggraph));

    // ONLY the gateway's append-only evidence grew — one execution, one
    // attempt and one authority-gate decision pair per delegation.
    expect(changedTables(before, mid)).toEqual([
      'action_approval_decisions',
      'action_requests',
      'agent_execution_attempts',
      'agent_executions',
    ]);
    expect(changedTables(mid, after)).toEqual([
      'action_approval_decisions',
      'action_requests',
      'agent_execution_attempts',
      'agent_executions',
    ]);
    expect(
      mid.rows('action_approval_decisions') - before.rows('action_approval_decisions'),
    ).toBe(1);
    expect(mid.rows('agent_executions') - before.rows('agent_executions')).toBe(1);
    expect(mid.rows('agent_execution_attempts') - before.rows('agent_execution_attempts')).toBe(1);

    // No table was created or dropped; the domain schema stayed identical.
    expect(mid.tableNames()).toEqual(before.tableNames());
    expect(after.tableNames()).toEqual(before.tableNames());

    // The first runtime's execution record is untouched by the second.
    const reread = await getAgentExecution(ctx, {
      executionId: viaLanggraph.evidenceExecutionId,
    });
    expect(reread).toEqual(executionLanggraph);
  });
});

// ---------------------------------------------------------------------------
// The harness itself — boundary discipline as objective evidence
// ---------------------------------------------------------------------------

describe('W048 — the verification harness obeys the boundary', () => {
  const OWN_DIR = path.dirname(fileURLToPath(import.meta.url));

  it('imports other modules only through their contracts', async () => {
    const files = (await readdir(OWN_DIR)).filter((file) => file.endsWith('.ts')).sort();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = await readFile(path.join(OWN_DIR, file), 'utf8');
      const specifiers = [...source.matchAll(/['"](@\/modules\/[^'"]+)['"]/g)].map(
        (match) => match[1]!,
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).toMatch(/^@\/modules\/[a-z0-9-]+\/contract$/);
      }
    }
  });

  it('the business capability fixture is provider-agnostic and persistence-free', async () => {
    const source = await readFile(path.join(OWN_DIR, 'capability.ts'), 'utf8');
    // No provider/model/runtime vocabulary may appear in the business code
    // — the strongest structural form of "no business code rewrite".
    expect(source).not.toMatch(
      /openai|anthropic|google|gemini|mistral|cohere|deepseek|groq|gpt-|claude|command-r|llama|langgraph|crewai|autogen|semantic-kernel/i,
    );
    // And it never touches persistence or provider drivers directly.
    expect(source).not.toContain('@/infra/db');
    expect(source).not.toMatch(/['"]pg['"]|pglite|ioredis/);
    // Its module coupling is type-only (the contract seam).
    for (const match of source.matchAll(/^import (type )?\{[^}]*\} from '(@\/modules\/[^']+)';/gm)) {
      expect(match[1]).toBe('type ');
    }
  });
});
