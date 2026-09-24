// Public domain types of the meetings module (W085 — Meeting Intelligence
// Gateway).
//
// W085 owns the canonical meeting intelligence vocabulary: "Create
// canonical meeting/session/transcript/artifact contracts and native
// Zoom/Teams/Meet adapters, plus optional cross-platform meeting-bot
// adapters" (WORK-ITEM-CATALOG). Meeting information enters the SAME
// identity, evidence, CompanyModel and cognition loop as every other
// observation (FINAL-TECH-LEAD-HANDOFF §4.4: "There is no separate meeting
// knowledge store") — this module is the CAPTURE gateway, never a second
// knowledge authority: transcripts, artifacts, participant identities and
// metadata become immutable OBSERVATIONS through the observations contract
// (W004); understanding remains the epistemics/cognition path's job.
//
// Everything here is provider-neutral BY CONSTRUCTION (lock 16 /
// MODULE-DEPENDENCY-MAP provider boundaries): providers appear only as the
// canonical `MeetingProvider` key owned by this module's validation
// vocabulary; provider-native webhook envelopes, meeting objects, session
// shapes, transcript formats and artifact descriptors are parsed inside
// `adapters/` and never leave this module in their raw shape. The only
// provider-minted values that cross the boundary are OPAQUE strings
// (account ids, meeting/session/transcript/artifact ids, cursors) — the
// discipline the sources module applies to CRM records.
//
// Credential isolation (GOVERNANCE mandatory invariant; IMPLEMENTATION-
// STACK §8): `credentialRef` is an OPAQUE reference into the secret store.
// OAuth token values, API keys and bot secrets never reach a domain table,
// a log line or a contract result. The domain tracks only NON-SECRET
// authorization STATE (the authorization kind, the granted scopes and the
// grant's expiry).
//
// Canonical model (the contracts the work item names):
//   * MeetingConnection — one tenant-owned capture endpoint per provider
//     account (a Zoom workspace, a Teams tenant, a Meet workspace, a
//     Recall meeting-bot account): configuration + authorization state.
//   * Meeting — the scheduled/recurring meeting entity a provider
//     identifies (title, agenda, scheduled window, host): a CAPTURE
//     REGISTRY row (current provider metadata), each delivered state of
//     which is preserved as an immutable observation.
//   * MeetingSession — ONE occurrence of a meeting (a call instance) with
//     its participant attendance: the unit transcripts and artifacts attach
//     to. W086 (Realtime Voice / Meeting Companion) builds its live
//     sessions on this contract.
//   * MeetingParticipant — the canonical participant identity registry:
//     provider-minted participant accounts (get-or-create on sight, the
//     ADR-0003 discipline applied to meeting providers) with an optional
//     read-only resolution onto an organizational person through the
//     identity module's VERIFIED email identities (W002). Unifying meeting
//     identity with the full identity module is W095's declared job.
//   * MeetingTranscript — the canonical transcript of one session: ordered
//     segments with speaker attribution (participant ids or provider
//     speaker labels), timestamps, text and provider ASR confidence.
//   * MeetingArtifact — one durable artifact of a session (a recording, a
//     chat file, a summary, a document…) identified by its OPAQUE storage
//     reference and carrying its capture provenance.
//   * MeetingAccessEvent — the explicit record of failed/expired meeting
//     access ("failed/expired meeting access is explicit" — W085
//     acceptance): append-only, queryable, never a silent gap.

// ---------------------------------------------------------------------------
// Providers, modes, statuses
// ---------------------------------------------------------------------------

/**
 * Canonical meeting-provider vocabulary (owned by this module — the
 * meetings counterpart of the sources module's provider keys). The three
 * native platform adapters ('zoom', 'microsoft-teams', 'google-meet') are
 * joined by 'recall' — the cross-platform meeting-bot adapter (the
 * FINAL-TECH-LEAD-HANDOFF §14 technology policy: "Prefer native platform
 * APIs; use Recall/Meeting BaaS as an acceleration adapter when useful").
 * Mirrored by the `provider` CHECKs in migrations/ — keep both in sync.
 */
