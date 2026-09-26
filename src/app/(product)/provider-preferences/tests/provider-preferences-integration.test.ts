// Integration tests for the provider-choice product surface (W091) against
// the embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE ACCEPTANCE CORE, end to end through the provider-preferences
// module's REAL contract and the surface's own view builder + action
// dispatcher (no Next.js boot — the pure halves the server actions run):
//
//   * THE MEMBER VIEW (central W091 probe) — a plain member sees the
//     whole default surface with NO provider jargon even though the
//     tenant's accounts and the seeded execution carry provider + model
//     names; the technical layer is absent (advanced === null);
//   * THE ADMIN VIEW — the technical layer IS present (the reveal is the
//     point): both accounts in routing order with positions 1..2;
//   * ACTION FLOWS — a member's save lands in the honest
//     requiresAdministrator state; an administrator's save auto-applies
//     (the account priorities flip through the llm contract); members
//     cannot override or apply; an administrator's override writes
//     through the llm contract's own input;
//   * THE EXPLANATION — rendered from the FROZEN snapshot of the seeded
//     execution: plain lines jargon-free, the technical block carrying
//     the real provider;
//   * TENANT ISOLATION — tenant B sees none of tenant A's profile,
//     events or executions, and cannot act on A's account ids (uniform
//     account_not_found — no existence leak).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import {
  DATA_CLASSIFICATIONS,
  LLM_CAPABILITIES,
  LLM_PROVIDERS,
  LLM_SCOPES,
  invokeLlm,
  listAiProviderAccounts,
  listLlmModels,
  registerAiProviderAccount,
  setLlmTransport,
} from '@/modules/llm/contract';
import type { AiProviderAccount } from '@/modules/llm/contract';
import { RecordingLlmTransport } from '../../../../../tests/provider-hotswap/fakes';
import {
  ProviderPreferencesError,
  allExplanationLines,
  explainRoutingDecision,
} from '@/modules/provider-preferences/contract';

import { buildProviderPreferencesView } from '../lib/views';
import { executeProviderPreferencesAction, parseActionBody } from '../lib/actions';
import type { ParsedActionInput } from '../lib/actions';
import { PREFERENCE_OPTIONS_COPY } from '../lib/labels';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['llm:administer'] };
}

async function expectProviderPreferencesError(
  code: ProviderPreferencesError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ProviderPreferencesError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderPreferencesError);
    expect((error as ProviderPreferencesError).code).toBe(code);
  }
}

