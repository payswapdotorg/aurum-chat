import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    testMatch: ['**/*.test.ts'],
    // Station hygiene: embedded-PostgreSQL boots run 5-6s under sandbox
    // memory pressure; the 5s default produced boundary flakes in the
    // health readiness and journey-proof-sweep suites. 20s keeps every
    // real test green without masking genuine hangs (slowest legit test
    // is ~12s).
    testTimeout: 20000,
  },
});
