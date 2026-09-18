// Pure policy/composition logic of the briefings module (W032 —
// Management Briefings). No database, no context, no time source —
// everything here is a total, deterministic function of its arguments
// (the same discipline as the actions matrix and the notifications
// policy): the same policy state and the same inputs always yield the
// same resolution, window, bounding and composition answers. No LLM,
// randomness or hidden state participates (ARCHITECTURE.md §2 —
// application-owned behavior).
//
// Contents:
//  * the section-kind / trigger-kind vocabularies (mirrored by the SQL
//    CHECK constraints in migrations/001 and /002);
//  * the BUILT-IN DEFAULT policy — the deterministic floor for tenants
//    that configured no rows (all sections on, 20 items each, a 24h
//    lookback, a 24h cadence window, no delivery push);
//  * resolveBriefingPolicySnapshot / resolveSectionPolicySnapshot —
//    kind row → tenant-default row → built-in (the house resolution
//    discipline);
//  * briefingWindowFrom — the default coverage-window computation
//    (continuity with the previous briefing, clamped to the maximum
//    window);
//  * boundCandidates — the honest item-cap application (candidate count
//    retained);
//  * composeBriefingHeadline / composeBriefingBody — the deterministic
//    management-facing text, bounded for the notifications contract's
//    subject/body limits;
//  * the delivery-handoff vocabulary: the notification kind a pushed
//    briefing is created under (W031) and the stable dedupe key that
//    makes the handoff replay-safe;
//  * excerptText — the bounded excerpt helper (deep links carry the full
//    records; briefings carry bounded management-readable text).

import type {
  BriefingItem,
  BriefingPolicy,
  BriefingPolicySource,
  BriefingRecipient,
  BriefingSectionKind,
  BriefingTriggerKind,
  ResolvedBriefingPolicy,
  ResolvedSectionPolicy,
  SectionPolicySource,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the SQL CHECK constraints)
// ---------------------------------------------------------------------------

/**
 * The briefing section kinds, in the canonical order sections are
 * compiled and returned (W032's own list — the work item text).
 */
export const BRIEFING_SECTION_KINDS = [
  'changes',
  'goal-drift',
  'unknowns',
  'risks',
  'opportunities',
  'capability-gaps',
  'workforce-performance',
  'approvals',
] as const;

export function isBriefingSectionKind(value: unknown): value is BriefingSectionKind {
  return (
    typeof value === 'string' &&
    (BRIEFING_SECTION_KINDS as readonly string[]).includes(value)
  );
}

/** Human labels for the composition functions (display only). */
export const SECTION_LABELS: Record<BriefingSectionKind, string> = {
  changes: 'Changes',
  'goal-drift': 'Goal drift',
  unknowns: 'Unknowns',
  risks: 'Risks',
  opportunities: 'Opportunities',
  'capability-gaps': 'Capability gaps',
  'workforce-performance': 'Workforce / agent performance',
  approvals: 'Approvals',
};

/** What may initiate a briefing generation (provider-neutral). */
export const BRIEFING_TRIGGER_KINDS = ['on_demand', 'scheduled', 'system'] as const;

