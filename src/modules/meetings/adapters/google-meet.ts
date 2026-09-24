// Google Meet adapter (MODULE-INTERNAL). Envelope shape the Meet
// transport delivers (a Workspace-events-style webhook body carrying the
// workspace account and one conference-domain resource per event):
//
//   {
//     "eventUuid": "…",                 // unique per event, stable across
//                                        // redeliveries — the record id
//     "occurredAt": "…ISO…",
//     "workspace": { "id": "…" },
//     "eventType": "conferenceRecordUpdated" | "conferenceSessionEnded" |
//                  "transcriptReady" | "recordingReady" | "accessDenied",
//     "conferenceRecord": { "meetingId": "…", "title": "…", "agenda": "…",
//                           "scheduledStart": "…", "scheduledEnd": "…",
//                           "host": { "userId": "…", "name": "…", "email": "…" } },
//     "session": { "sessionId": "…", "startedAt": "…", "endedAt": "…",
//                  "participants": [{ "userId": "…", "name": "…", "email": "…",
//                                     "joinedAt": "…", "leftAt": "…" }] },
//     "transcript": { "transcriptId": "…", "language": "…",
//                     "segments": [{ "userId": "…", "speakerName": "…",
//                                    "startedAt": "…", "endedAt": "…", "text": "…",
//                                    "confidence": … }] },
//     "recording": { "recordingId": "…", "name": "…", "mediaType": "video/mp4",
//                    "sizeBytes": …, "storageRef": "…", "checksum": "…" },
//     "access": { "code": "not_found" | "recording_unavailable" |
//                         "transcript_unavailable", "detail": "…",
//                 "meetingId": "…" }
//   }
//
// Meet resource names arrive `spaces/…`-qualified; the adapter accepts
// either the bare id or the `kind/id` form and canonicalizes onto the
// bare id (the canonical, adapter-normalized form).

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

