// Product shell (W075) — the capability hub registry: the SINGLE intent
// registry that powers the three discovery surfaces of the measurement
// frame (plan §4):
//
//   `Chat → contextual action → detail surface → return to Chat`
//   `Chat → Search/More → capability hub`
//
// The W070 capability map proved every capability ROUTE is reachable; the
// frozen plan's §4 correction is that **reachable ≠ naturally discovered**:
// the remaining gap is task language. This registry is therefore written
// in USER INTENT, never in module names — an entry says what a person
// wants to DO ("Connect a channel", "Add your own AI provider", "Find a
// capability to install"), and points at the surface that does it.
//
// One registry, three projections (no second list to drift):
//   * the More page renders the families as the grouped capability hub;
//   * the command search derives task-language keywords + suggestions;
//   * the contextual prompt components render the blocked-state prompts
//     (missing connection / no suitable model / capability not installed /
//     integrate with your tools) from the same entries.
//
// CLIENT-SAFETY: like `navigation.ts`, this module is imported by client
// components (the command search) — pure data only, no server imports.
// The tower surface entries are DERIVED from `towerSurfaceLinks()` so the
// fifteen management-mode destinations cannot drift from the navigation
// registry, and their hrefs stay the tower's own.

import type { ShellIcon } from './navigation';
import { towerSurfaceLinks } from './navigation';
import type { TowerLinkGroup, TowerSurfaceLink } from './navigation';

/** One capability entry a user can reach by intent. */
export interface CapabilityEntry {
  /** Stable slug — also the command id suffix (`intent:<id>`). */
  id: string;
  /** Intent-first label in user language (never a module name). */
  label: string;
  /** One line describing what this does for the user, in user language. */
  summary: string;
  /** The destination (an in-app path). */
  href: string;
  /** Task-language search terms (module words welcome HERE, not in labels). */
  keywords: string[];
  icon: ShellIcon;
  /**
   * Small grouping note rendered on the hub card (an intent sub-family,
   * e.g. "management mode" for tower drill-downs). Optional.
   */
  note: string | null;
}

/** A capability family: entries grouped by the intent a user arrives with. */
export interface CapabilityFamily {
  /** Stable slug. */
  id: string;
  /** The intent heading in user language (what you came here to do). */
  heading: string;
  /** One line for the family, in user language. */
  blurb: string;
  entries: CapabilityEntry[];
}

/** Intent sub-group note per tower link group (user language, not taxonomy). */
const TOWER_INTENT_NOTES: Record<TowerLinkGroup, string> = {
  Overview: 'decide now',
  Direction: 'steer the company',
  Intelligence: 'what Aurum found',
  'People & Systems': 'people, agents and work',
  Governance: 'evidence, decisions and audit',
};

/** One tower surface as an intent entry (labels stay the tower's own). */
function towerEntry(link: TowerSurfaceLink): CapabilityEntry {
  return {
    id: `tower-${link.surface}`,
    label: link.label,
    summary: link.tagline,
    href: link.href,
    keywords: [link.surface, 'management', 'tower', ...link.label.toLowerCase().split(/\s+/)],
    icon: 'tower',
    note: TOWER_INTENT_NOTES[link.group],
  };
}

/**
 * The capability families, in More-hub order. The management-mode family
 * (the Control Tower bridge) is built from the navigation registry so it
 * can never drift; everything else is declared here in intent language.
 */
