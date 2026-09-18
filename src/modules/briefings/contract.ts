// ============================================================================
// briefings — the ONLY public surface of the briefings module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W032 — Management Briefings:
// "Generate policy-controlled proactive briefings for changes, goal
//  drift, unknowns, risks, opportunities, capability gaps,
//  workforce/agent performance and approvals."
//
// THE POLICIES (tenant-scoped management controls, keyed by section kind
// with a tenant-wide default row and a built-in floor — the
// actions/freshness/notifications resolution discipline):
//   setBriefingPolicy / getBriefingPolicy / listBriefingPolicies /
//   resolveBriefingPolicy — which sections are enabled, the item cap and
//   lookback per section, and — on the DEFAULT row only — the
//   briefing-level cadence window plus the delivery recipient a
//   generated briefing is pushed to. Policy writes require the
//   'briefings:administer' claim. Every briefing SNAPSHOTS the resolved
//   policy that governed it: later policy edits never rewrite what a
//   recorded briefing says.
//
// THE GENERATION (the proactive core):
//   generateBriefing — the explicit worker entrypoint (scheduled/system
//      triggers drive it; this module owns no background time). It
//      resolves the policy, computes the coverage window (explicit
//      bounds win; the default lower bound is CONTINUOUS with the
//      previous briefing — no gaps, no overlaps), compiles every section
//      from the DEPENDENCY CONTRACTS, and records the immutable briefing
//      + sections atomically. An idempotency key replays the original
//      briefing (first write wins — the events module's pattern) and
//      re-attempts an unfinished delivery. Delivery itself is a handoff:
//      when the policy carries a recipient, ONE notification (kind
//      'briefing', stable dedupe key `briefing:<id>`) is created through
//      the notifications contract (W031) — urgent/digest/escalation,
//      retries, the W009 authority gate and acknowledgment remain W031's
//      owned machinery. Briefings never deliver over a channel directly.
//
// THE SECTIONS (W032's own list, in canonical order):
//   changes (events W003) · goal-drift (goals W008: overdue horizons +
//   in-window revisions) · unknowns (epistemics W007: the open set) ·
//   risks and opportunities (cognition W013: findings recorded on the
//   risk-opportunity-capability-analysis stage inside the section
//   window) · capability-gaps (capabilities W017: the derived
//   uncovered/shortfall view) · workforce-performance (agents W021:
//   per-agent rollups; the human-workforce compiler integrates here when
//   W019 lands) · approvals (actions W009: pending authority-gate
//   requests).
//
// THE READS:
//   getBriefing / listBriefings — the recorded briefing feed. Briefings
//   and sections are immutable history (storage-level triggers reject
//   UPDATE/DELETE/TRUNCATE; the ONLY post-write move is the one-way
//   NULL→value assignment of the delivery notification id). There is
//   deliberately NO operation to update, regenerate in place, or erase a
//   briefing — the chain "policy snapshot → window → compiled sections
//   → deep-linked evidence → delivery handoff" stays reconstructable
//   (ARCHITECTURE.md §24), and a briefing NEVER becomes authoritative
//   business state (lock 34 / ADR-0010): every item carries deep links
//   (`refs`) to the underlying records.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's briefings,
// sections and policies are indistinguishable from missing ones — no
// existence leak.
//
// Dependency posture (work-item DAG: W008 + W013 + W031 → W032, plus the
// module map's "cognition + actions → notifications/briefings"): this
// module imports ONLY module contracts — events, goals, epistemics,
// cognition, capabilities, agents, actions, notifications and (for the
// canonical channel-provider vocabulary) identity. Section compilation
// reads each owning module's contract; nothing else. The sections whose
// first-class source modules do not exist at this base (W015
// opportunities, W018 automation candidates, W019 human workforce) are
// served today through the cognition trace findings and the agents
// contract rollups, and integrate through the same section kinds when
// their modules land — the kinds are stable.
// ============================================================================

export {
  generateBriefing,
  getBriefing,
  getBriefingPolicy,
  listBriefingPolicies,
  listBriefings,
  resolveBriefingPolicy,
  setBriefingPolicy,
} from './service';

