// Implementation of the edge-connector module's public operations (see
// contract.ts). W088 — Aurum Edge Connector.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by `newId()` where
// the id is needed before the insert; timestamps come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`edge_not_found` /
// `job_not_found`), no existence leak.
//
// W088 acceptance — "outbound-only connection where possible; signed
// tenant-scoped jobs; local secret handling; capability allowlist;
// health/version reporting; result normalization; no second
// organizational truth store" — is carried by these deliberate
// properties, all tested:
//
//   1. OUTBOUND-ONLY: Aurum NEVER opens a connection toward the edge. The
//      edge dials home through exactly three authenticated call shapes
//      (heartbeat → pull → submit); the dial-home authentication is an
//      HMAC proof over purpose/tenant/edge/nonce material with a
//      per-call nonce consumed exactly once (replay-resistant channel).
//   2. SIGNED TENANT-SCOPED JOBS: every job envelope is canonical JSON
//      signed by the wired signer (no signer wired → `signer_unavailable`,
//      never a fake success); the envelope carries tenant, edge,
//      capability, nonce, expiry; both sides verify.
//   3. LOCAL SECRET HANDLING: only OPAQUE secret references + scopes are
//      persisted (the allowlist rows); credential values never enter any
//      table, envelope or log line — the edge resolves refs locally.
//   4. CAPABILITY ALLOWLIST, TWICE: dispatch (issueEdgeJob) refuses
//      capabilities outside the persisted allowlist; the edge boundary
//      (the runtime's local copy) refuses them again — the simulator
//      proves the boundary check.
//   5. HEALTH/VERSION REPORTING: heartbeats are verified, append-only
//      evidence; the runtime's derived health gates dispatch (honest
//      degradation: `edge_not_connected` for pending/stale edges).
//   6. RESULT NORMALIZATION: submitted results are canonicalized (plain
//      JSON only — a provider object is rejected loudly) and use the W084
//      receipt taxonomy verbatim; `createEdgeDeepActionTransport`
//      (transport.ts) maps them straight onto the deep-action pipeline's
//      transport port. No second organizational truth store: the job
//      result is execution evidence; W084 owns reconciliation.
//   7. REPLAY RESISTANCE: per-job envelope nonces (a consumed nonce is
//      refused by BOTH sides) and per-call dial-home nonces.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { EdgeConnectorError } from './errors';
import {
  canonicalEnvelopeMaterial,
  canonicalJson,
  edgeAuthMaterial,
  verifyEnvelopeSignature,
} from './envelope';
import {
  assertEdgeTenantContext,
  validateEdgeAuthentication,
  validateEdgeHeartbeatReport,
  validateGetEdgeJobQuery,
  validateGetEdgeRuntimeQuery,
  validateIssueEdgeJobInput,
  validateListEdgeEventsQuery,
  validateListEdgeHeartbeatsQuery,
  validateListEdgeJobsQuery,
  validateListEdgeRuntimesQuery,
  validatePullPendingEdgeJobsInput,
  validateRegisterEdgeRuntimeInput,
  validateRevokeEdgeRuntimeInput,
  validateSetEdgeAllowlistInput,
  validateSubmitEdgeJobResultInput,
  validateVerifyEdgeJobEnvelopeInput,
  type ValidatedAllowlistEntry,
} from './validation';
import type {
  EdgeAllowlistEntry,
  EdgeAuthentication,
  EdgeConnectivityKind,
  EdgeEvent,
  EdgeEventType,
  EdgeHealth,
  EdgeHeartbeat,
  EdgeHeartbeatReport,
  EdgeHeartbeatResult,
  EdgeJob,
  EdgeJobEnvelope,
  EdgeJobState,
  EdgeReceiptStatus,
  EdgeRuntime,
  EdgeRuntimeDetail,
  EdgeRuntimeStatus,
  EdgeRuntimeSummary,
  EdgeSigner,
  IssueEdgeJobResult,
  ListEdgeHeartbeatsQuery,
  ListEdgeEventsQuery,
  ListEdgeJobsQuery,
  ListEdgeRuntimesQuery,
  PullPendingEdgeJobsResult,
  RegisterEdgeRuntimeInput,
  RevokeEdgeRuntimeInput,
  SetEdgeAllowlistInput,
  SignedEdgeJobEnvelope,
  SubmitEdgeJobResultResult,
  GetEdgeJobQuery,
  GetEdgeRuntimeQuery,
  PullPendingEdgeJobsInput,
  SubmitEdgeJobResultInput,
  IssueEdgeJobInput,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants
// ---------------------------------------------------------------------------

/** The authority claim that gates edge administration (register/revoke/allowlist). */
export const EDGE_CONNECTOR_AUTHORITY_ADMINISTER = 'edge-connector:administer';

// ---------------------------------------------------------------------------
// The signer port wiring (infrastructure, not domain state)
// ---------------------------------------------------------------------------

let wiredSigner: EdgeSigner | null = null;

/** Wires (or clears) the edge signer — the enrollment-key holder. */
export function wireEdgeSigner(signer: EdgeSigner | null): void {
  wiredSigner = signer;
}

/** The currently wired edge signer (null = none). */
export function getWiredSigner(): EdgeSigner | null {
  return wiredSigner;
}

function requireSigner(): EdgeSigner {
  if (wiredSigner === null) {
    throw new EdgeConnectorError(
      'signer_unavailable',
      'no edge signer is wired — wireEdgeSigner first; the protocol refuses to fake signatures',
    );
  }
  return wiredSigner;
}

// ---------------------------------------------------------------------------
// Transport-result canonicalization (provider objects never cross)
// ---------------------------------------------------------------------------

function isPlainJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;
  if (Array.isArray(value)) return value.every((entry) => isPlainJsonValue(entry));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isPlainJsonValue(entry));
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface EdgeRow extends DbRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: EdgeRuntimeStatus;
  signing_key_id: string;
  connectivity: EdgeConnectivityKind[];
  reported_version: string | null;
  reported_capabilities: EdgeConnectivityKind[] | null;
  stale_after_seconds: number;
  heartbeat_interval_seconds: number;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AllowlistRow extends DbRow {
  id: string;
  tenant_id: string;
  edge_id: string;
  capability_key: string;
  mode: 'read' | 'write';
  connectivity: EdgeConnectivityKind;
  secret_ref: string;
  secret_scopes: string[];
  created_at: Date | string;
}

