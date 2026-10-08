// Service proofs for the execution-fabric module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Test-locks every
// acceptance axis of W137 (spec/work-items/WORK-ITEM-CATALOG.md §W137 —
// "isolation, persistence where required, artifact handoff, takeover,
// cancellation, recovery and evidence are tested; vendor removal does not
// change domain contracts"):
//
//   * ISOLATION — two-tenant separation at every read/mutation/list
//     surface (uniform typed not-founds, no existence leak, same defKey
//     coexists) PLUS session-credential isolation: the credential rides
//     the lease as an OPAQUE reference (W082), is handed verbatim to the
//     adapter's open at prepare (proven on the browser adapter's receipt
//     surface) and NEVER appears in a domain evidence tail;
//   * PERSISTENCE WHERE REQUIRED — a durable-checkpoint lease without a
//     recorded checkpoint refuses recovery (checkpoint_required); with
//     one, recovery replays from the checkpoint cursor into a FRESH
//     session bound to the SAME isolated profile; a session-checkpoint
//     definition recovers from its prior session;
//   * ARTIFACT HANDOFF — artifacts cross the environment boundary by
//     opaque reference in both directions (digest optional), the
//     manifest reads back in evidence order, filterable; the four
//     evidence tables reject UPDATE/DELETE/TRUNCATE at the storage
//     level;
//   * TAKEOVER — the W131 'Take control' cycle: a human holds control
//     (holder 'human', reason + opaque W009 authorityActionRef
//     retained VERBATIM and never decided by the fabric), control
//     returns by EXPLICIT HAND-BACK ONLY (release on a suspended lease
//     refuses lease_suspended);
//   * CANCELLATION — fabric-executed: the terminal state commits first,
//     the vendor session closes best-effort after; cancellable from
//     preparing/live/suspended/lost; a REMOVED vendor never blocks
//     cancellation;
//   * RECOVERY — lease death parks 'lost' (NOT terminal), recovery
//     stamps the checkpoint ref it resumed from and clears the loss; a
//     failing vendor resume stamps the lease 'failed' with the
//     actionable detail, then refuses typed;
//   * EVIDENCE CAPTURE — the frozen W131 capture vocabulary with the
//     verification triad and literal redaction 'applied', servable only
//     on in-flight postures;
//   * THE VENDOR-REMOVAL CLAUSE — the SAME domain flow driven through
//     the fake-browser and fake-remote-sandbox adapters produces
//     IDENTICAL domain outcomes (statuses, reasons, event timelines);
//     unregistering the adapters leaves every read serving while
//     prepare/recover refuse adapter_not_registered, and cancellation
//     still completes; re-registration restores acquisition with the
//     domain contracts UNCHANGED; no vendor name rides in any domain
//     record;
//   * THE STATE MACHINE — one-way transitions with FOR-UPDATE
//     staleness re-checks (sequential second-call refusal — the
//     provable form on single-connection PGlite, same as W134/W135/
//     W136); the storage guard mirrors the legality definition;
//   * CROSS-MODULE GATING — every acquisition runs against a REAL W136
//     agent-exchange fixture chain (goal → plan → W021 execution →
//     recorded run): missing/completed plans and off-plan runs refuse
//     typed; retired definitions refuse new leases while existing
//     leases continue;
//   * TYPED NOT-FOUNDS + the honest-descriptor law — nothing is wired
//     by default ('local' kind → adapter_unavailable), a
//     supported:false declaration refuses acquisition explicitly, and
//     an unhealthy vendor is reported honestly, never fabricated.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): this harness NEVER
// opens a db.transaction of its own — the service opens exactly one
// transaction per mutation on the single PGlite connection, and a
// harness transaction around a service call would deadlock the embedded
// database. Every fixture is built through the REAL public contracts
// (goals, agent-exchange, agents, actions — the W137 seam map), never
// by direct SQL writes (the storage-guard probes are the deliberate
// exception: they prove the schema's own laws).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

// The module under proof — through its contract only (rule (b)).
import * as fabric from '../contract';
import { ExecutionFabricError } from '../contract';
import type {
  EnvironmentDefinition,
  ExecutionFabricErrorCode,
  FabricLease,
  RegisterEnvironmentDefinitionInput,
} from '../contract';
import {
  createLocalContainerAdapter,
  createBrowserEnvironmentAdapter,
  createRemoteSandboxAdapter,
  createFakeRemoteSandboxTransport,
} from '../contract';
import type {
  BrowserEnvironmentAdapter,
  LocalContainerAdapter,
  RemoteSandboxAdapter,
} from '../contract';

// The consumed seams, exercised as REAL records through their owning
// contracts (never re-derived, never direct-written):
//   goals W008 · agent-exchange W136 · agents W021 · actions W009 ·
//   computer-use W093/W110 (the BrowserDriver port, behind the browser
//   adapter) · W131 frozen vocabularies (through the execution contract)
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import * as exchangeContract from '@/modules/agent-exchange/contract';
import type { ExecutionPlan, ExecutionRun } from '@/modules/agent-exchange/contract';
import { registerAgent, submitAgentExecution } from '@/modules/agents/contract';
import type { AgentDefinition, AgentExecution } from '@/modules/agents/contract';
import { authorizeAction, getActionRequest } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import type { BrowserAllowlist, BrowserDriver } from '@/modules/computer-use/contract';

// Deterministic service-clock pins (the injectable clock discipline —
// same-millisecond writes must not decide what a proof shows).
const T_ISO_ACQUIRE_A = '2026-10-08T10:00:00.000Z';
const T_ISO_PREPARE_A = '2026-10-08T10:05:00.000Z';
const T_ISO_ACQUIRE_B = '2026-10-08T10:10:00.000Z';
const T_ISO_PREPARE_B = '2026-10-08T10:15:00.000Z';
const T_DEF_1 = '2026-10-08T11:00:00.000Z';
const T_DEF_2 = '2026-10-08T11:01:00.000Z';
const T_DEF_3 = '2026-10-08T11:02:00.000Z';
const T_ACQUIRE = '2026-10-08T11:05:00.000Z';
const T_PREPARE = '2026-10-08T11:10:00.000Z';
const T_ARTIFACT = '2026-10-08T11:15:00.000Z';
const T_EVIDENCE = '2026-10-08T11:20:00.000Z';
const T_CHECKPOINT = '2026-10-08T11:25:00.000Z';
const T_TAKEOVER = '2026-10-08T11:30:00.000Z';
const T_HANDBACK = '2026-10-08T11:35:00.000Z';
const T_HEARTBEAT = '2026-10-08T11:40:00.000Z';
const T_LOST = '2026-10-08T11:45:00.000Z';
const T_RECOVER = '2026-10-08T11:50:00.000Z';
const T_RELEASE = '2026-10-08T11:55:00.000Z';
const T_GDEF_1 = '2026-10-08T12:00:00.000Z';
const T_GDEF_2 = '2026-10-08T12:01:00.000Z';
const T_GDEF_3 = '2026-10-08T12:02:00.000Z';
const T_GDEF_4 = '2026-10-08T12:03:00.000Z';
const T_CONTINUE = '2026-10-08T12:10:00.000Z';
const T_RETIRE = '2026-10-08T12:11:00.000Z';
const T_EV_A = '2026-10-08T12:20:00.000Z';
const T_EV_B = '2026-10-08T12:21:00.000Z';
const T_EV_C = '2026-10-08T12:22:00.000Z';
const T_EV_D = '2026-10-08T12:23:00.000Z';
const T_CANCEL = '2026-10-08T12:30:00.000Z';
const T_Q1 = '2026-10-08T12:40:00.000Z';
const T_Q2 = '2026-10-08T12:41:00.000Z';
const T_VR_ACQUIRE = '2026-10-08T13:00:00.000Z';
const T_VR_PREPARE = '2026-10-08T13:05:00.000Z';
const T_VR_ARTIFACT = '2026-10-08T13:10:00.000Z';
const T_VR_EVIDENCE = '2026-10-08T13:15:00.000Z';
const T_VR_CHECKPOINT = '2026-10-08T13:20:00.000Z';
const T_VR_TAKEOVER = '2026-10-08T13:25:00.000Z';
const T_VR_HANDBACK = '2026-10-08T13:30:00.000Z';
const T_VR_LOST = '2026-10-08T13:35:00.000Z';
const T_VR_RECOVER = '2026-10-08T13:40:00.000Z';
const T_VR_RELEASE = '2026-10-08T13:45:00.000Z';
const T_RM_ACQUIRE = '2026-10-08T13:50:00.000Z';
const T_RM_PREPARE = '2026-10-08T13:51:00.000Z';
const T_RM_CHECKPOINT = '2026-10-08T13:52:00.000Z';
const T_RM_LOST = '2026-10-08T13:53:00.000Z';
const T_OPEN_FAIL = '2026-10-08T14:00:00.000Z';
const T_OPEN_FAIL_STAMP = '2026-10-08T14:01:00.000Z';
const T_RESUME_FAIL_ACQUIRE = '2026-10-08T14:10:00.000Z';
const T_RESUME_FAIL_STAMP = '2026-10-08T14:20:00.000Z';
const T_FAIL = '2026-10-08T14:30:00.000Z';

function pinClock(at: string): () => void {
  const realNow = systemClock.now;
  systemClock.now = () => new Date(at);
  return () => {
    systemClock.now = realNow;
  };
}

/** Pin the clock around one async service call (deterministic stamps). */
async function at<T>(time: string, fn: () => Promise<T>): Promise<T> {
  const unpin = pinClock(time);
  try {
    return await fn();
  } finally {
    unpin();
  }
}

