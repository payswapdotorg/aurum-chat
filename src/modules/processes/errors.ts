// Typed errors of the processes module. Consumers catch `ProcessesError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`process_not_found` / `process_version_not_found` /
// `finding_not_found`) — the existence of another tenant's process
// intelligence must never leak (ADR-0001). This includes versions and
// findings: a version of a foreign-tenant process reads the same as a
// missing one.
//
// Evidence reads flow through the events and observations CONTRACTS
// (listEvents / listObservations). Their errors propagate unchanged — the
// freshness module's documented precedent: a contract read failure is the
// owning module's error to report, and this module only constructs queries
// that already passed its own (stricter, pattern-compatible) validation, so
// a sibling validation failure signals a genuine boundary bug, not a caller
// error worth re-labelling.

export type ProcessesErrorCode =
  | 'invalid_context'
  | 'invalid_reconstruction_input'
  | 'invalid_process_query'
  | 'process_not_found'
  | 'process_version_not_found'
  | 'finding_not_found'
  // Two different principals raced to create the same process name; the
  // loser re-reads and retries (the winner's identity is the process).
  | 'process_name_conflict'
  // A version-based optimistic guard or append race failed cleanly; the
  // loser re-reads the process and retries (history is never rewritten).
  | 'process_conflict'
  // The evidence in scope exceeded a reconstruction bound (maxEvents, or
  // the model size caps). Remedy: narrow the window/types or raise maxEvents
  // within its own cap — never a silent truncation of evidence.
  | 'reconstruction_too_large';

export class ProcessesError extends Error {
  constructor(
    public readonly code: ProcessesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessesError';
  }
}
