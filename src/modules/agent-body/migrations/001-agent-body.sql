-- W133 · agent-body module — the persistent Aurum Agent Body and its
-- append-only model-binding attachments.
--
-- AGENT-BODY-LAB-CROSS-PLATFORM-ARCHITECTURE.md §1 is the contract:
-- "Aurum is a persistent model-agnostic Agent Body plus a separately
-- selected Model Binding. The body owns role, communication behavior,
-- information acquisition behavior, company context access, memory policy,
-- permitted capabilities, escalation behavior, evidence hooks and learning
-- hooks. The selected model owns provider, model id, modalities, tool
-- support and runtime characteristics. Changing the model does not replace
-- the body and does not reset company understanding or learning history."
--
-- That last sentence is carved into the SCHEMA, not just the service:
--   * agent_bodies is the persistent side — NOTHING provider-, model- or
--     runtime-shaped lives in it. Its identity (role) is immutable, its
--     lifecycle is the one-way active → retired transition, and rows are
--     never deleted or truncated (a body is organizational history; its
--     attachments are append-only evidence that must never dangle).
--   * agent_body_model_bindings is the possession side — an APPEND-ONLY
--     attachment log: a trigger rejects DELETE and TRUNCATE outright and
--     rejects every UPDATE except the one-way lifecycle transition
--     (active → superseded | detached, with its timestamp stamped exactly
--     once and every identity column — including the OPAQUE provider-
--     fabric binding reference and the VERBATIM policy-check payload —
--     immutable). A partial UNIQUE index enforces at most ONE active
--     attachment per (tenant, body, purpose); a per-body UNIQUE position
--     keeps the history deterministically ordered.
--
-- THE SWAP INVARIANT, enforced by structure: a model swap appends a new
-- attachment and supersedes the prior active one (same purpose) in ONE
-- transaction. The agent_bodies row is not part of that transaction's
-- writes — no UPDATE, no updated_at bump — so the body is byte-identical
-- before and after the swap. There is no ON UPDATE CASCADE, no trigger and
-- no column in agent_bodies that a binding attachment could touch.
--
-- binding_id is deliberately NOT a foreign key into the provider-fabric
-- tables: it is an OPAQUE reference stored VERBATIM (the codebase
-- discipline for cross-module references — audit's subject and coverage's
-- source precedents). Attachments are audit evidence that must survive
-- fabric-side supersession; existence validation is a composition/TL
-- integration concern, never a storage cascade.
--
-- Tenant scoping (ADR-0001): every table carries tenant_id; two tenants
-- hold fully independent bodies and attachment histories, and cross-tenant
-- access is indistinguishable from missing records at the service layer.

-- §1 AgentBody — the persistent, model-agnostic side.
CREATE TABLE agent_bodies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- Identity: tenant-unique immutable role slug.
  role text NOT NULL
    CHECK (role ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  label text NOT NULL
    CHECK (char_length(label) >= 1 AND char_length(label) <= 128),
  description text
    CHECK (description IS NULL OR char_length(description) <= 1024),
  -- The five §1 policy descriptors: honest plain-JSON-or-null. This layer
  -- stores what the body's policies SAY, exactly as asserted; null means
  -- "not stated", never "permissive".
  communication_behavior jsonb
    CHECK (communication_behavior IS NULL OR jsonb_typeof(communication_behavior) = 'object'),
  information_acquisition_behavior jsonb
    CHECK (information_acquisition_behavior IS NULL OR jsonb_typeof(information_acquisition_behavior) = 'object'),
  company_context_access jsonb
    CHECK (company_context_access IS NULL OR jsonb_typeof(company_context_access) = 'object'),
  memory_policy jsonb
    CHECK (memory_policy IS NULL OR jsonb_typeof(memory_policy) = 'object'),
  escalation_behavior jsonb
    CHECK (escalation_behavior IS NULL OR jsonb_typeof(escalation_behavior) = 'object'),
  -- Declared capability KEYS (grants/enforcement live in the capability
  -- authorities, not here).
  permitted_capabilities text[] NOT NULL DEFAULT '{}',
  -- Opaque (registry, ref) forward references — the coverage module's
  -- CoverageSource discipline; never credentials, never domain copies.
  evidence_hooks jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_hooks) = 'array'),
  learning_hooks jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(learning_hooks) = 'array'),
  -- One-way lifecycle.
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  -- System-captured principal (never caller-suppliable).
  created_by text NOT NULL CHECK (char_length(created_by) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A model swap NEVER bumps this (the swap path does not touch this row).
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (tenant_id, role),
  -- Lifecycle/stamp consistency: only a retired body carries retired_at.
  CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE INDEX agent_bodies_tenant_status_idx ON agent_bodies (tenant_id, status);

-- §1 BodyModelBinding — the append-only possession attachment.
CREATE TABLE agent_body_model_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  body_id uuid NOT NULL,
  -- OPAQUE provider-fabric binding reference, stored VERBATIM (never a
  -- foreign key — see the header note).
  binding_id text NOT NULL
    CHECK (char_length(binding_id) >= 1 AND char_length(binding_id) <= 256),
  -- The frozen W132 purpose vocabulary (types.ts mirrors it because the
  -- frozen contract exports types only).
  purpose text NOT NULL CHECK (purpose IN ('cognition', 'conversation', 'analysis', 'background')),
  -- The VERBATIM policy-check payload that authorized the attachment.
  policy_check jsonb NOT NULL CHECK (jsonb_typeof(policy_check) = 'object'),
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'detached')),
  -- Monotonic per-body attachment ordinal: deterministic history order.
  position integer NOT NULL CHECK (position >= 1),
  attached_by text NOT NULL CHECK (char_length(attached_by) >= 1),
  attached_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  detached_at timestamptz,
  detach_reason text
    CHECK (detach_reason IS NULL OR (char_length(detach_reason) >= 1 AND char_length(detach_reason) <= 2048)),
  -- Lifecycle/stamp consistency: each terminal state stamps exactly its
  -- own column, exactly once.
  CHECK (
    (status = 'active' AND superseded_at IS NULL AND detached_at IS NULL AND detach_reason IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL AND detached_at IS NULL AND detach_reason IS NULL)
    OR (status = 'detached' AND superseded_at IS NULL AND detached_at IS NOT NULL AND detach_reason IS NOT NULL)
  )
);

