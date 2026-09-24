// Microsoft Teams adapter (MODULE-INTERNAL). Envelope shape the Teams
// transport delivers (a Graph-change-notification-style webhook body —
// one notification id per delivery, tenant-scoped):
//
//   {
//     "id": "…",                      // the notification id — the record id
//     "tenantId": "…",
//     "occurredAt": "…ISO…",
//     "changeType": "onlineMeetingUpdated" | "callStarted" | "callEnded" |
//                   "transcriptReady" | "recordingReady" | "accessDenied",
//     "resourceData": {
//       "onlineMeetingId": "…", "callId": "…",
//       "title": "…", "agenda": "…", "scheduledStart": "…", "scheduledEnd": "…",
//       "host": { "aadId": "…", "displayName": "…", "email": "…" },
//       "startedAt": "…", "endedAt": "…",
//       "participants": [{ "aadId": "…", "displayName": "…", "email": "…",
//                          "joinedAt": "…", "leftAt": "…" }],
//       "transcript": { "id": "…", "language": "…",
//                       "segments": [{ "participantId": "…", "speakerName": "…",
//                                      "startedAt": "…", "endedAt": "…", "text": "…",
//                                      "confidence": … }] },
//       "recording": { "id": "…", "displayName": "…", "mediaType": "video/mp4",
//                      "sizeBytes": …, "storageRef": "…", "checksum": "…" },
//       "access": { "code": "access_denied", "detail": "…" }
//     }
//   }
//
// Teams ids are Entra GUIDs — the adapter lowercases them so the canonical
// account/participant registries key consistently regardless of the casing
// the provider emitted.

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

function lowercased(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (text === '') {
    throw new MeetingsError(
      'invalid_provider_payload',
      'participant id must be a non-empty string',
    );
  }
  return text;
}

