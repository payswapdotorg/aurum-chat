// Intelligence discovery (W061) — the workflow's presentational parts.
//
// Plain server-renderable components (no hooks, no 'use client') shared
// by the four intelligence pages: the finding row (severity legible,
// why-this-matters + what-Aurum-needs-next ALWAYS visible — the work
// item's two mandatory reading aids), the chain rail (the navigable
// goal → gap → unknown → mission → evidence → belief spine), and the
// evidence/belief/mission/unknown list rows that walk the chain.
//
// Visual language: ShareNet-dominant (W057's tokens) — hairlines, status
// pills, restrained tones; color never carries meaning alone (every pill
// pairs its dot with a label). Styling is scoped under the
// `aurum-intel-*` classes in product.css.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusPill, EmptyState } from '../../components/states';
import type { PillTone } from '../../lib/states';
import type {
  BeliefItem,
  EvidenceItem,
  GapRunRow,
  MissionRow,
  UnknownRow,
  AcquisitionRow,
} from '../lib/views';
import type { ProactiveFinding } from '../lib/findings';

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

export function FindingRow({ finding }: { finding: ProactiveFinding }): ReactNode {
  return (
    <article className="aurum-intel-finding" data-kind={finding.kind}>
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
                  : 'Opportunity finding'}
        </span>
        <span className="aurum-intel-finding-when" suppressHydrationWarning>
          {dateLabel(finding.detectedAt)}
        </span>
      </div>
      <h3 className="aurum-intel-finding-title">
        <Link href={finding.href}>{finding.title}</Link>
      </h3>
      <div className="aurum-intel-finding-body">
        <div className="aurum-intel-why">
          <span className="aurum-intel-aid-label">Why this matters</span>
          <p>{finding.whyThisMatters}</p>
        </div>
        <div className="aurum-intel-next">
          <span className="aurum-intel-aid-label">What Aurum needs next</span>
          <p>{finding.whatNext}</p>
          {finding.missionId === null ? null : (
            <Link
              className="aurum-intel-inline-link"
              href={`/intelligence/missions/${finding.missionId}`}
            >
              Open the learning mission
            </Link>
          )}
        </div>
      </div>
      <p className="aurum-intel-finding-foot">
        {finding.impact === null ? null : <>Decision impact {percent(finding.impact)} · </>}
        {finding.informationValue === null ? null : <>Information value {percent(finding.informationValue)} · </>}
        {finding.evidenceObservationIds.length === 0 ? null : (
          <Link href="/evidence">{finding.evidenceObservationIds.length} evidence link(s)</Link>
        )}
        {finding.affectedGoalIds[0] === undefined ? null : (
          <>
            {' '}· <Link href={`/intelligence/goals/${finding.affectedGoalIds[0]!}`}>open the goal chain</Link>
          </>
        )}
      </p>
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

export function MissionLinkRow({ mission }: { mission: MissionRow }): ReactNode {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link className="aurum-intel-row-title" href={mission.href}>
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
    </li>
  );
}

export function UnknownLinkRow({ unknown }: { unknown: UnknownRow }): ReactNode {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link className="aurum-intel-row-title" href={unknown.href}>
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
    </li>
  );
}

export function GapRunBlock({ run }: { run: GapRunRow }): ReactNode {
  return (
    <li className="aurum-intel-row">
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
            <p className="aurum-intel-row-links">
              {candidate.unknownId === null ? null : (
                <Link className="aurum-intel-inline-link" href={`/intelligence/unknowns/${candidate.unknownId}`}>
                  Open the unknown
                </Link>
              )}
              {candidate.missionId === null ? null : (
                <Link className="aurum-intel-inline-link" href={`/intelligence/missions/${candidate.missionId}`}>
                  Open the mission
                </Link>
              )}
            </p>
          </li>
        ))}
      </ul>
      <p className="aurum-intel-row-foot">Run {dateLabel(run.recordedAt)} · {run.id.slice(0, 8)}</p>
    </li>
  );
}

export function EvidenceRow({ evidence }: { evidence: EvidenceItem }): ReactNode {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">{evidence.kind}</span>
        <span className="aurum-intel-row-meta">
          {evidence.sourceLabel} · {evidence.channel}
        </span>
      </div>
      <p className="aurum-intel-row-foot">
        Observed {dateLabel(evidence.observedAt)}
        {evidence.confidence === null ? '' : ` · confidence ${percent(evidence.confidence)}`} ·{' '}
        <Link href="/evidence">evidence surface</Link>
      </p>
    </li>
  );
}

export function BeliefRow({ belief }: { belief: BeliefItem }): ReactNode {
  return (
    <li className="aurum-intel-row">
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
    </li>
  );
}

export function AcquisitionRowItem({ acquisition }: { acquisition: AcquisitionRow }): ReactNode {
  return (
    <li className="aurum-intel-row">
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
    </li>
  );
}

// ---------------------------------------------------------------------------
// The "why / next" reading aids (always visible on every workflow page)
// ---------------------------------------------------------------------------

/** The two mandatory reading aids, rendered as a paired block. */
export function WhyNextBlock({
  why,
  next,
}: {
  why: string;
  next: string;
}): ReactNode {
  return (
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
  );
}

/** A quiet empty state with a workflow-shaped hint (no dead ends). */
export function ChainEmpty({
  step,
  hint,
}: {
  step: string;
  hint: string;
}): ReactNode {
  return <EmptyState title={`No ${step.toLowerCase()}s on this step yet`} hint={hint} />;
}
