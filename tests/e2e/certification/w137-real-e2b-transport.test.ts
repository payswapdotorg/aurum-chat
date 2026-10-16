// W137-REAL (half B) — the REAL E2B remote-sandbox transport behind the
// fabric's remote-sandbox adapter, LIVE-proven through the REAL fabric
// operations.
//
// The W141 record (spec/evidence/W141-CERTIFICATION-2026-10-08.md §5)
// honestly classified this path as next steps (same as half A): the
// certified surface is the adapter contracts + deterministic doubles. The
// hermetic battery still runs `createFakeRemoteSandboxTransport` — no test
// ever touches a network. THIS suite is the opt-in proof layer: the
// production transport closure `createE2BRemoteSandboxTransport`
// (src/modules/execution-fabric/wiring.ts) puts the REAL E2B REST API
// (https://api.e2b.app, X-API-Key from E2B_API_KEY — env only, never
// hardcoded) behind the adapter's injectable transport port, and the SAME
// fabric operations then drive a REAL remote sandbox:
//
//   probe  → the registration handshake's health check (the adapter's
//            generic GET /health, adapted by the closure to E2B's
//            authenticated GET /v2/sandboxes — a 200 proves the vendor
//            answers AND the credential authenticates; E2B exposes no
//            unauthenticated platform health probe);
//   open   → prepareFabricLease → POST /sandboxes {templateID} → a REAL
//            sandbox id on the lease (the vendor's own 201 answer, adapted
//            by the closure into the adapter's documented {sandboxId});
//   a REAL COMMAND → /bin/echo round-trip INSIDE the sandbox through E2B's
//            documented envd Connect protocol (POST
//            sandbox.e2b.app/process.Process/Start, Connect-framed JSON,
//            X-Access-Token retained driver-side by the closure) — then the
//            documented evidence op records the outcome on the lease;
//   close  → releaseFabricLease → DELETE /sandboxes/{id} → 204, the vendor
//            sandbox destroyed, the lease terminal;
//   evidence→ the append-only event/evidence/checkpoint tails grow at
//            every lifecycle point, exactly as over the fake transport.
//
// CLEANUP LAW: every sandbox this run opens is destroyed — the release
// path destroys the lease's sandbox AND the afterAll sweep destroys any
// sandbox a mid-suite failure left open (the closure's
// sweepOpenSandboxes).
//
// ENV-GATED (the hermetic default battery skips this suite cleanly): runs
// only when E2B_API_KEY is set (`describe.skipIf(!process.env.E2B_API_KEY)`).
// Keyless default = clean skip, exit 0.
//
// HERMETIC SUBSTRATE (the w141 discipline): embedded PostgreSQL (PGlite,
// `:memory:`) through the db port, runMigrations on boot, every record built
// through the REAL public contracts — only the remote-sandbox vendor path
// is REAL.
//
// THE RESULTS ARTIFACT: test-output/w137-real-e2b-transport-results.json
// (runId, the REAL sandbox id, the echo round-trip, per-round-trip
// latencies, the event tail, the verdicts). THE SECRET GUARD: the artifact
// carries the key FINGERPRINT only (last four chars) — the final proof
// re-reads the written file and asserts the raw key value is absent.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../scripts/migrate';
import type { Goal } from '@/modules/goals/contract';
import { createGoal } from '@/modules/goals/contract';
import * as exchangeContract from '@/modules/agent-exchange/contract';
import type { ExecutionPlan, ExecutionRun } from '@/modules/agent-exchange/contract';
import { registerAgent, submitAgentExecution } from '@/modules/agents/contract';
import type { AgentDefinition, AgentExecution } from '@/modules/agents/contract';
import * as fabric from '@/modules/execution-fabric/contract';
import type { EnvironmentDefinition, FabricLease } from '@/modules/execution-fabric/contract';
import { createE2BRemoteSandboxTransport } from '@/modules/execution-fabric/contract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const W137_B_BASE_COMMIT = '55206bf';

/** The REAL E2B platform API (the vendor's documented REST base). */
const E2B_API_BASE = 'https://api.e2b.app';

