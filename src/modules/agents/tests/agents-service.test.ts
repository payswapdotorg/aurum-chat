// Integration tests for the agents module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W021 acceptance:
// "Provider-independent execution contract with permissions, async
// execution, idempotency, retries, normalized results, evidence and
// cost."
//
//  * definitions — claim-gated registration (idempotent per slug), 
//    tenant-scoped reads with the uniform cross-tenant not-found
//    discipline (ADR-0001), filtered listing and management-control
//    updates (including permission grants and disable/enable);
//  * permissions — an execution requesting scopes beyond the agent's
//    grant is refused BEFORE anything is recorded (no execution, no
//    action request, no dispatch);
//  * the W009 authority gate — every submission routes through kind
//    'agent-execution' at the HIGHEST §20 level its scopes imply: the
//    built-in default allows ANALYZE (queued immediately), gates EXECUTE
//    behind human approval (awaiting_approval → decideApproval → the
//    pump resolves it), a tenant policy can forbid outright (a terminal
//    'refused' record — evidence), and a human can reject a gated
//    submission (refused with approval_rejected);
//  * async execution — submit records and returns without dispatching;
//    the pump performs exactly ONE bounded attempt per call, serialized
//    per execution; unwired transport is the explicit
//    provider_unavailable;
//  * idempotency — a recorded key replays the original execution (first
//    write wins; the gate shares the key, so an approved gated
//    submission resumes without a second request);
//  * retries — transient runtime failures re-queue while attempts
//    remain (maxAttempts), then fail terminally; provider refusals and
//    unnormalizable results are permanent single-attempt failures;
//  * normalized results + provider independence — the SAME canonical
//    task contract executes through all five runtime adapters
//    (openai-assistants, langgraph, crewai, autogen, semantic-kernel)
//    with canonical results, provider task ids, usage and deterministic
//    integer-minor-unit cost accumulated on the execution;
//  * evidence — append-only attempt rows with latency/usage/cost, the
//    immutable submission (storage triggers reject UPDATE/DELETE on
//    attempts and substantive-field changes on executions), §25
//    correlation/causation identities and the filtered trace surface;
//  * tenant isolation — every operation is tenant-scoped; another
//    tenant's agents, executions and attempts are indistinguishable
//    from missing ones.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as agentsContract from '../contract';
import { decideApproval, listActionRequests, setAuthorityPolicy } from '@/modules/actions/contract';
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
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  cancelAgentExecution,
  getAgent,
  getAgentExecution,
  listAgentExecutionAttempts,
  listAgentExecutions,
  listAgents,
  registerAgent,
  runAgentExecution,
  submitAgentExecution,
  updateAgent,
} = agentsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantDefinitions = newId();
const tenantPermissions = newId();
const tenantGate = newId();
const tenantForbid = newId();
const tenantReject = newId();
const tenantAsync = newId();
const tenantIdempotency = newId();
const tenantRetries = newId();
const tenantPermanent = newId();
const tenantMultiProvider = newId();
const tenantIsolation = newId();
const tenantOther = newId();
const tenantStorage = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function agentsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer', 'agents:administer'] };
}

