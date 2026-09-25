// Unit tests for the cellular module's PURE surface (W087): validation
// vocabulary, input guards, policy resolution/routing/cost logic, the
// telecom adapters' envelope parsing, and the defense-in-depth
// re-validation — no database, no clock, no network.
//
//  * vocabulary guards — providers, reach kinds/statuses, voice-fallback
//    modes, E.164/uuid primitives;
//  * the built-in floor + policy resolution — kind row → tenant default
//    → built-in, with the resolution trail;
//  * routing + cost — the voice-fallback decision, segment estimation,
//    per-leg cost, the lifetime cap;
//  * the W009 gate vocabulary — the action kind per recipient
//    classification (employee-messaging vs external-communication), the
//    stable gate key;
//  * connection/registration/policy/reach/query guards — bounds, uuid
//    checks, unknown-key rejection (a caller can never smuggle identity
//    or tenancy);
//  * twilio adapter — inbound SMS → sms_reply (+ the channels relay
//    envelope passed through verbatim), terminal delivery receipts,
//    non-terminal statuses rejected as unsupported, voice speech →
//    voice_reply, call lifecycle mapping (in-progress→answered,
//    busy/canceled→no_answer), malformed envelopes;
//  * telnyx adapter — the same canonical journey from a materially
//    different wire shape (provider-swap evidence, GOVERNANCE: the same
//    canonical capability through two providers), including the
//    NORMALIZED channels relay envelope the integration layer must
//    produce;
//  * provider-swap structural identity — the same journey through both
//    adapters yields identical canonical shapes (kind/from/to/text)
//    modulo provider key + opaque ids;
//  * defense in depth — adapter output re-validation rejects unknown
//    kinds, bad statuses, non-E.164 numbers; transport receipt
//    re-validation rejects malformed statuses/ids.

import { describe, expect, it } from 'vitest';
import { telnyxAdapter } from '../adapters/telnyx';
import { twilioAdapter } from '../adapters/twilio';
import { allCellularAdapters } from '../adapters';
import { CellularError } from '../errors';
import {
  BUILT_IN_DEFAULT_POLICY,
  CELLULAR_AUTHORITY_ADMINISTER,
  CELLULAR_REACH_AUTHORITY_LEVEL,
  fitsCostCap,
  reachActionKindFor,
  reachGateKey,
  resolveCellularPolicyRows,
  shouldFallBackToVoice,
  smsAttemptCostMinor,
  smsSegmentsOf,
  voiceAttemptCostMinor,
} from '../policy';
import {
  canAdministerCellularPolicies,
  isE164,
  isUuid,
  segmentsUnderPolicy,
  validateCanonicalCellularEvent,
  validateListCellularReachQuery,
  validateReachAnyoneInput,
  validateRegisterCellularConnectionInput,
  validateSetCellularPolicyInput,
  validateTransportSmsReceipt,
  validateTransportVoiceReceipt,
} from '../validation';
import { isCellularProvider } from '../policy';
import type { CanonicalCellularEvent, CellularPolicy } from '../types';

const UUID = '7f9c1f4a-51d6-4a8e-9c3b-2d6e8f0a1b2c';
const OTHER_UUID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

