// Unit tests for the auth module (W058) — pure logic, no database:
// password verifier round-trips and fail-closed behavior, token minting
// and digest discipline, the interim role→claim mapping, input
// validation, and the session lifetime policy boundaries.
//
// Fake credentials are assembled from fragments at runtime (never a
// realistic full literal in source — GitHub push protection).

import { describe, expect, it } from 'vitest';
import { claimsForRole, MANAGEMENT_CLAIMS } from '../claims';
import { AuthError } from '../errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../passwords';
import {
  INVITE_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  initialExpiry,
  inviteExpiry,
  isInviteExpired,
  isLive,
  renewal,
} from '../policy';
import { digestsEqual, hashToken, mintInviteCode, mintToken } from '../tokens';
import {
  assertDisplayName,
  assertEmail,
  assertInvitableRole,
  assertTokenShape,
  assertUuid,
} from '../validation';

const passwordFromFragments = (...parts: string[]): string => parts.join('');
const validPassword = (): string => passwordFromFragments('gr', 'een', '-tortoise-', '42');

describe('password verifiers', () => {
  it('round-trips a password through hash and verify', () => {
    const password = validPassword();
    const stored = hashPassword(password);
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain(password);
    expect(verifyPassword(password, stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword(validPassword());
    expect(verifyPassword(passwordFromFragments('wr', 'ong', '-password-9'), stored)).toBe(false);
  });

  it('produces different verifiers for the same password (random salt)', () => {
    expect(hashPassword(validPassword())).not.toBe(hashPassword(validPassword()));
  });

  it('fails closed on malformed verifiers (no throw, no leak)', () => {
    expect(verifyPassword('x'.repeat(16), 'not-a-verifier')).toBe(false);
    expect(verifyPassword('x'.repeat(16), 'bcrypt$foo$bar')).toBe(false);
    expect(verifyPassword('x'.repeat(16), 'scrypt$1$2$3$short')).toBe(false);
    expect(verifyPassword('x'.repeat(16), 'scrypt$A$B$C$####$%%%%')).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(() => assertPasswordPolicy(undefined)).toThrow(AuthError);
    expect(() => assertPasswordPolicy('short')).toThrow(AuthError);
    expect(() => assertPasswordPolicy('x'.repeat(201))).toThrow(AuthError);
    expect(assertPasswordPolicy(validPassword())).toBe(validPassword());
  });
});

describe('tokens', () => {
  it('mints long, url-safe, unique tokens', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    const code = mintInviteCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('digests are stable, hex, and never the raw token', () => {
    const token = mintToken();
    const digest = hashToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(token);
    expect(digestsEqual(digest, hashToken(token))).toBe(true);
    expect(digestsEqual(digest, hashToken(mintToken()))).toBe(false);
  });
});

describe('role → claim mapping (interim, W009 folds it)', () => {
  it('owners and admins carry the management claim set', () => {
    expect(claimsForRole('owner')).toEqual([...MANAGEMENT_CLAIMS]);
    expect(claimsForRole('admin')).toEqual([...MANAGEMENT_CLAIMS]);
    expect(claimsForRole('admin')).toContain('actions:approve');
  });

  it('members carry no claims', () => {
    expect(claimsForRole('member')).toEqual([]);
  });

  it('the mapping never mints platform claims', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(claimsForRole(role)).not.toContain('organizations:provision');
      expect(claimsForRole(role)).not.toContain('marketplace:administer');
    }
    // The vendor claim IS a tenant-level capability (any company may offer packages).
    expect(claimsForRole('owner')).toContain('marketplace:submit');
  });
});

describe('input validation', () => {
  it('accepts and normalizes valid emails', () => {
    expect(assertEmail('  Manager@Example.TEST ', 'email')).toBe(
      'manager@example.test',
    );
  });

  it('rejects malformed emails', () => {
    expect(() => assertEmail('no-at-sign', 'email')).toThrow(AuthError);
    expect(() => assertEmail('a@b', 'email')).toThrow(AuthError);
    expect(() => assertEmail('a b@c.test', 'email')).toThrow(AuthError);
    expect(() => assertEmail('', 'email')).toThrow(AuthError);
    expect(() => assertEmail(42, 'email')).toThrow(AuthError);
  });

  it('display names trim and enforce the length range', () => {
    expect(assertDisplayName('  Ada Lovelace  ', 'name')).toBe('Ada Lovelace');
    expect(() => assertDisplayName('   ', 'name')).toThrow(AuthError);
    expect(() => assertDisplayName('x'.repeat(201), 'name')).toThrow(AuthError);
  });

  it('uuids are validated case-insensitively', () => {
    const id = '00000000-0000-4000-8000-000000000ABC'.toLowerCase();
    expect(assertUuid('00000000-0000-4000-8000-000000000ABC', 'field')).toBe(id);
    expect(() => assertUuid('globex', 'field')).toThrow(AuthError);
    expect(() => assertUuid(null, 'field')).toThrow(AuthError);
  });

  it('token shapes fail closed', () => {
    expect(assertTokenShape('abcDEF123_-', 'token')).toBe('abcDEF123_-');
    expect(() => assertTokenShape('has space!', 'token')).toThrow(AuthError);
    expect(() => assertTokenShape('', 'token')).toThrow(AuthError);
    expect(() => assertTokenShape('x'.repeat(129), 'token')).toThrow(AuthError);
  });

  it('invitable roles exclude owner', () => {
    expect(assertInvitableRole(undefined)).toBe('member');
    expect(assertInvitableRole(null)).toBe('member');
    expect(assertInvitableRole('admin')).toBe('admin');
    expect(() => assertInvitableRole('owner')).toThrow(AuthError);
  });
});

describe('session lifetime policy', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const loginAt = new Date('2026-10-01T09:00:00.000Z');

  it('the constants encode the intended windows', () => {
    expect(SESSION_IDLE_TTL_MS).toBe(7 * DAY);
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(30 * DAY);
    expect(INVITE_TTL_MS).toBe(7 * DAY);
  });

  it('initial expiry is the first idle window', () => {
    expect(initialExpiry(loginAt).getTime()).toBe(loginAt.getTime() + SESSION_IDLE_TTL_MS);
  });

  it('isLive follows revocation and expiry', () => {
    const expires = new Date(loginAt.getTime() + DAY);
    expect(isLive(expires, null, loginAt)).toBe(true);
    expect(isLive(expires, null, new Date(expires.getTime() + 1))).toBe(false);
    expect(isLive(expires, loginAt, loginAt)).toBe(false);
  });

  it('renewal slides the idle window while the last seen is fresh (no write)', () => {
    const now = new Date(loginAt.getTime() + 30_000); // 30s later
    const decision = renewal(loginAt, loginAt, now);
    expect(decision.write).toBe(false);
  });

  it('renewal writes once the throttle elapses', () => {
    const now = new Date(loginAt.getTime() + 61_000); // 61s later
    const decision = renewal(loginAt, loginAt, now);
    expect(decision.write).toBe(true);
    expect(decision.lastSeenAt.getTime()).toBe(now.getTime());
    expect(decision.expiresAt.getTime()).toBe(now.getTime() + SESSION_IDLE_TTL_MS);
  });

  it('renewal never exceeds the absolute cap', () => {
    const nearCap = new Date(loginAt.getTime() + SESSION_ABSOLUTE_TTL_MS - DAY);
    const decision = renewal(loginAt, loginAt, nearCap);
    const absoluteDeadline = loginAt.getTime() + SESSION_ABSOLUTE_TTL_MS;
    expect(decision.expiresAt.getTime()).toBeLessThanOrEqual(absoluteDeadline);
    expect(decision.expiresAt.getTime()).toBe(absoluteDeadline); // the cap binds
    expect(decision.write).toBe(true);
  });

  it('a session with no touch yet renews on first activity', () => {
    const now = new Date(loginAt.getTime() + 90_000);
    const decision = renewal(loginAt, null, now);
    expect(decision.write).toBe(true);
    expect(decision.lastSeenAt.getTime()).toBe(now.getTime());
  });

  it('invite expiry bookkeeping', () => {
    const created = new Date('2026-10-01T09:00:00.000Z');
    expect(inviteExpiry(created).getTime()).toBe(created.getTime() + INVITE_TTL_MS);
    expect(isInviteExpired(inviteExpiry(created), created)).toBe(false);
    expect(
      isInviteExpired(inviteExpiry(created), new Date(created.getTime() + INVITE_TTL_MS + 1)),
    ).toBe(true);
  });
});
