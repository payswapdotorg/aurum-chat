// WhatsApp adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: WhatsApp Cloud API webhook envelope
//   { entry: [ { changes: [ { value: { metadata, contacts, messages } } ] } ] }
// Status/delivery webhooks carry `statuses` instead of `messages` — a
// recognized-but-non-message event (`unsupported_provider_event`).
//
// Canonical account id: E.164 with leading `+` (wa_id/from arrive bare).
// Thread key: the pairwise chat (customer ↔ business number).

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
  epochSecondsToIso,
  normalizeE164Account,
  optionalString,
  pairThreadKey,
  requiredString,
  toE164,
  unsupportedEvent,
} from './shared';

const PROVIDER: ChannelProvider = 'whatsapp';

function firstMediaField(
  message: Record<string, unknown>,
): { field: string; value: Record<string, unknown> } | null {
  for (const field of ['image', 'audio', 'video', 'document'] as const) {
    const value = message[field];
    if (value !== undefined && value !== null) {
      return { field, value: asObject(value, `messages[0].${field}`) };
    }
  }
  return null;
}

function parseMediaAttachments(message: Record<string, unknown>): CanonicalAttachment[] {
  const media = firstMediaField(message);
  if (media === null) return [];
  const kind = media.field as 'image' | 'audio' | 'video' | 'document';
  return [
    canonicalAttachment(kind, requiredString(media.value, 'id', `messages[0].${media.field}`), {
      mimeType: optionalString(media.value, 'mime_type'),
      caption: optionalString(media.value, 'caption'),
    }),
  ];
}

export const whatsappAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    return normalizeE164Account(raw);
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const envelope = asObject(payload, 'payload');
    const entries = asArray(envelope.entry, 'payload.entry');
    if (entries.length === 0) {
      throw unsupportedEvent('whatsapp webhook carries no entry (empty envelope)');
    }
    const changes = asArray(asObject(entries[0], 'payload.entry[0]').changes, 'payload.entry[0].changes');
    if (changes.length === 0) {
      throw unsupportedEvent('whatsapp webhook carries no change (empty envelope)');
    }
    const value = asObject(asObject(changes[0], 'payload.entry[0].changes[0]').value, '…changes[0].value');

    const messages = value.messages === undefined ? [] : asArray(value.messages, '…value.messages');
    if (messages.length === 0) {
      // Status/delivery receipts and template-status events carry `statuses`
      // instead of `messages` — transcript-irrelevant.
      throw unsupportedEvent(
        value.statuses !== undefined
          ? 'whatsapp status webhooks (delivery/read receipts) are not messages'
          : 'whatsapp webhook carries no message',
      );
    }
    const message = asObject(messages[0], '…value.messages[0]');
    const type = requiredString(message, 'type', '…value.messages[0]');

    let text: string | null = null;
    const attachments: CanonicalAttachment[] = [];

    if (type === 'text') {
      text = requiredString(asObject(message.text, '…messages[0].text'), 'body', '…messages[0].text');
    } else if (type === 'location') {
      const location = asObject(message.location, '…messages[0].location');
      const latitude = location.latitude;
      const longitude = location.longitude;
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        throw unsupportedEvent('whatsapp location message without coordinates');
      }
      attachments.push(canonicalAttachment('location', `geo:${latitude},${longitude}`));
    } else if (type === 'image' || type === 'audio' || type === 'video' || type === 'document') {
      attachments.push(...parseMediaAttachments(message));
    } else {
      throw unsupportedEvent(`whatsapp message type '${type}' is not supported`);
    }

    const metadata = asObject(value.metadata, '…value.metadata');
    const businessNumber = toE164(
      requiredString(metadata, 'display_phone_number', '…value.metadata'),
      '…value.metadata.display_phone_number',
    );
    const contacts = value.contacts === undefined ? [] : asArray(value.contacts, '…value.contacts');
    const contact = contacts.length > 0 ? asObject(contacts[0], '…value.contacts[0]') : null;
    const displayName =
      contact !== null
        ? boundedText(
            optionalString(asObject(contact.profile ?? {}, '…contacts[0].profile'), 'name'),
            200,
          )
        : null;
    const from = toE164(requiredString(message, 'from', '…value.messages[0]'), '…value.messages[0].from');

    return {
      provider: PROVIDER,
      providerAccountId: from,
      displayName,
      providerMessageId: requiredString(message, 'id', '…value.messages[0]'),
      sentAt: epochSecondsToIso(message.timestamp, '…value.messages[0].timestamp'),
      providerThreadKey: pairThreadKey(from, businessNumber),
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
