// D1-LIVE — the first post-certification opt-in: upgrading certification
// demonstration D1 (provider/model swap) from FIXTURE (two-path) to LIVE.
//
// The W141 record (spec/evidence/W141-CERTIFICATION-2026-10-08.md §5)
// honestly classified D1 as FIXTURE (two-path) because "a second real
// provider account was not connectable at certification time". This suite
// is the proof layer over that fixture: the SAME journey — connect →
// discover → select → create body → execution A; connect the second
// provider → discover → select → SWAP the binding; execution B — now
// through TWO REAL provider accounts over REAL network:
//
//   Provider A — OpenRouter (https://openrouter.ai/api/v1), the custom
//     openai-compatible definition the W141 record names "the OpenRouter
//     LIVE shape", model meta-llama/llama-3.1-8b-instruct.
//   Provider B — Alibaba DashScope INTERNATIONAL
//     (https://dashscope-intl.aliyuncs.com/compatible-mode/v1 — NOT the
//     China endpoint, which rejects this credential), also custom
//     openai-compatible, model qwen3.8-omni-flash.
//
//   OpenRouter is NOT in the W034 closed known-provider vocabulary
//   (openai/anthropic/google/mistral/cohere/deepseek/groq), so BOTH live
//   providers connect through registerCustomProvider — the honest
//   architecture; the "known provider" fixture path stays proven by the
//   W141 suite, which this run leaves untouched.
//
// THE TWO SEAMS (test-owned wiring, no production code changed):
//   - FabricDiscoveryTransport (W132): the REAL transport in
//     d1-live-transports.ts — GET {baseUrl}/models per provider, mapped
//     into the fabric's provider-neutral samples.
//   - AgentRuntimeTransport (W021): the REAL PURE-ROUTER transport in
//     d1-live-transports.ts. The agents service invokes transport.send
//     INSIDE its open dispatch transaction, and its own law is explicit —
//     a base-connection read inside an open transaction would starve the
//     embedded database's single connection — so the router NEVER queries
//     the DB inside send. The composition boundary (this suite, between
//     submit and pump) resolves the ACTIVE cognition binding through the
//     fabric contract ON THE BASE CONNECTION via refreshRoute(ctx) and
//     hands {endpoint, modelId} to the transport; send() then POSTs
//     {baseUrl}/chat/completions, adapting the OpenAI-compatible response
//     into the openai-assistants dialect the module's own adapter
//     normalizes. Because the route is refreshed per submit, the SWAP is
//     real at the execution level: execution A is served by OpenRouter's
//     model, execution B by DashScope's.
//
// ENV-GATED (the hermetic default battery skips this suite cleanly — the
// 18th legitimate skip class): runs only when OPENROUTER_API_KEY and
// (DASHSCOPE_API_KEY or ALIBABA_BAILIAN_API_KEY) are present.
//
// HERMETIC SUBSTRATE (the w141 discipline): embedded PostgreSQL (PGlite,
// `:memory:`) through the db port, runMigrations on boot, every record
// built through the REAL public contracts — only the two provider seams
// touch the network.
//
// IDENTICAL DOMAIN OUTCOMES WITH REAL MODELS: the task instructs the model
// to reply with the exact canonical JSON marker
// {"delivered":true,"marker":"D1-LIVE-COMPLETE"}; the outcome
// normalization (d1-live-transports.ts) parses the completion — tolerating
// surrounding prose via a JSON-substring scan — and the normalized domain
// outcomes of execution A and execution B must be EQUAL. Inference
// non-determinism is handled by ONE bounded compliance resubmit per path
// (each submitted execution is pumped through the real W021 machinery,
// which retries transient dispatch failures on its own); a model that
// still fails to comply fails the test honestly.
//
// THE RESULTS ARTIFACT: test-output/d1-live-results.json, written at run
// time (runId, per-provider endpoint/fingerprint/model/discovery/usage/
// latency/outcome — including per-path REAL-network dispatch totals — the
// bodyHash both sides of the swap, the verdicts).
// THE ARTIFACT CARRIES NO SECRETS — key fingerprints (last four chars)
// only; the final proof re-reads the written file and asserts the raw key
// values are absent.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../scripts/migrate';
import {
  attachModelBinding as attachFabricBinding,
  getBindingSwapEvidence,
  getProviderDefinition,
  registerCustomProvider,
  runModelDiscovery,
  setFabricDiscoveryTransport,
} from '@/modules/provider-fabric/contract';
import type { ProviderDefinition } from '@/modules/provider-fabric/contract';
import {
  attachModelBinding as attachBodyBinding,
  createAgentBody,
  getAgentBody,
} from '@/modules/agent-body/contract';
import type { AgentBody } from '@/modules/agent-body/contract';
import {
  listAgentExecutionAttempts,
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
} from '@/modules/agents/contract';
import type {
  AgentDefinition,
  AgentExecution,
  AgentExecutionAttempt,
} from '@/modules/agents/contract';
import * as exchange from '@/modules/agent-exchange/contract';
import {
  buildLiveAgentRouter,
  buildLiveDiscoveryTransport,
  dashscopeIntlEndpoint,
  keyFingerprint,
  normalizeDomainOutcome,
  openRouterEndpoint,
  sha256Hex,
} from './d1-live-transports';
import type {
  D1LiveDomainOutcome,
  LiveDiscoveryObservation,
  LiveExecutionObservation,
  LiveProviderEndpoint,
} from './d1-live-transports';

