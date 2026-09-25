// Typed errors of the realtime module. Consumers catch `RealtimeError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`connection_not_found` / `session_not_found` /
// `participant_not_found` / `response_not_found`) — the existence of
// another tenant's realtime state must never leak (ADR-0001). This
// covers every id-bearing lookup: connections, sessions, participants,
// turns, responses and artifacts.
//
// Failures are EXPLICIT, never silent no-ops or fake successes (the W085
// discipline): a start with no wired transport fails `provider_unavailable`;
// a recording start without all-party consent fails `consent_required` AND
// leaves an explicit `recording.blocked` ledger event; a lapsed recorded
// OAuth grant fails fast `realtime_authorization_expired`.

export type RealtimeErrorCode =
  | 'invalid_context'
  | 'invalid_realtime_input'
  | 'invalid_realtime_query'
  | 'unsupported_provider'
  | 'connection_not_found'
  | 'realtime_connection_conflict'
  | 'connection_disabled'
  | 'realtime_authorization_expired'
  | 'session_not_found'
  | 'session_not_live'
  | 'session_terminal'
  | 'room_not_live'
  | 'participant_not_found'
  | 'consent_required'
  | 'recording_not_running'
  | 'response_not_found'
  | 'response_in_flight'
  | 'dial_not_allowed'
  | 'provider_unavailable'
  | 'transport_failed'
  | 'invalid_provider_payload'
  | 'unsupported_provider_event'
  | 'event_apply_failed'
  | 'finalize_failed';

export class RealtimeError extends Error {
  constructor(
    public readonly code: RealtimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RealtimeError';
  }
}
