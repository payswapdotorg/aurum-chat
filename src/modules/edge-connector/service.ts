// The edge-connector service (W088 — Aurum Edge Connector): the
// GATEWAY side of the claim protocol plus the deep-action transport
// adapter that rides it.
//
// W088 acceptance, clause by clause, mapped to this surface:
//
//   * OUTBOUND-ONLY CONNECTION WHERE POSSIBLE — the gateway NEVER
//     reaches into an edge. Jobs wait as 'pending' until an edge CALLS
//     claimEdgeJobs for its tenant + allowlist scope (the claim lease +
//     reclaim sweep is the whole inbound surface: one direction, edge →
//     gateway). The DeepActionTransport adapter below is the
//     gateway-side half of the seam: it submits and AWAITS the edge's
//     normalized report.
//
//   * SIGNED TENANT-SCOPED JOBS — submitEdgeJob freezes a versioned,
//     tenant-scoped, capability-declared, idempotency-keyed envelope and
//     signs it with the WIRED signer (HMAC-SHA256; the secret is wiring
//     configuration, never persisted — rows record only signerKeyRef).
//     No signer wired → `signer_unavailable`, never a fake unsigned job.
//     Replay of an already-executed idempotency key returns the recorded
//     result; a 'failed' job (no external effect taken) re-drives.
//
//   * LOCAL SECRET HANDLING — the gateway stores only the edge token's
//     SHA-256 DIGEST and the opaque credentialRefs envelopes carry; no
//     secret VALUE ever reaches a table, event or error here.
//
//   * CAPABILITY ALLOWLIST — registrations declare the capability keys
//     an edge will execute (open vocabulary, append-only audited); the
//     CLAIM is scoped by the recorded allowlist, and the edge re-checks
//     its OWN allowlist before executing (defense in depth — a refusal
//     is flagged here on report as job status 'refused' + evidence).
//
//   * HEALTH/VERSION REPORTING — reportEdgeHeartbeat appends the
//     status event (version, allowlist digest, last-job stats) and
//     moves the registration's report columns; the reads resolve a
//     silent edge as 'stale', honestly rendered (health.ts).
//
//   * RESULT NORMALIZATION — reportEdgeJobResult accepts only CANONICAL
//     deep-action results; a provider-shaped payload is rejected loudly
//     (`invalid_edge_result` — the invalid_transport_result discipline
//     at this module's own boundary) and nothing is persisted.
//
//   * NO SECOND ORGANIZATIONAL TRUTH STORE — every durable fact of the
//     edge program lives in this module's tenant-scoped PostgreSQL
//     tables (registrations, allowlist audit, status events, signed
//     jobs + lifecycle events). The edge holds only in-flight scratch.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's edges, jobs,
// health or audit rows are indistinguishable from missing
// (`edge_not_found` / `job_not_found`) — no existence leak.

import { createHash, createHmac } from 'node:crypto';
import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import type {
  DeepActionExecuteRequest,
  DeepActionInspectRequest,
  DeepActionReceipt,
  DeepActionState,
  DeepActionTransport,
} from '@/modules/deep-actions/contract';
import { EdgeConnectorError } from './errors';
import { allowlistDigestOf, envelopeDigest, signEnvelope } from './envelope';
import { DEFAULT_LEASE_MS, resolveEdgeHealthView } from './health';
import { normalizeEdgeJobResult } from './normalize';
import type {
  ClaimEdgeJobsInput,
  ClaimEdgeJobsResult,
  EdgeAllowlistEventView,
  EdgeDispatchTransportConfig,
  EdgeJobEnvelope,
  EdgeJobEventView,
  EdgeJobKind,
  EdgeJobResult,
  EdgeJobSigner,
  EdgeJobStatus,
  EdgeJobView,
  EdgeRegistrationView,
  EdgeRuntimeStats,
  EdgeStatusEventView,
  GetEdgeJobQuery,
  GetEdgeQuery,
  HeartbeatInput,
  ListEdgeAllowlistEventsQuery,
  ListEdgeJobsQuery,
  ListEdgeJobEventsQuery,
  ListEdgeStatusEventsQuery,
  ListEdgesQuery,
  RegisterEdgeInput,
  RegisterEdgeResult,
  ReportEdgeJobInput,
  ReportEdgeJobResult,
  RetireEdgeInput,
  SubmitEdgeJobInput,
  SubmitEdgeJobResult,
  SignedEdgeJob,
  UpdateEdgeAllowlistInput,
} from './types';
import {
  assertEdgeTenantContext,
  checkAllowlist,
  validateClaimEdgeJobsInput,
  validateEdgeFeedQuery,
  validateGetEdgeQuery,
  validateHeartbeatInput,
  validateIdQuery,
  validateJobFeedQuery,
  validateListEdgeJobsQuery,
  validateListEdgesQuery,
  validateRegisterEdgeInput,
  validateReportEdgeJobInput,
  validateRetireInput,
  validateSubmitEdgeJobInput,
  validateUpdateAllowlistInput,
} from './validation';

// ---------------------------------------------------------------------------
// Module-owned constants
// ---------------------------------------------------------------------------

/** The transport adapter's default result-poll interval (ms). */
export const DEFAULT_TRANSPORT_POLL_MS = 250;
/** The transport adapter's default give-up horizon (ms). */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// The signer wiring (infrastructure, not domain state)
// ---------------------------------------------------------------------------

let wiredSigner: EdgeJobSigner | null = null;

/**
 * An HMAC-SHA256 signer factory: the secret lives ONLY in the returned
 * closure (wiring configuration); nothing else ever sees it. The keyRef
 * is the wiring identity recorded on signed jobs.
 */
