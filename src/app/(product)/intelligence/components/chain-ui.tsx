// Intelligence discovery (W061) — the workflow's presentational parts.
//
// Plain server-renderable components (no hooks, no 'use client') shared
// by the four intelligence pages: the finding row (severity legible,
// why-this-matters + what-Aurum-needs-next ALWAYS visible — the work
// item's two mandatory reading aids), the chain rail (the navigable
// goal → gap → unknown → mission → evidence → belief spine), and the
// evidence/belief/mission/unknown list rows that walk the chain.
//
// W114 — "everything is a conversation": every row below speaks the
// messenger language (intelligence.css, imported here so the chain
// pages lift with the channel): a message row is an avatar tile (one
// stable warm hue per entry TYPE) beside an incoming bubble, with the
// drill-down actions as reply-style chips under the bubble. Semantics,
// links, data and props are unchanged — this is presentation only.
// Color never carries meaning alone: the avatar glyph always pairs with
// the row's own labels and pills.

import Link from 'next/link';
import type { ReactNode } from 'react';
import '../intelligence.css';
import { StatusPill, EmptyState } from '../../components/states';
import type { PillTone } from '../../lib/states';
import { withChatReturn } from '../../chat/lib/chat-types';
import type {
  BeliefItem,
  EvidenceItem,
  GapRunRow,
  MissionRow,
  UnknownRow,
  AcquisitionRow,
} from '../lib/views';
import type { FindingKind, ProactiveFinding } from '../lib/findings';

// W072 — CONVERSATIONAL CONTINUITY ON THE CHAIN: every component below
// accepts an optional `back` return link (guarded `/chat?c=…`, read by
// the page from the `back` query parameter). Internal drill-down links
// carry it forward, so a reader who walks the chain from a chat card
// keeps the way back to the originating conversation at every hop —
// the workflow never strands them. Null (the default, and always on
// direct visits) renders exactly the pre-W072 links.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function percent(value: number): string {
  return `${(Math.round(value * 100)).toFixed(0)}%`;
}

/** The messenger avatar hues (W114) — one stable warm hue per entry type. */
export type AvatarHue =
  | 'finding'       /* gold — findings, discovery passes, Aurum's own voice */
  | 'decision'      /* green — approvals/decisions */
  | 'goal'          /* teal — goals */
  | 'unknown'       /* rust — unknowns */
  | 'mission'       /* rust — missions and their acquisitions */
  | 'capability'    /* plum — capability gaps */
  | 'contradiction' /* terracotta — conflicting evidence */
  | 'system'        /* ink — evidence/beliefs (the immutable layer) */
  | 'aurum';        /* gold — Aurum's own briefing voice */

/** The avatar tile of a message row (decorative: the row's own labels
 *  carry the meaning — the tile never speaks alone). Shared with the
 *  intelligence page's own message rows. */
export function MessageAvatar({ hue, glyph }: { hue: AvatarHue; glyph: string }): ReactNode {
  return (
    <span className="aurum-intel-avatar" data-hue={hue} aria-hidden="true">
      {glyph}
    </span>
  );
}

/** One finding kind → its avatar (hue + the type's initial). */
const FINDING_AVATARS: Record<FindingKind, { hue: AvatarHue; glyph: string }> = {
  unknown: { hue: 'unknown', glyph: 'U' },
  risk: { hue: 'finding', glyph: 'R' },
  opportunity: { hue: 'finding', glyph: 'O' },
  'capability-gap': { hue: 'capability', glyph: 'C' },
  contradiction: { hue: 'contradiction', glyph: 'X' },
};

/** The chain's canonical steps (the acceptance's navigable path). */
export const CHAIN_STEPS = [
  'Goal',
  'Gap',
  'Unknown',
  'Mission',
  'Evidence',
  'Belief',
] as const;

