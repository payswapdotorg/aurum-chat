-- W028 · marketplace module — the governed package catalog.
--
-- ARCHITECTURE.md §17 (frozen) — "Marketplace lifecycle:
--   `DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW →
--    APPROVED / REJECTED → PUBLISHED → INSTALLABLE → ACTIVE /
--    SUSPENDED / DEPRECATED`."
-- W028 owns the chain through INSTALLABLE, for BOTH ExtensionPackage
-- and AgentPackage ("The same governance applies to AgentPackages").
-- Locks 26/27: "Marketplace publication and tenant installation/
-- activation are separate states"; "Third-party marketplace packages
-- remain pending until platform approval." ADR-0004: "Marketplace
-- artifacts have submission, verification, review, approval,
-- publication, installation and activation states. Third-party packages
-- remain unavailable for tenant installation until platform approval."
--
-- The ACTIVE/SUSPENDED/DEPRECATED tail is deliberately NOT here — the
-- extensions module owns it as the extension's own tenant-registry
-- lifecycle (W025), and lock 26 keeps publication and installation
-- separate. Tenant installation records themselves are downstream scope
-- (W026/W047 consume INSTALLABLE); W028 delivers the governed catalog.
--
-- PLATFORM TABLES (deliberately tenant_id-free, listed in
-- scripts/arch-allowlist.json as IMPLEMENTATION-STACK §3 provides: "every
-- domain table carries tenant_id (except the platform allow-list in
-- scripts/arch-allowlist.json)"). The catalog is platform-level by
-- nature: a published package is one vendor's offered artifact that
-- every tenant may see — that is the marketplace's purpose, and
-- ARCHITECTURE.md §3 sanctions exactly this ("Cross-tenant data access
-- is forbidden except through explicit platform-level operations that
-- never expose one tenant's business knowledge to another"). Tenancy is
-- therefore a VISIBILITY discipline, enforced by the service: a package
-- that is not yet PUBLISHED/INSTALLABLE is visible ONLY to its vendor
-- tenant and platform operators; for every other tenant it is
-- indistinguishable from missing (package_not_found — no existence
-- leak, ADR-0001 applied to the platform catalog).
--
-- Four tables:
--
--   marketplace_packages                — one immutable artifact version
--                                         per (kind, package_key,
--                                         version) + the mutable governed
--                                         state. Payload frozen at
--                                         creation; only state and
--                                         updated_at may ever change
--                                         (trigger). Versions strictly
--                                         increase per (kind, key).
--   marketplace_package_verifications   — append-only AUTOMATED_
--                                         VERIFICATION runs (per-check
--                                         evidence; the extensions
--                                         module's run discipline).
--   marketplace_package_reviews         — append-only platform review
--                                         decisions (the mandatory
--                                         human approval; rejection
--                                         requires a reason).
--   marketplace_package_lifecycle_events— append-only transition trail
--                                         (who moved the package, when,
--                                         from which state to which —
--                                         §24 reconstructability).
--
-- There is deliberately NO operation to update or delete a payload, no
-- un-reject, no un-publish: the catalog is append-only history (a fixed
-- artifact ships as a NEW version). The storage-level triggers below
-- enforce it even for callers bypassing the service.

CREATE TABLE marketplace_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_kind text NOT NULL CHECK (package_kind IN ('extension', 'agent')),
  package_key text NOT NULL CHECK (
    package_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  version_major integer NOT NULL CHECK (version_major >= 0),
  version_minor integer NOT NULL CHECK (version_minor >= 0),
  version_patch integer NOT NULL CHECK (version_patch >= 0),
  display_name text NOT NULL CHECK (display_name <> '' AND char_length(display_name) <= 120),
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  -- The frozen artifact content (jsonb shape floor below; vocabularies
  -- and bounds are service + AUTOMATED_VERIFICATION scope on purpose —
  -- the extensions module's cron-grammar precedent, so a bypass write
  -- with garbage vocabulary lands and is CAUGHT by verification).
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- The vendor provenance (the ownership chain): the submitting tenant
  -- and principal. Pre-publication visibility and the separation-of-
  -- duties review guard key off these.
  vendor_tenant uuid NOT NULL,
  vendor_principal text NOT NULL CHECK (vendor_principal <> ''),
  state text NOT NULL CHECK (state IN (
    'DRAFT', 'SUBMITTED', 'AUTOMATED_VERIFICATION', 'PENDING_REVIEW',
    'APPROVED', 'REJECTED', 'PUBLISHED', 'INSTALLABLE'
  )),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- One immutable artifact version per (kind, key, version): the
  -- storage floor under the service's strict monotonicity rule.
  CONSTRAINT marketplace_packages_kind_key_version_unique
    UNIQUE (package_kind, package_key, version),
  -- Payload shape floor per kind (structure only, never vocabulary).
  CONSTRAINT marketplace_packages_extension_payload_shape CHECK (
    package_kind <> 'extension'
    OR (
      jsonb_typeof(payload->'subject') = 'object'
      AND (payload->>'manifestId') IS NOT NULL
      AND (payload->>'extensionKey') IS NOT NULL
    )
  ),
  CONSTRAINT marketplace_packages_agent_payload_shape CHECK (
    package_kind <> 'agent'
    OR (
      (payload->>'role') IS NOT NULL
      AND (payload->>'instructions') IS NOT NULL
      AND (payload->>'provider') IS NOT NULL
      AND jsonb_typeof(payload->'permissions') = 'array'
    )
  )
);

-- The governed chain reads by state (review queue) and by key/version.
CREATE INDEX marketplace_packages_state_idx
  ON marketplace_packages (state, updated_at);
CREATE INDEX marketplace_packages_kind_key_version_idx
  ON marketplace_packages (package_kind, package_key, version_major DESC, version_minor DESC, version_patch DESC);
CREATE INDEX marketplace_packages_vendor_idx
  ON marketplace_packages (vendor_tenant, updated_at DESC);

-- Storage-level artifact immutability: a package may move ONLY its
-- governed state (and updated_at); its identity (kind, key, version),
-- frozen payload, vendor provenance and creation time are history.
-- DELETE and TRUNCATE are always forbidden — a rejected or superseded
-- version is catalog evidence, never garbage.

CREATE OR REPLACE FUNCTION marketplace_packages_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marketplace packages are catalog history (W028 marketplace governance): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'marketplace packages are catalog history (W028 marketplace governance): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.package_kind <> OLD.package_kind
     OR NEW.package_key <> OLD.package_key
     OR NEW.version <> OLD.version
     OR NEW.version_major <> OLD.version_major
     OR NEW.version_minor <> OLD.version_minor
     OR NEW.version_patch <> OLD.version_patch
     OR NEW.display_name <> OLD.display_name
     OR NEW.description <> OLD.description
     OR NEW.payload <> OLD.payload
     OR NEW.vendor_tenant <> OLD.vendor_tenant
     OR NEW.vendor_principal <> OLD.vendor_principal
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'marketplace packages are catalog history (W028 marketplace governance): only the governed state (state, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketplace_packages_state_only_updates
  BEFORE UPDATE OR DELETE ON marketplace_packages
  FOR EACH ROW EXECUTE FUNCTION marketplace_packages_guard();

CREATE TRIGGER marketplace_packages_immutable_truncate
  BEFORE TRUNCATE ON marketplace_packages
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace_packages_guard();

-- ---------------------------------------------------------------------------
-- AUTOMATED_VERIFICATION runs (append-only platform evidence)
-- ---------------------------------------------------------------------------

CREATE TABLE marketplace_package_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('verified', 'failed')),
  -- Per-check outcomes in the kind's canonical check order.
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  summary text NOT NULL CHECK (summary <> '' AND char_length(summary) <= 512),
  ran_by_tenant uuid NOT NULL,
  ran_by_principal text NOT NULL CHECK (ran_by_principal <> ''),
  ran_at timestamptz NOT NULL,
  CONSTRAINT marketplace_package_verifications_package_fk
    FOREIGN KEY (package_id) REFERENCES marketplace_packages (id)
);

CREATE INDEX marketplace_package_verifications_package_idx
  ON marketplace_package_verifications (package_id, ran_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Platform review decisions (append-only — the mandatory approval)
-- ---------------------------------------------------------------------------

CREATE TABLE marketplace_package_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason text
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  reviewed_by_tenant uuid NOT NULL,
  reviewed_by_principal text NOT NULL CHECK (reviewed_by_principal <> ''),
  reviewed_at timestamptz NOT NULL,
  CONSTRAINT marketplace_package_reviews_package_fk
    FOREIGN KEY (package_id) REFERENCES marketplace_packages (id),
  -- A rejection records its why (terminal transitions carry reasons).
  CONSTRAINT marketplace_package_reviews_rejection_reason CHECK (
    decision <> 'reject' OR reason IS NOT NULL
  )
);

-- Separation of duties at the storage floor: a platform review decision
-- may never be recorded by the vendor principal that offered the
-- package, nor from the vendor tenant (self-approval is unrepresentable
-- — the actions module's decideApproval discipline, applied to the
-- catalog). A trigger rather than a CHECK because it must read the
-- package row.
CREATE OR REPLACE FUNCTION marketplace_reviews_guard_vendor() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM marketplace_packages p
     WHERE p.id = NEW.package_id
       AND (p.vendor_principal = NEW.reviewed_by_principal
            OR p.vendor_tenant = NEW.reviewed_by_tenant)
  ) THEN
    RAISE EXCEPTION 'marketplace review decisions require separation of duties (W028 marketplace governance): the vendor principal/tenant cannot review its own package';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketplace_reviews_vendor_separation
  BEFORE INSERT ON marketplace_package_reviews
  FOR EACH ROW EXECUTE FUNCTION marketplace_reviews_guard_vendor();

