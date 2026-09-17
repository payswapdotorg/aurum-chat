// Management Control Tower (W033) — pure presentation helpers.
//
// No I/O, no React, no contracts: everything here is a total function of
// its arguments, so the tower's display rules are unit-testable in
// isolation (IMPLEMENTATION-STACK §7's unit-test doctrine applied to the
// UI surface).

/** Canonical display order shared by goals (priority) and missions (urgency). */
export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export type PriorityLike = (typeof PRIORITY_ORDER)[number];

/** 1 (most urgent) .. 4; unknown values sort last. */
export function priorityRank(value: string): number {
  const index = (PRIORITY_ORDER as readonly string[]).indexOf(value);
  return index === -1 ? PRIORITY_ORDER.length + 1 : index + 1;
}

/** 'manual_effort' → 'Manual Effort'; 'approval_required' → 'Approval Required'. */
export function titleCase(slug: string): string {
  return slug
    .split(/[_\s-]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** 'risk-opportunity-capability-analysis' → 'Risk Opportunity Capability Analysis'. */
export function titleCaseKebab(slug: string): string {
  return slug
    .split('-')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Bounded display string with an ellipsis marker. */
export function truncate(text: string, max: number): string {
  if (max < 1) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** ISO 8601 instant → '2026-09-14 09:15 UTC' (UTC, unambiguous). */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${date.getUTCDate()}`.padStart(2, '0');
  const hh = `${date.getUTCHours()}`.padStart(2, '0');
  const mm = `${date.getUTCMinutes()}`.padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

/** Integer minor units + ISO currency → '$123.45' / '€1,234.00' (best effort). */
export function formatMinorUnits(amount: number, currency: string): string {
  const major = amount / 100;
  const formatted = major.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency} `;
  return `${symbol}${formatted}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

/** 0.87 → '87%'; accepts [0,1] fractions (confidence/information value). */
export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 0.42 → '42%' (shares, like a process's manual share). */
export function formatShare(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Short bounded join: joinList(['a','b','c'], 2) → 'a, b, +1 more'. */
export function joinList(items: string[], max: number): string {
  if (items.length === 0) return '—';
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const joined = shown.join(', ');
  return rest > 0 ? `${joined}, +${rest} more` : joined;
}

/** A count that hit its read bound — displayed honestly as '500+'. */
export function formatCount(count: number, capped: boolean): string {
  return capped ? `${count}+` : `${count}`;
}

/** Compact duration for process stats: seconds → '2d 4h' / '3h 12m' / '45m' / '8s'. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
