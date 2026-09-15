// Messenger-platform webhook shape, shared by the Facebook/Messenger and
// Instagram adapters (MODULE-INTERNAL). Both providers speak the same
// messaging envelope:
//   { entry: [ { messaging: [ { sender: { id }, recipient: { id },
//       timestamp (ms), message: { mid, text?, attachments? } } ] } ] }
// Postbacks, referrals, standby and delivery/read receipts are recognized
// but non-message events (`unsupported_provider_event`).

import { ChannelsError } from '../errors';
import type { CanonicalAttachment, CanonicalContent } from '../types';
import { asArray, asObject, epochMillisToIso, optionalString, pairThreadKey, requiredString, unsupportedEvent } from './shared';

export interface MessengerStyleParse {
  senderId: string;
  recipientId: string;
  displayName: null;
  providerMessageId: string;
  sentAt: string;
  providerThreadKey: string;
  content: CanonicalContent;
}

const NUMERIC_ID_PATTERN = /^\d{1,64}$/;

export function parseMessengerStyleEnvelope(
  payload: unknown,
  providerLabel: string,
): MessengerStyleParse {
  const envelope = asObject(payload, 'payload');
  const entries = asArray(envelope.entry, 'payload.entry');
  if (entries.length === 0) {
    throw unsupportedEvent(`${providerLabel} webhook carries no entry (empty envelope)`);
  }
  const entry = asObject(entries[0], 'payload.entry[0]');

  if (entry.messaging === undefined || entry.messaging === null) {
    // postbacks, standby, delivery/read receipts, … ride on sibling keys.
    throw unsupportedEvent(
      `${providerLabel} webhook entry carries no messaging event (postback/standby/receipt events are not messages)`,
    );
  }
  const messaging = asArray(entry.messaging, 'payload.entry[0].messaging');
  if (messaging.length === 0) {
    throw unsupportedEvent(`${providerLabel} webhook entry carries no messaging event`);
  }
  const event = asObject(messaging[0], 'payload.entry[0].messaging[0]');
  if (event.message === undefined || event.message === null) {
    throw unsupportedEvent(
      `${providerLabel} messaging event carries no message object (postback/referral events are not messages)`,
    );
  }

  const sender = asObject(event.sender, '…messaging[0].sender');
  const recipient = asObject(event.recipient, '…messaging[0].recipient');
  const senderId = requiredString(sender, 'id', '…messaging[0].sender');
  const recipientId = requiredString(recipient, 'id', '…messaging[0].recipient');
  if (!NUMERIC_ID_PATTERN.test(senderId) || !NUMERIC_ID_PATTERN.test(recipientId)) {
    throw new ChannelsError(
      'invalid_provider_payload',
      `${providerLabel} platform ids are numeric`,
    );
  }

  const message = asObject(event.message, '…messaging[0].message');
  const text = optionalString(message, 'text');

  const attachments: CanonicalAttachment[] = [];
  if (message.attachments !== undefined && message.attachments !== null) {
    const list = asArray(message.attachments, '…message.attachments');
    for (const entryValue of list) {
      const attachment = asObject(entryValue, '…message.attachments[]');
      const type = optionalString(attachment, 'type');
      const payloadValue = asObject(attachment.payload ?? {}, '…attachments[].payload');
      if (type === 'image' || type === 'audio' || type === 'video' || type === 'file') {
        const url = optionalString(payloadValue, 'url');
        if (url === null) {
          throw new ChannelsError(
            'invalid_provider_payload',
            `${providerLabel} attachment carries no payload url`,
          );
        }
        attachments.push({
          kind: type === 'file' ? 'document' : type,
          reference: url,
          mimeType: null,
          caption: null,
          transcript: null,
        });
      } else if (type === 'location') {
        const coordinates = asObject(payloadValue.coordinates ?? {}, '…payload.coordinates');
        const latitude = coordinates.lat;
        const longitude = coordinates.long;
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
          throw new ChannelsError(
            'invalid_provider_payload',
            `${providerLabel} location attachment carries no coordinates`,
          );
        }
        attachments.push({
          kind: 'location',
          reference: `geo:${latitude},${longitude}`,
          mimeType: null,
          caption: null,
          transcript: null,
        });
      } else {
        throw unsupportedEvent(`${providerLabel} attachment type '${String(type)}' is not supported`);
      }
    }
  }

  if (text === null && attachments.length === 0) {
    throw unsupportedEvent(`${providerLabel} message carries neither text nor supported attachments`);
  }

  return {
    senderId,
    recipientId,
    displayName: null, // profile names are fetched via the platform API, not the webhook
    providerMessageId: requiredString(message, 'mid', '…messaging[0].message'),
    sentAt: epochMillisToIso(event.timestamp, '…messaging[0].timestamp'),
    // Neither platform exposes a conversation id in the webhook; the
    // participant pair (account ↔ page/ig-account) is the native anchor.
    providerThreadKey: pairThreadKey(senderId, recipientId),
    content: { text, attachments },
  };
}

export function numericAccountValidator(providerLabel: string): (raw: string) => string {
  return (raw: string): string => {
    const trimmed = raw.trim();
    if (!NUMERIC_ID_PATTERN.test(trimmed)) {
      throw new ChannelsError(
        'invalid_channel_input',
        `providerAccountId must be a numeric ${providerLabel} platform id for this provider (got '${raw}')`,
      );
    }
    return trimmed;
  };
}
