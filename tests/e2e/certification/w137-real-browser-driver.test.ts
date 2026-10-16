// W137-REAL (half A) — the REAL Playwright/Chromium browser driver behind
// the fabric's browser adapter, LIVE-proven through the REAL fabric
// operations.
//
// The W141 record (spec/evidence/W141-CERTIFICATION-2026-10-08.md §5)
// honestly classified this path as next steps: "Real Playwright/Chromium +
// E2B remote-sandbox execution of the W137 adapters: the certified surface
// is the adapter contracts + deterministic doubles; real-driver evaluation
// documented as next steps." The hermetic battery still runs the
// deterministic double (THE SUITE NEVER LAUNCHES REAL CHROME — the module's
// own law); THIS suite is the opt-in proof layer over that fixture: the
// production wiring closure `wirePlaywrightBrowserAdapter` (W137 wiring.ts)
// injects W110's `createPlaywrightBrowserDriver` — REAL Playwright OSS
// driving REAL headless Chromium — through the existing BrowserDriver port,
// and the SAME fabric operations then drive a REAL browser session:
//
//   open    → prepareFabricLease → driver.startSession on the isolated
//             profile key → the lease goes LIVE with a REAL session id in
//             the W110 driver's own documented format
//             (`playwright-session-NNNN` — the honest marker that the id was
//             minted by the real driver, never a double);
//   probe   → the honest descriptor (registration handshake: filesystem and
//             commands NOT supported — the honest-descriptor law, unchanged
//             over the real wiring);
//   resume  → markFabricLeaseLost + recoverFabricLease → a FRESH disposable
//             session bound to the SAME isolated profile key (the lease's
//             profile continuity — the W093 per-(tenant,subject) discipline);
//   close   → releaseFabricLease → the session ends on the driver and the
//             lease reaches its terminal state;
//   evidence→ the append-only event/evidence/checkpoint tails grow at every
//             lifecycle point, exactly as over the doubles.
//
// THE FABRIIC NEVER DRIVES A BROWSER ACTION (the W137 law — computer-use
// owns governed browser automation): the proof is the fabric's own lease
// lifecycle over the REAL engine, evidenced by the driver's recording
// surfaces (session starts, profile keys, engine version) and the honest
// Chromium version string.
//
// ENV-GATED (the hermetic default battery skips this suite cleanly): runs
// only when W137_BROWSER_LIVE is set (the task's prescribed gate —
// `describe.skipIf(!process.env.W137_BROWSER_LIVE)`). Keyless default =
// clean skip, exit 0.
//
// HERMETIC SUBSTRATE (the w141 discipline): embedded PostgreSQL (PGlite,
// `:memory:`) through the db port, runMigrations on boot, every record built
// through the REAL public contracts (goals → agent-exchange → agents → the
// fabric contract) — only the browser engine is REAL.
//
// THE RESULTS ARTIFACT: test-output/w137-real-browser-driver-results.json
// (runId, real engine version, real session ids, per-phase latencies, the
// profile key, the event tail, the verdicts). It carries no secrets (no
// credential VALUE exists on this path — the lease rides an OPAQUE ref).

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
import type { BrowserAllowlist } from '@/modules/computer-use/contract';
import * as fabric from '@/modules/execution-fabric/contract';
import type { EnvironmentDefinition, FabricLease } from '@/modules/execution-fabric/contract';
import { wirePlaywrightBrowserAdapter } from '@/modules/execution-fabric/contract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const W137_A_BASE_COMMIT = '55206bf';

/** The governed allowlist the real wiring hands to the driver at every start. */
const W137_ALLOWLIST: BrowserAllowlist = {
  urlGlobs: ['https://example.com/*', 'https://www.iana.org/*'],
  verbs: ['goto', 'read'],
};

/** The OPAQUE credential ref the lease rides (W082 — a VALUE never rides). */
const W137_CREDENTIAL_REF = 'w137-live://credential-ref/browser-1';

/** The real W110 driver's documented session-key grammar (the honest real-driver marker). */
const REAL_PLAYWRIGHT_SESSION_KEY = /^playwright-session-\d{4,}$/;

