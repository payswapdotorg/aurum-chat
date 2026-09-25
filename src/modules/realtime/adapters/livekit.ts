// LiveKit adapter (MODULE-INTERNAL). Envelope shape the LiveKit
// integration layer (the agent worker / app route relaying provider
// webhooks and agent dispatch events) delivers:
//
//   {
//     "type": "room.started" | "room.finished" |
//             "participant.connected" | "participant.disconnected" |
//             "consent.granted" | "consent.revoked" |
//             "transcript.finalized" |
//             "response.completed" | "response.interrupted" |
//             "egress.started" | "egress.ended" |
//             "agent.failed" | "webhook.verify",
//     "event_id": "…",                  // unique per event, stable across
//                                        // redeliveries — the dedupe key
//     "occurredAt": "…ISO…",
//     "account":  { "id": "…" },         // the LiveKit project id
//     "room":     { "id": "…" },
//     "participant": { "identity": "…", "name": "…", "email": null,
//                      "phone": null },  // phone set for SIP/PSTN parties
//     "transcript": { "participant_id": "…", "speaker_name": "…",
//                     "started_at": "…", "ended_at": "…", "text": "…",
//                     "confidence": 0.94 },
//     "response": { "id": "…",           // the domain response id echoed
//                  "interrupted_by": "…" },
//     "recording": { "artifact": { "id": "…", "storage_ref": "…",
//                                  "media_type": "audio/ogg",
//                                  "size_bytes": N, "checksum": "…" } },
//     "failure":  { "code": "…", "detail": "…" },
//     "end":      { "reason": "finished" }
//   }
//
// A batch envelope { "events": [ …envelopes ] } is also accepted.
//
// `room.finished`'s end reason is canonicalized to `provider_ended`
// (LiveKit finished the room; the last-participant-left classification is
// the DOMAIN's, derived from participant state — never the provider's).

import { RealtimeError } from '../errors';
import type {
  CanonicalRealtimeEvent,
  RecordingStoppedEvent,
  SessionEndedEvent,
  SessionFailedEvent,
} from '../types';
import {
  optionalByteSize,
  optionalConfidence,
  optionalIsoInstant,
  optionalString,
  requireEvents,
  requireIsoInstant,
  requireObject,
  requireString,
  unsupportedEvent,
} from './shared';
import type { RealtimeAdapter, RealtimeEventParseResult } from './types';

const FAILURE_CODES: Record<string, 'room_unavailable' | 'agent_disconnected' | 'provider_error'> = {
  room_unavailable: 'room_unavailable',
  agent_disconnected: 'agent_disconnected',
  transport_error: 'provider_error',
};

function canonicalFailureCode(providerCode: string): 'room_unavailable' | 'agent_disconnected' | 'provider_error' {
  return FAILURE_CODES[providerCode] ?? 'provider_error';
}

export const livekitAdapter: RealtimeAdapter = {
  provider: 'livekit',

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new RealtimeError('invalid_realtime_input', 'livekit account id must be non-empty');
    }
    return text;
  },

  normalizeParticipantId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new RealtimeError(
        'invalid_provider_payload',
        'livekit participant identity must be non-empty',
      );
    }
    return text;
  },

  agentParticipantId(sessionId: string): string {
    return `aurum-agent-${sessionId}`;
  },

  parseEvent(payload: unknown): RealtimeEventParseResult {
    const envelope = requireObject(payload, 'livekit event envelope');
    if (envelope.events !== undefined) {
      return parseBatch(envelope.events);
    }
    return parseOne(envelope);
  },
};

function parseBatch(events: unknown): RealtimeEventParseResult {
  const list = requireEvents(events, 'livekit batch events').map((entry) =>
    parseOne(entry),
  );
  if (list.length === 0) {
    throw new RealtimeError('invalid_provider_payload', 'livekit batch envelope carries no events');
  }
  const providerAccountId = list[0]!.providerAccountId;
  for (const parsed of list.slice(1)) {
    if (parsed.providerAccountId !== providerAccountId) {
      throw new RealtimeError(
        'invalid_provider_payload',
        'a livekit batch envelope must belong to exactly one account',
      );
    }
  }
  return { providerAccountId, events: list.flatMap((parsed) => parsed.events) };
}

