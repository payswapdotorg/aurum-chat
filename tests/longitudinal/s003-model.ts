// ============================================================================
// W100 — the pure S003 CONVERSION MODEL (tests/longitudinal/s003-model.ts).
//
// The deterministic, seeded firm/scenario/effort/trust model of the S003
// conversion benchmark (tests/longitudinal/s003-conversion.benchmark.test.ts
// is the orchestrator; THIS file is the pure engine — no database, no
// context, no clock, no imports beyond types). Every function here is a
// total deterministic function of the SEED, so identical seeds produce
// byte-identical scenario traces (the work item's "reproducible seeds"
// acceptance), and the orchestrator's assertions can rely on exact
// arithmetic the way the W056 benchmark relies on world.ts.
//
// WHAT IS MODELED vs WHAT IS MEASURED (the honesty split):
//   * MODELED here — the FIRM (industry, size, incumbent systems), the
//     WORK SCENARIOS (per-industry workflow templates; a seeded selection
//     per checkpoint), the scenario-step → capability-requirement mapping,
//     the BASELINE (pre-S003) manual-integration effort protocol, and the
//     routing DECISION RULE (which surface may serve a step).
//   * MEASURED by the orchestrator — whether a capability is actually HELD:
//     kit grants (vertical-kits), connected systems + capability floors +
//     grants (integration-intelligence / connection-broker /
//     capability-grants), live meeting/cellular channels (meetings /
//     cellular), active supervised agents (agent-supervision). The routing
//     function below takes an AdoptionSnapshot the orchestrator derives
//     ONLY from module reads — never from this file's constants — so every
//     conversion delta is attributable to recorded capability adoption,
//     not to scenario differences (the same scenario set is evaluated on
//     both sides).
//
// THE FIVE MEASUREMENTS (metric definitions of record — the same text is
// embedded in every emitted artifact's schema header):
//   1. AURUM-PRIMARY willingness — the fraction of a firm's modeled work
//      scenarios at a checkpoint whose FIRST step routes to Aurum. A
//      scenario is routed through Aurum first when the surface that serves
//      its entry step is one Aurum holds (core intelligence, a kit grant,
//      a connected system's floor/grant, a live meeting/cellular channel,
//      or an active supervised agent).
//   2. AURUM-ONLY willingness — the fraction of scenarios whose EVERY step
//      routes to Aurum (no context exit to any incumbent tool).
//   3. CONTEXT-SWITCHING — the expected number of tool switches per
//      scenario: adjacent step pairs served by different tools (Aurum or a
//      specific incumbent system/work surface). Exits AND re-entries both
//      count (each adjacency change is one switch).
//   4. INTEGRATION SETUP EFFORT — modeled action-minutes to connect the
//      firm's incumbent systems (and import their history): the pre-S003
//      path is a documented manual per-integration protocol; the S003 path
//      is the MEASURED W096 discover→…→outcome chain + W094 migration
//      import the orchestrator actually executed, weighted by the same
//      documented action weights.
//   5. TRUST and REALIZED VALUE — trust = the fraction of the firm's
//      automation/agent action portfolio that Aurum executes and completes
//      without human rollback (supervised agent executions delivered with
//      the supervision still active; capability invocations allowed by an
//      active floor/grant and not revoked); realized value = the W055
//      quality-metric families (recommendation calibration, intervention
//      realized-vs-expected, evidence quality) evaluated on the matured
//      surface — carried by the orchestrator from the quality module's own
//      snapshots, not computed here.
// ============================================================================

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** The three modeled industries: the two W092 kit verticals + one kit-less. */
export type S003Industry = 'legal' | 'accounting' | 'logistics';

/** Firm sizes; the size decides the incumbent-system count and portfolio depth. */
export type S003FirmSize = 'solo' | 'small' | 'mid' | 'large';

/** Which surface may serve one scenario step. */
export type S003StepOrigin =
  /** The S002 core intelligence loop (observe/investigate/recommend/brief). */
  | 'core'
  /** A vertical capability minted by an installed W092 starter kit. */
  | 'kit'
  /** A capability of a connected incumbent system (W081/W082/W083). */
  | 'connection'
  /** A live meeting channel (W085 ingestion + capture). */
  | 'meeting'
  /** Live cellular/SMS/voice reachability (W087). */
  | 'cellular'
  /** An active supervised agent (W098). */
  | 'supervision'
  /** Work no software surface serves (physical/offline) — never converts. */
  | 'incumbent-only';

/** The benchmark checkpoints (the W056 measurement months). */
export const S003_CHECKPOINTS: readonly number[] = [1, 3, 6, 12, 24] as const;

/** Scenarios evaluated per checkpoint, by firm size. */
export const S003_SCENARIOS_PER_CHECKPOINT: Record<S003FirmSize, number> = {
  solo: 3,
  small: 4,
  mid: 5,
  large: 6,
};

/** Incumbent systems, by size (the first N roles of the industry's list). */
export const S003_SYSTEM_COUNT: Record<S003FirmSize, number> = {
  solo: 1,
  small: 2,
  mid: 3,
  large: 4,
};

