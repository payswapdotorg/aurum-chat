-- W111 · migration module — Production Migration Reader / Native-Reader
-- Adapters: the READER REJECTION LEDGER.
--
-- The W094 staged-import chain is deliberately strict: the module's own
-- canonicalization (validation.ts) throws on any non-canonical incumbent
-- record, so ONE malformed row in a real incumbent export would fail the
-- whole round — the honest-but-blunt behavior. The W111 real incumbent
-- readers (the CSV export-library adapter) therefore canonicalize PER ROW
-- before returning: every malformed/oversized/duplicate/undecodable row is
-- EXPLICITLY REJECTED with a recorded reason instead of poisoning the
-- snapshot, and the surviving canonical records land staged.
--
-- No silent data loss demands those rejections have a DURABLE,
-- tenant-scoped audit home: every row the incumbent exported either lands
-- staged (migration_imported_records), is explicitly rejected HERE (with
-- its reason and its raw source evidence), or is explicitly conflicted
-- (migration_identity_conflicts) — the round's counts must reconcile
--   export rows = staged + rejected + conflicted.
--
-- This is the ONE sanctioned W111 storage addition (work order §3):
--   * migration_reader_rejections — the append-only rejection ledger.
--
-- The reason_code vocabulary is deliberately NOT an enum CHECK (unlike
-- 001's workflow vocabularies): the ledger is the shared audit home of
-- EVERY first-party reader adapter (reader_kind distinguishes them), and
-- each adapter owns its own rejection vocabulary. The column is bounded
-- text; the module's canonicalizer (validation.ts) enforces the bound and
-- the adapter files own the vocabularies.
--
-- Credential VALUES never reach this table (the W082 discipline): the
-- reader sees only the opaque credentialRef, and even that is not stored
-- here — the ledger records WHAT was rejected and WHY, never secrets.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id
-- (scripts/check-architecture.ts rule d).

CREATE TABLE migration_reader_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  -- The import round whose snapshot read produced the rejection (the
  -- round link makes the count reconciliation auditable per round).
  round_id uuid NOT NULL,
  -- Which first-party reader adapter rejected the row (its own stable
  -- kind string, e.g. 'csv-export').
  reader_kind text NOT NULL CHECK (char_length(reader_kind) BETWEEN 1 AND 100),
  -- The OPAQUE incumbent snapshot reference the read carried.
  snapshot_ref text NOT NULL CHECK (char_length(snapshot_ref) BETWEEN 1 AND 200),
  -- The incumbent external id when the row carried a readable one (null
  -- when the id itself was the reason the row was unreadable).
  external_id text CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 200),
  -- 1-based data-row position in the export file the adapter read (the
  -- evidence pointer an operator follows back to the source export).
  line_number integer NOT NULL CHECK (line_number >= 1),
  -- The adapter-owned machine-checkable rejection reason code.
  reason_code text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 100),
  -- The human-readable reason (the deterministic sentence, never merely
  -- "something was wrong with this row").
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  -- The raw source row as the adapter saw it (bounded evidence; redacted
  -- of nothing — the incumbent's own export data, never credentials).
  raw_row text CHECK (raw_row IS NULL OR char_length(raw_row) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL,
  CONSTRAINT migration_reader_rejections_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT migration_reader_rejections_round_unique
    UNIQUE (tenant_id, round_id, reader_kind, line_number, reason_code)
);

CREATE INDEX migration_reader_rejections_round_idx
  ON migration_reader_rejections (tenant_id, round_id, line_number);
CREATE INDEX migration_reader_rejections_migration_idx
  ON migration_reader_rejections (tenant_id, migration_id, created_at DESC);
