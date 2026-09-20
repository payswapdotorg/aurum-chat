// The non-production gate of the demo harness (W068 acceptance: "no
// production backdoor").
//
// Seeding demo tenants/personas creates real principals with known
// passwords and real tenants with real journey data. That is exactly what
// browser verification needs — and exactly what a production deployment
// must never receive. The gate is therefore PURE, checked BEFORE any
// database work, and fails closed:
//
//   * DATABASE_URL set, or AURUM_DB=postgres  → refuse (production-like
//     backend; the demo world may only ever live in the embedded dev/test
//     database);
//   * NODE_ENV=production                     → refuse (unconditionally —
//     a production runtime never seeds demos);
//   * AURUM_DB_MEMORY=1                       → allow (the vitest harness
//     mode: an isolated `:memory:` database is definitionally
//     non-production);
//   * AURUM_DEMO_SEED=1 (explicit opt-in)      → allow (the documented
//     way the dev seed script arms the embedded file database at
//     `.data/aurum.pg`);
//   * anything else                           → refuse (nobody seeds by
//     accident).
//
// The gate never inspects live state — callers pass the environment in
// (src/infra/config reads it; the seed composes both), so the decision is
// unit-testable and the seeding entry point stays the single place the
// rule lives.

import type {
  DemoSeedGateDecision,
  DemoSeedGateInput,
} from './types';

/** Evaluate the non-production gate for a seeding run (pure; no I/O). */
export function evaluateDemoSeedGate(input: DemoSeedGateInput): DemoSeedGateDecision {
  if (input.nodeEnv === 'production') {
    return {
      allowed: false,
      code: 'production_runtime',
      reason:
        'the demo harness never runs in a production runtime (NODE_ENV=production) — demo tenants and demo credentials are for browser verification only',
    };
  }
  if (input.databaseUrl !== undefined || input.backend === 'postgres') {
    return {
      allowed: false,
      code: 'production_backend',
      reason:
        'the demo harness refuses to seed a server database (DATABASE_URL/AURUM_DB=postgres) — seed the embedded dev database instead (AURUM_DB=embedded, .data/aurum.pg)',
    };
  }
  if (input.memoryMode) {
    return { allowed: true };
  }
  if (input.optIn) {
    return { allowed: true };
  }
  return {
    allowed: false,
    code: 'opt_in_required',
    reason:
      'seeding the demo harness requires an explicit opt-in — set AURUM_DEMO_SEED=1 for the embedded dev database (tests use AURUM_DB_MEMORY=1)',
  };
}
