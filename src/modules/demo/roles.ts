// The demo capability matrix (W068 acceptance: "role-specific capability
// visibility").
//
// This is the harness's single source of truth for WHICH capabilities each
// demo role sees, and HOW that visibility is enforced at this repository
// base. It describes the existing enforcement — it never invents a new
// one:
//
//   * tenant-role capabilities are enforced by the auth module's interim
//     role→claim mapping (claimsForRole: owner/admin → the management
//     claim set, member → none). The demo roles deliberately map onto the
//     REAL tenant-role ladder — manager=owner, developer=admin,
//     employee=member — so a signed-in persona's session authority is
//     exactly what the matrix predicts (the integration tests prove it
//     against the real contracts, not against this table).
//   * harness-only capabilities are real authority claims in the domain
//     ('marketplace:administer', 'llm:administer') that never ride a
//     tenant session at this base — W058's interim model excludes them on
//     purpose ("platform claims never ride a tenant session"), and the
//     authority-matrix work item will fold them in later. The harness
//     uses them through explicit contract contexts while SEEDING only.
//     The matrix says so honestly instead of pretending a browser
//     session can carry them.
//   * open capabilities need no claims — every verified tenant member
//     reads/acts there.
//
// The interim model is coarser than the matrix semantics: an admin
// session carries the WHOLE management claim set, so the developer
// persona (admin) technically also holds approve-actions. The matrix
// records the SEMANTIC per-role visibility; each capability's
// claimSource documents the interim derivation, and the tests assert the
// claims each persona's session really derives.

import type {
  DemoCapability,
  DemoCapabilityId,
  DemoRole,
  DemoRoleId,
} from './types';

// ---------------------------------------------------------------------------
// The capability catalog
// ---------------------------------------------------------------------------

/**
 * The claims that gate consequential operations of each capability — the
 * REAL claim names the domain contracts check (actions, marketplace,
 * extensions, agents, api, llm modules), not new vocabulary.
 */
export const DEMO_CAPABILITIES: readonly DemoCapability[] = [
  {
    id: 'chat',
    label: 'Aurum chat',
    description:
      'Talk with Aurum, the company intelligence employee — conversation list, message timeline, evidence-linked answers (product Chat area).',
    requiredClaims: [],
    claimSource: 'open',
  },
  {
    id: 'today',
    label: 'Today',
    description: 'The attention dashboard: pending approvals, urgent missions, open unknowns, live cognition.',
    requiredClaims: [],
    claimSource: 'open',
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    description:
      'Goals, situation, unknowns, missions, risks, opportunities, capabilities, processes and automation — the management intelligence surfaces (read).',
    requiredClaims: [],
    claimSource: 'open',
  },
  {
    id: 'people-workforce',
    label: 'People & workforce',
    description: 'Workforce, agents and how work gets done (read).',
    requiredClaims: [],
    claimSource: 'open',
  },
  {
    id: 'connections',
    label: 'Connections',
    description: 'Channels, source systems and destinations — the connection hub.',
    requiredClaims: [],
    claimSource: 'open',
  },
  {
    id: 'marketplace-browse',
    label: 'Marketplace browse & install',
    description: 'Browse the governed catalog and install packages into the tenant.',
    requiredClaims: [],
    claimSource: 'open',
  },
  {
    id: 'contribute-knowledge',
    label: 'Contribute knowledge',
    description:
      'Answer Aurum\u2019s targeted questions; see contribution acknowledgement and reward status (the employee learning journey).',
    requiredClaims: [],
    claimSource: 'open',
  },
  {
    id: 'approve-actions',
    label: 'Approve consequential actions',
    description:
      'Decide the pending requests at the human authority gate (Approvals surface) — employee-messaging asks, agent recruitment, contribution rewards.',
    requiredClaims: ['actions:approve'],
    claimSource: 'tenant-role',
  },
  {
    id: 'administer-policies',
    label: 'Administer policies & people',
    description:
      'Set authority and reward policies, invite members, manage the tenant\u2019s governance controls.',
    requiredClaims: ['actions:administer', 'rewards:administer'],
    claimSource: 'tenant-role',
  },
  {
    id: 'marketplace-develop',
    label: 'Marketplace develop & publish',
    description:
      'Build extensions with builder agents, freeze versions as packages, submit them to the governed chain (marketplace Developer console).',
    requiredClaims: ['marketplace:submit', 'extensions:administer'],
    claimSource: 'tenant-role',
  },
  {
    id: 'developer-api',
    label: 'Developer API & webhooks',
    description: 'Create/revoke API keys with scopes and webhook subscriptions (the developer integration surface).',
    requiredClaims: ['api:administer'],
    claimSource: 'tenant-role',
  },
  {
    id: 'platform-review',
    label: 'Platform package review',
    description:
      'The platform-side review queue: run automated verification, approve/reject, publish and make packages installable.',
    requiredClaims: ['marketplace:administer'],
    claimSource: 'harness-only',
  },
  {
    id: 'configure-ai',
    label: 'Configure AI providers (BYOA)',
    description:
      'Register tenant-owned AI provider accounts, scopes, budgets and availability (the AI/BYOA surface).',
    requiredClaims: ['llm:administer'],
    claimSource: 'harness-only',
  },
];

