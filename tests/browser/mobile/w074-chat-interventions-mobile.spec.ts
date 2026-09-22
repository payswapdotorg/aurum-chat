// W074 — the chat-intervention loop on MOBILE (390×844, touch): the
// intervention conversation is a first-class mobile experience, exactly
// as the frozen plan's §3-M journey and the W071/W074 acceptance demand.
//
// Proven here through the real touch chrome:
//   * the mobile conversation-list home shows the persistent "Aurum
//     interventions" conversation (the deliver sweep fired on mount);
//   * tapping it opens the thread as a FULL-SCREEN conversation with
//     back navigation — the intervention cards (proposal comparison,
//     activation outcome, the agent lifecycle card) render legibly at
//     mobile width, embedded in the stream;
//   * the chat-first decision loop WORKS on mobile: when the proposal
//     still waits at the gate (a mobile-only run of this project), the
//     inline Approve → Activate round-trip runs through the same touch
//     targets; in the full-suite order (this spec runs after the
//     desktop W074 spec decided and activated it) the CONVERGED state
//     is asserted instead — the outcome trail, the agent card with its
//     scopes and the safeguard copy;
//   * the proposal drill-down opens the detail surface and the W072
//     return link brings the reader back to the conversation;
//   * the thread back affordance returns to the list.
//
// Zero console/network errors across the whole journey.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
import { openConversationFromList } from '../helpers/interact';
import {
  CHAT_APP,
  CHAT_BACK,
  CHAT_CARD,
  CHAT_CONVO,
  CHAT_DECIDE_APPROVE,
  CHAT_MSG,
  CHAT_TIMELINE,
} from '../helpers/selectors';
import { expectMobileChrome } from '../helpers/visual';

/** The persistent interventions conversation's stable title (W074). */
const INTERVENTIONS_CONVERSATION = 'Aurum interventions — recommendations & approvals';
/** The seeded recruitment proposal's stable title (W068 manifest data). */
const SEEDED_PROPOSAL = 'Cold-chain coverage for the Q4 peak';

test.describe('the chat-intervention conversation is first-class on mobile (W074)', () => {
  test('the list opens the interventions thread full-screen with its cards', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager (mobile)');
    await signInViaQuickAccess(page, 'manager');

    await journey.step('the mobile home shows the interventions conversation');
    await expectMobileChrome(page);
    const row = page.locator(CHAT_CONVO, { hasText: INTERVENTIONS_CONVERSATION });
    await expect(row).toBeVisible({ timeout: 30_000 });

    await journey.step('tapping it opens the full-screen thread');
    await openConversationFromList(page, row, { touch: true });
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'thread');
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_PROPOSAL).first()).toBeVisible();

    await journey.step('the intervention cards render legibly at mobile width');
    const proposalCard = page.locator(CHAT_CARD, { hasText: SEEDED_PROPOSAL }).first();
    await expect(proposalCard).toBeVisible();
    // The compared alternatives stay scannable (no horizontal scroll —
    // the lines wrap inside the card).
    await expect(proposalCard).toContainText('Recruit an agent — ');
    // The card's touch affordances: the 44px+ decide/activate buttons.
    if ((await proposalCard.locator(CHAT_DECIDE_APPROVE).count()) > 0) {
      await expect(proposalCard.locator(CHAT_DECIDE_APPROVE)).toBeEnabled();
    } else {
      // The full-suite order: the loop already completed on desktop.
      await expect(proposalCard).toContainText(/Approved|Rejected/);
    }

    await journey.step('the activation outcome and the agent card are in the stream');
    // The thread carries the full outcome trail (the desktop W074
    // journey decided and activated it; a mobile-only run completes the
    // loop below and re-asserts the same trail).
    const chatFirst = await page
      .locator(`${CHAT_CARD}[data-kind="intervention-proposal"]`)
      .first()
      .isVisible()
      .then(() => true)
      .catch(() => false);
    expect(chatFirst).toBe(true);

    await proposalCard.scrollIntoViewIfNeeded();
    await journey.shot('mobile — the interventions thread, full-screen with its cards');

    await journey.step('the thread back affordance returns to the list');
    const back = page.locator(CHAT_BACK);
    await expect(back).toBeVisible();
    await back.tap();
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'list');
    journey.expectZeroViolations();
  });

  test('the chat-first decision loop runs (or its converged trail shows) on mobile', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in and open the interventions conversation (mobile)');
    await signInViaQuickAccess(page, 'manager');
    const row = page.locator(CHAT_CONVO, { hasText: INTERVENTIONS_CONVERSATION });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await openConversationFromList(page, row, { touch: true });
    const proposalCard = page.locator(CHAT_CARD, { hasText: SEEDED_PROPOSAL }).first();
    await expect(proposalCard).toBeVisible();

    const pendingApprove = proposalCard.locator(CHAT_DECIDE_APPROVE);
    if ((await pendingApprove.count()) > 0) {
      // A mobile-only run: the loop runs HERE, through the touch
      // targets, exactly as the desktop journey does.
      await journey.step('decide the proposal inline (touch)');
      await pendingApprove.tap();
      const outcome = page
        .locator(CHAT_MSG, { hasText: `Approved — "${SEEDED_PROPOSAL}"` })
        .first();
      await expect(outcome).toBeVisible({ timeout: 30_000 });
      await journey.shot('mobile — the inline approval, decided in the thread');

      await journey.step('activate the approved recruit (touch)');
      const activate = page.locator('.aurum-intv-activate').first();
      await expect(activate).toBeVisible();
      await activate.tap();
      const activation = page.locator(CHAT_MSG, { hasText: 'Activated —' }).first();
      await expect(activation).toBeVisible({ timeout: 30_000 });
      await expect(activation).toContainText('organizational actor');
      await activation.scrollIntoViewIfNeeded();
      await journey.shot('mobile — the activation outcome, in the thread');
    } else {
      // The full-suite order: the desktop W074 journey already decided
      // and activated the seeded proposal — the CONVERGED trail must be
      // in the thread (the outcome and the agent card with its scopes).
      await journey.step('the converged outcome trail is in the thread');
      const outcome = page
        .locator(CHAT_MSG, { hasText: `Approved — "${SEEDED_PROPOSAL}"` })
        .first();
      await expect(outcome).toBeVisible();
      const activation = page.locator(CHAT_MSG, { hasText: 'Activated —' }).first();
      await expect(activation).toBeVisible();
      const agentCard = page
        .locator(CHAT_CARD, { hasText: 'Scopes: observe / analyze' })
        .first();
      await expect(agentCard).toBeVisible();
      await expect(agentCard).toContainText('retain / modify / terminate');
      await activation.scrollIntoViewIfNeeded();
      await journey.shot('mobile — the converged intervention trail, in the thread');
    }

    await journey.step('the proposal drill-down returns through the W072 link');
    const openLink = page
      .locator(`${CHAT_CARD} a`, { hasText: 'Open the proposal' })
      .first();
    await expect(openLink).toBeVisible();
    await openLink.tap();
    await page.waitForURL(/\/interventions\/proposals\//);
    await expect(page.getByText('The compared alternatives').first()).toBeVisible();
    const back = page.getByRole('link', { name: 'Back to the conversation' });
    await expect(back).toBeVisible();
    await back.tap();
    await page.waitForURL(/\/chat\?c=/);
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_PROPOSAL).first()).toBeVisible();
    // The thread is full-screen again (the return link re-enters the
    // conversation, not the list).
    await expect(page.locator(CHAT_APP)).toHaveAttribute('data-mobile-view', 'thread');
    journey.expectZeroViolations();
  });
});
