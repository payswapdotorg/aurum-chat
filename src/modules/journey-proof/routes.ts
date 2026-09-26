// The route catalog (W070) — every user-facing route of this repository
// base, as ONE closed list. This is the source of truth the journey
// matrix's steps reference, the link-graph proofs resolve against, and
// the discoverability map maps capabilities onto. It is pure data: the
// execution suites prove each `file` exists and each page renders.
//
// Provenance of the entries:
//   * the product areas and their working surfaces — the (product) route
//     group (W057-W067);
//   * the fifteen Management Control Tower surfaces — the (tower) group
//     (W033), kept as management mode (plan §3);
//   * the auth surfaces — the (auth) group (W058);
//   * the API surface — the route handlers under src/app/api (W038/W058+),
//     listed for completeness with kind 'api' (the developer console
//     documents them; the browser never links them directly).
//
// MOBILE mapping follows plan §3: the bottom nav carries Chat / Today /
// Intelligence / People / More. Everything else is a drill-down from an
// area page, a hub link, or the command search (the mobile top bar's
// search entry).

import type { MobileAreaId, RouteSpec } from './types';

/** Every user-facing route (pages first, then the API surface). */
export const ROUTE_CATALOG: readonly RouteSpec[] = [
  // --- the root -----------------------------------------------------------
  {
    path: '/',
    kind: 'root-redirect',
    area: 'product',
    auth: 'required',
    title: 'Aurum root',
    file: 'src/app/(product)/page.tsx',
    mobileArea: 'chat',
  },

  // --- auth surfaces (W058) ----------------------------------------------
  {
    path: '/signin',
    kind: 'page',
    area: 'auth',
    auth: 'public',
    title: 'Sign in',
    file: 'src/app/(auth)/signin/page.tsx',
    mobileArea: null,
  },
  {
    path: '/signup',
    kind: 'page',
    area: 'auth',
    auth: 'public',
    title: 'Create an account',
    file: 'src/app/(auth)/signup/page.tsx',
    mobileArea: null,
  },
  {
    path: '/onboarding',
    kind: 'page',
    area: 'auth',
    auth: 'self',
    title: 'Company onboarding',
    file: 'src/app/(auth)/onboarding/page.tsx',
    mobileArea: 'more',
  },
  {
    path: '/invite/:code',
    kind: 'page',
    area: 'auth',
    auth: 'public',
    title: 'Invitation landing',
    file: 'src/app/(auth)/invite/[code]/page.tsx',
    mobileArea: null,
  },

  // --- product areas (W057-W067) ------------------------------------------
  {
    path: '/chat',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Aurum chat',
    file: 'src/app/(product)/chat/page.tsx',
    mobileArea: 'chat',
  },
  {
    path: '/intelligence',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Intelligence — today’s briefing',
    file: 'src/app/(product)/intelligence/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/intelligence/goals/:goalId',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'The goal chain',
    file: 'src/app/(product)/intelligence/goals/[goalId]/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/intelligence/unknowns/:unknownId',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'One unknown',
    file: 'src/app/(product)/intelligence/unknowns/[unknownId]/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/intelligence/missions/:missionId',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'One learning mission',
    file: 'src/app/(product)/intelligence/missions/[missionId]/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/learning',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Learning — requests, contributions, rewards',
    file: 'src/app/(product)/learning/page.tsx',
    mobileArea: null,
  },
  {
    path: '/interventions',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Interventions — capability gaps & agent lifecycle',
    file: 'src/app/(product)/interventions/page.tsx',
    mobileArea: null,
  },
  {
    path: '/interventions/proposals/:proposalId',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'One intervention proposal',
    file: 'src/app/(product)/interventions/proposals/[proposalId]/page.tsx',
    mobileArea: null,
  },
  {
    path: '/interventions/agents/:agentId',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'One agent',
    file: 'src/app/(product)/interventions/agents/[agentId]/page.tsx',
    mobileArea: null,
  },
  {
    path: '/interventions/teams/:teamId',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'One agent team',
    file: 'src/app/(product)/interventions/teams/[teamId]/page.tsx',
    mobileArea: null,
  },
  {
    path: '/connections',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Connections — channels, sources, destinations',
    file: 'src/app/(product)/connections/page.tsx',
    mobileArea: null,
  },
  {
    path: '/marketplace',
    kind: 'page',
    area: 'product',
    auth: 'public',
    title: 'Marketplace — the governed catalog',
    file: 'src/app/(product)/marketplace/page.tsx',
    mobileArea: null,
  },
  {
    path: '/marketplace/installed',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Marketplace — installed packages',
    file: 'src/app/(product)/marketplace/installed/page.tsx',
    mobileArea: null,
  },
  {
    path: '/marketplace/installed/:extensionKey',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'One installed extension',
    file: 'src/app/(product)/marketplace/installed/[extensionKey]/page.tsx',
    mobileArea: null,
  },
  {
    path: '/marketplace/developer',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Marketplace — developer console',
    file: 'src/app/(product)/marketplace/developer/page.tsx',
    mobileArea: null,
  },
  {
    path: '/marketplace/package/:packageId',
    kind: 'page',
    area: 'product',
    auth: 'public',
    title: 'One marketplace package',
    file: 'src/app/(product)/marketplace/package/[packageId]/page.tsx',
    mobileArea: null,
  },
  {
    path: '/developer',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Developer — API, keys, webhooks & MCP',
    file: 'src/app/(product)/developer/page.tsx',
    mobileArea: null,
  },
  {
    path: '/ai',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'AI providers (BYOA)',
    file: 'src/app/(product)/ai/page.tsx',
    mobileArea: null,
  },
  {
    path: '/ai/preferences',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'AI preferences — what matters when Aurum uses AI (W091)',
    file: 'src/app/(product)/ai/preferences/page.tsx',
    mobileArea: null,
  },
  {
    path: '/ai/preferences/advanced',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Advanced AI settings — technical detail, authorized (W091)',
    file: 'src/app/(product)/ai/preferences/advanced/page.tsx',
    mobileArea: null,
  },
  {
    path: '/explain',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Evidence & audit — the index',
    file: 'src/app/(product)/explain/page.tsx',
    mobileArea: null,
  },
  {
    path: '/explain/:kind/:id',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'Explain one decision',
    file: 'src/app/(product)/explain/[kind]/[id]/page.tsx',
    mobileArea: null,
  },
  {
    path: '/more',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'More — management mode, platform tools, keyboard',
    file: 'src/app/(product)/more/page.tsx',
    mobileArea: 'more',
  },
  {
    path: '/people',
    kind: 'page',
    area: 'product',
    auth: 'required',
    title: 'People & workforce hub',
    file: 'src/app/(product)/people/page.tsx',
    mobileArea: 'people',
  },

  // --- management mode — the Control Tower (W033) -------------------------
  {
    path: '/today',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Today — the attention dashboard',
    file: 'src/app/(tower)/today/page.tsx',
    mobileArea: 'today',
  },
  {
    path: '/goals',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Goals',
    file: 'src/app/(tower)/goals/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/situation',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Situation',
    file: 'src/app/(tower)/situation/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/unknowns',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Unknowns',
    file: 'src/app/(tower)/unknowns/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/missions',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Missions',
    file: 'src/app/(tower)/missions/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/risks',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Risks',
    file: 'src/app/(tower)/risks/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/opportunities',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Opportunities',
    file: 'src/app/(tower)/opportunities/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/capabilities',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Capabilities',
    file: 'src/app/(tower)/capabilities/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/processes',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Processes',
    file: 'src/app/(tower)/processes/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/automation',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Automation',
    file: 'src/app/(tower)/automation/page.tsx',
    mobileArea: 'intelligence',
  },
  {
    path: '/workforce',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Workforce',
    file: 'src/app/(tower)/workforce/page.tsx',
    mobileArea: 'people',
  },
  {
    path: '/agents',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Agents',
    file: 'src/app/(tower)/agents/page.tsx',
    mobileArea: 'people',
  },
  {
    path: '/evidence',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Evidence',
    file: 'src/app/(tower)/evidence/page.tsx',
    mobileArea: 'more',
  },
  {
    path: '/recommendations',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Recommendations',
    file: 'src/app/(tower)/recommendations/page.tsx',
    mobileArea: 'more',
  },
  {
    path: '/approvals',
    kind: 'page',
    area: 'management',
    auth: 'required',
    title: 'Approvals — the human authority gate',
    file: 'src/app/(tower)/approvals/page.tsx',
    mobileArea: 'more',
  },

  // --- the API surface (thin adapters — the developer console documents) --
  {
    path: '/api/health',
    kind: 'api',
    area: 'api',
    auth: 'public',
    title: 'Health/readiness',
    file: 'src/app/api/health/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/sign-in',
    kind: 'api',
    area: 'api',
    auth: 'public',
    title: 'Sign in',
    file: 'src/app/api/auth/sign-in/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/sign-up',
    kind: 'api',
    area: 'api',
    auth: 'public',
    title: 'Sign up',
    file: 'src/app/api/auth/sign-up/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/sign-out',
    kind: 'api',
    area: 'api',
    auth: 'public',
    title: 'Sign out',
    file: 'src/app/api/auth/sign-out/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/invite',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Create invitation',
    file: 'src/app/api/auth/invite/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/invite/revoke',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Revoke invitation',
    file: 'src/app/api/auth/invite/revoke/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/invite/redeem',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Redeem invitation',
    file: 'src/app/api/auth/invite/redeem/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/session',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Session info',
    file: 'src/app/api/auth/session/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/session/selection',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Company/workspace selection',
    file: 'src/app/api/auth/session/selection/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/auth/onboarding/company',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Create company',
    file: 'src/app/api/auth/onboarding/company/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/tower/:surface',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Tower surface read',
    file: 'src/app/api/tower/[surface]/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/tower/approvals/:requestId/decide',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Tower approval decision',
    file: 'src/app/api/tower/approvals/[requestId]/decide/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/connections',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Connections read',
    file: 'src/app/api/connections/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/shell',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Shell state',
    file: 'src/app/api/product/shell/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/chat/state',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Chat state',
    file: 'src/app/api/product/chat/state/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/chat/messages',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Chat send',
    file: 'src/app/api/product/chat/messages/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/chat/approvals/:requestId/decide',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Chat inline approval decision',
    file: 'src/app/api/product/chat/approvals/[requestId]/decide/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/learning/requests/:planId/answer',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Answer a knowledge request',
    file: 'src/app/api/product/learning/requests/[planId]/answer/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/learning/missions/:missionId/ask',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Request the next knowledge question',
    file: 'src/app/api/product/learning/missions/[missionId]/ask/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/ai',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'AI providers (BYOA) surface',
    file: 'src/app/api/product/ai/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/ai/preferences',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'AI preferences surface (W091)',
    file: 'src/app/api/product/ai/preferences/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/interventions/agents/:agentId/lifecycle',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Agent lifecycle decision',
    file: 'src/app/api/product/interventions/agents/[agentId]/lifecycle/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/interventions/teams',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Compose agent team',
    file: 'src/app/api/product/interventions/teams/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/interventions/teams/:teamId/lifecycle',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Team lifecycle',
    file: 'src/app/api/product/interventions/teams/[teamId]/lifecycle/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/interventions/decisions/:decisionId/settle',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Settle an intervention decision',
    file: 'src/app/api/product/interventions/decisions/[decisionId]/settle/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/interventions/proposals/:proposalId/activate',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Activate a proposed intervention',
    file: 'src/app/api/product/interventions/proposals/[proposalId]/activate/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/interventions/proposals/:proposalId/decide',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Decide a proposed intervention',
    file: 'src/app/api/product/interventions/proposals/[proposalId]/decide/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/intelligence/briefing/deliver',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Deliver the briefing into chat',
    file: 'src/app/api/product/intelligence/briefing/deliver/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/marketplace/extension/:extensionKey/:action',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Installed-extension governance',
    file: 'src/app/api/product/marketplace/extension/[extensionKey]/[action]/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/marketplace/developer/:action',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Marketplace developer actions',
    file: 'src/app/api/product/marketplace/developer/[action]/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/marketplace/package/:packageId/:action',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Marketplace package actions',
    file: 'src/app/api/product/marketplace/package/[packageId]/[action]/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/product/developer',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Developer console actions',
    file: 'src/app/api/product/developer/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/worker',
    kind: 'api',
    area: 'api',
    auth: 'required',
    title: 'Worker execution seam',
    file: 'src/app/api/worker/route.ts',
    mobileArea: null,
  },
  {
    path: '/api/v1/*',
    kind: 'api',
    area: 'api',
    auth: 'public',
    title: 'The public API (bearer-authenticated)',
    file: 'src/app/api/v1/[[...path]]/route.ts',
    mobileArea: null,
  },
];

