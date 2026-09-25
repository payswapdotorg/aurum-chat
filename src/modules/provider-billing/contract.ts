// ============================================================================
// provider-billing — the ONLY public surface of the provider-billing
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W090 — Aurum Provider Billing Gateway:
// "Abstract supported provider payment, usage, budgets and receipts
//  behind Aurum. Use Aurum-mediated settlement when terms permit; direct
//  customer billing is an explicit fallback."
// Acceptance: "provider cost can be attributed to tenant/capability/
//  execution; budget policy can block/route usage; supported provider
//  settlement produces an auditable receipt; unsupported direct-billing
//  provider does not break capability flow."
//
//   PAYMENT ARRANGEMENTS (the payment abstraction):
//   registerPaymentArrangement — claim-gated
//      ('provider-billing:administer') declaration of how one
//      (gateway, provider) is paid: 'aurum-mediated' (Aurum settles the
//      provider underneath through a named settlement adapter — POST-S002
//      plan §25) or 'direct-customer' (the explicit fallback: the
//      provider bills the customer directly; the registered
//      directBillingNote names that external requirement in
//      outcome-oriented language). Upsert per (gateway, provider);
//      getPaymentArrangement / listPaymentArrangements are the reads.
//
//   THE USAGE LEDGER (cost attribution — acceptance bullet 1):
//   recordProviderUsage — append-only, idempotent by (tenant, gateway,
//      dedupeKey): provider cost attributed to (gateway, provider,
//      capability, executionRef, accountRef) in integer minor units.
//      Attribution NEVER requires a payment arrangement — a
//      direct-billing or unregistered provider's usage records exactly
//      like a mediated one's (acceptance bullet 4: capability flow never
//      breaks). getUsageRecord / listUsageRecords /
//      getUsageSummary (per (gateway, provider, capability) aggregates
//      with distinct execution counts) are the attribution reads.
//
//   BUDGET POLICY (block/route — acceptance bullet 2):
//   setProviderBudget / retireProviderBudget / listProviderBudgets —
//      claim-gated management controls at four scopes (tenant, gateway,
//      provider, capability) with 'block'/'observe' enforcement over the
//      UTC calendar month. EVERY active covering row is evaluated (no
//      shadowing); the evaluation is a pure function of (rows, spend,
//      request, period) — the actions module's deterministic discipline.
//   enforceProviderBudget — the pre-flight gate a gateway calls before
//      provider usage: 'allow' or 'block' with the deterministic reason,
//      every covering posture, and append-only budget-event evidence for
//      the outcomes that bit (blocks and observed exceedance).
//   routeWithinBudget — the routing read: filters candidate
//      (gateway, provider, capability, projected cost) targets in input
//      order through the same evaluation (read-only).
//   listBudgetEvents — the enforcement audit feed.
//
//   SETTLEMENT (the auditable receipt — acceptance bullet 3):
//   settleProviderUsage — the Aurum-mediated billing experience: W009
//      authority gate first (kind 'provider-settlement', level EXECUTE —
//      money movement is consequential; a gated settlement replays the
//      same action request after decideApproval when retried with the
//      same idempotencyKey), then the durable core: claim the window's
//      UNSETTLED usage (settlement lines claim each usage record exactly
//      once — overlapping windows claim disjoint usage), charge through
//      the arrangement's wired settlement adapter with the settlement id
//      as the idempotency key (exactly-once charging; the charge lease
//      lets a crashed 'settling' row be re-driven safely), and land the
//      guarded 'settled' transition carrying the receipt reference, the
//      normalized provider-neutral payload and a SHA-256 receipt digest
//      that getSettlementReceipt RECOMPUTES on read (tamper-evident
//      audit). A 'direct-customer' arrangement refuses canonically
//      (`settlement_direct_billing`) — the explicit fallback.
//   getSettlement / listSettlements / getSettlementReceipt /
//   listSettlementEvents — the audit surface (append-only evidence).
//
//   THE SETTLEMENT ADAPTER PORT (the billing-provider seam):
//   wireSettlementAdapters — process-start wiring of the adapter set;
//      nothing is wired by default → settlement fails explicitly with
//      `settlement_adapter_unavailable`. The platform-account and
//      prepaid-balance adapter factories below are the shipped
//      first-party pair (materially different billing mechanics —
//      charge-on-account vs prepaid draw-down); both are conforming W089
//      ProviderAdapterDefinitions (kit-driven conformance suite). No OSS
//      dependency is introduced (injected HTTP client ports only — no
//      W089 technology-registry entry required).
//
//   THE W034 COMPOSITION BRIDGE:
//   importLlmUsage — pulls the llm gateway's completed executions into
//      the usage ledger through its public contract (idempotent per
//      execution): the first supported gateway's provider cost lands in
//      the billing ledger with zero llm-module changes.
//
//   THE W080 COMPOSITION BRIDGE:
//   createSettlementWorkflowBindings — executor bindings for the
//      canonical settlement workflow ('provider-billing.settlement'):
//      one window settled per invocation, durable checkpointed progress,
//      authority gated by the workflow engine's own approval wait under
//      the run's original durable context (no forked W009 semantics). A
//      worker crash mid-run resumes from the next window; the
//      authorizing action request id survives in the checkpoint.
//
// PROVIDER/BILLING-PROVIDER ISOLATION (lock 16 analog; IMPLEMENTATION-
// STACK §6 provider boundaries): everything exported below is
// provider-neutral AND billing-provider-neutral by construction.
// Gateways, providers and adapter keys appear only as canonical string
// keys; the only provider-minted values on this surface are OPAQUE
// strings (receipt references, execution/account references). No
// credential VALUE ever crosses an adapter into domain state (the
// billing provider's instance key is wiring-time configuration).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's arrangements,
// usage, budgets, settlements, receipts and audit events are
// indistinguishable from missing ones — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W090 ← W009, W034, W080, W089;
// all four verified present at the reviewed base): this module imports
// ONLY module contracts — actions (W009: the EXECUTE authority gate of
// settlement and the read-only evaluation the workflow bridge proposes
// its approval through), llm (W034: listLlmExecutions — the import
// bridge's source of attributed, completed provider executions), and
// provider-sdk (W089: the adapter-definition template, canonical error
// normalization and the canonical digest every receipt is bound by).
// W080's durable discipline — bounded unit of work, guarded transition,
// lease recovery, exactly-once external effect — is applied directly
// (the settlement state machine) AND composed through the workflow
// module's engine contract (the settlement workflow bridge).
// ============================================================================