interface HeartbeatRow extends DbRow {
  id: string;
  tenant_id: string;
  edge_id: string;
  position: number;
  reported_version: string;
  reported_capabilities: EdgeConnectivityKind[];
  reported_pending_jobs: number | null;
  received_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  edge_id: string;
  position: number;
  event: EdgeEventType;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

interface JobRow extends DbRow {
  id: string;
  tenant_id: string;
  edge_id: string;
  job_key: string | null;
  kind: 'inspect' | 'execute';
  capability_key: string;
  target: string;
  payload: unknown;
  credential_ref: string | null;
  system_key: string | null;
  state: EdgeJobState;
  nonce: string;
  canonical_material: string;
  signature: string;
  receipt_status: EdgeReceiptStatus | null;
  receipt_id: string | null;
  receipt_detail: string | null;
  result_state: { found: boolean; state: unknown } | null;
  issued_at: Date | string;
  expires_at: Date | string;
  delivered_at: Date | string | null;
  completed_at: Date | string | null;
  created_by: string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapEdge(row: EdgeRow): EdgeRuntime {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    status: row.status,
    signingKeyId: row.signing_key_id,
    connectivity: row.connectivity,
    reportedVersion: row.reported_version,
    reportedCapabilities: row.reported_capabilities,
    staleAfterSeconds: row.stale_after_seconds,
    heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
    lastSeenAt: toIso(row.last_seen_at),
    revokedAt: toIso(row.revoked_at),
    revokedReason: row.revoked_reason,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapAllowlist(row: AllowlistRow): EdgeAllowlistEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    capabilityKey: row.capability_key,
    mode: row.mode,
    connectivity: row.connectivity,
    secretRef: row.secret_ref,
    secretScopes: row.secret_scopes,
    createdAt: toIso(row.created_at)!,
  };
}

function mapHeartbeat(row: HeartbeatRow): EdgeHeartbeat {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    position: row.position,
    reportedVersion: row.reported_version,
    reportedCapabilities: row.reported_capabilities,
    reportedPendingJobs: row.reported_pending_jobs,
    receivedAt: toIso(row.received_at)!,
  };
}

function mapEvent(row: EventRow): EdgeEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    event: row.event,
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at)!,
  };
}

function mapJob(row: JobRow): EdgeJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    jobKey: row.job_key,
    kind: row.kind,
    capabilityKey: row.capability_key,
    target: row.target,
    payload: row.payload,
    credentialRef: row.credential_ref,
    systemKey: row.system_key,
    state: row.state,
    nonce: row.nonce,
    receiptStatus: row.receipt_status,
    receiptId: row.receipt_id,
    receiptDetail: row.receipt_detail,
    resultState: row.result_state,
    issuedAt: toIso(row.issued_at)!,
    expiresAt: toIso(row.expires_at)!,
    deliveredAt: toIso(row.delivered_at),
    completedAt: toIso(row.completed_at),
    createdBy: row.created_by,
  };
}

// ---------------------------------------------------------------------------
// Edge loaders + health derivation
// ---------------------------------------------------------------------------

async function findEdgeRow(
  db: Queryable,
  tenantId: string,
  edgeId: string,
): Promise<EdgeRow | null> {
  const rows = await db.query<EdgeRow>(
    `SELECT * FROM edge_runtimes WHERE tenant_id = $1 AND id = $2`,
    [tenantId, edgeId],
  );
  return rows.rows[0] ?? null;
}

async function loadEdge(tenantId: string, edgeId: string): Promise<EdgeRow> {
  const row = await findEdgeRow(getDb(), tenantId, edgeId);
  if (row === null) {
    throw new EdgeConnectorError(
      'edge_not_found',
      `no edge runtime '${edgeId}' exists in this tenant`,
    );
  }
  return row;
}

/** The derived health of a runtime row (never stored — computed fresh). */
export function healthOf(row: EdgeRow, at: Date = now()): EdgeHealth {
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'pending') return 'pending';
  const last = row.last_seen_at === null ? null : new Date(row.last_seen_at).getTime();
  if (last === null) return 'pending';
  const ageMs = at.getTime() - last;
  return ageMs <= row.stale_after_seconds * 1000 ? 'connected' : 'stale';
}

