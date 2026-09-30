// Product surface (W105) — the Marketplace area: KIT DETAIL.
//
// The vertical starter kits' real detail destination (Journey J22's
// blocked component): kit identity, the SIGNED version manifest (the
// sha-256 digest of the canonical JSON — the integrity signature), the
// deterministic verification posture (the shipped checks computed over
// the shipped bytes + the tenant's recorded append-only runs), the
// required-capability inspection (what authority the kit requests),
// the starter components (honestly 'defined', never claimed as deployed
// software), the vertical data-schema hints, the declared
// system-of-record integrations with their honest readiness, the
// invocation ledger summary, and the install/lifecycle state with
// exactly the actions THIS caller may legally take.
//
// Kits NEVER ride the extension/agent package flow: their install is
// the vertical-kits module's own lifecycle (register → verify → install
// → the W009 grant review → activate), rendered here with the
// marketplace's own vocabulary.

import type { Metadata } from 'next';
import Link from 'next/link';
import { withProductScope } from '../../../lib/context';
import { resolveSession } from '@/app/lib/session';
import type { PageSearchParams } from '../../../lib/context';
import { buildKitDetailView } from '../../lib/kits';
import { publicBrowsingContext } from '../../lib/views';
import {
  EmptyState,
  ErrorState,
  PageHead,
  Panel,
  StatusPill,
  Tag,
} from '../../../components/states';
import { ActionForm } from '../../components/action-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "One kit — Aurum",
  description: "One marketplace kit: versions, verification evidence, reviews and installation.",
};

