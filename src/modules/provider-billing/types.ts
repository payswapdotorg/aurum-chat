// The canonical, provider-neutral vocabulary of the provider-billing module
// (W090). Everything here is PROVIDER-NEUTRAL and BILLING-PROVIDER-NEUTRAL by
// construction: no provider SDKs, no billing-provider wire formats, no
// provider-minted objects (IMPLEMENTATION-STACK §6 provider isolation; the
// module imports no billing SDK at all — adapters speak injected HTTP ports).
// Billing-provider specifics translate INTO these types at the adapter
// boundary; nothing here ever decides WHICH provider or billing arrangement
// to use (provider selection stays in the owning gateway's routing/policy —
// handoff §4.6; W091 owns the outcome-oriented choice UX).

import type { CanonicalProviderFailure, ProviderAdapterDefinition } from '@/modules/provider-sdk/contract';

// ---------------------------------------------------------------------------
// 1. Payment arrangements — how one (gateway, provider) is paid
// ---------------------------------------------------------------------------

/**
 * How a supported provider's usage is paid (W090: "Use Aurum-mediated
 * settlement when terms permit; direct customer billing is an explicit
 * fallback").
 *
 *   aurum-mediated — the provider permits platform-mediated settlement: the
 *      tenant pays Aurum, Aurum settles provider charges underneath through
 *      a wired settlement adapter, and every settlement produces an
 *      auditable receipt (POST-S002 plan §25).
 *   direct-customer — the provider's terms require a direct customer billing
 *      relationship (the explicit adapter-level exception). Aurum still
 *      attributes usage/cost and enforces budgets, but settlement through
 *      Aurum is refused explicitly — capability flow never breaks.
 */
export type PaymentArrangementKind = 'aurum-mediated' | 'direct-customer';

/** Lifecycle of one payment arrangement row. */
export type PaymentArrangementStatus = 'active' | 'retired';

export interface PaymentArrangement {
  id: string;
  tenantId: string;
  /** The owning gateway's canonical key (e.g. 'llm' — open vocabulary). */
  gateway: string;
  /** The provider key in the owning gateway's vocabulary (e.g. 'openai'). */
  provider: string;
  arrangement: PaymentArrangementKind;
  /**
   * The settlement adapter key used for aurum-mediated settlement (open
   * vocabulary; must be wired at settlement time). Null for direct-customer.
   */
  settlementAdapterKey: string | null;
  /**
   * For direct-customer arrangements: the human-facing explanation of the
   * external billing requirement (outcome-oriented language; never provider
   * mechanics). Null for aurum-mediated.
   */
  directBillingNote: string | null;
  status: PaymentArrangementStatus;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  updatedAt: string;
}

export interface RegisterPaymentArrangementInput {
  gateway: string;
  provider: string;
  arrangement: PaymentArrangementKind;
  /** Required for 'aurum-mediated'; must be null for 'direct-customer'. */
  settlementAdapterKey?: string | null;
  /** Required for 'direct-customer'; must be null for 'aurum-mediated'. */
  directBillingNote?: string | null;
}

export interface GetPaymentArrangementQuery {
  gateway: string;
  provider: string;
}

export interface ListPaymentArrangementsQuery {
  gateway?: string;
  arrangement?: PaymentArrangementKind;
  status?: PaymentArrangementStatus;
  limit?: number;
}

// ---------------------------------------------------------------------------
// 2. The usage ledger — cost attributed to tenant/capability/execution
// ---------------------------------------------------------------------------

/**
 * One metered provider usage event, recorded append-only. The acceptance
 * core: provider cost attributed to (tenant implicit, gateway, provider,
 * capability, execution reference, account reference) in integer minor
 * units + ISO currency.
 */
