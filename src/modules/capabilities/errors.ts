// Typed errors of the capabilities module. Consumers catch
// `CapabilitiesError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`capability_not_found` / `capability_version_not_found` /
// `supply_not_found` / `supply_version_not_found` / `requirement_not_found` /
// `requirement_version_not_found`) — the existence of another tenant's
// capability graph must never leak (ADR-0001). This includes versions,
// supplies and requirements: a version of a foreign-tenant record reads the
// same as a missing one, and registering a supply or requirement against a
// foreign-tenant capability id reads the same as a missing capability.

export type CapabilitiesErrorCode =
  | 'invalid_context'
  | 'invalid_capability_input'
  | 'invalid_supply_input'
  | 'invalid_requirement_input'
  | 'invalid_query'
  // A lifecycle change was not surgical, or a retired record was handed
  // anything but a reactivation, or a supply was registered against a
  // retired capability (the goals module's transition discipline).
  | 'invalid_transition'
  | 'capability_not_found'
  | 'capability_version_not_found'
  | 'supply_not_found'
  | 'supply_version_not_found'
  | 'requirement_not_found'
  | 'requirement_version_not_found'
  // Two different principals raced to register the same capability name;
  // the loser re-reads and revises the winner's capability (the processes
  // module's name-conflict discipline — the name is the immutable graph key).
  | 'capability_name_conflict'
  // A version-append race on a capability (optimistic pointer guard);
  // the loser re-reads and retries (history is never rewritten).
  | 'capability_conflict'
  // Two different principals raced to register a supply/requirement for the
  // same (capability, supplier/source) pair, or a concurrent revision moved
  // a record forward mid-transaction; the loser re-reads and retries
  // (history is never rewritten).
  | 'supply_conflict'
  | 'requirement_conflict';

export class CapabilitiesError extends Error {
  constructor(
    public readonly code: CapabilitiesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilitiesError';
  }
}
