// Meeting intelligence surface (W104 — J17) — the meeting detail page.
//
// One captured meeting in full: the provider metadata (title, agenda,
// schedule, host), every captured session with its attendance, and each
// session's transcripts and artifacts under progressive disclosure —
// every captured row carries its evidence observation link (the capture
// is immutable evidence, not just a registry row).
//
// Composition through the meetings contract only (lock 31/32); a
// foreign/missing id renders the honest not-found state (the uniform
// meeting_not_found discipline — no existence leak).

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { ChatReturnLink, chatReturnFromSearchParams } from '../../chat/components/chat-return-link';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill, Tag } from '../../components/states';
import { buildMeetingDetailView } from '../lib/views';
import type { SessionDetailView } from '../lib/views';
import {
  artifactKindLabel,
  dateLabel,
  dateTimeLabel,
  providerLabel,
  sessionStatusLabel,
  sessionStatusTone,
} from '../lib/labels';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'One meeting — Aurum Meetings',
  description:
    'One captured meeting: its sessions, participants, transcripts and artifacts, each grounded in the immutable evidence model.',
};

function byteSizeLabel(bytes: number | null): string {
  if (bytes === null) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SessionBlock({ session }: { session: SessionDetailView }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">
          {session.title ?? 'One occurrence of this meeting'}
        </span>
        <StatusPill tone={sessionStatusTone(session.status)}>
          {sessionStatusLabel(session.status)}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        {session.startedAt === null ? 'not started' : `started ${dateTimeLabel(session.startedAt)}`}
        {session.endedAt === null ? '' : ` · ended ${dateTimeLabel(session.endedAt)}`}
        {' · '}
        {session.participants.length} attendee(s)
      </p>
      <div className="aurum-intel-row-text">
        <p className="aurum-intel-row-foot">Attendance (the latest state the provider delivered):</p>
        <ul className="aurum-item-list">
          {session.participants.map((participant) => (
            <li key={participant.participantId}>
              <div className="aurum-item-head">
                <span className="aurum-item-title">
                  {participant.displayName ?? participant.email ?? 'An unnamed attendee'}
                </span>
              </div>
              <p className="aurum-item-text">
                {participant.email ?? 'no email captured'}
                {participant.joinedAt === null ? '' : ` · joined ${dateTimeLabel(participant.joinedAt)}`}
                {participant.leftAt === null ? '' : ` · left ${dateTimeLabel(participant.leftAt)}`}
              </p>
            </li>
          ))}
        </ul>
      </div>
      {session.transcripts.length === 0 && session.artifacts.length === 0 ? (
        <p className="aurum-intel-row-foot">
          No transcripts or artifacts captured for this session yet — capture lands here the moment
          the provider delivers it.
        </p>
      ) : null}
      {session.transcripts.length === 0 ? null : (
        <details className="aurum-learn-disclose" style={{ marginTop: 10 }}>
          <summary>
            {session.transcripts.length} transcript(s) — {session.transcripts[0]!.language ?? 'unknown language'}
          </summary>
          <ul className="aurum-intel-list" style={{ marginTop: 10 }}>
            {session.transcripts.map((transcript) => (
              <li key={transcript.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    {transcript.segmentCount} attributed segment(s)
                  </span>
                  <Tag>{transcript.language ?? 'language unknown'}</Tag>
                </div>
                <p className="aurum-intel-row-text">&ldquo;{transcript.preview}&rdquo;</p>
                <p className="aurum-intel-row-foot">
                  captured {dateTimeLabel(transcript.capturedAt)} · evidence{' '}
                  <Link href="/evidence">{transcript.evidenceObservationId.slice(0, 8)}</Link>
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {session.artifacts.length === 0 ? null : (
        <details className="aurum-learn-disclose" style={{ marginTop: 10 }}>
          <summary>{session.artifacts.length} artifact(s)</summary>
          <ul className="aurum-intel-list" style={{ marginTop: 10 }}>
            {session.artifacts.map((artifact) => (
              <li key={artifact.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    {artifact.displayName ?? 'An untitled artifact'}
                  </span>
                  <Tag>{artifactKindLabel(artifact.kind)}</Tag>
                </div>
                <p className="aurum-intel-row-foot">
                  {artifact.mediaType ?? 'media type unknown'} · {byteSizeLabel(artifact.byteSize)} ·
                  captured {dateTimeLabel(artifact.capturedAt)} · evidence{' '}
                  <Link href="/evidence">{artifact.evidenceObservationId.slice(0, 8)}</Link>
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ meetingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { meetingId } = await params;
  const back = chatReturnFromSearchParams(await searchParams);
  const session = await requireAuthenticatedPage();

  let view: Awaited<ReturnType<typeof buildMeetingDetailView>>;
  try {
    view = await buildMeetingDetailView(session.context, meetingId);
  } catch {
    notFound();
  }

  const meeting = view.meeting;

  return (
    <>
      <PageHead
        title={meeting.title ?? 'An untitled meeting'}
        description={`A captured ${providerLabel(meeting.provider)} meeting — scheduled ${dateLabel(
          meeting.scheduledStartAt,
        )} → ${dateLabel(meeting.scheduledEndAt)}, ${view.sessions.length} captured session(s).`}
        meta={
          <>
            <ChatReturnLink back={back} />
            <Link href="/meetings">← Meetings</Link>
            {' · '}
            <Link href="/evidence">Evidence</Link>
          </>
        }
      />

      <Panel
        title="The meeting"
        blurb="The provider-identified scheduled entity — the capture registry's latest metadata; every delivered state is preserved as an immutable observation."
        meta={<Tag>{providerLabel(meeting.provider)}</Tag>}
      >
        <p className="aurum-intel-row-text">
          <strong>Title:</strong> {meeting.title ?? '(untitled — the provider has delivered no title)'}
        </p>
        <p className="aurum-intel-row-text">
          <strong>Agenda:</strong> {meeting.agenda ?? '(no agenda delivered)'}
        </p>
        <p className="aurum-intel-row-foot">
          Scheduled {dateLabel(meeting.scheduledStartAt)} → {dateLabel(meeting.scheduledEndAt)}
          {meeting.underlyingPlatform === null
            ? ''
            : ` · happened on ${meeting.underlyingPlatform}`}
          {' · '}
          first captured {dateLabel(meeting.createdAt)} · updated {dateLabel(meeting.updatedAt)}
        </p>
      </Panel>

      <Panel
        title="Captured sessions"
        blurb="One occurrence of the meeting each: actual times, attendance, and the transcripts and artifacts captured for it."
        meta={<>{view.sessions.length} session(s)</>}
      >
        {view.sessions.length === 0 ? (
          <EmptyState
            title="No sessions captured yet"
            hint="Sessions register when this meeting actually happens and the capture path delivers them."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.sessions.map((session) => (
              <SessionBlock key={session.id} session={session} />
            ))}
          </ul>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref={`/meetings/${meeting.id}`}
        />
      )}
    </>
  );
}
