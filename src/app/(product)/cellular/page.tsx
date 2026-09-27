// Cellular reachability surface (W104 — J18) — the /cellular hub.
//
// THE JOURNEY: "the cellular surface — the SMS/voice contract's
// user-visible path; environment limits recorded as the module reports
// them" (W101 J18). One manager-facing read-only surface composes the
// cellular contract's state families (W087): the telecom sending
// connections, the reach request feed (durable intents with their
// delivery state), and the routing/cost policy rows. The v1 public API
// mirrors the same contract reads (scope families cellular:read /
// cellular:write).
//
// Read-only by design: connection registration and reach requests are
// managed through the connection hub's flows and the conversation —
// this page never sends anything (lock 31/32 — every fact is read
// straight from the contract). THE HONESTY LAW: no transport is wired
// by default, so deliveries surface the module's explicit retryable
// provider_unavailable state — never a faked delivery.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill, Tag } from '../components/states';
import { buildCellularHomeView } from './lib/views';
import {
  CELLULAR_TRANSPORT_NOTE,
  REACH_FEED_NOTE,
  dateTimeLabel,
  failureCodeLabel,
  minorUnitsLabel,
  providerLabel,
  reachStatusLabel,
  reachStatusTone,
  voiceFallbackLabel,
} from './lib/labels';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cellular reachability — Aurum',
  description:
    'Reach people by SMS and voice when they cannot get online: the sending connections, the reach requests and their delivery state, and the routing and cost policies — honestly reported.',
};

export default async function CellularPage() {
  const session = await requireAuthenticatedPage();
  const view = await buildCellularHomeView(session.context);

  return (
    <>
      <PageHead
        title="Cellular reachability"
        description="The SMS/voice fallback for people who cannot get online: who Aurum reached, what was sent, and exactly how delivery went — no faked sends, ever."
        meta={
          <>
            <Link href="/connections">Connect a telecom account</Link>
            {' · '}
            <Link href="/chat">Back to the conversation</Link>
          </>
        }
      />

      <Panel
        title="Reach requests"
        blurb="The durable intents: the message, the authority gate that governs it, and the live delivery state. Open one for its full attempt audit and any replies."
        meta={<>{view.reach.length} request(s)</>}
      >
        {view.reach.length === 0 ? (
          <EmptyState
            title="No reach requests recorded"
            hint="A reach request is recorded the moment someone asks Aurum to reach a person by text or voice — the feed fills from the conversation."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.reach.map((row) => (
              <li key={row.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <Link className="aurum-intel-row-title" href={row.href}>
                    {row.kind === 'tell' ? 'Tell' : 'Ask'} {row.phoneNumber}
                  </Link>
                  <StatusPill tone={reachStatusTone(row.status)}>
                    {reachStatusLabel(row.status)}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-text">&ldquo;{row.text}&rdquo;</p>
                <p className="aurum-intel-row-foot">
                  {row.recipientKind === 'unknown_number'
                    ? 'an unverified external number'
                    : 'a verified person'}
                  {' · '}
                  {row.smsAttemptsCount} SMS + {row.voiceAttemptsCount} voice attempt(s), cycle{' '}
                  {row.cycle}
                  {' · '}
                  requested {dateTimeLabel(row.createdAt)}
                  {row.failureCode === null
                    ? ''
                    : ` · failed: ${failureCodeLabel(row.failureCode) ?? row.failureCode}`}
                  {' · '}
                  <Link href={row.href}>Open the request</Link>
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="aurum-panel-blurb" style={{ marginTop: 12, marginBottom: 0 }}>
          {REACH_FEED_NOTE}
        </p>
        <p className="aurum-panel-blurb" style={{ marginTop: 8, marginBottom: 0 }}>
          {CELLULAR_TRANSPORT_NOTE}
        </p>
      </Panel>

      <Panel
        title="Sending connections"
        blurb="The tenant-owned telecom accounts: one per vendor account with its E.164 sending number, the credential itself behind an opaque secret-store reference."
        meta={<>{view.connections.length} connection(s)</>}
      >
        {view.connections.length === 0 ? (
          <EmptyState
            title="No telecom account is registered"
            hint="A Twilio or Telnyx account with its sending number — registering one is the path to any SMS or voice reach. Nothing can be sent without it, and this page says so."
            action={
              <Link className="aurum-btn" data-variant="quiet" href="/connections">
                Connect a telecom account
              </Link>
            }
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.connections.map((connection) => (
              <li key={connection.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    {connection.displayName ?? providerLabel(connection.provider)} ·{' '}
                    <code className="aurum-mono">{connection.phoneNumber}</code>
                  </span>
                  <StatusPill tone={connection.status === 'active' ? 'positive' : 'neutral'}>
                    {connection.status === 'active' ? 'Sending' : 'Disabled'}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {providerLabel(connection.provider)} · account{' '}
                  <code className="aurum-mono">{connection.providerAccountId}</code> · updated{' '}
                  {dateTimeLabel(connection.updatedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Routing and cost policies"
        blurb="What governs each reach: SMS attempt budgets and backoff, segment limits, the cost model, the lifetime cap per request, and whether voice escalation is permitted. Policy writes require the administer claim — never this page."
        meta={<>{view.policies.length} row(s)</>}
      >
        {view.policies.length === 0 ? (
          <EmptyState
            title="No tenant policy rows — the built-in floor governs"
            hint="Until an administrator sets one, every reach resolves to the module's built-in floor: no voice fallback, three SMS attempts, a modest cost cap. The numbers in the note below are that floor."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.policies.map((policy) => (
              <li key={policy.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    {policy.reachKind === null ? 'Tenant-wide default' : `“${policy.reachKind}” reaches`}
                  </span>
                  <Tag>{voiceFallbackLabel(policy.voiceFallback)}</Tag>
                </div>
                <p className="aurum-intel-row-foot">
                  {policy.smsMaxAttempts} SMS attempt(s), {policy.retryBackoffSeconds}s backoff ·
                  max {policy.maxSmsSegments} segment(s) · {minorUnitsLabel(
                    policy.smsSegmentCostMinor,
                    policy.currency,
                  )}{' '}
                  per segment, {minorUnitsLabel(policy.voicePerMinuteCostMinor, policy.currency)}{' '}
                  per voice minute · cap{' '}
                  {policy.maxCostPerReachMinor === 0
                    ? 'uncapped'
                    : minorUnitsLabel(policy.maxCostPerReachMinor, policy.currency)}{' '}
                  per reach
                </p>
                {policy.note === null ? null : (
                  <p className="aurum-intel-row-foot">{policy.note}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/cellular"
        />
      )}
    </>
  );
}
