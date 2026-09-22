// The smoke driver (W078): one `runDeploymentSmoke()` pass over a hosted
// deployment, through real HTTP only.
//
// WHAT IT PROVES AND HOW. The work item: "Prove the hosted dogfood
// environment through real authentication, onboarding, chat, seeded
// journeys, durable execution retry/idempotency, health/readiness,
// queue/worker observability and release/rollback checks." The driver
// speaks to the deployment exactly as an operator's browser or a
// platform queue consumer would — fetch against the public routes — and
// records a verdict per catalog check:
//
//   hosted layer  — reachable from any network position: routing gates,
//                   the health/readiness contract, the worker seam's
//                   fail-closed auth, quick-sign-in availability, the
//                   retry-policy surface;
//   journey layer — needs a database-backed READY target: a fresh
//                   visitor registers through the REAL auth path
//                   (no shortcuts, no quick-access panel), creates a
//                   company through onboarding, lands in chat, runs a
//                   real composer turn (a full durable cognition
//                   execution), signs the SEEDED manager persona in with
//                   the manifest password, walks the seeded thread,
//                   surfaces the seeded pending approval and decides it
//                   inline, then observes the worker seam's duplicate /
//                   dead-letter / not-found dispositions and the metrics
//                   moving;
//   repo layer    — the operations surface of the repository itself
//                   (rollback runbook, known-good deployment, CI gates,
//                   deployment configuration, environment separation).
//
// BLOCKED DISCIPLINE: journey checks are marked BLOCKED (never failed)
// only when the target's own health endpoint proves the documented
// external precondition is missing — today the W077 §11 operator gaps
// (Neon DATABASE_URL; the worker token lives in the Vercel project
// environment). The moment the operator completes the step, the same
// command goes green. A target that is ready but misbehaves FAILS.

import { demoPersonaPassword, demoPersonaSpec } from '@/modules/demo/contract';
import { smokeCheck } from './catalog';
import { SmokeHttpClient, sessionCookieHeader, sessionTokenFromSetCookie } from './http';
import type { SmokeHttpResponse } from './http';
import {
  anonymousGateReasons,
  approvalCardReasons,
  approvalDecidedReasons,
  authenticatedRootReasons,
  chatGatedNoCompanyReasons,
  chatStateReasons,
  chatTurnReasons,
  companyCreatedReasons,
  healthContractReasons,
  healthGreenReasons,
  healthHonestRefusalReasons,
  observeHealth,
  observeWorkerPush,
  observeWorkerSnapshot,
  observabilitySurfacesAgreeReasons,
  pageRendersReasons,
  quickSignInReasons,
  retryPolicySurfaceReasons,
  sessionIssuedReasons,
  sessionNoCompanyReasons,
  workerAuthFailClosedReasons,
  workerMetricsAdvancedReasons,
  workerOutcomeReasons,
  workerSnapshotReasons,
} from './expectations';
import { summarize } from './report';
import {
  checkBrowserSuiteRegistered,
  checkCiGates,
  checkDeploymentConfig,
  checkDemoGateSeparation,
  checkEnvironmentMatrix,
  checkKnownGoodDeployment,
  checkRollbackRunbook,
} from './repo';
import type {
  HealthObservation,
  SmokeCheckResult,
  SmokeCheckStatus,
  SmokeReport,
  SmokeRunConfig,
} from './types';

/** The seeded conversation title (W068 demo world, journey B). */
const SEEDED_CONVERSATION_TITLE = 'Wholesale freshness — Aurum';

const DB_GAP_OPERATOR_STEP =
  'Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command';

const WORKER_TOKEN_STEP =
  'Provide the worker seam token (--worker-token / AURUM_SMOKE_WORKER_TOKEN) — the value lives in the Vercel project environment (WORKER_TOKEN)';

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A random uuid (crypto.getRandomValues — no dependency needed). */
function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The driver's result collector — verdicts come from the catalog only. */
class CheckRecorder {
  readonly results: SmokeCheckResult[] = [];

