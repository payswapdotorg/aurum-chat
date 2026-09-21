// Unit tests of the journey-proof module (W070) — the PURE halves: the
// matrix's internal consistency, the route catalog's well-formedness and
// reality (every catalog entry's file exists on disk), the capability
// map's coverage of every src/modules module, the accessibility engine
// on synthetic HTML, and the link-graph evaluators.
//
// The EXECUTION suites (rendering real pages, walking real journeys)
// live in tests/e2e/journeys/**.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  A11Y_RULES,
  CAPABILITY_ROUTES,
  JOURNEY_MATRIX,
  ROUTE_CATALOG,
  W070_ACCEPTANCE_BULLETS,
  a11yRule,
  auditHtml,
  auditSources,
  capabilityRouteGaps,
  deadEndViolations,
  evaluateMobileReachability,
  extractPageLinks,
  findRouteForPath,
  hasRoute,
  matchRoutePattern,
  matrixConsistency,
  pageRoutes,
  reportComplete,
} from '../contract';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

// ---------------------------------------------------------------------------
// The journey matrix
// ---------------------------------------------------------------------------

describe('the W070 journey matrix', () => {
  it('is internally consistent (routes exist, actors declared, one entry per acceptance bullet)', () => {
    expect(matrixConsistency()).toEqual([]);
  });

  it('covers every acceptance bullet of the work item exactly once', () => {
    const bullets = JOURNEY_MATRIX.map((journey) => journey.acceptance);
    expect(bullets.sort()).toEqual([...W070_ACCEPTANCE_BULLETS].sort());
  });

  it('declares both viewports for every product journey (desktop and mobile)', () => {
    for (const journey of JOURNEY_MATRIX) {
      if (journey.id === 'mobile-navigation') {
        expect(journey.viewports).toEqual(['mobile']);
        continue;
      }
      expect(journey.viewports).toContain('desktop');
      expect(journey.viewports).toContain('mobile');
    }
  });

  it('walks every step through routes that exist in the catalog', () => {
    for (const journey of JOURNEY_MATRIX) {
      for (const step of journey.steps) {
        expect(hasRoute(step.route), `${journey.id}/${step.id} → ${step.route}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The route catalog
// ---------------------------------------------------------------------------

describe('the route catalog', () => {
  it('has unique paths', () => {
    const paths = ROUTE_CATALOG.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('declares well-formed patterns (absolute, no empty segments)', () => {
    for (const route of ROUTE_CATALOG) {
      expect(route.path.startsWith('/'), route.path).toBe(true);
      expect(route.path.includes('//'), route.path).toBe(false);
      expect(route.path.endsWith('/') && route.path !== '/', route.path).toBe(false);
    }
  });

  it('points at files that exist in the repository (route reality)', () => {
    const missing: string[] = [];
    for (const route of ROUTE_CATALOG) {
      if (!existsSync(`${REPO_ROOT}/${route.file}`)) {
        missing.push(`${route.path} → ${route.file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('matches concrete paths, literals before parameterized', () => {
    expect(findRouteForPath('/marketplace/installed')?.path).toBe('/marketplace/installed');
    expect(findRouteForPath('/marketplace/installed/roast-batch-tracker')?.path).toBe(
      '/marketplace/installed/:extensionKey',
    );
    expect(findRouteForPath('/marketplace/package/abc-123')?.path).toBe(
      '/marketplace/package/:packageId',
    );
    expect(findRouteForPath('/intelligence/goals/g-1')?.path).toBe(
      '/intelligence/goals/:goalId',
    );
    expect(findRouteForPath('/api/v1/goals')?.path).toBe('/api/v1/*');
    expect(findRouteForPath('/api/v1/goals/g-1/versions')?.path).toBe('/api/v1/*');
    expect(findRouteForPath('/nowhere/at/all')).toBeNull();
    expect(matchRoutePattern('/invite/:code', '/invite/ABC123')).toEqual({ code: 'ABC123' });
    expect(matchRoutePattern('/invite/:code', '/invite/a/b')).toBeNull();
  });

  it('every page route is auth-classified and mobile-classified or explicitly drill-down', () => {
    for (const route of pageRoutes()) {
      expect(['required', 'public', 'self']).toContain(route.auth);
    }
  });
});

// ---------------------------------------------------------------------------
// The capability discoverability map
// ---------------------------------------------------------------------------

describe('the capability discoverability map', () => {
  it('references only routes that exist in the catalog', () => {
    expect(capabilityRouteGaps(ROUTE_CATALOG.map((route) => route.path))).toEqual([]);
  });

  it('has no route-less product capabilities (instruments are explicit)', () => {
    for (const capability of CAPABILITY_ROUTES) {
      if (capability.instrument) continue;
      expect(capability.routes.length, capability.module).toBeGreaterThan(0);
      expect(capability.surfaces.length, capability.module).toBeGreaterThan(0);
    }
  });

  it('covers every module folder of src/modules (the architecture capability set)', () => {
    const modules = readdirSync(`${REPO_ROOT}/src/modules`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const mapped = new Set(CAPABILITY_ROUTES.map((capability) => capability.module));
    expect(mapped.size).toBe(CAPABILITY_ROUTES.length); // no duplicates
    const missing = modules.filter((module) => !mapped.has(module));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The accessibility engine (synthetic HTML)
// ---------------------------------------------------------------------------

const GOOD_PAGE = `<!DOCTYPE html>
<html lang="en"><body>
<a class="skip" href="#main">Skip to content</a>
<header></header>
<nav aria-label="Primary"><a href="/chat">Chat</a></nav>
<main id="main">
  <h1>Intelligence</h1>
  <section><h2>Findings</h2><p>Nothing yet. <a href="/goals">See goals</a></p></section>
  <section><h3>Sub</h3><img alt="A chart" src="/chart.png"></section>
  <label for="q">Ask</label><input id="q" type="text" aria-label="Ask Aurum">
  <button type="button" aria-label="Send">➤</button>
  <table><caption>Shortcuts</caption><thead><tr><th scope="col">Key</th></tr></thead><tbody><tr><td>⌘K</td></tr></tbody></table>
</main>
<footer></footer>
</body></html>`;

describe('auditHtml', () => {
  it('passes a well-formed page', () => {
    expect(
      auditHtml(GOOD_PAGE, { subject: '/good', chrome: true, fullDocument: true }),
    ).toEqual([]);
  });

  it('flags a missing document language', () => {
    const violations = auditHtml(GOOD_PAGE.replace(' lang="en"', ''), {
      subject: '/x',
      chrome: true,
      fullDocument: true,
    });
    expect(violations.map((violation) => violation.rule)).toContain('document-lang');
  });

  it('flags missing landmarks and skip link for chrome pages', () => {
    const bare = '<html lang="en"><body><main><h1>Hi</h1><p>ok</p></main></body></html>';
    const violations = auditHtml(bare, {
      subject: '/x',
      chrome: true,
      fullDocument: true,
    });
    const rules = violations.map((violation) => violation.rule);
    expect(rules).toContain('landmark-navigation');
    expect(rules).toContain('skip-link');
  });

  it('does not demand chrome when the page renders bare', () => {
    const bare = '<html lang="en"><body><main><h1>Hi</h1><p>ok</p></main></body></html>';
    expect(
      auditHtml(bare, { subject: '/x', chrome: false, fullDocument: true }),
    ).toEqual([]);
  });

  it('flags multiple or missing h1 and skipped heading order', () => {
    const bad = '<html lang="en"><body><main><h1>A</h1><h1>B</h1><h4>skipped</h4></main></body></html>';
    const rules = auditHtml(bad, {
      subject: '/x',
      chrome: false,
      fullDocument: true,
    }).map((violation) => violation.rule);
    expect(rules).toContain('single-h1');
    expect(rules).toContain('heading-order');
  });

  it('flags images without alt, unnamed buttons and unnamed links', () => {
    const bad = `<html lang="en"><body><main><h1>A</h1>
      <img src="/x.png">
      <button type="button"><svg></svg></button>
      <a href="/chat"><svg></svg></a>
    </main></body></html>`;
    const rules = auditHtml(bad, {
      subject: '/x',
      chrome: false,
      fullDocument: true,
    }).map((violation) => violation.rule);
    expect(rules).toContain('img-alt');
    expect(rules).toContain('button-name');
    expect(rules).toContain('link-name');
  });

  it('accepts icon-only controls that carry aria-label', () => {
    const good = `<html lang="en"><body><main><h1>A</h1>
      <button type="button" aria-label="Search"><svg></svg></button>
    </main></body></html>`;
    expect(
      auditHtml(good, { subject: '/x', chrome: false, fullDocument: true }),
    ).toEqual([]);
  });

  it('flags unlabeled inputs and positive tabindex', () => {
    const bad = `<html lang="en"><body><main><h1>A</h1>
      <input type="text" id="q">
      <a href="/chat" tabindex="2">Chat</a>
    </main></body></html>`;
    const rules = auditHtml(bad, {
      subject: '/x',
      chrome: false,
      fullDocument: true,
    }).map((violation) => violation.rule);
    expect(rules).toContain('input-label');
    expect(rules).toContain('no-positive-tabindex');
  });

  it('flags tables without captions and th without scope', () => {
    const bad = `<html lang="en"><body><main><h1>A</h1>
      <table><thead><tr><th>Key</th></tr></thead><tbody><tr><td>k</td></tr></tbody></table>
    </main></body></html>`;
    const rules = auditHtml(bad, {
      subject: '/x',
      chrome: false,
      fullDocument: true,
    }).map((violation) => violation.rule);
    expect(rules).toContain('table-caption');
  });

  it('ignores hidden controls (aria-hidden decorations)', () => {
    const page = `<html lang="en"><body><main><h1>A</h1>
      <button type="button" aria-hidden="true"><svg></svg></button>
    </main></body></html>`;
    expect(
      auditHtml(page, { subject: '/x', chrome: false, fullDocument: true }),
    ).toEqual([]);
  });
});

describe('auditSources', () => {
  it('accepts the shipped touch-target and aria-current treatment', () => {
    const violations = auditSources({
      productCss:
        '.aurum-bottomnav ul { grid-template-columns: repeat(5, 1fr); } .aurum-bottomnav a { min-height: 56px; } .aurum-icon-btn { width: 44px; height: 44px; }',
      navigationComponents: [
        { file: 'rail.tsx', source: 'aria-current={active === area.id ? "page" : undefined}' },
      ],
    });
    expect(violations).toEqual([]);
  });

  it('flags undersized touch targets and missing aria-current', () => {
    const violations = auditSources({
      productCss: '.aurum-bottomnav ul { grid-template-columns: repeat(5, 1fr); } .aurum-bottomnav a { min-height: 30px; }',
      navigationComponents: [{ file: 'rail.tsx', source: '<Link href="/chat" />' }],
    });
    const rules = violations.map((violation) => violation.rule);
    expect(rules).toContain('touch-target');
    expect(rules).toContain('nav-aria-current');
  });
});

describe('the rule catalog', () => {
  it('has unique ids', () => {
    const ids = A11Y_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => a11yRule('document-lang')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The link graph and report evaluators
// ---------------------------------------------------------------------------

describe('extractPageLinks', () => {
  it('extracts in-app links with resolved paths and names, skipping hashes and externals', () => {
    const html = `<main>
      <a href="/intelligence">Intelligence</a>
      <a href="/chat?c=123#bottom">Chat thread</a>
      <a href="#keyboard">Shortcuts</a>
      <a href="https://example.com/x">External</a>
      <a href="mailto:x@y.z">Mail</a>
    </main>`;
    const links = extractPageLinks(html, '/more');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ href: '/intelligence', resolved: '/intelligence', accessibleName: 'Intelligence' });
    expect(links[1]?.resolved).toBe('/chat?c=123#bottom');
  });
});

describe('the report evaluators', () => {
  it('deadEndViolations lists broken links and link-less pages', () => {
    const violations = deadEndViolations([
      {
        route: '/good',
        links: [{ href: '/other', resolved: '/other', accessibleName: 'Other' }],
        broken: [],
        onward: [{ href: '/other', resolved: '/other', accessibleName: 'Other' }],
      },
      {
        route: '/bad',
        links: [{ href: '/nowhere', resolved: '/nowhere', accessibleName: 'Nowhere' }],
        broken: [{ href: '/nowhere', resolved: '/nowhere', accessibleName: 'Nowhere' }],
        onward: [],
      },
    ]);
    expect(violations).toEqual([
      '/bad: broken link → /nowhere (“Nowhere”)',
      '/bad: no onward in-app link (dead end)',
    ]);
  });

  it('reportComplete demands every journey proven and none failed', () => {
    const base = {
      results: [] as never[],
      pagesAudited: [],
      capabilitiesCovered: [],
    };
    const empty = reportComplete(base);
    expect(empty.complete).toBe(false);
    expect(empty.missing.length).toBe(JOURNEY_MATRIX.length);
    const allPassing = {
      ...base,
      results: JOURNEY_MATRIX.map((journey) => ({
        journeyId: journey.id,
        viewport: 'both' as const,
        actor: 'multi' as const,
        passed: true,
        failedStep: null,
        detail: 'ok',
      })),
    };
    expect(reportComplete(allPassing).complete).toBe(true);
    const oneFailed = {
      ...allPassing,
      results: [
        ...allPassing.results.slice(0, -1),
        { ...allPassing.results[allPassing.results.length - 1]!, passed: false, failedStep: 'x', detail: 'boom' },
      ],
    };
    const verdict = reportComplete(oneFailed);
    expect(verdict.complete).toBe(false);
    expect(verdict.failed).toHaveLength(1);
  });
});

describe('evaluateMobileReachability', () => {
  it('marks routes reachable via nav, command search or hub, and flags the rest', () => {
    const verdicts = evaluateMobileReachability(
      {
        mobileNavAreas: ['/chat', '/today'],
        commandRegistryRoutes: ['/learning'],
        hubRoutes: ['/developer'],
      },
      ['/chat', '/today', '/learning', '/developer', '/interventions'],
    );
    expect(verdicts).toEqual([
      { route: '/chat', reachable: true, via: 'mobile-nav' },
      { route: '/today', reachable: true, via: 'mobile-nav' },
      { route: '/learning', reachable: true, via: 'command-search' },
      { route: '/developer', reachable: true, via: 'hub' },
      { route: '/interventions', reachable: false, via: null },
    ]);
  });
});
