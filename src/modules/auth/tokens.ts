// Opaque bearer tokens for sessions and invitations.
//
// Mint: 32 random bytes, base64url (43 chars, URL/copy-paste safe).
// Store: only the sha-256 hex of the token ever reaches a table — a
// database leak reveals nothing reusable. Lookup is by exact hash on a
// UNIQUE index; the token itself has 256 bits of entropy so guessing is
// hopeless and hash equality is not a timing oracle that matters.

import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_BYTES = 32;

/** A fresh opaque token (shown to the caller exactly once). */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** The storage form of a token (sha-256 hex). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
