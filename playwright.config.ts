// W076 — the real-browser journey suite's configuration.
//
// The suite is registered SEPARATELY from `bun run test` (vitest runs
// only **/*.test.ts; these are **/*.spec.ts files), so the repository's
// baseline gate stays exactly as it was. One command runs the whole
// browser layer:
//
//   bun run browser:journeys
//
// Determinism choices:
//   * ONE worker, no parallelism — every journey runs against the same
//     seeded world in a fixed order (the suite mutates a little state by
//     design: a composer turn, an inline approval decision);
//   * retries: 0 — a retry would launder a real defect;
//   * the app itself is launched by tests/browser/global-setup.ts
//     (reset + seed + next dev on the dedicated port 3105 + health-wait)
//     and torn down deterministically at the end.
//
// Projects: desktop 1280×800 and mobile 390×844 with touch — both on the
// sandbox CHROMIUM (the work item's binding requirement; the mobile
// context is defined explicitly rather than via a device descriptor,
// which would pin the webkit engine).

import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.W076_PORT ?? 3105);

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  globalSetup: './tests/browser/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: './docs/productization-evidence/W076/journey-results.json' }],
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'off',
    trace: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'desktop',
      testMatch: /.*-desktop\.spec\.ts/,
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      testMatch: /.*-mobile\.spec\.ts/,
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});
