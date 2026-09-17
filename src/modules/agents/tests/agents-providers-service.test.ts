// Integration tests for the agents module's W035 surface — the Agent
// Provider Registry — against the embedded PostgreSQL (PGlite, `:memory:`)
// through the db port. Covers the work item acceptance: "Register multiple
// agent runtimes/providers and route execution without semantic provider
// coupling."
//
//  * accounts — claim-gated registration (idempotent per (provider,
//    label), ANY number of accounts per runtime family and across
//    families), tenant-scoped reads with the uniform cross-tenant
//    not-found discipline (ADR-0001), filtered listing and
//    management-control updates;
//  * availability — manual operator overrides (claim-gated), effective
//    reads (an expired cooldown reads as available), append-only storage
//    (triggers reject UPDATE/DELETE/TRUNCATE);
//  * routing — dispatches route to the tenant's registered accounts of the
//    agent definition's runtime family on neutral facts only: priority
//    ordering, the frozen routing snapshot on every attempt (every
//    candidate with its machine-readable reason, the chosen account),
//    the chosen account id on the transport request, transient-failure
//    cooldowns with failover to the next account, recovery events, the
//    §20 authority ceiling, the unrouted W021 fallback when the tenant
//    registered no account for the family, and the loud
//    no_eligible_runtime_account when every family account is ineligible
//    (nothing attempted, no attempt evidence consumed, the execution
//    stays queued);
//  * provider neutrality — the SAME canonical task contract and result
//    shape execute through routed accounts of multiple runtime families;
//    swapping which account serves never touches the canonical contract.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as agentsContract from '../contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { AgentsError } from '../errors';
import { setAgentTransport } from '../service';
import type {
  AgentPermissionScope,
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
  RegisterAgentInput,
  RegisterAgentRuntimeAccountInput,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getAgentRuntimeAccount,
  getAgentRuntimeAvailability,
  listAgentExecutionAttempts,
  listAgentRuntimeAccounts,
  registerAgent,
  registerAgentRuntimeAccount,
  runAgentExecution,
  setAgentRuntimeAvailability,
  submitAgentExecution,
  updateAgentRuntimeAccount,
} = agentsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantAccounts = newId();
const tenantAvailability = newId();
const tenantRouting = newId();
const tenantMismatch = newId();
const tenantFailover = newId();
const tenantFallback = newId();
const tenantIneligible = newId();
const tenantRecovery = newId();
const tenantIsolation = newId();
const tenantOther = newId();
const tenantStorage = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function agentsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

