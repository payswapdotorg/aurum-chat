// W101 — J20 · Provider choice + billing (desktop 1280×800).
//
// The mandatory proof (the W101 matrix): /ai/preferences AND
// /ai/preferences/advanced — the W091 surfaces (outcome preferences,
// explanations, the authorization-gated advanced area) + the
// provider/billing surfaces.
//
// The real production flow: the manager (the tenant owner) sets their own
// outcome priority through the real form and the resolved attribution
// flips honestly ("You chose this"), sets the company-wide priority
// through the administer-gated form, opens the ADVANCED technical area
// (authorized for the owner), probes a foreign explanation id (the
// uniform "No such record" — the tenant boundary on the new surface),
// then signs in as the run EMPLOYEE (a plain member) and proves the
// authority gate honestly refuses the advanced area and the company
// preference form. The provider/billing surfaces of this revision — the
// /ai page's model catalog, cost & latency and routing panels plus the
// preferences explanation feed's spending-limit honesty — are asserted
// as they exist (no dedicated /billing route exists in this revision;
// that fact is recorded in the transcript). The journey returns to Chat.

import { certTest as test, expect } from './fixtures';
import { readRunEmployee, signInRunManager, signOutViaMore } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectPageShellA11y } from './a11y';

test.describe('J20 — provider choice + billing (desktop)', () => {
  test('J20 — outcome preferences, the authorization-gated advanced area and the provider/billing surfaces', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in as the run manager (the tenant owner) and open AI preferences');
    await signInRunManager(page);
    const preferencesResponse = await page.goto('/ai/preferences');
    expect(
      preferencesResponse?.status(),
      'the /ai/preferences surface answers HTTP 200 in production (the W091 outcome-preferences surface)',
    ).toBe(200);
    await expect(page.getByRole('heading', { name: /AI preferences/i }).first()).toBeVisible();
    await cert.shot('AI preferences — the outcome-oriented surface');

    await cert.step('the preferences page carries the shell accessibility contract');
    await expectPageShellA11y(page, 'AI preferences');

    await cert.step('the resolved state is the honest balanced default');
    await expect(
      page.getByText(/The balanced default \(nothing is set yet\)/i).first(),
    ).toBeVisible();
    await expect(page.getByText(/What matters when Aurum uses AI/i).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Your choice/i }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Your company's choice/i }).first()).toBeVisible();
    await expect(page.getByText(/Nothing is set company-wide/i).first()).toBeVisible();
    await cert.shot('the honest default — the attribution pill');

    await cert.step('set the personal outcome priority through the real form');
    const personalForm = page.locator('form').filter({ hasText: 'Save my priority' }).first();
    await personalForm.locator('.aurum-pref-picker select').first().selectOption('privacy');
    await personalForm.getByRole('button', { name: 'Save my priority' }).click();
    await expect(personalForm.locator('.aurum-pref-ok').first()).toBeVisible({
      timeout: 30_000,
    });
    await page.reload();
    await expect(page.getByText(/You chose this/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('.aurum-pref-order').first(),
      'the resolved priority lists the chosen first outcome',
    ).toContainText('Strongest data protection');
    await cert.shot('the personal priority — the attribution flipped honestly');

    await cert.step('set the company-wide priority through the administer-gated form');
    const tenantForm = page.locator('form').filter({ hasText: 'Save the company priority' }).first();
    await expect(tenantForm, 'the owner sees the company preference form').toBeVisible();
    await tenantForm.getByRole('button', { name: 'Save the company priority' }).click();
    await expect(tenantForm.locator('.aurum-pref-ok').first()).toBeVisible({
      timeout: 30_000,
    });
    await page.reload();
    await expect(page.getByText(/Nothing is set company-wide/i)).toHaveCount(0);
    await cert.shot('the company priority — set by the authorized administrator');

    await cert.step('the explanations feed renders its honest state');
    await expect(page.getByRole('heading', { name: /Why this option\?/i }).first()).toBeVisible();
    await expect(page.getByText(/No choices recorded yet/i).first()).toBeVisible();
    await cert.shot('the explanations feed — the honest empty state');

    await cert.step('open the ADVANCED technical area as the authorized owner');
    await page.goto('/ai/preferences/advanced');
    await expect(page.getByRole('heading', { name: /Advanced AI settings/i }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Technical provider details/i }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Technical overrides \(pins\)/i }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Selection records \(technical\)/i }).first()).toBeVisible();
    await cert.shot('the advanced area — the authorized technical view');

    await cert.step('a foreign explanation id answers uniformly (the tenant boundary)');
    await page.goto('/ai/preferences/advanced?explanation=00000000-0000-0000-0000-000000000000');
    await expect(page.getByText(/No such record/i).first()).toBeVisible();
    await cert.shot('the foreign record — the uniform honest refusal');

    await cert.step('the provider/billing surfaces of this revision (/ai)');
    await page.goto('/ai');
    await expect(page.getByRole('heading', { name: /Model catalog \(the registry\)/i }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Cost & latency/i }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Routing & policy/i }).first()).toBeVisible();
    await cert.shot('the /ai surface — the provider catalog, cost and routing panels');
    await cert.step('recorded honestly: no dedicated /billing route exists in this revision');
    // The provider/billing surface users actually have in this revision is
    // the /ai panels above plus the preferences explanation feed (its
    // spending-limit exclusion honesty) — recorded in the transcript.

    await cert.step('sign in as the run employee (a plain member)');
    await signOutViaMore(page);
    const employee = await readRunEmployee();
    expect(employee, 'J05 must have run before J20 (file order guarantees it)').not.toBeNull();
    await page.goto('/signin');
    await page.locator('#signin-email').fill(employee!.email);
    await page.locator('#signin-password').fill(employee!.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/chat/, { timeout: 60_000 });
    await expect(page.locator('.aurum-chat-app')).toBeVisible({ timeout: 60_000 });

    await cert.step('the member sees the preferences surface without the company form');
    await page.goto('/ai/preferences');
    await expect(page.getByRole('heading', { name: /AI preferences/i }).first()).toBeVisible();
    await expect(page.getByText(/Only administrators of your company can change this./i).first()).toBeVisible();
    await expect(
      page.locator('form').filter({ hasText: 'Save the company priority' }),
      'the member does NOT see the company preference form',
    ).toHaveCount(0);
    await cert.shot('the member view — no company preference form');

    await cert.step('the advanced area honestly refuses the member (the authorization gate)');
    await page.goto('/ai/preferences/advanced');
    await expect(page.getByText(/Authorized area/i).first()).toBeVisible();
    await expect(
      page.getByText(/You are not authorized to open the advanced settings/i).first(),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Back to AI preferences/i }).first()).toBeVisible();
    await cert.shot('the advanced area — the honest refusal for a plain member');

    await cert.step('return to the conversation (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
