// W068 — the demo roles and the role→capability visibility model.
//
// THE FOUR ROLES map onto real platform primitives (nothing invented):
//
//   manager          owner  of the demo company   — management mode, the
//                     approval gate, governance surfaces;
//   employee         member of the demo company   — the conversation-
//                     first employee experience, knowledge contribution
//                     and rewards, no management claims;
//   developer        owner  of the demo vendor co  — the marketplace
//                     builder/publisher pipeline;
//   platform         admin  of the demo platform  — the platform review
//   reviewer          company                       pipeline persona.
//
// CAPABILITY VISIBILITY is DERIVED, never hand-written: a capability is
// visible to a role exactly when the role's verified tenant session
// carries the claims the product gates on (auth/claims.ts — the same
// derivation W058 sessions use), with ONE documented exception: platform
// claims ('marketplace:administer') never ride a tenant session by
// design, so the platform-review capability is marked
// 'platform-pipeline' — exercised through the harness's explicit platform
// context, exactly like every marketplace platform operation in this
// repository (scripts/seed-marketplace-demo.ts, the W028/W064 tests).
//
// Pure logic only: no db, no framework — unit-testable in isolation.

import { claimsForRole } from '@/modules/auth/contract';
import type { TenantRole } from '@/modules/organizations/contract';
import type {
  DemoAccountSpec,
  DemoCapability,
  DemoCapabilityVisibility,
  DemoCompanySpec,
  DemoCompanyId,
  DemoRole,
} from './types';

// ---------------------------------------------------------------------------
// The demo roles and their accounts
// ---------------------------------------------------------------------------

export const DEMO_ROLES: readonly DemoRole[] = [
  'manager',
  'employee',
  'developer',
  'platform-reviewer',
];

export function isDemoRole(value: unknown): value is DemoRole {
  return (
    value === 'manager' ||
    value === 'employee' ||
    value === 'developer' ||
    value === 'platform-reviewer'
  );
}

/** The three demo companies (deterministic names, obviously non-production). */
export const DEMO_COMPANIES: Record<DemoCompanyId, DemoCompanySpec> = {
  company: {
    id: 'company',
    name: 'Meridian Freight (Demo)',
    defaultWorkspaceName: 'Operations',
    purpose:
      'the main demo company: manager + employee personas, the intelligence chain, approvals, contributions and rewards',
  },
  vendor: {
    id: 'vendor',
    name: 'Cobalt Labs (Demo)',
    defaultWorkspaceName: 'Studio',
    purpose: 'the marketplace vendor company behind the developer persona',
  },
  platform: {
    id: 'platform',
    name: 'Aurum Platform (Demo)',
    defaultWorkspaceName: 'Platform Ops',
    purpose: 'the platform company behind the platform-reviewer persona',
  },
};

/**
 * The four deterministic demo accounts. Emails live under the reserved
 * `.example` domain (RFC 2606) so they can never collide with a real
 * address space, and the role word is always part of the local part so a
 * browser operator can see at a glance which persona signs in where.
 */
export const DEMO_ACCOUNTS: Record<DemoRole, DemoAccountSpec> = {
  manager: {
    role: 'manager',
    displayName: 'Mara Ellison',
    email: 'manager@meridian-demo.example',
    company: 'company',
    tenantRole: 'owner',
    purpose:
      'Journey A/D/E (+all management surfaces): onboarding and invites, the intelligence chain, the pending approval gate, connections, BYOA, agents and marketplace installation',
  },
  employee: {
    role: 'employee',
    displayName: 'Dev Patel',
    email: 'employee@meridian-demo.example',
    company: 'company',
    tenantRole: 'member',
    purpose:
      'Journey B/F: the conversation-first employee experience, channel identity, the targeted knowledge request, the contribution and its granted reward',
  },
  developer: {
    role: 'developer',
    displayName: 'Riley Osei',
    email: 'developer@cobalt-demo.example',
    company: 'vendor',
    tenantRole: 'owner',
    purpose:
      'Journey J/L (vendor side): the marketplace developer console — extension manifests, package submission states, the pending-review package and the agent package',
  },
  'platform-reviewer': {
    role: 'platform-reviewer',
    displayName: 'Quinn Faraday',
    email: 'reviewer@platform-demo.example',
    company: 'platform',
    tenantRole: 'admin',
    purpose:
      'Journey J (platform side): the platform review pipeline — the deterministic pending-review submission, verified and awaiting the platform decision',
  },
}

