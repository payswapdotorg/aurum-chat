-- W094 · migration-continuity module — Migration and Dual-Run
-- Continuity: the migration LIFECYCLE and its records. Imported
-- conversations / evidence / people land as REAL rows in the owning
-- modules' tables through their public contract writes; this module
-- owns ONLY the migration records: the run + its transition ledger,
-- the import manifests (counts in/out + content checksums + the
-- per-record landing ledger — the no-silent-data-loss record), the
-- cross-system identity mappings (incumbent id <-> Aurum id, with
-- provenance and a verification state — ambiguous NEVER auto-merged),
-- the dual-run sync runs, the surfaced conflicts (both versions,
-- timestamps, provenance, a machine-readable taxonomy — never
-- auto-resolved), the reconcile-based comparison reports, and the
-- progressive-retirement windows per entity kind.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). Nothing provider-named appears anywhere: the incumbent is
-- the W081 inventory system id + plain-language descriptors, the OPAQUE
-- W082 broker-connection id, and opaque incumbent record ids/targets;
-- the only incumbent-minted values that reach these tables are OPAQUE
-- strings (back-write receipt details). Credential VALUES never reach
-- these tables at all (the W082 discipline: the opaque credentialRef is
-- re-read from the connection per pass and passes straight through to
-- the W084 transport port).
--
-- State model (the governed lifecycle, mirrored by the shapes):
--   * migration_runs              — staged → imported → dual-running →
--                                  retiring-incumbent → retired, with
--                                  the W081 system + W082 connection +
--                                  the W083 capability keys every
--                                  incumbent access rides.
--   * migration_transitions       — the append-only transition ledger
--                                  (forward AND rollback, each row with
--                                  machine-readable evidence).
--   * migration_import_manifests  — per-batch: entity kind, resolution,
--                                  counts in/out, content checksums, the
--                                  contract write that landed the batch,
--                                  the per-record landing ledger.
--   * migration_identity_mappings — incumbent id <-> Aurum id with
--                                  verification state + provenance +
--                                  the dual-run sync checkpoints.
--   * migration_sync_runs         — one row per dual-run sync pass with
--                                  honest back-write outcomes.
--   * migration_conflicts         — surfaced conflicts with BOTH
--                                  versions + the W084 reconciliation
--                                  diff; resolution is human-only.
--   * migration_comparison_reports— per entity kind: matched / diverged
--                                  / incumbent-only / aurum-only, built
--                                  on the W084 reconcileOperation.
--   * migration_retirement_windows— per entity kind: open → retired |
--                                  rolled-back; rollback re-opens as a
--                                  NEW row (the trail is retained).
--   * migration_events            — append-only lifecycle audit.
--   * migration_idempotency       — caller-supplied staging dedupe keys.

-- ---------------------------------------------------------------------------
-- Runs — the durable lifecycle record
-- ---------------------------------------------------------------------------

CREATE TABLE migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The concrete migration context (frozen at staging; the W083/W084
  -- shape): {description, requestedFor}.
  task_context jsonb NOT NULL CHECK (jsonb_typeof(task_context) = 'object'),
  -- The W081 Tool & System Inventory record of the incumbent system.
  system_id uuid NOT NULL,
  -- The incumbent's canonical W081 system key + display name.
  system_key text NOT NULL CHECK (char_length(system_key) BETWEEN 1 AND 256),
  system_display_name text NOT NULL CHECK (char_length(system_display_name) BETWEEN 1 AND 256),
  -- The OPAQUE W082 broker connection the whole migration rides.
  connection_id uuid NOT NULL,
  -- The READ capability every incumbent read invokes (W081/W083 key).
  read_capability_key text NOT NULL CHECK (char_length(read_capability_key) BETWEEN 1 AND 128),
  -- The WRITE capability back-writes invoke; null = the incumbent
  -- accepts no Aurum back-writes.
  write_capability_key text CHECK (
    write_capability_key IS NULL OR char_length(write_capability_key) BETWEEN 1 AND 128
  ),
  -- The lifecycle (forward-only through the service; every transition
  -- and its reverse recorded in migration_transitions).
  state text NOT NULL DEFAULT 'staged' CHECK (state IN (
    'staged', 'imported', 'dual-running', 'retiring-incumbent', 'retired'
  )),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT migration_runs_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX migration_runs_tenant_state_idx
  ON migration_runs (tenant_id, state, created_at DESC);

