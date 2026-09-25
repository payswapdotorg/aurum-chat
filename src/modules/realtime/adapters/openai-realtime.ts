// OpenAI Realtime adapter (MODULE-INTERNAL) — the SECOND conforming
// transport provider (W086 acceptance: "transport provider can be
// swapped without domain rewrite"; GOVERNANCE provider-swap evidence).
// Envelope shape the OpenAI Realtime integration layer (the voice-app
// worker relaying session events) delivers — deliberately a materially
// different wire shape from the LiveKit envelope, so provider swap
// evidence is honest:
//
//   {
//     "type": "session.created" | "session.ended" |
//             "participant.joined" | "participant.left" |
//             "consent.granted" | "consent.revoked" |
//             "conversation.item.input_transcribed" |
//             "response.done" | "response.cancelled" |
//             "recording.started" | "recording.stopped" |
//             "session.error" | "health.ping",
//     "event_id": "…",                  // unique per event, stable across
//                                        // redeliveries — the dedupe key
//     "ts": "…ISO…",
//     "project_id": "…",                 // the OpenAI Realtime project
//     "room_id": "…",                    // the relayed session/room ref
//     "data": {
//       "participant_id": "…", "display_name": "…", "email": "…",
//       "phone": "…",                    // set for telephony parties
//       "speaker_label": "…",
//       "started_at": "…", "ended_at": "…", "text": "…",
//       "confidence": 0.91,
//       "response_id": "…", "interrupted_by": "…",
//       "artifact": { "artifact_id": "…", "storage_ref": "…",
//                     "media_type": "audio/wav", "bytes": N,
//                     "sha256": "…" },
//       "error_code": "…", "error_message": "…"
//     }
//   }
//
// A batch envelope { "batch": [ …envelopes ] } is also accepted.

import { RealtimeError } from '../errors';
import type {
  CanonicalRealtimeEvent,
  RecordingStoppedEvent,
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
  session_limit: 'room_unavailable',
  connection_lost: 'agent_disconnected',
  server_error: 'provider_error',
};

function canonicalFailureCode(providerCode: string): 'room_unavailable' | 'agent_disconnected' | 'provider_error' {
  return FAILURE_CODES[providerCode] ?? 'provider_error';
}

export const openaiRealtimeAdapter: RealtimeAdapter = {
  provider: 'openai-realtime',

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new RealtimeError(
        'invalid_realtime_input',
        'openai-realtime project id must be non-empty',
      );
    }
    return text;
  },

  normalizeParticipantId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new RealtimeError(
        'invalid_provider_payload',
        'openai-realtime participant id must be non-empty',
      );
    }
    return text;
  },

  agentParticipantId(sessionId: string): string {
    return `aurum_${sessionId}`;
  },

  parseEvent(payload: unknown): RealtimeEventParseResult {
    const envelope = requireObject(payload, 'openai-realtime event envelope');
    if (envelope.batch !== undefined) {
      return parseBatch(envelope.batch);
    }
    return parseOne(envelope);
  },
};

function parseBatch(batch: unknown): RealtimeEventParseResult {
  const list = requireEvents(batch, 'openai-realtime batch').map((entry) =>
    parseOne(entry),
  );
  if (list.length === 0) {
    throw new RealtimeError(
      'invalid_provider_payload',
      'openai-realtime batch envelope carries no events',
    );
  }
  const providerAccountId = list[0]!.providerAccountId;
  for (const parsed of list.slice(1)) {
    if (parsed.providerAccountId !== providerAccountId) {
      throw new RealtimeError(
        'invalid_provider_payload',
        'an openai-realtime batch envelope must belong to exactly one project',
      );
    }
  }
  return { providerAccountId, events: list.flatMap((parsed) => parsed.events) };
}

