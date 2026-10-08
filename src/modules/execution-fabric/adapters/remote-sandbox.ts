// The REMOTE-SANDBOX PATH adapter (W137 catalog path (c)) — an
// E2B-EQUIVALENT remote sandbox client behind the frozen W131 shape.
// Unlike the other two paths this adapter performs REAL network calls in
// production wiring — through an INJECTABLE transport (a narrow HTTP
// port): every request the adapter builds is a plain JSON envelope
// (method + URL + body) handed to the port, and the port decides what
// physically carries it. The repository's test suites inject a FAKE
// transport only — no test ever touches a network, and the adapter code
// itself never touches a secret VALUE: vendor credentials live in the
// production transport wrapper (the wiring closure that adds the
// Authorization header from the secret store), never in the envelopes
// this adapter builds (the W131/W082 discipline — credentials are
// created from opaque references only; discovery metadata carries
// non-sensitive strings only).
//
// The E2B-equivalent remote path this adapter speaks (documented, honest
// — no vendor SDK is imported; the wire shapes are the generic
// create/pause/resume/destroy sandbox protocol every remote-sandbox
// vendor in this class exposes):
//
//   POST   {base}/sandboxes            {resumeOf?: string}  → {sandboxId}
//   DELETE {base}/sandboxes/{id}                            → 204
//   GET    {base}/health                                    → {ok: true}
//
//   open()    → POST /sandboxes — mints a FRESH remote sandbox bound
//               to the isolated profile key derived from (tenant,
//               scope, subject) — the same derivation discipline as the
//               local-container and browser paths, so the three vendor
//               paths are interchangeable behind the definition.
//   resume()  → POST /sandboxes {resumeOf: prior-id} — a FRESH sandbox
//               continuing the prior one's paused state (the
//               resumption-token convention: '<session-id>@<cursor>' or
//               a bare sandbox id).
//   close()   → DELETE /sandboxes/{id} (sessions are disposable by
//               contract; the vendor reaps asynchronously).
//   probe()   → GET /health — the honest descriptor: 'available' when
//               the vendor answers, 'unavailable' otherwise. Remote
//               sandboxes declare filesystem, commands, network-egress,
//   display, artifact-store, session-persistence, checkpoint and
//   observation-capture supported; browser-profile is NOT (a remote
//   sandbox is a computer, not a governed browser — that is path (b)'s
//   declaration).
//
// Scriptable failures (openFailures/resumeFailures) model the vendor
// outage the service stamps onto the lease as 'failed' with the detail —
// honest failure evidence, never a fabricated success (the
// honest-descriptor law).

import { newId } from '@/infra/ids';
import type {
  ExecutionAdapterCapability,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentSession,
} from '@/modules/execution/contract';
import type { FabricAdapter, FabricAdapterSessionRequest } from '../types';

/**
 * THE INJECTABLE HTTP PORT — one narrow round-trip. Production wiring
 * wraps the platform fetch (adding vendor auth from the secret store and
 * timeouts); tests inject a fake. The adapter builds ONLY the envelope
 * below; no secret value ever appears in `headers` from adapter code.
 */
export type RemoteSandboxTransport = (request: {
  method: 'POST' | 'DELETE' | 'GET';
  url: string;
  headers: Record<string, string>;
  body: string | null;
}) => Promise<{ status: number; body: string }>;

/**
 * The real-fetch-backed default transport (production wiring only).
 * Adds the JSON content type and NO credential: the wiring closure that
 * constructs the adapter is expected to wrap this with vendor auth if
 * the deployment has one; the adapter never sees the token value.
 */
export async function fetchRemoteSandboxTransport(request: {
  method: 'POST' | 'DELETE' | 'GET';
  url: string;
  headers: Record<string, string>;
  body: string | null;
}): Promise<{ status: number; body: string }> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    throw new Error(`remote-sandbox transport unreachable: ${String(error)}`, {
      cause: error,
    });
  }
  return { status: response.status, body: await response.text() };
}

/** Typed transport failure — a non-2xx vendor answer or unreachable vendor. */
export class RemoteSandboxHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    bodyExcerpt: string,
  ) {
    super(`remote-sandbox vendor answered ${status} on ${url}: ${bodyExcerpt.slice(0, 200)}`);
    this.name = 'RemoteSandboxHttpError';
  }
}

