// Integration tests for the extensions module's builder (W027 — Extension
// Builder) against the embedded PostgreSQL (PGlite, `:memory:`) through
// the db port. Covers the W027 acceptance — "Support design/build/
// verify/deploy workflow using an isolated agent execution environment
// and the general runtime":
//
//  * THE WORKFLOW: request → designing → building → built → verified →
//    deploying → deployed through the explicit worker pump, one phase
//    step per call; the design and build phases run through the agents
//    module's isolated execution environment (a fake runtime transport
//    wired through setAgentTransport, the W021 test precedent), with
//    agent output deterministically validated before anything is
//    registered; the verify phase appends the same verification-run
//    evidence W025 records; the deploy phase activates (if needed) and
//    deploys through the general runtime's matrix-gated operations;
//  * ISOLATION: the builder's agent executions request exactly
//    'analyze' + 'propose' (never 'execute'), agent output that fails
//    the domain validation fails the build loudly (never a silent
//    substitute), and what the agent produced is retained as append-only
//    artifact custody even when rejected;
//  * AUTHORITY: request/pump/cancel are claim-gated
//    ('extensions:administer'); the default built-in matrix gates
//    activation and deployment behind human approvals (pending → decide
//    → re-pump applies), tenant policy can allow them (applies
//    immediately) or forbid them (activation_rejected);
//  * FAILURE EVIDENCE: design/build execution failures and refusals,
//    invalid artifacts (custody retained), mid-flight version conflicts
//    (drift), suspended extensions at deploy time — all recorded as
//    failure codes on the session, never thrown;
//  * RESUMABILITY: deterministic idempotency keys replay recorded
//    outcomes (a simulated crash gap self-heals), and a lost execution
//    link re-submits into the SAME agent execution;
//  * CANCELLATION: live builds only, cancelling the phase's live agent
//    execution with the reason;
//  * TENANT ISOLATION (ADR-0001) across every surface with uniform
//    not-found semantics (no existence leaks);
//  * STORAGE-LEVEL GUARANTEES: builds are history (identity frozen,
//    DELETE/TRUNCATE forbidden, live-state-only UPDATEs), artifacts are
//    append-only custody, and the phase/failure vocabularies are
//    CHECKed for writes bypassing the service.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as extensionsContract from '../contract';
import * as agentsContract from '@/modules/agents/contract';
import {
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { ExtensionsError } from '../errors';
import { setAgentTransport } from '@/modules/agents/contract';
import type {
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
  RegisterAgentInput,
} from '@/modules/agents/contract';

const {
  EXTENSIONS_AUTHORITY_ADMINISTER,
  getExtension,
  getExtensionBuild,
  getManifest,
  listExtensionBuildArtifacts,
  listExtensionBuilds,
  listExtensionLifecycleEvents,
  registerExtensionManifest,
  requestExtensionBuild,
  runExtensionBuild,
  cancelExtensionBuild,
  transitionExtension,
  getCurrentDeployment,
} = extensionsContract;

const {
  getAgentExecution,
  registerAgent,
  updateAgent,
} = agentsContract;

// Dedicated tenants keep each concern's data (and authority policies!)
// isolated from the others, so every assertion below sees only what it
// created.
const tenantRequest = newId();
const tenantHappy = newId();
const tenantGates = newId();
const tenantFailures = newId();
const tenantDrift = newId();
const tenantSuspended = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantStorage = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function extensionAdmin(tenantId: string): TenantContext {
  // The driving principal holds BOTH management claims: the registry's
  // administer claim (the builder surface) and the agents module's
  // (registering the builder agent fixture) — the realistic tenant
  // administrator.
  return {
    tenantId,
    principalId: newId(),
    authority: [EXTENSIONS_AUTHORITY_ADMINISTER, 'agents:administer'],
  };
}

function actionsAdmin(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: ['actions:administer', EXTENSIONS_AUTHORITY_ADMINISTER],
  };
}

function approver(tenantId: string): TenantContext {
  // A DIFFERENT principal with the actions approval claim (separation of duties).
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectErrorCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionsError);
    expect((error as ExtensionsError).code).toBe(code);
  }
}

/** Let this tenant's 'extension-deployment' EXECUTE operations apply without approval. */
async function allowExtensionDeployment(tenantId: string): Promise<void> {
  await setAuthorityPolicy(actionsAdmin(tenantId), {
    actionKind: 'extension-deployment',
    approvalLevels: [],
    forbiddenLevels: [],
  });
}

/** Approve a pending action request as an authorized different principal. */
async function approveRequest(tenantId: string, requestId: string): Promise<void> {
  await decideApproval(approver(tenantId), { requestId, decision: 'approve' });
}

// ---------------------------------------------------------------------------
// A recording fake transport that speaks the langgraph dialect
// ---------------------------------------------------------------------------

class FakeAgentTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];
  private output: unknown = {};
  private summary: string | null = null;
  private failuresLeft = 0;
  private failureStatus: 'rejected' | 'failed' = 'failed';
  private counter = 0;

  respondWith(output: unknown, summary: string | null = null): void {
    this.output = output;
    this.summary = summary;
  }

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
    this.counter += 1;
    const taskId = `fake-${String(this.counter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: {
        run_id: `lg_${taskId}`,
        output: { result: this.output, summary: this.summary },
        usage: { input_tokens: 900, output_tokens: 700, steps: 2 },
      },
      providerTaskId: taskId,
      detail: null,
    };
  }
}

let transport: FakeAgentTransport;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUILDER_AGENT: RegisterAgentInput = {
  slug: 'extension-designer',
  displayName: 'Extension Designer',
  role: 'extension design and build',
  description: 'Designs extension manifests from build briefs.',
  provider: 'langgraph',
  instructions:
    'Design extensions as JSON design documents; build them as complete manifest declarations.',
  runtimeConfig: { assistantId: 'asst_builder_1' },
  permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose'],
};

async function registerBuilderAgent(ctx: TenantContext): Promise<string> {
  // Idempotent per slug (the agents module's first-write-wins): later
  // calls in the same tenant replay the original definition.
  const registered = await registerAgent(ctx, BUILDER_AGENT);
  return registered.agent.id;
}

/** A complete, consistent design artifact (the design phase's output). */
function designOutput(): Record<string, unknown> {
  return {
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    notes: 'nightly sync keeps the world model fresh',
  };
}

/** A complete, consistent build artifact (the build phase's output). */
function buildOutput(): Record<string, unknown> {
  return {
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
  };
}

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
// Request-time behavior
// ---------------------------------------------------------------------------

describe('requesting a build (claim-gated, pre-validated, idempotent)', () => {
  it('gates on the administer claim before parsing (no shape leaks to plain members)', async () => {
    await expectErrorCode('forbidden', () =>
      requestExtensionBuild(member(tenantRequest), { nonsense: true } as never),
    );
  });

  it('rejects invalid inputs with the house codes', async () => {
    const admin = extensionAdmin(tenantRequest);
    const agentId = await registerBuilderAgent(extensionAdmin(tenantRequest));
    await expectErrorCode('invalid_input', () =>
      requestExtensionBuild(admin, { extensionKey: 'Bad Key', version: '1.0.0', brief: 'b', agentId }),
    );
    await expectErrorCode('invalid_input', () =>
      requestExtensionBuild(admin, { extensionKey: 'ok-key', version: '1.0', brief: 'b', agentId }),
    );
    await expectErrorCode('invalid_input', () =>
      requestExtensionBuild(admin, { extensionKey: 'ok-key', version: '1.0.0', brief: '', agentId }),
    );
  });

  it('rejects a missing, disabled or under-scoped builder agent', async () => {
    const admin = extensionAdmin(tenantRequest);
    await expectErrorCode('agent_not_found', () =>
      requestExtensionBuild(admin, {
        extensionKey: 'k',
        version: '1.0.0',
        brief: 'b',
        agentId: newId(),
      }),
    );

    const agentId = await registerBuilderAgent(admin);
    await updateAgent(admin, { agentId, status: 'disabled' });
    await expectErrorCode('agent_disabled', () =>
      requestExtensionBuild(admin, { extensionKey: 'k', version: '1.0.0', brief: 'b', agentId }),
    );
    await updateAgent(admin, { agentId, status: 'active' });

    const narrow = await registerAgent(admin, {
      ...BUILDER_AGENT,
      slug: 'narrow-agent',
      permissions: ['observe'],
    });
    await expectErrorCode('agent_scope_insufficient', () =>
      requestExtensionBuild(admin, {
        extensionKey: 'k',
        version: '1.0.0',
        brief: 'b',
        agentId: narrow.agent.id,
      }),
    );
  });

  it('fails fast on registry-impossible targets before spending agent budget', async () => {
    const admin = extensionAdmin(tenantRequest);
    const agentId = await registerBuilderAgent(admin);

    // existing extension at 2.0.0 → lower or equal targets are refused
    await registerExtensionManifest(admin, {
      extensionKey: 'existing-tool',
      version: '2.0.0',
      manifestSchemaVersion: 1,
      displayName: 'Existing Tool',
      hostRuntime: { minVersion: '1.0.0' },
    });
    await expectErrorCode('version_not_monotonic', () =>
      requestExtensionBuild(admin, {
        extensionKey: 'existing-tool',
        version: '1.9.0',
        brief: 'b',
        agentId,
      }),
    );
    await expectErrorCode('version_not_monotonic', () =>
      requestExtensionBuild(admin, {
        extensionKey: 'existing-tool',
        version: '2.0.0',
        brief: 'b',
        agentId,
      }),
    );

    // a retired extension accepts no new versions
    const deprecatedKey = 'retired-tool';
    await registerExtensionManifest(admin, {
      extensionKey: deprecatedKey,
      version: '1.0.0',
      manifestSchemaVersion: 1,
      displayName: 'Retired Tool',
      hostRuntime: { minVersion: '1.0.0' },
    });
    // the default built-in matrix gates the EXECUTE behind a human:
    // pending → approve → the SAME idempotency key replays and applies
    const deprecation = await transitionExtension(admin, {
      extensionKey: deprecatedKey,
      transition: 'deprecate',
      idempotencyKey: 'retire-existing-tool',
    });
    if (!deprecation.applied) {
      await approveRequest(tenantRequest, deprecation.gate.actionRequestId);
      const retired = await transitionExtension(admin, {
        extensionKey: deprecatedKey,
        transition: 'deprecate',
        idempotencyKey: 'retire-existing-tool',
      });
      expect(retired.applied).toBe(true);
    }
    expect(
      (await getExtension(admin, { extensionKey: deprecatedKey })).lifecycleState,
    ).toBe('DEPRECATED');
    await expectErrorCode('extension_deprecated', () =>
      requestExtensionBuild(admin, {
        extensionKey: deprecatedKey,
        version: '2.0.0',
        brief: 'b',
        agentId,
      }),
    );
  });

  it('creates the session in designing with the design execution submitted at the fixed scopes', async () => {
    const admin = extensionAdmin(tenantRequest);
    const agentId = await registerBuilderAgent(admin);

    const build = await requestExtensionBuild(admin, {
      extensionKey: 'brand-new-tool',
      version: '1.0.0',
      brief: 'A tool that reads invoices into the world model',
      agentId,
      idempotencyKey: 'build-brand-new',
    });

    expect(build.phase).toBe('designing');
    expect(build.extensionKey).toBe('brand-new-tool');
    expect(build.version).toBe('1.0.0');
    expect(build.brief).toBe('A tool that reads invoices into the world model');
    expect(build.agentId).toBe(agentId);
    expect(build.requestedBy).toBe(admin.principalId);
    expect(build.manifestId).toBeNull();
    expect(build.failureCode).toBeNull();
    expect(build.designExecutionId).not.toBeNull();

    // The isolated execution environment: the design execution requests
    // exactly analyze + propose (PROPOSE level — never EXECUTE) and
    // carries the canonical task with the deterministic correlation id.
    const execution = await getAgentExecution(admin, { executionId: build.designExecutionId! });
    expect(execution.requestedPermissions).toEqual(['analyze', 'propose']);
    expect(execution.authorityLevel).toBe('PROPOSE');
    expect(execution.status).toBe('queued'); // default policy allows PROPOSE
    expect(execution.task).toEqual({
      workflow: 'extension-build',
      phase: 'design',
      extensionKey: 'brand-new-tool',
      version: '1.0.0',
      brief: 'A tool that reads invoices into the world model',
    });
    expect(execution.correlationId).toBe(`ext-build-design:${build.id}`);
    expect(execution.causationId).toBeNull();
    expect(transport.requests).toHaveLength(0); // async: nothing dispatched yet
  });

  it('replays the original session for a recorded idempotency key', async () => {
    const admin = extensionAdmin(tenantRequest);
    const agentId = await registerBuilderAgent(admin);
    const input = {
      extensionKey: 'idempotent-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
      idempotencyKey: 'idem-1',
    };
    const first = await requestExtensionBuild(admin, input);
    const second = await requestExtensionBuild(admin, input);
    expect(second.id).toBe(first.id);
    expect(second.designExecutionId).toBe(first.designExecutionId);
    expect(await listExtensionBuilds(admin, { extensionKey: 'idempotent-tool' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The happy path (tenant policy allows extension deployments)
// ---------------------------------------------------------------------------

describe('the design/build/verify/deploy workflow (policy allows deployments)', () => {
  it('walks designing → building → built → verified → deployed one pump at a time', async () => {
    await allowExtensionDeployment(tenantHappy);
    const admin = extensionAdmin(tenantHappy);
    const agentId = await registerBuilderAgent(admin);

    const build = await requestExtensionBuild(admin, {
      extensionKey: 'invoice-ocr',
      version: '1.0.0',
      brief: 'Read invoices into the world model',
      agentId,
    });

    // --- design phase: one dispatch, artifact custody, build execution spawn
    transport.respondWith(designOutput(), 'a capability plan');
    const designing = await runExtensionBuild(admin, { buildId: build.id });
    expect(designing.phase).toBe('building');
    expect(designing.buildExecutionId).not.toBeNull();
    expect(designing.manifestId).toBeNull();

    // the build execution was caused by the design execution (§25)
    const buildExecution = await getAgentExecution(admin, {
      executionId: designing.buildExecutionId!,
    });
    expect(buildExecution.requestedPermissions).toEqual(['analyze', 'propose']);
    expect(buildExecution.authorityLevel).toBe('PROPOSE');
    expect(buildExecution.causationId).toBe(build.designExecutionId);
    expect(buildExecution.correlationId).toBe(`ext-build-build:${build.id}`);
    expect(buildExecution.task).toMatchObject({
      workflow: 'extension-build',
      phase: 'build',
      design: { displayName: 'Invoice OCR', stateScope: 'tenant' },
    });

    // --- build phase: one dispatch, the declaration registers as a manifest
    transport.respondWith(buildOutput(), 'the declaration');
    const built = await runExtensionBuild(admin, { buildId: build.id });
    expect(built.phase).toBe('built');
    expect(built.manifestId).not.toBeNull();

    // the extension was created REGISTERED and the manifest round-trips
    // the (normalized) declaration the agent produced
    const extension = await getExtension(admin, { extensionKey: 'invoice-ocr' });
    expect(extension.lifecycleState).toBe('REGISTERED');
    expect(extension.latestVersion).toBe('1.0.0');
    const manifest = await getManifest(admin, { manifestId: built.manifestId! });
    expect(manifest.displayName).toBe('Invoice OCR');
    expect(manifest.requestedPermissions).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ]);
    expect(manifest.verification.state).toBe('UNVERIFIED');
    expect(manifest.registeredBy).toBe(admin.principalId); // the pumping principal

    // --- verify phase: the same verification evidence W025 records
    const verified = await runExtensionBuild(admin, { buildId: build.id });
    expect(verified.phase).toBe('verified');
    const after = await getManifest(admin, { manifestId: built.manifestId! });
    expect(after.verification.state).toBe('VERIFIED');
    expect(after.verification.latestRun!.checks).toHaveLength(5);
    expect(after.verification.latestRun!.verifier).toBe(admin.principalId);

    // --- deploy phase: activation (fresh extension) + deployment, both applied
    const deployed = await runExtensionBuild(admin, { buildId: build.id });
    expect(deployed.phase).toBe('deployed');
    expect(deployed.deploymentId).not.toBeNull();

    const active = await getExtension(admin, { extensionKey: 'invoice-ocr' });
    expect(active.lifecycleState).toBe('ACTIVE');
    const lifecycleEvents = await listExtensionLifecycleEvents(admin, { extensionKey: 'invoice-ocr' });
    expect(lifecycleEvents.map((event) => event.transition)).toEqual(['activate']);
    expect(lifecycleEvents[0]!.actor).toBe(admin.principalId);

    const current = await getCurrentDeployment(admin, { extensionKey: 'invoice-ocr' });
    expect(current!.id).toBe(deployed.deploymentId);
    expect(current!.version).toBe('1.0.0');
    expect(current!.installKey).toBe('default');
    expect(current!.operation).toBe('deploy');
    // the runtime deployed the manifest's full requested set (the default grant)
    expect(current!.grantedPermissions).toEqual(manifest.requestedPermissions);

    // --- artifact custody: exactly two rows, the raw agent outputs
    const artifacts = await listExtensionBuildArtifacts(admin, { buildId: build.id });
    expect(artifacts.map((artifact) => artifact.phase)).toEqual(['design', 'build']);
    expect(artifacts[0]!.payload).toEqual(designOutput());
    expect(artifacts[1]!.payload).toEqual(buildOutput());
    expect(artifacts[0]!.executionId).toBe(build.designExecutionId);
    expect(artifacts[1]!.executionId).toBe(deployed.buildExecutionId);
    expect(artifacts[0]!.recordedBy).toBe(admin.principalId);

    // --- terminal: history cannot be re-pumped
    await expectErrorCode('not_runnable', () => runExtensionBuild(admin, { buildId: build.id }));
    await expectErrorCode('not_cancellable', () =>
      cancelExtensionBuild(admin, { buildId: build.id, reason: 'too late' }),
    );
  });

  it('builds a new version of an existing ACTIVE extension without re-activating it', async () => {
    await allowExtensionDeployment(tenantHappy);
    const admin = extensionAdmin(tenantHappy);
    const agentId = await registerBuilderAgent(admin);

    // version 1.0.0 through the workflow (the previous test's shape)
    const first = await requestExtensionBuild(admin, {
      extensionKey: 'versioned-tool',
      version: '1.0.0',
      brief: 'v1',
      agentId,
    });
    transport.respondWith(designOutput());
    await runExtensionBuild(admin, { buildId: first.id });
    transport.respondWith(buildOutput());
    await runExtensionBuild(admin, { buildId: first.id });
    await runExtensionBuild(admin, { buildId: first.id });
    const deployedV1 = await runExtensionBuild(admin, { buildId: first.id });
    expect(deployedV1.phase).toBe('deployed');

    // version 2.0.0 of the now-ACTIVE extension
    const second = await requestExtensionBuild(admin, {
      extensionKey: 'versioned-tool',
      version: '2.0.0',
      brief: 'v2',
      agentId,
    });
    transport.respondWith({ ...designOutput(), displayName: 'Versioned Tool v2' });
    await runExtensionBuild(admin, { buildId: second.id });
    transport.respondWith({ ...buildOutput(), displayName: 'Versioned Tool v2' });
    const built = await runExtensionBuild(admin, { buildId: second.id });
    expect(built.phase).toBe('built');
    await runExtensionBuild(admin, { buildId: second.id }); // verify
    const deployedV2 = await runExtensionBuild(admin, { buildId: second.id }); // deploy
    expect(deployedV2.phase).toBe('deployed');

    // no second activation event — the extension was already ACTIVE
    const events = await listExtensionLifecycleEvents(admin, { extensionKey: 'versioned-tool' });
    expect(events.map((event) => event.transition)).toEqual(['activate']);

    const current = await getCurrentDeployment(admin, { extensionKey: 'versioned-tool' });
    expect(current!.version).toBe('2.0.0');
    const extension = await getExtension(admin, { extensionKey: 'versioned-tool' });
    expect(extension.latestVersion).toBe('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// The gated path (the default built-in matrix: EXECUTE needs a human)
// ---------------------------------------------------------------------------

describe('the gated path (activation and deployment wait for human approvals)', () => {
  it('holds at the gates and applies after approve → re-pump', async () => {
    const admin = extensionAdmin(tenantGates);
    const agentId = await registerBuilderAgent(admin);

    const build = await requestExtensionBuild(admin, {
      extensionKey: 'gated-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });

    transport.respondWith(designOutput());
    expect((await runExtensionBuild(admin, { buildId: build.id })).phase).toBe('building');
    transport.respondWith(buildOutput());
    expect((await runExtensionBuild(admin, { buildId: build.id })).phase).toBe('built');
    expect((await runExtensionBuild(admin, { buildId: build.id })).phase).toBe('verified');

    // --- the activation gate holds the workflow at 'verified'
    const held = await runExtensionBuild(admin, { buildId: build.id });
    expect(held.phase).toBe('verified');
    expect((await getExtension(admin, { extensionKey: 'gated-tool' })).lifecycleState).toBe('REGISTERED');
    const pending = (await listActionRequests(admin, { status: 'pending' })).filter(
      (request) => request.actionKind === 'extension-deployment',
    );
    expect(pending).toHaveLength(1);

    // approve, re-pump: the activation replays and applies, then the
    // deployment submission lands at its own gate ('deploying')
    await approveRequest(tenantGates, pending[0]!.id);
    const deploying = await runExtensionBuild(admin, { buildId: build.id });
    expect(deploying.phase).toBe('deploying');
    expect((await getExtension(admin, { extensionKey: 'gated-tool' })).lifecycleState).toBe('ACTIVE');

    const deployGates = (await listActionRequests(admin, { status: 'pending' })).filter(
      (request) =>
        request.actionKind === 'extension-deployment' &&
        request.payload !== null &&
        (request.payload as Record<string, unknown>)['operation'] === 'deploy',
    );
    expect(deployGates).toHaveLength(1);

    // nothing applied yet: no deployment exists
    expect(await getCurrentDeployment(admin, { extensionKey: 'gated-tool' })).toBeNull();

    // approve the deployment, re-pump: the same key replays and applies
    await approveRequest(tenantGates, deployGates[0]!.id);
    const deployed = await runExtensionBuild(admin, { buildId: build.id });
    expect(deployed.phase).toBe('deployed');
    const current = await getCurrentDeployment(admin, { extensionKey: 'gated-tool' });
    expect(current!.version).toBe('1.0.0');
    expect(current!.id).toBe(deployed.deploymentId);

    // re-pumping the terminal build is refused
    await expectErrorCode('not_runnable', () => runExtensionBuild(admin, { buildId: build.id }));
  });
});

// ---------------------------------------------------------------------------
// Failure evidence (recorded on the session, never thrown)
// ---------------------------------------------------------------------------

describe('failure evidence (agent failures, invalid artifacts, drift, state)', () => {
  it('records a design execution failure when the runtime refuses the task', async () => {
    const admin = extensionAdmin(tenantFailures);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'refused-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });

    transport.failNext(1, 'rejected'); // a permanent refusal
    const failed = await runExtensionBuild(admin, { buildId: build.id });
    expect(failed.phase).toBe('failed');
    expect(failed.failureCode).toBe('design_execution_failed');
    expect(failed.failureDetail).toContain('refusal');
    // the failing execution is retained as linked evidence
    expect(failed.designExecutionId).not.toBeNull();
    const execution = await getAgentExecution(admin, { executionId: failed.designExecutionId! });
    expect(execution.status).toBe('failed');
  });

  it('records an invalid design artifact (custody retained, problems named)', async () => {
    const admin = extensionAdmin(tenantFailures);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'prose-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });

    // the agent answers in prose — not JSON
    transport.respondWith('I would design a wonderful invoice reader.');
    const failed = await runExtensionBuild(admin, { buildId: build.id });
    expect(failed.phase).toBe('failed');
    expect(failed.failureCode).toBe('design_artifact_invalid');
    expect(failed.failureDetail).toContain('not valid JSON');

    // custody: the prose answer is retained as the design artifact
    const artifacts = await listExtensionBuildArtifacts(admin, { buildId: build.id });
    expect(artifacts.map((artifact) => artifact.phase)).toEqual(['design']);
    expect(artifacts[0]!.payload).toBe('I would design a wonderful invoice reader.');
  });

  it('records an invalid build artifact that fails the registration rule set', async () => {
    const admin = extensionAdmin(tenantFailures);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'inconsistent-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });

    transport.respondWith(designOutput());
    await runExtensionBuild(admin, { buildId: build.id }); // → building

    // the declaration is inconsistent: capabilities without their permissions
    const inconsistent = buildOutput();
    delete inconsistent['requestedPermissions'];
    transport.respondWith(inconsistent);
    const failed = await runExtensionBuild(admin, { buildId: build.id });
    expect(failed.phase).toBe('failed');
    expect(failed.failureCode).toBe('build_artifact_invalid');
    expect(failed.failureDetail).toContain('the manifest declaration is inconsistent');

    // nothing was registered — the key never even entered the registry
    // (uniform not-found: a never-registered extension is missing)
    await expectErrorCode('extension_not_found', () =>
      getExtension(admin, { extensionKey: 'inconsistent-tool' }),
    );
    const artifacts = await listExtensionBuildArtifacts(admin, { buildId: build.id });
    expect(artifacts.map((artifact) => artifact.phase)).toEqual(['design', 'build']);
  });

  it('records a mid-flight version conflict as registry drift evidence', async () => {
    const admin = extensionAdmin(tenantDrift);
    const agentId = await registerBuilderAgent(admin);
    // the extension already exists at 1.0.0
    await registerExtensionManifest(admin, {
      extensionKey: 'drifting-tool',
      version: '1.0.0',
      manifestSchemaVersion: 1,
      displayName: 'Drifting Tool',
      hostRuntime: { minVersion: '1.0.0' },
    });

    const build = await requestExtensionBuild(admin, {
      extensionKey: 'drifting-tool',
      version: '2.0.0',
      brief: 'b',
      agentId,
    });
    transport.respondWith(designOutput());
    await runExtensionBuild(admin, { buildId: build.id }); // → building

    // a human registers 2.0.0 while the build sits at 'building'
    await registerExtensionManifest(admin, {
      extensionKey: 'drifting-tool',
      version: '2.0.0',
      manifestSchemaVersion: 1,
      displayName: 'Drifting Tool',
      hostRuntime: { minVersion: '1.0.0' },
    });

    transport.respondWith(buildOutput());
    const failed = await runExtensionBuild(admin, { buildId: build.id });
    expect(failed.phase).toBe('failed');
    // the registry's own monotonicity rule rejected the target —
    // re-recorded as build evidence in the registry's vocabulary
    expect(failed.failureCode).toBe('version_not_monotonic');
    expect(failed.failureDetail).toContain('does not come after');
    // the build's manifest link stays empty — the registry's row is not its own
    expect(failed.manifestId).toBeNull();
  });

  it('always verifies builder-built manifests (one rule set — no drift by construction)', async () => {
    const admin = extensionAdmin(tenantFailures);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'corrupt-proof-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });
    transport.respondWith(designOutput());
    await runExtensionBuild(admin, { buildId: build.id });
    transport.respondWith(buildOutput());
    const built = await runExtensionBuild(admin, { buildId: build.id });
    expect(built.phase).toBe('built');

    // The build artifact passed the SAME registration validation a human
    // registration passes, and the verification checks re-examine the
    // same rule set — so a builder-registered manifest cannot reach the
    // verify phase and fail it (a 'verification_failed' build is only
    // reachable through rule drift, i.e. a check added after the fact —
    // which then appears as a NEW failing run, never a rewrite). Pin
    // that invariant: the verify phase folds VERIFIED.
    const verified = await runExtensionBuild(admin, { buildId: build.id });
    expect(verified.phase).toBe('verified');
    expect(verified.failureCode).toBeNull();
    const manifest = await getManifest(admin, { manifestId: built.manifestId! });
    expect(manifest.verification.state).toBe('VERIFIED');
    expect(manifest.verification.latestRun!.outcome).toBe('verified');
  });

  it('records activation failure when the extension is suspended at deploy time', async () => {
    await allowExtensionDeployment(tenantSuspended);
    const admin = extensionAdmin(tenantSuspended);
    const agentId = await registerBuilderAgent(admin);

    // complete a first build so the extension exists and is ACTIVE
    const first = await requestExtensionBuild(admin, {
      extensionKey: 'moody-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });
    transport.respondWith(designOutput());
    await runExtensionBuild(admin, { buildId: first.id });
    transport.respondWith(buildOutput());
    await runExtensionBuild(admin, { buildId: first.id });
    await runExtensionBuild(admin, { buildId: first.id });
    expect((await runExtensionBuild(admin, { buildId: first.id })).phase).toBe('deployed');

    // suspend it (the allow policy applies the transition immediately)
    const suspension = await transitionExtension(admin, {
      extensionKey: 'moody-tool',
      transition: 'suspend',
    });
    expect(suspension.applied).toBe(true);
    expect((await getExtension(admin, { extensionKey: 'moody-tool' })).lifecycleState).toBe('SUSPENDED');

    // a new version's build reaches 'verified', then fails at deploy
    const second = await requestExtensionBuild(admin, {
      extensionKey: 'moody-tool',
      version: '2.0.0',
      brief: 'v2',
      agentId,
    });
    transport.respondWith(designOutput());
    await runExtensionBuild(admin, { buildId: second.id });
    transport.respondWith(buildOutput());
    await runExtensionBuild(admin, { buildId: second.id });
    await runExtensionBuild(admin, { buildId: second.id });
    const failed = await runExtensionBuild(admin, { buildId: second.id });
    expect(failed.phase).toBe('failed');
    expect(failed.failureCode).toBe('activation_failed');
    expect(failed.failureDetail).toContain('SUSPENDED');
  });
});

// ---------------------------------------------------------------------------
// Cancellation and resumability
// ---------------------------------------------------------------------------

describe('cancellation and resumability', () => {
  it('cancels a live build and its live agent execution, once', async () => {
    const admin = extensionAdmin(tenantFailures);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'cancelled-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });

    const cancelled = await cancelExtensionBuild(admin, {
      buildId: build.id,
      reason: 'the brief changed',
    });
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.failureCode).toBe('cancelled');
    expect(cancelled.failureDetail).toBe('the brief changed');

    // the design execution was cancelled with the reason
    const execution = await getAgentExecution(admin, { executionId: build.designExecutionId! });
    expect(execution.status).toBe('cancelled');
    expect(execution.errorDetail).toBe('the brief changed');

    // a cancelled build is history
    await expectErrorCode('not_runnable', () => runExtensionBuild(admin, { buildId: build.id }));
    await expectErrorCode('not_cancellable', () =>
      cancelExtensionBuild(admin, { buildId: build.id, reason: 'again' }),
    );
  });

  it('self-heals a lost execution link by replaying the deterministic key', async () => {
    await allowExtensionDeployment(tenantHappy);
    const admin = extensionAdmin(tenantHappy);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'crashy-tool',
      version: '1.0.0',
      brief: 'b',
      agentId,
    });

    // Simulate the crash gap: the session exists but its execution link
    // was lost (the link is live state, so the storage guard permits
    // the reset — exactly the recovery window the pump must survive).
    await getDb().query(
      `UPDATE extension_builds SET design_execution_id = NULL WHERE tenant_id = $1 AND id = $2`,
      [tenantHappy, build.id],
    );

    transport.respondWith(designOutput());
    const healed = await runExtensionBuild(admin, { buildId: build.id });
    // the deterministic key replayed the ORIGINAL design execution —
    // not a second one — and the workflow advanced
    expect(healed.phase).toBe('building');
    expect(healed.designExecutionId).toBe(build.designExecutionId);
    const executions = await agentsContract.listAgentExecutions(admin, {
      agentId,
      correlationId: `ext-build-design:${build.id}`,
    });
    expect(executions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (uniform not-found, no existence leaks)', () => {
  it('hides one tenant builds from every surface of another', async () => {
    const adminA = extensionAdmin(tenantIsoA);
    const adminB = extensionAdmin(tenantIsoB); // claimed: the claim gate
    // must not mask the not-found discipline for foreign builds
    const memberB = member(tenantIsoB);
    const agentA = await registerBuilderAgent(adminA);

    const build = await requestExtensionBuild(adminA, {
      extensionKey: 'private-tool',
      version: '1.0.0',
      brief: 'private',
      agentId: agentA,
    });

    // reads are member-open and uniformly not-found for foreign callers
    await expectErrorCode('build_not_found', () =>
      getExtensionBuild(memberB, { buildId: build.id }),
    );
    await expectErrorCode('build_not_found', () =>
      listExtensionBuildArtifacts(memberB, { buildId: build.id }),
    );
    expect(await listExtensionBuilds(memberB, {})).toEqual([]);
    // writes are claim-gated; a CLAIMED foreign principal still gets the
    // uniform not-found (no existence leak through the claim gate)
    await expectErrorCode('build_not_found', () =>
      runExtensionBuild(adminB, { buildId: build.id }),
    );
    await expectErrorCode('build_not_found', () =>
      cancelExtensionBuild(adminB, { buildId: build.id, reason: 'x' }),
    );

    // an unrelated member of tenant A still reads the evidence surfaces
    const memberA = member(tenantIsoA);
    expect((await getExtensionBuild(memberA, { buildId: build.id })).phase).toBe('designing');
    expect(await listExtensionBuilds(memberA, { extensionKey: 'private-tool' })).toHaveLength(1);
  });

  it('runs independent workflows for the same key in two tenants without interaction', async () => {
    await allowExtensionDeployment(tenantIsoA);
    await allowExtensionDeployment(tenantIsoB);
    const adminA = extensionAdmin(tenantIsoA);
    const adminB = extensionAdmin(tenantIsoB);
    const agentA = await registerBuilderAgent(adminA);
    const agentB = await registerBuilderAgent(adminB);

    const buildA = await requestExtensionBuild(adminA, {
      extensionKey: 'shared-name-tool',
      version: '1.0.0',
      brief: 'tenant A',
      agentId: agentA,
      idempotencyKey: 'iso-key',
    });
    // the same idempotency key in ANOTHER tenant is a different session
    const buildB = await requestExtensionBuild(adminB, {
      extensionKey: 'shared-name-tool',
      version: '1.0.0',
      brief: 'tenant B',
      agentId: agentB,
      idempotencyKey: 'iso-key',
    });
    expect(buildA.id).not.toBe(buildB.id);

    for (const [admin, build] of [
      [adminA, buildA],
      [adminB, buildB],
    ] as const) {
      transport.respondWith(designOutput());
      await runExtensionBuild(admin, { buildId: build.id });
      transport.respondWith(buildOutput());
      await runExtensionBuild(admin, { buildId: build.id });
      await runExtensionBuild(admin, { buildId: build.id });
      const deployed = await runExtensionBuild(admin, { buildId: build.id });
      expect(deployed.phase).toBe('deployed');
      expect((await listExtensionBuilds(admin, { extensionKey: 'shared-name-tool' })).length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees
// ---------------------------------------------------------------------------

describe('storage-level guarantees (history, custody, vocabularies)', () => {
  it('freezes the submission: identity fields cannot be rewritten, DELETE/TRUNCATE forbidden', async () => {
    const admin = extensionAdmin(tenantStorage);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'frozen-tool',
      version: '1.0.0',
      brief: 'frozen',
      agentId,
    });

    await expect(
      getDb().query(`UPDATE extension_builds SET brief = 'rewritten' WHERE tenant_id = $1 AND id = $2`, [
        tenantStorage,
        build.id,
      ]),
    ).rejects.toThrow(/only the live state/);
    await expect(
      getDb().query(`UPDATE extension_builds SET extension_key = 'other-tool' WHERE tenant_id = $1 AND id = $2`, [
        tenantStorage,
        build.id,
      ]),
    ).rejects.toThrow(/only the live state/);
    await expect(
      getDb().query(`UPDATE extension_builds SET agent_id = $3 WHERE tenant_id = $1 AND id = $2`, [
        tenantStorage,
        build.id,
        newId(),
      ]),
    ).rejects.toThrow(/only the live state/);
    await expect(
      getDb().query(`DELETE FROM extension_builds WHERE tenant_id = $1 AND id = $2`, [
        tenantStorage,
        build.id,
      ]),
    ).rejects.toThrow(/DELETE is forbidden/);
    // the artifacts table references builds, so the plain TRUNCATE hits
    // the FK first — CASCADE reaches the guard triggers instead
    await expect(
      getDb().query(`TRUNCATE extension_builds CASCADE`),
    ).rejects.toThrow(/TRUNCATE is forbidden/);

    // the live state MAY move (the guard's split): a raw phase move is
    // legal and the phase CHECKs keep the vocabulary closed
    await getDb().query(
      `UPDATE extension_builds SET phase = 'failed', failure_code = 'design_artifact_invalid',
         failure_detail = 'raw move', updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantStorage, build.id],
    );
    const moved = await getExtensionBuild(admin, { buildId: build.id });
    expect(moved.phase).toBe('failed');
    expect(moved.failureDetail).toBe('raw move');

    // the failure vocabulary is CHECKed for bypassing writes
    await expect(
      getDb().query(
        `UPDATE extension_builds SET failure_code = 'exploded' WHERE tenant_id = $1 AND id = $2`,
        [tenantStorage, build.id],
      ),
    ).rejects.toThrow();
    await expect(
      getDb().query(
        `UPDATE extension_builds SET phase = 'dreaming' WHERE tenant_id = $1 AND id = $2`,
        [tenantStorage, build.id],
      ),
    ).rejects.toThrow();
    // a live phase may not carry failure evidence (the shape CHECK): the
    // update below leaves failure_code set while moving to 'building'
    await expect(
      getDb().query(
        `UPDATE extension_builds SET phase = 'building' WHERE tenant_id = $1 AND id = $2`,
        [tenantStorage, build.id],
      ),
    ).rejects.toThrow();
  });

  it('keeps artifacts append-only custody', async () => {
    const admin = extensionAdmin(tenantStorage);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'custody-tool',
      version: '1.0.0',
      brief: 'custody',
      agentId,
    });
    transport.respondWith(designOutput());
    await runExtensionBuild(admin, { buildId: build.id }); // → building (design artifact recorded)

    await expect(
      getDb().query(
        `UPDATE extension_build_artifacts SET payload = '"rewritten"'::jsonb WHERE tenant_id = $1 AND build_id = $2`,
        [tenantStorage, build.id],
      ),
    ).rejects.toThrow(/append-only custody/);
    await expect(
      getDb().query(`DELETE FROM extension_build_artifacts WHERE tenant_id = $1 AND build_id = $2`, [
        tenantStorage,
        build.id,
      ]),
    ).rejects.toThrow(/append-only custody/);
    await expect(
      getDb().query(`TRUNCATE extension_build_artifacts`),
    ).rejects.toThrow(/append-only custody/);
  });

  it('bounds the recorded failure detail at the storage level', async () => {
    const admin = extensionAdmin(tenantStorage);
    const agentId = await registerBuilderAgent(admin);
    const build = await requestExtensionBuild(admin, {
      extensionKey: 'verbose-tool',
      version: '1.0.0',
      brief: 'verbose',
      agentId,
    });
    await expect(
      getDb().query(
        `UPDATE extension_builds SET failure_detail = $3 WHERE tenant_id = $1 AND id = $2`,
        [tenantStorage, build.id, 'x'.repeat(513)],
      ),
    ).rejects.toThrow();
  });
});
