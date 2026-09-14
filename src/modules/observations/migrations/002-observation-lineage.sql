-- W004 · observations module — extraction lineage edges (append-only).
--
-- One row per (child, parent) derivation edge: `observation_id` was derived
-- from `parent_observation_id` by the child's `lineage_method` (recorded on
-- the observation itself, together with the neutral extractor metadata).
-- Both foreign keys are tenant-consistent — an edge can never cross
-- tenants, even if the service layer were bypassed.
--
-- Edges exist only for observations created AFTER their parents (the
-- contract records lineage at creation time only), so the edge set is a DAG
-- by construction. Together with the immutability triggers this makes the
-- provenance graph append-only history.

CREATE TABLE observation_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  parent_observation_id uuid NOT NULL,
  -- Insertion position of the parent within the child's parent list: PG's
  -- now() is transaction-stable, so created_at cannot order edges recorded
  -- in one INSERT batch; `position` keeps parents deterministically in the
  -- order the recording call supplied them.
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT observation_lineage_child_fk
    FOREIGN KEY (observation_id, tenant_id) REFERENCES observations (id, tenant_id),
  CONSTRAINT observation_lineage_parent_fk
    FOREIGN KEY (parent_observation_id, tenant_id) REFERENCES observations (id, tenant_id),
  CONSTRAINT observation_lineage_unique UNIQUE (tenant_id, observation_id, parent_observation_id),
  CONSTRAINT observation_lineage_position_unique UNIQUE (tenant_id, observation_id, position),
  CONSTRAINT observation_lineage_no_self CHECK (observation_id <> parent_observation_id),
  CONSTRAINT observation_lineage_position_nonnegative CHECK (position >= 0)
);

CREATE INDEX observation_lineage_tenant_child_idx ON observation_lineage (tenant_id, observation_id);
CREATE INDEX observation_lineage_tenant_parent_idx ON observation_lineage (tenant_id, parent_observation_id);

-- Same storage-level immutability as the observations themselves: lineage
-- edges are append-only history.

CREATE OR REPLACE FUNCTION observation_lineage_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'observation lineage is immutable (architecture lock 5): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER observation_lineage_immutable
  BEFORE UPDATE OR DELETE ON observation_lineage
  FOR EACH ROW EXECUTE FUNCTION observation_lineage_reject_mutation();

CREATE TRIGGER observation_lineage_immutable_truncate
  BEFORE TRUNCATE ON observation_lineage
  FOR EACH STATEMENT EXECUTE FUNCTION observation_lineage_reject_mutation();
