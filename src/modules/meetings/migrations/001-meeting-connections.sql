-- W085 · meetings module — tenant-owned meeting capture endpoints and
-- their polling cursors.
--
-- A meeting connection is one authorized provider account the tenant
-- captures meeting intelligence from: a Zoom workspace, a Teams tenant, a
-- Meet workspace, a Recall meeting-bot account (ARCHITECTURE.md §3:
-- tenants own their sources; W085: "canonical
-- meeting/session/transcript/artifact contracts and native Zoom/Teams/Meet
-- adapters, plus optional cross-platform meeting-bot adapters").
-- Webhook reception resolves the envelope's account onto a registered
-- connection; polling fetches through the provider-neutral transport port
-- (see the service).
--
-- OAuth/credentials isolation (GOVERNANCE mandatory invariant;
-- IMPLEMENTATION-STACK §8): `credential_ref` is an OPAQUE reference into
-- the secret store — the credential VALUE (OAuth tokens, API keys, bot
-- secrets) never reaches any domain table, log line or contract result.
-- The domain tracks only NON-SECRET authorization state: the
-- classification (`auth_kind`), the granted scopes and the grant expiry
-- (`oauth_expires_at`), which the fetch transport may advance when it
-- refreshes a grant. A credentials-authorized connection carries NO OAuth
-- state (CHECK-enforced).
--
-- Per-element scope shape (1..255 printable) is enforced by the
-- application validation layer; SQL CHECKs cannot express universal
-- quantifiers over array elements without subqueries, so the storage layer
-- guarantees array-ness and count only — the same split the sources and
-- notifications modules apply to deeply-shaped jsonb.
--
-- This is configuration + authorization state, NOT evidence: the mutable
-- fields after creation are `status` (enable/disable), the authorization
-- fields (updated by re-registration — the re-authorization path) and
-- `oauth_expires_at` (advanced by transport-reported grant refreshes). It
-- therefore carries none of the append-only immutability triggers the
-- capture-evidence tables use; observations referencing a connection id
-- keep their provenance because DELETE has no code path.
--
-- MEETING POLLING CURSORS hold each connection's current fetch cursor:
-- the OPAQUE provider token the next poll resumes from (null = from the
-- beginning of the provider's window). Ingest FIRST, cursor SECOND: a
-- crash between them re-fetches the same window on the next poll and the
-- ingestion ledger suppresses what was already observed. This is live
-- ingestion state, not evidence: only `cursor` and `updated_at` may ever
-- move (guard trigger below); DELETE and TRUNCATE are forbidden. The
-- full checkpoint history / replay machinery is the sources module's
-- distinctive (W036); W085's acceptance requires no replay, so the live
-- cursor is all this module persists.
--
-- NOTE: the provider CHECKs in this module's migrations mirror
-- MEETING_PROVIDERS in src/modules/meetings/validation.ts — keep both in
-- sync (the same note the identity and sources migrations carry).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id.

CREATE TABLE meeting_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'zoom', 'microsoft-teams', 'google-meet', 'recall'
  )),
  provider_account_id text NOT NULL,
  display_name text,
  auth_kind text NOT NULL CHECK (auth_kind IN ('oauth', 'credentials')),
  credential_ref text NOT NULL,
  oauth_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  oauth_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_connections_tenant_provider_account_unique
    UNIQUE (tenant_id, provider, provider_account_id),
  CONSTRAINT meeting_connections_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_connections_provider_account_shape
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  CONSTRAINT meeting_connections_display_name_shape
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT meeting_connections_credential_shape
    CHECK (char_length(credential_ref) BETWEEN 1 AND 255),
  CONSTRAINT meeting_connections_oauth_scopes_shape CHECK (
    jsonb_typeof(oauth_scopes) = 'array'
    AND jsonb_array_length(oauth_scopes) <= 32
  ),
  CONSTRAINT meeting_connections_credentials_have_no_oauth_state CHECK (
    auth_kind <> 'credentials'
    OR (oauth_expires_at IS NULL AND jsonb_array_length(oauth_scopes) = 0)
  )
);

CREATE INDEX meeting_connections_tenant_provider_idx
  ON meeting_connections (tenant_id, provider, status);
CREATE INDEX meeting_connections_tenant_created_idx
  ON meeting_connections (tenant_id, created_at DESC);

CREATE TABLE meeting_ingestion_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  cursor text CHECK (cursor IS NULL OR char_length(cursor) BETWEEN 1 AND 1024),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_ingestion_cursors_connection_unique
    UNIQUE (tenant_id, connection_id),
  CONSTRAINT meeting_ingestion_cursors_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_ingestion_cursors_connection_fk
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES meeting_connections (id, tenant_id)
);

-- Storage-level guarantee: a cursor row can never be repointed at another
-- connection, and it can never be deleted — the current row is the live
-- resume state (the sources module's checkpoint discipline, minus the
-- history/replay tables W085 does not own).

CREATE OR REPLACE FUNCTION meeting_ingestion_cursors_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'meeting ingestion cursors are live ingestion state (W085 meetings): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'meeting ingestion cursors are live ingestion state (W085 meetings): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.connection_id <> OLD.connection_id THEN
    RAISE EXCEPTION 'meeting ingestion cursors are live ingestion state (W085 meetings): only the cursor and updated_at may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_ingestion_cursors_state_only_updates
  BEFORE UPDATE OR DELETE ON meeting_ingestion_cursors
  FOR EACH ROW EXECUTE FUNCTION meeting_ingestion_cursors_guard();

CREATE TRIGGER meeting_ingestion_cursors_immutable_truncate
  BEFORE TRUNCATE ON meeting_ingestion_cursors
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_ingestion_cursors_guard();
