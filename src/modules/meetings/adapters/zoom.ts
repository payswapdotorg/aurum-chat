// Zoom adapter (MODULE-INTERNAL). Envelope shape the Zoom transport
// delivers (a Cloud-event-style webhook body carrying the account id and
// one meeting-domain object per event):
//
//   {
//     "event": "meeting.created" | "meeting.updated" | "meeting.started" |
//              "meeting.ended" | "recording.completed" |
//              "recording.transcript_completed" | "meeting.access_denied",
//     "event_id": "…",                  // unique per event, stable across
//                                        // redeliveries — the record id
//     "occurredAt": "…ISO…",
//     "account": { "id": "…" },
//     "meeting":   { "id", "title", "agenda", "scheduled_start",
//                    "scheduled_end", "host": { "id", "name", "email" } },
//     "session":   { "id", "status", "started_at", "ended_at",
//                    "participants": [{ "id", "name", "email",
//                                       "joined_at", "left_at" }] },
//     "transcript":{ "id", "language",
//                    "segments": [{ "participant_id", "speaker_name",
//                                   "started_at", "ended_at", "text",
//                                   "confidence" }] },
//     "artifact":  { "id", "type", "name", "media_type", "size_bytes",
//                    "storage_ref", "checksum" },
//     "access":    { "code", "detail", "meeting_id" }
//   }

import { MeetingsError } from '../errors';
import {
  optionalIsoInstant,
  optionalString,
  requireIsoInstant,
  requireObject,
  requireString,
  unsupportedEvent,
} from './shared';
import {
  attendance,
  participant,
  segment,
  type MeetingAdapter,
  type MeetingWebhookParseResult,
} from './types';

const ARTIFACT_KINDS: Record<string, 'recording' | 'chat' | 'summary' | 'document' | 'attachment' | 'other'> = {
  recording: 'recording',
  chat: 'chat',
  summary: 'summary',
  document: 'document',
  attachment: 'attachment',
};

const ACCESS_CODES: Record<
  string,
  'access_denied' | 'not_found' | 'recording_unavailable' | 'transcript_unavailable'
> = {
  access_denied: 'access_denied',
  not_found: 'not_found',
  recording_unavailable: 'recording_unavailable',
  transcript_unavailable: 'transcript_unavailable',
};

function canonicalArtifactKind(
  providerType: string,
): 'recording' | 'chat' | 'summary' | 'document' | 'attachment' | 'other' {
  return ARTIFACT_KINDS[providerType] ?? 'other';
}

function canonicalAccessCode(
  providerCode: string,
): 'access_denied' | 'not_found' | 'recording_unavailable' | 'transcript_unavailable' {
  const code = ACCESS_CODES[providerCode];
  if (code === undefined) {
    throw new MeetingsError(
      'invalid_provider_payload',
      `access.code '${providerCode}' is not a recognized zoom access code`,
    );
  }
  return code;
}

