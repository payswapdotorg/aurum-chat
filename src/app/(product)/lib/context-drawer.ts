// Product shell (W057) — the context drawer's content model.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Canonical product shell": "optional
// right context drawer: evidence, why, related goal, mission, policy,
// approval/outcome". The drawer is a shell-level SYSTEM: surfaces (the
// notification entry today; chat cards and intelligence findings from
// W060/W061 on) hand a normalized payload to the shell, and the shell owns
// the presentation — right side panel on desktop, bottom sheet on mobile,
// with focus trapping and Escape handling. This module holds the pure
// model: the payload shape, its normalization guard and the open/close
// reducer, all unit-tested without a DOM.

import type { PillTone } from './states';

/** The canonical section kinds (the plan's drawer contents, plus `detail`). */
export type ContextSectionKind =
  | 'summary'
  | 'evidence'
  | 'why'
  | 'related-goal'
  | 'mission'
  | 'policy'
  | 'approval'
  | 'outcome'
  | 'detail';

/** One drawer section: a kind, a heading override, lines and optional links. */
export interface ContextSection {
  kind: ContextSectionKind;
  title: string;
  lines: string[];
  links: { label: string; href: string }[];
}

/** What a surface hands the shell to open the drawer. */
export interface ContextDrawerPayload {
  title: string;
  subtitle: string | null;
  tone: PillTone | null;
  sections: ContextSection[];
  /** Where the payload came from (rendered small at the bottom). */
  source: string | null;
}

export type ContextDrawerState =
  | { open: false }
  | { open: true; payload: ContextDrawerPayload };

export type ContextDrawerAction =
  | { type: 'open'; payload: ContextDrawerPayload }
  | { type: 'close' };

export function contextDrawerReducer(
  state: ContextDrawerState,
  action: ContextDrawerAction,
): ContextDrawerState {
  switch (action.type) {
    case 'open':
      return { open: true, payload: action.payload };
    case 'close':
      return { open: false };
  }
}

/** The default heading for a section kind (used when `title` is empty). */
export function sectionHeading(kind: ContextSectionKind): string {
  switch (kind) {
    case 'summary':
      return 'Summary';
    case 'evidence':
      return 'Evidence';
    case 'why':
      return 'Why this matters';
    case 'related-goal':
      return 'Related goal';
    case 'mission':
      return 'Learning mission';
    case 'policy':
      return 'Policy';
    case 'approval':
      return 'Approval';
    case 'outcome':
      return 'Outcome';
    case 'detail':
      return 'Details';
  }
}

function normalizeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed !== '') out.push(trimmed);
    }
  }
  return out;
}

function normalizeLinks(value: unknown): { label: string; href: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { label: string; href: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record['label'] === 'string' ? record['label'].trim() : '';
    const href = typeof record['href'] === 'string' ? record['href'].trim() : '';
    if (label !== '' && href !== '' && href.startsWith('/')) {
      out.push({ label, href });
    }
  }
  return out;
}

const SECTION_KINDS: readonly ContextSectionKind[] = [
  'summary',
  'evidence',
  'why',
  'related-goal',
  'mission',
  'policy',
  'approval',
  'outcome',
  'detail',
];

const TONES: readonly PillTone[] = [
  'positive',
  'warning',
  'error',
  'neutral',
  'info',
];

function normalizeSection(value: unknown): ContextSection | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !SECTION_KINDS.includes(kind as ContextSectionKind)) {
    return null;
  }
  const lines = normalizeLines(record['lines']);
  const links = normalizeLinks(record['links']);
  if (lines.length === 0 && links.length === 0) return null;
  const title =
    typeof record['title'] === 'string' && record['title'].trim() !== ''
      ? record['title'].trim()
      : sectionHeading(kind as ContextSectionKind);
  return { kind: kind as ContextSectionKind, title, lines, links };
}

/**
 * Normalize arbitrary input into a drawer payload, or null when the input
 * is not usable (no title, or no surviving sections). The shell's public
 * `openContext` runs every caller's input through this guard, so a
 * malformed payload can never break the drawer.
 */
export function normalizeContextPayload(input: unknown): ContextDrawerPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
  if (title === '') return null;
  const sections: ContextSection[] = [];
  if (Array.isArray(record['sections'])) {
    for (const entry of record['sections']) {
      const section = normalizeSection(entry);
      if (section !== null) sections.push(section);
    }
  }
  if (sections.length === 0) return null;
  const subtitle =
    typeof record['subtitle'] === 'string' && record['subtitle'].trim() !== ''
      ? record['subtitle'].trim()
      : null;
  const toneRaw = record['tone'];
  const tone =
    typeof toneRaw === 'string' && TONES.includes(toneRaw as PillTone)
      ? (toneRaw as PillTone)
      : null;
  const source =
    typeof record['source'] === 'string' && record['source'].trim() !== ''
      ? record['source'].trim()
      : null;
  return { title, subtitle, tone, sections, source };
}