export function createHmacSigner(config: { secret: string; keyRef: string }): EdgeJobSigner {
  if (typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new EdgeConnectorError(
      'invalid_input',
      'an edge-job signing secret must be at least 16 characters (wiring configuration, never persisted)',
    );
  }
  if (typeof config.keyRef !== 'string' || config.keyRef.length === 0 || config.keyRef.length > 64) {
    throw new EdgeConnectorError(
      'invalid_input',
      "a signer keyRef must be 1..64 characters (the wiring identity recorded on jobs)",
    );
  }
  return {
    keyRef: config.keyRef,
    sign: (payload: Buffer): string =>
      createHmac('sha256', config.secret).update(payload).digest('hex'),
  };
}

/** Wires (or clears) the gateway-side job signer — the signing seam. */
export function setEdgeJobSigner(signer: EdgeJobSigner | null): void {
  wiredSigner = signer;
}

/** The currently wired job signer (null = none). */
export function getEdgeJobSigner(): EdgeJobSigner | null {
  return wiredSigner;
}

function requireSigner(): EdgeJobSigner {
  if (wiredSigner === null) {
    throw new EdgeConnectorError(
      'signer_unavailable',
      'no edge-job signer is wired — setEdgeJobSigner first; the gateway refuses to submit unsigned jobs',
    );
  }
  return wiredSigner;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface EdgeRow extends DbRow {
  id: string;
  tenant_id: string;
  edge_key: string;
  label: string;
  system_class: string;
  version: string;
  status: 'active' | 'retired';
  allowlist: string[];
  allowlist_digest: string;
  token_digest: string;
  last_seen_at: Date | string | null;
  reported_version: string | null;
  reported_allowlist_digest: string | null;
  jobs_claimed: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_refused: number;
  last_job_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface JobRow extends DbRow {
  id: string;
  tenant_id: string;
  job_key: string;
  edge_id: string;
  edge_key: string;
  kind: EdgeJobKind;
  system_class: string;
  capability_key: string;
  envelope: EdgeJobEnvelope;
  envelope_digest: string;
  signature: string;
  signer_key_ref: string;
  status: EdgeJobStatus;
  attempts: number;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  lease_expires_at: Date | string | null;
  result: EdgeJobResult | null;
  failure_reason: string | null;
  refusal_reason: string | null;
  reported_by: string | null;
  reported_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface JobEventRow extends DbRow {
  id: string;
  tenant_id: string;
  job_id: string;
  position: number;
  event: string;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

interface StatusEventRow extends DbRow {
  id: string;
  tenant_id: string;
  edge_id: string;
  event: string;
  version: string | null;
  allowlist_digest: string | null;
  stats: EdgeRuntimeStats | null;
  detail: string | null;
  recorded_by: string;
  occurred_at: Date | string;
}

interface AllowlistEventRow extends DbRow {
  id: string;
  tenant_id: string;
  edge_id: string;
  change: 'added' | 'removed';
  capability_key: string;
  note: string | null;
  recorded_by: string;
  occurred_at: Date | string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapRegistration(row: EdgeRow): EdgeRegistrationView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeKey: row.edge_key,
    label: row.label,
    systemClass: row.system_class,
    version: row.version,
    status: row.status,
    allowlist: row.allowlist,
    allowlistDigest: row.allowlist_digest,
    stats: {
      jobsClaimed: row.jobs_claimed,
      jobsSucceeded: row.jobs_succeeded,
      jobsFailed: row.jobs_failed,
      jobsRefused: row.jobs_refused,
      lastJobAt: toIso(row.last_job_at),
    },
    health: resolveEdgeHealthView({
      lastSeenAt: row.last_seen_at,
      reportedVersion: row.reported_version,
      reportedAllowlistDigest: row.reported_allowlist_digest,
      recordedAllowlistDigest: row.allowlist_digest,
      now: now(),
    }),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapJob(row: JobRow): EdgeJobView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    edgeKey: row.edge_key,
    kind: row.kind,
    systemClass: row.system_class,
    capabilityKey: row.capability_key,
    idempotencyKey: row.job_key,
    status: row.status,
    attempts: row.attempts,
    claimedBy: row.claimed_by,
    claimedAt: toIso(row.claimed_at),
    leaseExpiresAt: toIso(row.lease_expires_at),
    result: row.result,
    failureReason: row.failure_reason,
    refusalReason: row.refusal_reason,
    reportedAt: toIso(row.reported_at),
    envelope: row.envelope,
    envelopeDigest: row.envelope_digest,
    signature: row.signature,
    signerKeyRef: row.signer_key_ref,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapJobEvent(row: JobEventRow): EdgeJobEventView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    jobId: row.job_id,
    position: row.position,
    event: row.event as EdgeJobEventView['event'],
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at)!,
  };
}

function mapStatusEvent(row: StatusEventRow): EdgeStatusEventView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    event: row.event as EdgeStatusEventView['event'],
    version: row.version,
    allowlistDigest: row.allowlist_digest,
    stats: row.stats,
    detail: row.detail,
    recordedBy: row.recorded_by,
    occurredAt: toIso(row.occurred_at)!,
  };
}

function mapAllowlistEvent(row: AllowlistEventRow): EdgeAllowlistEventView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    change: row.change,
    capabilityKey: row.capability_key,
    note: row.note,
    recordedBy: row.recorded_by,
    occurredAt: toIso(row.occurred_at)!,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Tenant-scoped registration lookup; missing ≡ cross-tenant (no leak). */
async function requireEdgeRow(
  context: TenantContext,
  edgeKey: string,
): Promise<EdgeRow> {
  const rows = await getDb().query<EdgeRow>(
    `SELECT * FROM edge_registrations WHERE tenant_id = $1 AND edge_key = $2`,
    [context.tenantId, edgeKey],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EdgeConnectorError(
      'edge_not_found',
      `no edge runtime '${edgeKey}' is registered for this tenant`,
    );
  }
  return row;
}

