-- W081 · integration-intelligence module — authorized discovery, the
-- tenant-scoped Tool & System Inventory, why-it-matters explanations,
-- safe-by-default recommendations (bulk-approved through the actions
-- module's authority matrix) and post-connection verification records.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). There are deliberately NO provider-named columns: a discovered
-- system is described by capability classes and data categories (the
-- plain-language registry in vocabulary.ts), and the only provider-adjacent
-- value anywhere is the OPAQUE source id inherited from the sources
-- module's provider-neutral contract. Credential values never reach these
-- tables at all — credentials live behind the sources module's opaque
-- credentialRef and are resolved by its transport, never by this module.
--
-- No append-only immutability triggers here (unlike evidence tables): the
-- inventory, recommendations and grants are configuration + authorization
-- + derived-understanding state that legitimately moves (systems update
-- on re-discovery, recommendations advance through their lifecycle, grants
-- revoke). The EVIDENCE of discovery is immutable elsewhere — every
-- discovered system cites the observations (W004) its directory records
-- became, and the approval trail is the actions module's append-only
-- ActionRequest/ApprovalDecision history.

-- ---------------------------------------------------------------------------
-- Discovery grants — the ONLY authorization to discover (the no-scan gate)
-- ---------------------------------------------------------------------------

CREATE TABLE integration_discovery_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The sources module connector id (opaque; validated to exist in this
  -- tenant at grant time through the sources contract — a soft reference,
  -- the events/observations precedent: no cross-module foreign key).
  source_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  note text,
  CONSTRAINT integration_discovery_grants_source_unique UNIQUE (tenant_id, source_id),
  CONSTRAINT integration_discovery_grants_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT integration_discovery_grants_note_shape
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  -- A revoked grant keeps its revocation trail together or not at all.
  CONSTRAINT integration_discovery_grants_revocation_shape CHECK (
    status = 'active'
    OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT integration_discovery_grants_active_has_no_revocation CHECK (
    status = 'revoked'
    OR (revoked_by IS NULL AND revoked_at IS NULL)
  )
);

CREATE INDEX integration_discovery_grants_tenant_status_idx
  ON integration_discovery_grants (tenant_id, status, granted_at DESC);

-- ---------------------------------------------------------------------------
-- Tool & System Inventory — every discovered system, tenant-scoped
-- ---------------------------------------------------------------------------

CREATE TABLE integration_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The authorized grant whose poll surfaced this system (provenance).
  grant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  -- Canonical identity: `${sourceId}:${externalId}` — unique per tenant.
  -- Cross-directory entity resolution (two directories listing the same
  -- tool) is deliberately NOT attempted here: the journey's map step
  -- (W096) owns identity/entity mapping; W081 records honest per-directory
  -- identities.
  system_key text NOT NULL,
  external_id text NOT NULL,
  display_name text NOT NULL,
  description text,
  -- Registry keys (validated against vocabulary.ts at write time; the SQL
  -- layer guarantees array-ness and bounds — the house split for deeply
  -- shaped jsonb).
  capability_classes jsonb NOT NULL CHECK (
    jsonb_typeof(capability_classes) = 'array'
    AND jsonb_array_length(capability_classes) BETWEEN 1 AND 16
  ),
  -- The full capability surface (read + write-gated descriptors).
  capabilities jsonb NOT NULL CHECK (
    jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) <= 64
  ),
  -- Sorted union of the categories the capabilities put in play.
  data_categories jsonb NOT NULL CHECK (
    jsonb_typeof(data_categories) = 'array' AND jsonb_array_length(data_categories) <= 32
  ),
  health text NOT NULL DEFAULT 'unknown'
    CHECK (health IN ('unknown', 'healthy', 'degraded', 'unreachable')),
  connection_status text NOT NULL DEFAULT 'discovered'
    CHECK (connection_status IN ('discovered', 'connected', 'disconnected')),
  -- The deterministic why-it-matters explanation (plain organizational
  -- language; see explain.ts).
  why_it_matters jsonb NOT NULL CHECK (jsonb_typeof(why_it_matters) = 'object'),
  -- Observation ids evidencing the latest discoveries (≤ 10, newest first).
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(evidence_observation_ids) = 'array'
    AND jsonb_array_length(evidence_observation_ids) <= 10
  ),
  discovered_by text NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_systems_key_unique UNIQUE (tenant_id, system_key),
  CONSTRAINT integration_systems_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT integration_systems_external_id_shape
    CHECK (char_length(external_id) BETWEEN 1 AND 255),
  CONSTRAINT integration_systems_display_name_shape
    CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT integration_systems_description_shape
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  CONSTRAINT integration_systems_system_key_shape
    CHECK (char_length(system_key) BETWEEN 3 AND 312)
);

