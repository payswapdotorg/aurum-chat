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

/** Force the embedded database into `:memory:` mode (used by tests). */
export function isDbMemory(): boolean {
  return envFlag('AURUM_DB_MEMORY');
}
