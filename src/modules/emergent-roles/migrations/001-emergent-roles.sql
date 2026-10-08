-- W138 · emergent-roles module — Emergent Roles + Marketplace
-- Publication.
--
-- The EMERGENCE PROJECTION (spec/work-items/WORK-ITEM-CATALOG.md
-- §W138): recurring capability gaps → evidence-backed RoleProposals →
-- governed review → marketplace submission REQUESTS and governed
-- activation RECORDS. The module aggregates existing evidence
-- authorities (W040 outcomes, W135 Lab calibrations, W136 execution
-- runs) and proposes — nothing here publishes, installs, recruits or
-- activates anything (the "publication/install/activation remain
-- governed" acceptance law): the marketplace (W028) owns the governed
-- package chain through INSTALLABLE, Agent Recruitment (W022) owns
-- approved acquisitions, and the actions matrix (W009) owns authority
-- decisions.
--
-- Load-bearing schema laws:
--   1. THE PROPOSAL CONTENT IS IMMUTABLE FROM CREATION. The evidence
--      citations, capability demands, alternatives and evaluation are
--      the proposal's frozen case — rewriting the case after reviews
--      or submissions reference it would corrupt the governance
--      history (the house "changed proposal is a NEW proposal" law).
--      Only the one-way lifecycle moves:
--      draft → under_review → approved | rejected → fulfilled, with
--      the draft | under_review → withdrawn exit; every transition
--      stamps its column EXACTLY ONCE.
--   2. GAP EVIDENCE, REVIEWS, SUBMISSIONS AND ACTIVATIONS ARE
--      APPEND-ONLY EVIDENCE (§24 "Audit records are append-only from
--      the domain perspective"). The emergence trail rejects
--      UPDATE/DELETE/TRUNCATE outright.
--   3. THE LAB AUTHORITY SEPARATION (the acceptance clause): the
--      principal that recorded an org-lab-sourced proposal cannot be
--      the principal that records its marketplace submission or its
--      activation — enforced by SERVICE typed errors AND by the
--      storage triggers below, so the bad rows are unrepresentable
--      even for callers bypassing the service (the marketplace
--      reviewPackage separation-of-duties precedent).
--   4. ONE UPSTREAM RECORD IS ONE GAP. Partial unique indexes make
--      each upstream outcome / recommendation / run citable as gap
--      evidence at most once per tenant — honest recurrence counting
--      (one missed outcome cannot pose as two gaps).
--
-- Cross-module references are opaque forward references, deliberately
-- NOT foreign keys (the house discipline), validated at write time
-- through their owning contracts and snapshotted where §24
-- reconstructability demands: gap capability → capabilities (W017,
-- readable + active), gap outcome source → learning (W040, settled +
-- missed), gap recommendation source → org-lab (W135, calibrated +
-- negative polarity), gap plan/run source → agent-exchange (W136,
-- readable plan + failed run), proposal provenance → org-lab (W135,
-- readable), review decisions → actions requests (W009, terminal; the
-- decision snapshot frozen verbatim), submission packages →
-- marketplace (W028, visible + kind 'agent'; key/version/state frozen
-- verbatim), activation acquisitions → agent-recruitment (W022,
-- approved).
--
-- Tenant scoping (ADR-0001): every table carries tenant_id; two
-- tenants hold fully independent emergence state, and cross-tenant
-- access is indistinguishable from missing records at the service
-- layer.

-- ---------------------------------------------------------------------------
-- The gap evidence — the aggregated recurring-gap detection input
-- (laws 2 + 4).
-- ---------------------------------------------------------------------------
CREATE TABLE role_gap_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  -- The capability the gap was observed in (validated readable +
  -- active through the capabilities contract at write time).
  capability_id uuid NOT NULL,
  -- The upstream seam, discriminated by source_kind (exactly one ref
  -- set per kind — the CHECK below).
  source_kind text NOT NULL CHECK (source_kind IN (
    'learning-outcome',
    'org-lab-recommendation',
    'execution-run'
  )),
  source_outcome_id uuid,
  source_recommendation_id uuid,
  source_plan_id uuid,
  source_run_id uuid,
  observation text NOT NULL
    CHECK (char_length(observation) >= 1 AND char_length(observation) <= 2000),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source_kind = 'learning-outcome'
       AND source_outcome_id IS NOT NULL
       AND source_recommendation_id IS NULL
       AND source_plan_id IS NULL
       AND source_run_id IS NULL)
    OR (source_kind = 'org-lab-recommendation'
       AND source_outcome_id IS NULL
       AND source_recommendation_id IS NOT NULL
       AND source_plan_id IS NULL
       AND source_run_id IS NULL)
    OR (source_kind = 'execution-run'
       AND source_outcome_id IS NULL
       AND source_recommendation_id IS NULL
       AND source_plan_id IS NOT NULL
       AND source_run_id IS NOT NULL)
  )
);

