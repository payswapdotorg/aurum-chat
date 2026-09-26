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
import { capabilityEntries, capabilityEntry } from './capability-hub';

// W075 — TASK LANGUAGE: the destination commands below say what the
// user wants to DO, not which module implements it (plan §4: "no
// capability should require a user to know Aurum's internal module
// names"). The labels and task keywords are derived from the capability
// hub registry (lib/capability-hub.ts) so the command search, the More
// hub and the contextual prompts share one intent source. Internal
// module words ("marketplace", "BYOA", "MCP") live on as KEYWORDS —
// they are search terms, not labels.

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
    title: 'Find a capability to install',
    subtitle: 'The governed catalog: extensions and agent packages',
    href: '/marketplace',
    keywords: [
      'marketplace',
      'catalog',
      'extensions',
      'packages',
      'install',
      'apps',
      'capability',
      'capabilities',
      'browse',
      'find',
      'add',
    ],
  },
  {
    id: 'installed',
    title: 'Review what you’ve installed',
    subtitle: 'Govern what your company runs: activate, suspend, rollback',
    href: '/marketplace/installed',
    keywords: ['marketplace', 'installed', 'extensions', 'govern', 'rollback', 'suspend', 'review'],
  },
  {
    id: 'developer',
    title: 'Build and publish a package',
    subtitle: 'Build extensions, publish packages, review submissions',
    href: '/marketplace/developer',
    keywords: ['marketplace', 'developer', 'builder', 'publish', 'review', 'submit', 'build', 'package'],
  },
  {
    // W092 — the Vertical Kits surface (an additive keyboard destination
    // of the marketplace area beside its three working surfaces).
    id: 'vertical-kits',
    title: 'Set up an industry starter kit',
    subtitle: 'Vertical starter kits: scoped bundles, removable and auditable',
    href: '/vertical-kits',
    keywords: ['vertical', 'kits', 'industry', 'starter', 'bundle', 'system of record', 'setup'],
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
    title: 'Read today’s briefing',
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
      'read',
    ],
  },
];

/**
 * The learning surface's keyboard destination (W062): knowledge
 * requests, contributions and rewards — the employee learning journey
 * (plan §2 Journey F), keyboard-reachable by name.
 */
export const LEARNING_DESTINATIONS: readonly {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
}[] = [
  {
    id: 'learning',
    title: 'Answer a question Aurum asked you',
    subtitle:
      'Answer Aurum’s targeted questions; see contribution acknowledgement and reward status',
    href: '/learning',
    keywords: [
      'learning',
      'missions',
      'knowledge',
      'questions',
      'requests',
      'answer',
      'ask',
      'contribution',
      'contributions',
      'acknowledgement',
      'rewards',
      'evidence',
    ],
  },
];

/**
 * The interventions surface's keyboard destinations (W063): capability
 * gaps, acquisition alternatives and the agent/workforce lifecycle —
 * the intervention journey (plan §2 Journey I), keyboard-reachable by
 * name.
 */
export const INTERVENTION_DESTINATIONS: readonly {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
}[] = [
  {
    id: 'interventions',
    title: 'Fix a capability gap — train, hire, automate or recruit',
    subtitle:
      'Compare train/reassign/hire/automate/recruit/install/outsource; decide proposals, activate agents and teams, track outcomes',
    href: '/interventions',
    keywords: [
      'interventions',
      'intervention',
      'capability',
      'capabilities',
      'gaps',
      'alternatives',
      'compare',
      'train',
      'reassign',
      'hire',
      'automate',
      'recruit',
      'install',
      'outsource',
      'proposal',
      'proposals',
      'approval',
      'approve',
      'activation',
      'activate',
      'agents',
      'agent',
      'teams',
      'team',
      'topology',
      'budget',
      'workforce',
      'lifecycle',
      'retain',
      'modify',
      'terminate',
      'termination',
      'outcomes',
      'automation',
    ],
  },
];

/**
 * The AI-providers surface's keyboard destination (W066): BYOA accounts,
 * model availability, routing policy, cost/latency and hot-swap
 * verification (plan §2 Journey H), keyboard-reachable by name.
 */
