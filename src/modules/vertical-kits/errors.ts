// Typed errors of the vertical-kits module. Consumers catch
// `VerticalKitsError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// The REFUSALS are not errors: a W009 gate rejection on an install review
// and a kit-capability denial at invocation are first-class, expected
// outcomes of governed kit usage — recorded on the installation
// ('rejected') / in the append-only invocation ledger and returned as
// data. Errors are reserved for caller mistakes, missing state, wiring
// gaps and non-canonical edge results:
//
//   * `edge_unavailable`     — no system-of-record edge is wired; the kit
//     runtime refuses to fake success. The Edge Connector (W088) is the
//     future implementor of the `VerticalKitEdge` port this seam awaits —
//     every deep-integration execution/inspection path is
//     DEFERRED-ON-W088 until it lands.
//   * `invalid_edge_result`  — a wired edge returned a non-canonical
//     value (a provider object cannot cross the kit runtime — lock 16).
//   * `version_not_monotonic` — a kit version was registered at or below
//     the latest registered version of the same kit key.
//   * `kit_verification_failed` — a manifest failed the deterministic
//     static verification; nothing is stored.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`installation_not_found` / `kit_version_not_found`) — the
// existence of another tenant's kits, versions, grants, invocations or
// events must never leak (ADR-0001).

export type VerticalKitsErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'forbidden'
  | 'kit_version_not_found'
  | 'installation_not_found'
  | 'verification_not_found'
  | 'kit_not_verified'
  | 'kit_already_installed'
  | 'installation_not_pending_review'
  | 'installation_not_active'
  | 'installation_not_lifecycle_state'
  | 'integration_not_found'
  | 'integration_read_only'
  | 'version_not_monotonic'
  | 'kit_verification_failed'
  | 'edge_unavailable'
  | 'invalid_edge_result';

export class VerticalKitsError extends Error {
  constructor(
    public readonly code: VerticalKitsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VerticalKitsError';
  }
}
