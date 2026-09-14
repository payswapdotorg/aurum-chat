// Queue port: QUEUES ONLY — never domain truth (ARCHITECTURE-LOCK 35).
//
// Backends: `memory` (default, dev/test) or `redis` when REDIS_URL is set
// (ioredis, imported lazily so the memory path stays dependency-free).

import type Redis from 'ioredis';
import { getRedisUrl } from './config';

export interface QueuePort {
  enqueue(name: string, message: unknown): Promise<void>;
  dequeue(name: string): Promise<unknown | null>;
}

interface QueueBackend {
  enqueue(name: string, message: unknown): Promise<void>;
  dequeue(name: string): Promise<unknown | null>;
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
  };
}

let queuePort: QueuePort | null = null;
let backendPromise: Promise<QueueBackend> | null = null;
let redisClient: Redis | null = null;

function ensureBackend(): Promise<QueueBackend> {
  backendPromise ??= (async () => {
    const url = getRedisUrl();
    if (url === undefined) return memoryQueueBackend();
    const { default: RedisCtor } = await import('ioredis');
    redisClient = new RedisCtor(url);
    return redisQueueBackend(redisClient);
  })();
  return backendPromise;
}

/** The queue port (singleton; backend chosen once from the environment). */
export function getQueue(): QueuePort {
  queuePort ??= {
    enqueue: async (name, message) => (await ensureBackend()).enqueue(name, message),
    dequeue: async (name) => (await ensureBackend()).dequeue(name),
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
