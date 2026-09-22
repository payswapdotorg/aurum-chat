// Lock port: mutual exclusion ONLY — never domain truth (ARCHITECTURE-LOCK 35).
//
// Backends: `memory` (default, dev/test) or `redis` when REDIS_URL is set
// (ioredis, imported lazily so the memory path stays dependency-free).
// W077 adds the redis-over-HTTP transport (Upstash REST —
// UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN) as the second
// redis option, behind the same port semantics.
//
// Acquire resolves to an opaque token; releasing requires the SAME token, so
// a caller can never release a lock it does not own. The redis backends use
// SET NX PX plus a compare-and-delete Lua script; the memory backend mirrors
// the same semantics in-process.

import type Redis from 'ioredis';
import { getRedisUrl } from './config';
import { getRedisRestClient, type RedisRestClient } from './redis-rest';
import { now } from './clock';
import { newId } from './ids';

export interface LockPort {
  /** Acquire `key` for at most `ttlMs`; resolves to a token, or null when held. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /** Release `key` with the acquire token; resolves true when this caller released it. */
  release(key: string, token: string): Promise<boolean>;
}

interface LockBackend {
  acquire(key: string, ttlMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<boolean>;
}

function memoryLockBackend(): LockBackend {
  const held = new Map<string, { token: string; expiresAtMs: number }>();
  return {
    async acquire(key, ttlMs) {
      const atMs = now().getTime();
      const current = held.get(key);
      if (current !== undefined && current.expiresAtMs > atMs) return null;
      const token = newId();
      held.set(key, { token, expiresAtMs: atMs + ttlMs });
      return token;
    },
    async release(key, token) {
      const current = held.get(key);
      if (current === undefined || current.token !== token) return false;
      held.delete(key);
      return true;
    },
  };
}

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function redisLockBackend(client: Redis): LockBackend {
  const key = (k: string) => `aurum:lock:${k}`;
  return {
    async acquire(k, ttlMs) {
      const token = newId();
      const ok = await client.set(key(k), token, 'PX', Math.ceil(ttlMs), 'NX');
      return ok === 'OK' ? token : null;
    },
    async release(k, token) {
      const result = await client.eval(RELEASE_SCRIPT, 1, key(k), token);
      return Number(result) === 1;
    },
  };
}

function redisRestLockBackend(client: RedisRestClient): LockBackend {
  const key = (k: string) => `aurum:lock:${k}`;
  return {
    async acquire(k, ttlMs) {
      const token = newId();
      const ok = await client.command(['SET', key(k), token, 'PX', Math.ceil(ttlMs), 'NX']);
      return ok === 'OK' ? token : null;
    },
    async release(k, token) {
      const result = await client.command(['EVAL', RELEASE_SCRIPT, '1', key(k), token]);
      return Number(result) === 1;
    },
  };
}

let lockPort: LockPort | null = null;
let backendPromise: Promise<LockBackend> | null = null;
let redisClient: Redis | null = null;

function ensureBackend(): Promise<LockBackend> {
  backendPromise ??= (async () => {
    const url = getRedisUrl();
    if (url !== undefined) {
      const { default: RedisCtor } = await import('ioredis');
      redisClient = new RedisCtor(url);
      return redisLockBackend(redisClient);
    }
    const rest = getRedisRestClient();
    if (rest !== null) return redisRestLockBackend(rest);
    return memoryLockBackend();
  })();
  return backendPromise;
}

/** The lock port (singleton; backend chosen once from the environment). */
export function getLock(): LockPort {
  lockPort ??= {
    acquire: async (key, ttlMs) => (await ensureBackend()).acquire(key, ttlMs),
    release: async (key, token) => (await ensureBackend()).release(key, token),
  };
  return lockPort;
}

/** Close the lock port and its redis connection, if any. */
export async function closeLock(): Promise<void> {
  lockPort = null;
  backendPromise = null;
  const client = redisClient;
  redisClient = null;
  if (client !== null) await client.quit();
}
