// Web adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: the canonical Aurum web-widget event (our own first-party
// surface — the one provider whose wire format WE own):
//   { sessionId, visitorId?, visitorName?, messageId, sentAt (ISO 8601),
//     text?, attachments?: [ { kind, url, mimeType?, caption? } ] }
//
// Canonical account id: the visitor id when the widget mints a stable one,
// else the session id.
// Thread key: the session id.

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
  asObject,
  boundedText,
  optionalString,
  requiredString,
} from './shared';

const PROVIDER: ChannelProvider = 'web';

const WEB_ID_PATTERN = /^[^\p{Cc}]{1,128}$/u;

function webId(raw: string, where: string): string {
  const trimmed = raw.trim();
  if (!WEB_ID_PATTERN.test(trimmed)) {
    throw new ChannelsError('invalid_provider_payload', `${where} must be 1..128 printable characters`);
  }
  return trimmed;
}

export const webAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    const trimmed = raw.trim();
    if (!WEB_ID_PATTERN.test(trimmed)) {
      throw new ChannelsError(
        'invalid_channel_input',
        `providerAccountId must be 1..128 printable characters for this provider (got '${raw}')`,
      );
    }
    return trimmed;
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const envelope = asObject(payload, 'payload');
    const sessionId = webId(requiredString(envelope, 'sessionId', 'payload'), 'payload.sessionId');
    const visitorId = optionalString(envelope, 'visitorId');
    const accountId =
      visitorId !== null ? webId(visitorId, 'payload.visitorId') : sessionId;
    const text = optionalString(envelope, 'text');

    const attachments: CanonicalAttachment[] = [];
    if (envelope.attachments !== undefined && envelope.attachments !== null) {
      const list = asArray(envelope.attachments, 'payload.attachments');
      for (const entry of list) {
        const attachment = asObject(entry, 'payload.attachments[]');
        const kind = optionalString(attachment, 'kind');
        if (
          kind !== 'image' &&
          kind !== 'audio' &&
          kind !== 'video' &&
          kind !== 'document' &&
          kind !== 'location'
        ) {
          throw new ChannelsError(
            'invalid_provider_payload',
            `payload.attachments[].kind must be a canonical attachment kind (got '${String(kind)}')`,
          );
        }
        attachments.push(
          canonicalAttachment(kind, requiredString(attachment, 'url', 'payload.attachments[]'), {
            mimeType: optionalString(attachment, 'mimeType'),
            caption: optionalString(attachment, 'caption'),
          }),
        );
      }
    }

    if (text === null && attachments.length === 0) {
      throw new ChannelsError(
        'invalid_provider_payload',
        'web event carries neither text nor attachments',
      );
    }

    const sentAt = envelope.sentAt;
    if (typeof sentAt !== 'string' || Number.isNaN(Date.parse(sentAt))) {
      throw new ChannelsError(
        'invalid_provider_payload',
        'payload.sentAt must be a parseable ISO 8601 timestamp',
      );
    }

    return {
      provider: PROVIDER,
      providerAccountId: accountId,
      displayName: boundedText(optionalString(envelope, 'visitorName'), 200),
      providerMessageId: webId(
        requiredString(envelope, 'messageId', 'payload'),
        'payload.messageId',
      ),
      sentAt: new Date(sentAt).toISOString(),
      providerThreadKey: sessionId,
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
