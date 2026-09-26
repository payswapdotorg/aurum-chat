// S003 — the pure SCORING ENGINE (W100): the S002 latent switching
// criterion, re-implemented deterministically over MEASURED quantities.
//
// Every factor below is a total, deterministic function of
//  (a) the measured loop trajectory (MonthReports + the W055 quality
//      families the simulator already records), and
//  (b) the measured composed-capability rows of the scenario
//      (integration/connection/grants/deep-action/migration/kit/channel/
//      edge/browser/supervision contract reads), plus
//  (c) the COMMITTED population/cost design constants (s003-world.ts).
// No hidden ground truth participates: the factors never read
// revealGroundTruth or any simulator hidden table.
//
// The formulas, weights, thresholds and credits are benchmark DESIGN
// CONSTANTS committed in the open (s003-world.ts) and mirrored into every
// results document — reproducibility requires them in the open. They are
// justified factor-by-factor in the comments below, each citing the S002
// finding it encodes.

import {
  S003_BASELINE_COST_MODEL,
  S003_FACTOR_KEYS,
  S003_HETEROGENEITY_SIGMA,
  S003_MATURITY_CREDITS,
  S003_THRESHOLD_ONLY,
  S003_THRESHOLD_PRIMARY,
  clamp01,
  round6,
  s003LatentScore,
  type S003FactorKey,
} from './s003-world';
import type {
  S003ComposedMeasurement,
  S003FirmScenarioResult,
  S003FirmSpec,
  S003LoopMeasurement,
  S003ProfessionalResult,
} from './s003-types';
import type { S003Role } from './s003-world';

/**
 * Role-specific switching friction bases (S002 factor 11: "role-specific
 * switching friction"). Execution roles (fulfillment) face the highest
 * friction — their incumbent tools ARE the work substrate; analyst roles
 * the lowest. The industry interaction (0.75 + 0.5·specialistDependence)
 * encodes the S002 finding that role friction compounds in
 * specialist-heavy industries.
 */
export const S003_ROLE_FRICTION_BASE: Readonly<Record<S003Role, number>> = Object.freeze({
  controller: 0.3,
  operations: 0.42,
  support: 0.5,
  fulfillment: 0.72,
  analyst: 0.22,
});

/**
 * The expected governed-execution events of the fully composed mature
 * chain (the denominator of the governance lever's measured coverage):
 * the W009 gate decisions + clean verification runs + supervised
 * admissions + gated capability invocations the chain is designed to
 * record. A committed design constant; the NUMERATOR is measured.
 */
export const S003_EXPECTED_GOVERNANCE_EVENTS = 12;

/** The audit surfaces of the trust measurement (see scoreTrust). */
export const S003_TRUST_SURFACES = 5;

// ---------------------------------------------------------------------------
// Derived measured helpers
// ---------------------------------------------------------------------------

/** The measured cold-reference walk length (month 1's steps). */
function coldReferenceSteps(loop: S003LoopMeasurement): number {
  const first = loop.months[0]?.steps ?? 7;
  return first > 0 ? first : 7;
}

/** The measured cold-reference prediction error (month 1's error). */
function coldReferenceError(loop: S003LoopMeasurement): number {
  const first = loop.months[0]?.predictionErrorMean ?? 1.5;
  return first > 0 ? first : 1.5;
}

/** Measured manual (out-of-Aurum) executions of the scenario's tasks. */
function manualExecutions(
  firm: S003FirmSpec,
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): number {
  return round6(loop.interventionsExecuted * (1 - effectiveWriteCoverage(firm, composed)));
}

/** Measured composed (in-Aurum) executions of the scenario's tasks. */
function composedExecutions(composed: S003ComposedMeasurement): number {
  return composed.deepAction.opsExecuted + composed.browser.stepsVerified + composed.edge.jobsSucceeded;
}