// ---------------------------------------------------------------------------
// The deterministic PRNG (the simulator module's own mulberry32, re-derived
// here so the model file stays import-free; same algorithm, same arithmetic)
// ---------------------------------------------------------------------------

export function s003Mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A per-(seed, salt) rng — the scenario derivation's only entropy source. */
function rngOf(seed: number, salt: number): () => number {
  return s003Mulberry32((seed ^ 0x9e3779b9) + salt * 2654435761);
}

// ---------------------------------------------------------------------------
// Firm designs (the seeded half — names; the structure is a frozen template)
// ---------------------------------------------------------------------------

/** One incumbent system role: what the firm runs, and what it can serve. */
export interface S003SystemRoleSpec {
  /** Stable role key ('case-mgmt', 'tms', ...) — the incumbent tool identity. */
  role: string;
  displayName: string;
  /** W081 registry capability classes → read.<class>/write.<class> surface. */
  capabilityClasses: readonly string[];
}

export interface S003FirmDesign {
  seed: number;
  industry: S003Industry;
  size: S003FirmSize;
  firmName: string;
  systems: readonly S003SystemRoleSpec[];
  /** The primary system of record (migration import + deep-action target). */
  primarySystemRole: string;
}

const FIRM_NAME_POOLS: Record<S003Industry, readonly string[]> = {
  legal: ['Halloran & Voss LLP', 'Mercer Legal Group', 'Kestrel Law Partners', 'Delmar Attorneys'],
  accounting: ['Bright Ledger Advisory', 'Solvent & Co Accountants', 'Pemberrow Books', 'Ardent Tax Partners'],
  logistics: ['Corvus Freight Systems', 'Meridian Haulage Ops', 'Northport Logistics', 'Atlas Cargo Group'],
};

const INDUSTRY_SYSTEMS: Record<S003Industry, readonly S003SystemRoleSpec[]> = {
  legal: [
    { role: 'case-mgmt', displayName: 'Matter System of Record', capabilityClasses: ['customer-records', 'project-tracking'] },
    { role: 'docket-cal', displayName: 'Docket & Calendar System', capabilityClasses: ['calendar-scheduling'] },
    { role: 'billing', displayName: 'Legal Billing System', capabilityClasses: ['billing-payments'] },
    { role: 'doc-vault', displayName: 'Document Vault', capabilityClasses: ['document-collaboration'] },
  ],
  accounting: [
    { role: 'ledger-erp', displayName: 'Ledger ERP System of Record', capabilityClasses: ['accounting-finance', 'billing-payments'] },
    { role: 'ar-aging', displayName: 'Receivables Aging System', capabilityClasses: ['billing-payments'] },
    { role: 'payroll', displayName: 'Payroll System', capabilityClasses: ['accounting-finance'] },
    { role: 'expenses', displayName: 'Expense System', capabilityClasses: ['accounting-finance'] },
  ],
  logistics: [
    { role: 'tms', displayName: 'Transport Management System', capabilityClasses: ['project-tracking', 'customer-records'] },
    { role: 'wms', displayName: 'Warehouse Management System', capabilityClasses: ['project-tracking'] },
    { role: 'carrier-portal', displayName: 'Carrier Portal', capabilityClasses: ['workflows-automation'] },
    { role: 'customs-broker', displayName: 'Customs Broker Portal', capabilityClasses: ['document-collaboration'] },
  ],
};

export function deriveS003Firm(
  seed: number,
  industry: S003Industry,
  size: S003FirmSize,
): S003FirmDesign {
  const rng = rngOf(seed, 97);
  const names = FIRM_NAME_POOLS[industry]!;
  return {
    seed,
    industry,
    size,
    firmName: names[Math.floor(rng() * names.length) % names.length]!,
    systems: INDUSTRY_SYSTEMS[industry]!.slice(0, S003_SYSTEM_COUNT[size]!),
    primarySystemRole: INDUSTRY_SYSTEMS[industry]![0]!.role,
  };
}

// ---------------------------------------------------------------------------
// The work-scenario templates (frozen per industry; the seed selects)
// ---------------------------------------------------------------------------

export interface S003ScenarioStepSpec {
  key: string;
  action: string;
  origin: S003StepOrigin;
  /**
   * The capability key the step requires (kit and connection origins). For
   * kit steps this is a W092 kit capability key; for connection steps a
   * W081 read.<class>/write.<class> capability key.
   */
  capabilityKey?: string;
  /**
   * The incumbent system role the step's work belongs to (the incumbent
   * tool the firm exits to when Aurum does not hold the capability). Kit
   * steps name their vertical system of record; non-system steps name a
   * stable pseudo-tool ('field-phones', 'meeting-tools', 'manual-work',
   * 'physical-only').
   */
  incumbentTool: string;
}

export interface S003ScenarioTemplate {
  key: string;
  title: string;
  steps: readonly S003ScenarioStepSpec[];
}

// -- legal (kit: legal-case-management) -------------------------------------

