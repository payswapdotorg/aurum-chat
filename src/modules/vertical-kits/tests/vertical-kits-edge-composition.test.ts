// W107 — the vertical-kit ↔ edge-execution COMPOSITION tests.
//
// The deterministic proof that the W092 `VerticalKitEdge` seam is now
// bound to the REAL W088 Edge Connector transport (never a duplicate
// fake): every test drives the ACTUAL edge-connector machinery —
// `registerEdgeRuntime` (enrollment), `wireEdgeSigner` +
// `createHmacSigner` (the enrollment key), `createInMemoryEdgeRuntime`
// (the deterministic customer-side runtime that dials home through the
// REAL contract calls), `createPrivateApiDouble` + `recordAdapters`
// (the contract-level connectivity double) — composed with the
// vertical-kits governed lifecycle (register → verify → install → the
// W009 grant review → activate) through the W107 adapter
// (`createEdgeConnectorKitEdge` + `setTenantKitEdge`).
//
// Coverage (the W107 acceptance):
//
//   * THE COMPOSITION END-TO-END — a kit integration inspects and
//     executes through the W088-backed edge transport: the read and the
//     write become signed, tenant-scoped EDGE JOBS, execute
//     customer-side through the dial-home loop, and come back
//     W084-SHAPED ({found, state} / the accepted/rejected/failed
//     receipt taxonomy) — recorded in the kit invocation ledger and the
//     edge-action ledger with the edge's opaque identity.
//
//   * GRANTS FRONT THE EDGE — the W009-fronted kit capability gate is
//     consulted BEFORE any edge call: a missing grant denies the write
//     as data (deterministic, task-grounded reason) and the transport
//     is never invoked (no edge job is issued, the dial-home loop never
//     runs).
//
//   * THE W084 IDEMPOTENCY DISCIPLINE — an identical kit write replays
//     the ORIGINAL edge job (exactly-once execution customer-side, the
//     same receipt); a changed payload is a new write and executes
//     fresh. A kit READ is a live read (a fresh job per call — never a
//     replayed stale outcome).
//
//   * TENANT ISOLATION — two tenants, two edges, two registrations: each
//     tenant rides ONLY its own edge (the job feeds and the adapter
//     records prove zero cross-execution), a foreign tenant's
//     installation is indistinguishable from missing, and a tenant with
//     no wiring fails honestly (`edge_unavailable`, readiness stays the
//     frozen 'deferred-on-w088' literal). A cross-tenant REGISTRATION
//     mistake is refused loudly by the registry.
//
//   * HONEST READ-FAILURE — an edge-boundary refusal of an inspect job
//     surfaces to the kit caller as the edge contract's own typed error
//     (never a fake read), exactly as EdgeConnectorError surfaces
//     through the W084 deep-action pipeline.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import * as edge from '@/modules/edge-connector/contract';
import type { EdgeAllowlistEntryInput } from '@/modules/edge-connector/contract';
import * as verticalKits from '../contract';
import { VerticalKitsError } from '../errors';
import { LEGAL_CASE_MANAGEMENT_KIT } from '../kits';

const {
  registerEdgeRuntime,
  listEdgeJobs,
  wireEdgeSigner,
  createHmacSigner,
  createInMemoryEdgeRuntime,
  createPrivateApiDouble,
  recordAdapters,
  EdgeConnectorError,
  EDGE_CONNECTOR_AUTHORITY_ADMINISTER,
} = edge;

const {
  registerKitVersion,
  runKitVerification,
  installKit,
  decideKitReview,
  activateKit,
  inspectKitIntegration,
  executeKitIntegration,
  getKitStatus,
  listKitEdgeActions,
  createEdgeConnectorKitEdge,
  setTenantKitEdge,
  resetTenantKitEdges,
} = verticalKits;

// ---------------------------------------------------------------------------
// Contexts and helpers
// ---------------------------------------------------------------------------

function freshTenant(): string {
  return newId();
}

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function kitAdminOf(tenantId: string): TenantContext {
  return memberOf(tenantId, ['vertical-kits:administer']);
}

function approverOf(tenantId: string): TenantContext {
  return memberOf(tenantId, ['actions:approve']);
}

function edgeAdminOf(tenantId: string): TenantContext {
  return memberOf(tenantId, [EDGE_CONNECTOR_AUTHORITY_ADMINISTER]);
}