-- ---------------------------------------------------------------------------
-- Transitions — the append-only lifecycle ledger (forward + rollback)
-- ---------------------------------------------------------------------------

CREATE TABLE migration_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- Monotonic per-migration position: the ledger order.
  position integer NOT NULL CHECK (position >= 1),
  kind text NOT NULL CHECK (kind IN ('forward', 'rollback')),
  -- Null only on the initial `staged` row.
  from_state text CHECK (
    from_state IS NULL OR from_state IN (
      'staged', 'imported', 'dual-running', 'retiring-incumbent', 'retired'
    )
  ),
  to_state text NOT NULL CHECK (to_state IN (
    'staged', 'imported', 'dual-running', 'retiring-incumbent', 'retired'
  )),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  -- Machine-readable evidence of the transition (counts, windows,
  -- receipts — the probe material).
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT migration_transitions_position_unique UNIQUE (tenant_id, migration_id, position),
  CONSTRAINT migration_transitions_id_tenant_unique UNIQUE (id, tenant_id),
  -- Only the initial row starts from nothing.
  CONSTRAINT migration_transitions_initial_shape CHECK (
    from_state IS NOT NULL OR (kind = 'forward' AND to_state = 'staged')
  )
);

CREATE INDEX migration_transitions_migration_idx
  ON migration_transitions (tenant_id, migration_id, position);

-- ---------------------------------------------------------------------------
-- Import manifests — the no-silent-data-loss record (per batch)
-- ---------------------------------------------------------------------------

CREATE TABLE migration_import_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- 1-based batch order (frozen at staging).
  batch_no integer NOT NULL CHECK (batch_no >= 1),
  -- The OPAQUE incumbent collection target the batch read.
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 256),
  -- The incumbent's own entity-kind label.
  entity_kind text NOT NULL CHECK (char_length(entity_kind) BETWEEN 1 AND 128),
  -- How the kind resolved onto Aurum's real owning surfaces (null while
  -- planned): conversation | person | kit-kind | raw-evidence.
  resolution text CHECK (resolution IN (
    'conversation', 'person', 'kit-kind', 'raw-evidence'
  )),
  -- The installed kit that declared the kind (resolution 'kit-kind').
  kit_key text CHECK (kit_key IS NULL OR char_length(kit_key) BETWEEN 1 AND 128),
  kit_entity text CHECK (kit_entity IS NULL OR char_length(kit_entity) BETWEEN 1 AND 128),
  -- The owning contract write that landed the batch (plain-language).
  contract_write text CHECK (contract_write IS NULL OR char_length(contract_write) BETWEEN 1 AND 128),
  -- Counts in/out: records read from the incumbent vs records landed
  -- through the owning contract writes.
  expected_count integer NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  landed_count integer NOT NULL DEFAULT 0 CHECK (landed_count >= 0),
  -- sha-256 of the canonical JSON of the records as read / as landed
  -- (read back through the owning contracts).
  source_checksum text CHECK (source_checksum IS NULL OR char_length(source_checksum) = 64),
  landed_checksum text CHECK (landed_checksum IS NULL OR char_length(landed_checksum) = 64),
  -- The per-record landing ledger: [{incumbentId, aurumId, aurumKind}].
  landed_records jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(landed_records) = 'array'),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'ok', 'mismatch')),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 2000),
  imported_at timestamptz,
  CONSTRAINT migration_manifests_batch_unique UNIQUE (tenant_id, migration_id, batch_no),
  CONSTRAINT migration_manifests_id_tenant_unique UNIQUE (id, tenant_id),
  -- A planned batch has read nothing yet; a finished one always says
  -- when. A clean batch landed exactly what it read.
  CONSTRAINT migration_manifests_planned_shape CHECK (
    status <> 'planned' OR (expected_count = 0 AND landed_count = 0
      AND source_checksum IS NULL AND landed_checksum IS NULL AND imported_at IS NULL)
  ),
  CONSTRAINT migration_manifests_finished_shape CHECK (
    status = 'planned' OR imported_at IS NOT NULL
  ),
  CONSTRAINT migration_manifests_ok_clean CHECK (
    status <> 'ok' OR (expected_count = landed_count AND landed_count > 0
      AND source_checksum IS NOT NULL AND landed_checksum IS NOT NULL)
  ),
  -- The kit columns exist exactly when the resolution is 'kit-kind'.
  CONSTRAINT migration_manifests_kit_shape CHECK (
    (resolution = 'kit-kind') = (kit_key IS NOT NULL AND kit_entity IS NOT NULL)
  ),
  -- A resolved batch records the contract write that landed it.
  CONSTRAINT migration_manifests_resolved_write CHECK (
    resolution IS NULL OR contract_write IS NOT NULL
  )
);

