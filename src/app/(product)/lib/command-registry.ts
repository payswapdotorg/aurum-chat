// Product shell (W057) — the command-search registry and its pure logic.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Global": "Cmd/Ctrl+K command search"
// across all major product areas, the fifteen management-mode surfaces and
// the chat discovery starters. The registry is built from the SAME
// navigation registry the rail and bottom nav render, so every area is
// discoverable from the keyboard exactly once — there is no second list to
// drift. Filtering and keyboard math are pure and unit-tested; the dialog
// component only renders the results.

import { CHAT_STARTERS } from './chat-starters';
import type { ChatStarter } from './chat-starters';
import { PRODUCT_AREAS, towerSurfaceLinks } from './navigation';
import type { ShellIcon } from './navigation';

/**
 * The marketplace area's keyboard destinations (W064). The area's hub
 * is already a PRODUCT_AREAS command; these are its three working
 * surfaces, so Cmd/Ctrl+K reaches them without a second registry.
 */
export const MARKETPLACE_DESTINATIONS: readonly {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
}[] = [
  {
    id: 'browse',
    title: 'Marketplace — browse',
    subtitle: 'The governed catalog: extensions and agent packages',
    href: '/marketplace',
    keywords: ['marketplace', 'catalog', 'extensions', 'packages', 'install'],
  },
  {
    id: 'installed',
    title: 'Marketplace — installed',
    subtitle: 'Govern what your company runs: activate, suspend, rollback',
    href: '/marketplace/installed',
    keywords: ['marketplace', 'installed', 'extensions', 'govern', 'rollback', 'suspend'],
  },
  {
    id: 'developer',
    title: 'Marketplace — developer',
    subtitle: 'Build extensions, publish packages, review submissions',
    href: '/marketplace/developer',
    keywords: ['marketplace', 'developer', 'builder', 'publish', 'review', 'submit'],
  },
];

/**
 * The intelligence area's keyboard destinations (W061). The area hub is
 * already a PRODUCT_AREAS command; the Today briefing is the workflow's
 * primary surface, so Cmd/Ctrl+K reaches it by name ("today", "briefing",
 * "findings") without a second navigation list.
 */
export const INTELLIGENCE_DESTINATIONS: readonly {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
}[] = [
  {
    id: 'briefing',
    title: 'Intelligence — Today’s briefing',
    subtitle: 'What Aurum found on its own: severity, why it matters, what’s next',
    href: '/intelligence',
    keywords: [
      'today',
      'briefing',
      'findings',
      'proactive',
      'attention',
      'intelligence',
      'chain',
      'goals',
      'unknowns',
      'missions',
      'risks',
      'opportunities',
    ],
  },
];

/** What a command does: navigate somewhere, or run a shell action. */
export type ShellCommandTarget =
  | { kind: 'navigate'; href: string }
  | { kind: 'open-notifications' };

export interface ShellCommand {
  id: string;
  title: string;
  subtitle: string;
  group: 'Navigate' | 'Ask Aurum' | 'Management' | 'Actions';
  icon: ShellIcon;
  keywords: string[];
  target: ShellCommandTarget;
}

/**
 * Every command in the shell. The scope query (`?tenant=...`, from
 * `scopeFromSearch`) is appended to navigate targets at USE time so the
 * command list itself stays independent of the current URL.
 */
