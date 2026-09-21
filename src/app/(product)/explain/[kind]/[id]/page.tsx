// Evidence, audit & explainability (W065) — THE causal evidence view.
//
// One consequential answer or decision, reconstructed end to end (§24,
// plan §2 Journey K): input → observations → evidence → belief/unknown →
// mission → source selection (reliability/freshness) → policy →
// recommendation → approval → execution → outcome → learning.
//
// The audit module's reconstruction (W046) is the evidence; this page is
// its honest presentation — every link present or STATED absent (the
// reconstruction's own completeness report), every row leading with human
// text, every status a pill with a label (never color alone), restricted
// evidence shown as restricted (never leaked, never hidden).
//
// A foreign or malformed anchor renders the honest not-found state — the
// audit contract's uniform not-found, no existence leak across tenants.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../../../components/states';
import { anchorHref, anchorKindForSegment } from '../../lib/anchors';
import {
  beliefStatusLabel,
  beliefStatusTone,
  dateTimeLabel,
  executionStateLabel,
  executionStateTone,
  gateLabel,
  gateTone,
  payloadSummary,
  percent,
  causalHint,
  requestStatusLabel,
  requestStatusTone,
  slugLabel,
} from '../../lib/labels';
import { buildDecisionExplainView } from '../../lib/views';
import type { ChainLinkReport } from '@/modules/audit/contract';
import {
  AuditRow,
  ContradictionRow,
  CausalRail,
  EvidenceRow,
  LinkAbsent,
  MissionProgress,
  SourceRow,
} from '../../components/chain-steps';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Explain a decision — Aurum',
  description:
    'The causal chain of one consequential decision: input, evidence, sources, contradictions, beliefs, missions, policy, approval, execution, outcome and learning.',
};

