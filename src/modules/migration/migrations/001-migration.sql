-- W094 · migration module — Migration and Dual-Run Continuity:
-- the staged import rounds, the external↔Aurum identifier map, the
-- identity-collision conflict ledger, the dual-run comparison rounds and
-- the progressive-retirement checkpoints that let a customer move from an
-- incumbent system to Aurum without ever risking their data or authority.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). Nothing provider-named appears anywhere: the incumbent appears
-- only as the W081 inventory system's plain-language descriptor and the
-- OPAQUE broker-connection id (W082); the only incumbent-minted values
-- that reach these tables are OPAQUE strings (external record ids,
-- snapshot references). Credential VALUES never reach these tables at all
-- (the W082 discipline: the connection row holds the opaque credentialRef;
-- this module loads it live and passes it straight through to the wired
-- incumbent reader / verification transport).
--
-- State model (the work item's canonical chain, mirrored by the shapes):
--   * migration_migrations       — one migration off one incumbent: the
--                                  frozen incumbent descriptor + kit
--                                  binding, and the RETIREMENT CHECKPOINT
--                                  chain dual-running → compare-clean →
--                                  incumbent-read-only → incumbent-retired,
--                                  with sequestered as the rollback
--                                  terminal.
--   * migration_rounds           — the staged import rounds: snapshot →
--                                  transform → staged → review → commit
--                                  (kind full/delta; the snapshot
--                                  reference and the delta base are
--                                  frozen per round).
--   * migration_imported_records — the EVIDENCE-shaped imported records:
--                                  every row carries its full provenance
--                                  (source system, external id, match
--                                  key, round, snapshot reference); the
--                                  payload/provenance columns are
--                                  IMMUTABLE at the storage level
--                                  (trigger below) — only the forward-
--                                  only workflow columns ever move.
--   * migration_identifier_map   — the external↔Aurum identifier map per
--                                  source system (per-migration rows,
--                                  live-lookup semantics across
--                                  migrations; sequestered migrations'
--                                  entries are excluded from live
--                                  lookups but retained).
--   * migration_identity_conflicts — the explicit collision records
--                                  (cross-system collisions and ambiguous
--                                  matches are surfaced here, never
--                                  auto-merged; a human resolves).
--   * migration_comparison_rounds + migration_comparison_entries — the
--                                  dual-run result comparison: the same
--                                  question evaluated against
--                                  incumbent-imported state and native
--                                  Aurum state, with agreements,
--                                  divergences and divergence reasons as
--                                  structured rows (divergences are
--                                  surfaced, never reconciled silently).
--   * migration_events           — append-only lifecycle audit (every
--                                  phase, every conflict, every checkpoint
--                                  with its evidence links; triggers
--                                  refuse UPDATE/DELETE/TRUNCATE).

-- ---------------------------------------------------------------------------
-- Migrations — one migration off one incumbent system
-- ---------------------------------------------------------------------------

CREATE TABLE migration_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The incumbent: the W081 Tool & System Inventory entry (frozen
  -- descriptor, validated through the integration-intelligence contract).
  incumbent_system_id uuid NOT NULL,
  incumbent_system_key text NOT NULL
    CHECK (char_length(incumbent_system_key) BETWEEN 3 AND 312),
  incumbent_system_display_name text NOT NULL
    CHECK (char_length(incumbent_system_display_name) BETWEEN 1 AND 200),
  -- The W082 broker connection the incumbent reads ride (opaque id,
  -- validated connected through the connection-broker contract).
  incumbent_connection_id uuid NOT NULL,
  -- The plain-language W081 READ capability the import rounds exercise.
  incumbent_read_capability_key text NOT NULL
    CHECK (char_length(incumbent_read_capability_key) BETWEEN 3 AND 128),
  -- The optional W092 vertical-kit binding (validated through the
  -- vertical-kits contract; the kit's schema hints drive the transform's
  -- per-record issue detection). All-or-nothing.
  kit_installation_id uuid,
  kit_key text CHECK (kit_key IS NULL OR char_length(kit_key) BETWEEN 3 AND 128),
  kit_version text CHECK (kit_version IS NULL OR char_length(kit_version) BETWEEN 1 AND 64),
  kit_integration_key text
    CHECK (kit_integration_key IS NULL OR char_length(kit_integration_key) BETWEEN 3 AND 128),
  -- The progressive-retirement checkpoint chain.
  status text NOT NULL DEFAULT 'dual-running' CHECK (status IN (
    'dual-running', 'compare-clean', 'incumbent-read-only',
    'incumbent-retired', 'sequestered'
  )),
  -- The evidence link justifying the compare-clean checkpoint (the
  -- completed comparison round with zero divergences).
  compare_clean_round_id uuid,
  read_only_at timestamptz,
  retired_at timestamptz,
  -- Rollback (sequester) evidence: when, by whom, why. Sequester is the
  -- rollback terminal; it never deletes anything.
  sequestered_at timestamptz,
  sequestered_by text,
  sequester_reason text
    CHECK (sequester_reason IS NULL OR char_length(sequester_reason) BETWEEN 1 AND 2000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT migration_migrations_id_tenant_unique UNIQUE (id, tenant_id),
  -- The kit binding is all-or-nothing.
  CONSTRAINT migration_migrations_kit_shape CHECK (
    (kit_installation_id IS NULL) = (kit_key IS NULL)
    AND (kit_installation_id IS NULL) = (kit_version IS NULL)
    AND (kit_installation_id IS NULL) = (kit_integration_key IS NULL)
  ),
  -- Only the compare-clean checkpoint and later know their evidence
  -- (sequestered freezes whatever the pre-rollback state knew).
  CONSTRAINT migration_migrations_compare_clean_shape CHECK (
    status IN ('dual-running', 'sequestered') OR compare_clean_round_id IS NOT NULL
  ),
  -- Only past the read-only checkpoint know its timestamp (and later;
  -- sequestered freezes whatever the pre-rollback state knew).
  CONSTRAINT migration_migrations_read_only_shape CHECK (
    status IN ('dual-running', 'compare-clean', 'sequestered') OR read_only_at IS NOT NULL
  ),
  CONSTRAINT migration_migrations_retired_shape CHECK (
    status <> 'incumbent-retired' OR retired_at IS NOT NULL
  ),
  -- Only sequestered carries sequester evidence; sequestered carries it
  -- always (and never the retirement timestamps).
  CONSTRAINT migration_migrations_sequestered_shape CHECK (
    status <> 'sequestered'
    OR (sequestered_at IS NOT NULL AND sequestered_by IS NOT NULL
        AND sequester_reason IS NOT NULL)
  ),
  CONSTRAINT migration_migrations_not_sequestered_shape CHECK (
    status = 'sequestered'
    OR (sequestered_at IS NULL AND sequestered_by IS NULL AND sequester_reason IS NULL)
  )
);

CREATE INDEX migration_migrations_tenant_status_idx
  ON migration_migrations (tenant_id, status, created_at DESC);
CREATE INDEX migration_migrations_tenant_system_idx
  ON migration_migrations (tenant_id, incumbent_system_id);

-- ---------------------------------------------------------------------------
-- Rounds — the staged import lifecycle (snapshot → transform → staged →
-- review → commit)
-- ---------------------------------------------------------------------------

CREATE TABLE migration_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- 1-based, strictly increasing per migration (sequential rounds).
  round_number integer NOT NULL CHECK (round_number >= 1),
  kind text NOT NULL CHECK (kind IN ('full', 'delta')),
  status text NOT NULL DEFAULT 'snapshotted' CHECK (status IN (
    'snapshotted', 'staged', 'reviewed', 'committed', 'abandoned'
  )),
  -- The OPAQUE incumbent-minted snapshot reference this round read (the
  -- provenance anchor of every record the round staged).
  snapshot_ref text NOT NULL CHECK (char_length(snapshot_ref) BETWEEN 1 AND 200),
  -- The delta base (the last COMMITTED round's snapshot reference; null
  -- for full rounds). An abandoned round never becomes a delta base, so
  -- its window is re-read — no silent data loss.
  since_snapshot_ref text
    CHECK (since_snapshot_ref IS NULL OR char_length(since_snapshot_ref) BETWEEN 1 AND 200),
  raw_record_count integer NOT NULL CHECK (raw_record_count >= 0),
  -- Transform-issue count (records staged with surfaced issues).
  transform_issue_count integer NOT NULL DEFAULT 0 CHECK (transform_issue_count >= 0),
  -- The commit-time verification read outcome (through the wired
  -- deep-action transport — the W084/W088 composition; 'not-wired' is the
  -- honest state when no transport is wired).
  verification text NOT NULL DEFAULT 'not-wired' CHECK (verification IN (
    'not-wired', 'verified', 'divergent'
  )),
  verified_count integer NOT NULL DEFAULT 0 CHECK (verified_count >= 0),
  divergent_count integer NOT NULL DEFAULT 0 CHECK (divergent_count >= 0),
  conflict_count integer NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  reviewed_by text,
  reviewed_at timestamptz,
  committed_at timestamptz,
  abandoned_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT migration_rounds_number_unique UNIQUE (tenant_id, migration_id, round_number),
  CONSTRAINT migration_rounds_id_tenant_unique UNIQUE (id, tenant_id),
  -- A delta round always knows its base; a full round never does.
  CONSTRAINT migration_rounds_kind_shape CHECK (
    (kind = 'delta') = (since_snapshot_ref IS NOT NULL)
  ),
  -- Phase-shape invariants.
  CONSTRAINT migration_rounds_snapshotted_shape CHECK (
    status <> 'snapshotted' OR (reviewed_by IS NULL AND committed_at IS NULL)
  ),
  CONSTRAINT migration_rounds_staged_shape CHECK (
    status <> 'staged' OR (reviewed_by IS NULL AND committed_at IS NULL)
  ),
  CONSTRAINT migration_rounds_reviewed_shape CHECK (
    status <> 'reviewed' OR (reviewed_by IS NOT NULL AND committed_at IS NULL)
  ),
  CONSTRAINT migration_rounds_committed_shape CHECK (
    status <> 'committed' OR (reviewed_by IS NOT NULL AND committed_at IS NOT NULL)
  ),
  CONSTRAINT migration_rounds_abandoned_shape CHECK (
    status <> 'abandoned' OR abandoned_at IS NOT NULL
  ),
  -- Only a committed round carries verification/conflict counts.
  CONSTRAINT migration_rounds_counts_shape CHECK (
    status <> 'committed'
    OR (verified_count + divergent_count <= raw_record_count)
  )
);