async function expectCode(
  code: AgentsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected AgentsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentsError);
    expect((error as AgentsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// A recording fake transport that speaks every runtime dialect
// ---------------------------------------------------------------------------

class RoutingFakeTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];
  private outcome: { output?: unknown } = {};
  private failingAccounts = new Set<string>();
  private unroutedFailuresLeft = 0;
  private counter = 0;

  respondWith(outcome: { output?: unknown }): void {
    this.outcome = outcome;
  }

  /** Dispatches through this account fail transiently (cooldown fuel). */
  failAccount(accountId: string): void {
    this.failingAccounts.add(accountId);
  }

  /** Unrouted dispatches fail transiently (the legacy path's retry policy). */
  failNextUnrouted(count: number): void {
    this.unroutedFailuresLeft = count;
  }

  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.requests.push(request);
    const accountId = request.runtimeAccountId ?? null;
    if (accountId !== null && this.failingAccounts.has(accountId)) {
      return { status: 'failed', payload: null, providerTaskId: null, detail: 'simulated transient failure' };
    }
    if (accountId === null && this.unroutedFailuresLeft > 0) {
      this.unroutedFailuresLeft -= 1;
      return { status: 'failed', payload: null, providerTaskId: null, detail: 'simulated transient failure' };
    }
    this.counter += 1;
    const taskId = `w035-${String(this.counter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: this.payloadFor(request.provider, taskId),
      providerTaskId: taskId,
      detail: null,
    };
  }

  /** Builds a runtime-NATIVE payload for the adapter to parse (dialect realism). */
  private payloadFor(provider: string, taskId: string): unknown {
    const output = this.outcome.output ?? { routed: true };
    switch (provider) {
      case 'openai-assistants':
        return {
          id: `run_${taskId}`,
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] },
          ],
          usage: { input_tokens: 1000, output_tokens: 500 },
        };
      case 'langgraph':
        return {
          run_id: `lg_${taskId}`,
          output: { result: output, summary: null },
          usage: { input_tokens: 1000, output_tokens: 500, steps: 4 },
        };
      case 'crewai':
        return {
          run_id: `crew_${taskId}`,
          status: 'completed',
          result: output,
          summary: null,
          token_usage: { input_tokens: 1000, output_tokens: 500, requests: 2 },
        };
      case 'autogen':
        return {
          id: `ag_${taskId}`,
          summary: null,
          result: output,
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        };
      default: // semantic-kernel
        return {
          runId: `sk_${taskId}`,
          output,
          summary: null,
          usage: { inputTokens: 1000, outputTokens: 500, invocations: 3 },
        };
    }
  }
}

let transport: RoutingFakeTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

beforeEach(() => {
  transport = new RoutingFakeTransport();
  setAgentTransport(transport);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREW_AGENT: RegisterAgentInput = {
  slug: 'crew-runner',
  displayName: 'Crew Runner',
  role: 'batch analyst',
  description: 'Runs analysis crews.',
  provider: 'crewai',
  instructions: 'Analyze the batch and report.',
  permissions: ['observe', 'analyze'],
  runtimeConfig: { crewName: 'analysis_crew' },
};

const TASK = { batchId: 'batch-7', goal: 'summarize findings' };
const ANALYZE_SUBMISSION = {
  task: TASK,
  requestedPermissions: ['observe', 'analyze'] as AgentPermissionScope[],
};

function crewAccount(overrides: Partial<RegisterAgentRuntimeAccountInput> & { label: string }): RegisterAgentRuntimeAccountInput {
  return {
    provider: 'crewai',
    credentialRef: `secret-store://crewai/${overrides.label}`,
    capabilities: ['task-execution'],
    maxAuthorityLevel: 'EXECUTE',
    priority: 100,
    ...overrides,
  };
}

async function register(ctx: TenantContext, input: RegisterAgentInput) {
  return (await registerAgent(ctx, input)).agent;
}

async function addAccount(ctx: TenantContext, input: RegisterAgentRuntimeAccountInput) {
  return (await registerAgentRuntimeAccount(ctx, input)).account;
}

// ---------------------------------------------------------------------------
// Runtime accounts (registration, reads, updates)
// ---------------------------------------------------------------------------

