// Evidence, audit & explainability (W065) — the pure label layer.
//
// Every display decision of the causal evidence view that does NOT need a
// database read lives here as a pure function: freshness/reliability
// labeling, tone mapping for status pills, compact time/age/latency
// formats, JSON payload summaries, contradiction weighing labels, and the
// causal rail's step vocabulary. Unit tests cover this module directly;
// the view builders (views.ts) stay thin composition over contracts.
//
// HONESTY RULES (frozen): color never carries meaning alone (every pill
// pairs a tone with a label — W057's StatusPill contract); an absent
// chain link is stated, never hidden; uuids are addresses, not content —
// every row leads with human text (plan §8 gate 10).

import type { PillTone } from '../../lib/states';

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Flatten whitespace and cap length with an ellipsis (quiet rows). */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** A short human summary of an observation/step payload (JSON, any shape). */
export function payloadSummary(payload: unknown, max = 160): string {
  if (payload === null || payload === undefined) return '—';
  if (typeof payload === 'string') return clip(payload, max);
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  try {
    return clip(JSON.stringify(payload), max);
  } catch {
    return '(unserializable payload)';
  }
}

/** Confidence 0..1 as a legible percent. */
export function percent(value: number): string {
  return `${(Math.round(value * 100)).toFixed(0)}%`;
}

/** Humanize a slug ('employee-messaging' → 'Employee messaging'). */
export function slugLabel(slug: string): string {
  const words = slug
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length === 0 ? slug : words.join(' ');
}

/** The one-sentence hint of a causal stage (foreign values get the input hint). */
export function causalHint(stage: string): string {
  return CAUSAL_STEP_HINTS[stage as CausalStage] ?? CAUSAL_STEP_HINTS.input;
}

// ---------------------------------------------------------------------------
// Time formatting (deterministic, UTC-stable — suppressHydrationWarning at render)
// ---------------------------------------------------------------------------