export {
  // Payment arrangements
  getPaymentArrangement,
  listPaymentArrangements,
  registerPaymentArrangement,
  // The usage ledger (cost attribution)
  getUsageRecord,
  getUsageSummary,
  listUsageRecords,
  recordProviderUsage,
  // Budget policy (block / route usage)
  enforceProviderBudget,
  listBudgetEvents,
  listProviderBudgets,
  retireProviderBudget,
  routeWithinBudget,
  setProviderBudget,
  // Settlement (the auditable receipt)
  getSettlement,
  getSettlementReceipt,
  listSettlementEvents,
  listSettlements,
  settleProviderUsage,
  // The settlement adapter port (wiring)
  getWiredSettlementAdapters,
  listWiredSettlementAdapters,
  wireSettlementAdapters,
  // The W034 composition bridge
  importLlmUsage,
  // The W080 composition bridge
  createSettlementWorkflowBindings,
} from './service';

export { ProviderBillingError } from './errors';
export type { ProviderBillingErrorCode } from './errors';

// Module-owned constants.
export {
  PROVIDER_BILLING_AUTHORITY_ADMINISTER,
  PROVIDER_SETTLEMENT_ACTION_KIND,
} from './service';
export {
  SETTLEMENT_WORKFLOW_KEY,
  SETTLEMENT_WORKFLOW_STEP_KEY,
} from './types';

