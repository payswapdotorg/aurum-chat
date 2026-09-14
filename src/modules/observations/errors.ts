// Typed errors of the observations module. Consumers catch
// `ObservationsError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`observation_not_found`) — the existence of another tenant's
// evidence must never leak (ADR-0001). This includes lineage: a parent
// observation that belongs to another tenant is reported as
// `observation_not_found`.

export type ObservationsErrorCode =
  | 'invalid_context'
  | 'invalid_observation_input'
  | 'invalid_observation_query'
  | 'invalid_lineage'
  | 'observation_not_found'
  | 'observation_forbidden';

export class ObservationsError extends Error {
  constructor(
    public readonly code: ObservationsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ObservationsError';
  }
}