function parseOne(envelope: Record<string, unknown>): RealtimeEventParseResult {
  const type = requireString(envelope.type, 'openai-realtime envelope.type');
  const providerEventId = requireString(envelope.event_id, 'openai-realtime envelope.event_id');
  const occurredAt = requireIsoInstant(envelope.ts, 'openai-realtime envelope.ts');
  const providerAccountId = requireString(envelope.project_id, 'openai-realtime envelope.project_id');
  const providerRoomId = requireString(envelope.room_id, 'openai-realtime envelope.room_id');
  const data =
    envelope.data === undefined || envelope.data === null ? {} : requireObject(envelope.data, 'openai-realtime envelope.data');

  const base = { providerEventId, occurredAt, providerRoomId };

  switch (type) {
    case 'session.created': {
      const event: CanonicalRealtimeEvent = { kind: 'session.started', ...base };
      return { providerAccountId, events: [event] };
    }
    case 'session.ended': {
      const event: CanonicalRealtimeEvent = {
        kind: 'session.ended',
        ...base,
        reason: 'provider_ended',
        endedAt: occurredAt,
      };
      return { providerAccountId, events: [event] };
    }
    case 'participant.joined': {
      const event: CanonicalRealtimeEvent = {
        kind: 'participant.joined',
        ...base,
        providerParticipantId: requireString(data.participant_id, 'data.participant_id'),
        displayName: optionalString(data.display_name, 'data.display_name'),
        email: optionalString(data.email, 'data.email'),
        phone: optionalString(data.phone, 'data.phone'),
        joinedAt: occurredAt,
      };
      return { providerAccountId, events: [event] };
    }
    case 'participant.left': {
      const event: CanonicalRealtimeEvent = {
        kind: 'participant.left',
        ...base,
        providerParticipantId: requireString(data.participant_id, 'data.participant_id'),
        leftAt: occurredAt,
      };
      return { providerAccountId, events: [event] };
    }
    case 'consent.granted':
    case 'consent.revoked': {
      const event: CanonicalRealtimeEvent = {
        kind: type === 'consent.granted' ? 'consent.granted' : 'consent.revoked',
        ...base,
        providerParticipantId: requireString(data.participant_id, 'data.participant_id'),
      };
      return { providerAccountId, events: [event] };
    }
    case 'conversation.item.input_transcribed': {
      const event: CanonicalRealtimeEvent = {
        kind: 'transcript.final',
        ...base,
        providerParticipantId: optionalString(data.participant_id, 'data.participant_id'),
        speakerName: optionalString(data.speaker_label, 'data.speaker_label'),
        startedAt: optionalIsoInstant(data.started_at, 'data.started_at') ?? occurredAt,
        endedAt: optionalIsoInstant(data.ended_at, 'data.ended_at'),
        text: requireString(data.text, 'data.text'),
        confidence: optionalConfidence(data.confidence, 'data.confidence'),
      };
      return { providerAccountId, events: [event] };
    }
    case 'response.done': {
      const event: CanonicalRealtimeEvent = {
        kind: 'response.completed',
        ...base,
        responseId: requireString(data.response_id, 'data.response_id'),
        completedAt: occurredAt,
      };
      return { providerAccountId, events: [event] };
    }
    case 'response.cancelled': {
      const event: CanonicalRealtimeEvent = {
        kind: 'response.interrupted',
        ...base,
        responseId: requireString(data.response_id, 'data.response_id'),
        interruptingProviderParticipantId: optionalString(
          data.interrupted_by,
          'data.interrupted_by',
        ),
        interruptedAt: occurredAt,
      };
      return { providerAccountId, events: [event] };
    }
    case 'recording.started': {
      const event: CanonicalRealtimeEvent = { kind: 'recording.started', ...base };
      return { providerAccountId, events: [event] };
    }
    case 'recording.stopped': {
      let artifact: RecordingStoppedEvent['artifact'] = null;
      if (data.artifact !== undefined && data.artifact !== null) {
        const raw = requireObject(data.artifact, 'data.artifact');
        artifact = {
          providerArtifactId: requireString(raw.artifact_id, 'data.artifact.artifact_id'),
          storageRef: optionalString(raw.storage_ref, 'data.artifact.storage_ref'),
          mediaType: optionalString(raw.media_type, 'data.artifact.media_type'),
          byteSize: optionalByteSize(raw.bytes, 'data.artifact.bytes'),
          checksum: optionalString(raw.sha256, 'data.artifact.sha256'),
        };
      }
      const event: RecordingStoppedEvent = { kind: 'recording.stopped', ...base, artifact };
      return { providerAccountId, events: [event] };
    }
    case 'session.error': {
      const code = optionalString(data.error_code, 'data.error_code') ?? 'server_error';
      const event: SessionFailedEvent = {
        kind: 'session.failed',
        ...base,
        code: canonicalFailureCode(code),
        detail: optionalString(data.error_message, 'data.error_message'),
      };
      return { providerAccountId, events: [event] };
    }
    case 'health.ping':
      unsupportedEvent('openai-realtime health pings carry no realtime events');
      break;
    default:
      throw new RealtimeError(
        'invalid_provider_payload',
        `openai-realtime envelope.type '${type}' is not a recognized event type`,
      );
  }
}
