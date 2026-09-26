// W070 — the browser-journey harness: the shared machinery of the
// tests/e2e/journeys/** suites.
//
// WHAT THIS PROVES AND HOW. "Automate the end-user journey matrix on
// desktop and mobile" needs the journeys exercised against the REAL
// surface code of this repository — the pages and API handlers the
// browser actually hits — not against mocks. The stack of this
// repository (Bun + vitest, node environment, no browser binaries in CI)
// makes a headed/Playwright driver unavailable by design, so the harness
// drives the SAME code paths at the highest fidelity that runs in the
// gates:
//
//   * PAGES are server-rendered to the exact HTML a browser receives on
//     first paint: every route's real page component + its real layout
//     chain (root → area layout → page) through React's
//     `renderToReadableStream`, with the session resolved from the
//     persona's REAL session token through the REAL auth contract. The
//     single seam is `next/headers` cookies() — mocked to present the
//     persona's session cookie, exactly the Cookie header a browser
//     sends. Redirects surface as the same NEXT_REDIRECT errors Next
//     itself throws; the harness decodes them.
//   * API interactions call the real handler libraries (the functions
//     the route.ts files delegate to — IMPLEMENTATION-STACK §5) with
//     real `Request` objects carrying the session cookie.
//   * THE WORLD is the deterministic W068 demo world, seeded through the
//     demo module's contract (migrations + seedDemoHarness) into the
//     embedded PostgreSQL (PGlite `:memory:`), and the personas sign in
//     through the real sign-in API with the manifest's assembled
//     password.
//
// Per-file isolation: each test file boots its own database (the vitest
// default), exactly like every other integration suite in this repo.

// The TWO seams (both exactly what a browser provides):
//   * `next/headers` cookies() presents the persona's session cookie;
//   * `next/navigation`'s client hooks receive the CURRENT URL (pathname
//     + search) — the location the browser would be on — so active-state
//     treatment (aria-current) renders for real. The module's server
//     functions (redirect/notFound) stay the REAL ones (importOriginal):
//     pages' redirect/not-found behavior is Next's own, decoded below.
import { vi } from 'vitest';

interface SessionHolder {
  token: string | null;
}

export const sessionHolder: SessionHolder = { token: null };

/** The URL the "browser" is on during a render (drives usePathname & co). */
interface NavigationHolder {
  pathname: string;
  search: string;
}

export const navigationHolder: NavigationHolder = { pathname: '/', search: '' };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'aurum_session' && sessionHolder.token !== null
        ? { value: sessionHolder.token }
        : undefined,
  }),
}));

vi.mock('next/navigation', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    usePathname: () => navigationHolder.pathname,
    useSearchParams: () => new URLSearchParams(navigationHolder.search),
    useRouter: () => ({
      push: () => undefined,
      replace: () => undefined,
      refresh: () => undefined,
      prefetch: () => undefined,
      back: () => undefined,
      forward: () => undefined,
    }),
  };
});

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { closeDb, getDb } from '../../../src/infra/db';
import { runMigrations } from '../../../scripts/migrate';
import {
  demoPersonaPassword,
  demoPersonaSpec,
  seedDemoHarness,
} from '../../../src/modules/demo/contract';
import type { DemoSeedReport } from '../../../src/modules/demo/contract';
import { findRouteForPath } from '../../../src/modules/journey-proof/contract';
import { handleSignIn } from '../../../src/app/(auth)/lib/api';

export type { DemoSeedReport };

// ---------------------------------------------------------------------------
// The demo world
// ---------------------------------------------------------------------------

let worldPromise: Promise<DemoSeedReport> | null = null;

/** Boot migrations + the deterministic demo world (once per test file). */
export function demoWorld(): Promise<DemoSeedReport> {
  if (worldPromise === null) {
    worldPromise = (async () => {
      await runMigrations(getDb());
      return seedDemoHarness();
    })();
  }
  return worldPromise;
}

/** Tear the database down (afterAll). */
export async function shutdownWorld(): Promise<void> {
  await closeDb();
}

/** The demo company tenant id. */
export function companyTenantId(report: DemoSeedReport): string {
  const company = report.tenants.find((tenant) => tenant.key === 'company');
  if (company === undefined) throw new Error('the demo world has no company tenant');
  return company.id;
}

/** One persona's principal id. */
export function personaPrincipalId(report: DemoSeedReport, role: string): string {
  const persona = report.personas.find((entry) => entry.role === role);
  if (persona === undefined) throw new Error(`no demo persona for role '${role}'`);
  return persona.principalId;
}

/** One journey's anchor record id from the seed report. */
export function anchorId(report: DemoSeedReport, journeyId: string, key: string): string {
  const journey = report.journeys.find((entry) => entry.id === journeyId);
  if (journey === undefined) throw new Error(`journey '${journeyId}' not in the seed report`);
  const anchor = journey.anchors.find((entry) => entry.anchorKey === key);
  if (anchor === undefined) throw new Error(`anchor '${key}' not in journey '${journeyId}'`);
  return anchor.recordId;
}

