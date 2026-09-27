// W106 — J22 · Specialist execution (desktop 1280×800).
//
// The mandatory proof (the W101 matrix, unchanged): the marketplace +
// installed-kit surfaces — the W092 vertical kits' user-visible path.
//
// PRODUCTION REALITY at the certified revision (W105 live): the vertical
// starter kits OWN their user-visible marketplace path. The public
// catalog carries the dedicated kits section (both signed starter kits
// with their state pills and manifest digests); the command search
// offers the kits destination by task language; the kit detail page
// renders the signed version manifest, the required-capability
// inspection, the deterministic verification posture, the honestly
// 'defined' starter components, and the install/lifecycle state; and
// the governed lifecycle is driven through the REAL forms — register
// the shipped version, record a verification run, install the verified
// version — landing at the pending human grant review. The
// approval-authority dimension is proven honestly: the requesting
// manager's own review decision is REFUSED by separation of duties (the
// authority gate holds even for the administrator who installed). The
// marketplace's governed package surfaces (catalog, honest not-found,
// installed extensions, developer publish path) remain proven as
// before; the unknown kit key answers with the honest not-found page.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectPageShellA11y } from './a11y';

test.describe('J22 — specialist execution (desktop)', () => {
  test('J22 — the marketplace surfaces and the vertical-kit lifecycle are proven through the real forms', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and discover the marketplace from the More hub');
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

    await cert.step('the marketplace page carries the shell accessibility contract');
    await expectPageShellA11y(page, 'the marketplace');

    await cert.step('the public catalog renders its live, governed state');
    await expect(page.getByText(/Live catalog/i).first()).toBeVisible();
    await expect(
      page.getByText(/verification|platform review/i).first(),
    ).toBeVisible();
    await cert.shot('the public catalog — the governed listing state');

    await cert.step('the catalog’s vertical starter kits section lists both signed kits');
    await expect(page.getByRole('heading', { name: 'Vertical starter kits' }).first()).toBeVisible();
    await expect(page.getByText('Legal & Case Management Starter Kit').first()).toBeVisible();
    await expect(page.getByText('Accounting & Ledger ERP Starter Kit').first()).toBeVisible();
    await expect(page.getByText('legal-case-management').first()).toBeVisible();
    await expect(page.getByText('accounting-ledger-erp').first()).toBeVisible();
    await cert.shot('the kits section — both signed starter kits listed');

    await cert.step('the command search offers the kits destination by task language');
    await page.locator(RAIL).getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByLabel('Search commands');
    await input.fill('starter kit');
    await expect(
      dialog.locator('[role="option"]').filter({ hasText: 'Explore vertical starter kits' }),
      'the kits command is offered by task language',
    ).toBeVisible();
    await cert.shot('command search — the vertical starter kits destination');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await cert.step('an unknown package answers with the honest not-found page');
    // A well-formed (uuid) but nonexistent package id — the honest
    // not-found state; a malformed id would render the different honest
    // "Read failed" error state (input validation), not not-found.
    await page.goto('/marketplace/package/00000000-0000-0000-0000-000000000000');
    await expect(page.getByText(/Package not found/i).first()).toBeVisible();
    await expect(page.getByText(/Nothing to show/i).first()).toBeVisible();
    await cert.shot('the package page — the honest not-found');

    await cert.step('the kit detail page renders the signed manifest and the governed lifecycle');
    await page.goto('/marketplace/kit/legal-case-management');
    await expect(
      page.getByRole('heading', { name: 'Legal & Case Management Starter Kit' }).first(),
    ).toBeVisible();
    await expect(page.getByText('Vertical starter kit').first()).toBeVisible();
    await expect(page.getByText('legal-case-management').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The signed version manifest' }).first()).toBeVisible();
    await expect(page.getByText(/manifest digest/i).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Required capabilities' }).first()).toBeVisible();
    await expect(page.getByText('read.case-matters').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Starter components' }).first()).toBeVisible();
    await expect(page.getByText('Matter intake form').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verification' }).first()).toBeVisible();
    await expect(page.getByText('Shipped checks pass').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Install & lifecycle' }).first()).toBeVisible();
    await expect(page.getByText('Not installed').first()).toBeVisible();
    await cert.shot('the kit detail page — the signed manifest and the lifecycle state');

    await cert.step('the kit detail page carries the shell accessibility contract');
    await expectPageShellA11y(page, 'the kit detail page');

    await cert.step('register the shipped version through the real form');
    await page.getByRole('button', { name: /Register v1\.0\.0 in your registry/i }).click();
    // The tenant registry records the shipped version (the server state
    // after the form's refresh — the durable signal, never the transient
    // form note).
    await expect(page.getByText('Your registry').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/v1\.0\.0 — unverified/).first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('No version of this kit is registered in your registry yet'),
      'the honest empty-registry note is gone',
    ).toHaveCount(0);
    await cert.shot('the kit registered — the shipped version frozen in the tenant registry');

    await cert.step('record a verification run through the real form');
    await page.getByRole('button', { name: 'Record a verification run' }).click();
    await expect(
      page.getByText('Latest recorded run (your registry)').first(),
      'the append-only verification run is recorded',
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Run recorded/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/v1\.0\.0 — verified/).first()).toBeVisible({ timeout: 30_000 });
    await cert.shot('the kit verified — the recorded run over the stored bytes');

    await cert.step('install the verified version through the real form (the confirmation-gated move)');
    // The consequential-action confirmation must be acknowledged through
    // its real checkbox before the submit unlocks.
    const confirm = page.locator('.aurum-mkt-confirm').first();
    await expect(confirm).toBeVisible();
    await confirm.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Install the verified version' }).first().click();
    await expect(
      page.getByText('The grant review is waiting for a human decision.').first(),
      'the install lands at the pending human grant review',
    ).toBeVisible({ timeout: 60_000 });
    await cert.shot('the kit installed — the state below is live');

    await cert.step('the grant review waits for a human decision (the authority gate)');
    await expect(page.getByText('Pending grant review').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Decide it in Approvals/i }).first()).toBeVisible();
    await cert.shot('the pending grant review — the human authority gate');

    await cert.step('the requesting manager’s own decision is refused by separation of duties');
    // The run manager holds actions:approve — the refusal proves the
    // authority gate’s separation of duties on the kit grant review.
    await expect(
      page.getByText(/separation of duties: the principal who requested this install never decides its own grant review/i).first(),
      'the self-approval path is honestly refused',
    ).toBeVisible();
    await cert.shot('the separation-of-duties refusal — the honest authority gate');

    await cert.step('the installed surface carries the kit installation and its lifecycle');
    await page.goto('/marketplace/installed');
    await expect(page.getByRole('heading', { name: /installed/i }).first()).toBeVisible();
    await expect(page.getByText(/1 kit installation/i).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /legal-case-management/i }).first()).toBeVisible();
    await expect(page.getByText('Pending grant review').first()).toBeVisible();
    await cert.shot('the installed surface — the kit installation under governance');

    await cert.step('an unknown extension governs honestly (no dead-end governance)');
    await page.goto('/marketplace/installed/w106-no-such-extension');
    await expect(page.getByText(/Extension not found|Nothing to govern/i).first()).toBeVisible();
    await cert.shot('the installed-extension governance — the honest not-found');
    // The lifecycle / recorded-transitions / current-deployment / rollback
    // governance panels render for INSTALLED extensions; the production
    // registry is empty (nothing has been published — the platform review
    // claim is honestly gated), so the extension governance vocabulary is
    // proven by the marketplace module's committed tests (G2 evidence)
    // while the KIT lifecycle above is proven live.

    await cert.step('an unknown kit key answers with the honest not-found page');
    await page.goto('/marketplace/kit/w106-no-such-kit');
    await expect(page.getByText(/Kit not found/i).first()).toBeVisible();
    await expect(page.getByText(/Nothing to show/i).first()).toBeVisible();
    await cert.shot('the kit page — the honest not-found');

    await cert.step('the developer surface renders the publish path with its claim gate');
    await page.goto('/marketplace/developer');
    await expect(page.getByRole('heading', { name: /Developer|Builder/i }).first()).toBeVisible();
    await expect(page.getByText(/Platform review queue/i).first()).toBeVisible();
    await expect(
      page.getByText(/extensions:administer|marketplace:administer/i).first(),
      'the publish path documents its authority claims',
    ).toBeVisible();
    await cert.shot('the developer surface — the governed publish path');

    await cert.step('return to the conversation (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
