// Integration tests for the AI-providers product surface (W066) against
// the embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE ACCEPTANCE CORE, end to end through the llm module's REAL contract
// and the surface's own API handlers (Journey H — configure AI):
//
//   * ADD / VERIFY / REVOKE — a tenant owner registers two BYOA accounts
//     through the POST API, connection-tests them (first unwired → the
//     honest provider_unavailable result; then through a recording
//     transport → verified with cost/latency evidence), revokes one
//     (routing stops, the record stays) and restores it;
//   * MODEL AVAILABILITY — manual holds/release change the view's
//     per-(account, model) states, automatic routing avoids held models,
//     and an explicit pin still overrides the hold (the documented
//     operator-instruction semantics);
//   * POLICY/ROUTING — priority changes reorder routing; scopes,
//     capabilities, classification and budget flow through account.update;
//   * COST/LATENCY — usage aggregates, budget posture and the append-only
//     execution evidence all agree with the contract reads;
//   * HOT-SWAP TEST — the same canonical request through two pinned
//     targets: equivalent, completed-divergent and failed outcomes, with
//     the verification record deep-linkable and tenant-scoped;
//   * THE AUTHORITY GATE — an ASK policy on 'llm-invocation' holds the
//     connection test at the human gate; approving it lets the SAME
//     idempotent retry proceed;
//   * TENANT ISOLATION — tenant B sees none of tenant A's accounts,
//     executions, usage or verifications, and cannot act on A's ids
//     (uniform not-found — no existence leak); a plain member (no
//     'llm:administer') reads but cannot manage.

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
  decideApproval,
  setAuthorityPolicy,
  ACTIONS_AUTHORITY_ADMINISTER,
} from '@/modules/actions/contract';
import { addTenantMember, provisionTenant } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import {
  getAiProviderAccount,
  getAiAvailability,
  invokeLlm,
  listLlmExecutions,
  setLlmTransport,
} from '@/modules/llm/contract';
import type { LlmTransport, LlmTransportReceipt, LlmTransportRequest } from '@/modules/llm/contract';
import { RecordingLlmTransport } from '../../../../../tests/provider-hotswap/fakes';

import { handleAiAction, handleAiGet } from '../lib/api';
import { buildByoaView } from '../lib/views';
import type { TestConnectionResult } from '../lib/actions';

/** The session cookie the AI-providers API resolves (lib/session). */
const SESSION_COOKIE = 'aurum_session';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function member(
  tenantId: string,
  authority: string[] = [],
  principalId: string = newId(),
): TenantContext {
  return { tenantId, principalId, authority };
}

interface AiFixture {
  tenantA: { id: string };
  tenantB: { id: string };
  ownerAToken: string;
  ownerBToken: string;
  memberAToken: string;
  memberAPrincipalId: string;
  ownerA: TenantContext;
  ownerB: TenantContext;
}

let fixture: AiFixture;
let transport: RecordingLlmTransport;

/** A request carrying one session cookie (the only scope source, W058). */
function request(path: string, token: string, init?: RequestInit): Request {
  return new Request(`https://aurum.test${path}`, {
    ...init,
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(init?.headers ?? {}) },
  });
}

async function registerSessionUser(label: string): Promise<{ principalId: string; token: string }> {
  const slug = label.toLowerCase().replaceAll(' ', '-');
  const email = [slug, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: label,
    email,
    password: ['ha', 'rbor', '-cr', 'ane-44'].join(''),
  });
  return { principalId: issued.session.principalId, token: issued.token };
}

