// Unit tests for the identity module's pure logic (no database):
// provider vocabulary, challenge hashing/generation, context/authority
// gating.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import {
  assertTenantContext,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  requireAuthority,
} from '../access';
import {
  CHALLENGE_TTL_MAX_SECONDS,
  CHALLENGE_TTL_MIN_SECONDS,
  challengeCodeMatches,
  generateChallengeCode,
  hashChallengeCode,
} from '../challenge';
import { IdentityError } from '../errors';
import { assertChannelProvider, CHANNEL_PROVIDERS, isChannelProvider } from '../providers';

const CANONICAL_PROVIDERS = [
  'whatsapp',
  'telegram',
  'signal',
  'slack',
  'x',
  'instagram',
  'facebook',
  'linkedin',
  'email',
  'sms',
  'voice',
  'web',
] as const;

describe('channel providers (ADR-0015: neutral keys only)', () => {
  it('covers exactly the canonical provider set from ARCHITECTURE.md §9', () => {
    expect([...CHANNEL_PROVIDERS].sort()).toEqual([...CANONICAL_PROVIDERS].sort());
    expect(new Set(CHANNEL_PROVIDERS).size).toBe(CHANNEL_PROVIDERS.length);
  });

  it('recognizes members and rejects unknown or malformed values', () => {
    for (const provider of CANONICAL_PROVIDERS) {
      expect(isChannelProvider(provider)).toBe(true);
      expect(assertChannelProvider(provider)).toBe(provider);
    }
    for (const bad of ['teams', 'WhatsApp', 'whatsapp ', '', 'whats-app', null, 42]) {
      expect(isChannelProvider(bad)).toBe(false);
      expect(() => assertChannelProvider(bad)).toThrow(IdentityError);
    }
  });

  it('reports the invalid-provider error code', () => {
    try {
      assertChannelProvider('teams');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityError);
      expect((error as IdentityError).code).toBe('invalid_identity_input');
    }
  });
});

describe('verification challenge codes', () => {
  it('generates zero-padded 6-digit codes', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateChallengeCode()).toMatch(/^\d{6}$/);
    }
  });

  it('binds the stored hash to tenant, identity and code', () => {
    // Assemble fake values from fragments at runtime (GitHub push protection hygiene).
    const tenantId = newId();
    const otherTenant = newId();
    const identityId = newId();
    const otherIdentity = newId();
    const code = ['42', '5190'].join('');

    const hash = hashChallengeCode(tenantId, identityId, code);
    expect(hash).toBe(hashChallengeCode(tenantId, identityId, code)); // deterministic
    expect(hash).not.toBe(hashChallengeCode(otherTenant, identityId, code));
    expect(hash).not.toBe(hashChallengeCode(tenantId, otherIdentity, code));
    expect(hash).not.toBe(hashChallengeCode(tenantId, identityId, ['42', '5191'].join('')));

    expect(challengeCodeMatches(hash, tenantId, identityId, code)).toBe(true);
    expect(challengeCodeMatches(hash, tenantId, identityId, ['00', '0000'].join(''))).toBe(false);
    expect(challengeCodeMatches(hash, tenantId, otherIdentity, code)).toBe(false);
    expect(challengeCodeMatches(hash, otherTenant, identityId, code)).toBe(false);
  });

  it('exposes sane ttl bounds', () => {
    expect(CHALLENGE_TTL_MIN_SECONDS).toBeGreaterThan(0);
    expect(CHALLENGE_TTL_MAX_SECONDS).toBeGreaterThan(CHALLENGE_TTL_MIN_SECONDS);
  });
});

describe('tenant context and authority (ADR-0001)', () => {
  const context = { tenantId: newId(), principalId: newId(), authority: [IDENTITY_AUTHORITY_ATTEST] };

  it('accepts a well-formed explicit context', () => {
    expect(() => assertTenantContext(context)).not.toThrow();
  });

  it('rejects malformed contexts', () => {
    expect(() => assertTenantContext({ ...context, tenantId: '' })).toThrow(IdentityError);
    expect(() => assertTenantContext({ ...context, tenantId: '   ' })).toThrow(IdentityError);
    expect(() => assertTenantContext({ ...context, principalId: '' })).toThrow(IdentityError);
    expect(() =>
      assertTenantContext({ ...context, authority: 'admin' as unknown as string[] }),
    ).toThrow(IdentityError);
  });

  it('requires the exact authority claim', () => {
    expect(() => requireAuthority(context, IDENTITY_AUTHORITY_ATTEST)).not.toThrow();
    expect(() => requireAuthority({ ...context, authority: [] }, IDENTITY_AUTHORITY_ATTEST)).toThrow(
      IdentityError,
    );
    expect(() => requireAuthority(context, IDENTITY_AUTHORITY_LINK)).toThrow(IdentityError);
    expect(() => requireAuthority(context, 'identity:something-else')).toThrow(IdentityError);
  });

  it('reports the forbidden code and names the missing claim', () => {
    try {
      requireAuthority({ ...context, authority: [] }, IDENTITY_AUTHORITY_LINK);
      expect.unreachable();
    } catch (error) {
      expect((error as IdentityError).code).toBe('forbidden');
      expect((error as IdentityError).message).toContain(IDENTITY_AUTHORITY_LINK);
    }
  });
});
