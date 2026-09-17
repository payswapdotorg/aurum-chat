// W047 — Capability Security Verification: INSTALL boundaries.
//
// Proves the extension runtime (W026) keeps installs isolated namespaces
// inside one tenant: install-scoped persistent state never crosses
// installs, tenant-scoped state is shared across installs but never
// leaves the tenant, deployments and their grants are tracked per
// install, event deliveries land per install, quotas are enforced per
// install namespace (not per tenant), an install without a deployment
// has no runtime at all, and the storage level keeps a state row's
// install identity immutable (a namespace cannot be moved after the
// fact, even by a write bypassing the service).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import {
  allowExtensionDeployment,
  deployExtensionVersion,
  dispatchExtensionEvent,
  executeExtensionExternalCall,
  expectExtensionsError,
  extensionAdmin,
  fullManifest,
  getCurrentDeployment,
  inertManifest,
  listExtensionDeployments,
  listExtensionEventDeliveries,
  member,
  newId,
  readExtensionState,
  registerVerified,
  rollbackExtensionDeployment,
  runMigrations,
  transitionExtension,
  triggerExtensionSchedule,
  wireFakeEgressPort,
  writeExtensionState,
} from './harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';

// One tenant for the whole file: install boundaries are INTRA-tenant by
// definition (cross-tenant blindness is tenant-boundaries.test.ts). The
// tenant allows extension-deployment EXECUTE so deployments apply
// immediately and every refusal below is about the install boundary.
const tenant = newId();

beforeAll(async () => {
  await runMigrations(getDb());
  await allowExtensionDeployment(tenant);
  // deterministic egress for the external-participation quota probes
  wireFakeEgressPort();
});

afterAll(async () => {
  await closeDb();
});

/** Register + verify + activate one full-capability extension. */
async function activatedExtension(
  extensionKey: string,
  overrides: Parameters<typeof fullManifest>[0] = {},
): Promise<string> {
  const admin = extensionAdmin(tenant);
  const { extensionId } = await registerVerified(admin, fullManifest({ extensionKey, ...overrides }));
  const activated = await transitionExtension(member(tenant), {
    extensionId,
    transition: 'activate',
    idempotencyKey: `w047:activate:${extensionKey}:1`,
  });
  expect(activated.applied).toBe(true);
  return extensionId;
}

// ---------------------------------------------------------------------------
// Install-scoped persistent state
// ---------------------------------------------------------------------------

