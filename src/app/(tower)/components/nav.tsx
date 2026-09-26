'use client';

// Management Control Tower (W033) — the tower navigation.
//
// A client component only because the ACTIVE surface needs the current
// pathname (usePathname); the grouping mirrors the navigation order of
// the surface registry (lib/surfaces.ts).

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

interface NavGroup {
  heading: string;
  items: { href: string; label: string }[];
}

const GROUPS: NavGroup[] = [
  {
    heading: 'Overview',
    items: [{ href: '/today', label: 'Today' }],
  },
  {
    heading: 'Direction',
    items: [
      { href: '/goals', label: 'Goals' },
      { href: '/situation', label: 'Situation' },
      { href: '/unknowns', label: 'Unknowns' },
      { href: '/missions', label: 'Missions' },
    ],
  },
  {
    heading: 'Intelligence',
    items: [
      { href: '/risks', label: 'Risks' },
      { href: '/opportunities', label: 'Opportunities' },
      { href: '/capabilities', label: 'Capabilities' },
      { href: '/processes', label: 'Processes' },
      { href: '/automation', label: 'Automation' },
    ],
  },
  {
    heading: 'People & Systems',
    items: [
      { href: '/workforce', label: 'Workforce' },
      { href: '/agents', label: 'Agents' },
      // W092 — the Vertical Kits surface (an additive row: the W033
      // fifteen surfaces above stay untouched, in their registry order).
      { href: '/vertical-kits', label: 'Vertical kits' },
    ],
  },
  {
    heading: 'Governance',
    items: [
      { href: '/evidence', label: 'Evidence' },
      { href: '/recommendations', label: 'Recommendations' },
      { href: '/approvals', label: 'Approvals' },
    ],
  },
];

export function TowerNav(): ReactNode {
  const pathname = usePathname();
  return (
    <nav className="tower-nav" aria-label="Control Tower surfaces">
      {GROUPS.map((group) => (
        <div className="tower-nav-group" key={group.heading}>
          <p className="tower-nav-heading">{group.heading}</p>
          {group.items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
              >
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
