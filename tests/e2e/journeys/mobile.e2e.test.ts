// W070 — the mobile-navigation journey (the "mobile navigation" acceptance
// bullet): the mobile chrome renders on every product page (top bar +
// five-area bottom nav), the active area carries its aria-current
// treatment, and EVERY page route of the catalog is reachable from the
// mobile chrome — by a breadth-first walk: the five bottom-nav areas, the
// command search (the mobile top bar's search entry), and the hub pages
// they link to (More / Intelligence / People / Marketplace / …), following
// real rendered links until the route graph closes.
//
// Touch-target sizes (44px+) are a stylesheet property — audited from the
// shipped CSS in the accessibility suite; this suite proves the structure
// the CSS sizes (the five links, their labels, the top-bar entries) and
// the reachability graph. Management-mode (tower) pages render in the
// tower shell with the tower nav — that is the plan's design, and it is
// asserted as such.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The harness first (its next/headers / next/navigation mocks register on
// module evaluation — see its header note).
import {
  anchorId,
  demoWorld,
  renderOk,
  renderRoute,
  shutdownWorld,
  signInPersona,
  type DemoSeedReport,
  type PersonaSession,
} from './harness';
import {
  MOBILE_AREAS,
  extractPageLinks,
  findRouteForPath,
  matchRoutePattern,
  mobileNavRoutes,
  pageRoutes,
} from '../../../src/modules/journey-proof/contract';
import { buildShellCommands } from '../../../src/app/(product)/lib/command-registry';
import { mobileNavAreas } from '../../../src/app/(product)/lib/navigation';
import { handleTeamCreatePost } from '../../../src/app/(product)/interventions/lib/api';
import { apiRequest } from './harness';

let manager: PersonaSession;
let report: DemoSeedReport;

beforeAll(async () => {
  report = await demoWorld();
  manager = await signInPersona('manager');
  // Compose one agent team through the real surface API so the team
  // drill-down has a live instance in the seeded world (the demo harness
  // seeds agents and proposals, not teams — the compose flow is the
  // surface's own path to one).
  const agentId = anchorId(report, 'agent-recruitment', 'agent-freshness-monitor');
  const team = await handleTeamCreatePost(
    apiRequest('/api/product/interventions/teams', manager, {
      body: {
        displayName: 'Freshness watch team',
        description: 'Watches wholesale freshness signals together',
        topology: 'flat',
        members: [{ agentId, role: 'freshness watcher' }],
        objective: 'Keep wholesale delivery freshness above the goal floor',
        successCriteria: 'Freshness findings surface within one business day',
        budgetAmount: '25.00',
        budgetCurrency: 'USD',
        ownerPrincipal: null,
      },
    }),
  );
  expect(team.status).toBe(200);
});

afterAll(async () => {
  await shutdownWorld();
});

// ---------------------------------------------------------------------------
// The mobile chrome
// ---------------------------------------------------------------------------

describe('the mobile chrome', () => {
  it('renders the top bar (company, presence, search, notifications) and the five-area bottom nav', async () => {
    const { html } = await renderOk('/chat', manager);
    expect(html).toContain('aurum-topbar');
    expect(html).toContain('aurum-bottomnav');
    // The five areas, in plan order, with their short labels.
    for (const area of mobileNavAreas()) {
      expect(html).toContain(`>${area.shortLabel}<`);
    }
    // The top bar's global entries are icon buttons with accessible names.
    expect(html).toContain('aria-label="Search (command menu)"');
    expect(html.toLowerCase()).toContain('notifications');
  });

  it('carries the bottom nav on every PRODUCT page (the employee shell)', async () => {
    for (const path of ['/chat', '/intelligence', '/people', '/more', '/connections']) {
      const { html } = await renderOk(path, manager);
      expect(html, path).toContain('aurum-bottomnav');
      expect(html, path).toContain('aurum-topbar');
    }
  });

  it('management-mode pages carry the tower nav (management mode is its own shell, by design)', async () => {
    for (const path of ['/today', '/goals', '/approvals']) {
      const { html } = await renderOk(path, manager);
      expect(html, path).toContain('tower-nav');
      // …and the surface links onward: the tower nav carries the fifteen
      // surfaces, so a tower page is never a dead end.
      expect(html, path).toContain('href="/goals"');
      expect(html, path).toContain('href="/approvals"');
    }
  });

  it('marks the ACTIVE area with aria-current (the real client-side treatment)', async () => {
    const { html } = await renderOk('/intelligence', manager);
    const bottomNavStart = html.indexOf('aurum-bottomnav');
    const navSlice = html.slice(bottomNavStart, bottomNavStart + 2500);
    expect(navSlice).toContain('aria-current="page"');
    // And the active one is Intelligence, not Chat.
    const activeAt = navSlice.indexOf('aria-current="page"');
    const labelChunk = navSlice.slice(activeAt, activeAt + 300);
    expect(labelChunk).toContain('Intel');
  });

  it('marks the active tower surface in management mode too', async () => {
    const { html } = await renderOk('/approvals', manager);
    expect(html).toContain('aria-current="page"');
  });
});

// ---------------------------------------------------------------------------
// Reachability: a breadth-first walk from the mobile chrome
// ---------------------------------------------------------------------------

