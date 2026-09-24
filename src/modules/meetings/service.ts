// Implementation of the meetings module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`connection_not_found` / `meeting_not_found` /
// `session_not_found`), no existence leak.
//
// W085 acceptance — "meeting metadata, participant identity,
// transcript/artifact and provenance are captured into the canonical
// evidence model; provider-specific schemas remain inside adapters;
// failed/expired meeting access is explicit" — is carried by these
// deliberate properties, all tested:
//   1. PROVIDER INDEPENDENCE (lock 16 / MODULE-DEPENDENCY-MAP provider
//      boundaries): provider-native webhook envelopes exist ONLY inside
//      `adapters/`; every operation receives canonical inputs and persists
//      canonical outputs; adapter AND transport output is re-validated
//      before anything reaches the registry or the observations contract
//      (a buggy adapter cannot smuggle provider shapes past the boundary).
//      The only provider-minted values on this surface are OPAQUE strings
//      (account ids, meeting/session/transcript/artifact ids, participant
//      ids, cursors);
//   2. EVIDENCE CAPTURE: every canonical record becomes an immutable
//      OBSERVATION through the observations contract (W004, lineage
//      `connector`, provider key as channel, provenance carrying the
//      capture connection id) and updates the canonical registry (meeting
//      metadata, session state, participant identities, transcripts,
//      artifacts) — the capture registry is current state, the
//      observations are the evidence trail. "There is no separate meeting
//      knowledge store" (FINAL-TECH-LEAD-HANDOFF §4.4): understanding
//      meeting content is the cognition loop's job over that evidence;
//   3. PARTICIPANT IDENTITY: provider-minted participant accounts are
//      captured on sight into the canonical registry (get-or-create — the
//      ADR-0003 discipline), and resolved onto organizational persons
//      through the identity module's VERIFIED email identities when one
//      exists (read-only W002 bridge; full unification is W095's job);
//   4. EXPLICIT ACCESS FAILURES: a lapsed recorded OAuth grant fails
//      ingestion fast (`meeting_authorization_expired`) AND is recorded
//      as an append-only access event; provider-delivered access failures
//      become access events AND observations (kind `meeting.access`) —
//      a gap in meeting intelligence is never silent;
//   5. IDEMPOTENT CAPTURE: the append-only `meeting_ingestion` ledger is
//      the dedupe authority — one observation per (tenant, connection,
//      provider record id), ever. Webhook redeliveries, poll re-fetches
//      and a partial crash recovery are all suppressed against it;
//   6. CREDENTIAL ISOLATION: credential VALUES never cross this contract
//      — the fetch transport receives the OPAQUE `credentialRef` and
//      resolves secrets itself; the domain tracks only non-secret
//      authorization state. A transport that REFRESHED a grant reports the
//      new expiry and the recorded authorization state moves with it.
//
// Polling cursor discipline: ingest FIRST, cursor SECOND — a crash
// between the two re-fetches the same window on the next poll and dedupe
// suppresses re-observation. The sources module's checkpoint
// history/replay machinery is deliberately NOT replicated here: W085's
// acceptance names no replay, so only the live cursor is persisted.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { getLock } from '@/infra/lock';
import type { TenantContext } from '@/infra/tenant';
import {
  findExternalIdentityByProviderKey,
  IdentityError,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import { ObservationsError, recordObservation } from '@/modules/observations/contract';
import { getMeetingAdapter } from './adapters';
import { MeetingsError } from './errors';
import {
  assertMeetingsTenantContext,
  cursorAdvance,
  isUuid,
  validateFetchResult,
  validateListAccessEventsQuery,
  validateListArtifactsQuery,
  validateListConnectionsQuery,
  validateListMeetingsQuery,
  validateListParticipantsQuery,
  validateListSessionsQuery,
  validateListTranscriptsQuery,
  validatePollInput,
  validateReceiveWebhookInput,
  validateRegisterConnectionInput,
  validateSetConnectionStatusInput,
  validateWebhookParseResult,
  type ValidatedListAccessEventsQuery,
  type ValidatedListArtifactsQuery,
  type ValidatedListConnectionsQuery,
  type ValidatedListMeetingsQuery,
  type ValidatedListParticipantsQuery,
  type ValidatedListSessionsQuery,
  type ValidatedListTranscriptsQuery,
  type ValidatedMeetingRecord,
  type ValidatedParticipant,
  type ValidatedPollInput,
  type ValidatedWebhookParseResult,
} from './validation';
import type {
  IngestedRecord,
  ListMeetingAccessEventsQuery,
  ListMeetingArtifactsQuery,
  ListMeetingConnectionsQuery,
  ListMeetingParticipantsQuery,
  ListMeetingsQuery,
  ListMeetingSessionsQuery,
  ListMeetingTranscriptsQuery,
  Meeting,
  MeetingAccessEvent,
  MeetingArtifact,
  MeetingConnection,
  MeetingFetchResult,
  MeetingParticipant,
  MeetingProvider,
  MeetingSession,
  MeetingTranscript,
  MeetingTransport,
  PollMeetingConnectionInput,
  PollResult,
  ReceiveMeetingWebhookInput,
  RegisterMeetingConnectionInput,
  RegisterMeetingConnectionResult,
  SessionParticipant,
  SetMeetingConnectionStatusInput,
  WebhookResult,
} from './types';

// How long one capture pass may hold a connection's ingestion lock.
const INGESTION_LOCK_TTL_MS = 60_000;

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

interface ParticipantRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_participant_id: string;
  display_name: string | null;
  email: string | null;
  subject_id: string | null;
  resolved_via: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MeetingRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  provider: string;
  provider_meeting_id: string;
  title: string | null;
  agenda: string | null;
  scheduled_start_at: Date | string | null;
  scheduled_end_at: Date | string | null;
  host_participant_id: string | null;
  underlying_platform: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionRow extends DbRow {
  id: string;
  tenant_id: string;
  meeting_id: string;
  provider_session_id: string;
  status: string;
  title: string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  participants: SessionParticipant[];
  created_at: Date | string;
  updated_at: Date | string;
}

interface TranscriptRow extends DbRow {
  id: string;
  tenant_id: string;
  session_id: string;
  provider_transcript_id: string;
  language: string | null;
  segments: unknown;
  evidence_observation_id: string;
  captured_via: string;
  captured_at: Date | string;
  created_at: Date | string;
}

interface ArtifactRow extends DbRow {
  id: string;
  tenant_id: string;
  session_id: string;
  kind: string;
  provider_artifact_id: string;
  display_name: string | null;
  media_type: string | null;
  byte_size: number | null;
  storage_ref: string | null;
  checksum: string | null;
  evidence_observation_id: string;
  captured_via: string;
  captured_at: Date | string;
  created_at: Date | string;
}

interface AccessEventRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  provider: string;
  provider_meeting_id: string | null;
  code: string;
  detail: string | null;
  occurred_at: Date | string;
  created_at: Date | string;
}

