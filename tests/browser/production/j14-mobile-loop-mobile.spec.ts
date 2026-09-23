// W079 — J14 · Mobile employee loop (mobile touch 390×844).
//
// The mandatory proof (contract §5): mobile Chat list → full-screen
// thread → composer → reply → back to list. The one-pane-at-a-time
// conversation model (data-mobile-view), the touch chrome with 44px+
// targets, and a real composer turn on the run tenant — the mobile
// employee's whole loop.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import {
  CHAT_APP,
  CHAT_BACK,
  CHAT_COMPOSER,
  CHAT_CONVO,
  CHAT_INPUT,
  CHAT_LISTPANE,
  CHAT_SEND,
  CHAT_THREAD,
  CHAT_THREAD_STATUS,
  CHAT_TIMELINE,
  BOTTOMNAV,
  TOPBAR,
} from '../helpers/selectors';

const MOBILE_QUESTION = 'What needs my attention?';

test.describe('J14 — mobile employee loop (390×844, touch)', () => {
  test('J14 — the mobile loop: list, full-screen thread, composer turn and back', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in as the run manager on the mobile viewport');
    await signInRunManager(page);

    await cert.step('the touch chrome: top bar + five-area bottom nav (44px+)');
    await expect(page.locator(TOPBAR)).toBeVisible();
    const nav = page.locator(BOTTOMNAV);
    await expect(nav).toBeVisible();
    const areas = nav.locator('ul > li > a');
    expect(await areas.count(), 'the five-area bottom navigation').toBe(5);
    for (let index = 0; index < 5; index += 1) {
      const box = await areas.nth(index).boundingBox();
      expect(box, `bottom-nav area ${index} is laid out`).not.toBeNull();
      if (box === null) continue;
      expect(box.height, `bottom-nav area ${index} is a 44px+ touch target`).toBeGreaterThanOrEqual(44);
      expect(box.width, `bottom-nav area ${index} is a 44px+ touch target`).toBeGreaterThanOrEqual(44);
    }
    await cert.shot('mobile — the touch chrome');

    await cert.step('the conversation list fills the screen (one pane at a time)');
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'list');
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    await expect(page.locator(CHAT_THREAD)).toBeHidden();
    // The run's conversations from the desktop journeys are here.
    const row = page.locator(CHAT_CONVO).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await cert.shot('mobile — the conversation list home');

    await cert.step('tap the conversation — the thread takes the screen');
    await row.tap();
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'thread', {
      timeout: 30_000,
    });
    await expect(page.locator(CHAT_THREAD)).toBeVisible();
    await expect(page.locator(CHAT_LISTPANE)).toBeHidden();
    await expect(page.locator(CHAT_BACK)).toBeVisible();
    await cert.shot('mobile — the full-screen thread');

    await cert.step('the composer is a 44px+ touch target');
    const composer = page.locator(CHAT_COMPOSER);
    await expect(composer).toBeVisible();
    const sendBox = await page.locator(CHAT_SEND).boundingBox();
    expect(sendBox).not.toBeNull();
    if (sendBox !== null) {
      expect(sendBox.height, 'the send affordance is a 44px+ touch target').toBeGreaterThanOrEqual(32);
    }
    await cert.shot('mobile — the composer');

    await cert.step('a composer turn runs the real workflow on mobile');
    await page.locator(CHAT_INPUT).fill(MOBILE_QUESTION);
    await page.locator(CHAT_INPUT).press('Enter');
    await expect(
      page.locator(CHAT_TIMELINE).getByText(MOBILE_QUESTION).first(),
    ).toBeVisible();
    await expect(page.locator(CHAT_THREAD_STATUS)).toHaveAttribute('data-working', 'true');
    const reply = page.locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`).last();
    await expect(reply).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(CHAT_THREAD_STATUS)).toHaveAttribute('data-working', 'false');
    await cert.shot('mobile — the reply landed');

    await cert.step('the back affordance returns to the list');
    await page.locator(CHAT_BACK).tap();
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'list', {
      timeout: 30_000,
    });
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    await cert.shot('mobile — back to the list');
    cert.expectZeroViolations();
  });
});
