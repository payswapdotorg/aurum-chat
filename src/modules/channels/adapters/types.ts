// The canonical channel-adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical provider (W030). Adapters are the ONLY place
// where provider-native webhook envelopes, account-id semantics and message
// formatting rules exist (lock 16 / ADR-0015: provider objects never cross
// the channels module; IMPLEMENTATION-STACK §6: provider SDKs may only be
// imported inside src/modules/channels/). Nothing in `adapters/` is
// exported through the module contract — the public surface speaks purely
// canonical types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// provider reality into canonical values and back. Persistence, identity
// registration, transcript recording and transport are the service's job.

import type { ChannelProvider } from '@/modules/identity/contract';
import type {
  CanonicalAttachment,
  CanonicalAttachmentKind,
  CanonicalContent,
  CanonicalInboundMessage,
  FormattedMessage,
} from '../types';

/**
 * What an adapter is asked to format for the wire.
 *
 * `code` is the single-use verification code (identity module, W002) — it
 * exists ONLY inside the channels module (adapters embed it in the outbound
 * text; the transport delivers it). It is never persisted and never
 * returned through the contract.
 */
export type OutboundFormattingRequest =
  | {
      purpose: 'message';
      content: CanonicalContent;
      subject: string | null;
      recipientName: string | null;
    }
  | {
      purpose: 'verification';
      code: string;
      recipientName: string | null;
    };

export interface ChannelAdapter {
  readonly provider: ChannelProvider;

  /**
   * Canonicalizes a raw provider account id supplied by a caller
   * (connection registration, outbound recipient) — e.g. E.164 with a
   * leading `+` for phone carriers, trimmed lowercase for email.
   * Throws `invalid_channel_input` when the value cannot be canonical.
   */
  normalizeAccountId(raw: string): string;

  /**
   * Parses one provider webhook payload into the canonical inbound message.
   * Throws `invalid_provider_payload` when the envelope is malformed and
   * `unsupported_provider_event` when it is a recognized-but-non-message
   * event (status callbacks, url_verification handshakes, edit events, …).
   */
  parseInbound(payload: unknown): CanonicalInboundMessage;

  /**
   * Formats a canonical outbound message for the provider's wire semantics
   * (subject lines for email, short bodies for SMS, spoken-digit text for
   * voice, …). The result is provider-NEUTRAL (FormattedMessage) so any
   * transport implementation can carry it.
   */
  formatOutbound(request: OutboundFormattingRequest): FormattedMessage;
}

// ---------------------------------------------------------------------------
// Shared construction helpers (re-exported through ./shared for adapters)
// ---------------------------------------------------------------------------

export function canonicalAttachment(
  kind: CanonicalAttachmentKind,
  reference: string,
  extras: { mimeType?: string | null; caption?: string | null; transcript?: string | null } = {},
): CanonicalAttachment {
  return {
    kind,
    reference,
    mimeType: extras.mimeType ?? null,
    caption: extras.caption ?? null,
    transcript: extras.transcript ?? null,
  };
}
