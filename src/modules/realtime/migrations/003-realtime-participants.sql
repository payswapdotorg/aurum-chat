-- W086 · realtime module — the per-session participant registry.
--
-- One row per (session, provider participant identity), captured on
-- sight (get-or-create — the ADR-0003 discipline the meetings module
-- applies to provider participants): a transcript turn or a consent
-- event may reference a participant whose join event is still in flight.
-- Speaker attribution, consent state and join/leave state hang off this
-- registry.
--
-- `subject_id` is an OPAQUE reference to the organizational person
-- resolved through the identity module's VERIFIED, subject-linked email
-- identities (W002) — the read-only bridge; full cross-modality
-- unification is W095's declared job. No cross-module foreign keys.
--
-- Roles: `human` (ordinary realtime client), `aurum` (Aurum's own agent
-- participant — exactly one per live session, minted by the provider's
-- adapter), `phone` (PSTN audio path — carries the E.164 number).
--
-- Mutable after creation: display facets (the transport may enrich
-- them), the verified-email resolution, consent, join/leave state. The
-- identity columns (session, provider participant id, role) are frozen —
-- a participant cannot become a different participant or swap roles.
-- The phone ⇔ role='phone' equivalence is CHECK-enforced.

CREATE TABLE realtime_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider_participant_id text NOT NULL
    CHECK (char_length(provider_participant_id) BETWEEN 1 AND 255),
  role text NOT NULL CHECK (role IN ('human', 'aurum', 'phone')),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  email text CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 320),
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  subject_id uuid,
  resolved_via text CHECK (resolved_via IS NULL OR resolved_via = 'verified_email_identity'),
  consent text NOT NULL DEFAULT 'pending' CHECK (consent IN ('pending', 'granted', 'revoked')),
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_participants_session_provider_unique
    UNIQUE (tenant_id, session_id, provider_participant_id),
  CONSTRAINT realtime_participants_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT realtime_participants_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES realtime_sessions (id, tenant_id),
  CONSTRAINT realtime_participants_phone_role CHECK (
    (role = 'phone') = (phone IS NOT NULL)
  ),
  CONSTRAINT realtime_participants_aurum_has_no_contact CHECK (
    role <> 'aurum' OR (email IS NULL AND phone IS NULL)
  )
);

CREATE INDEX realtime_participants_session_idx
  ON realtime_participants (tenant_id, session_id, created_at ASC);
CREATE INDEX realtime_participants_subject_idx
  ON realtime_participants (tenant_id, subject_id)
  WHERE subject_id IS NOT NULL;

-- Storage-level guarantee: the participant's identity within the session
-- is frozen; display facets, resolution, consent and attendance may move
-- forward but never backwards (a set join time cannot be un-joined). The
-- registry is session evidence — DELETE and TRUNCATE are forbidden.

CREATE OR REPLACE FUNCTION realtime_participants_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'realtime participants are the session identity registry (W086 realtime): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'realtime participants are the session identity registry (W086 realtime): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.session_id <> OLD.session_id
     OR NEW.provider_participant_id <> OLD.provider_participant_id
     OR NEW.role <> OLD.role THEN
    RAISE EXCEPTION 'realtime participants are the session identity registry (W086 realtime): identity is frozen on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER realtime_participants_identity_frozen_updates
  BEFORE UPDATE OR DELETE ON realtime_participants
  FOR EACH ROW EXECUTE FUNCTION realtime_participants_guard();

CREATE TRIGGER realtime_participants_immutable_truncate
  BEFORE TRUNCATE ON realtime_participants
  FOR EACH STATEMENT EXECUTE FUNCTION realtime_participants_guard();