interface CursorRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  cursor: string | null;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapConnection(row: ConnectionRow): MeetingConnection {
  const adapter = getMeetingAdapter(row.provider);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as MeetingConnection['provider'], // CHECK-constrained by migration 001
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    authKind: row.auth_kind as MeetingConnection['authKind'], // CHECK-constrained by migration 001
    credentialRef: row.credential_ref,
    oauthScopes: row.oauth_scopes,
    oauthExpiresAt: row.oauth_expires_at === null ? null : toIso(row.oauth_expires_at),
    status: row.status as MeetingConnection['status'], // CHECK-constrained by migration 001
    modes: [...adapter.modes],
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapParticipant(row: ParticipantRow): MeetingParticipant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as MeetingParticipant['provider'], // CHECK-constrained
    providerParticipantId: row.provider_participant_id,
    displayName: row.display_name,
    email: row.email,
    subjectId: row.subject_id,
    resolvedVia:
      row.resolved_via === null ? null : (row.resolved_via as 'verified_email_identity'),
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSession(row: SessionRow): MeetingSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    meetingId: row.meeting_id,
    providerSessionId: row.provider_session_id,
    status: row.status as MeetingSession['status'], // CHECK-constrained by migration 003
    title: row.title,
    startedAt: row.started_at === null ? null : toIso(row.started_at),
    endedAt: row.ended_at === null ? null : toIso(row.ended_at),
    participants: row.participants,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapTranscript(row: TranscriptRow): MeetingTranscript {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    providerTranscriptId: row.provider_transcript_id,
    language: row.language,
    segments: (row.segments as MeetingTranscript['segments']) ?? [],
    evidenceObservationId: row.evidence_observation_id,
    capturedVia: row.captured_via as MeetingTranscript['capturedVia'], // CHECK-constrained
    capturedAt: toIso(row.captured_at),
  };
}

function mapArtifact(row: ArtifactRow): MeetingArtifact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    kind: row.kind as MeetingArtifact['kind'], // CHECK-constrained by migration 005
    providerArtifactId: row.provider_artifact_id,
    displayName: row.display_name,
    mediaType: row.media_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    storageRef: row.storage_ref,
    checksum: row.checksum,
    evidenceObservationId: row.evidence_observation_id,
    capturedVia: row.captured_via as MeetingArtifact['capturedVia'], // CHECK-constrained
    capturedAt: toIso(row.captured_at),
  };
}

function mapAccessEvent(row: AccessEventRow): MeetingAccessEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    provider: row.provider as MeetingAccessEvent['provider'], // CHECK-constrained
    providerMeetingId: row.provider_meeting_id,
    code: row.code as MeetingAccessEvent['code'], // CHECK-constrained by migration 006
    detail: row.detail,
    occurredAt: toIso(row.occurred_at),
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
// Transport port (provider-neutral polling; implementations live inside adapters/)
// ---------------------------------------------------------------------------

let meetingTransport: MeetingTransport | null = null;

/**
 * Infrastructure wiring for the fetch port. Real transports (provider
 * SDKs / HTTP) are implemented inside `src/modules/meetings/adapters/` and
 * wired once at process start; tests substitute a scripted transport.
 * `null` restores the default "no provider available" state.
 */
export function setMeetingTransport(transport: MeetingTransport | null): void {
  meetingTransport = transport;
}

