// The canonical meeting-adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical meeting provider (W085). Adapters are the ONLY
// place where provider-native webhook envelopes, account-id semantics,
// participant-id semantics and event-classification rules exist (lock 16 /
// MODULE-DEPENDENCY-MAP provider boundaries; IMPLEMENTATION-STACK §6:
// provider SDKs may only be imported inside src/modules/meetings/).
// Nothing in `adapters/` is exported through the module contract — the
// public surface speaks purely canonical types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// provider reality into canonical values. Persistence, participant
// registration, dedupe and observation recording are the service's job;
// the actual polling network I/O belongs to the provider-neutral transport
// port (types.ts), whose real implementations also live in this folder.
//
// The record-id discipline (the dedupe contract): every adapter emits
// `providerRecordId` = the provider's own STABLE id for the delivered
// record — the provider's event id for webhook event deliveries, or the
// provider's domain-object id (with its revision discriminator when the
// provider supplies one) for object snapshots. Redelivering the same
// webhook envelope therefore produces the same ids and is suppressed by
// the ingestion ledger; distinct provider events (a session that starts,
// then ends) are distinct records with distinct ids.

import type { CanonicalMeetingRecord, MeetingIngestionMode, MeetingProvider } from '../types';
import type { ValidatedParticipant } from '../validation';

/** What a provider's webhook adapter produces from one envelope. */
export interface MeetingWebhookParseResult {
  /** The tenant's provider account the envelope belongs to (opaque). */
  providerAccountId: string;
  /** Canonical records extracted from the envelope (possibly many). */
  records: CanonicalMeetingRecord[];
}

export interface MeetingAdapter {
  readonly provider: MeetingProvider;
  /** Capture modes this provider supports (polling and/or webhook). */
  readonly modes: readonly MeetingIngestionMode[];

  /**
   * Canonicalizes a raw provider account id supplied by a caller
   * (connection registration, webhook account resolution). Throws
   * `invalid_meeting_input` when the value cannot be canonical.
   */
  normalizeAccountId(raw: string): string;

  /**
   * Canonicalizes a raw provider participant id supplied by an adapter or
   * transport — the participant registry keys on it. Throws
   * `invalid_provider_payload` when the value cannot be canonical.
   */
  normalizeParticipantId(raw: string): string;

  /**
   * Parses one provider webhook envelope into the account it belongs to
   * and its canonical records. Throws `invalid_provider_payload` when the
   * envelope is malformed and `unsupported_provider_event` when it is a
   * recognized-but-non-record event (verification handshakes, pings, …).
   */
  parseWebhook(payload: unknown): MeetingWebhookParseResult;
}

// ---------------------------------------------------------------------------
// Shared construction helpers (used by every adapter)
// ---------------------------------------------------------------------------

/** Builds one canonical participant (adapter-side convenience). */
export function participant(
  providerParticipantId: string,
  displayName: string | null,
  email: string | null,
): { providerParticipantId: string; displayName: string | null; email: string | null } {
  return { providerParticipantId, displayName, email };
}

/** Builds one canonical attendance entry (adapter-side convenience). */
export function attendance(
  who: { providerParticipantId: string; displayName: string | null; email: string | null },
  joinedAt: string | null,
  leftAt: string | null,
): {
  participant: { providerParticipantId: string; displayName: string | null; email: string | null };
  joinedAt: string | null;
  leftAt: string | null;
} {
  return { participant: who, joinedAt, leftAt };
}

/** Builds one canonical transcript segment (adapter-side convenience). */
export function segment(
  providerParticipantId: string | null,
  speakerName: string | null,
  startedAt: string,
  endedAt: string | null,
  text: string,
  confidence: number | null,
): {
  providerParticipantId: string | null;
  speakerName: string | null;
  startedAt: string;
  endedAt: string | null;
  text: string;
  confidence: number | null;
} {
  return { providerParticipantId, speakerName, startedAt, endedAt, text, confidence };
}

/** The host participant shape shared by the record builders (validated downstream). */
export type { ValidatedParticipant };