-- Law 4: one upstream record is one gap (per tenant, per seam).
CREATE UNIQUE INDEX role_gap_evidence_outcome_unique
  ON role_gap_evidence (tenant_id, source_outcome_id)
  WHERE source_kind = 'learning-outcome';
CREATE UNIQUE INDEX role_gap_evidence_recommendation_unique
  ON role_gap_evidence (tenant_id, source_recommendation_id)
  WHERE source_kind = 'org-lab-recommendation';
CREATE UNIQUE INDEX role_gap_evidence_run_unique
  ON role_gap_evidence (tenant_id, source_run_id)
  WHERE source_kind = 'execution-run';

CREATE INDEX role_gap_evidence_capability_idx
  ON role_gap_evidence (tenant_id, capability_id);
CREATE INDEX role_gap_evidence_kind_idx
  ON role_gap_evidence (tenant_id, source_kind, recorded_at);

-- ---------------------------------------------------------------------------
-- The role proposal — the emergence projection's spine (law 1).
-- ---------------------------------------------------------------------------
CREATE TABLE role_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  slug text NOT NULL
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text NOT NULL
    CHECK (char_length(title) >= 1 AND char_length(title) <= 200),
  -- The provenance: 'org-lab' proposals are the Lab's (the acceptance
  -- clause's authority separation keys on this + the origin principal).
  origin_kind text NOT NULL CHECK (origin_kind IN ('org-lab', 'tenant-operator')),
  origin_recommendation_id uuid,
  -- The principal that recorded the proposal (system-captured; the
  -- Lab-separation triggers compare against it).
  origin_principal_id text NOT NULL CHECK (char_length(origin_principal_id) >= 1),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'under_review', 'approved', 'rejected', 'fulfilled', 'withdrawn')),
  -- The frozen case (acceptance clause 1): evidence citations (2..16
  -- distinct gap-evidence ids), capability demands, alternatives with
  -- their evaluations, and the structured evaluation summary. All
  -- validated at write time; all immutable from creation.
  evidence_citations text[] NOT NULL
    CHECK (cardinality(evidence_citations) >= 2),
  demands jsonb NOT NULL
    CHECK (jsonb_typeof(demands) = 'array'),
  alternatives jsonb NOT NULL
    CHECK (jsonb_typeof(alternatives) = 'array'),
  evaluation jsonb NOT NULL
    CHECK (jsonb_typeof(evaluation) = 'object'),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  created_by text NOT NULL CHECK (char_length(created_by) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  submitted_by text
    CHECK (submitted_by IS NULL OR char_length(submitted_by) >= 1),
  decided_at timestamptz,
  fulfilled_at timestamptz,
  withdrawn_at timestamptz,
  -- The retained withdrawal reason (set exactly once by the withdrawal).
  lifecycle_note text
    CHECK (lifecycle_note IS NULL OR char_length(lifecycle_note) >= 1),
  UNIQUE (tenant_id, slug),
  CHECK (origin_kind <> 'org-lab' OR origin_recommendation_id IS NOT NULL),
  CHECK (origin_kind = 'org-lab' OR origin_recommendation_id IS NULL),
  CHECK (
    (status = 'draft'
       AND submitted_at IS NULL AND decided_at IS NULL
       AND fulfilled_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'under_review'
       AND submitted_at IS NOT NULL AND decided_at IS NULL
       AND fulfilled_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'approved'
       AND submitted_at IS NOT NULL AND decided_at IS NOT NULL
       AND fulfilled_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'rejected'
       AND submitted_at IS NOT NULL AND decided_at IS NOT NULL
       AND fulfilled_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'fulfilled'
       AND submitted_at IS NOT NULL AND decided_at IS NOT NULL
       AND fulfilled_at IS NOT NULL AND withdrawn_at IS NULL)
    OR (status = 'withdrawn'
       AND decided_at IS NULL AND fulfilled_at IS NULL
       AND withdrawn_at IS NOT NULL)
  )
);

CREATE INDEX role_proposals_tenant_status_idx ON role_proposals (tenant_id, status);
CREATE INDEX role_proposals_tenant_origin_idx ON role_proposals (tenant_id, origin_kind);

