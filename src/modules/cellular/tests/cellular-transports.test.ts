// Unit tests of the LIVE vendor transports (W108) — request construction
// against the documented Twilio/Telnyx REST shapes, auth headers,
// receipt mapping and the delivery-error taxonomy (transient 'failed' vs
// permanent 'rejected'), with an injected deterministic fetch double —
// NO network in tests. This is the VENDOR-SHAPE-VERIFICATION layer of
// the W108 evidence: the request/response shapes asserted here are the
// vendors' documented contracts (see the adapter file headers for the
// exact shapes and their provenance).
//
// The voice legs' bounded-poll bridge (create → poll → terminal) is
// exercised end-to-end against the double, including the honest
// incomplete-observation mappings at window expiry.

import { describe, expect, it } from 'vitest';
import { createTwilioTransport } from '../adapters/transport-twilio';
import { createTelnyxTransport } from '../adapters/transport-telnyx';
import type { CellularSmsRequest, CellularVoiceRequest } from '../types';

// ---------------------------------------------------------------------------
// The deterministic fetch double (records every exchange)
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private handler: (url: string, init: RequestInit) => Promise<Response> = () => {
    throw new Error('no handler scripted');
  };

  on(handler: (url: string, init: RequestInit) => Promise<Response>): void {
    this.handler = handler;
  }

  readonly fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    this.calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : null,
    });
    return this.handler(url, init);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function formResponse(status: number, body: Record<string, unknown>): Response {
  return jsonResponse(status, body);
}

function smsRequest(overrides: Partial<CellularSmsRequest> = {}): CellularSmsRequest {
  return {
    provider: 'twilio',
    tenantId: 'tenant-1',
    connectionId: 'conn-1',
    fromNumber: '+15550100000',
    toNumber: '+15551234567',
    text: 'The demo moved to 15:00',
    segments: 1,
    attemptId: 'attempt-1',
    ...overrides,
  };
}

function voiceRequest(overrides: Partial<CellularVoiceRequest> = {}): CellularVoiceRequest {
  return {
    provider: 'twilio',
    tenantId: 'tenant-1',
    connectionId: 'conn-1',
    fromNumber: '+15550100000',
    toNumber: '+15551234567',
    text: 'The demo moved to 15:00',
    attemptId: 'attempt-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Twilio — SMS
// ---------------------------------------------------------------------------

describe('twilio transport — sendSms', () => {
  it('constructs the documented Messages request (Basic auth, form body)', async () => {
    const fake = new FakeFetch();
    fake.on(() => Promise.resolve(formResponse(201, { sid: 'SM123', status: 'queued' })));
    const transport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: fake.fetch,
    });

    const receipt = await transport.sendSms(smsRequest());

    expect(receipt).toEqual({ status: 'accepted', providerMessageId: 'SM123', detail: null });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe(
      `Basic ${Buffer.from('AC_test:token-test').toString('base64')}`,
    );
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(call.body ?? '');
    expect(body.get('To')).toBe('+15551234567');
    expect(body.get('From')).toBe('+15550100000');
    expect(body.get('Body')).toBe('The demo moved to 15:00');
  });

  it('honors a configured API base URL override', async () => {
    const fake = new FakeFetch();
    fake.on(() => Promise.resolve(formResponse(201, { sid: 'SM1' })));
    const transport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      baseUrl: 'https://twilio-proxy.example.com',
      fetchImpl: fake.fetch,
    });
    await transport.sendSms(smsRequest());
    expect(fake.calls[0]!.url).toBe(
      'https://twilio-proxy.example.com/2010-04-01/Accounts/AC_test/Messages.json',
    );
  });

  it('maps the vendor error taxonomy: 400 invalid number → permanent rejected', async () => {
    const fake = new FakeFetch();
    fake.on(() =>
      Promise.resolve(
        jsonResponse(400, {
          code: 21211,
          message: "The 'To' number is not a valid phone number",
          more_info: 'https://www.twilio.com/docs/errors/21211',
        }),
      ),
    );
    const transport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: fake.fetch,
    });
    const receipt = await transport.sendSms(smsRequest());
    expect(receipt.status).toBe('rejected');
    expect(receipt.providerMessageId).toBeNull();
    expect(receipt.detail).toContain('21211');
    expect(receipt.detail).toContain('not a valid phone number');
  });

  it('maps auth/rate/server/network failures to the transient bucket', async () => {
    for (const scenario of [
      { status: 401, body: { message: 'authenticated request' } },
      { status: 402, body: { message: 'upgrade to send messages' } },
      { status: 429, body: { message: 'too many requests' } },
      { status: 503, body: { message: 'service unavailable' } },
    ]) {
      const fake = new FakeFetch();
      fake.on(() => Promise.resolve(jsonResponse(scenario.status, scenario.body)));
      const transport = createTwilioTransport({
        accountSid: 'AC_test',
        authToken: 'token-test',
        fetchImpl: fake.fetch,
      });
      const receipt = await transport.sendSms(smsRequest());
      expect(receipt.status).toBe('failed');
      expect(receipt.providerMessageId).toBeNull();
      expect(receipt.detail).toContain(`http ${scenario.status}`);
    }

    const networkFake = new FakeFetch();
    networkFake.on(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const networkTransport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: networkFake.fetch,
    });
    const networkReceipt = await networkTransport.sendSms(smsRequest());
    expect(networkReceipt.status).toBe('failed');
    expect(networkReceipt.detail).toContain('network/timeout');
    expect(networkReceipt.detail).toContain('ECONNREFUSED');
  });

  it('never fabricates a provider message id: 2xx without sid is transient', async () => {
    const fake = new FakeFetch();
    fake.on(() => Promise.resolve(formResponse(201, {})));
    const transport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: fake.fetch,
    });
    const receipt = await transport.sendSms(smsRequest());
    expect(receipt.status).toBe('failed');
    expect(receipt.providerMessageId).toBeNull();
    expect(receipt.detail).toContain('without a message sid');
  });
});