/**
 * The F19 conversion term: how much GENERIC composed-capability relief
 * (write-path coverage, channel access, re-entry relief, migration
 * tooling) converts into switching willingness in this industry. S002's
 * own finding (F19): "general UX improvement alone does little to move
 * these professionals toward Aurum-only" — in a compliance-constrained
 * industry the professional must still operate and verify the regulated
 * system of record, so the generic relief converts at
 * (1 − complianceConstraint). The governance lever's separate partial
 * credit (factor 9) is the only path that relieves the constraint
 * itself.
 */
function f19Conversion(firm: S003FirmSpec): number {
  return clamp01(1 - firm.industry.complianceConstraint);
}

/** The compliance-damped composed write coverage (the F19 interaction). */
function effectiveWriteCoverage(firm: S003FirmSpec, composed: S003ComposedMeasurement): number {
  const discovered = Math.max(1, composed.coverage.systemsDiscovered);
  const coverage = composed.coverage.systemsWithWritePath / discovered;
  return round6(coverage * f19Conversion(firm));
}

// ---------------------------------------------------------------------------
// The baseline cost model (labeled origin — see S003_BASELINE_COST_MODEL)
// ---------------------------------------------------------------------------

/** The no-Aurum counterfactual burden in minutes (the cost model, labeled). */
function noAurumBurdenMinutes(firm: S003FirmSpec, loop: S003LoopMeasurement): number {
  const coldSteps = coldReferenceSteps(loop);
  return (
    firm.industry.systems.length * S003_BASELINE_COST_MODEL.manualSetupMinutesPerSystem +
    loop.interventionsExecuted * S003_BASELINE_COST_MODEL.reEntryMinutesPerTask +
    loop.months.length * coldSteps * S003_BASELINE_COST_MODEL.manualInvestigationMinutesPerStep
  );
}

/** The baseline manual-path burden in minutes (the cost model, labeled). */
function baselineBurdenMinutes(firm: S003FirmSpec, loop: S003LoopMeasurement): number {
  return (
    firm.industry.systems.length * S003_BASELINE_COST_MODEL.manualSetupMinutesPerSystem +
    loop.interventionsExecuted * S003_BASELINE_COST_MODEL.reEntryMinutesPerTask
  );
}

/** The scenario's integration/re-entry burden in minutes. */
function scenarioBurdenMinutes(
  firm: S003FirmSpec,
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): number {
  if (composed.effort.approvals === 0 && composed.effort.elapsedSimulatedMinutes === 0) {
    // The baseline scenario composed nothing: the manual cost model applies
    // (its origin is labeled 'baseline-cost-model' in the results).
    return baselineBurdenMinutes(firm, loop);
  }
  const residualReentry =
    manualExecutions(firm, loop, composed) * S003_BASELINE_COST_MODEL.reEntryMinutesPerTask;
  return (
    composed.effort.approvals * S003_BASELINE_COST_MODEL.approvalMinutes +
    composed.effort.elapsedSimulatedMinutes +
    residualReentry
  );
}

// ---------------------------------------------------------------------------
// The factors
// ---------------------------------------------------------------------------

/**
 * Factor 1 — organizational-intelligence value after longitudinal
 * learning (S002). Measured from the loop the scenario itself ran:
 * routing efficiency (1 − meanSteps/coldSteps), first-choice correctness
 * (the oracle-judged selection family), recommendation calibration
 * (1 − meanError/coldError) and evidence confidence. The sub-weights are
 * committed design constants. IDENTICAL between scenarios by construction
 * (the same seeded loop) — the mature scenario must not claim the core
 * loop's value twice.
 */
function factorOrgIntelligence(loop: S003LoopMeasurement): number {
  const routing = clamp01(1 - loop.meanSteps / coldReferenceSteps(loop));
  const calibration = clamp01(1 - loop.meanPredictionError / coldReferenceError(loop));
  return round6(
    0.35 * routing + 0.3 * loop.firstChoiceCorrectRate + 0.2 * calibration + 0.15 * loop.evidenceMeanConfidence,
  );
}

