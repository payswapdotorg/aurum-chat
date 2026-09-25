-- W090 · provider-billing module — the Aurum Provider Billing Gateway:
-- tenant-scoped payment arrangements (aurum-mediated settlement vs the
-- explicit direct-customer fallback), the append-only provider usage
-- ledger (cost attributed to tenant/capability/execution), tenant budget
-- policy rows with their append-only enforcement audit, and the
-- settlement state machine (window claim → idempotent charge → auditable
-- receipt) with append-only lines and events.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). No credential VALUE ever reaches any of these tables: the
-- billing provider's instance key is wiring-time adapter configuration
-- (GOVERNANCE mandatory invariant; IMPLEMENTATION-STACK §8); receipts
-- carry only OPAQUE provider receipt references.
--
-- The `gateway` / `provider` / `settlement_adapter_key` columns are
-- deliberately OPEN vocabularies (shape-checked only, not closed CHECKs):
-- "Abstract supported provider payment … behind Aurum" — wiring a new
-- gateway (llm today; agents/channels/… tomorrow) or a new settlement
-- adapter must require no migration (the connection-broker module's
-- open-broker discipline). First-party adapter keys live in
-- src/modules/provider-billing/adapters/.
--
-- NOTE: the budget scope CHECKs mirror the scope-shape validation in
-- src/modules/provider-billing/validation.ts — keep both in sync.

-- ---------------------------------------------------------------------------
-- Payment arrangements — how one (gateway, provider) is paid
-- ---------------------------------------------------------------------------

