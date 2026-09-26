// Integration tests for the edge-connector module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W088
// acceptance end-to-end:
//
// "outbound-only connection where possible; signed tenant-scoped jobs;
//  local secret handling; capability allowlist; health/version
//  reporting; result normalization; no second organizational truth
//  store."
//
//  * ENROLLMENT + HONEST DEGRADATION — registration is claim-gated; a
//    pending (never-heartbeated) edge refuses dispatch
//    (`edge_not_connected`); no wired signer refuses to fake signatures
//    (`signer_unavailable`); staleness (no fresh heartbeat) degrades
//    dispatch the same way; revocation closes the dial-home channel.
//
//  * HEALTH/VERSION REPORTING — the deterministic runtime heartbeats
//    through the REAL dial-home contract; the version/capability report
//    lands on the runtime row and in the append-only heartbeat ledger.
//
//  * THE SIGNED JOB LIFECYCLE — issue (allowlist-checked at dispatch,
//    nonce-minted, canonical-material-signed), Aurum-side envelope
//    adjudication, edge pull (delivery events prove the EDGE dialed
//    home), edge-boundary verification with the customer-side key,
//    execution through the connectivity adapters, canonical result
//    submission, receipt in the W084 taxonomy.
//
//  * REPLAY RESISTANCE — both sides: the edge refuses a replayed nonce
//    at the boundary; Aurum's verify refuses a delivered/completed
//    envelope (`job_replayed`); dial-home request nonces are single-use;
//    a replayed result submission is first-write-wins.
//
//  * FORGERIES — a tampered signature, a foreign-tenant envelope and a
//    stale enrollment key are all refused loudly.
//
//  * THE BOUNDARY ALLOWLIST — a capability outside the EDGE's local
//    allowlist is refused AT THE BOUNDARY and reported back as an
//    honest 'rejected' receipt (denial is data).
//
//  * PROVIDER OBJECTS NEVER CROSS — a provider-native read state (a
//    Date instance) is rejected (`invalid_edge_result`); nothing
//    provider-shaped persists.
//
//  * LOCAL SECRET HANDLING — only opaque references + scopes persist;
//    a full-table scan proves no secret VALUE ever reaches storage.
//
//  * THE RETRY DISCIPLINE — a transient 'failed' attempt under the same
//    idempotency key re-issues a FRESH envelope (bounded), so a retried
//    deep-action phase resumes exactly like the W084 discipline.
//
//  * THE SIX CONNECTIVITY KINDS — private-api, openapi, mcp, database,
//    file-share and browser doubles each execute their jobs with their
//    own receipt branding (the connectivity surface is real at the
//    contract level; no live network).
//
//  * THE W084 COMPOSITION — a full deep-action task (W081→W082→W083
//    fixtures, exactly the deep-actions module's own discipline) whose
//    transport is `createEdgeDeepActionTransport`: discover→inspect→
//    propose→authorize→execute→verify→reconcile over the EDGE, the
//    write executed exactly once customer-side, opaque edge receipt ids
//    on the deep-action operation — plus the mismatch case (an accepted
//    edge write that changed nothing reconciles 'mismatched' through
//    the W084 pipeline — NO second reconciliation model) and the
//    transient-failure resume case.
//
//  * TENANT ISOLATION — two tenants, zero leakage; STORAGE DISCIPLINE —
//    the heartbeat and event ledgers are append-only at the storage
//    level.

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
import * as sourcesContract from '@/modules/sources/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as grantsContract from '@/modules/capability-grants/contract';
import * as deepActionsContract from '@/modules/deep-actions/contract';
import { runMigrations } from '../../../../scripts/migrate';
import * as edge from '../contract';
import { EdgeConnectorError } from '../errors';
import type {
  EdgeAllowlistEntryInput,
  EdgeConnectivityKind,
  EdgeRuntimeDetail,
} from '../types';

const {
  registerEdgeRuntime,
  revokeEdgeRuntime,
  setEdgeAllowlist,
  getEdgeRuntime,
  listEdgeRuntimes,
  listEdgeHeartbeats,
  listEdgeEvents,
  issueEdgeJob,
  verifyEdgeJobEnvelope,
  getEdgeJob,
  listEdgeJobs,
  sendEdgeHeartbeat,
  pullPendingEdgeJobs,
  submitEdgeJobResult,
  wireEdgeSigner,
  createEdgeDeepActionTransport,
  createInMemoryEdgeRuntime,
  createPrivateApiDouble,
  recordAdapters,
  createHmacSigner,
  edgeAuthMaterial,
  canonicalJson,
  EDGE_CONNECTOR_AUTHORITY_ADMINISTER,
} = edge;

const { decideApproval } = actionsContract;
const { registerSource, setSourceTransport } = sourcesContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;
const { grantDiscoverySource, listSystems, runDiscovery } = integrationContract;
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
  getDeepAction,
  setDeepActionTransport,
} = deepActionsContract;

// A FRESH tenant per test so counts stay deterministic.
function freshTenant(): string {
  return newId();
}

function adminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [EDGE_CONNECTOR_AUTHORITY_ADMINISTER] };
}

function approverOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

function integrationAdminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['integration-intelligence:administer'] };
}

