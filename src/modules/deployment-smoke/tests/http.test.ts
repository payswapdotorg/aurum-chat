// Unit tests for the W078 smoke HTTP client: manual redirects, explicit
// cookies, JSON parsing, Set-Cookie capture and unreachable targets —
// exercised against a REAL local node:http server (the client is the
// transport the deployed-target proofs ride on; it must behave over
// actual sockets, not mocks).

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmokeHttpClient, sessionCookieHeader, sessionTokenFromSetCookie } from '../http';

let base = '';
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/redirect') {
      response.writeHead(307, { location: '/signin?next=%2Fredirect' }).end();
      return;
    }
    if (url === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (url === '/cookie' && request.method === 'POST') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'aurum_session=tok123; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800',
      }).end('{"session":{"principal":{"id":"p1"}}}');
      return;
    }
    if (url === '/echo') {
      const cookie = request.headers.cookie ?? '(none)';
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ cookie }));
      return;
    }
    response.writeHead(404).end('nope');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SmokeHttpClient', () => {
  it('observes redirects manually (no silent following)', async () => {
    const client = new SmokeHttpClient({ baseUrl: base });
    const response = await client.get('/redirect');
    expect(response.status).toBe(307);
    expect(response.location).toBe(`${base}/signin?next=%2Fredirect`);
  });

  it('parses JSON bodies and preserves headers', async () => {
    const client = new SmokeHttpClient({ baseUrl: base });
    const response = await client.get('/json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('captures Set-Cookie verbatim and extracts the session token', async () => {
    const client = new SmokeHttpClient({ baseUrl: base });
    const response = await client.post('/cookie', {});
    expect(response.setCookies[0]).toContain('aurum_session=tok123');
    expect(response.setCookies[0]).toContain('HttpOnly');
    const token = sessionTokenFromSetCookie(response.setCookies);
    expect(token).toBe('tok123');
    // Explicit cookie passing — no jar, no leakage.
    const echo = await client.get('/echo', sessionCookieHeader(token));
    expect(echo.body).toEqual({ cookie: 'aurum_session=tok123' });
    const anonymous = await client.get('/echo');
    expect(anonymous.body).toEqual({ cookie: '(none)' });
  });

  it('normalizes transport failures into observations (never throws)', async () => {
    const client = new SmokeHttpClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    const response = await client.get('/json');
    expect(response.status).toBe(0);
    expect(response.error).not.toBeNull();
  });

  it('strips trailing slashes from the base url', async () => {
    const client = new SmokeHttpClient({ baseUrl: `${base}/` });
    const response = await client.get('/json');
    expect(response.status).toBe(200);
  });
});
