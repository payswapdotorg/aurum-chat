// W079 — the release-certification module's type model.
//
// A VERIFICATION HARNESS in the W068/W070/deployment-smoke sense: no
// tables, no migrations, no HTTP surface of its own, no authority
// vocabulary, no product behavior. It owns the typed proof material for
// the production journey certification: the J01–J15 journey matrix, the
// G1–G3 gate observations, the deployment identity, the two-run
// same-revision rule and the verdict vocabulary — the contract's exact
// discipline (spec/PRODUCTION-JOURNEY-CERTIFICATION-2026-09-23.md).

/** The journey ids of the mandatory production matrix (contract §5 + W101 §5). */
export type JourneyId =
  | 'J01'
  | 'J02'
  | 'J03'
  | 'J04'
  | 'J05'
  | 'J06'
  | 'J07'
  | 'J08'
  | 'J09'
  | 'J10'
  | 'J11'
  | 'J12'
  | 'J13'
  | 'J14'
  | 'J15'
  | 'J16'
  | 'J17'
  | 'J18'
  | 'J19'
  | 'J20'
  | 'J21'
  | 'J22';

/**
 * The certification program (W101): 'W079' is the frozen historical
 * program — the J01–J15 matrix, the W079 evidence root and the W079
 * document names; 'W101' is the post-S002 program — the full J01–J22
 * matrix, the W101 evidence root, the W101 repository identity and the
 * rollback-evidence gate. The catalog itself is ONE closed list; the
 * program selects which journeys are MANDATORY for a run (J01–J15 stay
 * mandatory in both).
 */
export type CertificationProgram = 'W079' | 'W101';

/** One journey's matrix definition (contract §5, verbatim semantics). */
export interface JourneySpec {
  id: JourneyId;
  /** The user journey's short name (contract §5 column 2). */
  title: string;
  /** The mandatory proof (contract §5 column 3). */
  mandatoryProof: string;
  /** Which browser contexts the journey must be exercised in. */
  contexts: readonly BrowserContextKind[];
  /** The surfaces the journey crosses (documentation only, never load-bearing). */
  surfaces: readonly string[];
}

/** The two browser contexts the contract requires (G3). */
export type BrowserContextKind = 'desktop' | 'mobile';

/** The certification verdict vocabulary (contract §2/§11 — exact words). */
export type CertificationVerdictKind = 'CERTIFIED READY' | 'BLOCKED' | 'FAILED';

/**
 * A gate/journey/check outcome. The certification vocabulary is strictly
 * three-valued: PASS (observed as specified), FAIL (the deployed system
 * violated the contract — a real defect), BLOCKED (a documented external
 * precondition is missing — never a system defect). A BLOCKED result can
 * never be converted to PASS (contract §2).
 */
export type CertificationStatus = 'pass' | 'fail' | 'blocked';

/** One recorded check of a certification run (gates, journeys, helpers). */
export interface CertificationCheck {
  id: string;
  title: string;
  status: CertificationStatus;
  /** Precise observation: what was seen, in the machine-generated report. */
  detail: string;
  /** Sanitized evidence (never a secret value). */
  evidence?: Record<string, unknown>;
}

/** The health-shape observation G1 reads (defensive over the real body). */
export interface G1HealthObservation {
  httpStatus: number;
  healthStatus: string | null;
  environment: string | null;
  hostedOnVercel: boolean | null;
  dbBackend: string | null;
  dbMigrations: number | null;
  dbError: string | null;
  queueBackend: string | null;
  cacheBackend: string | null;
  lockBackend: string | null;
  emailBackend: string | null;
  blobBackend: string | null;
  refusals: string[];
  warnings: string[];
  workerMetrics: Record<string, unknown> | null;
}

/** The production deployment identity (contract §3 — all ten fields). */
export interface DeploymentIdentity {
  /** 1. production hostname. */
  hostname: string;
  /** 2. Vercel deployment id (operator-supplied, verified read-only). */
  deploymentId: string;
  /** 3. deployed commit SHA. */
  commitSha: string;
  /** 4. deployment creation time (ISO). */
  deploymentCreatedAt: string;
  /** 5. certification timestamp (run start, ISO). */
  certificationStartedAt: string;
  /** 6. environment label reported by the application. */
  environmentLabel: string | null;
  /** 7. database backend class reported by health. */
  databaseBackendClass: string | null;
  /** 8. worker/runtime configuration state. */
  workerRuntimeState: {
    seamTokenGated: boolean | null;
    snapshotReachable: boolean | null;
    environment: string | null;
    queueDepth: number | null;
  };
  /** 9. the exact command and arguments that produced the run. */
  command: string;
  /** 10. GitHub repository state used to interpret the result. */
  repository: {
    remote: string;
    branch: string;
    baseCommit: string;
    headCommit: string;
  };
}

