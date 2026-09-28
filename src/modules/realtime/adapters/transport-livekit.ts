// LiveKit transport (MODULE-INTERNAL) — the REAL realtime transport of the
// livekit provider (W109). Everything provider-specific lives here and
// never leaves `src/modules/realtime/adapters/` (lock 16 /
// IMPLEMENTATION-STACK §6): the domain only ever sees the provider-neutral
// `RealtimeTransport` port, opaque room/egress ids and the canonical
// failure vocabulary.
//
// WIRE PROTOCOL (all LiveKit-specific, all inside this file):
//   * Room lifecycle — the Twirp JSON API over HTTPS:
//       POST {httpBase}/livekit.RoomService/CreateRoom   { name, empty_timeout }
//       POST {httpBase}/livekit.RoomService/DeleteRoom   { room }
//       POST {httpBase}/livekit.RoomService/SendData     { room, data, kind, topic }
//       POST {httpBase}/livekit.Egress/StartRoomCompositeEgress
//            { room_name, audio_only, stream: { protocol: RTMP, urls: [...] } }
//       POST {httpBase}/livekit.Egress/StopEgress        { egress_id }
//       POST {httpBase}/livekit.Egress/ListEgress        { room_name }
//       POST {httpBase}/livekit.SIP/CreateSIPParticipant { sip_trunk_id, sip_call_to,
//                                                          room_name, participant_identity }
//     `httpBase` is the LIVEKIT_URL host with wss://→https:// plus /twirp.
//     NOTE: this deployment family routes the canonical
//     `livekit.RoomService` service prefix (the `livekit.Room` alias used
//     by some SDKs falls through to the health responder on LiveKit
//     Cloud) — verified against the operator's project.
//   * Authentication — every Twirp call carries a short-lived LiveKit
//     access token minted here: HS256 JWT, iss=API key, sub=call identity,
//     exp=+5m, video grants scoped to the call (roomCreate/roomAdmin/
//     roomRecord + the target room for room-scoped methods).
//   * Agent speech — Aurum's spoken responses are PUBLISHED into the room
//     on the reliable data channel (topic `aurum.response`, payload
//     { responseId, agentParticipantId, text }); connected WebRTC clients
//     receive them on their `_reliable` data channel. The response
//     lifecycle (completed/interrupted) is confirmed through the provider
//     event edge (`receiveRealtimeEvent`) — the transport's idempotency
//     key is the domain response id carried in the payload.
//   * Recording — LiveKit egress. A room-composite, audio-only egress is
//     started/stopped through the Egress API; the egress REJOINS the room
//     as a real participant under its egress id. File outputs require an
//     external storage destination the operator may not have; the
//     storage-free output this transport uses is an RTMP stream
//     (LIVEKIT_EGRESS_STREAM_URL / `egressStreamUrl`). When no egress
//     destination is configured, recording control fails HONESTLY with
//     `provider_unavailable` — never a faked recording.
//   * Telephony — SIP dial-out through CreateSIPParticipant. Requires a
//     configured SIP trunk (`sipTrunkId`); without one it fails honestly.
//   * Join grants — `createJoinGrant` mints a short-lived room-scoped
//     join token (roomJoin + canSubscribe + canPublishData; no publish)
//     plus the project's WebSocket URL. EPHEMERAL by contract: the token
//     is returned to the caller only, never persisted, never logged.
//
// HONESTY CONTRACT: a transport constructed from an INCOMPLETE provider
// reality stays operational for what it can do and fails explicitly for
// what it cannot (recording without an egress destination, dial-out
// without a trunk) — the fail-closed discipline of the cellular
// transports (W108). Every provider error is surfaced as
// `transport_failed` carrying the provider's own code/message; network
// failures never become fake successes.

import { createHmac } from 'node:crypto';
import { RealtimeError } from '../errors';
import type {
  RealtimeDialRequest,
  RealtimeDialResult,
  RealtimeJoinGrant,
  RealtimeJoinGrantRequest,
  RealtimeRecordingArtifactInfo,
  RealtimeRecordingRequest,
  RealtimeRoomHandle,
  RealtimeRoomStartRequest,
  RealtimeRoomStopRequest,
  RealtimeSpeakRequest,
  RealtimeTransport,
} from '../types';

/** The LiveKit-specific configuration a host constructs the transport from. */
export interface LivekitTransportConfig {
  /** The project's WebSocket URL (wss://…) — joins and the Twirp base derive from it. */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Canonical account id the wiring reports (envelopes carry it; default: the URL host). */
  accountId: string;
  /** RTMP destination for the recording egress (null → recording fails provider_unavailable). */
  egressStreamUrl: string | null;
  /** SIP trunk id for telephony dial-out (null → dial fails provider_unavailable). */
  sipTrunkId: string | null;
}

/** The response shape of CreateRoom (only the facets this transport reads). */
interface LivekitRoom {
  sid: string;
  name: string;
  creation_time?: string;
}

