// ============================================================================
// realtime — the ONLY public surface of the realtime module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W086 — Realtime Voice and Meeting Companion:
// "Implement provider-neutral realtime session contracts with a
//  replaceable LiveKit adapter for Aurum voice, two-way meeting
//  participation, Meeting Companion and telephony/SIP."
//
//   registerRealtimeConnection — register (or RE-AUTHORIZE) one
//      tenant-owned realtime transport account per provider project (a
//      LiveKit project, an OpenAI Realtime project…). `credentialRef` is
//      an OPAQUE secret-store reference; credential values never reach
//      domain tables. Re-registering updates authorization fields and
//      reports `created: false` (the meetings module's connection
//      discipline).
//   getRealtimeConnection / listRealtimeConnections /
//   setRealtimeConnectionStatus — tenant-scoped reads and the
//      enable/disable lifecycle (uniform not-found discipline).
//   startRealtimeSession — start one realtime session in any of the four
//      product modes (aurum_voice, meeting_participation,
//      meeting_companion, telephony): the durable `requested` intent is
//      recorded FIRST, the room is materialized through the
//      provider-neutral transport port, Aurum's own participant is
//      registered (speaker attribution), and a telephony session places
//      its SIP dial-out. A failed materialization is an explicit,
//      queryable `failed` session — never a silent gap.
//   stopRealtimeSession — stop a session (idempotent; re-stopping an
//      ended session re-ensures its finalization run — the recovery
//      entry). Ends the durable state, stops a running recording, tears
//      the room down best-effort, and ensures the DURABLE FINALIZATION
//      WORKFLOW RUN (W080) that materializes the durable meeting
//      artifact.
//   receiveRealtimeEvent — the canonical EVENT edge: a provider event
//      envelope (provider key + raw JSON payload) is parsed by the
//      provider's PRIVATE adapter into canonical events; the envelope's
//      account resolves onto this tenant's registered connection; every
//      event applies to its session (by room) under the per-session
//      lock, deduped one-application-per-provider-event-id (the ledger
//      row IS the claim). Participant joins/leaves, consent (DTMF/
//      verbal), live transcript turns with speaker attribution,
//      spoken-response lifecycle (completed / INTERRUPTED), recording
//      confirmations and provider-side failures all land here.
//   recordRealtimeConsent — the DOMAIN consent path (companion UI /
//      authenticated client): both paths land in the same append-only
//      ledger. The consent floor: a recording may run only while every
//      currently-joined non-Aurum participant has granted; a revocation
//      while recording STOPS the recording.
//   startRealtimeRecording / stopRealtimeRecording — explicit recording
//      control. A consent-refused start is an error AND an explicit
//      `recording.blocked` ledger event; a stop captures the provider's
//      recording artifact (opaque references only).
//   speakRealtimeResponse — speak one Aurum response into the room
//      through the transport (the response id is the transport's
//      idempotency key), recording the attributed transcript turn and
//      the response lifecycle row. One response may be in flight at a
//      time; the completed/interrupted event releases the next speak.
//   dialRealtimeParticipant — SIP dial-out of one phone participant
//      into a live session (telephony/SIP; the participant needs
//      neither Internet nor an Aurum account).
//   createRealtimeJoinGrant — mint one EPHEMERAL join credential for a
//      joining client; never persisted by this module (the one
//      credential-shaped contract return, by design).
//   getRealtimeSession / listRealtimeSessions / listRealtimeParticipants
//   / listRealtimeTurns / listRealtimeResponses / listRealtimeArtifacts
//   / listRealtimeEvents — the canonical registry reads (current state;
//      the event ledger is the append-only trail, the session-close
//      observation is the W004 evidence).
//   pumpRealtimeFinalization — the worker seam (the W080 recovery
//      discipline): advance EXACTLY ONE pending finalization per call;
//      recovers the crash window between a terminal session transition
//      and its workflow run.
//   createRealtimeWorkflowBindings — the durable finalization executors
//      a host composes into its workflow engine. Bindings are code,
//      never durable state.
//   setRealtimeTransport / getRealtimeTransport — infrastructure wiring
//      for the provider-neutral transport port. Transports that touch
//      provider SDKs/HTTP must live inside this module's adapters/
//      folder (IMPLEMENTATION-STACK §6 provider isolation); no transport
//      is wired by default, so session starts fail explicitly with
//      `provider_unavailable`.
//
// PROVIDER ISOLATION (lock 16 / MODULE-DEPENDENCY-MAP provider
// boundaries; IMPLEMENTATION-STACK §6): everything exported below is
// provider-neutral by construction. Transport providers appear only as
// the canonical `RealtimeProvider` key owned by this module; the only
// provider-minted values on this surface are OPAQUE strings (account
// ids, room ids, participant ids, event ids, artifact ids). Provider
// event envelopes, SDK objects, room shapes and recording descriptors
// are parsed inside `adapters/` and never leave. The transport port is
// the seam: swapping LiveKit for another provider (openai-realtime
// ships as the second conforming adapter) touches no domain contract —
// the W086 acceptance property.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; access to another tenant's
// realtime state is reported as `connection_not_found` /
// `session_not_found` / `participant_not_found` / `response_not_found`
// — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W086 ← W080, W085): this module
// imports ONLY module contracts — the workflow contract (W080 — the
// durable finalization run that materializes the durable meeting
// artifact; kill/restart-safe through `pumpRealtimeFinalization`), the
// meetings contract (W085 — the read-validated canonical meeting
// session reference a participation/companion session attaches to), the
// identity contract (W002 — the read-only verified-email participant
// bridge; full cross-modality unification is W095's declared job) and
// the observations contract (W004 — the session-close observation that
// lands realtime evidence in the SAME canonical evidence model as every
// other observation). The object-storage port (infra/blob) carries the
// durable artifact content — W086 owns durable artifact storage, per
// the meetings module's artifact contract note.
// ============================================================================

