// ============================================================================
// people — the ONLY public surface of the people module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W002 — Identity Resolution: Person/Employee models plus the orchestration
// of the identity module's verified-linking workflow.
//
//   createPerson / createEmployee     — the tenant's directory records.
//   linkExternalIdentity              — attach a *verified* provider identity
//      to a person (the identity module enforces verification and the
//      `identity:link` authority claim; persons are never auto-created from
//      raw channel accounts — lock 15).
//   resolveIdentity                   — map a (provider, account) to the one
//      person/employee it belongs to, or report it as unknown/unresolved.
//   listPersonIdentities              — all channel identities of a person.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and is
// tenant-scoped at the SQL layer; access to another tenant's records is
// reported as `person_not_found` / `employee_not_found` (no existence leak).
//
// Identity-related failures (IdentityError from the identity contract, e.g.
// `forbidden`, `identity_not_verified`, `identity_already_linked`) propagate
// unchanged out of linkExternalIdentity / resolveIdentity.
// ============================================================================

export {
  createEmployee,
  createPerson,
  getEmployeeByPerson,
  getPerson,
  linkExternalIdentity,
  listPersonIdentities,
  resolveIdentity,
  setEmployeeStatus,
} from './service';

export { PeopleError } from './errors';
export type { PeopleErrorCode } from './errors';

export type {
  CreateEmployeeInput,
  CreatePersonInput,
  Employee,
  EmployeeStatus,
  IdentityResolution,
  LinkExternalIdentityInput,
  LinkExternalIdentityResult,
  Person,
  ResolveIdentityInput,
  SetEmployeeStatusInput,
} from './types';