-- Deterministic per-body history order (and the position-monotonicity
-- backstop behind the service's FOR UPDATE allocation).
CREATE UNIQUE INDEX agent_body_bindings_position_unique
  ON agent_body_model_bindings (tenant_id, body_id, position);

-- ONE active attachment per (tenant, body, purpose) — the structural
-- heart of "a separately selected Model Binding": attaching a new binding
-- for a purpose must supersede the old one first, in the same transaction.
CREATE UNIQUE INDEX agent_body_bindings_one_active
  ON agent_body_model_bindings (tenant_id, body_id, purpose)
  WHERE status = 'active';

-- Audit lookup: which bodies ever possessed a given fabric binding.
CREATE INDEX agent_body_bindings_tenant_binding_idx
  ON agent_body_model_bindings (tenant_id, binding_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement for the attachment history (the epistemics/
-- goals/coverage trigger discipline, sharpened for the one-way lifecycle):
-- a row-level guard for UPDATE/DELETE plus a statement-level guard for
-- TRUNCATE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent_body_binding_guard() RETURNS trigger AS $$
BEGIN
  -- DELETE and TRUNCATE are forbidden outright: the attachment history is
  -- the audit (what possessed the body, when, under which policy check).
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'agent_body_model_bindings is append-only (W133): % is forbidden on the binding history', TG_OP;
  END IF;

  -- UPDATE: the ONLY legal change is the one-way lifecycle transition
  -- active -> superseded | detached. Never back, never sideways.
  IF OLD.status <> 'active' OR NEW.status NOT IN ('superseded', 'detached') THEN
    RAISE EXCEPTION 'agent_body_model_bindings lifecycle is one-way (W133): only active -> superseded | detached is legal';
  END IF;

  -- Every identity column is immutable — including the OPAQUE fabric
  -- reference and the VERBATIM policy-check payload: the audit may never
  -- be rewritten, only terminally stamped.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.body_id IS DISTINCT FROM OLD.body_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.policy_check IS DISTINCT FROM OLD.policy_check
     OR NEW.position IS DISTINCT FROM OLD.position
     OR NEW.attached_by IS DISTINCT FROM OLD.attached_by
     OR NEW.attached_at IS DISTINCT FROM OLD.attached_at THEN
    RAISE EXCEPTION 'agent_body_model_bindings is append-only (W133): attachment identity columns are immutable';
  END IF;

  IF NEW.status = 'superseded' THEN
    IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
      RAISE EXCEPTION 'supersede must stamp superseded_at exactly once';
    END IF;
    IF NEW.detached_at IS DISTINCT FROM OLD.detached_at
       OR NEW.detach_reason IS DISTINCT FROM OLD.detach_reason THEN
      RAISE EXCEPTION 'supersede must not touch the detach columns';
    END IF;
  ELSE
    IF OLD.detached_at IS NOT NULL OR NEW.detached_at IS NULL THEN
      RAISE EXCEPTION 'detach must stamp detached_at exactly once';
    END IF;
    IF NEW.detach_reason IS NULL THEN
      RAISE EXCEPTION 'detach requires a reason';
    END IF;
    IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'detach must not touch superseded_at';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_body_bindings_immutable
  BEFORE UPDATE OR DELETE ON agent_body_model_bindings
  FOR EACH ROW EXECUTE FUNCTION agent_body_binding_guard();

CREATE TRIGGER agent_body_bindings_immutable_truncate
  BEFORE TRUNCATE ON agent_body_model_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION agent_body_binding_guard();

-- ---------------------------------------------------------------------------
-- Lifecycle guard for the bodies themselves: the role (identity) is
-- immutable, the status moves one way (active -> retired, stamped once),
-- provenance columns never change, and rows are never deleted or
-- truncated — a body is organizational history, and its append-only
-- attachments must never dangle.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent_body_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'agent_bodies is lifecycle-managed (W133): % is forbidden — retire the body instead; its binding attachments are append-only evidence', TG_OP;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'agent_bodies.role is immutable (W133): role is the body identity';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_bodies identity columns are immutable (W133)';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION 'agent_bodies lifecycle is one-way (W133): active -> retired only';
  END IF;

  IF NEW.status = 'retired' AND (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL) THEN
    RAISE EXCEPTION 'retire must stamp retired_at exactly once';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_bodies_immutable
  BEFORE UPDATE OR DELETE ON agent_bodies
  FOR EACH ROW EXECUTE FUNCTION agent_body_guard();

CREATE TRIGGER agent_bodies_immutable_truncate
  BEFORE TRUNCATE ON agent_bodies
  FOR EACH STATEMENT EXECUTE FUNCTION agent_body_guard();
