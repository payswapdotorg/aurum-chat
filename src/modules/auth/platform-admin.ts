// Platform-admin designation (W116) — the PURE vocabulary half.
//
// A platform admin is a PRINCIPAL fact (`auth_users.is_platform_admin`),
// never a tenant role and never a session claim: it gates exactly one
// surface family (the access waitlist review, /platform/waitlist) and is
// designated deterministically:
//
//   * AURUM_PLATFORM_ADMIN_EMAILS (comma-separated, case-insensitive) —
//     granted on sign-in. This is the production bootstrap: the operator
//     designates themselves with an environment variable. UNSET means
//     unset — no email ever matches (fail closed; see 006's header).
//
//   * The demo harness (W068) writes the flag through the auth
//     contract's explicit platform operation, gated on the
//     `auth:administer` authority claim below — the same explicit-context
//     posture `marketplace:administer` uses inside the harness (the
//     claim never rides a session at this base, so no HTTP surface can
//     ever reach the write).
//
// The flag is sticky: an env grant never revokes, and removing an email
// from the variable does not demote an already-granted principal.

import { envString } from '@/infra/config';

/**
 * The explicit platform-administration authority (W116). Carried ONLY by
 * harness/seed contexts, exactly like the platform claim
 * `marketplace:administer` — never derivable from a tenant role, never
 * riding a session (see claims.ts: platform claims are deliberately
 * absent from the interim role mapping).
 */
export const AUTH_AUTHORITY_ADMINISTER = 'auth:administer';

/** The env variable that designates production platform admins on sign-in. */
export const PLATFORM_ADMIN_EMAILS_ENV = 'AURUM_PLATFORM_ADMIN_EMAILS';

/**
 * The designated platform-admin emails (lowercase, deduplicated). UNSET
 * or blank means an EMPTY list — the grant fails closed, no email ever
 * matches. Blank entries are dropped so trailing commas are inert.
 */
export function platformAdminEmails(): string[] {
  const raw = envString(PLATFORM_ADMIN_EMAILS_ENV);
  if (raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (email !== '') seen.add(email);
  }
  return [...seen];
}

/** Does the (already normalized, lowercase) email carry the env designation? */
export function isDesignatedPlatformAdmin(email: string): boolean {
  return platformAdminEmails().includes(email);
}
