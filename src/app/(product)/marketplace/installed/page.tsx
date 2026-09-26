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
import { buildKitInstalledSection } from '../lib/kits';
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
  const kits = await buildKitInstalledSection(session.context);

  return (
    <>
      <PageHead
        title="Installed"
        description="What your company runs from the marketplace (or registered directly): each extension's lifecycle state, the verification posture of its latest version, and the deployment currently serving it — plus your installed vertical starter kits with their own lifecycle states, grants and invocation ledgers. Activation, suspension, rollback and retirement are governed here — every consequential move passes the authority gate."
        meta={
          <span>
            {view.total} extension{view.total === 1 ? '' : 's'} · {kits.total} kit installation{kits.total === 1 ? '' : 's'}
          </span>
        }
      />

      {!view.ok ? (
        <ErrorState
          title="Read failed"
          detail="Your registry could not be read right now. Nothing changed — try again in a moment."
          retryHref={`/marketplace/installed${scopeQuery}`}
        />
      ) : view.items.length === 0 ? (
        <EmptyState
          title="No extensions installed yet"
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

      {/* --- the installed vertical starter kits (their own lifecycle) --- */}
      <section
        className="aurum-panel"
        aria-labelledby="aurum-mkt-installed-kits-title"
        style={{ marginTop: 18 }}
      >
        <h2 className="aurum-panel-title" id="aurum-mkt-installed-kits-title">
          <span>Vertical starter kits</span>
        </h2>
        <p className="aurum-panel-blurb">
          Your installed kits and their own lifecycle states — separate from the
          extension registry above: a kit install routes its grant review through
          the human authority gate, approval mints exactly the declared
          capabilities, and removal revokes every grant.
        </p>
        {!kits.ok ? (
          <ErrorState
            title="Read failed"
            detail="Your kit installations could not be read right now. Nothing changed — try again in a moment."
            retryHref={`/marketplace/installed${scopeQuery}`}
          />
        ) : kits.items.length === 0 ? (
          <EmptyState
            title="No kits installed yet"
            hint="The signed starter kits in the catalog install from their own lifecycle — open one to register, verify and install it."
            action={
              <Link
                className="aurum-btn"
                data-variant="quiet"
                href={`/marketplace${scopeQuery}#vertical-kits`}
              >
                Browse the starter kits
              </Link>
            }
          />
        ) : (
          <ul className="aurum-item-list">
            {kits.items.map((kit) => (
              <li key={kit.id}>
                <div className="aurum-item-head">
                  <Link
                    className="aurum-mkt-item-title"
                    href={`/marketplace/kit/${kit.kitKey}${scopeQuery}`}
                  >
                    {kit.kitKey}
                  </Link>
                  <StatusPill tone={kit.stateTone}>{kit.stateLabel}</StatusPill>
                </div>
                <div className="aurum-item-foot">
                  <span className="aurum-mono">v{kit.kitVersion} · installed {kit.installedAt.slice(0, 10)}</span>
                  {kit.grants === null ? (
                    <Tag>grant counts unavailable</Tag>
                  ) : (
                    <Tag>{kit.grants.active} active grant{kit.grants.active === 1 ? '' : 's'}{kit.grants.revoked > 0 ? ` · ${kit.grants.revoked} revoked` : ''}</Tag>
                  )}
                  {kit.invocations === null ? (
                    <Tag>ledger counts unavailable</Tag>
                  ) : (
                    <Tag>{kit.invocations.allowed} allowed · {kit.invocations.denied} denied</Tag>
                  )}
                  {!kit.live ? <Tag>history — terminal</Tag> : null}
                </div>
                <p className="aurum-item-text">{kit.stateExplanation}</p>
              </li>
            ))}
          </ul>
        )}
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