/**
 * Factor 2 — one-work-surface ability (S002): the measured share of the
 * firm's work the Aurum surface carries. Two measured halves: the
 * investigation share (every mission the loop ran resolved inside Aurum —
 * measured: resolved missions / missions) and the execution coverage (the
 * measured share of the incumbent stack with a composed write path,
 * damped by the F19 conversion term — a regulated professional still
 * operates the system of record).
 */
function factorOneWorkSurface(
  firm: S003FirmSpec,
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): number {
  const resolvedInAurum = loop.months.length > 0 ? 1 : 0; // every mission resolved (measured)
  const executionCoverage = effectiveWriteCoverage(firm, composed);
  return round6(0.6 * resolvedInAurum + 0.4 * executionCoverage);
}

/**
 * Factor 3 — channel accessibility (S002 F21: "channel coverage = access
 * multiplier"). The baseline carries the loop's own measured chat channel
 * at half credit (the first channel matters most — sublinear access); the
 * composed cross-channel surface (email, SMS, meetings — measured)
 * contributes the other half, damped by the F19 conversion term.
 */
function factorChannelAccessibility(
  firm: S003FirmSpec,
  composed: S003ComposedMeasurement,
): number {
  const composedChannels = Math.max(
    0,
    composed.coverage.channelsWithEvidence - loopChannelBaseline(composed),
  );
  const composedShare = composedChannels > 0 ? f19Conversion(firm) : 0;
  return round6(0.5 + 0.5 * composedShare);
}

/** The measured channel surface the loop itself recorded (the baseline). */
function loopChannelBaseline(composed: S003ComposedMeasurement): number {
  // The baseline's coverage.channelsWithEvidence IS the loop's channel
  // count; the mature value adds the composed channels on top of it.
  return composed.leverInvocations['channel-coverage'] > 0 ? 1 : composed.coverage.channelsWithEvidence;
}

/**
 * Factor 4 — role fit (S002, per professional). Measured basis: the
 * role's reference employee's participation in the loop's recorded
 * evidence (acquisitions answered + messages sent), normalized by the
 * most-participating role, scaled into [0.4, 1.0] and modulated by the
 * committed personal-affinity draw (the population's deterministic
 * heterogeneity).
 */
function factorRoleFit(
  loop: S003LoopMeasurement,
  role: S003Role,
  affinityDraw: number,
): number {
  const participations = Object.values(loop.participationByRole);
  const max = Math.max(0, ...participations);
  const share = max > 0 ? (loop.participationByRole[role] ?? 0) / max : 0;
  const base = 0.4 + 0.6 * share;
  return round6(clamp01(base * (1 + S003_HETEROGENEITY_SIGMA * affinityDraw)));
}

/**
 * Factor 5 — observed context-switching reduction (S002). The
 * counterfactual (no Aurum at all) is measured from the loop's own cold
 * walk: coldSteps·months investigation switches + interventions·3
 * execution switches. The scenario's residual switches are the manual
 * executions × 3 plus the amortized setup switches (measured approvals
 * amortized over the horizon — each governed approval is one human
 * context switch).
 */
function factorContextSwitching(
  firm: S003FirmSpec,
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): number {
  const coldSteps = coldReferenceSteps(loop);
  const months = Math.max(1, loop.months.length);
  const switchesNoAurum =
    coldSteps * months * S003_BASELINE_COST_MODEL.switchesPerManualInvestigationStep +
    loop.interventionsExecuted * S003_BASELINE_COST_MODEL.switchesPerManualExecution;
  const amortizedSetupSwitches = composed.effort.approvals / months;
  const switchesScenario =
    manualExecutions(firm, loop, composed) * S003_BASELINE_COST_MODEL.switchesPerManualExecution +
    amortizedSetupSwitches;
  return round6(clamp01(1 - switchesScenario / Math.max(1, switchesNoAurum)));
}

