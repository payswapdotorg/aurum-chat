// Cellular reachability surface (W104 — J18) — the reach detail page.
//
// One reach request in full: the immutable intent (who, what, the exact
// text), the authority-gate reference that governs it, the POLICY
// SNAPSHOT that decided retries and cost for THIS request (later policy
// edits never rewrite it), the append-only attempt audit — each row the
// per-leg evidence, including the honest "no transport wired"
// provider_unavailable attempts this environment records — and the
// inbound replies correlated to the request.
//
// Composition through the cellular contract only (lock 31/32); a
// foreign/missing id renders the honest not-found state (the uniform
// reach_not_found discipline — no existence leak).

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { ChatReturnLink, chatReturnFromSearchParams } from '../../../chat/components/chat-return-link';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill, Tag } from '../../../components/states';
import { buildReachDetailView } from '../../lib/views';
import {
  CELLULAR_TRANSPORT_NOTE,
  attemptStatusLabel,
  attemptStatusTone,
  dateTimeLabel,
  failureCodeLabel,
  minorUnitsLabel,
  policySourceLabel,
  providerLabel,
  reachStatusLabel,
  reachStatusTone,
  voiceFallbackLabel,
} from '../../lib/labels';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'One reach request — Aurum Cellular',
  description:
    'One SMS/voice reach request: the intent, the policy snapshot that governs it, the full attempt history and any replies.',
};

