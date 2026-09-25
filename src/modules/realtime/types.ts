// Public domain types of the realtime module (W086 — Realtime Voice and
// Meeting Companion).
//
// W086 owns the REALTIME layer of the meeting/voice product surface:
// "provider-neutral realtime session contracts with a replaceable LiveKit
// adapter for Aurum voice, two-way meeting participation, Meeting Companion
// and telephony/SIP" (WORK-ITEM-CATALOG). One provider-neutral REALTIME
// SESSION abstraction serves the four product modes:
//
//   * `aurum_voice`          — a live two-way voice conversation between
//                               one person and Aurum itself;
//   * `meeting_participation` — a realtime room Aurum hosts/joins so it can
//                               listen AND speak during a meeting;
//   * `meeting_companion`     — an in-person meeting captured through an
//                               approved companion device (phone/tablet/
//                               laptop) with explicit participation and
//                               recording state (plan §7 workstream D);
//   * `telephony`            — a session whose audio path is the PSTN: a
//                               participant is reached by SIP dial-out (or
//                               dials in) and needs neither Internet nor an
//                               Aurum account.
//
// The realtime session is EPHEMERAL MEDIA over DURABLE STATE: every fact
// that outlives a worker process — the session record, participants,
// consent trail, live transcript turns, spoken-response lifecycle, durable
// artifacts — is a PostgreSQL row (lock 35; handoff §4.5 "worker/process
// death must not destroy Aurum state"). The live media itself (audio
// frames, interim ASR, in-flight playback) belongs to the transport
// provider and never enters the domain.
//
// Everything here is provider-neutral BY CONSTRUCTION (lock 16 /
// MODULE-DEPENDENCY-MAP provider boundaries; IMPLEMENTATION-STACK §6):
// realtime transport providers appear only as the canonical
// `RealtimeProvider` key owned by this module's validation vocabulary;
// provider-native envelopes, room objects, participant shapes, transcript
// formats and recording descriptors are parsed inside `adapters/` and
// never leave this module in their raw shape. The only provider-minted
// values that cross the boundary are OPAQUE strings (account ids, room
// ids, participant ids, event ids, artifact ids) — the discipline the
// meetings module applies to provider capture records.
//
// Credential isolation (GOVERNANCE mandatory invariant; IMPLEMENTATION-
// STACK §8): `credentialRef` is an OPAQUE reference into the secret store.
// API keys, OAuth tokens and join grants never reach a domain table, a
// log line or a persisted contract result. Join grants returned by
// `createRealtimeJoinGrant` are EPHEMERAL credentials handed to the
// joining client and are persisted nowhere (documented on the type).

// ---------------------------------------------------------------------------
// Provider vocabulary
// ---------------------------------------------------------------------------

/**
 * Canonical realtime transport providers (mirrored by the migration
 * CHECKs and the adapter registry). `livekit` is the P0 transport the
 * plan names; `openai-realtime` is the P1 alternative the technology
 * research lists — the second conforming provider that keeps the
 * transport swappable without domain rewrite (W086 acceptance).
 */
export type RealtimeProvider = 'livekit' | 'openai-realtime';

/** The four product modes one realtime session can serve. */
export type RealtimeSessionKind =
  | 'aurum_voice' // one person talking with Aurum
  | 'meeting_participation' // Aurum listens and speaks in a meeting
  | 'meeting_companion' // in-person meeting via a companion device
  | 'telephony'; // PSTN audio path (SIP dial-out / dial-in)

/**
 * The session lifecycle: `requested` (durable start intent recorded, the
 * room is being materialized), `live` (the room is up), terminal `ended`
 * (stopped by caller, provider, or the last participant leaving) and
 * `failed` (terminal failure — explicit, never silent).
 */
export type RealtimeSessionStatus = 'requested' | 'live' | 'ended' | 'failed';

/** Why an `ended` session ended (failed sessions carry `errorCode`). */
export type RealtimeEndedReason =
  | 'caller_stopped' // a caller invoked stopRealtimeSession
  | 'provider_ended' // the transport reported the room finished
  | 'last_participant_left'; // every non-Aurum participant left

