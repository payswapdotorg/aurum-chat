-- W026 · extensions module — host-rendered declarative UI documents.
--
-- One REPLACEABLE row per (tenant, extension, surface): the extension's
-- current declaration of what the HOST renders on that surface (§17
-- "host-rendered declarative UI"; §21/§22's control tower and briefing
-- surfaces are the primary consumers). The document is data only —
-- the closed block vocabulary (heading, text, metric, list, table,
-- divider) is validated by the runtime's shared pure rules
-- (runtime.ts uiDocumentProblems) before storage; there is
-- deliberately no scripting, no layout and no handler anywhere in the
-- model: the host renders data, the extension never ships code to the
-- UI layer (the isolation story).
--
-- A UI document is a declaration of what to render, like a policy:
-- legitimately updatable (publish replaces the document), identity
-- immutable (tenant, extension, surface, created_at), never deleted
-- through the runtime — triggers enforce the same for writes that
-- bypass the service. Whether a document renders at all is the
-- runtime's grant check (ui:render on the current deployment), not
-- this table's concern.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite foreign key keeps a declaration tenant-consistent with its
-- extension.

CREATE TABLE extension_ui (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  surface text NOT NULL CHECK (surface IN (
    'control-tower-panel', 'briefing-card', 'chat-panel', 'settings-form'
  )),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  updated_by text NOT NULL CHECK (updated_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT extension_ui_extension_surface_unique UNIQUE (tenant_id, extension_id, surface),
  CONSTRAINT extension_ui_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id)
);

CREATE INDEX extension_ui_tenant_updated_idx ON extension_ui (tenant_id, updated_at DESC);

-- Identity immutability + no DELETE/TRUNCATE: only the document
-- (document, updated_by, updated_at) may change.

CREATE OR REPLACE FUNCTION extension_ui_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extension UI declarations are replaceable, not deletable (W026 extension runtime): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'extension UI declarations are replaceable, not deletable (W026 extension runtime): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.extension_id <> OLD.extension_id
     OR NEW.extension_key <> OLD.extension_key
     OR NEW.surface <> OLD.surface
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'extension UI identity is immutable (W026 extension runtime): only the document (document, updated_by, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_ui_document_only_updates
  BEFORE UPDATE OR DELETE ON extension_ui
  FOR EACH ROW EXECUTE FUNCTION extension_ui_guard();

CREATE TRIGGER extension_ui_replaceable_truncate
  BEFORE TRUNCATE ON extension_ui
  FOR EACH STATEMENT EXECUTE FUNCTION extension_ui_guard();