beforeAll(async () => {
  await runMigrations(db);

  const platform = member(newId(), [ORGANIZATIONS_AUTHORITY_PROVISION]);

  const ownerA = await registerSessionUser('Northwind Owner');
  const ownerB = await registerSessionUser('Initech Owner');
  const plainMember = await registerSessionUser('Northwind Member');

  const tenantA = await provisionTenant(platform, {
    name: 'Northwind Traders',
    ownerPrincipalId: ownerA.principalId,
    defaultWorkspaceName: 'Company HQ',
  });
  const tenantB = await provisionTenant(platform, {
    name: 'Initech',
    ownerPrincipalId: ownerB.principalId,
  });

  // The plain member joins tenant A at the lowest role (no claims).
  await addTenantMember(member(tenantA.id, [], ownerA.principalId), {
    principalId: plainMember.principalId,
    role: 'member',
  });
  await selectCompany({ token: ownerA.token, tenantId: tenantA.id });
  await selectCompany({ token: plainMember.token, tenantId: tenantA.id });
  await selectCompany({ token: ownerB.token, tenantId: tenantB.id });

  fixture = {
    tenantA,
    tenantB,
    ownerAToken: ownerA.token,
    ownerBToken: ownerB.token,
    memberAToken: plainMember.token,
    memberAPrincipalId: plainMember.principalId,
    ownerA: member(tenantA.id, ['llm:administer', ACTIONS_AUTHORITY_ADMINISTER, 'actions:approve'], ownerA.principalId),
    ownerB: member(tenantB.id, ['llm:administer'], ownerB.principalId),
  };

  transport = new RecordingLlmTransport();
});

