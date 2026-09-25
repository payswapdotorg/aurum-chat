// Implementation of the cellular module's public operations (see
// contract.ts).
//
// W087 — Cellular Reachability and Communication Fallback. The
// outcome-oriented "Reach Anyone" core: a manager states an outcome
// ("Tell Sarah …"); this module resolves the recipient's VERIFIED phone
// identity (W002), routes it through the actions authority gate (W009),
// snapshots the tenant's cellular policy (routing/cost controls),
// delivers SMS legs and voice-fallback calls through the provider-
// neutral telecom transport port, tracks delivery/reply state through
// carrier events, returns replies into Aurum through the channels
// contract's canonical inbound edge (W030), and surfaces terminal
// failures to the asking manager through the notifications contract
// (W031). The recipient never needs Internet or an Aurum account — the
// PSTN is the transport, the E.164 number is the address.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) — or by the sanctioned `newId()` helper where a
// transport idempotency key needs the id before the row exists (the
// realtime module's speak discipline); timestamps come from the
// injectable clock and are never caller-supplied; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access
// is indistinguishable from a missing record, no existence leak.
//
// The W087 acceptance properties, all tested (see tests/):
//   1. REACH ANYONE — reachAnyone resolves the person's verified phone
//      identity (personId path; lock 15 — unverified accounts never
//      resolve to employees) or classifies a raw number honestly, gates
//      the communication through the W009 matrix under the canonical
//      action kind, snapshots the resolved policy, and delivers the
//      first SMS attempt when the gate allows;
//   2. VOICE FALLBACK — when the SMS leg terminally fails and the
//      policy's voiceFallback mode permits ('on_sms_failure'), the
//      module places a voice call that speaks the same message; a
//      forbidden policy never places one;
//   3. REPLY RETURNS INTO AURUM — receiveCellularEvent delegates the
//      message-shaped carrier envelope to the channels contract's
//      canonical inbound edge (transcript turn + on-sight identity,
//      W030), correlates the reply to its reach request, and records
//      the reply row; an UNCORRELATED inbound message (a manager with
//      no usable Internet data texting/calling Aurum's own number)
//      lands through the identical path as an inbound_request;
//   4. FAILED DELIVERY IS VISIBLE AND RETRYABLE — attempts are
//      append-only audit rows; a terminal failure carries a failure
//      code, optionally notifies the requester (W031), and reopens via
//      retryCellularReach (a new delivery cycle);
//   5. MULTIPLE TELECOM ADAPTERS — two vendors ('twilio', 'telnyx')
//      with materially different envelopes normalize into the same
//      canonical vocabulary (provider-swap evidence, GOVERNANCE).
//
// Delivery-error discipline (the notifications module's): connection
// problems and unwired transports are TRANSIENT (the tenant can fix the
// configuration; retries are budgeted); the carrier's explicit
// rejection is permanent (the SMS leg is terminal). Retries are leased:
// the claim UPDATE (next_attempt_at guard) makes one pump the single
// writer of an attempt, the lease doubles as the retry schedule, and
// delivery is at-least-once with idempotent effects (guarded status
// updates; the conversations contract's provider-message-id dedupe on
// the delegation path).

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ActionsError, authorizeAction, type ActionRequest } from '@/modules/actions/contract';
import { ChannelsError, receiveInbound, type InboundResult } from '@/modules/channels/contract';
import {
  findExternalIdentityByProviderKey,
  type ChannelProvider,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import {
  getEmployeeByPerson,
  getPerson,
  listPersonIdentities,
  PeopleError,
} from '@/modules/people/contract';
import { createNotification, NotificationsError } from '@/modules/notifications/contract';
import { getCellularAdapter } from './adapters';
import { CellularError } from './errors';
import {
  BUILT_IN_DEFAULT_POLICY,
  CELLULAR_FAILURE_NOTIFICATION_KIND,
  CELLULAR_REACH_AUTHORITY_LEVEL,
  fitsCostCap,
  reachActionKindFor,
  reachGateKey,
  resolveCellularPolicyRows,
  shouldFallBackToVoice,
  smsAttemptCostMinor,
  smsSegmentsOf,
  voiceAttemptCostMinor,
} from './policy';
import {
  assertCellularTenantContext,
  canAdministerCellularPolicies,
  isUuid,
  segmentsUnderPolicy,
  validateCanonicalCellularEvent,
  validateCellularPolicySubjectQuery,
  validateGetCellularReachQuery,
  validateListCellularConnectionsQuery,
  validateListCellularEventsQuery,
  validateListCellularPoliciesQuery,
  validateListCellularReachQuery,
  validateListCellularRepliesQuery,
  validateListCellularAttemptsQuery,
  validatePumpQuery,
  validateReachAnyoneInput,
  validateReceiveCellularEventInput,
  validateRegisterCellularConnectionInput,
  validateRetryCellularReachInput,
  validateSetCellularConnectionStatusInput,
  validateSetCellularPolicyInput,
  validateTransportSmsReceipt,
  validateTransportVoiceReceipt,
  type ValidatedListConnectionsQuery,
  type ValidatedPolicySubjectQuery,
  type ValidatedRegisterConnectionInput,
  type ValidatedSetConnectionStatusInput,
  type ValidatedSetPolicyInput,
} from './validation';
import type {
  CanonicalCellularEvent,
  CellularAttempt,
  CellularConnection,
  CellularConnectionStatus,
  CellularEventRecord,
  CellularEventResult,
  CellularPolicy,
  CellularPumpSummary,
  CellularReach,
  CellularReachKind,
  CellularReachStatus,
  CellularRecipientKind,
  CellularReply,
  CellularTransport,
  ListCellularConnectionsQuery,
  ListCellularEventsQuery,
  ListCellularPoliciesQuery,
  ListCellularReachQuery,
  ListCellularRepliesQuery,
  ListCellularAttemptsQuery,
  ReachAnyoneInput,
  ReceiveCellularEventInput,
  RegisterCellularConnectionInput,
  RegisterCellularConnectionResult,
  ResolvedCellularPolicy,
  RetryCellularReachInput,
  SetCellularConnectionStatusInput,
  SetCellularPolicyInput,
} from './types';

// ---------------------------------------------------------------------------
// Rows + mapping
// ---------------------------------------------------------------------------

interface ConnectionRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_account_id: string;
  phone_number: string;
  display_name: string | null;
  credential_ref: string;
  status: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PolicyRow extends DbRow {
  id: string;
  tenant_id: string;
  reach_kind: string | null;
  voice_fallback: string;
  sms_max_attempts: number;
  retry_backoff_seconds: number;
  max_sms_segments: number;
  sms_segment_cost_minor: number;
  voice_per_minute_cost_minor: number;
  currency: string;
  max_cost_per_reach_minor: number;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** The policy-resolution input shape (the pure resolver's row contract). */
interface PolicyRowLike {
  reachKind: CellularReachKind | null;
  voiceFallback: CellularPolicy['voiceFallback'];
  smsMaxAttempts: number;
  retryBackoffSeconds: number;
  maxSmsSegments: number;
  smsSegmentCostMinor: number;
  voicePerMinuteCostMinor: number;
  currency: string;
  maxCostPerReachMinor: number;
}

interface ReachRow extends DbRow {
  id: string;
  tenant_id: string;
  kind: string;
  recipient_kind: string;
  person_id: string | null;
  employee_id: string | null;
  identity_id: string | null;
  phone_number: string;
  text: string;
  connection_id: string;
  requested_by: string;
  action_request_id: string | null;
  action_kind: string;
  status: string;
  failure_code: string | null;
  policy_source: string;
  voice_fallback: string;
  sms_max_attempts: number;
  retry_backoff_seconds: number;
  max_sms_segments: number;
  sms_segment_cost_minor: number;
  voice_per_minute_cost_minor: number;
  currency: string;
  max_cost_per_reach_minor: number;
  failure_notification: Record<string, unknown> | null;
  sms_attempts_count: number;
  voice_attempts_count: number;
  cycle: number;
  cost_minor_total: number;
  next_attempt_at: Date | string | null;
  sent_at: Date | string | null;
  delivered_at: Date | string | null;
  replied_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AttemptRow extends DbRow {
  id: string;
  tenant_id: string;
  reach_request_id: string;
  attempt_no: number;
  cycle: number;
  leg: string;
  gate_status: string;
  provider: string;
  connection_id: string | null;
  from_number: string | null;
  to_number: string;
  text: string;
  segments: number | null;
  cost_minor: number;
  status: string;
  provider_message_id: string | null;
  provider_call_id: string | null;
  detail: string | null;
  attempted_at: Date | string;
  receipt_at: Date | string | null;
  duration_seconds: number | null;
  recording_url: string | null;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_event_id: string;
  kind: string;
  connection_id: string | null;
  event: CanonicalCellularEvent;
  created_at: Date | string;
}

interface ReplyRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_event_id: string;
  inbound_kind: string;
  reach_request_id: string | null;
  channel: string;
  from_number: string;
  to_number: string;
  text: string;
  identity_id: string | null;
  person_id: string | null;
  employee_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapConnection(row: ConnectionRow): CellularConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as CellularConnection['provider'], // CHECK-constrained by migration 001
    providerAccountId: row.provider_account_id,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    credentialRef: row.credential_ref,
    status: row.status as CellularConnectionStatus, // CHECK-constrained by migration 001
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapPolicy(row: PolicyRow): CellularPolicy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    reachKind: row.reach_kind as CellularPolicy['reachKind'], // CHECK-constrained by migration 002
    voiceFallback: row.voice_fallback as CellularPolicy['voiceFallback'],
    smsMaxAttempts: row.sms_max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    maxSmsSegments: row.max_sms_segments,
    smsSegmentCostMinor: row.sms_segment_cost_minor,
    voicePerMinuteCostMinor: row.voice_per_minute_cost_minor,
    currency: row.currency,
    maxCostPerReachMinor: row.max_cost_per_reach_minor,
    note: row.note,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapReach(row: ReachRow): CellularReach {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as CellularReachKind,
    recipientKind: row.recipient_kind as CellularRecipientKind,
    personId: row.person_id,
    employeeId: row.employee_id,
    identityId: row.identity_id,
    phoneNumber: row.phone_number,
    text: row.text,
    connectionId: row.connection_id,
    requestedBy: row.requested_by,
    actionRequestId: row.action_request_id,
    actionKind: row.action_kind,
    status: row.status as CellularReachStatus,
    failureCode: row.failure_code as CellularReach['failureCode'],
    policySource: row.policy_source as CellularReach['policySource'],
    voiceFallback: row.voice_fallback as CellularReach['voiceFallback'],
    smsMaxAttempts: row.sms_max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    maxSmsSegments: row.max_sms_segments,
    smsSegmentCostMinor: row.sms_segment_cost_minor,
    voicePerMinuteCostMinor: row.voice_per_minute_cost_minor,
    currency: row.currency,
    maxCostPerReachMinor: row.max_cost_per_reach_minor,
    smsAttemptsCount: row.sms_attempts_count,
    voiceAttemptsCount: row.voice_attempts_count,
    cycle: row.cycle,
    costMinorTotal: row.cost_minor_total,
    nextAttemptAt: toIsoOrNull(row.next_attempt_at),
    sentAt: toIsoOrNull(row.sent_at),
    deliveredAt: toIsoOrNull(row.delivered_at),
    repliedAt: toIsoOrNull(row.replied_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapAttempt(row: AttemptRow): CellularAttempt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    reachRequestId: row.reach_request_id,
    attemptNo: row.attempt_no,
    cycle: row.cycle,
    leg: row.leg as CellularAttempt['leg'],
    gateStatus: row.gate_status as CellularAttempt['gateStatus'],
    provider: row.provider as CellularAttempt['provider'],
    connectionId: row.connection_id,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    text: row.text,
    segments: row.segments,
    costMinor: row.cost_minor,
    status: row.status as CellularAttempt['status'],
    providerMessageId: row.provider_message_id,
    providerCallId: row.provider_call_id,
    detail: row.detail,
    attemptedAt: toIso(row.attempted_at),
    receiptAt: toIsoOrNull(row.receipt_at),
    durationSeconds: row.duration_seconds,
    recordingUrl: row.recording_url,
  };
}

function mapEvent(row: EventRow): CellularEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as CellularEventRecord['provider'],
    providerEventId: row.provider_event_id,
    kind: row.kind as CellularEventRecord['kind'],
    connectionId: row.connection_id,
    event: row.event,
    createdAt: toIso(row.created_at),
  };
}

function mapReply(row: ReplyRow): CellularReply {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as CellularReply['provider'],
    providerEventId: row.provider_event_id,
    inboundKind: row.inbound_kind as CellularReply['inboundKind'],
    reachRequestId: row.reach_request_id,
    channel: row.channel as CellularReply['channel'],
    fromNumber: row.from_number,
    toNumber: row.to_number,
    text: row.text,
    identityId: row.identity_id,
    personId: row.person_id,
    employeeId: row.employee_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    createdAt: toIso(row.created_at),
  };
}

function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Transport port (provider-neutral; implementations live inside adapters/)
// ---------------------------------------------------------------------------

let cellularTransport: CellularTransport | null = null;

/**
 * Infrastructure wiring for the delivery port. Real vendor transports
 * (SDKs / HTTP) are implemented inside `src/modules/cellular/adapters/`
 * and wired once at process start; tests substitute a scripted transport.
 * `null` restores the default "no provider available" state.
 */
export function setCellularTransport(transport: CellularTransport | null): void {
  cellularTransport = transport;
}

/** The currently wired transport (null when none — deliveries then fail `provider_unavailable`). */
export function getCellularTransport(): CellularTransport | null {
  return cellularTransport;
}

function transportFor(provider: string): CellularTransport {
  if (cellularTransport === null || cellularTransport.provider !== provider) {
    throw new CellularError(
      'provider_unavailable',
      `no cellular transport is wired for provider '${provider}' (wire one via setCellularTransport)`,
    );
  }
  return cellularTransport;
}

/** Connection-level failures that are TRANSIENT (the notifications discipline). */
const TRANSIENT_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'provider_unavailable',
  'connection_not_found',
  'connection_ambiguous',
  'connection_disabled',
]);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function registerCellularConnection(
  ctx: TenantContext,
  input: RegisterCellularConnectionInput,
): Promise<RegisterCellularConnectionResult> {
  assertCellularTenantContext(ctx);
  const valid: ValidatedRegisterConnectionInput = validateRegisterCellularConnectionInput(input);
  const adapter = getCellularAdapter(valid.provider);
  const providerAccountId = adapter.normalizeAccountId(valid.providerAccountId);
  const at = now();
  const db = getDb();

  const existing = await db.query<ConnectionRow>(
    `SELECT * FROM cellular_connections
       WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
    [ctx.tenantId, valid.provider, providerAccountId],
  );
  const current = existing.rows[0];
  if (current !== undefined) {
    // Re-registration is the RE-AUTHORIZATION path (the realtime module's
    // discipline): authorization fields move, the endpoint's identity does not.
    const updated = await db.query<ConnectionRow>(
      `UPDATE cellular_connections SET
         phone_number = $3, display_name = $4, credential_ref = $5, updated_at = $6
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [ctx.tenantId, current.id, valid.phoneNumber, valid.displayName, valid.credentialRef, at],
    );
    return { connection: mapConnection(updated.rows[0]!), created: false };
  }

  const inserted = await db.query<ConnectionRow>(
    `INSERT INTO cellular_connections (
       tenant_id, provider, provider_account_id, phone_number, display_name,
       credential_ref, created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.provider,
      providerAccountId,
      valid.phoneNumber,
      valid.displayName,
      valid.credentialRef,
      ctx.principalId,
      at,
    ],
  );
  return { connection: mapConnection(inserted.rows[0]!), created: true };
}

export async function getCellularConnection(
  ctx: TenantContext,
  query: { connectionId: string },
): Promise<CellularConnection> {
  assertCellularTenantContext(ctx);
  if (!isUuid(query.connectionId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new CellularError(
      'connection_not_found',
      `cellular connection '${query.connectionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM cellular_connections WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, query.connectionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new CellularError(
      'connection_not_found',
      `cellular connection '${query.connectionId}' does not exist in this tenant`,
    );
  }
  return mapConnection(row);
}

