// Unit tests for the redis-over-HTTP (Upstash REST) seam (W077): the
// transport itself, the REST backends behind the queue/cache/lock ports,
// and the deployment profile labeling. The provider is represented by a
// stubbed global `fetch` — no network, no real token (the same discipline
// email.test.ts applies to Resend).
//
// A REAL-provider round-trip is available opt-in (skipped unless both
// AURUM_TEST_REDIS_REST_URL and AURUM_TEST_REDIS_REST_TOKEN are set),
// mirroring worker-realredis.test.ts: against a live Upstash REST database
// it proves the cache/queue/lock ports work over the real HTTPS wire.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeCache, getCache } from './cache';
import { closeLock, getLock } from './lock';
import { closeQueue, getQueue } from './queue';
import { closeRedisRest, getRedisRestClient } from './redis-rest';
import { getRedisRestConfig } from './config';
import { resolveDeploymentProfile } from './deployment';

const TRACKED_VARS = [
  'REDIS_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const REST_URL = 'https://redis-rest.example.test';
const REST_TOKEN = 'test-redis-rest-token';

/** A fetch stub returning `value` as the JSON command result. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The parsed JSON command argv of the `index`-th fetch call (asserts it exists). */
function sentCommand(index: number): unknown {
  const call = fetchMock.mock.calls[index] as [string, RequestInit] | undefined;
  if (call === undefined) {
    throw new Error(`expected fetch call #${index + 1}, but only ${fetchMock.mock.calls.length} happened`);
  }
  return JSON.parse(String(call[1].body));
}

beforeEach(() => {
  for (const name of TRACKED_VARS) saved.set(name, process.env[name]);
  setEnv({
    REDIS_URL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined,
    KV_REST_API_TOKEN: undefined,
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  closeRedisRest();
  closeCache();
  closeQueue();
  closeLock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeRedisRest();
  closeCache();
  closeQueue();
  closeLock();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('redis rest configuration (getRedisRestConfig)', () => {
  it('is undefined when no seam is configured', () => {
    expect(getRedisRestConfig()).toBeUndefined();
  });

  it('accepts the UPSTASH_REDIS_REST_* spelling', () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    expect(getRedisRestConfig()).toEqual({ url: REST_URL, token: REST_TOKEN });
  });

  it('accepts the KV_REST_API_* spelling (the Vercel integration names)', () => {
    setEnv({ KV_REST_API_URL: REST_URL, KV_REST_API_TOKEN: REST_TOKEN });
    expect(getRedisRestConfig()).toEqual({ url: REST_URL, token: REST_TOKEN });
  });

  it('tolerates a mixed spelling pair (url from one, token from the other)', () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, KV_REST_API_TOKEN: REST_TOKEN });
    expect(getRedisRestConfig()).toEqual({ url: REST_URL, token: REST_TOKEN });
  });

  it('a URL without a token is a loud misconfiguration (never silent memory)', () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL });
    expect(() => getRedisRestConfig()).toThrow(/BOTH a URL and a token/);
  });

  it('a token without a URL is a loud misconfiguration', () => {
    setEnv({ KV_REST_API_TOKEN: REST_TOKEN });
    expect(() => getRedisRestConfig()).toThrow(/BOTH a URL and a token/);
  });
});

