// S003 — the Longitudinal Conversion Benchmark's POPULATION AND CRITERION
// DESIGN (W100). Pure, total, deterministic: no database, no clock, no
// imports beyond the module's own types — the world.ts discipline.
//
// WHAT THIS FILE IS. S003 re-runs the S002 multi-industry switching study
// (spec/SIMULATION-LEARNING-LOG.md, "Simulation S002") with the capabilities
// MEASURED instead of assumed: the same 11-industry x 3-size cohort, the
// same latent switching criterion over the same eleven factors, but every
// factor a deterministic function of quantities the harness MEASURED by
// composing the real module contracts at the base SHA (their deterministic
// doubles where the live external does not exist).
//
// WHAT IS A DESIGN CONSTANT AND WHAT IS MEASURED (the W100 honesty rule):
//  * MEASURED — every count, step, trajectory, cost and rate in the raw
//    results comes from recorded rows of the run (MonthReports, quality
//    snapshots, connection ledgers, reconciliation outcomes, …).
//  * DESIGN CONSTANT — the population's shape (industry anchors, firm-size
//    frictions, role frictions), the cost model's per-event weights, the
//    factor weights and the two thresholds. These are committed here, in
//    the results schema and in every generated document: reproducibility
//    requires them in the open. They are NOT hidden ground truth — the
//    hidden consequential facts of a simulated company stay in the
//    simulator's evaluation-side tables and never feed a factor.
//
// The S002 incumbent anchors (industry stacks, per-industry dependence and
// the by-industry/by-size baseline willingness) are carried over verbatim
// as the population design; the S003 BASELINE scenario (the W056 core
// intelligence/learning loop only — the pre-S002 capability set) is
// calibrated against the S002 baseline anchors and the weights are then
// FROZEN for the MATURE scenario.

import { mulberry32 } from './world';
import type {
  S003FirmSpec,
  S003IndustrySpec,
  S003MaturationAssumption,
  S003MatureLever,
  S003ProfessionalSpec,
  S003SizeSpec,
} from './s003-types';

// ---------------------------------------------------------------------------
// The portfolio-experience representation (per-firm scale)
// ---------------------------------------------------------------------------

/**
 * Months of company life each scenario advances. The W056 month mechanics
 * are the sanctioned representation of portfolio experience: one advanceMonth
 * is one month of the firm's recurring gap-of-the-month work. Four months
 * keep the full 33-firm x 2-scenario harness inside a defensible test-run
 * budget (the W056 benchmark's ~15s for one firm's 53 months is the
 * measured precedent; the S003 harness measures and reports its own
 * runtime).
 */
export const S003_MONTHS_PER_SCENARIO = 4;

/**
 * Projects of portfolio experience each advanced month represents. Four
 * months x 75 projects = 300 projects — the S002 study's mature-state
 * evaluation point ("willingness is evaluated after the portfolio has
 * reached the 300-project mature state").
 */
export const S003_PROJECTS_PER_MONTH = 75;

/** The S002 mature-state evaluation point (4 x 75). */
export const S003_MATURE_STATE_PROJECTS =
  S003_MONTHS_PER_SCENARIO * S003_PROJECTS_PER_MONTH;

// ---------------------------------------------------------------------------
// The roster (the S002 population, deterministically scaled)
// ---------------------------------------------------------------------------

/** The five professional roles — the simulator's own reference structure. */
export const S003_ROLES = [
  'controller',
  'operations',
  'support',
  'fulfillment',
  'analyst',
] as const;
export type S003Role = (typeof S003_ROLES)[number];

/**
 * The role a professional holds, by deterministic pattern per firm size —
 * the S002 size cohorts (small firms skew generalist, large firms skew
 * specialist) at a scale the raw-results file can carry honestly.
 */
export const S003_ROSTER_PATTERN: Readonly<Record<'small' | 'medium' | 'large', readonly S003Role[]>> = Object.freeze({
  small: [
    'controller', 'operations', 'support', 'fulfillment',
    'analyst', 'operations', 'fulfillment', 'analyst',
  ],
  medium: [
    'controller', 'controller', 'operations', 'operations', 'operations', 'operations',
    'support', 'support', 'support', 'fulfillment', 'fulfillment', 'fulfillment',
    'fulfillment', 'analyst', 'analyst', 'analyst',
  ],
  large: [
    'controller', 'controller', 'controller', 'controller',
    'operations', 'operations', 'operations', 'operations', 'operations',
    'operations', 'operations', 'operations',
    'support', 'support', 'support', 'support', 'support', 'support',
    'fulfillment', 'fulfillment', 'fulfillment', 'fulfillment', 'fulfillment',
    'fulfillment', 'fulfillment', 'fulfillment',
    'analyst', 'analyst', 'analyst', 'analyst', 'analyst', 'analyst',
  ],
});

