// W076 — Journey C (goal → unknown → mission) in the REAL browser on the
// desktop viewport: the intelligence briefing surfaces the seeded goal,
// and the chain is walked through the page's own links, down to the
// mission and back up to the goal — every hop a real navigation with the
// shell intact (no dead ends) and zero console errors.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
import { MAIN, RAIL } from '../helpers/selectors';
import { expectShareNetShell } from '../helpers/visual';

const GOAL_TITLE = 'Keep wholesale delivery freshness above 92%';

test.describe('Journey C — goal → unknown → mission (desktop)', () => {
  test('the intelligence briefing shows the proactive finding and links the chain', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager and open Intelligence');
    await signInViaQuickAccess(page, 'manager');
    await page.goto('/intelligence');
    await expect(page.getByText(GOAL_TITLE).first()).toBeVisible();
    await expect(page.getByText('What Aurum found on its own').first()).toBeVisible();

    await journey.step('the shell stays ShareNet around the briefing');
    await expectShareNetShell(page);
    await expect(page.locator(MAIN)).toBeVisible();
    await expect(page.locator(RAIL)).toBeVisible();
    await journey.shot('the intelligence briefing');

    await journey.step('follow the goal link into the chain');
    // The goal's own row-title link. Precise by href: the mission and
    // finding rows also carry the goal title inside their texts.
    await page
      .locator('a.aurum-intel-row-title[href*="/intelligence/goals/"]', { hasText: GOAL_TITLE })
      .first()
      .click();
    await page.waitForURL(/\/intelligence\/goals\//);
    await expect(page.getByText(GOAL_TITLE).first()).toBeVisible();
    await journey.shot('the goal page — gaps, unknown, mission');
    journey.expectZeroViolations();
  });

  test('the unknown and the mission open through their own links', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the goal page from the briefing');
    await page.goto('/intelligence');
    await page
      .locator('a.aurum-intel-row-title[href*="/intelligence/goals/"]', { hasText: GOAL_TITLE })
      .first()
      .click();
    await page.waitForURL(/\/intelligence\/goals\//);

    await journey.step('open the promoted unknown');
    await page
      .locator('a[href*="/intelligence/unknowns/"]')
      .first()
      .click();
    await page.waitForURL(/\/intelligence\/unknowns\//);
    // The unknown page: why it matters (the consequence line) and the
    // mission that closes it.
    await expect(page.getByText(/consequence/i).first()).toBeVisible();
    await journey.shot('the unknown — consequence and the closing mission');

    await journey.step('open the mission');
    await page
      .locator('a[href*="/intelligence/missions/"]')
      .first()
      .click();
    await page.waitForURL(/\/intelligence\/missions\//);
    await expect(page.getByText(GOAL_TITLE).first()).toBeVisible();
    await journey.shot('the mission — the knowledge objective');

    await journey.step('the chain links upward (no dead end)');
    await expect(
      page.locator('a[href*="/intelligence/goals/"]').first(),
    ).toBeVisible();
    journey.expectZeroViolations();
  });

  test('the employee persona sees the same chain (member-scoped visibility)', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'employee');
    await journey.step('the employee opens the intelligence briefing');
    await page.goto('/intelligence');
    await expect(page.getByText(GOAL_TITLE).first()).toBeVisible();
    await journey.shot('the intelligence briefing (employee)');
    journey.expectZeroViolations();
  });
});
