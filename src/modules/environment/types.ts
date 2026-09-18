// Public domain types of the environment module (W014 — Environment Watch).
//
// ARCHITECTURE.md §12 (frozen): "EnvironmentWatch defines the external
// entities/topics/geographies/regulators/laws/competitors/suppliers/
// technologies/markets that matter to a tenant, with freshness and
// escalation rules." Lock 18 makes EnvironmentWatch a first-class concept.
//
// The model is deliberately three-layered:
//
//  1. WATCHLISTS — the tenant's named external-watch programmes ("EU
//     Regulatory Watch", "Competitive Landscape"): a management control
//     carrying the list's DEFAULT ESCALATION POLICY. Controls are mutable
//     and updatable (the freshness/notification policy discipline); their
//     change history belongs to the audit module (W046).
//
//  2. WATCH ENTRIES — the individual external subjects being watched,
//     classified along the three axes the work item names:
//      * kind 'entity'    — one external entity, refined by `entityKind`
//                           from the §12 vocabulary (competitor, regulator,
//                           government_body, supplier, law, technology,
//                           market, industry);
//      * kind 'topic'     — one topic/theme ("AI regulation", "tariffs");
//      * kind 'geography' — one geography ("European Union", "US-CA").
//     Entity/topic entries may additionally carry `geographies` (where to
//     watch) and any entry may carry `topics` (what aspects to watch) as
//     canonical slugs. An entry may bind to the world model's entity for
//     the same external thing (validated readable through the world
//     contract at write time — the world module, W005, owns the tenant's
//     picture of external reality; this module owns the WATCH POLICY over
//     it, not a second entity registry).
//
//  3. SIGNALS + ESCALATIONS — the evidence-linked activity layer:
//      * a WatchSignal records that one immutable observation (W004,
//        validated readable through the observations contract) hit one
//        watch entry, with the assessed severity (the bounded-reasoning
//        seam: the cognitive orchestrator W013 or a connector rule
//        assesses; the application records, links evidence and never
//        treats the assessment as authoritative truth — lock 10);
//      * a WatchEscalation is the append-only record that the entry's
//        resolved ESCALATION POLICY fired — on a signal at/above the
//        policy's severity floor, or on staleness once the entry's
//        FRESHNESS policy (W006, subject kind 'environment.watch') has
//        been breached for the policy's grace period. Every escalation
//        SNAPSHOTS the resolved policy that governed it.
//
// External intelligence follows the frozen chain `external signal →
// observation → claim → company relationship → impact analysis →
// opportunity/risk → attention decision → mission or recommendation`
// (§12). This module owns the WATCHLIST DECLARATION and its two policies;
// observations (W004) own the signals, epistemics (W007) the claims, the
// world model (W005) the company relationships, the opportunity engine
// (W015) the impact analysis, and cognition/attention (W013/W051) the
// attention decisions. Everything stays provider-neutral and tenant-scoped
// (ADR-0001); parties are opaque references in the GoalParty precedent.

import type { FreshnessPolicy, FreshnessStatus } from '@/modules/freshness/contract';

export type { FreshnessPolicy, FreshnessStatus };

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** Lifecycle status of a watchlist (a management control; reversible). */
export type WatchlistStatus = 'active' | 'archived';

/** The three watch axes of the work item: entities, topics, geography. */
export type WatchEntryKind = 'entity' | 'topic' | 'geography';

/**
 * The external-entity vocabulary of ARCHITECTURE.md §12/§4: the entities a
 * tenant watches — regulators, laws, competitors, suppliers, technologies,
 * markets — plus the §4 core entities GovernmentBody and Industry.
 * Required exactly when `kind` is 'entity'.
 */
export type WatchEntityKind =
  | 'competitor'
  | 'regulator'
  | 'government_body'
  | 'supplier'
  | 'law'
  | 'technology'
  | 'market'
  | 'industry';

/**
 * Lifecycle status of a watch entry (a management control; reversible):
 *  * 'active'   — being watched: collects signals, evaluated by pumps;
 *  * 'paused'   — temporarily not watched (retains configuration);
 *  * 'archived' — retired (no erasure: signals/escalations reference it).
 */
export type WatchEntryStatus = 'active' | 'paused' | 'archived';

/**
 * Assessed severity of one watch signal / escalation. Ordered
 * low < medium < high < critical (see `severityRank`); aligned with the
 * missions module's urgency vocabulary.
 */
export type WatchSeverity = 'low' | 'medium' | 'high' | 'critical';

/** What fired one escalation record. */
export type EscalationTrigger = 'signal' | 'stale';

/** Kinds of parties an escalation may notify (opaque references). */
export type WatchPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

