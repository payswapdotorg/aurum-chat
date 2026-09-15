-- W007 · epistemics module — claims, beliefs, hypotheses, unknowns and
-- contradictions, with evidence links.
--
-- The five concepts (ARCHITECTURE.md §4/§11, locks 6, 7, 11, 12):
--
--   claims          — immutable, append-only propositions derived from ≥1
--                     observation (evidence link). A correction or a
--                     re-derivation is a NEW claim; storage-level triggers
--                     reject UPDATE/DELETE/TRUNCATE outright, mirroring the
--                     observations module (lock 5 discipline applied to
--                     derived propositions). This is what makes "conflicting
--                     evidence is retained" (lock 12) provable at the storage
--                     level: two claims derived from conflicting evidence
--                     cannot silently merge.
--
--   contradictions  — retained records that two evidence references
--                     (observation or claim) conflict. The pair is stored in
--                     canonical order and unique per tenant; identity fields
--                     and both evidence links are FROZEN after insert
--                     (trigger), DELETE/TRUNCATE are rejected, and the only
--                     legal mutation is the one-way open -> resolved
--                     transition, which annotates how the conflict was
--                     weighed without touching the retained evidence.
--
--   hypotheses      — unresolved explanations. Same retention discipline:
--                     one-way open -> confirmed | refuted with resolution
--                     evidence; identity fields frozen; no deletion.
--
--   unknowns        — consequential gaps in knowledge (lock 7): question +
--                     consequence are both required (a gap without a
--                     consequence is not first-class). One-way
--                     open -> resolved; frozen identity; no deletion.
--
--   beliefs         — versioned CURRENT working understanding: the anchor
--     (subject + active/retired lifecycle) lives here; the versioned
--     statement (proposition, confidence, alternatives, disconfirmation,
--     supporting claim ids) with its observation provenance lives in the
--     freshness module's temporal_revisions under subject kind
--     'epistemics.belief' (W006 machinery — the wiring the freshness
--     contract anticipates). The anchor guard below freezes identity and
--     enforces the one-way active -> retired lifecycle; DELETE is rejected
--     so a version chain is never orphaned from its anchor.
--
-- Cross-module references (observations) are deliberately NOT foreign keys
-- — the codebase discipline (freshness provenance precedent): links are
-- validated through the owning module's contract at write time and stored
-- as sorted, deduplicated jsonb arrays.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; two tenants hold
-- fully independent epistemic records, and cross-tenant access is
-- indistinguishable from missing records at the service layer.

-- ---------------------------------------------------------------------------
-- Claims — immutable evidence-derived propositions
-- ---------------------------------------------------------------------------

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  proposition text NOT NULL
    CHECK (char_length(proposition) >= 1 AND char_length(proposition) <= 2048),
  subject_kind text,
  subject_id uuid,
  confidence_value double precision NOT NULL
    CHECK (confidence_value >= 0 AND confidence_value <= 1),
  confidence_method text NOT NULL CHECK (char_length(confidence_method) >= 1),
  confidence_basis text,
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claims_subject_shape CHECK (
    (subject_kind IS NULL AND subject_id IS NULL)
    OR (subject_kind IS NOT NULL AND subject_id IS NOT NULL)
  ),
  CONSTRAINT claims_evidence_shape CHECK (
    jsonb_typeof(evidence_observation_ids) = 'array'
    AND jsonb_array_length(evidence_observation_ids) >= 1
  )
);

CREATE INDEX claims_tenant_recorded_idx ON claims (tenant_id, recorded_at DESC);
CREATE INDEX claims_tenant_subject_idx ON claims (tenant_id, subject_kind, subject_id);
CREATE INDEX claims_tenant_evidence_idx ON claims USING gin (evidence_observation_ids jsonb_path_ops);

CREATE OR REPLACE FUNCTION claims_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'claims are immutable (W007 epistemics): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_immutable
  BEFORE UPDATE OR DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION claims_reject_mutation();

CREATE TRIGGER claims_immutable_truncate
  BEFORE TRUNCATE ON claims
  FOR EACH STATEMENT EXECUTE FUNCTION claims_reject_mutation();

-- ---------------------------------------------------------------------------
-- Contradictions — retained conflicts between two evidence references
-- ---------------------------------------------------------------------------

