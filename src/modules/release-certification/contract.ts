// ============================================================================
// release-certification — the ONLY public surface of the module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W079 — Production Journey Certification & Release Gate (spec/work-items/
// WORK-ITEM-CATALOG.md): "Certify the complete end-user journey matrix
// against the real hosted production deployment. Require real production
// authentication, external PostgreSQL/Redis execution paths, desktop/mobile
// Chromium journeys, tenant isolation, Chat-first continuity,
// accessibility/discoverability, and two consecutive zero-failure/
// zero-blocked runs against the same deployment revision."
//
// This module is a VERIFICATION HARNESS in the W068/W070/deployment-smoke
// sense: no tables, no HTTP surface of its own, no authority vocabulary,
// no product behavior. It owns the typed proof material — the J01–J15
// matrix, the G1–G3 gate evaluations, the deployment identity model, the
// W078 composition, the two-run same-revision verdict and the evidence
// renderers. EXECUTION surfaces:
//   * the operator CLI — `bun run cert:production` (scripts/release-certification.ts);
//   * the browser suite — tests/browser/production/** (the W076 layer
//     extended for real production authentication), registered through
//     playwright.certification.config.ts;
//   * evidence runs — docs/productization-evidence/W079/**.
// ============================================================================

// The driver (one full certification pass: G1–G3 + the journey matrix).
export { runCertificationPass } from './driver';
export type { CertificationRunConfig } from './driver';

// The journey matrix (pure).
export {
  JOURNEY_MATRIX,
  JOURNEYS_LEAVING_CHAT,
  journeySpec,
  matrixConsistency,
  requiredBrowserTests,
} from './matrix';

// The verdict engine (pure).
export {
  G2_REPO_GATES,
  finalVerdict,
  gateOneReasons,
  gateThreeReasons,
  journeyInventoryReasons,
  journeyResultsFromDigest,
  quickSignInOffReasons,
  runVerdict,
  summarizeRun,
  w078RerunReasons,
  workerAuthorizationReasons,
} from './verdict';

// The identity model (pure adapters).
export {
  deploymentFromListing,
  deploymentIdentity,
  identityVerificationReasons,
  observeG1Health,
} from './identity';

// The evidence renderers (pure).
export {
  commandManifestToJson,
  finalCertificationToMarkdown,
  finalVerdictToJson,
  identityManifestToJson,
  runReportToMarkdown,
  runResultToJson,
} from './report';

export type {
  BrowserContextKind,
  BrowserRunDigest,
  CertificationCheck,
  CertificationRunResult,
  CertificationStatus,
  CertificationVerdictKind,
  DeploymentIdentity,
  FinalCertification,
  G1HealthObservation,
  JourneyId,
  JourneyResult,
  JourneySpec,
  RunSummary,
} from './types';
