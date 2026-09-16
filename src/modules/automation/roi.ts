// The automation module's derived economics — the pure, deterministic math
// behind "expected ROI" and "outcome measurement" (the capabilities
// module's gap.ts precedent: derived intelligence is computed on read and
// NEVER persisted, so it can never drift from the committed records it
// summarizes — lock 10).
//
// Two functions, both direction-aware and dependency-free:
//
//   expectedRoiOf    — the expected-ROI summary of one version's committed
//                      figures (savings per period, one-time investment,
//                      horizon in periods): net benefit over the horizon,
//                      the ROI ratio and the payback period. All money is
//                      integer minor units of the version's currency;
//                      ratios/payback are plain IEEE-754 doubles derived
//                      from them (deterministic).
//
//   outcomeTargetMet — the deterministic verdict of one observed metric
//                      value against the measurement plan's target under
//                      its direction ('at_least': observed >= target is a
//                      success; 'at_most': observed <= target is a success).

import type {
  AutomationPeriod,
  ExpectedRoi,
  OutcomeDirection,
} from './types';

/** The committed figures `expectedRoiOf` summarizes. */
export interface ExpectedRoiInput {
  currency: string;
  period: AutomationPeriod;
  /** Expected savings per period, integer minor units ≥ 0. */
  expectedSavingsMinor: number;
  /** One-time expected investment, integer minor units ≥ 0. */
  expectedInvestmentMinor: number;
  /** Assessment horizon in periods, integer ≥ 1. */
  roiHorizonPeriods: number;
}

/**
 * The deterministic expected-ROI summary (see `ExpectedRoi` in types.ts):
 *
 *   expectedNetBenefitMinor = savings × horizon − investment
 *   expectedRoiRatio        = netBenefit / investment
 *                             (null when investment = 0 — an ROI ratio is
 *                              undefined without an outlay)
 *   expectedPaybackPeriods  = investment / savings
 *                             (0 when investment = 0 — nothing to recover;
 *                              null when savings = 0 — never pays back)
 */
export function expectedRoiOf(content: ExpectedRoiInput): ExpectedRoi {
  const expectedNetBenefitMinor =
    content.expectedSavingsMinor * content.roiHorizonPeriods - content.expectedInvestmentMinor;
  const expectedRoiRatio =
    content.expectedInvestmentMinor > 0
      ? expectedNetBenefitMinor / content.expectedInvestmentMinor
      : null;
  const expectedPaybackPeriods =
    content.expectedSavingsMinor > 0
      ? content.expectedInvestmentMinor / content.expectedSavingsMinor
      : null;
  return {
    currency: content.currency,
    period: content.period,
    expectedSavingsMinor: content.expectedSavingsMinor,
    expectedInvestmentMinor: content.expectedInvestmentMinor,
    horizonPeriods: content.roiHorizonPeriods,
    expectedNetBenefitMinor,
    expectedRoiRatio,
    expectedPaybackPeriods,
  };
}

/**
 * Does one observed metric value meet the measurement plan's target under
 * its direction? The single deterministic definition (the learning
 * module's assessRealization discipline: one pure function, exported for
 * verification).
 */
export function outcomeTargetMet(
  direction: OutcomeDirection,
  target: number,
  observed: number,
): boolean {
  return direction === 'at_least' ? observed >= target : observed <= target;
}
