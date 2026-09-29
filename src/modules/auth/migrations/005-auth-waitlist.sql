-- W116 · auth module — the access waitlist (platform table).
--
-- `auth_waitlist` is the platform-level queue of access requests: one row
-- per email that asked for an Aurum account through the public sign-up.
-- A pending request is NOT a user yet — that is why this is a separate
-- table instead of a status column on `auth_users`: every `auth_users`
-- row stays exactly what it always was (an ACTIVE principal whose
-- password verifier verifies, whose id sessions and memberships may
-- reference). A waitlist row only becomes a principal when a platform
-- admin accepts it; until then no session, no membership and no
-- TenantContext can ever point at it.
--
-- It is a PLATFORM table (scripts/arch-allowlist.json, like `auth_users`):
-- a request exists BEFORE any tenant and carries no tenant scoping by
-- design (ADR-0001 — platform tables are allowlisted).
--
-- Lifecycle: pending → accepted (the principal row is created from this
-- row's captured material; the person signs in and flows into onboarding
-- exactly like a fresh registration) | declined (with an optional
-- one-line admin note, shown to the requester on their next sign-in
-- attempt — they have proven password knowledge at that point, so the
-- state reveals nothing they are not entitled to know). A declined
-- requester may submit again: the row resets to pending (a fresh
-- requested_at; the admin reviews the new request). A re-request while
-- pending updates the captured material in place (idempotent
-- re-request — one row per email, enforced by the UNIQUE constraint).
--
-- The password verifier is captured at request time (scrypt, exactly like
-- `auth_users.password_hash`) so acceptance needs no second password
-- transmission; raw passwords are never stored. `decided_by` records the
-- deciding platform admin's principal id (`auth_users.id`) — every
-- accept/decline is auditable.
--
-- PLATFORM ADMIN DESIGNATION (see 006-auth-platform-admin.sql): platform
-- admins are `auth_users.is_platform_admin` principals, granted either by
-- the AURUM_PLATFORM_ADMIN_EMAILS environment variable on sign-in (the
-- production bootstrap; fail-closed when unset) or by the demo harness's
-- explicit, documented non-production seed. A live invitation code keeps
-- its immediate-access path and never touches this table: an invitation
-- is already admin-granted trust.

CREATE TABLE auth_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 16 AND 512),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 280),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES auth_users (id),
  CONSTRAINT auth_waitlist_email_unique UNIQUE (email)
);

CREATE INDEX auth_waitlist_status_requested_idx ON auth_waitlist (status, requested_at);
