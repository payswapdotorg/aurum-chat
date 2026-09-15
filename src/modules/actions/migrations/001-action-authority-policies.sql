-- W009 · actions module — the authority matrix (tenant-scoped policy rows).
--
-- ARCHITECTURE.md §20: "Actions are classified as OBSERVE, ANALYZE,
-- RECOMMEND, ASK, PROPOSE and EXECUTE. Tenant policy defines which
-- authority levels and operations require human approval." One row per
-- (tenant, action kind) — plus the NULL-kind tenant-wide DEFAULT row —
-- declares:
--   * approval_levels  — the levels gated behind a human approval
--                        decision (deterministic approval gates);
--   * forbidden_levels — the levels forbidden outright (no approval
--                        path exists);
-- levels in neither list are allowed. Resolution (service layer): the
-- kind's row first, then the default row, then the built-in default
-- matrix (OBSERVE/ANALYZE/RECOMMEND/ASK/PROPOSE allowed, EXECUTE
-- approval-gated).
--
-- The kind namespace is open: any canonical slug (KIND_PATTERN) may carry
-- a policy — future modules (agents W021+, extensions W025+,
-- destinations W037, ...) register their kinds by using them. The §20
-- enumeration (employee-messaging, source-access, data-export,
-- agent-recruitment, agent-termination, extension-deployment,
-- external-communication) is anchored in code (CANONICAL_ACTION_KINDS),
-- not restricted here.
--
-- Policies are management controls, NOT evidence: they are legitimately
-- updatable (setAuthorityPolicy upserts; updated_at moves) and therefore
-- carry NO immutability triggers. Their full change history belongs to
-- the audit module (W046), not W009 — the same discipline the freshness
-- module applies to stale-after policies.
--
-- Levels are stored as sorted jsonb arrays (the house pattern for list
-- columns — see temporal_revisions.provenance_observation_ids and
-- observations.usage_tags). The CHECK constraints below pin the shape
-- and the six-level vocabulary; the trigger enforces the one rule a
-- CHECK cannot express without subqueries — no level may be BOTH
-- approval-gated and forbidden (the matrix must be unambiguous; the pure
-- evaluator would let forbidden win, but the data layer keeps rows
-- well-formed regardless of which path wrote them).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; one policy per
-- (tenant, kind) — UNIQUE NULLS NOT DISTINCT treats two NULL action_kind
-- rows as the same key (the default).

CREATE TABLE action_authority_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  action_kind text,
  approval_levels jsonb NOT NULL DEFAULT '[]'::jsonb,
  forbidden_levels jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT action_authority_policies_subject_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, action_kind),
  CONSTRAINT action_authority_policies_levels_shape CHECK (
    jsonb_typeof(approval_levels) = 'array'
    AND jsonb_typeof(forbidden_levels) = 'array'
  ),
  CONSTRAINT action_authority_policies_levels_vocabulary CHECK (
    approval_levels <@ '["OBSERVE","ANALYZE","RECOMMEND","ASK","PROPOSE","EXECUTE"]'::jsonb
    AND forbidden_levels <@ '["OBSERVE","ANALYZE","RECOMMEND","ASK","PROPOSE","EXECUTE"]'::jsonb
  )
);

CREATE INDEX action_authority_policies_tenant_kind_idx
  ON action_authority_policies (tenant_id, action_kind);

-- The ambiguity guard: no level may be both approval-gated and forbidden.

CREATE OR REPLACE FUNCTION action_authority_policies_check_levels() RETURNS trigger AS $$
DECLARE
  level text;
  vocabulary text[] := ARRAY['OBSERVE','ANALYZE','RECOMMEND','ASK','PROPOSE','EXECUTE'];
BEGIN
  FOR level IN SELECT jsonb_array_elements_text(NEW.approval_levels) LOOP
    IF NOT level = ANY(vocabulary) THEN
      RAISE EXCEPTION 'unknown authority level ''%'' in approval_levels (W009 authority matrix)', level;
    END IF;
    IF NEW.forbidden_levels @> to_jsonb(level) THEN
      RAISE EXCEPTION 'authority level ''%'' cannot be both approval-gated and forbidden (W009 authority matrix)', level;
    END IF;
  END LOOP;
  FOR level IN SELECT jsonb_array_elements_text(NEW.forbidden_levels) LOOP
    IF NOT level = ANY(vocabulary) THEN
      RAISE EXCEPTION 'unknown authority level ''%'' in forbidden_levels (W009 authority matrix)', level;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER action_authority_policies_levels_valid
  BEFORE INSERT OR UPDATE ON action_authority_policies
  FOR EACH ROW EXECUTE FUNCTION action_authority_policies_check_levels();