export default async function ExplainDecisionPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  const anchorKind = anchorKindForSegment(kind);
  if (anchorKind === null) notFound();

  const session = await requireAuthenticatedPage();
  const resolution = await buildDecisionExplainView(session.context, anchorKind, id);
  if (resolution.status === 'not-found') notFound();

  const view = resolution.view;
  const chain = view.chain;

  const byStage = new Map<string, ChainLinkReport>(
    view.completeness.map((report: ChainLinkReport) => [String(report.stage), report]),
  );
  const present = (stage: string): boolean => byStage.get(stage)?.present ?? false;
  const count = (stage: string): number => byStage.get(stage)?.itemCount ?? 0;

  const inputObservation = chain.input.observation;

  return (
    <>
      <PageHead
        title={view.title}
        description={`${view.subtitle} — reconstructed ${dateTimeLabel(
          view.reconstructedAt,
        )} from the owning modules' real records.`}
        meta={
          <>
            <Link href="/explain">← Evidence &amp; audit</Link>
            {' · '}
            <span>{view.kindLabel}</span>
            {view.correlationId === null ? null : (
              <>
                {' · '}
                <Link href={anchorHref('correlation', view.correlationId)}>
                  open the whole decision flow
                </Link>
              </>
            )}
          </>
        }
      />

      <CausalRail completeness={view.completeness} />

      {/* 1 — Input */}
      <Panel
        title="1 · Input — what started this"
        blurb={causalHint('input')}
        meta={<StatusPill tone={present('input') ? 'positive' : 'neutral'}>{present('input') ? 'Present' : 'Absent'}</StatusPill>}
      >
        {!present('input') ? (
          <LinkAbsent stage="input" />
        ) : (
          <>
            <p className="aurum-explain-row-text">
              <strong>Trigger:</strong> {chain.input.trigger === null
                ? 'not recorded'
                : `${slugLabel(chain.input.trigger.kind)}${
                    chain.input.trigger.label === null ? '' : ` — ${chain.input.trigger.label}`
                  }`}
            </p>
            {inputObservation === null ? (
              <p className="aurum-explain-row-foot">
                No triggering observation sits beneath the trigger (or it is restricted).
              </p>
            ) : inputObservation.unreadable ? (
              <p className="aurum-explain-row-foot">
                The triggering observation is restricted — its position on the chain is
                shown, its content is not.
              </p>
            ) : (
              <ul className="aurum-explain-list">
                <EvidenceRow
                  row={{
                    id: inputObservation.id,
                    unreadable: false,
                    kind: inputObservation.kind,
                    observedAt: inputObservation.observedAt,
                    recordedAt: inputObservation.recordedAt,
                    channel: inputObservation.channel,
                    sourceLabel: inputObservation.sourceLabel,
                    sourceId: null,
                    confidence: inputObservation.confidenceValue,
                    payload: payloadSummary(inputObservation.payload),
                    extractor: inputObservation.extractor,
                    freshness: null,
                  }}
                />
              </ul>
            )}
          </>
        )}
      </Panel>

      {/* 2 — Evidence */}
      <Panel
        title="2 · Evidence — the observations this decision rests on"
        blurb={causalHint('evidence')}
        meta={<StatusPill tone={present('evidence') ? 'positive' : 'neutral'}>{count('evidence')} observation(s)</StatusPill>}
      >
        {!present('evidence') ? (
          <LinkAbsent stage="evidence" />
        ) : view.evidenceRows.length === 0 ? (
          <EmptyState
            title="No readable observations"
            hint="Every observation this decision cites is restricted for your session."
          />
        ) : (
          <>
            <ul className="aurum-explain-list">
              {view.evidenceRows.map((row) => (
                <EvidenceRow key={row.id} row={row} />
              ))}
            </ul>
            {chain.evidence.knowledge.length === 0 && chain.evidence.transactive.length === 0 ? null : (
              <p className="aurum-explain-row-foot">
                The cycle also consulted {chain.evidence.knowledge.length} knowledge
                entr(ies) and {chain.evidence.transactive.length} transactive-memory
                relation(s) — organizational memory is part of the evidence base.
              </p>
            )}
          </>
        )}
      </Panel>

      {/* 3 — Source reliability & freshness (the source-selection link) */}
      <Panel
        title="3 · Sources — reliability & freshness"
        blurb="Which registered sources supplied the evidence, whether they are connected, and how fresh their streams are — the reliability signals the company actually records (status, freshness classification, latency)."
      >
        {view.sources.length === 0 ? (
          <EmptyState
            title="No registered sources on this chain"
            hint="The evidence above cites label-only sources (or none) — register a source in Connections and its reliability and freshness become part of every reconstruction."
          />
        ) : (
          <ul className="aurum-explain-list">
            {view.sources.map((row) => (
              <SourceRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Panel>

      {/* 4 — Contradictions (lock 12) */}
      <Panel
        title="4 · Conflicting evidence — retained, never merged away"
        blurb="Where the evidence beneath this decision disagrees with itself: both sides of every retained conflict, the respect in which they conflict, and — once weighed — how the conflict was resolved without erasing either side."
        meta={
          <StatusPill tone={view.contradictions.some((row) => row.status !== 'resolved') ? 'warning' : 'positive'}>
            {view.contradictions.length} conflict(s)
          </StatusPill>
        }
      >
        {view.contradictions.length === 0 ? (
          <EmptyState
            title="No retained conflicts on this evidence"
            hint="When two pieces of evidence disagree, the conflict is recorded with both sides — it never disappears into the conclusion."
          />
        ) : (
          <ul className="aurum-explain-list">
            {view.contradictions.map((row) => (
              <ContradictionRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Panel>

      {/* 5 — Claims & beliefs */}
      <Panel
        title="5 · Claims & beliefs — what was derived and concluded"
        blurb={causalHint('claims-beliefs')}
        meta={<StatusPill tone={present('claims-beliefs') ? 'positive' : 'neutral'}>{count('claims-beliefs')} item(s)</StatusPill>}
      >
        {!present('claims-beliefs') ? (
          <LinkAbsent stage="claims & beliefs" />
        ) : (
          <>
            {chain.claimsBeliefs.claims.length === 0 ? (
              <p className="aurum-explain-row-foot">No claims were derived this cycle.</p>
            ) : (
              <ul className="aurum-explain-list">
                {chain.claimsBeliefs.claims.map((claim) => (
                  <li key={claim.id} className="aurum-explain-row">
                    <div className="aurum-explain-row-head">
                      <span className="aurum-explain-row-title">Claim</span>
                      <span className="aurum-explain-row-meta">
                        confidence {percent(claim.confidenceValue)} · cites{' '}
                        {claim.evidenceObservationIds.length} observation(s)
                      </span>
                    </div>
                    <p className="aurum-explain-row-text">{claim.proposition}</p>
                  </li>
                ))}
              </ul>
            )}
            {chain.claimsBeliefs.beliefs.length === 0 ? (
              <p className="aurum-explain-row-foot">No belief was formed or revised this cycle.</p>
            ) : (
              <ul className="aurum-explain-list">
                {chain.claimsBeliefs.beliefs.map((belief) => (
                  <li key={`${belief.id}-${belief.version}`} className="aurum-explain-row">
                    <div className="aurum-explain-row-head">
                      <span className="aurum-explain-row-title">
                        Belief v{belief.version}
                      </span>
                      <StatusPill tone={beliefStatusTone(belief.status)}>
                        {beliefStatusLabel(belief.status)}
                      </StatusPill>
                      <span className="aurum-explain-row-meta">
                        confidence {percent(belief.confidenceValue)}
                      </span>
                    </div>
                    <p className="aurum-explain-row-text">{belief.proposition}</p>
                    {belief.alternatives.length === 0 ? null : (
                      <p className="aurum-explain-row-foot">
                        Alternative explanations kept: {belief.alternatives.join(' · ')}
                      </p>
                    )}
                    <p className="aurum-explain-row-foot">
                      Valid from {dateTimeLabel(belief.validFrom)} — understanding is
                      versioned, history is never rewritten.
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>

      {/* 6 — Unknown & mission */}
      <Panel
        title="6 · Unknown & mission — the gap and the learning launched for it"
        blurb={causalHint('unknown-mission')}
        meta={<StatusPill tone={present('unknown-mission') ? 'positive' : 'neutral'}>{count('unknown-mission')} item(s)</StatusPill>}
      >
        {!present('unknown-mission') ? (
          <LinkAbsent stage="unknown & mission" />
        ) : (
          <>
            {chain.unknownMission.unknowns.length === 0 ? (
              <p className="aurum-explain-row-foot">No unknown was raised this cycle.</p>
            ) : (
              <ul className="aurum-explain-list">
                {chain.unknownMission.unknowns.map((unknown) => (
                  <li key={unknown.id} className="aurum-explain-row">
                    <div className="aurum-explain-row-head">
                      <Link
                        className="aurum-explain-row-title"
                        href={view.links.unknown(unknown.id)}
                      >
                        {unknown.question}
                      </Link>
                      <StatusPill tone={unknown.status === 'open' ? 'warning' : 'positive'}>
                        {unknown.status === 'open' ? 'Open' : 'Resolved'}
                      </StatusPill>
                    </div>
                    <p className="aurum-explain-row-text">
                      Why it matters: {unknown.consequence}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {chain.unknownMission.missions.length === 0 ? (
              <p className="aurum-explain-row-foot">No learning mission was launched this cycle.</p>
            ) : (
              <ul className="aurum-explain-list">
                {chain.unknownMission.missions.map((mission) => (
                  <li key={mission.id} className="aurum-explain-row">
                    <div className="aurum-explain-row-head">
                      <Link className="aurum-explain-row-title" href={view.links.missionBase}>
                        {mission.title}
                      </Link>
                      <MissionProgress
                        current={mission.currentConfidence}
                        target={mission.targetConfidence}
                        achieved={mission.achievedConfidence}
                      />
                      <span className="aurum-explain-row-meta">{mission.status}</span>
                    </div>
                    <p className="aurum-explain-row-text">{mission.knowledgeObjective}</p>
                    {mission.acquisition === null ? null : (
                      <p className="aurum-explain-row-foot">
                        Source selection: the acquisition{' '}
                        {mission.acquisition.completed ? 'completed' : 'in progress'}
                        {mission.acquisition.outcomeKind === null
                          ? ''
                          : ` (${slugLabel(mission.acquisition.outcomeKind)})`}
                        {mission.acquisition.confidence === null
                          ? ''
                          : ` — confidence ${(mission.acquisition.confidence.from * 100).toFixed(0)}% → ${(mission.acquisition.confidence.to * 100).toFixed(0)}%`}
                        .
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>

      {/* 7 — Model & provider */}
      <Panel
        title="7 · Model & provider — who extracted the evidence"
        blurb={causalHint('model-provider')}
        meta={<StatusPill tone={present('model-provider') ? 'positive' : 'neutral'}>{chain.modelProvider.extractors.length} extractor(s)</StatusPill>}
      >
        {!present('model-provider') ? (
          <LinkAbsent stage="model & provider" />
        ) : (
          <ul className="aurum-explain-list">
            {chain.modelProvider.extractors.map((extractor) => (
              <li
                key={`${extractor.provider}:${extractor.model}`}
                className="aurum-explain-row"
              >
                <div className="aurum-explain-row-head">
                  <span className="aurum-explain-row-title">
                    {extractor.provider} / {extractor.model}
                  </span>
                  <span className="aurum-explain-row-meta">
                    extracted {extractor.observationIds.length} observation(s)
                  </span>
                </div>
                <p className="aurum-explain-row-foot">
                  Provider-neutral attribution from the LLM gateway — no provider is
                  architecturally privileged, and no model output is authoritative merely
                  because a model produced it.
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 8 — Policy evaluation */}
      <Panel
        title="8 · Policy — the rules that governed the decision"
        blurb={causalHint('policy')}
        meta={
          <StatusPill tone={present('policy') ? 'positive' : 'neutral'}>
            {present('policy') ? 'Evaluated' : 'Absent'}
          </StatusPill>
        }
      >
        {chain.policy.authorityEvaluation === null ? (
          chain.recommendation.actionRequest === null ? (
            <EmptyState
              title="No action was proposed"
              hint="Nothing reached the authority gate — no policy evaluation applies to this decision."
            />
          ) : (
            <LinkAbsent stage="policy" />
          )
        ) : (
          <>
            <div className="aurum-explain-row">
              <div className="aurum-explain-row-head">
                <span className="aurum-explain-row-title">
                  {slugLabel(chain.policy.authorityEvaluation.actionKind)}
                </span>
                <StatusPill tone={gateTone(chain.policy.authorityEvaluation.outcome)}>
                  {gateLabel(chain.policy.authorityEvaluation.outcome)}
                </StatusPill>
                <span className="aurum-explain-row-meta">
                  authority {chain.policy.authorityEvaluation.authorityLevel}
                </span>
              </div>
              <p className="aurum-explain-row-text">
                Resolved via {slugLabel(chain.policy.authorityEvaluation.resolvedVia)}
                {chain.policy.authorityEvaluation.policyNote === null
                  ? ''
                  : ` — ${chain.policy.authorityEvaluation.policyNote}`}
                .
              </p>
              <p className="aurum-explain-row-foot">
                The deterministic authority-matrix evaluation recorded on the request at
                gate time — learning can suggest, policy decides.
              </p>
            </div>
            {chain.policy.events.length === 0 ? null : (
              <>
                <h3 className="aurum-explain-subhead">Policy-stage audit events</h3>
                <ul className="aurum-explain-list">
                  {chain.policy.events.map((event) => (
                    <AuditRow
                      key={event.id}
                      event={event.event}
                      stageLabel="Policy"
                      summary={event.summary}
                      recordedAt={event.recordedAt}
                      href={null}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Panel>

      {/* 9 — Recommendation */}
      <Panel
        title="9 · Recommendation — what Aurum proposed"
        blurb={causalHint('recommendation')}
        meta={
          <StatusPill tone={present('recommendation') ? 'positive' : 'neutral'}>
            {present('recommendation') ? 'Proposed' : 'Nothing proposed'}
          </StatusPill>
        }
      >
        {chain.recommendation.actionRequest === null ? (
          <EmptyState
            title="No consequential action was proposed"
            hint="This decision concluded without routing an action through the authority gate."
          />
        ) : (
          (() => {
            const request = chain.recommendation.actionRequest;
            return (
              <div className="aurum-explain-row">
                <div className="aurum-explain-row-head">
                  <Link
                    className="aurum-explain-row-title"
                    href={anchorHref('action-request', request.id)}
                  >
                    {slugLabel(request.actionKind)}
                  </Link>
                  <StatusPill tone={requestStatusTone(request.status)}>
                    {requestStatusLabel(request.status)}
                  </StatusPill>
                  <span className="aurum-explain-row-meta">
                    authority {request.authorityLevel}
                  </span>
                </div>
                {request.justification === null ? null : (
                  <p className="aurum-explain-row-text">{request.justification}</p>
                )}
                <p className="aurum-explain-row-text">
                  Payload: <code className="aurum-mono">{payloadSummary(request.payload, 220)}</code>
                </p>
                <p className="aurum-explain-row-foot">
                  Requested {dateTimeLabel(request.requestedAt)} by{' '}
                  {slugLabel(request.requestedBy)}.
                </p>
              </div>
            );
          })()
        )}
      </Panel>

      {/* 10 — Approval record */}
      <Panel
        title="10 · Approval — who decided, and when"
        blurb={causalHint('approval')}
        meta={
          <StatusPill tone={chain.approval.decisions.length > 0 ? 'positive' : 'neutral'}>
            {chain.approval.decisions.length} decision(s)
          </StatusPill>
        }
      >
        {chain.approval.decisions.length === 0 ? (
          <EmptyState
            title="Nothing was gated by a human decision"
            hint="Either no action was proposed, or policy allowed it without requiring approval."
          />
        ) : (
          <ul className="aurum-explain-list">
            {chain.approval.decisions.map((decision) => (
              <li key={decision.id} className="aurum-explain-row">
                <div className="aurum-explain-row-head">
                  <span className="aurum-explain-row-title">
                    {slugLabel(decision.decision)}
                  </span>
                  <StatusPill tone={decision.decision === 'approved' ? 'positive' : 'error'}>
                    {decision.decision === 'approved' ? 'Approved' : 'Rejected'}
                  </StatusPill>
                  <span className="aurum-explain-row-meta">
                    decided by{' '}
                    {decision.decidedBy === 'policy' ? 'policy (automatic)' : 'a human'}
                  </span>
                </div>
                {decision.note === null ? null : (
                  <p className="aurum-explain-row-text">{decision.note}</p>
                )}
                <p className="aurum-explain-row-foot">
                  {dateTimeLabel(decision.decidedAt)} — the append-only decision trail;
                  decisions are never overwritten.
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 11 — Execution */}
      <Panel
        title="11 · Execution — the cycles that carried the decision"
        blurb={causalHint('execution')}
        meta={
          <StatusPill tone={chain.execution.executions.length > 0 || chain.execution.directAuthorization ? 'positive' : 'neutral'}>
            {chain.execution.executions.length} cycle(s)
            {chain.execution.directAuthorization ? ' · direct authorization' : ''}
          </StatusPill>
        }
      >
        {chain.execution.executions.length === 0 ? (
          chain.execution.directAuthorization ? (
            <EmptyState
              title="Authorized directly, outside a decision cycle"
              hint="A principal requested this action through the gate itself — no cognitive execution carried it."
            />
          ) : (
            <LinkAbsent stage="execution" />
          )
        ) : (
          <ul className="aurum-explain-list">
            {chain.execution.executions.map((execution) => (
              <li key={execution.id} className="aurum-explain-row">
                <div className="aurum-explain-row-head">
                  <Link
                    className="aurum-explain-row-title"
                    href={anchorHref('execution', execution.id)}
                  >
                    {execution.trigger.label ?? slugLabel(execution.trigger.kind)}
                  </Link>
                  <StatusPill tone={executionStateTone(execution.state)}>
                    {executionStateLabel(execution.state)}
                  </StatusPill>
                  <span className="aurum-explain-row-meta">
                    {execution.completedStages}/12 stages
                  </span>
                </div>
                <p className="aurum-explain-row-foot">
                  Started {dateTimeLabel(execution.createdAt)} by{' '}
                  {slugLabel(execution.actor.kind)}
                  {execution.completedAt === null
                    ? ''
                    : ` · completed ${dateTimeLabel(execution.completedAt)}`}
                  .
                </p>
                {execution.rationale === null ? null : (
                  <p className="aurum-explain-row-text">{execution.rationale}</p>
                )}
                {execution.abandonment === null ? null : (
                  <p className="aurum-explain-row-foot">
                    Abandoned: {execution.abandonment.reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 12 — Result */}
      <Panel
        title="12 · Result — what the gate produced"
        blurb={causalHint('result')}
        meta={
          chain.result.gate === null ? (
            <StatusPill tone="neutral">No gate</StatusPill>
          ) : (
            <StatusPill tone={gateTone(chain.result.gate)}>{gateLabel(chain.result.gate)}</StatusPill>
          )
        }
      >
        {chain.result.gate === null ? (
          <EmptyState
            title="Nothing reached the authority gate"
            hint="This decision proposed no action, so no gate outcome exists."
          />
        ) : (
          <div className="aurum-explain-row">
            <div className="aurum-explain-row-head">
              <span className="aurum-explain-row-title">
                {chain.result.resolution === null
                  ? 'Awaiting its resolution'
                  : chain.result.resolution === 'approved'
                    ? 'Approved — released'
                    : 'Rejected — refused'}
              </span>
              {chain.result.requestStatus === null ? null : (
                <StatusPill tone={requestStatusTone(chain.result.requestStatus)}>
                  {requestStatusLabel(chain.result.requestStatus)}
                </StatusPill>
              )}
            </div>
            <p className="aurum-explain-row-foot">
              {chain.result.decidedAt === null
                ? 'The deciding decision has not landed yet.'
                : `Decided ${dateTimeLabel(chain.result.decidedAt)}.`}
            </p>
          </div>
        )}
      </Panel>

      {/* 13 — Outcome */}
      <Panel
        title="13 · Outcome — what the cycle recorded as its result"
        blurb={causalHint('outcome')}
        meta={<StatusPill tone={present('outcome') ? 'positive' : 'neutral'}>{chain.outcome.outcomes.length} outcome(s)</StatusPill>}
      >
        {!present('outcome') ? (
          <LinkAbsent stage="outcome" />
        ) : (
          <ul className="aurum-explain-list">
            {chain.outcome.outcomes.map((outcome) => (
              <li key={`${outcome.executionId}-${outcome.recordedAt}`} className="aurum-explain-row">
                <div className="aurum-explain-row-head">
                  <span className="aurum-explain-row-title">
                    {slugLabel(outcome.kind)}
                  </span>
                  {outcome.actionRequestId === null ? null : (
                    <Link
                      className="aurum-explain-row-meta"
                      href={anchorHref('action-request', outcome.actionRequestId)}
                    >
                      its action request
                    </Link>
                  )}
                </div>
                <p className="aurum-explain-row-text">{outcome.summary}</p>
                {outcome.recordedAt === null ? null : (
                  <p className="aurum-explain-row-foot">
                    Recorded {dateTimeLabel(outcome.recordedAt)}.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 14 — Learning update */}
      <Panel
        title="14 · Learning — what was durably learned"
        blurb={causalHint('learning')}
        meta={<StatusPill tone={present('learning') ? 'positive' : 'neutral'}>{count('learning')} entr(ies)</StatusPill>}
      >
        {!present('learning') ? (
          <LinkAbsent stage="learning" />
        ) : (
          <ul className="aurum-explain-list">
            {chain.learning.knowledge.map((entry) => (
              <li key={entry.id} className="aurum-explain-row">
                <div className="aurum-explain-row-head">
                  <span className="aurum-explain-row-title">{entry.title}</span>
                  <span className="aurum-explain-row-meta">
                    {slugLabel(entry.kind)} · cites {entry.evidenceObservationIds.length}{' '}
                    observation(s)
                  </span>
                </div>
                <p className="aurum-explain-row-text">{entry.summary}</p>
                {entry.topics.length === 0 ? null : (
                  <p className="aurum-explain-row-foot">Topics: {entry.topics.join(' · ')}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 15 — The audit history of this decision */}
      <Panel
        title="The audit history of this decision"
        blurb="Every consequential event recorded about this decision's executions, action request or flow — the append-only trail beneath the chain."
      >
        {view.auditRecords.length === 0 ? (
          <EmptyState
            title="No audit events for this decision yet"
            hint="Policy changes, approvals and other consequential events attach here as they are recorded."
          />
        ) : (
          <ul className="aurum-explain-list">
            {view.auditRecords.map((event) => (
              <AuditRow
                key={event.id}
                event={event.event}
                stageLabel={slugLabel(event.chainStage)}
                summary={event.summary}
                recordedAt={event.recordedAt}
                href={null}
              />
            ))}
          </ul>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — the chain above may be missing freshness, source or contradiction detail. Retry in a moment.`}
          retryHref={anchorHref(view.anchorKind, view.anchorId)}
        />
      )}
    </>
  );
}
