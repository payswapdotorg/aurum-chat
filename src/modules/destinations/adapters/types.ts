// The canonical destination-adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical destination provider (W037). Adapters are the
// ONLY place where provider-native account-id semantics and request-body
// conventions exist (lock 16 analog / ADR-0015 provider independence;
// IMPLEMENTATION-STACK §6: provider SDKs may only be imported inside
// src/modules/destinations/). Nothing in `adapters/` is exported through
// the module contract — the public surface speaks purely canonical types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// canonical values into provider-shaped request bodies. Persistence,
// authority gating, the delivery ledger and the actual network I/O are the
// service's and the transport's jobs; real transports also live in this
// folder.
//
// The envelope an adapter composes is provider-specific in STRUCTURE but
// provider-neutral in SHAPE (FormattedDelivery: a plain JSON body + a
// canonical carriage hint), exactly like the channels module's
// FormattedMessage — the provider-native wire encoding is the transport's
// business.

import { DestinationsError } from '../errors';
import type {
  CanonicalOutboundRecord,
  DestinationCategory,
  DestinationProvider,
  FormattedDelivery,
} from '../types';

/** What a provider adapter is asked to format for the wire. */
export interface CanonicalDeliveryBatch {
  /** The delivery this batch belongs to. */
  deliveryId: string;
  /** 1-based attempt number (the envelope records it for providers that dedupe retries). */
  attempt: number;
  /** Canonical classification of the export batch. */
  kind: string;
  /** The canonical outbound records (validated: unique ids, plain-JSON data). */
  records: CanonicalOutboundRecord[];
}

export interface DestinationAdapter {
  readonly provider: DestinationProvider;
  /** Canonical destination family (the work item's six categories). */
  readonly category: DestinationCategory;
  /**
   * Whether every record's `data` must be a plain JSON object for this
   * provider: structured stores (warehouses, BI, spreadsheets, CRM/ERP)
   * need field-shaped rows; envelope-style providers (webhook, http-api)
   * accept any JSON. Enforced at dispatch time (invalid_delivery_records).
   */
  readonly requiresObjectRecords: boolean;

  /**
   * Canonicalizes a raw provider account id supplied by a caller
   * (destination registration) — e.g. lowercase project ids, uppercase
   * Salesforce org ids, trimmed endpoint addresses for webhooks/APIs.
   * Throws `invalid_destination_input` when the value cannot be canonical.
   */
  normalizeAccountId(raw: string): string;

  /**
   * Composes the provider-shaped request body for one delivery attempt
   * from the canonical batch. PURE and total on valid inputs — the
   * record-shape constraint is enforced BEFORE formatting (dispatch-time),
   * so formatting never fails on well-formed dispatches. Output is
   * re-validated by the service before it reaches the transport or the
   * attempt audit (defense in depth).
   */
  formatDelivery(batch: CanonicalDeliveryBatch): FormattedDelivery;
}

// ---------------------------------------------------------------------------
// Shared construction helpers (used by every adapter)
// ---------------------------------------------------------------------------

/** Builds one envelope (adapter-side convenience). */
export function envelope(shape: FormattedDelivery['shape'], body: unknown): FormattedDelivery {
  return { shape, body };
}

/** Rejects a non-canonical account id with the module's input code. */
export function invalidAccountId(provider: DestinationProvider): DestinationsError {
  return new DestinationsError(
    'invalid_destination_input',
    `providerAccountId must be a non-empty string for provider '${provider}'`,
  );
}
