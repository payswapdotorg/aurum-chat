-- W016 · processes module — process intelligence.
--
-- The work item: "Reconstruct processes from events/observations; detect
-- bottlenecks, duplication, handoffs, manual effort and errors."
--
-- ARCHITECTURE.md §13: "Aurum reconstructs how work actually occurs from
-- observed events and identifies bottlenecks, repeated work, duplicated
-- entry, unnecessary handoffs, errors, approvals and manual effort."
--
-- Three tables, the missions module's (W011) split, deliberately identical
-- in discipline:
--
--   processes          — identity + the CURRENT version pointer + the
--                        tenant-unique name. Carries no reconstruction
--                        content: every model field lives in the version
--                        chain, so the current picture and the audit trail
--                        can never diverge. `current_version` advances by
--                        UPDATE (that is the pointer's only job); DELETE
--                        and TRUNCATE are rejected by trigger — a process's
--                        identity and history are never erased (there is no
--                        delete operation on the contract either).
--
--   process_versions   — the append-only AUDIT CHAIN: one row per
--                        reconstruction, each a FULL self-contained snapshot
--                        (evidence scope + reconstructed model + detection
--                        options + audit quartet). A reconstruction is
--                        versioned understanding, not reality: the
--                        immutable facts stay in the events (W003) and
--                        observations (W004) modules; this table stores what
--                        Aurum UNDERSTOOD about the flow, so any past
--                        reconstruction stays reconstructable (§24 decision
--                        evidence). UPDATE/DELETE/TRUNCATE are rejected by
--                        triggers — history cannot be rewritten even by a
--                        caller bypassing the service (the goals W008 /
--                        missions W011 / events W003 discipline).
--
--   process_findings   — the evidence-derived inefficiency findings
--                        (bottleneck / duplication / handoff /
--                        manual_effort / error), one row per (version,
--                        kind, subject), each citing the exact event and
--                        observation ids that justify it. Append-only by
--                        trigger like the versions they belong to: findings
--                        are derived intelligence over immutable evidence
--                        (the observations module's immutability
--                        discipline; lock 5/10 — an LLM-derived or
--                        rule-derived finding is evidence-cited
--                        intelligence, never authoritative truth).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on `processes` is the tenant-consistent target for
-- the version and finding foreign keys, and the composite FK
-- (process_id, tenant_id, version) → process_versions makes a
-- cross-tenant or dangling finding unrepresentable in SQL.

CREATE TABLE processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processes_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT processes_tenant_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX processes_tenant_idx ON processes (tenant_id);

CREATE TABLE process_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  process_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL CHECK (change_kind IN ('created', 'reconstructed')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- evidence scope (the reconstruction is reproducible from it: the
  -- underlying events/observations are immutable)
  event_types jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(event_types) = 'array'),
  observation_kinds jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(observation_kinds) = 'array'),
  case_key_candidates jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(case_key_candidates) = 'array'),
  occurred_from timestamptz,
  occurred_to timestamptz,
  world_entity_id uuid,
  -- reconstructed model (deterministic given the evidence + options)
  steps jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(steps) = 'array'),
  edges jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(edges) = 'array'),
  variants jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(variants) = 'array'),
  stats jsonb NOT NULL
    CHECK (jsonb_typeof(stats) = 'object'),
  -- detection options in force for this version's findings
  options jsonb NOT NULL
    CHECK (jsonb_typeof(options) = 'object'),
  -- audit quartet: who / when / what / why
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT process_versions_process_version_unique UNIQUE (tenant_id, process_id, version),
  CONSTRAINT process_versions_process_fk
    FOREIGN KEY (process_id, tenant_id) REFERENCES processes (id, tenant_id),
  CONSTRAINT process_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

-- History + current-view lookups: (tenant_id, process_id, version) is
-- covered by the unique constraint above.
CREATE INDEX process_versions_process_idx ON process_versions (tenant_id, process_id, version);

CREATE TABLE process_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  process_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL CHECK (kind IN ('bottleneck', 'duplication', 'handoff', 'manual_effort', 'error')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 512),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  metrics jsonb NOT NULL
    CHECK (jsonb_typeof(metrics) = 'object'),
  evidence_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_event_ids) = 'array'),
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'),
  confidence double precision NOT NULL
    CHECK (confidence >= 0 AND confidence <= 1),
  detected_by_principal text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT process_findings_version_unique UNIQUE (tenant_id, process_id, version, kind, subject),
  CONSTRAINT process_findings_process_fk
    FOREIGN KEY (process_id, tenant_id) REFERENCES processes (id, tenant_id),
  CONSTRAINT process_findings_version_fk
    FOREIGN KEY (process_id, tenant_id, version)
    REFERENCES process_versions (process_id, tenant_id, version)
);

-- Findings list/deep-link lookups.
CREATE INDEX process_findings_process_idx ON process_findings (tenant_id, process_id, version);
CREATE INDEX process_findings_filters_idx ON process_findings (tenant_id, kind, confidence);

-- Storage-level audit guarantee: a process's reconstruction history and its
-- findings are append-only. Nothing may UPDATE, DELETE or TRUNCATE them —
-- not even a future module bypassing the service. The message deliberately
-- names no row id so the same function serves the row-level and the
-- statement-level trigger.

CREATE OR REPLACE FUNCTION process_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'process versions are append-only (W016 process audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER process_versions_immutable
  BEFORE UPDATE OR DELETE ON process_versions
  FOR EACH ROW EXECUTE FUNCTION process_versions_reject_mutation();

CREATE TRIGGER process_versions_immutable_truncate
  BEFORE TRUNCATE ON process_versions
  FOR EACH STATEMENT EXECUTE FUNCTION process_versions_reject_mutation();

CREATE OR REPLACE FUNCTION process_findings_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'process findings are append-only (W016 evidence-derived findings): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER process_findings_immutable
  BEFORE UPDATE OR DELETE ON process_findings
  FOR EACH ROW EXECUTE FUNCTION process_findings_reject_mutation();

CREATE TRIGGER process_findings_immutable_truncate
  BEFORE TRUNCATE ON process_findings
  FOR EACH STATEMENT EXECUTE FUNCTION process_findings_reject_mutation();

-- The processes identity row may advance its version pointer (UPDATE) —
-- that is how versioning moves — but identity and history are never erased.

CREATE OR REPLACE FUNCTION processes_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'processes cannot be erased (W016): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER processes_immutable_delete
  BEFORE DELETE ON processes
  FOR EACH ROW EXECUTE FUNCTION processes_reject_erasure();

CREATE TRIGGER processes_immutable_truncate
  BEFORE TRUNCATE ON processes
  FOR EACH STATEMENT EXECUTE FUNCTION processes_reject_erasure();
