// Service proofs for the cross-platform module (W139) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Locks the W139
// acceptance (spec/work-items/WORK-ITEM-CATALOG.md §W139):
//
// "same authoritative conversation/company state across clients; background
//  work is inspectable everywhere; platform-native capabilities are
//  adapters; cross-device handoff is evidenced."
//
//   * SAME AUTHORITATIVE STATE ACROSS CLIENTS — web, desktop and mobile
//     client sessions of the same tenant/principal read byte-identical
//     projections (conversation state, company overview, background-work
//     feed, shell model): the reads are CLIENT-AGNOSTIC by construction
//     (no platform parameter exists on any state read — locked by the
//     export tripwire), and the content-addressed projection refs are
//     RECOMPUTABLE by any client kind from the served projection alone
//     (digestOf over the documented canonical payload — locked here);
//   * BACKGROUND WORK INSPECTABLE EVERYWHERE — the typed feed over the
//     three seams (missions W011, agent-exchange execution runs W136,
//     execution-fabric leases W137) serves IDENTICAL items and semantics
//     to every client kind: normalized phases + VERBATIM seam statuses,
//     seam/phase filters, the exact sort invariant (latest activity,
//     workId tie-break), per-item reads with uniform typed not-found;
//   * PLATFORM-NATIVE CAPABILITIES ARE ADAPTERS — the deterministic
//     web/desktop/mobile doubles behind the vendor-neutral SPI: honest
//     descriptors (probed, never assumed), explicit refusals for
//     unsupported domains, typed failures for vendor-path throws, ONE
//     registration per platform kind, and THE REMOVAL-NEUTRALITY PROOF
//     (the W137 pattern): with every adapter unregistered every domain
//     read is byte-identical while acquisitions refuse typed, and
//     re-registration restores serving;
//   * CROSS-DEVICE HANDOFF IS EVIDENCED — the full lifecycle over a REAL
//     conversations seam: open (context frozen + 'session-opened'
//     evidence bound to the server projection) → handoff to another
//     device (verbatim context + 'handoff-recorded') → resumption (the
//     EXACT context restored, re-projected from CURRENT server state,
//     'resumed') → stale client revision DISCARDED and the discard
//     recorded ('conflict-discarded', resolution 'server-state-wins',
//     the frozen single-member vocabulary) → close (one-way,
//     'session-closed'); the trail is append-only and the context
//     immutable at the STORAGE level (trigger probes); anchorRevision
//     always equals the evidence count;
//   * TYPED ERROR PATHS + ONE-WAY TRANSITIONS — uniform not-founds
//     (missing ≡ foreign, no existence leak), session_not_active for
//     expired/revoked acting sessions, session_principal_mismatch,
//     handoff_same_session, session_already_revoked /
//     handoff_already_closed (the sequential second-call refusals — the
//     provable form on single-connection PGlite);
//   * TENANT ISOLATION (ADR-0001) — two tenants hold fully independent
//     client/handoff state: same-shaped sessions and handoffs coexist,
//     foreign reads are uniformly not-found, and neither spine nor
//     evidence trails leak across the boundary.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): this harness NEVER
// opens a db.transaction of its own — the service opens exactly one
// transaction per mutation on the single PGlite connection, and a
// harness transaction around a service call would deadlock the embedded
// database. Every fixture is built through the REAL public contracts
// (conversations W029, goals W008, missions W011, agents W021, actions
// W009, agent-exchange W136, execution-fabric W137, notifications W031,
// organizations W001) — never by direct SQL writes (the storage-trigger
// probes are the deliberate exception: they prove the schema's own laws).

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
import * as cp from '../contract';
import { CrossPlatformError } from '../contract';
import type { CrossPlatformErrorCode, HandoffWorkingContext } from '../contract';

// The consumed seams, exercised as REAL records through their owning
// contracts (never re-derived, never direct-written):
//   organizations W001 · conversations W029 · notifications W031 ·
//   goals W008 · missions W011 · agents W021 · actions W009 ·
//   agent-exchange W136 · execution-fabric W137
import { provisionTenant, createWorkspace } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import {
  createConversation,
  recordMessage,
} from '@/modules/conversations/contract';
import type { Conversation } from '@/modules/conversations/contract';
import { setNotificationPolicy, createNotification } from '@/modules/notifications/contract';
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import {
  createMission,
  reviseMission,
  completeMission,
  abandonMission,
} from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import {
  registerAgent,
  setAgentTransport,
  submitAgentExecution,
  runAgentExecution,
} from '@/modules/agents/contract';
import type { AgentRuntimeTransport } from '@/modules/agents/contract';
import { setAuthorityPolicy } from '@/modules/actions/contract';
import {
  createExecutionPlan,
  recordExecutionRun,
} from '@/modules/agent-exchange/contract';
import type { ExecutionRun } from '@/modules/agent-exchange/contract';
import {
  acquireFabricLease,
  cancelFabricLease,
  createLocalContainerAdapter,
  prepareFabricLease,
  registerEnvironmentDefinition,
  registerExecutionAdapter,
} from '@/modules/execution-fabric/contract';

// Deterministic service-clock pins (the injectable clock discipline —
// same-millisecond writes must not decide what a proof shows).
const T_FIX = '2026-10-08T08:00:00.000Z'; // all beforeAll fixtures
const T_NOTIF_1 = '2026-10-08T08:30:00.000Z';
const T_NOTIF_2 = '2026-10-08T08:35:00.000Z';
const T_NEW_SESSION = '2026-10-08T10:00:00.000Z';
const T_OPEN = '2026-10-08T09:00:00.000Z';
const T_HANDOFF = '2026-10-08T09:10:00.000Z';
const T_RESUME = '2026-10-08T09:20:00.000Z';
const T_APPEND = '2026-10-08T09:25:00.000Z';
const T_RESUME_STALE = '2026-10-08T09:30:00.000Z';
const T_CLOSE = '2026-10-08T09:40:00.000Z';
const T_MISSION_RESUME = '2026-10-08T09:50:00.000Z';
const T_PAST = '2020-01-01T00:00:00.000Z'; // the expired-session registration

function pinClock(at: string): () => void {
  const realNow = systemClock.now;
  systemClock.now = () => new Date(at);
  return () => {
    systemClock.now = realNow;
  };
}

function member(tenantId: string, principalId = newId(), authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

async function expectCode(
  code: CrossPlatformErrorCode,
  fn: () => Promise<unknown>,
): Promise<CrossPlatformError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CrossPlatformError);
    const typed = error as CrossPlatformError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// Fixture factories (all content caller-supplied — no industry or
// matching semantics live in these helpers, only the exact strings the
// fixtures declare and observe)
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
    actor: { kind: 'system' as const, label: 'w139-test' },
  };
}

function missionInput(title: string, urgency: 'critical' | 'high' | 'medium' | 'low') {
  return {
    title,
    knowledgeObjective: `Know ${title}`,
    informationValue: 0.8,
    urgency,
    currentConfidence: 0.2,
    targetConfidence: 0.9,
    investigationBudget: { amount: 100, currency: 'USD' },
    rewardBudget: { amount: 50, currency: 'USD' },
    completionCriteria: 'The knowledge is documented.',
    actor: { kind: 'system' as const, label: 'w139-test' },
  };
}

async function conversationWithMessages(
  ctx: TenantContext,
  title: string,
  turns: number,
): Promise<Conversation> {
  const conversation = await createConversation(ctx, { title });
  for (let index = 0; index < turns; index += 1) {
    const inbound = index % 2 === 0;
    await recordMessage(ctx, {
      conversationId: conversation.id,
      direction: inbound ? 'inbound' : 'outbound',
      actor: inbound
        ? { kind: 'external', label: 'w139-fixture-sender' }
        : { kind: 'system', label: 'w139-fixture' },
      channel: 'web',
      payload: { text: `turn ${index + 1} of ${title}` },
      sentAt: `2026-10-08T07:00:${String(10 + index).padStart(2, '0')}.000Z`,
    });
  }
  return conversation;
}

/** Registers one active agent definition (the W021 execution side). */
async function registerTenantAgent(ctx: TenantContext, slug: string) {
  const registered = await registerAgent(ctx, {
    slug,
    displayName: slug,
    role: 'specialist execution',
    description: 'Executes plan tasks.',
    provider: 'openai-assistants',
    instructions: 'Execute the assigned task and report.',
    permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose', 'execute'],
    runtimeConfig: { assistantId: `asst_${slug}` },
  });
  return registered.agent;
}

