// Developer / API / MCP Console (W067) — the developer surface (/developer).
//
// THE WORK ITEM: "Build API key/scopes, webhook, MCP connection and
// developer activity surfaces." One console composes Journey L end to end
// from the api module's CONTRACT and the W039 MCP surface's own registry
// (locks 31/32 — this page is a view, never a second source of truth):
//
//   * API KEYS — create (scopes + authority-claim grant, one-time raw-key
//     reveal), rotate (fresh key with the same grant + immediate revoke),
//     revoke (the record and its audit history stay);
//   * SCOPE VISIBILITY — the v1 route table grouped by capability scope:
//     every operation and the scope a key needs to call it, plus the
//     authority-claim vocabulary a key may carry downstream;
//   * WEBHOOKS — setup (https endpoint + event-type patterns + opaque
//     signing-secret reference), test pings, explicit redelivery, the
//     append-only delivery/attempt evidence, and the dispatch pump (which
//     reports the honest unwired state when no transport is wired);
//   * MCP CONNECTION — the stdio launch recipe (env names verbatim from
//     the W039 config module) and the live tool catalog with each tool's
//     policy posture;
//   * DEVELOPER ACTIVITY — the auditable integration events: every
//     api.operation and mcp.tool_invoked event, newest first, with the
//     deep-linkable delivery detail (?delivery=<uuid>).
//
// Mobile-first, 44px+ targets, real heading hierarchy, the shell's quiet
// states everywhere (EmptyState/ErrorState/StatusPill), progressive
// disclosure for configuration, and honest degradation notes per read
// family. Scope comes from the authenticated session (W058) — there is no
// tenant parameter anywhere in this surface.

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { getWebhookDelivery } from '@/modules/api/contract';
import type { WebhookDeliveryDetail } from '@/modules/api/contract';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../components/states';
import { buildDeveloperView } from './lib/views';
import type {
  ActivityRow,
  DeveloperView,
  McpToolRow,
  OperationRow,
  ScopeFamilyRow,
} from './lib/views';
import {
  ACTIVITY_NOTE,
  KEY_MANAGEMENT_CLAIM_NOTE,
  MCP_STDIO_NOTE,
  NO_RAW_PERSISTENCE_NOTE,
  REVOKE_NOTE,
  ROTATION_NOTE,
  SECRET_REF_NOTE,
  WEBHOOK_ENVELOPE_NOTE,
  activityFamilyLabel,
  ageLabel,
  attemptOutcomeLabel,
  attemptOutcomeTone,
  deliveryStatusLabel,
  deliveryStatusTone,
  keyStatusLabel,
  keyStatusTone,
  mcpPolicyLabel,
  mcpPolicyTone,
  scopeExplanation,
  scopeLabel,
  shortId,
  subscriptionStatusLabel,
  subscriptionStatusTone,
} from './lib/labels';
import {
  CreateKeyForm,
  CreateWebhookForm,
  DispatchPumpControl,
  KeyControls,
  RedeliverButton,
  WebhookControls,
} from './components/controls';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Developer — API, keys, webhooks & MCP — Aurum',
  description:
    'The developer console: API keys and scopes, webhooks with delivery evidence, MCP connection instructions, and the auditable integration event feed.',
};

/** First non-empty value of a possibly-array query parameter. */
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function KeyRow({
  view,
  apiKey,
}: {
  view: DeveloperView;
  apiKey: DeveloperView['keys'][number];
}): ReactNode {
  return (
    <li className="aurum-dev-key">
      <div className="aurum-ai-account-head">
        <span className="aurum-ai-account-title">{apiKey.label}</span>
        <StatusPill tone={keyStatusTone(apiKey.status)}>{keyStatusLabel(apiKey.status)}</StatusPill>
        <span className="aurum-ai-routing-position">key {shortId(apiKey.id)}</span>
      </div>
      <p className="aurum-ai-account-meta">
        {apiKey.scopes.map((scope) => scopeLabel(scope)).join(' · ')}
        {apiKey.scopes.length === 0 ? 'no scopes' : ''}
      </p>
      <p className="aurum-ai-account-meta aurum-ai-account-meta-sub">
        authority {apiKey.authority.length === 0 ? '— (none)' : apiKey.authority.join(' · ')} · acts as
        principal <code className="aurum-mono">{shortId(apiKey.principalId)}</code> · created{' '}
        {ageLabel(apiKey.createdAt, view.generatedAt)}
        {apiKey.lastUsedAt === null
          ? ' · never used'
          : ` · last used ${ageLabel(apiKey.lastUsedAt, view.generatedAt)}`}
        {apiKey.status === 'revoked' && apiKey.revokedAt !== null
          ? ` · revoked ${ageLabel(apiKey.revokedAt, view.generatedAt)}`
          : ''}
      </p>
      <KeyControls keyId={apiKey.id} label={apiKey.label} active={apiKey.status === 'active'} />
    </li>
  );
}

