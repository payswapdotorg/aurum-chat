// Integration tests of the LIVE TRANSPORT COMPOSITION (W108) — the
// SMS → VOICE fallback and the honest unwired posture proven through the
// COMPOSED path: real vendor transport implementations (the adapter
// factories, with an injected deterministic fetch double — no network)
// wired through the W108 per-provider registry exactly the way the
// production wiring module wires them (createCellularTransportFromConfig
// → setCellularTransportForProvider), delivering real reach requests
// against the embedded PostgreSQL.
//
// This proves the composition does not break the module's frozen
// routing/cost/fallback semantics:
//  * the attempt's pinned connection decides which provider's transport
//    serves the delivery (multi-provider wiring composes);
//  * the SMS→voice fallback honors the policy snapshot
//    ('on_sms_failure' places the call; 'forbidden' never does) and the
//    cost cap spans every leg through the live transports;
//  * a provider whose transport is not wired fails explicitly with
//    `provider_unavailable` (retryable, honest) while the OTHER
//    provider's deliveries keep flowing.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

import * as cellularContract from '../contract';
import { createTwilioTransport } from '../adapters/transport-twilio';
import { createTelnyxTransport } from '../adapters/transport-telnyx';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import type { CellularSmsRequest, CellularTransport, CellularVoiceRequest } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  createCellularTransportFromConfig,
  getCellularTransportForProvider,
  listCellularAttempts,
  reachAnyone,
  registerCellularConnection,
  setCellularPolicy,
  setCellularTransport,
  setCellularTransportForProvider,
} = cellularContract;

const tenantComposition = newId();
const tenantFallback = newId();
const tenantHonesty = newId();
const tenantSwapLive = newId();

const TENANT_NUMBER = '+15550100000';
const TELNYX_NUMBER = '+15550200000';

const BASE_TIME = Date.parse('2026-09-27T11:00:00Z');
let clockMs = BASE_TIME;

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

// ---------------------------------------------------------------------------
// The deterministic fetch double (records every vendor exchange)
// ---------------------------------------------------------------------------

interface RecordedExchange {
  url: string;
  method: string;
  body: string | null;
}

class ScriptableFetch {
  readonly exchanges: RecordedExchange[] = [];
  private handler: (url: string, init: RequestInit) => Promise<Response> = () => {
    throw new Error('no handler scripted');
  };

  on(handler: (url: string, init: RequestInit) => Promise<Response>): void {
    this.handler = handler;
  }

  readonly fetch = (url: string, init: RequestInit): Promise<Response> => {
    this.exchanges.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : null,
    });
    return this.handler(url, init);
  };

  count(urlEnd: string): number {
    return this.exchanges.filter((exchange) => exchange.url.endsWith(urlEnd)).length;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A scripted NEUTRAL transport (the single-seam override — the telnyx side). */
class ScriptedTransport implements CellularTransport {
  readonly provider = 'telnyx' as const;
  readonly smsRequests: CellularSmsRequest[] = [];
  readonly voiceRequests: CellularVoiceRequest[] = [];
  smsOutcome: 'accepted' | 'rejected' | 'failed' = 'accepted';
  voiceOutcome: 'answered' | 'no_answer' | 'failed' = 'answered';

  async sendSms(request: CellularSmsRequest) {
    this.smsRequests.push(request);
    return {
      status: this.smsOutcome,
      providerMessageId: this.smsOutcome === 'accepted' ? `msg_${newId()}` : null,
      detail: this.smsOutcome === 'accepted' ? null : `scripted ${this.smsOutcome}`,
    };
  }

  async placeVoiceCall(request: CellularVoiceRequest) {
    this.voiceRequests.push(request);
    return {
      status: this.voiceOutcome,
      providerCallId: `call_${newId()}`,
      detail: null,
    };
  }
}

async function registerTwilioConnection(ctx: TenantContext, account = 'AC_live'): Promise<void> {
  await registerCellularConnection(ctx, {
    provider: 'twilio',
    providerAccountId: account,
    phoneNumber: TENANT_NUMBER,
    credentialRef: 'secret-store:cellular/live-1',
  });
}

async function registerTelnyxConnection(ctx: TenantContext): Promise<void> {
  await registerCellularConnection(ctx, {
    provider: 'telnyx',
    providerAccountId: 'profile_live',
    phoneNumber: TELNYX_NUMBER,
    credentialRef: 'secret-store:cellular/live-2',
  });
}

/** The live twilio transport (real adapter code) over the deterministic double. */
function liveTwilioTransport(double: ScriptableFetch): CellularTransport {
  return createTwilioTransport({
    accountSid: 'AC_live',
    authToken: 'live-token-placeholder',
    fetchImpl: double.fetch,
    voiceWaitMs: 5_000,
    voicePollIntervalMs: 1,
  });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setCellularTransport(null);
  setCellularTransportForProvider('twilio', null);
  setCellularTransportForProvider('telnyx', null);
  await closeDb();
});

