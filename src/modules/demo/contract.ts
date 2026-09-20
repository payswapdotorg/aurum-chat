// ============================================================================
// demo — the ONLY public surface of the demo harness module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W068 — Deterministic Demo Tenant & Role Journey Harness:
// "Provide non-production seeded tenants/roles for browser verification.
//  Roles: manager; employee; developer; platform reviewer. Acceptance:
//  no production backdoor; deterministic data for every major journey;
//  role-specific capability visibility."
//
// WHAT THIS MODULE OWNS
//   * the guard — the non-production database + explicit-opt-in gate every
//     seed operation passes FIRST (no production backdoor);
//   * the four deterministic demo roles, their account/company bindings
//     and the DERIVED role→capability visibility model (roles.ts — derived
//     from the real authority model, never a parallel one);
//   * the deterministic journey dataset (seed.ts) — every major product
//     journey (plan §2, Journeys A–L) seeded through module contracts only;
//   * the manifest — the real record ids a browser operator (or W070's
//     journey matrix) verifies against.
//
// WHAT THIS MODULE DELIBERATELY IS NOT
//   * a second source of organizational truth — it composes the existing
//     domain contracts and adds no tables of its own;
//   * an authentication path — the demo accounts are ordinary principals
//     that sign in through the auth module like everyone else;
//   * a product surface — it owns no routes; the product reads whatever
//     the domain modules now hold.
// ============================================================================

export { seedDemoHarness } from './seed';

export {
  assertDemoSeedAllowed,
  DEMO_SEED_DB_ENV,
  DEMO_SEED_ENV,
  demoSeedEnvironment,
  isDemoOptedIn,
  isDemoSeedAllowed,
  isEmbeddedDatabase,
} from './guard';
export type { DemoSeedEnvironment } from './guard';

export {
  DEMO_ACCOUNTS,
  DEMO_CAPABILITIES,
  DEMO_COMPANIES,
  DEMO_ROLES,
  capabilitiesForRole,
  demoRoleDirectory,
  demoSessionClaims,
  demoSharedPassword,
  demoTenantRole,
  isDemoRole,
  visibleCapabilityKeys,
} from './roles';
export type { DemoRoleDirectoryEntry } from './roles';

export { DemoError } from './errors';
export type { DemoErrorCode } from './errors';

export type {
  DemoAccountRef,
  DemoAccountSpec,
  DemoCapability,
  DemoCapabilityVia,
  DemoCapabilityVisibility,
  DemoCompanyId,
  DemoCompanySpec,
  DemoManifest,
  DemoRole,
  DemoSeedReport,
} from './types';