function OperationRows({ operations }: { operations: OperationRow[] }): ReactNode {
  return (
    <ul className="aurum-dev-operations">
      {operations.map((operation) => (
        <li className="aurum-dev-operation" key={`${operation.method}-${operation.path}`}>
          <code className="aurum-mono aurum-dev-operation-method" data-method={operation.method}>
            {operation.method}
          </code>
          <code className="aurum-mono">{operation.path}</code>
          <span className="aurum-dev-operation-name">{operation.operation}</span>
        </li>
      ))}
    </ul>
  );
}

function ScopeFamilyRows({ families }: { families: ScopeFamilyRow[] }): ReactNode {
  return (
    <div className="aurum-dev-scopes">
      {families.map((family) => (
        <details className="aurum-learn-disclose" key={family.scope} open={families.length <= 4}>
          <summary>
            <code className="aurum-mono">{family.scope}</code>
            {family.scope === '(unauthenticated)' ? ' — open surface' : ` — ${scopeLabel(family.scope)}`}
            <span className="aurum-dev-scope-count">
              {family.operations.length} operation{family.operations.length === 1 ? '' : 's'}
            </span>
          </summary>
          <p className="aurum-panel-blurb">
            {family.scope === '(unauthenticated)' ? (
              <>The tenant-free discovery manifest — no key required.</>
            ) : (
              scopeExplanation(family.scope)
            )}
          </p>
          <OperationRows operations={family.operations} />
        </details>
      ))}
    </div>
  );
}

function SubscriptionRow({
  view,
  subscription,
}: {
  view: DeveloperView;
  subscription: DeveloperView['subscriptions'][number];
}): ReactNode {
  return (
    <li className="aurum-dev-webhook">
      <div className="aurum-ai-account-head">
        <span className="aurum-ai-account-title">{subscription.label}</span>
        <StatusPill tone={subscriptionStatusTone(subscription.status)}>
          {subscriptionStatusLabel(subscription.status)}
        </StatusPill>
        <span className="aurum-ai-routing-position">subscription {shortId(subscription.id)}</span>
      </div>
      <p className="aurum-ai-account-meta">
        <code className="aurum-mono">{subscription.url}</code>
      </p>
      <p className="aurum-ai-account-meta aurum-ai-account-meta-sub">
        {subscription.eventTypes.join(' · ')} · secret{' '}
        {subscription.secretRef === null ? (
          'not set (unsigned)'
        ) : (
          <code className="aurum-mono">{subscription.secretRef}</code>
        )}{' '}
        · up to {subscription.maxAttempts} attempts · added{' '}
        {ageLabel(subscription.createdAt, view.generatedAt)}
      </p>
      <WebhookControls
        subscriptionId={subscription.id}
        label={subscription.label}
        active={subscription.status === 'active'}
      />
    </li>
  );
}

function DeliveryRow({
  view,
  delivery,
}: {
  view: DeveloperView;
  delivery: DeveloperView['deliveries'][number];
}): ReactNode {
  return (
    <li className="aurum-dev-delivery">
      <div className="aurum-ai-account-head">
        <StatusPill tone={deliveryStatusTone(delivery.status)}>
          {deliveryStatusLabel(delivery.status)}
        </StatusPill>
        <span className="aurum-ai-execution-title">
          <code className="aurum-mono">{delivery.eventType}</code>
        </span>
        <span className="aurum-ai-execution-kind">
          {delivery.kind === 'test' ? 'test ping' : 'event delivery'} · delivery{' '}
          <code className="aurum-mono">{shortId(delivery.id)}</code>
        </span>
      </div>
      <p className="aurum-ai-execution-meta">
        attempt {delivery.attempts}/{delivery.maxAttempts}
        {delivery.lastStatusCode === null ? '' : ` · last status ${delivery.lastStatusCode}`}
        {delivery.lastError === null ? '' : ` · ${delivery.lastError}`}
        {delivery.redeliveryOf === null ? '' : ` · redelivery of ${shortId(delivery.redeliveryOf)}`}
        {delivery.status === 'pending'
          ? ` · next attempt ${ageLabel(delivery.nextAttemptAt, view.generatedAt)}`
          : ''}
        {delivery.deliveredAt === null ? '' : ` · delivered ${ageLabel(delivery.deliveredAt, view.generatedAt)}`}
        {' · '}
        <Link className="aurum-mkt-link" href={`/developer?delivery=${delivery.id}`}>
          evidence
        </Link>
      </p>
      {delivery.status === 'pending' ? <RedeliverButton deliveryId={delivery.id} /> : null}
    </li>
  );
}

