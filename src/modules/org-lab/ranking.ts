// The pure contextual-fit and ranking math of the org-lab module (W135 —
// Contextual Organizational Lab). No database, no clock, no contracts at
// runtime — the single deterministic definition of how the Lab ranks
// organization candidates under a ContextFingerprint, exported for
// verification (the outcomes module's priorRecommendationSignal and the
// learning module's assessRealization discipline).
//
// THE CONTEXTUAL RULE (binding): nothing here knows an industry, a season
// name, a workload semantics or a "best practice". The ONLY inputs are
// (a) the caller-supplied applicability hypotheses a candidate DECLARES
// and (b) the observed ContextFingerprint (W134's record — consumed
// as-is). Matching is mechanical set membership on the declared
// vocabularies; calibration is arithmetic over recorded evidence. The
// same subject under a materially different fingerprint can rank a
// different candidate first — that divergence is data, never code.
//
// SCORING (deterministic, documented, unit-test-locked):
//   * per mechanical axis: 'match' (declared ∧ observed ∧ satisfied),
//     'misfit' (declared ∧ observed ∧ violated), 'agnostic' (observed,
//     not declared), 'unobserved' (honestly absent from the fingerprint),
//     'advisory' (free-text axis: both postures surfaced, never matched);
//   * fitScore = matches / (matches + misfits) over the mechanical axes,
//     or null when the candidate declares nothing the fingerprint
//     observed (the cold contextual state — never a fabricated 0.5 in
//     the REPORT; the neutral baseline applies only inside the blend);
//   * rankScore = fit × calibrationFactor, where the factor is
//     1 + CALIBRATION_GAIN × (smoothedSuccessRate − 0.5) and the smoothed
//     rate is Laplace-smoothed ((successes + 1) / (sampleSize + 2)) so a
//     single sample can never swing the ranking wildly (evidence strength
//     grows with sample size — the W054 prior discipline). A cold
//     candidate (no calibrated recommendations) gets factor exactly 1:
//     no penalty, no boost;
//   * ordering: rankScore DESC, then slug ASC — fully deterministic.
//
// CALIBRATION POLARITY (the strict rule, a documented judgment call,
// reversible at TL discretion): a calibrated recommendation is 'positive'
// iff EVERY realized expected outcome was assessed 'met' or 'exceeded'
// by the learning module's frozen verdict; a single 'missed' makes it
// 'negative'. Failed recommendations are retained as negative evidence —
// there is no path that discards them.

import type {
  CalibrationPolarity,
  CalibrationSummary,
  CandidateApplicability,
  DimensionFit,
  DimensionVerdict,
  FitFingerprint,
  RankedCandidate,
  RankableCandidate,
  StaffingProfile,
} from './types';

/** How strongly calibration may modulate contextual fit (factor ∈ [0.75, 1.25]). */
export const CALIBRATION_GAIN = 0.5;

/** The neutral contextual-fit baseline used inside the blend (never reported). */
export const NEUTRAL_FIT = 0.5;

// ---------------------------------------------------------------------------
// Observed-context accessors (the fingerprint's typed dimensions, read as-is)
// ---------------------------------------------------------------------------

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The staffing profile a fingerprint's staffing observes: the dominant
 * experience bucket at ≥ 50% share, 'mixed' otherwise. A pure derivation
 * over the recorded mix — never a statement about which profile is better.
 * Returns null when staffing (or its experience mix) is honestly absent.
 */
export function observedStaffingProfile(
  staffing: FitFingerprint['staffing'],
): StaffingProfile | null {
  if (staffing === null || staffing.experienceMix === null) return null;
  const { novice, intermediate, expert } = staffing.experienceMix;
  const total = novice + intermediate + expert;
  if (total <= 0) return null;
  if (novice / total >= 0.5) return 'novice-heavy';
  if (intermediate / total >= 0.5) return 'intermediate-heavy';
  if (expert / total >= 0.5) return 'expert-heavy';
  return 'mixed';
}

/** Set-membership match with the single normalization definition. */
function matchesDeclared(observed: string, declared: readonly string[]): boolean {
  const token = normalizeToken(observed);
  return declared.some((entry) => normalizeToken(entry) === token);
}

/** Subset match: every declared requirement is present in the observed set. */
function coversRequirements(
  observed: readonly string[] | null,
  declared: readonly string[],
): boolean {
  if (observed === null) return false;
  const observedTokens = new Set(observed.map(normalizeToken));
  return declared.every((entry) => observedTokens.has(normalizeToken(entry)));
}

