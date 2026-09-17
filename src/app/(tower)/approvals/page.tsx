// Management Control Tower (W033) — the Approvals surface.
//
// The §21 approvals gate: pending action requests waiting for exactly
// one human decision, each with its append-only decision trail, plus the
// recently decided requests. Decisions go through the actions contract
// (decideApproval) via the tower API route — claim-gated, separation of
// duties enforced by the module, first decision wins, never un-decidable.

import { buildApprovalsView } from '../lib/views/approvals';
import { resolvePageContext, scopeQuery } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  ItemText,
  Notice,
  NotScoped,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { formatCount, formatInstant, titleCase } from '../lib/format';
import { DecisionForm } from './decision-form';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const resolution = await resolvePageContext(params);
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildApprovalsView(resolution.context);
  const scope = scopeQuery(params);

  const canDecide = resolution.context.authority.includes('actions:approve');
  const principal = resolution.context.principalId;

  return (
    <>
      <SurfaceHeader
        title="Approvals"
        description="Consequential actions the authority matrix holds for an explicit human decision. First decision wins; approved and rejected are terminal; the decision trail is append-only — decisions can never be rewritten or un-made."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      {canDecide ? null : (
        <Notice>
          Deciding requires the <code>actions:approve</code> authority claim. Until
          authentication lands (W038), pass it explicitly:{' '}
          <code>?authority=actions:approve</code> — the actions contract checks the claim
          itself; the tower never bypasses it.
        </Notice>
      )}
      <StatTiles
        items={[
          { label: 'Pending decisions', value: formatCount(view.pendingTotal, view.capped) },
          { label: 'Recently decided', value: view.recentlyDecided.length },
        ]}
      />
      <Card
        title="Pending requests"
        meta={`${formatCount(view.pendingTotal, view.capped)} waiting · ${view.pending.length} with trails shown`}
      >
        {view.pending.length === 0 ? (
          <Empty
            title="Nothing awaits your decision"
            hint="Requests become pending when the matrix evaluates a consequential action as approval-required."
          />
        ) : (
          <ul className="item-list">
            {view.pending.map(({ request, decisions }) => {
              const selfRequested = request.requestedBy === principal;
              return (
                <li key={request.id}>
                  <ItemHead
                    title={titleCase(request.actionKind)}
                    badges={
                      <>
                        <Badge kind="accent">{request.authorityLevel}</Badge>
                        <StatusBadge status="pending" />
                      </>
                    }
                  />
                  {request.justification === null ? null : (
                    <ItemText>{request.justification}</ItemText>
                  )}
                  <ItemFoot>
                    <span>requested {formatInstant(request.requestedAt)}</span>
                    <span>
                      by <span className="mono">{request.requestedBy}</span>
                    </span>
                    <span>routed via {request.evaluation.resolvedVia}</span>
                  </ItemFoot>
                  <DecisionForm
                    requestId={request.id}
                    tenant={scope.tenant}
                    principal={scope.principal}
                    authority={scope.authority}
                    disabled={selfRequested}
                    disabledReason={
                      selfRequested
                        ? 'the requesting principal may not decide its own request (separation of duties)'
                        : null
                    }
                  />
                  <div className="card-section">
                    <h4>Decision trail</h4>
                    {decisions.length === 0 ? (
                      <p className="item-text">No decisions recorded yet.</p>
                    ) : (
                      <ul className="item-list">
                        {decisions.map((decision) => (
                          <li key={decision.id}>
                            <ItemFoot>
                              <span>
                                <StatusBadge status={decision.decision} /> by{' '}
                                {decision.decidedBy === 'policy'
                                  ? 'policy'
                                  : `principal ${decision.principalId?.slice(0, 8) ?? '…'}`}
                              </span>
                              <span>{formatInstant(decision.decidedAt)}</span>
                              {decision.note === null ? null : <span>“{decision.note}”</span>}
                            </ItemFoot>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Recently decided" meta="terminal — append-only history">
        {view.recentlyDecided.length === 0 ? (
          <Empty title="No decided requests yet" />
        ) : (
          <ul className="item-list">
            {view.recentlyDecided.map((request) => (
              <li key={request.id}>
                <ItemHead
                  title={titleCase(request.actionKind)}
                  badges={
                    <>
                      <Badge kind="accent">{request.authorityLevel}</Badge>
                      <StatusBadge status={request.status} />
                    </>
                  }
                />
                <ItemFoot>
                  <span>requested {formatInstant(request.requestedAt)}</span>
                  <span>decided {formatInstant(request.decidedAt ?? request.requestedAt)}</span>
                  <span className="mono">{request.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
