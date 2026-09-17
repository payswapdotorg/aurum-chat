-- W053 · learning module — the versioned CompanyModel (ADR-0016).
--
-- ADR-0016 (Company Learning Model): "Aurum maintains a versioned
-- CompanyModel representing what it has learned about a specific tenant
-- beyond raw memories. The CompanyModel is derived from evidence, outcomes
-- and validated interactions and is never authoritative merely because it
-- was learned."
--
-- The model covers the ADR's ten knowledge areas — company vocabulary and
-- semantic conventions; organizational structure and role relationships;
-- process patterns and documented-versus-observed exceptions; source
-- reliability and freshness characteristics; employee expertise and
-- transactive-memory signals; capability patterns and known capability
-- gaps; goal interpretation and priority patterns; investigation and
-- source-selection preferences; intervention effectiveness priors; and
-- recurring organizational norms and exceptions.
--
-- Two tables, both FULLY append-only (the W040 discipline: no UPDATE
-- anywhere — the current model is DERIVED, never stored as mutable state):
--
--   company_model_updates    — one row per RECORDED LEARNING UPDATE: the
--                              change-set that carries a tenant-monotonic
--                              model_version (the "versioned" CompanyModel),
--                              the REQUIRED rationale (ADR-0016's learning
--                              invariant: "The learning update must identify
--                              what changed and why") and the acting party.
--                              This is the ONLY channel from completed
--                              evidence/outcomes to future behavior
--                              (ADR-0019: "The learning update path is the
--                              ONLY channel from outcomes to future
--                              behavior").
--
--   company_model_assertions — one row per LEARNED ASSERTION VERSION: what
--                              was learned (area + subject + topic +
--                              statement payload), with the ADR-mandated
--                              metadata on every row — provenance (evidence
--                              refs and/or a tenant-scoped outcome link),
--                              confidence (0..1), a validity interval
--                              (valid_from..valid_until) and learning/version
--                              metadata (per-chain version, supersedes link,
--                              the update that recorded it).
--
-- Versioning model (ADR-0016 "versioned"): an assertion chain is identified
-- by (area, subject_key, topic). Every learning update appends NEW rows to
-- the chains it touches; the new row supersedes the chain's previous head
-- (supersedes_id) and carries version = previous + 1. Nothing is ever
-- rewritten or deleted: superseded and retracted versions remain as
-- history (lock 12: contradictory evidence is retained), and the CURRENT
-- model is always derivable as "the highest-version row of each chain".
-- A 'retracted' disposition on a chain head closes that chain: the
-- assertion leaves the effective model while its history stays auditable.
--
-- Provider independence (ADR-0016: "CompanyModel state must survive
-- model/provider replacement"; lock 30): the two tables carry NO
-- provider/model identity of any kind — no provider names, no model names,
-- no execution-infrastructure state. Learned state is durable tenant data
-- in PostgreSQL (lock 35) and nothing else.
--
-- Policy authority (lock 14: "Learning cannot silently override explicit
-- policy"): the store itself holds no policy tables and no policy fields —
-- explicit policy lives in its owning modules; the CompanyModel's
-- application surface (service.ts rankCandidates) only ever reorders
-- caller-supplied, policy-vetted candidates and can never expand what
-- policy permits. The schema below additionally FORBIDS free-floating
-- assertions: every row must cite evidence references or link a settled
-- outcome (CHECK company_model_assertions_provenance_present), so a learned
-- preference can always be traced to evidence/outcomes.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FKs (supersedes_id, tenant_id), (update_id, tenant_id) and
-- (outcome_id, tenant_id) make cross-tenant references unrepresentable in
-- SQL (the W040 outcome_realizations pattern).

CREATE TABLE company_model_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The tenant-monotonic CompanyModel version this change-set mints.
  model_version integer NOT NULL CHECK (model_version >= 1),
  -- ADR-0016 learning invariant: the update identifies what changed and why.
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT company_model_updates_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- One version per tenant: the linear version of the whole CompanyModel,
  -- and the composite target of the assertions' update FK.
  CONSTRAINT company_model_updates_version_unique UNIQUE (tenant_id, model_version),
  CONSTRAINT company_model_updates_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX company_model_updates_version_idx
  ON company_model_updates (tenant_id, model_version DESC);

CREATE TABLE company_model_assertions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- One of the ten ADR-0016 knowledge areas (validation.ts mirrors this).
  area text NOT NULL CHECK (area IN (
    'vocabulary',
    'organization',
    'process_exception',
    'source_reliability',
    'employee_expertise',
    'capability_pattern',
    'goal_interpretation',
    'investigation_preference',
    'intervention_prior',
    'organizational_norm'
  )),
  -- What the assertion is about: a provider-neutral subject kind plus the
  -- normalized stable subject key ('<kind>:<uuid>' or '<kind>:<slug>';
  -- 'company' for company-wide assertions) and an optional human label.
  subject_kind text NOT NULL CHECK (subject_kind IN (
    'company',
    'term',
    'employee',
    'team',
    'role',
    'source',
    'process',
    'capability',
    'goal',
    'intervention',
    'agent'
  )),
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 2 AND 160),
  subject_label text
    CHECK (subject_label IS NULL OR char_length(subject_label) BETWEEN 1 AND 200),
  -- The specific dimension of the subject ('reliability', 'definition',
  -- 'reports_to', 'exception:expense-approval', ...). Two canonical topics
  -- carry machine-readable scores consumed by the application surface:
  -- ('source_reliability', 'reliability') and ('intervention_prior',
  -- 'effectiveness'), both with statement.score in [0, 1].
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 100),
  -- The learned assertion payload (a bounded JSON object; write-validated
  -- in validation.ts, mirrored here as defense in depth).
  statement jsonb NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  disposition text NOT NULL CHECK (disposition IN ('asserted', 'retracted')),
  -- The ADR-0016 validity interval: active during [valid_from, valid_until).
  valid_from timestamptz NOT NULL,
  valid_until timestamptz
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  -- Learning/version metadata: per-chain version (1-based), the previous
  -- head this row supersedes, and the recorded learning update that minted it.
  version integer NOT NULL CHECK (version >= 1),
  supersedes_id uuid,
  update_id uuid NOT NULL,
  -- Provenance: opaque evidence references (observation/event/document/
  -- report/system/metric/interaction/contribution — write-validated traceable
  -- refs) and/or ONE tenant-scoped outcome of THIS module (W040 outcomes),
  -- composite-FK'd so a learned assertion is never free-floating.
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  outcome_id uuid,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The chain a version belongs to: (area, subject_key, topic). One row per
  -- version — the UNIQUE constraint is the concurrency backstop that makes
  -- racing writers on the same chain lose cleanly.
  CONSTRAINT company_model_assertions_chain_unique
    UNIQUE (tenant_id, area, subject_key, topic, version),
  CONSTRAINT company_model_assertions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT company_model_assertions_supersedes_fk
    FOREIGN KEY (supersedes_id, tenant_id) REFERENCES company_model_assertions (id, tenant_id),
  CONSTRAINT company_model_assertions_update_fk
    FOREIGN KEY (update_id, tenant_id) REFERENCES company_model_updates (id, tenant_id),
  CONSTRAINT company_model_assertions_outcome_fk
    FOREIGN KEY (outcome_id, tenant_id) REFERENCES outcomes (id, tenant_id),
  -- ADR-0016: derived from evidence, outcomes and validated interactions —
  -- an assertion that cites nothing is unrepresentable.
  CONSTRAINT company_model_assertions_provenance_present
    CHECK (outcome_id IS NOT NULL OR jsonb_array_length(evidence) > 0)
);

-- Chain resolution (current head lookups), area scans for the model read
-- surface, the update join and the outcome attribution lookup.
CREATE INDEX company_model_assertions_chain_idx
  ON company_model_assertions (tenant_id, area, subject_key, topic, version DESC);
CREATE INDEX company_model_assertions_area_idx
  ON company_model_assertions (tenant_id, area, recorded_at);
CREATE INDEX company_model_assertions_update_idx
  ON company_model_assertions (tenant_id, update_id);
CREATE INDEX company_model_assertions_outcome_idx
  ON company_model_assertions (tenant_id, outcome_id);

-- Storage-level audit guarantee (the W040 pattern): CompanyModel updates
-- and assertions are append-only. Nothing may UPDATE, DELETE or TRUNCATE
-- either table — not even a future module bypassing the service. Learned
-- history is evidence; rewriting it would make the model's version
-- meaningless and destroy ADR-0016's attribution chain.

CREATE OR REPLACE FUNCTION company_model_updates_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'company model updates are append-only (W053 recorded learning updates): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER company_model_updates_immutable
  BEFORE UPDATE OR DELETE ON company_model_updates
  FOR EACH ROW EXECUTE FUNCTION company_model_updates_reject_mutation();

CREATE TRIGGER company_model_updates_immutable_truncate
  BEFORE TRUNCATE ON company_model_updates
  FOR EACH STATEMENT EXECUTE FUNCTION company_model_updates_reject_mutation();

CREATE OR REPLACE FUNCTION company_model_assertions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'company model assertions are append-only (W053 learned assertion versions): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER company_model_assertions_immutable
  BEFORE UPDATE OR DELETE ON company_model_assertions
  FOR EACH ROW EXECUTE FUNCTION company_model_assertions_reject_mutation();

CREATE TRIGGER company_model_assertions_immutable_truncate
  BEFORE TRUNCATE ON company_model_assertions
  FOR EACH STATEMENT EXECUTE FUNCTION company_model_assertions_reject_mutation();