export default async function ReachPage({
  params,
  searchParams,
}: {
  params: Promise<{ reachId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reachId } = await params;
  const back = chatReturnFromSearchParams(await searchParams);
  const session = await requireAuthenticatedPage();

  let view: Awaited<ReturnType<typeof buildReachDetailView>>;
  try {
    view = await buildReachDetailView(session.context, reachId);
  } catch {
    notFound();
  }

  const reach = view.reach;

  return (
    <>
      <PageHead
        title={`${reach.kind === 'tell' ? 'Tell' : 'Ask'} ${reach.phoneNumber}`}
        description={`One cellular reach request — ${reachStatusLabel(reach.status)}, ${view.attempts.length} audited attempt(s), cycle ${reach.cycle}.`}
        meta={
          <>
            <ChatReturnLink back={back} />
            <Link href="/cellular">← Cellular</Link>
            {reach.actionRequestId === null ? null : (
              <>
                {' · '}
                <Link href="/approvals">The authority gate</Link>
              </>
            )}
          </>
        }
      />

      <Panel
        title="The request"
        blurb="The immutable intent: who to reach, the exact message, and the policy snapshot that decided retries and cost for this request — later policy edits never rewrite it."
        meta={
          <StatusPill tone={reachStatusTone(reach.status)}>
            {reachStatusLabel(reach.status)}
          </StatusPill>
        }
      >
        <p className="aurum-intel-row-text">&ldquo;{reach.text}&rdquo;</p>
        <p className="aurum-intel-row-foot">
          To <code className="aurum-mono">{reach.phoneNumber}</code>
          {reach.recipientKind === 'unknown_number'
            ? ' — an unverified external number (gated as an external communication)'
            : ' — a person with a verified phone identity (gated as employee messaging)'}
          {' · '}
          requested {dateTimeLabel(reach.createdAt)}
          {' · '}
          cycle {reach.cycle}
          {reach.deliveredAt === null ? '' : ` · delivered ${dateTimeLabel(reach.deliveredAt)}`}
          {reach.repliedAt === null ? '' : ` · replied ${dateTimeLabel(reach.repliedAt)}`}
        </p>
        {reach.failureCode === null ? null : (
          <p className="aurum-intel-row-foot">
            <strong>Failed:</strong> {failureCodeLabel(reach.failureCode) ?? reach.failureCode}
            {' — '}
            {reach.failureCode === 'provider_unavailable'
              ? 'the module-recorded environment limit (retryable)'
              : 'see the attempt audit below for the per-leg evidence'}
          </p>
        )}
        <p className="aurum-intel-row-foot">
          Policy snapshot: {voiceFallbackLabel(reach.voiceFallback)} · {reach.smsMaxAttempts} SMS
          attempt budget, {reach.retryBackoffSeconds}s backoff · max {reach.maxSmsSegments}{' '}
          segment(s) · {minorUnitsLabel(reach.smsSegmentCostMinor, reach.currency)} per segment,{' '}
          {minorUnitsLabel(reach.voicePerMinuteCostMinor, reach.currency)} per voice minute · cap{' '}
          {reach.maxCostPerReachMinor === 0
            ? 'uncapped'
            : minorUnitsLabel(reach.maxCostPerReachMinor, reach.currency)}
          {' · '}
          decided by {policySourceLabel(reach.policySource)}
        </p>
        <p className="aurum-intel-row-foot">
          Authority gate: {reach.actionKind}
          {reach.actionRequestId === null ? ' (not yet evaluated)' : ''}
          {reach.nextAttemptAt === null
            ? ''
            : ` · next attempt eligible ${dateTimeLabel(reach.nextAttemptAt)}`}
        </p>
      </Panel>

      <Panel
        title="The attempt audit"
        blurb="One row per leg ever placed, permanently recorded: what was sent, through which connection, at what estimated cost, and the carrier's receipts. A failed row with no connection is an honest placement failure — nothing was sent."
        meta={<>{view.attempts.length} attempt(s)</>}
      >
        {view.attempts.length === 0 ? (
          <EmptyState
            title="No attempts recorded"
            hint="The first delivery attempt records here the moment the authority gate allows one — waiting approvals place nothing."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.attempts.map((attempt) => (
              <li key={attempt.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    #{attempt.attemptNo} · {attempt.leg === 'sms' ? 'SMS' : 'Voice'} · cycle{' '}
                    {attempt.cycle}
                  </span>
                  <StatusPill tone={attemptStatusTone(attempt.status)}>
                    {attemptStatusLabel(attempt.status)}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-text">&ldquo;{attempt.text}&rdquo;</p>
                <p className="aurum-intel-row-foot">
                  {providerLabel(attempt.provider)}
                  {attempt.connectionId === null
                    ? ' · no leg placed (no connection used)'
                    : ` · through connection ${attempt.connectionId.slice(0, 8)}`}
                  {attempt.fromNumber === null ? '' : ` · from ${attempt.fromNumber}`}
                  {' · '}
                  to {attempt.toNumber}
                  {attempt.segments === null ? '' : ` · ${attempt.segments} segment(s)`}
                  {' · '}
                  {attempt.costMinor === 0
                    ? 'no cost recorded'
                    : `estimated ${minorUnitsLabel(attempt.costMinor, reach.currency)}`}
                  {' · '}
                  gate {attempt.gateStatus}
                  {' · '}
                  attempted {dateTimeLabel(attempt.attemptedAt)}
                  {attempt.receiptAt === null ? '' : ` · receipt ${dateTimeLabel(attempt.receiptAt)}`}
                </p>
                {attempt.detail === null ? null : (
                  <p className="aurum-intel-row-foot">{attempt.detail}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="aurum-panel-blurb" style={{ marginTop: 12, marginBottom: 0 }}>
          {CELLULAR_TRANSPORT_NOTE}
        </p>
      </Panel>

      <Panel
        title="Replies"
        blurb="Inbound texts and calls this request received back — a reply lands here and in the conversation it belongs to."
        meta={<>{view.replies.length} reply(ies)</>}
      >
        {view.replies.length === 0 ? (
          <EmptyState
            title="No replies yet"
            hint="When this person texts or calls back, the reply records here with its conversation reference."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.replies.map((reply) => (
              <li key={reply.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    <code className="aurum-mono">{reply.fromNumber}</code> replied
                  </span>
                  <Tag>{reply.channel === 'sms' ? 'SMS' : 'Voice'}</Tag>
                </div>
                <p className="aurum-intel-row-text">&ldquo;{reply.text}&rdquo;</p>
                <p className="aurum-intel-row-foot">
                  recorded {dateTimeLabel(reply.createdAt)}
                  {reply.conversationId === null
                    ? ''
                    : ` · conversation ${reply.conversationId.slice(0, 8)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref={`/cellular/reach/${reach.id}`}
        />
      )}
    </>
  );
}
