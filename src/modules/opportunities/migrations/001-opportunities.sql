-- W015 · opportunities module — the Opportunity Engine.
--
-- The work item: "Convert external/internal signals into evidence-backed
-- opportunities with estimated value, confidence, affected goals and
-- required capabilities."
--
-- ARCHITECTURE.md §12 (frozen): "Opportunity is a first-class object with
-- evidence, estimated value, confidence, affected goals, required
-- capability and recommended next action." External intelligence follows
-- `external signal → observation → claim → company relationship → impact
-- analysis → opportunity/risk → attention decision → mission or
-- recommendation` — this module owns the conversion of that chain's signals
-- into the first-class object, with the derived-intelligence discipline of
-- its sibling modules (lock 10: never authoritative truth).
--
-- Four tables, the established splits:
--
--   opportunities            — identity + the CURRENT version pointer.
--                              Carries no content: every judgment field
--                              lives in the version chain, so the current
--                              picture and the audit trail can never
--                              diverge. `current_version` advances by
--                              UPDATE (that is the pointer's only job);
--                              DELETE and TRUNCATE are rejected by
--                              trigger — an opportunity's identity and
--                              history are never erased (there is no
--                              delete operation on the contract either).
--
--   opportunity_versions     — the append-only AUDIT CHAIN: one row per
--                              change, each a FULL self-contained snapshot
--                              (content + evidence snapshot + derived
--                              confidence/support/fingerprint + audit
--                              quartet). An opportunity is versioned
--                              understanding, not reality: the immutable
--                              facts stay in the observations (W004) and
--                              claims (W007) this module reads THROUGH
--                              their contracts; this table stores what
--                              Aurum UNDERSTOOD about the opportunity, so
--                              any past judgment stays reconstructable
--                              (§24 decision evidence — the goals W008 /
--                              missions W011 / processes W016 discipline).
--                              UPDATE/DELETE/TRUNCATE are rejected by
--                              triggers.
--
--   opportunity_conversion_runs — ONE explicit, durable conversion pass
--                              (the engine's unit of work — the attention
--                              module's discovery-run precedent): the
--                              snapshotted recordability policy, the
--                              trigger/actor/execution link and the
--                              disposition counts. Append-only by trigger.
--
--   opportunity_conversion_candidates — the decided candidates: each the
--                              self-contained record of WHAT was proposed
--                              (the bounded-reasoning judgment), WHAT the
--                              application derived (confidence, support,
--                              fingerprint) and WHAT it decided
--                              (disposition + reason + created/existing
--                              links). Append-only by trigger: the
--                              decision trail cannot be rewritten.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on `opportunities` is the tenant-consistent
-- target for the version foreign key, and the composite FK
-- (run_id, tenant_id) on candidates makes a cross-tenant or dangling
-- candidate unrepresentable in SQL. Goals/capabilities/world-entities are
-- opaque forward references (jsonb) — no cross-module foreign keys (the
-- missions affected-goals precedent).

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX opportunities_tenant_idx ON opportunities (tenant_id);

CREATE TABLE opportunity_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('created', 'revised', 'pursued', 'dismissed', 'reactivated')),
  -- the versioned content (full snapshot)
  status text NOT NULL CHECK (status IN ('open', 'pursued', 'dismissed')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  signal_origin text NOT NULL CHECK (signal_origin IN ('external', 'internal')),
  -- the signal chain's immutable links (validated through the W004/W007
  -- contracts at write time; sorted + deduplicated by the validation layer)
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'),
  evidence_claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_claim_ids) = 'array'),
  -- the confidence snapshot each cited reference carried at commit:
  -- [{ "kind": "observation" | "claim", "id": uuid, "value": number }]
  evidence_confidences jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_confidences) = 'array'),
  support integer NOT NULL CHECK (support >= 1),
  evidence_fingerprint text NOT NULL
    CHECK (char_length(evidence_fingerprint) BETWEEN 1 AND 2048),
  -- application-derived, never caller-supplied (lock 10)
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  estimated_value_amount bigint NOT NULL
    CHECK (estimated_value_amount >= 0 AND estimated_value_amount <= 9007199254740991),
  estimated_value_currency text NOT NULL CHECK (estimated_value_currency ~ '^[A-Z]{3}$'),
  -- opaque forward references (no cross-module foreign keys)
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goals) = 'array'),
  required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(required_capabilities) = 'array'),
  world_entities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(world_entities) = 'array'),
  next_action_kind text NOT NULL CHECK (next_action_kind IN ('monitor', 'investigate', 'recommend')),
  next_action_statement text NOT NULL
    CHECK (char_length(next_action_statement) BETWEEN 1 AND 2000),
  -- audit quartet: who / when / what / why
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_versions_opportunity_version_unique
    UNIQUE (tenant_id, opportunity_id, version),
  CONSTRAINT opportunity_versions_opportunity_fk
    FOREIGN KEY (opportunity_id, tenant_id) REFERENCES opportunities (id, tenant_id),
  CONSTRAINT opportunity_versions_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