const LEGAL_TEMPLATES: readonly S003ScenarioTemplate[] = [
  {
    key: 'matter-intake',
    title: 'New client matter intake and conflict screen',
    steps: [
      { key: 'intake', action: 'Capture the new matter details', origin: 'kit', capabilityKey: 'write.case-matters', incumbentTool: 'case-mgmt' },
      { key: 'conflicts', action: 'Screen the client for conflicts', origin: 'kit', capabilityKey: 'read.case-matters', incumbentTool: 'case-mgmt' },
      { key: 'deadlines', action: 'Calendar the statutory deadlines', origin: 'kit', capabilityKey: 'write.docket-entries', incumbentTool: 'docket-cal' },
      { key: 'brief', action: 'Brief the supervising partner', origin: 'core', incumbentTool: 'manual-work' },
    ],
  },
  {
    key: 'docket-deadline-sweep',
    title: 'Morning docket deadline sweep',
    steps: [
      { key: 'review', action: "Review tomorrow's court dates", origin: 'kit', capabilityKey: 'read.docket-calendar', incumbentTool: 'docket-cal' },
      { key: 'flag', action: 'Flag the at-risk deadline', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'reach', action: 'Reach the attorney in the field', origin: 'cellular', incumbentTool: 'field-phones' },
      { key: 'update', action: 'Update the docket entry', origin: 'kit', capabilityKey: 'write.docket-entries', incumbentTool: 'docket-cal' },
    ],
  },
  {
    key: 'engagement-letter-round',
    title: 'Engagement letter round for a renewed matter',
    steps: [
      { key: 'history', action: 'Pull the matter billing history', origin: 'kit', capabilityKey: 'read.billing-records', incumbentTool: 'billing' },
      { key: 'draft', action: 'Draft the letter structure', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'file', action: 'File the executed letter', origin: 'connection', capabilityKey: 'write.document-collaboration', incumbentTool: 'doc-vault' },
      { key: 'record', action: 'Record the engagement on the matter', origin: 'kit', capabilityKey: 'write.case-matters', incumbentTool: 'case-mgmt' },
    ],
  },
  {
    key: 'matter-status-briefing',
    title: 'Client matter-status briefing',
    steps: [
      { key: 'assemble', action: 'Assemble the matter statuses', origin: 'kit', capabilityKey: 'read.case-matters', incumbentTool: 'case-mgmt' },
      { key: 'summarize', action: 'Summarize for the client meeting', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'capture', action: 'Capture the client meeting', origin: 'meeting', incumbentTool: 'meeting-tools' },
      { key: 'followup', action: 'Send the follow-up commitments', origin: 'cellular', incumbentTool: 'field-phones' },
    ],
  },
  {
    key: 'billing-review',
    title: 'Monthly billing review and correction sync',
    steps: [
      { key: 'pull', action: "Pull the month's time entries", origin: 'kit', capabilityKey: 'read.billing-records', incumbentTool: 'billing' },
      { key: 'leak', action: 'Flag unbilled and leaked work', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'sync', action: 'Sync the corrections to billing', origin: 'connection', capabilityKey: 'write.billing-payments', incumbentTool: 'billing' },
      { key: 'brief', action: 'Brief the finance partner', origin: 'core', incumbentTool: 'manual-work' },
    ],
  },
  {
    key: 'matter-cycle-investigation',
    title: 'Matter cycle-time slip investigation',
    steps: [
      { key: 'investigate', action: 'Investigate why matter cycle time slipped', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'statuses', action: 'Pull the matter statuses', origin: 'kit', capabilityKey: 'read.case-matters', incumbentTool: 'case-mgmt' },
      { key: 'quantify', action: 'Quantify the slippage', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'plan', action: 'Update the matter plan', origin: 'kit', capabilityKey: 'write.case-matters', incumbentTool: 'case-mgmt' },
    ],
  },
  {
    key: 'contract-review-round',
    title: 'Contract review round with outside counsel',
    steps: [
      { key: 'corpus', action: 'Pull the contract corpus', origin: 'connection', capabilityKey: 'read.document-collaboration', incumbentTool: 'doc-vault' },
      { key: 'screen', action: 'Screen for risky clauses', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'agent', action: 'Run the deep review agent', origin: 'supervision', incumbentTool: 'manual-work' },
      { key: 'dispatch', action: 'Dispatch the overnight instructions', origin: 'cellular', incumbentTool: 'field-phones' },
      { key: 'courier', action: 'Courier the signed originals', origin: 'incumbent-only', incumbentTool: 'physical-only' },
    ],
  },
];

// -- accounting (kit: accounting-ledger-erp) ---------------------------------