async function expectCode(
  code: VerticalKitsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected VerticalKitsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof VerticalKitsError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** Captures whatever a call throws (null when it succeeds). */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

// Fake enrollment key material assembled from fragments at runtime (the
// house push-protection discipline; the VALUE never touches a table).
const KEY_ID = 'key-2026-w107';
const KEY_MATERIAL = ['edge-enroll-', 'svc', '-w107-material'].join('');

const READ_MATTERS: EdgeAllowlistEntryInput = {
  capabilityKey: 'read.case-matters',
  mode: 'read',
  connectivity: 'private-api',
  secretRef: 'edge-vault://legal-matter-read',
  secretScopes: ['legal-matter.read'],
};
const WRITE_MATTERS: EdgeAllowlistEntryInput = {
  capabilityKey: 'write.case-matters',
  mode: 'write',
  connectivity: 'private-api',
  secretRef: 'edge-vault://legal-matter-write',
  secretScopes: ['legal-matter.write'],
};

interface EnrollOptions {
  name?: string;
  allowlist?: EdgeAllowlistEntryInput[];
  /** The simulator's OWN local allowlist (defaults to the same list —
   * a test may deliberately diverge to prove the boundary policy). */
  localAllowlist?: EdgeAllowlistEntryInput[];
  privateApiStates?: Record<string, Record<string, unknown>>;
}

/** Enrolls a REAL edge runtime + its deterministic dial-home simulator. */
async function enrollEdge(tenantId: string, options: EnrollOptions = {}) {
  const allowlist = options.allowlist ?? [READ_MATTERS, WRITE_MATTERS];
  const detail = await registerEdgeRuntime(edgeAdminOf(tenantId), {
    name: options.name ?? 'Legal SOR edge',
    signingKeyId: KEY_ID,
    connectivity: ['private-api'],
    allowlist,
    staleAfterSeconds: 300,
  });
  const privateApi = createPrivateApiDouble({
    states: options.privateApiStates ?? {
      'matter-001': { status: 'open', practiceArea: 'litigation' },
    },
  });
  const { wrapped, records } = recordAdapters({ 'private-api': privateApi });
  const sim = createInMemoryEdgeRuntime({
    tenantId,
    edgeId: detail.runtime.id,
    keyId: KEY_ID,
    secretKey: KEY_MATERIAL,
    localAllowlist: options.localAllowlist ?? allowlist,
    localSecrets: Object.fromEntries(
      (options.localAllowlist ?? allowlist).map((entry) => [
        entry.secretRef,
        `local-material-${entry.capabilityKey}`,
      ]),
    ),
    adapters: { 'private-api': wrapped['private-api'] },
  });
  return { edgeId: detail.runtime.id, sim, records, privateApi };
}

/** The full governed walk: register → verify → install → approve → activate. */
async function installActiveLegalKit(tenantId: string): Promise<string> {
  const admin = kitAdminOf(tenantId);
  const approver = approverOf(tenantId);
  const registered = await registerKitVersion(admin, { manifest: LEGAL_CASE_MANAGEMENT_KIT });
  const run = await runKitVerification(admin, { kitVersionId: registered.version.id });
  expect(run.outcome).toBe('verified');
  const installed = await installKit(admin, {
    kitKey: 'legal-case-management',
    version: '1.0.0',
    justification: 'W107 composition walk',
  });
  const decided = await decideKitReview(approver, {
    installationId: installed.installation.id,
    decision: 'approve',
    note: 'W107: approved to exercise the composed edge paths',
  });
  expect(decided.installation.status).toBe('granted');
  const activated = await activateKit(admin, { installationId: decided.installation.id });
  expect(activated.installation.status).toBe('active');
  return activated.installation.id;
}

let migrationsRan = false;

beforeAll(async () => {
  if (!migrationsRan) {
    await runMigrations(getDb());
    migrationsRan = true;
  }
  wireEdgeSigner(createHmacSigner({ secretKeys: { [KEY_ID]: KEY_MATERIAL } }));
});

afterAll(async () => {
  resetTenantKitEdges();
  verticalKits.setVerticalKitEdge(null);
  wireEdgeSigner(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// The composition end-to-end
// ---------------------------------------------------------------------------

describe('W107 — the kit edge composition over the REAL W088 transport', () => {
  it('inspects and executes a kit integration through the edge: signed jobs, W084-shaped evidence', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const installationId = await installActiveLegalKit(tenant);

    const { edgeId, sim, records } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.3.0' });

    // THE W107 BINDING: the kit-side port implemented over the W088
    // public transport, registered for THIS tenant.
    let driveCount = 0;
    setTenantKitEdge(
      tenant,
      createEdgeConnectorKitEdge(member, {
        edgeId,
        drive: async () => {
          driveCount += 1;
          await sim.dialHomeOnce();
        },
        credentialRef: 'edge-vault://legal-matter-connection',
        systemKey: 'legal-case-management-sor',
      }),
    );

    // -- the READ path: a live edge job, executed customer-side.
    const inspected = await inspectKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      taskContext: { description: 'Summarize the matter for the weekly review' },
    });
    expect(inspected.invocation.outcome).toBe('allowed');
    expect(inspected.invocation.capabilityKey).toBe('read.case-matters');
    expect(inspected.state).toEqual({
      found: true,
      state: { status: 'open', practiceArea: 'litigation' },
    });

    // -- the WRITE path: a canonical payload becomes an edge job and
    // returns the W084 receipt taxonomy.
    const executed = await executeKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      payload: { status: 'pending-close' },
      taskContext: { description: 'Move the matter to pending-close' },
    });
    expect(executed.invocation.outcome).toBe('allowed');
    expect(executed.invocation.capabilityKey).toBe('write.case-matters');
    expect(executed.receipt).not.toBeNull();
    expect(executed.receipt!.receiptStatus).toBe('accepted');
    expect(executed.receipt!.receiptId).toMatch(/^edge-api-\d+$/);
    expect(executed.receipt!.edgeId).toBe(edgeId);
    // The read path now sees the written state (a LIVE read).
    const after = await inspectKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      taskContext: { description: 'Confirm the write' },
    });
    expect(after.state).toEqual({
      found: true,
      state: { status: 'pending-close', practiceArea: 'litigation' },
    });

    // -- the EDGE-JOB FEED: every kit call was a signed, tenant-scoped
    // job executed through the dial-home loop; the evidence is
    // W084-shaped (receipt status/id; the normalized read state).
    const jobs = await listEdgeJobs(member, { edgeId });
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.state === 'succeeded')).toBe(true);
    const inspectJobs = jobs.filter((job) => job.kind === 'inspect');
    const executeJobs = jobs.filter((job) => job.kind === 'execute');
    expect(inspectJobs).toHaveLength(2);
    expect(executeJobs).toHaveLength(1);
    expect(inspectJobs.every((job) => job.resultState !== null)).toBe(true);
    expect(executeJobs.every((job) => job.receiptStatus === 'accepted')).toBe(true);
    // The kit write's job carries the W107 content-addressed idempotency
    // key (traceable to the kit installation).
    expect(executeJobs[0]!.jobKey).toMatch(/^kit-edge:[0-9a-f-]+:w:/);
    // The adapter composed the W084 request's connection slot honestly.
    expect(jobs.every((job) => job.credentialRef === 'edge-vault://legal-matter-connection')).toBe(true);
    expect(jobs.every((job) => job.systemKey === 'legal-case-management-sor')).toBe(true);
    // The dial-home loop advanced once per job (the drive contract).
    expect(driveCount).toBe(3);

    // -- the CONNECTIVITY records: the edge resolved its LOCAL secret
    // references and executed exactly one write.
    const privateApi = records.get('private-api')!;
    expect(privateApi).toHaveLength(3);
    expect(privateApi.filter((request) => request.kind === 'execute')).toHaveLength(1);
    expect(privateApi.every((request) => request.secretRef?.startsWith('edge-vault://'))).toBe(true);

    // -- the KIT LEDGERS: the executed action carries the W084-shaped
    // receipt with the edge's opaque identity.
    const actions = await listKitEdgeActions(member, { installationId });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.receiptStatus).toBe('accepted');
    expect(actions[0]!.receiptId).toMatch(/^edge-api-\d+$/);
    expect(actions[0]!.edgeId).toBe(edgeId);
    expect(actions[0]!.capabilityKey).toBe('write.case-matters');

    // -- the honest status: integrations READY with the wired identity.
    const status = await getKitStatus(member, { installationId });
    expect(status.integrations.map((integration) => integration.readiness)).toEqual([
      'ready',
      'ready',
    ]);
    expect(status.edgeWired).toBe(edgeId);
  });

  it('denies a missing kit grant BEFORE any edge call: no job, no dial-home, denial as data', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const installationId = await installActiveLegalKit(tenant);

    const { edgeId, sim, records } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.3.0' });
    let driveCount = 0;
    setTenantKitEdge(
      tenant,
      createEdgeConnectorKitEdge(member, {
        edgeId,
        drive: async () => {
          driveCount += 1;
          await sim.dialHomeOnce();
        },
        credentialRef: 'edge-vault://legal-matter-connection',
        systemKey: 'legal-case-management-sor',
      }),
    );

    // Simulate the grant-lapse state: the write grant is revoked while
    // the installation stays active (an out-of-band drift the gate must
    // catch — the standard W092 test technique for grant state; the
    // revocation shape constraint is honored).
    await getDb().query(
      `UPDATE vertical_kit_grants
         SET status = 'revoked', revoked_at = $3, revoked_by = $4, revocation_reason = 'drifted out-of-band for the W107 denial proof'
         WHERE tenant_id = $1 AND installation_id = $2 AND capability_key = 'write.case-matters'`,
      [tenant, installationId, new Date().toISOString(), member.principalId],
    );

    const denied = await executeKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      payload: { status: 'closed' },
      taskContext: { description: 'Close the matter without the write grant' },
    });
    // DENIAL IS DATA: the invocation ledger records the refusal with the
    // deterministic, task-grounded reason naming the exact scope.
    expect(denied.invocation.outcome).toBe('denied');
    expect(denied.invocation.basis).toBe('grant-missing');
    expect(denied.invocation.denialReason).toContain("capability 'write.case-matters'");
    expect(denied.receipt).toBeNull();

    // THE TRANSPORT WAS NEVER INVOKED: no edge job, no dial-home, no
    // connectivity call — the kit grant fronts the edge by construction.
    const jobs = await listEdgeJobs(member, { edgeId });
    expect(jobs).toHaveLength(0);
    expect(driveCount).toBe(0);
    expect(records.get('private-api')!).toHaveLength(0);
  });

  it('keeps the W084 write discipline: identical content replays the original job; changed content executes fresh', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const installationId = await installActiveLegalKit(tenant);

    const { edgeId, sim, records } = await enrollEdge(tenant);
    await sim.heartbeat({ version: '1.3.0' });
    setTenantKitEdge(
      tenant,
      createEdgeConnectorKitEdge(member, {
        edgeId,
        drive: async () => {
          await sim.dialHomeOnce();
        },
        credentialRef: 'edge-vault://legal-matter-connection',
        systemKey: 'legal-case-management-sor',
      }),
    );

    // First write of the payload.
    const first = await executeKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      payload: { status: 'pending-close' },
      taskContext: { description: 'Move the matter to pending-close' },
    });
    expect(first.receipt!.receiptStatus).toBe('accepted');

    // The SAME write again (a retry or duplicate): the content-addressed
    // key replays the ORIGINAL edge job — exactly-once execution.
    const replayed = await executeKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      payload: { status: 'pending-close' },
      taskContext: { description: 'Re-deliver the same write' },
    });
    expect(replayed.invocation.outcome).toBe('allowed');
    expect(replayed.receipt!.receiptId).toBe(first.receipt!.receiptId);
    // Both invocations are recorded; the receipts are identical.
    const actions = await listKitEdgeActions(member, { installationId });
    expect(actions).toHaveLength(2);
    expect(new Set(actions.map((action) => action.receiptId)).size).toBe(1);

    // A CHANGED payload is a genuinely new write: a fresh job executes.
    const changed = await executeKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      payload: { status: 'closed' },
      taskContext: { description: 'Close the matter for real' },
    });
    expect(changed.receipt!.receiptStatus).toBe('accepted');
    expect(changed.receipt!.receiptId).not.toBe(first.receipt!.receiptId);

    // The edge executed exactly TWO writes (first + changed); the
    // replayed one never reached the connectivity adapter.
    const jobs = await listEdgeJobs(member, { edgeId });
    expect(jobs.filter((job) => job.kind === 'execute')).toHaveLength(2);
    const writes = records.get('private-api')!.filter((request) => request.kind === 'execute');
    expect(writes).toHaveLength(2);
    // A live read sees the LATEST state (the changed write applied).
    const after = await inspectKitIntegration(member, {
      installationId,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      taskContext: { description: 'Confirm the final state' },
    });
    expect(after.state).toEqual({
      found: true,
      state: { status: 'closed', practiceArea: 'litigation' },
    });
  });

  it('isolates tenants: each rides its OWN edge; foreign installations are missing; unwired tenants refuse honestly', async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);
    const installationA = await installActiveLegalKit(tenantA);
    const installationB = await installActiveLegalKit(tenantB);

    // Two SEPARATE edges, one per tenant, with their own connectivity
    // doubles and seeded targets.
    const enrolledA = await enrollEdge(tenantA, {
      name: 'A legal edge',
      privateApiStates: { 'matter-a-001': { status: 'open-a' } },
    });
    const enrolledB = await enrollEdge(tenantB, {
      name: 'B legal edge',
      privateApiStates: { 'matter-b-001': { status: 'open-b' } },
    });
    await enrolledA.sim.heartbeat({ version: '1.3.0' });
    await enrolledB.sim.heartbeat({ version: '1.3.0' });

    // Each tenant registers ITS OWN composition binding.
    setTenantKitEdge(
      tenantA,
      createEdgeConnectorKitEdge(memberA, {
        edgeId: enrolledA.edgeId,
        drive: async () => {
          await enrolledA.sim.dialHomeOnce();
        },
        credentialRef: 'edge-vault://a-legal-matters',
        systemKey: 'legal-case-management-sor',
      }),
    );
    setTenantKitEdge(
      tenantB,
      createEdgeConnectorKitEdge(memberB, {
        edgeId: enrolledB.edgeId,
        drive: async () => {
          await enrolledB.sim.dialHomeOnce();
        },
        credentialRef: 'edge-vault://b-legal-matters',
        systemKey: 'legal-case-management-sor',
      }),
    );

    // Both tenants execute through their OWN edges.
    const executedA = await executeKitIntegration(memberA, {
      installationId: installationA,
      integrationKey: 'case-management-sor',
      target: 'matter-a-001',
      payload: { status: 'closed-a' },
      taskContext: { description: 'Tenant A closes its matter' },
    });
    expect(executedA.receipt!.receiptStatus).toBe('accepted');
    expect(executedA.receipt!.edgeId).toBe(enrolledA.edgeId);
    const executedB = await executeKitIntegration(memberB, {
      installationId: installationB,
      integrationKey: 'case-management-sor',
      target: 'matter-b-001',
      payload: { status: 'closed-b' },
      taskContext: { description: 'Tenant B closes its matter' },
    });
    expect(executedB.receipt!.receiptStatus).toBe('accepted');
    expect(executedB.receipt!.edgeId).toBe(enrolledB.edgeId);

    // ZERO CROSS-EXECUTION: each edge's job feed holds ONLY its own
    // tenant's job; each adapter record holds ONLY its own target.
    const jobsA = await listEdgeJobs(memberA, { edgeId: enrolledA.edgeId });
    const jobsB = await listEdgeJobs(memberB, { edgeId: enrolledB.edgeId });
    expect(jobsA).toHaveLength(1);
    expect(jobsB).toHaveLength(1);
    expect(jobsA[0]!.target).toBe('matter-a-001');
    expect(jobsB[0]!.target).toBe('matter-b-001');
    const writesA = enrolledA.records.get('private-api')!.filter((r) => r.kind === 'execute');
    const writesB = enrolledB.records.get('private-api')!.filter((r) => r.kind === 'execute');
    expect(writesA.map((r) => r.target)).toEqual(['matter-a-001']);
    expect(writesB.map((r) => r.target)).toEqual(['matter-b-001']);

    // A foreign tenant's installation is indistinguishable from missing.
    await expectCode('installation_not_found', () =>
      executeKitIntegration(memberB, {
        installationId: installationA,
        integrationKey: 'case-management-sor',
        target: 'matter-a-001',
        payload: { status: 'stolen' },
        taskContext: { description: 'Tenant B reaches tenant A installation' },
      }),
    );
    // And the read path is equally isolated.
    await expectCode('installation_not_found', () =>
      inspectKitIntegration(memberB, {
        installationId: installationA,
        integrationKey: 'case-management-sor',
        target: 'matter-a-001',
        taskContext: { description: 'Tenant B reads tenant A installation' },
      }),
    );

    // A tenant with NO wiring fails honestly (no fake success, no edge
    // call): edge_unavailable, the frozen deferred literal in status.
    const tenantC = freshTenant();
    const memberC = memberOf(tenantC);
    const installationC = await installActiveLegalKit(tenantC);
    await expectCode('edge_unavailable', () =>
      executeKitIntegration(memberC, {
        installationId: installationC,
        integrationKey: 'case-management-sor',
        target: 'matter-c-001',
        payload: { status: 'closed-c' },
        taskContext: { description: 'Tenant C has no edge wired' },
      }),
    );
    const statusC = await getKitStatus(memberC, { installationId: installationC });
    expect(statusC.integrations.every((integration) => integration.readiness === 'deferred-on-w088')).toBe(true);
    expect(statusC.edgeWired).toBeNull();

    // A cross-tenant REGISTRATION mistake is refused loudly: tenant B's
    // binding cannot be registered under tenant C.
    const foreignBinding = createEdgeConnectorKitEdge(memberB, {
      edgeId: enrolledB.edgeId,
      drive: async () => {
        await enrolledB.sim.dialHomeOnce();
      },
      credentialRef: 'edge-vault://b-legal-matters',
      systemKey: 'legal-case-management-sor',
    });
    let refused: VerticalKitsError | null = null;
    try {
      setTenantKitEdge(tenantC, foreignBinding);
    } catch (error) {
      if (error instanceof VerticalKitsError) refused = error;
      else throw error;
    }
    expect(refused).not.toBeNull();
    expect(refused!.code).toBe('invalid_input');
    expect(refused!.message).toContain('cannot be registered');
  });

  it('surfaces an edge-boundary refusal of a kit read honestly (the edge contract error, never a fake read)', async () => {
    const tenant = freshTenant();
    const member = memberOf(tenant);
    const installationId = await installActiveLegalKit(tenant);

    // The DISPATCH-side allowlist names the read capability, but the
    // SIMULATOR's own local allowlist does not: the edge boundary
    // refuses the job and reports an honest 'rejected' receipt — which
    // the W088 transport surfaces (for inspect jobs) as its typed
    // error, exactly as the deep-action pipeline sees it.
    const { edgeId, sim } = await enrollEdge(tenant, {
      allowlist: [READ_MATTERS, WRITE_MATTERS],
      localAllowlist: [WRITE_MATTERS],
    });
    await sim.heartbeat({ version: '1.3.0' });
    setTenantKitEdge(
      tenant,
      createEdgeConnectorKitEdge(member, {
        edgeId,
        drive: async () => {
          await sim.dialHomeOnce();
        },
        credentialRef: 'edge-vault://legal-matter-connection',
        systemKey: 'legal-case-management-sor',
      }),
    );

    const surfaced = await captureError(() =>
      inspectKitIntegration(member, {
        installationId,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        taskContext: { description: 'A read the edge boundary refuses' },
      }),
    );
    expect(surfaced).toBeInstanceOf(EdgeConnectorError);
    if (!(surfaced instanceof EdgeConnectorError)) {
      throw new Error('expected the edge-boundary refusal to surface as EdgeConnectorError');
    }
    expect(surfaced.code).toBe('edge_job_rejected');
    // The refusal happened AT THE BOUNDARY (denial is data — the edge
    // submitted its honest 'rejected' receipt, recorded on the job).
    const jobs = await listEdgeJobs(member, { edgeId });
    const refusedJob = jobs.find((job) => job.kind === 'inspect');
    expect(refusedJob).toBeDefined();
    expect(refusedJob!.state).toBe('rejected');
    expect(refusedJob!.receiptDetail).toContain('not in the local allowlist');
    // The kit invocation ledger recorded the ALLOWED read gate verdict —
    // the gate authorized; the EDGE refused. Two different authorities,
    // both honest.
    // (No edge-action row exists: the write path never ran.)
    const actions = await listKitEdgeActions(member, { installationId });
    expect(actions).toHaveLength(0);
  });
});
