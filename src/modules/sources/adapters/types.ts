// The canonical source-adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical source provider (W036). Adapters are the ONLY
// place where provider-native webhook envelopes, account-id semantics and
// event-classification rules exist (lock 16 / MODULE-DEPENDENCY-MAP
// provider boundaries; IMPLEMENTATION-STACK §6: provider SDKs may only be
// imported inside src/modules/sources/). Nothing in `adapters/` is exported
// through the module contract — the public surface speaks purely canonical
// types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// provider reality into canonical values. Persistence, checkpointing,
// dedupe and observation recording are the service's job; the actual
// polling network I/O belongs to the provider-neutral transport port
// (types.ts), whose real implementations also live in this folder.

import type {
  CanonicalSourceRecord,
  SourceIngestionMode,
  SourceProvider,
} from '../types';

/** What a provider's webhook adapter produces from one envelope. */
export interface WebhookParseResult {
  /** The tenant's provider account the envelope belongs to (opaque). */
  providerAccountId: string;
  /** Canonical records extracted from the envelope (possibly one). */
  records: CanonicalSourceRecord[];
}

export interface SourceAdapter {
  readonly provider: SourceProvider;
  /** Ingestion modes this provider supports (polling and/or webhook). */
  readonly modes: readonly SourceIngestionMode[];

  /**
   * Canonicalizes a raw provider account id supplied by a caller (source
   * registration, webhook account resolution) — e.g. lowercase logins,
   * digit-only portal ids, uppercase org ids. Throws `invalid_source_input`
   * when the value cannot be canonical.
   */
  normalizeAccountId(raw: string): string;

  /**
   * Parses one provider webhook envelope into the account it belongs to
   * and its canonical records. Throws `invalid_provider_payload` when the
   * envelope is malformed and `unsupported_provider_event` when it is a
   * recognized-but-non-record event (verification handshakes, pings, …).
   * Providers without webhook support throw `ingestion_mode_unsupported`.
   */
  parseWebhook(payload: unknown): WebhookParseResult;
}

// ---------------------------------------------------------------------------
// Shared construction helpers (used by every adapter)
// ---------------------------------------------------------------------------

/** Builds one canonical record (adapter-side convenience). */
export function record(
  providerRecordId: string,
  kind: string,
  occurredAt: string,
  payload: unknown,
): CanonicalSourceRecord {
  return { providerRecordId, kind, payload, occurredAt };
}
