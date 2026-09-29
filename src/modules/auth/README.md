# auth — principals, sessions, and the access waitlist

The auth module owns the platform-level authentication domain: principals
(`auth_users`), sessions (`auth_sessions`), the principal's company
directory (`auth_user_companies`), tenant invitations (`auth_invites`) and —
since W116 — the access waitlist (`auth_waitlist`). Everything flows through
`contract.ts`; cross-module imports of anything else are architecture
violations.

## The access waitlist (W116)

Sign-up is **gated**: `POST /api/auth/sign-up` records a waitlist request
(email, display name, scrypt password verifier — captured at request time so
acceptance needs no second password transmission) instead of creating a
principal or issuing a session. The person stays signed out and sees the
confirmation state ("You're on the waitlist — the Aurum team will review
your request").

- **Invitations bypass the waitlist**: a live invite code keeps the
  immediate-access path (an invitation is already admin-granted trust); a
  dead code degrades to the waitlist.
- **Re-requests are idempotent**: one row per email (UNIQUE). A pending
  request refreshes in place; a DECLINED request resets to pending (the
  admin reviews the new request); an ACCEPTED request answers with the
  ordinary `email_taken` of registration.
- **Sign-in states**: correct credentials on a pending request →
  `request_pending` ("Your request is awaiting admin approval"); on a
  declined request → `request_declined` (with the admin's note). Wrong
  password / unknown email stay the uniform `invalid_credentials` — the
  requester proved nothing, so nothing about the queue leaks.
- **Accept** creates the principal from the captured material and records
  `decided_at`/`decided_by` (the deciding admin's principal id — every
  decision is auditable). **Decline** settles with an optional one-line
  note. Both are uniform `waitlist_not_found` for any non-pending shape.

## Who is a platform admin

Platform admins review the waitlist at `/platform/waitlist` (the
`(platform)` route group). The flag is a platform fact on `auth_users`
(`is_platform_admin`), never a tenant role:

1. **`AURUM_PLATFORM_ADMIN_EMAILS`** (comma-separated, case-insensitive):
   on sign-in, a matching email is granted the flag. This is the
   production bootstrap — the operator designates themselves with an
   environment variable, no seed, no database edit. **Fail closed**: when
   the variable is unset (the default), no email ever matches. The grant
   is sticky (removing an email never demotes an already-granted
   principal). Fresh deployments: a PENDING request for a designated
   email self-accepts at sign-in (the password proof keeps it
   takeover-proof; the waitlist row settles with `decided_by` = the
   principal's own id) — otherwise the first admin could never exist.
2. **The demo harness** (non-production only, refused in production
   runtimes by the demo gate) writes the flag through the auth contract's
   explicit `setPlatformAdminFlag` operation, gated on the
   `auth:administer` authority claim — a claim that never rides a session
   at this base, so no HTTP surface can reach the write.

See `migrations/005-auth-waitlist.sql` and
`migrations/006-auth-platform-admin.sql` for the schema-level rationale.

## Account operations (W116)

- **Change password** (`POST /api/auth/password`, reachable from `/more` →
  `/more/password`): current password must verify, the new one re-hashes
  with a fresh salt. Session policy: every OTHER session of the principal
  is revoked — this browser stays signed in, every other one signs out.
- **Sign out everywhere** (`POST /api/auth/sign-out-everywhere`): revokes
  every live session of the principal, this browser included.

The waitlist state is visible on sign-in attempt and to the admin — no
emails are sent in this iteration (no transport exists in the waitlist
path).
