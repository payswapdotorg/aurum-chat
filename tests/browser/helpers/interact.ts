// W076 — hydration-safe interaction helpers.
//
// In the dev runtime, a click delivered after first paint but before
// React hydrates a client component is LOST: no state change, no
// request, no console error (the failing evidence shows exactly that
// signature — zero violations, element untouched). Playwright's
// actionability checks cannot see hydration, so these helpers click,
// then check an OBSERVABLE client-side DOM effect that proves the
// handler engaged, and click once more if it did not. No fixed sleeps —
// the waits are on real state.

import type { Locator, Page } from '@playwright/test';

/** Is the messenger's conversation selection engaged (client-side DOM proof)? */
async function conversationSelectionEngaged(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = document.querySelector('.aurum-chat-app');
    if (app === null) return false;
    // Mobile: opening a conversation takes over the screen
    // (data-mobile-view=thread). Desktop: the selected row carries
    // aria-current (a client-only attribute).
    if (app.getAttribute('data-mobile-view') === 'thread') return true;
    return document.querySelector('.aurum-chat-convo[aria-current="true"]') !== null;
  });
}

/**
 * Open a conversation from the list row. Clicks (desktop) or taps
 * (mobile) the row, verifies the selection engaged, and retries ONCE if
 * the first press was lost to the hydration window. The caller's thread
 * assertions remain the loud gate if both presses fail.
 */
export async function openConversationFromList(
  page: Page,
  row: Locator,
  options: { touch?: boolean } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.touch === true) {
      await row.tap();
    } else {
      await row.click();
    }
    if (await conversationSelectionEngaged(page)) return;
  }
}
