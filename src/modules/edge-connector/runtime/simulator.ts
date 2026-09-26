// The deterministic in-memory edge runtime (W088) — the repository's
// double for the CUSTOMER-CONTROLLED runtime. A real edge is a process
// the customer operates on their own infrastructure; it dials home to
// Aurum (outbound-only), verifies every job envelope with the enrollment
// key it holds, enforces its OWN local capability allowlist at the
// boundary, resolves secret references against its OWN local secret
// store (secret values never leave it), and submits canonical results.
//
// This simulator implements exactly that behavior in-memory, through the
// module's real dial-home contract calls — so the protocol (proofs,
// envelope verification, allowlist checks, nonce consumption, result
// normalization) is exercised end-to-end with NO live network (the
// fixtures/doubles doctrine). It deliberately verifies envelopes with ITS
// OWN copy of the key material (never trusting Aurum's stored state) and
// keeps its OWN consumed-nonce set — exactly what a customer-side
// implementation would do.
//
// Scriptable failure modes (for negative tests):
//   * `nativeStateObject`  — return a provider-native object (a Date) as
//     the read state; the boundary submission must be rejected loudly
//     (`invalid_edge_result` — provider objects never cross);
//   * adapters themselves are injectable per connectivity kind (the
//     deterministic doubles ship scriptable failure modes).

