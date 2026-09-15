// Telegram adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: Telegram Bot API `update` object
//   { message: { message_id, from: { id, first_name, … }, chat: { id, … },
//     date (unix seconds), text | photo[] | voice | document | video, caption? } }
// Non-message updates (edited_message, channel_post, callback_query, …) are
// recognized-but-non-message events (`unsupported_provider_event`).
//
// Canonical account id: the numeric Telegram user id (string).
// Thread key: the chat id (`chat:<id>`) — Telegram chats are the native
// conversation anchor. Message ids are per-chat, so the provider message id
// is `<chat>:<message_id>`.

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
  epochSecondsToIso,
  optionalString,
  requiredString,
  threadKey,
  unsupportedEvent,
} from './shared';

const PROVIDER: ChannelProvider = 'telegram';

const NUMERIC_ID_PATTERN = /^-?\d{1,32}$/;

/**
 * Telegram ids arrive as JSON numbers OR numeric strings, and group chats
 * carry negative ids — both are canonicalized to the bare numeric string.
 */
function normalizeTelegramId(value: unknown, where: string): string {
  let text: string;
  if (typeof value === 'number' && Number.isInteger(value)) {
    text = String(value);
  } else if (typeof value === 'string' && value.trim() !== '') {
    text = value.trim();
  } else {
    throw new ChannelsError('invalid_provider_payload', `${where} must be a numeric Telegram id`);
  }
  if (!NUMERIC_ID_PATTERN.test(text)) {
    throw new ChannelsError(
      'invalid_provider_payload',
      `${where} must be a numeric Telegram id (got '${text}')`,
    );
  }
  return text;
}

export const telegramAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    const trimmed = raw.trim();
    if (!NUMERIC_ID_PATTERN.test(trimmed)) {
      throw new ChannelsError(
        'invalid_channel_input',
        `providerAccountId must be a numeric Telegram user id for this provider (got '${raw}')`,
      );
    }
    return trimmed;
  },
  parseInbound(payload: unknown): CanonicalInboundMessage {
    const update = asObject(payload, 'payload');
    if (update.message === undefined || update.message === null) {
      throw unsupportedEvent(
        'telegram update is not a `message` (edited_message/channel_post/callback_query/… are not supported)',
      );
    }
    const message = asObject(update.message, 'payload.message');
    const from = asObject(message.from, 'payload.message.from');
    const chat = asObject(message.chat, 'payload.message.chat');

    const userId = normalizeTelegramId(from.id, 'payload.message.from.id');
    const chatId = normalizeTelegramId(chat.id, 'payload.message.chat.id');
    const displayName = boundedText(
      [optionalString(from, 'first_name'), optionalString(from, 'last_name')]
        .filter((part): part is string => part !== null)
        .join(' ') || optionalString(from, 'username'),
      200,
    );

    const text = optionalString(message, 'text') ?? optionalString(message, 'caption');
    const attachments: CanonicalAttachment[] = [];

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      // Telegram sends ascending photo sizes; the largest is the real image.
      const sizes = asArray(message.photo, 'payload.message.photo').map((entry) =>
        asObject(entry, 'payload.message.photo[]'),
      );
      const largest = sizes.reduce((best, current) => {
        const bestWidth = typeof best.width === 'number' ? best.width : 0;
        const currentWidth = typeof current.width === 'number' ? current.width : 0;
        return currentWidth > bestWidth ? current : best;
      });
      attachments.push(
        canonicalAttachment('image', requiredString(largest, 'file_id', 'payload.message.photo[]')),
      );
    }
    for (const field of ['voice', 'audio', 'video_note', 'video'] as const) {
      if (message[field] !== undefined && message[field] !== null) {
        const media = asObject(message[field], `payload.message.${field}`);
        const kind = field === 'voice' || field === 'audio' ? 'audio' : 'video';
        attachments.push(
          canonicalAttachment(kind, requiredString(media, 'file_id', `payload.message.${field}`), {
            mimeType: optionalString(media, 'mime_type'),
          }),
        );
        break; // one media object per message in practice
      }
    }
    if (message.document !== undefined && message.document !== null) {
      const document = asObject(message.document, 'payload.message.document');
      attachments.push(
        canonicalAttachment('document', requiredString(document, 'file_id', 'payload.message.document'), {
          mimeType: optionalString(document, 'mime_type'),
          caption: optionalString(document, 'file_name'),
        }),
      );
    }

    if (text === null && attachments.length === 0) {
      throw unsupportedEvent('telegram message carries neither text nor supported media');
    }

    const messageId = normalizeTelegramId(message.message_id, 'payload.message.message_id');
    return {
      provider: PROVIDER,
      providerAccountId: userId,
      displayName,
      providerMessageId: threadKey([chatId, messageId]),
      sentAt: epochSecondsToIso(message.date, 'payload.message.date'),
      providerThreadKey: threadKey(['chat', chatId]),
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
