// Implementation of the cross-platform module's public operations (see
// contract.ts).
//
// W139 — Cross-Platform Aurum Product (spec/work-items/WORK-ITEM-CATALOG.md
// §W139): the CROSS-PLATFORM SEMANTIC CORE. Web is the CANONICAL client,
// Desktop (Tauri 2) the POWER client, Mobile (Expo/React Native) the FIELD
// client — and every one of them consumes THIS surface. The module's law,
// baked structurally:
//
//   * SERVER-SIDE STATE IS AUTHORITATIVE; CLIENTS ARE PROJECTIONS (the
//     frozen W131 conclusion). Every state read is a live composition
//     over the owning seams' contracts (conversations W029, goals W008,
//     missions W011, agent-exchange W136, execution-fabric W137,
//     notifications, organizations) — the platform kind of the asking
//     session NEVER participates in state computation. This module
//     persists only client sessions and handoff evidence, never domain
//     truth: there is no operation here that could mint a divergent
//     authority (test-locked).
//   * PLATFORM-NATIVE CAPABILITIES ARE ADAPTERS. The in-memory adapter
//     registry is RUNTIME wiring, never domain state (the W137 ruling):
//     register/unregister touch no table, and with ZERO adapters
//     registered every domain operation behaves identically (the
//     platform-removal neutrality clause, test-locked).
//   * HANDOFFS ARE EVIDENCE. The working context is frozen at open, moves
//     VERBATIM between devices, restores EXACTLY on resumption, and the
//     trail is append-only (storage-trigger enforced). Resumption
//     re-projects the focus from CURRENT server state — the frozen
//     ContinuityHandoffSemantics literals: reprojection
//     'from-server-state', authorityTransfer 'none', payload
//     'projection-refs-only'. A stale client projection is DISCARDED and
//     the discard recorded (resolution 'server-state-wins', the frozen
//     single-member vocabulary).
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): PGlite is
// single-connection, so a base-connection read inside an open
// db.transaction(...) starves the embedded database. EVERY cross-module
// read (all seven seams above) and every evidence gate therefore runs
// BEFORE the transaction opens; each mutation then keeps its spine
// update + evidence append atomic in ONE transaction whose statements
// touch only this module's tables:
//
//   * registerClientSession — validation + the future-expiry gate, then a
//     SINGLE append (one INSERT — atomic by itself).
//   * revokeClientSession — uniform not-found + not-yet-revoked
//     pre-checks on the base connection, then ONE transaction re-checking
//     the one-way transition under a FOR UPDATE row lock.
//   * openHandoffSession — every gate first (the acting client session
//     readable, tenant-owned, ACTIVE and same-principal), then ONE
//     transaction appending the spine + the 'session-opened' evidence.
//   * recordHandoff / resumeHandoff / closeHandoffSession — every gate
//     first (session readable + open; the receiving session readable,
//     ACTIVE, same-principal and distinct; the focus reprojection
//     computed from CURRENT server state on the base connection), then
//     ONE transaction re-checking the open state under a FOR UPDATE row
//     lock before the spine update + evidence appends.
//
// Adapter I/O (probe/invoke) is ALWAYS outside every transaction — the
// W137 law; capability operations open no transaction at all.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by newId(); semantic
// timestamps come from the injectable clock and are never
// caller-supplied; principals are system-captured from the explicit
// TenantContext; every statement is scoped by tenant (ADR-0001) —
// cross-tenant access is indistinguishable from missing records
// (uniform typed not-found, no existence leak).
//
// Deterministic orders (test-locked): client sessions newest-issued
// first (issued_at DESC, id DESC); handoff sessions most-recently-active
// first (last_active_at DESC, id DESC); the evidence trail in timeline
// order (recorded_at ASC, id ASC); the background-work feed by latest
// activity (updated_at DESC, work_id DESC); the shell areas in the W057
// plan order; command entries by their declaration order.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import type {
  ClientPlatformKind,
  CompanyStateProjectionRef,
} from '@/modules/execution/contract';
import {
  getConversation,
  listMessages,
  ConversationsError,
} from '@/modules/conversations/contract';
import type { Conversation, Message } from '@/modules/conversations/contract';
import { listGoals } from '@/modules/goals/contract';
import { getMission, listMissions, MissionsError } from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import {
  listExecutionPlans,
  listExecutionRuns,
} from '@/modules/agent-exchange/contract';
import type { ExecutionRun } from '@/modules/agent-exchange/contract';
import { listFabricLeases } from '@/modules/execution-fabric/contract';
import type { FabricLease } from '@/modules/execution-fabric/contract';
import { listNotifications } from '@/modules/notifications/contract';
import { getTenant, listWorkspaces, OrganizationsError } from '@/modules/organizations/contract';
import { CrossPlatformError } from './errors';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  TOWER_SURFACE_SLUGS,
  assertCrossPlatformTenantContext,
  digestOf,
  validateGetBackgroundWorkItemInput,
  validateHandoffSessionRefInput,
  validateInvokePlatformCapabilityInput,
  validateListBackgroundWorkQuery,
  validateListClientSessionsQuery,
  validateListHandoffEvidenceQuery,
  validateListHandoffSessionsQuery,
  validateOpenHandoffSessionInput,
  validateReadCompanyOverviewQuery,
  validateReadConversationStateQuery,
  validateReadShellModelQuery,
  validateRecordHandoffInput,
  validateRegisterClientSessionInput,
  validateResumeHandoffInput,
  validateSessionRefInput,
} from './validation';
import type {
  BackgroundWorkItem,
  BackgroundWorkPhase,
  BackgroundWorkSeam,
  ClientSession,
  CompanyGoalSummary,
  CompanyMissionSummary,
  CompanyOverviewProjection,
  ConversationStateProjection,
  HandoffEvidence,
  HandoffEvidenceKind,
  HandoffResumption,
  HandoffSession,
  HandoffWorkingContext,
  PlatformAdapter,
  PlatformAdapterDescriptor,
  PlatformCapabilityReceipt,
  ProductAreaId,
  ProductShellModel,
  ShellArea,
  ShellCommandEntry,
  ShellNavigationState,
} from './types';

// ---------------------------------------------------------------------------
// Row types + mappers (own tables only)
// ---------------------------------------------------------------------------

interface ClientSessionRow extends DbRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  platform: string;
  device_label: string | null;
  issued_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
}

