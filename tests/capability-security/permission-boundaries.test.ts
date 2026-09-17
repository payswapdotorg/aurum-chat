// W047 — Capability Security Verification: PERMISSION boundaries.
//
// Proves the permission model of the capability surfaces holds at every
// layer where it is declared:
//
//   * CLAIM GATES — registering extension manifests, running verification
//     evidence, driving the builder workflow, minting agents with
//     permission grants and weakening the tenant's authority policy all
//     require their administration authority claims; approvals require
//     the approval claim, and the requesting principal can never decide
//     its own gate request (separation of duties — GOVERNANCE.md
//     "high-impact actions are policy-gated");
//   * LEAST PRIVILEGE BY CONSTRUCTION — a manifest's requested permission
//     set must be EXACTLY what its declared capabilities require (no
//     hoarding, no undeclared capability), and its quotas must match;
//   * THE GRANT CEILING — an install-time grant is bounded by the
//     manifest's requested ceiling (service AND storage trigger), and
//     every runtime operation checks the CURRENT deployment's grant;
//   * THE VERIFICATION GATE — no unverified software capability can be
//     activated or deployed (the platform-approval gate that exists at
//     this base, ahead of W028's marketplace lifecycle);
//   * THE AUTHORITY MATRIX — consequential capability operations route
//     through the W009 gates (pending → human decision; policy forbid →
//     recorded rejection, never a silent pass);
//   * AGENT SCOPES — executions beyond the agent's grant are refused
//     BEFORE anything is recorded, grant changes apply immediately, and
//     the builder's isolated agent environment runs at exactly its fixed
//     scopes ('analyze' + 'propose' — never 'execute').

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import {
  ANALYST_AGENT,
  BUILDER_AGENT,
  BUILDER_AGENT_SCOPES,
  FakeAgentTransport,
  OPERATOR_AGENT,
  agentsAdmin,
  allowExtensionDeployment,
  approver,
  decideApproval,
  deployExtensionVersion,
  emitExtensionTelemetry,
  executeExtensionExternalCall,
  expectActionsError,
  expectAgentsError,
  expectExtensionsError,
  extensionAdmin,
  forbidExtensionDeployment,
  fullManifest,
  getAgentExecution,
  getExtension,
  getExtensionUi,
  getCurrentDeployment,
  inertManifest,
  listActionRequests,
  listAgentExecutions,
  listExtensionBuilds,
  member,
  memberAs,
  newId,
  publishExtensionUi,
  readExtensionState,
  registerAgent,
  registerExtensionManifest,
  registerVerified,
  requestExtensionBuild,
  runExtensionBuild,
  runAgentExecution,
  runManifestVerification,
  runMigrations,
  setAgentTransport,
  setAuthorityPolicy,
  submitAgentExecution,
  transitionExtension,
  updateAgent,
  wireFakeEgressPort,
  writeExtensionState,
} from './harness';
import type { RegisterExtensionManifestInput } from '@/modules/extensions/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';

// Dedicated tenants per concern so count/order assertions stay deterministic.
const tenantClaims = newId();
const tenantManifest = newId();
const tenantCeiling = newId();
const tenantVerified = newId();
const tenantGateDefault = newId();
const tenantForbidExt = newId();
const tenantForbidAgent = newId();
const tenantAgentScopes = newId();
const tenantBuilder = newId();

const transport = new FakeAgentTransport();

