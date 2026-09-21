// The W070 journey matrix (W070 — Browser Journey, Accessibility &
// Discoverability Proof).
//
// One entry per acceptance bullet of the work item (16 bullets → 16
// entries), each mapped onto the REAL routes of this repository base and
// the W068 demo personas. The execution suites under tests/e2e/journeys/
// walk these steps through the real surface code (pages server-rendered
// to the HTML a browser would receive, API handlers driven with the
// session cookie) and assemble the proof report.
//
// Viewports: every product journey is declared for BOTH desktop and
// mobile ("Automate the end-user journey matrix on desktop and mobile").
// The mobile-navigation entry additionally proves the mobile-specific
// behavior (bottom nav, top bar, reachability of every route).

import type { JourneyId, JourneySpec } from './types';
import { hasRoute } from './routes';

/**
 * The acceptance matrix, in work-item order. `acceptance` quotes the
 * bullet verbatim from spec/work-items/WORK-ITEM-CATALOG.md W070.
 */
export const JOURNEY_MATRIX: readonly JourneySpec[] = [
  {
    id: 'first-run-onboarding',
    ref: 'A',
    kind: 'journey',
    title: 'First-run onboarding',
    acceptance: 'first-run onboarding',
    actors: ['anonymous', 'fresh-manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'anonymous-entry',
        action: 'Open Aurum without a session',
        route: '/chat',
        via: 'url',
        expect:
          'the route gate redirects to /signin with a next parameter (no tenant surface renders unauthenticated)',
      },
      {
        id: 'signin-page',
        action: 'Land on the sign-in page',
        route: '/signin',
        via: 'redirect',
        expect: 'the sign-in form renders with labeled inputs and an actionable submit',
      },
      {
        id: 'signup',
        action: 'Create an account through the sign-up API',
        route: '/api/auth/sign-up',
        via: 'api',
        expect: 'registration issues a session; the principal exists with no company yet',
      },
      {
        id: 'no-company-redirect',
        action: 'Open the product with a company-less session',
        route: '/chat',
        via: 'url',
        expect: 'the page gate redirects to /onboarding (no crash, no empty shell)',
      },
      {
        id: 'onboarding-page',
        action: 'Complete onboarding: create a company',
        route: '/onboarding',
        via: 'redirect',
        expect:
          'the onboarding surface offers company creation, and the create-company API activates the session company',
      },
      {
        id: 'land-in-chat',
        action: 'Return to the product',
        route: '/chat',
        via: 'url',
        expect: 'the chat workspace renders — onboarding reaches usable Aurum chat',
      },
    ],
  },
  {
    id: 'manager-chat',
    ref: 'B',
    kind: 'journey',
    title: 'Manager chat',
    acceptance: 'manager chat',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'open-chat',
        action: 'Open the conversation area as the manager',
        route: '/chat',
        via: 'nav',
        expect: 'the conversation list renders with the seeded freshness thread and the discovery starters',
      },
      {
        id: 'open-thread',
        action: 'Open the seeded conversation',
        route: '/chat',
        via: 'link',
        expect: 'the message timeline renders the seeded turns (question, evidence-backed answer, follow-up)',
      },
      {
        id: 'send-turn',
        action: 'Ask Aurum a question through the composer API',
        route: '/api/product/chat/messages',
        via: 'api',
        expect:
          'the turn records the message, runs a real cognition execution and returns the evidence-backed reply',
      },
      {
        id: 'see-reply',
        action: 'See the reply in the timeline',
        route: '/chat',
        via: 'url',
        expect: 'the new turns appear in the conversation state, with the execution linked',
      },
    ],
  },
  {
    id: 'employee-chat',
    ref: 'B',
    kind: 'journey',
    title: 'Employee chat',
    acceptance: 'employee chat',
    actors: ['employee'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'employee-open-chat',
        action: 'Open the conversation area as the employee',
        route: '/chat',
        via: 'nav',
        expect: 'the employee sees the same conversation surface (chat is open to every tenant member)',
      },
      {
        id: 'employee-thread',
        action: 'Open the seeded employee conversation',
        route: '/chat',
        via: 'link',
        expect: 'the freshness thread with the employee question and Aurum’s answer renders',
      },
      {
        id: 'employee-send',
        action: 'Ask a question through the composer API',
        route: '/api/product/chat/messages',
        via: 'api',
        expect: 'the employee turn records and returns a deterministic answer (no management claims needed)',
      },
    ],
  },
  {
    id: 'goal-unknown-mission',
    ref: 'C',
    kind: 'journey',
    title: 'Goal → unknown → mission',
    acceptance: 'goal → unknown → mission',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'briefing',
        action: 'Open the Intelligence briefing',
        route: '/intelligence',
        via: 'nav',
        expect: 'the proactive findings and the active goals render, each goal linking into its chain',
      },
      {
        id: 'goal-chain',
        action: 'Open the goal chain of the seeded freshness goal',
        route: '/intelligence/goals/:goalId',
        via: 'link',
        expect: 'the chain page renders the discovery gaps, the promoted unknown and the learning mission',
      },
      {
        id: 'unknown',
        action: 'Open the promoted unknown',
        route: '/intelligence/unknowns/:unknownId',
        via: 'link',
        expect: 'the unknown page shows why it matters and the mission that closes it',
      },
      {
        id: 'mission',
        action: 'Open the learning mission',
        route: '/intelligence/missions/:missionId',
        via: 'link',
        expect: 'the mission page shows the knowledge objective, progress, and the affected goal chain upward',
      },
    ],
  },
  {
    id: 'evidence-explainability',
    ref: 'K',
    kind: 'journey',
    title: 'Evidence & explainability',
    acceptance: 'evidence/explainability',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'explain-index',
        action: 'Open the evidence & audit index',
        route: '/explain',
        via: 'nav',
        expect: 'the index lists the reconstructed decisions and recent evidence',
      },
      {
        id: 'explain-decision',
        action: 'Explain the seeded cognitive execution',
        route: '/explain/:kind/:id',
        via: 'link',
        expect:
          'the causal chain renders: conversation turn → observations → claim → belief → findings → action request',
      },
    ],
  },
  {
    id: 'recommendation-approval-outcome',
    ref: 'E',
    kind: 'journey',
    title: 'Recommendation → approval → outcome',
    acceptance: 'recommendation → approval → outcome',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'recommendation',
        action: 'Open the interventions surface (the seeded recruitment recommendation)',
        route: '/interventions',
        via: 'nav',
        expect: 'the capability gap and its pending recruitment proposal render with compared alternatives',
      },
      {
        id: 'proposal',
        action: 'Open the proposal',
        route: '/interventions/proposals/:proposalId',
        via: 'link',
        expect: 'the proposal shows the alternatives (train/recruit/outsource) and waits at the approval gate',
      },
      {
        id: 'approve',
        action: 'Approve the proposal through the decision API',
        route: '/api/product/interventions/proposals/:proposalId/decide',
        via: 'api',
        expect: 'the manager decision records (claim-gated, human-authorized)',
      },
      {
        id: 'outcome',
        action: 'Activate the approved intervention and see the outcome',
        route: '/api/product/interventions/proposals/:proposalId/activate',
        via: 'api',
        expect: 'activation produces the outcome record the surfaces track (agent active under the proposal)',
      },
      {
        id: 'approvals-surface',
        action: 'See the decision in the Approvals surface',
        route: '/approvals',
        via: 'nav',
        expect: 'the tower Approvals surface shows the pending and decided requests with their trails',
      },
    ],
  },
  {
    id: 'learning-contribution-reward',
    ref: 'F',
    kind: 'journey',
    title: 'Learning contribution & reward',
    acceptance: 'learning contribution/reward',
    actors: ['employee', 'manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'learning-home',
        action: 'Open the learning surface as the employee',
        route: '/learning',
        via: 'nav',
        expect: 'knowledge requests, the mission’s learning view, contributions and reward status render',
      },
      {
        id: 'contribution',
        action: 'See the seeded contribution acknowledged',
        route: '/learning',
        via: 'url',
        expect: 'June’s answer is recorded as a validated contribution with acknowledgement',
      },
      {
        id: 'reward',
        action: 'See the reward state',
        route: '/learning',
        via: 'url',
        expect: 'the reward converted by policy renders with its approval-gated status',
      },
    ],
  },
  {
    id: 'connections',
    ref: 'G',
    kind: 'journey',
    title: 'Connections',
    acceptance: 'connections',
    actors: ['manager', 'developer'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'hub',
        action: 'Open the connection hub',
        route: '/connections',
        via: 'nav',
        expect: 'the three families render with the seeded WhatsApp/Slack channels, HubSpot/Stripe sources and Sheets destination',
      },
      {
        id: 'health',
        action: 'Inspect connection health and identity mapping',
        route: '/connections',
        via: 'url',
        expect: 'per-connection health, freshness and the employee identity mapping are visible',
      },
      {
        id: 'connect',
        action: 'Register a new channel connection through the surface API',
        route: '/api/connections',
        via: 'api',
        expect: 'the new connection appears in the hub view (tenant-owned credential reference only)',
      },
    ],
  },
  {
    id: 'byoa',
    ref: 'H',
    kind: 'journey',
    title: 'BYOA — configure AI',
    acceptance: 'BYOA',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'ai-page',
        action: 'Open the AI providers surface',
        route: '/ai',
        via: 'nav',
        expect: 'the two seeded tenant-owned provider accounts render with scopes, priorities and budgets',
      },
      {
        id: 'ai-action',
        action: 'Exercise a provider action through the surface API',
        route: '/api/product/ai',
        via: 'api',
        expect: 'the BYOA surface performs account operations tenant-scoped (no provider privileged)',
      },
    ],
  },
  {
    id: 'agent-recruitment',
    ref: 'I',
    kind: 'journey',
    title: 'Agent recruitment',
    acceptance: 'agent recruitment',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'gap',
        action: 'Open the capability gap (the recruitment trigger)',
        route: '/interventions',
        via: 'nav',
        expect: 'the cold-chain capability gap renders with its unmet demand and the live agent',
      },
      {
        id: 'proposal-detail',
        action: 'Open the recruitment proposal',
        route: '/interventions/proposals/:proposalId',
        via: 'link',
        expect: 'the proposal compares train/recruit/outsource with explicit uncertainty and a recommended alternative',
      },
      {
        id: 'agent-detail',
        action: 'Open the live agent’s page',
        route: '/interventions/agents/:agentId',
        via: 'link',
        expect: 'the seeded freshness-monitor agent renders with budget, permissions and lifecycle controls',
      },
    ],
  },
  {
    id: 'marketplace',
    ref: 'J',
    kind: 'journey',
    title: 'Marketplace',
    acceptance: 'marketplace',
    actors: ['developer', 'manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'catalog',
        action: 'Browse the governed catalog',
        route: '/marketplace',
        via: 'nav',
        expect: 'the installable vendor package renders in the public catalog with its governance state',
      },
      {
        id: 'package',
        action: 'Open the package page and inspect permissions',
        route: '/marketplace/package/:packageId',
        via: 'link',
        expect: 'the package detail shows permissions, verification and the install action',
      },
      {
        id: 'installed',
        action: 'Open the installed packages',
        route: '/marketplace/installed',
        via: 'nav',
        expect: 'the installed extension renders with activate/suspend/rollback governance',
      },
      {
        id: 'developer-console',
        action: 'Open the marketplace developer console',
        route: '/marketplace/developer',
        via: 'nav',
        expect: 'the developer’s own package renders in its pending-review state',
      },
    ],
  },
  {
    id: 'developer-api-mcp',
    ref: 'L',
    kind: 'journey',
    title: 'Developer, API & MCP',
    acceptance: 'developer/API/MCP',
    actors: ['developer'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'console',
        action: 'Open the developer console',
        route: '/developer',
        via: 'nav',
        expect: 'the seeded API key and webhook render with scopes, activity and the MCP connection guide',
      },
      {
        id: 'key-lifecycle',
        action: 'Create and revoke an API key through the console API',
        route: '/api/product/developer',
        via: 'api',
        expect: 'key creation and revocation work and are audited',
      },
    ],
  },
  {
    id: 'mobile-navigation',
    ref: 'M',
    kind: 'journey',
    title: 'Mobile navigation',
    acceptance: 'mobile navigation',
    actors: ['manager'],
    viewports: ['mobile'],
    steps: [
      {
        id: 'bottom-nav',
        action: 'Open the product on a mobile viewport',
        route: '/chat',
        via: 'url',
        expect:
          'the mobile chrome renders: top bar (company, presence, search, notifications) and the five-area bottom nav with ≥44px touch targets',
      },
      {
        id: 'nav-areas',
        action: 'Walk the five bottom-nav areas',
        route: '/intelligence',
        via: 'nav',
        expect: 'Chat / Today / Intelligence / People / More all render with an active-state treatment',
      },
      {
        id: 'reachability',
        action: 'Reach every product route from the mobile chrome',
        route: '/more',
        via: 'nav',
        expect:
          'every page route is reachable on mobile: directly, via a hub (More/Intelligence/People), or via the command search',
      },
    ],
  },
  {
    id: 'accessibility',
    ref: '·',
    kind: 'audit',
    title: 'Accessibility',
    acceptance: 'accessibility',
    actors: ['manager', 'employee', 'developer', 'anonymous'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'document-rules',
        action: 'Audit every rendered page for the document rules',
        route: '/chat',
        via: 'url',
        expect:
          'lang, one main landmark, skip link, exactly one h1, ordered headings, no positive tabindex',
      },
      {
        id: 'name-rules',
        action: 'Audit every rendered page for accessible names',
        route: '/chat',
        via: 'url',
        expect: 'every link and button (icon-only included) has an accessible name; every image has alt',
      },
      {
        id: 'form-rules',
        action: 'Audit the forms (sign-in, onboarding, composer)',
        route: '/signin',
        via: 'url',
        expect: 'inputs carry labels; data tables carry captions and scoped headers',
      },
      {
        id: 'touch-and-keyboard',
        action: 'Audit the shipped CSS and keyboard treatment',
        route: '/more',
        via: 'url',
        expect:
          'bottom-nav and icon buttons meet 44px+ touch targets; nav carries aria-current; the keyboard reference documents the shortcuts',
      },
    ],
  },
  {
    id: 'no-dead-ends',
    ref: '·',
    kind: 'audit',
    title: 'No dead-end pages',
    acceptance: 'no dead-end pages',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'every-page-renders',
        action: 'Render every page route of the catalog with the demo world',
        route: '/chat',
        via: 'url',
        expect: 'every page renders real HTML (no crash, no empty shell)',
      },
      {
        id: 'every-page-links-onward',
        action: 'Check every rendered page for onward navigation',
        route: '/chat',
        via: 'url',
        expect: 'every page carries shell navigation plus at least one onward in-content link',
      },
      {
        id: 'no-broken-links',
        action: 'Resolve every link every page emits',
        route: '/chat',
        via: 'url',
        expect: 'no link points at a route that does not exist (no dead ends by broken link)',
      },
    ],
  },
  {
    id: 'capability-coverage',
    ref: '·',
    kind: 'audit',
    title: 'Every architecture capability has a discoverable user route',
    acceptance: 'every architecture capability has a discoverable user route',
    actors: ['manager'],
    viewports: ['desktop', 'mobile'],
    steps: [
      {
        id: 'module-coverage',
        action: 'Map every src/modules module through the capability map',
        route: '/more',
        via: 'url',
        expect: 'every architecture module has at least one user-facing route',
      },
      {
        id: 'routes-exist',
        action: 'Verify every mapped route exists',
        route: '/more',
        via: 'url',
        expect: 'every capability route resolves to a real route of this base',
      },
      {
        id: 'discovery-surfaces',
        action: 'Verify every mapped route is discoverable',
        route: '/more',
        via: 'url',
        expect:
          'every capability route is reachable from a real discovery surface: rail, mobile nav, command search, hub link, drill-down, chat card, or the auth/public entry',
      },
    ],
  },
];

