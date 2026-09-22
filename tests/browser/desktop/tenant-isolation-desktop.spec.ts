// W076 — authentication and tenant switching in the REAL browser on the
// desktop viewport, with data isolation visible in the UI.
//
// Two seeded personas across two tenants: the manager of Meridian
// Roasters (the demo company) and the platform reviewer of Aurum
// Platform Review (the platform tenant). Both authenticate through the
// real quick-access panel; the manager signs out through the real
// affordance (the More hub's Account section), and the reviewer signs in.
// The isolation is asserted from what the UI actually shows: the
// company switcher's tenant name, the conversation list's contents (and
// its honest empty state), and the intelligence briefing's contents.

import { journeyTest as test, expect } from '../fixtures';
import { personaName, signInViaQuickAccess, signOutViaMoreHub } from '../helpers/personas';
import { CHAT_CONVO, CHAT_LISTPANE } from '../helpers/selectors';

const MERIDIAN = 'Meridian Roasters';
const PLATFORM = 'Aurum Platform Review';
const GOAL_TITLE = 'Keep wholesale delivery freshness above 92%';

/** The company the DESKTOP RAIL switcher shows (the topbar variant is
 * display:none at desktop width — the first DOM match would be hidden). */
async function activeCompanyName(page: import('@playwright/test').Page): Promise<string> {
  const company = page.locator('.aurum-rail .aurum-switcher-company').first();
  await expect(company).toBeVisible();
  return (await company.textContent()) ?? '';
}

test.describe('Authentication and tenant switching — isolation visible in the UI (desktop)', () => {
  test('the manager signs in, sees Meridian data, signs out, and the reviewer sees none of it', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager (Meridian Roasters)');
    await signInViaQuickAccess(page, 'manager');
    expect(await activeCompanyName(page)).toContain(MERIDIAN);
    // Meridian data is visible: the seeded conversation and the goal.
    await expect(page.locator(CHAT_CONVO, { hasText: 'Wholesale freshness' })).toBeVisible();
    await page.goto('/intelligence');
    await expect(page.getByText(GOAL_TITLE).first()).toBeVisible();
    await journey.shot('manager — Meridian data visible');

    await journey.step('sign out through the real affordance (More → Account)');
    await signOutViaMoreHub(page);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    await journey.step('sign in as the platform reviewer (Aurum Platform Review)');
    await signInViaQuickAccess(page, 'platform-reviewer');
    expect(await activeCompanyName(page)).toContain(PLATFORM);

    await journey.step('the conversation list shows NONE of Meridian’s threads');
    // The reviewer’s tenant has no conversations: the honest empty state,
    // and the seeded Meridian conversation is nowhere in the list pane.
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    await expect(page.locator(CHAT_CONVO)).toHaveCount(0);
    await expect(
      page.locator('.aurum-chat-listempty', { hasText: /No conversations yet/ }),
    ).toBeVisible();
    expect(
      await page.locator(CHAT_LISTPANE).textContent(),
      'the Meridian conversation is invisible to the platform tenant',
    ).not.toContain('Wholesale freshness');
    await journey.shot('platform reviewer — an empty conversation list (isolation)');

    await journey.step('the intelligence briefing shows NONE of Meridian’s goals');
    await page.goto('/intelligence');
    const body = await page.locator('main').textContent();
    expect(body, 'the Meridian goal is invisible to the platform tenant').not.toContain(GOAL_TITLE);
    await journey.shot('platform reviewer — the intelligence briefing (isolation)');
    journey.expectZeroViolations();
  });

  test('the quick-access panel served both personas through the real auth flow', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('the panel lists both personas before either signs in');
    await page.goto('/signin');
    for (const role of ['manager', 'platform-reviewer'] as const) {
      await expect(
        page.locator('.aurum-auth-quick-persona', { hasText: personaName(role) }),
      ).toBeVisible();
    }
    journey.expectZeroViolations();
  });
});
