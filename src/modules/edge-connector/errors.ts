// Typed errors of the edge-connector module. Consumers catch
// `EdgeConnectorError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// The REFUSALS are data, not errors, wherever the pipeline treats them so:
// an edge job whose execution the EDGE refused ('rejected' receipt) or
// transiently failed ('failed' receipt) is recorded on the job and returned
// as the canonical receipt — the W084 deep-action taxonomy, not a forked
// model. Errors are reserved for caller mistakes, missing state, wiring
// gaps, authentication failures and non-canonical results:
//
//   * `edge_not_connected`   — honest degradation: no healthy edge is
//     available for dispatch (never connected, gone stale, or revoked);
//   * `signer_unavailable`   — no edge signer is wired; job issuance and
//     envelope verification refuse to fake success (the sources/
//     destinations/deep-actions discipline);
//   * `edge_authentication_failed` / `edge_authentication_replayed` — the
//     dial-home call's HMAC proof did not verify, or its request nonce was
//     already consumed (replay-resistant channel);
//   * `invalid_envelope`     — signature, shape, key or tenant mismatch on
//     a presented job envelope;
//   * `job_replayed`         — the envelope's nonce was already consumed
//     (the job already left the queue / completed);
//   * `invalid_edge_result`  — the edge returned a non-canonical result (a
//     provider object cannot cross the boundary — lock 16);
//   * `capability_not_allowed` — the capability is not in the edge's
//     allowlist (checked at dispatch AND, edge-side, at the boundary).
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`edge_not_found` / `job_not_found`) — the existence of another
// tenant's edges, jobs, heartbeats, allowlist or events must never leak
// (ADR-0001).

export type EdgeConnectorErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'forbidden'
  | 'edge_not_found'
  | 'edge_name_taken'
  | 'edge_revoked'
  | 'edge_not_connected'
  | 'signer_unavailable'
  | 'edge_authentication_failed'
  | 'edge_authentication_replayed'
  | 'capability_not_allowed'
  | 'job_not_found'
  | 'invalid_envelope'
  | 'job_replayed'
  | 'job_expired'
  | 'invalid_edge_result'
  | 'edge_job_incomplete'
  | 'edge_job_failed'
  | 'edge_job_rejected';

export class EdgeConnectorError extends Error {
  constructor(
    public readonly code: EdgeConnectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EdgeConnectorError';
  }
}
