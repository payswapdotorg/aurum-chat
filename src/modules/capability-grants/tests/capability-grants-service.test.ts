// Integration tests for the capability-grants module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W083
// acceptance end-to-end:
//
// "Start with safe read-only access and request write/action authority
//  only when a concrete task requires it. Make every grant visible,
//  scoped, auditable and revocable."
// Acceptance: initial read-only connection; action invocation produces
// human-readable reason and exact requested scope; denial stops the write;
// later retry can request only the missing capability.
//
//  * THE ACCEPTANCE PATH — W081 discovery puts a system in the Tool &
//    System Inventory; a W082 broker connection (embedded broker, scripted
//    backend) binds it; establishConnectionAccess partitions the live
//    surface (reads conferred, writes gated — the INITIAL READ-ONLY
//    CONNECTION); a read invocation is allowed by the floor; a write
//    invocation is DENIED with the human-readable reason and the exact
//    requested scope; the ask goes through the W009 gate (kind
//    'capability-grant' × EXECUTE); rejection stops the write (no grant,
//    still denied); a retry ask for the SAME capability is approved by a
//    human and the write invocation is then ALLOWED under the grant;
//
//  * THE MINIMAL RETRY — a task needing [A, B] where A is already granted
//    asks for ONLY [B] (the request row and the W009 payload carry exactly
//    the missing key); a fully-satisfied ask creates NO request at all;
//
//  * REVOCATION — revoking the grant denies the capability again, with
//    ask-state 'revoked' in the denial's requested scope; revocation is
//    claim-gated and idempotent;
//
//  * POLICY PATHS — the tenant matrix may auto-allow the ask (POLICY
//    approval recorded, grant minted at request time, granted_by
//    'policy') or forbid it outright (POLICY rejection, no grant);
//
//  * SEPARATION OF DUTIES — the requesting principal cannot decide its
//    own ask (delegated to the actions contract); deciding without the
//    approve claim is forbidden; deciding a non-pending request refuses;
//
//  * STATE DISCIPLINE — establish on a pending/unbound connection, invoke
//    without an envelope, unknown capability keys, duplicate open asks
//    (request_pending), unknown-key input rejection;
//
//  * TENANT ISOLATION — two tenants, zero leakage (uniform not-found, no
//    cross-tenant establish/invoke/read);
//
//  * STORAGE DISCIPLINE — the invocations and grant-events ledgers are
//    append-only (UPDATE/DELETE/TRUNCATE refused at the storage level).

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
import { ActionsError } from '@/modules/actions/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { CapabilityGrantsError } from '../errors';
import * as grants from '../contract';
import type {
  BrokerHttpClient,
  BrokerHttpRequest,
  BrokerHttpResponse,
} from '@/modules/connection-broker/contract';
import type { CanonicalSourceRecord, SourceFetchResult, SourceTransport } from '@/modules/sources/contract';

const {
  decideGrantRequest,
  establishConnectionAccess,
  getCapabilityGrant,
  getCapabilityInvocation,
  getConnectionAccess,
  getGrantRequest,
  invokeCapability,
  listCapabilityGrants,
  listCapabilityInvocations,
  listGrantEvents,
  listGrantRequests,
  requestCapabilityAuthority,
  revokeCapabilityGrant,
  CAPABILITY_GRANT_ACTION_KIND,
  CAPABILITY_GRANTS_AUTHORITY_ADMINISTER,
} = grants;

const { listActionRequests, listApprovalDecisions, setAuthorityPolicy } = actionsContract;
const { grantDiscoverySource, listSystems, runDiscovery } = integrationContract;
const { registerSource, setSourceTransport } = sourcesContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;

// A FRESH tenant per test so counts stay deterministic (every test owns its
// own sources, inventory, connections, envelopes, grants and policies).
function freshTenant(): string {
  return newId();
}