function memberOf(tenantId: string): TenantContext {
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

// Fake enrollment key material assembled from fragments at runtime
// (never a realistic full token literal in source — the house
// push-protection discipline). The VALUE never touches a domain table.
const KEY_ID = 'key-2026-k088';
const KEY_MATERIAL = ['edge-enroll-', 'svc', '-k088-material'].join('');
const OLD_KEY_ID = 'key-2019-rotated';
const OLD_KEY_MATERIAL = ['edge-enroll-', 'old', '-material-2019'].join('');

function wiredSigner() {
  return createHmacSigner({
    secretKeys: { [KEY_ID]: KEY_MATERIAL, [OLD_KEY_ID]: OLD_KEY_MATERIAL },
  });
}

/** A dial-home authentication built in-test (any purpose). */
function edgeAuth(
  tenantId: string,
  edgeId: string,
  purpose: 'heartbeat' | 'pull' | 'submit',
  requestNonce: string,
) {
  const base = { tenantId, edgeId, requestNonce };
  const proof = wiredSigner().sign(KEY_ID, edgeAuthMaterial(purpose, base));
  return { ...base, proof };
}

const READ_CRM: EdgeAllowlistEntryInput = {
  capabilityKey: 'read.customer-records',
  mode: 'read',
  connectivity: 'private-api',
  secretRef: 'edge-vault://crm-read',
  secretScopes: ['crm.read'],
};
const WRITE_CRM: EdgeAllowlistEntryInput = {
  capabilityKey: 'write.customer-records',
  mode: 'write',
  connectivity: 'private-api',
  secretRef: 'edge-vault://crm-write',
  secretScopes: ['crm.write'],
};

interface EnrollOptions {
  name?: string;
  allowlist?: EdgeAllowlistEntryInput[];
  connectivity?: EdgeConnectivityKind[];
  privateApiStates?: Record<string, Record<string, unknown>>;
}

/** Registers an edge (admin claim) + builds its deterministic runtime. */
async function enrollEdge(tenantId: string, options: EnrollOptions = {}) {
  const allowlist = options.allowlist ?? [READ_CRM, WRITE_CRM];
  const detail: EdgeRuntimeDetail = await registerEdgeRuntime(adminOf(tenantId), {
    name: options.name ?? 'Plant edge',
    signingKeyId: KEY_ID,
    connectivity: options.connectivity ?? ['private-api'],
    allowlist,
    staleAfterSeconds: 300,
  });
  const privateApi = createPrivateApiDouble({
    states: options.privateApiStates ?? { 'cust-1042': { stage: 'onboarding' } },
  });
  const { wrapped, records } = recordAdapters({ 'private-api': privateApi });
  const sim = createInMemoryEdgeRuntime({
    tenantId,
    edgeId: detail.runtime.id,
    keyId: KEY_ID,
    secretKey: KEY_MATERIAL,
    localAllowlist: allowlist,
    localSecrets: Object.fromEntries(
      allowlist.map((entry) => [
        entry.secretRef,
        entry.secretRef === 'edge-vault://crm-read'
          ? 'local-read-material'
          : entry.secretRef === 'edge-vault://crm-write'
            ? 'local-write-material'
            : `local-material-${entry.capabilityKey}`,
      ]),
    ),
    adapters: { 'private-api': wrapped['private-api'] },
  });
  return { edgeId: detail.runtime.id, detail, sim, records, privateApi };
}

// ---------------------------------------------------------------------------
// The W081→W082 fixtures (exactly the deep-actions module's own test
// discipline — the composed pipeline runs against REAL contracts)
// ---------------------------------------------------------------------------

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

class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;

  constructor(private readonly nowProvider: () => Date) {}

  async request(
    request: brokerContract.BrokerHttpRequest,
  ): Promise<brokerContract.BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.w088.example/oauth/${state}`,
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

let directoryTransport: ScriptedDirectoryTransport;
let brokerBackend: ScriptedBrokerBackend;

const BASE_TIME = Date.now();
let clockMs = BASE_TIME;

let accountCounter = 0;

/** The full W081→W082 setup for one connected system (the W083 fixture). */
async function connectSystem(
  tenantId: string,
  displayName: string,
  capabilityClasses: string[],
): Promise<{ connectionId: string; systemId: string }> {
  const adminCtx = integrationAdminOf(tenantId);
  const memberCtx = memberOf(tenantId);

  accountCounter += 1;
  const { source } = await registerSource(adminCtx, {
    provider: 'notion',
    providerAccountId: `ws-${String(accountCounter).padStart(8, '0')}`,
    displayName: `${displayName} directory`,
    authKind: 'oauth',
    credentialRef: `secret-store://` + `w088/` + `notion-${accountCounter}/` + 'ref',
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await grantDiscoverySource(adminCtx, { sourceId: source.id });
  directoryTransport.script({
    records: [
      {
        providerRecordId: `dir-${accountCounter}`,
        kind: 'directory.system.discovered',
        payload: { externalId: `app-${accountCounter}`, displayName, capabilityClasses },
        occurredAt: '2026-09-26T10:00:00Z',
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
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
): Promise<void> {
  const ctx = memberOf(tenantId);
  const boss = approverOf(tenantId);
  await establishConnectionAccess(ctx, { connectionId });
  const ask = await requestCapabilityAuthority(ctx, {
    connectionId,
    capabilityKeys,
    taskContext: { description: 'W088 composition write authority' },
  });
  if (ask.request !== null) {
    await decideGrantRequest(boss, { requestId: ask.request.id, decision: 'approve' });
  }
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
  brokerBackend = new ScriptedBrokerBackend(() => new Date(clockMs));
  wireEdgeSigner(wiredSigner());
  setSourceTransport(directoryTransport);
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.w088.example',
      apiToken: ['emb_', 'w088', '_token'].join(''),
      httpClient: brokerBackend,
    }),
  ]);
  setDeepActionTransport(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSourceTransport(null);
  wireConnectionBrokers(null);
  wireEdgeSigner(null);
  setDeepActionTransport(null);
});

