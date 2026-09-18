// Public domain types of the briefings module (W032 — Management
// Briefings).
//
// W032 owns policy-controlled PROACTIVE management briefings:
//
//  1. BRIEFING POLICIES (tenant-scoped management controls, keyed by
//     section kind with a tenant-wide default row and a built-in floor —
//     the actions/freshness/notifications resolution discipline): which
//     sections are enabled, how many items each section may carry, how
//     far back each section looks, and — on the default row only — the
//     briefing-level cadence window and the delivery recipient a
//     generated briefing is pushed to through the notifications module
//     (W031).
//
//  2. BRIEFINGS: one immutable derived document per generation — the
//     window it covers, the trigger that produced it, the resolved
//     policy snapshots that governed it, and its sections. Lock 34
//     (ADR-0010): briefings are DERIVED INTELLIGENCE, never
//     authoritative source state — every item deep-links the underlying
//     records through `refs` (ARCHITECTURE.md §22: "findings link to the
//     underlying evidence and executions").
//
//  3. SECTIONS: one row per section kind per briefing — the policy
//     snapshot, the section's effective lookback window, the candidate
//     count found, and the bounded item list. Disabled sections record
//     an empty row (the briefing documents exactly what was off).
//
// Everything is provider-neutral by construction: the one channel-party
// shape (delivery recipient) re-uses the canonical vocabulary owned by
// the identity module and re-exported through the channels/notifications
// contracts. The acting principal is the TenantContext principal
// (opaque string, per the house precedent).

import type { ChannelProvider } from '@/modules/notifications/contract';