-- History + current-view lookups (covered by the unique constraint) and the
-- duplicate-detection lookup over LIVE opportunities' current versions.
CREATE INDEX opportunity_versions_opportunity_idx
  ON opportunity_versions (tenant_id, opportunity_id, version);
CREATE INDEX opportunity_versions_fingerprint_idx
  ON opportunity_versions (tenant_id, evidence_fingerprint);

CREATE TABLE opportunity_conversion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  trigger_kind text NOT NULL
    CHECK (trigger_kind IN ('cognitive-execution', 'scheduled', 'manual')),
  originating_execution_id uuid,
  -- the snapshotted recordability policy (auditable per run)
  min_confidence double precision NOT NULL CHECK (min_confidence >= 0 AND min_confidence <= 1),
  min_value_amount bigint
    CHECK (min_value_amount IS NULL OR (min_value_amount >= 0 AND min_value_amount <= 9007199254740991)),
  min_value_currency text CHECK (min_value_currency IS NULL OR min_value_currency ~ '^[A-Z]{3}$'),
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- the tenant-consistent target for the candidate foreign key
  CONSTRAINT opportunity_conversion_runs_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT opportunity_conversion_runs_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- the loop linkage IS the cognitive-execution trigger
  CONSTRAINT conversion_runs_execution_link
    CHECK (trigger_kind <> 'cognitive-execution' OR originating_execution_id IS NOT NULL),
  -- the value gate is a money pair or absent, never half-set
  CONSTRAINT conversion_runs_value_gate_paired
    CHECK ((min_value_amount IS NULL) = (min_value_currency IS NULL))
);
-- Disposition counts are NOT stored: they are DERIVED from the append-only
-- candidate rows at read time (the attention module's discovery-run
-- precedent) — the run row stays one immutable record, never a
-- write-then-fix-up row the immutability trigger would have to allow.

CREATE INDEX opportunity_conversion_runs_tenant_idx
  ON opportunity_conversion_runs (tenant_id, recorded_at);
CREATE INDEX opportunity_conversion_runs_execution_idx
  ON opportunity_conversion_runs (tenant_id, originating_execution_id);