/** Options of {@link createRemoteSandboxAdapter}. */
export interface RemoteSandboxAdapterOptions {
  /**
   * The vendor API base URL (e.g. 'https://api.sandbox-vendor.example').
   * No trailing slash; the adapter appends the path segments.
   */
  apiBaseUrl: string;
  /**
   * The injectable transport. Defaults to the real-fetch transport —
   * TESTS MUST INJECT A FAKE (the repository's suites never let this
   * default run).
   */
  transport?: RemoteSandboxTransport;
  adapterId?: string;
  displayName?: string;
  /** The declared network-egress policy of the remote sandbox (default 'restricted'). */
  networkEgress?: 'disabled' | 'restricted' | 'open';
  /** How many consecutive open() calls throw (the scriptable vendor outage). */
  openFailures?: number;
  /** How many consecutive resume() calls throw (the scriptable vendor outage). */
  resumeFailures?: number;
}

/** One tracked remote sandbox (kept after close for resumption). */
export interface RemoteSandboxRecord {
  sandboxId: string;
  profileKey: string;
  phase: 'live' | 'ended';
  resumeOf: string | null;
  openedAt: string;
  endedAt: string | null;
}

/** Read-only adapter state for proofs (the vendor side stays behind the port). */
export interface RemoteSandboxAdapterState {
  readonly sandboxes: readonly RemoteSandboxRecord[];
  readonly profileKeys: readonly string[];
  /**
   * Every request envelope the adapter built, in order — the proof
   * surface for the wire shape (method, URL, JSON body; NO credential
   * value ever appears here).
   */
  readonly requests: readonly {
    method: 'POST' | 'DELETE' | 'GET';
    url: string;
    body: string | null;
  }[];
  readonly openCalls: number;
  readonly resumeCalls: number;
  readonly closeCalls: number;
  readonly probeCalls: number;
}

/** The remote-sandbox adapter plus its read-only proof surface. */
export interface RemoteSandboxAdapter extends FabricAdapter {
  readonly state: RemoteSandboxAdapterState;
}

/** The isolated profile key (the shared three-path derivation discipline). */
function remoteProfileKeyOf(request: FabricAdapterSessionRequest): string {
  if (request.profileScope === 'session') {
    return `remote:tenant:${request.tenantId}:session`;
  }
  if (request.profileScope === 'task') {
    return `remote:tenant:${request.tenantId}:subject:${request.subjectRef ?? 'unscoped'}`;
  }
  return `remote:tenant:${request.tenantId}:environment`;
}

/**
 * The E2B-equivalent remote-sandbox adapter behind the frozen W131
 * shape. Vendor identity is METADATA on the descriptor and appears
 * nowhere in any domain record; the wire protocol is the generic
 * create/resume/destroy sandbox protocol, so swapping the vendor is a
 * base-URL + transport change — the domain contracts are untouched
 * (the vendor-removal clause).
 */
