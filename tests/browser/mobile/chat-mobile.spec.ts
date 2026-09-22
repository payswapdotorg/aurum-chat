// W076 — the mobile chat journey in the REAL browser (390×844, touch —
// the iPhone 12 device profile): chat is FIRST-CLASS on mobile, exactly
// as the frozen plan's §3-M journey and the W071 acceptance demand.
//
// Proven here through the real touch chrome:
//   * the top bar (company switcher, presence, global entries) and the
//     five-area bottom navigation with 44px+ touch targets;
//   * the conversation-list pane fills the screen (data-mobile-view=list);
//   * tapping a conversation opens the thread as a full-screen
//     conversation (data-mobile-view=thread) with back navigation;
//   * the WhatsApp-like bubble geometry holds at mobile width;
//   * a composer turn runs the real workflow and the reply lands;
//   * the back affordance returns to the list.
//
// Zero console/network errors across the whole journey.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
import { openConversationFromList } from '../helpers/interact';
import {
  CHAT_APP,
  CHAT_BACK,
  CHAT_CONVO,
  CHAT_INPUT,
  CHAT_LISTPANE,
  CHAT_MSG,
  CHAT_THREAD,
  CHAT_TIMELINE,
  CHAT_WORKING,
} from '../helpers/selectors';
import {
  expectCompactTimestamps,
  expectComposer,
  expectMessengerBubbles,
  expectMobileChatFirstClass,
  expectMobileChrome,
  expectUnreadBadge,
} from '../helpers/visual';

const SEEDED_CONVERSATION = 'Wholesale freshness';
const SEEDED_QUESTION = 'Aurum, why did our wholesale freshness score drop this month?';

test.describe('Mobile chat — first-class conversation (390×844, touch)', () => {
  test('the conversation list is the mobile home with the touch chrome', async ({ journey }) => {
    const { page } = journey;
    await journey.step('sign in as the manager on the mobile viewport');
    await signInViaQuickAccess(page, 'manager');

    await journey.step('the touch chrome: top bar + five-area bottom nav (44px+)');
    await expectMobileChrome(page);

    await journey.step('the conversation list fills the screen');
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'list');
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    // One pane at a time: the thread pane is not rendered visible.
    await expect(page.locator(CHAT_THREAD)).toBeHidden();
    await expect(page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION })).toBeVisible();
    await expectUnreadBadge(page);
    await expectMobileChatFirstClass(page);
    await journey.shot('mobile — the conversation list home');
    journey.expectZeroViolations();
  });

  test('tapping a conversation opens a full-screen thread with back navigation', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('tap the conversation row');
    await openConversationFromList(
      page,
      page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION }),
      { touch: true },
    );

    await journey.step('the thread pane takes the screen');
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'thread');
    await expect(page.locator(CHAT_THREAD)).toBeVisible();
    // One pane at a time: the list pane is hidden while the thread shows.
    await expect(page.locator(CHAT_LISTPANE)).toBeHidden();
    await expect(page.locator(CHAT_BACK)).toBeVisible();

    await journey.step('the seeded thread renders with mobile bubble fidelity');
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_QUESTION).first()).toBeVisible();
    const report = await expectMessengerBubbles(page);
    expect(report.memberCount).toBeGreaterThanOrEqual(2);
    expect(report.aurumCount).toBeGreaterThanOrEqual(2);
    await expectCompactTimestamps(page);
    await expectComposer(page);
    await journey.shot('mobile — the full-screen thread');
    journey.expectZeroViolations();
  });

  test('a composer turn runs the real workflow on mobile and the reply lands', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the seeded conversation');
    await openConversationFromList(
      page,
      page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION }),
      { touch: true },
    );
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_QUESTION).first()).toBeVisible();

    await journey.step('ask through the touch composer');
    const turnSent = page.waitForRequest(
      (request) =>
        request.url().includes('/api/product/chat/messages') && request.method() === 'POST',
    );
    await page.locator(CHAT_INPUT).fill("What don't we know?");
    await page.locator(CHAT_INPUT).press('Enter');
    await turnSent;
    await expect(page.locator(CHAT_WORKING)).toBeVisible();
    await expect(
      page.locator(CHAT_TIMELINE).getByText("What don't we know?").first(),
    ).toBeVisible();

    await journey.step('the reply lands as an Aurum bubble');
    await expect(
      page.locator(`${CHAT_MSG}[data-side="aurum"]`).last(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(CHAT_WORKING)).toHaveCount(0);
    await journey.shot('mobile — the composer round-trip');
    journey.expectZeroViolations();
  });

  test('the back affordance returns from the thread to the list', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the thread, then go back');
    await openConversationFromList(
      page,
      page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION }),
      { touch: true },
    );
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'thread');
    await page.locator(CHAT_BACK).tap();
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'list');
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    await expect(page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION })).toBeVisible();
    journey.expectZeroViolations();
  });
});