function expectCode(code: CellularError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected CellularError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof CellularError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

describe('cellular vocabulary guards', () => {
  it('accepts exactly the two canonical telecom providers', () => {
    expect(isCellularProvider('twilio')).toBe(true);
    expect(isCellularProvider('telnyx')).toBe(true);
    expect(isCellularProvider('vonage')).toBe(false);
    expect(isCellularProvider('')).toBe(false);
    expect(isCellularProvider(null)).toBe(false);
  });

  it('registers one adapter per canonical provider (exhaustiveness)', () => {
    expect(allCellularAdapters().map((a) => a.provider).sort()).toEqual(['telnyx', 'twilio']);
  });

  it('validates uuids and E.164 numbers', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isE164('+15551234567')).toBe(true);
    expect(isE164('5551234567')).toBe(false);
    expect(isE164('+0155123456')).toBe(false);
  });

  it('gates policy administration behind the administer claim', () => {
    expect(canAdministerCellularPolicies([CELLULAR_AUTHORITY_ADMINISTER])).toBe(true);
    expect(canAdministerCellularPolicies(['some-other-claim'])).toBe(false);
    expect(canAdministerCellularPolicies([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The built-in floor + policy resolution
// ---------------------------------------------------------------------------

describe('cellular policy resolution', () => {
  const kindRow: CellularPolicy = {
    id: UUID,
    tenantId: OTHER_UUID,
    reachKind: 'ask',
    voiceFallback: 'on_sms_failure',
    smsMaxAttempts: 5,
    retryBackoffSeconds: 30,
    maxSmsSegments: 2,
    smsSegmentCostMinor: 3,
    voicePerMinuteCostMinor: 99,
    currency: 'EUR',
    maxCostPerReachMinor: 500,
    note: null,
    createdAt: '2026-09-25T10:00:00Z',
    updatedAt: '2026-09-25T10:00:00Z',
  };
  const defaultRow: CellularPolicy = { ...kindRow, id: OTHER_UUID, reachKind: null };

  it('prefers the kind row over the tenant default over the built-in floor', () => {
    expect(resolveCellularPolicyRows('ask', [kindRow, defaultRow]).source).toBe('kind');
    expect(resolveCellularPolicyRows('tell', [kindRow, defaultRow]).source).toBe('tenant-default');
    expect(resolveCellularPolicyRows('tell', [kindRow]).source).toBe('built-in');
    expect(resolveCellularPolicyRows('ask', []).source).toBe('built-in');
  });

  it('resolves the kind row values when present', () => {
    const { resolved } = resolveCellularPolicyRows('ask', [kindRow, defaultRow]);
    expect(resolved.voiceFallback).toBe('on_sms_failure');
    expect(resolved.smsMaxAttempts).toBe(5);
    expect(resolved.currency).toBe('EUR');
    expect(resolved.maxCostPerReachMinor).toBe(500);
  });

  it('the built-in floor is conservative: voice fallback forbidden, budgeted retries, USD, capped', () => {
    expect(BUILT_IN_DEFAULT_POLICY.voiceFallback).toBe('forbidden');
    expect(BUILT_IN_DEFAULT_POLICY.smsMaxAttempts).toBe(3);
    expect(BUILT_IN_DEFAULT_POLICY.currency).toBe('USD');
    expect(BUILT_IN_DEFAULT_POLICY.maxCostPerReachMinor).toBeGreaterThan(0);
    const { resolved } = resolveCellularPolicyRows('tell', []);
    expect(resolved.policy).toBeNull();
    expect(resolved.voiceFallback).toBe('forbidden');
  });
});

// ---------------------------------------------------------------------------
// Routing + cost
// ---------------------------------------------------------------------------

describe('routing and cost logic', () => {
  it('voice fallback happens exactly when the policy permits it', () => {
    expect(shouldFallBackToVoice('on_sms_failure')).toBe(true);
    expect(shouldFallBackToVoice('forbidden')).toBe(false);
  });

  it('estimates SMS segments at 160 characters per segment (policy approximation)', () => {
    expect(smsSegmentsOf('hi')).toBe(1);
    expect(smsSegmentsOf('a'.repeat(160))).toBe(1);
    expect(smsSegmentsOf('a'.repeat(161))).toBe(2);
    expect(smsSegmentsOf('a'.repeat(320))).toBe(2);
  });

  it('checks the segment policy and estimates per-leg cost', () => {
    expect(segmentsUnderPolicy('hi', 4).ok).toBe(true);
    expect(segmentsUnderPolicy('a'.repeat(641), 4).ok).toBe(false);
    expect(smsAttemptCostMinor(2, 5)).toBe(10);
    expect(voiceAttemptCostMinor(150)).toBe(150);
  });

  it('enforces the lifetime cost cap (0 = uncapped)', () => {
    expect(fitsCostCap(0, 100, 1000)).toBe(true);
    expect(fitsCostCap(900, 100, 1000)).toBe(true);
    expect(fitsCostCap(901, 100, 1000)).toBe(false);
    expect(fitsCostCap(9_000_000, 100, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The W009 gate vocabulary
// ---------------------------------------------------------------------------

describe('the authority gate vocabulary', () => {
  it('gates verified employees as employee messaging, everyone else as external communication', () => {
    expect(reachActionKindFor('verified_employee')).toBe('employee-messaging');
    expect(reachActionKindFor('verified_person')).toBe('external-communication');
    expect(reachActionKindFor('unverified_identity')).toBe('external-communication');
    expect(reachActionKindFor('unknown_number')).toBe('external-communication');
  });

  it('uses the ASK level with a stable per-request gate key', () => {
    expect(CELLULAR_REACH_AUTHORITY_LEVEL).toBe('ASK');
    expect(reachGateKey(UUID)).toBe(`cellular-reach:${UUID}`);
  });
});

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

describe('connection registration validation', () => {
  it('accepts a connection and normalizes whitespace', () => {
    const valid = validateRegisterCellularConnectionInput({
      provider: 'twilio',
      providerAccountId: '  AC-main  ',
      phoneNumber: '+15550100000',
      credentialRef: 'secret-store:twilio/1',
      displayName: ' Ops number ',
    });
    expect(valid.providerAccountId).toBe('AC-main');
    expect(valid.phoneNumber).toBe('+15550100000');
    expect(valid.displayName).toBe('Ops number');
  });

  it('rejects bad vendors, numbers, and unknown fields', () => {
    expectCode('invalid_cellular_input', () =>
      validateRegisterCellularConnectionInput({
        provider: 'vonage' as never,
        providerAccountId: 'AC-main',
        phoneNumber: '+15550100000',
        credentialRef: 'secret-store:1',
      }),
    );
    expectCode('invalid_cellular_input', () =>
      validateRegisterCellularConnectionInput({
        provider: 'twilio',
        providerAccountId: 'AC-main',
        phoneNumber: '5550100000',
        credentialRef: 'secret-store:1',
      }),
    );
    expectCode('invalid_cellular_input', () =>
      validateRegisterCellularConnectionInput({
        provider: 'twilio',
        providerAccountId: 'AC-main',
        phoneNumber: '+15550100000',
        credentialRef: 'secret-store:1',
        tenantId: OTHER_UUID, // a caller can never smuggle tenancy
      } as never),
    );
  });
});

describe('policy input validation', () => {
  it('accepts a coherent policy update', () => {
    const valid = validateSetCellularPolicyInput({
      reachKind: 'ask',
      voiceFallback: 'on_sms_failure',
      smsMaxAttempts: 5,
      currency: 'EUR',
      maxCostPerReachMinor: 500,
    });
    expect(valid.reachKind).toBe('ask');
    expect(valid.voiceFallback).toBe('on_sms_failure');
    expect(valid.currency).toBe('EUR');
  });

  it('rejects out-of-bounds numbers, bad currencies, bad kinds, unknown fields', () => {
    expectCode('invalid_cellular_input', () =>
      validateSetCellularPolicyInput({ smsMaxAttempts: 11 }),
    );
    expectCode('invalid_cellular_input', () =>
      validateSetCellularPolicyInput({ currency: 'usd' }),
    );
    expectCode('invalid_cellular_input', () =>
      validateSetCellularPolicyInput({ reachKind: 'demand' as never }),
    );
    expectCode('invalid_cellular_input', () =>
      validateSetCellularPolicyInput({ voiceFallback: 'always' as never }),
    );
    expectCode('invalid_cellular_input', () => validateSetCellularPolicyInput({ id: UUID } as never));
  });
});

describe('reach input validation', () => {
  const base = {
    kind: 'tell' as const,
    text: 'The demo moved to 15:00.',
    phoneNumber: '+15551234567',
  };

  it('accepts a raw-number reach', () => {
    const valid = validateReachAnyoneInput(base);
    expect(valid.phoneNumber).toBe('+15551234567');
    expect(valid.personId).toBeNull();
  });

  it('accepts a person reach and normalizes the number', () => {
    const valid = validateReachAnyoneInput({
      kind: 'ask',
      text: 'Please confirm.',
      personId: UUID,
      phoneNumber: null,
    });
    expect(valid.personId).toBe(UUID);
  });

  it('requires exactly one of personId/phoneNumber and a bounded text', () => {
    expectCode('invalid_cellular_input', () =>
      validateReachAnyoneInput({ kind: 'tell', text: 'x' }),
    );
    expectCode('invalid_cellular_input', () =>
      validateReachAnyoneInput({ kind: 'tell', text: 'x', personId: UUID, phoneNumber: '+15551234567' }),
    );
    expectCode('invalid_cellular_input', () =>
      validateReachAnyoneInput({ kind: 'tell', text: 'x', personId: 'not-a-uuid' }),
    );
    expectCode('invalid_cellular_input', () =>
      validateReachAnyoneInput({ ...base, text: 'a'.repeat(641) }),
    );
    expectCode('invalid_cellular_input', () =>
      validateReachAnyoneInput({ ...base, kind: 'demand' as never }),
    );
    expectCode('invalid_cellular_input', () =>
      validateReachAnyoneInput({ ...base, status: 'sent' } as never), // no lifecycle smuggling
    );
  });

  it('validates the failure-notification target against the channel vocabulary', () => {
    expectCode('invalid_cellular_input', () =>
      validateReachAnyoneInput({
        ...base,
        failureNotification: { provider: 'carrier-pigeon', providerAccountId: 'x' },
      }),
    );
    const valid = validateReachAnyoneInput({
      ...base,
      failureNotification: { provider: 'email', providerAccountId: 'boss@example.com' },
    });
    expect(valid.failureNotification).not.toBeNull();
  });
});

describe('query guards', () => {
  it('reach list queries validate filters and limits', () => {
    const valid = validateListCellularReachQuery({ status: 'sent', limit: 10 });
    expect(valid.status).toBe('sent');
    expect(valid.limit).toBe(10);
    expectCode('invalid_cellular_query', () =>
      validateListCellularReachQuery({ status: 'exploded' as never }),
    );
    expectCode('invalid_cellular_query', () => validateListCellularReachQuery({ limit: 501 }));
    expectCode('invalid_cellular_query', () =>
      validateListCellularReachQuery({ tenantId: OTHER_UUID } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// The twilio adapter
// ---------------------------------------------------------------------------

const TWILIO_INBOUND_SMS = {
  From: '+15551234567',
  To: '+15550100000',
  Body: 'Got it — see you at 15:00.',
  MessageSid: 'SM inbound 1'.replace(/ /g, '_'),
  AccountSid: 'AC main'.replace(/ /g, '_'),
};

describe('the twilio adapter', () => {
  it('parses an inbound SMS into a canonical sms_reply and relays the envelope verbatim', () => {
    const { event, channelPayload } = twilioAdapter.parseEvent(TWILIO_INBOUND_SMS);
    expect(event.kind).toBe('sms_reply');
    if (event.kind !== 'sms_reply') return;
    expect(event.provider).toBe('twilio');
    expect(event.fromNumber).toBe('+15551234567');
    expect(event.toNumber).toBe('+15550100000');
    expect(event.text).toBe('Got it — see you at 15:00.');
    expect(event.providerMessageId).toBe(event.providerEventId);
    // The channels relay envelope is the ORIGINAL Twilio-shaped webhook —
    // the channels contract's sms adapter parses this shape natively.
    expect(channelPayload).toBe(TWILIO_INBOUND_SMS);
  });

  it('parses a terminal delivery receipt with a status-suffixed event id', () => {
    const { event, channelPayload } = twilioAdapter.parseEvent({
      MessageSid: 'SM_outbound_1',
      MessageStatus: 'delivered',
      AccountSid: 'AC_main',
      Timestamp: '2026-09-25T10:05:00Z',
    });
    expect(event.kind).toBe('sms_receipt');
    if (event.kind !== 'sms_receipt') return;
    expect(event.providerEventId).toBe('SM_outbound_1:delivered');
    expect(event.providerMessageId).toBe('SM_outbound_1');
    expect(event.status).toBe('delivered');
    expect(event.occurredAt).toBe('2026-09-25T10:05:00.000Z');
    expect(channelPayload).toBeNull(); // receipts never reach the channels edge
  });

  it('rejects non-terminal delivery statuses as unsupported (lifecycle pings)', () => {
    expectCode('unsupported_provider_event', () =>
      twilioAdapter.parseEvent({ MessageSid: 'SM1', MessageStatus: 'queued', AccountSid: 'AC1' }),
    );
    expectCode('unsupported_provider_event', () =>
      twilioAdapter.parseEvent({ MessageSid: 'SM1', MessageStatus: 'sent', AccountSid: 'AC1' }),
    );
  });

  it('parses voice speech into a voice_reply (the channels relay envelope carries EventKey)', () => {
    const { event, channelPayload } = twilioAdapter.parseEvent({
      CallSid: 'CA_call_1',
      From: '+15551234567',
      To: '+15550100000',
      AccountSid: 'AC_main',
      EventKey: 'evt_speech_1',
      SpeechResult: 'Yes, I will be there.',
      RecordingUrl: 'https://recordings.invalid/CA1',
    });
    expect(event.kind).toBe('voice_reply');
    if (event.kind !== 'voice_reply') return;
    expect(event.providerCallId).toBe('CA_call_1');
    expect(event.speech).toBe('Yes, I will be there.');
    expect(event.recordingUrl).toBe('https://recordings.invalid/CA1');
    expect(channelPayload).toEqual({
      CallSid: 'CA_call_1',
      From: '+15551234567',
      To: '+15550100000',
      AccountSid: 'AC_main',
      EventKey: 'evt_speech_1',
      SpeechResult: 'Yes, I will be there.',
      RecordingUrl: 'https://recordings.invalid/CA1',
    });
  });

  it('maps call lifecycle statuses onto the canonical vocabulary', () => {
    const call = (status: string) => ({
      CallSid: 'CA1',
      From: '+15551234567',
      To: '+15550100000',
      AccountSid: 'AC1',
      EventKey: `evt_${status}`,
      CallStatus: status,
    });
    const expectStatus = (status: string, canonical: string) => {
      const { event } = twilioAdapter.parseEvent(call(status));
      expect(event.kind).toBe('call_status');
      if (event.kind !== 'call_status') return;
      expect(event.callStatus).toBe(canonical);
    };
    expectStatus('initiated', 'initiated');
    expectStatus('ringing', 'ringing');
    expectStatus('in-progress', 'answered');
    expectStatus('completed', 'completed');
    expectStatus('no-answer', 'no_answer');
    expectStatus('busy', 'no_answer');
    expectStatus('canceled', 'no_answer');
    expectStatus('failed', 'failed');
  });

  it('captures call completion details and rejects malformed envelopes', () => {
    const { event } = twilioAdapter.parseEvent({
      CallSid: 'CA1',
      From: '+15551234567',
      To: '+15550100000',
      AccountSid: 'AC1',
      EventKey: 'evt_completed',
      CallStatus: 'completed',
      CallDuration: 42,
      RecordingUrl: 'https://recordings.invalid/CA1',
    });
    expect(event.kind).toBe('call_status');
    if (event.kind !== 'call_status') return;
    expect(event.durationSeconds).toBe(42);
    expect(event.recordingUrl).toBe('https://recordings.invalid/CA1');

    expectCode('invalid_provider_payload', () => twilioAdapter.parseEvent('not-an-object'));
    expectCode('invalid_provider_payload', () => twilioAdapter.parseEvent({ From: '+1555' }));
    expectCode('invalid_provider_payload', () =>
      twilioAdapter.parseEvent({
        CallSid: 'CA1',
        From: '+15551234567',
        To: '+15550100000',
        AccountSid: 'AC1',
        CallStatus: 'teleported',
      }),
    );
    // A voice webhook carrying neither speech nor a call status is a ping.
    expectCode('unsupported_provider_event', () =>
      twilioAdapter.parseEvent({
        CallSid: 'CA1',
        From: '+15551234567',
        To: '+15550100000',
        AccountSid: 'AC_main',
        EventKey: 'evt_ping',
      }),
    );
  });

  it('normalizes account ids and rejects emptiness', () => {
    expect(twilioAdapter.normalizeAccountId('  AC-main  ')).toBe('AC-main');
    expectCode('invalid_cellular_input', () => twilioAdapter.normalizeAccountId('   '));
  });
});

// ---------------------------------------------------------------------------
// The telnyx adapter (the second conforming provider)
// ---------------------------------------------------------------------------

const TELNYX_INBOUND_SMS = {
  data: {
    event_type: 'message.received',
    id: 'evt_telnyx_1',
    occurred_at: '2026-09-25T10:00:30Z',
    account_id: 'profile_main',
    payload: {
      id: 'msg_telnyx_1',
      from: { phone_number: '+15551234567' },
      to: { phone_number: '+15550100000' },
      text: 'Got it — see you at 15:00.',
    },
  },
};

describe('the telnyx adapter', () => {
  it('parses message.received into the SAME canonical sms_reply and normalizes the channels relay envelope', () => {
    const { event, channelPayload } = telnyxAdapter.parseEvent(TELNYX_INBOUND_SMS);
    expect(event.kind).toBe('sms_reply');
    if (event.kind !== 'sms_reply') return;
    expect(event.provider).toBe('telnyx');
    expect(event.providerEventId).toBe('evt_telnyx_1');
    expect(event.fromNumber).toBe('+15551234567');
    expect(event.toNumber).toBe('+15550100000');
    expect(event.text).toBe('Got it — see you at 15:00.');
    expect(event.providerMessageId).toBe('msg_telnyx_1');
    // The normalized carrier-webhook envelope the channels contract's sms
    // adapter documents (Twilio-style field names).
    expect(channelPayload).toEqual({
      From: '+15551234567',
      To: '+15550100000',
      Body: 'Got it — see you at 15:00.',
      MessageSid: 'msg_telnyx_1',
    });
  });

  it('parses terminal delivery updates and rejects lifecycle pings', () => {
    const { event } = telnyxAdapter.parseEvent({
      data: {
        event_type: 'message.delivery_updated',
        id: 'evt_dlr_1',
        occurred_at: '2026-09-25T10:05:00Z',
        account_id: 'profile_main',
        payload: { id: 'msg_telnyx_1', status: 'delivery_failed', failure_code: '470' },
      },
    });
    expect(event.kind).toBe('sms_receipt');
    if (event.kind !== 'sms_receipt') return;
    expect(event.providerMessageId).toBe('msg_telnyx_1');
    expect(event.status).toBe('undelivered');
    expect(event.detail).toBe('telnyx failure code 470');

    expectCode('unsupported_provider_event', () =>
      telnyxAdapter.parseEvent({
        data: {
          event_type: 'message.delivery_updated',
          id: 'evt_dlr_2',
          account_id: 'p',
          payload: { id: 'm', status: 'queued' },
        },
      }),
    );
    expectCode('unsupported_provider_event', () =>
      telnyxAdapter.parseEvent({
        data: { event_type: 'message.finalized', id: 'evt_x', account_id: 'p', payload: {} },
      }),
    );
  });

  it('parses call.speech into a voice_reply with the normalized voice relay envelope', () => {
    const { event, channelPayload } = telnyxAdapter.parseEvent({
      data: {
        event_type: 'call.speech',
        id: 'evt_speech_telnyx',
        occurred_at: '2026-09-25T10:06:00Z',
        account_id: 'profile_main',
        payload: {
          call_id: 'call_telnyx_1',
          from: '+15551234567',
          to: '+15550100000',
          text: 'Yes, I will be there.',
          recording_url: 'https://recordings.invalid/c1',
        },
      },
    });
    expect(event.kind).toBe('voice_reply');
    if (event.kind !== 'voice_reply') return;
    expect(event.providerCallId).toBe('call_telnyx_1');
    expect(event.speech).toBe('Yes, I will be there.');
    expect(channelPayload).toEqual({
      CallSid: 'call_telnyx_1',
      From: '+15551234567',
      To: '+15550100000',
      SpeechResult: 'Yes, I will be there.',
      RecordingUrl: 'https://recordings.invalid/c1',
      EventKey: 'evt_speech_telnyx',
    });
  });

  it('maps call lifecycle event types onto the canonical vocabulary', () => {
    const callEvent = (event_type: string, extra: Record<string, unknown> = {}) => ({
      data: {
        event_type,
        id: `evt_${event_type.replace(/[.-]/g, '_')}`,
        account_id: 'profile_main',
        payload: {
          call_id: 'call_telnyx_1',
          from: '+15551234567',
          to: '+15550100000',
          ...extra,
        },
      },
    });
    const expectStatus = (event_type: string, canonical: string) => {
      const { event } = telnyxAdapter.parseEvent(callEvent(event_type));
      expect(event.kind).toBe('call_status');
      if (event.kind !== 'call_status') return;
      expect(event.callStatus).toBe(canonical);
    };
    expectStatus('call.initiated', 'initiated');
    expectStatus('call.ringing', 'ringing');
    expectStatus('call.answered', 'answered');
    expectStatus('call.no-answer', 'no_answer');
    expectStatus('call.failed', 'failed');

    const { event } = telnyxAdapter.parseEvent(
      callEvent('call.completed', { duration_seconds: 30, recording_url: 'https://r.invalid/c1' }),
    );
    expect(event.kind).toBe('call_status');
    if (event.kind !== 'call_status') return;
    expect(event.callStatus).toBe('completed');
    expect(event.durationSeconds).toBe(30);
    expect(event.recordingUrl).toBe('https://r.invalid/c1');
  });

  it('rejects malformed envelopes', () => {
    expectCode('invalid_provider_payload', () => telnyxAdapter.parseEvent({}));
    expectCode('invalid_provider_payload', () => telnyxAdapter.parseEvent({ data: 'nope' }));
    expectCode('invalid_provider_payload', () =>
      telnyxAdapter.parseEvent({
        data: { event_type: 'message.received', id: 'e', account_id: 'p', payload: { id: 'm' } },
      }),
    );
    expect(telnyxAdapter.normalizeAccountId('  profile-main  ')).toBe('profile-main');
    expectCode('invalid_cellular_input', () => telnyxAdapter.normalizeAccountId(''));
  });
});

// ---------------------------------------------------------------------------
// Provider-swap structural identity (GOVERNANCE provider-swap evidence)
// ---------------------------------------------------------------------------

describe('provider swap: the same journey through both vendors', () => {
  it('yields identical canonical reply shapes modulo provider key and opaque ids', () => {
    const twilioReply = twilioAdapter.parseEvent(TWILIO_INBOUND_SMS).event;
    const telnyxReply = telnyxAdapter.parseEvent(TELNYX_INBOUND_SMS).event;
    expect(twilioReply.kind).toBe(telnyxReply.kind);
    if (twilioReply.kind === 'sms_reply' && telnyxReply.kind === 'sms_reply') {
      expect(twilioReply.text).toBe(telnyxReply.text);
      expect(twilioReply.fromNumber).toBe(telnyxReply.fromNumber);
      expect(twilioReply.toNumber).toBe(telnyxReply.toNumber);
    }

    const twilioVoice = twilioAdapter.parseEvent({
      CallSid: 'CA1',
      From: '+15551234567',
      To: '+15550100000',
      AccountSid: 'AC_main',
      EventKey: 'evt_s1',
      SpeechResult: 'Yes, I will be there.',
    }).event;
    const telnyxVoice = telnyxAdapter.parseEvent({
      data: {
        event_type: 'call.speech',
        id: 'evt_s2',
        account_id: 'profile_main',
        payload: {
          call_id: 'c2',
          from: '+15551234567',
          to: '+15550100000',
          text: 'Yes, I will be there.',
        },
      },
    }).event;
    expect(twilioVoice.kind).toBe(telnyxVoice.kind);
    if (twilioVoice.kind === 'voice_reply' && telnyxVoice.kind === 'voice_reply') {
      expect(twilioVoice.speech).toBe(telnyxVoice.speech);
      expect(twilioVoice.fromNumber).toBe(telnyxVoice.fromNumber);
    }
  });

  it('produces channels relay envelopes of the same documented shape', () => {
    const twilioRelay = twilioAdapter.parseEvent(TWILIO_INBOUND_SMS)
      .channelPayload as Record<string, unknown>;
    const telnyxRelay = telnyxAdapter.parseEvent(TELNYX_INBOUND_SMS)
      .channelPayload as Record<string, unknown>;
    // The channels sms adapter requires exactly From/To/Body/MessageSid —
    // both relays carry them; From/To/Body are identical, the MessageSid
    // is each vendor's own opaque id for the same real-world message.
    for (const field of ['From', 'To', 'Body']) {
      expect(twilioRelay[field]).toBeDefined();
      expect(telnyxRelay[field]).toBe(twilioRelay[field]);
    }
    expect(typeof twilioRelay.MessageSid).toBe('string');
    expect(typeof telnyxRelay.MessageSid).toBe('string');
    expect(Object.keys(telnyxRelay).sort()).toEqual(['Body', 'From', 'MessageSid', 'To']);
  });
});

// ---------------------------------------------------------------------------
// Defense in depth
// ---------------------------------------------------------------------------

describe('adapter output re-validation', () => {
  const reply: CanonicalCellularEvent = {
    kind: 'sms_reply',
    provider: 'twilio',
    providerAccountId: 'AC_main',
    providerEventId: 'SM1',
    fromNumber: '+15551234567',
    toNumber: '+15550100000',
    text: 'hi',
    providerMessageId: 'SM1',
    sentAt: null,
  };

  it('accepts a well-formed canonical event', () => {
    expect(validateCanonicalCellularEvent(reply)).toEqual(reply);
  });

  it('rejects unknown kinds, bad providers, non-E.164 numbers, bad statuses', () => {
    expectCode('invalid_provider_payload', () =>
      validateCanonicalCellularEvent({ ...reply, kind: 'smoke_signal' } as never),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalCellularEvent({ ...reply, provider: 'vonage' as never }),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalCellularEvent({ ...reply, fromNumber: '555' }),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalCellularEvent({
        kind: 'sms_receipt',
        provider: 'twilio',
        providerAccountId: 'AC_main',
        providerEventId: 'SM1',
        providerMessageId: 'SM1',
        status: 'teleported',
        detail: null,
        occurredAt: null,
      } as never),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalCellularEvent({
        kind: 'call_status',
        provider: 'twilio',
        providerAccountId: 'AC_main',
        providerEventId: 'e1',
        providerCallId: 'CA1',
        callStatus: 'beamed-up',
        durationSeconds: null,
        recordingUrl: null,
        occurredAt: null,
      } as never),
    );
  });

  it('rejects empty speech on voice replies', () => {
    expectCode('invalid_provider_payload', () =>
      validateCanonicalCellularEvent({
        kind: 'voice_reply',
        provider: 'twilio',
        providerAccountId: 'AC_main',
        providerEventId: 'e1',
        providerCallId: 'CA1',
        fromNumber: '+15551234567',
        toNumber: '+15550100000',
        speech: '   ',
        recordingUrl: null,
        occurredAt: null,
      }),
    );
  });
});

describe('transport receipt re-validation', () => {
  it('accepts well-formed receipts and rejects malformed ones loudly', () => {
    expect(validateTransportSmsReceipt({ status: 'accepted', providerMessageId: 'SM1', detail: null }).status).toBe('accepted');
    expect(validateTransportVoiceReceipt({ status: 'answered', providerCallId: 'CA1', detail: null }).status).toBe('answered');
    expect(() =>
      validateTransportSmsReceipt({ status: 'teleported', providerMessageId: null, detail: null }),
    ).toThrow(/internal invariant violation/);
    expect(() =>
      validateTransportSmsReceipt({ status: 'accepted', providerMessageId: '\u0000bad', detail: null }),
    ).toThrow(/internal invariant violation/);
    expect(() =>
      validateTransportVoiceReceipt({ status: 'answered', providerCallId: '', detail: null }),
    ).toThrow(/internal invariant violation/);
  });
});
