// W047 — Capability Security Verification: TENANT boundaries.
//
// Proves the capability surfaces of the extensions module (W025 registry,
// W026 runtime, W027 builder) and the agents module (W021 gateway) — plus
// the actions module's authority-gate evidence they route through — are
// BLIND across tenants (ADR-0001): another tenant's extensions, manifests,
// deployments, installs, state, evidence, agents, executions, attempts,
// builds, artifacts and action requests are indistinguishable from missing
// ones (uniform not-found, no existence leak), the same natural keys are
// independently registrable per tenant with zero interaction, and no
// cross-tenant operation leaves a trace in the other tenant's storage or
// reaches its provider transports.
//
// What is deliberately NOT re-proven here: the per-module unit/storage
// behaviors (immutability triggers, pagination, normalization) belong to
// the sibling module tests; this file crosses modules through the
// contracts only, exactly what a verification work item is for.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import {
  ANALYST_AGENT,
  BUILDER_AGENT,
  FakeAgentTransport,
  OPERATOR_AGENT,
  agentsAdmin,
  allowExtensionDeployment,
  approver,
  cancelAgentExecution,
  decideApproval,
  deployExtensionVersion,
  dispatchExtensionEvent,
  emitExtensionTelemetry,
  executeExtensionExternalCall,
  expectActionsError,
  expectAgentsError,
  expectExtensionsError,
  extensionAdmin,
  fullManifest,
  getAgent,
  getAgentExecution,
  getExtension,
  getExtensionBuild,
  getExtensionUi,
  getManifest,
  getManifestVerification,
  getCurrentDeployment,
  listActionRequests,
  listExtensionBuildArtifacts,
  listExtensionBuilds,
  listExtensionDeployments,
  listExtensionEventDeliveries,
  listExtensionExternalCalls,
  listExtensionLifecycleEvents,
  listExtensionScheduleRuns,
  listExtensionTelemetryEvents,
  listExtensions,
  listManifests,
  listManifestVerifications,
  listAgentExecutionAttempts,
  listAgentExecutions,
  listAgents,
  member,
  newId,
  publishExtensionUi,
  readExtensionState,
  registerAgent,
  registerVerified,
  requestExtensionBuild,
  rollbackExtensionDeployment,
  runAgentExecution,
  runExtensionBuild,
  runManifestVerification,
  runMigrations,
  setAgentTransport,
  submitAgentExecution,
  transitionExtension,
  triggerExtensionSchedule,
  updateAgent,
  wireFakeEgressPort,
  writeExtensionState,
} from './harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';

// Tenant A seeds every capability surface; tenant B is the adversarial
// observer that must see nothing of it. Both tenants allow
// extension-deployment EXECUTE so A's seeding applies immediately and B's
// refusals below are about isolation, not policy.
const tenantA = newId();
const tenantB = newId();

const transport = new FakeAgentTransport();

// Tenant A's seeded scene (filled by beforeAll).
let extensionAId = '';
let manifestAId = '';
let manifestA2Id = '';
let deploymentAId = '';
let agentAId = '';
let operatorAId = '';
let builderAgentAId = '';
let executionAId = '';
let buildAId = '';
let pendingRequestAId = '';