export interface ProviderUsageRecord {
  id: string;
  tenantId: string;
  gateway: string;
  provider: string;
  capability: string;
  /** Opaque reference to the owning gateway's execution record, when known. */
  executionRef: string | null;
  /** Opaque reference to the tenant's provider account, when known. */
  accountRef: string | null;
  /** Integer minor units (≥ 0; 0 when the provider reports no cost). */
  costMinor: number;
  currency: 'USD';
  /** Metered quantity (e.g. total tokens), when the provider reports one. */
  quantity: number | null;
  /** Unit of the metered quantity (e.g. 'tokens'). */
  unit: string | null;
  /** Where this record came from (open vocabulary; first-party: 'gateway', 'llm-import'). */
  source: string;
  /** Emitter-supplied dedupe key — unique per (tenant, gateway). */
  dedupeKey: string;
  /** The usage's business time (ISO 8601). */
  occurredAt: string;
  recordedBy: string;
  /** ISO 8601 — service clock at record time. */
  recordedAt: string;
}

export interface RecordProviderUsageInput {
  gateway: string;
  provider: string;
  capability: string;
  executionRef?: string | null;
  accountRef?: string | null;
  costMinor: number;
  quantity?: number | null;
  unit?: string | null;
  source?: string;
  /** Required — idempotent replay returns the original record. */
  dedupeKey: string;
  /** Defaults to the service clock. */
  occurredAt?: string;
}

export interface RecordProviderUsageResult {
  record: ProviderUsageRecord;
  /** False when the dedupe key replayed an existing record (first write wins). */
  created: boolean;
}

export interface ListUsageRecordsQuery {
  gateway?: string;
  provider?: string;
  capability?: string;
  executionRef?: string;
  accountRef?: string;
  /** Inclusive lower bound on occurred_at (ISO 8601). */
  since?: string;
  /** Exclusive upper bound on occurred_at (ISO 8601). */
  until?: string;
  limit?: number;
}

export interface GetUsageRecordQuery {
  usageId: string;
}

/** One aggregated attribution row: (gateway, provider, capability). */
export interface UsageSummaryRow {
  gateway: string;
  provider: string;
  capability: string;
  records: number;
  costMinor: number;
  quantity: number | null;
  /** Distinct non-null execution references (execution attribution). */
  executions: number;
}

export interface UsageSummary {
  /** Matching window (ISO 8601; null = unbounded). */
  since: string | null;
  until: string | null;
  records: number;
  costMinor: number;
  executions: number;
  rows: UsageSummaryRow[];
}

export interface UsageSummaryQuery {
  gateway?: string;
  provider?: string;
  capability?: string;
  since?: string;
  until?: string;
}

// ---------------------------------------------------------------------------
// 3. Budget policy — block / route usage
// ---------------------------------------------------------------------------

/** The scoping of one budget row (most specific wins nothing — ALL covering rows are evaluated). */
export type BudgetScope = 'tenant' | 'gateway' | 'provider' | 'capability';

/** What happens when a covering budget is exceeded by projected usage. */
export type BudgetEnforcementKind = 'block' | 'observe';

