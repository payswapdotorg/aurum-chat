-- W086 · realtime module — tenant-owned realtime transport accounts.
--
-- A realtime connection is one authorized provider project the tenant's
-- realtime sessions run on: a LiveKit project, an OpenAI Realtime
-- project… (ARCHITECTURE.md §3: tenants own their provider accounts;
-- W086: "provider-neutral realtime session contracts with a replaceable
-- LiveKit adapter for Aurum voice, two-way meeting participation,
-- Meeting Companion and telephony/SIP").
--
-- Credential isolation (GOVERNANCE mandatory invariant; IMPLEMENTATION-
-- STACK §8): `credential_ref` is an OPAQUE reference into the secret
-- store — the credential VALUE (API keys, OAuth tokens, join grants)
-- never reaches any domain table, log line or contract result. The
-- domain tracks only NON-SECRET authorization state: the classification
-- (`auth_kind`), the granted scopes and the grant expiry. An api_key
-- connection carries NO OAuth state (CHECK-enforced).
--
-- This is configuration + authorization state, NOT evidence: the mutable
-- fields after creation are `status` (enable/disable) and the
-- authorization fields (updated by re-registration — the
-- re-authorization path). It therefore carries none of the append-only
-- immutability triggers the capture-evidence tables use; observations
-- referencing a connection id keep their provenance because DELETE has
-- no code path.
--
-- NOTE: the provider CHECKs in this module's migrations mirror
-- REALTIME_PROVIDERS in src/modules/realtime/validation.ts — keep both in
-- sync (the same note the identity, sources and meetings migrations
-- carry).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id.

CREATE TABLE realtime_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('livekit', 'openai-realtime')),
  provider_account_id text NOT NULL
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  auth_kind text NOT NULL CHECK (auth_kind IN ('api_key', 'oauth')),
  credential_ref text NOT NULL
    CHECK (char_length(credential_ref) BETWEEN 1 AND 255),
  oauth_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  oauth_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_connections_tenant_provider_account_unique
    UNIQUE (tenant_id, provider, provider_account_id),
  CONSTRAINT realtime_connections_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT realtime_connections_oauth_scopes_shape CHECK (
    jsonb_typeof(oauth_scopes) = 'array'
    AND jsonb_array_length(oauth_scopes) <= 32
  ),
  CONSTRAINT realtime_connections_api_key_has_no_oauth_state CHECK (
    auth_kind <> 'api_key'
    OR (oauth_expires_at IS NULL AND jsonb_array_length(oauth_scopes) = 0)
  )
);

CREATE INDEX realtime_connections_tenant_provider_idx
  ON realtime_connections (tenant_id, provider, status);
CREATE INDEX realtime_connections_tenant_created_idx
  ON realtime_connections (tenant_id, created_at DESC);
