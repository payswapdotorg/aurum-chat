// W047 — Capability Security Verification: SANDBOX boundaries.
//
// Proves the runtime sandboxes actually contain the capabilities they
// expose:
//
//   * EGRESS — external participation is confined to the EXACT declared
//     https origins (never prefix or lookalike matching), the egress port
//     is the runtime's only network touchpoint, request headers are
//     passed to the port but NEVER recorded in call evidence (secrets do
//     not become data), and a non-https origin cannot even be declared;
//   * BOUNDS — state values, event payloads and telemetry payloads are
//     byte-bounded; state namespaces are quota-bounded; schedules fire
//     only by declared name and daily quota;
//   * TRANSPORT — agent dispatches go only through the provider-neutral
//     transport port (unwired = an explicit provider_unavailable, never a
//     fake success), the transport request is provider-neutral by shape,
//     and the submission fields the pump relies on are frozen;
//   * EVIDENCE — attempts, deployments, external calls, state and
//     manifests are append-only/immutable at the STORAGE level (triggers
//     reject mutation even for writes bypassing the services), and a
//     deployment cannot reference another tenant's manifest even by a
//     direct SQL insert (composite tenant foreign keys).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import {
  ANALYST_AGENT,
  FakeAgentTransport,
  agentsAdmin,
  allowExtensionDeployment,
  deployExtensionVersion,
  dispatchExtensionEvent,
  emitExtensionTelemetry,
  executeExtensionExternalCall,
  expectAgentsError,
  expectExtensionsError,
  extensionAdmin,
  fullManifest,
  inertManifest,
  listAgentExecutionAttempts,
  listExtensionExternalCalls,
  member,
  newId,
  portCalls,
  readExtensionState,
  registerAgent,
  registerExtensionManifest,
  registerVerified,
  runAgentExecution,
  runMigrations,
  setAgentTransport,
  submitAgentExecution,
  transitionExtension,
  triggerExtensionSchedule,
  wireFakeEgressPort,
  writeExtensionState,
} from './harness';
import {
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_STATE_VALUE_BYTES,
  MAX_TELEMETRY_PAYLOAD_BYTES,
} from '@/modules/extensions/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';

const tenantEgress = newId();
const tenantBounds = newId();
const tenantTransport = newId();
const tenantEvidence = newId();

const transport = new FakeAgentTransport();