describe('redis rest transport (getRedisRestClient)', () => {
  it('is null when the seam is not configured', () => {
    expect(getRedisRestClient()).toBeNull();
  });

  it('POSTs the command argv as JSON with the bearer token', async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    fetchMock.mockResolvedValueOnce(jsonResponse('OK'));
    const client = getRedisRestClient();
    expect(client).not.toBeNull();
    await client!.command(['SET', 'k', 'v']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REST_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${REST_TOKEN}`);
    expect(init.body).toBe(JSON.stringify(['SET', 'k', 'v']));
  });

  it('resolves the JSON command result verbatim', async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    const client = getRedisRestClient()!;
    await expect(client.command(['GET', 'missing'])).resolves.toBeNull();
  });

  it('rejects an HTTP error with status and truncated detail', async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'command not allowed' }, 401));
    const client = getRedisRestClient()!;
    await expect(client.command(['GET', 'k'])).rejects.toThrow(/HTTP 401.*command not allowed/);
  });

  it('wraps network failures', async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = getRedisRestClient()!;
    await expect(client.command(['PING'])).rejects.toThrow(/redis rest request failed: ECONNRESET/);
  });

  it('tolerates a trailing slash in the endpoint and is a per-process singleton', () => {
    setEnv({ UPSTASH_REDIS_REST_URL: `${REST_URL}/`, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    fetchMock.mockResolvedValue(jsonResponse('PONG'));
    const first = getRedisRestClient();
    const second = getRedisRestClient();
    expect(second).toBe(first);
    return first!.command(['PING']).then(() => {
      const [url] = fetchMock.mock.calls[0] as [string, unknown];
      expect(url).toBe(REST_URL);
    });
  });
});

describe('cache port on the redis rest backend', () => {
  it('maps set/get/del onto SET/GET/DEL under the aurum:cache: prefix', async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    fetchMock.mockResolvedValue(jsonResponse('OK'));
    const cache = getCache();
    await cache.set('k', 'v');
    await cache.set('k2', 'v2', 90);
    expect(sentCommand(0)).toEqual(['SET', 'aurum:cache:k', 'v']);
    expect(sentCommand(1)).toEqual(['SET', 'aurum:cache:k2', 'v2', 'PX', 90_000]);

    fetchMock.mockResolvedValueOnce(jsonResponse('v'));
    await expect(cache.get('k')).resolves.toBe('v');
    expect(sentCommand(2)).toEqual(['GET', 'aurum:cache:k']);

    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    await expect(cache.get('missing')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(1));
    await cache.del('k');
    expect(sentCommand(4)).toEqual(['DEL', 'aurum:cache:k']);
  });
});

describe('queue port on the redis rest backend', () => {
  it('maps enqueue/dequeue/depth onto RPUSH/LPOP/LLEN under the aurum:queue: prefix', async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    fetchMock.mockResolvedValue(jsonResponse(1));
    const queue = getQueue();
    await queue.enqueue('w077', { hello: 'world' });
    expect(sentCommand(0)).toEqual(['RPUSH', 'aurum:queue:w077', JSON.stringify({ hello: 'world' })]);

    fetchMock.mockResolvedValueOnce(jsonResponse(1));
    await expect(queue.depth('w077')).resolves.toBe(1);
    expect(sentCommand(1)).toEqual(['LLEN', 'aurum:queue:w077']);

    fetchMock.mockResolvedValueOnce(jsonResponse(JSON.stringify({ hello: 'world' })));
    await expect(queue.dequeue('w077')).resolves.toEqual({ hello: 'world' });

    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    await expect(queue.dequeue('w077')).resolves.toBeNull();
  });
});

describe('lock port on the redis rest backend', () => {
  it('maps acquire onto SET NX PX and release onto compare-and-delete EVAL', async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: REST_URL, UPSTASH_REDIS_REST_TOKEN: REST_TOKEN });
    const lock = getLock();

    fetchMock.mockResolvedValueOnce(jsonResponse('OK'));
    const token = await lock.acquire('w077', 5_000);
    expect(token).toBeTypeOf('string');
    const acquireArgs = sentCommand(0) as unknown[];
    expect(acquireArgs[0]).toBe('SET');
    expect(acquireArgs[1]).toBe('aurum:lock:w077');
    expect(acquireArgs[2]).toBe(token);
    expect(acquireArgs[3]).toBe('PX');
    expect(acquireArgs[4]).toBe(5_000);
    expect(acquireArgs[5]).toBe('NX');

    // Held: SET NX does not apply — no token.
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    await expect(lock.acquire('w077', 5_000)).resolves.toBeNull();

    // Release with the owning token: EVAL deletes → 1.
    fetchMock.mockResolvedValueOnce(jsonResponse(1));
    await expect(lock.release('w077', token!)).resolves.toBe(true);
    const releaseArgs = sentCommand(2) as string[];
    expect(releaseArgs[0]).toBe('EVAL');
    expect(releaseArgs[2]).toBe('1');
    expect(releaseArgs[3]).toBe('aurum:lock:w077');
    expect(releaseArgs[4]).toBe(token);

    // Release with a foreign token: EVAL refuses → 0.
    fetchMock.mockResolvedValueOnce(jsonResponse(0));
    await expect(lock.release('w077', 'not-the-token')).resolves.toBe(false);
  });
});

describe('backend selection and deployment labeling', () => {
  it('REDIS_URL (redis protocol) still wins over the REST seam', () => {
    setEnv({
      REDIS_URL: 'redis://localhost:6379',
      UPSTASH_REDIS_REST_URL: REST_URL,
      UPSTASH_REDIS_REST_TOKEN: REST_TOKEN,
    });
    // Labeling is 'redis' either way; the seam config itself stays readable.
    expect(getRedisRestConfig()).toEqual({ url: REST_URL, token: REST_TOKEN });
    const profile = resolveDeploymentProfile();
    expect(profile.backends.queue).toBe('redis');
    expect(profile.backends.cache).toBe('redis');
    expect(profile.backends.lock).toBe('redis');
  });

  it('the REST seam alone labels queue/cache/lock as redis', () => {
    setEnv({ KV_REST_API_URL: REST_URL, KV_REST_API_TOKEN: REST_TOKEN });
    const profile = resolveDeploymentProfile();
    expect(profile.backends.queue).toBe('redis');
    expect(profile.backends.cache).toBe('redis');
    expect(profile.backends.lock).toBe('redis');
  });

  it('no seam at all keeps the memory backends (and never calls the provider)', async () => {
    const cache = getCache();
    await cache.set('k', 'v');
    await expect(cache.get('k')).resolves.toBe('v');
    expect(fetchMock).not.toHaveBeenCalled();
    const profile = resolveDeploymentProfile();
    expect(profile.backends.queue).toBe('memory');
    expect(profile.backends.cache).toBe('memory');
    expect(profile.backends.lock).toBe('memory');
  });
});

// ---------------------------------------------------------------------------
// Opt-in: the same round-trip against a REAL Upstash REST database.
// Activates only when BOTH AURUM_TEST_REDIS_REST_URL and
// AURUM_TEST_REDIS_REST_TOKEN are provided; skipped otherwise (local gate
// runs never require a provider).
// ---------------------------------------------------------------------------
const realRestUrl = process.env.AURUM_TEST_REDIS_REST_URL;
const realRestToken = process.env.AURUM_TEST_REDIS_REST_TOKEN;

describe.skipIf(realRestUrl === undefined || realRestToken === undefined)(
  'cache/queue/lock ports against a REAL redis REST endpoint',
  () => {
    beforeEach(() => {
      vi.unstubAllGlobals(); // the real fetch — this suite is the live wire
      setEnv({ UPSTASH_REDIS_REST_URL: realRestUrl, UPSTASH_REDIS_REST_TOKEN: realRestToken });
    });

    it('round-trips cache, queue and lock semantics over HTTPS', async () => {
      const cache = getCache();
      await cache.set('w077-rest-test:cache', 'hello', 60);
      await expect(cache.get('w077-rest-test:cache')).resolves.toBe('hello');
      await cache.del('w077-rest-test:cache');
      await expect(cache.get('w077-rest-test:cache')).resolves.toBeNull();

      const queue = getQueue();
      await queue.enqueue('w077-rest-test', { live: true });
      await expect(queue.depth('w077-rest-test')).resolves.toBe(1);
      await expect(queue.dequeue('w077-rest-test')).resolves.toEqual({ live: true });
      await expect(queue.depth('w077-rest-test')).resolves.toBe(0);

      const lock = getLock();
      const token = await lock.acquire('w077-rest-test:lock', 10_000);
      expect(token).toBeTypeOf('string');
      await expect(lock.acquire('w077-rest-test:lock', 10_000)).resolves.toBeNull();
      await expect(lock.release('w077-rest-test:lock', token!)).resolves.toBe(true);
      await expect(lock.release('w077-rest-test:lock', 'foreign')).resolves.toBe(false);
    });
  },
);
