// W076 — Journey J/L + the W075 discovery frame in the REAL browser on
// the desktop viewport: the /more capability hub (grouped by user intent,
// never internal taxonomy), the command search (the shell's task
// language), and the public marketplace catalog — every capability
// reachable without knowing Aurum's module names, with the shell intact
// and zero console errors.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
import { BOTTOMNAV, HUB_CARD, MAIN, RAIL, TOPBAR } from '../helpers/selectors';
import { expectShareNetShell } from '../helpers/visual';

test.describe('Journeys J/L + W075 — discovery through More, search and marketplace (desktop)', () => {
  test('the More hub groups capabilities by user intent, not module names', async ({ journey }) => {
    const { page } = journey;
    await journey.step('sign in as the manager and open More');
    await signInViaQuickAccess(page, 'manager');
    await page.goto('/more');
    await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();

    await journey.step('the intent families render with their capability cards');
    // The intent families of the W075 registry (user-intent headings).
    for (const heading of [
      'Work with Aurum',
      'Stay on top of the company',
      'Connect your systems',
      'Choose the AI Aurum uses',
      'Extend Aurum’s capabilities',
      'Integrate Aurum with your tools',
      'See why Aurum concluded something',
    ]) {
      const family = page
        .getByRole('heading', { name: heading })
        .first();
      await expect(family, `the hub carries the intent family “${heading}”`).toBeVisible();
    }
    // A representative set of capability cards — user-intent labels.
    const cards = page.locator(HUB_CARD);
    expect(await cards.count(), 'the hub is a full capability index').toBeGreaterThan(15);
    await expect(cards.filter({ hasText: 'Talk with Aurum' }).first()).toBeVisible();
    await expect(cards.filter({ hasText: 'Add your own AI provider' }).first()).toBeVisible();
    await expect(cards.filter({ hasText: 'Find a capability to install' }).first()).toBeVisible();

    await journey.step('the shell stays ShareNet around the hub');
    await expectShareNetShell(page);
    await expect(page.locator(MAIN)).toBeVisible();
    await journey.shot('the More hub — the capability index');
    journey.expectZeroViolations();
  });

  test('command search speaks task language and navigates to the destination', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the command search from the rail');
    await page.locator(RAIL).getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();

    await journey.step('type a task and see the matching commands');
    const input = dialog.getByLabel('Search commands');
    await expect(input).toBeVisible();
    await input.fill('connect');
    await expect(dialog.locator('[role="option"]').first()).toBeVisible();
    await journey.shot('command search — task language');

    await journey.step('a no-match query offers task-language suggestions (no dead end)');
    // The W075 prompt registry: when nothing matches, the suggested
    // searches carry real queries — the dialog never dead-ends.
    await input.fill('zz-nothing-matches-this');
    await expect(dialog.getByRole('group', { name: 'Suggested searches' })).toBeVisible();
    const chip = dialog.getByRole('button', { name: /connect/i }).first();
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(dialog.locator('[role="option"]').first()).toBeVisible();

    await journey.step('escape closes the dialog (keyboard discipline)');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    journey.expectZeroViolations();
  });

  test('the marketplace catalog is public and its packages drill down', async ({ journey }) => {
    const { page } = journey;
    await journey.step('browse the public catalog');
    await page.goto('/marketplace');
    await expect(page.getByText('Roast Batch Tracker').first()).toBeVisible();
    await journey.shot('the marketplace catalog');

    await journey.step('open the package page (permissions and governance)');
    await page
      .locator('a[href*="/marketplace/package/"]')
      .filter({ hasText: 'Roast Batch Tracker' })
      .first()
      .click();
    await page.waitForURL(/\/marketplace\/package\//);
    await expect(page.getByText('Roast Batch Tracker').first()).toBeVisible();
    await expect(page.getByText(/permission/i).first()).toBeVisible();
    await journey.shot('the package page — permissions and governance');
    journey.expectZeroViolations();
  });

  test('the developer console is discoverable from More (Journey L)', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'developer');
    await journey.step('open the developer console from the hub');
    await page.goto('/more');
    await page
      .locator(HUB_CARD)
      .filter({ hasText: 'Integrate Aurum — API, webhooks, MCP' })
      .first()
      .click();
    await page.waitForURL(/\/developer/);
    await expect(page.getByText('meridian-ops-integration').first()).toBeVisible();
    await expect(page.getByText('Ops webhook').first()).toBeVisible();
    await expect(page.getByText('MCP', { exact: false }).first()).toBeVisible();
    await journey.shot('the developer console — keys, webhooks, MCP');
    journey.expectZeroViolations();
  });

  test('the mobile chrome exists in the DOM for narrow viewports (desktop-width sanity)', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('the responsive chrome is present in the document');
    // At 1280px the mobile chrome is display:none but still part of the
    // responsive contract; the mobile suite exercises it as the primary
    // navigation at 390px.
    await expect(page.locator(TOPBAR)).toBeAttached();
    await expect(page.locator(BOTTOMNAV)).toBeAttached();
    await expect(page.locator(TOPBAR)).toBeHidden();
    await expect(page.locator(BOTTOMNAV)).toBeHidden();
    journey.expectZeroViolations();
  });
});
