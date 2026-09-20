// Product surface (W064) — the Marketplace area: BROWSE.
//
// The public governed catalog — real state through the marketplace
// contract (exactly the PUBLISHED and INSTALLABLE versions). A scoped
// request also reads the caller's installed-extensions summary so the
// area opens with "what you already run" beside "what you can add".
// The catalog itself is public: an unscoped visitor browses with the
// documented claim-less browsing context (nothing pre-publication is
// ever visible — the contract's visibility rule grants nothing else).
//
// W057's honest hub (governance facts + "coming to this area") is
// replaced by this real surface — the facts it stated are now the
// working parts of the pages below.

import Link from 'next/link';
import { withProductScope } from '../lib/context';
import type { PageSearchParams } from '../lib/context';
import { resolveSession } from '@/app/lib/session';
import {
  buildCatalogView,
  parseKindFilter,
  publicBrowsingContext,
} from './lib/views';
import {
  EmptyState,
  ErrorState,
  PageHead,
  Panel,
  StatusPill,
  Tag,
} from '../components/states';
import { ShellGlyph } from '../components/icons';

export const dynamic = 'force-dynamic';

const KIND_TABS: { value: 'all' | 'extension' | 'agent'; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'extension', label: 'Extensions' },
  { value: 'agent', label: 'Agent packages' },
];

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  // W058: scope comes from the session; an anonymous visitor still browses
  // the public catalog with the claim-less browsing context (reads only —
  // every write path requires a signed-in session with an active company).
  const session = await resolveSession();
  const scoped = session.status === 'authenticated';
  const ctx = scoped ? session.context : publicBrowsingContext();
  const scopeQuery = withProductScope(params);
  const rawKind = Array.isArray(params['kind']) ? (params['kind'][0] ?? null) : (params['kind'] ?? null);
  const kindFilter = parseKindFilter(rawKind);
  const view = await buildCatalogView(ctx, kindFilter);

  const tabs = KIND_TABS.map((tab) => ({
    ...tab,
    href: `/marketplace${withProductScope(params, { kind: tab.value === 'all' ? null : tab.value })}`,
    active: tab.value === view.kindFilter,
  }));

  return (
    <>
      <PageHead
        title="Marketplace"
        description="Extensions and governed agent packages — general software capabilities for your Aurum, not a fixed feature catalog. Every listing passed automated verification AND platform review before it became installable; publication and installation are separate states."
        meta={<span>Live catalog · {view.total} listing{view.total === 1 ? '' : 's'} shown</span>}
      />
      {!scoped ? (
        <div className="aurum-notice">
          You are browsing the public catalog without signing in. Sign in to
          see your company&apos;s installed extensions and to install or
          govern anything — every write passes your session&apos;s verified
          scope.
        </div>
      ) : null}

      <div className="aurum-mkt-area-links">
        <Link className="aurum-mkt-area-link" href={`/marketplace/installed${scopeQuery}`}>
          <ShellGlyph name="check" size={15} />
          <span>
            <strong>Installed</strong>
            <span>govern what your company already runs</span>
          </span>
        </Link>
        <Link className="aurum-mkt-area-link" href={`/marketplace/developer${scopeQuery}`}>
          <ShellGlyph name="developer" size={15} />
          <span>
            <strong>Developer</strong>
            <span>build, verify and publish packages</span>
          </span>
        </Link>
      </div>

      {view.installed !== null ? (
        <Panel
          title="What your company runs"
          blurb="Your tenant registry — extensions installed from here or registered directly. Install, activation, suspension and rollback are governed from the Installed surface."
          meta={
            view.installed.ok ? (
              <span>{view.installed.total} extension{view.installed.total === 1 ? '' : 's'}</span>
            ) : undefined
          }
        >
          {view.installed.ok ? (
            view.installed.total === 0 ? (
              <EmptyState
                title="Nothing installed yet"
                hint="Install a package below — or build one in the Developer surface — and it lands here with its lifecycle state."
              />
            ) : (
              <div className="aurum-mkt-stat-row">
                <span className="aurum-mkt-stat">
                  <strong>{view.installed.active}</strong>
                  <span>active</span>
                </span>
                <span className="aurum-mkt-stat">
                  <strong>{view.installed.suspended}</strong>
                  <span>suspended</span>
                </span>
                <span className="aurum-mkt-stat">
                  <strong>{view.installed.registered}</strong>
                  <span>registered, inert</span>
                </span>
                <span className="aurum-mkt-stat">
                  <strong>{view.installed.deprecated}</strong>
                  <span>deprecated</span>
                </span>
              </div>
            )
          ) : (
            <ErrorState
              title="Read failed"
              detail="Your registry could not be read right now. The catalog below keeps working."
            />
          )}
        </Panel>
      ) : null}

      <section className="aurum-panel" aria-labelledby="aurum-mkt-catalog-title">
        <h2 className="aurum-panel-title" id="aurum-mkt-catalog-title">
          <span>Browse the catalog</span>
          <nav className="aurum-mkt-tabs" aria-label="Filter by kind">
            {tabs.map((tab) => (
              <Link
                key={tab.value}
                href={tab.href}
                className="aurum-mkt-tab"
                aria-current={tab.active ? 'page' : undefined}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        </h2>
        <p className="aurum-panel-blurb">
          Listings are immutable artifact versions frozen by their vendor. A listing&apos;s
          permissions are inspected before anything is installed — never after.
        </p>
        {!view.ok ? (
          <ErrorState
            title="Catalog unavailable"
            detail="The catalog read failed. Nothing about your scope changed — try again in a moment."
            retryHref={`/marketplace${scopeQuery}`}
          />
        ) : view.items.length === 0 ? (
          <EmptyState
            title={kindFilter === 'all' ? 'The catalog is empty' : `No ${kindFilter} packages yet`}
            hint="Vendors publish through the Developer surface: automated verification and platform review gate every listing."
          />
        ) : (
          <ul className="aurum-item-list">
            {view.items.map((item) => (
              <li key={item.id}>
                <div className="aurum-item-head">
                  <Link
                    className="aurum-mkt-item-title"
                    href={`/marketplace/package/${item.id}${scopeQuery}`}
                  >
                    {item.displayName}
                  </Link>
                  <StatusPill tone={item.stateTone}>{item.stateLabel}</StatusPill>
                </div>
                <div className="aurum-item-foot">
                  <span className="aurum-mono">{item.packageKey} · v{item.version}</span>
                  <Tag>{item.kindLabel}</Tag>
                  <Tag>{item.permissionCount} permission{item.permissionCount === 1 ? '' : 's'}</Tag>
                </div>
                {item.description === null || item.description === '' ? null : (
                  <p className="aurum-item-text">{item.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div style={{ marginTop: 18 }}>
        <Panel
          title="What is always true here"
          blurb="Governance is not a badge — it is the state machine every package went through:"
        >
          <ul className="aurum-item-list">
            <li>
              <p className="aurum-item-text">
                Third-party packages stay <strong>pending until platform approval</strong> — no
                submission can bypass review, and a vendor can never review its own package.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                Install, activate, suspend and rollback are{' '}
                <strong>separate lifecycle states</strong> with the full trail recorded.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                Agent packages ride the <strong>same governance surface</strong> as extensions —
                same chain, same permission inspection, same review.
              </p>
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