beforeEach(() => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  clockMs += 1_000;
});

afterEach(() => {
  vi.restoreAllMocks();
  setCellularTransport(null);
  setCellularTransportForProvider('twilio', null);
  setCellularTransportForProvider('telnyx', null);
});

// ---------------------------------------------------------------------------
// Multi-provider composition + honest unwired postures
// ---------------------------------------------------------------------------

describe('the composed multi-provider wiring', () => {
  it('constructs the live transports through the contract factory and wires them per provider (the production path)', () => {
    const twilio = createCellularTransportFromConfig({
      provider: 'twilio',
      accountSid: 'AC_live',
      credential: 'live-token-placeholder',
    });
    const telnyx = createCellularTransportFromConfig({
      provider: 'telnyx',
      credential: 'live-key-placeholder',
      callControlAppId: 'app-live',
    });
    setCellularTransportForProvider('twilio', twilio);
    setCellularTransportForProvider('telnyx', telnyx);
    expect(getCellularTransportForProvider('twilio')?.provider).toBe('twilio');
    expect(getCellularTransportForProvider('telnyx')?.provider).toBe('telnyx');

    // The factory rejects partial configuration loudly (honest, never
    // half-constructed).
    expect(() =>
      createCellularTransportFromConfig({ provider: 'twilio', accountSid: 'AC_live' }),
    ).toThrow(/CELLULAR_TWILIO_AUTH_TOKEN/);
    expect(() => createCellularTransportFromConfig({ provider: 'telnyx' })).toThrow(
      /CELLULAR_TELNYX_API_KEY/,
    );

    setCellularTransportForProvider('twilio', null);
    setCellularTransportForProvider('telnyx', null);
  });

  it('serves each attempt through its own connection\u2019s provider (per-provider twilio + single-seam telnyx)', async () => {
    const ctx = member(tenantComposition);
    await registerTwilioConnection(ctx);
    await registerTelnyxConnection(ctx);
    // The TWO active connections make auto-selection ambiguous — pass
    // explicit connection ids (the module's precision rule).
    const connections = await cellularContract.listCellularConnections(ctx, {});
    const twilioConnection = connections.find((c) => c.provider === 'twilio')!;
    const telnyxConnection = connections.find((c) => c.provider === 'telnyx')!;

    const double = new ScriptableFetch();
    double.on((url) => {
      if (url.includes('/Messages.json')) {
        return Promise.resolve(jsonResponse(201, { sid: `SM_${newId()}` }));
      }
      return Promise.resolve(jsonResponse(200, { status: 'completed', sid: 'CA1' }));
    });
    setCellularTransportForProvider('twilio', liveTwilioTransport(double));
    const scripted = new ScriptedTransport();
    setCellularTransport(scripted);

    const twilioReach = await reachAnyone(ctx, {
      phoneNumber: '+15559990001',
      kind: 'tell',
      text: 'Via the live twilio transport',
      connectionId: twilioConnection.id,
    });
    expect(twilioReach.status).toBe('sent');
    expect(double.count('/Messages.json')).toBe(1); // the REAL twilio REST call shape
    expect(scripted.smsRequests).toHaveLength(0);

    const telnyxReach = await reachAnyone(ctx, {
      phoneNumber: '+15559990002',
      kind: 'tell',
      text: 'Via the scripted single-seam transport',
      connectionId: telnyxConnection.id,
    });
    expect(telnyxReach.status).toBe('sent');
    expect(scripted.smsRequests).toHaveLength(1); // the single seam served its provider
    expect(scripted.smsRequests[0]!.fromNumber).toBe(TELNYX_NUMBER);
    expect(double.count('/Messages.json')).toBe(1); // the live transport untouched
  });
});

// ---------------------------------------------------------------------------
// SMS → voice fallback through the composed live path
// ---------------------------------------------------------------------------

