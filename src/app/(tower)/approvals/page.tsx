// Management Control Tower (W033) — the Approvals surface.
//
// The §21 approvals gate: pending action requests waiting for exactly
// one human decision, each with its append-only decision trail, plus the
// recently decided requests. Decisions go through the actions contract
// (decideApproval) via the tower API route — claim-gated, separation of
// duties enforced by the module, first decision wins, never un-decidable.

import { buildApprovalsView } from '../lib/views/approvals';
import { resolvePageContext } from '../lib/page-context';
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

export default async function ApprovalsPage() {
  const resolution = await resolvePageContext();
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildApprovalsView(resolution.context);
  // W058: scope lives in the session — the decision form posts with the
  // session cookie, so no scope threading is needed.
  const scope = { tenant: null, principal: null, authority: null };

  const canDecide = resolution.context.authority.includes('actions:approve');
  const principal = resolution.context.principalId;

  return (
    <>
      <SurfaceHeader
        title="Approvals"
        description="Consequential actions the authority matrix holds for an explicit human decision. First decision wins; approved and rejected are final; the decision trail is permanent — decisions can never be rewritten or un-made."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      {canDecide ? null : (
        <Notice>
          Decisions need an owner or admin role. Ask an admin to promote you, or
          let another approver decide.
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
            hint="Requests become pending when a consequential action needs an explicit human decision."
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
                      by <span className="mono">{request.requestedBy.slice(0, 8)}</span>
                    </span>
                  </ItemFoot>
                  <DecisionForm
                    requestId={request.id}
                    tenant={scope.tenant}
                    principal={scope.principal}
                    authority={scope.authority}
                    disabled={selfRequested}
                    disabledReason={
                      selfRequested
                        ? 'you may not decide your own request (separation of duties)'
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
                                  : `approver ${decision.principalId?.slice(0, 8) ?? '…'}`}
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
      <Card title="Recently decided" meta="final — permanent history">
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
                  <span>
                    request <span className="mono">{request.id.slice(0, 8)}</span>
                  </span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
