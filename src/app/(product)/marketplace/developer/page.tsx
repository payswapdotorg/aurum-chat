// Product surface (W064) — the Marketplace area: DEVELOPER.
//
// The builder/publish console (Journey J's "developer publish" half):
//   * the BUILDER — request extension builds (design → build → verify →
//     deploy through the tenant's builder agents), advance them one
//     phase at a time, cancel with a recorded reason;
//   * the PUBLISH flow — freeze a registry manifest version as an
//     extension package, or author an agent package blueprint, then
//     walk the governed chain from the package's own page;
//   * the vendor's own packages in every state;
//   * the platform REVIEW QUEUE (the administer claim) — the same
//     governed surface, seen from the platform side.
//
// Everything rendered is REAL state through the module contracts; the
// forms POST to the thin API adapters and the page re-renders from the
// server on refresh. No claims, no surface: the page says exactly which
// claim the developer experience needs instead of pretending.

import Link from 'next/link';
import { requirePageScope } from '@/app/lib/page-session';
import { buildDeveloperView } from '../lib/views';
import {
  EmptyState,
  ErrorState,
  PageHead,
  Panel,
  StatusPill,
  Tag,
} from '../../components/states';
import { ActionForm } from '../components/action-form';
import { AGENT_SCOPE_COPY, buildPhaseExplanation } from '../lib/labels';
import {
  AGENT_PERMISSION_SCOPES,
  AGENT_RUNTIME_PROVIDERS,
} from '@/modules/agents/contract';

export const dynamic = 'force-dynamic';

