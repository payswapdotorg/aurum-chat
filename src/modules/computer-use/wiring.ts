// W110 — the ENV-DRIVEN WIRING of the BrowserDriver port (the W108
// cellular reference pattern, src/infra/cellular.ts: a globalThis-guarded
// lazy computation, ONCE per process — Next compiles route bundles into
// separate module registries, so a module-level memo would diverge per
// registry, the W058 incident).
//
// ENVIRONMENT CONTRACT (documented for the operator; the machine-readable
// wiring report below is the operator-auditable surface — see
// docs/productization-evidence/W110/):
//
//   BROWSER_DRIVER = playwright | deterministic | none
//
//     * 'playwright'    — the REAL browser driver (Playwright/chromium
//                          behind the W093 port; the W110 adapter). Its
//                          own environment block (BROWSER_CREDENTIALS,
//                          BROWSER_ARTIFACT_DIR, BROWSER_PROFILE_DIR,
//                          BROWSER_HEADLESS, BROWSER_ACTION_TIMEOUT_MS)
//                          is documented in adapters/playwright-driver.ts.
//     * 'deterministic' — the repository's deterministic scripted double
//                          (fixture; NO real browser, NO network) — for
//                          local composition and demos ONLY. It is NOT a
//                          production browser: a plan against unseeded
//                          pages observes found:false and cannot verify.
//     * unset / 'none'  — NOTHING is wired (the default): browser tasks
//                          fail explicitly with `driver_unavailable`
//                          rather than faking success (the existing W093
//                          semantics, unchanged — the deterministic
//                          double remains what the test suites wire
//                          explicitly through setBrowserDriver).
//
// PRECEDENCE: an EXPLICIT setBrowserDriver(...) always wins — the wiring
// never clobbers a driver that is already wired (the cellular precedent:
// the frozen single seam keeps precedence over env wiring, so test
// overrides are always honored).
//
// INVOCATION: `ensureBrowserDriverWired()` is idempotent per process. It
// is exported through the module contract for every production entry
// point that starts/resumes browser tasks (the API/worker composition is
// the W112 certification frontier — no production route invokes it yet,
// which is why the default unwired posture stays honest).
//
// HONESTY CONTRACT: an unknown BROWSER_DRIVER value wires NOTHING and
// says so in the report (never a guessed driver, never a faked success).

import { envString } from '@/infra/config';
import { createPlaywrightBrowserDriver } from './adapters/playwright-driver';
import { createScriptedBrowserDriver } from './double';
import { getBrowserDriver, setBrowserDriver } from './service';

/** The selectable browser drivers (plus the explicit-override marker). */
export type BrowserDriverKind = 'playwright' | 'deterministic' | 'none' | 'explicit';

/** The per-process wiring outcome (machine-readable, operator-auditable). */
export interface BrowserDriverWiringReport {
  driver: BrowserDriverKind;
  state: 'wired' | 'unwired';
  detail: string;
}

interface BrowserDriverWiringGlobal {
  __aurumBrowserDriverWiring?: BrowserDriverWiringReport;
}

const wiringGlobal = globalThis as unknown as BrowserDriverWiringGlobal;

/**
 * Wire the configured browser driver ONCE per process (idempotent; the
 * globalThis guard survives Next's per-bundle module registries). Unset
 * or unknown env → nothing wired (honest `driver_unavailable`), never a
 * guessed driver.
 */
export function ensureBrowserDriverWired(): BrowserDriverWiringReport {
  wiringGlobal.__aurumBrowserDriverWiring ??= wireFromEnv();
  return wiringGlobal.__aurumBrowserDriverWiring;
}

/** Reset the wiring (tests and process shutdown). Clears the wired driver. */
export function resetBrowserDriverWiring(): void {
  wiringGlobal.__aurumBrowserDriverWiring = undefined;
  setBrowserDriver(null);
}

function wireFromEnv(): BrowserDriverWiringReport {
  // An explicitly wired driver ALWAYS takes precedence (test overrides
  // honored; the env never clobbers an explicit setBrowserDriver).
  if (getBrowserDriver() !== null) {
    return {
      driver: 'explicit',
      state: 'wired',
      detail:
        'an explicitly wired browser driver (setBrowserDriver) takes precedence over environment wiring — BROWSER_DRIVER was not applied',
    };
  }

  const configured = envString('BROWSER_DRIVER')?.toLowerCase();
  if (configured === undefined || configured === 'none') {
    return {
      driver: 'none',
      state: 'unwired',
      detail:
        'BROWSER_DRIVER unset (or none) — no browser driver is wired; browser tasks fail honestly with driver_unavailable rather than faking success',
    };
  }
  if (configured === 'playwright') {
    setBrowserDriver(createPlaywrightBrowserDriver());
    return {
      driver: 'playwright',
      state: 'wired',
      detail:
        'real Playwright (chromium) browser driver wired behind the W093 port — BROWSER_CREDENTIALS / BROWSER_ARTIFACT_DIR / BROWSER_PROFILE_DIR / BROWSER_HEADLESS / BROWSER_ACTION_TIMEOUT_MS configure it',
    };
  }
  if (configured === 'deterministic') {
    setBrowserDriver(createScriptedBrowserDriver());
    return {
      driver: 'deterministic',
      state: 'wired',
      detail:
        'deterministic scripted browser driver (fixture double) wired — NOT a real browser; local composition and demos only (the test suites keep wiring their own scripted drivers explicitly)',
    };
  }
  return {
    driver: 'none',
    state: 'unwired',
    detail: `BROWSER_DRIVER='${configured}' is not a known driver (playwright | deterministic | none) — nothing wired; browser tasks fail honestly with driver_unavailable`,
  };
}