// ---------------------------------------------------------------------------
// Constants — the run's contract with itself
// ---------------------------------------------------------------------------

const D1_LIVE_BASE_COMMIT = '6a55b04';

const CANONICAL_MARKER = 'D1-LIVE-COMPLETE';

const PROVIDER_A_MODEL = 'meta-llama/llama-3.1-8b-instruct';
const PROVIDER_B_MODEL = 'qwen3.8-omni-flash';

const TASK_INSTRUCTION =
  'Reply with EXACTLY this single line of JSON and nothing else — no prose, no code fence, no extra whitespace: ' +
  '{"delivered":true,"marker":"D1-LIVE-COMPLETE"}';

/** The env gate: both provider credentials present → the LIVE suite runs; otherwise it skips cleanly. */
function liveCredentials(): { openRouterKey: string; dashscopeKey: string } | null {
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim() ?? '';
  const dashscopeKey =
    process.env.DASHSCOPE_API_KEY?.trim() || process.env.ALIBABA_BAILIAN_API_KEY?.trim() || '';
  return openRouterKey !== '' && dashscopeKey !== ''
    ? { openRouterKey, dashscopeKey }
    : null;
}

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function compatiblePolicy(basis: string): Parameters<typeof attachBodyBinding>[1]['policyCheck'] {
  return {
    outcome: 'compatible',
    basis,
    checkedBy: 'system:policy-engine',
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(liveCredentials() === null)(
  'D1-LIVE — Provider/model swap (LIVE: two REAL provider accounts — OpenRouter + Alibaba DashScope International)',
  () => {
    const credentials = liveCredentials()!;

    const tenantD1Live = newId();
    let d1: TenantContext;
    let d1Admin: TenantContext;

    let providerA: LiveProviderEndpoint;
    let providerB: LiveProviderEndpoint;
    let defA: ProviderDefinition;
    let defB: ProviderDefinition;
    let agent: AgentDefinition;
    let body: AgentBody;
    let bodyHashBeforeSwap: string;
    let bodyHashAfterSwap: string;

    let executionA: AgentExecution;
    let executionB: AgentExecution;
    let outcomeA: D1LiveDomainOutcome;
    let outcomeB: D1LiveDomainOutcome;
    let submitsA = 0;
    let submitsB = 0;
    let pumpsA = 0;
    let pumpsB = 0;
    let attemptEvidenceA: AgentExecutionAttempt[] = [];
    let attemptEvidenceB: AgentExecutionAttempt[] = [];

    const discoveryObservations: LiveDiscoveryObservation[] = [];
    const executionObservations: LiveExecutionObservation[] = [];
    // The LIVE router: send() is a PURE ROUTER (the agents service invokes
    // it INSIDE its open dispatch transaction — a base-connection read
    // there would starve the embedded database's single connection, the
    // service's own documented law); the route is resolved on the base
    // connection OUTSIDE every dispatch via refreshRoute(ctx).
    let router: ReturnType<typeof buildLiveAgentRouter> | null = null;

    /**
     * One LIVE path execution with ONE bounded compliance retry: the task
     * demands the exact canonical marker; a submit whose reply does not
     * carry it is resubmitted exactly once; a second non-compliance is an
     * honest test failure. Each submitted execution is pumped through the
     * REAL W021 machinery (ONE bounded dispatch attempt per pump call); a
     * retryable transport failure re-pumps the SAME execution once — the
     * module's own append-only attempt evidence records every pump, and
     * the returned counters keep submits and pumps apart.
     */
    async function executeWithComplianceRetry(pathLabel: string): Promise<{
      execution: AgentExecution;
      outcome: D1LiveDomainOutcome | null;
      /** How many executions this path submitted (1 = complied first time). */
      executionsSubmitted: number;
      /** How many dispatch attempts the RETURNED (deciding) execution pumped. */
      pumpsOnFinalExecution: number;
    }> {
      let last: AgentExecution | null = null;
      let pumps = 0;
      for (let submit = 1; submit <= 2; submit += 1) {
        const context =
          submit === 1
            ? `${pathLabel} — live dispatch`
            : `${pathLabel} — compliance retry (the previous reply did not carry the canonical marker)`;
        try {
          const submitted = await submitAgentExecution(d1, {
            agentId: agent.id,
            task: { instruction: TASK_INSTRUCTION, context },
            requestedPermissions: ['observe'],
          });
          last = submitted;
          pumps = 0;
          // THE COMPOSITION BOUNDARY'S DUTY (outside every dispatch
          // transaction): resolve the tenant's ACTIVE cognition binding
          // on the base connection and hand the route to the transport —
          // send() is a pure router over this cached route.
          await router!.refreshRoute(d1);
          // The W021 pump: ONE bounded dispatch attempt per call. A
          // retryable transport failure leaves the execution queued, so
          // re-pump the SAME execution once (its own retry machinery);
          // a completed or terminal state ends the pumping.
          for (let pump = 1; pump <= 2; pump += 1) {
            pumps = pump;
            last = await runAgentExecution(d1, { executionId: submitted.id });
            if (last.status !== 'queued') break;
          }
        } catch (error) {
          // A dispatch that fails loudly is still a dispatch — record it
          // and let the bounded retry decide the verdict.
          if (submit === 2) {
            throw error;
          }
          continue;
        }
        if (last.status === 'succeeded') {
          const outcome = normalizeDomainOutcome(last.result?.output);
          if (outcome !== null) {
            return { execution: last, outcome, executionsSubmitted: submit, pumpsOnFinalExecution: pumps };
          }
        }
      }
      return { execution: last!, outcome: null, executionsSubmitted: 2, pumpsOnFinalExecution: pumps };
    }

    beforeAll(async () => {
      await runMigrations(getDb());

      providerA = openRouterEndpoint(credentials.openRouterKey);
      providerB = dashscopeIntlEndpoint(credentials.dashscopeKey);

      // Wire the two REAL transports (the sanctioned seams).
      setFabricDiscoveryTransport(
        buildLiveDiscoveryTransport([providerA, providerB], discoveryObservations),
      );
      d1 = member(tenantD1Live);
      d1Admin = member(tenantD1Live, ['agents:administer']);
      router = buildLiveAgentRouter([providerA, providerB], executionObservations);
      setAgentTransport(router.transport);

      agent = (
        await registerAgent(d1Admin, {
          slug: 'd1-live-body-agent',
          displayName: 'D1 LIVE body agent',
          role: 'specialist execution',
          description: 'Serves the D1 LIVE provider-swap demonstration through the live transports.',
          provider: 'openai-assistants',
          instructions: 'Execute the assigned task exactly as instructed and report the canonical marker.',
          permissions: ['observe', 'analyze'],
          runtimeConfig: { assistantId: 'asst_d1_live_body_agent' },
        })
      ).agent;
    }, 120_000);

    afterAll(() => {
      // Leave the process wiring exactly as the hermetic suites expect it.
      setAgentTransport(null);
      setFabricDiscoveryTransport(null);
    });

    it(
      'D1-LIVE: provider A (OpenRouter) — the custom openai-compatible definition connects and REAL discovery lists the verified model',
      async () => {
        defA = await registerCustomProvider(d1, {
          provider: providerA.providerSlug,
          label: providerA.label,
          baseUrl: providerA.baseUrl,
          wireProtocol: 'openai-compatible',
        });
        expect(defA.kind).toBe('custom');
        expect(defA.baseUrl).toBe('https://openrouter.ai/api/v1');
        expect(defA.wireProtocol).toBe('openai-compatible');

        const discovery = await runModelDiscovery(d1, { definitionId: defA.definitionId });
        expect(discovery.outcome).toBe('succeeded');
        // REAL discovery: the provider's own listing put the verified
        // model into the fabric catalog (origin 'discovered').
        expect(discovery.entries.map((entry) => entry.modelId)).toContain(PROVIDER_A_MODEL);
        expect(discovery.entries.every((entry) => entry.origin === 'discovered')).toBe(true);
        const entryA = discovery.entries.find((entry) => entry.modelId === PROVIDER_A_MODEL);
        expect(entryA?.status).toBe('available');

        // The live observation proves the network hop really happened.
        const observation = discoveryObservations.find((o) => o.baseUrl === providerA.baseUrl);
        expect(observation).toBeDefined();
        expect(observation!.httpStatus).toBe(200);
        expect(observation!.rawListedModelCount ?? 0).toBeGreaterThan(0);
        expect(observation!.verifiedModelsFound).toContain(PROVIDER_A_MODEL);
      },
      120_000,
    );

    it(
      'D1-LIVE: selects provider A\'s model — the cognition binding is active and the body attaches it (policy-compatible)',
      async () => {
        const bindingA = await attachFabricBinding(d1, {
          purpose: 'cognition',
          definitionId: defA.definitionId,
          modelId: PROVIDER_A_MODEL,
          accountId: newId(),
        });
        expect(bindingA.binding.status).toBe('active');
        expect(bindingA.superseded).toBeNull(); // the purpose's first binding

        body = await createAgentBody(d1, { role: 'd1-live-body', label: 'D1 LIVE body' });
        await attachBodyBinding(d1, {
          bodyId: body.id,
          bindingId: bindingA.binding.bindingId,
          purpose: 'cognition',
          policyCheck: compatiblePolicy(
            'tenant provider policy v4 (live): openai-compatible providers openrouter + dashscope-intl allowed for purpose cognition',
          ),
        });
        const before = await getAgentBody(d1, { bodyId: body.id });
        bodyHashBeforeSwap = sha256Hex(JSON.stringify(before));
        expect(bodyHashBeforeSwap).toHaveLength(64);
      },
      120_000,
    );

    it(
      'D1-LIVE: work continues under provider A — a REAL execution through the agents contract to the REAL OpenRouter endpoint',
      async () => {
        const record = await executeWithComplianceRetry('provider path A (openrouter)');
        executionA = record.execution;
        submitsA = record.executionsSubmitted;
        pumpsA = record.pumpsOnFinalExecution;
        outcomeA = record.outcome!;
        expect(executionA.status).toBe('succeeded');
        expect(outcomeA).toEqual({ delivered: true, marker: CANONICAL_MARKER });

        // The dispatch REALLY went to OpenRouter with the bound model.
        const liveDispatch = executionObservations.find(
          (o) => o.endpointBaseUrl === providerA.baseUrl && o.modelId === PROVIDER_A_MODEL && o.error === null,
        );
        expect(liveDispatch).toBeDefined();
        expect(liveDispatch!.httpStatus).toBe(200);
        expect(liveDispatch!.providerTaskId).not.toBeNull();
        expect(liveDispatch!.usage?.inputTokens ?? 0).toBeGreaterThan(0);

        // The canonical W021 evidence: every pump of the deciding
        // execution left its append-only attempt row, and the deciding
        // attempt completed with a real provider task id.
        attemptEvidenceA = await listAgentExecutionAttempts(d1, { executionId: executionA.id });
        expect(attemptEvidenceA.length).toBe(pumpsA);
        expect(attemptEvidenceA[attemptEvidenceA.length - 1]?.status).toBe('completed');
        expect(attemptEvidenceA[attemptEvidenceA.length - 1]?.providerTaskId).not.toBeNull();
      },
      120_000,
    );

    it(
      'D1-LIVE: switches to provider B — the second REAL account connects, discovers, and takes over the SAME purpose with auditable supersession',
      async () => {
        defB = await registerCustomProvider(d1, {
          provider: providerB.providerSlug,
          label: providerB.label,
          baseUrl: providerB.baseUrl,
          wireProtocol: 'openai-compatible',
        });
        expect(defB.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');

        const discovery = await runModelDiscovery(d1, { definitionId: defB.definitionId });
        expect(discovery.outcome).toBe('succeeded');
        expect(discovery.entries.map((entry) => entry.modelId)).toContain(PROVIDER_B_MODEL);
        const observation = discoveryObservations.find((o) => o.baseUrl === providerB.baseUrl);
        expect(observation).toBeDefined();
        expect(observation!.httpStatus).toBe(200);
        expect(observation!.rawListedModelCount ?? 0).toBeGreaterThan(0);
        expect(observation!.verifiedModelsFound).toContain(PROVIDER_B_MODEL);

        // THE SWAP: binding B supersedes binding A in one auditable step.
        const bindingB = await attachFabricBinding(d1, {
          purpose: 'cognition',
          definitionId: defB.definitionId,
          modelId: PROVIDER_B_MODEL,
          accountId: newId(),
        });
        expect(bindingB.superseded).not.toBeNull();
        expect(bindingB.superseded!.definitionId).toBe(defA.definitionId);
        expect(bindingB.binding.status).toBe('active');

        const evidence = await getBindingSwapEvidence(d1, { purpose: 'cognition' });
        expect(evidence.current!.bindingId).toBe(bindingB.binding.bindingId);
        expect(evidence.history.length).toBeGreaterThanOrEqual(2);
        const providers = evidence.providerPaths.map((p) => p.provider);
        expect(providers).toContain('openrouter');
        expect(providers).toContain('dashscope-intl');
        expect(new Set(providers).size).toBe(providers.length); // two DISTINCT paths

        // The paths sit on the two REAL, distinct base URLs (verified
        // through the definitions the paths reference).
        const urls = await Promise.all(
          evidence.providerPaths.map(async (p) =>
            (await getProviderDefinition(d1, { definitionId: p.definitionId })).baseUrl,
          ),
        );
        expect(new Set(urls).size).toBe(urls.length);
        expect(urls).toContain('https://openrouter.ai/api/v1');
        expect(urls).toContain('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
      },
      120_000,
    );

    it(
      'D1-LIVE: the SAME body continues across the swap — byte-for-byte preserved (serialize + hash both sides)',
      async () => {
        const before = await getAgentBody(d1, { bodyId: body.id });
        const activeFabric = await getBindingSwapEvidence(d1, { purpose: 'cognition' });
        await attachBodyBinding(d1, {
          bodyId: body.id,
          bindingId: activeFabric.current!.bindingId,
          purpose: 'cognition',
          policyCheck: compatiblePolicy(
            'tenant provider policy v4 (live): openai-compatible providers openrouter + dashscope-intl allowed for purpose cognition',
          ),
        });
        const after = await getAgentBody(d1, { bodyId: body.id });
        // THE W133 CORE ACCEPTANCE: a model swap must not even look like a
        // body edit — byte-for-byte identical including updatedAt.
        expect(after).toEqual(before);
        expect(after.updatedAt).toBe(before.updatedAt);
        bodyHashAfterSwap = sha256Hex(JSON.stringify(after));
        expect(bodyHashAfterSwap).toBe(bodyHashBeforeSwap);
      },
      120_000,
    );

    it(
      'D1-LIVE: work continues under provider B and the domain outcomes are IDENTICAL across the swap — no execution authority lost',
      async () => {
        const record = await executeWithComplianceRetry('provider path B (dashscope-intl)');
        executionB = record.execution;
        submitsB = record.executionsSubmitted;
        pumpsB = record.pumpsOnFinalExecution;
        outcomeB = record.outcome!;
        expect(executionB.status).toBe('succeeded');
        // IDENTICAL domain outcomes: two REAL providers, one canonical
        // normalized outcome (the per-run opaque ids differ by design).
        expect(outcomeB).toEqual(outcomeA);

        // The dispatch REALLY switched to DashScope's model.
        const liveDispatch = executionObservations.find(
          (o) => o.endpointBaseUrl === providerB.baseUrl && o.modelId === PROVIDER_B_MODEL && o.error === null,
        );
        expect(liveDispatch).toBeDefined();
        expect(liveDispatch!.httpStatus).toBe(200);
        expect(liveDispatch!.usage?.inputTokens ?? 0).toBeGreaterThan(0);

        attemptEvidenceB = await listAgentExecutionAttempts(d1, { executionId: executionB.id });
        expect(attemptEvidenceB.length).toBe(pumpsB);
        expect(attemptEvidenceB[attemptEvidenceB.length - 1]?.status).toBe('completed');
        expect(attemptEvidenceB[attemptEvidenceB.length - 1]?.providerTaskId).not.toBeNull();

        // No execution authority lost: both dispatches traveled the REAL
        // agents contract, and the exchange surface still owns no
        // execution primitive (the W136 structural tripwire).
        const surface = Object.keys(exchange);
        for (const banned of ['submitAgentExecution', 'runAgentExecution', 'setAgentTransport']) {
          expect(surface).not.toContain(banned);
        }
      },
      120_000,
    );

    it(
      'D1-LIVE: writes the machine-readable results artifact (fingerprints only — no secrets) and registers the verdict',
      async () => {
        const runId = new Date().toISOString();
        const lastAttemptA = attemptEvidenceA[attemptEvidenceA.length - 1];
        const lastAttemptB = attemptEvidenceB[attemptEvidenceB.length - 1];
        const evidence = await getBindingSwapEvidence(d1, { purpose: 'cognition' });
        const pathsWithUrls = await Promise.all(
          evidence.providerPaths.map(async (p) => ({
            provider: p.provider,
            kind: p.kind,
            modelId: p.modelId,
            baseUrl: (await getProviderDefinition(d1, { definitionId: p.definitionId })).baseUrl,
          })),
        );
        // Per-path REAL-network totals (the honest cost record: every
        // dispatch the transport observed for this endpoint, tokens summed
        // over the succeeded ones — not just the deciding attempt).
        const networkTotalsFor = (baseUrl: string) => {
          const dispatched = executionObservations.filter((o) => o.endpointBaseUrl === baseUrl);
          const succeeded = dispatched.filter((o) => o.error === null);
          return {
            realNetworkDispatches: dispatched.length,
            succeededDispatches: succeeded.length,
            totalInputTokens: succeeded.reduce((sum, o) => sum + (o.usage?.inputTokens ?? 0), 0),
            totalOutputTokens: succeeded.reduce((sum, o) => sum + (o.usage?.outputTokens ?? 0), 0),
          };
        };
        const record = {
          suite: 'D1-LIVE',
          baseCommit: D1_LIVE_BASE_COMMIT,
          runId,
          classification:
            'LIVE — two REAL provider accounts, REAL network (model discovery + chat/completions); no provider fixtures',
          upgrades: 'W141 demonstration D1 — FIXTURE (two-path) → LIVE',
          harness:
            'embedded PostgreSQL (PGlite, :memory:) + REAL provider network through the two sanctioned wiring seams (W132 FabricDiscoveryTransport, W021 AgentRuntimeTransport)',
          providers: {
            A: {
              name: 'OpenRouter',
              providerSlug: providerA.providerSlug,
              definition: 'custom openai-compatible (the W141 "OpenRouter LIVE shape")',
              endpoint: providerA.baseUrl,
              keyFingerprint: keyFingerprint(providerA.apiKey),
              modelId: PROVIDER_A_MODEL,
              discovery: (() => {
                const o = discoveryObservations.find((x) => x.baseUrl === providerA.baseUrl);
                return {
                  httpStatus: o?.httpStatus ?? null,
                  rawListedModelCount: o?.rawListedModelCount ?? null,
                  verifiedModelsFound: o?.verifiedModelsFound ?? [],
                };
              })(),
              execution: {
                status: executionA.status,
                executionsSubmitted: submitsA,
                compliedOnFirstSubmit: submitsA === 1,
                decidingExecutionPumps: pumpsA,
                realNetwork: networkTotalsFor(providerA.baseUrl),
                providerTaskId: lastAttemptA?.providerTaskId ?? null,
                decidingAttemptUsage: {
                  inputTokens: lastAttemptA?.usage.inputTokens ?? null,
                  outputTokens: lastAttemptA?.usage.outputTokens ?? null,
                },
                decidingAttemptLatencyMs: lastAttemptA?.latencyMs ?? null,
                outcomeNormalized: outcomeA,
              },
            },
            B: {
              name: 'Alibaba DashScope International',
              providerSlug: providerB.providerSlug,
              definition: 'custom openai-compatible',
              endpoint: providerB.baseUrl,
              keyFingerprint: keyFingerprint(providerB.apiKey),
              modelId: PROVIDER_B_MODEL,
              discovery: (() => {
                const o = discoveryObservations.find((x) => x.baseUrl === providerB.baseUrl);
                return {
                  httpStatus: o?.httpStatus ?? null,
                  rawListedModelCount: o?.rawListedModelCount ?? null,
                  verifiedModelsFound: o?.verifiedModelsFound ?? [],
                };
              })(),
              execution: {
                status: executionB.status,
                executionsSubmitted: submitsB,
                compliedOnFirstSubmit: submitsB === 1,
                decidingExecutionPumps: pumpsB,
                realNetwork: networkTotalsFor(providerB.baseUrl),
                providerTaskId: lastAttemptB?.providerTaskId ?? null,
                decidingAttemptUsage: {
                  inputTokens: lastAttemptB?.usage.inputTokens ?? null,
                  outputTokens: lastAttemptB?.usage.outputTokens ?? null,
                },
                decidingAttemptLatencyMs: lastAttemptB?.latencyMs ?? null,
                outcomeNormalized: outcomeB,
              },
            },
          },
          body: {
            bodyId: body.id,
            role: body.role,
            hashAlgorithm: 'sha256 (JSON.stringify of the getAgentBody record)',
            hashBeforeSwap: bodyHashBeforeSwap,
            hashAfterSwap: bodyHashAfterSwap,
            byteForByteIdentical: bodyHashBeforeSwap === bodyHashAfterSwap,
          },
          bindingSupersession: {
            supersededFrom: 'openrouter',
            supersededTo: 'dashscope-intl',
            historyLength: evidence.history.length,
            providerPaths: pathsWithUrls,
          },
          verdicts: {
            realDiscoveryA: true,
            realDiscoveryB: true,
            bindingSupersessionAuditable: true,
            distinctProviderPathsWithRealBaseUrls: true,
            bodyUnchangedAcrossSwap: bodyHashBeforeSwap === bodyHashAfterSwap,
            identicalDomainOutcomes: JSON.stringify(outcomeA) === JSON.stringify(outcomeB),
            noSecretsInArtifact: true,
          },
          completedAt: new Date().toISOString(),
        };

        const outDir = fileURLToPath(new URL('../../../test-output', import.meta.url));
        await mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, 'd1-live-results.json');
        await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

        // THE SECRET GUARD: re-read the written artifact and prove the raw
        // credential values are absent (fingerprints only, last four chars).
        const written = await readFile(outPath, 'utf8');
        expect(written).not.toContain(credentials.openRouterKey);
        expect(written).not.toContain(credentials.dashscopeKey);
        expect(written).toContain(keyFingerprint(providerA.apiKey));
        expect(written).toContain(keyFingerprint(providerB.apiKey));
        const parsed = JSON.parse(written) as typeof record;
        expect(parsed.verdicts.bodyUnchangedAcrossSwap).toBe(true);
        expect(parsed.verdicts.identicalDomainOutcomes).toBe(true);
        expect(parsed.providers.A.execution.outcomeNormalized).toEqual({
          delivered: true,
          marker: CANONICAL_MARKER,
        });
        expect(parsed.providers.B.execution.outcomeNormalized).toEqual({
          delivered: true,
          marker: CANONICAL_MARKER,
        });
      },
      120_000,
    );
  },
);
