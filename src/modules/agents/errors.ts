// Typed errors of the agents module (W021 — Agent Gateway). Consumers
// catch `AgentsError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`agent_not_found` / `execution_not_found`) — the existence of
// another tenant's agent definitions or executions must never leak
// (ADR-0001), the same uniform not-found discipline the actions, llm and
// sources modules apply.
//
// `forbidden` is the authorization failure of the claim-gated writes
// (register/update agent definitions): a plain tenant member must not be
// able to mint organizational actors with permissions — the same
// claim-gate discipline the llm module applies to AI provider accounts.
//
// `permission_not_granted` is the permission-scoping failure at the heart
// of W021 ("with permissions"): an execution requesting a scope its agent
// was never granted is refused before anything is recorded — the runtime
// never sees it, and no action request exists.
//
// Provider availability: without a wired transport no runtime dispatch is
// possible — that state is the explicit `provider_unavailable`, never a
// silent no-op or a fake success (the llm/channels/sources discipline).
//
// `execution_refused` is NOT an error: a submission the authority matrix
// forbids is RECORDED as a terminal `refused` execution (evidence, §24)
// and returned to the caller — exactly like a gated submission, which is
// recorded as `awaiting_approval` and returned. The codes below cover
// only the states a caller cannot resolve through the recorded lifecycle.

export type AgentsErrorCode =
  | 'invalid_context'
  | 'invalid_agent_input'
  | 'invalid_query'
  | 'forbidden'
  | 'agent_not_found'
  | 'agent_disabled'
  | 'permission_not_granted'
  | 'unsupported_provider'
  | 'invalid_runtime_config'
  | 'provider_unavailable'
  | 'provider_malformed_response'
  | 'execution_not_found'
  | 'not_runnable'
  | 'not_cancellable'
  | 'execution_conflict';

export class AgentsError extends Error {
  constructor(
    public readonly code: AgentsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentsError';
  }
}