/** Verifies the edge token against the stored DIGEST (value never stored). */
function verifyEdgeToken(row: EdgeRow, edgeToken: string): void {
  if (sha256Hex(edgeToken) !== row.token_digest) {
    throw new EdgeConnectorError(
      'edge_token_invalid',
      `the edge token does not verify for edge '${row.edge_key}' (only its SHA-256 digest is known here)`,
    );
  }
}

/** Tenant-scoped job lookup; missing ≡ cross-tenant (no leak). */
async function findJobRow(db: Queryable, context: TenantContext, jobId: string): Promise<JobRow | null> {
  const rows = await db.query<JobRow>(
    `SELECT * FROM edge_jobs WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, jobId],
  );
  return rows.rows[0] ?? null;
}

/** Appends one job lifecycle event (monotonic per-job position). */
async function recordJobEvent(
  db: Queryable,
  context: TenantContext,
  jobId: string,
  event: EdgeJobEventView['event'],
  detail: string | null,
  recordedBy: string,
): Promise<void> {
  const at = now();
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next
       FROM edge_job_events WHERE tenant_id = $1 AND job_id = $2`,
    [context.tenantId, jobId],
  );
  await db.query(
    `INSERT INTO edge_job_events (id, tenant_id, job_id, position, event, detail, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), context.tenantId, jobId, next.rows[0]?.next ?? 1, event, detail, recordedBy, at],
  );
}

/** Appends one edge status event (health evidence; per-edge position). */
async function recordStatusEvent(
  db: Queryable,
  context: TenantContext,
  edgeId: string,
  event: EdgeStatusEventView['event'],
  payload: { version?: string | null; allowlistDigest?: string | null; stats?: EdgeRuntimeStats | null; detail?: string | null },
): Promise<void> {
  const at = now();
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next
       FROM edge_health_events WHERE tenant_id = $1 AND edge_id = $2`,
    [context.tenantId, edgeId],
  );
  await db.query(
    `INSERT INTO edge_health_events (id, tenant_id, edge_id, event, version, allowlist_digest, stats, detail, recorded_by, occurred_at, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      newId(),
      context.tenantId,
      edgeId,
      event,
      payload.version ?? null,
      payload.allowlistDigest ?? null,
      payload.stats === undefined || payload.stats === null ? null : JSON.stringify(payload.stats),
      payload.detail ?? null,
      context.principalId,
      at,
      next.rows[0]?.next ?? 1,
    ],
  );
}

/** The next per-edge position of the allowlist audit feed. */
async function nextAllowlistPosition(
  db: Queryable,
  context: TenantContext,
  edgeId: string,
): Promise<number> {
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next
       FROM edge_allowlist_events WHERE tenant_id = $1 AND edge_id = $2`,
    [context.tenantId, edgeId],
  );
  return next.rows[0]?.next ?? 1;
}

function isTerminal(status: EdgeJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'refused';
}

/**
 * True when a job's outcome is FINAL (a replay of its idempotency key
 * returns the recorded outcome verbatim). A 'failed' job is NOT final:
 * no external effect was taken, so its key re-drives for a fresh attempt.
 */
function isFinal(status: EdgeJobStatus): boolean {
  return status === 'succeeded' || status === 'refused';
}

// ---------------------------------------------------------------------------
// Registration lifecycle
// ---------------------------------------------------------------------------

/**
 * Registers (or refuses to re-register) one customer-controlled edge
 * runtime: a broker-connection-CLASS record — tenant-scoped, open
 * vocabulary keys, opaque references only. The edge token is stored ONLY
 * as its SHA-256 digest; the initial allowlist is audited as 'added'
 * rows; a duplicate (tenant, edgeKey) is a loud `edge_conflict` (a
 * changed edge is a NEW key — retire the old one).
 */
export async function registerEdgeRuntime(
  context: TenantContext,
  input: RegisterEdgeInput,
): Promise<RegisterEdgeResult> {
  assertEdgeTenantContext(context);
  const valid = validateRegisterEdgeInput(input);
  const db = getDb();
  const at = now();

  const existing = await db.query<EdgeRow>(
    `SELECT * FROM edge_registrations WHERE tenant_id = $1 AND edge_key = $2`,
    [context.tenantId, valid.edgeKey],
  );
  if (existing.rows.length > 0) {
    throw new EdgeConnectorError(
      'edge_conflict',
      `edge runtime '${valid.edgeKey}' is already registered for this tenant — retire it and register a new key instead (identity columns are frozen)`,
    );
  }

  const edgeId = newId();
  const digest = allowlistDigestOf(valid.allowlist);
  try {
    await db.query(
      `INSERT INTO edge_registrations (
         id, tenant_id, edge_key, label, system_class, version, status,
         allowlist, allowlist_digest, token_digest, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, $8, $9, $10, $11, $11)`,
      [
        edgeId,
        context.tenantId,
        valid.edgeKey,
        valid.label,
        valid.systemClass,
        valid.version,
        JSON.stringify(valid.allowlist),
        digest,
        sha256Hex(valid.edgeToken),
        context.principalId,
        at,
      ],
    );
  } catch (error) {
    // A concurrent registration of the same key: first write wins.
    if ((error as { code?: string }).code === '23505') {
      throw new EdgeConnectorError(
        'edge_conflict',
        `edge runtime '${valid.edgeKey}' is already registered for this tenant`,
      );
    }
    throw error;
  }

  await recordStatusEvent(db, context, edgeId, 'registered', {
    version: valid.version,
    allowlistDigest: digest,
    detail: `edge '${valid.edgeKey}' registered (${valid.allowlist.length} capability keys, class '${valid.systemClass}')`,
  });
  let position = await nextAllowlistPosition(db, context, edgeId);
  for (const key of valid.allowlist) {
    await db.query(
      `INSERT INTO edge_allowlist_events (id, tenant_id, edge_id, change, capability_key, note, recorded_by, occurred_at, position)
         VALUES ($1, $2, $3, 'added', $4, $5, $6, $7, $8)`,
      [newId(), context.tenantId, edgeId, key, 'initial registration', context.principalId, at, position],
    );
    position += 1;
  }

  const row = (await db.query<EdgeRow>(`SELECT * FROM edge_registrations WHERE tenant_id = $1 AND id = $2`, [
    context.tenantId,
    edgeId,
  ])).rows[0]!;
  return { registration: mapRegistration(row), created: true };
}

