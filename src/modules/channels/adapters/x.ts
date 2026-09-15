// X (Twitter) adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: X (Twitter) Account Activity API DM webhook
//   { direct_message_events: [ { id, created_timestamp (ms string), text,
//       sender_id, recipient_id, attachment?: { media: { type, media_url_https? } } } ],
//     users: { <id>: { name, screen_name } } }
//
// Canonical account id: the numeric X user id (string).
// Thread key: the DM conversation — X exposes no conversation id, so the
// participant pair (sorted) is the native anchor.

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
  epochMillisToIso,
  optionalString,
  pairThreadKey,
  requiredString,
  unsupportedEvent,
} from './shared';

const PROVIDER: ChannelProvider = 'x';

const NUMERIC_ID_PATTERN = /^\d{1,32}$/;

function normalizeXId(value: unknown, where: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!NUMERIC_ID_PATTERN.test(text)) {
    throw new ChannelsError(
      'invalid_provider_payload',
      `${where} must be a numeric X user id (got '${String(value)}')`,
    );
  }
  return text;
}

export const xAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    const trimmed = raw.trim();
    if (!NUMERIC_ID_PATTERN.test(trimmed)) {
      throw new ChannelsError(
        'invalid_channel_input',
        `providerAccountId must be a numeric X user id for this provider (got '${raw}')`,
      );
    }
    return trimmed;
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const envelope = asObject(payload, 'payload');
    if (
      envelope.direct_message_events === undefined ||
      envelope.direct_message_events === null
    ) {
      throw unsupportedEvent('X webhook carries no direct_message_events (not a DM event)');
    }
    const events = asArray(envelope.direct_message_events, 'payload.direct_message_events');
    if (events.length === 0) {
      throw unsupportedEvent('X webhook carries no direct message event');
    }
    const event = asObject(events[0], 'payload.direct_message_events[0]');

    const senderId = normalizeXId(event.sender_id, '…direct_message_events[0].sender_id');
    const recipientId = normalizeXId(event.recipient_id, '…direct_message_events[0].recipient_id');
    const text = optionalString(event, 'text');

    const attachments: CanonicalAttachment[] = [];
    if (event.attachment !== undefined && event.attachment !== null) {
      const attachment = asObject(event.attachment, '…direct_message_events[0].attachment');
      const media = asObject(attachment.media, '….attachment.media');
      const mediaType = optionalString(media, 'type');
      const reference = optionalString(media, 'media_url_https') ?? optionalString(media, 'media_url');
      if (mediaType === 'photo' || mediaType === 'animated_gif') {
        if (reference === null) {
          throw new ChannelsError(
            'invalid_provider_payload',
            'X media attachment carries no media url',
          );
        }
        attachments.push(canonicalAttachment('image', reference));
      } else if (mediaType === 'video') {
        if (reference === null) {
          throw new ChannelsError(
            'invalid_provider_payload',
            'X media attachment carries no media url',
          );
        }
        attachments.push(canonicalAttachment('video', reference));
      } else {
        throw unsupportedEvent(`X media type '${String(mediaType)}' is not supported`);
      }
    }

    if (text === null && attachments.length === 0) {
      throw unsupportedEvent('X direct message carries neither text nor supported media');
    }

    const users = asObject(envelope.users ?? {}, 'payload.users');
    const sender = users[senderId];
    const displayName =
      isRecord(sender) ? boundedText(optionalString(sender, 'name'), 200) : null;

    return {
      provider: PROVIDER,
      providerAccountId: senderId,
      displayName,
      providerMessageId: requiredString(event, 'id', '…direct_message_events[0]'),
      sentAt: epochMillisToIso(
        event.created_timestamp,
        '…direct_message_events[0].created_timestamp',
      ),
      providerThreadKey: pairThreadKey(senderId, recipientId),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
