// Unit tests for the deployment profile (W069): environment separation,
// backend labeling, guardrail clamping and the production-readiness
// refusal/warning policy — the pure logic behind /api/health, the worker
// seam and scripts/worker.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertProductionReadiness,
  describeDeployment,
  resolveDeploymentProfile,
} from './deployment';

const TRACKED_VARS = [
  'DEPLOYMENT_ENV',
  'VERCEL_ENV',
  'NODE_ENV',
  'DATABASE_URL',
  'AURUM_DB',
  'AURUM_DB_MEMORY',
  'REDIS_URL',
  'RESEND_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'WORKER_TOKEN',
  'AURUM_COMMERCIAL',
  'AURUM_WORKER_MAX_ATTEMPTS',
  'AURUM_WORKER_BATCH_LIMIT',
  'AURUM_WORKER_POLL_INTERVAL_MS',
  'AURUM_EMAIL_DAILY_LIMIT',
  'AURUM_BLOB_MAX_BYTES',
  'AURUM_DB_POOL_MAX',
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  for (const name of TRACKED_VARS) saved.set(name, process.env[name]);
  // A neutral baseline: plain local development.
  setEnv({
    DEPLOYMENT_ENV: undefined,
    VERCEL_ENV: undefined,
    NODE_ENV: 'test',
    DATABASE_URL: undefined,
    AURUM_DB: undefined,
    AURUM_DB_MEMORY: undefined,
    REDIS_URL: undefined,
    RESEND_API_KEY: undefined,
    BLOB_READ_WRITE_TOKEN: undefined,
    WORKER_TOKEN: undefined,
    AURUM_COMMERCIAL: undefined,
  });
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('environment separation', () => {
  it('defaults to development outside any platform hints', () => {
    expect(resolveDeploymentProfile().environment).toBe('development');
  });

  it('an explicit DEPLOYMENT_ENV always wins over platform hints', () => {
    setEnv({ VERCEL_ENV: 'production', DEPLOYMENT_ENV: 'staging' });
    expect(resolveDeploymentProfile().environment).toBe('staging');
  });

  it('VERCEL_ENV maps production and preview directly', () => {
    setEnv({ VERCEL_ENV: 'production' });
    expect(resolveDeploymentProfile().environment).toBe('production');
    setEnv({ VERCEL_ENV: 'preview' });
    const preview = resolveDeploymentProfile();
    expect(preview.environment).toBe('preview');
    expect(preview.hostedOnVercel).toBe(true);
  });

  it('NODE_ENV=production without platform hints is production', () => {
    setEnv({ NODE_ENV: 'production' });
    const profile = resolveDeploymentProfile();
    expect(profile.environment).toBe('production');
    expect(profile.hostedOnVercel).toBe(false);
  });

  it('an unknown DEPLOYMENT_ENV is a hard misconfiguration (never re-labeled)', () => {
    setEnv({ DEPLOYMENT_ENV: 'prod-ish' });
    expect(() => resolveDeploymentProfile()).toThrow(/DEPLOYMENT_ENV/);
  });
});

describe('backend labeling', () => {
  it('local development: everything on the built-in memory/embedded runtimes', () => {
    const backends = resolveDeploymentProfile().backends;
    expect(backends).toEqual({
      db: 'embedded',
      queue: 'memory',
      cache: 'memory',
      lock: 'memory',
      email: 'memory',
      blob: 'memory',
    });
  });

  it('the free-tier dogfood stack labels Neon/Upstash/Resend/Blob correctly', () => {
    setEnv({
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      REDIS_URL: 'redis://example.invalid:6379',
      RESEND_API_KEY: 're_placeholder',
      BLOB_READ_WRITE_TOKEN: 'blob_placeholder',
    });
    const backends = resolveDeploymentProfile().backends;
    expect(backends.db).toBe('postgres');
    expect(backends.queue).toBe('redis');
    expect(backends.cache).toBe('redis');
    expect(backends.lock).toBe('redis');
    expect(backends.email).toBe('resend');
    expect(backends.blob).toBe('vercel-blob');
  });

  it('AURUM_COMMERCIAL=1 marks the commercial profile; default is dogfood', () => {
    expect(resolveDeploymentProfile().dogfood).toBe(true);
    expect(resolveDeploymentProfile().commercial).toBe(false);
    setEnv({ AURUM_COMMERCIAL: '1' });
    const commercial = resolveDeploymentProfile();
    expect(commercial.commercial).toBe(true);
    expect(commercial.dogfood).toBe(false);
  });
});

describe('usage guardrails', () => {
  it('defaults are the free-tier budgets', () => {
    expect(resolveDeploymentProfile().guardrails).toEqual({
      workerMaxAttempts: 5,
      workerBatchLimit: 10,
      workerPollIntervalMs: 2000,
      emailDailyLimit: 100,
      blobMaxBytes: 8 * 1024 * 1024,
      dbPoolMax: 5,
    });
  });

  it('env knobs override within clamps and ignore garbage', () => {
    setEnv({
      AURUM_WORKER_MAX_ATTEMPTS: '3',
      AURUM_WORKER_BATCH_LIMIT: '25',
      AURUM_WORKER_POLL_INTERVAL_MS: '5000',
      AURUM_EMAIL_DAILY_LIMIT: '0',
      AURUM_BLOB_MAX_BYTES: '1048576',
      AURUM_DB_POOL_MAX: '8',
    });
    expect(resolveDeploymentProfile().guardrails).toMatchObject({
      workerMaxAttempts: 3,
      workerBatchLimit: 25,
      workerPollIntervalMs: 5000,
      emailDailyLimit: 0,
      blobMaxBytes: 1024 * 1024,
      dbPoolMax: 8,
    });
    setEnv({ AURUM_WORKER_MAX_ATTEMPTS: '9999', AURUM_WORKER_BATCH_LIMIT: 'nope' });
    expect(resolveDeploymentProfile().guardrails).toMatchObject({
      workerMaxAttempts: 5, // clamped back to default
      workerBatchLimit: 10,
    });
  });
});

describe('production readiness', () => {
  it('nothing is enforced outside production', () => {
    setEnv({ DEPLOYMENT_ENV: 'development' });
    expect(assertProductionReadiness(resolveDeploymentProfile())).toEqual([]);
    setEnv({ DEPLOYMENT_ENV: 'preview' });
    expect(assertProductionReadiness(resolveDeploymentProfile())).toEqual([]);
    setEnv({ DEPLOYMENT_ENV: 'staging' });
    expect(assertProductionReadiness(resolveDeploymentProfile())).toEqual([]);
  });

  it('production REFUSES the embedded database and a missing worker token', () => {
    setEnv({ DEPLOYMENT_ENV: 'production', WORKER_TOKEN: 'tok' });
    const refusals = assertProductionReadiness(resolveDeploymentProfile()).filter(
      (note) => note.level === 'refusal',
    );
    expect(refusals).toHaveLength(1); // embedded db on PGlite
    expect(refusals[0]!.message).toContain('DATABASE_URL');

    setEnv({
      DEPLOYMENT_ENV: 'production',
      WORKER_TOKEN: undefined,
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    });
    const tokenRefusal = assertProductionReadiness(resolveDeploymentProfile()).filter(
      (note) => note.level === 'refusal',
    );
    expect(tokenRefusal).toHaveLength(1); // missing WORKER_TOKEN
    expect(tokenRefusal[0]!.message).toContain('WORKER_TOKEN');
  });

  it('a fully wired production has no refusals; missing optional providers only warn', () => {
    setEnv({
      DEPLOYMENT_ENV: 'production',
      WORKER_TOKEN: 'tok',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    });
    const notes = assertProductionReadiness(resolveDeploymentProfile());
    expect(notes.filter((n) => n.level === 'refusal')).toEqual([]);
    expect(notes.map((n) => n.level)).toEqual(['warning', 'warning', 'warning']);

    setEnv({
      DEPLOYMENT_ENV: 'production',
      WORKER_TOKEN: 'tok',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      REDIS_URL: 'redis://example.invalid:6379',
      RESEND_API_KEY: 're_placeholder',
      BLOB_READ_WRITE_TOKEN: 'blob_placeholder',
    });
    expect(assertProductionReadiness(resolveDeploymentProfile())).toEqual([]);
  });
});

describe('operator banner', () => {
  it('describes the profile without secrets', () => {
    setEnv({
      DATABASE_URL: 'postgres://user:secret-password@example.invalid/db',
      REDIS_URL: 'redis://:secret@example.invalid:6379',
    });
    const banner = describeDeployment(resolveDeploymentProfile()).join('\n');
    expect(banner).toContain('environment: development');
    expect(banner).toContain('db: postgres');
    expect(banner).toContain('queue: redis');
    expect(banner).toContain('internal/non-commercial dogfood');
    // Credentials must never appear in the banner.
    expect(banner).not.toContain('secret-password');
    expect(banner).not.toContain('secret@');
  });
});