/** e.g. 'Oct 3, 2026' */
export function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** e.g. 'Oct 3, 14:05 UTC' */
export function dateTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString('en', { month: 'short', day: 'numeric' })}, ${date
    .toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC`;
}

/** A duration in seconds as a compact human span. */
export function spanLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Evidence age (seconds) as a compact human span. */
export function ageLabel(ageSeconds: number | null): string {
  return ageSeconds === null ? 'no evidence yet' : `${spanLabel(ageSeconds)} old`;
}

// ---------------------------------------------------------------------------
// Freshness & source reliability (W006 vocabulary → tones + labels)
// ---------------------------------------------------------------------------

export type FreshnessStatus = 'current' | 'aging' | 'stale' | 'unknown';

/** Coerce a contract freshness status into the labeled vocabulary (unknown on foreign values). */
export function asFreshnessStatus(value: string): FreshnessStatus {
  return value === 'current' || value === 'aging' || value === 'stale'
    ? value
    : 'unknown';
}

/** Tone for a freshness classification (restrained: stale is a warning-family signal). */
export function freshnessTone(status: FreshnessStatus): PillTone {
  if (status === 'current') return 'positive';
  if (status === 'aging') return 'warning';
  if (status === 'stale') return 'error';
  return 'neutral';
}

/** Label for a freshness classification (never color alone). */
export function freshnessLabel(status: FreshnessStatus): string {
  if (status === 'current') return 'Current';
  if (status === 'aging') return 'Aging';
  if (status === 'stale') return 'Stale';
  return 'Freshness unknown';
}

/** Tone for a source's connection status (the reliability half of the signal). */
export function sourceStatusTone(status: string): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}

/** Label for a source's connection status. */
export function sourceStatusLabel(status: string): string {
  return status === 'active' ? 'Connected' : 'Disconnected';
}

// ---------------------------------------------------------------------------
// Execution / gate / approval vocabulary → tones + labels
// ---------------------------------------------------------------------------

/** Tone for a cognitive execution state. */
export function executionStateTone(state: string): PillTone {
  if (state === 'completed') return 'positive';
  if (state === 'awaiting_approval') return 'warning';
  if (state === 'awaiting_input') return 'warning';
  if (state === 'abandoned') return 'neutral';
  return 'info'; // running
}

/** Human label for an execution state. */
export function executionStateLabel(state: string): string {
  const map: Record<string, string> = {
    running: 'Running',
    awaiting_input: 'Suspended — awaiting input',
    awaiting_approval: 'Suspended — awaiting approval',
    completed: 'Completed',
    abandoned: 'Abandoned',
  };
  return map[state] ?? state;
}

/** Tone for an action request status. */
export function requestStatusTone(status: string): PillTone {
  if (status === 'approved') return 'positive';
  if (status === 'rejected') return 'error';
  return 'warning'; // pending
}

/** Human label for an action request status. */
export function requestStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: 'Pending decision',
    approved: 'Approved',
    rejected: 'Rejected',
  };
  return map[status] ?? status;
}

/** Tone for the authority gate outcome. */
export function gateTone(outcome: string): PillTone {
  if (outcome === 'allowed') return 'positive';
  if (outcome === 'forbidden') return 'error';
  return 'warning'; // approval_required
}

/** Human label for the authority gate outcome. */
export function gateLabel(outcome: string): string {
  const map: Record<string, string> = {
    allowed: 'Allowed by policy',
    approval_required: 'Required human approval',
    forbidden: 'Forbidden by policy',
  };
  return map[outcome] ?? outcome;
}

/** Tone for a contradiction's status (open conflict is a warning, never an error). */
export function contradictionTone(status: string): PillTone {
  return status === 'resolved' ? 'positive' : 'warning';
}

/** Human label for a contradiction's status. */
export function contradictionLabel(status: string): string {
  return status === 'resolved' ? 'Weighed — resolved' : 'Retained conflict';
}

/** Human label for a belief's status. */
export function beliefStatusLabel(status: string): string {
  const map: Record<string, string> = {
    active: 'Current understanding',
    retired: 'Retired',
    superseded: 'Superseded',
  };
  return map[status] ?? status;
}

/** Tone for a belief's status. */
export function beliefStatusTone(status: string): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}

// ---------------------------------------------------------------------------
// The causal rail (§24's frozen chain — the view's spine)
// ---------------------------------------------------------------------------

/**
 * The causal chain steps in §24 order, each with its human label — the
 * rail the decision view walks top to bottom. The vocabulary mirrors the
 * audit contract's CHAIN_STAGES one-for-one (input … learning) with the
 * product's wording; the ordering is frozen by ARCHITECTURE.md §24.
 */
export const CAUSAL_STEPS = [
  { stage: 'input', label: 'Input' },
  { stage: 'evidence', label: 'Evidence' },
  { stage: 'claims-beliefs', label: 'Claims & beliefs' },
  { stage: 'unknown-mission', label: 'Unknown & mission' },
  { stage: 'policy', label: 'Policy' },
  { stage: 'model-provider', label: 'Model & provider' },
  { stage: 'recommendation', label: 'Recommendation' },
  { stage: 'approval', label: 'Approval' },
  { stage: 'execution', label: 'Execution' },
  { stage: 'result', label: 'Result' },
  { stage: 'outcome', label: 'Outcome' },
  { stage: 'learning', label: 'Learning' },
] as const;

export type CausalStage = (typeof CAUSAL_STEPS)[number]['stage'];

/** The human label of a causal stage (§24 vocabulary, foreign values pass through). */
export function causalLabel(stage: string): string {
  return CAUSAL_STEPS.find((step) => step.stage === stage)?.label ?? stage;
}

/** One-sentence "what this link is" for each causal step (progressive disclosure). */
export const CAUSAL_STEP_HINTS: Record<CausalStage, string> = {
  input: 'What started this decision — the trigger and, when one exists, the observation behind it.',
  evidence:
    'The immutable observations the decision rests on, with each source\u2019s reliability and freshness.',
  'claims-beliefs':
    'What was derived from the evidence (claims) and the versioned working understanding (beliefs) that weighed them.',
  'unknown-mission':
    'What was not known, the consequence of not knowing it, and the learning mission launched to close the gap.',
  policy: 'Which authority rules governed the decision, and how the gate evaluated the proposed action.',
  'model-provider':
    'Which providers and models extracted the evidence — AI output is evidence with lineage, never authority.',
  recommendation: 'The consequential action Aurum proposed, with its justification.',
  approval: 'Who decided — the append-only trail of policy and human decisions.',
  execution: 'The decision cycle(s) that carried the decision, and how far each ran.',
  result: 'What the authority gate produced: allowed, forbidden, or a human decision.',
  outcome: 'What the cycle recorded as its result.',
  learning: 'What was durably learned — evidence-backed organizational memory.',
};
