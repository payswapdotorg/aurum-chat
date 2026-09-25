// Integration tests for the deep-actions module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W084
// acceptance end-to-end:
//
// "multi-system task can execute from Aurum; action receipt and
//  downstream state are verified; reconciliation detects mismatches and
//  creates attention/evidence; provider objects never cross the gateway."
//
//  * THE ACCEPTANCE PATH — two connected systems discovered through W081
//    and connected through W082 (embedded broker, scripted backend) with
//    W083 write grants; a TWO-SYSTEM deep-action task walks the whole
//    chain discover→inspect→propose→authorize→execute→verify→reconcile
//    through the real contracts: the surface snapshot, the pre-state
//    evidence, the W009 gate (kind 'deep-action' × EXECUTE) with its
//    approver-facing payload, the per-operation W083 invocations, the
//    opaque action receipts, the post-state evidence and the clean
//    reconciliation — every link readable on the task;
//
//  * MISMATCH CREATES ATTENTION AND EVIDENCE — an accepted write that
//    leaves the target unchanged reconciles 'mismatched': a mismatch
//    evidence observation (derived from the two state reads) and an
//    epistemics unknown (the attention record) are created and linked,
//    with the divergence enumerated and the unchanged state flagged;
//
//  * DENIAL STOPS THE WRITE — an operation whose write capability has no
//    grant is denied at authorization: the task is 'rejected' carrying
//    the W083 gate's own human-readable reason, and NO transport execute
//    call ever happened;
//
//  * GATE REJECTION — a human 'reject' on the proposal refuses the task;
//    a tenant policy that forbids 'deep-action' refuses it at propose;
//    a policy that auto-allows it proceeds without a human decision;
//
//  * PROVIDER OBJECTS NEVER CROSS — a transport returning a provider
//    receipt object or a non-JSON state is rejected loudly
//    (invalid_transport_result); nothing provider-shaped is persisted;
//
//  * EXECUTION RESUME AND PERMANENT REFUSAL — a transient 'failed'
//    receipt parks the task 'failed' and re-execution continues from the
//    open operation (executed operations are never re-executed); a
//    permanent 'rejected' receipt refuses re-execution;
//
//  * STATE DISCIPLINE — phase calls out of order, missing transport,
//    pending gate, unknown tasks, idempotent create replay;
//
//  * TENANT ISOLATION — two tenants, zero leakage;
//
//  * THE W080 COMPOSITION — the same task executes as a durable workflow
//    run: the approval wait survives a whole ENGINE GENERATION swap
//    (fresh engine + fresh bindings resume the same run), and the task
//    reaches 'reconciled' through the pump;
//
//  * STORAGE DISCIPLINE — the events ledger is append-only
//    (UPDATE/DELETE/TRUNCATE refused at the storage level).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as actionsContract from '@/modules/actions/contract';
import * as epistemicsContract from '@/modules/epistemics/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as sourcesContract from '@/modules/sources/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as grantsContract from '@/modules/capability-grants/contract';
import * as observationsContract from '@/modules/observations/contract';
import * as workflowContract from '@/modules/workflow/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { DeepActionsError } from '../errors';
import * as deepActions from '../contract';
import type {
  DeepActionExecuteRequest,
  DeepActionInspectRequest,
  DeepActionReceipt,
  DeepActionState,
  DeepActionTransport,
} from '../contract';

const {
  createDeepAction,
  discoverExecutionSurface,
  inspectTargets,
  proposeDeepAction,
  authorizeDeepAction,
  executeDeepAction,
  verifyDeepAction,
  reconcileDeepAction,
  getDeepAction,
  listDeepActions,
  listDeepActionEvents,
  setDeepActionTransport,
  startDeepActionRun,
  createDeepActionWorkflowBindings,
  DEEP_ACTION_ACTION_KIND,
} = deepActions;

const { decideApproval, listActionRequests, setAuthorityPolicy } = actionsContract;
const { getUnknown } = epistemicsContract;
const { getObservation } = observationsContract;
const { grantDiscoverySource, listSystems, runDiscovery } = integrationContract;
const { registerSource, setSourceTransport } = sourcesContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;
const {
  decideGrantRequest,
  establishConnectionAccess,
  requestCapabilityAuthority,
} = grantsContract;
const { createWorkflowEngine, getRun } = workflowContract;

// A FRESH tenant per test so counts stay deterministic.
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

function policyAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

// Fake credentials are assembled from fragments at runtime (never a
// realistic full token literal in source — GitHub push protection).
function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w084/` + `${label}/` + 'ref';
}

async function expectDeepError(
  code: DeepActionsError['code'],
  fn: () => Promise<unknown>,
): Promise<DeepActionsError> {
  try {
    await fn();
    throw new Error(`expected DeepActionsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof DeepActionsError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

// ---------------------------------------------------------------------------
// Stubbed transports (the provider side lives BEHIND these fakes)
// ---------------------------------------------------------------------------