CREATE INDEX migration_manifests_migration_idx
  ON migration_import_manifests (tenant_id, migration_id, batch_no);

-- ---------------------------------------------------------------------------
-- Identity mappings — incumbent id <-> Aurum id (W095 discipline)
-- ---------------------------------------------------------------------------

CREATE TABLE migration_identity_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- The incumbent's own record id (opaque string).
  incumbent_id text NOT NULL CHECK (char_length(incumbent_id) BETWEEN 1 AND 200),
  -- The incumbent's entity kind for the record.
  incumbent_kind text NOT NULL CHECK (char_length(incumbent_kind) BETWEEN 1 AND 128),
  -- The Aurum row the record landed as (null while ambiguous/unmerged).
  aurum_id uuid,
  -- The Aurum row kind: conversation | person | observation.
  aurum_kind text CHECK (
    aurum_kind IS NULL OR aurum_kind IN ('conversation', 'person', 'observation')
  ),
  -- The CURRENT Aurum view of the logical record (a sync-update
  -- observation supersedes the originally landed row; the original
  -- stays as immutable evidence).
  current_aurum_id uuid,
  -- The W095 verification semantics re-used: verified, or
  -- unverified-external when ambiguous — NEVER auto-merged.
  verification_state text NOT NULL CHECK (verification_state IN (
    'verified', 'unverified-external'
  )),
  match_basis text NOT NULL CHECK (match_basis IN (
    'import-created', 'sync-created', 'ambiguous-candidates',
    'conflicting-attributes', 'human-resolution'
  )),
  -- Candidate organizational records when ambiguous (never auto-merged).
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(candidates) = 'array'),
  -- Provenance: {attributes, batchNo, resolvedBy, resolutionNote, ...}.
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  -- Dual-run sync checkpoints: sha-256 of the canonical incumbent /
  -- Aurum versions at the last pass (conflict detection's baseline),
  -- plus the incumbent's canonical form as last seen (the W084
  -- pre-state of the reconcile-based comparison).
  last_incumbent_checksum text CHECK (last_incumbent_checksum IS NULL OR char_length(last_incumbent_checksum) = 64),
  last_aurum_checksum text CHECK (last_aurum_checksum IS NULL OR char_length(last_aurum_checksum) = 64),
  last_incumbent_form jsonb CHECK (
    last_incumbent_form IS NULL OR jsonb_typeof(last_incumbent_form) = 'object'
  ),
  mapped_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- One incumbent record maps to at most one Aurum record per
  -- migration (the stable, durable map).
  CONSTRAINT migration_mappings_incumbent_unique UNIQUE (tenant_id, migration_id, incumbent_kind, incumbent_id),
  CONSTRAINT migration_mappings_id_tenant_unique UNIQUE (id, tenant_id),
  -- A verified mapping points at a real Aurum row; an ambiguous one
  -- never merged (no aurum id, or one held only as a candidate record).
  CONSTRAINT migration_mappings_verified_shape CHECK (
    verification_state <> 'verified' OR (aurum_id IS NOT NULL AND aurum_kind IS NOT NULL
      AND match_basis <> 'ambiguous-candidates' AND match_basis <> 'conflicting-attributes')
  ),
  CONSTRAINT migration_mappings_ambiguous_shape CHECK (
    verification_state <> 'unverified-external'
    OR match_basis IN ('ambiguous-candidates', 'conflicting-attributes')
  ),
  -- The current view only exists once something landed.
  CONSTRAINT migration_mappings_current_shape CHECK (
    current_aurum_id IS NULL OR aurum_id IS NOT NULL
  )
);

CREATE INDEX migration_mappings_migration_idx
  ON migration_identity_mappings (tenant_id, migration_id, incumbent_kind);

-- ---------------------------------------------------------------------------
-- Sync runs — one row per dual-run pass, with honest outcomes
-- ---------------------------------------------------------------------------