interface HandoffSessionRow extends DbRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  focus_kind: string;
  focus_ref: string;
  focus_seam: string | null;
  draft: string | null;
  navigation_state: unknown;
  origin_client_session_id: string;
  active_client_session_id: string;
  open_on_platform: string;
  status: string;
  anchor_revision: number;
  opened_at: Date | string;
  last_active_at: Date | string;
  closed_at: Date | string | null;
  closed_by: string | null;
}

interface HandoffEvidenceRow extends DbRow {
  id: string;
  tenant_id: string;
  handoff_session_id: string;
  evidence_kind: string;
  actor: string;
  client_session_id: string | null;
  from_platform: string | null;
  to_platform: string | null;
  context_snapshot: unknown;
  projection_revision: number | null;
  projection_digest: string | null;
  discarded_client_revision: number | null;
  resolution: string | null;
  recorded_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isoRequired(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function platformOf(value: string): ClientPlatformKind {
  return value as ClientPlatformKind;
}

function mapClientSession(row: ClientSessionRow): ClientSession {
  const revokedAt = iso(row.revoked_at);
  const expiresAt = iso(row.expires_at);
  const state =
    revokedAt !== null ? 'revoked' : expiresAt !== null && Date.parse(expiresAt) <= Date.now() ? 'expired' : 'active';
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    platform: platformOf(row.platform),
    deviceLabel: row.device_label,
    issuedAt: isoRequired(row.issued_at),
    lastSeenAt: isoRequired(row.last_seen_at),
    expiresAt,
    revokedAt,
    state,
  };
}

function navigationOf(value: unknown): ShellNavigationState {
  const object = (value ?? {}) as Record<string, unknown>;
  return {
    area: (typeof object.area === 'string' ? object.area : 'chat') as ProductAreaId,
    towerSurface: typeof object.towerSurface === 'string' ? object.towerSurface : null,
    focusRef: typeof object.focusRef === 'string' ? object.focusRef : null,
  };
}

function contextOf(row: HandoffSessionRow): HandoffWorkingContext {
  return {
    focusKind: row.focus_kind as HandoffWorkingContext['focusKind'],
    focusRef: row.focus_ref,
    ...(row.focus_seam === null ? {} : { focusSeam: row.focus_seam as BackgroundWorkSeam }),
    draft: row.draft,
    navigation: navigationOf(row.navigation_state),
  };
}

function mapHandoffSession(row: HandoffSessionRow): HandoffSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    context: contextOf(row),
    originClientSessionId: row.origin_client_session_id,
    activeClientSessionId: row.active_client_session_id,
    openOnPlatform: platformOf(row.open_on_platform),
    status: row.status === 'closed' ? 'closed' : 'open',
    anchorRevision: row.anchor_revision,
    openedAt: isoRequired(row.opened_at),
    lastActiveAt: isoRequired(row.last_active_at),
    closedAt: iso(row.closed_at),
  };
}

function mapHandoffEvidence(row: HandoffEvidenceRow): HandoffEvidence {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    handoffSessionId: row.handoff_session_id,
    kind: row.evidence_kind as HandoffEvidenceKind,
    actor: row.actor,
    clientSessionId: row.client_session_id,
    fromPlatform: row.from_platform === null ? null : platformOf(row.from_platform),
    toPlatform: row.to_platform === null ? null : platformOf(row.to_platform),
    contextSnapshot: snapshotOf(row.context_snapshot),
    projectionRevision: row.projection_revision,
    projectionDigest: row.projection_digest,
    discardedClientRevision: row.discarded_client_revision,
    resolution: row.resolution === null ? null : 'server-state-wins',
    recordedAt: isoRequired(row.recorded_at),
  };
}

