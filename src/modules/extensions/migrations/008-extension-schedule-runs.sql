-- W026 · extensions module — schedule invocation records (append-only).
--
-- One IMMUTABLE row per fired scheduled trigger of one install (§17
-- "scheduled triggers"). The host's scheduler decides WHEN (against
-- the manifest's cron declaration — grammar validated by W025); this
-- record is the runtime's half: the trigger fired, by whose call, at
-- what time, under which cron (recorded from the manifest at
-- invocation time — what fired, not what would fire today). The
-- extension's handler runs in the host's execution environment; its
-- outcomes are the extension's own telemetry.
--
-- Daily quota accounting (maxScheduleInvocationsPerDay of the current
-- deployment's manifest) counts these rows per (tenant, extension,
-- install, UTC day) — the index below is that lookup.
--
-- Storage-level append-only guarantee (the house pattern): the
-- triggers below reject UPDATE, DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite foreign key keeps a run tenant-consistent with its
-- extension.

CREATE TABLE extension_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  install_key text NOT NULL CHECK (
    install_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  schedule_name text NOT NULL CHECK (
    schedule_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  cron text NOT NULL CHECK (cron <> ''),
  invoked_by text NOT NULL CHECK (invoked_by <> ''),
  invoked_at timestamptz NOT NULL,
  CONSTRAINT extension_schedule_runs_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_schedule_runs_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id)
);

CREATE INDEX extension_schedule_runs_quota_idx
  ON extension_schedule_runs (tenant_id, extension_id, install_key, invoked_at);
CREATE INDEX extension_schedule_runs_list_idx
  ON extension_schedule_runs (tenant_id, extension_id, invoked_at DESC);

CREATE OR REPLACE FUNCTION extension_schedule_runs_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension schedule runs are append-only evidence (W026 extension runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_schedule_runs_immutable
  BEFORE UPDATE OR DELETE ON extension_schedule_runs
  FOR EACH ROW EXECUTE FUNCTION extension_schedule_runs_reject_mutation();

CREATE TRIGGER extension_schedule_runs_immutable_truncate
  BEFORE TRUNCATE ON extension_schedule_runs
  FOR EACH STATEMENT EXECUTE FUNCTION extension_schedule_runs_reject_mutation();
