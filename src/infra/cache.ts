// Cache port: CACHES ONLY — never domain truth (ARCHITECTURE-LOCK 35).
//
// Backends: `memory` (default, dev/test) or `redis` when REDIS_URL is set
// (ioredis, imported lazily so the memory path stays dependency-free).

import type Redis from 'ioredis';
import { getRedisUrl } from './config';
import { now } from './clock';

export interface CachePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

function memoryCacheBackend(): CacheBackend {
  const entries = new Map<string, { value: string; expiresAtMs: number | null }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now().getTime()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, {
        value,
        expiresAtMs: ttlSeconds === undefined ? null : now().getTime() + Math.ceil(ttlSeconds * 1000),
      });
    },
    async del(key) {
      entries.delete(key);
    },
  };
}

function redisCacheBackend(client: Redis): CacheBackend {
  const key = (k: string) => `aurum:cache:${k}`;
  return {
    async get(k) {
      return client.get(key(k));
    },
    async set(k, value, ttlSeconds) {
      if (ttlSeconds === undefined) {
        await client.set(key(k), value);
        return;
      }
      await client.set(key(k), value, 'PX', Math.ceil(ttlSeconds * 1000));
    },
    async del(k) {
      await client.del(key(k));
    },
  };
}

let cachePort: CachePort | null = null;
let backendPromise: Promise<CacheBackend> | null = null;
let redisClient: Redis | null = null;

function ensureBackend(): Promise<CacheBackend> {
  backendPromise ??= (async () => {
    const url = getRedisUrl();
    if (url === undefined) return memoryCacheBackend();
    const { default: RedisCtor } = await import('ioredis');
    redisClient = new RedisCtor(url);
    return redisCacheBackend(redisClient);
  })();
  return backendPromise;
}

/** The cache port (singleton; backend chosen once from the environment). */
export function getCache(): CachePort {
  cachePort ??= {
    get: async (key) => (await ensureBackend()).get(key),
    set: async (key, value, ttlSeconds) => (await ensureBackend()).set(key, value, ttlSeconds),
    del: async (key) => (await ensureBackend()).del(key),
  };
  return cachePort;
}

/** Close the cache port and its redis connection, if any. */
export async function closeCache(): Promise<void> {
  cachePort = null;
  backendPromise = null;
  const client = redisClient;
  redisClient = null;
  if (client !== null) await client.quit();
}