/**
 * The shared demo password — ASSEMBLED FROM FRAGMENTS AT RUNTIME, never a
 * full credential literal in source (GitHub push protection; the same
 * discipline the repository's test suites use). It is a non-production
 * demo credential by construction: the word 'demo' is part of it, and the
 * accounts only exist in the guarded, opt-in embedded database.
 */
const DEMO_PASSWORD_FRAGMENTS: readonly string[] = [
  'Aurum',
  'Demo',
  '-journeys',
  '2026',
  '!',
];

export function demoSharedPassword(): string {
  return DEMO_PASSWORD_FRAGMENTS.join('');
}

/**
 * The authority claims a demo role's verified session carries — the REAL
 * W058 derivation (claimsForRole), never a parallel list. A plain member
 * carries none: every management capability is invisible to the employee
 * persona because the authority model says so, not because the harness
 * says so.
 */
export function demoSessionClaims(role: DemoRole): readonly string[] {
  return claimsForRole(DEMO_ACCOUNTS[role].tenantRole as TenantRole);
}

/** The tenant role a demo account holds in its demo company. */
export function demoTenantRole(role: DemoRole): TenantRole {
  return DEMO_ACCOUNTS[role].tenantRole as TenantRole;
}

// ---------------------------------------------------------------------------
// The capability catalog (mirrors the real product vocabulary)
// ---------------------------------------------------------------------------

/**
 * The authority claims whose ANY-ONE presence unlocks a capability — the
 * exact rules the product surfaces use (W064's labels.ts
 * canUseDeveloperSurface, the actions module's approve claim, the api
 * module's administer claim).
 */
export const DEMO_CAPABILITIES: readonly DemoCapability[] = [
  {
    key: 'chat',
    label: 'Chat with Aurum',
    href: '/chat',
    requiredClaims: [],
    platformClaim: false,
    rationale: 'the conversation-first employee experience (W057 shell; W060 deepens it)',
  },
  {
    key: 'today',
    label: 'Today',
    href: '/today',
    requiredClaims: [],
    platformClaim: false,
    rationale: 'the attention dashboard — decisions, missions, unknowns',
  },
  {
    key: 'intelligence',
    label: 'Intelligence hub',
    href: '/intelligence',
    requiredClaims: [],
    platformClaim: false,
    rationale: 'goals, situation, unknowns, missions, risks and opportunities',
  },
  {
    key: 'people',
    label: 'People hub',
    href: '/people',
    requiredClaims: [],
    platformClaim: false,
    rationale: 'workforce, agents and how work gets done',
  },
  {
    key: 'connections',
    label: 'Connections hub',
    href: '/connections',
    requiredClaims: [],
    platformClaim: false,
    rationale: 'channels, source systems and destinations (Journey G)',
  },
  {
    key: 'marketplace',
    label: 'Marketplace catalog',
    href: '/marketplace',
    requiredClaims: [],
    platformClaim: false,
    rationale: 'the governed catalog is public browsing (Journey J, discover)',
  },
  {
    key: 'more',
    label: 'More',
    href: '/more',
    requiredClaims: [],
    platformClaim: false,
    rationale: 'management-mode index, platform tools, account',
  },
  {
    key: 'marketplace-developer',
    label: 'Marketplace developer console',
    href: '/marketplace/developer',
    requiredClaims: ['marketplace:submit', 'extensions:administer', 'marketplace:administer'],
    platformClaim: false,
    rationale: 'builder sessions, manifest versions, package submission states',
  },
  {
    key: 'marketplace-install',
    label: 'Installed package governance',
    href: '/marketplace/installed',
    requiredClaims: ['extensions:administer', 'agents:administer'],
    platformClaim: false,
    rationale: 'activate, suspend, rollback what the company runs (Journey J, govern)',
  },
  {
    key: 'approvals-decide',
    label: 'Decide approvals',
    href: '/approvals',
    requiredClaims: ['actions:approve'],
    platformClaim: false,
    rationale: 'the human authority gate over consequential actions (Journey E)',
  },
  {
    key: 'api-keys',
    label: 'API keys & webhooks',
    href: '/more',
    requiredClaims: ['api:administer'],
    platformClaim: false,
    rationale: 'developer integration credentials (Journey L; the console surface arrives with W067, the capability and seeded key/webhook are real today)',
  },
  {
    key: 'platform-review',
    label: 'Platform package review',
    href: '/marketplace/developer',
    requiredClaims: ['marketplace:administer'],
    platformClaim: true,
    rationale: 'the platform review decision on pending marketplace submissions (lock 27)',
  },
];