export type MeetingProvider = 'zoom' | 'microsoft-teams' | 'google-meet' | 'recall';

/** How a provider's records can be captured: pulled on demand, or pushed. */
export type MeetingIngestionMode = 'polling' | 'webhook';

/** Which canonical path captured a record. */
export type MeetingIngestionVia = 'polling' | 'webhook';

export type MeetingConnectionStatus = 'active' | 'disabled';

/**
 * How the tenant authorized the capture (non-secret classification of the
 * credential held in the secret store behind `credentialRef`).
 */
export type MeetingAuthKind = 'oauth' | 'credentials';

/** Lifecycle of one meeting occurrence. */
export type MeetingSessionStatus = 'scheduled' | 'started' | 'ended';

/** Canonical artifact kinds a session can produce. */
export type MeetingArtifactKind =
  | 'recording'
  | 'chat'
  | 'summary'
  | 'document'
  | 'attachment'
  | 'other';

/**
 * Canonical classification of failed/expired meeting access (W085
 * acceptance: "failed/expired meeting access is explicit"). A closed
 * vocabulary so consumers can branch without parsing prose.
 */
export type MeetingAccessCode =
  | 'authorization_expired' // the recorded OAuth grant lapsed
  | 'access_denied' // the provider refused access to the resource
  | 'not_found' // the provider no longer knows the meeting/session
  | 'recording_unavailable' // the recording exists but cannot be retrieved
  | 'transcript_unavailable'; // the transcript exists but cannot be retrieved

// ---------------------------------------------------------------------------
// Connections (tenant-owned capture endpoints)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped meeting capture endpoint: one authorized provider account
 * the tenant captures meeting intelligence from (ARCHITECTURE.md §3:
 * tenants own their sources).
 *
 * `credentialRef` is an OPAQUE secret-store reference; the credential value
 * never reaches any domain table (IMPLEMENTATION-STACK §8; GOVERNANCE:
 * source credentials are tenant-scoped and never stored in semantic
 * memory). OAuth metadata (`oauthScopes`, `oauthExpiresAt`) is non-secret
 * authorization state; it is incoherent (and rejected) for
 * `credentials`-authorized connections.
 *
 * `modes` reports the capture modes the provider's adapter supports —
 * derived, provider-neutral capability, never a provider object.
 */
export interface MeetingConnection {
  id: string;
  tenantId: string;
  provider: MeetingProvider;
  /** Canonical, adapter-normalized account id (opaque string). */
  providerAccountId: string;
  displayName: string | null;
  authKind: MeetingAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted OAuth scopes (oauth connections only; empty otherwise). */
  oauthScopes: string[];
  /** When the OAuth grant lapses (oauth connections only; null = non-expiring). */
  oauthExpiresAt: string | null;
  status: MeetingConnectionStatus;
  /** Capture modes the provider adapter supports. */
  modes: MeetingIngestionMode[];
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on status/authorization changes only. */
  updatedAt: string;
}

export interface RegisterMeetingConnectionInput {
  provider: MeetingProvider;
  /** Raw provider account id; normalized by the provider's adapter. */
  providerAccountId: string;
  displayName?: string | null;
  authKind: MeetingAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted scopes; required to be empty for `credentials` connections. */
  oauthScopes?: string[];
  /** Grant expiry (strict ISO 8601); required to be null for `credentials` connections. */
  oauthExpiresAt?: string | null;
}

/**
 * Result of `registerMeetingConnection`. Re-registering an EXISTING
 * connection is the re-authorization path: it updates the authorization
 * fields (auth kind, credential reference, scopes, expiry) and reports
 * `created: false` — the endpoint's identity (provider, account,
 * provenance history) never changes.
 */
export interface RegisterMeetingConnectionResult {
  connection: MeetingConnection;
  created: boolean;
}