export const zoomAdapter: MeetingAdapter = {
  provider: 'zoom',
  modes: ['webhook', 'polling'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new MeetingsError(
        'invalid_meeting_input',
        'providerAccountId must be a non-empty string',
      );
    }
    return text;
  },

  normalizeParticipantId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new MeetingsError(
        'invalid_provider_payload',
        'participant id must be a non-empty string',
      );
    }
    return text;
  },

  parseWebhook(payload: unknown): MeetingWebhookParseResult {
    const envelope = requireObject(payload, 'the zoom envelope');
    if (envelope.handshake !== undefined) {
      unsupportedEvent('zoom handshake envelopes carry no records');
    }
    const eventName = requireString(envelope.event, 'event');
    const eventId = requireString(envelope.event_id, 'event_id');
    const occurredAt = requireIsoInstant(envelope.occurredAt, 'occurredAt');
    const account = requireObject(envelope.account, 'account');
    const providerAccountId = this.normalizeAccountId(
      requireString(account.id, 'account.id'),
    );

    const meetingObject = () => requireObject(envelope.meeting, 'meeting');
    const sessionObject = () => requireObject(envelope.session, 'session');

    switch (eventName) {
      case 'meeting.created':
      case 'meeting.updated': {
        const meeting = meetingObject();
        const host = meeting.host === undefined || meeting.host === null
          ? null
          : (() => {
              const hostObject = requireObject(meeting.host, 'meeting.host');
              return participant(
                this.normalizeParticipantId(requireString(hostObject.id, 'meeting.host.id')),
                optionalString(hostObject.name, 'meeting.host.name'),
                optionalString(hostObject.email, 'meeting.host.email'),
              );
            })();
        return {
          providerAccountId,
          records: [
            {
              kind: 'meeting.updated',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: requireString(meeting.id, 'meeting.id'),
              title: optionalString(meeting.title, 'meeting.title'),
              agenda: optionalString(meeting.agenda, 'meeting.agenda'),
              scheduledStartAt: optionalIsoInstant(
                meeting.scheduled_start,
                'meeting.scheduled_start',
              ),
              scheduledEndAt: optionalIsoInstant(meeting.scheduled_end, 'meeting.scheduled_end'),
              underlyingPlatform: 'zoom',
              host,
            },
          ],
        };
      }

      case 'meeting.started':
      case 'meeting.ended': {
        const session = sessionObject();
        const rawParticipants = session.participants === undefined ? [] : session.participants;
        if (!Array.isArray(rawParticipants)) {
          throw new MeetingsError('invalid_provider_payload', 'session.participants must be an array');
        }
        const participants = rawParticipants.map((entry, index) => {
          const who = requireObject(entry, `session.participants[${index}]`);
          return attendance(
            participant(
              this.normalizeParticipantId(requireString(who.id, `session.participants[${index}].id`)),
              optionalString(who.name, `session.participants[${index}].name`),
              optionalString(who.email, `session.participants[${index}].email`),
            ),
            optionalIsoInstant(who.joined_at, `session.participants[${index}].joined_at`),
            optionalIsoInstant(who.left_at, `session.participants[${index}].left_at`),
          );
        });
        return {
          providerAccountId,
          records: [
            {
              kind: 'session.updated',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: requireString(meetingObject().id, 'meeting.id'),
              providerSessionId: requireString(session.id, 'session.id'),
              status: eventName === 'meeting.started' ? 'started' : 'ended',
              title: optionalString(session.title, 'session.title'),
              startedAt: optionalIsoInstant(session.started_at, 'session.started_at'),
              endedAt: optionalIsoInstant(session.ended_at, 'session.ended_at'),
              participants,
            },
          ],
        };
      }

      case 'recording.transcript_completed': {
        const transcript = requireObject(envelope.transcript, 'transcript');
        const rawSegments = transcript.segments;
        if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
          throw new MeetingsError(
            'invalid_provider_payload',
            'transcript.segments must be a non-empty array',
          );
        }
        const segments = rawSegments.map((entry, index) => {
          const seg = requireObject(entry, `transcript.segments[${index}]`);
          const providerParticipantId = optionalString(
            seg.participant_id,
            `transcript.segments[${index}].participant_id`,
          );
          const confidence = seg.confidence === undefined || seg.confidence === null
            ? null
            : (seg.confidence as number);
          return segment(
            providerParticipantId === null
              ? null
              : this.normalizeParticipantId(providerParticipantId),
            optionalString(seg.speaker_name, `transcript.segments[${index}].speaker_name`),
            requireIsoInstant(seg.started_at, `transcript.segments[${index}].started_at`),
            optionalIsoInstant(seg.ended_at, `transcript.segments[${index}].ended_at`),
            requireString(seg.text, `transcript.segments[${index}].text`),
            confidence,
          );
        });
        return {
          providerAccountId,
          records: [
            {
              kind: 'transcript.available',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: requireString(meetingObject().id, 'meeting.id'),
              providerSessionId: requireString(sessionObject().id, 'session.id'),
              providerTranscriptId: requireString(transcript.id, 'transcript.id'),
              language: optionalString(transcript.language, 'transcript.language'),
              segments,
            },
          ],
        };
      }

      case 'recording.completed': {
        const artifact = requireObject(envelope.artifact, 'artifact');
        const sizeBytes = artifact.size_bytes === undefined || artifact.size_bytes === null
          ? null
          : (artifact.size_bytes as number);
        return {
          providerAccountId,
          records: [
            {
              kind: 'artifact.available',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: requireString(meetingObject().id, 'meeting.id'),
              providerSessionId: requireString(sessionObject().id, 'session.id'),
              providerArtifactId: requireString(artifact.id, 'artifact.id'),
              artifactKind: canonicalArtifactKind(
                requireString(artifact.type, 'artifact.type'),
              ),
              displayName: optionalString(artifact.name, 'artifact.name'),
              mediaType: optionalString(artifact.media_type, 'artifact.media_type'),
              byteSize: sizeBytes,
              storageRef: optionalString(artifact.storage_ref, 'artifact.storage_ref'),
              checksum: optionalString(artifact.checksum, 'artifact.checksum'),
            },
          ],
        };
      }

      case 'meeting.access_denied': {
        const access = requireObject(envelope.access, 'access');
        return {
          providerAccountId,
          records: [
            {
              kind: 'access.failed',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: optionalString(access.meeting_id, 'access.meeting_id'),
              accessCode: canonicalAccessCode(
                requireString(access.code, 'access.code'),
              ),
              detail: optionalString(access.detail, 'access.detail'),
            },
          ],
        };
      }

      default:
        throw new MeetingsError(
          'unsupported_provider_event',
          `zoom event '${eventName}' carries no meeting-intelligence records`,
        );
    }
  },
};