// ---------------------------------------------------------------------------
// Lookups and matching
// ---------------------------------------------------------------------------

const BY_PATH: ReadonlyMap<string, RouteSpec> = new Map(
  ROUTE_CATALOG.map((route) => [route.path, route]),
);

/** One route spec by exact pattern (throws — the catalog is closed). */
export function routeSpec(path: string): RouteSpec {
  const spec = BY_PATH.get(path);
  if (spec === undefined) {
    throw new Error(`unknown route '${path}' in the journey-proof route catalog`);
  }
  return spec;
}

/** Does the exact pattern exist? */
export function hasRoute(path: string): boolean {
  return BY_PATH.has(path);
}

/** All page routes (what a browser renders), in catalog order. */
export function pageRoutes(): RouteSpec[] {
  return ROUTE_CATALOG.filter((route) => route.kind !== 'api');
}

/** All API routes, in catalog order. */
export function apiRoutes(): RouteSpec[] {
  return ROUTE_CATALOG.filter((route) => route.kind === 'api');
}

/** Split a pattern/segment list on '/', decoding nothing. */
function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Match a concrete pathname against a `:param` pattern. Returns the params
 * (in order) on match, null otherwise. A trailing `*` segment matches any
 * remaining segments (the /api/v1 catch-all).
 */