export default async function DeveloperPage() {
  // W058: authenticated routing — the session carries the company scope
  // (and the role-derived authority claims: every member may submit).
  const scope = await requirePageScope('/marketplace/developer');
  const view = await buildDeveloperView(scope.context);

  const activeAgents = view.builderAgents.items.filter((agent) => agent.status === 'active');

  return (
    <>
      <PageHead
        title="Developer"
        description="Build extensions with your builder agents, freeze verified versions as marketplace packages, and walk them through the governed chain — automated verification, platform review, publication, installability. The platform's review queue lives here too."
        meta={<span>Live state · generated {view.generatedAt.slice(11, 19)}Z</span>}
      />

      {!view.usable ? (
        <div className="aurum-notice">
          The developer surface needs one of the authority claims{' '}
          <code>marketplace:submit</code> (publish),{' '}
          <code>extensions:administer</code> (build) or{' '}
          <code>marketplace:administer</code> (platform review). Since the
          authentication experience (W058), every company member carries{' '}
          <code>marketplace:submit</code> with their session; the administer
          claims belong to platform reviewers. The review queue and forms below
          stay honest about what your scope can do.
        </div>
      ) : null}

      {/* ---------------- the builder ---------------- */}
      <Panel
        title="Builder"
        blurb="Request a build session: a tenant-registered agent designs and builds the manifest from your brief — analyze and propose scopes only, never execute — and each advance pumps one phase (design → build → verify → deploy) with the deterministic checks recording evidence."
        meta={<span>{view.builds.items.length} session{view.builds.items.length === 1 ? '' : 's'}</span>}
      >
        {!view.builds.ok ? (
          <ErrorState
            title="Read failed"
            detail="Your build sessions could not be read right now."
          />
        ) : (
          <>
            <ActionForm
              action="/api/product/marketplace/developer/request-build"
              fields={[
                {
                  kind: 'text',
                  name: 'extensionKey',
                  label: 'Extension key',
                  placeholder: 'invoice-ocr',
                  required: true,
                  hint: 'A new key creates a new extension; an existing key builds a strictly newer version.',
                },
                {
                  kind: 'text',
                  name: 'version',
                  label: 'Target version (semver)',
                  placeholder: '1.0.0',
                  required: true,
                },
                {
                  kind: 'select',
                  name: 'agentId',
                  label: 'Builder agent',
                  options:
                    activeAgents.length === 0
                      ? [{ value: '', label: 'No active builder agents registered yet' }]
                      : activeAgents.map((agent) => ({
                          value: agent.id,
                          label: `${agent.displayName} — ${agent.role} (${agent.provider})`,
                        })),
                  hint: 'Builder agents need the analyze and propose scopes (never execute — the agent proposes, the application disposes).',
                },
                {
                  kind: 'text',
                  name: 'brief',
                  label: 'Build brief',
                  placeholder: 'What the extension should be and do',
                  required: true,
                  textarea: true,
                },
              ]}
              submitLabel="Request the build"
              note="The session starts in 'designing' — advance it below, one phase per step."
            />

            {view.builds.items.length === 0 ? (
              <div style={{ marginTop: 14 }}>
                <EmptyState
                  title="No build sessions yet"
                  hint="Request one above; the agent's raw design and build outputs are retained as append-only artifact custody."
                />
              </div>
            ) : (
              <ul className="aurum-item-list" style={{ marginTop: 14 }}>
                {view.builds.items.map((build) => (
                  <li key={build.id}>
                    <div className="aurum-item-head">
                      <span className="aurum-item-title">
                        {build.extensionKey} <span className="aurum-mono">v{build.version}</span>
                      </span>
                      <StatusPill tone={build.phaseTone}>{build.phaseLabel}</StatusPill>
                    </div>
                    <p className="aurum-item-text">{build.brief}</p>
                    {build.failureCode === null ? null : (
                      <p className="aurum-item-text">
                        <span className="aurum-mono">{build.failureCode}</span> —{' '}
                        {build.failureDetail}
                      </p>
                    )}
                    <div className="aurum-item-foot">
                      <span>{buildPhaseExplanation(build.phase)}</span>
                    </div>
                    {build.canAdvance || build.canCancel ? (
                      <div className="aurum-mkt-build-actions">
                        {build.canAdvance ? (
                          <ActionForm
                            action="/api/product/marketplace/developer/advance-build"
                            fields={[]}
                            hidden={{ buildId: build.id }}
                            submitLabel="Advance one phase"
                            variant="quiet"
                          />
                        ) : null}
                        {build.canCancel ? (
                          <ActionForm
                            action="/api/product/marketplace/developer/cancel-build"
                            fields={[
                              {
                                kind: 'text',
                                name: 'reason',
                                label: 'Cancellation reason',
                                required: true,
                              },
                            ]}
                            hidden={{ buildId: build.id }}
                            submitLabel="Cancel this build"
                            variant="quiet"
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>

      {/* ---------------- the publish flow ---------------- */}
      <Panel
        title="Publish"
        blurb="Freeze a verified manifest version from your registry as a marketplace package, or author an agent package blueprint. Both kinds ride the same governed chain: submission, automated verification, platform review, publication, installability."
      >
        <h3 className="aurum-mkt-subhead">Extension package (from your registry)</h3>
        {!view.manifests.ok ? (
          <ErrorState
            title="Read failed"
            detail="Your registry's manifest versions could not be read right now."
          />
        ) : view.manifests.items.length === 0 ? (
          <EmptyState
            title="No manifest versions to publish"
            hint="Build one above (or register a manifest through the API) — then it appears here to freeze."
          />
        ) : (
          <ActionForm
            action="/api/product/marketplace/developer/create-extension-package"
            fields={[
              {
                kind: 'select',
                name: 'manifestId',
                label: 'Manifest version to freeze',
                options: view.manifests.items.map((manifest) => ({
                  value: manifest.manifestId,
                  label: `${manifest.extensionKey} v${manifest.version} — ${manifest.displayName} (${manifest.verificationState.toLowerCase()}, ${manifest.permissionCount} permissions)`,
                })),
                hint: 'The package freezes the manifest content ONCE — the platform never re-reads your registry at review time.',
              },
              {
                kind: 'text',
                name: 'packageKey',
                label: 'Catalog key (optional)',
                placeholder: 'defaults to the extension key',
              },
            ]}
            submitLabel="Create the package (DRAFT)"
          />
        )}

        <h3 className="aurum-mkt-subhead" style={{ marginTop: 22 }}>
          Agent package (the blueprint itself)
        </h3>
        <ActionForm
          action="/api/product/marketplace/developer/create-agent-package"
          fields={[
            {
              kind: 'text',
              name: 'packageKey',
              label: 'Catalog key',
              placeholder: 'collections-negotiator',
              required: true,
            },
            {
              kind: 'text',
              name: 'version',
              label: 'Version (semver)',
              placeholder: '1.0.0',
              required: true,
            },
            {
              kind: 'text',
              name: 'displayName',
              label: 'Display name',
              placeholder: 'Collections Negotiator',
              required: true,
            },
            {
              kind: 'text',
              name: 'description',
              label: 'Description (optional)',
              placeholder: 'What this agent does for a company',
            },
            {
              kind: 'text',
              name: 'role',
              label: 'Role',
              placeholder: 'negotiate outstanding invoices',
              required: true,
            },
            {
              kind: 'select',
              name: 'provider',
              label: 'Runtime provider',
              options: AGENT_RUNTIME_PROVIDERS.map((provider) => ({
                value: provider,
                label: provider,
              })),
              hint: 'The canonical provider the blueprint targets — runtime accounts stay tenant-owned, never vendor-supplied.',
            },
            {
              kind: 'text',
              name: 'instructions',
              label: 'Operating instructions',
              placeholder: 'The agent\u2019s operating contract',
              required: true,
              textarea: true,
            },
            {
              kind: 'permission-select',
              name: 'permissions',
              label: 'Permission scopes',
              hint: 'The blueprint\u2019s scope set — installers get exactly this, the same vocabulary tenant agents are governed by.',
              options: AGENT_PERMISSION_SCOPES.map((scope) => ({
                value: scope,
                label: AGENT_SCOPE_COPY[scope]?.label ?? scope,
                description: AGENT_SCOPE_COPY[scope]?.description ?? '',
              })),
            },
          ]}
          submitLabel="Create the agent package (DRAFT)"
        />
      </Panel>

      {/* ---------------- my packages ---------------- */}
      <Panel
        title="Your packages"
        blurb="Every state your company's packages are in — drafts, submissions, the platform's decisions, published versions. Each opens its governed page."
        meta={<span>{view.packages.items.length} package{view.packages.items.length === 1 ? '' : 's'}</span>}
      >
        {!view.packages.ok ? (
          <ErrorState
            title="Read failed"
            detail="Your packages could not be read right now."
          />
        ) : view.packages.items.length === 0 ? (
          <EmptyState
            title="No packages yet"
            hint="Create one above — it starts as a DRAFT you submit to the platform pipeline."
          />
        ) : (
          <ul className="aurum-item-list">
            {view.packages.items.map((pkg) => (
              <li key={pkg.id}>
                <div className="aurum-item-head">
                  <Link
                    className="aurum-mkt-item-title"
                    href={`/marketplace/package/${pkg.id}`}
                  >
                    {pkg.displayName}
                  </Link>
                  <StatusPill tone={pkg.stateTone}>{pkg.stateLabel}</StatusPill>
                </div>
                <div className="aurum-item-foot">
                  <span className="aurum-mono">
                    {pkg.packageKey} · v{pkg.version}
                  </span>
                  <Tag>{pkg.kindLabel}</Tag>
                </div>
                <p className="aurum-item-text">{pkg.stateExplanation}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ---------------- the platform review queue ---------------- */}
      <Panel
        title="Platform review queue"
        blurb="The platform pipeline view — everything between submission and the platform's decision, both package kinds, exactly as a platform operator sees it."
      >
        {!view.reviewQueue.allowed ? (
          <EmptyState
            title="Needs the platform administer claim"
            hint="Add marketplace:administer to act as a platform operator — and note a vendor can never review its own package, whatever claims it holds."
          />
        ) : !view.reviewQueue.ok ? (
          <ErrorState
            title="Read failed"
            detail="The review queue could not be read right now."
          />
        ) : view.reviewQueue.items.length === 0 ? (
          <EmptyState
            title="The queue is empty"
            hint="Submitted packages land here for automated verification and review."
          />
        ) : (
          <ul className="aurum-item-list">
            {view.reviewQueue.items.map((item) => (
              <li key={item.id}>
                <div className="aurum-item-head">
                  <Link
                    className="aurum-mkt-item-title"
                    href={`/marketplace/package/${item.id}`}
                  >
                    {item.displayName}
                  </Link>
                  <StatusPill tone={item.stateTone}>{item.stateLabel}</StatusPill>
                </div>
                <div className="aurum-item-foot">
                  <span className="aurum-mono">
                    {item.packageKey} · v{item.version}
                  </span>
                  <Tag>{item.kindLabel}</Tag>
                  <span className="aurum-mono">vendor {item.vendorTenant.slice(0, 13)}…</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
