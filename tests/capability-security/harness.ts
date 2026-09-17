// W047 — Capability Security Verification: shared harness.
//
// Cross-module verification fixtures for the capability surfaces of the
// Aurum platform: the extensions module (W025 contracts, W026 runtime,
// W027 builder), the agents module (W021 gateway) and the actions module
// (W009 authority matrix). The test files next to this harness prove
// those surfaces cannot cross the four boundary classes of
// WORK-ITEM-CATALOG.md W047 — tenant, install, permission and sandbox.
//
// Scope posture (GOVERNANCE.md "implement only declared scope"): W047 is
// a verification work item, so the cross-module test directory
// tests/capability-security/ is sanctioned by the work item itself
// ("Cross-module test dirs need architect approval — do not create them
// unless your item is a verification item"). This harness imports other
// modules ONLY through their contract.ts surfaces (IMPLEMENTATION-STACK
// §2), plus the src/infra ports and the migration runner exactly like
// the sibling module tests do.
//
// Marketplace note: W028 (Marketplace Governance — ExtensionPackage and
// AgentPackage lifecycle) is NOT delivered at this base (no
// src/modules/marketplace/ exists at commit 8f2096a). The
// package-adjacent surfaces that DO exist today — immutable versioned
// extension manifests as package payloads, the VERIFIED-before-ACTIVE
// gate, the install-time grant ⊆ requested-ceiling bound, and the
// builder's append-only artifact custody — are proven by these tests;
// the publication / platform-approval lifecycle itself remains W028's
// to deliver (reported under DEVIATIONS in the work item report).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as agentsContract from '@/modules/agents/contract';
import * as extensionsContract from '@/modules/extensions/contract';
import {
  ActionsError,
  type ActionsErrorCode,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { expect } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import type {
  ExtensionHttpCall,
  ExtensionsErrorCode,
  RegisterExtensionManifestInput,
} from '@/modules/extensions/contract';
import type {
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
  AgentsErrorCode,
  RegisterAgentInput,
} from '@/modules/agents/contract';

export { runMigrations } from '../../scripts/migrate';
export { newId } from '@/infra/ids';

// ---------------------------------------------------------------------------
// Contract surfaces (re-exported once so every test file imports the same
// names through this harness — always and only the contract surface)
// ---------------------------------------------------------------------------

export const {
  EXTENSIONS_AUTHORITY_ADMINISTER,
  EXTENSION_ACTION_KIND,
  BUILDER_AGENT_SCOPES,
  deployExtensionVersion,
  dispatchExtensionEvent,
  emitExtensionTelemetry,
  executeExtensionExternalCall,
  getExtension,
  getExtensionBuild,
  getExtensionUi,
  getManifest,
  getManifestVerification,
  getCurrentDeployment,
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
  publishExtensionUi,
  readExtensionState,
  registerExtensionManifest,
  requestExtensionBuild,
  rollbackExtensionDeployment,
  runExtensionBuild,
  runManifestVerification,
  setExtensionHttpPort,
  transitionExtension,
  triggerExtensionSchedule,
  writeExtensionState,
} = extensionsContract;

export const {
  AGENT_ACTION_KIND,
  AGENTS_AUTHORITY_ADMINISTER_CLAIM,
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
} = agentsContract;

export { decideApproval, listActionRequests, setAuthorityPolicy } from '@/modules/actions/contract';
export { ActionsError } from '@/modules/actions/contract';
export type { ActionsErrorCode } from '@/modules/actions/contract';

export { ExtensionsError } from '@/modules/extensions/contract';
export type { ExtensionsErrorCode } from '@/modules/extensions/contract';

export { AgentsError } from '@/modules/agents/contract';
export type { AgentsErrorCode } from '@/modules/agents/contract';

// ---------------------------------------------------------------------------
// Context factories (the sibling module tests' conventions)
// ---------------------------------------------------------------------------

/** A plain tenant member (no authority claims). */
export function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** A member with explicit authority claims and a fixed principal. */
export function memberAs(tenantId: string, principalId: string, authority: string[]): TenantContext {
  return { tenantId, principalId, authority };
}

/** The extensions-module administration claim holder. */
export function extensionAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [EXTENSIONS_AUTHORITY_ADMINISTER] };
}

/** The agents-module administration claim holder. */
export function agentsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [AGENTS_AUTHORITY_ADMINISTER_CLAIM] };
}

/** The actions-module administration claim holder. */
export function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

/** A DIFFERENT principal holding the approval claim (separation of duties). */
export function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

// ---------------------------------------------------------------------------
// Typed error assertions (the modules' uniform discipline)
// ---------------------------------------------------------------------------

export async function expectExtensionsError(
  code: ExtensionsErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    expect.unreachable(`expected ExtensionsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof extensionsContract.ExtensionsError)) throw error;
    expect(error.code).toBe(code);
  }
}

export async function expectAgentsError(
  code: AgentsErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    expect.unreachable(`expected AgentsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof agentsContract.AgentsError)) throw error;
    expect(error.code).toBe(code);
  }
}

