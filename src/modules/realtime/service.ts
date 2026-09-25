// The realtime module's operations (W086 — Realtime Voice and Meeting
// Companion). House discipline throughout follows the meetings module
// (W085): explicit TenantContext on every call, uniform cross-tenant
// not-found (ADR-0001), parameterized SQL only through the db port,
// append-only evidence enforced at the storage layer, provider envelopes
// parsed by private adapters and re-validated before application.
//
// DURABLE-FIRST LIFECYCLE (lock 35/36; handoff §4.5): a session start
// records the `requested` intent BEFORE the transport materializes the
// room (concurrent starts and failed materializations are explicit,
// queryable rows); every terminal transition that reached `live` sets
// `finalize_pending`, and the durable finalization WORKFLOW RUN (the
// W080 port) materializes the transcript artifact through the
// object-storage port and records the session-close observation (W004)
// — kill/restart-safe: `pumpRealtimeFinalization` recovers the crash
// window between a terminal transition and its run, idempotently (first
// write wins on the run's idempotency key).
//
// THE CONSENT FLOOR (W086 acceptance "consent/recording state"): a
// recording may run ONLY while every currently-joined non-Aurum
// participant has explicitly granted consent. A start without it is
// refused AND left as an explicit `recording.blocked` ledger event; a
// revocation while recording STOPS the recording (the gate must hold
// continuously). Both consent paths — the domain op (companion UI) and
// the provider event (DTMF/verbal telephony consent) — land in the same
// append-only ledger.
//
// INTERRUPTION (W086 acceptance): a `response.interrupted` event marks
// the in-flight spoken response interrupted with the interrupting
// participant attributed (barge-in). One response may be in flight at a
// time (`response_in_flight`); callers wait for the completed or
// interrupted event before speaking again.
//
// AUTHORIZATION ENFORCEMENT POINTS: active operations (start, dial,
// recording control, join grants) require an ACTIVE connection and a
// current OAuth grant (fail fast — the meetings discipline). Passive
// event application requires only a non-disabled connection: a live
// session's events must land even if a grant lapses mid-flight (the
// start authorized the flow; orphaning live sessions to an expiry check
// would lose evidence).
//
// CROSS-CONTRACT DISCIPLINE: sibling module contracts are never called
// inside a transaction of this module that they could nest into — the
// identity verified-email bridge and the observations recording path use
// only plain SELECTs/single-statement writes (verified), and the one
// workflow-contract call (startRun) is deliberately post-commit.

