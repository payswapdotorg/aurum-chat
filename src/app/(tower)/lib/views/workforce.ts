// Management Control Tower (W033) — the Workforce view.
//
// Workforce intelligence (W019 — workload, role/capability fit,
// performance signals, staffing needs with alternative explanations) is
// NOT delivered at this base, and the tower deliberately performs no
// employee assessment of its own (lock 20/21). What the current
// contracts DO expose, and what this view shows:
//   * employee-supplied capabilities (W017 listSupplies, supplier kind
//     'employee') — who supplies what, at which level;
//   * the world model's people/team entities (W005) — the organizational
//     picture as understood;
//   * tenant membership (W001 listTenantMembers) — who holds which role;
//     requires a MEMBER principal, so it degrades to a notice otherwise.
//
// The people contract (W002) exposes no employee ROSTER listing — that
// gap is reported in the delivery report (DEVIATIONS) for the architect;
// the tower does not read another module's tables to work around it.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listCapabilities, listSupplies } from '@/modules/capabilities/contract';
import type { CapabilitySupply } from '@/modules/capabilities/contract';
import { listTenantMembers } from '@/modules/organizations/contract';
import { OrganizationsError } from '@/modules/organizations/contract';
import type { TenantMembership } from '@/modules/organizations/contract';
import { listEntities } from '@/modules/world/contract';
import type { WorldEntity } from '@/modules/world/contract';

const CAP = 200;

export interface WorkforceSupplyItem {
  id: string;
  capability: { id: string; name: string };
  supplier: CapabilitySupply['supplier'];
  level: number;
  capacity: number | null;
  status: CapabilitySupply['status'];
  updatedAt: string;
}

export interface WorkforcePersonEntity {
  id: string;
  kind: string;
  name: string;
  description: string | null;
}

export interface WorkforceMemberItem {
  principalId: string;
  role: TenantMembership['role'];
  createdAt: string;
}

export interface WorkforceView {
  generatedAt: string;
  employeeSupplies: { total: number; items: WorkforceSupplyItem[] };
  peopleEntities: WorkforcePersonEntity[];
  members: { readable: boolean; reason: string | null; items: WorkforceMemberItem[] };
  /** Honest limits of the current base, shown on the surface itself. */
  notices: string[];
}

/** Build the Workforce view (facts only — no assessments, locks 20/21). */
export async function buildWorkforceView(ctx: TenantContext): Promise<WorkforceView> {
  const [supplies, capabilities, peopleEntities, memberships] = await Promise.all([
    listSupplies(ctx, { supplierKind: 'employee', limit: CAP }),
    listCapabilities(ctx, { limit: 500 }),
    listEntities(ctx, { category: 'people', limit: 50 }),
    listTenantMembers(ctx).catch((error: unknown) => {
      if (error instanceof OrganizationsError && error.code === 'tenant_not_found') {
        return null; // principal is not a member (or tenant absent) — degrade honestly
      }
      throw error;
    }),
  ]);

  const namesById = new Map(capabilities.map((c) => [c.id, c.name]));

  return {
    generatedAt: now().toISOString(),
    employeeSupplies: {
      total: supplies.length,
      items: supplies.map((supply: CapabilitySupply) => ({
        id: supply.id,
        capability: {
          id: supply.capabilityId,
          name: namesById.get(supply.capabilityId) ?? supply.capabilityId,
        },
        supplier: supply.supplier,
        level: supply.level,
        capacity: supply.capacity,
        status: supply.status,
        updatedAt: supply.updatedAt,
      })),
    },
    peopleEntities: peopleEntities.map((entity: WorldEntity) => ({
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      description: entity.description,
    })),
    members:
      memberships === null
        ? {
            readable: false,
            reason:
              'tenant membership is readable only by a member principal — pass ?principal=<member uuid>',
            items: [],
          }
        : {
            readable: true,
            reason: null,
            items: memberships.map((m: TenantMembership) => ({
              principalId: m.principalId,
              role: m.role,
              createdAt: m.createdAt,
            })),
          },
    notices: [
      'Workforce intelligence (W019 — workload, fit, performance signals with alternative explanations) is not delivered at this base; this surface presents facts only, no assessments.',
      'The people contract (W002) exposes no employee roster listing — reported as a contract gap for the architect.',
    ],
  };
}
