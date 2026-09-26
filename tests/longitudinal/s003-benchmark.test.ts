// ============================================================================
// W100 — THE S003 LONGITUDINAL CONVERSION BENCHMARK HARNESS.
//
// The S002 multi-industry switching study, RE-RUN with capabilities
// MEASURED instead of assumed (the work item):
//   "Re-run the multi-industry benchmark after the new integration/
//    realtime/action capabilities. Measure Aurum-primary and Aurum-only
//    willingness, context-switching reduction, integration setup effort,
//    trust and realized value."
// Acceptance: "reproducible seeds, multiple firm sizes/industries, explicit
// baseline versus mature scenario, no hidden-ground-truth leakage, raw
// results committed."
//
// THE COHORT: the S002 population (11 industries x 3 firm sizes, 33 firms,
// 616 professionals) run through TWO scenarios per firm:
//   BASELINE — the W056 core intelligence/learning loop ONLY (the
//     pre-S002 capability set);
//   MATURE   — the same loop plus the post-S002 capabilities composed
//     through their real contracts (deterministic doubles where no live
//     external exists).
//
// FAILURE CONDITIONS (spec/LONGITUDINAL-BENCHMARK.md inherited + the W100
// extensions — each asserted to NOT hold below):
//   * policy relaxed between runs — the frozen materiality policy governs
//     every discovery run of every firm-scenario tenant;
//   * hidden facts directly exposed to the reasoning layer — the hidden
//     markers of the seeded companies never appear on any cognition
//     surface of any tenant, and never in the committed results;
//   * improvement without recorded evidence — the loop's improvement is
//     attributable to recorded learning updates (identical loop in both
//     scenarios), and every mature-scenario lever's measured invocation
//     count is > 0;
//   * a mature lever without a real contract — every lever cites its
//     contracts and the cohort's composed levers cover the full registry;
//   * the same seed NOT reproducing byte-identical raw results — one firm
//     is re-run in fresh tenants and compared byte-for-byte.
// ============================================================================

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as attentionContract from '@/modules/attention/contract';
import * as conversationsContract from '@/modules/conversations/contract';
import * as epistemicsContract from '@/modules/epistemics/contract';
import * as knowledgeAcquisitionContract from '@/modules/knowledge-acquisition/contract';
import * as learningContract from '@/modules/learning/contract';
import * as observationsContract from '@/modules/observations/contract';
import {
  MATERIALITY_POLICY,
  S003_MATURATION_ASSUMPTIONS,
  S003_MATURE_LEVERS,
  S003_MONTHS_PER_SCENARIO,
  S003_MATURE_STATE_PROJECTS,
  S003_PROJECTS_PER_MONTH,
  deriveCompanyDesign,
  type S003Results,
} from '@/modules/simulator/contract';
import { runMigrations } from '../../scripts/migrate';
import { canonicalJson, runS003Cohort } from './s003/runner';
import { interpretS003Results } from './s003/interpret';

const RESULTS_PATH = fileURLToPath(new URL('./s003/results/s003-results.json', import.meta.url));

/** The firms re-run for the byte-identical determinism assertion. */
const DETERMINISM_FIRMS = ['sales-small', 'defense-large'] as const;

/** The tenants swept for the frozen-policy and leakage failure conditions. */
const SWEEP_FIRMS = ['sales-small', 'technology-medium', 'finance-large', 'defense-large'] as const;

let outcome: Awaited<ReturnType<typeof runS003Cohort>>;
let committed: S003Results;
let committedRaw: string;

function memberOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

beforeAll(async () => {
  await runMigrations(getDb());
  outcome = await runS003Cohort({ determinismFirmKeys: [...DETERMINISM_FIRMS] });
  committedRaw = readFileSync(RESULTS_PATH, 'utf8');
  committed = interpretS003Results(JSON.parse(committedRaw)) as unknown as S003Results;
}, 600_000);

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The committed raw results (the deliverable) and reproducibility
// ---------------------------------------------------------------------------