const BY_ID: ReadonlyMap<JourneyId, JourneySpec> = new Map(
  JOURNEY_MATRIX.map((journey) => [journey.id, journey]),
);

/** Every journey id, in matrix order. */
export const JOURNEY_IDS: readonly JourneyId[] = JOURNEY_MATRIX.map((journey) => journey.id);

/** One journey by id (throws — the matrix is closed). */
export function journeySpec(id: JourneyId): JourneySpec {
  const spec = BY_ID.get(id);
  if (spec === undefined) {
    throw new Error(`unknown journey '${id}' in the W070 journey matrix`);
  }
  return spec;
}

/** The walkable journeys (kind 'journey'), in matrix order. */
export function walkableJourneys(): JourneySpec[] {
  return JOURNEY_MATRIX.filter((journey) => journey.kind === 'journey');
}

/** The audit obligations (kind 'audit'), in matrix order. */
export function auditJourneys(): JourneySpec[] {
  return JOURNEY_MATRIX.filter((journey) => journey.kind === 'audit');
}

/** Which journeys a viewport must see (every journey declares both viewports). */
export function journeysForViewport(viewport: 'desktop' | 'mobile'): JourneySpec[] {
  return JOURNEY_MATRIX.filter((journey) => journey.viewports.includes(viewport));
}

