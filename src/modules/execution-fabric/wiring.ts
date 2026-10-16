// PRODUCTION WIRING CLOSURES (the W137 real-drivers opt-in, 2026-10-15)
// — the two closures that put REAL drivers behind this fabric's two
// remote-seam adapter paths. The W141 record honestly classified them as
// next steps ("Real Playwright/Chromium + E2B remote-sandbox execution of
// the W137 adapters: the certified surface is the adapter contracts +
// deterministic doubles; real-driver evaluation documented as next steps"
// — spec/evidence/W141-CERTIFICATION-2026-10-08.md §5); these closures are
// that evaluation's production wiring, delivered ADDITIVELY:
//
//   1. `wirePlaywrightBrowserAdapter` (path b) — injects W110's REAL
//      Playwright/Chromium driver (`createPlaywrightBrowserDriver`, the
//      repository's already-reviewed browser runtime, consumed through
//      the computer-use CONTRACT only) into `createBrowserEnvironmentAdapter`
//      through the existing `driver: BrowserDriver` port. NOTHING about the
//      adapter changes: the closure constructs the port's production
//      implementation and hands it over, exactly the wiring the adapter's
//      own header documents ("production wiring is W110's
//      createPlaywrightBrowserDriver or an approved W088 edge adapter").
//      The governed allowlist is still handed to the driver at every session
//      start and re-checked driver-side (the W088 twice-checked discipline
//      — unchanged); the closure returns the driver handle alongside the
//      adapter so the composition root can close the shared engine at
//      shutdown (`driver.close()` is deliberately NOT part of the port).
//
//   2. `createE2BRemoteSandboxTransport` (path c) — the REAL E2B REST API
//      behind the injectable transport port of `createRemoteSandboxAdapter`.
//      The adapter keeps its documented GENERIC wire untouched
//      (POST/DELETE `/sandboxes[/{id}]`, GET `/health`); THIS closure owns
//      every vendor-specific adaptation — auth header, real URLs, request
//      and response body shapes, per-round-trip timeouts:
//
//        generic  GET    {apiBaseUrl}/health                → E2B `GET  /v2/sandboxes`   (X-API-Key; a 200 proves the vendor answers AND the credential authenticates — E2B exposes no unauthenticated platform health probe, so the authenticated list read is the honest stand-in)
//        generic  POST   {apiBaseUrl}/sandboxes  {}         → E2B `POST /sandboxes`      (X-API-Key; body `{templateID, timeout}`; 201 `{sandboxID, envdAccessToken}` — the answer is rewritten to the adapter's documented `{sandboxId}` shape)
//        generic  POST   {apiBaseUrl}/sandboxes  {resumeOf} → E2B `POST /sandboxes/{id}/resume` (X-API-Key; 201 — E2B resumes the SAME sandbox id, the vendor's documented resume semantics)
//        generic  DELETE {apiBaseUrl}/sandboxes/{id}         → E2B `DELETE /sandboxes/{id}` (X-API-Key; 204)
//
//      VENDOR AUTH (the W082 law, binding): the key comes from `E2B_API_KEY`
//      in the environment (or an explicitly injected value for wiring
//      tests) — NEVER hardcoded, and the key VALUE never crosses into the
//      adapter, any domain record or any log the closure keeps. The closure
//      also retains each opened sandbox's `envdAccessToken` (driver-side
//      only, straight from the vendor's create answer) and exposes
//      `runCommand()` — ONE command executed through E2B's documented envd
//      Connect protocol (`POST sandbox.e2b.app/process.Process/Start`,
//      Connect-framed JSON) — so a wiring test can prove a REAL command
//      round-trip inside a REAL sandbox without importing any vendor SDK.
//      The envd token is dropped when the sandbox is destroyed.
//
// Both closures are wiring artifacts, not domain state (the W131 law): the
// fabric resolves adapters at acquisition by KIND + capability declaration
// only, and no vendor name rides in any definition, lease, event, artifact,
// evidence record or checkpoint. The hermetic battery keeps running the
// deterministic doubles (`createFakeRemoteSandboxTransport`, the scripted
// browser driver) — NOTHING is wired by default; the real drivers are
// constructed exactly where a caller (app composition / a LIVE suite)
// invokes these closures.

