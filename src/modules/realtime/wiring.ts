// Realtime transport wiring (W109) — the env-driven production wiring of
// the realtime module's transport port, in the cellular.ts discipline
// (W108 — the merged reference pattern): a globalThis-guarded lazy
// singleton, computed once per process at first use; Next dev compiles
// route bundles into separate module registries — a module-level variable
// would diverge per registry (the W058 incident).
//
// ENVIRONMENT CONTRACT (documented for the operator; the evidence files
// under docs/productization-evidence/W109/ record the exact shape with
// the secret REDACTED):
//
//   LIVEKIT_URL                — the project's WebSocket URL ('wss://…').
//   LIVEKIT_API_KEY            — the project API key (JWT iss).
//   LIVEKIT_API_SECRET         — the project API secret (HS256 signing
//                                key; never logged, never persisted).
//   LIVEKIT_ACCOUNT_ID         — optional canonical account id the
//                                provider's event envelopes carry
//                                (default: the LIVEKIT_URL host — one per
//                                LiveKit Cloud project).
//   LIVEKIT_EGRESS_STREAM_URL  — optional RTMP destination for the
//                                recording egress (unset → recording
//                                control fails honestly with
//                                provider_unavailable; rooms, speech and
//                                join grants stay fully operational).
//   LIVEKIT_SIP_TRUNK_ID       — optional SIP trunk id for telephony
//                                dial-out (unset → dial fails honestly).
//
// HONESTY CONTRACT: unset or PARTIAL configuration leaves the livekit
// transport UNWIRED — realtime session starts then fail explicitly with
// `provider_unavailable` (retryable, visible; never a faked room). The
// deterministic scripted transport remains available for tests through
// `setRealtimeTransport` (the wiring never fights a test that wired its
// own transport: `ensureRealtimeTransportsWired()` only wires from env,
// and tests reset both seams through `resetRealtimeTransportWiring()`).
//
// INVOCATION: `ensureRealtimeTransportsWired()` is idempotent per
// process. A host composes it at its realtime entry points (the resident
// worker / session-start edge — the W112 certification frontier composes
// the full worker; the wiring function is exported through the module
// contract exactly like `createRealtimeWorkflowBindings` is).

import { envString } from '@/infra/config';
import { createLivekitTransport, livekitAccountIdOfUrl } from './adapters/transport-livekit';
import type { RealtimeProvider } from './types';
import { setRealtimeTransport } from './service';

/** The per-provider wiring outcome (machine-readable, operator-auditable). */
export interface RealtimeTransportWiringState {
  provider: RealtimeProvider;
  state: 'wired' | 'unwired' | 'incomplete';
  detail: string;
}

export interface RealtimeTransportWiringReport {
  providers: RealtimeTransportWiringState[];
  /**
   * The canonical account id the wired livekit transport serves — the
   * `providerAccountId` a tenant's realtime connection must be registered
   * with (and the account id its provider event envelopes carry). Null
   * while livekit is unwired/incomplete.
   */
  livekitAccountId: string | null;
}

interface RealtimeWiringGlobal {
  __aurumRealtimeTransportWiring?: RealtimeTransportWiringReport;
}

const wiringGlobal = globalThis as unknown as RealtimeWiringGlobal;

/**
 * Wire the configured live transports ONCE per process (idempotent; the
 * globalThis guard survives Next's per-bundle module registries).
 * Unset/partial env → the livekit transport stays unwired (honest
 * `provider_unavailable`), never half-constructed.
 */
export function ensureRealtimeTransportsWired(): RealtimeTransportWiringReport {
  wiringGlobal.__aurumRealtimeTransportWiring ??= wireFromEnv();
  return wiringGlobal.__aurumRealtimeTransportWiring;
}

/** Reset the wiring (tests and process shutdown). */
export function resetRealtimeTransportWiring(): void {
  wiringGlobal.__aurumRealtimeTransportWiring = undefined;
  setRealtimeTransport(null);
}

function wireFromEnv(): RealtimeTransportWiringReport {
  const url = envString('LIVEKIT_URL');
  const apiKey = envString('LIVEKIT_API_KEY');
  const apiSecret = envString('LIVEKIT_API_SECRET');

  if (url === undefined && apiKey === undefined && apiSecret === undefined) {
    return {
      providers: [
        {
          provider: 'livekit',
          state: 'unwired',
          detail:
            'no livekit configuration present (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET unset) — realtime sessions fail honestly with provider_unavailable',
        },
      ],
      livekitAccountId: null,
    };
  }

  const missing: string[] = [];
  if (url === undefined) missing.push('LIVEKIT_URL');
  if (apiKey === undefined) missing.push('LIVEKIT_API_KEY');
  if (apiSecret === undefined) missing.push('LIVEKIT_API_SECRET');
  if (missing.length > 0) {
    return {
      providers: [
        {
          provider: 'livekit',
          state: 'incomplete',
          detail: `partial livekit configuration — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required alongside the rest; the transport stays unwired (honest provider_unavailable)`,
        },
      ],
      livekitAccountId: null,
    };
  }

  const accountId = envString('LIVEKIT_ACCOUNT_ID') ?? livekitAccountIdOfUrl(url!);
  const egressStreamUrl = envString('LIVEKIT_EGRESS_STREAM_URL') ?? null;
  const sipTrunkId = envString('LIVEKIT_SIP_TRUNK_ID') ?? null;

  setRealtimeTransport(
    createLivekitTransport({
      url: url!,
      apiKey: apiKey!,
      apiSecret: apiSecret!,
      accountId,
      egressStreamUrl,
      sipTrunkId,
    }),
  );

  const capabilities: string[] = ['rooms', 'speech (data publish)', 'join grants'];
  capabilities.push(egressStreamUrl === null
    ? 'recording UNAVAILABLE (LIVEKIT_EGRESS_STREAM_URL unset — recording control fails honestly)'
    : 'recording (RTMP egress)');
  capabilities.push(sipTrunkId === null
    ? 'telephony dial-out UNAVAILABLE (LIVEKIT_SIP_TRUNK_ID unset — dial fails honestly)'
    : 'telephony dial-out (SIP trunk)');

  return {
    providers: [
      {
        provider: 'livekit',
        state: 'wired',
        detail: `livekit live transport wired (account '${accountId}'; Twirp room service + egress + signal WebSocket); capabilities: ${capabilities.join('; ')}`,
      },
    ],
    livekitAccountId: accountId,
  };
}
