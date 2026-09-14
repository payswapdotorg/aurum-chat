// Integration tests for the identity module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers ADR-0003 acceptance at
// the identity layer: registration idempotency per provider key, the
// verified-linking workflow (challenge-response and admin attestation),
// revocation, and tenant isolation (ADR-0001).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { CHALLENGE_MAX_ATTEMPTS, CHALLENGE_TTL_MIN_SECONDS } from '../challenge';
import {
  attestIdentity,
  attachVerifiedSubject,
  completeVerificationChallenge,
  detachSubject,
  findExternalIdentityByProviderKey,
  getExternalIdentity,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  issueVerificationChallenge,
  listSubjectIdentities,
  registerExternalIdentity,
  revokeVerification,
  type ChannelProvider,
  type ExternalIdentity,
} from '../contract';

const tenantA = newId();
const tenantB = newId();

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function identityManager(tenantId: string): TenantContext {
  return member(tenantId, [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK]);
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registering external identities', () => {
  it('creates one row per provider key and collapses duplicate registrations', async () => {
    const first = await registerExternalIdentity(member(tenantA), {
      provider: 'whatsapp',
      providerAccountId: '+15550100',
      displayName: 'Ada on WhatsApp',
    });
    expect(first.created).toBe(true);
    expect(first.identity.status).toBe('unverified');
    expect(first.identity.provider).toBe('whatsapp');
    expect(first.identity.providerAccountId).toBe('+15550100');
    expect(first.identity.subjectId).toBeNull();
    expect(first.identity.tenantId).toBe(tenantA);

    // duplicate registration (same account, untrimmed) collapses onto the row
    const duplicate = await registerExternalIdentity(member(tenantA), {
      provider: 'whatsapp',
      providerAccountId: ' +15550100 ',
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.identity.id).toBe(first.identity.id);

    // same account id on a different provider is a different identity
    const otherProvider = await registerExternalIdentity(member(tenantA), {
      provider: 'slack',
      providerAccountId: '+15550100',
    });
    expect(otherProvider.created).toBe(true);
    expect(otherProvider.identity.id).not.toBe(first.identity.id);
  });

  it('rejects invalid providers and empty account ids', async () => {
    await expect(
      registerExternalIdentity(member(tenantA), {
        provider: 'teams' as unknown as ChannelProvider,
        providerAccountId: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_identity_input' });
    await expect(
      registerExternalIdentity(member(tenantA), { provider: 'email', providerAccountId: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_identity_input' });
  });

  it('scopes lookups strictly to the calling tenant', async () => {
    const inA = await registerExternalIdentity(member(tenantA), { provider: 'telegram', providerAccountId: '7001' });
    const inB = await registerExternalIdentity(member(tenantB), { provider: 'telegram', providerAccountId: '7001' });
    expect(inA.identity.id).not.toBe(inB.identity.id);

    const foundInA = await findExternalIdentityByProviderKey(member(tenantA), {
      provider: 'telegram',
      providerAccountId: '7001',
    });
    expect(foundInA?.id).toBe(inA.identity.id);
    expect(foundInA?.tenantId).toBe(tenantA);

    // cross-tenant ids are indistinguishable from missing records
    await expect(getExternalIdentity(member(tenantA), inB.identity.id)).rejects.toMatchObject({
      code: 'identity_not_found',
    });
    await expect(getExternalIdentity(member(tenantB), inA.identity.id)).rejects.toMatchObject({
      code: 'identity_not_found',
    });
    expect(
      await findExternalIdentityByProviderKey(member(tenantA), { provider: 'signal', providerAccountId: 'never-registered' }),
    ).toBeNull();
  });
});

describe('challenge-response verification', () => {
  it('verifies an identity with the correct code and records provenance', async () => {
    const ctx = member(tenantA);
    const { identity } = await registerExternalIdentity(ctx, {
      provider: 'email',
      providerAccountId: 'grace@corp.example',
    });
    const challenge = await issueVerificationChallenge(ctx, { identityId: identity.id });
    expect(challenge.code).toMatch(/^\d{6}$/);
    expect(challenge.identityId).toBe(identity.id);

    const pending = await getExternalIdentity(ctx, identity.id);
    expect(pending.status).toBe('pending');

    const verified = await completeVerificationChallenge(ctx, {
      identityId: identity.id,
      code: challenge.code,
    });
    expect(verified.status).toBe('verified');
    expect(verified.verificationMethod).toBe('challenge_response');
    expect(verified.verifiedBy).toBe(ctx.principalId);
    expect(verified.verifiedAt).not.toBeNull();
  });

  it('burns attempts on wrong codes and locks the challenge after too many tries', async () => {
    const ctx = member(tenantA);
    const { identity } = await registerExternalIdentity(ctx, {
      provider: 'signal',
      providerAccountId: '+15550199',
    });
    const challenge = await issueVerificationChallenge(ctx, { identityId: identity.id });
    const wrongCodeFor = (code: string): string => (code === '000000' ? '000001' : '000000');

    for (let attempt = 0; attempt < CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      await expect(
        completeVerificationChallenge(ctx, { identityId: identity.id, code: wrongCodeFor(challenge.code) }),
      ).rejects.toMatchObject({ code: 'challenge_code_mismatch' });
    }
    // even the correct code no longer helps once attempts are exhausted
    await expect(
      completeVerificationChallenge(ctx, { identityId: identity.id, code: challenge.code }),
    ).rejects.toMatchObject({ code: 'challenge_attempts_exhausted' });

    const stillPending = await getExternalIdentity(ctx, identity.id);
    expect(stillPending.status).toBe('pending');

    // a fresh challenge re-enables verification
    const fresh = await issueVerificationChallenge(ctx, { identityId: identity.id });
    const verified = await completeVerificationChallenge(ctx, { identityId: identity.id, code: fresh.code });
    expect(verified.status).toBe('verified');
  });

  it('rejects invalid ttls', async () => {
    const ctx = member(tenantA);
    const { identity } = await registerExternalIdentity(ctx, { provider: 'sms', providerAccountId: '+15550177' });
    await expect(issueVerificationChallenge(ctx, { identityId: identity.id, ttlSeconds: 0 })).rejects.toMatchObject(
      { code: 'invalid_challenge_ttl' },
    );
    await expect(issueVerificationChallenge(ctx, { identityId: identity.id, ttlSeconds: 100_000 })).rejects.toMatchObject(
      { code: 'invalid_challenge_ttl' },
    );
    await expect(
      issueVerificationChallenge(ctx, { identityId: identity.id, ttlSeconds: CHALLENGE_TTL_MIN_SECONDS - 1 }),
    ).rejects.toMatchObject({ code: 'invalid_challenge_ttl' });
  });

  it('expires challenges after the ttl (clock is injectable)', async () => {
    const ctx = member(tenantA);
    const { identity } = await registerExternalIdentity(ctx, { provider: 'sms', providerAccountId: '+15550188' });
    const challenge = await issueVerificationChallenge(ctx, {
      identityId: identity.id,
      ttlSeconds: CHALLENGE_TTL_MIN_SECONDS,
    });
    const issuedAt = systemClock.now();
    vi.spyOn(systemClock, 'now').mockImplementation(
      () => new Date(issuedAt.getTime() + (CHALLENGE_TTL_MIN_SECONDS + 1) * 1_000),
    );
    await expect(
      completeVerificationChallenge(ctx, { identityId: identity.id, code: challenge.code }),
    ).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  it('rejects completing without an active challenge and double verification', async () => {
    const ctx = member(tenantA);
    const { identity } = await registerExternalIdentity(ctx, { provider: 'web', providerAccountId: 'visitor-9' });
    // never issued a challenge
    await expect(
      completeVerificationChallenge(ctx, { identityId: identity.id, code: '123456' }),
    ).rejects.toMatchObject({ code: 'challenge_not_active' });

    const challenge = await issueVerificationChallenge(ctx, { identityId: identity.id });
    const verified = await completeVerificationChallenge(ctx, { identityId: identity.id, code: challenge.code });
    expect(verified.status).toBe('verified');

    // the consumed challenge cannot be replayed; no new challenge on a verified identity
    await expect(
      completeVerificationChallenge(ctx, { identityId: identity.id, code: challenge.code }),
    ).rejects.toMatchObject({ code: 'identity_already_verified' });
    await expect(issueVerificationChallenge(ctx, { identityId: identity.id })).rejects.toMatchObject({
      code: 'identity_already_verified',
    });
  });
});

describe('admin attestation and revocation', () => {
  it('requires the attest authority and records evidence and provenance', async () => {
    const { identity } = await registerExternalIdentity(member(tenantA), {
      provider: 'linkedin',
      providerAccountId: 'ada-l',
    });
    await expect(
      attestIdentity(member(tenantA), { identityId: identity.id, evidence: 'HR confirmed account ownership' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      attestIdentity(identityManager(tenantA), { identityId: identity.id, evidence: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_identity_input' });

    const manager = identityManager(tenantA);
    const verified = await attestIdentity(manager, {
      identityId: identity.id,
      evidence: 'HR confirmed account ownership',
    });
    expect(verified.status).toBe('verified');
    expect(verified.verificationMethod).toBe('admin_attestation');
    expect(verified.verificationEvidence).toBe('HR confirmed account ownership');
    expect(verified.verifiedBy).toBe(manager.principalId);

    await expect(
      attestIdentity(identityManager(tenantA), { identityId: identity.id, evidence: 'again' }),
    ).rejects.toMatchObject({ code: 'identity_already_verified' });
  });

  it('revokes verification, detaches the subject and requires a reason', async () => {
    const manager = identityManager(tenantA);
    const { identity } = await registerExternalIdentity(member(tenantA), { provider: 'x', providerAccountId: 'ada-at-x' });
    const verified = await attestIdentity(manager, { identityId: identity.id, evidence: 'manager confirmed' });
    const subjectId = newId();
    const linked = await attachVerifiedSubject(manager, { identityId: verified.id, subjectId });
    expect(linked.subjectId).toBe(subjectId);

    await expect(
      revokeVerification(member(tenantA), { identityId: identity.id, reason: 'account recycled' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      revokeVerification(manager, { identityId: identity.id, reason: '  ' }),
    ).rejects.toMatchObject({ code: 'invalid_identity_input' });

    const revoked = await revokeVerification(manager, { identityId: identity.id, reason: 'account recycled' });
    expect(revoked.status).toBe('revoked');
    expect(revoked.subjectId).toBeNull(); // trust gone → link gone
    expect(revoked.subjectKind).toBeNull();
    expect(revoked.revokedReason).toBe('account recycled');
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.verifiedAt).toBeNull();
    expect(revoked.verificationMethod).toBeNull();

    // revoked identities can neither enter the challenge flow nor be linked
    await expect(issueVerificationChallenge(member(tenantA), { identityId: identity.id })).rejects.toMatchObject({
      code: 'identity_revoked',
    });
    await expect(attachVerifiedSubject(manager, { identityId: identity.id, subjectId: newId() })).rejects.toMatchObject(
      { code: 'identity_not_verified' },
    );
    // ... but an explicit re-attestation restores verifiability
    const reattested = await attestIdentity(manager, {
      identityId: identity.id,
      evidence: 'ownership re-confirmed after investigation',
    });
    expect(reattested.status).toBe('verified');
    expect(reattested.subjectId).toBeNull(); // ...without restoring the revoked link
  });

  it('refuses to revoke identities that are not verified', async () => {
    const { identity } = await registerExternalIdentity(member(tenantA), {
      provider: 'instagram',
      providerAccountId: 'ada.ig',
    });
    await expect(
      revokeVerification(identityManager(tenantA), { identityId: identity.id, reason: 'nope' }),
    ).rejects.toMatchObject({ code: 'identity_not_verified' });
  });
});

describe('verified linking to subjects', () => {
  async function attestedIdentity(
    tenantId: string,
    provider: ChannelProvider,
    account: string,
  ): Promise<ExternalIdentity> {
    const { identity } = await registerExternalIdentity(member(tenantId), { provider, providerAccountId: account });
    return attestIdentity(identityManager(tenantId), {
      identityId: identity.id,
      evidence: `attested for ${provider}:${account}`,
    });
  }

  it('links only verified identities, only with the link authority', async () => {
    const manager = identityManager(tenantA);
    const subjectId = newId();

    const unverified = await registerExternalIdentity(member(tenantA), {
      provider: 'whatsapp',
      providerAccountId: '+15550200',
    });
    await expect(attachVerifiedSubject(member(tenantA), { identityId: unverified.identity.id, subjectId })).rejects.toMatchObject(
      { code: 'forbidden' }, // authority is checked before anything else
    );
    await expect(attachVerifiedSubject(manager, { identityId: unverified.identity.id, subjectId })).rejects.toMatchObject(
      { code: 'identity_not_verified' },
    );

    const verified = await attestedIdentity(tenantA, 'whatsapp', '+15550200');
    const linked = await attachVerifiedSubject(manager, { identityId: verified.id, subjectId });
    expect(linked.subjectId).toBe(subjectId);
    expect(linked.subjectKind).toBe('person');
    expect(linked.linkedAt).not.toBeNull();

    // idempotent re-attach to the same subject
    const again = await attachVerifiedSubject(manager, { identityId: verified.id, subjectId });
    expect(again.subjectId).toBe(subjectId);

    await expect(attachVerifiedSubject(manager, { identityId: verified.id, subjectId: newId() })).rejects.toMatchObject(
      { code: 'identity_already_linked' },
    );
    await expect(
      attachVerifiedSubject(manager, { identityId: verified.id, subjectId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'invalid_subject' });
  });

  it('never links across tenants', async () => {
    const inB = await attestedIdentity(tenantB, 'telegram', '79002');
    await expect(
      attachVerifiedSubject(identityManager(tenantA), { identityId: inB.id, subjectId: newId() }),
    ).rejects.toMatchObject({ code: 'identity_not_found' });
  });

  it('lists linked identities tenant-scoped and supports detaching', async () => {
    const manager = identityManager(tenantA);
    const subject = newId();
    const a = await attestedIdentity(tenantA, 'slack', 'U7001');
    const b = await attestedIdentity(tenantA, 'email', 'who@corp.example');
    await attachVerifiedSubject(manager, { identityId: a.id, subjectId: subject });
    await attachVerifiedSubject(manager, { identityId: b.id, subjectId: subject });

    const listed = await listSubjectIdentities(member(tenantA), subject);
    expect(listed.map((identity) => identity.id).sort()).toEqual([a.id, b.id].sort());
    // the same subject uuid in another tenant sees nothing — uuid collisions cannot leak
    expect(await listSubjectIdentities(member(tenantB), subject)).toEqual([]);

    const detached = await detachSubject(manager, { identityId: a.id });
    expect(detached.subjectId).toBeNull();
    expect(detached.status).toBe('verified'); // ownership stays proven; only the association is gone
    await expect(detachSubject(manager, { identityId: a.id })).rejects.toMatchObject({ code: 'identity_not_linked' });
    await expect(detachSubject(member(tenantA), { identityId: b.id })).rejects.toMatchObject({ code: 'forbidden' });
    // cross-tenant detach is not found
    await expect(detachSubject(identityManager(tenantB), { identityId: b.id })).rejects.toMatchObject({
      code: 'identity_not_found',
    });
  });
});
