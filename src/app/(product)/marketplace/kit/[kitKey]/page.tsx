// Product surface (W105) — the Marketplace area: VERTICAL KIT DETAIL.
//
// The W092 vertical starter kits' detail destination (the kit-scoped
// companion of /marketplace/package/:id, reachable from the catalog's
// kits section): kit identity, the SIGNED version manifest (the frozen
// content + its sha-256 integrity digest), the verification status
// (the module's own deterministic checks — over the stored registry
// version when registered, honestly labeled as the shipped-manifest
// posture when not), the invocation ledger summary, and the
// install/lifecycle state with exactly the actions THIS caller may
// legally take through the vertical-kits module's own lifecycle —
// install (register → verify → the W009 grant-review gate), the human
// review decision, activate/suspend/resume, and terminal removal.
//
// The kits are NOT marketplace packages: they carry no DRAFT→…→
// INSTALLABLE chain and no platform review. Their real states are
// surfaced exactly as the vertical-kits module records them — SIGNED
// (digest), VERIFIED (deterministic checks), and the tenant install
// lifecycle (pending-review → granted → active ⇄ suspended → removed,
// rejected terminal).

import Link from 'next/link';
import { withProductScope } from '../../../lib/context';
import { resolveSession } from '@/app/lib/session';
import type { PageSearchParams } from '../../../lib/context';
import { publicBrowsingContext } from '../../lib/views';
import { buildKitDetailView } from '../../lib/kit-views';
import {
  KIT_CHAIN,
  KIT_KIND_LABEL,
  KIT_TRANSITION_COPY,
  kitChainReached,
  kitChainRejected,
  kitInstallationStateExplanation,
  kitInstallationStateLabel,
  kitInstallPosture,
  kitVerificationLabel,
  kitVerificationTone,
  shortDigest,
} from '../../lib/kit-labels';
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