// ---------------------------------------------------------------------------
// Twilio — voice (create + bounded poll)
// ---------------------------------------------------------------------------

describe('twilio transport — placeVoiceCall', () => {
  it('constructs the documented Calls request (Twiml with XML-escaped text)', async () => {
    const fake = new FakeFetch();
    fake.on(() => Promise.resolve(formResponse(201, { sid: 'CA1', status: 'queued' })));
    const transport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: fake.fetch,
      voiceWaitMs: 10,
      voicePollIntervalMs: 1,
    });
    // The poll never returns a terminal state within the tiny window —
    // the CREATE request shape is what this case asserts.
    await transport.placeVoiceCall(voiceRequest({ text: 'P&L <report> arrived' }));
    const create = fake.calls[0]!;
    expect(create.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls.json');
    const body = new URLSearchParams(create.body ?? '');
    expect(body.get('To')).toBe('+15551234567');
    expect(body.get('From')).toBe('+15550100000');
    expect(body.get('Twiml')).toBe('<Response><Say>P&amp;L &lt;report&gt; arrived</Say></Response>');
  });

  it('polls to a completed call → answered (the message was spoken)', async () => {
    const fake = new FakeFetch();
    const pollBodies = [{ status: 'ringing' }, { status: 'in-progress' }, { status: 'completed' }];
    fake.on((url) => {
      if (url.endsWith('/Calls.json')) {
        return Promise.resolve(formResponse(201, { sid: 'CA1', status: 'queued' }));
      }
      return Promise.resolve(formResponse(200, pollBodies.shift() ?? { status: 'completed' }));
    });
    const transport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: fake.fetch,
      voiceWaitMs: 5_000,
      voicePollIntervalMs: 1,
    });
    const receipt = await transport.placeVoiceCall(voiceRequest());
    expect(receipt).toEqual({ status: 'answered', providerCallId: 'CA1', detail: null });
    // create + three polls
    expect(fake.calls.length).toBe(4);
    expect(fake.calls[1]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls/CA1.json');
    expect(fake.calls[1]!.headers['authorization']).toBe(
      `Basic ${Buffer.from('AC_test:token-test').toString('base64')}`,
    );
  });

  it('maps unanswered terminal statuses', async () => {
    for (const terminal of ['no-answer', 'busy', 'canceled']) {
      const fake = new FakeFetch();
      fake.on((url) => {
        if (url.endsWith('/Calls.json')) {
          return Promise.resolve(formResponse(201, { sid: 'CA1' }));
        }
        return Promise.resolve(formResponse(200, { status: terminal }));
      });
      const transport = createTwilioTransport({
        accountSid: 'AC_test',
        authToken: 'token-test',
        fetchImpl: fake.fetch,
        voiceWaitMs: 5_000,
        voicePollIntervalMs: 1,
      });
      const receipt = await transport.placeVoiceCall(voiceRequest());
      expect(receipt.status).toBe('no_answer');
      expect(receipt.providerCallId).toBe('CA1');
      expect(receipt.detail).toContain(terminal);
    }
  });

  it('maps a failed call status and refused creation honestly', async () => {
    const failedFake = new FakeFetch();
    failedFake.on((url) => {
      if (url.endsWith('/Calls.json')) return Promise.resolve(formResponse(201, { sid: 'CA1' }));
      return Promise.resolve(formResponse(200, { status: 'failed' }));
    });
    const failedTransport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: failedFake.fetch,
      voiceWaitMs: 5_000,
      voicePollIntervalMs: 1,
    });
    expect((await failedTransport.placeVoiceCall(voiceRequest())).status).toBe('failed');

    const refusedFake = new FakeFetch();
    refusedFake.on(() =>
      Promise.resolve(jsonResponse(400, { code: 21214, message: 'not a valid phone number' })),
    );
    const refusedTransport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: refusedFake.fetch,
    });
    const refused = await refusedTransport.placeVoiceCall(voiceRequest());
    expect(refused.status).toBe('failed'); // the voice receipt taxonomy has no permanent slot
    expect(refused.detail).toContain('21214');
  });

  it('window expiry: in-progress → answered, ringing → no_answer (honest observation)', async () => {
    const inProgressFake = new FakeFetch();
    inProgressFake.on((url) => {
      if (url.endsWith('/Calls.json')) return Promise.resolve(formResponse(201, { sid: 'CA1' }));
      return Promise.resolve(formResponse(200, { status: 'in-progress' }));
    });
    const inProgressTransport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: inProgressFake.fetch,
      voiceWaitMs: 20,
      voicePollIntervalMs: 1,
    });
    const stillSpeaking = await inProgressTransport.placeVoiceCall(voiceRequest());
    expect(stillSpeaking.status).toBe('answered');
    expect(stillSpeaking.detail).toContain('wait window');

    const ringingFake = new FakeFetch();
    ringingFake.on((url) => {
      if (url.endsWith('/Calls.json')) return Promise.resolve(formResponse(201, { sid: 'CA1' }));
      return Promise.resolve(formResponse(200, { status: 'ringing' }));
    });
    const ringingTransport = createTwilioTransport({
      accountSid: 'AC_test',
      authToken: 'token-test',
      fetchImpl: ringingFake.fetch,
      voiceWaitMs: 20,
      voicePollIntervalMs: 1,
    });
    const neverAnswered = await ringingTransport.placeVoiceCall(voiceRequest());
    expect(neverAnswered.status).toBe('no_answer');
    expect(neverAnswered.detail).toContain('did not reach a terminal status');
  });
});