CREATE INDEX migration_rounds_migration_idx
  ON migration_rounds (tenant_id, migration_id, round_number DESC);

-- ---------------------------------------------------------------------------
-- Imported records — the EVIDENCE-shaped rows (never silently mutated)
-- ---------------------------------------------------------------------------

CREATE TABLE migration_imported_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  round_id uuid NOT NULL,
  -- 1-based position within the round (the deterministic commit order).
  position integer NOT NULL CHECK (position >= 1),
  -- PROVENANCE (immutable after insert — the trigger below enforces it):
  -- the source system key, the incumbent's external record id, the
  -- natural match key, the vertical entity type and the snapshot
  -- reference the record was read under.
  source_system_key text NOT NULL
    CHECK (char_length(source_system_key) BETWEEN 3 AND 312),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  match_key text CHECK (match_key IS NULL OR char_length(match_key) BETWEEN 1 AND 200),
  entity_type text CHECK (entity_type IS NULL OR char_length(entity_type) BETWEEN 1 AND 100),
  snapshot_ref text NOT NULL CHECK (char_length(snapshot_ref) BETWEEN 1 AND 200),
  -- The incumbent's canonical payload (null for tombstones — records the
  -- incumbent reported deleted).
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  tombstone boolean NOT NULL DEFAULT false,
  -- The transform's surfaced issues (never drop a record silently).
  issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues) = 'array'),
  -- Forward-only workflow columns (the only columns that ever move).
  state text NOT NULL DEFAULT 'snapshotted' CHECK (state IN (
    'snapshotted', 'staged', 'committed', 'abandoned'
  )),
  disposition text CHECK (disposition IS NULL OR disposition IN (
    'new', 'update', 'matched', 'conflicted', 'resolved', 'tombstone'
  )),
  aurum_entity_id text
    CHECK (aurum_entity_id IS NULL OR char_length(aurum_entity_id) BETWEEN 1 AND 200),
  identity_conflict_id uuid,
  created_at timestamptz NOT NULL,
  committed_at timestamptz,
  CONSTRAINT migration_imported_records_position_unique
    UNIQUE (tenant_id, round_id, position),
  CONSTRAINT migration_imported_records_id_tenant_unique UNIQUE (id, tenant_id),
  -- A tombstone carries no payload; a live record always does.
  CONSTRAINT migration_imported_records_tombstone_shape CHECK (
    tombstone OR payload IS NOT NULL
  ),
  CONSTRAINT migration_imported_records_not_tombstone_shape CHECK (
    NOT tombstone OR payload IS NULL
  ),
  -- Workflow-shape invariants (the forward-only chain).
  CONSTRAINT migration_imported_records_snapshotted_shape CHECK (
    state <> 'snapshotted' OR (disposition IS NULL AND aurum_entity_id IS NULL)
  ),
  CONSTRAINT migration_imported_records_staged_shape CHECK (
    state <> 'staged' OR (disposition IS NULL AND aurum_entity_id IS NULL)
  ),
  CONSTRAINT migration_imported_records_committed_shape CHECK (
    state <> 'committed' OR (disposition IS NOT NULL AND committed_at IS NOT NULL)
  ),
  CONSTRAINT migration_imported_records_abandoned_shape CHECK (
    state <> 'abandoned' OR (disposition IS NULL AND aurum_entity_id IS NULL)
  ),
  -- Disposition/link shape: the linking dispositions carry their entity;
  -- a tombstone carries the entity it tombstoned when one was mapped (an
  -- unmapped tombstone — the incumbent deleted a record never imported —
  -- retains its evidence with no link); conflicted records carry their
  -- conflict link and no entity until resolved; resolved carries both.
  CONSTRAINT migration_imported_records_linked_shape CHECK (
    disposition NOT IN ('new', 'update', 'matched') OR aurum_entity_id IS NOT NULL
  ),
  CONSTRAINT migration_imported_records_conflicted_shape CHECK (
    disposition <> 'conflicted' OR (identity_conflict_id IS NOT NULL AND aurum_entity_id IS NULL)
  ),
  CONSTRAINT migration_imported_records_resolved_shape CHECK (
    disposition <> 'resolved'
    OR (identity_conflict_id IS NOT NULL AND aurum_entity_id IS NOT NULL)
  )
);