/** The stored jsonb context snapshot, re-typed (round-trips contextJsonOf). */
function snapshotOf(value: unknown): HandoffWorkingContext | null {
  if (value === null || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  return {
    focusKind: object.focusKind as HandoffWorkingContext['focusKind'],
    focusRef: typeof object.focusRef === 'string' ? object.focusRef : '',
    ...(typeof object.focusSeam === 'string'
      ? { focusSeam: object.focusSeam as BackgroundWorkSeam }
      : {}),
    draft: typeof object.draft === 'string' ? object.draft : null,
    navigation: navigationOf(object.navigation),
  };
}

// ---------------------------------------------------------------------------
// The platform adapter registry (in-memory runtime wiring, NEVER domain
// state — the W137 ruling; register/unregister touch no table)
// ---------------------------------------------------------------------------

const adapterRegistry = new Map<ClientPlatformKind, PlatformAdapter>();

/**
 * Registers the platform adapter for its platform kind. ONE registration
 * per platform kind keeps resolution deterministic (a second registration
 * for the same kind is a typed error, not a silent override). The receipt
 * is the adapter's PROBED descriptor — never assumed (the honest-
 * descriptor law).
 */
export async function registerPlatformAdapter(
  adapter: PlatformAdapter,
): Promise<PlatformAdapterDescriptor> {
  if (adapterRegistry.has(adapter.platform)) {
    throw new CrossPlatformError(
      'adapter_already_registered',
      `a platform adapter is already registered for '${adapter.platform}'`,
    );
  }
  const descriptor = await adapter.probe();
  adapterRegistry.set(adapter.platform, adapter);
  return descriptor;
}

/**
 * UNREGISTERS a platform adapter — the platform-removal operation. It
 * deliberately returns nothing and touches no table: removing every
 * adapter leaves every domain operation (state reads, background-work
 * inspection, handoffs, the shell read model) byte-identical (the
 * acceptance clause, test-locked). Only capability probing/invocation
 * surfaces the removal, as a typed `adapter_not_found`.
 */
export function unregisterPlatformAdapter(adapterId: string): void {
  for (const [platform, adapter] of adapterRegistry) {
    if (adapter.adapterId === adapterId) {
      adapterRegistry.delete(platform);
      return;
    }
  }
}

/** Lists the registered adapters' descriptors (probed live). */
export async function listPlatformAdapters(): Promise<PlatformAdapterDescriptor[]> {
  const descriptors: PlatformAdapterDescriptor[] = [];
  for (const adapter of adapterRegistry.values()) {
    descriptors.push(await adapter.probe());
  }
  return descriptors;
}

/** Probes the adapter registered for the platform (typed not-found when absent). */
export async function probePlatformCapabilities(
  platform: ClientPlatformKind,
): Promise<PlatformAdapterDescriptor> {
  const adapter = adapterRegistry.get(platform);
  if (adapter === undefined) {
    throw new CrossPlatformError(
      'adapter_not_found',
      `no platform adapter is registered for '${platform}'`,
    );
  }
  return adapter.probe();
}

/**
 * Invokes one platform-native capability through the registered adapter.
 * The adapter is probed first (the honest-descriptor law): an unsupported
 * domain is an EXPLICIT typed refusal, never a fabricated success; an
 * adapter throw is mapped to the typed `capability_invocation_failed` —
 * honest failure evidence. No transaction ever wraps adapter I/O.
 */
export async function invokePlatformCapability(
  ctx: TenantContext,
  input: unknown,
): Promise<PlatformCapabilityReceipt> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateInvokePlatformCapabilityInput(input);
  const adapter = adapterRegistry.get(valid.platform);
  if (adapter === undefined) {
    throw new CrossPlatformError(
      'adapter_not_found',
      `no platform adapter is registered for '${valid.platform}'`,
    );
  }
  const descriptor = await adapter.probe();
  const declaration = descriptor.capabilities.find(
    (entry) => entry.domain === valid.domain,
  );
  if (declaration === undefined || !declaration.supported) {
    throw new CrossPlatformError(
      'capability_not_supported',
      `the '${valid.platform}' platform adapter does not support '${valid.domain}'`,
    );
  }
  try {
    return await adapter.invoke({ domain: valid.domain, input: valid.input });
  } catch (error) {
    throw new CrossPlatformError(
      'capability_invocation_failed',
      `the '${valid.platform}' platform adapter failed serving '${valid.domain}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Client sessions
// ---------------------------------------------------------------------------

/** Registers one client session (server-issued identity; never client-minted). */
export async function registerClientSession(
  ctx: TenantContext,
  input: unknown,
): Promise<ClientSession> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateRegisterClientSessionInput(input);
  if (valid.expiresAt !== null && Date.parse(valid.expiresAt) <= Date.parse(now().toISOString())) {
    throw new CrossPlatformError(
      'invalid_session_input',
      'expiresAt must be in the future at registration',
    );
  }
  const id = newId();
  const timestamp = now().toISOString();
  const db = getDb();
  const result = await db.query<ClientSessionRow>(
    `INSERT INTO client_sessions
         (id, tenant_id, principal_id, platform, device_label, issued_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
       RETURNING *`,
    [id, ctx.tenantId, ctx.principalId, valid.platform, valid.deviceLabel, timestamp, valid.expiresAt],
  );
  return mapClientSession(result.rows[0]!);
}

async function findSessionRow(
  db: Queryable,
  ctx: TenantContext,
  clientSessionId: string,
  forUpdate: boolean,
): Promise<ClientSessionRow | null> {
  const result = await db.query<ClientSessionRow>(
    `SELECT * FROM client_sessions
       WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, clientSessionId],
  );
  return result.rows[0] ?? null;
}

async function loadSessionRow(
  db: Queryable,
  ctx: TenantContext,
  clientSessionId: string,
  forUpdate = false,
): Promise<ClientSessionRow> {
  const row = await findSessionRow(db, ctx, clientSessionId, forUpdate);
  if (row === null) {
    throw new CrossPlatformError(
      'session_not_found',
      `no client session '${clientSessionId}' exists in this tenant`,
    );
  }
  return row;
}

/** Loads a client session and enforces it is ACTIVE (not expired/revoked). */
async function loadActiveSessionRow(
  ctx: TenantContext,
  clientSessionId: string,
): Promise<ClientSessionRow> {
  const row = await loadSessionRow(getDb(), ctx, clientSessionId);
  const mapped = mapClientSession(row);
  if (mapped.state !== 'active') {
    throw new CrossPlatformError(
      'session_not_active',
      `client session '${clientSessionId}' is ${mapped.state}`,
    );
  }
  return row;
}

/** Touches the acting session's last-seen stamp (single UPDATE, base connection). */
async function touchSession(ctx: TenantContext, clientSessionId: string): Promise<void> {
  await getDb().query(
    `UPDATE client_sessions SET last_seen_at = $1
       WHERE tenant_id = $2 AND id = $3 AND revoked_at IS NULL`,
    [now().toISOString(), ctx.tenantId, clientSessionId],
  );
}

/** Reads one client session (tenant-scoped; uniform typed not-found). */
export async function getClientSession(
  ctx: TenantContext,
  input: unknown,
): Promise<ClientSession> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateSessionRefInput(input, 'invalid_query');
  const row = await loadSessionRow(getDb(), ctx, valid.clientSessionId);
  return mapClientSession(row);
}

/** Lists the tenant's client sessions (newest-issued first). */
export async function listClientSessions(
  ctx: TenantContext,
  query: unknown,
): Promise<ClientSession[]> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateListClientSessionsQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = 'SELECT * FROM client_sessions WHERE tenant_id = $1';
  if (valid.platform !== undefined) {
    params.push(valid.platform);
    sql += ` AND platform = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY issued_at DESC, id DESC LIMIT $${params.length}`;
  const result = await getDb().query<ClientSessionRow>(sql, params);
  const sessions = result.rows.map(mapClientSession);
  if (valid.state === undefined) return sessions;
  return sessions.filter((session) => session.state === valid.state);
}

