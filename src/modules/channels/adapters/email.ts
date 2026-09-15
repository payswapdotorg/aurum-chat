// Email adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: an inbound-email webhook already normalized to JSON by the
// receiving edge (SendGrid Inbound Parse / SES receipt style):
//   { from: 'Name <addr@example.com>', to, subject, text?, html?, messageId?,
//     date? (RFC 2822 or ISO), inReplyTo?, attachments?: [ { url, type?, name? } ] }
// `html` is deliberately dropped: the canonical transcript keeps the plain
// text; rendering variants are a UI concern.
//
// Canonical account id: the lowercase email address.
// Thread key: the subject normalized (Re:/Fwd: prefixes stripped,
// whitespace collapsed, lowercased) — the classic stable email-thread
// anchor across reply chains.

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
  flexibleDateToIso,
  kindFromMimeType,
  optionalString,
  requiredString,
} from './shared';

const PROVIDER: ChannelProvider = 'email';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Splits 'Name <addr@host>' (or a bare address) into name + lowercase address. */
function parseEmailAddress(raw: string, where: string): { name: string | null; address: string } {
  const angleMatch = /^([^<]*)<([^>]+)>$/.exec(raw.trim());
  const name = angleMatch !== null ? angleMatch[1]!.trim() : '';
  const address = (angleMatch !== null ? angleMatch[2]! : raw.trim()).toLowerCase();
  if (!EMAIL_PATTERN.test(address)) {
    throw new ChannelsError('invalid_provider_payload', `${where} is not a valid email address (got '${raw}')`);
  }
  return { name: name === '' ? null : name, address };
}

export function normalizeEmailThreadSubject(subject: string): string {
  let normalized = subject.trim().toLowerCase();
  // Strip leading reply/forward markers repeatedly ("re:", "fw:", "fwd:").
  for (;;) {
    const next = normalized.replace(/^(re|fw|fwd)\s*:\s*/, '');
    if (next === normalized) break;
    normalized = next;
  }
  return normalized.replace(/\s+/g, ' ');
}

export const emailAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    try {
      return parseEmailAddress(raw, 'providerAccountId').address;
    } catch (error) {
      if (error instanceof ChannelsError && error.code === 'invalid_provider_payload') {
        throw new ChannelsError(
          'invalid_channel_input',
          `providerAccountId must be a valid email address for this provider (got '${raw}')`,
        );
      }
      throw error;
    }
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    const envelope = asObject(payload, 'payload');
    const from = parseEmailAddress(
      requiredString(envelope, 'from', 'payload'),
      'payload.from',
    );
    const subject = optionalString(envelope, 'subject');
    const text = optionalString(envelope, 'text');

    const attachments: CanonicalAttachment[] = [];
    if (envelope.attachments !== undefined && envelope.attachments !== null) {
      const list = asArray(envelope.attachments, 'payload.attachments');
      for (const entry of list) {
        const attachment = asObject(entry, 'payload.attachments[]');
        const mimeType = optionalString(attachment, 'type');
        attachments.push(
          canonicalAttachment(
            kindFromMimeType(mimeType, 'document'),
            requiredString(attachment, 'url', 'payload.attachments[]'),
            { mimeType, caption: optionalString(attachment, 'name') },
          ),
        );
      }
    }

    if (text === null && attachments.length === 0) {
      throw new ChannelsError(
        'invalid_provider_payload',
        'email carries neither text nor attachments',
      );
    }

    const messageId = optionalString(envelope, 'messageId');
    const threadSubject = subject === null ? null : normalizeEmailThreadSubject(subject);

    return {
      provider: PROVIDER,
      providerAccountId: from.address,
      displayName: boundedText(from.name, 200),
      providerMessageId: messageId,
      sentAt: flexibleDateToIso(envelope.date, 'payload.date'),
      providerThreadKey:
        threadSubject === null || threadSubject === ''
          ? null
          : `subject:${threadSubject.slice(0, 512)}`,
      threadTitle: boundedText(subject, 200),
      content: { text, attachments },
    };
  },

  formatOutbound(request: OutboundFormattingRequest): FormattedMessage {
    if (request.purpose === 'verification') {
      return {
        text: `Your Aurum verification code is ${request.code}. It expires soon — never share this code with anyone.`,
        subject: 'Your Aurum verification code',
        attachments: [],
      };
    }
    const text = request.content.text ?? '[media]';
    return {
      text,
      subject: request.subject ?? text.slice(0, 80),
      attachments: request.content.attachments,
    };
  },
};
