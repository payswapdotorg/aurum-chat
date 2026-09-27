// Meeting intelligence surface (W104 — J17) — the view builders.
//
// Server-side composition of EXISTING module contracts only (lock 31/32:
// contracts, never persistence) — the discipline the intelligence,
// learning and connections surfaces follow. Two views:
//
//   buildMeetingsHomeView — the /meetings hub: the captured meetings
//     (with session counts and last-activity, one link per meeting),
//     the registered capture connections, the participant identity
//     registry and the explicit access-failure history.
//   buildMeetingDetailView — one meeting: its metadata, every captured
//     session with attendance, and each session's transcripts and
//     artifacts (progressive disclosure on the page; the evidence
//     observation link rides every captured row).
//
// Honesty rules (the intelligence surface's discipline):
//   * a FAILING read renders an empty section plus a `degraded` note —
//     never fake emptiness, never a crash;
//   * a MISSING record throws the owning contract's not-found error for
//     the page to render its honest not-found state;
//   * nothing here is persisted — views are derived, the contract owns
//     the truth.
//
// Tenancy (ADR-0001): every builder takes the EXPLICIT TenantContext;
// another tenant's records read as missing (the contract's own
// `*_not_found` — no existence leak).

import type { TenantContext } from '@/infra/tenant';
import {
  getMeeting,
  listMeetingAccessEvents,
  listMeetingArtifacts,
  listMeetingConnections,
  listMeetingParticipants,
  listMeetings,
  listMeetingSessions,
  listMeetingTranscripts,
} from '@/modules/meetings/contract';
import type {
  Meeting,
  MeetingAccessCode,
  MeetingAccessEvent,
  MeetingArtifactKind,
  MeetingConnection,
  MeetingIngestionMode,
  MeetingParticipant,
  MeetingSessionStatus,
  MeetingTranscript,
} from '@/modules/meetings/contract';

// ---------------------------------------------------------------------------
// Row shapes (serialized server → page; labels resolved at render)
// ---------------------------------------------------------------------------

/** How many meetings the hub list carries (the surface stays calm). */
export const HOME_ROW_LIMIT = 30;

/**
 * How many sessions the hub reads to compute counts/last-activity in ONE
 * call (the module's own MAX_LIST_LIMIT is 500 — the count is honest for
 * every tenant the calm surface can show).
 */
export const SESSION_WINDOW_LIMIT = 500;

/** One captured meeting row of the hub list. */
export interface MeetingRow {
  id: string;
  /** The provider title, or the honest untitled fallback. */
  title: string;
  provider: string;
  agenda: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  /** Sessions captured for this meeting (from the session window). */
  sessionCount: number;
  /** The most recent session activity (endedAt ?? startedAt), when any. */
  lastActivityAt: string | null;
  href: string;
}

/** One registered capture connection. */
export interface CaptureConnectionRow {
  id: string;
  provider: string;
  providerAccountId: string;
  displayName: string | null;
  status: 'active' | 'disabled';
  modes: MeetingIngestionMode[];
  oauthExpiresAt: string | null;
  updatedAt: string;
}

/** One participant identity row (provider-minted, resolved when known). */
export interface ParticipantRow {
  id: string;
  provider: string;
  displayName: string | null;
  email: string | null;
  /** Resolved onto an organizational person through the verified-email bridge. */
  resolved: boolean;
  lastSeenAt: string;
}

/** One explicit access-failure row (append-only history). */
export interface AccessEventRow {
  id: string;
  provider: string;
  code: MeetingAccessCode;
  detail: string | null;
  occurredAt: string;
}

/** The /meetings hub view. */
export interface MeetingsHomeView {
  generatedAt: string;
  meetings: MeetingRow[];
  connections: CaptureConnectionRow[];
  participants: ParticipantRow[];
  accessEvents: AccessEventRow[];
  degraded: string[];
}

// ---------------------------------------------------------------------------
// buildMeetingsHomeView
// ---------------------------------------------------------------------------