export function createRemoteSandboxAdapter(
  options: RemoteSandboxAdapterOptions,
): RemoteSandboxAdapter {
  const adapterId = options.adapterId ?? 'remote-sandbox-1';
  const displayName = options.displayName ?? 'Remote sandbox (E2B-equivalent)';
  const networkEgress = options.networkEgress ?? 'restricted';
  const transport: RemoteSandboxTransport = options.transport ?? fetchRemoteSandboxTransport;
  const base = options.apiBaseUrl.replace(/\/+$/, '');

  const sandboxes = new Map<string, RemoteSandboxRecord>();
  const requests: { method: 'POST' | 'DELETE' | 'GET'; url: string; body: string | null }[] = [];
  let openCalls = 0;
  let resumeCalls = 0;
  let closeCalls = 0;
  let probeCalls = 0;
  let openFailures = options.openFailures ?? 0;
  let resumeFailures = options.resumeFailures ?? 0;

  const capabilities: ExecutionAdapterCapability[] = [
    { domain: 'filesystem', supported: true },
    { domain: 'commands', supported: true },
    { domain: 'network-egress', supported: true, limits: { policy: networkEgress } },
    { domain: 'display', supported: true },
    { domain: 'browser-profile', supported: false },
    { domain: 'artifact-store', supported: true },
    { domain: 'session-persistence', supported: true, limits: { scope: 'vendor sandbox pause/resume' } },
    { domain: 'checkpoint', supported: true },
    { domain: 'observation-capture', supported: true },
  ];

  const JSON_HEADERS = { 'content-type': 'application/json' } as const;

  function sessionOf(
    sandboxId: string,
    profileKey: string,
    openedAt: Date,
  ): ExecutionEnvironmentSession {
    return {
      sessionId: sandboxId,
      adapterId,
      phase: 'live',
      openedAt: openedAt.toISOString(),
      isolation: {
        tenantIsolated: true,
        profileScope: 'task',
        networkEgress,
        credentialHandling: 'opaque-ref-only',
      },
      persistence: {
        survivesRestart: true,
        checkpoint: 'durable-checkpoint',
        persistentScope: profileKey,
      },
      artifacts: [],
    };
  }

  /** One vendor round-trip: the envelope is logged, the answer enforced. */
  async function call(
    method: 'POST' | 'DELETE' | 'GET',
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<{ status: number; parsed: unknown }> {
    const url = `${base}${path}`;
    const serialized = body === null ? null : JSON.stringify(body);
    requests.push({ method, url, body: serialized });
    const headers: Record<string, string> = { ...JSON_HEADERS };
    const response = await transport({ method, url, headers, body: serialized });
    if (response.status < 200 || response.status >= 300) {
      throw new RemoteSandboxHttpError(response.status, url, response.body);
    }
    let parsed: unknown = null;
    if (response.body.length > 0) {
      try {
        parsed = JSON.parse(response.body) as unknown;
      } catch {
        throw new RemoteSandboxHttpError(response.status, url, 'non-JSON vendor answer');
      }
    }
    return { status: response.status, parsed };
  }

  function requireSandboxId(parsed: unknown, url: string): string {
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { sandboxId?: unknown }).sandboxId !== 'string' ||
      (parsed as { sandboxId: string }).sandboxId.length === 0
    ) {
      throw new RemoteSandboxHttpError(200, url, 'vendor answer carried no sandboxId');
    }
    return (parsed as { sandboxId: string }).sandboxId;
  }

  return {
    adapterId,
    kind: 'remote-sandbox',

    async probe(): Promise<ExecutionEnvironmentDescriptor> {
      probeCalls += 1;
      // The honest-descriptor law: an unreachable vendor is REPORTED
      // ('unavailable'), never fabricated as healthy and never thrown —
      // the fabric surfaces the declaration. A test scripts the outage
      // through the fake transport's failure queue.
      let healthy = true;
      try {
        await call('GET', '/health', null);
      } catch {
        healthy = false;
      }
      return {
        adapterId,
        kind: 'remote-sandbox',
        displayName,
        vendor: {
          vendorName: 'aurum-remote-sandbox-port',
          vendorProduct: 'E2B-equivalent remote sandbox (generic wire protocol)',
          vendorAdapterVersion: '1',
        },
        capabilities,
        health: healthy ? 'available' : 'unavailable',
      };
    },

    async open(request: FabricAdapterSessionRequest): Promise<ExecutionEnvironmentSession> {
      openCalls += 1;
      if (openFailures > 0) {
        openFailures -= 1;
        throw new Error(`remote-sandbox: provision failure #${openCalls} (scripted outage)`);
      }
      const profileKey = remoteProfileKeyOf(request);
      const { parsed } = await call('POST', '/sandboxes', {});
      const sandboxId = requireSandboxId(parsed, `${base}/sandboxes`);
      const openedAt = new Date();
      sandboxes.set(sandboxId, {
        sandboxId,
        profileKey,
        phase: 'live',
        resumeOf: null,
        openedAt: openedAt.toISOString(),
        endedAt: null,
      });
      return sessionOf(sandboxId, profileKey, openedAt);
    },

    async resume(checkpointRef: string): Promise<ExecutionEnvironmentSession> {
      resumeCalls += 1;
      if (resumeFailures > 0) {
        resumeFailures -= 1;
        throw new Error(`remote-sandbox: resume failure #${resumeCalls} (scripted outage)`);
      }
      // The resumption-token convention: '<session-id>@<cursor>' or a
      // bare sandbox id names the vendor sandbox the fresh one continues.
      const priorId = checkpointRef.split('@', 1)[0]!;
      const prior = sandboxes.get(priorId);
      if (prior === undefined) {
        throw new Error(
          `remote-sandbox: no sandbox '${priorId}' to resume from (unknown checkpoint ref)`,
        );
      }
      const { parsed } = await call('POST', '/sandboxes', { resumeOf: priorId });
      const sandboxId = requireSandboxId(parsed, `${base}/sandboxes`);
      const openedAt = new Date();
      sandboxes.set(sandboxId, {
        sandboxId,
        profileKey: prior.profileKey,
        phase: 'live',
        resumeOf: priorId,
        openedAt: openedAt.toISOString(),
        endedAt: null,
      });
      return sessionOf(sandboxId, prior.profileKey, openedAt);
    },

    async close(sessionId: string, reason: string): Promise<ExecutionEnvironmentSession> {
      closeCalls += 1;
      const record = sandboxes.get(sessionId);
      if (record === undefined) {
        throw new Error(`remote-sandbox: unknown session '${sessionId}'`);
      }
      await call('DELETE', `/sandboxes/${encodeURIComponent(sessionId)}`, null);
      if (record.phase !== 'ended') {
        record.phase = 'ended';
        record.endedAt = new Date().toISOString();
        // The fabric's reason (release/cancel/fail) is retained in the
        // DOMAIN evidence tail; the vendor wire carries only the idempotent
        // destroy (the shared adapter close ruling).
        void reason;
      }
      return {
        sessionId,
        adapterId,
        phase: 'ended',
        openedAt: record.openedAt,
        endedAt: record.endedAt ?? undefined,
        isolation: {
          tenantIsolated: true,
          profileScope: 'task',
          networkEgress,
          credentialHandling: 'opaque-ref-only',
        },
        persistence: {
          survivesRestart: true,
          checkpoint: 'durable-checkpoint',
          persistentScope: record.profileKey,
        },
        artifacts: [],
      };
    },

    state: {
      get sandboxes(): readonly RemoteSandboxRecord[] {
        return [...sandboxes.values()];
      },
      get profileKeys(): readonly string[] {
        return [...new Set([...sandboxes.values()].map((entry) => entry.profileKey))];
      },
      get requests(): readonly {
        method: 'POST' | 'DELETE' | 'GET';
        url: string;
        body: string | null;
      }[] {
        return requests;
      },
      get openCalls(): number {
        return openCalls;
      },
      get resumeCalls(): number {
        return resumeCalls;
      },
      get closeCalls(): number {
        return closeCalls;
      },
      get probeCalls(): number {
        return probeCalls;
      },
    },
  };
}

