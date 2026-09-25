// W044 — Tenant Isolation Verification · the unified-identity sweep (W095).
//
// The unified-identity module (W095 — Unified Cross-Channel, Meeting and
// Telephony Identity Verification) owns tenant-scoped tables for the
// cross-modality identity surface: the modality-scoped identity registry,
// the ambiguity ledger and the decision evidence trail.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * the registry is tenant-scoped: the SAME (modality, provider,
//     account) key observed in both tenants yields two INDEPENDENT
//     registry identities with independent verification state;
//   * registry rows, ambiguities and the evidence trail of one tenant are
//     invisible to the other (uniform `unified_identity_not_found` /
//     `ambiguity_not_found`, disjoint listings);
//   * a foreign row cannot be linked, revoked or resolved from the other
//     tenant — trust operations are claim-gated but NEVER scope-giving: a
//     tenant-B principal holding every authority claim in the repository
//     (including identity:attest / identity:link) stays blind to tenant A
//     (ADR-0001);
//   * the repository boundary: every unified table carries a NOT NULL
//     uuid tenant_id, and the row partition holds after the fixtures ran.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/unified-identity/tests/); this sweep is the two-tenant
// proof the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  assertTenantPartition,
  member,
  memberWith,
  OMNIPOTENT_AUTHORITY,
  runMigrations,
  tableColumns,
} from './harness';
import {
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { createPerson, linkExternalIdentity } from '@/modules/people/contract';
import {
  getUnifiedIdentity,
  getUnifiedSubjectProfile,
  linkUnifiedSubject,
  listUnifiedAmbiguities,
  listUnifiedIdentities,
  listUnifiedIdentityEvents,
  observeModalityIdentity,
  resolveUnifiedAmbiguity,
  resolveUnifiedIdentity,
  revokeUnifiedLink,
} from '@/modules/unified-identity/contract';

const tenantA = newId();
const tenantB = newId();

const UNIFIED_TABLES = [
  'unified_identities',
  'unified_ambiguities',
  'unified_identity_events',
] as const;

async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  let succeeded = false;
  try {
    await fn();
    succeeded = true;
  } catch (error) {
    caught = error;
  }
  expect(succeeded, `expected an error with code '${code}' but the call succeeded`).toBe(false);
  expect(caught, `expected an Error with code '${code}'`).toBeInstanceOf(Error);
  expect((caught as { code?: unknown }).code, `expected error code '${code}'`).toBe(code);
}

/**
 * One tenant's unification journey: a person with a verified email
 * identity, an auto-linked meeting identity, and an ambiguous edge
 * observation whose conflict lands in the tenant's own ambiguity ledger.
 * Both tenants use the SAME provider keys — the registries stay
 * independent.
 */