export const microsoftTeamsAdapter: MeetingAdapter = {
  provider: 'microsoft-teams',
  modes: ['webhook', 'polling'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim().toLowerCase();
    if (text === '') {
      throw new MeetingsError(
        'invalid_meeting_input',
        'providerAccountId must be a non-empty string',
      );
    }
    return text;
  },

  normalizeParticipantId(raw: string): string {
    return lowercased(raw);
  },

  parseWebhook(payload: unknown): MeetingWebhookParseResult {
    const envelope = requireObject(payload, 'the microsoft-teams envelope');
    if (envelope.validationToken !== undefined) {
      unsupportedEvent('microsoft-teams validation handshakes carry no records');
    }
    const notificationId = requireString(envelope.id, 'id');
    const occurredAt = requireIsoInstant(envelope.occurredAt, 'occurredAt');
    const providerAccountId = this.normalizeAccountId(
      requireString(envelope.tenantId, 'tenantId'),
    );
    const data = requireObject(envelope.resourceData, 'resourceData');
    const changeType = requireString(envelope.changeType, 'changeType');
    const onlineMeetingId = () => requireString(data.onlineMeetingId, 'resourceData.onlineMeetingId');
    const callId = () => requireString(data.callId, 'resourceData.callId');

    switch (changeType) {
      case 'onlineMeetingUpdated': {
        const host = data.host === undefined || data.host === null
          ? null
          : (() => {
              const hostObject = requireObject(data.host, 'resourceData.host');
              return participant(
                this.normalizeParticipantId(
                  requireString(hostObject.aadId, 'resourceData.host.aadId'),
                ),
                optionalString(hostObject.displayName, 'resourceData.host.displayName'),
                optionalString(hostObject.email, 'resourceData.host.email'),
              );
            })();
        return {
          providerAccountId,
          records: [
            {
              kind: 'meeting.updated',
              providerRecordId: notificationId,
              occurredAt,
              providerMeetingId: onlineMeetingId(),
              title: optionalString(data.title, 'resourceData.title'),
              agenda: optionalString(data.agenda, 'resourceData.agenda'),
              scheduledStartAt: optionalIsoInstant(
                data.scheduledStart,
                'resourceData.scheduledStart',
              ),
              scheduledEndAt: optionalIsoInstant(data.scheduledEnd, 'resourceData.scheduledEnd'),
              underlyingPlatform: 'microsoft-teams',
              host,
            },
          ],
        };
      }

      case 'callStarted':
      case 'callEnded': {
        const rawParticipants = data.participants === undefined ? [] : data.participants;
        if (!Array.isArray(rawParticipants)) {
          throw new MeetingsError(
            'invalid_provider_payload',
            'resourceData.participants must be an array',
          );
        }
        const participants = rawParticipants.map((entry, index) => {
          const who = requireObject(entry, `resourceData.participants[${index}]`);
          return attendance(
            participant(
              this.normalizeParticipantId(
                requireString(who.aadId, `resourceData.participants[${index}].aadId`),
              ),
              optionalString(who.displayName, `resourceData.participants[${index}].displayName`),
              optionalString(who.email, `resourceData.participants[${index}].email`),
            ),
            optionalIsoInstant(who.joinedAt, `resourceData.participants[${index}].joinedAt`),
            optionalIsoInstant(who.leftAt, `resourceData.participants[${index}].leftAt`),
          );
        });
        return {
          providerAccountId,
          records: [
            {
              kind: 'session.updated',
              providerRecordId: notificationId,
              occurredAt,
              providerMeetingId: onlineMeetingId(),
              providerSessionId: callId(),
              status: changeType === 'callStarted' ? 'started' : 'ended',
              title: optionalString(data.title, 'resourceData.title'),
              startedAt: optionalIsoInstant(data.startedAt, 'resourceData.startedAt'),
              endedAt: optionalIsoInstant(data.endedAt, 'resourceData.endedAt'),
              participants,
            },
          ],
        };
      }

      case 'transcriptReady': {
        const transcript = requireObject(data.transcript, 'resourceData.transcript');
        const rawSegments = transcript.segments;
        if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
          throw new MeetingsError(
            'invalid_provider_payload',
            'resourceData.transcript.segments must be a non-empty array',
          );
        }
        const segments = rawSegments.map((entry, index) => {
          const seg = requireObject(entry, `resourceData.transcript.segments[${index}]`);
          const providerParticipantId = optionalString(
            seg.participantId,
            `resourceData.transcript.segments[${index}].participantId`,
          );
          const confidence =
            seg.confidence === undefined || seg.confidence === null ? null : (seg.confidence as number);
          return segment(
            providerParticipantId === null
              ? null
              : this.normalizeParticipantId(providerParticipantId),
            optionalString(seg.speakerName, `resourceData.transcript.segments[${index}].speakerName`),
            requireIsoInstant(seg.startedAt, `resourceData.transcript.segments[${index}].startedAt`),
            optionalIsoInstant(seg.endedAt, `resourceData.transcript.segments[${index}].endedAt`),
            requireString(seg.text, `resourceData.transcript.segments[${index}].text`),
            confidence,
          );
        });
        return {
          providerAccountId,
          records: [
            {
              kind: 'transcript.available',
              providerRecordId: notificationId,
              occurredAt,
              providerMeetingId: onlineMeetingId(),
              providerSessionId: callId(),
              providerTranscriptId: requireString(transcript.id, 'resourceData.transcript.id'),
              language: optionalString(transcript.language, 'resourceData.transcript.language'),
              segments,
            },
          ],
        };
      }

      case 'recordingReady': {
        const recording = requireObject(data.recording, 'resourceData.recording');
        const sizeBytes =
          recording.sizeBytes === undefined || recording.sizeBytes === null
            ? null
            : (recording.sizeBytes as number);
        return {
          providerAccountId,
          records: [
            {
              kind: 'artifact.available',
              providerRecordId: notificationId,
              occurredAt,
              providerMeetingId: onlineMeetingId(),
              providerSessionId: callId(),
              providerArtifactId: requireString(recording.id, 'resourceData.recording.id'),
              artifactKind: 'recording',
              displayName: optionalString(recording.displayName, 'resourceData.recording.displayName'),
              mediaType: optionalString(recording.mediaType, 'resourceData.recording.mediaType'),
              byteSize: sizeBytes,
              storageRef: optionalString(recording.storageRef, 'resourceData.recording.storageRef'),
              checksum: optionalString(recording.checksum, 'resourceData.recording.checksum'),
            },
          ],
        };
      }

      case 'accessDenied': {
        const access = requireObject(data.access, 'resourceData.access');
        const code = requireString(access.code, 'resourceData.access.code');
        if (code !== 'access_denied') {
          throw new MeetingsError(
            'invalid_provider_payload',
            `resourceData.access.code '${code}' is not a recognized microsoft-teams access code`,
          );
        }
        return {
          providerAccountId,
          records: [
            {
              kind: 'access.failed',
              providerRecordId: notificationId,
              occurredAt,
              providerMeetingId: null,
              accessCode: 'access_denied',
              detail: optionalString(access.detail, 'resourceData.access.detail'),
            },
          ],
        };
      }

      default:
        throw new MeetingsError(
          'unsupported_provider_event',
          `microsoft-teams changeType '${changeType}' carries no meeting-intelligence records`,
        );
    }
  },
};
