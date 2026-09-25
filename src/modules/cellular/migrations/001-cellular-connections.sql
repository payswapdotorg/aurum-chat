-- W087 · cellular module — tenant-owned telecom connections.
--
-- A connection is one telecom vendor account the tenant REACHES people
-- through (a Twilio account, a Telnyx messaging profile) with its E.164
-- sending number (ARCHITECTURE.md §3: tenants own their channels). SMS
-- sends and voice fallback calls originate from this number; carrier
-- webhooks (replies, delivery receipts, call events) resolve onto the
-- account.
--
-- `credential_ref` is an OPAQUE reference into the secret store — the
-- credential VALUE never reaches any domain table (IMPLEMENTATION-STACK
-- §8; GOVERNANCE mandatory invariant: channel credentials are
-- tenant-scoped and never stored in semantic memory). Rotating a
-- credential means repointing the reference in the secret store.
--
-- This is configuration state, NOT evidence: re-registration is the
-- RE-AUTHORIZATION path (credential reference, sending number and
-- display name may move; the endpoint's identity never changes — the
-- realtime module's connection discipline), and the only other mutable
-- field is `status` (enable/disable). It therefore carries none of the
-- append-only immutability triggers the evidence tables use.
--
-- NOTE: the provider CHECK mirrors CELLULAR_PROVIDERS in
-- src/modules/cellular/policy.ts — keep both in sync.

CREATE TABLE cellular_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('twilio', 'telnyx')),
  provider_account_id text NOT NULL
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  credential_ref text NOT NULL CHECK (char_length(credential_ref) BETWEEN 1 AND 255),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cellular_connections_tenant_provider_account_unique
    UNIQUE (tenant_id, provider, provider_account_id),
  CONSTRAINT cellular_connections_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX cellular_connections_tenant_provider_idx
  ON cellular_connections (tenant_id, provider, status);
CREATE INDEX cellular_connections_tenant_created_idx
  ON cellular_connections (tenant_id, created_at DESC);
