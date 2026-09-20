// Product surface (W064) — the Marketplace area: PACKAGE DETAIL.
//
// Journey J's "inspect permissions" step, and the governance home of
// one package: the governed-chain position, the permission ceiling the
// package requests (both kinds — agent packages inspect the same way),
// the capability declaration and quotas (extensions), the append-only
// verification/review evidence, the lifecycle trail, and exactly the
// actions THIS caller may legally take — vendor submission, the
// platform's verification/review/publish/installable decisions, and
// tenant installation.

import Link from 'next/link';
import { withProductScope } from '../../../lib/context';
import { resolveSession } from '@/app/lib/session';
import type { PageSearchParams } from '../../../lib/context';
import { buildPackageView, publicBrowsingContext } from '../../lib/views';
import { isAgentPackage, isExtensionPackage } from '@/modules/marketplace/contract';
import {
  EmptyState,
  ErrorState,
  PageHead,
  Panel,
  StatusPill,
  Tag,
} from '../../../components/states';
import { ActionForm } from '../../components/action-form';
import { verificationTone } from '../../lib/labels';

export const dynamic = 'force-dynamic';

function ChainView({ chain }: { chain: { state: string; label: string; reached: boolean; isRejected: boolean }[] }) {
  return (
    <ol className="aurum-mkt-chain" aria-label="Governed chain">
      {chain.map((node) => (
        <li
          key={node.state}
          data-reached={node.reached}
          data-rejected={node.isRejected}
          aria-current={node.reached ? 'step' : undefined}
        >
          <span className="aurum-mkt-chain-dot" aria-hidden="true" />
          <span className="aurum-mkt-chain-label">{node.label}</span>
        </li>
      ))}
    </ol>
  );
}

