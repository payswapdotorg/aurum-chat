// Voice adapter (MODULE-INTERNAL — provider payloads never cross the
// channels module; lock 16 / ADR-0015).
//
// Inbound: a telephony voice webhook normalized to JSON (Twilio-style field
// names):
//   { CallSid, From: '+15551234567', To: '+15550100000', CallStatus?,
//     SpeechResult?, RecordingUrl?, RecordingDuration?, Timestamp?, EventKey? }
// A call carries no sender clock in the webhook — an optional Timestamp is
// honored and the service clock is the fallback. `SpeechResult` is the
// provider-side transcript of what was said; `RecordingUrl` is the audio
// artifact.
//
// Canonical account id: E.164 with leading `+`.
// Thread key: the call (CallSid) — one call is one conversation with
// possibly several speech turns; carriers that split a call into multiple
// speech events supply EventKey as the per-event id.

import type { ChannelProvider } from '@/modules/identity/contract';
import { ChannelsError } from '../errors';
import type { CanonicalInboundMessage, FormattedMessage } from '../types';
import {
  canonicalAttachment,
  type ChannelAdapter,
  type OutboundFormattingRequest,
} from './types';
import {
  flexibleDateToIso,
  normalizeE164Account,
  optionalString,
  requiredString,
  toE164,
} from './shared';

const PROVIDER: ChannelProvider = 'voice';

export const voiceAdapter: ChannelAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    return normalizeE164Account(raw);
  },

  parseInbound(payload: unknown): CanonicalInboundMessage {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ChannelsError(
        'invalid_provider_payload',
        'payload must be an object (the telephony voice webhook envelope)',
      );
    }
    const envelope = payload as Record<string, unknown>;
    const callSid = requiredString(envelope, 'CallSid', 'payload');
    const from = toE164(requiredString(envelope, 'From', 'payload'), 'payload.From');
    // `To` is validated for envelope completeness but carries no canonical
    // meaning here — the thread anchor is the call itself (CallSid).
    toE164(requiredString(envelope, 'To', 'payload'), 'payload.To');
    const speech = optionalString(envelope, 'SpeechResult');
    const recordingUrl = optionalString(envelope, 'RecordingUrl');

    if (speech === null && recordingUrl === null) {
      // Call-status webhooks (ringing/completed/…) carry neither — they are
      // lifecycle events, not communication turns.
      throw new ChannelsError(
        'unsupported_provider_event',
        'voice webhook carries neither SpeechResult nor RecordingUrl (call-status lifecycle event)',
      );
    }

    const content =
      speech !== null && recordingUrl !== null
        ? {
            text: speech,
            attachments: [canonicalAttachment('audio', recordingUrl, { transcript: speech })],
          }
        : speech !== null
          ? { text: speech, attachments: [] }
          : {
              text: null,
              attachments: [canonicalAttachment('audio', recordingUrl!)],
            };

    return {
      provider: PROVIDER,
      providerAccountId: from,
      displayName: null, // telephony carries no profile name
      providerMessageId: optionalString(envelope, 'EventKey') ?? callSid,
      sentAt: flexibleDateToIso(envelope.Timestamp, 'payload.Timestamp'),
      providerThreadKey: callSid,
      threadTitle: null,
      content,
    };
  },

  formatOutbound(request: OutboundFormattingRequest): FormattedMessage {
    if (request.purpose === 'verification') {
      // Spoken form: digits spaced for text-to-speech delivery.
      const spoken = request.code.split('').join(' ');
      return {
        text: `Your Aurum verification code is ${spoken}. It expires soon. Never share this code.`,
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