beforeAll(async () => {
  await runMigrations(getDb());
  for (const tenantId of [tenantEgress, tenantBounds, tenantTransport, tenantEvidence]) {
    await allowExtensionDeployment(tenantId);
  }
  setAgentTransport(transport);
  wireFakeEgressPort();
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

/** Register + verify + activate + deploy one full-capability extension. */
async function liveExtension(
  tenantId: string,
  extensionKey: string,
  overrides: Parameters<typeof fullManifest>[0] = {},
): Promise<string> {
  const admin = extensionAdmin(tenantId);
  const requester = member(tenantId);
  const { extensionId } = await registerVerified(admin, fullManifest({ extensionKey, ...overrides }));
  const activated = await transitionExtension(requester, {
    extensionId,
    transition: 'activate',
    idempotencyKey: `w047:activate:${extensionKey}:1`,
  });
  expect(activated.applied).toBe(true);
  const deployed = await deployExtensionVersion(requester, { extensionId, version: '1.0.0' });
  expect(deployed.applied).toBe(true);
  return extensionId;
}

// ---------------------------------------------------------------------------
// The egress sandbox
// ---------------------------------------------------------------------------

describe('external participation is confined to the exact declared origins', () => {
  it('calls reach only the declared origin — through the port, exactly as scoped', async () => {
    const requester = member(tenantEgress);
    const extensionId = await liveExtension(tenantEgress, 'egress-probe');
    const base = { extensionId, origin: 'https://api.invoices.example.com', method: 'GET' as const };

    const ok = await executeExtensionExternalCall(requester, { ...base, path: '/v1/invoices' });
    expect(ok.outcome).toBe('succeeded');
    // the port saw EXACTLY declared-origin + path — nothing else on the wire
    expect(portCalls.at(-1)?.url).toBe('https://api.invoices.example.com/v1/invoices');
    expect(portCalls.at(-1)?.method).toBe('GET');

    // lookalike and sibling hosts are not the declared origin — ever
    await expectExtensionsError('origin_not_declared', () =>
      executeExtensionExternalCall(requester, {
        ...base,
        origin: 'https://api.invoices.example.com.evil.io',
        path: '/',
      }),
    );
    await expectExtensionsError('origin_not_declared', () =>
      executeExtensionExternalCall(requester, {
        ...base,
        origin: 'https://evil.example.com',
        path: '/',
      }),
    );
    await expectExtensionsError('origin_not_declared', () =>
      executeExtensionExternalCall(requester, {
        ...base,
        origin: 'https://invoices.example.com',
        path: '/',
      }),
    );
    // the failed probes never reached the wire
    const wireForProbe = portCalls.filter((call) => call.url.startsWith('https://api.invoices.example.com/'));
    expect(wireForProbe).toHaveLength(1);
  });

  it('a non-https origin cannot even be declared as a participant', async () => {
    const admin = extensionAdmin(tenantEgress);
    await expectExtensionsError('invalid_input', () =>
      registerExtensionManifest(
        admin,
        fullManifest({
          extensionKey: 'http-participant',
          externalParticipants: [{ label: 'Plain HTTP', origin: 'http://api.invoices.example.com' }],
        }),
      ),
    );
  });

  it('the request path is confined to the declared-origin path grammar', async () => {
    const requester = member(tenantEgress);
    const extensionId = await liveExtension(tenantEgress, 'egress-path-probe');
    await expectExtensionsError('invalid_input', () =>
      executeExtensionExternalCall(requester, {
        extensionId,
        origin: 'https://api.invoices.example.com',
        method: 'GET',
        path: 'no-leading-slash',
      }),
    );
  });

  it('secrets passed to the port never become recorded evidence', async () => {
    const requester = member(tenantEgress);
    const extensionId = await liveExtension(tenantEgress, 'secret-probe');
    const call = await executeExtensionExternalCall(requester, {
      extensionId,
      origin: 'https://api.invoices.example.com',
      method: 'POST',
      path: '/v1/invoices',
      body: { number: 'INV-1' },
      headers: { Authorization: 'Bearer w047-secret-token' },
    });
    expect(call.outcome).toBe('succeeded');
    // the port DID receive the header (the runtime forwards it)…
    expect(portCalls.at(-1)?.headers['Authorization']).toBe('Bearer w047-secret-token');
    // …but the recorded evidence never contains it
    const calls = await listExtensionExternalCalls(requester, { extensionId });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain('w047-secret-token');
  });
});

// ---------------------------------------------------------------------------
// Bounds and quotas of the runtime sandbox
// ---------------------------------------------------------------------------

describe('the runtime sandbox bounds every capability surface', () => {
  it('state values are byte-bounded and namespaces quota-bounded', async () => {
    const requester = member(tenantBounds);
    const extensionId = await liveExtension(tenantBounds, 'state-bounds', {
      quotas: { maxStateBytes: 1_048_576, maxScheduleInvocationsPerDay: 1_440, maxExternalCallsPerDay: 100_000 },
    });
    // a single value beyond the per-value bound
    await expectExtensionsError('invalid_input', () =>
      writeExtensionState(requester, {
        extensionId,
        key: 'huge',
        value: 'x'.repeat(MAX_STATE_VALUE_BYTES + 1),
      }),
    );
    // the namespace quota (a tiny budget) is enforced too
    const tiny = await liveExtension(tenantBounds, 'tiny-state', {
      quotas: { maxStateBytes: 20, maxScheduleInvocationsPerDay: 1_440, maxExternalCallsPerDay: 100_000 },
    });
    await writeExtensionState(requester, { extensionId: tiny, key: 'a', value: 'x'.repeat(10) });
    await expectExtensionsError('state_quota_exceeded', () =>
      writeExtensionState(requester, { extensionId: tiny, key: 'b', value: 'x'.repeat(10) }),
    );
    expect((await readExtensionState(requester, { extensionId: tiny, key: 'a' }))?.bytes).toBe(12);
  });

  it('event payloads are byte-bounded', async () => {
    const requester = member(tenantBounds);
    // a topic ONLY this extension subscribes to, so the delivered count is exact
    const eventBoundsId = await liveExtension(tenantBounds, 'event-bounds', {
      eventSubscriptions: ['w047.custom.topic'],
    });
    await expectExtensionsError('invalid_input', () =>
      dispatchExtensionEvent(requester, {
        topic: 'w047.custom.topic',
        payload: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1),
      }),
    );
    // the bounded dispatch still works — and lands in this extension's install
    const dispatch = await dispatchExtensionEvent(requester, {
      topic: 'w047.custom.topic',
      payload: { n: 1 },
    });
    expect(dispatch.delivered).toBe(1);
    expect(dispatch.deliveries.map((delivery) => delivery.extensionId)).toEqual([eventBoundsId]);
  });

  it('telemetry is capability-gated and byte-bounded', async () => {
    const requester = member(tenantBounds);
    // an inert manifest never declared telemetry
    const admin = extensionAdmin(tenantBounds);
    const { extensionId: inertId } = await registerVerified(
      admin,
      inertManifest({
        extensionKey: 'silent-sandbox-probe',
        stateScope: 'tenant',
        requestedPermissions: ['state:read', 'state:write'],
        quotas: { maxStateBytes: 1024, maxScheduleInvocationsPerDay: 0, maxExternalCallsPerDay: 0 },
      }),
    );
    await transitionExtension(requester, {
      extensionId: inertId,
      transition: 'activate',
      idempotencyKey: 'w047:activate:silent-sandbox-probe:1',
    });
    await deployExtensionVersion(requester, { extensionId: inertId, version: '1.0.0' });
    await expectExtensionsError('telemetry_not_declared', () =>
      emitExtensionTelemetry(requester, { extensionId: inertId, name: 'run.completed' }),
    );

    // a declared telemetry capability is payload-bounded
    const chattyId = await liveExtension(tenantBounds, 'telemetry-bounds');
    await expectExtensionsError('invalid_input', () =>
      emitExtensionTelemetry(requester, {
        extensionId: chattyId,
        name: 'run.completed',
        payload: 'x'.repeat(MAX_TELEMETRY_PAYLOAD_BYTES + 1),
      }),
    );
    const event = await emitExtensionTelemetry(requester, {
      extensionId: chattyId,
      name: 'run.completed',
      payload: { ok: true },
    });
    expect(event.payload).toEqual({ ok: true });
  });

  it('schedules fire only by declared name and within the daily quota', async () => {
    const requester = member(tenantBounds);
    const extensionId = await liveExtension(tenantBounds, 'schedule-bounds', {
      quotas: {
        maxStateBytes: 1_048_576,
        maxScheduleInvocationsPerDay: 1,
        maxExternalCallsPerDay: 100_000,
      },
    });
    await expectExtensionsError('schedule_not_declared', () =>
      triggerExtensionSchedule(requester, { extensionId, scheduleName: 'undeclared-sync' }),
    );
    const run = await triggerExtensionSchedule(requester, {
      extensionId,
      scheduleName: 'nightly-sync',
    });
    expect(run.scheduleName).toBe('nightly-sync');
    // the declared daily quota is one invocation
    await expectExtensionsError('schedule_quota_exceeded', () =>
      triggerExtensionSchedule(requester, { extensionId, scheduleName: 'nightly-sync' }),
    );
  });
});

// ---------------------------------------------------------------------------
// The agent dispatch sandbox
// ---------------------------------------------------------------------------

describe('agent dispatches go only through the provider-neutral transport port', () => {
  it('an unwired transport is an explicit failure — never a fake success', async () => {
    const admin = agentsAdmin(tenantTransport);
    const agent = (await registerAgent(admin, ANALYST_AGENT)).agent;
    const execution = await submitAgentExecution(member(tenantTransport), {
      agentId: agent.id,
      task: { probe: 'unwired' },
      requestedPermissions: ['observe', 'analyze'],
    });
    expect(execution.status).toBe('queued');

    setAgentTransport(null);
    await expectAgentsError('provider_unavailable', () =>
      runAgentExecution(member(tenantTransport), { executionId: execution.id }),
    );
    // the execution stays queued — loud failure, no silent dispatch
    expect(
      (await listAgentExecutionAttempts(member(tenantTransport), { executionId: execution.id })).length,
    ).toBe(0);
    setAgentTransport(transport);
  });

  it('the transport request is provider-neutral by shape, and evidence is append-only', async () => {
    const admin = agentsAdmin(tenantTransport);
    const agent = (await registerAgent(admin, ANALYST_AGENT)).agent;
    const execution = await submitAgentExecution(member(tenantTransport), {
      agentId: agent.id,
      task: { probe: 'wire-shape' },
      requestedPermissions: ['observe', 'analyze'],
    });
    const run = await runAgentExecution(member(tenantTransport), { executionId: execution.id });
    expect(run.status).toBe('succeeded');

    // what the transport saw: the canonical provider key, the agent id,
    // an opaque runtime agent reference and an opaque JSON body — no
    // provider-native object shape crosses the module boundary raw
    const request = transport.requestsFor([agent.id]).at(-1)!;
    expect(request.provider).toBe('openai-assistants');
    expect(request.agentId).toBe(agent.id);
    expect(typeof request.runtimeAgentRef).toBe('string');
    expect(request.runtimeAgentRef.length).toBeGreaterThan(0);
    expect(request.body).toEqual(expect.anything());

    // the attempt evidence exists and is append-only at the storage level
    const attempts = await listAgentExecutionAttempts(member(tenantTransport), {
      executionId: execution.id,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.providerTaskId).toBeTypeOf('string');
    await expect(
      getDb().query(`UPDATE agent_execution_attempts SET error_code = 'x' WHERE tenant_id = $1`, [
        tenantTransport,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM agent_execution_attempts WHERE tenant_id = $1`, [tenantTransport]),
    ).rejects.toThrow(/append-only/);

    // the submission fields the pump relies on are frozen
    await expect(
      getDb().query(`UPDATE agent_executions SET task = '{"hacked": true}' WHERE id = $1`, [
        execution.id,
      ]),
    ).rejects.toThrow(/only the live state/);
    await expect(
      getDb().query(`UPDATE agent_executions SET max_attempts = 5 WHERE id = $1`, [execution.id]),
    ).rejects.toThrow(/only the live state/);
  });
});

// ---------------------------------------------------------------------------
// Storage-level evidence guarantees of the extension surfaces
// ---------------------------------------------------------------------------

describe('extension evidence is append-only and tenant-consistent at the storage level', () => {
  it('deployments, external calls, state and manifests resist mutation even bypassing the service', async () => {
    const requester = member(tenantEvidence);
    const extensionId = await liveExtension(tenantEvidence, 'evidence-probe');
    await writeExtensionState(requester, { extensionId, key: 'probe', value: { n: 1 } });
    const call = await executeExtensionExternalCall(requester, {
      extensionId,
      origin: 'https://api.invoices.example.com',
      method: 'GET',
      path: '/',
    });
    const manifestId = (
      await getDb().query<{ id: string }>(
        `SELECT id FROM extension_manifests WHERE tenant_id = $1 AND extension_id = $2 LIMIT 1`,
        [tenantEvidence, extensionId],
      )
    ).rows[0]!.id;
    const stateRowId = (
      await getDb().query<{ id: string }>(
        `SELECT id FROM extension_state WHERE tenant_id = $1 AND extension_id = $2 AND state_key = 'probe'`,
        [tenantEvidence, extensionId],
      )
    ).rows[0]!.id;
    const deploymentId = (
      await getDb().query<{ id: string }>(
        `SELECT id FROM extension_deployments WHERE tenant_id = $1 AND extension_id = $2 LIMIT 1`,
        [tenantEvidence, extensionId],
      )
    ).rows[0]!.id;

    const db = getDb();
    await expect(
      db.query(`UPDATE extension_deployments SET version = '9.9.9' WHERE id = $1`, [deploymentId]),
    ).rejects.toThrow(/append-only history/);
    await expect(
      db.query(`DELETE FROM extension_external_calls WHERE id = $1`, [call.id]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      db.query(`DELETE FROM extension_state WHERE id = $1`, [stateRowId]),
    ).rejects.toThrow(/persistent/);
    await expect(
      db.query(`UPDATE extension_manifests SET display_name = 'Rewritten' WHERE id = $1`, [manifestId]),
    ).rejects.toThrow(/immutable versioned history/);
  });

  it('a deployment cannot reference another tenant’s manifest, even by direct SQL', async () => {
    // a manifest that exists — in the EGRESS tenant
    const foreignManifestId = (
      await getDb().query<{ id: string }>(
        `SELECT id FROM extension_manifests WHERE tenant_id = $1 LIMIT 1`,
        [tenantEgress],
      )
    ).rows[0]!.id;
    // an extension that exists — in the EVIDENCE tenant
    const ownExtension = (
      await getDb().query<{ id: string; extension_key: string }>(
        `SELECT id, extension_key FROM extensions WHERE tenant_id = $1 LIMIT 1`,
        [tenantEvidence],
      )
    ).rows[0]!;
    await expect(
      getDb().query(
        `INSERT INTO extension_deployments (
           tenant_id, extension_id, extension_key, install_key, manifest_id, version,
           operation, replaces_deployment_id, granted_permissions, deployed_by, deployed_at, action_request_id
         ) VALUES ($1, $2, $3, 'cross-tenant', $4, '1.0.0', 'deploy', NULL,
           '[]'::jsonb, 'probe', now(), NULL)`,
        [tenantEvidence, ownExtension.id, ownExtension.extension_key, foreignManifestId],
      ),
    ).rejects.toThrow();
  });
});