function plusMinutes(from: string, minutes: number): string {
  return new Date(new Date(from).getTime() + minutes * 60_000).toISOString();
}

function member(
  tenantId: string,
  principalId = newId(),
  authority: string[] = [],
): TenantContext {
  return { tenantId, principalId, authority };
}

async function expectCode(
  code: ExecutionFabricErrorCode,
  fn: () => Promise<unknown>,
): Promise<ExecutionFabricError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionFabricError);
    const typed = error as ExecutionFabricError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// Fixture factories (all content caller-supplied — no industry or
// matching semantics live in these helpers)
// ---------------------------------------------------------------------------

function goalInput(title: string) {
  return {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team' as const, label: 'operations' },
    priority: 'high' as const,
    successCriteria: 'Measurable success',
    actor: { kind: 'system' as const, label: 'w137-test' },
  };
}

/** Registers one active agent definition (the W021 execution side). */
async function registerTenantAgent(ctx: TenantContext, slug: string): Promise<AgentDefinition> {
  const registered = await registerAgent(ctx, {
    slug,
    displayName: slug,
    role: 'specialist execution',
    description: 'Executes plan tasks inside leased environments.',
    provider: 'openai-assistants',
    instructions: 'Execute the assigned task and report.',
    permissions: ['observe', 'analyze'],
    runtimeConfig: { assistantId: `asst_${slug}` },
  });
  return registered.agent;
}

/**
 * The full REAL W136 fixture chain for one tenant: goal → plan (one
 * tenant-agent member) → W021 execution → recorded run. Returns the
 * ids the fabric's acquisition gate consumes.
 */
async function exchangeFixture(
  ctx: TenantContext,
  admin: TenantContext,
  title: string,
): Promise<{ goal: Goal; plan: ExecutionPlan; run: ExecutionRun }> {
  const goal = await createGoal(ctx, goalInput(title));
  const agent = await registerTenantAgent(admin, `agent-${newId().slice(0, 8)}`);
  const plan = await exchangeContract.createExecutionPlan(ctx, {
    goalId: goal.id,
    objective: `Execute ${title} inside an isolated environment`,
    tasks: [{ taskKey: 'survey', title: 'Survey the site' }],
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Lead specialist', ref: agent.id },
    ],
  });
  const execution: AgentExecution = await submitAgentExecution(ctx, {
    agentId: agent.id,
    task: { instruction: 'Survey the site', context: 'spring window' },
    requestedPermissions: ['observe'],
  });
  const run = await exchangeContract.recordExecutionRun(ctx, {
    planId: plan.id,
    taskKey: 'survey',
    agentExecutionId: execution.id,
    context: { evidenceRefs: ['obs-site-survey'] },
  });
  return { goal, plan, run };
}

function workspaceDefinition(
  defKey: string,
  displayName: string,
): RegisterEnvironmentDefinitionInput {
  return {
    defKey,
    displayName,
    kind: 'workspace',
    profileScope: 'task',
    networkEgress: 'restricted',
    survivesRestart: true,
    checkpoint: 'durable-checkpoint',
    persistentScope: '/workspace',
    requiredCapabilities: ['filesystem', 'commands'],
  };
}

/** Acquire one lease (left 'preparing'). */
async function newLease(
  ctx: TenantContext,
  definitionId: string,
  planId: string,
  executionRunId: string,
): Promise<FabricLease> {
  return fabric.acquireFabricLease(ctx, { definitionId, planId, executionRunId });
}

/** Acquire + prepare one lease (left 'live' with a disposable session). */
async function newPreparedLease(
  ctx: TenantContext,
  definitionId: string,
  planId: string,
  executionRunId: string,
): Promise<FabricLease> {
  const lease = await newLease(ctx, definitionId, planId, executionRunId);
  return fabric.prepareFabricLease(ctx, { leaseId: lease.id });
}

// ---------------------------------------------------------------------------
// The browser-driver double (the sanctioned W093/W110 seam — NO real
// browser is ever launched by this suite)
// ---------------------------------------------------------------------------

const FAKE_BROWSER_DRIVER: BrowserDriver = {
  startSession: async () => ({ sessionKey: `brow-${newId()}` }),
  performAction: async () => {
    throw new Error('the fabric never drives browser actions (computer-use owns that)');
  },
  endSession: async () => {},
};

const BROWSER_ALLOWLIST: BrowserAllowlist = {
  urlGlobs: ['https://example.com/*'],
  verbs: ['goto', 'read'],
};

const REMOTE_BASE = 'https://sandbox.vendor.example';

// ---------------------------------------------------------------------------
// Tenants (dedicated per concern so count/order assertions stay deterministic)
// ---------------------------------------------------------------------------

const tenantFlow = newId();
const tenantGate = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();

// The single principal that drives the whole lifecycle spine, so the
// evidence-tail `recordedBy` assertions stay deterministic.
const flowActor = member(tenantFlow);

// The in-memory adapter wiring (module state — the registered instances).
let localAdapter: LocalContainerAdapter;
let browserAdapter: BrowserEnvironmentAdapter;
let remoteAdapter: RemoteSandboxAdapter;

// --- tenantFlow: the lifecycle + vendor-removal + failure stamps ---
let planFlow: ExecutionPlan;
let runFlow: ExecutionRun;
let takeoverRequest: ActionRequest;
let defWorkspace: EnvironmentDefinition;
let defBrowser: EnvironmentDefinition;
let defRemote: EnvironmentDefinition;
let leaseMain: FabricLease;

// --- tenantGate: the cross-module gates + typed error paths ---
let planGate: ExecutionPlan;
let runGate: ExecutionRun;
let goalGate: Goal;
let defLocalKind: EnvironmentDefinition;
let defNoDisplay: EnvironmentDefinition;
let defRetire: EnvironmentDefinition;
let defPlain: EnvironmentDefinition;

// --- tenantIsoA / tenantIsoB: tenant isolation ---
let defIsoA: EnvironmentDefinition;
let defIsoB: EnvironmentDefinition;
let leaseIsoA: FabricLease;
let leaseIsoB: FabricLease;
let planIsoA: ExecutionPlan;
let planIsoB: ExecutionPlan;
let runIsoB: ExecutionRun;