import { randomUUID } from 'node:crypto';
import { createHmacSigner, edgeAuthMaterial, verifyEnvelopeSignature } from '../envelope';
import {
  pullPendingEdgeJobs,
  sendEdgeHeartbeat,
  submitEdgeJobResult,
} from '../service';
import type {
  EdgeAuthentication,
  EdgeConnectivityKind,
  EdgeJobEnvelope,
  EdgeJobResult,
  EdgeReceiptStatus,
  EdgeSigner,
  SignedEdgeJobEnvelope,
} from '../types';
import {
  createDeterministicConnectivityAdapters,
  type EdgeAdapterRequest,
  type EdgeAdapterResult,
  type EdgeConnectivityAdapter,
} from './adapters';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The edge-side allowlist (the customer's own boundary policy). */
export interface LocalAllowlistEntry {
  capabilityKey: string;
  mode: 'read' | 'write';
  connectivity: EdgeConnectivityKind;
  /** The secret reference the edge resolves LOCALLY. */
  secretRef: string;
  secretScopes: string[];
}

export interface InMemoryEdgeRuntimeConfig {
  tenantId: string;
  edgeId: string;
  /** The OPAQUE enrollment key id — must match the registered runtime. */
  keyId: string;
  /**
   * The enrollment key material — held ONLY here (customer-side) and in
   * the gateway's wiring-time signer. NEVER persisted by Aurum.
   */
  secretKey: string;
  localAllowlist: LocalAllowlistEntry[];
  /** secretRef → local secret material (values never cross the boundary). */
  localSecrets: Record<string, string>;
  /** Per-kind adapters; defaults to the deterministic doubles. */
  adapters?: Partial<Record<EdgeConnectivityKind, EdgeConnectivityAdapter>>;
  /** Negative-test mode: return a provider-native object as read state. */
  nativeStateObject?: boolean;
  /** The version this runtime reports in heartbeats. */
  version?: string;
}

// ---------------------------------------------------------------------------
// Boundary outcomes (recorded for test proofs)
// ---------------------------------------------------------------------------

/** Why the boundary refused an envelope (never silently swallowed). */
export interface EdgeBoundaryRefusal {
  jobId: string;
  stage: 'signature' | 'tenant' | 'edge' | 'expiry' | 'replayed-nonce' | 'allowlist' | 'secret-ref' | 'mode';
  reason: string;
}

/** One executed (or refused) envelope, with the submitted result. */
export interface EdgeExecutionRecord {
  jobId: string;
  capabilityKey: string;
  connectivity: EdgeConnectivityKind;
  secretRef: string | null;
  receiptStatus: EdgeReceiptStatus | null;
  refusal: EdgeBoundaryRefusal | null;
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export class InMemoryEdgeRuntime {
  private readonly signer: EdgeSigner;
  private readonly adapters: Record<EdgeConnectivityKind, EdgeConnectivityAdapter>;
  private readonly allowlistByKey = new Map<string, LocalAllowlistEntry>();
  private readonly consumedNonces = new Set<string>();
  /**
   * Per-instance unique tag for dial-home request nonces — real runtimes
   * must never reuse nonce material across processes/instances, or the
   * single-use channel would reject a fresh instance's first call.
   */
  private readonly instanceTag: string;
  private nonceCounter = 0;

  readonly executions: EdgeExecutionRecord[] = [];
  readonly boundaryRefusals: EdgeBoundaryRefusal[] = [];
  readonly pulledEnvelopes: SignedEdgeJobEnvelope[] = [];
  readonly submissionErrors: Array<{ jobId: string; code: string; message: string }> = [];
  nativeStateObject = false;
  readonly version: string;

  constructor(readonly config: InMemoryEdgeRuntimeConfig) {
    this.instanceTag = randomUUID().slice(0, 8);
    this.signer = createHmacSigner({ secretKeys: { [config.keyId]: config.secretKey } });
    this.adapters = {
      ...createDeterministicConnectivityAdapters(),
      ...(config.adapters ?? {}),
    };
    for (const entry of config.localAllowlist) {
      this.allowlistByKey.set(entry.capabilityKey, entry);
    }
    this.nativeStateObject = config.nativeStateObject ?? false;
    this.version = config.version ?? '1.0.0';
  }

  /** The runtime's own signer (customer-side key material). */
  get ownSigner(): EdgeSigner {
    return this.signer;
  }

  // -- the dial-home authentication -------------------------------------

  private nextAuth(): EdgeAuthentication {
    this.nonceCounter += 1;
    const requestNonce = `${this.config.tenantId.slice(0, 8)}-sim-${this.instanceTag}-${this.nonceCounter}`;
    return {
      tenantId: this.config.tenantId,
      edgeId: this.config.edgeId,
      requestNonce,
      proof: 'placeholder',
    };
  }

  private authFor(purpose: 'heartbeat' | 'pull' | 'submit'): EdgeAuthentication {
    const base = this.nextAuth();
    const proof = this.signer.sign(
      this.config.keyId,
      edgeAuthMaterial(purpose, {
        tenantId: base.tenantId,
        edgeId: base.edgeId,
        requestNonce: base.requestNonce,
      }),
    );
    return { ...base, proof };
  }

  // -- the three dial-home call shapes ----------------------------------

  /** Heartbeat: liveness + version/capability report. */
  async heartbeat(report?: {
    version?: string;
    capabilities?: EdgeConnectivityKind[];
    pendingJobs?: number;
  }): Promise<{ version: string }> {
    const result = await sendEdgeHeartbeat(this.authFor('heartbeat'), {
      version: report?.version ?? this.version,
      capabilities: report?.capabilities ?? null,
      pendingJobs: report?.pendingJobs ?? null,
    });
    return { version: result.heartbeat.reportedVersion };
  }

  /** Pull pending jobs and execute each pulled envelope exactly once. */
  async dialHomeOnce(): Promise<number> {
    const pulled = await pullPendingEdgeJobs(this.authFor('pull'), { limit: 1 });
    for (const signed of pulled.envelopes) {
      this.pulledEnvelopes.push(signed);
      await this.executeEnvelope(signed);
    }
    return pulled.envelopes.length;
  }

  /**
   * Execute one presented envelope through the FULL boundary discipline:
   * verify the signature with the runtime's own key, check tenant/edge
   * scope, refuse replayed nonces, enforce the LOCAL allowlist, resolve
   * the secret reference locally, dispatch the adapter, submit the
   * canonical result. Used by dialHomeOnce and directly by tests
   * (replay/forgery negative cases).
   */
  async executeEnvelope(signed: SignedEdgeJobEnvelope): Promise<EdgeExecutionRecord> {
    const envelope = signed.envelope;

    // 1. Signature — with the runtime's OWN key material, never Aurum's.
    if (!verifyEnvelopeSignature(envelope, signed.signature, this.signer)) {
      return this.refuse(envelope, 'signature', 'the envelope signature did not verify against the enrollment key this runtime holds');
    }
    // 2. Tenant scope — a foreign-tenant envelope is refused outright.
    if (envelope.tenantId !== this.config.tenantId) {
      return this.refuse(envelope, 'tenant', `the envelope is scoped to tenant '${envelope.tenantId}', not this runtime's tenant`);
    }
    // 3. Edge scope.
    if (envelope.edgeId !== this.config.edgeId) {
      return this.refuse(envelope, 'edge', `the envelope is addressed to edge '${envelope.edgeId}', not this runtime`);
    }
    // 4. Expiry.
    if (Date.parse(envelope.expiresAt) <= Date.now()) {
      return this.refuse(envelope, 'expiry', `the envelope expired at ${envelope.expiresAt}`);
    }
    // 5. Replay — the runtime's own consumed-nonce set.
    if (this.consumedNonces.has(envelope.nonce)) {
      return this.refuse(envelope, 'replayed-nonce', `nonce '${envelope.nonce}' was already consumed — replay refused at the boundary`);
    }
    // 6. Mode consistency (inspect exercises read.*, execute write.*).
    const expectedMode = envelope.capabilityKey.startsWith('read.') ? 'read' : 'write';
    const modeOfJob = envelope.kind === 'inspect' ? 'read' : 'write';
    if (expectedMode !== modeOfJob) {
      return this.refuse(envelope, 'mode', `a '${envelope.kind}' job cannot exercise capability '${envelope.capabilityKey}'`);
    }
    // 7. THE LOCAL ALLOWLIST — the edge's own boundary policy.
    const entry = this.allowlistByKey.get(envelope.capabilityKey);
    if (entry === undefined || entry.mode !== modeOfJob) {
      const record = this.record(envelope, null, null, {
        jobId: envelope.jobId,
        stage: 'allowlist',
        reason: `capability '${envelope.capabilityKey}' is not in this runtime's local allowlist — refused at the edge boundary`,
      });
      // A boundary refusal is an honest 'rejected' receipt back to Aurum
      // (denial is data, never a swallowed error).
      await this.submit(envelope, {
        receipt: {
          status: 'rejected',
          receiptId: null,
          detail: `capability '${envelope.capabilityKey}' refused at the edge boundary: not in the local allowlist`,
        },
        state: null,
      });
      return record;
    }
    // 8. Local secret resolution (values never leave the runtime).
    const secretMaterial = this.config.localSecrets[entry.secretRef];
    if (secretMaterial === undefined) {
      const record = this.record(envelope, entry.connectivity, null, {
        jobId: envelope.jobId,
        stage: 'secret-ref',
        reason: `secret reference '${entry.secretRef}' is not present in this runtime's local secret store`,
      });
      await this.submit(envelope, {
        receipt: {
          status: 'rejected',
          receiptId: null,
          detail: `local secret '${entry.secretRef}' could not be resolved at the edge boundary`,
        },
        state: null,
      });
      return record;
    }

    // Execute through the connectivity adapter (the secret material stays
    // local — only the opaque ref crosses the boundary into this method).
    const request: EdgeAdapterRequest = {
      connectivity: entry.connectivity,
      kind: envelope.kind,
      capabilityKey: envelope.capabilityKey,
      target: envelope.target,
      payload:
        envelope.payload !== null && envelope.payload !== undefined
          ? (envelope.payload as Record<string, unknown>)
          : null,
      secretRef: entry.secretRef,
      secretScopes: entry.secretScopes,
    };
    const adapter = this.adapters[entry.connectivity];
    let adapterResult: EdgeAdapterResult;
    if (adapter === undefined) {
      adapterResult = {
        receipt: {
          status: 'rejected',
          receiptId: null,
          detail: `no adapter wired for connectivity '${entry.connectivity}' on this runtime`,
        },
        state: null,
      };
    } else {
      adapterResult =
        envelope.kind === 'inspect' ? await adapter.inspect(request) : await adapter.execute(request);
    }

    this.consumedNonces.add(envelope.nonce);
    const result: EdgeJobResult =
      envelope.kind === 'inspect' && this.nativeStateObject
        ? {
            // A provider-native object (a Date instance) — NOT canonical
            // JSON; the boundary must reject it loudly.
            receipt: adapterResult.receipt,
            state: { found: true, state: new Date() } as unknown as { found: boolean; state: unknown },
          }
        : {
            receipt: adapterResult.receipt,
            state: adapterResult.state ?? null,
          };
    const record = this.record(envelope, entry.connectivity, entry.secretRef, null);
    record.receiptStatus = adapterResult.receipt.status;
    await this.submit(envelope, result);
    return record;
  }

  private async submit(envelope: EdgeJobEnvelope, result: EdgeJobResult): Promise<void> {
    try {
      await submitEdgeJobResult(this.authFor('submit'), { jobId: envelope.jobId, result });
    } catch (error) {
      // Submission failures (expired jobs, non-canonical results refused
      // by the gateway, auth problems) are recorded, never swallowed —
      // the honest-degradation discipline runs in both directions.
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      this.submissionErrors.push({ jobId: envelope.jobId, code, message });
    }
  }

  private refuse(
    envelope: EdgeJobEnvelope,
    stage: EdgeBoundaryRefusal['stage'],
    reason: string,
  ): EdgeExecutionRecord {
    // A forged/forged-tenant envelope is NOT executed and NOTHING is
    // submitted back for it — the runtime cannot trust it enough to even
    // report on it.
    return this.record(envelope, null, null, { jobId: envelope.jobId, stage, reason });
  }

  private record(
    envelope: EdgeJobEnvelope,
    connectivity: EdgeConnectivityKind | null,
    secretRef: string | null,
    refusal: EdgeBoundaryRefusal | null,
  ): EdgeExecutionRecord {
    const record: EdgeExecutionRecord = {
      jobId: envelope.jobId,
      capabilityKey: envelope.capabilityKey,
      connectivity: connectivity ?? 'private-api',
      secretRef,
      receiptStatus: null,
      refusal,
    };
    this.executions.push(record);
    if (refusal !== null) this.boundaryRefusals.push(refusal);
    return record;
  }
}

/** Factory (the house style — exported through the module contract). */
export function createInMemoryEdgeRuntime(config: InMemoryEdgeRuntimeConfig): InMemoryEdgeRuntime {
  return new InMemoryEdgeRuntime(config);
}