const ACCOUNTING_TEMPLATES: readonly S003ScenarioTemplate[] = [
  {
    key: 'period-close-prep',
    title: 'Period close preparation',
    steps: [
      { key: 'checklist', action: 'Pull the close checklist state', origin: 'kit', capabilityKey: 'read.ledger-accounts', incumbentTool: 'ledger-erp' },
      { key: 'unposted', action: 'Flag the unposted entries', origin: 'kit', capabilityKey: 'read.journal-entries', incumbentTool: 'ledger-erp' },
      { key: 'post', action: 'Post the adjusting entries', origin: 'kit', capabilityKey: 'write.journal-entries', incumbentTool: 'ledger-erp' },
      { key: 'brief', action: 'Brief the controller', origin: 'core', incumbentTool: 'manual-work' },
    ],
  },
  {
    key: 'receivables-aging-review',
    title: 'Receivables aging review and collections',
    steps: [
      { key: 'buckets', action: 'Pull the AR aging buckets', origin: 'kit', capabilityKey: 'read.receivables-ledger', incumbentTool: 'ar-aging' },
      { key: 'priorities', action: 'Identify the collection priorities', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'reach', action: 'Reach the delinquent client', origin: 'cellular', incumbentTool: 'field-phones' },
      { key: 'record', action: 'Record the promise to pay', origin: 'connection', capabilityKey: 'write.billing-payments', incumbentTool: 'ar-aging' },
    ],
  },
  {
    key: 'journal-entry-validation',
    title: 'Drafted journal entry validation',
    steps: [
      { key: 'drafts', action: 'Pull the drafted entries', origin: 'kit', capabilityKey: 'read.journal-entries', incumbentTool: 'ledger-erp' },
      { key: 'invariants', action: 'Check the balance invariants', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'post', action: 'Post the balanced set', origin: 'kit', capabilityKey: 'write.journal-entries', incumbentTool: 'ledger-erp' },
    ],
  },
  {
    key: 'payables-review',
    title: 'Payables review and payment scheduling',
    steps: [
      { key: 'ap', action: 'Pull the AP aging', origin: 'kit', capabilityKey: 'read.payables-ledger', incumbentTool: 'ledger-erp' },
      { key: 'duplicates', action: 'Flag the duplicate bills', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'schedule', action: 'Schedule the payments', origin: 'connection', capabilityKey: 'write.accounting-finance', incumbentTool: 'ledger-erp' },
    ],
  },
  {
    key: 'revenue-leak-investigation',
    title: 'Revenue leak investigation',
    steps: [
      { key: 'investigate', action: 'Investigate the revenue leak signal', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'balances', action: 'Pull the ledger balances', origin: 'kit', capabilityKey: 'read.ledger-accounts', incumbentTool: 'ledger-erp' },
      { key: 'quantify', action: 'Quantify the leak', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'correction', action: 'Post the correction', origin: 'kit', capabilityKey: 'write.journal-entries', incumbentTool: 'ledger-erp' },
    ],
  },
  {
    key: 'expense-round',
    title: 'Expense report round',
    steps: [
      { key: 'reports', action: 'Pull the expense reports', origin: 'connection', capabilityKey: 'read.accounting-finance', incumbentTool: 'expenses' },
      { key: 'violations', action: 'Flag the policy violations', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'notify', action: 'Notify the approver offsite', origin: 'cellular', incumbentTool: 'field-phones' },
      { key: 'export', action: 'Export the audit trail', origin: 'connection', capabilityKey: 'write.accounting-finance', incumbentTool: 'expenses' },
    ],
  },
  {
    key: 'client-close-briefing',
    title: 'Client close walkthrough briefing',
    steps: [
      { key: 'summary', action: 'Assemble the close summary', origin: 'kit', capabilityKey: 'read.ledger-accounts', incumbentTool: 'ledger-erp' },
      { key: 'agent', action: 'Run the close review agent', origin: 'supervision', incumbentTool: 'manual-work' },
      { key: 'walkthrough', action: 'Capture the client walkthrough', origin: 'meeting', incumbentTool: 'meeting-tools' },
      { key: 'mail', action: 'Mail the filed returns', origin: 'incumbent-only', incumbentTool: 'physical-only' },
    ],
  },
];

// -- logistics (KIT-LESS — the core-independence control industry) -----------

