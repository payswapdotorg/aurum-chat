// Unit tests for the product shell (W057) — the pure UX-system logic:
// navigation registries, command search, the context seam, the context
// drawer model, chat starters, state-pattern copy and the keyboard math.
// No DB, no DOM — the component layer only renders what these functions
// decide (the tower's testing doctrine applied to the shell).

import { describe, expect, it } from 'vitest';
import { TOWER_SURFACES } from '@/app/(tower)/lib/surfaces';
import {
  MOBILE_NAV_AREA_IDS,
  PRODUCT_AREAS,
  TOWER_SURFACE_SLUGS,
  activeAreaId,
  intelligenceSurfaces,
  mobileNavAreas,
  peopleSurfaces,
  productArea,
  railNavAreas,
  towerSurfaceLinks,
} from '../lib/navigation';
import {
  buildShellCommands,
  commandHref,
  filterShellCommands,
  nextCommandIndex,
  scoreCommand,
  starterOfCommand,
} from '../lib/command-registry';
import { withProductScope } from '../lib/context';
import {
  contextDrawerReducer,
  normalizeContextPayload,
  sectionHeading,
} from '../lib/context-drawer';
import { CHAT_STARTERS, findStarter, starterHref } from '../lib/chat-starters';
import {
  connectionStatusLabel,
  connectionStatusTone,
  errorSummary,
  isScopeError,
} from '../lib/states';
import {
  deliveryClassLabel,
  notificationNeedsAttention,
  notificationStatusLabel,
  notificationTone,
} from '../lib/shell-state';
import { nextFocusIndex, trapTabIndex, wrapIndex } from '../lib/focus';

// ---------------------------------------------------------------------------
// Navigation registry
// ---------------------------------------------------------------------------

describe('product navigation registry', () => {
  it('has the seven canonical areas with unique ids and hrefs', () => {
    expect(PRODUCT_AREAS.map((area) => area.id)).toEqual([
      'chat',
      'today',
      'intelligence',
      'people',
      'connections',
      'marketplace',
      'more',
    ]);
    const hrefs = new Set(PRODUCT_AREAS.map((area) => area.href));
    expect(hrefs.size).toBe(PRODUCT_AREAS.length);
  });

  it('carries exactly the five mobile bottom-nav areas (plan §3)', () => {
    expect(MOBILE_NAV_AREA_IDS).toEqual([
      'chat',
      'today',
      'intelligence',
      'people',
      'more',
    ]);
    expect(mobileNavAreas().map((area) => area.id)).toEqual(
      MOBILE_NAV_AREA_IDS,
    );
  });

  it('the rail renders every area except More (More renders as its own section)', () => {
    expect(railNavAreas().map((area) => area.id)).toEqual([
      'chat',
      'today',
      'intelligence',
      'people',
      'connections',
      'marketplace',
    ]);
  });

  it('every area has a short label, tagline and icon', () => {
    for (const area of PRODUCT_AREAS) {
      expect(area.shortLabel.length).toBeGreaterThan(0);
      expect(area.tagline.length).toBeGreaterThan(0);
      expect(area.icon.length).toBeGreaterThan(0);
    }
  });

  it('Today is the tower surface at /today (management mode drill-down)', () => {
    expect(productArea('today')).toMatchObject({
      href: '/today',
      mode: 'management',
    });
  });

  it('activeAreaId matches product paths only', () => {
    expect(activeAreaId('/chat')).toBe('chat');
    expect(activeAreaId('/chat')).toBe('chat');
    expect(activeAreaId('/intelligence')).toBe('intelligence');
    expect(activeAreaId('/marketplace/some-child')).toBe('marketplace');
    expect(activeAreaId('/more')).toBe('more');
    // Tower drill-downs are NOT product areas (they render in the tower shell).
    expect(activeAreaId('/risks')).toBeNull();
    expect(activeAreaId('/today')).toBeNull();
    expect(activeAreaId('/')).toBeNull();
  });

  it('exposes all fifteen tower surfaces with unique hrefs and non-empty labels', () => {
    const links = towerSurfaceLinks();
    expect(links).toHaveLength(15);
    const hrefs = new Set(links.map((link) => link.href));
    expect(hrefs.size).toBe(15);
    for (const link of links) {
      expect(link.label.length).toBeGreaterThan(0);
      expect(link.tagline.length).toBeGreaterThan(0);
      expect(link.group.length).toBeGreaterThan(0);
    }
  });

  it('the client-safe tower slug list is locked to the tower registry (no drift)', () => {
    // navigation.ts cannot import the tower registry at runtime (it would
    // drag the pg driver into client bundles), so the slugs live locally —
    // and this test is the lock: both lists must be IDENTICAL, in order.
    expect([...TOWER_SURFACE_SLUGS]).toEqual([...TOWER_SURFACES]);
  });

  it('the intelligence hub carries direction + intelligence surfaces; people carries its own', () => {
    const intelligence = intelligenceSurfaces().map((link) => link.surface);
    expect(intelligence).toContain('goals');
    expect(intelligence).toContain('unknowns');
    expect(intelligence).toContain('risks');
    expect(intelligence).toContain('automation');
    expect(intelligence).not.toContain('workforce');
    const people = peopleSurfaces().map((link) => link.surface);
    expect(people).toEqual(['workforce', 'agents']);
  });
});

