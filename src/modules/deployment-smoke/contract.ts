// ============================================================================
// deployment-smoke — the ONLY public surface of the module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W078 — Post-Deployment Smoke and Operations Proof (spec/work-items/
// WORK-ITEM-CATALOG.md): "Prove the hosted dogfood environment through
// real authentication, onboarding, chat, seeded journeys, durable
// execution retry/idempotency, health/readiness, queue/worker
// observability and release/rollback checks."
//
// This module is a VERIFICATION HARNESS in the W068/W070 sense: no
// tables, no HTTP surface of its own, no authority vocabulary, no
// product behavior. It owns the typed proof material — the check
// catalog, the pure expectation evaluators, the repo-surface checks,
// the HTTP driver and the report model. EXECUTION surfaces:
//   * the operator CLI  — `bun run smoke:dogfood` (scripts/deployment-smoke.ts);
//   * the integration suite — tests/e2e/deployment-smoke/** (the full
//     matrix proven green against a handler-mounted real HTTP server);
//   * evidence runs     — docs/productization-evidence/W078/**.
// ============================================================================

// The driver (the one-call smoke run over a hosted target).
export { runDeploymentSmoke } from './driver';

// The check catalog (pure).
export {
  W078_ACCEPTANCE_BULLETS,
  catalogConsistency,
  checksForAcceptance,
  smokeCheck,
  smokeChecks,
} from './catalog';
export type { SmokeCheckSpec } from './catalog';

// The pure expectation evaluators.
export {
  anonymousGateReasons,
  anonymousSessionReasons,
  approvalCardReasons,
  approvalDecidedReasons,
  authenticatedRootReasons,
  chatGatedNoCompanyReasons,
  chatStateReasons,
  chatTurnReasons,
  companyCreatedReasons,
  healthContractReasons,
  healthGreenReasons,
  healthHonestRefusalReasons,
  observeHealth,
  observeWorkerPush,
  observeWorkerSnapshot,
  observabilitySurfacesAgreeReasons,
  pageRendersReasons,
  quickSignInReasons,
  retryPolicySurfaceReasons,
  sessionIssuedReasons,
  sessionNoCompanyReasons,
  workerAuthFailClosedReasons,
  workerMetricsAdvancedReasons,
  workerOutcomeReasons,
  workerSnapshotReasons,
} from './expectations';

// The HTTP client (transport only).
export { SmokeHttpClient, sessionCookieHeader, sessionTokenFromSetCookie } from './http';
export type { SmokeHttpResponse } from './http';

// The repo-layer checks (read-only).
export {
  checkBrowserSuiteRegistered,
  checkCiGates,
  checkDemoGateSeparation,
  checkDeploymentConfig,
  checkEnvironmentMatrix,
  checkKnownGoodDeployment,
  checkRollbackRunbook,
} from './repo';
export type { RepoCheckOutcome } from './repo';

// The report model (pure).
export { reportToJson, reportToMarkdown, smokeExitCode, summarize } from './report';

export type {
  GuardrailObservation,
  HealthObservation,
  QuickSignInExpectation,
  SmokeCategory,
  SmokeCheckResult,
  SmokeCheckStatus,
  SmokeLayer,
  SmokeProfile,
  SmokeReport,
  SmokeRunConfig,
  SmokeSummary,
  WorkerCounters,
  WorkerPushObservation,
  WorkerSnapshotObservation,
} from './types';