/** Revokes a client session — the one-way transition (FOR UPDATE re-check). */
export async function revokeClientSession(
  ctx: TenantContext,
  input: unknown,
): Promise<ClientSession> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateSessionRefInput(input, 'invalid_session_input');
  const db = getDb();
  // Uniform not-found pre-check on the base connection.
  await loadSessionRow(db, ctx, valid.clientSessionId);
  const timestamp = now().toISOString();
  return db.transaction(async (tx) => {
    const row = await loadSessionRow(tx, ctx, valid.clientSessionId, true);
    if (row.revoked_at !== null) {
      throw new CrossPlatformError(
        'session_already_revoked',
        `client session '${valid.clientSessionId}' is already revoked (the transition is one-way)`,
      );
    }
    const result = await tx.query<ClientSessionRow>(
      `UPDATE client_sessions
         SET revoked_at = $1, revoked_by = $2, last_seen_at = $1
       WHERE tenant_id = $3 AND id = $4
       RETURNING *`,
      [timestamp, ctx.principalId, ctx.tenantId, valid.clientSessionId],
    );
    return mapClientSession(result.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// The authoritative state projections (client-agnostic reads)
// ---------------------------------------------------------------------------

/**
 * Reads the authoritative conversation state — the conversations seam's
 * own records, bound to a content-addressed projection ref. The read is
 * CLIENT-AGNOSTIC by construction: no platform parameter exists.
 */
export async function readConversationState(
  ctx: TenantContext,
  query: unknown,
): Promise<ConversationStateProjection> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateReadConversationStateQuery(query);
  let conversation: Conversation;
  let messages: Message[];
  try {
    conversation = await getConversation(ctx, valid.conversationId);
    messages = await listMessages(ctx, {
      conversationId: valid.conversationId,
      order: 'asc',
      limit: valid.messageLimit,
    });
  } catch (error) {
    if (error instanceof ConversationsError) {
      throw new CrossPlatformError(
        'conversation_not_found',
        `no conversation '${valid.conversationId}' is readable in this tenant`,
      );
    }
    throw error;
  }
  const payload = {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      messageCount: conversation.messageCount,
      lastMessageAt: conversation.lastMessageAt,
    },
    messages: messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      channel: message.channel,
      actor: message.actor,
      payload: message.payload,
      sentAt: message.sentAt,
      recordedAt: message.recordedAt,
    })),
  };
  return {
    projectionRef: {
      projectionKind: 'conversation-state',
      targetId: conversation.id,
      tenantId: ctx.tenantId,
      revision: conversation.messageCount,
      digest: digestOf(payload),
    },
    conversation,
    messages,
  };
}

/**
 * Reads the authoritative company overview — current goals and missions
 * as compact typed summaries, content-addressed. Client-agnostic by
 * construction.
 */
export async function readCompanyOverview(
  ctx: TenantContext,
  query: unknown,
): Promise<CompanyOverviewProjection> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateReadCompanyOverviewQuery(query);
  const goals = await listGoals(ctx, { limit: valid.goalLimit });
  const missions = await listMissions(ctx, { limit: valid.missionLimit });
  const goalSummaries: CompanyGoalSummary[] = goals.map((goal) => ({
    goalId: goal.id,
    title: goal.content.title,
    status: goal.content.status,
    priority: goal.content.priority,
    version: goal.version,
    updatedAt: goal.updatedAt,
  }));
  const missionSummaries: CompanyMissionSummary[] = missions.map((mission) => ({
    missionId: mission.id,
    title: mission.content.title,
    status: mission.content.status,
    urgency: mission.content.urgency,
    version: mission.version,
    updatedAt: mission.updatedAt,
  }));
  const payload = { goals: goalSummaries, missions: missionSummaries };
  return {
    projectionRef: {
      projectionKind: 'company-overview',
      targetId: ctx.tenantId,
      tenantId: ctx.tenantId,
      revision: goalSummaries.length + missionSummaries.length,
      digest: digestOf(payload),
    },
    goals: goalSummaries,
    missions: missionSummaries,
  };
}

// ---------------------------------------------------------------------------
// The background-work feed (inspection everywhere)
// ---------------------------------------------------------------------------

/** The frozen seam-status → phase mapping (see types.ts for the table). */
const MISSION_PHASES: Record<string, BackgroundWorkPhase> = {
  active: 'in-flight',
  completed: 'succeeded',
  abandoned: 'cancelled',
};

const RUN_PHASES: Record<string, BackgroundWorkPhase> = {
  awaiting_approval: 'awaiting-decision',
  queued: 'in-flight',
  succeeded: 'succeeded',
  failed: 'failed',
  refused: 'failed',
  cancelled: 'cancelled',
};

const LEASE_PHASES: Record<string, BackgroundWorkPhase> = {
  preparing: 'in-flight',
  live: 'in-flight',
  suspended: 'suspended',
  lost: 'lost',
  released: 'succeeded',
  cancelled: 'cancelled',
  failed: 'failed',
};

function latestOf(...stamps: Array<string | null>): string {
  let latest = stamps[0] ?? '';
  for (const stamp of stamps) {
    if (stamp !== null && Date.parse(stamp) > Date.parse(latest)) latest = stamp;
  }
  return latest;
}

