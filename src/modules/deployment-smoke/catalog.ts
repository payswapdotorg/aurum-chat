// The W078 smoke check catalog (pure).
//
// Every check id the driver can emit is declared here exactly once, with
// the acceptance bullet (canonical plan §5 W078 / the work-item entry)
// it proves, its category and its execution layer. The driver emits
// results ONLY through `smokeCheck(id)` lookups, so the catalog and the
// executed checks cannot drift (the unit tests assert the invariants:
// unique ids, known categories/layers, every acceptance bullet covered).
//
// The acceptance bullets, verbatim (spec/POST-W070-JOURNEY-UX-DEPLOYMENT-
// PLAN-2026-09-21.md §5 "W078 — Post-Deployment Smoke & Operations
// Proof", plus the work-item wording for the same obligations):
//   1. sign-in/onboarding works on the hosted deployment;
//   2. Chat is the primary root experience;
//   3. seeded demo journeys work;
//   4. browser journeys pass on production dogfood (hosted auth/chat is
//      the precondition layer the smoke proves; the browser layer is
//      W076's suite — re-runnable against the hosted target once the
//      documented provider gaps close);
//   5. worker/workflow retry and duplicate semantics are observed;
//   6. health endpoint is green;
//   7. queue depth and worker metrics are inspectable;
//   8. deployment rollback is documented;
//   9. environment separation is verified.

import type { SmokeCategory, SmokeLayer } from './types';

/** The W078 acceptance bullets (canonical plan §5), machine-referenceable. */
export const W078_ACCEPTANCE_BULLETS: readonly string[] = [
  'sign-in/onboarding works on the hosted deployment',
  'Chat is the primary root experience',
  'seeded demo journeys work',
  'browser journeys pass on production dogfood',
  'worker/workflow retry and duplicate semantics are observed',
  'health endpoint is green',
  'queue depth and worker metrics are inspectable',
  'deployment rollback is documented',
  'environment separation is verified',
];

/** One catalog entry: a check the smoke driver can execute. */
export interface SmokeCheckSpec {
  id: string;
  title: string;
  category: SmokeCategory;
  layer: SmokeLayer;
  /** The acceptance bullet (W078_ACCEPTANCE_BULLETS entry) this proves. */
  acceptance: string;
}