  record(
    id: string,
    status: SmokeCheckStatus,
    detail: string,
    evidence?: Record<string, unknown>,
  ): void {
    const spec = smokeCheck(id);
    this.results.push({
      id: spec.id,
      title: spec.title,
      category: spec.category,
      acceptance: spec.acceptance,
      layer: spec.layer,
      status,
      detail,
      evidence,
    });
  }

  reasons(id: string, reasons: string[], evidence?: Record<string, unknown>): void {
    if (reasons.length === 0) {
      this.record(id, 'pass', 'observed as specified', evidence);
    } else {
      this.record(id, 'fail', reasons.join('; '), evidence);
    }
  }

  blocked(id: string, reason: string, evidence?: Record<string, unknown>): void {
    this.record(id, 'blocked', reason, evidence);
  }

  skipped(id: string, reason: string, evidence?: Record<string, unknown>): void {
    this.record(id, 'skipped', reason, evidence);
  }
}

function evidenceOf(response: SmokeHttpResponse): Record<string, unknown> {
  return {
    status: response.status,
    body: response.body === null ? clip(response.text, 400) : response.body,
  };
}

/** Every check the journey layer can emit (blocked/skipped lists stay exact). */
const JOURNEY_CHECK_IDS: readonly string[] = [
  'auth.signup',
  'auth.session-no-company',
  'auth.chat-gated-pre-onboarding',
  'auth.onboarding-company',
  'auth.signout',
  'routing.root-authenticated-chat',
  'chat.state-fresh',
  'chat.turn',
  'chat.thread-persists',
  'seeded.persona-signin',
  'seeded.conversation-list',
  'seeded.thread',
  'seeded.attention-turn',
  'seeded.approval-decided',
  'worker.duplicate-acknowledged',
  'worker.dead-letter-invalid',
  'worker.not-found-consumed',
  'worker.idle-pull',
  'observability.metrics-advance',
  'observability.surfaces-agree',
];

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/** Run the W078 deployment smoke suite against one hosted target. */
export async function runDeploymentSmoke(config: SmokeRunConfig): Promise<SmokeReport> {
  const startedAt = new Date();
  const runId = config.runId ?? startedAt.getTime().toString(36);
  const client = new SmokeHttpClient({
    baseUrl: config.target,
    timeoutMs: config.timeoutMs,
    fetchImpl: config.fetchImpl,
  });
  const recorder = new CheckRecorder();
  const quickSignInExpectation = config.expectQuickSignIn ?? 'unchecked';
  const workerToken = config.workerToken ?? null;

  // -------------------------------------------------------------------------
  // 1. Hosted layer — routing
  // -------------------------------------------------------------------------
  const root = await client.get('/');
  recorder.reasons('routing.root-anonymous-gate', anonymousGateReasons(root, '/'), {
    status: root.status,
    location: root.location,
  });

  const chatAnonymous = await client.get('/chat');
  recorder.reasons('routing.chat-anonymous-gate', anonymousGateReasons(chatAnonymous, '/chat'), {
    status: chatAnonymous.status,
    location: chatAnonymous.location,
  });

  const onboarding = await client.get('/onboarding');
  recorder.reasons(
    'routing.onboarding-gate',
    anonymousGateReasons(onboarding, '/onboarding'),
    { status: onboarding.status, location: onboarding.location },
  );

  const signin = await client.get('/signin');
  recorder.reasons('routing.signin-renders', pageRendersReasons(signin, { contains: 'Aurum' }), {
    status: signin.status,
    contentType: signin.headers['content-type'] ?? null,
  });

  const assetMatch = /\/_next\/static\/[^"' )]+\.(?:css|js)/.exec(signin.text);
  if (assetMatch === null) {
    // A built deployment always embeds its asset graph; an SSR-harness
    // render does not. Nothing to prove either way — say so honestly.
    recorder.skipped(
      'routing.static-assets',
      'the rendered document references no /_next/static asset (an SSR-harness render carries no build asset graph — this check is proven on built/hosted targets)',
      { status: signin.status },
    );
  } else {
    const asset = await client.get(assetMatch[0]);
    const reasons: string[] = [];
    if (asset.status !== 200) reasons.push(`the asset answered ${asset.status}`);
    if (asset.error !== null) reasons.push(`the asset fetch failed: ${clip(asset.error, 120)}`);
    recorder.reasons('routing.static-assets', reasons, {
      asset: assetMatch[0],
      status: asset.status,
      contentType: asset.headers['content-type'] ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // 2. Hosted layer — health / readiness
  // -------------------------------------------------------------------------
  let health: HealthObservation = observeHealth(await client.get('/api/health'));
  recorder.reasons('health.contract', healthContractReasons(health), {
    status: health.httpStatus,
    healthStatus: health.status,
    environment: health.environment,
    backends: {
      db: health.dbBackend,
      queue: health.queueBackend,
      cache: health.cacheBackend,
      lock: health.lockBackend,
      email: health.emailBackend,
      blob: health.blobBackend,
    },
  });

  const journeyReady = health.status !== 'error' && health.dbOk === true;
  const dbBlockReason = `the hosted database is not ready — /api/health reports status '${health.status}'${
    health.dbError === null ? '' : ` (${clip(health.dbError, 160)})`
  }. ${DB_GAP_OPERATOR_STEP}`;

  // The green-health obligation: proven on any ready target, blocked on the
  // documented gap — never silently skipped.
  if (journeyReady) {
    recorder.reasons('health.green', healthGreenReasons(health), {
      status: health.status,
      migrations: health.migrations,
      refusals: health.refusals.length,
      warnings: health.warnings.length,
    });
  } else {
    recorder.blocked('health.green', dbBlockReason, {
      healthStatus: health.status,
      dbBackend: health.dbBackend,
      dbError: health.dbError,
    });
  }

  if (config.expectedEnvironment === undefined) {
    recorder.skipped('health.environment-label', 'no expected environment was configured', {
      observed: health.environment,
    });
  } else if (health.environment === config.expectedEnvironment) {
    recorder.record(
      'health.environment-label',
      'pass',
      `the target reports '${health.environment}'`,
      { observed: health.environment, expected: config.expectedEnvironment, hostedOnVercel: health.hostedOnVercel },
    );
  } else {
    recorder.record(
      'health.environment-label',
      'fail',
      `the target reports environment '${health.environment}' (expected '${config.expectedEnvironment}')`,
      { observed: health.environment, expected: config.expectedEnvironment },
    );
  }

  if (health.status === 'error') {
    recorder.reasons('health.honest-refusal', healthHonestRefusalReasons(health), {
      status: health.httpStatus,
      refusals: health.refusals,
      dbBackend: health.dbBackend,
    });
  } else {
    recorder.skipped(
      'health.honest-refusal',
      'nothing to refuse — the target reports a serving database (no production refusal state to observe)',
      { status: health.status },
    );
  }

  recorder.reasons('worker.retry-policy-surface', retryPolicySurfaceReasons(health.guardrails), {
    guardrails: health.guardrails,
  });

  // -------------------------------------------------------------------------
  // 3. Hosted layer — worker seam auth + observability
  // -------------------------------------------------------------------------
  const workerNoToken = await client.get('/api/worker');
  const seamTokenGated = workerNoToken.status === 401;
  if (seamTokenGated) {
    const workerBadToken = await client.get('/api/worker', {
      'x-worker-token': 'definitely-not-the-token',
    });
    recorder.reasons(
      'worker.seam-auth-fail-closed',
      workerAuthFailClosedReasons(workerNoToken, workerBadToken),
      { noTokenStatus: workerNoToken.status, badTokenStatus: workerBadToken.status },
    );
  } else {
    recorder.skipped(
      'worker.seam-auth-fail-closed',
      'the seam is not token-gated on this target (no WORKER_TOKEN configured — legal outside production)',
      { noTokenStatus: workerNoToken.status },
    );
  }

  if (seamTokenGated && workerToken === null) {
    recorder.blocked('observability.worker-snapshot', WORKER_TOKEN_STEP, {
      noTokenStatus: workerNoToken.status,
    });
  } else {
    const tokenHeaders = workerToken === null ? undefined : { 'x-worker-token': workerToken };
    const snapshotResponse = await client.get('/api/worker', tokenHeaders);
    const snapshot = observeWorkerSnapshot(snapshotResponse);
    recorder.reasons('observability.worker-snapshot', workerSnapshotReasons(snapshot), {
      status: snapshotResponse.status,
      environment: snapshot.environment,
      queueDepth: snapshot.queueDepth,
      metrics: snapshot.metrics,
    });
  }

  if (quickSignInExpectation === 'unchecked') {
    recorder.skipped(
      'env.quick-signin-availability',
      'no quick-sign-in expectation was configured for this target',
    );
  } else {
    const quickSignIn = await client.post('/api/auth/quick-sign-in', { persona: 'manager' });
    recorder.reasons(
      'env.quick-signin-availability',
      quickSignInReasons(quickSignIn, quickSignInExpectation),
      { status: quickSignIn.status, body: quickSignIn.body },
    );
  }

  // -------------------------------------------------------------------------
  // 4. Journey layer — gated on a database-backed READY target
  // -------------------------------------------------------------------------
  if (config.profile !== 'full') {
    for (const id of JOURNEY_CHECK_IDS) {
      recorder.skipped(id, 'the journey layer runs only with --profile full');
    }
  } else if (!journeyReady) {
    for (const id of JOURNEY_CHECK_IDS) {
      recorder.blocked(id, dbBlockReason, { healthStatus: health.status });
    }
  } else {
    await runJourneyLayer(recorder, client, {
      runId,
      workerToken,
      seamTokenGated,
      workerTokenStep: WORKER_TOKEN_STEP,
    });
    // The final health observation (post-activity) for the report.
    health = observeHealth(await client.get('/api/health'));
  }

  // -------------------------------------------------------------------------
  // 5. Repo layer — the operations surface of the repository
  // -------------------------------------------------------------------------
  const repoCheckIds: readonly string[] = [
    'release.rollback-runbook',
    'release.known-good-deployment',
    'release.ci-gates',
    'release.deployment-config',
    'browser.suite-registered',
    'env.demo-gate-refuses-production',
    'env.matrix-documented',
  ];
  if (config.repoRoot === null || config.repoRoot === undefined) {
    for (const id of repoCheckIds) {
      recorder.skipped(id, 'the repo layer runs only with --repo-root');
    }
  } else {
    const rollback = await checkRollbackRunbook(config.repoRoot);
    recorder.reasons('release.rollback-runbook', rollback.reasons, rollback.evidence);
    const knownGood = await checkKnownGoodDeployment(config.repoRoot);
    recorder.reasons('release.known-good-deployment', knownGood.reasons, knownGood.evidence);
    const ci = await checkCiGates(config.repoRoot);
    recorder.reasons('release.ci-gates', ci.reasons, ci.evidence);
    const deploymentConfig = await checkDeploymentConfig(config.repoRoot);
    recorder.reasons('release.deployment-config', deploymentConfig.reasons, deploymentConfig.evidence);
    const browserSuite = await checkBrowserSuiteRegistered(config.repoRoot);
    recorder.reasons('browser.suite-registered', browserSuite.reasons, browserSuite.evidence);
    const demoGate = await checkDemoGateSeparation();
    recorder.reasons('env.demo-gate-refuses-production', demoGate.reasons, demoGate.evidence);
    const matrix = await checkEnvironmentMatrix(config.repoRoot);
    recorder.reasons('env.matrix-documented', matrix.reasons, matrix.evidence);
  }

  const finishedAt = new Date();
  return {
    label: config.label ?? new URL(config.target).host,
    target: config.target,
    profile: config.profile,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    expectedEnvironment: config.expectedEnvironment ?? null,
    results: recorder.results,
    summary: summarize(recorder.results),
    health,
  };
}

// ---------------------------------------------------------------------------
// The journey layer (database-backed target)
// ---------------------------------------------------------------------------

interface JourneyContext {
  runId: string;
  workerToken: string | null;
  seamTokenGated: boolean;
  workerTokenStep: string;
}

async function runJourneyLayer(
  recorder: CheckRecorder,
  client: SmokeHttpClient,
  context: JourneyContext,
): Promise<void> {
  const { runId } = context;

  // --- real authentication: a fresh visitor registers ----------------------
  const signUpEmail = `w078-smoke-${runId}@aurum-smoke.test`;
  const signUpPassword = `smoke-${runId}-operator`;
  const signUp = await client.post('/api/auth/sign-up', {
    displayName: 'W078 Smoke Operator',
    email: signUpEmail,
    password: signUpPassword,
  });
  recorder.reasons('auth.signup', sessionIssuedReasons(signUp), evidenceOf(signUp));
  const smokeToken = sessionTokenFromSetCookie(signUp.setCookies);

  if (smokeToken === null) {
    // Without a session nothing later can run — fail the rest honestly.
    for (const id of JOURNEY_CHECK_IDS) {
      if (id !== 'auth.signup') recorder.record(id, 'fail', 'sign-up issued no session cookie — the journey cannot continue');
    }
    return;
  }
  const smokeCookie = sessionCookieHeader(smokeToken);

  // --- the pre-onboarding state ---------------------------------------------
  const sessionBefore = await client.get('/api/auth/session', smokeCookie);
  recorder.reasons(
    'auth.session-no-company',
    sessionNoCompanyReasons(sessionBefore),
    evidenceOf(sessionBefore),
  );

  const chatBefore = await client.get('/api/product/chat/state', smokeCookie);
  recorder.reasons(
    'auth.chat-gated-pre-onboarding',
    chatGatedNoCompanyReasons(chatBefore),
    evidenceOf(chatBefore),
  );

  // --- onboarding: create the company ----------------------------------------
  const company = await client.post(
    '/api/auth/onboarding/company',
    { name: 'W078 Smoke Roasters', slug: `w078-smoke-${runId.toLowerCase()}` },
    smokeCookie,
  );
  recorder.reasons('auth.onboarding-company', companyCreatedReasons(company).reasons, evidenceOf(company));

  // --- chat is the primary root experience ------------------------------------
  const rootAuthenticated = await client.get('/', smokeCookie);
  recorder.reasons('routing.root-authenticated-chat', authenticatedRootReasons(rootAuthenticated), {
    status: rootAuthenticated.status,
    location: rootAuthenticated.location,
  });

  // --- the composer turn (a full durable cognition execution) ------------------
  const stateFresh = await client.get('/api/product/chat/state', smokeCookie);
  recorder.reasons('chat.state-fresh', chatStateReasons(stateFresh).reasons, evidenceOf(stateFresh));

  const turn = await client.post(
    '/api/product/chat/messages',
    { text: 'What needs my attention?' },
    smokeCookie,
  );
  const turnOutcome = chatTurnReasons(turn);
  recorder.reasons('chat.turn', turnOutcome.reasons, {
    status: turn.status,
    conversationId: turnOutcome.conversationId,
    executionId: turnOutcome.executionId,
  });

  if (turnOutcome.conversationId !== null) {
    const thread = await client.get(
      `/api/product/chat/state?conversationId=${turnOutcome.conversationId}`,
      smokeCookie,
    );
    recorder.reasons(
      'chat.thread-persists',
      chatStateReasons(thread, { expectThreadMessages: 2 }).reasons,
      { conversationId: turnOutcome.conversationId, status: thread.status },
    );
  } else {
    recorder.record(
      'chat.thread-persists',
      'fail',
      'the turn produced no conversation id — the thread cannot be re-read',
    );
  }

  // --- the seeded demo journeys -------------------------------------------------
  const manager = demoPersonaSpec('manager');
  const managerSignIn = await client.post('/api/auth/sign-in', {
    email: manager.email,
    password: demoPersonaPassword(),
  });
  recorder.reasons('seeded.persona-signin', sessionIssuedReasons(managerSignIn), {
    status: managerSignIn.status,
    persona: 'manager',
    email: manager.email,
  });
  const managerToken = sessionTokenFromSetCookie(managerSignIn.setCookies);

  if (managerToken === null) {
    for (const id of ['seeded.conversation-list', 'seeded.thread', 'seeded.attention-turn', 'seeded.approval-decided']) {
      recorder.record(id, 'fail', 'the seeded manager persona could not sign in');
    }
  } else {
    const managerCookie = sessionCookieHeader(managerToken);

    const seededState = await client.get('/api/product/chat/state', managerCookie);
    const seededList = chatStateReasons(seededState, { expectTitle: SEEDED_CONVERSATION_TITLE });
    recorder.reasons('seeded.conversation-list', seededList.reasons, {
      status: seededState.status,
      expectedTitle: SEEDED_CONVERSATION_TITLE,
    });

    if (seededList.conversationId !== null) {
      const seededThread = await client.get(
        `/api/product/chat/state?conversationId=${seededList.conversationId}`,
        managerCookie,
      );
      recorder.reasons(
        'seeded.thread',
        chatStateReasons(seededThread, { expectThreadMessages: 4 }).reasons,
        { conversationId: seededList.conversationId, status: seededThread.status },
      );

      // The attention turn surfaces the seeded pending approval (Journey E).
      const attention = await client.post(
        '/api/product/chat/messages',
        { conversationId: seededList.conversationId, text: 'What needs my attention?' },
        managerCookie,
      );
      const attentionOutcome = approvalCardReasons(attention);
      recorder.reasons('seeded.attention-turn', attentionOutcome.reasons, {
        status: attention.status,
        requestId: attentionOutcome.requestId,
      });

      if (attentionOutcome.requestId !== null) {
        const decision = await client.post(
          `/api/product/chat/approvals/${attentionOutcome.requestId}/decide`,
          { decision: 'approve', note: 'W078 post-deployment smoke' },
          managerCookie,
        );
        const stateAfter = await client.get(
          `/api/product/chat/state?conversationId=${seededList.conversationId}`,
          managerCookie,
        );
        recorder.reasons(
          'seeded.approval-decided',
          approvalDecidedReasons(decision, stateAfter, attentionOutcome.requestId),
          { requestId: attentionOutcome.requestId, decisionStatus: decision.status },
        );
      } else {
        recorder.record(
          'seeded.approval-decided',
          'fail',
          'the attention turn surfaced no pending approval card — nothing to decide',
        );
      }
    } else {
      for (const id of ['seeded.thread', 'seeded.attention-turn', 'seeded.approval-decided']) {
        recorder.record(id, 'fail', 'the seeded conversation is not in the manager chat list');
      }
    }
  }

  // --- durable execution semantics (the worker push seam) ------------------------
  const seamAccess =
    !(context.seamTokenGated && context.workerToken === null)
      ? ({ ok: true } as const)
      : ({ ok: false, reason: context.workerTokenStep } as const);
  const tokenHeaders = context.workerToken === null ? undefined : { 'x-worker-token': context.workerToken };

  const sessionForExecution = await client.get('/api/auth/session', smokeCookie);
  const sessionBody =
    sessionForExecution.status === 200 &&
    typeof sessionForExecution.body === 'object' &&
    sessionForExecution.body !== null &&
    !Array.isArray(sessionForExecution.body)
      ? (sessionForExecution.body as Record<string, unknown>)
      : {};
  const principal =
    typeof sessionBody['principal'] === 'object' && sessionBody['principal'] !== null
      ? (sessionBody['principal'] as Record<string, unknown>)
      : {};
  const companyView =
    typeof sessionBody['company'] === 'object' && sessionBody['company'] !== null
      ? (sessionBody['company'] as Record<string, unknown>)
      : {};
  const principalId = typeof principal['id'] === 'string' ? principal['id'] : null;
  const tenantId = typeof companyView['tenantId'] === 'string' ? companyView['tenantId'] : null;
  const authority = Array.isArray(companyView['authority'])
    ? companyView['authority'].filter((claim): claim is string => typeof claim === 'string')
    : [];
  const executionId = turnOutcome.executionId;

  const executionRefsReady = tenantId !== null && principalId !== null && executionId !== null;
  const refsReason = 'the chat turn or session did not expose the execution references the worker probes need';

  if (!seamAccess.ok) {
    for (const id of [
      'worker.duplicate-acknowledged',
      'worker.dead-letter-invalid',
      'worker.not-found-consumed',
      'worker.idle-pull',
      'observability.metrics-advance',
      'observability.surfaces-agree',
    ]) {
      recorder.blocked(id, seamAccess.reason);
    }
  } else {
    // An invalid envelope is dead-lettered with a precise reason, never retried.
    const invalid = await client.post(
      '/api/worker',
      { jobs: [{ kind: 'not-a-cognition-stage' }] },
      tokenHeaders,
    );
    recorder.reasons(
      'worker.dead-letter-invalid',
      workerOutcomeReasons(observeWorkerPush(invalid), {
        status: 'dead_letter',
        detailIncludes: 'invalid job envelope',
      }),
      evidenceOf(invalid),
    );

    // A pull-mode sweep of the drained queue reports idle honestly.
    const pull = await client.post('/api/worker', undefined, tokenHeaders);
    recorder.reasons(
      'worker.idle-pull',
      workerOutcomeReasons(observeWorkerPush(pull), { status: 'idle' }),
      evidenceOf(pull),
    );

    if (!executionRefsReady) {
      for (const id of [
        'worker.duplicate-acknowledged',
        'worker.not-found-consumed',
        'observability.metrics-advance',
      ]) {
        recorder.blocked(id, refsReason, {
          tenantId,
          executionId,
          principalId: principalId === null ? null : 'present',
        });
      }
    } else {
      const job = (overrides: Record<string, unknown>) => ({
        kind: 'cognition-stage',
        executionId,
        stage: 'observation',
        tenantId,
        principalId,
        authority,
        input: {},
        attempt: 1,
        enqueuedAt: new Date().toISOString(),
        ...overrides,
      });

      // A redelivered job whose stage already advanced (the turn completed
      // or suspended past 'observation') is ACKNOWLEDGED as an idempotent
      // duplicate — persisted execution state is the idempotency authority.
      const duplicate = await client.post('/api/worker', { jobs: [job({})] }, tokenHeaders);
      recorder.reasons(
        'worker.duplicate-acknowledged',
        workerOutcomeReasons(observeWorkerPush(duplicate), { status: 'duplicate' }),
        evidenceOf(duplicate),
      );

      // A well-formed job for an unknown execution is consumed as not_found.
      const unknown = await client.post(
        '/api/worker',
        { jobs: [job({ executionId: randomUuid() })] },
        tokenHeaders,
      );
      recorder.reasons(
        'worker.not-found-consumed',
        workerOutcomeReasons(observeWorkerPush(unknown), { status: 'not_found' }),
        evidenceOf(unknown),
      );

      // The counters must reflect the dispositions just observed.
      const snapshotAfter = observeWorkerSnapshot(await client.get('/api/worker', tokenHeaders));
      recorder.reasons(
        'observability.metrics-advance',
        workerMetricsAdvancedReasons(snapshotAfter, { duplicate: true, notFound: true }),
        { metrics: snapshotAfter.metrics, queueDepth: snapshotAfter.queueDepth },
      );
    }
  }

  // --- the two observability surfaces must agree (one process registry) ------------
  const lateHealth = observeHealth(await client.get('/api/health'));
  const lateSnapshot = observeWorkerSnapshot(
    await client.get('/api/worker', tokenHeaders ?? undefined),
  );
  recorder.reasons(
    'observability.surfaces-agree',
    observabilitySurfacesAgreeReasons(lateHealth, lateSnapshot),
    { healthWorker: lateHealth.workerMetrics, seamWorker: lateSnapshot.metrics },
  );

  // --- sign-out revokes the session ---------------------------------------------------
  const signOut = await client.post('/api/auth/sign-out', undefined, smokeCookie);
  const sessionAfter = await client.get('/api/auth/session', smokeCookie);
  const signOutReasons: string[] = [];
  if (signOut.status !== 200) signOutReasons.push(`expected HTTP 200 (got ${signOut.status})`);
  if (!signOut.setCookies.some((cookie) => cookie.startsWith('aurum_session=;'))) {
    signOutReasons.push('the session cookie was not cleared');
  }
  if (sessionAfter.status !== 401) {
    signOutReasons.push(`the revoked session still answers ${sessionAfter.status} (expected 401)`);
  }
  recorder.reasons('auth.signout', signOutReasons, {
    signOutStatus: signOut.status,
    sessionAfterStatus: sessionAfter.status,
  });
}