/**
 * The explicit recording state of a session (W086 acceptance:
 * "consent/recording state"). `off` (never recorded), `recording` (a
 * consent-authorized recording is running), `recorded` (recording
 * happened and stopped — a recording artifact may exist).
 */
export type RealtimeRecordingState = 'off' | 'recording' | 'recorded';

/** Explicit failure classification of a `failed` session. */
export type RealtimeFailureCode =
  | 'provider_unavailable' // no transport wired for the provider
  | 'transport_failed' // the transport refused/failed the operation
  | 'dial_failed' // the SIP dial-out could not be placed
  | 'room_unavailable' // the provider could not materialize the room
  | 'agent_disconnected' // Aurum's own agent lost its media connection
  | 'provider_error'; // the provider reported an unclassified failure

/** How a participant's audio reaches the room. */
export type RealtimeParticipantRole =
  | 'human' // ordinary realtime client
  | 'aurum' // Aurum's own agent participant (exactly one per session)
  | 'phone'; // PSTN audio path (SIP dialed in or out)

/**
 * A participant's standing consent to being recorded. `pending` until the
 * participant grants; `revoked` records an explicit withdrawal (which
 * stops a running recording — see the service). Aurum's own participant
 * never consents (it IS Aurum); the consent gate ignores it.
 */
export type RealtimeConsentState = 'pending' | 'granted' | 'revoked';

// ---------------------------------------------------------------------------
// Connections (tenant-owned realtime transport accounts)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped realtime transport account: one authorized provider
 * project (a LiveKit project, an OpenAI Realtime project…) whose rooms
 * this tenant's realtime sessions run on (ARCHITECTURE.md §3: tenants own
 * their provider accounts).
 *
 * `credentialRef` is an OPAQUE secret-store reference; the credential
 * value never reaches any domain table (IMPLEMENTATION-STACK §8). OAuth
 * metadata (`oauthScopes`, `oauthExpiresAt`) is non-secret authorization
 * state; it is incoherent (and rejected) for `api_key` connections.
 */
export interface RealtimeConnection {
  id: string;
  tenantId: string;
  provider: RealtimeProvider;
  /** Canonical, adapter-normalized account id (opaque string). */
  providerAccountId: string;
  displayName: string | null;
  authKind: RealtimeAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted OAuth scopes (oauth connections only; empty otherwise). */
  oauthScopes: string[];
  /** When the OAuth grant lapses (oauth connections only; null = non-expiring). */
  oauthExpiresAt: string | null;
  status: RealtimeConnectionStatus;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on status/authorization changes only. */
  updatedAt: string;
}

export type RealtimeAuthKind = 'api_key' | 'oauth';
export type RealtimeConnectionStatus = 'active' | 'disabled';

export interface RegisterRealtimeConnectionInput {
  provider: RealtimeProvider;
  /** Raw provider account id; normalized by the provider's adapter. */
  providerAccountId: string;
  displayName?: string | null;
  authKind: RealtimeAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted scopes; required to be empty for `api_key` connections. */
  oauthScopes?: string[];
  /** Grant expiry (strict ISO 8601); required to be null for `api_key` connections. */
  oauthExpiresAt?: string | null;
}

/**
 * Result of `registerRealtimeConnection`. Re-registering an EXISTING
 * connection is the re-authorization path: it updates the authorization
 * fields (auth kind, credential reference, scopes, expiry) and reports
 * `created: false` — the endpoint's identity never changes (the meetings
 * module's connection discipline).
 */
export interface RegisterRealtimeConnectionResult {
  connection: RealtimeConnection;
  created: boolean;
}

