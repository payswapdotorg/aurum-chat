// The BROWSER PATH adapter (W137 catalog path (b)) — a typed adapter
// that drives a governed browser through the W093/W110 BrowserDriver
// PORT (computer-use's provider-neutral exit seam, consumed here
// type-only through its contract — the fabric WRAPS the port, it never
// duplicates browser authority; computer-use stays the one owner of
// governed browser automation).
//
// In production wiring the port is served by the repository's real
// Playwright/chromium adapter (W110's `createPlaywrightBrowserDriver`,
// exported through the computer-use contract) or an approved edge
// browser adapter (W088); this adapter maps the frozen W131
// ExecutionAdapter shape onto that port:
//
//   open()    → driver.startSession — the ISOLATED browser profile key
//               is minted from (tenant, subject, scope): per TENANT
//               always; per SUBJECT (the fabric lease) when the
//               declared scope is 'task' (the W093 per-(tenant,task)
//               discipline); shared across the tenant's sessions when
//               'environment'. The OPAQUE credentialRef passes straight
//               through for LOCAL driver-side materialization — a
//               secret VALUE never crosses this boundary.
//   resume()  → driver.startSession on the SAME isolated profile key
//               (the port's persistent per-profile storage state is the
//               browser continuity) — a FRESH disposable session bound
//               to the profile the checkpoint ref names (the
//               resumption-token convention: '<session-id>@<cursor>').
//   close()   → driver.endSession (sessions are disposable by contract).
//   probe()   → the honest descriptor: browser-profile, observation-
//               capture, artifact-store, session-persistence, checkpoint
//               and display supported; filesystem and commands NOT
//               (supported:false — the honest-descriptor law); network
//               egress governed by the wired allowlist.
//
// THE TEST SUITE NEVER LAUNCHES REAL CHROME: the driver seam is
// injected (a fake driver in the fabric's suite; the scripted
// deterministic double `createScriptedBrowserDriver` remains the
// repository's test-suite default through the computer-use contract).
// The one-time real-browser execution remains W110's recorded evidence
// run (docs/productization-evidence/W110/) — this adapter composes the
// same port, it does not re-certify the browser runtime.

import type {
  ExecutionAdapterCapability,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentSession,
} from '@/modules/execution/contract';
import type {
  BrowserAllowlist,
  BrowserDriver,
} from '@/modules/computer-use/contract';
import type { FabricAdapter, FabricAdapterSessionRequest } from '../types';

/** Options of {@link createBrowserEnvironmentAdapter}. */
export interface BrowserEnvironmentAdapterOptions {
  /** The W093/W110 BrowserDriver port instance this adapter drives (Playwright in production wiring; a fake/double in tests). */
  driver: BrowserDriver;
  /** The frozen governed-automation allowlist handed to the driver at every session start (re-checked driver-side — the W088 twice-checked discipline). */
  allowlist: BrowserAllowlist;
  adapterId?: string;
  displayName?: string;
  /** How many consecutive open() calls throw (the scriptable vendor failure). */
  openFailures?: number;
  /** How many consecutive resume() calls throw (the scriptable vendor failure). */
  resumeFailures?: number;
}

/** Read-only adapter state for proofs (the provider side stays behind the seam). */
export interface BrowserAdapterState {
  readonly startedSessions: readonly { sessionKey: string; profileKey: string; credentialRef: string | null }[];
  readonly endedSessions: readonly { sessionKey: string; reason: string }[];
  readonly profileKeys: readonly string[];
  readonly openCalls: number;
  readonly resumeCalls: number;
  readonly closeCalls: number;
}

/** The browser adapter plus its read-only proof surface. */
export interface BrowserEnvironmentAdapter extends FabricAdapter {
  readonly state: BrowserAdapterState;
}

/** The isolated browser profile key (the W093 discipline: per tenant AND per subject). */
function browserProfileKeyOf(request: FabricAdapterSessionRequest): string {
  if (request.profileScope === 'session') {
    return `browser:tenant:${request.tenantId}:session`;
  }
  if (request.profileScope === 'task') {
    return `browser:tenant:${request.tenantId}:subject:${request.subjectRef ?? 'unscoped'}`;
  }
  return `browser:tenant:${request.tenantId}:environment`;
}

/**
 * The browser-path adapter behind the frozen W131 shape. Vendor
 * identity is METADATA on the descriptor (the port's driver decides
 * the concrete browser) and appears nowhere in any domain record.
 */
