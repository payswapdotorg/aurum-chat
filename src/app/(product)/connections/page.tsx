// Connection & Integration Hub (W059) — the connections center page.
//
// The user-facing connections center for channels, source systems and
// destinations (plan §4 W059 / Journey G): connect / disconnect /
// configure, derived connection health, identity verification & linking,
// source freshness + checkpoint state, destination delivery state — all
// composed live from the module contracts (channels W030, sources W036,
// destinations W037, identity/people W002, freshness W006, conversations
// W029). The page is a server component; the interactive controls (client
// components in components/interaction.tsx) POST to /api/connections and
// refresh this view.
//
// The tenant context comes from the documented dev seam (query parameters)
// until W058 lands authenticated sessions.

import type { ReactNode } from 'react';
import {
  firstValue,
} from './lib/context';
import { requirePageScope } from '@/app/lib/page-session';
import { buildConnectionsView } from './lib/views';
import type { IdentityCard } from './lib/views';
import {
  ActionButton,
  ActionForm,
  ConnectForm,
  PersonCreateForm,
} from './components/interaction';
import {
  DetailGrid,
  EmptyState,
  HealthPill,
  HealthReasons,
  Notice,
  Pill,
  SectionCard,
  StatRow,
  StatusPill,
  When,
} from './components/hub-ui';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // W058: authenticated routing — the session carries the company scope
  // (and the role-derived claims the hub's attest/link actions check).
  const pageScope = await requirePageScope('/connections');
  const params = await searchParams;
  const lookupProvider = firstValue(params['identity_provider']);
  const lookupAccount = firstValue(params['identity_account']);
  const identityLookup =
    lookupProvider !== null && lookupAccount !== null
      ? { provider: lookupProvider, providerAccountId: lookupAccount }
      : null;

  const view = await buildConnectionsView(pageScope.context, { identityLookup });
  const now = view.generatedAt;

  const connectedChannels = view.channels.cards.filter((card) => card.connection !== null);
  const availableChannelProviders = view.catalog.channels.filter(
    (entry) => !connectedChannels.some((card) => card.provider === entry.key),
  );

  return (
    <>
      <nav className="conn-nav" aria-label="Connections sections">
        <a className="chip" href="#channels">
          Channels
        </a>
        <a className="chip" href="#sources">
          Sources
        </a>
        <a className="chip" href="#destinations">
          Destinations
        </a>
        <a className="chip" href="#identities">
          Identity &amp; verification
        </a>
      </nav>

      <StatRow
        items={[
          {
            label: 'Channels connected',
            value: `${view.channels.connected}/${view.channels.catalogSize}`,
            hint: `${view.channels.active} active · ${view.channels.byLevel.degraded} degraded`,
          },
          {
            label: 'Sources connected',
            value: view.sources.connected,
            hint: `${view.sources.active} active · ${view.sources.byLevel.degraded} degraded`,
          },
          {
            label: 'Destinations connected',
            value: view.destinations.connected,
            hint: `${view.destinations.active} active · ${view.destinations.byLevel.degraded} degraded`,
          },
          {
            label: 'Channel identities',
            value: view.identities.cards.length,
            hint: `${view.identities.byStatus.verified} verified · ${
              view.identities.byStatus.unverified + view.identities.byStatus.pending
            } awaiting verification`,
          },
        ]}
      />

      <div className="notices">
        {view.notices.map((notice) => (
          <Notice key={notice}>{notice}</Notice>
        ))}
      </div>

      {/* ------------------------------- Channels ------------------------------ */}

      <SectionCard
        id="channels"
        title="Channels"
        description="The tenant's sending endpoints: one WhatsApp business number, one Telegram bot, one Slack workspace app… Disconnecting disables the endpoint; channel endpoints are otherwise immutable (re-registering an existing endpoint changes nothing)."
        meta={`generated ${now}`}
      >
        {connectedChannels.length === 0 ? (
          <EmptyState
            title="No channels connected"
            hint="Connect a channel endpoint below to let Aurum converse over it."
          />
        ) : (
          <ul className="rows">
            {connectedChannels.map((card) => (
              <li className="row" key={card.provider}>
                <div className="row-head">
                  <span className="row-title">{card.label}</span>
                  <HealthPill health={card.health} />
                  <Pill tone="muted">{card.connection?.providerAccountId}</Pill>
                  {card.connection?.displayName ? (
                    <span className="row-sub">{card.connection.displayName}</span>
                  ) : null}
                </div>
                <HealthReasons health={card.health} />
                <div className="row-foot">
                  <span>
                    last activity <When at={card.lastActivityAt} now={now} />
                  </span>
                  <span>
                    {card.identitiesSeen} identit{card.identitiesSeen === 1 ? 'y' : 'ies'} seen recently
                  </span>
                  <span className="mono">{card.connection?.id}</span>
                </div>
                <details className="disclose">
                  <summary>Details &amp; controls</summary>
                  <div className="disclose-body">
                    <DetailGrid
                      rows={[
                        { key: 'Status', value: <StatusPill status={card.connection?.status ?? 'disabled'} /> },
                        {
                          key: 'Credential reference',
                          value: <span className="mono">{card.connection?.credentialRef}</span>,
                        },
                        {
                          key: 'Delivery transport',
                          value: card.transportWired ? 'wired' : 'not wired (sends fail provider_unavailable)',
                        },
                        {
                          key: 'Connected',
                          value: <When at={card.connection?.createdAt ?? null} now={now} />,
                        },
                      ]}
                    />
                    <div className="action-inline">
                      {card.connection?.status === 'active' ? (
                        <ActionButton
                          action="channel.setStatus"
                          fields={{ connectionId: card.connection.id, status: 'disabled' }}
                          label="Disconnect"
                          tone="danger"
                          confirmText={`Disconnect the ${card.label} endpoint? Inbound turns keep recording; outbound sends stop.`}
                        />
                      ) : (
                        <ActionButton
                          action="channel.setStatus"
                          fields={{ connectionId: card.connection?.id ?? '', status: 'active' }}
                          label="Reconnect"
                          tone="primary"
                        />
                      )}
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}

        {availableChannelProviders.length > 0 ? (
          <ConnectForm
            kind="channel"
            providers={availableChannelProviders}
            title={`Connect a channel (${availableChannelProviders.length} available)`}
          />
        ) : null}
      </SectionCard>

      {/* -------------------------------- Sources ------------------------------ */}

      <SectionCard
        id="sources"
        title="Source systems"
        description="Inbound connectors the tenant ingests evidence from (polling or webhooks). Freshness is the canonical W006 classification; the checkpoint is the opaque cursor the next poll resumes from. Re-registering a source is its re-authorization path."
        meta={`generated ${now}`}
      >
        {view.sources.cards.length === 0 ? (
          <EmptyState
            title="No source systems connected"
            hint="Connect a source to start ingesting authorized evidence as observations."
          />
        ) : (
          <ul className="rows">
            {view.sources.cards.map((card) => (
              <li className="row" key={card.id}>
                <div className="row-head">
                  <span className="row-title">{card.label}</span>
                  <HealthPill health={card.health} />
                  <StatusPill status={card.status} />
                  <Pill tone={card.freshness.status === 'current' ? 'ok' : card.freshness.status === 'unknown' ? 'muted' : 'warn'}>
                    freshness: {card.freshness.status}
                  </Pill>
                  <Pill tone="muted">{card.providerAccountId}</Pill>
                </div>
                <HealthReasons health={card.health} />
                <div className="row-foot">
                  <span>
                    {card.checkpoint === null
                      ? 'no checkpoint yet'
                      : card.checkpoint.cursor === null
                        ? 'checkpoint at start'
                        : 'checkpoint set'}
                  </span>
                  {card.checkpoint !== null ? (
                    <span>
                      checkpoint <When at={card.checkpoint.updatedAt} now={now} />
                    </span>
                  ) : null}
                  <span>
                    newest evidence{' '}
                    {card.freshness.latestObservedAt === null
                      ? 'none'
                      : `${card.freshness.ageSeconds ?? '—'}s old`}
                  </span>
                  <span>{card.modes.join(' + ')}</span>
                  <span className="mono">{card.id}</span>
                </div>
                <details className="disclose">
                  <summary>Checkpoint, freshness &amp; controls</summary>
                  <div className="disclose-body">
                    <DetailGrid
                      rows={[
                        {
                          key: 'Authorization',
                          value: `${card.authKind}${card.oauthExpiresAt === null ? '' : ` · expires ${card.oauthExpiresAt}`}`,
                        },
                        {
                          key: 'Credential reference',
                          value: <span className="mono">{card.credentialRef}</span>,
                        },
                        {
                          key: 'Current checkpoint',
                          value:
                            card.checkpoint === null
                              ? 'none (never polled, or rewound to start)'
                              : card.checkpoint.cursor === null
                                ? 'start of history (cursor null)'
                                : <span className="mono">{card.checkpoint.cursor}</span>,
                        },
                        {
                          key: 'Freshness (W006)',
                          value: `${card.freshness.status} · ${card.freshness.observationsConsidered} observations considered${
                            card.freshness.maxLatencySeconds === null
                              ? ''
                              : ` · max latency ${card.freshness.maxLatencySeconds}s`
                          }`,
                        },
                        ...(card.recentCheckpoints.length === 0
                          ? []
                          : [
                              {
                                key: 'Checkpoint history',
                                value: card.recentCheckpoints
                                  .map(
                                    (entry) =>
                                      `${entry.origin} @ ${entry.recordedAt}${
                                        entry.cursor === null ? ' (start)' : ''
                                      }`,
                                  )
                                  .join(' · '),
                              },
                            ]),
                      ]}
                    />
                    <div className="action-inline">
                      <ActionButton
                        action="source.poll"
                        fields={{ sourceId: card.id }}
                        label="Poll now"
                        tone="primary"
                      />
                      <ActionButton
                        action="source.replay"
                        fields={{ sourceId: card.id }}
                        label="Replay from start"
                        confirmText="Rewind the checkpoint to the beginning? The next poll re-fetches from the start; dedupe suppresses already-observed records."
                      />
                      {card.status === 'active' ? (
                        <ActionButton
                          action="source.setStatus"
                          fields={{ sourceId: card.id, status: 'disabled' }}
                          label="Disconnect"
                          tone="danger"
                        />
                      ) : (
                        <ActionButton
                          action="source.setStatus"
                          fields={{ sourceId: card.id, status: 'active' }}
                          label="Reconnect"
                        />
                      )}
                    </div>
                    <details className="disclose">
                      <summary>Re-authorize (configure)</summary>
                      <div className="disclose-body">
                        <ActionForm
                          action="source.register"
                          fixedFields={{
                            provider: card.provider,
                            providerAccountId: card.providerAccountId,
                            id: card.id,
                          }}
                          fields={[
                            {
                              name: 'credentialRef',
                              label: 'New credential reference',
                              required: true,
                              hint: 'Opaque secret-store reference — never a credential value.',
                            },
                            { name: 'displayName', label: 'Display name (optional)' },
                          ]}
                          submitLabel="Re-authorize source"
                        />
                      </div>
                    </details>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}

        <ConnectForm
          kind="source"
          providers={view.catalog.sources}
          title="Connect a source system"
        />
      </SectionCard>

      {/* ------------------------------ Destinations ---------------------------- */}

      <SectionCard
        id="destinations"
        title="Destinations"
        description="Outbound connectors Aurum publishes authorized findings to. Delivery state is the append-only outbound ledger: pending deliveries wait for the data-export authority gate (or a wired transport); failed deliveries retry; replay re-delivers as a new gated delivery. Re-registering a destination is its re-authorization path."
        meta={`generated ${now}`}
      >
        {view.destinations.cards.length === 0 ? (
          <EmptyState
            title="No destinations connected"
            hint="Connect a destination to export authorized Aurum findings to your systems."
          />
        ) : (
          <ul className="rows">
            {view.destinations.cards.map((card) => (
              <li className="row" key={card.id}>
                <div className="row-head">
                  <span className="row-title">{card.label}</span>
                  <HealthPill health={card.health} />
                  <StatusPill status={card.status} />
                  <Pill tone="muted">{card.category}</Pill>
                  <Pill tone="muted">{card.providerAccountId}</Pill>
                </div>
                <HealthReasons health={card.health} />
                <div className="row-foot">
                  <span>
                    {card.deliveries.total} deliver{card.deliveries.total === 1 ? 'y' : 'ies'} ·{' '}
                    {card.deliveries.delivered} delivered · {card.deliveries.pending} pending ·{' '}
                    {card.deliveries.failed} failed · {card.deliveries.rejected} rejected
                  </span>
                  {card.deliveries.latest !== null ? (
                    <span>
                      latest {card.deliveries.latest.kind} — {card.deliveries.latest.status} (
                      <When at={card.deliveries.latest.updatedAt} now={now} />)
                    </span>
                  ) : null}
                  <span className="mono">{card.id}</span>
                </div>
                <details className="disclose">
                  <summary>Delivery state &amp; controls</summary>
                  <div className="disclose-body">
                    <DetailGrid
                      rows={[
                        {
                          key: 'Authorization',
                          value: `${card.authKind}${card.oauthExpiresAt === null ? '' : ` · expires ${card.oauthExpiresAt}`}`,
                        },
                        {
                          key: 'Credential reference',
                          value: <span className="mono">{card.credentialRef}</span>,
                        },
                        {
                          key: 'Latest delivery',
                          value:
                            card.deliveries.latest === null
                              ? 'none dispatched yet'
                              : `${card.deliveries.latest.kind} — ${card.deliveries.latest.status} (updated ${card.deliveries.latest.updatedAt})`,
                        },
                        {
                          key: 'Latest delivery id',
                          value:
                            card.deliveries.latest === null ? (
                              '—'
                            ) : (
                              <span className="mono">{card.deliveries.latest.id}</span>
                            ),
                        },
                      ]}
                    />
                    {card.deliveries.latest !== null &&
                    (card.deliveries.latest.status === 'pending' ||
                      card.deliveries.latest.status === 'failed') ? (
                      <div className="action-inline">
                        <ActionButton
                          action="destination.retry"
                          fields={{ deliveryId: card.deliveries.latest.id }}
                          label="Retry latest delivery"
                          tone="primary"
                        />
                      </div>
                    ) : null}
                    {card.deliveries.latest !== null && card.deliveries.latest.status === 'delivered' ? (
                      <div className="action-inline">
                        <ActionButton
                          action="destination.replay"
                          fields={{ deliveryId: card.deliveries.latest.id }}
                          label="Re-deliver (replay)"
                          confirmText="Re-deliver this payload as a NEW delivery under a fresh full gate authorization?"
                        />
                      </div>
                    ) : null}
                    <div className="action-inline">
                      {card.status === 'active' ? (
                        <ActionButton
                          action="destination.setStatus"
                          fields={{ destinationId: card.id, status: 'disabled' }}
                          label="Disconnect"
                          tone="danger"
                        />
                      ) : (
                        <ActionButton
                          action="destination.setStatus"
                          fields={{ destinationId: card.id, status: 'active' }}
                          label="Reconnect"
                        />
                      )}
                    </div>
                    <details className="disclose">
                      <summary>Re-authorize (configure)</summary>
                      <div className="disclose-body">
                        <ActionForm
                          action="destination.register"
                          fixedFields={{
                            provider: card.provider,
                            providerAccountId: card.providerAccountId,
                            id: card.id,
                          }}
                          fields={[
                            {
                              name: 'credentialRef',
                              label: 'New credential reference',
                              required: true,
                              hint: 'Opaque secret-store reference — never a credential value.',
                            },
                            { name: 'displayName', label: 'Display name (optional)' },
                          ]}
                          submitLabel="Re-authorize destination"
                        />
                      </div>
                    </details>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}

        <ConnectForm
          kind="destination"
          providers={view.catalog.destinations.flatMap((group) => group.entries)}
          title="Connect a destination"
        />
      </SectionCard>

      {/* --------------------------- Identity & verification -------------------- */}

      <SectionCard
        id="identities"
        title="Identity &amp; verification"
        description="Channel accounts seen by Aurum, with their explicit verification state. Verification proves the account holder controls the account (challenge over their own channel, or an admin attestation); linking attaches a verified identity to a person — unverified accounts stay external and never become pseudo-employees (lock 15)."
        meta={`discovery window: newest ${view.identities.discoveryWindow} turns per channel`}
      >
        <form className="form-stack" method="get" action="/connections#identities">
          <div className="field">
            <label htmlFor="identity-lookup-provider">Look up an identity by provider account</label>
            <div className="action-inline">
              <select
                id="identity-lookup-provider"
                name="identity_provider"
                defaultValue={lookupProvider ?? ''}
              >
                {view.catalog.channels.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                name="identity_account"
                placeholder="provider account id"
                defaultValue={lookupAccount ?? ''}
              />
              <button type="submit" className="btn btn-quiet">
                Look up
              </button>
            </div>
            <span className="hint">
              The identity contract exposes no tenant-wide listing — identities surface from recent
              channel activity; use this lookup for accounts outside that window.
            </span>
          </div>
        </form>

        {view.identities.lookupMiss !== null ? <Notice neutral>{view.identities.lookupMiss}</Notice> : null}

        {view.identities.lookup !== null ? (
          <ul className="rows">
            <IdentityRow card={view.identities.lookup} now={now} />
          </ul>
        ) : null}

        {view.identities.cards.length === 0 ? (
          <EmptyState
            title="No channel identities yet"
            hint="Identities register on sight when someone messages a connected channel."
          />
        ) : (
          <ul className="rows">
            {view.identities.cards.map((card) => (
              <IdentityRow key={card.id} card={card} now={now} />
            ))}
          </ul>
        )}

        <details className="disclose">
          <summary>Create a person record (for linking)</summary>
          <div className="disclose-body">
            <PersonCreateForm />
          </div>
        </details>
      </SectionCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// One identity row + its verification/linking controls
// ---------------------------------------------------------------------------

function IdentityRow({ card, now }: { card: IdentityCard; now: string }): ReactNode {
  return (
    <li className="row" id={`identity-${card.id}`}>
      <div className="row-head">
        <span className="row-title">{card.displayName ?? card.providerAccountId}</span>
        <StatusPill status={card.status} />
        <Pill tone="muted">{card.label}</Pill>
        <Pill tone="muted">{card.providerAccountId}</Pill>
      </div>
      <div className="row-foot">
        {card.subject !== null ? (
          <span>
            linked to {card.subject.fullName}
            {card.subject.resolvable ? '' : ' (person record unavailable — opaque id)'}
          </span>
        ) : (
          <span>not linked to a person</span>
        )}
        {card.verificationMethod !== null ? (
          <span>via {card.verificationMethod.replaceAll('_', ' ')}</span>
        ) : null}
        {card.verifiedAt !== null ? <span>verified {card.verifiedAt}</span> : null}
        {card.revokedReason !== null ? <span>revoked: {card.revokedReason}</span> : null}
        {card.discovered ? (
          <span>
            last seen <When at={card.lastSeenAt} now={now} />
          </span>
        ) : (
          <span>found by lookup</span>
        )}
        <span className="mono">{card.id}</span>
      </div>

      <details className="disclose">
        <summary>Verification &amp; linking</summary>
        <div className="disclose-body">
          {card.status === 'unverified' || card.status === 'pending' ? (
            <div className="action-inline" style={{ marginBottom: 10 }}>
              <ActionButton
                action="identity.challenge"
                fields={{ identityId: card.id }}
                label="Send verification code"
                tone="primary"
              />
              <span className="hint" style={{ fontSize: 12 }}>
                Delivered over the identity&apos;s own channel (needs an active connection + wired
                transport). The code never appears in transcripts or here.
              </span>
            </div>
          ) : null}

          {card.status === 'pending' ? (
            <ActionForm
              action="identity.complete"
              fixedFields={{ identityId: card.id }}
              fields={[
                {
                  name: 'code',
                  label: 'Reply code',
                  required: true,
                  hint: 'The code the account holder replied with over their channel.',
                },
              ]}
              submitLabel="Complete verification"
            />
          ) : null}

          {card.status !== 'verified' ? (
            <ActionForm
              action="identity.attest"
              fixedFields={{ identityId: card.id }}
              fields={[
                {
                  name: 'evidence',
                  label: 'Attestation evidence',
                  required: true,
                  hint: 'Why you attest this account belongs to this person (requires the identity:attest claim).',
                },
              ]}
              submitLabel="Attest (admin verification)"
            />
          ) : null}

          {card.status === 'verified' && card.subject === null ? (
            <ActionForm
              action="identity.link"
              fixedFields={{ identityId: card.id }}
              fields={[
                {
                  name: 'personId',
                  label: 'Person id (uuid)',
                  required: true,
                  hint: 'people.persons.id — create a person record below if none exists yet (requires the identity:link claim).',
                },
              ]}
              submitLabel="Link to person"
            />
          ) : null}

          {card.subject !== null ? (
            <div className="action-inline" style={{ marginBottom: 10 }}>
              <ActionButton
                action="identity.detach"
                fields={{ identityId: card.id }}
                label="Detach from person"
                confirmText="Detach this identity from its person? Person attribution stops until it is linked again."
              />
            </div>
          ) : null}

          {card.status === 'verified' ? (
            <ActionForm
              action="identity.revoke"
              fixedFields={{ identityId: card.id }}
              fields={[
                {
                  name: 'reason',
                  label: 'Revocation reason',
                  required: true,
                  hint: 'Revocation also detaches — the identity resolves to nothing until re-attested (requires the identity:attest claim).',
                },
              ]}
              submitLabel="Revoke verification"
            />
          ) : null}
        </div>
      </details>
    </li>
  );
}