CREATE TABLE opportunity_conversion_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  disposition text NOT NULL
    CHECK (disposition IN ('converted', 'below_threshold', 'currency_mismatch', 'duplicate')),
  signal_origin text NOT NULL CHECK (signal_origin IN ('external', 'internal')),
  -- the proposed judgment (self-contained audit of what was considered)
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'),
  evidence_claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_claim_ids) = 'array'),
  evidence_confidences jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_confidences) = 'array'),
  support integer NOT NULL CHECK (support >= 1),
  evidence_fingerprint text NOT NULL
    CHECK (char_length(evidence_fingerprint) BETWEEN 1 AND 2048),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  estimated_value_amount bigint NOT NULL
    CHECK (estimated_value_amount >= 0 AND estimated_value_amount <= 9007199254740991),
  estimated_value_currency text NOT NULL CHECK (estimated_value_currency ~ '^[A-Z]{3}$'),
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goals) = 'array'),
  required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(required_capabilities) = 'array'),
  world_entities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(world_entities) = 'array'),
  next_action_kind text NOT NULL
    CHECK (next_action_kind IN ('monitor', 'investigate', 'recommend')),
  next_action_statement text NOT NULL
    CHECK (char_length(next_action_statement) BETWEEN 1 AND 2000),
  created_opportunity_id uuid,
  existing_opportunity_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_conversion_candidates_run_fk
    FOREIGN KEY (run_id, tenant_id)
    REFERENCES opportunity_conversion_runs (id, tenant_id),
  -- a candidate points at exactly one outcome record of the right kind
  CONSTRAINT conversion_candidates_converted_link
    CHECK (
      (disposition = 'converted' AND created_opportunity_id IS NOT NULL)
      OR (disposition = 'duplicate' AND existing_opportunity_id IS NOT NULL)
      OR (disposition NOT IN ('converted', 'duplicate')
          AND created_opportunity_id IS NULL AND existing_opportunity_id IS NULL)
    ),
  -- the deterministic gate explanation belongs to non-converted candidates
  CONSTRAINT conversion_candidates_reason_paired
    CHECK (
      (disposition = 'converted' AND reason IS NULL)
      OR (disposition <> 'converted' AND reason IS NOT NULL)
    )
);

CREATE INDEX opportunity_conversion_candidates_run_idx
  ON opportunity_conversion_candidates (tenant_id, run_id);

-- Storage-level audit guarantee: the opportunity audit chain and the
-- conversion decision trail are append-only. Nothing may UPDATE, DELETE or
-- TRUNCATE them — not even a future module bypassing the service. The
-- message deliberately names no row id so the same function serves the
-- row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION opportunity_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'opportunity versions are append-only (W015 opportunity audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_versions_immutable
  BEFORE UPDATE OR DELETE ON opportunity_versions
  FOR EACH ROW EXECUTE FUNCTION opportunity_versions_reject_mutation();

CREATE TRIGGER opportunity_versions_immutable_truncate
  BEFORE TRUNCATE ON opportunity_versions
  FOR EACH STATEMENT EXECUTE FUNCTION opportunity_versions_reject_mutation();

-- The opportunities identity row may advance its version pointer (UPDATE)
-- — that is how versioning moves — but identity and history are never
-- erased.

CREATE OR REPLACE FUNCTION opportunities_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'opportunities cannot be erased (W015): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunities_immutable_delete
  BEFORE DELETE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunities_reject_erasure();

CREATE TRIGGER opportunities_immutable_truncate
  BEFORE TRUNCATE ON opportunities
  FOR EACH STATEMENT EXECUTE FUNCTION opportunities_reject_erasure();

-- Conversion runs and candidates are one-pass evidence of what Aurum
-- converted and decided: entirely immutable.

CREATE OR REPLACE FUNCTION conversion_runs_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'conversion runs are append-only (W015 conversion audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_conversion_runs_immutable
  BEFORE UPDATE OR DELETE ON opportunity_conversion_runs
  FOR EACH ROW EXECUTE FUNCTION conversion_runs_reject_mutation();

CREATE TRIGGER opportunity_conversion_runs_immutable_truncate
  BEFORE TRUNCATE ON opportunity_conversion_runs
  FOR EACH STATEMENT EXECUTE FUNCTION conversion_runs_reject_mutation();

CREATE OR REPLACE FUNCTION conversion_candidates_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'conversion candidates are append-only (W015 decision trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_conversion_candidates_immutable
  BEFORE UPDATE OR DELETE ON opportunity_conversion_candidates
  FOR EACH ROW EXECUTE FUNCTION conversion_candidates_reject_mutation();

CREATE TRIGGER opportunity_conversion_candidates_immutable_truncate
  BEFORE TRUNCATE ON opportunity_conversion_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION conversion_candidates_reject_mutation();