/** Dispatch-time health gate — honest degradation, never a fake success. */
function requireDispatchable(row: EdgeRow, at: Date = now()): EdgeRow {
  if (row.status === 'revoked') {
    throw new EdgeConnectorError(
      'edge_revoked',
      `edge runtime '${row.id}' is revoked and can execute nothing`,
    );
  }
  const health = healthOf(row, at);
  if (health !== 'connected') {
    const why =
      health === 'pending'
        ? 'it has never completed a heartbeat'
        : `its last heartbeat is older than its ${row.stale_after_seconds}s staleness window`;
    throw new EdgeConnectorError(
      'edge_not_connected',
      `edge runtime '${row.id}' is '${health}' (${why}) — no healthy edge is available for dispatch`,
    );
  }
  return row;
}

async function listAllowlistRows(db: Queryable, tenantId: string, edgeId: string): Promise<AllowlistRow[]> {
  const rows = await db.query<AllowlistRow>(
    `SELECT * FROM edge_capability_allowlist
       WHERE tenant_id = $1 AND edge_id = $2 ORDER BY capability_key`,
    [tenantId, edgeId],
  );
  return rows.rows;
}

function requireAllowlisted(
  entries: AllowlistRow[],
  capabilityKey: string,
): AllowlistRow {
  const entry = entries.find((candidate) => candidate.capability_key === capabilityKey);
  if (entry === undefined) {
    throw new EdgeConnectorError(
      'capability_not_allowed',
      `capability '${capabilityKey}' is not in this edge's allowlist — the dispatch-side allowlist check refuses it`,
    );
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Events (append-only)
// ---------------------------------------------------------------------------

function clampDetail(detail: string | null): string | null {
  if (detail === null) return null;
  const trimmed = detail.trim();
  if (trimmed === '') return null;
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

async function recordEvent(
  db: Queryable,
  input: {
    tenantId: string;
    edgeId: string;
    event: EdgeEventType;
    detail: string | null;
    recordedBy: string;
    at: Date;
  },
): Promise<void> {
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM edge_events
       WHERE tenant_id = $1 AND edge_id = $2`,
    [input.tenantId, input.edgeId],
  );
  await db.query(
    `INSERT INTO edge_events (id, tenant_id, edge_id, position, event, detail, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newId(),
      input.tenantId,
      input.edgeId,
      next.rows[0]?.next ?? 1,
      input.event,
      input.detail,
      input.recordedBy,
      input.at,
    ],
  );
}

// ---------------------------------------------------------------------------
// Dial-home authentication (the outbound-only channel)
// ---------------------------------------------------------------------------

/**
 * Verifies a dial-home authentication: shape → edge (tenant-scoped) →
 * status → HMAC proof → per-call nonce consumption. The proof is over
 * `edge-auth:v1:<purpose>:<tenantId>:<edgeId>:<requestNonce>`; a consumed
 * request nonce is a replay and is refused.
 */
async function verifyEdgeAuth(
  purpose: 'heartbeat' | 'pull' | 'submit',
  auth: unknown,
  options: { requireConnected: boolean },
): Promise<EdgeRow> {
  const valid = validateEdgeAuthentication(purpose, auth);
  const row = await loadEdge(valid.tenantId, valid.edgeId);
  if (row.status === 'revoked') {
    throw new EdgeConnectorError(
      'edge_revoked',
      `edge runtime '${row.id}' is revoked — the dial-home channel is closed`,
    );
  }
  if (options.requireConnected && row.status !== 'connected') {
    throw new EdgeConnectorError(
      'edge_not_connected',
      `edge runtime '${row.id}' is '${row.status}' — complete a heartbeat before pulling or submitting`,
    );
  }
  const signer = requireSigner();
  const material = edgeAuthMaterial(purpose, valid);
  if (!signer.verify(row.signing_key_id, material, valid.proof)) {
    throw new EdgeConnectorError(
      'edge_authentication_failed',
      `the ${purpose} proof did not verify for edge '${row.id}' — check the enrollment key and the canonical proof material`,
    );
  }
  // Per-call nonce consumption (first write wins): a replayed dial-home
  // call is refused even though its proof verifies.
  const consumed = await getDb().query(
    `INSERT INTO edge_auth_nonces (id, tenant_id, edge_id, request_nonce, consumed_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, edge_id, request_nonce) DO NOTHING`,
    [newId(), valid.tenantId, valid.edgeId, valid.requestNonce, now()],
  );
  if ((consumed.rowCount ?? 0) === 0) {
    throw new EdgeConnectorError(
      'edge_authentication_replayed',
      `the ${purpose} request nonce '${valid.requestNonce}' was already consumed — dial-home calls are single-use`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Registration + allowlist (admin-gated)
// ---------------------------------------------------------------------------

function requireAdmin(ctx: TenantContext, operation: string): void {
  if (!ctx.authority.includes(EDGE_CONNECTOR_AUTHORITY_ADMINISTER)) {
    throw new EdgeConnectorError(
      'forbidden',
      `${operation} requires the '${EDGE_CONNECTOR_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
}

async function insertAllowlist(
  tx: Queryable,
  tenantId: string,
  edgeId: string,
  entries: ValidatedAllowlistEntry[],
  at: Date,
): Promise<void> {
  for (const entry of entries) {
    await tx.query(
      `INSERT INTO edge_capability_allowlist
         (id, tenant_id, edge_id, capability_key, mode, connectivity, secret_ref, secret_scopes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        newId(),
        tenantId,
        edgeId,
        entry.capabilityKey,
        entry.mode,
        entry.connectivity,
        entry.secretRef,
        JSON.stringify(entry.secretScopes),
        at,
      ],
    );
  }
}

async function edgeDetail(row: EdgeRow): Promise<EdgeRuntimeDetail> {
  const allowlist = (await listAllowlistRows(getDb(), row.tenant_id, row.id)).map(mapAllowlist);
  const lastHeartbeat = row.last_seen_at === null ? null : toIso(row.last_seen_at);
  return {
    runtime: mapEdge(row),
    health: healthOf(row),
    lastHeartbeatAt: lastHeartbeat,
    allowlist,
  };
}

export async function registerEdgeRuntime(
  ctx: TenantContext,
  input: RegisterEdgeRuntimeInput,
): Promise<EdgeRuntimeDetail> {
  assertEdgeTenantContext(ctx);
  requireAdmin(ctx, 'registering an edge runtime');
  const valid = validateRegisterEdgeRuntimeInput(input);
  const db = getDb();
  const at = now();

  const clash = await db.query<{ id: string }>(
    `SELECT id FROM edge_runtimes WHERE tenant_id = $1 AND name = $2`,
    [ctx.tenantId, valid.name],
  );
  if (clash.rows.length > 0) {
    throw new EdgeConnectorError(
      'edge_name_taken',
      `an edge runtime named '${valid.name}' already exists in this tenant`,
    );
  }

  const edgeId = newId();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO edge_runtimes (
         id, tenant_id, name, description, status, signing_key_id, connectivity,
         stale_after_seconds, heartbeat_interval_seconds, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb, $7, $8, $9, $10, $10)`,
      [
        edgeId,
        ctx.tenantId,
        valid.name,
        valid.description,
        valid.signingKeyId,
        JSON.stringify(valid.connectivity),
        valid.staleAfterSeconds,
        valid.heartbeatIntervalSeconds,
        ctx.principalId,
        at,
      ],
    );
    await insertAllowlist(tx, ctx.tenantId, edgeId, valid.allowlist, at);
    await recordEvent(tx, {
      tenantId: ctx.tenantId,
      edgeId,
      event: 'registered',
      detail: clampDetail(
        `edge '${valid.name}' registered with ${valid.allowlist.length} allowlisted capabilities`,
      ),
      recordedBy: ctx.principalId,
      at,
    });
  });

  return edgeDetail((await loadEdge(ctx.tenantId, edgeId))!);
}

export async function revokeEdgeRuntime(
  ctx: TenantContext,
  input: RevokeEdgeRuntimeInput,
): Promise<EdgeRuntimeDetail> {
  assertEdgeTenantContext(ctx);
  requireAdmin(ctx, 'revoking an edge runtime');
  const valid = validateRevokeEdgeRuntimeInput(input);
  const db = getDb();
  const at = now();
  const row = await loadEdge(ctx.tenantId, valid.edgeId);
  if (row.status !== 'revoked') {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE edge_runtimes
           SET status = 'revoked', revoked_at = $3, revoked_reason = $4, updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND status <> 'revoked'`,
        [ctx.tenantId, valid.edgeId, at, valid.reason, at],
      );
      await recordEvent(tx, {
        tenantId: ctx.tenantId,
        edgeId: valid.edgeId,
        event: 'revoked',
        detail: clampDetail(valid.reason ?? `edge '${row.name}' revoked`),
        recordedBy: ctx.principalId,
        at,
      });
    });
  }
  return edgeDetail(await loadEdge(ctx.tenantId, valid.edgeId));
}

export async function setEdgeAllowlist(
  ctx: TenantContext,
  input: SetEdgeAllowlistInput,
): Promise<EdgeRuntimeDetail> {
  assertEdgeTenantContext(ctx);
  requireAdmin(ctx, 'replacing an edge allowlist');
  const valid = validateSetEdgeAllowlistInput(input);
  const db = getDb();
  const at = now();
  const row = await loadEdge(ctx.tenantId, valid.edgeId);

  await db.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM edge_capability_allowlist WHERE tenant_id = $1 AND edge_id = $2`,
      [ctx.tenantId, valid.edgeId],
    );
    await insertAllowlist(tx, ctx.tenantId, valid.edgeId, valid.allowlist, at);
    await recordEvent(tx, {
      tenantId: ctx.tenantId,
      edgeId: valid.edgeId,
      event: 'allowlist-updated',
      detail: clampDetail(
        `allowlist replaced: ${valid.allowlist.length} capabilities (${valid.allowlist
          .map((entry) => entry.capabilityKey)
          .join(', ')})`,
      ),
      recordedBy: ctx.principalId,
      at,
    });
  });

  return edgeDetail((await loadEdge(ctx.tenantId, row.id))!);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getEdgeRuntime(
  ctx: TenantContext,
  query: GetEdgeRuntimeQuery,
): Promise<EdgeRuntimeDetail> {
  assertEdgeTenantContext(ctx);
  const valid = validateGetEdgeRuntimeQuery(query);
  return edgeDetail(await loadEdge(ctx.tenantId, valid.edgeId));
}

export async function listEdgeRuntimes(
  ctx: TenantContext,
  query: ListEdgeRuntimesQuery,
): Promise<EdgeRuntimeSummary[]> {
  assertEdgeTenantContext(ctx);
  const valid = validateListEdgeRuntimesQuery(query);
  const db = getDb();
  const rows = await db.query<EdgeRow>(
    `SELECT * FROM edge_runtimes WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  const summaries: EdgeRuntimeSummary[] = rows.rows.map((row) => ({
    runtime: mapEdge(row),
    health: healthOf(row),
    lastHeartbeatAt: row.last_seen_at === null ? null : toIso(row.last_seen_at),
  }));
  if (valid.health === null) return summaries;
  return summaries.filter((summary) => summary.health === valid.health);
}

export async function listEdgeHeartbeats(
  ctx: TenantContext,
  query: ListEdgeHeartbeatsQuery,
): Promise<EdgeHeartbeat[]> {
  assertEdgeTenantContext(ctx);
  const valid = validateListEdgeHeartbeatsQuery(query);
  await loadEdge(ctx.tenantId, valid.edgeId);
  const rows = await getDb().query<HeartbeatRow>(
    `SELECT * FROM edge_heartbeats
       WHERE tenant_id = $1 AND edge_id = $2
       ORDER BY received_at DESC, position DESC LIMIT $3`,
    [ctx.tenantId, valid.edgeId, valid.limit],
  );
  return rows.rows.map(mapHeartbeat);
}

export async function listEdgeEvents(
  ctx: TenantContext,
  query: ListEdgeEventsQuery,
): Promise<EdgeEvent[]> {
  assertEdgeTenantContext(ctx);
  const valid = validateListEdgeEventsQuery(query);
  await loadEdge(ctx.tenantId, valid.edgeId);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM edge_events
       WHERE tenant_id = $1 AND edge_id = $2
       ORDER BY recorded_at DESC, position DESC LIMIT $3`,
    [ctx.tenantId, valid.edgeId, valid.limit],
  );
  return rows.rows.map(mapEvent);
}

// ---------------------------------------------------------------------------
// issueEdgeJob — the dispatch (signed tenant-scoped envelopes)
// ---------------------------------------------------------------------------

export async function issueEdgeJob(
  ctx: TenantContext,
  input: IssueEdgeJobInput,
): Promise<IssueEdgeJobResult> {
  assertEdgeTenantContext(ctx);
  const valid = validateIssueEdgeJobInput(input);
  const db = getDb();
  const at = now();
  const edge = requireDispatchable(await loadEdge(ctx.tenantId, valid.edgeId), at);

  // DISPATCH-SIDE ALLOWLIST CHECK: what the edge may execute/see.
  const allowlist = await listAllowlistRows(db, ctx.tenantId, edge.id);
  requireAllowlisted(allowlist, valid.capabilityKey);

  // Idempotent replay with the deep-action RETRY discipline: a recorded
  // key replays the original outcome (first-write-wins) — UNLESS the
  // recorded attempt ended 'failed' (transient, by the W084 taxonomy) or
  // expired without executing. Those are re-issued under a
  // bounded attempt-suffixed key so a retried pipeline phase gets a
  // FRESH envelope (the failed attempts remain as evidence).
  if (valid.idempotencyKey !== null) {
    let key = valid.idempotencyKey;
    let bumps = 0;
    for (;;) {
      const existing = await db.query<JobRow>(
        `SELECT * FROM edge_jobs WHERE tenant_id = $1 AND edge_id = $2 AND job_key = $3`,
        [ctx.tenantId, edge.id, key],
      );
      const row = existing.rows[0];
      if (row === undefined) break; // a fresh attempt slot
      if (row.state !== 'failed' && row.state !== 'expired') {
        // succeeded / rejected / in-flight: the recorded outcome stands.
        return { job: mapJob(row), envelope: signedEnvelopeOf(row), created: false };
      }
      if (bumps >= MAX_IDEMPOTENT_ATTEMPTS) {
        // Too many transient attempts under this key — surface the last
        // outcome honestly instead of re-issuing forever.
        return { job: mapJob(row), envelope: signedEnvelopeOf(row), created: false };
      }
      bumps += 1;
      const next = nextAttemptKey(key);
      if (next === null || next.length > 200) {
        return { job: mapJob(row), envelope: signedEnvelopeOf(row), created: false };
      }
      key = next;
    }
    valid.idempotencyKey = key;
  }

  const jobId = newId();
  const nonce = newId();
  const envelope: EdgeJobEnvelope = {
    jobId,
    keyId: edge.signing_key_id,
    tenantId: ctx.tenantId,
    edgeId: edge.id,
    kind: valid.kind,
    capabilityKey: valid.capabilityKey,
    target: valid.target,
    payload: valid.payload,
    credentialRef: valid.credentialRef,
    systemKey: valid.systemKey,
    nonce,
    issuedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + valid.ttlSeconds * 1000).toISOString(),
  };
  const material = canonicalEnvelopeMaterial(envelope);
  const signer = requireSigner();
  const signature = signer.sign(edge.signing_key_id, material);

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO edge_jobs (
         id, tenant_id, edge_id, job_key, kind, capability_key, target, payload,
         credential_ref, system_key, state, nonce, canonical_material, signature,
         issued_at, expires_at, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'issued', $11, $12, $13, $14, $15, $16)`,
      [
        jobId,
        ctx.tenantId,
        edge.id,
        valid.idempotencyKey,
        valid.kind,
        valid.capabilityKey,
        valid.target,
        valid.payload === null ? null : JSON.stringify(valid.payload),
        valid.credentialRef,
        valid.systemKey,
        nonce,
        material,
        signature,
        at,
        new Date(at.getTime() + valid.ttlSeconds * 1000),
        ctx.principalId,
      ],
    );
    await recordEvent(tx, {
      tenantId: ctx.tenantId,
      edgeId: edge.id,
      event: 'job-issued',
      detail: clampDetail(`job ${jobId} (${valid.kind} ${valid.capabilityKey} → ${valid.target})`),
      recordedBy: ctx.principalId,
      at,
    });
  });

  const row = (await db.query<JobRow>(`SELECT * FROM edge_jobs WHERE tenant_id = $1 AND id = $2`, [
    ctx.tenantId,
    jobId,
  ])).rows[0]!;
  return { job: mapJob(row), envelope: signedEnvelopeOf(row), created: true };
}

