// ============================================================================
// environment — the ONLY public surface of the environment module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W014 — Environment Watch (spec/work-items/WORK-ITEM-CATALOG.md):
// "Implement company-specific external watchlists with entities, topics,
//  geography, regulators, competitors, suppliers, freshness and escalation
//  policy."
//
// ARCHITECTURE.md §12 (frozen): "EnvironmentWatch defines the external
// entities/topics/geographies/regulators/laws/competitors/suppliers/
// technologies/markets that matter to a tenant, with freshness and
// escalation rules." Lock 18: EnvironmentWatch is a first-class concept.
//
//   Watchlists (the named external-watch programmes)
//     createWatchlist — a programme with its REQUIRED default escalation
//        policy (a watch that cannot demand attention is a misconfig).
//     getWatchlist / listWatchlists — views with derived entry counts,
//        filtered (status, name/description search).
//     updateWatchlist — name/description/policy edits (controls are
//        updatable; change history belongs to audit, W046).
//     setWatchlistStatus — the reversible active ↔ archived lifecycle.
//        An archived list accepts no new entries and its entries are not
//        evaluated by the staleness pump.
//
//   Watch entries (the watched subjects — the three axes of the item)
//     addWatchEntry — kind 'entity' (entityKind from the §12 vocabulary:
//        competitor / regulator / government_body / supplier / law /
//        technology / market / industry), 'topic' or 'geography', scoped
//        by canonical geography slugs (where) and topic slugs (what
//        aspects), optionally bound to the world module's entity for the
//        same external thing (validated readable through the world
//        contract — W005 owns the entity, this module the watch policy).
//     getWatchEntry / listWatchEntries — filtered (watchlist, kind,
//        entityKind, status, geography/topic containment, search).
//     updateWatchEntry — mutable scoping/linkage (name, description,
//        world binding, geographies, topics, escalation-policy override);
//        kind + entityKind are IMMUTABLE identity (remove + re-add).
//     setWatchEntryStatus — the reversible active / paused / archived
//        lifecycle; only ACTIVE entries on ACTIVE lists collect signals.
//
//   Freshness wiring (W006 — the shared subject-kind namespace)
//     setWatchFreshnessPolicy — upsert the stale-after policy of one
//        entry, or the tenant-wide 'environment.watch' DEFAULT every
//        entry falls back to (watchEntryId omitted/null). Delegates to
//        the freshness contract under WATCH_SUBJECT_KIND — exactly the
//        wiring the freshness contract anticipates ("W014 its watch
//        rules").
//     resolveWatchFreshnessPolicy — the governing policy after
//        entry-specific → kind-default resolution (null = none).
//     evaluateWatchFreshness — the entry's evidence stream classified
//        current/aging/stale (or 'unknown': no policy, or no signal yet —
//        the freshness module's discipline) plus the staleness-escalation
//        schedule (staleSince, escalationDueAt, episode state).
//
//   Signals (the evidence-linked hits)
//     recordWatchSignal — link ONE immutable observation (W004, validated
//        readable through the observations contract) to one active entry
//        with an assessed severity (the bounded-reasoning seam — lock 10:
//        the assessment is recorded evidence-linked input, never
//        authoritative truth) and an optional originating cognitive
//        execution (W013, validated readable). Signals are append-only
//        (storage-enforced); one per (entry, observation). When the
//        severity meets the resolved escalation policy's floor, the
//        SIGNAL ARM fires immediately: an append-only escalation that
//        SNAPSHOTS the resolved policy.
//     getWatchSignal / listWatchSignals — the hit feed (watchlist, entry,
//        minimum-severity filters) with each signal's escalation link.
//
//   Escalations (the append-only policy-fired records)
//     escalateStaleWatches — THE STALENESS ARM's explicit due-processing
//        pump (workers call it on a schedule; this module owns no
//        background time — the notifications module's discipline):
//        considers ACTIVE entries on ACTIVE lists (bounded, oldest
//        first), classifies each against its freshness policy, and for
//        entries stale past the policy's grace period records ONE
//        'stale' escalation per staleness EPISODE (new evidence
//        re-anchors the episode). Single-flighted per tenant via the lock
//        port; skips are accounted (fresh / unknown / disarmed / notDue /
//        deduplicated).
//     getWatchEscalation / listWatchEscalations — the escalation feed
//        (watchlist, entry, trigger, minimum-severity filters).
//
// There is deliberately NO operation to update or erase a signal or an
// escalation (append-only, storage-enforced triggers), no DELETE for
// watchlists/entries (identity is retained; archived is the retirement),
// and no autonomous consequence: an escalation RECORDS that attention is
// due — delivering notifications is W031's policy-gated job, launching
// missions W011's, opportunities are W015's; `proposeMission` is a policy
// flag on the snapshot, not an action.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's watch programme is
// indistinguishable from a missing one (`watchlist_not_found` /
// `watch_entry_not_found` / `watch_signal_not_found` /
// `watch_escalation_not_found` — no existence leak), and the validated
// cross-module references (world entities, observations, cognitive
// executions) are uniformly `invalid_world_ref` / `invalid_observation_ref`
// / `invalid_execution_ref` for the same reason.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md:
// W005 + W006 + W013 → W014; MODULE-DEPENDENCY-MAP.md:
// `goals + world + cognition → environment/opportunities/…`): this module
// imports ONLY module contracts — world (W005: entity-binding validation),
// freshness (W006: stale-after policies + the pure classifiers),
// observations (W004: signal evidence validation) and cognition (W013:
// originating-execution validation). Nothing else.
// ============================================================================

