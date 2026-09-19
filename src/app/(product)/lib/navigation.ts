// Product shell (W057) — the navigation registry.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Canonical product shell" is the
// source of the area set:
//
//   Desktop rail : Chat, Today, Intelligence, People, Connections,
//                  Marketplace, More
//   Mobile bottom: Chat / Today / Intelligence / People / More
//
// Aurum's two connected modes (plan §3): the employee-first product shell
// is the primary experience; the 15-surface Management Control Tower
// (W033) stays available as management mode and is reached as drill-down
// destinations — never as the first discovery mechanism.
//
// CLIENT-SAFETY: this module is imported by client components (the rail,
// the bottom nav, the command search), so it must stay free of server-only
// imports. The tower's own registry (`@/app/(tower)/lib/surfaces`) cannot
// be imported here at runtime — it drags the tower's view builders (module
// contracts → infra/db → the pg driver) into the browser bundle. The
// fifteen surface slugs are therefore declared HERE as the client-safe
// list, and the product unit tests enforce that it matches the tower's
// registry exactly, so the two can never drift.

/** The tower's fifteen surfaces, in tower navigation order (test-locked). */
export const TOWER_SURFACE_SLUGS = [
  'today',
  'goals',
  'situation',
  'unknowns',
  'missions',
  'risks',
  'opportunities',
  'capabilities',
  'processes',
  'automation',
  'workforce',
  'agents',
  'evidence',
  'recommendations',
  'approvals',
] as const;

export type TowerSurface = (typeof TOWER_SURFACE_SLUGS)[number];

export function isTowerSurfaceSlug(value: string): value is TowerSurface {
  return (TOWER_SURFACE_SLUGS as readonly string[]).includes(value);
}

/** Icon names understood by the shell's inline icon set. */
export type ShellIcon =
  | 'chat'
  | 'today'
  | 'intelligence'
  | 'people'
  | 'connections'
  | 'marketplace'
  | 'more'
  | 'search'
  | 'bell'
  | 'chevron'
  | 'close'
  | 'check'
  | 'tower'
  | 'developer'
  | 'spark'
  | 'keyboard';

/** One product area (the rail's and the bottom nav's unit). */
export interface ProductArea {
  id: ProductAreaId;
  href: string;
  label: string;
  /** Short label for the mobile bottom nav (kept short on purpose). */
  shortLabel: string;
  icon: ShellIcon;
  tagline: string;
  /** Where the area lives: the product shell or the tower (management mode). */
  mode: 'product' | 'management';
}

export type ProductAreaId =
  | 'chat'
  | 'today'
  | 'intelligence'
  | 'people'
  | 'connections'
  | 'marketplace'
  | 'more';

/**
 * The seven canonical product areas in plan order. `today` points at the
 * existing tower Today surface (W033 owns the `/today` route; the
 * product-mode intelligence workflow that unifies Today is W061's scope) —
 * it is flagged `management` so the shell can mark the drill-down honestly.
 */
export const PRODUCT_AREAS: readonly ProductArea[] = [
  {
    id: 'chat',
    href: '/chat',
    label: 'Chat',
    shortLabel: 'Chat',
    icon: 'chat',
    tagline: 'Talk with Aurum, your intelligence employee',
    mode: 'product',
  },
  {
    id: 'today',
    href: '/today',
    label: 'Today',
    shortLabel: 'Today',
    icon: 'today',
    tagline: 'What needs your attention right now (management view)',
    mode: 'management',
  },
  {
    id: 'intelligence',
    href: '/intelligence',
    label: 'Intelligence',
    shortLabel: 'Intel',
    icon: 'intelligence',
    tagline: 'Goals, situation, unknowns, missions, risks and opportunities',
    mode: 'product',
  },
  {
    id: 'people',
    href: '/people',
    label: 'People',
    shortLabel: 'People',
    icon: 'people',
    tagline: 'Your workforce, agents and how work gets done',
    mode: 'product',
  },
  {
    id: 'connections',
    href: '/connections',
    label: 'Connections',
    shortLabel: 'Connect',
    icon: 'connections',
    tagline: 'Channels, source systems and destinations',
    mode: 'product',
  },
  {
    id: 'marketplace',
    href: '/marketplace',
    label: 'Marketplace',
    shortLabel: 'Market',
    icon: 'marketplace',
    tagline: 'Extensions and governed agent packages',
    mode: 'product',
  },
  {
    id: 'more',
    href: '/more',
    label: 'More',
    shortLabel: 'More',
    icon: 'more',
    tagline: 'Management mode, platform tools and keyboard reference',
    mode: 'product',
  },
];

/** The mobile bottom nav carries exactly these five areas (plan §3). */
export const MOBILE_NAV_AREA_IDS: readonly ProductAreaId[] = [
  'chat',
  'today',
  'intelligence',
  'people',
  'more',
];

export function productArea(id: ProductAreaId): ProductArea {
  const area = PRODUCT_AREAS.find((candidate) => candidate.id === id);
  if (area === undefined) {
    throw new Error(`unknown product area '${id}'`);
  }
  return area;
}

/** The five bottom-nav areas in plan order. */
export function mobileNavAreas(): ProductArea[] {
  return MOBILE_NAV_AREA_IDS.map((id) => productArea(id));
}

/** The rail's primary areas (everything except `more`, which renders last). */
export function railNavAreas(): ProductArea[] {
  return PRODUCT_AREAS.filter((area) => area.id !== 'more').map((area) => area);
}

