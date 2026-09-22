// Capability, workforce & agent interventions (W063) — one recruitment
// proposal's detail page (the comparison, the approval, the
// activation).
//
// THE WORK ITEM'S FIRST HALF, in one navigable page:
//   * COMPARE — every alternative of the proposal in canonical order,
//     on the same dimensions (cost, weeks to impact, expected level and
//     capacity contribution), the recommended one marked; a 'recruit'
//     alternative shows the permission scopes the proposed agent would
//     be granted and the §20 authority level they imply — the future
//     grant visible at decision time;
//   * EXPLICIT UNCERTAINTY AND EVIDENCE — the capability snapshot the
//     proposal froze at creation (the gap classification and numbers it
//     was computed against) and the cited evidence observations, linked
//     into the Evidence surface;
//   * PROPOSAL → APPROVAL → ACTIVATION — the human decision form while
//     the proposal waits at the gate; the activation form once approved
//     (the recruit alternative registers the agent with its proposed
//     scopes).
//
// The page is a read of the agent-recruitment contract plus this
// surface's write affordances (lib/workflow.ts) — no second source of
// truth. A missing/foreign proposal renders the honest not-found state.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, PageHead, Panel, StatusPill } from '../../../components/states';
import { ChatReturnLink, chatReturnFromSearchParams } from '../../../chat/components/chat-return-link';
import { withChatReturn } from '../../../chat/lib/chat-types';
import type { PageSearchParams } from '../../../lib/context';
import { buildProposalView } from '../../lib/views';
import type { ProposalAlternativeRow, ProposalView } from '../../lib/views';
import {
  GATE_NOTE,
  alternativeKindLabel,
  dateLabel,
  moneyLabel,
  percentLabel,
  proposalStatusLabel,
  proposalStatusTone,
  weeksLabel,
} from '../../lib/labels';
import { ProposalDecisionForm } from '../../components/proposal-decision-form';
import { AgentActivationForm } from '../../components/agent-activation-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Recruitment proposal — Interventions — Aurum',
  description:
    'One capability-gap acquisition comparison — the alternatives, the evidence, the human approval and the activation.',
};

function AlternativeRowView({ alternative }: { alternative: ProposalAlternativeRow }) {
  return (
    <li className="aurum-intel-row aurum-int-compare-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">
          {alternativeKindLabel(alternative.kind)}
          {alternative.recommended ? ' — recommended' : ''}
        </span>
        {alternative.recommended ? <StatusPill tone="positive">Recommended</StatusPill> : null}
      </div>
      <p className="aurum-intel-row-text">{alternative.summary}</p>
      {alternative.note === null ? null : (
        <p className="aurum-intel-row-foot">Note: {alternative.note}</p>
      )}
      <p className="aurum-intel-row-foot">
        {alternative.estimatedCostMinor === null || alternative.estimatedCostCurrency === null
          ? 'cost unknown'
          : moneyLabel(alternative.estimatedCostMinor, alternative.estimatedCostCurrency)}{' '}
        · {weeksLabel(alternative.estimatedWeeks)} ·{' '}
        {alternative.expectedLevel === null
          ? 'level contribution unknown'
          : `+${percentLabel(alternative.expectedLevel)} level`}
        {alternative.expectedCapacity === null
          ? ''
          : ` · +${alternative.expectedCapacity} capacity`}
      </p>
      {alternative.agentPermissions === null ? null : (
        <p className="aurum-intel-row-foot">
          Proposed agent scopes: {alternative.agentPermissions.join(' / ')}
          {alternative.impliedAuthorityLevel === null
            ? ''
            : ` — implies ${alternative.impliedAuthorityLevel} authority (the gate reviews every execution)`}
        </p>
      )}
    </li>
  );
}

