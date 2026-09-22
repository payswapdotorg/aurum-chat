// The smoke suite's expectation model (pure evaluators, no I/O).
//
// Every evaluator takes OBSERVED evidence (an SmokeHttpResponse, or a
// defensive view parsed out of one) and returns reasons: an empty list
// means the expectation holds, each entry is one precise violation.
// The driver turns (reasons, context) into pass/fail/blocked/skipped
// verdicts; all domain judgment lives here so it is unit-testable
// against synthetic observations — including the exact body shapes the
// live production dogfood returns today (the honest 503 with its
// DATABASE_URL refusal — captured verbatim in the unit tests).
//
// The contracts evaluated are the deployment's own frozen surfaces:
//   * /api/health   — docs/DEPLOYMENT.md §7 + src/app/api/health/lib.ts;
//   * /api/worker   — docs/DEPLOYMENT.md §2/§7 + src/app/api/worker/lib.ts;
//   * /api/auth/**  — src/app/(auth)/lib/api.ts (W058);
//   * /api/product/chat/** — src/app/(product)/chat/lib/chat-api.ts;
//   * the middleware route gate — src/middleware.ts (W058).

import type {
  GuardrailObservation,
  HealthObservation,
  WorkerCounters,
  WorkerPushObservation,
  WorkerSnapshotObservation,
} from './types';
import type { SmokeHttpResponse } from './http';

// ---------------------------------------------------------------------------
// Small defensive helpers (the observed bodies are arbitrary JSON)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Parse the worker metrics registry out of either surface's body. */
function observeCounters(raw: unknown): WorkerCounters {
  const metrics = isRecord(raw) ? raw : {};
  return {
    jobsEnqueued: asNumber(metrics['jobsEnqueued']),
    jobsProcessed: asNumber(metrics['jobsProcessed']),
    jobsSuspended: asNumber(metrics['jobsSuspended']),
    jobsDuplicate: asNumber(metrics['jobsDuplicate']),
    jobsConflict: asNumber(metrics['jobsConflict']),
    jobsNotFound: asNumber(metrics['jobsNotFound']),
    jobsRetried: asNumber(metrics['jobsRetried']),
    jobsDeadLettered: asNumber(metrics['jobsDeadLettered']),
    idlePolls: asNumber(metrics['idlePolls']),
    batches: asNumber(metrics['batches']),
    lastActivityAt: asString(metrics['lastActivityAt']),
  };
}

/** Parse the deployment guardrails out of either surface's body. */
function observeGuardrails(raw: unknown): GuardrailObservation {
  const guardrails = isRecord(raw) ? raw : {};
  return {
    workerMaxAttempts: asNumber(guardrails['workerMaxAttempts']),
    workerBatchLimit: asNumber(guardrails['workerBatchLimit']),
    workerPollIntervalMs: asNumber(guardrails['workerPollIntervalMs']),
  };
}

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------

/** Parse /api/health into the defensive observation the driver uses. */
export function observeHealth(response: SmokeHttpResponse): HealthObservation {
  const body = isRecord(response.body) ? response.body : {};
  const environment = isRecord(body['environment']) ? body['environment'] : {};
  const components = isRecord(body['components']) ? body['components'] : {};
  const db = isRecord(components['db']) ? components['db'] : {};
  const readiness = isRecord(body['readiness']) ? body['readiness'] : {};
  const rawStatus = asString(body['status']);
  const status: HealthObservation['status'] =
    rawStatus === 'ok' || rawStatus === 'degraded' || rawStatus === 'error'
      ? rawStatus
      : 'unknown';
  const metrics = isRecord(body['worker']) ? body['worker'] : null;
  return {
    httpStatus: response.status,
    status,
    environment: asString(environment['environment']),
    hostedOnVercel: asBoolean(environment['hostedOnVercel']),
    dogfoodNotice: asString(environment['dogfoodNotice']),
    dbBackend: asString(db['backend']),
    dbOk: asBoolean(db['ok']),
    migrations: asNumber(db['migrations']),
    dbError: asString(db['error']),
    queueBackend: asString(isRecord(components['queue']) ? components['queue']['backend'] : null),
    cacheBackend: asString(isRecord(components['cache']) ? components['cache']['backend'] : null),
    lockBackend: asString(isRecord(components['lock']) ? components['lock']['backend'] : null),
    emailBackend: asString(isRecord(components['email']) ? components['email']['backend'] : null),
    blobBackend: asString(isRecord(components['blob']) ? components['blob']['backend'] : null),
    refusals: (asArray(readiness['refusals']) ?? []).filter(
      (entry): entry is string => typeof entry === 'string',
    ),
    warnings: (asArray(readiness['warnings']) ?? []).filter(
      (entry): entry is string => typeof entry === 'string',
    ),
    workerMetricsPresent: metrics !== null,
    workerMetrics: observeCounters(body['worker']),
    guardrails: observeGuardrails(body['guardrails']),
    cacheControl: response.headers['cache-control'] ?? null,
    fetchError: response.error,
  };
}

