// Evidence, audit & explainability (W065) — the causal view's
// presentational parts.
//
// Plain server-renderable components (no hooks, no 'use client'): the
// causal rail (the §24 chain with per-link present/absent state — what is
// absent is STATED, never hidden), the evidence row (source, freshness
// and reliability signals inline), the source reliability row, the
// retained-contradiction row (both sides human-labeled, lock 12), and the
// quiet "not on this chain" state for absent links.
//
// Visual language: ShareNet-dominant (W057's tokens) — hairlines, status
// pills, restrained tones; color never carries meaning alone (every pill
// pairs its dot with a label). Styling is scoped under `aurum-explain-*`
// in product.css.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState, StatusPill } from '../../components/states';
import type { PillTone } from '../../lib/states';
import type { ChainLinkReport } from '@/modules/audit/contract';
import type {
  ContradictionRowView,
  EvidenceRowView,
  SourceRowView,
} from '../lib/views';
import {
  CAUSAL_STEP_HINTS,
  CAUSAL_STEPS,
  asFreshnessStatus,
  contradictionLabel,
  contradictionTone,
  dateTimeLabel,
  freshnessLabel,
  freshnessTone,
  percent,
  sourceStatusLabel,
  sourceStatusTone,
} from '../lib/labels';

// ---------------------------------------------------------------------------
// The causal rail (§24's chain, one pill per link, present/absent stated)
// ---------------------------------------------------------------------------

/**
 * The spine of the view: all twelve §24 links in frozen order, each
 * showing its supporting item count and — through data-absent — whether
 * the link carries anything for THIS decision. The rail is the honest
 * summary of the completeness report the reconstruction returns.
 */
