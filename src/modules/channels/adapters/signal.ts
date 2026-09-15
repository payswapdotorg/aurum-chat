// Signal adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: signal-cli JSON envelope (the de-facto machine interface for
// Signal, which has no first-party bot webhook — "as provider availability
// permits"):
//   { envelope: { sourceNumber, sourceName?, timestamp (unix ms),
//     message?, attachments?: [ { contentType, id } ] } }
//
// Canonical account id: E.164 with leading `+`.
// Thread key: the sender's number (Signal DMs are pairwise sessions).

import type { ChannelProvider } from '@/modules/identity/contract';
import type { CanonicalAttachment, CanonicalInboundMessage, FormattedMessage } from '../types';
import {
  canonicalAttachment,
  type ChannelAdapter,
  type OutboundFormattingRequest,
} from './types';
import {
  asArray,
  asObject,
  boundedText,
  epochMillisToIso,
  kindFromMimeType,
  normalizeE164Account,
  optionalString,
  requiredString,
  toE164,
  unsupportedEvent,
} from './shared';

const PROVIDER: ChannelProvider = 'signal';

export const signalAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    return normalizeE164Account(raw);
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const wrapper = asObject(payload, 'payload');
    const envelope = asObject(wrapper.envelope, 'payload.envelope');
    const source = toE164(
      requiredString(envelope, 'sourceNumber', 'payload.envelope'),
      'payload.envelope.sourceNumber',
    );
    const displayName = boundedText(optionalString(envelope, 'sourceName'), 200);
    const text = optionalString(envelope, 'message');

    const attachments: CanonicalAttachment[] = [];
    if (envelope.attachments !== undefined && envelope.attachments !== null) {
      const list = asArray(envelope.attachments, 'payload.envelope.attachments');
      for (const entry of list) {
        const attachment = asObject(entry, 'payload.envelope.attachments[]');
        const mimeType = optionalString(attachment, 'contentType');
        attachments.push(
          canonicalAttachment(
            kindFromMimeType(mimeType, 'document'),
            requiredString(attachment, 'id', 'payload.envelope.attachments[]'),
            { mimeType },
          ),
        );
      }
    }

    if (text === null && attachments.length === 0) {
      throw unsupportedEvent('signal envelope carries neither message nor attachments');
    }

    const timestamp = envelope.timestamp;
    return {
      provider: PROVIDER,
      providerAccountId: source,
      displayName,
      // signal-cli exposes no per-message id; the envelope timestamp is the
      // stable identity of the delivery within the pairwise session.
      providerMessageId: `signal:${source}:${String(timestamp)}`,
      sentAt: epochMillisToIso(timestamp, 'payload.envelope.timestamp'),
      providerThreadKey: source,
      threadTitle: null,
      content: { text, attachments },
    };
  },

  formatOutbound(request: OutboundFormattingRequest): FormattedMessage {
    if (request.purpose === 'verification') {
      return {
        text: `Aurum verification code: ${request.code}. It expires soon — never share this code.`,
        subject: null,
        attachments: [],
      };
    }
    return {
      text: request.content.text ?? '[media]',
      subject: null,
      attachments: request.content.attachments,
    };
  },
};
