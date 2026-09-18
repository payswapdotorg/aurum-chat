// Pure synthetic-company engine of the simulator module (W056). No
// database, no context, no clock, no imports beyond types — everything here
// is a total, deterministic function of the SEED, so the same seed always
// materializes the same company and the same month always presents the same
// information environment (LONGITUDINAL-BENCHMARK.md: "Run identical seeded
// companies with equivalent goals and information environments").
//
// The design splits every fact about the synthetic company into exactly two
// halves, and the split is the whole point of W056:
//
//   PUBLIC  — what the tenant's world model, org chart and evidence say
//   (employee names/titles, system labels, the goal, the monthly churn
//   reading, message chatter, external events). Public facts flow into the
//   reasoning layer through the ordinary contracts (people, world, goals,
//   observations, conversations, events).
//
//   HIDDEN  — the consequential ground truth (each source's true answer
//   quality, the month's true driver, the intervention's true realized
//   value, the leak-detecting MARKER sentinels). Hidden facts are persisted
//   ONLY in the simulator's own tables and are consumed ONLY by the
//   world-oracle (a source ANSWERING an acquisition — the sanctioned
//   evidence channel), the ground-truth evaluator (quality judgments) and
//   the reveal surface (benchmark verification). The benchmark's leakage
//   test proves no hidden marker ever appears on any reasoning-layer
//   record.
//
// The reference company shape (counts, roles, authorities, costs, hidden
// qualities, thresholds) is a FIXED, hand-tuned template — the deliberate
// interpretation decision recorded in the module header — because the
// benchmark's exact assertions (cold start resolves in exactly 7
// investigation steps, the experienced instance in exactly 1 from month 2,
// the intervention calibration error 1.5 → 0.45 → 0.15) require the
// walk arithmetic to be pinned. The SEED varies every identity-bearing
// surface (names, markers, driver phrasings, reading noise within the
// promotion envelope, message/event selection) so different seeds are
// different companies with identical, exactly-computable benchmark
// dynamics.

import type { CandidateSignals } from '@/modules/knowledge-acquisition/contract';

// ---------------------------------------------------------------------------
// Vocabularies (fixed template constants — the frozen reference company)
// ---------------------------------------------------------------------------

/** Seeded name pools — identity-bearing variation. */
const COMPANY_NAMES = [
  'Northwind Dynamics',
  'Aurora Metals',
  'Corvus Logistics',
  'Helix Fabrication',
  'Meridian Foods',
  'Sabena Components',
  'Tessera Textiles',
  'Vantage Instruments',
  'Bluepeak Supplies',
  'Iris Packaging',
  'Kepler Devices',
  'Solace Chemicals',
] as const;

const FIRST_NAMES = [
  'Dana', 'Ravi', 'Mei', 'Omar', 'Ines', 'Lena', 'Kofi', 'Yuki', 'Petra', 'Marco',
  'Aisha', 'Tomas', 'Nadia', 'Felix', 'Sofia', 'Arjun',
] as const;

const LAST_NAMES = [
  'Delacroix', 'Menon', 'Tanaka', 'Haddad', 'Petrova', 'Lindqvist', 'Mensah', 'Sato',
  'Novak', 'Rossi', 'Diallo', 'Vargas', 'Weber', 'Kimura', 'Costa', 'Reyes',
] as const;

/** The eight recurring monthly topics (the gap-of-the-month cycle). */
export const TOPIC_CYCLE: readonly string[] = [
  'churn-driver',
  'supplier-delay',
  'fulfillment-cost',
  'ticket-backlog',
  'revenue-leak',
  'inventory-drift',
  'pricing-elasticity',
  'contract-renewal',
] as const;

/** The hidden driver phrasings the month's true answer names. */
const DRIVER_PHRASINGS: readonly string[] = [
  'an aggressive price change on the mid-tier plans',
  'a fulfillment SLA miss at the main warehouse',
  'a stale quote-to-cash handoff',
  'a support backlog spillover',
  'a revenue recognition gap in renewals',
  'an inventory reconciliation drift',
  'a pricing elasticity misread',
  'an expiring enterprise contract clause',
] as const;