export const AI_DESTINATIONS: readonly {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
}[] = [
  {
    id: 'byoa',
    title: 'Add your own AI provider',
    subtitle:
      'Your own AI accounts: add, verify, revoke; availability, policy, cost, latency, provider swap proof',
    href: '/ai',
    keywords: [
      'ai',
      'byoa',
      'provider',
      'providers',
      'llm',
      'model',
      'models',
      'routing',
      'priority',
      'budget',
      'availability',
      'cost',
      'latency',
      'hot-swap',
      'hotswap',
      'swap',
      'keys',
      'add',
      'connect',
      'account',
      'accounts',
      'no model',
      'no suitable model',
    ],
  },
];

/**
/**
 * The evidence/audit surface's keyboard destination (W065): the causal
 * evidence view — reconstruct any consequential answer or decision
 * (input → evidence → belief → mission → policy → approval → execution →
 * outcome → learning), plan §2 Journey K, keyboard-reachable by name.
 */
export const EVIDENCE_DESTINATIONS: readonly {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
}[] = [
  {
    id: 'explain',
    title: 'Explain a decision',
    subtitle:
      'Reconstruct any consequential answer or decision: sources, conflicts, policy, approvals, outcomes and learning',
    href: '/explain',
    keywords: [
      'evidence',
      'audit',
      'explain',
      'explainability',
      'why',
      'reconstruct',
      'reconstruction',
      'decision',
      'decisions',
      'chain',
      'causal',
      'provenance',
      'sources',
      'freshness',
      'reliability',
      'contradiction',
      'contradictions',
      'conflict',
      'policy',
      'approval',
      'approvals',
      'execution',
      'outcome',
      'outcomes',
      'learning',
      'trail',
      'accountability',
      'show me why',
    ],
  },
];

/**
 * The developer console's keyboard destinations (W067): API keys and
 * scopes, webhooks, MCP connection instructions and the integration
 * event feed (plan §2 Journey L), keyboard-reachable by name — the
 * platform-tool half of the More page's promise, now delivered.
 */