function KitChainView({
  reached,
  rejected,
}: {
  reached: boolean[];
  rejected: boolean;
}) {
  return (
    <ol className="aurum-mkt-chain" aria-label="Kit install lifecycle">
      {KIT_CHAIN.map((state, index) => (
        <li
          key={state}
          data-reached={reached[index] === true}
          data-rejected={rejected && index === 0}
          aria-current={reached[index] === true ? 'step' : undefined}
        >
          <span className="aurum-mkt-chain-dot" aria-hidden="true" />
          <span className="aurum-mkt-chain-label">
            {kitInstallationStateLabel(state)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default async function VerticalKitPage({
  params,
  searchParams,
}: {
  params: Promise<{ kitKey: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { kitKey } = await params;
  const query = await searchParams;
  // W058: scope comes from the session; an anonymous visitor inspects
  // the shipped kit content with the claim-less browsing context
  // (read-only — the signed manifest and the deterministic verification
  // posture are first-party module content, not tenant data).
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
            description="This kit is neither a shipped vertical starter kit nor a version registered in your company's kit registry — which is indistinguishable from missing by design."
          />
          <div style={{ marginTop: 14 }}>
            <EmptyState
              title="Nothing to show"
              hint="The catalog lists the platform's shipped vertical starter kits; a tenant's own registered kit versions are visible to that tenant alone."
              action={
                <Link className="aurum-btn" data-variant="quiet" href={`/marketplace${scopeQuery}#vertical-kits`}>
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
  const { manifest, verification, installation, runtime, actions } = view;
  const actionBase = `/api/product/marketplace/kit/${manifest.kitKey}`;
  const backHref = `/marketplace${scopeQuery}#vertical-kits`;
  const unscopedNotice = scoped ? null : (
    <div className="aurum-notice">
      You are inspecting a shipped starter kit without signing in. Its manifest,
      digest and verification posture are first-party platform content — but
      installing or governing it needs your company scope; sign in first.
    </div>
  );

  const posture = kitInstallPosture(installation?.status ?? null);
  const reached = kitChainReached(
    installation?.status ?? 'pending-review',
    runtime?.events.map((event) => event.event) ?? [],
  );
  const rejected = kitChainRejected(installation?.status ?? 'pending-review');

  return (
    <>
      <PageHead
        title={manifest.displayName}
        description={manifest.description}
        meta={
          <span>
            <Tag>{KIT_KIND_LABEL}</Tag>
            <span className="aurum-mono" style={{ marginLeft: 8 }}>
              {manifest.kitKey} · v{manifest.version}
            </span>
          </span>
        }
      />
      {unscopedNotice}

      <div className="aurum-mkt-detail-grid">
        {/* --- install/lifecycle status + chain --- */}
        <Panel
          title="Install lifecycle"
          blurb={
            installation === null
              ? "Not installed in your company. The kit installs through the vertical-kits module's own lifecycle — the tenant grant review rides the authority gate, not the marketplace package chain."
              : kitInstallationStateExplanation(installation.status)
          }
          meta={<StatusPill tone={posture.tone}>{posture.label}</StatusPill>}
        >
          {installation === null ? (
            <p className="aurum-item-text">
              Kits carry no DRAFT→INSTALLABLE marketplace chain: a kit version is{' '}
              <strong>signed</strong> (its manifest digest) and{' '}
              <strong>verified</strong> (the deterministic checks below) the moment
              it is registered — installability is the verification posture itself,
              and installation is the tenant grant review.
            </p>
          ) : (
            <KitChainView reached={reached} rejected={rejected} />
          )}
          <div className="aurum-mkt-meta-lines">
            <span>
              vertical <span className="aurum-mono">{manifest.verticalKey}</span>
            </span>
            <span>
              manifest digest{' '}
              <span className="aurum-mono" title={view.manifestDigest}>
                {shortDigest(view.manifestDigest)}
              </span>
            </span>
            <span>
              {view.registered
                ? `registered in your registry ${view.registeredAt?.slice(0, 10) ?? ''}`
                : 'shipped content — not yet in your registry'}
            </span>
          </div>
          {view.versions.length > 1 ? (
            <p className="aurum-item-text" style={{ marginTop: 8 }}>
              {view.versions.length} immutable versions recorded (newest v
              {view.versions[0]!.version}); a changed kit ships as a NEW version,
              never an edit.
            </p>
          ) : null}
          <p className="aurum-item-text" style={{ marginTop: 10 }}>
            <Link className="aurum-mkt-link" href={backHref}>
              ← back to the catalog
            </Link>
          </p>
        </Panel>

        {/* --- requested authority (the grant review's payload) --- */}
        <Panel
          title="Required capabilities"
          blurb="The authority the kit asks your company to grant — reviewed at install. Approval mints EXACTLY this set as kit grants; rejection mints nothing."
          meta={<span>{view.capabilities.length} requested</span>}
        >
          {view.capabilities.length === 0 ? (
            <EmptyState title="No capabilities requested" hint="This kit requests no tenant authority." />
          ) : (
            <ul className="aurum-mkt-perm-list-static">
              {view.capabilities.map((capability) => (
                <li key={capability.key}>
                  <span className="aurum-mkt-perm-key aurum-mono">{capability.key}</span>
                  <span className="aurum-mkt-perm-body-static">
                    <strong>{capability.label}</strong>
                    <span>
                      {capability.mode} · data categories:{' '}
                      {capability.dataCategories.join(', ')}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* --- deterministic verification evidence --- */}
        <Panel
          title="Verification"
          blurb="The vertical-kits module's own deterministic checks — the same rules registration enforces and runKitVerification re-examines over the STORED bytes. The latest run decides; drift appears as a new run, never a rewrite."
          meta={
            <StatusPill tone={kitVerificationTone(verification.state)}>
              {kitVerificationLabel(verification.state)}
            </StatusPill>
          }
        >
          {verification.checks.length === 0 ? (
            <EmptyState
              title="No verification evidence"
              hint={
                verification.source === 'registry-run'
                  ? 'No append-only verification run has been recorded for the registered version yet — install runs one automatically.'
                  : 'The shipped manifest carries no run evidence until your registry records the version.'
              }
            />
          ) : (
            <>
              <ul className="aurum-mkt-checks">
                {verification.checks.map((check) => (
                  <li key={check.check} data-outcome={check.passed ? 'pass' : 'fail'}>
                    <span className="aurum-mkt-check-name">{check.check}</span>
                    <span className="aurum-mkt-check-detail">
                      {check.detail === null ? 'passed' : check.detail}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="aurum-item-text" style={{ marginTop: 8 }}>
                {verification.source === 'registry-run'
                  ? `Append-only run over the stored version${verification.ranAt === null ? '' : ` — ran ${verification.ranAt.slice(0, 10)}`}.`
                  : 'The same deterministic checks over the shipped manifest — your registry records its own append-only run at install.'}
              </p>
            </>
          )}
        </Panel>

        {/* --- starter components (definitions, honestly) --- */}
        <Panel
          title="Starter components"
          blurb="Definitions INSIDE the kit — not deployed software. Materializing them into your extension/agent registries follows those modules' own governed lifecycles downstream."
          meta={
            <span>
              {manifest.extensionDefinitions.length} extensions ·{' '}
              {manifest.agentDefinitions.length} agents
            </span>
          }
        >
          {manifest.extensionDefinitions.length === 0 &&
          manifest.agentDefinitions.length === 0 ? (
            <EmptyState title="No starter components" hint="This kit declares no extension or agent definitions." />
          ) : (
            <ul className="aurum-mkt-cap-list">
              {manifest.extensionDefinitions.map((definition) => (
                <li key={definition.definitionKey}>
                  <span className="aurum-mkt-cap-label">{definition.displayName}</span>
                  <span>
                    starter extension · {definition.requestedPermissions.length} permission
                    {definition.requestedPermissions.length === 1 ? '' : 's'} ·{' '}
                    {definition.capabilities.schedules.length > 0 ? 'scheduled' : 'event/ui-driven'}{' '}
                    · <strong>defined</strong> (not deployed)
                  </span>
                </li>
              ))}
              {manifest.agentDefinitions.map((definition) => (
                <li key={definition.definitionKey}>
                  <span className="aurum-mkt-cap-label">{definition.displayName}</span>
                  <span>
                    starter agent · {definition.role} · {definition.provider} ·{' '}
                    {definition.permissions.length} scope
                    {definition.permissions.length === 1 ? '' : 's'} ·{' '}
                    <strong>defined</strong> (not recruited)
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="aurum-mkt-subhead">Vertical data-schema hints</h3>
          {manifest.dataSchemaHints.length === 0 ? (
            <EmptyState title="No schema hints" hint="This kit declares no system-of-record entity shapes." />
          ) : (
            <ul className="aurum-mkt-cap-list">
              {manifest.dataSchemaHints.map((hint) => (
                <li key={hint.entity}>
                  <span className="aurum-mkt-cap-label">{hint.label}</span>
                  <span>
                    <span className="aurum-mono">{hint.entity}</span> · {hint.fields.length} field
                    {hint.fields.length === 1 ? '' : 's'}
                    {hint.note === null || hint.note === '' ? '' : ` — ${hint.note}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* --- declared integrations --- */}
        <Panel
          title="System-of-record integrations"
          blurb="The deep-integration paths the kit declares for its vertical. With no Edge Connector wired (W088, in flight), every path is honestly deferred — the kit runtime refuses to fake success."
          meta={
            <span>
              {manifest.edgeIntegrations.length} declared ·{' '}
              {runtime !== null && runtime.edgeWired !== null
                ? `edge ${shortDigest(runtime.edgeWired)} wired`
                : 'no edge wired'}
            </span>
          }
        >
          {manifest.edgeIntegrations.length === 0 ? (
            <EmptyState title="No integrations declared" hint="This kit declares no system-of-record edge integrations." />
          ) : (
            <ul className="aurum-mkt-cap-list">
              {(runtime?.integrations ??
                manifest.edgeIntegrations.map((integration) => ({
                  integrationKey: integration.integrationKey,
                  systemLabel: integration.systemLabel,
                  readiness: 'deferred-on-w088' as const,
                }))
              ).map((integration) => (
                <li key={integration.integrationKey}>
                  <span className="aurum-mkt-cap-label">{integration.systemLabel}</span>
                  <span>
                    <span className="aurum-mono">{integration.integrationKey}</span> ·{' '}
                    {integration.readiness === 'ready'
                      ? 'ready'
                      : 'deferred on the Edge Connector (W088)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* --- the invocation ledger + grants + lifecycle trail --- */}
        {installation === null ? (
          <Panel
            title="Invocation ledger"
            blurb="Every capability invocation verdict — allowed or denied — lands in the kit's append-only ledger. Nothing is installed yet, so there is nothing to report."
          >
            <EmptyState
              title="No ledger yet"
              hint="Install the kit and exercise its capabilities — every gate verdict (allowed or denied, with its deterministic reason) records here."
            />
          </Panel>
        ) : (
          <Panel
            title="Invocation ledger & grants"
            blurb="The honest runtime report: which capabilities hold authority, every invocation verdict the gate recorded, and the append-only lifecycle trail."
            meta={
              <span>
                {runtime?.invocations.allowed ?? 0} allowed ·{' '}
                {runtime?.invocations.denied ?? 0} denied
              </span>
            }
          >
            <div className="aurum-mkt-stat-row">
              <span className="aurum-mkt-stat">
                <strong>
                  {runtime?.grants.active ??
                    installation.grants.filter((grant) => grant.status === 'active').length}
                </strong>
                <span>active grants</span>
              </span>
              <span className="aurum-mkt-stat">
                <strong>
                  {runtime?.grants.revoked ??
                    installation.grants.filter((grant) => grant.status === 'revoked').length}
                </strong>
                <span>revoked grants</span>
              </span>
              <span className="aurum-mkt-stat">
                <strong>{runtime?.invocations.allowed ?? 0}</strong>
                <span>invocations allowed</span>
              </span>
              <span className="aurum-mkt-stat">
                <strong>{runtime?.invocations.denied ?? 0}</strong>
                <span>denied</span>
              </span>
            </div>
            {runtime === null || runtime.recentInvocations.length === 0 ? (
              <EmptyState
                title="No invocations recorded"
                hint="The pre-execution gate records every verdict — allowed and denied alike — the moment the kit's capabilities are exercised."
              />
            ) : (
              <ul className="aurum-item-list">
                {runtime.recentInvocations.map((invocation, index) => (
                  <li key={`${invocation.capabilityKey}-${invocation.invokedAt}-${index}`}>
                    <div className="aurum-item-head">
                      <span className="aurum-item-title aurum-mono">{invocation.capabilityKey}</span>
                      <StatusPill tone={invocation.outcome === 'allowed' ? 'positive' : 'error'}>
                        {invocation.outcome}
                      </StatusPill>
                    </div>
                    {invocation.denialReason === null ? null : (
                      <p className="aurum-item-text">{invocation.denialReason}</p>
                    )}
                    <div className="aurum-item-foot">
                      <span>basis {invocation.basis}</span>
                      <span>{invocation.invokedAt.slice(0, 19).replace('T', ' ')}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="aurum-mkt-subhead">Lifecycle trail</h3>
            {(runtime?.events ?? []).length === 0 ? (
              <EmptyState
                title="No events recorded"
                hint="Every install, review, grant minted/revoked and removal lands here."
              />
            ) : (
              <ul className="aurum-mkt-trail">
                {runtime!.events.map((event, index) => (
                  <li key={`${event.event}-${index}`}>
                    <span className="aurum-mono">{event.recordedAt.slice(0, 10)}</span>
                    <span>
                      {event.event}
                      {event.detail === null ? '' : `: ${event.detail}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>

      {/* --- the actions this caller may legally take --- */}
      <Panel
        title="Actions"
        blurb="Exactly what YOUR scope may do with this kit right now — the vertical-kits module's own rules: the administer claim, one live lifecycle per kit, and the lifecycle state machine's own transitions."
      >
        {!scoped ? (
          <EmptyState
            title="Acting needs a company scope"
            hint="Sign in with a company to install or govern this kit — the action then carries your session's verified scope."
            action={
              <Link className="aurum-btn" data-variant="quiet" href="/signin">
                Sign in
              </Link>
            }
          />
        ) : (
          <div className="aurum-mkt-action-grid">
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
                      label: 'Justification (carried on the grant review)',
                      placeholder: 'Why your company needs this vertical kit',
                    },
                  ]}
                  submitLabel="Install this kit version"
                  confirmPrompt="I inspected the required capabilities and accept that install routes the grant review through the authority gate."
                  note="register → verify → install. The shipped manifest becomes an immutable version in your registry; the deterministic checks run over the stored bytes; the install lands pending-review until a human grants the declared capabilities (an auto-allow policy mints them at once)."
                />
              </div>
            ) : null}

            {!actions.canInstall && actions.installBlockedReason !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Install</h3>
                <div className="aurum-notice">{actions.installBlockedReason}</div>
              </div>
            ) : null}

            {actions.canReview && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Grant review decision</h3>
                <ActionForm
                  action={`${actionBase}/review`}
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
                      name: 'reason',
                      label: 'Reason (required to reject)',
                      placeholder: 'Why this decision was reached',
                    },
                  ]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Record the review decision"
                  confirmPrompt="I am deciding the tenant grant review for this kit's declared capabilities."
                  note="pending-review → granted or rejected. Approval mints EXACTLY the declared capabilities as kit grants; rejection mints nothing and is terminal for this install."
                />
              </div>
            ) : null}

            {actions.canActivate && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">{KIT_TRANSITION_COPY.activate.label}</h3>
                <ActionForm
                  action={`${actionBase}/activate`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Activate the kit"
                  note={KIT_TRANSITION_COPY.activate.description}
                />
              </div>
            ) : null}

            {actions.canSuspend && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">{KIT_TRANSITION_COPY.suspend.label}</h3>
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
                  note={KIT_TRANSITION_COPY.suspend.description}
                />
              </div>
            ) : null}

            {actions.canResume && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">{KIT_TRANSITION_COPY.resume.label}</h3>
                <ActionForm
                  action={`${actionBase}/resume`}
                  scopeQuery={scopeQuery}
                  fields={[]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Resume the kit"
                  note={KIT_TRANSITION_COPY.resume.description}
                />
              </div>
            ) : null}

            {actions.canRemove && installation !== null ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">{KIT_TRANSITION_COPY.remove.label}</h3>
                <ActionForm
                  action={`${actionBase}/remove`}
                  scopeQuery={scopeQuery}
                  variant="danger"
                  fields={[
                    {
                      kind: 'text',
                      name: 'reason',
                      label: 'Reason (required)',
                      placeholder: 'Why this kit (and its grants) is being retired',
                      required: true,
                    },
                  ]}
                  hidden={{ installationId: installation.id }}
                  submitLabel="Remove the kit"
                  confirmPrompt="Removal is terminal: every active grant is revoked with the kit, and the append-only audit is retained."
                  note={KIT_TRANSITION_COPY.remove.description}
                />
              </div>
            ) : null}

            {!actions.canGovern ? (
              <div className="aurum-mkt-action">
                <h3 className="aurum-mkt-subhead">Governance</h3>
                <div className="aurum-notice">
                  Governing vertical kits requires the{' '}
                  <span className="aurum-mono">vertical-kits:administer</span>{' '}
                  authority claim. Your session can read the kit&apos;s state; every
                  write stays gated.
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </>
  );
}