// ---------------------------------------------------------------------------
// Telnyx — SMS
// ---------------------------------------------------------------------------

describe('telnyx transport — sendSms', () => {
  it('constructs the documented /v2/messages request (Bearer auth, JSON body)', async () => {
    const fake = new FakeFetch();
    fake.on(() =>
      Promise.resolve(jsonResponse(201, { data: { id: 'msg-1', status: 'queued' } })),
    );
    const transport = createTelnyxTransport({ apiKey: 'KEYtest', fetchImpl: fake.fetch });

    const receipt = await transport.sendSms(
      smsRequest({ provider: 'telnyx', text: 'The demo moved to 15:00' }),
    );

    expect(receipt).toEqual({ status: 'accepted', providerMessageId: 'msg-1', detail: null });
    const call = fake.calls[0]!;
    expect(call.url).toBe('https://api.telnyx.com/v2/messages');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer KEYtest');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body ?? '')).toEqual({
      from: '+15550100000',
      to: '+15551234567',
      text: 'The demo moved to 15:00',
    });
  });

  it('maps the vendor error taxonomy: 400 invalid number → permanent rejected', async () => {
    const fake = new FakeFetch();
    fake.on(() =>
      Promise.resolve(
        jsonResponse(400, {
          errors: [{ code: '10018', title: 'Invalid phone number', detail: '+1555… is not valid' }],
        }),
      ),
    );
    const transport = createTelnyxTransport({ apiKey: 'KEYtest', fetchImpl: fake.fetch });
    const receipt = await transport.sendSms(smsRequest({ provider: 'telnyx' }));
    expect(receipt.status).toBe('rejected');
    expect(receipt.detail).toContain('10018');
    expect(receipt.detail).toContain('Invalid phone number');
  });

  it('maps auth/rate/server/network failures to the transient bucket', async () => {
    for (const scenario of [
      { status: 401, body: { errors: [{ title: 'Unauthorized' }] } },
      { status: 429, body: { errors: [{ title: 'Rate limit' }] } },
      { status: 500, body: { errors: [{ title: 'Server error' }] } },
    ]) {
      const fake = new FakeFetch();
      fake.on(() => Promise.resolve(jsonResponse(scenario.status, scenario.body)));
      const transport = createTelnyxTransport({ apiKey: 'KEYtest', fetchImpl: fake.fetch });
      const receipt = await transport.sendSms(smsRequest({ provider: 'telnyx' }));
      expect(receipt.status).toBe('failed');
    }

    const networkFake = new FakeFetch();
    networkFake.on(() => Promise.reject(new Error('socket hang up')));
    const networkTransport = createTelnyxTransport({ apiKey: 'KEYtest', fetchImpl: networkFake.fetch });
    const networkReceipt = await networkTransport.sendSms(smsRequest({ provider: 'telnyx' }));
    expect(networkReceipt.status).toBe('failed');
    expect(networkReceipt.detail).toContain('network/timeout');
  });

  it('never fabricates a message id: 2xx without data.id is transient', async () => {
    const fake = new FakeFetch();
    fake.on(() => Promise.resolve(jsonResponse(201, { data: {} })));
    const transport = createTelnyxTransport({ apiKey: 'KEYtest', fetchImpl: fake.fetch });
    const receipt = await transport.sendSms(smsRequest({ provider: 'telnyx' }));
    expect(receipt.status).toBe('failed');
    expect(receipt.detail).toContain('without a message id');
  });
});

