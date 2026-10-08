// The LOCAL-CONTAINER PATH adapter (W137 catalog path (a)) — a
// DETERMINISTIC SIMULATION of a local container runtime, documented
// honestly: no container engine, no process, no filesystem touch, no
// network. It serves the frozen W131 'workspace' kind (a container IS
// the canonical workspace: "a persistent file/command workspace
// (container or equivalent)") and models, in memory:
//
//   * PER-PROFILE VOLUMES — the simulated container filesystem, keyed by
//     the isolated profile key derived from (tenant, scope, subject):
//     'session' scope mints a FRESH volume per session (wholly
//     disposable), 'task' scope persists across the sessions of one
//     subject (the fabric lease — the W093 per-(tenant,task)
//     discipline), 'environment' scope persists across the tenant's
//     sessions on this adapter. This is the PERSISTENCE-WHERE-REQUIRED
//     surface the proofs inspect (a simulated volume surviving session
//     death is the declared survivesRestart guarantee, honestly
//     simulated).
//   * THE COMMAND LOG — every simulated command the driving side asks
//     the adapter to record (the fabric never issues commands; the
//     composition does, adapter-side). Read-only exposed for proofs.
//   * SESSION PHASES + DISPOSABILITY — sessions are minted 'live' and
//     closed on close(); the closed session record stays (durable
//     adapter-side registry) so resume(<session-id>) can bind a FRESH
//     session to the SAME isolated volume (the resumption-token
//     convention shared by all three adapters: a checkpoint cursor of
//     '<session-id>@<worker-cursor>' — or a bare session id — names the
//     vendor session the fresh one continues).
//   * SCRIPTABLE FAILURES — openFailures/resumeFailures countdowns make
//     open() and resume() throw (the vendor-path failure the service
//     stamps onto the lease as 'failed' with the detail — honest
//     failure evidence, never a fabricated success).
//
// The adapter implements the frozen W131 ExecutionAdapter
// capability-shape (probe/open/resume/close) through the fabric's
// FabricAdapter SPI (the additive optional subjectRef — see types.ts).
// Vendor identity is METADATA on the descriptor ('aurum-local-sim') and
// appears nowhere in any domain record (the W131 law, test-locked).

import { newId } from '@/infra/ids';
import type {
  ExecutionAdapterCapability,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentSession,
} from '@/modules/execution/contract';
import type { FabricAdapter, FabricAdapterSessionRequest } from '../types';

/** Options of {@link createLocalContainerAdapter}. */
export interface LocalContainerAdapterOptions {
  /** Stable adapter instance id (default 'local-container-sim-1'). */
  adapterId?: string;
  displayName?: string;
  /**
   * The declared network-egress policy of the simulated container
   * (default 'disabled' — the isolation-by-default posture).
   */
  networkEgress?: 'disabled' | 'restricted' | 'open';
  /** How many consecutive open() calls throw (the scriptable vendor failure). */
  openFailures?: number;
  /** How many consecutive resume() calls throw (the scriptable vendor failure). */
  resumeFailures?: number;
}

/** One simulated container session (kept after close for resumption). */
export interface LocalSimSessionRecord {
  sessionId: string;
  profileKey: string;
  phase: 'live' | 'ended';
  openedAt: string;
  endedAt: string | null;
  closeReason: string | null;
}

/** Read-only adapter state for proofs (the provider side stays behind the seam). */
export interface LocalContainerAdapterState {
  readonly sessions: readonly LocalSimSessionRecord[];
  readonly profileKeys: readonly string[];
  readonly volumeContents: (profileKey: string) => ReadonlyMap<string, string> | undefined;
  readonly commandLog: readonly { sessionId: string; command: string }[];
  readonly openCalls: number;
  readonly resumeCalls: number;
  readonly closeCalls: number;
}

/** The simulation adapter plus its read-only proof surface and command recorder. */
export interface LocalContainerAdapter extends FabricAdapter {
  readonly state: LocalContainerAdapterState;
  /** Record one simulated command against a LIVE session (composition-side; the fabric never issues commands). */
  recordCommand(sessionId: string, command: string): void;
}

/** The isolated profile key: per TENANT always; per SUBJECT when task-scoped; shared when environment-scoped. */
function profileKeyOf(request: FabricAdapterSessionRequest): string {
  if (request.profileScope === 'session') {
    return `tenant:${request.tenantId}:session`;
  }
  if (request.profileScope === 'task') {
    return `tenant:${request.tenantId}:subject:${request.subjectRef ?? 'unscoped'}`;
  }
  return `tenant:${request.tenantId}:environment`;
}

/**
 * The deterministic local-container SIMULATION (catalog path (a)).
 * Honest limitation, stated here and in WORK-NOTES: this adapter
 * simulates a container runtime in memory; the REAL local container
 * path (a container engine behind the same frozen shape) is the
 * documented next step — the domain contracts are identical either way
 * (the vendor-removal clause).
 */