import { createHash } from 'node:crypto';
import { now } from '@/infra/clock';
import { putBlobObject } from '@/infra/blob';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { resolveDeploymentProfile } from '@/infra/deployment';
import { newId } from '@/infra/ids';
import { getLock } from '@/infra/lock';
import type { TenantContext } from '@/infra/tenant';
import {
  findExternalIdentityByProviderKey,
  IdentityError,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import { getMeetingSession, MeetingsError } from '@/modules/meetings/contract';
import { ObservationsError, recordObservation } from '@/modules/observations/contract';
import {
  registerWorkflow,
  startRun,
  WorkflowError,
  type WorkflowExecutorBindings,
  type WorkflowStepInvocation,
  type WorkflowStepResult,
} from '@/modules/workflow/contract';
import { getRealtimeAdapter } from './adapters';
import { RealtimeError } from './errors';
import {
  assertRealtimeTenantContext,
  isRealtimeFailureCode,
  isUuid,
  validateDialInput,
  validateEventParseResult,
  validateListArtifactsQuery,
  validateListConnectionsQuery,
  validateListEventsQuery,
  validateListParticipantsQuery,
  validateListResponsesQuery,
  validateListSessionsQuery,
  validateListTurnsQuery,
  validateReceiveEventInput,
  validateRecordConsentInput,
  validateRegisterConnectionInput,
  validateSessionRefInput,
  validateSetConnectionStatusInput,
  validateSpeakInput,
  validateStartSessionInput,
  validateStopSessionInput,
  type ValidatedEventParseResult,
  type ValidatedListArtifactsQuery,
  type ValidatedListConnectionsQuery,
  type ValidatedListEventsQuery,
  type ValidatedListParticipantsQuery,
  type ValidatedListResponsesQuery,
  type ValidatedListSessionsQuery,
  type ValidatedListTurnsQuery,
  type ValidatedRealtimeEvent,
  type ValidatedRegisterConnectionInput,
  type ValidatedSessionRefInput,
  type ValidatedSetConnectionStatusInput,
} from './validation';
import type {
  DialRealtimeParticipantInput,
  ListRealtimeArtifactsQuery,
  ListRealtimeConnectionsQuery,
  ListRealtimeEventsQuery,
  ListRealtimeParticipantsQuery,
  ListRealtimeResponsesQuery,
  ListRealtimeSessionsQuery,
  ListRealtimeTurnsQuery,
  RealtimeArtifact,
  RealtimeConnection,
  RealtimeConnectionStatus,
  RealtimeEventRecord,
  RealtimeEventResult,
  RealtimeFinalizationPumpOutcome,
  RealtimeJoinGrant,
  RealtimeParticipant,
  RealtimeRecordingArtifactInfo,
  RealtimeRecordingStopResult,
  RealtimeResponse,
  RealtimeSession,
  RealtimeSessionStartResult,
  RealtimeSessionStopResult,
  RealtimeTransport,
  RealtimeTurn,
  ReceiveRealtimeEventInput,
  RecordRealtimeConsentInput,
  RegisterRealtimeConnectionInput,
  RegisterRealtimeConnectionResult,
  SpeakRealtimeResponseInput,
  StartRealtimeSessionInput,
  StopRealtimeSessionInput,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long one per-session application/speak pass may hold its lock. */
const SESSION_LOCK_TTL_MS = 60_000;

/** The durable finalization workflow's identity (W080 port). */
export const REALTIME_FINALIZE_DEFINITION_KEY = 'realtime.session-finalize';
const REALTIME_FINALIZE_TITLE = 'Realtime session finalization';

function sessionLockKey(sessionId: string): string {
  return `realtime:session:${sessionId}`;
}

function finalizeIdempotencyKey(sessionId: string): string {
  return `realtime-finalize-${sessionId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Maps any transport-thrown error onto a canonical session failure code. */
function canonicalFailureCodeOf(error: unknown): 'transport_failed' | 'provider_unavailable' {
  if (error instanceof RealtimeError && isRealtimeFailureCode(error.code)) {
    return error.code as 'transport_failed' | 'provider_unavailable';
  }
  return 'transport_failed';
}

// ---------------------------------------------------------------------------
// Row shapes + mappers
// ---------------------------------------------------------------------------

interface ConnectionRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_account_id: string;
  display_name: string | null;
  auth_kind: string;
  credential_ref: string;
  oauth_scopes: string[];
  oauth_expires_at: Date | string | null;
  status: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  provider: string;
  kind: string;
  status: string;
  title: string | null;
  meeting_session_id: string | null;
  provider_room_id: string | null;
  recording_state: string;
  ended_reason: string | null;
  error_code: string | null;
  error_detail: string | null;
  finalize_pending: boolean;
  finalize_run_id: string | null;
  evidence_observation_id: string | null;
  created_by: string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ParticipantRow extends DbRow {
  id: string;
  tenant_id: string;
  session_id: string;
  provider_participant_id: string;
  role: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  subject_id: string | null;
  resolved_via: string | null;
  consent: string;
  joined_at: Date | string | null;
  left_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  session_id: string;
  source: string;
  kind: string;
  provider_event_id: string | null;
  participant_id: string | null;
  detail: Record<string, unknown>;
  occurred_at: Date | string;
  created_at: Date | string;
}

interface TurnRow extends DbRow {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_no: string | number;
  kind: string;
  speaker_participant_id: string | null;
  speaker_name: string | null;
  text: string;
  confidence: number | null;
  response_id: string | null;
  event_id: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  created_at: Date | string;
}

interface ResponseRow extends DbRow {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string | null;
  request_turn_id: string | null;
  text: string;
  status: string;
  interrupted_by_participant_id: string | null;
  error_detail: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  interrupted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ArtifactRow extends DbRow {
  id: string;
  tenant_id: string;
  session_id: string;
  kind: string;
  domain_key: string | null;
  provider_artifact_id: string | null;
  display_name: string | null;
  media_type: string | null;
  byte_size: number | null;
  storage_ref: string;
  checksum: string | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapConnection(row: ConnectionRow): RealtimeConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as RealtimeConnection['provider'], // CHECK-constrained by migration 001
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    authKind: row.auth_kind as RealtimeConnection['authKind'], // CHECK-constrained
    credentialRef: row.credential_ref,
    oauthScopes: row.oauth_scopes,
    oauthExpiresAt: toIsoOrNull(row.oauth_expires_at),
    status: row.status as RealtimeConnectionStatus, // CHECK-constrained
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSession(row: SessionRow): RealtimeSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    provider: row.provider as RealtimeSession['provider'], // CHECK-constrained
    kind: row.kind as RealtimeSession['kind'], // CHECK-constrained
    status: row.status as RealtimeSession['status'], // CHECK-constrained
    title: row.title,
    meetingSessionId: row.meeting_session_id,
    providerRoomId: row.provider_room_id,
    recordingState: row.recording_state as RealtimeSession['recordingState'], // CHECK-constrained
    endedReason: (row.ended_reason ?? null) as RealtimeSession['endedReason'],
    errorCode: (row.error_code ?? null) as RealtimeSession['errorCode'],
    errorDetail: row.error_detail,
    finalizePending: row.finalize_pending,
    finalizeRunId: row.finalize_run_id,
    evidenceObservationId: row.evidence_observation_id,
    createdBy: row.created_by,
    startedAt: toIsoOrNull(row.started_at),
    endedAt: toIsoOrNull(row.ended_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapParticipant(row: ParticipantRow): RealtimeParticipant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    providerParticipantId: row.provider_participant_id,
    role: row.role as RealtimeParticipant['role'], // CHECK-constrained
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    subjectId: row.subject_id,
    resolvedVia: row.resolved_via === null ? null : 'verified_email_identity',
    consent: row.consent as RealtimeParticipant['consent'], // CHECK-constrained
    joinedAt: toIsoOrNull(row.joined_at),
    leftAt: toIsoOrNull(row.left_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: EventRow): RealtimeEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    source: row.source as RealtimeEventRecord['source'], // CHECK-constrained
    kind: row.kind as RealtimeEventRecord['kind'], // CHECK-constrained
    providerEventId: row.provider_event_id,
    participantId: row.participant_id,
    detail: row.detail ?? {},
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
  };
}

function mapTurn(row: TurnRow): RealtimeTurn {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    turnNo: Number(row.turn_no),
    kind: row.kind as RealtimeTurn['kind'], // CHECK-constrained
    speakerParticipantId: row.speaker_participant_id,
    speakerName: row.speaker_name,
    text: row.text,
    confidence: row.confidence,
    responseId: row.response_id,
    eventId: row.event_id,
    startedAt: toIso(row.started_at),
    endedAt: toIsoOrNull(row.ended_at),
    createdAt: toIso(row.created_at),
  };
}

function mapResponse(row: ResponseRow): RealtimeResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    requestTurnId: row.request_turn_id,
    text: row.text,
    status: row.status as RealtimeResponse['status'], // CHECK-constrained
    interruptedByParticipantId: row.interrupted_by_participant_id,
    errorDetail: row.error_detail,
    startedAt: toIso(row.started_at),
    completedAt: toIsoOrNull(row.completed_at),
    interruptedAt: toIsoOrNull(row.interrupted_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapArtifact(row: ArtifactRow): RealtimeArtifact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    kind: row.kind as RealtimeArtifact['kind'], // CHECK-constrained
    domainKey: row.domain_key,
    providerArtifactId: row.provider_artifact_id,
    displayName: row.display_name,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    storageRef: row.storage_ref,
    checksum: row.checksum,
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

let realtimeTransport: RealtimeTransport | null = null;

/**
 * Infrastructure wiring for the transport port. Real transports (provider
 * SDKs / HTTP) are implemented inside `src/modules/realtime/adapters/`
 * and wired once at process start; tests substitute a scripted transport.
 * `null` restores the default "no provider available" state.
 */
export function setRealtimeTransport(transport: RealtimeTransport | null): void {
  realtimeTransport = transport;
}

/** The currently wired transport (null when none — starts then fail `provider_unavailable`). */
export function getRealtimeTransport(): RealtimeTransport | null {
  return realtimeTransport;
}

function transportFor(provider: string): RealtimeTransport {
  if (realtimeTransport === null || realtimeTransport.provider !== provider) {
    throw new RealtimeError(
      'provider_unavailable',
      `no realtime transport is wired for provider '${provider}' (wire one via setRealtimeTransport)`,
    );
  }
  return realtimeTransport;
}

// ---------------------------------------------------------------------------
// Connection loading helpers (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function loadConnectionRow(
  ctx: TenantContext,
  connectionId: string,
): Promise<ConnectionRow> {
  if (!isUuid(connectionId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new RealtimeError(
      'connection_not_found',
      `connection '${connectionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM realtime_connections WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, connectionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RealtimeError(
      'connection_not_found',
      `connection '${connectionId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function loadConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<RealtimeConnection> {
  return mapConnection(await loadConnectionRow(ctx, connectionId));
}

async function loadActiveConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<RealtimeConnection> {
  const connection = await loadConnection(ctx, connectionId);
  if (connection.status !== 'active') {
    throw new RealtimeError(
      'connection_disabled',
      `connection '${connection.id}' (${connection.provider}) is disabled`,
    );
  }
  return connection;
}

async function loadConnectionByAccount(
  ctx: TenantContext,
  provider: RealtimeConnection['provider'],
  providerAccountId: string,
): Promise<ConnectionRow> {
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM realtime_connections
       WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
    [ctx.tenantId, provider, providerAccountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RealtimeError(
      'connection_not_found',
      `no ${provider} realtime connection for account '${providerAccountId}' exists in this tenant`,
    );
  }
  return row;
}

/**
 * Authorization guard for ACTIVE operations: a recorded OAuth grant that
 * has lapsed blocks starts/dials/recording until the tenant re-authorizes
 * (fail fast — the meetings discipline). api_key grants never lapse.
 */
function assertAuthorizationCurrent(connection: RealtimeConnection, at: Date): void {
  if (connection.authKind === 'oauth' && connection.oauthExpiresAt !== null) {
    if (at.getTime() >= Date.parse(connection.oauthExpiresAt)) {
      throw new RealtimeError(
        'realtime_authorization_expired',
        `the OAuth grant of connection '${connection.id}' (${connection.provider}) expired at ${connection.oauthExpiresAt} — re-register the connection to re-authorize`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Session loading helpers
// ---------------------------------------------------------------------------

async function loadSessionRow(ctx: TenantContext, sessionId: string): Promise<SessionRow> {
  if (!isUuid(sessionId)) {
    throw new RealtimeError(
      'session_not_found',
      `session '${sessionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<SessionRow>(
    `SELECT * FROM realtime_sessions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RealtimeError(
      'session_not_found',
      `session '${sessionId}' does not exist in this tenant`,
    );
  }
  return row;
}

function assertLive(session: SessionRow): void {
  if (session.status !== 'live') {
    throw new RealtimeError(
      session.status === 'requested' ? 'session_not_live' : 'session_terminal',
      `session '${session.id}' is ${session.status} — only a live session supports this operation`,
    );
  }
}

async function findSessionRowByRoom(
  ctx: TenantContext,
  connectionId: string,
  providerRoomId: string,
): Promise<SessionRow | null> {
  const row = (
    await getDb().query<SessionRow>(
      `SELECT * FROM realtime_sessions
         WHERE tenant_id = $1 AND connection_id = $2 AND provider_room_id = $3`,
      [ctx.tenantId, connectionId, providerRoomId],
    )
  ).rows[0];
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The verified-email identity bridge (read-only — W002; the meetings
// module's discipline; full unification is W095's declared job)
// ---------------------------------------------------------------------------

async function resolveSubjectByEmail(
  ctx: TenantContext,
  email: string,
): Promise<string | null> {
  const probes = email === email.toLowerCase() ? [email] : [email, email.toLowerCase()];
  for (const probe of probes) {
    let identity: ExternalIdentity | null;
    try {
      identity = await findExternalIdentityByProviderKey(ctx, {
        provider: 'email',
        providerAccountId: probe,
      });
    } catch (error) {
      if (error instanceof IdentityError) {
        // A sibling rejection here contradicts a pre-validated read —
        // stay loud rather than wrong (the sources module's discipline).
        throw new Error(
          `the identity contract rejected the realtime participant bridge (internal invariant violation): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (identity !== null && identity.status === 'verified' && identity.subjectId !== null) {
      return identity.subjectId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Participant registry (get-or-create on sight — the ADR-0003 discipline)
// ---------------------------------------------------------------------------

interface ParticipantFacets {
  providerParticipantId: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  role: 'human' | 'aurum' | 'phone';
}

/** Plain-read get (no creation) — the pre-transaction half of get-or-create. */
async function findParticipantRow(
  ctx: TenantContext,
  sessionId: string,
  providerParticipantId: string,
): Promise<ParticipantRow | null> {
  const row = (
    await getDb().query<ParticipantRow>(
      `SELECT * FROM realtime_participants
         WHERE tenant_id = $1 AND session_id = $2 AND provider_participant_id = $3`,
      [ctx.tenantId, sessionId, providerParticipantId],
    )
  ).rows[0];
  return row ?? null;
}

/**
 * Get-or-create one participant. The verified-email resolution (an
 * identity-contract read) happens BEFORE the insert transaction opens —
 * sibling contracts are never called inside this module's transactions.
 */
async function captureParticipant(
  ctx: TenantContext,
  sessionId: string,
  facets: ParticipantFacets,
): Promise<ParticipantRow> {
  const existing = await findParticipantRow(ctx, sessionId, facets.providerParticipantId);
  if (existing !== null) return existing;
  const subjectId =
    facets.email !== null ? await resolveSubjectByEmail(ctx, facets.email) : null;
  let inserted: ParticipantRow | undefined;
  try {
    inserted = (
      await getDb().query<ParticipantRow>(
        `INSERT INTO realtime_participants (
             tenant_id, session_id, provider_participant_id, role, display_name,
             email, phone, subject_id, resolved_via
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
        [
          ctx.tenantId,
          sessionId,
          facets.providerParticipantId,
          facets.role,
          facets.displayName,
          facets.email,
          facets.phone,
          subjectId,
          subjectId === null ? null : 'verified_email_identity',
        ],
      )
    ).rows[0];
  } catch (error) {
    if (isDuplicateKeyOn(error, 'realtime_participants')) {
      // A concurrent sight won the get-or-create — return its row.
      const raced = await findParticipantRow(ctx, sessionId, facets.providerParticipantId);
      if (raced !== null) return raced;
    }
    throw error;
  }
  return inserted!;
}

async function loadParticipantRow(
  ctx: TenantContext,
  sessionId: string,
  participantId: string,
): Promise<ParticipantRow> {
  if (!isUuid(participantId)) {
    throw new RealtimeError(
      'participant_not_found',
      `participant '${participantId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ParticipantRow>(
    `SELECT * FROM realtime_participants WHERE tenant_id = $1 AND session_id = $2 AND id = $3`,
    [ctx.tenantId, sessionId, participantId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RealtimeError(
      'participant_not_found',
      `participant '${participantId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function loadAurumParticipant(
  ctx: TenantContext,
  sessionId: string,
): Promise<ParticipantRow> {
  const row = (
    await getDb().query<ParticipantRow>(
      `SELECT * FROM realtime_participants
         WHERE tenant_id = $1 AND session_id = $2 AND role = 'aurum'`,
      [ctx.tenantId, sessionId],
    )
  ).rows[0];
  if (row === undefined) {
    throw new RealtimeError(
      'participant_not_found',
      `session '${sessionId}' has no aurum participant registered`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Domain event recording (the explicit trail)
// ---------------------------------------------------------------------------

async function recordDomainEvent(
  db: Queryable,
  ctx: TenantContext,
  sessionId: string,
  kind: RealtimeEventRecord['kind'],
  detail: Record<string, unknown>,
  participantId: string | null,
  occurredAt: Date,
): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO realtime_events (
         tenant_id, session_id, source, kind, provider_event_id, participant_id,
         detail, occurred_at
       ) VALUES ($1, $2, 'domain', $3, NULL, $4, $5::jsonb, $6)
       RETURNING id`,
    [ctx.tenantId, sessionId, kind, participantId, JSON.stringify(detail), occurredAt],
  );
  return inserted.rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Turn numbering (per-session, under the session lock)
// ---------------------------------------------------------------------------

async function nextTurnNo(db: Queryable, tenantId: string, sessionId: string): Promise<number> {
  const row = (
    await db.query<{ next: number }>(
      `SELECT COALESCE(MAX(turn_no), 0) + 1 AS next FROM realtime_turns
         WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
  ).rows[0];
  return Number(row?.next ?? 1);
}

// ---------------------------------------------------------------------------
// Connections — public operations
// ---------------------------------------------------------------------------

export async function registerRealtimeConnection(
  ctx: TenantContext,
  input: RegisterRealtimeConnectionInput,
): Promise<RegisterRealtimeConnectionResult> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedRegisterConnectionInput = validateRegisterConnectionInput(input);
  const adapter = getRealtimeAdapter(valid.provider);
  const providerAccountId = adapter.normalizeAccountId(valid.providerAccountId);
  const at = now();
  const db = getDb();

  // Re-registering an existing connection is the RE-AUTHORIZATION path
  // (the meetings module's discipline): authorization fields move; the
  // endpoint's identity never changes.
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM realtime_connections
         WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
      [ctx.tenantId, valid.provider, providerAccountId],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<ConnectionRow>(
        `UPDATE realtime_connections SET
             auth_kind = $4, credential_ref = $5, oauth_scopes = $6::jsonb,
             oauth_expires_at = $7, updated_at = $8
           WHERE tenant_id = $1 AND id = $2 AND provider = $3
         RETURNING *`,
        [
          ctx.tenantId,
          existingId,
          valid.provider,
          valid.authKind,
          valid.credentialRef,
          JSON.stringify(valid.oauthScopes),
          valid.oauthExpiresAt === null ? null : new Date(valid.oauthExpiresAt),
          at,
        ],
      );
      return { connection: mapConnection(updated.rows[0]!), created: false };
    }
    let inserted;
    try {
      inserted = await tx.query<ConnectionRow>(
        `INSERT INTO realtime_connections (
             tenant_id, provider, provider_account_id, display_name, auth_kind,
             credential_ref, oauth_scopes, oauth_expires_at, status, created_by,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'active', $9, $10, $10)
           RETURNING *`,
        [
          ctx.tenantId,
          valid.provider,
          providerAccountId,
          valid.displayName,
          valid.authKind,
          valid.credentialRef,
          JSON.stringify(valid.oauthScopes),
          valid.oauthExpiresAt === null ? null : new Date(valid.oauthExpiresAt),
          ctx.principalId,
          at,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'realtime_connections')) {
        throw new RealtimeError(
          'realtime_connection_conflict',
          'a realtime connection for this provider account was created concurrently; retry the registration',
        );
      }
      throw error;
    }
    return { connection: mapConnection(inserted.rows[0]!), created: true };
  });
}

export async function getRealtimeConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<RealtimeConnection> {
  assertRealtimeTenantContext(ctx);
  return loadConnection(ctx, connectionId);
}

export async function listRealtimeConnections(
  ctx: TenantContext,
  query: ListRealtimeConnectionsQuery,
): Promise<RealtimeConnection[]> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedListConnectionsQuery = validateListConnectionsQuery(query);
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
  const rows = await getDb().query<ConnectionRow>(
    `SELECT * FROM realtime_connections WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapConnection);
}

export async function setRealtimeConnectionStatus(
  ctx: TenantContext,
  input: { connectionId: string; status: RealtimeConnectionStatus },
): Promise<RealtimeConnection> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedSetConnectionStatusInput = validateSetConnectionStatusInput(input);
  const result = await getDb().query<ConnectionRow>(
    `UPDATE realtime_connections SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, valid.connectionId, valid.status, now()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant connections are indistinguishable from missing ones.
    throw new RealtimeError(
      'connection_not_found',
      `connection '${valid.connectionId}' does not exist in this tenant`,
    );
  }
  return mapConnection(row);
}

// ---------------------------------------------------------------------------
// Sessions — start
// ---------------------------------------------------------------------------

export async function startRealtimeSession(
  ctx: TenantContext,
  input: StartRealtimeSessionInput,
): Promise<RealtimeSessionStartResult> {
  assertRealtimeTenantContext(ctx);
  const valid = validateStartSessionInput(input);
  const connection = await loadActiveConnection(ctx, valid.connectionId);
  assertAuthorizationCurrent(connection, now());
  const adapter = getRealtimeAdapter(connection.provider);
  const db = getDb();

  // The meetings-module reference this participation/companion session
  // belongs to must be READABLE through the meetings contract — an
  // opaque, validated reference (never a foreign key).
  if (valid.meetingSessionId !== null) {
    try {
      await getMeetingSession(ctx, valid.meetingSessionId);
    } catch (error) {
      if (error instanceof MeetingsError) {
        throw new RealtimeError(
          'invalid_realtime_input',
          `meetingSessionId '${valid.meetingSessionId}' does not reference a readable meeting session in this tenant (${error.code})`,
        );
      }
      throw error;
    }
  }

  // 1. Durable start intent FIRST (concurrent starts and failed
  //    materializations become explicit, queryable rows).
  const at = now();
  const inserted = await db.query<SessionRow>(
    `INSERT INTO realtime_sessions (
         tenant_id, connection_id, provider, kind, status, title,
         meeting_session_id, recording_state, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'requested', $5, $6, 'off', $7, $8, $8)
       RETURNING *`,
    [
      ctx.tenantId,
      connection.id,
      connection.provider,
      valid.kind,
      valid.title,
      valid.meetingSessionId,
      ctx.principalId,
      at,
    ],
  );
  const session = inserted.rows[0]!;
  const agentParticipantId = adapter.agentParticipantId(session.id);

  // 2. Materialize the room through the provider-neutral transport.
  let handle: { providerRoomId: string; agentParticipantId: string };
  try {
    const transport = transportFor(connection.provider);
    handle = await transport.startRoom({
      provider: connection.provider,
      tenantId: ctx.tenantId,
      connectionId: connection.id,
      providerAccountId: connection.providerAccountId,
      credentialRef: connection.credentialRef,
      sessionId: session.id,
      kind: valid.kind,
      agentParticipantId,
      title: valid.title,
    });
  } catch (error) {
    const failure = error instanceof RealtimeError && error.code === 'provider_unavailable'
      ? 'provider_unavailable'
      : canonicalFailureCodeOf(error);
    await markSessionFailed(ctx, session.id, failure, describeError(error), false);
    throw error instanceof RealtimeError
      ? error
      : new RealtimeError('transport_failed', describeError(error));
  }

  // 3. Room live: fill the one-way room link (a concurrent stop that won
  //    the session first makes this a no-op — the guard below reports it).
  const liveAt = now();
  const updated = await db.query<SessionRow>(
    `UPDATE realtime_sessions SET
         status = 'live', provider_room_id = $3, started_at = $4, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'requested'
       RETURNING *`,
    [ctx.tenantId, session.id, handle.providerRoomId, liveAt],
  );
  if (updated.rows[0] === undefined) {
    // The session was stopped (or otherwise terminally transitioned)
    // while the room was being materialized. The provider room dies by
    // its own empty-room timeout; the durable state stays authoritative.
    throw new RealtimeError(
      'session_terminal',
      `session '${session.id}' reached a terminal state while its room was being materialized`,
    );
  }

  // 4. Register Aurum's own participant (speaker attribution for Aurum).
  await captureParticipant(ctx, session.id, {
    providerParticipantId: agentParticipantId,
    displayName: 'Aurum',
    email: null,
    phone: null,
    role: 'aurum',
  });

  // 5. Telephony: place the SIP dial-out this session exists for.
  if (valid.dial !== null) {
    try {
      const transport = transportFor(connection.provider);
      const dialed = await transport.dial({
        provider: connection.provider,
        tenantId: ctx.tenantId,
        connectionId: connection.id,
        providerAccountId: connection.providerAccountId,
        credentialRef: connection.credentialRef,
        sessionId: session.id,
        providerRoomId: handle.providerRoomId,
        phoneNumber: valid.dial.phoneNumber,
        displayName: valid.dial.displayName,
      });
      await captureParticipant(ctx, session.id, {
        providerParticipantId: dialed.providerParticipantId,
        displayName: valid.dial.displayName,
        email: null,
        phone: valid.dial.phoneNumber,
        role: 'phone',
      });
    } catch (error) {
      await markSessionFailed(ctx, session.id, 'dial_failed', describeError(error), true);
      throw new RealtimeError('transport_failed', describeError(error));
    }
  }

  return { session: mapSession(await loadSessionRow(ctx, session.id)) };
}

/** Marks a session terminally failed (explicit, never silent). */
async function markSessionFailed(
  ctx: TenantContext,
  sessionId: string,
  code: string,
  detail: string,
  wasLive: boolean,
): Promise<void> {
  await getDb().query(
    `UPDATE realtime_sessions SET
         status = 'failed', error_code = $3, error_detail = $4,
         finalize_pending = $5, ended_at = $6, updated_at = $6
       WHERE tenant_id = $1 AND id = $2 AND status IN ('requested', 'live')`,
    [ctx.tenantId, sessionId, code, detail.slice(0, 2000) || 'unknown failure', wasLive, now()],
  );
}

// ---------------------------------------------------------------------------
// Sessions — stop (idempotent; the finalization recovery entry)
// ---------------------------------------------------------------------------

export async function stopRealtimeSession(
  ctx: TenantContext,
  input: StopRealtimeSessionInput,
): Promise<RealtimeSessionStopResult> {
  assertRealtimeTenantContext(ctx);
  const valid = validateStopSessionInput(input);
  const session = await loadSessionRow(ctx, valid.sessionId);
  const at = now();

  if (session.status === 'requested' || session.status === 'live') {
    // Stop a running recording first (its artifact lands before the end).
    // A transport failure here leaves the truthful 'recording' state —
    // the session still ends (durable state is authoritative).
    if (session.recording_state === 'recording') {
      await stopRecordingInternal(ctx, session).catch(() => undefined);
    }
    // Provider room teardown is BEST-EFFORT after the durable end: a
    // transport hiccup cannot un-end a session, and an orphaned room
    // dies by the provider's own empty-room timeout.
    await stopRoomBestEffort(ctx, session);
    const wasLive = session.started_at !== null;
    const ended = await getDb().transaction(async (tx) => {
      const updated = await tx.query<SessionRow>(
        `UPDATE realtime_sessions SET
             status = 'ended', ended_reason = 'caller_stopped',
             finalize_pending = $3, ended_at = $4, updated_at = $4
           WHERE tenant_id = $1 AND id = $2 AND status IN ('requested', 'live')
           RETURNING *`,
        [ctx.tenantId, session.id, wasLive, at],
      );
      const row = updated.rows[0] ?? (await loadSessionRow(ctx, session.id));
      if (row.status === 'ended' && row.ended_reason === 'caller_stopped') {
        await recordDomainEvent(
          tx,
          ctx,
          session.id,
          'session.ended',
          { reason: 'caller_stopped', by: ctx.principalId },
          null,
          at,
        );
      }
      return row;
    });
    if (ended.status === 'ended') {
      const ensured = await ensureFinalizeRun(ctx, ended);
      return { session: mapSession(ended), finalizeRunId: ensured };
    }
    return { session: mapSession(ended), finalizeRunId: ended.finalize_run_id };
  }

  // Terminal already: re-stopping is the idempotent recovery path — it
  // re-ensures the finalization run for an ended/failed session (a no-op
  // when ensured) and reports the current state.
  const ensured = await ensureFinalizeRun(ctx, session);
  return { session: mapSession(session), finalizeRunId: ensured };
}

async function stopRoomBestEffort(ctx: TenantContext, session: SessionRow): Promise<void> {
  if (session.provider_room_id === null) return;
  try {
    const connection = await loadConnection(ctx, session.connection_id);
    const transport = transportFor(connection.provider);
    await transport.stopRoom({
      provider: connection.provider,
      tenantId: ctx.tenantId,
      connectionId: connection.id,
      providerAccountId: connection.providerAccountId,
      credentialRef: connection.credentialRef,
      sessionId: session.id,
      providerRoomId: session.provider_room_id,
    });
  } catch {
    // Durable state is authoritative; the empty-room timeout backstops.
  }
}

// ---------------------------------------------------------------------------
// Sessions — reads
// ---------------------------------------------------------------------------

export async function getRealtimeSession(
  ctx: TenantContext,
  sessionId: string,
): Promise<RealtimeSession> {
  assertRealtimeTenantContext(ctx);
  return mapSession(await loadSessionRow(ctx, sessionId));
}

export async function listRealtimeSessions(
  ctx: TenantContext,
  query: ListRealtimeSessionsQuery,
): Promise<RealtimeSession[]> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedListSessionsQuery = validateListSessionsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.connectionId !== null) {
    params.push(valid.connectionId);
    conditions.push(`connection_id = $${params.length}`);
  }
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<SessionRow>(
    `SELECT * FROM realtime_sessions WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapSession);
}

// ---------------------------------------------------------------------------
// Participants — reads + consent (the domain path)
// ---------------------------------------------------------------------------

export async function listRealtimeParticipants(
  ctx: TenantContext,
  query: ListRealtimeParticipantsQuery,
): Promise<RealtimeParticipant[]> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedListParticipantsQuery = validateListParticipantsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.sessionId !== null) {
    params.push(valid.sessionId);
    conditions.push(`session_id = $${params.length}`);
  }
  if (valid.role !== null) {
    params.push(valid.role);
    conditions.push(`role = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<ParticipantRow>(
    `SELECT * FROM realtime_participants WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapParticipant);
}

export async function recordRealtimeConsent(
  ctx: TenantContext,
  input: RecordRealtimeConsentInput,
): Promise<RealtimeParticipant> {
  assertRealtimeTenantContext(ctx);
  const valid = validateRecordConsentInput(input);
  const session = await loadSessionRow(ctx, valid.sessionId);
  if (session.status === 'ended' || session.status === 'failed') {
    throw new RealtimeError(
      'session_terminal',
      `session '${session.id}' is ${session.status} — consent applies to active sessions only`,
    );
  }
  const participant = await loadParticipantRow(ctx, session.id, valid.participantId);
  if (participant.role === 'aurum') {
    throw new RealtimeError(
      'invalid_realtime_input',
      'the aurum agent participant does not consent to recording (the consent gate ignores it)',
    );
  }
  const at = now();
  const db = getDb();
  const updated = await db.transaction(async (tx) => {
    const row = (
      await tx.query<ParticipantRow>(
        `UPDATE realtime_participants SET consent = $4, updated_at = $5
           WHERE tenant_id = $1 AND session_id = $2 AND id = $3
           RETURNING *`,
        [ctx.tenantId, session.id, participant.id, valid.consent, at],
      )
    ).rows[0]!;
    await recordDomainEvent(
      tx,
      ctx,
      session.id,
      valid.consent === 'granted' ? 'consent.granted' : 'consent.revoked',
      { via: 'domain', by: ctx.principalId },
      participant.id,
      at,
    );
    return row;
  });

  // The consent floor: a revocation while recording STOPS the recording
  // (the all-party gate must hold continuously). The consent is already
  // durable; a stop failure surfaces to the caller (retryable — the
  // revoked state stands).
  if (valid.consent === 'revoked' && session.recording_state === 'recording') {
    const reloaded = await loadSessionRow(ctx, session.id);
    if (reloaded.recording_state === 'recording') {
      await stopRecordingInternal(ctx, reloaded);
    }
  }
  return mapParticipant(updated);
}

// ---------------------------------------------------------------------------
// Recording control (the consent gate)
// ---------------------------------------------------------------------------

export async function startRealtimeRecording(
  ctx: TenantContext,
  input: { sessionId: string },
): Promise<RealtimeSession> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedSessionRefInput = validateSessionRefInput(input, 'recording start input');
  const session = await loadSessionRow(ctx, valid.sessionId);
  assertLive(session);
  if (session.recording_state !== 'off') {
    throw new RealtimeError(
      'invalid_realtime_input',
      `session '${session.id}' recording state is '${session.recording_state}' — only an 'off' session can start recording`,
    );
  }
  const db = getDb();
  const at = now();

  // The consent floor: every currently-joined non-Aurum participant must
  // have explicitly granted. A refused start is EXPLICIT — a
  // `recording.blocked` ledger event names who has not consented.
  const unconsented = (
    await db.query<{ id: string; provider_participant_id: string }>(
      `SELECT id, provider_participant_id FROM realtime_participants
         WHERE tenant_id = $1 AND session_id = $2
           AND role <> 'aurum' AND left_at IS NULL AND consent <> 'granted'`,
      [ctx.tenantId, session.id],
    )
  ).rows;
  if (unconsented.length > 0) {
    await recordDomainEvent(db, ctx, session.id, 'recording.blocked', {
      reason: 'consent_required',
      unconsented: unconsented.map((row) => row.provider_participant_id),
    }, null, at);
    throw new RealtimeError(
      'consent_required',
      `recording requires every joined participant's explicit consent — ${unconsented.length} participant(s) have not granted it`,
    );
  }

  // Durable intent first, then the transport; a transport failure
  // reverts the intent (the ledger rows keep the truth).
  await db.query(
    `UPDATE realtime_sessions SET recording_state = 'recording', updated_at = $3
       WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, session.id, at],
  );
  try {
    const connection = await loadActiveConnection(ctx, session.connection_id);
    assertAuthorizationCurrent(connection, at);
    const transport = transportFor(connection.provider);
    await transport.startRecording({
      provider: connection.provider,
      tenantId: ctx.tenantId,
      connectionId: connection.id,
      providerAccountId: connection.providerAccountId,
      credentialRef: connection.credentialRef,
      sessionId: session.id,
      providerRoomId: session.provider_room_id!,
    });
  } catch (error) {
    await db.query(
      `UPDATE realtime_sessions SET recording_state = 'off', updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, session.id, now()],
    );
    throw error instanceof RealtimeError
      ? error
      : new RealtimeError('transport_failed', describeError(error));
  }
  await recordDomainEvent(db, ctx, session.id, 'recording.started', {}, null, now());
  return mapSession(await loadSessionRow(ctx, session.id));
}

export async function stopRealtimeRecording(
  ctx: TenantContext,
  input: { sessionId: string },
): Promise<RealtimeRecordingStopResult> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedSessionRefInput = validateSessionRefInput(input, 'recording stop input');
  const session = await loadSessionRow(ctx, valid.sessionId);
  if (session.recording_state !== 'recording') {
    throw new RealtimeError(
      'recording_not_running',
      `session '${session.id}' recording state is '${session.recording_state}' — no recording is running`,
    );
  }
  const artifact = await stopRecordingInternal(ctx, session);
  return { session: mapSession(await loadSessionRow(ctx, session.id)), artifact };
}

/**
 * Stops a running recording: transport stop, provider artifact capture
 * (guarded insert) and the domain `recording.stopped` ledger event. Used
 * by the public stop, the consent-revocation floor and the session-stop
 * path. On a transport failure the state stays the TRUTHFUL 'recording'
 * (the provider may still be recording) and the error propagates.
 */
async function stopRecordingInternal(
  ctx: TenantContext,
  session: SessionRow,
): Promise<RealtimeArtifact | null> {
  const connection = await loadConnection(ctx, session.connection_id);
  const transport = transportFor(connection.provider);
  const stopped = await transport.stopRecording({
    provider: connection.provider,
    tenantId: ctx.tenantId,
    connectionId: connection.id,
    providerAccountId: connection.providerAccountId,
    credentialRef: connection.credentialRef,
    sessionId: session.id,
    providerRoomId: session.provider_room_id!,
  });
  let artifact: RealtimeArtifact | null = null;
  if (stopped.artifact !== null) {
    artifact = await insertRecordingArtifact(ctx, session.id, stopped.artifact);
  }
  const at = now();
  await getDb().transaction(async (tx) => {
    await tx.query(
      `UPDATE realtime_sessions SET recording_state = 'recorded', updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, session.id, at],
    );
    await recordDomainEvent(
      tx,
      ctx,
      session.id,
      'recording.stopped',
      artifact === null ? {} : { artifactId: artifact.id },
      null,
      at,
    );
  });
  return artifact;
}

async function insertRecordingArtifact(
  ctx: TenantContext,
  sessionId: string,
  info: RealtimeRecordingArtifactInfo,
): Promise<RealtimeArtifact | null> {
  const inserted = await getDb().query<ArtifactRow>(
    `INSERT INTO realtime_artifacts (
         tenant_id, session_id, kind, provider_artifact_id, display_name,
         media_type, byte_size, storage_ref, checksum
       ) VALUES ($1, $2, 'recording', $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
    [
      ctx.tenantId,
      sessionId,
      info.providerArtifactId,
      'Session recording',
      info.mediaType,
      info.byteSize,
      info.storageRef ?? `provider://recording/${info.providerArtifactId}`,
      info.checksum,
    ],
  );
  const row = inserted.rows[0];
  return row === undefined ? null : mapArtifact(row);
}

// ---------------------------------------------------------------------------
// Telephony — SIP dial-out into a live session
// ---------------------------------------------------------------------------

export async function dialRealtimeParticipant(
  ctx: TenantContext,
  input: DialRealtimeParticipantInput,
): Promise<RealtimeParticipant> {
  assertRealtimeTenantContext(ctx);
  const valid = validateDialInput(input);
  const session = await loadSessionRow(ctx, valid.sessionId);
  assertLive(session);
  const connection = await loadActiveConnection(ctx, session.connection_id);
  assertAuthorizationCurrent(connection, now());
  const transport = transportFor(connection.provider);
  let dialed: { providerParticipantId: string };
  try {
    dialed = await transport.dial({
      provider: connection.provider,
      tenantId: ctx.tenantId,
      connectionId: connection.id,
      providerAccountId: connection.providerAccountId,
      credentialRef: connection.credentialRef,
      sessionId: session.id,
      providerRoomId: session.provider_room_id!,
      phoneNumber: valid.phoneNumber,
      displayName: valid.displayName,
    });
  } catch (error) {
    throw error instanceof RealtimeError
      ? error
      : new RealtimeError('transport_failed', describeError(error));
  }
  const row = await captureParticipant(ctx, session.id, {
    providerParticipantId: dialed.providerParticipantId,
    displayName: valid.displayName,
    email: null,
    phone: valid.phoneNumber,
    role: 'phone',
  });
  return mapParticipant(row);
}

// ---------------------------------------------------------------------------
// Join grants (ephemeral credentials — never persisted)
// ---------------------------------------------------------------------------

export async function createRealtimeJoinGrant(
  ctx: TenantContext,
  input: { sessionId: string; displayName?: string | null },
): Promise<RealtimeJoinGrant> {
  assertRealtimeTenantContext(ctx);
  if (typeof input !== 'object' || input === null || !isUuid(input.sessionId)) {
    throw new RealtimeError('invalid_realtime_input', 'sessionId must be a uuid');
  }
  const session = await loadSessionRow(ctx, input.sessionId);
  assertLive(session);
  const connection = await loadActiveConnection(ctx, session.connection_id);
  assertAuthorizationCurrent(connection, now());
  const transport = transportFor(connection.provider);
  const displayName =
    input.displayName === undefined || input.displayName === null
      ? null
      : input.displayName.trim() === ''
        ? null
        : input.displayName.trim().slice(0, 200);
  try {
    return await transport.createJoinGrant({
      provider: connection.provider,
      tenantId: ctx.tenantId,
      connectionId: connection.id,
      providerAccountId: connection.providerAccountId,
      credentialRef: connection.credentialRef,
      sessionId: session.id,
      providerRoomId: session.provider_room_id!,
      displayName,
    });
  } catch (error) {
    throw error instanceof RealtimeError
      ? error
      : new RealtimeError('transport_failed', describeError(error));
  }
}

// ---------------------------------------------------------------------------
// Live transcript + spoken responses — reads
// ---------------------------------------------------------------------------

export async function listRealtimeTurns(
  ctx: TenantContext,
  query: ListRealtimeTurnsQuery,
): Promise<RealtimeTurn[]> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedListTurnsQuery = validateListTurnsQuery(query);
  await loadSessionRow(ctx, valid.sessionId); // uniform not-found (ADR-0001)
  const conditions: string[] = ['tenant_id = $1', 'session_id = $2'];
  const params: unknown[] = [ctx.tenantId, valid.sessionId];
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<TurnRow>(
    `SELECT * FROM realtime_turns WHERE ${conditions.join(' AND ')}
       ORDER BY turn_no ASC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapTurn);
}

export async function listRealtimeResponses(
  ctx: TenantContext,
  query: ListRealtimeResponsesQuery,
): Promise<RealtimeResponse[]> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedListResponsesQuery = validateListResponsesQuery(query);
  await loadSessionRow(ctx, valid.sessionId); // uniform not-found (ADR-0001)
  const conditions: string[] = ['tenant_id = $1', 'session_id = $2'];
  const params: unknown[] = [ctx.tenantId, valid.sessionId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<ResponseRow>(
    `SELECT * FROM realtime_responses WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapResponse);
}

export async function listRealtimeArtifacts(
  ctx: TenantContext,
  query: ListRealtimeArtifactsQuery,
): Promise<RealtimeArtifact[]> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedListArtifactsQuery = validateListArtifactsQuery(query);
  await loadSessionRow(ctx, valid.sessionId); // uniform not-found (ADR-0001)
  const conditions: string[] = ['tenant_id = $1', 'session_id = $2'];
  const params: unknown[] = [ctx.tenantId, valid.sessionId];
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<ArtifactRow>(
    `SELECT * FROM realtime_artifacts WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapArtifact);
}

export async function listRealtimeEvents(
  ctx: TenantContext,
  query: ListRealtimeEventsQuery,
): Promise<RealtimeEventRecord[]> {
  assertRealtimeTenantContext(ctx);
  const valid: ValidatedListEventsQuery = validateListEventsQuery(query);
  await loadSessionRow(ctx, valid.sessionId); // uniform not-found (ADR-0001)
  const conditions: string[] = ['tenant_id = $1', 'session_id = $2'];
  const params: unknown[] = [ctx.tenantId, valid.sessionId];
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM realtime_events WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at ASC, id ASC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapEvent);
}

// ---------------------------------------------------------------------------
// Spoken Aurum responses
// ---------------------------------------------------------------------------

export async function speakRealtimeResponse(
  ctx: TenantContext,
  input: SpeakRealtimeResponseInput,
): Promise<RealtimeResponse> {
  assertRealtimeTenantContext(ctx);
  const valid = validateSpeakInput(input);
  const session = await loadSessionRow(ctx, valid.sessionId);
  assertLive(session);
  const connection = await loadConnection(ctx, session.connection_id);
  const transport = transportFor(connection.provider);
  const adapter = getRealtimeAdapter(connection.provider);
  const agentParticipantId = adapter.agentParticipantId(session.id);

  // The same per-session lock the event-application path takes: turn
  // numbering and the in-flight response guard must be serialized
  // against incoming provider events.
  const lock = getLock();
  const token = await lock.acquire(sessionLockKey(session.id), SESSION_LOCK_TTL_MS);
  if (token === null) {
    throw new RealtimeError(
      'event_apply_failed',
      `another pass holds session '${session.id}' — retry once it completes (safe: application is idempotent)`,
    );
  }
  try {
    const db = getDb();
    // One response in flight at a time: callers wait for the completed or
    // interrupted event before speaking again.
    const inFlight = (
      await db.query<{ id: string }>(
        `SELECT id FROM realtime_responses
           WHERE tenant_id = $1 AND session_id = $2 AND status = 'speaking'`,
        [ctx.tenantId, session.id],
      )
    ).rows[0];
    if (inFlight !== undefined) {
      throw new RealtimeError(
        'response_in_flight',
        `response '${inFlight.id}' is still speaking in session '${session.id}' — wait for its completed or interrupted event`,
      );
    }

    // The reply-to turn must belong to this session.
    if (valid.inReplyToTurnId !== null) {
      const turn = (
        await db.query<{ id: string }>(
          `SELECT id FROM realtime_turns WHERE tenant_id = $1 AND session_id = $2 AND id = $3`,
          [ctx.tenantId, session.id, valid.inReplyToTurnId],
        )
      ).rows[0];
      if (turn === undefined) {
        throw new RealtimeError(
          'invalid_realtime_input',
          `inReplyToTurnId '${valid.inReplyToTurnId}' does not reference a turn of session '${session.id}'`,
        );
      }
    }

    const responseId = newId();
    const at = now();

    // Transport acceptance FIRST: the transcript only records speech the
    // provider actually accepted (a refused speak leaves a `failed`
    // lifecycle row, never a transcript turn). The response id is the
    // transport's idempotency key for retries/recoveries.
    try {
      await transport.speak({
        provider: connection.provider,
        tenantId: ctx.tenantId,
        connectionId: connection.id,
        providerAccountId: connection.providerAccountId,
        credentialRef: connection.credentialRef,
        sessionId: session.id,
        providerRoomId: session.provider_room_id!,
        responseId,
        agentParticipantId,
        text: valid.text,
      });
    } catch (error) {
      await db.query(
        `INSERT INTO realtime_responses (
             tenant_id, session_id, turn_id, request_turn_id, text, status,
             error_detail, started_at, created_at, updated_at
           ) VALUES ($1, $2, NULL, $3, $4, 'failed', $5, $6, $6, $6)`,
        [
          ctx.tenantId,
          session.id,
          valid.inReplyToTurnId,
          valid.text,
          describeError(error).slice(0, 2000),
          at,
        ],
      );
      throw error instanceof RealtimeError
        ? error
        : new RealtimeError('transport_failed', describeError(error));
    }

    // Accepted: the aurum turn (speaker attribution) + lifecycle row.
    const aurum = await loadAurumParticipant(ctx, session.id);
    return db.transaction(async (tx) => {
      const turnNo = await nextTurnNo(tx, ctx.tenantId, session.id);
      const turn = (
        await tx.query<TurnRow>(
          `INSERT INTO realtime_turns (
               tenant_id, session_id, turn_no, kind, speaker_participant_id,
               speaker_name, text, confidence, response_id, event_id, started_at,
               created_at
             ) VALUES ($1, $2, $3, 'aurum_response', $4, 'Aurum', $5, NULL, $6, NULL, $7, $7)
             RETURNING *`,
          [ctx.tenantId, session.id, turnNo, aurum.id, valid.text, responseId, at],
        )
      ).rows[0]!;
      const response = (
        await tx.query<ResponseRow>(
          `INSERT INTO realtime_responses (
               tenant_id, session_id, turn_id, request_turn_id, text, status,
               started_at, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, 'speaking', $6, $6, $6)
             RETURNING *`,
          [ctx.tenantId, session.id, turn.id, valid.inReplyToTurnId, valid.text, at],
        )
      ).rows[0]!;
      return mapResponse(response);
    });
  } finally {
    await lock.release(sessionLockKey(session.id), token);
  }
}

// ---------------------------------------------------------------------------
// The provider event edge — receive, dedupe, apply
// ---------------------------------------------------------------------------

export async function receiveRealtimeEvent(
  ctx: TenantContext,
  input: ReceiveRealtimeEventInput,
): Promise<RealtimeEventResult> {
  assertRealtimeTenantContext(ctx);
  const valid = validateReceiveEventInput(input);
  const adapter = getRealtimeAdapter(valid.provider);

  // Provider-native payload → canonical events (adapter-private; the raw
  // envelope never advances past this line).
  const parsed = adapter.parseEvent(valid.payload);
  // Defense in depth: adapter output is re-validated before anything is
  // persisted or applied.
  const canonical: ValidatedEventParseResult = validateEventParseResult(parsed);

  // The envelope's account resolves onto THIS tenant's registered
  // connection — a foreign tenant's endpoint is indistinguishable from an
  // unknown account (ADR-0001, no existence leak).
  const connectionRow = await loadConnectionByAccount(
    ctx,
    valid.provider,
    adapter.normalizeAccountId(canonical.providerAccountId),
  );
  if (connectionRow.status !== 'active') {
    throw new RealtimeError(
      'connection_disabled',
      `connection '${connectionRow.id}' (${connectionRow.provider}) is disabled`,
    );
  }
  const connection = mapConnection(connectionRow);

  // Group events by the session (room) they belong to; resolve each room
  // onto its session, then apply the group's events one-by-one under the
  // session's lock (each event: ledger insert + state change in ONE
  // transaction — the ledger row IS the claim; the meetings module's
  // per-record apply discipline).
  const bySession = new Map<string, ValidatedRealtimeEvent[]>();
  for (const event of canonical.events) {
    const group = bySession.get(event.providerRoomId);
    if (group === undefined) bySession.set(event.providerRoomId, [event]);
    else group.push(event);
  }

  let applied = 0;
  let duplicates = 0;
  const effects: Array<() => Promise<void>> = [];
  for (const [roomKey, events] of bySession) {
    const session = await findSessionRowByRoom(ctx, connection.id, roomKey);
    if (session === null) {
      throw new RealtimeError(
        'session_not_found',
        `no realtime session for room '${roomKey}' exists on this connection in this tenant`,
      );
    }
    const lock = getLock();
    const token = await lock.acquire(sessionLockKey(session.id), SESSION_LOCK_TTL_MS);
    if (token === null) {
      throw new RealtimeError(
        'event_apply_failed',
        `another pass holds session '${session.id}' — retry once it completes (safe: application is idempotent)`,
      );
    }
    try {
      for (const event of events) {
        const outcome = await applyOneEvent(ctx, session.id, event);
        if (outcome === 'duplicate') {
          duplicates += 1;
        } else {
          applied += 1;
          const effect = await collectEffect(ctx, session.id, event);
          if (effect !== null) effects.push(effect);
        }
      }
    } finally {
      await lock.release(sessionLockKey(session.id), token);
    }
  }

  // Post-commit effects (durable end → finalization run; consent
  // revocation → recording stop; last-participant-left → room teardown):
  // best-effort here — the finalization pump recovers the finalize
  // window, and the provider's empty-room timeout backstops teardown.
  for (const effect of effects) await effect();

  return { connection, received: canonical.events.length, applied, duplicates };
}

/** Post-commit effects an applied event may require. */
async function collectEffect(
  ctx: TenantContext,
  sessionId: string,
  event: ValidatedRealtimeEvent,
): Promise<(() => Promise<void>) | null> {
  if (event.kind === 'session.ended' || event.kind === 'session.failed') {
    return async () => {
      await ensureFinalizeRunEffect(ctx, sessionId);
    };
  }
  if (event.kind === 'participant.left') {
    // Auto-end on last non-Aurum participant leaving: Aurum alone in a
    // room is a session over.
    return async () => {
      const session = await loadSessionRow(ctx, sessionId);
      if (session.status !== 'live') return;
      const remaining = (
        await getDb().query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM realtime_participants
             WHERE tenant_id = $1 AND session_id = $2
               AND role <> 'aurum' AND left_at IS NULL`,
          [ctx.tenantId, sessionId],
        )
      ).rows[0];
      const ever = (
        await getDb().query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM realtime_participants
             WHERE tenant_id = $1 AND session_id = $2 AND role <> 'aurum'`,
          [ctx.tenantId, sessionId],
        )
      ).rows[0];
      if (Number(remaining?.count ?? 0) === 0 && Number(ever?.count ?? 0) > 0) {
        const at = now();
        const ended = await getDb().transaction(async (tx) => {
          const updated = await tx.query<SessionRow>(
            `UPDATE realtime_sessions SET
                 status = 'ended', ended_reason = 'last_participant_left',
                 finalize_pending = true, ended_at = $3, updated_at = $3
               WHERE tenant_id = $1 AND id = $2 AND status = 'live'
               RETURNING *`,
            [ctx.tenantId, sessionId, at],
          );
          const row = updated.rows[0];
          if (row !== undefined) {
            await recordDomainEvent(tx, ctx, sessionId, 'session.ended', {
              reason: 'last_participant_left',
            }, null, at);
          }
          return row ?? null;
        });
        if (ended !== null) {
          await stopRoomBestEffort(ctx, ended);
          await ensureFinalizeRunEffect(ctx, sessionId);
        }
      }
    };
  }
  if (event.kind === 'consent.revoked') {
    // The consent floor: a revocation while recording stops it.
    return async () => {
      const session = await loadSessionRow(ctx, sessionId);
      if (session.recording_state === 'recording') {
        await stopRecordingInternal(ctx, session).catch(() => undefined);
      }
    };
  }
  return null;
}

/**
 * Pre-resolves the organizational subjects of an event's NEW participants
 * through the identity contract BEFORE the apply transaction opens —
 * sibling-contract reads never run inside this module's transactions
 * (PGlite executes them on the single connection; the workflow-resumption
 * discipline).
 */
async function preResolveEventSubjects(
  ctx: TenantContext,
  sessionId: string,
  event: ValidatedRealtimeEvent,
): Promise<Map<string, string | null>> {
  const subjects = new Map<string, string | null>();
  const candidates: Array<{ id: string | null; email: string | null }> = [];
  switch (event.kind) {
    case 'participant.joined':
      candidates.push({ id: event.providerParticipantId, email: event.email });
      break;
    case 'participant.left':
    case 'consent.granted':
    case 'consent.revoked':
      candidates.push({ id: event.providerParticipantId, email: null });
      break;
    case 'transcript.final':
      candidates.push({ id: event.providerParticipantId, email: null });
      break;
    case 'response.interrupted':
      candidates.push({ id: event.interruptingProviderParticipantId, email: null });
      break;
    default:
      break;
  }
  for (const candidate of candidates) {
    if (candidate.id === null || candidate.id === undefined) continue;
    if ((await findParticipantRow(ctx, sessionId, candidate.id)) !== null) continue;
    subjects.set(candidate.id, candidate.email !== null ? await resolveSubjectByEmail(ctx, candidate.email) : null);
  }
  return subjects;
}

/**
 * Applies ONE canonical event: the dedupe insert (ON CONFLICT DO NOTHING
 * against the partial unique index) and its state change run in one
 * transaction — a row returned means fresh (apply); no row means the
 * provider redelivered an already-applied event id (skip).
 */
async function applyOneEvent(
  ctx: TenantContext,
  sessionId: string,
  event: ValidatedRealtimeEvent,
): Promise<'applied' | 'duplicate'> {
  const db = getDb();
  const subjects = await preResolveEventSubjects(ctx, sessionId, event);
  return db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO realtime_events (
           tenant_id, session_id, source, kind, provider_event_id, participant_id,
           detail, occurred_at
         ) VALUES ($1, $2, 'provider', $3, $4, NULL, $5::jsonb, $6)
         ON CONFLICT (tenant_id, session_id, provider_event_id) WHERE provider_event_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
      [
        ctx.tenantId,
        sessionId,
        event.kind,
        event.providerEventId,
        JSON.stringify(eventDetail(event)),
        new Date(event.occurredAt),
      ],
    );
    const eventRowId = inserted.rows[0]?.id;
    if (eventRowId === undefined) return 'duplicate' as const;

    // Fresh state per event (earlier events in the batch may have moved it).
    const session = (
      await tx.query<SessionRow>(
        `SELECT * FROM realtime_sessions WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, sessionId],
      )
    ).rows[0]!;
    await applyEventState(tx, ctx, session, event, eventRowId, subjects);
    return 'applied' as const;
  });
}