-- ---------------------------------------------------------------------------
-- The governed review — append-only records of authority decisions
-- (law 2). The W009 authority system decides; the module records the
-- frozen decision snapshot. At most one review per proposal (the
-- lifecycle is one-way).
-- ---------------------------------------------------------------------------
CREATE TABLE role_proposal_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  action_request_id uuid NOT NULL,
  decision jsonb NOT NULL
    CHECK (jsonb_typeof(decision) = 'object'),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, proposal_id)
);

CREATE INDEX role_proposal_reviews_proposal_idx
  ON role_proposal_reviews (tenant_id, proposal_id, recorded_at);

-- ---------------------------------------------------------------------------
-- The marketplace submission REQUEST — append-only (law 2). Cites a
-- REAL marketplace package created through the marketplace's own
-- governed vendor path; freezes its key/version/state verbatim. The
-- actual publication chain belongs to the marketplace and the platform.
-- ---------------------------------------------------------------------------
CREATE TABLE role_marketplace_submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  package_id uuid NOT NULL,
  package_key text NOT NULL CHECK (char_length(package_key) >= 1),
  package_version text NOT NULL CHECK (char_length(package_version) >= 1),
  package_state text NOT NULL
    CHECK (package_state IN (
      'DRAFT', 'SUBMITTED', 'AUTOMATED_VERIFICATION', 'PENDING_REVIEW',
      'APPROVED', 'REJECTED', 'PUBLISHED', 'INSTALLABLE'
    )),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX role_marketplace_submissions_proposal_idx
  ON role_marketplace_submissions (tenant_id, proposal_id, recorded_at);
CREATE INDEX role_marketplace_submissions_package_idx
  ON role_marketplace_submissions (tenant_id, package_id);

-- ---------------------------------------------------------------------------
-- The activation RECORD — append-only (law 2). Cites a REAL APPROVED
-- agent-recruitment proposal (the governed acquisition); recording it
-- moves the proposal's lifecycle approved → fulfilled.
-- ---------------------------------------------------------------------------
CREATE TABLE role_activations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  recruitment_proposal_id uuid NOT NULL,
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX role_activations_proposal_idx
  ON role_activations (tenant_id, proposal_id, recorded_at);