import { envString } from '@/infra/config';
import {
  createPlaywrightBrowserDriver,
  type BrowserAllowlist,
  type PlaywrightBrowserDriver,
  type PlaywrightBrowserDriverOptions,
} from '@/modules/computer-use/contract';
import { createBrowserEnvironmentAdapter } from './adapters/browser-adapter';
import type { BrowserEnvironmentAdapter } from './adapters/browser-adapter';
import type { RemoteSandboxTransport } from './adapters/remote-sandbox';

// ---------------------------------------------------------------------------
// Path (b) — the real Playwright/Chromium browser wiring closure
// ---------------------------------------------------------------------------

/** Options of {@link wirePlaywrightBrowserAdapter}. */
export interface WirePlaywrightBrowserAdapterOptions {
  /**
   * The frozen governed-automation allowlist handed to the driver at every
   * session start (re-checked driver-side — the W088 twice-checked
   * discipline). Production wiring chooses this; the fabric only carries it.
   */
  allowlist: BrowserAllowlist;
  /**
   * W110 driver configuration (headless mode, profile/artifact stores,
   * timeouts). Its own environment block (BROWSER_CREDENTIALS,
   * BROWSER_ARTIFACT_DIR, BROWSER_PROFILE_DIR, BROWSER_HEADLESS,
   * BROWSER_ACTION_TIMEOUT_MS) stays honored for every field left unset.
   */
  driverOptions?: PlaywrightBrowserDriverOptions;
  adapterId?: string;
  displayName?: string;
}

/** The browser wiring: the fabric adapter plus the real driver handle it composes. */
export interface PlaywrightBrowserFabricWiring {
  /** The browser-path adapter behind the frozen W131 shape — register this through the fabric wiring seam. */
  readonly adapter: BrowserEnvironmentAdapter;
  /** The REAL W110 Playwright driver behind the port (engine version + recording surfaces are its evidence). */
  readonly driver: PlaywrightBrowserDriver;
}

/**
 * The browser path's production wiring closure: W110's REAL
 * Playwright/Chromium driver injected through the existing BrowserDriver
 * port of {@link createBrowserEnvironmentAdapter}. Additive wiring only —
 * the adapter's public behavior, the frozen SPI and the certified surfaces
 * are untouched; the closure just constructs the port's production
 * implementation and hands it over. The composition root owns the shared
 * engine's lifetime (`driver.close()` at shutdown — deliberately outside
 * the port).
 */
export function wirePlaywrightBrowserAdapter(
  options: WirePlaywrightBrowserAdapterOptions,
): PlaywrightBrowserFabricWiring {
  const driver = createPlaywrightBrowserDriver(options.driverOptions);
  const adapter = createBrowserEnvironmentAdapter({
    driver,
    allowlist: options.allowlist,
    adapterId: options.adapterId,
    displayName: options.displayName,
  });
  return { adapter, driver };
}

// ---------------------------------------------------------------------------
// Path (c) — the real E2B remote-sandbox transport closure
// ---------------------------------------------------------------------------

/** Options of {@link createE2BRemoteSandboxTransport}. */
export interface E2BTransportOptions {
  /**
   * The vendor API key. When omitted the closure reads `E2B_API_KEY` from
   * the environment — the ONLY credential channel; a missing key refuses
   * loudly at construction (a wiring defect must never look like "no
   * vendor"), never a guessed key.
   */
  apiKey?: string;
  /** The E2B platform API base URL (default `https://api.e2b.app`, no trailing slash). */
  apiBaseUrl?: string;
  /** The template the closure creates sandboxes from (default `base`). */
  templateId?: string;
  /** The sandbox time-to-live in seconds E2B is asked for at create (default 300). */
  sandboxTimeoutSeconds?: number;
  /** Per-round-trip timeout in ms (default 30000) — production wiring adds the timeout the adapter never presumes. */
  requestTimeoutMs?: number;
  /** The envd shared sandbox host (default `https://sandbox.e2b.app`). */
  envdBaseUrl?: string;
  /** The envd port inside the sandbox (default 49983 — E2B's documented default). */
  envdPort?: number;
  /** Injectable fetch (tests; default the platform fetch). */
  fetchImpl?: typeof fetch;
}

