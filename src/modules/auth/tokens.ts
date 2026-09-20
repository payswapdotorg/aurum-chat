// Opaque token minting for sessions and invitations (W058).
//
// Doctrine (the api module's constant-time discipline): the raw token is
// 32 bytes of CSPRNG entropy presented base64url; ONLY its SHA-256 hex
// digest is ever stored or compared. Lookup is by digest equality on the
// unique index, and comparisons of digests use timingSafeEqual so no
// digest prefix leaks through timing.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Raw token entropy: 32 bytes → 43 base64url characters. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Raw invite code entropy: 24 bytes → 32 base64url characters (URL-path safe). */
export function mintInviteCode(): string {
  return randomBytes(24).toString('base64url');
}

/** SHA-256 hex digest of a raw token (what the tables store). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time equality of two hex digests (defensive; lookups are indexed). */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
