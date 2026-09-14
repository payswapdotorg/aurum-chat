// Typed errors of the people module. Consumers catch `PeopleError` and
// branch on `code`. Cross-tenant access is deliberately indistinguishable
// from a missing record (`person_not_found` / `employee_not_found`) so the
// existence of another tenant's records never leaks (ADR-0001).

export type PeopleErrorCode =
  | 'invalid_context'
  | 'invalid_person_input'
  | 'person_not_found'
  | 'invalid_employee_input'
  | 'employee_not_found'
  | 'employee_already_exists'
  | 'employee_number_taken'
  | 'invalid_status_transition';

export class PeopleError extends Error {
  constructor(
    public readonly code: PeopleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PeopleError';
  }
}
