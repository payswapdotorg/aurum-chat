// Typed errors of the llm module. Consumers catch `LlmError` and branch on
// `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing record
// (`account_not_found` / `execution_not_found` / `verification_not_found`) —
// the existence of another tenant's AI provider accounts, executions or
// verification evidence must never leak (ADR-0001), the same uniform
// not-found discipline the channels, conversations and actions modules
// apply.
//
// Provider availability: without a wired transport no provider interaction
// is possible — that state is the explicit `provider_unavailable`, never a
// silent no-op or a fake success (the channels module's discipline).
//
// `forbidden` is the authorization failure of the claim-gated writes
// (register/update accounts, manual availability overrides): a plain tenant
// member must not be able to attach arbitrary external AI endpoints to the
// tenant or rewrite its routing/availability state — the same claim-gate
// discipline the actions module applies to the authority matrix.

export type LlmErrorCode =
  | 'invalid_context'
  | 'invalid_llm_input'
  | 'invalid_llm_query'
  | 'forbidden'
  | 'account_not_found'
  | 'account_disabled'
  | 'unsupported_provider'
  | 'unsupported_model'
  | 'unsupported_capability'
  | 'model_output_limit'
  | 'no_eligible_account'
  | 'provider_unavailable'
  | 'invocation_forbidden'
  | 'invocation_approval_required'
  | 'invocation_rejected'
  | 'invocation_failed'
  | 'provider_malformed_response'
  | 'execution_not_found'
  | 'verification_not_found';

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
