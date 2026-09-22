// W076 — the WhatsApp-like core loop in the REAL browser (desktop
// 1280×800): the seeded conversation, the bubble geometry, the composer
// round-trip with its working state, the contextual cards of the W072
// contract embedded in the live stream, the inline approval gate (Journey
// E's chat-first path) and the message-level explainability loop
// (Journey K from inside the conversation).
//
// The journey discovers EVERYTHING through the UI: the conversation is
// opened by clicking its list row (ids are re-seeded per run), the
// question is typed into the composer, the reply is awaited as a live
// bubble, the approval is decided with the card's own buttons, and the
// explainability drill-down is followed by its link.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
import { openConversationFromList } from '../helpers/interact';
import {
  CHAT_BACK,
  CHAT_CARD,
  CHAT_CITATIONS,
  CHAT_COMPOSER,
  CHAT_CONVO,
  CHAT_DECIDE_APPROVE,
  CHAT_EXPLAIN,
  CHAT_INPUT,
  CHAT_LISTPANE,
  CHAT_MSG,
  CHAT_THREAD,
  CHAT_THREAD_STATUS,
  CHAT_TIMELINE,
  CHAT_WORKING,
} from '../helpers/selectors';
import {
  expectCompactTimestamps,
  expectDaySeparator,
  expectMessengerBubbles,
  expectUnreadBadge,
} from '../helpers/visual';

/** The seeded conversation's stable title (W068 manifest data). */
const SEEDED_CONVERSATION = 'Wholesale freshness';
/** June's seeded question — the thread's first member bubble. */
const SEEDED_QUESTION = 'Aurum, why did our wholesale freshness score drop this month?';

