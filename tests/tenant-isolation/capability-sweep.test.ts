// W044 — Tenant Isolation Verification · application-boundary sweep for the
// capability-workforce and learning modules: actions (W009), agents (W021),
// extensions (W025/W026) and learning (W040 outcomes).
//
// Same doctrine as the other sweeps, plus the authorization dimension the
// work item calls out ("automated AUTHORIZATION and integration tests"):
//   * authority-policy rows are per-tenant — forbidding a level in tenant A
//     never changes tenant B's matrix;
//   * approvals cannot be decided across tenants even with the approve
//     claim (and the requester-separation rule is orthogonal to that);
//   * agent definitions share slugs per-tenant and executions/attempt
//     histories never leak;
//   * extension runtime state is namespaced per tenant even for the same
//     extension key, and dispatch fans out only to the caller's installs;
//   * learning outcomes ground on in-tenant executions only.
//
// Process-global transport ports (agents) are wired per file and unwired in
// afterAll (house pattern; vitest isolates files, cleanup is hygiene).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  authorizeAction,
  decideApproval,
  getActionRequest,
  listActionRequests,
  listApprovalDecisions,
  resolveAuthorityPolicy,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import {
  decideAgentLifecycle,
  getAgentEvaluation,
  getAgentLifecycleDecision,
  listAgentEvaluations,
  listAgentLifecycleDecisions,
  recordAgentEvaluation,
  settleAgentLifecycleDecision,
} from '@/modules/agent-evaluation/contract';
import {
  createRecruitmentProposal,
  getRecruitmentProposal,
  listRecruitmentProposals,
  requestRecruitmentApproval,
  settleRecruitmentProposal,
  withdrawRecruitmentProposal,
  type CreateRecruitmentProposalInput,
} from '@/modules/agent-recruitment/contract';
import {
  activateTeam,
  createTeam,
  dissolveTeam,
  getTeam,
  listTeamOutcomes,
  listTeamVersions,
  listTeams,
  recordTeamOutcome,
  reviseTeam,
  type CreateTeamInput,
} from '@/modules/agent-teams/contract';
import {
  cancelAgentExecution,
  getAgent,
  getAgentExecution,
  listAgentExecutionAttempts,
  listAgentExecutions,
  listAgents,
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
  updateAgent,
  type AgentPermissionScope,
  type AgentRuntimeTransport,
  type AgentRuntimeTransportReceipt,
  type AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';
import {
  deployExtensionVersion,
  dispatchExtensionEvent,
  emitExtensionTelemetry,
  executeExtensionExternalCall,
  getCurrentDeployment,
  getExtension,
  getManifest,
  listExtensionDeployments,
  listExtensionEventDeliveries,
  listExtensionExternalCalls,
  listExtensionScheduleRuns,
  listExtensionTelemetryEvents,
  listExtensions,
  publishExtensionUi,
  readExtensionState,
  registerExtensionManifest,
  rollbackExtensionDeployment,
  runManifestVerification,
  setExtensionHttpPort,
  transitionExtension,
  triggerExtensionSchedule,
  writeExtensionState,
  type RegisterExtensionManifestInput,
} from '@/modules/extensions/contract';
import {
  abandonOutcome,
  defineOutcome,
  getMeasurement,
  getOutcome,
  listMeasurements,
  listOutcomes,
  recordMeasurement,
  settleOutcome,
  summarizeRealization,
} from '@/modules/learning/contract';
import {
  applyRewardPolicy,
  getReward,
  getRewardPolicy,
  listRewards,
  setRewardPolicy,
  settleReward,
  summarizeRewards,
  type ApplyRewardPolicyInput,
  type SetRewardPolicyInput,
} from '@/modules/rewards/contract';
import { startExecution } from '@/modules/cognition/contract';
import { registerCapability } from '@/modules/capabilities/contract';
import { createMission } from '@/modules/missions/contract';
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  memberWith,
  OMNIPOTENT_AUTHORITY,
  omnipotent,
  runMigrations,
} from './harness';

const tenantA = newId();
const tenantB = newId();
const ctxA = member(tenantA);
const ctxB = member(tenantB);

/** Extension-managing principals (claim-gated registry operations). */
const extAdminA = memberWith(tenantA, ['extensions:administer']);
const extAdminB = memberWith(tenantB, ['extensions:administer']);
/** Actions administrators (policy writes) and approvers (decision writes). */
const actionsAdminA = memberWith(tenantA, ['actions:administer']);
const actionsAdminB = memberWith(tenantB, ['actions:administer']);
const approverA = memberWith(tenantA, ['actions:approve']);
const approverB = memberWith(tenantB, ['actions:approve']);

beforeAll(async () => {
  await runMigrations(getDb());
  // Both tenants pin "extension-deployment EXECUTE is allowed" so lifecycle
  // and deployments apply immediately (the isolation probes below do not
  // depend on the gate being open — they fail earlier, at resolution).
  await setAuthorityPolicy(actionsAdminA, { actionKind: 'extension-deployment', approvalLevels: [] });
  await setAuthorityPolicy(actionsAdminB, { actionKind: 'extension-deployment', approvalLevels: [] });
});