/** Retires one edge runtime (terminal; its pending jobs await a new edge). */
export async function retireEdgeRuntime(
  context: TenantContext,
  input: RetireEdgeInput,
): Promise<{ registration: EdgeRegistrationView }> {
  assertEdgeTenantContext(context);
  const valid = validateRetireInput(input);
  const db = getDb();
  const at = now();
  const rows = await db.query<EdgeRow>(
    `UPDATE edge_registrations SET status = 'retired', updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'active'
       RETURNING *`,
    [context.tenantId, valid.edgeId, at],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EdgeConnectorError('edge_not_found', 'no active edge runtime with this id for this tenant');
  }
  await recordStatusEvent(db, context, row.id, 'retired', {
    detail: `edge '${row.edge_key}' retired`,
  });
  return { registration: mapRegistration(row) };
}

/**
 * Changes one edge's recorded allowlist — APPEND-ONLY AUDITED: every
 * added/removed capability key lands in edge_allowlist_events, and the
 * change itself is a status event. (The edge's LOCAL allowlist remains
 * the real enforcement; a diverged digest surfaces as health drift.)
 */
export async function updateEdgeAllowlist(
  context: TenantContext,
  input: UpdateEdgeAllowlistInput,
): Promise<{ registration: EdgeRegistrationView }> {
  assertEdgeTenantContext(context);
  const valid = validateUpdateAllowlistInput(input);
  const db = getDb();
  const at = now();

  const current = (
    await db.query<EdgeRow>(`SELECT * FROM edge_registrations WHERE tenant_id = $1 AND id = $2`, [
      context.tenantId,
      valid.edgeId,
    ])
  ).rows[0];
  if (current === undefined) {
    throw new EdgeConnectorError('edge_not_found', 'no edge runtime with this id for this tenant');
  }
  if (current.status !== 'active') {
    throw new EdgeConnectorError('edge_retired', 'a retired edge runtime cannot change its allowlist');
  }

  const removed = new Set(valid.remove);
  const next = [...current.allowlist.filter((key) => !removed.has(key)), ...valid.add];
  checkAllowlist(next, 'allowlist');

  const digest = allowlistDigestOf(next);
  const rows = await db.query<EdgeRow>(
    `UPDATE edge_registrations SET allowlist = $3::jsonb, allowlist_digest = $4, updated_at = $5
       WHERE tenant_id = $1 AND id = $2 AND status = 'active'
       RETURNING *`,
    [context.tenantId, valid.edgeId, JSON.stringify(next), digest, at],
  );
  const row = rows.rows[0]!;

  let position = await nextAllowlistPosition(db, context, valid.edgeId);
  for (const key of valid.remove) {
    await db.query(
      `INSERT INTO edge_allowlist_events (id, tenant_id, edge_id, change, capability_key, note, recorded_by, occurred_at, position)
         VALUES ($1, $2, $3, 'removed', $4, $5, $6, $7, $8)`,
      [newId(), context.tenantId, valid.edgeId, key, valid.note, context.principalId, at, position],
    );
    position += 1;
  }
  for (const key of valid.add) {
    await db.query(
      `INSERT INTO edge_allowlist_events (id, tenant_id, edge_id, change, capability_key, note, recorded_by, occurred_at, position)
         VALUES ($1, $2, $3, 'added', $4, $5, $6, $7, $8)`,
      [newId(), context.tenantId, valid.edgeId, key, valid.note, context.principalId, at, position],
    );
    position += 1;
  }
  await recordStatusEvent(db, context, valid.edgeId, 'allowlist-changed', {
    allowlistDigest: digest,
    detail: `allowlist changed: +${valid.add.length} / -${valid.remove.length} (now ${next.length} keys)`,
  });
  return { registration: mapRegistration(row) };
}

// ---------------------------------------------------------------------------
// Registration reads (honest health rendering)
// ---------------------------------------------------------------------------

export async function getEdgeRuntime(
  context: TenantContext,
  query: GetEdgeQuery,
): Promise<{ registration: EdgeRegistrationView }> {
  assertEdgeTenantContext(context);
  const valid = validateGetEdgeQuery(query);
  const db = getDb();
  const rows =
    valid.edgeId !== null
      ? await db.query<EdgeRow>(`SELECT * FROM edge_registrations WHERE tenant_id = $1 AND id = $2`, [
          context.tenantId,
          valid.edgeId,
        ])
      : await db.query<EdgeRow>(
          `SELECT * FROM edge_registrations WHERE tenant_id = $1 AND edge_key = $2`,
          [context.tenantId, valid.edgeKey],
        );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EdgeConnectorError('edge_not_found', 'no edge runtime with this id or key for this tenant');
  }
  return { registration: mapRegistration(row) };
}