/** `kind/id`-qualified resource names canonicalize onto the bare id. */
function bareResourceId(raw: string): string {
  const text = raw.trim();
  if (text === '') {
    throw new MeetingsError(
      'invalid_provider_payload',
      'resource id must be a non-empty string',
    );
  }
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

const ACCESS_CODES: Record<string, 'not_found' | 'recording_unavailable' | 'transcript_unavailable'> = {
  not_found: 'not_found',
  recording_unavailable: 'recording_unavailable',
  transcript_unavailable: 'transcript_unavailable',
};

export const googleMeetAdapter: MeetingAdapter = {
  provider: 'google-meet',
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
    return bareResourceId(raw);
  },

  parseWebhook(payload: unknown): MeetingWebhookParseResult {
    const envelope = requireObject(payload, 'the google-meet envelope');
    if (envelope.handshake !== undefined) {
      unsupportedEvent('google-meet handshake envelopes carry no records');
    }
    const eventId = requireString(envelope.eventUuid, 'eventUuid');
    const occurredAt = requireIsoInstant(envelope.occurredAt, 'occurredAt');
    const workspace = requireObject(envelope.workspace, 'workspace');
    const providerAccountId = this.normalizeAccountId(
      requireString(workspace.id, 'workspace.id'),
    );
    const eventType = requireString(envelope.eventType, 'eventType');
    const conferenceRecord = () =>
      requireObject(envelope.conferenceRecord, 'conferenceRecord');
    const sessionObject = () => requireObject(envelope.session, 'session');

    switch (eventType) {
      case 'conferenceRecordUpdated': {
        const record = conferenceRecord();
        const host = record.host === undefined || record.host === null
          ? null
          : (() => {
              const hostObject = requireObject(record.host, 'conferenceRecord.host');
              return participant(
                this.normalizeParticipantId(
                  requireString(hostObject.userId, 'conferenceRecord.host.userId'),
                ),
                optionalString(hostObject.name, 'conferenceRecord.host.name'),
                optionalString(hostObject.email, 'conferenceRecord.host.email'),
              );
            })();
        return {
          providerAccountId,
          records: [
            {
              kind: 'meeting.updated',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: bareResourceId(
                requireString(record.meetingId, 'conferenceRecord.meetingId'),
              ),
              title: optionalString(record.title, 'conferenceRecord.title'),
              agenda: optionalString(record.agenda, 'conferenceRecord.agenda'),
              scheduledStartAt: optionalIsoInstant(
                record.scheduledStart,
                'conferenceRecord.scheduledStart',
              ),
              scheduledEndAt: optionalIsoInstant(
                record.scheduledEnd,
                'conferenceRecord.scheduledEnd',
              ),
              underlyingPlatform: 'google-meet',
              host,
            },
          ],
        };
      }

      case 'conferenceSessionEnded': {
        const session = sessionObject();
        const rawParticipants = session.participants === undefined ? [] : session.participants;
        if (!Array.isArray(rawParticipants)) {
          throw new MeetingsError(
            'invalid_provider_payload',
            'session.participants must be an array',
          );
        }
        const participants = rawParticipants.map((entry, index) => {
          const who = requireObject(entry, `session.participants[${index}]`);
          return attendance(
            participant(
              this.normalizeParticipantId(
                requireString(who.userId, `session.participants[${index}].userId`),
              ),
              optionalString(who.name, `session.participants[${index}].name`),
              optionalString(who.email, `session.participants[${index}].email`),
            ),
            optionalIsoInstant(who.joinedAt, `session.participants[${index}].joinedAt`),
            optionalIsoInstant(who.leftAt, `session.participants[${index}].leftAt`),
          );
        });
        return {
          providerAccountId,
          records: [
            {
              kind: 'session.updated',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: bareResourceId(
                requireString(conferenceRecord().meetingId, 'conferenceRecord.meetingId'),
              ),
              providerSessionId: bareResourceId(
                requireString(session.sessionId, 'session.sessionId'),
              ),
              status: 'ended',
              title: optionalString(session.title, 'session.title'),
              startedAt: optionalIsoInstant(session.startedAt, 'session.startedAt'),
              endedAt: requireIsoInstant(session.endedAt, 'session.endedAt'),
              participants,
            },
          ],
        };
      }

      case 'transcriptReady': {
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
            seg.userId,
            `transcript.segments[${index}].userId`,
          );
          const confidence =
            seg.confidence === undefined || seg.confidence === null ? null : (seg.confidence as number);
          return segment(
            providerParticipantId === null
              ? null
              : this.normalizeParticipantId(providerParticipantId),
            optionalString(seg.speakerName, `transcript.segments[${index}].speakerName`),
            requireIsoInstant(seg.startedAt, `transcript.segments[${index}].startedAt`),
            optionalIsoInstant(seg.endedAt, `transcript.segments[${index}].endedAt`),
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
              providerMeetingId: bareResourceId(
                requireString(conferenceRecord().meetingId, 'conferenceRecord.meetingId'),
              ),
              providerSessionId: bareResourceId(
                requireString(sessionObject().sessionId, 'session.sessionId'),
              ),
              providerTranscriptId: bareResourceId(
                requireString(transcript.transcriptId, 'transcript.transcriptId'),
              ),
              language: optionalString(transcript.language, 'transcript.language'),
              segments,
            },
          ],
        };
      }

      case 'recordingReady': {
        const recording = requireObject(envelope.recording, 'recording');
        const sizeBytes =
          recording.sizeBytes === undefined || recording.sizeBytes === null
            ? null
            : (recording.sizeBytes as number);
        return {
          providerAccountId,
          records: [
            {
              kind: 'artifact.available',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId: bareResourceId(
                requireString(conferenceRecord().meetingId, 'conferenceRecord.meetingId'),
              ),
              providerSessionId: bareResourceId(
                requireString(sessionObject().sessionId, 'session.sessionId'),
              ),
              providerArtifactId: bareResourceId(
                requireString(recording.recordingId, 'recording.recordingId'),
              ),
              artifactKind: 'recording',
              displayName: optionalString(recording.name, 'recording.name'),
              mediaType: optionalString(recording.mediaType, 'recording.mediaType'),
              byteSize: sizeBytes,
              storageRef: optionalString(recording.storageRef, 'recording.storageRef'),
              checksum: optionalString(recording.checksum, 'recording.checksum'),
            },
          ],
        };
      }

      case 'accessDenied': {
        const access = requireObject(envelope.access, 'access');
        const code = ACCESS_CODES[requireString(access.code, 'access.code')];
        if (code === undefined) {
          throw new MeetingsError(
            'invalid_provider_payload',
            `access.code '${String(access.code)}' is not a recognized google-meet access code`,
          );
        }
        return {
          providerAccountId,
          records: [
            {
              kind: 'access.failed',
              providerRecordId: eventId,
              occurredAt,
              providerMeetingId:
                access.meetingId === undefined || access.meetingId === null
                  ? null
                  : bareResourceId(requireString(access.meetingId, 'access.meetingId')),
              accessCode: code,
              detail: optionalString(access.detail, 'access.detail'),
            },
          ],
        };
      }

      default:
        throw new MeetingsError(
          'unsupported_provider_event',
          `google-meet eventType '${eventType}' carries no meeting-intelligence records`,
        );
    }
  },
};