const LOGISTICS_TEMPLATES: readonly S003ScenarioTemplate[] = [
  {
    key: 'shipment-exception-triage',
    title: 'Shipment exception triage',
    steps: [
      { key: 'stalled', action: 'Detect the stalled shipments', origin: 'connection', capabilityKey: 'read.project-tracking', incumbentTool: 'tms' },
      { key: 'diagnose', action: 'Diagnose the root cause', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'notify', action: 'Notify the affected customer', origin: 'cellular', incumbentTool: 'field-phones' },
      { key: 'update', action: 'Update the shipment record', origin: 'connection', capabilityKey: 'write.project-tracking', incumbentTool: 'tms' },
    ],
  },
  {
    key: 'carrier-sla-review',
    title: 'Carrier SLA review and escalation',
    steps: [
      { key: 'ledger', action: "Pull the week's shipment SLA ledger", origin: 'connection', capabilityKey: 'read.project-tracking', incumbentTool: 'tms' },
      { key: 'breaches', action: 'Compute the SLA breaches', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'escalate', action: 'Escalate to the carrier', origin: 'connection', capabilityKey: 'write.workflows-automation', incumbentTool: 'carrier-portal' },
      { key: 'brief', action: 'Brief the ops manager', origin: 'core', incumbentTool: 'manual-work' },
    ],
  },
  {
    key: 'delivery-exception-briefing',
    title: 'Delivery exception briefing',
    steps: [
      { key: 'misses', action: 'Pull the missed deliveries', origin: 'connection', capabilityKey: 'read.customer-records', incumbentTool: 'tms' },
      { key: 'investigate', action: 'Investigate the delivery misses', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'review', action: 'Capture the carrier review meeting', origin: 'meeting', incumbentTool: 'meeting-tools' },
      { key: 'recovery', action: 'Dispatch the recovery instructions', origin: 'cellular', incumbentTool: 'field-phones' },
      { key: 'commitments', action: 'Update the customer commitments', origin: 'connection', capabilityKey: 'write.customer-records', incumbentTool: 'tms' },
    ],
  },
  {
    key: 'ops-weekly-review',
    title: 'Operations weekly review',
    steps: [
      { key: 'exceptions', action: "Assemble the week's shipment exceptions", origin: 'connection', capabilityKey: 'read.project-tracking', incumbentTool: 'tms' },
      { key: 'agent', action: 'Run the triage agent', origin: 'supervision', incumbentTool: 'manual-work' },
      { key: 'capture', action: 'Capture the ops review meeting', origin: 'meeting', incumbentTool: 'meeting-tools' },
      { key: 'publish', action: 'Publish the action list to the carrier portal', origin: 'connection', capabilityKey: 'write.workflows-automation', incumbentTool: 'carrier-portal' },
    ],
  },
  {
    key: 'delivery-miss-investigation',
    title: 'Delivery miss investigation',
    steps: [
      { key: 'investigate', action: 'Investigate the delivery misses', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'ledger', action: 'Pull the shipment ledger', origin: 'connection', capabilityKey: 'read.project-tracking', incumbentTool: 'tms' },
      { key: 'notify', action: 'Notify the affected customers', origin: 'cellular', incumbentTool: 'field-phones' },
      { key: 'recovery', action: 'Update the recovery plan', origin: 'connection', capabilityKey: 'write.customer-records', incumbentTool: 'tms' },
    ],
  },
  {
    key: 'inventory-drift-investigation',
    title: 'Inventory drift investigation',
    steps: [
      { key: 'counts', action: 'Pull the warehouse counts', origin: 'connection', capabilityKey: 'read.project-tracking', incumbentTool: 'wms' },
      { key: 'drift', action: 'Investigate the drift', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'adjust', action: 'Adjust the records', origin: 'connection', capabilityKey: 'write.project-tracking', incumbentTool: 'wms' },
      { key: 'brief', action: 'Brief the warehouse lead', origin: 'meeting', incumbentTool: 'meeting-tools' },
    ],
  },
  {
    key: 'customs-documentation-round',
    title: 'Customs documentation round',
    steps: [
      { key: 'manifest', action: 'Pull the shipment manifest', origin: 'connection', capabilityKey: 'read.project-tracking', incumbentTool: 'tms' },
      { key: 'assemble', action: 'Assemble the customs documents', origin: 'connection', capabilityKey: 'read.document-collaboration', incumbentTool: 'customs-broker' },
      { key: 'compliance', action: 'Verify the compliance checklist', origin: 'core', incumbentTool: 'manual-work' },
      { key: 'submit', action: 'Submit the filing', origin: 'connection', capabilityKey: 'write.document-collaboration', incumbentTool: 'customs-broker' },
      { key: 'archive', action: 'Archive the stamped originals', origin: 'incumbent-only', incumbentTool: 'physical-only' },
    ],
  },
];

const INDUSTRY_TEMPLATES: Record<S003Industry, readonly S003ScenarioTemplate[]> = {
  legal: LEGAL_TEMPLATES,
  accounting: ACCOUNTING_TEMPLATES,
  logistics: LOGISTICS_TEMPLATES,
};

// ---------------------------------------------------------------------------
// The scenario derivation — a pure function of (seed, checkpoint, firm)
// ---------------------------------------------------------------------------

export interface S003Scenario {
  key: string;
  title: string;
  steps: readonly S003ScenarioStepSpec[];
}

/**
 * The firm's work scenarios at one checkpoint: a seeded selection of
 * size-count distinct templates from the industry pool (deterministic
 * shuffle + take). The SAME selection is evaluated under the baseline and
 * the mature adoption state (and on every mature instance of the same
 * firm) — scenario identity never varies between variants.
 */
export function deriveS003Scenarios(
  seed: number,
  industry: S003Industry,
  size: S003FirmSize,
  checkpoint: number,
): S003Scenario[] {
  const pool = [...INDUSTRY_TEMPLATES[industry]!];
  const rng = rngOf(seed, 1000 + checkpoint);
  // Deterministic Fisher-Yates under the seeded rng, then take N.
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1)) % (index + 1);
    const held = pool[swap]!;
    pool[swap] = pool[index]!;
    pool[index] = held;
  }
  return pool.slice(0, S003_SCENARIOS_PER_CHECKPOINT[size]!).map((template) => ({
    key: template.key,
    title: template.title,
    steps: template.steps,
  }));
}

// ---------------------------------------------------------------------------
// The adoption snapshot (module-derived ONLY — the orchestrator fills it)
// ---------------------------------------------------------------------------