export interface ListMeetingConnectionsQuery {
  provider?: MeetingProvider;
  status?: MeetingConnectionStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetMeetingConnectionStatusInput {
  connectionId: string;
  status: MeetingConnectionStatus;
}

// ---------------------------------------------------------------------------
// Participant identity (canonical, provider-minted)
// ---------------------------------------------------------------------------

/**
 * A provider-minted participant identity, normalized by the provider's
 * PRIVATE adapter — what a session's attendance and a transcript's speaker
 * attribution are expressed in. The provider's own stable participant
 * account id (opaque string) plus the display facets the provider
 * reported. No provider SDK object crosses the boundary (lock 16).
 */
export interface CanonicalParticipant {
  /** Canonical, adapter-normalized participant account id (opaque). */
  providerParticipantId: string;
  displayName: string | null;
  email: string | null;
}

/** One participant's attendance of one session, as the provider reported. */
export interface CanonicalParticipantAttendance {
  participant: CanonicalParticipant;
  /** ISO 8601 — when the participant joined (null = the provider did not say). */
  joinedAt: string | null;
  /** ISO 8601 — when the participant left (null = still in or unknown). */
  leftAt: string | null;
}

/**
 * The persisted participant identity: a tenant-scoped canonical registry
 * entry per (provider, participant account), captured on sight (get-or-
 * create; duplicates collapse onto one row — the ADR-0003 discipline the
 * identity module applies to channel providers, applied to meeting
 * providers). Unifying meeting identities with the identity module's
 * verified linking is W095's declared job; W085 additionally performs the
 * one contract-legal bridge available today: when the participant carries
 * an email that matches a VERIFIED, subject-linked email identity in the
 * identity module (W002), `subjectId` records the organizational person
 * (read-only resolution — no identity state is created or modified here).
 */
export interface MeetingParticipant {
  id: string;
  tenantId: string;
  provider: MeetingProvider;
  /** Canonical, adapter-normalized participant account id (opaque). */
  providerParticipantId: string;
  displayName: string | null;
  email: string | null;
  /**
   * Opaque reference to the resolved organizational person
   * (people.persons.id) when the verified-email bridge resolved; null
   * otherwise. Never a foreign key (cross-module, house pattern).
   */
  subjectId: string | null;
  /** How `subjectId` was resolved (null while unresolved). */
  resolvedVia: 'verified_email_identity' | null;
  /** ISO 8601 — first time this identity was seen in a capture. */
  firstSeenAt: string;
  /** ISO 8601 — last time this identity was seen in a capture. */
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListMeetingParticipantsQuery {
  provider?: MeetingProvider;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Meetings (the scheduled entity) and sessions (one occurrence)
// ---------------------------------------------------------------------------

/**
 * The canonical meeting: the provider-identified scheduled/recurring
 * entity. A CAPTURE REGISTRY row holding the LATEST provider metadata;
 * every delivered state of that metadata is preserved as an immutable
 * observation (kind `meeting.metadata`) — the registry is current state,
 * the observations are the evidence trail.
 *
 * Sessions (occurrences) reference their meeting; a session may arrive
 * before any metadata event, in which case the meeting is created as a
 * skeleton (null title/agenda) and filled when the provider delivers
 * metadata — meeting identity is provider-minted and stable, so the
 * skeleton never forks.
 */
export interface Meeting {
  id: string;
  tenantId: string;
  /** The connection whose capture produced this meeting. */
  connectionId: string;
  provider: MeetingProvider;
  /** The provider's own stable meeting id (opaque). */
  providerMeetingId: string;
  title: string | null;
  agenda: string | null;
  /** ISO 8601 — scheduled start (provider metadata; null when unknown). */
  scheduledStartAt: string | null;
  /** ISO 8601 — scheduled end (provider metadata; null when unknown). */
  scheduledEndAt: string | null;
  /** The host's participant registry id (null until the provider names a host). */
  hostParticipantId: string | null;
  /**
   * Neutral platform key for the platform the meeting actually happened
   * on, when the capture path can say (native adapters report their own
   * platform; the meeting-bot adapter reports the platform its bot
   * attended). Free-form neutral string — a bot adapter may attend
   * platforms outside the native vocabulary.
   */
  underlyingPlatform: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListMeetingsQuery {
  provider?: MeetingProvider;
  connectionId?: string;
  /** Inclusive lower bound on scheduled start — strict ISO 8601. */
  scheduledFrom?: string;
  /** Inclusive upper bound on scheduled start — strict ISO 8601. */
  scheduledTo?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * One occurrence of a meeting: the unit transcripts and artifacts attach
 * to. `participants` is the LATEST attendance state the provider
 * delivered (registry ids + the display facets captured with it); every
 * delivered attendance is preserved in the session observations. W086
 * builds its realtime sessions on this contract.
 */
export interface MeetingSession {
  id: string;
  tenantId: string;
  meetingId: string;
  /** The provider's own stable occurrence id (opaque). */
  providerSessionId: string;
  status: MeetingSessionStatus;
  title: string | null;
  /** ISO 8601 — actual start (null while scheduled/unknown). */
  startedAt: string | null;
  /** ISO 8601 — actual end (null until ended/unknown). */
  endedAt: string | null;
  participants: SessionParticipant[];
  createdAt: string;
  updatedAt: string;
}

/** A participant's attendance as persisted on the session (latest state). */
export interface SessionParticipant {
  /** The participant registry id. */
  participantId: string;
  providerParticipantId: string;
  displayName: string | null;
  email: string | null;
  joinedAt: string | null;
  leftAt: string | null;
}

export interface ListMeetingSessionsQuery {
  meetingId?: string;
  status?: MeetingSessionStatus;
  /** Inclusive lower bound on actual start — strict ISO 8601. */
  startedFrom?: string;
  /** Inclusive upper bound on actual start — strict ISO 8601. */
  startedTo?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** One attributed stretch of speech, canonically. */
export interface TranscriptSegment {
  /** The speaker's participant registry id (null when the provider could not attribute). */
  participantId: string | null;
  /** The provider-reported speaker label when unattributed (display only). */
  speakerName: string | null;
  /** ISO 8601 — when the segment started. */
  startedAt: string;
  /** ISO 8601 — when the segment ended (null = provider did not say). */
  endedAt: string | null;
  text: string;
  /** Inclusive [0, 1] — the provider's ASR confidence (null = not reported). */
  confidence: number | null;
}

/**
 * The canonical transcript of one session, delivered by a provider (or a
 * meeting bot). Append-only capture evidence: a provider-side revision is
 * a NEW provider transcript id and therefore a new row — both are
 * retained (the lock 12 spirit: contradictory or corrected captures are
 * never silently merged). The immutable observation (kind
 * `meeting.transcript`) preserves exactly what was delivered.
 */
export interface MeetingTranscript {
  id: string;
  tenantId: string;
  sessionId: string;
  /** The provider's own stable transcript id (opaque). */
  providerTranscriptId: string;
  /** BCP-47-style language tag as the provider reported it (null = unknown). */
  language: string | null;
  segments: TranscriptSegment[];
  /** The observation this transcript was recorded as (W004 evidence). */
  evidenceObservationId: string;
  capturedVia: MeetingIngestionVia;
  /** ISO 8601 — when Aurum committed the capture (service clock). */
  capturedAt: string;
}

export interface ListMeetingTranscriptsQuery {
  sessionId: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * One durable artifact of a session (a recording, the in-meeting chat
 * export, a provider summary, a shared document…). Append-only capture
 * evidence. `storageRef` is an OPAQUE reference to where the artifact
 * content can be materialized (a blob-store reference once content has
 * been persisted — W086 owns durable artifact storage — or the capture
 * path's provider-side materialization key). It is NEVER a raw provider
 * URL: provider URLs carry scoped tokens (a credential) and must not
 * reach domain tables (IMPLEMENTATION-STACK §8).
 */
export interface MeetingArtifact {
  id: string;
  tenantId: string;
  sessionId: string;
  kind: MeetingArtifactKind;
  /** The provider's own stable artifact id (opaque). */
  providerArtifactId: string;
  displayName: string | null;
  /** MIME type as the provider reported it (e.g. `video/mp4`). */
  mediaType: string | null;
  byteSize: number | null;
  /** Opaque storage reference (never a raw provider URL). */
  storageRef: string | null;
  /** Content checksum as the provider reported it (opaque string). */
  checksum: string | null;
  /** The observation this artifact was recorded as (W004 evidence). */
  evidenceObservationId: string;
  capturedVia: MeetingIngestionVia;
  /** ISO 8601 — when Aurum committed the capture (service clock). */
  capturedAt: string;
}

export interface ListMeetingArtifactsQuery {
  sessionId: string;
  kind?: MeetingArtifactKind;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Access events (failed/expired access is explicit)
// ---------------------------------------------------------------------------

/**
 * One explicit failed/expired-access record (W085 acceptance). Append-only.
 * Access failures are also preserved as observations (kind
 * `meeting.access`) so the evidence model explains why intelligence for a
 * meeting is missing — a gap is never silent.
 */
export interface MeetingAccessEvent {
  id: string;
  tenantId: string;
  connectionId: string;
  provider: MeetingProvider;
  /** The meeting the access failure concerns (null when connection-wide). */
  providerMeetingId: string | null;
  code: MeetingAccessCode;
  detail: string | null;
  /** ISO 8601 — when the access failed per the provider/transport clock. */
  occurredAt: string;
  /** ISO 8601 — when Aurum committed the event (service clock). */
  createdAt: string;
}

export interface ListMeetingAccessEventsQuery {
  connectionId?: string;
  code?: MeetingAccessCode;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Canonical records (adapter output — provider-neutral)
// ---------------------------------------------------------------------------

/**
 * One provider record, normalized by the provider's PRIVATE adapter (or
 * re-emitted by the wired transport): the unit of meeting capture. Each
 * becomes exactly one immutable observation (through the observations
 * contract) and updates the canonical registry.
 *
 * `providerRecordId` is the provider's own stable id for the delivered
 * record — the dedupe key on the ingestion ledger. State-transition
 * deliveries (a session that starts, then ends) are DISTINCT records with
 * distinct ids; redelivering the same record (webhook retries, poll
 * re-fetches of the same window) produces the same id and is suppressed.
 */
export type CanonicalMeetingRecord =
  | MeetingUpdatedRecord
  | SessionUpdatedRecord
  | TranscriptAvailableRecord
  | ArtifactAvailableRecord
  | AccessFailedRecord;

/** The meeting's metadata was created or revised. */
export interface MeetingUpdatedRecord {
  kind: 'meeting.updated';
  providerRecordId: string;
  /** ISO 8601 — the provider's event time. */
  occurredAt: string;
  providerMeetingId: string;
  title: string | null;
  agenda: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  underlyingPlatform: string | null;
  host: CanonicalParticipant | null;
}

/** A session (occurrence) reached a new state. */
export interface SessionUpdatedRecord {
  kind: 'session.updated';
  providerRecordId: string;
  occurredAt: string;
  providerMeetingId: string;
  providerSessionId: string;
  status: MeetingSessionStatus;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  participants: CanonicalParticipantAttendance[];
}

/** A transcript became available for one session. */
export interface TranscriptAvailableRecord {
  kind: 'transcript.available';
  providerRecordId: string;
  occurredAt: string;
  providerMeetingId: string;
  providerSessionId: string;
  providerTranscriptId: string;
  language: string | null;
  segments: CanonicalTranscriptSegment[];
}

/** A session artifact became available. */
export interface ArtifactAvailableRecord {
  kind: 'artifact.available';
  providerRecordId: string;
  occurredAt: string;
  providerMeetingId: string;
  providerSessionId: string;
  providerArtifactId: string;
  artifactKind: MeetingArtifactKind;
  displayName: string | null;
  mediaType: string | null;
  byteSize: number | null;
  storageRef: string | null;
  checksum: string | null;
}

/** Access to a meeting/session/resource failed or expired. */
export interface AccessFailedRecord {
  kind: 'access.failed';
  providerRecordId: string;
  occurredAt: string;
  providerMeetingId: string | null;
  accessCode: MeetingAccessCode;
  detail: string | null;
}

/** A transcript segment as the adapter normalized it (pre-registry). */
export interface CanonicalTranscriptSegment {
  providerParticipantId: string | null;
  speakerName: string | null;
  startedAt: string;
  endedAt: string | null;
  text: string;
  confidence: number | null;
}

// ---------------------------------------------------------------------------
// Ingestion results
// ---------------------------------------------------------------------------

/** The ledger link proving what evidence one captured record became. */
export interface IngestedRecord {
  providerRecordId: string;
  /** The observation recorded for this provider record (W004 evidence). */
  observationId: string;
}

/** Result of `receiveMeetingWebhook`. */
export interface WebhookResult {
  connection: MeetingConnection;
  /** Records the provider's webhook delivered. */
  fetched: number;
  /** Records that became NEW observations. */
  ingested: number;
  /** Records suppressed by the dedupe ledger (already ingested). */
  duplicates: number;
  records: IngestedRecord[];
}

/**
 * Input of `receiveMeetingWebhook` — the provider webhook edge. `payload`
 * is the raw provider-native JSON envelope as it arrived; it is parsed by
 * the provider's adapter INSIDE this module and never crosses back out.
 */
export interface ReceiveMeetingWebhookInput {
  provider: MeetingProvider;
  payload: unknown;
}

export interface PollMeetingConnectionInput {
  connectionId: string;
  /** 1..200, default 50. */
  maxRecords?: number;
}

/** Result of `pollMeetingConnection`. */
export interface PollResult {
  connection: MeetingConnection;
  /** Records the transport returned for this window. */
  fetched: number;
  /** Records that became NEW observations. */
  ingested: number;
  /** Records suppressed by the dedupe ledger (already ingested). */
  duplicates: number;
  records: IngestedRecord[];
  /** Whether the provider reports more data past this window. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Fetch port (provider-neutral polling; implementations are module-internal)
// ---------------------------------------------------------------------------

/** The provider-neutral fetch request handed to the transport. */
export interface MeetingFetchRequest {
  provider: MeetingProvider;
  tenantId: string;
  connectionId: string;
  /** Canonical, adapter-normalized account id (opaque). */
  providerAccountId: string;
  /** Opaque secret-store reference — the transport resolves credentials. */
  credentialRef: string;
  /** Resume point; null = fetch from the beginning of the provider's window. */
  cursor: string | null;
  maxRecords: number;
}

/**
 * The provider-neutral outcome of one fetch. `nextCursor` null means the
 * provider has no further data (an exhausted window); `hasMore` reports
 * whether more data exists past this batch. `authorizationExpiresAt` is
 * how a transport that REFRESHED an OAuth grant reports the new expiry
 * (non-secret authorization state; the service records it on the
 * connection).
 */
export interface MeetingFetchResult {
  records: CanonicalMeetingRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  authorizationExpiresAt?: string | null;
}

/**
 * The polling port real transports implement. Transports that touch
 * provider SDKs/HTTP must live inside `src/modules/meetings/adapters/`
 * (IMPLEMENTATION-STACK §6 provider isolation); they are wired at process
 * start via `setMeetingTransport`. No transport is wired by default —
 * polls then fail explicitly with `provider_unavailable`.
 */
export interface MeetingTransport {
  fetch(request: MeetingFetchRequest): Promise<MeetingFetchResult>;
}
