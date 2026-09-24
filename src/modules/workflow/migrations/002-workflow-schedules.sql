-- W080 · workflow module — cron-style schedules (evaluated by the worker
-- loop).
--
-- A schedule is tenant-scoped management configuration: which workflow
-- definition to run, under which 5-field cron expression (UTC-only —
-- pinned by CHECK), with which input, active or not. The evaluation
-- sweep (the engine's evaluateSchedules) walks occurrences strictly
-- after last_occurrence_at up to "now" and materializes one run per
-- occurrence.
--
-- workflow_schedule_firings is the append-only, IDEMPOTENT firing
-- ledger: UNIQUE (tenant, schedule, occurrence) means a fired
-- occurrence can never re-fire — a restarted or duplicate evaluation
-- sweep loses the insert race and skips (first write wins). The run
-- itself additionally carries the derived idempotency key
-- `sched:<scheduleId>:<occurrenceMs>` — belt and suspenders.
--
-- Schedules may be updated (active toggle, cursor movement — that is
-- how evaluation advances) but never erased: deactivate instead
-- (DELETE/TRUNCATE rejected by trigger, the workflow_runs precedent).

CREATE TABLE workflow_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_key text NOT NULL CHECK (
    definition_key ~ '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$'
  ),
  cron text NOT NULL CHECK (cron <> ''),
  -- UTC-only in W080 (the cron evaluator's contract); the column is
  -- pinned so a future multi-zone engine must migrate explicitly.
  timezone text NOT NULL DEFAULT 'UTC' CHECK (timezone = 'UTC'),
  active boolean NOT NULL DEFAULT true,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The evaluation cursor: the latest occurrence already materialized.
  last_occurrence_at timestamptz,
  -- Advisory next occurrence (recomputed on evaluation; never truth).
  next_occurrence_at timestamptz,
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT workflow_schedules_id_tenant_unique UNIQUE (id, tenant_id),
  -- The cursor and the advisory projection are ordered.
  CONSTRAINT workflow_schedules_occurrence_order CHECK (
    last_occurrence_at IS NULL
    OR next_occurrence_at IS NULL
    OR next_occurrence_at > last_occurrence_at
  )
);

CREATE INDEX workflow_schedules_tenant_idx
  ON workflow_schedules (tenant_id, created_at DESC);
CREATE INDEX workflow_schedules_due_idx
  ON workflow_schedules (tenant_id, active, last_occurrence_at);

CREATE TABLE workflow_schedule_firings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  -- The scheduled instant (cron boundary) this firing materializes.
  occurrence_at timestamptz NOT NULL,
  run_id uuid NOT NULL,
  fired_at timestamptz NOT NULL,
  CONSTRAINT workflow_schedule_firings_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workflow_schedule_firings_slot_unique UNIQUE (tenant_id, schedule_id, occurrence_at),
  CONSTRAINT workflow_schedule_firings_schedule_fk
    FOREIGN KEY (schedule_id, tenant_id) REFERENCES workflow_schedules (id, tenant_id)
);

CREATE INDEX workflow_schedule_firings_schedule_idx
  ON workflow_schedule_firings (tenant_id, schedule_id, occurrence_at DESC);

-- Append-only firing ledger (idempotency authority for schedules).
CREATE OR REPLACE FUNCTION workflow_schedule_firings_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow schedule firings are append-only evidence (W080 durable runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_schedule_firings_immutable
  BEFORE UPDATE OR DELETE ON workflow_schedule_firings
  FOR EACH ROW EXECUTE FUNCTION workflow_schedule_firings_reject_mutation();

CREATE TRIGGER workflow_schedule_firings_immutable_truncate
  BEFORE TRUNCATE ON workflow_schedule_firings
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_schedule_firings_reject_mutation();

-- Schedules are management configuration: updates advance the cursor or
-- flip active; erasure is forbidden (deactivate instead).
CREATE OR REPLACE FUNCTION workflow_schedules_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow schedules cannot be erased (W080 durable runtime): % is forbidden on table % — deactivate the schedule instead',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_schedules_immutable_delete
  BEFORE DELETE ON workflow_schedules
  FOR EACH ROW EXECUTE FUNCTION workflow_schedules_reject_erasure();

CREATE TRIGGER workflow_schedules_immutable_truncate
  BEFORE TRUNCATE ON workflow_schedules
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_schedules_reject_erasure();
