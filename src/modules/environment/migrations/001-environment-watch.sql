-- W014 · environment module — Environment Watch.
--
-- The work item: "Implement company-specific external watchlists with
-- entities, topics, geography, regulators, competitors, suppliers,
-- freshness and escalation policy."
--
-- ARCHITECTURE.md §12: "EnvironmentWatch defines the external
-- entities/topics/geographies/regulators/laws/competitors/suppliers/
-- technologies/markets that matter to a tenant, with freshness and
-- escalation rules." Lock 18: EnvironmentWatch is a first-class concept.
--
-- Four tables, the processes module's (W016) discipline:
--
--   watchlists        — the tenant's named external-watch programmes
--                       (management controls: updatable, never erased;
--                       DELETE/TRUNCATE rejected by trigger, no update
--                       trigger). Each carries the REQUIRED default
--                       escalation policy for its entries. Freshness
--                       (stale-after) policies are NOT stored here — they
--                       live in the freshness module (W006) under the
--                       shared subject-kind namespace, key
--                       ('environment.watch', <entry id> | NULL default);
--                       exactly the wiring the freshness contract
--                       anticipates ("W014 its watch rules").
--
--   watch_entries     — the watched subjects along the three axes of the
--                       work item: entity entries (entity_kind from the
--                       §12 vocabulary: competitor / regulator /
--                       government_body / supplier / law / technology /
--                       market / industry), topic entries and geography
--                       entries, each optionally scoped by canonical
--                       geography slugs (where) and topic slugs (what
--                       aspects) and optionally bound to the world
--                       module's entity for the same external thing (an
--                       opaque forward reference validated through the
--                       world contract at write time — no cross-module
--                       foreign key, the repo-wide precedent). Controls:
--                       updatable (except the identity kind columns),
--                       never erased.
--
--   watch_signals     — the evidence-linked hits: one row per (tenant,
--                       entry, observation), severity-assessed at the
--                       bounded-reasoning seam and always backed by an
--                       immutable observation (W004) validated readable at
--                       write time; observed_at is denormalized from the
--                       observation so freshness math needs no re-read.
--                       APPEND-ONLY (triggers): a signal is a link over
--                       immutable evidence — a re-assessment is a NEW
--                       signal on the same observation of a DIFFERENT
--                       entry, or a new observation; the (entry,
--                       observation) pair never repeats.
--
--   watch_escalations — the append-only records that a watch's escalation
--                       policy fired: the SIGNAL arm (a signal at/above
--                       the resolved floor — one escalation per signal,
--                       partial UNIQUE) or the STALENESS arm (evidence
--                       stale past the freshness threshold for the grace
--                       period — one escalation per staleness episode,
--                       service-level dedupe anchored to the newest
--                       evidence). Every row SNAPSHOTS the resolved policy
--                       that governed it: later policy edits never rewrite
--                       what governed a recorded escalation (the
--                       notifications module's policy-snapshot discipline).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on `watchlists` is the tenant-consistent target
-- for the entry foreign keys, and the composite FKs (watch_entry_id,
-- tenant_id) make cross-tenant signals/escalations unrepresentable in SQL
-- even for a caller that bypasses the service (the world/processes
-- precedent).

CREATE TABLE watchlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- the REQUIRED default escalation policy for this list's entries
  -- (shape mirrored by watch_escalations_policy_shape below):
  --   signalSeverityFloor — one of the watch severities;
  --   staleGraceSeconds   — positive seconds or null (disarmed);
  --   staleSeverity       — required iff staleGraceSeconds is set;
  --   notifyParties       — 1..8 {kind,id?,label?} objects;
  --   proposeMission      — boolean.
  escalation_policy jsonb NOT NULL,
  created_by_principal text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watchlists_tenant_name_unique UNIQUE (tenant_id, name),
  CONSTRAINT watchlists_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT watchlists_policy_shape CHECK (
    jsonb_typeof(escalation_policy) = 'object'
    AND escalation_policy ? 'signalSeverityFloor'
    AND escalation_policy ? 'staleGraceSeconds'
    AND escalation_policy ? 'staleSeverity'
    AND escalation_policy ? 'notifyParties'
    AND escalation_policy ? 'proposeMission'
    AND (escalation_policy->>'signalSeverityFloor') IN ('low', 'medium', 'high', 'critical')
    AND jsonb_typeof(escalation_policy->'notifyParties') = 'array'
    AND jsonb_array_length(escalation_policy->'notifyParties') BETWEEN 1 AND 8
    AND (escalation_policy->>'proposeMission') IN ('true', 'false')
  ),
  CONSTRAINT watchlists_policy_coherent CHECK (
    (
      (escalation_policy->>'staleGraceSeconds') IS NULL
      AND (escalation_policy->>'staleSeverity') IS NULL
    )
    OR (
      (escalation_policy->>'staleGraceSeconds') ~ '^[1-9][0-9]*$'
      AND (escalation_policy->>'staleGraceSeconds')::integer BETWEEN 1 AND 2592000
      AND (escalation_policy->>'staleSeverity') IN ('low', 'medium', 'high', 'critical')
    )
  )
);

