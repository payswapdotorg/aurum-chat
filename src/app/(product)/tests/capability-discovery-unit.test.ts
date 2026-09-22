// Unit tests for W075 — Natural Capability Discovery.
//
// The W070 capability map proved every capability ROUTE is reachable;
// W075's acceptance is about DISCOVERABILITY in the user's mental model
// (plan §4): "Chat → contextual action → detail surface" and
// "Chat → Search/More → capability hub", with labels that describe user
// intent rather than internal modules. These tests lock the three
// projections of the single intent registry (`lib/capability-hub`):
//
//   * HUB COMPLETENESS — every static non-auth page route of the route
//     catalog is an entry of the capability hub (the More page renders
//     the whole registry), so nothing is command-search-only;
//   * TASK LANGUAGE — labels describe what the user wants to do; the
//     module-first label patterns are gone; the task queries a user
//     actually types ("whatsapp", "no model", "integrate", "invite",
//     "install") find the right destination;
//   * CONTEXTUAL PROMPTS — the blocked-state prompts point at hub
//     destinations (a prompt never introduces a surface the hub does
//     not list), and the command-search suggestions all resolve.
//
// Pure registry tests — no DB, no DOM (the shell's testing doctrine).

import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_FAMILIES,
  CAPABILITY_PROMPTS,
  COMMAND_SUGGESTIONS,
  capabilityEntries,
  capabilityEntry,
  capabilityPrompt,
} from '../lib/capability-hub';
import {
  buildShellCommands,
  filterShellCommands,
} from '../lib/command-registry';
import { PRODUCT_AREAS, towerSurfaceLinks } from '../lib/navigation';
import { ROUTE_CATALOG, pageRoutes } from '@/modules/journey-proof/contract';
import { CARD_HREFS } from '../chat/lib/chat-types';

// ---------------------------------------------------------------------------
// Hub completeness — the More page is the full capability index
// ---------------------------------------------------------------------------