const SMOKE_CHECKS: readonly SmokeCheckSpec[] = [
  // --- routing / chat-root (bullets 2 and 4's precondition layer) --------
  {
    id: 'routing.root-anonymous-gate',
    title: 'anonymous root is gated to sign-in with a return path',
    category: 'routing',
    layer: 'hosted',
    acceptance: 'Chat is the primary root experience',
  },
  {
    id: 'routing.chat-anonymous-gate',
    title: 'anonymous /chat is gated to sign-in with next=/chat',
    category: 'routing',
    layer: 'hosted',
    acceptance: 'Chat is the primary root experience',
  },
  {
    id: 'routing.signin-renders',
    title: '/signin renders a real HTML page',
    category: 'routing',
    layer: 'hosted',
    acceptance: 'sign-in/onboarding works on the hosted deployment',
  },
  {
    id: 'routing.static-assets',
    title: 'static assets referenced by the page are served',
    category: 'routing',
    layer: 'hosted',
    acceptance: 'browser journeys pass on production dogfood',
  },
  {
    id: 'routing.onboarding-gate',
    title: 'anonymous /onboarding is gated to sign-in',
    category: 'routing',
    layer: 'hosted',
    acceptance: 'sign-in/onboarding works on the hosted deployment',
  },
  {
    id: 'browser.suite-registered',
    title:
      'the real-browser journey suite is wired and evidenced (re-runnable against the hosted dogfood)',
    category: 'release-rollback',
    layer: 'repo',
    acceptance: 'browser journeys pass on production dogfood',
  },
  {
    id: 'routing.root-authenticated-chat',
    title: 'an authenticated session is routed from / to /chat',
    category: 'routing',
    layer: 'journey',
    acceptance: 'Chat is the primary root experience',
  },

  // --- health / readiness (bullets 6, 4) ---------------------------------
  {
    id: 'health.contract',
    title: '/api/health answers with the full readiness contract',
    category: 'health-readiness',
    layer: 'hosted',
    acceptance: 'health endpoint is green',
  },
  {
    id: 'health.environment-label',
    title: '/api/health reports the expected environment label',
    category: 'environment-separation',
    layer: 'hosted',
    acceptance: 'environment separation is verified',
  },
  {
    id: 'health.green',
    title: '/api/health is green (db answers, schema applied, no refusals)',
    category: 'health-readiness',
    layer: 'journey',
    acceptance: 'health endpoint is green',
  },
  {
    id: 'health.honest-refusal',
    title:
      'a production target without its domain-truth database refuses to serve (and says so precisely)',
    category: 'health-readiness',
    layer: 'hosted',
    acceptance: 'health endpoint is green',
  },

  // --- authentication / onboarding (bullet 1) ----------------------------
  {
    id: 'auth.signup',
    title: 'a fresh visitor registers a real account and receives a session cookie',
    category: 'authentication-onboarding',
    layer: 'journey',
    acceptance: 'sign-in/onboarding works on the hosted deployment',
  },
  {
    id: 'auth.session-no-company',
    title: 'the fresh session reports no active company (onboarding state)',
    category: 'authentication-onboarding',
    layer: 'journey',
    acceptance: 'sign-in/onboarding works on the hosted deployment',
  },
  {
    id: 'auth.chat-gated-pre-onboarding',
    title: 'chat correctly refuses a company-less session (409 no_active_company)',
    category: 'authentication-onboarding',
    layer: 'journey',
    acceptance: 'sign-in/onboarding works on the hosted deployment',
  },
  {
    id: 'auth.onboarding-company',
    title: 'company creation through onboarding selects the tenant',
    category: 'authentication-onboarding',
    layer: 'journey',
    acceptance: 'sign-in/onboarding works on the hosted deployment',
  },
  {
    id: 'auth.signout',
    title: 'sign-out revokes the session and clears the cookie',
    category: 'authentication-onboarding',
    layer: 'journey',
    acceptance: 'sign-in/onboarding works on the hosted deployment',
  },

  // --- chat (bullet 2) ----------------------------------------------------
  {
    id: 'chat.state-fresh',
    title: 'chat state answers for the onboarded session',
    category: 'routing',
    layer: 'journey',
    acceptance: 'Chat is the primary root experience',
  },
  {
    id: 'chat.turn',
    title: 'a composer turn runs the real workflow and returns the reply',
    category: 'routing',
    layer: 'journey',
    acceptance: 'Chat is the primary root experience',
  },
  {
    id: 'chat.thread-persists',
    title: 'the turn persists into the conversation thread',
    category: 'routing',
    layer: 'journey',
    acceptance: 'Chat is the primary root experience',
  },

  // --- seeded demo journeys (bullet 3) ------------------------------------
  {
    id: 'seeded.persona-signin',
    title: 'the seeded manager persona signs in through the real password path',
    category: 'seeded-journeys',
    layer: 'journey',
    acceptance: 'seeded demo journeys work',
  },
  {
    id: 'seeded.conversation-list',
    title: 'the seeded demo conversation appears in the manager chat list',
    category: 'seeded-journeys',
    layer: 'journey',
    acceptance: 'seeded demo journeys work',
  },
  {
    id: 'seeded.thread',
    title: 'the seeded thread opens with its recorded turns',
    category: 'seeded-journeys',
    layer: 'journey',
    acceptance: 'seeded demo journeys work',
  },
  {
    id: 'seeded.attention-turn',
    title: 'the attention turn surfaces the seeded pending approval as a chat card',
    category: 'seeded-journeys',
    layer: 'journey',
    acceptance: 'seeded demo journeys work',
  },
  {
    id: 'seeded.approval-decided',
    title: 'the pending approval is decided inline and the timeline reflects it',
    category: 'seeded-journeys',
    layer: 'journey',
    acceptance: 'seeded demo journeys work',
  },

  // --- durable execution (bullet 5) ----------------------------------------
  {
    id: 'worker.seam-auth-fail-closed',
    title: 'the worker seam refuses unauthenticated and bad-token calls',
    category: 'durable-execution',
    layer: 'hosted',
    acceptance: 'worker/workflow retry and duplicate semantics are observed',
  },
  {
    id: 'worker.duplicate-acknowledged',
    title: 'a redelivered (stale-stage) job is acknowledged as an idempotent duplicate',
    category: 'durable-execution',
    layer: 'journey',
    acceptance: 'worker/workflow retry and duplicate semantics are observed',
  },
  {
    id: 'worker.dead-letter-invalid',
    title: 'an invalid pushed envelope is dead-lettered with a precise reason',
    category: 'durable-execution',
    layer: 'journey',
    acceptance: 'worker/workflow retry and duplicate semantics are observed',
  },
  {
    id: 'worker.not-found-consumed',
    title: 'a job for an unknown execution is consumed as not_found (never retried)',
    category: 'durable-execution',
    layer: 'journey',
    acceptance: 'worker/workflow retry and duplicate semantics are observed',
  },
  {
    id: 'worker.idle-pull',
    title: 'a pull-mode sweep of the drained queue reports idle honestly',
    category: 'durable-execution',
    layer: 'journey',
    acceptance: 'worker/workflow retry and duplicate semantics are observed',
  },
  {
    id: 'worker.retry-policy-surface',
    title: 'the deployment surfaces its worker retry policy (guardrails)',
    category: 'durable-execution',
    layer: 'hosted',
    acceptance: 'worker/workflow retry and duplicate semantics are observed',
  },

  // --- observability (bullet 7) ---------------------------------------------
  {
    id: 'observability.worker-snapshot',
    title: 'GET /api/worker exposes queue depth and the metrics registry',
    category: 'observability',
    layer: 'hosted',
    acceptance: 'queue depth and worker metrics are inspectable',
  },
  {
    id: 'observability.metrics-advance',
    title: 'worker metrics counters advance with observed job dispositions',
    category: 'observability',
    layer: 'journey',
    acceptance: 'queue depth and worker metrics are inspectable',
  },
  {
    id: 'observability.surfaces-agree',
    title: 'the health and worker observability surfaces report the same counters',
    category: 'observability',
    layer: 'journey',
    acceptance: 'queue depth and worker metrics are inspectable',
  },

  // --- release / rollback (bullet 8) -----------------------------------------
  {
    id: 'release.rollback-runbook',
    title: 'the rollback runbook documents all four recovery cases',
    category: 'release-rollback',
    layer: 'repo',
    acceptance: 'deployment rollback is documented',
  },
  {
    id: 'release.known-good-deployment',
    title: 'a known-good deployment uid is recorded as the promote target',
    category: 'release-rollback',
    layer: 'repo',
    acceptance: 'deployment rollback is documented',
  },
  {
    id: 'release.ci-gates',
    title: 'CI runs the four repository gates before deploy',
    category: 'release-rollback',
    layer: 'repo',
    acceptance: 'deployment rollback is documented',
  },
  {
    id: 'release.deployment-config',
    title: 'the deployment configuration migrates before build and sweeps daily',
    category: 'release-rollback',
    layer: 'repo',
    acceptance: 'deployment rollback is documented',
  },

  // --- environment separation (bullet 9) --------------------------------------
  {
    id: 'env.quick-signin-availability',
    title: 'demo quick sign-in availability matches the runtime family',
    category: 'environment-separation',
    layer: 'hosted',
    acceptance: 'environment separation is verified',
  },
  {
    id: 'env.demo-gate-refuses-production',
    title: 'the demo seed gate refuses production runtimes and backends',
    category: 'environment-separation',
    layer: 'repo',
    acceptance: 'environment separation is verified',
  },
  {
    id: 'env.matrix-documented',
    title: 'the environment separation matrix is documented',
    category: 'environment-separation',
    layer: 'repo',
    acceptance: 'environment separation is verified',
  },
];