beforeAll(async () => {
  await runMigrations(getDb());

  // The adapter wiring (in-memory, never domain state): the three
  // evaluated catalog paths behind the frozen W131 shape, registered in
  // a fixed order so resolution is deterministic. The browser path
  // composes the W093/W110 BrowserDriver port through a fake driver;
  // the remote path runs behind the fake transport — no network, no
  // browser, ever.
  localAdapter = createLocalContainerAdapter();
  browserAdapter = createBrowserEnvironmentAdapter({
    driver: FAKE_BROWSER_DRIVER,
    allowlist: BROWSER_ALLOWLIST,
  });
  remoteAdapter = createRemoteSandboxAdapter({
    apiBaseUrl: REMOTE_BASE,
    transport: createFakeRemoteSandboxTransport(),
  });
  await fabric.registerExecutionAdapter(localAdapter);
  await fabric.registerExecutionAdapter(browserAdapter);
  await fabric.registerExecutionAdapter(remoteAdapter);

  // ------------------------------------------------------------------
  // tenantFlow — the lifecycle fixtures (REAL W136 chain).
  // ------------------------------------------------------------------
  const flow = member(tenantFlow);
  const flowAdmin = member(tenantFlow, newId(), ['agents:administer']);
  const flowFixture = await exchangeFixture(flow, flowAdmin, 'Execute the site program');
  planFlow = flowFixture.plan;
  runFlow = flowFixture.run;

  // The opaque W009 consequential-action reference a takeover may cite.
  takeoverRequest = await authorizeAction(flow, {
    actionKind: 'agent-execution',
    authorityLevel: 'EXECUTE',
    payload: { what: 'the site-workspace takeover' },
    justification: 'the operator takes control for inspection',
  });

  defWorkspace = await at(T_DEF_1, () =>
    fabric.registerEnvironmentDefinition(flow, workspaceDefinition('site-workspace', 'Site workspace')),
  );
  defBrowser = await at(T_DEF_2, () =>
    fabric.registerEnvironmentDefinition(flow, {
      defKey: 'site-browser',
      displayName: 'Site browser',
      kind: 'browser',
      profileScope: 'task',
      networkEgress: 'restricted',
      survivesRestart: false,
      checkpoint: 'session',
      requiredCapabilities: ['display', 'browser-profile'],
    }),
  );
  defRemote = await at(T_DEF_3, () =>
    fabric.registerEnvironmentDefinition(flow, {
      defKey: 'site-remote',
      displayName: 'Site remote sandbox',
      kind: 'remote-sandbox',
      profileScope: 'task',
      networkEgress: 'restricted',
      survivesRestart: true,
      checkpoint: 'durable-checkpoint',
      persistentScope: '/sandbox',
      requiredCapabilities: ['filesystem', 'commands', 'display'],
    }),
  );

  // ------------------------------------------------------------------
  // tenantGate — the gating + typed-error fixtures.
  // ------------------------------------------------------------------
  const gate = member(tenantGate);
  const gateAdmin = member(tenantGate, newId(), ['agents:administer']);
  const gateFixture = await exchangeFixture(gate, gateAdmin, 'The gated program');
  goalGate = gateFixture.goal;
  planGate = gateFixture.plan;
  runGate = gateFixture.run;

  defLocalKind = await at(T_GDEF_1, () =>
    fabric.registerEnvironmentDefinition(gate, {
      defKey: 'gate-local-kind',
      displayName: 'In-process fixture environment',
      kind: 'local',
      profileScope: 'session',
      networkEgress: 'disabled',
      survivesRestart: false,
      checkpoint: 'none',
      requiredCapabilities: [],
    }),
  );
  defNoDisplay = await at(T_GDEF_2, () =>
    fabric.registerEnvironmentDefinition(gate, {
      defKey: 'gate-no-display',
      displayName: 'Workspace with a display requirement',
      kind: 'workspace',
      profileScope: 'task',
      networkEgress: 'restricted',
      survivesRestart: true,
      checkpoint: 'durable-checkpoint',
      persistentScope: '/workspace',
      requiredCapabilities: ['filesystem', 'display'],
    }),
  );
  defRetire = await at(T_GDEF_3, () =>
    fabric.registerEnvironmentDefinition(
      gate,
      workspaceDefinition('gate-retire', 'The retirement fixture'),
    ),
  );
  defPlain = await at(T_GDEF_4, () =>
    fabric.registerEnvironmentDefinition(
      gate,
      workspaceDefinition('gate-workspace-plain', 'The plain gated workspace'),
    ),
  );

  // ------------------------------------------------------------------
  // tenantIsoA / tenantIsoB — isolation fixtures (same defKey, same
  // shape, one prepared lease each).
  // ------------------------------------------------------------------
  const isoA = member(tenantIsoA);
  const isoAAdmin = member(tenantIsoA, newId(), ['agents:administer']);
  const isoAFixture = await exchangeFixture(isoA, isoAAdmin, 'The isolation program A');
  defIsoA = await fabric.registerEnvironmentDefinition(
    isoA,
    workspaceDefinition('iso-workspace', 'Isolation workspace'),
  );
  leaseIsoA = await at(T_ISO_ACQUIRE_A, () =>
    fabric.acquireFabricLease(isoA, {
      definitionId: defIsoA.id,
      planId: isoAFixture.plan.id,
      executionRunId: isoAFixture.run.id,
    }),
  );
  leaseIsoA = await at(T_ISO_PREPARE_A, () =>
    fabric.prepareFabricLease(isoA, { leaseId: leaseIsoA.id }),
  );
  planIsoA = isoAFixture.plan;

  const isoB = member(tenantIsoB);
  const isoBAdmin = member(tenantIsoB, newId(), ['agents:administer']);
  const isoBFixture = await exchangeFixture(isoB, isoBAdmin, 'The isolation program B');
  defIsoB = await fabric.registerEnvironmentDefinition(
    isoB,
    workspaceDefinition('iso-workspace', 'Isolation workspace'),
  );
  leaseIsoB = await at(T_ISO_ACQUIRE_B, () =>
    fabric.acquireFabricLease(isoB, {
      definitionId: defIsoB.id,
      planId: isoBFixture.plan.id,
      executionRunId: isoBFixture.run.id,
    }),
  );
  leaseIsoB = await at(T_ISO_PREPARE_B, () =>
    fabric.prepareFabricLease(isoB, { leaseId: leaseIsoB.id }),
  );
  planIsoB = isoBFixture.plan;
  runIsoB = isoBFixture.run;
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The vendor-neutral definitions
// ---------------------------------------------------------------------------

describe('registerEnvironmentDefinition — the vendor-neutral registry', () => {
  it('registers and normalizes the retained shape (isolation literals included)', async () => {
    expect(defWorkspace).toMatchObject({
      tenantId: tenantFlow,
      defKey: 'site-workspace',
      displayName: 'Site workspace',
      kind: 'workspace',
      isolation: {
        tenantIsolated: true,
        profileScope: 'task',
        networkEgress: 'restricted',
        credentialHandling: 'opaque-ref-only',
      },
      persistence: {
        survivesRestart: true,
        checkpoint: 'durable-checkpoint',
        persistentScope: '/workspace',
      },
      requiredCapabilities: ['filesystem', 'commands'],
      status: 'active',
      note: null,
      createdBy: expect.any(String),
      createdAt: T_DEF_1,
      retiredAt: null,
    });
    // The read path serves the same record uniformly.
    const read = await fabric.getEnvironmentDefinition(member(tenantFlow), {
      definitionId: defWorkspace.id,
    });
    expect(read).toEqual(defWorkspace);
  });

  it('refuses a reused defKey (a changed definition is a NEW definition)', async () => {
    const flow = member(tenantFlow);
    await expectCode('definition_key_taken', () =>
      fabric.registerEnvironmentDefinition(flow, workspaceDefinition('site-workspace', 'Again')),
    );
    await expectCode('definition_not_found', () =>
      fabric.getEnvironmentDefinition(flow, { definitionId: newId() }),
    );
  });

  it('lists definitions newest-first with the kind filter', async () => {
    const gate = member(tenantGate);
    const all = await fabric.listEnvironmentDefinitions(gate);
    expect(all.map((d) => d.defKey)).toEqual([
      'gate-workspace-plain',
      'gate-retire',
      'gate-no-display',
      'gate-local-kind',
    ]);
    const workspaces = await fabric.listEnvironmentDefinitions(gate, { kind: 'workspace' });
    expect(workspaces.map((d) => d.defKey)).toEqual([
      'gate-workspace-plain',
      'gate-retire',
      'gate-no-display',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cross-module gating — the REAL W136 seams (acceptance: the fabric
// serves in-flight orchestration only)
// ---------------------------------------------------------------------------

describe('acquireFabricLease — the W136 evidence gates (REAL fixtures)', () => {
  it('refuses missing and non-ACTIVE exchange plans uniformly', async () => {
    const gate = member(tenantGate);
    await expectCode('exchange_plan_not_found', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defPlain.id,
        planId: newId(),
        executionRunId: runGate.id,
      }),
    );
    const done = await exchangeContract.createExecutionPlan(gate, {
      goalId: goalGate.id,
      objective: 'A finished program',
      tasks: [{ taskKey: 'probe', title: 'Probe' }],
    });
    await exchangeContract.completeExecutionPlan(gate, {
      planId: done.id,
      note: 'delivered and evidenced',
    });
    // A completed plan acquires no new environments — the fabric serves
    // in-flight orchestration only.
    await expectCode('exchange_plan_not_found', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defPlain.id,
        planId: done.id,
        executionRunId: runGate.id,
      }),
    );
  });

  it('refuses runs not recorded on the named plan', async () => {
    const gate = member(tenantGate);
    const planB = await exchangeContract.createExecutionPlan(gate, {
      goalId: goalGate.id,
      objective: 'A second program (the off-plan probe)',
      tasks: [{ taskKey: 'probe', title: 'Probe' }],
    });
    await expectCode('execution_run_not_found', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defPlain.id,
        planId: planB.id,
        executionRunId: runGate.id,
      }),
    );
    await expectCode('execution_run_not_found', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defPlain.id,
        planId: planGate.id,
        executionRunId: newId(),
      }),
    );
  });

  it('refuses retired definitions while existing leases continue', async () => {
    const gate = member(tenantGate);
    const continuing = await at(T_CONTINUE, () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defRetire.id,
        planId: planGate.id,
        executionRunId: runGate.id,
      }),
    );
    const retired = await at(T_RETIRE, () =>
      fabric.retireEnvironmentDefinition(gate, { definitionId: defRetire.id }),
    );
    expect(retired.status).toBe('retired');
    expect(retired.retiredAt).toBe(T_RETIRE);
    // The definition lifecycle is one-way, terminal.
    await expectCode('definition_already_retired', () =>
      fabric.retireEnvironmentDefinition(gate, { definitionId: defRetire.id }),
    );
    // New acquisitions refuse.
    await expectCode('definition_retired', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defRetire.id,
        planId: planGate.id,
        executionRunId: runGate.id,
      }),
    );
    // Existing leases continue through the full lifecycle.
    const prepared = await fabric.prepareFabricLease(gate, { leaseId: continuing.id });
    expect(prepared.status).toBe('live');
  });

  it('refuses definitions nothing serves, and unsupported capabilities, explicitly', async () => {
    const gate = member(tenantGate);
    // Nothing is wired by default for the frozen 'local' kind — the
    // honest-descriptor law refuses rather than faking success.
    await expectCode('adapter_unavailable', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defLocalKind.id,
        planId: planGate.id,
        executionRunId: runGate.id,
      }),
    );
    // The local-container path declares display supported:false — the
    // required capability is refused explicitly, never fabricated.
    await expectCode('adapter_capability_unsupported', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defNoDisplay.id,
        planId: planGate.id,
        executionRunId: runGate.id,
      }),
    );
    await expectCode('definition_not_found', () =>
      fabric.acquireFabricLease(gate, {
        definitionId: newId(),
        planId: planGate.id,
        executionRunId: runGate.id,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The full lease lifecycle — the acceptance spine (isolation,
// persistence, artifact handoff, takeover, recovery, evidence)
// ---------------------------------------------------------------------------

describe('the full lease lifecycle over the real fabric', () => {
  it('acquires a lease bound to the REAL W136 run with the resolved adapter', async () => {
    const flow = flowActor;
    leaseMain = await at(T_ACQUIRE, () =>
      fabric.acquireFabricLease(flow, {
        definitionId: defWorkspace.id,
        planId: planFlow.id,
        executionRunId: runFlow.id,
        credentialRef: 'vault://env/site-ssh-key',
        leaseMinutes: 90,
      }),
    );
    expect(leaseMain.status).toBe('preparing');
    expect(leaseMain.definitionKey).toBe('site-workspace');
    expect(leaseMain.definitionKind).toBe('workspace');
    expect(leaseMain.planId).toBe(planFlow.id);
    expect(leaseMain.executionRunId).toBe(runFlow.id);
    // The run's identity is denormalized from the REAL W136 record.
    expect(leaseMain.taskKey).toBe(runFlow.taskKey);
    expect(leaseMain.agentId).toBe(runFlow.agentId);
    expect(leaseMain.taskKey).toBe('survey');
    // The credential rides the lease as an OPAQUE reference (W082).
    expect(leaseMain.credentialRef).toBe('vault://env/site-ssh-key');
    expect(leaseMain.adapterId).toBe('local-container-sim-1');
    expect(leaseMain.leaseMinutes).toBe(90);
    expect(leaseMain.sessionId).toBeNull();
    expect(leaseMain.leaseUntil).toBeNull();
    expect(leaseMain.createdAt).toBe(T_ACQUIRE);
    expect(leaseMain.acquiredBy).toBe(flow.principalId);
  });

  it('prepares the disposable session, tenant+subject isolated', async () => {
    const flow = flowActor;
    const prepared = await at(T_PREPARE, () =>
      fabric.prepareFabricLease(flow, { leaseId: leaseMain.id }),
    );
    leaseMain = prepared;
    expect(prepared.status).toBe('live');
    expect(prepared.sessionId).toMatch(/^lcs-/);
    expect(prepared.openedAt).toBe(T_PREPARE);
    expect(prepared.leaseUntil).toBe(plusMinutes(T_PREPARE, 90));
    expect(prepared.lastHeartbeatAt).toBe(T_PREPARE);
    // Adapter-side: the session's isolated profile key is scoped to the
    // TENANT and the lease (the W093 per-(tenant,task) discipline).
    const record = localAdapter.state.sessions.find(
      (s) => s.sessionId === prepared.sessionId,
    );
    expect(record).toBeDefined();
    expect(record!.profileKey).toBe(`tenant:${tenantFlow}:subject:${leaseMain.id}`);
  });

  it('hands artifacts across the boundary and captures evidence with literal redaction', async () => {
    const flow = flowActor;
    const artifact = await at(T_ARTIFACT, () =>
      fabric.recordArtifactHandoff(flow, {
        leaseId: leaseMain.id,
        direction: 'out',
        artifactRef: 'artifact://site-report',
        artifactKind: 'report',
        digest: 'a1b2c3d4e5f6a7b8',
      }),
    );
    expect(artifact.digest).toBe('a1b2c3d4e5f6a7b8');
    expect(artifact.recordedBy).toBe(flow.principalId);
    expect(artifact.recordedAt).toBe(T_ARTIFACT);
    const evidence = await at(T_EVIDENCE, () =>
      fabric.recordLeaseEvidence(flow, {
        leaseId: leaseMain.id,
        captureKind: 'screenshot',
        artifactRef: 'artifact://shot-1',
        verification: 'verified',
        detail: 'the site dashboard',
      }),
    );
    expect(evidence.redaction).toBe('applied');
    expect(evidence.verification).toBe('verified');
  });

  it('cuts a durable checkpoint naming the covered evidence', async () => {
    const flow = flowActor;
    const cursor = `${leaseMain.sessionId}@worker-cursor-1`;
    const checkpoint = await at(T_CHECKPOINT, () =>
      fabric.recordLeaseCheckpoint(flow, {
        leaseId: leaseMain.id,
        cursor,
        coveredEvidenceRefs: ['artifact://shot-1'],
      }),
    );
    expect(checkpoint.cursor).toBe(cursor);
    expect(checkpoint.coveredEvidenceRefs).toEqual(['artifact://shot-1']);
    expect(checkpoint.recordedAt).toBe(T_CHECKPOINT);
  });

  it('takes over for a human (opaque W009 ref retained, never decided) and hands back', async () => {
    const flow = flowActor;
    const taken = await at(T_TAKEOVER, () =>
      fabric.takeoverFabricLease(flow, {
        leaseId: leaseMain.id,
        reason: 'operator inspection',
        authorityActionRef: takeoverRequest.id,
      }),
    );
    expect(taken.status).toBe('suspended');
    expect(taken.takeoverHolder).toBe('human');
    expect(taken.takenOverAt).toBe(T_TAKEOVER);
    expect(taken.takeoverReason).toBe('operator inspection');
    // The opaque W009 ref is retained VERBATIM — and the fabric never
    // decided the approval (the actions authority stays untouched).
    expect(taken.authorityActionRef).toBe(takeoverRequest.id);
    const request = await getActionRequest(flow, { requestId: takeoverRequest.id });
    expect(request.status).toBe('pending');
    // Control returns by EXPLICIT HAND-BACK ONLY.
    const handed = await at(T_HANDBACK, () =>
      fabric.handbackFabricLease(flow, {
        leaseId: leaseMain.id,
        note: 'inspection complete',
      }),
    );
    expect(handed.status).toBe('live');
    expect(handed.takeoverHolder).toBeNull();
    expect(handed.handbackAt).toBe(T_HANDBACK);
    expect(handed.handbackNote).toBe('inspection complete');
  });

  it('heartbeats the live lease into a renewed window', async () => {
    const flow = flowActor;
    const beat = await at(T_HEARTBEAT, () =>
      fabric.heartbeatFabricLease(flow, { leaseId: leaseMain.id }),
    );
    expect(beat.status).toBe('live');
    expect(beat.leaseUntil).toBe(plusMinutes(T_HEARTBEAT, 90));
    expect(beat.lastHeartbeatAt).toBe(T_HEARTBEAT);
  });

  it('parks a dead lease lost, then recovers a FRESH session from the checkpoint', async () => {
    const flow = flowActor;
    const priorSessionId = leaseMain.sessionId;
    const lost = await at(T_LOST, () =>
      fabric.markFabricLeaseLost(flow, {
        leaseId: leaseMain.id,
        detail: 'worker host died',
      }),
    );
    expect(lost.status).toBe('lost'); // parked, NOT terminal
    expect(lost.lostAt).toBe(T_LOST);
    expect(lost.lostDetail).toBe('worker host died');
    const recovered = await at(T_RECOVER, () =>
      fabric.recoverFabricLease(flow, { leaseId: leaseMain.id }),
    );
    expect(recovered.status).toBe('live');
    // A FRESH disposable session (never the dead one).
    expect(recovered.sessionId).toMatch(/^lcs-/);
    expect(recovered.sessionId).not.toBe(priorSessionId);
    // Persistence where required: recovery names the checkpoint it
    // resumed from, the loss is cleared, first liveness is retained.
    expect(recovered.recoveredFromCheckpointRef).toBe(`${priorSessionId}@worker-cursor-1`);
    expect(recovered.recoveredAt).toBe(T_RECOVER);
    expect(recovered.lostAt).toBeNull();
    expect(recovered.lostDetail).toBeNull();
    expect(recovered.openedAt).toBe(T_PREPARE);
    expect(recovered.leaseUntil).toBe(plusMinutes(T_RECOVER, 90));
    // Adapter-side: the fresh session binds to the SAME isolated
    // profile (the simulated volume survives session death).
    const prior = localAdapter.state.sessions.find((s) => s.sessionId === priorSessionId);
    const fresh = localAdapter.state.sessions.find((s) => s.sessionId === recovered.sessionId);
    expect(prior!.profileKey).toBe(fresh!.profileKey);
    leaseMain = recovered;
  });

  it('releases the lease cleanly (the terminal close, vendor session closed after)', async () => {
    const flow = flowActor;
    const closeCallsBefore = localAdapter.state.closeCalls;
    const released = await at(T_RELEASE, () =>
      fabric.releaseFabricLease(flow, {
        leaseId: leaseMain.id,
        reason: 'work completed',
      }),
    );
    expect(released.status).toBe('released');
    expect(released.releasedAt).toBe(T_RELEASE);
    expect(released.releaseReason).toBe('work completed');
    // The disposable session closed best-effort after the committed
    // terminal state, with the fabric's reason retained adapter-side.
    expect(localAdapter.state.closeCalls).toBe(closeCallsBefore + 1);
    const session = localAdapter.state.sessions.find(
      (s) => s.sessionId === released.sessionId,
    );
    expect(session!.phase).toBe('ended');
    expect(session!.closeReason).toBe('released: work completed');
  });

  it('reads back the full evidence timeline in order, filterable by kind', async () => {
    const flow = flowActor;
    const events = await fabric.listLeaseEvents(flow, { leaseId: leaseMain.id });
    expect(events.map((e) => e.kind)).toEqual([
      'acquired',
      'prepared',
      'artifact',
      'evidence',
      'checkpoint',
      'takeover',
      'handback',
      'loss',
      'recovery',
      'release',
    ]);
    expect(events.map((e) => e.recordedAt)).toEqual([
      T_ACQUIRE,
      T_PREPARE,
      T_ARTIFACT,
      T_EVIDENCE,
      T_CHECKPOINT,
      T_TAKEOVER,
      T_HANDBACK,
      T_LOST,
      T_RECOVER,
      T_RELEASE,
    ]);
    expect(events[0]!.recordedBy).toBe(flow.principalId);
    expect(events[0]!.payload).toMatchObject({
      definitionKey: 'site-workspace',
      definitionKind: 'workspace',
      planId: planFlow.id,
      executionRunId: runFlow.id,
      taskKey: 'survey',
      adapterId: 'local-container-sim-1',
      leaseMinutes: 90,
    });
    const recoveries = await fabric.listLeaseEvents(flow, {
      leaseId: leaseMain.id,
      kind: 'recovery',
    });
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.payload).toMatchObject({
      recoveredFromCheckpointRef: leaseMain.recoveredFromCheckpointRef,
    });
    // The evidence tails carry NO credential material (the opaque ref
    // rides the lease row only — never a domain evidence record).
    expect(JSON.stringify(events)).not.toContain('vault://');
  });
});

// ---------------------------------------------------------------------------
// Persistence where required
// ---------------------------------------------------------------------------

describe('persistence where required', () => {
  it('refuses recovery of a durable-checkpoint lease with no recorded checkpoint', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await fabric.markFabricLeaseLost(flow, {
      leaseId: lease.id,
      detail: 'died before any checkpoint was cut',
    });
    await expectCode('checkpoint_required', () =>
      fabric.recoverFabricLease(flow, { leaseId: lease.id }),
    );
    // The refusal stamped nothing — the lease stays parked.
    const still = await fabric.getFabricLease(flow, { leaseId: lease.id });
    expect(still.status).toBe('lost');
    expect(still.recoveredAt).toBeNull();
  });

  it('recovers a session-checkpoint lease from its prior session', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defBrowser.id, planFlow.id, runFlow.id);
    await fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'browser runtime died' });
    const recovered = await fabric.recoverFabricLease(flow, { leaseId: lease.id });
    expect(recovered.status).toBe('live');
    expect(recovered.sessionId).not.toBe(lease.sessionId);
    // No checkpoint existed — recovery resumed from the prior session
    // id (the session-level persistence the definition declared).
    expect(recovered.recoveredFromCheckpointRef).toBe(lease.sessionId);
  });
});

