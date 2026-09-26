// Typed errors of the edge-connector module. Consumers catch
// `EdgeConnectorError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// The REFUSALS are not errors where the W088 discipline is concerned: an
// edge refusing a job (allowlist, signature, no executor) is a first-class
// recorded outcome of the claim protocol — it is persisted on the job
// ('refused', flagged at the gateway) and returned as data. Errors are
// reserved for caller mistakes, missing state, wiring gaps and non-canonical
// report payloads:
//
//   * `signer_unavailable`   — no edge-job signer is wired; the gateway
//     refuses to submit an unsigned job (the sources/destinations
//     never-fake-success discipline);
//   * `invalid_edge_result`  — an edge reported a non-canonical result (a
//     provider object cannot cross the edge seam — the deep-actions
//     `invalid_transport_result` discipline reshaped onto this module's
//     report boundary);
//   * `envelope_mismatch`    — a report claims a job envelope the gateway
//     never signed (digest differs) — a possible tamper or replay across
//     jobs, refused loudly;
//   * `edge_refused` / `edge_job_failed` / `edge_job_timeout` — the
//     transport adapter's loud surfacing of the edge's own verdict on a
//     job it was asked to carry out.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`edge_not_found` / `job_not_found`) — the existence of another
// tenant's edges, jobs, health or audit rows must never leak (ADR-0001).
//
// SECRET HYGIENE: no message, detail or extra field of this error ever
// carries a credential VALUE. Edge-side secrets live only in the edge
// runtime's local store; the gateway knows digests and opaque references.

export type EdgeConnectorErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'edge_not_found'
  | 'edge_conflict'
  | 'edge_retired'
  | 'edge_token_invalid'
  | 'job_not_found'
  | 'job_not_claimed'
  | 'envelope_mismatch'
  | 'invalid_edge_result'
  | 'signer_unavailable'
  | 'allowlist_invalid'
  | 'edge_refused'
  | 'edge_job_failed'
  | 'edge_job_timeout';

export class EdgeConnectorError extends Error {
  /**
   * The machine-readable refusal reason when this error is an
   * `edge_refused` verdict carried out of the transport adapter (the
   * edge's own refusal code — `bad_signature`, `capability_not_allowed`,
   * …). Null otherwise.
   */
  public readonly refusalReason: string | null;

  /**
   * The machine-readable failure reason when this error is an
   * `edge_job_failed` verdict carried out of the transport adapter.
   * Null otherwise.
   */
  public readonly failureReason: string | null;

  constructor(
    public readonly code: EdgeConnectorErrorCode,
    message: string,
    extras: { refusalReason?: string; failureReason?: string } = {},
  ) {
    super(message);
    this.name = 'EdgeConnectorError';
    this.refusalReason = extras.refusalReason ?? null;
    this.failureReason = extras.failureReason ?? null;
  }
}
