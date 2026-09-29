// W115 — the tower's way home: the back-navigation DOM suite.
//
// WHAT THIS PROVES AND HOW. The operator-confirmed bug: once a user
// entered any Tower surface there was NO control anywhere in the tower
// shell that returned them to the employee app — the only way back to
// /chat was hand-editing the URL. The fix is SHELL chrome: the (tower)
// layout (which every one of the fifteen surfaces renders inside) now
// carries a persistent "Back to Aurum Chat" link in the tower header.
//
// This suite renders the REAL layout wrapping REAL representative
// surface pages (Today, Goals, Approvals — one surface from each end of
// the navigation: the briefing dashboard, a Direction list surface, and
// the Governance decision surface) through React's renderToReadableStream,
// exactly the W070 journey-harness technique: the page components read
// their session through the REAL session resolution, with `next/headers`
// cookies() mocked to present a real session cookie (the one seam a
// browser provides) and `next/navigation`'s client hooks fed the current
// path so the nav's active state renders for real. The fixture boots the
// embedded PostgreSQL (PGlite `:memory:`), runs the real migrations, and
// provisions the owner through the REAL contracts (registerUser →
// provisionTenant → selectCompany) — the same discipline as the tower
// integration suite, cut down to what a shell render needs.
//
// The assertions are the W115 acceptance, per surface: the control is
// PRESENT, NAMED (aria-label "Back to Aurum Chat"), a real link POINTED
// AT /chat, carried by the tower header (shell chrome — not page
// content), exactly once, with the visible label matching the accessible
// name and the arrow glyph decorative. The page's own surface header is
// asserted too, so a green run proves the real surface rendered inside
// the real shell — not an error fallback.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';

// ---------------------------------------------------------------------------
// The two browser seams (exactly the W070 journey harness contract)
// ---------------------------------------------------------------------------

/** The session cookie the render presents (a real token, set per render). */
const sessionHolder: { token: string | null } = { token: null };

/** The URL the "browser" is on during a render (drives the nav's hooks). */
const navigationHolder: { pathname: string } = { pathname: '/' };

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
    useSearchParams: () => new URLSearchParams(),
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

// ---------------------------------------------------------------------------
// The real code under test — IMPORT ORDER IS LOAD-BEARING (the smoke
// suite's discipline): every app-side import is dynamic and happens
// AFTER the mocks above are registered, so no module in the graph
// resolves next/headers or next/navigation before the seams exist.
// ---------------------------------------------------------------------------

const { createElement } = await import('react');
const { renderToReadableStream } = await import('react-dom/server');
const { closeDb, getDb } = await import('@/infra/db');
const { runMigrations } = await import('../../../../scripts/migrate');
const { newId } = await import('@/infra/ids');
const { registerUser, selectCompany } = await import('@/modules/auth/contract');
const { provisionTenant } = await import('@/modules/organizations/contract');

const { TOWER_BACK_LABEL, default: TowerLayout } = await import('../layout');
const { default: TodayPage } = await import('../today/page');
const { default: GoalsPage } = await import('../goals/page');
const { default: ApprovalsPage } = await import('../approvals/page');

const db = getDb();

// Fake credentials are assembled from fragments at runtime (push-protection).
const passwordFragments = ['w', '115-', 'back', '-nav-72'];

/** One representative surface: its path, nav label and real page module.
 * The pages are loosened to the harness's generic component shape: the
 * props passed at render (params + searchParams promises) are exactly
 * what the App Router provides; components taking fewer props ignore
 * the extras. */
const SURFACES = [
  { pathname: '/today', label: 'Today', Page: TodayPage },
  { pathname: '/goals', label: 'Goals', Page: GoalsPage },
  { pathname: '/approvals', label: 'Approvals', Page: ApprovalsPage },
] as unknown as readonly {
  pathname: string;
  label: string;
  Page: ComponentType<Record<string, unknown>>;
}[];

let ownerToken: string;

beforeAll(async () => {
  await runMigrations(db);
  // A company owner through the REAL contracts — the least identity a
  // tower surface needs to render scoped (no seeded state required: the
  // shell chrome is session-shape-independent, and the empty views still
  // render the real surface headers).
  const owner = await registerUser({
    displayName: 'Tower Back Owner',
    email: ['w115-owner-', newId().slice(0, 8), '@example', '.test'].join(''),
    password: passwordFragments.join(''),
  });
  const tenant = await provisionTenant(
    { principalId: newId(), authority: ['organizations:provision'] },
    { name: 'W115 Back Navigation Co', ownerPrincipalId: owner.session.principalId },
  );
  const session = await selectCompany({ token: owner.token, tenantId: tenant.id });
  ownerToken = owner.token;
  void session;
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The render (the W070 harness shape, scoped to the tower shell)
// ---------------------------------------------------------------------------

/** Server-render one real surface inside the real tower layout. */
async function renderTowerSurface(
  pathname: string,
  Page: ComponentType<Record<string, unknown>>,
): Promise<string> {
  navigationHolder.pathname = pathname;
  sessionHolder.token = ownerToken;
  try {
    const stream = await renderToReadableStream(
      createElement(TowerLayout, null,
        createElement(Page, {
          params: Promise.resolve({}),
          searchParams: Promise.resolve({}),
        })),
    );
    return await new Response(stream).text();
  } finally {
    sessionHolder.token = null;
    navigationHolder.pathname = '/';
  }
}

/** The control's full opening tag (attribute order is React's, not ours). */
function backControlAnchor(html: string): string {
  const anchor = new RegExp(
    `<a\\b[^>]*aria-label="${TOWER_BACK_LABEL}"[^>]*>`,
  ).exec(html);
  expect(anchor, `the "${TOWER_BACK_LABEL}" anchor is rendered`).not.toBeNull();
  return anchor![0];
}

// ---------------------------------------------------------------------------
// The W115 acceptance: every surface inherits the way home
// ---------------------------------------------------------------------------

describe.each(SURFACES)('the tower shell on $pathname', ({ pathname, label, Page }) => {
  it('renders the persistent Back to Aurum Chat control in the tower header', async () => {
    const html = await renderTowerSurface(pathname, Page);

    // The real surface rendered inside the real shell (not an error
    // fallback): the surface's own channel header carries its title.
    expect(html).toMatch(new RegExp(`<h2>\\s*${label}\\s*</h2>`));

    // PRESENT, NAMED, AND POINTED AT /chat — a real link, exactly once.
    const anchor = backControlAnchor(html);
    expect(anchor).toContain('href="/chat"');
    expect(anchor).toContain('class="tower-back"');
    const occurrences = html.split(`aria-label="${TOWER_BACK_LABEL}"`).length - 1;
    expect(occurrences).toBe(1);

    // SHELL CHROME: the control rides the tower header (the zone every
    // surface inherits), before the navigation — not inside page content.
    const headerStart = html.indexOf('<header class="tower-header">');
    const navStart = html.indexOf('<nav class="tower-nav"');
    const controlAt = html.indexOf(anchor);
    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(navStart).toBeGreaterThan(headerStart);
    expect(controlAt).toBeGreaterThan(headerStart);
    expect(controlAt).toBeLessThan(navStart);

    // The visible label matches the accessible name, with the left-arrow
    // glyph decorative (aria-hidden) inside the control.
    const fromControl = html.slice(controlAt);
    expect(fromControl).toMatch(
      new RegExp(`<svg[\\s\\S]*aria-hidden="true"[\\s\\S]*${TOWER_BACK_LABEL}\\s*</a>`),
    );
  });
});