export const CAPABILITY_FAMILIES: readonly CapabilityFamily[] = [
  {
    id: 'work',
    heading: 'Work with Aurum',
    blurb: 'The conversation, and the questions Aurum brings you.',
    entries: [
      {
        id: 'chat',
        label: 'Talk with Aurum',
        summary:
          'Ask anything about the company; answers come with evidence and action cards.',
        href: '/chat',
        keywords: ['chat', 'talk', 'ask', 'message', 'conversation', 'question', 'aurum'],
        icon: 'chat',
        note: null,
      },
      {
        id: 'learning',
        label: 'Answer a question Aurum asked you',
        summary:
          'Knowledge requests from Aurum, your contributions, and the rewards policy acknowledges them with.',
        href: '/learning',
        keywords: [
          'learning',
          'answer',
          'question',
          'knowledge',
          'contribute',
          'contribution',
          'reward',
          'rewards',
          'missions',
        ],
        icon: 'people',
        note: null,
      },
    ],
  },
  {
    id: 'stay-on-top',
    heading: 'Stay on top of the company',
    blurb: 'What Aurum found on its own, and the people it works with.',
    entries: [
      {
        id: 'briefing',
        label: 'Read today’s briefing',
        summary:
          'The proactive findings that need you: severity, why it matters, what’s next.',
        href: '/intelligence',
        keywords: [
          'today',
          'briefing',
          'findings',
          'proactive',
          'attention',
          'intelligence',
          'goals',
          'unknowns',
          'missions',
          'risks',
          'opportunities',
        ],
        icon: 'intelligence',
        note: null,
      },
      {
        id: 'people',
        label: 'See your people and how work gets done',
        summary: 'The workforce, roles and what Aurum understands about how work flows.',
        href: '/people',
        keywords: ['people', 'workforce', 'team', 'roles', 'employees', 'staff'],
        icon: 'people',
        note: null,
      },
    ],
  },
  {
    id: 'connect',
    heading: 'Connect your systems',
    blurb: 'Channels, data sources and deliveries Aurum works through.',
    entries: [
      {
        id: 'connections',
        label: 'Connect a channel or data source',
        summary:
          'WhatsApp, Slack and the other channels Aurum talks on; the systems it reads; the destinations it delivers to.',
        href: '/connections',
        keywords: [
          'connect',
          'connection',
          'connections',
          'channel',
          'channels',
          'whatsapp',
          'slack',
          'telegram',
          'signal',
          'source',
          'sources',
          'data',
          'ingest',
          'sync',
          'import',
          'destination',
          'destinations',
          'delivery',
          'identity',
          'link',
        ],
        icon: 'connections',
        note: null,
      },
    ],
  },
  {
    id: 'ai',
    heading: 'Choose the AI Aurum uses',
    blurb: 'Bring your own AI accounts — no provider is privileged.',
    entries: [
      {
        id: 'ai-providers',
        label: 'Add your own AI provider',
        summary:
          'Connect an AI account, check availability, routing, cost and latency — and hot-swap providers without losing the thread.',
        href: '/ai',
        keywords: [
          'ai',
          'provider',
          'providers',
          'llm',
          'model',
          'models',
          'add',
          'connect',
          'account',
          'accounts',
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
          'byoa',
          'no model',
          'no suitable model',
          'chatgpt',
          'openai',
          'anthropic',
          'claude',
          'gemini',
        ],
        icon: 'spark',
        note: null,
      },
    ],
  },
  {
    id: 'extend',
    heading: 'Extend Aurum’s capabilities',
    blurb: 'The governed marketplace: find, install and govern capabilities.',
    entries: [
      {
        id: 'marketplace-browse',
        label: 'Find a capability to install',
        summary:
          'Extensions and agent packages that add what your company needs — reviewed before anything is installable.',
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
        icon: 'marketplace',
        note: null,
      },
      {
        id: 'marketplace-installed',
        label: 'Review what you’ve installed',
        summary: 'Activate, suspend or roll back what your company runs.',
        href: '/marketplace/installed',
        keywords: [
          'marketplace',
          'installed',
          'extensions',
          'govern',
          'rollback',
          'suspend',
          'activate',
          'review',
        ],
        icon: 'marketplace',
        note: null,
      },
      {
        id: 'marketplace-developer',
        label: 'Build and publish a package',
        summary: 'Package a capability, submit it, and follow the review.',
        href: '/marketplace/developer',
        keywords: [
          'marketplace',
          'developer',
          'builder',
          'build',
          'publish',
          'package',
          'submit',
          'review',
        ],
        icon: 'marketplace',
        note: null,
      },
    ],
  },
  {
    id: 'integrate',
    heading: 'Integrate Aurum with your tools',
    blurb: 'The API, webhooks and MCP connection — Aurum inside your own software.',
    entries: [
      {
        id: 'developer',
        label: 'Integrate Aurum — API, webhooks, MCP',
        summary:
          'Create and rotate API keys, manage webhooks, and connect your tools over the model context protocol.',
        href: '/developer',
        keywords: [
          'developer',
          'api',
          'integrate',
          'integration',
          'keys',
          'key',
          'scopes',
          'scope',
          'webhook',
          'webhooks',
          'mcp',
          'model context protocol',
          'console',
          'rotate',
          'revoke',
          'bearer',
          'token',
        ],
        icon: 'developer',
        note: null,
      },
    ],
  },
  {
    id: 'act',
    heading: 'Act on gaps and opportunities',
    blurb: 'Compare fixes for a capability gap, then approve and activate.',
    entries: [
      {
        id: 'interventions',
        label: 'Fix a capability gap — train, hire, automate or recruit',
        summary:
          'Aurum’s acquisition alternatives side by side; proposals you approve; agents and teams you activate and review.',
        href: '/interventions',
        keywords: [
          'interventions',
          'intervention',
          'capability',
          'gap',
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
          'activate',
          'agents',
          'teams',
          'workforce',
          'lifecycle',
          'fix',
        ],
        icon: 'people',
        note: null,
      },
    ],
  },
  {
    id: 'manage',
    heading: 'Run and govern the company',
    blurb:
      'Management mode — the Control Tower: every governing surface one drill-down away, grouped by what you came to decide.',
    entries: [
      {
        id: 'today',
        label: 'See what needs a decision',
        summary: 'The attention dashboard: decisions, missions and unknowns waiting.',
        href: '/today',
        keywords: ['today', 'decisions', 'decision', 'management', 'tower'],
        icon: 'today',
        note: 'decide now',
      },
      ...towerSurfaceLinks()
        .filter((link) => link.surface !== 'today')
        .map(towerEntry),
    ],
  },
  {
    id: 'explain',
    heading: 'See why Aurum concluded something',
    blurb: 'Every consequential answer, end to end: evidence, conflicts, approvals.',
    entries: [
      {
        id: 'explain',
        label: 'Explain a decision',
        summary:
          'Reconstruct any consequential answer or decision — sources, retained contradictions, policy, approvals, outcomes and learning.',
        href: '/explain',
        keywords: [
          'explain',
          'why',
          'evidence',
          'audit',
          'decision',
          'decisions',
          'provenance',
          'contradiction',
          'conflict',
          'accountability',
          'show me why',
        ],
        icon: 'tower',
        note: null,
      },
    ],
  },
  {
    id: 'account',
    heading: 'Your company and account',
    blurb: 'The company itself, invitations and your session.',
    entries: [
      {
        id: 'company',
        label: 'Set up your company and invite people',
        summary: 'Company details, workspaces and the invitation roster.',
        href: '/onboarding',
        keywords: [
          'company',
          'invite',
          'invitations',
          'invitation',
          'onboarding',
          'workspace',
          'workspaces',
          'members',
          'team',
          'account',
          'setup',
        ],
        icon: 'more',
        note: null,
      },
    ],
  },
];