export { BriefingsError } from './errors';
export type { BriefingsErrorCode } from './errors';

// The deterministic section vocabulary, the built-in policy floor, the
// kind → default → built-in resolution, the window/bounding math and
// the bounded composition — the single definitions, pure and total,
// reusable by downstream modules (W033 control tower, W038 API, W039
// MCP) and unit-testable in isolation (the notifications policy.ts
// precedent).
export {
  // fixed vocabularies
  BRIEFING_SECTION_KINDS,
  BRIEFING_TRIGGER_KINDS,
  SECTION_LABELS,
  // the built-in floor + resolution
  BUILT_IN_DEFAULT_POLICY,
  builtInDefaultPolicy,
  resolveBriefingPolicySnapshot,
  resolveSectionPolicySnapshot,
  // deterministic windows and bounding
  MAX_BRIEFING_WINDOW_SECONDS,
  briefingWindowFrom,
  boundCandidates,
  // bounded composition (delivery handoff subject/body)
  BODY_SECTION_EXCERPTS,
  MAX_BODY_LENGTH,
  MAX_HEADLINE_LENGTH,
  composeBriefingBody,
  composeBriefingHeadline,
  excerptText,
  EXCERPT_ELLIPSIS,
  // the delivery-handoff vocabulary
  BRIEFING_NOTIFICATION_KIND,
  briefingNotificationDedupeKey,
  // authority + scan determinism
  BRIEFINGS_AUTHORITY_ADMINISTER,
  SECTION_SCAN_LIMITS,
  // vocabulary guards
  isBriefingPolicySource,
  isBriefingSectionKind,
  isBriefingTriggerKind,
  recipientLabel,
} from './policy';

export {
  DEFAULT_LIST_LIMIT,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MAX_ITEMS,
  MAX_NOTE_LENGTH,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_SECTION_ITEMS_BYTES,
  MAX_TRIGGER_LABEL_LENGTH,
  MAX_WINDOW_SECONDS,
  MIN_MAX_ITEMS,
  MIN_WINDOW_SECONDS,
  assertBriefingsTenantContext,
  canAdministerBriefingPolicies,
  isUuid,
} from './validation';

export type {
  ValidatedGenerateInput,
  ValidatedPolicyInput,
} from './validation';

// The compiler bounds + registry (sections read sibling contracts; the
// registry is the documented seam future source modules integrate
// through).
export {
  MAX_DETAIL_CONSEQUENCE,
  MAX_DETAIL_IDS,
  MAX_DETAIL_TEXT,
  MAX_ITEM_REFS,
  MAX_SUMMARY_LENGTH,
  compileSection,
} from './sections';
export type { SectionCompiler, SectionWindow } from './sections';

export type {
  ApprovalItemDetail,
  Briefing,
  BriefingItem,
  BriefingItemDetail,
  BriefingPolicy,
  BriefingPolicySource,
  BriefingRecipient,
  BriefingRef,
  BriefingSection,
  BriefingSectionKind,
  BriefingSectionSummary,
  BriefingSummary,
  BriefingTriggerKind,
  CapabilityGapItemDetail,
  ChangeItemDetail,
  FindingItemDetail,
  GenerateBriefingInput,
  GenerateBriefingResult,
  GetBriefingQuery,
  GoalDriftItemDetail,
  ListBriefingsQuery,
  ListBriefingPoliciesQuery,
  PolicySubjectQuery,
  ResolvedBriefingPolicy,
  ResolvedSectionPolicy,
  ResolvePolicyQuery,
  SectionPolicySource,
  SetBriefingPolicyInput,
  UnknownItemDetail,
  WorkforceItemDetail,
} from './types';

// The canonical channel-provider vocabulary is owned by the identity
// module (ADR-0015 provider-neutral keys) and re-exported through the
// notifications contract; it is re-exported here so this contract is
// self-contained for the delivery-recipient shape it requires.
export type { ChannelProvider } from '@/modules/notifications/contract';
