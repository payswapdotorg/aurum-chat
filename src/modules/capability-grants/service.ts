// Implementation of the capability-grants module's public operations (see
// contract.ts). W083 — Progressive Capability Grants.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) or `newId()` where a cross-module call needs the id
// first; timestamps come from the injectable clock and are never
// caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`*_not_found`), no existence leak.
//
// W083 acceptance — "Start with safe read-only access and request
// write/action authority only when a concrete task requires it. Make every
// grant visible, scoped, auditable and revocable." — is carried by these
// deliberate properties, all tested:
//
//   1. THE READ-ONLY START: `establishConnectionAccess` partitions a
//      connected system's live capability surface (read through the W081
//      contract) into what the connection confers on day one (every READ
//      capability — the floor) and what stays WRITE-GATED. Every
//      invocation requires the envelope: there is no capability path that
//      skips the explicit, visible read-only state.
//
//   2. THE ASK IS ALWAYS MINIMAL AND ALWAYS GATED: `requestCapabilityAuthority`
//      subtracts every capability an active grant already covers BEFORE
//      asking — the request row and the W009 action payload carry exactly
//      the MISSING keys ("later retry can request only the missing
//      capability") — and the ask itself is a consequential EXECUTE action
//      through the actions contract (action kind 'capability-grant'): the
//      built-in default gates it behind human approval; tenant policy may
//      auto-allow (a POLICY approval, recorded) or forbid (a POLICY
//      rejection, recorded) — never bypassed. A duplicate open ask is
//      refused (`request_pending`): the pending one must be decided first.
//
//   3. THE GATE STOPS THE WRITE: `invokeCapability` performs NO side
//      effects ever — it is the pre-execution authority check W084's
//      executor consults. A read capability is allowed by the floor; a
//      write capability is allowed only under an active grant. A denied
//      write invocation is RECORDED (append-only ledger) and returned with
//      its denial: the deterministic human-readable reason (why the
//      permission is necessary for THIS task — reason.ts, no LLM, lock 10)
//      and the exact requested scope (the missing capability, its label,
//      data categories and current ask-state). Nothing was written.
//
//   4. DENIAL IS DECISION-FINAL BUT NOT PERMANENT POLICY: a rejected ask
//      mints no grant and the gate keeps refusing; a NEW concrete task may
//      re-ask (tenants who want permanence forbid the action kind in W009
//      — the matrix is the policy authority, lock 14 discipline).
//
//   5. VISIBILITY + SCOPING + AUDIT + REVOCATION: grants, requests,
//      invocations and the envelope are all readable (get/list below);
//      every grant carries exactly its capability keys plus the frozen
//      scope detail the approver saw; the lifecycle is auditable THREE ways
//      (the W009 ActionRequest/ApprovalDecision trail, the append-only
//      capability_grant_events ledger and the append-only
//      capability_invocations ledger); `revokeCapabilityGrant` takes the
//      authority back with a full trail, claim-gated.
//
// Provider/broker isolation (lock 16): the only provider-adjacent values
// crossing this surface are the OPAQUE connection id from the
// connection-broker contract and the W081 plain-language capability keys.

import { now } from '@/infra/clock';
import { getDb, type DbResult, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  decideApproval,
  getActionRequest,
  listApprovalDecisions,
  type ActionRequest,
} from '@/modules/actions/contract';
import {
  getSystem,
  type InventorySystem,
  IntegrationError,
  type SystemCapability,
} from '@/modules/integration-intelligence/contract';
import {
  ConnectionBrokerError,
  getConnection,
  type BrokerConnection,
} from '@/modules/connection-broker/contract';
import { CapabilityGrantsError } from './errors';
import { buildAuthorityRequestReason, buildInvocationDenialReason, joinAnd } from './reason';
import type {
  CapabilityAccess,
  CapabilityDenial,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityGrantRequest,
  CapabilityInvocation,
  CapabilityAskState,
  ConnectionAccessView,
  DecideGrantRequestInput,
  EstablishAccessInput,
  GetAccessQuery,
  GetGrantQuery,
  GetGrantRequestQuery,
  GetInvocationQuery,
  GrantedCapability,
  GrantEventEntry,
  GrantEventType,
  GrantRequestStatus,
  GrantStatus,
  InvokeCapabilityInput,
  InvocationOutcome,
  ListGrantEventsQuery,
  ListGrantRequestsQuery,
  ListGrantsQuery,
  ListInvocationsQuery,
  RequestAuthorityInput,
  RequestAuthorityResult,
  RequestedCapabilityDetail,
  RevokeGrantInput,
  TaskContext,
} from './types';
import {
  assertGrantsTenantContext,
  partitionSurface,
  toDescriptor,
  validateDecideGrantRequestInput,
  validateEstablishAccessInput,
  validateGetAccessQuery,
  validateGetGrantQuery,
  validateGetGrantRequestQuery,
  validateGetInvocationQuery,
  validateInvokeCapabilityInput,
  validateListGrantEventsQuery,
  validateListGrantRequestsQuery,
  validateListGrantsQuery,
  validateListInvocationsQuery,
  validateRequestAuthorityInput,
  validateRevokeGrantInput,
  type ValidatedTaskContext,
} from './validation';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/** Authority claim that revokes capability grants (the admin gate). */
export const CAPABILITY_GRANTS_AUTHORITY_ADMINISTER = 'capability-grants:administer';

/**
 * The canonical action kind of a capability-grant ask (the W009 §20
 * vocabulary — an authority EXPANSION over a connected system is always a
 * consequential EXECUTE action).
 */