function workspaceDefinition() {
  return {
    defKey: 'w139-workspace',
    displayName: 'W139 workspace',
    kind: 'workspace' as const,
    profileScope: 'task' as const,
    networkEgress: 'restricted' as const,
    survivesRestart: true,
    checkpoint: 'durable-checkpoint' as const,
    persistentScope: '/workspace',
    requiredCapabilities: ['filesystem', 'commands'] as const,
  };
}
// (the fabric contract wants a mutable array — widen at the call site)
function workspaceDefinitionInput() {
  const definition = workspaceDefinition();
  return { ...definition, requiredCapabilities: [...definition.requiredCapabilities] };
}

// ---------------------------------------------------------------------------
// Tenants (dedicated per concern so count/order assertions stay deterministic)
// ---------------------------------------------------------------------------

const tenantHandoff = newId(); // the handoff lifecycle + evidence tenant
const tenantErr = newId(); // typed error paths (deliberately NOT provisioned)
const tenantIsoA = newId(); // tenant isolation
const tenantIsoB = newId();
let tenantState = ''; // the provisioned same-state/feed/shell tenant (id minted by provisionTenant)

// --- tenantState: web + desktop + mobile sessions over REAL seam state ---
let stateTenant: Tenant;
let owner: TenantContext;
let stateAdmin: TenantContext; // agents/actions/notifications claims (non-member)
let stateNotifAdmin: TenantContext;
let conversationState: Conversation;
let goalA: Goal;
let goalB: Goal;
let missionActive: Mission;
let missionCompleted: Mission;
let missionAbandoned: Mission;
let runQueued: ExecutionRun;
let runSucceeded: ExecutionRun;
let runAwaiting: ExecutionRun;
let sessionWeb: cp.ClientSession;
let sessionDesktop: cp.ClientSession;
let sessionMobile: cp.ClientSession;

// --- tenantHandoff: the lifecycle ---
let handoffUser: TenantContext;
let handoffPrincipalId: string;
let conversationHandoff: Conversation;
let missionHandoff: Mission;
let sessionWebH: cp.ClientSession;
let sessionDesktopH: cp.ClientSession;
let sessionMobileH: cp.ClientSession;
let sessionForeign: cp.ClientSession; // same tenant, DIFFERENT principal
let sessionToRevoke: cp.ClientSession;

// --- tenantIsoA / tenantIsoB ---
let isoA: TenantContext;
let isoB: TenantContext;
let convIsoA: Conversation;
let convIsoB: Conversation;
let sessionIsoAWeb: cp.ClientSession;
let sessionIsoBWeb: cp.ClientSession;
let sessionIsoBMobile: cp.ClientSession;

beforeAll(async () => {
  await runMigrations(getDb());

  // The in-process fake agent transport (the sanctioned W021 wiring seam):
  // delivers the openai-assistants dialect the module's own adapter
  // normalizes — no real provider is contacted, and the canonical
  // result/cost still travel the REAL normalized contract.
  const fakeTransport: AgentRuntimeTransport = {
    send: async () => ({
      status: 'delivered' as const,
      payload: {
        id: 'run_w139_fixture',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify({ surveyed: 3 }) }],
          },
        ],
        summary: 'Surveyed 3 sites',
        usage: { input_tokens: 120, output_tokens: 45 },
      },
      providerTaskId: 'run_w139_fixture',
      detail: null,
    }),
  };
  setAgentTransport(fakeTransport);

  // The fabric's own in-memory adapter wiring (never domain state): the
  // deterministic local-container path serves the workspace definition.
  await registerExecutionAdapter(createLocalContainerAdapter());

  // The platform adapter wiring (in-memory, never domain state): web +
  // desktop registered up front; the mobile double is registered inside
  // the adapter proofs (its scriptable-failure variant is exercised there).
  await cp.registerPlatformAdapter(cp.createWebPlatformAdapter());
  await cp.registerPlatformAdapter(cp.createDesktopPlatformAdapter());

  const restoreClock = pinClock(T_FIX);
  try {
    // ------------------------------------------------------------------
    // tenantState — the provisioned same-state/feed/shell fixtures.
    // ------------------------------------------------------------------
    const platform = { principalId: newId(), authority: ['organizations:provision'] };
    const stateOwnerPrincipal = newId();
    stateTenant = await provisionTenant(platform, {
      name: `Aurum Cross-Platform Co ${newId().slice(0, 8)}`,
      ownerPrincipalId: stateOwnerPrincipal,
    });
    tenantState = stateTenant.id;
    owner = member(tenantState, stateOwnerPrincipal);
    stateAdmin = member(tenantState, newId(), ['agents:administer', 'actions:administer']);
    stateNotifAdmin = member(tenantState, newId(), ['notifications:administer']);
    await createWorkspace(owner, { name: 'Field Operations' });

    conversationState = await conversationWithMessages(owner, 'Site survey briefing', 3);
    goalA = await createGoal(owner, goalInput('Grow the field program'));
    goalB = await createGoal(owner, goalInput('Streamline dispatch'));
    missionActive = await createMission(owner, missionInput('Map the survey practice', 'high'));
    missionCompleted = await createMission(owner, missionInput('Document the routing method', 'medium'));
    missionCompleted = await completeMission(owner, {
      missionId: missionCompleted.id,
      achievedConfidence: 0.9,
      outcome: 'The routing method is documented.',
      actor: { kind: 'system', label: 'w139-test' },
    });
    missionAbandoned = await createMission(owner, missionInput('Probe the old fleet data', 'low'));
    missionAbandoned = await abandonMission(owner, {
      missionId: missionAbandoned.id,
      reason: 'the source system retired',
      actor: { kind: 'system', label: 'w139-test' },
    });

    // The W136 plan + the three runs (queued / succeeded / awaiting).
    const agentState = await registerTenantAgent(stateAdmin, `state-specialist-${newId().slice(0, 8)}`);
    await setAuthorityPolicy(stateAdmin, {
      actionKind: 'agent-execution',
      approvalLevels: ['EXECUTE'],
    });
    const planState = await createExecutionPlan(owner, {
      goalId: goalA.id,
      objective: 'Execute the survey program across clients',
      tasks: [{ taskKey: 'survey', title: 'Survey the site' }],
      members: [{ memberKey: 'lead', kind: 'tenant-agent' as const, role: 'Lead specialist', ref: agentState.id }],
    });
    const executionQueued = await submitAgentExecution(owner, {
      agentId: agentState.id,
      task: { instruction: 'Survey the site', context: 'w139 window' },
      requestedPermissions: ['observe'],
    });
    const executionDone = await submitAgentExecution(owner, {
      agentId: agentState.id,
      task: { instruction: 'Survey the site, final pass', context: 'w139 window' },
      requestedPermissions: ['observe'],
    });
    await runAgentExecution(owner, { executionId: executionDone.id });
    const executionAwaiting = await submitAgentExecution(owner, {
      agentId: agentState.id,
      task: { instruction: 'Dispatch the crews', context: 'w139 window' },
      requestedPermissions: ['execute'],
    });
    runQueued = await recordExecutionRun(owner, {
      planId: planState.id,
      taskKey: 'survey',
      agentExecutionId: executionQueued.id,
      context: { evidenceRefs: ['w139-site-brief'] },
    });
    runSucceeded = await recordExecutionRun(owner, {
      planId: planState.id,
      taskKey: 'survey',
      agentExecutionId: executionDone.id,
      context: { evidenceRefs: ['w139-site-brief'] },
    });
    runAwaiting = await recordExecutionRun(owner, {
      planId: planState.id,
      taskKey: 'survey',
      agentExecutionId: executionAwaiting.id,
      context: { evidenceRefs: ['w139-site-brief'] },
    });

    // The fabric leases over the runs: preparing / live / cancelled.
    const definition = await registerEnvironmentDefinition(owner, workspaceDefinitionInput());
    await acquireFabricLease(owner, {
      definitionId: definition.id,
      planId: planState.id,
      executionRunId: runQueued.id,
    });
    const leaseLive = await acquireFabricLease(owner, {
      definitionId: definition.id,
      planId: planState.id,
      executionRunId: runSucceeded.id,
    });
    await prepareFabricLease(owner, { leaseId: leaseLive.id });
    const leaseToCancel = await acquireFabricLease(owner, {
      definitionId: definition.id,
      planId: planState.id,
      executionRunId: runAwaiting.id,
    });
    await cancelFabricLease(owner, { leaseId: leaseToCancel.id, reason: 'the w139 probe is done' });

    // The shell's notification entry: two PENDING notifications (the
    // digest class accumulates — no channel is contacted, deterministically).
    await setNotificationPolicy(stateNotifAdmin, {
      notificationKind: 'w139.shell-probe',
      deliveryClass: 'digest',
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      dedupeWindowSeconds: 300,
      digestWindowSeconds: 3600,
      requireAcknowledgment: false,
    });
    let restoreNotif = pinClock(T_NOTIF_1);
    await createNotification(owner, {
      kind: 'w139.shell-probe',
      recipient: { provider: 'slack', providerAccountId: 'U139ATTN' },
      subject: 'First attention',
      body: 'The first pending notification.',
    });
    restoreNotif();
    restoreNotif = pinClock(T_NOTIF_2);
    await createNotification(owner, {
      kind: 'w139.shell-probe',
      recipient: { provider: 'slack', providerAccountId: 'U139ATTN' },
      subject: 'Latest attention',
      body: 'The second pending notification.',
    });
    restoreNotif();

    // The three client kinds of the same principal (the W131 vocabulary).
    sessionWeb = await cp.registerClientSession(owner, {
      platform: 'web',
      deviceLabel: 'Browser — canonical',
    });
    sessionDesktop = await cp.registerClientSession(owner, {
      platform: 'desktop',
      deviceLabel: 'MacBook Pro — power client',
    });
    sessionMobile = await cp.registerClientSession(owner, {
      platform: 'mobile',
      deviceLabel: 'iPhone 15 — field client',
    });

    // ------------------------------------------------------------------
    // tenantHandoff — the lifecycle fixtures.
    // ------------------------------------------------------------------
    handoffPrincipalId = newId();
    handoffUser = member(tenantHandoff, handoffPrincipalId);
    conversationHandoff = await conversationWithMessages(handoffUser, 'Field briefing', 1);
    missionHandoff = await createMission(handoffUser, missionInput('Verify the site roster', 'high'));
    sessionWebH = await cp.registerClientSession(handoffUser, {
      platform: 'web',
      deviceLabel: 'Office browser',
    });
    sessionDesktopH = await cp.registerClientSession(handoffUser, {
      platform: 'desktop',
      deviceLabel: 'Office workstation',
    });
    sessionMobileH = await cp.registerClientSession(handoffUser, {
      platform: 'mobile',
      deviceLabel: 'Field phone',
    });
    sessionForeign = await cp.registerClientSession(member(tenantHandoff, newId()), {
      platform: 'web',
      deviceLabel: 'Someone else browser',
    });
    sessionToRevoke = await cp.registerClientSession(handoffUser, {
      platform: 'web',
      deviceLabel: 'Soon-revoked browser',
    });

    // ------------------------------------------------------------------
    // tenantIsoA / tenantIsoB — the isolation fixtures (same natural
    // shapes: same conversation title, same device labels).
    // ------------------------------------------------------------------
    isoA = member(tenantIsoA);
    isoB = member(tenantIsoB);
    convIsoA = await conversationWithMessages(isoA, 'Shared working title', 2);
    convIsoB = await conversationWithMessages(isoB, 'Shared working title', 2);
    sessionIsoAWeb = await cp.registerClientSession(isoA, {
      platform: 'web',
      deviceLabel: 'Shared device label',
    });
    sessionIsoBWeb = await cp.registerClientSession(isoB, {
      platform: 'web',
      deviceLabel: 'Shared device label',
    });
    sessionIsoBMobile = await cp.registerClientSession(isoB, {
      platform: 'mobile',
      deviceLabel: 'B field phone',
    });
    await cp.openHandoffSession(isoA, {
      clientSessionId: sessionIsoAWeb.id,
      context: {
        focusKind: 'conversation',
        focusRef: convIsoA.id,
        draft: 'A tenant draft',
        navigation: { area: 'chat' },
      },
    });
  } finally {
    restoreClock();
  }
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Client sessions — the server-issued registry
// ---------------------------------------------------------------------------

