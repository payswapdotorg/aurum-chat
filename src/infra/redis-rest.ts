// Redis-over-HTTP transport (W077): the Upstash REST surface.
//
// The queue/cache/lock ports already speak the redis PROTOCOL through
// ioredis (REDIS_URL — the TCP wire). Free-tier serverless hosting often
// prefers — or, for per-database tokens, only exposes — the HTTPS REST
// surface, where one command is a POST whose JSON body is the command argv
// array and the response body is the command result (the Upstash REST
// contract). This module is that transport: ONE command executor shared by
// the three ports, provider-named ONLY here so a different HTTP-redis
// vendor is an adapter swap, not a port change (provider isolation).
//
// Discipline (mirrors email.ts):
//   * plain `fetch`, no SDK — nothing new to bundle;
//   * every request timeout-guarded (a free-tier provider must never wedge
//     a caller — 10s, the email adapter's budget);
//   * singleton on globalThis (the Next.js multi-registry discipline db.ts
//     documents), chosen ONCE from the environment at first use;
//   * carries NO domain semantics — the ports keep their contracts; only
//     the wire changes. Redis is never domain truth (lock 35).
//
// Selection precedence (per port): REDIS_URL (ioredis, full protocol)
// first, then this REST seam, then the in-process memory backend.

import { getRedisRestConfig } from './config';

/** A provider call must never wedge a caller (the email adapter's budget). */
const REQUEST_TIMEOUT_MS = 10_000;

/** The minimal surface the queue/cache/lock REST backends need. */
export interface RedisRestClient {
  /**
   * Run one redis command (the argv array, e.g. `['SET', key, value]`);
   * resolves to the raw command result (`'OK'`, a value, `null`, a number).
   */
  command(args: (string | number)[]): Promise<unknown>;
}

interface RedisRestGlobal {
  __aurumRedisRestClient?: RedisRestClient;
}
const restGlobal = globalThis as unknown as RedisRestGlobal;

function createRestClient(url: string, token: string): RedisRestClient {
  // Tolerate a trailing slash in the configured endpoint.
  const endpoint = url.replace(/\/+$/, '');
  return {
    async command(args) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `redis rest request failed: ${error instanceof Error ? error.message : 'network error'}`,
          { cause: error },
        );
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`redis rest rejected the command (HTTP ${response.status}): ${detail}`);
      }
      const parsed = (await response.json().catch(() => null)) as unknown;
      // Upstash's REST contract wraps EVERY command result in a
      // `{"result": <value>}` envelope (verified against the live wire:
      // PING → {"result":"PONG"}, LLEN → {"result":0}, LPOP on an empty
      // list → {"result":null}). The ports need the bare result, so the
      // envelope is unwrapped HERE — the one place that owns the wire.
      // Defensive for other HTTP-redis vendors: a body that is not the
      // envelope passes through unchanged.
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'result' in parsed
      ) {
        return (parsed as { result: unknown }).result;
      }
      return parsed;
    },
  };
}

/**
 * The Redis REST client singleton — `null` when the REST seam is not
 * configured (then the ports fall back: REDIS_URL, else memory). A
 * half-configured seam throws from `getRedisRestConfig` instead (loud).
 */
export function getRedisRestClient(): RedisRestClient | null {
  if (restGlobal.__aurumRedisRestClient !== undefined) return restGlobal.__aurumRedisRestClient;
  const config = getRedisRestConfig();
  if (config === undefined) return null;
  const client = createRestClient(config.url, config.token);
  restGlobal.__aurumRedisRestClient = client;
  return client;
}

/** Reset the singleton (tests; process shutdown needs nothing — stateless). */
export function closeRedisRest(): void {
  restGlobal.__aurumRedisRestClient = undefined;
}
