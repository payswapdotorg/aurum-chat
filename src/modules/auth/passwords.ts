// Password hashing for the auth module — node:crypto scrypt with a random
// per-account salt, encoded self-describing so parameters can evolve.
//
// No external dependency (the stack's provider-neutrality doctrine applied
// to credentials: Node's own KDF). Verification is timing-safe.
//
// The encoded format: `scrypt$N$r$p$<salt b64>$<key b64>`.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { BinaryLike } from 'node:crypto';
import { promisify } from 'node:util';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

const promisifiedScrypt = promisify(scryptCallback) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** Hash a password (random salt). Never throws on well-formed input. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await promisifiedScrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against an encoded hash. Returns false for any
 * malformed/unknown encoding or invalid KDF parameters (never throws): a
 * bad stored hash must fail CLOSED, not crash the sign-in path.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n <= 1 || r <= 0 || p <= 0) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await promisifiedScrypt(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false; // invalid parameter combinations fail closed
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
