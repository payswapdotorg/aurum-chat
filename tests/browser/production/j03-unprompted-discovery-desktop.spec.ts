// W079 — J03 · Unprompted discovery (desktop 1280×800).
//
// The mandatory proof (contract §5): goal/situation → gap → unknown →
// learning mission. The journey walks Aurum's discovery chain through
// the REAL surfaces on the run tenant: the chat starters pose the goals
// and unknowns questions (the conversational entry), the Intelligence
// hub renders the navigable chain (goal → gap → unknown → mission →
// evidence → belief) with the situation and capability-gap panels, and
// the Learning hub carries the missions/knowledge view. On a fresh
// company every leg renders its HONEST state — the discovery surfaces
// exist, are navigable, and never dead-end — and the journey returns to
// the originating conversation (the cross-surface rule).

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';

const GOALS_QUESTION = 'How are we doing against our goals?';
const UNKNOWNS_QUESTION = "What don't we know?";

test.describe('J03 — unprompted discovery (desktop)', () => {
  test('J03 — the discovery chain: chat starters, the Intelligence hub and the Learning surface', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and pose the goals question through the starter');
    await signInRunManager(page);
    const goalsStarter = page.locator('.aurum-starter', { hasText: GOALS_QUESTION }).first();
    await expect(goalsStarter).toBeVisible();
    await goalsStarter.click();
    await page.locator('#aurum-chat-input').press('Enter');
    await expect(
      page.locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`).first(),
    ).toBeVisible({ timeout: 90_000 });

    await cert.step('pose the unknowns question in the same conversation');
    await page.locator('#aurum-chat-input').fill(UNKNOWNS_QUESTION);
    await page.locator('#aurum-chat-input').press('Enter');
    const unknownsReply = page
      .locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`)
      .filter({ hasText: /open unknown|don’t know|unknowns/i })
      .first();
    await expect(unknownsReply).toBeVisible({ timeout: 90_000 });
    await cert.shot('the discovery questions — asked conversationally');

    await cert.step('open the Intelligence hub from the rail');
    await page.locator(RAIL).getByRole('link', { name: 'Intelligence' }).click();
    await page.waitForURL(/\/intelligence/);
    await expect(page.getByRole('heading', { name: 'Intelligence' }).first()).toBeVisible();

    await cert.step('the chain surface renders the goal → mission navigation');
    // The chain rail names the navigable chain steps.
    await expect(page.getByText('Goals — the chain entries')).toBeVisible();
    await expect(
      page.getByText(/Every active goal is the first step of the navigable chain/i),
    ).toBeVisible();
    // The honest fresh state: no active goals yet — an empty state, not a
    // dead end (the hint tells the manager what a goal does).
    await expect(page.getByText('No active goals')).toBeVisible();
    await cert.shot('the Intelligence hub — the chain surface');

    await cert.step('the situation and capability-gap panels render');
    await expect(page.getByText('Situation and capabilities')).toBeVisible();
    await expect(page.getByText(/open knowledge gaps/i).first()).toBeVisible();
    await expect(page.getByText(/No open unknowns|open unknown/i).first()).toBeVisible();
    // The mission leg of the chain is reachable from this surface.
    await expect(page.getByText('Urgent learning missions')).toBeVisible();

    await cert.step('the Learning hub carries the mission view');
    const learnLink = page
      .locator('a')
      .filter({ hasText: /Learning|mission/i })
      .first();
    await expect(learnLink).toBeVisible();
    await page.goto('/learning');
    await expect(page.getByRole('heading', { name: 'Learning' }).first()).toBeVisible();
    await expect(page.getByText(/mission|knowledge/i).first()).toBeVisible();
    await cert.shot('the Learning hub — missions and company knowledge');

    await cert.step('return to the originating conversation (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    // The discovery questions are preserved — the thread survived the
    // round trip through two management surfaces.
    await expect(
      page.locator(CHAT_TIMELINE).getByText(GOALS_QUESTION).first(),
    ).toBeVisible({ timeout: 30_000 });
    cert.expectZeroViolations();
  });
});
