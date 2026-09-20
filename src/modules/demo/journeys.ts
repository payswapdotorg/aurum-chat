// The demo journey catalog (W068 acceptance: "deterministic data for
// every major journey").
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §2 simulates twelve major journeys
// (A–L). This catalog turns each of them into a seeded, verifiable unit:
// every journey declares the anchor keys the harness seeds for it, and
// the seeding is complete exactly when each declared anchor exists in
// the demo database (the integration tests assert exactly that).
//
// The `demo-world` entry is the shared substrate (tenants, personas,
// memberships, the employee's person/identity records) — not one of the
// plan's letters, but the foundation every journey composes from.

import type { DemoJourney, DemoJourneyId } from './types';

export const DEMO_JOURNEYS: readonly DemoJourney[] = [
  {
    id: 'demo-world',
    ref: '·',
    title: 'The demo world',
    description:
      'Three seeded tenants (the demo company, a marketplace vendor, the platform review tenant), four sign-in personas mapped to the real tenant-role ladder, the employee\u2019s person/employee/identity records, and the tenant selections that make each persona land in its company on sign-in.',
    primaryRole: 'manager',
    alsoExercisedBy: ['employee', 'developer', 'platform-reviewer'],
    anchorKeys: [
      'tenant-company',
      'tenant-vendor',
      'tenant-platform',
      'persona-manager',
      'persona-employee',
      'persona-developer',
      'persona-platform-reviewer',
      'membership-employee',
      'membership-developer',
      'membership-worker',
      'membership-platform-reviewer',
      'person-employee',
      'employee-record',
      'identity-web',
    ],
  },
  {
    id: 'manager-onboarding',
    ref: 'A',
    title: 'First-time company manager onboarding',
    description:
      'The manager signs in with a real account, lands in the selected company workspace, and manages invitations from the member roster (one pending invite is seeded).',
    primaryRole: 'manager',
    alsoExercisedBy: [],
    anchorKeys: ['invite-pending'],
  },
  {
    id: 'employee-chat',
    ref: 'B',
    title: 'Talk to the Aurum employee',
    description:
      'A real conversation thread between the employee persona and Aurum over the web channel: the freshness question, Aurum\u2019s evidence-backed answer, the follow-up — plus the execution link that ties the triggering conversation to the cognitive execution that investigated it.',
    primaryRole: 'employee',
    alsoExercisedBy: ['manager'],
    anchorKeys: ['conversation-freshness', 'execution-link'],
  },
  {
    id: 'unprompted-discovery',
    ref: 'C',
    title: 'Discover something management did not ask about',
    description:
      'Two management goals, freshness evidence observations, the derived claim, and one unprompted goal-gap discovery pass that promotes the freshness gap into a first-class unknown and a learning mission (the goal → gap → unknown → mission chain).',
    primaryRole: 'manager',
    alsoExercisedBy: [],
    anchorKeys: [
      'goal-freshness',
      'goal-shiptime',
      'observation-freshness-1',
      'observation-freshness-2',
      'observation-freshness-3',
      'claim-freshness-dip',
      'discovery-run',
      'unknown-freshness',
      'mission-freshness',
    ],
  },
  {
    id: 'risk-investigation',
    ref: 'D',
    title: 'Investigate a risk, opportunity or capability gap',
    description:
      'A capability with unmet demand (the cold-chain gap), a reconstructed fulfillment process with deterministic findings (the bottleneck), and a retained contradiction between two freshness readings — the Risks, Opportunities, Capabilities, Processes and Automation surfaces all have live data.',
    primaryRole: 'manager',
    alsoExercisedBy: [],
    anchorKeys: [
      'capability-cold-chain',
      'requirement-cold-chain',
      'supply-june',
      'observation-case-1',
      'observation-case-2',
      'process-fulfillment',
      'contradiction-freshness',
    ],
  },
  {
    id: 'consequential-approval',
    ref: 'E',
    title: 'Approve a consequential action',
    description:
      'The tenant\u2019s authority policy gates employee messaging at ASK; one canonical cognitive execution runs the full loop — evidence, claim, belief, findings — and suspends awaiting approval of its proposed follow-up question; an earlier request already decided by the manager gives the approvals surface history.',
    primaryRole: 'manager',
    alsoExercisedBy: [],
    anchorKeys: [
      'policy-employee-messaging',
      'policy-extension-deployment',
      'cognition-execution',
      'approval-history',
    ],
  },
  {
    id: 'employee-contribution',
    ref: 'F',
    title: 'An employee helps Aurum learn',
    description:
      'The discovery mission plans an ask-person acquisition against the employee, she answers, the contribution is recorded and validated, the reward policy converts it, and the resulting reward sits approval-gated — contribution acknowledgement and reward status, end to end.',
    primaryRole: 'employee',
    alsoExercisedBy: ['manager'],
    anchorKeys: [
      'acquisition-plan',
      'acquisition-answer',
      'contribution',
      'contribution-validation',
      'reward-policy',
      'reward',
    ],
  },
  {
    id: 'connect-company',
    ref: 'G',
    title: 'Connect the company',
    description:
      'Two channel endpoints (WhatsApp, Slack), two source systems (HubSpot, Stripe) and one destination (Google Sheets) registered with tenant-owned credential references — the connection hub\u2019s health, identity-mapping and delivery views have live state.',
    primaryRole: 'manager',
    alsoExercisedBy: ['developer'],
    anchorKeys: [
      'channel-whatsapp',
      'channel-slack',
      'source-hubspot',
      'source-stripe',
      'destination-sheets',
    ],
  },
  {
    id: 'configure-ai',
    ref: 'H',
    title: 'Configure AI (BYOA)',
    description:
      'Two tenant-owned AI provider accounts (different providers — no single provider is privileged) with opaque credential references, scopes, classifications, priorities and budgets.',
    primaryRole: 'manager',
    alsoExercisedBy: [],
    anchorKeys: ['llm-account-openai', 'llm-account-anthropic'],
  },
  {
    id: 'agent-recruitment',
    ref: 'I',
    title: 'Recruit and monitor an agent',
    description:
      'An active tenant agent (the freshness monitor) and a recruitment proposal for the cold-chain gap comparing train / recruit / outsource alternatives, waiting at the approval gate with its recommended alternative.',
    primaryRole: 'manager',
    alsoExercisedBy: [],
    anchorKeys: ['agent-freshness-monitor', 'recruitment-proposal'],
  },
  {
    id: 'marketplace',
    ref: 'J',
    title: 'Marketplace: browse, install, publish, review',
    description:
      'A vendor package walked through the whole governed chain to INSTALLABLE and installed into the demo company (registered, verified, activated, deployed with a narrowed grant); the developer\u2019s own package submitted and verified into PENDING_REVIEW — the platform reviewer\u2019s queue.',
    primaryRole: 'developer',
    alsoExercisedBy: ['platform-reviewer', 'manager'],
    anchorKeys: [
      'vendor-package',
      'vendor-package-governance',
      'install-roast-batch-tracker',
      'developer-package',
    ],
  },
  {
    id: 'explainability',
    ref: 'K',
    title: 'Explainability & audit',
    description:
      'The evidence chain of the demo world, indexed: conversation turn → observations → claim → belief → goal evaluation → trace findings → action request → decision — reconstructable from linked ids (the cognition execution of journey E is the spine).',
    primaryRole: 'manager',
    alsoExercisedBy: [],
    anchorKeys: ['evidence-chain'],
  },
  {
    id: 'developer-console',
    ref: 'L',
    title: 'Developer integration',
    description:
      'An API key with scoped capabilities owned by the developer persona, and a webhook subscription for the ops integration — the developer console\u2019s data.',
    primaryRole: 'developer',
    alsoExercisedBy: [],
    anchorKeys: ['api-key', 'webhook-subscription'],
  },
];

const JOURNEY_BY_ID: ReadonlyMap<DemoJourneyId, DemoJourney> = new Map(
  DEMO_JOURNEYS.map((journey) => [journey.id, journey]),
);

/** One journey by id (throws on unknown ids — the catalog is closed). */
export function demoJourney(id: DemoJourneyId): DemoJourney {
  const journey = JOURNEY_BY_ID.get(id);
  if (journey === undefined) {
    throw new Error(`unknown demo journey '${id}'`);
  }
  return journey;
}

/** The catalog in plan order (the substrate first, then A–L). */
export function demoJourneys(): readonly DemoJourney[] {
  return DEMO_JOURNEYS;
}

/** Every anchor key of every journey, in catalog order (the seed completeness set). */
export function demoAnchorKeys(): string[] {
  return DEMO_JOURNEYS.flatMap((journey) => [...journey.anchorKeys]);
}