export function CausalRail({ completeness }: { completeness: ChainLinkReport[] }): ReactNode {
  const byStage = new Map(completeness.map((report) => [report.stage, report]));
  return (
    <ol className="aurum-explain-rail" aria-label="The causal chain of this decision">
      {CAUSAL_STEPS.map((step, index) => {
        const report = byStage.get(step.stage);
        const present = report?.present ?? false;
        return (
          <li
            key={step.stage}
            className="aurum-explain-rail-step"
            data-absent={!present}
            title={CAUSAL_STEP_HINTS[step.stage]}
          >
            <span className="aurum-explain-rail-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="aurum-explain-rail-name">{step.label}</span>
            {present ? (
              <span className="aurum-explain-rail-count">
                {report?.itemCount ?? 0}
              </span>
            ) : (
              <span className="aurum-explain-rail-none">not on this chain</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The quiet state for a chain link that carries nothing for this decision. */
export function LinkAbsent({ stage }: { stage: string }): ReactNode {
  return (
    <EmptyState
      title="Nothing on this link"
      hint={`This decision's chain carries no ${stage.toLowerCase()} record — the reconstruction states what is absent instead of inventing it.`}
    />
  );
}

// ---------------------------------------------------------------------------
// The evidence row (one observation, with its source and freshness signals)
// ---------------------------------------------------------------------------

export function EvidenceRow({ row }: { row: EvidenceRowView }): ReactNode {
  if (row.unreadable) {
    return (
      <li className="aurum-explain-row" data-restricted="true">
        <div className="aurum-explain-row-head">
          <span className="aurum-explain-row-title">Restricted observation</span>
          <StatusPill tone="neutral">Restricted</StatusPill>
        </div>
        <p className="aurum-explain-row-foot">
          You may not read this observation — its existence and position on the chain are
          shown, its content is not.
        </p>
      </li>
    );
  }
  return (
    <li className="aurum-explain-row">
      <div className="aurum-explain-row-head">
        <span className="aurum-explain-row-title">{row.kind}</span>
        {row.freshness === null ? (
          <StatusPill tone="neutral">Freshness unavailable</StatusPill>
        ) : (
          <StatusPill tone={freshnessTone(asFreshnessStatus(row.freshness.status))}>
            {freshnessLabel(asFreshnessStatus(row.freshness.status))}
          </StatusPill>
        )}
        {row.confidence === null ? null : (
          <span className="aurum-explain-row-meta">
            confidence {percent(row.confidence)}
          </span>
        )}
      </div>
      {row.payload === null ? null : <p className="aurum-explain-row-text">{row.payload}</p>}
      <p className="aurum-explain-row-foot">
        {row.sourceLabel === null ? 'No source label' : `Source: ${row.sourceLabel}`} ·
        channel {row.channel} · observed {dateTimeLabel(row.observedAt)}
        {row.freshness === null
          ? ''
          : ` · evidence ${row.freshness.age} · ingestion latency ${row.freshness.latency}${
              row.freshness.latencyExceeded ? ' (policy exceeded)' : ''
            }`}
      </p>
      {row.extractor === null ? null : (
        <p className="aurum-explain-row-foot">
          Extracted by {row.extractor.provider} / {row.extractor.model} — AI output is
          evidence with lineage, never authority on its own.
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The source reliability row (registered sources: status + stream freshness)
// ---------------------------------------------------------------------------

export function SourceRow({ row }: { row: SourceRowView }): ReactNode {
  return (
    <li className="aurum-explain-row">
      <div className="aurum-explain-row-head">
        <span className="aurum-explain-row-title">{row.label}</span>
        <StatusPill tone={sourceStatusTone(row.status)}>
          {sourceStatusLabel(row.status)}
        </StatusPill>
        {row.freshness === null ? (
          <StatusPill tone="neutral">Freshness unavailable</StatusPill>
        ) : (
          <StatusPill tone={freshnessTone(asFreshnessStatus(row.freshness.status))}>
            {freshnessLabel(asFreshnessStatus(row.freshness.status))}
          </StatusPill>
        )}
      </div>
      <p className="aurum-explain-row-text">
        {row.observationCount} of this decision&apos;s observation(s) cite this source ·
        provider {row.provider}
      </p>
      <p className="aurum-explain-row-foot">
        {row.freshness === null
          ? 'The freshness evaluation was unavailable just now.'
          : `Newest evidence ${row.freshness.age} · considered ${row.freshness.considered} observation(s) · avg latency ${
              row.freshness.avgLatency ?? '—'
            } · worst ${row.freshness.maxLatency ?? '—'}`}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The retained contradiction row (lock 12 — both sides, never merged away)
// ---------------------------------------------------------------------------

function SideLabel({
  side,
}: {
  side: ContradictionRowView['left'];
}): ReactNode {
  return (
    <span className="aurum-explain-side">
      <span className="aurum-explain-side-kind">
        {side.refKind === 'observation' ? 'Observation' : 'Claim'}
      </span>
      <span className="aurum-explain-side-text">{side.label}</span>
    </span>
  );
}

export function ContradictionRow({ row }: { row: ContradictionRowView }): ReactNode {
  return (
    <li className="aurum-explain-row">
      <div className="aurum-explain-row-head">
        <StatusPill tone={contradictionTone(row.status)}>
          {contradictionLabel(row.status)}
        </StatusPill>
        <span className="aurum-explain-row-meta">
          detected {dateTimeLabel(row.detectedAt)}
        </span>
      </div>
      <div className="aurum-explain-conflict">
        <SideLabel side={row.left} />
        <span className="aurum-explain-conflict-mark" aria-hidden="true">
          ⇄
        </span>
        <SideLabel side={row.right} />
      </div>
      <p className="aurum-explain-row-text">{row.note}</p>
      {row.status === 'resolved' ? (
        <p className="aurum-explain-row-foot">
          Weighed {row.resolvedAt === null ? '' : dateTimeLabel(row.resolvedAt)} —{' '}
          {row.resolutionNote ?? 'no resolution note recorded'}. Both sides are retained.
        </p>
      ) : (
        <p className="aurum-explain-row-foot">
          The conflict is retained, not merged away; a weighing note resolves it without
          erasing either side.
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The audit history row (the append-only trail)
// ---------------------------------------------------------------------------

export function AuditRow({
  event,
  stageLabel,
  summary,
  recordedAt,
  href,
}: {
  event: string;
  stageLabel: string;
  summary: string;
  recordedAt: string;
  href: string | null;
}): ReactNode {
  const body = (
    <>
      <div className="aurum-explain-row-head">
        <span className="aurum-explain-row-title">{event}</span>
        <span className="aurum-explain-row-meta">chain stage: {stageLabel}</span>
      </div>
      <p className="aurum-explain-row-text">{summary}</p>
      <p className="aurum-explain-row-foot">recorded {dateTimeLabel(recordedAt)}</p>
    </>
  );
  return (
    <li className="aurum-explain-row">
      {href === null ? body : <Link href={href} className="aurum-explain-audit-link">{body}</Link>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

/** A confidence figure with its alternatives (beliefs carry uncertainty). */
export function ConfidenceNote({
  confidence,
  suffix,
}: {
  confidence: number;
  suffix?: string;
}): ReactNode {
  return (
    <span className="aurum-explain-row-meta">
      confidence {percent(confidence)}
      {suffix === undefined ? '' : ` · ${suffix}`}
    </span>
  );
}

/** Latency/agreement figure for acquisition progress (missions). */
export function MissionProgress({
  current,
  target,
  achieved,
}: {
  current: number;
  target: number;
  achieved: number | null;
}): ReactNode {
  const value = achieved ?? current;
  const tone: PillTone = value >= target ? 'positive' : 'warning';
  return (
    <StatusPill tone={tone}>
      {Math.round(value * 100)}% / target {Math.round(target * 100)}%
      <span className="aurum-sr-only">
        {value >= target ? 'target met' : 'below target'}
      </span>
    </StatusPill>
  );
}