/** One journey's result inside one certification run. */
export interface JourneyResult {
  journeyId: JourneyId;
  status: CertificationStatus;
  /** Which contexts ran and their Playwright verdicts. */
  contexts: { context: BrowserContextKind; status: CertificationStatus; detail: string }[];
  /** The per-context Playwright test ids that made up the journey. */
  testIds: string[];
  /** Repo-relative evidence paths (transcripts/screenshots/errors). */
  transcripts: string[];
  screenshots: string[];
  errorCaptures: string[];
  /** Failure detail (status fail) or the external precondition (blocked). */
  detail: string;
}

/** The run summary (contract §7 — the four numbers that must all be 0). */
export interface RunSummary {
  passed: number;
  failed: number;
  blocked: number;
  flaky: number;
  unexpected: number;
}

/** One complete certification run (Run A or Run B). */
export interface CertificationRunResult {
  runLabel: 'A' | 'B';
  /** The certification program this run belongs to ('W079' historical, 'W101' post-S002). */
  program: CertificationProgram;
  startedAt: string;
  finishedAt: string;
  target: string;
  identity: DeploymentIdentity;
  /** G1–G3 gate checks. */
  gates: CertificationCheck[];
  /** The G2 repository gate tails (command + summary line each). */
  repoGates: { command: string; exitCode: number | null; summary: string }[];
  /** The W078 hosted smoke rerun embedded as operations proof (§8). */
  w078: {
    label: string;
    summary: { total: number; passed: number; failed: number; blocked: number; skipped: number };
    reportPath: string | null;
  } | null;
  /** The J01–J15 results (W079) or the full J01–J22 results (W101). */
  journeys: JourneyResult[];
  summary: RunSummary;
  verdict: CertificationVerdictKind;
  /** The exact command line that produced this run (contract §3.9). */
  command: string;
  /** The evidence directory (repo-relative). */
  evidenceDir: string;
}

/** The final two-run certification outcome. */
export interface FinalCertification {
  verdict: CertificationVerdictKind;
  runA: CertificationRunResult | null;
  runB: CertificationRunResult | null;
  /** Why the verdict is not CERTIFIED READY (empty when it is). */
  reasons: string[];
  /** The checks the finalizer itself ran (same-revision, agreement…). */
  checks: CertificationCheck[];
  generatedAt: string;
}

/** The browser runner's machine-readable result (the Playwright digest). */
export interface BrowserRunDigest {
  /** Playwright suite totals. */
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /** Per-test outcomes, keyed by the W079 test id (j01-entry:desktop …). */
  tests: {
    testId: string;
    journeyId: JourneyId;
    context: BrowserContextKind;
    status: 'pass' | 'fail' | 'flaky' | 'skipped';
    title: string;
    file: string;
    durationMs: number;
    error: string | null;
    /**
     * The honest BLOCKED channel (W101): a test that PASSED at the
     * Playwright level may still record machine-checkable reasons why a
     * mandatory surface of its journey does not exist in the deployed
     * revision. The folding maps a journey whose tests carry non-empty
     * blockedReasons to journey status 'blocked' — which can never be
     * laundered to PASS (the run verdict and the final verdict both stay
     * BLOCKED). Absent/empty for every W079 journey (J01–J15 untouched).
     */
    blockedReasons?: string[];
    /** Machine-checkable probe results backing the blocked reasons. */
    blockedEvidence?: Record<string, unknown>;
  }[];
  /** The zero-violation record across every journey (browser error captures). */
  violations: { testId: string; violations: number }[];
  /** Evidence inventory the fixture wrote (repo-relative). */
  evidence: {
    transcripts: string[];
    screenshots: string[];
    errorCaptures: string[];
    results: string[];
  };
}
