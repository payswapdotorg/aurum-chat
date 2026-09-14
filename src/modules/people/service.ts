// Implementation of the people module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); semantic timestamps come from the injectable clock;
// every statement is scoped by the explicit TenantContext (ADR-0001).
//
// The identity-resolution read path lives here because only the people
// module can join persons/employees with the identity module's contract:
// `resolveIdentity` maps a provider account to the one person (and
// employment) it belongs to — or reports it as unknown/unresolved so channel
// accounts can never surface as disconnected pseudo-employees (lock 15).

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  attachVerifiedSubject,
  findExternalIdentityByProviderKey,
  listSubjectIdentities,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import { canTransitionEmployeeStatus, isEmployeeStatus } from './employee-status';
import { PeopleError } from './errors';
import type {
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

interface PersonRow extends DbRow {
  id: string;
  tenant_id: string;
  full_name: string;
  email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EmployeeRow extends DbRow {
  id: string;
  tenant_id: string;
  person_id: string;
  employee_number: string | null;
  title: string | null;
  department: string | null;
  hired_at: Date | string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function assertContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new PeopleError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new PeopleError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new PeopleError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapPerson(row: PersonRow): Person {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fullName: row.full_name,
    email: row.email,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personId: row.person_id,
    employeeNumber: row.employee_number,
    title: row.title,
    department: row.department,
    hiredAt: row.hired_at === null ? null : toIso(row.hired_at),
    status: row.status as EmployeeStatus, // CHECK-constrained by migration 002
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function loadPersonRow(ctx: TenantContext, personId: string): Promise<PersonRow> {
  const result = await getDb().query<PersonRow>(
    `SELECT * FROM persons WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, personId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant access is indistinguishable from a missing record (no existence leak).
    throw new PeopleError('person_not_found', `person '${personId}' does not exist in this tenant`);
  }
  return row;
}

async function loadEmployeeRow(ctx: TenantContext, employeeId: string): Promise<EmployeeRow> {
  const result = await getDb().query<EmployeeRow>(
    `SELECT * FROM employees WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, employeeId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new PeopleError('employee_not_found', `employee '${employeeId}' does not exist in this tenant`);
  }
  return row;
}

export async function createPerson(ctx: TenantContext, input: CreatePersonInput): Promise<Person> {
  assertContext(ctx);
  const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : '';
  if (fullName === '') {
    throw new PeopleError('invalid_person_input', 'fullName must be a non-empty string');
  }
  const email = input.email?.trim() || null;
  if (email !== null && !email.includes('@')) {
    throw new PeopleError('invalid_person_input', 'email must be an email address');
  }
  const at = now();
  const result = await getDb().query<PersonRow>(
    `INSERT INTO persons (tenant_id, full_name, email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4) RETURNING *`,
    [ctx.tenantId, fullName, email, at],
  );
  return mapPerson(result.rows[0]!);
}

export async function getPerson(ctx: TenantContext, personId: string): Promise<Person> {
  assertContext(ctx);
  return mapPerson(await loadPersonRow(ctx, personId));
}

export async function createEmployee(ctx: TenantContext, input: CreateEmployeeInput): Promise<Employee> {
  assertContext(ctx);
  await getPerson(ctx, input.personId); // tenant-scoped existence check → person_not_found
  const employeeNumber = input.employeeNumber?.trim() || null;
  const title = input.title?.trim() || null;
  const department = input.department?.trim() || null;
  const hiredAt = input.hiredAt?.trim() || null;
  if (hiredAt !== null && Number.isNaN(Date.parse(hiredAt))) {
    throw new PeopleError('invalid_employee_input', 'hiredAt must be an ISO 8601 timestamp');
  }
  const db = getDb();
  const existingEmployment = await db.query<{ id: string }>(
    `SELECT id FROM employees WHERE tenant_id = $1 AND person_id = $2`,
    [ctx.tenantId, input.personId],
  );
  if (existingEmployment.rows[0] !== undefined) {
    throw new PeopleError('employee_already_exists', 'this person already has an employment record in this tenant');
  }
  if (employeeNumber !== null) {
    const taken = await db.query<{ id: string }>(
      `SELECT id FROM employees WHERE tenant_id = $1 AND employee_number = $2`,
      [ctx.tenantId, employeeNumber],
    );
    if (taken.rows[0] !== undefined) {
      throw new PeopleError('employee_number_taken', `employee number '${employeeNumber}' is already in use in this tenant`);
    }
  }
  const at = now();
  const result = await db.query<EmployeeRow>(
    `INSERT INTO employees (tenant_id, person_id, employee_number, title, department, hired_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
    [
      ctx.tenantId,
      input.personId,
      employeeNumber,
      title,
      department,
      hiredAt === null ? null : new Date(hiredAt),
      at,
    ],
  );
  return mapEmployee(result.rows[0]!);
}

export async function getEmployeeByPerson(
  ctx: TenantContext,
  personId: string,
): Promise<Employee | null> {
  assertContext(ctx);
  const result = await getDb().query<EmployeeRow>(
    `SELECT * FROM employees WHERE tenant_id = $1 AND person_id = $2`,
    [ctx.tenantId, personId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapEmployee(row);
}

export async function setEmployeeStatus(
  ctx: TenantContext,
  input: SetEmployeeStatusInput,
): Promise<Employee> {
  assertContext(ctx);
  if (!isEmployeeStatus(input.status)) {
    throw new PeopleError('invalid_employee_input', `unknown employee status '${String(input.status)}'`);
  }
  const row = await loadEmployeeRow(ctx, input.employeeId);
  if (!isEmployeeStatus(row.status)) {
    throw new PeopleError('invalid_employee_input', 'employee row carries an unknown status');
  }
  if (!canTransitionEmployeeStatus(row.status, input.status)) {
    throw new PeopleError(
      'invalid_status_transition',
      `cannot transition employee status from '${row.status}' to '${input.status}'`,
    );
  }
  const at = now();
  const result = await getDb().query<EmployeeRow>(
    `UPDATE employees SET status = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4 RETURNING *`,
    [input.status, at, ctx.tenantId, input.employeeId],
  );
  return mapEmployee(result.rows[0]!);
}

/**
 * Verified-linking workflow entry point (ADR-0003): attach a *verified*
 * external identity to a person. Delegates the verified/authority checks to
 * the identity module (single source of truth for identity trust); validates
 * the person here. Persons are created deliberately — never automatically
 * from a raw channel account (lock 15).
 */
export async function linkExternalIdentity(
  ctx: TenantContext,
  input: LinkExternalIdentityInput,
): Promise<LinkExternalIdentityResult> {
  assertContext(ctx);
  const person = await getPerson(ctx, input.personId);
  const identity = await attachVerifiedSubject(ctx, { identityId: input.identityId, subjectId: person.id });
  return { person, identity };
}

/** Resolve a provider account to the one person/employee it belongs to in this tenant. */
export async function resolveIdentity(
  ctx: TenantContext,
  input: ResolveIdentityInput,
): Promise<IdentityResolution> {
  assertContext(ctx);
  const identity = await findExternalIdentityByProviderKey(ctx, {
    provider: input.provider,
    providerAccountId: input.providerAccountId,
  });
  if (identity === null) {
    return { status: 'unknown_identity' };
  }
  if (identity.status !== 'verified' || identity.subjectId === null) {
    return { status: 'unresolved_identity', identity };
  }
  // The link workflow guarantees the subject exists; a miss here is an
  // integrity breach and must fail loudly rather than resolve to nothing.
  const person = await getPerson(ctx, identity.subjectId);
  const employee = await getEmployeeByPerson(ctx, identity.subjectId);
  return { status: 'resolved', identity, person, employee };
}

export async function listPersonIdentities(
  ctx: TenantContext,
  personId: string,
): Promise<ExternalIdentity[]> {
  assertContext(ctx);
  const person = await getPerson(ctx, personId);
  return listSubjectIdentities(ctx, person.id);
}