export function createBrowserEnvironmentAdapter(
  options: BrowserEnvironmentAdapterOptions,
): BrowserEnvironmentAdapter {
  const adapterId = options.adapterId ?? 'browser-env-1';
  const displayName = options.displayName ?? 'Governed browser environment';
  const driver = options.driver;

  const startedSessions: { sessionKey: string; profileKey: string; credentialRef: string | null }[] =
    [];
  const endedSessions: { sessionKey: string; reason: string }[] = [];
  const resumeProfileKeys: string[] = [];
  let openCalls = 0;
  let resumeCalls = 0;
  let closeCalls = 0;
  let openFailures = options.openFailures ?? 0;
  let resumeFailures = options.resumeFailures ?? 0;

  const capabilities: ExecutionAdapterCapability[] = [
    { domain: 'filesystem', supported: false },
    { domain: 'commands', supported: false },
    { domain: 'network-egress', supported: true, limits: { governedBy: 'allowlist' } },
    { domain: 'display', supported: true },
    { domain: 'browser-profile', supported: true },
    { domain: 'artifact-store', supported: true, limits: { kinds: 'screenshot,dom-snapshot,action-trace' } },
    { domain: 'session-persistence', supported: true, limits: { scope: 'per-profile storage state' } },
    { domain: 'checkpoint', supported: true },
    { domain: 'observation-capture', supported: true },
  ];

  function sessionOf(
    sessionKey: string,
    profileKey: string,
    openedAt: Date,
  ): ExecutionEnvironmentSession {
    return {
      sessionId: sessionKey,
      adapterId,
      phase: 'live',
      openedAt: openedAt.toISOString(),
      isolation: {
        tenantIsolated: true,
        profileScope: 'task',
        networkEgress: 'restricted',
        credentialHandling: 'opaque-ref-only',
      },
      persistence: {
        survivesRestart: false,
        checkpoint: 'session',
        persistentScope: profileKey,
      },
      artifacts: [],
    };
  }

  return {
    adapterId,
    kind: 'browser',

    async probe(): Promise<ExecutionEnvironmentDescriptor> {
      return {
        adapterId,
        kind: 'browser',
        displayName,
        vendor: {
          vendorName: 'aurum-browser-port',
          vendorProduct: 'governed browser environment (W093/W110 BrowserDriver port)',
          vendorAdapterVersion: '1',
        },
        capabilities,
        health: 'available',
      };
    },

    async open(request: FabricAdapterSessionRequest): Promise<ExecutionEnvironmentSession> {
      openCalls += 1;
      if (openFailures > 0) {
        openFailures -= 1;
        throw new Error(`browser environment: session start failure #${openCalls} (scripted)`);
      }
      const profileKey = browserProfileKeyOf(request);
      const started = await driver.startSession({
        taskId: request.subjectRef ?? `fabric-${request.tenantId}`,
        profileKey,
        credentialRef: request.credentialRef ?? null,
        allowlist: options.allowlist,
      });
      startedSessions.push({
        sessionKey: started.sessionKey,
        profileKey,
        credentialRef: request.credentialRef ?? null,
      });
      return sessionOf(started.sessionKey, profileKey, new Date());
    },

    async resume(checkpointRef: string): Promise<ExecutionEnvironmentSession> {
      resumeCalls += 1;
      if (resumeFailures > 0) {
        resumeFailures -= 1;
        throw new Error(`browser environment: resume failure #${resumeFailures} (scripted)`);
      }
      // The resumption-token convention: the checkpoint cursor's
      // '<session-id>@…' prefix names the prior vendor session; the
      // fresh session binds to the SAME isolated profile.
      const priorKey = checkpointRef.split('@', 1)[0]!;
      const prior = startedSessions.find((entry) => entry.sessionKey === priorKey);
      if (prior === undefined) {
        throw new Error(
          `browser environment: no session '${priorKey}' to resume from (unknown checkpoint ref)`,
        );
      }
      const started = await driver.startSession({
        taskId: priorKey,
        profileKey: prior.profileKey,
        credentialRef: prior.credentialRef,
        allowlist: options.allowlist,
      });
      resumeProfileKeys.push(prior.profileKey);
      return sessionOf(started.sessionKey, prior.profileKey, new Date());
    },

    async close(sessionId: string, reason: string): Promise<ExecutionEnvironmentSession> {
      closeCalls += 1;
      const prior = startedSessions.find((entry) => entry.sessionKey === sessionId);
      if (prior === undefined) {
        throw new Error(`browser environment: unknown session '${sessionId}'`);
      }
      // The adapter's close mapping (documented ruling): every fabric-
      // initiated end maps to the port's 'aborted' end-reason — the
      // fabric's own reason (release/cancel/fail) is retained in the
      // DOMAIN evidence tail, not in the driver receipt.
      await driver.endSession({ sessionKey: sessionId, reason: 'aborted', detail: reason });
      endedSessions.push({ sessionKey: sessionId, reason });
      return {
        sessionId,
        adapterId,
        phase: 'ended',
        openedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        isolation: {
          tenantIsolated: true,
          profileScope: 'task',
          networkEgress: 'restricted',
          credentialHandling: 'opaque-ref-only',
        },
        persistence: {
          survivesRestart: false,
          checkpoint: 'session',
          persistentScope: prior.profileKey,
        },
        artifacts: [],
      };
    },

    state: {
      get startedSessions() {
        return startedSessions;
      },
      get endedSessions() {
        return endedSessions;
      },
      get profileKeys() {
        const keys = new Set<string>([
          ...startedSessions.map((entry) => entry.profileKey),
          ...resumeProfileKeys,
        ]);
        return [...keys];
      },
      get openCalls() {
        return openCalls;
      },
      get resumeCalls() {
        return resumeCalls;
      },
      get closeCalls() {
        return closeCalls;
      },
    },
  };
}