CREATE INDEX watchlists_tenant_status_idx ON watchlists (tenant_id, status);

CREATE TABLE watch_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  watchlist_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('entity', 'topic', 'geography')),
  entity_kind text
    CHECK (entity_kind IS NULL OR entity_kind IN (
      'competitor', 'regulator', 'government_body', 'supplier',
      'law', 'technology', 'market', 'industry'
    )),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  world_entity_id uuid,
  geographies jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(geographies) = 'array'),
  topics jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(topics) = 'array'),
  -- per-entry full-snapshot override; NULL = inherit the watchlist's policy
  escalation_policy jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_by_principal text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watch_entries_identity_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, watchlist_id, kind, entity_kind, name),
  CONSTRAINT watch_entries_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT watch_entries_watchlist_fk
    FOREIGN KEY (watchlist_id, tenant_id) REFERENCES watchlists (id, tenant_id),
  CONSTRAINT watch_entries_kind_coherent CHECK (
    (kind = 'entity' AND entity_kind IS NOT NULL)
    OR (kind <> 'entity' AND entity_kind IS NULL)
  ),
  CONSTRAINT watch_entries_geography_scope CHECK (
    kind <> 'geography' OR jsonb_array_length(geographies) = 0
  ),
  CONSTRAINT watch_entries_policy_shape CHECK (
    escalation_policy IS NULL OR (
      jsonb_typeof(escalation_policy) = 'object'
      AND escalation_policy ? 'signalSeverityFloor'
      AND escalation_policy ? 'staleGraceSeconds'
      AND escalation_policy ? 'staleSeverity'
      AND escalation_policy ? 'notifyParties'
      AND escalation_policy ? 'proposeMission'
      AND (escalation_policy->>'signalSeverityFloor') IN ('low', 'medium', 'high', 'critical')
      AND jsonb_typeof(escalation_policy->'notifyParties') = 'array'
      AND jsonb_array_length(escalation_policy->'notifyParties') BETWEEN 1 AND 8
      AND (escalation_policy->>'proposeMission') IN ('true', 'false')
    )
  ),
  CONSTRAINT watch_entries_policy_coherent CHECK (
    escalation_policy IS NULL
    OR (
      (
        (escalation_policy->>'staleGraceSeconds') IS NULL
        AND (escalation_policy->>'staleSeverity') IS NULL
      )
      OR (
        (escalation_policy->>'staleGraceSeconds') ~ '^[1-9][0-9]*$'
        AND (escalation_policy->>'staleGraceSeconds')::integer BETWEEN 1 AND 2592000
        AND (escalation_policy->>'staleSeverity') IN ('low', 'medium', 'high', 'critical')
      )
    )
  )
);

CREATE INDEX watch_entries_watchlist_idx ON watch_entries (tenant_id, watchlist_id);
CREATE INDEX watch_entries_filters_idx ON watch_entries (tenant_id, kind, entity_kind, status);

CREATE TABLE watch_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  watch_entry_id uuid NOT NULL,
  -- the backing observation (W004): an opaque forward reference validated
  -- readable through the observations contract at write time —
  -- deliberately NOT a foreign key (the freshness provenance precedent).
  observation_id uuid NOT NULL,
  -- observedAt of the backing observation, denormalized at record time so
  -- freshness math needs no re-read (the observation itself is immutable).
  observed_at timestamptz NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  -- the originating cognitive execution (W013), when one produced/processed
  -- the signal — opaque forward reference, validated at write time.
  origin_execution_id uuid,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watch_signals_entry_observation_unique
    UNIQUE (tenant_id, watch_entry_id, observation_id),
  CONSTRAINT watch_signals_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT watch_signals_entry_fk
    FOREIGN KEY (watch_entry_id, tenant_id) REFERENCES watch_entries (id, tenant_id)
);

-- Freshness evaluation: the newest signal per entry (observed_at, then
-- recorded_at, then id — deterministic).
CREATE INDEX watch_signals_entry_observed_idx
  ON watch_signals (tenant_id, watch_entry_id, observed_at DESC, recorded_at DESC, id DESC);
CREATE INDEX watch_signals_observation_idx ON watch_signals (tenant_id, observation_id);