CREATE INDEX migration_imported_records_round_idx
  ON migration_imported_records (tenant_id, round_id, position);
CREATE INDEX migration_imported_records_migration_idx
  ON migration_imported_records (tenant_id, migration_id, external_id);
CREATE INDEX migration_imported_records_entity_idx
  ON migration_imported_records (tenant_id, migration_id, aurum_entity_id);

-- ---------------------------------------------------------------------------
-- The identifier map — external↔Aurum identifiers per source system
-- ---------------------------------------------------------------------------

CREATE TABLE migration_identifier_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- The source system the external id belongs to (per source system:
  -- only one LIVE migration per (tenant, system) is allowed, so live
  -- lookups by (source system, external id) resolve to at most one row).
  source_system_key text NOT NULL
    CHECK (char_length(source_system_key) BETWEEN 3 AND 312),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  match_key text CHECK (match_key IS NULL OR char_length(match_key) BETWEEN 1 AND 200),
  -- The Aurum-side identifier the external id resolves to (the map's
  -- value; preserved forever — retirement never removes an entry).
  aurum_entity_id text NOT NULL CHECK (char_length(aurum_entity_id) BETWEEN 1 AND 200),
  -- The round that established this entry.
  round_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('import', 'conflict-resolution')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT migration_identifier_map_external_unique
    UNIQUE (tenant_id, migration_id, external_id),
  CONSTRAINT migration_identifier_map_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX migration_identifier_map_source_idx
  ON migration_identifier_map (tenant_id, source_system_key, external_id);