/** The response shape of the egress calls (only the facets this transport reads). */
interface LivekitEgressInfo {
  egress_id: string;
  room_name?: string;
  status?: string;
  error?: string;
  file_results?: Array<{
    filename?: string;
    started_at?: string;
    ended_at?: string;
    duration?: string;
    size?: string;
    location?: string;
  }>;
}

/** LiveKit video grants (the JWT `video` claim) — provider vocabulary, file-local. */
interface VideoGrants {
  roomCreate?: boolean;
  roomList?: boolean;
  roomAdmin?: boolean;
  roomRecord?: boolean;
  roomJoin?: boolean;
  room?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

/** How long a Twirp admin token lives (seconds). */
const ADMIN_TOKEN_TTL_SECONDS = 300;
/** How long a join grant token lives (seconds). */
const JOIN_TOKEN_TTL_SECONDS = 600;
/** Room empty timeout (seconds) — an abandoned room dies on its own. */
const ROOM_EMPTY_TIMEOUT_SECONDS = 300;
/** The data-channel topic Aurum's spoken responses are published under. */
const RESPONSE_TOPIC = 'aurum.response';

function httpBaseOf(url: string): string {
  const withHttps = url.startsWith('wss://')
    ? `https://${url.slice('wss://'.length)}`
    : url.replace(/\/+$/, '');
  return `${withHttps.replace(/\/+$/, '')}/twirp`;
}

function hostOf(url: string): string {
  const bare = url.replace(/^wss:\/\//, '').replace(/^https:\/\//, '').split('/')[0]!;
  return bare;
}

/** Mints one LiveKit access token (HS256 JWT) — the ONLY credential logic in the module. */
export function mintLivekitToken(
  config: Pick<LivekitTransportConfig, 'apiKey' | 'apiSecret'>,
  identity: string,
  grants: VideoGrants,
  ttlSeconds: number,
): { token: string; expiresAt: Date } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((nowSeconds + ttlSeconds) * 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: config.apiKey,
      sub: identity,
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
      video: grants,
    }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', config.apiSecret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, expiresAt };
}

/** A LiveKit-acceptable identity fragment (identities are opaque but bounded). */
function safeIdentity(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120);
  return cleaned === '' ? 'guest' : cleaned;
}

/**
 * The REAL livekit transport. Constructed by the env-driven wiring
 * (`../wiring.ts`, the cellular.ts pattern) or directly by hosts/tests
 * with explicit configuration. All provider I/O happens inside these
 * methods; the domain sees only the provider-neutral port.
 */