export interface ListRealtimeConnectionsQuery {
  provider?: RealtimeProvider;
  status?: RealtimeConnectionStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetRealtimeConnectionStatusInput {
  connectionId: string;
  status: RealtimeConnectionStatus;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * One realtime session: a provider room lifecycle plus the durable
 * canonical state W086 owns. A CAPTURE/REGISTRY row holding the CURRENT
 * session state; the append-only evidence trail lives in the realtime
 * event ledger (`realtime_events` — every canonical event applied) and
 * the session-close observation recorded by the finalization workflow
 * through the observations contract (W004).
 *
 * `meetingSessionId` is an OPAQUE reference to the meetings module's
 * canonical session (W085) this realtime session participates in or
 * companions — validated readable through that module's contract at
 * start, never a foreign key (cross-module, house pattern). In-person
 * companion sessions may have none.
 */
export interface RealtimeSession {
  id: string;
  tenantId: string;
  connectionId: string;
  provider: RealtimeProvider;
  kind: RealtimeSessionKind;
  status: RealtimeSessionStatus;
  title: string | null;
  /** Opaque reference to the meetings module's session (validated, no FK). */
  meetingSessionId: string | null;
  /** The provider's own room id (opaque; set once the room is live). */
  providerRoomId: string | null;
  recordingState: RealtimeRecordingState;
  endedReason: RealtimeEndedReason | null;
  errorCode: RealtimeFailureCode | null;
  errorDetail: string | null;
  /** True once the session ended/failed with finalization still to ensure. */
  finalizePending: boolean;
  /** The durable finalization workflow run (W080), once ensured. */
  finalizeRunId: string | null;
  /** The session-close observation (W004 evidence), once recorded. */
  evidenceObservationId: string | null;
  createdBy: string;
  /** ISO 8601 — when the room went live (null while `requested`/failed start). */
  startedAt: string | null;
  /** ISO 8601 — when the session reached a terminal state. */
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartRealtimeSessionInput {
  connectionId: string;
  kind: RealtimeSessionKind;
  title?: string | null;
  /**
   * Opaque reference to the meetings module's canonical session (W085)
   * this participation/companion session belongs to; validated readable
   * through that module's contract. Required-null for `aurum_voice` and
   * `telephony` (no meeting is involved).
   */
  meetingSessionId?: string | null;
  /**
   * SIP dial-out target — required for kind `telephony` (the session
   * exists to reach this number), forbidden for other kinds (a phone
   * participant can still be dialed into a live session afterwards via
   * `dialRealtimeParticipant`).
   */
  dial?: { phoneNumber: string; displayName?: string | null } | null;
}

export interface RealtimeSessionStartResult {
  session: RealtimeSession;
}

export interface StopRealtimeSessionInput {
  sessionId: string;
}

/**
 * Result of `stopRealtimeSession`. The finalization workflow run is the
 * durable artifact materializer (W080 dependency): the session is ended
 * synchronously; the transcript artifact and session-close observation
 * are produced by the run the caller (or the recovery pump) advances.
 */
export interface RealtimeSessionStopResult {
  session: RealtimeSession;
  /** The finalization workflow run id (existing runs replay — idempotent). */
  finalizeRunId: string | null;
}

export interface ListRealtimeSessionsQuery {
  connectionId?: string;
  kind?: RealtimeSessionKind;
  status?: RealtimeSessionStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/**
 * One participant of one realtime session, canonically. Provider-minted
 * participant identity (`providerParticipantId`, opaque), captured on
 * sight (get-or-create), with the display facets the transport reported.
 *
 * `subjectId` records the organizational person resolved through the
 * identity module's VERIFIED, subject-linked email identities (W002) —
 * the read-only bridge the meetings module also applies; full
 * cross-modality unification is W095's declared job.
 */
export interface RealtimeParticipant {
  id: string;
  tenantId: string;
  sessionId: string;
  /** Canonical, adapter-normalized participant id (opaque). */
  providerParticipantId: string;
  role: RealtimeParticipantRole;
  displayName: string | null;
  email: string | null;
  /** E.164 phone number (role `phone` only). */
  phone: string | null;
  /** Opaque reference to the resolved organizational person, when the verified-email bridge resolved. */
  subjectId: string | null;
  resolvedVia: 'verified_email_identity' | null;
  consent: RealtimeConsentState;
  /** ISO 8601 — latest join (null until the participant joined). */
  joinedAt: string | null;
  /** ISO 8601 — latest leave (null while in the room / never joined). */
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListRealtimeParticipantsQuery {
  sessionId?: string;
  role?: RealtimeParticipantRole;
  /** 1..500, default 50. */
  limit?: number;
}

/** The domain consent path (companion UI / authenticated client). */
export interface RecordRealtimeConsentInput {
  sessionId: string;
  participantId: string;
  consent: 'granted' | 'revoked';
}

// ---------------------------------------------------------------------------
// Recording control
// ---------------------------------------------------------------------------

export interface RealtimeRecordingInput {
  sessionId: string;
}

/** Result of `stopRealtimeRecording` (the recording artifact, when the provider produced one). */
export interface RealtimeRecordingStopResult {
  session: RealtimeSession;
  artifact: RealtimeArtifact | null;
}

// ---------------------------------------------------------------------------
// Live transcript turns
// ---------------------------------------------------------------------------

/**
 * One finalized stretch of speech in the live transcript, with speaker
 * attribution. Human turns are produced by `transcript.final` canonical
 * events (the adapter normalizes provider interim ASR away — only
 * finalized speech is canonical); Aurum turns are produced when a spoken
 * response is accepted by the transport.
 *
 * Append-only capture evidence: turns are never updated or deleted
 * (storage-enforced). An interrupted Aurum response keeps its full
 * intended text here; the interruption itself is recorded on the
 * response lifecycle row and in the event ledger.
 */
export interface RealtimeTurn {
  id: string;
  tenantId: string;
  sessionId: string;
  /** 1-based per-session ordering of turn commits. */
  turnNo: number;
  kind: 'human_speech' | 'aurum_response';
  /** The speaker's participant registry id (null when unattributable). */
  speakerParticipantId: string | null;
  /** The transport-reported speaker label when unattributed (display only). */
  speakerName: string | null;
  text: string;
  /** Inclusive [0, 1] — the transport's ASR confidence (null = not reported). */
  confidence: number | null;
  /** Aurum turns: the spoken-response lifecycle row. */
  responseId: string | null;
  /** Human turns: the canonical event that produced them. */
  eventId: string | null;
  /** ISO 8601 — when the speech started (provider clock / speak time). */
  startedAt: string;
  /** ISO 8601 — when the speech ended (null = not reported). */
  endedAt: string | null;
  createdAt: string;
}

export interface ListRealtimeTurnsQuery {
  sessionId: string;
  kind?: 'human_speech' | 'aurum_response';
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Spoken Aurum responses
// ---------------------------------------------------------------------------

/**
 * The lifecycle of ONE spoken Aurum response: accepted by the transport
 * (`speaking`), then completed, interrupted (barge-in — W086 acceptance
 * "interruption handling") or failed. The spoken TEXT itself is the
 * linked aurum turn; this row carries what happened to it.
 */
export interface RealtimeResponse {
  id: string;
  tenantId: string;
  sessionId: string;
  /** The transcript turn this response spoke (null if the transport never accepted it). */
  turnId: string | null;
  /** The human turn this response replies to (null = unprompted). */
  requestTurnId: string | null;
  text: string;
  status: 'speaking' | 'completed' | 'interrupted' | 'failed';
  /** The participant whose speech cut this response short. */
  interruptedByParticipantId: string | null;
  errorDetail: string | null;
  /** ISO 8601 — when the transport accepted the speak. */
  startedAt: string;
  /** ISO 8601 — when playback completed. */
  completedAt: string | null;
  /** ISO 8601 — when playback was interrupted. */
  interruptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpeakRealtimeResponseInput {
  sessionId: string;
  /** What Aurum says (1..8000 chars). */
  text: string;
  /** The human turn this response replies to (optional attribution). */
  inReplyToTurnId?: string | null;
}

export interface ListRealtimeResponsesQuery {
  sessionId: string;
  status?: RealtimeResponse['status'];
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Telephony (SIP dial-out)
// ---------------------------------------------------------------------------

export interface DialRealtimeParticipantInput {
  sessionId: string;
  /** E.164 phone number to dial. */
  phoneNumber: string;
  displayName?: string | null;
}

// ---------------------------------------------------------------------------
// Artifacts (durable meeting artifacts — W086 acceptance)
// ---------------------------------------------------------------------------

/**
 * One durable artifact of a realtime session. The TRANSCRIPT artifact is
 * materialized by the finalization workflow into the object-storage port
 * (a JSON document of the session's canonical state; `storageRef` is the
 * blob URL — W086 owns durable artifact storage, per the meetings
 * module's artifact contract). RECORDING artifacts carry the provider's
 * opaque materialization reference (never a raw provider URL with scoped
 * tokens).
 */
export interface RealtimeArtifact {
  id: string;
  tenantId: string;
  sessionId: string;
  kind: 'transcript' | 'recording';
  /** `transcript` for domain-materialized artifacts; null for provider artifacts. */
  domainKey: string | null;
  /** The provider's own stable artifact id (opaque; recording artifacts). */
  providerArtifactId: string | null;
  displayName: string | null;
  /** MIME type (e.g. `application/json`, `audio/ogg`). */
  mediaType: string | null;
  byteSize: number | null;
  /** Opaque storage reference (blob URL / provider materialization key). */
  storageRef: string;
  /** Content checksum (opaque string). */
  checksum: string | null;
  createdAt: string;
}

export interface ListRealtimeArtifactsQuery {
  sessionId: string;
  kind?: 'transcript' | 'recording';
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Canonical realtime events (adapter output — provider-neutral)
// ---------------------------------------------------------------------------

/** The closed canonical event vocabulary (mirrored by migration CHECKs). */
export type RealtimeEventKind =
  | 'session.started' // the provider room went live
  | 'session.ended' // the provider finished the room
  | 'session.failed' // a terminal provider failure
  | 'participant.joined'
  | 'participant.left'
  | 'consent.granted' // e.g. DTMF/verbal telephony consent
  | 'consent.revoked'
  | 'transcript.final' // one finalized attributed stretch of speech
  | 'response.completed' // a spoken Aurum response finished playing
  | 'response.interrupted' // barge-in cut a spoken response short
  | 'recording.started' // provider confirmation of a domain-started recording
  | 'recording.stopped' // provider recording stop (may carry the artifact)
  | 'recording.blocked'; // a recording start the consent gate refused

/** How the event entered the ledger: the provider transport, or a domain operation. */
export type RealtimeEventSource = 'provider' | 'domain';

/**
 * One canonical realtime event as the provider's PRIVATE adapter
 * normalized it (pre-registry). `providerEventId` is the provider's own
 * stable id for the delivered event — the dedupe key: redelivering the
 * same envelope produces the same id and is suppressed; distinct provider
 * events are distinct records.
 */
export type CanonicalRealtimeEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | SessionFailedEvent
  | ParticipantJoinedEvent
  | ParticipantLeftEvent
  | ConsentGrantedEvent
  | ConsentRevokedEvent
  | TranscriptFinalEvent
  | ResponseCompletedEvent
  | ResponseInterruptedEvent
  | RecordingStartedEvent
  | RecordingStoppedEvent;

interface CanonicalEventBase {
  /** The provider's own stable event id (opaque, the dedupe key). */
  providerEventId: string;
  /** ISO 8601 — the provider's event time. */
  occurredAt: string;
  /** The provider's room reference (opaque; resolves the session). */
  providerRoomId: string;
}

export interface SessionStartedEvent extends CanonicalEventBase {
  kind: 'session.started';
}

export interface SessionEndedEvent extends CanonicalEventBase {
  kind: 'session.ended';
  /** Canonicalized provider end classification. */
  reason: 'provider_ended';
  /** ISO 8601 — when the room finished per the provider. */
  endedAt: string;
}

export interface SessionFailedEvent extends CanonicalEventBase {
  kind: 'session.failed';
  code: RealtimeFailureCode;
  detail: string | null;
}

export interface ParticipantJoinedEvent extends CanonicalEventBase {
  kind: 'participant.joined';
  providerParticipantId: string;
  displayName: string | null;
  email: string | null;
  /** E.164 number when the participant is on the PSTN path. */
  phone: string | null;
  /** ISO 8601 — when the participant joined. */
  joinedAt: string;
}

export interface ParticipantLeftEvent extends CanonicalEventBase {
  kind: 'participant.left';
  providerParticipantId: string;
  /** ISO 8601 — when the participant left. */
  leftAt: string;
}

export interface ConsentGrantedEvent extends CanonicalEventBase {
  kind: 'consent.granted';
  providerParticipantId: string;
}

export interface ConsentRevokedEvent extends CanonicalEventBase {
  kind: 'consent.revoked';
  providerParticipantId: string;
}

/** One finalized attributed stretch of human speech (the live transcript). */
export interface TranscriptFinalEvent extends CanonicalEventBase {
  kind: 'transcript.final';
  /** The speaker's provider participant id (null = the provider could not attribute). */
  providerParticipantId: string | null;
  /** The provider-reported speaker label when unattributed (display only). */
  speakerName: string | null;
  startedAt: string;
  endedAt: string | null;
  text: string;
  /** Inclusive [0, 1] — the transport's ASR confidence (null = not reported). */
  confidence: number | null;
}

export interface ResponseCompletedEvent extends CanonicalEventBase {
  kind: 'response.completed';
  /** The domain-minted response id the speak operation passed to the transport. */
  responseId: string;
  /** ISO 8601 — when playback completed. */
  completedAt: string;
}

export interface ResponseInterruptedEvent extends CanonicalEventBase {
  kind: 'response.interrupted';
  /** The domain-minted response id that was cut short. */
  responseId: string;
  /** The participant whose speech barged in (null when the provider could not attribute). */
  interruptingProviderParticipantId: string | null;
  /** ISO 8601 — when the interruption happened. */
  interruptedAt: string;
}

export interface RecordingStartedEvent extends CanonicalEventBase {
  kind: 'recording.started';
}

/**
 * The provider stopped recording — carries the provider's recording
 * artifact reference when it produced one (opaque materialization key,
 * never a raw scoped URL).
 */
export interface RecordingStoppedEvent extends CanonicalEventBase {
  kind: 'recording.stopped';
  artifact: {
    providerArtifactId: string;
    storageRef: string | null;
    mediaType: string | null;
    byteSize: number | null;
    checksum: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// The event ledger (canonical trail)
// ---------------------------------------------------------------------------

/**
 * One applied canonical realtime event: the append-only trail of
 * everything that happened in a session — the provider events the ledger
 * dedupes (UNIQUE per session + provider event id) and the domain events
 * the module's own operations record (consent decisions, recording
 * control, blocked recording attempts). This IS the explicit
 * consent/recording state history (W086 acceptance).
 */
export interface RealtimeEventRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  source: RealtimeEventSource;
  kind: RealtimeEventKind;
  /** The provider's event id (null for domain events). */
  providerEventId: string | null;
  /** The participant registry row this event concerns, when one. */
  participantId: string | null;
  /** Canonical event facets (speaker label, artifact info, failure detail…). */
  detail: Record<string, unknown>;
  /** ISO 8601 — when the event occurred (provider clock / service clock). */
  occurredAt: string;
  createdAt: string;
}

export interface ListRealtimeEventsQuery {
  sessionId: string;
  kind?: RealtimeEventKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Result of `receiveRealtimeEvent`. */
export interface RealtimeEventResult {
  connection: RealtimeConnection;
  /** Canonical events the envelope carried. */
  received: number;
  /** Events applied to the session registry (fresh). */
  applied: number;
  /** Events suppressed by the dedupe ledger (already applied). */
  duplicates: number;
}

/** Input of `receiveRealtimeEvent` — the provider event edge. */
export interface ReceiveRealtimeEventInput {
  provider: RealtimeProvider;
  /** Raw provider-native envelope; parsed by the provider's PRIVATE adapter inside this module. */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// The transport port (provider-neutral; implementations are module-internal)
// ---------------------------------------------------------------------------

/** Credentials-free request facets every transport call carries. */
export interface RealtimeTransportCall {
  provider: RealtimeProvider;
  tenantId: string;
  connectionId: string;
  /** Canonical, adapter-normalized account id (opaque). */
  providerAccountId: string;
  /** Opaque secret-store reference — the transport resolves credentials. */
  credentialRef: string;
  sessionId: string;
}

export interface RealtimeRoomStartRequest extends RealtimeTransportCall {
  kind: RealtimeSessionKind;
  /** The identity Aurum's agent joins under (adapter-minted, stable). */
  agentParticipantId: string;
  title: string | null;
}

/** The persisted-safe room handle a transport returns (no credentials). */
export interface RealtimeRoomHandle {
  /** The provider's own room id (opaque). */
  providerRoomId: string;
  /** The identity the agent joined under (echoed for confirmation). */
  agentParticipantId: string;
}

export interface RealtimeRoomStopRequest extends RealtimeTransportCall {
  providerRoomId: string;
}

export interface RealtimeSpeakRequest extends RealtimeTransportCall {
  providerRoomId: string;
  /** The domain-minted response id — the transport's idempotency key for this speak. */
  responseId: string;
  agentParticipantId: string;
  text: string;
}

export interface RealtimeRecordingRequest extends RealtimeTransportCall {
  providerRoomId: string;
}

/** The provider's recording artifact descriptor (opaque references). */
export interface RealtimeRecordingArtifactInfo {
  providerArtifactId: string;
  storageRef: string | null;
  mediaType: string | null;
  byteSize: number | null;
  checksum: string | null;
}

export interface RealtimeDialRequest extends RealtimeTransportCall {
  providerRoomId: string;
  phoneNumber: string;
  displayName: string | null;
}

export interface RealtimeDialResult {
  /** The provider's participant id for the dialed party (opaque). */
  providerParticipantId: string;
}

export interface RealtimeJoinGrantRequest extends RealtimeTransportCall {
  providerRoomId: string;
  /** Optional identity hint for the joining client. */
  displayName: string | null;
}

/**
 * An EPHEMERAL join credential minted by the transport for one client.
 * This is the one credential-shaped value the contract RETURNS — by
 * design: the caller hands it to the joining client immediately. It is
 * NEVER persisted by this module (no domain table, no event, no
 * observation ever carries `token` or `url`; tests assert this).
 */
export interface RealtimeJoinGrant {
  url: string;
  token: string;
  /** ISO 8601 — when the grant lapses. */
  expiresAt: string;
}

/**
 * The provider-neutral realtime transport port. Implementations that
 * touch provider SDKs/HTTP must live inside `src/modules/realtime/
 * adapters/` (IMPLEMENTATION-STACK §6 provider isolation); they are
 * wired at process start via `setRealtimeTransport`. No transport is
 * wired by default — session starts then fail explicitly with
 * `provider_unavailable` (the meetings/channels discipline).
 */
export interface RealtimeTransport {
  readonly provider: RealtimeProvider;
  startRoom(request: RealtimeRoomStartRequest): Promise<RealtimeRoomHandle>;
  stopRoom(request: RealtimeRoomStopRequest): Promise<void>;
  speak(request: RealtimeSpeakRequest): Promise<void>;
  startRecording(request: RealtimeRecordingRequest): Promise<void>;
  stopRecording(
    request: RealtimeRecordingRequest,
  ): Promise<{ artifact: RealtimeRecordingArtifactInfo | null }>;
  dial(request: RealtimeDialRequest): Promise<RealtimeDialResult>;
  createJoinGrant(request: RealtimeJoinGrantRequest): Promise<RealtimeJoinGrant>;
}

// ---------------------------------------------------------------------------
// Finalization pump (the W080 recovery seam)
// ---------------------------------------------------------------------------

/** The disposition of one `pumpRealtimeFinalization` call. */
export interface RealtimeFinalizationPumpOutcome {
  status:
    | 'idle' // nothing pending for this tenant
    | 'ensured' // a pending finalization run was started or idempotently replayed
    | 'failed'; // starting the run failed (detail says why; the pump retries)
  sessionId: string | null;
  runId: string | null;
  detail: string;
}