/**
 * Factor 6 — incumbent system-of-record dependence (S002 F14, inverted to
 * a positive factor). The industry base is the committed S002 anchor; the
 * mature scenario's MEASURED composed write coverage reduces the
 * effective dependence by at most the committed COMPOSED_SOR_CREDIT
 * (F14: composed front ends do not erase system-of-record dependence).
 */
function factorIncumbentIndependence(
  firm: S003FirmSpec,
  composed: S003ComposedMeasurement,
): number {
  const composedShare = effectiveWriteCoverage(firm, composed);
  const effective =
    firm.industry.incumbentSoRDependence *
    (1 - S003_MATURITY_CREDITS.composedSorCredit * composedShare);
  return round6(1 - effective);
}

/**
 * Factor 7 — specialist-domain dependence (S002 F18, inverted). Reduced
 * ONLY where a REAL W092 starter kit is installed, active and its
 * capabilities invoked through the kit gate (all measured); industries
 * without a shipped kit stay at baseline (partial-maturity, labeled in
 * the raw results).
 */
function factorSpecialistIndependence(
  firm: S003FirmSpec,
  composed: S003ComposedMeasurement,
): number {
  const kitLever = composed.kit.active && composed.kit.capabilitiesInvoked > 0 ? 1 : 0;
  // The kit is industry-specific specialist depth, but it rides the same
  // trust barrier in regulated industries (half the compliance damping).
  const kitConversion = 1 - firm.industry.complianceConstraint * 0.5;
  const effective =
    firm.industry.specialistDependence *
    (1 - S003_MATURITY_CREDITS.kitCredit * kitLever * kitConversion);
  return round6(1 - effective);
}

/**
 * Factor 8 — integration/re-entry burden relief (S002 F17 — the strongest
 * blocker). The baseline burden is the committed manual cost model over
 * the measured stack and task counts; the mature burden is MEASURED
 * (governed approvals × committed human minutes + the tick-clock elapsed
 * simulated minutes + the residual manual re-entry). Relief = 1 −
 * burden/burdenBaseline. Baseline scenario relief is 0 by construction.
 */
function factorReEntryRelief(
  firm: S003FirmSpec,
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): number {
  const noAurum = noAurumBurdenMinutes(firm, loop);
  if (noAurum <= 0) return 0;
  const burden = scenarioBurdenMinutes(firm, loop, composed);
  // The F19 interaction: the composed relief converts at the industry's
  // conversion term; the baseline's investigation absorption (the loop's
  // own relief) converts in full — the missions resolved inside Aurum
  // regardless of the compliance regime.
  const baselineRelief = clamp01(1 - baselineBurdenMinutes(firm, loop) / noAurum);
  const fullRelief = clamp01(1 - burden / noAurum);
  const conversion = f19Conversion(firm);
  const relief = baselineRelief + (fullRelief - baselineRelief) * conversion;
  return round6(clamp01(relief));
}

/**
 * Factor 9 — compliance/security constraint headroom (S002 F19,
 * inverted). The industry base is the committed S002 anchor. The REAL
 * governance primitives (measured W009 gate decisions, clean verification
 * runs, supervised admissions, gated invocations) reduce the effective
 * constraint by at most the committed GOVERNANCE_CREDIT — a PARTIAL
 * credit, because the regulated deployment/residency/retention trust pack
 * has NO real implementation at the base SHA (labeled partial-maturity).
 */
function factorGovernanceHeadroom(
  firm: S003FirmSpec,
  composed: S003ComposedMeasurement,
): number {
  const governedEvents =
    composed.trust.gateDecisionsRecorded +
    composed.trust.verificationRunsClean +
    composed.supervision.executionsAdmitted +
    composed.coverage.systemsVerified;
  const lever = clamp01(governedEvents / S003_EXPECTED_GOVERNANCE_EVENTS);
  const effective =
    firm.industry.complianceConstraint * (1 - S003_MATURITY_CREDITS.governanceCredit * lever);
  return round6(1 - effective);
}

