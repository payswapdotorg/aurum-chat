// Simulator module errors (W056). One error type with stable codes, the
// repo-wide convention (attention/outcomes/quality precedent): contract
// operations REJECT with `SimulatorError`; the code is machine-readable and
// tenant-safe (a foreign tenant's company is indistinguishable from a
// missing one — `company_not_found`, no existence leak).

export type SimulatorErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'company_not_found'
  | 'company_already_exists'
  | 'month_unavailable'
  | 'month_out_of_order'
  | 'identity_authority_required'
  | 'scenario_failed';

export class SimulatorError extends Error {
  readonly code: SimulatorErrorCode;

  constructor(code: SimulatorErrorCode, message: string) {
    super(message);
    this.name = 'SimulatorError';
    this.code = code;
  }
}
