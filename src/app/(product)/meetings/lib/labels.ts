// Meeting intelligence surface (W104 — J17) — the pure label/format layer.
//
// Everything here is a total function over the meetings module's CONTRACT
// vocabulary (providers, connection statuses, session statuses, artifact
// kinds, access codes): the human copy the pages and the tests share, so
// the vocabularies can never drift (the /ai, learning and developer
// labels discipline). Color never carries meaning alone — every status
// maps to a tone AND a label; the pill component pairs them.

import type { PillTone } from '../../lib/states';
import type {
  MeetingAccessCode,
  MeetingArtifactKind,
  MeetingAuthKind,
  MeetingConnectionStatus,
  MeetingIngestionMode,
  MeetingSessionStatus,
} from '@/modules/meetings/contract';

// CLIENT-SAFETY (the shell's navigation.ts discipline): this module stays
// free of server-only imports by construction (type-only contract
// import; pure functions only).

/** Compact date: "Sep 24, 2026" — falls back to the raw string. */
export function dateLabel(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Compact date+time: "Sep 24, 09:00" — falls back to the raw string. */
export function dateTimeLabel(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString('en', { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString(
    'en',
    { hour: '2-digit', minute: '2-digit', hour12: false },
  )}`;
}

/** Provider key → user-facing platform name. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case 'zoom':
      return 'Zoom';
    case 'microsoft-teams':
      return 'Microsoft Teams';
    case 'google-meet':
      return 'Google Meet';
    case 'recall':
      return 'Recall (meeting bot)';
    default:
      return provider;
  }
}

export function connectionStatusLabel(status: MeetingConnectionStatus): string {
  return status === 'active' ? 'Capturing' : 'Disabled';
}

export function connectionStatusTone(status: MeetingConnectionStatus): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}

export function sessionStatusLabel(status: MeetingSessionStatus): string {
  switch (status) {
    case 'scheduled':
      return 'Scheduled';
    case 'started':
      return 'Happening now';
    case 'ended':
      return 'Ended';
    default:
      return status;
  }
}

export function sessionStatusTone(status: MeetingSessionStatus): PillTone {
  switch (status) {
    case 'started':
      return 'positive';
    case 'ended':
      return 'info';
    default:
      return 'info';
  }
}

export function authKindLabel(kind: MeetingAuthKind): string {
  switch (kind) {
    case 'oauth':
      return 'OAuth grant';
    case 'credentials':
      return 'API credentials';
    default:
      return kind;
  }
}

export function ingestionModeLabel(mode: MeetingIngestionMode): string {
  return mode === 'webhook' ? 'Provider webhooks' : 'Scheduled polling';
}

export function artifactKindLabel(kind: MeetingArtifactKind): string {
  switch (kind) {
    case 'recording':
      return 'Recording';
    case 'chat':
      return 'In-meeting chat';
    case 'summary':
      return 'Provider summary';
    case 'document':
      return 'Shared document';
    case 'attachment':
      return 'Attachment';
    default:
      return kind;
  }
}

export function accessCodeLabel(code: MeetingAccessCode): string {
  return code.replaceAll('_', ' ');
}

export function accessCodeTone(code: MeetingAccessCode): PillTone {
  return code === 'recording_unavailable' || code === 'authorization_expired'
    ? 'warning'
    : 'error';
}

/** The page's standing explanation of what this surface is. */
export const MEETING_INTELLIGENCE_NOTE =
  'Meeting intelligence is captured, not guessed: a registered capture connection (a Zoom workspace, a Teams tenant, a Meet workspace or a meeting bot) delivers metadata, sessions, participants, transcripts and artifacts through its provider webhooks or scheduled polling — every captured record also lands in the immutable evidence model as an observation. This surface reads that registry; it never edits capture state.';

/**
 * The honest environment note for capture connections with no wired
 * transport: polling fails explicitly with provider_unavailable (the
 * module's own report) until one is wired — webhook capture keeps
 * working. Mirrored in the unit tests so the words are the product.
 */
export const CAPTURE_TRANSPORT_NOTE =
  'No fetch transport is wired by default: scheduled polling fails explicitly with provider_unavailable (retryable, recorded as an access event) until an operator wires one — provider webhook capture is unaffected. Nothing here fakes a capture.';
