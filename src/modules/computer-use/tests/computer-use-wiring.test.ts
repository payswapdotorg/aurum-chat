// Tests of the env-driven browser-driver wiring (W110 —
// src/modules/computer-use/wiring.ts, the W108 cellular Family-A
// reference pattern). No database, no browser, no network: these prove
// the ENVIRONMENT → DRIVER construction mapping, the honest unset/unknown
// posture (an unwired driver stays `driver_unavailable`, never a faked
// success), the explicit-setBrowserDriver precedence, and the
// globalThis-guarded idempotence.

delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterEach, describe, expect, it } from 'vitest';
import {
  createPlaywrightBrowserDriver,
  createScriptedBrowserDriver,
  ensureBrowserDriverWired,
  getBrowserDriver,
  resetBrowserDriverWiring,
  setBrowserDriver,
} from '../contract';

const WIRING_ENV_KEYS = [
  'BROWSER_DRIVER',
  'BROWSER_CREDENTIALS',
  'BROWSER_ARTIFACT_DIR',
  'BROWSER_PROFILE_DIR',
  'BROWSER_HEADLESS',
  'BROWSER_ACTION_TIMEOUT_MS',
] as const;

function clearWiringEnv(): void {
  for (const key of WIRING_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearWiringEnv();
  resetBrowserDriverWiring();
});

describe('ensureBrowserDriverWired — the env → driver construction', () => {
  it('no configuration: honestly unwired (the default posture is unchanged)', () => {
    clearWiringEnv();
    const report = ensureBrowserDriverWired();
    expect(report).toMatchObject({ driver: 'none', state: 'unwired' });
    expect(report.detail).toContain('driver_unavailable');
    expect(getBrowserDriver()).toBeNull();
  });

  it("BROWSER_DRIVER='none': explicitly unwired, honestly", () => {
    process.env.BROWSER_DRIVER = 'none';
    const report = ensureBrowserDriverWired();
    expect(report).toMatchObject({ driver: 'none', state: 'unwired' });
    expect(getBrowserDriver()).toBeNull();
  });

  it("BROWSER_DRIVER='playwright': the real Playwright adapter is wired (inert construction — no engine launches until a session starts)", () => {
    process.env.BROWSER_DRIVER = 'playwright';
    const report = ensureBrowserDriverWired();
    expect(report).toMatchObject({ driver: 'playwright', state: 'wired' });
    const wired = getBrowserDriver();
    expect(wired).not.toBeNull();
    expect(typeof wired!.startSession).toBe('function');
    expect(typeof wired!.performAction).toBe('function');
    expect(typeof wired!.endSession).toBe('function');
    // Inert by construction: wiring never launches a browser.
    expect((wired as unknown as { engineVersion: () => string }).engineVersion()).toBe(
      'not-launched',
    );
  });

  it("BROWSER_DRIVER='deterministic': the scripted fixture double is wired (NOT a real browser — the report says so)", () => {
    process.env.BROWSER_DRIVER = 'deterministic';
    const report = ensureBrowserDriverWired();
    expect(report).toMatchObject({ driver: 'deterministic', state: 'wired' });
    expect(report.detail).toContain('NOT a real browser');
    // The double's own scripting surface proves which driver was wired.
    const wired = getBrowserDriver() as unknown as { seedPage: unknown };
    expect(typeof wired.seedPage).toBe('function');
  });

  it("an unknown BROWSER_DRIVER value wires NOTHING and says so (never a guessed driver)", () => {
    process.env.BROWSER_DRIVER = 'puppeteer';
    const report = ensureBrowserDriverWired();
    expect(report).toMatchObject({ driver: 'none', state: 'unwired' });
    expect(report.detail).toContain("BROWSER_DRIVER='puppeteer' is not a known driver");
    expect(getBrowserDriver()).toBeNull();
  });

  it('an EXPLICIT setBrowserDriver always takes precedence over environment wiring (test overrides honored)', () => {
    const explicit = createScriptedBrowserDriver();
    setBrowserDriver(explicit);
    process.env.BROWSER_DRIVER = 'playwright';
    const report = ensureBrowserDriverWired();
    expect(report).toMatchObject({ driver: 'explicit', state: 'wired' });
    expect(report.detail).toContain('takes precedence');
    expect(getBrowserDriver()).toBe(explicit);
  });

  it('idempotent per process: a second call returns the same report and never rewires', () => {
    process.env.BROWSER_DRIVER = 'playwright';
    const first = ensureBrowserDriverWired();
    const wiredFirst = getBrowserDriver();
    process.env.BROWSER_DRIVER = 'deterministic'; // even a change of env does not rewire
    const second = ensureBrowserDriverWired();
    expect(second).toBe(first);
    expect(getBrowserDriver()).toBe(wiredFirst);
  });

  it('reset clears the memo AND the wired driver (tests and process shutdown)', () => {
    process.env.BROWSER_DRIVER = 'playwright';
    ensureBrowserDriverWired();
    expect(getBrowserDriver()).not.toBeNull();
    resetBrowserDriverWiring();
    expect(getBrowserDriver()).toBeNull();
    clearWiringEnv();
    const report = ensureBrowserDriverWired();
    expect(report).toMatchObject({ driver: 'none', state: 'unwired' });
  });

  it('the real adapter is constructible directly from configuration too (the cellular config-factory precedent)', () => {
    const driver = createPlaywrightBrowserDriver();
    expect(typeof driver.startSession).toBe('function');
    // Constructing from defaults never touches the engine.
    expect(driver.engineVersion()).toBe('not-launched');
  });
});