export interface ProviderBudget {
  id: string;
  tenantId: string;
  scope: BudgetScope;
  /** Present for scope 'gateway' and narrower. */
  gateway: string | null;
  /** Present for scope 'provider' and narrower. */
  provider: string | null;
  /** Present for scope 'capability' only. */
  capability: string | null;
  /** Canonical join of the scope columns (the namespace key). */
  scopeKey: string;
  /** UTC calendar month period (the budget period; ISO 8601 anchor in results). */
  budgetMinor: number;
  currency: 'USD';
  enforcement: BudgetEnforcementKind;
  status: 'active' | 'retired';
  note: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetProviderBudgetInput {
  scope: BudgetScope;
  gateway?: string | null;
  provider?: string | null;
  capability?: string | null;
  budgetMinor: number;
  enforcement: BudgetEnforcementKind;
  note?: string | null;
}

export interface ListProviderBudgetsQuery {
  status?: 'active' | 'retired';
  gateway?: string;
  limit?: number;
}

/** One covering budget's live posture for an enforcement evaluation. */
export interface BudgetPosture {
  budgetId: string;
  scopeKey: string;
  scope: BudgetScope;
  enforcement: BudgetEnforcementKind;
  budgetMinor: number;
  currency: 'USD';
  /** Recorded usage cost inside the current UTC month for this budget's scope. */
  spendMinor: number;
  /** budgetMinor − spendMinor (may be negative when already exceeded). */
  headroomMinor: number;
  /** ISO 8601 — start of the current UTC calendar month (the period). */
  periodStart: string;
}

export interface BudgetEnforcementViolation {
  posture: BudgetPosture;
  projectedTotalMinor: number;
  overageMinor: number;
}

export interface BudgetEnforcement {
  /** 'block' when any covering 'block' budget would be exceeded. */
  decision: 'allow' | 'block';
  /** Deterministic human-readable reason (null when allowed). */
  reason: string | null;
  /** The covering 'block' budgets the projection would exceed. */
  violations: BudgetEnforcementViolation[];
  /** The covering 'observe' budgets already exceeded (allowed, but recorded). */
  warnings: BudgetPosture[];
  /** All covering budgets' live postures, most specific first. */
  postures: BudgetPosture[];
  /** The evaluated request. */
  request: {
    gateway: string;
    provider: string;
    capability: string;
    projectedCostMinor: number;
  };
}

export interface EnforceProviderBudgetInput {
  gateway: string;
  provider: string;
  capability: string;
  /** The projected cost of the usage about to run (integer minor units, ≥ 0). */
  projectedCostMinor: number;
}

export interface RouteWithinBudgetCandidate {
  gateway: string;
  provider: string;
  capability: string;
  projectedCostMinor: number;
}

export interface RouteWithinBudgetResult {
  /** The allowed candidates, in input order ('route usage'). */
  routed: RouteWithinBudgetCandidate[];
  /** The blocked candidates with the deterministic reason. */
  blocked: Array<RouteWithinBudgetCandidate & { reason: string }>;
}

/** Append-only audit of enforcement outcomes that bit (block / observe-warning). */
export interface ProviderBudgetEvent {
  id: string;
  tenantId: string;
  budgetId: string | null;
  scopeKey: string;
  /** 'blocked' | 'observed_exceeded'. */
  event: string;
  detail: string;
  enforcement: BudgetEnforcement;
  checkedBy: string;
  occurredAt: string;
}

export interface ListBudgetEventsQuery {
  budgetId?: string;
  event?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// 4. Settlement — the Aurum-mediated billing experience + auditable receipts
// ---------------------------------------------------------------------------

export type SettlementStatus = 'settling' | 'settled' | 'failed';

/** One settled usage window: the durable settlement record. */
export interface ProviderSettlement {
  id: string;
  tenantId: string;
  gateway: string;
  provider: string;
  arrangement: 'aurum-mediated';
  settlementAdapterKey: string;
  windowFrom: string;
  windowTo: string;
  status: SettlementStatus;
  lineCount: number;
  amountMinor: number;
  currency: 'USD';
  /** Opaque settlement-adapter receipt reference (null until settled). */
  receiptRef: string | null;
  /** The adapter's normalized, provider-neutral receipt payload (null until settled). */
  receiptPayload: unknown;
  /** SHA-256 digest over the receipt's canonical content (tamper-evident). */
  receiptDigest: string | null;
  /** The W009 action request that authorized this settlement. */
  actionRequestId: string;
  /** Canonical normalized failure when status is 'failed'. */
  failure: CanonicalProviderFailure | null;
  failureDetail: string | null;
  leaseExpiresAt: string | null;
  settledBy: string | null;
  settledAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SettleProviderUsageInput {
  gateway: string;
  provider: string;
  /** Inclusive window lower bound (ISO 8601). */
  windowFrom: string;
  /** Exclusive window upper bound (ISO 8601). */
  windowTo: string;
  /**
   * Idempotency key forwarded to the W009 settlement gate: with the same
   * key, a settlement the tenant gated behind human approval replays the
   * SAME action request after decideApproval (retry then proceeds).
   */
  idempotencyKey?: string | null;
}

export interface SettleProviderUsageResult {
  settlement: ProviderSettlement;
  /** The auditable receipt (present when status is 'settled'). */
  receipt: SettlementReceipt | null;
}

/** Per-line usage attribution inside one settlement receipt. */
export interface SettlementReceiptLine {
  capability: string;
  records: number;
  costMinor: number;
  executions: number;
}

/** The auditable receipt of one settlement (W090 acceptance core). */
export interface SettlementReceipt {
  settlementId: string;
  tenantId: string;
  gateway: string;
  provider: string;
  arrangement: 'aurum-mediated';
  settlementAdapterKey: string;
  windowFrom: string;
  windowTo: string;
  status: SettlementStatus;
  lineCount: number;
  amountMinor: number;
  currency: 'USD';
  usage: {
    records: number;
    executions: number;
    byCapability: SettlementReceiptLine[];
  };
  /** The settlement adapter's opaque receipt reference. */
  receiptRef: string | null;
  /** The adapter's normalized, provider-neutral receipt payload. */
  receiptPayload: unknown;
  /** SHA-256 over the receipt's canonical content (recomputed on read). */
  receiptDigest: string | null;
  actionRequestId: string;
  settledBy: string | null;
  settledAt: string | null;
  failure: CanonicalProviderFailure | null;
}

export interface GetSettlementQuery {
  settlementId: string;
}

export interface ListSettlementsQuery {
  gateway?: string;
  provider?: string;
  status?: SettlementStatus;
  limit?: number;
}

export interface ListSettlementEventsQuery {
  settlementId: string;
  limit?: number;
}

/** Append-only settlement lifecycle audit. */
export interface ProviderSettlementEvent {
  id: string;
  tenantId: string;
  settlementId: string;
  seq: number;
  /** 'window_claimed' | 'charge_succeeded' | 'charge_failed'. */
  event: string;
  detail: string;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// 5. The settlement adapter port (the billing-provider seam)
// ---------------------------------------------------------------------------

/** One charge request through a settlement adapter. */
export interface SettlementChargeRequest {
  settlementId: string;
  tenantId: string;
  gateway: string;
  provider: string;
  amountMinor: number;
  currency: 'USD';
  /** Honored idempotency key — exactly-once charging per logical settlement. */
  idempotencyKey: string;
  /** Human label carried to the billing provider (no tenant secrets). */
  description: string;
  occurredAt: string;
}

/** The canonical charge result (provider-neutral; no provider objects). */
export interface SettlementChargeResult {
  /** The billing provider's opaque receipt reference. */
  receiptRef: string;
  /** Normalized, provider-neutral receipt payload (digest material; bounded JSON). */
  receiptPayload: unknown;
  amountMinor: number;
  currency: 'USD';
}

/**
 * A settlement adapter: the ONLY place where billing-provider wire dialects
 * exist. Alongside its port duties every adapter is a conforming W089
 * ProviderAdapterDefinition (canonical lifecycle, capabilities, error
 * normalization — proven by the module's conformance suite).
 */
export interface ProviderSettlementAdapter {
  /** Canonical adapter key (persisted on arrangements; open vocabulary). */
  readonly key: string;
  /** The W089 SDK adapter definition (lifecycle, capabilities, errors). */
  readonly definition: ProviderAdapterDefinition;
  /** Charge one settlement idempotently; failures throw SettlementAdapterError. */
  charge(request: SettlementChargeRequest): Promise<SettlementChargeResult>;
}

/** Introspection of one wired settlement adapter. */
export interface WiredSettlementAdapterInfo {
  key: string;
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// 6. Composition bridges (W034 llm import; W080 durable settlement runs)
// ---------------------------------------------------------------------------

export interface ImportLlmUsageResult {
  /** Usage records minted this call. */
  imported: number;
  /** Completed llm executions already present in the ledger (idempotent skip). */
  skipped: number;
  /** Executions whose cost attribution produced a record. */
  considered: number;
}

export interface ImportLlmUsageInput {
  /** 1..500 completed executions per pull (default 100). */
  limit?: number;
}

/** The canonical settlement workflow's definition key (W080 bridge). */
export const SETTLEMENT_WORKFLOW_KEY = 'provider-billing.settlement';
/** The settlement workflow's single step key. */
export const SETTLEMENT_WORKFLOW_STEP_KEY = 'settle-windows';

/** The run input of the settlement workflow. */
export interface SettlementRunInput {
  /** The windows to settle, in order. */
  windows: Array<{
    gateway: string;
    provider: string;
    windowFrom: string;
    windowTo: string;
  }>;
}

/** The durable progress checkpoint of the settlement workflow step. */
export interface SettlementRunCheckpoint {
  settled: string[];
  skipped: number;
  nextIndex: number;
}
