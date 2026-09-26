// Typed errors of the provider-preferences module. Consumers catch
// `ProviderPreferencesError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// The AUTHORIZATIONS are not errors-as-refusals of expected outcomes —
// they are the module's authority gate working: `unauthorized` is
// thrown when a management operation (tenant preference, technical
// override, advanced explanation detail) arrives without the
// 'provider-preferences:administer' claim (the provider-billing/llm
// claim-gate pattern). Everything an ordinary member does (their own
// preference, the resolved profile, the ordinary "why" reads) needs no
// claim and never sees this code.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`explanation_not_found` / `override_not_found`) — the
// existence of another tenant's preferences, overrides or explanation
// records must never leak (ADR-0001).

export type ProviderPreferencesErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'unauthorized'
  | 'explanation_not_found'
  | 'override_not_found';

export class ProviderPreferencesError extends Error {
  constructor(
    public readonly code: ProviderPreferencesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderPreferencesError';
  }
}