export function createLocalContainerAdapter(
  options: LocalContainerAdapterOptions = {},
): LocalContainerAdapter {
  const adapterId = options.adapterId ?? 'local-container-sim-1';
  const displayName = options.displayName ?? 'Local container (deterministic simulation)';
  const networkEgress = options.networkEgress ?? 'disabled';

  const sessions = new Map<string, LocalSimSessionRecord>();
  const volumes = new Map<string, Map<string, string>>();
  const commandLog: { sessionId: string; command: string }[] = [];
  let openCalls = 0;
  let resumeCalls = 0;
  let closeCalls = 0;
  let openFailures = options.openFailures ?? 0;
  let resumeFailures = options.resumeFailures ?? 0;

  const capabilities: ExecutionAdapterCapability[] = [
    { domain: 'filesystem', supported: true },
    { domain: 'commands', supported: true },
    { domain: 'network-egress', supported: true, limits: { policy: networkEgress } },
    { domain: 'display', supported: false },
    { domain: 'browser-profile', supported: false },
    { domain: 'artifact-store', supported: true },
    { domain: 'session-persistence', supported: true },
    { domain: 'checkpoint', supported: true },
    { domain: 'observation-capture', supported: true },
  ];

  function sessionOf(sessionId: string, openedAt: Date): ExecutionEnvironmentSession {
    return {
      sessionId,
      adapterId,
      phase: 'live',
      openedAt: openedAt.toISOString(),
      isolation: {
        tenantIsolated: true,
        profileScope: 'environment',
        networkEgress,
        credentialHandling: 'opaque-ref-only',
      },
      persistence: {
        survivesRestart: true,
        checkpoint: 'durable-checkpoint',
        persistentScope: '/workspace',
      },
      artifacts: [],
    };
  }

  return {
    adapterId,
    kind: 'workspace',

    async probe(): Promise<ExecutionEnvironmentDescriptor> {
      return {
        adapterId,
        kind: 'workspace',
        displayName,
        vendor: {
          vendorName: 'aurum-local-sim',
          vendorProduct: 'deterministic local-container simulation',
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
        throw new Error(`local-container simulation: provision failure #${openCalls} (scripted)`);
      }
      const profileKey = profileKeyOf(request);
      if (!volumes.has(profileKey)) volumes.set(profileKey, new Map());
      const sessionId = `lcs-${newId()}`;
      const openedAt = new Date();
      sessions.set(sessionId, {
        sessionId,
        profileKey,
        phase: 'live',
        openedAt: openedAt.toISOString(),
        endedAt: null,
        closeReason: null,
      });
      return sessionOf(sessionId, openedAt);
    },

    async resume(checkpointRef: string): Promise<ExecutionEnvironmentSession> {
      resumeCalls += 1;
      if (resumeFailures > 0) {
        resumeFailures -= 1;
        throw new Error(
          `local-container simulation: resume failure #${resumeFailures} (scripted)`,
        );
      }
      // The resumption-token convention: '<session-id>@<cursor>' or a
      // bare session id names the vendor session the fresh one continues.
      const priorId = checkpointRef.split('@', 1)[0]!;
      const prior = sessions.get(priorId);
      if (prior === undefined) {
        throw new Error(
          `local-container simulation: no session '${priorId}' to resume from (unknown checkpoint ref)`,
        );
      }
      const sessionId = `lcs-${newId()}`;
      const openedAt = new Date();
      sessions.set(sessionId, {
        sessionId,
        profileKey: prior.profileKey,
        phase: 'live',
        openedAt: openedAt.toISOString(),
        endedAt: null,
        closeReason: null,
      });
      return sessionOf(sessionId, openedAt);
    },

    async close(sessionId: string, reason: string): Promise<ExecutionEnvironmentSession> {
      closeCalls += 1;
      const record = sessions.get(sessionId);
      if (record === undefined) {
        throw new Error(`local-container simulation: unknown session '${sessionId}'`);
      }
      if (record.phase !== 'ended') {
        record.phase = 'ended';
        record.endedAt = new Date().toISOString();
        record.closeReason = reason;
      }
      return {
        sessionId,
        adapterId,
        phase: 'ended',
        openedAt: record.openedAt,
        endedAt: record.endedAt ?? undefined,
        isolation: {
          tenantIsolated: true,
          profileScope: 'environment',
          networkEgress,
          credentialHandling: 'opaque-ref-only',
        },
        persistence: {
          survivesRestart: true,
          checkpoint: 'durable-checkpoint',
          persistentScope: '/workspace',
        },
        artifacts: [],
      };
    },

    recordCommand(sessionId: string, command: string): void {
      const record = sessions.get(sessionId);
      if (record === undefined || record.phase !== 'live') {
        throw new Error(`local-container simulation: no live session '${sessionId}'`);
      }
      commandLog.push({ sessionId, command });
    },

    state: {
      get sessions(): readonly LocalSimSessionRecord[] {
        return [...sessions.values()];
      },
      get profileKeys(): readonly string[] {
        return [...volumes.keys()];
      },
      volumeContents(profileKey: string): ReadonlyMap<string, string> | undefined {
        return volumes.get(profileKey);
      },
      get commandLog(): readonly { sessionId: string; command: string }[] {
        return commandLog;
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
    },
  };
}
