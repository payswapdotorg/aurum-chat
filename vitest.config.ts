import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    testMatch: ['**/*.test.ts'],
    // W076 — the real-browser suite lives in tests/browser/** as Playwright
    // **/*.spec.ts files and runs through its own command
    // (`bun run browser:journeys`, playwright.config.ts). Vitest 5 no
    // longer honors testMatch (it is a silent no-op — the default include
    // matches both *.test.ts and *.spec.ts), so the browser suite is
    // excluded EXPLICITLY here to keep `bun run test` exactly the
    // repository's node-environment baseline.
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
    // Station hygiene: embedded-PostgreSQL boots run 5-6s under sandbox
    // memory pressure; the 5s default produced boundary flakes in the
    // health readiness and journey-proof-sweep suites. 20s keeps every
    // real test green without masking genuine hangs (slowest legit test
    // is ~12s).
    testTimeout: 20000,
  },
});