// First-party settlement adapters (conforming W089 ProviderAdapterDefinitions).
export {
  createPlatformAccountSettlementAdapter,
  PLATFORM_ACCOUNT_ADAPTER_KEY,
} from './adapters/platform-account';
export type { PlatformAccountAdapterConfig } from './adapters/platform-account';
export {
  createPrepaidBalanceSettlementAdapter,
  PREPAID_BALANCE_ADAPTER_KEY,
} from './adapters/prepaid-balance';
export type { PrepaidBalanceAdapterConfig } from './adapters/prepaid-balance';
export type {
  SettlementHttpClient,
  SettlementHttpRequest,
  SettlementHttpResponse,
} from './adapters/shared';
export { SettlementAdapterError } from './adapters/shared';

// Pure vocabulary / derivations (unit-testable without a database).
export {
  budgetCovers,
  budgetScopeKey,
  isBudgetEnforcementKind,
  monthStartUtcIso,
} from './budget';
export {
  DEFAULT_LLM_IMPORT_LIMIT,
  DEFAULT_LIST_LIMIT,
  KEY_PATTERN,
  MAX_BUDGET_MINOR,
  MAX_COST_MINOR,
  MAX_LLM_IMPORT_LIMIT,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_QUANTITY,
  MAX_SETTLEMENT_WINDOWS,
  MAX_WINDOW_SECONDS,
  SETTLEMENT_LEASE_SECONDS,
  isBudgetScope,
  isPaymentArrangementKind,
  isPaymentArrangementStatus,
  isUuid,
} from './validation';
export type {
  ValidatedRegisterArrangementInput,
  ValidatedArrangementQuery,
  ValidatedListArrangementsQuery,
  ValidatedRecordUsageInput,
  ValidatedListUsageQuery,
  ValidatedUsageSummaryQuery,
  ValidatedSetBudgetInput,
  ValidatedListBudgetsQuery,
  ValidatedEnforceBudgetInput,
  ValidatedRouteCandidate,
  ValidatedListBudgetEventsQuery,
  ValidatedSettleInput,
  ValidatedSettlementQuery,
  ValidatedListSettlementsQuery,
  ValidatedListSettlementEventsQuery,
  ValidatedImportLlmInput,
  ValidatedSettlementRunInput,
} from './validation';

export type {
  BudgetEnforcement,
  BudgetEnforcementKind,
  BudgetEnforcementViolation,
  BudgetPosture,
  BudgetScope,
  ImportLlmUsageInput,
  ImportLlmUsageResult,
  ListBudgetEventsQuery,
  ListPaymentArrangementsQuery,
  ListProviderBudgetsQuery,
  ListSettlementEventsQuery,
  ListSettlementsQuery,
  ListUsageRecordsQuery,
  PaymentArrangement,
  PaymentArrangementKind,
  PaymentArrangementStatus,
  ProviderBudget,
  ProviderBudgetEvent,
  ProviderSettlement,
  ProviderSettlementAdapter,
  ProviderSettlementEvent,
  ProviderUsageRecord,
  RecordProviderUsageInput,
  RecordProviderUsageResult,
  RegisterPaymentArrangementInput,
  RouteWithinBudgetCandidate,
  RouteWithinBudgetResult,
  SettlementChargeRequest,
  SettlementChargeResult,
  SettlementReceipt,
  SettlementReceiptLine,
  SettlementRunCheckpoint,
  SettlementRunInput,
  SettlementStatus,
  SettleProviderUsageInput,
  SettleProviderUsageResult,
  UsageSummary,
  UsageSummaryQuery,
  UsageSummaryRow,
  WiredSettlementAdapterInfo,
  GetPaymentArrangementQuery,
  GetSettlementQuery,
  GetUsageRecordQuery,
  EnforceProviderBudgetInput,
} from './types';
