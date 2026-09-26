// Public domain types of the S003 Longitudinal Conversion Benchmark (W100).
//
// S003 re-runs the S002 multi-industry switching study with capabilities
// MEASURED, not assumed. These types define (a) the pure population design
// (s003-world.ts), (b) the MEASURED inputs the harness collects by
// composing the real module contracts, and (c) the canonical result
// document the harness commits under tests/longitudinal/s003/results/
// (versioned by the schema of record — tests/longitudinal/s003/schema).
//
// The measured inputs deliberately carry NO hidden values: every field is
// an observable behavior record (steps, counts, rates, costs, statuses)
// read through public contracts. The hidden consequential facts stay
// behind the simulator's evaluation surface and never feed a factor.

import type { S003FactorKey, S003LeverKey, S003Role } from './s003-world';

// ---------------------------------------------------------------------------
// Population design (pure — s003-world.ts)
// ---------------------------------------------------------------------------

/** One incumbent system of an industry's anchor stack. */
export interface S003IncumbentSystemSpec {
  key: string;
  displayName: string;
  /** The canonical W036 connector provider the anchor maps onto. */
  provider: string;
  /** W081 capability-class registry keys (1..2). */
  capabilityClasses: readonly string[];
}

/** One industry world (the S002 anchors as committed design constants). */
export interface S003IndustrySpec {
  key: string;
  label: string;
  incumbentAnchor: string;
  /** S002 population constant: dependence on the incumbent system of record. */
  incumbentSoRDependence: number;
  /** S002 population constant: specialist-domain dependence. */
  specialistDependence: number;
  /** S002 population constant: compliance/security constraint intensity. */
  complianceConstraint: number;
  systems: readonly S003IncumbentSystemSpec[];
  /** The REAL W092 starter kit that ships for this industry (null: none). */
  verticalKitKey: string | null;
  /** The stack includes private/on-prem systems (the W088 edge lever fires). */
  onPrem: boolean;
  /** The anchor system with no usable API (the W093 browser lever fires). */
  browserFallbackSystem: string | null;
}

/** One firm size (the S002 size cohorts). */
export interface S003SizeSpec {
  key: 'small' | 'medium' | 'large';
  label: string;
  rosterSize: number;
  /** S002 population constant: firm-size migration friction (F20). */
  migrationFriction: number;
}

/** One professional of the synthetic population. */
export interface S003ProfessionalSpec {
  index: number;
  role: S003Role;
  /** The deterministic personal-affinity draw in [-1, 1] (committed design). */
  affinityDraw: number;
}

/** One firm of the cohort. */
export interface S003FirmSpec {
  key: string;
  industryIndex: number;
  industry: S003IndustrySpec;
  sizeIndex: number;
  size: S003SizeSpec;
  seed: number;
  professionals: readonly S003ProfessionalSpec[];
}

/** One of S002's seven maturation assumptions, labeled by real maturity. */
export interface S003MaturationAssumption {
  key: string;
  label: string;
  /** 'real' | 'partial' | 'none' — what is implemented at the base SHA. */
  maturity: 'real' | 'partial' | 'none';
  /** The exact module contracts the lever rides (empty for 'none'). */
  contracts: readonly string[];
  note: string;
}

/** One mature-scenario lever with its contract citations. */
export interface S003MatureLever {
  key: S003LeverKey;
  label: string;
  contracts: readonly string[];
}

// ---------------------------------------------------------------------------
// Measured inputs (what the harness collects from the run)
// ---------------------------------------------------------------------------

/** One advanced month's measured behavior (MonthReport + W055 snapshot). */
export interface S003MonthMeasurement {
  month: number;
  topic: string;
  /** MonthReport.steps — the acquisition walk's plan count. */
  steps: number;
  firstChoiceKind: 'person' | 'system' | null;
  firstChoiceLabel: string | null;
  /** W055 source-selection family. */
  firstChoiceCorrect: number | null;
  firstChoiceTotal: number;
  /** W055 mission-resolution-efficiency family. */
  medianSteps: number | null;
  meanSteps: number | null;
  /** W055 recommendation-calibration family. */
  predictionErrorMean: number | null;
  metOrExceededRate: number | null;
  /** W055 realized-value family. */
  realizedValueSum: number | null;
  netVarianceSum: number | null;
  /** W055 investigation-cost family (minor units of the mission currency). */
  windowPlans: number | null;
  windowCostMinor: number | null;
  /** W055 evidence-quality family. */
  observations: number | null;
  meanConfidence: number | null;
  shareWithConfidenceBasis: number | null;
  /** Whether the driver recorded the month's CompanyModel update. */
  learningRecorded: boolean;
}