/** The simulator reference-employee index each role is measured through. */
export const S003_ROLE_EMPLOYEE_INDEX: Readonly<Record<S003Role, number>> = Object.freeze({
  controller: 0, // 'Controller' (Finance)
  operations: 1, // 'Operations lead'
  support: 2, // 'Support lead'
  fulfillment: 3, // 'Warehouse specialist' (Fulfillment)
  analyst: 4, // 'Finance analyst'
});

// ---------------------------------------------------------------------------
// Firm sizes (the S002 size cohorts)
// ---------------------------------------------------------------------------

export const S003_FIRM_SIZES: readonly S003SizeSpec[] = Object.freeze([
  Object.freeze({
    key: 'small',
    label: 'Small firm',
    rosterSize: S003_ROSTER_PATTERN.small.length,
    /**
     * Firm-size migration friction (S002 F20: large enterprises need a
     * migration strategy — long-lived data, customized workflows,
     * permission structures, training, integrations, contracts, specialist
     * operations teams).
     */
    migrationFriction: 0.21,
  }),
  Object.freeze({
    key: 'medium',
    label: 'Medium firm',
    rosterSize: S003_ROSTER_PATTERN.medium.length,
    migrationFriction: 0.46,
  }),
  Object.freeze({
    key: 'large',
    label: 'Large firm',
    rosterSize: S003_ROSTER_PATTERN.large.length,
    migrationFriction: 0.725,
  }),
]);

// ---------------------------------------------------------------------------
// Industries (the S002 anchors)
// ---------------------------------------------------------------------------

/**
 * The eleven industry worlds. `incumbentSoRDependence`,
 * `specialistDependence` and `complianceConstraint` are the S002-derived
 * population constants, CALIBRATED so that the S003 BASELINE scenario (the
 * W056 core loop only — the pre-S002 capability set) reproduces the S002
 * baseline anchors: the by-industry Aurum-only table (sales ~89% down to
 * the regulated anchors at ~0%), the overall ~24.7% anchor and the
 * small > medium > large size ordering, all within a stated band (the
 * calibration procedure is the dev tooling at
 * tests/longitudinal/s003/dev-calibrate.ts; the fitted values are frozen
 * here and in every results document). The fitting respects semantic
 * bands (regulated industries stay high-compliance, information
 * industries low) and the S002 tables' own internal rounding — S002's
 * by-size and by-industry tables do not average exactly to its overall
 * figure, so the calibration prioritizes the by-industry table and the
 * overall anchor; the by-size ordering and approximate ratios hold.
 *
 * `systems` is the incumbent benchmark anchor stack the mature scenario
 * composes against (providers are the canonical W036 connector keys the
 * anchor maps onto; capability classes are W081 registry keys).
 * `verticalKitKey` names the real W092 starter kit where one ships;
 * `onPrem` marks stacks with private/on-prem systems (the W088 edge
 * lever); `browserFallbackSystem` names the anchor system with no usable
 * API (the W093 last-resort lever).
 */