export async function listCellularConnections(
  ctx: TenantContext,
  query: ListCellularConnectionsQuery,
): Promise<CellularConnection[]> {
  assertCellularTenantContext(ctx);
  const valid: ValidatedListConnectionsQuery = validateListCellularConnectionsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ConnectionRow>(
    `SELECT * FROM cellular_connections WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapConnection(row));
}

export async function setCellularConnectionStatus(
  ctx: TenantContext,
  input: SetCellularConnectionStatusInput,
): Promise<CellularConnection> {
  assertCellularTenantContext(ctx);
  const valid: ValidatedSetConnectionStatusInput = validateSetCellularConnectionStatusInput(input);
  // The only other mutable field of a connection is its status.
  const result = await getDb().query<ConnectionRow>(
    `UPDATE cellular_connections SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, valid.connectionId, valid.status, now()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant connections are indistinguishable from missing ones.
    throw new CellularError(
      'connection_not_found',
      `cellular connection '${valid.connectionId}' does not exist in this tenant`,
    );
  }
  return mapConnection(row);
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function policyRowLike(row: PolicyRow): PolicyRowLike {
  return {
    reachKind: row.reach_kind as CellularReachKind | null,
    voiceFallback: row.voice_fallback as CellularPolicy['voiceFallback'],
    smsMaxAttempts: row.sms_max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    maxSmsSegments: row.max_sms_segments,
    smsSegmentCostMinor: row.sms_segment_cost_minor,
    voicePerMinuteCostMinor: row.voice_per_minute_cost_minor,
    currency: row.currency,
    maxCostPerReachMinor: row.max_cost_per_reach_minor,
  };
}

async function lookupPolicyRow(
  ctx: TenantContext,
  reachKind: CellularReachKind | null,
): Promise<PolicyRow | null> {
  const result = await getDb().query<PolicyRow>(
    `SELECT * FROM cellular_policies
       WHERE tenant_id = $1 AND reach_kind IS NOT DISTINCT FROM $2`,
    [ctx.tenantId, reachKind],
  );
  return result.rows[0] ?? null;
}

async function loadPolicyRows(ctx: TenantContext): Promise<PolicyRow[]> {
  const result = await getDb().query<PolicyRow>(
    `SELECT * FROM cellular_policies WHERE tenant_id = $1 ORDER BY reach_kind NULLS LAST, created_at`,
    [ctx.tenantId],
  );
  return result.rows;
}

/** Resolve the effective policy for one reach kind (kind → default → built-in). */
async function resolvePolicy(
  ctx: TenantContext,
  reachKind: CellularReachKind,
): Promise<ResolvedCellularPolicy> {
  const rows = await loadPolicyRows(ctx);
  const { resolved } = resolveCellularPolicyRows(
    reachKind,
    rows.map(policyRowLike),
  );
  return resolved;
}

export async function setCellularPolicy(
  ctx: TenantContext,
  input: SetCellularPolicyInput,
): Promise<CellularPolicy> {
  assertCellularTenantContext(ctx);
  // Cellular policies control consequential outbound communications
  // (voice fallback intrusiveness, retry budgets, cost caps): only
  // holders of the administer claim may tighten or relax them
  // (authorization before input parsing — unauthorized callers learn
  // nothing about shapes).
  if (!canAdministerCellularPolicies(ctx.authority)) {
    throw new CellularError(
      'forbidden',
      `this operation requires the 'cellular:administer' authority claim`,
    );
  }
  const valid: ValidatedSetPolicyInput = validateSetCellularPolicyInput(input);
  const timestamp = now();
  const db = getDb();

  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM cellular_policies
         WHERE tenant_id = $1 AND reach_kind IS NOT DISTINCT FROM $2`,
      [ctx.tenantId, valid.reachKind],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<PolicyRow>(
        `UPDATE cellular_policies SET
           voice_fallback = $3, sms_max_attempts = $4, retry_backoff_seconds = $5,
           max_sms_segments = $6, sms_segment_cost_minor = $7,
           voice_per_minute_cost_minor = $8, currency = $9,
           max_cost_per_reach_minor = $10, note = $11, updated_at = $12
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          existingId,
          valid.voiceFallback ?? BUILT_IN_DEFAULT_POLICY.voiceFallback,
          valid.smsMaxAttempts ?? BUILT_IN_DEFAULT_POLICY.smsMaxAttempts,
          valid.retryBackoffSeconds ?? BUILT_IN_DEFAULT_POLICY.retryBackoffSeconds,
          valid.maxSmsSegments ?? BUILT_IN_DEFAULT_POLICY.maxSmsSegments,
          valid.smsSegmentCostMinor ?? BUILT_IN_DEFAULT_POLICY.smsSegmentCostMinor,
          valid.voicePerMinuteCostMinor ?? BUILT_IN_DEFAULT_POLICY.voicePerMinuteCostMinor,
          valid.currency ?? BUILT_IN_DEFAULT_POLICY.currency,
          valid.maxCostPerReachMinor ?? BUILT_IN_DEFAULT_POLICY.maxCostPerReachMinor,
          valid.note,
          timestamp,
        ],
      );
      return mapPolicy(updated.rows[0]!);
    }
    let inserted;
    try {
      inserted = await tx.query<PolicyRow>(
        `INSERT INTO cellular_policies (
           tenant_id, reach_kind, voice_fallback, sms_max_attempts,
           retry_backoff_seconds, max_sms_segments, sms_segment_cost_minor,
           voice_per_minute_cost_minor, currency, max_cost_per_reach_minor,
           note, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.reachKind,
          valid.voiceFallback ?? BUILT_IN_DEFAULT_POLICY.voiceFallback,
          valid.smsMaxAttempts ?? BUILT_IN_DEFAULT_POLICY.smsMaxAttempts,
          valid.retryBackoffSeconds ?? BUILT_IN_DEFAULT_POLICY.retryBackoffSeconds,
          valid.maxSmsSegments ?? BUILT_IN_DEFAULT_POLICY.maxSmsSegments,
          valid.smsSegmentCostMinor ?? BUILT_IN_DEFAULT_POLICY.smsSegmentCostMinor,
          valid.voicePerMinuteCostMinor ?? BUILT_IN_DEFAULT_POLICY.voicePerMinuteCostMinor,
          valid.currency ?? BUILT_IN_DEFAULT_POLICY.currency,
          valid.maxCostPerReachMinor ?? BUILT_IN_DEFAULT_POLICY.maxCostPerReachMinor,
          valid.note,
          timestamp,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'cellular_policies')) {
        throw new CellularError(
          'invalid_cellular_input',
          'a cellular policy for this kind was created concurrently; retry the set operation',
        );
      }
      throw error;
    }
    return mapPolicy(inserted.rows[0]!);
  });
}

export async function getCellularPolicy(
  ctx: TenantContext,
  query: { reachKind?: CellularReachKind | null },
): Promise<CellularPolicy> {
  assertCellularTenantContext(ctx);
  const valid: ValidatedPolicySubjectQuery = validateCellularPolicySubjectQuery(query);
  const row = await lookupPolicyRow(ctx, valid.reachKind);
  if (row === null) {
    throw new CellularError(
      'policy_not_found',
      `no cellular policy exists for ${
        valid.reachKind === null ? 'the tenant default' : `kind '${valid.reachKind}'`
      } in this tenant`,
    );
  }
  return mapPolicy(row);
}

export async function resolveCellularPolicy(
  ctx: TenantContext,
  query: { reachKind?: CellularReachKind | null },
): Promise<ResolvedCellularPolicy> {
  assertCellularTenantContext(ctx);
  const valid: ValidatedPolicySubjectQuery = validateCellularPolicySubjectQuery(query);
  const reachKind = valid.reachKind ?? 'tell';
  return resolvePolicy(ctx, reachKind);
}

export async function listCellularPolicies(
  ctx: TenantContext,
  query: ListCellularPoliciesQuery,
): Promise<CellularPolicy[]> {
  assertCellularTenantContext(ctx);
  const valid = validateListCellularPoliciesQuery(query);
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM cellular_policies WHERE tenant_id = $1
       ORDER BY reach_kind NULLS LAST, created_at LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map((row) => mapPolicy(row));
}

// ---------------------------------------------------------------------------
// Sending-connection resolution (the channels module's discipline)
// ---------------------------------------------------------------------------

/**
 * Resolve the sending endpoint for a REACH REQUEST: an explicit connection
 * id (tenant-scoped, active) or the tenant's UNIQUE active connection.
 * The resolved connection is PINNED onto the request at ask time —
 * attempts always carry a concrete endpoint, even when it is disabled
 * mid-flight (a disabled endpoint's in-flight deliveries still report).
 */
async function resolveSendingConnection(
  ctx: TenantContext,
  connectionId: string | null,
): Promise<ConnectionRow> {
  const db = getDb();
  if (connectionId !== null) {
    if (!isUuid(connectionId)) {
      throw new CellularError(
        'connection_not_found',
        `cellular connection '${connectionId}' does not exist in this tenant`,
      );
    }
    const result = await db.query<ConnectionRow>(
      `SELECT * FROM cellular_connections WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, connectionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CellularError(
        'connection_not_found',
        `cellular connection '${connectionId}' does not exist in this tenant`,
      );
    }
    if (row.status !== 'active') {
      throw new CellularError(
        'connection_disabled',
        `cellular connection '${row.id}' (${row.provider}) is disabled`,
      );
    }
    return row;
  }

  const rows = await db.query<ConnectionRow>(
    `SELECT * FROM cellular_connections
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY created_at, id`,
    [ctx.tenantId],
  );
  if (rows.rows.length === 0) {
    // Precision over a bare not-found (the channels module's discipline).
    const any = await db.query<{ status: string }>(
      `SELECT status FROM cellular_connections WHERE tenant_id = $1 LIMIT 1`,
      [ctx.tenantId],
    );
    if (any.rows[0] !== undefined) {
      throw new CellularError(
        'connection_disabled',
        `no active cellular connection exists in this tenant (all connections are disabled)`,
      );
    }
    throw new CellularError(
      'connection_not_found',
      `no active cellular connection exists in this tenant`,
    );
  }
  if (rows.rows.length > 1) {
    throw new CellularError(
      'connection_ambiguous',
      `${rows.rows.length} active cellular connections exist — pass an explicit connectionId`,
    );
  }
  return rows.rows[0]!;
}

