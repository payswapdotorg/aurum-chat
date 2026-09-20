// Product surface (W064) — the Marketplace area: INSTALLED EXTENSION.
//
// The tenant-side governance drill-down (Journey J's "activate →
// monitor → suspend/rollback"): the extension's lifecycle state and
// its legal transitions (each one an authority-gated contract call),
// the registered manifest versions with their verification postures,
// the deployment history of the default install with each deployment's
// granted permissions, and rollback to any recorded superseded
// deployment. Deploying a specific version narrows the grant against
// the manifest ceiling — least privilege as a redeploy, never a
// mutation of history.

import Link from 'next/link';
import { withProductScope } from '../../../lib/context';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import type { PageSearchParams } from '../../../lib/context';
import { buildExtensionView } from '../../lib/views';
import {
  EmptyState,
  ErrorState,
  PageHead,
  Panel,
  StatusPill,
  Tag,
} from '../../../components/states';
import { ActionForm } from '../../components/action-form';
import { EXTENSION_PERMISSION_COPY, verificationTone } from '../../lib/labels';

export const dynamic = 'force-dynamic';

export default async function InstalledExtensionPage({
  params,
  searchParams,
}: {
  params: Promise<{ extensionKey: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { extensionKey } = await params;
  const query = await searchParams;
  const session = await requireAuthenticatedPage();
  const scopeQuery = withProductScope(query);
  const result = await buildExtensionView(session.context, extensionKey);

  if (!result.ok) {
    if (result.failure === 'not_found') {
      return (
        <>
          <PageHead
            title="Extension not found"
            description="No extension with this key exists in your company's registry."
          />
          <div style={{ marginTop: 14 }}>
            <EmptyState
              title="Nothing to govern"
              hint="Another company's registry is invisible by design."
              action={
                <Link
                  className="aurum-btn"
                  data-variant="quiet"
                  href={`/marketplace/installed${scopeQuery}`}
                >
                  Back to installed
                </Link>
              }
            />
          </div>
        </>
      );
    }
    return (
      <>
        <PageHead title="Installed" description="One extension's governance view." />
        <div style={{ marginTop: 14 }}>
          <ErrorState
            title="Read failed"
            detail="The extension could not be read right now. Nothing changed — try again in a moment."
            retryHref={`/marketplace/installed/${extensionKey}${scopeQuery}`}
          />
        </div>
      </>
    );
  }

  const { view } = result;
  const actionBase = `/api/product/marketplace/extension/${encodeURIComponent(extensionKey)}`;
  const current = view.currentDeployment;

  return (
    <>
      <PageHead
        title={view.extension.extensionKey}
        description={view.extension.stateExplanation}
        meta={
          <span>
            <StatusPill tone={view.extension.stateTone}>{view.extension.stateLabel}</StatusPill>
            <span className="aurum-mono" style={{ marginLeft: 8 }}>
              {view.extension.latestVersion === null
                ? 'no versions'
                : `latest v${view.extension.latestVersion}`}
            </span>
          </span>
        }
      />

      {/* --- lifecycle transitions --- */}
      <Panel
        title="Lifecycle"
        blurb="Each transition is an authority-gated contract call — approval-required moves wait at the gate and complete after the human decision (the same idempotent request replays)."
        meta={<span>updated {view.extension.updatedAt.slice(0, 10)}</span>}
      >
        {!view.canGovern ? (
          <div className="aurum-notice">
            Governing extensions needs the <code>extensions:administer</code> authority claim.
            The state below stays readable for every member.
          </div>
        ) : view.availableTransitions.length === 0 ? (
          <EmptyState
            title="No legal transitions"
            hint="A deprecated extension is terminal — build a new extension instead."
          />
        ) : (
          <div className="aurum-mkt-action-grid">
            {view.availableTransitions.map((transition) => (
              <div key={transition.transition} className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">{transition.label}</h3>
                <ActionForm
                  action={`${actionBase}/${transition.transition}`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  submitLabel={transition.label}
                  variant={transition.transition === 'deprecate' ? 'danger' : 'primary'}
                  confirmPrompt={
                    transition.transition === 'deprecate'
                      ? 'Deprecation is terminal — no new versions, no return. I am sure.'
                      : undefined
                  }
                  note={transition.description}
                />
              </div>
            ))}
          </div>
        )}
        <h3 className="aurum-mkt-subhead">Recorded transitions</h3>
        {view.lifecycleEvents.length === 0 ? (
          <EmptyState title="No transitions recorded" hint="Applied transitions land here with who moved it and when." />
        ) : (
          <ul className="aurum-mkt-trail">
            {view.lifecycleEvents.map((event) => (
              <li key={event.id}>
                <span className="aurum-mono">{event.occurredAt.slice(0, 10)}</span>
                <span>
                  {event.transition}: {event.fromState} → {event.toState}
                </span>
                <span className="aurum-mono">by {event.actor.slice(0, 13)}…</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* --- the current deployment --- */}
      <Panel
        title="Current deployment"
        blurb="What the default install is actually serving right now, with the effective permission grant."
      >
        {current === null ? (
          <EmptyState
            title="Nothing deployed"
            hint="Deploy a verified version below — the extension must be ACTIVE and the version VERIFIED."
          />
        ) : (
          <>
            <div className="aurum-mkt-meta-lines">
              <span>
                serving <strong>v{current.version}</strong> on install{' '}
                <span className="aurum-mono">{current.installKey}</span>
              </span>
              <span>
                deployed {current.deployedAt.slice(0, 10)} by{' '}
                <span className="aurum-mono">{current.deployedBy.slice(0, 13)}…</span>
              </span>
              <span>
                operation <span className="aurum-mono">{current.operation}</span>
              </span>
            </div>
            <ul className="aurum-mkt-perm-list-static" style={{ marginTop: 10 }}>
              {current.grantedPermissions.map((permission) => {
                const copy = EXTENSION_PERMISSION_COPY[permission];
                return (
                  <li key={permission}>
                    <span className="aurum-mkt-perm-key aurum-mono">{permission}</span>
                    <span className="aurum-mkt-perm-body-static">
                      <strong>{copy?.label ?? permission}</strong>
                      <span>{copy?.description ?? ''}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>

      {/* --- registered versions + deploy --- */}
      <Panel
        title="Registered versions"
        blurb="Immutable manifest versions with their derived verification posture. Only VERIFIED versions of an ACTIVE extension may deploy; the grant is bounded by the version's requested ceiling."
      >
        {view.manifests.length === 0 ? (
          <EmptyState title="No versions registered" hint="Build or register a version first." />
        ) : (
          <ul className="aurum-item-list">
            {view.manifests.map((manifest) => (
              <li key={manifest.manifestId}>
                <div className="aurum-item-head">
                  <span className="aurum-item-title">
                    v{manifest.version} — {manifest.displayName}
                  </span>
                  <StatusPill tone={verificationTone(manifest.verificationState as never)}>
                    {manifest.verificationState.toLowerCase()}
                  </StatusPill>
                </div>
                <div className="aurum-item-foot">
                  <span>{manifest.permissionCount} requested permissions</span>
                  <span>registered {manifest.registeredAt.slice(0, 10)}</span>
                </div>
                {view.canGovern && manifest.isDeployable ? (
                  <div style={{ marginTop: 10 }}>
                    <ActionForm
                      action={`${actionBase}/deploy`}
                      scopeQuery={scopeQuery}
                      fields={[
                        {
                          kind: 'permission-select',
                          name: 'grantedPermissions',
                          label: 'Grant for this deploy — narrow if you want',
                          hint: 'The effective runtime grant; the manifest ceiling bounds it and the deployed grant is frozen into the deployment record.',
                          options: manifest.requestedPermissions.map((permission) => {
                            const copy = EXTENSION_PERMISSION_COPY[permission];
                            return {
                              value: permission,
                              label: copy?.label ?? permission,
                              description: copy?.description ?? '',
                            };
                          }),
                        },
                      ]}
                      hidden={{ manifestId: manifest.manifestId }}
                      submitLabel={`Deploy v${manifest.version}`}
                      note="A deploy supersedes the current deployment of the default install (the record stays in history for rollback)."
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="aurum-item-text" style={{ marginTop: 10 }}>
          <Link className="aurum-mkt-link" href={`/marketplace/installed${scopeQuery}`}>
            ← back to installed
          </Link>
        </p>
      </Panel>

      {/* --- deployment history + rollback --- */}
      <Panel
        title="Deployment history & rollback"
        blurb="Every recorded deployment of the default install, append-only. Rollback restores a superseded deployment's exact recorded grant — never a fresh negotiation."
      >
        {view.deployments.length === 0 ? (
          <EmptyState
            title="No deployments recorded"
            hint="Deploy a version first; every deployment is kept for rollback."
          />
        ) : (
          <ul className="aurum-item-list">
            {view.deployments.map((deployment) => (
              <li key={deployment.id}>
                <div className="aurum-item-head">
                  <span className="aurum-item-title">
                    v{deployment.version}{' '}
                    <span className="aurum-mono">{deployment.operation}</span>
                  </span>
                  {deployment.isCurrent ? (
                    <Tag>
                      <StatusPill tone="positive">current</StatusPill>
                    </Tag>
                  ) : null}
                </div>
                <div className="aurum-item-foot">
                  <span className="aurum-mono">install {deployment.installKey}</span>
                  <span>{deployment.grantedPermissions.length} granted</span>
                  <span>deployed {deployment.deployedAt.slice(0, 10)}</span>
                </div>
                {view.canGovern && deployment.isRollbackTarget ? (
                  <div style={{ marginTop: 10 }}>
                    <ActionForm
                      action={`${actionBase}/rollback`}
                      scopeQuery={scopeQuery}
                      fields={[]}
                      hidden={{ targetDeploymentId: deployment.id }}
                      submitLabel={`Roll back to v${deployment.version}`}
                      variant="quiet"
                      confirmPrompt={`Rolling back restores version ${deployment.version}'s exact recorded grant.`}
                      note="Rollback targets a superseded deployment of the same install; the rollback itself passes the authority gate."
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