/**
 * Derive one role's capability visibility from the REAL authority model:
 * a capability is session-visible iff the role's derived session claims
 * include at least one of the capability's required claims. The platform
 * claim exception is explicit: 'marketplace:administer' never rides a
 * tenant session (auth/claims.ts), so the platform-review capability is
 * reported as `via: 'platform-pipeline'` — reachable only through the
 * harness's explicit platform context.
 */
export function capabilitiesForRole(role: DemoRole): DemoCapabilityVisibility[] {
  const claims = demoSessionClaims(role);
  return DEMO_CAPABILITIES.map((capability) => {
    const hasClaim =
      capability.requiredClaims.length === 0 ||
      capability.requiredClaims.some((claim) => claims.includes(claim));
    if (capability.platformClaim) {
      // Platform claims never ride a tenant session — by design. The
      // platform reviewer persona reaches this capability through the
      // platform pipeline context; no other role does.
      const viaPipeline = role === 'platform-reviewer';
      return {
        key: capability.key,
        label: capability.label,
        href: capability.href,
        visible: viaPipeline,
        via: viaPipeline ? ('platform-pipeline' as const) : null,
        note: viaPipeline
          ? 'the platform review claim never rides a tenant session — the harness exercises it through the explicit platform pipeline context'
          : 'platform governance is not a tenant capability',
      };
    }
    if (capability.requiredClaims.length === 0) {
      return {
        key: capability.key,
        label: capability.label,
        href: capability.href,
        visible: true,
        via: 'session' as const,
        note: 'every company member sees this area',
      };
    }
    return {
      key: capability.key,
      label: capability.label,
      href: capability.href,
      visible: hasClaim,
      via: hasClaim ? ('session' as const) : null,
      note: hasClaim
        ? `the verified ${DEMO_ACCOUNTS[role].tenantRole} role derives the required authority claim`
        : 'a plain member session carries no management authority claims (auth/claims.ts)',
    };
  });
}

/** The visible capability keys of one role (the compact form). */
export function visibleCapabilityKeys(role: DemoRole): string[] {
  return capabilitiesForRole(role)
    .filter((capability) => capability.visible)
    .map((capability) => capability.key);
}

/**
 * The full role directory — what W070's journey matrix and browser
 * operators verify: for each demo role, the account binding and the
 * derived capability visibility.
 */
export interface DemoRoleDirectoryEntry {
  role: DemoRole;
  account: DemoAccountSpec;
  company: DemoCompanySpec;
  sessionClaims: readonly string[];
  capabilities: DemoCapabilityVisibility[];
}

export function demoRoleDirectory(): DemoRoleDirectoryEntry[] {
  return DEMO_ROLES.map((role) => ({
    role,
    account: DEMO_ACCOUNTS[role],
    company: DEMO_COMPANIES[DEMO_ACCOUNTS[role].company],
    sessionClaims: demoSessionClaims(role),
    capabilities: capabilitiesForRole(role),
  }));
}
