// Integration tests for the extensions module's RUNTIME (W026 —
// General-Purpose Extension Runtime) against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the catalog entry's
// acceptance — "persistent scoped state, declarative UI, schedules,
// event subscriptions, scoped external participation, quotas,
// isolation, deployment, rollback and telemetry":
//
//  * DEPLOYMENT: matrix-gated (kind 'extension-deployment', EXECUTE —
//    pending → human approve → same idempotency key applies; policy
//    allow applies immediately; policy forbid records the rejection),
//    preconditions enforced (extension ACTIVE, manifest VERIFIED, host
//    runtime inside the declared range, grant ⊆ requested ceiling),
//    apply-time re-checks, append-only history with the current
//    deployment as a fold (latest seq), and idempotent replay;
//  * ROLLBACK: re-activates a superseded deployment's version + grant,
//    preconditions re-checked against TODAY's verification state,
//    recorded as its own deployment (operation 'rollback', linked to
//    the deployment it replaced), never as a rewrite;
//  * PERSISTENT SCOPED STATE: tenant namespace shared across installs
//    and deployments (state survives upgrades AND rollbacks), install
//    namespace isolated between installs, revision +1 per write, null
//    clears a key without deleting it, scope↔installKey agreement
//    enforced, maxStateBytes quota enforced per namespace;
//  * DECLARATIVE UI: closed-vocabulary documents per (extension,
//    surface), replaceable, surface must be declared, grant-gated on
//    BOTH the publish and the render read (a redeploy without
//    ui:render stops rendering);
//  * SCHEDULES: declared-name triggers append immutable run records,
//    maxScheduleInvocationsPerDay enforced per (tenant, extension,
//    install, UTC day);
//  * EVENT SUBSCRIPTIONS: dispatch fans one topic out to every
//    subscribed install — delivered, or not_granted when the grant
//    omits events:subscribe (a downgrade is evidence, never silence) —
//    and suspended extensions receive nothing (disablement);
//  * SCOPED EXTERNAL PARTICIPATION: EXACT-origin sandbox (never
//    prefix), injectable egress port, outcome vocabulary
//    succeeded/http_error/failed recorded append-only, headers never
//    recorded, maxExternalCallsPerDay enforced per UTC day;
//  * TELEMETRY: extension-emitted bounded events, capability- and
//    grant-gated, append-only;
//  * ISOLATION (ADR-0001 + §17): tenant isolation with uniform
//    not-found semantics on every surface (including dispatch —
//    another tenant's installs never receive), and storage-level
//    guarantees (append-only triggers, state identity immutability,
//    revision monotonicity, the grant ⊆ ceiling trigger for bypass
//    writes).
//
// Every describe runs in its OWN tenant (with its own authority
// policy pinned up front) so the fan-out operations — dispatch above
// all — never see another describe's extensions.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as extensionsContract from '../contract';
import {
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { ExtensionsError } from '../errors';
import type {
  ExtensionHttpCall,
  ExtensionUiDocument,
  RegisterExtensionManifestInput,
} from '../types';

const {
  EXTENSION_ACTION_KIND,
  EXTENSIONS_AUTHORITY_ADMINISTER,
  deployExtensionVersion,
  dispatchExtensionEvent,
  emitExtensionTelemetry,
  executeExtensionExternalCall,
  getCurrentDeployment,
  getExtension,
  getExtensionUi,
  listExtensionDeployments,
  listExtensionEventDeliveries,
  listExtensionExternalCalls,
  listExtensionScheduleRuns,
  listExtensionTelemetryEvents,
  publishExtensionUi,
  readExtensionState,
  registerExtensionManifest,
  rollbackExtensionDeployment,
  runManifestVerification,
  setExtensionHttpPort,
  transitionExtension,
  triggerExtensionSchedule,
  writeExtensionState,
} = extensionsContract;

// One tenant per describe (see the header comment); tenantGate keeps
// the built-in default matrix and tenantForbid forbids EXECUTE.
const tenantDeploy = newId();
const tenantGate = newId();
const tenantForbid = newId();
const tenantRollback = newId();
const tenantState = newId();
const tenantQuota = newId();
const tenantUi = newId();
const tenantSchedules = newId();
const tenantEvents = newId();
const tenantExternal = newId();
const tenantTelemetry = newId();
const tenantDisabled = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantStorage = newId();

const ALLOW_TENANTS = [
  tenantDeploy,
  tenantRollback,
  tenantState,
  tenantQuota,
  tenantUi,
  tenantSchedules,
  tenantEvents,
  tenantExternal,
  tenantTelemetry,
  tenantDisabled,
  tenantIsoA,
  tenantIsoB,
  tenantStorage,
];

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function extensionAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [EXTENSIONS_AUTHORITY_ADMINISTER] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectErrorCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionsError);
    expect((error as ExtensionsError).code).toBe(code);
  }
}

const FULL_PERMISSIONS = [
  'state:read',
  'state:write',
  'ui:render',
  'schedule:run',
  'events:subscribe',
  'external:participate',
  'telemetry:emit',
] as const;

/** A full-capability manifest whose host range covers the runtime's version. */
function runtimeManifest(
  overrides: Partial<RegisterExtensionManifestInput> = {},
): RegisterExtensionManifestInput {
  return {
    extensionKey: 'invoice-ocr',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [...FULL_PERMISSIONS],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 3,
      maxExternalCallsPerDay: 2,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
    ...overrides,
  };
}