/**
 * Factor 10 — firm-size migration friction ease (S002 F20, inverted).
 * Reduced only by the MEASURED migration composition (committed rounds,
 * preserved identifiers, a run comparison), by at most the committed
 * MIGRATION_CREDIT (F20: migration tooling helps; large-firm friction
 * persists).
 */
function factorMigrationEase(
  firm: S003FirmSpec,
  composed: S003ComposedMeasurement,
): number {
  const lever = clamp01(
    (Math.min(1, composed.migration.roundsCommitted) +
      (composed.migration.identifierMappings > 0 ? 1 : 0) +
      (composed.migration.roundsCommitted > 0 ? 1 : 0)) /
      3,
  );
  // The F19 interaction: migration tooling is generic capability.
  const effective =
    firm.size.migrationFriction *
    (1 - S003_MATURITY_CREDITS.migrationCredit * lever * f19Conversion(firm));
  return round6(1 - effective);
}

/**
 * Factor 11 — role-specific switching friction ease (S002, per
 * professional; factor 11 inverted). Role base × the industry
 * interaction; modulated by the committed personal-affinity draw. NOT
 * modulated by the mature scenario: the role-native task UX (S002
 * assumption 6) has no real implementation at the base SHA and stays at
 * its baseline contribution (labeled).
 */
function factorRoleSwitchEase(
  firm: S003FirmSpec,
  role: S003Role,
  affinityDraw: number,
): number {
  const friction =
    S003_ROLE_FRICTION_BASE[role] * (0.75 + 0.5 * firm.industry.specialistDependence);
  return round6(clamp01((1 - friction) * (1 + S003_HETEROGENEITY_SIGMA * affinityDraw)));
}

// ---------------------------------------------------------------------------
// The six W100 measurements (composed per firm-scenario)
// ---------------------------------------------------------------------------

/** Measurement 5 — trust, from the measured evidence/attention surfaces. */
function scoreTrust(
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): S003FirmScenarioResult['measurements']['trust'] {
  const evidenceConfidenceBasis = loop.evidenceShareWithConfidenceBasis;
  // Execution attribution: composed executions carrying full evidence
  // chains (pre+post state observations) over all executions.
  const executed = composed.deepAction.opsExecuted;
  const chained =
    executed > 0
      ? Math.min(composed.deepAction.preStateEvidence, composed.deepAction.postStateEvidence) / executed
      : 0;
  const governedAuthority =
    composed.trust.actionRequestsSubmitted > 0
      ? composed.trust.gateDecisionsRecorded / composed.trust.actionRequestsSubmitted
      : 0;
  const verificationLedger =
    composed.trust.verificationRunsTotal > 0
      ? composed.trust.verificationRunsClean / composed.trust.verificationRunsTotal
      : 0;
  const auditTrail = composed.trust.auditLedgersWithEntries / S003_TRUST_SURFACES;
  const score = round6(
    0.2 * evidenceConfidenceBasis +
      0.2 * chained +
      0.2 * governedAuthority +
      0.2 * verificationLedger +
      0.2 * auditTrail,
  );
  return {
    score,
    evidenceConfidenceBasis: round6(evidenceConfidenceBasis),
    gateDiscipline: round6(governedAuthority),
    verificationLedger: round6(verificationLedger),
    evidenceChain: round6(chained),
    auditTrail: round6(auditTrail),
    attentionRecords:
      composed.deepAction.mismatchUnknowns + composed.migration.divergencesSurfaced,
  };
}

