// W068 — the production-backdoor guard of the demo harness.
//
// "no production backdoor" is an acceptance criterion of the work item,
// and this file is where it is enforced. The demo seed may ONLY run when
// BOTH of these hold:
//
//   1. the database is the EMBEDDED one (PGlite): `DATABASE_URL` must be
//      unset AND `AURUM_DB` must be 'embedded' or unset (embedded is the
//      documented default — IMPLEMENTATION-STACK §3: "AURUM_DB=embedded
//      (default; dev + test)"). A real server PostgreSQL — which is what
//      staging and production run on — always sets DATABASE_URL, so the
//      seed refuses before it can touch a production database.
//   2. the operator explicitly opted in by setting AURUM_DEMO_SEED=1. The
//      embedded dev database is also used by ordinary local development;
//      demo data must never appear there as a side effect.
//
// The guard is deliberately pure and dependency-free so the unit tests can
// exercise every branch without a database, and `seedDemoHarness` calls
// `assertDemoSeedAllowed()` as its FIRST operation (before any module
// contract is touched).

import { DemoError } from './errors';

/** The opt-in environment variable (must be exactly '1'). */
export const DEMO_SEED_ENV = 'AURUM_DEMO_SEED';

/** The db-mode environment variables the guard inspects. */
export const DEMO_SEED_DB_ENV = 'AURUM_DB';

export interface DemoSeedEnvironment {
  /** process.env.DATABASE_URL */
  databaseUrl: string | undefined;
  /** process.env.AURUM_DB (undefined = embedded default) */
  aurumDb: string | undefined;
  /** process.env.AURUM_DEMO_SEED */
  demoSeed: string | undefined;
}

/** Read the guard's inputs from the real environment. */
export function demoSeedEnvironment(): DemoSeedEnvironment {
  return {
    databaseUrl: process.env.DATABASE_URL,
    aurumDb: process.env.AURUM_DB,
    demoSeed: process.env[DEMO_SEED_ENV],
  };
}

/** Is the database the embedded (non-production) one? */
export function isEmbeddedDatabase(env: Pick<DemoSeedEnvironment, 'databaseUrl' | 'aurumDb'>): boolean {
  if (env.databaseUrl !== undefined && env.databaseUrl !== '') return false;
  if (env.aurumDb === undefined || env.aurumDb === '') return true;
  return env.aurumDb === 'embedded';
}

/** Is the demo opt-in satisfied? */
export function isDemoOptedIn(env: Pick<DemoSeedEnvironment, 'demoSeed'>): boolean {
  return env.demoSeed === '1';
}

/** Both guard conditions at once. */
export function isDemoSeedAllowed(env: DemoSeedEnvironment = demoSeedEnvironment()): boolean {
  return isEmbeddedDatabase(env) && isDemoOptedIn(env);
}

/**
 * Throw `production_backdoor` unless seeding is allowed. `seedDemoHarness`
 * calls this first — no demo tenant, principal or journey record can be
 * created against a server database or without the explicit opt-in.
 */
export function assertDemoSeedAllowed(env: DemoSeedEnvironment = demoSeedEnvironment()): void {
  if (!isEmbeddedDatabase(env)) {
    throw new DemoError(
      'production_backdoor',
      'the demo harness refuses to run against a server database (DATABASE_URL is set) — demo tenants exist only in the embedded, non-production database',
    );
  }
  if (!isDemoOptedIn(env)) {
    throw new DemoError(
      'production_backdoor',
      `the demo harness requires an explicit opt-in: set ${DEMO_SEED_ENV}=1 (it is non-production tooling, never a side effect)`,
    );
  }
}
