// Twilio telecom adapter (MODULE-INTERNAL — vendor payloads never cross
// the cellular module; lock 16 / ADR-0015 spirit; IMPLEMENTATION-STACK
// §6 provider isolation).
//
// Envelope shapes (the carrier webhooks the Twilio integration layer
// delivers, normalized to JSON — the same field names the channels
// module's sms/voice adapters document, which is why the message-shaped
// events relay to the channels contract's inbound edge verbatim):
//
//   Inbound SMS (a reply / a manager-originated message):
//     { From: '+1555…', To: '+1555…', Body: 'text', MessageSid: 'SM…',
//       AccountSid: 'AC…' }
//
//   SMS delivery-status callback (terminal statuses only — 'queued'/
//   'sent'/'accepted' are recognized-but-non-record lifecycle pings and
//   are rejected as unsupported):
//     { MessageSid: 'SM…', MessageStatus: 'delivered'|'undelivered'|'failed',
//       AccountSid: 'AC…', ErrorCode?: '…', Timestamp?: '…' }
//
//   Voice call events (each relayed webhook carries EventKey — the
//   integration layer's stable per-event id, the dedupe key; Twilio's
//   own webhooks redeliver wholesale and the relay needs a stable id):
//     { CallSid: 'CA…', From: '+1555…', To: '+1555…', AccountSid: 'AC…',
//       EventKey: 'evt…',
//       CallStatus: 'initiated'|'ringing'|'in-progress'|'completed'|
//                   'no-answer'|'busy'|'canceled'|'failed',
//       SpeechResult?: 'spoken text', RecordingUrl?: 'https…',
//       RecordingDuration?: N, CallDuration?: N, Timestamp?: '…' }
//     A SpeechResult makes the event a VOICE REPLY (relayed to the
//     channels voice edge verbatim); otherwise it is a call-status event.
//
//   CallStatus mapping: initiated→initiated, ringing→ringing,
//     in-progress→answered, completed→completed,
//     no-answer|busy|canceled→no_answer, failed→failed.
//
// Canonical account id: the AccountSid (trimmed).
// Event ids: MessageSid for inbound SMS; `${MessageSid}:${MessageStatus}`
//   for delivery receipts (the same MessageSid streams several status
//   updates — the status suffix keeps one ledger row per distinct
//   terminal report while redelivery of the same report dedupes);
//   EventKey for call events.

import type { CanonicalCellularEvent } from '../types';
import { CellularError } from '../errors';
import type { CellularAdapter, ParsedCellularEvent } from './types';
import {
  flexibleDateToIso,
  optionalNonNegativeInteger,
  optionalString,
  requireObject,
  requiredString,
  toE164,
  unsupportedEvent,
} from './shared';

const PROVIDER = 'twilio' as const;

/** Terminal delivery statuses the ledger records; every other status is a non-record ping. */
const TERMINAL_MESSAGE_STATUSES = new Set(['delivered', 'undelivered', 'failed']);

const CALL_STATUS_MAP: Record<string, 'initiated' | 'ringing' | 'answered' | 'completed' | 'no_answer' | 'failed'> = {
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'answered',
  completed: 'completed',
  'no-answer': 'no_answer',
  busy: 'no_answer',
  canceled: 'no_answer',
  failed: 'failed',
};

function isTwilioVoiceEnvelope(envelope: Record<string, unknown>): boolean {
  // Voice webhooks carry CallSid and no MessageSid; SMS webhooks are the
  // converse. This is the documented vendor distinction.
  return envelope.MessageSid === undefined && envelope.CallSid !== undefined;
}

export const twilioAdapter: CellularAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new CellularError('invalid_cellular_input', 'twilio account id must be non-empty');
    }
    return text;
  },

  parseEvent(payload: unknown): ParsedCellularEvent {
    const envelope = requireObject(payload, 'twilio event envelope');
    const account = requiredString(envelope, 'AccountSid', 'envelope');
    if (isTwilioVoiceEnvelope(envelope)) {
      return parseVoiceEvent(envelope, account);
    }
    return parseSmsEvent(envelope, account, payload);
  },
};

// ---------------------------------------------------------------------------
// SMS: inbound reply vs terminal delivery receipt
// ---------------------------------------------------------------------------