function quoteList(values: readonly string[]): string {
  return values.length === 0 ? '(nothing declared)' : values.join(', ');
}

// ---------------------------------------------------------------------------
// The per-axis fit report
// ---------------------------------------------------------------------------

/**
 * The full twelve-axis fit report of one candidate under one fingerprint
 * (the acceptance's dimension list, canonical order). Mechanical axes get
 * match/misfit/agnostic/unobserved; the free-text budget/quality/SLA axes
 * get advisory (both postures surfaced, never matched).
 */
export function contextualFit(
  applicability: CandidateApplicability,
  fingerprint: FitFingerprint,
): { dimensions: DimensionFit[]; fitScore: number | null } {
  const dimensions: DimensionFit[] = [];

  const push = (
    axis: DimensionFit['axis'],
    verdict: DimensionVerdict,
    declared: string,
    observed: string,
  ): void => {
    dimensions.push({ axis, verdict, declared, observed });
  };

  // --- season / time window ---------------------------------------------
  if (fingerprint.season === null) {
    push('season', 'unobserved', quoteList(applicability.seasonWindows), '(not observed)');
  } else if (applicability.seasonWindows.length === 0) {
    push('season', 'agnostic', '(nothing declared)', `window: ${fingerprint.season.window}`);
  } else {
    const ok = matchesDeclared(fingerprint.season.window, applicability.seasonWindows);
    push(
      'season',
      ok ? 'match' : 'misfit',
      `windows: ${quoteList(applicability.seasonWindows)}`,
      `window: ${fingerprint.season.window}`,
    );
  }

  // --- duration -----------------------------------------------------------
  if (fingerprint.duration === null) {
    push('duration', 'unobserved', quoteList(applicability.durationClasses), '(not observed)');
  } else if (applicability.durationClasses.length === 0) {
    push('duration', 'agnostic', '(nothing declared)', `class: ${fingerprint.duration.durationClass}`);
  } else {
    const ok = applicability.durationClasses.includes(fingerprint.duration.durationClass);
    push(
      'duration',
      ok ? 'match' : 'misfit',
      `classes: ${quoteList(applicability.durationClasses)}`,
      `class: ${fingerprint.duration.durationClass}`,
    );
  }

  // --- staffing / staff experience ---------------------------------------
  const profile = observedStaffingProfile(fingerprint.staffing);
  if (profile === null) {
    push('staffing', 'unobserved', quoteList(applicability.staffingProfiles), '(not observed)');
  } else if (applicability.staffingProfiles.length === 0) {
    push('staffing', 'agnostic', '(nothing declared)', `profile: ${profile}`);
  } else {
    const ok = applicability.staffingProfiles.includes(profile);
    push(
      'staffing',
      ok ? 'match' : 'misfit',
      `profiles: ${quoteList(applicability.staffingProfiles)}`,
      `profile: ${profile}`,
    );
  }

  // --- workload -----------------------------------------------------------
  if (fingerprint.workload === null) {
    push('workload', 'unobserved', quoteList(applicability.workloadLevels), '(not observed)');
  } else if (applicability.workloadLevels.length === 0) {
    push('workload', 'agnostic', '(nothing declared)', `level: ${fingerprint.workload}`);
  } else {
    const ok = applicability.workloadLevels.includes(fingerprint.workload);
    push(
      'workload',
      ok ? 'match' : 'misfit',
      `levels: ${quoteList(applicability.workloadLevels)}`,
      `level: ${fingerprint.workload}`,
    );
  }

  // --- capability ---------------------------------------------------------
  if (fingerprint.capabilities === null) {
    push('capabilities', 'unobserved', quoteList(applicability.requiredCapabilities), '(not observed)');
  } else if (applicability.requiredCapabilities.length === 0) {
    push(
      'capabilities',
      'agnostic',
      '(nothing declared)',
      `available: ${quoteList(fingerprint.capabilities.available)}`,
    );
  } else {
    const ok = coversRequirements(fingerprint.capabilities.available, applicability.requiredCapabilities);
    push(
      'capabilities',
      ok ? 'match' : 'misfit',
      `requires: ${quoteList(applicability.requiredCapabilities)}`,
      `available: ${quoteList(fingerprint.capabilities.available)}`,
    );
  }

  // --- environment --------------------------------------------------------
  if (fingerprint.environment === null) {
    push('environment', 'unobserved', quoteList(applicability.requiredEnvironmentFactors), '(not observed)');
  } else if (applicability.requiredEnvironmentFactors.length === 0) {
    push(
      'environment',
      'agnostic',
      '(nothing declared)',
      `factors: ${quoteList(fingerprint.environment.factors)}`,
    );
  } else {
    const ok = coversRequirements(fingerprint.environment.factors, applicability.requiredEnvironmentFactors);
    push(
      'environment',
      ok ? 'match' : 'misfit',
      `requires: ${quoteList(applicability.requiredEnvironmentFactors)}`,
      `factors: ${quoteList(fingerprint.environment.factors)}`,
    );
  }

  // --- budget (advisory: both postures surfaced, never matched) ----------
  if (fingerprint.constraints === null || fingerprint.constraints.budgetNote === null) {
    push('budget', 'unobserved', applicability.budgetNote ?? '(nothing declared)', '(not observed)');
  } else {
    push(
      'budget',
      'advisory',
      applicability.budgetNote ?? '(nothing declared)',
      `budget: ${fingerprint.constraints.budgetNote}`,
    );
  }

  // --- quality (advisory) -------------------------------------------------
  if (fingerprint.constraints === null || fingerprint.constraints.qualityTarget === null) {
    push('quality', 'unobserved', applicability.qualityTarget ?? '(nothing declared)', '(not observed)');
  } else {
    push(
      'quality',
      'advisory',
      applicability.qualityTarget ?? '(nothing declared)',
      `target: ${fingerprint.constraints.qualityTarget}`,
    );
  }

  // --- risk ---------------------------------------------------------------
  const observedRisk = fingerprint.constraints === null ? null : fingerprint.constraints.riskTolerance;
  if (observedRisk === null) {
    push('risk', 'unobserved', quoteList(applicability.riskTolerances), '(not observed)');
  } else if (applicability.riskTolerances.length === 0) {
    push('risk', 'agnostic', '(nothing declared)', `tolerance: ${observedRisk}`);
  } else {
    const ok = applicability.riskTolerances.includes(observedRisk);
    push(
      'risk',
      ok ? 'match' : 'misfit',
      `tolerances: ${quoteList(applicability.riskTolerances)}`,
      `tolerance: ${observedRisk}`,
    );
  }

  // --- verification -------------------------------------------------------
  const observedVerification =
    fingerprint.constraints === null ? null : fingerprint.constraints.verificationRequirements;
  if (observedVerification === null) {
    push(
      'verification',
      'unobserved',
      quoteList(applicability.requiredVerificationRequirements),
      '(not observed)',
    );
  } else if (applicability.requiredVerificationRequirements.length === 0) {
    push(
      'verification',
      'agnostic',
      '(nothing declared)',
      `requires: ${quoteList(observedVerification)}`,
    );
  } else {
    const ok = coversRequirements(observedVerification, applicability.requiredVerificationRequirements);
    push(
      'verification',
      ok ? 'match' : 'misfit',
      `requires: ${quoteList(applicability.requiredVerificationRequirements)}`,
      `observed: ${quoteList(observedVerification)}`,
    );
  }

  // --- evidence freshness -------------------------------------------------
  if (fingerprint.evidenceFreshness === null) {
    push('evidence-freshness', 'unobserved', quoteList(applicability.freshSurfaces), '(not observed)');
  } else if (applicability.freshSurfaces.length === 0) {
    push(
      'evidence-freshness',
      'agnostic',
      '(nothing declared)',
      `critical surfaces: ${quoteList(fingerprint.evidenceFreshness.criticalFreshSurfaces)} (max age: ${
        fingerprint.evidenceFreshness.maxEvidenceAge ?? 'not stated'
      })`,
    );
  } else {
    const ok = coversRequirements(
      fingerprint.evidenceFreshness.criticalFreshSurfaces,
      applicability.freshSurfaces,
    );
    push(
      'evidence-freshness',
      ok ? 'match' : 'misfit',
      `keeps fresh: ${quoteList(applicability.freshSurfaces)}`,
      `critical surfaces: ${quoteList(fingerprint.evidenceFreshness.criticalFreshSurfaces)} (max age: ${
        fingerprint.evidenceFreshness.maxEvidenceAge ?? 'not stated'
      })`,
    );
  }

  // --- SLA (advisory) -----------------------------------------------------
  if (fingerprint.constraints === null || fingerprint.constraints.slaNote === null) {
    push('sla', 'unobserved', applicability.slaNote ?? '(nothing declared)', '(not observed)');
  } else {
    push(
      'sla',
      'advisory',
      applicability.slaNote ?? '(nothing declared)',
      `sla: ${fingerprint.constraints.slaNote}`,
    );
  }

  // --- the score over the mechanical axes --------------------------------
  const matches = dimensions.filter((entry) => entry.verdict === 'match').length;
  const misfits = dimensions.filter((entry) => entry.verdict === 'misfit').length;
  const fitScore = matches + misfits === 0 ? null : matches / (matches + misfits);
  return { dimensions, fitScore };
}