/** One step of the chain rail (linked when the step has a target). */
export function ChainRail({
  activeStep,
  counts,
}: {
  activeStep: (typeof CHAIN_STEPS)[number];
  counts?: Partial<Record<(typeof CHAIN_STEPS)[number], number>>;
}): ReactNode {
  return (
    <ol className="aurum-intel-chain" aria-label="The intelligence chain">
      {CHAIN_STEPS.map((step, index) => (
        <li
          key={step}
          className="aurum-intel-chain-step"
          data-active={step === activeStep}
          data-first={index === 0}
        >
          <span className="aurum-intel-chain-index" aria-hidden="true">
            {index + 1}
          </span>
          <span className="aurum-intel-chain-name">{step}</span>
          {counts?.[step] === undefined ? null : (
            <span className="aurum-intel-chain-count">{counts[step]}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The finding row (Today's briefing unit — why + next ALWAYS visible)
// ---------------------------------------------------------------------------

export function FindingRow({
  finding,
  back = null,
}: {
  finding: ProactiveFinding;
  /** The guarded conversation return link (W072 continuity). */
  back?: string | null;
}): ReactNode {
  const avatar = FINDING_AVATARS[finding.kind] ?? { hue: 'finding' as AvatarHue, glyph: 'F' };
  return (
    <article className="aurum-intel-finding aurum-intel-msg" data-kind={finding.kind}>
      <MessageAvatar hue={avatar.hue} glyph={avatar.glyph} />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-finding-head">
          <StatusPill tone={finding.severity.tone}>{finding.severity.label}</StatusPill>
          <span className="aurum-intel-finding-kind">
            {finding.kind === 'unknown'
              ? 'Unknown — goal-gap'
              : finding.kind === 'contradiction'
                ? 'Conflicting evidence'
                : finding.kind === 'capability-gap'
                  ? 'Capability gap'
                  : finding.kind === 'risk'
                    ? 'Risk finding'
                    : finding.source === 'opportunity'
                      ? 'Opportunity — live record'
                      : 'Opportunity finding'}
          </span>
          <span className="aurum-intel-finding-when" suppressHydrationWarning>
            {dateLabel(finding.detectedAt)}
          </span>
        </div>
        <h3 className="aurum-intel-finding-title">
          <Link href={withChatReturn(finding.href, back)}>{finding.title}</Link>
        </h3>
        <div className="aurum-intel-finding-body">
          <div className="aurum-intel-why">
            <span className="aurum-intel-aid-label">Why this matters</span>
            <p>{finding.whyThisMatters}</p>
          </div>
          <div className="aurum-intel-next">
            <span className="aurum-intel-aid-label">What Aurum needs next</span>
            <p>{finding.whatNext}</p>
          </div>
        </div>
        {finding.impact === null && finding.informationValue === null ? null : (
          <p className="aurum-intel-finding-foot">
            {finding.impact === null ? null : <>Decision impact {percent(finding.impact)}</>}
            {finding.impact !== null && finding.informationValue !== null ? ' · ' : null}
            {finding.informationValue === null ? null : (
              <>Information value {percent(finding.informationValue)}</>
            )}
          </p>
        )}
        {/* The drill-down actions, re-framed as the message's replies. */}
        <div className="aurum-intel-replies">
          {finding.missionId === null ? null : (
            <Link
              className="aurum-intel-chip aurum-intel-chip-primary"
              href={withChatReturn(`/intelligence/missions/${finding.missionId}`, back)}
            >
              Open the learning mission
            </Link>
          )}
          {finding.evidenceObservationIds.length === 0 ? null : (
            <Link className="aurum-intel-chip" href={withChatReturn('/evidence', back)}>
              {finding.evidenceObservationIds.length} evidence link(s)
            </Link>
          )}
          {finding.affectedGoalIds[0] === undefined ? null : (
            <Link
              className="aurum-intel-chip"
              href={withChatReturn(`/intelligence/goals/${finding.affectedGoalIds[0]!}`, back)}
            >
              open the goal chain
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Chain step rows (unknowns, missions, gaps, evidence, beliefs)
// ---------------------------------------------------------------------------

const MISSION_TONE: Record<string, PillTone> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

export function MissionLinkRow({
  mission,
  back = null,
}: {
  mission: MissionRow;
  /** The guarded conversation return link (W072 continuity). */
  back?: string | null;
}): ReactNode {
  return (
    <li className="aurum-intel-msg">
      <MessageAvatar hue="mission" glyph="M" />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-row-head">
          <Link className="aurum-intel-row-title" href={withChatReturn(mission.href, back)}>
            {mission.title}
          </Link>
          <StatusPill tone={MISSION_TONE[mission.urgency] ?? 'neutral'}>
            {mission.urgency} urgency
          </StatusPill>
        </div>
        <p className="aurum-intel-row-text">{mission.knowledgeObjective}</p>
        <p className="aurum-intel-row-foot">
          Confidence {percent(mission.currentConfidence)} → {percent(mission.targetConfidence)} ·
          information value {percent(mission.informationValue)} · status {mission.status}
        </p>
      </div>
    </li>
  );
}

export function UnknownLinkRow({
  unknown,
  back = null,
}: {
  unknown: UnknownRow;
  /** The guarded conversation return link (W072 continuity). */
  back?: string | null;
}): ReactNode {
  return (
    <li className="aurum-intel-msg">
      <MessageAvatar hue="unknown" glyph="U" />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-row-head">
          <Link className="aurum-intel-row-title" href={withChatReturn(unknown.href, back)}>
            {unknown.question}
          </Link>
          <StatusPill tone={unknown.status === 'open' ? 'warning' : 'positive'}>
            {unknown.status === 'open' ? 'Open' : 'Resolved'}
          </StatusPill>
        </div>
        <p className="aurum-intel-row-text">{unknown.consequence}</p>
        <p className="aurum-intel-row-foot">
          Recorded {dateLabel(unknown.recordedAt)}
          {unknown.resolvedAt === null ? '' : ` · resolved ${dateLabel(unknown.resolvedAt)}`}
        </p>
      </div>
    </li>
  );
}

export function GapRunBlock({
  run,
  back = null,
}: {
  run: GapRunRow;
  /** The guarded conversation return link (W072 continuity). */
  back?: string | null;
}): ReactNode {
  return (
    <li className="aurum-intel-msg">
      <MessageAvatar hue="finding" glyph="D" />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-row-head">
          <span className="aurum-intel-row-title">
            Discovery pass — {run.triggerKind}
            {run.triggerLabel === null ? '' : ` · ${run.triggerLabel}`}
          </span>
          <StatusPill tone="info">
            {run.counts.promoted} promoted / {run.counts.total} candidates
          </StatusPill>
        </div>
        <ul className="aurum-intel-candidates">
          {run.candidates.map((candidate) => (
            <li key={candidate.id} className="aurum-intel-candidate" data-disposition={candidate.disposition}>
              <div className="aurum-intel-row-head">
                <span className="aurum-intel-row-title">{candidate.missingKnowledge}</span>
                <StatusPill
                  tone={
                    candidate.disposition === 'promoted'
                      ? 'warning'
                      : candidate.disposition === 'already_covered'
                        ? 'positive'
                        : 'neutral'
                  }
                >
                  {candidate.disposition === 'promoted'
                    ? `${candidate.urgency} urgency — promoted`
                    : candidate.disposition.replace('_', ' ')}
                </StatusPill>
              </div>
              <p className="aurum-intel-row-text">{candidate.consequence}</p>
              <p className="aurum-intel-row-foot">
                Decision impact {percent(candidate.decisionImpact)} · information value{' '}
                {percent(candidate.informationValue)} · confidence {percent(candidate.currentConfidence)} →{' '}
                {percent(candidate.requiredConfidence)}
                {candidate.unknownId === null ? '' : ' · unknown recorded'}
              </p>
              {candidate.unknownId === null && candidate.missionId === null ? null : (
                <div className="aurum-intel-replies">
                  {candidate.unknownId === null ? null : (
                    <Link className="aurum-intel-chip" href={withChatReturn(`/intelligence/unknowns/${candidate.unknownId}`, back)}>
                      Open the unknown
                    </Link>
                  )}
                  {candidate.missionId === null ? null : (
                    <Link className="aurum-intel-chip" href={withChatReturn(`/intelligence/missions/${candidate.missionId}`, back)}>
                      Open the mission
                    </Link>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="aurum-intel-row-foot">Run {dateLabel(run.recordedAt)} · {run.id.slice(0, 8)}</p>
      </div>
    </li>
  );
}

export function EvidenceRow({
  evidence,
  back = null,
}: {
  evidence: EvidenceItem;
  /** The guarded conversation return link (W072 continuity). */
  back?: string | null;
}): ReactNode {
  return (
    <li className="aurum-intel-msg">
      <MessageAvatar hue="system" glyph="E" />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-row-head">
          <span className="aurum-intel-row-title">{evidence.kind}</span>
          <span className="aurum-intel-row-meta">
            {evidence.sourceLabel} · {evidence.channel}
          </span>
        </div>
        <p className="aurum-intel-row-foot">
          Observed {dateLabel(evidence.observedAt)}
          {evidence.confidence === null ? '' : ` · confidence ${percent(evidence.confidence)}`}
        </p>
        <div className="aurum-intel-replies">
          <Link className="aurum-intel-chip" href={withChatReturn('/evidence', back)}>
            evidence surface
          </Link>
        </div>
      </div>
    </li>
  );
}

export function BeliefRow({ belief }: { belief: BeliefItem }): ReactNode {
  return (
    <li className="aurum-intel-msg">
      <MessageAvatar hue="system" glyph="B" />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-row-head">
          <span className="aurum-intel-row-title">{belief.proposition}</span>
          <StatusPill tone={belief.status === 'active' ? 'positive' : 'neutral'}>
            {belief.status === 'active' ? `Belief · ${percent(belief.confidence ?? 0)} confidence` : 'Retired'}
          </StatusPill>
        </div>
        {belief.alternatives.length === 0 ? null : (
          <p className="aurum-intel-row-text">
            Alternatives retained: {belief.alternatives.join(' · ')}
          </p>
        )}
        {belief.disconfirmation === null ? null : (
          <p className="aurum-intel-row-text">
            Could be changed by: {belief.disconfirmation}
          </p>
        )}
        <p className="aurum-intel-row-foot">
          {belief.provenanceObservationIds.length} provenance observation(s) ·{' '}
          {belief.supportingClaimIds.length} weighed claim(s)
          {belief.subjectLabel === null ? '' : ` · subject: ${belief.subjectLabel}`} · valid from{' '}
          {dateLabel(belief.validFrom)} · recorded {dateLabel(belief.recordedAt)}
        </p>
      </div>
    </li>
  );
}

export function AcquisitionRowItem({ acquisition }: { acquisition: AcquisitionRow }): ReactNode {
  return (
    <li className="aurum-intel-msg">
      <MessageAvatar hue="mission" glyph="Q" />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-row-head">
          <span className="aurum-intel-row-title">
            {acquisition.chosenLabel === null
              ? `Acquisition — ${acquisition.decision}`
              : `Asked ${acquisition.chosenLabel}`}
          </span>
          <StatusPill tone={acquisition.outcomeNote === null ? 'info' : 'positive'}>
            {acquisition.outcomeNote === null ? acquisition.decision : 'Answered'}
          </StatusPill>
        </div>
        {acquisition.outcomeNote === null ? null : (
          <p className="aurum-intel-row-text">{acquisition.outcomeNote}</p>
        )}
        <p className="aurum-intel-row-foot">
          Recorded {dateLabel(acquisition.recordedAt)}
          {acquisition.missionCompleted ? ' · mission completed by this answer' : ''}
          {acquisition.evidenceObservationId === null ? '' : ' · evidence recorded'}
        </p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The "why / next" reading aids (always visible on every workflow page)
// ---------------------------------------------------------------------------

/** The two mandatory reading aids, rendered as a paired block inside a
 *  message bubble from Aurum (the channel's opening message). */
export function WhyNextBlock({
  why,
  next,
}: {
  why: string;
  next: string;
}): ReactNode {
  return (
    <div className="aurum-intel-msg">
      <MessageAvatar hue="aurum" glyph="A" />
      <div className="aurum-intel-bubble">
        <div className="aurum-intel-whynext">
          <div className="aurum-intel-why">
            <span className="aurum-intel-aid-label">Why this matters</span>
            <p>{why}</p>
          </div>
          <div className="aurum-intel-next">
            <span className="aurum-intel-aid-label">What Aurum needs next</span>
            <p>{next}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A quiet empty state with a workflow-shaped hint (no dead ends) —
 *  rendered as an honest chat bubble from Aurum. */
export function ChainEmpty({
  step,
  hint,
}: {
  step: string;
  hint: string;
}): ReactNode {
  return (
    <div className="aurum-intel-msg">
      <MessageAvatar hue="aurum" glyph="A" />
      <div className="aurum-intel-bubble">
        <EmptyState title={`No ${step.toLowerCase()}s on this step yet`} hint={hint} />
      </div>
    </div>
  );
}
