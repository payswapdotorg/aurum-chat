// Typed errors of the sources module. Consumers catch `SourcesError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`source_not_found` / `checkpoint_not_found`) — the existence of
// another tenant's connectors, cursors or ingestion state must never leak
// (ADR-0001). This covers every id-bearing lookup: get, poll, webhook
// account resolution, status changes, checkpoint reads and replay targets.
//
// Provider availability mirrors the channels module's discipline: without a
// wired transport no polling fetch is possible — that state is the explicit
// `provider_unavailable`, never a silent no-op or a fake success.

export type SourcesErrorCode =
  | 'invalid_context'
  | 'invalid_source_input'
  | 'invalid_source_query'
  | 'unsupported_provider'
  | 'source_not_found'
  | 'source_conflict'
  | 'source_disabled'
  | 'source_authorization_expired'
  | 'ingestion_mode_unsupported'
  | 'ingestion_busy'
  | 'provider_unavailable'
  | 'fetch_failed'
  | 'invalid_fetch_result'
  | 'invalid_provider_payload'
  | 'unsupported_provider_event'
  | 'checkpoint_not_found';

export class SourcesError extends Error {
  constructor(
    public readonly code: SourcesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourcesError';
  }
}