// ---------------------------------------------------------------------------
// Calibration blending + ranking
// ---------------------------------------------------------------------------

/**
 * Laplace-smoothed success rate: (successes + 1) / (sampleSize + 2). A
 * single sample can never swing the rate to 0 or 1 — evidence strength
 * grows with sample size (the W054 prior discipline). Cold start (null
 * calibration or empty sample) is 0.5 by definition.
 */
export function smoothedSuccessRate(calibration: CalibrationSummary | null): number {
  if (calibration === null || calibration.sampleSize === 0) return 0.5;
  return (calibration.successes + 1) / (calibration.sampleSize + 2);
}

/**
 * The deterministic blended rank score: contextual fit modulated by
 * outcome calibration. fitScore null (no declared-relevant signal) blends
 * from the neutral baseline. A cold candidate's factor is exactly 1 —
 * no penalty, no boost (the honest no-evidence state).
 */
export function rankScoreOf(
  fitScore: number | null,
  calibration: CalibrationSummary | null,
): number {
  const fit = fitScore ?? NEUTRAL_FIT;
  if (calibration === null || calibration.sampleSize === 0) return fit;
  return fit * (1 + CALIBRATION_GAIN * (smoothedSuccessRate(calibration) - 0.5));
}

/**
 * Rank the candidates under one fingerprint (THE SEARCH'S PURE CORE).
 * Ordering: rankScore DESC, then slug ASC — fully deterministic. The
 * calibrations map is keyed by candidateId; a missing key is the cold
 * start.
 */