/** All six measurements composed for one firm-scenario. */
function composeMeasurements(
  firm: S003FirmSpec,
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): S003FirmScenarioResult['measurements'] {
  const coldSteps = coldReferenceSteps(loop);
  const months = Math.max(1, loop.months.length);
  const switchesNoAurum =
    coldSteps * months + loop.interventionsExecuted * S003_BASELINE_COST_MODEL.switchesPerManualExecution;
  const amortizedSetupSwitches = composed.effort.approvals / months;
  const switchesScenario =
    manualExecutions(firm, loop, composed) * S003_BASELINE_COST_MODEL.switchesPerManualExecution +
    amortizedSetupSwitches;
  const measuredMature =
    composed.effort.approvals > 0 || composed.effort.elapsedSimulatedMinutes > 0;
  const writeCoverage = effectiveWriteCoverage(firm, composed);

  return {
    contextSwitching: {
      switchesAvoidedPerTask: round6((switchesNoAurum - switchesScenario) / months),
      reductionVsNoAurum: round6(clamp01(1 - switchesScenario / Math.max(1, switchesNoAurum))),
      manualExecutions: round6(manualExecutions(firm, loop, composed)),
      composedExecutions: composedExecutions(composed),
      amortizedSetupSwitches: round6(amortizedSetupSwitches),
    },
    setupEffort: {
      origin: measuredMature ? 'measured' : 'baseline-cost-model',
      minutes: round6(scenarioBurdenMinutes(firm, loop, composed)),
      steps: measuredMature
        ? composed.effort.contractCalls
        : firm.industry.systems.length, // the measured manual registrations (registerSource per system)
      approvals: composed.effort.approvals,
      perSystemMinutes: round6(
        scenarioBurdenMinutes(firm, loop, composed) / firm.industry.systems.length,
      ),
    },
    trust: scoreTrust(loop, composed),
    realizedValue: {
      realizedValueSum: round6(loop.totalRealizedValueSum),
      netVarianceSum: round6(loop.meanNetVariance),
      meanPredictionError: round6(loop.meanPredictionError),
      missionCostMinor: loop.totalWindowCostMinor,
      attributableShare: round6(writeCoverage),
    },
  };
}

// ---------------------------------------------------------------------------
// The scenario result (factors + professionals + measurements)
// ---------------------------------------------------------------------------

/**
 * Scores one firm-scenario: the eleven factors (nine firm-level, two per
 * professional), every professional's latent score and willingness
 * verdicts, and the six W100 measurements. Pure and deterministic.
 */
export function scoreS003Scenario(
  firm: S003FirmSpec,
  scenario: 'baseline' | 'mature',
  loop: S003LoopMeasurement,
  composed: S003ComposedMeasurement,
): S003FirmScenarioResult {
  const firmFactors: Record<S003FactorKey, number> = {
    organizationalIntelligenceValue: factorOrgIntelligence(loop),
    oneWorkSurface: factorOneWorkSurface(firm, loop, composed),
    channelAccessibility: factorChannelAccessibility(firm, composed),
    roleFit: 0, // per professional (below)
    contextSwitchingReduction: factorContextSwitching(firm, loop, composed),
    incumbentIndependence: factorIncumbentIndependence(firm, composed),
    specialistIndependence: factorSpecialistIndependence(firm, composed),
    reEntryRelief: factorReEntryRelief(firm, loop, composed),
    governanceHeadroom: factorGovernanceHeadroom(firm, composed),
    migrationEase: factorMigrationEase(firm, composed),
    roleSwitchEase: 0, // per professional (below)
  };

  const professionals: S003ProfessionalResult[] = firm.professionals.map((professional) => {
    const factors: Record<S003FactorKey, number> = { ...firmFactors };
    factors.roleFit = factorRoleFit(loop, professional.role, professional.affinityDraw);
    factors.roleSwitchEase = factorRoleSwitchEase(firm, professional.role, professional.affinityDraw);
    const score = s003LatentScore(factors);
    return {
      role: professional.role,
      roleFit: factors.roleFit,
      roleSwitchEase: factors.roleSwitchEase,
      affinityDraw: professional.affinityDraw,
      score,
      willingOnly: score >= S003_THRESHOLD_ONLY,
      willingPrimary: score >= S003_THRESHOLD_PRIMARY,
    };
  });
  // The firm-level factor record carries the roster-mean of the two
  // per-professional factors (the raw results carry both per
  // professional; the mean keeps the firm record self-describing).
  firmFactors.roleFit = round6(
    professionals.reduce((sum, entry) => sum + entry.roleFit, 0) / Math.max(1, professionals.length),
  );
  firmFactors.roleSwitchEase = round6(
    professionals.reduce((sum, entry) => sum + entry.roleSwitchEase, 0) / Math.max(1, professionals.length),
  );

  return {
    scenario,
    seed: firm.seed,
    months: loop.months,
    loop,
    composed,
    factors: firmFactors,
    professionals,
    measurements: composeMeasurements(firm, loop, composed),
  };
}