/**
 * The fake transport the fabric's own proofs run against — NEVER a real
 * network call (exported so the service suite and any consumer's suite
 * share the exact same double). Deterministic: every create mints
 * `rsb-<n>` in call order; health answers ok; destroy answers 204.
 */
export function createFakeRemoteSandboxTransport(options: {
  /** Scripted non-2xx answers per path prefix, consumed in order. */
  failures?: { pathIncludes: string; status: number; body: string }[];
} = {}): RemoteSandboxTransport & {
  /** The fake's own request log (shared shape with the adapter's view). */
  readonly seen: readonly { method: string; url: string; body: string | null }[];
} {
  const seen: { method: string; url: string; body: string | null }[] = [];
  let counter = 0;
  const failures = [...(options.failures ?? [])];
  return Object.assign(
    async (request: {
      method: 'POST' | 'DELETE' | 'GET';
      url: string;
      headers: Record<string, string>;
      body: string | null;
    }): Promise<{ status: number; body: string }> => {
      seen.push({ method: request.method, url: request.url, body: request.body });
      const scripted = failures.findIndex((entry) => request.url.includes(entry.pathIncludes));
      if (scripted >= 0) {
        const [entry] = failures.splice(scripted, 1);
        return { status: entry!.status, body: entry!.body };
      }
      if (request.method === 'GET' && request.url.endsWith('/health')) {
        return { status: 200, body: JSON.stringify({ ok: true }) };
      }
      if (request.method === 'POST' && request.url.endsWith('/sandboxes')) {
        counter += 1;
        return { status: 201, body: JSON.stringify({ sandboxId: `rsb-${counter}-${newId()}` }) };
      }
      if (request.method === 'DELETE' && request.url.includes('/sandboxes/')) {
        return { status: 204, body: '' };
      }
      return { status: 404, body: JSON.stringify({ error: 'unknown remote-sandbox route' }) };
    },
    {
      get seen(): readonly { method: string; url: string; body: string | null }[] {
        return seen;
      },
    },
  );
}