/** The currently wired transport (null when none — polls then fail `provider_unavailable`). */
export function getMeetingTransport(): MeetingTransport | null {
  return meetingTransport;
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
    throw new MeetingsError(
      'connection_not_found',
      `connection '${connectionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM meeting_connections WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, connectionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MeetingsError(
      'connection_not_found',
      `connection '${connectionId}' does not exist in this tenant`,
    );
  }
  return row;
}

function mapLoadedConnection(row: ConnectionRow): MeetingConnection {
  return mapConnection(row);
}

async function loadConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<MeetingConnection> {
  return mapLoadedConnection(await loadConnectionRow(ctx, connectionId));
}

async function loadActiveConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<MeetingConnection> {
  const connection = await loadConnection(ctx, connectionId);
  if (connection.status !== 'active') {
    throw new MeetingsError(
      'connection_disabled',
      `connection '${connection.id}' (${connection.provider}) is disabled`,
    );
  }
  return connection;
}

async function loadConnectionByAccount(
  ctx: TenantContext,
  provider: MeetingConnection['provider'],
  providerAccountId: string,
): Promise<MeetingConnection> {
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM meeting_connections
       WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
    [ctx.tenantId, provider, providerAccountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MeetingsError(
      'connection_not_found',
      `no ${provider} meeting connection for account '${providerAccountId}' exists in this tenant`,
    );
  }
  return mapConnection(row);
}

/**
 * Authorization guard: a recorded OAuth grant that has lapsed blocks
 * capture until the tenant re-authorizes (fail fast — W085 acceptance:
 * "failed/expired meeting access is explicit"). Transports keep a healthy
 * grant current by reporting refreshed expiries; once lapsed, only
 * re-registration (the re-authorization path) unblocks the connection.
 */
function assertAuthorizationCurrent(connection: MeetingConnection, at: Date): void {
  if (connection.authKind === 'oauth' && connection.oauthExpiresAt !== null) {
    if (at.getTime() >= Date.parse(connection.oauthExpiresAt)) {
      throw new MeetingsError(
        'meeting_authorization_expired',
        `the OAuth grant of connection '${connection.id}' (${connection.provider}) expired at ${connection.oauthExpiresAt} — re-register the connection to re-authorize`,
      );
    }
  }
}

/**
 * Records a lapsed-grant access event (the explicit-domain trail of the
 * fail-fast `meeting_authorization_expired` throw above).
 */
async function recordLapsedGrantEvent(
  ctx: TenantContext,
  connection: MeetingConnection,
): Promise<void> {
  const at = now();
  await getDb().query(
    `INSERT INTO meeting_access_events (
       tenant_id, connection_id, provider, provider_meeting_id, code, detail, occurred_at
     ) VALUES ($1, $2, $3, NULL, 'authorization_expired', $4, $5)`,
    [
      ctx.tenantId,
      connection.id,
      connection.provider,
      `the recorded OAuth grant expired at ${connection.oauthExpiresAt ?? 'an unknown time'}`,
      at,
    ],
  );
}

// ---------------------------------------------------------------------------
// Participant registry (get-or-create on sight — the ADR-0003 discipline)
// ---------------------------------------------------------------------------

/**
 * Resolves a participant's email onto an organizational person through the
 * identity module (W002) — the one contract-legal bridge available before
 * W095 unifies meeting identity. READ-ONLY: no identity state is created
 * or modified; only an already-VERIFIED, subject-linked email identity
 * resolves. The identity module stores emails as delivered (trimmed), so
 * both the delivered and the lowercased form are probed.
 */
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
        // stay loud rather than wrong.
        throw new Error(
          `the identity contract rejected a participant email lookup (internal invariant violation): ${error.message}`,
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

/**
 * Get-or-create one canonical participant identity. On sight of a NEW
 * (provider, participant id) the row is created with the email-bridge
 * resolution; an EXISTING row moves its display facets forward (richer
 * provider data wins; nulls never erase what was learned) and refreshes
 * `last_seen_at`.
 */
async function captureParticipant(
  ctx: TenantContext,
  provider: MeetingConnection['provider'],
  participant: ValidatedParticipant,
  at: Date,
): Promise<MeetingParticipant> {
  const db = getDb();
  const canonical = getMeetingAdapter(provider).normalizeParticipantId(
    participant.providerParticipantId,
  );
  const email = participant.email;

  const inserted = await db.query<ParticipantRow>(
    `INSERT INTO meeting_participants (
       tenant_id, provider, provider_participant_id, display_name, email,
       subject_id, resolved_via, first_seen_at, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (tenant_id, provider, provider_participant_id) DO NOTHING
     RETURNING *`,
    [
      ctx.tenantId,
      provider,
      canonical,
      participant.displayName,
      email,
      null,
      null,
      at,
    ],
  );
  const fresh = inserted.rows[0];
  if (fresh !== undefined) {
    const resolved = email === null ? null : await resolveSubjectByEmail(ctx, email);
    if (resolved !== null) {
      const updated = await db.query<ParticipantRow>(
        `UPDATE meeting_participants SET subject_id = $3, resolved_via = 'verified_email_identity', updated_at = $4
           WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [ctx.tenantId, fresh.id, resolved, at],
      );
      return mapParticipant(updated.rows[0]!);
    }
    return mapParticipant(fresh);
  }

  // Existing identity: move display facets forward (never erase) and
  // refresh the sighting time. The email bridge is re-run when a NEW email
  // appears — a later capture may resolve what an earlier one could not.
  const existing = await db.query<ParticipantRow>(
    `SELECT * FROM meeting_participants
       WHERE tenant_id = $1 AND provider = $2 AND provider_participant_id = $3`,
    [ctx.tenantId, provider, canonical],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    // Unreachable barring a delete path (none exists — trigger-guarded);
    // stay loud rather than wrong.
    throw new Error(
      'meeting participant disappeared after a duplicate-registration conflict (internal invariant violation)',
    );
  }
  const updated = await db.query<ParticipantRow>(
    `UPDATE meeting_participants SET
         display_name = COALESCE($3, display_name),
         email = COALESCE($4, email),
         last_seen_at = $5,
         updated_at = $5
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, row.id, participant.displayName, email, at],
  );
  const mapped = mapParticipant(updated.rows[0]!);
  if (mapped.subjectId === null && email !== null) {
    const resolved = await resolveSubjectByEmail(ctx, email);
    if (resolved !== null) {
      const resolvedRow = await db.query<ParticipantRow>(
        `UPDATE meeting_participants SET subject_id = $3, resolved_via = 'verified_email_identity', updated_at = $4
           WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [ctx.tenantId, row.id, resolved, at],
      );
      return mapParticipant(resolvedRow.rows[0]!);
    }
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Evidence capture (the observations contract — W004)
// ---------------------------------------------------------------------------

/** Kinds of observation the meeting gateway records (canonical, filterable). */
const OBSERVATION_KINDS = {
  meetingMetadata: 'meeting.metadata',
  meetingSession: 'meeting.session',
  meetingTranscript: 'meeting.transcript',
  meetingArtifact: 'meeting.artifact',
  meetingAccess: 'meeting.access',
} as const;

/**
 * Records one canonical capture payload as an observation through the
 * observations contract, mapping sibling errors onto module codes. The
 * provider key is the channel (lock 16: neutral keys, never provider
 * objects); lineage `connector` marks gateway-captured evidence; the
 * provenance source carries the capture connection id (opaque, the
 * deliberately-unverified sibling reference the observations module
 * documents) and the gateway label.
 */
