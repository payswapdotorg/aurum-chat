// Intelligence discovery (W061) — the Intelligence area home.
//
// THE PRODUCT-MODE TODAY (the work item turns "Today, goals, situation,
// unknowns, missions, risks, opportunities and capabilities" into ONE
// discoverable intelligence workflow): the proactive findings briefing —
// what Aurum found on its own, severity/urgency legible, "why this
// matters" and "what Aurum needs next" on every finding — plus the
// attention few, the active goals with their chain counts (the entry
// points into the navigable goal → gap → unknown → mission → evidence →
// belief path), the capability gaps, and the management-mode
// drill-downs (the tower surfaces stay one click away, plan §3).
//
// Composition is read-only through module contracts (lock 31/32/34);
// the only write this surface offers is "Deliver to chat" (the
// acceptance's chat half, idempotent per findings digest).

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { withProductScope } from '../lib/context';
import type { PageSearchParams } from '../lib/context';
import { intelligenceSurfaces } from '../lib/navigation';
import { EmptyState, PageHead, Panel, StatusPill } from '../components/states';
import { ShellGlyph } from '../components/icons';
import { ChatReturnLink, chatReturnFromSearchParams } from '../chat/components/chat-return-link';
import { buildIntelligenceView } from './lib/views';
import type { IntelligenceView } from './lib/views';
import { ChainRail, FindingRow, MissionLinkRow } from './components/chain-ui';
import { DeliverToChatButton } from './components/deliver-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Intelligence — Aurum',
  description:
    'Today\u2019s briefing and the intelligence workflow: goals, gaps, unknowns, missions, evidence and beliefs — navigable end to end.',
};

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function IntelligencePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  // W072 — the guarded return link when the workflow was opened from a
  // chat card or a briefing drill-down (`?back=/chat?c=…`).
  const back = chatReturnFromSearchParams(params);
  const session = await requireAuthenticatedPage();
  const scopeQuery = withProductScope(params);
  const view: IntelligenceView = await buildIntelligenceView(session.context);
  const surfaces = intelligenceSurfaces();

  return (
    <>
      <PageHead
        title="Intelligence"
        description="Today\u2019s briefing — what Aurum found on its own — and the workflow from goals through gaps, unknowns and missions to the evidence and beliefs underneath."
        meta={<>
          <ChatReturnLink back={back} />
          Generated {dateLabel(view.generatedAt)}
        </>}
      />

      {/* The product-mode Today: the proactive findings briefing. */}
      <Panel
        title="What Aurum found on its own"
        blurb="Proactive findings, worst first: goal-gap discoveries, analysis findings and retained conflicting evidence — severity legible, why and next always visible."
        meta={<>{view.findings.length} finding(s)</>}
      >
        {view.findings.length === 0 ? (
          <EmptyState
            title="Nothing proactive right now"
            hint="When Aurum notices a material goal gap, a risk, an opportunity or conflicting evidence, it lands here — and can be delivered into the chat."
          />
        ) : (
          <div className="aurum-intel-findings">
            {view.findings.map((finding) => (
              <FindingRow key={`${finding.source}-${finding.id}`} finding={finding} back={back} />
            ))}
          </div>
        )}
        <DeliverToChatButton />
        {view.degraded.length === 0 ? null : (
          <p className="aurum-intel-degraded" role="note">
            Some reads were unavailable just now ({view.degraded.join(', ')}) — this briefing may
            be incomplete.
          </p>
        )}
      </Panel>

      {/* The attention few (decisions and urgent learning). */}
      <Panel
        title="What needs a decision or is running urgently"
        blurb="The authority gate and the critical/high-urgency learning missions — the rest of Today."
      >
        <div className="aurum-intel-attention">
          <div className="aurum-intel-attention-block">
            <h3 className="aurum-intel-subhead">
              Pending approvals{' '}
              <StatusPill tone={view.attention.pendingApprovals.count > 0 ? 'warning' : 'positive'}>
                {view.attention.pendingApprovals.count}
              </StatusPill>
            </h3>
            {view.attention.pendingApprovals.latest.length === 0 ? (
              <p className="aurum-intel-row-foot">No approvals are waiting for a human decision.</p>
            ) : (
              <ul className="aurum-intel-list">
                {view.attention.pendingApprovals.latest.map((request) => (
                  <li key={request.id} className="aurum-intel-row">
                    <div className="aurum-intel-row-head">
                      <span className="aurum-intel-row-title">{request.actionKind}</span>
                      <span className="aurum-intel-row-meta">{request.authorityLevel}</span>
                    </div>
                    <p className="aurum-intel-row-foot">
                      Requested {dateLabel(request.requestedAt)} ·{' '}
                      <Link href="/approvals">decide it in Approvals</Link>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="aurum-intel-attention-block">
            <h3 className="aurum-intel-subhead">Urgent learning missions</h3>
            {view.attention.urgentMissions.length === 0 ? (
              <p className="aurum-intel-row-foot">No missions at critical/high urgency.</p>
            ) : (
              <ul className="aurum-intel-list">
                {view.attention.urgentMissions.map((mission) => (
                  <MissionLinkRow key={mission.id} mission={mission} back={back} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>

      {/* The chain entries: active goals with their gap/unknown/mission counts. */}
      <Panel
        title="Goals — the chain entries"
        blurb="Every active goal is the first step of the navigable chain: gap → unknown → mission → evidence → belief."
      >
        <ChainRail
          activeStep="Goal"
          counts={{
            Unknown: view.situation.openUnknowns,
            Mission: view.situation.activeMissions,
          }}
        />
        {view.goals.length === 0 ? (
          <EmptyState
            title="No active goals"
            hint="Goals are the company's declared direction — define one and Aurum starts evaluating what stands between it and the desired state."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.goals.map((goal) => (
              <li key={goal.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <Link className="aurum-intel-row-title" href={goal.href}>
                    {goal.title}
                  </Link>
                  <StatusPill
                    tone={
                      goal.priority === 'critical'
                        ? 'error'
                        : goal.priority === 'high'
                          ? 'warning'
                          : 'info'
                    }
                  >
                    {goal.priority} priority
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-text">{goal.objective}</p>
                <p className="aurum-intel-row-foot">
                  Horizon ends {dateLabel(goal.horizonEnd)} ·{' '}
                  <Link href={`${goal.href}${scopeQuery}`}>open the chain</Link> ·{' '}
                  {goal.openUnknownIds.length} open unknown(s) ·{' '}
                  {goal.activeMissionIds.length} active mission(s) ·{' '}
                  {goal.activeBeliefCount} active belief(s)
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* The situation counts + capability gaps (the workflow's context). */}
      <Panel
        title="Situation and capabilities"
        blurb="Where the company is: the open knowledge gaps, the learning underway, retained conflicts — and whether the capabilities exist to act."
      >
        <div className="aurum-intel-stats">
          <span className="aurum-intel-stat">
            <strong>{view.situation.activeGoals}</strong> active goal(s)
          </span>
          <span className="aurum-intel-stat">
            <strong>{view.situation.openUnknowns}</strong> open unknown(s)
          </span>
          <span className="aurum-intel-stat">
            <strong>{view.situation.activeMissions}</strong> active mission(s)
          </span>
          <span className="aurum-intel-stat">
            <strong>{view.situation.openContradictions}</strong> retained contradiction(s)
          </span>
        </div>
        {view.capabilityGaps.length === 0 ? (
          <EmptyState
            title="No capability gaps detected"
            hint="Capability analysis compares the demand your goals imply with the supply you have."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.capabilityGaps.map((gap) => (
              <li key={gap.capabilityId} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">{gap.name}</span>
                  <StatusPill tone="warning">{gap.statusLabel}</StatusPill>
                </div>
                <p className="aurum-intel-row-text">
                  {gap.unmetCount} unmet requirement(s) · {gap.requirementCount} active
                  requirement(s) · {gap.supplyCount} active supply(ies)
                </p>
                <p className="aurum-intel-row-foot">
                  <Link href="/capabilities">compare alternatives in Capabilities</Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Management mode drill-downs (the tower surfaces, plan §3). */}
      <Panel
        title="Management mode"
        blurb="The Control Tower surfaces stay one click away — these are the drill-down destinations of the workflow, not its entry."
      >
        <div className="aurum-hub-grid">
          {surfaces.map((surface) => (
            <Link
              key={surface.surface}
              href={`${surface.href}${scopeQuery}`}
              className="aurum-hub-card"
            >
              <span className="aurum-hub-label">
                <ShellGlyph name="tower" size={16} />
                {surface.label}
              </span>
              <span className="aurum-hub-tagline">{surface.tagline}</span>
              <span className="aurum-hub-note">management mode</span>
            </Link>
          ))}
        </div>
      </Panel>
    </>
  );
}
