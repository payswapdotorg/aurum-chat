// Integration tests for the edge-connector module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port, using an
// IN-MEMORY fake gateway+edge pair (the in-memory gateway client +
// the real edge runtime) — deterministic, no real network. Covers the
// W088 acceptance clause by clause:
//
// "outbound-only connection where possible; signed tenant-scoped jobs;
//  local secret handling; capability allowlist; health/version
//  reporting; result normalization; no second organizational truth
//  store."
//
//  * THE CLAIM PROTOCOL — submitted jobs stay 'pending' until the EDGE
//    calls in (nothing is pushed); one pollOnce claims, verifies,
//    executes locally, normalizes and reports; the audit trail reads
//    created → claimed → succeeded; the runtime scratch drains to zero;
//
//  * SIGNATURE TAMPER — a mutated claimed envelope is refused at the
//    edge with the machine-readable 'bad_signature' and flagged at the
//    gateway; a report bound to a foreign envelope digest is refused
//    loudly (envelope_mismatch) and the job is left untouched;
//
//  * TENANT ISOLATION — tenant B's edge cannot claim or even see
//    tenant A's jobs (indistinguishable from missing);
//
//  * ALLOWLIST — a job outside the registration's recorded allowlist is
//    never claimed; a job inside the recorded but OUTSIDE the edge's
//    LOCAL allowlist is refused at the edge AND flagged at the gateway
//    (defense in depth);
//
//  * IDEMPOTENT REPLAY — a replayed executed key returns the recorded
//    result and the executor runs EXACTLY ONCE; a failed job (no
//    external effect taken) re-drives through the same key;
//
//  * RESULT NORMALIZATION — a hostile edge reporting a provider object
//    is rejected loudly (invalid_edge_result) with the job untouched;
//
//  * HEALTH/VERSION — a silent edge renders 'stale'; a fresh heartbeat
//    renders 'healthy'; a diverged allowlist digest renders drift;
//
//  * SECRET HYGIENE (hostile probes) — a hostile executor echoing the
//    resolved secret is screened at the edge; a hostile report reason
//    carrying a secret is shape-rejected; the token value and every
//    credential value are ABSENT from all tables, events and errors;
//
//  * STORAGE DISCIPLINE — the audit ledgers are append-only and the
//    job/registration state machines are frozen where they must be.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { EdgeConnectorError } from '../errors';
import {
  allowlistDigestOf,
  claimEdgeJobs,
  createEdgeRuntime,
  createHmacSigner,
  createInMemoryGatewayClient,
  envelopeDigest,
  getEdgeJob,
  getEdgeRuntime,
  listEdgeAllowlistEvents,
  listEdgeJobEvents,
  listEdgeJobs,
  listEdgeRuntimes,
  listEdgeStatusEvents,
  registerEdgeRuntime,
  reportEdgeHeartbeat,
  reportEdgeJobResult,
  retireEdgeRuntime,
  setEdgeJobSigner,
  submitEdgeJob,
  updateEdgeAllowlist,
} from '../contract';
import type { EdgeJobExecutor, EdgeJobRequest } from '../contract';

// Test secrets are assembled from fragments at runtime (never a
// realistic full token literal in source — GitHub push protection).
const SIGNING_SECRET = ['edge-jobs-', 'hmac-', 'w088-', 'a1b2c3'].join('');
const EDGE_TOKEN = ['edge-', 'tok-', 'w088-', '7741'].join('');
const DB_SECRET = ['acme-', 'db-', 'pw-', '9f3Kzq'].join('');

const BASE_TIME = Date.parse('2026-09-24T12:00:00Z');
let clockMs = BASE_TIME;

const READ_CUSTOMERS = 'read.customer-records';
const WRITE_CUSTOMERS = 'write.customer-records';
const WRITE_TICKETS = 'write.support-desk';
const WRITE_INVENTORY = 'write.inventory';