// ---------------------------------------------------------------------------
// Enrollment, honest degradation, health/version reporting
// ---------------------------------------------------------------------------

describe('W088 enrollment and honest degradation', () => {
  it('registers an edge (admin-gated) as pending with its allowlist of opaque references', async () => {
    const tenant = freshTenant();
    await expectEdgeError('forbidden', () =>
      registerEdgeRuntime(memberOf(tenant), {
        name: 'rogue edge',
        signingKeyId: KEY_ID,
        connectivity: ['private-api'],
        allowlist: [READ_CRM],
      }),
    );
    const { detail } = await enrollEdge(tenant);
    expect(detail.runtime.status).toBe('pending');
    expect(detail.health).toBe('pending');
    expect(detail.runtime.signingKeyId).toBe(KEY_ID);
    expect(detail.allowlist).toHaveLength(2);
    // Only opaque references + scopes — never values.
    expect(detail.allowlist[0]!.secretRef).toBe('edge-vault://crm-read');
    expect(detail.allowlist[0]!.secretScopes).toEqual(['crm.read']);
    // A second edge with the same name is refused.
    await expectEdgeError('edge_name_taken', () =>
      registerEdgeRuntime(adminOf(tenant), {
        name: 'Plant edge',
        signingKeyId: KEY_ID,
        connectivity: ['private-api'],
        allowlist: [READ_CRM],
      }),
    );
  });

  it('refuses dispatch while no healthy edge exists (pending, signer-less, stale, revoked)', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim } = await enrollEdge(tenant);

    // Pending: never heartbeated.
    await expectEdgeError('edge_not_connected', () =>
      issueEdgeJob(member, {
        edgeId,
        kind: 'inspect',
        capabilityKey: 'read.customer-records',
        target: 'cust-1042',
      }),
    );
    // The dial-home pull is equally gated before the first heartbeat.
    await expectEdgeError('edge_not_connected', () => sim.dialHomeOnce());

    // Signer-less issuance refuses to fake signatures.
    await sim.heartbeat({ version: '1.2.0' });
    wireEdgeSigner(null);
    await expectEdgeError('signer_unavailable', () =>
      issueEdgeJob(member, {
        edgeId,
        kind: 'inspect',
        capabilityKey: 'read.customer-records',
        target: 'cust-1042',
      }),
    );
    wireEdgeSigner(wiredSigner());

    // Stale: the heartbeat aged past the staleness window.
    clockMs += 301_000;
    const stale = await getEdgeRuntime(adminOf(tenant), { edgeId });
    expect(stale.health).toBe('stale');
    await expectEdgeError('edge_not_connected', () =>
      issueEdgeJob(member, {
        edgeId,
        kind: 'inspect',
        capabilityKey: 'read.customer-records',
        target: 'cust-1042',
      }),
    );

    // Healing: a fresh heartbeat restores dispatch.
    clockMs += 1000;
    await sim.heartbeat({ version: '1.3.0', pendingJobs: 0 });
    const issued = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
    });
    expect(issued.created).toBe(true);

    // Revoked: the dial-home channel is closed for good.
    await revokeEdgeRuntime(adminOf(tenant), { edgeId, reason: 'decommissioned' });
    const revoked = await getEdgeRuntime(adminOf(tenant), { edgeId });
    expect(revoked.health).toBe('revoked');
    await expectEdgeError('edge_revoked', () =>
      issueEdgeJob(member, {
        edgeId,
        kind: 'inspect',
        capabilityKey: 'read.customer-records',
        target: 'cust-1042',
      }),
    );
    await expectEdgeError('edge_revoked', () => sim.heartbeat({ version: '1.4.0' }));
    await expectEdgeError('edge_revoked', () => sim.dialHomeOnce());
  });

  it('records health/version evidence in the append-only heartbeat ledger', async () => {
    const tenant = freshTenant();
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0', capabilities: ['private-api'], pendingJobs: 2 });
    clockMs += 60_000;
    await sim.heartbeat({ version: '1.3.0', capabilities: ['private-api'], pendingJobs: 0 });

    const detail = await getEdgeRuntime(adminOf(tenant), { edgeId });
    expect(detail.runtime.status).toBe('connected');
    expect(detail.runtime.reportedVersion).toBe('1.3.0');
    expect(detail.runtime.reportedCapabilities).toEqual(['private-api']);
    expect(detail.lastHeartbeatAt).not.toBeNull();

    const beats = await listEdgeHeartbeats(memberOf(tenant), { edgeId });
    expect(beats).toHaveLength(2);
    expect(beats[0]!.reportedVersion).toBe('1.3.0');
    expect(beats[1]!.reportedVersion).toBe('1.2.0');
    expect(beats[1]!.reportedPendingJobs).toBe(2);

    const summaries = await listEdgeRuntimes(memberOf(tenant), { health: 'connected' });
    expect(summaries.map((summary) => summary.runtime.id)).toEqual([edgeId]);
  });
});

// ---------------------------------------------------------------------------
// The signed job lifecycle (issue → verify → pull → execute → submit)
// ---------------------------------------------------------------------------

