// ============================================================================
// journey-proof — the ONLY public surface of the module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W070 — Browser Journey, Accessibility & Discoverability Proof
// (spec/work-items/WORK-ITEM-CATALOG.md): "Automate the end-user journey
// matrix on desktop and mobile", acceptance: first-run onboarding;
// manager chat; employee chat; goal → unknown → mission;
// evidence/explainability; recommendation → approval → outcome; learning
// contribution/reward; connections; BYOA; agent recruitment; marketplace;
// developer/API/MCP; mobile navigation; accessibility; no dead-end pages;
// every architecture capability has a discoverable user route.
//
// This module is a VERIFICATION HARNESS in the W068 demo-module sense:
// no tables, no HTTP surface, no authority vocabulary, no product
// behavior. It owns the typed proof material —
//   * the journey matrix (every acceptance bullet as steps over the real
//     routes, desktop AND mobile, with the demo personas);
//   * the route catalog (every user-facing route of this base);
//   * the capability discoverability map (every src/modules module → its
//     user routes and discovery surfaces);
//   * the accessibility rule set + the HTML/CSS audit engine;
//   * the link-graph evaluators (dead ends, broken links, mobile
//     reachability) and the proof-report assembly.
//
// The EXECUTION lives in tests/e2e/journeys/** (the cross-cutting
// verification location of this repository, per IMPLEMENTATION-STACK §7 —
// W070 is a verification item): those suites boot the embedded
// PostgreSQL, seed the W068 demo world through its contract, sign the
// personas in through the real auth flow, render the real pages to the
// HTML a browser would receive, drive the real API handler libs with the
// session cookie, and feed the evidence to THIS module's evaluators.
// ============================================================================

// The journey matrix (pure).
export { JOURNEY_MATRIX, JOURNEY_IDS } from './matrix';
export {
  W070_ACCEPTANCE_BULLETS,
  auditJourneys,
  journeysForViewport,
  journeySpec,
  matrixConsistency,
  walkableJourneys,
} from './matrix';

// The route catalog (pure).
export {
  MOBILE_AREAS,
  ROUTE_CATALOG,
  apiRoutes,
  findRouteForPath,
  hasRoute,
  matchRoutePattern,
  mobileDrillDownRoutes,
  mobileNavRoutes,
  pageRoutes,
  routeSpec,
} from './routes';

// The capability discoverability map (pure).
export {
  CAPABILITY_ROUTES,
  capabilityFor,
  capabilityRouteGaps,
  evaluateMobileReachability,
} from './discoverability';

// The accessibility rule set + audit engine (pure).
export { A11Y_RULES, a11yRule, auditHtml, auditSources, extractPageLinks } from './a11y';

// The HTML inspection utilities (pure).
export {
  accessibleName,
  allTags,
  decodeEntities,
  elementEnd,
  findTagById,
  findTags,
  isHiddenTag,
  isInternalHref,
  resolveHref,
  stripQueryAndHash,
  textContent,
} from './html';

// The proof-report assembly (pure).
export {
  deadEndViolations,
  failingResult,
  passingResult,
  reportComplete,
  reportSummary,
} from './report';

export type { ParsedTag } from './html';

// The public types.
export type {
  A11yAuditOptions,
  A11yRule,
  A11yRuleId,
  A11yViolation,
  CapabilityRoute,
  DiscoverableSurface,
  JourneyActor,
  JourneyId,
  JourneyKind,
  JourneyProofReport,
  JourneyProofResult,
  JourneySpec,
  JourneyStep,
  LinkInfo,
  MobileAreaId,
  MobileReachability,
  PageLinkProof,
  RouteArea,
  RouteAuth,
  RouteKind,
  RouteSpec,
  StepVia,
  Viewport,
} from './types';