export const S003_INDUSTRIES: readonly S003IndustrySpec[] = Object.freeze([
  {
    key: 'sales',
    label: 'Sales / GTM',
    incumbentAnchor: 'Salesforce + HubSpot + Slack/Teams',
    incumbentSoRDependence: 0.16,
    specialistDependence: 0.11,
    complianceConstraint: 0.06,
    systems: [
      { key: 'crm', displayName: 'Incumbent CRM', provider: 'salesforce', capabilityClasses: ['customer-records', 'sales-pipeline'] },
      { key: 'engagement', displayName: 'Engagement Platform', provider: 'hubspot', capabilityClasses: ['customer-records'] },
      { key: 'desk', displayName: 'Support Desk', provider: 'zendesk', capabilityClasses: ['support-desk'] },
    ],
    verticalKitKey: null,
    onPrem: false,
    browserFallbackSystem: null,
  },
  {
    key: 'technology',
    label: 'Technology / Software',
    incumbentAnchor: 'Jira/Confluence + GitHub + Slack/Teams',
    incumbentSoRDependence: 0.17,
    specialistDependence: 0.15,
    complianceConstraint: 0.18,
    systems: [
      { key: 'tracker', displayName: 'Issue Tracker', provider: 'jira', capabilityClasses: ['project-tracking'] },
      { key: 'repo', displayName: 'Code Repositories', provider: 'github', capabilityClasses: ['code-repositories'] },
      { key: 'wiki', displayName: 'Engineering Wiki', provider: 'confluence', capabilityClasses: ['knowledge-base', 'document-collaboration'] },
    ],
    verticalKitKey: null,
    onPrem: false,
    browserFallbackSystem: null,
  },
  {
    key: 'entertainment',
    label: 'Entertainment / Media',
    incumbentAnchor: 'Adobe + Frame.io + Slack/Teams + CMS',
    incumbentSoRDependence: 0.205,
    specialistDependence: 0.155,
    complianceConstraint: 0.185,
    systems: [
      { key: 'assets', displayName: 'Asset Library', provider: 'google-drive', capabilityClasses: ['document-collaboration'] },
      { key: 'production', displayName: 'Production Board', provider: 'linear', capabilityClasses: ['project-tracking'] },
      { key: 'cms', displayName: 'Content CMS', provider: 'notion', capabilityClasses: ['knowledge-base'] },
    ],
    verticalKitKey: null,
    onPrem: false,
    browserFallbackSystem: null,
  },
  {
    key: 'fashion',
    label: 'Fashion / Retail',
    incumbentAnchor: 'Shopify Plus + Adobe + ERP/CRM',
    incumbentSoRDependence: 0.21,
    specialistDependence: 0.16,
    complianceConstraint: 0.19,
    systems: [
      { key: 'commerce', displayName: 'Commerce Platform', provider: 'stripe', capabilityClasses: ['billing-payments', 'sales-pipeline'] },
      { key: 'catalog', displayName: 'Product Catalog', provider: 'confluence', capabilityClasses: ['document-collaboration'] },
      { key: 'marketing', displayName: 'Marketing Hub', provider: 'hubspot', capabilityClasses: ['customer-records'] },
    ],
    verticalKitKey: null,
    onPrem: false,
    browserFallbackSystem: null,
  },
  {
    key: 'hospitality',
    label: 'Hospitality',
    incumbentAnchor: 'Oracle OPERA + Toast/Restaurant365 + Microsoft 365',
    incumbentSoRDependence: 0.275,
    specialistDependence: 0.21,
    complianceConstraint: 0.16,
    systems: [
      { key: 'pms', displayName: 'Property Management', provider: 'salesforce', capabilityClasses: ['customer-records'] },
      { key: 'pos', displayName: 'Point of Sale', provider: 'stripe', capabilityClasses: ['billing-payments'] },
      { key: 'ops', displayName: 'Operations Hub', provider: 'notion', capabilityClasses: ['knowledge-base'] },
    ],
    verticalKitKey: null,
    onPrem: false,
    browserFallbackSystem: 'pos',
  },
  {
    key: 'construction',
    label: 'Construction / AEC / Contractor',
    incumbentAnchor: 'Autodesk Forma + Procore + Primavera/Fieldwire',
    incumbentSoRDependence: 0.42,
    specialistDependence: 0.29,
    complianceConstraint: 0.25,
    systems: [
      { key: 'field-ops', displayName: 'Field Operations', provider: 'jira', capabilityClasses: ['project-tracking'] },
      { key: 'design-docs', displayName: 'Design & BIM Documents', provider: 'google-drive', capabilityClasses: ['document-collaboration'] },
      { key: 'job-cost', displayName: 'Job Cost & ERP', provider: 'quickbooks', capabilityClasses: ['billing-payments', 'accounting-finance'] },
    ],
    verticalKitKey: null,
    onPrem: true,
    browserFallbackSystem: 'field-ops',
  },
  {
    key: 'transportation',
    label: 'Transportation / Delivery',
    incumbentAnchor: 'Samsara + dispatch/TMS + Microsoft 365',
    incumbentSoRDependence: 0.42,
    specialistDependence: 0.29,
    complianceConstraint: 0.24,
    systems: [
      { key: 'dispatch', displayName: 'Dispatch & TMS', provider: 'zapier', capabilityClasses: ['workflows-automation'] },
      { key: 'maintenance', displayName: 'Fleet Maintenance', provider: 'jira', capabilityClasses: ['project-tracking'] },
      { key: 'docs', displayName: 'Shipping Documents', provider: 'google-drive', capabilityClasses: ['document-collaboration'] },
    ],
    verticalKitKey: null,
    onPrem: true,
    browserFallbackSystem: 'dispatch',
  },
  {
    key: 'finance',
    label: 'Finance / Banking / Accounting',
    incumbentAnchor: 'Salesforce Financial Services + SAP/Oracle/NetSuite + Microsoft 365',
    incumbentSoRDependence: 0.44,
    specialistDependence: 0.4,
    complianceConstraint: 0.36,
    systems: [
      { key: 'crm', displayName: 'Financial CRM', provider: 'salesforce', capabilityClasses: ['customer-records', 'sales-pipeline'] },
      { key: 'gl-erp', displayName: 'General Ledger / ERP', provider: 'quickbooks', capabilityClasses: ['accounting-finance'] },
      { key: 'collab', displayName: 'Collaboration Hub', provider: 'confluence', capabilityClasses: ['knowledge-base'] },
    ],
    // The REAL W092 accounting starter kit ships at the base SHA.
    verticalKitKey: 'accounting-ledger-erp',
    onPrem: false,
    browserFallbackSystem: null,
  },
  {
    key: 'legal',
    label: 'Legal',
    incumbentAnchor: 'Clio + Westlaw/Practical Law/CoCounsel',
    incumbentSoRDependence: 0.44,
    specialistDependence: 0.42,
    complianceConstraint: 0.38,
    systems: [
      { key: 'matters', displayName: 'Matter Management', provider: 'salesforce', capabilityClasses: ['customer-records'] },
      { key: 'research', displayName: 'Research Library', provider: 'confluence', capabilityClasses: ['knowledge-base'] },
      { key: 'billing', displayName: 'Billing & Time', provider: 'quickbooks', capabilityClasses: ['billing-payments'] },
    ],
    // The REAL W092 legal starter kit ships at the base SHA.
    verticalKitKey: 'legal-case-management',
    onPrem: false,
    browserFallbackSystem: null,
  },
  {
    key: 'healthcare',
    label: 'Healthcare',
    incumbentAnchor: 'Epic / Oracle Health + Microsoft 365/Teams',
    incumbentSoRDependence: 0.46,
    specialistDependence: 0.44,
    complianceConstraint: 0.42,
    systems: [
      { key: 'ehr', displayName: 'Electronic Health Records', provider: 'salesforce', capabilityClasses: ['customer-records'] },
      { key: 'scheduling', displayName: 'Care Scheduling', provider: 'google-calendar', capabilityClasses: ['calendar-scheduling'] },
      { key: 'clinical-docs', displayName: 'Clinical Documents', provider: 'google-drive', capabilityClasses: ['document-collaboration'] },
    ],
    verticalKitKey: null,
    onPrem: true,
    browserFallbackSystem: 'ehr',
  },
  {
    key: 'defense',
    label: 'Defense / Security',
    incumbentAnchor: 'Palantir + Microsoft/Teams + ServiceNow',
    incumbentSoRDependence: 0.46,
    specialistDependence: 0.44,
    complianceConstraint: 0.42,
    systems: [
      { key: 'mission', displayName: 'Mission System', provider: 'jira', capabilityClasses: ['project-tracking'] },
      { key: 'secure-docs', displayName: 'Secure Documents', provider: 'google-drive', capabilityClasses: ['document-collaboration'] },
      { key: 'directory', displayName: 'Secure Directory', provider: 'notion', capabilityClasses: ['identity-directory'] },
    ],
    verticalKitKey: null,
    onPrem: true,
    browserFallbackSystem: 'secure-docs',
  },
]);