export type { ChannelProvider };

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The briefing sections W032 compiles (the work item's own list):
 *  * 'changes'               — meaningful changes (events, W003) in the
 *                              section window;
 *  * 'goal-drift'            — active goals overdue against their horizon
 *                              or revised inside the section window
 *                              (W008);
 *  * 'unknowns'              — the current unresolved unknowns (W007);
 *  * 'risks'                 — risk findings recorded on cognitive
 *                              executions (W013) in the section window;
 *  * 'opportunities'         — opportunity findings (W013) ditto;
 *  * 'capability-gaps'       — current uncovered/shortfall capability
 *                              gaps (W017);
 *  * 'workforce-performance' — per-worker performance rollups over the
 *                              agent workforce (W021; the human-workforce
 *                              compiler integrates here when W019 lands);
 *  * 'approvals'             — decisions currently requiring management
 *                              attention: pending authority-gate requests
 *                              (W009).
 */
export type BriefingSectionKind =
  | 'changes'
  | 'goal-drift'
  | 'unknowns'
  | 'risks'
  | 'opportunities'
  | 'capability-gaps'
  | 'workforce-performance'
  | 'approvals';

/** What initiated a generation (provider-neutral, worker-driven). */
export type BriefingTriggerKind = 'on_demand' | 'scheduled' | 'system';

/** Where a briefing-level policy resolution came from. */
export type BriefingPolicySource = 'tenant-default' | 'built-in';

/** Where a section policy resolution came from. */
export type SectionPolicySource = 'kind' | 'tenant-default' | 'built-in';

// ---------------------------------------------------------------------------
// Delivery (canonical channel party — provider-neutral, ADR-0015)
// ---------------------------------------------------------------------------

/**
 * The recipient a generated briefing is pushed to through the
 * notifications module (W031). Same canonical shape the notifications
 * contract requires; delivery semantics (urgent/digest/escalation, the
 * W009 authority gate, retries) stay owned by W031.
 */
export interface BriefingRecipient {
  provider: ChannelProvider;
  /** Canonical, adapter-normalized account id (opaque string). */
  providerAccountId: string;
  displayName?: string | null;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped briefing policy row. `sectionKind` null is the
 * tenant-wide DEFAULT row: it carries the default section controls AND
 * the briefing-level configuration (the cadence window and the delivery
 * recipient — only the default row may carry a recipient).
 *
 * Policies are management controls, not evidence: legitimately updatable,
 * with change history belonging to audit (W046).
 */
export interface BriefingPolicy {
  id: string;
  tenantId: string;
  sectionKind: string | null;
  /** Whether the section (or, on the default row, sections without their own row) appears. */
  enabled: boolean;
  /** Item cap per section (1..100). */
  maxItems: number;
  /** Section lookback (60..2_592_000 s); on the default row also the cadence window. */
  windowSeconds: number;
  /** Delivery recipient — the DEFAULT ROW ONLY (validation + SQL CHECK enforce it). */
  deliveryRecipient: BriefingRecipient | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `setBriefingPolicy` (upsert by section-kind key). */
export interface SetBriefingPolicyInput {
  /** null/omitted addresses the tenant-wide default row. */
  sectionKind?: string | null;
  enabled?: boolean;
  maxItems?: number;
  windowSeconds?: number;
  /** Only addressable on the default row (null disables delivery). */
  deliveryRecipient?: BriefingRecipient | null;
  note?: string | null;
}

/**
 * The effective briefing-level rules: the cadence window, the default
 * section controls, and the delivery recipient. `policy` is null exactly
 * when the built-in floor decided.
 */
export interface ResolvedBriefingPolicy {
  source: BriefingPolicySource;
  /** The default row that decided, or null when the built-in floor did. */
  policy: BriefingPolicy | null;
  enabled: boolean;
  maxItems: number;
  windowSeconds: number;
  deliveryRecipient: BriefingRecipient | null;
}

/**
 * The effective rules for one section: what decided plus the resolved
 * field values (the built-in floor's values when nothing else decided,
 * so a resolved policy is always directly usable).
 */
export interface ResolvedSectionPolicy {
  sectionKind: BriefingSectionKind;
  source: SectionPolicySource;
  /** The policy row that decided, or null when the built-in floor did. */
  policy: BriefingPolicy | null;
  enabled: boolean;
  maxItems: number;
  windowSeconds: number;
}

/** Query shape of `getBriefingPolicy` (exact key; null = the default row). */
export interface PolicySubjectQuery {
  sectionKind?: string | null;
}

/** Query shape of `resolveBriefingPolicy` (a section kind's effective rules). */
export interface ResolvePolicyQuery {
  sectionKind: BriefingSectionKind;
}

/** Query shape of `listBriefingPolicies`. */
export interface ListBriefingPoliciesQuery {
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Briefings
// ---------------------------------------------------------------------------

/** Input shape of `generateBriefing`. */
export interface GenerateBriefingInput {
  /** What initiated the generation; defaults to on_demand. */
  trigger?: {
    kind: BriefingTriggerKind;
    label?: string | null;
  };
  /**
   * Inclusive lower bound of the coverage window; omitted = the previous
   * briefing's window end (continuous coverage, no gaps/overlaps), or
   * `windowTo − resolved cadence window` for the first briefing.
   */
  windowFrom?: string | null;
  /** Inclusive upper bound; omitted = now (service clock). */
  windowTo?: string | null;
  /**
   * Emitter-supplied dedupe key: generating again with the same key
   * returns the original briefing unchanged (first write wins) and
   * re-attempts an unfinished delivery. The events module's pattern.
   */
  idempotencyKey?: string | null;
}

/** Result of `generateBriefing`. */
export interface GenerateBriefingResult {
  briefing: Briefing;
  /** true when the idempotency key replayed an existing briefing. */
  deduped: boolean;
  /** Set when a policy-controlled delivery handoff happened; the notification's id. */
  deliveredNotificationId: string | null;
}

/**
 * One deep link from a briefing item to the underlying record (lock 34 /
 * §22: findings link to the underlying evidence and executions). `module`
 * names the owning module; `kind` the record kind inside it; `id` the
 * opaque record id.
 */
export interface BriefingRef {
  module: string;
  kind: string;
  id: string;
}

// --- Per-section item payloads (the `detail` discriminator) ---------------

export interface ChangeItemDetail {
  section: 'changes';
  type: string;
  typeVersion: number;
  occurredAt: string;
  recordedAt: string;
  sequence: number;
  actor: { kind: string; label: string | null };
}

export interface GoalDriftItemDetail {
  section: 'goal-drift';
  goalId: string;
  version: number;
  title: string;
  priority: string;
  /** 'overdue' wins when a goal is both overdue and revised. */
  signal: 'overdue' | 'revised';
  /** The goals module's change kind of the current version. */
  changeKind: string | null;
  horizonEnd: string;
  /** When the current version was committed (lastChange.recordedAt). */
  changedAt: string;
}

export interface UnknownItemDetail {
  section: 'unknowns';
  unknownId: string;
  question: string;
  consequence: string;
  recordedAt: string;
}

export interface FindingItemDetail {
  section: 'risks' | 'opportunities';
  executionId: string;
  findingKind: 'risk' | 'opportunity';
  statement: string;
  evidenceObservationIds: string[];
  affectedGoalIds: string[];
  /** When the analysis step that recorded the finding was committed. */
  recordedAt: string;
}

export interface CapabilityGapItemDetail {
  section: 'capability-gaps';
  capabilityId: string;
  name: string;
  gapStatus: 'uncovered' | 'level_shortfall' | 'capacity_shortfall';
  unmetCount: number;
  bestActiveLevel: number | null;
  totalActiveCapacity: number;
}

export interface WorkforceItemDetail {
  section: 'workforce-performance';
  agentId: string;
  slug: string;
  displayName: string | null;
  role: string;
  provider: string;
  /** Executions submitted inside the section window. */
  executions: number;
  succeeded: number;
  failed: number;
  refused: number;
  cancelled: number;
  /** awaiting_approval + queued (still in flight). */
  awaiting: number;
  /** Sum of execution costs, integer minor units. */
  costMinor: number;
}

export interface ApprovalItemDetail {
  section: 'approvals';
  requestId: string;
  actionKind: string;
  authorityLevel: string;
  requestedBy: string;
  requestedAt: string;
  justification: string | null;
}

/** The kind-specific payload of one briefing item (discriminated by `section`). */
export type BriefingItemDetail =
  | ChangeItemDetail
  | GoalDriftItemDetail
  | UnknownItemDetail
  | FindingItemDetail
  | CapabilityGapItemDetail
  | WorkforceItemDetail
  | ApprovalItemDetail;

/** One bounded briefing item: a human summary, deep links and the payload. */
export interface BriefingItem {
  /** 1..500 chars — the management-readable line. */
  summary: string;
  /** 0..32 deep links to the underlying records. */
  refs: BriefingRef[];
  detail: BriefingItemDetail;
}

// --- Sections ---------------------------------------------------------------

/** One compiled section of a recorded briefing. */
export interface BriefingSection {
  id: string;
  tenantId: string;
  briefingId: string;
  sectionKind: BriefingSectionKind;
  policySource: SectionPolicySource;
  /** false = the section was disabled by policy; the row documents it. */
  enabled: boolean;
  /** The snapshot of the item cap and lookback that governed compilation. */
  maxItems: number;
  windowSeconds: number;
  /**
   * The section's effective window (inclusive bounds): the INTERSECTION
   * of the briefing's coverage window and the section's lookback policy —
   * a section never reaches beyond what its briefing covers, and never
   * re-covers what a previous briefing already did.
   */
  windowFrom: string;
  windowTo: string;
  /** Candidates found before the item cap applied (honesty about truncation). */
  candidateCount: number;
  itemCount: number;
  items: BriefingItem[];
  recordedAt: string;
}

/** The list-view of a section (no items — deep-link with `getBriefing`). */
export type BriefingSectionSummary = Omit<BriefingSection, 'items'>;

// --- Briefings ---------------------------------------------------------------

/**
 * One generated briefing: the immutable derived document. The
 * briefing-level policy snapshot (`policySource`, `defaultWindowSeconds`,
 * `deliveryRecipient`) is EXACTLY as it governed this generation; later
 * policy edits never rewrite a recorded briefing.
 */
export interface Briefing {
  id: string;
  tenantId: string;
  trigger: { kind: BriefingTriggerKind; label: string | null };
  /** Inclusive coverage bounds. */
  windowFrom: string;
  windowTo: string;
  generatedBy: string;
  generatedAt: string;
  /** 1..200 chars — the deterministic headline (policy.ts). */
  headline: string;
  policySource: BriefingPolicySource;
  defaultWindowSeconds: number;
  /** The delivery recipient snapshot (null = no push). */
  deliveryRecipient: BriefingRecipient | null;
  /** The notification created for the delivery handoff (W031), once it happened. */
  deliveryNotificationId: string | null;
  updatedAt: string;
  /** All sections in canonical kind order. */
  sections: BriefingSection[];
}

/** The list-view of a briefing (sections without items). */
export type BriefingSummary = Omit<Briefing, 'sections'> & {
  sections: BriefingSectionSummary[];
};

/** Query shape of `getBriefing`. */
export interface GetBriefingQuery {
  briefingId: string;
}

/** Query shape of `listBriefings`. */
export interface ListBriefingsQuery {
  triggerKind?: BriefingTriggerKind;
  /** Briefings whose window intersects [from, to] (inclusive bounds). */
  windowFrom?: string;
  windowTo?: string;
  /** 1..500, default 50. */
  limit?: number;
}