afterAll(async () => {
  setAgentTransport(null);
  setExtensionHttpPort(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// actions (W009)
// ---------------------------------------------------------------------------

describe('W044 actions — the authority matrix is tenant-scoped', () => {
  it('fails cross-tenant request reads and approval decisions uniformly', async () => {
    // A gated request in tenant A (built-in default: EXECUTE needs approval).
    const gateA = await authorizeAction(ctxA, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'collections-agent' },
      justification: 'W044 fixture',
    });
    expect(gateA.status).toBe('pending');

    await expectUniformNotFound(
      'action_request_not_found',
      () => getActionRequest(ctxB, { requestId: gateA.id }),
      () => getActionRequest(ctxB, { requestId: newId() }),
    );
    // B's approver (holding the approve claim) cannot decide A's request.
    await expect(
      decideApproval(approverB, { requestId: gateA.id, decision: 'approve', note: 'pwned' }),
    ).rejects.toMatchObject({ code: 'action_request_not_found' });
    await expect(
      listApprovalDecisions(ctxB, { requestId: gateA.id }),
    ).rejects.toMatchObject({ code: 'action_request_not_found' });
    // The omnipotent principal of B is equally blind.
    await expect(
      decideApproval(omnipotent(tenantB), { requestId: gateA.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'action_request_not_found' });

    // A's request is untouched by B's probes; A's own approver can act.
    const untouched = await getActionRequest(ctxA, { requestId: gateA.id });
    expect(untouched.status).toBe('pending');
    const decided = await decideApproval(approverA, { requestId: gateA.id, decision: 'approve' });
    expect(decided.status).toBe('approved');
  });

  it('scopes idempotency keys and policy rows per tenant', async () => {
    const key = 'w044-iso-key';
    const first = await authorizeAction(ctxA, {
      actionKind: 'source-access',
      authorityLevel: 'OBSERVE',
      payload: { system: 'erp' },
      idempotencyKey: key,
    });
    const replay = await authorizeAction(ctxA, {
      actionKind: 'source-access',
      authorityLevel: 'OBSERVE',
      payload: { system: 'erp' },
      idempotencyKey: key,
    });
    expect(replay.id).toBe(first.id); // idempotent inside A

    const inB = await authorizeAction(ctxB, {
      actionKind: 'source-access',
      authorityLevel: 'OBSERVE',
      payload: { system: 'erp' },
      idempotencyKey: key,
    });
    expect(inB.id).not.toBe(first.id); // same key, independent namespace

    // A forbids OBSERVE source-access; B's matrix is unchanged.
    await setAuthorityPolicy(actionsAdminA, {
      actionKind: 'source-access',
      forbiddenLevels: ['OBSERVE'],
      note: 'A locks down',
    });
    // A forbidden level is a POLICY REJECTION (recorded request with status
    // 'rejected'), not a thrown error — the request itself is evidence.
    const refusedInA = await authorizeAction(ctxA, {
      actionKind: 'source-access',
      authorityLevel: 'OBSERVE',
      payload: { system: 'erp' },
    });
    expect(refusedInA.status).toBe('rejected');
    expect(refusedInA.evaluation.outcome).toBe('forbidden');
    const bPolicy = await resolveAuthorityPolicy(ctxB, { actionKind: 'source-access' });
    expect(bPolicy.forbiddenLevels).not.toContain('OBSERVE');

    // Listings stay per-tenant.
    const aRequests = await listActionRequests(ctxA, {});
    const bRequests = await listActionRequests(ctxB, {});
    expect(bRequests.map((request) => request.id)).not.toContain(first.id);
    expect(aRequests.map((request) => request.id)).not.toContain(inB.id);
  });
});

// ---------------------------------------------------------------------------
// agents (W021)
// ---------------------------------------------------------------------------

/** Deterministic fake runtime transport (no provider SDK, no network). */
class FakeAgentTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];
  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.requests.push(request);
    // openai-assistants runtime-NATIVE dialect, as the module's adapter parses it.
    return {
      status: 'delivered',
      payload: {
        id: 'run_fake-000001',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"triaged":true}' }],
          },
        ],
        usage: { input_tokens: 1200, output_tokens: 800 },
      },
      providerTaskId: 'fake-000001',
      detail: null,
    };
  }
}

