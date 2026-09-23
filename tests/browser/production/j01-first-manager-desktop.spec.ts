// W079 — J01 · First-time manager (desktop 1280×800).
//
// The mandatory proof (contract §5): anonymous → sign-in → onboarding →
// company → Chat. This journey CREATES the certification run's tenant:
// a fresh visitor registers through the REAL production sign-up flow,
// creates the company through the REAL onboarding form, and lands in the
// messenger — the credentials are recorded in the run's SECRETS scratch
// directory (never the evidence tree) for the other journeys to sign in
// with. The production auth surface is verified honest along the way:
// the quick-access demo panel does not exist here.

import { certTest as test, expect } from './fixtures';
import { mintRunTenant, writeRunTenant } from './helpers';
import { CHAT_COMPOSER, CHAT_INPUT, CHAT_LISTPANE, CHAT_THREAD, SHELL } from '../helpers/selectors';

test.describe('J01 — first-time manager (desktop)', () => {
  test('J01 — anonymous visitor reaches Chat through real sign-up, onboarding and company creation', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('the anonymous root lands on the sign-in surface');
    await page.goto('/');
    await page.waitForURL(/\/signin/);
    expect(page.url(), 'the root carries the way back (next param)').toContain('next=');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    // Production discipline: NO quick-access demo panel (hard release gate 5).
    await expect(page.locator('.aurum-auth-quick')).toHaveCount(0);
    await cert.shot('anonymous entry — the production sign-in surface');

    await cert.step('follow the real "Create an account" entry');
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.waitForURL(/\/signup/);
    await expect(page.getByRole('heading', { name: 'Get started with Aurum' })).toBeVisible();

    await cert.step('register through the real form (name, email, password)');
    const tenant = mintRunTenant(process.env.W079_RUN_LABEL ?? 'A');
    await page.locator('#signup-name').fill(tenant.managerName);
    await page.locator('#signup-email').fill(tenant.managerEmail);
    await page.locator('#signup-password').fill(tenant.managerPassword);
    await page.getByRole('button', { name: 'Create account' }).click();

    await cert.step('the fresh principal lands on onboarding (no company yet)');
    await page.waitForURL(/\/onboarding/, { timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'Welcome to Aurum' })).toBeVisible();
    await cert.shot('onboarding — the workspace setup surface');

    await cert.step('create the company through the real form');
    await page.locator('#company-name').fill(tenant.companyName);
    await page.getByRole('button', { name: 'Create company' }).click();

    await cert.step('the first screen is the messenger (Chat-first)');
    await page.waitForURL(/\/chat/, { timeout: 90_000 });
    await expect(page.locator(SHELL)).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    await expect(page.locator(CHAT_THREAD)).toBeVisible();
    await expect(page.locator(CHAT_COMPOSER)).toBeVisible();
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    // The honest first-run state: the starter discovery surface, no
    // conversations yet, no dead ends.
    await expect(page.locator('.aurum-starter').first()).toBeVisible();
    await expect(page.locator('.aurum-chat-listempty')).toBeVisible();
    await cert.shot('the first screen — the messenger with its starters');

    // Record the run tenant (secrets scratch — never evidence).
    await writeRunTenant(tenant);
    cert.expectZeroViolations();
  });
});
