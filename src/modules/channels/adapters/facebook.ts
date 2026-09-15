// Facebook/Messenger adapter (MODULE-INTERNAL — provider payloads never
// cross the channels module; lock 16 / ADR-0015).
//
// Inbound: the Messenger platform webhook envelope (see ./messenger-shape).
//
// Canonical account id: the numeric PSID (string).
// Thread key: the participant pair (user ↔ page).

import type { ChannelProvider } from '@/modules/identity/contract';
import type { CanonicalInboundMessage, FormattedMessage } from '../types';
import { type ChannelAdapter, type OutboundFormattingRequest } from './types';
import { numericAccountValidator, parseMessengerStyleEnvelope } from './messenger-shape';

const PROVIDER: ChannelProvider = 'facebook';

export const facebookAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId: numericAccountValidator('Facebook/Messenger'),

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const parsed = parseMessengerStyleEnvelope(payload, 'facebook');
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