// ---------------------------------------------------------------------------
// The lease state machine — one-way transitions (the sequential
// second-call refusal form; the FOR-UPDATE staleness re-checks are the
// same class as W134/W135/W136 — not concurrently provable here)
// ---------------------------------------------------------------------------

describe('the lease state machine (one-way transitions)', () => {
  it('prepares exactly once', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await expectCode('lease_not_preparing', () =>
      fabric.prepareFabricLease(flow, { leaseId: lease.id }),
    );
  });

  it('holds the takeover/handback cycle to its legal shape', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    // Handback requires a suspended lease.
    await expectCode('lease_not_suspended', () =>
      fabric.handbackFabricLease(flow, { leaseId: lease.id, note: 'nothing to return' }),
    );
    await fabric.takeoverFabricLease(flow, { leaseId: lease.id, reason: 'inspect' });
    // A second takeover is illegal (suspended admits handback/lost/cancel/fail).
    await expectCode('lease_not_live', () =>
      fabric.takeoverFabricLease(flow, { leaseId: lease.id, reason: 'again' }),
    );
    // Release refuses while a human holds control — explicit
    // hand-back first, or cancel.
    await expectCode('lease_suspended', () =>
      fabric.releaseFabricLease(flow, { leaseId: lease.id, reason: 'cannot release' }),
    );
    await fabric.handbackFabricLease(flow, { leaseId: lease.id, note: 'back' });
    await expectCode('lease_not_suspended', () =>
      fabric.handbackFabricLease(flow, { leaseId: lease.id, note: 'again' }),
    );
  });

  it('heartbeats only live leases', async () => {
    const flow = member(tenantFlow);
    const preparing = await newLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await expectCode('lease_not_live', () =>
      fabric.heartbeatFabricLease(flow, { leaseId: preparing.id }),
    );
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'died' });
    await expectCode('lease_not_live', () =>
      fabric.heartbeatFabricLease(flow, { leaseId: lease.id }),
    );
  });

  it('recovers only lost leases (and only once per loss)', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await expectCode('lease_not_lost', () =>
      fabric.recoverFabricLease(flow, { leaseId: lease.id }),
    );
    await fabric.recordLeaseCheckpoint(flow, {
      leaseId: lease.id,
      cursor: `${lease.sessionId}@c1`,
    });
    await fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'died' });
    const recovered = await fabric.recoverFabricLease(flow, { leaseId: lease.id });
    expect(recovered.status).toBe('live');
    await expectCode('lease_not_lost', () =>
      fabric.recoverFabricLease(flow, { leaseId: lease.id }),
    );
    // Marking lost twice is illegal (lost admits live/cancel/fail).
    await fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'died again' });
    await expectCode('invalid_transition', () =>
      fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'a third time' }),
    );
  });

  it('freezes the lease at its terminal: every further operation refuses', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    const cancelled = await at(T_CANCEL, () =>
      fabric.cancelFabricLease(flow, { leaseId: lease.id, reason: 'the program was halted' }),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationRequestedAt).toBe(T_CANCEL);
    expect(cancelled.cancelReason).toBe('the program was halted');
    for (const op of [
      () => fabric.prepareFabricLease(flow, { leaseId: lease.id }),
      () => fabric.takeoverFabricLease(flow, { leaseId: lease.id, reason: 'x' }),
      () => fabric.handbackFabricLease(flow, { leaseId: lease.id }),
      () => fabric.heartbeatFabricLease(flow, { leaseId: lease.id }),
      () => fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'x' }),
      () => fabric.recoverFabricLease(flow, { leaseId: lease.id }),
      () => fabric.cancelFabricLease(flow, { leaseId: lease.id, reason: 'x' }),
      () => fabric.releaseFabricLease(flow, { leaseId: lease.id, reason: 'x' }),
      () => fabric.failFabricLease(flow, { leaseId: lease.id, detail: 'x' }),
      () =>
        fabric.recordArtifactHandoff(flow, {
          leaseId: lease.id,
          direction: 'in',
          artifactRef: 'r',
          artifactKind: 'k',
        }),
      () =>
        fabric.recordLeaseEvidence(flow, {
          leaseId: lease.id,
          captureKind: 'console',
          artifactRef: 'r',
          verification: 'verified',
        }),
      () => fabric.recordLeaseCheckpoint(flow, { leaseId: lease.id, cursor: 'c' }),
    ]) {
      await expectCode('lease_already_terminal', op);
    }
    // Typed not-found for a missing lease, uniformly.
    await expectCode('lease_not_found', () =>
      fabric.getFabricLease(flow, { leaseId: newId() }),
    );
  });

  it('mirrors the state machine at the storage level (defense in depth)', async () => {
    const flow = member(tenantFlow);
    const db = getDb();
    const live = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await expect(
      db.query(`UPDATE fabric_leases SET status = 'preparing' WHERE id = $1`, [live.id]),
    ).rejects.toThrow(/not a legal transition/);
    await expect(
      db.query(`UPDATE fabric_leases SET agent_id = $2 WHERE id = $1`, [live.id, newId()]),
    ).rejects.toThrow(/content is immutable/);
    await expect(
      db.query(`UPDATE fabric_leases SET release_reason = 'forged' WHERE status = 'released'`),
    ).rejects.toThrow(/frozen/);
    await expect(db.query(`DELETE FROM fabric_leases`)).rejects.toThrow(/lifecycle-managed/);
    await expect(db.query(`TRUNCATE fabric_leases`)).rejects.toThrow(/lifecycle-managed/);
    await expect(
      db.query(`UPDATE environment_definitions SET def_key = 'forged'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`DELETE FROM environment_definitions`),
    ).rejects.toThrow(/lifecycle-managed/);
  });
});

// ---------------------------------------------------------------------------
// Cancellation (fabric-executed — no cooperative window)
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('cancels a live lease: terminal state first, vendor session closed after', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    const closeCallsBefore = localAdapter.state.closeCalls;
    const cancelled = await fabric.cancelFabricLease(flow, {
      leaseId: lease.id,
      reason: 'the program was halted',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(localAdapter.state.closeCalls).toBe(closeCallsBefore + 1);
    const session = localAdapter.state.sessions.find(
      (s) => s.sessionId === cancelled.sessionId,
    );
    expect(session!.phase).toBe('ended');
    expect(session!.closeReason).toBe('cancelled: the program was halted');
  });

  it('cancels a human-held lease (takeover never blocks fabric cancellation)', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await fabric.takeoverFabricLease(flow, { leaseId: lease.id, reason: 'inspect' });
    const cancelled = await fabric.cancelFabricLease(flow, {
      leaseId: lease.id,
      reason: 'halted while suspended',
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('cancels a lost lease (parked leases still close)', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'died' });
    const cancelled = await fabric.cancelFabricLease(flow, {
      leaseId: lease.id,
      reason: 'abandoned after death',
    });
    expect(cancelled.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// The append-only evidence tails — artifact handoff + evidence capture
// ---------------------------------------------------------------------------

describe('artifact handoff and evidence capture (the append-only tails)', () => {
  it('records artifacts in both directions and filters the manifest', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    const inbound = await at(T_EV_A, () =>
      fabric.recordArtifactHandoff(flow, {
        leaseId: lease.id,
        direction: 'in',
        artifactRef: 'artifact://site-brief',
        artifactKind: 'brief',
      }),
    );
    expect(inbound.digest).toBeNull();
    const outbound = await at(T_EV_B, () =>
      fabric.recordArtifactHandoff(flow, {
        leaseId: lease.id,
        direction: 'out',
        artifactRef: 'artifact://site-report',
        artifactKind: 'report',
        digest: 'a1b2c3d4e5f6a7b8',
      }),
    );
    expect(outbound.recordedAt).toBe(T_EV_B);
    const all = await fabric.listArtifactHandoffs(flow, { leaseId: lease.id });
    expect(all.map((h) => h.direction)).toEqual(['in', 'out']);
    const outs = await fabric.listArtifactHandoffs(flow, {
      leaseId: lease.id,
      direction: 'out',
    });
    expect(outs).toHaveLength(1);
    expect(outs[0]!.digest).toBe('a1b2c3d4e5f6a7b8');
  });

  it('captures evidence across the verification triad and filters by capture kind', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    const shot = await at(T_EV_C, () =>
      fabric.recordLeaseEvidence(flow, {
        leaseId: lease.id,
        captureKind: 'screenshot',
        artifactRef: 'artifact://shot-2',
        verification: 'verified',
        detail: 'the survey dashboard',
      }),
    );
    expect(shot.redaction).toBe('applied');
    const dom = await at(T_EV_D, () =>
      fabric.recordLeaseEvidence(flow, {
        leaseId: lease.id,
        captureKind: 'dom-snapshot',
        artifactRef: 'artifact://dom-2',
        verification: 'mismatched',
      }),
    );
    expect(dom.verification).toBe('mismatched');
    const all = await fabric.listLeaseEvidence(flow, { leaseId: lease.id });
    expect(all.map((e) => e.captureKind)).toEqual(['screenshot', 'dom-snapshot']);
    const mismatched = await fabric.listLeaseEvidence(flow, {
      leaseId: lease.id,
      verification: 'mismatched',
    });
    expect(mismatched.map((e) => e.id)).toEqual([dom.id]);
    const screenshots = await fabric.listLeaseEvidence(flow, {
      leaseId: lease.id,
      captureKind: 'screenshot',
    });
    expect(screenshots).toHaveLength(1);
  });

  it('holds the servable postures (what may be recorded against which state)', async () => {
    const flow = member(tenantFlow);
    // A preparing lease serves artifacts but not evidence or checkpoints.
    const preparing = await newLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await fabric.recordArtifactHandoff(flow, {
      leaseId: preparing.id,
      direction: 'in',
      artifactRef: 'artifact://staged-input',
      artifactKind: 'input',
    });
    await expectCode('invalid_transition', () =>
      fabric.recordLeaseEvidence(flow, {
        leaseId: preparing.id,
        captureKind: 'console',
        artifactRef: 'r',
        verification: 'verified',
      }),
    );
    await expectCode('invalid_transition', () =>
      fabric.recordLeaseCheckpoint(flow, { leaseId: preparing.id, cursor: 'c' }),
    );
    // A lost lease serves none of the tails.
    const lost = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await fabric.markFabricLeaseLost(flow, { leaseId: lost.id, detail: 'died' });
    await expectCode('invalid_transition', () =>
      fabric.recordArtifactHandoff(flow, {
        leaseId: lost.id,
        direction: 'in',
        artifactRef: 'r',
        artifactKind: 'k',
      }),
    );
    // A suspended (human-held) lease still serves evidence and
    // artifacts, but NOT checkpoints (the driving worker does not run).
    const suspended = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    await fabric.takeoverFabricLease(flow, { leaseId: suspended.id, reason: 'inspect' });
    const consoleCapture = await fabric.recordLeaseEvidence(flow, {
      leaseId: suspended.id,
      captureKind: 'console',
      artifactRef: 'artifact://console-1',
      verification: 'unverified',
    });
    expect(consoleCapture.verification).toBe('unverified');
    await fabric.recordArtifactHandoff(flow, {
      leaseId: suspended.id,
      direction: 'out',
      artifactRef: 'artifact://handover-pack',
      artifactKind: 'pack',
    });
    await expectCode('invalid_transition', () =>
      fabric.recordLeaseCheckpoint(flow, { leaseId: suspended.id, cursor: 'c' }),
    );
  });

  it('keeps the four evidence tables append-only at the storage level', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE fabric_lease_artifacts SET artifact_ref = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM fabric_lease_evidence`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE fabric_lease_checkpoints`)).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE fabric_lease_events SET payload = '{}'::jsonb`),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// THE VENDOR-REMOVAL CLAUSE — the same domain flow through the
// fake-browser and fake-remote-sandbox adapters, then the removal itself
// ---------------------------------------------------------------------------

describe('the vendor-removal clause (identical domain outcomes, unchanged contracts)', () => {
  const FLOW_EVENTS = [
    'acquired',
    'prepared',
    'artifact',
    'evidence',
    'checkpoint',
    'takeover',
    'handback',
    'loss',
    'recovery',
    'release',
  ] as const;

  /** The SAME domain flow driven through one adapter path. */
  async function runEnvironmentFlow(
    ctx: TenantContext,
    definitionId: string,
    extra?: { credentialRef?: string },
  ) {
    const lease = await at(T_VR_ACQUIRE, () =>
      fabric.acquireFabricLease(ctx, {
        definitionId,
        planId: planFlow.id,
        executionRunId: runFlow.id,
        ...extra,
      }),
    );
    const prepared = await at(T_VR_PREPARE, () =>
      fabric.prepareFabricLease(ctx, { leaseId: lease.id }),
    );
    const cursor = `${prepared.sessionId}@flow-cursor-1`;
    await at(T_VR_ARTIFACT, () =>
      fabric.recordArtifactHandoff(ctx, {
        leaseId: lease.id,
        direction: 'out',
        artifactRef: 'artifact://site-report',
        artifactKind: 'report',
        digest: 'a1b2c3d4e5f6a7b8',
      }),
    );
    await at(T_VR_EVIDENCE, () =>
      fabric.recordLeaseEvidence(ctx, {
        leaseId: lease.id,
        captureKind: 'dom-snapshot',
        artifactRef: 'artifact://dom',
        verification: 'verified',
      }),
    );
    await at(T_VR_CHECKPOINT, () =>
      fabric.recordLeaseCheckpoint(ctx, {
        leaseId: lease.id,
        cursor,
        coveredEvidenceRefs: ['artifact://dom'],
      }),
    );
    await at(T_VR_TAKEOVER, () =>
      fabric.takeoverFabricLease(ctx, { leaseId: lease.id, reason: 'operator inspection' }),
    );
    await at(T_VR_HANDBACK, () =>
      fabric.handbackFabricLease(ctx, { leaseId: lease.id, note: 'inspection complete' }),
    );
    await at(T_VR_LOST, () =>
      fabric.markFabricLeaseLost(ctx, { leaseId: lease.id, detail: 'worker host died' }),
    );
    const recovered = await at(T_VR_RECOVER, () =>
      fabric.recoverFabricLease(ctx, { leaseId: lease.id }),
    );
    const released = await at(T_VR_RELEASE, () =>
      fabric.releaseFabricLease(ctx, { leaseId: lease.id, reason: 'work completed' }),
    );
    return { lease, prepared, recovered, released, cursor };
  }

  /** The vendor-neutral projection of a finished lease (ids excluded). */
  function domainProjection(lease: FabricLease) {
    return {
      status: lease.status,
      planId: lease.planId,
      executionRunId: lease.executionRunId,
      taskKey: lease.taskKey,
      agentId: lease.agentId,
      leaseMinutes: lease.leaseMinutes,
      takeoverHolder: lease.takeoverHolder,
      takeoverReason: lease.takeoverReason,
      handbackNote: lease.handbackNote,
      lostDetail: lease.lostDetail,
      releaseReason: lease.releaseReason,
      takenOverAt: lease.takenOverAt,
      handbackAt: lease.handbackAt,
      lostAt: lease.lostAt,
      recoveredAt: lease.recoveredAt,
      releasedAt: lease.releasedAt,
      openedAt: lease.openedAt,
    };
  }

  it('drives the SAME domain flow to IDENTICAL outcomes on both vendor paths', async () => {
    const flow = member(tenantFlow);
    const browserResumeCallsBefore = browserAdapter.state.resumeCalls;
    const browserFlow = await runEnvironmentFlow(flow, defBrowser.id, {
      credentialRef: 'vault://browser/site-login',
    });
    const remoteFlow = await runEnvironmentFlow(flow, defRemote.id);

    // Identical domain outcomes — every vendor-neutral field, every
    // timestamp (the same pins), every status.
    expect(domainProjection(browserFlow.released)).toEqual(domainProjection(remoteFlow.released));
    expect(browserFlow.released.status).toBe('released');
    expect(browserFlow.released.takeoverHolder).toBeNull();
    // Both paths recovered a FRESH session from their checkpoint.
    expect(browserFlow.recovered.sessionId).not.toBe(browserFlow.prepared.sessionId);
    expect(remoteFlow.recovered.sessionId).not.toBe(remoteFlow.prepared.sessionId);
    expect(browserFlow.released.recoveredFromCheckpointRef).toBe(browserFlow.cursor);
    expect(remoteFlow.released.recoveredFromCheckpointRef).toBe(remoteFlow.cursor);
    // Identical evidence timelines.
    const bEvents = await fabric.listLeaseEvents(flow, { leaseId: browserFlow.lease.id });
    const rEvents = await fabric.listLeaseEvents(flow, { leaseId: remoteFlow.lease.id });
    expect(bEvents.map((e) => e.kind)).toEqual([...FLOW_EVENTS]);
    expect(bEvents.map((e) => [e.kind, e.recordedAt])).toEqual(
      rEvents.map((e) => [e.kind, e.recordedAt]),
    );
    const bArtifacts = await fabric.listArtifactHandoffs(flow, { leaseId: browserFlow.lease.id });
    const rArtifacts = await fabric.listArtifactHandoffs(flow, { leaseId: remoteFlow.lease.id });
    expect(bArtifacts.map((h) => [h.direction, h.artifactKind, h.digest])).toEqual(
      rArtifacts.map((h) => [h.direction, h.artifactKind, h.digest]),
    );
    const bEvidence = await fabric.listLeaseEvidence(flow, { leaseId: browserFlow.lease.id });
    const rEvidence = await fabric.listLeaseEvidence(flow, { leaseId: remoteFlow.lease.id });
    expect(bEvidence.map((e) => [e.captureKind, e.verification, e.redaction])).toEqual(
      rEvidence.map((e) => [e.captureKind, e.verification, e.redaction]),
    );
    const bCheckpoints = await fabric.listLeaseCheckpoints(flow, {
      leaseId: browserFlow.lease.id,
    });
    const rCheckpoints = await fabric.listLeaseCheckpoints(flow, {
      leaseId: remoteFlow.lease.id,
    });
    expect(bCheckpoints).toHaveLength(1);
    expect(rCheckpoints).toHaveLength(1);
    expect(bCheckpoints[0]!.coveredEvidenceRefs).toEqual(rCheckpoints[0]!.coveredEvidenceRefs);

    // NO vendor name rides in any domain record (metadata lives on the
    // adapter descriptor only).
    const serialized = JSON.stringify([
      browserFlow.released,
      remoteFlow.released,
      bEvents,
      rEvents,
      bArtifacts,
      rArtifacts,
      bEvidence,
      rEvidence,
      bCheckpoints,
      rCheckpoints,
    ]).toLowerCase();
    for (const vendor of ['e2b', 'playwright', 'docker', 'chromium']) {
      expect(serialized).not.toContain(vendor);
    }

    // Session-credential isolation, proven on the browser path's
    // receipt surface: the OPAQUE ref handed verbatim to the driver at
    // open, the profile key tenant+subject isolated — and the ref
    // NEVER in the evidence tail.
    const bStart = browserAdapter.state.startedSessions.find(
      (s) => s.sessionKey === browserFlow.prepared.sessionId,
    );
    expect(bStart).toBeDefined();
    expect(bStart!.credentialRef).toBe('vault://browser/site-login');
    expect(bStart!.profileKey).toBe(
      `browser:tenant:${tenantFlow}:subject:${browserFlow.lease.id}`,
    );
    // The recovery resumed through the adapter onto the SAME isolated
    // profile (the resume surface records the profile binding).
    expect(browserAdapter.state.resumeCalls).toBe(browserResumeCallsBefore + 1);
    expect(browserAdapter.state.profileKeys).toContain(bStart!.profileKey);
    expect(JSON.stringify(bEvents)).not.toContain('vault://');
    // The lease row itself carries the opaque ref (persisted where the
    // adapter consumes it — W082).
    expect(browserFlow.released.credentialRef).toBe('vault://browser/site-login');
    expect(remoteFlow.released.credentialRef).toBeNull();

    // Remote-path continuity: the fresh sandbox resumed the prior one
    // on the SAME isolated profile (the vendor wire carried only ids).
    const sandboxes = remoteAdapter.state.sandboxes.filter(
      (s) =>
        s.sandboxId === remoteFlow.prepared.sessionId ||
        s.sandboxId === remoteFlow.recovered.sessionId,
    );
    expect(sandboxes).toHaveLength(2);
    expect(sandboxes[1]!.resumeOf).toBe(sandboxes[0]!.sandboxId);
    expect(sandboxes[1]!.profileKey).toBe(sandboxes[0]!.profileKey);
    expect(sandboxes[0]!.profileKey).toBe(
      `remote:tenant:${tenantFlow}:subject:${remoteFlow.lease.id}`,
    );
  });

  it('serves reads after removal, refuses prepare/recover, never blocks cancellation', async () => {
    const flow = member(tenantFlow);
    // Leases acquired BEFORE the removal (they name the adapter id).
    const stash = await at(T_RM_ACQUIRE, () =>
      fabric.acquireFabricLease(flow, {
        definitionId: defBrowser.id,
        planId: planFlow.id,
        executionRunId: runFlow.id,
      }),
    );
    const lostLease = await (async () => {
      const lease = await at(T_RM_ACQUIRE, () =>
        fabric.acquireFabricLease(flow, {
          definitionId: defBrowser.id,
          planId: planFlow.id,
          executionRunId: runFlow.id,
        }),
      );
      return at(T_RM_PREPARE, () => fabric.prepareFabricLease(flow, { leaseId: lease.id }));
    })();
    await at(T_RM_CHECKPOINT, () =>
      fabric.recordLeaseCheckpoint(flow, {
        leaseId: lostLease.id,
        cursor: `${lostLease.sessionId}@c1`,
      }),
    );
    await at(T_RM_LOST, () =>
      fabric.markFabricLeaseLost(flow, {
        leaseId: lostLease.id,
        detail: 'died',
      }),
    );
    const closeCallsBefore = browserAdapter.state.closeCalls;

    // THE VENDOR-REMOVAL OPERATION.
    expect(fabric.unregisterExecutionAdapter('browser-env-1')).toBe(true);
    expect(fabric.unregisterExecutionAdapter('remote-sandbox-1')).toBe(true);
    try {
      // Reads of served leases still work — the domain rows are untouched.
      const stashView = await fabric.getFabricLease(flow, { leaseId: stash.id });
      expect(stashView.status).toBe('preparing');
      const events = await fabric.listLeaseEvents(flow, { leaseId: lostLease.id });
      expect(events.map((e) => e.kind)).toEqual(['acquired', 'prepared', 'checkpoint', 'loss']);
      // Prepare and recover refuse — the vendor path is gone.
      await expectCode('adapter_not_registered', () =>
        fabric.prepareFabricLease(flow, { leaseId: stash.id }),
      );
      await expectCode('adapter_not_registered', () =>
        fabric.recoverFabricLease(flow, { leaseId: lostLease.id }),
      );
      // The refusal stamped nothing: the leases hold their states.
      expect((await fabric.getFabricLease(flow, { leaseId: stash.id })).status).toBe('preparing');
      expect((await fabric.getFabricLease(flow, { leaseId: lostLease.id })).status).toBe('lost');
      // Cancellation completes without the vendor (the domain contracts
      // did not change — a removed vendor never blocks the terminal).
      const cancelled = await fabric.cancelFabricLease(flow, {
        leaseId: lostLease.id,
        reason: 'halted after the vendor path was removed',
      });
      expect(cancelled.status).toBe('cancelled');
      expect(browserAdapter.state.closeCalls).toBe(closeCallsBefore); // no vendor close
      // Removing an unknown adapter is a clean false.
      expect(fabric.unregisterExecutionAdapter('never-registered')).toBe(false);
    } finally {
      // Restore the wiring (re-registration replaces with a fresh
      // generation — the same ids, fresh handshake).
      await fabric.registerExecutionAdapter(browserAdapter);
      await fabric.registerExecutionAdapter(remoteAdapter);
    }
  });

  it('restores acquisition after re-registration (the contracts never changed)', async () => {
    const flow = member(tenantFlow);
    const view = await fabric.registerExecutionAdapter(browserAdapter);
    expect(view.descriptor.kind).toBe('browser');
    expect(view.descriptor.health).toBe('available');
    expect(view.registrationIndex).toBeGreaterThan(0);
    // A fresh acquisition + preparation works again, identically.
    const lease = await fabric.acquireFabricLease(flow, {
      definitionId: defBrowser.id,
      planId: planFlow.id,
      executionRunId: runFlow.id,
    });
    const prepared = await fabric.prepareFabricLease(flow, { leaseId: lease.id });
    expect(prepared.status).toBe('live');
    expect(prepared.adapterId).toBe('browser-env-1');
    // The discovery view lists every registered path (vendor identity
    // is METADATA on the descriptor — the only place it is visible).
    const registered = fabric.listRegisteredAdapters();
    expect(registered.map((r) => r.descriptor.kind).sort()).toEqual([
      'browser',
      'remote-sandbox',
      'workspace',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The honest-descriptor law + vendor-path failure stamps
// ---------------------------------------------------------------------------

describe('the honest-descriptor law and vendor-path failures', () => {
  it('refuses acquisition when every serving adapter reports unhealthy', async () => {
    const flow = member(tenantFlow);
    // Wiring swap: replace the remote path with one whose vendor
    // answers 503 on health — probe-at-registration reports it
    // honestly, and the acquisition refuses (never fabricated).
    const unhealthy = createRemoteSandboxAdapter({
      apiBaseUrl: REMOTE_BASE,
      transport: createFakeRemoteSandboxTransport({
        failures: [{ pathIncludes: '/health', status: 503, body: 'overloaded' }],
      }),
    });
    const view = await fabric.registerExecutionAdapter(unhealthy);
    expect(view.descriptor.health).toBe('unavailable');
    try {
      await expectCode('adapter_unavailable', () =>
        fabric.acquireFabricLease(flow, {
          definitionId: defRemote.id,
          planId: planFlow.id,
          executionRunId: runFlow.id,
        }),
      );
    } finally {
      await fabric.registerExecutionAdapter(remoteAdapter);
    }
  });

  it('stamps the lease failed when the vendor path fails to open (honest evidence)', async () => {
    const flow = member(tenantFlow);
    // Wiring swap: the local path whose next open() throws.
    await fabric.registerExecutionAdapter(createLocalContainerAdapter({ openFailures: 1 }));
    try {
      const lease = await at(T_OPEN_FAIL, () =>
        fabric.acquireFabricLease(flow, {
          definitionId: defWorkspace.id,
          planId: planFlow.id,
          executionRunId: runFlow.id,
        }),
      );
      await expectCode('adapter_open_failed', () =>
        at(T_OPEN_FAIL_STAMP, () => fabric.prepareFabricLease(flow, { leaseId: lease.id })),
      );
      const stamped = await fabric.getFabricLease(flow, { leaseId: lease.id });
      expect(stamped.status).toBe('failed');
      expect(stamped.failedAt).toBe(T_OPEN_FAIL_STAMP);
      expect(stamped.failureDetail).toContain('prepare vendor-path failure');
      expect(stamped.failureDetail).toContain('provision failure');
      const failures = await fabric.listLeaseEvents(flow, {
        leaseId: lease.id,
        kind: 'failure',
      });
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({ phase: 'prepare' });
      // The stamped lease is terminal.
      await expectCode('lease_already_terminal', () =>
        fabric.prepareFabricLease(flow, { leaseId: lease.id }),
      );
    } finally {
      await fabric.registerExecutionAdapter(localAdapter);
    }
  });

  it('stamps the lease failed when the vendor path fails to resume', async () => {
    const flow = member(tenantFlow);
    // Wiring swap: the remote path whose next resume() throws.
    await fabric.registerExecutionAdapter(
      createRemoteSandboxAdapter({
        apiBaseUrl: REMOTE_BASE,
        transport: createFakeRemoteSandboxTransport(),
        resumeFailures: 1,
      }),
    );
    try {
      const lease = await at(T_RESUME_FAIL_ACQUIRE, () =>
        fabric.acquireFabricLease(flow, {
          definitionId: defRemote.id,
          planId: planFlow.id,
          executionRunId: runFlow.id,
        }),
      );
      const prepared = await fabric.prepareFabricLease(flow, { leaseId: lease.id });
      await fabric.recordLeaseCheckpoint(flow, {
        leaseId: lease.id,
        cursor: `${prepared.sessionId}@c1`,
      });
      await fabric.markFabricLeaseLost(flow, { leaseId: lease.id, detail: 'died' });
      await expectCode('adapter_resume_failed', () =>
        at(T_RESUME_FAIL_STAMP, () => fabric.recoverFabricLease(flow, { leaseId: lease.id })),
      );
      const stamped = await fabric.getFabricLease(flow, { leaseId: lease.id });
      expect(stamped.status).toBe('failed');
      expect(stamped.failureDetail).toContain('recover vendor-path failure');
      expect(stamped.failureDetail).toContain('resume failure');
    } finally {
      await fabric.registerExecutionAdapter(remoteAdapter);
    }
  });

  it('records the explicit vendor-failure report (failFabricLease)', async () => {
    const flow = member(tenantFlow);
    const lease = await newPreparedLease(flow, defWorkspace.id, planFlow.id, runFlow.id);
    const failed = await at(T_FAIL, () =>
      fabric.failFabricLease(flow, {
        leaseId: lease.id,
        detail: 'the sandbox filesystem became read-only',
      }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.failedAt).toBe(T_FAIL);
    expect(failed.failureDetail).toBe('the sandbox filesystem became read-only');
    const failures = await fabric.listLeaseEvents(flow, {
      leaseId: lease.id,
      kind: 'failure',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({
      detail: 'the sandbox filesystem became read-only',
      phase: 'explicit-report',
    });
  });
});

// ---------------------------------------------------------------------------
// Reads and queries (deterministic orders, filters, uniform not-founds)
// ---------------------------------------------------------------------------

describe('the read surface', () => {
  it('lists leases newest-first with every filter', async () => {
    const gate = member(tenantGate);
    const q1 = await at(T_Q1, () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defPlain.id,
        planId: planGate.id,
        executionRunId: runGate.id,
      }),
    );
    const q2 = await at(T_Q2, () =>
      fabric.acquireFabricLease(gate, {
        definitionId: defPlain.id,
        planId: planGate.id,
        executionRunId: runGate.id,
      }),
    );
    const all = await fabric.listFabricLeases(gate);
    // Newest first: q2, q1, then the retirement-fixture lease.
    expect(all.slice(0, 2).map((l) => l.id)).toEqual([q2.id, q1.id]);
    expect(all).toHaveLength(3);
    const byDefinition = await fabric.listFabricLeases(gate, {
      definitionId: defPlain.id,
    });
    expect(byDefinition.map((l) => l.id)).toEqual([q2.id, q1.id]);
    const byRun = await fabric.listFabricLeases(gate, { executionRunId: runGate.id });
    expect(byRun).toHaveLength(3);
    const byStatus = await fabric.listFabricLeases(gate, { status: 'preparing' });
    expect(byStatus.map((l) => l.id)).toEqual([q2.id, q1.id]); // newest first
    const none = await fabric.listFabricLeases(gate, { definitionId: newId() });
    expect(none).toEqual([]);
    // The views carry the denormalized definition identity.
    expect(byDefinition[0]!.definitionKey).toBe('gate-workspace-plain');
    expect(byDefinition[0]!.definitionKind).toBe('workspace');
  });

  it('serves the isolation tenants\' event tails and filters by kind and limit', async () => {
    const isoA = member(tenantIsoA);
    const events = await fabric.listLeaseEvents(isoA, { leaseId: leaseIsoA.id });
    expect(events.map((e) => [e.kind, e.recordedAt])).toEqual([
      ['acquired', T_ISO_ACQUIRE_A],
      ['prepared', T_ISO_PREPARE_A],
    ]);
    const prepared = await fabric.listLeaseEvents(isoA, {
      leaseId: leaseIsoA.id,
      kind: 'prepared',
    });
    expect(prepared).toHaveLength(1);
    const limited = await fabric.listLeaseEvents(isoA, { leaseId: leaseIsoA.id, limit: 1 });
    expect(limited.map((e) => e.kind)).toEqual(['acquired']);
    // Empty tails read as empty (never an error).
    expect(await fabric.listArtifactHandoffs(isoA, { leaseId: leaseIsoA.id })).toEqual([]);
    expect(await fabric.listLeaseEvidence(isoA, { leaseId: leaseIsoA.id })).toEqual([]);
    expect(await fabric.listLeaseCheckpoints(isoA, { leaseId: leaseIsoA.id })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001) + session isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('holds fully independent fabric state across two tenants', async () => {
    const isoA = member(tenantIsoA);
    const isoB = member(tenantIsoB);
    // The same defKey coexists in both tenants.
    expect(defIsoA.defKey).toBe(defIsoB.defKey);
    expect(defIsoA.id).not.toBe(defIsoB.id);
    // Foreign reads are uniformly not-found — no existence leak.
    await expectCode('definition_not_found', () =>
      fabric.getEnvironmentDefinition(isoA, { definitionId: defIsoB.id }),
    );
    await expectCode('lease_not_found', () =>
      fabric.getFabricLease(isoA, { leaseId: leaseIsoB.id }),
    );
    await expectCode('lease_not_found', () =>
      fabric.prepareFabricLease(isoA, { leaseId: leaseIsoB.id }),
    );
    await expectCode('lease_not_found', () =>
      fabric.recordArtifactHandoff(isoA, {
        leaseId: leaseIsoB.id,
        direction: 'in',
        artifactRef: 'r',
        artifactKind: 'k',
      }),
    );
    await expectCode('lease_not_found', () =>
      fabric.listLeaseEvents(isoA, { leaseId: leaseIsoB.id }),
    );
    // Lists never leak across the boundary.
    expect((await fabric.listEnvironmentDefinitions(isoA)).map((d) => d.id)).toEqual([defIsoA.id]);
    expect((await fabric.listFabricLeases(isoA)).map((l) => l.id)).toEqual([leaseIsoA.id]);
    expect((await fabric.listFabricLeases(isoB)).map((l) => l.id)).toEqual([leaseIsoB.id]);
    // The W136 cross-module gates hold tenant scoping: a foreign plan
    // and a foreign run are uniformly not-found.
    await expectCode('exchange_plan_not_found', () =>
      fabric.acquireFabricLease(isoA, {
        definitionId: defIsoA.id,
        planId: planIsoB.id,
        executionRunId: runIsoB.id,
      }),
    );
    await expectCode('execution_run_not_found', () =>
      fabric.acquireFabricLease(isoA, {
        definitionId: defIsoA.id,
        planId: planIsoA.id,
        executionRunId: runIsoB.id,
      }),
    );
  });

  it('isolates adapter sessions per tenant (structural profile keys)', async () => {
    const keyA = `tenant:${tenantIsoA}:subject:${leaseIsoA.id}`;
    const keyB = `tenant:${tenantIsoB}:subject:${leaseIsoB.id}`;
    expect(localAdapter.state.profileKeys).toContain(keyA);
    expect(localAdapter.state.profileKeys).toContain(keyB);
    expect(keyA).not.toBe(keyB);
    // Both isolation leases are live and healthy in their own tenants.
    const a = await fabric.getFabricLease(member(tenantIsoA), { leaseId: leaseIsoA.id });
    const b = await fabric.getFabricLease(member(tenantIsoB), { leaseId: leaseIsoB.id });
    expect(a.status).toBe('live');
    expect(b.status).toBe('live');
    expect(a.tenantId).toBe(tenantIsoA);
    expect(b.tenantId).toBe(tenantIsoB);
  });
});