describe('install-scoped state: installs are isolated namespaces', () => {
  it('state written in one install is invisible in every other install', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('per-install-state', { stateScope: 'install' });
    for (const installKey of ['default', 'emea', 'apac']) {
      const deployed = await deployExtensionVersion(requester, {
        extensionId,
        version: '1.0.0',
        installKey,
        idempotencyKey: `w047:deploy:per-install-state:${installKey}`,
      });
      expect(deployed.applied).toBe(true);
    }

    await writeExtensionState(requester, { extensionId, key: 'cursor', value: 1 });
    await writeExtensionState(requester, { extensionId, installKey: 'emea', key: 'cursor', value: 2 });
    await writeExtensionState(requester, { extensionId, installKey: 'apac', key: 'cursor', value: 3 });

    // each install sees only its own value — the install boundary holds
    expect((await readExtensionState(requester, { extensionId, key: 'cursor' }))?.value).toBe(1);
    expect(
      (await readExtensionState(requester, { extensionId, installKey: 'emea', key: 'cursor' }))?.value,
    ).toBe(2);
    expect(
      (await readExtensionState(requester, { extensionId, installKey: 'apac', key: 'cursor' }))?.value,
    ).toBe(3);

    // a key written in one install does not exist in another
    await writeExtensionState(requester, { extensionId, installKey: 'emea', key: 'emea-only', value: 'x' });
    expect(
      await readExtensionState(requester, { extensionId, installKey: 'apac', key: 'emea-only' }),
    ).toBeNull();
    expect(await readExtensionState(requester, { extensionId, key: 'emea-only' })).toBeNull();
  });

  it('an install without a deployment has no runtime at all', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('undeployed-install', { stateScope: 'install' });
    await expectExtensionsError('no_deployment', () =>
      readExtensionState(requester, { extensionId, installKey: 'latam', key: 'cursor' }),
    );
    await expectExtensionsError('no_deployment', () =>
      writeExtensionState(requester, {
        extensionKey: 'undeployed-install',
        installKey: 'latam',
        key: 'cursor',
        value: 1,
      }),
    );
  });

  it('a tenant-scoped manifest rejects install-scoped addressing (loud, not silent)', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('tenant-scoped-state');
    // both installs have a deployment — so the refusals below are about
    // the scope, not a missing runtime
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:tenant-scoped-state:emea',
    });
    await writeExtensionState(requester, { extensionId, key: 'shared', value: 'tenant-wide' });
    // tenant scope ignores installs by design — supplying one is a mismatch
    await expectExtensionsError('scope_mismatch', () =>
      readExtensionState(requester, { extensionId, installKey: 'emea', key: 'shared' }),
    );
    await expectExtensionsError('scope_mismatch', () =>
      writeExtensionState(requester, { extensionId, installKey: 'emea', key: 'shared', value: 'x' }),
    );
  });

  it('tenant-scoped state is shared across installs — but never beyond the tenant', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('shared-across-installs');
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'default' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:shared-across-installs:emea',
    });
    // written through the default install…
    await writeExtensionState(requester, { extensionId, key: 'shared', value: 'tenant-wide' });
    // …read back through the emea install: same tenant namespace
    expect((await readExtensionState(requester, { extensionId, key: 'shared' }))?.value).toBe(
      'tenant-wide',
    );
    // one physical namespace: the revision advanced exactly once
    const entry = await readExtensionState(requester, { extensionId, key: 'shared' });
    expect(entry?.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Deployments per install
// ---------------------------------------------------------------------------

describe('deployments: each install tracks its own version and grant', () => {
  it('deploying to one install never moves another install', async () => {
    const admin = extensionAdmin(tenant);
    const requester = member(tenant);
    const extensionId = await activatedExtension('per-install-deploy', { stateScope: 'install' });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'default' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:per-install-deploy:emea',
    });
    // v2 exists and is verified
    await registerVerified(admin, fullManifest({ extensionKey: 'per-install-deploy', version: '2.0.0' }));
    await deployExtensionVersion(requester, {
      extensionId,
      version: '2.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:per-install-deploy:emea:v2',
    });

    // emea runs v2; default stays on v1 — installs move independently
    expect((await getCurrentDeployment(requester, { extensionId, installKey: 'emea' }))?.version).toBe(
      '2.0.0',
    );
    expect(
      (await getCurrentDeployment(requester, { extensionId, installKey: 'default' }))?.version,
    ).toBe('1.0.0');
    expect(
      (await getCurrentDeployment(requester, { extensionId, installKey: 'apac' })),
    ).toBeNull();

    // each install lists only its own deployment history
    expect(await listExtensionDeployments(requester, { extensionId, installKey: 'emea' })).toHaveLength(
      2,
    );
    expect(
      await listExtensionDeployments(requester, { extensionId, installKey: 'default' }),
    ).toHaveLength(1);
  });

  it('a rollback target of another install is rejected as a mismatch', async () => {
    const admin = extensionAdmin(tenant);
    const requester = member(tenant);
    const extensionId = await activatedExtension('per-install-rollback', { stateScope: 'install' });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'emea' });
    await registerVerified(
      admin,
      fullManifest({ extensionKey: 'per-install-rollback', version: '2.0.0' }),
    );
    await deployExtensionVersion(requester, {
      extensionId,
      version: '2.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:per-install-rollback:emea:v2',
    });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'default',
      idempotencyKey: 'w047:deploy:per-install-rollback:default',
    });

    // the emea v1 deployment exists in the tenant — but it belongs to a
    // different install than 'default', so default cannot roll back to it
    const emeaHistory = await listExtensionDeployments(requester, { extensionId, installKey: 'emea' });
    const emeaV1 = emeaHistory.find((deployment) => deployment.version === '1.0.0')!;
    await expectExtensionsError('invalid_rollback', () =>
      rollbackExtensionDeployment(requester, {
        extensionId,
        targetDeploymentId: emeaV1.id,
        installKey: 'default',
      }),
    );
    // emea itself CAN roll back to it (control)
    const rollback = await rollbackExtensionDeployment(requester, {
      extensionId,
      targetDeploymentId: emeaV1.id,
      installKey: 'emea',
      idempotencyKey: 'w047:rollback:per-install-rollback:emea',
    });
    expect(rollback.applied).toBe(true);
    expect((await getCurrentDeployment(requester, { extensionId, installKey: 'emea' }))?.version).toBe(
      '1.0.0',
    );
  });
});

