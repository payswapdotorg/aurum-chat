// Public types of the demo module (W068 — Deterministic Demo Tenant &
// Role Journey Harness).
//
// The demo module owns ONE thing: a deterministic, non-production demo
// world that browser verification (W070) can sign into and walk. It is a
// harness over the existing domain contracts — it never becomes a second
// source of organizational truth (PRODUCT-SURFACE-DEPLOYMENT-PLAN §2/§10)
// and it exposes no HTTP surface of its own.

/** The four demo roles the work item names (manager/employee/developer/platform reviewer). */
export type DemoRoleId = 'manager' | 'employee' | 'developer' | 'platform-reviewer';

/**
 * A product capability a demo role may or may not see. The ids name the
 * capability FAMILIES the product shell and tower expose at this base
 * (W057's areas + the tower's fifteen surfaces + the governed write
 * surfaces), not individual routes.
 */
export type DemoCapabilityId =
  | 'chat'
  | 'today'
  | 'intelligence'
  | 'people-workforce'
  | 'connections'
  | 'marketplace-browse'
  | 'contribute-knowledge'
  | 'approve-actions'
  | 'administer-policies'
  | 'marketplace-develop'
  | 'developer-api'
  | 'platform-review'
  | 'configure-ai';

/** How a capability's authority claims can reach a signed-in session at this base. */
export type DemoClaimSource =
  /**
   * Derivable from a verified tenant role (auth claimsForRole — W058's
   * interim mapping: owner/admin carry the management claim set).
   */
  | 'tenant-role'
  /**
   * Platform/harness-scoped only at this base: the claims exist in the
   * authority vocabulary but never ride a tenant session (W058's interim
   * model deliberately excludes them; the authority-matrix item folds
   * them in later). The harness itself uses them while seeding, through
   * explicit contract contexts — never through a session.
   */
  | 'harness-only'
  /** No claims needed (every tenant member can read/act). */
  | 'open';

/** One capability of the demo capability matrix. */
export interface DemoCapability {
  id: DemoCapabilityId;
  label: string;
  description: string;
  /** The authority claims that gate the capability's consequential operations. */
  requiredClaims: readonly string[];
  claimSource: DemoClaimSource;
}

/** One demo role: a persona archetype with its capability visibility. */
export interface DemoRole {
  id: DemoRoleId;
  label: string;
  description: string;
  /** The organizations-module tenant role the persona holds in its demo tenant. */
  tenantRole: 'owner' | 'admin' | 'member';
  /** Which capabilities this role sees in the demo world (ordered, stable). */
  capabilities: readonly DemoCapabilityId[];
}

/** The identifier of one major product journey (plan §2 A–L, plus the shared substrate). */
export type DemoJourneyId =
  | 'demo-world'
  | 'manager-onboarding'
  | 'employee-chat'
  | 'unprompted-discovery'
  | 'risk-investigation'
  | 'consequential-approval'
  | 'employee-contribution'
  | 'connect-company'
  | 'configure-ai'
  | 'agent-recruitment'
  | 'marketplace'
  | 'explainability'
  | 'developer-console';

/** One seeded journey: what it is, which role walks it, which anchors it seeds. */
export interface DemoJourney {
  id: DemoJourneyId;
  /** The plan §2 letter this journey implements ('·' for the shared substrate). */
  ref: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | '·';
  title: string;
  description: string;
  primaryRole: DemoRoleId;
  /** Additional roles that exercise parts of the journey. */
  alsoExercisedBy: readonly DemoRoleId[];
  /**
   * Every anchor key the harness seeds for this journey. The seed is
   * complete exactly when each of these exists — the deterministic-data
   * acceptance (work item: "deterministic data for every major journey").
   */
  anchorKeys: readonly string[];
}

/** One demo tenant of the deterministic world. */
export interface DemoTenantSpec {
  /** Stable harness key ('company' | 'vendor' | 'platform'). */
  key: 'company' | 'vendor' | 'platform';
  name: string;
  slug: string;
  defaultWorkspaceName: string;
}

/** One demo persona of the deterministic world. */
export interface DemoPersonaSpec {
  /** The demo role the persona plays. */
  role: DemoRoleId;
  tenantKey: 'company' | 'platform';
  fullName: string;
  email: string;
  title: string;
  /** The tenant role granted to the persona (mirrors DemoRole.tenantRole). */
  tenantRole: 'owner' | 'admin' | 'member';
}

/** One recorded seed anchor: (journey, key) → the seeded record id. */
export interface DemoAnchor {
  journeyId: DemoJourneyId;
  anchorKey: string;
  /** The primary seeded record id (uuid) the anchor points at. */
  recordId: string;
  /** Secondary ids and deterministic facts (e.g. every observation id of a case). */
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** A seeded tenant as the seed report carries it. */
export interface DemoSeedTenant {
  key: DemoTenantSpec['key'];
  id: string;
  name: string;
  slug: string;
}

/** A seeded persona as the seed report carries it. */
export interface DemoSeedPersona {
  role: DemoRoleId;
  email: string;
  principalId: string;
  tenantKey: DemoPersonaSpec['tenantKey'];
  tenantRole: DemoPersonaSpec['tenantRole'];
}

/** The result of one seeding run (the harness's own directory). */
export interface DemoSeedReport {
  seededAt: string;
  tenants: DemoSeedTenant[];
  personas: DemoSeedPersona[];
  /** Every journey with its anchors (only journeys that seeded something). */
  journeys: { id: DemoJourneyId; title: string; anchors: DemoAnchor[] }[];
  /** The pending action requests the demo world leaves for the manager. */
  pendingApprovals: { actionKind: string; requestId: string }[];
  /** Anchors newly created by this run vs. already present (idempotent re-runs). */
  created: number;
  skipped: number;
}

/** The environment inputs of the non-production gate (pure; no I/O). */
export interface DemoSeedGateInput {
  /** AURUM_DB when explicitly set ('embedded' | 'postgres' | undefined). */
  backend: 'embedded' | 'postgres' | undefined;
  /** DATABASE_URL when set (any value means a server database is configured). */
  databaseUrl: string | undefined;
  /** AURUM_DB_MEMORY (the test-harness mode). */
  memoryMode: boolean;
  /** AURUM_DEMO_SEED — the explicit opt-in for the embedded dev database. */
  optIn: boolean;
  /** NODE_ENV — 'production' refuses unconditionally. */
  nodeEnv: string | undefined;
}

/** The gate's decision. */
export type DemoSeedGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: 'production_backend' | 'production_runtime' | 'opt_in_required';
      reason: string;
    };
