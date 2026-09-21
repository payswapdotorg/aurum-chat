// Capability, workforce & agent interventions (W063) — one agent's
// lifecycle detail page (the measured evaluation, the
// retain/modify/terminate decisions, the tied outcomes).
//
// THE WORK ITEM'S LIFECYCLE CLAUSES, in one navigable page:
//   * THE MEASUREMENT — the agent's latest evaluation, all six
//     dimensions the work item names (outcome, cost, quality,
//     utilization, security — plus the replacement options each
//     assessed and compared against the measured window cost);
//   * RETAIN / MODIFY / TERMINATE — the lifecycle decision form
//     (always following a measured evaluation; terminating routes
//     through the authority gate, and the settle pump applies the
//     decided termination — the agent definition is disabled through
//     the agents contract);
//   * OUTCOME TRACKING — the learning outcomes tied to this agent as
//     their subject: expected versus realized, with the deterministic
//     met/exceeded/missed verdict.
//
// The page is a read of the agents/agent-evaluation/learning contracts
// plus this surface's write affordances (lib/workflow.ts) — no second
// source of truth. A missing/foreign agent renders the honest
// not-found state. Nothing here terminates a HUMAN — the employment
// note stays visible (lock 21).

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../../../components/states';
import { buildAgentView } from '../../lib/views';
import type { AgentView } from '../../lib/views';
import {
  GATE_NOTE,
  HUMAN_AUTHORIZED_NOTE,
  dateLabel,
  decisionStatusLabel,
  decisionStatusTone,
  lifecycleChangeLabel,
  moneyLabel,
  outcomeStatusLabel,
  outcomeStatusTone,
  percentLabel,
  replacementKindLabel,
} from '../../lib/labels';
import { AgentLifecycleForm } from '../../components/agent-lifecycle-form';
import { SettleButton } from '../../components/settle-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Agent lifecycle — Interventions — Aurum',
  description:
    'One agent’s measured evaluation, its retain/modify/terminate lifecycle and the outcomes tied to it.',
};