function ActivityEventRow({ view, row }: { view: DeveloperView; row: ActivityRow }): ReactNode {
  return (
    <li className="aurum-dev-activity">
      <div className="aurum-ai-account-head">
        <span className="aurum-pill aurum-pill-neutral">{activityFamilyLabel(row.type)}</span>
        <span className="aurum-ai-execution-title">
          <code className="aurum-mono">{row.operation}</code>
        </span>
        <span className="aurum-ai-execution-kind">{ageLabel(row.occurredAt, view.generatedAt)}</span>
      </div>
      <p className="aurum-ai-execution-meta">
        {row.detail}
        {row.keyId === null ? '' : ` · key ${shortId(row.keyId)}`} · correlation{' '}
        <code className="aurum-mono">{shortId(row.correlationId)}</code>
      </p>
    </li>
  );
}

function McpToolRows({ tools }: { tools: McpToolRow[] }): ReactNode {
  return (
    <ul className="aurum-dev-mcp-tools">
      {tools.map((tool) => (
        <li className="aurum-dev-mcp-tool" key={tool.name}>
          <div className="aurum-ai-model-head">
            <code className="aurum-mono">{tool.name}</code>
            <StatusPill tone={mcpPolicyTone(tool.policyKind)}>
              {mcpPolicyLabel(tool.policyKind)}
            </StatusPill>
          </div>
          <p className="aurum-ai-model-meta">
            {tool.title} — {tool.description}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default async function DeveloperConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireAuthenticatedPage();
  const view = await buildDeveloperView(session.context);
  const nowIso = view.generatedAt;

  // The optional deep link to one delivery's attempt trail (?delivery=).
  const deliveryId = firstValue(params['delivery']);
  let delivery: WebhookDeliveryDetail | null = null;
  let deliveryError: string | null = null;
  if (deliveryId !== null) {
    try {
      delivery = await getWebhookDelivery(session.context, { deliveryId });
    } catch {
      // Uniform not-found: a missing OR foreign-tenant id is the same state.
      deliveryError = deliveryId;
    }
  }

  const activeKeys = view.keys.filter((key) => key.status === 'active');

  return (
    <>
      <PageHead
        title="Developer"
        description="API keys and scopes, webhooks with delivery evidence, MCP connection instructions, and every auditable integration event — one console for everything that integrates with your company's intelligence employee."
        meta={
          <>
            Generated {nowIso} · {activeKeys.length} active key
            {activeKeys.length === 1 ? '' : 's'} · {view.subscriptions.length} webhook
            {view.subscriptions.length === 1 ? '' : 's'} · {view.mcpTools.length} MCP tools
          </>
        }
      />

      {view.canAdministerKeys ? null : (
        <div className="aurum-notice" role="note">
          <strong>View-only keys.</strong> {KEY_MANAGEMENT_CLAIM_NOTE}
        </div>
      )}

      {view.transportWired ? null : (
        <div className="aurum-notice" role="note">
          <strong>No webhook transport is wired in this environment.</strong> Test pings and
          deliveries queue as pending and the dispatch pump says so honestly — subscriptions,
          evidence and redelivery remain fully manageable. The transport is infrastructure wiring
          (setApiWebhookTransport at process start), never domain state.
        </div>
      )}

      {/* ------------------------------ API keys ------------------------------ */}

      <Panel
        title="API keys"
        blurb="The machine credentials of the public API: tenant-scoped, principal-bound, capability-scoped and revocable. Only a sha-256 hash is ever persisted; the raw key is returned exactly once, at issuance."
        meta={<>{view.keys.length} key{view.keys.length === 1 ? '' : 's'}</>}
      >
        {view.keys.length === 0 ? (
          <EmptyState
            title={view.canAdministerKeys ? 'No API keys yet' : 'No API keys visible to you'}
            hint={
              view.canAdministerKeys
                ? 'Create the first one below: a label, the capability scopes it may use, and any authority claims it must carry downstream.'
                : KEY_MANAGEMENT_CLAIM_NOTE
            }
          />
        ) : (
          <ul className="aurum-dev-keys">
            {view.keys.map((item) => (
              <KeyRow view={view} apiKey={item} key={item.id} />
            ))}
          </ul>
        )}
        {view.canAdministerKeys ? <CreateKeyForm /> : null}
        <ul className="aurum-ai-notes">
          <li>{NO_RAW_PERSISTENCE_NOTE}</li>
          <li>{REVOKE_NOTE}</li>
          <li>{ROTATION_NOTE}</li>
        </ul>
      </Panel>

      {/* --------------------------- Scope visibility ------------------------ */}

      <Panel
        title="Scopes & operations"
        blurb="What each capability scope unlocks on the v1 public API — every operation a key can call, and the one scope it needs to call it. The same table the unauthenticated discovery document serves at GET /api/v1."
        meta={<>{view.scopeFamilies.length} families</>}
      >
        <ScopeFamilyRows families={view.scopeFamilies} />
        <ul className="aurum-ai-notes">
          <li>
            Scopes gate the HTTP boundary ON TOP of membership checks and the domain modules' own
            authority gates — a key never bypasses a domain gate, it only ever carries the claims
            you granted it.
          </li>
          <li>
            Authority claims a key may carry downstream: api:administer, actions:approve,
            actions:administer, agents:administer — platform claims are deliberately never
            grantable to a key.
          </li>
          <li>
            Authenticate with <code className="aurum-mono">Authorization: Bearer aurum_…</code> —
            malformed, unknown and revoked keys are indistinguishable (uniform 401, no leak).
          </li>
        </ul>
      </Panel>

      {/* ------------------------------- Webhooks ----------------------------- */}

      <Panel
        title="Webhooks"
        blurb="The outbound event surface: subscribe https endpoints to event-type patterns and Aurum enqueues a signed delivery for every matching event — with append-only attempt evidence and explicit redelivery."
        meta={<>{view.subscriptions.length} subscription{view.subscriptions.length === 1 ? '' : 's'}</>}
      >
        {view.subscriptions.length === 0 ? (
          <EmptyState
            title="No webhook endpoints yet"
            hint="Add the first one below — an https endpoint, the event types you want, and an optional signing-secret reference."
          />
        ) : (
          <ul className="aurum-dev-webhooks">
            {view.subscriptions.map((subscription) => (
              <SubscriptionRow view={view} subscription={subscription} key={subscription.id} />
            ))}
          </ul>
        )}
        <CreateWebhookForm />
        <ul className="aurum-ai-notes">
          <li>{SECRET_REF_NOTE}</li>
          <li>{WEBHOOK_ENVELOPE_NOTE}</li>
        </ul>
      </Panel>

      <Panel
        title="Webhook deliveries"
        blurb="The delivery queue and its evidence: every enqueued delivery, its attempt budget, its last outcome — and the append-only attempt trail behind each one."
        meta={<>{view.deliveries.length} recent</>}
      >
        <DispatchPumpControl />
        {view.deliveries.length === 0 ? (
          <EmptyState
            title="No deliveries yet"
            hint="Send a test ping to a subscription, or wait for the next matching event — every delivery lands here with its full attempt history."
          />
        ) : (
          <ul className="aurum-dev-deliveries">
            {view.deliveries.map((delivery) => (
              <DeliveryRow view={view} delivery={delivery} key={delivery.id} />
            ))}
          </ul>
        )}
        {deliveryError === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 12 }}>
            <strong>No delivery at this address</strong>
            <span>
              The id <code className="aurum-mono">{deliveryError.slice(0, 8)}</code> matches no
              webhook delivery in this company — missing and foreign ids are indistinguishable by
              design.
            </span>
          </div>
        )}
        {delivery === null ? null : (
          <div style={{ marginTop: 12 }}>
            <h3 className="aurum-ai-subhead">
              Delivery evidence — <code className="aurum-mono">{shortId(delivery.delivery.id)}</code>
            </h3>
            <div className="aurum-dev-attempts">
              {delivery.attempts.length === 0 ? (
                <p className="aurum-panel-blurb">
                  No attempts yet — the delivery is queued and waiting for the pump.
                </p>
              ) : (
                <ol className="aurum-dev-attempt-list">
                  {delivery.attempts.map((attempt) => (
                    <li className="aurum-dev-attempt" key={attempt.id}>
                      <span className="aurum-dev-attempt-no">#{attempt.attemptNo}</span>
                      <StatusPill tone={attemptOutcomeTone(attempt.outcome)}>
                        {attemptOutcomeLabel(attempt.outcome)}
                      </StatusPill>
                      <span className="aurum-dev-attempt-meta">
                        {attempt.statusCode === null ? 'no response' : `HTTP ${attempt.statusCode}`}
                        {attempt.latencyMs === null ? '' : ` · ${attempt.latencyMs} ms`}
                        {attempt.error === null ? '' : ` · ${attempt.error}`}
                        {` · ${ageLabel(attempt.startedAt, nowIso)}`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="aurum-ai-execution-meta">
                The frozen envelope this delivery POSTs on every attempt (byte-stable, so
                signatures stay verifiable across retries):
              </p>
              <pre className="aurum-dev-envelope">
                <code>{delivery.delivery.body}</code>
              </pre>
            </div>
          </div>
        )}
      </Panel>

      {/* --------------------------- MCP connection --------------------------- */}

      <Panel
        title="MCP connection"
        blurb="Aurum's capabilities, exposed as Model Context Protocol tools: query goals, unknowns, beliefs, evidence, missions, agents and approval workflows — propose investigations and consequential actions through the same approval gates."
      >
        <p className="aurum-ai-test-note">{MCP_STDIO_NOTE}</p>
        <div className="aurum-dev-mcp-guide">
          <div className="aurum-dev-mcp-step">
            <h3 className="aurum-ai-subhead">1 · Launch the server</h3>
            <pre className="aurum-dev-envelope">
              <code>{`${view.mcp.launchCommand}`}</code>
            </pre>
            <p className="aurum-ai-execution-meta">
              The server speaks <strong>{view.mcp.transport}</strong> (JSON-RPC over stdio). Point
              any MCP client — Claude Desktop, an IDE, your own — at the process.
            </p>
          </div>
          <div className="aurum-dev-mcp-step">
            <h3 className="aurum-ai-subhead">2 · Bind it to a tenant principal</h3>
            <pre className="aurum-dev-envelope">
              <code>{`${view.mcp.envNames.tenantId}=<tenant uuid>\n${view.mcp.envNames.principalId}=<principal uuid>\n${view.mcp.envNames.authority}=actions:approve   # optional claims`}</code>
            </pre>
            <p className="aurum-ai-execution-meta">
              Startup is fail-closed: the configured principal must be a member of the configured
              tenant before the transport serves. Every tool call carries this explicit context —
              tenant-scoped, permission-checked and audited (locks 32).
            </p>
          </div>
        </div>
        <h3 className="aurum-ai-subhead">The tool catalog ({view.mcpTools.length} tools)</h3>
        <McpToolRows tools={view.mcpTools} />
      </Panel>

      {/* -------------------------- Developer activity ------------------------ */}

      <Panel
        title="Integration activity"
        blurb="The auditable trail of everything that used the public surfaces: API operations (success and failure alike) and MCP tool invocations, with what was asked and how it ended."
        meta={<>{view.activity.length} event{view.activity.length === 1 ? '' : 's'}</>}
      >
        {view.activity.length === 0 ? (
          <EmptyState
            title="No integration activity yet"
            hint="Call the public API with a key, or invoke an MCP tool — every operation appends its immutable audit event here."
          />
        ) : (
          <ul className="aurum-dev-activity-feed">
            {view.activity.map((row) => (
              <ActivityEventRow view={view} row={row} key={row.id} />
            ))}
          </ul>
        )}
        <ul className="aurum-ai-notes">
          <li>{ACTIVITY_NOTE}</li>
        </ul>
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/developer"
        />
      )}
    </>
  );
}