/** The canonical facets an event carries into its ledger row. */
function eventDetail(event: ValidatedRealtimeEvent): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (
      key === 'kind' ||
      key === 'providerEventId' ||
      key === 'occurredAt' ||
      key === 'providerRoomId'
    ) {
      continue;
    }
    if (value !== undefined) detail[key] = value;
  }
  return detail;
}

async function applyEventState(
  tx: Queryable,
  ctx: TenantContext,
  session: SessionRow,
  event: ValidatedRealtimeEvent,
  eventRowId: string,
  subjects: Map<string, string | null>,
): Promise<void> {
  const at = new Date(event.occurredAt);
  switch (event.kind) {
    case 'session.started': {
      // Confirmation of a start the op already performed; a `requested`
      // session (op crashed mid-start) is completed by the event.
      await tx.query(
        `UPDATE realtime_sessions SET
             status = 'live', started_at = COALESCE(started_at, $3),
             provider_room_id = COALESCE(provider_room_id, $4), updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'requested'`,
        [ctx.tenantId, session.id, at, event.providerRoomId],
      );
      return;
    }
    case 'session.ended': {
      const wasLive = session.status === 'live' || session.started_at !== null;
      await tx.query(
        `UPDATE realtime_sessions SET
             status = 'ended', ended_reason = 'provider_ended',
             finalize_pending = $3, ended_at = $4, updated_at = $4
           WHERE tenant_id = $1 AND id = $2 AND status IN ('requested', 'live')`,
        [ctx.tenantId, session.id, wasLive, new Date(event.endedAt)],
      );
      return;
    }
    case 'session.failed': {
      const wasLive = session.status === 'live' || session.started_at !== null;
      await tx.query(
        `UPDATE realtime_sessions SET
             status = 'failed', error_code = $3, error_detail = $4,
             finalize_pending = $5, ended_at = $6, updated_at = $6
           WHERE tenant_id = $1 AND id = $2 AND status IN ('requested', 'live')`,
        [
          ctx.tenantId,
          session.id,
          event.code,
          event.detail ?? 'provider-reported failure',
          wasLive,
          at,
        ],
      );
      return;
    }
    case 'participant.joined': {
      const phone = facetString(event, 'phone');
      const participant = await captureParticipantTx(tx, ctx, session.id, subjects, {
        providerParticipantId: event.providerParticipantId,
        displayName: facetString(event, 'displayName'),
        email: facetString(event, 'email'),
        phone,
        role: phone !== null ? 'phone' : 'human',
      });
      await tx.query(
        `UPDATE realtime_participants SET
             joined_at = $4, left_at = NULL, updated_at = $5,
             display_name = COALESCE($6, display_name),
             email = COALESCE($7, email)
           WHERE tenant_id = $1 AND session_id = $2 AND id = $3`,
        [
          ctx.tenantId,
          session.id,
          participant.id,
          new Date(event.joinedAt),
          at,
          facetString(event, 'displayName'),
          facetString(event, 'email'),
        ],
      );
      await tx.query(
        `UPDATE realtime_events SET participant_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, eventRowId, participant.id],
      );
      return;
    }
    case 'participant.left': {
      const participant = await captureParticipantTx(tx, ctx, session.id, subjects, {
        providerParticipantId: event.providerParticipantId,
        displayName: null,
        email: null,
        phone: null,
        role: 'human',
      });
      await tx.query(
        `UPDATE realtime_participants SET left_at = $4, updated_at = $5
           WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND left_at IS NULL`,
        [ctx.tenantId, session.id, participant.id, new Date(event.leftAt), at],
      );
      await tx.query(
        `UPDATE realtime_events SET participant_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, eventRowId, participant.id],
      );
      // The last-participant-left auto-end is a POST-COMMIT effect (see
      // collectEffect) — it needs fresh committed state.
      return;
    }
    case 'consent.granted':
    case 'consent.revoked': {
      const participant = await captureParticipantTx(tx, ctx, session.id, subjects, {
        providerParticipantId: event.providerParticipantId,
        displayName: null,
        email: null,
        phone: null,
        role: 'human',
      });
      const consent = event.kind === 'consent.granted' ? 'granted' : 'revoked';
      await tx.query(
        `UPDATE realtime_participants SET consent = $4, updated_at = $5
           WHERE tenant_id = $1 AND session_id = $2 AND id = $3`,
        [ctx.tenantId, session.id, participant.id, consent, at],
      );
      await tx.query(
        `UPDATE realtime_events SET participant_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, eventRowId, participant.id],
      );
      return;
    }
    case 'transcript.final': {
      const speakerId = event.providerParticipantId;
      let speakerParticipantId: string | null = null;
      if (typeof speakerId === 'string' && speakerId !== '') {
        const participant = await captureParticipantTx(tx, ctx, session.id, subjects, {
          providerParticipantId: speakerId,
          displayName: facetString(event, 'speakerName'),
          email: null,
          phone: null,
          role: 'human',
        });
        speakerParticipantId = participant.id;
        await tx.query(
          `UPDATE realtime_events SET participant_id = $3 WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, eventRowId, participant.id],
        );
      }
      const turnNo = await nextTurnNo(tx, ctx.tenantId, session.id);
      const endedAt = facetString(event, 'endedAt');
      await tx.query(
        `INSERT INTO realtime_turns (
             tenant_id, session_id, turn_no, kind, speaker_participant_id,
             speaker_name, text, confidence, response_id, event_id, started_at,
             ended_at, created_at
           ) VALUES ($1, $2, $3, 'human_speech', $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
        [
          ctx.tenantId,
          session.id,
          turnNo,
          speakerParticipantId,
          facetString(event, 'speakerName'),
          event.text,
          facetNumber(event, 'confidence'),
          eventRowId,
          new Date(event.startedAt),
          endedAt === null ? null : new Date(endedAt),
          at,
        ],
      );
      return;
    }
    case 'response.completed': {
      await assertResponseKnown(tx, ctx, session.id, event.responseId);
      await tx.query(
        `UPDATE realtime_responses SET
             status = 'completed', completed_at = $4, updated_at = $4
           WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND status = 'speaking'`,
        [ctx.tenantId, session.id, event.responseId, new Date(event.completedAt)],
      );
      return;
    }
    case 'response.interrupted': {
      await assertResponseKnown(tx, ctx, session.id, event.responseId);
      let interrupterId: string | null = null;
      const interrupter = event.interruptingProviderParticipantId;
      if (typeof interrupter === 'string' && interrupter !== '') {
        const participant = await captureParticipantTx(tx, ctx, session.id, subjects, {
          providerParticipantId: interrupter,
          displayName: null,
          email: null,
          phone: null,
          role: 'human',
        });
        interrupterId = participant.id;
      }
      await tx.query(
        `UPDATE realtime_responses SET
             status = 'interrupted', interrupted_at = $4,
             interrupted_by_participant_id = $5, updated_at = $4
           WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND status = 'speaking'`,
        [
          ctx.tenantId,
          session.id,
          event.responseId,
          new Date(event.interruptedAt),
          interrupterId,
        ],
      );
      return;
    }
    case 'recording.started': {
      // Pure confirmation: the domain op set 'recording' before calling
      // the transport. An event while 'off' is a provider anomaly — the
      // ledger row records it; the consent-gated state does NOT move.
      return;
    }
    case 'recording.stopped': {
      // State sync down (provider stopped it) + artifact capture.
      await tx.query(
        `UPDATE realtime_sessions SET recording_state = 'recorded', updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND recording_state = 'recording'`,
        [ctx.tenantId, session.id, at],
      );
      const artifact = event.artifact;
      if (artifact !== null && artifact !== undefined) {
        await tx.query(
          `INSERT INTO realtime_artifacts (
               tenant_id, session_id, kind, provider_artifact_id, display_name,
               media_type, byte_size, storage_ref, checksum
             ) VALUES ($1, $2, 'recording', $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING`,
          [
            ctx.tenantId,
            session.id,
            artifact.providerArtifactId,
            'Session recording',
            artifact.mediaType,
            artifact.byteSize,
            artifact.storageRef ?? `provider://recording/${artifact.providerArtifactId}`,
            artifact.checksum,
          ],
        );
      }
      return;
    }
  }
}