export default async function ProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ proposalId: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { proposalId } = await params;
  // W072/W074 — the guarded return link when the proposal was opened
  // from a chat recommendation card (`?back=/chat?c=…`): the manager
  // jumps into the deep comparison and always keeps the way back to
  // the thread where the recommendation arrived.
  const search = await searchParams;
  const back = chatReturnFromSearchParams(search);
  const session = await requireAuthenticatedPage();

  let view: ProposalView;
  try {
    view = await buildProposalView(session.context, proposalId);
  } catch {
    notFound();
  }

  const proposal = view.proposal;
  const awaiting = proposal.status === 'awaiting_approval' && proposal.approval.actionRequestId !== null;

  return (
    <>
      <PageHead
        title={proposal.title}
        description={`The compared ways to close the ${proposal.capability.name} gap — cost, timeline and expected contribution per alternative, decided by a human.`}
        meta={
          <>
            <ChatReturnLink back={back} />{' '}
            <StatusPill tone={proposalStatusTone(proposal.status)}>
              {proposalStatusLabel(proposal.status)}
            </StatusPill>{' '}
            · proposed {dateLabel(proposal.createdAt)} · updated {dateLabel(proposal.updatedAt)}
          </>
        }
      />

      <p className="aurum-intel-row-text" style={{ marginBottom: 14 }}>
        {proposal.rationale}
      </p>
      <p className="aurum-intel-row-foot" style={{ marginBottom: 18 }}>
        <Link
          className="aurum-learn-link"
          href={withChatReturn('/interventions', back)}
        >
          ← All interventions
        </Link>
      </p>

      {/* The comparison. */}
      <Panel
        title="The compared alternatives"
        blurb="Every acquisition channel the proposal compared, on the same dimensions. The recommended alternative is the proposer’s, not the decision — the human decides."
        meta={<>{view.alternatives.length} alternative{view.alternatives.length === 1 ? '' : 's'}</>}
      >
        <ul className="aurum-intel-list aurum-int-compare">
          {view.alternatives.map((alternative) => (
            <AlternativeRowView key={alternative.id} alternative={alternative} />
          ))}
        </ul>
      </Panel>

      {/* Explicit uncertainty and evidence. */}
      <Panel
        title="What this comparison was computed against"
        blurb="The decision-time snapshot — the capability’s gap classification and supply numbers when the proposal was recorded, and the evidence observations it cites."
      >
        <ul className="aurum-intel-list">
          <li className="aurum-intel-row">
            <div className="aurum-intel-row-head">
              <Link className="aurum-intel-row-title" href="/capabilities">
                {proposal.capability.name}
              </Link>
              <StatusPill tone={proposal.capability.gapStatus === 'covered' ? 'positive' : 'warning'}>
                {proposal.capability.gapStatus === null
                  ? 'no gap classification'
                  : proposal.capability.gapStatus.replace('_', ' ')}
              </StatusPill>
            </div>
            <p className="aurum-intel-row-foot">
              Best active level{' '}
              {proposal.capability.bestActiveLevel === null
                ? 'none'
                : percentLabel(proposal.capability.bestActiveLevel)}{' '}
              · total active capacity {proposal.capability.totalActiveCapacity ?? 'unknown'} ·
              capability {proposal.capability.status}
            </p>
          </li>
          <li className="aurum-intel-row">
            <div className="aurum-intel-row-head">
              <span className="aurum-intel-row-title">Cited evidence</span>
              <StatusPill tone={proposal.evidenceObservationIds.length === 0 ? 'neutral' : 'info'}>
                {proposal.evidenceObservationIds.length} observation
                {proposal.evidenceObservationIds.length === 1 ? '' : 's'}
              </StatusPill>
            </div>
            {proposal.evidenceObservationIds.length === 0 ? (
              <p className="aurum-intel-row-foot">
                No observations cited — the comparison rests on the capability snapshot alone.
              </p>
            ) : (
              <p className="aurum-intel-row-foot">
                {proposal.evidenceObservationIds.map((id) => (
                  <Link key={id} className="aurum-learn-link" href="/evidence">
                    {id.slice(0, 8)}
                  </Link>
                ))}
              </p>
            )}
          </li>
        </ul>
      </Panel>

      {/* The approval (the human authority gate). */}
      <Panel
        title="The approval"
        blurb="Acquiring capability is a consequential action — the authority gate holds it until an authorized human decides."
      >
        {proposal.approval.actionRequestId === null ? (
          <EmptyState
            title="Not yet submitted to the gate"
            hint="The comparison exists as a draft — submission is the proposer’s step, and this surface renders its outcome."
          />
        ) : (
          <ul className="aurum-intel-list">
            <li className="aurum-intel-row">
              <div className="aurum-intel-row-head">
                <Link className="aurum-intel-row-title" href="/approvals">
                  Gate request {proposal.approval.actionRequestId.slice(0, 8)}
                </Link>
                <StatusPill
                  tone={proposal.status === 'awaiting_approval' ? 'warning' : 'neutral'}
                >
                  {proposal.approval.policyOutcome === null
                    ? 'unknown outcome'
                    : proposal.approval.policyOutcome.replace('_', ' ')}
                </StatusPill>
              </div>
              <p className="aurum-intel-row-foot">
                Submitted by {proposal.approval.submittedBy ?? 'unknown'} ·{' '}
                {proposal.approval.submittedAt === null
                  ? 'unknown time'
                  : dateLabel(proposal.approval.submittedAt)}
                {proposal.approval.policyResolvedVia === null
                  ? ''
                  : ` · resolved via ${proposal.approval.policyResolvedVia}`}
              </p>
              {proposal.approval.decidedAt === null ? (
                <p className="aurum-intel-row-foot">No decision yet — it waits for a human.</p>
              ) : (
                <p className="aurum-intel-row-foot">
                  Decided by {proposal.approval.decidedBy}
                  {proposal.approval.decidedByPrincipal === null
                    ? ''
                    : ` (${proposal.approval.decidedByPrincipal.slice(0, 8)})`}{' '}
                  on {dateLabel(proposal.approval.decidedAt)}
                </p>
              )}
            </li>
          </ul>
        )}
        {awaiting ? (
          <>
            <p className="aurum-learn-hint" style={{ marginTop: 12 }}>
              You are the human this gate waits for — decide it below.
            </p>
            <ProposalDecisionForm
              proposalId={proposal.id}
              requestId={proposal.approval.actionRequestId ?? ''}
            />
            <p className="aurum-learn-separation" role="note" style={{ marginTop: 12 }}>
              {GATE_NOTE}
            </p>
          </>
        ) : null}
        {proposal.withdrawnAt === null ? null : (
          <p className="aurum-intel-row-foot" style={{ marginTop: 10 }}>
            Withdrawn {dateLabel(proposal.withdrawnAt)}
            {proposal.withdrawalReason === null ? '' : ` — “${proposal.withdrawalReason}”`}
          </p>
        )}
      </Panel>

      {/* The activation (only for an approved recruit comparison). */}
      <Panel
        title="The activation"
        blurb={view.activation.reason}
        meta={
          view.activation.available ? <StatusPill tone="positive">Ready to activate</StatusPill> : null
        }
      >
        {view.activation.available ? (
          <>
            <p className="aurum-learn-hint" style={{ marginBottom: 10 }}>
              Registering makes the agent an organizational actor with exactly the scopes the
              approved comparison proposed — activation completes the proposal → approval →
              activation chain.
            </p>
            <AgentActivationForm
              proposalId={proposal.id}
              suggestedSlug={view.activation.suggestedSlug}
              suggestedRole={view.activation.suggestedRole}
              suggestedInstructions={view.activation.suggestedInstructions}
              defaultPermissions={view.activation.defaultPermissions}
            />
          </>
        ) : (
          <EmptyState
            title="No activation from this proposal"
            hint={view.activation.reason}
          />
        )}
      </Panel>
    </>
  );
}