CREATE TABLE contradictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  evidence_a_kind text NOT NULL CHECK (evidence_a_kind IN ('observation', 'claim')),
  evidence_a_id uuid NOT NULL,
  evidence_b_kind text NOT NULL CHECK (evidence_b_kind IN ('observation', 'claim')),
  evidence_b_id uuid NOT NULL,
  note text NOT NULL CHECK (char_length(note) >= 1 AND char_length(note) <= 2048),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_kind text CHECK (resolved_by_kind IN ('belief', 'claim', 'observation')),
  resolved_by_id uuid,
  resolution_note text,
  -- Canonical pair order: the service normalizes the unordered pair, and the
  -- row comparison makes the canonical form checkable in SQL, so one pair
  -- maps to exactly one row per tenant (see contradictions_pair_unique).
  CONSTRAINT contradictions_canonical_order CHECK (
    (evidence_a_kind, evidence_a_id) < (evidence_b_kind, evidence_b_id)
  ),
  CONSTRAINT contradictions_pair_unique
    UNIQUE (tenant_id, evidence_a_kind, evidence_a_id, evidence_b_kind, evidence_b_id),
  CONSTRAINT contradictions_resolution_shape CHECK (
    (status = 'open'
      AND resolved_at IS NULL
      AND resolved_by_kind IS NULL
      AND resolved_by_id IS NULL
      AND resolution_note IS NULL)
    OR (status = 'resolved'
      AND resolved_at IS NOT NULL
      AND resolution_note IS NOT NULL
      AND (resolved_by_kind IS NULL) = (resolved_by_id IS NULL))
  )
);

CREATE INDEX contradictions_tenant_detected_idx ON contradictions (tenant_id, detected_at DESC);
CREATE INDEX contradictions_tenant_evidence_a_idx
  ON contradictions (tenant_id, evidence_a_kind, evidence_a_id);
CREATE INDEX contradictions_tenant_evidence_b_idx
  ON contradictions (tenant_id, evidence_b_kind, evidence_b_id);

-- Retention guard (lock 12): the contradiction record and BOTH evidence
-- links are frozen at insert; resolution is the only legal mutation and it
-- is one-way. Nothing can rewrite which evidence conflicted, and nothing
-- can delete the record — even a caller bypassing the service.
CREATE OR REPLACE FUNCTION contradictions_retention_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'contradictions are retained (architecture lock 12): % is forbidden on table %',
      TG_OP, TG_TABLE_NAME;
  END IF;
  IF OLD.status = 'resolved' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.evidence_a_kind IS DISTINCT FROM OLD.evidence_a_kind
      OR NEW.evidence_a_id IS DISTINCT FROM OLD.evidence_a_id
      OR NEW.evidence_b_kind IS DISTINCT FROM OLD.evidence_b_kind
      OR NEW.evidence_b_id IS DISTINCT FROM OLD.evidence_b_id
      OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
      OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
      OR NEW.resolved_by_kind IS DISTINCT FROM OLD.resolved_by_kind
      OR NEW.resolved_by_id IS DISTINCT FROM OLD.resolved_by_id
      OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
      RAISE EXCEPTION 'resolved contradictions are terminal (architecture lock 12): table % cannot be rewritten',
        TG_TABLE_NAME;
    END IF;
  ELSIF OLD.status = 'open' AND NEW.status = 'resolved' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.evidence_a_kind IS DISTINCT FROM OLD.evidence_a_kind
      OR NEW.evidence_a_id IS DISTINCT FROM OLD.evidence_a_id
      OR NEW.evidence_b_kind IS DISTINCT FROM OLD.evidence_b_kind
      OR NEW.evidence_b_id IS DISTINCT FROM OLD.evidence_b_id
      OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.detected_at IS DISTINCT FROM OLD.detected_at THEN
      RAISE EXCEPTION 'contradiction evidence links are frozen (architecture lock 12): % on table % would rewrite retained evidence',
        TG_OP, TG_TABLE_NAME;
    END IF;
  ELSE
    RAISE EXCEPTION 'contradiction status may only move forward open -> resolved (architecture lock 12): illegal transition on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contradictions_retention
  BEFORE UPDATE OR DELETE ON contradictions
  FOR EACH ROW EXECUTE FUNCTION contradictions_retention_guard();

CREATE TRIGGER contradictions_retention_truncate
  BEFORE TRUNCATE ON contradictions
  FOR EACH STATEMENT EXECUTE FUNCTION contradictions_retention_guard();

-- ---------------------------------------------------------------------------
-- Hypotheses — unresolved explanations
-- ---------------------------------------------------------------------------

CREATE TABLE hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  proposition text NOT NULL
    CHECK (char_length(proposition) >= 1 AND char_length(proposition) <= 2048),
  subject_kind text,
  subject_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'refuted')),
  supporting_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution_evidence_claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution_note text,
  CONSTRAINT hypotheses_subject_shape CHECK (
    (subject_kind IS NULL AND subject_id IS NULL)
    OR (subject_kind IS NOT NULL AND subject_id IS NOT NULL)
  ),
  CONSTRAINT hypotheses_supporting_shape
    CHECK (jsonb_typeof(supporting_observation_ids) = 'array'),
  CONSTRAINT hypotheses_resolution_shape CHECK (
    (status = 'open'
      AND resolved_at IS NULL
      AND resolution_note IS NULL
      AND jsonb_array_length(resolution_evidence_observation_ids) = 0
      AND jsonb_array_length(resolution_evidence_claim_ids) = 0)
    OR (status IN ('confirmed', 'refuted')
      AND resolved_at IS NOT NULL
      AND resolution_note IS NOT NULL)
  ),
  CONSTRAINT hypotheses_resolution_evidence_shape CHECK (
    jsonb_typeof(resolution_evidence_observation_ids) = 'array'
    AND jsonb_typeof(resolution_evidence_claim_ids) = 'array'
  )
);