function facetString(event: Record<string, unknown>, key: string): string | null {
  const value = event[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function facetNumber(event: Record<string, unknown>, key: string): number | null {
  const value = event[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function assertResponseKnown(
  tx: Queryable,
  ctx: TenantContext,
  sessionId: string,
  responseId: string,
): Promise<void> {
  const row = (
    await tx.query<{ id: string }>(
      `SELECT id FROM realtime_responses WHERE tenant_id = $1 AND session_id = $2 AND id = $3`,
      [ctx.tenantId, sessionId, responseId],
    )
  ).rows[0];
  if (row === undefined) {
    throw new RealtimeError(
      'response_not_found',
      `response '${responseId}' does not exist in session '${sessionId}' — the provider echoed an unknown response id`,
    );
  }
}

/**
 * Transactional variant of the get-or-create participant registry. The
 * verified-email resolution happened BEFORE the transaction opened (the
 * identity contract is never called inside this module's transactions —
 * PGlite runs sibling reads on the same single connection); a rare
 * get-or-create race leaves the subject unresolved — W095's unification
 * pass covers it.
 */
async function captureParticipantTx(
  tx: Queryable,
  ctx: TenantContext,
  sessionId: string,
  subjects: Map<string, string | null>,
  facets: ParticipantFacets,
): Promise<ParticipantRow> {
  const existing = (
    await tx.query<ParticipantRow>(
      `SELECT * FROM realtime_participants
         WHERE tenant_id = $1 AND session_id = $2 AND provider_participant_id = $3`,
      [ctx.tenantId, sessionId, facets.providerParticipantId],
    )
  ).rows[0];
  if (existing !== undefined) return existing;
  const subjectId = subjects.get(facets.providerParticipantId) ?? null;
  const inserted = await tx.query<ParticipantRow>(
    `INSERT INTO realtime_participants (
         tenant_id, session_id, provider_participant_id, role, display_name,
         email, phone, subject_id, resolved_via
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, session_id, provider_participant_id) DO NOTHING
       RETURNING *`,
    [
      ctx.tenantId,
      sessionId,
      facets.providerParticipantId,
      facets.role,
      facets.displayName,
      facets.email,
      facets.phone,
      subjectId,
      subjectId === null ? null : 'verified_email_identity',
    ],
  );
  const row = inserted.rows[0];
  if (row !== undefined) return row;
  const raced = (
    await tx.query<ParticipantRow>(
      `SELECT * FROM realtime_participants
         WHERE tenant_id = $1 AND session_id = $2 AND provider_participant_id = $3`,
      [ctx.tenantId, sessionId, facets.providerParticipantId],
    )
  ).rows[0];
  return raced!;
}

// ---------------------------------------------------------------------------
// Durable finalization (the W080 workflow port)
// ---------------------------------------------------------------------------

/**
 * Ensures the finalization workflow definition exists (idempotent —
 * re-registering identical content is a no-op) and starts (or idempotently
 * replays) the finalization run for one session. Never called inside a
 * transaction: the workflow contract manages its own.
 */
async function ensureFinalizeRun(ctx: TenantContext, session: SessionRow): Promise<string | null> {
  if (!session.finalize_pending || session.finalize_run_id !== null) {
    return session.finalize_run_id;
  }
  try {
    await registerWorkflow(ctx, {
      key: REALTIME_FINALIZE_DEFINITION_KEY,
      title: REALTIME_FINALIZE_TITLE,
      description:
        'Materializes the durable meeting artifact of a realtime session (transcript document via the object-storage port) and records the session-close observation (W004 evidence).',
      spec: {
        steps: [
          {
            key: 'materialize-artifacts',
            maxAttempts: 5,
            retryBackoffSeconds: 10,
            leaseSeconds: 300,
          },
          {
            key: 'record-session-observation',
            maxAttempts: 5,
            retryBackoffSeconds: 10,
            leaseSeconds: 300,
          },
        ],
      },
    });
    const run = await startRun(ctx, {
      definitionKey: REALTIME_FINALIZE_DEFINITION_KEY,
      input: { sessionId: session.id, recordedBy: ctx.principalId },
      idempotencyKey: finalizeIdempotencyKey(session.id),
      triggerReference: session.id,
    });
    // Guarded fill: a concurrent ensurer replays the same run.
    await getDb().query(
      `UPDATE realtime_sessions SET finalize_run_id = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND finalize_run_id IS NULL`,
      [ctx.tenantId, session.id, run.id, now()],
    );
    return run.id;
  } catch (error) {
    if (error instanceof WorkflowError) {
      // The durable end stands; the recovery pump retries the run.
      return null;
    }
    throw error;
  }
}

async function ensureFinalizeRunEffect(ctx: TenantContext, sessionId: string): Promise<void> {
  const session = await loadSessionRow(ctx, sessionId);
  await ensureFinalizeRun(ctx, session);
}

/**
 * The finalization recovery pump (the worker seam — the W080
 * `evaluateSchedules` discipline): advances EXACTLY ONE pending
 * finalization per call. Recovers the crash window between a terminal
 * session transition and its workflow run (idempotent — first write
 * wins).
 */
export async function pumpRealtimeFinalization(
  ctx: TenantContext,
): Promise<RealtimeFinalizationPumpOutcome> {
  assertRealtimeTenantContext(ctx);
  const pending = (
    await getDb().query<SessionRow>(
      `SELECT * FROM realtime_sessions
         WHERE tenant_id = $1 AND finalize_pending AND finalize_run_id IS NULL
         ORDER BY ended_at ASC, id ASC LIMIT 1`,
      [ctx.tenantId],
    )
  ).rows[0];
  if (pending === undefined) {
    return {
      status: 'idle',
      sessionId: null,
      runId: null,
      detail: 'no pending realtime finalizations for this tenant',
    };
  }
  const runId = await ensureFinalizeRun(ctx, pending);
  if (runId === null) {
    return {
      status: 'failed',
      sessionId: pending.id,
      runId: null,
      detail: `starting the finalization run for session '${pending.id}' failed — the pump retries`,
    };
  }
  return {
    status: 'ensured',
    sessionId: pending.id,
    runId,
    detail: `finalization run '${runId}' ensured for session '${pending.id}'`,
  };
}

// ---------------------------------------------------------------------------
// The finalization executors (code bindings — never durable state)
// ---------------------------------------------------------------------------

interface FinalizeRunInput {
  sessionId: string;
  recordedBy: string;
}

function readFinalizeInput(invocation: WorkflowStepInvocation): FinalizeRunInput {
  const input = invocation.input;
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as FinalizeRunInput).sessionId !== 'string' ||
    typeof (input as FinalizeRunInput).recordedBy !== 'string'
  ) {
    throw new RealtimeError(
      'finalize_failed',
      'the finalization run input is malformed (expected { sessionId, recordedBy })',
    );
  }
  return input as FinalizeRunInput;
}

/**
 * Step 1 — materialize the durable transcript artifact: a JSON document
 * of the session's canonical state, persisted through the object-storage
 * port under a DETERMINISTIC key with a guarded UNIQUE artifact row —
 * a retried, recovered or duplicated execution can neither fork the
 * artifact nor duplicate the row.
 */
async function materializeArtifactsStep(
  invocation: WorkflowStepInvocation,
): Promise<WorkflowStepResult> {
  const { sessionId } = readFinalizeInput(invocation);
  const tenantId = invocation.tenantId;
  const db = getDb();

  const session = (
    await db.query<SessionRow>(`SELECT * FROM realtime_sessions WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      sessionId,
    ])
  ).rows[0];
  if (session === undefined) {
    throw new RealtimeError(
      'finalize_failed',
      `session '${sessionId}' does not exist in tenant '${tenantId}'`,
    );
  }

  const existing = (
    await db.query<ArtifactRow>(
      `SELECT * FROM realtime_artifacts
         WHERE tenant_id = $1 AND session_id = $2 AND domain_key = 'transcript'`,
      [tenantId, sessionId],
    )
  ).rows[0];
  if (existing !== undefined) {
    return { type: 'done', output: { transcriptArtifactId: existing.id } };
  }

  const participants = (
    await db.query<ParticipantRow>(
      `SELECT * FROM realtime_participants
         WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at ASC, id ASC`,
      [tenantId, sessionId],
    )
  ).rows;
  const turns = (
    await db.query<TurnRow>(
      `SELECT * FROM realtime_turns
         WHERE tenant_id = $1 AND session_id = $2 ORDER BY turn_no ASC`,
      [tenantId, sessionId],
    )
  ).rows;

  const document = {
    schema: 'aurum.realtime.transcript/1',
    sessionId: session.id,
    kind: session.kind,
    title: session.title,
    meetingSessionId: session.meeting_session_id,
    startedAt: toIsoOrNull(session.started_at),
    endedAt: toIsoOrNull(session.ended_at),
    endedReason: session.ended_reason,
    recordingState: session.recording_state,
    errorCode: session.error_code,
    errorDetail: session.error_detail,
    participants: participants.map((row) => ({
      participantId: row.id,
      role: row.role,
      providerParticipantId: row.provider_participant_id,
      displayName: row.display_name,
      email: row.email,
      phone: row.phone,
      subjectId: row.subject_id,
      consent: row.consent,
      joinedAt: toIsoOrNull(row.joined_at),
      leftAt: toIsoOrNull(row.left_at),
    })),
    turns: turns.map((row) => ({
      turnNo: Number(row.turn_no),
      kind: row.kind,
      speakerParticipantId: row.speaker_participant_id,
      speakerName: row.speaker_name,
      text: row.text,
      confidence: row.confidence,
      responseId: row.response_id,
      startedAt: toIso(row.started_at),
      endedAt: toIsoOrNull(row.ended_at),
    })),
  };

  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const key = `realtime/${tenantId}/${sessionId}/transcript.json`;
  const maxBytes = resolveDeploymentProfile().guardrails.blobMaxBytes;
  const stored = await putBlobObject(
    { key, data: bytes, contentType: 'application/json' },
    maxBytes,
  );
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

  const inserted = await db.query<ArtifactRow>(
    `INSERT INTO realtime_artifacts (
         tenant_id, session_id, kind, domain_key, provider_artifact_id,
         display_name, media_type, byte_size, storage_ref, checksum
       ) VALUES ($1, $2, 'transcript', 'transcript', NULL, $3, 'application/json', $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING *`,
    [tenantId, sessionId, 'Session transcript', bytes.byteLength, stored.url, checksum],
  );
  return {
    type: 'done',
    output: { transcriptArtifactId: inserted.rows[0]?.id ?? null, storageRef: stored.url },
  };
}

/**
 * Step 2 — record the session-close observation through the observations
 * contract (W004: the realtime session enters the SAME evidence model as
 * every other observation; lineage `direct` — Aurum participated
 * first-hand), link it one-way onto the session, and clear the pending
 * flag. Idempotent under retries: the guarded one-way fill is the
 * authority (a crash between the observation and the fill can duplicate
 * the observation at worst — the same window the meetings ledger
 * documents).
 */
async function recordSessionObservationStep(
  invocation: WorkflowStepInvocation,
): Promise<WorkflowStepResult> {
  const { sessionId, recordedBy } = readFinalizeInput(invocation);
  const tenantId = invocation.tenantId;
  const ctx: TenantContext = { tenantId, principalId: recordedBy, authority: [] };
  const db = getDb();

  const session = (
    await db.query<SessionRow>(`SELECT * FROM realtime_sessions WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      sessionId,
    ])
  ).rows[0];
  if (session === undefined) {
    throw new RealtimeError(
      'finalize_failed',
      `session '${sessionId}' does not exist in tenant '${tenantId}'`,
    );
  }
  if (session.evidence_observation_id !== null) {
    // Already recorded (idempotent fast path).
    await db.query(
      `UPDATE realtime_sessions SET finalize_pending = false, updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [tenantId, sessionId, now()],
    );
    return {
      type: 'done',
      output: { evidenceObservationId: session.evidence_observation_id },
    };
  }

  const artifacts = (
    await db.query<ArtifactRow>(
      `SELECT * FROM realtime_artifacts
         WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at ASC`,
      [tenantId, sessionId],
    )
  ).rows;
  const turnCount = (
    await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM realtime_turns WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
  ).rows[0];
  const participantCount = (
    await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM realtime_participants
         WHERE tenant_id = $1 AND session_id = $2 AND role <> 'aurum'`,
      [tenantId, sessionId],
    )
  ).rows[0];

  const payload = {
    sessionId: session.id,
    kind: session.kind,
    title: session.title,
    meetingSessionId: session.meeting_session_id,
    startedAt: toIsoOrNull(session.started_at),
    endedAt: toIsoOrNull(session.ended_at),
    endedReason: session.ended_reason,
    recordingState: session.recording_state,
    errorCode: session.error_code,
    errorDetail: session.error_detail,
    participantCount: Number(participantCount?.count ?? 0),
    turnCount: Number(turnCount?.count ?? 0),
    artifacts: artifacts.map((row) => ({
      id: row.id,
      kind: row.kind,
      storageRef: row.storage_ref,
      checksum: row.checksum,
      byteSize: row.byte_size,
    })),
  };

  let observationId: string;
  try {
    const observation = await recordObservation(ctx, {
      kind: 'realtime.session',
      payload,
      observedAt: toIso(session.ended_at ?? session.updated_at),
      source: { kind: 'system', id: session.connection_id, label: 'realtime' },
      channel: session.provider,
      lineage: { method: 'direct', parents: [], extractor: null },
      permissions: { visibility: 'tenant', workspaceId: null, principalId: null, usage: [] },
      confidence: {
        value: 1,
        method: 'realtime_gateway',
        basis: 'first-hand realtime session participation (W086 realtime)',
      },
    });
    observationId = observation.id;
  } catch (error) {
    if (error instanceof ObservationsError) {
      // A sibling rejection here contradicts a pre-validated payload —
      // stay loud rather than wrong (the meetings module's discipline).
      throw new Error(
        `the observations contract rejected the realtime session-close observation (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }

  await db.query(
    `UPDATE realtime_sessions SET
         evidence_observation_id = $3, finalize_pending = false, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
    [tenantId, sessionId, observationId, now()],
  );
  return { type: 'done', output: { evidenceObservationId: observationId } };
}

/**
 * The executor bindings a host composes into its workflow engine
 * (`createWorkflowEngine(createRealtimeWorkflowBindings())`). Bindings
 * are CODE, never durable state: losing them loses no run progress — a
 * host with the bindings restarts and pumps onward.
 */
export function createRealtimeWorkflowBindings(): WorkflowExecutorBindings {
  return {
    [REALTIME_FINALIZE_DEFINITION_KEY]: {
      'materialize-artifacts': materializeArtifactsStep,
      'record-session-observation': recordSessionObservationStep,
    },
  };
}