/** All capability entries, flattened in family order. */
export function capabilityEntries(): CapabilityEntry[] {
  return CAPABILITY_FAMILIES.flatMap((family) => family.entries);
}

/** One capability entry by id (throws — the registry is closed). */
export function capabilityEntry(id: string): CapabilityEntry {
  const entry = capabilityEntries().find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`unknown capability entry '${id}'`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Contextual prompts (the blocked-state entry points — plan §3 journeys
// G, H, J and L: the conversation must lead to the path that unblocks it)
// ---------------------------------------------------------------------------

/**
 * One contextual prompt: WHEN a capability is missing or blocking, WHERE
 * the user goes. The prompts are the chat-facing half of discovery —
 * shared components render them wherever a surface knows it is blocked
 * (the answer pipeline, the context drawer, the More hub's honest
 * "when something is missing" section).
 */
export interface CapabilityPrompt {
  id: string;
  /** The blocking situation, in user words. */
  when: string;
  /** The unblocking action, in user words (the link label). */
  label: string;
  /** One line of explanation. */
  summary: string;
  href: string;
  keywords: string[];
}

/**
 * The four contextual prompt kinds, each tied to the same destinations as
 * the hub entries (the registry's own consistency rule: a prompt never
 * introduces a surface the hub does not list).
 */
export const CAPABILITY_PROMPTS: readonly CapabilityPrompt[] = [
  {
    id: 'connections',
    when: 'Aurum cannot see a system it needs',
    label: 'Connect the missing system',
    summary:
      'Channels, source systems and deliveries — connecting one unblocks the investigation.',
    href: '/connections',
    keywords: ['connect', 'connection', 'channel', 'source', 'system', 'whatsapp', 'slack'],
  },
  {
    id: 'ai-provider',
    when: 'No suitable model is available to answer',
    label: 'Add an AI provider',
    summary:
      'Bring your own AI account and Aurum answers open-ended questions with it — evidence still grounded.',
    href: '/ai',
    keywords: ['model', 'ai', 'provider', 'llm', 'no model', 'add'],
  },
  {
    id: 'marketplace',
    when: 'A capability you need is not installed',
    label: 'Find a capability to install',
    summary: 'The marketplace lists reviewed extensions and agent packages.',
    href: '/marketplace',
    keywords: ['marketplace', 'install', 'capability', 'extension', 'package'],
  },
  {
    id: 'developer',
    when: 'You want Aurum inside your own tools',
    label: 'Integrate Aurum — API, webhooks, MCP',
    summary: 'API keys, webhook delivery and the MCP connection instructions.',
    href: '/developer',
    keywords: ['developer', 'api', 'mcp', 'webhook', 'integrate'],
  },
];

/** One prompt by id (throws — the set is closed). */
export function capabilityPrompt(id: string): CapabilityPrompt {
  const prompt = CAPABILITY_PROMPTS.find((candidate) => candidate.id === id);
  if (prompt === undefined) {
    throw new Error(`unknown capability prompt '${id}'`);
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Command-search suggestions (task language for the empty state)
// ---------------------------------------------------------------------------

/** One clickable suggestion in the command search's no-results state. */
export interface CommandSuggestion {
  /** The task phrasing the user sees (task language, never a module name). */
  label: string;
  /** The query the suggestion sets — a real keyword of a real command. */
  query: string;
}

/**
 * The task-language suggestions for the command search's empty state.
 * Each query is a REAL keyword of a REAL registry command (the unit
 * tests lock this: every suggestion must produce at least one result).
 */
export const COMMAND_SUGGESTIONS: readonly CommandSuggestion[] = [
  { label: 'Connect WhatsApp or Slack', query: 'whatsapp' },
  { label: 'Add an AI provider', query: 'ai' },
  { label: 'Install a capability', query: 'install' },
  { label: 'Integrate with your tools', query: 'api' },
  { label: 'What needs my attention?', query: 'attention' },
  { label: 'Explain a decision', query: 'why' },
];
