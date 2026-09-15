// Typed errors of the memory module. Consumers catch `MemoryError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`knowledge_entry_not_found` / `transactive_entry_not_found`) —
// the existence of another tenant's organizational memory must never leak
// (ADR-0001). The same uniformity applies to evidence: an observation that
// does not exist in this tenant (or is not readable by this principal) is
// reported as `invalid_provenance` — never as a distinguishable
// "belongs to someone else".

export type MemoryErrorCode =
  | 'invalid_context'
  | 'invalid_knowledge_input'
  | 'invalid_knowledge_query'
  | 'invalid_transactive_input'
  | 'invalid_transactive_query'
  | 'invalid_provenance'
  | 'knowledge_entry_not_found'
  | 'transactive_entry_not_found';

export class MemoryError extends Error {
  constructor(
    public readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}
