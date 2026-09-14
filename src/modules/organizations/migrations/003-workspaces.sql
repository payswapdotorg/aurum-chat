-- W001 · organizations module — workspaces (ADR-0001).
--
-- A workspace partitions one tenant's experience; it is directly
-- tenant-scoped (tenant_id — arch gate rule (d)) and never weakens tenant
-- isolation. Slug is unique per tenant: tenants have independent slug
-- namespaces. created_by is the creating principal (opaque uuid), kept as
-- lightweight provenance.

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_tenant_slug_unique UNIQUE (tenant_id, slug)
);

CREATE INDEX workspaces_tenant_idx ON workspaces (tenant_id);
