-- W085 · meetings module — the canonical participant identity registry.
--
-- One row per (tenant, provider, canonical provider participant id): the
-- meeting participant identities Aurum has captured on sight. This is the
-- ADR-0003 discipline the identity module applies to channel providers,
-- applied to MEETING providers: session attendance and transcript speaker
-- attribution resolve through this registry, so the same person attending
-- ten meetings is one canonical identity with one stable registry id.
--
-- W085 deliberately does NOT extend the identity module: its
-- channel-provider vocabulary is frozen for messaging providers, and
-- unifying meeting identity with the full verified-linking workflow is
-- W095's declared job ("Extend identity proof so one person remains one
-- organizational identity across messaging, meetings, SMS, voice"). W085
-- performs the one contract-legal bridge available today, read-only:
-- `subject_id` records the organizational person (people.persons.id,
-- opaque — no cross-module foreign key is possible, the house pattern)
-- when the participant's email matches a VERIFIED, subject-linked email
-- identity in the identity module (W002). `resolved_via` names the
-- resolution path; null while unresolved.
--
-- This is a REGISTRY, not evidence: display facets may improve as the
-- provider reports richer data (`display_name`, `email`, `last_seen_at`
-- move), identity itself never does — (provider, provider_participant_id)
-- is immutable from creation. What was captured, and when, is preserved in
-- the session/transcript observations that cite the registry id.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id.

CREATE TABLE meeting_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'zoom', 'microsoft-teams', 'google-meet', 'recall'
  )),
  provider_participant_id text NOT NULL
    CHECK (char_length(provider_participant_id) BETWEEN 1 AND 255),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  email text CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 320),
  subject_id uuid,
  resolved_via text CHECK (
    resolved_via IS NULL OR resolved_via IN ('verified_email_identity')
  ),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_participants_tenant_provider_participant_unique
    UNIQUE (tenant_id, provider, provider_participant_id),
  CONSTRAINT meeting_participants_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_participants_resolution_shape CHECK (
    (subject_id IS NULL AND resolved_via IS NULL)
    OR (subject_id IS NOT NULL AND resolved_via IS NOT NULL)
  )
);

CREATE INDEX meeting_participants_tenant_provider_idx
  ON meeting_participants (tenant_id, provider, last_seen_at DESC);
CREATE INDEX meeting_participants_tenant_subject_idx
  ON meeting_participants (tenant_id, subject_id);

-- Storage-level guarantee: a participant's provider identity is immutable
-- from creation (it IS the registry key), and the identity-module
-- resolution can be revised by a later capture (a re-verified email
-- identity may resolve an already-resolved participant to another
-- subject) but never fabricated incoherently — subject without a
-- resolution path, or vice versa, is rejected outright by the CHECK
-- above. DELETE/TRUNCATE are forbidden: identity capture history is
-- reconstructable from the observations that cite the registry.

CREATE OR REPLACE FUNCTION meeting_participants_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'meeting participants are a canonical identity registry (W085 meetings): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'meeting participants are a canonical identity registry (W085 meetings): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.provider <> OLD.provider
     OR NEW.provider_participant_id <> OLD.provider_participant_id
     OR NEW.first_seen_at <> OLD.first_seen_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'meeting participants are a canonical identity registry (W085 meetings): only the display facets, resolution and sighting times may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_participants_facets_only_updates
  BEFORE UPDATE OR DELETE ON meeting_participants
  FOR EACH ROW EXECUTE FUNCTION meeting_participants_guard();

CREATE TRIGGER meeting_participants_immutable_truncate
  BEFORE TRUNCATE ON meeting_participants
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_participants_guard();
