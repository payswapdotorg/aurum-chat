-- W116 · auth module — the access waitlist (platform table) + platform admins.
--
-- PART 1: `auth_users.is_platform_admin` — the deterministic platform-admin
-- designation. A platform admin is the Aurum operator: the principal who
-- reviews the access waitlist (and, later, every other platform-governed
-- surface). Two ways the flag becomes true, both documented here and in the
-- module README:
--   * ENV BOOTSTRAP — AURUM_PLATFORM_ADMIN_EMAILS (comma-separated, exact
--     lowercase match): on SIGN-IN, a matching email grants the flag. This
--     is how the real operator designates themselves on a fresh deployment
--     without a seed. FAILS CLOSED when unset (no env grants at all).
--   * SEED/CONTRACT — the auth contract's setPlatformAdmin operation
--     (claim-gated on 'auth:platform-admin', mirroring the organizations
--     module's 'organizations:provision' provisioner pattern). The demo
--     harness uses it to make the manager persona a platform admin.
-- The column lives on the platform principals table (it is a property of
-- the PRINCIPAL, not of any tenant membership — platform authority never
-- rides a tenant session, the W058 interim doctrine).
--
-- PART 2: `auth_waitlist` — one row per signup request (W116: "signing up
-- should put you on a waitlist that the admin of Aurum chat should accept
-- before you get an account"). A pending request is NOT a user: no
-- auth_users row exists until an admin accepts, so the table is a PLATFORM
-- table (scripts/arch-allowlist.json, like `auth_users`) — it is keyed by
-- the platform-global email namespace and carries no tenant_id.
--
-- The password verifier (scrypt, passwords.ts) is captured AT REQUEST TIME
-- so acceptance never needs a second password transmission; it is copied
-- into the new auth_users row on accept. Lifecycle:
--   pending → accepted (an admin approved; the principal row is created or
--             already active — an invite may have let the person in first)
--   pending → declined (an admin refused; the optional one-line note is
--             shown to the requester on their next sign-in attempt)
-- Both decisions are auditable: decided_at + decided_by (the admin's
-- principal id). Rows are append-only history EXCEPT the pending row
-- itself: a duplicate signup for the same email UPDATES the pending row
-- (display name, verifier, requested_at — the idempotent re-request), and
-- a fresh request after accept/decline INSERTS a new pending row, so the
-- decision trail is never overwritten. The partial unique index is the
-- race-proof backstop for "one pending request per email", exactly like
-- auth_invites_pending_email.

ALTER TABLE auth_users
  ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

CREATE TABLE auth_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 16 AND 512),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES auth_users (id),
  note text CHECK (char_length(note) BETWEEN 1 AND 280)
);

CREATE INDEX auth_waitlist_email_idx ON auth_waitlist (email);

-- Only one PENDING request per email (see above).
CREATE UNIQUE INDEX auth_waitlist_pending_email
  ON auth_waitlist (email) WHERE status = 'pending';
