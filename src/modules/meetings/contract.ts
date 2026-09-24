// ============================================================================
// meetings — the ONLY public surface of the meetings module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W085 — Meeting Intelligence Gateway:
// "Create canonical meeting/session/transcript/artifact contracts and
//  native Zoom/Teams/Meet adapters, plus optional cross-platform
//  meeting-bot adapters."
//
//   registerMeetingConnection — register (or RE-AUTHORIZE) one tenant-owned
//      meeting capture endpoint per provider account: a Zoom workspace, a
//      Teams tenant, a Meet workspace, a Recall meeting-bot account…
//      `credentialRef` is an OPAQUE secret-store reference; credential
//      values never reach domain tables. Re-registering an existing
//      connection updates its authorization fields (the re-authorization
//      path) and reports `created: false`.
//   getMeetingConnection / listMeetingConnections /
//   setMeetingConnectionStatus — tenant-scoped reads and the enable/disable
//      lifecycle (uniform not-found discipline).
//   receiveMeetingWebhook — the canonical WEBHOOK path: a provider webhook
//      payload (provider key + raw JSON envelope) is parsed by the
//      provider's PRIVATE adapter into canonical records; the envelope's
//      account resolves onto this tenant's registered connection. Every
//      record becomes an immutable observation through the observations
//      contract (W004 — meeting metadata, sessions with participant
//      identity, transcripts with speaker attribution, artifacts, and
//      explicit access failures all land in the canonical evidence model
//      with provenance) and updates the canonical registry (meetings,
//      sessions, participants). Redelivered envelopes dedupe on the
//      ingestion ledger — one observation per provider record id, ever.
//   pollMeetingConnection — the canonical POLLING path: the
//      provider-neutral fetch transport pulls records since the
//      connection's stored cursor; capture is ingest-then-cursor, so a
//      failed poll retried re-fetches the same window and dedupe
//      suppresses re-observation. A lapsed recorded OAuth grant fails fast
//      (`meeting_authorization_expired`) AND leaves a queryable access
//      event; a transport that refreshed a grant reports the new expiry.
//   getMeeting / listMeetings / getMeetingSession / listMeetingSessions /
//   listMeetingTranscripts / listMeetingArtifacts — the canonical
//      registry reads (current capture state; the evidence trail lives in
//      the observations the ingestion paths recorded).
//   listMeetingParticipants — the canonical participant identity registry
//      (provider-minted meeting identities, captured on sight; resolved
//      onto organizational persons through the identity module's verified
//      email identities where one exists — the read-only W002 bridge; full
//      unification is W095's declared job).
//   listMeetingAccessEvents — the explicit failed/expired-access history
//      (append-only; also recorded as observations so a gap in meeting
//      intelligence is never silent).
//   setMeetingTransport / getMeetingTransport — infrastructure wiring for
//      the provider-neutral fetch port. Transports that touch provider
//      SDKs/HTTP must live inside this module's adapters/ folder
//      (IMPLEMENTATION-STACK §6 provider isolation); no transport is wired
//      by default, so polls fail explicitly with `provider_unavailable`.
//
// PROVIDER ISOLATION (lock 16 / MODULE-DEPENDENCY-MAP provider boundaries):
// everything exported below is provider-neutral by construction. Providers
// appear only as the canonical `MeetingProvider` key owned by this module;
// the only provider-minted values on this surface are OPAQUE strings
// (account ids, meeting/session/transcript/artifact ids, participant ids,
// cursors). Provider webhook envelopes, SDK objects, meeting shapes and
// cursor semantics are parsed inside `adapters/` and never leave.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's meeting
// intelligence is reported as `connection_not_found` / `meeting_not_found`
// / `session_not_found` — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W085 ← W002, W004, W013, W036,
// W080): this module imports ONLY module contracts — the observations
// contract (W004 — the canonical evidence model every captured record
// lands in, with provenance, lineage `connector` and the provider key as
// channel) and the identity contract (W002 — the read-only
// verified-email bridge for participant resolution). The W013 cognition
// loop perceives meeting evidence through the observations it is built on
// (its `observation` trigger kind), exactly as it perceives source
// records — no cognition state is created here. The W036 gateway
// discipline (connections / adapters / transport port / dedupe ledger /
// fail-fast authorization) is the pattern this module applies to the
// meeting provider family; the W080 workflow port remains available for
// the durable realtime flows W086 builds on this contract.
// ============================================================================

