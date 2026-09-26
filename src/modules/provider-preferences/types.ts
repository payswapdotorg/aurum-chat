// Public domain types of the provider-preferences module (W091 —
// User-Friendly Provider Choice UX).
//
// W091 owns the OUTCOME-ORIENTED provider-selection experience and its
// persisted preference domain (spec/work-items/WORK-ITEM-CATALOG.md):
//
//   "Present provider selection as outcomes such as cost, privacy,
//    quality, speed or organizational policy. Persist preferences and
//    reveal technical details only in advanced settings."
//   Acceptance: "ordinary user never needs provider jargon; preference
//    can be changed at any time; system explains why a provider was
//    selected; technical override remains available to authorized
//    advanced users."
//
// The domain model this module owns:
//
//   * OUTCOME PREFERENCES — what a tenant (company) and, within the
//     permission model's tenant/principal distinction, what an
//     individual member cares about when Aurum picks among AI options:
//     an ordered priority over the four canonical outcomes (cost,
//     privacy, quality, speed) plus the tenant's organizational-policy
//     posture (policy-first = organizational policy decides; personal
//     preferences are recorded but do not bend routing while it holds).
//   * THE RESOLVED PROFILE — the deterministic fold of the two levels
//     (policy-first → tenant priority → personal preference → the
//     documented balanced default) with its SOURCE attribution, so the
//     UI can say whose choice is in effect ("you", "your company",
//     "company policy", "the balanced default").
//   * SELECTION-EXPLANATION RECORDS — append-only records of WHY a
//     provider was chosen for a capability/route, in USER LANGUAGE
//     (which preference or policy drove it), including the honest
//     "only one option was available", "no option was available" and
//     "a spending limit excluded alternatives" cases. The technical
//     identity of the chosen provider is persisted for the advanced
//     surface ONLY — the ordinary view (what non-advanced users and the
//     product surfaces read) excludes it by construction.
//   * TECHNICAL OVERRIDES — the authorization-gated advanced surface's
//     persisted state: an authorized advanced user can pin a specific
//     provider for a (gateway, capability) scope with a reason; the
//     override is reversible (set → clear → set again) and every change
//     lands on the append-only audit feed.
//
// JARGON DISCIPLINE (the acceptance's first clause, enforced by types):
// everything an ordinary user can read is expressed in outcomes and
// plain language. Providers appear ONLY as the OPAQUE technical keys of
// the advanced surface (`chosenProvider`, `provider`) — never inside a
// user-language explanation string. Gateways and capabilities appear
// only as canonical lowercase keys (open vocabularies, the
// provider-billing discipline: the owning gateway's vocabulary is
// validated where it is known, not here).
//
// ROUTING POSTURE (the work order's scope note): this module FEEDS
// policy inputs — the resolved outcome priority, the recorded
// explanations and the override state. It never executes provider
// calls, never bypasses the W009 authority gate for consequential
// actions, and routes provider COST through the W090 billing gateway's
// own budget evaluation (resolveProviderChoice consults
// routeWithinBudget read-only before ranking). No provider becomes
// architecturally privileged (lock 30): the default profile is a
// documented balanced order, and the ranker applies the TENANT'S
// priority, never a registry position.

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/**
 * The canonical outcome vocabulary — the only words an ordinary user
 * needs to steer provider choice (the work item's list; organizational
 * policy is the tenant-level POSTURE, not an outcome).
 */
export type ProviderPreferenceOutcome = 'cost' | 'privacy' | 'quality' | 'speed';

/**
 * Whose outcome priority is in effect for a principal — the resolved
 * profile's source attribution (the "why this priority" answer).
 *
 *   organizational-policy — the tenant is policy-first: company policy
 *      decides; personal preferences are recorded but do not bend
 *      routing while it holds (the honest "policy decided" case).
 *   tenant-priority — the company's outcome priority (no personal
 *      preference set).
 *   personal-preference — this member's own outcome priority.
 *   default — nothing is set yet; the documented balanced default
 *      applies.
 */
export type PreferenceSource =
  | 'organizational-policy'
  | 'tenant-priority'
  | 'personal-preference'
  | 'default';

/**
 * What mechanism actually determined a provider choice — the
 * explanation record's decision taxonomy:
 *
 *   technical-override — an authorized advanced override pinned the
 *      chosen provider (reviewable/reversible in advanced settings).
 *   preference — the resolved outcome priority ranked the available
 *      options and one won.
 *   single-choice — exactly one option was available (by nature or
 *      because budget policy excluded the others); nothing was
 *      "preferred" over anything.
 *   no-choice — no option was available; nothing was chosen. Recorded
 *      so the moment is visible, never swallowed.
 */
