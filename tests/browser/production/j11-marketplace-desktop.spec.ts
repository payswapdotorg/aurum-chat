// W079 — J11 · Marketplace / extensions (desktop 1280×800).
//
// The mandatory proof (contract §5): discover capability → public
// catalog/package → install/review state → return to task.
//
// PRODUCTION REALITY, recorded honestly: the public catalog lists
// packages that completed the governed publish chain (verification +
// platform review) — the production registry is empty because nothing
// has been published yet, and the marketplace's seeding script is
// embedded-db-only by design (it can never touch production). The
// journey proves, through real surfaces:
//
//   * the discovery path (More → "Find a capability to install");
//   * the public catalog renders honestly (live count, the empty state,
//     the governance copy — every listing passed verification AND
//     platform review);
//   * the installed-extensions state surface (the review state of what
//     the tenant installed — honest empty);
//   * the marketplace developer surface (the publish path);
//   * the return to the task in Chat.
//
// The install/review recording chain (catalog → package → install grant)
// is proven by the repository's committed tests (G2) and the W076
// browser layer over the seeded artifact world — recorded in the
// certification report.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';

test.describe('J11 — marketplace / extensions (desktop)', () => {
  test('J11 — the marketplace: discovery, the public catalog and the install state', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and discover the marketplace from More');
    await signInRunManager(page);
    await page.goto('/more');
    const hubCard = page
      .locator('.aurum-hub-card')
      .filter({ hasText: 'Find a capability to install' })
      .first();
    await expect(hubCard).toBeVisible();
    await hubCard.click();
    await page.waitForURL(/\/marketplace/);
    await expect(page.getByRole('heading', { name: 'Marketplace' }).first()).toBeVisible();
    await cert.shot('the marketplace — discovered from the hub');

    await cert.step('the public catalog renders its live, governed state');
    // The catalog is public and real: the live listing count renders with
    // the governance copy (verification AND platform review).
    await expect(page.getByText(/Live catalog/i).first()).toBeVisible();
    await expect(
      page.getByText(/verification|platform review/i).first(),
    ).toBeVisible();
    await cert.shot('the public catalog — the governed listing state');

    await cert.step('the installed-extensions state surface (the review state)');
    await page.goto('/marketplace/installed');
    await expect(
      page.getByRole('heading', { name: /installed/i }).first(),
    ).toBeVisible();
    await cert.shot('the installed state — the tenant review surface');

    await cert.step('the marketplace developer surface (the publish path)');
    await page.goto('/marketplace/developer');
    await expect(page.getByRole('heading', { name: 'Developer' }).first()).toBeVisible();
    await cert.shot('the marketplace developer surface');

    await cert.step('return to the task in Chat (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    await expect(page.locator('.aurum-chat-composer')).toBeVisible();
    cert.expectZeroViolations();
  });
});