/** External events the world presents each month (observable, not truth). */
const EXTERNAL_EVENT_TYPES: readonly string[] = [
  'regulator.deadline.announced',
  'competitor.price.cut',
  'supplier.rate.hike',
  'market.demand.shift',
  'regulator.rule.updated',
  'competitor.launch',
  'supplier.leadtime.worsened',
  'market.credit.tightened',
] as const;

/** Message chatter pool — topic-adjacent, never ground truth. */
const MESSAGE_TEXTS: readonly string[] = [
  'the numbers this month look off, we should look into it',
  'I flagged the monthly review for deeper digging',
  'leadership asked for the driver analysis again',
  'can someone sanity-check the latest export',
  'the dashboard delta surprised me this morning',
  'ops says the pattern repeats every quarter',
] as const;

/** Employees of the reference company (structure fixed; names seeded). */
export interface EmployeeDesign {
  /** Display name (seeded). */
  fullName: string;
  title: string;
  department: string;
  /**
   * PUBLIC org-chart authority (the planner's ADR-0018 authority signal).
   * The org chart knows seniority, not competence — hidden answer quality
   * is deliberately NOT reflected here (that is exactly what must be
   * LEARNED into the CompanyModel).
   */
  authority: number;
  /** HIDDEN true answer quality of this employee (ground truth). */
  hiddenQuality: number;
}

/** Systems of record of the reference company (CRM/ERP-like). */
export interface SystemDesign {
  /** Stable machine key, e.g. 'billing-crm'. */
  key: string;
  /** Display label (public). */
  label: string;
  /** The sources module (W036) provider the connection registers under. */
  provider: 'salesforce' | 'quickbooks' | 'confluence' | 'google-drive';
  /** PUBLIC authority signal. */
  authority: number;
  /** HIDDEN true answer quality (ground truth). */
  hiddenQuality: number;
  /** Estimated investigation cost, integer minor units of the mission currency. */
  costMinor: number;
}

/** One month of the synthetic company's life (seeded). */
export interface MonthScenario {
  month: number;
  topic: string;
  /**
   * The monthly churn reading (public evidence). Seeded within the
   * promotion envelope: the goal stays off target with low driver
   * confidence, so goal-gap discovery promotes exactly one driver unknown
   * for every seed and every month (verified by the unit test against the
   * attention module's own pure derivation).
   */
  readingValue: number;
  /** Two employee messages (public chatter). */
  messages: ReadonlyArray<{ senderIndex: number; text: string }>;
  /** One external event (public). */
  externalEvent: { type: string; label: string };
  /** The hidden consequential fact of the month (ground truth). */
  hidden: {
    /** Unique leak-detection sentinel — never appears outside simulator tables. */
    marker: string;
    /** The month's true driver (what a sufficient investigation reveals). */
    driver: string;
    /** The answer a source with sufficient quality returns. */
    answerText: string;
    /** Whether the discovered gap is consequential (judgment ground truth). */
    consequential: boolean;
    /** The minimal hidden quality a first-choice source needs to be 'correct'. */
    firstChoiceCorrectThreshold: number;
  };
}

/** The full seeded company design (pure function of the seed). */
export interface CompanyDesign {
  seed: number;
  companyName: string;
  employees: readonly EmployeeDesign[];
  systems: readonly SystemDesign[];
  teams: readonly string[];
  projects: readonly string[];
  suppliers: ReadonlyArray<{ name: string; kind: 'supplier' | 'subcontractor' }>;
  process: {
    name: string;
    eventTypes: readonly string[];
    /** Per-flow step offsets in minutes; the slow middle edge is the bottleneck. */
    flows: ReadonlyArray<readonly number[]>;
  };
  goal: {
    title: string;
    objective: string;
    desiredState: string;
    metricName: string;
    metricUnit: string;
    threshold: number;
    horizonEnd: string;
    /** Reading driver confidence the monthly claim carries (public, low). */
    driverConfidence: number;
  };
  intervention: {
    /** The W054 intervention kind (§13's acquisition options). */
    kind: 'install_extension';
    name: string;
    capabilityLabel: string;
    recommendationLabel: string;
    metricName: string;
    metricUnit: string;
    /** The uninformed (cold) expectation — optimistic. */
    baseExpectation: number;
    /** The hidden realized value (ground truth, stable). */
    realizedValue: number;
  };
  missionBudget: { amount: number; currency: string };
  rewardBudget: { amount: number; currency: string };
  months: readonly MonthScenario[];
}