export const CAPABILITY_GRANT_ACTION_KIND = 'capability-grant';

/** Idempotency-key namespace for authority requests (first write wins, W009 replay). */
const GRANT_REQUEST_IDEMPOTENCY_PREFIX = 'capability-grant-request:';

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface AccessRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  system_id: string;
  system_key: string;
  system_display_name: string;
  read_capabilities: CapabilityDescriptor[];
  write_capabilities: CapabilityDescriptor[];
  established_by: string;
  established_at: Date | string;
  updated_at: Date | string;
}

interface RequestRow extends DbRow {
  id: string;
  tenant_id: string;
  access_id: string;
  connection_id: string;
  system_id: string;
  action_request_id: string;
  capability_keys: string[];
  requested_scope: { key: string; label: string; dataCategories: string[]; state: CapabilityAskState }[];
  reason: string;
  task_context: TaskContext;
  status: GrantRequestStatus;
  requested_by: string;
  requested_at: Date | string;
  decided_at: Date | string | null;
  updated_at: Date | string;
}

interface GrantRow extends DbRow {
  id: string;
  tenant_id: string;
  access_id: string;
  connection_id: string;
  system_id: string;
  capability_keys: string[];
  scope_detail: { key: string; label: string; dataCategories: string[] }[];
  status: GrantStatus;
  granted_via: string;
  granted_by: string;
  granted_at: Date | string;
  revoked_by: string | null;
  revoked_at: Date | string | null;
  revocation_note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface InvocationRow extends DbRow {
  id: string;
  tenant_id: string;
  access_id: string;
  connection_id: string;
  system_id: string;
  capability_key: string;
  capability_mode: 'read' | 'write';
  outcome: InvocationOutcome;
  basis: 'read-only-floor' | 'capability-grant' | 'grant-missing';
  grant_id: string | null;
  denial: CapabilityDenial | null;
  task_context: TaskContext;
  invoked_by: string;
  invoked_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  access_id: string;
  event: GrantEventType;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return iso(value)!;
}

function mapAccess(row: AccessRow): CapabilityAccess {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    systemId: row.system_id,
    systemKey: row.system_key,
    systemDisplayName: row.system_display_name,
    readCapabilities: row.read_capabilities,
    writeCapabilities: row.write_capabilities,
    establishedBy: row.established_by,
    establishedAt: isoRequired(row.established_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapRequest(row: RequestRow): CapabilityGrantRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accessId: row.access_id,
    connectionId: row.connection_id,
    systemId: row.system_id,
    actionRequestId: row.action_request_id,
    capabilityKeys: [...row.capability_keys],
    requestedScope: row.requested_scope,
    reason: row.reason,
    taskContext: row.task_context,
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: isoRequired(row.requested_at),
    decidedAt: iso(row.decided_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapGrant(row: GrantRow): CapabilityGrant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accessId: row.access_id,
    connectionId: row.connection_id,
    systemId: row.system_id,
    capabilityKeys: [...row.capability_keys],
    scopeDetail: row.scope_detail,
    status: row.status,
    grantedVia: row.granted_via,
    grantedBy: row.granted_by,
    grantedAt: isoRequired(row.granted_at),
    revokedBy: row.revoked_by,
    revokedAt: iso(row.revoked_at),
    revocationNote: row.revocation_note,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapInvocation(row: InvocationRow): CapabilityInvocation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accessId: row.access_id,
    connectionId: row.connection_id,
    systemId: row.system_id,
    capabilityKey: row.capability_key,
    capabilityMode: row.capability_mode,
    outcome: row.outcome,
    basis: row.basis,
    grantId: row.grant_id,
    denial: row.denial,
    taskContext: row.task_context,
    invokedBy: row.invoked_by,
    invokedAt: isoRequired(row.invoked_at),
  };
}

function mapEvent(row: EventRow): GrantEventEntry {
  return {
    id: row.id,
    accessId: row.access_id,
    event: row.event,
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: isoRequired(row.recorded_at),
  };
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Cross-module loaders (tenant-scoped through the owning contracts)
// ---------------------------------------------------------------------------

/** Loads a broker connection through the connection-broker contract (W082). */
async function loadConnection(ctx: TenantContext, connectionId: string): Promise<BrokerConnection> {
  try {
    return await getConnection(ctx, { connectionId });
  } catch (error) {
    if (error instanceof ConnectionBrokerError && error.code === 'connection_not_found') {
      throw new CapabilityGrantsError(
        'connection_not_found',
        `no connection '${connectionId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

/** Loads a Tool & System Inventory entry through the W081 contract. */
async function loadSystem(ctx: TenantContext, systemId: string): Promise<InventorySystem> {
  try {
    return await getSystem(ctx, { systemId });
  } catch (error) {
    if (error instanceof IntegrationError && error.code === 'system_not_found') {
      throw new CapabilityGrantsError(
        'system_not_found',
        `no inventory system '${systemId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Module-internal loaders
// ---------------------------------------------------------------------------

async function findAccessRow(
  db: Queryable,
  ctx: TenantContext,
  connectionId: string,
): Promise<AccessRow | null> {
  const rows = await db.query<AccessRow>(
    `SELECT * FROM capability_access WHERE tenant_id = $1 AND connection_id = $2`,
    [ctx.tenantId, connectionId],
  );
  return rows.rows[0] ?? null;
}

async function findGrantRow(
  db: Queryable,
  ctx: TenantContext,
  grantId: string,
): Promise<GrantRow | null> {
  const rows = await db.query<GrantRow>(
    `SELECT * FROM capability_grants WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, grantId],
  );
  return rows.rows[0] ?? null;
}

async function findRequestRow(
  db: Queryable,
  ctx: TenantContext,
  requestId: string,
): Promise<RequestRow | null> {
  const rows = await db.query<RequestRow>(
    `SELECT * FROM capability_grant_requests WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, requestId],
  );
  return rows.rows[0] ?? null;
}

/** Active grants of one connection, newest first. */
async function listActiveGrantRows(
  db: Queryable,
  ctx: TenantContext,
  connectionId: string,
): Promise<GrantRow[]> {
  const rows = await db.query<GrantRow>(
    `SELECT * FROM capability_grants
       WHERE tenant_id = $1 AND connection_id = $2 AND status = 'active'
       ORDER BY granted_at DESC, id DESC`,
    [ctx.tenantId, connectionId],
  );
  return rows.rows;
}

/** The open (pending) ask of one connection, if any. */
async function findOpenRequestRow(
  db: Queryable,
  ctx: TenantContext,
  connectionId: string,
): Promise<RequestRow | null> {
  const rows = await db.query<RequestRow>(
    `SELECT * FROM capability_grant_requests
       WHERE tenant_id = $1 AND connection_id = $2 AND status = 'pending_approval'
       ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, connectionId],
  );
  return rows.rows[0] ?? null;
}

/** The active grant covering `capabilityKey`, if any. */
async function findCoveringGrantRow(
  db: Queryable,
  ctx: TenantContext,
  connectionId: string,
  capabilityKey: string,
): Promise<GrantRow | null> {
  const rows = await db.query<GrantRow>(
    `SELECT * FROM capability_grants
       WHERE tenant_id = $1 AND connection_id = $2 AND status = 'active'
         AND capability_keys @> $3::jsonb
       ORDER BY granted_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, connectionId, JSON.stringify([capabilityKey])],
  );
  return rows.rows[0] ?? null;
}

/**
 * The current ask-state of one write capability on a connection — the
 * honest history a denial reports and a retry builds on:
 * 'pending' (an ask sits in the gate) → 'rejected' (an ask was decided
 * against) → 'revoked' (authority existed and was taken back) →
 * 'unrequested'.
 */
async function askStateForKey(
  db: Queryable,
  ctx: TenantContext,
  connectionId: string,
  capabilityKey: string,
): Promise<CapabilityAskState> {
  const pending = await db.query<{ id: string }>(
    `SELECT id FROM capability_grant_requests
       WHERE tenant_id = $1 AND connection_id = $2 AND status = 'pending_approval'
         AND capability_keys @> $3::jsonb
       LIMIT 1`,
    [ctx.tenantId, connectionId, JSON.stringify([capabilityKey])],
  );
  if (pending.rows.length > 0) return 'pending';

  const rejected = await db.query<{ id: string }>(
    `SELECT id FROM capability_grant_requests
       WHERE tenant_id = $1 AND connection_id = $2 AND status = 'rejected'
         AND capability_keys @> $3::jsonb
       LIMIT 1`,
    [ctx.tenantId, connectionId, JSON.stringify([capabilityKey])],
  );
  if (rejected.rows.length > 0) return 'rejected';

  const revoked = await db.query<{ id: string }>(
    `SELECT id FROM capability_grants
       WHERE tenant_id = $1 AND connection_id = $2 AND status = 'revoked'
         AND capability_keys @> $3::jsonb
       LIMIT 1`,
    [ctx.tenantId, connectionId, JSON.stringify([capabilityKey])],
  );
  if (revoked.rows.length > 0) return 'revoked';

  return 'unrequested';
}

/** Maps active grant rows to the GrantedCapability surface (labels from the frozen detail). */
function grantedCapabilitiesOf(rows: readonly GrantRow[]): GrantedCapability[] {
  const out: GrantedCapability[] = [];
  for (const row of rows) {
    for (const key of row.capability_keys) {
      const detail = row.scope_detail.find((entry) => entry.key === key);
      out.push({
        key,
        label: detail?.label ?? key,
        grantId: row.id,
      });
    }
  }
  return out;
}

/** Appends one lifecycle event (inside the caller's transaction). */
async function recordGrantEvent(
  tx: Queryable,
  ctx: TenantContext,
  accessId: string,
  event: GrantEventType,
  detail: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO capability_grant_events (
       tenant_id, access_id, event, detail, recorded_by, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.tenantId, accessId, event, detail, ctx.principalId, now()],
  );
}

/** Truncates to the events table's detail bound. */
function clampDetail(detail: string): string {
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
}

function taskRecord(task: ValidatedTaskContext): TaskContext {
  return { description: task.description, requestedFor: task.requestedFor };
}

/** The request status an action-request status mirrors onto. */
function requestStatusForActionStatus(status: ActionRequest['status']): GrantRequestStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending_approval';
  }
}

// ---------------------------------------------------------------------------
// The read-only envelope (the safe start)
// ---------------------------------------------------------------------------

export async function establishConnectionAccess(
  ctx: TenantContext,
  input: EstablishAccessInput,
): Promise<CapabilityAccess> {
  assertGrantsTenantContext(ctx);
  const valid = validateEstablishAccessInput(input);

  // The connection must exist in THIS tenant and be connected (the
  // connection-broker contract's uniform cross-tenant not-found discipline
  // applies — a foreign connection id is indistinguishable from missing).
  const connection = await loadConnection(ctx, valid.connectionId);
  if (connection.status !== 'connected') {
    throw new CapabilityGrantsError(
      'connection_not_connected',
      `connection '${valid.connectionId}' is '${connection.status}', not 'connected' — only a connected connection can establish read-only access`,
    );
  }
  if (connection.inventorySystemId === null) {
    throw new CapabilityGrantsError(
      'connection_not_bound',
      `connection '${valid.connectionId}' carries no Tool & System Inventory binding — its capability surface cannot be derived (connect it through the inventory)`,
    );
  }

  // The LIVE capability surface (read through the W081 contract — the
  // envelope always reflects what the system currently offers).
  const system = await loadSystem(ctx, connection.inventorySystemId);
  const surface: SystemCapability[] = system.capabilities;
  const partitioned = partitionSurface(surface);
  const byKey = new Map(surface.map((capability) => [capability.key, capability]));
  const readCapabilities = partitioned.read
    .map((key) => byKey.get(key))
    .filter((capability): capability is SystemCapability => capability !== undefined)
    .map(toDescriptor);
  const writeCapabilities = partitioned.write
    .map((key) => byKey.get(key))
    .filter((capability): capability is SystemCapability => capability !== undefined)
    .map(toDescriptor);

  const at = now();
  return getDb().transaction(async (tx) => {
    const existing = await findAccessRow(tx, ctx, valid.connectionId);
    if (existing !== null) {
      // Re-establish refreshes the frozen envelope onto the live surface
      // (systems evolve on re-discovery); identity and history stay.
      const updated = await tx.query<AccessRow>(
        `UPDATE capability_access SET
           system_id = $3, system_key = $4, system_display_name = $5,
           read_capabilities = $6::jsonb, write_capabilities = $7::jsonb,
           updated_at = $8
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          existing.id,
          system.id,
          system.systemKey,
          system.displayName,
          JSON.stringify(readCapabilities),
          JSON.stringify(writeCapabilities),
          at,
        ],
      );
      return mapAccess(updated.rows[0]!);
    }
    const inserted = await tx.query<AccessRow>(
      `INSERT INTO capability_access (
         id, tenant_id, connection_id, system_id, system_key, system_display_name,
         read_capabilities, write_capabilities, established_by, established_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $10)
       RETURNING *`,
      [
        newId(),
        ctx.tenantId,
        valid.connectionId,
        system.id,
        system.systemKey,
        system.displayName,
        JSON.stringify(readCapabilities),
        JSON.stringify(writeCapabilities),
        ctx.principalId,
        at,
      ],
    ).catch(async (error: unknown) => {
      // A concurrent establish won the unique (tenant, connection) race —
      // idempotent: surface the winner.
      if (!isDuplicateKeyOn(error, 'capability_access')) throw error;
      const winner = await findAccessRow(tx, ctx, valid.connectionId);
      if (winner !== null) return null;
      throw error;
    });
    if (inserted !== null) {
      const access = mapAccess(inserted.rows[0]!);
      await recordGrantEvent(
        tx,
        ctx,
        access.id,
        'access-established',
        clampDetail(
          `read-only start: ${readCapabilities.length} read capability(ies) conferred, ${writeCapabilities.length} write capability(ies) gated on ${system.displayName}`,
        ),
      );
      return access;
    }
    const winner = await findAccessRow(tx, ctx, valid.connectionId);
    return mapAccess(winner!);
  });
}

export async function getConnectionAccess(
  ctx: TenantContext,
  query: GetAccessQuery,
): Promise<ConnectionAccessView> {
  assertGrantsTenantContext(ctx);
  const valid = validateGetAccessQuery(query);
  const db = getDb();
  const access = await findAccessRow(db, ctx, valid.connectionId);
  if (access === null) {
    throw new CapabilityGrantsError(
      'access_not_found',
      `no capability access established for connection '${valid.connectionId}' in this tenant`,
    );
  }
  const grants = await listActiveGrantRows(db, ctx, valid.connectionId);
  const open = await findOpenRequestRow(db, ctx, valid.connectionId);
  return {
    ...mapAccess(access),
    connectionMode: grants.length > 0 ? 'elevated' : 'read-only',
    activeGrants: grantedCapabilitiesOf(grants),
    pendingRequestIds: open === null ? [] : [open.id],
  };
}

// ---------------------------------------------------------------------------
// The ask (progressive authority — always minimal, always gated)
// ---------------------------------------------------------------------------

export async function requestCapabilityAuthority(
  ctx: TenantContext,
  input: RequestAuthorityInput,
): Promise<RequestAuthorityResult> {
  assertGrantsTenantContext(ctx);
  const valid = validateRequestAuthorityInput(input);

  const connection = await loadConnection(ctx, valid.connectionId);
  if (connection.status !== 'connected') {
    throw new CapabilityGrantsError(
      'connection_not_connected',
      `connection '${valid.connectionId}' is '${connection.status}', not 'connected' — authority can only be requested on a connected connection`,
    );
  }
  const access = await findAccessRow(getDb(), ctx, valid.connectionId);
  if (access === null) {
    throw new CapabilityGrantsError(
      'access_not_established',
      `no capability access established for connection '${valid.connectionId}' — establish the read-only start first`,
    );
  }

  // Validate every requested key against the LIVE surface, split by mode.
  const system = await loadSystem(ctx, access.system_id);
  const byKey = new Map(system.capabilities.map((capability) => [capability.key, capability]));
  const askCandidates: CapabilityDescriptor[] = [];
  for (const key of valid.capabilityKeys) {
    const capability = byKey.get(key);
    if (capability === undefined) {
      throw new CapabilityGrantsError(
        'capability_not_offered',
        `capability '${key}' is not on the surface of '${system.displayName}' — the offered capabilities are ${joinAnd(system.capabilities.map((c) => c.key))}`,
      );
    }
    if (capability.mode === 'write') askCandidates.push(toDescriptor(capability));
  }
  // The read-only floor this connection confers (the full read surface —
  // reads never need authority, so the result tells the caller which
  // capabilities came with the connection).
  const conferredRead = system.capabilities
    .filter((capability) => capability.mode === 'read')
    .map(toDescriptor);

  // THE MINIMAL ASK: subtract everything an active grant already covers —
  // a later retry requests only the missing capability.
  const activeGrants = await listActiveGrantRows(getDb(), ctx, valid.connectionId);
  const covered = new Set(activeGrants.flatMap((row) => row.capability_keys));
  const alreadyGranted = grantedCapabilitiesOf(activeGrants);
  const missing = askCandidates.filter((capability) => !covered.has(capability.key));

  if (missing.length === 0) {
    // Nothing to ask: every write capability the task needs is already
    // covered and reads come with the connection. No gate history is
    // created for a satisfied request.
    return {
      request: null,
      alreadyGranted,
      conferredReadCapabilities: conferredRead,
    };
  }

  // One open ask per connection: decide the pending one before asking
  // again (the storage-level backstop mirrors this discipline).
  const open = await findOpenRequestRow(getDb(), ctx, valid.connectionId);
  if (open !== null) {
    throw new CapabilityGrantsError(
      'request_pending',
      `an authority request '${open.id}' for this connection is still pending — decide it before requesting again`,
    );
  }

  // The approver-facing scope: each missing capability with its honest
  // ask-state (unrequested / rejected before / revoked before).
  const db = getDb();
  const requestedScope: RequestedCapabilityDetail[] = [];
  for (const capability of missing) {
    requestedScope.push({
      ...capability,
      state: await askStateForKey(db, ctx, valid.connectionId, capability.key),
    });
  }

  const connectionMode = activeGrants.length > 0 ? 'elevated' : 'read-only';
  const reason = buildAuthorityRequestReason({
    systemDisplayName: system.displayName,
    taskContext: taskRecord(valid.taskContext),
    requested: missing,
    alreadyGranted,
    connectionMode,
  });

  // The W009 gate FIRST: the action request must exist before any grant
  // request may sit in a gated state (the W081 batch discipline). The
  // request id doubles as the idempotency key, so a retried submission
  // replays the original action request instead of duplicating gate
  // history.
  const requestId = newId();
  const payload = {
    requestId,
    actionKind: CAPABILITY_GRANT_ACTION_KIND,
    connectionId: valid.connectionId,
    systemKey: system.systemKey,
    systemDisplayName: system.displayName,
    connectionMode,
    reason,
    requestedScope,
    alreadyGranted,
    taskContext: taskRecord(valid.taskContext),
  };
  const actionRequest = await authorizeAction(ctx, {
    actionKind: CAPABILITY_GRANT_ACTION_KIND,
    authorityLevel: 'EXECUTE',
    payload,
    justification: reason,
    idempotencyKey: `${GRANT_REQUEST_IDEMPOTENCY_PREFIX}${requestId}`,
  });
  const status = requestStatusForActionStatus(actionRequest.status);
  // A policy-decided request carries its own decidedAt — mirror that,
  // not our clock.
  const at = now();
  const decidedAt = actionRequest.status === 'pending' ? null : actionRequest.decidedAt ?? at;

  return getDb().transaction(async (tx) => {
    let inserted: DbResult<RequestRow>;
    try {
      inserted = await tx.query<RequestRow>(
        `INSERT INTO capability_grant_requests (
           id, tenant_id, access_id, connection_id, system_id, action_request_id,
           capability_keys, requested_scope, reason, task_context,
           status, requested_by, requested_at, decided_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14, $13)
         RETURNING *`,
        [
          requestId,
          ctx.tenantId,
          access.id,
          valid.connectionId,
          system.id,
          actionRequest.id,
          JSON.stringify(missing.map((capability) => capability.key)),
          JSON.stringify(requestedScope),
          reason,
          JSON.stringify(taskRecord(valid.taskContext)),
          status,
          ctx.principalId,
          at,
          decidedAt,
        ],
      );
    } catch (error) {
      // A concurrent ask won the one-open-ask race (the partial unique
      // index is the storage-level backstop of the request_pending
      // discipline). Surface the same refusal.
      if (isDuplicateKeyOn(error, 'capability_grant_requests')) {
        throw new CapabilityGrantsError(
          'request_pending',
          'an authority request for this connection is still pending — decide it before requesting again',
        );
      }
      throw error;
    }
    const request = mapRequest(inserted.rows[0]!);
    await recordGrantEvent(
      tx,
      ctx,
      access.id,
      'authority-requested',
      clampDetail(`asked for ${joinAnd(missing.map((c) => `"${c.label}"`))} on ${system.displayName}`),
    );

    // A policy-decided ask is decided at gate time.
    if (status === 'approved') {
      // Policy-allowed: the grant is minted now (granted_by 'policy' — the
      // W009 decision trail names the matrix).
      await mintGrant(
        tx,
        ctx,
        access.id,
        valid.connectionId,
        system.id,
        request.id,
        'policy',
        missing.map((capability) => capability.key),
        requestedScope.map((capability) => ({
          key: capability.key,
          label: capability.label,
          dataCategories: capability.dataCategories,
        })),
        decidedAt ?? at,
      );
      await recordGrantEvent(
        tx,
        ctx,
        access.id,
        'authority-granted',
        clampDetail(`granted by policy: ${joinAnd(missing.map((c) => `"${c.label}"`))}`),
      );
    } else if (status === 'rejected') {
      // Policy-forbidden: the ask is recorded rejected — no grant, no
      // authority, the gate keeps refusing (the matrix decided).
      await recordGrantEvent(
        tx,
        ctx,
        access.id,
        'authority-rejected',
        clampDetail(`rejected by policy: ${joinAnd(missing.map((c) => `"${c.label}"`))}`),
      );
    }
    return {
      request,
      alreadyGranted,
      conferredReadCapabilities: conferredRead,
    };
  });
}

/** Mints one scoped grant from an APPROVED request (inside the caller's transaction). */
async function mintGrant(
  tx: Queryable,
  ctx: TenantContext,
  accessId: string,
  connectionId: string,
  systemId: string,
  grantedVia: string,
  grantedBy: string,
  capabilityKeys: string[],
  scopeDetail: { key: string; label: string; dataCategories: string[] }[],
  grantedAt: Date | string,
): Promise<GrantRow> {
  const grantedAtDate = grantedAt instanceof Date ? grantedAt : new Date(grantedAt);
  const inserted = await tx.query<GrantRow>(
    `INSERT INTO capability_grants (
       id, tenant_id, access_id, connection_id, system_id,
       capability_keys, scope_detail, status, granted_via, granted_by,
       granted_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'active', $8, $9, $10, $10, $10)
     RETURNING *`,
    [
      newId(),
      ctx.tenantId,
      accessId,
      connectionId,
      systemId,
      JSON.stringify(capabilityKeys),
      JSON.stringify(scopeDetail),
      grantedVia,
      grantedBy,
      grantedAtDate,
    ],
  );
  return inserted.rows[0]!;
}

export async function decideGrantRequest(
  ctx: TenantContext,
  input: DecideGrantRequestInput,
): Promise<CapabilityGrantRequest> {
  assertGrantsTenantContext(ctx);
  const valid = validateDecideGrantRequestInput(input);

  const db = getDb();
  const existing = await findRequestRow(db, ctx, valid.requestId);
  if (existing === null) {
    throw new CapabilityGrantsError(
      'grant_request_not_found',
      `no authority request '${valid.requestId}' exists in this tenant`,
    );
  }
  if (existing.status !== 'pending_approval') {
    throw new CapabilityGrantsError(
      'grant_request_not_pending',
      `authority request '${valid.requestId}' is '${existing.status}' — only a pending request can be decided`,
    );
  }

  let actionRequest: ActionRequest;
  try {
    // The human decision itself flows through the actions contract: the
    // approve claim, the separation of duties (the requester never decides
    // its own request) and first-decision-wins are enforced THERE (W009).
    actionRequest = await decideApproval(ctx, {
      requestId: existing.action_request_id,
      decision: valid.decision,
      note: valid.note,
    });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'not_pending') {
      // Crash-recovery sync: the request was already decided (a prior
      // decide succeeded but our state update was interrupted, or another
      // approver won the race). Re-read the authoritative request state
      // and sync onto it — first decision wins, always.
      actionRequest = await getActionRequest(ctx, { requestId: existing.action_request_id });
      if (actionRequest.status === 'pending') throw error;
    } else {
      throw error;
    }
  }

  // Who actually decided (the actions contract is the authority): the
  // latest principal decision on the action request.
  const decisions = await listApprovalDecisions(ctx, { requestId: existing.action_request_id });
  const principalDecision = [...decisions]
    .reverse()
    .find((decision) => decision.decidedBy === 'principal' && decision.decision === valid.decision);
  const decidedBy = principalDecision?.principalId ?? ctx.principalId;

  const status = requestStatusForActionStatus(actionRequest.status);
  const at = now();
  const decidedAt = actionRequest.decidedAt ?? at;

  return getDb().transaction(async (tx) => {
    const updated = await tx.query<RequestRow>(
      `UPDATE capability_grant_requests SET
         status = $3, decided_at = $4, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending_approval'
       RETURNING *`,
      [ctx.tenantId, valid.requestId, status, decidedAt],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      // Someone else synced first — return the current state.
      const current = await findRequestRow(tx, ctx, valid.requestId);
      return mapRequest(current!);
    }

    if (status === 'approved') {
      // The approval mints the grant: exactly the requested scope, linked
      // to the request → action request → decisions chain.
      await mintGrant(
        tx,
        ctx,
        row.access_id,
        row.connection_id,
        row.system_id,
        row.id,
        decidedBy,
        [...row.capability_keys],
        row.requested_scope.map((capability) => ({
          key: capability.key,
          label: capability.label,
          dataCategories: capability.dataCategories,
        })),
        decidedAt,
      );
      await recordGrantEvent(
        tx,
        ctx,
        row.access_id,
        'authority-granted',
        clampDetail(`granted ${joinAnd(row.requested_scope.map((c) => `"${c.label}"`))} via request ${row.id}`),
      );
    } else {
      await recordGrantEvent(
        tx,
        ctx,
        row.access_id,
        'authority-rejected',
        clampDetail(`rejected ${joinAnd(row.requested_scope.map((c) => `"${c.label}"`))} via request ${row.id}`),
      );
    }
    return mapRequest(row);
  });
}

// ---------------------------------------------------------------------------
// The gate (action invocation — denial stops the write)
// ---------------------------------------------------------------------------

export async function invokeCapability(
  ctx: TenantContext,
  input: InvokeCapabilityInput,
): Promise<CapabilityInvocation> {
  assertGrantsTenantContext(ctx);
  const valid = validateInvokeCapabilityInput(input);

  // THE WRITE NEVER HAPPENS HERE: this is the pre-execution authority
  // check. It touches no external system and mints no side effect — an
  // 'allowed' invocation is the authority evidence a subsequent execution
  // links to (W084's executor consults this gate).
  const connection = await loadConnection(ctx, valid.connectionId);
  if (connection.status !== 'connected') {
    throw new CapabilityGrantsError(
      'connection_not_connected',
      `connection '${valid.connectionId}' is '${connection.status}', not 'connected' — a disconnected connection confers no capability`,
    );
  }

  const db = getDb();
  const access = await findAccessRow(db, ctx, valid.connectionId);
  if (access === null) {
    throw new CapabilityGrantsError(
      'access_not_established',
      `no capability access established for connection '${valid.connectionId}' — establish the read-only start first`,
    );
  }
  if (access.system_id !== connection.inventorySystemId) {
    throw new CapabilityGrantsError(
      'access_stale',
      `the capability access of connection '${valid.connectionId}' was established for a different inventory system — re-establish it`,
    );
  }

  // The LIVE surface decides what exists to invoke.
  const system = await loadSystem(ctx, access.system_id);
  const capability = system.capabilities.find((entry) => entry.key === valid.capabilityKey);
  if (capability === undefined) {
    throw new CapabilityGrantsError(
      'capability_not_offered',
      `capability '${valid.capabilityKey}' is not on the surface of '${system.displayName}' — the offered capabilities are ${joinAnd(system.capabilities.map((c) => c.key))}`,
    );
  }

  const at = now();
  const task = taskRecord(valid.taskContext);

  if (capability.mode === 'read') {
    // THE READ-ONLY FLOOR: reads come with the connection itself.
    const inserted = await db.query<InvocationRow>(
      `INSERT INTO capability_invocations (
         id, tenant_id, access_id, connection_id, system_id,
         capability_key, capability_mode, outcome, basis, grant_id, denial, task_context,
         invoked_by, invoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'read', 'allowed', 'read-only-floor', NULL, NULL, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        newId(),
        ctx.tenantId,
        access.id,
        valid.connectionId,
        access.system_id,
        capability.key,
        JSON.stringify(task),
        ctx.principalId,
        at,
      ],
    );
    return mapInvocation(inserted.rows[0]!);
  }

  // A write capability: only an active grant may carry it.
  const grant = await findCoveringGrantRow(db, ctx, valid.connectionId, capability.key);
  if (grant !== null) {
    const inserted = await db.query<InvocationRow>(
      `INSERT INTO capability_invocations (
         id, tenant_id, access_id, connection_id, system_id,
         capability_key, capability_mode, outcome, basis, grant_id, denial, task_context,
         invoked_by, invoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'write', 'allowed', 'capability-grant', $7, NULL, $8::jsonb, $9, $10)
       RETURNING *`,
      [
        newId(),
        ctx.tenantId,
        access.id,
        valid.connectionId,
        access.system_id,
        capability.key,
        grant.id,
        JSON.stringify(task),
        ctx.principalId,
        at,
      ],
    );
    return mapInvocation(inserted.rows[0]!);
  }

  // DENIED — the write is stopped. The invocation is recorded with its
  // human-readable reason and the exact requested scope (the acceptance
  // core): the missing capability, its plain-language label, data
  // categories, current ask-state, and what the connection does hold.
  const activeGrants = await listActiveGrantRows(db, ctx, valid.connectionId);
  const alreadyGranted = grantedCapabilitiesOf(activeGrants);
  const connectionMode = activeGrants.length > 0 ? 'elevated' : 'read-only';
  const descriptor = toDescriptor(capability);
  const denial: CapabilityDenial = {
    reason: buildInvocationDenialReason({
      systemDisplayName: system.displayName,
      taskContext: task,
      missing: [descriptor],
      alreadyGranted,
      connectionMode,
    }),
    requestedScope: [
      {
        ...descriptor,
        state: await askStateForKey(db, ctx, valid.connectionId, capability.key),
      },
    ],
    alreadyGranted,
  };

  const inserted = await db.query<InvocationRow>(
    `INSERT INTO capability_invocations (
       id, tenant_id, access_id, connection_id, system_id,
       capability_key, capability_mode, outcome, basis, grant_id, denial, task_context,
       invoked_by, invoked_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'write', 'denied', 'grant-missing', NULL, $7::jsonb, $8::jsonb, $9, $10)
     RETURNING *`,
    [
      newId(),
      ctx.tenantId,
      access.id,
      valid.connectionId,
      access.system_id,
      capability.key,
      JSON.stringify(denial),
      JSON.stringify(task),
      ctx.principalId,
      at,
    ],
  );
  return mapInvocation(inserted.rows[0]!);
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export async function revokeCapabilityGrant(
  ctx: TenantContext,
  input: RevokeGrantInput,
): Promise<CapabilityGrant> {
  assertGrantsTenantContext(ctx);
  // Revocation takes authority BACK — a safety act held behind the
  // administer claim (the integration-intelligence admin-gate precedent),
  // not a consequential expansion, so it is claim-gated rather than
  // W009-gated.
  if (!ctx.authority.includes(CAPABILITY_GRANTS_AUTHORITY_ADMINISTER)) {
    throw new CapabilityGrantsError(
      'forbidden',
      `revoking capability grants requires the '${CAPABILITY_GRANTS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateRevokeGrantInput(input);

  const existing = await findGrantRow(getDb(), ctx, valid.grantId);
  if (existing === null) {
    throw new CapabilityGrantsError(
      'grant_not_found',
      `no capability grant '${valid.grantId}' exists in this tenant`,
    );
  }
  if (existing.status === 'revoked') {
    // Idempotent: an already-revoked grant returns as-is (its trail stays).
    return mapGrant(existing);
  }

  const at = now();
  return getDb().transaction(async (tx) => {
    const updated = await tx.query<GrantRow>(
      `UPDATE capability_grants SET
         status = 'revoked', revoked_by = $3, revoked_at = $4, revocation_note = $5, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'active'
       RETURNING *`,
      [ctx.tenantId, valid.grantId, ctx.principalId, at, valid.note],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      // Someone else revoked first — return the current state.
      const current = await findGrantRow(tx, ctx, valid.grantId);
      return mapGrant(current!);
    }
    await recordGrantEvent(
      tx,
      ctx,
      row.access_id,
      'authority-revoked',
      clampDetail(
        `revoked ${joinAnd(row.scope_detail.map((c) => `"${c.label}"`))}` +
          (valid.note !== null ? ` — ${valid.note}` : ''),
      ),
    );
    return mapGrant(row);
  });
}

// ---------------------------------------------------------------------------
// Reads (the visible surface)
// ---------------------------------------------------------------------------

export async function getCapabilityGrant(
  ctx: TenantContext,
  query: GetGrantQuery,
): Promise<CapabilityGrant> {
  assertGrantsTenantContext(ctx);
  const valid = validateGetGrantQuery(query);
  const row = await findGrantRow(getDb(), ctx, valid.grantId);
  if (row === null) {
    throw new CapabilityGrantsError(
      'grant_not_found',
      `no capability grant '${valid.grantId}' exists in this tenant`,
    );
  }
  return mapGrant(row);
}

export async function listCapabilityGrants(
  ctx: TenantContext,
  query: ListGrantsQuery,
): Promise<CapabilityGrant[]> {
  assertGrantsTenantContext(ctx);
  const valid = validateListGrantsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.connectionId !== null) {
    params.push(valid.connectionId);
    conditions.push(`connection_id = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<GrantRow>(
    `SELECT * FROM capability_grants WHERE ${conditions.join(' AND ')}
       ORDER BY granted_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapGrant);
}

export async function getGrantRequest(
  ctx: TenantContext,
  query: GetGrantRequestQuery,
): Promise<CapabilityGrantRequest> {
  assertGrantsTenantContext(ctx);
  const valid = validateGetGrantRequestQuery(query);
  const row = await findRequestRow(getDb(), ctx, valid.requestId);
  if (row === null) {
    throw new CapabilityGrantsError(
      'grant_request_not_found',
      `no authority request '${valid.requestId}' exists in this tenant`,
    );
  }
  return mapRequest(row);
}

export async function listGrantRequests(
  ctx: TenantContext,
  query: ListGrantRequestsQuery,
): Promise<CapabilityGrantRequest[]> {
  assertGrantsTenantContext(ctx);
  const valid = validateListGrantRequestsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.connectionId !== null) {
    params.push(valid.connectionId);
    conditions.push(`connection_id = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<RequestRow>(
    `SELECT * FROM capability_grant_requests WHERE ${conditions.join(' AND ')}
       ORDER BY requested_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapRequest);
}

export async function getCapabilityInvocation(
  ctx: TenantContext,
  query: GetInvocationQuery,
): Promise<CapabilityInvocation> {
  assertGrantsTenantContext(ctx);
  const valid = validateGetInvocationQuery(query);
  const rows = await getDb().query<InvocationRow>(
    `SELECT * FROM capability_invocations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.invocationId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new CapabilityGrantsError(
      'invocation_not_found',
      `no capability invocation '${valid.invocationId}' exists in this tenant`,
    );
  }
  return mapInvocation(row);
}

export async function listCapabilityInvocations(
  ctx: TenantContext,
  query: ListInvocationsQuery,
): Promise<CapabilityInvocation[]> {
  assertGrantsTenantContext(ctx);
  const valid = validateListInvocationsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.connectionId !== null) {
    params.push(valid.connectionId);
    conditions.push(`connection_id = $${params.length}`);
  }
  if (valid.capabilityKey !== null) {
    params.push(valid.capabilityKey);
    conditions.push(`capability_key = $${params.length}`);
  }
  if (valid.outcome !== null) {
    params.push(valid.outcome);
    conditions.push(`outcome = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<InvocationRow>(
    `SELECT * FROM capability_invocations WHERE ${conditions.join(' AND ')}
       ORDER BY invoked_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapInvocation);
}

export async function listGrantEvents(
  ctx: TenantContext,
  query: ListGrantEventsQuery,
): Promise<GrantEventEntry[]> {
  assertGrantsTenantContext(ctx);
  const valid = validateListGrantEventsQuery(query);
  // The access must exist in this tenant — its event trail is
  // tenant-scoped with it (cross-tenant: uniform not_found, no leak).
  const access = await findAccessRow(getDb(), ctx, valid.connectionId);
  if (access === null) {
    throw new CapabilityGrantsError(
      'access_not_found',
      `no capability access established for connection '${valid.connectionId}' in this tenant`,
    );
  }
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM capability_grant_events
       WHERE tenant_id = $1 AND access_id = $2
       ORDER BY recorded_at DESC, id DESC LIMIT $3`,
    [ctx.tenantId, access.id, valid.limit],
  );
  return rows.rows.map(mapEvent);
}