/** The loop-level aggregates the factors consume (all measured). */
export interface S003LoopMeasurement {
  months: readonly S003MonthMeasurement[];
  totalSteps: number;
  meanSteps: number;
  /** Correct first choices / judged months (months 1..N). */
  firstChoiceCorrectRate: number;
  /** Mean recommendation prediction error over the months. */
  meanPredictionError: number;
  evidenceMeanConfidence: number;
  evidenceShareWithConfidenceBasis: number;
  totalRealizedValueSum: number;
  meanNetVariance: number;
  totalWindowCostMinor: number;
  /** The monthly interventions executed (MonthReport.intervention count). */
  interventionsExecuted: number;
  /**
   * Measured participation per role: acquisitions answered by the role's
   * reference employee + messages sent by that employee, over the months.
   */
  participationByRole: Readonly<Record<S003Role, number>>;
  /** Distinct channels the loop's own recorded messages carried (measured). */
  channelsOfLoop: number;
}

/**
 * The composed-capability measurements (MATURE scenario only; the baseline
 * composes nothing and reports the all-zero shape with measured manual-path
 * facts). Every count is a recorded row of the run.
 */
export interface S003ComposedMeasurement {
  /** Measured invocation count per mature lever (asserted > 0 when due). */
  leverInvocations: Readonly<Record<S003LeverKey, number>>;
  /** The composed effort model inputs (all measured). */
  effort: {
    contractCalls: number;
    /** Human decisions through authority gates / review claims. */
    approvals: number;
    /** Tick-clock minutes between the first and last composed call. */
    elapsedSimulatedMinutes: number;
  };
  coverage: {
    systemsDiscovered: number;
    systemsConnected: number;
    systemsVerified: number;
    /** Systems whose write path the deep action actually exercised. */
    systemsWithWritePath: number;
    /** Distinct channels with recorded evidence (chat/email/SMS/meetings). */
    channelsWithEvidence: number;
  };
  deepAction: {
    tasks: number;
    operations: number;
    opsExecuted: number;
    opsReconciledClean: number;
    opsMismatched: number;
    preStateEvidence: number;
    postStateEvidence: number;
    mismatchUnknowns: number;
  };
  migration: {
    roundsCommitted: number;
    recordsImported: number;
    identifierMappings: number;
    conflictsSurfaced: number;
    divergencesSurfaced: number;
  };
  kit: {
    installed: boolean;
    active: boolean;
    capabilitiesInvoked: number;
  };
  browser: {
    tasks: number;
    stepsVerified: number;
  };
  edge: {
    jobsIssued: number;
    jobsSucceeded: number;
  };
  channels: {
    messagesOutbound: number;
    smsReachAttempts: number;
    meetingsIngested: number;
  };
  supervision: {
    agentsSupervised: number;
    executionsAdmitted: number;
    healthObservations: number;
  };
  trust: {
    /** W009 action-gate decisions recorded (any kind). */
    gateDecisionsRecorded: number;
    /** W009 action requests submitted for a human decision. */
    actionRequestsSubmitted: number;
    /** Verification runs with a clean (verified) outcome. */
    verificationRunsClean: number;
    verificationRunsTotal: number;
    /** Distinct append-only ledgers with entries this scenario drove. */
    auditLedgersWithEntries: number;
  };
}

// ---------------------------------------------------------------------------
// Canonical results (the committed raw-results shape)
// ---------------------------------------------------------------------------

/** The per-professional factor scores and willingness outcomes. */
export interface S003ProfessionalResult {
  role: S003Role;
  /** roleFit — factor 4 (the per-professional measured factor). */
  roleFit: number;
  /** roleSwitchEase — factor 11 (the per-professional role factor). */
  roleSwitchEase: number;
  /** The committed personal-affinity draw applied to both. */
  affinityDraw: number;
  score: number;
  willingOnly: boolean;
  willingPrimary: boolean;
}