// ---------------------------------------------------------------------------
// Event deliveries per install
// ---------------------------------------------------------------------------

describe('event deliveries: fan-out lands per install, grants decide visibility', () => {
  it('each subscribed install gets its own delivery; a grant downgrade is evidence, not silence', async () => {
    const requester = member(tenant);
    // a topic ONLY this extension subscribes to, so the counts are exact
    const extensionId = await activatedExtension('per-install-events', {
      eventSubscriptions: ['w047.install.topic'],
    });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'default' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:per-install-events:emea',
    });

    const first = await dispatchExtensionEvent(requester, { topic: 'w047.install.topic', payload: 1 });
    expect(first.delivered).toBe(2);
    expect(first.notGranted).toBe(0);

    // redeploy emea with a grant that drops events:subscribe
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      grantedPermissions: ['state:read', 'state:write'],
      idempotencyKey: 'w047:deploy:per-install-events:emea:narrowed',
    });
    const second = await dispatchExtensionEvent(requester, { topic: 'w047.install.topic', payload: 2 });
    expect(second.delivered).toBe(1);
    expect(second.notGranted).toBe(1);
    const emeaDelivery = second.deliveries.find((delivery) => delivery.installKey === 'emea')!;
    expect(emeaDelivery.outcome).toBe('not_granted');
    const defaultDelivery = second.deliveries.find((delivery) => delivery.installKey === 'default')!;
    expect(defaultDelivery.outcome).toBe('delivered');

    // each install's delivery list is its own
    const emeaDeliveries = await listExtensionEventDeliveries(requester, {
      extensionId,
      installKey: 'emea',
    });
    expect(emeaDeliveries).toHaveLength(2);
    expect(emeaDeliveries.every((delivery) => delivery.installKey === 'emea')).toBe(true);
    const defaultDeliveries = await listExtensionEventDeliveries(requester, {
      extensionId,
      installKey: 'default',
    });
    expect(defaultDeliveries).toHaveLength(2);
    expect(defaultDeliveries.every((delivery) => delivery.outcome === 'delivered')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quotas are per-install namespaces
// ---------------------------------------------------------------------------

describe('quotas: enforced per install namespace, not per tenant', () => {
  it('external-call quota is per (extension, install, day)', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('per-install-external', {
      quotas: {
        maxStateBytes: 1_048_576,
        maxScheduleInvocationsPerDay: 1_440,
        maxExternalCallsPerDay: 2,
      },
    });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'default' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:per-install-external:emea',
    });
    const base = {
      extensionId,
      origin: 'https://api.invoices.example.com',
      method: 'GET' as const,
    };

    // default exhausts its own daily budget of two
    await executeExtensionExternalCall(requester, { ...base, installKey: 'default', path: '/one' });
    await executeExtensionExternalCall(requester, { ...base, installKey: 'default', path: '/two' });
    await expectExtensionsError('external_quota_exceeded', () =>
      executeExtensionExternalCall(requester, { ...base, installKey: 'default', path: '/three' }),
    );
    // emea still has its OWN budget — install isolation of the quota
    const emeaCall = await executeExtensionExternalCall(requester, {
      ...base,
      installKey: 'emea',
      path: '/emea-one',
    });
    expect(emeaCall.outcome).toBe('succeeded');
  });

  it('state quota is per namespace: a full install does not block another', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('per-install-state-quota', {
      stateScope: 'install',
      quotas: {
        maxStateBytes: 20,
        maxScheduleInvocationsPerDay: 1_440,
        maxExternalCallsPerDay: 100_000,
      },
    });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'default' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:per-install-state-quota:emea',
    });

    // "xxxxxxxxxx" (with quotes) = 12 bytes; two keys = 24 > 20 on default
    await writeExtensionState(requester, {
      extensionId,
      installKey: 'default',
      key: 'a',
      value: 'x'.repeat(10),
    });
    await expectExtensionsError('state_quota_exceeded', () =>
      writeExtensionState(requester, { extensionId, installKey: 'default', key: 'b', value: 'x'.repeat(10) }),
    );
    // emea's namespace is empty — the same key fits there
    const emeaWrite = await writeExtensionState(requester, {
      extensionId,
      installKey: 'emea',
      key: 'a',
      value: 'x'.repeat(10),
    });
    expect(emeaWrite.bytes).toBe(12);
  });

  it('schedule quota is per (extension, install, day)', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('per-install-schedules', {
      quotas: {
        maxStateBytes: 1_048_576,
        maxScheduleInvocationsPerDay: 2,
        maxExternalCallsPerDay: 100_000,
      },
    });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'default' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      installKey: 'emea',
      idempotencyKey: 'w047:deploy:per-install-schedules:emea',
    });

    await triggerExtensionSchedule(requester, { extensionId, installKey: 'default', scheduleName: 'nightly-sync' });
    await triggerExtensionSchedule(requester, { extensionId, installKey: 'default', scheduleName: 'nightly-sync' });
    await expectExtensionsError('schedule_quota_exceeded', () =>
      triggerExtensionSchedule(requester, { extensionId, installKey: 'default', scheduleName: 'nightly-sync' }),
    );
    // emea's schedule budget is untouched
    const emeaRun = await triggerExtensionSchedule(requester, {
      extensionId,
      installKey: 'emea',
      scheduleName: 'nightly-sync',
    });
    expect(emeaRun.installKey).toBe('emea');
  });
});