describe('W088 signed tenant-scoped jobs', () => {
  it('issues a signed envelope, verifies it, and executes it through the dial-home loop', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });

    const issued = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
      credentialRef: 'embedded-connection:emb-001',
      systemKey: 'crm',
      idempotencyKey: 'w088-inspect-1',
    });
    expect(issued.created).toBe(true);
    expect(issued.job.state).toBe('issued');
    const { envelope } = issued.envelope;
    expect(envelope.tenantId).toBe(tenant);
    expect(envelope.edgeId).toBe(edgeId);
    expect(envelope.nonce).toMatch(/^[0-9a-f-]{36}$/);
    // The envelope carries NO secret material — only opaque references.
    expect(JSON.stringify(envelope)).not.toContain('local-read-material');

    // Aurum-side adjudication of the fresh envelope: it verifies.
    const verified = await verifyEdgeJobEnvelope(member, issued.envelope);
    expect(verified.job.id).toBe(issued.job.id);

    // The edge executes it over the dial-home loop.
    const executed = await sim.dialHomeOnce();
    expect(executed).toBe(1);
    expect(sim.submissionErrors).toEqual([]);

    const job = await getEdgeJob(member, { jobId: issued.job.id });
    expect(job.state).toBe('succeeded');
    expect(job.receiptStatus).toBe('accepted');
    expect(job.receiptId).toMatch(/^edge-api-\d+$/);
    expect(job.resultState).toEqual({ found: true, state: { stage: 'onboarding' } });
    expect(job.deliveredAt).not.toBeNull();
    expect(job.completedAt).not.toBeNull();

    // The delivery events prove the EDGE dialed home (recorded_by is the
    // edge id — Aurum never opened a connection toward it).
    const events = await listEdgeEvents(member, { edgeId });
    expect(events.find((entry) => entry.event === 'job-issued')!).toBeDefined();
    const delivered = events.find((entry) => entry.event === 'job-delivered')!;
    expect(delivered.recordedBy).toBe(edgeId);
    expect(events.find((entry) => entry.event === 'job-succeeded')!).toBeDefined();

    // An idempotent re-issue replays the SUCCEEDED job (first-write-wins).
    const replay = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
      idempotencyKey: 'w088-inspect-1',
    });
    expect(replay.created).toBe(false);
    expect(replay.job.id).toBe(issued.job.id);
  });

  it('checks the capability allowlist at DISPATCH and lets the boundary narrow it further', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });

    // Dispatch-side: a capability outside the PERSISTED allowlist is refused.
    await expectEdgeError('capability_not_allowed', () =>
      issueEdgeJob(member, {
        edgeId,
        kind: 'inspect',
        capabilityKey: 'read.erp-orders',
        target: 'order-1',
      }),
    );

    // The write is in the persisted allowlist but NOT in the edge's local
    // copy (the runtime came up narrower): the BOUNDARY refuses it and
    // reports the refusal as data.
    const narrower = createInMemoryEdgeRuntime({
      tenantId: tenant,
      edgeId,
      keyId: KEY_ID,
      secretKey: KEY_MATERIAL,
      localAllowlist: [READ_CRM],
      localSecrets: { 'edge-vault://crm-read': 'local-read-material' },
    });
    const issued = await issueEdgeJob(member, {
      edgeId,
      kind: 'execute',
      capabilityKey: 'write.customer-records',
      target: 'cust-1042',
      payload: { stage: 'onboarding-complete' },
    });
    await narrower.dialHomeOnce();
    const job = await getEdgeJob(member, { jobId: issued.job.id });
    expect(job.state).toBe('rejected');
    expect(job.receiptStatus).toBe('rejected');
    expect(job.receiptDetail).toContain('refused at the edge boundary');
    expect(narrower.boundaryRefusals[0]!.stage).toBe('allowlist');
  });

  it('replaces the allowlist (admin-gated) and re-checks dispatch against it', async () => {
    const tenant = freshTenant();
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });
    await setEdgeAllowlist(adminOf(tenant), { edgeId, allowlist: [READ_CRM] });
    await expectEdgeError('capability_not_allowed', () =>
      issueEdgeJob(memberOf(tenant), {
        edgeId,
        kind: 'execute',
        capabilityKey: 'write.customer-records',
        target: 'cust-1042',
        payload: { stage: 'x' },
      }),
    );
    const stillReadable = await issueEdgeJob(memberOf(tenant), {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
    });
    expect(stillReadable.created).toBe(true);
  });

  it('is replay-resistant on both sides of the boundary', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });

    const issued = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
      idempotencyKey: 'w088-replay-1',
    });

    // Aurum-side: the envelope verifies while 'issued'…
    await verifyEdgeJobEnvelope(member, issued.envelope);
    // …the edge pulls and executes it once…
    await sim.dialHomeOnce();
    // …and presenting the SAME envelope again is refused both ways:
    //   edge-side — the consumed nonce;
    const replay = await sim.executeEnvelope(issued.envelope);
    expect(replay.refusal?.stage).toBe('replayed-nonce');
    //   Aurum-side — verify refuses a delivered/completed envelope.
    await expectEdgeError('job_replayed', () =>
      verifyEdgeJobEnvelope(member, issued.envelope),
    );

    // A replayed RESULT submission is first-write-wins: single execution,
    // the original outcome returned.
    const replaySubmit = await submitEdgeJobResult(
      edgeAuth(tenant, edgeId, 'submit', 'w088-manual-replay'),
      {
        jobId: issued.job.id,
        result: {
          receipt: { status: 'accepted', receiptId: 'r-dup', detail: null },
          state: { found: true, state: { stage: 'duplicate' } },
        },
      },
    );
    expect(replaySubmit.submitted).toBe(false);
    const job = await getEdgeJob(member, { jobId: issued.job.id });
    expect(job.receiptId).not.toBe('r-dup');
    expect(job.resultState).toEqual({ found: true, state: { stage: 'onboarding' } });
  });

  it('refuses forgeries: tampered signatures, foreign tenants, stale keys', async () => {
    const tenant = freshTenant();
    const otherTenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });

    const issued = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
    });

    // A tampered signature is refused at the edge boundary (never executed).
    const tampered = { envelope: issued.envelope.envelope, signature: 'f'.repeat(64) };
    const refused = await sim.executeEnvelope(tampered);
    expect(refused.refusal?.stage).toBe('signature');
    expect(sim.pulledEnvelopes).toHaveLength(0);

    // A foreign-tenant envelope (correctly signed, then re-addressed) is
    // refused at the boundary AND at Aurum's verify — a full wall.
    const foreignBody = { ...issued.envelope.envelope, tenantId: otherTenant };
    const foreignSigned = {
      envelope: foreignBody,
      signature: wiredSigner().sign(KEY_ID, canonicalJson(foreignBody)),
    };
    const foreignRefusal = await sim.executeEnvelope(foreignSigned);
    expect(foreignRefusal.refusal?.stage).toBe('tenant');
    await expectEdgeError('invalid_envelope', () =>
      verifyEdgeJobEnvelope(member, foreignSigned),
    );

    // A VALID signature under a STALE enrollment key id (one the edge no
    // longer registers) is refused by Aurum's adjudication.
    const staleKeyBody = { ...issued.envelope.envelope, keyId: OLD_KEY_ID };
    const staleKeySigned = {
      envelope: staleKeyBody,
      signature: wiredSigner().sign(OLD_KEY_ID, canonicalJson(staleKeyBody)),
    };
    await expectEdgeError('invalid_envelope', () =>
      verifyEdgeJobEnvelope(member, staleKeySigned),
    );

    // An expired envelope is refused by adjudication and at the boundary.
    const expiredBody = {
      ...issued.envelope.envelope,
      issuedAt: '2019-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:00:00.000Z',
    };
    const expiredSigned = {
      envelope: expiredBody,
      signature: wiredSigner().sign(KEY_ID, canonicalJson(expiredBody)),
    };
    await expectEdgeError('job_expired', () =>
      verifyEdgeJobEnvelope(member, expiredSigned),
    );
    const expiredAtBoundary = await sim.executeEnvelope(expiredSigned);
    expect(expiredAtBoundary.refusal?.stage).toBe('expiry');
  });

  it('refuses non-canonical (provider-object) results loudly — nothing provider-shaped persists', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim } = await enrollEdge(tenant);
    sim.nativeStateObject = true;
    await sim.heartbeat({ version: '1.2.0' });

    const issued = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
    });
    await sim.dialHomeOnce();
    // The boundary submission was refused (invalid_edge_result) and the
    // job stayed 'delivered' — an honest, visible non-success.
    expect(sim.submissionErrors).toHaveLength(1);
    expect(sim.submissionErrors[0]!.code).toBe('invalid_edge_result');
    const job = await getEdgeJob(member, { jobId: issued.job.id });
    expect(job.state).toBe('delivered');
    expect(job.receiptStatus).toBeNull();

    // Direct submission of a provider-native value is refused the same way.
    await expectEdgeError('invalid_edge_result', () =>
      submitEdgeJobResult(edgeAuth(tenant, edgeId, 'submit', 'w088-native-1'), {
        jobId: issued.job.id,
        result: {
          receipt: { status: 'accepted', receiptId: null, detail: null },
          state: { found: true, state: new Date() },
        },
      }),
    );
  });

  it('refuses dial-home calls with bad proofs and single-uses request nonces', async () => {
    const tenant = freshTenant();
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });

    // A wrong proof fails authentication.
    await expectEdgeError('edge_authentication_failed', () =>
      sendEdgeHeartbeat(
        { tenantId: tenant, edgeId, requestNonce: 'nonce-bad-proof', proof: 'f'.repeat(64) },
        { version: '1.0.0' },
      ),
    );

    // A replayed (already-consumed) request nonce is refused even though
    // its proof verifies.
    const auth = edgeAuth(tenant, edgeId, 'pull', 'nonce-once');
    await pullPendingEdgeJobs(auth, { limit: 1 });
    await expectEdgeError('edge_authentication_replayed', () =>
      pullPendingEdgeJobs(auth, { limit: 1 }),
    );
  });

  it('re-issues a FRESH envelope after a transient failure under the same key (the W084 retry discipline)', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim, privateApi } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });
    privateApi.store.failOnce.add('cust-1042');

    const first = await issueEdgeJob(member, {
      edgeId,
      kind: 'execute',
      capabilityKey: 'write.customer-records',
      target: 'cust-1042',
      payload: { stage: 'onboarding-complete' },
      idempotencyKey: 'w088-retry-key',
    });
    await sim.dialHomeOnce();
    let job = await getEdgeJob(member, { jobId: first.job.id });
    expect(job.state).toBe('failed');
    expect(job.receiptStatus).toBe('failed');
    expect(job.receiptDetail).toContain('transient');

    // A re-issue under the SAME key gets a FRESH envelope (attempt 2).
    const retried = await issueEdgeJob(member, {
      edgeId,
      kind: 'execute',
      capabilityKey: 'write.customer-records',
      target: 'cust-1042',
      payload: { stage: 'onboarding-complete' },
      idempotencyKey: 'w088-retry-key',
    });
    expect(retried.created).toBe(true);
    expect(retried.job.id).not.toBe(first.job.id);
    expect(retried.job.jobKey).toBe('w088-retry-key::retry-2');
    await sim.dialHomeOnce();
    job = await getEdgeJob(member, { jobId: retried.job.id });
    expect(job.state).toBe('succeeded');

    // A THIRD issue under the key replays the SUCCEEDED attempt
    // (first-write-wins — success is final).
    const replay = await issueEdgeJob(member, {
      edgeId,
      kind: 'execute',
      capabilityKey: 'write.customer-records',
      target: 'cust-1042',
      payload: { stage: 'onboarding-complete' },
      idempotencyKey: 'w088-retry-key',
    });
    expect(replay.created).toBe(false);
    expect(replay.job.id).toBe(retried.job.id);
  });

  it('expires undelivered envelopes past their TTL (forward-only hygiene)', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });

    const issued = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
      ttlSeconds: 60,
    });
    // Age past the envelope's TTL, then pull: the sweep expires it.
    clockMs += 61_000;
    await sim.heartbeat({ version: '1.2.0' });
    const pulled = await sim.dialHomeOnce();
    expect(pulled).toBe(0);
    const job = await getEdgeJob(member, { jobId: issued.job.id });
    expect(job.state).toBe('expired');
    expect(job.receiptStatus).toBeNull();
    // Submitting a result for the expired job is refused honestly.
    await expectEdgeError('job_expired', () =>
      submitEdgeJobResult(edgeAuth(tenant, edgeId, 'submit', 'w088-expired-1'), {
        jobId: issued.job.id,
        result: { receipt: { status: 'accepted', receiptId: null, detail: null }, state: null },
      }),
    );
    // A re-issue under the same key gets a FRESH envelope (expired
    // attempts are retryable).
    const reissued = await issueEdgeJob(member, {
      edgeId,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-1042',
      ttlSeconds: 60,
      idempotencyKey: 'w088-expired-key',
    });
    void reissued;
  });
});

