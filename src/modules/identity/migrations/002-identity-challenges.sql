-- W002 · identity module — out-of-band verification challenges.
--
-- A challenge proves control of a provider account: the service mints a
-- single-use, expiring, attempt-limited 6-digit code (stored only as a
-- sha-256 hash bound to tenant + identity); the channels module (W030)
-- delivers it over the provider channel and feeds the response back.
--
-- Lifecycle: a newer challenge supersedes all outstanding older ones
-- (superseded_at); a successful response consumes it (consumed_at); wrong
-- responses burn attempts (attempts / max_attempts) and exhaustion
-- invalidates the challenge.

CREATE TABLE identity_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  code_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  consumed_at timestamptz,
  superseded_at timestamptz
);

CREATE INDEX identity_challenges_tenant_identity_idx ON identity_challenges (tenant_id, identity_id);
