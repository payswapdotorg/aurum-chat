// End-to-end tests of the W088 EDGE-DISPATCH TRANSPORT: the deep-actions
// gateway pipeline (W084's discover→inspect→propose→authorize→execute→
// verify→reconcile) driven THROUGH the edge connector — the canonical
// reads/writes become SIGNED edge jobs, the customer-controlled edge
// runtime claims them over the outbound-only protocol, executes against
// its local (fake) private systems, normalizes results into the
// canonical deep-action shapes and reports back; the transport adapter
// (wired via setDeepActionTransport) hands the pipeline its states and
// receipts.
//
// This is the W088↔W084 composition proof: the gateway pipeline works
// end-to-end against an edge, with provider objects never crossing the
// seam, and the deep-actions resume semantics (a transient failed
// receipt parks the task 'failed'; the retry re-drives the SAME
// idempotency key and succeeds) riding the edge program's re-drive.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as actionsContract from '@/modules/actions/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as sourcesContract from '@/modules/sources/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as grantsContract from '@/modules/capability-grants/contract';
import { runMigrations } from '../../../../scripts/migrate';
import * as deepActions from '@/modules/deep-actions/contract';
import {
  createEdgeDispatchTransport,
  createEdgeRuntime,
  createHmacSigner,
  createInMemoryGatewayClient,
  listEdgeJobs,
  registerEdgeRuntime,
  setEdgeJobSigner,
} from '../contract';
import type { EdgeJobExecutor } from '../contract';

const { decideApproval } = actionsContract;
const { grantDiscoverySource, listSystems, runDiscovery } = integrationContract;
const { registerSource, setSourceTransport } = sourcesContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;
const { decideGrantRequest, establishConnectionAccess, requestCapabilityAuthority } =
  grantsContract;
const {
  createDeepAction,
  discoverExecutionSurface,
  inspectTargets,
  proposeDeepAction,
  authorizeDeepAction,
  executeDeepAction,
  verifyDeepAction,
  reconcileDeepAction,
  listDeepActionEvents,
  setDeepActionTransport,
} = deepActions;

// Test secrets are assembled from fragments at runtime (never a
// realistic full token literal in source — GitHub push protection).
const SIGNING_SECRET = ['edge-jobs-', 'hmac-', 'w088-', 'e2e'].join('');
const EDGE_TOKEN = ['edge-', 'tok-', 'w088-', 'e2e1'].join('');

const BASE_TIME = Date.parse('2026-09-24T12:00:00Z');
let clockMs = BASE_TIME;

const TASK_CONTEXT = {
  description: 'Close out the Q3 renewals after the signed contracts landed',
  requestedFor: 'Q3 close',
};
const WRITE_CUSTOMERS = 'write.customer-records';
const WRITE_TICKETS = 'write.support-desk';
const READ_CUSTOMERS = 'read.customer-records';
const READ_TICKETS = 'read.support-desk';

function freshTenant(): string {
  return newId();
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

function integrationAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['integration-intelligence:administer'] };
}