test.describe('Journey B — the chat core loop (desktop)', () => {
  test('the conversation list opens the seeded thread with WhatsApp-like fidelity', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager');
    await signInViaQuickAccess(page, 'manager');

    await journey.step('the list shows the conversation with unread treatment');
    const row = page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION });
    await expect(row).toBeVisible();
    await expectUnreadBadge(page);

    await journey.step('open the conversation from the list');
    await row.click();
    // The thread pane takes the conversation (client-side selection).
    await expect(page.locator(CHAT_THREAD).getByText(SEEDED_QUESTION).first()).toBeVisible();

    await journey.step('the bubble geometry: speaker sides, tints, compact timestamps');
    const report = await expectMessengerBubbles(page);
    expect(report.memberCount).toBeGreaterThanOrEqual(2);
    expect(report.aurumCount).toBeGreaterThanOrEqual(2);
    await expectCompactTimestamps(page);
    await expectDaySeparator(page);

    await journey.step('the thread header carries the Aurum identity and quiet status');
    const status = page.locator(CHAT_THREAD_STATUS);
    await expect(status).toBeVisible();
    await expect(status).toContainText('On duty');
    // Delivery/read state on the member's own bubbles (the check glyph).
    await expect(
      page.locator(`${CHAT_MSG}[data-side="member"] .aurum-chat-status`).first(),
    ).toBeVisible();

    await journey.step('the evidence-backed seeded answer is on screen');
    await expect(page.locator(CHAT_TIMELINE).getByText(/Harbor Grocery \(86%\)/).first()).toBeVisible();

    await journey.shot('the seeded thread — bubbles, timestamps, composer');
    journey.expectZeroViolations();
  });

  test('a composer turn runs the real workflow: optimistic bubble → working → cards', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the seeded conversation');
    await openConversationFromList(
      page,
      page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION }),
    );
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_QUESTION).first()).toBeVisible();

    await journey.step('ask the attention question through the composer');
    const composer = page.locator(CHAT_COMPOSER);
    await expect(composer).toBeVisible();
    const turnSent = page.waitForRequest(
      (request) =>
        request.url().includes('/api/product/chat/messages') && request.method() === 'POST',
    );
    await page.locator(CHAT_INPUT).fill('What needs my attention?');
    await page.locator(CHAT_INPUT).press('Enter');

    // The optimistic member bubble renders immediately (right-aligned,
    // pending treatment) and the working indicator runs while the
    // workflow executes. Waiting for the request DISPATCH (not the
    // response) pins the assertion inside the in-flight window, where
    // the working state is contractually on screen.
    await journey.step('the optimistic bubble + the working indicator');
    await turnSent;
    await expect(
      page.locator(CHAT_TIMELINE).getByText('What needs my attention?').first(),
    ).toBeVisible();
    await expect(page.locator(CHAT_WORKING)).toBeVisible();
    await expect(page.locator(CHAT_THREAD_STATUS)).toHaveAttribute('data-working', 'true');

    await journey.step('the reply lands with contextual cards in the stream');
    const replyBubble = page
      .locator(`${CHAT_MSG}[data-side="aurum"]`)
      .filter({ hasText: 'needs your attention' })
      .first();
    await expect(replyBubble).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(CHAT_THREAD_STATUS)).toHaveAttribute('data-working', 'false');
    // The W072 card contract in the live stream: approval cards with the
    // human decision gate, deep-linked into management mode.
    await expect(page.locator(CHAT_CARD).first()).toBeVisible();
    const approvalCard = page.locator(CHAT_CARD, { hasText: 'Employee messaging' }).first();
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard).toContainText('Needs your decision');
    // The citations block: evidence embedded under the answer.
    await expect(page.locator(CHAT_CITATIONS).first()).toBeVisible();
    // The message-level explainability affordance (W072).
    await expect(page.locator(CHAT_EXPLAIN).first()).toBeVisible();

    // Bring the card into the timeline's viewport so the human-review
    // screenshot shows the live-stream card contract in frame.
    await approvalCard.scrollIntoViewIfNeeded();
    await journey.shot('the reply — contextual cards in the live stream');
    journey.expectZeroViolations();
  });

  test('a pending approval is decided inline from the conversation (Journey E, chat-first)', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the conversation and ask for attention');
    await openConversationFromList(
      page,
      page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION }),
    );
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_QUESTION).first()).toBeVisible();
    await page.locator(CHAT_INPUT).fill('What needs my attention?');
    await page.locator(CHAT_INPUT).press('Enter');
    const approvalCard = page.locator(CHAT_CARD, { hasText: 'Employee messaging' }).first();
    await expect(approvalCard).toBeVisible({ timeout: 30_000 });

    await journey.step('approve the employee-messaging request with the card button');
    const approve = approvalCard.locator(CHAT_DECIDE_APPROVE);
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    await approve.click();

    await journey.step('the decision is acknowledged in place');
    await expect(approvalCard).toContainText(/You approved this/i, { timeout: 30_000 });
    await expect(approvalCard.locator(CHAT_DECIDE_APPROVE)).toHaveCount(0);

    await approvalCard.scrollIntoViewIfNeeded();
    await journey.shot('the inline approval — decided inside the thread');
    journey.expectZeroViolations();
  });

  test('the explainability drill-down opens from the message and returns to the thread', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the conversation and ask for attention');
    await openConversationFromList(
      page,
      page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION }),
    );
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_QUESTION).first()).toBeVisible();
    await page.locator(CHAT_INPUT).fill('What needs my attention?');
    await page.locator(CHAT_INPUT).press('Enter');
    await expect(
      page.locator(CHAT_MSG, { hasText: 'needs your attention' }).last(),
    ).toBeVisible({ timeout: 30_000 });

    await journey.step('follow the Why-this-answer link (Journey K from chat)');
    const why = page.locator(CHAT_EXPLAIN).first();
    await expect(why).toBeVisible();
    await why.click();
    await page.waitForURL(/\/explain\/execution\//);
    // The causal chain renders: the trigger (the question itself) and the
    // evidence spine.
    await expect(page.getByText(/What needs my attention/i).first()).toBeVisible();
    await expect(page.getByText('Evidence').first()).toBeVisible();
    await journey.shot('the explainability trace of the chat answer');

    await journey.step('return to the conversation through the W072 return link');
    // The drill-down carries the way back: the back parameter addresses
    // the exact originating message. The link is the canonical return
    // affordance every drill-down surface renders.
    expect(page.url()).toContain('back=');
    const back = page.getByRole('link', { name: 'Back to the conversation' });
    await expect(back).toBeVisible();
    await back.click();
    await page.waitForURL(/\/chat\?c=/);
    // The return link is a message anchor: the conversation reopens with
    // the fragment addressing the exact originating message (client-side
    // navigation carries the fragment in the URL).
    expect(new URL(page.url()).hash).toMatch(/^#m-/);
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_QUESTION).first()).toBeVisible();

    await journey.step('a DIRECT deep-link load lands on the exact message (:target)');
    // Following the same URL as a full navigation (the shared-link path)
    // processes the fragment natively: the anchored message carries the
    // :target treatment — the reader sees exactly where they came back to.
    await page.goto(page.url());
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_QUESTION).first()).toBeVisible();
    await expect(page.locator('.aurum-chat-msg:target')).toBeVisible();
    journey.expectZeroViolations();
  });

  test('new-chat affordance + conversation search filter the list (W071 controls)', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('start a new conversation from the list head');
    const newChat = page.locator('.aurum-chat-newchat');
    await expect(newChat).toBeVisible();
    await newChat.click();
    // The welcome state: the starter grid in the thread pane — the
    // first-run discovery surface, without leaving the messenger.
    await expect(page.locator('.aurum-chat-welcome')).toBeVisible();
    await expect(page.locator('.aurum-starter').first()).toBeVisible();
    await journey.shot('the new-conversation welcome state');

    await journey.step('the search affordance filters the conversation list');
    await page.locator('#aurum-chat-search').fill('nothing-matches-this');
    await expect(
      page.locator('.aurum-chat-listempty', { hasText: /No conversations match/ }),
    ).toBeVisible();
    await page.locator('#aurum-chat-search').fill('Wholesale');
    await expect(page.locator(CHAT_CONVO, { hasText: SEEDED_CONVERSATION })).toBeVisible();
    // The list pane remains the primary pane throughout.
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    // The back affordance exists in the thread header (mobile-first
    // control, hidden on desktop width — present in the DOM).
    await expect(page.locator(CHAT_BACK)).toBeAttached();
    journey.expectZeroViolations();
  });
});