export interface S003AdoptedSystem {
  role: string;
  /** The W081 inventory system's connection is live and verified. */
  connected: boolean;
  /** Capability keys on the connection's read-only floor (W083). */
  floor: ReadonlySet<string>;
  /** Actively granted write capabilities (W083 grants). */
  grants: ReadonlySet<string>;
}

export interface S003AdoptionSnapshot {
  /** Active kit capability keys (W092 grants of an active installation). */
  kitGrants: ReadonlySet<string>;
  /** The connected incumbent systems, keyed by firm system role. */
  systems: ReadonlyMap<string, S003AdoptedSystem>;
  /** At least one ingested meeting session exists (W085). */
  meetingsLive: boolean;
  /** A live cellular connection with a delivered reach (W087). */
  cellularLive: boolean;
  /** Count of ACTIVE supervised agents (W098). */
  activeSupervisedAgents: number;
}

/** The empty adoption state — the BASELINE (pre-S003) firm. */
export function emptyS003Adoption(): S003AdoptionSnapshot {
  return {
    kitGrants: new Set(),
    systems: new Map(),
    meetingsLive: false,
    cellularLive: false,
    activeSupervisedAgents: 0,
  };
}

// ---------------------------------------------------------------------------
// The routing decision (pure; adoption-derived — no ground truth involved)
// ---------------------------------------------------------------------------

export interface S003StepRouting {
  stepKey: string;
  /** 'aurum' or the incumbent tool identity (the firm's system role / pseudo-tool). */
  tool: string;
  /** Which recorded surface authorized Aurum to serve the step (null = incumbent). */
  basis: string | null;
}

export interface S003ScenarioRouting {
  scenarioKey: string;
  steps: readonly S003StepRouting[];
  /** The first step routed to Aurum. */
  aurumPrimary: boolean;
  /** Every step routed to Aurum (no context exit). */
  aurumOnly: boolean;
  /** Adjacent tool changes across the step sequence. */
  switches: number;
}

function routeOneStep(
  step: S003ScenarioStepSpec,
  firm: S003FirmDesign,
  adoption: S003AdoptionSnapshot,
): S003StepRouting {
  switch (step.origin) {
    case 'core':
      // The S002 core intelligence loop — Aurum's pre-S003 strength.
      return { stepKey: step.key, tool: 'aurum', basis: 'core-intelligence-loop' };
    case 'kit': {
      if (adoption.kitGrants.has(step.capabilityKey!)) {
        return {
          stepKey: step.key,
          tool: 'aurum',
          basis: `kit-grant:${step.capabilityKey}`,
        };
      }
      return { stepKey: step.key, tool: step.incumbentTool, basis: null };
    }
    case 'connection': {
      const system = adoption.systems.get(step.incumbentTool);
      if (
        system !== undefined &&
        system.connected &&
        (system.floor.has(step.capabilityKey!) || system.grants.has(step.capabilityKey!))
      ) {
        return {
          stepKey: step.key,
          tool: 'aurum',
          basis: `connection:${step.incumbentTool}:${step.capabilityKey}${
            system.grants.has(step.capabilityKey!) ? ':granted' : ':floor'
          }`,
        };
      }
      return { stepKey: step.key, tool: step.incumbentTool, basis: null };
    }
    case 'meeting':
      if (adoption.meetingsLive) {
        return { stepKey: step.key, tool: 'aurum', basis: 'meeting-channel-live' };
      }
      return { stepKey: step.key, tool: step.incumbentTool, basis: null };
    case 'cellular':
      if (adoption.cellularLive) {
        return { stepKey: step.key, tool: 'aurum', basis: 'cellular-channel-live' };
      }
      return { stepKey: step.key, tool: step.incumbentTool, basis: null };
    case 'supervision':
      if (adoption.activeSupervisedAgents > 0) {
        return { stepKey: step.key, tool: 'aurum', basis: 'agent-supervision-active' };
      }
      return { stepKey: step.key, tool: step.incumbentTool, basis: null };
    case 'incumbent-only':
    default:
      return { stepKey: step.key, tool: step.incumbentTool, basis: null };
  }
}

/**
 * Route one scenario under one adoption state. NOTE: `firm` is currently
 * carried for traceability (future per-firm capability specialization);
 * the routing itself reads ONLY the adoption snapshot (module-derived
 * facts) and the scenario spec (public design) — it structurally cannot
 * consult hidden ground truth, and it does not vary between the baseline
 * and mature evaluation of the same scenario beyond the adoption state.
 */
export function routeS003Scenario(
  scenario: S003Scenario,
  firm: S003FirmDesign,
  adoption: S003AdoptionSnapshot,
): S003ScenarioRouting {
  const steps = scenario.steps.map((step) => routeOneStep(step, firm, adoption));
  let switches = 0;
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index]!.tool !== steps[index - 1]!.tool) switches += 1;
  }
  return {
    scenarioKey: scenario.key,
    steps,
    aurumPrimary: steps.length > 0 && steps[0]!.tool === 'aurum',
    aurumOnly: steps.length > 0 && steps.every((step) => step.tool === 'aurum'),
    switches,
  };
}