describe('SMS → voice fallback through the composed live transport path', () => {
  it('falls back to a voice call when the policy permits and the SMS leg terminally fails', async () => {
    const ctx = member(tenantFallback, ['cellular:administer']);
    await registerTwilioConnection(ctx);
    await setCellularPolicy(ctx, {
      reachKind: 'tell',
      voiceFallback: 'on_sms_failure',
      smsMaxAttempts: 1, // one SMS attempt, then the routing decision
    });

    // The live transport's vendor behavior: the SMS send fails
    // transiently (a 5xx), then the voice call is created and completes.
    const double = new ScriptableFetch();
    double.on((url, init) => {
      if (url.includes('/Messages.json')) {
        return Promise.resolve(jsonResponse(503, { message: 'carrier unavailable' }));
      }
      if (url.includes('/Calls.json') && init.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { sid: 'CA_live_1', status: 'queued' }));
      }
      // The call-status poll.
      return Promise.resolve(jsonResponse(200, { status: 'completed', sid: 'CA_live_1' }));
    });
    setCellularTransportForProvider('twilio', liveTwilioTransport(double));

    const reach = await reachAnyone(ctx, {
      phoneNumber: '+15559990003',
      kind: 'tell',
      text: 'Fallback proof through the live composition',
    });

    expect(reach.status).toBe('delivered');
    expect(reach.failureCode).toBeNull();
    // The vendor exchanges prove the legs: one SMS send (refused), one
    // call creation, at least one call-status poll.
    expect(double.count('/Messages.json')).toBe(1);
    expect(double.exchanges.filter((e) => e.url.includes('/Calls.json') && e.method === 'POST')).toHaveLength(1);

    const attempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
    expect(attempts).toHaveLength(2);
    const [sms, voice] = attempts;
    expect(sms!.leg).toBe('sms');
    expect(sms!.status).toBe('failed');
    expect(sms!.detail).toContain('http 503');
    expect(voice!.leg).toBe('voice');
    expect(voice!.status).toBe('answered');
    expect(voice!.providerCallId).toBe('CA_live_1');
    // The Twiml spoken on the call is the reach text.
    const callCreate = double.exchanges.find(
      (e) => e.url.includes('/Calls.json') && e.method === 'POST',
    )!;
    expect(new URLSearchParams(callCreate.body ?? '').get('Twiml')).toBe(
      '<Response><Say>Fallback proof through the live composition</Say></Response>',
    );
  });

  it('never places a voice call when the policy forbids the fallback', async () => {
    const ctx = member(tenantFallback, ['cellular:administer']);
    await registerTwilioConnection(ctx);
    await setCellularPolicy(ctx, {
      reachKind: 'tell',
      voiceFallback: 'forbidden', // the built-in default: a call is intrusive
      smsMaxAttempts: 1,
    });

    const double = new ScriptableFetch();
    double.on(() => Promise.resolve(jsonResponse(503, { message: 'carrier unavailable' })));
    setCellularTransportForProvider('twilio', liveTwilioTransport(double));

    const reach = await reachAnyone(ctx, {
      phoneNumber: '+15559990004',
      kind: 'tell',
      text: 'No voice for me',
    });
    expect(reach.status).toBe('failed');
    expect(reach.failureCode).toBe('sms_attempts_exhausted');
    expect(double.count('/Calls.json')).toBe(0); // no call was ever placed
  });

  it('honors the lifetime cost cap through the composed path (no leg beyond the cap)', async () => {
    const ctx = member(tenantFallback, ['cellular:administer']);
    await registerTwilioConnection(ctx);
    await setCellularPolicy(ctx, {
      reachKind: 'tell',
      voiceFallback: 'on_sms_failure',
      smsMaxAttempts: 3,
      // A cap smaller than ONE SMS attempt (the default rate is 5 minor
      // units per segment): the first leg is already beyond the cap.
      maxCostPerReachMinor: 1,
    });

    const double = new ScriptableFetch();
    double.on(() => Promise.resolve(jsonResponse(201, { sid: `SM_${newId()}` })));
    setCellularTransportForProvider('twilio', liveTwilioTransport(double));

    const reach = await reachAnyone(ctx, {
      phoneNumber: '+15559990005',
      kind: 'tell',
      text: 'Capped before any leg',
    });
    expect(reach.status).toBe('failed');
    expect(reach.failureCode).toBe('cost_cap_exceeded');
    expect(double.exchanges).toHaveLength(0); // the cap refused BEFORE the vendor call
  });
});