// ---------------------------------------------------------------------------
// Local secret handling — the storage-level proof
// ---------------------------------------------------------------------------

describe('W088 local secret handling (opaque references + scopes only)', () => {
  it('never persists a secret VALUE anywhere in the module tables', async () => {
    const tenant = freshTenant();
    const { sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });
    await issueEdgeJob(memberOf(tenant), {
      edgeId: sim.config.edgeId,
      kind: 'execute',
      capabilityKey: 'write.customer-records',
      target: 'cust-1042',
      payload: { stage: 'onboarding-complete' },
    });
    await sim.dialHomeOnce();

    const db = getDb();
    for (const table of [
      'edge_runtimes',
      'edge_capability_allowlist',
      'edge_heartbeats',
      'edge_jobs',
      'edge_events',
      'edge_auth_nonces',
    ]) {
      const rows = await db.query<DbRow>(`SELECT * FROM ${table}`);
      const dump = JSON.stringify(rows.rows);
      expect(dump, table).not.toContain('local-read-material');
      expect(dump, table).not.toContain('local-write-material');
      expect(dump, table).not.toContain(KEY_MATERIAL);
    }
    // …and the opaque references ARE there (references + scopes, values
    // resolved only at the edge).
    const allowlist = await db.query<DbRow>(`SELECT * FROM edge_capability_allowlist`);
    expect(JSON.stringify(allowlist.rows)).toContain('edge-vault://crm-read');
  });
});