CREATE TABLE migration_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- 1-based per-migration sequence.
  sequence integer NOT NULL CHECK (sequence >= 1),
  records_read integer NOT NULL DEFAULT 0 CHECK (records_read >= 0),
  records_landed integer NOT NULL DEFAULT 0 CHECK (records_landed >= 0),
  back_writes_attempted integer NOT NULL DEFAULT 0 CHECK (back_writes_attempted >= 0),
  back_writes_accepted integer NOT NULL DEFAULT 0 CHECK (back_writes_accepted >= 0),
  -- Permanent refusals — surfaced as conflict rows.
  back_writes_refused integer NOT NULL DEFAULT 0 CHECK (back_writes_refused >= 0),
  -- Transient failures (receipt 'failed') — retried by the next pass.
  back_writes_failed integer NOT NULL DEFAULT 0 CHECK (back_writes_failed >= 0),
  -- Blocked by the W083 gate or a missing write capability (governance,
  -- surfaced in the run + the comparison report).
  back_writes_blocked integer NOT NULL DEFAULT 0 CHECK (back_writes_blocked >= 0),
  conflicts_detected integer NOT NULL DEFAULT 0 CHECK (conflicts_detected >= 0),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 2000),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  CONSTRAINT migration_sync_runs_sequence_unique UNIQUE (tenant_id, migration_id, sequence),
  CONSTRAINT migration_sync_runs_id_tenant_unique UNIQUE (id, tenant_id),
  -- A live pass has no finish; a closed one always says when (a
  -- hard-killed worker leaves the honest 'running' row behind).
  CONSTRAINT migration_sync_runs_end_shape CHECK (
    (status = 'running') = (finished_at IS NULL)
  )
);

CREATE INDEX migration_sync_runs_migration_idx
  ON migration_sync_runs (tenant_id, migration_id, sequence DESC);

-- ---------------------------------------------------------------------------
-- Conflicts — surfaced, both versions, never auto-resolved
-- ---------------------------------------------------------------------------

CREATE TABLE migration_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  entity_kind text NOT NULL CHECK (char_length(entity_kind) BETWEEN 1 AND 128),
  incumbent_id text NOT NULL CHECK (char_length(incumbent_id) BETWEEN 1 AND 200),
  aurum_id uuid,
  -- The machine-readable conflict taxonomy.
  taxonomy text NOT NULL CHECK (taxonomy IN (
    'concurrent-update', 'delete-vs-update', 'back-write-refused'
  )),
  -- BOTH versions (the incumbent's is null on delete-vs-update).
  incumbent_version jsonb CHECK (
    incumbent_version IS NULL OR jsonb_typeof(incumbent_version) = 'object'
  ),
  aurum_version jsonb CHECK (aurum_version IS NULL OR jsonb_typeof(aurum_version) = 'object'),
  -- Both sides' own clocks for their versions.
  incumbent_updated_at timestamptz,
  aurum_updated_at timestamptz,
  -- Provenance of both versions: {incumbent: {...}, aurum: {...}}.
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  -- The W084 reconcileOperation diff between the two versions
  -- ({matched, mismatches, stateUnchanged} — the deep-actions shape).
  reconciliation jsonb CHECK (
    reconciliation IS NULL OR jsonb_typeof(reconciliation) = 'object'
  ),
  -- NEVER auto-resolved: 'none' until a human decides.
  resolution text NOT NULL DEFAULT 'none' CHECK (resolution IN ('none', 'incumbent', 'aurum')),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 2000),
  resolved_by text,
  resolved_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  detected_in_sync_run uuid,
  detected_at timestamptz NOT NULL,
  CONSTRAINT migration_conflicts_id_tenant_unique UNIQUE (id, tenant_id),
  -- An open conflict carries no resolution; a resolved one always says
  -- who decided, when, and why.
  CONSTRAINT migration_conflicts_open_shape CHECK (
    status <> 'open' OR (resolution = 'none' AND resolved_by IS NULL AND resolved_at IS NULL)
  ),
  CONSTRAINT migration_conflicts_resolved_shape CHECK (
    status <> 'resolved' OR (resolution <> 'none' AND resolution_note IS NOT NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX migration_conflicts_queue_idx
  ON migration_conflicts (tenant_id, migration_id, entity_kind, status);

-- ---------------------------------------------------------------------------
-- Comparison reports — reconcile-based, the retirement decision's input
-- ---------------------------------------------------------------------------

CREATE TABLE migration_comparison_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  entity_kind text NOT NULL CHECK (char_length(entity_kind) BETWEEN 1 AND 128),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  diverged_count integer NOT NULL DEFAULT 0 CHECK (diverged_count >= 0),
  incumbent_only_count integer NOT NULL DEFAULT 0 CHECK (incumbent_only_count >= 0),
  aurum_only_count integer NOT NULL DEFAULT 0 CHECK (aurum_only_count >= 0),
  -- Clean exactly when nothing diverged and neither side holds orphans.
  clean boolean NOT NULL,
  -- The per-record outcome rows (W084-shaped reconciliations inside).
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(outcomes) = 'array'),
  compared_at timestamptz NOT NULL,
  CONSTRAINT migration_reports_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT migration_reports_clean_shape CHECK (
    clean = (diverged_count = 0 AND incumbent_only_count = 0 AND aurum_only_count = 0)
  )
);