export default async function AgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const session = await requireAuthenticatedPage();

  let view: AgentView;
  try {
    view = await buildAgentView(session.context, agentId);
  } catch {
    notFound();
  }

  const agent = view.agent;
  const evaluation = view.evaluation;

  return (
    <>
      <PageHead
        title={agent.displayName ?? agent.slug}
        description="One organizational agent — what it is contracted to do, how it measures, and the lifecycle decisions that govern it."
        meta={
          <>
            <StatusPill tone={agent.status === 'active' ? 'positive' : 'neutral'}>
              {agent.status}
            </StatusPill>{' '}
            · {agent.provider} · scopes {agent.permissions.join(' / ')}
          </>
        }
      />

      <p className="aurum-intel-row-text" style={{ marginBottom: 12 }}>
        {agent.role}
      </p>
      <p className="aurum-intel-row-foot" style={{ marginBottom: 18 }}>
        <Link className="aurum-learn-link" href="/interventions">
          ← All interventions
        </Link>
      </p>

      {/* The measurement (the six dimensions). */}
      <Panel
        title="The measured evaluation"
        blurb="The latest evidence snapshot — outcome, cost, quality, utilization and security, computed from authoritative module state, never caller-supplied. Replacement options are compared against the measured window cost."
        meta={
          evaluation === null
            ? undefined
            : <>
                measured {dateLabel(evaluation.recordedAt)} · window{' '}
                {dateLabel(evaluation.windowFrom)} → {dateLabel(evaluation.windowTo)}
              </>
        }
      >
        {evaluation === null ? (
          <EmptyState
            title="No evaluation yet"
            hint="An evaluation freezes the agent’s measured performance — record one from the evaluation surface, then decide its lifecycle here."
          />
        ) : (
          <>
            <ul className="aurum-intel-list">
              <li className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">Outcome</span>
                  <StatusPill
                    tone={
                      evaluation.outcome.missed > evaluation.outcome.met ? 'warning' : 'neutral'
                    }
                  >
                    {evaluation.outcome.settled} settled · {evaluation.outcome.open} open
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {evaluation.outcome.outcomesTotal} outcomes tied to this agent ·{' '}
                  {evaluation.outcome.met} met · {evaluation.outcome.exceeded} exceeded ·{' '}
                  {evaluation.outcome.missed} missed · net variance vs expected{' '}
                  {evaluation.outcome.netVarianceVsExpected}
                </p>
              </li>
              <li className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">Cost</span>
                  <StatusPill tone="neutral">
                    {moneyLabel(evaluation.cost.totalCostMinor, evaluation.cost.costCurrency)}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {evaluation.cost.executionsIncluded} executions
                  {evaluation.cost.executionsTruncated ? ' (list truncated — older exist)' : ''} ·{' '}
                  {evaluation.cost.attemptsIncluded} attempts ·{' '}
                  {evaluation.cost.costPerSucceededMinor === null
                    ? 'no succeeded execution to average'
                    : `${moneyLabel(evaluation.cost.costPerSucceededMinor, evaluation.cost.costCurrency)} per succeeded execution`}
                </p>
              </li>
              <li className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">Quality</span>
                  <StatusPill
                    tone={
                      evaluation.quality.successRate !== null && evaluation.quality.successRate < 0.5
                        ? 'warning'
                        : 'neutral'
                    }
                  >
                    {evaluation.quality.successRate === null
                      ? 'nothing terminated yet'
                      : `${percentLabel(evaluation.quality.successRate)} success`}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {evaluation.quality.succeeded} succeeded · {evaluation.quality.failed} failed ·{' '}
                  {evaluation.quality.refused} refused · {evaluation.quality.cancelled} cancelled ·{' '}
                  {evaluation.quality.averageLatencyMs === null
                    ? 'no latency measured'
                    : `mean latency ${evaluation.quality.averageLatencyMs} ms`}
                </p>
              </li>
              <li className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">Utilization</span>
                  <StatusPill tone="neutral">{evaluation.utilization.submissions} submissions</StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {evaluation.utilization.live} still live ·{' '}
                  {evaluation.utilization.distinctPrincipals} distinct principals ·{' '}
                  {evaluation.utilization.distinctActiveDays} active days ·{' '}
                  {evaluation.utilization.submissionsPerDay} per day
                </p>
              </li>
              <li className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">Security</span>
                  <StatusPill tone={evaluation.security.findingsCount === 0 ? 'positive' : 'warning'}>
                    {evaluation.security.findingsCount === 0
                      ? 'clean bill'
                      : `${evaluation.security.findingsCount} finding${evaluation.security.findingsCount === 1 ? '' : 's'}`}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  Granted scopes {evaluation.security.grantedPermissions.join(' / ') || 'none'} ·{' '}
                  {evaluation.security.overGrantedScopes.length === 0
                    ? 'no over-granted scope'
                    : `over-granted: ${evaluation.security.overGrantedScopes.join(' / ')}`}{' '}
                  · {evaluation.security.approvalGated} approval-gated ·{' '}
                  {evaluation.security.policyRefusals} policy refusals
                </p>
              </li>
            </ul>
            {evaluation.replacementOptions.length === 0 ? null : (
              <>
                <p className="aurum-learn-hint" style={{ marginTop: 12 }}>
                  The replacement options this evaluation compared (the §13 vocabulary mirrored on
                  the termination side), each against the measured window cost:
                </p>
                <ul className="aurum-intel-list">
                  {evaluation.replacementOptions.map((option) => (
                    <li className="aurum-intel-row" key={option.id}>
                      <div className="aurum-intel-row-head">
                        <span className="aurum-intel-row-title">
                          {replacementKindLabel(option.kind)}
                          {option.recommended ? ' — recommended' : ''}
                        </span>
                        {option.recommended ? <StatusPill tone="positive">Recommended</StatusPill> : null}
                      </div>
                      <p className="aurum-intel-row-text">{option.summary}</p>
                      <p className="aurum-intel-row-foot">
                        {option.estimatedCostMinor === null || option.estimatedCostCurrency === null
                          ? 'cost unknown'
                          : moneyLabel(option.estimatedCostMinor, option.estimatedCostCurrency)}
                        {option.costDeltaMinor === null
                          ? ''
                          : option.costDeltaMinor >= 0
                            ? ` · +${moneyLabel(option.costDeltaMinor, option.estimatedCostCurrency ?? 'USD')} vs measured window`
                            : ` · saves ${moneyLabel(Math.abs(option.costDeltaMinor), option.estimatedCostCurrency ?? 'USD')} vs measured window`}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Panel>

      {/* The lifecycle decisions (retain/modify/terminate). */}
      <Panel
        title="Lifecycle decisions"
        blurb="Every decision follows from a measured evaluation. Retain and modify are recorded management evidence; terminating routes through the authority gate — no agent is terminated without an explicit human decision, and the settle pump applies the decided one."
        meta={<>{view.decisions.length} decision{view.decisions.length === 1 ? '' : 's'}</>}
      >
        {evaluation !== null && agent.status === 'active' ? (
          <>
            <p className="aurum-learn-hint" style={{ marginBottom: 10 }}>
              Decide this agent’s lifecycle from the measured evaluation above:
            </p>
            <AgentLifecycleForm
              agentId={agent.id}
              evaluationId={evaluation.id}
              replacementOptions={evaluation.replacementOptions}
            />
          </>
        ) : evaluation === null ? (
          <EmptyState
            title="No decision without evidence"
            hint="A lifecycle decision always cites a measured evaluation — record one first."
          />
        ) : (
          <EmptyState
            title="This agent is disabled"
            hint="A disabled agent accepts no new executions; its recorded history stays as evidence."
          />
        )}
        {view.decisions.length === 0 ? null : (
          <ul className="aurum-intel-list" style={{ marginTop: 12 }}>
            {view.decisions.map((decision) => (
              <li className="aurum-intel-row" key={decision.id}>
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    {lifecycleChangeLabel(decision.change)}
                  </span>
                  <StatusPill tone={decisionStatusTone(decision.status)}>
                    {decisionStatusLabel(decision.status)}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-text">{decision.rationale}</p>
                <p className="aurum-intel-row-foot">
                  {decision.modificationSummary === null
                    ? ''
                    : `Modifies: ${decision.modificationSummary} · `}
                  recorded {dateLabel(decision.recordedAt)}
                  {decision.appliedAt === null ? '' : ` · applied ${dateLabel(decision.appliedAt)}`}
                </p>
                {decision.actionRequestId === null ? null : (
                  <p className="aurum-intel-row-foot">
                    Gate request{' '}
                    <Link className="aurum-learn-link" href="/approvals">
                      {decision.actionRequestId.slice(0, 8)}
                    </Link>
                    {decision.status === 'awaiting_approval' || decision.status === 'approved' ? (
                      <>
                        {' '}
                        holds or has decided the termination — apply it below once approved.
                      </>
                    ) : null}
                  </p>
                )}
                {decision.status === 'awaiting_approval' || decision.status === 'approved' ? (
                  <div style={{ marginTop: 8 }}>
                    <SettleButton decisionId={decision.id} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="aurum-learn-separation" role="note" style={{ marginTop: 12 }}>
          {GATE_NOTE}
        </p>
      </Panel>

      {/* Outcome tracking. */}
      <Panel
        title="Tied outcomes"
        blurb="The measurable outcomes this agent is the subject of — the expected value frozen at definition, the realized value grounded in a measurement."
        meta={<>{view.outcomes.length} outcome{view.outcomes.length === 1 ? '' : 's'}</>}
      >
        {view.outcomes.length === 0 ? (
          <EmptyState
            title="No outcomes tied to this agent"
            hint="Outcome measurement ties agents to measurable metrics — the expected value is a prediction frozen before realization."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.outcomes.map((outcome) => (
              <li className="aurum-intel-row" key={outcome.id}>
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    {outcome.metricName} ({outcome.metricUnit})
                  </span>
                  <StatusPill tone={outcomeStatusTone(outcome.status)}>
                    {outcomeStatusLabel(outcome.status)}
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  expected {outcome.expected} ·{' '}
                  {outcome.realized === null
                    ? 'not yet realized'
                    : `realized ${outcome.realized}${
                        outcome.assessment === null ? '' : ` — ${outcome.assessment}`
                      }`}{' '}
                  · defined {dateLabel(outcome.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="aurum-learn-separation" role="note">
        {HUMAN_AUTHORIZED_NOTE}
      </p>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref={`/interventions/agents/${agent.id}`}
        />
      )}
    </>
  );
}