CREATE TABLE provider_payment_arrangements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  gateway text NOT NULL CHECK (gateway ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  arrangement text NOT NULL CHECK (arrangement IN ('aurum-mediated', 'direct-customer')),
  -- Settlement adapter key (open vocabulary); required iff aurum-mediated.
  settlement_adapter_key text
    CHECK (settlement_adapter_key IS NULL OR char_length(settlement_adapter_key) BETWEEN 1 AND 64),
  -- The explicit external billing requirement; required iff direct-customer.
  direct_billing_note text
    CHECK (direct_billing_note IS NULL OR char_length(direct_billing_note) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_payment_arrangements_key_unique UNIQUE (tenant_id, gateway, provider),
  CONSTRAINT provider_payment_arrangements_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT provider_payment_arrangements_mediated_shape CHECK (
    arrangement <> 'aurum-mediated' OR settlement_adapter_key IS NOT NULL
  ),
  CONSTRAINT provider_payment_arrangements_direct_shape CHECK (
    arrangement <> 'direct-customer'
    OR (settlement_adapter_key IS NULL AND direct_billing_note IS NOT NULL)
  )
);

CREATE INDEX provider_payment_arrangements_tenant_idx
  ON provider_payment_arrangements (tenant_id, status, gateway);

-- ---------------------------------------------------------------------------
-- Provider budgets — tenant budget policy (block / route usage)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('tenant', 'gateway', 'provider', 'capability')),
  gateway text CHECK (gateway IS NULL OR gateway ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider text CHECK (provider IS NULL OR provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  capability text CHECK (capability IS NULL OR capability ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- Canonical scope-key encoding ('' | 'g' | 'g:p' | 'g:p:c') — the
  -- per-tenant budget namespace (see budget.ts budgetScopeKey).
  scope_key text NOT NULL CHECK (char_length(scope_key) <= 200),
  budget_minor bigint NOT NULL
    CHECK (budget_minor >= 0 AND budget_minor <= 1000000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  enforcement text NOT NULL CHECK (enforcement IN ('block', 'observe')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_budgets_scope_key_unique UNIQUE (tenant_id, scope_key),
  CONSTRAINT provider_budgets_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT provider_budgets_tenant_shape CHECK (
    scope <> 'tenant' OR (gateway IS NULL AND provider IS NULL AND capability IS NULL)
  ),
  CONSTRAINT provider_budgets_gateway_shape CHECK (
    scope <> 'gateway' OR (gateway IS NOT NULL AND provider IS NULL AND capability IS NULL)
  ),
  CONSTRAINT provider_budgets_provider_shape CHECK (
    scope <> 'provider' OR (gateway IS NOT NULL AND provider IS NOT NULL AND capability IS NULL)
  ),
  CONSTRAINT provider_budgets_capability_shape CHECK (
    scope <> 'capability'
    OR (gateway IS NOT NULL AND provider IS NOT NULL AND capability IS NOT NULL)
  )
);

CREATE INDEX provider_budgets_tenant_status_idx
  ON provider_budgets (tenant_id, status);

-- Budget enforcement audit — append-only evidence of the outcomes that
-- bit (blocked usage / observed exceedance), with the full deterministic
-- enforcement snapshot frozen at check time. Later budget edits never
-- rewrite what a recorded check decided.

CREATE TABLE provider_budget_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL
    REFERENCES provider_budgets (id),
  scope_key text NOT NULL CHECK (char_length(scope_key) <= 200),
  event text NOT NULL CHECK (event IN ('blocked', 'observed_exceeded')),
  detail text NOT NULL CHECK (char_length(detail) BETWEEN 1 AND 2000),
  enforcement jsonb NOT NULL CHECK (jsonb_typeof(enforcement) = 'object'),
  checked_by text NOT NULL CHECK (checked_by <> ''),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT provider_budget_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX provider_budget_events_tenant_idx
  ON provider_budget_events (tenant_id, occurred_at DESC);
CREATE INDEX provider_budget_events_budget_idx
  ON provider_budget_events (tenant_id, budget_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Provider usage records — the append-only cost-attribution ledger
-- ---------------------------------------------------------------------------

CREATE TABLE provider_usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  gateway text NOT NULL CHECK (gateway ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  capability text NOT NULL CHECK (capability ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- Opaque references into the OWNING gateway's records (validated there).
  execution_ref text CHECK (execution_ref IS NULL OR char_length(execution_ref) BETWEEN 1 AND 255),
  account_ref text CHECK (account_ref IS NULL OR char_length(account_ref) BETWEEN 1 AND 255),
  cost_minor bigint NOT NULL
    CHECK (cost_minor >= 0 AND cost_minor <= 1000000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  quantity bigint CHECK (quantity IS NULL OR (quantity >= 0 AND quantity <= 1000000000000)),
  unit text CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 64),
  source text NOT NULL DEFAULT 'gateway' CHECK (char_length(source) BETWEEN 1 AND 64),
  -- Emitter-supplied dedupe key — unique per (tenant, gateway): a recorded
  -- key replays the original record on retry (first write wins; the events
  -- module's semantics).
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_usage_records_dedupe_unique UNIQUE (tenant_id, gateway, dedupe_key),
  CONSTRAINT provider_usage_records_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT provider_usage_records_quantity_shape CHECK (
    (quantity IS NULL AND unit IS NULL) OR (quantity IS NOT NULL AND unit IS NOT NULL)
  )
);

CREATE INDEX provider_usage_records_tenant_scope_idx
  ON provider_usage_records (tenant_id, gateway, provider, capability, occurred_at);
CREATE INDEX provider_usage_records_tenant_occurred_idx
  ON provider_usage_records (tenant_id, occurred_at DESC);
CREATE INDEX provider_usage_records_tenant_execution_idx
  ON provider_usage_records (tenant_id, execution_ref) WHERE execution_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Provider settlements — the durable settlement state machine
-- ---------------------------------------------------------------------------

CREATE TABLE provider_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  gateway text NOT NULL CHECK (gateway ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  arrangement text NOT NULL CHECK (arrangement = 'aurum-mediated'),
  settlement_adapter_key text NOT NULL CHECK (char_length(settlement_adapter_key) BETWEEN 1 AND 64),
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'settling' CHECK (status IN ('settling', 'settled', 'failed')),
  line_count integer NOT NULL CHECK (line_count >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0 AND amount_minor <= 1000000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- OPAQUE settlement-adapter receipt reference (never a receipt payload).
  receipt_ref text CHECK (receipt_ref IS NULL OR char_length(receipt_ref) BETWEEN 1 AND 255),
  -- The adapter's NORMALIZED, provider-neutral receipt payload (the W089
  -- definition discipline: no provider-native object crosses the adapter;
  -- bounded to 4 KiB so a misbehaving adapter cannot bloat the ledger).
  receipt_payload jsonb
    CHECK (receipt_payload IS NULL OR (jsonb_typeof(receipt_payload) = 'object'
      AND octet_length(receipt_payload::text) <= 4096)),
  -- SHA-256 hex digest over the receipt's canonical content.
  receipt_digest text CHECK (receipt_digest IS NULL OR receipt_digest ~ '^[0-9a-f]{64}$'),
  -- The W009 action request that authorized this settlement (soft
  -- reference — the actions module's own table; the extension-deployments
  -- precedent: no cross-module FK).
  action_request_id uuid NOT NULL,
  -- Canonical normalized failure (W089 taxonomy) when status is 'failed'.
  failure jsonb CHECK (failure IS NULL OR jsonb_typeof(failure) = 'object'),
  failure_detail text CHECK (failure_detail IS NULL OR char_length(failure_detail) BETWEEN 1 AND 2000),
  -- The charge lease: a 'settling' row older than its lease may be
  -- re-driven by a retry (the adapter's idempotency key keeps the charge
  -- exactly-once — the W080 lease discipline applied to money movement).
  lease_expires_at timestamptz,
  settled_by text CHECK (settled_by IS NULL OR settled_by <> ''),
  settled_at timestamptz,
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_settlements_window_unique UNIQUE (tenant_id, gateway, provider, window_from, window_to),
  CONSTRAINT provider_settlements_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT provider_settlements_window_order CHECK (window_to > window_from),
  CONSTRAINT provider_settlements_settled_shape CHECK (
    status <> 'settled'
    OR (
      receipt_ref IS NOT NULL AND receipt_digest IS NOT NULL AND receipt_payload IS NOT NULL
      AND settled_at IS NOT NULL AND settled_by IS NOT NULL
      AND lease_expires_at IS NULL AND failure IS NULL AND failure_detail IS NULL
    )
  ),
  CONSTRAINT provider_settlements_failed_shape CHECK (
    status <> 'failed'
    OR (failure IS NOT NULL AND failure_detail IS NOT NULL
        AND settled_at IS NULL AND settled_by IS NULL
        AND receipt_ref IS NULL AND receipt_digest IS NULL AND receipt_payload IS NULL)
  ),
  CONSTRAINT provider_settlements_settling_shape CHECK (
    status <> 'settling' OR (lease_expires_at IS NOT NULL AND settled_at IS NULL
        AND settled_by IS NULL AND receipt_ref IS NULL AND receipt_digest IS NULL
        AND receipt_payload IS NULL)
  )
);

CREATE INDEX provider_settlements_tenant_idx
  ON provider_settlements (tenant_id, gateway, provider, created_at DESC);
CREATE INDEX provider_settlements_tenant_status_idx
  ON provider_settlements (tenant_id, status, created_at DESC);

-- Settlement lines — the append-only usage CLAIMS of one settlement.
-- UNIQUE (usage_record_id): one usage record settles exactly once, ever —
-- two overlapping windows claim disjoint remaining usage, so a window can
-- never double-charge a record. Each line snapshots the usage record's
-- attribution at claim time (the receipt's line-item truth).

CREATE TABLE provider_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  settlement_id uuid NOT NULL
    REFERENCES provider_settlements (id),
  usage_record_id uuid NOT NULL
    REFERENCES provider_usage_records (id),
  gateway text NOT NULL CHECK (gateway ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  capability text NOT NULL CHECK (capability ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  execution_ref text CHECK (execution_ref IS NULL OR char_length(execution_ref) BETWEEN 1 AND 255),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0 AND cost_minor <= 1000000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_settlement_lines_usage_unique UNIQUE (usage_record_id),
  CONSTRAINT provider_settlement_lines_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT provider_settlement_lines_pair_unique UNIQUE (settlement_id, usage_record_id)
);

CREATE INDEX provider_settlement_lines_settlement_idx
  ON provider_settlement_lines (tenant_id, settlement_id);

-- Settlement events — the append-only charge audit (claim, success,
-- failure), each attempt with its outcome. `seq` is a technical global
-- monotonic sequence (minted per ROW by the database, never a
-- caller-supplied natural key — the llm_executions.seq discipline).

CREATE TABLE provider_settlement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  settlement_id uuid NOT NULL
    REFERENCES provider_settlements (id),
  seq serial NOT NULL UNIQUE,
  event text NOT NULL CHECK (event IN ('window_claimed', 'charge_succeeded', 'charge_failed')),
  detail text NOT NULL CHECK (char_length(detail) BETWEEN 1 AND 2000),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT provider_settlement_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX provider_settlement_events_settlement_idx
  ON provider_settlement_events (tenant_id, settlement_id, seq);

-- ---------------------------------------------------------------------------
-- Storage-level immutability (the actions module's guard discipline)
-- ---------------------------------------------------------------------------

-- Usage records, settlement lines, settlement events and budget events
-- are immutable history the moment they are recorded: UPDATE, DELETE and
-- TRUNCATE are forbidden outright, even for a caller bypassing the
-- service. (Usage correction is a NEW compensating record; settlement
-- recovery is a guarded state transition on the settlement row, never a
-- line rewrite.)

CREATE OR REPLACE FUNCTION provider_billing_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'provider billing % is append-only history (W090 provider billing gateway): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_usage_records_immutable
  BEFORE UPDATE OR DELETE ON provider_usage_records
  FOR EACH ROW EXECUTE FUNCTION provider_billing_append_only_guard();
CREATE TRIGGER provider_usage_records_immutable_truncate
  BEFORE TRUNCATE ON provider_usage_records
  FOR EACH STATEMENT EXECUTE FUNCTION provider_billing_append_only_guard();

CREATE TRIGGER provider_settlement_lines_immutable
  BEFORE UPDATE OR DELETE ON provider_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION provider_billing_append_only_guard();
CREATE TRIGGER provider_settlement_lines_immutable_truncate
  BEFORE TRUNCATE ON provider_settlement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION provider_billing_append_only_guard();

CREATE TRIGGER provider_settlement_events_immutable
  BEFORE UPDATE OR DELETE ON provider_settlement_events
  FOR EACH ROW EXECUTE FUNCTION provider_billing_append_only_guard();
CREATE TRIGGER provider_settlement_events_immutable_truncate
  BEFORE TRUNCATE ON provider_settlement_events
  FOR EACH STATEMENT EXECUTE FUNCTION provider_billing_append_only_guard();

CREATE TRIGGER provider_budget_events_immutable
  BEFORE UPDATE OR DELETE ON provider_budget_events
  FOR EACH ROW EXECUTE FUNCTION provider_billing_append_only_guard();
CREATE TRIGGER provider_budget_events_immutable_truncate
  BEFORE TRUNCATE ON provider_budget_events
  FOR EACH STATEMENT EXECUTE FUNCTION provider_billing_append_only_guard();

-- Settlements are a guarded STATE MACHINE: only the lifecycle state and
-- its receipt/failure/lease columns may ever move (settling → settled |
-- failed, failed → settling on a re-drive). The window, the amount, the
-- line count, the arrangement, the authorizing action request and the
-- creators are frozen at claim time.

CREATE OR REPLACE FUNCTION provider_settlements_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlements are durable history (W090 provider billing gateway): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'settlements are durable history (W090 provider billing gateway): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.gateway <> OLD.gateway
     OR NEW.provider <> OLD.provider
     OR NEW.arrangement <> OLD.arrangement
     OR NEW.settlement_adapter_key <> OLD.settlement_adapter_key
     OR NEW.window_from <> OLD.window_from
     OR NEW.window_to <> OLD.window_to
     OR NEW.line_count <> OLD.line_count
     OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency
     OR NEW.action_request_id <> OLD.action_request_id
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'settlements are durable history (W090 provider billing gateway): only the lifecycle state (status, receipt, failure, lease, settled_*, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_settlements_state_only_updates
  BEFORE UPDATE OR DELETE ON provider_settlements
  FOR EACH ROW EXECUTE FUNCTION provider_settlements_guard();
CREATE TRIGGER provider_settlements_immutable_truncate
  BEFORE TRUNCATE ON provider_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION provider_settlements_guard();

-- Budgets are updatable MANAGEMENT CONTROLS (not evidence): the amount,
-- enforcement mode, note and status may move (their change history
-- belongs to audit, W046); the scope columns are frozen — a changed scope
-- is a NEW budget row (retire the old one).

CREATE OR REPLACE FUNCTION provider_budgets_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budgets are management controls with an audit trail (W090 provider billing gateway): DELETE is forbidden — retire the row instead (table %)',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'budgets are management controls with an audit trail (W090 provider billing gateway): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.scope <> OLD.scope
     OR NEW.gateway IS DISTINCT FROM OLD.gateway
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.scope_key <> OLD.scope_key
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'budgets are management controls with an audit trail (W090 provider billing gateway): only the controls (budget_minor, enforcement, note, status, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_budgets_controls_only_updates
  BEFORE UPDATE OR DELETE ON provider_budgets
  FOR EACH ROW EXECUTE FUNCTION provider_budgets_guard();
CREATE TRIGGER provider_budgets_immutable_truncate
  BEFORE TRUNCATE ON provider_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION provider_budgets_guard();
