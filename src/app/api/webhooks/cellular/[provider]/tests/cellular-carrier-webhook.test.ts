// Integration tests of the CARRIER WEBHOOK EDGE (W108) — the carrier →
// Aurum HTTP seam: vendor request-signature verification (Twilio
// X-Twilio-Signature HMAC-SHA1; Telnyx Ed25519 over
// `${timestamp}|${rawBody}`), the account→tenant resolution, the feeding
// of receiveCellularEvent, redelivery idempotency (one application per
// provider event id), unknown-tenant events observed-not-errored, and
// the fail-closed posture when verification is unconfigured. The route
// handler (src/app/api/webhooks/cellular/[provider]/lib.ts) is tested
// directly with the house discipline (no Next.js boot); the test-side
// signature computations are INDEPENDENT implementations of the vendors'
// documented algorithms — they validate the adapter's implementation,
// not a shared helper.
//
// This is the DETERMINISTIC-COMPOSITION layer of the W108 evidence: the
// signature algorithms and webhook envelope shapes are exercised
// end-to-end against the module; LIVE carrier proof remains
// ENVIRONMENT-BLOCKED (no Twilio/Telnyx credentials exist in any
// audited environment — see the evidence record).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

import { createHmac, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import * as cellularContract from '@/modules/cellular/contract';
import { handleCellularWebhookPost } from '../lib';
import { resetCellularTransportWiring } from '@/infra/cellular';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../../../scripts/migrate';

const { listCellularEvents, listCellularReplies, registerCellularConnection } = cellularContract;

// Dedicated tenants per group.
const tenantWebhook = newId();
const tenantTelnyx = newId();

const TENANT_NUMBER = '+15550100000';
const WEBHOOK_URL = 'https://aurum.example.com/api/webhooks/cellular/twilio';
const TWILIO_AUTH_TOKEN = 'test-auth-token-0123456789abcdef';

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

// ---------------------------------------------------------------------------
// The test-side, INDEPENDENT implementations of the documented vendor
// signature algorithms (they must agree with the adapters' versions).
// ---------------------------------------------------------------------------

/** base64(HMAC-SHA1(authToken, url + Σ sorted(key+value))) — Twilio's documented digest. */
function independentTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((accumulated, key) => accumulated + key + params[key]!, url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

function telnyxKeyPair(): {
  publicKeyBase64Der: string;
  sign: (rawBody: string, timestamp: string) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyBase64Der: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (rawBody, timestamp) =>
      ed25519Sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64'),
  };
}

function carrierRequest(url: string, body: string, headers: Record<string, string>): Request {
  return new Request(url, { method: 'POST', body, headers });
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
  await registerCellularConnection(member(tenantWebhook), {
    provider: 'twilio',
    providerAccountId: 'AC_test',
    phoneNumber: TENANT_NUMBER,
    credentialRef: 'secret-store:cellular/1',
  });
  await registerCellularConnection(member(tenantTelnyx), {
    provider: 'telnyx',
    providerAccountId: 'profile_test',
    phoneNumber: TENANT_NUMBER,
    credentialRef: 'secret-store:cellular/2',
  });
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  setEnv('CELLULAR_TWILIO_AUTH_TOKEN', TWILIO_AUTH_TOKEN);
});

afterEach(() => {
  setEnv('CELLULAR_TWILIO_AUTH_TOKEN', undefined);
  setEnv('CELLULAR_TELNYX_PUBLIC_KEY', undefined);
  setEnv('CELLULAR_WEBHOOK_PUBLIC_URL', undefined);
  resetCellularTransportWiring();
});

// ---------------------------------------------------------------------------
// Twilio — the signed carrier edge
// ---------------------------------------------------------------------------

