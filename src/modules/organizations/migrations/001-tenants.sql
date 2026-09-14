-- W001 · organizations module — tenants (ADR-0001).
--
-- `tenants` is the platform-level root table of the whole tenant model: one
-- row per company. It anchors every tenant-scoped chain (tenant_members,
-- workspaces and workspace_members all reference it), so it cannot carry a
-- tenant_id of its own — it is listed in scripts/arch-allowlist.json as a
-- platform table (IMPLEMENTATION-STACK §3: "every domain table carries
-- tenant_id (except the platform allow-list)").
--
-- Tenant creation happens only through the explicit platform-level operation
-- provisionTenant (requires the `organizations:provision` claim); tenant
-- reads/writes always arrive with an explicit TenantContext pinned to
-- tenants.id. Slug is globally unique (platform namespace).

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_unique UNIQUE (slug)
);