/** Bound on re-issued attempts under one idempotency key (the retry discipline). */
const MAX_IDEMPOTENT_ATTEMPTS = 5;

const ATTEMPT_SUFFIX_PATTERN = /::retry-(\d+)$/;

/**
 * Derives the next attempt-suffixed job key ('k' → 'k::retry-2',
 * 'k::retry-N' → 'k::retry-(N+1)'); null when the suffix cannot grow.
 */
function nextAttemptKey(key: string): string | null {
  const match = ATTEMPT_SUFFIX_PATTERN.exec(key);
  if (match === null) return `${key}::retry-2`;
  const next = Number.parseInt(match[1]!, 10) + 1;
  if (!Number.isFinite(next)) return null;
  return `${key.slice(0, match.index)}::retry-${next}`;
}

function signedEnvelopeOf(row: JobRow): SignedEdgeJobEnvelope {
  const envelope = JSON.parse(row.canonical_material) as EdgeJobEnvelope;
  return { envelope, signature: row.signature };
}

export async function getEdgeJob(ctx: TenantContext, query: GetEdgeJobQuery): Promise<EdgeJob> {
  assertEdgeTenantContext(ctx);
  const valid = validateGetEdgeJobQuery(query);
  const rows = await getDb().query<JobRow>(
    `SELECT * FROM edge_jobs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.jobId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EdgeConnectorError(
      'job_not_found',
      `no edge job '${valid.jobId}' exists in this tenant`,
    );
  }
  return mapJob(row);
}

export async function listEdgeJobs(ctx: TenantContext, query: ListEdgeJobsQuery): Promise<EdgeJob[]> {
  assertEdgeTenantContext(ctx);
  const valid = validateListEdgeJobsQuery(query);
  const filters: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.edgeId !== null) {
    params.push(valid.edgeId);
    filters.push(`edge_id = $${params.length}`);
  }
  if (valid.state !== null) {
    params.push(valid.state);
    filters.push(`state = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<JobRow>(
    `SELECT * FROM edge_jobs WHERE ${filters.join(' AND ')}
       ORDER BY issued_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapJob);
}

// ---------------------------------------------------------------------------
// verifyEdgeJobEnvelope — the full Aurum-side adjudication
// ---------------------------------------------------------------------------

/**
 * Adjudicates a presented signed envelope end-to-end: signature (wired
 * signer, key id), tenant scope (the envelope must belong to the CALLING
 * tenant), edge existence, key-id match, expiry, allowlist scope, and
 * nonce/job freshness (a delivered or completed job's envelope is a
 * REPLAY). Returns the job the envelope addresses.
 */
export async function verifyEdgeJobEnvelope(
  ctx: TenantContext,
  signed: SignedEdgeJobEnvelope,
): Promise<{ job: EdgeJob }> {
  assertEdgeTenantContext(ctx);
  const valid = validateVerifyEdgeJobEnvelopeInput(signed);
  const signer = requireSigner();
  const { envelope, signature } = valid.envelope;

  if (!verifyEnvelopeSignature(envelope, signature, signer)) {
    throw new EdgeConnectorError(
      'invalid_envelope',
      'the envelope signature did not verify against the wired signer',
    );
  }
  if (envelope.tenantId !== ctx.tenantId) {
    throw new EdgeConnectorError(
      'invalid_envelope',
      'the envelope is scoped to another tenant',
    );
  }
  const edge = await loadEdge(ctx.tenantId, envelope.edgeId);
  if (edge.signing_key_id !== envelope.keyId) {
    throw new EdgeConnectorError(
      'invalid_envelope',
      `the envelope's key id '${envelope.keyId}' does not match the edge's enrollment key '${edge.signing_key_id}'`,
    );
  }
  if (new Date(envelope.expiresAt).getTime() <= now().getTime()) {
    throw new EdgeConnectorError(
      'job_expired',
      `the envelope expired at ${envelope.expiresAt}`,
    );
  }
  const allowlist = await listAllowlistRows(getDb(), ctx.tenantId, edge.id);
  requireAllowlisted(allowlist, envelope.capabilityKey);

  const rows = await getDb().query<JobRow>(
    `SELECT * FROM edge_jobs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, envelope.jobId],
  );
  const row = rows.rows[0];
  if (row === undefined || row.nonce !== envelope.nonce) {
    throw new EdgeConnectorError(
      'job_not_found',
      `no edge job matches the presented envelope`,
    );
  }
  if (row.state !== 'issued') {
    throw new EdgeConnectorError(
      'job_replayed',
      `the envelope's nonce was already consumed (job is '${row.state}') — replays are refused on both sides of the boundary`,
    );
  }
  return { job: mapJob(row) };
}