export function isBriefingTriggerKind(value: unknown): value is BriefingTriggerKind {
  return (
    typeof value === 'string' &&
    (BRIEFING_TRIGGER_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Authority + delivery-handoff vocabulary
// ---------------------------------------------------------------------------

/** Authority claim required to manage briefing policies. */
export const BRIEFINGS_AUTHORITY_ADMINISTER = 'briefings:administer';

/**
 * The canonical notification kind a policy-controlled briefing push is
 * created under (W031's open kind namespace — W032 registers its kind by
 * using it). Delivery semantics (class, retries, dedupe, escalation, the
 * W009 authority gate) are owned by the notifications module; tenants
 * configure them through THAT module's policy surface for this kind.
 */
export const BRIEFING_NOTIFICATION_KIND = 'briefing';

/** The stable dedupe key for a briefing's delivery handoff (replay-safe). */
export function briefingNotificationDedupeKey(briefingId: string): string {
  return `briefing:${briefingId}`;
}

// ---------------------------------------------------------------------------
// The built-in default policy (the deterministic floor)
// ---------------------------------------------------------------------------

/**
 * The built-in default: every section enabled, 20 items per section, a
 * 24-hour lookback, a 24-hour cadence window, and no delivery push
 * (management reads briefings through the control-tower surface; push is
 * an explicit opt-in). Tenants tighten or relax every field per section
 * kind through setBriefingPolicy; the floor never silently overrides
 * tenant policy (the actions module's built-in matrix discipline).
 */
export const BUILT_IN_DEFAULT_POLICY = {
  enabled: true,
  maxItems: 20,
  windowSeconds: 86_400,
  deliveryRecipient: null,
} as const;

/** A fresh copy of the built-in default policy fields. */
export function builtInDefaultPolicy(): Omit<
  ResolvedBriefingPolicy,
  'source' | 'policy'
> {
  return {
    enabled: BUILT_IN_DEFAULT_POLICY.enabled,
    maxItems: BUILT_IN_DEFAULT_POLICY.maxItems,
    windowSeconds: BUILT_IN_DEFAULT_POLICY.windowSeconds,
    deliveryRecipient: BUILT_IN_DEFAULT_POLICY.deliveryRecipient,
  };
}

// ---------------------------------------------------------------------------
// Resolution (kind row → tenant-default row → built-in)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective BRIEFING-LEVEL policy (cadence window, default
 * section controls, delivery recipient) from the tenant's default row:
 * the default row when it exists, otherwise the built-in floor. Pure and
 * total — every tenant resolves.
 */
export function resolveBriefingPolicySnapshot(
  defaultRow: BriefingPolicy | null,
): ResolvedBriefingPolicy {
  if (defaultRow === null) {
    return { source: 'built-in', policy: null, ...builtInDefaultPolicy() };
  }
  return {
    source: 'tenant-default',
    policy: defaultRow,
    enabled: defaultRow.enabled,
    maxItems: defaultRow.maxItems,
    windowSeconds: defaultRow.windowSeconds,
    deliveryRecipient: defaultRow.deliveryRecipient,
  };
}

/**
 * Resolve the effective policy for one section kind: the kind's own row
 * first, then the tenant-wide default row (its section fields), then the
 * built-in floor. Pure and total — every section kind resolves.
 * `policy` is null exactly when the built-in floor decided.
 */
export function resolveSectionPolicySnapshot(
  sectionKind: BriefingSectionKind,
  kindRow: BriefingPolicy | null,
  defaultRow: BriefingPolicy | null,
): ResolvedSectionPolicy {
  const decided = kindRow ?? defaultRow;
  if (decided === null) {
    return {
      sectionKind,
      source: 'built-in',
      policy: null,
      enabled: BUILT_IN_DEFAULT_POLICY.enabled,
      maxItems: BUILT_IN_DEFAULT_POLICY.maxItems,
      windowSeconds: BUILT_IN_DEFAULT_POLICY.windowSeconds,
    };
  }
  const source: SectionPolicySource =
    kindRow !== null ? 'kind' : 'tenant-default';
  return {
    sectionKind,
    source,
    policy: decided,
    enabled: decided.enabled,
    maxItems: decided.maxItems,
    windowSeconds: decided.windowSeconds,
  };
}

// ---------------------------------------------------------------------------
// Window computation
// ---------------------------------------------------------------------------

/** The maximum coverage a single briefing window may span (90 days). */
export const MAX_BRIEFING_WINDOW_SECONDS = 7_776_000;

/**
 * The default lower bound of a briefing's coverage window
 * (deterministic, total):
 *  * with a previous briefing — its window end (continuous coverage:
 *    no gaps, no overlaps), clamped to at most
 *    `MAX_BRIEFING_WINDOW_SECONDS` before `windowTo`;
 *  * without one — `windowTo − resolved cadence window` (the policy's
 *    windowSeconds, already clamped to the legal bounds by validation).
 *
 * Always strictly before `windowTo`; a caller passing a last-window-to
 * at/after `windowTo` falls back to the cadence window (a clock skew
 * between generations must never produce an empty window).
 */
export function briefingWindowFrom(
  lastWindowTo: string | null,
  windowTo: Date,
  cadenceSeconds: number,
): Date {
  const cadence = Math.min(
    Math.max(cadenceSeconds, 1),
    MAX_BRIEFING_WINDOW_SECONDS,
  );
  const fallback = new Date(windowTo.getTime() - cadence * 1_000);
  if (lastWindowTo === null) return fallback;
  const last = Date.parse(lastWindowTo);
  if (!Number.isFinite(last)) return fallback;
  const lastEnd = new Date(last);
  if (lastEnd.getTime() >= windowTo.getTime()) return fallback;
  const floor = new Date(windowTo.getTime() - MAX_BRIEFING_WINDOW_SECONDS * 1_000);
  return lastEnd.getTime() < floor.getTime() ? floor : lastEnd;
}

// ---------------------------------------------------------------------------
// Bounding (the honest item cap)
// ---------------------------------------------------------------------------

/** The result of applying a section's item cap to its candidate list. */
export interface BoundedItems {
  items: BriefingItem[];
  /** Candidates found BEFORE the cap applied (never silently truncated). */
  candidateCount: number;
}

/**
 * Apply the section's item cap: the first `maxItems` candidates become
 * items; the candidate count retains how many were found. Pure, total.
 */
export function boundCandidates(
  candidates: readonly BriefingItem[],
  maxItems: number,
): BoundedItems {
  const cap = Math.max(1, Math.floor(maxItems));
  return {
    items: candidates.slice(0, cap),
    candidateCount: candidates.length,
  };
}

// ---------------------------------------------------------------------------
// Composition (deterministic, bounded for the notifications contract)
// ---------------------------------------------------------------------------

/** Subject limit of the notifications contract (the push handoff). */
export const MAX_HEADLINE_LENGTH = 200;
/** Body limit of the notifications contract (the push handoff). */
export const MAX_BODY_LENGTH = 4_096;

/** Per-section excerpt lines in the composed body (bounded). */
export const BODY_SECTION_EXCERPTS = 3;

/** Input of `composeBriefingHeadline` / `composeBriefingBody`. */
export interface ComposeSection {
  sectionKind: BriefingSectionKind;
  enabled: boolean;
  itemCount: number;
  candidateCount: number;
  items: readonly { summary: string }[];
}

/**
 * The deterministic briefing headline (≤ 200 chars):
 * `Briefing — <on>/<total> sections, <items> items`.
 */
export function composeBriefingHeadline(sections: readonly ComposeSection[]): string {
  const total = sections.length;
  const on = sections.filter((section) => section.enabled).length;
  const items = sections.reduce((sum, section) => sum + section.itemCount, 0);
  return excerptText(`Briefing — ${on}/${total} sections, ${items} items`, MAX_HEADLINE_LENGTH);
}

/**
 * The deterministic briefing body (≤ 4096 chars) for the delivery
 * handoff: one status line per section (label, item count, candidate
 * count when the cap truncated) plus the first
 * `BODY_SECTION_EXCERPTS` item summaries per enabled section, each
 * indented. Sections are rendered in the canonical kind order the caller
 * supplies.
 */
export function composeBriefingBody(
  sections: readonly ComposeSection[],
  windowTo: string,
): string {
  const lines: string[] = [`As of ${windowTo}`];
  for (const section of sections) {
    if (!section.enabled) {
      lines.push(`${SECTION_LABELS[section.sectionKind]}: section disabled by policy`);
      continue;
    }
    const truncated =
      section.candidateCount > section.itemCount
        ? ` (of ${section.candidateCount} found)`
        : '';
    lines.push(`${SECTION_LABELS[section.sectionKind]}: ${section.itemCount} item(s)${truncated}`);
    for (const item of section.items.slice(0, BODY_SECTION_EXCERPTS)) {
      lines.push(`  - ${item.summary}`);
    }
  }
  return excerptText(lines.join('\n'), MAX_BODY_LENGTH);
}

// ---------------------------------------------------------------------------
// Excerpt helper
// ---------------------------------------------------------------------------

/** The ellipsis marking a bounded excerpt. */
export const EXCERPT_ELLIPSIS = '…';

/**
 * Bounded excerpt: at most `maxLength` characters, cut on a code-unit
 * boundary, suffixed with an ellipsis when (and only when) the source
 * was longer. Bounded management text + deep links to full records is
 * the honest shape for a derived briefing (lock 34).
 */
export function excerptText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const room = Math.max(1, maxLength - EXCERPT_ELLIPSIS.length);
  return `${text.slice(0, room)}${EXCERPT_ELLIPSIS}`;
}

// ---------------------------------------------------------------------------
// Scan limits (documented determinism for section compilation)
// ---------------------------------------------------------------------------

/**
 * How many of each dependency contract's records a section compiler
 * examines per generation. Every limit is the dependency's own list
 * limit where one exists (the honest maximum it will return in one
 * call); the execution scan is bounded because findings are read one
 * execution trace at a time. These are constants, not policy: they bound
 * work, while section policy (enabled/maxItems/windowSeconds) decides
 * what appears.
 */
export const SECTION_SCAN_LIMITS = {
  /** events.listEvents per changes section (the contract's max limit). */
  events: 500,
  /** goals.listGoals per goal-drift section (the contract's max limit). */
  goals: 500,
  /** epistemics.listUnknowns per unknowns section. */
  unknowns: 500,
  /** cognition.listExecutions scanned for findings sections. */
  executions: 50,
  /** capabilities.analyzeGaps per capability-gaps section. */
  gaps: 500,
  /** agents.listAgents per workforce-performance section. */
  agents: 500,
  /** agents.listAgentExecutions per agent (the contract's max limit). */
  agentExecutions: 500,
  /** actions.listActionRequests per approvals section. */
  approvals: 500,
} as const;

/** A delivery recipient's canonical display label (composition only). */
export function recipientLabel(recipient: BriefingRecipient): string {
  return recipient.displayName ?? recipient.providerAccountId;
}

/** Map a briefing policy source for read models (no-op guard for the CHECK vocabulary). */
export function isBriefingPolicySource(value: unknown): value is BriefingPolicySource {
  return value === 'tenant-default' || value === 'built-in';
}