function approver(tenantId: string): TenantContext {
  // A DIFFERENT principal with the actions approval claim (separation of duties).
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
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

interface FakeOutcome {
  output?: unknown;
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
  operations?: number;
}

class FakeAgentTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];
  private outcome: FakeOutcome = {};
  private failuresLeft = 0;
  private failureStatus: 'rejected' | 'failed' = 'failed';
  private static counter = 0;

  respondWith(outcome: FakeOutcome): void {
    this.outcome = outcome;
  }

  /** The next `count` dispatches fail (transient by default). */
  failNext(count: number, status: 'rejected' | 'failed' = 'failed'): void {
    this.failuresLeft = count;
    this.failureStatus = status;
  }

  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.requests.push(request);
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      return {
        status: this.failureStatus,
        payload: null,
        providerTaskId: null,
        detail: `simulated ${this.failureStatus === 'failed' ? 'transient failure' : 'refusal'}`,
      };
    }
    FakeAgentTransport.counter += 1;
    const taskId = `fake-${String(FakeAgentTransport.counter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: this.payloadFor(request.provider, taskId),
      providerTaskId: taskId,
      detail: null,
    };
  }

  /** Builds a runtime-NATIVE payload for the adapter to parse (dialect realism). */
  private payloadFor(provider: string, taskId: string): unknown {
    const output = this.outcome.output ?? { triaged: true };
    const summary = this.outcome.summary ?? null;
    const inputTokens = this.outcome.inputTokens ?? 1200;
    const outputTokens = this.outcome.outputTokens ?? 800;
    const operations = this.outcome.operations ?? 3;
    switch (provider) {
      case 'openai-assistants':
        return {
          id: `run_${taskId}`,
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: typeof output === 'string' ? output : JSON.stringify(output) },
              ],
            },
          ],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };
      case 'langgraph':
        return {
          run_id: `lg_${taskId}`,
          output: { result: output, summary },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, steps: operations },
        };
      case 'crewai':
        return {
          run_id: `crew_${taskId}`,
          status: 'completed',
          result: output,
          summary,
          token_usage: { input_tokens: inputTokens, output_tokens: outputTokens, requests: operations },
        };
      case 'autogen':
        return {
          id: `ag_${taskId}`,
          summary,
          result: output,
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
        };
      default: // semantic-kernel
        return {
          runId: `sk_${taskId}`,
          output,
          summary,
          usage: { inputTokens, outputTokens, invocations: operations },
        };
    }
  }
}

let transport: FakeAgentTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

beforeEach(() => {
  transport = new FakeAgentTransport();
  setAgentTransport(transport);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANALYST: RegisterAgentInput = {
  slug: 'triage-analyst',
  displayName: 'Triage Analyst',
  role: 'conversation triage',
  description: 'Triages inbound conversations and drafts replies.',
  provider: 'openai-assistants',
  instructions: 'Triage the conversation and propose a reply.',
  permissions: ['observe', 'analyze', 'recommend'],
  runtimeConfig: { assistantId: 'asst_triage' },
};

const OPERATOR: RegisterAgentInput = {
  ...ANALYST,
  slug: 'reply-operator',
  role: 'reply operator',
  permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose', 'execute'],
};

const TASK = { conversationId: 'conv-17', goal: 'draft a reply for review' };
/** The analyze-scoped submission body (spread after a concrete agentId). */
const ANALYZE_SUBMISSION = {
  task: TASK,
  requestedPermissions: ['observe', 'analyze'] as AgentPermissionScope[],
};

async function register(ctx: TenantContext, input: RegisterAgentInput) {
  const result = await registerAgent(ctx, input);
  return result.agent;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe('agents service — definitions', () => {
  it('registers agents idempotently and claim-gates the writes', async () => {
    const admin = agentsAdmin(tenantDefinitions);
    const first = await register(admin, ANALYST);
    expect(first.status).toBe('active');
    expect(first.permissions).toEqual(['observe', 'analyze', 'recommend']);

    const again = await registerAgent(admin, { ...ANALYST, instructions: 'Different instructions.' });
    expect(again.created).toBe(false);
    expect(again.agent.id).toBe(first.id);
    // First registration wins.
    expect(again.agent.instructions).toBe(ANALYST.instructions);

    await expectCode('forbidden', () => registerAgent(member(tenantDefinitions), { ...ANALYST, slug: 'rogue' }));
  });

  it('reads are tenant-scoped with the uniform not-found discipline', async () => {
    const admin = agentsAdmin(tenantDefinitions);
    const agent = await register(admin, { ...ANALYST, slug: 'research-agent', provider: 'langgraph' });

    const found = await getAgent(member(tenantDefinitions), { agentId: agent.id });
    expect(found.id).toBe(agent.id);

    await expectCode('agent_not_found', () => getAgent(member(tenantOther), { agentId: agent.id }));
    await expectCode('agent_not_found', () => getAgent(member(tenantDefinitions), { agentId: newId() }));
    await expectCode('agent_not_found', () => getAgent(member(tenantDefinitions), { agentId: 'not-a-uuid' } as never));

    expect(await listAgents(member(tenantOther), {})).toEqual([]);
  });

  it('lists with filters', async () => {
    const admin = agentsAdmin(tenantDefinitions);
    await register(admin, { ...ANALYST, slug: 'alpha', provider: 'crewai' });
    await register(admin, { ...ANALYST, slug: 'beta', provider: 'langgraph' });

    const all = await listAgents(member(tenantDefinitions), {});
    expect(all.map((agent) => agent.slug)).toContain('alpha');

    const onlyCrew = await listAgents(member(tenantDefinitions), { provider: 'crewai' });
    expect(onlyCrew.map((agent) => agent.slug)).toEqual(['alpha']);
  });

  it('updates the mutable management controls and claim-gates them', async () => {
    const admin = agentsAdmin(tenantDefinitions);
    const agent = await register(admin, { ...ANALYST, slug: 'mutable' });

    const updated = await updateAgent(admin, {
      agentId: agent.id,
      permissions: ['observe', 'analyze'],
      instructions: 'Triage only — no replies.',
      runtimeConfig: { assistantId: 'asst_v2' },
    });
    expect(updated.permissions).toEqual(['observe', 'analyze']);
    expect(updated.instructions).toBe('Triage only — no replies.');
    expect(updated.updatedAt >= agent.updatedAt).toBe(true);

    const disabled = await updateAgent(admin, { agentId: agent.id, status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    const reenabled = await updateAgent(admin, { agentId: agent.id, status: 'active' });
    expect(reenabled.status).toBe('active');

    await expectCode('forbidden', () => updateAgent(member(tenantDefinitions), { agentId: agent.id, role: 'x' }));
    await expectCode('agent_not_found', () => updateAgent(agentsAdmin(tenantOther), { agentId: agent.id, role: 'x' }));
  });
});

// ---------------------------------------------------------------------------
// Permissions (the "with permissions" acceptance)
// ---------------------------------------------------------------------------

describe('agents service — permission scoping', () => {
  it('refuses executions beyond the grant BEFORE anything is recorded', async () => {
    const admin = agentsAdmin(tenantPermissions);
    const agent = await register(admin, ANALYST); // observe/analyze/recommend

    await expectCode('permission_not_granted', () =>
      submitAgentExecution(member(tenantPermissions), {
        agentId: agent.id,
        task: TASK,
        requestedPermissions: ['observe', 'execute'],
      }),
    );
    await expectCode('permission_not_granted', () =>
      submitAgentExecution(member(tenantPermissions), {
        agentId: agent.id,
        task: TASK,
        requestedPermissions: ['ask'],
      }),
    );

    // Nothing was recorded: no executions, no action requests.
    expect(await listAgentExecutions(member(tenantPermissions), {})).toEqual([]);
    expect(await listActionRequests(member(tenantPermissions), { actionKind: 'agent-execution' })).toEqual([]);

    // A covered request passes the permission check (and the built-in
    // default matrix allows ANALYZE — see the gate group below).
    const covered = await submitAgentExecution(member(tenantPermissions), {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    expect(covered.status).toBe('queued');
    expect(covered.authorityLevel).toBe('ANALYZE');
    expect(covered.requestedPermissions).toEqual(['observe', 'analyze']);
  });

  it('records the grant change and enforces the NEW grant', async () => {
    const admin = agentsAdmin(tenantPermissions);
    const agent = await register(admin, ANALYST);
    await updateAgent(admin, { agentId: agent.id, permissions: ['observe'] });

    await expectCode('permission_not_granted', () =>
      submitAgentExecution(member(tenantPermissions), {
        agentId: agent.id,
        task: TASK,
        requestedPermissions: ['observe', 'analyze'],
      }),
    );
    const ok = await submitAgentExecution(member(tenantPermissions), {
      agentId: agent.id,
      task: TASK,
      requestedPermissions: ['observe'],
    });
    expect(ok.status).toBe('queued');
    expect(ok.authorityLevel).toBe('OBSERVE');
  });
});

// ---------------------------------------------------------------------------
// The W009 authority gate (kind 'agent-execution')
// ---------------------------------------------------------------------------

describe('agents service — the authority gate (W009 integration)', () => {
  it('records an approved action request for every submission and links it on the execution', async () => {
    const admin = agentsAdmin(tenantGate);
    const agent = await register(admin, ANALYST);

    const execution = await submitAgentExecution(member(tenantGate), {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    expect(execution.status).toBe('queued');
    expect(execution.policy.outcome).toBe('allowed');
    expect(execution.policy.resolvedVia).toBe('built-in');

    const requests = await listActionRequests(member(tenantGate), { actionKind: 'agent-execution' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('approved');
    expect(requests[0]!.authorityLevel).toBe('ANALYZE');
    expect(requests[0]!.requestedBy).not.toBe('');
    expect(requests[0]!.payload).toMatchObject({ agentId: agent.id, agentSlug: agent.slug });
    expect(execution.policy.actionRequestId).toBe(requests[0]!.id);
  });

  it('gates EXECUTE-level submissions behind a human approval, then the pump resolves it', async () => {
    const admin = agentsAdmin(tenantGate);
    const agent = await register(admin, OPERATOR);

    const submitting = member(tenantGate);
    const gated = await submitAgentExecution(submitting, {
      agentId: agent.id,
      task: TASK,
      requestedPermissions: ['execute'],
      idempotencyKey: 'agents:gate-flow-1',
    });
    expect(gated.status).toBe('awaiting_approval');
    expect(gated.authorityLevel).toBe('EXECUTE');
    expect(gated.policy.outcome).toBe('approval_required');
    expect(gated.completedAt).toBeNull();

    // While gated, the pump reports the submission still awaiting.
    const stillAwaiting = await runAgentExecution(submitting, { executionId: gated.id });
    expect(stillAwaiting.status).toBe('awaiting_approval');
    expect((await listAgentExecutionAttempts(submitting, { executionId: gated.id }))).toEqual([]);

    // Separation of duties: the submitting principal never decides its own request.
    const pending = await listActionRequests(submitting, { actionKind: 'agent-execution', status: 'pending' });
    expect(pending).toHaveLength(1);
    await expect(
      decideApproval(submitting, { requestId: pending[0]!.id, decision: 'approve' }),
    ).rejects.toThrow();

    await decideApproval(approver(tenantGate), { requestId: pending[0]!.id, decision: 'approve' });

    // The pump resolves the approved gate and performs the first attempt.
    const run = await runAgentExecution(submitting, { executionId: gated.id });
    expect(run.status).toBe('succeeded');
    expect(run.policy.outcome).toBe('approval_required'); // frozen matrix snapshot
    expect(run.policy.actionRequestId).toBe(pending[0]!.id);
    const attempts = await listAgentExecutionAttempts(submitting, { executionId: gated.id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('completed');

    // No second action request was ever minted.
    const all = await listActionRequests(submitting, { actionKind: 'agent-execution' });
    expect(all.filter((request) => request.id === pending[0]!.id)).toHaveLength(1);
  });

  it('a tenant policy can forbid agent execution at a level — recorded as refused evidence', async () => {
    const admin = actionsAdmin(tenantForbid);
    const agent = await register(admin, ANALYST);
    await setAuthorityPolicy(admin, {
      actionKind: 'agent-execution',
      forbiddenLevels: ['ANALYZE'],
    });

    const refused = await submitAgentExecution(member(tenantForbid), {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    expect(refused.status).toBe('refused');
    expect(refused.errorCode).toBe('execution_forbidden');
    expect(refused.completedAt).not.toBeNull();
    expect(refused.policy.outcome).toBe('forbidden');

    // The refusing decision is reconstructable through the actions module.
    const requests = await listActionRequests(member(tenantForbid), { actionKind: 'agent-execution' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('rejected');

    // Terminal: the pump refuses to dispatch it.
    await expectCode('not_runnable', () => runAgentExecution(member(tenantForbid), { executionId: refused.id }));

    // Deeper scopes are unaffected (RECOMMEND is not forbidden).
    const deeper = await submitAgentExecution(member(tenantForbid), {
      agentId: agent.id,
      task: TASK,
      requestedPermissions: ['observe', 'recommend'],
    });
    expect(deeper.status).toBe('queued');
    expect(deeper.authorityLevel).toBe('RECOMMEND');
  });

  it('a human can reject a gated submission — the pump records the refusal', async () => {
    const admin = actionsAdmin(tenantReject);
    const agent = await register(admin, OPERATOR);
    await setAuthorityPolicy(admin, {
      actionKind: 'agent-execution',
      approvalLevels: ['EXECUTE'],
    });

    const gated = await submitAgentExecution(member(tenantReject), {
      agentId: agent.id,
      task: TASK,
      requestedPermissions: ['execute'],
    });
    expect(gated.status).toBe('awaiting_approval');

    const pending = await listActionRequests(member(tenantReject), { actionKind: 'agent-execution', status: 'pending' });
    await decideApproval(approver(tenantReject), { requestId: pending[0]!.id, decision: 'reject' });

    const refused = await runAgentExecution(member(tenantReject), { executionId: gated.id });
    expect(refused.status).toBe('refused');
    expect(refused.errorCode).toBe('approval_rejected');
    expect(refused.completedAt).not.toBeNull();
    expect((await listAgentExecutionAttempts(member(tenantReject), { executionId: gated.id }))).toEqual([]);
  });

  it('disabled agents accept no executions and are not dispatched', async () => {
    const admin = agentsAdmin(tenantGate);
    const agent = await register(admin, { ...ANALYST, slug: 'paused-agent' });
    const execution = await submitAgentExecution(member(tenantGate), {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    expect(execution.status).toBe('queued');

    await updateAgent(admin, { agentId: agent.id, status: 'disabled' });
    await expectCode('agent_disabled', () =>
      submitAgentExecution(member(tenantGate), { agentId: agent.id, ...ANALYZE_SUBMISSION }),
    );
    // The already-queued execution is not dispatched while disabled.
    await expectCode('agent_disabled', () => runAgentExecution(member(tenantGate), { executionId: execution.id }));
    expect((await getAgentExecution(member(tenantGate), { executionId: execution.id })).status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Async execution and idempotency
// ---------------------------------------------------------------------------

describe('agents service — async execution and idempotency', () => {
  it('submission records without dispatching; an unwired transport is explicit', async () => {
    const admin = agentsAdmin(tenantAsync);
    const agent = await register(admin, ANALYST);

    const execution = await submitAgentExecution(member(tenantAsync), {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      correlationId: 'flow-42',
      causationId: 'mission-7',
    });
    expect(execution.status).toBe('queued');
    expect(execution.attemptsCount).toBe(0);
    expect(execution.correlationId).toBe('flow-42');
    expect(execution.causationId).toBe('mission-7');
    expect(transport.requests).toHaveLength(0); // async: nothing dispatched yet

    setAgentTransport(null);
    await expectCode('provider_unavailable', () =>
      runAgentExecution(member(tenantAsync), { executionId: execution.id }),
    );
    // The execution stays queued — a loud failure, never a fake success.
    expect((await getAgentExecution(member(tenantAsync), { executionId: execution.id })).status).toBe('queued');
  });

  it('a recorded idempotency key replays the original execution (first write wins)', async () => {
    const admin = agentsAdmin(tenantIdempotency);
    const agent = await register(admin, ANALYST);
    const submitting = member(tenantIdempotency);

    const first = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      idempotencyKey: 'agents:retry-once',
    });
    const replay = await submitAgentExecution(submitting, {
      agentId: agent.id,
      task: { different: 'task' },
      requestedPermissions: ['observe'],
      idempotencyKey: 'agents:retry-once',
    });
    expect(replay.id).toBe(first.id);
    expect(replay.task).toEqual(TASK); // the ORIGINAL task, not the retry's
    expect(replay.requestedPermissions).toEqual(['observe', 'analyze']);

    expect(await listAgentExecutions(submitting, {})).toHaveLength(1);
    // One action request for one execution (the gate shared the key).
    expect(await listActionRequests(submitting, { actionKind: 'agent-execution' })).toHaveLength(1);

    // Without a key every submission mints a fresh execution.
    const fresh = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    expect(fresh.id).not.toBe(first.id);
    expect(await listAgentExecutions(submitting, {})).toHaveLength(2);
  });

  it('cancels live executions one-way and refuses terminal ones', async () => {
    const admin = agentsAdmin(tenantAsync);
    const agent = await register(admin, { ...ANALYST, slug: 'cancellable' });
    const submitting = member(tenantAsync);

    const queued = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    const cancelled = await cancelAgentExecution(submitting, {
      executionId: queued.id,
      reason: 'superseded by a newer task',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.errorCode).toBe('cancelled');
    expect(cancelled.errorDetail).toBe('superseded by a newer task');
    expect(cancelled.completedAt).not.toBeNull();

    await expectCode('not_runnable', () => runAgentExecution(submitting, { executionId: queued.id }));
    await expectCode('not_cancellable', () =>
      cancelAgentExecution(submitting, { executionId: queued.id, reason: 'twice' }),
    );

    // A gated submission is cancellable while awaiting approval.
    const operator = await register(admin, { ...OPERATOR, slug: 'cancellable-operator' });
    const gated = await submitAgentExecution(submitting, {
      agentId: operator.id,
      task: TASK,
      requestedPermissions: ['execute'],
    });
    const cancelledGated = await cancelAgentExecution(submitting, { executionId: gated.id, reason: 'withdrawing' });
    expect(cancelledGated.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Retries and normalized results
// ---------------------------------------------------------------------------

describe('agents service — the pump, retries, results and cost', () => {
  it('performs exactly ONE attempt per call and completes with the normalized result', async () => {
    const admin = agentsAdmin(tenantRetries);
    const agent = await register(admin, ANALYST);
    const submitting = member(tenantRetries);

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    const run = await runAgentExecution(submitting, { executionId: execution.id });

    expect(run.status).toBe('succeeded');
    expect(run.attemptsCount).toBe(1);
    expect(run.result).toEqual({ output: { triaged: true }, summary: null });
    expect(run.errorCode).toBeNull();
    expect(run.costMinor).toBeGreaterThan(0); // (1200*250 + 800*1000)/1e6 → 1 cent
    expect(run.costCurrency).toBe('USD');
    expect(run.completedAt).not.toBeNull();

    // The attempt evidence: provider, task id, latency, usage, cost.
    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.provider).toBe('openai-assistants');
    expect(attempt.status).toBe('completed');
    expect(attempt.providerTaskId).toMatch(/^run_fake-/);
    expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
    expect(attempt.usage.inputTokens).toBe(1200);
    expect(attempt.usage.outputTokens).toBe(800);
    expect(attempt.costMinor).toBe(run.costMinor);
    expect(attempt.result).toEqual(run.result);
    expect(attempt.dispatchedBy).not.toBe('');

    // The dispatch carried the canonical contract through the adapter:
    // provider key, agent id and the opaque runtime agent reference.
    const wireRequest = transport.requests[0]!;
    expect(wireRequest.provider).toBe('openai-assistants');
    expect(wireRequest.agentId).toBe(agent.id);
    expect(wireRequest.runtimeAgentRef).toBe('asst_triage');
    expect(wireRequest.body).toMatchObject({ assistant_id: 'asst_triage' });

    // Terminal: further pumps refuse.
    await expectCode('not_runnable', () => runAgentExecution(submitting, { executionId: execution.id }));
  });

  it('retries transient failures while attempts remain, then fails terminally', async () => {
    const admin = agentsAdmin(tenantRetries);
    const agent = await register(admin, { ...ANALYST, slug: 'flaky-runtime' });
    const submitting = member(tenantRetries);

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      maxAttempts: 3,
    });

    transport.failNext(99); // every dispatch fails transiently

    const first = await runAgentExecution(submitting, { executionId: execution.id });
    expect(first.status).toBe('queued'); // retryable → back in the queue
    expect(first.attemptsCount).toBe(1);
    const second = await runAgentExecution(submitting, { executionId: execution.id });
    expect(second.status).toBe('queued');
    expect(second.attemptsCount).toBe(2);
    const third = await runAgentExecution(submitting, { executionId: execution.id });
    expect(third.status).toBe('failed'); // ceiling reached
    expect(third.attemptsCount).toBe(3);
    expect(third.errorCode).toBe('dispatch_failed');
    expect(third.result).toBeNull();
    expect(third.completedAt).not.toBeNull();

    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts.every((attempt) => attempt.status === 'failed' && attempt.retryable)).toBe(true);
    expect(attempts.every((attempt) => attempt.errorCode === 'dispatch_failed')).toBe(true);

    await expectCode('not_runnable', () => runAgentExecution(submitting, { executionId: execution.id }));
  });

  it('succeeds after a transient failure (cost accumulates from completed attempts only)', async () => {
    const admin = agentsAdmin(tenantRetries);
    const agent = await register(admin, { ...ANALYST, slug: 'recovering-runtime' });
    const submitting = member(tenantRetries);

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      maxAttempts: 3,
    });

    transport.failNext(1);
    const afterFailure = await runAgentExecution(submitting, { executionId: execution.id });
    expect(afterFailure.status).toBe('queued');

    const recovered = await runAgentExecution(submitting, { executionId: execution.id });
    expect(recovered.status).toBe('succeeded');
    expect(recovered.attemptsCount).toBe(2);
    expect(recovered.costMinor).toBe(1); // only the completed attempt priced

    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
    expect(attempts[0]!.costMinor).toBe(0);
    expect(attempts[1]!.costMinor).toBe(1);
  });

  it('a provider refusal is a permanent single-attempt failure', async () => {
    const admin = agentsAdmin(tenantPermanent);
    const agent = await register(admin, { ...ANALYST, slug: 'refusing-runtime' });
    const submitting = member(tenantPermanent);

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
      maxAttempts: 5,
    });
    transport.failNext(99, 'rejected');

    const failed = await runAgentExecution(submitting, { executionId: execution.id });
    expect(failed.status).toBe('failed');
    expect(failed.attemptsCount).toBe(1); // permanent — no retry burned
    expect(failed.errorCode).toBe('dispatch_rejected');

    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.retryable).toBe(false);
  });

  it('an unnormalizable runtime result is a loud permanent failure, never a substitute', async () => {
    const admin = agentsAdmin(tenantPermanent);
    const agent = await register(admin, { ...ANALYST, slug: 'garbage-runtime' });
    const submitting = member(tenantPermanent);

    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    // "Delivered" but not in any dialect the adapter can parse.
    transport.respondWith({ output: { triaged: true } });
    const originalSend = transport.send.bind(transport);
    transport.send = async (request) => {
      const receipt = await originalSend(request);
      return { ...receipt, payload: { totally: 'unexpected' } };
    };

    const failed = await runAgentExecution(submitting, { executionId: execution.id });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('result_invalid');
    expect(failed.attemptsCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provider independence — the same contract through every runtime
// ---------------------------------------------------------------------------

describe('agents service — provider independence (one contract, five runtimes)', () => {
  const PROVIDERS = [
    { provider: 'openai-assistants', config: { assistantId: 'asst_x' } },
    { provider: 'langgraph', config: { assistantId: 'graph-x' } },
    { provider: 'crewai', config: { crewName: 'crew-x' } },
    { provider: 'autogen', config: { teamId: 'team-x' } },
    { provider: 'semantic-kernel', config: { agentId: 'sk-x' } },
  ] as const;

  it('executes the same canonical task through every runtime and normalizes the results', async () => {
    const admin = agentsAdmin(tenantMultiProvider);
    const submitting = member(tenantMultiProvider);
    const outputs = [];

    for (const [index, spec] of PROVIDERS.entries()) {
      const agent = await register(admin, {
        ...ANALYST,
        slug: `runner-${index}`,
        provider: spec.provider,
        runtimeConfig: spec.config,
      });
      const execution = await submitAgentExecution(submitting, {
        agentId: agent.id,
        task: TASK,
        requestedPermissions: ['observe', 'analyze'],
        correlationId: 'flow-multi-provider',
      });
      const run = await runAgentExecution(submitting, { executionId: execution.id });
      expect(run.status).toBe('succeeded');
      expect(run.provider).toBe(spec.provider);
      expect(run.result!.output).toEqual({ triaged: true });
      expect(run.costMinor).toBeGreaterThan(0);
      outputs.push(run.result);

      const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
      expect(attempts[0]!.provider).toBe(spec.provider);
      expect(attempts[0]!.providerTaskId).toBeTruthy();
    }

    // Every runtime normalized to the SAME canonical output for the same task.
    expect(new Set(outputs.map((result) => JSON.stringify(result))).size).toBe(1);

    const correlated = await listAgentExecutions(submitting, { correlationId: 'flow-multi-provider' });
    expect(correlated).toHaveLength(PROVIDERS.length);
    expect(correlated.map((execution) => execution.provider).sort()).toEqual([...PROVIDERS.map((spec) => spec.provider)].sort());
  });

  it('a runtime configuration without a provider-side reference fails before dispatch', async () => {
    const admin = agentsAdmin(tenantMultiProvider);
    const agent = await register(admin, {
      ...ANALYST,
      slug: 'misconfigured',
      provider: 'langgraph',
      runtimeConfig: {}, // no assistantId
    });
    const execution = await submitAgentExecution(member(tenantMultiProvider), {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    await expectCode('invalid_runtime_config', () =>
      runAgentExecution(member(tenantMultiProvider), { executionId: execution.id }),
    );
    expect((await getAgentExecution(member(tenantMultiProvider), { executionId: execution.id })).status).toBe('queued');
    expect(transport.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('agents service — tenant isolation', () => {
  it('another tenant cannot see, submit, run, cancel or read evidence', async () => {
    const admin = agentsAdmin(tenantIsolation);
    const agent = await register(admin, ANALYST);
    const owner = member(tenantIsolation);
    const outsider = member(tenantOther);

    const execution = await submitAgentExecution(owner, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    await runAgentExecution(owner, { executionId: execution.id });
    expect((await getAgentExecution(owner, { executionId: execution.id })).status).toBe('succeeded');

    // Reads: uniform not-found, no existence leak.
    await expectCode('agent_not_found', () => getAgent(outsider, { agentId: agent.id }));
    await expectCode('execution_not_found', () => getAgentExecution(outsider, { executionId: execution.id }));
    await expectCode('execution_not_found', () =>
      listAgentExecutionAttempts(outsider, { executionId: execution.id }),
    );
    expect(await listAgents(outsider, {})).toEqual([]);
    expect(await listAgentExecutions(outsider, {})).toEqual([]);

    // The outsider cannot even submit against the owner's agent: a
    // foreign agent is indistinguishable from a missing one.
    await expectCode('agent_not_found', () =>
      submitAgentExecution(outsider, { agentId: agent.id, ...ANALYZE_SUBMISSION }),
    );

    // Running or cancelling a foreign execution fails uniformly.
    await expectCode('execution_not_found', () => runAgentExecution(outsider, { executionId: execution.id }));
    await expectCode('execution_not_found', () =>
      cancelAgentExecution(outsider, { executionId: execution.id, reason: 'not mine' }),
    );

    // The owner's evidence is intact.
    const attempts = await listAgentExecutionAttempts(owner, { executionId: execution.id });
    expect(attempts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (append-only evidence, immutable submissions)
// ---------------------------------------------------------------------------

describe('agents service — storage discipline', () => {
  it('attempts are append-only: UPDATE and DELETE are rejected at the storage level', async () => {
    const admin = agentsAdmin(tenantStorage);
    const agent = await register(admin, ANALYST);
    const submitting = member(tenantStorage);
    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });
    await runAgentExecution(submitting, { executionId: execution.id });
    const attempts = await listAgentExecutionAttempts(submitting, { executionId: execution.id });
    expect(attempts).toHaveLength(1);

    const db = getDb();
    await expect(
      db.query(`UPDATE agent_execution_attempts SET error_code = 'x' WHERE tenant_id = $1`, [
        tenantStorage,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM agent_execution_attempts WHERE tenant_id = $1`, [tenantStorage]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`TRUNCATE agent_execution_attempts`),
    ).rejects.toThrow(/append-only/);
  });

  it('executions: DELETE/TRUNCATE rejected; substantive fields frozen; state shapes enforced', async () => {
    const admin = agentsAdmin(tenantStorage);
    const agent = await register(admin, { ...ANALYST, slug: 'frozen-runtime' });
    const submitting = member(tenantStorage);
    const execution = await submitAgentExecution(submitting, {
      agentId: agent.id,
      ...ANALYZE_SUBMISSION,
    });

    const db = getDb();
    await expect(
      db.query(`UPDATE agent_executions SET task = '{"hacked": true}' WHERE id = $1`, [execution.id]),
    ).rejects.toThrow(/only the live state/);
    await expect(
      db.query(`UPDATE agent_executions SET max_attempts = 5 WHERE id = $1`, [execution.id]),
    ).rejects.toThrow(/only the live state/);
    await expect(
      db.query(`UPDATE agent_executions SET authority_level = 'OBSERVE' WHERE id = $1`, [execution.id]),
    ).rejects.toThrow(/only the live state/);
    await expect(db.query(`DELETE FROM agent_executions WHERE id = $1`, [execution.id])).rejects.toThrow(
      /immutable history/,
    );
    await expect(db.query(`TRUNCATE agent_executions`)).rejects.toThrow(/immutable history/);

    // Even the allowed live-state columns cannot produce an inconsistent
    // shape: 'succeeded' requires a result (CHECK constraint).
    await expect(
      db.query(`UPDATE agent_executions SET status = 'succeeded', completed_at = now() WHERE id = $1`, [
        execution.id,
      ]),
    ).rejects.toThrow();
  });
});
