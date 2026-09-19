'use client';

// Product shell (W057) — the context drawer.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3: "optional right context drawer:
// evidence, why, related goal, mission, policy, approval/outcome". The
// drawer renders whatever normalized payload a surface hands the shell
// (`useProductShell().openContext`) — right panel on desktop, bottom sheet
// on mobile, focus-trapped via the shared Sheet. In this work item the
// notification entry feeds it real payloads; chat cards and intelligence
// findings plug in the same way from W060/W061.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useProductShell } from './product-shell-provider';
import { Sheet } from './sheet';
import { StatusPill } from './states';
import { sectionHeading } from '../lib/context-drawer';
import type { ContextSection } from '../lib/context-drawer';
import { scopeFromSearch } from '../lib/context';

function SectionBody({ section }: { section: ContextSection }): ReactNode {
  return (
    <section className="aurum-ctx-section">
      <h3 className="aurum-ctx-heading">{section.title}</h3>
      {section.lines.map((line, index) => (
        <p className="aurum-ctx-line" key={index}>
          {line}
        </p>
      ))}
      {section.links.length === 0 ? null : (
        <div className="aurum-ctx-links">
          {section.links.map((link) => {
            const scope = scopeFromSearch(
              typeof window === 'undefined' ? '' : window.location.search,
            );
            const href =
              link.href.includes('?') || scope === ''
                ? link.href
                : `${link.href}${scope}`;
            return (
              <Link key={link.href} href={href}>
                {link.label}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ContextDrawer(): ReactNode {
  const { contextDrawer, closeContext } = useProductShell();
  if (!contextDrawer.open || contextDrawer.payload === null) return null;
  const payload = contextDrawer.payload;
  return (
    <Sheet
      title={payload.title}
      subtitle={payload.subtitle}
      closeLabel="Close context"
      onClose={closeContext}
      toneBadge={
        payload.tone === null ? null : <StatusPill tone={payload.tone}>context</StatusPill>
      }
      footer={
        payload.source === null
          ? 'Context is derived intelligence — never authoritative source state.'
          : `Source: ${payload.source} · derived intelligence, never authoritative source state.`
      }
    >
      {payload.sections.map((section, index) => (
        <SectionBody
          key={`${section.kind}-${index}-${sectionHeading(section.kind)}`}
          section={section}
        />
      ))}
    </Sheet>
  );
}