// ---------------------------------------------------------------------------
// Escalation policy
// ---------------------------------------------------------------------------

/**
 * A provider-neutral party reference (the goals module's GoalParty
 * precedent): an opaque uuid `id` owned by the respective module (people
 * for 'person', world for 'team', agents for 'agent'), a human-readable
 * `label`, or both — at least one must be present, so an escalation's
 * audience is always traceable.
 */
export interface WatchParty {
  kind: WatchPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of a `WatchParty`. */
export interface WatchPartyInput {
  kind: WatchPartyKind;
  id?: string | null;
  label?: string | null;
}

/**
 * The escalation policy of a watch — WHAT HAPPENS when the watch is
 * breached. Two arms, matching the two ways a watch can demand attention:
 *
 *  * the SIGNAL arm — a signal at/above `signalSeverityFloor` escalates
 *    immediately when the signal is recorded;
 *  * the STALENESS arm — a watch whose evidence has been stale (per its
 *    freshness policy, W006) for more than `staleGraceSeconds` escalates
 *    at severity `staleSeverity`; `staleGraceSeconds: null` DISARMS the
 *    arm (and `staleSeverity` must then be null too — inert configuration
 *    is rejected, the notifications module's escalation-coherence rule).
 *
 * `notifyParties` names who the escalation is for (≥ 1 opaque party);
 * `proposeMission` records that the escalation should propose a learning
 * mission — the "attention decision → mission or recommendation" arm of
 * §12's chain (launching the mission itself stays with the missions
 * module's own gates; this module never acts autonomously).
 *
 * The policy is a management control: the WATCHLIST carries the default
 * (required); an entry may carry a full-snapshot OVERRIDE (stored null =
 * inherit). Recorded escalations snapshot the resolved policy, so later
 * edits never rewrite what governed a past escalation.
 */
export interface WatchEscalationPolicy {
  signalSeverityFloor: WatchSeverity;
  /** Seconds of staleness past the freshness stale-after threshold before escalating; null disarms. */
  staleGraceSeconds: number | null;
  /** Severity of a staleness escalation; required iff `staleGraceSeconds` is set. */
  staleSeverity: WatchSeverity | null;
  notifyParties: WatchParty[];
  /** Whether the escalation proposes launching a learning mission. */
  proposeMission: boolean;
}

/** Input shape of `WatchEscalationPolicy` (identical — full-snapshot semantics). */
export interface WatchEscalationPolicyInput {
  signalSeverityFloor: WatchSeverity;
  staleGraceSeconds?: number | null;
  staleSeverity?: WatchSeverity | null;
  notifyParties: WatchPartyInput[];
  proposeMission: boolean;
}

/** A resolved escalation policy plus where it came from. */
export interface ResolvedEscalationPolicy {
  policy: WatchEscalationPolicy;
  source: 'entry' | 'watchlist';
}

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

/** One tenant watchlist (a named external-watch programme). */
export interface Watchlist {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: WatchlistStatus;
  /** The list's default escalation policy for its entries. */
  escalationPolicy: WatchEscalationPolicy;
  /** Derived entry counts by status (list/get views). */
  entryCounts: { active: number; paused: number; archived: number };
  /** ISO 8601 — the acting principal at creation (system-captured). */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `createWatchlist`. */
export interface CreateWatchlistInput {
  name: string;
  description?: string | null;
  /** Required — a watch without an escalation policy cannot demand attention. */
  escalationPolicy: WatchEscalationPolicyInput;
}

/** Query shape of `getWatchlist`. */
export interface GetWatchlistQuery {
  watchlistId: string;
}

/** Query shape of `listWatchlists`. */
export interface ListWatchlistsQuery {
  status?: WatchlistStatus;
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Input shape of `updateWatchlist` (arrays/policies replace wholesale). */
export interface UpdateWatchlistInput {
  watchlistId: string;
  name?: string;
  /** `null` clears. */
  description?: string | null;
  /** Full-snapshot replacement (omit to keep). */
  escalationPolicy?: WatchEscalationPolicyInput;
}

/** Input shape of `setWatchlistStatus` (reversible control transition). */
export interface SetWatchlistStatusInput {
  watchlistId: string;
  status: WatchlistStatus;
}

// ---------------------------------------------------------------------------
// Watch entries
// ---------------------------------------------------------------------------

/** One watched external subject (see the module header for the three kinds). */
export interface WatchEntry {
  id: string;
  tenantId: string;
  watchlistId: string;
  /** Denormalized from the owning watchlist for list views. */
  watchlistName: string;
  watchlistStatus: WatchlistStatus;
  kind: WatchEntryKind;
  /** Required exactly when `kind` is 'entity'; null otherwise. */
  entityKind: WatchEntityKind | null;
  name: string;
  description: string | null;
  /**
   * Optional binding to the world model's entity for the same external
   * thing (validated readable through the world contract at write time;
   * the world module owns the entity, this module the watch policy).
   */
  worldEntityId: string | null;
  /** Where to watch (canonical slugs); empty for geography-kind entries. */
  geographies: string[];
  /** What aspects to watch (canonical slugs). */
  topics: string[];
  /** Per-entry full-snapshot override; null = inherit the watchlist's policy. */
  escalationPolicy: WatchEscalationPolicy | null;
  /** The governing policy after entry-override → watchlist-default resolution. */
  resolvedEscalationPolicy: ResolvedEscalationPolicy;
  status: WatchEntryStatus;
  /** ISO 8601 — the acting principal at creation (system-captured). */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `addWatchEntry`. */
export interface AddWatchEntryInput {
  watchlistId: string;
  kind: WatchEntryKind;
  /** Required iff `kind` is 'entity'; forbidden otherwise. */
  entityKind?: WatchEntityKind | null;
  name: string;
  description?: string | null;
  /** Optional world-entity binding (uuid). */
  worldEntityId?: string | null;
  /** Where to watch; must be empty for geography-kind entries. */
  geographies?: string[];
  topics?: string[];
  /** Full-snapshot override; omit/null to inherit the watchlist's policy. */
  escalationPolicy?: WatchEscalationPolicyInput | null;
}

/** Query shape of `getWatchEntry`. */
export interface GetWatchEntryQuery {
  watchEntryId: string;
}

/** Query shape of `listWatchEntries`. */
export interface ListWatchEntriesQuery {
  watchlistId?: string;
  kind?: WatchEntryKind;
  entityKind?: WatchEntityKind;
  status?: WatchEntryStatus;
  /** Entry matches when its `geographies` array contains the slug. */
  geography?: string;
  /** Entry matches when its `topics` array contains the slug. */
  topic?: string;
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Input shape of `updateWatchEntry` (kind/entityKind are immutable identity). */
export interface UpdateWatchEntryInput {
  watchEntryId: string;
  name?: string;
  /** `null` clears. */
  description?: string | null;
  /** `null` clears the binding. */
  worldEntityId?: string | null;
  /** Replaces wholesale. */
  geographies?: string[];
  /** Replaces wholesale. */
  topics?: string[];
  /** `null` clears the override (inherit the watchlist's policy). */
  escalationPolicy?: WatchEscalationPolicyInput | null;
}

/** Input shape of `setWatchEntryStatus` (reversible control transition). */
export interface SetWatchEntryStatusInput {
  watchEntryId: string;
  status: WatchEntryStatus;
}

// ---------------------------------------------------------------------------
// Freshness wiring (W006, subject kind 'environment.watch')
// ---------------------------------------------------------------------------

/** Input shape of `setWatchFreshnessPolicy` (upsert by subject). */
export interface SetWatchFreshnessPolicyInput {
  /**
   * The watch entry this policy refines; null/omitted addresses the
   * tenant-wide 'environment.watch' default every entry falls back to.
   */
  watchEntryId?: string | null;
  staleAfterSeconds: number;
  agingAfterSeconds?: number | null;
  maxLatencySeconds?: number | null;
  note?: string | null;
}

/** Query shape of `resolveWatchFreshnessPolicy`. */
export interface ResolveWatchFreshnessPolicyQuery {
  watchEntryId: string;
}

/** Query shape of `evaluateWatchFreshness`. */
export interface EvaluateWatchFreshnessQuery {
  watchEntryId: string;
  /** Evaluate as of this instant (strict ISO 8601); defaults to now. */
  asOf?: string;
}

/**
 * Freshness of one watch entry's evidence stream: the age of its newest
 * signal's observation, classified against the resolved freshness policy
 * (entry-specific first, then the 'environment.watch' kind default), plus
 * the staleness-escalation schedule the pump acts on.
 *
 * `status` is 'unknown' when no policy applies OR no signal has been
 * recorded yet — the freshness module's discipline (no evidence to age is
 * unknown, never stale; "we have never observed this" discovery belongs to
 * attention, W051, not to a staleness pump that would otherwise fire on
 * every freshly added watch).
 */
export interface WatchFreshness {
  watchEntryId: string;
  tenantId: string;
  evaluatedAt: string;
  status: FreshnessStatus;
  /** The newest signal (by observedAt) feeding this evaluation; null when none. */
  latestSignalId: string | null;
  /** observedAt of the newest signal's observation; null when no signals. */
  latestObservedAt: string | null;
  /** Age of the newest evidence, seconds (fractional); null when no signals. */
  ageSeconds: number | null;
  /** The resolved freshness policy; null → status 'unknown'. */
  policy: FreshnessPolicy | null;
  /** The governing escalation policy (always resolvable for an existing entry). */
  escalationPolicy: ResolvedEscalationPolicy;
  /** When status is 'stale': the instant staleness began (latestObservedAt + staleAfterSeconds). */
  staleSince: string | null;
  /** When status is 'stale': seconds past the stale boundary (> 0). */
  staleForSeconds: number | null;
  /** When the staleness arm is armed: staleSince + staleGraceSeconds (the due instant). */
  escalationDueAt: string | null;
  /** True when a stale escalation is already recorded for THIS staleness episode. */
  staleEscalationRecorded: boolean;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** One evidence-linked hit on a watch entry. */
export interface WatchSignal {
  id: string;
  tenantId: string;
  watchEntryId: string;
  /** The observation backing the signal (validated at write time; immutable evidence). */
  observationId: string;
  /** observedAt of the backing observation, denormalized at record time. */
  observedAt: string;
  severity: WatchSeverity;
  note: string | null;
  /** The cognitive execution (W013) that produced/processed the signal, if any. */
  originExecutionId: string | null;
  /** True when an escalation was recorded for this signal. */
  escalated: boolean;
  /** The escalation recorded for this signal, when one fired. */
  escalationId: string | null;
  /** ISO 8601 — the acting principal (system-captured). */
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordWatchSignal`. */
export interface RecordWatchSignalInput {
  watchEntryId: string;
  observationId: string;
  severity: WatchSeverity;
  note?: string | null;
  originExecutionId?: string | null;
}

/** Result of `recordWatchSignal` — the signal plus the escalation it fired, if any. */
export interface WatchSignalResult {
  signal: WatchSignal;
  escalation: WatchEscalation | null;
}

/** Query shape of `getWatchSignal`. */
export interface GetWatchSignalQuery {
  watchSignalId: string;
}

/** Query shape of `listWatchSignals`. */
export interface ListWatchSignalsQuery {
  watchEntryId?: string;
  watchlistId?: string;
  /** Signals at/above this severity. */
  minSeverity?: WatchSeverity;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

/** One append-only record that a watch's escalation policy fired. */
export interface WatchEscalation {
  id: string;
  tenantId: string;
  watchEntryId: string;
  /** 'signal' — a signal at/above the floor; 'stale' — the staleness arm. */
  trigger: EscalationTrigger;
  severity: WatchSeverity;
  /** The signal that fired this escalation; null for 'stale'. */
  signalId: string | null;
  /** The resolved policy snapshot AT ESCALATION TIME (later edits never rewrite it). */
  policySnapshot: ResolvedEscalationPolicy;
  /** Human-readable reason (generated for 'stale'; the signal's note or generated for 'signal'). */
  summary: string;
  /** ISO 8601 — the acting principal (the signal recorder or the pump caller). */
  recordedBy: string;
  recordedAt: string;
}

/** Query shape of `getWatchEscalation`. */
export interface GetWatchEscalationQuery {
  watchEscalationId: string;
}

/** Query shape of `listWatchEscalations`. */
export interface ListWatchEscalationsQuery {
  watchEntryId?: string;
  watchlistId?: string;
  trigger?: EscalationTrigger;
  /** Escalations at/above this severity. */
  minSeverity?: WatchSeverity;
  /** 1..500, default 50. */
  limit?: number;
}

/** Skip-accounting of one `escalateStaleWatches` run. */
export interface StaleEscalationCounts {
  /** Not stale (current/aging). */
  fresh: number;
  /** No applicable freshness policy or no signal evidence ('unknown'). */
  unknown: number;
  /** Stale but the resolved policy disarms the staleness arm. */
  disarmed: number;
  /** Stale, armed, but the due instant has not passed yet. */
  notDue: number;
  /** Due, but this staleness episode already recorded its escalation. */
  deduplicated: number;
}

/** Result of one `escalateStaleWatches` pump pass. */
export interface StaleEscalationRun {
  evaluatedAt: string;
  /** How many entries the pass considered (bounded by the query limit). */
  considered: number;
  /** The escalations recorded by THIS pass (oldest first). */
  recorded: WatchEscalation[];
  counts: StaleEscalationCounts;
}

/** Query shape of `escalateStaleWatches` (the explicit due-processing pump). */
export interface EscalateStaleWatchesQuery {
  /** Restrict the pass to one watchlist; default: all active lists. */
  watchlistId?: string;
  /** Bound on entries considered per pass, 1..500, default 100. */
  limit?: number;
}