// ---------------------------------------------------------------------------
// Telnyx — voice (Call Control: create → poll → speak → poll)
// ---------------------------------------------------------------------------

describe('telnyx transport — placeVoiceCall', () => {
  it('fails honestly without a call control application (SMS-only wiring)', async () => {
    const fake = new FakeFetch();
    const transport = createTelnyxTransport({ apiKey: 'KEYtest', fetchImpl: fake.fetch });
    const receipt = await transport.placeVoiceCall(voiceRequest({ provider: 'telnyx' }));
    expect(receipt.status).toBe('failed');
    expect(receipt.detail).toContain('CELLULAR_TELNYX_CALL_CONTROL_APP_ID');
    expect(fake.calls).toHaveLength(0); // nothing was attempted
  });

  it('constructs the documented call-control flow: create, poll to answered, speak, poll to completed', async () => {
    const fake = new FakeFetch();
    const callStates = ['ringing', 'answered', 'answered', 'completed'];
    fake.on((url, init) => {
      if (url === 'https://api.telnyx.com/v2/calls' && init.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { data: { id: 'cc-1', call_state: 'parked' } }));
      }
      if (url.endsWith('/actions/speak')) {
        return Promise.resolve(jsonResponse(202, { result: 'ok' }));
      }
      return Promise.resolve(
        jsonResponse(200, { data: { id: 'cc-1', call_state: callStates.shift() ?? 'completed' } }),
      );
    });
    const transport = createTelnyxTransport({
      apiKey: 'KEYtest',
      callControlAppId: 'app-1',
      fetchImpl: fake.fetch,
      voiceWaitMs: 5_000,
      voicePollIntervalMs: 1,
    });

    const receipt = await transport.placeVoiceCall(voiceRequest({ provider: 'telnyx' }));

    expect(receipt).toEqual({ status: 'answered', providerCallId: 'cc-1', detail: null });
    const create = fake.calls[0]!;
    expect(create.url).toBe('https://api.telnyx.com/v2/calls');
    expect(create.headers['authorization']).toBe('Bearer KEYtest');
    expect(JSON.parse(create.body ?? '')).toEqual({
      from: '+15550100000',
      to: '+15551234567',
      connection_id: 'app-1',
    });
    const speak = fake.calls.find((call) => call.url.endsWith('/actions/speak'))!;
    expect(speak.method).toBe('POST');
    expect(JSON.parse(speak.body ?? '')).toEqual({ payload: 'The demo moved to 15:00' });
  });

  it('maps unanswered terminal states and a disappeared call resource', async () => {
    const noAnswerFake = new FakeFetch();
    noAnswerFake.on((url, init) => {
      if (url === 'https://api.telnyx.com/v2/calls' && init.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { data: { id: 'cc-1' } }));
      }
      return Promise.resolve(jsonResponse(200, { data: { id: 'cc-1', call_state: 'no-answer' } }));
    });
    const noAnswerTransport = createTelnyxTransport({
      apiKey: 'KEYtest',
      callControlAppId: 'app-1',
      fetchImpl: noAnswerFake.fetch,
      voiceWaitMs: 5_000,
      voicePollIntervalMs: 1,
    });
    const noAnswer = await noAnswerTransport.placeVoiceCall(voiceRequest({ provider: 'telnyx' }));
    expect(noAnswer.status).toBe('no_answer');
    expect(noAnswer.providerCallId).toBe('cc-1');

    const goneFake = new FakeFetch();
    goneFake.on((url, init) => {
      if (url === 'https://api.telnyx.com/v2/calls' && init.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { data: { id: 'cc-1' } }));
      }
      return Promise.resolve(jsonResponse(404, { errors: [{ title: 'Not found' }] }));
    });
    const goneTransport = createTelnyxTransport({
      apiKey: 'KEYtest',
      callControlAppId: 'app-1',
      fetchImpl: goneFake.fetch,
      voiceWaitMs: 5_000,
      voicePollIntervalMs: 1,
    });
    const gone = await goneTransport.placeVoiceCall(voiceRequest({ provider: 'telnyx' }));
    expect(gone.status).toBe('failed');
    expect(gone.detail).toContain('disappeared');
  });

  it('maps a rejected speak command to an honest failed receipt', async () => {
    const fake = new FakeFetch();
    fake.on((url, init) => {
      if (url === 'https://api.telnyx.com/v2/calls' && init.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { data: { id: 'cc-1' } }));
      }
      if (url.endsWith('/actions/speak')) {
        return Promise.resolve(jsonResponse(422, { errors: [{ title: 'Invalid payload' }] }));
      }
      return Promise.resolve(jsonResponse(200, { data: { id: 'cc-1', call_state: 'answered' } }));
    });
    const transport = createTelnyxTransport({
      apiKey: 'KEYtest',
      callControlAppId: 'app-1',
      fetchImpl: fake.fetch,
      voiceWaitMs: 5_000,
      voicePollIntervalMs: 1,
    });
    const receipt = await transport.placeVoiceCall(voiceRequest({ provider: 'telnyx' }));
    expect(receipt.status).toBe('failed');
    expect(receipt.detail).toContain('speak command rejected');
  });

  it('window expiry after an accepted speak → answered (honest observation)', async () => {
    const fake = new FakeFetch();
    fake.on((url, init) => {
      if (url === 'https://api.telnyx.com/v2/calls' && init.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { data: { id: 'cc-1' } }));
      }
      if (url.endsWith('/actions/speak')) {
        return Promise.resolve(jsonResponse(202, { result: 'ok' }));
      }
      return Promise.resolve(jsonResponse(200, { data: { id: 'cc-1', call_state: 'answered' } }));
    });
    const transport = createTelnyxTransport({
      apiKey: 'KEYtest',
      callControlAppId: 'app-1',
      fetchImpl: fake.fetch,
      voiceWaitMs: 20,
      voicePollIntervalMs: 1,
    });
    const receipt = await transport.placeVoiceCall(voiceRequest({ provider: 'telnyx' }));
    expect(receipt.status).toBe('answered');
    expect(receipt.detail).toContain('wait window');
  });
});

// ---------------------------------------------------------------------------
// Construction guards (the honest partial-configuration posture)
// ---------------------------------------------------------------------------

describe('transport construction guards', () => {
  it('rejects empty credentials and malformed base URLs loudly', () => {
    expect(() => createTwilioTransport({ accountSid: '', authToken: 'x' })).toThrow(/accountSid/);
    expect(() => createTwilioTransport({ accountSid: 'AC', authToken: ' ' })).toThrow(/authToken/);
    expect(() => createTwilioTransport({ accountSid: 'AC', authToken: 'x', baseUrl: 'not-a-url' })).toThrow(
      /baseUrl/,
    );
    expect(() => createTelnyxTransport({ apiKey: '' })).toThrow(/apiKey/);
    expect(() => createTelnyxTransport({ apiKey: 'k', callControlAppId: ' ' })).toThrow(
      /callControlAppId/,
    );
  });
});