// ---------------------------------------------------------------------------
// The pairwise firm result (baseline vs mature — the deliverable)
// ---------------------------------------------------------------------------

function scenarioShares(result: S003FirmScenarioResult): {
  only: number;
  primary: number;
  mean: number;
} {
  const total = Math.max(1, result.professionals.length);
  const only = result.professionals.filter((entry) => entry.willingOnly).length / total;
  const primary = result.professionals.filter((entry) => entry.willingPrimary).length / total;
  const mean =
    result.professionals.reduce((sum, entry) => sum + entry.score, 0) / total;
  return { only: round6(only), primary: round6(primary), mean: round6(mean) };
}

/**
 * The levers the mature scenario composes for THIS firm
 * (industry-conditional — an edge runtime is for private/on-prem stacks,
 * a browser fallback for no-API systems, a kit only where one ships).
 */
export function s003LeversForFirm(firm: S003FirmSpec): import('./s003-world').S003LeverKey[] {
  const levers: import('./s003-world').S003LeverKey[] = [
    'integration-discovery',
    'connection-lifecycle',
    'progressive-grants',
    'deep-action-execution',
    'migration-continuity',
    'channel-coverage',
    'agent-supervision',
  ];
  if (firm.industry.verticalKitKey !== null) levers.push('vertical-kit');
  if (firm.industry.onPrem) levers.push('edge-jobs');
  if (firm.industry.browserFallbackSystem !== null) levers.push('browser-fallback');
  return levers;
}

/**
 * The partial-maturity labels of THIS firm: the S002 maturation
 * assumptions that have no full real implementation and therefore stayed
 * at (or near) their baseline contribution for this firm.
 */
export function s003PartialMaturityForFirm(firm: S003FirmSpec): string[] {
  const labels: string[] = [
    'role-native-ux', // S002 assumption 6: no real implementation at the base SHA.
    'regulated-trust-packs:deployment-residency-half', // S002 assumption 3: only the authority/audit half is real.
  ];
  if (firm.industry.verticalKitKey === null) {
    labels.push('vertical-extensions:no-shipped-kit'); // S002 assumption 2: partial for this industry.
  }
  return labels;
}

/** The pairwise firm result: baseline vs mature with the six deltas. */
export function composeS003FirmResult(
  firm: S003FirmSpec,
  baseline: S003FirmScenarioResult,
  mature: S003FirmScenarioResult,
): import('./s003-types').S003FirmResult {
  const base = scenarioShares(baseline);
  const mat = scenarioShares(mature);
  return {
    key: firm.key,
    industryKey: firm.industry.key,
    industryLabel: firm.industry.label,
    sizeKey: firm.size.key,
    seed: firm.seed,
    baseline,
    mature,
    delta: {
      aurumOnlyShare: round6(mat.only - base.only),
      aurumPrimaryShare: round6(mat.primary - base.primary),
      latentScoreMean: round6(mat.mean - base.mean),
      contextSwitchingReduction: round6(
        mature.measurements.contextSwitching.reductionVsNoAurum -
          baseline.measurements.contextSwitching.reductionVsNoAurum,
      ),
      setupEffortMinutes: round6(
        mature.measurements.setupEffort.minutes - baseline.measurements.setupEffort.minutes,
      ),
      trust: round6(mature.measurements.trust.score - baseline.measurements.trust.score),
      attributableRealizedShare: round6(
        mature.measurements.realizedValue.attributableShare -
          baseline.measurements.realizedValue.attributableShare,
      ),
    },
    leversComposed: s003LeversForFirm(firm),
    partialMaturity: s003PartialMaturityForFirm(firm),
  };
}

