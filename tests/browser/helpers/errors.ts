// W076 — console / network violation capture for the real-browser journeys.
//
// The work item's acceptance: "no console errors in major journeys". This
// module attaches ONE collector per page that accumulates every violation
// the real browser session produces, so each journey can assert ZERO at
// its end (and the evidence tree records exactly what was seen, filtered
// or not).
//
// THE DOCUMENTED NOISE FILTER (kept as narrow as possible; every entry is
// browser bookkeeping or third-party browser behavior, never an
// application defect):
//   1. favicon 404s — the app deliberately ships no favicon asset, so the
//      browser's automatic /favicon.ico request 404s in the dev runtime
//      and Chromium logs it as a console error + HTTP 404. Third-party
//      asset noise, not app behavior.
//   2. net::ERR_ABORTED request failures — in-flight requests cancelled
//      because the page navigated or closed (Playwright context teardown
//      mid-poll). Cancellation bookkeeping, not a server or app failure;
//      real failures still surface as HTTP >= 400 responses, requestfailed
//      with other error texts, console errors and pageerror events.
//   3. Chromium's PASSWORD-MANAGER style injection on auth forms — the
//      browser's password manager intermittently injects
//      style="caret-color:transparent" into email/password inputs BEFORE
//      React hydrates (a known Chromium behavior — vercel/next.js#47973;
//      the repo's source contains no caret-color anywhere). React's dev
//      hydration warning then fires with that attribute as the only diff.
//      The filter matches ONLY that exact signature (a hydration warning
//      whose diff is the injected caret-color style); every other
//      hydration mismatch still fails the journey.

import type { Page } from '@playwright/test';

/** One captured violation of the zero-error contract. */
export interface Violation {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http';
  /** Human-readable detail (message text, error text, or status line). */
  detail: string;
  /** The URL the violation refers to, when one does. */
  url: string | null;
  /** ISO timestamp of the capture. */
  at: string;
}

/** Is this URL the browser's automatic favicon request (filtered noise)? */
function isFaviconUrl(url: string): boolean {
  try {
    return new URL(url).pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

/** Is this console text the dev favicon 404 log line (filtered noise)? */
function isFaviconConsoleNoise(text: string): boolean {
  return text.includes('favicon') && /404|Failed to load resource/i.test(text);
}

/**
 * Is this console text Chromium's password-manager hydration warning (the
 * injected caret-color style — the ONLY acceptable hydration diff)?
 */
function isPasswordManagerHydrationNoise(text: string): boolean {
  if (!text.includes('A tree hydrated but some attributes')) return false;
  return text.includes('caret-color') || text.includes('caretColor');
}

/**
 * Attach the collectors to a page. Every console error, uncaught page
 * error, failed request and HTTP >= 400 response lands in `sink` unless
 * it matches the documented noise filter above.
 */
export function attachViolationCollectors(page: Page, sink: Violation[]): void {
  const at = (): string => new Date().toISOString();

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (isFaviconConsoleNoise(text)) return;
    if (isPasswordManagerHydrationNoise(text)) return;
    sink.push({ kind: 'console', detail: text, url: page.url(), at: at() });
  });

  page.on('pageerror', (error) => {
    sink.push({ kind: 'pageerror', detail: String(error), url: page.url(), at: at() });
  });

  page.on('requestfailed', (request) => {
    // Filtered: cancellations (see the module header for the rationale).
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
    if (isFaviconUrl(request.url())) return;
    sink.push({
      kind: 'requestfailed',
      detail: `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`,
      url: request.url(),
      at: at(),
    });
  });

  page.on('response', (response) => {
    if (response.status() < 400) return;
    if (isFaviconUrl(response.url())) return;
    sink.push({
      kind: 'http',
      detail: `${response.status()} ${response.statusText()}`,
      url: response.url(),
      at: at(),
    });
  });
}