CREATE INDEX migration_reports_kind_idx
  ON migration_comparison_reports (tenant_id, migration_id, entity_kind, compared_at DESC);

-- ---------------------------------------------------------------------------
-- Retirement windows — progressive, per entity kind
-- ---------------------------------------------------------------------------

CREATE TABLE migration_retirement_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  entity_kind text NOT NULL CHECK (char_length(entity_kind) BETWEEN 1 AND 128),
  -- 1-based per-(migration, kind) sequence — rollback re-opens the
  -- window as a NEW row (the trail is retained).
  sequence integer NOT NULL CHECK (sequence >= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retired', 'rolled-back')),
  -- The comparison report that gated the retirement (or the re-open).
  closed_with_report_id uuid,
  opened_at timestamptz NOT NULL,
  opened_by text NOT NULL,
  retired_at timestamptz,
  CONSTRAINT migration_windows_sequence_unique UNIQUE (tenant_id, migration_id, entity_kind, sequence),
  CONSTRAINT migration_windows_id_tenant_unique UNIQUE (id, tenant_id),
  -- Only a retired window says when authority transferred.
  CONSTRAINT migration_windows_retired_shape CHECK (
    (status = 'retired') = (retired_at IS NOT NULL)
  )
);

CREATE INDEX migration_windows_kind_idx
  ON migration_retirement_windows (tenant_id, migration_id, entity_kind, sequence DESC);

-- ---------------------------------------------------------------------------
-- Events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE migration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- Monotonic per-migration position: the service clock can hold still
  -- within one run (test-controllable time), so the audit feed orders
  -- by (recorded_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'staged',
    'imported',
    'import-mismatch',
    'dual-run-started',
    'sync-completed',
    'conflict-detected',
    'conflict-resolved',
    'back-write-blocked',
    'comparison-recorded',
    'retirement-window-opened',
    'kind-retired',
    'authority-transferred',
    'rollback',
    'retired',
    'mapping-ambiguity-resolved'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT migration_events_position_unique UNIQUE (tenant_id, migration_id, position),
  CONSTRAINT migration_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX migration_events_migration_idx
  ON migration_events (tenant_id, migration_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Idempotency — caller-supplied dedupe keys, first write wins
-- ---------------------------------------------------------------------------

-- One row per recorded stageMigration idempotency key: a replay of
-- the key returns the original migration (the events module's
-- first-write-wins semantics; the deep-actions/computer-use precedent).

CREATE TABLE migration_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 2 AND 200),
  created_at timestamptz NOT NULL,
  CONSTRAINT migration_idempotency_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT migration_idempotency_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX migration_idempotency_migration_idx
  ON migration_idempotency (tenant_id, migration_id);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- migration_transitions + migration_events: strictly append-only — no
-- UPDATE, DELETE or TRUNCATE, ever. (The run/manifest/mapping/conflict/
-- report/window tables legitimately move forward through the lifecycle
-- — they are workflow state; the EVIDENCE itself lives in these two
-- ledgers and in the owning modules' immutable rows.)

CREATE OR REPLACE FUNCTION migration_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W094 migration-continuity audit): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER migration_transitions_immutable
  BEFORE UPDATE OR DELETE ON migration_transitions
  FOR EACH ROW EXECUTE FUNCTION migration_append_only_reject_mutation();
CREATE TRIGGER migration_transitions_immutable_truncate
  BEFORE TRUNCATE ON migration_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION migration_append_only_reject_mutation();

CREATE TRIGGER migration_events_immutable
  BEFORE UPDATE OR DELETE ON migration_events
  FOR EACH ROW EXECUTE FUNCTION migration_append_only_reject_mutation();
CREATE TRIGGER migration_events_immutable_truncate
  BEFORE TRUNCATE ON migration_events
  FOR EACH STATEMENT EXECUTE FUNCTION migration_append_only_reject_mutation();