// A FRESH tenant per test so counts stay deterministic.
function freshTenant(): string {
  return newId();
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectEdgeError(
  code: EdgeConnectorError['code'],
  fn: () => Promise<unknown>,
): Promise<EdgeConnectorError> {
  try {
    await fn();
    throw new Error(`expected EdgeConnectorError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof EdgeConnectorError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

function inspectRequest(idempotencyKey: string, credentialRef = 'edge-vault://acme/db-read'): EdgeJobRequest {
  return {
    connectionId: '2b7b8a44-6707-48c7-93c5-13ab1d5c0f22',
    credentialRef,
    systemKey: 'acme-onprem-crm',
    capabilityKey: READ_CUSTOMERS,
    target: 'cust-1042',
    idempotencyKey,
  };
}

function executeRequest(idempotencyKey: string, target = 'cust-1042'): EdgeJobRequest {
  return {
    connectionId: '2b7b8a44-6707-48c7-93c5-13ab1d5c0f22',
    credentialRef: 'edge-vault://acme/db-write',
    systemKey: 'acme-onprem-crm',
    capabilityKey: WRITE_CUSTOMERS,
    target,
    payload: { stage: 'onboarding-complete', healthScore: 82 },
    idempotencyKey,
  };
}

/**
 * The customer-side executor wiring for the tests: a canonical entity
 * store behind read/write capability keys, with scriptable hostile
 * modes (throw once, echo the resolved secret, return a provider
 * object).
 */
function createEntityExecutor(store: Map<string, unknown>): EdgeJobExecutor & {
  calls: number;
  failOnce: boolean;
  echoSecret: boolean;
} {
  const executor = {
    calls: 0,
    failOnce: false,
    echoSecret: false,
    async execute(input: Parameters<EdgeJobExecutor['execute']>[0]): Promise<unknown> {
      executor.calls += 1;
      const request = input.request as {
        connectionId: string;
        target: string;
        payload?: unknown;
        credentialRef?: string;
      };
      const key = `${request.connectionId}:${request.target}`;
      const credential = input.resolveCredential(request.credentialRef ?? '');
      if (credential === null) throw new Error('unknown credential ref');
      if (executor.echoSecret) {
        return { found: true, state: { leaked: credential } };
      }
      if (executor.failOnce) {
        executor.failOnce = false;
        throw new Error(`local connectivity blip while holding ${credential.length} characters of credential`);
      }
      if (input.kind === 'inspect') {
        const state = store.get(key);
        return { found: state !== undefined, state: state ?? null };
      }
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      const base =
        typeof store.get(key) === 'object' && store.get(key) !== null
          ? (store.get(key) as Record<string, unknown>)
          : {};
      store.set(key, { ...base, ...payload });
      return { status: 'accepted', receiptId: `edge-rcpt-${executor.calls.toString().padStart(4, '0')}`, detail: null };
    },
  };
  return executor;
}

/** Registers an edge + wires the runtime and the in-memory client. */
async function setupEdge(
  tenantId: string,
  options: {
    edgeKey?: string;
    allowlist?: string[];
    runtimeAllowlist?: string[];
    executors?: Record<string, EdgeJobExecutor>;
    secrets?: Record<string, string>;
  } = {},
) {
  const edgeKey = options.edgeKey ?? 'acme-onprem-edge';
  const allowlist = options.allowlist ?? [READ_CUSTOMERS, WRITE_CUSTOMERS];
  const { registration } = await registerEdgeRuntime(member(tenantId), {
    edgeKey,
    label: 'Acme on-prem edge',
    systemClass: 'database',
    version: '1.0.0',
    allowlist,
    edgeToken: EDGE_TOKEN,
  });
  const context = member(tenantId);
  const client = createInMemoryGatewayClient({ context, edgeKey, edgeToken: EDGE_TOKEN });
  const store = new Map<string, unknown>();
  const entityExecutor = createEntityExecutor(store);
  const executors = options.executors ?? {
    [READ_CUSTOMERS]: entityExecutor,
    [WRITE_CUSTOMERS]: entityExecutor,
  };
  const runtime = createEdgeRuntime({
    gateway: client,
    tenantId,
    edgeKey,
    version: '1.0.0',
    systemClass: 'database',
    allowlist: options.runtimeAllowlist ?? allowlist,
    verificationSecret: SIGNING_SECRET,
    secrets: options.secrets ?? {
      'edge-vault://acme/db-read': DB_SECRET,
      'edge-vault://acme/db-write': DB_SECRET,
    },
    executors,
    claimLimit: 8,
    leaseMs: 120_000,
    heartbeatIntervalMs: 30_000,
  });
  return { registration, context, client, runtime, store, entityExecutor, edgeKey };
}

/** Serializes every edge_* table (the secret-leak probe substrate). */
async function dumpAllEdgeTables(): Promise<string> {
  const tables = [
    'edge_registrations',
    'edge_allowlist_events',
    'edge_health_events',
    'edge_jobs',
    'edge_job_events',
  ];
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await getDb().query(`SELECT * FROM ${table}`);
    parts.push(JSON.stringify(rows.rows));
  }
  return parts.join('\n');
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  setEdgeJobSigner(createHmacSigner({ secret: SIGNING_SECRET, keyRef: 'edge-jobs/v1' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setEdgeJobSigner(null);
});

// ---------------------------------------------------------------------------
// The claim protocol (outbound-only)
// ---------------------------------------------------------------------------

describe('W088 claim protocol: outbound-only, signed jobs, normalized results', () => {
  it('keeps a submitted job pending until the EDGE calls in (nothing is pushed)', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:probe:1',
      request: inspectRequest('edge:probe:1'),
    });
    expect(submitted.created).toBe(true);
    expect(submitted.job.status).toBe('pending');
    expect(submitted.job.envelope.tenantId).toBe(tenant);
    expect(submitted.job.envelope.v).toBe(1);
    expect(submitted.job.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(submitted.job.signerKeyRef).toBe('edge-jobs/v1');
    // The gateway never reaches into the edge: no executor ran.
    expect(edge.entityExecutor.calls).toBe(0);
  });

  it('claims, verifies, executes locally, normalizes and reports in one edge cycle', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant, {
      secrets: {
        'edge-vault://acme/db-read': DB_SECRET,
        'edge-vault://acme/db-write': DB_SECRET,
      },
    });
    edge.store.set('2b7b8a44-6707-48c7-93c5-13ab1d5c0f22:cust-1042', {
      stage: 'onboarding',
      healthScore: 55,
    });

    const read = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:happy:read',
      request: inspectRequest('edge:happy:read'),
    });
    const write = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:happy:write',
      request: executeRequest('edge:happy:write'),
    });

    // The edge initiates: one claim cycle takes both jobs.
    await edge.runtime.pollOnce();

    const readJob = await getEdgeJob(edge.context, { jobId: read.job.id });
    expect(readJob.status).toBe('succeeded');
    expect(readJob.result).toEqual({
      found: true,
      state: { stage: 'onboarding', healthScore: 55 },
    });

    const writeJob = await getEdgeJob(edge.context, { jobId: write.job.id });
    expect(writeJob.status).toBe('succeeded');
    expect(writeJob.result).toEqual({
      status: 'accepted',
      receiptId: 'edge-rcpt-0002',
      detail: null,
    });
    // The private system now holds the canonical write.
    expect(edge.store.get('2b7b8a44-6707-48c7-93c5-13ab1d5c0f22:cust-1042')).toMatchObject({
      stage: 'onboarding-complete',
      healthScore: 82,
    });

    // The audit trail: created → claimed → succeeded (position-ordered).
    const events = await listEdgeJobEvents(edge.context, { jobId: write.job.id, limit: 50 });
    const sequence = events.events.map((entry) => entry.event).reverse();
    expect(sequence).toEqual(['created', 'claimed', 'succeeded']);

    // No second truth store: the runtime scratch drained to zero.
    expect(edge.runtime.scratch).toHaveLength(0);

    // Health/version reporting happened with the cycle (heartbeat).
    const view = await getEdgeRuntime(edge.context, { edgeKey: edge.edgeKey });
    expect(view.registration.health.status).toBe('healthy');
    expect(view.registration.health.reportedVersion).toBe('1.0.0');
    expect(view.registration.health.allowlistDrift).toBe(false);
    expect(view.registration.health.lastSeenAt).not.toBeNull();
    // Gateway-measured counters.
    expect(view.registration.stats.jobsClaimed).toBe(2);
    expect(view.registration.stats.jobsSucceeded).toBe(2);
    expect(view.registration.stats.jobsFailed).toBe(0);
    expect(view.registration.stats.jobsRefused).toBe(0);
    // The status events ledger carries the heartbeat evidence — and the
    // heartbeat AFTER processing carries the last-job stats.
    await edge.runtime.heartbeatOnce();
    const status = await listEdgeStatusEvents(edge.context, { edgeId: edge.registration.id, limit: 10 });
    expect(status.events.map((entry) => entry.event)).toContain('heartbeat');
    expect(status.events[0]!.event).toBe('heartbeat');
    expect(status.events[0]!.stats).toMatchObject({ jobsClaimed: 2, jobsSucceeded: 2 });
    expect(status.events[0]!.stats!.lastJobAt).not.toBeNull();
  });

  it('scopes the claim by the recorded allowlist and verifies the edge token', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant, { allowlist: [READ_CUSTOMERS, WRITE_CUSTOMERS] });
    await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_INVENTORY, // outside the recorded allowlist
      idempotencyKey: 'edge:scope:1',
      request: {
        connectionId: '2b7b8a44-6707-48c7-93c5-13ab1d5c0f22',
        credentialRef: 'edge-vault://acme/inv-write',
        systemKey: 'acme-onprem-erp',
        capabilityKey: WRITE_INVENTORY,
        target: 'item-9',
        payload: { qty: 4 },
        idempotencyKey: 'edge:scope:1',
      },
    });
    const claim = await claimEdgeJobs(edge.context, {
      edgeKey: edge.edgeKey,
      edgeToken: EDGE_TOKEN,
    });
    expect(claim.jobs).toHaveLength(0);
    const feed = await listEdgeJobs(edge.context, {});
    expect(feed.jobs[0]!.status).toBe('pending'); // never claimed, never executed

    // A wrong token cannot claim at all.
    await expectEdgeError('edge_token_invalid', () =>
      claimEdgeJobs(edge.context, {
        edgeKey: edge.edgeKey,
        edgeToken: ['edge-', 'tok-', 'WRONG'].join(''),
      }),
    );
    expect((await listEdgeJobs(edge.context, {})).jobs[0]!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Signed jobs: tamper + replay rejection
// ---------------------------------------------------------------------------

describe('W088 signed jobs: signature tamper and envelope binding', () => {
  it('refuses a tampered envelope at the edge and flags it loudly at the gateway', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:tamper:1',
      request: executeRequest('edge:tamper:1'),
    });

    // Claim, then tamper with the signed envelope between claim and
    // execution (the hostile middleman: field swap + payload rewrite).
    const claim = await claimEdgeJobs(edge.context, { edgeKey: edge.edgeKey, edgeToken: EDGE_TOKEN });
    expect(claim.jobs).toHaveLength(1);
    const tampered = claim.jobs[0]!;
    tampered.envelope.capabilityKey = WRITE_TICKETS; // field swap
    tampered.envelope.request = executeRequest('edge:tamper:1', 'cust-9999');

    // The edge verifies FIRST: the executor never runs, and the report
    // of the tampered envelope is refused loudly at the gateway
    // (envelope_mismatch — the executed envelope is not the one the
    // gateway signed). The job is left 'claimed', untouched.
    await expectEdgeError('envelope_mismatch', () => edge.runtime.processSignedJob(tampered));
    expect(edge.entityExecutor.calls).toBe(0);
    const job = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(job.status).toBe('claimed');
    expect(job.result).toBeNull();
    expect(job.envelope.capabilityKey).toBe(WRITE_CUSTOMERS); // the stored contract is intact

    // The claim lease expires (a crashed/hijacked claim ages out) and the
    // job reverts to pending — tamper attempts lose nothing.
    clockMs += 120_001;
    const reclaim = await claimEdgeJobs(edge.context, { edgeKey: edge.edgeKey, edgeToken: EDGE_TOKEN });
    expect(reclaim.reclaimedJobIds).toEqual([submitted.job.id]);
    const events = await listEdgeJobEvents(edge.context, { jobId: submitted.job.id, limit: 50 });
    expect(events.events.map((entry) => entry.event)).toContain('reclaimed');
  });

  it('refuses a report bound to a foreign envelope digest (envelope_mismatch)', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:mismatch:1',
      request: inspectRequest('edge:mismatch:1'),
    });
    const claim = await claimEdgeJobs(edge.context, { edgeKey: edge.edgeKey, edgeToken: EDGE_TOKEN });
    expect(claim.jobs).toHaveLength(1);

    const foreignDigest = envelopeDigest({
      ...claim.jobs[0]!.envelope,
      capabilityKey: WRITE_TICKETS,
    });
    const error = await expectEdgeError('envelope_mismatch', () =>
      reportEdgeJobResult(edge.context, {
        edgeKey: edge.edgeKey,
        edgeToken: EDGE_TOKEN,
        jobId: submitted.job.id,
        executedEnvelopeDigest: foreignDigest,
        outcome: { kind: 'result', result: { found: true, state: { forged: true } } },
      }),
    );
    // Nothing leaked into the error and the job is untouched.
    expect(error.message).not.toContain(DB_SECRET);
    const job = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(job.status).toBe('claimed');
    expect(job.result).toBeNull();
  });

  it('refuses to submit without a wired signer (never a fake unsigned job)', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    setEdgeJobSigner(null);
    await expectEdgeError('signer_unavailable', () =>
      submitEdgeJob(edge.context, {
        edgeKey: edge.edgeKey,
        kind: 'inspect',
        capabilityKey: READ_CUSTOMERS,
        idempotencyKey: 'edge:unsigned:1',
        request: inspectRequest('edge:unsigned:1'),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('W088 tenant scope isolation', () => {
  it("tenant B's edge cannot claim or even see tenant A's jobs", async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const edgeA = await setupEdge(tenantA, { edgeKey: 'acme-onprem-edge' });
    const edgeB = await setupEdge(tenantB, { edgeKey: 'acme-onprem-edge' }); // same key, other tenant

    const submitted = await submitEdgeJob(edgeA.context, {
      edgeKey: 'acme-onprem-edge',
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:iso:1',
      request: executeRequest('edge:iso:1'),
    });

    // B claims: nothing (its own tenant scope is empty).
    const claimB = await claimEdgeJobs(edgeB.context, {
      edgeKey: 'acme-onprem-edge',
      edgeToken: EDGE_TOKEN,
    });
    expect(claimB.jobs).toHaveLength(0);

    // B's edge runtime cycle: its executor never runs for A's job.
    await edgeB.runtime.pollOnce();
    expect(edgeB.entityExecutor.calls).toBe(0);

    // B cannot read A's job — indistinguishable from missing.
    await expectEdgeError('job_not_found', () =>
      getEdgeJob(edgeB.context, { jobId: submitted.job.id }),
    );
    const feedB = await listEdgeJobs(edgeB.context, {});
    expect(feedB.jobs).toHaveLength(0);

    // A's job is untouched.
    const jobA = await getEdgeJob(edgeA.context, { jobId: submitted.job.id });
    expect(jobA.status).toBe('pending');
    expect(jobA.tenantId).toBe(tenantA);

    // B cannot report on A's job either — its existence never leaks
    // (the job is indistinguishable from missing in B's scope).
    await expectEdgeError('job_not_found', () =>
      reportEdgeJobResult(edgeB.context, {
        edgeKey: 'acme-onprem-edge',
        edgeToken: EDGE_TOKEN,
        jobId: submitted.job.id,
        executedEnvelopeDigest: submitted.job.envelopeDigest,
        outcome: { kind: 'result', result: { found: true, state: { forged: true } } },
      }),
    );

    // The same idempotency key in tenant B is B's OWN job (keys are
    // tenant-scoped — no existence leak through conflicts).
    const submittedB = await submitEdgeJob(edgeB.context, {
      edgeKey: 'acme-onprem-edge',
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:iso:1',
      request: executeRequest('edge:iso:1'),
    });
    expect(submittedB.created).toBe(true);
    expect(submittedB.job.id).not.toBe(submitted.job.id);
  });
});

// ---------------------------------------------------------------------------
// The capability allowlist (edge-side re-check = defense in depth)
// ---------------------------------------------------------------------------

describe('W088 capability allowlist', () => {
  it('refuses a job at the edge when the local allowlist is narrower, and flags it', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant, {
      allowlist: [READ_CUSTOMERS, WRITE_CUSTOMERS, WRITE_TICKETS],
      runtimeAllowlist: [READ_CUSTOMERS, WRITE_CUSTOMERS], // the edge's OWN list is narrower
    });
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_TICKETS,
      idempotencyKey: 'edge:allow:1',
      request: {
        connectionId: '2b7b8a44-6707-48c7-93c5-13ab1d5c0f22',
        credentialRef: 'edge-vault://acme/desk-write',
        systemKey: 'acme-onprem-desk',
        capabilityKey: WRITE_TICKETS,
        target: 'tick-9001',
        payload: { status: 'resolved' },
        idempotencyKey: 'edge:allow:1',
      },
    });

    // The gateway's RECORDED allowlist admits the claim…
    const claim = await claimEdgeJobs(edge.context, { edgeKey: edge.edgeKey, edgeToken: EDGE_TOKEN });
    expect(claim.jobs).toHaveLength(1);
    // …but the edge's OWN re-check refuses before executing.
    await edge.runtime.processSignedJob(claim.jobs[0]!);

    const job = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(job.status).toBe('refused');
    expect(job.refusalReason).toBe('capability_not_allowed');
    expect(edge.entityExecutor.calls).toBe(0);
    const view = await getEdgeRuntime(edge.context, { edgeKey: edge.edgeKey });
    expect(view.registration.stats.jobsRefused).toBe(1);
    const events = await listEdgeJobEvents(edge.context, { jobId: submitted.job.id, limit: 10 });
    expect(events.events.map((entry) => entry.event)).toContain('refused');
  });

  it('audits allowlist changes append-only and moves the digest', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const before = await getEdgeRuntime(edge.context, { edgeKey: edge.edgeKey });
    const updated = await updateEdgeAllowlist(edge.context, {
      edgeId: edge.registration.id,
      add: [WRITE_INVENTORY],
      remove: [],
      note: 'plant-2 MES went live',
    });
    expect(updated.registration.allowlist).toEqual([READ_CUSTOMERS, WRITE_CUSTOMERS, WRITE_INVENTORY]);
    expect(updated.registration.allowlistDigest).not.toBe(before.registration.allowlistDigest);
    expect(updated.registration.allowlistDigest).toBe(
      allowlistDigestOf([READ_CUSTOMERS, WRITE_CUSTOMERS, WRITE_INVENTORY]),
    );

    const audit = await listEdgeAllowlistEvents(edge.context, { edgeId: edge.registration.id, limit: 50 });
    const added = audit.events.filter((entry) => entry.change === 'added');
    expect(added.map((entry) => entry.capabilityKey).sort()).toEqual(
      [READ_CUSTOMERS, WRITE_CUSTOMERS, WRITE_INVENTORY].sort(),
    );
    // Newest first (the seq discipline): the audited change carries its note.
    expect(added[0]!.note).toBe('plant-2 MES went live');

    const status = await listEdgeStatusEvents(edge.context, { edgeId: edge.registration.id, limit: 50 });
    expect(status.events.map((entry) => entry.event)).toContain('allowlist-changed');

    // The initial registration keys are audited too.
    const initial = audit.events.filter((entry) => entry.note === 'initial registration');
    expect(initial).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: replay returns the recorded result, never a second effect
// ---------------------------------------------------------------------------

describe('W088 idempotent jobs', () => {
  it('replays the recorded result and runs the executor EXACTLY ONCE', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const first = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:replay:1',
      request: executeRequest('edge:replay:1'),
    });
    await edge.runtime.pollOnce();
    const done = await getEdgeJob(edge.context, { jobId: first.job.id });
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ status: 'accepted' });
    expect(edge.entityExecutor.calls).toBe(1);

    // Replay of the executed key: the recorded result, no new job, no
    // second external effect.
    const replay = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:replay:1',
      request: executeRequest('edge:replay:1'),
    });
    expect(replay.created).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.job.id).toBe(first.job.id);
    expect(replay.job.result).toEqual(done.result);
    expect(edge.entityExecutor.calls).toBe(1);

    // A terminal report replay also returns the recorded outcome.
    const reported = await reportEdgeJobResult(edge.context, {
      edgeKey: edge.edgeKey,
      edgeToken: EDGE_TOKEN,
      jobId: first.job.id,
      executedEnvelopeDigest: first.job.envelopeDigest,
      outcome: { kind: 'result', result: { status: 'accepted', receiptId: 'forged', detail: null } },
    });
    expect(reported.replayed).toBe(true);
    expect(reported.job.result).toEqual(done.result);
    expect(edge.entityExecutor.calls).toBe(1); // STILL once

    // The replays are audited.
    const events = await listEdgeJobEvents(edge.context, { jobId: first.job.id, limit: 50 });
    const replays = events.events.filter((entry) => entry.event === 'replayed');
    expect(replays.length).toBe(2);
  });

  it('re-drives a failed job through the same key (no external effect was taken)', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    edge.entityExecutor.failOnce = true; // throws BEFORE any effect

    const first = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:redrive:1',
      request: executeRequest('edge:redrive:1'),
    });
    await edge.runtime.pollOnce();
    const failed = await getEdgeJob(edge.context, { jobId: first.job.id });
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('executor_error');
    expect(failed.result).toBeNull();
    // No external effect was taken by the failed attempt — asserted NOW,
    // before the re-drive runs.
    expect(edge.store.has('2b7b8a44-6707-48c7-93c5-13ab1d5c0f22:cust-1042')).toBe(false);

    // The re-drive: the same key re-enters pending, then succeeds.
    const redrive = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:redrive:1',
      request: executeRequest('edge:redrive:1'),
    });
    expect(redrive.created).toBe(false);
    expect(redrive.replayed).toBe(false);
    expect(redrive.job.status).toBe('pending');
    await edge.runtime.pollOnce();
    const done = await getEdgeJob(edge.context, { jobId: first.job.id });
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ status: 'accepted' });
    expect(edge.entityExecutor.calls).toBe(2); // two ATTEMPTS…
    expect(edge.store.get('2b7b8a44-6707-48c7-93c5-13ab1d5c0f22:cust-1042')).toMatchObject({
      stage: 'onboarding-complete',
    }); // …but the effect landed exactly once

    const events = await listEdgeJobEvents(edge.context, { jobId: first.job.id, limit: 50 });
    const sequence = events.events.map((entry) => entry.event).reverse();
    expect(sequence).toEqual(['created', 'claimed', 'failed', 'redriven', 'claimed', 'succeeded']);
  });

  it('records a transient failed receipt as a re-drivable failure', async () => {
    const tenant = freshTenant();
    let attempts = 0;
    const edge = await setupEdge(tenant, {
      executors: {
        [WRITE_CUSTOMERS]: {
          async execute() {
            attempts += 1;
            if (attempts === 1) {
              return { status: 'failed', receiptId: null, detail: 'upstream timeout — transient' };
            }
            return { status: 'accepted', receiptId: 'edge-rcpt-0002', detail: null };
          },
        },
      },
    });
    const first = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:transient:1',
      request: executeRequest('edge:transient:1'),
    });
    await edge.runtime.pollOnce();
    const parked = await getEdgeJob(edge.context, { jobId: first.job.id });
    expect(parked.status).toBe('failed');
    expect(parked.failureReason).toBe('transient-receipt-failure');
    expect(parked.result).toEqual({ status: 'failed', receiptId: null, detail: 'upstream timeout — transient' });

    // The re-drive succeeds; the SECOND attempt's receipt is recorded.
    await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'execute',
      capabilityKey: WRITE_CUSTOMERS,
      idempotencyKey: 'edge:transient:1',
      request: executeRequest('edge:transient:1'),
    });
    await edge.runtime.pollOnce();
    const done = await getEdgeJob(edge.context, { jobId: first.job.id });
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ status: 'accepted', receiptId: 'edge-rcpt-0002' });
  });
});

// ---------------------------------------------------------------------------
// Result normalization at the gateway boundary
// ---------------------------------------------------------------------------

describe('W088 result normalization (provider objects never cross)', () => {
  it('rejects a hostile provider-object report loudly and leaves the job untouched', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:noncanon:1',
      request: inspectRequest('edge:noncanon:1'),
    });
    await claimEdgeJobs(edge.context, { edgeKey: edge.edgeKey, edgeToken: EDGE_TOKEN });

    // A HOSTILE edge bypassing the runtime, reporting a provider object.
    await expectEdgeError('invalid_edge_result', () =>
      reportEdgeJobResult(edge.context, {
        edgeKey: edge.edgeKey,
        edgeToken: EDGE_TOKEN,
        jobId: submitted.job.id,
        executedEnvelopeDigest: submitted.job.envelopeDigest,
        outcome: { kind: 'result', result: { found: true, state: new Date() } },
      }),
    );
    const job = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(job.status).toBe('claimed'); // untouched
    expect(job.result).toBeNull();

    // The runtime's own screen also refuses provider-shaped results.
    const hostile = await setupEdge(tenant, {
      edgeKey: 'acme-hostile-edge',
      executors: {
        [READ_CUSTOMERS]: {
          async execute() {
            return { found: true, state: new Map([['k', 'v']]) }; // provider-shaped
          },
        },
      },
    });
    const hostileJob = await submitEdgeJob(hostile.context, {
      edgeKey: 'acme-hostile-edge',
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:noncanon:2',
      request: inspectRequest('edge:noncanon:2'),
    });
    await hostile.runtime.pollOnce();
    const refused = await getEdgeJob(hostile.context, { jobId: hostileJob.job.id });
    expect(refused.status).toBe('failed');
    expect(refused.failureReason).toBe('invalid_result');
  });
});

// ---------------------------------------------------------------------------
// Health/version reporting (honest staleness rendering)
// ---------------------------------------------------------------------------

describe('W088 health and version reporting', () => {
  it("renders a silent edge 'stale', a fresh one 'healthy', and drift honestly", async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant, {
      allowlist: [READ_CUSTOMERS, WRITE_CUSTOMERS],
      runtimeAllowlist: [READ_CUSTOMERS], // diverged from the record
    });

    // Never heartbeat-ed: stale, honestly.
    const silent = await getEdgeRuntime(edge.context, { edgeKey: edge.edgeKey });
    expect(silent.registration.health.status).toBe('stale');
    expect(silent.registration.health.lastSeenAt).toBeNull();
    expect(silent.registration.health.allowlistDrift).toBe(false); // nothing reported yet

    // A heartbeat brings it healthy — and reports the drift.
    await edge.runtime.heartbeatOnce();
    const fresh = await getEdgeRuntime(edge.context, { edgeKey: edge.edgeKey });
    expect(fresh.registration.health.status).toBe('healthy');
    expect(fresh.registration.health.reportedVersion).toBe('1.0.0');
    expect(fresh.registration.health.reportedAllowlistDigest).toBe(allowlistDigestOf([READ_CUSTOMERS]));
    expect(fresh.registration.health.allowlistDrift).toBe(true); // diverged — flagged, never trusted

    // Silence beyond the window: stale again (the honest rendering).
    clockMs += 120_001;
    const stale = await getEdgeRuntime(edge.context, { edgeKey: edge.edgeKey });
    expect(stale.registration.health.status).toBe('stale');
    expect(stale.registration.health.allowlistDrift).toBe(true);

    // The heartbeat evidence is append-only status events.
    const status = await listEdgeStatusEvents(edge.context, { edgeId: edge.registration.id, limit: 10 });
    expect(status.events[0]!.event).toBe('heartbeat');
    expect(status.events[0]!.version).toBe('1.0.0');
    expect(status.events[0]!.allowlistDigest).toBe(allowlistDigestOf([READ_CUSTOMERS]));
    expect(status.events[0]!.stats).toMatchObject({ jobsClaimed: 0, jobsSucceeded: 0 });
  });

  it('retires an edge: claims and submissions refuse, evidence remains', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const retired = await retireEdgeRuntime(edge.context, { edgeId: edge.registration.id });
    expect(retired.registration.status).toBe('retired');

    await expectEdgeError('edge_retired', () =>
      claimEdgeJobs(edge.context, { edgeKey: edge.edgeKey, edgeToken: EDGE_TOKEN }),
    );
    await expectEdgeError('edge_retired', () =>
      submitEdgeJob(edge.context, {
        edgeKey: edge.edgeKey,
        kind: 'inspect',
        capabilityKey: READ_CUSTOMERS,
        idempotencyKey: 'edge:retired:1',
        request: inspectRequest('edge:retired:1'),
      }),
    );
    await expectEdgeError('edge_retired', () =>
      reportEdgeHeartbeat(edge.context, {
        edgeKey: edge.edgeKey,
        edgeToken: EDGE_TOKEN,
        version: '1.0.0',
        allowlistDigest: allowlistDigestOf([READ_CUSTOMERS, WRITE_CUSTOMERS]),
        stats: { jobsClaimed: 0, jobsSucceeded: 0, jobsFailed: 0, jobsRefused: 0, lastJobAt: null },
      }),
    );
    const status = await listEdgeStatusEvents(edge.context, { edgeId: edge.registration.id, limit: 10 });
    expect(status.events.map((entry) => entry.event)).toContain('retired');
  });
});

// ---------------------------------------------------------------------------
// Lease discipline (bounded, expiring scratch — the reclaim path)
// ---------------------------------------------------------------------------

describe('W088 claim leases', () => {
  it('reverts an expired claim to pending and re-claims it (auditable)', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:lease:1',
      request: inspectRequest('edge:lease:1'),
    });

    const first = await claimEdgeJobs(edge.context, {
      edgeKey: edge.edgeKey,
      edgeToken: EDGE_TOKEN,
      leaseMs: 60_000,
    });
    expect(first.jobs).toHaveLength(1);
    const claimed = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(claimed.status).toBe('claimed');
    expect(claimed.attempts).toBe(1);
    expect(claimed.leaseExpiresAt).not.toBeNull();

    clockMs += 60_001; // the lease expires (a crashed edge's scratch ages out)

    const second = await claimEdgeJobs(edge.context, {
      edgeKey: edge.edgeKey,
      edgeToken: EDGE_TOKEN,
    });
    expect(second.reclaimedJobIds).toEqual([submitted.job.id]);
    expect(second.jobs).toHaveLength(1); // re-claimed
    const reclaimed = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(reclaimed.status).toBe('claimed');
    expect(reclaimed.attempts).toBe(2);

    const events = await listEdgeJobEvents(edge.context, { jobId: submitted.job.id, limit: 50 });
    const sequence = events.events.map((entry) => entry.event).reverse();
    expect(sequence).toEqual(['created', 'claimed', 'reclaimed', 'claimed']);
  });
});

// ---------------------------------------------------------------------------
// Local secret handling (hostile probes)
// ---------------------------------------------------------------------------

describe('W088 local secret handling (hostile probes)', () => {
  it('screens an executor that echoes the resolved secret — the value never crosses', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    edge.entityExecutor.echoSecret = true; // the hostile executor

    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:leak:1',
      request: inspectRequest('edge:leak:1'),
    });
    await edge.runtime.pollOnce();

    const job = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(job.status).toBe('failed');
    expect(job.failureReason).toBe('secret_leak_detected');
    expect(job.result).toBeNull();

    // THE PROBE: no secret VALUE in ANY table.
    const dump = await dumpAllEdgeTables();
    expect(dump).not.toContain(DB_SECRET);
    expect(dump).not.toContain(EDGE_TOKEN);
    // The job's envelope carried only the opaque credentialRef.
    expect(JSON.stringify(job.envelope)).toContain('edge-vault://acme/db-read');
    expect(JSON.stringify(job.envelope)).not.toContain(DB_SECRET);
  });

  it('shape-rejects a hostile report reason carrying a secret value', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:leak:2',
      request: inspectRequest('edge:leak:2'),
    });
    await claimEdgeJobs(edge.context, { edgeKey: edge.edgeKey, edgeToken: EDGE_TOKEN });
    const error = await expectEdgeError('invalid_input', () =>
      reportEdgeJobResult(edge.context, {
        edgeKey: edge.edgeKey,
        edgeToken: EDGE_TOKEN,
        jobId: submitted.job.id,
        executedEnvelopeDigest: submitted.job.envelopeDigest,
        outcome: { kind: 'failed', reason: `password is ${DB_SECRET}` },
      }),
    );
    expect(error.message).not.toContain(DB_SECRET);
    const dump = await dumpAllEdgeTables();
    expect(dump).not.toContain(DB_SECRET);
  });

  it('keeps the edge token out of every table (only its digest is stored)', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:token:1',
      request: inspectRequest('edge:token:1'),
    });
    await edge.runtime.pollOnce();
    const dump = await dumpAllEdgeTables();
    expect(dump).not.toContain(EDGE_TOKEN);
    expect(dump).toContain(edge.registration.allowlistDigest); // digests ARE stored
  });

  it('keeps an unknown credential reference an honest local failure', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:unknown:1',
      request: inspectRequest('edge:unknown:1', 'edge-vault://acme/UNKNOWN'),
    });
    await edge.runtime.pollOnce();
    const job = await getEdgeJob(edge.context, { jobId: submitted.job.id });
    expect(job.status).toBe('failed');
    expect(job.failureReason).toBe('executor_error');
    const dump = await dumpAllEdgeTables();
    expect(dump).not.toContain(DB_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (append-only evidence, frozen state machines)
// ---------------------------------------------------------------------------

describe('W088 storage discipline', () => {
  it('refuses UPDATE/DELETE/TRUNCATE on the append-only ledgers', async () => {
    const tenant = freshTenant();
    const edge = await setupEdge(tenant);
    const submitted = await submitEdgeJob(edge.context, {
      edgeKey: edge.edgeKey,
      kind: 'inspect',
      capabilityKey: READ_CUSTOMERS,
      idempotencyKey: 'edge:storage:1',
      request: inspectRequest('edge:storage:1'),
    });
    await edge.runtime.pollOnce();
    await edge.runtime.heartbeatOnce();

    await expect(getDb().query(`UPDATE edge_job_events SET detail = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(getDb().query(`UPDATE edge_health_events SET detail = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      getDb().query(`UPDATE edge_allowlist_events SET note = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM edge_job_events`)).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE edge_health_events`)).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE edge_allowlist_events`)).rejects.toThrow(/append-only/);

    // Jobs are durable history: no DELETE/TRUNCATE, and the frozen
    // contract columns never move.
    await expect(getDb().query(`DELETE FROM edge_jobs`)).rejects.toThrow(/durable history/);
    await expect(getDb().query(`TRUNCATE edge_jobs`)).rejects.toThrow(/durable history/);
    await expect(
      getDb().query(`UPDATE edge_jobs SET envelope = '{"v":2}'::jsonb, signature = '${'0'.repeat(64)}' WHERE id = $1`, [
        submitted.job.id,
      ]),
    ).rejects.toThrow(/durable history/);

    // Registrations: identity columns frozen; DELETE forbidden.
    await expect(
      getDb().query(`UPDATE edge_registrations SET edge_key = 'tampered-edge'`),
    ).rejects.toThrow(/audit trail/);
    await expect(
      getDb().query(`UPDATE edge_registrations SET token_digest = '${'0'.repeat(64)}'`),
    ).rejects.toThrow(/audit trail/);
    await expect(getDb().query(`DELETE FROM edge_registrations`)).rejects.toThrow(/audit trail/);
  });
});

// ---------------------------------------------------------------------------
// The registration lifecycle discipline
// ---------------------------------------------------------------------------

describe('W088 registration discipline', () => {
  it('refuses a duplicate (tenant, edgeKey) loudly', async () => {
    const tenant = freshTenant();
    await setupEdge(tenant, { edgeKey: 'acme-onprem-edge' });
    await expectEdgeError('edge_conflict', () =>
      registerEdgeRuntime(member(tenant), {
        edgeKey: 'acme-onprem-edge',
        label: 'Impostor',
        systemClass: 'api',
        version: '9.9.9',
        allowlist: [READ_CUSTOMERS],
        edgeToken: EDGE_TOKEN,
      }),
    );
  });

  it('lists edges with their health views', async () => {
    const tenant = freshTenant();
    await setupEdge(tenant, { edgeKey: 'acme-onprem-edge' });
    await setupEdge(tenant, { edgeKey: 'acme-plant2-edge' });
    const feed = await listEdgeRuntimes(member(tenant), {});
    expect(feed.edges.map((entry) => entry.edgeKey).sort()).toEqual([
      'acme-onprem-edge',
      'acme-plant2-edge',
    ]);
    for (const entry of feed.edges) {
      expect(entry.health.status).toBe('stale'); // silent until a heartbeat
    }
  });
});