// ---------------------------------------------------------------------------
// Dial-home: heartbeat (health/version reporting)
// ---------------------------------------------------------------------------

export async function sendEdgeHeartbeat(
  auth: EdgeAuthentication,
  report: EdgeHeartbeatReport,
): Promise<EdgeHeartbeatResult> {
  const edge = await verifyEdgeAuth('heartbeat', auth, { requireConnected: false });
  const valid = validateEdgeHeartbeatReport(report);
  const db = getDb();
  const at = now();
  const heartbeatId = newId();

  await db.transaction(async (tx) => {
    const next = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM edge_heartbeats
         WHERE tenant_id = $1 AND edge_id = $2`,
      [edge.tenant_id, edge.id],
    );
    await tx.query(
      `INSERT INTO edge_heartbeats
         (id, tenant_id, edge_id, position, reported_version, reported_capabilities, reported_pending_jobs, received_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        heartbeatId,
        edge.tenant_id,
        edge.id,
        next.rows[0]?.next ?? 1,
        valid.version,
        JSON.stringify(valid.capabilities ?? edge.connectivity),
        valid.pendingJobs,
        at,
      ],
    );
    await tx.query(
      `UPDATE edge_runtimes
         SET status = 'connected', last_seen_at = $3, reported_version = $4,
             reported_capabilities = $5::jsonb, updated_at = $6
       WHERE tenant_id = $1 AND id = $2`,
      [
        edge.tenant_id,
        edge.id,
        at,
        valid.version,
        JSON.stringify(valid.capabilities ?? edge.connectivity),
        at,
      ],
    );
    await recordEvent(tx, {
      tenantId: edge.tenant_id,
      edgeId: edge.id,
      event: 'heartbeat-received',
      detail: clampDetail(`heartbeat v${valid.version}${valid.pendingJobs !== null ? `, ${valid.pendingJobs} pending` : ''}`),
      recordedBy: edge.id,
      at,
    });
  });

  const heartbeatRow = (
    await db.query<HeartbeatRow>(
      `SELECT * FROM edge_heartbeats WHERE tenant_id = $1 AND id = $2`,
      [edge.tenant_id, heartbeatId],
    )
  ).rows[0]!;
  const runtimeRow = await loadEdge(edge.tenant_id, edge.id);
  return { heartbeat: mapHeartbeat(heartbeatRow), runtime: mapEdge(runtimeRow) };
}