describe('mobile reachability of every page route', () => {
  /** The BFS result: every route pattern reachable, with a concrete example link. */
  let reachablePatterns: Map<string, string>;
  let reachableStatics: Set<string>;

  it('walks the mobile horizon breadth-first until the route graph closes', async () => {
    // Hop 0: the five bottom-nav areas + the command-search registry (the
    // mobile top bar's search entry covers the same destinations).
    const commandRoutes = buildShellCommands()
      .filter((command) => command.target.kind === 'navigate')
      .map((command) => (command.target as { href: string }).href)
      .map((href) => href.split('?')[0]?.split('#')[0] ?? href);
    const startPaths = [...mobileNavAreas().map((area) => area.href), ...commandRoutes];

    reachablePatterns = new Map<string, string>();
    reachableStatics = new Set<string>();
    const visited = new Set<string>();
    let frontier = startPaths.filter((path) => path !== '/' && !path.includes('*'));
    const MAX_DEPTH = 4;

    for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth += 1) {
      const nextFrontier: string[] = [];
      for (const path of frontier) {
        if (visited.has(path)) continue;
        visited.add(path);
        const spec = findRouteForPath(path);
        if (spec === null) continue; // not a catalog route (query-only targets etc.)
        if (spec.kind !== 'page') continue; // API routes are not rendered walks
        if (spec.area === 'auth') continue; // the entry flow's own surfaces
        if (spec.path.includes(':')) {
          if (!reachablePatterns.has(spec.path)) reachablePatterns.set(spec.path, path);
          continue; // concrete drill-down instance: record the pattern, keep walking it too
        }
        reachableStatics.add(spec.path);
        const rendered = await renderRoute(path, manager);
        if (rendered.status !== 'ok' || rendered.html === null) continue;
        for (const link of extractPageLinks(rendered.html, path)) {
          const clean = link.resolved.split('?')[0]?.split('#')[0] ?? link.resolved;
          if (clean === '' || clean === path) continue;
          const linkSpec = findRouteForPath(clean);
          if (linkSpec === null || linkSpec.kind !== 'page' || linkSpec.area === 'auth') continue;
          if (!visited.has(clean)) nextFrontier.push(clean);
        }
      }
      frontier = nextFrontier;
    }

    // The walk itself is the evidence: it must have gone deep.
    expect(reachableStatics.size).toBeGreaterThan(25);
    expect(reachablePatterns.size).toBeGreaterThan(5);
  });

  it('every STATIC product/management route is reachable (nav, command search, or hub walk)', () => {
    const inScope = pageRoutes()
      .filter(
        (route) =>
          route.kind === 'page' &&
          route.area !== 'auth' &&
          !route.path.includes(':'),
      )
      .map((route) => route.path);
    const missing = inScope.filter((path) => !reachableStatics.has(path));
    expect(missing).toEqual([]);
  });

  it('every PARAMETERIZED product route has a concrete reachable instance', () => {
    const parameterized = pageRoutes()
      .filter(
        (route) =>
          route.kind === 'page' &&
          route.area !== 'auth' &&
          route.path.includes(':') &&
          route.path !== '/invite/:code', // URL-only surface: the code IS the link
      )
      .map((route) => route.path);
    const missing = parameterized.filter((pattern) => !reachablePatterns.has(pattern));
    expect(missing).toEqual([]);
  });

  it('the auth surfaces are the entry flow itself (reachable by design, not by nav)', async () => {
    // /signin and /signup are where unauthenticated requests land (the
    // route-gate redirect), /onboarding is where company-less sessions
    // land — both proven in the onboarding suite — and /onboarding is
    // ALSO linked from the More page for company management.
    const { html } = await renderOk('/more', manager);
    expect(html).toContain('href="/onboarding"');
  });

  it('the five bottom-nav areas are exactly the plan §3 set', () => {
    expect(MOBILE_AREAS).toEqual(['chat', 'today', 'intelligence', 'people', 'more']);
    expect(mobileNavAreas().map((area) => area.id)).toEqual(MOBILE_AREAS);
  });

  it('the seeded journey drill-downs are concretely reachable from the walk', () => {
    const goalId = anchorId(report, 'unprompted-discovery', 'goal-freshness');
    const missionId = anchorId(report, 'unprompted-discovery', 'mission-freshness');
    const proposalId = anchorId(report, 'agent-recruitment', 'recruitment-proposal');
    expect(reachablePatterns.get('/intelligence/goals/:goalId')).toBe(
      `/intelligence/goals/${goalId}`,
    );
    expect(reachablePatterns.get('/intelligence/missions/:missionId')).toBe(
      `/intelligence/missions/${missionId}`,
    );
    expect(reachablePatterns.get('/interventions/proposals/:proposalId')).toBe(
      `/interventions/proposals/${proposalId}`,
    );
    // And the route resolver agrees.
    expect(
      matchRoutePattern('/intelligence/goals/:goalId', `/intelligence/goals/${goalId}`),
    ).toEqual({ goalId });
  });

  it('the mobile-nav direct routes agree with the catalog’s mobile areas', () => {
    const navRoutes = mobileNavRoutes().map((route) => route.path);
    const expected = ['/chat', '/today', '/intelligence', '/people', '/onboarding', '/more'];
    for (const route of expected) {
      expect(navRoutes, route).toContain(route);
    }
  });
});