/**
 * Which product area a pathname belongs to (for active-state treatment).
 * Tower routes other than `/today` are drill-downs, not areas — they render
 * inside the tower shell, not this one.
 */
export function activeAreaId(pathname: string): ProductAreaId | null {
  const areas: ProductAreaId[] = [
    'chat',
    'intelligence',
    'people',
    'connections',
    'marketplace',
    'more',
  ];
  for (const id of areas) {
    const area = productArea(id);
    if (pathname === area.href || pathname.startsWith(`${area.href}/`)) {
      return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Management mode (the tower's fifteen surfaces, grouped the way the tower
// groups them — labels and taglines are the product shell's own)
// ---------------------------------------------------------------------------

export interface TowerSurfaceLink {
  surface: TowerSurface;
  href: string;
  label: string;
  tagline: string;
  group: TowerLinkGroup;
}

export type TowerLinkGroup =
  | 'Overview'
  | 'Direction'
  | 'Intelligence'
  | 'People & Systems'
  | 'Governance';

const TOWER_SURFACE_META: Record<TowerSurface, Omit<TowerSurfaceLink, 'href'>> = {
  today: {
    surface: 'today',
    label: 'Today',
    tagline: 'The attention dashboard: decisions, missions, unknowns',
    group: 'Overview',
  },
  goals: {
    surface: 'goals',
    label: 'Goals',
    tagline: 'Desired states the company is steering toward',
    group: 'Direction',
  },
  situation: {
    surface: 'situation',
    label: 'Situation',
    tagline: 'The current company situation at a glance',
    group: 'Direction',
  },
  unknowns: {
    surface: 'unknowns',
    label: 'Unknowns',
    tagline: 'First-class questions with consequences of not knowing',
    group: 'Direction',
  },
  missions: {
    surface: 'missions',
    label: 'Missions',
    tagline: 'Goal-driven learning missions',
    group: 'Direction',
  },
  risks: {
    surface: 'risks',
    label: 'Risks',
    tagline: 'Detected risks with evidence',
    group: 'Intelligence',
  },
  opportunities: {
    surface: 'opportunities',
    label: 'Opportunities',
    tagline: 'Detected opportunities with evidence',
    group: 'Intelligence',
  },
  capabilities: {
    surface: 'capabilities',
    label: 'Capabilities',
    tagline: 'Supply and requirement per capability',
    group: 'Intelligence',
  },
  processes: {
    surface: 'processes',
    label: 'Processes',
    tagline: 'Reconstructed processes with effort findings',
    group: 'Intelligence',
  },
  automation: {
    surface: 'automation',
    label: 'Automation',
    tagline: 'Automation opportunities found in processes',
    group: 'Intelligence',
  },
  workforce: {
    surface: 'workforce',
    label: 'Workforce',
    tagline: 'People, roles and workforce intelligence',
    group: 'People & Systems',
  },
  agents: {
    surface: 'agents',
    label: 'Agents',
    tagline: 'Organizational agents with budgets and outcomes',
    group: 'People & Systems',
  },
  evidence: {
    surface: 'evidence',
    label: 'Evidence',
    tagline: 'Immutable observations',
    group: 'Governance',
  },
  recommendations: {
    surface: 'recommendations',
    label: 'Recommendations',
    tagline: 'Policy-gated recommended actions',
    group: 'Governance',
  },
  approvals: {
    surface: 'approvals',
    label: 'Approvals',
    tagline: 'The human authority gate',
    group: 'Governance',
  },
};

/** All fifteen tower surfaces as navigation links (management mode). */
export function towerSurfaceLinks(): TowerSurfaceLink[] {
  return TOWER_SURFACE_SLUGS.map((surface) => ({
    ...TOWER_SURFACE_META[surface],
    surface,
    href: `/${surface}`,
  }));
}

/** A tower surface's link (single lookup). */
export function towerSurfaceLink(
  surface: TowerSurface,
): TowerSurfaceLink {
  return { ...TOWER_SURFACE_META[surface], href: `/${surface}` };
}

/** The tower links grouped for the intelligence/people hubs and the More page. */
export function towerLinksByGroup(): { heading: TowerLinkGroup; links: TowerSurfaceLink[] }[] {
  const groups: { heading: TowerLinkGroup; links: TowerSurfaceLink[] }[] = [];
  for (const link of towerSurfaceLinks()) {
    const existing = groups.find((group) => group.heading === link.group);
    if (existing === undefined) {
      groups.push({ heading: link.group, links: [link] });
    } else {
      existing.links.push(link);
    }
  }
  return groups;
}

/** Which intelligence-family surfaces belong on the Intelligence hub. */
export function intelligenceSurfaces(): TowerSurfaceLink[] {
  return towerSurfaceLinks().filter(
    (link) =>
      link.group === 'Direction' || link.group === 'Intelligence',
  );
}

/** Which people-family surfaces belong on the People hub. */
export function peopleSurfaces(): TowerSurfaceLink[] {
  return towerSurfaceLinks().filter(
    (link) => link.group === 'People & Systems',
  );
}

/** Which governance surfaces belong on the More page's management index. */
export function governanceSurfaces(): TowerSurfaceLink[] {
  return towerSurfaceLinks().filter((link) => link.group === 'Governance');
}

/** Overview surfaces (Today) shown on the More page's management index. */
export function overviewSurfaces(): TowerSurfaceLink[] {
  return towerSurfaceLinks().filter((link) => link.group === 'Overview');
}