beforeAll(async () => {
  await runMigrations(getDb());
  // Immediate-apply tenants: the deployment gate is open so every refusal
  // below is about the permission boundary under test, not the gate.
  for (const tenantId of [tenantManifest, tenantCeiling, tenantVerified, tenantAgentScopes, tenantBuilder]) {
    await allowExtensionDeployment(tenantId);
  }
  await forbidExtensionDeployment(tenantForbidExt);
  setAgentTransport(transport);
  wireFakeEgressPort();
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

/** Register + verify + activate + deploy (immediate-apply tenants). */
async function liveExtension(
  tenantId: string,
  input: RegisterExtensionManifestInput,
  installKey = 'default',
): Promise<string> {
  const admin = extensionAdmin(tenantId);
  const requester = member(tenantId);
  const { extensionId } = await registerVerified(admin, input);
  const activated = await transitionExtension(requester, {
    extensionId,
    transition: 'activate',
    idempotencyKey: `w047:activate:${input.extensionKey}:1`,
  });
  expect(activated.applied).toBe(true);
  const deployed = await deployExtensionVersion(requester, {
    extensionId,
    version: input.version,
    installKey,
  });
  expect(deployed.applied).toBe(true);
  return extensionId;
}

// ---------------------------------------------------------------------------
// Claim gates
// ---------------------------------------------------------------------------

describe('claim gates: administration of capabilities is authorized', () => {
  it('the extension registry, verification and builder surfaces require extensions:administer', async () => {
    const admin = extensionAdmin(tenantClaims);
    const plain = member(tenantClaims);
    const registered = await registerExtensionManifest(
      admin,
      fullManifest({ extensionKey: 'claim-probe' }),
    );
    const builderAgentId = (await registerAgent(agentsAdmin(tenantClaims), BUILDER_AGENT)).agent.id;
    const buildId = (
      await requestExtensionBuild(admin, {
        extensionKey: 'claim-build-probe',
        version: '0.1.0',
        brief: 'Claim-gate probe.',
        agentId: builderAgentId,
        idempotencyKey: 'w047:claims:build:1',
      })
    ).id;

    await expectExtensionsError('forbidden', () =>
      registerExtensionManifest(plain, fullManifest({ extensionKey: 'rogue-extension' })),
    );
    await expectExtensionsError('forbidden', () =>
      runManifestVerification(plain, { manifestId: registered.manifest.id }),
    );
    await expectExtensionsError('forbidden', () =>
      requestExtensionBuild(plain, {
        extensionKey: 'rogue-build',
        version: '0.1.0',
        brief: 'No claim, no build.',
        agentId: builderAgentId,
      }),
    );
    await expectExtensionsError('forbidden', () => runExtensionBuild(plain, { buildId }));
  });

  it('agent administration and the authority-gate surfaces require their claims', async () => {
    const plain = member(tenantClaims);
    const admin = agentsAdmin(tenantClaims);
    const agent = (await registerAgent(admin, ANALYST_AGENT)).agent;
    await expectAgentsError('forbidden', () =>
      registerAgent(plain, { ...ANALYST_AGENT, slug: 'rogue-agent' }),
    );
    await expectAgentsError('forbidden', () =>
      updateAgent(plain, { agentId: agent.id, permissions: ['execute'] }),
    );
    await expectActionsError('forbidden', () =>
      setAuthorityPolicy(plain, { actionKind: 'agent-execution', approvalLevels: [] }),
    );

    // a REAL pending request exists (built-in default gates EXECUTE):
    // deciding it still requires the approval claim
    const operator = (await registerAgent(admin, OPERATOR_AGENT)).agent;
    const gated = await submitAgentExecution(plain, {
      agentId: operator.id,
      task: { probe: 'claim-gate' },
      requestedPermissions: ['execute'],
    });
    expect(gated.status).toBe('awaiting_approval');
    await expectActionsError('forbidden', () =>
      decideApproval(plain, { requestId: gated.policy.actionRequestId, decision: 'approve' }),
    );
    // the request is still pending — nothing moved
    expect(
      (await listActionRequests(plain, { actionKind: 'agent-execution', status: 'pending' })).some(
        (request) => request.id === gated.policy.actionRequestId,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Least-privilege manifests
// ---------------------------------------------------------------------------

describe('manifest permission declarations are least-privilege by construction', () => {
  const admin = extensionAdmin(tenantManifest);

  it('no scope hoarding: a permission without its justifying capability is rejected', async () => {
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(admin, fullManifest({ extensionKey: 'hoarder', uiSurfaces: [] })),
    );
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(
        admin,
        fullManifest({ extensionKey: 'hoarder-2', externalParticipants: [] }),
      ),
    );
  });

  it('no undeclared capability: a capability without its required permission is rejected', async () => {
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(
        admin,
        fullManifest({
          extensionKey: 'undeclared-state',
          requestedPermissions: [
            'state:read',
            'ui:render',
            'schedule:run',
            'events:subscribe',
            'external:participate',
            'telemetry:emit',
          ],
        }),
      ),
    );
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(
        admin,
        fullManifest({
          extensionKey: 'undeclared-telemetry',
          requestedPermissions: [
            'state:read',
            'state:write',
            'ui:render',
            'schedule:run',
            'events:subscribe',
            'external:participate',
          ],
        }),
      ),
    );
  });

  it('quota declarations must match the declared capabilities exactly', async () => {
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(
        admin,
        fullManifest({
          extensionKey: 'quotaless-schedules',
          quotas: {
            maxStateBytes: 1_048_576,
            maxScheduleInvocationsPerDay: 0,
            maxExternalCallsPerDay: 1_000,
          },
        }),
      ),
    );
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(
        admin,
        inertManifest({
          extensionKey: 'quota-without-capability',
          quotas: { maxStateBytes: 512, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
        }),
      ),
    );
  });

  it('the permission vocabulary is closed', async () => {
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(
        admin,
        fullManifest({
          extensionKey: 'vocab-rogue',
          // deliberately outside the closed vocabulary — the cast keeps
          // the compiler from rejecting the attack payload under test
          requestedPermissions: ['state:read', 'root:everything'] as never,
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The grant ceiling
// ---------------------------------------------------------------------------

describe('install-time grants are bounded by the requested ceiling', () => {
  it('a grant beyond the ceiling is refused; a narrowed grant deploys', async () => {
    const requester = member(tenantCeiling);
    const extensionId = await liveExtension(
      tenantCeiling,
      inertManifest({
        extensionKey: 'capped-extension',
        stateScope: 'tenant',
        requestedPermissions: ['state:read', 'state:write'],
        quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      }),
    );
    await expectExtensionsError('grant_exceeds_ceiling', () =>
      deployExtensionVersion(requester, {
        extensionId,
        version: '1.0.0',
        installKey: 'emea',
        grantedPermissions: ['state:read', 'state:write', 'ui:render'],
      }),
    );
    const narrowed = await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      grantedPermissions: ['state:read'],
    });
    expect(narrowed.deployment!.grantedPermissions).toEqual(['state:read']);
  });

  it('the ceiling holds even for writes bypassing the service (storage trigger)', async () => {
    const admin = extensionAdmin(tenantCeiling);
    const { extensionId, manifestId } = await registerVerified(
      admin,
      inertManifest({
        extensionKey: 'storage-ceiling-probe',
        stateScope: 'tenant',
        requestedPermissions: ['state:read', 'state:write'],
        quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      }),
    );
    await expect(
      getDb().query(
        `INSERT INTO extension_deployments (
           tenant_id, extension_id, extension_key, install_key, manifest_id, version,
           operation, replaces_deployment_id, granted_permissions, deployed_by, deployed_at, action_request_id
         ) VALUES ($1, $2, 'storage-ceiling-probe', 'bypass', $3, '1.0.0', 'deploy', NULL,
           '["state:read","state:write","ui:render"]'::jsonb, 'probe', now(), NULL)`,
        [tenantCeiling, extensionId, manifestId],
      ),
    ).rejects.toThrow(/requested ceiling/);
  });

  it('the runtime enforces the CURRENT deployment grant on every capability surface', async () => {
    const requester = member(tenantCeiling);

    // state: redeploy the default install with a read-only grant — reads
    // pass, writes are refused (tenant-scoped state is addressed without
    // an install key, so the default install's current grant governs it)
    const stateId = await liveExtension(
      tenantCeiling,
      inertManifest({
        extensionKey: 'read-only-state',
        stateScope: 'tenant',
        requestedPermissions: ['state:read', 'state:write'],
        quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      }),
    );
    await deployExtensionVersion(requester, {
      extensionId: stateId,
      version: '1.0.0',
      grantedPermissions: ['state:read'],
      idempotencyKey: 'w047:ceiling:read-only:default',
    });
    await expectExtensionsError('permission_not_granted', () =>
      writeExtensionState(requester, { extensionId: stateId, key: 'k', value: 1 }),
    );
    // the read-only grant still reads (nothing yet) without error
    expect(await readExtensionState(requester, { extensionId: stateId, key: 'k' })).toBeNull();
    // redeploying with the full ceiling-grant restores the write
    await deployExtensionVersion(requester, {
      extensionId: stateId,
      version: '1.0.0',
      grantedPermissions: ['state:read', 'state:write'],
      idempotencyKey: 'w047:ceiling:read-write:default',
    });
    const written = await writeExtensionState(requester, {
      extensionId: stateId,
      key: 'k',
      value: 1,
    });
    expect(written.revision).toBe(1);

    // ui: a grant without ui:render refuses BOTH publish and render read
    // (UI surfaces are install-independent: the grant of the current
    // default-install deployment governs the surface)
    const uiId = await liveExtension(
      tenantCeiling,
      fullManifest({ extensionKey: 'no-ui-grant' }),
    );
    await deployExtensionVersion(requester, {
      extensionId: uiId,
      version: '1.0.0',
      grantedPermissions: ['state:read', 'state:write'],
      idempotencyKey: 'w047:ceiling:no-ui:default',
    });
    await expectExtensionsError('permission_not_granted', () =>
      publishExtensionUi(requester, {
        extensionId: uiId,
        surface: 'control-tower-panel',
        document: { title: null, blocks: [] },
      }),
    );
    await expectExtensionsError('permission_not_granted', () =>
      getExtensionUi(requester, {
        extensionId: uiId,
        surface: 'control-tower-panel',
      }),
    );

    // external participation: declared origin, missing grant
    const externalId = await liveExtension(
      tenantCeiling,
      fullManifest({ extensionKey: 'no-external-grant' }),
    );
    await deployExtensionVersion(requester, {
      extensionId: externalId,
      version: '1.0.0',
      installKey: 'emea',
      grantedPermissions: ['state:read', 'state:write'],
      idempotencyKey: 'w047:ceiling:no-external:emea',
    });
    await expectExtensionsError('permission_not_granted', () =>
      executeExtensionExternalCall(requester, {
        extensionId: externalId,
        installKey: 'emea',
        origin: 'https://api.invoices.example.com',
        method: 'GET',
        path: '/',
      }),
    );

    // telemetry: declared capability, missing grant
    const telemetryId = await liveExtension(
      tenantCeiling,
      fullManifest({ extensionKey: 'no-telemetry-grant' }),
    );
    await deployExtensionVersion(requester, {
      extensionId: telemetryId,
      version: '1.0.0',
      installKey: 'emea',
      grantedPermissions: ['state:read', 'state:write'],
      idempotencyKey: 'w047:ceiling:no-telemetry:emea',
    });
    await expectExtensionsError('permission_not_granted', () =>
      emitExtensionTelemetry(requester, {
        extensionId: telemetryId,
        installKey: 'emea',
        name: 'run.completed',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The verification gate (the platform-approval gate that exists today)
// ---------------------------------------------------------------------------

describe('no unverified software capability can be enabled or deployed', () => {
  it('an unverified latest version blocks activation until a passing run exists', async () => {
    const admin = extensionAdmin(tenantVerified);
    const requester = member(tenantVerified);
    const registered = await registerExtensionManifest(
      admin,
      fullManifest({ extensionKey: 'unverified-gate' }),
    );
    await expectExtensionsError('verification_required', () =>
      transitionExtension(requester, {
        extensionId: registered.extension.id,
        transition: 'activate',
        idempotencyKey: 'w047:verified:unverified-gate:1',
      }),
    );
    // the extension is still REGISTERED
    expect(
      (await getExtension(requester, { extensionId: registered.extension.id })).lifecycleState,
    ).toBe('REGISTERED');
    // a passing verification run flips the gate
    const run = await runManifestVerification(admin, { manifestId: registered.manifest.id });
    expect(run.state).toBe('VERIFIED');
    const activated = await transitionExtension(requester, {
      extensionId: registered.extension.id,
      transition: 'activate',
      idempotencyKey: 'w047:verified:unverified-gate:1',
    });
    expect(activated.applied).toBe(true);
  });

  it('an ACTIVE extension cannot deploy a newer unverified version', async () => {
    const admin = extensionAdmin(tenantVerified);
    const requester = member(tenantVerified);
    const extensionId = await liveExtension(
      tenantVerified,
      fullManifest({ extensionKey: 'verified-deploy-gate' }),
    );
    const v2 = await registerExtensionManifest(
      admin,
      fullManifest({ extensionKey: 'verified-deploy-gate', version: '2.0.0' }),
    );
    await expectExtensionsError('verification_required', () =>
      deployExtensionVersion(requester, { extensionId, version: '2.0.0' }),
    );
    // v1 keeps running while v2 sits un-deployable
    expect((await getCurrentDeployment(requester, { extensionId }))?.version).toBe('1.0.0');
    await runManifestVerification(admin, { manifestId: v2.manifest.id });
    const deployed = await deployExtensionVersion(requester, { extensionId, version: '2.0.0' });
    expect(deployed.applied).toBe(true);
    expect(deployed.deployment!.version).toBe('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// The W009 authority matrix over capability operations
// ---------------------------------------------------------------------------

describe('the authority matrix gates consequential capability operations', () => {
  it('the built-in default gates activation until a human decides; separation of duties holds', async () => {
    const admin = extensionAdmin(tenantGateDefault);
    const requester = member(tenantGateDefault);
    const { extensionId } = await registerVerified(
      admin,
      fullManifest({ extensionKey: 'gated-activation' }),
    );

    // built-in floor: EXECUTE is approval-gated — the transition WAITS
    const held = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'w047:gate:activation:1',
    });
    expect(held.applied).toBe(false);
    expect(held.gate.status).toBe('pending');
    expect((await getExtension(requester, { extensionId })).lifecycleState).toBe('REGISTERED');

    // separation of duties: even a principal HOLDING the approval claim
    // cannot decide the request it caused
    const pending = await listActionRequests(requester, {
      actionKind: 'extension-deployment',
      status: 'pending',
    });
    const requestId = pending[0]!.id;
    await expectActionsError('forbidden', () =>
      decideApproval(memberAs(tenantGateDefault, requester.principalId, ['actions:approve']), {
        requestId,
        decision: 'approve',
      }),
    );
    // a plain member of the tenant cannot decide either
    await expectActionsError('forbidden', () =>
      decideApproval(member(tenantGateDefault), { requestId, decision: 'approve' }),
    );

    // the authorized different principal decides; the replay applies
    await decideApproval(approver(tenantGateDefault), { requestId, decision: 'approve' });
    const applied = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'w047:gate:activation:1',
    });
    expect(applied.applied).toBe(true);
    expect((await getExtension(requester, { extensionId })).lifecycleState).toBe('ACTIVE');
  });

  it('a tenant policy forbidding extension-deployment EXECUTE rejects loudly and records evidence', async () => {
    const admin = extensionAdmin(tenantForbidExt);
    const requester = member(tenantForbidExt);
    const { extensionId } = await registerVerified(
      admin,
      fullManifest({ extensionKey: 'forbidden-activation' }),
    );
    await expectExtensionsError('forbidden_by_policy', () =>
      transitionExtension(requester, {
        extensionId,
        transition: 'activate',
        idempotencyKey: 'w047:forbid:activation:1',
      }),
    );
    // the rejection is recorded evidence, and the extension never moved
    const rejected = await listActionRequests(requester, {
      actionKind: 'extension-deployment',
      status: 'rejected',
    });
    expect(rejected.length).toBeGreaterThan(0);
    expect((await getExtension(requester, { extensionId })).lifecycleState).toBe('REGISTERED');
  });

  it('a tenant policy forbidding agent-execution records a terminal refused execution', async () => {
    const policyAdmin = memberAs(tenantForbidAgent, newId(), [
      'actions:administer',
      'agents:administer',
    ]);
    await setAuthorityPolicy(policyAdmin, {
      actionKind: 'agent-execution',
      forbiddenLevels: ['EXECUTE'],
    });
    const agent = (await registerAgent(agentsAdmin(tenantForbidAgent), OPERATOR_AGENT)).agent;
    const refused = await submitAgentExecution(member(tenantForbidAgent), {
      agentId: agent.id,
      task: { probe: 'forbidden-execute' },
      requestedPermissions: ['execute'],
    });
    expect(refused.status).toBe('refused');
    expect(refused.errorCode).toBe('execution_forbidden');
    expect(refused.completedAt).not.toBeNull();
    // the refusal is reconstructable through the actions module
    const rejected = await listActionRequests(member(tenantForbidAgent), {
      actionKind: 'agent-execution',
      status: 'rejected',
    });
    expect(rejected.some((request) => request.id === refused.policy.actionRequestId)).toBe(true);
    // terminal: the pump refuses to dispatch it
    await expectAgentsError('not_runnable', () =>
      runAgentExecution(member(tenantForbidAgent), { executionId: refused.id }),
    );
    expect(transport.requestsFor([agent.id])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Agent permission scopes
// ---------------------------------------------------------------------------

describe('agent permission scopes are enforced before anything is recorded', () => {
  it('an execution beyond the grant is refused with NO execution, request or dispatch', async () => {
    const admin = agentsAdmin(tenantAgentScopes);
    const agent = (await registerAgent(admin, ANALYST_AGENT)).agent; // observe/analyze/recommend
    await expectAgentsError('permission_not_granted', () =>
      submitAgentExecution(member(tenantAgentScopes), {
        agentId: agent.id,
        task: { probe: 'over-scope' },
        requestedPermissions: ['observe', 'execute'],
      }),
    );
    // nothing was recorded in either module
    expect(await listAgentExecutions(member(tenantAgentScopes), {})).toEqual([]);
    expect(
      await listActionRequests(member(tenantAgentScopes), { actionKind: 'agent-execution' }),
    ).toEqual([]);
    expect(transport.requestsFor([agent.id])).toHaveLength(0);
  });

  it('grant changes apply immediately and disabled agents accept nothing', async () => {
    const admin = agentsAdmin(tenantAgentScopes);
    const agent = (await registerAgent(admin, ANALYST_AGENT)).agent;
    // narrow the grant: 'analyze' is no longer covered
    await updateAgent(admin, { agentId: agent.id, permissions: ['observe'] });
    await expectAgentsError('permission_not_granted', () =>
      submitAgentExecution(member(tenantAgentScopes), {
        agentId: agent.id,
        task: { probe: 'narrowed' },
        requestedPermissions: ['observe', 'analyze'],
      }),
    );
    // the covered scope still passes the permission check
    const allowed = await submitAgentExecution(member(tenantAgentScopes), {
      agentId: agent.id,
      task: { probe: 'narrowed' },
      requestedPermissions: ['observe'],
    });
    expect(allowed.status).toBe('queued');
    expect(allowed.authorityLevel).toBe('OBSERVE');

    // disable: no new executions, no dispatch of the queued one
    await updateAgent(admin, { agentId: agent.id, status: 'disabled' });
    await expectAgentsError('agent_disabled', () =>
      submitAgentExecution(member(tenantAgentScopes), {
        agentId: agent.id,
        task: { probe: 'disabled' },
        requestedPermissions: ['observe'],
      }),
    );
    await expectAgentsError('agent_disabled', () =>
      runAgentExecution(member(tenantAgentScopes), { executionId: allowed.id }),
    );
    expect(transport.requestsFor([agent.id])).toHaveLength(0);
    // the queued execution is intact — inert, not lost
    await expect(
      getAgentExecution(member(tenantAgentScopes), { executionId: allowed.id }),
    ).resolves.toMatchObject({ status: 'queued' });
  });
});

// ---------------------------------------------------------------------------
// The builder's isolated agent environment
// ---------------------------------------------------------------------------

describe('the builder’s isolated agent environment runs at fixed scopes', () => {
  it('the fixed scope set is exactly analyze + propose (never execute)', () => {
    expect([...BUILDER_AGENT_SCOPES]).toEqual(['analyze', 'propose']);
  });

  it('a builder agent missing a fixed scope is rejected; a disabled one too', async () => {
    const admin = agentsAdmin(tenantBuilder);
    const extensionAdminCtx = extensionAdmin(tenantBuilder);
    const analystOnly = (await registerAgent(admin, ANALYST_AGENT)).agent; // no 'propose'
    await expectExtensionsError('agent_scope_insufficient', () =>
      requestExtensionBuild(extensionAdminCtx, {
        extensionKey: 'scope-probe',
        version: '0.1.0',
        brief: 'The agent cannot propose.',
        agentId: analystOnly.id,
      }),
    );

    const disabledBuilder = (
      await registerAgent(admin, { ...BUILDER_AGENT, slug: 'boundary-builder-disabled' })
    ).agent;
    await updateAgent(admin, { agentId: disabledBuilder.id, status: 'disabled' });
    await expectExtensionsError('agent_disabled', () =>
      requestExtensionBuild(extensionAdminCtx, {
        extensionKey: 'scope-probe',
        version: '0.1.0',
        brief: 'The builder agent is disabled.',
        agentId: disabledBuilder.id,
      }),
    );
    // nothing was recorded
    expect(await listExtensionBuilds(extensionAdminCtx, {})).toEqual([]);
  });

  it('a granted builder agent executes at exactly the fixed scopes', async () => {
    const admin = agentsAdmin(tenantBuilder);
    const extensionAdminCtx = extensionAdmin(tenantBuilder);
    const builderAgent = (await registerAgent(admin, BUILDER_AGENT)).agent; // analyze+propose only
    const build = await requestExtensionBuild(extensionAdminCtx, {
      extensionKey: 'fixed-scope-build',
      version: '0.1.0',
      brief: 'The isolated environment proves its fixed scopes.',
      agentId: builderAgent.id,
      idempotencyKey: 'w047:builder:fixed-scopes:1',
    });
    // the design execution the builder submitted requests EXACTLY the
    // fixed scopes — the isolated environment never runs at 'execute'
    const executions = await listAgentExecutions(member(tenantBuilder), {
      agentId: builderAgent.id,
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.requestedPermissions).toEqual(['analyze', 'propose']);
    expect(executions[0]!.authorityLevel).toBe('PROPOSE');
    // the build session links that execution
    expect(build.designExecutionId).toBe(executions[0]!.id);
  });
});