/** All smoke checks, in catalog order. */
export function smokeChecks(): readonly SmokeCheckSpec[] {
  return SMOKE_CHECKS;
}

/** One check spec by id (throws on unknown ids — no silent drift). */
export function smokeCheck(id: string): SmokeCheckSpec {
  const spec = SMOKE_CHECKS.find((check) => check.id === id);
  if (spec === undefined) {
    throw new Error(`unknown smoke check id '${id}' — declare it in the catalog first`);
  }
  return spec;
}

/** All checks assigned to one acceptance bullet. */
export function checksForAcceptance(acceptance: string): readonly SmokeCheckSpec[] {
  return SMOKE_CHECKS.filter((check) => check.acceptance === acceptance);
}

/**
 * Catalog consistency invariants (unit-tested): unique ids, known
 * categories/layers, every acceptance bullet covered by at least one
 * check, and every check's acceptance bullet exists in the bullet list.
 */
export function catalogConsistency(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const ids = new Set<string>();
  const categories: readonly SmokeCategory[] = [
    'routing',
    'health-readiness',
    'authentication-onboarding',
    'seeded-journeys',
    'durable-execution',
    'observability',
    'release-rollback',
    'environment-separation',
  ];
  const layers: readonly SmokeLayer[] = ['hosted', 'journey', 'repo'];
  for (const check of SMOKE_CHECKS) {
    if (ids.has(check.id)) problems.push(`duplicate check id '${check.id}'`);
    ids.add(check.id);
    if (!categories.includes(check.category)) {
      problems.push(`check '${check.id}' has unknown category '${check.category}'`);
    }
    if (!layers.includes(check.layer)) {
      problems.push(`check '${check.id}' has unknown layer '${String(check.layer)}'`);
    }
    if (!W078_ACCEPTANCE_BULLETS.includes(check.acceptance)) {
      problems.push(`check '${check.id}' references an unknown acceptance bullet`);
    }
  }
  for (const bullet of W078_ACCEPTANCE_BULLETS) {
    if (!SMOKE_CHECKS.some((check) => check.acceptance === bullet)) {
      problems.push(`acceptance bullet '${bullet}' has no check`);
    }
  }
  return { ok: problems.length === 0, problems };
}