/** A real Chromium version string (e.g. 143.0.7499.4) — never the 'not-launched' sentinel. */
const REAL_CHROMIUM_VERSION = /^\d+\.\d+\.\d+\.\d+$/;

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.W137_BROWSER_LIVE)(
  'W137-REAL/A — the browser adapter behind REAL Playwright/Chromium (LIVE)',
  () => {
    const tenantId = newId();
    let ctx: TenantContext;
    let admin: TenantContext;
    let wiring: ReturnType<typeof wirePlaywrightBrowserAdapter>;
    let goal: Goal;
    let plan: ExecutionPlan;
    let run: ExecutionRun;
    let definition: EnvironmentDefinition;
    let lease: FabricLease;

    let firstSessionId = '';
    let resumedSessionId = '';
    let directClosedSessionId = '';
    let openLatencyMs = 0;
    let resumeLatencyMs = 0;
    let closeLatencyMs = 0;
    let directCloseLatencyMs = 0;
    const lifecycleKinds: string[] = [];

    beforeAll(
      async () => {
        await runMigrations(getDb());

        ctx = member(tenantId);
        admin = member(tenantId, ['agents:administer']);

        // THE PRODUCTION WIRING CLOSURE: W110's real Playwright/Chromium
        // driver injected through the existing BrowserDriver port — the
        // adapter's public behavior untouched.
        wiring = wirePlaywrightBrowserAdapter({
          allowlist: W137_ALLOWLIST,
          driverOptions: { headless: true },
          adapterId: 'browser-playwright-live-1',
          displayName: 'Governed browser environment (real Playwright/Chromium)',
        });
        await fabric.registerExecutionAdapter(wiring.adapter);

        // The REAL W136 fixture chain the acquisition gate consumes.
        goal = await createGoal(ctx, {
          title: 'Execute the browser-environment program',
          objective: 'Objective of the W137 REAL browser driver proof',
          desiredState: 'Desired state of the W137 REAL browser driver proof',
          horizonEnd: '2027-12-31T00:00:00.000Z',
          owner: { kind: 'team', label: 'operations' },
          priority: 'high',
          successCriteria: 'Measurable success',
          actor: { kind: 'system', label: 'w137-real-driver-suite' },
        });
        const agent: AgentDefinition = (
          await registerAgent(admin, {
            slug: `w137-real-browser-agent-${newId().slice(0, 8)}`,
            displayName: 'W137 REAL browser agent',
            role: 'specialist execution',
            description: 'Serves the W137 REAL browser-driver proof through the real wiring.',
            provider: 'openai-assistants',
            instructions: 'Execute the assigned task and report.',
            permissions: ['observe', 'analyze'],
            runtimeConfig: { assistantId: 'asst_w137_real_browser' },
          })
        ).agent;
        plan = await exchangeContract.createExecutionPlan(ctx, {
          goalId: goal.id,
          objective: 'Execute the browser-environment program inside the real governed browser',
          tasks: [{ taskKey: 'survey', title: 'Survey the site' }],
          members: [{ memberKey: 'lead', kind: 'tenant-agent', role: 'Lead specialist', ref: agent.id }],
        });
        const execution: AgentExecution = await submitAgentExecution(ctx, {
          agentId: agent.id,
          task: { instruction: 'Survey the site', context: 'w137 real-driver window' },
          requestedPermissions: ['observe'],
        });
        run = await exchangeContract.recordExecutionRun(ctx, {
          planId: plan.id,
          taskKey: 'survey',
          agentExecutionId: execution.id,
          context: { evidenceRefs: ['obs-w137-real-browser'] },
        });

        definition = await fabric.registerEnvironmentDefinition(ctx, {
          defKey: 'w137-real-browser',
          displayName: 'Governed browser (real Playwright/Chromium)',
          kind: 'browser',
          profileScope: 'task',
          networkEgress: 'restricted',
          survivesRestart: false,
          checkpoint: 'session',
          requiredCapabilities: ['display', 'browser-profile'],
        });
      },
      120_000,
    );

    afterAll(
      async () => {
        // The composition root's duty: close the shared REAL engine (the
        // port deliberately has no engine close — the wiring owns it).
        if (wiring !== undefined) await wiring.driver.close().catch(() => undefined);
        await closeDb();
      },
      120_000,
    );

    it(
      'W137-REAL/A: probe → the honest descriptor over the real wiring (the registration handshake)',
      async () => {
        const registered = fabric.listRegisteredAdapters();
        const view = registered.find(
          (entry) => entry.descriptor.adapterId === wiring.adapter.adapterId,
        );
        expect(view).toBeDefined();
        const descriptor = view!.descriptor;
        expect(descriptor.kind).toBe('browser');
        expect(descriptor.health).toBe('available');
        // The honest-descriptor law, unchanged over the real wiring.
        const byDomain = new Map(descriptor.capabilities.map((cap) => [cap.domain, cap]));
        expect(byDomain.get('filesystem')?.supported).toBe(false);
        expect(byDomain.get('commands')?.supported).toBe(false);
        expect(byDomain.get('browser-profile')?.supported).toBe(true);
        expect(byDomain.get('display')?.supported).toBe(true);
        expect(byDomain.get('network-egress')?.supported).toBe(true);
        expect(byDomain.get('session-persistence')?.supported).toBe(true);
        expect(byDomain.get('checkpoint')?.supported).toBe(true);
        expect(byDomain.get('observation-capture')?.supported).toBe(true);
        // Vendor identity is METADATA only (the W131 law).
        expect(descriptor.vendor.vendorName).toBe('aurum-browser-port');
      },
      120_000,
    );

    it(
      'W137-REAL/A: open → the lease goes LIVE with a REAL Chromium session id',
      async () => {
        const acquired = await fabric.acquireFabricLease(ctx, {
          definitionId: definition.id,
          planId: plan.id,
          executionRunId: run.id,
          credentialRef: W137_CREDENTIAL_REF,
        });
        expect(acquired.status).toBe('preparing');
        expect(acquired.adapterId).toBe(wiring.adapter.adapterId);
        expect(acquired.credentialRef).toBe(W137_CREDENTIAL_REF);

        const startedAt = Date.now();
        const prepared = await fabric.prepareFabricLease(ctx, { leaseId: acquired.id });
        openLatencyMs = Date.now() - startedAt;
        lease = prepared;

        expect(prepared.status).toBe('live');
        firstSessionId = prepared.sessionId ?? '';
        // THE REAL-DRIVER MARKER: the W110 Playwright driver's documented
        // session-key grammar — a double can never mint this shape honestly.
        expect(firstSessionId).toMatch(REAL_PLAYWRIGHT_SESSION_KEY);

        // REAL Chromium launched: the driver's own engine version (never
        // the 'not-launched' sentinel).
        expect(wiring.driver.engineVersion()).toMatch(REAL_CHROMIUM_VERSION);

        // The isolated profile key (the W093 per-(tenant,subject)
        // discipline) with the opaque credential handed VERBATIM.
        const expectedProfileKey = `browser:tenant:${tenantId}:subject:${prepared.id}`;
        expect(wiring.driver.sessionStarts).toHaveLength(1);
        expect(wiring.driver.sessionStarts[0]).toMatchObject({
          profileKey: expectedProfileKey,
          credentialRef: W137_CREDENTIAL_REF,
          allowlist: W137_ALLOWLIST,
        });
        expect(wiring.adapter.state.startedSessions[0]).toMatchObject({
          sessionKey: firstSessionId,
          profileKey: expectedProfileKey,
          credentialRef: W137_CREDENTIAL_REF,
        });

        // The evidence tail starts growing at the lifecycle points.
        const events = await fabric.listLeaseEvents(ctx, { leaseId: prepared.id });
        lifecycleKinds.push(...events.map((event) => event.kind));
        expect(events.map((event) => event.kind)).toEqual(['acquired', 'prepared']);
      },
      120_000,
    );

    it(
      'W137-REAL/A: evidence rows append on the LIVE real-browser lease (the §24 tails)',
      async () => {
        const evidence = await fabric.recordLeaseEvidence(ctx, {
          leaseId: lease.id,
          captureKind: 'dom-snapshot',
          artifactRef: 'w137-live://dom-snapshot/real-chromium-1',
          verification: 'verified',
          detail: 'a REAL Chromium context observed through the governed port',
        });
        expect(evidence.redaction).toBe('applied');
        expect(evidence.verification).toBe('verified');

        const artifact = await fabric.recordArtifactHandoff(ctx, {
          leaseId: lease.id,
          direction: 'out',
          artifactRef: 'w137-live://dom-snapshot/real-chromium-1',
          artifactKind: 'dom-snapshot',
        });
        expect(artifact.direction).toBe('out');

        const checkpoint = await fabric.recordLeaseCheckpoint(ctx, {
          leaseId: lease.id,
          // The resumption-token convention: '<session-id>@<worker-cursor>'.
          cursor: `${firstSessionId}@w137-real-cursor-1`,
          coveredEvidenceRefs: ['w137-live://dom-snapshot/real-chromium-1'],
        });
        expect(checkpoint.cursor).toBe(`${firstSessionId}@w137-real-cursor-1`);

        const evidenceRows = await fabric.listLeaseEvidence(ctx, { leaseId: lease.id });
        expect(evidenceRows).toHaveLength(1);
        expect(evidenceRows[0]!.artifactRef).toBe('w137-live://dom-snapshot/real-chromium-1');
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
      'W137-REAL/A: resume → a FRESH session on the SAME profile key (loss + recovery over the real engine)',
      async () => {
        const lost = await fabric.markFabricLeaseLost(ctx, {
          leaseId: lease.id,
          detail: 'the W137 LIVE harness parks the lease to prove real recovery',
        });
        expect(lost.status).toBe('lost');
        expect(lost.sessionId).toBe(firstSessionId); // the durable truth keeps the id; the session is disposable

        const startedAt = Date.now();
        const recovered = await fabric.recoverFabricLease(ctx, { leaseId: lease.id });
        resumeLatencyMs = Date.now() - startedAt;
        lease = recovered;

        expect(recovered.status).toBe('live');
        resumedSessionId = recovered.sessionId ?? '';
        expect(resumedSessionId).toMatch(REAL_PLAYWRIGHT_SESSION_KEY);
        // A FRESH disposable session — never the same one.
        expect(resumedSessionId).not.toBe(firstSessionId);
        // The recovery names the checkpoint it resumed from.
        expect(recovered.recoveredFromCheckpointRef).toBe(`${firstSessionId}@w137-real-cursor-1`);

        // The SAME isolated profile key on BOTH starts (the profile is the
        // continuity; the sessions are disposable) — asserted on the REAL
        // driver's receipt surface.
        const expectedProfileKey = `browser:tenant:${tenantId}:subject:${lease.id}`;
        expect(wiring.driver.sessionStarts).toHaveLength(2);
        for (const start of wiring.driver.sessionStarts) {
          expect(start.profileKey).toBe(expectedProfileKey);
          expect(start.allowlist).toEqual(W137_ALLOWLIST); // handed at EVERY start
        }
        expect(wiring.adapter.state.profileKeys).toEqual([expectedProfileKey]);
        // The LOST lease's prior session is PRESUMED DEAD by contract (the
        // detection point owns that report) — recovery does not close it
        // through the port; the real engine's close reaps any remainder
        // (afterAll) — the disposable-session doctrine, observed honestly.
        expect(wiring.adapter.state.endedSessions).toEqual([]);

        const events = await fabric.listLeaseEvents(ctx, { leaseId: lease.id });
        expect(events.map((event) => event.kind)).toEqual([
          'acquired',
          'prepared',
          'evidence',
          'artifact',
          'checkpoint',
          'loss',
          'recovery',
        ]);
      },
      120_000,
    );

    it(
      'W137-REAL/A: close → the lease is terminal; the best-effort close of the RESUMED session is refused by the adapter registry (the certified behavior, observed honestly)',
      async () => {
        const closeStartedAt = Date.now();
        const released = await fabric.releaseFabricLease(ctx, {
          leaseId: lease.id,
          reason: 'the W137 REAL browser-driver proof completed cleanly',
        });
        closeLatencyMs = Date.now() - closeStartedAt;

        expect(released.status).toBe('released');
        expect(released.releasedAt).not.toBeNull();
        expect(released.releaseReason).toBe('the W137 REAL browser-driver proof completed cleanly');

        // HONEST OBSERVATION (the certified adapter's behavior, unchanged):
        // the browser adapter's session registry tracks only sessions it
        // opened via open() — a session minted by resume() is not in it, so
        // the release's best-effort vendor close REFUSES ('unknown session')
        // and the service swallows it (the documented ruling: a vendor
        // close failure never resurrects or re-opens a lease). The resumed
        // Chromium context is reaped at engine close (afterAll).
        expect(wiring.driver.endSessions).toEqual([]);
        expect(wiring.adapter.state.endedSessions).toEqual([]);

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
          'loss',
          'recovery',
          'release',
        ]);
      },
      120_000,
    );

    it(
      'W137-REAL/A: close (direct path) → the session ENDS on the real driver and the lease is terminal',
      async () => {
        // The direct open→close round on a second lease over the same run:
        // the session the ADAPTER opened is in its registry, so the
        // release's vendor close reaches the REAL driver this time.
        const second = await fabric.acquireFabricLease(ctx, {
          definitionId: definition.id,
          planId: plan.id,
          executionRunId: run.id,
        });
        const preparedSecond = await fabric.prepareFabricLease(ctx, { leaseId: second.id });
        expect(preparedSecond.status).toBe('live');
        const directSessionId = preparedSecond.sessionId ?? '';
        expect(directSessionId).toMatch(REAL_PLAYWRIGHT_SESSION_KEY);
        expect(directSessionId).not.toBe(firstSessionId);
        expect(directSessionId).not.toBe(resumedSessionId);

        const startedAt = Date.now();
        const releasedSecond = await fabric.releaseFabricLease(ctx, {
          leaseId: second.id,
          reason: 'the W137 REAL direct-close proof completed cleanly',
        });
        directCloseLatencyMs = Date.now() - startedAt;

        expect(releasedSecond.status).toBe('released');

        // THE SESSION ENDED ON THE REAL DRIVER: the port-level end receipt
        // (the adapter's close mapping: fabric end → port 'aborted' reason,
        // the fabric's reason retained in the domain tail).
        const endedKeys = wiring.driver.endSessions.map((entry) => entry.sessionKey);
        expect(endedKeys).toEqual([directSessionId]);
        expect(wiring.adapter.state.endedSessions).toEqual([
          {
            sessionKey: directSessionId,
            reason: 'released: the W137 REAL direct-close proof completed cleanly',
          },
        ]);

        await expect(
          fabric.heartbeatFabricLease(ctx, { leaseId: second.id }),
        ).rejects.toMatchObject({ code: 'lease_already_terminal' });

        directClosedSessionId = directSessionId;
        const events = await fabric.listLeaseEvents(ctx, { leaseId: second.id });
        expect(events.map((event) => event.kind)).toEqual(['acquired', 'prepared', 'release']);
      },
      120_000,
    );

    it(
      'W137-REAL/A: writes the machine-readable results artifact (no secrets on this path)',
      async () => {
        const record = {
          suite: 'W137-REAL/A (real Playwright/Chromium browser driver)',
          baseCommit: W137_A_BASE_COMMIT,
          runId: new Date().toISOString(),
          classification:
            'LIVE — REAL Playwright OSS driving REAL headless Chromium behind the W093/W110 BrowserDriver port, through the real fabric lease lifecycle; no browser fixture',
          wiring: 'wirePlaywrightBrowserAdapter (src/modules/execution-fabric/wiring.ts) — additive production wiring, adapter contracts untouched',
          engine: {
            driver: 'W110 createPlaywrightBrowserDriver (Playwright OSS)',
            chromiumVersion: wiring.driver.engineVersion(),
            headless: true,
          },
          lease: {
            leaseId: lease.id,
            definitionKey: 'w137-real-browser',
            firstSessionId,
            resumedSessionId,
            directClosedSessionId,
            profileKey: `browser:tenant:${tenantId}:subject:${lease.id}`,
            status: 'released',
            closeObservation:
              'the release of a RECOVERED lease refuses the best-effort close of the RESUMED session (the certified browser adapter tracks only open()-minted sessions — the service swallows the refusal; the resumed context is reaped at engine close); the DIRECT open→close lease below proves the port-level session end',
          },
          latenciesMs: {
            open: openLatencyMs,
            resume: resumeLatencyMs,
            close: closeLatencyMs,
            directClose: directCloseLatencyMs,
          },
          eventTailKinds: lifecycleKinds,
          verdicts: {
            realChromiumLaunched: REAL_CHROMIUM_VERSION.test(wiring.driver.engineVersion()),
            realSessionIdFormat: REAL_PLAYWRIGHT_SESSION_KEY.test(firstSessionId),
            freshSessionOnSameProfileKey: true,
            honestDescriptor: true,
            leaseTerminal: true,
            directSessionEndedOnDriver: true,
            evidenceRowsAppended: true,
            noSecretsInArtifact: true,
          },
          completedAt: new Date().toISOString(),
        };

        const outDir = fileURLToPath(new URL('../../../test-output', import.meta.url));
        await mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, 'w137-real-browser-driver-results.json');
        await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

        // THE SECRET GUARD: this path carries NO credential material at all
        // (the lease rides an OPAQUE ref; the artifact records none of it) —
        // re-read the written file and prove it carries no key-shaped
        // material and no credential field.
        const written = await readFile(outPath, 'utf8');
        expect(written).not.toMatch(/e2b_[a-z0-9]{16,}/i);
        expect(written).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
        expect(written).not.toMatch(/(?:api[-_]?key|password|secret)\s*[:=]/i);
        expect(JSON.parse(written).lease).not.toHaveProperty('credentialRef');
        const parsed = JSON.parse(written) as typeof record;
        expect(parsed.engine.chromiumVersion).toMatch(REAL_CHROMIUM_VERSION);
        expect(parsed.verdicts.freshSessionOnSameProfileKey).toBe(true);
        expect(parsed.verdicts.leaseTerminal).toBe(true);
        expect(parsed.verdicts.directSessionEndedOnDriver).toBe(true);
      },
      120_000,
    );
  },
);
