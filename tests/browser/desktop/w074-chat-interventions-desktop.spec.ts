// W074 — the chat-intervention loop in the REAL browser (desktop
// 1280×800): the post-W076 mandate's coverage gap, closed.
//
// The journey proves the WHOLE conversational intervention chain through
// the UI only (no API shortcuts): the proactive capability-gap
// recommendation arrives in the persistent "Aurum interventions"
// conversation (the deliver sweep the chat workspace fires on mount),
// the proposal card renders its compared alternatives and waits at the
// human gate, the INLINE DECISION is cast from the card's own buttons
// through the real authority-gate round-trip, the outcome message
// returns to the ORIGINATING thread, the ACTIVATION affordance
// registers the agent with exactly the proposed scopes, and the
// drill-down (the proposal detail surface) carries the W072 return link
// back to the exact message — while the Interventions hub shows the
// same governance truth from its own surface.
//
// Everything is discovered through the UI: the conversation row is
// found by title (ids are re-seeded per run), the decision is clicked
// on the card, the activation is clicked where it renders, and the
// return path is the link a human would follow.
//
// File-order note: this spec runs LAST among the desktop specs (w… >
// accessibility/chat/discovery/intelligence/interventions/onboarding/
// tenant-isolation), because it CONSUMES the seeded proposal's pending
// state — the earlier journeys (interventions-desktop's "Waiting for a
// human decision") must observe the world as seeded.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
import { openConversationFromList } from '../helpers/interact';
import {
  CHAT_CARD,
  CHAT_CONVO,
  CHAT_DECIDE_APPROVE,
  CHAT_MSG,
  CHAT_TIMELINE,
} from '../helpers/selectors';

/** The persistent interventions conversation's stable title (W074). */
const INTERVENTIONS_CONVERSATION = 'Aurum interventions — recommendations & approvals';
/** The seeded recruitment proposal's stable title (W068 manifest data). */
const SEEDED_PROPOSAL = 'Cold-chain coverage for the Q4 peak';

