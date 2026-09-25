// Telnyx telecom adapter (MODULE-INTERNAL — vendor payloads never cross
// the cellular module; lock 16 / ADR-0015 spirit; IMPLEMENTATION-STACK
// §6 provider isolation).
//
// The SECOND conforming telecom provider: a materially different wire
// shape from Twilio's that normalizes into the SAME canonical cellular
// vocabulary — the provider-swap evidence for W087 (the realtime
// module's livekit/openai-realtime discipline: the same canonical
// journey through two providers yields identical canonical domain state
// modulo provider key + opaque ids).
//
// Envelope shape (the carrier webhooks the Telnyx integration layer
// delivers as JSON; `account_id` is the messaging profile/application
// the relay received the webhook for — the same role Twilio's AccountSid
// plays):
//
//   {
//     "data": {
//       "event_type": "message.received" | "message.delivery_updated" |
//                     "call.initiated" | "call.ringing" | "call.answered" |
//                     "call.completed" | "call.no-answer" | "call.failed" |
//                     "call.speech",
//       "id": "evt…",                    // stable event id — the dedupe key
//       "occurred_at": "…ISO…",
//       "account_id": "profile…",
//       "payload": { …event-specific… }
//     }
//   }
//
//   message.received payload:
//     { id: "msg…", from: { phone_number: "+1555…" },
//       to: { phone_number: "+1555…" }, text: "…" }
//     → canonical sms_reply; the channels relay envelope is NORMALIZED
//       (the telnyx adapter IS the vendor integration layer performing
//       exactly the normalization the channels contract documents: "a
//       carrier webhook normalized to JSON (Twilio-style field names)"):
//       { From, To, Body, MessageSid: payload.id }.
//
//   message.delivery_updated payload:
//     { id: "msg…", status: "delivered" | "delivery_failed" | "failed" }
//     → canonical sms_receipt. Non-terminal statuses ('queued', 'sent',
//       'accepted', 'scheduled'…) are recognized-but-non-record and are
//       rejected as unsupported.
//
//   call.* payload (call_id, from/to phone numbers; call.completed
//   carries duration_seconds and optionally recording_url):
//     { call_id: "call…", from: "+1555…", to: "+1555…",
//       duration_seconds?: N, recording_url?: "https…" }
//     → canonical call_status (initiated / ringing / answered /
//       completed / no_answer / failed).
//
//   call.speech payload:
//     { call_id: "call…", from: "+1555…", to: "+1555…",
//       text: "spoken text", recording_url?: "https…" }
//     → canonical voice_reply; the channels relay envelope is NORMALIZED
//       to the voice shape the channels contract's voice adapter
//       documents: { CallSid, From, To, SpeechResult, EventKey: data.id }.
//
// Canonical account id: data.account_id (trimmed).
// Event ids: data.id for every event (stable across redeliveries).

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

const PROVIDER = 'telnyx' as const;

/** Terminal delivery statuses the ledger records; every other status is a non-record ping. */
const TERMINAL_DELIVERY_STATUSES = new Set(['delivered', 'delivery_failed', 'failed', 'undelivered']);

const EVENT_TYPE_TO_CALL_STATUS: Record<string, 'initiated' | 'ringing' | 'answered' | 'completed' | 'no_answer' | 'failed'> = {
  'call.initiated': 'initiated',
  'call.ringing': 'ringing',
  'call.answered': 'answered',
  'call.completed': 'completed',
  'call.no-answer': 'no_answer',
  'call.failed': 'failed',
};

/** Maps the vendor's terminal delivery statuses onto the canonical ones. */
function canonicalReceiptStatus(raw: string): 'delivered' | 'undelivered' | 'failed' {
  if (raw === 'delivered') return 'delivered';
  return raw === 'failed' ? 'failed' : 'undelivered';
}

export const telnyxAdapter: CellularAdapter = {
  provider: PROVIDER,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new CellularError('invalid_cellular_input', 'telnyx account id must be non-empty');
    }
    return text;
  },

  parseEvent(payload: unknown): ParsedCellularEvent {
    const envelope = requireObject(payload, 'telnyx event envelope');
    const data = requireObject(envelope.data, 'telnyx envelope.data');
    const account = requiredString(data, 'account_id', 'envelope.data');
    const eventId = requiredString(data, 'id', 'envelope.data');
    const eventType = requiredString(data, 'event_type', 'envelope.data');
    const eventPayload = requireObject(data.payload, 'envelope.data.payload');
    const occurredAt = flexibleDateToIso(data.occurred_at, 'envelope.data.occurred_at');

    if (eventType === 'message.received') {
      return parseMessageReceived(eventPayload, account, eventId, occurredAt);
    }
    if (eventType === 'message.delivery_updated') {
      return parseDeliveryUpdated(eventPayload, account, eventId, occurredAt);
    }
    if (eventType === 'call.speech') {
      return parseCallSpeech(eventPayload, account, eventId, occurredAt);
    }
    const callStatus = EVENT_TYPE_TO_CALL_STATUS[eventType];
    if (callStatus !== undefined) {
      return parseCallStatus(eventPayload, account, eventId, callStatus, occurredAt);
    }
    throw unsupportedEvent(
      `telnyx event_type '${eventType}' is not a record event (supported: message.received, message.delivery_updated, call.*, call.speech)`,
    );
  },
};

