// Typed errors of the cross-platform module. Consumers catch
// `CrossPlatformError` and branch on `code`; messages are for
// humans/logs, never for control flow — the same discipline every
// module applies.
//
// Error vocabulary (21 codes):
//   invalid_context          — a caller forgot/malformed the explicit
//                              TenantContext (ADR-0001: the context is
//                              asserted, never ambient);
//   invalid_session_input    — malformed registerClientSession input;
//   invalid_query            — malformed get/list/read query;
//   invalid_handoff_input    — malformed open/record/resume/close
//                              handoff input (context shape, draft
//                              bounds, navigation state, focus rules);
//   invalid_capability_input — malformed invokePlatformCapability input;
//   session_not_found        — uniform not-found for a missing OR
//                              foreign client session (ADR-0001: cross-
//                              tenant access is indistinguishable from
//                              missing — no existence leak);
//   session_not_active       — a mutation was attempted through an
//                              expired or revoked client session;
//   session_already_revoked  — revoking an already-revoked session
//                              (the transition is one-way, terminal);
//   session_principal_mismatch — a handoff targeted a client session of
//                              a DIFFERENT principal (a user's working
//                              context moves between their own devices);
//   handoff_not_found        — uniform not-found for a missing or
//                              foreign handoff session;
//   handoff_not_open         — handing off / resuming a closed session;
//   handoff_already_closed   — closing an already-closed session (the
//                              transition is one-way, terminal);
//   handoff_same_session     — a handoff whose receiving session is the
//                              session that already holds it (a handoff
//                              must MOVE between devices);
//   conversation_not_found   — the conversation focus/read is missing,
//                              foreign, or unreadable (mapped from the
//                              conversations contract);
//   mission_not_found        — the mission focus/read is missing or
//                              foreign (mapped from the missions
//                              contract);
//   work_item_not_found      — the background-work focus does not
//                              resolve on its seam;
//   tenant_not_found         — the shell's tenant surface is missing
//                              (mapped from the organizations contract —
//                              an unprovisioned tenant has no switcher
//                              state);
//   adapter_not_found        — no adapter is registered for the
//                              platform kind (the registry is empty or
//                              the platform was unregistered — the
//                              vendor-removal state, surfaced honestly);
//   adapter_already_registered — registering a second adapter for one
//                              platform kind (one registration per
//                              platform keeps resolution deterministic);
//   capability_not_supported — the platform adapter declares the
//                              capability domain unsupported (the
//                              honest-descriptor law — an explicit
//                              refusal, never a fabricated success);
//   capability_invocation_failed — the adapter's vendor path failed
//                              (mapped from the adapter's throw — honest
//                              failure evidence, never a fake receipt).

export type CrossPlatformErrorCode =
  | 'invalid_context'
  | 'invalid_session_input'
  | 'invalid_query'
  | 'invalid_handoff_input'
  | 'invalid_capability_input'
  | 'session_not_found'
  | 'session_not_active'
  | 'session_already_revoked'
  | 'session_principal_mismatch'
  | 'handoff_not_found'
  | 'handoff_not_open'
  | 'handoff_already_closed'
  | 'handoff_same_session'
  | 'conversation_not_found'
  | 'mission_not_found'
  | 'work_item_not_found'
  | 'tenant_not_found'
  | 'adapter_not_found'
  | 'adapter_already_registered'
  | 'capability_not_supported'
  | 'capability_invocation_failed';

/** The module's typed error. */
export class CrossPlatformError extends Error {
  readonly code: CrossPlatformErrorCode;

  constructor(code: CrossPlatformErrorCode, message: string) {
    super(message);
    this.name = 'CrossPlatformError';
    this.code = code;
  }
}