/** The pinned connection of a reach request (no delete path — a miss is an integrity breach). */
async function loadPinnedConnection(ctx: TenantContext, connectionId: string): Promise<ConnectionRow> {
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM cellular_connections WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, connectionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `the pinned cellular connection '${connectionId}' disappeared (internal invariant violation)`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Recipient resolution (W002 — verified phone identity)
// ---------------------------------------------------------------------------

interface ResolvedRecipient {
  recipientKind: CellularRecipientKind;
  personId: string | null;
  employeeId: string | null;
  identityId: string | null;
  phoneNumber: string;
}

/**
 * Resolve the person's VERIFIED phone identity: a verified, subject-linked
 * 'sms' (preferred) or 'voice' identity (lock 15 — an unverified account
 * never silently becomes an employee). Deterministic order: sms before
 * voice, then the identity service's (created_at, id) order.
 */
async function resolvePersonRecipient(
  ctx: TenantContext,
  personId: string,
): Promise<ResolvedRecipient> {
  try {
    await getPerson(ctx, personId);
  } catch (error) {
    if (error instanceof PeopleError && error.code === 'person_not_found') {
      // A missing/foreign person is uniformly unreachable (no existence leak).
      throw new CellularError(
        'person_not_reachable',
        `person '${personId}' does not exist in this tenant`,
      );
    }
    throw error;
  }

  const identities = await listPersonIdentities(ctx, personId);
  const verified = identities.filter(
    (identity) =>
      (identity.provider === 'sms' || identity.provider === 'voice') &&
      identity.status === 'verified' &&
      identity.subjectId === personId &&
      identity.subjectKind === 'person',
  );
  const phoneIdentity =
    verified.find((identity) => identity.provider === 'sms') ?? verified[0] ?? null;
  if (phoneIdentity === null) {
    throw new CellularError(
      'person_not_reachable',
      `person '${personId}' has no verified phone identity (sms or voice) in this tenant`,
    );
  }
  const employee = await getEmployeeByPerson(ctx, personId);
  return {
    recipientKind: employee === null ? 'verified_person' : 'verified_employee',
    personId,
    employeeId: employee === null ? null : employee.id,
    identityId: phoneIdentity.id,
    phoneNumber: phoneIdentity.providerAccountId,
  };
}

/** Resolve a raw E.164 number onto its honest recipient classification. */
async function resolveRawPhoneRecipient(
  ctx: TenantContext,
  phoneNumber: string,
): Promise<ResolvedRecipient> {
  for (const provider of ['sms', 'voice'] as const) {
    const resolution = await resolvePhoneIdentity(ctx, provider, phoneNumber);
    if (resolution !== null) {
      return resolution;
    }
  }
  return {
    recipientKind: 'unknown_number',
    personId: null,
    employeeId: null,
    identityId: null,
    phoneNumber,
  };
}

/** One provider's resolution of a phone number; null when that provider knows nothing. */
async function resolvePhoneIdentity(
  ctx: TenantContext,
  provider: ChannelProvider,
  phoneNumber: string,
): Promise<ResolvedRecipient | null> {
  const identity = await findExternalIdentityByProviderKey(ctx, {
    provider,
    providerAccountId: phoneNumber,
  });
  if (identity === null) {
    return null;
  }
  if (
    identity.status !== 'verified' ||
    identity.subjectId === null ||
    identity.subjectKind !== 'person'
  ) {
    return {
      recipientKind: 'unverified_identity',
      personId: null,
      employeeId: null,
      identityId: identity.id,
      phoneNumber,
    };
  }
  const employee = await getEmployeeByPerson(ctx, identity.subjectId);
  return {
    recipientKind: employee === null ? 'verified_person' : 'verified_employee',
    personId: identity.subjectId,
    employeeId: employee === null ? null : employee.id,
    identityId: identity.id,
    phoneNumber,
  };
}

// ---------------------------------------------------------------------------
// The W009 authority gate (the notifications module's discipline)
// ---------------------------------------------------------------------------

/**
 * Route one reach request through the actions authority gate. The STABLE
 * idempotency key replays the original request on every re-check — a
 * human approval between pumps unlocks delivery; gate history is never
 * duplicated. Rejections here contradict the actions contract (our
 * inputs are pre-validated) and stay loud.
 */
async function authorizeReachGate(ctx: TenantContext, row: ReachRow): Promise<ActionRequest> {
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind: row.action_kind,
      authorityLevel: CELLULAR_REACH_AUTHORITY_LEVEL,
      payload: {
        reachRequestId: row.id,
        kind: row.kind,
        recipient: {
          recipientKind: row.recipient_kind,
          phoneNumber: row.phone_number,
          personId: row.person_id,
        },
        text: row.text,
        voiceFallback: row.voice_fallback,
      },
      justification: `reach ${row.phone_number} by SMS with voice fallback (cellular reach request ${row.id})`,
      idempotencyKey: reachGateKey(row.id),
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      throw new Error(
        `the authority gate rejected a pre-validated cellular authorization (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  // One-way NULL→value fill of the gate request reference.
  await getDb().query(
    `UPDATE cellular_reach_requests SET action_request_id = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND action_request_id IS NULL`,
    [ctx.tenantId, row.id, request.id, now()],
  );
  return request;
}

// ---------------------------------------------------------------------------
// Failure visibility (W031 — the notifications contract)
// ---------------------------------------------------------------------------

/**
 * Tell the asking manager a reach terminally failed or was blocked, when
 * the request carried a failure-notification target. Delegated to the
 * notifications contract (its own policy/retry/gate machinery applies);
 * a rejection here contradicts the pre-validated target and stays loud.
 */
async function notifyFailure(ctx: TenantContext, row: ReachRow): Promise<void> {
  const target = row.failure_notification;
  if (target === null) return;
  const subject =
    row.status === 'blocked'
      ? 'Cellular reach blocked by policy'
      : `Cellular reach failed (${row.failure_code ?? 'unknown'})`;
  const body = [
    `Aurum could not complete the cellular reach request ${row.id}.`,
    `Recipient: ${row.phone_number}${row.person_id === null ? '' : ` (person ${row.person_id})`}.`,
    `Status: ${row.status}${row.failure_code === null ? '' : ` — ${row.failure_code}`}.`,
    `Message: ${row.text.slice(0, 200)}`,
    `The request can be retried through the cellular module once the cause is fixed.`,
  ].join(' ');
  try {
    await createNotification(ctx, {
      kind: CELLULAR_FAILURE_NOTIFICATION_KIND,
      recipient: {
        provider: String(target.provider) as ChannelProvider,
        providerAccountId: String(target.providerAccountId),
        displayName:
          typeof target.displayName === 'string' && target.displayName !== ''
            ? target.displayName
            : undefined,
      },
      subject: subject.slice(0, 200),
      body: body.slice(0, 4_096),
      dedupeKey: `cellular-reach:${row.id}:${row.status}`,
      correlationId: row.id,
    });
  } catch (error) {
    if (error instanceof NotificationsError) {
      throw new Error(
        `the notifications contract rejected a pre-validated reach failure notification (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reach request state transitions (guarded, forward-only per cycle)
// ---------------------------------------------------------------------------

async function loadReachRow(ctx: TenantContext, reachRequestId: string): Promise<ReachRow> {
  if (!isUuid(reachRequestId)) {
    throw new CellularError(
      'reach_not_found',
      `cellular reach request '${reachRequestId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ReachRow>(
    `SELECT * FROM cellular_reach_requests WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, reachRequestId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new CellularError(
      'reach_not_found',
      `cellular reach request '${reachRequestId}' does not exist in this tenant`,
    );
  }
  return row;
}

/** Terminal failure: visible, code-carrying, retryable via retryCellularReach. */
async function terminalFail(ctx: TenantContext, row: ReachRow, code: string): Promise<ReachRow> {
  const at = now();
  const updated = await getDb().query<ReachRow>(
    `UPDATE cellular_reach_requests
       SET status = 'failed', failure_code = $3, next_attempt_at = NULL, updated_at = $4
       WHERE tenant_id = $1 AND id = $2
         AND status NOT IN ('delivered', 'replied', 'blocked', 'failed')
       RETURNING *`,
    [ctx.tenantId, row.id, code, at],
  );
  const fresh = updated.rows[0] ?? row;
  await notifyFailure(ctx, fresh);
  return fresh;
}

/** Gate rejection: blocked, never sent, not reopenable (the decision is stable). */
async function blockReach(ctx: TenantContext, row: ReachRow): Promise<ReachRow> {
  const at = now();
  const updated = await getDb().query<ReachRow>(
    `UPDATE cellular_reach_requests
       SET status = 'blocked', next_attempt_at = NULL, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'awaiting_approval', 'sent')
       RETURNING *`,
    [ctx.tenantId, row.id, at],
  );
  const fresh = updated.rows[0] ?? row;
  await notifyFailure(ctx, fresh);
  return fresh;
}

/** The next monotonic attempt number of a request (its full attempt audit). */
async function nextAttemptNo(ctx: TenantContext, reachRequestId: string): Promise<number> {
  const result = await getDb().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM cellular_attempts
       WHERE tenant_id = $1 AND reach_request_id = $2`,
    [ctx.tenantId, reachRequestId],
  );
  return Number(result.rows[0]?.count ?? 0) + 1;
}

/** Record one append-only attempt row (id pre-minted for the transport's idempotency key). */
async function recordAttempt(
  ctx: TenantContext,
  reachRequestId: string,
  attemptId: string,
  placement: {
    leg: 'sms' | 'voice';
    cycle: number;
    provider: string;
    connectionId: string | null;
    fromNumber: string | null;
    toNumber: string;
    text: string;
    segments: number | null;
    costMinor: number;
    status: string;
    providerMessageId: string | null;
    providerCallId: string | null;
    detail: string | null;
  },
): Promise<AttemptRow> {
  const at = now();
  const attemptNo = await nextAttemptNo(ctx, reachRequestId);
  const inserted = await getDb().query<AttemptRow>(
    `INSERT INTO cellular_attempts (
       id, tenant_id, reach_request_id, attempt_no, cycle, leg, gate_status, provider,
       connection_id, from_number, to_number, text, segments, cost_minor, status,
       provider_message_id, provider_call_id, detail, attempted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      attemptId,
      ctx.tenantId,
      reachRequestId,
      attemptNo,
      placement.cycle,
      placement.leg,
      placement.provider,
      placement.connectionId,
      placement.fromNumber,
      placement.toNumber,
      placement.text,
      placement.segments,
      placement.costMinor,
      placement.status,
      placement.providerMessageId,
      placement.providerCallId,
      placement.detail,
      at,
    ],
  );
  return inserted.rows[0]!;
}

// ---------------------------------------------------------------------------
// Leg outcomes (drives the pump summary and the callers)
// ---------------------------------------------------------------------------

type LegOutcome =
  | { kind: 'waiting' } // a concurrent pass owns the attempt slot
  | { kind: 'sent' } // the SMS leg was accepted by the carrier
  | { kind: 'voice_delivered' } // the voice fallback call was answered
  | { kind: 'retry_scheduled' } // transient failure; the lease is the schedule
  | { kind: 'failed' } // terminally failed (SMS or voice leg)
  | { kind: 'cost_capped' }; // the policy's cost cap refused the next leg

// ---------------------------------------------------------------------------
// The SMS leg
// ---------------------------------------------------------------------------

/**
 * Attempt one SMS delivery of a reach request. Claims the attempt slot
 * (the lease doubles as the retry schedule — the notifications module's
 * discipline), resolves the pinned connection, enforces the cost cap,
 * delivers through the provider-neutral transport (the pre-minted
 * attempt id is the transport's idempotency key), records the attempt
 * row and moves the request state. Connection/transport problems are
 * TRANSIENT (bounded retries); the carrier's rejection is permanent
 * (the SMS leg is terminal).
 */
async function attemptSmsLeg(ctx: TenantContext, row: ReachRow): Promise<LegOutcome> {
  const at = now();
  const db = getDb();

  // Claim the attempt slot: status 'pending', due, single writer.
  const lease = new Date(at.getTime() + row.retry_backoff_seconds * 1_000);
  const claimed = await db.query<ReachRow>(
    `UPDATE cellular_reach_requests SET next_attempt_at = $3, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
       RETURNING *`,
    [ctx.tenantId, row.id, lease, at],
  );
  const claimedRow = claimed.rows[0];
  if (claimedRow === undefined) return { kind: 'waiting' }; // a concurrent pump owns it

  const connection = await loadPinnedConnection(ctx, claimedRow.connection_id);

  // Cost control: the policy snapshot's rate × the segment estimate.
  const segments = smsSegmentsOf(claimedRow.text);
  const costMinor = smsAttemptCostMinor(segments, claimedRow.sms_segment_cost_minor);
  if (!fitsCostCap(claimedRow.cost_minor_total, costMinor, claimedRow.max_cost_per_reach_minor)) {
    await terminalFail(ctx, claimedRow, 'cost_cap_exceeded');
    return { kind: 'cost_capped' };
  }

  // Deliver through the provider-neutral transport. No transport wired
  // for this vendor → transient, budgeted (the tenant can wire one).
  const attemptId = newId();
  let receipt: {
    status: 'accepted' | 'rejected' | 'failed';
    providerMessageId: string | null;
    detail: string | null;
  };
  try {
    const transport = transportFor(connection.provider);
    receipt = validateTransportSmsReceipt(
      await transport.sendSms({
        provider: connection.provider as 'twilio' | 'telnyx',
        tenantId: ctx.tenantId,
        connectionId: connection.id,
        fromNumber: connection.phone_number,
        toNumber: claimedRow.phone_number,
        text: claimedRow.text,
        segments,
        attemptId,
      }),
    );
  } catch (error) {
    if (error instanceof CellularError && TRANSIENT_CONNECTION_CODES.has(error.code)) {
      // Transient placement failure: an honest, budgeted "tried and could
      // not send" attempt row (no leg placed — connection fields null).
      await recordAttempt(ctx, row.id, attemptId, {
        leg: 'sms',
        cycle: claimedRow.cycle,
        provider: connection.provider,
        connectionId: null,
        fromNumber: null,
        toNumber: claimedRow.phone_number,
        text: claimedRow.text,
        segments,
        costMinor: 0,
        status: 'failed',
        providerMessageId: null,
        providerCallId: null,
        detail: error.message.slice(0, 2_000),
      });
      const counted = await countAttempt(ctx, row, 'sms', 0);
      return budgetOrTerminal(ctx, counted);
    }
    throw error;
  }

  await recordAttempt(ctx, row.id, attemptId, {
    leg: 'sms',
    cycle: claimedRow.cycle,
    provider: connection.provider,
    connectionId: connection.id,
    fromNumber: connection.phone_number,
    toNumber: claimedRow.phone_number,
    text: claimedRow.text,
    segments,
    costMinor,
    status:
      receipt.status === 'accepted' ? 'sent' : receipt.status === 'rejected' ? 'rejected' : 'failed',
    providerMessageId: receipt.providerMessageId,
    providerCallId: null,
    detail: receipt.detail === null ? null : receipt.detail.slice(0, 2_000),
  });
  const counted = await countAttempt(ctx, row, 'sms', costMinor);

  if (receipt.status === 'accepted') {
    const sentAt = toIso(now());
    await db.query(
      `UPDATE cellular_reach_requests
         SET status = 'sent', sent_at = COALESCE(sent_at, $3), next_attempt_at = NULL, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
      [ctx.tenantId, row.id, sentAt, now()],
    );
    return { kind: 'sent' };
  }
  if (receipt.status === 'rejected') {
    // The carrier permanently refused the send: the SMS leg is terminal.
    return decideVoiceFallback(ctx, counted, 'sms_rejected');
  }
  // Transient transport failure: retry within the budget or terminate.
  return budgetOrTerminal(ctx, counted);
}

/** Count one attempt onto the request (and its estimated cost, when placed). */
async function countAttempt(
  ctx: TenantContext,
  row: ReachRow,
  leg: 'sms' | 'voice',
  costMinor: number,
): Promise<ReachRow> {
  const column = leg === 'sms' ? 'sms_attempts_count' : 'voice_attempts_count';
  const updated = await getDb().query<ReachRow>(
    `UPDATE cellular_reach_requests
       SET ${column} = ${column} + 1, cost_minor_total = cost_minor_total + $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
    [ctx.tenantId, row.id, costMinor, now()],
  );
  return updated.rows[0] ?? row;
}

/**
 * A transient SMS failure consumed an attempt: the lease (set at claim
 * time) schedules the next retry while the budget holds; otherwise the
 * SMS leg is terminal.
 */
async function budgetOrTerminal(ctx: TenantContext, row: ReachRow): Promise<LegOutcome> {
  if (row.sms_attempts_count < row.sms_max_attempts) {
    return { kind: 'retry_scheduled' };
  }
  return decideVoiceFallback(ctx, row, 'sms_attempts_exhausted');
}

// ---------------------------------------------------------------------------
// The voice-fallback leg (the routing decision)
// ---------------------------------------------------------------------------

/**
 * The ROUTING decision: the SMS leg terminally failed — fall back to a
 * voice call when the request's policy snapshot permits ("falls back to
 * voice when policy permits"); otherwise the request terminally fails
 * with the SMS failure code. The voice leg is the LAST leg: an answered
 * call delivers the message; anything else fails the request
 * (retryable via retryCellularReach once the cause is fixed).
 */
async function decideVoiceFallback(
  ctx: TenantContext,
  row: ReachRow,
  smsFailureCode: string,
): Promise<LegOutcome> {
  if (!shouldFallBackToVoice(row.voice_fallback as CellularReach['voiceFallback'])) {
    await terminalFail(ctx, row, smsFailureCode);
    return { kind: 'failed' };
  }

  const at = now();
  const db = getDb();
  // Mark the in-flight voice leg (queryable; recovered by call events or
  // an explicit retry if the process dies mid-call).
  const marked = await db.query<ReachRow>(
    `UPDATE cellular_reach_requests
       SET status = 'voice_fallback', next_attempt_at = NULL, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'sent')
       RETURNING *`,
    [ctx.tenantId, row.id, at],
  );
  const markedRow = marked.rows[0] ?? row;
  const connection = await loadPinnedConnection(ctx, markedRow.connection_id);

  const costMinor = voiceAttemptCostMinor(markedRow.voice_per_minute_cost_minor);
  if (!fitsCostCap(markedRow.cost_minor_total, costMinor, markedRow.max_cost_per_reach_minor)) {
    await terminalFail(ctx, markedRow, 'cost_cap_exceeded');
    return { kind: 'cost_capped' };
  }

  const attemptId = newId();
  let receipt: {
    status: 'answered' | 'no_answer' | 'failed';
    providerCallId: string | null;
    detail: string | null;
  };
  try {
    const transport = transportFor(connection.provider);
    receipt = validateTransportVoiceReceipt(
      await transport.placeVoiceCall({
        provider: connection.provider as 'twilio' | 'telnyx',
        tenantId: ctx.tenantId,
        connectionId: connection.id,
        fromNumber: connection.phone_number,
        toNumber: markedRow.phone_number,
        text: markedRow.text,
        attemptId,
      }),
    );
  } catch (error) {
    if (error instanceof CellularError && TRANSIENT_CONNECTION_CODES.has(error.code)) {
      await recordAttempt(ctx, row.id, attemptId, {
        leg: 'voice',
        cycle: markedRow.cycle,
        provider: connection.provider,
        connectionId: null,
        fromNumber: null,
        toNumber: markedRow.phone_number,
        text: markedRow.text,
        segments: null,
        costMinor: 0,
        status: 'failed',
        providerMessageId: null,
        providerCallId: null,
        detail: error.message.slice(0, 2_000),
      });
      const counted = await countAttempt(ctx, row, 'voice', 0);
      await terminalFail(ctx, counted, 'provider_unavailable');
      return { kind: 'failed' };
    }
    throw error;
  }

  await recordAttempt(ctx, row.id, attemptId, {
    leg: 'voice',
    cycle: markedRow.cycle,
    provider: connection.provider,
    connectionId: connection.id,
    fromNumber: connection.phone_number,
    toNumber: markedRow.phone_number,
    text: markedRow.text,
    segments: null,
    costMinor,
    status:
      receipt.status === 'answered' ? 'answered' : receipt.status === 'no_answer' ? 'no_answer' : 'failed',
    providerMessageId: null,
    providerCallId: receipt.providerCallId,
    detail: receipt.detail === null ? null : receipt.detail.slice(0, 2_000),
  });
  const counted = await countAttempt(ctx, row, 'voice', costMinor);

  if (receipt.status === 'answered') {
    await db.query(
      `UPDATE cellular_reach_requests
         SET status = 'delivered', delivered_at = COALESCE(delivered_at, $3), next_attempt_at = NULL,
             updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND status = 'voice_fallback'`,
      [ctx.tenantId, row.id, toIso(now()), now()],
    );
    return { kind: 'voice_delivered' };
  }
  await terminalFail(
    ctx,
    counted,
    receipt.status === 'no_answer' ? 'voice_no_answer' : 'voice_failed',
  );
  return { kind: 'failed' };
}

// ---------------------------------------------------------------------------
// Reach — the outcome-oriented core
// ---------------------------------------------------------------------------

export async function reachAnyone(ctx: TenantContext, input: ReachAnyoneInput): Promise<CellularReach> {
  assertCellularTenantContext(ctx);
  const valid = validateReachAnyoneInput(input);

  // 1. Resolve the recipient (W002: a verified phone identity for a
  //    person; an honest classification for a raw number).
  const recipient: ResolvedRecipient =
    valid.personId !== null
      ? await resolvePersonRecipient(ctx, valid.personId)
      : await resolveRawPhoneRecipient(ctx, valid.phoneNumber!);

  // 2. Resolve + snapshot the policy; enforce the SMS segment policy.
  const policy = await resolvePolicy(ctx, valid.kind);
  const { ok: segmentsOk } = segmentsUnderPolicy(valid.text, policy.maxSmsSegments);
  if (!segmentsOk) {
    throw new CellularError(
      'message_too_long',
      `the message occupies ${smsSegmentsOf(valid.text)} SMS segments; the resolved policy for kind '${valid.kind}' allows at most ${policy.maxSmsSegments}`,
    );
  }

  // 3. Fail fast on connection configuration (honest feedback at ask
  //    time); the resolved connection is pinned onto the request.
  const connection = await resolveSendingConnection(ctx, valid.connectionId);

  // 4. Record the durable intent FIRST — the request id must exist before
  //    the authority gate's idempotency key can reference it.
  const actionKind = reachActionKindFor(recipient.recipientKind);
  const at = now();
  const inserted = await getDb().query<ReachRow>(
    `INSERT INTO cellular_reach_requests (
       tenant_id, kind, recipient_kind, person_id, employee_id, identity_id,
       phone_number, text, connection_id, requested_by, action_kind, status,
       policy_source, voice_fallback, sms_max_attempts, retry_backoff_seconds,
       max_sms_segments, sms_segment_cost_minor, voice_per_minute_cost_minor,
       currency, max_cost_per_reach_minor, failure_notification,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending',
       $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $22
     )
     RETURNING *`,
    [
      ctx.tenantId,
      valid.kind,
      recipient.recipientKind,
      recipient.personId,
      recipient.employeeId,
      recipient.identityId,
      recipient.phoneNumber,
      valid.text,
      connection.id,
      ctx.principalId,
      actionKind,
      policy.source,
      policy.voiceFallback,
      policy.smsMaxAttempts,
      policy.retryBackoffSeconds,
      policy.maxSmsSegments,
      policy.smsSegmentCostMinor,
      policy.voicePerMinuteCostMinor,
      policy.currency,
      policy.maxCostPerReachMinor,
      valid.failureNotification === null ? null : JSON.stringify(valid.failureNotification),
      at,
    ],
  );
  let row = inserted.rows[0]!;

  // 5. Route through the W009 authority matrix, then deliver when allowed.
  const gate = await authorizeReachGate(ctx, row);
  if (gate.status === 'pending') {
    const waiting = await getDb().query<ReachRow>(
      `UPDATE cellular_reach_requests
         SET status = 'awaiting_approval', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
      [ctx.tenantId, row.id, now()],
    );
    row = waiting.rows[0] ?? row;
  } else if (gate.status === 'rejected') {
    row = await blockReach(ctx, row);
  } else {
    await attemptSmsLeg(ctx, row);
  }

  // 6. Return the fresh state.
  return mapReach(await loadReachRow(ctx, row.id));
}

export async function retryCellularReach(
  ctx: TenantContext,
  input: RetryCellularReachInput,
): Promise<CellularReach> {
  assertCellularTenantContext(ctx);
  const valid = validateRetryCellularReachInput(input);
  const row = await loadReachRow(ctx, valid.reachRequestId);

  // Only terminal failures (and a stuck in-flight voice leg) reopen; a
  // blocked request never does — the authority decision is stable per
  // request, so a policy change requires a NEW request.
  if (row.status !== 'failed' && row.status !== 'voice_fallback') {
    throw new CellularError(
      'reach_not_retryable',
      `cellular reach request '${row.id}' is '${row.status}' — only 'failed' (and stuck 'voice_fallback') requests can be retried`,
    );
  }

  // Open a new delivery cycle: the counters reset, the lifetime cost does
  // not (the cost cap spans every cycle — a cost-control property).
  const reopened = await getDb().query<ReachRow>(
    `UPDATE cellular_reach_requests
       SET status = 'pending', failure_code = NULL, sms_attempts_count = 0,
           voice_attempts_count = 0, cycle = cycle + 1, next_attempt_at = NULL, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status IN ('failed', 'voice_fallback')
       RETURNING *`,
    [ctx.tenantId, row.id, now()],
  );
  const fresh = reopened.rows[0];
  if (fresh === undefined) {
    // A concurrent retry won the race — its cycle is the live one.
    throw new CellularError(
      'reach_not_retryable',
      `cellular reach request '${row.id}' was retried concurrently and is no longer in a retryable state`,
    );
  }

  // Re-check the gate (idempotent replay: the recorded decision governs)
  // and deliver the cycle's first attempt when allowed.
  const gate = await authorizeReachGate(ctx, fresh);
  if (gate.status === 'pending') {
    const waiting = await getDb().query<ReachRow>(
      `UPDATE cellular_reach_requests
         SET status = 'awaiting_approval', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
      [ctx.tenantId, fresh.id, now()],
    );
    return mapReach(waiting.rows[0] ?? fresh);
  }
  if (gate.status === 'rejected') {
    return mapReach(await blockReach(ctx, fresh));
  }
  await attemptSmsLeg(ctx, fresh);
  return mapReach(await loadReachRow(ctx, fresh.id));
}

// ---------------------------------------------------------------------------
// The worker seam — the due-processing pump
// ---------------------------------------------------------------------------

/**
 * Advance due reach requests: (a) `awaiting_approval` requests re-check
 * the authority gate (a human approval between pumps unlocks delivery),
 * (b) due `pending` requests (first attempt unlocked by a gate, or a
 * retry whose backoff elapsed) claim their attempt slot and deliver.
 * Nothing in this module owns background time — workers call this on a
 * schedule (the notifications module's pump discipline).
 */
export async function pumpCellularReach(
  ctx: TenantContext,
  query: { limit?: number },
): Promise<CellularPumpSummary> {
  assertCellularTenantContext(ctx);
  const valid = validatePumpQuery(query);
  const at = now();
  const summary: CellularPumpSummary = {
    processed: 0,
    attempted: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    blocked: 0,
    waiting: 0,
    voiceFallback: 0,
  };

  const due = await getDb().query<ReachRow>(
    `SELECT * FROM cellular_reach_requests
       WHERE tenant_id = $1 AND status IN ('pending', 'awaiting_approval')
         AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
    [ctx.tenantId, at, valid.limit],
  );
  for (const row of due.rows) {
    summary.processed += 1;
    const gate = await authorizeReachGate(ctx, row);
    if (gate.status === 'pending') {
      if (row.status !== 'awaiting_approval') {
        await getDb().query(
          `UPDATE cellular_reach_requests SET status = 'awaiting_approval', updated_at = $3
             WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
          [ctx.tenantId, row.id, now()],
        );
      }
      summary.waiting += 1;
      continue;
    }
    if (gate.status === 'rejected') {
      await blockReach(ctx, row);
      summary.blocked += 1;
      continue;
    }

    // Approved: normalize awaiting_approval → pending, then attempt.
    let current = row;
    if (row.status === 'awaiting_approval') {
      const resumed = await getDb().query<ReachRow>(
        `UPDATE cellular_reach_requests SET status = 'pending', updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'
           RETURNING *`,
        [ctx.tenantId, row.id, now()],
      );
      current = resumed.rows[0] ?? row;
    }
    if (current.status !== 'pending') continue; // moved concurrently

    const outcome = await attemptSmsLeg(ctx, current);
    if (outcome.kind === 'waiting') {
      summary.waiting += 1;
      continue;
    }
    summary.attempted += 1;
    if (outcome.kind === 'sent') summary.sent += 1;
    else if (outcome.kind === 'voice_delivered') {
      summary.delivered += 1;
      summary.voiceFallback += 1;
    } else if (outcome.kind === 'failed') {
      summary.failed += 1;
      summary.voiceFallback += 1; // only a placed voice leg fails this way
    } else if (outcome.kind === 'retry_scheduled') summary.waiting += 1;
    // 'cost_capped' is terminal failure without a placed leg
    else summary.failed += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// The provider event edge — receive, dedupe, apply
// ---------------------------------------------------------------------------

/**
 * The envelope's account resolves onto THIS tenant's registered
 * connection — a foreign tenant's endpoint is indistinguishable from an
 * unknown account (ADR-0001, no existence leak; the realtime module's
 * discipline). Status is deliberately NOT checked: a disabled endpoint's
 * in-flight deliveries still report (receipt events finalize past sends;
 * replies need no active connection to land in Aurum).
 */
async function loadEventConnection(
  ctx: TenantContext,
  provider: string,
  providerAccountId: string,
): Promise<ConnectionRow> {
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM cellular_connections
       WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
    [ctx.tenantId, provider, providerAccountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new CellularError(
      'connection_not_found',
      `no ${provider} cellular connection for account '${providerAccountId}' exists in this tenant`,
    );
  }
  return row;
}

/**
 * Claim the ledger event: one application per (tenant, provider, event
 * id) — the ledger row IS the claim (the realtime module's discipline).
 * Returns null when the event was already applied (redelivery).
 */
async function claimEvent(
  ctx: TenantContext,
  event: CanonicalCellularEvent,
  connectionId: string,
): Promise<EventRow | null> {
  const inserted = await getDb().query<EventRow>(
    `INSERT INTO cellular_events (
       tenant_id, provider, provider_event_id, kind, connection_id, event, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING
     RETURNING *`,
    [ctx.tenantId, event.provider, event.providerEventId, event.kind, connectionId, JSON.stringify(event), now()],
  );
  return inserted.rows[0] ?? null;
}

export async function receiveCellularEvent(
  ctx: TenantContext,
  input: ReceiveCellularEventInput,
): Promise<CellularEventResult> {
  assertCellularTenantContext(ctx);
  const valid = validateReceiveCellularEventInput(input);
  const adapter = getCellularAdapter(valid.provider);

  // Provider-native payload → canonical event (adapter-private; the raw
  // envelope never advances past this line).
  const parsed = adapter.parseEvent(valid.payload);
  // Defense in depth: adapter output is re-validated before anything is
  // persisted or handed to a sibling contract (lock 16).
  const event = validateCanonicalCellularEvent(parsed.event);
  if (event.provider !== valid.provider) {
    throw new CellularError(
      'invalid_provider_payload',
      `the ${valid.provider} adapter produced an event tagged '${event.provider}' (internal invariant violation)`,
    );
  }

  // The envelope's account resolves onto this tenant's connection.
  const connection = await loadEventConnection(
    ctx,
    event.provider,
    adapter.normalizeAccountId(event.providerAccountId),
  );

  if (event.kind === 'sms_reply' || event.kind === 'voice_reply') {
    return applyReplyEvent(ctx, event, parsed.channelPayload, connection);
  }
  return applyCarrierEvent(ctx, event, connection);
}

// ---------------------------------------------------------------------------
// Reply events (replies + manager-originated requests)
// ---------------------------------------------------------------------------

/**
 * Apply a message-shaped carrier event: the relay envelope goes to the
 * channels contract's canonical inbound edge FIRST (transcript turn +
 * on-sight identity — idempotent through the conversations contract's
 * provider-message-id dedupe), then the ledger claim decides whether
 * this event id still needs its cellular effects (reply row + reach
 * correlation). An uncorrelated message is the manager-originated path:
 * a manager with no usable Internet data texting/calling Aurum's own
 * number — the request returned into Aurum (transcript + attribution +
 * this row).
 */
async function applyReplyEvent(
  ctx: TenantContext,
  event:
    | Extract<CanonicalCellularEvent, { kind: 'sms_reply' }>
    | Extract<CanonicalCellularEvent, { kind: 'voice_reply' }>,
  channelPayload: unknown,
  connection: ConnectionRow,
): Promise<CellularEventResult> {
  const channel = event.kind === 'sms_reply' ? 'sms' : 'voice';

  // 1. The canonical transcript path (W030): the reply becomes a real
  //    conversation turn attributed through the W002 identity registry.
  let inbound: InboundResult;
  try {
    inbound = await receiveInbound(ctx, { provider: channel, payload: channelPayload });
  } catch (error) {
    if (error instanceof ChannelsError) {
      // The envelope is not a valid canonical ${channel} message — the
      // vendor adapter and the channels adapter disagree, which is an
      // integration bug, surfaced loudly with the canonical code.
      throw new CellularError(
        'invalid_provider_payload',
        `the carrier envelope is not a valid canonical ${channel} message: ${error.message}`,
      );
    }
    throw error;
  }

  // 2. Person attribution (lock 15): the on-sight identity resolves to a
  //    person only when verified AND subject-linked; every other state
  //    records the message without person attribution.
  const identity: ExternalIdentity = inbound.identity;
  let personId: string | null = null;
  let employeeId: string | null = null;
  if (identity.status === 'verified' && identity.subjectId !== null && identity.subjectKind === 'person') {
    personId = identity.subjectId;
    const employee = await getEmployeeByPerson(ctx, personId);
    employeeId = employee === null ? null : employee.id;
  }

  // 3. Claim the ledger event (one application per provider event id).
  const claimed = await claimEvent(ctx, event, connection.id);
  if (claimed === null) {
    return { applied: false, kind: event.kind, reply: null, reach: null };
  }

  // 4. Correlate the reply to an open reach request of this tenant.
  const correlated = await correlateReply(ctx, event);

  // 5. Record the reply row (+ the request's 'replied' transition) —
  //    one transaction, one row per event id.
  const at = now();
  const db = getDb();
  const { replyRow, reachRow } = await db.transaction(async (tx) => {
    const insertedReply = await tx.query<ReplyRow>(
      `INSERT INTO cellular_replies (
         tenant_id, provider, provider_event_id, inbound_kind, reach_request_id,
         channel, from_number, to_number, text, identity_id, person_id, employee_id,
         conversation_id, message_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        ctx.tenantId,
        event.provider,
        event.providerEventId,
        correlated === null ? 'inbound_request' : 'reach_reply',
        correlated === null ? null : correlated.id,
        channel,
        event.fromNumber,
        event.toNumber,
        event.kind === 'sms_reply' ? event.text : event.speech,
        identity.id,
        personId,
        employeeId,
        inbound.message.conversationId,
        inbound.message.id,
        at,
      ],
    );
    let updatedReach: ReachRow | null = correlated;
    if (correlated !== null) {
      const updated = await tx.query<ReachRow>(
        `UPDATE cellular_reach_requests
           SET status = 'replied', delivered_at = COALESCE(delivered_at, $3), replied_at = $3,
               next_attempt_at = NULL, updated_at = $3
           WHERE tenant_id = $1 AND id = $2
             AND status IN ('sent', 'delivered', 'voice_fallback')
           RETURNING *`,
        [ctx.tenantId, correlated.id, at],
      );
      updatedReach = updated.rows[0] ?? correlated;
    }
    return { replyRow: insertedReply.rows[0]!, reachRow: updatedReach };
  });

  return {
    applied: true,
    kind: event.kind,
    reply: mapReply(replyRow),
    reach: reachRow === null ? null : mapReach(reachRow),
  };
}

/**
 * Correlate an inbound message to the tenant's open reach request:
 *  * voice speech — by the call it belongs to (the carrier's call id of
 *    our placed voice attempt);
 *  * SMS — the tenant's most recent un-replied request in a sent-state
 *    to that number whose pinned connection's number matches the
 *    reply's To (routing precision: the reply came in on the same
 *    number the request went out on).
 * Deterministic (created_at DESC); no correlation → the manager-
 * originated inbound path.
 */
async function correlateReply(
  ctx: TenantContext,
  event:
    | Extract<CanonicalCellularEvent, { kind: 'sms_reply' }>
    | Extract<CanonicalCellularEvent, { kind: 'voice_reply' }>,
): Promise<ReachRow | null> {
  const db = getDb();
  if (event.kind === 'voice_reply') {
    const attempt = await db.query<{ reach_request_id: string }>(
      `SELECT reach_request_id FROM cellular_attempts
         WHERE tenant_id = $1 AND provider = $2 AND provider_call_id = $3 AND leg = 'voice'
         ORDER BY attempted_at DESC, id DESC LIMIT 1`,
      [ctx.tenantId, event.provider, event.providerCallId],
    );
    const found = attempt.rows[0];
    if (found === undefined) return null;
    return loadReachRow(ctx, found.reach_request_id);
  }
  const rows = await db.query<ReachRow>(
    `SELECT r.* FROM cellular_reach_requests r
       JOIN cellular_connections c
         ON c.tenant_id = r.tenant_id AND c.id = r.connection_id
       WHERE r.tenant_id = $1 AND r.phone_number = $2 AND c.phone_number = $3
         AND r.status IN ('sent', 'delivered', 'voice_fallback')
         AND r.replied_at IS NULL
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 1`,
    [ctx.tenantId, event.fromNumber, event.toNumber],
  );
  return rows.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Carrier events (delivery receipts + call lifecycle)
// ---------------------------------------------------------------------------

/**
 * Apply a carrier status event: claim the ledger row, then apply its
 * (idempotent, guarded) state effects. A receipt or call event that
 * references no attempt of this tenant's (e.g. the carrier reporting a
 * message another module sent) is OBSERVED and recorded — never an
 * error: the ledger row is the record, the state stays untouched.
 */
async function applyCarrierEvent(
  ctx: TenantContext,
  event:
    | Extract<CanonicalCellularEvent, { kind: 'sms_receipt' }>
    | Extract<CanonicalCellularEvent, { kind: 'call_status' }>,
  connection: ConnectionRow,
): Promise<CellularEventResult> {
  const claimed = await claimEvent(ctx, event, connection.id);
  if (claimed === null) {
    return { applied: false, kind: event.kind, reply: null, reach: null };
  }

  const db = getDb();
  const at = now();

  if (event.kind === 'sms_receipt') {
    const attempt = await db.query<AttemptRow>(
      `SELECT * FROM cellular_attempts
         WHERE tenant_id = $1 AND provider = $2 AND provider_message_id = $3 AND leg = 'sms'
         ORDER BY attempted_at DESC, id DESC LIMIT 1`,
      [ctx.tenantId, event.provider, event.providerMessageId],
    );
    const attemptRow = attempt.rows[0];
    if (attemptRow === undefined) {
      return { applied: true, kind: 'sms_receipt', reply: null, reach: null };
    }
    return applySmsReceipt(ctx, event, attemptRow, at);
  }

  // call_status
  const attempt = await db.query<AttemptRow>(
    `SELECT * FROM cellular_attempts
       WHERE tenant_id = $1 AND provider = $2 AND provider_call_id = $3 AND leg = 'voice'
       ORDER BY attempted_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, event.provider, event.providerCallId],
  );
  const attemptRow = attempt.rows[0];
  if (attemptRow === undefined) {
    return { applied: true, kind: 'call_status', reply: null, reach: null };
  }
  return applyCallStatus(ctx, event, attemptRow, at);
}

/** Apply a terminal delivery receipt to its SMS attempt + reach request. */
async function applySmsReceipt(
  ctx: TenantContext,
  event: Extract<CanonicalCellularEvent, { kind: 'sms_receipt' }>,
  attemptRow: AttemptRow,
  at: Date,
): Promise<CellularEventResult> {
  const db = getDb();
  const detail =
    event.detail === null
      ? `carrier reported '${event.status}'`
      : `carrier reported '${event.status}': ${event.detail}`;

  // Guarded (idempotent): only a 'sent' attempt is still awaiting this
  // receipt; anything else replays as a no-op.
  await db.query(
    `UPDATE cellular_attempts
       SET status = $3, detail = $4, receipt_at = $5
       WHERE tenant_id = $1 AND id = $2 AND status = 'sent'`,
    [
      ctx.tenantId,
      attemptRow.id,
      event.status === 'delivered' ? 'delivered' : event.status === 'undelivered' ? 'undelivered' : 'failed',
      detail.slice(0, 2_000),
      at,
    ],
  );

  if (event.status === 'delivered') {
    const updated = await db.query<ReachRow>(
      `UPDATE cellular_reach_requests
         SET status = 'delivered', delivered_at = COALESCE(delivered_at, $3),
             next_attempt_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'sent'
         RETURNING *`,
      [ctx.tenantId, attemptRow.reach_request_id, at],
    );
    const reach = updated.rows[0];
    if (reach === undefined) {
      // The request already moved (replied / terminal) — read it back.
      const fresh = await loadReachRow(ctx, attemptRow.reach_request_id);
      return { applied: true, kind: 'sms_receipt', reply: null, reach: mapReach(fresh) };
    }
    return { applied: true, kind: 'sms_receipt', reply: null, reach: mapReach(reach) };
  }

  // A failed/undelivered delivery: retry within the snapshot budget,
  // otherwise the SMS leg is terminal (voice fallback decision).
  const row = await loadReachRow(ctx, attemptRow.reach_request_id);
  if (row.status !== 'sent') {
    return { applied: true, kind: 'sms_receipt', reply: null, reach: mapReach(row) };
  }
  if (row.sms_attempts_count < row.sms_max_attempts) {
    const retryAt = new Date(at.getTime() + row.retry_backoff_seconds * 1_000);
    const updated = await db.query<ReachRow>(
      `UPDATE cellular_reach_requests
         SET status = 'pending', next_attempt_at = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND status = 'sent'
         RETURNING *`,
      [ctx.tenantId, row.id, retryAt, at],
    );
    return { applied: true, kind: 'sms_receipt', reply: null, reach: mapReach(updated.rows[0] ?? row) };
  }
  await decideVoiceFallback(ctx, row, 'sms_attempts_exhausted');
  const fresh = await loadReachRow(ctx, row.id);
  return { applied: true, kind: 'sms_receipt', reply: null, reach: mapReach(fresh) };
}

/** Apply a call lifecycle event to its voice attempt + reach request. */
async function applyCallStatus(
  ctx: TenantContext,
  event: Extract<CanonicalCellularEvent, { kind: 'call_status' }>,
  attemptRow: AttemptRow,
  at: Date,
): Promise<CellularEventResult> {
  const db = getDb();

  if (event.callStatus === 'initiated' || event.callStatus === 'ringing') {
    // Recognized call-lifecycle pings: the ledger row is the record.
    const reach = await loadReachRow(ctx, attemptRow.reach_request_id);
    return { applied: true, kind: 'call_status', reply: null, reach: mapReach(reach) };
  }

  if (event.callStatus === 'answered') {
    await db.query(
      `UPDATE cellular_attempts SET status = 'answered', receipt_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status <> 'completed'`,
      [ctx.tenantId, attemptRow.id, at],
    );
    await db.query(
      `UPDATE cellular_reach_requests
         SET status = 'delivered', delivered_at = COALESCE(delivered_at, $3),
             next_attempt_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'voice_fallback'`,
      [ctx.tenantId, attemptRow.reach_request_id, at],
    );
  } else if (event.callStatus === 'completed') {
    await db.query(
      `UPDATE cellular_attempts
         SET status = 'completed', receipt_at = $3, duration_seconds = COALESCE($4, duration_seconds),
             recording_url = COALESCE($5, recording_url)
         WHERE tenant_id = $1 AND id = $2 AND status = 'answered'`,
      [
        ctx.tenantId,
        attemptRow.id,
        at,
        event.durationSeconds,
        event.recordingUrl === null ? null : event.recordingUrl.slice(0, 2_048),
      ],
    );
  } else if (event.callStatus === 'no_answer') {
    await db.query(
      `UPDATE cellular_attempts SET status = 'no_answer', receipt_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'answered'`,
      [ctx.tenantId, attemptRow.id, at],
    );
    const row = await loadReachRow(ctx, attemptRow.reach_request_id);
    if (row.status === 'voice_fallback') {
      await terminalFail(ctx, row, 'voice_no_answer');
    }
  } else {
    // 'failed'
    await db.query(
      `UPDATE cellular_attempts SET status = 'failed', receipt_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'answered'`,
      [ctx.tenantId, attemptRow.id, at],
    );
    const row = await loadReachRow(ctx, attemptRow.reach_request_id);
    if (row.status === 'voice_fallback') {
      await terminalFail(ctx, row, 'voice_failed');
    }
  }

  const fresh = await loadReachRow(ctx, attemptRow.reach_request_id);
  return { applied: true, kind: 'call_status', reply: null, reach: mapReach(fresh) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCellularReach(
  ctx: TenantContext,
  query: { reachRequestId: string },
): Promise<CellularReach> {
  assertCellularTenantContext(ctx);
  const valid = validateGetCellularReachQuery(query);
  const row = await loadReachRow(ctx, valid.reachRequestId);
  return mapReach(row);
}

export async function listCellularReach(
  ctx: TenantContext,
  query: ListCellularReachQuery,
): Promise<CellularReach[]> {
  assertCellularTenantContext(ctx);
  const valid = validateListCellularReachQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.personId !== null) {
    params.push(valid.personId);
    conditions.push(`person_id = $${params.length}`);
  }
  if (valid.phoneNumber !== null) {
    params.push(valid.phoneNumber);
    conditions.push(`phone_number = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ReachRow>(
    `SELECT * FROM cellular_reach_requests WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapReach(row));
}

export async function listCellularAttempts(
  ctx: TenantContext,
  query: ListCellularAttemptsQuery,
): Promise<CellularAttempt[]> {
  assertCellularTenantContext(ctx);
  const valid = validateListCellularAttemptsQuery(query);
  // Uniform not-found: the request must exist in this tenant.
  await loadReachRow(ctx, valid.reachRequestId);
  const rows = await getDb().query<AttemptRow>(
    `SELECT * FROM cellular_attempts
       WHERE tenant_id = $1 AND reach_request_id = $2
       ORDER BY attempt_no ASC`,
    [ctx.tenantId, valid.reachRequestId],
  );
  return rows.rows.map((row) => mapAttempt(row));
}

export async function listCellularReplies(
  ctx: TenantContext,
  query: ListCellularRepliesQuery,
): Promise<CellularReply[]> {
  assertCellularTenantContext(ctx);
  const valid = validateListCellularRepliesQuery(query);
  if (valid.reachRequestId !== null) {
    // Uniform not-found: the request must exist in this tenant.
    await loadReachRow(ctx, valid.reachRequestId);
    const rows = await getDb().query<ReplyRow>(
      `SELECT * FROM cellular_replies
         WHERE tenant_id = $1 AND reach_request_id = $2
         ORDER BY created_at ASC, id ASC LIMIT $3`,
      [ctx.tenantId, valid.reachRequestId, valid.limit],
    );
    return rows.rows.map((row) => mapReply(row));
  }
  const rows = await getDb().query<ReplyRow>(
    `SELECT * FROM cellular_replies WHERE tenant_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map((row) => mapReply(row));
}

export async function listCellularEvents(
  ctx: TenantContext,
  query: ListCellularEventsQuery,
): Promise<CellularEventRecord[]> {
  assertCellularTenantContext(ctx);
  const valid = validateListCellularEventsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM cellular_events WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapEvent(row));
}