afterAll(async () => {
  setLlmTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Envelope {
  surface?: string;
  tenantId?: string;
  view?: {
    canAdminister?: boolean;
    transportWired?: boolean;
    accounts?: {
      id: string;
      provider: string;
      label: string;
      status: string;
      priority: number;
      routingPosition: number;
      budgetMinor: number | null;
      spend?: { spendMinor: number; executions: number } | null;
      models?: {
        modelId: string;
        usableCapabilities: string[];
        availability?: { state: string; source: string } | null;
      }[];
    }[];
    usage?: { provider: string; model: string; executions: number; costMinor: number }[];
    executions?: { id: string; purpose: string; status: string }[];
    hotSwapExecutions?: { id: string }[];
    catalog?: { provider: string }[];
    degraded?: string[];
  };
  verification?: unknown;
  action?: string;
  summary?: string;
  result?: unknown;
  error?: string;
  message?: string;
}

async function getView(token: string, query = ''): Promise<{ status: number; body: Envelope }> {
  const result = await handleAiGet(request(`/api/product/ai${query}`, token));
  return { status: result.status, body: result.body as Envelope };
}

async function postAction(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Envelope }> {
  const result = await handleAiAction(
    request('/api/product/ai', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    body,
  );
  return { status: result.status, body: result.body as Envelope };
}

function asTestResult(result: unknown): TestConnectionResult {
  return result as TestConnectionResult;
}

/** The fragment-assembled opaque credential references (push-protection discipline). */
function credentialRef(provider: string, label: string): string {
  return [['secret', 'store'].join('-'), 'byoa', provider, label].join('/');
}

// ---------------------------------------------------------------------------
// Journey H — the whole flow through the surface's API
// ---------------------------------------------------------------------------

describe('Journey H — configure AI (add / verify / policy / cost / hot-swap)', () => {
  let openaiAccountId = '';
  let anthropicAccountId = '';

  it('starts honest: an empty, view-scoped surface with the registry catalog', async () => {
    const { status, body } = await getView(fixture.ownerAToken);
    expect(status).toBe(200);
    expect(body.surface).toBe('ai');
    expect(body.tenantId).toBe(fixture.tenantA.id);
    expect(body.view?.canAdminister).toBe(true);
    expect(body.view?.transportWired).toBe(false);
    expect(body.view?.accounts).toEqual([]);
    // The catalog is platform reference data — alphabetical, complete.
    const providers = (body.view?.catalog ?? []).map((entry) => entry.provider);
    expect(providers).toEqual([...providers].sort((left, right) => left.localeCompare(right)));
    expect(providers).toContain('openai');
    expect(providers).toContain('anthropic');
  });

  it('ADD: an owner registers two provider accounts through the API', async () => {
    const first = await postAction(fixture.ownerAToken, {
      action: 'account.register',
      provider: 'openai',
      label: 'Primary workspace key',
      credentialRef: credentialRef('openai', 'primary'),
      scopes: ['conversation', 'analysis', 'cognition'],
      capabilities: ['text-generation', 'embedding'],
      maxDataClassification: 'internal',
      priority: 100,
    });
    expect(first.status).toBe(200);
    expect(first.body.summary).toContain('Added openai account');
    openaiAccountId = (first.body.result as { account: { id: string } }).account.id;

    const second = await postAction(fixture.ownerAToken, {
      action: 'account.register',
      provider: 'anthropic',
      label: 'Backup reasoning account',
      credentialRef: credentialRef('anthropic', 'backup'),
      scopes: ['analysis', 'background'],
      capabilities: ['text-generation'],
      maxDataClassification: 'restricted',
      priority: 50,
      budgetMinor: 2_500,
    });
    expect(second.status).toBe(200);
    anthropicAccountId = (second.body.result as { account: { id: string } }).account.id;

    // Routing order: anthropic (priority 50) first, openai (100) second.
    const { body } = await getView(fixture.ownerAToken);
    const accounts = body.view?.accounts ?? [];
    expect(accounts.map((account) => account.provider)).toEqual(['anthropic', 'openai']);
    expect(accounts[0]!.routingPosition).toBe(1);
    expect(accounts[0]!.budgetMinor).toBe(2_500);
    // Per-model rows: openai carries 3 registry models, 2 usable (the
    // account permits text-generation AND embedding).
    const openai = accounts.find((account) => account.provider === 'openai')!;
    expect(openai.models).toHaveLength(3);
    expect(openai.models!.filter((model) => model.usableCapabilities.length > 0)).toHaveLength(3);
    const embeddingModel = openai.models!.find((model) => model.modelId === 'text-embedding-3-small')!;
    expect(embeddingModel.usableCapabilities).toEqual(['embedding']);
    // No availability events yet — every model reads available.
    expect(embeddingModel.availability).toBeNull();
  });

  it('VERIFY (the honest failure): with no transport wired the test reports provider_unavailable', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'account.test',
      accountId: openaiAccountId,
    });
    // A failed connection test is a RESULT, not an API error.
    expect(status).toBe(200);
    const result = asTestResult(body.result);
    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('provider_unavailable');
    expect(result.executionId).toBeNull();
    expect(result.note).toContain('No provider interaction completed');
  });

  it('VERIFY (the real path): through a wired transport the pinned invocation completes with evidence', async () => {
    transport.serve('openai', { text: 'ready' });
    transport.serve('anthropic', { text: 'ready' });
    setLlmTransport(transport);

    const { body } = await getView(fixture.ownerAToken);
    expect(body.view?.transportWired).toBe(true);

    const test = await postAction(fixture.ownerAToken, {
      action: 'account.test',
      accountId: openaiAccountId,
    });
    expect(test.status).toBe(200);
    const result = asTestResult(test.body.result);
    expect(result.outcome).toBe('verified');
    expect(result.provider).toBe('openai');
    expect(result.model).toMatch(/gpt-4o|text-embedding-3-small/);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.costMinor).toBeGreaterThanOrEqual(0);
    expect(result.executionId).not.toBeNull();

    // The execution is append-only evidence with the default policy gate.
    const executions = await listLlmExecutions(fixture.ownerA, { accountId: openaiAccountId, limit: 10 });
    const testExecution = executions.find((execution) => execution.id === result.executionId);
    expect(testExecution?.purpose).toBe('invocation');
    expect(testExecution?.status).toBe('completed');
    expect(testExecution?.policy?.outcome).toBe('allowed');
    expect(testExecution?.routing.pinned).toBe(true);
  });

  it('POLICY/ROUTING: priority updates reorder routing; budget/spend become visible', async () => {
    const update = await postAction(fixture.ownerAToken, {
      action: 'account.update',
      accountId: openaiAccountId,
      priority: 10,
    });
    expect(update.status).toBe(200);
    expect(update.body.summary).toContain('routing re-reads the new configuration');

    const { body } = await getView(fixture.ownerAToken);
    const accounts = body.view?.accounts ?? [];
    expect(accounts.map((account) => account.provider)).toEqual(['openai', 'anthropic']);
    // The verified test execution meters spend on the openai account.
    const openai = accounts.find((account) => account.provider === 'openai')!;
    expect(openai.spend!.executions).toBeGreaterThanOrEqual(1);
    // Usage aggregates now carry at least one openai row with cost.
    const usage = body.view?.usage ?? [];
    expect(usage.some((row) => row.provider === 'openai' && row.executions >= 1)).toBe(true);
  });

  it('MODEL AVAILABILITY: a manual hold excludes the model from AUTOMATIC routing (a pin still overrides)', async () => {
    const hold = await postAction(fixture.ownerAToken, {
      action: 'availability.set',
      accountId: openaiAccountId,
      model: 'gpt-4o-mini',
      state: 'unavailable',
      reason: 'provider incident',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    expect(hold.status).toBe(200);
    expect(hold.body.summary).toContain('Held openai gpt-4o-mini');

    // The view reflects the effective unavailable state.
    const availability = await getAiAvailability(fixture.ownerA, { accountId: openaiAccountId });
    const held = availability.find((entry) => entry.model === 'gpt-4o-mini');
    expect(held?.state).toBe('unavailable');
    expect(held?.source).toBe('manual');

    // UNPINNED production routing (the chat workflow's path) avoids the
    // held model: an unpinned invocation routes to openai gpt-4o, never
    // the held gpt-4o-mini.
    const unpinned = await invokeLlm(fixture.ownerA, {
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'public',
      messages: [{ role: 'user', content: 'production routing probe' }],
      maxOutputTokens: 16,
    });
    expect(unpinned.routing.pinned).toBe(false);
    expect(unpinned.model).toBe('gpt-4o');
    expect(unpinned.routing.candidates.find((candidate) => candidate.model === 'gpt-4o-mini')?.reason).toBe('unavailable');

    // An explicit pin is the documented operator override of the heuristic
    // (the surface's connection test pins by design — testing a held model
    // is sometimes exactly what an operator wants).
    const pinned = await postAction(fixture.ownerAToken, {
      action: 'account.test',
      accountId: openaiAccountId,
      model: 'gpt-4o-mini',
    });
    expect(asTestResult(pinned.body.result).outcome).toBe('verified');
    expect(asTestResult(pinned.body.result).model).toBe('gpt-4o-mini');

    // Release: the model returns to automatic routing.
    const release = await postAction(fixture.ownerAToken, {
      action: 'availability.set',
      accountId: openaiAccountId,
      model: 'gpt-4o-mini',
      state: 'available',
    });
    expect(release.status).toBe(200);
    const after = await getAiAvailability(fixture.ownerA, { accountId: openaiAccountId });
    expect(after.find((entry) => entry.model === 'gpt-4o-mini')?.state).toBe('available');
  });

  it('Holding every model of the first-priority account reroutes unpinned traffic to the next account', async () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small']) {
      await postAction(fixture.ownerAToken, {
        action: 'availability.set',
        accountId: openaiAccountId,
        model,
        state: 'unavailable',
      });
    }
    // Openai (priority 10) is fully held — the unpinned request falls
    // through to the anthropic account (priority 50), whose first registry
    // model is claude-sonnet-4-5.
    const rerouted = await invokeLlm(fixture.ownerA, {
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'public',
      messages: [{ role: 'user', content: 'rerouting probe' }],
      maxOutputTokens: 16,
    });
    expect(rerouted.provider).toBe('anthropic');
    expect(rerouted.model).toBe('claude-sonnet-4-5');
    // Release them again for the rest of the suite.
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small']) {
      await postAction(fixture.ownerAToken, {
        action: 'availability.set',
        accountId: openaiAccountId,
        model,
        state: 'available',
      });
    }
  });

  it('REVOKE: disabling stops routing (the test fails account_disabled) and the record stays', async () => {
    const revoke = await postAction(fixture.ownerAToken, {
      action: 'account.setStatus',
      accountId: openaiAccountId,
      status: 'disabled',
    });
    expect(revoke.status).toBe(200);
    expect(revoke.body.summary).toContain('Revoked openai account');

    const test = await postAction(fixture.ownerAToken, {
      action: 'account.test',
      accountId: openaiAccountId,
    });
    expect(asTestResult(test.body.result).outcome).toBe('failed');
    expect(asTestResult(test.body.result).errorCode).toBe('account_disabled');

    // The record (and its evidence) is retained, shown as revoked in the view.
    const account = await getAiProviderAccount(fixture.ownerA, { accountId: openaiAccountId });
    expect(account.status).toBe('disabled');
    const { body } = await getView(fixture.ownerAToken);
    const revoked = (body.view?.accounts ?? []).find((entry) => entry.id === openaiAccountId);
    expect(revoked?.status).toBe('disabled');

    // Restore for the hot-swap work below.
    const restore = await postAction(fixture.ownerAToken, {
      action: 'account.setStatus',
      accountId: openaiAccountId,
      status: 'active',
    });
    expect(restore.body.summary).toContain('Restored openai account');
  });

  it('HOT-SWAP (equivalent): the same request through openai and anthropic, deep-linkable record', async () => {
    const run = await postAction(fixture.ownerAToken, {
      action: 'hotswap.verify',
      targetA: { accountId: openaiAccountId, model: 'gpt-4o-mini' },
      targetB: { accountId: anthropicAccountId, model: 'claude-haiku-4-5' },
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'internal',
    });
    expect(run.status).toBe(200);
    expect(run.body.summary).toContain('openai/gpt-4o-mini ↔ anthropic/claude-haiku-4-5');
    const result = run.body.result as {
      status: string;
      verification: {
        id: string;
        outcome: string;
        requestDigest: string;
        executionAId: string;
        executionBId: string;
      };
      executionA: { status: string; provider: string; purpose: string };
      executionB: { status: string; provider: string; purpose: string };
    };
    expect(result.status).toBe('verified');
    expect(result.verification.outcome).toBe('equivalent');
    expect(result.executionA.provider).toBe('openai');
    expect(result.executionB.provider).toBe('anthropic');
    expect(result.executionA.purpose).toBe('hot-swap-verification');

    // The record is retrievable by id (the ?verification= deep link).
    const deep = await getView(fixture.ownerAToken, `?verification=${result.verification.id}`);
    expect(deep.status).toBe(200);
    expect(deep.body.verification).toMatchObject({ id: result.verification.id, outcome: 'equivalent' });

    // The evidence feed shows the two pinned verification executions.
    const { body } = await getView(fixture.ownerAToken);
    expect((body.view?.hotSwapExecutions ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('HOT-SWAP (divergent): differing canonical output still proves the swap', async () => {
    transport.serve('anthropic', { text: 'a different, but complete answer' });
    const run = await postAction(fixture.ownerAToken, {
      action: 'hotswap.verify',
      targetA: { accountId: openaiAccountId, model: 'gpt-4o-mini' },
      targetB: { accountId: anthropicAccountId, model: 'claude-haiku-4-5' },
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'internal',
    });
    const result = run.body.result as { verification: { outcome: string } };
    expect(result.verification.outcome).toBe('completed-divergent');
    transport.serve('anthropic', { text: 'ready' });
  });

  it('HOT-SWAP (failed): a failing target records the failure as evidence', async () => {
    // A transport wrapper that fails every anthropic call (transient).
    const failing: LlmTransport = {
      async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
        if (request.provider === 'anthropic') {
          return {
            status: 'failed',
            payload: null,
            providerExecutionId: null,
            detail: 'connection reset by peer (test fake)',
          };
        }
        return transport.send(request);
      },
    };
    setLlmTransport(failing);
    const run = await postAction(fixture.ownerAToken, {
      action: 'hotswap.verify',
      targetA: { accountId: openaiAccountId, model: 'gpt-4o-mini' },
      targetB: { accountId: anthropicAccountId, model: 'claude-haiku-4-5' },
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'internal',
    });
    const result = run.body.result as { verification: { outcome: string } };
    expect(result.verification.outcome).toBe('failed');
    // The failed anthropic execution is evidence, with an availability cooldown event.
    const anthropicExecutions = await listLlmExecutions(fixture.ownerA, {
      accountId: anthropicAccountId,
      purpose: 'hot-swap-verification',
      limit: 10,
    });
    expect(anthropicExecutions.some((execution) => execution.status === 'failed')).toBe(true);
    const availability = await getAiAvailability(fixture.ownerA, { accountId: anthropicAccountId });
    expect(availability.some((entry) => entry.state === 'unavailable' && entry.source === 'execution')).toBe(true);
    setLlmTransport(transport);
  });

  it('THE AUTHORITY GATE: an ASK policy holds the test at the human gate; approval lets the retry proceed', async () => {
    await setAuthorityPolicy(fixture.ownerA, {
      actionKind: 'llm-invocation',
      approvalLevels: ['ANALYZE'],
      note: 'every provider call is reviewed',
    });

    const gated = await postAction(fixture.ownerAToken, {
      action: 'account.test',
      accountId: anthropicAccountId,
      model: 'claude-haiku-4-5',
    });
    const result = asTestResult(gated.body.result);
    expect(result.outcome).toBe('awaiting-approval');
    expect(result.actionRequestId).not.toBeNull();
    expect(gated.body.summary).toContain('human approval');

    // The human decision (contract level — the Approvals surface's job).
    // Separation of duties: a DIFFERENT authorized principal decides.
    const approver = member(fixture.tenantA.id, ['actions:approve'], newId());
    const decision = await decideApproval(approver, {
      requestId: result.actionRequestId!,
      decision: 'approve',
      note: 'connection test approved',
    });
    expect(decision.status).toBe('approved');

    // The retry with the SAME deterministic key replays the SAME request
    // and proceeds through to the provider.
    const retry = await postAction(fixture.ownerAToken, {
      action: 'account.test',
      accountId: anthropicAccountId,
      model: 'claude-haiku-4-5',
    });
    const retried = asTestResult(retry.body.result);
    expect(retried.outcome).toBe('verified');
    expect(retried.model).toBe('claude-haiku-4-5');

    // Relax back so later flows route freely: a policy row that neither
    // forbids nor gates ANALYZE leaves it allowed (matrix precedence).
    await setAuthorityPolicy(fixture.ownerA, {
      actionKind: 'llm-invocation',
      approvalLevels: ['EXECUTE'],
      note: 'default posture restored',
    });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation and role boundaries
// ---------------------------------------------------------------------------

describe('tenant isolation and authority boundaries (ADR-0001 at the BYOA surface)', () => {
  let foreignAccountId = '';
  let foreignVerificationId = '';

  beforeAll(async () => {
    const created = await postAction(fixture.ownerAToken, {
      action: 'account.register',
      provider: 'mistral',
      label: 'Northwind mistral',
      credentialRef: credentialRef('mistral', 'northwind'),
      scopes: ['analysis'],
      capabilities: ['text-generation'],
      maxDataClassification: 'internal',
      priority: 500,
    });
    foreignAccountId = (created.body.result as { account: { id: string } }).account.id;
    const run = await postAction(fixture.ownerAToken, {
      action: 'hotswap.verify',
      targetA: { accountId: foreignAccountId, model: 'mistral-small-latest' },
      targetB: { accountId: foreignAccountId, model: 'mistral-large-latest' },
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'internal',
    });
    foreignVerificationId = (run.body.result as { verification: { id: string } }).verification.id;
  });

  it('tenant B sees none of tenant A’s accounts, usage, executions or verifications', async () => {
    const { status, body } = await getView(fixture.ownerBToken);
    expect(status).toBe(200);
    expect(body.tenantId).toBe(fixture.tenantB.id);
    expect(body.view?.accounts).toEqual([]);
    expect(body.view?.usage).toEqual([]);
    expect(body.view?.executions).toEqual([]);
    expect(body.view?.hotSwapExecutions).toEqual([]);
  });

  it('tenant B cannot test, update, revoke or hold tenant A’s account (uniform 404)', async () => {
    for (const body of [
      { action: 'account.test', accountId: foreignAccountId },
      { action: 'account.update', accountId: foreignAccountId, priority: 1 },
      { action: 'account.setStatus', accountId: foreignAccountId, status: 'disabled' },
      {
        action: 'availability.set',
        accountId: foreignAccountId,
        model: 'mistral-small-latest',
        state: 'unavailable',
      },
    ]) {
      const outcome = await postAction(fixture.ownerBToken, body);
      expect(outcome.status).toBe(404);
      expect(outcome.body.error).toBe('account_not_found');
    }
  });

  it('tenant B cannot use tenant A’s account as a hot-swap target, and cannot read A’s verification', async () => {
    const run = await postAction(fixture.ownerBToken, {
      action: 'hotswap.verify',
      targetA: { accountId: foreignAccountId, model: 'mistral-small-latest' },
      targetB: { accountId: foreignAccountId, model: 'mistral-large-latest' },
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'internal',
    });
    expect(run.status).toBe(404);
    expect(run.body.error).toBe('account_not_found');

    const deep = await getView(fixture.ownerBToken, `?verification=${foreignVerificationId}`);
    expect(deep.status).toBe(404);
    expect(deep.body.error).toBe('verification_not_found');
  });

  it('a plain member reads the surface but cannot manage (403, view-only)', async () => {
    const { status, body } = await getView(fixture.memberAToken);
    expect(status).toBe(200);
    expect(body.view?.canAdminister).toBe(false);
    expect((body.view?.accounts ?? []).length).toBeGreaterThan(0);

    const attempt = await postAction(fixture.memberAToken, {
      action: 'account.register',
      provider: 'groq',
      label: 'should not exist',
      credentialRef: credentialRef('groq', 'member'),
      scopes: ['analysis'],
      capabilities: ['text-generation'],
      maxDataClassification: 'internal',
      priority: 1,
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error).toBe('forbidden');

    const hold = await postAction(fixture.memberAToken, {
      action: 'availability.set',
      accountId: foreignAccountId,
      model: 'mistral-small-latest',
      state: 'unavailable',
    });
    expect(hold.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated / sessionless requests
// ---------------------------------------------------------------------------

describe('sessionless requests', () => {
  it('rejects anonymous GET and POST with 401 (no scope leak)', async () => {
    const get = await handleAiGet(new Request('https://aurum.test/api/product/ai'));
    expect(get.status).toBe(401);
    expect((get.body as { error: string }).error).toBe('unauthenticated');

    const post = await handleAiAction(
      new Request('https://aurum.test/api/product/ai', { method: 'POST' }),
      { action: 'account.test', accountId: 'irrelevant' },
    );
    expect(post.status).toBe(401);
    expect((post.body as { error: string }).error).toBe('unauthenticated');
  });

  it('rejects malformed bodies and malformed verification parameters', async () => {
    const badAction = await handleAiAction(
      request('/api/product/ai', fixture.ownerAToken, { method: 'POST' }),
      { action: 'selfdestruct' },
    );
    expect(badAction.status).toBe(400);
    expect((badAction.body as { error: string }).error).toBe('invalid_body');

    const badQuery = await getView(fixture.ownerAToken, '?verification=not-a-uuid');
    expect(badQuery.status).toBe(400);
    expect(badQuery.body.error).toBe('invalid_query');
  });
});

// ---------------------------------------------------------------------------
// The page's own view builder (the same read model the page renders)
// ---------------------------------------------------------------------------

describe('buildByoaView (the page read model)', () => {
  it('composes accounts in routing order with spend, usage, evidence and no degradation', async () => {
    const view = await buildByoaView(fixture.ownerA);
    expect(view.degraded).toEqual([]);
    expect(view.canAdminister).toBe(true);
    expect(view.transportWired).toBe(true);
    expect(view.accounts.length).toBeGreaterThanOrEqual(3);
    const priorities = view.accounts.map((account) => account.priority);
    expect([...priorities].sort((left, right) => left - right)).toEqual(priorities);
    // The account whose evidence we created carries spend + last activity.
    const withSpend = view.accounts.find((account) => (account.spend?.executions ?? 0) > 0);
    expect(withSpend).toBeDefined();
    expect(withSpend!.lastExecutionAt).not.toBeNull();
    // Evidence feeds stay bounded.
    expect(view.executions.length).toBeLessThanOrEqual(20);
    expect(view.hotSwapExecutions.length).toBeLessThanOrEqual(12);
    expect(view.hotSwapExecutions.every((execution) => execution.purpose === 'hot-swap-verification')).toBe(true);
  });
});