// ---------------------------------------------------------------------------
// The honest unwired posture through the composed path
// ---------------------------------------------------------------------------

describe('the honest provider_unavailable posture', () => {
  it('a provider without a wired transport fails explicitly and retryably while the other provider flows', async () => {
    const ctx = member(tenantHonesty, ['cellular:administer']);
    await registerTwilioConnection(ctx);
    await registerTelnyxConnection(ctx);
    await setCellularPolicy(ctx, {
      reachKind: 'tell',
      voiceFallback: 'on_sms_failure',
      smsMaxAttempts: 1, // the honest SMS + voice attempt pair, then terminal
    });
    const connections = await cellularContract.listCellularConnections(ctx, {});
    const twilioConnection = connections.find((c) => c.provider === 'twilio')!;
    const telnyxConnection = connections.find((c) => c.provider === 'telnyx')!;

    // ONLY telnyx is wired (single seam): the twilio connection's
    // deliveries fail honestly with provider_unavailable.
    const scripted = new ScriptedTransport();
    setCellularTransport(scripted);

    const twilioReach = await reachAnyone(ctx, {
      phoneNumber: '+15559990006',
      kind: 'tell',
      text: 'Nobody wired my provider',
      connectionId: twilioConnection.id,
    });
    expect(twilioReach.status).toBe('failed');
    expect(twilioReach.failureCode).toBe('provider_unavailable');
    const attempts = await listCellularAttempts(ctx, { reachRequestId: twilioReach.id });
    expect(attempts).toHaveLength(2); // the honest SMS + voice attempt pair
    for (const attempt of attempts) {
      expect(attempt.status).toBe('failed');
      expect(attempt.connectionId).toBeNull(); // no leg was placed
      expect(attempt.detail).toContain('no cellular transport is wired');
    }

    // …while the telnyx connection's delivery flows normally.
    const telnyxReach = await reachAnyone(ctx, {
      phoneNumber: '+15559990007',
      kind: 'tell',
      text: 'My provider is wired',
      connectionId: telnyxConnection.id,
    });
    expect(telnyxReach.status).toBe('sent');
    expect(scripted.smsRequests).toHaveLength(1);

    // The failed provider is RETRYABLE once its transport is wired.
    const double = new ScriptableFetch();
    double.on((url) =>
      url.includes('/Messages.json')
        ? Promise.resolve(jsonResponse(201, { sid: `SM_${newId()}` }))
        : Promise.resolve(jsonResponse(200, { status: 'completed' })),
    );
    setCellularTransportForProvider('twilio', liveTwilioTransport(double));
    const retried = await cellularContract.retryCellularReach(ctx, {
      reachRequestId: twilioReach.id,
    });
    expect(retried.status).toBe('sent');
    expect(retried.cycle).toBe(2);
    expect(double.count('/Messages.json')).toBe(1);
  });

  it('the live telnyx transport delivers the same canonical journey (provider-swap evidence through live code)', async () => {
    const ctx = member(tenantSwapLive);
    await registerTelnyxConnection(ctx);
    const double = new ScriptableFetch();
    double.on((url, init) => {
      if (url === 'https://api.telnyx.com/v2/messages' && init.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { data: { id: `msg_${newId()}`, status: 'queued' } }));
      }
      return Promise.resolve(jsonResponse(200, { data: { id: 'cc', call_state: 'completed' } }));
    });
    setCellularTransportForProvider(
      'telnyx',
      createTelnyxTransport({
        apiKey: 'live-key-placeholder',
        callControlAppId: 'app-live',
        fetchImpl: double.fetch,
        voiceWaitMs: 5_000,
        voicePollIntervalMs: 1,
      }),
    );

    const reach = await reachAnyone(ctx, {
      phoneNumber: '+15559990008',
      kind: 'tell',
      text: 'Telnyx live-composed journey',
    });
    expect(reach.status).toBe('sent');
    const attempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
    expect(attempts[0]!.provider).toBe('telnyx');
    expect(attempts[0]!.providerMessageId).toMatch(/^msg_/);
    expect(attempts[0]!.fromNumber).toBe(TELNYX_NUMBER);
    expect(double.count('/v2/messages')).toBe(1);
  });
});
