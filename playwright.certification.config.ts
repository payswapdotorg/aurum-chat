// W079 — the PRODUCTION certification browser suite's configuration.
//
// Registered SEPARATELY from both `bun run test` (vitest runs only
// **/*.test.ts) and the W076 journey config (playwright.config.ts boots a
// local dev server with a seeded demo world — the OPPOSITE of what this
// suite needs). This config drives the LIVE PRODUCTION deployment:
//
//   * baseURL comes from W079_BASE_URL (the certification driver sets it
//     to the hosted production URL — a local/preview URL can never be
//     certified with it);
//   * NO global setup: production is NEVER seeded, reset or warmed by
//     the suite — every journey creates its state through the real
//     product flows (sign-up, onboarding, composer turns, invites);
//   * the ONLY teardown is the digest assembly (global-teardown.ts),
//     which folds the per-test records into browser-run-digest.json for
//     the driver;
//   * ONE worker, no parallelism — the journeys build on each other in
//     file order (J01 creates the run tenant; J05 invites the employee
//     and mints the API key; J07 answers the knowledge request);
//   * retries: 0 — a retry would launder a real defect (flaky is a
//     contract failure, not a pass);
//   * desktop 1280×800 and mobile touch 390×844 projects (the contract's
//     two browser contexts), Chromium as required.
//
// Determinism note: each certification RUN (A and B) mints its own fresh
// tenant (helpers.ts) — one-shot approvals and knowledge requests are
// consumed by their decisions, so runs never recycle consumed state.

import { defineConfig } from '@playwright/test';

const BASE_URL = process.env.W079_BASE_URL ?? '';
const RUN_DIR = process.env.W079_RUN_DIR ?? '';

if (BASE_URL === '' || RUN_DIR === '') {
  throw new Error(
    'playwright.certification.config.ts requires W079_BASE_URL and W079_RUN_DIR — ' +
      'run the browser matrix through the certification driver (bun run cert:production)',
  );
}

export default defineConfig({
  testDir: './tests/browser/production',
  outputDir: './test-results/certification',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  globalTeardown: './tests/browser/production/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: `${RUN_DIR}/playwright-results.json` }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: 'off',
    trace: 'off',
    actionTimeout: 60_000,
    navigationTimeout: 90_000,
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
