// The customer-controlled EDGE RUNTIME of the edge-connector module
// (W088: "Provide a customer-controlled runtime for private/on-prem
// APIs, MCP, OpenAPI, databases, files and approved browser adapters").
//
// This is the code the TENANT runs on their own infrastructure. It holds:
//   * the job VERIFICATION secret (the gateway signer's counterpart —
//     wiring configuration; every claimed envelope's signature, tenant,
//     version and idempotency key are verified locally before anything
//     executes);
//   * the LOCAL SECRET STORE — the credentials of the private systems,
//     which exist ONLY here (executors resolve opaque credentialRefs
//     through the guarded resolver below; no VALUE ever leaves through
//     the port: results are normalized and screened against these exact
//     values before anything is reported);
//   * the ALLOWLIST — the capability keys this runtime will execute,
//     re-checked BEFORE every execution (defense in depth: the
//     gateway's W083 grant and recorded allowlist are necessary, not
//     sufficient — this side's own list is the last word);
//   * the EXECUTORS — the customer's wiring per capability key (an HTTP
//     client, an MCP client, a database driver, a file-share mount, an
//     approved browser adapter…).
//
// OUTBOUND-ONLY: the runtime INITIATES every interaction through the
// EdgeGatewayClient port (claim → execute → report; heartbeat). The
// gateway never reaches in. Production wires an HTTPS adapter over the
// same port; tests and embedded deployments wire the in-memory client
// below — deterministic, no real network.
//
// NO SECOND ORGANIZATIONAL TRUTH STORE: the runtime keeps only in-flight
// job SCRATCH (bounded by the claim limit, expiring with the claim
// lease) plus local telemetry counters for the heartbeat payload —
// runtime state, never domain truth; every durable fact lives in
// Aurum's PostgreSQL.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { allowlistDigestOf, envelopeDigest, verifySignedEnvelope } from './envelope';
import { normalizeEdgeJobResult, screenForSecrets } from './normalize';
import {
  claimEdgeJobs,
  reportEdgeHeartbeat,
  reportEdgeJobResult,
} from './service';
import type {
  EdgeGatewayClient,
  EdgeJobExecutor,
  EdgeJobOutcome,
  EdgeRuntime,
  EdgeRuntimeStats,
  EdgeScratchEntry,
  SignedEdgeJob,
} from './types';

// ---------------------------------------------------------------------------
// The in-memory gateway client (tests + embedded deployments)
// ---------------------------------------------------------------------------

/**
 * An EdgeGatewayClient whose transport is a DIRECT in-process call into
 * the edge-connector service — the deterministic fake gateway+edge pair
 * (no real network). The edge token and the tenant context are wiring
 * here; an HTTPS adapter in production carries the same token in an
 * Authorization header against the tenant's edge endpoints.
 */