CREATE TABLE watch_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  watch_entry_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('signal', 'stale')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  -- set iff trigger_kind = 'signal' (the firing signal); null for 'stale'
  signal_id uuid,
  -- the resolved policy snapshot AT ESCALATION TIME: a full
  -- WatchEscalationPolicy plus its resolution 'source'
  -- ('entry' | 'watchlist'). Later policy edits never rewrite it.
  policy_snapshot jsonb NOT NULL,
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watch_escalations_entry_fk
    FOREIGN KEY (watch_entry_id, tenant_id) REFERENCES watch_entries (id, tenant_id),
  CONSTRAINT watch_escalations_signal_fk
    FOREIGN KEY (signal_id, tenant_id) REFERENCES watch_signals (id, tenant_id),
  CONSTRAINT watch_escalations_signal_coherent CHECK (
    (trigger_kind = 'signal' AND signal_id IS NOT NULL)
    OR (trigger_kind = 'stale' AND signal_id IS NULL)
  ),
  CONSTRAINT watch_escalations_snapshot_shape CHECK (
    jsonb_typeof(policy_snapshot) = 'object'
    AND policy_snapshot ? 'policy'
    AND policy_snapshot ? 'source'
    AND (policy_snapshot->>'source') IN ('entry', 'watchlist')
    AND jsonb_typeof(policy_snapshot->'policy') = 'object'
    AND (policy_snapshot->'policy'->>'signalSeverityFloor') IN ('low', 'medium', 'high', 'critical')
    AND jsonb_typeof(policy_snapshot->'policy'->'notifyParties') = 'array'
    AND jsonb_array_length(policy_snapshot->'policy'->'notifyParties') BETWEEN 1 AND 8
    AND (policy_snapshot->'policy'->>'proposeMission') IN ('true', 'false')
  )
);

-- The signal arm fires at most once per signal — storage-enforced.
CREATE UNIQUE INDEX watch_escalations_signal_unique
  ON watch_escalations (tenant_id, signal_id)
  WHERE signal_id IS NOT NULL;

CREATE INDEX watch_escalations_entry_idx
  ON watch_escalations (tenant_id, watch_entry_id, recorded_at DESC, id DESC);
CREATE INDEX watch_escalations_trigger_idx ON watch_escalations (tenant_id, trigger_kind, recorded_at DESC);

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE a signal or an escalation — not even a future module bypassing
-- the service. The message deliberately names no row id so the same
-- function serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION watch_signals_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'watch signals are append-only (W014 evidence-linked hits): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watch_signals_immutable
  BEFORE UPDATE OR DELETE ON watch_signals
  FOR EACH ROW EXECUTE FUNCTION watch_signals_reject_mutation();

CREATE TRIGGER watch_signals_immutable_truncate
  BEFORE TRUNCATE ON watch_signals
  FOR EACH STATEMENT EXECUTE FUNCTION watch_signals_reject_mutation();

CREATE OR REPLACE FUNCTION watch_escalations_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'watch escalations are append-only (W014 escalation audit): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watch_escalations_immutable
  BEFORE UPDATE OR DELETE ON watch_escalations
  FOR EACH ROW EXECUTE FUNCTION watch_escalations_reject_mutation();

CREATE TRIGGER watch_escalations_immutable_truncate
  BEFORE TRUNCATE ON watch_escalations
  FOR EACH STATEMENT EXECUTE FUNCTION watch_escalations_reject_mutation();

-- Watchlists and watch entries are management CONTROLS: their content may
-- be updated (name, description, policies, status, updated_at), but
-- identity and history are never ERASED — signals and escalations
-- reference them, and "what were we watching back then" stays answerable
-- through the retained identity rows (full change history belongs to the
-- audit module, W046 — the freshness policy precedent).

CREATE OR REPLACE FUNCTION watchlists_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'watchlists cannot be erased (W014): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watchlists_immutable_delete
  BEFORE DELETE ON watchlists
  FOR EACH ROW EXECUTE FUNCTION watchlists_reject_erasure();

CREATE TRIGGER watchlists_immutable_truncate
  BEFORE TRUNCATE ON watchlists
  FOR EACH STATEMENT EXECUTE FUNCTION watchlists_reject_erasure();

CREATE OR REPLACE FUNCTION watch_entries_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'watch entries cannot be erased (W014): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watch_entries_immutable_delete
  BEFORE DELETE ON watch_entries
  FOR EACH ROW EXECUTE FUNCTION watch_entries_reject_erasure();

CREATE TRIGGER watch_entries_immutable_truncate
  BEFORE TRUNCATE ON watch_entries
  FOR EACH STATEMENT EXECUTE FUNCTION watch_entries_reject_erasure();
