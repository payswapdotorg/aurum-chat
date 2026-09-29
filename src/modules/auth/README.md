# auth — Principals, Sessions, the Access Waitlist & Tenant Onboarding (W058 → W116)

The identity module of Aurum: platform principals (`auth_users` — the ids
every `TenantContext.principalId` carries), signed-in browser state
(`auth_sessions`), the principal's company directory
(`auth_user_companies`), tenant invitations (`auth_invites`) and — since
W116 — the **access waitlist** (`auth_waitlist`).

Public surface: `src/modules/auth/contract.ts` only (cross-module imports
of anything else are architecture violations detected by
`bun run arch`).

## W116 — the waitlist-gated signup

Signing up no longer creates an account. The public signup path
(`signUp`, the handler behind `POST /api/auth/sign-up`) records an access
request on the platform waitlist; a **platform admin** accepts or declines
it before any principal exists:

```
signup (no invite)          → auth_waitlist row, status pending
signup (?invite=<live code>) → immediate access (unchanged since W058 —
                               an invite is already admin-granted trust)
admin accepts                → auth_users row created from the verifier
                               captured at request time; request accepted
admin declines (+ note)      → request declined; the note is shown on the
                               requester's next sign-in attempt
```

Design notes:

* **A pending request is not a user.** `auth_waitlist` is a separate
  PLATFORM table (allowlisted in `scripts/arch-allowlist.json`) — the
  principal row is only created on acceptance. An alternative (a status
  column on `auth_users`) was rejected: it would create half-users in the
  principals table that every consumer must remember to filter.
* **The scrypt verifier is captured at request time** so acceptance never
  needs a second password transmission; the accept path copies it into
  the new `auth_users` row verbatim.
* **Idempotent re-request:** a duplicate pending signup for the same
  email updates the pending row (latest name, verifier and requested_at
  win). A fresh request after a decision inserts a NEW pending row — the
  decision trail is append-only. The response never reveals whether the
  email was already queued.
* **No existence leaks (house doctrine):** on sign-in, the
  pending/declined states are visible ONLY after the requester proved
  password knowledge against the captured verifier. Without that proof,
  unknown email / wrong password / wrong-queued-password are uniformly
  `invalid_credentials`. An email that already carries an ACTIVE account
  keeps the honest `email_taken` at signup (pre-W116 behavior — the
  person has an account; the waitlist is not for them).

## Platform admins (deterministic + seedable)

The flag lives on the principals table: `auth_users.is_platform_admin`
(migration `005-auth-waitlist.sql`). Two ways it becomes true:

1. **Env bootstrap (production):** `AURUM_PLATFORM_ADMIN_EMAILS` — a
   comma-separated list of emails. On **sign-in**, a matching email is
   granted the flag (the grant is persisted — it is a write-through, not
   a per-request check). This is how the operator designates themselves
   on a fresh deployment without a seed. **Fails closed when unset:** no
   email grants anything.
2. **Contract designation (seed/tests):** `setPlatformAdmin(ctx, …)` —
   claim-gated on `'auth:platform-admin'`
   (`AUTH_AUTHORITY_PLATFORM_ADMIN`), mirroring the organizations
   module's `'organizations:provision'` provisioner pattern: the claim
   never rides a session; it exists only on an explicitly constructed
   `PlatformContext` (the demo harness builds one while seeding).

The session view carries the flag (`AuthenticatedSession.platformAdmin`,
read from the row on every authentication) so surfaces can gate without
a second lookup. The admin area lives at `/platform/waitlist`
(the `(platform)` route group); decisions are native POST form actions to
`/api/platform/waitlist/decide` (never GET mutations), audited as
`decided_at` + `decided_by` (the admin's principal id).

The demo harness seeds the manager persona
(`priya.nair@meridian-roasters.demo`) as a platform admin and one pending
request (`dana.whitfield@meridian-roasters.demo`) so the whole journey is
walkable in the browser.

## Password change & sign out everywhere (W116)

`changePassword` (the `/more` → `/more/password` surface): current
password is re-verified (wrong = uniform `invalid_credentials`), the new
one is scrypt-hashed. **Session doctrine:** every OTHER session of the
principal is revoked; the session that performed the change stays signed
in — the person is mid-flow, and everyone else is honestly booted to
sign in again.

`signOutEverywhere` (button next to the password form): revokes EVERY
session of the principal, uniformly quiet like `signOut`.

## Invariants that predate W116 (unchanged)

* Credentials are never stored raw: passwords as scrypt verifiers
  (`passwords.ts`), session tokens and invite codes as SHA-256 digests
  only (`tokens.ts`).
* Sign-in failures are uniformly `invalid_credentials`; session failures
  are uniformly `unauthenticated` — the surface never learns WHY.
* The organizations module stays the sole membership authority; tenant
  switching re-verifies membership per request and can never cross scope.
* Migrations are append-only: 001 principals, 002 sessions, 003 user
  companies, 004 invites, 005 waitlist + platform admins.
