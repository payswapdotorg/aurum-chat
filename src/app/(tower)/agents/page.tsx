// Management Control Tower (W033) — the Agents surface.
//
// The agent workforce (W021 — Agent Gateway): persistent definitions
// with explicit roles, permissions and providers (lock 22 —
// organizational actors with explicit contracts), and their recent
// executions (async, policy-gated, cost-carrying). Provider-neutral by
// construction (lock 24). Recruitment (W022), teams (W023) and
// evaluation (W024) are not delivered at this base.

import { buildAgentsView } from '../lib/views/agents';
import { resolvePageContext } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  Notice,
  NotScoped,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { formatInstant, formatMinorUnits, joinList, titleCase } from '../lib/format';

export const dynamic = 'force-dynamic';

// Display-level phrasing for execution error codes — words, never raw enums.
const ERROR_CODE_PHRASES: Record<string, string> = {
  provider_unavailable: 'provider unavailable — nothing was sent',
  dispatch_failed: 'could not reach the runtime',
  dispatch_rejected: 'the runtime refused the call',
  result_invalid: 'the runtime returned an unusable result',
  execution_forbidden: 'not permitted for this agent',
  approval_rejected: 'a required approval was rejected',
  account_disabled: 'the account is disabled',
  bad_input: 'the request was invalid',
  cancelled: 'cancelled',
};

function describeErrorCode(code: string): string {
  return ERROR_CODE_PHRASES[code] ?? code.replaceAll('_', ' ');
}

export default async function AgentsPage() {
  const resolution = await resolvePageContext();
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildAgentsView(resolution.context);

  return (
    <>
      <SurfaceHeader
        title="Agents"
        description="The agent workforce: persistent definitions with explicit roles, granted permissions and runtime providers, plus their recent executions through the agent gateway — permission-scoped, policy-gated, idempotent and traceable, with normalized results and cost."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <Notice neutral>
        Agent registration requires admin permission, and every run passes the approval
        gates its permissions require. Recruiting, teams and evaluation tools are planned.
      </Notice>
      <StatTiles
        items={[
          { label: 'Agent definitions', value: view.definitions.total },
          { label: 'Recent executions', value: view.executions.total },
          {
            label: 'Spend (recent)',
            value: formatMinorUnits(
              view.executions.items.reduce((sum, e) => sum + e.costMinor, 0),
              'USD',
            ),
            hint: 'sum of attempt costs',
          },
        ]}
      />
      <Card title="Agent definitions" meta={`${view.definitions.total} registered`}>
        {view.definitions.items.length === 0 ? (
          <Empty
            title="No agents registered"
            hint="Agents are organizational actors with explicit contracts, budgets, permissions and outcomes."
          />
        ) : (
          <ul className="item-list">
            {view.definitions.items.map((agent) => (
              <li key={agent.id}>
                <ItemHead
                  title={agent.displayName ?? agent.slug}
                  badges={
                    <>
                      <Badge kind="muted">{agent.slug}</Badge>
                      <StatusBadge status={agent.status} />
                    </>
                  }
                />
                <p className="item-text">
                  <strong>Role:</strong> {agent.role} · <strong>Runtime:</strong>{' '}
                  {titleCase(agent.provider)}
                </p>
                <ItemFoot>
                  <span>permissions: {joinList(agent.permissions, 6)}</span>
                  <span>updated {formatInstant(agent.updatedAt)}</span>
                  <span>
                    agent <span className="mono">{agent.id.slice(0, 8)}</span>
                  </span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recent executions" meta={`${view.executions.total} latest`}>
        {view.executions.items.length === 0 ? (
          <Empty title="No agent executions" />
        ) : (
          <div className="tt-wrap">
            <table className="tt">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Authority</th>
                  <th>Attempts</th>
                  <th>Cost</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {view.executions.items.map((execution) => (
                  <tr key={execution.id}>
                    <td>{execution.agentSlug ?? execution.id}</td>
                    <td>
                      <StatusBadge status={execution.status} />
                      {execution.errorCode === null ? null : (
                        <>
                          {' '}
                          <span>{describeErrorCode(execution.errorCode)}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <Badge kind="accent">{execution.authorityLevel}</Badge>
                    </td>
                    <td>{execution.attemptsCount}</td>
                    <td>{formatMinorUnits(execution.costMinor, execution.costCurrency)}</td>
                    <td>{formatInstant(execution.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
