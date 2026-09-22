// W076 — the mobile navigation journey in the REAL browser (390×844,
// touch): the five-area bottom navigation carries the product areas with
// active-state treatment, the command search opens from the mobile top
// bar, the More hub stays reachable, and management mode (Today → the
// Control Tower) keeps its own shell. No dead ends; zero console errors.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
import { BOTTOMNAV, HUB_CARD, TOPBAR } from '../helpers/selectors';
import { expectMobileChrome } from '../helpers/visual';

test.describe('Mobile navigation — the five areas and the hub (390×844, touch)', () => {
  test('the bottom navigation carries the five areas with active treatment', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager on the mobile viewport');
    await signInViaQuickAccess(page, 'manager');
    await expectMobileChrome(page);

    await journey.step('the five areas in plan order with short labels');
    const areas = page.locator(`${BOTTOMNAV} ul > li > a`);
    await expect(areas).toHaveCount(5);
    for (const label of ['Chat', 'Today', 'Intel', 'People', 'More']) {
      await expect(
        areas.filter({ hasText: label }).first(),
        `the bottom nav carries “${label}”`,
      ).toBeVisible();
    }
    // Chat is the active area on /chat (aria-current).
    await expect(areas.filter({ hasText: 'Chat' }).first()).toHaveAttribute(
      'aria-current',
      'page',
    );

    await journey.step('navigate to Intelligence through the bottom nav');
    await areas.filter({ hasText: 'Intel' }).first().tap();
    await page.waitForURL(/\/intelligence/);
    await expect(areas.filter({ hasText: 'Intel' }).first()).toHaveAttribute(
      'aria-current',
      'page',
    );
    await journey.shot('mobile — the Intelligence area from the bottom nav');
    journey.expectZeroViolations();
  });

  test('the More hub is reachable on mobile and its cards navigate', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open More from the bottom nav');
    await page.locator(`${BOTTOMNAV} ul > li > a`).filter({ hasText: 'More' }).first().tap();
    await page.waitForURL(/\/more/);
    await expect(
      page.getByRole('heading', { name: 'More', exact: true }),
    ).toBeVisible();
    const cards = page.locator(HUB_CARD);
    expect(await cards.count(), 'the hub stays the full capability index on mobile').toBeGreaterThan(15);

    await journey.step('follow a hub card into a capability surface');
    await cards.filter({ hasText: 'Talk with Aurum' }).first().tap();
    await page.waitForURL(/\/chat/);
    await expect(page.locator('.aurum-chat-app')).toBeVisible();
    journey.expectZeroViolations();
  });

  test('management mode (Today) keeps its own shell on mobile', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open Today — the management-mode area');
    await page.locator(`${BOTTOMNAV} ul > li > a`).filter({ hasText: 'Today' }).first().tap();
    await page.waitForURL(/\/today/);
    // The tower shell renders with its own navigation — the drill-down
    // destination, never the primary mobile navigation.
    await expect(page.locator('.tower-nav')).toBeVisible();
    await expect(page.locator('.tower-nav a[href="/goals"]')).toBeVisible();
    await journey.shot('mobile — management mode (the tower shell)');
    journey.expectZeroViolations();
  });

  test('command search opens from the mobile top bar and closes on Escape', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the command search from the top bar');
    const searchButton = page.locator(TOPBAR).getByRole('button', {
      name: 'Search (command menu)',
    });
    await expect(searchButton).toBeVisible();
    const box = await searchButton.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.height, 'the top-bar search is a 44px+ touch target').toBeGreaterThanOrEqual(44);
    }
    await searchButton.tap();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Search commands')).toBeFocused();

    await journey.step('type a task and Escape back out');
    await dialog.getByLabel('Search commands').fill('goal');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    journey.expectZeroViolations();
  });
});