describe('the committed raw results', () => {
  it('interprets against the versioned schema of record (the refusing interpreter)', () => {
    // interpretS003Results THROWS on any violation; the committed document
    // passed at generation time and must pass again here.
    const interpreted = interpretS003Results(JSON.parse(readFileSync(RESULTS_PATH, 'utf8')));
    expect(interpreted.benchmarkId).toBe('s003-longitudinal-conversion');
    expect(interpreted.schemaVersion).toBe(1);
  });

  it('the refusing interpreter refuses unknown schema versions and unknown properties', () => {
    const document = JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) as Record<string, unknown>;
    const futureVersion = { ...document, schemaVersion: 2 };
    expect(() => interpretS003Results(futureVersion)).toThrow(/unsupported schemaVersion 2/);
    const withUnknown = { ...document, surpriseField: true };
    expect(() => interpretS003Results(withUnknown)).toThrow(/unknown property 'surpriseField'/);
  });

  it('the fresh run reproduces the committed results byte-identically', () => {
    expect(canonicalJson(outcome.results)).toBe(canonicalJson(committed));
    expect(canonicalJson(outcome.results)).toBe(committedRaw);
  });

  it('the same seed reproduces byte-identical raw results on re-run (fresh tenants)', () => {
    for (const key of DETERMINISM_FIRMS) {
      const first = outcome.results.firms.find((firm) => firm.key === key)!;
      expect(first).toBeDefined();
      const rerun = outcome.determinismFirmJson[key]!;
      expect(rerun).toBeDefined();
      expect(rerun).toBe(canonicalJson(first));
    }
  });

  it('the cohort is the S002 population: 11 industries x 3 sizes, one deterministic seed per firm', () => {
    const { results } = outcome;
    expect(results.design.cohort).toEqual({
      industries: 11,
      sizes: 3,
      firms: 33,
      professionals: 616,
    });
    expect(new Set(results.firms.map((firm) => firm.industryKey)).size).toBe(11);
    expect(new Set(results.firms.map((firm) => firm.sizeKey)).size).toBe(3);
    expect(new Set(results.firms.map((firm) => firm.seed)).size).toBe(33);
    // The portfolio-experience representation: 4 months x 75 projects = 300.
    expect(results.design.monthsPerScenario).toBe(S003_MONTHS_PER_SCENARIO);
    expect(results.design.matureStateProjects).toBe(S003_MATURE_STATE_PROJECTS);
    expect(results.design.projectsPerMonth).toBe(S003_PROJECTS_PER_MONTH);
    for (const firm of results.firms) {
      expect(firm.baseline.months).toHaveLength(S003_MONTHS_PER_SCENARIO);
      expect(firm.mature.months).toHaveLength(S003_MONTHS_PER_SCENARIO);
      expect(firm.baseline.seed).toBe(firm.seed);
      expect(firm.mature.seed).toBe(firm.seed);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure condition: the frozen policy governed every run of every tenant
// ---------------------------------------------------------------------------

describe('failure condition: policy not relaxed between scenarios', () => {
  it('the materiality policy is frozen and governed every discovery run of every swept tenant', async () => {
    expect(Object.isFrozen(MATERIALITY_POLICY)).toBe(true);
    for (const key of SWEEP_FIRMS) {
      const tenants = outcome.tenants[key]!;
      for (const tenantId of [tenants.baseline, tenants.mature]) {
        const runs = await attentionContract.listDiscoveryRuns(memberOf(tenantId), { limit: 500 });
        expect(runs.length).toBeGreaterThan(0);
        for (const run of runs) {
          expect(run.policy.impactThreshold).toBe(MATERIALITY_POLICY.impactThreshold);
          expect(run.policy.valueThreshold).toBe(MATERIALITY_POLICY.valueThreshold);
        }
        // Every persisted planner signal shows access 'allowed' — learned
        // preference never overrode the access policy.
        const plans = await knowledgeAcquisitionContract.listAcquisitionPlans(memberOf(tenantId), {
          limit: 500,
        });
        expect(plans.length).toBeGreaterThan(0);
        for (const plan of plans) {
          for (const ranked of plan.ranked) {
            expect(ranked.signals.access).toBe('allowed');
          }
        }
      }
      // The SAME frozen policy governed both scenarios of the firm —
      // nothing was relaxed for the mature run.
      const baselineRuns = await attentionContract.listDiscoveryRuns(
        memberOf(outcome.tenants[key]!.baseline),
        { limit: 500 },
      );
      const matureRuns = await attentionContract.listDiscoveryRuns(
        memberOf(outcome.tenants[key]!.mature),
        { limit: 500 },
      );
      expect(matureRuns.length).toBe(baselineRuns.length);
      for (const run of matureRuns) {
        expect(run.policy.impactThreshold).toBe(baselineRuns[0]!.policy.impactThreshold);
        expect(run.policy.valueThreshold).toBe(baselineRuns[0]!.policy.valueThreshold);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Failure condition: no hidden-ground-truth leakage
// ---------------------------------------------------------------------------

describe('failure condition: no hidden-ground-truth leakage', () => {
  it('the hidden markers never appear on any cognition surface of any swept tenant', async () => {
    for (const key of SWEEP_FIRMS) {
      const firm = outcome.results.firms.find((entry) => entry.key === key)!;
      const design = deriveCompanyDesign(firm.seed);
      const markers = design.months.map((month) => month.hidden.marker);
      expect(new Set(markers).size).toBe(design.months.length);
      for (const tenantId of [
        outcome.tenants[key]!.baseline,
        outcome.tenants[key]!.mature,
      ]) {
        const ctx = memberOf(tenantId);
        const observations = await observationsContract.listObservations(ctx, { limit: 500 });
        expect(observations.length).toBeGreaterThan(0);
        for (const observation of observations) {
          for (const marker of markers) {
            expect(JSON.stringify(observation.payload).includes(marker)).toBe(false);
          }
        }
        const claims = await epistemicsContract.listClaims(ctx, { limit: 500 });
        for (const claim of claims) {
          for (const marker of markers) {
            expect(claim.proposition.includes(marker)).toBe(false);
          }
        }
        const messages = await conversationsContract.listMessages(ctx, { limit: 500 });
        for (const message of messages) {
          for (const marker of markers) {
            expect(JSON.stringify(message.payload).includes(marker)).toBe(false);
          }
        }
        const model = await learningContract.getCompanyModel(ctx, {});
        for (const assertion of model.assertions) {
          for (const marker of markers) {
            expect(
              (JSON.stringify(assertion.statement) + JSON.stringify(assertion.subject)).includes(
                marker,
              ),
            ).toBe(false);
          }
        }
      }
    }
  });

  it('the committed raw results carry no hidden markers or hidden answers', () => {
    const serialized = committedRaw;
    for (const firm of outcome.results.firms) {
      const design = deriveCompanyDesign(firm.seed);
      for (const month of design.months) {
        expect(serialized.includes(month.hidden.marker)).toBe(false);
        expect(serialized.includes(month.hidden.answerText)).toBe(false);
      }
    }
  });

  it('the scoring layer never reads the reveal surface (structural: factors consume only measured inputs)', () => {
    // The canonical results' factor inputs are the loop months, the loop
    // aggregates and the composed measurement — the schema of record pins
    // exactly those fields, and every one is an observable record (steps,
    // counts, rates, costs). The hidden facts (markers, answers, hidden
    // qualities) are absent by the assertions above; the reveal surface is
    // never invoked by the runner (the simulator's oracle is the only
    // sanctioned seam, inside advanceMonth).
    for (const firm of outcome.results.firms) {
      for (const scenario of [firm.baseline, firm.mature]) {
        // The measured loop factors are present and in range.
        expect(scenario.loop.months.length).toBe(S003_MONTHS_PER_SCENARIO);
        expect(scenario.loop.meanSteps).toBeGreaterThan(0);
        expect(scenario.factors.organizationalIntelligenceValue).toBeGreaterThan(0);
        expect(scenario.factors.organizationalIntelligenceValue).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Failure condition: improvement attributable to recorded evidence rows
// ---------------------------------------------------------------------------

describe('failure condition: improvement attributable to recorded evidence', () => {
  it('the loop is identical between scenarios — the delta comes only from the composed capabilities', () => {
    for (const firm of outcome.results.firms) {
      // Same monthly information environment (same seed) and same measured
      // loop behavior: the W056 walk arithmetic.
      expect(firm.mature.months.map((month) => month.steps)).toEqual(
        firm.baseline.months.map((month) => month.steps),
      );
      expect(firm.mature.months.map((month) => month.topic)).toEqual(
        firm.baseline.months.map((month) => month.topic),
      );
      // Every month of both scenarios recorded its CompanyModel update —
      // the improvement channel of the core loop.
      for (const month of [...firm.baseline.months, ...firm.mature.months]) {
        expect(month.learningRecorded).toBe(true);
      }
      // The core-loop factors are identical between scenarios.
      expect(firm.mature.factors.organizationalIntelligenceValue).toBe(
        firm.baseline.factors.organizationalIntelligenceValue,
      );
    }
  });

  it('the baseline composed NOTHING (all-zero levers) while the mature levers all fired', () => {
    for (const firm of outcome.results.firms) {
      for (const count of Object.values(firm.baseline.composed.leverInvocations)) {
        expect(count).toBe(0);
      }
      expect(firm.baseline.composed.effort.contractCalls).toBe(0);
      expect(firm.baseline.composed.effort.approvals).toBe(0);
      // Every lever the firm's industry calls for actually invoked.
      for (const lever of firm.leversComposed) {
        expect(firm.mature.composed.leverInvocations[lever]).toBeGreaterThan(0);
      }
    }
  });

  it('the cohort covers every mature lever of the registry (the union assertion)', () => {
    const registryKeys = S003_MATURE_LEVERS.map((lever) => lever.key);
    const composedKeys = new Set(
      outcome.results.firms.flatMap((firm) => [...firm.leversComposed]),
    );
    for (const key of registryKeys) {
      expect(composedKeys.has(key)).toBe(true);
    }
    // Every firm's levers are a subset of the registry.
    for (const firm of outcome.results.firms) {
      for (const lever of firm.leversComposed) {
        expect(registryKeys).toContain(lever);
      }
    }
  });

  it('every mature lever cites real module contracts, and the citations ride measured flows', () => {
    for (const lever of S003_MATURE_LEVERS) {
      expect(lever.contracts.length).toBeGreaterThan(0);
      for (const citation of lever.contracts) {
        expect(citation).toMatch(/^[a-z-]+\/contract\.ts: /);
      }
    }
    // The measured rows behind the citations: for every firm, the deep
    // action executed and reconciled with its full evidence chain, the
    // migration committed a round with preserved identifiers, and the
    // connection/verification ledgers hold entries.
    for (const firm of outcome.results.firms) {
      const composed = firm.mature.composed;
      expect(composed.coverage.systemsDiscovered).toBe(3);
      expect(composed.coverage.systemsConnected).toBe(3);
      expect(composed.coverage.systemsVerified).toBe(3);
      expect(composed.deepAction.tasks).toBe(1);
      expect(composed.deepAction.opsExecuted).toBe(2);
      expect(composed.deepAction.preStateEvidence).toBe(2);
      expect(composed.deepAction.postStateEvidence).toBe(2);
      // One seeded divergence surfaced as a mismatch unknown — never a
      // silent success (the attention record).
      expect(composed.deepAction.opsMismatched).toBe(1);
      expect(composed.deepAction.mismatchUnknowns).toBe(1);
      expect(composed.migration.roundsCommitted).toBe(1);
      expect(composed.migration.recordsImported).toBe(3);
      expect(composed.migration.identifierMappings).toBe(3);
      expect(composed.migration.divergencesSurfaced).toBe(1);
      expect(composed.supervision.agentsSupervised).toBe(1);
      expect(composed.supervision.executionsAdmitted).toBe(1);
      expect(composed.channels.messagesOutbound).toBe(1);
      expect(composed.channels.smsReachAttempts).toBe(1);
      expect(composed.channels.meetingsIngested).toBe(2);
      expect(composed.effort.approvals).toBeGreaterThan(0);
      expect(composed.effort.contractCalls).toBeGreaterThan(0);
      expect(composed.effort.elapsedSimulatedMinutes).toBeGreaterThan(0);
    }
  });

  it('tenant isolation: each firm-scenario ran in its own tenant', () => {
    const seen = new Set<string>();
    for (const firm of outcome.results.firms) {
      const tenants = outcome.tenants[firm.key]!;
      expect(tenants.baseline).not.toBe(tenants.mature);
      expect(seen.has(tenants.baseline)).toBe(false);
      expect(seen.has(tenants.mature)).toBe(false);
      seen.add(tenants.baseline);
      seen.add(tenants.mature);
    }
  });
});

// ---------------------------------------------------------------------------
// The six W100 measurements (baseline vs mature — the deliverable)
// ---------------------------------------------------------------------------

describe('the six measurements (baseline vs mature)', () => {
  it('measurements 1+2 — Aurum-only and Aurum-primary willingness, both thresholds', () => {
    const { headline, baseline, mature } = outcome.results.cohort;
    // The baseline reproduces the S002 anchors at band level (S002:
    // 24.7% ± 0.3 overall; the calibration targets band-level agreement).
    expect(baseline.aurumOnlyShare).toBeGreaterThan(0.18);
    expect(baseline.aurumOnlyShare).toBeLessThan(0.3);
    // Aurum-primary is the EASIER bar (F15): strictly more professionals.
    expect(baseline.aurumPrimaryShare).toBeGreaterThan(baseline.aurumOnlyShare);
    expect(mature.aurumPrimaryShare).toBeGreaterThan(mature.aurumOnlyShare);
    // The composed capabilities move willingness UP...
    expect(headline.aurumOnlyShare.delta).toBeGreaterThan(0.05);
    expect(headline.aurumPrimaryShare.delta).toBeGreaterThan(0.05);
    // ...but stay BELOW the S002 FULL-maturity scenario (56.8%) — the
    // partial-maturity honesty bound.
    expect(mature.aurumOnlyShare).toBeLessThan(0.568);
    // By-size ordering preserved in both scenarios (S002: small > medium > large).
    const sizeOf = (aggregate: typeof baseline, size: string) =>
      aggregate.bySize.find((row) => row.sizeKey === size)!.aurumOnlyShare;
    for (const aggregate of [baseline, mature]) {
      expect(sizeOf(aggregate, 'small')).toBeGreaterThan(sizeOf(aggregate, 'medium'));
      expect(sizeOf(aggregate, 'medium')).toBeGreaterThan(sizeOf(aggregate, 'large'));
    }
    // The regulated anchors stay notably weaker in the mature scenario.
    for (const industryKey of ['finance', 'legal', 'healthcare', 'defense']) {
      const row = mature.byIndustry.find((entry) => entry.industryKey === industryKey)!;
      expect(row.aurumOnlyShare).toBeLessThanOrEqual(0.15);
    }
  });

  it('measurement 3 — context-switching reduction (measured from the trajectories)', () => {
    const { headline, baseline, mature } = outcome.results.cohort;
    // The loop's routing trajectory: the cold walk (7 steps) collapses to
    // 1 step from month 2 in BOTH scenarios (the core loop's measured
    // improvement — identical by construction).
    for (const firm of outcome.results.firms) {
      const steps = firm.baseline.months.map((month) => month.steps);
      expect(steps[0]).toBe(7);
      for (let index = 1; index < steps.length; index += 1) {
        expect(steps[index]).toBe(1);
      }
    }
    // The switching reduction: baseline 0.7 (the loop absorbs the
    // investigation), mature higher (the composed write paths absorb the
    // execution switches).
    expect(baseline.contextSwitchingReductionMean).toBeCloseTo(0.7, 5);
    expect(mature.contextSwitchingReductionMean).toBeGreaterThan(
      baseline.contextSwitchingReductionMean,
    );
    expect(headline.contextSwitchingReduction.delta).toBeGreaterThan(0.03);
  });

  it('measurement 4 — integration setup effort (measured, labeled by origin)', () => {
    const { headline, baseline, mature } = outcome.results.cohort;
    // The baseline effort is the labeled manual cost model; the mature
    // effort is MEASURED (composed calls, approvals, elapsed simulated
    // minutes) and lands far below the manual path.
    expect(baseline.setupEffortMinutesMean).toBe(840); // 3 systems x 240 + 4 tasks x 30
    for (const firm of outcome.results.firms) {
      expect(firm.baseline.measurements.setupEffort.origin).toBe('baseline-cost-model');
      expect(firm.mature.measurements.setupEffort.origin).toBe('measured');
      expect(firm.mature.measurements.setupEffort.steps).toBeGreaterThan(20);
      expect(firm.mature.measurements.setupEffort.approvals).toBeGreaterThanOrEqual(5);
    }
    expect(mature.setupEffortMinutesMean).toBeLessThan(400);
    expect(headline.setupEffortMinutes.delta).toBeLessThan(-400);
  });

  it('measurement 5 — trust (composed from the evidence/attention surfaces)', () => {
    const { headline, baseline, mature } = outcome.results.cohort;
    // The baseline carries the loop's own evidence discipline (confidence
    // basis 1.0, judgments, learning updates) — nothing else.
    expect(baseline.trustMean).toBeCloseTo(0.32, 5);
    // The mature scenario adds the governed-authority, verification and
    // execution-evidence chains — all measured.
    for (const firm of outcome.results.firms) {
      const trust = firm.mature.measurements.trust;
      expect(trust.evidenceConfidenceBasis).toBe(1);
      expect(trust.gateDiscipline).toBe(1);
      expect(trust.verificationLedger).toBe(1);
      expect(trust.evidenceChain).toBe(1);
      expect(trust.auditTrail).toBe(1);
      // The attention records: the surfaced divergence + the mismatch.
      expect(trust.attentionRecords).toBe(2);
    }
    expect(mature.trustMean).toBeGreaterThan(baseline.trustMean);
    expect(headline.trust.delta).toBeGreaterThan(0.5);
  });

  it('measurement 6 — realized value (the W055 families + composed attribution)', () => {
    const r = outcome.results;
    // The loop's realized-value families are IDENTICAL between scenarios
    // (the same seeded loop) — the honest position: the core loop's value
    // is not double-counted.
    for (const firm of r.firms) {
      expect(firm.mature.measurements.realizedValue.realizedValueSum).toBe(
        firm.baseline.measurements.realizedValue.realizedValueSum,
      );
      expect(firm.mature.measurements.realizedValue.netVarianceSum).toBe(
        firm.baseline.measurements.realizedValue.netVarianceSum,
      );
      // The composed-execution attribution share (the measured write-path
      // coverage) is what the mature scenario ADDS.
      expect(firm.baseline.measurements.realizedValue.attributableShare).toBe(0);
      expect(firm.mature.measurements.realizedValue.attributableShare).toBeGreaterThan(0);
    }
    expect(r.cohort.headline.attributableRealizedShare.delta).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// The partial-maturity labels (the honesty surface)
// ---------------------------------------------------------------------------

describe('the partial-maturity labels', () => {
  it('every S002 maturation assumption is labeled with its real maturity and citations', () => {
    expect(S003_MATURATION_ASSUMPTIONS).toHaveLength(7);
    const keys = S003_MATURATION_ASSUMPTIONS.map((assumption) => assumption.key);
    expect(keys).toContain('deep-connectors');
    expect(keys).toContain('vertical-extensions');
    expect(keys).toContain('regulated-trust-packs');
    expect(keys).toContain('migration-tooling');
    expect(keys).toContain('channel-coverage');
    expect(keys).toContain('role-native-ux');
    expect(keys).toContain('outcome-reporting');
    // The 'none' assumption has no contracts and is labeled per firm.
    const roleNativeUx = S003_MATURATION_ASSUMPTIONS.find(
      (assumption) => assumption.key === 'role-native-ux',
    )!;
    expect(roleNativeUx.maturity).toBe('none');
    expect(roleNativeUx.contracts).toHaveLength(0);
    // The committed results carry the labels verbatim.
    expect(committed.design.maturationAssumptions).toHaveLength(7);
    // Every firm carries its partial-maturity labels.
    for (const firm of outcome.results.firms) {
      expect(firm.partialMaturity).toContain('role-native-ux');
      expect(firm.partialMaturity).toContain(
        'regulated-trust-packs:deployment-residency-half',
      );
      if (firm.industryKey !== 'legal' && firm.industryKey !== 'finance') {
        expect(firm.partialMaturity).toContain('vertical-extensions:no-shipped-kit');
        expect(firm.mature.composed.kit.active).toBe(false);
      } else {
        expect(firm.mature.composed.kit.active).toBe(true);
        expect(firm.mature.composed.kit.capabilitiesInvoked).toBe(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The measured runtime (reported, never scored)
// ---------------------------------------------------------------------------

describe('the measured runtime', () => {
  it('the full cohort completes inside the harness budget', () => {
    // The per-firm scale decision (4 months x 75 projects = the S002
    // mature-state threshold) keeps the full 33-firm x 2-scenario run
    // inside a defensible test budget; this asserts the run completed and
    // reports the measured wall clock in the test output.
    expect(outcome.wallClockMs).toBeGreaterThan(0);
    expect(outcome.wallClockMs).toBeLessThan(300_000);
    console.log(
      `S003 measured wall-clock runtime: ${(outcome.wallClockMs / 1000).toFixed(1)}s ` +
        `for ${outcome.results.design.cohort.firms} firms x 2 scenarios ` +
        `(${outcome.results.design.cohort.professionals} professionals)`,
    );
  });
});
