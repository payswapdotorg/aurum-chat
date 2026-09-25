// The canonical realtime-adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical realtime transport provider (W086). Adapters
// are the ONLY place where provider-native event envelopes, account-id
// semantics, participant-id semantics and failure-classification rules
// exist (lock 16 / MODULE-DEPENDENCY-MAP provider boundaries;
// IMPLEMENTATION-STACK §6: provider SDKs may only be imported inside
// src/modules/realtime/). Nothing in `adapters/` is exported through the
// module contract — the public surface speaks purely canonical types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// provider reality into canonical values. Persistence, participant
// registration, dedupe and observation recording are the service's job;
// the actual room/media I/O belongs to the provider-neutral transport
// port (types.ts), whose real implementations also live in this folder.
//
// The event-id discipline (the dedupe contract): every adapter emits
// `providerEventId` = the provider's own STABLE id for the delivered
// event. Redelivering the same envelope therefore produces the same ids
// and is suppressed by the event ledger; distinct provider events are
// distinct records with distinct ids.
//
// The agent identity discipline: Aurum's own participant identity in a
// room is ADAPTER-MINTED and deterministic per session
// (`agentParticipantId(sessionId)`), so the domain can pass it to the
// transport on startRoom, register Aurum's participant row, and attribute
// Aurum's spoken turns — without any provider object crossing the seam.

import type { CanonicalRealtimeEvent, RealtimeProvider } from '../types';

/** What a provider's event adapter produces from one envelope. */
export interface RealtimeEventParseResult {
  /** The tenant's provider account the envelope belongs to (opaque). */
  providerAccountId: string;
  /** Canonical events extracted from the envelope (possibly many). */
  events: CanonicalRealtimeEvent[];
}

export interface RealtimeAdapter {
  readonly provider: RealtimeProvider;

  /**
   * Canonicalizes a raw provider account id supplied by a caller
   * (connection registration, event account resolution). Throws
   * `invalid_realtime_input` when the value cannot be canonical.
   */
  normalizeAccountId(raw: string): string;

  /**
   * Canonicalizes a raw provider participant id supplied by an adapter or
   * transport — the participant registry keys on it. Throws
   * `invalid_provider_payload` when the value cannot be canonical.
   */
  normalizeParticipantId(raw: string): string;

  /**
   * Aurum's own participant identity for one session (deterministic,
   * provider-appropriate — e.g. what the LiveKit agent joins as).
   */
  agentParticipantId(sessionId: string): string;

  /**
   * Parses one provider event envelope into the account it belongs to
   * and its canonical events. Throws `invalid_provider_payload` when the
   * envelope is malformed and `unsupported_provider_event` when it is a
   * recognized-but-non-record event (verification handshakes, pings…).
   */
  parseEvent(payload: unknown): RealtimeEventParseResult;
}