// ---------------------------------------------------------------------------
// Seeds (reproducibility: same (industry, size) -> same firm, always)
// ---------------------------------------------------------------------------

/** The deterministic seed of one (industry, size) firm. */
export function s003SeedFor(industryIndex: number, sizeIndex: number): number {
  return 0x5300_0000 + industryIndex * 8 + sizeIndex;
}

// ---------------------------------------------------------------------------
// The latent switching criterion (the S002 criterion, re-implemented)
// ---------------------------------------------------------------------------

/** The eleven S002 factors, in canonical order (the results-schema order). */
export const S003_FACTOR_KEYS = [
  'organizationalIntelligenceValue',
  'oneWorkSurface',
  'channelAccessibility',
  'roleFit',
  'contextSwitchingReduction',
  'incumbentIndependence',
  'specialistIndependence',
  'reEntryRelief',
  'governanceHeadroom',
  'migrationEase',
  'roleSwitchEase',
] as const;
export type S003FactorKey = (typeof S003_FACTOR_KEYS)[number];

/**
 * The factor weights and the logistic intercept — BENCHMARK DESIGN
 * CONSTANTS, committed in the open. Calibrated so the S003 BASELINE
 * scenario (the pre-S002 capability set) reproduces the S002 baseline
 * anchors at band level (S002: 24.7% ± 0.3 Aurum-only overall; the
 * by-industry table with sales on top and the regulated/specialist
 * anchors at zero; the small > medium > large size ordering), then FROZEN
 * — the MATURE scenario is scored with the exact same weights and
 * thresholds, so every mature-vs-baseline delta is attributable to
 * MEASURED capability composition, never to re-tuning. The weight
 * STRUCTURE encodes the S002 findings: the organizational-intelligence
 * value is the core draw (the heaviest single weight); the industry
 * blockers (system-of-record, specialist-domain, compliance) carry the
 * differentiation; the generic capability-relief weights are deliberately
 * small because the F19 conversion term already limits what generic
 * relief converts to in constrained industries.
 */
