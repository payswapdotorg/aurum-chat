// Slack adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: Slack Events API envelope
//   { type: 'event_callback', team_id, event: { type: 'message', user, text,
//     ts, channel, files?: [ { url_private?|url?, mimetype?, name? } ] } }
// `url_verification` handshakes and non-`message` events (app mentions,
// channel lifecycle, message edits, bot messages, …) are recognized-but-
// non-message events (`unsupported_provider_event`).
//
// Canonical account id: the Slack member id (U-prefixed, uppercase
// alphanumeric).
// Thread key: the channel id — a Slack channel is the native conversation
// anchor. `ts` is per-channel, so the provider message id is
// `<channel>.<ts>`.

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
  epochSecondsToIso,
  kindFromMimeType,
  optionalString,
  requiredString,
  unsupportedEvent,
} from './shared';

const PROVIDER: ChannelProvider = 'slack';

const SLACK_ID_PATTERN = /^[A-Z0-9]{3,64}$/;

function normalizeSlackId(value: unknown, where: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!SLACK_ID_PATTERN.test(text)) {
    throw new ChannelsError(
      'invalid_provider_payload',
      `${where} must be an uppercase alphanumeric Slack id (got '${String(value)}')`,
    );
  }
  return text;
}

export const slackAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    const trimmed = raw.trim();
    if (!SLACK_ID_PATTERN.test(trimmed)) {
      throw new ChannelsError(
        'invalid_channel_input',
        `providerAccountId must be an uppercase alphanumeric Slack member id for this provider (got '${raw}')`,
      );
    }
    return trimmed;
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const envelope = asObject(payload, 'payload');
    const type = optionalString(envelope, 'type');
    if (type === 'url_verification') {
      throw unsupportedEvent('slack url_verification handshakes are not messages');
    }
    if (type !== 'event_callback') {
      throw new ChannelsError(
        'invalid_provider_payload',
        `payload.type must be 'event_callback' (got '${String(type)}')`,
      );
    }
    const event = asObject(envelope.event, 'payload.event');
    const eventType = optionalString(event, 'type');
    if (eventType !== 'message') {
      throw unsupportedEvent(
        `slack event type '${String(eventType)}' is not a message (app_mention/… are not supported)`,
      );
    }
    // message_changed / message_deleted / bot traffic ride along as subtypes.
    const subtype = optionalString(event, 'subtype');
    if (subtype !== null && subtype !== 'file_share') {
      throw unsupportedEvent(`slack message subtype '${subtype}' is not supported`);
    }

    const userId = normalizeSlackId(event.user, 'payload.event.user');
    const channelId = normalizeSlackId(event.channel, 'payload.event.channel');
    const ts = requiredString(event, 'ts', 'payload.event');
    const text = optionalString(event, 'text');

    const attachments: CanonicalAttachment[] = [];
    if (event.files !== undefined && event.files !== null) {
      const files = asArray(event.files, 'payload.event.files');
      for (const entry of files) {
        const file = asObject(entry, 'payload.event.files[]');
        const reference = optionalString(file, 'url_private') ?? optionalString(file, 'url');
        if (reference === null) {
          // Slack sometimes withholds file URLs (access revocation) — the
          // file is dropped, the textual turn survives.
          continue;
        }
        const mimeType = optionalString(file, 'mimetype');
        attachments.push(
          canonicalAttachment(kindFromMimeType(mimeType, 'document'), reference, {
            mimeType,
            caption: optionalString(file, 'name'),
          }),
        );
      }
    }

    if (text === null && attachments.length === 0) {
      throw unsupportedEvent('slack message carries neither text nor accessible files');
    }

    return {
      provider: PROVIDER,
      providerAccountId: userId,
      displayName: null, // the Events API envelope carries no profile name
      providerMessageId: `${channelId}.${ts}`,
      sentAt: epochSecondsToIso(ts, 'payload.event.ts'),
      providerThreadKey: channelId,
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