/** A provider-neutral source transport that serves scripted windows. */
class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  readonly requests: unknown[] = [];
  private windows: sourcesContract.SourceFetchResult[] = [];

  script(...windows: sourcesContract.SourceFetchResult[]): void {
    this.windows.push(...windows);
  }

  async fetch(request: unknown): Promise<sourcesContract.SourceFetchResult> {
    this.requests.push(request);
    const next = this.windows.shift();
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

/** A fake managed-broker server (the embedded wire dialect). */
class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  readonly requests: brokerContract.BrokerHttpRequest[] = [];
  private authorizations = new Map<string, string>();
  private counter = 0;

  constructor(private readonly nowProvider: () => Date) {}

  async request(request: brokerContract.BrokerHttpRequest): Promise<brokerContract.BrokerHttpResponse> {
    this.requests.push(request);
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
          expires_at: new Date(this.nowProvider().getTime() + 900_000).toISOString(),
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
          expires_at: new Date(this.nowProvider().getTime() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

/**
 * A fake deep-action transport — the "provider side" behind the gateway's
 * exit seam. It keeps a canonical entity store, applies executed writes
 * and returns OPAQUE receipt ids, with scriptable failure modes:
 *   * failOnce  — a transient 'failed' receipt for the FIRST execute of a
 *     target (the resume path);
 *   * refuse    — a permanent 'rejected' receipt for a target;
 *   * skipApply — an 'accepted' receipt whose write changes nothing (the
 *     accepted-but-nothing-moved mismatch);
 *   * nativeReceiptObject / nativeStateObject — deliberately NON-CANONICAL
 *     results (a provider object): the gateway must reject them loudly.
 */
class ScriptedDeepActionTransport implements DeepActionTransport {
  readonly inspectRequests: DeepActionInspectRequest[] = [];
  readonly executeRequests: DeepActionExecuteRequest[] = [];
  private states = new Map<string, unknown>();
  private receiptCounter = 0;
  readonly failOnce = new Set<string>();
  readonly refuse = new Set<string>();
  readonly skipApply = new Set<string>();
  nativeReceiptObject = false;
  nativeStateObject = false;

  private key(connectionId: string, target: string): string {
    return `${connectionId}:${target}`;
  }

  seed(connectionId: string, target: string, state: unknown): void {
    this.states.set(this.key(connectionId, target), state);
  }

  stateOf(connectionId: string, target: string): unknown {
    return this.states.get(this.key(connectionId, target));
  }

  async inspect(request: DeepActionInspectRequest): Promise<DeepActionState> {
    this.inspectRequests.push(request);
    if (this.nativeStateObject) {
      // A provider-native object (a Date instance) — NOT canonical JSON.
      return { found: true, state: new Date() } as unknown as DeepActionState;
    }
    const state = this.states.get(this.key(request.connectionId, request.target));
    return { found: state !== undefined, state: state ?? null };
  }

  async execute(request: DeepActionExecuteRequest): Promise<DeepActionReceipt> {
    this.executeRequests.push(request);
    if (this.nativeReceiptObject) {
      // A provider-native receipt object — NOT the canonical shape.
      return {
        status: 'accepted',
        receiptId: { native: 'provider-receipt-handle' },
        detail: null,
      } as unknown as DeepActionReceipt;
    }
    if (this.refuse.has(request.target)) {
      return { status: 'rejected', receiptId: null, detail: 'quota exceeded — permanent refusal' };
    }
    if (this.failOnce.has(request.target)) {
      this.failOnce.delete(request.target);
      return { status: 'failed', receiptId: null, detail: 'upstream timeout — transient' };
    }
    this.receiptCounter += 1;
    const receiptId = `rcpt-${this.receiptCounter.toString().padStart(4, '0')}`;
    if (!this.skipApply.has(request.target)) {
      const current = this.states.get(this.key(request.connectionId, request.target));
      const base = typeof current === 'object' && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
      this.states.set(
        this.key(request.connectionId, request.target),
        { ...base, ...(request.payload as Record<string, unknown>) },
      );
    }
    return { status: 'accepted', receiptId, detail: null };
  }
}

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

let directoryTransport: ScriptedDirectoryTransport;
let brokerBackend: ScriptedBrokerBackend;
let transport: ScriptedDeepActionTransport;

const BASE_TIME = Date.parse('2026-09-24T12:00:00Z');
let clockMs = BASE_TIME;

let accountCounter = 0;

/**
 * The full W081→W082 setup for one connected system (the W083 test
 * fixture discipline): register a directory source, admin-grant
 * discovery, discover the system, connect it through the scripted
 * embedded broker.
 */
async function connectSystem(
  tenantId: string,
  displayName: string,
  capabilityClasses: string[],
): Promise<{ connectionId: string; systemId: string }> {
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
  return { connectionId: connection.connection.id, systemId: system.id };
}

/** Establishes the W083 read-only envelope and grants the write keys. */
async function grantWrites(
  tenantId: string,
  connectionId: string,
  capabilityKeys: string[],
  taskContext: { description: string; requestedFor?: string | null },
): Promise<void> {
  const ctx = member(tenantId);
  const boss = approver(tenantId);
  await establishConnectionAccess(ctx, { connectionId });
  const ask = await requestCapabilityAuthority(ctx, {
    connectionId,
    capabilityKeys,
    taskContext,
  });
  if (ask.request !== null) {
    await decideGrantRequest(boss, { requestId: ask.request.id, decision: 'approve' });
  }
}

const TASK_CONTEXT = {
  description: 'Close out the Q3 renewals after the signed contracts landed',
  requestedFor: 'Q3 close',
};

const WRITE_CUSTOMERS = 'write.customer-records';
const WRITE_TICKETS = 'write.support-desk';

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
  brokerBackend = new ScriptedBrokerBackend(() => new Date(clockMs));
  transport = new ScriptedDeepActionTransport();
  setSourceTransport(directoryTransport);
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.unit.example',
      apiToken: ['emb_', 'test', '_token'].join(''),
      httpClient: brokerBackend,
    }),
  ]);
  setDeepActionTransport(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSourceTransport(null);
  wireConnectionBrokers(null);
  setDeepActionTransport(null);
});

// ---------------------------------------------------------------------------
// The acceptance path
// ---------------------------------------------------------------------------