CREATE INDEX role_activations_recruitment_idx
  ON role_activations (tenant_id, recruitment_proposal_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (laws 2). Gap evidence, reviews, submissions
-- and activations reject every UPDATE/DELETE/TRUNCATE outright.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION emergent_roles_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'emergent-roles evidence is append-only (W138): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_gap_evidence_immutable
  BEFORE UPDATE OR DELETE ON role_gap_evidence
  FOR EACH ROW EXECUTE FUNCTION emergent_roles_reject_mutation();

CREATE TRIGGER role_gap_evidence_immutable_truncate
  BEFORE TRUNCATE ON role_gap_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION emergent_roles_reject_mutation();

CREATE TRIGGER role_proposal_reviews_immutable
  BEFORE UPDATE OR DELETE ON role_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION emergent_roles_reject_mutation();

CREATE TRIGGER role_proposal_reviews_immutable_truncate
  BEFORE TRUNCATE ON role_proposal_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION emergent_roles_reject_mutation();

CREATE TRIGGER role_marketplace_submissions_immutable
  BEFORE UPDATE OR DELETE ON role_marketplace_submissions
  FOR EACH ROW EXECUTE FUNCTION emergent_roles_reject_mutation();

CREATE TRIGGER role_marketplace_submissions_immutable_truncate
  BEFORE TRUNCATE ON role_marketplace_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION emergent_roles_reject_mutation();

CREATE TRIGGER role_activations_immutable
  BEFORE UPDATE OR DELETE ON role_activations
  FOR EACH ROW EXECUTE FUNCTION emergent_roles_reject_mutation();

CREATE TRIGGER role_activations_immutable_truncate
  BEFORE TRUNCATE ON role_activations
  FOR EACH STATEMENT EXECUTE FUNCTION emergent_roles_reject_mutation();

-- ---------------------------------------------------------------------------
-- The Lab authority separation (law 3, the acceptance clause). The
-- principal that recorded an org-lab-sourced proposal cannot record
-- its marketplace submission or its activation. Storage-level: the bad
-- rows are unrepresentable even for callers bypassing the service.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION emergent_roles_lab_no_self_publish() RETURNS trigger AS $$
DECLARE
  origin_kind text;
  origin_principal text;
BEGIN
  SELECT origin_kind, origin_principal_id INTO origin_kind, origin_principal
    FROM role_proposals
   WHERE tenant_id = NEW.tenant_id AND id = NEW.proposal_id;
  IF origin_kind = 'org-lab' AND NEW.recorded_by = origin_principal THEN
    RAISE EXCEPTION 'Lab authority separation (W138): the Lab cannot self-publish its own role proposal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_marketplace_submissions_lab_separation
  BEFORE INSERT ON role_marketplace_submissions
  FOR EACH ROW EXECUTE FUNCTION emergent_roles_lab_no_self_publish();

CREATE OR REPLACE FUNCTION emergent_roles_lab_no_self_activate() RETURNS trigger AS $$
DECLARE
  origin_kind text;
  origin_principal text;
BEGIN
  SELECT origin_kind, origin_principal_id INTO origin_kind, origin_principal
    FROM role_proposals
   WHERE tenant_id = NEW.tenant_id AND id = NEW.proposal_id;
  IF origin_kind = 'org-lab' AND NEW.recorded_by = origin_principal THEN
    RAISE EXCEPTION 'Lab authority separation (W138): the Lab cannot self-activate its own role proposal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_activations_lab_separation
  BEFORE INSERT ON role_activations
  FOR EACH ROW EXECUTE FUNCTION emergent_roles_lab_no_self_activate();

-- ---------------------------------------------------------------------------
-- The proposal pointer: the ONLY legal UPDATE is the one-way lifecycle
-- (draft → under_review → approved | rejected → fulfilled, plus the
-- draft | under_review → withdrawn exit), each transition stamping its
-- column exactly once and the withdrawal setting the retained reason;
-- every identity/content column is immutable; DELETE/TRUNCATE
-- forbidden (law 1).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION role_proposal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'role_proposals is lifecycle-managed (W138): % is forbidden — the emergence projection is durable evidence', TG_OP;
  END IF;

  -- Identity and content are immutable from creation.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.origin_kind IS DISTINCT FROM OLD.origin_kind
     OR NEW.origin_recommendation_id IS DISTINCT FROM OLD.origin_recommendation_id
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.evidence_citations IS DISTINCT FROM OLD.evidence_citations
     OR NEW.demands IS DISTINCT FROM OLD.demands
     OR NEW.alternatives IS DISTINCT FROM OLD.alternatives
     OR NEW.evaluation IS DISTINCT FROM OLD.evaluation
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'role_proposals content is immutable (W138): only the one-way lifecycle moves';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('under_review', 'withdrawn'))
       OR (OLD.status = 'under_review' AND NEW.status IN ('approved', 'rejected', 'withdrawn'))
       OR (OLD.status = 'approved' AND NEW.status = 'fulfilled')
     ) THEN
    RAISE EXCEPTION 'role_proposals lifecycle is one-way (W138): draft -> under_review -> approved|rejected -> fulfilled, with the draft|under_review -> withdrawn exit';
  END IF;

  IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     AND (OLD.submitted_at IS NOT NULL OR NEW.status NOT IN ('under_review', 'approved', 'rejected', 'fulfilled')) THEN
    RAISE EXCEPTION 'submission must stamp submitted_at exactly once, on the draft -> under_review transition';
  END IF;

  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     AND (OLD.submitted_by IS NOT NULL OR NEW.submitted_at IS NULL) THEN
    RAISE EXCEPTION 'submitted_by must be stamped exactly once, with submitted_at';
  END IF;

  IF NEW.decided_at IS DISTINCT FROM OLD.decided_at
     AND (OLD.decided_at IS NOT NULL OR NEW.status NOT IN ('approved', 'rejected', 'fulfilled')) THEN
    RAISE EXCEPTION 'the review must stamp decided_at exactly once, on the under_review -> approved|rejected transition';
  END IF;

  IF NEW.fulfilled_at IS DISTINCT FROM OLD.fulfilled_at
     AND (OLD.fulfilled_at IS NOT NULL OR NEW.status <> 'fulfilled') THEN
    RAISE EXCEPTION 'activation must stamp fulfilled_at exactly once, on the approved -> fulfilled transition';
  END IF;

  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
     AND (OLD.withdrawn_at IS NOT NULL OR NEW.status <> 'withdrawn') THEN
    RAISE EXCEPTION 'withdrawal must stamp withdrawn_at exactly once';
  END IF;

  IF NEW.lifecycle_note IS DISTINCT FROM OLD.lifecycle_note
     AND (OLD.lifecycle_note IS NOT NULL OR NEW.status <> 'withdrawn') THEN
    RAISE EXCEPTION 'role_proposals lifecycle_note may only be set by the withdrawal';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_proposals_immutable
  BEFORE UPDATE OR DELETE ON role_proposals
  FOR EACH ROW EXECUTE FUNCTION role_proposal_guard();

CREATE TRIGGER role_proposals_immutable_truncate
  BEFORE TRUNCATE ON role_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION role_proposal_guard();
