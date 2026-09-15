// Typed errors of the channels module. Consumers catch `ChannelsError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`connection_not_found`) — the existence of another tenant's
// channel connections must never leak (ADR-0001). Identity references that
// are missing, foreign or otherwise unavailable are uniformly
// `invalid_provenance`, the same no-leak discipline the conversations and
// memory modules apply to evidence references.
//
// Provider availability ("as provider availability permits", W030): without
// a wired transport no outbound delivery is possible — that state is the
// explicit `provider_unavailable`, never a silent no-op or a fake success.

export type ChannelsErrorCode =
  | 'invalid_context'
  | 'invalid_channel_input'
  | 'invalid_channel_query'
  | 'invalid_provenance'
  | 'connection_not_found'
  | 'connection_ambiguous'
  | 'connection_disabled'
  | 'unsupported_provider_event'
  | 'invalid_provider_payload'
  | 'provider_unavailable'
  | 'delivery_rejected'
  | 'delivery_failed'
  | 'conversation_not_found'
  | 'identity_not_eligible'
  | 'challenge_not_active'
  | 'challenge_expired'
  | 'challenge_code_mismatch'
  | 'challenge_attempts_exhausted';

export class ChannelsError extends Error {
  constructor(
    public readonly code: ChannelsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelsError';
  }
}
