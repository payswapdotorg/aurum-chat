// Instagram adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: the Instagram Messaging webhook — the Messenger-platform envelope
// (see ./messenger-shape) with Instagram-scoped ids.
//
// Canonical account id: the numeric Instagram-scoped user id (string).
// Thread key: the participant pair (user ↔ IG professional account).

import type { ChannelProvider } from '@/modules/identity/contract';
import type { CanonicalInboundMessage, FormattedMessage } from '../types';
import { type ChannelAdapter, type OutboundFormattingRequest } from './types';
import { numericAccountValidator, parseMessengerStyleEnvelope } from './messenger-shape';

const PROVIDER: ChannelProvider = 'instagram';

export const instagramAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId: numericAccountValidator('Instagram'),

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const parsed = parseMessengerStyleEnvelope(payload, 'instagram');
    return {
      provider: PROVIDER,
      providerAccountId: parsed.senderId,
      displayName: parsed.displayName,
      providerMessageId: parsed.providerMessageId,
      sentAt: parsed.sentAt,
      providerThreadKey: parsed.providerThreadKey,
      threadTitle: null,
      content: parsed.content,
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
