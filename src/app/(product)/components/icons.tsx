// Product shell (W057) — the shell's inline icon set.
//
// Hand-drawn 24×24 stroke glyphs in the lucide tradition (round caps,
// 1.75 stroke). Inline SVG on purpose: the product shell adds no icon
// dependency to the one-package budget, and every icon is aria-hidden by
// default (labels live on the controls, not the glyphs).

import type { ReactNode } from 'react';
import type { ShellIcon } from '../lib/navigation';

export interface ShellIconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 18,
  className,
  children,
  label,
}: ShellIconProps & { children: ReactNode; label: string }): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      <title>{label}</title>
      {children}
    </svg>
  );
}

/** Render one of the shell's icons by name (navigation registries store names). */
export function ShellGlyph({
  name,
  size,
  className,
}: ShellIconProps & { name: ShellIcon }): ReactNode {
  switch (name) {
    case 'chat':
      return (
        <Svg label="chat" size={size} className={className}>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </Svg>
      );
    case 'today':
      return (
        <Svg label="today" size={size} className={className}>
          <rect x="3" y="4" width="18" height="18" rx="3" />
          <path d="M16 2v4M8 2v4M3 10h18" />
          <circle cx="12" cy="15.5" r="1.6" />
        </Svg>
      );
    case 'intelligence':
      return (
        <Svg label="intelligence" size={size} className={className}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21" />
        </Svg>
      );
    case 'people':
      return (
        <Svg label="people" size={size} className={className}>
          <circle cx="9" cy="8" r="3.4" />
          <path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
          <path d="M16 5.4a3.2 3.2 0 0 1 0 6.2M17.4 15.4c1.8.6 3 2.2 3.4 4.6" />
        </Svg>
      );
    case 'connections':
      return (
        <Svg label="connections" size={size} className={className}>
          <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
          <path d="M9 17v3a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-3" />
          <path d="M9 7H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h3M15 7h3a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-3" />
        </Svg>
      );
    case 'marketplace':
      return (
        <Svg label="marketplace" size={size} className={className}>
          <path d="M4 8.5 6 4h12l2 4.5" />
          <path d="M4 8.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V8.5z" />
          <path d="M9.5 12.5h5" />
        </Svg>
      );
    case 'more':
      return (
        <Svg label="more" size={size} className={className}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
        </Svg>
      );
    case 'search':
      return (
        <Svg label="search" size={size} className={className}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.8-3.8" />
        </Svg>
      );
    case 'bell':
      return (
        <Svg label="notifications" size={size} className={className}>
          <path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5" />
          <path d="M10.3 19.5a2 2 0 0 0 3.4 0" />
        </Svg>
      );
    case 'chevron':
      return (
        <Svg label="chevron" size={size} className={className}>
          <path d="m6 9 6 6 6-6" />
        </Svg>
      );
    case 'close':
      return (
        <Svg label="close" size={size} className={className}>
          <path d="M18 6 6 18M6 6l12 12" />
        </Svg>
      );
    case 'check':
      return (
        <Svg label="selected" size={size} className={className}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </Svg>
      );
    case 'tower':
      return (
        <Svg label="management" size={size} className={className}>
          <path d="M8 21V5.5L12 3l4 2.5V21" />
          <path d="M4 21h16" />
          <path d="M8 10h8M8 14.5h8M8 21v-2" />
        </Svg>
      );
    case 'developer':
      return (
        <Svg label="developer" size={size} className={className}>
          <path d="m8 8-4.5 4L8 16M16 8l4.5 4L16 16" />
          <path d="m13.5 5-3 14" />
        </Svg>
      );
    case 'spark':
      return (
        <Svg label="ask" size={size} className={className}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
          <circle cx="12" cy="12" r="3.2" />
        </Svg>
      );
    case 'keyboard':
      return (
        <Svg label="keyboard" size={size} className={className}>
          <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
          <path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" />
        </Svg>
      );
  }
}