function parseSmsEvent(
  envelope: Record<string, unknown>,
  account: string,
  rawPayload: unknown,
): ParsedCellularEvent {
  const messageSid = requiredString(envelope, 'MessageSid', 'envelope');
  const messageStatus = optionalString(envelope, 'MessageStatus');

  if (messageStatus === null) {
    // Inbound SMS message (a reply, or a manager-originated request).
    const from = toE164(requiredString(envelope, 'From', 'envelope'), 'envelope.From');
    const to = toE164(requiredString(envelope, 'To', 'envelope'), 'envelope.To');
    const body = requiredString(envelope, 'Body', 'envelope');
    const event: CanonicalCellularEvent = {
      kind: 'sms_reply',
      provider: PROVIDER,
      providerAccountId: account,
      providerEventId: messageSid,
      fromNumber: from,
      toNumber: to,
      text: body,
      providerMessageId: messageSid,
      sentAt: flexibleDateToIso(envelope.Timestamp, 'envelope.Timestamp'),
    };
    // The Twilio inbound-SMS envelope is exactly the carrier-webhook shape
    // the channels contract's sms adapter documents — relay it verbatim.
    return { event, channelPayload: rawPayload };
  }

  if (!TERMINAL_MESSAGE_STATUSES.has(messageStatus)) {
    // 'queued' / 'sent' / 'accepted' / … — recognized-but-non-record.
    throw unsupportedEvent(
      `twilio delivery status '${messageStatus}' is a lifecycle ping, not a record event (terminal statuses: ${[...TERMINAL_MESSAGE_STATUSES].join(', ')})`,
    );
  }

  const detail = optionalString(envelope, 'ErrorCode');
  const event: CanonicalCellularEvent = {
    kind: 'sms_receipt',
    provider: PROVIDER,
    providerAccountId: account,
    providerEventId: `${messageSid}:${messageStatus}`,
    providerMessageId: messageSid,
    status: messageStatus as 'delivered' | 'undelivered' | 'failed',
    detail: detail === null ? null : `twilio error code ${detail}`,
    occurredAt: flexibleDateToIso(envelope.Timestamp, 'envelope.Timestamp'),
  };
  return { event, channelPayload: null };
}

// ---------------------------------------------------------------------------
// Voice: speech (reply) vs call lifecycle
// ---------------------------------------------------------------------------

function parseVoiceEvent(
  envelope: Record<string, unknown>,
  account: string,
): ParsedCellularEvent {
  const callSid = requiredString(envelope, 'CallSid', 'envelope');
  const eventKey = requiredString(envelope, 'EventKey', 'envelope');
  const from = toE164(requiredString(envelope, 'From', 'envelope'), 'envelope.From');
  const to = toE164(requiredString(envelope, 'To', 'envelope'), 'envelope.To');
  const speech = optionalString(envelope, 'SpeechResult');
  const recordingUrl = optionalString(envelope, 'RecordingUrl');
  const timestamp = flexibleDateToIso(envelope.Timestamp, 'envelope.Timestamp');

  if (speech !== null) {
    const event: CanonicalCellularEvent = {
      kind: 'voice_reply',
      provider: PROVIDER,
      providerAccountId: account,
      providerEventId: eventKey,
      providerCallId: callSid,
      fromNumber: from,
      toNumber: to,
      speech,
      recordingUrl,
      occurredAt: timestamp,
    };
    // The Twilio voice envelope (CallSid/From/To/SpeechResult/…) is the
    // carrier-webhook shape the channels contract's voice adapter
    // documents — relay it verbatim (EventKey doubles as the channels
    // message id, keeping multi-turn calls distinct).
    return { event, channelPayload: envelope };
  }

  const callStatusRaw = optionalString(envelope, 'CallStatus');
  if (callStatusRaw === null) {
    throw unsupportedEvent(
      'twilio voice webhook carries neither SpeechResult nor CallStatus (a call media/lifecycle ping, not a record event)',
    );
  }
  const callStatus = CALL_STATUS_MAP[callStatusRaw];
  if (callStatus === undefined) {
    throw new CellularError(
      'invalid_provider_payload',
      `envelope.CallStatus '${callStatusRaw}' is not a recognized twilio call status`,
    );
  }
  const duration =
    optionalNonNegativeInteger(envelope, 'CallDuration', 'envelope') ??
    optionalNonNegativeInteger(envelope, 'RecordingDuration', 'envelope');
  const event: CanonicalCellularEvent = {
    kind: 'call_status',
    provider: PROVIDER,
    providerAccountId: account,
    providerEventId: eventKey,
    providerCallId: callSid,
    callStatus,
    durationSeconds: duration,
    recordingUrl,
    occurredAt: timestamp,
  };
  return { event, channelPayload: null };
}