export async function expectActionsError(
  code: ActionsErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    expect.unreachable(`expected ActionsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ActionsError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Manifest fixtures (the W025 registration input shapes)
// ---------------------------------------------------------------------------

const FULL_PERMISSIONS = [
  'state:read',
  'state:write',
  'ui:render',
  'schedule:run',
  'events:subscribe',
  'external:participate',
  'telemetry:emit',
] as const;

/** A full-capability manifest whose host range covers the runtime's version. */
export function fullManifest(
  overrides: Partial<RegisterExtensionManifestInput> = {},
): RegisterExtensionManifestInput {
  return {
    extensionKey: 'capability-probe',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Capability Probe',
    description: 'Exercises every capability area of the extension runtime',
    requestedPermissions: [...FULL_PERMISSIONS],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 1_440,
      maxExternalCallsPerDay: 100_000,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
    ...overrides,
  };
}

/** An inert manifest: no capabilities, no permissions, no quotas. */
export function inertManifest(
  overrides: Partial<RegisterExtensionManifestInput> = {},
): RegisterExtensionManifestInput {
  return {
    extensionKey: 'inert-probe',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Inert Probe',
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
    requestedPermissions: [],
    stateScope: 'none',
    uiSurfaces: [],
    schedules: [],
    eventSubscriptions: [],
    externalParticipants: [],
    telemetry: false,
    quotas: { maxStateBytes: 0, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Workflow helpers shared by the boundary suites
// ---------------------------------------------------------------------------

/** Register + verify a manifest so its extension can be activated/deployed. */
export async function registerVerified(
  ctx: TenantContext,
  input: RegisterExtensionManifestInput,
): Promise<{ extensionId: string; manifestId: string }> {
  const registered = await registerExtensionManifest(ctx, input);
  const run = await runManifestVerification(ctx, { manifestId: registered.manifest.id });
  if (run.state !== 'VERIFIED') {
    throw new Error(`fixture manifest did not verify (state ${run.state})`);
  }
  return { extensionId: registered.extension.id, manifestId: registered.manifest.id };
}

/** Pin "extension-deployment EXECUTE is allowed" for a tenant up front. */
export async function allowExtensionDeployment(tenantId: string): Promise<void> {
  await setAuthorityPolicy(actionsAdmin(tenantId), {
    actionKind: 'extension-deployment',
    approvalLevels: [],
  });
}

/** Forbid "extension-deployment EXECUTE" for a tenant outright. */
export async function forbidExtensionDeployment(tenantId: string): Promise<void> {
  await setAuthorityPolicy(actionsAdmin(tenantId), {
    actionKind: 'extension-deployment',
    forbiddenLevels: ['EXECUTE'],
  });
}

// ---------------------------------------------------------------------------
// Agent fixtures
// ---------------------------------------------------------------------------

/** An analyze/recommend analyst agent (W021's ANALYST fixture shape). */
export const ANALYST_AGENT: RegisterAgentInput = {
  slug: 'boundary-analyst',
  displayName: 'Boundary Analyst',
  role: 'conversation triage',
  description: 'Analyzes inbound conversations and drafts recommendations.',
  provider: 'openai-assistants',
  instructions: 'Analyze the conversation and propose a recommendation.',
  permissions: ['observe', 'analyze', 'recommend'],
  runtimeConfig: { assistantId: 'asst_boundary' },
};

/** An all-scope operator agent (EXECUTE-capable). */
export const OPERATOR_AGENT: RegisterAgentInput = {
  ...ANALYST_AGENT,
  slug: 'boundary-operator',
  role: 'reply operator',
  permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose', 'execute'],
};

/** The builder's isolated agent (exactly the builder scopes). */
export const BUILDER_AGENT: RegisterAgentInput = {
  ...ANALYST_AGENT,
  slug: 'boundary-builder',
  role: 'extension builder',
  permissions: ['analyze', 'propose'],
};

/**
 * A recording fake agent transport that speaks every runtime dialect
 * (the sibling agents-service tests' fixture, trimmed to W047's needs:
 * every dispatch is captured; responses are always well-formed native
 * payloads the module-private adapters can normalize).
 */
export class FakeAgentTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];

  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.requests.push(request);
    const taskId = `w047-${String(this.requests.length).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: this.payloadFor(request.provider, taskId),
      providerTaskId: taskId,
      detail: null,
    };
  }

  /** Dispatch requests aimed at any of `agentIds` so far. */
  requestsFor(agentIds: readonly string[]): AgentRuntimeTransportRequest[] {
    return this.requests.filter((request) => agentIds.includes(request.agentId));
  }

  /** Builds a runtime-NATIVE payload for the adapter to parse (dialect realism). */
  private payloadFor(provider: string, taskId: string): unknown {
    const output = { w047: true };
    const summary = 'boundary probe';
    switch (provider) {
      case 'openai-assistants':
        return {
          id: `run_${taskId}`,
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify(output) }],
            },
          ],
          usage: { input_tokens: 1200, output_tokens: 800 },
        };
      case 'langgraph':
        return {
          run_id: `lg_${taskId}`,
          output: { result: output, summary },
          usage: { input_tokens: 1200, output_tokens: 800, steps: 3 },
        };
      case 'crewai':
        return {
          run_id: `crew_${taskId}`,
          status: 'completed',
          result: output,
          summary,
          token_usage: { input_tokens: 1200, output_tokens: 800, requests: 3 },
        };
      case 'autogen':
        return {
          id: `ag_${taskId}`,
          summary,
          result: output,
          usage: { prompt_tokens: 1200, completion_tokens: 800 },
        };
      default: // semantic-kernel
        return {
          runId: `sk_${taskId}`,
          output,
          summary,
          usage: { inputTokens: 1200, outputTokens: 800, invocations: 3 },
        };
    }
  }
}

/**
 * A deterministic fake egress port (the sibling runtime tests' fixture):
 * every call is captured; the URL decides the outcome; nothing touches
 * the network.
 */
export const portCalls: ExtensionHttpCall[] = [];

export function wireFakeEgressPort(): void {
  setExtensionHttpPort(async (call) => {
    portCalls.push(call);
    if (call.url.endsWith('/notfound')) return { status: 404, bodyText: 'no such resource' };
    if (call.url.endsWith('/boom')) throw new Error('network unreachable');
    return { status: 200, bodyText: '{"ok":true}' };
  });
}
