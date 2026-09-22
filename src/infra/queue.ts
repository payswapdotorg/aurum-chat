// Queue port: QUEUES ONLY — never domain truth (ARCHITECTURE-LOCK 35).
//
// Backends: `memory` (default, dev/test) or `redis` when REDIS_URL is set
// (ioredis, imported lazily so the memory path stays dependency-free).
// W077 adds the redis-over-HTTP transport (Upstash REST —
// UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN) as the second
// redis option, behind the same port semantics.
// W069 adds `depth` (observable queue length) for the worker seam and
// /api/health — read-only bookkeeping, never domain state.

import type Redis from 'ioredis';
import { getRedisUrl } from './config';
import { getRedisRestClient, type RedisRestClient } from './redis-rest';

export interface QueuePort {
  enqueue(name: string, message: unknown): Promise<void>;
  dequeue(name: string): Promise<unknown | null>;
  /** Current number of waiting messages (0 for unknown/empty queues). */
  depth(name: string): Promise<number>;
}

interface QueueBackend {
  enqueue(name: string, message: unknown): Promise<void>;
  dequeue(name: string): Promise<unknown | null>;
  depth(name: string): Promise<number>;
}

function memoryQueueBackend(): QueueBackend {
  const lists = new Map<string, unknown[]>();
  return {
    async enqueue(name, message) {
      const list = lists.get(name) ?? [];
      list.push(message);
      lists.set(name, list);
    },
    async dequeue(name) {
      const message = lists.get(name)?.shift();
      return message === undefined ? null : message;
    },
    async depth(name) {
      return lists.get(name)?.length ?? 0;
    },
  };
}

function redisQueueBackend(client: Redis): QueueBackend {
  const key = (name: string) => `aurum:queue:${name}`;
  return {
    async enqueue(name, message) {
      await client.rpush(key(name), JSON.stringify(message));
    },
    async dequeue(name) {
      const raw = await client.lpop(key(name));
      return raw === null ? null : (JSON.parse(raw) as unknown);
    },
    async depth(name) {
      return client.llen(key(name));
    },
  };
}

function redisRestQueueBackend(client: RedisRestClient): QueueBackend {
  const key = (name: string) => `aurum:queue:${name}`;
  return {
    async enqueue(name, message) {
      await client.command(['RPUSH', key(name), JSON.stringify(message)]);
    },
    async dequeue(name) {
      const raw = await client.command(['LPOP', key(name)]);
      return raw === null || raw === undefined ? null : (JSON.parse(String(raw)) as unknown);
    },
    async depth(name) {
      const raw = await client.command(['LLEN', key(name)]);
      return Number(raw ?? 0);
    },
  };
}

let queuePort: QueuePort | null = null;
let backendPromise: Promise<QueueBackend> | null = null;
let redisClient: Redis | null = null;

function ensureBackend(): Promise<QueueBackend> {
  backendPromise ??= (async () => {
    const url = getRedisUrl();
    if (url !== undefined) {
      const { default: RedisCtor } = await import('ioredis');
      redisClient = new RedisCtor(url);
      return redisQueueBackend(redisClient);
    }
    const rest = getRedisRestClient();
    if (rest !== null) return redisRestQueueBackend(rest);
    return memoryQueueBackend();
  })();
  return backendPromise;
}

/** The queue port (singleton; backend chosen once from the environment). */
export function getQueue(): QueuePort {
  queuePort ??= {
    enqueue: async (name, message) => (await ensureBackend()).enqueue(name, message),
    dequeue: async (name) => (await ensureBackend()).dequeue(name),
    depth: async (name) => (await ensureBackend()).depth(name),
  };
  return queuePort;
}

/** Close the queue port and its redis connection, if any. */
export async function closeQueue(): Promise<void> {
  queuePort = null;
  backendPromise = null;
  const client = redisClient;
  redisClient = null;
  if (client !== null) await client.quit();
}