describe('the twilio carrier webhook edge', () => {
  it('accepts a validly signed inbound SMS and feeds receiveCellularEvent (reply + transcript land)', async () => {
    const fields = {
      From: '+15559990001',
      To: TENANT_NUMBER,
      Body: 'Tell Sarah the demo moved to 15:00',
      MessageSid: `SM_${newId()}`,
      AccountSid: 'AC_test',
    };
    const body = formBody(fields);
    const signature = independentTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, fields);
    const request = carrierRequest(WEBHOOK_URL, body, {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    });

    const result = await handleCellularWebhookPost('twilio', request);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: 'applied',
      applied: true,
      kind: 'sms_reply',
    });
    const replyId = result.body.replyId as string;
    expect(replyId).toBeTruthy();

    // The manager-originated ask returned into the canonical conversation.
    const replies = await listCellularReplies(member(tenantWebhook), { reachRequestId: null });
    const reply = replies.find((row) => row.id === replyId)!;
    expect(reply.inboundKind).toBe('inbound_request');
    expect(reply.text).toBe('Tell Sarah the demo moved to 15:00');
    expect(reply.conversationId).not.toBeNull();
  });

  it('also accepts a validly signed JSON body (the same documented concatenation)', async () => {
    const payload = {
      From: '+15559990002',
      To: TENANT_NUMBER,
      Body: 'JSON-shaped carrier post',
      MessageSid: `SM_${newId()}`,
      AccountSid: 'AC_test',
    };
    const body = JSON.stringify(payload);
    const signature = independentTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, payload);
    const request = carrierRequest(WEBHOOK_URL, body, {
      'content-type': 'application/json',
      'x-twilio-signature': signature,
    });

    const result = await handleCellularWebhookPost('twilio', request);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, status: 'applied', applied: true });
  });

  it('is idempotent per provider event id: a redelivered signed request applies exactly once', async () => {
    const fields = {
      From: '+15559990003',
      To: TENANT_NUMBER,
      Body: 'Redelivered ask',
      MessageSid: `SM_${newId()}`,
      AccountSid: 'AC_test',
    };
    const body = formBody(fields);
    const signature = independentTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, fields);
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    };

    const first = await handleCellularWebhookPost('twilio', carrierRequest(WEBHOOK_URL, body, headers));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ applied: true });

    const redelivery = await handleCellularWebhookPost('twilio', carrierRequest(WEBHOOK_URL, body, headers));
    expect(redelivery.status).toBe(200);
    expect(redelivery.body).toMatchObject({ ok: true, applied: false });

    // Exactly ONE reply row and ONE ledger row for the event id.
    const replies = await listCellularReplies(member(tenantWebhook), {
      reachRequestId: null,
      limit: 500,
    });
    expect(replies.filter((row) => row.providerEventId === fields.MessageSid)).toHaveLength(1);
    const events = await listCellularEvents(member(tenantWebhook), { limit: 500 });
    expect(events.filter((row) => row.providerEventId === fields.MessageSid)).toHaveLength(1);
  });

  it('rejects an invalid signature (403, never processed) and a missing one equally', async () => {
    const fields = {
      From: '+15559990004',
      To: TENANT_NUMBER,
      Body: 'Forged',
      MessageSid: `SM_${newId()}`,
      AccountSid: 'AC_test',
    };
    const body = formBody(fields);
    const before = await listCellularEvents(member(tenantWebhook), { limit: 500 });

    const forged = await handleCellularWebhookPost(
      'twilio',
      carrierRequest(WEBHOOK_URL, body, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': independentTwilioSignature('WRONG-token', WEBHOOK_URL, fields),
      }),
    );
    expect(forged.status).toBe(403);
    expect(forged.body).toMatchObject({ ok: false });

    const missing = await handleCellularWebhookPost(
      'twilio',
      carrierRequest(WEBHOOK_URL, body, {
        'content-type': 'application/x-www-form-urlencoded',
      }),
    );
    expect(missing.status).toBe(403);

    const after = await listCellularEvents(member(tenantWebhook), { limit: 500 });
    expect(after.length).toBe(before.length); // nothing was processed
  });

  it('fails CLOSED (503) when verification is not configured', async () => {
    setEnv('CELLULAR_TWILIO_AUTH_TOKEN', undefined);
    const fields = {
      From: '+15559990005',
      To: TENANT_NUMBER,
      Body: 'x',
      MessageSid: `SM_${newId()}`,
      AccountSid: 'AC_test',
    };
    const result = await handleCellularWebhookPost(
      'twilio',
      carrierRequest(WEBHOOK_URL, formBody(fields), {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'anything',
      }),
    );
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false });
    expect(String(result.body.error)).toContain('CELLULAR_TWILIO_AUTH_TOKEN');
  });

  it('acknowledges recognized non-record pings (queued delivery status → 200, nothing recorded)', async () => {
    const fields = {
      MessageSid: `SM_${newId()}`,
      MessageStatus: 'queued',
      AccountSid: 'AC_test',
    };
    const body = formBody(fields);
    const signature = independentTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, fields);
    const before = await listCellularEvents(member(tenantWebhook), { limit: 500 });
    const result = await handleCellularWebhookPost(
      'twilio',
      carrierRequest(WEBHOOK_URL, body, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, status: 'unsupported' });
    const after = await listCellularEvents(member(tenantWebhook), { limit: 500 });
    expect(after.length).toBe(before.length);
  });

  it('observes unknown-tenant envelopes without erroring (202; nothing recorded for anyone)', async () => {
    const fields = {
      From: '+15559990006',
      To: TENANT_NUMBER,
      Body: 'Stranger traffic',
      MessageSid: `SM_${newId()}`,
      AccountSid: 'AC_unknown_account',
    };
    const body = formBody(fields);
    const signature = independentTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, fields);
    const before = await listCellularEvents(member(tenantWebhook), { limit: 500 });
    const result = await handleCellularWebhookPost(
      'twilio',
      carrierRequest(WEBHOOK_URL, body, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      }),
    );
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({
      ok: true,
      status: 'unknown_tenant',
      providerAccountId: 'AC_unknown_account',
    });
    const after = await listCellularEvents(member(tenantWebhook), { limit: 500 });
    expect(after.length).toBe(before.length);
  });

  it('rejects malformed envelopes (400) and unknown providers (404)', async () => {
    const malformed = formBody({ From: '+15559990007' }); // no AccountSid/To/Body
    const signature = independentTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, { From: '+15559990007' });
    const bad = await handleCellularWebhookPost(
      'twilio',
      carrierRequest(WEBHOOK_URL, malformed, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false });

    const unknown = await handleCellularWebhookPost(
      'vonage',
      carrierRequest(WEBHOOK_URL, '{}', { 'content-type': 'application/json' }),
    );
    expect(unknown.status).toBe(404);
  });

  it('verifies against CELLULAR_WEBHOOK_PUBLIC_URL when the proxy rewrites the Host', async () => {
    setEnv('CELLULAR_WEBHOOK_PUBLIC_URL', 'https://public.example.com/api/webhooks/cellular/twilio');
    const fields = {
      From: '+15559990008',
      To: TENANT_NUMBER,
      Body: 'Behind a proxy',
      MessageSid: `SM_${newId()}`,
      AccountSid: 'AC_test',
    };
    // The carrier signed against the PUBLIC url; the request arrives on the
    // internal one (request.url below) and the route must re-derive the
    // public one for verification.
    const signature = independentTwilioSignature(
      TWILIO_AUTH_TOKEN,
      'https://public.example.com/api/webhooks/cellular/twilio',
      fields,
    );
    const result = await handleCellularWebhookPost(
      'twilio',
      carrierRequest('https://internal-host/api/webhooks/cellular/twilio', formBody(fields), {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, status: 'applied', applied: true });
  });

  it('guards the carrier body size (413)', async () => {
    const bigBody = formBody({
      From: '+15559990009',
      To: TENANT_NUMBER,
      Body: 'x'.repeat(1_100_000),
      MessageSid: 'SM_big',
      AccountSid: 'AC_test',
    });
    const signature = independentTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, {
      From: '+15559990009',
      To: TENANT_NUMBER,
      Body: 'x'.repeat(1_100_000),
      MessageSid: 'SM_big',
      AccountSid: 'AC_test',
    });
    const result = await handleCellularWebhookPost(
      'twilio',
      carrierRequest(WEBHOOK_URL, bigBody, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      }),
    );
    expect(result.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Telnyx — the Ed25519-signed carrier edge
// ---------------------------------------------------------------------------

describe('the telnyx carrier webhook edge', () => {
  const TELNYX_URL = 'https://aurum.example.com/api/webhooks/cellular/telnyx';

  function telnyxInboundPayload(from: string, text: string): string {
    return JSON.stringify({
      data: {
        event_type: 'message.received',
        id: `evt_${newId()}`,
        occurred_at: '2026-09-27T10:00:00Z',
        account_id: 'profile_test',
        payload: {
          id: `msg_${newId()}`,
          from: { phone_number: from },
          to: { phone_number: TENANT_NUMBER },
          text,
        },
      },
    });
  }

  it('accepts a validly signed message.received and feeds receiveCellularEvent', async () => {
    const keys = telnyxKeyPair();
    setEnv('CELLULAR_TELNYX_PUBLIC_KEY', keys.publicKeyBase64Der);
    const rawBody = telnyxInboundPayload('+15559991001', 'Telnyx-signed ask');
    const timestamp = '1769472000';
    const signature = keys.sign(rawBody, timestamp);

    const result = await handleCellularWebhookPost(
      'telnyx',
      carrierRequest(TELNYX_URL, rawBody, {
        'content-type': 'application/json',
        'telnyx-signature': signature,
        'telnyx-timestamp': timestamp,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, status: 'applied', applied: true, kind: 'sms_reply' });

    const replies = await listCellularReplies(member(tenantTelnyx), { reachRequestId: null });
    const reply = replies.find((row) => row.text === 'Telnyx-signed ask')!;
    expect(reply.inboundKind).toBe('inbound_request');
    expect(reply.provider).toBe('telnyx');
    expect(reply.conversationId).not.toBeNull();
  });

  it('rejects a wrong signature, a tampered body, and missing headers (403 each)', async () => {
    const keys = telnyxKeyPair();
    setEnv('CELLULAR_TELNYX_PUBLIC_KEY', keys.publicKeyBase64Der);
    const rawBody = telnyxInboundPayload('+15559991002', 'Tamper target');
    const timestamp = '1769472000';
    const signature = keys.sign(rawBody, timestamp);

    // Wrong signature (signed a different body).
    const wrongSignature = await handleCellularWebhookPost(
      'telnyx',
      carrierRequest(TELNYX_URL, rawBody, {
        'content-type': 'application/json',
        'telnyx-signature': keys.sign('{"tampered":true}', timestamp),
        'telnyx-timestamp': timestamp,
      }),
    );
    expect(wrongSignature.status).toBe(403);

    // Tampered body (signature no longer matches).
    const tampered = await handleCellularWebhookPost(
      'telnyx',
      carrierRequest(TELNYX_URL, rawBody.replace('Tamper target', 'Tampered!'), {
        'content-type': 'application/json',
        'telnyx-signature': signature,
        'telnyx-timestamp': timestamp,
      }),
    );
    expect(tampered.status).toBe(403);

    // Missing headers.
    const missing = await handleCellularWebhookPost(
      'telnyx',
      carrierRequest(TELNYX_URL, rawBody, { 'content-type': 'application/json' }),
    );
    expect(missing.status).toBe(403);
  });

  it('fails CLOSED (503) when no public key is configured', async () => {
    setEnv('CELLULAR_TELNYX_PUBLIC_KEY', undefined);
    const result = await handleCellularWebhookPost(
      'telnyx',
      carrierRequest(TELNYX_URL, telnyxInboundPayload('+15559991003', 'x'), {
        'content-type': 'application/json',
        'telnyx-signature': 'aaaa',
        'telnyx-timestamp': '1769472000',
      }),
    );
    expect(result.status).toBe(503);
    expect(String(result.body.error)).toContain('CELLULAR_TELNYX_PUBLIC_KEY');
  });

  it('never authenticates with a malformed configured key (fail closed)', async () => {
    setEnv('CELLULAR_TELNYX_PUBLIC_KEY', 'not-base64-der!!!');
    const keys = telnyxKeyPair();
    const rawBody = telnyxInboundPayload('+15559991004', 'x');
    const timestamp = '1769472000';
    const result = await handleCellularWebhookPost(
      'telnyx',
      carrierRequest(TELNYX_URL, rawBody, {
        'content-type': 'application/json',
        'telnyx-signature': keys.sign(rawBody, timestamp),
        'telnyx-timestamp': timestamp,
      }),
    );
    expect(result.status).toBe(403);
  });
});
