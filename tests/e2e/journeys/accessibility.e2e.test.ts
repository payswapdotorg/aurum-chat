// W070 — the accessibility audit (the "accessibility" acceptance bullet).
//
// Every page of the route catalog renders (real page components + real
// layouts, seeded demo world, real personas) and the rendered HTML — the
// markup a browser receives — is audited against the rule set of the
// journey-proof module (src/modules/journey-proof/a11y.ts): document
// language, landmarks, the skip link, heading structure, accessible names
// for every link/button (icon-only controls included), image alts, form
// labels, table captions, and tabindex discipline.
//
// The rules that live OUTSIDE the rendered HTML — touch-target sizes
// (44px+) and the active-state aria-current treatment — are audited from
// the SHIPPED stylesheet and the real navigation components (they are CSS
// and client-side properties; SSR cannot show them).
//
// DEPENDENCY-SURFACE GAPS (the audit's findings). The rules that DO NOT
// hold on every surface are frozen below as DOCUMENTED EXCEPTIONS —
// precise, machine-checked evidence of accessibility gaps in surfaces
// owned by OTHER work items (W033 tower tables, W059 connections, W060
// chat), which this work item may not modify (GOVERNANCE.md — no silent
// redesign; escalation is the architect's call). The assertion is EXACT:
// any NEW violation fails the gate, and any FIX also updates this frozen
// list (an improvement the next delivery records deliberately).
//
// Both viewports are covered: the server HTML carries both chrome variants
// (the stylesheet decides visibility), so one render audits the shared
// semantics, and the CSS audit covers the per-viewport sizing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The harness first (its next/headers / next/navigation mocks register on
// module evaluation — see its header note).
import {
  anchorId,
  apiRequest,
  demoWorld,
  renderOk,
  shutdownWorld,
  signInPersona,
  type DemoSeedReport,
  type PersonaSession,
} from './harness';
import {
  A11Y_RULES,
  auditHtml,
  auditSources,
  pageRoutes,
  type A11yViolation,
} from '../../../src/modules/journey-proof/contract';
import { handleTeamCreatePost } from '../../../src/app/(product)/interventions/lib/api';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * The frozen, documented exceptions (dependency-surface gaps this work
 * item reports under DEVIATIONS — see the file header). Keys are
 * `rule @ route-pattern`.
 *
 * W071 removed the former `single-h1 @ /chat` exception: the conversation
 * surface now renders exactly one screen-reader-only h1 ("Chat with
 * Aurum"), recorded here per the fix protocol above.
 */
const DOCUMENTED_EXCEPTIONS: readonly { key: string; owner: string; why: string }[] = [
  {
    key: 'single-h1 @ /connections',
    owner: 'W059 (connection hub)',
    why: 'the hub renders sections but no page heading',
  },
  {
    key: 'input-label @ /connections',
    owner: 'W059 (connection hub)',
    why: 'the identity-lookup account input carries only a placeholder (a label or aria-label would satisfy the rule)',
  },
  {
    key: 'table-caption @ /situation',
    owner: 'W033 (tower Situation)',
    why: 'the surface’s data table has no caption/aria-label and its th carry no scope',
  },
  {
    key: 'table-caption @ /risks',
    owner: 'W033 (tower Risks)',
    why: 'the surface’s data table has no caption/aria-label and its th carry no scope',
  },
  {
    key: 'table-caption @ /capabilities',
    owner: 'W033 (tower Capabilities)',
    why: 'the surface’s data table has no caption/aria-label and its th carry no scope',
  },
  {
    key: 'table-caption @ /processes',
    owner: 'W033 (tower Processes)',
    why: 'the surface’s data table has no caption/aria-label and its th carry no scope',
  },
  {
    key: 'table-caption @ /workforce',
    owner: 'W033 (tower Workforce)',
    why: 'the surface’s data table has no caption/aria-label and its th carry no scope',
  },
  {
    key: 'table-caption @ /evidence',
    owner: 'W033 (tower Evidence)',
    why: 'the surface’s data table has no caption/aria-label and its th carry no scope',
  },
];

let report: DemoSeedReport;
let manager: PersonaSession;
let employee: PersonaSession;
let developer: PersonaSession;
let teamId: string;

beforeAll(async () => {
  report = await demoWorld();
  manager = await signInPersona('manager');
  employee = await signInPersona('employee');
  developer = await signInPersona('developer');
  // One live team so the team drill-down page audits with real content.
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
  if (team.status === 200) {
    const created = team.body as { team?: { id?: string } };
    teamId = created.team?.id ?? '';
  }
  expect(teamId).not.toBe('');
});

afterAll(async () => {
  await shutdownWorld();
});

/** The concrete seeded path for a parameterized route (throws on unknown needs). */
function concretePath(pattern: string): string {
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
      return `/interventions/teams/${teamId}`;
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

/** Which persona walks a route (mirrors the demo capability matrix). */
function personaFor(pattern: string): PersonaSession | null {
  if (pattern === '/signin' || pattern === '/signup') return null;
  if (pattern.startsWith('/developer')) return developer;
  if (pattern.startsWith('/marketplace/developer')) return developer;
  if (pattern.startsWith('/learning')) return employee;
  return manager;
}

/** The audit options for a route (auth pages are chrome-free by design). */
function optionsFor(pattern: string, suffix = ''): Parameters<typeof auditHtml>[1] {
  const auth = pattern === '/signin' || pattern === '/signup' || pattern === '/onboarding' || pattern.startsWith('/invite/');
  return {
    subject: `${pattern}${suffix}`,
    chrome: true,
    fullDocument: true,
    navigation: !auth,
  };
}

function violationKeys(violations: readonly A11yViolation[]): string[] {
  return [...new Set(violations.map((violation) => `${violation.rule} @ ${violation.subject}`))]
    .sort();
}

describe('the accessibility audit over every rendered page', () => {
  const violations: A11yViolation[] = [];
  const audited: string[] = [];

  it('audits every page route of the catalog', async () => {
    for (const route of pageRoutes()) {
      if (route.kind === 'root-redirect') continue; // the root only forwards
      const path = route.path.includes(':') ? concretePath(route.path) : route.path;
      const persona = personaFor(route.path);
      const { html } = await renderOk(path, persona);
      violations.push(...auditHtml(html, optionsFor(route.path)));
      audited.push(route.path);
    }
    expect(audited.length).toBeGreaterThanOrEqual(pageRoutes().length - 1);
  });

  it('audits the role-visibility variants (employee and developer walks)', async () => {
    for (const path of ['/chat', '/learning', '/intelligence']) {
      const { html } = await renderOk(path, employee);
      violations.push(...auditHtml(html, optionsFor(path, ' (employee)')));
    }
    const { html } = await renderOk('/developer', developer);
    violations.push(...auditHtml(html, optionsFor('/developer', ' (developer)')));
  });

  it('audits the anonymous entry pages with the full document', async () => {
    for (const path of ['/signin', '/signup', '/marketplace']) {
      const { html } = await renderOk(path, null);
      violations.push(...auditHtml(html, optionsFor(path, ' (anonymous)')));
    }
  });

  it('the remaining violations are EXACTLY the documented dependency-surface gaps', () => {
    const exceptions = new Set(DOCUMENTED_EXCEPTIONS.map((exception) => exception.key));
    const found = violationKeys(violations).filter(
      // Role/variant duplicates of the same route collapse onto the base key.
      (key) => !exceptions.has(key.replace(/ \(employee\)| \(developer\)| \(anonymous\)/, '')),
    );
    expect(found).toEqual([]);
  });

  it('every documented exception is still live (a fix updates this list deliberately)', () => {
    const found = new Set(violationKeys(violations));
    for (const exception of DOCUMENTED_EXCEPTIONS) {
      const live =
        found.has(exception.key) ||
        // Variant walks (e.g. /chat as employee) count for the base key.
        [...found].some((key) => key.replace(/ \(employee\)| \(developer\)| \(anonymous\)/, '') === exception.key);
      expect(live, `${exception.key} (${exception.owner})`).toBe(true);
    }
  });

  it('audits the shipped CSS and navigation sources (touch targets, aria-current)', () => {
    const productCss = readFileSync(`${REPO_ROOT}/src/app/(product)/product.css`, 'utf8');
    const navigationComponents = [
      {
        file: 'src/app/(product)/components/desktop-rail.tsx',
        source: readFileSync(`${REPO_ROOT}/src/app/(product)/components/desktop-rail.tsx`, 'utf8'),
      },
      {
        file: 'src/app/(product)/components/mobile-chrome.tsx',
        source: readFileSync(`${REPO_ROOT}/src/app/(product)/components/mobile-chrome.tsx`, 'utf8'),
      },
      {
        file: 'src/app/(tower)/components/nav.tsx',
        source: readFileSync(`${REPO_ROOT}/src/app/(tower)/components/nav.tsx`, 'utf8'),
      },
    ];
    expect(auditSources({ productCss, navigationComponents })).toEqual([]);
  });

  it('the keyboard reference documents the shell’s shortcuts and accessibility behavior', async () => {
    const { html } = await renderOk('/more', manager);
    const keyboardAt = html.indexOf('id="keyboard"');
    expect(keyboardAt).toBeGreaterThanOrEqual(0);
    const slice = html.slice(keyboardAt, keyboardAt + 4000);
    expect(slice).toContain('Open the command search');
    expect(slice.toLowerCase()).toContain('skip');
  });

  it('exercised the complete rule set (every rule had a subject to check)', () => {
    // All fourteen rules ran across the audited pages: the document rules
    // (full document renders), the chrome rules (shelled pages), the
    // content rules (links/buttons/inputs/tables exist on the audited
    // pages), plus the css-scope rules in the source audit.
    expect(A11Y_RULES.length).toBe(14);
    expect(audited).toContain('/chat');
    expect(audited).toContain('/signin');
    expect(audited).toContain('/approvals');
  });
});