// ---------------------------------------------------------------------------
// Fixed reference-company constants (the exact benchmark arithmetic)
// ---------------------------------------------------------------------------

/** The five employees: authority is public, quality is hidden ground truth. */
export const REFERENCE_EMPLOYEES: readonly EmployeeDesign[] = [
  { fullName: '', title: 'Controller', department: 'Finance', authority: 0.62, hiddenQuality: 0.72 },
  { fullName: '', title: 'Operations lead', department: 'Operations', authority: 0.6, hiddenQuality: 0.8 },
  { fullName: '', title: 'Support lead', department: 'Support', authority: 0.58, hiddenQuality: 0.7 },
  { fullName: '', title: 'Warehouse specialist', department: 'Fulfillment', authority: 0.54, hiddenQuality: 0.5 },
  { fullName: '', title: 'Finance analyst', department: 'Finance', authority: 0.52, hiddenQuality: 0.45 },
] as const;

/**
 * The four systems of record. The CRM is the single best-informed source
 * (hidden quality 0.98, the only one at or above the mission's required
 * confidence 0.9) while carrying the LOWEST public authority of the
 * plausible candidates — the cold-start instance therefore walks six
 * mediocre sources before reaching it (exactly 7 steps), and the
 * experienced instance routes to it first from month 2 on (exactly 1 step).
 */
export const REFERENCE_SYSTEMS: readonly SystemDesign[] = [
  { key: 'billing-crm', label: 'Billing CRM', provider: 'salesforce', authority: 0.48, hiddenQuality: 0.98, costMinor: 150 },
  { key: 'erp', label: 'ERP', provider: 'quickbooks', authority: 0.46, hiddenQuality: 0.75, costMinor: 200 },
  { key: 'wiki', label: 'Company Wiki', provider: 'confluence', authority: 0.5, hiddenQuality: 0.6, costMinor: 0 },
  { key: 'sheets', label: 'Ops Spreadsheets', provider: 'google-drive', authority: 0.44, hiddenQuality: 0.25, costMinor: 0 },
] as const;

export const REFERENCE_TEAM_POOL = [
  'Revenue Operations',
  'Fulfillment Group',
  'Client Success',
  'Logistics Cell',
] as const;
export const REFERENCE_PROJECT_POOL = [
  'Atlas Rollout',
  'Beacon Migration',
  'Compass Upgrade',
  'Delta Retrofit',
] as const;
export const REFERENCE_SUPPLIER_POOL = [
  'Corvus Freight',
  'Halcyon Shipping',
  'Brightwall Cargo',
  'Meridian Haulage',
] as const;
export const REFERENCE_SUBCONTRACTOR_POOL = [
  'Lumen Components',
  'Ardent Parts',
  'Ferrum Supply',
  'Nordic Tooling',
] as const;

/** Two distinct picks from a pool (deterministic under the rng). */
function pickTwoDistinct(rng: () => number, pool: readonly string[]): [string, string] {
  const first = Math.floor(rng() * pool.length) % pool.length;
  const second = (first + 1 + Math.floor(rng() * (pool.length - 1))) % pool.length;
  return [pool[first]!, pool[second]!];
}

/**
 * The order-to-cash event pattern: four flows; the reviewed→approved edge
 * is fast in flow 1 (10 minutes) and slow (7200 seconds) in flows 2–4, so
 * process reconstruction (W016, with a 3000-second bottleneck threshold
 * and min-edge-instances 2) reports a bottleneck on that edge.
 */
export const REFERENCE_PROCESS_FLOWS: ReadonlyArray<readonly number[]> = [
  [0, 10, 20, 30],
  [600, 610, 7300, 7310],
  [1200, 1210, 8410, 8420],
  [1800, 1810, 9010, 9020],
] as const;
export const REFERENCE_PROCESS_EVENT_TYPES = [
  'order.received',
  'order.reviewed',
  'order.approved',
  'order.fulfilled',
] as const;
export const BOTTLENECK_THRESHOLD_SECONDS = 3000;

/** The goal-gap discovery reading envelope (see MonthScenario.readingValue). */
export const READING_ENVELOPE = { base: 8.8, span: 0.4 } as const;
/** Claimed driver confidence of the monthly reading (public, low). */
export const READING_DRIVER_CONFIDENCE = 0.2;