export function rankOrganizationCandidates(
  fingerprint: FitFingerprint,
  candidates: readonly RankableCandidate[],
  calibrations: ReadonlyMap<string, CalibrationSummary>,
): RankedCandidate[] {
  const ranked = candidates.map((candidate) => {
    const { dimensions, fitScore } = contextualFit(candidate.applicability, fingerprint);
    const calibration = calibrations.get(candidate.candidateId) ?? null;
    return {
      candidateId: candidate.candidateId,
      slug: candidate.slug,
      rankScore: rankScoreOf(fitScore, calibration),
      fitScore,
      dimensions,
    };
  });
  ranked.sort((a, b) => {
    if (a.rankScore !== b.rankScore) return b.rankScore - a.rankScore;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return ranked;
}

// ---------------------------------------------------------------------------
// Calibration polarity (the strict rule — see the header note)
// ---------------------------------------------------------------------------

/**
 * The deterministic polarity of one calibrated recommendation: 'positive'
 * iff every realized expected outcome was assessed 'met' or 'exceeded'
 * (the learning module's frozen verdicts, consumed verbatim); 'negative'
 * as soon as one was 'missed'. Failed recommendations are retained as
 * negative evidence.
 */
export function calibrationPolarity(
  realized: ReadonlyArray<{ assessment: 'met' | 'exceeded' | 'missed' }>,
): CalibrationPolarity {
  return realized.every((entry) => entry.assessment === 'met' || entry.assessment === 'exceeded')
    ? 'positive'
    : 'negative';
}

/**
 * The deterministic aggregate over calibrated recommendations (the
 * recommendation-facing summary): sampleSize / successes / failures /
 * successRate. Aggregates only — never per-recommendation labels (the
 * ADR-0019 no-leak law).
 */
export function calibrationAggregate(
  polarities: ReadonlyArray<{ recommendationId: string; polarity: CalibrationPolarity }>,
): CalibrationSummary | null {
  if (polarities.length === 0) return null;
  const successes = polarities.filter((entry) => entry.polarity === 'positive').length;
  return {
    candidateId: '', // filled by the caller (the summary's subject)
    sampleSize: polarities.length,
    successes,
    failures: polarities.length - successes,
    successRate: successes / polarities.length,
    evidenceRecommendationIds: polarities.map((entry) => entry.recommendationId),
  };
}