describe('registerClientSession / getClientSession / listClientSessions', () => {
  it('registers the three W131 platform kinds as server-issued identity (never client-minted)', async () => {
    expect(sessionWeb.platform).toBe('web');
    expect(sessionDesktop.platform).toBe('desktop');
    expect(sessionMobile.platform).toBe('mobile');
    expect(sessionWeb.id).not.toBe(sessionDesktop.id);
    expect(sessionWeb.id).not.toBe(sessionMobile.id);
    expect(sessionWeb.principalId).toBe(owner.principalId);
    expect(sessionWeb.tenantId).toBe(tenantState);
    expect(sessionWeb.state).toBe('active');
    expect(sessionWeb.revokedAt).toBeNull();
    expect(sessionWeb.issuedAt === sessionWeb.lastSeenAt).toBe(true);
    expect(sessionWeb.deviceLabel).toBe('Browser — canonical');
    const reread = await cp.getClientSession(owner, { clientSessionId: sessionMobile.id });
    expect(reread).toEqual(sessionMobile);
  });

  it('refuses a past expiry at registration (the future-ness gate)', async () => {
    await expectCode('invalid_session_input', () =>
      cp.registerClientSession(owner, {
        platform: 'web',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    await expectCode('invalid_session_input', () =>
      cp.registerClientSession(owner, { platform: 'watchos' as never }),
    );
    await expectCode('invalid_session_input', () =>
      cp.registerClientSession(owner, {
        platform: 'web',
        deviceLabel: 'x'.repeat(121),
      }),
    );
  });

  it('lists newest-issued first, with platform and derived-state filters', async () => {
    const restore = pinClock(T_NEW_SESSION);
    const newest = await cp.registerClientSession(owner, {
      platform: 'web',
      deviceLabel: 'Newest tab',
    });
    restore();
    const all = await cp.listClientSessions(owner, {});
    expect(all[0]!.id).toBe(newest.id);
    expect(all.map((session) => session.id)).toContain(sessionWeb.id);
    expect(all.map((session) => session.id)).toContain(sessionMobile.id);
    // issued_at DESC, id DESC — the deterministic order.
    for (let index = 1; index < all.length; index += 1) {
      const previous = all[index - 1]!;
      const current = all[index]!;
      expect(Date.parse(previous.issuedAt)).toBeGreaterThanOrEqual(Date.parse(current.issuedAt));
    }
    const webOnly = await cp.listClientSessions(owner, { platform: 'web' });
    expect(webOnly.every((session) => session.platform === 'web')).toBe(true);
    expect(webOnly.map((session) => session.id)).toContain(newest.id);
    expect(webOnly.map((session) => session.id)).not.toContain(sessionDesktop.id);
    const activeOnly = await cp.listClientSessions(owner, { state: 'active' });
    expect(activeOnly.every((session) => session.state === 'active')).toBe(true);
    expect(activeOnly.map((session) => session.id)).not.toContain(sessionToRevoke.id);
    await expectCode('invalid_query', () => cp.listClientSessions(owner, { limit: 0 }));
    await expectCode('invalid_query', () => cp.listClientSessions(owner, { platform: 'watchos' as never }));
  });

  it('reads one session tenant-scoped: missing and foreign are uniformly session_not_found', async () => {
    await expectCode('session_not_found', () =>
      cp.getClientSession(owner, { clientSessionId: newId() }),
    );
    await expectCode('session_not_found', () =>
      cp.getClientSession(owner, { clientSessionId: sessionIsoAWeb.id }),
    );
    await expectCode('session_not_found', () =>
      cp.getClientSession(member(tenantErr), { clientSessionId: sessionWeb.id }),
    );
    await expectCode('invalid_query', () =>
      cp.getClientSession(owner, { clientSessionId: 'not-a-uuid' }),
    );
  });
});

describe('revokeClientSession — the one-way transition', () => {
  it('revokes once, then refuses the second call and freezes the acting rights', async () => {
    const revoked = await cp.revokeClientSession(handoffUser, {
      clientSessionId: sessionToRevoke.id,
    });
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokedAt !== null).toBe(true);
    await expectCode('session_already_revoked', () =>
      cp.revokeClientSession(handoffUser, { clientSessionId: sessionToRevoke.id }),
    );
    // A revoked session can no longer ACT (open a handoff).
    await expectCode('session_not_active', () =>
      cp.openHandoffSession(handoffUser, {
        clientSessionId: sessionToRevoke.id,
        context: {
          focusKind: 'conversation',
          focusRef: conversationHandoff.id,
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
    await expectCode('session_not_found', () =>
      cp.revokeClientSession(handoffUser, { clientSessionId: newId() }),
    );
  });

  it('an expired session is derived-state expired and cannot act either', async () => {
    const restore = pinClock(T_PAST);
    const registered = await cp.registerClientSession(handoffUser, {
      platform: 'mobile',
      deviceLabel: 'Long-gone phone',
      expiresAt: '2021-06-01T00:00:00.000Z',
    });
    restore();
    expect(registered.state).toBe('expired');
    const reread = await cp.getClientSession(handoffUser, { clientSessionId: registered.id });
    expect(reread.state).toBe('expired');
    await expectCode('session_not_active', () =>
      cp.openHandoffSession(handoffUser, {
        clientSessionId: registered.id,
        context: {
          focusKind: 'conversation',
          focusRef: conversationHandoff.id,
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The authoritative state — identical for every client kind
// ---------------------------------------------------------------------------

describe('readConversationState — the client-agnostic authoritative read', () => {
  it('serves byte-identical projections to web, desktop and mobile sessions', async () => {
    const reads = await Promise.all(
      [sessionWeb, sessionDesktop, sessionMobile].map(() =>
        cp.readConversationState(owner, { conversationId: conversationState.id, messageLimit: 50 }),
      ),
    );
    const web = reads[0]!;
    const desktop = reads[1]!;
    const mobile = reads[2]!;
    expect(web).toEqual(desktop);
    expect(web).toEqual(mobile);
    expect(web.conversation.id).toBe(conversationState.id);
    expect(web.conversation.title).toBe('Site survey briefing');
    expect(web.messages).toHaveLength(3);
    expect(web.projectionRef.projectionKind).toBe('conversation-state');
    expect(web.projectionRef.targetId).toBe(conversationState.id);
    // revision = the thread's message count (monotonic under appends).
    expect(web.projectionRef.revision).toBe(3);
    expect(web.projectionRef.tenantId).toBe(tenantState);
  });

  it('binds a digest ANY client kind can recompute from the served projection alone', async () => {
    const projection = await cp.readConversationState(owner, {
      conversationId: conversationState.id,
      messageLimit: 50,
    });
    const recomputed = cp.digestOf({
      conversation: {
        id: projection.conversation.id,
        title: projection.conversation.title,
        messageCount: projection.conversation.messageCount,
        lastMessageAt: projection.conversation.lastMessageAt,
      },
      messages: projection.messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        channel: message.channel,
        actor: message.actor,
        payload: message.payload,
        sentAt: message.sentAt,
        recordedAt: message.recordedAt,
      })),
    });
    expect(projection.projectionRef.digest).toBe(recomputed);
    // The same recomputation through the served window with a smaller
    // limit is a DIFFERENT digest (the window is part of the content).
    const window = await cp.readConversationState(owner, {
      conversationId: conversationState.id,
      messageLimit: 2,
    });
    expect(window.messages).toHaveLength(2);
    expect(window.messages[0]!.payload).toEqual({ text: 'turn 1 of Site survey briefing' });
    expect(window.projectionRef.revision).toBe(3);
    expect(window.projectionRef.digest).not.toBe(projection.projectionRef.digest);
    await expectCode('invalid_query', () =>
      cp.readConversationState(owner, { conversationId: conversationState.id, messageLimit: 0 }),
    );
  });

  it('refuses a missing or foreign conversation uniformly (conversation_not_found)', async () => {
    await expectCode('conversation_not_found', () =>
      cp.readConversationState(owner, { conversationId: newId() }),
    );
    await expectCode('conversation_not_found', () =>
      cp.readConversationState(owner, { conversationId: convIsoA.id }),
    );
    await expectCode('conversation_not_found', () =>
      cp.readConversationState(member(tenantErr), { conversationId: conversationState.id }),
    );
  });
});

describe('readCompanyOverview — the client-agnostic company read', () => {
  it('serves the same compact summaries to every client kind, content-addressed', async () => {
    const reads = await Promise.all(
      [sessionWeb, sessionDesktop, sessionMobile].map(() =>
        cp.readCompanyOverview(owner, { goalLimit: 50, missionLimit: 50 }),
      ),
    );
    const web = reads[0]!;
    const desktop = reads[1]!;
    const mobile = reads[2]!;
    expect(web).toEqual(desktop);
    expect(web).toEqual(mobile);
    expect(web.projectionRef.projectionKind).toBe('company-overview');
    expect(web.projectionRef.targetId).toBe(tenantState);
    expect(web.goals.map((goal) => goal.goalId).sort()).toEqual([goalA.id, goalB.id].sort());
    expect(web.missions.map((mission) => mission.missionId).sort()).toEqual(
      [missionActive.id, missionCompleted.id, missionAbandoned.id].sort(),
    );
    // Verbatim field mirroring (the goals seam W008's own records).
    const active = web.missions.find((mission) => mission.missionId === missionActive.id)!;
    expect(active.status).toBe('active');
    expect(active.urgency).toBe('high');
    expect(active.title).toBe('Map the survey practice');
    const completed = web.missions.find((mission) => mission.missionId === missionCompleted.id)!;
    expect(completed.status).toBe('completed');
    const abandoned = web.missions.find((mission) => mission.missionId === missionAbandoned.id)!;
    expect(abandoned.status).toBe('abandoned');
    // revision = served goal + mission count; digest recomputable.
    expect(web.projectionRef.revision).toBe(web.goals.length + web.missions.length);
    expect(web.projectionRef.digest).toBe(cp.digestOf({ goals: web.goals, missions: web.missions }));
    await expectCode('invalid_query', () => cp.readCompanyOverview(owner, { goalLimit: 501 }));
  });

  it('an empty tenant reads an empty overview (no fabricated state)', async () => {
    const empty = await cp.readCompanyOverview(member(tenantErr), {});
    expect(empty.goals).toEqual([]);
    expect(empty.missions).toEqual([]);
    expect(empty.projectionRef.revision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The background-work feed — inspectable everywhere, identical semantics
// ---------------------------------------------------------------------------

describe('listBackgroundWork / getBackgroundWorkItem', () => {
  it('projects the three seams with normalized phases and VERBATIM seam statuses', async () => {
    const feed = await cp.listBackgroundWork(owner, { limit: 500 });
    const byId = new Map(feed.map((item) => [item.workId, item]));
    // Missions W011: active → in-flight, completed → succeeded, abandoned → cancelled.
    const mission = byId.get(missionActive.id)!;
    expect(mission.seam).toBe('mission');
    expect(mission.seamStatus).toBe('active');
    expect(mission.phase).toBe('in-flight');
    expect(mission.parentRef).toBeNull();
    expect(mission.title).toBe('Map the survey practice');
    expect(byId.get(missionCompleted.id)!.phase).toBe('succeeded');
    expect(byId.get(missionCompleted.id)!.seamStatus).toBe('completed');
    expect(byId.get(missionAbandoned.id)!.phase).toBe('cancelled');
    expect(byId.get(missionAbandoned.id)!.seamStatus).toBe('abandoned');
    // Execution runs W136: queued → in-flight, succeeded → succeeded,
    // awaiting_approval → awaiting-decision; parentRef = the plan.
    const run = byId.get(runQueued.id)!;
    expect(run.seam).toBe('execution-run');
    expect(run.seamStatus).toBe('queued');
    expect(run.phase).toBe('in-flight');
    expect(run.parentRef).not.toBeNull();
    const succeededRun = byId.get(runSucceeded.id)!;
    expect(succeededRun.seamStatus).toBe('succeeded');
    expect(succeededRun.phase).toBe('succeeded');
    const awaitingRun = byId.get(runAwaiting.id)!;
    expect(awaitingRun.seamStatus).toBe('awaiting_approval');
    expect(awaitingRun.phase).toBe('awaiting-decision');
    // Fabric leases W137: preparing → in-flight, live → in-flight,
    // cancelled → cancelled; parentRef = the environment definition.
    const leases = feed.filter((item) => item.seam === 'fabric-lease');
    expect(leases).toHaveLength(3);
    expect(leases.map((lease) => lease.seamStatus).sort()).toEqual(['cancelled', 'live', 'preparing']);
    expect(leases.every((lease) => lease.parentRef !== null)).toBe(true);
    expect(leases.filter((lease) => lease.seamStatus === 'cancelled').every((lease) => lease.phase === 'cancelled')).toBe(true);
    expect(leases.filter((lease) => lease.seamStatus !== 'cancelled').every((lease) => lease.phase === 'in-flight')).toBe(true);
    // Every item is tenant-scoped.
    expect(feed.every((item) => item.tenantId === tenantState)).toBe(true);
  });

  it('serves the IDENTICAL feed to web, desktop and mobile sessions (inspectable everywhere)', async () => {
    const reads = await Promise.all(
      [sessionWeb, sessionDesktop, sessionMobile].map(() => cp.listBackgroundWork(owner, { limit: 500 })),
    );
    const web = reads[0]!;
    const desktop = reads[1]!;
    const mobile = reads[2]!;
    expect(web).toEqual(desktop);
    expect(web).toEqual(mobile);
    // The deterministic order: latest activity first, workId tie-break.
    for (let index = 1; index < web.length; index += 1) {
      const previous = web[index - 1]!;
      const current = web[index]!;
      const byUpdated = Date.parse(previous.updatedAt) - Date.parse(current.updatedAt);
      if (byUpdated === 0) {
        expect(previous.workId.localeCompare(current.workId)).toBeGreaterThan(0);
      } else {
        expect(byUpdated).toBeGreaterThan(0);
      }
    }
    // Per-item reads are identical too, for every seam.
    for (const seam of ['mission', 'execution-run', 'fabric-lease'] as const) {
      const source = web.find((item) => item.seam === seam)!;
      const [itemWeb, itemDesktop, itemMobile] = await Promise.all(
        [sessionWeb, sessionDesktop, sessionMobile].map(() =>
          cp.getBackgroundWorkItem(owner, { seam, workRef: source.workId }),
        ),
      );
      expect(itemWeb).toEqual(itemDesktop);
      expect(itemWeb).toEqual(itemMobile);
      expect(itemWeb).toEqual(source);
    }
  });

  it('filters by seam and by phase, after which the limit applies', async () => {
    const missions = await cp.listBackgroundWork(owner, { seam: 'mission' });
    expect(missions.every((item) => item.seam === 'mission')).toBe(true);
    expect(missions).toHaveLength(3);
    const runs = await cp.listBackgroundWork(owner, { seam: 'execution-run' });
    expect(runs.every((item) => item.seam === 'execution-run')).toBe(true);
    expect(runs).toHaveLength(3);
    const succeeded = await cp.listBackgroundWork(owner, { phase: 'succeeded' });
    expect(succeeded.every((item) => item.phase === 'succeeded')).toBe(true);
    expect(succeeded.map((item) => item.workId)).toContain(missionCompleted.id);
    expect(succeeded.map((item) => item.workId)).toContain(runSucceeded.id);
    const leaseCancelled = await cp.listBackgroundWork(owner, {
      seam: 'fabric-lease',
      phase: 'cancelled',
    });
    expect(leaseCancelled).toHaveLength(1);
    const bounded = await cp.listBackgroundWork(owner, { seam: 'mission', limit: 2 });
    expect(bounded).toHaveLength(2);
    await expectCode('invalid_query', () => cp.listBackgroundWork(owner, { seam: 'nope' as never }));
    await expectCode('invalid_query', () => cp.listBackgroundWork(owner, { phase: 'nope' as never }));
  });

  it('reads one item by seam + ref with uniform typed not-found', async () => {
    const mission = await cp.getBackgroundWorkItem(owner, {
      seam: 'mission',
      workRef: missionActive.id,
    });
    expect(mission.workId).toBe(missionActive.id);
    await expectCode('work_item_not_found', () =>
      cp.getBackgroundWorkItem(owner, { seam: 'mission', workRef: newId() }),
    );
    await expectCode('work_item_not_found', () =>
      cp.getBackgroundWorkItem(owner, { seam: 'execution-run', workRef: `${runQueued.id}0` }),
    );
    // A foreign tenant's work is invisible on every seam.
    await expectCode('work_item_not_found', () =>
      cp.getBackgroundWorkItem(member(tenantErr), { seam: 'mission', workRef: missionActive.id }),
    );
    // An empty tenant sees an empty feed everywhere.
    const empty = await cp.listBackgroundWork(member(tenantErr), {});
    expect(empty).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Platform-native capabilities — adapters, and removal neutrality
// ---------------------------------------------------------------------------

describe('the platform adapter registry + capability SPI', () => {
  it('registers one adapter per platform kind and refuses a second registration', async () => {
    const mobileDescriptor = await cp.registerPlatformAdapter(cp.createMobilePlatformAdapter());
    expect(mobileDescriptor.platform).toBe('mobile');
    expect(mobileDescriptor.health).toBe('available');
    // web + desktop were registered in beforeAll; the list is probed live.
    const listed = await cp.listPlatformAdapters();
    expect(listed.map((descriptor) => descriptor.platform).sort()).toEqual(['desktop', 'mobile', 'web']);
    for (const descriptor of listed) {
      // Vendor identity is METADATA only (the W131 law applied to clients).
      expect(descriptor.vendor.vendorName).toMatch(/^aurum-(web|desktop|mobile)-sim$/);
      expect(descriptor.capabilities).toHaveLength(5);
    }
    await expectCode('adapter_already_registered', () =>
      cp.registerPlatformAdapter(cp.createWebPlatformAdapter()),
    );
  });

  it('serves capabilities through the registered adapters, refuses unsupported domains, maps vendor throws', async () => {
    const receipt = await cp.invokePlatformCapability(owner, {
      platform: 'web',
      domain: 'notifications',
      input: { title: 'Survey ready' },
    });
    expect(receipt.adapterId).toBe('web-platform-sim-1');
    expect(receipt.domain).toBe('notifications');
    expect(typeof receipt.servedAt).toBe('string');
    // The honest-descriptor law: web declares window-management unsupported.
    await expectCode('capability_not_supported', () =>
      cp.invokePlatformCapability(owner, {
        platform: 'web',
        domain: 'window-management',
        input: {},
      }),
    );
    // Desktop (the power client) serves window-management.
    const desktopReceipt = await cp.invokePlatformCapability(owner, {
      platform: 'desktop',
      domain: 'window-management',
      input: { action: 'maximize' },
    });
    expect(desktopReceipt.domain).toBe('window-management');
    // A vendor-path throw is a typed failure — never a fabricated receipt.
    cp.unregisterPlatformAdapter('mobile-platform-sim-1');
    await cp.registerPlatformAdapter(cp.createMobilePlatformAdapter({ invokeFailures: 1 }));
    await expectCode('capability_invocation_failed', () =>
      cp.invokePlatformCapability(owner, {
        platform: 'mobile',
        domain: 'camera',
        input: {},
      }),
    );
    const afterFailure = await cp.invokePlatformCapability(owner, {
      platform: 'mobile',
      domain: 'camera',
      input: {},
    });
    expect(afterFailure.domain).toBe('camera');
    // Input validation: the platform and domain vocabularies are closed.
    await expectCode('invalid_capability_input', () =>
      cp.invokePlatformCapability(owner, { platform: 'watchos' as never, domain: 'camera', input: {} }),
    );
    await expectCode('invalid_capability_input', () =>
      cp.invokePlatformCapability(owner, { platform: 'web', domain: 'telepathy' as never, input: {} }),
    );
    await expectCode('invalid_capability_input', () =>
      cp.invokePlatformCapability(owner, { platform: 'web', domain: 'camera', input: () => 1 }),
    );
  });

  it('REMOVAL NEUTRALITY (the W137 pattern): zero adapters change no domain read, refuse acquisitions typed, restore on re-registration', async () => {
    // The domain reads with adapters registered.
    const conversationBefore = await cp.readConversationState(owner, {
      conversationId: conversationState.id,
      messageLimit: 50,
    });
    const overviewBefore = await cp.readCompanyOverview(owner, {});
    const workBefore = await cp.listBackgroundWork(owner, { limit: 500 });
    const shellBefore = await cp.readShellModel(owner, {});
    const handoffsBefore = await cp.listHandoffSessions(handoffUser, {});
    const sessionsBefore = await cp.listClientSessions(owner, {});
    const evidenceBefore = await cp.listHandoffEvidence(member(tenantIsoA), {
      handoffSessionId: (await cp.listHandoffSessions(member(tenantIsoA), {}))[0]!.id,
    });

    // THE VENDOR-REMOVAL OPERATION: every adapter unregistered.
    cp.unregisterPlatformAdapter('web-platform-sim-1');
    cp.unregisterPlatformAdapter('desktop-platform-sim-1');
    cp.unregisterPlatformAdapter('mobile-platform-sim-1');
    expect(await cp.listPlatformAdapters()).toEqual([]);

    // Only the capability surface surfaces the removal — typed, honestly.
    for (const platform of ['web', 'desktop', 'mobile'] as const) {
      await expectCode('adapter_not_found', () => cp.probePlatformCapabilities(platform));
      await expectCode('adapter_not_found', () =>
        cp.invokePlatformCapability(owner, { platform, domain: 'notifications', input: {} }),
      );
    }

    // Every domain read is byte-identical with ZERO adapters registered.
    expect(
      await cp.readConversationState(owner, { conversationId: conversationState.id, messageLimit: 50 }),
    ).toEqual(conversationBefore);
    expect(await cp.readCompanyOverview(owner, {})).toEqual(overviewBefore);
    expect(await cp.listBackgroundWork(owner, { limit: 500 })).toEqual(workBefore);
    expect(await cp.readShellModel(owner, {})).toEqual(shellBefore);
    expect(await cp.listHandoffSessions(handoffUser, {})).toEqual(handoffsBefore);
    expect(await cp.listClientSessions(owner, {})).toEqual(sessionsBefore);
    expect(
      await cp.listHandoffEvidence(member(tenantIsoA), {
        handoffSessionId: (await cp.listHandoffSessions(member(tenantIsoA), {}))[0]!.id,
      }),
    ).toEqual(evidenceBefore);

    // Re-registration restores serving (same frozen SPI).
    await cp.registerPlatformAdapter(cp.createWebPlatformAdapter());
    await cp.registerPlatformAdapter(cp.createDesktopPlatformAdapter());
    await cp.registerPlatformAdapter(cp.createMobilePlatformAdapter());
    const restored = await cp.invokePlatformCapability(owner, {
      platform: 'web',
      domain: 'notifications',
      input: { title: 'back online' },
    });
    expect(restored.adapterId).toBe('web-platform-sim-1');
    expect(restored.domain).toBe('notifications');
  });
});

// ---------------------------------------------------------------------------
// Cross-device handoff — evidenced
// ---------------------------------------------------------------------------

describe('the handoff lifecycle — open, hand off, resume (fresh + stale), close', () => {
  it('walks the full evidenced lifecycle with the exact-state resumption', async () => {
    // The frozen working context — the NORMALIZED shape the service
    // freezes (towerSurface/focusRef normalize to null when absent).
    const frozenContext: HandoffWorkingContext = {
      focusKind: 'conversation',
      focusRef: conversationHandoff.id,
      draft: 'Half-written reply about the site survey',
      navigation: { area: 'chat', towerSurface: null, focusRef: conversationHandoff.id },
    };

    // OPEN on the web client (context frozen + first evidence).
    let restore = pinClock(T_OPEN);
    let session = await cp.openHandoffSession(handoffUser, {
      clientSessionId: sessionWebH.id,
      context: frozenContext,
    });
    restore();
    expect(session.status).toBe('open');
    expect(session.context).toEqual(frozenContext);
    expect(session.originClientSessionId).toBe(sessionWebH.id);
    expect(session.activeClientSessionId).toBe(sessionWebH.id);
    expect(session.openOnPlatform).toBe('web');
    expect(session.anchorRevision).toBe(1);
    expect(session.closedAt).toBeNull();
    const handoffId = session.id;
    let trail = await cp.listHandoffEvidence(handoffUser, { handoffSessionId: handoffId });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.kind).toBe('session-opened');
    expect(trail[0]!.contextSnapshot).toEqual(frozenContext);
    expect(trail[0]!.fromPlatform).toBe('web');
    expect(trail[0]!.toPlatform).toBeNull();
    expect(trail[0]!.actor).toBe(handoffPrincipalId);
    expect(trail[0]!.clientSessionId).toBe(sessionWebH.id);
    // The opening evidence is bound to the CURRENT server projection.
    expect(trail[0]!.projectionRevision).toBe(1);
    expect(trail[0]!.projectionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // HAND OFF to the mobile client (verbatim context, new evidence).
    restore = pinClock(T_HANDOFF);
    session = await cp.recordHandoff(handoffUser, {
      handoffSessionId: handoffId,
      toClientSessionId: sessionMobileH.id,
    });
    restore();
    expect(session.activeClientSessionId).toBe(sessionMobileH.id);
    expect(session.openOnPlatform).toBe('mobile');
    expect(session.context).toEqual(frozenContext);
    expect(session.anchorRevision).toBe(2);
    trail = await cp.listHandoffEvidence(handoffUser, { handoffSessionId: handoffId });
    expect(trail).toHaveLength(2);
    expect(trail[1]!.kind).toBe('handoff-recorded');
    expect(trail[1]!.fromPlatform).toBe('web');
    expect(trail[1]!.toPlatform).toBe('mobile');
    expect(trail[1]!.contextSnapshot).toEqual(frozenContext);
    // The receiving session's journey stamp moved (the acting record).
    const mobileAfter = await cp.getClientSession(handoffUser, { clientSessionId: sessionMobileH.id });
    expect(mobileAfter.lastSeenAt).toBe(T_HANDOFF);

    // RESUME on the desktop client with a FRESH revision — exact state.
    restore = pinClock(T_RESUME);
    let resumption = await cp.resumeHandoff(handoffUser, {
      handoffSessionId: handoffId,
      clientSessionId: sessionDesktopH.id,
      clientRevision: 1,
    });
    restore();
    expect(resumption.restoredContext).toEqual(frozenContext);
    expect(resumption.session.activeClientSessionId).toBe(sessionDesktopH.id);
    expect(resumption.session.openOnPlatform).toBe('desktop');
    expect(resumption.conflict).toBeNull();
    // The frozen W131 handoff semantics literals, verbatim.
    expect(resumption.semantics).toEqual({
      reprojection: 'from-server-state',
      authorityTransfer: 'none',
      payload: 'projection-refs-only',
    });
    expect(resumption.reprojection.projectionKind).toBe('conversation-state');
    expect(resumption.reprojection.revision).toBe(1);

    // The server state moves on: one more message on the thread.
    restore = pinClock(T_APPEND);
    await recordMessage(handoffUser, {
      conversationId: conversationHandoff.id,
      direction: 'inbound',
      actor: { kind: 'external', label: 'w139-fixture-sender' },
      channel: 'web',
      payload: { text: 'the survey advanced' },
      sentAt: T_APPEND,
    });
    restore();

    // RESUME on the web client with the now-STALE revision — discarded.
    restore = pinClock(T_RESUME_STALE);
    resumption = await cp.resumeHandoff(handoffUser, {
      handoffSessionId: handoffId,
      clientSessionId: sessionWebH.id,
      clientRevision: 1,
    });
    restore();
    expect(resumption.restoredContext).toEqual(frozenContext);
    expect(resumption.reprojection.revision).toBe(2);
    expect(resumption.conflict).not.toBeNull();
    expect(resumption.conflict!.conflictKind).toBe('stale-client-projection');
    expect(resumption.conflict!.resolution).toBe('server-state-wins');
    expect(resumption.conflict!.discardedClientRevision).toBe(1);
    expect(resumption.conflict!.anchorRef).toBe(handoffId);
    expect(resumption.conflict!.resolvedAt).toBe(T_RESUME_STALE);

    // CLOSE — the one-way terminal transition.
    restore = pinClock(T_CLOSE);
    session = await cp.closeHandoffSession(handoffUser, { handoffSessionId: handoffId });
    restore();
    expect(session.status).toBe('closed');
    expect(session.closedAt).toBe(T_CLOSE);
    expect(session.context).toEqual(frozenContext);

    // The full trail, in timeline order: the multiset of kinds is exact
    // (same-millisecond events order by id — the counts are the proof),
    // and anchorRevision ALWAYS equals the evidence count.
    trail = await cp.listHandoffEvidence(handoffUser, { handoffSessionId: handoffId });
    expect(trail).toHaveLength(6);
    expect(trail[0]!.kind).toBe('session-opened');
    expect(trail[5]!.kind).toBe('session-closed');
    expect([...trail.map((event) => event.kind)].sort()).toEqual(
      [
        'session-opened',
        'handoff-recorded',
        'resumed',
        'resumed',
        'conflict-discarded',
        'session-closed',
      ].sort(),
    );
    for (let index = 1; index < trail.length; index += 1) {
      expect(Date.parse(trail[index - 1]!.recordedAt)).toBeLessThanOrEqual(
        Date.parse(trail[index]!.recordedAt),
      );
    }
    const discard = trail.find((event) => event.kind === 'conflict-discarded')!;
    expect(discard.resolution).toBe('server-state-wins');
    expect(discard.discardedClientRevision).toBe(1);
    expect(discard.contextSnapshot).toBeNull();
    expect(discard.projectionRevision).toBe(2);
    const reread = await cp.getHandoffSession(handoffUser, { handoffSessionId: handoffId });
    expect(reread.anchorRevision).toBe(trail.length);
    // The kind filter.
    const resumes = await cp.listHandoffEvidence(handoffUser, {
      handoffSessionId: handoffId,
      kind: 'resumed',
    });
    expect(resumes).toHaveLength(2);
    expect(resumes.every((event) => event.kind === 'resumed')).toBe(true);
  });

  it('re-projects a mission focus from current server state (the mission seam path)', async () => {
    const context: HandoffWorkingContext = {
      focusKind: 'mission',
      focusRef: missionHandoff.id,
      draft: null,
      navigation: { area: 'intelligence', towerSurface: 'missions', focusRef: null },
    };
    let restore = pinClock(T_FIX);
    const session = await cp.openHandoffSession(handoffUser, {
      clientSessionId: sessionWebH.id,
      context,
    });
    restore();
    expect(session.context).toEqual(context);
    let trail = await cp.listHandoffEvidence(handoffUser, { handoffSessionId: session.id });
    expect(trail[0]!.projectionRevision).toBe(1); // the mission's version
    // The mission advances (version 2) → the client's revision 1 is stale.
    await reviseMission(handoffUser, {
      missionId: missionHandoff.id,
      title: 'Verify the site roster, revised',
      actor: { kind: 'system', label: 'w139-test' },
    });
    restore = pinClock(T_MISSION_RESUME);
    const resumption = await cp.resumeHandoff(handoffUser, {
      handoffSessionId: session.id,
      clientSessionId: sessionMobileH.id,
      clientRevision: 1,
    });
    restore();
    expect(resumption.reprojection.projectionKind).toBe('mission-state');
    expect(resumption.reprojection.revision).toBe(2);
    expect(resumption.conflict).not.toBeNull();
    expect(resumption.conflict!.resolution).toBe('server-state-wins');
    expect(resumption.restoredContext).toEqual(context);
    trail = await cp.listHandoffEvidence(handoffUser, { handoffSessionId: session.id });
    expect(trail.map((event) => event.kind)).toContain('conflict-discarded');
    // The one-way close + the sequential second-call refusals.
    await cp.closeHandoffSession(handoffUser, { handoffSessionId: session.id });
    await expectCode('handoff_already_closed', () =>
      cp.closeHandoffSession(handoffUser, { handoffSessionId: session.id }),
    );
    await expectCode('handoff_not_open', () =>
      cp.recordHandoff(handoffUser, {
        handoffSessionId: session.id,
        toClientSessionId: sessionDesktopH.id,
      }),
    );
    await expectCode('handoff_not_open', () =>
      cp.resumeHandoff(handoffUser, {
        handoffSessionId: session.id,
        clientSessionId: sessionDesktopH.id,
      }),
    );
  });

  it('refuses the structural handoff violations (same session, foreign principal, bad focus)', async () => {
    const restore = pinClock(T_FIX);
    const session = await cp.openHandoffSession(handoffUser, {
      clientSessionId: sessionWebH.id,
      context: {
        focusKind: 'conversation',
        focusRef: conversationHandoff.id,
        draft: 'another working context',
        navigation: { area: 'chat' },
      },
    });
    restore();
    // A handoff must MOVE between sessions.
    await expectCode('handoff_same_session', () =>
      cp.recordHandoff(handoffUser, {
        handoffSessionId: session.id,
        toClientSessionId: sessionWebH.id,
      }),
    );
    // A user's working context moves between their OWN devices only.
    await expectCode('session_principal_mismatch', () =>
      cp.recordHandoff(handoffUser, {
        handoffSessionId: session.id,
        toClientSessionId: sessionForeign.id,
      }),
    );
    // The honest-focus gate: a focus that does not resolve is refused.
    await expectCode('conversation_not_found', () =>
      cp.openHandoffSession(handoffUser, {
        clientSessionId: sessionWebH.id,
        context: {
          focusKind: 'conversation',
          focusRef: newId(),
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
    await expectCode('mission_not_found', () =>
      cp.openHandoffSession(handoffUser, {
        clientSessionId: sessionWebH.id,
        context: {
          focusKind: 'mission',
          focusRef: missionActive.id, // belongs to tenantState
          draft: null,
          navigation: { area: 'intelligence' },
        },
      }),
    );
    await expectCode('work_item_not_found', () =>
      cp.openHandoffSession(handoffUser, {
        clientSessionId: sessionWebH.id,
        context: {
          focusKind: 'background-work',
          focusRef: runQueued.id, // belongs to tenantState
          focusSeam: 'execution-run',
          draft: null,
          navigation: { area: 'today' },
        },
      }),
    );
    // The acting session must belong to the calling principal.
    await expectCode('session_principal_mismatch', () =>
      cp.openHandoffSession(member(tenantHandoff, newId()), {
        clientSessionId: sessionWebH.id,
        context: {
          focusKind: 'conversation',
          focusRef: conversationHandoff.id,
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
    // Validation gates fire through the service too.
    await expectCode('invalid_handoff_input', () =>
      cp.openHandoffSession(handoffUser, {
        clientSessionId: sessionWebH.id,
        context: {
          focusKind: 'background-work',
          focusRef: 'x', // focusSeam missing
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
    await expectCode('handoff_not_found', () =>
      cp.recordHandoff(handoffUser, {
        handoffSessionId: newId(),
        toClientSessionId: sessionMobileH.id,
      }),
    );
    await expectCode('session_not_found', () =>
      cp.openHandoffSession(handoffUser, {
        clientSessionId: newId(),
        context: {
          focusKind: 'conversation',
          focusRef: conversationHandoff.id,
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
  });

  it('keeps the evidence trail append-only and the context immutable at the STORAGE level', async () => {
    const db = getDb();
    await expect(db.query(`UPDATE handoff_evidence SET actor = 'forged'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM handoff_evidence`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE handoff_evidence`)).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE handoff_sessions SET draft = 'forged'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`UPDATE handoff_sessions SET focus_ref = 'forged'`),
    ).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM handoff_sessions`)).rejects.toThrow(/append-and-close/);
    await expect(db.query(`UPDATE client_sessions SET platform = 'mobile'`)).rejects.toThrow(
      /immutable/,
    );
    await expect(db.query(`UPDATE client_sessions SET device_label = 'forged'`)).rejects.toThrow(
      /immutable/,
    );
    await expect(db.query(`DELETE FROM client_sessions`)).rejects.toThrow(/append-and-revoke/);
  });

  it('lists handoff sessions with the status/focus/platform filters (own records only)', async () => {
    const open = await cp.listHandoffSessions(handoffUser, { status: 'open' });
    expect(open.every((session) => session.status === 'open')).toBe(true);
    expect(open.map((session) => session.context.focusKind)).not.toContain('mission');
    const conversations = await cp.listHandoffSessions(handoffUser, { focusKind: 'conversation' });
    expect(conversations.length).toBeGreaterThanOrEqual(2);
    const mobileHeld = await cp.listHandoffSessions(handoffUser, { platform: 'mobile' });
    expect(mobileHeld.every((session) => session.openOnPlatform === 'mobile')).toBe(true);
    expect(mobileHeld.map((session) => session.id)).not.toContain(open[0]!.id);
    await expectCode('invalid_query', () => cp.listHandoffSessions(handoffUser, { limit: 0 }));
    await expectCode('invalid_query', () =>
      cp.listHandoffSessions(handoffUser, { status: 'nope' as never }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation — client sessions and handoff state never leak', () => {
  it("tenant B sees none of tenant A's sessions, handoffs or evidence; same shapes coexist per tenant", async () => {
    const ctxA = isoA;
    const ctxB = isoB;

    // B sees no sessions and no handoffs of A — only B's own (same-shaped)
    // registrations, never A's ids.
    const sessionsB = await cp.listClientSessions(ctxB, {});
    expect(sessionsB.map((session) => session.id).sort()).toEqual(
      [sessionIsoBWeb.id, sessionIsoBMobile.id].sort(),
    );
    expect(sessionsB.every((session) => session.tenantId === tenantIsoB)).toBe(true);
    expect(await cp.listHandoffSessions(ctxB, {})).toEqual([]);
    const handoffA = (await cp.listHandoffSessions(ctxA, {}))[0]!;
    expect(handoffA.tenantId).toBe(tenantIsoA);

    // Uniform not-founds — foreign ≡ missing, on every path.
    await expectCode('session_not_found', () =>
      cp.getClientSession(ctxB, { clientSessionId: sessionIsoAWeb.id }),
    );
    await expectCode('session_not_found', () =>
      cp.openHandoffSession(ctxB, {
        clientSessionId: sessionIsoAWeb.id,
        context: {
          focusKind: 'conversation',
          focusRef: convIsoB.id,
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
    await expectCode('handoff_not_found', () =>
      cp.getHandoffSession(ctxB, { handoffSessionId: handoffA.id }),
    );
    await expectCode('handoff_not_found', () =>
      cp.listHandoffEvidence(ctxB, { handoffSessionId: handoffA.id }),
    );
    await expectCode('handoff_not_found', () =>
      cp.recordHandoff(ctxB, {
        handoffSessionId: handoffA.id,
        toClientSessionId: sessionIsoBMobile.id,
      }),
    );
    await expectCode('handoff_not_found', () =>
      cp.resumeHandoff(ctxB, {
        handoffSessionId: handoffA.id,
        clientSessionId: sessionIsoBMobile.id,
      }),
    );
    await expectCode('handoff_not_found', () =>
      cp.closeHandoffSession(ctxB, { handoffSessionId: handoffA.id }),
    );

    // B's own state reads are B's alone (conversation + work + overview).
    await expectCode('conversation_not_found', () =>
      cp.readConversationState(ctxB, { conversationId: convIsoA.id }),
    );
    expect(await cp.listBackgroundWork(ctxB, {})).toEqual([]);
    const overviewB = await cp.readCompanyOverview(ctxB, {});
    expect(overviewB.goals).toEqual([]);

    // The same natural shapes coexist: B walks its own lifecycle over its
    // own conversation with the SAME title and the SAME device label.
    const handoffB = await cp.openHandoffSession(ctxB, {
      clientSessionId: sessionIsoBWeb.id,
      context: {
        focusKind: 'conversation',
        focusRef: convIsoB.id,
        draft: 'B tenant draft',
        navigation: { area: 'chat' },
      },
    });
    expect(handoffB.tenantId).toBe(tenantIsoB);
    expect(handoffB.id).not.toBe(handoffA.id);
    const moved = await cp.recordHandoff(ctxB, {
      handoffSessionId: handoffB.id,
      toClientSessionId: sessionIsoBMobile.id,
    });
    expect(moved.openOnPlatform).toBe('mobile');
    expect(moved.context.focusRef).toBe(convIsoB.id);
    const trailB = await cp.listHandoffEvidence(ctxB, { handoffSessionId: handoffB.id });
    expect(trailB.map((event) => event.kind)).toEqual(['session-opened', 'handoff-recorded']);
    expect(trailB.every((event) => event.tenantId === tenantIsoB)).toBe(true);

    // A's records are untouched by B's lifecycle.
    const handoffAAfter = await cp.getHandoffSession(ctxA, { handoffSessionId: handoffA.id });
    expect(handoffAAfter.activeClientSessionId).toBe(sessionIsoAWeb.id);
    expect(handoffAAfter.openOnPlatform).toBe('web');
    const trailA = await cp.listHandoffEvidence(ctxA, { handoffSessionId: handoffA.id });
    expect(trailA.every((event) => event.tenantId === tenantIsoA)).toBe(true);
    expect(trailA.some((event) => event.kind === 'handoff-recorded')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The product shell read model + the no-second-authority tripwire
// ---------------------------------------------------------------------------

describe('readShellModel — the W057 semantics, contract-level only', () => {
  it('serves the typed shell model with every W057 element, identical for every client kind', async () => {
    const reads = await Promise.all(
      [sessionWeb, sessionDesktop, sessionMobile].map(() => cp.readShellModel(owner, {})),
    );
    const web = reads[0]!;
    const desktop = reads[1]!;
    const mobile = reads[2]!;
    expect(web).toEqual(desktop);
    expect(web).toEqual(mobile);
    expect(web.projectionRef.projectionKind).toBe('product-shell');

    // The seven product areas, in plan order, web-canonical addressing.
    expect(web.areas.map((area) => area.areaId)).toEqual([
      'chat',
      'today',
      'intelligence',
      'people',
      'connections',
      'marketplace',
      'more',
    ]);
    expect(web.areas.map((area) => area.href)).toEqual([
      '/chat',
      '/today',
      '/intelligence',
      '/people',
      '/connections',
      '/marketplace',
      '/more',
    ]);
    expect(web.areas.find((area) => area.areaId === 'today')!.mode).toBe('management');
    expect(web.areas.every((area) => area.mode === 'product' || area.areaId === 'today')).toBe(true);
    expect(web.areas.every((area) => area.shortLabel.length > 0 && area.tagline.length > 0)).toBe(true);

    // The command search: 7 areas + 15 tower surfaces + 3 entry points.
    expect(web.commandSearch).toHaveLength(25);
    const byTargetKind = new Map<string, number>();
    for (const entry of web.commandSearch) {
      byTargetKind.set(entry.target.kind, (byTargetKind.get(entry.target.kind) ?? 0) + 1);
      expect(entry.keywords.length).toBeGreaterThan(0);
    }
    expect(byTargetKind.get('area')).toBe(7);
    expect(byTargetKind.get('tower-surface')).toBe(15);
    expect(byTargetKind.get('notification-entry')).toBe(1);
    expect(byTargetKind.get('context-drawer')).toBe(1);
    expect(byTargetKind.get('tenant-switcher')).toBe(1);
    const towerEntry = web.commandSearch.find((entry) => entry.commandId === 'tower:goals')!;
    expect(towerEntry.target.ref).toBe('goals');

    // The notification entry (derived from the REAL notifications seam).
    expect(web.notificationEntry.attentionCount).toBe(2);
    expect(web.notificationEntry.latestSubject).toBe('Latest attention');
    expect(web.notificationEntry.latestAt).toBe(T_NOTIF_2);

    // The context drawer: 'none' without a focus.
    expect(web.contextDrawer).toEqual({ focusKind: 'none', focusRef: null, summary: null });

    // The tenant/workspace switcher (the organizations seam).
    expect(web.tenantSwitcher.tenantId).toBe(tenantState);
    expect(web.tenantSwitcher.tenantName).toBe(stateTenant.name);
    expect(web.tenantSwitcher.tenantSlug).toBe(stateTenant.slug);
    expect(web.tenantSwitcher.workspaces).toHaveLength(2);
    expect(web.tenantSwitcher.workspaces.map((workspace) => workspace.label)).toContain(
      'Field Operations',
    );
  });

  it('describes the contextual focus through the drawer (current server state)', async () => {
    const withConversationFocus = await cp.readShellModel(owner, {
      focus: { focusKind: 'conversation', focusRef: conversationState.id },
    });
    expect(withConversationFocus.contextDrawer.focusKind).toBe('conversation');
    expect(withConversationFocus.contextDrawer.focusRef).toBe(conversationState.id);
    expect(withConversationFocus.contextDrawer.summary).toContain('conversation-state');
    expect(withConversationFocus.contextDrawer.summary).toContain('r3');
    const withMissionFocus = await cp.readShellModel(owner, {
      focus: { focusKind: 'mission', focusRef: missionActive.id },
    });
    expect(withMissionFocus.contextDrawer.summary).toContain('mission-state');
    const withWorkFocus = await cp.readShellModel(owner, {
      focus: { focusKind: 'background-work', focusRef: runQueued.id, focusSeam: 'execution-run' },
    });
    expect(withWorkFocus.contextDrawer.summary).toContain('background-work-state');
    await expectCode('invalid_query', () =>
      cp.readShellModel(owner, { focus: { focusKind: 'background-work', focusRef: 'x' } }),
    );
  });

  it('requires a provisioned tenant honestly (tenant_not_found, no fabricated switcher)', async () => {
    await expectCode('tenant_not_found', () => cp.readShellModel(member(tenantErr), {}));
    await expectCode('tenant_not_found', () =>
      cp.readShellModel({ tenantId: newId(), principalId: newId(), authority: [] }, {}),
    );
  });

  it('exports NO domain-mutation primitive — this contract cannot mint domain truth (structural tripwire)', () => {
    const forbidden = [
      'recordMessage',
      'createConversation',
      'createGoal',
      'reviseGoal',
      'archiveGoal',
      'createMission',
      'reviseMission',
      'completeMission',
      'abandonMission',
      'createNotification',
      'registerAgent',
      'submitAgentExecution',
      'runAgentExecution',
      'cancelAgentExecution',
      'createExecutionPlan',
      'recordExecutionRun',
      'provisionTenant',
      'createWorkspace',
      'registerEnvironmentDefinition',
      'acquireFabricLease',
    ];
    const exported = Object.keys(cp);
    for (const name of forbidden) {
      expect(exported).not.toContain(name);
    }
    // The sanctioned operation surface is exactly the 21 semantic-core
    // ops + the pure validation/digest surface + the three adapter
    // doubles + the typed error — NOTHING that mints domain truth.
    const operations = new Set(
      Object.keys(cp).filter(
        (name) => typeof (cp as Record<string, unknown>)[name] === 'function',
      ),
    );
    const expectedOperations = new Set([
      // client sessions
      'getClientSession',
      'listClientSessions',
      'registerClientSession',
      'revokeClientSession',
      // authoritative state
      'readCompanyOverview',
      'readConversationState',
      // background-work inspection
      'getBackgroundWorkItem',
      'listBackgroundWork',
      // platform adapters + capabilities
      'invokePlatformCapability',
      'listPlatformAdapters',
      'probePlatformCapabilities',
      'registerPlatformAdapter',
      'unregisterPlatformAdapter',
      // cross-device handoff
      'closeHandoffSession',
      'getHandoffSession',
      'listHandoffEvidence',
      'listHandoffSessions',
      'openHandoffSession',
      'recordHandoff',
      'resumeHandoff',
      // the shell read model
      'readShellModel',
      // the typed error + the pure validation/digest surface
      'CrossPlatformError',
      'assertCrossPlatformTenantContext',
      'canonicalJson',
      'digestOf',
      'isBackgroundWorkPhase',
      'isBackgroundWorkSeam',
      'isCapabilityDomain',
      'isClientSessionState',
      'isHandoffEvidenceKind',
      'isHandoffFocusKind',
      'isPlatformKind',
      'isProductAreaId',
      'isTowerSurfaceSlug',
      'isUuid',
      // the deterministic platform adapter doubles
      'createWebPlatformAdapter',
      'createDesktopPlatformAdapter',
      'createMobilePlatformAdapter',
    ]);
    expect(operations).toEqual(expectedOperations);
  });
});
