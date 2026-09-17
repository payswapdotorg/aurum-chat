-- W041 · learning module — company learning (versioned usefulness/preferences).
--
-- The work item (spec/work-items/WORK-ITEM-CATALOG.md, W041):
-- "Version company-specific usefulness/preferences from explicit, behavioral
--  and outcome feedback without mutating policy silently."
--
-- ADR-0016 (Company Learning Model — normative for the learning track):
-- "Each learned assertion has provenance, confidence, validity interval and
--  learning/version metadata. Explicit policy remains authoritative over
--  learned preference." And the learning invariant: "A completed project or
--  intervention may improve future behavior only through a recorded learning
--  update linked to evidence and outcome. The learning update must identify
--  what changed and why." Lock 14: "Learning cannot silently override explicit
--  policy." W053 (CompanyModel Learning) builds the full ADR-0016 model on
--  top of W041 + W042 + W040; this migration provides the versioned substrate
--  that item composes.
--
-- Two tables, both FULLY append-only (the W040 discipline):
--
--   company_learnings          — one immutable CHAIN-HEAD row per
--                                (tenant, target, aspect): the company-
--                                specific subject a usefulness/preference is
--                                versioned for. The target is an OPAQUE
--                                forward reference (kind + uuid id + optional
--                                label — the W040 subject precedent: sources
--                                W036, people W002, agents W021, extensions
--                                W025, missions W011, channels W030,
--                                processes W016, capabilities W017 own the
--                                records; no cross-module foreign keys). The
--                                aspect is the dimension being versioned
--                                ('source-reliability', 'preferred-channel',
--                                'usefulness', ... an open slug vocabulary —
--                                W053's CompanyModel owns the taxonomy).
--                                UNIQUE (tenant_id, target_kind, target_id,
--                                aspect) is the chain key: one version chain
--                                per company-specific subject.
--
--   company_learning_versions  — the append-only VERSION rows: each recorded
--                                feedback event mints version N+1 of its
--                                chain and NEVER rewrites history (what
--                                changed = the retained previous versions;
--                                why = the REQUIRED reason — ADR-0016's
--                                learning invariant). Each version carries:
--                                  * channel — which feedback leg produced
--                                    it: 'explicit' (a stated
--                                    usefulness/preference), 'behavioral'
--                                    (observed behavior — MUST cite ≥1
--                                    evidence reference: observed behavior is
--                                    only learnable from evidence) or
--                                    'outcome' (feedback grounded in a
--                                    SETTLED W040 outcome in the same
--                                    tenant — composite FK below; the frozen
--                                    met/exceeded/missed assessment is
--                                    snapshotted onto the version, so the
--                                    feedback signal stays self-contained);
--                                  * value — the learned assertion's content
--                                    (any plain JSON: a usefulness score, a
--                                    preference object, a ranking hint);
--                                  * confidence — 0..1;
--                                  * valid_from/valid_until — the validity
--                                    interval (valid_from is the service
--                                    clock's stamp; valid_until is an
--                                    optional ISO date);
--                                  * provenance — actor party + authenticated
--                                    principal + clock-stamped recorded_at +
--                                    optional opaque evidence references.
--
-- Version numbers are 1-based and monotonic per chain; the current version
-- of a chain is the maximum version (DERIVED — never stored as state, the
-- W040 discipline). There is deliberately NO operation to edit, reorder,
-- renumber or delete a version: a learned preference is versioned, not
-- mutated — nothing changes silently under a policy (or anything else) that
-- consumed an earlier version, and the whole chain stays reconstructable
-- (lock 37). PostgreSQL rejects UPDATE/DELETE/TRUNCATE on both tables via
-- the triggers below, even for a caller bypassing the service.
--
-- POLICY NON-AUTHORITY (the item's "without mutating policy silently",
-- lock 14, ADR-0016): learned preference state is ADVISORY. These tables
-- are not referenced by any policy surface, and no policy surface is
-- referenced from this module — the read model exposes `authoritative:
-- false` on every version (a system-minted constant) so every consumer
-- sees that explicit policy remains authoritative over learned preference.
-- Nothing here may write, relax or tighten tenant policy.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite FKs
-- (company_learning_id, tenant_id) → company_learnings (id, tenant_id) and
-- (outcome_id, tenant_id) → outcomes (id, tenant_id) make cross-tenant rows
-- unrepresentable in SQL (the outcome_realizations pattern from 001).

CREATE TABLE company_learnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  target_kind text NOT NULL
    CHECK (target_kind IN ('source', 'person', 'agent', 'extension', 'mission', 'channel', 'process', 'capability')),
  target_id text NOT NULL
    CHECK (target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  target_label text
    CHECK (target_label IS NULL OR char_length(target_label) BETWEEN 1 AND 200),
  aspect text NOT NULL
    CHECK (aspect ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The chain key: one version chain per company-specific subject.
  CONSTRAINT company_learnings_chain_unique UNIQUE (tenant_id, target_kind, target_id, aspect),
  -- The composite target of the tenant-scoped FK below.
  CONSTRAINT company_learnings_id_tenant_unique UNIQUE (id, tenant_id)
);

-- Chain lookups by subject and by aspect (the listing filters).
CREATE INDEX company_learnings_target_idx ON company_learnings (tenant_id, target_kind, target_id);
CREATE INDEX company_learnings_aspect_idx ON company_learnings (tenant_id, aspect);

CREATE TABLE company_learning_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_learning_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  channel text NOT NULL CHECK (channel IN ('explicit', 'behavioral', 'outcome')),
  value jsonb NOT NULL,
  confidence double precision NOT NULL
    CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  outcome_id uuid,
  outcome_assessment text
    CHECK (outcome_assessment IS NULL OR outcome_assessment IN ('met', 'exceeded', 'missed')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until text
    CHECK (valid_until IS NULL OR valid_until ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT company_learning_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- Same-tenant version of this chain only.
  CONSTRAINT company_learning_versions_learning_fk
    FOREIGN KEY (company_learning_id, tenant_id) REFERENCES company_learnings (id, tenant_id),
  -- Outcome feedback is grounded in a SETTLED outcome of THIS tenant —
  -- the W040 → W041 dependency made structural (cross-tenant outcome
  -- feedback is unrepresentable in SQL).
  CONSTRAINT company_learning_versions_outcome_fk
    FOREIGN KEY (outcome_id, tenant_id) REFERENCES outcomes (id, tenant_id),
  -- Version numbers are unique per chain (the writer serializes appends on
  -- the head row; this is the storage-level backstop).
  CONSTRAINT company_learning_versions_version_unique UNIQUE (tenant_id, company_learning_id, version),
  -- The channel shapes are surgical: outcome feedback carries the outcome
  -- link and its frozen assessment; explicit/behavioral feedback carries
  -- neither (explicit feedback is a statement, behavioral feedback is
  -- evidence-linked observed behavior).
  CONSTRAINT company_learning_versions_channel_shape CHECK (
    (channel = 'outcome' AND outcome_id IS NOT NULL AND outcome_assessment IS NOT NULL)
    OR (channel <> 'outcome' AND outcome_id IS NULL AND outcome_assessment IS NULL)
  ),
  -- Observed behavior is only learnable from evidence: behavioral feedback
  -- must cite at least one evidence reference.
  CONSTRAINT company_learning_versions_behavioral_evidence CHECK (
    channel <> 'behavioral' OR jsonb_array_length(evidence) >= 1
  )
);

-- The chain audit trail, ascending in version order.
CREATE INDEX company_learning_versions_learning_idx
  ON company_learning_versions (tenant_id, company_learning_id, version);
-- The "most recently learned" feed ordering.
CREATE INDEX company_learning_versions_recorded_idx
  ON company_learning_versions (tenant_id, recorded_at);
-- Outcome-linked learning lookups (which outcomes fed the model).
CREATE INDEX company_learning_versions_outcome_idx
  ON company_learning_versions (tenant_id, outcome_id);

-- Storage-level audit guarantee: chain heads and versions are append-only.
-- A learned preference is VERSIONED, never mutated — updating or deleting a
-- version would silently change what the company (and any policy built on
-- earlier state) had learned. Nothing may UPDATE, DELETE or TRUNCATE either
-- table, not even a future module bypassing the service. The messages name
-- no row id so the same functions serve row-level and statement-level
-- triggers.

CREATE OR REPLACE FUNCTION company_learnings_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'company learning chains are append-only (W041 company learning): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER company_learnings_immutable
  BEFORE UPDATE OR DELETE ON company_learnings
  FOR EACH ROW EXECUTE FUNCTION company_learnings_reject_mutation();

CREATE TRIGGER company_learnings_immutable_truncate
  BEFORE TRUNCATE ON company_learnings
  FOR EACH STATEMENT EXECUTE FUNCTION company_learnings_reject_mutation();

CREATE OR REPLACE FUNCTION company_learning_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'company learning versions are append-only (W041 versioned feedback): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER company_learning_versions_immutable
  BEFORE UPDATE OR DELETE ON company_learning_versions
  FOR EACH ROW EXECUTE FUNCTION company_learning_versions_reject_mutation();

CREATE TRIGGER company_learning_versions_immutable_truncate
  BEFORE TRUNCATE ON company_learning_versions
  FOR EACH STATEMENT EXECUTE FUNCTION company_learning_versions_reject_mutation();