CREATE INDEX marketplace_package_reviews_package_idx
  ON marketplace_package_reviews (package_id, reviewed_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Lifecycle events (the append-only transition trail)
-- ---------------------------------------------------------------------------

CREATE TABLE marketplace_package_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  transition text NOT NULL CHECK (transition IN (
    'submit', 'verify', 'verification-passed', 'verification-failed',
    'approve', 'reject', 'publish', 'make-installable'
  )),
  from_state text NOT NULL CHECK (from_state IN (
    'DRAFT', 'SUBMITTED', 'AUTOMATED_VERIFICATION', 'PENDING_REVIEW',
    'APPROVED', 'REJECTED', 'PUBLISHED', 'INSTALLABLE'
  )),
  to_state text NOT NULL CHECK (to_state IN (
    'DRAFT', 'SUBMITTED', 'AUTOMATED_VERIFICATION', 'PENDING_REVIEW',
    'APPROVED', 'REJECTED', 'PUBLISHED', 'INSTALLABLE'
  )),
  actor_tenant uuid NOT NULL,
  actor text NOT NULL CHECK (actor <> ''),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT marketplace_package_lifecycle_events_package_fk
    FOREIGN KEY (package_id) REFERENCES marketplace_packages (id),
  -- The entire pure state machine (lifecycle.ts) re-pinned at the
  -- storage level: only the exact legal (transition, from, to) triples
  -- can be recorded — a bypass write cannot invent a transition.
  CONSTRAINT marketplace_package_lifecycle_events_direction_shape CHECK (
    (transition = 'submit' AND from_state = 'DRAFT' AND to_state = 'SUBMITTED')
    OR (transition = 'verify' AND from_state = 'SUBMITTED' AND to_state = 'AUTOMATED_VERIFICATION')
    OR (transition = 'verification-passed' AND from_state = 'AUTOMATED_VERIFICATION' AND to_state = 'PENDING_REVIEW')
    OR (transition = 'verification-failed' AND from_state = 'AUTOMATED_VERIFICATION' AND to_state = 'REJECTED')
    OR (transition = 'approve' AND from_state = 'PENDING_REVIEW' AND to_state = 'APPROVED')
    OR (transition = 'reject' AND from_state = 'PENDING_REVIEW' AND to_state = 'REJECTED')
    OR (transition = 'publish' AND from_state = 'APPROVED' AND to_state = 'PUBLISHED')
    OR (transition = 'make-installable' AND from_state = 'PUBLISHED' AND to_state = 'INSTALLABLE')
  )
);