function parseOne(envelope: Record<string, unknown>): RealtimeEventParseResult {
  const type = requireString(envelope.type, 'livekit envelope.type');
  const providerEventId = requireString(envelope.event_id, 'livekit envelope.event_id');
  const occurredAt = requireIsoInstant(envelope.occurredAt, 'livekit envelope.occurredAt');
  const account = requireObject(envelope.account, 'livekit envelope.account');
  const providerAccountId = requireString(account.id, 'livekit envelope.account.id');
  const room = requireObject(envelope.room, 'livekit envelope.room');
  const providerRoomId = requireString(room.id, 'livekit envelope.room.id');

  const base = { providerEventId, occurredAt, providerRoomId };

  switch (type) {
    case 'room.started': {
      const event: CanonicalRealtimeEvent = { kind: 'session.started', ...base };
      return { providerAccountId, events: [event] };
    }
    case 'room.finished': {
      const end = requireObject(envelope.end, "livekit envelope.end (type 'room.finished')");
      requireString(end.reason, 'livekit envelope.end.reason');
      const event: SessionEndedEvent = {
        kind: 'session.ended',
        ...base,
        reason: 'provider_ended',
        endedAt: occurredAt,
      };
      return { providerAccountId, events: [event] };
    }
    case 'participant.connected':
    case 'participant.disconnected': {
      const participant = requireObject(
        envelope.participant,
        `livekit envelope.participant (type '${type}')`,
      );
      const identity = requireString(participant.identity, 'livekit participant.identity');
      const event: CanonicalRealtimeEvent =
        type === 'participant.connected'
          ? {
              kind: 'participant.joined',
              ...base,
              providerParticipantId: identity,
              displayName: optionalString(participant.name, 'livekit participant.name'),
              email: optionalString(participant.email, 'livekit participant.email'),
              phone: optionalString(participant.phone, 'livekit participant.phone'),
              joinedAt: occurredAt,
            }
          : {
              kind: 'participant.left',
              ...base,
              providerParticipantId: identity,
              leftAt: occurredAt,
            };
      return { providerAccountId, events: [event] };
    }
    case 'consent.granted':
    case 'consent.revoked': {
      const participant = requireObject(
        envelope.participant,
        `livekit envelope.participant (type '${type}')`,
      );
      const event: CanonicalRealtimeEvent = {
        kind: type === 'consent.granted' ? 'consent.granted' : 'consent.revoked',
        ...base,
        providerParticipantId: requireString(
          participant.identity,
          'livekit participant.identity',
        ),
      };
      return { providerAccountId, events: [event] };
    }
    case 'transcript.finalized': {
      const transcript = requireObject(
        envelope.transcript,
        "livekit envelope.transcript (type 'transcript.finalized')",
      );
      const event: CanonicalRealtimeEvent = {
        kind: 'transcript.final',
        ...base,
        providerParticipantId: optionalString(
          transcript.participant_id,
          'livekit transcript.participant_id',
        ),
        speakerName: optionalString(transcript.speaker_name, 'livekit transcript.speaker_name'),
        startedAt:
          optionalIsoInstant(transcript.started_at, 'livekit transcript.started_at') ?? occurredAt,
        endedAt: optionalIsoInstant(transcript.ended_at, 'livekit transcript.ended_at'),
        text: requireString(transcript.text, 'livekit transcript.text'),
        confidence: optionalConfidence(transcript.confidence, 'livekit transcript.confidence'),
      };
      return { providerAccountId, events: [event] };
    }
    case 'response.completed':
    case 'response.interrupted': {
      const response = requireObject(
        envelope.response,
        `livekit envelope.response (type '${type}')`,
      );
      const responseId = requireString(response.id, 'livekit response.id');
      const event: CanonicalRealtimeEvent =
        type === 'response.completed'
          ? {
              kind: 'response.completed',
              ...base,
              responseId,
              completedAt: occurredAt,
            }
          : {
              kind: 'response.interrupted',
              ...base,
              responseId,
              interruptingProviderParticipantId: optionalString(
                response.interrupted_by,
                'livekit response.interrupted_by',
              ),
              interruptedAt: occurredAt,
            };
      return { providerAccountId, events: [event] };
    }
    case 'egress.started': {
      const event: CanonicalRealtimeEvent = { kind: 'recording.started', ...base };
      return { providerAccountId, events: [event] };
    }
    case 'egress.ended': {
      const recording = requireObject(
        envelope.recording,
        "livekit envelope.recording (type 'egress.ended')",
      );
      let artifact: RecordingStoppedEvent['artifact'] = null;
      if (recording.artifact !== undefined && recording.artifact !== null) {
        const raw = requireObject(recording.artifact, 'livekit recording.artifact');
        artifact = {
          providerArtifactId: requireString(raw.id, 'livekit recording.artifact.id'),
          storageRef: optionalString(raw.storage_ref, 'livekit recording.artifact.storage_ref'),
          mediaType: optionalString(raw.media_type, 'livekit recording.artifact.media_type'),
          byteSize: optionalByteSize(raw.size_bytes, 'livekit recording.artifact.size_bytes'),
          checksum: optionalString(raw.checksum, 'livekit recording.artifact.checksum'),
        };
      }
      const event: RecordingStoppedEvent = { kind: 'recording.stopped', ...base, artifact };
      return { providerAccountId, events: [event] };
    }
    case 'agent.failed': {
      const failure = requireObject(envelope.failure, "livekit envelope.failure (type 'agent.failed')");
      const code = requireString(failure.code, 'livekit failure.code');
      const event: SessionFailedEvent = {
        kind: 'session.failed',
        ...base,
        code: canonicalFailureCode(code),
        detail: optionalString(failure.detail, 'livekit failure.detail'),
      };
      return { providerAccountId, events: [event] };
    }
    case 'webhook.verify':
      unsupportedEvent('livekit webhook verification envelopes carry no realtime events');
      break;
    default:
      throw new RealtimeError(
        'invalid_provider_payload',
        `livekit envelope.type '${type}' is not a recognized event type`,
      );
  }
}
