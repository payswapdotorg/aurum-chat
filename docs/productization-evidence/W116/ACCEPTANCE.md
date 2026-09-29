# W116 — Production Acceptance (the waitlist-gated authentication system)

**Date:** 2026-09-29 · **Verdict: PASS** · **Build:** d6a1d92 (main) · **URL:** aurum-chat-livid.vercel.app

The operator's directive: *"there needs to be a complete authentication system fit for the app's ambition. signing up should put you on a waitlist that the admin of aurum chat should accept before you get an account."*

## The journey, verified live on production

### 1. Signup lands on the waitlist — NOT an account
Anonymous `/signup`: the button now reads **"Request access"**; the copy explains
"Every request is reviewed by the Aurum team… Holding an invitation? It skips the queue."
Submitting a fresh request (Dana Whitfield / dana.whitfield@meridian-roasters.demo) renders
the confirmation state:

> **You're on the waitlist** — "The Aurum team will review your request. When your account
> is approved, sign in with the email and password you provided — your request is kept,
> you don't need to sign up again." · "Come back to the sign-in page to check the status
> of your request."

No principal row exists until an admin accepts (the migration header documents the
lifecycle: pending → accepted / declined, decided_at + decided_by auditable).

### 2. Pending sign-in is honest
Signing in as the pending requester returns the alert
**"your access request is awaiting admin approval"** — no account exists, no
existence leak beyond the requester's own knowledge (the uniform-error doctrine).

### 3. The admin surface is existence-safe
- Anonymous → `/platform/waitlist` redirects to `/signin` (no leak).
- Authenticated non-admin → redirects to `/chat` (no leak).
- Platform admins (the `is_platform_admin` designation) see the waitlist view:
  request rows as contact rows with Accept / Decline (covered by the module's
  136-test suite — service, contract, and page-level — all green on the merge).

### 4. The invitation bypass (by design)
Tara created an invitation (one-time code) → anonymous colleague opened the invite
link ("Meridian Acceptance Co invited you to Aurum") → "Create an account with
colleague.invite.test@aurum-test.dev" → the signup shows **"Create account"**
(the waitlist is skipped for invitation holders) → lands in the company `/chat`
with membership, zero page errors. The full two-person journey holds.

### 5. The completed auth surface
`/more` now carries **Change password** and **Sign out everywhere** alongside the
existing entries; session/token digest and scrypt properties are unchanged.

### 6. Health — the schema drift self-healed
`/api/health`: `status: ok` — `census 259 = expected 259, missing [], extra []`.
(The pre-existing production `auth_waitlist` table — created outside repo history
during the first implementation attempt — is now the migration-declared table;
the W118 extras diagnostic named it, the merge blessed it.)

## Production bootstrap — ONE operator action required

To review/accept waitlist requests on production, set the env var in the Vercel
project (Settings → Environment Variables):

```
AURUM_PLATFORM_ADMIN_EMAILS = <comma-separated emails, exact lowercase match>
```

On sign-in, a matching email grants platform admin (fails closed when unset).
Until set, requests accumulate pending — visible the moment the first admin
signs in. (Dev/demo world: the manager persona priya.nair@meridian-roasters.demo
is seeded as platform admin, with Dana's request pending — runnable locally via
the demo harness.)

## Evidence anchors
- Live verification: agent-browser session 2026-09-29 22:05–22:40 UTC (this document's
  quotes are verbatim from the rendered pages).
- Gates on the shipped merge (39c50d8): typecheck 0 errors · eslint 0 problems ·
  arch 701/326/250 · vitest 6245 passed / 0 failed / 23 skipped.
- Deploy history: e855ba7+39c50d8 (first attempt failed on a migration content-hash
  drift — my idempotent-guard edit vs the ledger's pinned hash; fixed by restoring
  the worker's exact bytes, d6a1d92 deployed clean at 22:19 UTC).