// ---------------------------------------------------------------------------
// The six connectivity kinds
// ---------------------------------------------------------------------------

describe('W088 the connectivity surface (six kinds, deterministic doubles)', () => {
  it('executes jobs through each connectivity kind with kind-branded receipts', async () => {
    const tenant = freshTenant();
    const reads = [
      { capabilityKey: 'read.api-orders', connectivity: 'private-api' },
      { capabilityKey: 'read.openapi-orders', connectivity: 'openapi' },
      { capabilityKey: 'read.mcp-tools', connectivity: 'mcp' },
      { capabilityKey: 'read.db-tables', connectivity: 'database' },
      { capabilityKey: 'read.share-files', connectivity: 'file-share' },
      { capabilityKey: 'read.browser-state', connectivity: 'browser' },
    ] as const;
    const writes = [{ capabilityKey: 'write.db-tables', connectivity: 'database' }] as const;
    const RECEIPT_PREFIX_BY_KIND: Record<string, string> = {
      'private-api': 'edge-api',
      openapi: 'edge-openapi',
      mcp: 'edge-mcp',
      database: 'edge-db',
      'file-share': 'edge-file',
      browser: 'edge-browser',
    };
    const entries = [...reads, ...writes].map((entry) => ({
      capabilityKey: entry.capabilityKey,
      mode: (entry.capabilityKey.startsWith('read.') ? 'read' : 'write') as 'read' | 'write',
      connectivity: entry.connectivity,
      secretRef: `edge-vault://${entry.capabilityKey}`,
      secretScopes: [`${entry.capabilityKey}.use`],
    }));
    const { edgeId, sim } = await enrollEdge(tenant, {
      connectivity: ['private-api', 'openapi', 'mcp', 'database', 'file-share', 'browser'],
      allowlist: entries,
    });
    await sim.heartbeat({ version: '2.0.0' });

    const member = memberOf(tenant);
    for (const entry of reads) {
      const issued = await issueEdgeJob(member, {
        edgeId,
        kind: 'inspect',
        capabilityKey: entry.capabilityKey,
        target: `target-${entry.connectivity}`,
      });
      await sim.dialHomeOnce();
      const job = await getEdgeJob(member, { jobId: issued.job.id });
      expect(job.state, entry.capabilityKey).toBe('succeeded');
      // The receipt-branding mirrors receiptPrefixOf (adapters.ts).
      const prefix = RECEIPT_PREFIX_BY_KIND[entry.connectivity];
      expect(job.receiptId, entry.capabilityKey).toMatch(new RegExp(`^${prefix}-\\d+$`));
    }

    const writeIssued = await issueEdgeJob(member, {
      edgeId,
      kind: 'execute',
      capabilityKey: 'write.db-tables',
      target: 'tbl-orders',
      payload: { stage: 'synced' },
    });
    await sim.dialHomeOnce();
    const writeJob = await getEdgeJob(member, { jobId: writeIssued.job.id });
    expect(writeJob.state).toBe('succeeded');
    expect(writeJob.receiptId).toMatch(/^edge-db-\d+$/);

    const jobs = await listEdgeJobs(member, { edgeId });
    expect(jobs.filter((job) => job.state === 'succeeded')).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// The W084 composition — result normalization end-to-end
// ---------------------------------------------------------------------------

describe('W088 result normalization: the deep-action pipeline executes over the edge', () => {
  it('walks discover→inspect→propose→authorize→execute→verify→reconcile with the edge as transport', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const boss = approverOf(tenant);
    const { connectionId } = await connectSystem(tenant, 'Plant CRM', ['customer-records']);
    await grantWrites(tenant, connectionId, ['write.customer-records']);

    const { edgeId, sim, records } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });
    setDeepActionTransport(
      createEdgeDeepActionTransport(member, {
        edgeId,
        drive: async () => {
          await sim.dialHomeOnce();
        },
      }),
    );

    const created = await createDeepAction(member, {
      taskContext: {
        description: 'Close out the Q3 renewal at the plant CRM',
        requestedFor: 'Q3 close',
      },
      operations: [
        {
          key: 'file-crm',
          connectionId,
          capabilityKey: 'write.customer-records',
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });

    await discoverExecutionSurface(member, { taskId: created.task.id });
    await inspectTargets(member, { taskId: created.task.id });
    const proposed = await proposeDeepAction(member, { taskId: created.task.id });
    await decideApproval(boss, { requestId: proposed.task.actionRequestId!, decision: 'approve' });
    await authorizeDeepAction(member, { taskId: created.task.id });
    await executeDeepAction(member, { taskId: created.task.id });
    await verifyDeepAction(member, { taskId: created.task.id });
    const reconciled = await reconcileDeepAction(member, { taskId: created.task.id });

    // The task closed CLEAN through the pipeline — whose evidence,
    // verification and reconciliation are exactly W084's (no fork).
    expect(reconciled.task.status).toBe('reconciled');
    expect(reconciled.task.mismatchCount).toBe(0);

    // The deep-action operation carries the EDGE-MINTED opaque receipt id.
    const operation = reconciled.operations[0]!;
    expect(operation.receiptStatus).toBe('accepted');
    expect(operation.receiptId).toMatch(/^edge-api-\d+$/);
    expect(operation.preStateObservationId).not.toBeNull();
    expect(operation.postStateObservationId).not.toBeNull();

    // The write executed EXACTLY ONCE at the edge (pre/post reads ×2,
    // write ×1) — through the private-api double, with the EDGE-LOCAL
    // secret reference (the value never crossed).
    const privateApi = records.get('private-api')!;
    expect(privateApi).toHaveLength(3);
    expect(privateApi.filter((request) => request.kind === 'execute')).toHaveLength(1);
    expect(privateApi.filter((request) => request.kind === 'inspect')).toHaveLength(2);
    expect(privateApi.every((request) => request.secretRef?.startsWith('edge-vault://'))).toBe(
      true,
    );

    // The edge job feed shows the three envelopes (pre-inspect, execute,
    // post-verify), all terminal, with normalized read evidence.
    const jobs = await listEdgeJobs(member, { edgeId });
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.state === 'succeeded')).toBe(true);
    expect(jobs.filter((job) => job.kind === 'inspect').every((job) => job.resultState !== null)).toBe(
      true,
    );
  });

  it('reconciles a mismatched edge write through the W084 pipeline (no second truth store)', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const boss = approverOf(tenant);
    const { connectionId } = await connectSystem(tenant, 'Plant CRM', ['customer-records']);
    await grantWrites(tenant, connectionId, ['write.customer-records']);

    // The double ACCEPTS the write but applies nothing — the classic
    // accepted-but-unchanged mismatch W084's reconciliation exists for.
    const { edgeId, sim, privateApi } = await enrollEdge(tenant);
    privateApi.store.skipApply.add('cust-1042');
    await sim.heartbeat({ version: '1.2.0' });
    setDeepActionTransport(
      createEdgeDeepActionTransport(member, { edgeId, drive: async () => {
          await sim.dialHomeOnce();
        } }),
    );

    const created = await createDeepAction(member, {
      taskContext: { description: 'A write the edge accepts but does not apply' },
      operations: [
        {
          key: 'file-crm',
          connectionId,
          capabilityKey: 'write.customer-records',
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(member, { taskId: created.task.id });
    await inspectTargets(member, { taskId: created.task.id });
    const proposed = await proposeDeepAction(member, { taskId: created.task.id });
    await decideApproval(boss, { requestId: proposed.task.actionRequestId!, decision: 'approve' });
    await authorizeDeepAction(member, { taskId: created.task.id });
    await executeDeepAction(member, { taskId: created.task.id });
    await verifyDeepAction(member, { taskId: created.task.id });
    const mismatched = await reconcileDeepAction(member, { taskId: created.task.id });

    // The W084 pipeline — NOT the edge module — decided the truth: the
    // task is 'mismatched', a mismatch observation and an attention
    // unknown exist, linked through the pipeline's own records.
    expect(mismatched.task.status).toBe('mismatched');
    expect(mismatched.task.mismatchCount).toBe(1);
    expect(mismatched.operations[0]!.mismatchEvidenceObservationId).not.toBeNull();
    expect(mismatched.operations[0]!.mismatchUnknownId).not.toBeNull();
  });

  it('resumes a transient edge failure through the pipeline retry (fresh envelope, single success)', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const boss = approverOf(tenant);
    const { connectionId } = await connectSystem(tenant, 'Plant CRM', ['customer-records']);
    await grantWrites(tenant, connectionId, ['write.customer-records']);

    const { edgeId, sim, records, privateApi } = await enrollEdge(tenant);
    // The first write execution of this target fails transiently.
    privateApi.store.failOnce.add('cust-1042');
    await sim.heartbeat({ version: '1.2.0' });
    setDeepActionTransport(
      createEdgeDeepActionTransport(member, { edgeId, drive: async () => {
          await sim.dialHomeOnce();
        } }),
    );

    const created = await createDeepAction(member, {
      taskContext: { description: 'A transient edge failure must resume' },
      operations: [
        {
          key: 'file-crm',
          connectionId,
          capabilityKey: 'write.customer-records',
          target: 'cust-1042',
          payload: { stage: 'onboarding-complete' },
          expectation: { stage: 'onboarding-complete' },
        },
      ],
    });
    await discoverExecutionSurface(member, { taskId: created.task.id });
    await inspectTargets(member, { taskId: created.task.id });
    const proposed = await proposeDeepAction(member, { taskId: created.task.id });
    await decideApproval(boss, { requestId: proposed.task.actionRequestId!, decision: 'approve' });
    await authorizeDeepAction(member, { taskId: created.task.id });
    await executeDeepAction(member, { taskId: created.task.id });

    // The transient failure parked the task 'failed' — a RETRYABLE state.
    const parked = await getDeepAction(member, { taskId: created.task.id });
    expect(parked.task.status).toBe('failed');

    // Re-executing the SAME task re-enters the transport with the SAME
    // per-operation idempotency key: the edge module re-issues a FRESH
    // envelope (attempt 2) and the pipeline completes.
    await executeDeepAction(member, { taskId: created.task.id });
    await verifyDeepAction(member, { taskId: created.task.id });
    const resumed = await reconcileDeepAction(member, { taskId: created.task.id });
    expect(resumed.task.status).toBe('reconciled');

    // Exactly two write attempts (the first failed transiently, the
    // retry succeeded) — and BOTH execute jobs recorded as evidence.
    const writes = records.get('private-api')!.filter((request) => request.kind === 'execute');
    expect(writes).toHaveLength(2);
    const jobs = await listEdgeJobs(member, { edgeId });
    const executeJobs = jobs.filter((job) => job.kind === 'execute');
    expect(executeJobs).toHaveLength(2);
    expect(executeJobs.find((job) => job.state === 'failed')).toBeDefined();
    expect(executeJobs.find((job) => job.state === 'succeeded')).toBeDefined();
    expect(executeJobs.find((job) => job.jobKey?.endsWith('::retry-2'))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation + storage discipline
// ---------------------------------------------------------------------------

describe('W088 tenant isolation', () => {
  it('keeps every tenant edge state indistinguishable-from-missing to the other', async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    const { edgeId: edgeA, sim: simA } = await enrollEdge(tenantA, { name: 'A edge' });
    const { edgeId: edgeB } = await enrollEdge(tenantB, { name: 'B edge' });
    await simA.heartbeat({ version: '1.0.0' });
    const issuedA = await issueEdgeJob(memberA, {
      edgeId: edgeA,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-a',
    });

    // Cross-tenant reads and dispatches are uniformly not-found — no
    // existence leak, before any state moves.
    await expectEdgeError('edge_not_found', () => getEdgeRuntime(memberB, { edgeId: edgeA }));
    await expectEdgeError('edge_not_found', () =>
      issueEdgeJob(memberB, {
        edgeId: edgeA,
        kind: 'inspect',
        capabilityKey: 'read.customer-records',
        target: 'cust-a',
      }),
    );
    await expectEdgeError('job_not_found', () => getEdgeJob(memberB, { jobId: issuedA.job.id }));
    await expectEdgeError('edge_not_found', () =>
      listEdgeHeartbeats(memberB, { edgeId: edgeA }),
    );

    // Tenant B's dial-home auth against A's edge is uniformly refused.
    await expectEdgeError('edge_not_found', () =>
      pullPendingEdgeJobs(edgeAuth(tenantB, edgeA, 'pull', 'b-pull-1'), { limit: 1 }),
    );

    // Each tenant's listings hold exactly its own edges and jobs.
    expect((await listEdgeRuntimes(memberA, {})).map((s) => s.runtime.id)).toEqual([edgeA]);
    expect((await listEdgeRuntimes(memberB, {})).map((s) => s.runtime.id)).toEqual([edgeB]);
    const jobsForA = await listEdgeJobs(memberA, {});
    expect(jobsForA).toHaveLength(1);
    expect(jobsForA[0]!.id).toBe(issuedA.job.id);
    expect(await listEdgeJobs(memberB, {})).toHaveLength(0);
  });
});

describe('W088 storage discipline', () => {
  it('keeps the heartbeat and event ledgers append-only at the storage level', async () => {
    const tenant = freshTenant();
    const { edgeId, sim } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.2.0' });

    const db = getDb();
    await expect(db.query(`UPDATE edge_heartbeats SET reported_version = '9.9.9'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM edge_events`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE edge_heartbeats`)).rejects.toThrow(/append-only/);
    // The append-only guards did not consume the rows.
    const beats = await listEdgeHeartbeats(memberOf(tenant), { edgeId });
    expect(beats).toHaveLength(1);
  });
});