export const S003_FACTOR_WEIGHTS: Readonly<Record<S003FactorKey, number>> = Object.freeze({
  organizationalIntelligenceValue: 1.5,
  oneWorkSurface: 0.15,
  channelAccessibility: 0.06,
  roleFit: 0.15,
  contextSwitchingReduction: 0.08,
  incumbentIndependence: 0.9,
  specialistIndependence: 0.87,
  reEntryRelief: 0.15,
  governanceHeadroom: 0.87,
  migrationEase: 0.44,
  roleSwitchEase: 0.5,
});

/** The logistic intercept (calibrated with the weights; frozen with them). */
export const S003_SCORE_INTERCEPT = -3.38;

/**
 * The STRICT Aurum-only threshold (S002: "willingness to consolidate the
 * professional's primary workflow into Aurum" — no longer operating the
 * incumbent systems directly for the simulated work).
 */
export const S003_THRESHOLD_ONLY = 0.66;

/**
 * The EASIER Aurum-primary threshold (S002 F15: "professional spends most
 * coordination/reasoning time in Aurum" — the incumbent stack may remain
 * the execution substrate behind Aurum).
 */
export const S003_THRESHOLD_PRIMARY = 0.555;

/** The deterministic latent score: logistic(intercept + Σ wᵢ·fᵢ). */
export function s003LatentScore(factors: Readonly<Record<S003FactorKey, number>>): number {
  let utility = S003_SCORE_INTERCEPT;
  for (const key of S003_FACTOR_KEYS) {
    utility += S003_FACTOR_WEIGHTS[key] * factors[key]!;
  }
  return round6(1 / (1 + Math.exp(-utility)));
}

// ---------------------------------------------------------------------------
// The population heterogeneity parameter (deterministic, committed)
// ---------------------------------------------------------------------------

/**
 * The synthetic population's personal-affinity dispersion. S002 drew its
 * professionals from a Monte Carlo; S003 makes the draw DETERMINISTIC: one
 * mulberry32 draw per (firm seed, professional index) in [-1, 1], applied
 * to the two per-professional factors (role fit and role switching ease)
 * as f·(1 + σ·draw), clamped to [0, 1]. This is a POPULATION DESIGN
 * parameter — not a measurement, never derived from hidden ground truth —
 * and it is committed here and in every results document.
 */
export const S003_HETEROGENEITY_SIGMA = 0.25;

export function s003AffinityDraw(seed: number, professionalIndex: number): number {
  const rng = mulberry32((seed ^ 0x5f3759df) + professionalIndex * 2654435761);
  return rng() * 2 - 1;
}

// ---------------------------------------------------------------------------
// The baseline cost model (design constants; clearly labeled as such)
// ---------------------------------------------------------------------------

/**
 * The S002 baseline integration cost model — the MANUAL path no records
 * exist for (a human sets the system up by hand and re-enters data by
 * hand). These constants model that human effort; the MATURE scenario's
 * effort, by contrast, is MEASURED (composed contract calls, recorded
 * approvals, tick-clock elapsed time). Every results document carries both
 * labeled by origin.
 */
