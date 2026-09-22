// Environment access helpers (DATABASE_URL, AURUM_DB, REDIS_URL, ...).
//
// Rule: this module NEVER throws at import time — every read is a function
// call, so importing `config` is always side-effect free. Blank values are
// treated as unset so `.env.example` style empty entries are inert.

/** Raw env value, normalized: `undefined` when missing or blank. */
export function envString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Boolean env flag: true only for 1/true/yes/on (case-insensitive). */
export function envFlag(name: string): boolean {
  const value = envString(name)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Database backend selector. `undefined` = not explicitly chosen. */
export type DbBackend = 'embedded' | 'postgres';

/** Explicit database backend from AURUM_DB (throws only when *called* with a bad value). */
export function getAurumDb(): DbBackend | undefined {
  const value = envString('AURUM_DB')?.toLowerCase();
  if (value === undefined) return undefined;
  if (value === 'embedded' || value === 'postgres') return value;
  throw new Error(`AURUM_DB must be 'embedded' or 'postgres' (got '${value}')`);
}

/** PostgreSQL connection string for the node-postgres backend (staging/production). */
export function getDatabaseUrl(): string | undefined {
  return envString('DATABASE_URL');
}

/** Redis connection string; when set, the redis backends are used for queue/cache/lock. */
export function getRedisUrl(): string | undefined {
  return envString('REDIS_URL');
}

/** Redis-over-HTTP (Upstash REST) configuration: endpoint + bearer token. */
export interface RedisRestConfig {
  url: string;
  token: string;
}

/**
 * The redis REST seam (W077). Two spellings are accepted so both the direct
 * Upstash naming and the Vercel marketplace integration naming work:
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL       + KV_REST_API_TOKEN
 * A HALF-CONFIGURED pair is a hard misconfiguration (loud, never silently
 * re-labeled as the memory backend) — the same discipline as AURUM_DB.
 */
export function getRedisRestConfig(): RedisRestConfig | undefined {
  const url = envString('UPSTASH_REDIS_REST_URL') ?? envString('KV_REST_API_URL');
  const token = envString('UPSTASH_REDIS_REST_TOKEN') ?? envString('KV_REST_API_TOKEN');
  if (url === undefined && token === undefined) return undefined;
  if (url === undefined || token === undefined) {
    throw new Error(
      'redis rest requires BOTH a URL and a token (set UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN together)',
    );
  }
  return { url, token };
}

/** Force the embedded database into `:memory:` mode (used by tests). */
export function isDbMemory(): boolean {
  return envFlag('AURUM_DB_MEMORY');
}
