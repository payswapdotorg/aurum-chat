// Typed errors of the conversations module. Consumers catch
// `ConversationsError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`conversation_not_found` / `message_not_found`) — the existence of
// another tenant's conversations must never leak (ADR-0001). Identity and
// person references that are missing, foreign or otherwise unavailable are
// uniformly `invalid_provenance` — the same no-leak discipline the memory
// module applies to evidence.

export type ConversationsErrorCode =
  | 'invalid_context'
  | 'invalid_conversation_input'
  | 'invalid_conversation_query'
  | 'invalid_actor'
  | 'identity_not_resolved'
  | 'invalid_provenance'
  | 'invalid_execution_link'
  | 'conversation_not_found'
  | 'message_not_found';

export class ConversationsError extends Error {
  constructor(
    public readonly code: ConversationsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationsError';
  }
}
