-- W030 · channels module — tenant-owned channel connections.
--
-- A connection is one provider endpoint the tenant SENDS through: a
-- WhatsApp business number, a Telegram bot, a Slack workspace app, an
-- email mailbox, a web widget origin… (ARCHITECTURE.md §3: tenants own
-- their channels). Outbound delivery resolves a connection; inbound
-- reception deliberately does NOT require one (channel accounts are
-- registered on sight through the identity contract, W002 — see the
-- service).
--
-- `credential_ref` is an OPAQUE reference into the secret store — the
-- credential VALUE never reaches any domain table (IMPLEMENTATION-STACK
-- §8; GOVERNANCE mandatory invariant: channel credentials are
-- tenant-scoped and never stored in semantic memory). Rotating a
-- credential means repointing the reference in the secret store.
--
-- This is configuration state, NOT evidence: the only mutable field after
-- creation is `status` (enable/disable), enforced by the service
-- (setChannelConnectionStatus). It therefore carries none of the
-- append-only immutability triggers the observation-derived tables use.
--
-- NOTE: the provider CHECK mirrors CHANNEL_PROVIDERS in
-- src/modules/identity/providers.ts — keep both in sync.

CREATE TABLE channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
    'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
  )),
  provider_account_id text NOT NULL,
  display_name text,
  credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_connections_tenant_provider_account_unique
    UNIQUE (tenant_id, provider, provider_account_id),
  CONSTRAINT channel_connections_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT channel_connections_provider_account_shape
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  CONSTRAINT channel_connections_display_name_shape
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT channel_connections_credential_shape
    CHECK (char_length(credential_ref) BETWEEN 1 AND 255)
);

CREATE INDEX channel_connections_tenant_provider_idx
  ON channel_connections (tenant_id, provider, status);
CREATE INDEX channel_connections_tenant_created_idx
  ON channel_connections (tenant_id, created_at DESC);
