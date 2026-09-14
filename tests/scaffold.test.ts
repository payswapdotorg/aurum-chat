// W000 scaffold test — proves the whole spine:
//  * embedded database (`:memory:` PGlite) boots and round-trips
//    parameterized SQL, including transactions;
//  * the migration runner handles an empty/absent modules dir, orders
//    modules topologically by contract-import edges and is idempotent;
//  * arch rule (d) logic: information_schema introspection finds tenant_id;
//  * queue/cache/lock memory backends round-trip (with TTL + contention);
//  * the clock is injectable.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeCache, getCache } from '@/infra/cache';
import { fixedClock, now } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { closeLock, getLock } from '@/infra/lock';
import { closeQueue, getQueue } from '@/infra/queue';
import { withTenant } from '@/infra/tenant';
import { computeModuleOrder, runMigrations } from '../scripts/migrate';

const db = getDb();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterAll(async () => {
  await closeDb();
  await closeQueue();
  await closeCache();
  await closeLock();
});

describe('infra db (embedded PGlite, :memory:)', () => {
  it('round-trips a throwaway migration with parameterized SQL', async () => {
    await db.query(
      `CREATE TABLE t (
         id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
         tenant_id uuid NOT NULL,
         n int
       )`,
    );
    const tenantId = newId();
    const inserted = await db.query<{ id: string; tenant_id: string; n: number }>(
      `INSERT INTO t (tenant_id, n) VALUES ($1, $2) RETURNING id, tenant_id, n`,
      [tenantId, 42],
    );
    expect(inserted.rows).toHaveLength(1);
    const row = inserted.rows[0]!;
    expect(row.n).toBe(42);
    expect(row.tenant_id).toBe(tenantId);
    expect(row.id).toMatch(UUID_V4);

    const selected = await db.query<{ id: string; n: number }>(
      `SELECT id, n FROM t WHERE id = $1`,
      [row.id],
    );
    expect(selected.rows).toHaveLength(1);
    expect(selected.rows[0]!.n).toBe(42);

    const byTenant = await db.query<{ n: number }>(
      `SELECT n FROM t WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(byTenant.rows.map((r) => r.n)).toEqual([42]);
  });

  it('asserts arch rule (d) logic: information_schema sees tenant_id on the throwaway table', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 't'`,
    );
    expect(columns.rows.map((c) => c.column_name)).toContain('tenant_id');
  });

  it('runs migrations with an empty/absent modules dir (creates only _migrations, idempotent)', async () => {
    const first = await runMigrations(db);
    const second = await runMigrations(db);
    expect(first.applied).toEqual([]);
    expect(second.applied).toEqual([]);
    const recorded = await db.query<{ name: string }>(`SELECT name FROM _migrations`);
    expect(recorded.rows).toEqual([]);
    const tables = (
      await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).rows.map((t) => t.table_name);
    expect(tables.sort()).toEqual(['_migrations', 't']);
  });

  it('commits transactions atomically and rolls back on failure', async () => {
    await db.query(
      `CREATE TABLE tx_probe (
         id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
         tenant_id uuid NOT NULL,
         n int
       )`,
    );
    const tenantId = newId();
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO tx_probe (tenant_id, n) VALUES ($1, $2)`, [tenantId, 1]);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO tx_probe (tenant_id, n) VALUES ($1, $2)`, [tenantId, 2]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.query<{ n: number }>(
      `SELECT n FROM tx_probe WHERE tenant_id = $1 ORDER BY n`,
      [tenantId],
    );
    expect(rows.rows.map((r) => r.n)).toEqual([1]);
  });
});