CREATE INDEX hypotheses_tenant_recorded_idx ON hypotheses (tenant_id, recorded_at DESC);
CREATE INDEX hypotheses_tenant_status_idx ON hypotheses (tenant_id, status);
CREATE INDEX hypotheses_tenant_subject_idx ON hypotheses (tenant_id, subject_kind, subject_id);

-- Retention guard: identity is frozen, resolution is one-way, deletion is
-- forbidden — a refuted hypothesis stays as negative evidence.
CREATE OR REPLACE FUNCTION hypotheses_retention_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'hypotheses are retained (W007 epistemics): % is forbidden on table %',
      TG_OP, TG_TABLE_NAME;
  END IF;
  IF OLD.status <> 'open' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.proposition IS DISTINCT FROM OLD.proposition
      OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
      OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.supporting_observation_ids IS DISTINCT FROM OLD.supporting_observation_ids
      OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
      OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
      OR NEW.resolution_evidence_observation_ids IS DISTINCT FROM OLD.resolution_evidence_observation_ids
      OR NEW.resolution_evidence_claim_ids IS DISTINCT FROM OLD.resolution_evidence_claim_ids
      OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
      RAISE EXCEPTION 'resolved hypotheses are terminal (W007 epistemics): table % cannot be rewritten',
        TG_TABLE_NAME;
    END IF;
  ELSIF NEW.status IN ('confirmed', 'refuted') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.proposition IS DISTINCT FROM OLD.proposition
      OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
      OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR NEW.supporting_observation_ids IS DISTINCT FROM OLD.supporting_observation_ids
      OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
      RAISE EXCEPTION 'hypothesis identity fields are frozen (W007 epistemics): % on table % would rewrite retained propositions',
        TG_OP, TG_TABLE_NAME;
    END IF;
  ELSE
    RAISE EXCEPTION 'hypothesis status may only move forward open -> confirmed|refuted (W007 epistemics): illegal transition on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hypotheses_retention
  BEFORE UPDATE OR DELETE ON hypotheses
  FOR EACH ROW EXECUTE FUNCTION hypotheses_retention_guard();

CREATE TRIGGER hypotheses_retention_truncate
  BEFORE TRUNCATE ON hypotheses
  FOR EACH STATEMENT EXECUTE FUNCTION hypotheses_retention_guard();

-- ---------------------------------------------------------------------------
-- Unknowns — consequential gaps in knowledge (lock 7)
-- ---------------------------------------------------------------------------

CREATE TABLE unknowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  question text NOT NULL CHECK (char_length(question) >= 1 AND char_length(question) <= 2048),
  consequence text NOT NULL CHECK (char_length(consequence) >= 1 AND char_length(consequence) <= 2048),
  subject_kind text,
  subject_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  related_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_belief_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_kind text CHECK (resolution_kind IN ('belief', 'claim', 'observation')),
  resolution_id uuid,
  resolution_note text,
  CONSTRAINT unknowns_subject_shape CHECK (
    (subject_kind IS NULL AND subject_id IS NULL)
    OR (subject_kind IS NOT NULL AND subject_id IS NOT NULL)
  ),
  CONSTRAINT unknowns_related_shape CHECK (
    jsonb_typeof(related_observation_ids) = 'array'
    AND jsonb_typeof(related_claim_ids) = 'array'
    AND jsonb_typeof(related_belief_ids) = 'array'
  ),
  CONSTRAINT unknowns_resolution_shape CHECK (
    (status = 'open'
      AND resolved_at IS NULL
      AND resolution_kind IS NULL
      AND resolution_id IS NULL
      AND resolution_note IS NULL)
    OR (status = 'resolved'
      AND resolved_at IS NOT NULL
      AND resolution_note IS NOT NULL
      AND (resolution_kind IS NULL) = (resolution_id IS NULL))
  )
);

CREATE INDEX unknowns_tenant_recorded_idx ON unknowns (tenant_id, recorded_at DESC);
CREATE INDEX unknowns_tenant_status_idx ON unknowns (tenant_id, status);
CREATE INDEX unknowns_tenant_subject_idx ON unknowns (tenant_id, subject_kind, subject_id);

