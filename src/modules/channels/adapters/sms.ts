// SMS adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: a carrier webhook normalized to JSON (Twilio-style field names):
//   { From: '+15551234567', To: '+15550100000', Body: 'text', MessageSid: 'SM…',
//     MediaUrls?: string[] }
// Carrier SMS webhooks carry no sender timestamp — the service clock is the
// sentAt fallback.
//
// Canonical account id: E.164 with leading `+`.
// Thread key: the pairwise traffic between the two E.164 ends (sorted).

import type { ChannelProvider } from '@/modules/identity/contract';
import { ChannelsError } from '../errors';
import type { CanonicalAttachment, CanonicalInboundMessage, FormattedMessage } from '../types';
import {
  canonicalAttachment,
  type ChannelAdapter,
  type OutboundFormattingRequest,
} from './types';
import {
  asArray,
  normalizeE164Account,
  pairThreadKey,
  requiredString,
  toE164,
} from './shared';

const PROVIDER: ChannelProvider = 'sms';

export const smsAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    return normalizeE164Account(raw);
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new ChannelsError('invalid_provider_payload', 'payload must be an object (the carrier webhook envelope)');
    }
    const envelope = payload as Record<string, unknown>;
    const from = toE164(requiredString(envelope, 'From', 'payload'), 'payload.From');
    const to = toE164(requiredString(envelope, 'To', 'payload'), 'payload.To');
    const body = requiredString(envelope, 'Body', 'payload');
    const messageSid = requiredString(envelope, 'MessageSid', 'payload');

    const attachments: CanonicalAttachment[] = [];
    if (envelope.MediaUrls !== undefined && envelope.MediaUrls !== null) {
      for (const entry of asArray(envelope.MediaUrls, 'payload.MediaUrls')) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          throw new ChannelsError(
            'invalid_provider_payload',
            'payload.MediaUrls entries must be non-empty url strings',
          );
        }
        // MMS media without a content type default to documents.
        attachments.push(canonicalAttachment('document', entry.trim()));
      }
    }

    return {
      provider: PROVIDER,
      providerAccountId: from,
      displayName: null, // SMS carries no profile name
      providerMessageId: messageSid,
      sentAt: null, // carrier SMS webhooks carry no sender clock
      providerThreadKey: pairThreadKey(from, to),
      threadTitle: null,
      content: { text: body, attachments },
    };
  },

  formatOutbound(request: OutboundFormattingRequest): FormattedMessage {
    if (request.purpose === 'verification') {
      // GSM-7 segment budget: keep verification texts single-segment.
      return {
        text: `Aurum code ${request.code} — expires soon. Never share it.`,
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
