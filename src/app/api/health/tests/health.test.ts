// Integration tests for the health/readiness handler (W069):
// handleHealthGet in src/app/api/health/lib.ts, driven directly without
// booting Next.js. Real db port against the embedded PostgreSQL.
//
//   * ok shape: component labels, guardrails, migration count, worker
//     metrics — and NO tenant data (the readiness surface must stay
//     deployment-shape only);
//   * degraded: production with readiness refusals/warnings still
//     answers 200 with an explicit status;
//   * error → 503: the domain-truth database unreachable, or the schema
//     not applied — readiness fails closed;
//   * the route adapter sets cache-control: no-store (route.ts).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { handleHealthGet } from '../lib';
import { runMigrations } from '../../../../../scripts/migrate';

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  delete process.env.DEPLOYMENT_ENV;
  delete process.env.VERCEL_ENV;
  // Vitest runs with NODE_ENV=test; pin it type-safely against outer
  // environments so profile resolution stays deterministic.
  Object.assign(process.env, { NODE_ENV: 'test' });
  delete process.env.REDIS_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterEach(() => {
  delete process.env.DEPLOYMENT_ENV;
  delete process.env.VERCEL_ENV;
});

describe('health/readiness — the ok shape', () => {
  it('reports deployment shape with the applied migration count', async () => {
    const result = await handleHealthGet();
    expect(result.status).toBe(200);
    const body = result.body as {
      status: string;
      environment: { environment: string; dogfoodNotice: string | null };
      components: {
        db: { backend: string; ok: boolean; migrations: number | null };
        queue: { backend: string };
        email: { backend: string };
        blob: { backend: string };
      };
      guardrails: Record<string, number>;
      worker: Record<string, unknown>;
      readiness: { refusals: string[]; warnings: string[] };
    };
    expect(body.status).toBe('ok');
    expect(body.environment.environment).toBe('development');
    expect(body.environment.dogfoodNotice).toContain('non-commercial dogfood');
    expect(body.components.db.backend).toBe('embedded');
    expect(body.components.db.ok).toBe(true);
    expect(body.components.db.migrations).toBeGreaterThanOrEqual(40);
    expect(body.components.queue.backend).toBe('memory');
    expect(body.components.email.backend).toBe('memory');
    expect(body.components.blob.backend).toBe('memory');
    expect(body.guardrails.emailDailyLimit).toBe(100);
    expect(body.readiness.refusals).toEqual([]);
    expect(body.worker).toHaveProperty('jobsProcessed');
  });

  it('carries no tenant-shaped data (deployment shape only)', async () => {
    const result = await handleHealthGet();
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ['tenantId', 'principalId', 'authority', 'password', 'token']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('health/readiness — degraded (production misconfiguration)', () => {
  it('production with missing providers answers degraded 200 with warnings', async () => {
    process.env.DEPLOYMENT_ENV = 'production';
    // Unset the file's embedded selector so DATABASE_URL labels the
    // postgres backend (the db singleton stays the healthy embedded
    // instance — the label is what this test asserts).
    delete process.env.AURUM_DB;
    process.env.DATABASE_URL = 'postgres://user:pass@example.invalid/db';
    process.env.WORKER_TOKEN = 'configured';
    try {
      const result = await handleHealthGet();
      expect(result.status).toBe(200);
      const body = result.body as {
        status: string;
        readiness: { refusals: string[]; warnings: string[] };
        components: { db: { backend: string } };
      };
      expect(body.status).toBe('degraded');
      expect(body.components.db.backend).toBe('postgres');
      expect(body.readiness.refusals).toEqual([]);
      expect(body.readiness.warnings).toHaveLength(3);
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.WORKER_TOKEN;
      process.env.AURUM_DB = 'embedded';
    }
  });
});

describe('health/readiness — error (fail closed)', () => {
  it('503 when the domain-truth database is unreachable', async () => {
    // Close the healthy embedded database and force the port to try a
    // dead external server — readiness must fail closed with 503.
    await closeDb();
    process.env.AURUM_DB = 'postgres';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/none';
    try {
      const result = await handleHealthGet();
      expect(result.status).toBe(503);
      const body = result.body as { status: string; components: { db: { ok: boolean } } };
      expect(body.status).toBe('error');
      expect(body.components.db.ok).toBe(false);
    } finally {
      delete process.env.AURUM_DB;
      delete process.env.DATABASE_URL;
      process.env.AURUM_DB = 'embedded';
      process.env.AURUM_DB_MEMORY = '1';
      // Drop the dead postgres port first, then re-migrate the fresh
      // embedded database so subsequent tests see the applied schema.
      await closeDb().catch(() => undefined);
      await runMigrations(getDb());
    }
  });

  it("503 when the database answers but the schema isn't applied", async () => {
    await closeDb();
    process.env.AURUM_DB = 'embedded';
    process.env.AURUM_DB_MEMORY = '1';
    // A FRESH embedded database with NO migrations: SELECT 1 succeeds,
    // _migrations does not exist — live but not ready.
    try {
      const result = await handleHealthGet();
      expect(result.status).toBe(503);
      const body = result.body as {
        status: string;
        components: { db: { ok: boolean; error: string | null } };
      };
      expect(body.status).toBe('error');
      expect(body.components.db.error).toContain('_migrations');
    } finally {
      await closeDb();
      await runMigrations(getDb());
    }
  });
});