async function safe<T>(family: string, degraded: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

export async function buildMeetingsHomeView(ctx: TenantContext): Promise<MeetingsHomeView> {
  const degraded: string[] = [];

  const [meetings, sessions, connections, participants, accessEvents] = await Promise.all([
    safe('meetings', degraded, () => listMeetings(ctx, { limit: HOME_ROW_LIMIT })),
    safe('sessions', degraded, () => listMeetingSessions(ctx, { limit: SESSION_WINDOW_LIMIT })),
    safe('meeting-connections', degraded, () => listMeetingConnections(ctx, {})),
    safe('participants', degraded, () => listMeetingParticipants(ctx, { limit: 24 })),
    safe('access-events', degraded, () => listMeetingAccessEvents(ctx, { limit: 12 })),
  ]);

  const byMeeting = new Map<string, { count: number; last: string | null }>();
  for (const session of sessions ?? []) {
    const entry = byMeeting.get(session.meetingId) ?? { count: 0, last: null };
    entry.count += 1;
    const activity = session.endedAt ?? session.startedAt;
    if (activity !== null && (entry.last === null || activity > entry.last)) {
      entry.last = activity;
    }
    byMeeting.set(session.meetingId, entry);
  }

  const rows: MeetingRow[] = (meetings ?? []).map((meeting) => {
    const entry = byMeeting.get(meeting.id);
    return {
      id: meeting.id,
      title: meeting.title ?? 'An untitled meeting',
      provider: meeting.provider,
      agenda: meeting.agenda,
      scheduledStartAt: meeting.scheduledStartAt,
      scheduledEndAt: meeting.scheduledEndAt,
      sessionCount: entry?.count ?? 0,
      lastActivityAt: entry?.last ?? null,
      href: `/meetings/${meeting.id}`,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    meetings: rows,
    connections: (connections ?? []).map(toConnectionRow),
    participants: (participants ?? []).map(toParticipantRow),
    accessEvents: (accessEvents ?? []).map(toAccessEventRow),
    degraded: [...new Set(degraded)],
  };
}

function toConnectionRow(connection: MeetingConnection): CaptureConnectionRow {
  return {
    id: connection.id,
    provider: connection.provider,
    providerAccountId: connection.providerAccountId,
    displayName: connection.displayName,
    status: connection.status,
    modes: [...connection.modes],
    oauthExpiresAt: connection.oauthExpiresAt,
    updatedAt: connection.updatedAt,
  };
}

function toParticipantRow(participant: MeetingParticipant): ParticipantRow {
  return {
    id: participant.id,
    provider: participant.provider,
    displayName: participant.displayName,
    email: participant.email,
    resolved: participant.subjectId !== null,
    lastSeenAt: participant.lastSeenAt,
  };
}

function toAccessEventRow(event: MeetingAccessEvent): AccessEventRow {
  return {
    id: event.id,
    provider: event.provider,
    code: event.code,
    detail: event.detail,
    occurredAt: event.occurredAt,
  };
}

// ---------------------------------------------------------------------------
// buildMeetingDetailView
// ---------------------------------------------------------------------------

/** How many sessions the detail view reads per meeting. */
export const DETAIL_SESSION_LIMIT = 12;

/** How many transcripts/artifacts the detail view reads per session. */
export const DETAIL_CAPTURE_LIMIT = 10;

/** One transcript of a session (its evidence link rides along). */
export interface TranscriptView {
  id: string;
  language: string | null;
  segmentCount: number;
  /** The first words of the transcript, for the row summary. */
  preview: string;
  evidenceObservationId: string;
  capturedAt: string;
}

/** One artifact of a session. */
export interface ArtifactView {
  id: string;
  kind: MeetingArtifactKind;
  displayName: string | null;
  mediaType: string | null;
  byteSize: number | null;
  evidenceObservationId: string;
  capturedAt: string;
}

/** One session of the meeting, with its captures and attendance. */
export interface SessionDetailView {
  id: string;
  status: MeetingSessionStatus;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  participants: {
    participantId: string;
    displayName: string | null;
    email: string | null;
    joinedAt: string | null;
    leftAt: string | null;
  }[];
  transcripts: TranscriptView[];
  artifacts: ArtifactView[];
}

/** The /meetings/[meetingId] detail view. */
export interface MeetingDetailView {
  meeting: Meeting;
  sessions: SessionDetailView[];
  degraded: string[];
}

function transcriptPreview(transcript: MeetingTranscript): string {
  const words: string[] = [];
  for (const segment of transcript.segments) {
    for (const word of segment.text.split(/\s+/)) {
      if (word !== '') words.push(word);
      if (words.length >= 18) break;
    }
    if (words.length >= 18) break;
  }
  const joined = words.join(' ');
  return joined === '' ? '(an empty transcript)' : `${joined}…`;
}

export async function buildMeetingDetailView(
  ctx: TenantContext,
  meetingId: string,
): Promise<MeetingDetailView> {
  const degraded: string[] = [];

  // A missing/foreign meeting throws meeting_not_found — the page's
  // honest not-found state (uniform discipline, no existence leak).
  const meeting = await getMeeting(ctx, meetingId);

  const sessions = await safe('sessions', degraded, () =>
    listMeetingSessions(ctx, { meetingId, limit: DETAIL_SESSION_LIMIT }),
  );

  const detailed: SessionDetailView[] = [];
  for (const session of sessions ?? []) {
    // Per-session captures: transcripts and artifacts attach to the
    // SESSION (one occurrence) — bounded, honest reads of each family.
    const [transcripts, artifacts] = await Promise.all([
      safe('transcripts', degraded, () =>
        listMeetingTranscripts(ctx, { sessionId: session.id, limit: DETAIL_CAPTURE_LIMIT }),
      ),
      safe('artifacts', degraded, () =>
        listMeetingArtifacts(ctx, { sessionId: session.id, limit: DETAIL_CAPTURE_LIMIT }),
      ),
    ]);
    detailed.push({
      id: session.id,
      status: session.status,
      title: session.title,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      participants: session.participants.map((participant) => ({
        participantId: participant.participantId,
        displayName: participant.displayName,
        email: participant.email,
        joinedAt: participant.joinedAt,
        leftAt: participant.leftAt,
      })),
      transcripts: (transcripts ?? []).map((transcript) => ({
        id: transcript.id,
        language: transcript.language,
        segmentCount: transcript.segments.length,
        preview: transcriptPreview(transcript),
        evidenceObservationId: transcript.evidenceObservationId,
        capturedAt: transcript.capturedAt,
      })),
      artifacts: (artifacts ?? []).map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        displayName: artifact.displayName,
        mediaType: artifact.mediaType,
        byteSize: artifact.byteSize,
        evidenceObservationId: artifact.evidenceObservationId,
        capturedAt: artifact.capturedAt,
      })),
    });
  }

  return { meeting, sessions: detailed, degraded: [...new Set(degraded)] };
}