async function recordCaptureObservation(
  ctx: TenantContext,
  connection: MeetingConnection,
  kind: string,
  payload: unknown,
  observedAt: string,
): Promise<string> {
  try {
    const observation = await recordObservation(ctx, {
      kind,
      payload,
      observedAt,
      source: { kind: 'external', id: connection.id, label: 'meetings' },
      channel: connection.provider,
      lineage: { method: 'connector', parents: [], extractor: null },
      permissions: { visibility: 'tenant', workspaceId: null, principalId: null, usage: [] },
      confidence: {
        value: 1,
        method: 'meeting_gateway',
        basis: `verbatim ${connection.provider} record delivered by the meeting intelligence gateway (W085)`,
      },
    });
    return observation.id;
  } catch (error) {
    if (error instanceof ObservationsError) {
      // Every rejection here contradicts a pre-validated canonical record —
      // stay loud rather than wrong (the sources module's discipline for
      // sibling-contract rejections).
      throw new Error(
        `the observations contract rejected a canonical meeting record (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Registry upserts (meetings / sessions)
// ---------------------------------------------------------------------------

/** Loads (or creates a skeleton for) the meeting a record refers to. */
async function ensureMeeting(
  ctx: TenantContext,
  connection: MeetingConnection,
  providerMeetingId: string,
): Promise<MeetingRow> {
  const db = getDb();
  const existing = await db.query<MeetingRow>(
    `SELECT * FROM meetings WHERE tenant_id = $1 AND provider = $2 AND provider_meeting_id = $3`,
    [ctx.tenantId, connection.provider, providerMeetingId],
  );
  const row = existing.rows[0];
  if (row !== undefined) return row;

  // Skeleton: a session/transcript/artifact may arrive before any
  // metadata event. Identity is provider-minted and stable, so the
  // skeleton fills in place — it never forks.
  const inserted = await db.query<MeetingRow>(
    `INSERT INTO meetings (
         tenant_id, connection_id, provider, provider_meeting_id, created_by
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, provider, provider_meeting_id) DO NOTHING
       RETURNING *`,
    [ctx.tenantId, connection.id, connection.provider, providerMeetingId, ctx.principalId],
  );
  const fresh = inserted.rows[0];
  if (fresh !== undefined) return fresh;
  const raced = await db.query<MeetingRow>(
    `SELECT * FROM meetings WHERE tenant_id = $1 AND provider = $2 AND provider_meeting_id = $3`,
    [ctx.tenantId, connection.provider, providerMeetingId],
  );
  return raced.rows[0]!;
}

async function applyMeetingUpdated(
  ctx: TenantContext,
  connection: MeetingConnection,
  record: Extract<ValidatedMeetingRecord, { kind: 'meeting.updated' }>,
): Promise<string> {
  const db = getDb();
  const at = now();
  const host =
    record.host === null
      ? null
      : await captureParticipant(ctx, connection.provider, record.host, at);
  const meeting = await ensureMeeting(ctx, connection, record.providerMeetingId);
  await db.query(
    `UPDATE meetings SET
         title = COALESCE($3, title),
         agenda = COALESCE($4, agenda),
         scheduled_start_at = COALESCE($5, scheduled_start_at),
         scheduled_end_at = COALESCE($6, scheduled_end_at),
         host_participant_id = COALESCE($7, host_participant_id),
         underlying_platform = COALESCE($8, underlying_platform),
         updated_at = $9
       WHERE tenant_id = $1 AND id = $2`,
    [
      ctx.tenantId,
      meeting.id,
      record.title,
      record.agenda,
      record.scheduledStartAt === null ? null : new Date(record.scheduledStartAt),
      record.scheduledEndAt === null ? null : new Date(record.scheduledEndAt),
      host === null ? null : host.id,
      record.underlyingPlatform,
      at,
    ],
  );
  return recordCaptureObservation(
    ctx,
    connection,
    OBSERVATION_KINDS.meetingMetadata,
    {
      provider: connection.provider,
      connectionId: connection.id,
      providerMeetingId: record.providerMeetingId,
      title: record.title,
      agenda: record.agenda,
      scheduledStartAt: record.scheduledStartAt,
      scheduledEndAt: record.scheduledEndAt,
      underlyingPlatform: record.underlyingPlatform,
      host:
        host === null
          ? null
          : {
              participantId: host.id,
              providerParticipantId: host.providerParticipantId,
              displayName: host.displayName,
              email: host.email,
            },
    },
    record.occurredAt,
  );
}

/** Loads (or creates an ended skeleton for) the session a record refers to. */
async function ensureSession(
  ctx: TenantContext,
  connection: MeetingConnection,
  meetingId: string,
  providerSessionId: string,
): Promise<SessionRow> {
  const db = getDb();
  const existing = await db.query<SessionRow>(
    `SELECT * FROM meeting_sessions WHERE tenant_id = $1 AND meeting_id = $2 AND provider_session_id = $3`,
    [ctx.tenantId, meetingId, providerSessionId],
  );
  const row = existing.rows[0];
  if (row !== undefined) return row;

  // An artifact/transcript proves the occurrence ran and completed: the
  // skeleton is 'ended' (actual times null until a session event carries
  // them).
  const inserted = await db.query<SessionRow>(
    `INSERT INTO meeting_sessions (
         tenant_id, meeting_id, provider_session_id, status
       ) VALUES ($1, $2, $3, 'ended')
       ON CONFLICT (tenant_id, meeting_id, provider_session_id) DO NOTHING
       RETURNING *`,
    [ctx.tenantId, meetingId, providerSessionId],
  );
  const fresh = inserted.rows[0];
  if (fresh !== undefined) return fresh;
  const raced = await db.query<SessionRow>(
    `SELECT * FROM meeting_sessions WHERE tenant_id = $1 AND meeting_id = $2 AND provider_session_id = $3`,
    [ctx.tenantId, meetingId, providerSessionId],
  );
  return raced.rows[0]!;
}

async function applySessionUpdated(
  ctx: TenantContext,
  connection: MeetingConnection,
  record: Extract<ValidatedMeetingRecord, { kind: 'session.updated' }>,
): Promise<string> {
  const db = getDb();
  const at = now();
  const meeting = await ensureMeeting(ctx, connection, record.providerMeetingId);

  const participants: SessionParticipant[] = [];
  for (const attendance of record.participants) {
    const captured = await captureParticipant(
      ctx,
      connection.provider,
      attendance.participant,
      at,
    );
    participants.push({
      participantId: captured.id,
      providerParticipantId: captured.providerParticipantId,
      displayName: captured.displayName,
      email: captured.email,
      joinedAt: attendance.joinedAt,
      leftAt: attendance.leftAt,
    });
  }

  await db.query(
    `INSERT INTO meeting_sessions (
         tenant_id, meeting_id, provider_session_id, status, title,
         started_at, ended_at, participants
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, meeting_id, provider_session_id) DO UPDATE SET
         status = EXCLUDED.status,
         title = COALESCE(EXCLUDED.title, meeting_sessions.title),
         started_at = COALESCE(EXCLUDED.started_at, meeting_sessions.started_at),
         ended_at = COALESCE(EXCLUDED.ended_at, meeting_sessions.ended_at),
         participants = EXCLUDED.participants,
         updated_at = now()`,
    [
      ctx.tenantId,
      meeting.id,
      record.providerSessionId,
      record.status,
      record.title,
      record.startedAt === null ? null : new Date(record.startedAt),
      record.endedAt === null ? null : new Date(record.endedAt),
      JSON.stringify(participants),
    ],
  );

  return recordCaptureObservation(
    ctx,
    connection,
    OBSERVATION_KINDS.meetingSession,
    {
      provider: connection.provider,
      connectionId: connection.id,
      providerMeetingId: record.providerMeetingId,
      providerSessionId: record.providerSessionId,
      status: record.status,
      title: record.title,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      participants,
    },
    record.occurredAt,
  );
}

async function applyTranscriptAvailable(
  ctx: TenantContext,
  connection: MeetingConnection,
  record: Extract<ValidatedMeetingRecord, { kind: 'transcript.available' }>,
  via: 'polling' | 'webhook',
): Promise<string> {
  const db = getDb();
  const at = now();
  const meeting = await ensureMeeting(ctx, connection, record.providerMeetingId);
  const session = await ensureSession(
    ctx,
    connection,
    meeting.id,
    record.providerSessionId,
  );

  // Speaker attribution: segment speakers resolve through the participant
  // registry (get-or-create) — "participant identity … captured into the
  // canonical evidence model" at the segment level.
  const segments = [] as {
    participantId: string | null;
    speakerName: string | null;
    startedAt: string;
    endedAt: string | null;
    text: string;
    confidence: number | null;
  }[];
  for (const segment of record.segments) {
    const participant =
      segment.providerParticipantId === null
        ? null
        : await captureParticipant(
            ctx,
            connection.provider,
            {
              providerParticipantId: segment.providerParticipantId,
              displayName: segment.speakerName,
              email: null,
            },
            at,
          );
    segments.push({
      participantId: participant === null ? null : participant.id,
      speakerName: segment.speakerName,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      text: segment.text,
      confidence: segment.confidence,
    });
  }

  const observationId = await recordCaptureObservation(
    ctx,
    connection,
    OBSERVATION_KINDS.meetingTranscript,
    {
      provider: connection.provider,
      connectionId: connection.id,
      providerMeetingId: record.providerMeetingId,
      providerSessionId: record.providerSessionId,
      providerTranscriptId: record.providerTranscriptId,
      language: record.language,
      segments,
    },
    record.occurredAt,
  );

  // Append-only: a provider-side revision is a new provider transcript id
  // and a new row; both are retained (lock 12 spirit). Within one session
  // a duplicate id is a redelivery the ledger has already suppressed —
  // the ON CONFLICT DO NOTHING keeps a raced double-apply from failing
  // the pass.
  await db.query(
    `INSERT INTO meeting_transcripts (
         tenant_id, session_id, provider_transcript_id, language, segments,
         evidence_observation_id, captured_via, captured_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (tenant_id, session_id, provider_transcript_id) DO NOTHING`,
    [
      ctx.tenantId,
      session.id,
      record.providerTranscriptId,
      record.language,
      JSON.stringify(segments),
      observationId,
      via,
      at,
    ],
  );
  return observationId;
}

async function applyArtifactAvailable(
  ctx: TenantContext,
  connection: MeetingConnection,
  record: Extract<ValidatedMeetingRecord, { kind: 'artifact.available' }>,
  via: 'polling' | 'webhook',
): Promise<string> {
  const db = getDb();
  const at = now();
  const meeting = await ensureMeeting(ctx, connection, record.providerMeetingId);
  const session = await ensureSession(
    ctx,
    connection,
    meeting.id,
    record.providerSessionId,
  );

  const observationId = await recordCaptureObservation(
    ctx,
    connection,
    OBSERVATION_KINDS.meetingArtifact,
    {
      provider: connection.provider,
      connectionId: connection.id,
      providerMeetingId: record.providerMeetingId,
      providerSessionId: record.providerSessionId,
      providerArtifactId: record.providerArtifactId,
      artifactKind: record.artifactKind,
      displayName: record.displayName,
      mediaType: record.mediaType,
      byteSize: record.byteSize,
      storageRef: record.storageRef,
      checksum: record.checksum,
    },
    record.occurredAt,
  );

  await db.query(
    `INSERT INTO meeting_artifacts (
         tenant_id, session_id, kind, provider_artifact_id, display_name,
         media_type, byte_size, storage_ref, checksum,
         evidence_observation_id, captured_via, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, session_id, provider_artifact_id) DO NOTHING`,
    [
      ctx.tenantId,
      session.id,
      record.artifactKind,
      record.providerArtifactId,
      record.displayName,
      record.mediaType,
      record.byteSize,
      record.storageRef,
      record.checksum,
      observationId,
      via,
      at,
    ],
  );
  return observationId;
}

async function applyAccessFailed(
  ctx: TenantContext,
  connection: MeetingConnection,
  record: Extract<ValidatedMeetingRecord, { kind: 'access.failed' }>,
): Promise<string> {
  const db = getDb();
  await db.query(
    `INSERT INTO meeting_access_events (
         tenant_id, connection_id, provider, provider_meeting_id, code, detail, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ctx.tenantId,
      connection.id,
      connection.provider,
      record.providerMeetingId,
      record.accessCode,
      record.detail,
      new Date(record.occurredAt),
    ],
  );
  return recordCaptureObservation(
    ctx,
    connection,
    OBSERVATION_KINDS.meetingAccess,
    {
      provider: connection.provider,
      connectionId: connection.id,
      providerMeetingId: record.providerMeetingId,
      accessCode: record.accessCode,
      detail: record.detail,
    },
    record.occurredAt,
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function registerMeetingConnection(
  ctx: TenantContext,
  input: RegisterMeetingConnectionInput,
): Promise<RegisterMeetingConnectionResult> {
  assertMeetingsTenantContext(ctx);
  const valid = validateRegisterConnectionInput(input);
  const adapter = getMeetingAdapter(valid.provider);
  const providerAccountId = adapter.normalizeAccountId(valid.providerAccountId);
  const at = now();
  const db = getDb();

  // Re-registering an existing connection is the RE-AUTHORIZATION path:
  // the authorization fields (kind, credential reference, scopes, expiry)
  // move to what the caller just supplied; the endpoint's identity
  // (provider, account, provenance history) never changes. The
  // transaction + duplicate-key discipline makes the rare concurrent
  // first-registration explicit instead of racy.
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM meeting_connections
         WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
      [ctx.tenantId, valid.provider, providerAccountId],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<ConnectionRow>(
        `UPDATE meeting_connections SET
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
        `INSERT INTO meeting_connections (
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
      if (isDuplicateKeyOn(error, 'meeting_connections')) {
        throw new MeetingsError(
          'meeting_connection_conflict',
          'a meeting connection for this provider account was created concurrently; retry the registration',
        );
      }
      throw error;
    }
    return { connection: mapConnection(inserted.rows[0]!), created: true };
  });
}

export async function getMeetingConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<MeetingConnection> {
  assertMeetingsTenantContext(ctx);
  return loadConnection(ctx, connectionId);
}

export async function listMeetingConnections(
  ctx: TenantContext,
  query: ListMeetingConnectionsQuery,
): Promise<MeetingConnection[]> {
  assertMeetingsTenantContext(ctx);
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
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<ConnectionRow>(
    `SELECT * FROM meeting_connections WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapConnection(row));
}

export async function setMeetingConnectionStatus(
  ctx: TenantContext,
  input: SetMeetingConnectionStatusInput,
): Promise<MeetingConnection> {
  assertMeetingsTenantContext(ctx);
  const valid = validateSetConnectionStatusInput(input);
  const result = await getDb().query<ConnectionRow>(
    `UPDATE meeting_connections SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, valid.connectionId, valid.status, now()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant connections are indistinguishable from missing ones.
    throw new MeetingsError(
      'connection_not_found',
      `connection '${valid.connectionId}' does not exist in this tenant`,
    );
  }
  return mapConnection(row);
}

// ---------------------------------------------------------------------------
// Ingestion core — claim, apply, link (the shared webhook/polling path)
// ---------------------------------------------------------------------------

/**
 * Applies one canonical record to the registry + evidence model. The
 * `via` discriminator travels into the append-only capture tables
 * (transcripts/artifacts record which canonical path committed them).
 */
async function applyRecord(
  ctx: TenantContext,
  connection: MeetingConnection,
  record: ValidatedMeetingRecord,
  via: 'polling' | 'webhook',
): Promise<string> {
  switch (record.kind) {
    case 'meeting.updated':
      return applyMeetingUpdated(ctx, connection, record);
    case 'session.updated':
      return applySessionUpdated(ctx, connection, record);
    case 'transcript.available':
      return applyTranscriptAvailable(ctx, connection, record, via);
    case 'artifact.available':
      return applyArtifactAvailable(ctx, connection, record, via);
    case 'access.failed':
      return applyAccessFailed(ctx, connection, record);
  }
}

/**
 * Ingests one validated batch into a connection: claims each provider
 * record id on the append-only ledger, applies the fresh records to the
 * registry + evidence model, fills the one-way link, and reports what
 * happened. Serialized by the per-connection ingestion lock.
 */
async function ingestRecords(
  ctx: TenantContext,
  connection: MeetingConnection,
  records: ValidatedMeetingRecord[],
  via: 'polling' | 'webhook',
): Promise<{ ingested: number; duplicates: number; records: IngestedRecord[] }> {
  if (records.length === 0) {
    return { ingested: 0, duplicates: 0, records: [] };
  }

  const lockKey = `meetings:ingest:${connection.id}`;
  const lock = getLock();
  const token = await lock.acquire(lockKey, INGESTION_LOCK_TTL_MS);
  if (token === null) {
    throw new MeetingsError(
      'ingestion_busy',
      `another capture pass holds connection '${connection.id}' — retry once it completes (safe: capture is idempotent)`,
    );
  }
  try {
    const db = getDb();
    const at = now();

    // 1. Claim: fresh provider record ids enter the ledger; ids already
    //    linked (or claimed by a live concurrent pass — impossible under
    //    the lock, but guarded anyway) are duplicates.
    const claimParams: unknown[] = [ctx.tenantId, connection.id, at, via];
    const claimTuples = records.map((record, index) => `($1, $2, $${5 + index}, $4, $3)`);
    for (const record of records) claimParams.push(record.providerRecordId);
    const claimed = await db.query<{ provider_record_id: string }>(
      `INSERT INTO meeting_ingestion (
         tenant_id, connection_id, provider_record_id, ingested_via, claimed_at
       ) VALUES ${claimTuples.join(', ')}
       ON CONFLICT (tenant_id, connection_id, provider_record_id) DO NOTHING
       RETURNING provider_record_id`,
      claimParams,
    );
    const freshIds = new Set(claimed.rows.map((row) => row.provider_record_id));

    // 2. Crash recovery: a PREVIOUS pass may have claimed ids whose
    //    observation never got recorded or linked (process died between
    //    claim and link). Those unlinked claims are re-ingestible — the
    //    provider's latest delivery of the record is captured now.
    const conflictIds = records
      .filter((record) => !freshIds.has(record.providerRecordId))
      .map((record) => record.providerRecordId);
    const recoverableIds = new Set<string>();
    if (conflictIds.length > 0) {
      const recovery = await db.query<{ provider_record_id: string }>(
        `SELECT provider_record_id FROM meeting_ingestion
           WHERE tenant_id = $1 AND connection_id = $2
             AND provider_record_id = ANY($3::text[])
             AND observation_id IS NULL`,
        [ctx.tenantId, connection.id, conflictIds],
      );
      for (const row of recovery.rows) recoverableIds.add(row.provider_record_id);
    }

    const claimable = records.filter(
      (record) =>
        freshIds.has(record.providerRecordId) || recoverableIds.has(record.providerRecordId),
    );
    const duplicates = records.length - claimable.length;

    // 3. Apply: registry + evidence per claimable record.
    const ingested: IngestedRecord[] = [];
    for (const record of claimable) {
      const observationId = await applyRecord(ctx, connection, record, via);
      ingested.push({ providerRecordId: record.providerRecordId, observationId });
      // 4. Link: fill the one-way ledger link. The NULL-guard keeps a
      //    concurrent writer from double-linking (defense in depth on top
      //    of the lock).
      await db.query(
        `UPDATE meeting_ingestion SET observation_id = $4, ingested_at = $5
           WHERE tenant_id = $1 AND connection_id = $2 AND provider_record_id = $3
             AND observation_id IS NULL`,
        [ctx.tenantId, connection.id, record.providerRecordId, observationId, at],
      );
    }

    return { ingested: claimable.length, duplicates, records: ingested };
  } finally {
    await lock.release(lockKey, token);
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function receiveMeetingWebhook(
  ctx: TenantContext,
  input: ReceiveMeetingWebhookInput,
): Promise<WebhookResult> {
  assertMeetingsTenantContext(ctx);
  const valid = validateReceiveWebhookInput(input);
  const adapter = getMeetingAdapter(valid.provider);
  if (!adapter.modes.includes('webhook')) {
    throw new MeetingsError(
      'ingestion_mode_unsupported',
      `provider '${valid.provider}' supports no webhook capture — it is polled through the fetch transport`,
    );
  }

  // Provider-native payload → canonical records (adapter-private; the raw
  // envelope never advances past this line).
  const parsed = adapter.parseWebhook(input.payload);
  // Defense in depth: adapter output is re-validated before anything is
  // persisted or handed to a sibling contract.
  const canonical: ValidatedWebhookParseResult = validateWebhookParseResult(parsed);

  // The envelope's account resolves onto THIS tenant's registered
  // connection — a foreign tenant's endpoint is indistinguishable from an
  // unknown account (ADR-0001, no existence leak).
  const connection = await loadConnectionByAccount(
    ctx,
    valid.provider,
    adapter.normalizeAccountId(canonical.providerAccountId),
  );
  if (connection.status !== 'active') {
    throw new MeetingsError(
      'connection_disabled',
      `connection '${connection.id}' (${connection.provider}) is disabled`,
    );
  }
  assertAuthorizationCurrent(connection, now());

  const ingest = await ingestRecords(ctx, connection, canonical.records, 'webhook');
  return {
    connection,
    fetched: canonical.records.length,
    ingested: ingest.ingested,
    duplicates: ingest.duplicates,
    records: ingest.records,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function loadCursorRow(
  ctx: TenantContext,
  connectionId: string,
): Promise<CursorRow | null> {
  const result = await getDb().query<CursorRow>(
    `SELECT * FROM meeting_ingestion_cursors WHERE tenant_id = $1 AND connection_id = $2`,
    [ctx.tenantId, connectionId],
  );
  return result.rows[0] ?? null;
}

async function advanceCursor(
  ctx: TenantContext,
  connectionId: string,
  cursor: string | null,
): Promise<void> {
  await getDb().query(
    `INSERT INTO meeting_ingestion_cursors (tenant_id, connection_id, cursor, updated_at)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, connection_id) DO UPDATE SET cursor = $3, updated_at = $4`,
    [ctx.tenantId, connectionId, cursor, now()],
  );
}

export async function pollMeetingConnection(
  ctx: TenantContext,
  input: PollMeetingConnectionInput,
): Promise<PollResult> {
  assertMeetingsTenantContext(ctx);
  const valid: ValidatedPollInput = validatePollInput(input);
  const connection = await loadActiveConnection(ctx, valid.connectionId);
  const adapter = getMeetingAdapter(connection.provider);
  if (!adapter.modes.includes('polling')) {
    throw new MeetingsError(
      'ingestion_mode_unsupported',
      `provider '${connection.provider}' supports no polling — its records arrive through webhooks`,
    );
  }

  // Failed/expired access is explicit: a lapsed recorded grant fails fast
  // AND leaves a queryable access event before it throws.
  if (connection.authKind === 'oauth' && connection.oauthExpiresAt !== null) {
    if (now().getTime() >= Date.parse(connection.oauthExpiresAt)) {
      await recordLapsedGrantEvent(ctx, connection);
      assertAuthorizationCurrent(connection, now());
    }
  }

  const transport = meetingTransport;
  if (transport === null) {
    throw new MeetingsError(
      'provider_unavailable',
      `no meeting transport is wired for provider '${connection.provider}' (wire one via setMeetingTransport)`,
    );
  }

  const cursorRow = await loadCursorRow(ctx, connection.id);
  const cursor = cursorRow?.cursor ?? null;

  let raw: MeetingFetchResult;
  try {
    raw = await transport.fetch({
      provider: connection.provider,
      tenantId: ctx.tenantId,
      connectionId: connection.id,
      providerAccountId: connection.providerAccountId,
      credentialRef: connection.credentialRef,
      cursor,
      maxRecords: valid.maxRecords,
    });
  } catch (error) {
    throw new MeetingsError(
      'fetch_failed',
      `the ${connection.provider} transport failed to fetch records for connection '${connection.id}'${
        error instanceof Error ? `: ${error.message}` : ''
      } (transient — the cursor is unchanged and the poll may be retried)`,
    );
  }

  // Defense in depth: transport output is re-validated before anything is
  // persisted or handed to the observations contract.
  const fetched = validateFetchResult(raw);
  if (fetched.authorizationExpiresAt !== null && connection.authKind !== 'oauth') {
    throw new Error(
      `the ${connection.provider} transport reported an authorization expiry for a credentials-authorized connection (internal invariant violation)`,
    );
  }

  // Ingest FIRST, cursor SECOND: a crash between the two re-fetches the
  // same window on the next poll and dedupe suppresses re-capture.
  const ingest = await ingestRecords(ctx, connection, fetched.records, 'polling');

  if (cursorAdvance(cursor, fetched.nextCursor)) {
    await advanceCursor(ctx, connection.id, fetched.nextCursor);
  }

  // A transport that refreshed the OAuth grant reports the new expiry; the
  // recorded authorization state moves with it (non-secret metadata).
  let current = connection;
  if (fetched.authorizationExpiresAt !== null) {
    const updated = await getDb().query<ConnectionRow>(
      `UPDATE meeting_connections SET oauth_expires_at = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, connection.id, new Date(fetched.authorizationExpiresAt), now()],
    );
    const row = updated.rows[0];
    if (row !== undefined) current = mapConnection(row);
  }

  return {
    connection: current,
    fetched: fetched.records.length,
    ingested: ingest.ingested,
    duplicates: ingest.duplicates,
    records: ingest.records,
    hasMore: fetched.hasMore,
  };
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

function mapMeetingRow(row: MeetingRow): Meeting {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    provider: row.provider as MeetingProvider, // CHECK-constrained by migration 003
    providerMeetingId: row.provider_meeting_id,
    title: row.title,
    agenda: row.agenda,
    scheduledStartAt: row.scheduled_start_at === null ? null : toIso(row.scheduled_start_at),
    scheduledEndAt: row.scheduled_end_at === null ? null : toIso(row.scheduled_end_at),
    hostParticipantId: row.host_participant_id,
    underlyingPlatform: row.underlying_platform,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function getMeeting(
  ctx: TenantContext,
  meetingId: string,
): Promise<Meeting> {
  assertMeetingsTenantContext(ctx);
  if (!isUuid(meetingId)) {
    throw new MeetingsError(
      'meeting_not_found',
      `meeting '${meetingId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<MeetingRow>(
    `SELECT * FROM meetings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, meetingId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MeetingsError(
      'meeting_not_found',
      `meeting '${meetingId}' does not exist in this tenant`,
    );
  }
  return mapMeetingRow(row);
}

export async function listMeetings(
  ctx: TenantContext,
  query: ListMeetingsQuery,
): Promise<Meeting[]> {
  assertMeetingsTenantContext(ctx);
  const valid: ValidatedListMeetingsQuery = validateListMeetingsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (valid.connectionId !== null) {
    params.push(valid.connectionId);
    conditions.push(`connection_id = $${params.length}`);
  }
  if (valid.scheduledFrom !== null) {
    params.push(new Date(valid.scheduledFrom));
    conditions.push(`(scheduled_start_at IS NULL OR scheduled_start_at >= $${params.length})`);
  }
  if (valid.scheduledTo !== null) {
    params.push(new Date(valid.scheduledTo));
    conditions.push(`(scheduled_start_at IS NULL OR scheduled_start_at <= $${params.length})`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<MeetingRow>(
    `SELECT * FROM meetings WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapMeetingRow(row));
}

export async function getMeetingSession(
  ctx: TenantContext,
  sessionId: string,
): Promise<MeetingSession> {
  assertMeetingsTenantContext(ctx);
  if (!isUuid(sessionId)) {
    throw new MeetingsError(
      'session_not_found',
      `session '${sessionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<SessionRow>(
    `SELECT * FROM meeting_sessions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MeetingsError(
      'session_not_found',
      `session '${sessionId}' does not exist in this tenant`,
    );
  }
  return mapSession(row);
}

export async function listMeetingSessions(
  ctx: TenantContext,
  query: ListMeetingSessionsQuery,
): Promise<MeetingSession[]> {
  assertMeetingsTenantContext(ctx);
  const valid: ValidatedListSessionsQuery = validateListSessionsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.meetingId !== null) {
    params.push(valid.meetingId);
    conditions.push(`meeting_id = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.startedFrom !== null) {
    params.push(new Date(valid.startedFrom));
    conditions.push(`(started_at IS NULL OR started_at >= $${params.length})`);
  }
  if (valid.startedTo !== null) {
    params.push(new Date(valid.startedTo));
    conditions.push(`(started_at IS NULL OR started_at <= $${params.length})`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<SessionRow>(
    `SELECT * FROM meeting_sessions WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapSession(row));
}

export async function listMeetingTranscripts(
  ctx: TenantContext,
  query: ListMeetingTranscriptsQuery,
): Promise<MeetingTranscript[]> {
  assertMeetingsTenantContext(ctx);
  const valid: ValidatedListTranscriptsQuery = validateListTranscriptsQuery(query);
  // The session check enforces tenancy before any transcript is revealed.
  await getMeetingSession(ctx, valid.sessionId);
  const rows = await getDb().query<TranscriptRow>(
    `SELECT * FROM meeting_transcripts
       WHERE tenant_id = $1 AND session_id = $2
       ORDER BY created_at DESC, id DESC LIMIT $3`,
    [ctx.tenantId, valid.sessionId, valid.limit],
  );
  return rows.rows.map((row) => mapTranscript(row));
}

export async function listMeetingArtifacts(
  ctx: TenantContext,
  query: ListMeetingArtifactsQuery,
): Promise<MeetingArtifact[]> {
  assertMeetingsTenantContext(ctx);
  const valid: ValidatedListArtifactsQuery = validateListArtifactsQuery(query);
  // The session check enforces tenancy before any artifact is revealed.
  await getMeetingSession(ctx, valid.sessionId);
  const conditions: string[] = ['tenant_id = $1', 'session_id = $2'];
  const params: unknown[] = [ctx.tenantId, valid.sessionId];
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ArtifactRow>(
    `SELECT * FROM meeting_artifacts WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapArtifact(row));
}

export async function listMeetingAccessEvents(
  ctx: TenantContext,
  query: ListMeetingAccessEventsQuery,
): Promise<MeetingAccessEvent[]> {
  assertMeetingsTenantContext(ctx);
  const valid: ValidatedListAccessEventsQuery = validateListAccessEventsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.connectionId !== null) {
    params.push(valid.connectionId);
    conditions.push(`connection_id = $${params.length}`);
  }
  if (valid.code !== null) {
    params.push(valid.code);
    conditions.push(`code = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<AccessEventRow>(
    `SELECT * FROM meeting_access_events WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapAccessEvent(row));
}

export async function listMeetingParticipants(
  ctx: TenantContext,
  query: ListMeetingParticipantsQuery,
): Promise<MeetingParticipant[]> {
  assertMeetingsTenantContext(ctx);
  const valid: ValidatedListParticipantsQuery = validateListParticipantsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ParticipantRow>(
    `SELECT * FROM meeting_participants WHERE ${conditions.join(' AND ')}
       ORDER BY last_seen_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapParticipant(row));
}