export async function listEdgeRuntimes(
  context: TenantContext,
  query: ListEdgesQuery,
): Promise<{ edges: EdgeRegistrationView[] }> {
  assertEdgeTenantContext(context);
  const valid = validateListEdgesQuery(query);
  const db = getDb();
  const rows = await db.query<EdgeRow>(
    `SELECT * FROM edge_registrations WHERE tenant_id = $1
       ${valid.status !== null ? 'AND status = $2' : ''}
       ORDER BY created_at DESC, id DESC LIMIT ${valid.limit}`,
    valid.status !== null ? [context.tenantId, valid.status] : [context.tenantId],
  );
  return { edges: rows.rows.map(mapRegistration) };
}

// ---------------------------------------------------------------------------
// Job submission (the signed envelope)
// ---------------------------------------------------------------------------

/**
 * Submits one job to an edge: freezes the versioned, tenant-scoped,
 * capability-declared, idempotency-keyed envelope and signs it with the
 * wired signer. FIRST WRITE WINS on the idempotency key:
 *   * a TERMINAL (succeeded/refused) job replays its recorded outcome
 *     verbatim — never a second external effect;
 *   * a FAILED job (no external effect taken) re-drives to 'pending';
 *   * a live (pending/claimed) job returns as-is.
 */
export async function submitEdgeJob(
  context: TenantContext,
  input: SubmitEdgeJobInput,
): Promise<SubmitEdgeJobResult> {
  assertEdgeTenantContext(context);
  const valid = validateSubmitEdgeJobInput(input);
  const db = getDb();
  const at = now();

  const edge = await requireEdgeRow(context, valid.edgeKey);
  if (edge.status !== 'active') {
    throw new EdgeConnectorError(
      'edge_retired',
      `edge runtime '${valid.edgeKey}' is retired — jobs cannot be submitted to it`,
    );
  }
  const signer = requireSigner();

  const existing = (
    await db.query<JobRow>(`SELECT * FROM edge_jobs WHERE tenant_id = $1 AND job_key = $2`, [
      context.tenantId,
      valid.idempotencyKey,
    ])
  ).rows[0];
  if (existing !== undefined) {
    if (isFinal(existing.status)) {
      await recordJobEvent(db, context, existing.id, 'replayed', `idempotency key replayed (status '${existing.status}')`, context.principalId);
      return { job: mapJob(existing), created: false, replayed: true };
    }
    if (existing.status === 'failed') {
      // No external effect was taken — the key re-drives for a fresh attempt.
      const rows = await db.query<JobRow>(
        `UPDATE edge_jobs SET status = 'pending', result = NULL,
           failure_reason = NULL, refusal_reason = NULL, reported_by = NULL, reported_at = NULL,
           claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'failed'
           RETURNING *`,
        [context.tenantId, existing.id, at],
      );
      await recordJobEvent(db, context, existing.id, 'redriven', 'failed job re-driven through its idempotency key', context.principalId);
      const job = rows.rows[0] ?? existing;
      return { job: mapJob(job), created: false, replayed: false };
    }
    return { job: mapJob(existing), created: false, replayed: false };
  }

  const jobId = newId();
  const envelope: EdgeJobEnvelope = {
    v: 1,
    jobId,
    tenantId: context.tenantId,
    edgeKey: valid.edgeKey,
    systemClass: edge.system_class,
    kind: valid.kind,
    capabilityKey: valid.capabilityKey,
    idempotencyKey: valid.idempotencyKey,
    request: valid.request,
    submittedAt: at.toISOString(),
    submittedBy: context.principalId,
  };
  const signed = signEnvelope(envelope, signer);
  const digest = envelopeDigest(envelope);

  try {
    await db.query(
      `INSERT INTO edge_jobs (
         id, tenant_id, job_key, edge_id, edge_key, kind, system_class, capability_key,
         envelope, envelope_digest, signature, signer_key_ref, status, attempts,
         created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, 'pending', 0, $13, $14, $14)`,
      [
        jobId,
        context.tenantId,
        valid.idempotencyKey,
        edge.id,
        valid.edgeKey,
        valid.kind,
        edge.system_class,
        valid.capabilityKey,
        JSON.stringify(envelope),
        digest,
        signed.signature,
        signed.signerKeyRef,
        context.principalId,
        at,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      // A concurrent submit of the same key: first write wins — replay it.
      const winner = (
        await db.query<JobRow>(`SELECT * FROM edge_jobs WHERE tenant_id = $1 AND job_key = $2`, [
          context.tenantId,
          valid.idempotencyKey,
        ])
      ).rows[0]!;
      return { job: mapJob(winner), created: false, replayed: isFinal(winner.status) };
    }
    throw error;
  }

  await recordJobEvent(
    db,
    context,
    jobId,
    'created',
    `job submitted to edge '${valid.edgeKey}' (kind '${valid.kind}', capability '${valid.capabilityKey}')`,
    context.principalId,
  );
  const row = (await db.query<JobRow>(`SELECT * FROM edge_jobs WHERE tenant_id = $1 AND id = $2`, [
    context.tenantId,
    jobId,
  ])).rows[0]!;
  return { job: mapJob(row), created: true, replayed: false };
}

// ---------------------------------------------------------------------------
// The claim protocol (outbound-only: the edge calls in)
// ---------------------------------------------------------------------------

/**
 * Claims pending jobs for one edge — the OUTBOUND-ONLY connection point:
 * the gateway never reaches into the edge; the edge runtime calls this
 * with its key + token, and receives only jobs scoped to ITS tenant and
 * the registration's recorded allowlist, each carrying its signed
 * envelope. Claimed jobs hold a LEASE; an expired lease is swept back to
 * 'pending' first (the reclaim path — bounded edge scratch, no lost
 * jobs), and the sweep is auditable ('reclaimed').
 */
export async function claimEdgeJobs(
  context: TenantContext,
  input: ClaimEdgeJobsInput,
): Promise<ClaimEdgeJobsResult> {
  assertEdgeTenantContext(context);
  const valid = validateClaimEdgeJobsInput(input);
  const leaseMs = valid.leaseMs > 0 ? valid.leaseMs : DEFAULT_LEASE_MS;
  const at = now();

  const edge = await requireEdgeRow(context, valid.edgeKey);
  verifyEdgeToken(edge, valid.edgeToken);
  if (edge.status !== 'active') {
    throw new EdgeConnectorError(
      'edge_retired',
      `edge runtime '${valid.edgeKey}' is retired — it cannot claim jobs`,
    );
  }

  const reclaimedJobIds: string[] = [];
  const claimedRows: JobRow[] = [];

  await getDb().transaction(async (tx) => {
    // 1. Sweep expired claim leases back to pending (auditable reclaim).
    const swept = await tx.query<{ id: string }>(
      `UPDATE edge_jobs SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
         lease_expires_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND edge_id = $2 AND status = 'claimed' AND lease_expires_at <= $3
         RETURNING id`,
      [context.tenantId, edge.id, at],
    );
    for (const row of swept.rows) {
      reclaimedJobIds.push(row.id);
      await recordJobEvent(tx, context, row.id, 'reclaimed', 'claim lease expired — job reverted to pending', context.principalId);
    }

    // 2. Claim the oldest pending jobs inside the edge's allowlist scope.
    const rows = await tx.query<JobRow>(
      `UPDATE edge_jobs SET status = 'claimed', claimed_by = $2, claimed_at = $3,
         lease_expires_at = $4, attempts = attempts + 1, updated_at = $3
         WHERE id IN (
           SELECT id FROM edge_jobs
             WHERE tenant_id = $1 AND edge_id = $2 AND status = 'pending'
               AND capability_key = ANY($5::text[])
             ORDER BY created_at ASC, id ASC
             LIMIT $6
             FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
      [context.tenantId, edge.id, at, new Date(at.getTime() + leaseMs), edge.allowlist, valid.limit],
    );
    claimedRows.push(...rows.rows);
    for (const row of rows.rows) {
      await recordJobEvent(
        tx,
        context,
        row.id,
        'claimed',
        `job claimed by edge '${valid.edgeKey}' (attempt ${row.attempts}, lease ${leaseMs}ms)`,
        context.principalId,
      );
    }
    if (rows.rows.length > 0) {
      await tx.query(
        `UPDATE edge_registrations SET jobs_claimed = jobs_claimed + $3, updated_at = $4
           WHERE tenant_id = $1 AND id = $2`,
        [context.tenantId, edge.id, rows.rows.length, at],
      );
    }
  });

  const jobs: SignedEdgeJob[] = claimedRows.map((row) => ({
    envelope: row.envelope,
    signature: row.signature,
    signerKeyRef: row.signer_key_ref,
  }));
  return { jobs, reclaimedJobIds };
}

// ---------------------------------------------------------------------------
// Job reporting (the normalized result crossing back)
// ---------------------------------------------------------------------------

/**
 * Reports one executed job's outcome. The report is BOUND to the exact
 * signed envelope the gateway minted (`executedEnvelopeDigest`): a
 * mismatch is a loud `envelope_mismatch` (tamper or cross-job replay),
 * and the job is left untouched. A TERMINAL job replays its recorded
 * outcome (`replayed: true`) — never a second effect. A non-canonical
 * result is rejected loudly (`invalid_edge_result`): provider objects
 * never cross the edge seam.
 */
export async function reportEdgeJobResult(
  context: TenantContext,
  input: ReportEdgeJobInput,
): Promise<ReportEdgeJobResult> {
  assertEdgeTenantContext(context);
  const valid = validateReportEdgeJobInput(input);
  const db = getDb();
  const at = now();

  const edge = await requireEdgeRow(context, valid.edgeKey);
  verifyEdgeToken(edge, valid.edgeToken);
  // A retired edge may still REPORT (drain in-flight claimed work); it
  // can no longer claim or be submitted to.

  const job = await findJobRow(db, context, valid.jobId);
  if (job === null) {
    throw new EdgeConnectorError('job_not_found', 'no edge job with this id for this tenant');
  }

  // The executed envelope must be EXACTLY the one the gateway signed.
  if (valid.executedEnvelopeDigest !== job.envelope_digest) {
    throw new EdgeConnectorError(
      'envelope_mismatch',
      `the reported envelope digest does not match job '${job.job_key}' — the executed envelope is not the one the gateway signed`,
    );
  }

  if (isTerminal(job.status)) {
    await recordJobEvent(db, context, job.id, 'replayed', `terminal replay (status '${job.status}') — recorded outcome returned`, context.principalId);
    return { job: mapJob(job), replayed: true };
  }

  if (job.status !== 'claimed' || job.claimed_by !== edge.id) {
    throw new EdgeConnectorError(
      'job_not_claimed',
      `job '${job.job_key}' is not claimed by edge '${valid.edgeKey}' — nothing to report`,
    );
  }

  // Normalize + validate the outcome (canonical shapes only).
  let nextStatus: EdgeJobStatus;
  let result: EdgeJobResult | null = null;
  let failureReason: string | null = null;
  let refusalReason: string | null = null;
  let detail: string;

  if (valid.outcome.kind === 'result') {
    const normalization = normalizeEdgeJobResult(job.kind, valid.outcome.result);
    if (!normalization.ok) {
      throw new EdgeConnectorError(
        'invalid_edge_result',
        `edge '${valid.edgeKey}' reported a non-canonical ${job.kind} result for job '${job.job_key}' — provider objects never cross the edge seam (the job is left 'claimed' and untouched)`,
      );
    }
    result = normalization.result;
    if (job.kind === 'inspect') {
      nextStatus = 'succeeded';
      detail = `canonical state reported (found: ${(normalization.result as DeepActionState).found})`;
    } else {
      const receipt = normalization.result as DeepActionReceipt;
      if (receipt.status === 'failed') {
        // A transient receipt failure: NO external effect was taken — the
        // job re-drives through its idempotency key (the deep-actions
        // resume discipline).
        nextStatus = 'failed';
        failureReason = 'transient-receipt-failure';
        detail = 'transient failed receipt reported — no external effect taken';
      } else {
        nextStatus = 'succeeded';
        detail = `receipt reported ('${receipt.status}')`;
      }
    }
  } else if (valid.outcome.kind === 'failed') {
    nextStatus = 'failed';
    failureReason = valid.outcome.reason;
    detail = `edge reported failure: ${valid.outcome.reason}`;
  } else {
    nextStatus = 'refused';
    refusalReason = valid.outcome.reason;
    detail = `edge REFUSED the job: ${valid.outcome.reason} (flagged at the gateway)`;
  }

  const rows = await db.query<JobRow>(
    `UPDATE edge_jobs SET status = $4, result = $5::jsonb, failure_reason = $6,
       refusal_reason = $7, reported_by = $8, reported_at = $9, updated_at = $9
       WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND claimed_by = $3
       RETURNING *`,
    [
      context.tenantId,
      job.id,
      edge.id,
      nextStatus,
      result === null ? null : JSON.stringify(result),
      failureReason,
      refusalReason,
      context.principalId,
      at,
    ],
  );
  const updated = rows.rows[0];
  if (updated === undefined) {
    // Lost a race (lease swept mid-report): re-read and replay if terminal.
    const fresh = await findJobRow(db, context, job.id);
    if (fresh !== null && isTerminal(fresh.status)) {
      await recordJobEvent(db, context, fresh.id, 'replayed', `terminal replay after report race (status '${fresh.status}')`, context.principalId);
      return { job: mapJob(fresh), replayed: true };
    }
    throw new EdgeConnectorError('job_not_claimed', `job '${job.job_key}' lost its claim before the report landed`);
  }

  await recordJobEvent(db, context, job.id, nextStatus, detail, context.principalId);
  const statColumn =
    nextStatus === 'succeeded' ? 'jobs_succeeded' : nextStatus === 'failed' ? 'jobs_failed' : 'jobs_refused';
  await db.query(
    `UPDATE edge_registrations SET ${statColumn} = ${statColumn} + 1, last_job_at = $3, updated_at = $3
       WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, edge.id, at],
  );
  return { job: mapJob(updated), replayed: false };
}

// ---------------------------------------------------------------------------
// Heartbeat (health/version/stats evidence)
// ---------------------------------------------------------------------------

/**
 * Reports one edge heartbeat: version, CURRENT local allowlist digest
 * and last-job stats. Appends the status event and moves the
 * registration's report columns; a digest that diverges from the
 * recorded allowlist later renders as health drift (honestly flagged,
 * never silently trusted).
 */
export async function reportEdgeHeartbeat(
  context: TenantContext,
  input: HeartbeatInput,
): Promise<{ registration: EdgeRegistrationView }> {
  assertEdgeTenantContext(context);
  const valid = validateHeartbeatInput(input);
  const db = getDb();
  const at = now();

  const edge = await requireEdgeRow(context, valid.edgeKey);
  verifyEdgeToken(edge, valid.edgeToken);
  if (edge.status !== 'active') {
    throw new EdgeConnectorError('edge_retired', `edge runtime '${valid.edgeKey}' is retired — it cannot heartbeat`);
  }

  await recordStatusEvent(db, context, edge.id, 'heartbeat', {
    version: valid.version,
    allowlistDigest: valid.allowlistDigest,
    stats: valid.stats,
  });
  const rows = await db.query<EdgeRow>(
    `UPDATE edge_registrations SET last_seen_at = $3, reported_version = $4,
       reported_allowlist_digest = $5, updated_at = $3
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
    [context.tenantId, edge.id, at, valid.version, valid.allowlistDigest],
  );
  return { registration: mapRegistration(rows.rows[0]!) };
}

// ---------------------------------------------------------------------------
// Job reads
// ---------------------------------------------------------------------------

export async function getEdgeJob(
  context: TenantContext,
  query: GetEdgeJobQuery,
): Promise<EdgeJobView> {
  assertEdgeTenantContext(context);
  const valid = validateIdQuery(query, 'jobId', 'getEdgeJob');
  const job = await findJobRow(getDb(), context, valid.id);
  if (job === null) {
    throw new EdgeConnectorError('job_not_found', 'no edge job with this id for this tenant');
  }
  return mapJob(job);
}

export async function listEdgeJobs(
  context: TenantContext,
  query: ListEdgeJobsQuery,
): Promise<{ jobs: EdgeJobView[] }> {
  assertEdgeTenantContext(context);
  const valid = validateListEdgeJobsQuery(query);
  const filters: string[] = ['tenant_id = $1'];
  const params: unknown[] = [context.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    filters.push(`status = $${params.length}`);
  }
  if (valid.edgeKey !== null) {
    params.push(valid.edgeKey);
    filters.push(`edge_key = $${params.length}`);
  }
  const rows = await getDb().query<JobRow>(
    `SELECT * FROM edge_jobs WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${valid.limit}`,
    params,
  );
  return { jobs: rows.rows.map(mapJob) };
}

export async function listEdgeJobEvents(
  context: TenantContext,
  query: ListEdgeJobEventsQuery,
): Promise<{ events: EdgeJobEventView[] }> {
  assertEdgeTenantContext(context);
  const valid = validateJobFeedQuery(query);
  const rows = await getDb().query<JobEventRow>(
    `SELECT * FROM edge_job_events WHERE tenant_id = $1 AND job_id = $2
       ORDER BY recorded_at DESC, position DESC LIMIT ${valid.limit}`,
    [context.tenantId, valid.jobId],
  );
  return { events: rows.rows.map(mapJobEvent) };
}

export async function listEdgeStatusEvents(
  context: TenantContext,
  query: ListEdgeStatusEventsQuery,
): Promise<{ events: EdgeStatusEventView[] }> {
  assertEdgeTenantContext(context);
  const valid = validateEdgeFeedQuery(query);
  const rows = await getDb().query<StatusEventRow>(
    `SELECT * FROM edge_health_events WHERE tenant_id = $1 AND edge_id = $2
       ORDER BY occurred_at DESC, position DESC LIMIT ${valid.limit}`,
    [context.tenantId, valid.edgeId],
  );
  return { events: rows.rows.map(mapStatusEvent) };
}

export async function listEdgeAllowlistEvents(
  context: TenantContext,
  query: ListEdgeAllowlistEventsQuery,
): Promise<{ events: EdgeAllowlistEventView[] }> {
  assertEdgeTenantContext(context);
  const valid = validateEdgeFeedQuery(query);
  const rows = await getDb().query<AllowlistEventRow>(
    `SELECT * FROM edge_allowlist_events WHERE tenant_id = $1 AND edge_id = $2
       ORDER BY occurred_at DESC, position DESC LIMIT ${valid.limit}`,
    [context.tenantId, valid.edgeId],
  );
  return { events: rows.rows.map(mapAllowlistEvent) };
}

// ---------------------------------------------------------------------------
// The deep-action transport adapter (the gateway pipeline's exit seam)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The EDGE-DISPATCHING DeepActionTransport: the deep-actions pipeline's
 * canonical inspect/execute calls become SIGNED edge jobs; the adapter
 * awaits the edge's normalized report (the outbound-only claim protocol
 * runs on the edge's side) and hands back the canonical
 * DeepActionState / DeepActionReceipt. Wire it with the deep-actions
 * contract's setDeepActionTransport to prove the gateway pipeline works
 * end-to-end against an edge.
 *
 * Verdict mapping (loud, never faked):
 *   * succeeded inspect        → the canonical DeepActionState;
 *   * succeeded execute        → the canonical DeepActionReceipt;
 *   * failed execute           → the recorded transient receipt (or a
 *     synthesized 'failed' receipt carrying the failure reason) —
 *     deep-actions parks the task 'failed' for retry, and the retry's
 *     stable idempotency key re-drives the job;
 *   * failed inspect / refused → EdgeConnectorError ('edge_job_failed'
 *     / 'edge_refused' with the machine-readable reason) — a refused or
 *     unreadable read is never faked as "not found";
 *   * timeout                  → 'edge_job_timeout'.
 */
export function createEdgeDispatchTransport(
  config: EdgeDispatchTransportConfig,
): DeepActionTransport {
  const pollMs = config.pollMs ?? DEFAULT_TRANSPORT_POLL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;

  async function dispatch(
    kind: EdgeJobKind,
    request: DeepActionInspectRequest | DeepActionExecuteRequest,
  ): Promise<EdgeJobView> {
    const submitted = await submitEdgeJob(config.context, {
      edgeKey: config.edgeKey,
      kind,
      capabilityKey: request.capabilityKey,
      idempotencyKey: request.idempotencyKey,
      request,
    });
    let job = submitted.job;
    const clockDeadline = now().getTime() + timeoutMs;
    const wallDeadline = Date.now() + timeoutMs + 10_000;
    while (!isTerminal(job.status)) {
      if (now().getTime() >= clockDeadline || Date.now() >= wallDeadline) {
        throw new EdgeConnectorError(
          'edge_job_timeout',
          `edge job '${job.idempotencyKey}' (kind '${kind}') did not reach a terminal status within ${timeoutMs}ms — the edge is silent or slow`,
        );
      }
      await sleep(pollMs);
      job = await getEdgeJob(config.context, { jobId: job.id });
    }
    return job;
  }

  return {
    async inspect(request: DeepActionInspectRequest): Promise<DeepActionState> {
      const job = await dispatch('inspect', request);
      if (job.status === 'succeeded') {
        return job.result as DeepActionState;
      }
      if (job.status === 'refused') {
        throw new EdgeConnectorError(
          'edge_refused',
          `the edge refused to inspect '${request.target}' through '${request.capabilityKey}': ${job.refusalReason}`,
          { refusalReason: job.refusalReason ?? 'unknown' },
        );
      }
      throw new EdgeConnectorError(
        'edge_job_failed',
        `the edge failed to inspect '${request.target}' through '${request.capabilityKey}': ${job.failureReason}`,
        { failureReason: job.failureReason ?? 'unknown' },
      );
    },

    async execute(request: DeepActionExecuteRequest): Promise<DeepActionReceipt> {
      const job = await dispatch('execute', request);
      if (job.status === 'succeeded') {
        return job.result as DeepActionReceipt;
      }
      if (job.status === 'refused') {
        throw new EdgeConnectorError(
          'edge_refused',
          `the edge refused to execute the write on '${request.target}' through '${request.capabilityKey}': ${job.refusalReason}`,
          { refusalReason: job.refusalReason ?? 'unknown' },
        );
      }
      // 'failed': a transient receipt (or an edge-side failure) — no
      // external effect was taken; the deep-actions retry re-drives the
      // job through the SAME stable idempotency key.
      if (job.result !== null) {
        return job.result as DeepActionReceipt;
      }
      return {
        status: 'failed',
        receiptId: null,
        detail: job.failureReason ?? 'edge job failed',
      };
    },
  };
}