// ---------------------------------------------------------------------------
// Dial-home: pull (the outbound-only job delivery)
// ---------------------------------------------------------------------------

export async function pullPendingEdgeJobs(
  auth: EdgeAuthentication,
  input: PullPendingEdgeJobsInput,
): Promise<PullPendingEdgeJobsResult> {
  const edge = await verifyEdgeAuth('pull', auth, { requireConnected: true });
  const valid = validatePullPendingEdgeJobsInput(input);
  const db = getDb();
  const at = now();

  // Sweep expired envelopes first (forward-only hygiene).
  const expired = await db.query<{ id: string }>(
    `UPDATE edge_jobs SET state = 'expired'
       WHERE tenant_id = $1 AND edge_id = $2 AND state IN ('issued', 'delivered') AND expires_at <= $3
       RETURNING id`,
    [edge.tenant_id, edge.id, at],
  );
  const expiredIds = expired.rows.map((row) => row.id);
  if (expiredIds.length > 0) {
    await db.transaction(async (tx) => {
      for (const jobId of expiredIds) {
        await recordEvent(tx, {
          tenantId: edge.tenant_id,
          edgeId: edge.id,
          event: 'job-expired',
          detail: clampDetail(`job ${jobId} expired before completing`),
          recordedBy: edge.id,
          at,
        });
      }
    });
  }

  // Deliver the oldest issued envelopes (mark 'delivered', first write wins).
  const delivered = await db.transaction(async (tx) => {
    const pending = await tx.query<JobRow>(
      `SELECT * FROM edge_jobs
         WHERE tenant_id = $1 AND edge_id = $2 AND state = 'issued'
         ORDER BY issued_at ASC, id ASC LIMIT $3`,
      [edge.tenant_id, edge.id, valid.limit],
    );
    const envelopes: SignedEdgeJobEnvelope[] = [];
    for (const row of pending.rows) {
      const updated = await tx.query<JobRow>(
        `UPDATE edge_jobs SET state = 'delivered', delivered_at = $3
           WHERE tenant_id = $1 AND id = $2 AND state = 'issued'
         RETURNING *`,
        [edge.tenant_id, row.id, at],
      );
      if (updated.rows[0] !== undefined) {
        envelopes.push(signedEnvelopeOf(updated.rows[0]));
        await recordEvent(tx, {
          tenantId: edge.tenant_id,
          edgeId: edge.id,
          event: 'job-delivered',
          detail: clampDetail(`job ${row.id} pulled over the dial-home link`),
          recordedBy: edge.id,
          at,
        });
      }
    }
    return envelopes;
  });

  return { envelopes: delivered, expiredCount: expiredIds.length };
}