describe('agents W035 — runtime accounts', () => {
  it('registers accounts claim-gated, idempotently, multiple per family and across families', async () => {
    const admin = agentsAdmin(tenantAccounts);

    const primary = await addAccount(admin, crewAccount({ label: 'primary', priority: 0 }));
    const secondary = await addAccount(admin, crewAccount({ label: 'secondary', priority: 10 }));
    // A DIFFERENT runtime family registered by the same tenant.
    const graph = await addAccount(admin, {
      provider: 'langgraph',
      label: 'self-hosted',
      credentialRef: 'secret-store://langgraph/self-hosted',
      capabilities: ['task-execution'],
      maxAuthorityLevel: 'ANALYZE',
      priority: 50,
    });

    expect(primary.status).toBe('active');
    expect(primary.provider).toBe('crewai');
    expect(graph.provider).toBe('langgraph');
    expect(new Set([primary.id, secondary.id, graph.id]).size).toBe(3);

    // Same (provider, label) re-registers idempotently — first write wins.
    const again = await registerAgentRuntimeAccount(admin, crewAccount({ label: 'primary', priority: 999 }));
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(primary.id);
    expect(again.account.priority).toBe(0);

    // A plain member cannot attach runtime endpoints to the tenant.
    await expectCode('forbidden', () =>
      registerAgentRuntimeAccount(member(tenantAccounts), crewAccount({ label: 'rogue' })),
    );
  });

  it('reads are tenant-scoped with the uniform not-found discipline', async () => {
    const admin = agentsAdmin(tenantAccounts);
    const account = await addAccount(admin, crewAccount({ label: 'scoped' }));

    const found = await getAgentRuntimeAccount(member(tenantAccounts), { accountId: account.id });
    expect(found.id).toBe(account.id);

    await expectCode('runtime_account_not_found', () =>
      getAgentRuntimeAccount(member(tenantOther), { accountId: account.id }),
    );
    await expectCode('runtime_account_not_found', () =>
      getAgentRuntimeAccount(member(tenantAccounts), { accountId: newId() }),
    );
    await expectCode('runtime_account_not_found', () =>
      getAgentRuntimeAccount(member(tenantAccounts), { accountId: 'not-a-uuid' } as never),
    );

    expect(await listAgentRuntimeAccounts(member(tenantOther), {})).toEqual([]);
  });

  it('lists with provider/status filters and updates the mutable controls', async () => {
    const admin = agentsAdmin(tenantAccounts);
    const a = await addAccount(admin, crewAccount({ label: 'list-a', priority: 1 }));
    const b = await addAccount(admin, crewAccount({ label: 'list-b', priority: 2 }));
    await addAccount(admin, {
      provider: 'autogen',
      label: 'team-runtime',
      credentialRef: 'secret-store://autogen/team-runtime',
      capabilities: ['task-execution'],
      maxAuthorityLevel: 'EXECUTE',
      priority: 3,
    });

    const crews = await listAgentRuntimeAccounts(member(tenantAccounts), { provider: 'crewai' });
    expect(crews.map((account) => account.label).sort()).toEqual(
      ['list-a', 'list-b', 'primary', 'scoped', 'secondary'].sort(),
    );

    const disabled = await updateAgentRuntimeAccount(admin, {
      accountId: a.id,
      status: 'disabled',
      priority: 500,
      maxAuthorityLevel: 'ASK',
    });
    expect(disabled.status).toBe('disabled');
    expect(disabled.priority).toBe(500);
    expect(disabled.maxAuthorityLevel).toBe('ASK');

    // Claim-gated and uniformly not-found.
    await expectCode('forbidden', () =>
      updateAgentRuntimeAccount(member(tenantAccounts), { accountId: b.id, priority: 1 }),
    );
    await expectCode('runtime_account_not_found', () =>
      updateAgentRuntimeAccount(agentsAdmin(tenantOther), { accountId: b.id, priority: 1 }),
    );

    const onlyDisabled = await listAgentRuntimeAccounts(member(tenantAccounts), { status: 'disabled' });
    expect(onlyDisabled.map((account) => account.id)).toEqual([a.id]);
  });
});

// ---------------------------------------------------------------------------
// Availability (manual overrides, effective reads, append-only storage)
// ---------------------------------------------------------------------------