export {
  getMeeting,
  getMeetingConnection,
  getMeetingSession,
  getMeetingTransport,
  listMeetingAccessEvents,
  listMeetingArtifacts,
  listMeetingConnections,
  listMeetingParticipants,
  listMeetings,
  listMeetingSessions,
  listMeetingTranscripts,
  pollMeetingConnection,
  receiveMeetingWebhook,
  registerMeetingConnection,
  setMeetingConnectionStatus,
  setMeetingTransport,
} from './service';

export { MeetingsError } from './errors';
export type { MeetingsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_RECORDS,
  MAX_BATCH_RECORDS,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_CURSOR_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MAX_RECORDS,
  MAX_OAUTH_SCOPES,
  MAX_PAYLOAD_BYTES,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_ARTIFACT_ID_LENGTH,
  MAX_PROVIDER_MEETING_ID_LENGTH,
  MAX_PROVIDER_RECORD_ID_LENGTH,
  MAX_PROVIDER_SESSION_ID_LENGTH,
  MAX_PROVIDER_TRANSCRIPT_ID_LENGTH,
  MAX_SCOPE_LENGTH,
  MEETING_ACCESS_CODES,
  MEETING_ARTIFACT_KINDS,
  MEETING_AUTH_KINDS,
  MEETING_CONNECTION_STATUSES,
  MEETING_INGESTION_MODES,
  MEETING_INGESTION_VIAS,
  MEETING_PROVIDERS,
  MEETING_SESSION_STATUSES,
  cursorAdvance,
  isMeetingAccessCode,
  isMeetingArtifactKind,
  isMeetingAuthKind,
  isMeetingConnectionStatus,
  isMeetingIngestionMode,
  isMeetingIngestionVia,
  isMeetingProvider,
  isMeetingSessionStatus,
} from './validation';

export type {
  ValidatedFetchResult,
  ValidatedListAccessEventsQuery,
  ValidatedListArtifactsQuery,
  ValidatedListConnectionsQuery,
  ValidatedListMeetingsQuery,
  ValidatedListParticipantsQuery,
  ValidatedListSessionsQuery,
  ValidatedListTranscriptsQuery,
  ValidatedMeetingRecord,
  ValidatedPollInput,
  ValidatedRegisterConnectionInput,
  ValidatedWebhookParseResult,
} from './validation';

export type {
  AccessFailedRecord,
  ArtifactAvailableRecord,
  CanonicalMeetingRecord,
  CanonicalParticipant,
  CanonicalParticipantAttendance,
  CanonicalTranscriptSegment,
  IngestedRecord,
  ListMeetingAccessEventsQuery,
  ListMeetingArtifactsQuery,
  ListMeetingConnectionsQuery,
  ListMeetingParticipantsQuery,
  ListMeetingsQuery,
  ListMeetingSessionsQuery,
  ListMeetingTranscriptsQuery,
  Meeting,
  MeetingAccessCode,
  MeetingAccessEvent,
  MeetingArtifact,
  MeetingArtifactKind,
  MeetingAuthKind,
  MeetingConnection,
  MeetingConnectionStatus,
  MeetingFetchRequest,
  MeetingFetchResult,
  MeetingIngestionMode,
  MeetingIngestionVia,
  MeetingParticipant,
  MeetingProvider,
  MeetingSession,
  MeetingSessionStatus,
  MeetingTranscript,
  MeetingTransport,
  PollMeetingConnectionInput,
  PollResult,
  ReceiveMeetingWebhookInput,
  RegisterMeetingConnectionInput,
  RegisterMeetingConnectionResult,
  SessionParticipant,
  SetMeetingConnectionStatusInput,
  TranscriptAvailableRecord,
  TranscriptSegment,
  WebhookResult,
} from './types';
