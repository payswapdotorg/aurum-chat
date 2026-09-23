// W079 — the mandatory production journey matrix (contract §5, verbatim
// semantics). PURE: this file owns the J01–J15 catalog the certification
// runs against, the context requirements per journey, and the derived
// inventory the browser suite must satisfy. Every journey id the contract
// names must be here exactly once — `matrixConsistency` proves it.

import type { BrowserContextKind, JourneyId, JourneySpec } from './types';

/**
 * The J01–J15 matrix. The `title`/`mandatoryProof` values mirror
 * spec/PRODUCTION-JOURNEY-CERTIFICATION-2026-09-23.md §5 word for word —
 * the machine-generated report restates them so the committed evidence
 * self-describes against the contract.
 */
export const JOURNEY_MATRIX: readonly JourneySpec[] = [
  {
    id: 'J01',
    title: 'First-time manager',
    mandatoryProof: 'anonymous → sign-in → onboarding → company → Chat',
    contexts: ['desktop'],
    surfaces: ['/ (anonymous)', '/signup', '/onboarding', '/chat'],
  },
  {
    id: 'J02',
    title: 'Talk to Aurum',
    mandatoryProof: 'conversation list → thread → compose → working → answer → evidence',
    contexts: ['desktop'],
    surfaces: ['/chat'],
  },
  {
    id: 'J03',
    title: 'Unprompted discovery',
    mandatoryProof: 'goal/situation → gap → unknown → learning mission',
    contexts: ['desktop'],
    surfaces: ['/intelligence', '/today', '/intelligence/missions/:id', '/chat'],
  },
  {
    id: 'J04',
    title: 'Risk/opportunity/process investigation',
    mandatoryProof: 'finding → detail → evidence/action → return to originating conversation',
    contexts: ['desktop'],
    surfaces: ['/intelligence', '/chat', '/evidence'],
  },
  {
    id: 'J05',
    title: 'Consequential approval',
    mandatoryProof: 'recommendation → comparison → explicit human decision → activation → outcome',
    contexts: ['desktop'],
    surfaces: ['/chat', '/approvals'],
  },
  {
    id: 'J06',
    title: 'Explainability',
    mandatoryProof: 'answer/action → Why → evidence/provenance → return to exact chat message',
    contexts: ['desktop'],
    surfaces: ['/chat', '/explain/execution/:id'],
  },
  {
    id: 'J07',
    title: 'Employee learning contribution',
    mandatoryProof: 'knowledge request in Chat → answer → acknowledgement → contribution/evidence → reward state',
    contexts: ['desktop'],
    surfaces: ['/chat', '/learning', '/onboarding (invite)'],
  },
  {
    id: 'J08',
    title: 'Company connections',
    mandatoryProof: 'Chat/contextual prompt → Connections → configure/verify → return to investigation',
    contexts: ['desktop'],
    surfaces: ['/chat', '/connections'],
  },
  {
    id: 'J09',
    title: 'AI/BYOA',
    mandatoryProof: 'unavailable capability/model → provider configuration → usable route → return to task',
    contexts: ['desktop'],
    surfaces: ['/chat', '/ai'],
  },
  {
    id: 'J10',
    title: 'Workforce / agent intervention',
    mandatoryProof: 'capability gap → alternatives → proposal → human approval → activation → lifecycle',
    contexts: ['desktop'],
    surfaces: ['/more', '/workforce', '/interventions', '/agents'],
  },
  {
    id: 'J11',
    title: 'Marketplace / extensions',
    mandatoryProof: 'discover capability → public catalog/package → install/review state → return to task',
    contexts: ['desktop'],
    surfaces: ['/more', '/marketplace', '/marketplace/package/:id', '/chat'],
  },
  {
    id: 'J12',
    title: 'Developer / API / MCP',
    mandatoryProof: 'discover from More/search → developer console → key/webhook/MCP surface → audit state',
    contexts: ['desktop'],
    surfaces: ['/more', '/developer'],
  },
  {
    id: 'J13',
    title: 'Tenant isolation',
    mandatoryProof: 'manager tenant activity → sign out → second tenant → no first-tenant data visible',
    contexts: ['desktop'],
    surfaces: ['/chat', '/signin', '/onboarding'],
  },
  {
    id: 'J14',
    title: 'Mobile employee loop',
    mandatoryProof: 'mobile Chat list → full-screen thread → composer → reply → back to list',
    contexts: ['mobile'],
    surfaces: ['/chat (mobile 390×844, touch)'],
  },
  {
    id: 'J15',
    title: 'Accessibility / discoverability',
    mandatoryProof: 'keyboard/focus/ARIA; task-language discovery; no dead-end/no-match states',
    contexts: ['desktop'],
    surfaces: ['/chat', '/more', 'command search'],
  },
];

/** One journey's spec by id (throws on an unknown id — a matrix bug). */
export function journeySpec(id: JourneyId): JourneySpec {
  const spec = JOURNEY_MATRIX.find((journey) => journey.id === id);
  if (spec === undefined) {
    throw new Error(`unknown journey id '${id}' — the matrix is inconsistent`);
  }
  return spec;
}

/**
 * Matrix consistency (the catalog's own invariant): every J01–J15 id
 * appears exactly once, every journey carries at least one context, and
 * the context vocabulary is legal. The unit test pins this; the driver
 * re-checks it before any run so a broken matrix can never produce a
 * verdict.
 */
export function matrixConsistency(): string[] {
  const reasons: string[] = [];
  const expected: readonly JourneyId[] = [
    'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10',
    'J11', 'J12', 'J13', 'J14', 'J15',
  ];
  const seen = new Set<string>();
  for (const journey of JOURNEY_MATRIX) {
    if (seen.has(journey.id)) reasons.push(`${journey.id} appears more than once`);
    seen.add(journey.id);
    if (journey.contexts.length === 0) {
      reasons.push(`${journey.id} declares no browser context`);
    }
    for (const context of journey.contexts) {
      if (context !== 'desktop' && context !== 'mobile') {
        reasons.push(`${journey.id} declares an unknown context '${context}'`);
      }
    }
    if (journey.mandatoryProof.trim() === '' || journey.title.trim() === '') {
      reasons.push(`${journey.id} has an empty title or mandatory proof`);
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) reasons.push(`${id} is missing from the matrix`);
  }
  return reasons;
}

/**
 * Every (journey × context) pair the browser suite must cover — the
 * completeness inventory the run digest is compared against.
 */
export function requiredBrowserTests(): { journeyId: JourneyId; context: BrowserContextKind }[] {
  const pairs: { journeyId: JourneyId; context: BrowserContextKind }[] = [];
  for (const journey of JOURNEY_MATRIX) {
    for (const context of journey.contexts) {
      pairs.push({ journeyId: journey.id, context });
    }
  }
  return pairs;
}

/** The contract's cross-surface rule (§5): journeys that leave Chat. */
export const JOURNEYS_LEAVING_CHAT: readonly JourneyId[] = [
  'J03',
  'J04',
  'J05',
  'J06',
  'J08',
  'J09',
  'J10',
  'J11',
];
