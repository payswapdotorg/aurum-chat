// Meeting intelligence surface (W104 — J17) — the /meetings hub.
//
// THE JOURNEY: "the meetings surface — the meeting-intelligence
// contract's user-visible path" (W101 J17). One manager-facing read-only
// surface composes the meetings contract's registry families (W085):
// the captured meetings (one link each to the session/transcript/
// artifact detail), the registered capture connections, the participant
// identity registry, and the explicit access-failure history — a gap in
// meeting intelligence is never silent.
//
// Read-only by design: capture state is registered and managed through
// the connection hub's flows; this page never edits it (lock 31/32 —
// every fact is read straight from the contract). Honest empty states
// point at /connections (the unblocking path); a failing read renders
// the degraded note, never fake emptiness.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill, Tag } from '../components/states';
import { buildMeetingsHomeView } from './lib/views';
import {
  CAPTURE_TRANSPORT_NOTE,
  MEETING_INTELLIGENCE_NOTE,
  accessCodeLabel,
  accessCodeTone,
  connectionStatusLabel,
  connectionStatusTone,
  dateLabel,
  dateTimeLabel,
  ingestionModeLabel,
  providerLabel,
} from './lib/labels';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Meetings — Aurum',
  description:
    'Meeting intelligence Aurum captured: meetings, sessions, participants, transcripts and artifacts, with the capture connections and access history behind them.',
};

export default async function MeetingsPage() {
  const session = await requireAuthenticatedPage();
  const view = await buildMeetingsHomeView(session.context);

  return (
    <>
      <PageHead
        title="Meetings"
        description="What Aurum captured from the meetings your company runs — sessions, who was there, transcripts and artifacts, with the capture state behind them."
        meta={
          <>
            <Link href="/connections">Connect a meeting source</Link>
            {' · '}
            <Link href="/chat">Back to the conversation</Link>
          </>
        }
      />

      <Panel
        title="Captured meetings"
        blurb="The capture registry: every meeting a registered connection has delivered — open one for its sessions, transcripts, recordings and artifacts."
        meta={<>{view.meetings.length} meeting(s)</>}
      >
        {view.meetings.length === 0 ? (
          <EmptyState
            title="No meetings captured yet"
            hint="Capture starts when a meeting connection (Zoom, Teams, Meet or a meeting bot) delivers its first record — register one from the connection hub."
            action={
              <Link className="aurum-btn" data-variant="quiet" href="/connections">
                Connect a meeting source
              </Link>
            }
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.meetings.map((meeting) => (
              <li key={meeting.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <Link className="aurum-intel-row-title" href={meeting.href}>
                    {meeting.title}
                  </Link>
                  <Tag>{providerLabel(meeting.provider)}</Tag>
                </div>
                {meeting.agenda === null ? null : (
                  <p className="aurum-intel-row-text">{meeting.agenda}</p>
                )}
                <p className="aurum-intel-row-foot">
                  Scheduled {dateLabel(meeting.scheduledStartAt)} → {dateLabel(meeting.scheduledEndAt)}
                  {' · '}
                  {meeting.sessionCount === 0
                    ? 'no sessions captured yet'
                    : `${meeting.sessionCount} captured session(s)`}
                  {meeting.lastActivityAt === null
                    ? ''
                    : ` · last activity ${dateTimeLabel(meeting.lastActivityAt)}`}
                  {' · '}
                  <Link href={meeting.href}>Open the meeting</Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Capture connections"
        blurb="The tenant-owned meeting capture endpoints: one per provider account, each with an opaque credential reference — the values never leave the secret store."
        meta={<>{view.connections.length} connection(s)</>}
      >
        {view.connections.length === 0 ? (
          <EmptyState
            title="No meeting capture is registered"
            hint="A Zoom workspace, a Teams tenant, a Meet workspace or a meeting-bot account — registering one is the path to captured meetings."
            action={
              <Link className="aurum-btn" data-variant="quiet" href="/connections">
                Connect a meeting source
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
                    {providerLabel(connection.provider)}
                  </span>
                  <StatusPill tone={connectionStatusTone(connection.status)}>
                    {connectionStatusLabel(connection.status)}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  account <code className="aurum-mono">{connection.providerAccountId}</code>
                  {' · '}
                  {connection.modes.map((mode) => ingestionModeLabel(mode)).join(' + ') || 'no capture modes'}
                  {connection.oauthExpiresAt === null
                    ? ''
                    : ` · grant expires ${dateLabel(connection.oauthExpiresAt)}`}
                  {' · '}
                  updated {dateLabel(connection.updatedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="aurum-panel-blurb" style={{ marginTop: 12, marginBottom: 0 }}>
          {CAPTURE_TRANSPORT_NOTE}
        </p>
      </Panel>

      <Panel
        title="Participants"
        blurb="The participant identity registry: provider-minted identities captured on sight, resolved onto your people where a verified email bridge exists."
        meta={<>{view.participants.length} identity(ies)</>}
      >
        {view.participants.length === 0 ? (
          <EmptyState
            title="No participants captured yet"
            hint="Identities register on sight as sessions arrive — this list fills with the meetings your company runs."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.participants.map((participant) => (
              <li key={participant.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    {participant.displayName ?? participant.email ?? 'An unnamed participant'}
                  </span>
                  <StatusPill tone={participant.resolved ? 'positive' : 'neutral'}>
                    {participant.resolved ? 'resolved to a person' : 'external / unresolved'}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {providerLabel(participant.provider)}
                  {participant.email === null ? '' : ` · ${participant.email}`}
                  {' · '}
                  last seen {dateLabel(participant.lastSeenAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Access history"
        blurb="The explicit failed/expired-access records — when a meeting's intelligence is missing, this is why (each also lands in the evidence model)."
        meta={<>{view.accessEvents.length} event(s)</>}
      >
        {view.accessEvents.length === 0 ? (
          <EmptyState
            title="No access failures recorded"
            hint="Failed or expired meeting access is recorded explicitly — nothing silent. An empty history means every capture path is healthy."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.accessEvents.map((event) => (
              <li key={event.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">{accessCodeLabel(event.code)}</span>
                  <StatusPill tone={accessCodeTone(event.code)}>
                    {providerLabel(event.provider)}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {event.detail ?? 'no provider detail'}
                  {' · '}
                  occurred {dateTimeLabel(event.occurredAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="How meeting intelligence works" blurb="The standing contract, in plain words.">
        <p className="aurum-item-text">{MEETING_INTELLIGENCE_NOTE}</p>
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/meetings"
        />
      )}
    </>
  );
}