export const S003_BASELINE_COST_MODEL = Object.freeze({
  /** Manual integration setup effort per incumbent system, minutes. */
  manualSetupMinutesPerSystem: 240,
  /** Manual re-entry effort per manually-executed task, minutes (F17). */
  reEntryMinutesPerTask: 30,
  /** Context switches per manually-executed task (open, find, act, return). */
  switchesPerManualExecution: 3,
  /** Context switches per manual investigation step (one app hop each). */
  switchesPerManualInvestigationStep: 1,
  /** Human minutes per manually-performed investigation step (the no-Aurum counterfactual). */
  manualInvestigationMinutesPerStep: 20,
  /** Human minutes per governed approval decision. */
  approvalMinutes: 10,
});

// ---------------------------------------------------------------------------
// The maturity credits (how far a REAL capability moves a negative factor)
// ---------------------------------------------------------------------------

/**
 * How far each composed capability moves its negative factor. These caps
 * encode the S002 findings the maturation scenario must NOT silently
 * exceed: F14 (composed connections do not erase system-of-record
 * dependence), F19 (the governance primitives are real but the regulated
 * deployment/trust pack is not implemented), F20 (migration tooling helps
 * but large-firm friction persists).
 */
export const S003_MATURITY_CREDITS = Object.freeze({
  /**
   * Composed write paths reduce effective SoR dependence by at most 35%
   * (F14: composed front ends do not erase system-of-record dependence).
   */
  composedSorCredit: 0.12,
  /**
   * An installed+active W092 kit absorbs at most 35% of specialist
   * dependence — the kit's deep-integration execution rides the
   * deferred-on-W088 edge seam (the vertical-kits contract's own honest
   * status), so only the governed install/gate surface is measured.
   */
  kitCredit: 0.15,
  /**
   * The REAL governance primitives (W009 gates, W083 progressive grants,
   * append-only ledgers) address at most 35% of the compliance constraint;
   * the deployment/residency/retention trust pack does NOT exist at the
   * base SHA and earns zero (partial-maturity, labeled).
   */
  governanceCredit: 0.12,
  /** Composed migration tooling relieves at most 45% of firm-size friction. */
  migrationCredit: 0.15,
});

/** The maximal channel surface the mature scenario can compose (measured against). */
export const S003_CHANNEL_SURFACE = 4; // chat (loop) + email + SMS + meetings

// ---------------------------------------------------------------------------
// The maturation-assumption registry (S002's seven, labeled by REAL maturity)
// ---------------------------------------------------------------------------

/**
 * S002's seven maturation assumptions, mapped to what is ACTUALLY
 * implemented at the base SHA. 'real' levers are composed and measured in
 * the mature scenario; 'partial' levers contribute only their real
 * fraction; 'none' levers stay at their baseline contribution — never
 * silently assumed mature. Every entry cites the exact module contracts
 * the lever rides.
 */