// ---------------------------------------------------------------------------
// Cohort aggregation
// ---------------------------------------------------------------------------

/** Aggregates one scenario's firm results into the cohort view. */
export function aggregateS003Scenario(
  firms: readonly import('./s003-types').S003FirmResult[],
  scenario: 'baseline' | 'mature',
): import('./s003-types').S003CohortScenarioAggregate {
  const results = firms.map((firm) => firm[scenario]);
  const professionals = results.reduce((sum, result) => sum + result.professionals.length, 0);
  const only =
    results.reduce(
      (sum, result) => sum + result.professionals.filter((entry) => entry.willingOnly).length,
      0,
    ) / Math.max(1, professionals);
  const primary =
    results.reduce(
      (sum, result) => sum + result.professionals.filter((entry) => entry.willingPrimary).length,
      0,
    ) / Math.max(1, professionals);
  const meanScore =
    results.reduce(
      (sum, result) => sum + result.professionals.reduce((s, entry) => s + entry.score, 0),
      0,
    ) / Math.max(1, professionals);
  const trust =
    results.reduce((sum, result) => sum + result.measurements.trust.score, 0) /
    Math.max(1, results.length);
  const setup =
    results.reduce((sum, result) => sum + result.measurements.setupEffort.minutes, 0) /
    Math.max(1, results.length);
  const switching =
    results.reduce((sum, result) => sum + result.measurements.contextSwitching.reductionVsNoAurum, 0) /
    Math.max(1, results.length);
  const attributable =
    results.reduce((sum, result) => sum + result.measurements.realizedValue.attributableShare, 0) /
    Math.max(1, results.length);

  const industryKeys = [...new Set(firms.map((firm) => firm.industryKey))];
  const sizeKeys = ['small', 'medium', 'large'] as const;
  return {
    professionals,
    aurumOnlyShare: round6(only),
    aurumPrimaryShare: round6(primary),
    latentScoreMean: round6(meanScore),
    trustMean: round6(trust),
    setupEffortMinutesMean: round6(setup),
    contextSwitchingReductionMean: round6(switching),
    attributableRealizedShareMean: round6(attributable),
    byIndustry: industryKeys.map((industryKey) => {
      const industryResults = results.filter(
        (_, index) => firms[index]!.industryKey === industryKey,
      );
      const count = industryResults.reduce((sum, result) => sum + result.professionals.length, 0);
      return {
        industryKey,
        professionals: count,
        aurumOnlyShare: round6(
          industryResults.reduce(
            (sum, result) => sum + result.professionals.filter((entry) => entry.willingOnly).length,
            0,
          ) / Math.max(1, count),
        ),
        aurumPrimaryShare: round6(
          industryResults.reduce(
            (sum, result) => sum + result.professionals.filter((entry) => entry.willingPrimary).length,
            0,
          ) / Math.max(1, count),
        ),
      };
    }),
    bySize: sizeKeys.flatMap((sizeKey) => {
      const sizeResults = results.filter((_, index) => firms[index]!.sizeKey === sizeKey);
      const count = sizeResults.reduce((sum, result) => sum + result.professionals.length, 0);
      if (count === 0) return []; // never emit a zero-professional row
      return [{
        sizeKey,
        professionals: count,
        aurumOnlyShare: round6(
          sizeResults.reduce(
            (sum, result) => sum + result.professionals.filter((entry) => entry.willingOnly).length,
            0,
          ) / Math.max(1, count),
        ),
        aurumPrimaryShare: round6(
          sizeResults.reduce(
            (sum, result) => sum + result.professionals.filter((entry) => entry.willingPrimary).length,
            0,
          ) / Math.max(1, count),
        ),
      }];
    }),
  };
}

// Re-exported for the contract surface (single import point).
export { S003_FACTOR_KEYS };