/** How many months the synthetic company lives. */
export const TOTAL_MONTHS = 24;
/** The benchmark's measurement checkpoints (LONGITUDINAL-BENCHMARK.md). */
export const BENCHMARK_MONTHS: readonly number[] = [1, 3, 6, 12, 24] as const;

/** Mission investigation budget (integer minor units + ISO currency). */
export const MISSION_BUDGET = { amount: 50_000, currency: 'EUR' } as const;
export const REWARD_BUDGET = { amount: 5_000, currency: 'EUR' } as const;

/** The goal-gap discovery materiality policy — frozen for every call. */
export const MATERIALITY_POLICY = Object.freeze({
  impactThreshold: 0.5,
  valueThreshold: 0.5,
});

/** The rankCandidates policy for source selection — frozen for every call. */
export const SOURCE_RANK_POLICY = Object.freeze({
  allowedKinds: Object.freeze(['employee', 'source']),
});

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32 — the repo's established fixture PRNG)
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32): the same seed, the same world. */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length) % pool.length]!;
}

function deriveMarker(seed: number, month: number): string {
  return `gt-${seed.toString(16).padStart(8, '0')}-m${String(month).padStart(2, '0')}`;
}

/**
 * Derives the complete synthetic company design from the seed — pure,
 * total, deterministic. The structure (roles, authorities, costs, hidden
 * qualities, thresholds, budgets) is the frozen reference template; the
 * seed varies names, markers, driver phrasings, reading noise and
 * message/event selection.
 */
export function deriveCompanyDesign(seed: number): CompanyDesign {
  const rng = mulberry32(seed);

  // Employees: seeded names on the fixed role structure.
  const usedNames = new Set<string>();
  const employees: EmployeeDesign[] = REFERENCE_EMPLOYEES.map((template) => {
    let fullName = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    for (let attempt = 0; usedNames.has(fullName) && attempt < 64; attempt += 1) {
      fullName = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    }
    usedNames.add(fullName);
    return { ...template, fullName };
  });

  // Months: one scenario per month, a pure function of (seed, month).
  const months: MonthScenario[] = [];
  for (let month = 1; month <= TOTAL_MONTHS; month += 1) {
    const topicIndex = (month - 1) % TOPIC_CYCLE.length;
    const topic = TOPIC_CYCLE[topicIndex]!;
    const monthRng = mulberry32((seed ^ 0x9e3779b9) + month * 2654435761);
    const readingValue =
      Math.round((READING_ENVELOPE.base + READING_ENVELOPE.span * monthRng()) * 100) / 100;
    const driver = DRIVER_PHRASINGS[(topicIndex + Math.floor(rng() * 2)) % DRIVER_PHRASINGS.length]!;
    const messageCount = 2;
    const messages: Array<{ senderIndex: number; text: string }> = [];
    for (let index = 0; index < messageCount; index += 1) {
      messages.push({
        senderIndex: Math.floor(monthRng() * employees.length) % employees.length,
        text: pick(monthRng, MESSAGE_TEXTS),
      });
    }
    months.push({
      month,
      topic,
      readingValue,
      messages,
      externalEvent: {
        type: EXTERNAL_EVENT_TYPES[topicIndex]!,
        label: `external signal for ${topic}`,
      },
      hidden: {
        marker: deriveMarker(seed, month),
        driver,
        answerText: `The dominant driver behind ${topic} in month ${month} is ${driver}.`,
        consequential: true,
        firstChoiceCorrectThreshold: 0.9,
      },
    });
  }

  return {
    seed,
    companyName: pick(rng, COMPANY_NAMES),
    employees,
    systems: REFERENCE_SYSTEMS,
    teams: pickTwoDistinct(rng, REFERENCE_TEAM_POOL),
    projects: pickTwoDistinct(rng, REFERENCE_PROJECT_POOL),
    suppliers: [
      { name: pick(rng, REFERENCE_SUPPLIER_POOL), kind: 'supplier' as const },
      { name: pick(rng, REFERENCE_SUBCONTRACTOR_POOL), kind: 'subcontractor' as const },
    ],
    process: {
      // The seed suffix keeps the process name tenant-unique when one
      // tenant materializes several companies (process names are unique
      // per tenant; a repeated name would append versions instead).
      name: `Order to Cash (c${seed.toString(16)})`,
      eventTypes: REFERENCE_PROCESS_EVENT_TYPES,
      flows: REFERENCE_PROCESS_FLOWS,
    },
    goal: {
      title: 'Keep monthly churn under control',
      objective: 'Bring monthly customer churn back under control and keep it there',
      desiredState: 'Monthly churn at or below 6 percent',
      metricName: 'monthly-churn-rate',
      metricUnit: 'percent',
      threshold: 6,
      horizonEnd: '2028-12-31T00:00:00.000Z',
      driverConfidence: READING_DRIVER_CONFIDENCE,
    },
    intervention: {
      kind: 'install_extension',
      name: 'invoice-matching-automation',
      capabilityLabel: 'Invoice matching automation',
      recommendationLabel: 'Automate invoice matching on the order-to-cash bottleneck',
      metricName: 'invoices matched automatically',
      metricUnit: 'invoices',
      baseExpectation: 12,
      realizedValue: 10.5,
    },
    missionBudget: { ...MISSION_BUDGET },
    rewardBudget: { ...REWARD_BUDGET },
    months,
  };
}

