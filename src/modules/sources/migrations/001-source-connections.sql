-- W036 · sources module — tenant-owned inbound connectors.
--
-- A source is one provider endpoint the tenant ingests authorized
-- information from: a Salesforce org, a HubSpot portal, a Jira site, a
-- Stripe account… (ARCHITECTURE.md §10). Polling resolves a source's
-- checkpoint through the fetch transport; webhook reception resolves the
-- envelope's account onto a registered source (see the service).
--
-- OAuth/credentials isolation (GOVERNANCE mandatory invariant;
-- IMPLEMENTATION-STACK §8): `credential_ref` is an OPAQUE reference into
-- the secret store — the credential VALUE (OAuth tokens, API keys,
-- passwords) never reaches any domain table, log line or contract result.
-- The domain tracks only NON-SECRET authorization state: the
-- classification (`auth_kind`), the granted scopes and the grant expiry
-- (`oauth_expires_at`), which the fetch transport may advance when it
-- refreshes a grant. A credentials-authorized source carries NO OAuth
-- state (CHECK-enforced).
--
-- Per-element scope shape (1..255 printable) is enforced by the
-- application validation layer; SQL CHECKs cannot express universal
-- quantifiers over array elements without subqueries, so the storage layer
-- guarantees array-ness and count only — the same split the notifications
-- module applies to deeply-shaped jsonb.
--
-- This is configuration + authorization state, NOT evidence: the mutable
-- fields after creation are `status` (enable/disable), the authorization
-- fields (updated by re-registration — the re-authorization path) and
-- `oauth_expires_at` (advanced by transport-reported grant refreshes). It
-- therefore carries none of the append-only immutability triggers the
-- observation-derived tables use; observations referencing a source id
-- keep their provenance because DELETE has no code path.
--
-- NOTE: the provider CHECK mirrors SOURCE_PROVIDERS in
-- src/modules/sources/validation.ts — keep both in sync.

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'salesforce', 'hubspot', 'zendesk', 'jira', 'linear', 'confluence',
    'notion', 'github', 'google-drive', 'google-calendar', 'stripe',
    'quickbooks', 'zapier'
  )),
  provider_account_id text NOT NULL,
  display_name text,
  auth_kind text NOT NULL CHECK (auth_kind IN ('oauth', 'credentials')),
  credential_ref text NOT NULL,
  oauth_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  oauth_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_tenant_provider_account_unique
    UNIQUE (tenant_id, provider, provider_account_id),
  CONSTRAINT sources_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT sources_provider_account_shape
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  CONSTRAINT sources_display_name_shape
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT sources_credential_shape
    CHECK (char_length(credential_ref) BETWEEN 1 AND 255),
  CONSTRAINT sources_oauth_scopes_shape CHECK (
    jsonb_typeof(oauth_scopes) = 'array'
    AND jsonb_array_length(oauth_scopes) <= 32
  ),
  CONSTRAINT sources_credentials_have_no_oauth_state CHECK (
    auth_kind <> 'credentials'
    OR (oauth_expires_at IS NULL AND jsonb_array_length(oauth_scopes) = 0)
  )
);

CREATE INDEX sources_tenant_provider_idx ON sources (tenant_id, provider, status);
CREATE INDEX sources_tenant_created_idx ON sources (tenant_id, created_at DESC);
