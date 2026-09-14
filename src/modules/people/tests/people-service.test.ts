// Integration tests for the people module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W002 acceptance:
// Person/Employee models, the verified-linking workflow across channel
// providers, duplicate provider identities resolving to one employee, and
// cross-tenant isolation (ADR-0001).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  attestIdentity,
  completeVerificationChallenge,
  detachSubject,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  issueVerificationChallenge,
  registerExternalIdentity,
  revokeVerification,
  type ChannelProvider,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import { runMigrations } from '../../../../scripts/migrate';
import {
  createEmployee,
  createPerson,
  getEmployeeByPerson,
  getPerson,
  linkExternalIdentity,
  listPersonIdentities,
  resolveIdentity,
  setEmployeeStatus,
} from '../contract';

const tenantA = newId();
const tenantB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function manager(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK] };
}

async function personWithEmployee(tenantId: string, fullName: string, employeeNumber: string) {
  const person = await createPerson(member(tenantId), { fullName });
  const employee = await createEmployee(member(tenantId), {
    personId: person.id,
    employeeNumber,
    title: `Title of ${fullName}`,
  });
  return { person, employee };
}

/** Full verified-linking workflow for one provider account. */
async function verifiedLinkedIdentity(
  tenantId: string,
  provider: ChannelProvider,
  accountId: string,
  personId: string,
): Promise<ExternalIdentity> {
  const { identity } = await registerExternalIdentity(member(tenantId), { provider, providerAccountId: accountId });
  const challenge = await issueVerificationChallenge(member(tenantId), { identityId: identity.id });
  const verified = await completeVerificationChallenge(member(tenantId), {
    identityId: identity.id,
    code: challenge.code,
  });
  const linked = await linkExternalIdentity(manager(tenantId), { personId, identityId: verified.id });
  return linked.identity;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('persons', () => {
  it('creates and reads persons within a tenant (input is normalized)', async () => {
    const person = await createPerson(member(tenantA), { fullName: ' Ada Lovelace ', email: ' ada@corp.example ' });
    expect(person.fullName).toBe('Ada Lovelace');
    expect(person.email).toBe('ada@corp.example');
    expect(person.tenantId).toBe(tenantA);

    const read = await getPerson(member(tenantA), person.id);
    expect(read.id).toBe(person.id);
    expect(read.fullName).toBe('Ada Lovelace');
  });

  it('rejects invalid input and malformed contexts', async () => {
    await expect(createPerson(member(tenantA), { fullName: '   ' })).rejects.toMatchObject({
      code: 'invalid_person_input',
    });
    await expect(createPerson(member(tenantA), { fullName: 'X', email: 'not-an-email' })).rejects.toMatchObject({
      code: 'invalid_person_input',
    });
    await expect(
      createPerson({ tenantId: '', principalId: newId(), authority: [] }, { fullName: 'X' }),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });

  it('hides persons across tenants', async () => {
    const inB = await createPerson(member(tenantB), { fullName: 'Tenant B Person' });
    await expect(getPerson(member(tenantA), inB.id)).rejects.toMatchObject({ code: 'person_not_found' });
  });
});

describe('employees', () => {
  it('creates an employment record for a person of the tenant', async () => {
    const { person } = await personWithEmployee(tenantA, 'Grace Hopper', 'E-100');
    const employee = await getEmployeeByPerson(member(tenantA), person.id);
    expect(employee?.employeeNumber).toBe('E-100');
    expect(employee?.status).toBe('active');
    expect(employee?.personId).toBe(person.id);
  });

  it('rejects cross-tenant person references, duplicate employments and taken numbers', async () => {
    const foreign = await createPerson(member(tenantB), { fullName: 'Foreign Person' });
    await expect(createEmployee(member(tenantA), { personId: foreign.id })).rejects.toMatchObject({
      code: 'person_not_found',
    });

    const { person } = await personWithEmployee(tenantA, 'Alan Turing', 'E-101');
    await expect(createEmployee(member(tenantA), { personId: person.id })).rejects.toMatchObject({
      code: 'employee_already_exists',
    });

    const other = await createPerson(member(tenantA), { fullName: 'Second Person' });
    await expect(
      createEmployee(member(tenantA), { personId: other.id, employeeNumber: 'E-100' }),
    ).rejects.toMatchObject({ code: 'employee_number_taken' });
    await expect(
      createEmployee(member(tenantA), { personId: other.id, hiredAt: 'not-a-date' }),
    ).rejects.toMatchObject({ code: 'invalid_employee_input' });

    // employee numbers are scoped per tenant: tenant B may reuse 'E-100'
    const inB = await createEmployee(member(tenantB), { personId: foreign.id, employeeNumber: 'E-100' });
    expect(inB.employeeNumber).toBe('E-100');
  });

  it('validates status transitions', async () => {
    const { employee } = await personWithEmployee(tenantA, 'Leave Case', 'E-102');
    expect((await setEmployeeStatus(member(tenantA), { employeeId: employee.id, status: 'on_leave' })).status).toBe(
      'on_leave',
    );
    expect((await setEmployeeStatus(member(tenantA), { employeeId: employee.id, status: 'active' })).status).toBe(
      'active',
    );
    expect((await setEmployeeStatus(member(tenantA), { employeeId: employee.id, status: 'terminated' })).status).toBe(
      'terminated',
    );
    await expect(
      setEmployeeStatus(member(tenantA), { employeeId: employee.id, status: 'active' }),
    ).rejects.toMatchObject({ code: 'invalid_status_transition' });
    await expect(
      setEmployeeStatus(member(tenantB), { employeeId: employee.id, status: 'on_leave' }),
    ).rejects.toMatchObject({ code: 'employee_not_found' });
  });
});

describe('verified linking across providers (W002 acceptance)', () => {
  it('resolves duplicate provider identities to one employee', async () => {
    const { person, employee } = await personWithEmployee(tenantA, 'Multi-Channel Employee', 'E-200');

    // duplicate registration of the same WhatsApp account collapses to one identity
    const first = await registerExternalIdentity(member(tenantA), {
      provider: 'whatsapp',
      providerAccountId: '+15550300',
    });
    expect(first.created).toBe(true);
    const duplicate = await registerExternalIdentity(member(tenantA), {
      provider: 'whatsapp',
      providerAccountId: '+15550300',
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.identity.id).toBe(first.identity.id);

    // the same human, verified on four different channel providers
    const whatsapp = await verifiedLinkedIdentity(tenantA, 'whatsapp', '+15550300', person.id);
    const slack = await verifiedLinkedIdentity(tenantA, 'slack', 'U8001', person.id);
    const telegram = await verifiedLinkedIdentity(tenantA, 'telegram', '80011', person.id);
    const email = await verifiedLinkedIdentity(tenantA, 'email', 'multi@corp.example', person.id);

    // every provider account resolves to the SAME person and the SAME employee
    for (const identity of [whatsapp, slack, telegram, email]) {
      const resolution = await resolveIdentity(member(tenantA), {
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
      });
      expect(resolution.status).toBe('resolved');
      if (resolution.status !== 'resolved') throw new Error('unreachable');
      expect(resolution.identity.id).toBe(identity.id);
      expect(resolution.person.id).toBe(person.id);
      expect(resolution.person.tenantId).toBe(tenantA);
      expect(resolution.employee?.id).toBe(employee.id);
      expect(resolution.employee?.status).toBe('active');
    }

    // one employee, four linked identities, no duplicates from re-registration
    const identities = await listPersonIdentities(member(tenantA), person.id);
    expect(identities).toHaveLength(4);
    expect(new Set(identities.map((identity) => identity.id)).size).toBe(4);
    expect(identities.every((identity) => identity.subjectId === person.id)).toBe(true);
  });

  it('resolves a verified person without an employment record (employee is optional)', async () => {
    const person = await createPerson(member(tenantA), { fullName: 'External Collaborator' });
    await verifiedLinkedIdentity(tenantA, 'telegram', '80013', person.id);
    const resolution = await resolveIdentity(member(tenantA), { provider: 'telegram', providerAccountId: '80013' });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.person.id).toBe(person.id);
      expect(resolution.employee).toBeNull();
    }
  });

  it('never resolves unverified or unlinked identities (lock 15: no pseudo-employees)', async () => {
    const { person } = await personWithEmployee(tenantA, 'Unverified Case', 'E-201');

    // unverified identity
    const unverified = await registerExternalIdentity(member(tenantA), {
      provider: 'whatsapp',
      providerAccountId: '+15550301',
    });
    expect(
      (await resolveIdentity(member(tenantA), { provider: 'whatsapp', providerAccountId: '+15550301' })).status,
    ).toBe('unresolved_identity');

    // verified but not linked
    const challenge = await issueVerificationChallenge(member(tenantA), { identityId: unverified.identity.id });
    await completeVerificationChallenge(member(tenantA), { identityId: unverified.identity.id, code: challenge.code });
    expect(
      (await resolveIdentity(member(tenantA), { provider: 'whatsapp', providerAccountId: '+15550301' })).status,
    ).toBe('unresolved_identity');

    // unknown account
    expect(
      (await resolveIdentity(member(tenantA), { provider: 'whatsapp', providerAccountId: '+15559999' })).status,
    ).toBe('unknown_identity');

    // linking requires the authority claim and a verified identity
    await expect(
      linkExternalIdentity(member(tenantA), { personId: person.id, identityId: unverified.identity.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const otherUnverified = await registerExternalIdentity(member(tenantA), {
      provider: 'x',
      providerAccountId: 'unverified-at-x',
    });
    await expect(
      linkExternalIdentity(manager(tenantA), { personId: person.id, identityId: otherUnverified.identity.id }),
    ).rejects.toMatchObject({ code: 'identity_not_verified' });
  });

  it('revocation and detaching break resolution', async () => {
    const { person } = await personWithEmployee(tenantA, 'Revocation Case', 'E-202');
    const identity = await verifiedLinkedIdentity(tenantA, 'telegram', '80012', person.id);

    const revoked = await revokeVerification(manager(tenantA), { identityId: identity.id, reason: 'account compromised' });
    expect(revoked.subjectId).toBeNull();
    expect(
      (await resolveIdentity(member(tenantA), { provider: 'telegram', providerAccountId: '80012' })).status,
    ).toBe('unresolved_identity');

    // re-verify via attestation, link again, then detach
    const reattested = await attestIdentity(manager(tenantA), {
      identityId: identity.id,
      evidence: 're-verified after compromise',
    });
    expect(reattested.subjectId).toBeNull();
    const linked = await linkExternalIdentity(manager(tenantA), { personId: person.id, identityId: identity.id });
    expect(linked.identity.subjectId).toBe(person.id);
    const detached = await detachSubject(manager(tenantA), { identityId: identity.id });
    expect(detached.subjectId).toBeNull();
    expect(
      (await resolveIdentity(member(tenantA), { provider: 'telegram', providerAccountId: '80012' })).status,
    ).toBe('unresolved_identity');
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('keeps identical provider accounts in different tenants fully separate', async () => {
    const a = await personWithEmployee(tenantA, 'Shared Phone A', 'E-300');
    const b = await personWithEmployee(tenantB, 'Shared Phone B', 'E-300');
    const identityA = await verifiedLinkedIdentity(tenantA, 'whatsapp', '+15550400', a.person.id);
    const identityB = await verifiedLinkedIdentity(tenantB, 'whatsapp', '+15550400', b.person.id);
    expect(identityA.id).not.toBe(identityB.id);

    // each tenant resolves the shared account to its own person/employee
    const resolutionA = await resolveIdentity(member(tenantA), {
      provider: 'whatsapp',
      providerAccountId: '+15550400',
    });
    const resolutionB = await resolveIdentity(member(tenantB), {
      provider: 'whatsapp',
      providerAccountId: '+15550400',
    });
    expect(resolutionA.status).toBe('resolved');
    expect(resolutionB.status).toBe('resolved');
    if (resolutionA.status === 'resolved' && resolutionB.status === 'resolved') {
      expect(resolutionA.person.id).toBe(a.person.id);
      expect(resolutionA.employee?.id).toBe(a.employee.id);
      expect(resolutionB.person.id).toBe(b.person.id);
      expect(resolutionB.employee?.id).toBe(b.employee.id);
      expect(resolutionA.person.tenantId).toBe(tenantA);
      expect(resolutionB.person.tenantId).toBe(tenantB);
    }

    // a key registered only in tenant B is unknown to tenant A
    const onlyB = await registerExternalIdentity(member(tenantB), { provider: 'signal', providerAccountId: '+15550401' });
    expect(onlyB.created).toBe(true);
    expect(
      (await resolveIdentity(member(tenantA), { provider: 'signal', providerAccountId: '+15550401' })).status,
    ).toBe('unknown_identity');

    // cross-tenant ids and links are invisible / impossible
    await expect(getPerson(member(tenantA), b.person.id)).rejects.toMatchObject({ code: 'person_not_found' });
    await expect(
      linkExternalIdentity(manager(tenantA), { personId: a.person.id, identityId: identityB.id }),
    ).rejects.toMatchObject({ code: 'identity_not_found' });
    await expect(listPersonIdentities(member(tenantB), a.person.id)).rejects.toMatchObject({
      code: 'person_not_found',
    });
    const inA = await listPersonIdentities(member(tenantA), a.person.id);
    expect(inA.map((identity) => identity.id)).toEqual([identityA.id]);
  });
});