export const S003_MATURATION_ASSUMPTIONS: readonly S003MaturationAssumption[] = Object.freeze([
  Object.freeze({
    key: 'deep-connectors',
    label: 'Deep two-way connectors and action adapters for incumbent systems',
    maturity: 'real',
    contracts: [
      'connection-broker/contract.ts: initiateConnection, completeConnection, runConnectionSync',
      'deep-actions/contract.ts: createDeepAction, discoverExecutionSurface, inspectTargets, proposeDeepAction, authorizeDeepAction, executeDeepAction, verifyDeepAction, reconcileDeepAction',
      'capability-grants/contract.ts: establishConnectionAccess, requestCapabilityAuthority, decideGrantRequest, invokeCapability',
    ],
    note: 'Composed and measured per firm against scripted incumbent doubles (no live externals in the suite — the fixtures/doubles doctrine).',
  }),
  Object.freeze({
    key: 'vertical-extensions',
    label: 'Mature vertical specialist extensions/agents',
    maturity: 'partial',
    contracts: [
      'vertical-kits/contract.ts: registerKitVersion, installKit, decideKitReview, activateKit, invokeKitCapability',
    ],
    note: 'REAL for legal (legal-case-management) and finance (accounting-ledger-erp) — the two shipped W092 starter kits; the other nine industries have NO shipped kit and their specialist-domain factor stays at baseline (partial-maturity, labeled per firm in the raw results). Kit integration execution rides the deferred-on-W088 edge seam; capability invocation through the kit gate is what is measured.',
  }),
  Object.freeze({
    key: 'regulated-trust-packs',
    label: 'Secure regulated deployment/trust packs',
    maturity: 'partial',
    contracts: [
      'actions/contract.ts: decideApproval (the W009 authority gate)',
      'capability-grants/contract.ts: invokeCapability (least-privilege invocation ledger)',
      'agent-supervision/contract.ts: registerSupervisedAgent, submitSupervisedExecution, observeSupervisedAgentHealth',
    ],
    note: 'PARTIAL: the action-authority/auditability half is REAL and measured (W009 gates, W083 progressive grants, append-only ledgers, W098 supervised execution); the data-residency/deployment/retention pack half has NO real implementation at the base SHA and earns zero credit (labeled).',
  }),
  Object.freeze({
    key: 'migration-tooling',
    label: 'Migration/import and continuity tooling',
    maturity: 'real',
    contracts: [
      'migration/contract.ts: createMigration, captureSnapshot, transformImportRound, reviewImportRound, commitImportRound, runComparisonRound, listIdentifierMappings (FixtureIncumbent/FixtureNativeStore deterministic doubles)',
    ],
    note: 'Composed and measured per firm: staged import round, identifier map, dual-run comparison with surfaced divergences.',
  }),
  Object.freeze({
    key: 'channel-coverage',
    label: 'Broad channel/mobile coverage',
    maturity: 'real',
    contracts: [
      'channels/contract.ts: registerChannelConnection, sendOutbound',
      'cellular/contract.ts: registerCellularConnection, reachAnyone',
      'meetings/contract.ts: registerMeetingConnection, receiveMeetingWebhook',
      'conversations/contract.ts: recordMessage (the loop\'s chat channel)',
    ],
    note: 'Composed and measured: the chat channel the core loop already records, plus outbound email, SMS reach and meeting ingestion against scripted transports.',
  }),
  Object.freeze({
    key: 'role-native-ux',
    label: 'Role-native task UX and unified work surface',
    maturity: 'none',
    contracts: [],
    note: 'NO real implementation at the base SHA (a product/UX maturation, not a module). The unified-work-surface share IS measured through composed execution paths (deep-actions/browser/edge), but the role-native UX layer itself stays at its baseline contribution for every firm.',
  }),
  Object.freeze({
    key: 'outcome-reporting',
    label: 'Stronger outcome/ROI/evidence reporting',
    maturity: 'real',
    contracts: [
      'quality/contract.ts: computeQualitySnapshot (the nine W055 families)',
      'outcomes/contract.ts: defineOutcome, recordMeasurement, settleOutcome, realizeIntervention',
      'deep-actions/contract.ts: reconcileDeepAction (per-operation pre/post/mismatch evidence observations)',
    ],
    note: 'The realized-value and calibration families are measured from the quality snapshots; the composed execution adds the per-operation evidence chain (pre-state, post-state, mismatch observations) measured in the mature scenario.',
  }),
]);

// ---------------------------------------------------------------------------
// The mature-lever registry (what the mature scenario must actually invoke)
// ---------------------------------------------------------------------------

/** The lever keys the mature scenario composes; each carries its citations. */
export type S003LeverKey =
  | 'integration-discovery'
  | 'connection-lifecycle'
  | 'progressive-grants'
  | 'deep-action-execution'
  | 'migration-continuity'
  | 'vertical-kit'
  | 'channel-coverage'
  | 'edge-jobs'
  | 'browser-fallback'
  | 'agent-supervision';

/**
 * Every mature-scenario lever with the module contracts it rides. The
 * harness ASSERTS each lever's measured invocation count is > 0 in the
 * mature scenario (a lever that invoked nothing is a broken harness, not a
 * quiet assumption), and the raw results carry the citations verbatim.
 */
