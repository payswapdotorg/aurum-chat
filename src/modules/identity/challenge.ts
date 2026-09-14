// Out-of-band verification challenges (pure logic, no database).
//
// A challenge proves that a human controls a provider account: the module
// mints a single-use, expiring, attempt-limited code; the channels module
// (W030) delivers it over the provider channel and feeds the response back.
// Only the sha-256 hash is persisted, bound to (tenant, identity) so a code
// can never be replayed against another identity or tenant.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** Challenge codes are 6 decimal digits (zero-padded). */
const CODE_DIGITS = 6;

/** Default time-to-live for a challenge: 15 minutes. */
export const DEFAULT_CHALLENGE_TTL_SECONDS = 900;

/** Smallest accepted custom ttl. */
export const CHALLENGE_TTL_MIN_SECONDS = 30;

/** Largest accepted custom ttl: 24 hours. */
export const CHALLENGE_TTL_MAX_SECONDS = 86_400;

/** Wrong attempts allowed per challenge before it is locked. */
export const CHALLENGE_MAX_ATTEMPTS = 5;

export function generateChallengeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(CODE_DIGITS, '0');
}

/** sha-256 of `tenant:identity:code` — binds a code to one identity in one tenant. */
export function hashChallengeCode(tenantId: string, identityId: string, code: string): string {
  return createHash('sha256').update(`${tenantId}:${identityId}:${code}`).digest('hex');
}

/** Constant-time comparison of a submitted code against the stored hash. */
export function challengeCodeMatches(
  expectedHash: string,
  tenantId: string,
  identityId: string,
  code: string,
): boolean {
  const actual = Buffer.from(hashChallengeCode(tenantId, identityId, code), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