// ---------------------------------------------------------------------------
// message.received → sms_reply (+ normalized channels relay envelope)
// ---------------------------------------------------------------------------

function parseMessageReceived(
  payload: Record<string, unknown>,
  account: string,
  eventId: string,
  occurredAt: string | null,
): ParsedCellularEvent {
  const messageId = requiredString(payload, 'id', 'payload');
  const fromHolder = requireObject(payload.from, 'payload.from');
  const from = toE164(requiredString(fromHolder, 'phone_number', 'payload.from'), 'payload.from.phone_number');
  const toHolder = requireObject(payload.to, 'payload.to');
  const to = toE164(requiredString(toHolder, 'phone_number', 'payload.to'), 'payload.to.phone_number');
  const text = requiredString(payload, 'text', 'payload');

  const event: CanonicalCellularEvent = {
    kind: 'sms_reply',
    provider: PROVIDER,
    providerAccountId: account,
    providerEventId: eventId,
    fromNumber: from,
    toNumber: to,
    text,
    providerMessageId: messageId,
    sentAt: occurredAt,
  };
  // The normalized carrier-webhook envelope the channels contract's sms
  // adapter documents — the telnyx adapter is the vendor integration
  // layer performing this documented normalization.
  const channelPayload = {
    From: from,
    To: to,
    Body: text,
    MessageSid: messageId,
  };
  return { event, channelPayload };
}

// ---------------------------------------------------------------------------
// message.delivery_updated → sms_receipt
// ---------------------------------------------------------------------------

function parseDeliveryUpdated(
  payload: Record<string, unknown>,
  account: string,
  eventId: string,
  occurredAt: string | null,
): ParsedCellularEvent {
  const messageId = requiredString(payload, 'id', 'payload');
  const status = requiredString(payload, 'status', 'payload');
  if (!TERMINAL_DELIVERY_STATUSES.has(status)) {
    throw unsupportedEvent(
      `telnyx delivery status '${status}' is a lifecycle ping, not a record event (terminal statuses: ${[...TERMINAL_DELIVERY_STATUSES].join(', ')})`,
    );
  }
  const failureCode = optionalString(payload, 'failure_code');
  const event: CanonicalCellularEvent = {
    kind: 'sms_receipt',
    provider: PROVIDER,
    providerAccountId: account,
    providerEventId: eventId,
    providerMessageId: messageId,
    status: canonicalReceiptStatus(status),
    detail: failureCode === null ? null : `telnyx failure code ${failureCode}`,
    occurredAt,
  };
  return { event, channelPayload: null };
}

// ---------------------------------------------------------------------------
// call.speech → voice_reply (+ normalized channels relay envelope)
// ---------------------------------------------------------------------------

function parseCallSpeech(
  payload: Record<string, unknown>,
  account: string,
  eventId: string,
  occurredAt: string | null,
): ParsedCellularEvent {
  const callId = requiredString(payload, 'call_id', 'payload');
  const from = toE164(requiredString(payload, 'from', 'payload'), 'payload.from');
  const to = toE164(requiredString(payload, 'to', 'payload'), 'payload.to');
  const speech = requiredString(payload, 'text', 'payload');
  const recordingUrl = optionalString(payload, 'recording_url');

  const event: CanonicalCellularEvent = {
    kind: 'voice_reply',
    provider: PROVIDER,
    providerAccountId: account,
    providerEventId: eventId,
    providerCallId: callId,
    fromNumber: from,
    toNumber: to,
    speech,
    recordingUrl,
    occurredAt,
  };
  // The normalized voice envelope the channels contract's voice adapter
  // documents; EventKey = the stable telnyx event id keeps multi-turn
  // calls distinct in the transcript.
  const channelPayload = {
    CallSid: callId,
    From: from,
    To: to,
    SpeechResult: speech,
    ...(recordingUrl === null ? {} : { RecordingUrl: recordingUrl }),
    EventKey: eventId,
  };
  return { event, channelPayload };
}

// ---------------------------------------------------------------------------
// call.* → call_status
// ---------------------------------------------------------------------------

function parseCallStatus(
  payload: Record<string, unknown>,
  account: string,
  eventId: string,
  callStatus: 'initiated' | 'ringing' | 'answered' | 'completed' | 'no_answer' | 'failed',
  occurredAt: string | null,
): ParsedCellularEvent {
  const callId = requiredString(payload, 'call_id', 'payload');
  const durationSeconds = optionalNonNegativeInteger(payload, 'duration_seconds', 'payload');
  const recordingUrl = optionalString(payload, 'recording_url');
  const event: CanonicalCellularEvent = {
    kind: 'call_status',
    provider: PROVIDER,
    providerAccountId: account,
    providerEventId: eventId,
    providerCallId: callId,
    callStatus,
    durationSeconds,
    recordingUrl,
    occurredAt,
  };
  return { event, channelPayload: null };
}