export interface S003ConversionMeasurement {
  scenarioCount: number;
  aurumPrimaryFraction: number;
  aurumOnlyFraction: number;
  meanSwitchesPerScenario: number;
  routings: readonly S003ScenarioRouting[];
}

/** Evaluate a firm's whole checkpoint scenario set under one adoption state. */
export function measureS003Conversion(
  firm: S003FirmDesign,
  scenarios: readonly S003Scenario[],
  adoption: S003AdoptionSnapshot,
): S003ConversionMeasurement {
  const routings = scenarios.map((scenario) => routeS003Scenario(scenario, firm, adoption));
  const count = routings.length;
  const primary = routings.filter((routing) => routing.aurumPrimary).length;
  const only = routings.filter((routing) => routing.aurumOnly).length;
  const switches = routings.reduce((sum, routing) => sum + routing.switches, 0);
  return {
    scenarioCount: count,
    aurumPrimaryFraction: count === 0 ? 0 : primary / count,
    aurumOnlyFraction: count === 0 ? 0 : only / count,
    meanSwitchesPerScenario: count === 0 ? 0 : switches / count,
    routings,
  };
}

// ---------------------------------------------------------------------------
// Measurement 4 — integration setup effort (the two paths)
// ---------------------------------------------------------------------------

/**
 * The documented action weights (modeled action-minutes). The SAME weights
 * price both paths, so the comparison isolates the STEP MIX (what work the
 * path contains), not the pricing.
 */
export const S003_EFFORT_WEIGHTS = Object.freeze({
  /** A mechanical provider-side/config action (automatic module call, review click). */
  automaticAction: 1,
  /** A human decision on the W009 authority gate (batch approval, grant ask, migration review). */
  humanApproval: 10,
  /** A human review of an import round's staged records. */
  humanRoundReview: 15,
});

/**
 * The pre-S003 manual per-integration protocol (MODELED — the documented
 * incumbent path before integration intelligence existed). Nine steps per
 * system, each a weighted action; the last is the manual history
 * re-entry/import the S003 path replaces with the W094 migration.
 */
export const S003_MANUAL_PROTOCOL: readonly { key: string; action: string; minutes: number }[] = [
  { key: 'procure-access', action: 'Procure admin access to the incumbent system', minutes: 25 },
  { key: 'configure-credentials', action: 'Configure API credentials by hand', minutes: 20 },
  { key: 'test-connectivity', action: 'Test connectivity and auth against the vendor', minutes: 15 },
  { key: 'negotiate-scope', action: 'Negotiate the data scope with the vendor/owner', minutes: 30 },
  { key: 'map-fields', action: 'Map the fields and semantics manually', minutes: 35 },
  { key: 'verify-sample', action: 'Verify a data sample end to end', minutes: 20 },
  { key: 'document', action: 'Document the integration for the team', minutes: 15 },
  { key: 'train', action: 'Train the team on the new pipe', minutes: 20 },
  { key: 'reimport-history', action: 'Export and re-enter the system history', minutes: 45 },
];

/** The modeled baseline effort: the manual protocol, once per incumbent system. */
export function s003BaselineEffort(firm: S003FirmDesign): {
  systemCount: number;
  stepsPerSystem: number;
  totalMinutes: number;
  perSystem: { role: string; minutes: number }[];
} {
  const perSystem = firm.systems.map((system) => ({
    role: system.role,
    minutes: S003_MANUAL_PROTOCOL.reduce((sum, step) => sum + step.minutes, 0),
  }));
  return {
    systemCount: firm.systems.length,
    stepsPerSystem: S003_MANUAL_PROTOCOL.length,
    totalMinutes: perSystem.reduce((sum, entry) => sum + entry.minutes, 0),
    perSystem,
  };
}

/**
 * The measured S003 effort: the orchestrator records every chain step it
 * ACTUALLY executed (op key + weight class) while building the mature
 * surface; this function prices the recorded chain. No step is counted
 * that did not run.
 */
export interface S003EffortStep {
  op: string;
  /** Which canonical chain phase the op belongs to (W096 vocabulary + migration). */
  phase: string;
  weight: 'automaticAction' | 'humanApproval' | 'humanRoundReview';
}

export function s003PriceEffort(steps: readonly S003EffortStep[]): {
  stepCount: number;
  totalMinutes: number;
  byPhase: { phase: string; steps: number; minutes: number }[];
  /** The raw recorded chain, in execution order (the artifact's per-op record). */
  ops: readonly { op: string; phase: string; weight: string; minutes: number }[];
} {
  const byPhase = new Map<string, { steps: number; minutes: number }>();
  let total = 0;
  for (const step of steps) {
    const minutes = S003_EFFORT_WEIGHTS[step.weight];
    total += minutes;
    const bucket = byPhase.get(step.phase) ?? { steps: 0, minutes: 0 };
    bucket.steps += 1;
    bucket.minutes += minutes;
    byPhase.set(step.phase, bucket);
  }
  return {
    stepCount: steps.length,
    totalMinutes: total,
    byPhase: [...byPhase.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([phase, bucket]) => ({ phase, steps: bucket.steps, minutes: bucket.minutes })),
    ops: steps.map((step) => ({
      op: step.op,
      phase: step.phase,
      weight: step.weight,
      minutes: S003_EFFORT_WEIGHTS[step.weight],
    })),
  };
}