// ---------------------------------------------------------------------------
// Dial-home: submit (the normalized result)
// ---------------------------------------------------------------------------

export async function submitEdgeJobResult(
  auth: EdgeAuthentication,
  input: SubmitEdgeJobResultInput,
): Promise<SubmitEdgeJobResultResult> {
  const edge = await verifyEdgeAuth('submit', auth, { requireConnected: true });
  const valid = validateSubmitEdgeJobResultInput(input);
  const db = getDb();
  const at = now();

  const rows = await db.query<JobRow>(
    `SELECT * FROM edge_jobs WHERE tenant_id = $1 AND id = $2`,
    [edge.tenant_id, valid.jobId],
  );
  let row = rows.rows[0];
  if (row === undefined || row.edge_id !== edge.id) {
    throw new EdgeConnectorError(
      'job_not_found',
      `no edge job '${valid.jobId}' is addressable by this edge in this tenant`,
    );
  }
  if (row.state === 'expired') {
    throw new EdgeConnectorError(
      'job_expired',
      `edge job '${row.id}' expired before this result arrived`,
    );
  }
  if (row.state !== 'issued' && row.state !== 'delivered') {
    // Idempotent first-write-wins: a repeated submission returns the
    // original outcome, never a second effect.
    return { job: mapJob(row), submitted: false };
  }

  // CANONICALIZATION: plain JSON only — a provider object (class
  // instance, symbol, cycle, oversized body) cannot cross the boundary.
  const result = valid.result;
  if (!isPlainJsonValue(result.state?.state ?? null) || !isPlainJsonValue(result.receipt)) {
    throw new EdgeConnectorError(
      'invalid_edge_result',
      `the submitted result for job '${row.id}' is not plain JSON — provider objects never cross the edge boundary`,
    );
  }
  if (JSON.stringify(result).length > 262_144 * 2) {
    throw new EdgeConnectorError(
      'invalid_edge_result',
      `the submitted result for job '${row.id}' is oversized — large artifacts belong in object storage`,
    );
  }
  const stateJson =
    row.kind === 'inspect' && result.state !== null
      ? JSON.stringify({ found: result.state.found, state: result.state.state ?? null })
      : null;
  if (row.kind === 'inspect' && result.receipt.status === 'accepted' && result.state === null) {
    throw new EdgeConnectorError(
      'invalid_input',
      `an accepted inspect result for job '${row.id}' must carry its normalized read state`,
    );
  }

  const jobState: EdgeJobState =
    result.receipt.status === 'accepted' ? 'succeeded' : result.receipt.status === 'rejected' ? 'rejected' : 'failed';
  const eventType: EdgeEventType =
    jobState === 'succeeded' ? 'job-succeeded' : jobState === 'rejected' ? 'job-rejected' : 'job-failed';

  await db.transaction(async (tx) => {
    const updated = await tx.query<JobRow>(
      `UPDATE edge_jobs
         SET state = $3, receipt_status = $4, receipt_id = $5, receipt_detail = $6,
             result_state = $7::jsonb, completed_at = $8
       WHERE tenant_id = $1 AND id = $2 AND state IN ('issued', 'delivered')
       RETURNING *`,
      [
        edge.tenant_id,
        row!.id,
        jobState,
        result.receipt.status,
        result.receipt.receiptId,
        result.receipt.detail,
        stateJson,
        at,
      ],
    );
    const after = updated.rows[0];
    if (after !== undefined) {
      row = after;
      await recordEvent(tx, {
        tenantId: edge.tenant_id,
        edgeId: edge.id,
        event: eventType,
        detail: clampDetail(
          `job ${after.id} ${jobState}${result.receipt.receiptId !== null ? ` (receipt ${result.receipt.receiptId})` : ''}`,
        ),
        recordedBy: edge.id,
        at,
      });
    }
  });

  return { job: mapJob(row!), submitted: true };
}

// ---------------------------------------------------------------------------
// Result canonicality helper shared with the transport (exported for tests)
// ---------------------------------------------------------------------------

/** Is this value plain JSON (no provider objects)? Pure check. */
export function isCanonicalEdgeValue(value: unknown): boolean {
  return isPlainJsonValue(value);
}

/** The canonical JSON form (re-export of the envelope core for callers). */
export { canonicalJson };