export default async function KitPage({
  params,
  searchParams,
}: {
  params: Promise<{ kitKey: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { kitKey } = await params;
  const query = await searchParams;
  // W058: scope comes from the session; an anonymous visitor inspects the
  // shipped starter content with the claim-less browsing context
  // (read-only — every write needs a signed-in session with a company).
  const session = await resolveSession();
  const scoped = session.status === 'authenticated';
  const ctx = scoped ? session.context : publicBrowsingContext();
  const scopeQuery = withProductScope(query);
  const result = await buildKitDetailView(ctx, kitKey);

  if (!result.ok) {
    if (result.failure === 'not_found') {
      return (
        <>
          <PageHead
            title="Kit not found"
            description="This vertical starter kit does not exist. The catalog's kits section lists every shipped starter kit."
          />
          <div style={{ marginTop: 14 }}>
            <EmptyState
              title="Nothing to show"
              hint="Only shipped starter kits have pages here — an unknown kit key is indistinguishable from a missing one by design."
              action={
                <Link className="aurum-btn" data-variant="quiet" href={`/marketplace${scopeQuery}#vertical-kits`}>
                  Back to the catalog's kits
                </Link>
              }
            />
          </div>
        </>
      );
    }
    return (
      <>
        <PageHead title="Marketplace" description="One vertical starter kit." />
        <div style={{ marginTop: 14 }}>
          <ErrorState
            title="Read failed"
            detail="The kit could not be read right now. Nothing changed — try again in a moment."
            retryHref={`/marketplace/kit/${kitKey}${scopeQuery}`}
          />
        </div>
      </>
    );
  }

  const view = result.view;
  const { actions, registry, installation } = view;
  const backHref = `/marketplace${scopeQuery}#vertical-kits`;
  const actionBase = `/api/product/marketplace/kit/${view.kitKey}`;
  const unscopedNotice = scoped ? null : (
    <div className="aurum-notice">
      You are inspecting a shipped starter kit without signing in. Registering,
      verifying or installing it needs your company scope — sign in first; the
      action then carries your session&apos;s verified scope.
    </div>
  );
  const latestRegistered = registry !== null && registry.versions.length > 0 ? registry.versions[0]! : null;

  return (
    <>
      <PageHead
        title={view.displayName}
        description={view.description}
        meta={
          <span>
            <Tag>Vertical starter kit</Tag>
            <span className="aurum-mono" style={{ marginLeft: 8 }}>
              {view.kitKey} · v{view.shippedVersion} · {view.verticalKey}
            </span>
          </span>
        }
      />
      {unscopedNotice}

      <div className="aurum-mkt-detail-grid">
        {/* --- install/lifecycle status --- */}
        <Panel
          title="Install & lifecycle"
          blurb={
            installation === null
              ? 'The vertical-kits install lifecycle: register a version, verify it, install it (the grant review routes through the human authority gate), then activate. This kit has no live installation in your company.'
              : installation.stateExplanation
          }
          meta={
            installation === null ? (
              <StatusPill tone="neutral">Not installed</StatusPill>
            ) : (
              <StatusPill tone={installation.stateTone}>{installation.stateLabel}</StatusPill>
            )
          }
        >
          {installation !== null ? (
            <>
              <div className="aurum-mkt-meta-lines">
                <span>
                  installed version <span className="aurum-mono">v{installation.kitVersion}</span>
                </span>
                <span>installed {installation.installedAt.slice(0, 10)}</span>
                <span>
                  grants <span className="aurum-mono">{installation.grants.active} active · {installation.grants.revoked} revoked</span>
                </span>
                <span>
                  invocations <span className="aurum-mono">{installation.invocations.allowed} allowed · {installation.invocations.denied} denied</span>
                </span>
              </div>
              {installation.status === 'pending-review' ? (
                <p className="aurum-item-text" style={{ marginTop: 10 }}>
                  The grant review is waiting for a human decision.{' '}
                  <Link className="aurum-mkt-link" href={`/approvals${scopeQuery === '' ? '' : scopeQuery}`}>
                    Decide it in Approvals (management mode)
                  </Link>{' '}
                  — or record the decision here below.
                </p>
              ) : null}
            </>
          ) : (
            <p className="aurum-item-text">
              Nothing is installed for this kit in your company yet. The register →
              verify → install steps below are the honest path; installation
              never activates anything on its own.
            </p>
          )}
          <p className="aurum-item-text" style={{ marginTop: 10 }}>
            <Link className="aurum-mkt-link" href={backHref}>
              ← back to the catalog&apos;s kits
            </Link>
          </p>
        </Panel>

        {/* --- the signed version manifest --- */}
        <Panel
          title="The signed version manifest"
          blurb="Every kit version is immutable and carries the sha-256 digest of its manifest's canonical JSON — the integrity signature. A changed declaration is a NEW version, never an edit."
        >
          <div className="aurum-mkt-meta-lines">
            <span>
              kit key <span className="aurum-mono">{view.kitKey}</span>
            </span>
            <span>
              shipped version <span className="aurum-mono">v{view.shippedVersion}</span>
            </span>
            <span>
              manifest digest <span className="aurum-mono">{view.manifestDigest.slice(0, 16)}…</span>
            </span>
            <span>
              contents{' '}
              <span className="aurum-mono">
                {view.capabilities.length} capabilities · {view.components.filter((component) => component.componentKind === 'extension').length}{' '}
                extension definitions · {view.components.filter((component) => component.componentKind === 'agent').length} agent definitions
              </span>
            </span>
          </div>
          {registry !== null ? (
            registry.ok ? (
              registry.versions.length === 0 ? (
                <p className="aurum-item-text" style={{ marginTop: 10 }}>
                  No version of this kit is registered in your registry yet — the
                  shipped content above is the seed your company can register.
                </p>
              ) : (
                <>
                  <h3 className="aurum-mkt-subhead">Your registry</h3>
                  <ul className="aurum-mkt-trail">
                    {registry.versions.map((version) => (
                      <li key={version.id}>
                        <span className="aurum-mono">{version.registeredAt.slice(0, 10)}</span>
                        <span>v{version.version} — {version.verificationState}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : (
              <p className="aurum-item-text" style={{ marginTop: 10 }}>
                Your kit registry could not be read right now — the shipped
                content above still stands.
              </p>
            )
          ) : null}
        </Panel>

        {/* --- required capabilities (the permission inspection) --- */}
        <Panel
          title="Required capabilities"
          blurb="The authority the kit requests — reviewed at install. Approval mints exactly these as kit grants; rejection mints nothing."
          meta={<span>{view.capabilities.length} requested</span>}
        >
          <ul className="aurum-mkt-perm-list-static">
            {view.capabilities.map((capability) => (
              <li key={capability.key}>
                <span className="aurum-mkt-perm-key aurum-mono">{capability.key}</span>
                <span className="aurum-mkt-perm-body-static">
                  <strong>{capability.label}</strong>
                  <span>
                    {capability.mode} · data in play: {capability.dataCategories.join(', ')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        {/* --- verification: the shipped posture + the recorded runs --- */}
        <Panel
          title="Verification"
          blurb="The same deterministic checks registration enforces. The shipped checks are computed over the shipped bytes now; your registry's recorded runs are permanent evidence (drift appears as a new run, never a rewrite)."
          meta={
            <StatusPill tone={view.shippedChecksOutcome === 'verified' ? 'positive' : 'error'}>
              {view.shippedChecksOutcome === 'verified' ? 'Shipped checks pass' : 'Shipped checks fail'}
            </StatusPill>
          }
        >
          <ul className="aurum-mkt-checks">
            {view.shippedChecks.map((check) => (
              <li key={check.check} data-outcome={check.passed ? 'passed' : 'failed'}>
                <span className="aurum-mkt-check-name">{check.check}</span>
                <span className="aurum-mkt-check-detail">
                  {check.detail === null ? 'passed' : check.detail}
                </span>
              </li>
            ))}
          </ul>
          {registry !== null && registry.latestRun !== null ? (
            <>
              <h3 className="aurum-mkt-subhead">Latest recorded run (your registry)</h3>
              <ul className="aurum-mkt-checks">
                {registry.latestRun.checks.map((check) => (
                  <li key={check.check} data-outcome={check.passed ? 'passed' : 'failed'}>
                    <span className="aurum-mkt-check-name">{check.check}</span>
                    <span className="aurum-mkt-check-detail">
                      {check.detail === null ? 'passed' : check.detail}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="aurum-item-text" style={{ marginTop: 8 }}>
                Run recorded {registry.latestRun.ranAt.slice(0, 10)} — outcome:{' '}
                {registry.latestRun.outcome}.
              </p>
            </>
          ) : null}
        </Panel>

        {/* --- starter components (honestly 'defined') --- */}
        <Panel
          title="Starter components"
          blurb="Definitions inside the kit, NOT deployed software — materializing them into your extension/agent registries follows those modules' own governed lifecycles downstream."
        >
          {view.components.length === 0 ? (
            <EmptyState title="No starter components" hint="This kit declares no extension or agent definitions." />
          ) : (
            <ul className="aurum-item-list">
              {view.components.map((component) => (
                <li key={component.componentKind + component.definitionKey}>
                  <div className="aurum-item-head">
                    <span className="aurum-item-title">{component.displayName}</span>
                    <StatusPill tone="neutral">{component.componentKind} · defined</StatusPill>
                  </div>
                  <p className="aurum-item-text">{component.description}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* --- vertical data-schema hints + integrations --- */}
        <Panel
          title="Vertical data & integrations"
          blurb="The system-of-record entities the kit works with (schema hints live inside the manifest — no vertical table ever reaches a core module) and the deep integrations it will reach through the Edge Connector."
        >
          <h3 className="aurum-mkt-subhead">Data-schema hints</h3>
          {view.schemaHints.length === 0 ? (
            <EmptyState title="No schema hints" hint="This kit declares no vertical entities." />
          ) : (
            <ul className="aurum-mkt-cap-list">
              {view.schemaHints.map((hint) => (
                <li key={hint.entity}>
                  <span className="aurum-mkt-cap-label">{hint.label}</span>
                  <span>
                    {hint.fieldCount} fields ({hint.requiredFields.length} required) — entity &apos;{hint.entity}&apos;
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="aurum-mkt-subhead">Declared integrations</h3>
          {view.integrations.length === 0 ? (
            <EmptyState title="No declared integrations" hint="This kit declares no system-of-record edge." />
          ) : (
            <ul className="aurum-item-list">
              {view.integrations.map((integration) => (
                <li key={integration.integrationKey}>
                  <div className="aurum-item-head">
                    <span className="aurum-item-title">{integration.systemLabel}</span>
                    <StatusPill tone={integration.readiness === 'ready' ? 'positive' : 'warning'}>
                      {integration.readiness === 'ready' ? 'ready' : 'deferred on the Edge Connector'}
                    </StatusPill>
                  </div>
                  <p className="aurum-item-text">{integration.description}</p>
                  <div className="aurum-item-foot">
                    <span className="aurum-mono">
                      read {integration.readCapabilityKey}
                      {integration.writeCapabilityKey === null ? ' · read-only' : ` · write ${integration.writeCapabilityKey}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* --- the invocation ledger (when installed) --- */}
        {installation !== null ? (
          <Panel
            title="Invocation ledger"
            blurb="Every capability-invocation verdict, allowed or denied — permanently recorded, with the deterministic denial reason."
            meta={
              <span>
                {installation.invocations.allowed} allowed · {installation.invocations.denied} denied
              </span>
            }
          >
            {installation.recentInvocations.length === 0 ? (
              <EmptyState
                title="No invocations yet"
                hint="Capability invocations land here with their verdict — the kit runtime never fakes a pass."
              />
            ) : (
              <ul className="aurum-mkt-trail">
                {installation.recentInvocations.map((invocation) => (
                  <li key={invocation.id}>
                    <span className="aurum-mono">{invocation.invokedAt.slice(0, 10)}</span>
                    <span>
                      {invocation.capabilityKey} — {invocation.outcome}
                      {invocation.denialReason === null ? '' : `: ${invocation.denialReason}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="aurum-mkt-subhead">Lifecycle audit trail</h3>
            {installation.recentEvents.length === 0 ? (
              <EmptyState title="No events yet" hint="Every install/review/transition and minted/revoked grant lands here." />
            ) : (
              <ul className="aurum-mkt-trail">
                {installation.recentEvents.map((event) => (
                  <li key={event.id}>
                    <span className="aurum-mono">{event.recordedAt.slice(0, 10)}</span>
                    <span>
                      {event.event}
                      {event.detail === null ? '' : ` — ${event.detail}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}
      </div>

      {/* --- the actions this caller may legally take --- */}
      <Panel
        title="Actions"
        blurb="Exactly what YOUR scope may do with this kit right now — the vertical-kits lifecycle, never the extension package flow. Each move is one governed contract operation."
      >
        {!scoped ? (
          <EmptyState
            title="Acting needs a company scope"
            hint="Sign in with a company to register, verify or install this kit — the action then carries your session's verified scope."
            action={
              <Link className="aurum-btn" data-variant="quiet" href="/signin">
                Sign in
              </Link>
            }
          />
        ) : (
          <div className="aurum-mkt-action-grid">
            {actions.canRegister ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Register the shipped version</h3>
                <ActionForm
                  action={`${actionBase}/register`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  submitLabel={`Register v${view.shippedVersion} in your registry`}
                  note="Registration freezes the shipped manifest (with its digest) as an immutable version in YOUR registry — the deterministic checks run as part of it."
                />
              </div>
            ) : null}

            {!actions.canRegister && actions.registerBlockedReason !== null && actions.canAdminister && latestRegistered === null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Register</h3>
                <div className="aurum-notice">{actions.registerBlockedReason}</div>
              </div>
            ) : null}

            {actions.canRunVerification ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Run verification</h3>
                <ActionForm
                  action={`${actionBase}/verify`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  hidden={latestRegistered === null ? {} : { kitVersionId: latestRegistered.id }}
                  submitLabel="Record a verification run"
                  note="Checks re-run against the exact bytes that were published — any later change is caught and recorded."
                />
              </div>
            ) : null}

            {actions.canInstall ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Install into your company</h3>
                <ActionForm
                  action={`${actionBase}/install`}
                  scopeQuery={scopeQuery}
                  fields={[
                    {
                      kind: 'text',
                      name: 'justification',
                      label: 'Why this kit (optional)',
                      placeholder: 'The approver-facing justification for the grant review',
                    },
                  ]}
                  hidden={latestRegistered === null ? {} : { version: latestRegistered.version }}
                  submitLabel="Install the verified version"
                  confirmPrompt="I inspected the required capabilities and accept that approval grants exactly them."
                  note="Install routes the grant review through the human authority gate: under the default policy it waits for a decision (here or in Approvals); approval mints exactly the declared capabilities, rejection mints nothing."
                />
              </div>
            ) : null}

            {!actions.canInstall && actions.installBlockedReason !== null && actions.canAdminister ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Install</h3>
                <div className="aurum-notice">{actions.installBlockedReason}</div>
              </div>
            ) : null}

            {actions.canDecideReview ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Grant review decision</h3>
                <ActionForm
                  action={`${actionBase}/decide-review`}
                  scopeQuery={scopeQuery}
                  fields={[
                    {
                      kind: 'select',
                      name: 'decision',
                      label: 'Decision',
                      options: [
                        { value: 'approve', label: 'Approve — mint the declared capabilities' },
                        { value: 'reject', label: 'Reject — mint nothing' },
                      ],
                    },
                    {
                      kind: 'text',
                      name: 'note',
                      label: 'Note (optional)',
                      placeholder: 'Why the review reached this decision',
                    },
                  ]}
                  hidden={installation === null ? {} : { installationId: installation.id }}
                  submitLabel="Record the review decision"
                  confirmPrompt="I am deciding the grant review, and I am not the principal who requested this install."
                  note="The approval is recorded by a person, not the vendor — decisions are permanent."
                />
              </div>
            ) : null}

            {!actions.canDecideReview && actions.decideBlockedReason !== null && installation !== null && installation.status === 'pending-review' ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Grant review</h3>
                <div className="aurum-notice">{actions.decideBlockedReason}</div>
              </div>
            ) : null}

            {actions.canActivate && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Activate</h3>
                <ActionForm
                  action={`${actionBase}/activate`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Activate the kit"
                  note="granted → active. Only an active kit's capability invocations pass the gate."
                />
              </div>
            ) : null}

            {actions.canSuspend && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Suspend</h3>
                <ActionForm
                  action={`${actionBase}/suspend`}
                  scopeQuery={scopeQuery}
                  fields={[
                    {
                      kind: 'text',
                      name: 'reason',
                      label: 'Reason (optional)',
                      placeholder: 'Why the kit is being parked',
                    },
                  ]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Suspend the kit"
                  note="active → suspended. Every invocation is denied while suspended; resuming returns it to active."
                />
              </div>
            ) : null}

            {actions.canResume && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Resume</h3>
                <ActionForm
                  action={`${actionBase}/resume`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Resume the kit"
                  note="suspended → active."
                />
              </div>
            ) : null}

            {actions.canRemove && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Remove (terminal)</h3>
                <ActionForm
                  action={`${actionBase}/remove`}
                  scopeQuery={scopeQuery}
                  variant="danger"
                  fields={[
                    {
                      kind: 'text',
                      name: 'reason',
                      label: 'Reason (recommended)',
                      placeholder: 'Why the kit is being removed',
                    },
                  ]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Remove the kit"
                  confirmPrompt="Removal is terminal: every active grant is revoked with the kit and a fresh install starts a new lifecycle."
                  note="Every grant is revoked (no orphaned authority); the audit trail is retained permanently."
                />
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </>
  );
}