export function createLivekitTransport(config: LivekitTransportConfig): RealtimeTransport {
  const httpBase = httpBaseOf(config.url);
  // The egress started per room (recording control state; the fallback
  // lookup below survives a transport reconstruction).
  const egressByRoom = new Map<string, string>();

  async function twirp<T>(method: string, body: unknown, grants: VideoGrants): Promise<T> {
    const { token } = mintLivekitToken(config, 'aurum-transport', grants, ADMIN_TOKEN_TTL_SECONDS);
    let response: Response;
    try {
      response = await fetch(`${httpBase}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch (error) {
      throw new RealtimeError(
        'transport_failed',
        `livekit ${method} did not reach the provider: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new RealtimeError(
        'transport_failed',
        `livekit ${method} failed: HTTP ${response.status} ${text.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RealtimeError(
        'transport_failed',
        `livekit ${method} returned a non-JSON body (HTTP ${response.status}): ${text.slice(0, 200)}`,
      );
    }
  }

  /** Room-scoped admin grants (the room service requires the room grant for room methods). */
  function roomAdminGrants(room: string): VideoGrants {
    return { roomCreate: true, roomList: true, roomAdmin: true, roomRecord: true, room };
  }

  function roomNameOf(sessionId: string): string {
    return `aurum-${sessionId}`;
  }

  return {
    provider: 'livekit',

    async startRoom(request: RealtimeRoomStartRequest): Promise<RealtimeRoomHandle> {
      const roomName = roomNameOf(request.sessionId);
      const room = await twirp<LivekitRoom>(
        'livekit.RoomService/CreateRoom',
        { name: roomName, empty_timeout: ROOM_EMPTY_TIMEOUT_SECONDS },
        roomAdminGrants(roomName),
      );
      if (typeof room?.name !== 'string' || room.name === '' || typeof room.sid !== 'string') {
        throw new RealtimeError(
          'transport_failed',
          `livekit CreateRoom returned an unusable room handle for '${roomName}'`,
        );
      }
      // The canonical room reference is the NAME (stable across room
      // instance recreation by sid); the sid is provider-internal.
      return { providerRoomId: room.name, agentParticipantId: request.agentParticipantId };
    },

    async stopRoom(request: RealtimeRoomStopRequest): Promise<void> {
      await twirp(
        'livekit.RoomService/DeleteRoom',
        { room: request.providerRoomId },
        roomAdminGrants(request.providerRoomId),
      );
    },

    async speak(request: RealtimeSpeakRequest): Promise<void> {
      const payload = JSON.stringify({
        responseId: request.responseId,
        agentParticipantId: request.agentParticipantId,
        text: request.text,
      });
      await twirp(
        'livekit.RoomService/SendData',
        {
          room: request.providerRoomId,
          data: Buffer.from(payload, 'utf8').toString('base64'),
          kind: 'RELIABLE',
          topic: RESPONSE_TOPIC,
        },
        roomAdminGrants(request.providerRoomId),
      );
    },

    async startRecording(request: RealtimeRecordingRequest): Promise<void> {
      if (config.egressStreamUrl === null) {
        throw new RealtimeError(
          'provider_unavailable',
          'the livekit provider has no egress destination configured (LIVEKIT_EGRESS_STREAM_URL unset) — recording cannot start on this provider',
        );
      }
      const egress = await twirp<LivekitEgressInfo>(
        'livekit.Egress/StartRoomCompositeEgress',
        {
          roomName: request.providerRoomId,
          audioOnly: true,
          stream: { protocol: 'RTMP', urls: [config.egressStreamUrl] },
        },
        roomAdminGrants(request.providerRoomId),
      );
      if (typeof egress?.egress_id !== 'string' || egress.egress_id === '') {
        throw new RealtimeError(
          'transport_failed',
          'livekit StartRoomCompositeEgress returned no egress id',
        );
      }
      egressByRoom.set(request.providerRoomId, egress.egress_id);
    },

    async stopRecording(
      request: RealtimeRecordingRequest,
    ): Promise<{ artifact: RealtimeRecordingArtifactInfo | null }> {
      let egressId = egressByRoom.get(request.providerRoomId) ?? null;
      if (egressId === null) {
        // The transport may have been reconstructed (process restart):
        // recover the room's most recent egress through ListEgress.
        const listed = await twirp<{ items?: LivekitEgressInfo[] }>(
          'livekit.Egress/ListEgress',
          { roomName: request.providerRoomId },
          roomAdminGrants(request.providerRoomId),
        );
        egressId = listed.items?.[0]?.egress_id ?? null;
      }
      if (egressId === null) {
        throw new RealtimeError(
          'transport_failed',
          `livekit has no egress recorded for room '${request.providerRoomId}' — cannot stop what never started`,
        );
      }
      const stopped = await twirp<LivekitEgressInfo>(
        'livekit.Egress/StopEgress',
        { egressId },
        roomAdminGrants(request.providerRoomId),
      );
      egressByRoom.delete(request.providerRoomId);
      const file = stopped.file_results?.[0];
      if (file === undefined) {
        // A stream-only egress produces no file artifact — honest null.
        return { artifact: null };
      }
      return {
        artifact: {
          providerArtifactId: stopped.egress_id ?? egressId,
          storageRef: file.location ?? file.filename ?? null,
          mediaType: 'audio/ogg',
          byteSize: file.size !== undefined ? Number(file.size) : null,
          checksum: null,
        },
      };
    },

    async dial(request: RealtimeDialRequest): Promise<RealtimeDialResult> {
      if (config.sipTrunkId === null) {
        throw new RealtimeError(
          'provider_unavailable',
          'the livekit provider has no SIP trunk configured (LIVEKIT_SIP_TRUNK_ID unset) — telephony dial-out cannot be placed on this provider',
        );
      }
      const identity = `sip-${request.phoneNumber.replace(/[^0-9]/g, '')}`;
      const info = await twirp<{ participant_id?: string; participant_sid?: string }>(
        'livekit.SIP/CreateSIPParticipant',
        {
          sipTrunkId: config.sipTrunkId,
          sipCallTo: request.phoneNumber,
          roomName: request.providerRoomId,
          participantIdentity: identity,
        },
        roomAdminGrants(request.providerRoomId),
      );
      const participantId = info?.participant_id ?? identity;
      return { providerParticipantId: participantId };
    },

    async createJoinGrant(request: RealtimeJoinGrantRequest): Promise<RealtimeJoinGrant> {
      const identity = request.displayName === null ? `guest-${Date.now()}` : safeIdentity(request.displayName);
      const { token, expiresAt } = mintLivekitToken(
        config,
        identity,
        {
          roomJoin: true,
          room: request.providerRoomId,
          canSubscribe: true,
          canPublish: false,
          canPublishData: true,
        },
        JOIN_TOKEN_TTL_SECONDS,
      );
      return { url: config.url, token, expiresAt: expiresAt.toISOString() };
    },
  };
}

/** The account id the env wiring derives from a project URL (exported for wiring/tests). */
export function livekitAccountIdOfUrl(url: string): string {
  return hostOf(url);
}
