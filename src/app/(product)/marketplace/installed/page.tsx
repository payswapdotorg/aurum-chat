// Product surface (W064) — the Marketplace area: INSTALLED.
//
// The tenant-side governance half of Journey J: what your company runs
// (the extensions registry with each extension's lifecycle state,
// verification posture and current deployment), one drill-down per
// extension for install/activate/suspend/resume/deprecate transitions,
// version deployments with permission grants, and rollback to any
// recorded superseded deployment.

import Link from 'next/link';
import { withProductScope } from '../../lib/context';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import type { PageSearchParams } from '../../lib/context';
import { buildInstalledView } from '../lib/views';
import { buildInstalledKitsView } from '../lib/kit-views';
import {
  EmptyState,
  ErrorState,
  PageHead,
  Panel,
  StatusPill,
  Tag,
} from '../../components/states';
import { verificationTone } from '../lib/labels';

export const dynamic = 'force-dynamic';

export default async function InstalledPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  const session = await requireAuthenticatedPage();
  const scopeQuery = withProductScope(params);
  const view = await buildInstalledView(session.context);
  // W105 — the installed vertical starter kits (the W092 kits' own
  // lifecycle states — additive; the extensions registry above is
  // untouched).
  const kits = await buildInstalledKitsView(session.context);

  return (
    <>
      <PageHead
        title="Installed"
        description="What your company runs from the marketplace (or registered directly): each extension's lifecycle state, the verification posture of its latest version, and the deployment currently serving it. Activation, suspension, rollback and retirement are governed here — every consequential move passes the authority gate."
        meta={<span>{view.total} extension{view.total === 1 ? '' : 's'}</span>}
      />

      {!view.ok ? (
        <ErrorState
          title="Read failed"
          detail="Your registry could not be read right now. Nothing changed — try again in a moment."
          retryHref={`/marketplace/installed${scopeQuery}`}
        />
      ) : view.items.length === 0 ? (
        <EmptyState
          title="Nothing installed yet"
          hint="Browse the catalog and install a package — or build one in the Developer surface. Installed extensions land here with their lifecycle state."
          action={
            <Link className="aurum-btn" data-variant="quiet" href={`/marketplace${scopeQuery}`}>
              Browse the catalog
            </Link>
          }
        />
      ) : (
        <ul className="aurum-item-list">
          {view.items.map((item) => (
            <li key={item.id}>
              <div className="aurum-item-head">
                <Link
                  className="aurum-mkt-item-title"
                  href={`/marketplace/installed/${item.extensionKey}${scopeQuery}`}
                >
                  {item.extensionKey}
                </Link>
                <StatusPill tone={item.stateTone}>{item.stateLabel}</StatusPill>
              </div>
              <div className="aurum-item-foot">
                <span className="aurum-mono">
                  {item.latestVersion === null ? 'no versions' : `latest v${item.latestVersion}`}
                </span>
                {item.verificationState === null ? null : (
                  <Tag>
                    <StatusPill tone={verificationTone(item.verificationState as never)}>
                      {item.verificationState.toLowerCase()}
                    </StatusPill>
                  </Tag>
                )}
                {item.deployment === null ? (
                  <Tag>not deployed</Tag>
                ) : (
                  <Tag>
                    serving v{item.deployment.version} · {item.deployment.grantedCount} granted
                  </Tag>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="aurum-panel" aria-labelledby="aurum-mkt-installed-kits-title">
        <h2 className="aurum-panel-title" id="aurum-mkt-installed-kits-title">
          <span>Vertical starter kits</span>
        </h2>
        <p className="aurum-panel-blurb">
          The W092 specialist kits your company installed — governed by the
          vertical-kits module&apos;s own lifecycle (the grant review, the minted
          capability grants, and the invocation ledger live on each kit&apos;s
          detail page).
        </p>
        {!kits.ok ? (
          <ErrorState
            title="Kit registry read failed"
            detail="Your kit installations could not be read right now. Nothing changed — try again in a moment."
            retryHref={`/marketplace/installed${scopeQuery}`}
          />
        ) : kits.items.length === 0 ? (
          <EmptyState
            title="No vertical kits installed yet"
            hint="Install a specialist starter kit from the catalog — it lands here with its grant-review state, minted grants and lifecycle trail."
            action={
              <Link
                className="aurum-btn"
                data-variant="quiet"
                href={`/marketplace${scopeQuery}#vertical-kits`}
              >
                Browse the vertical starter kits
              </Link>
            }
          />
        ) : (
          <ul className="aurum-item-list">
            {kits.items.map((item) => (
              <li key={item.installationId}>
                <div className="aurum-item-head">
                  <Link
                    className="aurum-mkt-item-title"
                    href={`/marketplace/kit/${item.kitKey}${scopeQuery}`}
                  >
                    {item.kitKey}
                  </Link>
                  <StatusPill tone={item.stateTone}>{item.stateLabel}</StatusPill>
                </div>
                <div className="aurum-item-foot">
                  <span className="aurum-mono">v{item.kitVersion}</span>
                  {item.verificationState === null ? null : (
                    <Tag>
                      <StatusPill tone={verificationTone(item.verificationState as never)}>
                        {item.verificationState.toLowerCase()}
                      </StatusPill>
                    </Tag>
                  )}
                  {item.grants === null ? (
                    <Tag>grants unreadable</Tag>
                  ) : (
                    <Tag>
                      {item.grants.active} active · {item.grants.revoked} revoked grant
                      {item.grants.active + item.grants.revoked === 1 ? '' : 's'}
                    </Tag>
                  )}
                  <span>installed {item.installedAt.slice(0, 10)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {kits.ok && kits.removedCount > 0 ? (
          <p className="aurum-item-text" style={{ marginTop: 10 }}>
            {kits.removedCount} removed kit lifecycle{kits.removedCount === 1 ? '' : 's'} retained
            as append-only audit — visible on each kit&apos;s detail trail, never
            listed as running.
          </p>
        ) : null}
      </section>

      <div style={{ marginTop: 18 }}>
        <Panel
          title="The lifecycle you are governing"
          blurb="The extension's own states — separate from the marketplace package states:"
        >
          <ul className="aurum-item-list">
            <li>
              <p className="aurum-item-text">
                <strong>Registered</strong> — versions recorded, the extension is inert until
                activated.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                <strong>Active ⇄ Suspended</strong> — enabled or temporarily disabled; only
                ACTIVE extensions accept deployments and rollbacks.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                <strong>Deprecated</strong> — retired, terminal: no new versions, no return.
              </p>
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