export function matchRoutePattern(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternSegments = segments(pattern);
  const pathSegments = segments(pathname);
  if (patternSegments.includes('*')) {
    const starIndex = patternSegments.indexOf('*');
    if (pathSegments.length < starIndex) return null;
  } else if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]!;
    if (expected === '*') {
      params['*'] = pathSegments.slice(index).join('/');
      return params;
    }
    const actual = pathSegments[index];
    if (actual === undefined) return null;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/**
 * Which catalog route a concrete pathname belongs to (first match wins —
 * the catalog is ordered so exact literals precede parameterized patterns
 * where they could collide, e.g. /marketplace/installed before
 * /marketplace/package/:packageId and /marketplace itself).
 */
export function findRouteForPath(pathname: string): RouteSpec | null {
  for (const route of ROUTE_CATALOG) {
    if (route.kind === 'root-redirect' && pathname === '/') return route;
    if (matchRoutePattern(route.path, pathname) !== null) return route;
  }
  return null;
}

/** The five mobile areas, in plan §3 order. */
export const MOBILE_AREAS: readonly MobileAreaId[] = [
  'chat',
  'today',
  'intelligence',
  'people',
  'more',
];

/** Which routes the mobile bottom nav reaches directly. */
export function mobileNavRoutes(): RouteSpec[] {
  return ROUTE_CATALOG.filter((route) => route.mobileArea !== null && route.kind !== 'api');
}

/** Routes that are drill-downs on mobile (no direct bottom-nav entry). */
export function mobileDrillDownRoutes(): RouteSpec[] {
  return ROUTE_CATALOG.filter((route) => route.mobileArea === null && route.kind === 'page');
}
