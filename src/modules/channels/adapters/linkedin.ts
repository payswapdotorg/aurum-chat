// LinkedIn adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// LinkedIn's real-time messaging webhooks are not publicly available; the
// documented canonical envelope below is what a tenant-configured LinkedIn
// event bridge emits ("as provider availability permits"):
//   { conversationId, senderId, sentAt (ISO 8601 or epoch ms), text?,
//     attachments?: [ { kind, url, mimeType?, caption? } ], messageId? }
//
// Canonical account id: the LinkedIn member id (alphanumeric).
// Thread key: the conversation id (LinkedIn conversations are first-class).

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
  flexibleDateToIso,
  optionalString,
  requiredString,
} from './shared';

const PROVIDER: ChannelProvider = 'linkedin';

const LINKEDIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const linkedinAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    const trimmed = raw.trim();
    if (!LINKEDIN_ID_PATTERN.test(trimmed)) {
      throw new ChannelsError(
        'invalid_channel_input',
        `providerAccountId must be an alphanumeric LinkedIn member id for this provider (got '${raw}')`,
      );
    }
    return trimmed;
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const envelope = asObject(payload, 'payload');
    const conversationId = requiredString(envelope, 'conversationId', 'payload');
    const senderId = requiredString(envelope, 'senderId', 'payload');
    if (!LINKEDIN_ID_PATTERN.test(senderId)) {
      throw new ChannelsError(
        'invalid_provider_payload',
        `payload.senderId must be an alphanumeric LinkedIn member id (got '${senderId}')`,
      );
    }
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
        'linkedin event carries neither text nor attachments',
      );
    }

    const sentAtRaw = envelope.sentAt;
    const sentAt =
      typeof sentAtRaw === 'number' && Number.isFinite(sentAtRaw)
        ? new Date(sentAtRaw).toISOString()
        : flexibleDateToIso(sentAtRaw, 'payload.sentAt');
    const explicitMessageId = optionalString(envelope, 'messageId');

    return {
      provider: PROVIDER,
      providerAccountId: senderId,
      displayName: null, // the bridge envelope carries no profile name
      providerMessageId:
        explicitMessageId ?? `linkedin:${conversationId}:${senderId}:${sentAt ?? 'undated'}`,
      sentAt,
      providerThreadKey: conversationId,
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