-- Retention guard: identity is frozen, resolution is one-way, deletion is
-- forbidden — a resolved unknown stays as an auditable record of a closed gap.
CREATE OR REPLACE FUNCTION unknowns_retention_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'unknowns are retained (architecture lock 7): % is forbidden on table %',
      TG_OP, TG_TABLE_NAME;
  END IF;
  IF OLD.status = 'resolved' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.question IS DISTINCT FROM OLD.question
      OR NEW.consequence IS DISTINCT FROM OLD.consequence
      OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
      OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.related_observation_ids IS DISTINCT FROM OLD.related_observation_ids
      OR NEW.related_claim_ids IS DISTINCT FROM OLD.related_claim_ids
      OR NEW.related_belief_ids IS DISTINCT FROM OLD.related_belief_ids
      OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
      OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
      OR NEW.resolution_kind IS DISTINCT FROM OLD.resolution_kind
      OR NEW.resolution_id IS DISTINCT FROM OLD.resolution_id
      OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
      RAISE EXCEPTION 'resolved unknowns are terminal (architecture lock 7): table % cannot be rewritten',
        TG_TABLE_NAME;
    END IF;
  ELSIF OLD.status = 'open' AND NEW.status = 'resolved' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.question IS DISTINCT FROM OLD.question
      OR NEW.consequence IS DISTINCT FROM OLD.consequence
      OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
      OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR NEW.related_observation_ids IS DISTINCT FROM OLD.related_observation_ids
      OR NEW.related_claim_ids IS DISTINCT FROM OLD.related_claim_ids
      OR NEW.related_belief_ids IS DISTINCT FROM OLD.related_belief_ids
      OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
      RAISE EXCEPTION 'unknown identity fields are frozen (architecture lock 7): % on table % would rewrite the retained gap',
        TG_OP, TG_TABLE_NAME;
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown status may only move forward open -> resolved (architecture lock 7): illegal transition on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER unknowns_retention
  BEFORE UPDATE OR DELETE ON unknowns
  FOR EACH ROW EXECUTE FUNCTION unknowns_retention_guard();

CREATE TRIGGER unknowns_retention_truncate
  BEFORE TRUNCATE ON unknowns
  FOR EACH STATEMENT EXECUTE FUNCTION unknowns_retention_guard();

-- ---------------------------------------------------------------------------
-- Beliefs — anchors of the versioned current working understanding
-- ---------------------------------------------------------------------------

CREATE TABLE beliefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_kind text,
  subject_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retire_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT beliefs_subject_shape CHECK (
    (subject_kind IS NULL AND subject_id IS NULL)
    OR (subject_kind IS NOT NULL AND subject_id IS NOT NULL)
  ),
  CONSTRAINT beliefs_retirement_shape CHECK (
    (status = 'active' AND retired_at IS NULL AND retire_reason IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL AND retire_reason IS NOT NULL)
  )
);

CREATE INDEX beliefs_tenant_created_idx ON beliefs (tenant_id, created_at DESC);
CREATE INDEX beliefs_tenant_status_idx ON beliefs (tenant_id, status);
CREATE INDEX beliefs_tenant_subject_idx ON beliefs (tenant_id, subject_kind, subject_id);

-- Lifecycle guard: the anchor's identity (subject, creation) is frozen;
-- active -> retired is the only legal mutation and it is one-way; DELETE is
-- rejected so a version chain in temporal_revisions is never orphaned from
-- its anchor. The versioned statements themselves are append-only in the
-- freshness module (its own storage-level triggers).
CREATE OR REPLACE FUNCTION beliefs_lifecycle_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'belief anchors are retained (W007 epistemics): % is forbidden on table %',
      TG_OP, TG_TABLE_NAME;
  END IF;
  IF OLD.status = 'retired' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
      OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.retire_reason IS DISTINCT FROM OLD.retire_reason
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
      RAISE EXCEPTION 'retired beliefs are terminal (W007 epistemics): table % cannot be rewritten',
        TG_TABLE_NAME;
    END IF;
  ELSIF OLD.status = 'active' AND NEW.status = 'retired' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
      OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'belief identity fields are frozen (W007 epistemics): % on table % would rewrite the belief anchor',
        TG_OP, TG_TABLE_NAME;
    END IF;
  ELSE
    RAISE EXCEPTION 'belief status may only move forward active -> retired (W007 epistemics): illegal transition on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER beliefs_lifecycle
  BEFORE UPDATE OR DELETE ON beliefs
  FOR EACH ROW EXECUTE FUNCTION beliefs_lifecycle_guard();

CREATE TRIGGER beliefs_lifecycle_truncate
  BEFORE TRUNCATE ON beliefs
  FOR EACH STATEMENT EXECUTE FUNCTION beliefs_lifecycle_guard();
