// Typed errors of the provider-preferences module. Consumers catch
// `ProviderPreferencesError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`account_not_found` / `execution_not_found`) — the existence of
// another tenant's data must never leak (ADR-0001; the llm contract's own
// uniform not-found is wrapped into these codes when this module
// delegates to it).

export type ProviderPreferencesErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'unauthorized'
  | 'account_not_found'
  | 'execution_not_found'
  | 'mapping_unavailable';

export class ProviderPreferencesError extends Error {
  constructor(
    public readonly code: ProviderPreferencesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderPreferencesError';
  }
}