/** One executed command's honest result (the envd Connect round-trip). */
export interface E2BCommandResult {
  cmd: string;
  args: string[];
  /** The process's exit code (null when the vendor answer carried none). */
  exitCode: number | null;
  exited: boolean;
  stdout: string;
  stderr: string;
  latencyMs: number;
}

/** One logged E2B round-trip (the closure's read-only evidence surface — no bodies, no secrets). */
export interface E2BTransportLogEntry {
  method: 'POST' | 'DELETE' | 'GET';
  url: string;
  status: number;
  latencyMs: number;
  /** Which generic-wire operation caused the round-trip (plus runCommand entries). */
  purpose: 'health' | 'create' | 'resume' | 'destroy' | 'run-command';
}

/** The envd Connect frame payload for one process start (E2B's documented wire). */
interface E2BStartRequest {
  process: { cmd: string; args?: string[]; envs?: Record<string, string>; cwd?: string | null };
  stdin: boolean;
}

/** The event stream shapes of `process.Process/Start` (E2B's documented wire). */
type E2BProcessEvent =
  | { start: { pid: number } }
  | { data: { stdout?: string; stderr?: string; pty?: string } }
  | { end: { exitCode?: number; exited?: boolean; status?: string; error?: string | null } }
  | { keepalive: Record<string, never> };

/**
 * The remote-sandbox path's production transport closure: the REAL E2B REST
 * API behind the injectable transport port. The adapter's generic wire is
 * adapted HERE and ONLY here (headers/auth/URLs/body shapes/timeouts); the
 * adapter and its certified contracts are untouched. The returned transport
 * carries `runCommand` (a REAL command inside a sandbox THIS transport
 * opened, through E2B's documented envd Connect protocol — no vendor SDK)
 * and a read-only `log` of every E2B round-trip (method, url, status,
 * latency — never a body, never a secret).
 */