/**
 * Matrix self-consistency (unit-tested): every step's route exists in the
 * route catalog, every actor and viewport is valid, and every acceptance
 * bullet of the work item is covered exactly once.
 */
export const W070_ACCEPTANCE_BULLETS: readonly string[] = [
  'first-run onboarding',
  'manager chat',
  'employee chat',
  'goal → unknown → mission',
  'evidence/explainability',
  'recommendation → approval → outcome',
  'learning contribution/reward',
  'connections',
  'BYOA',
  'agent recruitment',
  'marketplace',
  'developer/API/MCP',
  'mobile navigation',
  'accessibility',
  'no dead-end pages',
  'every architecture capability has a discoverable user route',
];

/** Verify the matrix is internally consistent (pure; used by unit tests). */
export function matrixConsistency(): string[] {
  const problems: string[] = [];
  const acceptanceCovered = new Set<string>();
  for (const journey of JOURNEY_MATRIX) {
    if (acceptanceCovered.has(journey.acceptance)) {
      problems.push(`journey '${journey.id}' duplicates acceptance bullet '${journey.acceptance}'`);
    }
    acceptanceCovered.add(journey.acceptance);
    if (journey.actors.length === 0) {
      problems.push(`journey '${journey.id}' declares no actor`);
    }
    if (journey.viewports.length === 0) {
      problems.push(`journey '${journey.id}' declares no viewport`);
    }
    for (const step of journey.steps) {
      if (!hasRoute(step.route)) {
        problems.push(
          `journey '${journey.id}' step '${step.id}' references unknown route '${step.route}'`,
        );
      }
    }
    if (journey.steps.length === 0) {
      problems.push(`journey '${journey.id}' has no steps`);
    }
  }
  for (const bullet of W070_ACCEPTANCE_BULLETS) {
    if (!acceptanceCovered.has(bullet)) {
      problems.push(`acceptance bullet '${bullet}' has no journey`);
    }
  }
  return problems;
}
