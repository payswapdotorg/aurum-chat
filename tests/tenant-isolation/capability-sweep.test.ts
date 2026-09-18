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
import { startExecution } from '@/modules/cognition/contract';
import { assertTenantPartition, expectUniformNotFound, member, memberWith, omnipotent, runMigrations } from './harness';

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
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