CREATE INDEX migration_identifier_map_match_idx
  ON migration_identifier_map (tenant_id, match_key);
CREATE INDEX migration_identifier_map_entity_idx
  ON migration_identifier_map (tenant_id, aurum_entity_id);

-- ---------------------------------------------------------------------------
-- Identity conflicts — collisions surfaced, never auto-merged
-- ---------------------------------------------------------------------------

CREATE TABLE migration_identity_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  round_id uuid NOT NULL,
  record_id uuid NOT NULL,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  match_key text CHECK (match_key IS NULL OR char_length(match_key) BETWEEN 1 AND 200),
  -- 'cross-system-collision': another source system's map entries already
  --   claim this match key (never auto-merged across systems).
  -- 'ambiguous-match': the claims span 2+ aurum entities (ambiguous, the
  --   W095 rule applied to migration — a human decides).
  kind text NOT NULL CHECK (kind IN ('cross-system-collision', 'ambiguous-match')),
  -- The frozen candidate claims at raise time (source system keys,
  -- external ids, aurum entity ids, migrations).
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_aurum_entity_id text
    CHECK (resolution_aurum_entity_id IS NULL OR char_length(resolution_aurum_entity_id) BETWEEN 1 AND 200),
  resolution_note text
    CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 2000),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT migration_identity_conflicts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT migration_identity_conflicts_open_shape CHECK (
    status <> 'open'
    OR (resolution_aurum_entity_id IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
  ),
  CONSTRAINT migration_identity_conflicts_resolved_shape CHECK (
    status <> 'resolved'
    OR (resolution_aurum_entity_id IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX migration_identity_conflicts_migration_idx
  ON migration_identity_conflicts (tenant_id, migration_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Comparison rounds — the dual-run result comparison
-- ---------------------------------------------------------------------------

CREATE TABLE migration_comparison_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  compared_entity_count integer NOT NULL CHECK (compared_entity_count >= 0),
  agreement_count integer NOT NULL CHECK (agreement_count >= 0),
  divergence_count integer NOT NULL CHECK (divergence_count >= 0),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT migration_comparison_rounds_id_tenant_unique UNIQUE (id, tenant_id),
  -- Every compared entity agrees or diverges (the structural kinds count
  -- as divergences).
  CONSTRAINT migration_comparison_rounds_sum_shape CHECK (
    agreement_count + divergence_count = compared_entity_count
  )
);

CREATE INDEX migration_comparison_rounds_migration_idx
  ON migration_comparison_rounds (tenant_id, migration_id, created_at DESC);

-- One structured comparison entry per compared entity (agreements,
-- divergences and their deterministic reasons — surfaced, never
-- reconciled silently).
CREATE TABLE migration_comparison_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  comparison_round_id uuid NOT NULL,
  -- Deterministic ordering within the round.
  position integer NOT NULL CHECK (position >= 1),
  aurum_entity_id text NOT NULL CHECK (char_length(aurum_entity_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN (
    'agreement', 'divergence', 'native-missing', 'incumbent-deleted', 'incumbent-missing'
  )),
  -- The value divergences (W084 StateMismatch shapes: path, expected,
  -- actual — expected = incumbent-imported, actual = native) plus the
  -- structural one-sided fields.
  mismatches jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mismatches) = 'array'),
  incumbent_only_fields jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(incumbent_only_fields) = 'array'),
  native_only_fields jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(native_only_fields) = 'array'),
  -- The deterministic divergence reason (plain language).
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT migration_comparison_entries_position_unique
    UNIQUE (tenant_id, comparison_round_id, position),
  CONSTRAINT migration_comparison_entries_id_tenant_unique UNIQUE (id, tenant_id),
  -- Only divergences carry divergence material; agreements carry none.
  CONSTRAINT migration_comparison_entries_agreement_shape CHECK (
    kind <> 'agreement'
    OR (jsonb_array_length(mismatches) = 0
        AND jsonb_array_length(incumbent_only_fields) = 0
        AND jsonb_array_length(native_only_fields) = 0
        AND reason IS NULL)
  ),
  CONSTRAINT migration_comparison_entries_divergence_shape CHECK (
    kind <> 'divergence'
    OR reason IS NOT NULL
  ),
  -- The structural kinds carry their deterministic reason.
  CONSTRAINT migration_comparison_entries_structural_reason CHECK (
    kind IN ('agreement', 'divergence') OR reason IS NOT NULL
  )
);

