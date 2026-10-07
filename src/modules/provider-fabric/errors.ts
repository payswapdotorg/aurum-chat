// Typed errors of the provider-fabric module (W132). Consumers catch
// `ProviderFabricError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`definition_not_found` / `entry_not_found`) — the existence of
// another tenant's provider definitions, catalog entries or health
// evidence must never leak (ADR-0001), the same uniform not-found
// discipline the llm and channels modules apply.
//
// `definition_not_found` is deliberately UNIFORM over malformed, unknown
// AND foreign-tenant definition references: a caller that hands the
// fabric a non-uuid or a uuid it cannot see gets the same typed answer
// as for a well-formed id that simply does not exist — never a generic
// query-shape error (the W132 prior-execution lesson: malformed refs
// must surface the uniform not-found, not `invalid_query`).
//
// `credential_payload_rejected` is its own typed code, deliberately
// distinct from `invalid_input`: credential-shaped VALUES inside fabric
// inputs (labels, notes, display names, base URLs) are a security
// boundary event, not a shape problem — credentials live ONLY in the
// existing credential-ref mechanism (W034 BYOA accounts + the secret
// store), never in provider definitions or catalog entries.

export type ProviderFabricErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'credential_payload_rejected'
  | 'definition_not_found'
  | 'entry_not_found'
  | 'provider_slug_taken'
  | 'provider_slug_reserved'
  | 'unsupported_provider'
  | 'unsupported_wire_protocol'
  | 'duplicate_model_entry'
  | 'model_not_in_catalog'
  | 'model_unavailable'
  | 'definition_disabled'
  | 'binding_conflict'
  | 'provider_unavailable'
  | 'provider_malformed_response';

export class ProviderFabricError extends Error {
  constructor(
    public readonly code: ProviderFabricErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderFabricError';
  }
}