export {
  // watchlists
  createWatchlist,
  getWatchlist,
  listWatchlists,
  setWatchlistStatus,
  updateWatchlist,
  // watch entries
  addWatchEntry,
  getWatchEntry,
  listWatchEntries,
  setWatchEntryStatus,
  updateWatchEntry,
  // freshness wiring (W006)
  evaluateWatchFreshness,
  resolveWatchFreshnessPolicy,
  setWatchFreshnessPolicy,
  // signals
  getWatchSignal,
  listWatchSignals,
  recordWatchSignal,
  // escalations
  escalateStaleWatches,
  getWatchEscalation,
  listWatchEscalations,
} from './service';

export { EnvironmentError } from './errors';
export type { EnvironmentErrorCode } from './errors';

// The deterministic escalation/staleness derivations — the single
// definitions, pure and total, reusable by downstream modules (W015
// opportunity engine, W033 control tower) and unit-testable in isolation
// (the processes detection.ts / freshness classification.ts precedent).
export {
  isStaleEpisodeEscalated,
  resolveEscalationPolicy,
  severityMeetsFloor,
  severityRank,
  severitiesAtOrAbove,
  signalEscalationSummary,
  staleEscalationSummary,
  stalenessDue,
  stalenessSchedule,
} from './escalation';
export type { StalenessSchedule } from './escalation';

export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_PUMP_LIMIT,
  ESCALATION_TRIGGERS,
  MAX_LIST_LIMIT,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_NOTIFY_PARTIES,
  MAX_PARTY_LABEL_LENGTH,
  MAX_PUMP_LIMIT,
  MAX_SCOPES,
  MAX_STALE_GRACE_SECONDS,
  MAX_SUMMARY_LENGTH,
  WATCH_ENTRY_KINDS,
  WATCH_ENTRY_STATUSES,
  WATCH_ENTITY_KINDS,
  WATCH_PARTY_KINDS,
  WATCH_SEVERITIES,
  WATCH_SUBJECT_KIND,
  WATCHLIST_STATUSES,
  escapeLike,
  isEscalationTrigger,
  isUuid,
  isWatchEntryKind,
  isWatchEntryStatus,
  isWatchEntityKind,
  isWatchPartyKind,
  isWatchSeverity,
  isWatchlistStatus,
} from './validation';

export type {
  ValidatedAddWatchEntryInput,
  ValidatedCreateWatchlistInput,
  ValidatedEscalationPolicy,
  ValidatedEvaluateWatchFreshnessQuery,
  ValidatedIdQuery,
  ValidatedListEntriesQuery,
  ValidatedListEscalationsQuery,
  ValidatedListSignalsQuery,
  ValidatedListWatchlistsQuery,
  ValidatedParty,
  ValidatedPumpQuery,
  ValidatedRecordSignalInput,
  ValidatedResolveWatchFreshnessPolicyQuery,
  ValidatedSetWatchEntryStatusInput,
  ValidatedSetWatchFreshnessPolicyInput,
  ValidatedSetWatchlistStatusInput,
  ValidatedUpdateWatchEntryInput,
  ValidatedUpdateWatchlistInput,
} from './validation';

export type {
  AddWatchEntryInput,
  CreateWatchlistInput,
  EscalateStaleWatchesQuery,
  EscalationTrigger,
  EvaluateWatchFreshnessQuery,
  FreshnessPolicy,
  FreshnessStatus,
  GetWatchEntryQuery,
  GetWatchEscalationQuery,
  GetWatchSignalQuery,
  GetWatchlistQuery,
  ListWatchEntriesQuery,
  ListWatchEscalationsQuery,
  ListWatchSignalsQuery,
  ListWatchlistsQuery,
  RecordWatchSignalInput,
  ResolvedEscalationPolicy,
  ResolveWatchFreshnessPolicyQuery,
  SetWatchEntryStatusInput,
  SetWatchFreshnessPolicyInput,
  SetWatchlistStatusInput,
  StaleEscalationCounts,
  StaleEscalationRun,
  UpdateWatchEntryInput,
  UpdateWatchlistInput,
  WatchEntityKind,
  WatchEntry,
  WatchEntryKind,
  WatchEntryStatus,
  WatchEscalation,
  WatchEscalationPolicy,
  WatchEscalationPolicyInput,
  WatchFreshness,
  WatchParty,
  WatchPartyInput,
  WatchPartyKind,
  WatchSeverity,
  WatchSignal,
  WatchSignalResult,
  Watchlist,
  WatchlistStatus,
} from './types';