export default async function PackagePage({
  params,
  searchParams,
}: {
  params: Promise<{ packageId: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { packageId } = await params;
  const query = await searchParams;
  // W058: scope comes from the session; anonymous visitors inspect the
  // public listing with the claim-less browsing context (read-only).
  const session = await resolveSession();
  const scoped = session.status === 'authenticated';
  const ctx = scoped ? session.context : publicBrowsingContext();
  const scopeQuery = withProductScope(query);
  const result = await buildPackageView(ctx, packageId);

  if (!result.ok) {
    if (result.failure === 'not_found') {
      return (
        <>
          <PageHead
            title="Package not found"
            description="This package does not exist in the catalog, or it is another company's pre-publication work — which is indistinguishable from missing by design."
          />
          <div style={{ marginTop: 14 }}>
            <EmptyState
              title="Nothing to show"
              hint="Only published and installable packages are public; a vendor's draft is visible to the vendor and the platform alone."
              action={
                <Link className="aurum-btn" data-variant="quiet" href={`/marketplace${scopeQuery}`}>
                  Back to the catalog
                </Link>
              }
            />
          </div>
        </>
      );
    }
    return (
      <>
        <PageHead title="Marketplace" description="One governed package." />
        <div style={{ marginTop: 14 }}>
          <ErrorState
            title="Read failed"
            detail="The package could not be read right now. Nothing changed — try again in a moment."
            retryHref={`/marketplace/package/${packageId}${scopeQuery}`}
          />
        </div>
      </>
    );
  }

  const view = result.view;
  const { pkg, actions, evidence } = view;
  const backHref = `/marketplace${scopeQuery}`;
  const actionBase = `/api/product/marketplace/package/${pkg.id}`;
  const unscopedNotice = scoped ? null : (
    <div className="aurum-notice">
      You are inspecting a public listing without signing in. Acting on it
      (installing) needs your company scope — sign in first; the action then
      carries your session&apos;s verified scope.
    </div>
  );

  const latestRun = evidence.verification.latestRun;
  const hasChecks = latestRun !== null && latestRun.checks.length > 0;

  return (
    <>
      <PageHead
        title={pkg.displayName}
        description={pkg.description ?? 'A governed marketplace package.'}
        meta={
          <span>
            <Tag>{view.kindLabel}</Tag>
            <span className="aurum-mono" style={{ marginLeft: 8 }}>
              {pkg.packageKey} · v{pkg.version}
            </span>
          </span>
        }
      />
      {unscopedNotice}

      <div className="aurum-mkt-detail-grid">
        {/* --- status + chain --- */}
        <Panel
          title="Status"
          blurb={view.stateExplanation}
          meta={<StatusPill tone={view.stateTone}>{view.stateLabel}</StatusPill>}
        >
          <ChainView chain={view.chain} />
          <div className="aurum-mkt-meta-lines">
            <span>
              vendor <span className="aurum-mono">{pkg.vendorTenant.slice(0, 13)}…</span>
            </span>
            <span>
              frozen artifact <span className="aurum-mono">{pkg.id.slice(0, 13)}…</span>
            </span>
            <span>updated {pkg.updatedAt.slice(0, 10)}</span>
          </div>
          <p className="aurum-item-text" style={{ marginTop: 10 }}>
            <Link className="aurum-mkt-link" href={backHref}>
              ← back to the catalog
            </Link>
          </p>
        </Panel>

        {/* --- permission inspection (both kinds) --- */}
        <Panel
          title="Requested permissions"
          blurb={
            pkg.kind === 'extension'
              ? 'The manifest ceiling: exactly the set the declared capabilities require — the grant at install time is bounded by this and may be narrowed.'
              : 'The agent blueprint\'s permission scopes — the same closed vocabulary tenant agents are governed by. Installing registers the blueprint with these scopes.'
          }
          meta={<span>{view.permissions.length} requested</span>}
        >
          {view.permissions.length === 0 ? (
            <EmptyState title="No permissions requested" hint="This package requests no runtime capability." />
          ) : (
            <ul className="aurum-mkt-perm-list-static">
              {view.permissions.map((permission) => (
                <li key={permission.key}>
                  <span className="aurum-mkt-perm-key aurum-mono">{permission.key}</span>
                  <span className="aurum-mkt-perm-body-static">
                    <strong>{permission.label}</strong>
                    <span>{permission.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* --- capability declaration + quotas (extensions) --- */}
        {isExtensionPackage(pkg) ? (
          <Panel
            title="Capability declaration"
            blurb="What the extension declares it does — least privilege is enforced against this, not requested."
          >
            <ul className="aurum-mkt-cap-list">
              {view.capabilities.map((line) => (
                <li key={line.label}>
                  <span className="aurum-mkt-cap-label">{line.label}</span>
                  <span>{line.detail}</span>
                </li>
              ))}
            </ul>
            <h3 className="aurum-mkt-subhead">Declared quotas</h3>
            <ul className="aurum-mkt-cap-list">
              {view.quotas.map((line) => (
                <li key={line.label}>
                  <span className="aurum-mkt-cap-label">{line.label}</span>
                  <span>{line.detail}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : isAgentPackage(pkg) ? (
          <Panel
            title="Agent blueprint"
            blurb="What the package installs: role, operating instructions, canonical runtime provider. Runtime accounts stay tenant-owned — a vendor artifact never carries credentials."
          >
            <ul className="aurum-mkt-cap-list">
              <li>
                <span className="aurum-mkt-cap-label">Role</span>
                <span>{pkg.payload.role}</span>
              </li>
              <li>
                <span className="aurum-mkt-cap-label">Runtime provider</span>
                <span>{pkg.payload.provider}</span>
              </li>
              <li>
                <span className="aurum-mkt-cap-label">Instructions</span>
                <span className="aurum-mkt-instructions">{pkg.payload.instructions}</span>
              </li>
            </ul>
          </Panel>
        ) : null}

        {/* --- automated verification evidence --- */}
        <Panel
          title="Automated verification"
          blurb="Append-only runs of the deterministic checks — the same rules the registry and the builder run. The latest run decides the posture; drift appears as a new run, never a rewrite."
          meta={
            <StatusPill tone={verificationTone(evidence.verification.outcome)}>
              {evidence.verification.outcome === 'verified'
                ? 'Verified'
                : evidence.verification.outcome === 'failed'
                  ? 'Failed'
                  : 'Unverified'}
            </StatusPill>
          }
        >
          {!hasChecks ? (
            <EmptyState
              title="No verification runs yet"
              hint="Automated verification runs when the platform processes the submission — a vendor cannot run it on its own package."
            />
          ) : (
            <>
              <ul className="aurum-mkt-checks">
                {latestRun!.checks.map((check) => (
                  <li key={check.check} data-outcome={check.outcome}>
                    <span className="aurum-mkt-check-name">{check.check}</span>
                    <span className="aurum-mkt-check-detail">
                      {check.detail === null ? 'passed' : check.detail}
                    </span>
                  </li>
                ))}
              </ul>
              {evidence.runs.length > 1 ? (
                <p className="aurum-item-text" style={{ marginTop: 8 }}>
                  {evidence.runs.length} runs recorded (newest shown).
                </p>
              ) : null}
            </>
          )}
        </Panel>

        {/* --- review decisions + lifecycle trail --- */}
        <Panel
          title="Platform review"
          blurb="The mandatory human decision — the reviewer is provably neither the vendor's tenant nor its principal."
        >
          {evidence.reviews.length === 0 ? (
            <EmptyState
              title="No review decision yet"
              hint="Reviews land here with their decision, reason and reviewer provenance."
            />
          ) : (
            <ul className="aurum-item-list">
              {evidence.reviews.map((review) => (
                <li key={review.id}>
                  <div className="aurum-item-head">
                    <span className="aurum-item-title">
                      {review.decision === 'approve' ? 'Approved' : 'Rejected'}
                    </span>
                    <StatusPill tone={review.decision === 'approve' ? 'positive' : 'error'}>
                      {review.decision === 'approve' ? 'approved' : 'rejected'}
                    </StatusPill>
                  </div>
                  <p className="aurum-item-text">
                    {review.reason ?? 'no reason recorded'}
                  </p>
                  <div className="aurum-item-foot">
                    <span>reviewed {review.reviewedAt.slice(0, 10)}</span>
                    <span className="aurum-mono">by {review.reviewedByPrincipal.slice(0, 13)}…</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <h3 className="aurum-mkt-subhead">Lifecycle trail</h3>
          {evidence.lifecycle.length === 0 ? (
            <EmptyState title="No transitions recorded" hint="Each state change lands here with who moved it and when." />
          ) : (
            <ul className="aurum-mkt-trail">
              {evidence.lifecycle.map((event) => (
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
      </div>

      {/* --- the actions this caller may legally take --- */}
      <Panel
        title="Actions"
        blurb="Exactly what YOUR scope may do with this package right now — the same rules the domain contracts enforce."
      >
        {!scoped ? (
          <EmptyState
            title="Acting needs a company scope"
            hint="Sign in with a company to install or govern this package — the action then carries your session's verified scope."
            action={
              <Link className="aurum-btn" data-variant="quiet" href="/signin">
                Sign in
              </Link>
            }
          />
        ) : (
          <div className="aurum-mkt-action-grid">
            {actions.canSubmit ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Submit for verification (vendor)</h3>
                <ActionForm
                  action={`${actionBase}/submit`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  submitLabel="Submit to the platform pipeline"
                  note="DRAFT → SUBMITTED. The vendor hands the frozen artifact to the platform; verification and review are not the vendor's to run."
                />
              </div>
            ) : null}

            {actions.canRunVerification ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Run automated verification (platform)</h3>
                <ActionForm
                  action={`${actionBase}/verify`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  submitLabel="Run the deterministic checks"
                  note="SUBMITTED → PENDING_REVIEW or REJECTED. A failed check rejects the package with the evidence recorded."
                />
              </div>
            ) : null}

            {actions.canReview ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Platform review decision</h3>
                <ActionForm
                  action={`${actionBase}/review`}
                  scopeQuery={scopeQuery}
                  fields={[
                    {
                      kind: 'select',
                      name: 'decision',
                      label: 'Decision',
                      options: [
                        { value: 'approve', label: 'Approve' },
                        { value: 'reject', label: 'Reject' },
                      ],
                    },
                    {
                      kind: 'text',
                      name: 'reason',
                      label: 'Reason (required to reject)',
                      placeholder: 'Why the platform reached this decision',
                    },
                  ]}
                  submitLabel="Record the review decision"
                  confirmPrompt="I am deciding on the platform's behalf, and I am not this package's vendor."
                  note="PENDING_REVIEW → APPROVED or REJECTED. The decision is append-only evidence; rejection is terminal for this version."
                />
              </div>
            ) : null}

            {actions.reviewBlockedBySeparation ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Review</h3>
                <div className="aurum-notice">
                  Separation of duties: this package&apos;s vendor is your own tenant or principal.
                  A vendor can never review its own package — even with the administer claim.
                </div>
              </div>
            ) : null}

            {actions.canPublish ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Publish (platform)</h3>
                <ActionForm
                  action={`${actionBase}/publish`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  submitLabel="Publish to the catalog"
                  confirmPrompt="Publishing lists this version publicly; installation stays separately gated."
                  note="APPROVED → PUBLISHED. Publication never implies installation."
                />
              </div>
            ) : null}

            {actions.canMakeInstallable ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Make installable (platform)</h3>
                <ActionForm
                  action={`${actionBase}/make-installable`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  submitLabel="Clear for installation"
                  confirmPrompt="Tenants will be able to install this version."
                  note="PUBLISHED → INSTALLABLE — the platform's installation-gating decision."
                />
              </div>
            ) : null}

            {actions.canInstall && pkg.kind === 'extension' ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Install into your company</h3>
                <ActionForm
                  action={`${actionBase}/install`}
                  scopeQuery={scopeQuery}
                  fields={[
                    {
                      kind: 'permission-select',
                      name: 'grantedPermissions',
                      label: 'Runtime grant — narrow if you want',
                      hint: 'The manifest ceiling is what the package REQUESTS; the grant is what your company actually allows. Uncheck to narrow.',
                      options: view.permissions.map((permission) => ({
                        value: permission.key,
                        label: permission.label,
                        description: permission.description,
                      })),
                    },
                  ]}
                  submitLabel="Install this version"
                  confirmPrompt="I inspected the requested permissions and accept the grant I selected."
                  note="Install registers the version in your registry, verifies it, activates it, and deploys it to the 'default' install — each step reports honestly, and approval-gated steps wait for a human decision."
                />
              </div>
            ) : null}

            {actions.canInstall && pkg.kind === 'agent' ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Install the agent blueprint</h3>
                <ActionForm
                  action={`${actionBase}/install`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  submitLabel="Register the agent in your company"
                  confirmPrompt="I inspected the blueprint's permission scopes and accept them."
                  note="Installing an agent package registers the blueprint as a tenant agent (role, instructions, provider, scopes). Runtime accounts and the recruitment workflow stay yours to configure."
                />
              </div>
            ) : null}

            {!actions.canInstall && actions.installBlockedReason !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Install</h3>
                <div className="aurum-notice">{actions.installBlockedReason}</div>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </>
  );
}