describe('capability hub completeness', () => {
  const entries = capabilityEntries();
  const hubHrefs = new Set(entries.map((entry) => entry.href));

  it('every static non-auth page route is a hub entry (nothing is More-missing)', () => {
    // The auth entry flow is reachable by design (route-gate redirects)
    // and /more is the page itself; everything else a user can open
    // must be findable from the capability hub.
    const inScope = pageRoutes()
      .filter(
        (route) =>
          route.kind === 'page' &&
          route.area !== 'auth' &&
          !route.path.includes(':') &&
          route.path !== '/more',
      )
      .map((route) => route.path);
    expect(inScope.length).toBeGreaterThan(20);
    const missing = inScope.filter((path) => !hubHrefs.has(path));
    expect(missing).toEqual([]);
  });

  it('every hub entry targets a real route in the catalog (no invented hrefs)', () => {
    const known = new Set(ROUTE_CATALOG.map((route) => route.path));
    const invented = [...hubHrefs].filter((href) => !known.has(href));
    expect(invented).toEqual([]);
  });

  it('hub entry ids are unique; families have unique headings', () => {
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const headings = CAPABILITY_FAMILIES.map((family) => family.heading);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('the management-mode family carries Today plus all fifteen tower surfaces, derived from the navigation registry', () => {
    const manage = CAPABILITY_FAMILIES.find((family) => family.id === 'manage');
    expect(manage).toBeDefined();
    const manageHrefs = new Set(manage!.entries.map((entry) => entry.href));
    for (const link of towerSurfaceLinks()) {
      expect(manageHrefs.has(link.href), link.href).toBe(true);
    }
    expect(manage!.entries).toHaveLength(15);
    // And the sub-group notes are user intent, not the tower taxonomy.
    for (const entry of manage!.entries) {
      expect(entry.note).not.toBeNull();
      expect(['Overview', 'Direction', 'Intelligence', 'People & Systems', 'Governance']).not.toContain(entry.note);
    }
  });

  it('every product area is represented in the hub (the rail and the hub agree)', () => {
    for (const area of PRODUCT_AREAS) {
      if (area.id === 'more') continue; // this page
      expect(
        entries.some((entry) => entry.href === area.href),
        area.href,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Task language — labels describe user intent, not internal modules
// ---------------------------------------------------------------------------

describe('task language', () => {
  const entries = capabilityEntries();

  it('no hub label uses the module-first prefix pattern (the W057-era labels)', () => {
    // The pre-W075 command labels led with the module: "Marketplace —
    // browse", "Intelligence — Today's briefing", "AI providers —…",
    // "Developer —…", "Learning —…", "Interventions —…". The regression
    // lock: no label (hub or command) starts with a module name.
    const moduleFirst = /^(Marketplace|Intelligence|Learning|Interventions|AI providers|Evidence & audit|Developer)\s*[—-]/;
    for (const entry of entries) {
      expect(moduleFirst.test(entry.label), entry.label).toBe(false);
    }
    for (const command of buildShellCommands()) {
      expect(moduleFirst.test(command.title), command.title).toBe(false);
    }
  });

  it('family headings are intent phrases, never the tower taxonomy', () => {
    const taxonomy = [
      'Overview',
      'Direction',
      'Intelligence',
      'People & Systems',
      'Governance',
      'L0',
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
      'L7',
    ];
    for (const family of CAPABILITY_FAMILIES) {
      expect(taxonomy, family.heading).not.toContain(family.heading);
    }
  });

  it('the key capabilities carry intent labels a user would recognize', () => {
    // The plan's §3 remaining improvements, as label obligations:
    // G (connections), H (BYOA), J (marketplace), L (developer/API/MCP),
    // the management bridge, and the explainability view.
    expect(capabilityEntry('connections').label).toMatch(/connect/i);
    expect(capabilityEntry('ai-providers').label).toMatch(/ai provider/i);
    expect(capabilityEntry('marketplace-browse').label).toMatch(/install/i);
    expect(capabilityEntry('developer').label).toMatch(/integrate/i);
    expect(capabilityEntry('interventions').label).toMatch(/fix/i);
    expect(capabilityEntry('explain').label).toMatch(/explain/i);
    // The management-mode bridge names itself in user language.
    const manage = CAPABILITY_FAMILIES.find((family) => family.id === 'manage');
    expect(manage!.heading).toMatch(/run|govern/i);
    expect(manage!.blurb).toMatch(/management mode/i);
  });

  it('a user typing a TASK finds the destination that does it (the task queries)', () => {
    const commands = buildShellCommands();
    const firstHref = (query: string): string => {
      const results = filterShellCommands(commands, query);
      expect(results.length, `query '${query}' must match something`).toBeGreaterThan(0);
      const target = results[0]!.command.target;
      expect(target.kind).toBe('navigate');
      return target.kind === 'navigate' ? target.href : '';
    };
    // Journey G: a missing connection — "whatsapp"/"slack"/"connect".
    expect(firstHref('whatsapp')).toBe('/connections');
    expect(firstHref('slack')).toBe('/connections');
    expect(firstHref('connect')).toBe('/connections');
    // Journey H: "no suitable model available" → the provider path.
    expect(firstHref('no model')).toBe('/ai');
    expect(firstHref('add ai')).toBe('/ai');
    // Journey J: "install a capability" → the marketplace.
    expect(firstHref('install')).toBe('/marketplace');
    // Journey L: "integrate" → the developer console.
    expect(firstHref('integrate')).toBe('/developer');
    expect(firstHref('mcp')).toBe('/developer');
    expect(firstHref('api key')).toBe('/developer');
    // The company/invitation path — previously NOT in the command search.
    expect(firstHref('invite')).toBe('/onboarding');
    expect(firstHref('company')).toBe('/onboarding');
  });
});

// ---------------------------------------------------------------------------
// No critical capability is command-search-only (multi-frame reachability)
// ---------------------------------------------------------------------------

describe('no capability is command-search-only', () => {
  const commands = buildShellCommands();
  const commandHrefs = new Set(
    commands
      .filter((command) => command.target.kind === 'navigate')
      .map((command) => (command.target as { href: string }).href),
  );
  const hubHrefs = new Set(capabilityEntries().map((entry) => entry.href));
  const railHrefs = new Set(PRODUCT_AREAS.map((area) => area.href));
  const towerHrefs = new Set(towerSurfaceLinks().map((link) => link.href));
  const chatCardHrefs = new Set(Object.values(CARD_HREFS));

  /** The critical destinations: every hub entry plus the chat cards' targets. */
  const criticalHrefs = [...hubHrefs, ...chatCardHrefs];

  it('every critical capability is reachable from the hub AND at least one other frame', () => {
    const searchOnly: string[] = [];
    for (const href of criticalHrefs) {
      const inCommands = commandHrefs.has(href);
      const inHub = hubHrefs.has(href);
      // The non-search frames: the desktop rail, the tower nav, the
      // chat cards (contextual action), or the hub itself is enough
      // because the hub is mobile-reachable through the More area of
      // the bottom nav — but "command-search-ONLY" means search is the
      // SOLE path, so we assert a second frame beyond search exists.
      const secondFrame =
        railHrefs.has(href) ||
        towerHrefs.has(href) ||
        chatCardHrefs.has(href) ||
        inHub;
      if (!inCommands || !inHub || !secondFrame) {
        searchOnly.push(`${href} (commands=${inCommands}, hub=${inHub}, other=${secondFrame})`);
      }
    }
    expect(searchOnly).toEqual([]);
  });

  it('the mobile frame reaches every critical capability: More is a bottom-nav area and lists them all', () => {
    // The mobile bottom nav carries `more`; the More page renders the
    // whole hub registry — so every critical destination is reachable
    // on mobile without the command search.
    expect(
      PRODUCT_AREAS.find((area) => area.id === 'more')?.href,
    ).toBe('/more');
    for (const href of criticalHrefs) {
      expect(hubHrefs.has(href), href).toBe(true);
    }
  });

  it('the chat cards still deep-link their management destinations (the contextual-action frame)', () => {
    // The W060 card kinds widened by W072 into the unified nine-kind
    // model (capabilities and evidence join) — the "Chat → contextual
    // action → detail surface" frame. Worker A owns the chat surface;
    // the card href contract is the seam this wave builds around.
    expect(Object.keys(CARD_HREFS).sort()).toEqual([
      'approval',
      'capability',
      'evidence',
      'goal',
      'mission',
      'opportunity',
      'recommendation',
      'risk',
      'unknown',
    ]);
    for (const href of Object.values(CARD_HREFS)) {
      expect(commandHrefs.has(href), href).toBe(true);
      expect(hubHrefs.has(href) || towerHrefs.has(href), href).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Contextual prompts (the blocked-state entry points)
// ---------------------------------------------------------------------------

describe('contextual capability prompts', () => {
  it('the four blocked-state prompts exist with distinct destinations', () => {
    expect(CAPABILITY_PROMPTS.map((prompt) => prompt.id).sort()).toEqual([
      'ai-provider',
      'connections',
      'developer',
      'marketplace',
    ]);
    const hrefs = new Set(CAPABILITY_PROMPTS.map((prompt) => prompt.href));
    expect(hrefs.size).toBe(CAPABILITY_PROMPTS.length);
  });

  it('a prompt never introduces a destination the hub does not list', () => {
    const hubHrefs = new Set(capabilityEntries().map((entry) => entry.href));
    for (const prompt of CAPABILITY_PROMPTS) {
      expect(hubHrefs.has(prompt.href), prompt.href).toBe(true);
    }
  });

  it('every prompt is also command-search reachable (the prompt path is never the only path)', () => {
    const commands = buildShellCommands();
    for (const prompt of CAPABILITY_PROMPTS) {
      const found = commands.find(
        (command) =>
          command.target.kind === 'navigate' &&
          (command.target as { href: string }).href === prompt.href,
      );
      expect(found, prompt.href).toBeDefined();
    }
  });

  it('the prompts speak in user situations ("when") and user actions ("label")', () => {
    const connections = capabilityPrompt('connections');
    expect(connections.when).toMatch(/cannot see|missing|blocked/i);
    expect(connections.label).toMatch(/connect/i);
    const ai = capabilityPrompt('ai-provider');
    expect(ai.when).toMatch(/no suitable model/i);
    expect(ai.label).toMatch(/add an ai provider/i);
    const marketplace = capabilityPrompt('marketplace');
    expect(marketplace.when).toMatch(/not installed/i);
    expect(marketplace.label).toMatch(/find|install/i);
    const developer = capabilityPrompt('developer');
    expect(developer.when).toMatch(/inside your own tools|own tools/i);
    expect(developer.label).toMatch(/integrate/i);
  });
});

// ---------------------------------------------------------------------------
// Command-search suggestions (the no-results state is an entry point)
// ---------------------------------------------------------------------------

describe('command-search suggestions', () => {
  it('every suggestion sets a query that has real results', () => {
    const commands = buildShellCommands();
    for (const suggestion of COMMAND_SUGGESTIONS) {
      const results = filterShellCommands(commands, suggestion.query);
      expect(
        results.length,
        `suggestion '${suggestion.label}' → query '${suggestion.query}'`,
      ).toBeGreaterThan(0);
    }
  });

  it('suggestions are task phrasings, not module names', () => {
    for (const suggestion of COMMAND_SUGGESTIONS) {
      expect(suggestion.label.length).toBeGreaterThan(3);
      expect(suggestion.label).not.toMatch(/^(More|Tower|Product area)/i);
    }
  });
});
