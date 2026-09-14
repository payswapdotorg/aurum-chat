// Public domain types of the people module (W002 — Person/Employee models).
//
// Person is the tenant-scoped human record; Employee is the employment role
// over a person (one employment per person per tenant in W002). External
// channel identities are owned by the identity module and linked to persons
// through its verified-linking workflow — the people module orchestrates
// that link and resolves identities back to person/employee records.

import type { ChannelProvider, ExternalIdentity } from '@/modules/identity/contract';

/** Tenant-scoped human record. */
export interface Person {
  id: string;
  tenantId: string;
  fullName: string;
  email: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

export type EmployeeStatus = 'active' | 'on_leave' | 'terminated';

/** Employment record over a person (tenant-scoped; one per person in W002). */
export interface Employee {
  id: string;
  tenantId: string;
  personId: string;
  employeeNumber: string | null;
  title: string | null;
  department: string | null;
  /** ISO 8601. */
  hiredAt: string | null;
  status: EmployeeStatus;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

export interface CreatePersonInput {
  fullName: string;
  email?: string | null;
}

export interface CreateEmployeeInput {
  personId: string;
  employeeNumber?: string | null;
  title?: string | null;
  department?: string | null;
  /** ISO 8601 timestamp. */
  hiredAt?: string | null;
}

export interface SetEmployeeStatusInput {
  employeeId: string;
  status: EmployeeStatus;
}

export interface LinkExternalIdentityInput {
  personId: string;
  identityId: string;
}

export interface LinkExternalIdentityResult {
  person: Person;
  identity: ExternalIdentity;
}

export interface ResolveIdentityInput {
  provider: ChannelProvider;
  providerAccountId: string;
}

/**
 * Outcome of resolving a provider account within a tenant:
 *
 * - `unknown_identity`    — no such (provider, account) in this tenant;
 * - `unresolved_identity` — the account is known but is not a verified,
 *   linked identity (unverified / pending / revoked / unlinked) — it must
 *   NOT be treated as an employee (lock 15);
 * - `resolved`            — the account resolves to one person, with their
 *   employment record when one exists.
 */
export type IdentityResolution =
  | { status: 'unknown_identity' }
  | { status: 'unresolved_identity'; identity: ExternalIdentity }
  | { status: 'resolved'; identity: ExternalIdentity; person: Person; employee: Employee | null };