test.describe('Journeys E/I — the chat-intervention loop (desktop, W074)', () => {
  test('the proactive recommendation arrives in the thread with the comparison and the human gate', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager');
    await signInViaQuickAccess(page, 'manager');

    await journey.step('the messenger mount fires the interventions sweep');
    // The chat workspace delivers the tenant's awaiting proposals into
    // the persistent interventions conversation on mount — the row
    // appears in the list without the manager ever discovering the
    // Interventions route.
    const row = page.locator(CHAT_CONVO, { hasText: INTERVENTIONS_CONVERSATION });
    await expect(row).toBeVisible({ timeout: 30_000 });

    await journey.step('open the interventions conversation from the list');
    await openConversationFromList(page, row);
    await expect(
      page.locator(CHAT_TIMELINE).getByText(SEEDED_PROPOSAL).first(),
    ).toBeVisible();

    await journey.step('the proposal card waits at the human gate with its comparison');
    const proposalCard = page
      .locator(CHAT_CARD, { hasText: SEEDED_PROPOSAL })
      .first();
    await expect(proposalCard).toBeVisible();
    await expect(proposalCard).toContainText('Needs your decision');
    // The compared alternatives, conversationally legible: the
    // acquisition vocabulary a manager scans (train / recruit / hire).
    await expect(proposalCard).toContainText('Train an employee — ');
    await expect(proposalCard).toContainText('Recruit an agent — ');
    await expect(proposalCard).toContainText('Hire human capability — ');
    await expect(proposalCard).toContainText('recommended');
    // The human-employment safeguard rides the consequential card.
    await expect(proposalCard).toContainText('The human authority gate');
    await expect(proposalCard).toContainText('employment decisions stay human-authorized');

    await journey.step('the capability-gap card and the citations ride the same turn');
    const message = page.locator(CHAT_MSG, { hasText: 'needs your decision' }).last();
    await expect(message).toContainText('cold-chain');
    await expect(proposalCard.locator('a', { hasText: 'Open the proposal' })).toHaveCount(1);
    await expect(proposalCard).toContainText('Why this?');

    await proposalCard.scrollIntoViewIfNeeded();
    await journey.shot('the intervention proposal — the comparison at the human gate');
    journey.expectZeroViolations();
  });

  test('the inline human decision and the activation complete end to end in the thread', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in and open the interventions conversation');
    await signInViaQuickAccess(page, 'manager');
    const row = page.locator(CHAT_CONVO, { hasText: INTERVENTIONS_CONVERSATION });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await openConversationFromList(page, row);
    const proposalCard = page.locator(CHAT_CARD, { hasText: SEEDED_PROPOSAL }).first();
    await expect(proposalCard).toBeVisible();

    await journey.step('approve the proposal with the card button (the authority gate)');
    const approve = proposalCard.locator(CHAT_DECIDE_APPROVE);
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    await approve.click();

    await journey.step('the outcome message returns to the originating thread');
    const outcome = page
      .locator(CHAT_MSG, { hasText: `Approved — "${SEEDED_PROPOSAL}"` })
      .first();
    await expect(outcome).toBeVisible({ timeout: 30_000 });
    await expect(outcome).toContainText('decided it in this thread');
    // The decision is acknowledged in place — the gate is settled, the
    // decision buttons are gone.
    await expect(proposalCard).not.toContainText('Needs your decision');

    await journey.step('the activation affordance registers the agent');
    // The approved comparison carries a recruit alternative — the card
    // now offers the activation (the same thread, no route change).
    const activate = page.locator('.aurum-intv-activate').first();
    await expect(activate).toBeVisible();
    await expect(activate).toBeEnabled();
    await activate.click();

    await journey.step('the activation outcome lands with the agent card');
    const activation = page.locator(CHAT_MSG, { hasText: 'Activated —' }).first();
    await expect(activation).toBeVisible({ timeout: 30_000 });
    await expect(activation).toContainText('organizational actor');
    // The agent card: exactly the scopes the approved comparison
    // proposed, with the retain/modify/terminate lifecycle context.
    const agentCard = page
      .locator(CHAT_CARD, { hasText: 'Scopes: observe / analyze' })
      .first();
    await expect(agentCard).toBeVisible();
    await expect(agentCard).toContainText('retain / modify / terminate');
    await expect(agentCard).toContainText('never autonomously terminates a human employee');

    await activation.scrollIntoViewIfNeeded();
    await journey.shot('the activation — the agent card lands in the thread');
    journey.expectZeroViolations();
  });

  test('the drill-down carries the way back to the exact message (W072 continuity)', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in and open the interventions conversation');
    await signInViaQuickAccess(page, 'manager');
    const row = page.locator(CHAT_CONVO, { hasText: INTERVENTIONS_CONVERSATION });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await openConversationFromList(page, row);

    await journey.step('open the proposal detail from the card');
    // The outcome trail is already in the thread (this spec file runs in
    // order); the proposal card's drill-down opens the detail surface.
    const openLink = page
      .locator(`${CHAT_CARD} a`, { hasText: 'Open the proposal' })
      .first();
    await expect(openLink).toBeVisible();
    await openLink.click();
    await page.waitForURL(/\/interventions\/proposals\//);

    await journey.step('the detail surface shows the same governance truth');
    // The same proposal, decided and activated, seen from the surface
    // that owns the truth — no context loss, no dead end.
    await expect(page.getByText('The compared alternatives').first()).toBeVisible();
    await expect(page.getByText('Approved').first()).toBeVisible();
    await journey.shot('the proposal detail — decided, from the card drill-down');

    await journey.step('return to the conversation through the W072 return link');
    expect(page.url()).toContain('back=');
    const back = page.getByRole('link', { name: 'Back to the conversation' });
    await expect(back).toBeVisible();
    await back.click();
    await page.waitForURL(/\/chat\?c=/);
    // The return link addresses the exact originating message.
    expect(new URL(page.url()).hash).toMatch(/^#m-/);
    await expect(page.locator(CHAT_TIMELINE).getByText(SEEDED_PROPOSAL).first()).toBeVisible();
    journey.expectZeroViolations();
  });

  test('the detailed surfaces carry the same governance truth (hub linkage + tower trail)', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in and open the Interventions hub');
    await signInViaQuickAccess(page, 'manager');
    await page.goto('/interventions');

    await journey.step('the hub links the same recommendations to the thread');
    // The hub's chat linkage: the recommendations also live in the
    // persistent conversation, with the stable /chat?c= return link.
    const chatLink = page.locator('a', { hasText: 'also live in your Aurum chat' });
    await expect(chatLink).toBeVisible();
    await expect(chatLink).toHaveAttribute('href', /\/chat\?c=/);
    await expect(page.getByText(/1 recommendation delivered/)).toBeVisible();
    await expect(page.getByText(/1 decided/)).toBeVisible();
    await expect(page.getByText(/1 activated/)).toBeVisible();

    await journey.step('the proposal row shows the decided state, still deep-linked');
    await expect(page.getByText(SEEDED_PROPOSAL).first()).toBeVisible();
    await page
      .locator('a[href*="/interventions/proposals/"]')
      .first()
      .click();
    await page.waitForURL(/\/interventions\/proposals\//);
    await expect(page.getByText('Approved').first()).toBeVisible();
    await journey.shot('the interventions hub — the decided proposal, chat-linked');

    await journey.step('the tower Approvals surface shows the decision trail');
    await page.goto('/approvals');
    await expect(page.getByText(/agent[ -]recruitment|cold-chain/i).first()).toBeVisible();
    await expect(page.getByText(/approved/i).first()).toBeVisible();
    journey.expectZeroViolations();
  });
});
