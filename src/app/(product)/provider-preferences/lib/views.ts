// Provider choice (W091) — the view builder.
//
// Server-side composition of the provider-preferences module's CONTRACT
// only (the outcome layer over the llm gateway): the tenant's saved choice
// with its application state and plain mapping guidance, the frozen
// routing explanation of the latest AI task, the append-only change
// history, and — ONLY for holders of the technical authority claim — the
// advanced technical layer.
//
// Honesty rules (the ai/lib/views.ts discipline):
//   * a FAILING read renders an empty section plus a `degraded` note —
//     never fake emptiness, never a crash;
//   * the default-surface fields are jargon-free by construction (the
//     module's own plain-language layer); technical vocabulary rides the
//     authorized `advanced` branch only;
//   * principal ids never render as content — the view drops `updatedBy`.
//
// Tenancy (ADR-0001): the builder takes the EXPLICIT TenantContext;
// another tenant's profiles, mappings, events, executions and accounts are
// indistinguishable from missing ones (the contract's own uniform
// not-found — no existence leak).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  DEFAULT_PREFERENCE,
  explainRoutingDecision,
  getProviderPreferenceProfile,
  getTechnicalLayerView,
  listPreferenceChangeEvents,
} from '@/modules/provider-preferences/contract';
import type {
  PreferenceAssignment,
  ProviderPreferenceKind,
  RoutingDecisionExplanation,
  TechnicalLayerView,
} from '@/modules/provider-preferences/contract';
import { eventLabel } from './labels';

// ---------------------------------------------------------------------------
// Row shapes (serialized server → page/client; labels resolve at render)
// ---------------------------------------------------------------------------

/** How many change events the history renders (the audit stays complete). */
export const HISTORY_ROW_LIMIT = 20;

/** One change-history row, pre-labeled for the default surface. */
export interface PreferenceHistoryRow {
  event: string;
  eventLabel: string;
  summary: string;
  /** ISO 8601 — when the change happened. */
  occurredAt: string;
  /** True for technical-override events (summary stays in the advanced view). */
  technical: boolean;
}

/** The /provider-preferences page's whole view (one build, degraded-safe). */
export interface ProviderPreferencesView {
  generatedAt: string;
  /** True when the session's authority carries 'llm:administer'. */
  canAdminister: boolean;
  // The preference profile (default-surface fields, plain language only).
  preference: ProviderPreferenceKind;
  saved: boolean;
  note: string | null;
  /** ISO 8601 — when the choice was last saved (null = never). */
  updatedAt: string | null;
  appliedPreference: ProviderPreferenceKind | null;
  /** ISO 8601 — when the applied preference was last written to routing. */
  appliedAt: string | null;
  pendingApplication: boolean;
  mappings: PreferenceAssignment[];
  mappingNotes: string[];
  changeEventCount: number;
  // The explanation surface (null = the read degraded).
  explanation: RoutingDecisionExplanation | null;
  // The change history, newest first.
  history: PreferenceHistoryRow[];
  // The technical layer — null for members AND for degraded admin reads.
  advanced: TechnicalLayerView | null;
  /** Which read families failed (honest degradation, never silence). */
  degraded: string[];
}

export type { TechnicalAccountRow, TechnicalLayerView } from '@/modules/provider-preferences/contract';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One bounded failed read → an empty section + a degraded note. */
async function safe<T>(
  family: string,
  degraded: string[],
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildProviderPreferencesView
// ---------------------------------------------------------------------------

/**
 * Build the whole provider-choice view for one tenant: the preference
 * profile (or the honest default), the latest routing explanation, the
 * change history, and the technical layer when the session may administer
 * it. Members never trigger the technical read at all.
 */
export async function buildProviderPreferencesView(
  ctx: TenantContext,
): Promise<ProviderPreferencesView> {
  const degraded: string[] = [];
  const canAdminister = ctx.authority.includes('llm:administer');

  const [profileRead, eventsRead, explanation] = await Promise.all([
    safe('profile', degraded, () => getProviderPreferenceProfile(ctx)),
    safe('events', degraded, () => listPreferenceChangeEvents(ctx, { limit: HISTORY_ROW_LIMIT })),
    safe('explanation', degraded, () => explainRoutingDecision(ctx, {})),
  ]);

  // The technical layer is read ONLY for authorized sessions; a failed
  // read degrades to the plain "ask an administrator" state (no technical
  // data whatsoever) plus a degraded note.
  const advanced = canAdminister
    ? await safe('advanced-settings', degraded, () => getTechnicalLayerView(ctx))
    : null;

  const profile = profileRead ?? {
    preference: DEFAULT_PREFERENCE,
    saved: false,
    note: null,
    updatedAt: null,
    appliedPreference: null,
    appliedAt: null,
    pendingApplication: false,
    mappings: [] as PreferenceAssignment[],
    mappingNotes: [] as string[],
    changeEventCount: 0,
  };

  return {
    generatedAt: now().toISOString(),
    canAdminister,
    preference: profile.preference,
    saved: profile.saved,
    note: profile.note,
    updatedAt: profile.updatedAt,
    appliedPreference: profile.appliedPreference,
    appliedAt: profile.appliedAt,
    pendingApplication: profile.pendingApplication,
    mappings: profile.mappings,
    mappingNotes: profile.mappingNotes,
    changeEventCount: profile.changeEventCount,
    explanation,
    history: (eventsRead ?? []).map((event) => ({
      event: event.event,
      eventLabel: eventLabel(event.event),
      summary: event.summary,
      occurredAt: event.occurredAt,
      technical: event.event === 'technical-override',
    })),
    advanced,
    degraded: [...new Set(degraded)],
  };
}