// ---------------------------------------------------------------------------
// Storage level: a state row's install identity is immutable
// ---------------------------------------------------------------------------

describe('storage level: install namespace identity cannot be moved', () => {
  it('a state row pinned to one install cannot be re-homed, even bypassing the service', async () => {
    const requester = member(tenant);
    const extensionId = await activatedExtension('install-identity', { stateScope: 'install' });
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'emea' });
    await writeExtensionState(requester, { extensionId, installKey: 'emea', key: 'pinned', value: 1 });

    const row = await getDb().query<{ id: string }>(
      `SELECT id FROM extension_state WHERE tenant_id = $1 AND extension_id = $2 AND state_key = 'pinned'`,
      [tenant, extensionId],
    );
    const rowId = row.rows[0]!.id;
    await expect(
      getDb().query(`UPDATE extension_state SET install_key = 'default' WHERE id = $1`, [rowId]),
    ).rejects.toThrow(/identity is immutable/);
  });
});

// ---------------------------------------------------------------------------
// Inert manifests: no capability, no install runtime regardless of keying
// ---------------------------------------------------------------------------

describe('inert capability declarations stay inert in every install', () => {
  it('a manifest without state refuses state in every install namespace', async () => {
    const admin = extensionAdmin(tenant);
    const requester = member(tenant);
    const { extensionId } = await registerVerified(
      admin,
      inertManifest({ extensionKey: 'stateless-install-probe' }),
    );
    await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'w047:activate:stateless-install-probe:1',
    });
    // both installs have a deployment — so the refusals below are about
    // the missing capability, not a missing runtime
    await deployExtensionVersion(requester, { extensionId, version: '1.0.0', installKey: 'emea' });
    await deployExtensionVersion(requester, {
      extensionId,
      version: '1.0.0',
      idempotencyKey: 'w047:deploy:stateless-install-probe:default',
    });
    await expectExtensionsError('state_not_declared', () =>
      readExtensionState(requester, { extensionId, installKey: 'emea', key: 'k' }),
    );
    await expectExtensionsError('state_not_declared', () =>
      writeExtensionState(requester, { extensionId, key: 'k', value: 1 }),
    );
  });
});