export function createE2BRemoteSandboxTransport(
  options: E2BTransportOptions = {},
): RemoteSandboxTransport & {
  /** Runs ONE command in a sandbox this transport opened (envd Connect protocol). */
  readonly runCommand: (
    sandboxId: string,
    command: { cmd: string; args?: string[] },
  ) => Promise<E2BCommandResult>;
  /** Every E2B round-trip this closure made, in order (no bodies, no secrets). */
  readonly log: readonly E2BTransportLogEntry[];
  /** The sandbox ids this closure currently tracks as open (cleanup sweep surface). */
  readonly openSandboxIds: readonly string[];
  /** Best-effort destroy of every tracked sandbox (the cleanup sweep). */
  readonly sweepOpenSandboxes: () => Promise<void>;
} {
  const apiKey = options.apiKey ?? envString('E2B_API_KEY');
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error(
      'E2B transport wiring refused: no API key (set E2B_API_KEY in the environment or pass apiKey explicitly) — the production transport never guesses credentials',
    );
  }
  const apiBase = (options.apiBaseUrl ?? 'https://api.e2b.app').replace(/\/+$/, '');
  const envdBase = (options.envdBaseUrl ?? 'https://sandbox.e2b.app').replace(/\/+$/, '');
  const templateId = options.templateId ?? 'base';
  const timeoutSeconds = options.sandboxTimeoutSeconds ?? 300;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const envdPort = options.envdPort ?? 49983;
  const doFetch = options.fetchImpl ?? fetch;

  // Driver-side only: the envd access token of every sandbox this closure
  // opened (straight from the vendor's create answer; never handed back
  // through the transport port, dropped at destroy).
  const envdTokens = new Map<string, string>();
  const log: E2BTransportLogEntry[] = [];

  async function roundTrip(
    method: 'POST' | 'DELETE' | 'GET',
    url: string,
    init: { headers?: Record<string, string>; body?: string; purpose: E2BTransportLogEntry['purpose'] },
  ): Promise<{ status: number; body: string; latencyMs: number }> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      log.push({ method, url, status: 0, latencyMs: Date.now() - startedAt, purpose: init.purpose });
      throw new Error(`E2B transport round-trip unreachable: ${String(error)}`, { cause: error });
    }
    const body = await response.text();
    log.push({
      method,
      url,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      purpose: init.purpose,
    });
    return { status: response.status, body, latencyMs: Date.now() - startedAt };
  }

  /** The vendor's create/resume answer rewritten to the adapter's `{sandboxId}` shape (the ONLY response rewrite). */
  function toGenericSandboxBody(vendorBody: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(vendorBody) as unknown;
    } catch {
      return vendorBody; // a non-JSON vendor answer fails the adapter's own guard
    }
    const vendorId =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { sandboxID?: unknown }).sandboxID
        : undefined;
    if (typeof vendorId !== 'string' || vendorId.length === 0) return vendorBody;
    // The envd access token stays driver-side — it never crosses the port.
    const envdToken = (parsed as { envdAccessToken?: unknown }).envdAccessToken;
    envdTokens.set(vendorId, typeof envdToken === 'string' ? envdToken : '');
    return JSON.stringify({ sandboxId: vendorId });
  }

  const transport: RemoteSandboxTransport = async (request) => {
    const authHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'X-API-Key': apiKey,
    };
    // The generic wire, adapted per operation — everything vendor-specific
    // lives in THIS closure:
    if (request.method === 'GET' && request.url.endsWith('/health')) {
      // E2B exposes no unauthenticated platform health probe; the
      // authenticated empty-page sandbox listing is the honest stand-in (a
      // 200 proves the vendor answers AND the credential authenticates).
      const answer = await roundTrip('GET', `${apiBase}/v2/sandboxes`, {
        headers: authHeaders,
        purpose: 'health',
      });
      return answer;
    }
    if (request.method === 'POST' && request.url.endsWith('/sandboxes')) {
      let resumeOf: string | undefined;
      try {
        const parsed = JSON.parse(request.body ?? '{}') as { resumeOf?: unknown };
        if (typeof parsed.resumeOf === 'string' && parsed.resumeOf.length > 0) {
          resumeOf = parsed.resumeOf;
        }
      } catch {
        /* an unparseable create envelope is answered by the vendor's own 4xx */
      }
      if (resumeOf === undefined) {
        // open: a FRESH sandbox from the configured template.
        const answer = await roundTrip('POST', `${apiBase}/sandboxes`, {
          headers: authHeaders,
          body: JSON.stringify({ templateID: templateId, timeout: timeoutSeconds }),
          purpose: 'create',
        });
        return { status: answer.status, body: toGenericSandboxBody(answer.body) };
      }
      // resume: E2B's documented resume semantics — the SAME sandbox id
      // unpauses (the resumption-token convention still names it).
      const answer = await roundTrip(
        'POST',
        `${apiBase}/sandboxes/${encodeURIComponent(resumeOf)}/resume`,
        { headers: authHeaders, body: JSON.stringify({}), purpose: 'resume' },
      );
      return { status: answer.status, body: toGenericSandboxBody(answer.body) };
    }
    if (request.method === 'DELETE') {
      const id = request.url.slice(request.url.lastIndexOf('/sandboxes/') + 11);
      const answer = await roundTrip('DELETE', `${apiBase}/sandboxes/${encodeURIComponent(id)}`, {
        headers: authHeaders,
        purpose: 'destroy',
      });
      envdTokens.delete(id);
      return answer;
    }
    return { status: 404, body: JSON.stringify({ error: 'unsupported generic-wire operation' }) };
  };

  /** Decodes E2B's Connect framing: flags byte + big-endian u32 length + payload, repeated. */
  function* decodeConnectFrames(bytes: Uint8Array): Generator<{ flags: number; payload: string }> {
    let offset = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 5 <= bytes.length) {
      const flags = bytes[offset]!;
      const length = view.getUint32(offset + 1);
      if (offset + 5 + length > bytes.length) break;
      yield {
        flags,
        payload: new TextDecoder().decode(bytes.subarray(offset + 5, offset + 5 + length)),
      };
      offset += 5 + length;
    }
  }

  async function runCommand(
    sandboxId: string,
    command: { cmd: string; args?: string[] },
  ): Promise<E2BCommandResult> {
    const token = envdTokens.get(sandboxId);
    if (token === undefined) {
      throw new Error(
        `E2B runCommand refused: sandbox '${sandboxId}' was not opened by this transport (no retained envd access token)`,
      );
    }
    const startedAt = Date.now();
    const payload: E2BStartRequest = {
      process: { cmd: command.cmd, args: command.args ?? [] },
      stdin: false,
    };
    const json = JSON.stringify(payload);
    const frame = new Uint8Array(5 + json.length);
    frame[0] = 0; // flags: an uncompressed unary request frame
    new DataView(frame.buffer).setUint32(1, json.length);
    frame.set(new TextEncoder().encode(json), 5);
    const response = await doFetch(`${envdBase}/process.Process/Start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/connect+json',
        'connect-protocol-version': '1',
        'connect-timeout-ms': String(requestTimeoutMs),
        'E2b-Sandbox-Id': sandboxId,
        'E2b-Sandbox-Port': String(envdPort),
        'X-Access-Token': token,
      },
      body: frame,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const stream = new Uint8Array(await response.arrayBuffer());
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let exited = false;
    for (const frameEvent of decodeConnectFrames(stream)) {
      if (frameEvent.flags !== 0) continue; // the end-stream frame carries trailers, not events
      let inner: E2BProcessEvent | undefined;
      try {
        inner = (JSON.parse(frameEvent.payload) as { event?: E2BProcessEvent }).event;
      } catch {
        continue;
      }
      if (inner === undefined) continue;
      if ('data' in inner) {
        if (typeof inner.data.stdout === 'string') {
          stdout += Buffer.from(inner.data.stdout, 'base64').toString('utf8');
        }
        if (typeof inner.data.stderr === 'string') {
          stderr += Buffer.from(inner.data.stderr, 'base64').toString('utf8');
        }
      }
      if ('end' in inner) {
        exited = inner.end.exited ?? exited;
        if (typeof inner.end.exitCode === 'number') {
          exitCode = inner.end.exitCode;
        } else if (exitCode === null && typeof inner.end.status === 'string') {
          // The vendor's documented end-event shape may omit the numeric
          // exitCode and carry only the go-runtime status string
          // (observed: "exit status 0") — parse it, closure-side.
          const statusMatch = /^exit status (\d+)$/.exec(inner.end.status.trim());
          if (statusMatch !== null) exitCode = Number(statusMatch[1]);
        }
      }
    }
    const latencyMs = Date.now() - startedAt;
    log.push({
      method: 'POST',
      url: `${envdBase}/process.Process/Start`,
      status: response.status,
      latencyMs,
      purpose: 'run-command',
    });
    if (response.status !== 200) {
      throw new Error(
        `E2B runCommand failed: envd answered ${response.status} on ${envdBase}/process.Process/Start`,
      );
    }
    return { cmd: command.cmd, args: command.args ?? [], exitCode, exited, stdout, stderr, latencyMs };
  }

  const sweepOpenSandboxes = async (): Promise<void> => {
    for (const sandboxId of [...envdTokens.keys()]) {
      try {
        await roundTrip('DELETE', `${apiBase}/sandboxes/${encodeURIComponent(sandboxId)}`, {
          headers: { 'content-type': 'application/json', 'X-API-Key': apiKey },
          purpose: 'destroy',
        });
      } catch {
        /* best effort — the sweep never masks the run's own verdicts */
      }
      envdTokens.delete(sandboxId);
    }
  };

  return Object.assign(transport, {
    runCommand,
    sweepOpenSandboxes,
    get log(): readonly E2BTransportLogEntry[] {
      return log;
    },
    get openSandboxIds(): readonly string[] {
      return [...envdTokens.keys()];
    },
  });
}