CREATE INDEX integration_systems_tenant_discovered_idx
  ON integration_systems (tenant_id, discovered_at DESC);
CREATE INDEX integration_systems_tenant_connection_idx
  ON integration_systems (tenant_id, connection_status, health);

-- ---------------------------------------------------------------------------
-- Recommendations — ranked, safe-by-default (read-only) connection proposals
-- ---------------------------------------------------------------------------

CREATE TABLE integration_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  system_id uuid NOT NULL,
  -- Frozen system identity for deterministic ranking (ORDER BY score DESC,
  -- system_key ASC — no clock, no randomness).
  system_key text NOT NULL,
  batch_id uuid,
  status text NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed', 'pending_approval', 'approved', 'rejected', 'connected')
  ),
  score integer NOT NULL CHECK (score >= 0),
  connection_mode text NOT NULL DEFAULT 'read-only' CHECK (connection_mode IN ('read-only')),
  -- Frozen at proposal time: the explanation and scope impact the approver
  -- was shown (audit trail of what was approved).
  why_it_matters jsonb NOT NULL CHECK (jsonb_typeof(why_it_matters) = 'object'),
  scope_impact jsonb NOT NULL CHECK (jsonb_typeof(scope_impact) = 'object'),
  proposed_by text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_recommendations_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT integration_recommendations_system_key_shape
    CHECK (char_length(system_key) BETWEEN 3 AND 312)
);

-- One LIVE recommendation per system at a time: a system may accumulate
-- historical (rejected) recommendations, but never two live ones (a
-- rejected human decision is respected — discovery does not re-propose).
CREATE UNIQUE INDEX integration_recommendations_live_unique
  ON integration_recommendations (tenant_id, system_id)
  WHERE status IN ('proposed', 'pending_approval', 'approved', 'connected');

CREATE INDEX integration_recommendations_tenant_status_idx
  ON integration_recommendations (tenant_id, status, score DESC);
CREATE INDEX integration_recommendations_tenant_batch_idx
  ON integration_recommendations (tenant_id, batch_id);

-- ---------------------------------------------------------------------------
-- Batches — bulk approval routed through the actions module (W009)
-- ---------------------------------------------------------------------------

CREATE TABLE integration_recommendation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The actions module's ActionRequest id (the W009 gate record; soft
  -- reference). The request is created BEFORE this row: a recommendation
  -- may never sit in a gated state without its gate record existing —
  -- an orphaned request (request exists, batch insert failed) is a
  -- harmless no-op approval surface, an orphaned batch would be a
  -- gate-bypass-shaped hole.
  action_request_id uuid,
  status text NOT NULL DEFAULT 'pending_request' CHECK (
    status IN ('pending_request', 'pending_approval', 'approved', 'rejected')
  ),
  recommendation_count integer NOT NULL CHECK (recommendation_count >= 1),
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_recommendation_batches_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT integration_recommendation_batches_request_state CHECK (
    status = 'pending_request' OR action_request_id IS NOT NULL
  )
);

CREATE INDEX integration_recommendation_batches_tenant_status_idx
  ON integration_recommendation_batches (tenant_id, status, submitted_at DESC);

-- ---------------------------------------------------------------------------
-- Verification runs — which promised capabilities actually verified reachable
-- ---------------------------------------------------------------------------

CREATE TABLE integration_verification_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  system_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'partial', 'failed')),
  -- Per promised read-capability probe results (the promised-vs-verified
  -- ledger the work item demands).
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  promised_count integer NOT NULL CHECK (promised_count >= 0),
  verified_count integer NOT NULL CHECK (verified_count >= 0),
  transport_wired boolean NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_verification_runs_id_tenant_unique UNIQUE (id, tenant_id),
  -- A run that says probes ran must carry a time and a consistent count.
  CONSTRAINT integration_verification_runs_decided_shape CHECK (
    status = 'pending'
    OR (verified_at IS NOT NULL AND verified_count <= promised_count)
  ),
  CONSTRAINT integration_verification_runs_pending_shape CHECK (
    status <> 'pending' OR (verified_count = 0 AND verified_at IS NULL)
  )
);

CREATE INDEX integration_verification_runs_tenant_system_idx
  ON integration_verification_runs (tenant_id, system_id, created_at DESC);
CREATE INDEX integration_verification_runs_tenant_recommendation_idx
  ON integration_verification_runs (tenant_id, recommendation_id, created_at DESC);