// ---------------------------------------------------------------------------
// Measurement 5a — the automation-action portfolio (trust)
// ---------------------------------------------------------------------------

export type S003AutomationKind =
  | 'supervised-agent-execution'
  | 'capability-read'
  | 'capability-write-approved'
  | 'capability-write-denied';

export interface S003AutomationAction {
  key: string;
  kind: S003AutomationKind;
  /** The incumbent system role the action touches (connection-based kinds). */
  systemRole: string | null;
  /** The capability key invoked (capability kinds). */
  capabilityKey: string | null;
}

/**
 * The firm's automation-action portfolio — the work the mature firm would
 * delegate to Aurum's automation/agent surfaces. FIXED per firm (the
 * frozen-template discipline): 2 supervised agent duties, 2 floor reads,
 * 1 approved write ask and 1 write ask the firm's approver DENIES (the
 * honest sub-1.0 trust: a scope denial is an automation action the firm
 * did not accept). Attempted = 6 for every firm; accepted-without-rollback
 * = 5 when every surface holds.
 */
export function deriveS003AutomationPortfolio(
  firm: S003FirmDesign,
): S003AutomationAction[] {
  const primary = firm.systems[0]!;
  const readClass = primary.capabilityClasses[0]!;
  const secondaryWriteClass = primary.capabilityClasses[1] ?? primary.capabilityClasses[0]!;
  return [
    {
      key: 'agent-duty-1',
      kind: 'supervised-agent-execution',
      systemRole: null,
      capabilityKey: null,
    },
    {
      key: 'agent-duty-2',
      kind: 'supervised-agent-execution',
      systemRole: null,
      capabilityKey: null,
    },
    {
      key: 'floor-read-1',
      kind: 'capability-read',
      systemRole: primary.role,
      capabilityKey: `read.${readClass}`,
    },
    {
      key: 'floor-read-2',
      kind: 'capability-read',
      systemRole: primary.role,
      capabilityKey: `read.${secondaryWriteClass}`,
    },
    {
      key: 'write-approved',
      kind: 'capability-write-approved',
      systemRole: primary.role,
      capabilityKey: `write.${readClass}`,
    },
    {
      key: 'write-denied',
      kind: 'capability-write-denied',
      systemRole: primary.role,
      capabilityKey: `write.${secondaryWriteClass}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Design invariants (asserted by the benchmark — the honest-statistics gates)
// ---------------------------------------------------------------------------

/**
 * Every industry pool must satisfy the conversion pigeonhole for every
 * firm size: at each checkpoint the seeded selection picks
 * S003_SCENARIOS_PER_CHECKPOINT[size] distinct templates, and the number
 * of templates whose ENTRY step cannot convert for that size must stay
 * strictly below the pick count — so every firm, at every checkpoint,
 * routes at least one scenario through Aurum first in the mature state
 * that routed incumbent-first in the baseline. If a template edit breaks
 * this, the suite fails (a claimed improvement inverted).
 */
export function s003TemplateInvariantsHold(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const industry of ['legal', 'accounting', 'logistics'] as const) {
    const templates = INDUSTRY_TEMPLATES[industry]!;
    const firm = deriveS003Firm(0, industry, 'large');
    const allRoles = new Set(firm.systems.map((system) => system.role));
    for (const size of ['solo', 'small', 'mid', 'large'] as const) {
      const sizeFirm = deriveS003Firm(0, industry, size);
      const sizeRoles = new Set(sizeFirm.systems.map((system) => system.role));
      const picks = S003_SCENARIOS_PER_CHECKPOINT[size]!;
      let nonConvertibleEntries = 0;
      for (const template of templates) {
        const entry = template.steps[0]!;
        const converts =
          entry.origin === 'kit' ||
          (entry.origin === 'connection' && sizeRoles.has(entry.incumbentTool)) ||
          false;
        if (!converts) nonConvertibleEntries += 1;
      }
      if (nonConvertibleEntries >= picks) {
        problems.push(
          `${industry}/${size}: ${nonConvertibleEntries} of ${templates.length} templates have non-converting entry steps (>= the ${picks} picks) — the aurum-primary improvement is no longer guaranteed`,
        );
      }
      if (templates.length < picks) {
        problems.push(`${industry}/${size}: pool smaller than the pick count`);
      }
      void allRoles;
    }
    // Every template must have at least 2 steps and a stable first step.
    for (const template of templates) {
      if (template.steps.length < 2) {
        problems.push(`${industry}/${template.key}: fewer than 2 steps`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The full template pools (exported for the orchestrator's artifact header). */
export function s003TemplatePools(): Record<S003Industry, readonly string[]> {
  return {
    legal: LEGAL_TEMPLATES.map((template) => template.key),
    accounting: ACCOUNTING_TEMPLATES.map((template) => template.key),
    logistics: LOGISTICS_TEMPLATES.map((template) => template.key),
  };
}