/** Parse (unit-tested) then execute — the exact pair the server actions run. */
async function runAction(
  ctx: TenantContext,
  body: Record<string, unknown>,
): Promise<{ action: string; summary: string; result: unknown }> {
  const parsed = parseActionBody(body);
  if (!parsed.ok) {
    throw new Error(`unexpected parse failure: ${parsed.error}`);
  }
  return executeProviderPreferencesAction(ctx, parsed.value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// The jargon vocabulary (the llm contract's machine words — the member
// view's DEFAULT fields must never render any of them).
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

const JARGON_TOKENS: readonly string[] = [
  ...LLM_PROVIDERS,
  ...LLM_PROVIDERS.flatMap((provider) => listLlmModels(provider).map((model) => model.modelId)),
  ...LLM_CAPABILITIES,
  ...LLM_SCOPES,
  ...DATA_CLASSIFICATIONS,
  ...REJECTION_REASONS,
  'maxDataClassification',
  'llm',
  'byoa',
];

function expectJargonFree(rendered: string): void {
  const haystack = rendered.toLowerCase();
  for (const token of JARGON_TOKENS) {
    expect(haystack).not.toContain(token.toLowerCase());
  }
}

const db = getDb();

let tenantA = '';
let tenantB = '';
let openaiAccountId = '';
let anthropicAccountId = '';
let memberA: TenantContext;
let adminA: TenantContext;
let adminB: TenantContext;
let transport: RecordingLlmTransport;

beforeAll(async () => {
  await runMigrations(db);

  tenantA = newId();
  tenantB = newId();
  memberA = member(tenantA);
  adminA = admin(tenantA);
  adminB = admin(tenantB);

  // Two tenant-A accounts with opposite data-policy ceilings and the
  // openai account first in the configured order (priority 10 < 20).
  const openai = await registerAiProviderAccount(adminA, {
    provider: 'openai',
    label: 'Primary workspace key',
    credentialRef: 'secret-store://byoa/openai/primary',
    scopes: ['cognition', 'conversation', 'analysis', 'background'],
    capabilities: ['text-generation', 'embedding'],
    maxDataClassification: 'restricted',
    priority: 10,
  });
  const anthropic = await registerAiProviderAccount(adminA, {
    provider: 'anthropic',
    label: 'Backup reasoning account',
    credentialRef: 'secret-store://byoa/anthropic/backup',
    scopes: ['cognition', 'conversation', 'analysis', 'background'],
    capabilities: ['text-generation'],
    maxDataClassification: 'public',
    priority: 20,
  });
  openaiAccountId = openai.account.id;
  anthropicAccountId = anthropic.account.id;

  // One REAL execution through the gateway (a recording transport speaks
  // the addressee's native dialect): with classification 'internal' the
  // public-ceiling account is rejected by the data policy and the
  // restricted-ceiling account is chosen — a frozen snapshot with real
  // provider + model names to explain.
  transport = new RecordingLlmTransport();
  transport.serve('openai', { text: 'ready' });
  setLlmTransport(transport);
  const execution = await invokeLlm(memberA, {
    capability: 'text-generation',
    scope: 'cognition',
    dataClassification: 'internal',
    messages: [{ role: 'user', content: 'Is the gateway provider-neutral?' }],
    temperature: 0,
    maxOutputTokens: 16,
  });
  expect(execution.status).toBe('completed');
  expect(execution.provider).toBe('openai');
});

afterAll(async () => {
  setLlmTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// The member view — the central W091 probe
// ---------------------------------------------------------------------------

describe('member view — outcomes only, no jargon, no technical layer', () => {
  it('renders the honest default state with zero technical data', async () => {
    const view = await buildProviderPreferencesView(memberA);
    expect(view.degraded).toEqual([]);
    expect(view.canAdminister).toBe(false);
    expect(view.advanced).toBeNull();
    expect(view.saved).toBe(false);
    expect(view.preference).toBe('balanced');
    expect(view.pendingApplication).toBe(false);
    expect(view.mappings).toEqual([]);
    expect(view.history).toEqual([]);
    expect(view.changeEventCount).toBe(0);
  });

  it('carries NO provider jargon in the default fields (the accounts and execution do)', async () => {
    const view = await buildProviderPreferencesView(memberA);
    expect(view.advanced).toBeNull();

    // The tenant's own accounts DO carry provider names (the point of the
    // probe: the member view must not leak them into its default fields).
    const accounts: AiProviderAccount[] = await listAiProviderAccounts(adminA, {});
    expect(JSON.stringify(accounts)).toContain('openai');
    expect(JSON.stringify(accounts)).toContain('anthropic');

    const explanation =
      view.explanation !== null && view.explanation.found ? view.explanation : null;
    expect(explanation).not.toBeNull();

    const defaultSurface = JSON.stringify({
      options: PREFERENCE_OPTIONS_COPY,
      mappingNotes: view.mappingNotes,
      bases: view.mappings.map((mapping) => mapping.basis),
      preferenceLine: explanation?.preferenceLine ?? null,
      explanationLines: explanation === null ? [] : allExplanationLines(explanation.explanation),
      historySummaries: view.history
        .filter((row) => !row.technical)
        .map((row) => row.summary),
      historyLabels: view.history.map((row) => row.eventLabel),
    });
    expectJargonFree(defaultSurface);
  });
});

// ---------------------------------------------------------------------------
// The admin view — the technical reveal is the point
// ---------------------------------------------------------------------------

describe('admin view — the technical layer, authorized', () => {
  it('exposes both accounts in routing order with positions 1..2', async () => {
    const view = await buildProviderPreferencesView(adminA);
    expect(view.degraded).toEqual([]);
    expect(view.canAdminister).toBe(true);
    expect(view.advanced).not.toBeNull();
    const accounts = view.advanced?.accounts ?? [];
    expect(accounts).toHaveLength(2);
    expect([...accounts.map((account) => account.routingPosition)].sort((left, right) => left - right)).toEqual([1, 2]);
    const providers = accounts.map((account) => account.provider);
    expect(providers).toContain('openai');
    expect(providers).toContain('anthropic');
    // The configured order: openai (priority 10) routes first.
    expect(accounts[0]!.provider).toBe('openai');
    expect(accounts[0]!.priority).toBe(10);
    expect(accounts[1]!.provider).toBe('anthropic');
    expect(accounts[1]!.priority).toBe(20);
    // Provider names ARE present here — the authorized reveal.
    expect(JSON.stringify(view.advanced)).toContain('openai');
    expect(JSON.stringify(view.advanced)).toContain('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Action flows (the exact parse + execute pair the server actions run)
// ---------------------------------------------------------------------------

describe('action flows — member saves, admin applies, override is claim-gated', () => {
  it("a member's save lands in the honest requiresAdministrator state", async () => {
    const outcome = await runAction(memberA, {
      action: 'preference.save',
      preference: 'privacy-first',
      note: 'compliance asked for the strictest options first',
    });
    expect(outcome.action).toBe('preference.save');
    const result = asRecord(outcome.result);
    expect(result['requiresAdministrator']).toBe(true);
    expect(result['applied']).toBe(false);
    expect(result['written']).toBe(0);
    expect(outcome.summary).toContain('administrator');
    expectJargonFree(outcome.summary);
  });

  it("the member's saved choice renders jargon-free with a pending application", async () => {
    const view = await buildProviderPreferencesView(memberA);
    expect(view.saved).toBe(true);
    expect(view.preference).toBe('privacy-first');
    expect(view.pendingApplication).toBe(true);
    expect(view.appliedPreference).toBeNull();
    expect(view.note).toBe('compliance asked for the strictest options first');
    expect(view.changeEventCount).toBe(1);
    expect(view.history).toHaveLength(1);
    expect(view.history[0]!.eventLabel).toBe('Choice saved');
    expect(view.history[0]!.technical).toBe(false);
    // The populated default fields stay jargon-free (mapping guidance,
    // history summaries, explanation lines).
    const explanation =
      view.explanation !== null && view.explanation.found ? view.explanation : null;
    const defaultSurface = JSON.stringify({
      mappingNotes: view.mappingNotes,
      bases: view.mappings.map((mapping) => mapping.basis),
      preferenceLine: explanation?.preferenceLine ?? null,
      explanationLines: explanation === null ? [] : allExplanationLines(explanation.explanation),
      historySummaries: view.history
        .filter((row) => !row.technical)
        .map((row) => row.summary),
    });
    expectJargonFree(defaultSurface);
    expect(view.mappings).toHaveLength(2);
    expect(view.mappings.map((mapping) => mapping.position)).toEqual([1, 2]);
  });

  it("an administrator's save applies immediately — the priorities flip through the llm contract", async () => {
    const outcome = await runAction(adminA, {
      action: 'preference.save',
      preference: 'privacy-first',
    });
    const result = asRecord(outcome.result);
    expect(result['applied']).toBe(true);
    expect(result['requiresAdministrator']).toBe(false);
    expect(result['written']).toBe(2);

    // privacy-first re-sorts by the data-policy ceiling: the public
    // account now routes first, the restricted account second.
    const accounts = await listAiProviderAccounts(adminA, {});
    expect(accounts.map((account) => account.provider)).toEqual(['anthropic', 'openai']);
    expect(accounts.map((account) => account.priority)).toEqual([10, 20]);
    expect(accounts.find((account) => account.id === anthropicAccountId)?.priority).toBe(10);
    expect(accounts.find((account) => account.id === openaiAccountId)?.priority).toBe(20);

    const view = await buildProviderPreferencesView(memberA);
    expect(view.pendingApplication).toBe(false);
    expect(view.appliedPreference).toBe('privacy-first');
    expect(view.appliedAt).not.toBeNull();
  });

  it('members cannot override and cannot apply (typed unauthorized errors)', async () => {
    await expectProviderPreferencesError('unauthorized', () =>
      executeProviderPreferencesAction(memberA, {
        action: 'override.update',
        accountId: openaiAccountId,
        priority: 33,
        status: null,
      } satisfies ParsedActionInput),
    );
    await expectProviderPreferencesError('unauthorized', () =>
      executeProviderPreferencesAction(memberA, { action: 'preference.apply' }),
    );
  });

  it("an administrator's override writes through the llm contract's own input", async () => {
    const outcome = await runAction(adminA, {
      action: 'override.update',
      accountId: openaiAccountId,
      priority: 33,
    });
    expect(outcome.action).toBe('override.update');
    const result = asRecord(outcome.result);
    expect(result['priority']).toBe(33);
    expect(typeof result['label']).toBe('string');

    const accounts = await listAiProviderAccounts(adminA, {});
    expect(accounts.find((account) => account.id === openaiAccountId)?.priority).toBe(33);

    // The override lands in the audit as a technical event — the member
    // view labels it but never renders its summary.
    const view = await buildProviderPreferencesView(memberA);
    const technical = view.history.filter((row) => row.technical);
    expect(technical).toHaveLength(1);
    expect(technical[0]!.eventLabel).toBe('Technical change');
    expectJargonFree(JSON.stringify(technical.map((row) => row.eventLabel)));
  });
});

// ---------------------------------------------------------------------------
// The explanation surface (frozen snapshot of the seeded execution)
// ---------------------------------------------------------------------------

describe('the explanation — plain for everyone, technical for the authorized', () => {
  it('explains the latest AI task from its frozen routing snapshot', async () => {
    const view = await buildProviderPreferencesView(memberA);
    expect(view.explanation).not.toBeNull();
    const explanation = view.explanation!;
    expect(explanation.found).toBe(true);
    if (!explanation.found) return;

    expect(explanation.executionId).not.toBe('');
    expect(explanation.status).toBe('completed');
    expect(explanation.explanation.chosen).not.toBeNull();
    // One rejected line per (account, model) candidate that was not chosen:
    // the other chosen-account models ranked lower, and every model of the
    // public-ceiling account rejected by the data policy.
    expect(explanation.explanation.rejected.length).toBeGreaterThan(0);
    expect(
      explanation.explanation.rejected.some((line) => line.text.includes('data policy')),
    ).toBe(true);
    expectJargonFree(explanation.preferenceLine);
    expectJargonFree(JSON.stringify(allExplanationLines(explanation.explanation)));

    // The technical block carries the real provider (the authorized view
    // renders it; the member view never does).
    expect(explanation.technical.chosen).not.toBeNull();
    expect(LLM_PROVIDERS).toContain(explanation.technical.chosen!.provider);
    expect(explanation.technical.chosen!.provider).toBe('openai');
    expect(explanation.technical.candidates.length).toBeGreaterThanOrEqual(2);
    expect(
      explanation.technical.candidates.some(
        (candidate) => !candidate.eligible && candidate.reason === 'data_classification_exceeds_account_policy',
      ),
    ).toBe(true);
  });

  it('answers honestly for an execution address that does not exist', async () => {
    const missing = await explainRoutingDecision(memberA, { executionId: newId() });
    expect(missing.found).toBe(false);
    if (!missing.found) {
      expect(missing.reason).toBe('execution-not-found');
      expectJargonFree(missing.note);
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (uniform not-found — no existence leak)
// ---------------------------------------------------------------------------

describe('tenant isolation — tenant B sees nothing of tenant A', () => {
  it('renders an empty, honest default surface for a tenant-B member', async () => {
    const view = await buildProviderPreferencesView(member(tenantB));
    expect(view.canAdminister).toBe(false);
    expect(view.advanced).toBeNull();
    expect(view.saved).toBe(false);
    expect(view.history).toEqual([]);
    expect(view.changeEventCount).toBe(0);
    expect(view.explanation).not.toBeNull();
    const explanation = view.explanation!;
    expect(explanation.found).toBe(false);
    if (!explanation.found) {
      expect(explanation.reason).toBe('no-executions');
      expectJargonFree(explanation.note);
    }
    // No leakage of tenant A's preference state either.
    expect(view.preference).toBe('balanced');
    expect(view.pendingApplication).toBe(false);
  });

  it("rejects a tenant-B admin acting on tenant A's account id uniformly", async () => {
    await expectProviderPreferencesError('account_not_found', () =>
      executeProviderPreferencesAction(adminB, {
        action: 'override.update',
        accountId: openaiAccountId,
        priority: 44,
        status: null,
      } satisfies ParsedActionInput),
    );
  });
});