async function unifiedJourney(
  tenantId: string,
  key: 'a' | 'b',
): Promise<{ meetingRowId: string; ambiguityId: string; edgeRowId: string; personId: string }> {
  const ctx: TenantContext = { tenantId, principalId: newId(), authority: [] };
  const admin = memberWith(tenantId, ['identity:attest', 'identity:link']);
  const email = key === 'a' ? 'dana@sweep.test' : 'blair@sweep.test';
  const phone = key === 'a' ? '+15550107001' : '+15550107002';

  const person = await createPerson(ctx, { fullName: key === 'a' ? 'Dana Sweep' : 'Blair Sweep' });
  const { identity } = await registerExternalIdentity(admin, {
    provider: 'email',
    providerAccountId: email,
  });
  await attestIdentity(admin, { identityId: identity.id, evidence: `HR directory email (${key})` });
  await linkExternalIdentity(admin, { personId: person.id, identityId: identity.id });

  // The same E.164 belongs to a different person — the edge observation
  // is ambiguous in BOTH tenants, each with its own ledger row.
  const other = await createPerson(ctx, { fullName: key === 'a' ? 'Other A' : 'Other B' });
  const { identity: sms } = await registerExternalIdentity(admin, {
    provider: 'sms',
    providerAccountId: phone,
  });
  await attestIdentity(admin, { identityId: sms.id, evidence: `HR mobile (${key})` });
  await linkExternalIdentity(admin, { personId: other.id, identityId: sms.id });

  const meeting = await observeModalityIdentity(ctx, {
    modality: 'meeting',
    provider: 'zoom',
    providerAccountId: 'zoom-sweep-participant', // SAME key in both tenants
    email,
  });
  expect(meeting.match.outcome).toBe('linked');
  expect(meeting.identity.subjectId).toBe(person.id);

  const edge = await observeModalityIdentity(ctx, {
    modality: 'edge',
    provider: 'edge-connector',
    providerAccountId: 'edge-sweep-user', // SAME key in both tenants
    email,
    phone,
  });
  expect(edge.match.outcome).toBe('ambiguous');
  const ambiguityId =
    edge.match.outcome === 'ambiguous' ? edge.match.ambiguityId : 'no-ambiguity';

  return { meetingRowId: meeting.identity.id, ambiguityId, edgeRowId: edge.identity.id, personId: person.id };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date('2026-09-25T10:00:00Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('W044 sweep — unified-identity (W095)', () => {
  it('runs both tenants side by side with zero leakage', async () => {
    const journeyA = await unifiedJourney(tenantA, 'a');
    const journeyB = await unifiedJourney(tenantB, 'b');

    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    // The SAME (modality, provider, account) key resolves independently
    // per tenant — two registry identities, two verification states.
    const resolutionA = await resolveUnifiedIdentity(ctxA, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'zoom-sweep-participant',
    });
    const resolutionB = await resolveUnifiedIdentity(ctxB, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'zoom-sweep-participant',
    });
    expect(resolutionA.status).toBe('resolved');
    expect(resolutionB.status).toBe('resolved');
    if (resolutionA.status === 'resolved' && resolutionB.status === 'resolved') {
      expect(resolutionA.person.id).toBe(journeyA.personId);
      expect(resolutionB.person.id).toBe(journeyB.personId);
      expect(resolutionA.person.id).not.toBe(resolutionB.person.id);
    }

    // Listings are disjoint and tenant-pure.
    const rowsA = await listUnifiedIdentities(ctxA, {});
    const rowsB = await listUnifiedIdentities(ctxB, {});
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(2);
    expect(rowsA.every((row) => row.tenantId === tenantA)).toBe(true);
    expect(rowsB.every((row) => row.tenantId === tenantB)).toBe(true);

    // Cross-tenant registry reads are uniformly not-found.
    await expectCode('unified_identity_not_found', () =>
      getUnifiedIdentity(ctxA, journeyB.meetingRowId),
    );
    await expectCode('unified_identity_not_found', () =>
      getUnifiedIdentity(ctxB, journeyA.meetingRowId),
    );
    await expectCode('unified_identity_not_found', () => getUnifiedIdentity(ctxA, newId()));

    // A foreign row cannot be linked, revoked or resolved from the other tenant.
    await expectCode('unified_identity_not_found', () =>
      linkUnifiedSubject(memberWith(tenantA, ['identity:link']), {
        unifiedIdentityId: journeyB.edgeRowId,
        personId: journeyA.personId,
        evidence: 'foreign link attempt',
      }),
    );
    await expectCode('unified_identity_not_found', () =>
      revokeUnifiedLink(memberWith(tenantB, ['identity:attest']), {
        unifiedIdentityId: journeyA.meetingRowId,
        reason: 'foreign revoke attempt',
      }),
    );

    // Ambiguity ledgers are per-tenant: each tenant sees exactly its own
    // open ambiguity; the other tenant's ledger is empty and its rows are
    // uniformly not-found.
    const ambiguitiesA = await listUnifiedAmbiguities(ctxA, { status: 'open' });
    const ambiguitiesB = await listUnifiedAmbiguities(ctxB, { status: 'open' });
    expect(ambiguitiesA).toHaveLength(1);
    expect(ambiguitiesB).toHaveLength(1);
    expect(ambiguitiesA[0]!.tenantId).toBe(tenantA);
    expect(ambiguitiesB[0]!.tenantId).toBe(tenantB);
    await expectCode('ambiguity_not_found', () =>
      resolveUnifiedAmbiguity(memberWith(tenantA, ['identity:attest']), {
        ambiguityId: ambiguitiesB[0]!.id,
        action: 'dismissed',
      }),
    );

    // Evidence trails are per-tenant.
    const eventsA = await listUnifiedIdentityEvents(ctxA, {});
    const eventsB = await listUnifiedIdentityEvents(ctxB, {});
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    expect(eventsA.every((event) => event.tenantId === tenantA)).toBe(true);
    expect(eventsB.every((event) => event.tenantId === tenantB)).toBe(true);

    // Profiles are tenant-scoped: a foreign person id is uniformly missing
    // (PeopleError carries the people module's `person_not_found`).
    await expectCode('person_not_found', () => getUnifiedSubjectProfile(ctxB, journeyA.personId));
  });

  it('trust operations are claim-gated but never scope-giving (omniscient blind probe)', async () => {
    // A tenant-B principal holding every authority claim this repository
    // checks — including the identity claims W095 reuses — stays blind to
    // tenant A. Authority authorizes operations, never tenant scope.
    const blindB = memberWith(tenantB, [...OMNIPOTENT_AUTHORITY]);
    const rowsA = await listUnifiedIdentities(member(tenantA), {});
    const meetingRowA = rowsA.find((row) => row.modality === 'meeting')!;
    const ambiguitiesA = await listUnifiedAmbiguities(member(tenantA), { status: 'open' });

    await expectCode('unified_identity_not_found', () => getUnifiedIdentity(blindB, meetingRowA.id));
    await expectCode('unified_identity_not_found', () =>
      linkUnifiedSubject(blindB, {
        unifiedIdentityId: meetingRowA.id,
        personId: newId(),
        evidence: 'omnipotent link attempt',
      }),
    );
    await expectCode('unified_identity_not_found', () =>
      revokeUnifiedLink(blindB, { unifiedIdentityId: meetingRowA.id, reason: 'omnipotent revoke' }),
    );
    await expectCode('ambiguity_not_found', () =>
      resolveUnifiedAmbiguity(blindB, { ambiguityId: ambiguitiesA[0]!.id, action: 'dismissed' }),
    );
    // Tenant B's own view is untouched by the probe.
    expect((await listUnifiedIdentities(blindB, {})).length).toBe(2);
  });

  it('carries a NOT NULL uuid tenant_id on every unified table (repository boundary)', async () => {
    const columns = await tableColumns();
    for (const table of UNIFIED_TABLES) {
      const tenantColumn = columns.find(
        (column) => column.table_name === table && column.column_name === 'tenant_id',
      );
      expect(tenantColumn, `${table} must carry a tenant_id column`).toBeDefined();
      expect(tenantColumn!.data_type, `${table}.tenant_id must be uuid`).toBe('uuid');
      expect(tenantColumn!.is_nullable, `${table}.tenant_id must be NOT NULL`).toBe('NO');
    }
  });

  it('holds the row partition across every tenant-scoped table after the fixtures ran', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
