// Password verifiers (W058). scrypt via Node's built-in crypto — no
// external dependency, no native build, and the parameters live below so
// tests can exercise the format round-trip without any DB.
//
// Storage format (self-describing, upgradeable):
//   scrypt$<N>$<r>$<p>$<salt-b64url>$<hash-b64url>
// Verification is timing-safe and accepts only the exact format above
// (an unknown scheme fails closed).

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AuthError } from './errors';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCHEME = 'scrypt';

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** Hash a password into the self-describing verifier format. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [SCHEME, String(SCRYPT_N), String(SCRYPT_R), String(SCRYPT_P), b64url(salt), b64url(hash)].join('$');
}

/**
 * Verify a password against a stored verifier. Constant-time on the digest
 * comparison; uniform `invalid_credentials` on any malformed input (fail
 * closed — never an exception that reveals which half failed).
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Password policy as one place (the service validates before hashing). */
export function assertPasswordPolicy(password: unknown): string {
  if (typeof password !== 'string') {
    throw new AuthError('invalid_input', 'password must be a string');
  }
  if (password.length < 8 || password.length > 200) {
    throw new AuthError('invalid_input', 'password must be 8–200 characters');
  }
  return password;
}