export function createInMemoryGatewayClient(config: {
  context: TenantContext;
  edgeKey: string;
  edgeToken: string;
}): EdgeGatewayClient {
  return {
    async claimJobs(request: { limit: number; leaseMs: number }) {
      const result = await claimEdgeJobs(config.context, {
        edgeKey: config.edgeKey,
        edgeToken: config.edgeToken,
        limit: request.limit,
        leaseMs: request.leaseMs,
      });
      return { jobs: result.jobs, reclaimedJobIds: result.reclaimedJobIds };
    },
    async reportJobResult(request: {
      jobId: string;
      executedEnvelopeDigest: string;
      outcome: EdgeJobOutcome;
    }) {
      const result = await reportEdgeJobResult(config.context, {
        edgeKey: config.edgeKey,
        edgeToken: config.edgeToken,
        jobId: request.jobId,
        executedEnvelopeDigest: request.executedEnvelopeDigest,
        outcome: request.outcome,
      });
      return { replayed: result.replayed };
    },
    async heartbeat(request: { version: string; allowlistDigest: string; stats: EdgeRuntimeStats }) {
      await reportEdgeHeartbeat(config.context, {
        edgeKey: config.edgeKey,
        edgeToken: config.edgeToken,
        version: request.version,
        allowlistDigest: request.allowlistDigest,
        stats: request.stats,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The edge runtime
// ---------------------------------------------------------------------------

/**
 * Builds one customer-controlled edge runtime. Configuration is the
 * customer's wiring: gateway client, keys, allowlist, secret store and
 * the per-capability executors. Start it (start) and it claims, executes
 * and reports on its own cadence; stop it and the in-flight scratch ages
 * out with its leases (the gateway reverts expired claims to pending —
 * nothing is lost, nothing is held hostage).
 */
export function createEdgeRuntime(config: {
  gateway: EdgeGatewayClient;
  /** The tenant whose jobs this edge may run (envelope re-check). */
  tenantId: string;
  edgeKey: string;
  version: string;
  systemClass: string;
  allowlist: string[];
  /** The job-verification secret (the gateway signer's counterpart). */
  verificationSecret: string;
  /** The LOCAL secret store: opaque credentialRef → credential VALUE. */
  secrets: Record<string, string>;
  /** The customer's executors, keyed by capability key. */
  executors: Record<string, EdgeJobExecutor>;
  claimLimit?: number;
  leaseMs?: number;
  /** The claim/execute/report cadence (default 250ms; tests tighten it). */
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}): EdgeRuntime {
  const claimLimit = config.claimLimit ?? 8;
  const leaseMs = config.leaseMs ?? 120_000;
  const pollIntervalMs = config.pollIntervalMs ?? 250;
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;

  const allowlist = [...config.allowlist];
  const scratch = new Map<string, EdgeScratchEntry>();
  let lastHeartbeatAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stats: EdgeRuntimeStats = {
    jobsClaimed: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
    jobsRefused: 0,
    lastJobAt: null,
  };

  function dropExpiredScratch(): void {
    const at = now().getTime();
    for (const [jobId, entry] of scratch) {
      if (Date.parse(entry.expiresAt) <= at) scratch.delete(jobId);
    }
  }

  async function heartbeatOnce(): Promise<void> {
    lastHeartbeatAt = now().getTime();
    await config.gateway.heartbeat({
      version: config.version,
      allowlistDigest: allowlistDigestOf(allowlist),
      stats: { ...stats },
    });
  }

  /**
   * Processes ONE claimed signed job — the full edge-side discipline:
   * verify → allowlist re-check → execute → normalize → secret-screen →
   * report. Every refusal is a machine-readable code; every failure
   * stays local except its code; nothing provider-shaped or
   * secret-bearing ever crosses back.
   */
  async function processSignedJob(signed: SignedEdgeJob): Promise<void> {
    const envelope = signed.envelope;

    // 1. VERIFY the envelope (signature, version, tenant, idempotency key).
    const verification = verifySignedEnvelope(signed, {
      verificationSecret: config.verificationSecret,
      expectedTenantId: config.tenantId,
      expectedEdgeKey: config.edgeKey,
    });
    if (!verification.ok) {
      stats.jobsRefused += 1;
      stats.lastJobAt = now().toISOString();
      await config.gateway.reportJobResult({
        jobId: envelope.jobId,
        executedEnvelopeDigest: envelopeDigest(envelope),
        outcome: { kind: 'refused', reason: verification.reason },
      });
      scratch.delete(envelope.jobId);
      return;
    }

    // 2. RE-CHECK the edge's OWN allowlist (defense in depth — the
    //    gateway's grant and recorded allowlist are necessary, not
    //    sufficient; this list is the last word).
    if (!allowlist.includes(envelope.capabilityKey)) {
      stats.jobsRefused += 1;
      stats.lastJobAt = now().toISOString();
      await config.gateway.reportJobResult({
        jobId: envelope.jobId,
        executedEnvelopeDigest: envelopeDigest(envelope),
        outcome: { kind: 'refused', reason: 'capability_not_allowed' },
      });
      scratch.delete(envelope.jobId);
      return;
    }

    // 3. EXECUTE through the customer's wiring (or refuse honestly).
    const executor = config.executors[envelope.capabilityKey];
    if (executor === undefined) {
      stats.jobsRefused += 1;
      stats.lastJobAt = now().toISOString();
      await config.gateway.reportJobResult({
        jobId: envelope.jobId,
        executedEnvelopeDigest: envelopeDigest(envelope),
        outcome: { kind: 'refused', reason: 'no_executor' },
      });
      scratch.delete(envelope.jobId);
      return;
    }

    let raw: unknown;
    try {
      raw = await executor.execute({
        kind: envelope.kind,
        capabilityKey: envelope.capabilityKey,
        systemClass: envelope.systemClass,
        request: envelope.request,
        resolveCredential: (credentialRef: string): string | null => {
          const value = config.secrets[credentialRef];
          return value === undefined ? null : value;
        },
      });
    } catch {
      // An executor throw is LOCAL: the raw message stays on the edge
      // (it may carry a secret); only the machine-readable code crosses.
      stats.jobsFailed += 1;
      stats.lastJobAt = now().toISOString();
      await config.gateway.reportJobResult({
        jobId: envelope.jobId,
        executedEnvelopeDigest: envelopeDigest(envelope),
        outcome: { kind: 'failed', reason: 'executor_error' },
      });
      scratch.delete(envelope.jobId);
      return;
    }

    // 4. NORMALIZE into the canonical deep-action shape (provider
    //    objects never cross the edge seam).
    const normalization = normalizeEdgeJobResult(envelope.kind, raw);
    if (!normalization.ok) {
      stats.jobsFailed += 1;
      stats.lastJobAt = now().toISOString();
      await config.gateway.reportJobResult({
        jobId: envelope.jobId,
        executedEnvelopeDigest: envelopeDigest(envelope),
        outcome: { kind: 'failed', reason: 'invalid_result' },
      });
      scratch.delete(envelope.jobId);
      return;
    }

    // 5. SCREEN the normalized result against the LOCAL secret values —
    //    the only place that holds them is the only place that can
    //    screen for them. A leak is refused loudly and the VALUE never
    //    crosses (not into a table, an event, or an error message).
    if (screenForSecrets(normalization.result, Object.values(config.secrets))) {
      stats.jobsFailed += 1;
      stats.lastJobAt = now().toISOString();
      await config.gateway.reportJobResult({
        jobId: envelope.jobId,
        executedEnvelopeDigest: envelopeDigest(envelope),
        outcome: { kind: 'failed', reason: 'secret_leak_detected' },
      });
      scratch.delete(envelope.jobId);
      return;
    }

    // 6. REPORT the canonical outcome.
    if (envelope.kind === 'execute') {
      const receipt = normalization.result as { status: string };
      if (receipt.status === 'failed') stats.jobsFailed += 1;
      else stats.jobsSucceeded += 1;
    } else {
      stats.jobsSucceeded += 1;
    }
    stats.lastJobAt = now().toISOString();
    await config.gateway.reportJobResult({
      jobId: envelope.jobId,
      executedEnvelopeDigest: envelopeDigest(envelope),
      outcome: { kind: 'result', result: normalization.result },
    });
    scratch.delete(envelope.jobId);
  }

  /** One claim → execute → report cycle (the loop body). */
  async function pollOnce(): Promise<void> {
    dropExpiredScratch();
    const due = lastHeartbeatAt === 0 || now().getTime() - lastHeartbeatAt >= heartbeatIntervalMs;
    if (due) await heartbeatOnce();
    // Only claim what the scratch bound allows (bounded in-flight work).
    const room = Math.max(0, claimLimit - scratch.size);
    if (room === 0) return;
    const claimed = await config.gateway.claimJobs({ limit: room, leaseMs });
    for (const signed of claimed.jobs) {
      stats.jobsClaimed += 1;
      scratch.set(signed.envelope.jobId, {
        jobId: signed.envelope.jobId,
        capabilityKey: signed.envelope.capabilityKey,
        claimedAt: now().toISOString(),
        expiresAt: new Date(now().getTime() + leaseMs).toISOString(),
      });
      await processSignedJob(signed);
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void pollOnce().catch(() => undefined);
      }, pollIntervalMs);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    pollOnce,
    heartbeatOnce,
    processSignedJob,
    get scratch(): readonly EdgeScratchEntry[] {
      return [...scratch.values()];
    },
    get allowlist(): readonly string[] {
      return [...allowlist];
    },
    get stats(): EdgeRuntimeStats {
      return { ...stats };
    },
  };
}
