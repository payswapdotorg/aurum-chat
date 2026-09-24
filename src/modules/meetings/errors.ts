// Typed errors of the meetings module. Consumers catch `MeetingsError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`connection_not_found` / `meeting_not_found` / `session_not_found`)
// — the existence of another tenant's meeting intelligence must never leak
// (ADR-0001). This covers every id-bearing lookup: connections, meetings,
// sessions and the poll path's connection resolution.
//
// Failed/expired meeting access is EXPLICIT (W085 acceptance), never a
// silent no-op or a fake success: a lapsed recorded OAuth grant fails
// ingestion fast (`meeting_authorization_expired`); a provider webhook that
// reports an access failure becomes BOTH an append-only access event and
// an observation; a capture attempt with no wired transport fails with
// `provider_unavailable` — the discipline the sources and channels
// modules apply.

export type MeetingsErrorCode =
  | 'invalid_context'
  | 'invalid_meeting_input'
  | 'invalid_meeting_query'
  | 'unsupported_provider'
  | 'connection_not_found'
  | 'meeting_connection_conflict'
  | 'connection_disabled'
  | 'meeting_authorization_expired'
  | 'ingestion_mode_unsupported'
  | 'ingestion_busy'
  | 'provider_unavailable'
  | 'fetch_failed'
  | 'invalid_fetch_result'
  | 'invalid_provider_payload'
  | 'unsupported_provider_event'
  | 'meeting_not_found'
  | 'session_not_found';

export class MeetingsError extends Error {
  constructor(
    public readonly code: MeetingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MeetingsError';
  }
}