const CAPABILITY_BY_ID: ReadonlyMap<DemoCapabilityId, DemoCapability> = new Map(
  DEMO_CAPABILITIES.map((capability) => [capability.id, capability]),
);

/** One capability by id (throws on unknown ids — the catalog is closed). */
export function demoCapability(id: DemoCapabilityId): DemoCapability {
  const capability = CAPABILITY_BY_ID.get(id);
  if (capability === undefined) {
    throw new Error(`unknown demo capability '${id}'`);
  }
  return capability;
}

// ---------------------------------------------------------------------------
// The four roles
// ---------------------------------------------------------------------------

/**
 * The four demo roles, mapped onto the real tenant-role ladder so their
 * session authority is exactly what the interim auth model derives.
 */
export const DEMO_ROLES: readonly DemoRole[] = [
  {
    id: 'manager',
    label: 'Manager',
    description:
      'The company\u2019s operations lead (tenant owner): sees every intelligence surface, decides approvals, administers policies and invites the team.',
    tenantRole: 'owner',
    capabilities: [
      'chat',
      'today',
      'intelligence',
      'people-workforce',
      'connections',
      'marketplace-browse',
      'contribute-knowledge',
      'approve-actions',
      'administer-policies',
    ],
  },
  {
    id: 'employee',
    label: 'Employee',
    description:
      'A plain company member (tenant member): chats with Aurum, reads the shared surfaces, answers targeted questions and sees contribution/reward state — no management claims.',
    tenantRole: 'member',
    capabilities: [
      'chat',
      'today',
      'intelligence',
      'people-workforce',
      'connections',
      'marketplace-browse',
      'contribute-knowledge',
    ],
  },
  {
    id: 'developer',
    label: 'Developer',
    description:
      'The company\u2019s integration engineer (tenant admin): everything the employee sees, plus the marketplace developer console, extension builds and the API/webhook integration surface.',
    tenantRole: 'admin',
    capabilities: [
      'chat',
      'today',
      'intelligence',
      'people-workforce',
      'connections',
      'marketplace-browse',
      'contribute-knowledge',
      'marketplace-develop',
      'developer-api',
    ],
  },
  {
    id: 'platform-reviewer',
    label: 'Platform reviewer',
    description:
      'The platform side (a member of the platform review tenant): governs the marketplace pipeline. At this base the review capability is claim-gated platform scope (see platform-review) — the persona, the queue and the governed data are seeded for verification.',
    tenantRole: 'admin',
    capabilities: ['chat', 'today', 'intelligence', 'people-workforce', 'connections', 'platform-review'],
  },
];

const ROLE_BY_ID: ReadonlyMap<DemoRoleId, DemoRole> = new Map(
  DEMO_ROLES.map((role) => [role.id, role]),
);

/** One demo role by id (throws on unknown ids — the role set is closed). */
export function demoRole(id: DemoRoleId): DemoRole {
  const role = ROLE_BY_ID.get(id);
  if (role === undefined) {
    throw new Error(`unknown demo role '${id}'`);
  }
  return role;
}

/** All four roles in catalog order. */
export function demoRoles(): readonly DemoRole[] {
  return DEMO_ROLES;
}

/** The capability-visibility matrix entry for one role (stable order). */
export function capabilityVisibilityForRole(id: DemoRoleId): readonly DemoCapability[] {
  return demoRole(id).capabilities.map((capabilityId) => demoCapability(capabilityId));
}

/** Does the role see the capability? */
export function roleSeesCapability(roleId: DemoRoleId, capabilityId: DemoCapabilityId): boolean {
  return demoRole(roleId).capabilities.includes(capabilityId);
}
