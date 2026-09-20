// ============================================================================
// demo — the ONLY public surface of the demo module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W068 — Deterministic Demo Tenant & Role Journey Harness (spec/work-items/
// WORK-ITEM-CATALOG.md): "Provide non-production seeded tenants/roles for
// browser verification. Roles: manager; employee; developer; platform
// reviewer. Acceptance: no production backdoor; deterministic data for
// every major journey; role-specific capability visibility."
//
// The demo module is a HARNESS over the domain contracts, not a source of
// organizational truth: it owns no business records (its single table is
// the seed-anchor registry), exposes no HTTP surface, and adds no
// authority vocabulary. Browser verification signs the personas in
// through the real auth flow; the harness itself only seeds.
//
// Public surface, three halves:
//   * the STATIC directory (pure, no database) — the deterministic
//     manifest (tenants/personas), the four roles with their capability
//     visibility matrix, and the journey catalog (plan §2 A–L with the
//     anchor keys each journey seeds). W070 can plan entirely from this;
//   * the GATE (pure) — the non-production decision every seeding run
//     must pass (no production backdoor);
//   * the SEED + DIRECTORY READ — `seedDemoHarness()` materializes the
//     world through module contracts (idempotent per anchor) and returns
//     the report; `readDemoJourneyAnchors` reads one tenant's seeded
//     anchors back.
// ============================================================================

export { seedDemoHarness, readDemoJourneyAnchors } from './seed';

export { evaluateDemoSeedGate } from './gate';

// The static directory (pure).
export { assertManifestConsistency } from './manifest';
export {
  DEMO_PASSWORD_FRAGMENTS,
  DEMO_PERSONAS,
  DEMO_TENANTS,
  DEMO_TIME,
  DEMO_KEYS,
  demoPersonaPassword,
  demoPersonaSpec,
  demoTenantSpec,
} from './manifest';
export {
  DEMO_CAPABILITIES,
  DEMO_ROLES,
  capabilityVisibilityForRole,
  demoCapability,
  demoRole,
  demoRoles,
  roleSeesCapability,
} from './roles';
export {
  DEMO_JOURNEYS,
  demoAnchorKeys,
  demoJourney,
  demoJourneys,
} from './journeys';

export { DemoError } from './errors';
export type { DemoErrorCode } from './errors';

export type {
  DemoAnchor,
  DemoCapability,
  DemoCapabilityId,
  DemoClaimSource,
  DemoJourney,
  DemoJourneyId,
  DemoPersonaSpec,
  DemoRole,
  DemoRoleId,
  DemoSeedGateDecision,
  DemoSeedGateInput,
  DemoSeedPersona,
  DemoSeedReport,
  DemoSeedTenant,
  DemoTenantSpec,
} from './types';
