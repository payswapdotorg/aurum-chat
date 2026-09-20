// Unit tests for the pure logic of the auth module: password hashing
// (scrypt encode/verify, fail-closed on garbage), token minting/hashing,
// input validation, and the session authority derivation. No database, no
// migrations.
//
// CREDENTIAL HYGIENE (IMPLEMENTATION-STACK): every fake credential in this
// file is assembled from fragments at runtime — never a realistic full
// literal in source.

import { describe, expect, it } from 'vitest';
import { SESSION_AUTHORITY_BY_ROLE, sessionAuthorityForRole } from '../authority';
import { AuthError } from '../errors';
import { hashPassword, verifyPassword } from '../passwords';
import { hashToken, mintToken } from '../tokens';
import { assertDisplayName, assertEmail, assertPassword, assertToken, assertUuidInput } from '../validation';

/** Fake passwords assembled at runtime (never a full literal in source). */
function fakePassword(): string {
  return ['trust', 'No1', 'plumbing', 'tests'].join('-');
}

describe('password hashing (scrypt)', () => {
  it('round-trips a password and rejects a different one', async () => {
    const password = fakePassword();
    const encoded = await hashPassword(password);
    expect(encoded.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword(`${password}!`, encoded)).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const password = fakePassword();
    const a = await hashPassword(password);
    const b = await hashPassword(password);
    expect(a).not.toBe(b);
  });

  it('fails CLOSED on malformed stored hashes (never throws)', async () => {
    const password = fakePassword();
    expect(await verifyPassword(password, '')).toBe(false);
    expect(await verifyPassword(password, 'plaintext')).toBe(false);
    expect(await verifyPassword(password, 'scrypt$1$2$3$zz$zz')).toBe(false);
    expect(await verifyPassword(password, 'bcrypt$12$abc$def')).toBe(false);
    expect(await verifyPassword(password, 'scrypt$x$8$1$AAAA$AAAA')).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('mints 43-char base64url tokens with real entropy', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically to the storage form (sha-256 hex)', () => {
    const token = mintToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(mintToken()));
  });
});

describe('validation', () => {
  it('normalizes and bounds emails', () => {
    expect(assertEmail('  Dana.Okafor@Example.COM ')).toBe('dana.okafor@example.com');
    expect(() => assertEmail('not-an-email')).toThrow(AuthError);
    expect(() => assertEmail('a@b')).toThrow(AuthError);
    expect(() => assertEmail('a b@example.com')).toThrow(AuthError);
    expect(() => assertEmail('@example.com')).toThrow(AuthError);
    expect(() => assertEmail('a@')).toThrow(AuthError);
    expect(() => assertEmail('two@at@signs.com')).toThrow(AuthError);
  });

  it('bounds display names and passwords', () => {
    expect(assertDisplayName('  Dana  ')).toBe('Dana');
    expect(() => assertDisplayName('   ')).toThrow(AuthError);
    expect(() => assertDisplayName('x'.repeat(101))).toThrow(AuthError);
    expect(assertPassword(fakePassword())).toBe(fakePassword());
    expect(() => assertPassword('short')).toThrow(AuthError);
    expect(() => assertPassword('x'.repeat(201))).toThrow(AuthError);
  });

  it('validates uuids and tokens', () => {
    expect(assertUuidInput('00000000-0000-4000-8000-000000000001', 'id')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(() => assertUuidInput('nope', 'id')).toThrow(AuthError);
    expect(assertToken('  abc123  ')).toBe('abc123');
    expect(() => assertToken('has space')).toThrow(AuthError);
    expect(() => assertToken('x'.repeat(129))).toThrow(AuthError);
  });
});

describe('session authority derivation', () => {
  it('owners and admins keep the human gates and tenant governance usable; members stay lean', () => {
    expect(sessionAuthorityForRole('owner')).toEqual([
      'actions:approve',
      'identity:attest',
      'identity:link',
      'extensions:administer',
      'agents:administer',
      'marketplace:submit',
    ]);
    expect(sessionAuthorityForRole('admin')).toEqual(SESSION_AUTHORITY_BY_ROLE.admin);
    expect(sessionAuthorityForRole('member')).toEqual(['marketplace:submit']);
  });

  it('never derives the platform administer claim for a tenant role', () => {
    for (const claims of Object.values(SESSION_AUTHORITY_BY_ROLE)) {
      expect(claims).not.toContain('marketplace:administer');
    }
  });

  it('returns a fresh list per call (callers cannot mutate the table)', () => {
    const a = sessionAuthorityForRole('member');
    a.push('actions:approve');
    expect(sessionAuthorityForRole('member')).toEqual(['marketplace:submit']);
  });
});