export {
  // Connections
  getRealtimeConnection,
  listRealtimeConnections,
  registerRealtimeConnection,
  setRealtimeConnectionStatus,
  // Sessions
  getRealtimeSession,
  listRealtimeSessions,
  startRealtimeSession,
  stopRealtimeSession,
  // Participants + consent
  listRealtimeParticipants,
  recordRealtimeConsent,
  // Recording control
  startRealtimeRecording,
  stopRealtimeRecording,
  // Telephony
  dialRealtimeParticipant,
  // Join grants
  createRealtimeJoinGrant,
  // Transcript + responses
  listRealtimeTurns,
  listRealtimeResponses,
  speakRealtimeResponse,
  // Artifacts + trail
  listRealtimeArtifacts,
  listRealtimeEvents,
  // The provider event edge
  receiveRealtimeEvent,
  // The finalization seam (W080)
  createRealtimeWorkflowBindings,
  pumpRealtimeFinalization,
  // Transport wiring
  getRealtimeTransport,
  setRealtimeTransport,
} from './service';

// The durable finalization workflow's definition key (stable identity).
export { REALTIME_FINALIZE_DEFINITION_KEY } from './service';

export { RealtimeError } from './errors';
export type { RealtimeErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  MAX_BYTE_SIZE,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_CHECKSUM_LENGTH,
  MAX_DETAIL_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EVENTS_PER_ENVELOPE,
  MAX_LIST_LIMIT,
  MAX_MEDIA_TYPE_LENGTH,
  MAX_OAUTH_SCOPES,
  MAX_PAYLOAD_BYTES,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_EVENT_ID_LENGTH,
  MAX_PROVIDER_ID_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_STORAGE_REF_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  REALTIME_ARTIFACT_KINDS,
  REALTIME_AUTH_KINDS,
  REALTIME_CONNECTION_STATUSES,
  REALTIME_CONSENT_STATES,
  REALTIME_ENDED_REASONS,
  REALTIME_EVENT_KINDS,
  REALTIME_FAILURE_CODES,
  REALTIME_PARTICIPANT_ROLES,
  REALTIME_PROVIDERS,
  REALTIME_RECORDING_STATES,
  REALTIME_RESPONSE_STATUSES,
  REALTIME_SESSION_KINDS,
  REALTIME_SESSION_STATUSES,
  REALTIME_TURN_KINDS,
  isE164,
  isRealtimeProvider,
  isUuid,
} from './validation';

export type {
  ValidatedEventParseResult,
  ValidatedListArtifactsQuery,
  ValidatedListConnectionsQuery,
  ValidatedListEventsQuery,
  ValidatedListParticipantsQuery,
  ValidatedListResponsesQuery,
  ValidatedListSessionsQuery,
  ValidatedListTurnsQuery,
  ValidatedRealtimeEvent,
  ValidatedRegisterConnectionInput,
} from './validation';

export type {
  CanonicalRealtimeEvent,
  ConsentGrantedEvent,
  ConsentRevokedEvent,
  DialRealtimeParticipantInput,
  ListRealtimeArtifactsQuery,
  ListRealtimeConnectionsQuery,
  ListRealtimeEventsQuery,
  ListRealtimeParticipantsQuery,
  ListRealtimeResponsesQuery,
  ListRealtimeSessionsQuery,
  ListRealtimeTurnsQuery,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
  RealtimeArtifact,
  RealtimeAuthKind,
  RealtimeConnection,
  RealtimeConnectionStatus,
  RealtimeConsentState,
  RealtimeDialRequest,
  RealtimeDialResult,
  RealtimeEndedReason,
  RealtimeEventKind,
  RealtimeEventRecord,
  RealtimeEventResult,
  RealtimeEventSource,
  RealtimeFailureCode,
  RealtimeFinalizationPumpOutcome,
  RealtimeJoinGrant,
  RealtimeJoinGrantRequest,
  RealtimeParticipant,
  RealtimeParticipantRole,
  RealtimeProvider,
  RealtimeRecordingArtifactInfo,
  RealtimeRecordingRequest,
  RealtimeRecordingState,
  RealtimeRecordingStopResult,
  RealtimeResponse,
  RealtimeRoomHandle,
  RealtimeRoomStartRequest,
  RealtimeRoomStopRequest,
  RealtimeSession,
  RealtimeSessionKind,
  RealtimeSessionStartResult,
  RealtimeSessionStatus,
  RealtimeSessionStopResult,
  RealtimeSpeakRequest,
  RealtimeTransport,
  RealtimeTransportCall,
  RealtimeTurn,
  ReceiveRealtimeEventInput,
  RecordRealtimeConsentInput,
  RecordingStartedEvent,
  RecordingStoppedEvent,
  RegisterRealtimeConnectionInput,
  RegisterRealtimeConnectionResult,
  ResponseCompletedEvent,
  ResponseInterruptedEvent,
  SessionEndedEvent,
  SessionFailedEvent,
  SessionStartedEvent,
  SpeakRealtimeResponseInput,
  StartRealtimeSessionInput,
  StopRealtimeSessionInput,
  TranscriptFinalEvent,
} from './types';