describe('migration runner (synthetic modules)', () => {
  it('orders modules topologically (dependencies first) and applies idempotently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aurum-modules-'));
    try {
      for (const dir of ['alpha/migrations', 'bravo/migrations', 'orphan/migrations']) {
        await mkdir(path.join(root, dir), { recursive: true });
      }
      // alpha imports bravo's contract -> bravo is a dependency of alpha.
      await writeFile(
        path.join(root, 'alpha', 'service.ts'),
        `import type { Bravo } from '@/modules/bravo/contract';\nexport const alpha = 1;\n`,
      );
      await writeFile(
        path.join(root, 'alpha', 'contract.ts'),
        `export interface Alpha { id: string }\n`,
      );
      await writeFile(
        path.join(root, 'alpha', 'migrations', '001-alpha.sql'),
        `CREATE TABLE alpha_things (\n  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n  tenant_id uuid NOT NULL,\n  bravo_id uuid NOT NULL\n);\n`,
      );
      await writeFile(
        path.join(root, 'bravo', 'contract.ts'),
        `export interface Bravo { id: string }\n`,
      );
      await writeFile(
        path.join(root, 'bravo', 'migrations', '001-bravo.sql'),
        `CREATE TABLE bravo_bits (\n  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n  tenant_id uuid NOT NULL,\n  label text NOT NULL\n);\n`,
      );
      await writeFile(
        path.join(root, 'orphan', 'contract.ts'),
        `export interface Orphan { id: string }\n`,
      );
      await writeFile(
        path.join(root, 'orphan', 'migrations', '001-orphan.sql'),
        `CREATE TABLE orphan_notes (\n  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n  tenant_id uuid NOT NULL,\n  note text\n);\n`,
      );

      const report = await runMigrations(db, root);
      expect(report.order).toEqual(['bravo', 'orphan', 'alpha']);
      expect(report.applied).toEqual([
        'bravo/001-bravo.sql',
        'orphan/001-orphan.sql',
        'alpha/001-alpha.sql',
      ]);

      const rerun = await runMigrations(db, root);
      expect(rerun.applied).toEqual([]);
      expect(rerun.skipped.sort()).toEqual([
        'alpha/001-alpha.sql',
        'bravo/001-bravo.sql',
        'orphan/001-orphan.sql',
      ]);

      const recorded = await db.query<{ name: string }>(`SELECT name FROM _migrations ORDER BY name`);
      expect(recorded.rows.map((r) => r.name)).toEqual([
        'alpha/001-alpha.sql',
        'bravo/001-bravo.sql',
        'orphan/001-orphan.sql',
      ]);

      const tables = (
        await db.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        )
      ).rows.map((t) => t.table_name);
      expect(tables).toContain('bravo_bits');
      expect(tables).toContain('orphan_notes');
      expect(tables).toContain('alpha_things');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a dependency cycle as a hard error', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aurum-cycle-'));
    try {
      for (const dir of ['x', 'y']) {
        await mkdir(path.join(root, dir), { recursive: true });
      }
      await writeFile(
        path.join(root, 'x', 'a.ts'),
        `import type { Y } from '@/modules/y/contract';\n`,
      );
      await writeFile(
        path.join(root, 'y', 'a.ts'),
        `import type { X } from '@/modules/x/contract';\n`,
      );
      await expect(computeModuleOrder(root)).rejects.toThrow(/cycle/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('infra queue (memory backend)', () => {
  it('enqueue -> dequeue round trips in FIFO order and drains to null', async () => {
    const queue = getQueue();
    await queue.enqueue('scaffold', { kind: 'a' });
    await queue.enqueue('scaffold', { kind: 'b' });
    await queue.enqueue('scaffold', { kind: 'c' });
    expect(await queue.dequeue('scaffold')).toEqual({ kind: 'a' });
    expect(await queue.dequeue('scaffold')).toEqual({ kind: 'b' });
    expect(await queue.dequeue('scaffold')).toEqual({ kind: 'c' });
    expect(await queue.dequeue('scaffold')).toBeNull();
  });
});

describe('infra cache (memory backend)', () => {
  it('sets, gets and deletes values', async () => {
    const cache = getCache();
    await cache.set('scaffold:key', 'value-1');
    expect(await cache.get('scaffold:key')).toBe('value-1');
    await cache.del('scaffold:key');
    expect(await cache.get('scaffold:key')).toBeNull();
  });

  it('expires values after the ttl', async () => {
    const cache = getCache();
    await cache.set('scaffold:ttl', 'gone-soon', 0.05);
    expect(await cache.get('scaffold:ttl')).toBe('gone-soon');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await cache.get('scaffold:ttl')).toBeNull();
  });
});

describe('infra lock (memory backend)', () => {
  it('serializes contention: a second acquire fails until release', async () => {
    const lock = getLock();
    const token = await lock.acquire('scaffold:lock', 5_000);
    expect(token).toMatch(UUID_V4);
    expect(await lock.acquire('scaffold:lock', 5_000)).toBeNull(); // contention
    expect(await lock.release('scaffold:lock', 'not-the-token')).toBe(false);
    expect(await lock.release('scaffold:lock', token!)).toBe(true);
    const again = await lock.acquire('scaffold:lock', 5_000);
    expect(again).toMatch(UUID_V4);
    await lock.release('scaffold:lock', again!);
  });

  it('lets a stale lock expire and invalidates the old token', async () => {
    const lock = getLock();
    const staleToken = await lock.acquire('scaffold:stale', 50);
    expect(staleToken).toMatch(UUID_V4);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const refreshed = await lock.acquire('scaffold:stale', 5_000);
    expect(refreshed).toMatch(UUID_V4);
    expect(await lock.release('scaffold:stale', staleToken!)).toBe(false);
    await lock.release('scaffold:stale', refreshed!);
  });
});

describe('infra clock', () => {
  it('supports injection via fixedClock while now() stays live', () => {
    const fixedAt = '2024-01-01T00:00:00.000Z';
    const clock = fixedClock(fixedAt);
    expect(clock.now().toISOString()).toBe(fixedAt);
    expect(clock.now().toISOString()).toBe(fixedAt);
    const live = now();
    expect(live).toBeInstanceOf(Date);
    expect(live.getTime()).toBeGreaterThanOrEqual(Date.parse(fixedAt));
  });
});

describe('infra tenant', () => {
  it('passes an explicit TenantContext through withTenant', async () => {
    const context = { tenantId: newId(), principalId: newId(), authority: ['admin'] };
    const seen = await withTenant(context, async (inner) => inner);
    expect(seen).toEqual(context);
  });
});

describe('infra ids', () => {
  it('mints unique uuid v4 ids', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newId()));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