export type SelectionDecision =
  | 'technical-override'
  | 'preference'
  | 'single-choice'
  | 'no-choice';

/** Lifecycle of one technical override row (reversible by design). */
export type TechnicalOverrideStatus = 'active' | 'retired';

/** The append-only audit vocabulary of the module's state changes. */
export type ProviderPreferenceEventType =
  | 'tenant-preference-set'
  | 'personal-preference-set'
  | 'personal-preference-cleared'
  | 'override-set'
  | 'override-cleared';

// ---------------------------------------------------------------------------
// Preferences (tenant level + personal level)
// ---------------------------------------------------------------------------

/** The tenant's persisted outcome-priority setting (one row per tenant). */
export interface TenantPreference {
  id: string;
  tenantId: string;
  /** The company's ordered outcome priority (1..4, unique). */
  outcomePriority: ProviderPreferenceOutcome[];
  /**
   * True when organizational policy decides: personal preferences are
   * recorded but do not influence routing while this holds (the
   * honest "policy decided" posture).
   */
  policyFirst: boolean;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One member's persisted outcome preference (one row per principal). */
export interface PersonalPreference {
  id: string;
  tenantId: string;
  principalId: string;
  outcomePriority: ProviderPreferenceOutcome[];
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The deterministic fold of the two levels for one principal. */
export interface ResolvedPreferenceProfile {
  /** The effective ordered outcome priority. */
  outcomePriority: ProviderPreferenceOutcome[];
  /** Whose priority is in effect (the plain-language attribution). */
  source: PreferenceSource;
  /** The tenant's policy-first posture (mirrored for the UI). */
  policyFirst: boolean;
}

// ---------------------------------------------------------------------------
// Technical overrides (the advanced, authorization-gated surface)
// ---------------------------------------------------------------------------

/**
 * One persisted technical override: an authorized advanced user's pin
 * of a specific provider for one (gateway, capability) scope. `reason`
 * is REQUIRED human language — the override says why it exists, and the
 * audit feed keeps it. Reversible: clear parks the row 'retired' and a
 * later set re-activates the scope.
 */
export interface TechnicalOverride {
  id: string;
  tenantId: string;
  /** The owning gateway's canonical key (e.g. 'llm' — open vocabulary). */
  gateway: string;
  /** The capability scope; null = the whole gateway. */
  capability: string | null;
  /** Canonical scope encoding ('g' | 'g:c') — the per-tenant namespace. */
  scopeKey: string;
  /** The pinned provider key in the owning gateway's vocabulary. */
  provider: string;
  /** Why this override exists (required human language, 1..2000 chars). */
  reason: string;
  status: TechnicalOverrideStatus;
  setBy: string;
  setAt: string;
  retiredBy: string | null;
  retiredAt: string | null;
}

// ---------------------------------------------------------------------------
// Selection-explanation records (append-only; two projections)
// ---------------------------------------------------------------------------

/**
 * The ORDINARY view of one selection-explanation record — the
 * "why this provider?" answer for non-advanced users. Deliberately
 * EXCLUDES the technical identity of the chosen provider and account:
 * jargon-free by construction (the acceptance's first clause).
 */
export interface SelectionExplanationView {
  id: string;
  /** The capability the choice was made for (gateway vocabulary key). */
  capability: string;
  decision: SelectionDecision;
  preferenceSource: PreferenceSource;
  /** The outcome that separated the winner from the runner-up (if any). */
  decidingOutcome: ProviderPreferenceOutcome | null;
  candidatesConsidered: number;
  budgetExcludedCount: number;
  /** True when an active override named a provider with no available option. */
  overrideUnavailable: boolean;
  /** The user-language explanation (NEVER contains provider identity). */
  explanation: string;
  /** ISO 8601 — service clock at record time. */
  occurredAt: string;
}

/**
 * The FULL (advanced) projection of one selection-explanation record —
 * authorization-gated ('provider-preferences:administer'): carries the
 * technical identity (chosen provider, account reference, gateway) the
 * advanced settings area renders.
 */
export interface SelectionExplanationRecord extends SelectionExplanationView {
  tenantId: string;
  gateway: string;
  /** The chosen provider's key (null when no option was available). */
  chosenProvider: string | null;
  /** Opaque reference into the owning gateway's account records. */
  chosenAccountRef: string | null;
  recordedBy: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Input of `setTenantPreference` (claim-gated: company-wide setting). */
export interface SetTenantPreferenceInput {
  outcomePriority: ProviderPreferenceOutcome[];
  policyFirst: boolean;
}

/** Input of `setPersonalPreference` (any member; principal from context). */
export interface SetPersonalPreferenceInput {
  outcomePriority: ProviderPreferenceOutcome[];
}

/**
 * One candidate option a gateway offers for a capability/route. The
 * `outcomes` map carries the caller-normalized comparable signal per
 * outcome — LOWER IS BETTER (cost in integer minor units, latency in
 * milliseconds, a quality tier where 1 is best, a data-handling tier
 * where 1 is most protective). A missing outcome signal is treated as
 * unknown = worst for that outcome. The CALLER decides what each
 * outcome means numerically for its providers; this module applies the
 * tenant's priority deterministically (no provider is privileged —
 * lock 30).
 */
export interface ProviderCandidate {
  /** The provider key in the owning gateway's vocabulary. */
  provider: string;
  /** Opaque reference into the owning gateway's account records. */
  accountRef?: string | null;
  /** Projected cost (integer minor units) for the W090 budget consult. */
  projectedCostMinor?: number | null;
  outcomes: Partial<Record<ProviderPreferenceOutcome, number>>;
}

/** Input of `resolveProviderChoice` (the policy-input resolution read). */
export interface ResolveProviderChoiceInput {
  gateway: string;
  capability: string;
  /** 0..16 candidate options; the resolution explains honestly when few. */
  candidates: ProviderCandidate[];
  /** Required dedupe key — unique per (tenant, gateway); first write wins. */
  dedupeKey: string;
}

/**
 * Input of `recordSelectionExplanation` — the standalone recorder for
 * gateways that make their own choice (not through
 * `resolveProviderChoice`) but still owe users the honest "why". The
 * user-language explanation is BUILT by this module from the structured
 * fields (consistent language, jargon-free by construction).
 */
export interface RecordSelectionExplanationInput {
  gateway: string;
  capability: string;
  /** The chosen provider (null = nothing was chosen). */
  chosenProvider: string | null;
  chosenAccountRef?: string | null;
  decision: SelectionDecision;
  preferenceSource: PreferenceSource;
  decidingOutcome?: ProviderPreferenceOutcome | null;
  candidatesConsidered: number;
  budgetExcludedCount?: number;
  /** True when an override was active but named an unavailable provider. */
  overrideUnavailable?: boolean;
  dedupeKey: string;
}

/** Input of `setTechnicalOverride` (claim-gated). */
export interface SetTechnicalOverrideInput {
  gateway: string;
  /** null = the whole gateway. */
  capability?: string | null;
  provider: string;
  reason: string;
}

/** Input of `clearTechnicalOverride` (claim-gated; reversible via set). */
export interface ClearTechnicalOverrideInput {
  gateway: string;
  capability?: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ListSelectionExplanationsQuery {
  capability?: string;
  limit?: number;
}

export interface GetSelectionExplanationQuery {
  explanationId: string;
}

export interface ListTechnicalOverridesQuery {
  gateway?: string;
  status?: TechnicalOverrideStatus;
  limit?: number;
}

export interface GetTechnicalOverrideQuery {
  gateway: string;
  capability?: string | null;
}

export interface ListProviderPreferenceEventsQuery {
  limit?: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Result of `resolveProviderChoice`. */
export interface ResolveProviderChoiceResult {
  /** The chosen option (null when none was available). */
  chosen: { provider: string; accountRef: string | null } | null;
  /** The user-language explanation (jargon-free). */
  explanation: string;
  decision: SelectionDecision;
  preferenceSource: PreferenceSource;
  decidingOutcome: ProviderPreferenceOutcome | null;
  /** How many candidates were offered (before budget filtering). */
  candidatesConsidered: number;
  /** How many candidates W090 budget policy excluded. */
  budgetExcludedCount: number;
  /** True when an active override named a provider with no available option. */
  overrideUnavailable: boolean;
  /** The ordinary (jargon-free) view of the recorded explanation. */
  record: SelectionExplanationView;
  /** False when the dedupe key replayed an existing record (first write wins). */
  created: boolean;
}

/** Result of `recordSelectionExplanation`. */
export interface RecordSelectionExplanationResult {
  /** The FULL record (the caller is the technical gateway path). */
  record: SelectionExplanationRecord;
  /** False when the dedupe key replayed an existing record. */
  created: boolean;
}

/** Result of `setTechnicalOverride`. */
export interface SetTechnicalOverrideResult {
  override: TechnicalOverride;
  /** False when an existing scope row was updated/re-activated. */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** One append-only audit event of the module's state changes. */
export interface ProviderPreferenceEvent {
  id: string;
  tenantId: string;
  /** The principal a personal event is about (null for tenant-level). */
  principalId: string | null;
  position: number;
  event: ProviderPreferenceEventType;
  /** User-language detail (never contains technical provider identity). */
  detail: string;
  recordedBy: string;
  recordedAt: string;
}