/** The health endpoint must answer the full readiness contract shape. */
export function healthContractReasons(observation: HealthObservation): string[] {
  const reasons: string[] = [];
  if (observation.httpStatus === 0) {
    reasons.push(
      `the target is unreachable (${clip(observation.fetchError ?? 'no response', 160)})`,
    );
    return reasons;
  }
  if (observation.status === 'unknown') {
    reasons.push('the body has no recognizable status field (ok|degraded|error)');
  }
  if (observation.status === 'error' && observation.httpStatus !== 503) {
    reasons.push(`status 'error' must answer HTTP 503 (got ${observation.httpStatus})`);
  }
  if (observation.status !== 'error' && observation.httpStatus !== 200) {
    reasons.push(
      `status '${observation.status}' must answer HTTP 200 (got ${observation.httpStatus})`,
    );
  }
  if (observation.environment === null) {
    reasons.push('the environment label is absent');
  }
  for (const backend of [
    ['db', observation.dbBackend],
    ['queue', observation.queueBackend],
    ['cache', observation.cacheBackend],
    ['lock', observation.lockBackend],
    ['email', observation.emailBackend],
    ['blob', observation.blobBackend],
  ] as const) {
    if (backend[1] === null) reasons.push(`the ${backend[0]} backend label is absent`);
  }
  if (!observation.workerMetricsPresent) {
    reasons.push('the worker metrics registry is absent');
  }
  if (observation.cacheControl === null || !observation.cacheControl.includes('no-store')) {
    reasons.push(`health must be cache-control: no-store (got '${observation.cacheControl ?? 'none'}')`);
  }
  return reasons;
}

/** Health must be green: db answers, schema applied, no refusals. */
export function healthGreenReasons(observation: HealthObservation): string[] {
  const reasons: string[] = [];
  if (observation.status !== 'ok') {
    reasons.push(`health status is '${observation.status}' (expected 'ok')`);
  }
  if (observation.dbOk !== true) {
    reasons.push(
      `the domain-truth database does not answer${observation.dbError === null ? '' : `: ${clip(observation.dbError, 160)}`}`,
    );
  }
  if (observation.migrations === null || observation.migrations <= 0) {
    reasons.push('the schema is not applied (migrations count missing or zero)');
  }
  if (observation.refusals.length > 0) {
    reasons.push(`production readiness refusals present: ${observation.refusals.join(' | ')}`);
  }
  return reasons;
}

/**
 * The fail-closed honesty rule (lock 35): a PRODUCTION target without
 * its external PostgreSQL must refuse to serve — 503, status 'error',
 * the precise DATABASE_URL refusal — rather than silently degrade.
 */