CREATE INDEX marketplace_package_lifecycle_events_package_idx
  ON marketplace_package_lifecycle_events (package_id, occurred_at DESC, id DESC);

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE a verification run, a review decision or a lifecycle event —
-- not even a future module bypassing the service. Governance evidence
-- is history the moment it is recorded.

CREATE OR REPLACE FUNCTION marketplace_evidence_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'marketplace governance evidence is append-only (W028 marketplace governance): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketplace_package_verifications_immutable
  BEFORE UPDATE OR DELETE ON marketplace_package_verifications
  FOR EACH ROW EXECUTE FUNCTION marketplace_evidence_reject_mutation();

CREATE TRIGGER marketplace_package_verifications_immutable_truncate
  BEFORE TRUNCATE ON marketplace_package_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace_evidence_reject_mutation();

CREATE TRIGGER marketplace_package_reviews_immutable
  BEFORE UPDATE OR DELETE ON marketplace_package_reviews
  FOR EACH ROW EXECUTE FUNCTION marketplace_evidence_reject_mutation();

CREATE TRIGGER marketplace_package_reviews_immutable_truncate
  BEFORE TRUNCATE ON marketplace_package_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace_evidence_reject_mutation();

CREATE TRIGGER marketplace_package_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON marketplace_package_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION marketplace_evidence_reject_mutation();

CREATE TRIGGER marketplace_package_lifecycle_events_immutable_truncate
  BEFORE TRUNCATE ON marketplace_package_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace_evidence_reject_mutation();
