-- W002 · people module — tenant-scoped person records.
--
-- A person is the tenant's human record. The composite UNIQUE (id, tenant_id)
-- is the target for the employees table's tenant-consistent foreign key:
-- an employment row can only reference a person of the SAME tenant.

CREATE TABLE persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  full_name text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT persons_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX persons_tenant_idx ON persons (tenant_id);