function missionItem(mission: Mission): BackgroundWorkItem {
  return {
    workId: mission.id,
    seam: 'mission',
    tenantId: mission.tenantId,
    title: mission.content.title,
    phase: MISSION_PHASES[mission.content.status] ?? 'in-flight',
    seamStatus: mission.content.status,
    parentRef: null,
    recordedAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

function runItem(
  plan: { id: string; objective: string },
  run: ExecutionRun,
): BackgroundWorkItem {
  return {
    workId: run.id,
    seam: 'execution-run',
    tenantId: run.tenantId,
    title: `${plan.objective} — ${run.taskKey}`,
    phase: RUN_PHASES[run.executionStatus] ?? 'in-flight',
    seamStatus: run.executionStatus,
    parentRef: plan.id,
    recordedAt: run.recordedAt,
    updatedAt: run.executionCompletedAt ?? run.recordedAt,
  };
}

function leaseItem(lease: FabricLease): BackgroundWorkItem {
  return {
    workId: lease.id,
    seam: 'fabric-lease',
    tenantId: lease.tenantId,
    title: `${lease.definitionKey} — ${lease.taskKey}`,
    phase: LEASE_PHASES[lease.status] ?? 'in-flight',
    seamStatus: lease.status,
    parentRef: lease.definitionId,
    recordedAt: lease.createdAt,
    updatedAt: latestOf(
      lease.createdAt,
      lease.openedAt,
      lease.takenOverAt,
      lease.handbackAt,
      lease.lostAt,
      lease.recoveredAt,
      lease.releasedAt,
      lease.failedAt,
    ),
  };
}

/**
 * Collects the background-work feed across the seams — what the system is
 * doing, projected identically for any client kind. Runs are gathered per
 * plan (the exchange's reads are plan-scoped), bounded to the tenant's
 * most recent 50 plans × 50 runs each.
 */
export async function listBackgroundWork(
  ctx: TenantContext,
  query: unknown,
): Promise<BackgroundWorkItem[]> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateListBackgroundWorkQuery(query);
  const items: BackgroundWorkItem[] = [];
  if (valid.seam === undefined || valid.seam === 'mission') {
    const missions = await listMissions(ctx, { limit: MAX_LIST_LIMIT });
    for (const mission of missions) items.push(missionItem(mission));
  }
  if (valid.seam === undefined || valid.seam === 'execution-run') {
    const plans = await listExecutionPlans(ctx, { limit: MAX_LIST_LIMIT });
    for (const plan of plans) {
      const runs = await listExecutionRuns(ctx, { planId: plan.id, limit: MAX_LIST_LIMIT });
      for (const run of runs) items.push(runItem(plan, run));
    }
  }
  if (valid.seam === undefined || valid.seam === 'fabric-lease') {
    const leases = await listFabricLeases(ctx, { limit: MAX_LIST_LIMIT });
    for (const lease of leases) items.push(leaseItem(lease));
  }
  const filtered =
    valid.phase === undefined ? items : items.filter((item) => item.phase === valid.phase);
  filtered.sort((a, b) => {
    const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return b.workId.localeCompare(a.workId);
  });
  return filtered.slice(0, valid.limit);
}

/** Reads one background-work item by seam + ref (uniform typed not-found). */
export async function getBackgroundWorkItem(
  ctx: TenantContext,
  input: unknown,
): Promise<BackgroundWorkItem> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateGetBackgroundWorkItemInput(input);
  if (valid.seam === 'mission') {
    let mission: Mission;
    try {
      mission = await getMission(ctx, valid.workRef);
    } catch (error) {
      if (error instanceof MissionsError) {
        throw new CrossPlatformError(
          'work_item_not_found',
          `no background work '${valid.workRef}' exists on the mission seam`,
        );
      }
      throw error;
    }
    return missionItem(mission);
  }
  const items = await listBackgroundWork(ctx, { seam: valid.seam, limit: MAX_LIST_LIMIT });
  const found = items.find((item) => item.workId === valid.workRef);
  if (found === undefined) {
    throw new CrossPlatformError(
      'work_item_not_found',
      `no background work '${valid.workRef}' exists on the ${valid.seam} seam`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Focus reprojection (the from-server-state re-projection of a handoff)
// ---------------------------------------------------------------------------

/**
 * Computes the CURRENT server-side projection of a handoff focus — the
 * revision + digest the receiving device re-projects against. This is
 * the mechanical meaning of the frozen reprojection literal
 * 'from-server-state': nothing about the client participates.
 */
async function computeFocusProjection(
  ctx: TenantContext,
  context: HandoffWorkingContext,
): Promise<CompanyStateProjectionRef> {
  if (context.focusKind === 'conversation') {
    const state = await readConversationState(ctx, {
      conversationId: context.focusRef,
      messageLimit: DEFAULT_LIST_LIMIT,
    });
    return state.projectionRef;
  }
  if (context.focusKind === 'mission') {
    let mission: Mission;
    try {
      mission = await getMission(ctx, context.focusRef);
    } catch (error) {
      if (error instanceof MissionsError) {
        throw new CrossPlatformError(
          'mission_not_found',
          `no mission '${context.focusRef}' is readable in this tenant`,
        );
      }
      throw error;
    }
    return {
      projectionKind: 'mission-state',
      targetId: mission.id,
      tenantId: ctx.tenantId,
      revision: mission.version,
      digest: digestOf({
        missionId: mission.id,
        title: mission.content.title,
        status: mission.content.status,
        urgency: mission.content.urgency,
        version: mission.version,
        updatedAt: mission.updatedAt,
      }),
    };
  }
  const item = await getBackgroundWorkItem(ctx, {
    seam: context.focusSeam!,
    workRef: context.focusRef,
  });
  return {
    projectionKind: 'background-work-state',
    targetId: item.workId,
    tenantId: ctx.tenantId,
    revision: 1,
    digest: digestOf({
      workId: item.workId,
      seam: item.seam,
      title: item.title,
      phase: item.phase,
      seamStatus: item.seamStatus,
      updatedAt: item.updatedAt,
    }),
  };
}

// ---------------------------------------------------------------------------
// Cross-device handoff
// ---------------------------------------------------------------------------

async function findHandoffRow(
  db: Queryable,
  ctx: TenantContext,
  handoffSessionId: string,
  forUpdate: boolean,
): Promise<HandoffSessionRow | null> {
  const result = await db.query<HandoffSessionRow>(
    `SELECT * FROM handoff_sessions
       WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, handoffSessionId],
  );
  return result.rows[0] ?? null;
}

async function loadHandoffRow(
  db: Queryable,
  ctx: TenantContext,
  handoffSessionId: string,
  forUpdate = false,
): Promise<HandoffSessionRow> {
  const row = await findHandoffRow(db, ctx, handoffSessionId, forUpdate);
  if (row === null) {
    throw new CrossPlatformError(
      'handoff_not_found',
      `no handoff session '${handoffSessionId}' exists in this tenant`,
    );
  }
  return row;
}

interface EvidenceAppend {
  kind: HandoffEvidenceKind;
  actor: string;
  clientSessionId: string | null;
  fromPlatform: ClientPlatformKind | null;
  toPlatform: ClientPlatformKind | null;
  contextSnapshot: HandoffWorkingContext | null;
  projectionRevision: number | null;
  projectionDigest: string | null;
  discardedClientRevision: number | null;
  resolution: 'server-state-wins' | null;
  recordedAt: string;
}

async function appendEvidence(
  tx: Queryable,
  ctx: TenantContext,
  handoffSessionId: string,
  append: EvidenceAppend,
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO handoff_evidence
         (id, tenant_id, handoff_session_id, evidence_kind, actor, client_session_id,
          from_platform, to_platform, context_snapshot, projection_revision,
          projection_digest, discarded_client_revision, resolution, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      ctx.tenantId,
      handoffSessionId,
      append.kind,
      append.actor,
      append.clientSessionId,
      append.fromPlatform,
      append.toPlatform,
      append.contextSnapshot === null ? null : JSON.stringify(contextJsonOf(append.contextSnapshot)),
      append.projectionRevision,
      append.projectionDigest,
      append.discardedClientRevision,
      append.resolution,
      append.recordedAt,
    ],
  );
  return id;
}

/** The stored jsonb shape of a working context (round-trips through contextOf). */
function contextJsonOf(context: HandoffWorkingContext): Record<string, unknown> {
  return {
    focusKind: context.focusKind,
    focusRef: context.focusRef,
    ...(context.focusSeam === undefined ? {} : { focusSeam: context.focusSeam }),
    draft: context.draft,
    navigation: {
      area: context.navigation.area,
      towerSurface: context.navigation.towerSurface ?? null,
      focusRef: context.navigation.focusRef ?? null,
    },
  };
}

/** Opens a handoff session: freezes the working context + first evidence. */
export async function openHandoffSession(
  ctx: TenantContext,
  input: unknown,
): Promise<HandoffSession> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateOpenHandoffSessionInput(input);
  // GATES (base connection, before any transaction): the acting client
  // session exists, is tenant-owned, ACTIVE and same-principal.
  const sessionRow = await loadActiveSessionRow(ctx, valid.clientSessionId);
  if (sessionRow.principal_id !== ctx.principalId) {
    throw new CrossPlatformError(
      'session_principal_mismatch',
      'the acting client session belongs to a different principal',
    );
  }
  // The focus must resolve against CURRENT server state (the honest-focus
  // gate: a handoff of a focus that does not exist is refused, exactly).
  // The SAME projection binds the 'session-opened' evidence — computed on
  // the base connection BEFORE the transaction (the W134 law).
  const projection = await computeFocusProjection(ctx, valid.context);
  await touchSession(ctx, valid.clientSessionId);
  const id = newId();
  const timestamp = now().toISOString();
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO handoff_sessions
         (id, tenant_id, principal_id, focus_kind, focus_ref, focus_seam, draft,
          navigation_state, origin_client_session_id, active_client_session_id,
          open_on_platform, status, anchor_revision, opened_at, last_active_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, 'open', 1, $11, $11)`,
      [
        id,
        ctx.tenantId,
        ctx.principalId,
        valid.context.focusKind,
        valid.context.focusRef,
        valid.context.focusSeam ?? null,
        valid.context.draft,
        JSON.stringify(contextJsonOf(valid.context)),
        valid.clientSessionId,
        sessionRow.platform,
        timestamp,
      ],
    );
    await appendEvidence(tx, ctx, id, {
      kind: 'session-opened',
      actor: ctx.principalId,
      clientSessionId: valid.clientSessionId,
      fromPlatform: platformOf(sessionRow.platform),
      toPlatform: null,
      contextSnapshot: valid.context,
      projectionRevision: projection.revision,
      projectionDigest: projection.digest,
      discardedClientRevision: null,
      resolution: null,
      recordedAt: timestamp,
    });
    const row = await findHandoffRow(tx, ctx, id, false);
    return mapHandoffSession(row!);
  });
}

/** Records a handoff: the session moves to the receiving device (verbatim context). */
export async function recordHandoff(
  ctx: TenantContext,
  input: unknown,
): Promise<HandoffSession> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateRecordHandoffInput(input);
  // GATES (base connection): the session is readable + open; the receiving
  // session is readable, ACTIVE, same-principal and DISTINCT.
  const spineRow = await loadHandoffRow(getDb(), ctx, valid.handoffSessionId);
  if (spineRow.status !== 'open') {
    throw new CrossPlatformError(
      'handoff_not_open',
      `handoff session '${valid.handoffSessionId}' is closed`,
    );
  }
  const toRow = await loadActiveSessionRow(ctx, valid.toClientSessionId);
  if (toRow.principal_id !== spineRow.principal_id) {
    throw new CrossPlatformError(
      'session_principal_mismatch',
      'the receiving client session belongs to a different principal',
    );
  }
  if (valid.toClientSessionId === spineRow.active_client_session_id) {
    throw new CrossPlatformError(
      'handoff_same_session',
      'the receiving session already holds this handoff session (a handoff must move devices)',
    );
  }
  // The focus reprojection from CURRENT server state (before the transaction).
  const context = contextOf(spineRow);
  const projection = await computeFocusProjection(ctx, context);
  await touchSession(ctx, valid.toClientSessionId);
  const timestamp = now().toISOString();
  const db = getDb();
  return db.transaction(async (tx) => {
    // FOR UPDATE staleness re-check: a racing close owns the terminal state.
    const locked = await loadHandoffRow(tx, ctx, valid.handoffSessionId, true);
    if (locked.status !== 'open') {
      throw new CrossPlatformError(
        'handoff_not_open',
        `handoff session '${valid.handoffSessionId}' is closed`,
      );
    }
    await tx.query(
      `UPDATE handoff_sessions
         SET active_client_session_id = $1, open_on_platform = $2,
             last_active_at = $3, anchor_revision = anchor_revision + 1
       WHERE tenant_id = $4 AND id = $5`,
      [valid.toClientSessionId, toRow.platform, timestamp, ctx.tenantId, valid.handoffSessionId],
    );
    await appendEvidence(tx, ctx, valid.handoffSessionId, {
      kind: 'handoff-recorded',
      actor: ctx.principalId,
      clientSessionId: valid.toClientSessionId,
      fromPlatform: platformOf(spineRow.open_on_platform),
      toPlatform: platformOf(toRow.platform),
      contextSnapshot: context,
      projectionRevision: projection.revision,
      projectionDigest: projection.digest,
      discardedClientRevision: null,
      resolution: null,
      recordedAt: timestamp,
    });
    const row = await findHandoffRow(tx, ctx, valid.handoffSessionId, false);
    return mapHandoffSession(row!);
  });
}