// ---------------------------------------------------------------------------
// Planner-signal composition (the benchmark's learned-signal channel)
// ---------------------------------------------------------------------------

/**
 * The neutral public signals every candidate starts from (the planner's
 * ADR-0018 signal values are caller-supplied; these are the fixed
 * policy/workflow-level inputs the simulator's driver passes):
 * relevance/freshness/prior-contribution-value are neutral for every
 * candidate (the cold-start tenant has no transactive memory), authority is
 * the public org-chart value, and cost is the explicit public cost. The
 * LEARNED signals — reliability and expected quality — carry the
 * CompanyModel's blended prior (W053 rankCandidates on the
 * source_selection domain); with no prior they stay at the neutral 0.5, so
 * a cold-start instance and a not-yet-learning instance feed the planner
 * byte-identical signals (the benchmark's month-1 equivalence).
 */
export const NEUTRAL_SIGNAL = 0.5;

/** The planner signals of one menu candidate — pure composition. */
export function composePlannerSignals(
  menu: ReadonlyArray<{
    kind: 'person' | 'system';
    id: string;
    label: string;
    authority: number;
    costMinor: number;
  }>,
  /** Learned prior blend per candidate key ('employee:<id>' / 'source:<id>'). */
  learnedByKey: ReadonlyMap<string, number>,
): CandidateSignals[] {
  return menu.map((candidate) => {
    const key = `${candidate.kind === 'person' ? 'employee' : 'source'}:${candidate.id}`;
    const learned = learnedByKey.get(key);
    const blend = learned === undefined ? NEUTRAL_SIGNAL : learned;
    return {
      kind: candidate.kind,
      id: candidate.id,
      label: candidate.label,
      relevance: NEUTRAL_SIGNAL,
      reliability: blend,
      freshness: NEUTRAL_SIGNAL,
      authority: candidate.authority,
      expectedQuality: blend,
      priorContributionValue: NEUTRAL_SIGNAL,
      cost: candidate.costMinor,
      access: 'allowed' as const,
    };
  });
}

/**
 * The intervention expectation of one month — the recommendation-quality
 * leg. The cold expectation is the base; the experienced instance blends
 * the learned intervention prior (W053 rankCandidates on the intervention
 * domain, baseScore 1.0 so "no prior" means "expect the base in full").
 * The learned prior score is the realized/expected ratio of past
 * interventions, so the expectation converges toward the hidden realized
 * value as confidence grows: error 1.5 → 0.45 → 0.15 for the reference
 * company, against the cold start's constant 1.5.
 */
export function interventionExpectation(baseExpectation: number, blendScore: number): number {
  return Math.round(baseExpectation * blendScore * 1000) / 1000;
}

/**
 * The confidence schedule of recorded CompanyModel assertions: the k-th
 * version of a subject's chain is recorded at min(0.9, 0.4 + 0.15·k) —
 * version 1 at 0.55, 2 at 0.7, 3 at 0.85, 4+ at 0.9 (monotone, capped).
 */
export function nextPriorConfidence(currentVersions: number): number {
  return Math.min(0.9, 0.4 + 0.15 * (currentVersions + 1));
}
