-- W058 · auth module — principals (platform table, ADR-0001).
--
-- `auth_users` is the platform-level table of authenticated principals:
-- one row per human account (email + password verifier + display name).
-- The row's `id` IS the principal id every TenantContext carries
-- (organizations' membership rows store it as an opaque uuid — "the auth
-- module owns principals", see the organizations contract).
--
-- It cannot carry a tenant_id of its own: a principal exists BEFORE any
-- tenant (first-manager onboarding provisions the company), and one
-- principal may be a member of several companies (the product journey's
-- company switcher) — so the row is listed in scripts/arch-allowlist.json
-- as a platform table (IMPLEMENTATION-STACK §3), exactly like `tenants`.
--
-- The password verifier is a scrypt hash (see src/modules/auth/passwords.ts);
-- raw passwords are never stored. Email is the platform-global login key,
-- unique case-insensitively (stored normalized lowercase).

CREATE TABLE auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 16 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_users_email_unique UNIQUE (email)
);