// ---------------------------------------------------------------------------
// Command search
// ---------------------------------------------------------------------------

describe('command search registry', () => {
  const commands = buildShellCommands();

  it('contains every product area, every tower surface, every starter and the actions', () => {
    expect(commands.filter((c) => c.id.startsWith('area:'))).toHaveLength(7);
    expect(commands.filter((c) => c.id.startsWith('tower:'))).toHaveLength(15);
    expect(commands.filter((c) => c.id.startsWith('starter:'))).toHaveLength(8);
    expect(commands.filter((c) => c.id.startsWith('action:'))).toHaveLength(2);
    // W061: the intelligence area's Today briefing destination rides the
    // same registry (keyboard-discoverable exactly once).
    expect(commands.filter((c) => c.id.startsWith('intelligence:'))).toHaveLength(1);
    const ids = new Set(commands.map((command) => command.id));
    expect(ids.size).toBe(commands.length);
  });

  it('every navigate command targets an in-app path', () => {
    for (const command of commands) {
      if (command.target.kind === 'navigate') {
        expect(command.target.href.startsWith('/')).toBe(true);
      }
    }
  });

  it('empty query returns everything in registry order', () => {
    const results = filterShellCommands(commands, '');
    expect(results).toHaveLength(commands.length);
    expect(results[0]!.command.id).toBe('area:chat');
  });

  it('matches by title prefix, word start and substring — best first', () => {
    const results = filterShellCommands(commands, 'peo').map((r) => r.command.id);
    expect(results[0]).toBe('area:people');

    const risks = filterShellCommands(commands, 'risk').map((r) => r.command.id);
    expect(risks[0]).toBe('tower:risks');

    const attention = filterShellCommands(commands, 'attention').map(
      (r) => r.command.id,
    );
    // W061: the Today briefing command keyword-matches 'attention' exactly
    // (score 4) and precedes the starters in registry order, so it leads;
    // the starter (its 'attention' keyword also scores 4) follows, and both
    // beat the substring-only notifications action.
    expect(attention[0]).toBe('intelligence:briefing');
    expect(attention[1]).toBe('starter:attention');
    expect(attention).toContain('action:notifications');

    // The Today briefing is keyboard-reachable by name (W061's destination).
    const briefing = filterShellCommands(commands, 'briefing').map(
      (r) => r.command.id,
    );
    expect(briefing[0]).toBe('intelligence:briefing');
  });

  it('scoring: exact beats prefix beats word beats substring; no match is 0', () => {
    const byId = (id: string) => commands.find((c) => c.id === id)!;
    expect(scoreCommand(byId('starter:attention'), 'What needs my attention?')).toBe(2);
    expect(scoreCommand(byId('area:chat'), 'ch')).toBe(3);
    expect(scoreCommand(byId('starter:attention'), 'att')).toBe(4); // word start
    expect(scoreCommand(byId('tower:approvals'), 'human authority')).toBe(5); // substring
    expect(scoreCommand(byId('tower:approvals'), 'zzz')).toBe(0);
  });

  it('keyboard selection wraps in both directions', () => {
    expect(nextCommandIndex(null, 5, 'next')).toBe(0);
    expect(nextCommandIndex(0, 5, 'prev')).toBe(4);
    expect(nextCommandIndex(4, 5, 'next')).toBe(0);
    expect(nextCommandIndex(2, 5, 'prev')).toBe(1);
    expect(nextCommandIndex(null, 5, 'first')).toBe(0);
    expect(nextCommandIndex(null, 5, 'last')).toBe(4);
    expect(nextCommandIndex(1, 0, 'next')).toBeNull();
  });

  it('command hrefs preserve the scope query and keep hashes last', () => {
    const byId = (id: string) => commands.find((c) => c.id === id)!;
    expect(commandHref(byId('area:chat'), '?tenant=t1')).toBe('/chat?tenant=t1');
    expect(commandHref(byId('area:chat'), '')).toBe('/chat');
    const keyboard = byId('action:keyboard');
    expect(commandHref(keyboard, '?tenant=t1')).toBe('/more?tenant=t1#keyboard');
    expect(commandHref(byId('action:notifications'), '?tenant=t1')).toBe('');
  });

  it('starterOfCommand maps command ids back to starters', () => {
    const byId = (id: string) => commands.find((c) => c.id === id)!;
    expect(starterOfCommand(byId('starter:why'), CHAT_STARTERS)?.id).toBe('why');
    expect(starterOfCommand(byId('area:chat'), CHAT_STARTERS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Context seam
// ---------------------------------------------------------------------------

describe('link query building (post-W058: no scope seam)', () => {
  it('withProductScope applies overrides only — scope parameters never ride a URL', () => {
    expect(withProductScope({})).toBe('');
    expect(withProductScope({ tenant: '00000000-0000-4000-8000-000000000001' })).toBe('');
    expect(withProductScope({}, { kind: 'agent' })).toBe('?kind=agent');
    expect(withProductScope({}, { kind: null })).toBe('');
    expect(withProductScope({}, { status: 'archived' })).toBe('?status=archived');
  });
});

// ---------------------------------------------------------------------------
// Context drawer model
// ---------------------------------------------------------------------------

describe('context drawer model', () => {
  it('reducer opens and closes', () => {
    const payload = normalizeContextPayload({
      title: 'Risk: churn rising',
      subtitle: 'detected by the intelligence loop',
      sections: [{ kind: 'why', lines: ['Churn is up 12%.'] }],
    });
    expect(payload).not.toBeNull();
    const opened = contextDrawerReducer(
      { open: false },
      { type: 'open', payload: payload! },
    );
    expect(opened.open).toBe(true);
    expect(contextDrawerReducer(opened, { type: 'close' })).toEqual({
      open: false,
    });
  });

  it('normalizes valid payloads and fills section headings', () => {
    const payload = normalizeContextPayload({
      title: '  Recommendation: hire collections agent  ',
      subtitle: '',
      tone: 'info',
      source: 'recommendations view',
      sections: [
        { kind: 'summary', lines: ['Train vs hire.', '  '] },
        {
          kind: 'evidence',
          lines: ['Observation O-1'],
          links: [
            { label: 'Open evidence', href: '/evidence' },
            { label: 'evil', href: 'https://evil.example' }, // external hrefs are dropped
            { label: '', href: '/goals' },
          ],
        },
      ],
    });
    expect(payload).toEqual({
      title: 'Recommendation: hire collections agent',
      subtitle: null,
      tone: 'info',
      source: 'recommendations view',
      sections: [
        { kind: 'summary', title: 'Summary', lines: ['Train vs hire.'], links: [] },
        {
          kind: 'evidence',
          title: 'Evidence',
          lines: ['Observation O-1'],
          links: [{ label: 'Open evidence', href: '/evidence' }],
        },
      ],
    });
    expect(sectionHeading('related-goal')).toBe('Related goal');
    expect(sectionHeading('approval')).toBe('Approval');
  });

  it('rejects payloads without a title or without usable sections', () => {
    expect(normalizeContextPayload(null)).toBeNull();
    expect(normalizeContextPayload({ sections: [] })).toBeNull();
    expect(normalizeContextPayload({ title: 'x' })).toBeNull();
    expect(
      normalizeContextPayload({ title: 'x', sections: [{ kind: 'nope', lines: ['a'] }] }),
    ).toBeNull();
    expect(
      normalizeContextPayload({ title: 'x', sections: [{ kind: 'why', lines: [] }] }),
    ).toBeNull();
    expect(normalizeContextPayload({ title: 'x', tone: 'sparkle', sections: [{ kind: 'why', lines: ['a'] }] })?.tone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chat starters
// ---------------------------------------------------------------------------

describe('chat discovery starters', () => {
  it('carries the eight canonical starters from the plan, verbatim', () => {
    expect(CHAT_STARTERS.map((starter) => starter.question)).toEqual([
      'What needs my attention?',
      'What changed?',
      "What don't we know?",
      'How are we doing against our goals?',
      'Where are we inefficient?',
      'What should we improve?',
      'Show me why.',
      'What is Aurum learning about our company?',
    ]);
  });

  it('findStarter matches ids (trimmed) and no free text yet', () => {
    expect(findStarter('attention')?.id).toBe('attention');
    expect(findStarter(' attention ')?.id).toBe('attention'); // trimmed
    expect(findStarter('What needs my attention?')).toBeNull();
    expect(findStarter(null)).toBeNull();
    expect(findStarter('')).toBeNull();
  });

  it('starter hrefs carry the selection and the scope (query joining)', () => {
    const starter = CHAT_STARTERS[0]!;
    expect(starterHref(starter, '')).toBe('/chat?q=attention');
    expect(starterHref(starter, '?tenant=t1')).toBe('/chat?q=attention&tenant=t1');
  });
});

// ---------------------------------------------------------------------------
// State-pattern copy and mappings
// ---------------------------------------------------------------------------

describe('state patterns', () => {
  it('notification statuses map to tones and attention', () => {
    expect(notificationTone('delivered')).toBe('positive');
    expect(notificationTone('pending')).toBe('info');
    expect(notificationTone('escalating')).toBe('warning');
    expect(notificationTone('escalated')).toBe('warning');
    expect(notificationTone('failed')).toBe('error');
    expect(notificationTone('suppressed')).toBe('neutral');
    expect(notificationNeedsAttention('pending')).toBe(true);
    expect(notificationNeedsAttention('delivered')).toBe(false);
    expect(notificationNeedsAttention('blocked')).toBe(false);
    expect(notificationStatusLabel('escalation_failed')).toBe('Escalation failed');
    expect(deliveryClassLabel('digest')).toBe('Digest');
  });

  it('connection statuses map to tones and labels', () => {
    expect(connectionStatusTone('active')).toBe('positive');
    expect(connectionStatusTone('disabled')).toBe('neutral');
    expect(connectionStatusLabel('active')).toBe('Active');
    expect(connectionStatusLabel('weird')).toBe('weird');
  });

  it('errorSummary is friendly and never leaks internals', () => {
    expect(errorSummary({ code: 'tenant_not_found' })).toMatchObject({
      title: 'Company unavailable',
    });
    expect(errorSummary({ code: 'forbidden' })).toMatchObject({
      title: 'Not allowed here',
    });
    expect(errorSummary(new Error('boom'))).toMatchObject({
      title: 'Something went wrong',
      detail: 'This surface could not be assembled right now: boom',
    });
    expect(errorSummary('mystery')).toMatchObject({
      detail: 'This surface could not be assembled right now. Try again in a moment.',
    });
    expect(isScopeError({ code: 'tenant_not_found' })).toBe(true);
    expect(isScopeError(new Error('x'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keyboard math
// ---------------------------------------------------------------------------

describe('focus helpers', () => {
  it('roving focus wraps and handles null', () => {
    expect(nextFocusIndex(null, 3, 'next')).toBe(0);
    expect(nextFocusIndex(0, 3, 'prev')).toBe(2);
    expect(nextFocusIndex(2, 3, 'next')).toBe(0);
    expect(nextFocusIndex(1, 3, 'none')).toBe(1);
    expect(nextFocusIndex(0, 0, 'next')).toBeNull();
  });

  it('trapTabIndex wraps Tab at the ends and passes through inside', () => {
    expect(trapTabIndex(2, 3, false)).toBe(0); // last → first
    expect(trapTabIndex(1, 3, false)).toBeNull(); // stay inside
    expect(trapTabIndex(0, 3, true)).toBe(2); // first → last on shift
    expect(trapTabIndex(1, 3, true)).toBeNull();
    expect(trapTabIndex(null, 3, false)).toBe(0);
  });

  it('wrapIndex wraps in both directions', () => {
    expect(wrapIndex(0, 3, -1)).toBe(2);
    expect(wrapIndex(2, 3, 1)).toBe(0);
    expect(wrapIndex(1, 3, 1)).toBe(2);
  });
});