CREATE INDEX migration_comparison_entries_round_idx
  ON migration_comparison_entries (tenant_id, comparison_round_id, position);

-- ---------------------------------------------------------------------------
-- Events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE migration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- Monotonic per-migration position: the service clock can hold still
  -- within one phase (test-controllable time), so the audit feed orders
  -- by (recorded_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'created',
    'snapshot-captured',
    'transformed',
    'reviewed',
    'committed',
    'round-abandoned',
    'identity-conflict-raised',
    'identity-conflict-resolved',
    'comparison-completed',
    'compare-clean-checkpoint',
    'incumbent-read-only-checkpoint',
    'incumbent-retired',
    'sequestered',
    'verification-divergence'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  -- The evidence links the event justifies itself with (the round, the
  -- conflict, the comparison round — null when not applicable).
  round_id uuid,
  comparison_round_id uuid,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT migration_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX migration_events_migration_idx
  ON migration_events (tenant_id, migration_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- migration_events: strictly append-only audit — no UPDATE, DELETE or
-- TRUNCATE, ever (the deep-action events precedent).
CREATE OR REPLACE FUNCTION migration_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W094 migration audit): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER migration_events_immutable
  BEFORE UPDATE OR DELETE ON migration_events
  FOR EACH ROW EXECUTE FUNCTION migration_append_only_reject_mutation();
CREATE TRIGGER migration_events_immutable_truncate
  BEFORE TRUNCATE ON migration_events
  FOR EACH STATEMENT EXECUTE FUNCTION migration_append_only_reject_mutation();

-- migration_imported_records: the EVIDENCE columns are immutable — the
-- payload and the provenance (source system, external id, match key,
-- entity type, snapshot reference, round) can never be silently mutated.
-- Only the forward-only workflow columns (state, disposition,
-- aurum_entity_id, identity_conflict_id, committed_at, issues — the
-- transform's surfaced annotations and the commit's links) may move.
CREATE OR REPLACE FUNCTION migration_records_reject_evidence_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.payload IS DISTINCT FROM NEW.payload
     OR OLD.source_system_key IS DISTINCT FROM NEW.source_system_key
     OR OLD.external_id IS DISTINCT FROM NEW.external_id
     OR OLD.match_key IS DISTINCT FROM NEW.match_key
     OR OLD.entity_type IS DISTINCT FROM NEW.entity_type
     OR OLD.snapshot_ref IS DISTINCT FROM NEW.snapshot_ref
     OR OLD.round_id IS DISTINCT FROM NEW.round_id
     OR OLD.tombstone IS DISTINCT FROM NEW.tombstone
     OR OLD.position IS DISTINCT FROM NEW.position THEN
    RAISE EXCEPTION 'migration_imported_records is evidence (W094): the payload and provenance columns of an imported record are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER migration_imported_records_evidence_immutable
  BEFORE UPDATE ON migration_imported_records
  FOR EACH ROW EXECUTE FUNCTION migration_records_reject_evidence_mutation();