// Stable principals per tenant (separation of duties: the requester of an
// ask is never its decider — the actions contract enforces it).
function principal(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function admin(ctx: TenantContext): TenantContext {
  return { ...ctx, authority: [...ctx.authority, CAPABILITY_GRANTS_AUTHORITY_ADMINISTER] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

// Fake credentials are assembled from fragments at runtime (never a
// realistic full token literal in source — GitHub push protection).
function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w083/` + `${label}/` + 'ref';
}

async function expectGrantsError(
  code: CapabilityGrantsError['code'],
  fn: () => Promise<unknown>,
): Promise<CapabilityGrantsError> {
  try {
    await fn();
    throw new Error(`expected CapabilityGrantsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof CapabilityGrantsError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

// ---------------------------------------------------------------------------
// Stubbed transports
// ---------------------------------------------------------------------------

/** A provider-neutral source transport that records every fetch request. */
class ScriptedDirectoryTransport implements SourceTransport {
  readonly requests: unknown[] = [];
  private windows: SourceFetchResult[] = [];

  script(...windows: SourceFetchResult[]): void {
    this.windows.push(...windows);
  }

  async fetch(request: unknown): Promise<SourceFetchResult> {
    this.requests.push(request);
    const next = this.windows.shift();
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

/**
 * A fake managed-broker server implementing the embedded wire dialect
 * (authorization + callback — the connect lifecycle W083 rides on; sync and
 * webhook routes are not exercised by this module).
 */
class ScriptedBrokerBackend implements BrokerHttpClient {
  readonly requests: BrokerHttpRequest[] = [];
  private authorizations = new Map<string, string>();
  private counter = 0;

  constructor(private readonly nowProvider: () => Date) {}

  async request(request: BrokerHttpRequest): Promise<BrokerHttpResponse> {
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
      const expiresAt = new Date(this.nowProvider().getTime() + 3_600_000).toISOString();
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: [],
          expires_at: expiresAt,
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

/** One canonical directory record (the discovery-source adapter output). */
function directoryRecord(
  externalId: string,
  displayName: string,
  capabilityClasses: string[],
): CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${externalId}`,
    kind: 'directory.system.discovered',
    payload: { externalId, displayName, capabilityClasses },
    occurredAt: '2026-09-23T10:00:00Z',
  };
}

function windowOf(records: CanonicalSourceRecord[]): SourceFetchResult {
  return { records, nextCursor: null, hasMore: false };
}

let directoryTransport: ScriptedDirectoryTransport;
let brokerBackend: ScriptedBrokerBackend;

const BASE_TIME = Date.parse('2026-09-23T12:00:00Z');
let clockMs = BASE_TIME;

function advance(seconds: number): void {
  clockMs += seconds * 1_000;
}

let accountCounter = 0;

/**
 * The full W081→W082 setup for one connected system: register a directory
 * source, admin-grant discovery, discover the system, connect it through
 * the (scripted) embedded broker and return the pair.
 */
async function connectSystem(
  tenantId: string,
  displayName: string,
  capabilityClasses: string[],
): Promise<{ connectionId: string; systemId: string }> {
  const adminCtx = { tenantId, principalId: newId(), authority: ['integration-intelligence:administer'] };
  const memberCtx = principal(tenantId);

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
  directoryTransport.script(windowOf([directoryRecord(`app-${accountCounter}`, displayName, capabilityClasses)]));
  await runDiscovery(memberCtx, { sourceId: source.id });
  const systems = await listSystems(memberCtx, {});
  const system = systems.find((entry) => entry.displayName === displayName)!;

  const initiation = await initiateConnection(memberCtx, {
    provider: 'notion',
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

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setSourceTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  directoryTransport = new ScriptedDirectoryTransport();
  brokerBackend = new ScriptedBrokerBackend(() => new Date(clockMs));
  setSourceTransport(directoryTransport);
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.unit.example',
      apiToken: ['emb_', 'test', '_token'].join(''),
      httpClient: brokerBackend,
    }),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSourceTransport(null);
  wireConnectionBrokers(null);
});

// The plain-language capability keys of the CRM test fixture (the W081
// registry's customer-records + sales-pipeline classes).
const READ_CUSTOMERS = 'read.customer-records';
const WRITE_CUSTOMERS = 'write.customer-records';
const WRITE_DEALS = 'write.sales-pipeline';

const TASK = {
  description: 'File signed contracts into the CRM',
  requestedFor: 'Q3 close',
};
const OTHER_TASK = {
  description: 'Update the deal stages after the pipeline review',
  requestedFor: null,
};

// ---------------------------------------------------------------------------
// The acceptance path
// ---------------------------------------------------------------------------

describe('W083 acceptance path: read-only start → denied ask-later write → approve → allowed', () => {
  it('walks the whole progressive journey through the real contracts', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant); // the intelligence employee (member)
    const boss = approver(tenant);

    const { connectionId } = await connectSystem(tenant, 'Acme CRM', [
      'customer-records',
      'sales-pipeline',
    ]);

    // -- INITIAL READ-ONLY CONNECTION: the envelope partitions the live
    //    surface. Reads conferred, writes gated. Nothing else exists yet.
    const access = await establishConnectionAccess(aurum, { connectionId });
    expect(access.connectionId).toBe(connectionId);
    expect(access.systemDisplayName).toBe('Acme CRM');
    expect(access.readCapabilities.map((capability) => capability.key).sort()).toEqual([
      'read.customer-records',
      'read.sales-pipeline',
    ]);
    expect(access.writeCapabilities.map((capability) => capability.key).sort()).toEqual([
      WRITE_CUSTOMERS,
      WRITE_DEALS,
    ]);
    const view = await getConnectionAccess(aurum, { connectionId });
    expect(view.connectionMode).toBe('read-only');
    expect(view.activeGrants).toEqual([]);
    expect(view.pendingRequestIds).toEqual([]);

    // -- A READ invocation is allowed by the floor (the safe start).
    const readInvocation = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: READ_CUSTOMERS,
      taskContext: TASK,
    });
    expect(readInvocation.outcome).toBe('allowed');
    expect(readInvocation.basis).toBe('read-only-floor');
    expect(readInvocation.grantId).toBeNull();
    expect(readInvocation.denial).toBeNull();
    expect(readInvocation.capabilityMode).toBe('read');

    // -- A WRITE invocation is DENIED: human-readable reason + the exact
    //    requested scope. The write did not happen (no grant exists).
    const deniedWrite = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: WRITE_CUSTOMERS,
      taskContext: TASK,
    });
    expect(deniedWrite.outcome).toBe('denied');
    expect(deniedWrite.basis).toBe('grant-missing');
    expect(deniedWrite.capabilityMode).toBe('write');
    expect(deniedWrite.grantId).toBeNull();
    expect(deniedWrite.denial).not.toBeNull();
    // The human-readable reason: the task, the capability in plain
    // language, the read-only state, the stopped write.
    expect(deniedWrite.denial!.reason).toContain('the task "File signed contracts into the CRM" (for Q3 close)');
    expect(deniedWrite.denial!.reason).toContain('"Edit customer records"');
    expect(deniedWrite.denial!.reason).toContain('The connection is read-only');
    expect(deniedWrite.denial!.reason).toContain('The write is stopped');
    // The EXACT requested scope: one capability, fully described.
    expect(deniedWrite.denial!.requestedScope).toHaveLength(1);
    expect(deniedWrite.denial!.requestedScope[0]).toMatchObject({
      key: WRITE_CUSTOMERS,
      label: 'Edit customer records',
      state: 'unrequested',
    });
    expect(deniedWrite.denial!.requestedScope[0]!.dataCategories).toContain('customer-contacts');
    expect(deniedWrite.denial!.alreadyGranted).toEqual([]);

    // -- THE ASK routes through the W009 gate.
    const ask = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    expect(ask.request).not.toBeNull();
    expect(ask.request!.status).toBe('pending_approval');
    expect(ask.request!.capabilityKeys).toEqual([WRITE_CUSTOMERS]);
    expect(ask.request!.reason).toContain('File signed contracts into the CRM');
    expect(ask.request!.requestedScope.map((capability) => capability.key)).toEqual([WRITE_CUSTOMERS]);
    expect(ask.conferredReadCapabilities.map((capability) => capability.key).sort()).toEqual([
      'read.customer-records',
      'read.sales-pipeline',
    ]);
    // The W009 gate record: kind 'capability-grant', level EXECUTE,
    // requested by the member, justification IS the human-readable reason.
    const gateRequests = await listActionRequests(boss, { actionKind: CAPABILITY_GRANT_ACTION_KIND });
    const gateRequest = gateRequests.find((entry) => entry.id === ask.request!.actionRequestId)!;
    expect(gateRequest).toBeDefined();
    expect(gateRequest.status).toBe('pending');
    expect(gateRequest.authorityLevel).toBe('EXECUTE');
    expect(gateRequest.requestedBy).toBe(aurum.principalId);
    expect(gateRequest.justification).toBe(ask.request!.reason);
    // The approver-facing payload carries the reason and the exact scope.
    const payload = gateRequest.payload as {
      reason: string;
      requestedScope: { key: string; label: string; state: string }[];
      alreadyGranted: unknown[];
      taskContext: { description: string };
    };
    expect(payload.reason).toBe(ask.request!.reason);
    expect(payload.requestedScope.map((capability) => capability.key)).toEqual([WRITE_CUSTOMERS]);
    expect(payload.taskContext.description).toBe(TASK.description);
    expect(payload.alreadyGranted).toEqual([]);

    // -- DENIAL STOPS THE WRITE: the human rejects the ask; no grant is
    //    minted; the write stays denied (and says so honestly).
    const rejected = await decideGrantRequest(boss, {
      requestId: ask.request!.id,
      decision: 'reject',
      note: 'not for the quarterly close',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedAt).not.toBeNull();
    expect(await listCapabilityGrants(aurum, { connectionId })).toHaveLength(0);
    const stillDenied = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: WRITE_CUSTOMERS,
      taskContext: TASK,
    });
    expect(stillDenied.outcome).toBe('denied');
    expect(stillDenied.denial!.requestedScope[0]!.state).toBe('rejected');

    // -- A LATER RETRY: a NEW concrete task re-asks for the SAME (still
    //    missing) capability; the human approves; the grant is minted.
    const retryTask = { description: 'Sync renewed contracts from the signing tool' };
    const retry = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: retryTask,
    });
    expect(retry.request).not.toBeNull();
    expect(retry.request!.status).toBe('pending_approval');
    expect(retry.request!.capabilityKeys).toEqual([WRITE_CUSTOMERS]);
    const approved = await decideGrantRequest(boss, {
      requestId: retry.request!.id,
      decision: 'approve',
      note: 'needed for contract sync',
    });
    expect(approved.status).toBe('approved');
    const grantsNow = await listCapabilityGrants(aurum, { connectionId, status: 'active' });
    expect(grantsNow).toHaveLength(1);
    const grant = grantsNow[0]!;
    // SCOPED: exactly the approved capability keys + frozen detail.
    expect(grant.capabilityKeys).toEqual([WRITE_CUSTOMERS]);
    expect(grant.scopeDetail[0]).toMatchObject({ key: WRITE_CUSTOMERS, label: 'Edit customer records' });
    expect(grant.grantedVia).toBe(retry.request!.id);
    expect(grant.grantedBy).toBe(boss.principalId);
    expect(grant.status).toBe('active');

    // -- The write invocation is now ALLOWED under the grant.
    const allowedWrite = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: WRITE_CUSTOMERS,
      taskContext: retryTask,
    });
    expect(allowedWrite.outcome).toBe('allowed');
    expect(allowedWrite.basis).toBe('capability-grant');
    expect(allowedWrite.grantId).toBe(grant.id);
    expect(allowedWrite.denial).toBeNull();

    // -- The OTHER write capability stays gated (scope is narrow).
    const dealsDenied = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: WRITE_DEALS,
      taskContext: OTHER_TASK,
    });
    expect(dealsDenied.outcome).toBe('denied');
    expect(dealsDenied.denial!.requestedScope[0]).toMatchObject({
      key: WRITE_DEALS,
      label: 'Edit deals and pipeline stages',
      state: 'unrequested',
    });
    // The denial contrasts what IS held.
    expect(dealsDenied.denial!.alreadyGranted).toMatchObject([
      { key: WRITE_CUSTOMERS, grantId: grant.id },
    ]);
    expect(dealsDenied.denial!.reason).toContain('holds write authority only for "Edit customer records"');

    // -- VISIBILITY: every record is readable.
    const fetchedGrant = await getCapabilityGrant(aurum, { grantId: grant.id });
    expect(fetchedGrant.id).toBe(grant.id);
    const fetchedRequest = await getGrantRequest(aurum, { requestId: retry.request!.id });
    expect(fetchedRequest.id).toBe(retry.request!.id);
    const invocations = await listCapabilityInvocations(aurum, { connectionId });
    expect(invocations).toHaveLength(5); // 1 read allowed + 3 denied + 1 allowed
    expect(invocations.filter((entry) => entry.outcome === 'denied')).toHaveLength(3);
    expect(invocations.filter((entry) => entry.outcome === 'allowed')).toHaveLength(2);
    const deniedInvocations = await listCapabilityInvocations(aurum, { outcome: 'denied' });
    expect(deniedInvocations).toHaveLength(3);
    const byKey = await listCapabilityInvocations(aurum, { capabilityKey: WRITE_CUSTOMERS });
    expect(byKey).toHaveLength(3);
    const single = await getCapabilityInvocation(aurum, { invocationId: invocations[0]!.id });
    expect(single.id).toBe(invocations[0]!.id);
    const events = await listGrantEvents(aurum, { connectionId });
    const eventKinds = events.map((entry) => entry.event);
    expect(eventKinds).toContain('access-established');
    expect(eventKinds).toContain('authority-requested');
    expect(eventKinds).toContain('authority-rejected');
    expect(eventKinds).toContain('authority-granted');
    const liveView = await getConnectionAccess(aurum, { connectionId });
    expect(liveView.connectionMode).toBe('elevated');
    expect(liveView.activeGrants).toMatchObject([{ key: WRITE_CUSTOMERS, grantId: grant.id }]);

    // -- AUDIT: the W009 decision trail of the approved ask.
    const decisions = await listApprovalDecisions(boss, { requestId: retry.request!.actionRequestId });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'approve',
      decidedBy: 'principal',
      principalId: boss.principalId,
    });
  });

  it('re-asking subtracts active grants — the retry requests ONLY the missing capability', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const boss = approver(tenant);

    const { connectionId } = await connectSystem(tenant, 'Deal CRM', [
      'customer-records',
      'sales-pipeline',
    ]);
    await establishConnectionAccess(aurum, { connectionId });

    // The first task needs only write.customers; the ask carries it (the
    // full missing set — write.deals is not needed yet, so it is NOT asked).
    const first = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    expect(first.request!.capabilityKeys).toEqual([WRITE_CUSTOMERS]);
    await decideGrantRequest(boss, { requestId: first.request!.id, decision: 'approve' });
    const [grant] = await listCapabilityGrants(aurum, { connectionId });
    expect(grant!.capabilityKeys).toEqual([WRITE_CUSTOMERS]);

    // A second, larger task needs [write.customers, write.deals] — but
    // write.customers is already granted: the NEW ask carries ONLY
    // write.deals ("later retry can request only the missing capability").
    const second = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS, WRITE_DEALS],
      taskContext: OTHER_TASK,
    });
    expect(second.request).not.toBeNull();
    expect(second.request!.capabilityKeys).toEqual([WRITE_DEALS]);
    expect(second.request!.requestedScope.map((capability) => capability.key)).toEqual([WRITE_DEALS]);
    expect(second.alreadyGranted).toMatchObject([{ key: WRITE_CUSTOMERS, grantId: grant!.id }]);
    // The W009 payload asks for exactly the missing key.
    const gateRequests = await listActionRequests(boss, { actionKind: CAPABILITY_GRANT_ACTION_KIND });
    const gateRequest = gateRequests.find((entry) => entry.id === second.request!.actionRequestId)!;
    const payload = gateRequest.payload as { requestedScope: { key: string }[] };
    expect(payload.requestedScope.map((capability) => capability.key)).toEqual([WRITE_DEALS]);

    // A fully satisfied ask creates NO request at all (read keys are
    // conferred by the floor; the first grant covers write.customers).
    const satisfied = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [READ_CUSTOMERS, WRITE_CUSTOMERS],
      taskContext: OTHER_TASK,
    });
    expect(satisfied.request).toBeNull();
    expect(satisfied.conferredReadCapabilities.map((capability) => capability.key).sort()).toEqual([
      'read.customer-records',
      'read.sales-pipeline',
    ]);
    expect(satisfied.alreadyGranted.map((capability) => capability.key)).toEqual([WRITE_CUSTOMERS]);
    // No new gate history was created for the satisfied ask.
    const after = await listActionRequests(boss, { actionKind: CAPABILITY_GRANT_ACTION_KIND });
    expect(after).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

describe('revocation', () => {
  it('takes the authority back with a full trail and re-enables the honest ask', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const boss = approver(tenant);
    const adminAurum = admin(aurum);

    const { connectionId } = await connectSystem(tenant, 'Revocable CRM', ['customer-records']);
    await establishConnectionAccess(aurum, { connectionId });
    const ask = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    await decideGrantRequest(boss, { requestId: ask.request!.id, decision: 'approve' });
    const [grant] = await listCapabilityGrants(aurum, { connectionId });

    // Claim-gated: a plain member cannot revoke.
    await expectGrantsError('forbidden', () =>
      revokeCapabilityGrant(aurum, { grantId: grant!.id }),
    );

    // The admin revokes with a note.
    advance(60);
    const revoked = await revokeCapabilityGrant(adminAurum, {
      grantId: grant!.id,
      note: 'quarter ended',
    });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedBy).toBe(adminAurum.principalId);
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revocationNote).toBe('quarter ended');

    // Idempotent: revoking again returns the same state.
    const again = await revokeCapabilityGrant(adminAurum, { grantId: grant!.id });
    expect(again.status).toBe('revoked');
    expect(again.revokedAt).toBe(revoked.revokedAt);

    // The capability is denied again — with ask-state 'revoked'.
    const denied = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: WRITE_CUSTOMERS,
      taskContext: TASK,
    });
    expect(denied.outcome).toBe('denied');
    expect(denied.denial!.requestedScope[0]!.state).toBe('revoked');
    expect(denied.denial!.alreadyGranted).toEqual([]);

    // A new ask is possible (a revoked grant does not permanently forbid —
    // permanence belongs to the W009 matrix, not to revocation).
    const reAsk = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: OTHER_TASK,
    });
    expect(reAsk.request!.requestedScope[0]).toMatchObject({ key: WRITE_CUSTOMERS, state: 'revoked' });

    // The lifecycle ledger carries the revocation.
    const events = await listGrantEvents(aurum, { connectionId });
    expect(events.map((entry) => entry.event)).toContain('authority-revoked');
    const revokedGrants = await listCapabilityGrants(aurum, { connectionId, status: 'revoked' });
    expect(revokedGrants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Policy paths (the matrix decides — W009 never bypassed)
// ---------------------------------------------------------------------------

describe('tenant policy paths', () => {
  it('auto-allows the ask when the matrix allows EXECUTE of capability-grant (policy approval recorded)', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const matrixAdmin = { tenantId: tenant, principalId: newId(), authority: ['actions:administer'] };

    const { connectionId } = await connectSystem(tenant, 'Trusted CRM', ['customer-records']);
    await establishConnectionAccess(aurum, { connectionId });
    await setAuthorityPolicy(matrixAdmin, {
      actionKind: CAPABILITY_GRANT_ACTION_KIND,
      approvalLevels: [],
      forbiddenLevels: [],
      note: 'this tenant trusts its own asks',
    });

    const result = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    // POLICY approval: the ask is decided at request time.
    expect(result.request!.status).toBe('approved');
    expect(result.request!.decidedAt).not.toBeNull();
    // The grant is minted immediately, granted_by 'policy'.
    const grants = await listCapabilityGrants(aurum, { connectionId });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.grantedBy).toBe('policy');
    expect(grants[0]!.capabilityKeys).toEqual([WRITE_CUSTOMERS]);
    // The write is allowed under it.
    const allowed = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: WRITE_CUSTOMERS,
      taskContext: TASK,
    });
    expect(allowed.outcome).toBe('allowed');
    expect(allowed.grantId).toBe(grants[0]!.id);
    // The W009 trail records the POLICY decision.
    const decisions = await listApprovalDecisions(aurum, { requestId: result.request!.actionRequestId });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decidedBy).toBe('policy');
  });

  it('forbids the ask outright when the matrix forbids EXECUTE (policy rejection recorded)', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const boss = approver(tenant);
    const matrixAdmin = { tenantId: tenant, principalId: newId(), authority: ['actions:administer'] };

    const { connectionId } = await connectSystem(tenant, 'Locked CRM', ['customer-records']);
    await establishConnectionAccess(aurum, { connectionId });
    await setAuthorityPolicy(matrixAdmin, {
      actionKind: CAPABILITY_GRANT_ACTION_KIND,
      forbiddenLevels: ['EXECUTE'],
      note: 'no write authority on any connection, ever',
    });

    const result = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    expect(result.request!.status).toBe('rejected');
    expect(result.request!.decidedAt).not.toBeNull();
    // No grant, no authority.
    expect(await listCapabilityGrants(aurum, { connectionId })).toHaveLength(0);
    const denied = await invokeCapability(aurum, {
      connectionId,
      capabilityKey: WRITE_CUSTOMERS,
      taskContext: TASK,
    });
    expect(denied.outcome).toBe('denied');
    expect(denied.denial!.requestedScope[0]!.state).toBe('rejected');
    // A human approver cannot override the matrix: the request is terminal.
    await expectGrantsError('grant_request_not_pending', () =>
      decideGrantRequest(boss, { requestId: result.request!.id, decision: 'approve' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Separation of duties + decide discipline
// ---------------------------------------------------------------------------

describe('decide discipline (delegated to the actions contract)', () => {
  it('the requester never decides its own ask; the approve claim is required; only pending requests move', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const boss = approver(tenant);
    const plainMember = principal(tenant);

    const { connectionId } = await connectSystem(tenant, 'Duty CRM', ['customer-records']);
    await establishConnectionAccess(aurum, { connectionId });
    const ask = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });

    // The requesting principal may NEVER decide its own request.
    const selfDecider = { tenantId: tenant, principalId: aurum.principalId, authority: ['actions:approve'] };
    await expect(
      decideGrantRequest(selfDecider, { requestId: ask.request!.id, decision: 'approve' }),
    ).rejects.toThrow(ActionsError);

    // Deciding requires the approve claim.
    await expect(
      decideGrantRequest(plainMember, { requestId: ask.request!.id, decision: 'approve' }),
    ).rejects.toThrow(ActionsError);

    // Decide it properly, then: first decision wins, terminal.
    await decideGrantRequest(boss, { requestId: ask.request!.id, decision: 'approve' });
    await expectGrantsError('grant_request_not_pending', () =>
      decideGrantRequest(boss, { requestId: ask.request!.id, decision: 'reject' }),
    );
    // The grant mints exactly once.
    expect(await listCapabilityGrants(aurum, { connectionId })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// State discipline
// ---------------------------------------------------------------------------

describe('state discipline', () => {
  it('refuses establish on a pending or unbound connection, and invoke without an envelope', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);

    // A PENDING (not completed) connection cannot establish access.
    accountCounter += 1;
    const pending = await initiateConnection(aurum, {
      provider: 'notion',
      connectionKey: `conn-${accountCounter}`,
      displayName: 'Pending CRM',
    });
    await expectGrantsError('connection_not_connected', () =>
      establishConnectionAccess(aurum, { connectionId: pending.connection.id }),
    );

    // An UNBOUND connection (no inventory system) cannot derive a surface.
    accountCounter += 1;
    const unbound = await initiateConnection(aurum, {
      provider: 'notion',
      connectionKey: `conn-${accountCounter}`,
      displayName: 'Unbound API',
    });
    const unboundConnected = await completeConnection(aurum, {
      connectionId: unbound.connection.id,
      state: unbound.authorization.state,
    });
    await expectGrantsError('connection_not_bound', () =>
      establishConnectionAccess(aurum, { connectionId: unboundConnected.connection.id }),
    );

    // Invoking without the envelope refuses (the read-only start is a
    // mandatory, visible state).
    const { connectionId } = await connectSystem(tenant, 'Strict CRM', ['customer-records']);
    await expectGrantsError('access_not_established', () =>
      invokeCapability(aurum, {
        connectionId,
        capabilityKey: READ_CUSTOMERS,
        taskContext: TASK,
      }),
    );
    await expectGrantsError('access_not_found', () =>
      getConnectionAccess(aurum, { connectionId }),
    );
  });

  it('refuses unknown capability keys and duplicate open asks', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const boss = approver(tenant);

    const { connectionId } = await connectSystem(tenant, 'Strict CRM', ['customer-records']);
    await establishConnectionAccess(aurum, { connectionId });

    // A capability not on the surface cannot be invoked or asked for.
    await expectGrantsError('capability_not_offered', () =>
      invokeCapability(aurum, {
        connectionId,
        capabilityKey: 'write.support-desk',
        taskContext: TASK,
      }),
    );
    await expectGrantsError('capability_not_offered', () =>
      requestCapabilityAuthority(aurum, {
        connectionId,
        capabilityKeys: ['write.support-desk'],
        taskContext: TASK,
      }),
    );

    // One open ask at a time.
    const ask = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    await expectGrantsError('request_pending', () =>
      requestCapabilityAuthority(aurum, {
        connectionId,
        capabilityKeys: [WRITE_CUSTOMERS],
        taskContext: OTHER_TASK,
      }),
    );
    // Deciding it unblocks new asks.
    await decideGrantRequest(boss, { requestId: ask.request!.id, decision: 'reject' });
    const reAsk = await requestCapabilityAuthority(aurum, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: OTHER_TASK,
    });
    expect(reAsk.request!.requestedScope[0]!.state).toBe('rejected');
  });

  it('rejects unknown input keys and malformed contexts before touching state', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const { connectionId } = await connectSystem(tenant, 'Input CRM', ['customer-records']);
    await establishConnectionAccess(aurum, { connectionId });

    await expectGrantsError('invalid_input', () =>
      invokeCapability(aurum, {
        connectionId,
        capabilityKey: READ_CUSTOMERS,
        taskContext: TASK,
        extra: 'no',
      } as never),
    );
    await expectGrantsError('invalid_input', () =>
      requestCapabilityAuthority(aurum, {
        connectionId,
        capabilityKeys: [],
        taskContext: TASK,
      }),
    );
    await expectGrantsError('invalid_input', () =>
      invokeCapability(aurum, {
        connectionId,
        capabilityKey: READ_CUSTOMERS,
        taskContext: { description: '' },
      }),
    );
    await expectGrantsError('invalid_input', () =>
      establishConnectionAccess(aurum, { connectionId: 'not-a-uuid' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('another tenant sees nothing: uniform not-found, no cross-tenant establish/invoke/read', async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const aurumA = principal(tenantA);
    const aurumB = principal(tenantB);

    const { connectionId } = await connectSystem(tenantA, 'Isolated CRM', ['customer-records']);
    await establishConnectionAccess(aurumA, { connectionId });
    const ask = await requestCapabilityAuthority(aurumA, {
      connectionId,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    const bossA = approver(tenantA);
    await decideGrantRequest(bossA, { requestId: ask.request!.id, decision: 'approve' });
    const [grantA] = await listCapabilityGrants(aurumA, { connectionId });
    // One invocation ledger entry in A (the read floor).
    await invokeCapability(aurumA, {
      connectionId,
      capabilityKey: READ_CUSTOMERS,
      taskContext: TASK,
    });
    const invocationsA = await listCapabilityInvocations(aurumA, { connectionId });
    expect(invocationsA).toHaveLength(1);

    // Tenant B cannot establish on A's connection (the broker's uniform
    // not-found — no existence leak).
    await expectGrantsError('connection_not_found', () =>
      establishConnectionAccess(aurumB, { connectionId }),
    );
    await expectGrantsError('connection_not_found', () =>
      invokeCapability(aurumB, {
        connectionId,
        capabilityKey: READ_CUSTOMERS,
        taskContext: TASK,
      }),
    );
    await expectGrantsError('connection_not_found', () =>
      requestCapabilityAuthority(aurumB, {
        connectionId,
        capabilityKeys: [WRITE_CUSTOMERS],
        taskContext: TASK,
      }),
    );
    // Uniform not-found on every read surface.
    await expectGrantsError('access_not_found', () => getConnectionAccess(aurumB, { connectionId }));
    await expectGrantsError('grant_not_found', () =>
      getCapabilityGrant(aurumB, { grantId: grantA!.id }),
    );
    await expectGrantsError('grant_request_not_found', () =>
      getGrantRequest(aurumB, { requestId: ask.request!.id }),
    );
    await expectGrantsError('invocation_not_found', () =>
      getCapabilityInvocation(aurumB, { invocationId: invocationsA[0]!.id }),
    );
    await expectGrantsError('access_not_found', () =>
      listGrantEvents(aurumB, { connectionId }),
    );
    // And B's listings are empty.
    expect(await listCapabilityGrants(aurumB, {})).toHaveLength(0);
    expect(await listGrantRequests(aurumB, {})).toHaveLength(0);
    expect(await listCapabilityInvocations(aurumB, {})).toHaveLength(0);

    // Tenant B's own world stays separate: a full second tenant with its
    // own system/grant does not leak into A's counts.
    const { connectionId: connectionB } = await connectSystem(tenantB, 'Beta CRM', ['customer-records']);
    await establishConnectionAccess(aurumB, { connectionId: connectionB });
    const askB = await requestCapabilityAuthority(aurumB, {
      connectionId: connectionB,
      capabilityKeys: [WRITE_CUSTOMERS],
      taskContext: TASK,
    });
    await decideGrantRequest(approver(tenantB), { requestId: askB.request!.id, decision: 'approve' });
    expect(await listCapabilityGrants(aurumA, {})).toHaveLength(1);
    expect(await listCapabilityGrants(aurumB, {})).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (append-only ledgers)
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('the invocations and grant-events ledgers are append-only at the storage level', async () => {
    const tenant = freshTenant();
    const aurum = principal(tenant);
    const { connectionId } = await connectSystem(tenant, 'Ledger CRM', ['customer-records']);
    await establishConnectionAccess(aurum, { connectionId });
    await invokeCapability(aurum, {
      connectionId,
      capabilityKey: READ_CUSTOMERS,
      taskContext: TASK,
    });

    const db = getDb();
    await expect(db.query(`UPDATE capability_invocations SET outcome = 'allowed'`)).rejects.toThrowError(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM capability_invocations`)).rejects.toThrowError(/append-only/);
    await expect(db.query(`UPDATE capability_grant_events SET detail = 'x'`)).rejects.toThrowError(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM capability_grant_events`)).rejects.toThrowError(/append-only/);
    // The records survive untouched.
    expect(await listCapabilityInvocations(aurum, { connectionId })).toHaveLength(1);
    expect(await listGrantEvents(aurum, { connectionId })).not.toHaveLength(0);
  });
});
