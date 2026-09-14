-- W002 · people module — employment records.
--
-- One employment per person per tenant (employees_person_unique); the
-- composite foreign key (person_id, tenant_id) → persons (id, tenant_id)
-- guarantees an employee row can never reference another tenant's person,
-- even if the service layer were bypassed. Employee numbers are unique per
-- tenant when present (partial unique index).

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  person_id uuid NOT NULL,
  employee_number text,
  title text,
  department text,
  hired_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'on_leave', 'terminated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_person_fk FOREIGN KEY (person_id, tenant_id) REFERENCES persons (id, tenant_id),
  CONSTRAINT employees_person_unique UNIQUE (tenant_id, person_id)
);

CREATE UNIQUE INDEX employees_tenant_number_unique ON employees (tenant_id, employee_number)
  WHERE employee_number IS NOT NULL;
CREATE INDEX employees_tenant_idx ON employees (tenant_id);