describe('agents W035 — runtime availability', () => {
  it('sets manual overrides claim-gated and reads effective states', async () => {
    const admin = agentsAdmin(tenantAvailability);
    const account = await addAccount(admin, crewAccount({ label: 'flaky' }));

    await expectCode('forbidden', () =>
      setAgentRuntimeAvailability(member(tenantAvailability), {
        accountId: account.id,
        state: 'unavailable',
      }),
    );
    await expectCode('runtime_account_not_found', () =>
      setAgentRuntimeAvailability(agentsAdmin(tenantOther), {
        accountId: account.id,
        state: 'unavailable',
      }),
    );

    const past = new Date(Date.now() - 5_000).toISOString();
    const override = await setAgentRuntimeAvailability(admin, {
      accountId: account.id,
      state: 'unavailable',
      reason: 'stale outage with a lapsed horizon',
      expiresAt: past,
    });
    expect(override.state).toBe('unavailable');
    expect(override.source).toBe('manual');

    // Effective read: the cooldown horizon has lapsed, so the account
    // reads as available again (the raw event is still the override).
    const [effective] = await getAgentRuntimeAvailability(admin, { accountId: account.id });
    expect(effective?.state).toBe('available');
    expect(effective?.source).toBe('manual');
    expect(effective?.reason).toBe('stale outage with a lapsed horizon');

    // Scoped read with the uniform not-found discipline.
    await expectCode('runtime_account_not_found', () =>
      getAgentRuntimeAvailability(admin, { accountId: newId() }),
    );
    expect(await getAgentRuntimeAvailability(agentsAdmin(tenantOther), {})).toEqual([]);
  });

  it('availability events are append-only at the storage level', async () => {
    const admin = agentsAdmin(tenantStorage);
    const account = await addAccount(admin, crewAccount({ label: 'evidence' }));
    await setAgentRuntimeAvailability(admin, { accountId: account.id, state: 'unavailable' });

    const db = getDb();
    await expect(
      db.query(`UPDATE agent_runtime_availability_events SET reason = 'rewritten' WHERE tenant_id = $1`, [
        tenantStorage,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM agent_runtime_availability_events WHERE tenant_id = $1`, [
        tenantStorage,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE agent_runtime_availability_events`)).rejects.toThrow(
      /append-only/,
    );
  });
});

// ---------------------------------------------------------------------------
// Routing (the dispatch path)
// ---------------------------------------------------------------------------

describe('agents W035 — dispatch routing', () => {
  it('routes through the best-priority account and freezes the decision on the attempt', async () => {
    const admin = agentsAdmin(tenantRouting);
    const submitting = member(tenantRouting);
    const agent = await register(admin, CREW_AGENT);
    const best = await addAccount(admin, crewAccount({ label: 'best', priority: 0 }));
    const worst = await addAccount(admin, crewAccount({ label: 'worst', priority: 900 }));

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    const ran = await runAgentExecution(submitting, { executionId: execution.id });

    expect(ran.status).toBe('succeeded');
    // The transport saw the chosen account, and only the chosen account.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.runtimeAccountId).toBe(best.id);
    expect(transport.requests[0]?.provider).toBe('crewai');

    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.runtimeAccountId).toBe(best.id);
    expect(attempt.routing).not.toBeNull();
    expect(attempt.routing?.routed).toBe(true);
    expect(attempt.routing?.chosen).toEqual({ accountId: best.id, provider: 'crewai' });
    const byId = new Map(attempt.routing!.candidates.map((candidate) => [candidate.accountId, candidate]));
    expect(byId.get(best.id)?.eligible).toBe(true);
    expect(byId.get(worst.id)?.eligible).toBe(true);
    expect(attempt.routing!.candidates).toHaveLength(2);
    // Cost still deterministic from the (centralized) registry pricing.
    expect(attempt.costMinor).toBeGreaterThan(0);
  });

  it('records foreign-family accounts as provider_mismatch, never routes them', async () => {
    const admin = agentsAdmin(tenantMismatch);
    const submitting = member(tenantMismatch);
    const agent = await register(admin, { ...CREW_AGENT, slug: 'crew-runner-2' });
    await addAccount(admin, {
      provider: 'langgraph',
      label: 'foreign-family',
      credentialRef: 'secret-store://langgraph/foreign-family',
      capabilities: ['task-execution'],
      maxAuthorityLevel: 'EXECUTE',
      priority: 0,
    });
    const crew = await addAccount(admin, crewAccount({ label: 'only-family', priority: 50 }));

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    await runAgentExecution(submitting, { executionId: execution.id });

    expect(transport.requests[0]?.runtimeAccountId).toBe(crew.id);
    const [attempt] = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    const foreign = attempt!.routing!.candidates.find((candidate) => candidate.accountId !== crew.id);
    expect(foreign?.reason).toBe('provider_mismatch');
    expect(foreign?.provider).toBe('langgraph');
  });

  it('respects the §20 authority ceiling: an ANALYZE dispatch never routes below its level', async () => {
    const admin = agentsAdmin(tenantIneligible);
    const submitting = member(tenantIneligible);
    const agent = await register(admin, CREW_AGENT);
    await addAccount(admin, crewAccount({ label: 'observe-only', maxAuthorityLevel: 'OBSERVE' }));

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    await expectCode('no_eligible_runtime_account', () =>
      runAgentExecution(submitting, { executionId: execution.id }),
    );

    // Nothing was attempted: no dispatch, no attempt evidence, still queued.
    expect(transport.requests).toHaveLength(0);
    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts).toEqual([]);
    const current = await agentsContract.getAgentExecution(submitting, { executionId: execution.id });
    expect(current.status).toBe('queued');
    expect(current.attemptsCount).toBe(0);
  });

  it('fails loudly when every family account is disabled, and recovers on re-enable', async () => {
    const admin = agentsAdmin(tenantIneligible);
    const submitting = member(tenantIneligible);
    const agent = await register(admin, { ...CREW_AGENT, slug: 'crew-runner-3' });
    const account = await addAccount(admin, crewAccount({ label: 'disabled-later' }));

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    await runAgentExecution(submitting, { executionId: execution.id }); // routed fine
    expect(transport.requests).toHaveLength(1);

    const execution2 = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      idempotencyKey: 'w035-disabled-family',
    });
    await updateAgentRuntimeAccount(admin, { accountId: account.id, status: 'disabled' });
    await expectCode('no_eligible_runtime_account', () =>
      runAgentExecution(submitting, { executionId: execution2.id }),
    );
    expect(transport.requests).toHaveLength(1); // no new dispatch

    await updateAgentRuntimeAccount(admin, { accountId: account.id, status: 'active' });
    const recovered = await runAgentExecution(submitting, { executionId: execution2.id });
    expect(recovered.status).toBe('succeeded');
    expect(transport.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Cooldown failover and recovery
// ---------------------------------------------------------------------------

describe('agents W035 — availability cooldown and failover', () => {
  it('cools a transiently failing account down and fails over to the next', async () => {
    const admin = agentsAdmin(tenantFailover);
    const submitting = member(tenantFailover);
    const agent = await register(admin, CREW_AGENT);
    const primary = await addAccount(admin, crewAccount({ label: 'primary', priority: 0 }));
    const standby = await addAccount(admin, crewAccount({ label: 'standby', priority: 10 }));

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      maxAttempts: 3,
    });

    transport.failAccount(primary.id);
    const first = await runAgentExecution(submitting, { executionId: execution.id });
    expect(first.status).toBe('queued'); // transient failure re-queued
    expect(first.attemptsCount).toBe(1);

    // The failed account is cooling down: the next pump fails over.
    const second = await runAgentExecution(submitting, { executionId: execution.id });
    expect(second.status).toBe('succeeded');
    expect(second.attemptsCount).toBe(2);
    expect(transport.requests.map((request) => request.runtimeAccountId)).toEqual([
      primary.id,
      standby.id,
    ]);

    // Attempt evidence reconstructs the failover (§24).
    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts.map((attempt) => attempt.runtimeAccountId)).toEqual([primary.id, standby.id]);
    expect(attempts[0]!.errorCode).toBe('dispatch_failed');
    expect(attempts[0]!.retryable).toBe(true);
    expect(attempts[1]!.status).toBe('completed');
    // The failover attempt's routing snapshot shows WHY the primary lost.
    const primaryCandidate = attempts[1]!.routing!.candidates.find(
      (candidate) => candidate.accountId === primary.id,
    );
    expect(primaryCandidate?.reason).toBe('unavailable');

    // The cooldown landed as an execution-sourced availability event.
    const [availability] = await getAgentRuntimeAvailability(admin, {
      accountId: primary.id,
    });
    expect(availability?.state).toBe('unavailable');
    expect(availability?.source).toBe('execution');
    expect(availability?.expiresAt).not.toBeNull();
  });

  it('records the recovery when a cooling account serves again', async () => {
    const admin = agentsAdmin(tenantRecovery);
    const submitting = member(tenantRecovery);
    const agent = await register(admin, CREW_AGENT);
    const account = await addAccount(admin, crewAccount({ label: 'recovering', priority: 0 }));

    // A manual outage whose horizon has already lapsed: the account routes
    // again (effective available) but its latest raw event is unavailable.
    const past = new Date(Date.now() - 60_000).toISOString();
    await setAgentRuntimeAvailability(admin, {
      accountId: account.id,
      state: 'unavailable',
      reason: 'stale outage',
      expiresAt: past,
    });

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    const ran = await runAgentExecution(submitting, { executionId: execution.id });
    expect(ran.status).toBe('succeeded');
    expect(transport.requests[0]?.runtimeAccountId).toBe(account.id);

    const [availability] = await getAgentRuntimeAvailability(admin, { accountId: account.id });
    expect(availability?.state).toBe('available');
    expect(availability?.source).toBe('execution');
    expect(availability?.reason).toBe('recovered after successful dispatch');
  });
});