beforeAll(async () => {
  await runMigrations(getDb());
  await allowExtensionDeployment(tenantA);
  await allowExtensionDeployment(tenantB);
  setAgentTransport(transport);
  wireFakeEgressPort();

  // --- extensions: registry + runtime surface, all in tenant A ---
  const adminA = extensionAdmin(tenantA);
  const requesterA = member(tenantA);
  const registered = await registerVerified(
    adminA,
    fullManifest({ extensionKey: 'shared-secure-key', version: '1.0.0' }),
  );
  extensionAId = registered.extensionId;
  manifestAId = registered.manifestId;
  // a second verified version so manifest history exists in A only
  const second = await registerVerified(
    adminA,
    fullManifest({ extensionKey: 'shared-secure-key', version: '2.0.0' }),
  );
  manifestA2Id = second.manifestId;

  await transitionExtension(requesterA, {
    extensionId: extensionAId,
    transition: 'activate',
    idempotencyKey: 'w047:activate:tenant-a:1',
  });
  const deployed = await deployExtensionVersion(requesterA, {
    extensionId: extensionAId,
    version: '1.0.0',
    idempotencyKey: 'w047:deploy:tenant-a:1',
  });
  deploymentAId = deployed.deployment!.id;
  await writeExtensionState(requesterA, { extensionId: extensionAId, key: 'secret', value: 'A-only' });
  await publishExtensionUi(requesterA, {
    extensionId: extensionAId,
    surface: 'control-tower-panel',
    document: { title: null, blocks: [] },
  });
  await emitExtensionTelemetry(requesterA, { extensionId: extensionAId, name: 'run.completed' });
  await triggerExtensionSchedule(requesterA, {
    extensionId: extensionAId,
    scheduleName: 'nightly-sync',
  });
  await executeExtensionExternalCall(requesterA, {
    extensionId: extensionAId,
    origin: 'https://api.invoices.example.com',
    method: 'GET',
    path: '/v1/invoices',
  });

  // --- agents: definitions, a pumped execution with attempt evidence ---
  const agentsAdminA = agentsAdmin(tenantA);
  agentAId = (await registerAgent(agentsAdminA, ANALYST_AGENT)).agent.id;
  operatorAId = (await registerAgent(agentsAdminA, OPERATOR_AGENT)).agent.id;
  builderAgentAId = (await registerAgent(agentsAdminA, BUILDER_AGENT)).agent.id;
  const execution = await submitAgentExecution(requesterA, {
    agentId: agentAId,
    task: { probe: 'tenant-boundary' },
    requestedPermissions: ['observe', 'analyze'],
  });
  await runAgentExecution(requesterA, { executionId: execution.id });
  executionAId = execution.id;

  // --- builder: a build session (the package pipeline) bound to A's agent ---
  buildAId = (
    await requestExtensionBuild(adminA, {
      extensionKey: 'pkg-target-a',
      version: '0.1.0',
      brief: 'A tenant-bound extension package probe.',
      agentId: builderAgentAId,
      idempotencyKey: 'w047:build:tenant-a:1',
    })
  ).id;

  // --- a pending W009 approval request inside tenant A ---
  const gated = await submitAgentExecution(requesterA, {
    agentId: operatorAId,
    task: { probe: 'gate-boundary' },
    requestedPermissions: ['execute'],
  });
  const pending = await listActionRequests(requesterA, {
    actionKind: 'agent-execution',
    status: 'pending',
  });
  pendingRequestAId = pending.find((request) => request.id === gated.policy.actionRequestId)!.id;
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// extensions — the registry and runtime surfaces are blind to tenant B
// ---------------------------------------------------------------------------

describe('extensions: tenant boundary (uniform not-found, no existence leak)', () => {
  const adminB = extensionAdmin(tenantB);
  const memberB = member(tenantB);

  it('the registry reads are uniformly not-found for another tenant', async () => {
    await expectExtensionsError('extension_not_found', () =>
      getExtension(memberB, { extensionId: extensionAId }),
    );
    // the same KEY is invisible too when B has not registered it
    await expectExtensionsError('extension_not_found', () =>
      getExtension(memberB, { extensionKey: 'shared-secure-key' }),
    );
    // and the listing surface sees nothing of A
    expect(await listExtensions(memberB, {})).toEqual([]);
    // A still resolves everything (control)
    expect((await getExtension(member(tenantA), { extensionId: extensionAId })).id).toBe(extensionAId);

    // manifest surfaces agree
    await expectExtensionsError('manifest_not_found', () =>
      getManifest(memberB, { manifestId: manifestAId }),
    );
    await expectExtensionsError('manifest_not_found', () =>
      getManifestVerification(memberB, { manifestId: manifestAId }),
    );
    await expectExtensionsError('manifest_not_found', () =>
      listManifestVerifications(memberB, { manifestId: manifestAId }),
    );
    // list reads filter by tenant — no error, no rows
    expect(await listManifests(memberB, { extensionId: extensionAId })).toEqual([]);
    // verification runs are claim-gated AND tenant-scoped: a claimless
    // member of B is refused on the claim, B's admin on the tenant scope
    await expectExtensionsError('forbidden', () =>
      runManifestVerification(memberB, { manifestId: manifestAId }),
    );
    await expectExtensionsError('manifest_not_found', () =>
      runManifestVerification(adminB, { manifestId: manifestAId }),
    );
  });

  it('the same key registers independently per tenant with zero interaction', async () => {
    const requesterB = member(tenantB);
    const registeredB = await registerVerified(
      adminB,
      fullManifest({ extensionKey: 'shared-secure-key', version: '3.0.0' }),
    );
    expect(registeredB.extensionId).not.toBe(extensionAId);
    expect(
      (await getExtension(adminB, { extensionKey: 'shared-secure-key' })).latestVersion,
    ).toBe('3.0.0');
    // B activates and deploys its OWN extension of the same key
    const activatedB = await transitionExtension(requesterB, {
      extensionId: registeredB.extensionId,
      transition: 'activate',
      idempotencyKey: 'w047:activate:tenant-b:1',
    });
    expect(activatedB.applied).toBe(true);
    const deployedB = await deployExtensionVersion(requesterB, {
      extensionId: registeredB.extensionId,
      version: '3.0.0',
      idempotencyKey: 'w047:deploy:tenant-b:1',
    });
    expect(deployedB.applied).toBe(true);
    expect(deployedB.deployment!.id).not.toBe(deploymentAId);

    // A's registry is untouched: still at 2.0.0 with its own manifest ids
    expect(
      (await getExtension(member(tenantA), { extensionKey: 'shared-secure-key' })).latestVersion,
    ).toBe('2.0.0');
    expect((await getManifest(member(tenantA), { manifestId: manifestAId })).id).toBe(manifestAId);
    expect((await getManifest(member(tenantA), { manifestId: manifestA2Id })).id).toBe(manifestA2Id);
  });

  it('every runtime capability surface refuses another tenant uniformly', async () => {
    const requesterB = member(tenantB);
    await expectExtensionsError('extension_not_found', () =>
      readExtensionState(requesterB, { extensionId: extensionAId, key: 'secret' }),
    );
    await expectExtensionsError('extension_not_found', () =>
      writeExtensionState(requesterB, { extensionId: extensionAId, key: 'secret', value: 'B-write' }),
    );
    await expectExtensionsError('extension_not_found', () =>
      getExtensionUi(requesterB, { extensionId: extensionAId, surface: 'control-tower-panel' }),
    );
    await expectExtensionsError('extension_not_found', () =>
      publishExtensionUi(requesterB, {
        extensionId: extensionAId,
        surface: 'control-tower-panel',
        document: { title: null, blocks: [] },
      }),
    );
    await expectExtensionsError('extension_not_found', () =>
      triggerExtensionSchedule(requesterB, {
        extensionId: extensionAId,
        scheduleName: 'nightly-sync',
      }),
    );
    await expectExtensionsError('extension_not_found', () =>
      listExtensionScheduleRuns(requesterB, { extensionId: extensionAId }),
    );
    await expectExtensionsError('extension_not_found', () =>
      listExtensionEventDeliveries(requesterB, { extensionId: extensionAId }),
    );
    await expectExtensionsError('extension_not_found', () =>
      executeExtensionExternalCall(requesterB, {
        extensionId: extensionAId,
        origin: 'https://api.invoices.example.com',
        method: 'GET',
        path: '/',
      }),
    );
    await expectExtensionsError('extension_not_found', () =>
      listExtensionExternalCalls(requesterB, { extensionId: extensionAId }),
    );
    await expectExtensionsError('extension_not_found', () =>
      emitExtensionTelemetry(requesterB, { extensionId: extensionAId, name: 'run.completed' }),
    );
    await expectExtensionsError('extension_not_found', () =>
      listExtensionTelemetryEvents(requesterB, { extensionId: extensionAId }),
    );
    await expectExtensionsError('extension_not_found', () =>
      getCurrentDeployment(requesterB, { extensionId: extensionAId }),
    );
    await expectExtensionsError('extension_not_found', () =>
      listExtensionDeployments(requesterB, { extensionId: extensionAId }),
    );
    await expectExtensionsError('extension_not_found', () =>
      listExtensionLifecycleEvents(requesterB, { extensionId: extensionAId }),
    );

    // the storage itself holds no B-visible row of A's runtime activity
    const rows = await getDb().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM extension_state WHERE tenant_id = $1`,
      [tenantB],
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);

    // A's data is unchanged — the namespace boundary held
    expect(
      (await readExtensionState(member(tenantA), { extensionId: extensionAId, key: 'secret' }))?.value,
    ).toBe('A-only');
  });

  it('deployment and lifecycle writes of another tenant fail without side effects', async () => {
    const requesterB = member(tenantB);
    // B owns a same-key extension now (previous test) — so a foreign
    // DEPLOYMENT id under it is precisely a missing deployment
    await expectExtensionsError('deployment_not_found', () =>
      rollbackExtensionDeployment(requesterB, {
        extensionKey: 'shared-secure-key',
        targetDeploymentId: deploymentAId,
      }),
    );
    await expectExtensionsError('extension_not_found', () =>
      deployExtensionVersion(requesterB, { extensionId: extensionAId, version: '1.0.0' }),
    );
    await expectExtensionsError('extension_not_found', () =>
      transitionExtension(requesterB, { extensionId: extensionAId, transition: 'suspend' }),
    );
    // A's extension is still ACTIVE on its recorded deployment
    expect(
      (await getExtension(member(tenantA), { extensionId: extensionAId })).lifecycleState,
    ).toBe('ACTIVE');
    expect((await getCurrentDeployment(member(tenantA), { extensionId: extensionAId }))?.id).toBe(
      deploymentAId,
    );
  });

  it('event dispatch never crosses the tenant boundary', async () => {
    // B dispatches the topic A's install subscribes to — nothing lands in A
    const dispatchB = await dispatchExtensionEvent(member(tenantB), { topic: 'invoice.paid' });
    expect(dispatchB.deliveries.every((delivery) => delivery.tenantId === tenantB)).toBe(true);
    expect(dispatchB.deliveries.map((delivery) => delivery.extensionId)).not.toContain(extensionAId);
    // A's own dispatch reaches only A's install
    const dispatchA = await dispatchExtensionEvent(member(tenantA), { topic: 'invoice.paid' });
    expect(dispatchA.deliveries.every((delivery) => delivery.tenantId === tenantA)).toBe(true);
    expect(dispatchA.deliveries.map((delivery) => delivery.extensionId)).toContain(extensionAId);
  });
});

// ---------------------------------------------------------------------------
// agents — definitions, executions and attempt evidence are blind to B
// ---------------------------------------------------------------------------

describe('agents: tenant boundary (uniform not-found, no dispatch)', () => {
  it('definition reads and writes are uniformly not-found for another tenant', async () => {
    const adminB = agentsAdmin(tenantB);
    const memberB = member(tenantB);
    await expectAgentsError('agent_not_found', () => getAgent(memberB, { agentId: agentAId }));
    await expectAgentsError('agent_not_found', () =>
      updateAgent(adminB, { agentId: agentAId, role: 'cross-tenant probe' }),
    );
    await expectAgentsError('agent_not_found', () =>
      submitAgentExecution(memberB, {
        agentId: agentAId,
        task: { probe: 'cross-tenant' },
        requestedPermissions: ['observe', 'analyze'],
      }),
    );
    expect(await listAgents(memberB, {})).toEqual([]);

    // the same slug registers independently in B
    const registeredB = await registerAgent(adminB, ANALYST_AGENT);
    expect(registeredB.created).toBe(true);
    expect(registeredB.agent.id).not.toBe(agentAId);
    // A's agent is untouched
    const inA = await getAgent(member(tenantA), { agentId: agentAId });
    expect(inA.id).toBe(agentAId);
    expect(inA.permissions).toEqual(['observe', 'analyze', 'recommend']);
  });

  it('executions and attempt evidence are invisible — and never dispatched — for another tenant', async () => {
    const memberB = member(tenantB);
    await expectAgentsError('execution_not_found', () =>
      getAgentExecution(memberB, { executionId: executionAId }),
    );
    await expectAgentsError('execution_not_found', () =>
      listAgentExecutionAttempts(memberB, { executionId: executionAId }),
    );
    await expectAgentsError('execution_not_found', () =>
      runAgentExecution(memberB, { executionId: executionAId }),
    );
    await expectAgentsError('execution_not_found', () =>
      cancelAgentExecution(memberB, { executionId: executionAId, reason: 'cross-tenant probe' }),
    );
    expect(await listAgentExecutions(memberB, {})).toEqual([]);

    // the pump never handed A's agents to the transport on B's behalf
    expect(transport.requestsFor([agentAId])).toHaveLength(1);
    expect(transport.requestsFor([operatorAId])).toHaveLength(0);
    // A's execution is still its own succeeded record with its evidence
    const execution = await getAgentExecution(member(tenantA), { executionId: executionAId });
    expect(execution.status).toBe('succeeded');
    expect(execution.tenantId).toBe(tenantA);
    expect(
      await listAgentExecutionAttempts(member(tenantA), { executionId: executionAId }),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// builder — the package pipeline is tenant-bound
// ---------------------------------------------------------------------------

describe('builder: the extension-build pipeline cannot cross tenants', () => {
  it('a build cannot be requested against another tenant’s agent', async () => {
    // tenant B's admin, tenant A's builder agent id
    await expectExtensionsError('agent_not_found', () =>
      requestExtensionBuild(extensionAdmin(tenantB), {
        extensionKey: 'pkg-target-b',
        version: '0.1.0',
        brief: 'Try to build with the other tenant’s agent.',
        agentId: builderAgentAId,
      }),
    );
    // nothing was recorded in the builder's registry
    expect(await listExtensionBuilds(extensionAdmin(tenantB), {})).toEqual([]);
  });

  it('builds, pumps and artifact custody are uniformly not-found for another tenant', async () => {
    const adminB = extensionAdmin(tenantB);
    await expectExtensionsError('build_not_found', () => getExtensionBuild(adminB, { buildId: buildAId }));
    await expectExtensionsError('build_not_found', () => runExtensionBuild(adminB, { buildId: buildAId }));
    await expectExtensionsError('build_not_found', () =>
      listExtensionBuildArtifacts(adminB, { buildId: buildAId }),
    );
    expect(await listExtensionBuilds(adminB, {})).toEqual([]);
    // A still resolves its own build session
    expect((await getExtensionBuild(extensionAdmin(tenantA), { buildId: buildAId })).id).toBe(buildAId);
  });
});

// ---------------------------------------------------------------------------
// the actions authority-gate evidence is tenant-scoped
// ---------------------------------------------------------------------------

describe('authority gate evidence: approvals cannot cross tenants', () => {
  it('another tenant’s approver cannot decide a pending request', async () => {
    await expectActionsError('action_request_not_found', () =>
      decideApproval(approver(tenantB), { requestId: pendingRequestAId, decision: 'approve' }),
    );
    // the request is still pending — the failed probe changed nothing
    const stillPending = await listActionRequests(member(tenantA), {
      actionKind: 'agent-execution',
      status: 'pending',
    });
    expect(stillPending.some((request) => request.id === pendingRequestAId)).toBe(true);
    // B's request feed never contained it
    expect(
      (await listActionRequests(member(tenantB), { actionKind: 'agent-execution' })).some(
        (request) => request.id === pendingRequestAId,
      ),
    ).toBe(false);

    // A's OWN approver decides it; the gated execution then dispatches
    await decideApproval(approver(tenantA), { requestId: pendingRequestAId, decision: 'approve' });
    const awaiting = await listAgentExecutions(member(tenantA), {
      agentId: operatorAId,
      status: 'awaiting_approval',
    });
    const resolved = await runAgentExecution(member(tenantA), { executionId: awaiting[0]!.id });
    expect(resolved.status).toBe('succeeded');
    expect(resolved.tenantId).toBe(tenantA);
  });
});