// ---------------------------------------------------------------------------
// Personas (real sign-in through the real API)
// ---------------------------------------------------------------------------

export type PersonaRole = 'manager' | 'employee' | 'developer' | 'platform-reviewer';

/** A signed-in persona: display name + the live session token. */
export interface PersonaSession {
  role: PersonaRole;
  displayName: string;
  email: string;
  token: string;
}

/** Sign one demo persona in through the real sign-in handler. */
export async function signInPersona(role: PersonaRole): Promise<PersonaSession> {
  const spec = demoPersonaSpec(role);
  const response = await handleSignIn(
    new Request('https://aurum.test/api/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: spec.email, password: demoPersonaPassword() }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(
      `persona '${role}' could not sign in (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  const cookie = response.setCookie;
  if (cookie === undefined) throw new Error('sign-in issued no session cookie');
  const token = /aurum_session=([^;]+)/.exec(cookie)?.[1];
  if (token === undefined) throw new Error(`unexpected session cookie '${cookie}'`);
  return { role, displayName: spec.fullName, email: spec.email, token };
}

/** Build a Request carrying a persona's session cookie (the API driver). */
export function apiRequest(
  url: string,
  persona: PersonaSession | null,
  init: { method?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (persona !== null) headers['cookie'] = `aurum_session=${persona.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://aurum.test${url}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

// ---------------------------------------------------------------------------
// Page rendering (the real page components + layouts, SSR)
// ---------------------------------------------------------------------------

/** A page/layout module's default export, loosened for the renderer. */
type LoModule = () => Promise<{ default: unknown }>;

interface RouteModule {
  area: 'auth' | 'product' | 'management';
  load: LoModule;
}

/** Every page route of the catalog with its real module loader. */
const PAGE_MODULES: Record<string, RouteModule> = {
  // auth surfaces
  '/signin': { area: 'auth', load: () => import('../../../src/app/(auth)/signin/page') },
  '/signup': { area: 'auth', load: () => import('../../../src/app/(auth)/signup/page') },
  '/onboarding': { area: 'auth', load: () => import('../../../src/app/(auth)/onboarding/page') },
  '/invite/:code': { area: 'auth', load: () => import('../../../src/app/(auth)/invite/[code]/page') },
  // product surfaces
  '/': { area: 'product', load: () => import('../../../src/app/(product)/page') },
  '/chat': { area: 'product', load: () => import('../../../src/app/(product)/chat/page') },
  '/intelligence': { area: 'product', load: () => import('../../../src/app/(product)/intelligence/page') },
  '/intelligence/goals/:goalId': {
    area: 'product',
    load: () => import('../../../src/app/(product)/intelligence/goals/[goalId]/page'),
  },
  '/intelligence/unknowns/:unknownId': {
    area: 'product',
    load: () => import('../../../src/app/(product)/intelligence/unknowns/[unknownId]/page'),
  },
  '/intelligence/missions/:missionId': {
    area: 'product',
    load: () => import('../../../src/app/(product)/intelligence/missions/[missionId]/page'),
  },
  '/learning': { area: 'product', load: () => import('../../../src/app/(product)/learning/page') },
  '/interventions': { area: 'product', load: () => import('../../../src/app/(product)/interventions/page') },
  '/interventions/proposals/:proposalId': {
    area: 'product',
    load: () => import('../../../src/app/(product)/interventions/proposals/[proposalId]/page'),
  },
  '/interventions/agents/:agentId': {
    area: 'product',
    load: () => import('../../../src/app/(product)/interventions/agents/[agentId]/page'),
  },
  '/interventions/teams/:teamId': {
    area: 'product',
    load: () => import('../../../src/app/(product)/interventions/teams/[teamId]/page'),
  },
  '/connections': { area: 'product', load: () => import('../../../src/app/(product)/connections/page') },
  '/marketplace': { area: 'product', load: () => import('../../../src/app/(product)/marketplace/page') },
  '/marketplace/installed': {
    area: 'product',
    load: () => import('../../../src/app/(product)/marketplace/installed/page'),
  },
  '/marketplace/installed/:extensionKey': {
    area: 'product',
    load: () => import('../../../src/app/(product)/marketplace/installed/[extensionKey]/page'),
  },
  '/marketplace/developer': {
    area: 'product',
    load: () => import('../../../src/app/(product)/marketplace/developer/page'),
  },
  '/marketplace/package/:packageId': {
    area: 'product',
    load: () => import('../../../src/app/(product)/marketplace/package/[packageId]/page'),
  },
  '/developer': { area: 'product', load: () => import('../../../src/app/(product)/developer/page') },
  '/ai': { area: 'product', load: () => import('../../../src/app/(product)/ai/page') },
  '/explain': { area: 'product', load: () => import('../../../src/app/(product)/explain/page') },
  '/explain/:kind/:id': {
    area: 'product',
    load: () => import('../../../src/app/(product)/explain/[kind]/[id]/page'),
  },
  '/more': { area: 'product', load: () => import('../../../src/app/(product)/more/page') },
  '/people': { area: 'product', load: () => import('../../../src/app/(product)/people/page') },
  // management mode (the tower)
  '/today': { area: 'management', load: () => import('../../../src/app/(tower)/today/page') },
  '/goals': { area: 'management', load: () => import('../../../src/app/(tower)/goals/page') },
  '/situation': { area: 'management', load: () => import('../../../src/app/(tower)/situation/page') },
  '/unknowns': { area: 'management', load: () => import('../../../src/app/(tower)/unknowns/page') },
  '/missions': { area: 'management', load: () => import('../../../src/app/(tower)/missions/page') },
  '/risks': { area: 'management', load: () => import('../../../src/app/(tower)/risks/page') },
  '/opportunities': { area: 'management', load: () => import('../../../src/app/(tower)/opportunities/page') },
  '/capabilities': { area: 'management', load: () => import('../../../src/app/(tower)/capabilities/page') },
  '/processes': { area: 'management', load: () => import('../../../src/app/(tower)/processes/page') },
  '/automation': { area: 'management', load: () => import('../../../src/app/(tower)/automation/page') },
  '/workforce': { area: 'management', load: () => import('../../../src/app/(tower)/workforce/page') },
  '/agents': { area: 'management', load: () => import('../../../src/app/(tower)/agents/page') },
  '/evidence': { area: 'management', load: () => import('../../../src/app/(tower)/evidence/page') },
  '/recommendations': { area: 'management', load: () => import('../../../src/app/(tower)/recommendations/page') },
  '/approvals': { area: 'management', load: () => import('../../../src/app/(tower)/approvals/page') },
  // W092 — the Vertical Kits tower surface (an additive loader beside the
  // W033 fifteen).
  '/vertical-kits': { area: 'management', load: () => import('../../../src/app/(tower)/vertical-kits/page') },
};

/** Every page route that must have a real module (the catalog ⇄ loader lock). */
export function loaderRoutePatterns(): string[] {
  return Object.keys(PAGE_MODULES);
}

type LayoutLoader = LoModule;

const LAYOUTS: Record<RouteModule['area'], { area: LayoutLoader; root: LayoutLoader }> = {
  auth: {
    area: () => import('../../../src/app/(auth)/layout'),
    root: () => import('../../../src/app/layout'),
  },
  product: {
    area: () => import('../../../src/app/(product)/layout'),
    root: () => import('../../../src/app/layout'),
  },
  management: {
    area: () => import('../../../src/app/(tower)/layout'),
    root: () => import('../../../src/app/layout'),
  },
};

/** What a render produced. */
export interface RenderedPage {
  /** The matched route pattern ('' when the path matches nothing). */
  route: string;
  /** The concrete path rendered (query stripped). */
  path: string;
  status: 'ok' | 'redirect' | 'not-found' | 'error';
  html: string | null;
  redirect: string | null;
  error: unknown | null;
}

const REDIRECT_DIGEST = /^NEXT_REDIRECT;([^;]*);([^;]*);([^;]*);/;

function redirectTargetOf(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string'
  ) {
    const digest = (error as { digest: string }).digest;
    const match = REDIRECT_DIGEST.exec(digest);
    if (match !== null) return match[2] ?? null;
    if (digest.startsWith('NEXT_NOT_FOUND')) return '@not-found';
  }
  return null;
}

/**
 * Render one route exactly as the server would: resolve the path against
 * the route catalog, load the real page module and its real layout chain,
 * present the persona's session cookie, and server-render the full
 * document. Query parameters ride through as the page's searchParams
 * (`/chat?c=<id>` opens that conversation).
 */
export async function renderRoute(
  pathWithQuery: string,
  persona: PersonaSession | null,
): Promise<RenderedPage> {
  const url = new URL(
    `https://aurum.test${pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`}`,
  );
  const path = url.pathname;
  const spec = findRouteForPath(path);
  if (spec === null) {
    return { route: '', path, status: 'not-found', html: null, redirect: null, error: null };
  }
  const entry = PAGE_MODULES[spec.path];
  if (entry === undefined) {
    return {
      route: spec.path,
      path,
      status: 'error',
      html: null,
      redirect: null,
      error: new Error(`no page loader for ${spec.path}`),
    };
  }

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  const params: Record<string, string> = {};
  if (spec.path !== '/') {
    const pattern = spec.path.split('/').filter((segment) => segment !== '');
    const actual = path.split('/').filter((segment) => segment !== '');
    pattern.forEach((segment, index) => {
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(actual[index] ?? '');
      }
    });
  }

  sessionHolder.token = persona === null ? null : persona.token;
  navigationHolder.pathname = path;
  navigationHolder.search = url.search;
  try {
    const [pageModule, areaLayout, rootLayout] = await Promise.all([
      entry.load(),
      LAYOUTS[entry.area].area(),
      LAYOUTS[entry.area].root(),
    ]);
    // The real page/layout components with their real prop types, cast
    // to the renderer's generic component shape (the props passed below —
    // params + searchParams promises — are exactly what the App Router
    // provides; components that take fewer props ignore the extras).
    const Page = pageModule.default as ComponentType<Record<string, unknown>>;
    const AreaLayout = areaLayout.default as ComponentType<{ children?: unknown }>;
    const RootLayout = rootLayout.default as ComponentType<{ children?: unknown }>;
    const pageElement = createElement(Page, {
      params: Promise.resolve(params),
      searchParams: Promise.resolve(query),
    });
    const inArea = createElement(AreaLayout, null, pageElement);
    const document = createElement(RootLayout, null, inArea);
    const stream = await renderToReadableStream(document);
    const html = await new Response(stream).text();
    return { route: spec.path, path, status: 'ok', html, redirect: null, error: null };
  } catch (error) {
    const target = redirectTargetOf(error);
    if (target === '@not-found') {
      return { route: spec.path, path, status: 'not-found', html: null, redirect: null, error: null };
    }
    if (target !== null) {
      return { route: spec.path, path, status: 'redirect', html: null, redirect: target, error: null };
    }
    return { route: spec.path, path, status: 'error', html: null, redirect: null, error };
  } finally {
    sessionHolder.token = null;
    navigationHolder.pathname = '/';
    navigationHolder.search = '';
  }
}

/** Render and require success (throws with the route and error on any other outcome). */
export async function renderOk(
  pathWithQuery: string,
  persona: PersonaSession | null,
): Promise<{ route: string; html: string }> {
  const rendered = await renderRoute(pathWithQuery, persona);
  if (rendered.status !== 'ok' || rendered.html === null) {
    throw new Error(
      `render of '${pathWithQuery}' as '${persona?.role ?? 'anonymous'}' → ${rendered.status}` +
        (rendered.redirect !== null ? ` → ${rendered.redirect}` : '') +
        (rendered.error instanceof Error ? `: ${rendered.error.message}` : ''),
    );
  }
  return { route: rendered.route, html: rendered.html };
}

// ---------------------------------------------------------------------------
// Concrete seeded paths (the drill-down pages' real record ids)
// ---------------------------------------------------------------------------

/**
 * The concrete path for a parameterized route pattern, from the seeded
 * demo world. Needs the team id when a team was composed for the world
 * (the harness itself does not mutate; the suites compose teams through
 * the real API before calling this).
 */
export function concretePathFor(
  pattern: string,
  context: { report: DemoSeedReport; teamId?: string },
): string {
  const { report } = context;
  switch (pattern) {
    case '/intelligence/goals/:goalId':
      return `/intelligence/goals/${anchorId(report, 'unprompted-discovery', 'goal-freshness')}`;
    case '/intelligence/unknowns/:unknownId':
      return `/intelligence/unknowns/${anchorId(report, 'unprompted-discovery', 'unknown-freshness')}`;
    case '/intelligence/missions/:missionId':
      return `/intelligence/missions/${anchorId(report, 'unprompted-discovery', 'mission-freshness')}`;
    case '/interventions/proposals/:proposalId':
      return `/interventions/proposals/${anchorId(report, 'agent-recruitment', 'recruitment-proposal')}`;
    case '/interventions/agents/:agentId':
      return `/interventions/agents/${anchorId(report, 'agent-recruitment', 'agent-freshness-monitor')}`;
    case '/interventions/teams/:teamId':
      if (context.teamId === undefined || context.teamId === '') {
        throw new Error('the team drill-down needs a composed team (compose one through the API first)');
      }
      return `/interventions/teams/${context.teamId}`;
    case '/marketplace/package/:packageId':
      return `/marketplace/package/${anchorId(report, 'marketplace', 'vendor-package')}`;
    case '/marketplace/installed/:extensionKey':
      return '/marketplace/installed/roast-batch-tracker';
    case '/explain/:kind/:id':
      return `/explain/execution/${anchorId(report, 'consequential-approval', 'cognition-execution')}`;
    case '/invite/:code':
      // The invitation code is single-use and shown once (only its hash is
      // stored) — the honest auditable state is the quiet dead-code page.
      return '/invite/not-a-live-code';
    default:
      throw new Error(`no concrete path mapping for ${pattern}`);
  }
}
