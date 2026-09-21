// Unit tests for the transactional email port (W069): memory backend,
// the Resend REST adapter boundary (request shape, auth, error mapping —
// provider stubbed at the fetch seam), and the daily budget guardrail.
//
// Provider credentials in tests are assembled from fragments at runtime
// (never a realistic full token literal in source — push protection).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeCache } from './cache';
import { closeEmail, getEmail, getMemoryEmailOutbox, sendTransactionalEmail } from './email';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  closeEmail();
  closeCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  closeEmail();
  closeCache();
});

const MESSAGE = {
  to: 'new-hire@example.test',
  subject: 'Your Aurum invitation',
  text: 'You have been invited to join the company workspace.',
  html: '<p>You have been invited.</p>',
};

describe('memory backend (default dev/test path)', () => {
  it('records receipts in the outbox and delivers nothing', async () => {
    const delivery = await getEmail().send(MESSAGE);
    expect(delivery.provider).toBe('memory');
    expect(delivery.to).toBe(MESSAGE.to);
    expect(delivery.subject).toBe(MESSAGE.subject);
    expect(delivery.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getMemoryEmailOutbox()).toEqual([delivery]);
  });

  it('closeEmail resets the singleton and the outbox', async () => {
    await getEmail().send(MESSAGE);
    closeEmail();
    expect(getMemoryEmailOutbox()).toEqual([]);
    await expect(getEmail().send(MESSAGE)).resolves.toBeTruthy();
  });
});

describe('Resend adapter boundary (fetch stub — no network)', () => {
  function assembleApiKey(): string {
    // Fragment assembly: never a realistic full token literal in source.
    return ['re_', 'test', '_placeholder'].join('');
  }

  it('sends the documented REST request shape and maps the provider receipt', async () => {
    const apiKey = assembleApiKey();
    process.env.RESEND_API_KEY = apiKey;
    process.env.EMAIL_FROM = 'Aurum Ops <ops@example.test>';
    closeEmail();

    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      return new Response(JSON.stringify({ id: 'resp-delivery-1' }), { status: 200 });
    }) as typeof fetch;

    const delivery = await getEmail().send(MESSAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, string>;
    expect(body).toEqual({
      from: 'Aurum Ops <ops@example.test>',
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
    expect(delivery).toMatchObject({ id: 'resp-delivery-1', provider: 'resend', to: MESSAGE.to });
    // The Resend backend keeps no local outbox — receipts live with the provider.
    expect(getMemoryEmailOutbox()).toEqual([]);
  });

  it('maps provider rejections to provider_error with the HTTP status', async () => {
    process.env.RESEND_API_KEY = assembleApiKey();
    closeEmail();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 })) as typeof fetch;

    await expect(getEmail().send(MESSAGE)).rejects.toMatchObject({
      name: 'EmailError',
      code: 'provider_error',
      message: expect.stringContaining('HTTP 401'),
    });
  });

  it('maps network failure to provider_error', async () => {
    process.env.RESEND_API_KEY = assembleApiKey();
    closeEmail();
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    await expect(getEmail().send(MESSAGE)).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('defaults the From address when EMAIL_FROM is unset', async () => {
    process.env.RESEND_API_KEY = assembleApiKey();
    closeEmail();
    let seenFrom = '';
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
      seenFrom = body.from!;
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }) as typeof fetch;
    await getEmail().send(MESSAGE);
    expect(seenFrom).toBe('Aurum <onboarding@resend.dev>');
  });
});

describe('daily budget guardrail', () => {
  it('rejects the send past the configured daily limit', async () => {
    for (let i = 0; i < 3; i += 1) {
      await sendTransactionalEmail({ ...MESSAGE, subject: `mail ${i}` }, 3);
    }
    await expect(sendTransactionalEmail(MESSAGE, 3)).rejects.toMatchObject({
      code: 'budget_exceeded',
      message: expect.stringContaining('3/3'),
    });
    // The outbox shows exactly the three delivered messages.
    expect(getMemoryEmailOutbox()).toHaveLength(3);
  });

  it('limit 0 disables the cap', async () => {
    for (let i = 0; i < 5; i += 1) {
      await sendTransactionalEmail({ ...MESSAGE, subject: `mail ${i}` }, 0);
    }
    expect(getMemoryEmailOutbox()).toHaveLength(5);
  });

  it('invalid messages are rejected before any budget counting', async () => {
    await expect(
      sendTransactionalEmail({ to: 'not-an-address', subject: '', text: '' }, 5),
    ).rejects.toMatchObject({ code: 'invalid_message' });
    expect(getMemoryEmailOutbox()).toEqual([]);
  });
});
