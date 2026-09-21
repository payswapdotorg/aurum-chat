// W075 — the natural-capability-discovery proof (the "reachable ≠
// naturally discovered" correction of plan §4), exercised against the
// REAL surface code the way the W070 suites are: the deterministic demo
// world, the real session flow, and the real server-rendered HTML of
// the discovery surfaces this wave owns.
//
//   * THE CAPABILITY HUB — /more renders EVERY capability family of the
//     intent registry (the `Chat → Search/More → capability hub` frame):
//     every static product surface, the fifteen management-mode surfaces
//     under user-intent groupings (not the tower taxonomy), the account
//     path, and the return path back to the conversation;
//   * THE CONTEXTUAL PROMPTS — the blocked-state panel (missing
//     connection / no suitable model / capability not installed /
//     integrate with your tools) renders with its entry points, so a
//     blocked moment is never a dead end;
//   * TASK LANGUAGE — the rendered labels are intent phrases and the
//     pre-W075 module-first patterns are gone;
//   * MOBILE REACHABILITY — the same /more HTML carries the mobile
//     shell (bottom nav + top bar), so every hub destination is
//     reachable on mobile through the More area of the bottom nav —
//     no capability depends on the command search alone.
//
// The pure halves (registry completeness, task-query matching, prompt
// consistency, command-search suggestions) are locked by the unit
// suite: src/app/(product)/tests/capability-discovery-unit.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The harness first (its next/headers / next/navigation mocks register on
// module evaluation — see its header note).
import { demoWorld, renderOk, shutdownWorld, signInPersona } from './harness';
import { extractPageLinks } from '../../../src/modules/journey-proof/contract';
import {
  CAPABILITY_FAMILIES,
  CAPABILITY_PROMPTS,
  capabilityEntries,
} from '../../../src/app/(product)/lib/capability-hub';
import { buildShellCommands } from '../../../src/app/(product)/lib/command-registry';
import { towerSurfaceLinks } from '../../../src/app/(product)/lib/navigation';

let moreHtml: string;
let moreLinks: Set<string>;

beforeAll(async () => {
  await demoWorld();
  const manager = await signInPersona('manager');
  const { html } = await renderOk('/more', manager);
  moreHtml = html;
  moreLinks = new Set(
    extractPageLinks(moreHtml, '/more').map(
      (link) => link.resolved.split('?')[0]?.split('#')[0] ?? link.resolved,
    ),
  );
});

afterAll(async () => {
  await shutdownWorld();
});

// ---------------------------------------------------------------------------
// The capability hub: the complete, intent-grouped index
// ---------------------------------------------------------------------------

describe('the More capability hub (the Chat → Search/More → capability hub frame)', () => {
  it('renders every capability family with its intent heading', () => {
    for (const family of CAPABILITY_FAMILIES) {
      expect(moreHtml, family.heading).toContain(family.heading);
    }
    // The intent headings the plan's journeys demand: the systems
    // connection path (G), the AI provider path (H), the marketplace
    // path (J), the integrate path (L) and the management bridge.
    expect(moreHtml).toContain('Connect your systems');
    expect(moreHtml).toContain('Choose the AI Aurum uses');
    expect(moreHtml).toContain('Extend Aurum’s capabilities');
    expect(moreHtml).toContain('Integrate Aurum with your tools');
    expect(moreHtml).toContain('Run and govern the company');
  });

  it('links every hub entry — the complete index, scope-preserving', () => {
    for (const entry of capabilityEntries()) {
      expect(moreLinks.has(entry.href), entry.href).toBe(true);
    }
  });

  it('links the working surfaces the pre-W075 More page omitted', () => {
    // Before W075 the More page did not link these: connections was
    // rail+search-only (and search-only on mobile), and the marketplace,
    // learning, interventions, intelligence and people surfaces were
    // absent from the "everything in one honest list".
    for (const href of [
      '/connections',
      '/marketplace',
      '/marketplace/installed',
      '/marketplace/developer',
      '/learning',
      '/interventions',
      '/intelligence',
      '/people',
      '/developer',
      '/ai',
      '/explain',
      '/onboarding',
    ]) {
      expect(moreLinks.has(href), href).toBe(true);
    }
  });

  it('carries the return path to the conversation (Chat → More → Chat)', () => {
    expect(moreLinks.has('/chat')).toBe(true);
    expect(moreHtml).toContain('Talk with Aurum');
  });

  it('the management-mode bridge groups the fifteen tower surfaces by user intent, not the tower taxonomy', () => {
    for (const link of towerSurfaceLinks()) {
      expect(moreLinks.has(link.href), link.href).toBe(true);
    }
    // The pre-W075 hub rendered the tower's internal group names as the
    // grouping notes ("Overview", "Direction", "People & Systems",
    // "Governance"). The corrected hub groups by what the user came to
    // decide; the taxonomy notes are gone.
    expect(moreHtml).not.toContain('>People &amp; Systems<');
    expect(moreHtml).not.toContain('>Governance<');
    expect(moreHtml).not.toContain('>Direction<');
    expect(moreHtml).toContain('management mode');
  });
});

// ---------------------------------------------------------------------------
// The contextual prompts (blocked states are not dead ends)
// ---------------------------------------------------------------------------

describe('the contextual capability prompts', () => {
  it('renders the when-Aurum-can’t panel with all four prompt entry points', () => {
    expect(moreHtml).toContain('When Aurum can’t do something yet');
    for (const prompt of CAPABILITY_PROMPTS) {
      expect(moreHtml, prompt.label).toContain(prompt.label);
      expect(moreLinks.has(prompt.href), prompt.href).toBe(true);
    }
    // The plan §3 Journey H phrasing: "no suitable model is available"
    // must lead to the provider path — and the panel says exactly that.
    expect(moreHtml).toContain('No suitable model is available to answer');
    // Journey G: the missing-connection path.
    expect(moreHtml).toContain('Connect the missing system');
  });

  it('the command search carries the account path and the task keywords (registry evidence)', () => {
    const commandHrefs = new Set(
      buildShellCommands()
        .filter((command) => command.target.kind === 'navigate')
        .map((command) => (command.target as { href: string }).href),
    );
    // /onboarding was command-search-missing before W075.
    expect(commandHrefs.has('/onboarding')).toBe(true);
    // The destinations the prompts point at are all search-reachable.
    for (const prompt of CAPABILITY_PROMPTS) {
      expect(commandHrefs.has(prompt.href), prompt.href).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Mobile reachability (the same HTML, the mobile shell)
// ---------------------------------------------------------------------------

describe('mobile reachability of the hub', () => {
  it('the More page renders inside the mobile shell (bottom nav + top bar)', () => {
    expect(moreHtml).toContain('aurum-bottomnav');
    expect(moreHtml).toContain('aurum-topbar');
    expect(moreHtml).toContain('aria-label="Search (command menu)"');
  });

  it('every hub destination is reachable on mobile through the More area — none is search-only', () => {
    // More is one of the five bottom-nav areas; the hub it renders
    // carries every capability entry. The complete proof that the walk
    // closes is the W070 mobile suite's breadth-first walk; this locks
    // the W075 addition: the hub entries themselves are all present in
    // the shell-rendered page a phone receives.
    for (const entry of capabilityEntries()) {
      expect(moreLinks.has(entry.href), entry.href).toBe(true);
    }
  });
});
