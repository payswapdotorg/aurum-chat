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