describe('W084 acceptance path: multi-system task executes, verifies and reconciles', () => {
  it('walks discover→inspect→propose→authorize→execute→verify→reconcile across two systems', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);

    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records', 'sales-pipeline']);
    const desk = await connectSystem(tenant, 'Beta Desk', ['support-desk']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    await grantWrites(tenant, desk.connectionId, [WRITE_TICKETS], TASK_CONTEXT);

    // Seed the (fake) external systems' current state.
    transport.seed(crm.connectionId, 'cust-1042', {
      stage: 'onboarding',
      healthScore: 55,
      owner: 'Dana',
    });
    transport.seed(desk.connectionId, 'tick-9001', { status: 'open', priority: 'high' });

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
    expect(created.task.status).toBe('draft');
    expect(created.task.operationCount).toBe(2);
    // Nothing has touched the provider side yet.
    expect(transport.inspectRequests).toHaveLength(0);
    expect(transport.executeRequests).toHaveLength(0);

    // -- DISCOVER: the execution surface across BOTH systems.
    const discovered = await discoverExecutionSurface(aurum, { taskId: created.task.id });
    expect(discovered.task.status).toBe('discovered');
    expect(discovered.surface).toHaveLength(2);
    const surfaceBySystem = new Map(discovered.surface.map((entry) => [entry.systemDisplayName, entry]));
    const crmSurface = surfaceBySystem.get('Acme CRM')!;
    expect(crmSurface.connectionMode).toBe('elevated');
    expect(crmSurface.activeGrantKeys).toContain(WRITE_CUSTOMERS);
    expect(crmSurface.readCapabilities).toHaveLength(2); // read.customer-records + read.sales-pipeline
    const deskSurface = surfaceBySystem.get('Beta Desk')!;
    expect(deskSurface.activeGrantKeys).toContain(WRITE_TICKETS);
    // The operations carry the frozen system descriptors and derived read keys.
    const fileCrm = discovered.operations.find((operation) => operation.key === 'file-crm')!;
    expect(fileCrm.systemDisplayName).toBe('Acme CRM');
    expect(fileCrm.readCapabilityKey).toBe('read.customer-records');
    expect(fileCrm.systemId).toBe(crm.systemId);

    // -- INSPECT: the pre-execution state of every target, as evidence.
    const inspected = await inspectTargets(aurum, { taskId: created.task.id });
    expect(inspected.task.status).toBe('inspected');
    expect(transport.inspectRequests).toHaveLength(2);
    for (const operation of inspected.operations) {
      expect(operation.preStateObservationId).not.toBeNull();
      expect(operation.state).toBe('pending');
    }
    // The pre-state evidence is readable through the observations contract.
    const preState = await getObservation(
      aurum,
      inspected.operations[0]!.preStateObservationId!,
    );
    expect(preState.kind).toBe('deep-action.pre-state');
    expect(preState.source).toMatchObject({ kind: 'system', label: 'Acme CRM' });
    expect((preState.payload as { state: { stage: string } }).state.stage).toBe('onboarding');

    // -- PROPOSE: the W009 gate (kind 'deep-action' × EXECUTE).
    const proposed = await proposeDeepAction(aurum, { taskId: created.task.id });
    expect(proposed.task.status).toBe('proposed');
    expect(proposed.task.actionRequestId).not.toBeNull();
    const gateRequests = await listActionRequests(boss, { actionKind: DEEP_ACTION_ACTION_KIND });
    const gateRequest = gateRequests.find((entry) => entry.id === proposed.task.actionRequestId)!;
    expect(gateRequest).toBeDefined();
    expect(gateRequest.status).toBe('pending');
    expect(gateRequest.authorityLevel).toBe('EXECUTE');
    expect(gateRequest.requestedBy).toBe(aurum.principalId);
    // The approver sees the FULL plan: both systems, both operations.
    const payload = gateRequest.payload as {
      surface: { system: string }[];
      operations: { key: string; system: string; target: string; expectation: unknown }[];
    };
    expect(payload.surface.map((entry) => entry.system).sort()).toEqual(['Acme CRM', 'Beta Desk']);
    expect(payload.operations).toHaveLength(2);
    expect(gateRequest.justification).toContain('Close out the Q3 renewals');
    expect(gateRequest.justification).toContain('Acme CRM');

    // Authorizing while the gate is pending refuses.
    await expectDeepError('gate_not_decided', () =>
      authorizeDeepAction(aurum, { taskId: created.task.id }),
    );

    // -- AUTHORIZE: the human approves; every write rides the W083 gate.
    await decideApproval(boss, { requestId: gateRequest.id, decision: 'approve' });
    const authorized = await authorizeDeepAction(aurum, { taskId: created.task.id });
    expect(authorized.task.status).toBe('authorized');
    for (const operation of authorized.operations) {
      expect(operation.state).toBe('authorized');
      expect(operation.invocationId).not.toBeNull();
      // The authority evidence is readable through the W083 contract.
      const invocation = await grantsContract.getCapabilityInvocation(aurum, {
        invocationId: operation.invocationId!,
      });
      expect(invocation.outcome).toBe('allowed');
      expect(invocation.basis).toBe('capability-grant');
      expect(invocation.capabilityKey).toBe(operation.capabilityKey);
    }
    // Nothing has been written yet.
    expect(transport.executeRequests).toHaveLength(0);

    // -- EXECUTE: the writes, one opaque receipt per operation.
    const executed = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(executed.task.status).toBe('executed');
    expect(transport.executeRequests).toHaveLength(2);
    const crmWrite = transport.executeRequests.find((request) => request.target === 'cust-1042')!;
    expect(crmWrite.capabilityKey).toBe(WRITE_CUSTOMERS);
    expect(crmWrite.systemKey).toBe(fileCrm.systemKey);
    expect(crmWrite.payload).toEqual({ stage: 'onboarding-complete', healthScore: 82 });
    for (const operation of executed.operations) {
      expect(operation.state).toBe('executed');
      expect(operation.receiptStatus).toBe('accepted');
      // The ONLY provider-minted value: an opaque receipt id.
      expect(operation.receiptId).toMatch(/^rcpt-\d{4}$/);
      expect(operation.executedAt).not.toBeNull();
    }
    // The (fake) external systems now hold the written state.
    expect(transport.stateOf(crm.connectionId, 'cust-1042')).toMatchObject({
      stage: 'onboarding-complete',
      healthScore: 82,
      owner: 'Dana', // untouched fields survive — canonical merge semantics
    });

    // -- VERIFY: the action receipt AND the downstream state.
    const verified = await verifyDeepAction(aurum, { taskId: created.task.id });
    expect(verified.task.status).toBe('verified');
    // Two inspect reads per operation happened: pre-state + post-state.
    expect(transport.inspectRequests).toHaveLength(4);
    for (const operation of verified.operations) {
      expect(operation.state).toBe('verified');
      expect(operation.postStateObservationId).not.toBeNull();
      expect(operation.verifiedAt).not.toBeNull();
    }
    const postState = await getObservation(
      aurum,
      verified.operations[1]!.postStateObservationId!,
    );
    expect(postState.kind).toBe('deep-action.post-state');
    const postPayload = postState.payload as {
      state: { status: string };
      receipt: { status: string; receiptId: string };
    };
    expect(postPayload.state.status).toBe('resolved');
    expect(postPayload.receipt.status).toBe('accepted');
    expect(postPayload.receipt.receiptId).toMatch(/^rcpt-\d{4}$/);

    // -- RECONCILE: every expectation held — the clean close.
    const reconciled = await reconcileDeepAction(aurum, { taskId: created.task.id });
    expect(reconciled.task.status).toBe('reconciled');
    expect(reconciled.task.mismatchCount).toBe(0);
    expect(reconciled.mismatchEvidenceObservationIds).toEqual([]);
    expect(reconciled.mismatchUnknownIds).toEqual([]);
    for (const operation of reconciled.operations) {
      expect(operation.state).toBe('matched');
      expect(operation.mismatchUnknownId).toBeNull();
      expect(operation.reconciledAt).not.toBeNull();
    }

    // The lifecycle audit tells the whole chain, in order.
    const events = await listDeepActionEvents(aurum, { taskId: created.task.id });
    const chain = events.map((event) => event.event).reverse();
    expect(chain).toEqual([
      'created',
      'surface-discovered',
      'targets-inspected',
      'proposed',
      'authorized',
      'operation-executed',
      'operation-executed',
      'executed',
      'verified',
      'reconciled',
    ]);

    // Phase discipline: the terminal task refuses further phases.
    await expectDeepError('task_not_pending_phase', () =>
      executeDeepAction(aurum, { taskId: created.task.id }),
    );
  });

  it('replays an idempotent create and never duplicates the plan', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);

    const first = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1',
          payload: { stage: 'done' },
          expectation: { stage: 'done' },
        },
      ],
      idempotencyKey: 'renewal-q3-once',
    });
    const replay = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1',
          payload: { stage: 'done' },
          expectation: { stage: 'done' },
        },
      ],
      idempotencyKey: 'renewal-q3-once',
    });
    expect(replay.created).toBe(false);
    expect(replay.task.id).toBe(first.task.id);
    expect(await listDeepActions(aurum, {})).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mismatch — attention and evidence