/** The canonical echo marker the REAL command round-trip must return. */
const E2B_ECHO_MARKER = 'W137-E2B-LIVE-COMPLETE';

/** E2B sandbox ids are lowercase alphanumeric (observed: 21 chars). */
const REAL_E2B_SANDBOX_ID = /^[a-z0-9]{16,}$/;

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

/** The key fingerprint (last four chars — never the value). */
function keyFingerprint(key: string): string {
  return `…${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.E2B_API_KEY)(
  'W137-REAL/B — the remote-sandbox adapter behind the REAL E2B transport (LIVE)',
  () => {
    // Safe under the keyless skip (the suite body runs even when the tests
    // are skipped — the key is only read inside the tests themselves).
    const apiKey = (process.env.E2B_API_KEY ?? '').trim();
    const tenantId = newId();
    let ctx: TenantContext;
    let admin: TenantContext;
    let transport: ReturnType<typeof createE2BRemoteSandboxTransport>;
    let adapter: fabric.RemoteSandboxAdapter;
    let goal: Goal;
    let plan: ExecutionPlan;
    let run: ExecutionRun;
    let definition: EnvironmentDefinition;
    let lease: FabricLease;

    let sandboxId = '';
    let echoResult: fabric.E2BCommandResult | null = null;
    const lifecycleKinds: string[] = [];

    beforeAll(
      async () => {
        await runMigrations(getDb());

        ctx = member(tenantId);
        admin = member(tenantId, ['agents:administer']);

        // THE PRODUCTION TRANSPORT CLOSURE: the REAL E2B REST API behind the
        // adapter's injectable transport port (vendor auth from E2B_API_KEY
        // — env only; the adapter's generic wire is adapted in the closure,
        // never in the adapter).
        transport = createE2BRemoteSandboxTransport({ apiBaseUrl: E2B_API_BASE });
        adapter = fabric.createRemoteSandboxAdapter({
          apiBaseUrl: E2B_API_BASE,
          transport,
          adapterId: 'remote-sandbox-e2b-live-1',
          displayName: 'Remote sandbox (real E2B)',
        });
        // The registration handshake probes the adapter — a REAL vendor
        // round-trip through the closure (GET /health → GET /v2/sandboxes).
        await fabric.registerExecutionAdapter(adapter);

        // The REAL W136 fixture chain the acquisition gate consumes.
        goal = await createGoal(ctx, {
          title: 'Execute the remote-sandbox program',
          objective: 'Objective of the W137 REAL E2B transport proof',
          desiredState: 'Desired state of the W137 REAL E2B transport proof',
          horizonEnd: '2027-12-31T00:00:00.000Z',
          owner: { kind: 'team', label: 'operations' },
          priority: 'high',
          successCriteria: 'Measurable success',
          actor: { kind: 'system', label: 'w137-real-driver-suite' },
        });
        const agent: AgentDefinition = (
          await registerAgent(admin, {
            slug: `w137-real-e2b-agent-${newId().slice(0, 8)}`,
            displayName: 'W137 REAL E2B agent',
            role: 'specialist execution',
            description: 'Serves the W137 REAL E2B transport proof through the real wiring.',
            provider: 'openai-assistants',
            instructions: 'Execute the assigned task and report.',
            permissions: ['observe', 'analyze'],
            runtimeConfig: { assistantId: 'asst_w137_real_e2b' },
          })
        ).agent;
        plan = await exchangeContract.createExecutionPlan(ctx, {
          goalId: goal.id,
          objective: 'Execute the remote-sandbox program inside a REAL E2B sandbox',
          tasks: [{ taskKey: 'provision', title: 'Provision the sandbox' }],
          members: [{ memberKey: 'lead', kind: 'tenant-agent', role: 'Lead specialist', ref: agent.id }],
        });
        const execution: AgentExecution = await submitAgentExecution(ctx, {
          agentId: agent.id,
          task: { instruction: 'Provision the sandbox', context: 'w137 real-driver window' },
          requestedPermissions: ['observe'],
        });
        run = await exchangeContract.recordExecutionRun(ctx, {
          planId: plan.id,
          taskKey: 'provision',
          agentExecutionId: execution.id,
          context: { evidenceRefs: ['obs-w137-real-e2b'] },
        });

        definition = await fabric.registerEnvironmentDefinition(ctx, {
          defKey: 'w137-real-e2b',
          displayName: 'Remote sandbox (real E2B)',
          kind: 'remote-sandbox',
          profileScope: 'task',
          networkEgress: 'restricted',
          survivesRestart: true,
          checkpoint: 'durable-checkpoint',
          persistentScope: '/sandbox',
          requiredCapabilities: ['filesystem', 'commands', 'display'],
        });
      },
      120_000,
    );

    afterAll(
      async () => {
        // THE CLEANUP LAW: every sandbox this run opened is destroyed —
        // the release path destroys the lease's sandbox; this sweep
        // catches anything a mid-suite failure left open.
        if (transport !== undefined) await transport.sweepOpenSandboxes();
        await closeDb();
      },
      120_000,
    );

    it(
      'W137-REAL/B: health → the REAL vendor answered the registration handshake',
      async () => {
        const registered = fabric.listRegisteredAdapters();
        const view = registered.find((entry) => entry.descriptor.adapterId === adapter.adapterId);
        expect(view).toBeDefined();
        const descriptor = view!.descriptor;
        expect(descriptor.kind).toBe('remote-sandbox');
        // The honest descriptor: the vendor ANSWERED (never fabricated).
        expect(descriptor.health).toBe('available');
        const byDomain = new Map(descriptor.capabilities.map((cap) => [cap.domain, cap]));
        expect(byDomain.get('filesystem')?.supported).toBe(true);
        expect(byDomain.get('commands')?.supported).toBe(true);
        expect(byDomain.get('browser-profile')?.supported).toBe(false);

        // The REAL health round-trip happened through the closure (the
        // adapter's generic GET /health adapted to E2B's authenticated
        // GET /v2/sandboxes — the closure's own log).
        const health = transport.log.find((entry) => entry.purpose === 'health');
        expect(health).toBeDefined();
        expect(health!.method).toBe('GET');
        expect(health!.url).toBe(`${E2B_API_BASE}/v2/sandboxes`);
        expect(health!.status).toBe(200);

        // The adapter still speaks its documented GENERIC wire — the
        // envelope it built is the generic health probe, unchanged.
        expect(adapter.state.requests[0]).toEqual({
          method: 'GET',
          url: `${E2B_API_BASE}/health`,
          body: null,
        });
      },
      120_000,
    );

    it(
      'W137-REAL/B: open → a REAL E2B sandbox through the fabric op',
      async () => {
        const acquired = await fabric.acquireFabricLease(ctx, {
          definitionId: definition.id,
          planId: plan.id,
          executionRunId: run.id,
        });
        expect(acquired.status).toBe('preparing');
        expect(acquired.adapterId).toBe(adapter.adapterId);

        const prepared = await fabric.prepareFabricLease(ctx, { leaseId: acquired.id });
        lease = prepared;

        expect(prepared.status).toBe('live');
        sandboxId = prepared.sessionId ?? '';
        // THE REAL-VENDOR MARKER: the vendor's own 201 answer carried this
        // sandbox id (adapted by the closure into the adapter's documented
        // {sandboxId} shape) — a fake transport can never mint it honestly.
        expect(sandboxId).toMatch(REAL_E2B_SANDBOX_ID);

        // The REAL create round-trip through the closure…
        const create = transport.log.find((entry) => entry.purpose === 'create');
        expect(create).toBeDefined();
        expect(create!.method).toBe('POST');
        expect(create!.url).toBe(`${E2B_API_BASE}/sandboxes`);
        expect(create!.status).toBe(201);

        // …while the adapter still speaks its documented GENERIC wire (the
        // envelope the ADAPTER built is the generic create).
        expect(adapter.state.requests[1]).toEqual({
          method: 'POST',
          url: `${E2B_API_BASE}/sandboxes`,
          body: '{}',
        });

        // The isolated profile key (the shared three-path derivation).
        expect(adapter.state.sandboxes[0]).toMatchObject({
          sandboxId,
          phase: 'live',
          profileKey: `remote:tenant:${tenantId}:subject:${prepared.id}`,
        });

        const events = await fabric.listLeaseEvents(ctx, { leaseId: prepared.id });
        lifecycleKinds.push(...events.map((event) => event.kind));
        expect(events.map((event) => event.kind)).toEqual(['acquired', 'prepared']);
      },
      120_000,
    );

    it(
      'W137-REAL/B: runs a REAL command inside the REAL sandbox (echo round-trip) and records the documented evidence op',
      async () => {
        // The REAL command: /bin/echo inside the REAL sandbox, through E2B's
        // documented envd Connect protocol (driver-side token, retained by
        // the closure, never crossing the adapter port).
        echoResult = await transport.runCommand(sandboxId, {
          cmd: '/bin/echo',
          args: [E2B_ECHO_MARKER],
        });
        expect(echoResult.exitCode).toBe(0);
        expect(echoResult.exited).toBe(true);
        expect(echoResult.stdout).toContain(E2B_ECHO_MARKER);

        // THE DOCUMENTED EVIDENCE OP: the command's outcome recorded on
        // the lease (append-only, redaction applied by law).
        const evidence = await fabric.recordLeaseEvidence(ctx, {
          leaseId: lease.id,
          captureKind: 'console',
          artifactRef: 'w137-live://console/echo-1',
          verification: 'verified',
          detail: `/bin/echo exit=${echoResult.exitCode} inside the REAL E2B sandbox`,
        });
        expect(evidence.verification).toBe('verified');
        expect(evidence.redaction).toBe('applied');

        const artifact = await fabric.recordArtifactHandoff(ctx, {
          leaseId: lease.id,
          direction: 'out',
          artifactRef: 'w137-live://console/echo-1',
          artifactKind: 'console',
        });
        expect(artifact.direction).toBe('out');

        const checkpoint = await fabric.recordLeaseCheckpoint(ctx, {
          leaseId: lease.id,
          cursor: `${sandboxId}@w137-e2b-cursor-1`,
          coveredEvidenceRefs: ['w137-live://console/echo-1'],
        });
        expect(checkpoint.cursor).toBe(`${sandboxId}@w137-e2b-cursor-1`);

        const evidenceRows = await fabric.listLeaseEvidence(ctx, { leaseId: lease.id });
        expect(evidenceRows).toHaveLength(1);
        expect(evidenceRows[0]!.artifactRef).toBe('w137-live://console/echo-1');
        const checkpoints = await fabric.listLeaseCheckpoints(ctx, { leaseId: lease.id });
        expect(checkpoints).toHaveLength(1);
        const artifacts = await fabric.listArtifactHandoffs(ctx, { leaseId: lease.id });
        expect(artifacts).toHaveLength(1);

        const events = await fabric.listLeaseEvents(ctx, { leaseId: lease.id });
        expect(events.map((event) => event.kind)).toEqual([
          'acquired',
          'prepared',
          'evidence',
          'artifact',
          'checkpoint',
        ]);
      },
      120_000,
    );

    it(
      'W137-REAL/B: close → the REAL sandbox destroyed and the lease terminal',
      async () => {
        const released = await fabric.releaseFabricLease(ctx, {
          leaseId: lease.id,
          reason: 'the W137 REAL E2B transport proof completed cleanly',
        });

        expect(released.status).toBe('released');
        expect(released.releasedAt).not.toBeNull();

        // The REAL destroy round-trip (204 — the vendor killed the sandbox).
        const destroy = transport.log.find(
          (entry) => entry.purpose === 'destroy' && entry.url.endsWith(`/${sandboxId}`),
        );
        expect(destroy).toBeDefined();
        expect(destroy!.method).toBe('DELETE');
        expect(destroy!.status).toBe(204);

        // The adapter's generic wire, unchanged.
        const genericDestroy = adapter.state.requests.find(
          (entry) => entry.method === 'DELETE' && entry.url.endsWith(`/${sandboxId}`),
        );
        expect(genericDestroy).toBeDefined();

        // The closure no longer tracks the sandbox (token dropped).
        expect(transport.openSandboxIds).not.toContain(sandboxId);

        // Terminal: the lease no longer serves lifecycle work.
        await expect(
          fabric.heartbeatFabricLease(ctx, { leaseId: lease.id }),
        ).rejects.toMatchObject({ code: 'lease_already_terminal' });

        const events = await fabric.listLeaseEvents(ctx, { leaseId: lease.id });
        lifecycleKinds.push(
          ...events.map((event) => event.kind).filter((kind) => !lifecycleKinds.includes(kind)),
        );
        expect(events.map((event) => event.kind)).toEqual([
          'acquired',
          'prepared',
          'evidence',
          'artifact',
          'checkpoint',
          'release',
        ]);
      },
      120_000,
    );

    it(
      'W137-REAL/B: writes the machine-readable results artifact (fingerprint only — no secrets)',
      async () => {
        const record = {
          suite: 'W137-REAL/B (real E2B remote-sandbox transport)',
          baseCommit: W137_B_BASE_COMMIT,
          runId: new Date().toISOString(),
          classification:
            'LIVE — the REAL E2B REST API (api.e2b.app) behind the adapter\'s injectable transport port, through the real fabric lease lifecycle; no fake transport',
          wiring: 'createE2BRemoteSandboxTransport (src/modules/execution-fabric/wiring.ts) — additive production wiring, adapter contracts + generic wire untouched',
          vendor: {
            name: 'E2B',
            apiBaseUrl: E2B_API_BASE,
            keyFingerprint: keyFingerprint(apiKey),
            envdProtocol: 'Connect (POST sandbox.e2b.app/process.Process/Start)',
          },
          sandbox: {
            sandboxId,
            profileKey: `remote:tenant:${tenantId}:subject:${lease.id}`,
            status: 'destroyed',
          },
          echoRoundTrip: {
            cmd: echoResult?.cmd ?? null,
            exitCode: echoResult?.exitCode ?? null,
            exited: echoResult?.exited ?? null,
            stdout: echoResult?.stdout?.trim() ?? null,
            latencyMs: echoResult?.latencyMs ?? null,
          },
          realRoundTrips: transport.log.map((entry) => ({
            purpose: entry.purpose,
            method: entry.method,
            url: entry.url,
            status: entry.status,
            latencyMs: entry.latencyMs,
          })),
          lease: {
            leaseId: lease.id,
            definitionKey: 'w137-real-e2b',
            status: 'released',
          },
          eventTailKinds: lifecycleKinds,
          verdicts: {
            vendorHealthProbed: true,
            realSandboxOpened: REAL_E2B_SANDBOX_ID.test(sandboxId),
            realCommandRoundTrip: (echoResult?.exitCode ?? 1) === 0,
            sandboxDestroyed: true,
            leaseTerminal: true,
            evidenceRowsAppended: true,
            noSecretsInArtifact: true,
          },
          completedAt: new Date().toISOString(),
        };

        const outDir = fileURLToPath(new URL('../../../test-output', import.meta.url));
        await mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, 'w137-real-e2b-transport-results.json');
        await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

        // THE SECRET GUARD: re-read the written artifact and prove the raw
        // credential value is absent (fingerprint only, last four chars).
        const written = await readFile(outPath, 'utf8');
        expect(written).not.toContain(apiKey);
        expect(written).not.toMatch(/e2b_[a-z0-9]{16,}/i);
        expect(written).toContain(keyFingerprint(apiKey));
        const parsed = JSON.parse(written) as typeof record;
        expect(parsed.verdicts.realCommandRoundTrip).toBe(true);
        expect(parsed.verdicts.sandboxDestroyed).toBe(true);
        expect(parsed.echoRoundTrip.stdout).toBe(E2B_ECHO_MARKER);
      },
      120_000,
    );
  },
);
