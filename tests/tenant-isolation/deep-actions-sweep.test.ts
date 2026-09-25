// W044 — Tenant Isolation Verification · the deep-actions sweep (W084).
//
// The deep-actions module (W084 — Deep Action Gateway and Reconciliation)
// owns tenant-scoped tables for its concepts: the multi-system task and
// its forward-only phase state, the per-operation plan with its authority
// evidence (the W083 invocation links), opaque action receipts and
// pre/post-state/mismatch evidence observation links, the discovered
// execution surface snapshots, and the append-only lifecycle events.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * a task (and its operations, surface and events) is invisible to the
//     other tenant: every read and every phase call through another
//     tenant's task id is uniformly not-found (no existence leak);
//   * cross-tenant phase advances cannot touch another tenant's task
//     before the not-found refusal (the task status never moves);
//   * each tenant's listings show exactly its own tasks.
//
// The deep per-phase isolation cases live in the module's own suite
// (src/modules/deep-actions/tests/); this sweep is the two-tenant proof
// the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import * as deepActions from '@/modules/deep-actions/contract';
import * as grants from '@/modules/capability-grants/contract';
import * as integration from '@/modules/integration-intelligence/contract';
import * as sources from '@/modules/sources/contract';
import {
  completeConnection,
  createEmbeddedBroker,
  initiateConnection,
  wireConnectionBrokers,
  type BrokerHttpClient,
  type BrokerHttpRequest,
  type BrokerHttpResponse,
} from '@/modules/connection-broker/contract';
import type { SourceFetchResult, SourceTransport } from '@/modules/sources/contract';
import { DeepActionsError } from '@/modules/deep-actions/errors';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: DeepActionsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected DeepActionsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof DeepActionsError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Minimal scripted backends (the sources directory + the embedded broker +
// the deep-action transport — the provider side stays behind the seams)
// ---------------------------------------------------------------------------

class SweepDirectory implements SourceTransport {
  async fetch(): Promise<SourceFetchResult> {
    return {
      records: [
        {
          providerRecordId: 'sweep-dir-1',
          kind: 'directory.system.discovered',
          payload: {
            externalId: 'sweep-crm',
            displayName: 'Sweep CRM',
            capabilityClasses: ['customer-records'],
          },
          occurredAt: '2026-09-23T10:00:00Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
  }
}

class SweepBroker implements BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;

  async request(request: BrokerHttpRequest): Promise<BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st_${this.counter}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: 'https://broker.sweep.example/oauth/x',
          state,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        },
      };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const state = this.authorizations.get(decodeURIComponent(callback[1]!));
      const body = request.body as { state?: string };
      if (state === undefined || body.state !== state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      this.counter += 1;
      const embId = `emb_${this.counter}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: ['read'],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: 'no scripted route' } };
  }
}

/** The fake provider side behind the deep-action transport seam. */
class SweepTransport implements deepActions.DeepActionTransport {
  readonly executeCalls: deepActions.DeepActionExecuteRequest[] = [];
  private states = new Map<string, unknown>();

  async inspect(
    request: deepActions.DeepActionInspectRequest,
  ): Promise<deepActions.DeepActionState> {
    const state = this.states.get(`${request.connectionId}:${request.target}`);
    return { found: true, state: state ?? { stage: 'onboarding' } };
  }

  async execute(
    request: deepActions.DeepActionExecuteRequest,
  ): Promise<deepActions.DeepActionReceipt> {
    this.executeCalls.push(request);
    this.states.set(`${request.connectionId}:${request.target}`, {
      ...(request.payload as Record<string, unknown>),
    });
    return {
      status: 'accepted',
      receiptId: `sweep-rcpt-${this.executeCalls.length}`,
      detail: null,
    };
  }
}

/** Full W081→W082→W083 setup for one tenant: one connected, granted system. */
async function connectSystem(tenantId: string): Promise<string> {
  const adminCtx = memberOf(tenantId, ['integration-intelligence:administer']);
  const memberCtx = memberOf(tenantId);
  const approverCtx = memberOf(tenantId, ['actions:approve']);
  const { source } = await sources.registerSource(adminCtx, {
    provider: 'notion',
    providerAccountId: `ws-${tenantId.slice(0, 8)}`,
    displayName: 'Sweep directory',
    authKind: 'oauth',
    // Fake credential fragments — assembled at runtime.
    credentialRef: ['secret-store://', 'w084-sweep/', `${tenantId.slice(0, 8)}/ref`].join(''),
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await integration.grantDiscoverySource(adminCtx, { sourceId: source.id });
  await integration.runDiscovery(memberCtx, { sourceId: source.id });
  const systems = await integration.listSystems(memberCtx, {});
  const system = systems.find((entry) => entry.displayName === 'Sweep CRM')!;
  const initiated = await initiateConnection(memberCtx, {
    provider: 'notion',
    connectionKey: `sweep-${tenantId.slice(0, 8)}`,
    displayName: 'Sweep CRM',
    inventorySystemId: system.id,
  });
  const completed = await completeConnection(memberCtx, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  const connectionId = completed.connection.id;

  // The progressive write authority: envelope → ask → approve.
  await grants.establishConnectionAccess(memberCtx, { connectionId });
  const ask = await grants.requestCapabilityAuthority(memberCtx, {
    connectionId,
    capabilityKeys: ['write.customer-records'],
    taskContext: { description: 'Sweep write authority' },
  });
  await grants.decideGrantRequest(approverCtx, {
    requestId: ask.request!.id,
    decision: 'approve',
  });
  return connectionId;
}

let transport: SweepTransport;

beforeAll(async () => {
  await runMigrations(getDb());
  sources.setSourceTransport(new SweepDirectory());
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.sweep.example',
      apiToken: ['embedded_tok_', 'sweep', '_fragment'].join(''),
      httpClient: new SweepBroker(),
    }),
  ]);
  transport = new SweepTransport();
  deepActions.setDeepActionTransport(transport);
});

afterAll(async () => {
  sources.setSourceTransport(null);
  wireConnectionBrokers(null);
  deepActions.setDeepActionTransport(null);
  await closeDb();
});

describe('W044 sweep — deep-actions (W084)', () => {
  let connectionA: string;
  let connectionB: string;

  it('the tasks, operations, surface and events stay per-tenant (zero leakage)', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    connectionA = await connectSystem(tenantA);
    connectionB = await connectSystem(tenantB);

    // Each tenant plans a deep action over its own connection.
    const createdA = await deepActions.createDeepAction(memberA, {
      taskContext: { description: 'Sweep tenant A renewal' },
      operations: [
        {
          key: 'file-crm',
          connectionId: connectionA,
          capabilityKey: 'write.customer-records',
          target: 'cust-sweep-a',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    const createdB = await deepActions.createDeepAction(memberB, {
      taskContext: { description: 'Sweep tenant B renewal' },
      operations: [
        {
          key: 'file-crm',
          connectionId: connectionB,
          capabilityKey: 'write.customer-records',
          target: 'cust-sweep-b',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    expect(createdA.task.tenantId).toBe(tenantA);
    expect(createdB.task.tenantId).toBe(tenantB);

    // Cross-tenant reads and phase calls are uniformly not-found —
    // before any state is touched, no existence leak.
    await expectCode('task_not_found', () =>
      deepActions.getDeepAction(memberB, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      deepActions.discoverExecutionSurface(memberB, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      deepActions.inspectTargets(memberB, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      deepActions.listDeepActionEvents(memberB, { taskId: createdA.task.id }),
    );
    // The task itself never moved: A's task is still 'draft' and B's
    // listings hold exactly B's own task.
    expect(
      (await deepActions.getDeepAction(memberA, { taskId: createdA.task.id })).task.status,
    ).toBe('draft');
    expect(await deepActions.listDeepActions(memberB, {})).toHaveLength(1);
    expect((await deepActions.listDeepActions(memberB, {}))[0]!.id).toBe(createdB.task.id);
    expect(await deepActions.listDeepActions(memberA, {})).toHaveLength(1);
  });

  it('the executed evidence, receipts and gate records of one tenant are invisible to the other', async () => {
    const memberA = memberOf(tenantA);
    const approverA = memberOf(tenantA, ['actions:approve']);
    const memberB = memberOf(tenantB);

    // Tenant A walks the whole chain to a reconciled task.
    const [taskA] = await deepActions.listDeepActions(memberA, {});
    expect(taskA).toBeDefined();
    await deepActions.discoverExecutionSurface(memberA, { taskId: taskA!.id });
    await deepActions.inspectTargets(memberA, { taskId: taskA!.id });
    const proposed = await deepActions.proposeDeepAction(memberA, { taskId: taskA!.id });
    const { decideApproval } = await import('@/modules/actions/contract');
    await decideApproval(approverA, {
      requestId: proposed.task.actionRequestId!,
      decision: 'approve',
    });
    await deepActions.authorizeDeepAction(memberA, { taskId: taskA!.id });
    await deepActions.executeDeepAction(memberA, { taskId: taskA!.id });
    await deepActions.verifyDeepAction(memberA, { taskId: taskA!.id });
    const reconciled = await deepActions.reconcileDeepAction(memberA, { taskId: taskA!.id });
    expect(reconciled.task.status).toBe('reconciled');
    // The write happened exactly once, for A's target only.
    expect(transport.executeCalls).toHaveLength(1);
    expect(transport.executeCalls[0]!.target).toBe('cust-sweep-a');

    // Tenant B still sees nothing of A's task, its evidence links or its
    // gate record — uniform not-found on every surface, and B's own task
    // is untouched (still 'draft').
    await expectCode('task_not_found', () =>
      deepActions.getDeepAction(memberB, { taskId: taskA!.id }),
    );
    await expectCode('task_not_found', () =>
      deepActions.executeDeepAction(memberB, { taskId: taskA!.id }),
    );
    await expectCode('task_not_found', () =>
      deepActions.reconcileDeepAction(memberB, { taskId: taskA!.id }),
    );
    const [taskB] = await deepActions.listDeepActions(memberB, {});
    expect(taskB).toBeDefined();
    expect(taskB!.status).toBe('draft');
    // The evidence observations A recorded are readable only in A (the
    // observations contract's own tenant boundary — asserted through the
    // module's links).
    const detailA = await deepActions.getDeepAction(memberA, { taskId: taskA!.id });
    expect(detailA.operations[0]!.preStateObservationId).not.toBeNull();
    expect(detailA.operations[0]!.postStateObservationId).not.toBeNull();
    expect(detailA.task.mismatchCount).toBe(0);
  });
});