function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w088/` + `${label}/` + 'ref';
}

// ---------------------------------------------------------------------------
// The W081→W082 fixture (the deep-actions test discipline, verbatim)
// ---------------------------------------------------------------------------

/** A provider-neutral source transport that serves scripted windows. */
class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  private windows: sourcesContract.SourceFetchResult[] = [];

  script(...windows: sourcesContract.SourceFetchResult[]): void {
    this.windows.push(...windows);
  }

  async fetch(): Promise<sourcesContract.SourceFetchResult> {
    const next = this.windows.shift();
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

/** A fake managed-broker server (the embedded wire dialect). */
class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;

  async request(request: brokerContract.BrokerHttpRequest): Promise<brokerContract.BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.unit.example/oauth/${state}`,
          state,
          expires_at: new Date(clockMs + 900_000).toISOString(),
        },
      };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const connectionId = decodeURIComponent(callback[1]!);
      const body = request.body as { state?: string };
      if (this.authorizations.get(connectionId) !== body.state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      this.counter += 1;
      const embId = `emb-${this.counter.toString().padStart(3, '0')}`;
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: [],
          expires_at: new Date(clockMs + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

let directoryTransport: ScriptedDirectoryTransport;
let brokerBackend: ScriptedBrokerBackend;
let accountCounter = 0;

function directoryRecord(
  externalId: string,
  displayName: string,
  capabilityClasses: string[],
): sourcesContract.CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${externalId}`,
    kind: 'directory.system.discovered',
    payload: { externalId, displayName, capabilityClasses },
    occurredAt: '2026-09-23T10:00:00Z',
  };
}

function windowOf(records: sourcesContract.CanonicalSourceRecord[]): sourcesContract.SourceFetchResult {
  return { records, nextCursor: null, hasMore: false };
}

/** The full W081→W082 setup for one connected system. */
async function connectSystem(
  tenantId: string,
  displayName: string,
  capabilityClasses: string[],
): Promise<{ connectionId: string; credentialRef: string }> {
  const adminCtx = integrationAdmin(tenantId);
  const memberCtx = member(tenantId);

  accountCounter += 1;
  const { source } = await registerSource(adminCtx, {
    provider: 'notion',
    providerAccountId: `ws-${String(accountCounter).padStart(8, '0')}`,
    displayName: `${displayName} directory`,
    authKind: 'oauth',
    credentialRef: fakeCredentialRef(`notion-${accountCounter}`),
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await grantDiscoverySource(adminCtx, { sourceId: source.id });
  directoryTransport.script(
    windowOf([directoryRecord(`app-${accountCounter}`, displayName, capabilityClasses)]),
  );
  await runDiscovery(memberCtx, { sourceId: source.id });
  const systems = await listSystems(memberCtx, {});
  const system = systems.find((entry) => entry.displayName === displayName)!;

  const initiation = await initiateConnection(memberCtx, {
    provider: 'salesforce',
    connectionKey: `conn-${accountCounter}`,
    displayName,
    inventorySystemId: system.id,
  });
  const connection = await completeConnection(memberCtx, {
    connectionId: initiation.connection.id,
    state: initiation.authorization.state,
  });
  return {
    connectionId: connection.connection.id,
    credentialRef: connection.connection.credentialRef ?? '',
  };
}

/** Establishes the W083 read-only envelope and grants the write keys. */
async function grantWrites(
  tenantId: string,
  connectionId: string,
  capabilityKeys: string[],
): Promise<void> {
  const ctx = member(tenantId);
  const boss = approver(tenantId);
  await establishConnectionAccess(ctx, { connectionId });
  const ask = await requestCapabilityAuthority(ctx, {
    connectionId,
    capabilityKeys,
    taskContext: TASK_CONTEXT,
  });
  if (ask.request !== null) {
    await decideGrantRequest(boss, { requestId: ask.request.id, decision: 'approve' });
  }
}

// ---------------------------------------------------------------------------
// The EDGE side (the customer-controlled runtime + its fake private systems)
// ---------------------------------------------------------------------------

/**
 * The edge's executor wiring: ONE canonical entity store behind the
 * read/write capability keys of the connected systems, with a scriptable
 * transient-failure mode (the deep-actions resume path).
 */
function createEdgeSideExecutor(store: Map<string, unknown>): EdgeJobExecutor & {
  calls: number;
  failTargets: Set<string>;
} {
  const executor = {
    calls: 0,
    failTargets: new Set<string>(),
    async execute(input: Parameters<EdgeJobExecutor['execute']>[0]): Promise<unknown> {
      executor.calls += 1;
      const request = input.request as {
        connectionId: string;
        target: string;
        payload?: unknown;
        credentialRef: string;
      };
      // The credential is resolved LOCALLY from the opaque ref.
      const credential = input.resolveCredential(request.credentialRef);
      if (credential === null) throw new Error('unknown credential ref');
      const key = `${request.connectionId}:${request.target}`;
      if (input.kind === 'inspect') {
        const state = store.get(key);
        return { found: state !== undefined, state: state ?? null };
      }
      if (executor.failTargets.has(request.target)) {
        executor.failTargets.delete(request.target);
        return { status: 'failed', receiptId: null, detail: 'edge upstream timeout — transient' };
      }
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      const base =
        typeof store.get(key) === 'object' && store.get(key) !== null
          ? (store.get(key) as Record<string, unknown>)
          : {};
      store.set(key, { ...base, ...payload });
      return {
        status: 'accepted',
        receiptId: `edge-rcpt-${executor.calls.toString().padStart(4, '0')}`,
        detail: null,
      };
    },
  };
  return executor;
}

/**
 * Wires the full edge side for one tenant: the registration (with the
 * capability allowlist of the systems under test), the LOCAL secret
 * store (keyed by the broker's opaque credentialRefs) and the runtime
 * loop (tight cadence — deterministic without a real network).
 */
async function setupEdgeSide(
  tenantId: string,
  credentialRefs: string[],
  store: Map<string, unknown>,
) {
  const edgeKey = 'acme-onprem-edge';
  const { registration } = await registerEdgeRuntime(member(tenantId), {
    edgeKey,
    label: 'Acme on-prem edge',
    systemClass: 'database',
    version: '1.2.0',
    allowlist: [READ_CUSTOMERS, READ_TICKETS, WRITE_CUSTOMERS, WRITE_TICKETS],
    edgeToken: EDGE_TOKEN,
  });
  const secrets: Record<string, string> = {};
  for (const ref of credentialRefs) {
    // One LOCAL secret per private system (fragment-assembled).
    secrets[ref] = ['acme-', 'onprem-', 'secret-', ref.slice(-4)].join('');
  }
  const executor = createEdgeSideExecutor(store);
  const runtime = createEdgeRuntime({
    gateway: createInMemoryGatewayClient({ context: member(tenantId), edgeKey, edgeToken: EDGE_TOKEN }),
    tenantId,
    edgeKey,
    version: '1.2.0',
    systemClass: 'database',
    allowlist: [READ_CUSTOMERS, READ_TICKETS, WRITE_CUSTOMERS, WRITE_TICKETS],
    verificationSecret: SIGNING_SECRET,
    secrets,
    executors: {
      [READ_CUSTOMERS]: executor,
      [READ_TICKETS]: executor,
      [WRITE_CUSTOMERS]: executor,
      [WRITE_TICKETS]: executor,
    },
    claimLimit: 8,
    leaseMs: 120_000,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 30_000,
  });
  runtime.start();
  return { registration, runtime, executor, edgeKey };
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
  directoryTransport = new ScriptedDirectoryTransport();
  brokerBackend = new ScriptedBrokerBackend();
  setSourceTransport(directoryTransport);
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.unit.example',
      apiToken: ['emb_', 'test', '_token'].join(''),
      httpClient: brokerBackend,
    }),
  ]);
  setEdgeJobSigner(createHmacSigner({ secret: SIGNING_SECRET, keyRef: 'edge-jobs/v1' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setSourceTransport(null);
  wireConnectionBrokers(null);
  setDeepActionTransport(null);
  setEdgeJobSigner(null);
});

// ---------------------------------------------------------------------------
// The composition proof
// ---------------------------------------------------------------------------

describe('W088 × W084: the deep-action pipeline end-to-end through the edge', () => {
  it('walks discover→inspect→propose→authorize→execute→verify→reconcile across two private systems', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);

    // Two connected private systems behind the W082 broker.
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records', 'sales-pipeline']);
    const desk = await connectSystem(tenant, 'Beta Desk', ['support-desk']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS]);
    await grantWrites(tenant, desk.connectionId, [WRITE_TICKETS]);

    // The (fake) private systems' current state — lives ONLY edge-side.
    const store = new Map<string, unknown>();
    store.set(`${crm.connectionId}:cust-1042`, {
      stage: 'onboarding',
      healthScore: 55,
      owner: 'Dana',
    });
    store.set(`${desk.connectionId}:tick-9001`, { status: 'open', priority: 'high' });

    // The customer-controlled edge runtime, started BEFORE the pipeline.
    const edge = await setupEdgeSide(
      tenant,
      [crm.credentialRef, desk.credentialRef],
      store,
    );

    // THE COMPOSITION: the pipeline's exit seam is the edge dispatch.
    setDeepActionTransport(
      createEdgeDispatchTransport({ context: aurum, edgeKey: edge.edgeKey, pollMs: 5, timeoutMs: 8_000 }),
    );

    // -- CREATE: the multi-system plan, frozen.
    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete', healthScore: 82 },
          expectation: { stage: 'onboarding-complete', healthScore: 82 },
        },
        {
          key: 'close-ticket',
          connectionId: desk.connectionId,
          capabilityKey: WRITE_TICKETS,
          target: 'tick-9001',
          payload: { status: 'resolved', priority: 'low' },
          expectation: { status: 'resolved', priority: 'low' },
        },
      ],
    });
    expect(created.created).toBe(true);
    // Nothing has touched the private systems yet.
    expect(edge.executor.calls).toBe(0);

    // -- DISCOVER → INSPECT (the pre-states cross the edge as SIGNED jobs).
    const discovered = await discoverExecutionSurface(aurum, { taskId: created.task.id });
    expect(discovered.task.status).toBe('discovered');
    const inspected = await inspectTargets(aurum, { taskId: created.task.id });
    expect(inspected.task.status).toBe('inspected');
    expect(edge.executor.calls).toBe(2); // two canonical state reads

    // -- PROPOSE → AUTHORIZE (the W009 gate + the W083 grants).
    const proposed = await proposeDeepAction(aurum, { taskId: created.task.id });
    expect(proposed.task.status).toBe('proposed');
    await decideApproval(boss, { requestId: proposed.task.actionRequestId!, decision: 'approve' });
    const authorized = await authorizeDeepAction(aurum, { taskId: created.task.id });
    expect(authorized.task.status).toBe('authorized');
    expect(edge.executor.calls).toBe(2); // still no writes

    // -- EXECUTE: the writes ride the edge as signed jobs; the receipts
    // are the edge's OPAQUE receipt ids.
    const executed = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(executed.task.status).toBe('executed');
    for (const operation of executed.operations) {
      expect(operation.receiptStatus).toBe('accepted');
      expect(operation.receiptId).toMatch(/^edge-rcpt-\d{4}$/);
      expect(operation.executedAt).not.toBeNull();
    }
    // The (fake) private systems now hold the written state — canonical
    // merge semantics preserved across the seam.
    expect(store.get(`${crm.connectionId}:cust-1042`)).toMatchObject({
      stage: 'onboarding-complete',
      healthScore: 82,
      owner: 'Dana',
    });
    expect(store.get(`${desk.connectionId}:tick-9001`)).toMatchObject({
      status: 'resolved',
      priority: 'low',
    });

    // -- VERIFY: the post-states read back through the edge.
    const verified = await verifyDeepAction(aurum, { taskId: created.task.id });
    expect(verified.task.status).toBe('verified');
    expect(edge.executor.calls).toBe(6); // 2 pre-states + 2 writes + 2 post-states

    // -- RECONCILE: every expectation held — the clean close.
    const reconciled = await reconcileDeepAction(aurum, { taskId: created.task.id });
    expect(reconciled.task.status).toBe('reconciled');
    expect(reconciled.task.mismatchCount).toBe(0);
    for (const operation of reconciled.operations) {
      expect(operation.state).toBe('matched');
    }

    // The edge program's own audit: every phase's jobs recorded,
    // tenant-scoped, all terminal.
    const feed = await listEdgeJobs(aurum, { limit: 50 });
    expect(feed.jobs).toHaveLength(6);
    expect(feed.jobs.every((job) => job.status === 'succeeded')).toBe(true);
    for (const job of feed.jobs) {
      expect(job.envelope.tenantId).toBe(tenant);
      expect(job.envelope.edgeKey).toBe('acme-onprem-edge');
      // The canonical requests crossed with their stable deep-action keys.
      expect(job.envelope.request.idempotencyKey).toMatch(/^deep-action:/);
      // Opaque credential refs only — never a secret VALUE.
      expect(JSON.stringify(job.envelope)).not.toContain('acme-onprem-secret-');
    }

    // The lifecycle audit of the task is complete and readable (newest first).
    const events = await listDeepActionEvents(aurum, { taskId: created.task.id, limit: 50 });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event).toBe('reconciled');

    edge.runtime.stop();
  });

  it('rides the deep-actions resume semantics: a transient edge receipt parks the task, the retry re-drives the SAME key and succeeds', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);

    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS]);

    const store = new Map<string, unknown>();
    store.set(`${crm.connectionId}:cust-2049`, { stage: 'onboarding', owner: 'Priya' });

    const edge = await setupEdgeSide(tenant, [crm.credentialRef], store);
    edge.executor.failTargets.add('cust-2049'); // the transient failure

    setDeepActionTransport(
      createEdgeDispatchTransport({ context: aurum, edgeKey: edge.edgeKey, pollMs: 5, timeoutMs: 8_000 }),
    );

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-2049',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    const proposed = await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, { requestId: proposed.task.actionRequestId!, decision: 'approve' });
    await authorizeDeepAction(aurum, { taskId: created.task.id });

    // First execution: the edge reports a TRANSIENT failed receipt; the
    // task parks 'failed' (resumable), no external effect taken.
    const first = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(first.task.status).toBe('failed');
    expect(first.operations[0]!.receiptStatus).toBe('failed');
    expect(store.get(`${crm.connectionId}:cust-2049`)).toMatchObject({ stage: 'onboarding' });

    // The re-run: deep-actions re-invokes the transport with the SAME
    // stable idempotency key; the edge job re-drives and the second
    // attempt takes the write.
    const retried = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(retried.task.status).toBe('executed');
    expect(retried.operations[0]!.receiptStatus).toBe('accepted');
    expect(retried.operations[0]!.receiptId).toMatch(/^edge-rcpt-\d{4}$/);
    expect(store.get(`${crm.connectionId}:cust-2049`)).toMatchObject({ stage: 'onboarding-complete' });

    // The chain closes through verify + reconcile.
    const verified = await verifyDeepAction(aurum, { taskId: created.task.id });
    expect(verified.task.status).toBe('verified');
    const reconciled = await reconcileDeepAction(aurum, { taskId: created.task.id });
    expect(reconciled.task.status).toBe('reconciled');

    // The edge audit shows the redrive discipline: one execute job row,
    // claimed twice (the transient attempt + the re-drive).
    const feed = await listEdgeJobs(aurum, { limit: 50 });
    const executeJobs = feed.jobs.filter((job) => job.kind === 'execute');
    expect(executeJobs).toHaveLength(1);
    expect(executeJobs[0]!.attempts).toBe(2);
    expect(executeJobs[0]!.status).toBe('succeeded');

    edge.runtime.stop();
  });
});