/**
 * Resumes a handoff on the receiving device: restores the working context
 * VERBATIM and re-projects the focus from CURRENT server state. A stale
 * client revision is discarded and the discard recorded as evidence
 * (resolution 'server-state-wins').
 */
export async function resumeHandoff(
  ctx: TenantContext,
  input: unknown,
): Promise<HandoffResumption> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateResumeHandoffInput(input);
  // GATES (base connection).
  const spineRow = await loadHandoffRow(getDb(), ctx, valid.handoffSessionId);
  if (spineRow.status !== 'open') {
    throw new CrossPlatformError(
      'handoff_not_open',
      `handoff session '${valid.handoffSessionId}' is closed`,
    );
  }
  const sessionRow = await loadActiveSessionRow(ctx, valid.clientSessionId);
  if (sessionRow.principal_id !== spineRow.principal_id) {
    throw new CrossPlatformError(
      'session_principal_mismatch',
      'the resuming client session belongs to a different principal',
    );
  }
  const context = contextOf(spineRow);
  // The re-projection from CURRENT server state (before the transaction).
  const projection = await computeFocusProjection(ctx, context);
  const stale =
    valid.clientRevision !== null && valid.clientRevision !== projection.revision;
  await touchSession(ctx, valid.clientSessionId);
  const timestamp = now().toISOString();
  const db = getDb();
  const { session, conflictId, recordedAt } = await db.transaction(async (tx) => {
    // FOR UPDATE staleness re-check.
    const locked = await loadHandoffRow(tx, ctx, valid.handoffSessionId, true);
    if (locked.status !== 'open') {
      throw new CrossPlatformError(
        'handoff_not_open',
        `handoff session '${valid.handoffSessionId}' is closed`,
      );
    }
    await tx.query(
      `UPDATE handoff_sessions
         SET active_client_session_id = $1, open_on_platform = $2,
             last_active_at = $3, anchor_revision = anchor_revision + 1
       WHERE tenant_id = $4 AND id = $5`,
      [valid.clientSessionId, sessionRow.platform, timestamp, ctx.tenantId, valid.handoffSessionId],
    );
    await appendEvidence(tx, ctx, valid.handoffSessionId, {
      kind: 'resumed',
      actor: ctx.principalId,
      clientSessionId: valid.clientSessionId,
      fromPlatform: platformOf(spineRow.open_on_platform),
      toPlatform: platformOf(sessionRow.platform),
      contextSnapshot: context,
      projectionRevision: projection.revision,
      projectionDigest: projection.digest,
      discardedClientRevision: null,
      resolution: null,
      recordedAt: timestamp,
    });
    let conflictEvidenceId: string | null = null;
    if (stale) {
      conflictEvidenceId = await appendEvidence(tx, ctx, valid.handoffSessionId, {
        kind: 'conflict-discarded',
        actor: ctx.principalId,
        clientSessionId: valid.clientSessionId,
        fromPlatform: platformOf(spineRow.open_on_platform),
        toPlatform: platformOf(sessionRow.platform),
        contextSnapshot: null,
        projectionRevision: projection.revision,
        projectionDigest: projection.digest,
        discardedClientRevision: valid.clientRevision,
        resolution: 'server-state-wins',
        recordedAt: timestamp,
      });
      await tx.query(
        `UPDATE handoff_sessions
           SET anchor_revision = anchor_revision + 1
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.handoffSessionId],
      );
    }
    const row = await findHandoffRow(tx, ctx, valid.handoffSessionId, false);
    return {
      session: mapHandoffSession(row!),
      conflictId: conflictEvidenceId,
      recordedAt: timestamp,
    };
  });
  return {
    session,
    restoredContext: context,
    semantics: {
      reprojection: 'from-server-state',
      authorityTransfer: 'none',
      payload: 'projection-refs-only',
    },
    reprojection: projection,
    conflict:
      stale && conflictId !== null
        ? {
            conflictId,
            anchorRef: valid.handoffSessionId,
            conflictKind: 'stale-client-projection',
            resolution: 'server-state-wins',
            discardedClientRevision: valid.clientRevision!,
            resolvedAt: recordedAt,
          }
        : null,
  };
}

/** Closes a handoff session — the one-way terminal transition (FOR UPDATE re-check). */
export async function closeHandoffSession(
  ctx: TenantContext,
  input: unknown,
): Promise<HandoffSession> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateHandoffSessionRefInput(input);
  // Uniform not-found pre-check on the base connection.
  await loadHandoffRow(getDb(), ctx, valid.handoffSessionId);
  const timestamp = now().toISOString();
  const db = getDb();
  return db.transaction(async (tx) => {
    // FOR UPDATE staleness re-check: a racing close owns the terminal state.
    const locked = await loadHandoffRow(tx, ctx, valid.handoffSessionId, true);
    if (locked.status === 'closed') {
      throw new CrossPlatformError(
        'handoff_already_closed',
        `handoff session '${valid.handoffSessionId}' is already closed (the transition is one-way)`,
      );
    }
    await tx.query(
      `UPDATE handoff_sessions
         SET status = 'closed', closed_at = $1, closed_by = $2,
             last_active_at = $1, anchor_revision = anchor_revision + 1
       WHERE tenant_id = $3 AND id = $4`,
      [timestamp, ctx.principalId, ctx.tenantId, valid.handoffSessionId],
    );
    await appendEvidence(tx, ctx, valid.handoffSessionId, {
      kind: 'session-closed',
      actor: ctx.principalId,
      clientSessionId: null,
      fromPlatform: platformOf(locked.open_on_platform),
      toPlatform: null,
      contextSnapshot: null,
      projectionRevision: null,
      projectionDigest: null,
      discardedClientRevision: null,
      resolution: null,
      recordedAt: timestamp,
    });
    const row = await findHandoffRow(tx, ctx, valid.handoffSessionId, false);
    return mapHandoffSession(row!);
  });
}

/** Reads one handoff session (tenant-scoped; uniform typed not-found). */
export async function getHandoffSession(
  ctx: TenantContext,
  input: unknown,
): Promise<HandoffSession> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateHandoffSessionRefInput(input);
  const row = await loadHandoffRow(getDb(), ctx, valid.handoffSessionId);
  return mapHandoffSession(row);
}

/** Lists the tenant's handoff sessions (most-recently-active first). */
export async function listHandoffSessions(
  ctx: TenantContext,
  query: unknown,
): Promise<HandoffSession[]> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateListHandoffSessionsQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = 'SELECT * FROM handoff_sessions WHERE tenant_id = $1';
  if (valid.status !== undefined) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  if (valid.focusKind !== undefined) {
    params.push(valid.focusKind);
    sql += ` AND focus_kind = $${params.length}`;
  }
  if (valid.platform !== undefined) {
    params.push(valid.platform);
    sql += ` AND open_on_platform = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY last_active_at DESC, id DESC LIMIT $${params.length}`;
  const result = await getDb().query<HandoffSessionRow>(sql, params);
  return result.rows.map(mapHandoffSession);
}

/** Reads the append-only evidence trail of one handoff session (timeline order). */
export async function listHandoffEvidence(
  ctx: TenantContext,
  query: unknown,
): Promise<HandoffEvidence[]> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateListHandoffEvidenceQuery(query);
  // Uniform not-found gate (a missing/foreign session has no trail).
  await loadHandoffRow(getDb(), ctx, valid.handoffSessionId);
  const params: unknown[] = [ctx.tenantId, valid.handoffSessionId];
  let sql = `SELECT * FROM handoff_evidence
       WHERE tenant_id = $1 AND handoff_session_id = $2`;
  if (valid.kind !== undefined) {
    params.push(valid.kind);
    sql += ` AND evidence_kind = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;
  const result = await getDb().query<HandoffEvidenceRow>(sql, params);
  return result.rows.map(mapHandoffEvidence);
}

// ---------------------------------------------------------------------------
// The product shell read model (W057 semantics, contract-level only)
// ---------------------------------------------------------------------------

/** The seven W057 product areas, in plan order (the canonical web renderer's registry, mirrored). */
const SHELL_AREAS: readonly ShellArea[] = [
  {
    areaId: 'chat',
    href: '/chat',
    label: 'Chat',
    shortLabel: 'Chat',
    tagline: 'Talk with Aurum, your intelligence employee',
    mode: 'product',
  },
  {
    areaId: 'today',
    href: '/today',
    label: 'Today',
    shortLabel: 'Today',
    tagline: 'What needs your attention right now (management view)',
    mode: 'management',
  },
  {
    areaId: 'intelligence',
    href: '/intelligence',
    label: 'Intelligence',
    shortLabel: 'Intel',
    tagline: 'Goals, situation, unknowns, missions, risks and opportunities',
    mode: 'product',
  },
  {
    areaId: 'people',
    href: '/people',
    label: 'People',
    shortLabel: 'People',
    tagline: 'Your workforce, agents and how work gets done',
    mode: 'product',
  },
  {
    areaId: 'connections',
    href: '/connections',
    label: 'Connections',
    shortLabel: 'Connect',
    tagline: 'Channels, source systems and destinations',
    mode: 'product',
  },
  {
    areaId: 'marketplace',
    href: '/marketplace',
    label: 'Marketplace',
    shortLabel: 'Market',
    tagline: 'Extensions and governed agent packages',
    mode: 'product',
  },
  {
    areaId: 'more',
    href: '/more',
    label: 'More',
    shortLabel: 'More',
    tagline: 'Everything else, including the Management Control Tower',
    mode: 'product',
  },
];

/** The command-search entries (typed; identical on every client kind). */
function shellCommandEntries(): ShellCommandEntry[] {
  const entries: ShellCommandEntry[] = [];
  for (const area of SHELL_AREAS) {
    entries.push({
      commandId: `navigate:${area.areaId}`,
      label: `Go to ${area.label}`,
      keywords: [area.label.toLowerCase(), area.shortLabel.toLowerCase(), 'navigate', 'go to'],
      target: { kind: 'area', ref: area.areaId },
    });
  }
  for (const slug of TOWER_SURFACE_SLUGS) {
    entries.push({
      commandId: `tower:${slug}`,
      label: `Tower: ${slug}`,
      keywords: [slug, 'tower', 'management'],
      target: { kind: 'tower-surface', ref: slug },
    });
  }
  entries.push({
    commandId: 'open:notifications',
    label: 'Open notifications',
    keywords: ['notifications', 'bell', 'alerts'],
    target: { kind: 'notification-entry', ref: null },
  });
  entries.push({
    commandId: 'open:context-drawer',
    label: 'Open the context drawer',
    keywords: ['context', 'drawer', 'focus'],
    target: { kind: 'context-drawer', ref: null },
  });
  entries.push({
    commandId: 'open:tenant-switcher',
    label: 'Switch tenant or workspace',
    keywords: ['tenant', 'workspace', 'switch', 'company'],
    target: { kind: 'tenant-switcher', ref: null },
  });
  return entries;
}

/**
 * Reads the product shell model — the W057 semantics as ONE typed
 * projection. The web app remains the CANONICAL renderer; desktop and
 * mobile consume the SAME model. Platform identity never enters the
 * computation (test-locked).
 */
export async function readShellModel(
  ctx: TenantContext,
  query: unknown,
): Promise<ProductShellModel> {
  assertCrossPlatformTenantContext(ctx);
  const valid = validateReadShellModelQuery(query);

  // The notification entry (the notifications seam, read-only).
  const notifications = await listNotifications(ctx, { limit: MAX_LIST_LIMIT });
  const attention = notifications.filter(
    (notification) =>
      notification.status === 'pending' ||
      notification.status === 'escalating' ||
      notification.status === 'escalated',
  );
  const latestAttention = attention.reduce<typeof attention[number] | null>(
    (acc, notification) =>
      acc === null || Date.parse(notification.createdAt) > Date.parse(acc.createdAt)
        ? notification
        : acc,
    null,
  );
  const notificationEntry = {
    attentionCount: attention.length,
    latestSubject: latestAttention === null ? null : latestAttention.subject,
    latestAt: latestAttention === null ? null : latestAttention.createdAt,
  };

  // The context drawer (the optional focus's CURRENT server state).
  let contextDrawer: ProductShellModel['contextDrawer'] = {
    focusKind: 'none',
    focusRef: null,
    summary: null,
  };
  if (valid.focus !== null) {
    const context: HandoffWorkingContext = {
      focusKind: valid.focus.focusKind,
      focusRef: valid.focus.focusRef,
      ...(valid.focus.focusSeam === undefined ? {} : { focusSeam: valid.focus.focusSeam }),
      draft: null,
      navigation: { area: 'chat' },
    };
    const projection = await computeFocusProjection(ctx, context);
    contextDrawer = {
      focusKind: valid.focus.focusKind,
      focusRef: valid.focus.focusRef,
      summary: `${projection.projectionKind} @ r${projection.revision} (${projection.digest.slice(0, 16)}…)`,
    };
  }

  // The tenant/workspace switcher (the organizations seam; a provisioned
  // tenant is required — an unprovisioned one maps to the typed
  // tenant_not_found, honestly).
  let switcher: ProductShellModel['tenantSwitcher'];
  try {
    const tenant = await getTenant(ctx);
    const workspaces = await listWorkspaces(ctx);
    switcher = {
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      workspaces: workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        label: workspace.name,
      })),
    };
  } catch (error) {
    if (error instanceof OrganizationsError) {
      throw new CrossPlatformError(
        'tenant_not_found',
        'the shell read model requires a provisioned tenant',
      );
    }
    throw error;
  }

  const areas: ShellArea[] = [...SHELL_AREAS];
  const commandSearch = shellCommandEntries();
  const payload = {
    areas,
    commandSearch,
    notificationEntry,
    contextDrawer,
    tenantSwitcher: switcher,
  };
  return {
    projectionRef: {
      projectionKind: 'product-shell',
      targetId: ctx.tenantId,
      tenantId: ctx.tenantId,
      revision: 1,
      digest: digestOf(payload),
    },
    ...payload,
  };
}