export const S003_MATURE_LEVERS: readonly S003MatureLever[] = Object.freeze([
  Object.freeze({
    key: 'integration-discovery',
    label: 'Authorized tooling discovery, recommendation and governed connection',
    contracts: [
      'integration-intelligence/contract.ts: grantDiscoverySource, runDiscovery, listRecommendations, submitRecommendationBatch, decideRecommendationBatch, connectSystem, verifySystem',
      'sources/contract.ts: registerSource, setSourceTransport',
    ],
  }),
  Object.freeze({
    key: 'connection-lifecycle',
    label: 'Brokered OAuth connection lifecycle for the incumbent stack',
    contracts: [
      'connection-broker/contract.ts: wireConnectionBrokers, initiateConnection, completeConnection, getConnection',
    ],
  }),
  Object.freeze({
    key: 'progressive-grants',
    label: 'Progressive access: the ask-later capability authority path',
    contracts: [
      'capability-grants/contract.ts: establishConnectionAccess, requestCapabilityAuthority, decideGrantRequest, invokeCapability',
    ],
  }),
  Object.freeze({
    key: 'deep-action-execution',
    label: 'Multi-system task execution: discover→inspect→propose→authorize→execute→verify→reconcile',
    contracts: [
      'deep-actions/contract.ts: createDeepAction, discoverExecutionSurface, inspectTargets, proposeDeepAction, authorizeDeepAction, executeDeepAction, verifyDeepAction, reconcileDeepAction',
      'actions/contract.ts: decideApproval (the W009 EXECUTE gate)',
    ],
  }),
  Object.freeze({
    key: 'migration-continuity',
    label: 'Staged incumbent import, identifier preservation and dual-run comparison',
    contracts: [
      'migration/contract.ts: createMigration, captureSnapshot, transformImportRound, reviewImportRound, commitImportRound, runComparisonRound, listIdentifierMappings',
    ],
  }),
  Object.freeze({
    key: 'vertical-kit',
    label: 'Governed vertical starter kit install and capability invocation',
    contracts: [
      'vertical-kits/contract.ts: registerKitVersion, installKit, decideKitReview, activateKit, invokeKitCapability',
    ],
  }),
  Object.freeze({
    key: 'channel-coverage',
    label: 'Cross-channel reach: outbound email, SMS fallback, meeting ingestion',
    contracts: [
      'channels/contract.ts: registerChannelConnection, sendOutbound',
      'cellular/contract.ts: registerCellularConnection, reachAnyone',
      'meetings/contract.ts: registerMeetingConnection, receiveMeetingWebhook',
    ],
  }),
  Object.freeze({
    key: 'edge-jobs',
    label: 'Customer-controlled edge runtime for private/on-prem systems',
    contracts: [
      'edge-connector/contract.ts: registerEdgeRuntime, setEdgeAllowlist, issueEdgeJob, createInMemoryEdgeRuntime (the deterministic runtime double), wireEdgeSigner',
    ],
  }),
  Object.freeze({
    key: 'browser-fallback',
    label: 'Governed last-resort browser automation for no-API systems',
    contracts: [
      'computer-use/contract.ts: createBrowserTask, startBrowserTask, createScriptedBrowserDriver (the deterministic driver double)',
    ],
  }),
  Object.freeze({
    key: 'agent-supervision',
    label: 'Persistent supervision of the specialist workforce',
    contracts: [
      'agents/contract.ts: registerAgent',
      'agent-supervision/contract.ts: registerSupervisedAgent, submitSupervisedExecution, observeSupervisedAgentHealth',
    ],
  }),
]);

// ---------------------------------------------------------------------------
// Firm specs (the full cohort, deterministically)
// ---------------------------------------------------------------------------

/** Every firm of the cohort with its deterministic seed and roster. */
export function s003Cohort(): S003FirmSpec[] {
  const firms: S003FirmSpec[] = [];
  for (let industryIndex = 0; industryIndex < S003_INDUSTRIES.length; industryIndex += 1) {
    const industry = S003_INDUSTRIES[industryIndex]!;
    for (let sizeIndex = 0; sizeIndex < S003_FIRM_SIZES.length; sizeIndex += 1) {
      const size = S003_FIRM_SIZES[sizeIndex]!;
      const seed = s003SeedFor(industryIndex, sizeIndex);
      const pattern = S003_ROSTER_PATTERN[size.key];
      const professionals: S003ProfessionalSpec[] = pattern.map((role, index) => ({
        index,
        role,
        affinityDraw: round6(s003AffinityDraw(seed, index)),
      }));
      firms.push({
        key: `${industry.key}-${size.key}`,
        industryIndex,
        industry,
        sizeIndex,
        size,
        seed,
        professionals,
      });
    }
  }
  return firms;
}

/** Rounds to 6 decimals (the quality module's score granularity). */
export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Clamps to [0, 1]. */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