export function buildShellCommands(): ShellCommand[] {
  const commands: ShellCommand[] = [];

  for (const area of PRODUCT_AREAS) {
    commands.push({
      id: `area:${area.id}`,
      title: area.label,
      subtitle: area.tagline,
      group: 'Navigate',
      icon: area.icon,
      keywords: [area.id, 'go', 'open', ...(area.mode === 'management' ? ['tower', 'management'] : [])],
      target: { kind: 'navigate', href: area.href },
    });
  }

  // W064 — the marketplace area's own destinations (the same registry
  // the rail and bottom nav build on; added here so the marketplace
  // surfaces are keyboard-discoverable exactly once each).
  for (const destination of MARKETPLACE_DESTINATIONS) {
    commands.push({
      id: `marketplace:${destination.id}`,
      title: destination.title,
      subtitle: destination.subtitle,
      group: 'Navigate',
      icon: 'marketplace',
      keywords: destination.keywords,
      target: { kind: 'navigate', href: destination.href },
    });
  }

  // W061 — the intelligence area's Today briefing destination (the
  // product-mode discovery workflow; keyboard-reachable by name).
  for (const destination of INTELLIGENCE_DESTINATIONS) {
    commands.push({
      id: `intelligence:${destination.id}`,
      title: destination.title,
      subtitle: destination.subtitle,
      group: 'Navigate',
      icon: 'intelligence',
      keywords: destination.keywords,
      target: { kind: 'navigate', href: destination.href },
    });
  }

  for (const starter of CHAT_STARTERS) {
    commands.push({
      id: `starter:${starter.id}`,
      title: starter.question,
      subtitle: starter.hint,
      group: 'Ask Aurum',
      icon: 'spark',
      keywords: ['ask', 'chat', 'question', starter.id],
      target: { kind: 'navigate', href: starter.href },
    });
  }

  for (const link of towerSurfaceLinks()) {
    commands.push({
      id: `tower:${link.surface}`,
      title: link.label,
      subtitle: `${link.tagline} — management mode`,
      group: 'Management',
      icon: 'tower',
      keywords: ['management', 'tower', link.surface, link.group.toLowerCase()],
      target: { kind: 'navigate', href: link.href },
    });
  }

  commands.push({
    id: 'action:notifications',
    title: 'Open notifications',
    subtitle: 'The attention inbox: urgent and escalation deliveries',
    group: 'Actions',
    icon: 'bell',
    keywords: ['attention', 'inbox', 'urgent', 'escalation', 'bell'],
    target: { kind: 'open-notifications' },
  });

  commands.push({
    id: 'action:keyboard',
    title: 'Keyboard reference',
    subtitle: 'Shortcuts and accessibility behavior of this shell',
    group: 'Actions',
    icon: 'keyboard',
    keywords: ['shortcuts', 'accessibility', 'a11y', 'help'],
    target: { kind: 'navigate', href: '/more#keyboard' },
  });

  return commands;
}

/** Lowest score wins; 0 = not a match. */
export function scoreCommand(command: ShellCommand, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 1; // empty query: everything matches, registry order
  const title = command.title.toLowerCase();
  if (title === q) return 2;
  if (title.startsWith(q)) return 3;
  const haystacks = [title, command.subtitle.toLowerCase(), ...command.keywords];
  for (const hay of haystacks) {
    if (hay.startsWith(q)) return 4;
  }
  for (const hay of haystacks) {
    if (hay.includes(q)) return 5;
  }
  // Word-start matching inside the title ("needs attention" → "na"? no —
  // only whole word prefixes, so "att" matches "What needs my attention?".
  const words = title.split(/\s+/);
  for (const word of words) {
    if (word.startsWith(q)) return 4;
  }
  return 0;
}

export interface ScoredCommand {
  command: ShellCommand;
  score: number;
}

/** Filter + rank the registry for a query (stable within equal scores). */
export function filterShellCommands(
  commands: ShellCommand[],
  query: string,
): ScoredCommand[] {
  const scored: ScoredCommand[] = [];
  for (const command of commands) {
    const score = scoreCommand(command, query);
    if (score > 0) scored.push({ command, score });
  }
  // Stable sort: equal scores keep registry order.
  return scored.sort((a, b) => a.score - b.score);
}

export type SelectionMove = 'first' | 'last' | 'next' | 'prev' | 'none';

/**
 * Roving-selection math for the keyboard traversal (ArrowUp/ArrowDown,
 * Home/End), with wrap-around at both ends. `current` is null when nothing
 * is selected (the dialog then picks first for 'next', last for 'prev').
 */
export function nextCommandIndex(
  current: number | null,
  count: number,
  move: SelectionMove,
): number | null {
  if (count <= 0) return null;
  switch (move) {
    case 'none':
      return current;
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return current === null ? 0 : (current + 1) % count;
    case 'prev':
      return current === null ? count - 1 : (current - 1 + count) % count;
  }
}

/** Append the preserved scope query to a navigate target's href. */
export function commandHref(command: ShellCommand, scopeQuery: string): string {
  if (command.target.kind !== 'navigate') return '';
  const href = command.target.href;
  if (scopeQuery === '') return href;
  const suffix = href.includes('?') ? `&${scopeQuery.slice(1)}` : scopeQuery;
  const hashIndex = href.indexOf('#');
  if (hashIndex === -1) return `${href}${suffix}`;
  const path = href.slice(0, hashIndex);
  const hash = href.slice(hashIndex);
  return `${path}${suffix}${hash}`;
}

/** The starter behind a command, when the command is a starter. */
export function starterOfCommand(
  command: ShellCommand,
  starters: readonly ChatStarter[],
): ChatStarter | null {
  if (!command.id.startsWith('starter:')) return null;
  const id = command.id.slice('starter:'.length);
  return starters.find((starter) => starter.id === id) ?? null;
}