/** One firm-scenario's canonical result (deterministic; no ids/timestamps). */
export interface S003FirmScenarioResult {
  scenario: 'baseline' | 'mature';
  seed: number;
  months: readonly S003MonthMeasurement[];
  loop: S003LoopMeasurement;
  /** The measured composed capabilities (mature) or measured manual-path facts (baseline). */
  composed: S003ComposedMeasurement;
  /** The eleven S002 factors, oriented so higher = more willing. */
  factors: Readonly<Record<S003FactorKey, number>>;
  professionals: readonly S003ProfessionalResult[];
  measurements: {
    /** Measurement 3 — context-switching reduction (0..1 + raw counts). */
    contextSwitching: {
      switchesAvoidedPerTask: number;
      reductionVsNoAurum: number;
      manualExecutions: number;
      composedExecutions: number;
      amortizedSetupSwitches: number;
    };
    /** Measurement 4 — integration setup effort (labeled by origin). */
    setupEffort: {
      origin: 'baseline-cost-model' | 'measured';
      minutes: number;
      steps: number;
      approvals: number;
      perSystemMinutes: number;
    };
    /** Measurement 5 — trust (composed from measured surfaces). */
    trust: {
      score: number;
      evidenceConfidenceBasis: number;
      gateDiscipline: number;
      verificationLedger: number;
      evidenceChain: number;
      auditTrail: number;
      attentionRecords: number;
    };
    /** Measurement 6 — realized value (the W055 families + attribution). */
    realizedValue: {
      realizedValueSum: number;
      netVarianceSum: number;
      meanPredictionError: number;
      missionCostMinor: number;
      /** The share of realized value attributable to Aurum-composed execution. */
      attributableShare: number;
    };
  };
}

/** One firm's pairwise deliverable: baseline vs mature. */
export interface S003FirmResult {
  key: string;
  industryKey: string;
  industryLabel: string;
  sizeKey: 'small' | 'medium' | 'large';
  seed: number;
  baseline: S003FirmScenarioResult;
  mature: S003FirmScenarioResult;
  delta: {
    aurumOnlyShare: number;
    aurumPrimaryShare: number;
    latentScoreMean: number;
    contextSwitchingReduction: number;
    setupEffortMinutes: number;
    trust: number;
    attributableRealizedShare: number;
  };
  /** Which mature levers fired for THIS firm (industry-conditional). */
  leversComposed: readonly S003LeverKey[];
  /** Partial-maturity labels for this firm's un-realized assumptions. */
  partialMaturity: readonly string[];
}

/** A cohort aggregate over one scenario. */
export interface S003CohortScenarioAggregate {
  professionals: number;
  aurumOnlyShare: number;
  aurumPrimaryShare: number;
  latentScoreMean: number;
  trustMean: number;
  setupEffortMinutesMean: number;
  contextSwitchingReductionMean: number;
  attributableRealizedShareMean: number;
  byIndustry: ReadonlyArray<{
    industryKey: string;
    professionals: number;
    aurumOnlyShare: number;
    aurumPrimaryShare: number;
  }>;
  bySize: ReadonlyArray<{
    sizeKey: 'small' | 'medium' | 'large';
    professionals: number;
    aurumOnlyShare: number;
    aurumPrimaryShare: number;
  }>;
}

/** The full canonical S003 results document (schema of record: version 1). */
export interface S003Results {
  schemaVersion: 1;
  benchmarkId: 's003-longitudinal-conversion';
  study: 'S003 — re-run of the S002 multi-industry switching study with capabilities measured';
  interpretation: string;
  design: {
    monthsPerScenario: number;
    projectsPerMonth: number;
    matureStateProjects: number;
    cohort: { industries: number; sizes: number; firms: number; professionals: number };
    factorWeights: Readonly<Record<S003FactorKey, number>>;
    scoreIntercept: number;
    thresholdOnly: number;
    thresholdPrimary: number;
    heterogeneitySigma: number;
    baselineCostModel: Readonly<Record<string, number>>;
    maturityCredits: Readonly<Record<string, number>>;
    channelSurface: number;
    maturationAssumptions: readonly S003MaturationAssumption[];
    matureLevers: readonly S003MatureLever[];
  };
  firms: readonly S003FirmResult[];
  cohort: {
    baseline: S003CohortScenarioAggregate;
    mature: S003CohortScenarioAggregate;
    headline: {
      aurumOnlyShare: { baseline: number; mature: number; delta: number };
      aurumPrimaryShare: { baseline: number; mature: number; delta: number };
      contextSwitchingReduction: { baseline: number; mature: number; delta: number };
      setupEffortMinutes: { baseline: number; mature: number; delta: number };
      trust: { baseline: number; mature: number; delta: number };
      attributableRealizedShare: { baseline: number; mature: number; delta: number };
    };
  };
}