// ---------------------------------------------------------------------------
// The unrouted fallback (W021 behavior preserved)
// ---------------------------------------------------------------------------

describe('agents W035 — unrouted fallback (no accounts of the family)', () => {
  it('serves dispatches unrouted when the tenant registered no account for the family', async () => {
    const admin = agentsAdmin(tenantFallback);
    const submitting = member(tenantFallback);
    const agent = await register(admin, CREW_AGENT);
    // Accounts of OTHER families must not capture or block the dispatch.
    await addAccount(admin, {
      provider: 'semantic-kernel',
      label: 'unrelated',
      credentialRef: 'secret-store://semantic-kernel/unrelated',
      capabilities: ['task-execution'],
      maxAuthorityLevel: 'EXECUTE',
      priority: 0,
    });

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    const ran = await runAgentExecution(submitting, { executionId: execution.id });
    expect(ran.status).toBe('succeeded');

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.runtimeAccountId).toBeNull();

    const [attempt] = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempt!.runtimeAccountId).toBeNull();
    expect(attempt!.routing?.routed).toBe(false);
    expect(attempt!.routing?.chosen).toBeNull();
    // The foreign-family account is recorded as a considered, mismatched candidate.
    expect(attempt!.routing?.candidates).toHaveLength(1);
    expect(attempt!.routing?.candidates[0]?.reason).toBe('provider_mismatch');
  });

  it('keeps the W021 retry discipline on the unrouted path', async () => {
    const admin = agentsAdmin(tenantFallback);
    const submitting = member(tenantFallback);
    const agent = await register(admin, { ...CREW_AGENT, slug: 'crew-runner-4' });

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      maxAttempts: 2,
    });
    transport.failNextUnrouted(1);
    const first = await runAgentExecution(submitting, { executionId: execution.id });
    expect(first.status).toBe('queued');
    const second = await runAgentExecution(submitting, { executionId: execution.id });
    expect(second.status).toBe('succeeded');
    expect(second.attemptsCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Provider neutrality across families (the swap property)
// ---------------------------------------------------------------------------

describe('agents W035 — provider neutrality (no semantic provider coupling)', () => {
  it('the same canonical task executes through routed accounts of three runtime families', async () => {
    const admin = agentsAdmin(tenantRouting);
    const submitting = member(tenantRouting);

    const specs: Array<{ provider: 'openai-assistants' | 'autogen' | 'semantic-kernel'; slug: string; config: Record<string, unknown> }> = [
      { provider: 'openai-assistants', slug: 'oa-runner', config: { assistantId: 'asst_w035' } },
      { provider: 'autogen', slug: 'ag-runner', config: { teamId: 'team_w035' } },
      { provider: 'semantic-kernel', slug: 'sk-runner', config: { agentId: 'sk_w035' } },
    ];

    for (const spec of specs) {
      const agent = await register(admin, {
        slug: spec.slug,
        role: 'neutral runner',
        provider: spec.provider,
        instructions: 'Run the task.',
        permissions: ['observe', 'analyze'],
        runtimeConfig: spec.config,
      });
      await addAccount(admin, {
        provider: spec.provider,
        label: 'tenant-owned',
        credentialRef: `secret-store://${spec.provider}/tenant-owned`,
        capabilities: ['task-execution'],
        maxAuthorityLevel: 'EXECUTE',
        priority: 0,
      });

      const execution = await submitAgentExecution(submitting, {
        agentId: agent.id,
        task: TASK,
        requestedPermissions: ['observe', 'analyze'],
      });
      const ran = await runAgentExecution(submitting, { executionId: execution.id });

      // Canonical contract, unchanged regardless of family or account.
      expect(ran.status).toBe('succeeded');
      expect(ran.provider).toBe(spec.provider);
      expect(ran.result?.output).toEqual({ routed: true });
      expect(ran.costCurrency).toBe('USD');
      const [attempt] = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
      expect(attempt!.runtimeAccountId).not.toBeNull();
      expect(attempt!.routing?.provider).toBe(spec.provider);
      expect(attempt!.routing?.routed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation of the routing surface
// ---------------------------------------------------------------------------

describe('agents W035 — tenant isolation', () => {
  it('another tenant\'s accounts never serve, block or leak', async () => {
    const admin = agentsAdmin(tenantIsolation);
    const submitting = member(tenantIsolation);
    const agent = await register(admin, CREW_AGENT);
    // The OTHER tenant owns the only crewai account in the database.
    await addAccount(agentsAdmin(tenantOther), crewAccount({ label: 'foreign', priority: 0 }));

    // No account of THIS tenant: unrouted dispatch, foreign accounts invisible.
    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    const ran = await runAgentExecution(submitting, { executionId: execution.id });
    expect(ran.status).toBe('succeeded');
    expect(transport.requests[0]?.runtimeAccountId).toBeNull();
    const [attempt] = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempt!.routing?.candidates).toEqual([]);

    // Reads never leak across tenants.
    expect(await listAgentRuntimeAccounts(submitting, {})).toEqual([]);
    expect(await getAgentRuntimeAvailability(submitting, {})).toEqual([]);
  });
});
