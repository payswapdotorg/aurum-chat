// Management Control Tower (W033) — the Workforce surface.
//
// Facts only, no assessments (locks 20/21: workforce intelligence must
// represent alternative explanations; Aurum never autonomously
// terminates employees). This surface shows who supplies which
// capabilities, the world model's people entities and the tenant's
// membership roles. Workforce intelligence (W019) is not delivered at
// this base — the surface says so.

import { buildWorkforceView } from '../lib/views/workforce';
import { requireTowerScope } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  Notice,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { formatInstant, joinList } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function WorkforcePage() {
  // W058: authenticated routing — the session carries the tenant scope.
  const scope = await requireTowerScope('/workforce');
  const view = await buildWorkforceView(scope.context);

  return (
    <>
      <SurfaceHeader
        title="Workforce"
        description="The human side of the capability graph: who supplies which capabilities at which level, the organizational picture as the world model understands it, and tenant membership roles. Facts only — workload, fit and performance assessment is workforce intelligence's scope, with alternative explanations preserved."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      {view.notices.map((notice) => (
        <Notice key={notice} neutral>
          {notice}
        </Notice>
      ))}
      <StatTiles
        items={[
          { label: 'Employee capability supplies', value: view.employeeSupplies.total },
          { label: 'People entities (world model)', value: view.peopleEntities.length },
          {
            label: 'Tenant members',
            value: view.members.readable ? view.members.items.length : '—',
            hint: view.members.readable ? undefined : 'member principal required',
          },
        ]}
      />
      <Card
        title="Employee-supplied capabilities"
        meta={`${view.employeeSupplies.total} supplies (supplier kind: employee)`}
      >
        {view.employeeSupplies.items.length === 0 ? (
          <Empty
            title="No employee capability supplies"
            hint="The capability graph records supplies from employees, teams, agents, software, suppliers and partners."
          />
        ) : (
          <div className="tt-wrap">
            <table className="tt">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Employee</th>
                  <th>Level</th>
                  <th>Capacity</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {view.employeeSupplies.items.map((supply) => (
                  <tr key={supply.id}>
                    <td>{supply.capability.name}</td>
                    <td>{supply.supplier.label ?? supply.supplier.id}</td>
                    <td>{supply.level}</td>
                    <td>{supply.capacity ?? '—'}</td>
                    <td>
                      <StatusBadge status={supply.status} />
                    </td>
                    <td>{formatInstant(supply.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="People in the world model" meta="company + external humans">
        {view.peopleEntities.length === 0 ? (
          <Empty title="No people entities" hint="The world model tracks persons, teams and external parties as entities." />
        ) : (
          <ul className="item-list">
            {view.peopleEntities.map((entity) => (
              <li key={entity.id}>
                <ItemHead
                  title={entity.name}
                  badges={<Badge kind="muted">{entity.kind}</Badge>}
                />
                {entity.description === null ? null : (
                  <p className="item-text">{entity.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Tenant membership" meta="roles: owner · admin · member">
        {view.members.readable ? (
          view.members.items.length === 0 ? (
            <Empty title="No members" />
          ) : (
            <ul className="item-list">
              {view.members.items.map((member) => (
                <li key={member.principalId}>
                  <ItemHead
                    title={<span className="mono">{member.principalId}</span>}
                    badges={
                      member.role === 'owner' ? (
                        <Badge kind="accent">owner</Badge>
                      ) : (
                        <Badge kind="muted">{member.role}</Badge>
                      )
                    }
                  />
                  <ItemFoot>
                    <span>member since {formatInstant(member.createdAt)}</span>
                  </ItemFoot>
                </li>
              ))}
            </ul>
          )
        ) : (
          <Empty title="Membership not readable" hint={view.members.reason ?? undefined} />
        )}
        <div className="card-section">
          <h4>Supplied-by overview</h4>
          <p className="item-text">
            Capabilities are supplied by {joinList(['employees', 'teams', 'agents', 'software', 'suppliers', 'partners'], 6)} —
            the Agents surface covers the agent workforce.
          </p>
        </div>
      </Card>
    </>
  );
}