export const DEVELOPER_DESTINATIONS: readonly {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
}[] = [
  {
    id: 'console',
    title: 'Integrate Aurum — API, webhooks, MCP',
    subtitle:
      'Create, rotate and revoke API keys; inspect scopes; manage webhooks and delivery evidence; connect over MCP',
    href: '/developer',
    keywords: [
      'developer',
      'api',
      'keys',
      'key',
      'scopes',
      'scope',
      'webhook',
      'webhooks',
      'mcp',
      'model',
      'context',
      'protocol',
      'integration',
      'integrate',
      'console',
      'rotate',
      'revoke',
      'bearer',
      'token',
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
 * W075 — task keywords from the capability hub: a user typing a TASK
 * ("whatsapp", "invite", "integrate") into the command search finds the
 * area that does it, without knowing the area's name. The merge happens
 * ONLY for areas with no more-specific destination command on the same
 * href — the task language for /intelligence and /marketplace lives on
 * their own destination commands, so the specific surface keeps its rank.
 */
function hubKeywords(href: string, specificHrefs: ReadonlySet<string>): string[] {
  if (specificHrefs.has(href)) return [];
  const entry = capabilityEntries().find((candidate) => candidate.href === href);
  return entry === undefined ? [] : entry.keywords;
}

/**
 * Every command in the shell. The scope query (`?tenant=...`, from
 * `scopeFromSearch`) is appended to navigate targets at USE time so the
 * command list itself stays independent of the current URL.
 */
export function buildShellCommands(): ShellCommand[] {
  const commands: ShellCommand[] = [];

  // Hrefs that already carry a dedicated, more-specific command (the
  // working-surface destinations, the tower surfaces, the account
  // entry). Area commands whose href is in this set keep their plain
  // area keywords — the specific command owns the task language.
  const specificHrefs = new Set<string>([
    ...MARKETPLACE_DESTINATIONS.map((destination) => destination.href),
    ...INTELLIGENCE_DESTINATIONS.map((destination) => destination.href),
    ...LEARNING_DESTINATIONS.map((destination) => destination.href),
    ...EVIDENCE_DESTINATIONS.map((destination) => destination.href),
    ...INTERVENTION_DESTINATIONS.map((destination) => destination.href),
    ...AI_DESTINATIONS.map((destination) => destination.href),
    ...DEVELOPER_DESTINATIONS.map((destination) => destination.href),
    ...towerSurfaceLinks().map((link) => link.href),
    capabilityEntry('company').href,
  ]);

  for (const area of PRODUCT_AREAS) {
    commands.push({
      id: `area:${area.id}`,
      title: area.label,
      subtitle: area.tagline,
      group: 'Navigate',
      icon: area.icon,
      keywords: [
        area.id,
        'go',
        'open',
        ...hubKeywords(area.href, specificHrefs),
        ...(area.mode === 'management' ? ['tower', 'management'] : []),
      ],
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

  // W062 — the learning surface's destination (knowledge requests,
  // contributions and rewards; keyboard-reachable by name).
  for (const destination of LEARNING_DESTINATIONS) {
    commands.push({
      id: `learning:${destination.id}`,
      title: destination.title,
      subtitle: destination.subtitle,
      group: 'Navigate',
      icon: 'people',
      keywords: destination.keywords,
      target: { kind: 'navigate', href: destination.href },
    });
  }

  // W065 — the evidence/audit surface's destination (the causal
  // explainability view; keyboard-reachable by name).
  for (const destination of EVIDENCE_DESTINATIONS) {
    commands.push({
      id: `evidence:${destination.id}`,
      title: destination.title,
      subtitle: destination.subtitle,
      group: 'Navigate',
      icon: 'tower',
      keywords: destination.keywords,
      target: { kind: 'navigate', href: destination.href },
    });
  }

  // W063 — the interventions surface's destination (capability gaps,
  // acquisition alternatives and the agent/workforce lifecycle;
  // keyboard-reachable by name).
  for (const destination of INTERVENTION_DESTINATIONS) {
    commands.push({
      id: `interventions:${destination.id}`,
      title: destination.title,
      subtitle: destination.subtitle,
      group: 'Navigate',
      icon: 'people',
      keywords: destination.keywords,
      target: { kind: 'navigate', href: destination.href },
    });
  }

  // W066 — the AI-providers destination (BYOA accounts, routing, cost,
  // hot-swap; keyboard-reachable by name — the platform-tool half of the
  // More page's promise, now delivered).
  for (const destination of AI_DESTINATIONS) {
    commands.push({
      id: `ai:${destination.id}`,
      title: destination.title,
      subtitle: destination.subtitle,
      group: 'Navigate',
      icon: 'spark',
      keywords: destination.keywords,
      target: { kind: 'navigate', href: destination.href },
    });
  }

  // W067 — the developer console destination (API keys/scopes, webhooks,
  // MCP connection, integration activity; keyboard-reachable by name —
  // the platform-tool half of the More page's promise, now delivered).
  for (const destination of DEVELOPER_DESTINATIONS) {
    commands.push({
      id: `developer:${destination.id}`,
      title: destination.title,
      subtitle: destination.subtitle,
      group: 'Navigate',
      icon: 'developer',
      keywords: destination.keywords,
      target: { kind: 'navigate', href: destination.href },
    });
  }

  // W075 — the account destination (company setup & invitations): the
  // last hub entry the command search was missing — "invite" and
  // "company" now find it, task-language first.
  {
    const company = capabilityEntry('company');
    commands.push({
      id: `account:${company.id}`,
      title: company.label,
      subtitle: company.summary,
      group: 'Navigate',
      icon: company.icon,
      keywords: company.keywords,
      target: { kind: 'navigate', href: company.href },
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
  // W075 — MULTI-WORD TASK QUERIES: a user types a task phrase
  // ("connect whatsapp", "add ai", "integrate with your tools"). The
  // command matches when EVERY word of the query appears somewhere in
  // the title, subtitle or keywords (AND semantics; single-word
  // behavior above is unchanged). Ranks with the substring tier —
  // task phrases are real queries, not noise.
  const tokens = q.split(/\s+/).filter((token) => token !== '');
  if (tokens.length > 1) {
    const everyTokenMatches = tokens.every((token) =>
      haystacks.some((hay) => hay.includes(token)),
    );
    if (everyTokenMatches) return 5;
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
