// The canonical telecom-adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical telecom provider (W087 "multiple telecom
// adapters"). Adapters are the ONLY place where vendor-native webhook
// envelopes, account-id semantics, delivery-receipt classification and
// call-lifecycle mapping exist (lock 16 / MODULE-DEPENDENCY-MAP provider
// boundaries; IMPLEMENTATION-STACK §6: vendor SDKs may only be imported
// inside src/modules/cellular/). Nothing in `adapters/` is exported
// through the module contract — the public surface speaks purely
// canonical types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// vendor reality into canonical values. Persistence, recipient
// resolution, dedupe and reply correlation are the service's job; the
// actual SMS/voice I/O belongs to the provider-neutral transport port
// (types.ts), whose real vendor implementations also live in this
// folder.
//
// The event-id discipline (the dedupe contract, realtime/channels
// discipline): every adapter emits `providerEventId` = the vendor's own
// STABLE id for the delivered event. Redelivering the same envelope
// produces the same id and is suppressed by the event ledger; distinct
// vendor events are distinct records with distinct ids.
//
// The channels-relay discipline (the W030 dependency seam): message-
// shaped events (SMS replies, call speech) additionally carry the
// carrier-webhook envelope the CHANNELS module's canonical inbound edge
// documents — "a carrier webhook normalized to JSON (Twilio-style field
// names)". Twilio envelopes are that shape natively (the adapter passes
// the envelope through untouched); Telnyx envelopes are normalized by
// the telnyx adapter, which is the vendor integration layer performing
// exactly the normalization the channels contract documents. Receipts
// and call-status events are NOT messages — they carry no relay payload
// and never reach the channels module.

import type { CanonicalCellularEvent, CellularProvider } from '../types';

/** What a provider's event adapter produces from one envelope. */
export interface ParsedCellularEvent {
  /** The canonical cellular event (re-validated by the service). */
  event: CanonicalCellularEvent;
  /**
   * The carrier-webhook envelope for the channels contract's canonical
   * inbound edge (message-shaped events only; null for receipts and
   * call-status events). See the file header for the relay discipline.
   */
  channelPayload: unknown | null;
}

export interface CellularAdapter {
  readonly provider: CellularProvider;

  /**
   * Canonicalizes a raw vendor account id supplied by a caller
   * (connection registration, event account resolution). Throws
   * `invalid_cellular_input` when the value cannot be canonical.
   */
  normalizeAccountId(raw: string): string;

  /**
   * Parses one vendor event envelope into its canonical cellular event
   * plus, for message-shaped events, the channels-relay payload. Throws
   * `invalid_provider_payload` when the envelope is malformed and
   * `unsupported_provider_event` when it is a recognized-but-non-record
   * event (non-terminal delivery statuses like 'queued'/'sent', call
   * pings…).
   */
  parseEvent(payload: unknown): ParsedCellularEvent;
}