describe('W044 agents — definitions and executions are tenant-scoped', () => {
  const ANALYST = {
    slug: 'triage-analyst',
    displayName: 'Triage Analyst',
    role: 'conversation triage',
    description: 'Triages inbound conversations and drafts replies.',
    provider: 'openai-assistants' as const,
    instructions: 'Triage the conversation and propose a reply.',
    permissions: ['observe', 'analyze', 'recommend'] as AgentPermissionScope[],
    runtimeConfig: { assistantId: 'asst_triage' },
  };

  const agentsAdminA = memberWith(tenantA, ['agents:administer']);
  const agentsAdminB = memberWith(tenantB, ['agents:administer']);

  it('gives the same agent slug independent definitions per tenant', async () => {
    const { agent: agentA } = await registerAgent(agentsAdminA, ANALYST);
    const { agent: agentB } = await registerAgent(agentsAdminB, ANALYST);
    expect(agentA.id).not.toBe(agentB.id);
    expect((await listAgents(ctxB, {})).map((agent) => agent.id)).not.toContain(agentA.id);
  });

  it('fails cross-tenant reads and submissions uniformly', async () => {
    const { agent: agentA } = await registerAgent(agentsAdminA, ANALYST);

    await expectUniformNotFound(
      'agent_not_found',
      () => getAgent(ctxB, { agentId: agentA.id }),
      () => getAgent(ctxB, { agentId: newId() }),
    );
    await expect(
      updateAgent(agentsAdminB, { agentId: agentA.id, displayName: 'Pwned by B' }),
    ).rejects.toMatchObject({ code: 'agent_not_found' });
    await expect(
      submitAgentExecution(ctxB, {
        agentId: agentA.id,
        task: { goal: 'pwn' },
        requestedPermissions: ['observe', 'analyze'],
      }),
    ).rejects.toMatchObject({ code: 'agent_not_found' });
    // The omnipotent principal of B cannot submit against A's agent either.
    await expect(
      submitAgentExecution(omnipotent(tenantB), {
        agentId: agentA.id,
        task: { goal: 'pwn' },
        requestedPermissions: ['observe', 'analyze'],
      }),
    ).rejects.toMatchObject({ code: 'agent_not_found' });
    expect((await getAgent(ctxA, { agentId: agentA.id })).displayName).toBe('Triage Analyst');
  });

  it('isolates executions, attempts and the runtime pump per tenant', async () => {
    const transport = new FakeAgentTransport();
    setAgentTransport(transport);

    const { agent: agentA } = await registerAgent(agentsAdminA, ANALYST);
    const { agent: agentB } = await registerAgent(agentsAdminB, ANALYST);

    const executionA = await submitAgentExecution(ctxA, {
      agentId: agentA.id,
      task: { conversationId: 'conv-17', goal: 'alpha task' },
      requestedPermissions: ['observe', 'analyze'],
      idempotencyKey: 'w044-agent-key',
    });
    const runA = await runAgentExecution(ctxA, { executionId: executionA.id });
    expect(runA.status).toBe('succeeded');

    // Same idempotency key in B is an independent execution of B's agent.
    const executionB = await submitAgentExecution(ctxB, {
      agentId: agentB.id,
      task: { conversationId: 'conv-17', goal: 'beta task' },
      requestedPermissions: ['observe', 'analyze'],
      idempotencyKey: 'w044-agent-key',
    });
    expect(executionB.id).not.toBe(executionA.id);

    const requestsBefore = transport.requests.length;
    await expectUniformNotFound(
      'execution_not_found',
      () => getAgentExecution(ctxB, { executionId: executionA.id }),
      () => getAgentExecution(ctxB, { executionId: newId() }),
    );
    await expect(
      runAgentExecution(ctxB, { executionId: executionA.id }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });
    await expect(
      cancelAgentExecution(ctxB, { executionId: executionA.id, reason: 'pwn' }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });
    await expect(
      listAgentExecutionAttempts(ctxB, { executionId: executionA.id }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });

    // A's execution did not run again and the transport saw no new dispatch.
    expect(transport.requests.length).toBe(requestsBefore);
    expect((await listAgentExecutions(ctxB, {})).map((execution) => execution.id)).not.toContain(
      executionA.id,
    );
    // A's own history is intact.
    expect(await listAgentExecutionAttempts(ctxA, { executionId: executionA.id })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extensions (W025/W026)
// ---------------------------------------------------------------------------

describe('W044 extensions — registry and runtime are tenant-scoped', () => {
  function manifestInput(overrides: Partial<RegisterExtensionManifestInput> = {}): RegisterExtensionManifestInput {
    return {
      extensionKey: 'invoice-ocr',
      version: '1.0.0',
      manifestSchemaVersion: 1,
      displayName: 'Invoice OCR',
      description: 'Reads invoices into the world model',
      requestedPermissions: ['state:read', 'state:write', 'ui:render', 'schedule:run', 'events:subscribe', 'external:participate', 'telemetry:emit'],
      stateScope: 'tenant',
      uiSurfaces: ['control-tower-panel'],
      schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
      eventSubscriptions: ['invoice.received', 'invoice.paid'],
      externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
      telemetry: true,
      quotas: { maxStateBytes: 1_048_576, maxScheduleInvocationsPerDay: 3, maxExternalCallsPerDay: 2 },
      hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
      ...overrides,
    };
  }

  /** Register + verify + activate + deploy + write one state key. */
  async function deployedExtension(
    admin: TenantContext,
    requester: TenantContext,
    manifest: RegisterExtensionManifestInput,
  ): Promise<{ extensionId: string; manifestId: string; deploymentId: string }> {
    const registered = await registerExtensionManifest(admin, manifest);
    const verification = await runManifestVerification(admin, { manifestId: registered.manifest.id });
    expect(verification.state).toBe('VERIFIED');
    await transitionExtension(requester, {
      extensionId: registered.extension.id,
      transition: 'activate',
      idempotencyKey: `activate:${manifest.extensionKey}:${manifest.version}`,
    });
    const deployed = await deployExtensionVersion(requester, {
      extensionId: registered.extension.id,
      version: manifest.version,
      idempotencyKey: `deploy:${manifest.extensionKey}:${manifest.version}`,
    });
    expect(deployed.applied).toBe(true);
    return {
      extensionId: registered.extension.id,
      manifestId: registered.manifest.id,
      deploymentId: deployed.deployment!.id,
    };
  }

  it('gives the same extension key independent lifecycles and state per tenant', async () => {
    const sharedKey = `invoice-ocr-${newId().slice(0, 8)}`;
    const alpha = await deployedExtension(extAdminA, ctxA, manifestInput({ extensionKey: sharedKey }));
    const beta = await deployedExtension(extAdminB, ctxB, manifestInput({ extensionKey: sharedKey, version: '2.0.0' }));

    expect(alpha.extensionId).not.toBe(beta.extensionId);
    expect((await getExtension(ctxB, { extensionKey: sharedKey })).latestVersion).toBe('2.0.0');
    expect((await getExtension(ctxA, { extensionKey: sharedKey })).latestVersion).toBe('1.0.0');

    // State namespaces are per tenant even for the same key/value slot.
    await writeExtensionState(ctxA, { extensionId: alpha.extensionId, key: 'secret', value: 'alpha-value' });
    await writeExtensionState(ctxB, { extensionId: beta.extensionId, key: 'secret', value: 'beta-value' });
    expect((await readExtensionState(ctxA, { extensionId: alpha.extensionId, key: 'secret' }))?.value).toBe('alpha-value');
    expect((await readExtensionState(ctxB, { extensionId: beta.extensionId, key: 'secret' }))?.value).toBe('beta-value');
  });

  it('makes every runtime surface blind to another tenant (uniform not-found)', async () => {
    const alpha = await deployedExtension(extAdminA, ctxA, manifestInput({ extensionKey: `iso-blinder-${newId().slice(0, 8)}` }));

    await expectUniformNotFound(
      'extension_not_found',
      () => getExtension(ctxB, { extensionId: alpha.extensionId }),
      () => getExtension(ctxB, { extensionId: newId() }),
    );
    await expect(
      readExtensionState(ctxB, { extensionId: alpha.extensionId, key: 'secret' }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      writeExtensionState(ctxB, { extensionId: alpha.extensionId, key: 'secret', value: 'pwned' }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      publishExtensionUi(ctxB, {
        extensionId: alpha.extensionId,
        surface: 'control-tower-panel',
        document: { title: null, blocks: [] },
      }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      triggerExtensionSchedule(ctxB, { extensionId: alpha.extensionId, scheduleName: 'nightly-sync' }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      listExtensionScheduleRuns(ctxB, { extensionId: alpha.extensionId }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      executeExtensionExternalCall(ctxB, {
        extensionId: alpha.extensionId,
        origin: 'https://api.invoices.example.com',
        method: 'GET',
        path: '/',
      }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      listExtensionExternalCalls(ctxB, { extensionId: alpha.extensionId }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      emitExtensionTelemetry(ctxB, { extensionId: alpha.extensionId, name: 'run.completed' }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      listExtensionTelemetryEvents(ctxB, { extensionId: alpha.extensionId }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      getCurrentDeployment(ctxB, { extensionId: alpha.extensionId }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      listExtensionDeployments(ctxB, { extensionId: alpha.extensionId }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    await expect(
      deployExtensionVersion(ctxB, { extensionId: alpha.extensionId, version: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });

    // The omnipotent principal of B is blind on every surface too.
    await expect(
      readExtensionState(omnipotent(tenantB), { extensionId: alpha.extensionId, key: 'secret' }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });

    // A's state survived every B probe untouched.
    await writeExtensionState(ctxA, { extensionId: alpha.extensionId, key: 'secret', value: 'alpha-guard' });
    expect((await readExtensionState(ctxA, { extensionId: alpha.extensionId, key: 'secret' }))?.value).toBe(
      'alpha-guard',
    );
  });

  it('fails cross-tenant manifest and deployment references uniformly', async () => {
    const alpha = await deployedExtension(extAdminA, ctxA, manifestInput({ extensionKey: `iso-manifest-${newId().slice(0, 8)}` }));

    await expectUniformNotFound(
      'manifest_not_found',
      () => getManifest(ctxB, { manifestId: alpha.manifestId }),
      () => getManifest(ctxB, { manifestId: newId() }),
    );
    await expect(
      runManifestVerification(extAdminB, { manifestId: alpha.manifestId }),
    ).rejects.toMatchObject({ code: 'manifest_not_found' });

    // B has its own extension; a foreign DEPLOYMENT id under it is exactly a
    // missing deployment — not a cross-tenant write target.
    const beta = await deployedExtension(extAdminB, ctxB, manifestInput({ extensionKey: `iso-manifest-beta-${newId().slice(0, 8)}`, version: '3.0.0' }));
    await expectUniformNotFound(
      'deployment_not_found',
      () =>
        rollbackExtensionDeployment(ctxB, {
          extensionId: beta.extensionId,
          targetDeploymentId: alpha.deploymentId,
        }),
      () =>
        rollbackExtensionDeployment(ctxB, {
          extensionId: beta.extensionId,
          targetDeploymentId: newId(),
        }),
    );
  });

  it('dispatches events only to the calling tenant installs', async () => {
    const dispatchKey = `invoice-ocr-${newId().slice(0, 8)}`;
    const alpha = await deployedExtension(extAdminA, ctxA, manifestInput({ extensionKey: dispatchKey }));
    const beta = await deployedExtension(extAdminB, ctxB, manifestInput({ extensionKey: dispatchKey, version: '4.0.0' }));
    const deliveriesFor = async (ctx: TenantContext, extensionId: string) =>
      (await listExtensionEventDeliveries(ctx, { extensionId })).filter(
        (delivery) => delivery.topic === 'invoice.paid',
      );

    // B's dispatch fans out across ALL of B's subscribed installs (earlier
    // tests in this file deployed more B-side extensions) — but never to A.
    const dispatchInB = await dispatchExtensionEvent(ctxB, { topic: 'invoice.paid' });
    expect(dispatchInB.delivered).toBeGreaterThanOrEqual(1);
    expect(await deliveriesFor(ctxA, alpha.extensionId)).toHaveLength(0); // A untouched

    // A's dispatch reaches A's install — and never B's.
    const dispatchInA = await dispatchExtensionEvent(ctxA, { topic: 'invoice.paid' });
    expect(dispatchInA.delivered).toBeGreaterThanOrEqual(1);
    expect(await deliveriesFor(ctxA, alpha.extensionId)).toHaveLength(1);
    expect(await deliveriesFor(ctxB, beta.extensionId)).toHaveLength(1); // only B's own dispatch

    // Cross-tenant listing is blind to the foreign extension entirely.
    await expect(
      listExtensionEventDeliveries(ctxB, { extensionId: alpha.extensionId }),
    ).rejects.toMatchObject({ code: 'extension_not_found' });
    expect((await listExtensions(ctxB, {})).map((extension) => extension.id)).not.toContain(
      alpha.extensionId,
    );
  });
});

// ---------------------------------------------------------------------------
// learning (W040)
// ---------------------------------------------------------------------------

describe('W044 learning — outcomes are tenant-scoped', () => {
  const outcomeInput = () => ({
    subject: { kind: 'agent' as const, id: newId(), label: 'Collections agent' },
    metricName: 'tickets resolved per week',
    metricUnit: 'tickets',
    direction: 'at_least' as const,
    baseline: 120,
    expected: 180,
    actor: { kind: 'person' as const, id: newId() },
    rationale: 'W044 fixture',
  });

  it('gives the same subject independent outcomes per tenant', async () => {
    const subjectId = newId();
    const input = { ...outcomeInput(), subject: { kind: 'agent' as const, id: subjectId, label: 'Collections agent' } };
    const outcomeA = await defineOutcome(ctxA, input);
    const outcomeB = await defineOutcome(ctxB, input);
    expect(outcomeA.id).not.toBe(outcomeB.id);
    expect((await listOutcomes(ctxB, {})).map((outcome) => outcome.id)).not.toContain(outcomeA.id);
  });

  it('fails cross-tenant reads, measurements and settlements uniformly', async () => {
    const bOutcomesBefore = (await listOutcomes(ctxB, {})).length;
    const outcomeA = await defineOutcome(ctxA, outcomeInput());
    const measurementA = await recordMeasurement(ctxA, {
      outcomeId: outcomeA.id,
      value: 170,
      actor: { kind: 'system', label: 'helpdesk' },
    });

    await expectUniformNotFound(
      'outcome_not_found',
      () => getOutcome(ctxB, outcomeA.id),
      () => getOutcome(ctxB, newId()),
    );
    await expectUniformNotFound(
      'measurement_not_found',
      () => getMeasurement(ctxB, measurementA.id),
      () => getMeasurement(ctxB, newId()),
    );
    await expect(
      listMeasurements(ctxB, { outcomeId: outcomeA.id }),
    ).rejects.toMatchObject({ code: 'outcome_not_found' });
    await expect(
      recordMeasurement(ctxB, { outcomeId: outcomeA.id, value: 999, actor: { kind: 'system', label: 'beta' } }),
    ).rejects.toMatchObject({ code: 'outcome_not_found' });
    await expect(
      settleOutcome(ctxB, {
        outcomeId: outcomeA.id,
        measurementId: measurementA.id,
        actor: { kind: 'person', id: newId() },
      }),
    ).rejects.toMatchObject({ code: 'outcome_not_found' });
    await expect(
      abandonOutcome(ctxB, { outcomeId: outcomeA.id, reason: 'pwn', actor: { kind: 'person', id: newId() } }),
    ).rejects.toMatchObject({ code: 'outcome_not_found' });

    // A's outcome is still open and measurable after B's probes.
    const still = await getOutcome(ctxA, outcomeA.id);
    expect(still.status).toBe('open');
    // B's realization summary counts only B's own outcomes — A's outcome
    // never enters it (A-side probes above created nothing in B).
    const summaryB = await summarizeRealization(ctxB, {});
    expect(summaryB.overall.total).toBe(bOutcomesBefore);
  });

  it('rejects outcomes grounded on another tenant execution', async () => {
    const executionA = await startExecution(ctxA, {
      trigger: { kind: 'management', label: 'W044 origin' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W044 fixture',
    });
    await expect(
      defineOutcome(ctxB, { ...outcomeInput(), originExecutionId: executionA.id }),
    ).rejects.toMatchObject({ code: 'invalid_origin_ref' });
  });
});

// ---------------------------------------------------------------------------
// agent-evaluation (W024)
// ---------------------------------------------------------------------------

describe('W044 agent-evaluation — measurements and lifecycle decisions are tenant-scoped', () => {
  const MEASURED = {
    slug: 'collections-analyst',
    displayName: 'Collections Analyst',
    role: 'collections triage',
    description: 'Prioritizes overdue invoices for the collections team.',
    provider: 'openai-assistants' as const,
    instructions: 'Triage overdue invoices and propose next actions.',
    permissions: ['observe', 'analyze', 'recommend'] as AgentPermissionScope[],
    runtimeConfig: { assistantId: 'asst_collections' },
  };

  /** Lifecycle decisions are management actions (the W021 claim). */
  const evalAdminA = memberWith(tenantA, ['agents:administer']);
  const evalAdminB = memberWith(tenantB, ['agents:administer']);

  const replacementOptions = () => [
    { kind: 'retain' as const, summary: 'Keep the current agent unchanged.', recommended: true },
    { kind: 'eliminate' as const, summary: 'Retire the capability if the agent keeps missing.' },
  ];

  it('gives the same agent slug independent evaluations per tenant', async () => {
    const { agent: agentA } = await registerAgent(evalAdminA, MEASURED);
    const { agent: agentB } = await registerAgent(evalAdminB, MEASURED);
    const evaluationA = await recordAgentEvaluation(ctxA, {
      agentId: agentA.id,
      replacementOptions: replacementOptions(),
    });
    const evaluationB = await recordAgentEvaluation(ctxB, {
      agentId: agentB.id,
      replacementOptions: replacementOptions(),
    });
    expect(evaluationA.id).not.toBe(evaluationB.id);
    expect((await listAgentEvaluations(ctxB, {})).map((evaluation) => evaluation.id)).not.toContain(
      evaluationA.id,
    );
    expect((await listAgentEvaluations(ctxA, {})).map((evaluation) => evaluation.id)).not.toContain(
      evaluationB.id,
    );
  });

  it('fails cross-tenant reads of evaluations and decisions uniformly', async () => {
    const { agent: agentA } = await registerAgent(evalAdminA, MEASURED);
    const evaluationA = await recordAgentEvaluation(ctxA, {
      agentId: agentA.id,
      replacementOptions: replacementOptions(),
    });
    const decisionA = await decideAgentLifecycle(evalAdminA, {
      evaluationId: evaluationA.id,
      change: 'retain',
      rationale: 'Steady measured performance across the window.',
    });
    expect(decisionA.status).toBe('recorded');

    await expectUniformNotFound(
      'evaluation_not_found',
      () => getAgentEvaluation(ctxB, { evaluationId: evaluationA.id }),
      () => getAgentEvaluation(ctxB, { evaluationId: newId() }),
    );
    await expectUniformNotFound(
      'decision_not_found',
      () => getAgentLifecycleDecision(ctxB, { decisionId: decisionA.id }),
      () => getAgentLifecycleDecision(ctxB, { decisionId: newId() }),
    );
    // The omnipotent principal of B is equally blind.
    await expect(
      getAgentEvaluation(omnipotent(tenantB), { evaluationId: evaluationA.id }),
    ).rejects.toMatchObject({ code: 'evaluation_not_found' });
  });

  it('rejects cross-tenant decisions and foreign-agent measurements', async () => {
    const { agent: agentA } = await registerAgent(evalAdminA, MEASURED);
    const evaluationA = await recordAgentEvaluation(ctxA, {
      agentId: agentA.id,
      replacementOptions: replacementOptions(),
    });
    const decisionA = await decideAgentLifecycle(evalAdminA, {
      evaluationId: evaluationA.id,
      change: 'retain',
      rationale: 'Measured cost and quality hold the line.',
    });

    // B cannot even measure A's agent — the agents contract is the wall, and
    // a foreign agent id is indistinguishable from a missing one.
    await expectUniformNotFound(
      'agent_not_found',
      () =>
        recordAgentEvaluation(ctxB, {
          agentId: agentA.id,
          replacementOptions: replacementOptions(),
        }),
      () =>
        recordAgentEvaluation(ctxB, {
          agentId: newId(),
          replacementOptions: replacementOptions(),
        }),
    );
    // B's workforce administrator (and B's omnipotent principal) cannot
    // decide on A's evidence or settle A's decision — the administer claim
    // authorizes operations within a tenant, never across.
    await expect(
      decideAgentLifecycle(evalAdminB, {
        evaluationId: evaluationA.id,
        change: 'terminate',
        rationale: 'pwn',
      }),
    ).rejects.toMatchObject({ code: 'evaluation_not_found' });
    await expect(
      decideAgentLifecycle(omnipotent(tenantB), {
        evaluationId: evaluationA.id,
        change: 'terminate',
        rationale: 'pwn',
      }),
    ).rejects.toMatchObject({ code: 'evaluation_not_found' });
    await expect(
      settleAgentLifecycleDecision(evalAdminB, { decisionId: decisionA.id }),
    ).rejects.toMatchObject({ code: 'decision_not_found' });

    // A's evidence survived every B probe untouched.
    expect((await getAgentEvaluation(ctxA, { evaluationId: evaluationA.id })).agentId).toBe(
      agentA.id,
    );
    expect((await getAgentLifecycleDecision(ctxA, { decisionId: decisionA.id })).status).toBe(
      'recorded',
    );
    expect((await listAgentLifecycleDecisions(ctxB, {})).map((decision) => decision.id)).not.toContain(
      decisionA.id,
    );
  });

  it('keeps the termination gate and its settlement per tenant', async () => {
    const { agent: agentA } = await registerAgent(evalAdminA, MEASURED);
    const evaluationA = await recordAgentEvaluation(ctxA, {
      agentId: agentA.id,
      replacementOptions: replacementOptions(),
    });
    // TERMINATE follows policy: under the built-in default matrix the gate
    // holds the decision for an explicit human decision.
    const termination = await decideAgentLifecycle(evalAdminA, {
      evaluationId: evaluationA.id,
      change: 'terminate',
      rationale: 'Retiring the prototype; the measured cost never landed.',
    });
    expect(termination.status).toBe('awaiting_approval');

    // B's settle cannot land on A's decision — uniform not-found — and A's
    // decision keeps waiting.
    await expect(
      settleAgentLifecycleDecision(evalAdminB, { decisionId: termination.id }),
    ).rejects.toMatchObject({ code: 'decision_not_found' });
    expect(
      (await getAgentLifecycleDecision(ctxA, { decisionId: termination.id })).status,
    ).toBe('awaiting_approval');

    // A's human approves the gate; A's settle applies the termination.
    await decideApproval(approverA, {
      requestId: termination.policy!.actionRequestId,
      decision: 'approve',
    });
    const applied = await settleAgentLifecycleDecision(evalAdminA, { decisionId: termination.id });
    expect(applied.status).toBe('applied');
    expect((await getAgent(ctxA, { agentId: agentA.id })).status).toBe('disabled');
    // B's decision history never saw A's termination.
    expect((await listAgentLifecycleDecisions(ctxB, {})).map((decision) => decision.id)).not.toContain(
      termination.id,
    );
  });
});

// ---------------------------------------------------------------------------
// agent-recruitment (W022)
// ---------------------------------------------------------------------------

describe('W044 agent-recruitment — proposals and approvals are tenant-scoped', () => {
  /** Withdrawing another principal's draft needs the workforce claim. */
  const workforceAdminB = memberWith(tenantB, ['agents:administer']);

  const alternatives = () => [
    { kind: 'train' as const, summary: 'Coach the existing collector on German.' },
    { kind: 'recruit' as const, summary: 'Recruit a German-support agent.', recommended: true },
  ];

  function proposalInput(capabilityId: string): CreateRecruitmentProposalInput {
    return {
      title: 'Close the German-language support gap',
      capabilityId,
      rationale: 'German support volume tripled; first response now breaches policy.',
      alternatives: alternatives(),
    };
  }

  async function capability(ctx: TenantContext, name: string) {
    return registerCapability(ctx, { name, actor: { kind: 'person', id: newId() } });
  }

  it('gives the same capability name and proposal title independent rows per tenant', async () => {
    const name = `german-support-${newId().slice(0, 8)}`;
    const capabilityA = await capability(ctxA, name);
    const capabilityB = await capability(ctxB, name);
    expect(capabilityA.id).not.toBe(capabilityB.id);

    const proposalA = await createRecruitmentProposal(ctxA, proposalInput(capabilityA.id));
    const proposalB = await createRecruitmentProposal(ctxB, proposalInput(capabilityB.id));
    expect(proposalA.id).not.toBe(proposalB.id);
    expect((await listRecruitmentProposals(ctxB, {})).map((proposal) => proposal.id)).not.toContain(
      proposalA.id,
    );
    expect((await listRecruitmentProposals(ctxA, {})).map((proposal) => proposal.id)).not.toContain(
      proposalB.id,
    );
  });

  it('fails cross-tenant reads and lifecycle writes uniformly', async () => {
    const capabilityA = await capability(ctxA, `iso-recruit-${newId().slice(0, 8)}`);
    const proposalA = await createRecruitmentProposal(ctxA, proposalInput(capabilityA.id));

    await expectUniformNotFound(
      'proposal_not_found',
      () => getRecruitmentProposal(ctxB, { proposalId: proposalA.id }),
      () => getRecruitmentProposal(ctxB, { proposalId: newId() }),
    );
    await expect(
      requestRecruitmentApproval(ctxB, { proposalId: proposalA.id }),
    ).rejects.toMatchObject({ code: 'proposal_not_found' });
    await expect(
      settleRecruitmentProposal(ctxB, { proposalId: proposalA.id }),
    ).rejects.toMatchObject({ code: 'proposal_not_found' });
    // Even B's workforce administrator cannot withdraw A's draft.
    await expect(
      withdrawRecruitmentProposal(workforceAdminB, { proposalId: proposalA.id, reason: 'pwn' }),
    ).rejects.toMatchObject({ code: 'proposal_not_found' });
    // The omnipotent principal of B is equally blind.
    await expect(
      getRecruitmentProposal(omnipotent(tenantB), { proposalId: proposalA.id }),
    ).rejects.toMatchObject({ code: 'proposal_not_found' });

    // A's draft survived every B probe untouched.
    expect((await getRecruitmentProposal(ctxA, { proposalId: proposalA.id })).status).toBe('proposed');
  });

  it('rejects proposals grounded on another tenant capability', async () => {
    const capabilityA = await capability(ctxA, `foreign-capability-${newId().slice(0, 8)}`);
    await expectUniformNotFound(
      'capability_not_found',
      () => createRecruitmentProposal(ctxB, proposalInput(capabilityA.id)),
      () => createRecruitmentProposal(ctxB, proposalInput(newId())),
    );
  });

  it('keeps the explicit approval gate per tenant', async () => {
    const capabilityA = await capability(ctxA, `gated-recruit-${newId().slice(0, 8)}`);
    const proposalA = await createRecruitmentProposal(ctxA, proposalInput(capabilityA.id));
    // Approval is explicit: under the built-in default matrix EXECUTE waits
    // for a human decision.
    const submitted = await requestRecruitmentApproval(ctxA, { proposalId: proposalA.id });
    expect(submitted.status).toBe('awaiting_approval');

    // B's settle cannot land a decision on A's proposal.
    await expect(
      settleRecruitmentProposal(ctxB, { proposalId: proposalA.id }),
    ).rejects.toMatchObject({ code: 'proposal_not_found' });
    expect(
      (await getRecruitmentProposal(ctxA, { proposalId: proposalA.id })).status,
    ).toBe('awaiting_approval');

    // A's human decides through the actions gate; A's settle records it.
    await decideApproval(approverA, {
      requestId: submitted.approval.actionRequestId!,
      decision: 'approve',
    });
    const settled = await settleRecruitmentProposal(ctxA, { proposalId: proposalA.id });
    expect(settled.status).toBe('approved');
    expect(settled.approval.decidedBy).toBe('principal');
    expect(
      (await listRecruitmentProposals(ctxB, { status: 'approved' })).map((proposal) => proposal.id),
    ).not.toContain(proposalA.id);
  });
});

// ---------------------------------------------------------------------------
// agent-teams (W023)
// ---------------------------------------------------------------------------

describe('W044 agent-teams — topologies and outcomes are tenant-scoped', () => {
  /** Composing organizational actors is a management action (W021 claim). */
  const teamsAdminA = memberWith(tenantA, ['agents:administer']);
  const teamsAdminB = memberWith(tenantB, ['agents:administer']);

  async function memberAgent(admin: TenantContext, slug: string): Promise<string> {
    const { agent } = await registerAgent(admin, {
      slug,
      displayName: 'Team Member',
      role: 'collections',
      description: 'Chases overdue invoices for a team.',
      provider: 'openai-assistants' as const,
      instructions: 'Recover overdue invoices courteously.',
      permissions: ['observe', 'analyze'] as AgentPermissionScope[],
      runtimeConfig: { assistantId: 'asst_member' },
    });
    return agent.id;
  }

  function teamInput(slug: string, agentId: string): CreateTeamInput {
    return {
      slug,
      displayName: 'Collections team',
      description: 'Chases overdue invoices under an escalation policy.',
      topology: 'flat',
      members: [{ agentId, role: 'collector' }],
      objectives: [
        { key: 'recovery-rate', objective: 'Recover 80% of overdue invoices within 30 days.' },
      ],
      budget: { amountMinor: 500_000, currency: 'USD' },
    };
  }

  it('gives the same team slug independent identities per tenant', async () => {
    const slug = `collections-${newId().slice(0, 8)}`;
    const agentA = await memberAgent(teamsAdminA, 'collections-collector-alpha');
    const agentB = await memberAgent(teamsAdminB, 'collections-collector-beta');
    const { team: teamA } = await createTeam(teamsAdminA, teamInput(slug, agentA));
    const { team: teamB } = await createTeam(teamsAdminB, teamInput(slug, agentB));
    expect(teamA.id).not.toBe(teamB.id);
    expect((await listTeams(ctxB, {})).map((team) => team.id)).not.toContain(teamA.id);
    // Slug reads resolve inside the caller's own namespace only.
    expect((await getTeam(ctxA, { slug })).id).toBe(teamA.id);
    expect((await getTeam(ctxB, { slug })).id).toBe(teamB.id);
  });

  it('fails cross-tenant reads and writes uniformly', async () => {
    const agentA = await memberAgent(teamsAdminA, 'iso-collector-alpha');
    const { team: teamA } = await createTeam(
      teamsAdminA,
      teamInput(`iso-team-${newId().slice(0, 8)}`, agentA),
    );

    await expectUniformNotFound(
      'team_not_found',
      () => getTeam(ctxB, { teamId: teamA.id }),
      () => getTeam(ctxB, { teamId: newId() }),
    );
    await expect(listTeamVersions(ctxB, { teamId: teamA.id })).rejects.toMatchObject({
      code: 'team_not_found',
    });
    // The outcome timeline over a foreign team id is uniformly EMPTY (the
    // tenant-scoped rows are the wall — no leak either way).
    expect(await listTeamOutcomes(ctxB, { teamId: teamA.id })).toEqual([]);

    await expect(
      reviseTeam(teamsAdminB, { teamId: teamA.id, displayName: 'Pwned by B' }),
    ).rejects.toMatchObject({ code: 'team_not_found' });
    await expect(
      activateTeam(teamsAdminB, { teamId: teamA.id }),
    ).rejects.toMatchObject({ code: 'team_not_found' });
    await expect(
      dissolveTeam(teamsAdminB, { teamId: teamA.id, reason: 'pwn' }),
    ).rejects.toMatchObject({ code: 'team_not_found' });
    await expect(
      recordTeamOutcome(ctxB, { teamId: teamA.id, headline: 'pwn', assessment: 'met' }),
    ).rejects.toMatchObject({ code: 'team_not_found' });
    // The omnipotent principal of B is equally blind.
    await expect(getTeam(omnipotent(tenantB), { teamId: teamA.id })).rejects.toMatchObject({
      code: 'team_not_found',
    });

    // A's team survived every B probe untouched (still a draft).
    const still = await getTeam(ctxA, { teamId: teamA.id });
    expect(still.status).toBe('draft');
    expect(still.content.displayName).toBe('Collections team');
  });

  it('rejects rosters referencing another tenant agents', async () => {
    const agentA = await memberAgent(teamsAdminA, 'roster-collector-alpha');
    await expectUniformNotFound(
      'invalid_agent_ref',
      () => createTeam(teamsAdminB, teamInput(`foreign-roster-${newId().slice(0, 8)}`, agentA)),
      () => createTeam(teamsAdminB, teamInput(`missing-roster-${newId().slice(0, 8)}`, newId())),
    );
  });

  it('records outcomes only in the owning tenant', async () => {
    const slug = `outcome-team-${newId().slice(0, 8)}`;
    const agentA = await memberAgent(teamsAdminA, 'outcome-collector-alpha');
    const agentB = await memberAgent(teamsAdminB, 'outcome-collector-beta');
    const { team: teamA } = await createTeam(teamsAdminA, teamInput(slug, agentA));
    const { team: teamB } = await createTeam(teamsAdminB, teamInput(slug, agentB));

    // Walk both teams to ACTIVE through the gated flow: the built-in default
    // matrix holds EXECUTE for a human decision, and re-invoking with the
    // SAME idempotency key replays the (now approved) gate and applies.
    const activate = async (admin: TenantContext, teamId: string, approver: TenantContext) => {
      const idempotencyKey = `w044-activate:${teamId}`;
      const pending = await activateTeam(admin, { teamId, idempotencyKey });
      expect(pending.applied).toBe(false);
      await decideApproval(approver, { requestId: pending.gate.actionRequestId, decision: 'approve' });
      const applied = await activateTeam(admin, { teamId, idempotencyKey });
      expect(applied.applied).toBe(true);
      return applied.team;
    };
    await activate(teamsAdminA, teamA.id, approverA);
    await activate(teamsAdminB, teamB.id, approverB);

    // The same objective key and headline coexist per tenant.
    const outcomeA = await recordTeamOutcome(ctxA, {
      teamId: teamA.id,
      objectiveKey: 'recovery-rate',
      headline: 'Recovery held above 80% for the quarter.',
      assessment: 'met',
    });
    const outcomeB = await recordTeamOutcome(ctxB, {
      teamId: teamB.id,
      objectiveKey: 'recovery-rate',
      headline: 'Recovery held above 80% for the quarter.',
      assessment: 'met',
    });
    expect(outcomeA.id).not.toBe(outcomeB.id);

    // B cannot append to A's timeline; each timeline is exactly its own.
    await expect(
      recordTeamOutcome(ctxB, { teamId: teamA.id, headline: 'pwn', assessment: 'met' }),
    ).rejects.toMatchObject({ code: 'team_not_found' });
    expect(await listTeamOutcomes(ctxA, { teamId: teamA.id })).toHaveLength(1);
    expect(await listTeamOutcomes(ctxB, { teamId: teamB.id })).toHaveLength(1);
    expect(
      (await listTeamOutcomes(ctxA, { teamId: teamA.id, objectiveKey: 'recovery-rate' })).map(
        (outcome) => outcome.id,
      ),
    ).toContain(outcomeA.id);
  });
});

// ---------------------------------------------------------------------------
// rewards (W043)
// ---------------------------------------------------------------------------

describe('W044 rewards — policies and granted rewards are tenant-scoped', () => {
  /** Policy writes are claim-gated (W043's own administration claim). */
  const rewardsAdminA = memberWith(tenantA, ['rewards:administer']);
  const rewardsAdminB = memberWith(tenantB, ['rewards:administer']);
  /**
   * A tenant-B principal holding EVERY authority claim this file's new
   * modules check: the repository-wide set PLUS 'rewards:administer', which
   * the harness's central OMNIPOTENT_AUTHORITY list does not carry yet
   * (report to the orchestrator: extend the central list with it).
   * Authority authorizes operations, never tenant scope — this principal
   * must stay blind to tenant A.
   */
  const blindB = memberWith(tenantB, [...OMNIPOTENT_AUTHORITY, 'rewards:administer']);

  function policyInput(): SetRewardPolicyInput {
    return {
      tiers: [{ name: 'thank-you-gift', minValueScore: 0.5, kind: 'gift', amount: 100_00 }],
      rewardCurrency: 'USD',
    };
  }

  function missionInput() {
    return {
      title: 'Churn root cause',
      knowledgeObjective: 'Why did churn rise in Q3?',
      informationValue: 0.8,
      urgency: 'high' as const,
      currentConfidence: 0.1,
      targetConfidence: 0.85,
      investigationBudget: { amount: 250_00, currency: 'USD' },
      rewardBudget: { amount: 500_000, currency: 'USD' },
      completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
      actor: { kind: 'person' as const, id: newId() },
    };
  }

  function contributionInput(missionId: string, contributionId: string): ApplyRewardPolicyInput {
    return {
      contribution: {
        kind: 'knowledge-contribution',
        id: contributionId,
        contributor: { personId: newId(), label: 'Dana' },
      },
      missionId,
      value: {
        status: 'measured',
        knowledgeGain: 0.9,
        missionImpact: 'resolved',
        affectedGoals: [{ goalId: newId() }],
        costAvoided: { amount: 50_000, currency: 'USD' },
      },
      actor: { kind: 'person', id: newId(), label: 'reward-desk' },
      rationale: 'W044 fixture',
    };
  }

  it('configures independent reward policies per tenant', async () => {
    const first = await setRewardPolicy(rewardsAdminA, policyInput());
    expect(first.version).toBe(1);
    expect((await setRewardPolicy(rewardsAdminB, policyInput())).version).toBe(1);

    // Rewriting A's policy never reaches B's row (one policy per tenant).
    const updated = await setRewardPolicy(rewardsAdminA, { ...policyInput(), note: 'A tightens' });
    expect(updated.version).toBe(2);
    expect((await getRewardPolicy(ctxA))!.version).toBe(2);
    expect((await getRewardPolicy(ctxB))!.version).toBe(1);
  });

  it('mints the same contribution id independently per tenant', async () => {
    // The per-tenant natural key: UNIQUE (tenant_id, contribution_kind,
    // contribution_id) — one reward per contribution, namespaced per tenant.
    const missionA = await createMission(ctxA, missionInput());
    const missionB = await createMission(ctxB, missionInput());
    const contributionId = newId();

    const appliedA = await applyRewardPolicy(ctxA, contributionInput(missionA.id, contributionId));
    const appliedB = await applyRewardPolicy(ctxB, contributionInput(missionB.id, contributionId));
    expect(appliedA.reward!.id).not.toBe(appliedB.reward!.id);
    expect(appliedA.reward!.status).toBe('proposed'); // the built-in default gates the grant
    expect(appliedB.reward!.status).toBe('proposed');

    // The natural key bites WITHIN a tenant only — B's mint never blocked
    // A's and vice versa; a second application in A is a uniform conflict.
    await expect(
      applyRewardPolicy(ctxA, contributionInput(missionA.id, contributionId)),
    ).rejects.toMatchObject({ code: 'reward_conflict' });

    // Listings and summaries stay per-tenant.
    expect((await listRewards(ctxB, {})).map((reward) => reward.id)).not.toContain(
      appliedA.reward!.id,
    );
    expect((await summarizeRewards(ctxA, {})).totalRewards).toBe(1);
    expect((await summarizeRewards(ctxB, {})).totalRewards).toBe(1);
  });

  it('fails cross-tenant reads, settlements and mission anchors uniformly', async () => {
    const missionA = await createMission(ctxA, missionInput());
    const applied = await applyRewardPolicy(ctxA, contributionInput(missionA.id, newId()));
    const rewardA = applied.reward!;
    expect(rewardA.status).toBe('proposed');

    await expectUniformNotFound(
      'reward_not_found',
      () => getReward(ctxB, rewardA.id),
      () => getReward(ctxB, newId()),
    );
    // B cannot settle A's gated reward.
    await expect(settleReward(ctxB, { rewardId: rewardA.id })).rejects.toMatchObject({
      code: 'reward_not_found',
    });
    // The every-claim principal of B ('rewards:administer' included) is
    // blind on the read AND on the write.
    await expect(getReward(blindB, rewardA.id)).rejects.toMatchObject({ code: 'reward_not_found' });
    await expect(settleReward(blindB, { rewardId: rewardA.id })).rejects.toMatchObject({
      code: 'reward_not_found',
    });

    // B anchoring an application on A's mission: uniform with a missing one
    // (no existence leak through the mission read).
    await expectUniformNotFound(
      'mission_not_found',
      () => applyRewardPolicy(ctxB, contributionInput(missionA.id, newId())),
      () => applyRewardPolicy(ctxB, contributionInput(newId(), newId())),
    );

    // A's reward waited through every B probe.
    expect((await getReward(ctxA, rewardA.id)).status).toBe('proposed');
  });

  it('settles the gated reward only through its own tenant approval', async () => {
    const bRewardsBefore = (await summarizeRewards(ctxB, {})).totalRewards;
    const missionA = await createMission(ctxA, missionInput());
    const applied = await applyRewardPolicy(ctxA, contributionInput(missionA.id, newId()));
    const rewardA = applied.reward!;

    // A's human approves the gate; A's settle consumes the frozen decision.
    await decideApproval(approverA, { requestId: rewardA.actionRequestId, decision: 'approve' });
    const settled = await settleReward(ctxA, { rewardId: rewardA.id });
    expect(settled.status).toBe('granted');
    expect(settled.settlement!.decision).toBe('granted');

    // B's surfaces still count only B's own rewards — A's granted reward
    // never enters them.
    expect((await listRewards(ctxB, {})).map((reward) => reward.id)).not.toContain(rewardA.id);
    expect((await summarizeRewards(ctxB, {})).totalRewards).toBe(bRewardsBefore);
  });
});

// ---------------------------------------------------------------------------
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