export function healthHonestRefusalReasons(observation: HealthObservation): string[] {
  const reasons: string[] = [];
  if (observation.status !== 'error') {
    reasons.push(`expected the honest refusal state 'error' (got '${observation.status}')`);
  }
  if (observation.httpStatus !== 503) {
    reasons.push(`expected HTTP 503 on the refusal (got ${observation.httpStatus})`);
  }
  if (!observation.refusals.some((refusal) => refusal.includes('DATABASE_URL'))) {
    reasons.push('the refusal list does not mention the missing DATABASE_URL');
  }
  if (observation.dbBackend !== 'embedded') {
    reasons.push(
      `expected the db backend label 'embedded' while the external database is missing (got '${observation.dbBackend}')`,
    );
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// /api/worker
// ---------------------------------------------------------------------------

/** Parse GET /api/worker into the observability observation. */
export function observeWorkerSnapshot(response: SmokeHttpResponse): WorkerSnapshotObservation {
  const body = isRecord(response.body) ? response.body : {};
  return {
    httpStatus: response.status,
    environment: asString(body['environment']),
    queueDepth: asNumber(body['queueDepth']),
    metrics: observeCounters(body['metrics']),
    guardrails: observeGuardrails(body['guardrails']),
  };
}

/** The worker seam snapshot must expose queue depth + the full registry. */
export function workerSnapshotReasons(observation: WorkerSnapshotObservation): string[] {
  const reasons: string[] = [];
  if (observation.httpStatus !== 200) {
    reasons.push(`expected HTTP 200 from the worker snapshot (got ${observation.httpStatus})`);
  }
  if (observation.queueDepth === null || observation.queueDepth < 0) {
    reasons.push('queue depth is not inspectable (missing or negative)');
  }
  const counters: [string, number | null][] = [
    ['jobsEnqueued', observation.metrics.jobsEnqueued],
    ['jobsProcessed', observation.metrics.jobsProcessed],
    ['jobsSuspended', observation.metrics.jobsSuspended],
    ['jobsDuplicate', observation.metrics.jobsDuplicate],
    ['jobsConflict', observation.metrics.jobsConflict],
    ['jobsNotFound', observation.metrics.jobsNotFound],
    ['jobsRetried', observation.metrics.jobsRetried],
    ['jobsDeadLettered', observation.metrics.jobsDeadLettered],
    ['idlePolls', observation.metrics.idlePolls],
    ['batches', observation.metrics.batches],
  ];
  for (const [name, value] of counters) {
    if (value === null) reasons.push(`the ${name} counter is absent`);
  }
  return reasons;
}

/** Parse a push-mode POST /api/worker response. */
export function observeWorkerPush(response: SmokeHttpResponse): WorkerPushObservation {
  const body = isRecord(response.body) ? response.body : {};
  const outcomes = (asArray(body['outcomes']) ?? []).filter(isRecord);
  return {
    httpStatus: response.status,
    mode: asString(body['mode']),
    processed: asNumber(body['processed']),
    outcomeStatuses: outcomes
      .map((outcome) => asString(outcome['status']))
      .filter((status): status is string => status !== null),
    outcomeDetails: outcomes
      .map((outcome) => asString(outcome['detail']))
      .filter((detail): detail is string => detail !== null),
    queueDepth: asNumber(body['queueDepth']),
  };
}

/** One processed job must come back with exactly this disposition. */
export function workerOutcomeReasons(
  observation: WorkerPushObservation,
  expected: { status: string; detailIncludes?: string; mode?: string },
): string[] {
  const reasons: string[] = [];
  if (observation.httpStatus !== 200) {
    reasons.push(`expected HTTP 200 from the worker seam (got ${observation.httpStatus})`);
    return reasons;
  }
  if (expected.mode !== undefined && observation.mode !== expected.mode) {
    reasons.push(`expected ${expected.mode} mode (got '${observation.mode}')`);
  }
  if (observation.outcomeStatuses.length !== 1) {
    reasons.push(`expected exactly one outcome (got ${observation.outcomeStatuses.length})`);
    return reasons;
  }
  if (observation.outcomeStatuses[0] !== expected.status) {
    reasons.push(
      `expected outcome '${expected.status}' (got '${observation.outcomeStatuses[0] ?? 'none'}')`,
    );
  }
  if (
    expected.detailIncludes !== undefined &&
    !(observation.outcomeDetails[0] ?? '').includes(expected.detailIncludes)
  ) {
    reasons.push(
      `expected the outcome detail to mention '${expected.detailIncludes}' (got '${clip(observation.outcomeDetails[0] ?? '', 200)}')`,
    );
  }
  return reasons;
}

/** The observability counters must reflect the dispositions just observed. */
export function workerMetricsAdvancedReasons(
  observation: WorkerSnapshotObservation,
  expectation: { duplicate: boolean; notFound: boolean },
): string[] {
  const reasons: string[] = [];
  if (expectation.duplicate && (observation.metrics.jobsDuplicate ?? 0) < 1) {
    reasons.push('the duplicate counter did not advance');
  }
  if (expectation.notFound && (observation.metrics.jobsNotFound ?? 0) < 1) {
    reasons.push('the not-found counter did not advance');
  }
  if ((observation.metrics.batches ?? 0) < 1) {
    reasons.push('no worker batch was recorded');
  }
  if (observation.metrics.lastActivityAt === null) {
    reasons.push('lastActivityAt is not set');
  }
  return reasons;
}

/** Health and the worker seam must agree on the counters (one process). */
export function observabilitySurfacesAgreeReasons(
  health: HealthObservation,
  worker: WorkerSnapshotObservation,
): string[] {
  const reasons: string[] = [];
  if (health.workerMetricsPresent !== true) {
    reasons.push('health does not carry the worker metrics registry');
    return reasons;
  }
  const compared: [keyof WorkerCounters, string][] = [
    ['jobsDuplicate', 'duplicate'],
    ['jobsNotFound', 'not-found'],
    ['jobsDeadLettered', 'dead-lettered'],
    ['jobsProcessed', 'processed'],
    ['batches', 'batches'],
  ];
  for (const [key, label] of compared) {
    const fromHealth = health.workerMetrics[key];
    const fromWorker = worker.metrics[key];
    if (fromHealth === null || fromWorker === null) {
      reasons.push(`the ${label} counter is missing on one of the surfaces`);
    } else if (fromHealth !== fromWorker) {
      reasons.push(
        `the ${label} counter disagrees between health (${String(fromHealth)}) and the worker seam (${String(fromWorker)})`,
      );
    }
  }
  return reasons;
}

/** The deployment must surface its worker retry policy (guardrails). */
export function retryPolicySurfaceReasons(
  guardrails: GuardrailObservation,
): string[] {
  const reasons: string[] = [];
  if (guardrails.workerMaxAttempts === null || guardrails.workerMaxAttempts < 1) {
    reasons.push('the worker retry cap (workerMaxAttempts) is not surfaced');
  }
  if (guardrails.workerBatchLimit === null || guardrails.workerBatchLimit < 1) {
    reasons.push('the worker batch cap (workerBatchLimit) is not surfaced');
  }
  if (guardrails.workerPollIntervalMs === null || guardrails.workerPollIntervalMs < 1) {
    reasons.push('the worker poll interval is not surfaced');
  }
  return reasons;
}

/** A company-less session must be refused by chat with 409 no_active_company. */
export function chatGatedNoCompanyReasons(response: SmokeHttpResponse): string[] {
  const reasons: string[] = [];
  if (response.status !== 409) {
    reasons.push(`expected HTTP 409 before onboarding (got ${response.status})`);
    return reasons;
  }
  const body = isRecord(response.body) ? response.body : {};
  if (asString(body['error']) !== 'no_active_company') {
    reasons.push(`expected error 'no_active_company' (got '${asString(body['error']) ?? 'none'}')`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Routing (the middleware gate + page behavior)
// ---------------------------------------------------------------------------

/** An anonymous page hit must be gated to /signin with a next return path. */
export function anonymousGateReasons(
  response: SmokeHttpResponse,
  expectedNext: string,
): string[] {
  const reasons: string[] = [];
  if (response.status !== 307 && response.status !== 308) {
    reasons.push(`expected a 307/308 redirect (got ${response.status})`);
    return reasons;
  }
  if (response.location === null) {
    reasons.push('the redirect carries no Location header');
    return reasons;
  }
  const url = new URL(response.location);
  if (url.pathname !== '/signin') {
    reasons.push(`expected the redirect target /signin (got ${url.pathname})`);
  }
  if (url.searchParams.get('next') !== expectedNext) {
    reasons.push(`expected next=${expectedNext} (got '${url.searchParams.get('next') ?? ''}')`);
  }
  return reasons;
}

/** An authenticated root hit must route to /chat (chat is the primary root). */
export function authenticatedRootReasons(response: SmokeHttpResponse): string[] {
  const reasons: string[] = [];
  if (response.status !== 307 && response.status !== 308) {
    reasons.push(`expected a 307/308 redirect to /chat (got ${response.status})`);
    return reasons;
  }
  const url = response.location === null ? null : new URL(response.location);
  if (url === null || url.pathname !== '/chat') {
    reasons.push(`expected the redirect target /chat (got '${response.location ?? 'none'}')`);
  }
  return reasons;
}

/** A public page must render real HTML. */
export function pageRendersReasons(
  response: SmokeHttpResponse,
  options: { contains?: string } = {},
): string[] {
  const reasons: string[] = [];
  if (response.status !== 200) {
    reasons.push(`expected HTTP 200 (got ${response.status})`);
  }
  const contentType = response.headers['content-type'] ?? '';
  if (!contentType.includes('text/html')) {
    reasons.push(`expected text/html (got '${contentType}')`);
  }
  if (!response.text.trimStart().startsWith('<!DOCTYPE') && !response.text.trimStart().startsWith('<html')) {
    reasons.push('the body is not an HTML document');
  }
  if (options.contains !== undefined && !response.text.includes(options.contains)) {
    reasons.push(`the page does not mention '${options.contains}'`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Authentication / onboarding (the W058 auth API)
// ---------------------------------------------------------------------------

/** A sign-up/sign-in response: 200, session principal, session cookie. */
export function sessionIssuedReasons(response: SmokeHttpResponse): string[] {
  const reasons: string[] = [];
  if (response.status !== 200) {
    reasons.push(
      `expected HTTP 200 (got ${response.status}: ${clip(response.text, 160)})`,
    );
    return reasons;
  }
  const body = isRecord(response.body) ? response.body : {};
  const session = isRecord(body['session']) ? body['session'] : {};
  const principal = isRecord(session['principal']) ? session['principal'] : {};
  if (asString(principal['id']) === null) reasons.push('the session principal is absent');
  if (response.setCookies.length === 0) {
    reasons.push('no Set-Cookie header was issued');
  } else if (!response.setCookies.some((cookie) => cookie.startsWith('aurum_session='))) {
    reasons.push('the aurum_session cookie was not issued');
  } else if (
    !response.setCookies.some(
      (cookie) => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && cookie.includes('Path=/'),
    )
  ) {
    reasons.push('the session cookie is missing its HttpOnly/SameSite/Path flags');
  }
  return reasons;
}

/** The fresh session view: no active company yet (onboarding state). */
export function sessionNoCompanyReasons(response: SmokeHttpResponse): string[] {
  const reasons: string[] = [];
  if (response.status !== 200) {
    reasons.push(`expected HTTP 200 (got ${response.status})`);
    return reasons;
  }
  const body = isRecord(response.body) ? response.body : {};
  if (asString(body['status']) !== 'no-company') {
    reasons.push(`expected session status 'no-company' (got '${asString(body['status']) ?? 'none'}')`);
  }
  if (body['company'] !== null) reasons.push('company should be null before onboarding');
  return reasons;
}

/** Company creation: tenant + selected company in the session view. */
export function companyCreatedReasons(
  response: SmokeHttpResponse,
): { reasons: string[]; tenantId: string | null } {
  const reasons: string[] = [];
  if (response.status !== 200) {
    reasons.push(`expected HTTP 200 (got ${response.status}: ${clip(response.text, 160)})`);
    return { reasons, tenantId: null };
  }
  const body = isRecord(response.body) ? response.body : {};
  const tenant = isRecord(body['tenant']) ? body['tenant'] : {};
  const session = isRecord(body['session']) ? body['session'] : {};
  const company = isRecord(session['company']) ? session['company'] : {};
  const tenantId = asString(tenant['id']);
  if (tenantId === null) reasons.push('the created tenant is absent');
  if (asString(company['tenantId']) === null) {
    reasons.push('the session view does not show the selected company');
  }
  return { reasons, tenantId };
}

/** The unauthenticated session view must be an honest 401. */
export function anonymousSessionReasons(response: SmokeHttpResponse): string[] {
  const reasons: string[] = [];
  if (response.status !== 401) {
    reasons.push(`expected HTTP 401 after sign-out (got ${response.status})`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Chat (the W060/W072 surface)
// ---------------------------------------------------------------------------

/** The chat state: a conversations array (and an optional open thread). */
export function chatStateReasons(
  response: SmokeHttpResponse,
  options: { expectTitle?: string; expectThreadMessages?: number } = {},
): { reasons: string[]; conversationId: string | null } {
  const reasons: string[] = [];
  if (response.status !== 200) {
    reasons.push(`expected HTTP 200 (got ${response.status}: ${clip(response.text, 160)})`);
    return { reasons, conversationId: null };
  }
  const body = isRecord(response.body) ? response.body : {};
  const view = isRecord(body['view']) ? body['view'] : {};
  const conversations = asArray(view['conversations']);
  if (conversations === null) reasons.push('the chat state has no conversations array');
  let conversationId: string | null = null;
  if (options.expectTitle !== undefined) {
    const found = (conversations ?? []).find((entry) => {
      if (!isRecord(entry)) return false;
      return asString(entry['title']) === options.expectTitle;
    });
    if (found === undefined || !isRecord(found)) {
      reasons.push(`the seeded conversation '${options.expectTitle}' is not in the list`);
    } else {
      conversationId = asString(found['id']);
      if (conversationId === null) reasons.push('the seeded conversation has no id');
    }
  }
  const thread = isRecord(view['thread']) ? view['thread'] : null;
  if (options.expectThreadMessages !== undefined) {
    if (thread === null) {
      reasons.push('the thread is absent');
    } else {
      const messages = asArray(thread['messages']) ?? [];
      if (messages.length < options.expectThreadMessages) {
        reasons.push(
          `the thread has ${messages.length} messages (expected >= ${options.expectThreadMessages})`,
        );
      }
    }
  }
  return { reasons, conversationId };
}

/** A composer turn: inbound + reply + the durable execution behind it. */
export function chatTurnReasons(
  response: SmokeHttpResponse,
): { reasons: string[]; conversationId: string | null; executionId: string | null } {
  const reasons: string[] = [];
  if (response.status !== 200) {
    reasons.push(`expected HTTP 200 (got ${response.status}: ${clip(response.text, 160)})`);
    return { reasons, conversationId: null, executionId: null };
  }
  const body = isRecord(response.body) ? response.body : {};
  const inbound = isRecord(body['inbound']) ? body['inbound'] : {};
  const reply = isRecord(body['reply']) ? body['reply'] : {};
  const answer = isRecord(reply['answer']) ? reply['answer'] : {};
  const conversationId = asString(body['conversationId']);
  const executionId = asString(body['executionId']) ?? asString(answer['executionId']);
  if (asString(inbound['id']) === null) reasons.push('the inbound message view is absent');
  if (asString(reply['id']) === null) reasons.push('the reply message view is absent');
  if (conversationId === null) reasons.push('the turn carries no conversation id');
  if (executionId === null) {
    reasons.push('the turn carries no cognition execution id (durable execution unproven)');
  }
  return { reasons, conversationId, executionId };
}

/**
 * The attention turn must surface the seeded pending approval as a chat
 * card with a live decision affordance (W072 card contract).
 */
export function approvalCardReasons(
  response: SmokeHttpResponse,
): { reasons: string[]; requestId: string | null } {
  const reasons: string[] = [];
  if (response.status !== 200) {
    reasons.push(`expected HTTP 200 (got ${response.status}: ${clip(response.text, 160)})`);
    return { reasons, requestId: null };
  }
  const body = isRecord(response.body) ? response.body : {};
  const reply = isRecord(body['reply']) ? body['reply'] : {};
  const answer = isRecord(reply['answer']) ? reply['answer'] : {};
  const cards = asArray(answer['cards']) ?? [];
  const approval = cards.find((card) => {
    if (!isRecord(card)) return false;
    if (asString(card['kind']) !== 'approval') return false;
    const decision = isRecord(card['decision']) ? card['decision'] : {};
    return asString(decision['status']) === 'pending';
  });
  if (approval === undefined || !isRecord(approval)) {
    reasons.push('the reply carries no pending approval card');
    return { reasons, requestId: null };
  }
  const decision = isRecord(approval['decision']) ? approval['decision'] : {};
  const requestId = asString(decision['requestId']);
  if (requestId === null) reasons.push('the approval card has no requestId');
  return { reasons, requestId };
}

/** The inline decision: approved, and the timeline reflects it on re-read. */
export function approvalDecidedReasons(
  decideResponse: SmokeHttpResponse,
  stateResponse: SmokeHttpResponse,
  requestId: string,
): string[] {
  const reasons: string[] = [];
  if (decideResponse.status !== 200) {
    reasons.push(
      `expected HTTP 200 from the decision (got ${decideResponse.status}: ${clip(decideResponse.text, 160)})`,
    );
    return reasons;
  }
  const decided = isRecord(decideResponse.body) ? decideResponse.body : {};
  if (asString(decided['status']) !== 'approved') {
    reasons.push(`the decision response status is '${asString(decided['status']) ?? 'none'}'`);
  }
  // The timeline re-read: the card with this requestId must now show the
  // decision (refreshApprovalCards re-reads the authoritative request).
  if (stateResponse.status !== 200) {
    reasons.push(`expected HTTP 200 from the chat state re-read (got ${stateResponse.status})`);
    return reasons;
  }
  const body = isRecord(stateResponse.body) ? stateResponse.body : {};
  const view = isRecord(body['view']) ? body['view'] : {};
  const thread = isRecord(view['thread']) ? view['thread'] : {};
  const messages = asArray(thread['messages']) ?? [];
  let observed: string | null = null;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const answer = isRecord(message['answer']) ? message['answer'] : {};
    for (const card of asArray(answer['cards']) ?? []) {
      if (!isRecord(card)) continue;
      const decision = isRecord(card['decision']) ? card['decision'] : {};
      if (asString(decision['requestId']) === requestId) {
        observed = asString(decision['status']);
      }
    }
  }
  if (observed === null) {
    reasons.push('the decided approval card is no longer in the thread');
  } else if (observed !== 'approved') {
    reasons.push(`the timeline still shows the decision as '${observed}'`);
  }
  return reasons;
}

/** Quick sign-in availability must match the runtime family. */
export function quickSignInReasons(
  response: SmokeHttpResponse,
  expected: 'off' | 'on',
): string[] {
  const reasons: string[] = [];
  if (expected === 'off') {
    if (response.status !== 404) {
      reasons.push(`expected HTTP 404 not_available in this runtime (got ${response.status})`);
      return reasons;
    }
    const body = isRecord(response.body) ? response.body : {};
    if (asString(body['error']) !== 'not_available') {
      reasons.push(`expected error 'not_available' (got '${asString(body['error']) ?? 'none'}')`);
    }
  } else if (response.status === 404) {
    reasons.push('quick sign-in should be available in a development runtime');
  }
  return reasons;
}

/** The worker seam must refuse unauthenticated and bad-token calls. */
export function workerAuthFailClosedReasons(
  noToken: SmokeHttpResponse,
  badToken: SmokeHttpResponse,
): string[] {
  const reasons: string[] = [];
  if (noToken.status !== 401) {
    reasons.push(`expected HTTP 401 without a token (got ${noToken.status})`);
  } else {
    const body = isRecord(noToken.body) ? noToken.body : {};
    if (asString(body['error']) === null || !(asString(body['error']) ?? '').includes('token')) {
      reasons.push('the 401 does not explain the token requirement');
    }
  }
  if (badToken.status !== 401) {
    reasons.push(`expected HTTP 401 with a bad token (got ${badToken.status})`);
  }
  return reasons;
}