/** An inert manifest: no capabilities, no permissions, no quotas. */
function inertManifest(
  overrides: Partial<RegisterExtensionManifestInput> = {},
): RegisterExtensionManifestInput {
  return {
    extensionKey: 'tiny-widget',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Tiny Widget',
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
    requestedPermissions: [],
    stateScope: 'none',
    uiSurfaces: [],
    schedules: [],
    eventSubscriptions: [],
    externalParticipants: [],
    telemetry: false,
    quotas: { maxStateBytes: 0, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
    ...overrides,
  };
}

/** Register + verify a manifest so it can be activated and deployed. */
async function registerVerified(
  ctx: TenantContext,
  input: RegisterExtensionManifestInput,
): Promise<{ extensionId: string; manifestId: string }> {
  const registered = await registerExtensionManifest(ctx, input);
  const run = await runManifestVerification(ctx, { manifestId: registered.manifest.id });
  expect(run.state).toBe('VERIFIED');
  return { extensionId: registered.extension.id, manifestId: registered.manifest.id };
}

/** Approve a pending action request as an authorized different principal. */
async function approveRequest(tenantId: string, requestId: string): Promise<void> {
  await decideApproval(approver(tenantId), { requestId, decision: 'approve' });
}

/** Egress calls the fake port saw (restored in afterAll). */
const portCalls: ExtensionHttpCall[] = [];

beforeAll(async () => {
  await runMigrations(getDb());
  // The allow-listed tenants pin "extension-deployment EXECUTE is
  // allowed" up front so lifecycle transitions and deployments apply
  // immediately; tenantGate deliberately keeps the built-in default
  // matrix (the pending → human → replay flow).
  for (const tenantId of ALLOW_TENANTS) {
    await setAuthorityPolicy(actionsAdmin(tenantId), {
      actionKind: 'extension-deployment',
      approvalLevels: [],
    });
  }
  await setAuthorityPolicy(actionsAdmin(tenantForbid), {
    actionKind: 'extension-deployment',
    forbiddenLevels: ['EXECUTE'],
  });
  // The egress port is a deterministic fake: every call is captured,
  // URLs decide the outcome. No test ever touches the network.
  setExtensionHttpPort(async (call) => {
    portCalls.push(call);
    if (call.url.endsWith('/notfound')) return { status: 404, bodyText: 'no such invoice' };
    if (call.url.endsWith('/boom')) throw new Error('network unreachable');
    return { status: 200, bodyText: '{"ok":true}' };
  });
});

afterAll(async () => {
  setExtensionHttpPort(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// Deployment — the authority gate, preconditions, history
// ---------------------------------------------------------------------------

describe('deployment through the authority matrix (kind extension-deployment, EXECUTE)', () => {
  it('requires the extension to be ACTIVE before anything can deploy', async () => {
    const admin = extensionAdmin(tenantDeploy);
    const { extensionId, manifestId } = await registerVerified(admin, runtimeManifest());
    // REGISTERED (never activated): no deployment, no runtime
    await expectErrorCode('extension_not_active', () =>
      deployExtensionVersion(member(tenantDeploy), { extensionId, manifestId }),
    );
    // runtime operations agree while the extension sits at REGISTERED
    await expectErrorCode('extension_not_active', () =>
      readExtensionState(member(tenantDeploy), { extensionId, key: 'k' }),
    );
  });

  it('applies immediately under allowing policy, records the grant, and derives the current', async () => {
    const admin = extensionAdmin(tenantDeploy);
    const requester = member(tenantDeploy);
    const { extensionId } = await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'first-deploy' }),
    );

    const activated = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:first-deploy:1',
    });
    expect(activated.applied).toBe(true);

    const deployed = await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      idempotencyKey: 'deploy:first-deploy:1',
    });
    expect(deployed.applied).toBe(true);
    expect(deployed.gate.status).toBe('approved');
    expect(deployed.deployment).toMatchObject({
      tenantId: tenantDeploy,
      extensionId,
      extensionKey: 'first-deploy',
      installKey: 'default',
      version: '1.0.0',
      operation: 'deploy',
      replacesDeploymentId: null,
      deployedBy: requester.principalId,
    });
    // default grant = the manifest's requested ceiling, canonical order
    expect(deployed.deployment!.grantedPermissions).toEqual([...FULL_PERMISSIONS]);

    // the gate request is real, tenant-visible actions evidence
    const requests = await listActionRequests(requester, { actionKind: EXTENSION_ACTION_KIND });
    const gateRequest = requests.find(
      (r) => (r.payload as { operation?: string }).operation === 'deploy',
    )!;
    expect(gateRequest.authorityLevel).toBe('EXECUTE');
    expect(gateRequest.payload).toMatchObject({
      operation: 'deploy',
      extensionId,
      extensionKey: 'first-deploy',
      installKey: 'default',
      version: '1.0.0',
      fromVersion: null,
    });

    // the current deployment is the fold over history
    const current = await getCurrentDeployment(member(tenantDeploy), { extensionId });
    expect(current?.id).toBe(deployed.deployment!.id);

    // re-invoking the SAME key replays the applied outcome — one record
    const replay = await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      idempotencyKey: 'deploy:first-deploy:1',
    });
    expect(replay.applied).toBe(true);
    expect(replay.deployment!.id).toBe(deployed.deployment!.id);
    expect(await listExtensionDeployments(member(tenantDeploy), { extensionId })).toHaveLength(1);
  });

  it('enforces the deploy-time preconditions: verification, host range, grant ceiling', async () => {
    const admin = extensionAdmin(tenantDeploy);
    const requester = member(tenantDeploy);

    // unverified version of an ACTIVATED extension cannot deploy: the
    // extension runs v1 (verified) while v2 sits unregistered-for-deploy
    await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'unverified-deploy', version: '1.0.0' }),
    );
    const activation = await transitionExtension(requester, {
      extensionKey: 'unverified-deploy',
      transition: 'activate',
      idempotencyKey: 'activate:unverified-deploy:1',
    });
    expect(activation.applied).toBe(true);
    await registerExtensionManifest(
      admin,
      runtimeManifest({ extensionKey: 'unverified-deploy', version: '2.0.0' }),
    );
    await expectErrorCode('verification_required', () =>
      deployExtensionVersion(requester, { extensionKey: 'unverified-deploy', version: '2.0.0' }),
    );

    // verified but outside the host range (the runtime is 2.1.0)
    await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'future-only', hostRuntime: { minVersion: '3.0.0' } }),
    );
    await transitionExtension(requester, {
      extensionKey: 'future-only',
      transition: 'activate',
      idempotencyKey: 'activate:future-only:1',
    });
    await expectErrorCode('incompatible_host', () =>
      deployExtensionVersion(requester, { extensionKey: 'future-only', version: '1.0.0' }),
    );

    // grant beyond the manifest's requested ceiling
    await registerVerified(
      admin,
      inertManifest({
        extensionKey: 'capped',
        stateScope: 'tenant',
        requestedPermissions: ['state:read', 'state:write'],
        quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      }),
    );
    await transitionExtension(requester, {
      extensionKey: 'capped',
      transition: 'activate',
      idempotencyKey: 'activate:capped:1',
    });
    await expectErrorCode('grant_exceeds_ceiling', () =>
      deployExtensionVersion(requester, {
        extensionKey: 'capped',
        version: '1.0.0',
        grantedPermissions: ['state:read', 'state:write', 'ui:render'],
      }),
    );
    // the narrowed grant within the ceiling deploys fine
    const narrowed = await deployExtensionVersion(requester, {
      extensionKey: 'capped',
      version: '1.0.0',
      grantedPermissions: ['state:read'],
    });
    expect(narrowed.deployment!.grantedPermissions).toEqual(['state:read']);
  });

  it('holds the deployment at the gate until a human approves, then applies on replay', async () => {
    const admin = extensionAdmin(tenantGate);
    const requester = member(tenantGate);
    const { extensionId } = await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'gated-deploy' }),
    );

    // the built-in default matrix gates EXECUTE: activation first
    const heldActivation = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:gated:1',
    });
    expect(heldActivation.applied).toBe(false);
    await approveRequest(tenantGate, heldActivation.gate.actionRequestId);
    const appliedActivation = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:gated:1',
    });
    expect(appliedActivation.applied).toBe(true);

    // then the deployment waits at the same gate
    const held = await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      idempotencyKey: 'deploy:gated:1',
    });
    expect(held.applied).toBe(false);
    expect(held.deployment).toBeNull();
    expect(held.gate.status).toBe('pending');
    expect(await getCurrentDeployment(member(tenantGate), { extensionId })).toBeNull();

    await approveRequest(tenantGate, held.gate.actionRequestId);
    const applied = await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      idempotencyKey: 'deploy:gated:1',
    });
    expect(applied.applied).toBe(true);
    expect(applied.deployment!.version).toBe('1.0.0');
    expect((await getCurrentDeployment(member(tenantGate), { extensionId }))!.id).toBe(
      applied.deployment!.id,
    );
  });

  it('records the policy rejection when the tenant forbids extension-deployment EXECUTE', async () => {
    const admin = extensionAdmin(tenantForbid);
    const requester = member(tenantForbid);
    const { extensionId } = await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'forbidden-deploy' }),
    );

    // the matrix governs the whole 'extension-deployment' kind: the
    // activation itself is refused and recorded before anything else
    await expectErrorCode('forbidden_by_policy', () =>
      transitionExtension(requester, {
        extensionId,
        transition: 'activate',
        idempotencyKey: 'activate:forbidden:1',
      }),
    );
    // a REGISTERED extension cannot even reach the deploy gate
    await expectErrorCode('extension_not_active', () =>
      deployExtensionVersion(requester, { extensionId, version: '1.0.0' }),
    );

    // storage-legal activation (the lifecycle column is the row's only
    // mutable field, W025), so the DEPLOY gate itself can be observed
    await getDb().query(
      `UPDATE extensions SET lifecycle_state = 'ACTIVE', updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
      [tenantForbid, extensionId],
    );
    await expectErrorCode('forbidden_by_policy', () =>
      deployExtensionVersion(requester, { extensionId, version: '1.0.0' }),
    );
    expect(await getCurrentDeployment(member(tenantForbid), { extensionId })).toBeNull();
    // the policy rejections are recorded actions evidence
    const requests = await listActionRequests(requester, { actionKind: EXTENSION_ACTION_KIND });
    const rejected = requests.find(
      (r) => (r.payload as { operation?: string }).operation === 'deploy',
    )!;
    expect(rejected.status).toBe('rejected');
    expect(rejected.evaluation.outcome).toBe('forbidden');
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe('rollback (recorded deployments are the restore points)', () => {
  it('re-activates a superseded deployment with its recorded grant; state survives', async () => {
    const admin = extensionAdmin(tenantRollback);
    const requester = member(tenantRollback);
    const { extensionId } = await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'rollback-target' }),
    );
    await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:rb:1',
    });

    // v1 deployed with a NARROWED grant (state only)
    const first = await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      grantedPermissions: ['state:read', 'state:write'],
      idempotencyKey: 'deploy:rb:1',
    });
    await writeExtensionState(requester, {
      extensionId,
      key: 'migration-state',
      value: { step: 'v1' },
    });

    // v2 (full grant) becomes current
    await registerVerified(admin, runtimeManifest({ extensionKey: 'rollback-target', version: '2.0.0' }));
    const second = await deployExtensionVersion(requester, {
      extensionId,
      version: '2.0.0',
      idempotencyKey: 'deploy:rb:2',
    });
    expect(second.deployment!.grantedPermissions).toEqual([...FULL_PERMISSIONS]);
    expect((await getCurrentDeployment(requester, { extensionId }))!.id).toBe(second.deployment!.id);

    // tenant-scoped state survives the upgrade
    expect(
      (await readExtensionState(requester, { extensionId, key: 'migration-state' }))?.value,
    ).toEqual({ step: 'v1' });

    // roll back to the first deployment: v1 + its narrowed grant
    const rolled = await rollbackExtensionDeployment(requester, {
      extensionId,
      targetDeploymentId: first.deployment!.id,
      idempotencyKey: 'rollback:rb:1',
    });
    expect(rolled.applied).toBe(true);
    expect(rolled.deployment).toMatchObject({
      version: '1.0.0',
      operation: 'rollback',
      replacesDeploymentId: second.deployment!.id,
      grantedPermissions: ['state:read', 'state:write'],
    });
    expect((await getCurrentDeployment(requester, { extensionId }))!.id).toBe(rolled.deployment!.id);

    // state survives the rollback too — persistence, not recreation
    expect(
      (await readExtensionState(requester, { extensionId, key: 'migration-state' }))?.value,
    ).toEqual({ step: 'v1' });
    // and the restored grant no longer carries the v2 capabilities
    await expectErrorCode('permission_not_granted', () =>
      emitExtensionTelemetry(requester, { extensionId, name: 'run.completed' }),
    );

    // the history is the full append-only trail
    const history = await listExtensionDeployments(requester, { extensionId });
    expect(history.map((d) => d.operation)).toEqual(['deploy', 'deploy', 'rollback']);
    expect(history.map((d) => d.version)).toEqual(['1.0.0', '2.0.0', '1.0.0']);
    expect(history[2]!.replacesDeploymentId).toBe(second.deployment!.id);
  });

  it('rejects nonsense targets with precise errors', async () => {
    const admin = extensionAdmin(tenantRollback);
    const requester = member(tenantRollback);
    await registerVerified(admin, runtimeManifest({ extensionKey: 'rollback-probe' }));
    await transitionExtension(requester, {
      extensionKey: 'rollback-probe',
      transition: 'activate',
      idempotencyKey: 'activate:rp:1',
    });
    const first = await deployExtensionVersion(requester, {
      extensionKey: 'rollback-probe',
      version: '1.0.0',
      idempotencyKey: 'deploy:rp:1',
    });
    await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'rollback-probe', version: '2.0.0' }),
    );
    await deployExtensionVersion(requester, {
      extensionKey: 'rollback-probe',
      version: '2.0.0',
      idempotencyKey: 'deploy:rp:2',
    });

    // the CURRENT deployment is not a rollback target
    const current = (await getCurrentDeployment(requester, { extensionKey: 'rollback-probe' }))!;
    await expectErrorCode('invalid_rollback', () =>
      rollbackExtensionDeployment(requester, {
        extensionKey: 'rollback-probe',
        targetDeploymentId: current.id,
      }),
    );
    // an unknown id is simply not found
    await expectErrorCode('deployment_not_found', () =>
      rollbackExtensionDeployment(requester, {
        extensionKey: 'rollback-probe',
        targetDeploymentId: newId(),
      }),
    );
    // a deployment of the same tenant but a different extension is a mismatch
    const other = await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'rollback-other' }),
    );
    await transitionExtension(requester, {
      extensionKey: 'rollback-other',
      transition: 'activate',
      idempotencyKey: 'activate:rp-other:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'rollback-other', version: '1.0.0' });
    const otherDeploymentId = (
      await getCurrentDeployment(requester, { extensionKey: 'rollback-other' })
    )!.id;
    await expectErrorCode('invalid_rollback', () =>
      rollbackExtensionDeployment(requester, {
        extensionKey: 'rollback-probe',
        targetDeploymentId: otherDeploymentId,
      }),
    );
    expect(other.extensionId).toBeDefined();
    expect(first.deployment!.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Persistent scoped state
// ---------------------------------------------------------------------------

describe('persistent scoped state (tenant and install namespaces)', () => {
  it('serves the tenant namespace: write, read, overwrite (+revision), null-clear', async () => {
    const admin = extensionAdmin(tenantState);
    const requester = member(tenantState);
    const { extensionId } = await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'stateful' }),
    );
    await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:state:1',
    });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0' });

    const created = await writeExtensionState(requester, {
      extensionId,
      key: 'prefs:theme',
      value: { mode: 'dark' },
    });
    expect(created).toMatchObject({
      key: 'prefs:theme',
      value: { mode: 'dark' },
      revision: 1,
      updatedBy: requester.principalId,
    });
    expect(created.bytes).toBe(JSON.stringify({ mode: 'dark' }).length);

    const overwritten = await writeExtensionState(requester, {
      extensionId,
      key: 'prefs:theme',
      value: { mode: 'light' },
    });
    expect(overwritten.revision).toBe(2);
    expect(overwritten.value).toEqual({ mode: 'light' });

    // a missing key reads as null; null is a legal stored value
    expect(await readExtensionState(requester, { extensionId, key: 'missing' })).toBeNull();
    const cleared = await writeExtensionState(requester, { extensionId, key: 'prefs:theme', value: null });
    expect(cleared.value).toBeNull();
    expect(cleared.revision).toBe(3);
    expect((await readExtensionState(requester, { extensionId, key: 'prefs:theme' }))?.value).toBeNull();

    // an install key for which no deployment exists has no runtime at all
    await expectErrorCode('no_deployment', () =>
      writeExtensionState(requester, { extensionId, key: 'k', installKey: 'emea', value: 1 }),
    );
    // with a deployment there, tenant scope is loud about install keys
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'deploy:state:emea',
    });
    await expectErrorCode('scope_mismatch', () =>
      writeExtensionState(requester, { extensionId, key: 'k', installKey: 'emea', value: 1 }),
    );
    await expectErrorCode('scope_mismatch', () =>
      readExtensionState(requester, { extensionId, key: 'k', installKey: 'emea' }),
    );
  });

  it('isolates install-scoped state between installs (and the default)', async () => {
    const admin = extensionAdmin(tenantState);
    const requester = member(tenantState);
    await registerVerified(
      admin,
      runtimeManifest({ extensionKey: 'per-workspace', stateScope: 'install' }),
    );
    await transitionExtension(requester, {
      extensionKey: 'per-workspace',
      transition: 'activate',
      idempotencyKey: 'activate:installs:1',
    });
    for (const installKey of ['default', 'emea', 'apac']) {
      const deployed = await deployExtensionVersion(requester, {
        extensionKey: 'per-workspace',
        version: '1.0.0',
        installKey,
        idempotencyKey: `deploy:installs:${installKey}`,
      });
      expect(deployed.applied).toBe(true);
    }

    await writeExtensionState(requester, { extensionKey: 'per-workspace', key: 'cursor', value: 1 });
    await writeExtensionState(requester, {
      extensionKey: 'per-workspace',
      installKey: 'emea',
      key: 'cursor',
      value: 2,
    });

    // each install sees only its own value; the isolation boundary holds
    expect(
      (await readExtensionState(requester, { extensionKey: 'per-workspace', key: 'cursor' }))?.value,
    ).toBe(1);
    expect(
      (await readExtensionState(requester, {
        extensionKey: 'per-workspace',
        installKey: 'emea',
        key: 'cursor',
      }))?.value,
    ).toBe(2);
    expect(
      await readExtensionState(requester, {
        extensionKey: 'per-workspace',
        installKey: 'apac',
        key: 'cursor',
      }),
    ).toBeNull();

    // an install without a deployment has no runtime at all
    await expectErrorCode('no_deployment', () =>
      readExtensionState(requester, { extensionKey: 'per-workspace', installKey: 'latam', key: 'cursor' }),
    );
  });

  it('refuses state on a manifest that declares none', async () => {
    const admin = extensionAdmin(tenantState);
    const requester = member(tenantState);
    await registerVerified(
      admin,
      inertManifest({
        extensionKey: 'stateless',
        uiSurfaces: ['chat-panel'],
        requestedPermissions: ['ui:render'],
      }),
    );
    await transitionExtension(requester, {
      extensionKey: 'stateless',
      transition: 'activate',
      idempotencyKey: 'activate:stateless:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'stateless', version: '1.0.0' });
    await expectErrorCode('state_not_declared', () =>
      writeExtensionState(requester, { extensionKey: 'stateless', key: 'k', value: 1 }),
    );
    await expectErrorCode('state_not_declared', () =>
      readExtensionState(requester, { extensionKey: 'stateless', key: 'k' }),
    );
  });

  it('enforces the maxStateBytes quota per namespace (overwrites free their old bytes)', async () => {
    const admin = extensionAdmin(tenantQuota);
    const requester = member(tenantQuota);
    await registerVerified(
      admin,
      runtimeManifest({
        extensionKey: 'tiny-state',
        quotas: {
          maxStateBytes: 20,
          maxScheduleInvocationsPerDay: 3,
          maxExternalCallsPerDay: 2,
        },
      }),
    );
    await transitionExtension(requester, {
      extensionKey: 'tiny-state',
      transition: 'activate',
      idempotencyKey: 'activate:tiny:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'tiny-state', version: '1.0.0' });

    // "xxxxxxxxxx" (with quotes) = 12 bytes
    await writeExtensionState(requester, { extensionKey: 'tiny-state', key: 'a', value: 'x'.repeat(10) });
    // a second key would put the namespace at 12 + 12 > 20
    await expectErrorCode('state_quota_exceeded', () =>
      writeExtensionState(requester, { extensionKey: 'tiny-state', key: 'b', value: 'x'.repeat(10) }),
    );
    // overwriting the same key with a smaller value fits (old bytes freed)
    const shrunk = await writeExtensionState(requester, {
      extensionKey: 'tiny-state',
      key: 'a',
      value: 'xx',
    });
    expect(shrunk.revision).toBe(2);
    // now a 4-byte null on key 'b' fits within the 20-byte budget
    expect(
      (await writeExtensionState(requester, { extensionKey: 'tiny-state', key: 'b', value: null })).bytes,
    ).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Declarative UI
// ---------------------------------------------------------------------------

describe('declarative UI (host-rendered, closed vocabulary)', () => {
  it('publishes, reads back and replaces documents per declared surface', async () => {
    const admin = extensionAdmin(tenantUi);
    const requester = member(tenantUi);
    await registerVerified(admin, runtimeManifest({ extensionKey: 'panel-provider' }));
    await transitionExtension(requester, {
      extensionKey: 'panel-provider',
      transition: 'activate',
      idempotencyKey: 'activate:panel:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'panel-provider', version: '1.0.0' });

    const document: ExtensionUiDocument = {
      title: 'Invoice pipeline',
      blocks: [
        { type: 'heading', text: 'Throughput' },
        { type: 'metric', label: 'Processed today', value: '1,204' },
        { type: 'table', columns: ['Bucket', 'Count'], rows: [['paid', '800'], ['open', '404']] },
      ],
    };
    const published = await publishExtensionUi(requester, {
      extensionKey: 'panel-provider',
      surface: 'control-tower-panel',
      document,
    });
    expect(published).toMatchObject({
      extensionKey: 'panel-provider',
      surface: 'control-tower-panel',
      updatedBy: requester.principalId,
    });
    expect(published.document).toEqual(document);

    const read = await getExtensionUi(member(tenantUi), {
      extensionKey: 'panel-provider',
      surface: 'control-tower-panel',
    });
    expect(read?.document).toEqual(document);

    // replace: the document moves, the (extension, surface) identity does not
    const replacement: ExtensionUiDocument = { title: null, blocks: [{ type: 'divider' }] };
    await publishExtensionUi(requester, {
      extensionKey: 'panel-provider',
      surface: 'control-tower-panel',
      document: replacement,
    });
    expect(
      (await getExtensionUi(member(tenantUi), {
        extensionKey: 'panel-provider',
        surface: 'control-tower-panel',
      }))?.document,
    ).toEqual(replacement);

    // an undeclared surface is refused on both sides
    await expectErrorCode('surface_not_declared', () =>
      publishExtensionUi(requester, {
        extensionKey: 'panel-provider',
        surface: 'chat-panel',
        document: replacement,
      }),
    );
    await expectErrorCode('surface_not_declared', () =>
      getExtensionUi(member(tenantUi), { extensionKey: 'panel-provider', surface: 'chat-panel' }),
    );
    expect(
      await getExtensionUi(member(tenantUi), { extensionKey: 'panel-provider', surface: 'settings-form' }),
    ).toBeNull();
  });

  it('stops rendering when a redeploy drops the ui:render grant', async () => {
    const admin = extensionAdmin(tenantUi);
    const requester = member(tenantUi);
    await registerVerified(admin, runtimeManifest({ extensionKey: 'grant-drift' }));
    await transitionExtension(requester, {
      extensionKey: 'grant-drift',
      transition: 'activate',
      idempotencyKey: 'activate:gd:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'grant-drift', version: '1.0.0' });
    await publishExtensionUi(requester, {
      extensionKey: 'grant-drift',
      surface: 'control-tower-panel',
      document: { title: null, blocks: [{ type: 'text', text: 'hello' }] },
    });

    // redeploy WITHOUT ui:render: publishing is refused and the host
    // render read is too — a revoked capability must not keep rendering
    await deployExtensionVersion(requester, {
      extensionKey: 'grant-drift',
      version: '1.0.0',
      grantedPermissions: ['state:read'],
      idempotencyKey: 'deploy:gd:2',
    });
    await expectErrorCode('permission_not_granted', () =>
      publishExtensionUi(requester, {
        extensionKey: 'grant-drift',
        surface: 'control-tower-panel',
        document: { title: null, blocks: [] },
      }),
    );
    await expectErrorCode('permission_not_granted', () =>
      getExtensionUi(member(tenantUi), { extensionKey: 'grant-drift', surface: 'control-tower-panel' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

describe('schedules (declared triggers, daily quota, append-only runs)', () => {
  it('fires declared schedules by name and records the cron at invocation time', async () => {
    const admin = extensionAdmin(tenantSchedules);
    const requester = member(tenantSchedules);
    await registerVerified(admin, runtimeManifest({ extensionKey: 'scheduler' }));
    await transitionExtension(requester, {
      extensionKey: 'scheduler',
      transition: 'activate',
      idempotencyKey: 'activate:sched:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'scheduler', version: '1.0.0' });

    const run = await triggerExtensionSchedule(requester, {
      extensionKey: 'scheduler',
      scheduleName: 'nightly-sync',
    });
    expect(run).toMatchObject({
      extensionKey: 'scheduler',
      installKey: 'default',
      scheduleName: 'nightly-sync',
      cron: '0 2 * * *',
      invokedBy: requester.principalId,
    });

    await expectErrorCode('schedule_not_declared', () =>
      triggerExtensionSchedule(requester, { extensionKey: 'scheduler', scheduleName: 'hourly-purge' }),
    );

    // the declared quota is 3/day for this install
    await triggerExtensionSchedule(requester, { extensionKey: 'scheduler', scheduleName: 'nightly-sync' });
    await triggerExtensionSchedule(requester, { extensionKey: 'scheduler', scheduleName: 'nightly-sync' });
    await expectErrorCode('schedule_quota_exceeded', () =>
      triggerExtensionSchedule(requester, { extensionKey: 'scheduler', scheduleName: 'nightly-sync' }),
    );
    const runs = await listExtensionScheduleRuns(member(tenantSchedules), { extensionKey: 'scheduler' });
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.cron === '0 2 * * *')).toBe(true);

    // a second install has its own quota window (its own deployment)
    await deployExtensionVersion(requester, {
      extensionKey: 'scheduler',
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'deploy:sched:emea',
    });
    const emeaRun = await triggerExtensionSchedule(requester, {
      extensionKey: 'scheduler',
      installKey: 'emea',
      scheduleName: 'nightly-sync',
    });
    expect(emeaRun.installKey).toBe('emea');
  });
});

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

describe('event subscriptions (fan-out dispatch, grant visibility)', () => {
  it('delivers a topic to every subscribed install — or records not_granted', async () => {
    const admin = extensionAdmin(tenantEvents);
    const requester = member(tenantEvents);

    // A: subscribed + granted (the fixture, default install)
    await registerVerified(admin, runtimeManifest({ extensionKey: 'invoice-ocr' }));
    await transitionExtension(requester, {
      extensionKey: 'invoice-ocr',
      transition: 'activate',
      idempotencyKey: 'activate:events:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'invoice-ocr', version: '1.0.0' });

    // B: subscribed but deployed WITHOUT events:subscribe
    await registerVerified(admin, runtimeManifest({ extensionKey: 'quiet-subscriber' }));
    await transitionExtension(requester, {
      extensionKey: 'quiet-subscriber',
      transition: 'activate',
      idempotencyKey: 'activate:events:2',
    });
    await deployExtensionVersion(requester, {
      extensionKey: 'quiet-subscriber',
      version: '1.0.0',
      grantedPermissions: ['state:read', 'state:write'],
    });

    // C: deployed, not subscribed to this topic
    await registerVerified(
      admin,
      runtimeManifest({
        extensionKey: 'other-topics',
        eventSubscriptions: ['supplier.updated'],
      }),
    );
    await transitionExtension(requester, {
      extensionKey: 'other-topics',
      transition: 'activate',
      idempotencyKey: 'activate:events:3',
    });
    await deployExtensionVersion(requester, { extensionKey: 'other-topics', version: '1.0.0' });

    const dispatch = await dispatchExtensionEvent(requester, {
      topic: 'invoice.paid',
      payload: { invoiceId: 'INV-42', amount: 1200 },
    });
    expect(dispatch.topic).toBe('invoice.paid');
    expect(dispatch.delivered).toBe(1);
    expect(dispatch.notGranted).toBe(1);
    expect(dispatch.deliveries.map((d) => d.extensionKey).sort()).toEqual([
      'invoice-ocr',
      'quiet-subscriber',
    ]);
    expect(dispatch.deliveries.find((d) => d.extensionKey === 'invoice-ocr')).toMatchObject({
      topic: 'invoice.paid',
      outcome: 'delivered',
      installKey: 'default',
    });
    expect(dispatch.deliveries.find((d) => d.extensionKey === 'quiet-subscriber')?.outcome).toBe(
      'not_granted',
    );

    // the payload round-trips through the delivery evidence
    const deliveries = await listExtensionEventDeliveries(requester, { extensionKey: 'invoice-ocr' });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.payload).toEqual({ invoiceId: 'INV-42', amount: 1200 });

    // an unsubscribed topic reaches nobody
    const none = await dispatchExtensionEvent(requester, { topic: 'nobody.subscribed' });
    expect(none.delivered).toBe(0);
    expect(none.deliveries).toEqual([]);

    // a suspended (disabled) subscriber receives nothing; resume restores
    await transitionExtension(requester, {
      extensionKey: 'invoice-ocr',
      transition: 'suspend',
      idempotencyKey: 'suspend:invoice-ocr:1',
    });
    const whileSuspended = await dispatchExtensionEvent(requester, { topic: 'invoice.paid' });
    expect(whileSuspended.delivered).toBe(0);
    expect(whileSuspended.deliveries.map((d) => d.extensionKey)).toEqual(['quiet-subscriber']);
    await transitionExtension(requester, {
      extensionKey: 'invoice-ocr',
      transition: 'resume',
      idempotencyKey: 'resume:invoice-ocr:1',
    });
    const afterResume = await dispatchExtensionEvent(requester, { topic: 'invoice.paid' });
    expect(afterResume.delivered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scoped external participation
// ---------------------------------------------------------------------------

describe('scoped external participation (exact-origin sandbox, egress port, quota)', () => {
  it('runs the full external participation surface', async () => {
    const admin = extensionAdmin(tenantExternal);
    const requester = member(tenantExternal);
    await registerVerified(
      admin,
      runtimeManifest({
        extensionKey: 'api-partner',
        quotas: { maxStateBytes: 1_048_576, maxScheduleInvocationsPerDay: 3, maxExternalCallsPerDay: 3 },
      }),
    );
    await transitionExtension(requester, {
      extensionKey: 'api-partner',
      transition: 'activate',
      idempotencyKey: 'activate:ext:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'api-partner', version: '1.0.0' });
    const base = { extensionKey: 'api-partner' as const, origin: 'https://api.invoices.example.com' };

    // success
    const ok = await executeExtensionExternalCall(requester, {
      ...base,
      method: 'POST',
      path: '/v1/invoices',
      body: { number: 'INV-1' },
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(ok).toMatchObject({
      extensionKey: 'api-partner',
      origin: 'https://api.invoices.example.com',
      method: 'POST',
      path: '/v1/invoices',
      outcome: 'succeeded',
      responseStatus: 200,
      detail: null,
    });
    expect(ok.requestBodyBytes).toBe(JSON.stringify({ number: 'INV-1' }).length);
    // the port saw the full request — including the header the evidence never stores
    expect(portCalls.at(-1)).toMatchObject({
      url: 'https://api.invoices.example.com/v1/invoices',
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token' },
    });

    // http error (non-2xx) and network failure (port throw)
    const missing = await executeExtensionExternalCall(requester, { ...base, method: 'GET', path: '/notfound' });
    expect(missing).toMatchObject({ outcome: 'http_error', responseStatus: 404 });
    expect(missing.detail).toContain('HTTP 404');
    const boomed = await executeExtensionExternalCall(requester, { ...base, method: 'GET', path: '/boom' });
    expect(boomed).toMatchObject({ outcome: 'failed', responseStatus: null });
    expect(boomed.detail).toContain('egress failed');

    // the sandbox: only the EXACT declared origin, never a lookalike
    await expectErrorCode('origin_not_declared', () =>
      executeExtensionExternalCall(requester, {
        extensionKey: 'api-partner',
        origin: 'https://api.invoices.example.com.evil.io',
        method: 'GET',
        path: '/',
      }),
    );

    // the declared quota is 3/day for this install — all used up
    await expectErrorCode('external_quota_exceeded', () =>
      executeExtensionExternalCall(requester, { ...base, method: 'GET', path: '/v2/one-more' }),
    );

    // the call evidence never contains the header values
    const calls = await listExtensionExternalCalls(member(tenantExternal), { extensionKey: 'api-partner' });
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.outcome)).toEqual(['succeeded', 'http_error', 'failed']);
    expect(JSON.stringify(calls)).not.toContain('secret-token');
  });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

describe('telemetry (extension-emitted, capability- and grant-gated)', () => {
  it('appends bounded telemetry events and lists them back', async () => {
    const admin = extensionAdmin(tenantTelemetry);
    const requester = member(tenantTelemetry);
    await registerVerified(admin, runtimeManifest({ extensionKey: 'chatty' }));
    await transitionExtension(requester, {
      extensionKey: 'chatty',
      transition: 'activate',
      idempotencyKey: 'activate:tel:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'chatty', version: '1.0.0' });

    const event = await emitExtensionTelemetry(requester, {
      extensionKey: 'chatty',
      name: 'run.completed',
      payload: { processed: 42, durationMs: 1300 },
    });
    expect(event).toMatchObject({
      extensionKey: 'chatty',
      installKey: 'default',
      name: 'run.completed',
      emittedBy: requester.principalId,
    });
    expect(event.payload).toEqual({ processed: 42, durationMs: 1300 });

    await emitExtensionTelemetry(requester, { extensionKey: 'chatty', name: 'run.skipped' });
    const events = await listExtensionTelemetryEvents(member(tenantTelemetry), { extensionKey: 'chatty' });
    expect(events.map((e) => e.name)).toEqual(['run.completed', 'run.skipped']);

    // a manifest without the telemetry capability refuses emission
    await registerVerified(
      admin,
      inertManifest({
        extensionKey: 'silent-runner',
        stateScope: 'tenant',
        requestedPermissions: ['state:read', 'state:write'],
        quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      }),
    );
    await transitionExtension(requester, {
      extensionKey: 'silent-runner',
      transition: 'activate',
      idempotencyKey: 'activate:tel:2',
    });
    await deployExtensionVersion(requester, { extensionKey: 'silent-runner', version: '1.0.0' });
    await expectErrorCode('telemetry_not_declared', () =>
      emitExtensionTelemetry(requester, { extensionKey: 'silent-runner', name: 'run.completed' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Disablement (suspension makes the extension fully inert)
// ---------------------------------------------------------------------------

describe('disablement (a suspended extension is inert; resume restores)', () => {
  it('refuses every runtime operation while SUSPENDED, then works again after resume', async () => {
    const admin = extensionAdmin(tenantDisabled);
    const requester = member(tenantDisabled);
    await registerVerified(admin, runtimeManifest({ extensionKey: 'flaky' }));
    await transitionExtension(requester, {
      extensionKey: 'flaky',
      transition: 'activate',
      idempotencyKey: 'activate:flaky:1',
    });
    await deployExtensionVersion(requester, { extensionKey: 'flaky', version: '1.0.0' });
    await writeExtensionState(requester, { extensionKey: 'flaky', key: 'cursor', value: 5 });

    const suspended = await transitionExtension(requester, {
      extensionKey: 'flaky',
      transition: 'suspend',
      idempotencyKey: 'suspend:flaky:1',
    });
    expect(suspended.applied).toBe(true);

    for (const fn of [
      () => readExtensionState(requester, { extensionKey: 'flaky', key: 'cursor' }),
      () => writeExtensionState(requester, { extensionKey: 'flaky', key: 'cursor', value: 6 }),
      () =>
        publishExtensionUi(requester, {
          extensionKey: 'flaky',
          surface: 'control-tower-panel',
          document: { title: null, blocks: [] },
        }),
      () => getExtensionUi(requester, { extensionKey: 'flaky', surface: 'control-tower-panel' }),
      () => triggerExtensionSchedule(requester, { extensionKey: 'flaky', scheduleName: 'nightly-sync' }),
      () =>
        executeExtensionExternalCall(requester, {
          extensionKey: 'flaky',
          origin: 'https://api.invoices.example.com',
          method: 'GET',
          path: '/',
        }),
      () => emitExtensionTelemetry(requester, { extensionKey: 'flaky', name: 'run.completed' }),
      () => deployExtensionVersion(requester, { extensionKey: 'flaky', version: '1.0.0' }),
    ]) {
      await expectErrorCode('extension_not_active', fn);
    }
    // dispatch skips the suspended extension entirely (no delivery)
    const dispatch = await dispatchExtensionEvent(requester, { topic: 'invoice.paid' });
    expect(dispatch.deliveries.filter((d) => d.extensionKey === 'flaky')).toEqual([]);

    // resume restores the runtime; state survived the suspension
    await transitionExtension(requester, {
      extensionKey: 'flaky',
      transition: 'resume',
      idempotencyKey: 'resume:flaky:1',
    });
    expect((await readExtensionState(requester, { extensionKey: 'flaky', key: 'cursor' }))?.value).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001) — uniform not-found, no existence leaks
// ---------------------------------------------------------------------------

describe('tenant isolation (uniform not-found, no existence leaks)', () => {
  it('makes every runtime surface blind to another tenant', async () => {
    const adminA = extensionAdmin(tenantIsoA);
    const requesterA = member(tenantIsoA);
    const adminB = extensionAdmin(tenantIsoB);
    const memberB = member(tenantIsoB);

    const { extensionId } = await registerVerified(
      adminA,
      runtimeManifest({ extensionKey: 'shared-key' }),
    );
    await transitionExtension(requesterA, {
      extensionKey: 'shared-key',
      transition: 'activate',
      idempotencyKey: 'activate:iso:1',
    });
    const deployed = await deployExtensionVersion(requesterA, {
      extensionKey: 'shared-key',
      version: '1.0.0',
    });
    await writeExtensionState(requesterA, { extensionKey: 'shared-key', key: 'secret', value: 'A' });

    // two tenants may register the same key independently; B is
    // ACTIVE too, so its refusals below are about isolation — not state
    await registerVerified(adminB, runtimeManifest({ extensionKey: 'shared-key', version: '2.0.0' }));
    expect((await getExtension(adminB, { extensionKey: 'shared-key' })).latestVersion).toBe('2.0.0');
    const requesterB = member(tenantIsoB);
    await transitionExtension(requesterB, {
      extensionKey: 'shared-key',
      transition: 'activate',
      idempotencyKey: 'activate:iso-b:1',
    });
    const deployedB = await deployExtensionVersion(requesterB, {
      extensionKey: 'shared-key',
      version: '2.0.0',
    });
    expect(deployedB.applied).toBe(true);
    expect(deployedB.deployment!.id).not.toBe(deployed.deployment!.id);
    await writeExtensionState(requesterB, { extensionKey: 'shared-key', key: 'secret', value: 'B' });

    // B cannot see or touch A's runtime through ANY surface
    await expectErrorCode('extension_not_found', () =>
      readExtensionState(memberB, { extensionId, key: 'secret' }),
    );
    await expectErrorCode('extension_not_found', () =>
      writeExtensionState(memberB, { extensionId, key: 'secret', value: 'B' }),
    );
    await expectErrorCode('extension_not_found', () =>
      getExtensionUi(memberB, { extensionId, surface: 'control-tower-panel' }),
    );
    await expectErrorCode('extension_not_found', () =>
      publishExtensionUi(memberB, {
        extensionId,
        surface: 'control-tower-panel',
        document: { title: null, blocks: [] },
      }),
    );
    await expectErrorCode('extension_not_found', () =>
      triggerExtensionSchedule(memberB, { extensionId, scheduleName: 'nightly-sync' }),
    );
    await expectErrorCode('extension_not_found', () => listExtensionScheduleRuns(memberB, { extensionId }));
    await expectErrorCode('extension_not_found', () =>
      listExtensionEventDeliveries(memberB, { extensionId }),
    );
    await expectErrorCode('extension_not_found', () =>
      executeExtensionExternalCall(memberB, {
        extensionId,
        origin: 'https://api.invoices.example.com',
        method: 'GET',
        path: '/',
      }),
    );
    await expectErrorCode('extension_not_found', () =>
      listExtensionExternalCalls(memberB, { extensionId }),
    );
    await expectErrorCode('extension_not_found', () =>
      emitExtensionTelemetry(memberB, { extensionId, name: 'run.completed' }),
    );
    await expectErrorCode('extension_not_found', () =>
      listExtensionTelemetryEvents(memberB, { extensionId }),
    );
    await expectErrorCode('extension_not_found', () => getCurrentDeployment(memberB, { extensionId }));
    await expectErrorCode('extension_not_found', () =>
      listExtensionDeployments(memberB, { extensionId }),
    );
    await expectErrorCode('extension_not_found', () =>
      deployExtensionVersion(memberB, { extensionId, version: '1.0.0' }),
    );
    // B's own extension exists, so a foreign DEPLOYMENT id under it is
    // precisely a missing deployment — not a missing extension
    await expectErrorCode('deployment_not_found', () =>
      rollbackExtensionDeployment(memberB, {
        extensionKey: 'shared-key',
        targetDeploymentId: deployed.deployment!.id,
      }),
    );

    // B's dispatch reaches B's own subscribed install — never A's
    const dispatchB = await dispatchExtensionEvent(memberB, { topic: 'invoice.paid' });
    expect(dispatchB.delivered).toBe(1);
    expect(dispatchB.deliveries.map((d) => d.extensionId)).not.toContain(extensionId);

    // and A's data is unchanged — each tenant's namespace is its own
    expect(
      (await readExtensionState(requesterA, { extensionKey: 'shared-key', key: 'secret' }))?.value,
    ).toBe('A');
    expect(
      (await readExtensionState(requesterB, { extensionKey: 'shared-key', key: 'secret' }))?.value,
    ).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (triggers enforce what the service promises)
// ---------------------------------------------------------------------------

describe('storage-level guarantees (triggers enforce what the service promises)', () => {
  const admin = extensionAdmin(tenantStorage);
  const requester = member(tenantStorage);
  let extensionId = '';
  let deploymentId = '';
  let stateRowId = '';
  let runId = '';
  let deliveryId = '';
  let callId = '';
  let telemetryId = '';
  let uiRowId = '';

  beforeAll(async () => {
    await registerVerified(admin, runtimeManifest({ extensionKey: 'storage-probe' }));
    await transitionExtension(requester, {
      extensionKey: 'storage-probe',
      transition: 'activate',
      idempotencyKey: 'activate:storage:1',
    });
    const deployed = await deployExtensionVersion(requester, {
      extensionKey: 'storage-probe',
      version: '1.0.0',
    });
    extensionId = deployed.deployment!.extensionId;
    deploymentId = deployed.deployment!.id;

    await writeExtensionState(requester, {
      extensionKey: 'storage-probe',
      key: 'probe',
      value: { n: 1 },
    });
    const run = await triggerExtensionSchedule(requester, {
      extensionKey: 'storage-probe',
      scheduleName: 'nightly-sync',
    });
    runId = run.id;
    const dispatch = await dispatchExtensionEvent(requester, { topic: 'invoice.paid', payload: 1 });
    deliveryId = dispatch.deliveries[0]!.id;
    const call = await executeExtensionExternalCall(requester, {
      extensionKey: 'storage-probe',
      origin: 'https://api.invoices.example.com',
      method: 'GET',
      path: '/',
    });
    callId = call.id;
    const telemetry = await emitExtensionTelemetry(requester, {
      extensionKey: 'storage-probe',
      name: 'run.completed',
    });
    telemetryId = telemetry.id;
    await publishExtensionUi(requester, {
      extensionKey: 'storage-probe',
      surface: 'control-tower-panel',
      document: { title: null, blocks: [{ type: 'divider' }] },
    });
    const db = getDb();
    uiRowId = (
      await db.query<{ id: string }>(
        `SELECT id FROM extension_ui WHERE tenant_id = $1 AND extension_id = $2`,
        [tenantStorage, extensionId],
      )
    ).rows[0]!.id;
    stateRowId = (
      await db.query<{ id: string }>(
        `SELECT id FROM extension_state WHERE tenant_id = $1 AND extension_id = $2 AND state_key = 'probe'`,
        [tenantStorage, extensionId],
      )
    ).rows[0]!.id;
  });

  it('deployments are append-only — no UPDATE, no DELETE, no TRUNCATE', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE extension_deployments SET version = '9.9.9' WHERE id = $1`, [deploymentId]),
    ).rejects.toThrow(/append-only history/);
    await expect(
      db.query(`DELETE FROM extension_deployments WHERE id = $1`, [deploymentId]),
    ).rejects.toThrow(/append-only history/);
    await expect(db.query(`TRUNCATE extension_deployments`)).rejects.toThrow(/append-only history/);
  });

  it('schedule runs, deliveries, external calls and telemetry are append-only', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE extension_schedule_runs SET cron = '* * * * *' WHERE id = $1`, [runId]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      db.query(`DELETE FROM extension_event_deliveries WHERE id = $1`, [deliveryId]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      db.query(`UPDATE extension_external_calls SET outcome = 'succeeded' WHERE id = $1`, [callId]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      db.query(`DELETE FROM extension_telemetry_events WHERE id = $1`, [telemetryId]),
    ).rejects.toThrow(/append-only evidence/);
  });

  it('state is persistent: identity immutable, revision +1 per write, no DELETE/TRUNCATE', async () => {
    const db = getDb();
    await expect(db.query(`DELETE FROM extension_state WHERE id = $1`, [stateRowId])).rejects.toThrow(
      /persistent/,
    );
    await expect(db.query(`TRUNCATE extension_state`)).rejects.toThrow(/persistent/);
    await expect(
      db.query(`UPDATE extension_state SET state_key = 'renamed' WHERE id = $1`, [stateRowId]),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      db.query(`UPDATE extension_state SET install_key = 'other' WHERE id = $1`, [stateRowId]),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      db.query(`UPDATE extension_state SET revision = revision + 5 WHERE id = $1`, [stateRowId]),
    ).rejects.toThrow(/advance by exactly one/);
    // the legal write moves exactly as the service does
    await db.query(
      `UPDATE extension_state SET value = '2'::jsonb, bytes = 3, revision = revision + 1, updated_at = now() WHERE id = $1`,
      [stateRowId],
    );
  });

  it('UI declarations are replaceable, not deletable; identity is immutable', async () => {
    const db = getDb();
    await expect(db.query(`DELETE FROM extension_ui WHERE id = $1`, [uiRowId])).rejects.toThrow(
      /not deletable/,
    );
    await expect(db.query(`TRUNCATE extension_ui`)).rejects.toThrow(/not deletable/);
    await expect(
      db.query(`UPDATE extension_ui SET surface = 'chat-panel' WHERE id = $1`, [uiRowId]),
    ).rejects.toThrow(/identity is immutable/);
    // the document itself may be replaced
    await db.query(
      `UPDATE extension_ui SET document = '{"title":null,"blocks":[]}'::jsonb, updated_at = now() WHERE id = $1`,
      [uiRowId],
    );
  });

  it('enforces the grant ⊆ requested-ceiling trigger for writes bypassing the service', async () => {
    const db = getDb();
    // a manifest with a narrow ceiling to deploy against
    const { manifestId } = await registerVerified(
      admin,
      inertManifest({
        extensionKey: 'storage-probe',
        version: '2.0.0',
        stateScope: 'tenant',
        requestedPermissions: ['state:read', 'state:write'],
        quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      }),
    );
    await expect(
      db.query(
        `INSERT INTO extension_deployments (
           tenant_id, extension_id, extension_key, install_key, manifest_id, version,
           operation, replaces_deployment_id, granted_permissions, deployed_by, deployed_at, action_request_id
         ) VALUES ($1, $2, 'storage-probe', 'bypass', $3, '2.0.0', 'deploy', NULL,
           '["state:read","state:write","ui:render"]'::jsonb, 'probe', now(), NULL)`,
        [tenantStorage, extensionId, manifestId],
      ),
    ).rejects.toThrow(/requested ceiling/);

    // a consistent bypass write is accepted (the control)
    await db.query(
      `INSERT INTO extension_deployments (
         tenant_id, extension_id, extension_key, install_key, manifest_id, version,
         operation, replaces_deployment_id, granted_permissions, deployed_by, deployed_at, action_request_id
       ) VALUES ($1, $2, 'storage-probe', 'bypass', $3, '2.0.0', 'deploy', NULL,
         '["state:read","state:write"]'::jsonb, 'probe', now(), NULL)`,
      [tenantStorage, extensionId, manifestId],
    );
    const bypass = await getCurrentDeployment(admin, {
      extensionKey: 'storage-probe',
      installKey: 'bypass',
    });
    expect(bypass?.grantedPermissions).toEqual(['state:read', 'state:write']);
  });
});
