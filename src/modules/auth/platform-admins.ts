// Platform-admin designation (W116) — the pure half: the env bootstrap
// parsing and the claim constant, no I/O, no database.
//
// WHO is a platform admin (deterministic + seedable, the work item's two
// designations):
//   * the FLAG — `auth_users.is_platform_admin` (migration 005) is the
//     stored source of truth; the session view carries it as
//     `platformAdmin` on every authentication;
//   * ENV BOOTSTRAP — AURUM_PLATFORM_ADMIN_EMAILS (comma-separated): on
//     SIGN-IN, a matching email grants the flag (the service writes it
//     through, so the grant persists). This is how the real operator
//     designates themselves on a fresh deployment without a seed. FAILS
//     CLOSED when unset: no email grants anything.
//   * SEED/CONTRACT — setPlatformAdmin (service.ts) is claim-gated on
//     AUTH_AUTHORITY_PLATFORM_ADMIN below, mirroring the organizations
//     module's ORGANIZATIONS_AUTHORITY_PROVISION provisioner pattern: the
//     claim never rides a session, it exists only inside an explicitly
//     constructed PlatformContext (the demo harness builds one while
//     seeding — never ambient, never session-wide).

/** The env var carrying the comma-separated platform-admin emails. */
export const PLATFORM_ADMIN_EMAILS_ENV = 'AURUM_PLATFORM_ADMIN_EMAILS';

/**
 * The platform-context authority claim that designates platform admins
 * outside the env bootstrap (the seed-time path). Platform claims never
 * ride a tenant session (W058 interim doctrine) — this string is only ever
 * placed on an explicitly constructed PlatformContext by the caller.
 */
export const AUTH_AUTHORITY_PLATFORM_ADMIN = 'auth:platform-admin';

/**
 * Parse the env bootstrap list: comma-separated emails, trimmed,
 * lowercased, empties dropped. Unset (or blank) yields an EMPTY set — the
 * fail-closed rule: nobody becomes an admin through the environment.
 */
export function platformAdminEmails(raw: string | undefined): Set<string> {
  const emails = new Set<string>();
  if (raw === undefined) return emails;
  for (const part of raw.split(',')) {
    const normalized = part.trim().toLowerCase();
    if (normalized !== '') emails.add(normalized);
  }
  return emails;
}
