// THE database port: one parameterized-SQL surface for the whole application.
//
// Backends (identical `$1, $2, ...` placeholder semantics either way):
//   - embedded (default; AURUM_DB=embedded): PGlite — real PostgreSQL 16 as
//     WASM. `.data/aurum.pg` for dev; `:memory:` when AURUM_DB_MEMORY=1
//     (tests).
//   - postgres (AURUM_DB=postgres, or DATABASE_URL set): node-postgres Pool.
//
// Precedence: an explicit AURUM_DB always wins; otherwise a set DATABASE_URL
// selects postgres; otherwise the embedded backend is the default.
//
// No module outside src/infra may import `pg` or `@electric-sql/pglite`
// (enforced by scripts/check-architecture.ts).
//
// `transaction` pins a single connection with BEGIN/COMMIT/ROLLBACK —
// required because a node-postgres Pool may otherwise spread the statements
// of one transaction across different pooled connections.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { getAurumDb, getDatabaseUrl, isDbMemory } from './config';

/** Dev location of the embedded (PGlite) database. */
export const EMBEDDED_DB_PATH = '.data/aurum.pg';

export interface DbRow {
  [column: string]: unknown;
}

export interface DbResult<T extends DbRow = DbRow> {
  rows: T[];
  rowCount: number | null;
}

/** Anything that executes parameterized SQL: the db port or an open transaction. */
export interface Queryable {
  query<T extends DbRow = DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>>;
}

export interface DbPort extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

function normalizePglite<T extends DbRow>(result: { rows: T[]; affectedRows?: number }): DbResult<T> {
  return {
    rows: result.rows,
    rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null,
  };
}

class EmbeddedDb implements DbPort {
  constructor(private readonly pglite: PGlite) {}

  query<T extends DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
    return this.pglite.query<T>(sql, params).then(normalizePglite);
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pglite.transaction((tx) =>
      fn({
        query: <T2 extends DbRow>(sql: string, params?: unknown[]) =>
          tx.query<T2>(sql, params).then(normalizePglite),
      }),
    );
  }

  close(): Promise<void> {
    return this.pglite.close();
  }
}

class PostgresDb implements DbPort {
  constructor(private readonly pool: Pool) {}

  async query<T extends DbRow>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
    const result =
      params === undefined ? await this.pool.query<T>(sql) : await this.pool.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? null };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Queryable = {
        query: async <T2 extends DbRow>(sql: string, params?: unknown[]) => {
          const result =
            params === undefined
              ? await client.query<T2>(sql)
              : await client.query<T2>(sql, params);
          return { rows: result.rows, rowCount: result.rowCount ?? null };
        },
      };
      const value = await fn(tx);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

// The singleton lives on globalThis (NOT a module-level variable): Next's
// dev runtime compiles route bundles into separate module registries, and
// a module-level singleton would hand each registry its OWN PGlite
// instance over the same file — divergent in-memory state followed by
// whole-file last-writer-wins corruption (W058 exposed this: a session
// written by an API route "vanished" for a page render). The global
// object is shared by every registry in the process, so exactly one
// embedded database (or Pool) exists per process, the same discipline
// Prisma's Next.js guidance uses for its client.
interface DbGlobal {
  __aurumDbPort?: DbPort;
  __aurumDbClose?: () => Promise<void>;
}
const dbGlobal = globalThis as unknown as DbGlobal;

function createFilePglite(): PGlite {
  mkdirSync(path.dirname(EMBEDDED_DB_PATH), { recursive: true });
  return new PGlite(EMBEDDED_DB_PATH);
}

/** Singleton database port for this process (shared across every route bundle). */
export function getDb(): DbPort {
  if (dbGlobal.__aurumDbPort !== undefined) return dbGlobal.__aurumDbPort;
  const backend = getAurumDb() ?? (getDatabaseUrl() !== undefined ? 'postgres' : 'embedded');
  if (backend === 'postgres') {
    const url = getDatabaseUrl();
    if (url === undefined) {
      throw new Error('AURUM_DB=postgres requires DATABASE_URL to be set');
    }
    const postgres = new PostgresDb(new Pool({ connectionString: url }));
    dbGlobal.__aurumDbPort = postgres;
    dbGlobal.__aurumDbClose = () => postgres.close();
    return postgres;
  }
  const embedded = isDbMemory() ? new EmbeddedDb(new PGlite()) : new EmbeddedDb(createFilePglite());
  dbGlobal.__aurumDbPort = embedded;
  dbGlobal.__aurumDbClose = () => embedded.close();
  return embedded;
}

/** Close the singleton (flushes the embedded database; ends the pool). */
export async function closeDb(): Promise<void> {
  const close = dbGlobal.__aurumDbClose;
  dbGlobal.__aurumDbPort = undefined;
  dbGlobal.__aurumDbClose = undefined;
  if (close !== undefined) await close();
}