// ---------------------------------------------------------------------------

describe('reconciliation detects mismatches and creates attention/evidence', () => {
  it('records mismatch evidence and an attention unknown for an accepted-but-unchanged write', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    const desk = await connectSystem(tenant, 'Beta Desk', ['support-desk']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    await grantWrites(tenant, desk.connectionId, [WRITE_TICKETS], TASK_CONTEXT);

    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    transport.seed(desk.connectionId, 'tick-9002', { status: 'open', priority: 'high' });
    // The desk write will be ACCEPTED but change nothing — the classic
    // "the provider took the write but the state did not move" divergence.
    transport.skipApply.add('tick-9002');

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
        {
          key: 'close-ticket',
          connectionId: desk.connectionId,
          capabilityKey: WRITE_TICKETS,
          target: 'tick-9002',
          payload: { status: 'resolved' },
          expectation: { status: 'resolved' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, {
      requestId: (await getDeepAction(aurum, { taskId: created.task.id })).task.actionRequestId!,
      decision: 'approve',
    });
    await authorizeDeepAction(aurum, { taskId: created.task.id });
    await executeDeepAction(aurum, { taskId: created.task.id });
    await verifyDeepAction(aurum, { taskId: created.task.id });

    const result = await reconcileDeepAction(aurum, { taskId: created.task.id });
    // ONE operation matched; the other mismatched — the task ends
    // 'mismatched' with attention and evidence created for exactly it.
    expect(result.task.status).toBe('mismatched');
    expect(result.task.mismatchCount).toBe(1);
    expect(result.mismatchEvidenceObservationIds).toHaveLength(1);
    expect(result.mismatchUnknownIds).toHaveLength(1);

    const fileCrm = result.operations.find((operation) => operation.key === 'file-crm')!;
    const closeTicket = result.operations.find((operation) => operation.key === 'close-ticket')!;
    expect(fileCrm.state).toBe('matched');
    expect(closeTicket.state).toBe('mismatched');
    expect(closeTicket.mismatchEvidenceObservationId).toBe(result.mismatchEvidenceObservationIds[0]);
    expect(closeTicket.mismatchUnknownId).toBe(result.mismatchUnknownIds[0]);

    // The mismatch EVIDENCE is an immutable observation derived from the
    // two state reads, enumerating the divergence and the unchanged state.
    const evidence = await getObservation(
      aurum,
      closeTicket.mismatchEvidenceObservationId!,
    );
    expect(evidence.kind).toBe('deep-action.reconciliation-mismatch');
    expect(evidence.lineage.method).toBe('transformation');
    expect(evidence.lineage.parents).toEqual([
      closeTicket.preStateObservationId,
      closeTicket.postStateObservationId,
    ]);
    const evidencePayload = evidence.payload as {
      operationKey: string;
      target: string;
      expectation: { status: string };
      observedState: { status: string };
      mismatches: { path: string; expected: string; actual: string }[];
      stateUnchanged: boolean;
      reason: string;
    };
    expect(evidencePayload.operationKey).toBe('close-ticket');
    expect(evidencePayload.mismatches).toEqual([
      { path: 'status', expected: 'resolved', actual: 'open' },
    ]);
    expect(evidencePayload.stateUnchanged).toBe(true);
    expect(evidencePayload.reason).toContain('identical to the pre-execution state');

    // The ATTENTION record is a consequential epistemics unknown linked
    // to all three observations and the task subject.
    const unknown = await getUnknown(aurum, { unknownId: closeTicket.mismatchUnknownId! });
    expect(unknown.status).toBe('open');
    expect(unknown.question).toContain('Why did the authorized action');
    expect(unknown.question).toContain('Close out the Q3 renewals after the signed contracts landed');
    expect(unknown.question).toContain("'tick-9002'");
    expect(unknown.question).toContain('Beta Desk');
    expect(unknown.consequence).toContain('diverges from what Aurum proposed');
    expect(unknown.subject).toEqual({ kind: 'deep-actions.task', id: created.task.id });
    // The epistemics contract normalizes evidence lists (sorted, deduped).
    expect([...unknown.relatedObservationIds].sort()).toEqual(
      [
        closeTicket.preStateObservationId,
        closeTicket.postStateObservationId,
        closeTicket.mismatchEvidenceObservationId,
      ].sort(),
    );

    // The audit records the mismatch detection.
    const events = await listDeepActionEvents(aurum, { taskId: created.task.id });
    expect(events.map((event) => event.event)).toContain('mismatch-detected');
    // Terminal — no further phases.
    await expectDeepError('task_not_pending_phase', () =>
      reconcileDeepAction(aurum, { taskId: created.task.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Denial stops the write
// ---------------------------------------------------------------------------

describe('a capability denial stops the write before anything executes', () => {
  it('parks the task rejected with the gate reason and no transport calls', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    const desk = await connectSystem(tenant, 'Beta Desk', ['support-desk']);
    // The CRM write is granted; the desk write is NOT (read-only floor only).
    await establishConnectionAccess(member(tenant), { connectionId: crm.connectionId });
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    await establishConnectionAccess(member(tenant), { connectionId: desk.connectionId });

    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    transport.seed(desk.connectionId, 'tick-9003', { status: 'open' });

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
        {
          key: 'close-ticket',
          connectionId: desk.connectionId,
          capabilityKey: WRITE_TICKETS,
          target: 'tick-9003',
          payload: { status: 'resolved' },
          expectation: { status: 'resolved' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, {
      requestId: (await getDeepAction(aurum, { taskId: created.task.id })).task.actionRequestId!,
      decision: 'approve',
    });

    // The authorized CRM operation stands; the desk write is DENIED at the
    // W083 gate — the whole task stops with the gate's own reason.
    const rejected = await authorizeDeepAction(aurum, { taskId: created.task.id });
    expect(rejected.task.status).toBe('rejected');
    expect(rejected.task.rejectionReason).toContain('Reply to or close support tickets');
    expect(rejected.task.rejectionReason).toContain('The write is stopped');
    const closeTicket = rejected.operations.find((operation) => operation.key === 'close-ticket')!;
    expect(closeTicket.state).toBe('denied');
    expect(closeTicket.denialInvocationId).not.toBeNull();
    // The denial invocation is the W083 gate's verdict, readable as data.
    const denial = await grantsContract.getCapabilityInvocation(aurum, {
      invocationId: closeTicket.denialInvocationId!,
    });
    expect(denial.outcome).toBe('denied');
    expect(denial.basis).toBe('grant-missing');
    expect(denial.denial).not.toBeNull();
    // The FIRST operation was authorized before the denial stopped the task.
    const fileCrm = rejected.operations.find((operation) => operation.key === 'file-crm')!;
    expect(fileCrm.state).toBe('authorized');
    expect(fileCrm.invocationId).not.toBeNull();

    // DENIAL STOPS THE WRITE: nothing executed, nothing left the system.
    expect(transport.executeRequests).toHaveLength(0);
    await expectDeepError('task_not_pending_phase', () =>
      executeDeepAction(aurum, { taskId: created.task.id }),
    );
    const events = await listDeepActionEvents(aurum, { taskId: created.task.id });
    expect(events.map((event) => event.event)).toContain('operation-denied');
  });
});

// ---------------------------------------------------------------------------
// Gate rejections and policy paths
// ---------------------------------------------------------------------------

describe('the W009 gate decides the proposal', () => {
  it('a human rejection refuses the task at authorization', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    const proposed = await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, {
      requestId: proposed.task.actionRequestId!,
      decision: 'reject',
      note: 'not during the audit freeze',
    });

    const refused = await authorizeDeepAction(aurum, { taskId: created.task.id });
    expect(refused.task.status).toBe('rejected');
    expect(refused.task.rejectionReason).toContain('human approver rejected');
    expect(transport.executeRequests).toHaveLength(0);
  });

  it('a forbidding policy refuses at propose; an auto-allowing policy proceeds without a human', async () => {
    const forbidden = freshTenant();
    {
      const aurum = member(forbidden);
      const crm = await connectSystem(forbidden, 'Acme CRM', ['customer-records']);
      await grantWrites(forbidden, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
      transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
      await setAuthorityPolicy(policyAdmin(forbidden), {
        actionKind: DEEP_ACTION_ACTION_KIND,
        approvalLevels: [],
        forbiddenLevels: ['EXECUTE'],
        note: 'no deep actions during the freeze',
      });
      const created = await createDeepAction(aurum, {
        taskContext: TASK_CONTEXT,
        operations: [
          {
            key: 'file-crm',
            connectionId: crm.connectionId,
            capabilityKey: WRITE_CUSTOMERS,
            target: 'cust-1042',
            payload: { stage: 'onboarding-complete' },
            expectation: { stage: 'onboarding-complete' },
          },
        ],
      });
      await discoverExecutionSurface(aurum, { taskId: created.task.id });
      await inspectTargets(aurum, { taskId: created.task.id });
      const refused = await proposeDeepAction(aurum, { taskId: created.task.id });
      expect(refused.task.status).toBe('rejected');
      expect(refused.task.rejectionReason).toContain('policy');
      expect(refused.task.actionRequestId).not.toBeNull();
    }

    // An auto-allowing policy: the gate records a POLICY approval and the
    // task proceeds straight through authorization without a human.
    const auto = freshTenant();
    const aurum = member(auto);
    const crm = await connectSystem(auto, 'Acme CRM', ['customer-records']);
    await grantWrites(auto, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    await setAuthorityPolicy(policyAdmin(auto), {
      actionKind: DEEP_ACTION_ACTION_KIND,
      approvalLevels: [],
      forbiddenLevels: [],
      note: 'this tenant trusts its own deep actions',
    });
    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    const proposed = await proposeDeepAction(aurum, { taskId: created.task.id });
    expect(proposed.task.status).toBe('proposed');
    const authorized = await authorizeDeepAction(aurum, { taskId: created.task.id });
    expect(authorized.task.status).toBe('authorized');
    const executed = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(executed.task.status).toBe('executed');
    await verifyDeepAction(aurum, { taskId: created.task.id });
    const reconciled = await reconcileDeepAction(aurum, { taskId: created.task.id });
    expect(reconciled.task.status).toBe('reconciled');
  });
});

// ---------------------------------------------------------------------------
// Provider objects never cross the gateway
// ---------------------------------------------------------------------------

describe('provider objects never cross the gateway', () => {
  it('rejects a provider-native receipt object loudly and persists nothing provider-shaped', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    transport.nativeReceiptObject = true;

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, {
      requestId: (await getDeepAction(aurum, { taskId: created.task.id })).task.actionRequestId!,
      decision: 'approve',
    });
    await authorizeDeepAction(aurum, { taskId: created.task.id });

    await expectDeepError('invalid_transport_result', () =>
      executeDeepAction(aurum, { taskId: created.task.id }),
    );
    // Nothing was persisted from the provider object — the operation still
    // stands at 'authorized' with no receipt.
    const detail = await getDeepAction(aurum, { taskId: created.task.id });
    expect(detail.task.status).toBe('authorized');
    expect(detail.operations[0]!.receiptStatus).toBeNull();
    expect(detail.operations[0]!.receiptId).toBeNull();
  });

  it('rejects a provider-native state object on the read path', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    transport.nativeStateObject = true;

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await expectDeepError('invalid_transport_result', () =>
      inspectTargets(aurum, { taskId: created.task.id }),
    );
  });

  it('exposes only opaque strings on its persisted surface — no provider shapes anywhere', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    const desk = await connectSystem(tenant, 'Beta Desk', ['support-desk']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    await grantWrites(tenant, desk.connectionId, [WRITE_TICKETS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    transport.seed(desk.connectionId, 'tick-9001', { status: 'open' });

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
        {
          key: 'close-ticket',
          connectionId: desk.connectionId,
          capabilityKey: WRITE_TICKETS,
          target: 'tick-9001',
          payload: { status: 'resolved' },
          expectation: { status: 'resolved' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, {
      requestId: (await getDeepAction(aurum, { taskId: created.task.id })).task.actionRequestId!,
      decision: 'approve',
    });
    await authorizeDeepAction(aurum, { taskId: created.task.id });
    await executeDeepAction(aurum, { taskId: created.task.id });
    await verifyDeepAction(aurum, { taskId: created.task.id });
    await reconcileDeepAction(aurum, { taskId: created.task.id });

    // Every persisted provider-minted value is an opaque string: the raw
    // rows carry only text/jsonb canonical shapes.
    const rows = await getDb().query<DbRow>(
      `SELECT * FROM deep_action_operations WHERE tenant_id = $1 AND task_id = $2 ORDER BY position`,
      [tenant, created.task.id],
    );
    expect(rows.rows).toHaveLength(2);
    const payloads = rows.rows.map((row) => row['payload'] as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ stage: 'onboarding-complete' });
    expect(payloads[1]).toMatchObject({ status: 'resolved' });
    for (const row of rows.rows) {
      expect(typeof row['receipt_id']).toBe('string');
      expect(row['receipt_status']).toBe('accepted');
      expect(typeof row['system_key']).toBe('string');
      // The payload round-tripped as plain JSON — nothing provider-shaped.
      expect(JSON.stringify(row['payload'])).not.toContain('native');
      expect(row['payload']).not.toHaveProperty('native');
    }
    // No provider-named field exists anywhere in the module's tables.
    const columns = await getDb().query<DbRow>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name LIKE 'deep_action%'`,
    );
    const providerish = columns.rows
      .map((row) => row['column_name'] as string)
      .filter((name) => /provider|vendor|sdk/i.test(name));
    expect(providerish).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Execution resume and permanent refusal
// ---------------------------------------------------------------------------

describe('execution resumes from transient failure and refuses permanent rejection', () => {
  it('re-executes only the open operation after a transient failure', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    const desk = await connectSystem(tenant, 'Beta Desk', ['support-desk']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    await grantWrites(tenant, desk.connectionId, [WRITE_TICKETS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    transport.seed(desk.connectionId, 'tick-9001', { status: 'open' });
    // The SECOND operation fails transiently on its first attempt.
    transport.failOnce.add('tick-9001');

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
        {
          key: 'close-ticket',
          connectionId: desk.connectionId,
          capabilityKey: WRITE_TICKETS,
          target: 'tick-9001',
          payload: { status: 'resolved' },
          expectation: { status: 'resolved' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, {
      requestId: (await getDeepAction(aurum, { taskId: created.task.id })).task.actionRequestId!,
      decision: 'approve',
    });
    await authorizeDeepAction(aurum, { taskId: created.task.id });

    const failed = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(failed.task.status).toBe('failed');
    expect(failed.task.rejectionReason).toContain("operation 'close-ticket'");
    expect(failed.operations[0]!.state).toBe('executed'); // the first write stands
    expect(failed.operations[1]!.state).toBe('failed');
    expect(failed.operations[1]!.receiptStatus).toBe('failed');

    // Resume: only the open operation re-executes.
    const resumed = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(resumed.task.status).toBe('executed');
    expect(resumed.operations[0]!.state).toBe('executed');
    expect(resumed.operations[1]!.state).toBe('executed');
    // Three execute calls total: op1 once, op2 twice (fail + retry).
    expect(transport.executeRequests).toHaveLength(3);
    const ticketWrites = transport.executeRequests.filter((request) => request.target === 'tick-9001');
    expect(ticketWrites).toHaveLength(2);
    // The stable per-operation idempotency key makes the retry
    // exactly-once for an honoring provider.
    expect(ticketWrites[0]!.idempotencyKey).toBe(ticketWrites[1]!.idempotencyKey);

    await verifyDeepAction(aurum, { taskId: created.task.id });
    const reconciled = await reconcileDeepAction(aurum, { taskId: created.task.id });
    expect(reconciled.task.status).toBe('reconciled');
  });

  it('refuses re-execution after a permanent provider rejection', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    transport.refuse.add('cust-1042');

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    await inspectTargets(aurum, { taskId: created.task.id });
    await proposeDeepAction(aurum, { taskId: created.task.id });
    await decideApproval(boss, {
      requestId: (await getDeepAction(aurum, { taskId: created.task.id })).task.actionRequestId!,
      decision: 'approve',
    });
    await authorizeDeepAction(aurum, { taskId: created.task.id });

    const failed = await executeDeepAction(aurum, { taskId: created.task.id });
    expect(failed.task.status).toBe('failed');
    expect(failed.operations[0]!.receiptStatus).toBe('rejected');
    await expectDeepError('operation_rejected', () =>
      executeDeepAction(aurum, { taskId: created.task.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// State discipline
// ---------------------------------------------------------------------------

describe('state discipline', () => {
  it('refuses phases out of order, unknown tasks and missing transport', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    // Phases must follow the chain.
    await expectDeepError('task_not_pending_phase', () =>
      inspectTargets(aurum, { taskId: created.task.id }),
    );
    await expectDeepError('task_not_pending_phase', () =>
      proposeDeepAction(aurum, { taskId: created.task.id }),
    );
    await discoverExecutionSurface(aurum, { taskId: created.task.id });
    // No transport wired: the read path refuses to fake success.
    setDeepActionTransport(null);
    await expectDeepError('transport_unavailable', () =>
      inspectTargets(aurum, { taskId: created.task.id }),
    );
    setDeepActionTransport(transport);
    // Unknown task ids are uniform not-found.
    const unknown = newId();
    await expectDeepError('task_not_found', () => getDeepAction(aurum, { taskId: unknown }));
    await expectDeepError('task_not_found', () =>
      discoverExecutionSurface(aurum, { taskId: unknown }),
    );
    await expectDeepError('task_not_found', () =>
      listDeepActionEvents(aurum, { taskId: unknown }),
    );
    // Unknown capability keys refuse at discover (the live surface rules).
    const bad = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'wrong',
          connectionId: crm.connectionId,
          capabilityKey: 'write.project-tracking', // not on Acme CRM's surface
          target: 'cust-1042',
          payload: { done: true },
          expectation: { done: true },
        },
      ],
    });
    await expectDeepError('capability_not_offered', () =>
      discoverExecutionSurface(aurum, { taskId: bad.task.id }),
    );
  });

  it('keeps the events ledger append-only at the storage level', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    const first = (await listDeepActionEvents(aurum, { taskId: created.task.id }))[0]!;
    await expect(getDb().query(`UPDATE deep_action_events SET detail = 'tampered' WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM deep_action_events WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE deep_action_events`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('keeps every tenant deep-action state indistinguishable-from-missing to the other', async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const aurumA = member(tenantA);
    const aurumB = member(tenantB);
    const bossA = approver(tenantA);

    const crm = await connectSystem(tenantA, 'Acme CRM', ['customer-records']);
    await grantWrites(tenantA, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });

    const created = await createDeepAction(aurumA, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(aurumA, { taskId: created.task.id });
    await inspectTargets(aurumA, { taskId: created.task.id });
    await proposeDeepAction(aurumA, { taskId: created.task.id });
    await decideApproval(bossA, {
      requestId: (await getDeepAction(aurumA, { taskId: created.task.id })).task.actionRequestId!,
      decision: 'approve',
    });
    await authorizeDeepAction(aurumA, { taskId: created.task.id });
    await executeDeepAction(aurumA, { taskId: created.task.id });

    // Tenant B sees NOTHING of tenant A's tasks — uniform not-found, no
    // existence leak, no phase advances, no events.
    await expectDeepError('task_not_found', () => getDeepAction(aurumB, { taskId: created.task.id }));
    await expectDeepError('task_not_found', () =>
      discoverExecutionSurface(aurumB, { taskId: created.task.id }),
    );
    await expectDeepError('task_not_found', () =>
      executeDeepAction(aurumB, { taskId: created.task.id }),
    );
    await expectDeepError('task_not_found', () =>
      listDeepActionEvents(aurumB, { taskId: created.task.id }),
    );
    expect(await listDeepActions(aurumB, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The W080 composition — durable, resumable workflow runs
// ---------------------------------------------------------------------------

describe('the W080 composition: durable deep-action workflow runs', () => {
  it('executes the whole chain as a workflow run and survives an engine-generation swap', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    const desk = await connectSystem(tenant, 'Beta Desk', ['support-desk']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    await grantWrites(tenant, desk.connectionId, [WRITE_TICKETS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });
    transport.seed(desk.connectionId, 'tick-9001', { status: 'open' });

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
        {
          key: 'close-ticket',
          connectionId: desk.connectionId,
          capabilityKey: WRITE_TICKETS,
          target: 'tick-9001',
          payload: { status: 'resolved' },
          expectation: { status: 'resolved' },
        },
      ],
    });

    // The run may only start from 'draft' — the workflow owns the chain.
    const run = await startDeepActionRun(aurum, { taskId: created.task.id });
    expect(run.status).toBe('pending');
    // A second start replays the same run (idempotent).
    const replay = await startDeepActionRun(aurum, { taskId: created.task.id });
    expect(replay.id).toBe(run.id);

    // Engine generation A: discover + inspect, then the approval wait.
    const engineA = createWorkflowEngine(createDeepActionWorkflowBindings(aurum));
    const pump1 = await engineA.pump(aurum);
    expect(pump1.status).toBe('suspended');
    expect((await getRun(aurum, { runId: run.id })).status).toBe('waiting');
    const midRun = await getDeepAction(aurum, { taskId: created.task.id });
    expect(midRun.task.status).toBe('inspected');
    for (const operation of midRun.operations) {
      expect(operation.preStateObservationId).not.toBeNull();
    }

    // The approval request waits for a human decision (W009).
    const requests = await listActionRequests(aurum, { actionKind: DEEP_ACTION_ACTION_KIND });
    const gateRequest = requests.find((entry) => entry.status === 'pending')!;
    expect(gateRequest).toBeDefined();
    await decideApproval(boss, { requestId: gateRequest.id, decision: 'approve' });

    // === ENGINE GENERATION A DIES (never consulted again) ===
    // A FRESH engine generation with fresh bindings resumes the SAME run
    // through authorize → execute → verify → reconcile.
    const engineB = createWorkflowEngine(createDeepActionWorkflowBindings(aurum));
    const statuses: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const outcome = await engineB.pump(aurum);
      statuses.push(outcome.status);
      const current = await getRun(aurum, { runId: run.id });
      if (current.status === 'succeeded' || current.status === 'failed') break;
    }
    const finished = await getRun(aurum, { runId: run.id });
    expect(finished.status).toBe('succeeded');
    expect(finished.result).toMatchObject({ taskId: created.task.id, status: 'reconciled', mismatchCount: 0 });

    // The task itself reached the clean terminal state with all links.
    const detail = await getDeepAction(aurum, { taskId: created.task.id });
    expect(detail.task.status).toBe('reconciled');
    expect(detail.task.actionRequestId).toBe(gateRequest.id);
    for (const operation of detail.operations) {
      expect(operation.state).toBe('matched');
      expect(operation.receiptStatus).toBe('accepted');
      expect(operation.postStateObservationId).not.toBeNull();
      expect(operation.reconciledAt).not.toBeNull();
    }
    // The external systems hold the written state.
    expect(transport.stateOf(desk.connectionId, 'tick-9001')).toMatchObject({ status: 'resolved' });
  });

  it('fails the run deterministically when the approval is rejected', async () => {
    const tenant = freshTenant();
    const aurum = member(tenant);
    const boss = approver(tenant);
    const crm = await connectSystem(tenant, 'Acme CRM', ['customer-records']);
    await grantWrites(tenant, crm.connectionId, [WRITE_CUSTOMERS], TASK_CONTEXT);
    transport.seed(crm.connectionId, 'cust-1042', { stage: 'onboarding' });

    const created = await createDeepAction(aurum, {
      taskContext: TASK_CONTEXT,
      operations: [
        {
          key: 'file-crm',
          connectionId: crm.connectionId,
          capabilityKey: WRITE_CUSTOMERS,
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    const run = await startDeepActionRun(aurum, { taskId: created.task.id });
    const engine = createWorkflowEngine(createDeepActionWorkflowBindings(aurum));
    await engine.pump(aurum); // discover + inspect + approval wait
    const requests = await listActionRequests(aurum, { actionKind: DEEP_ACTION_ACTION_KIND });
    const gateRequest = requests.find((entry) => entry.status === 'pending')!;
    await decideApproval(boss, { requestId: gateRequest.id, decision: 'reject' });
    await engine.pump(aurum); // released rejected → task rejected → run fails
    const finished = await getRun(aurum, { runId: run.id });
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('deep_action_approval_rejected');
    const detail = await getDeepAction(aurum, { taskId: created.task.id });
    expect(detail.task.status).toBe('rejected');
    expect(detail.task.actionRequestId).toBe(gateRequest.id);
    expect(transport.executeRequests).toHaveLength(0);
  });
});
