// W079 — J13 · Tenant isolation (desktop 1280×800).
//
// The mandatory proof (contract §5): manager tenant activity → sign out
// → second tenant → no first-tenant data visible.
//
// Two REAL production tenants, both created through the real sign-up and
// onboarding flows: the run tenant (with its recorded activity — the
// certification conversations) and a second, freshly created tenant.
// After signing out and entering the second tenant, NO first-tenant
// data may be visible anywhere (the conversation list, the intelligence
// surfaces, the evidence feed) — the tenant boundary is enforced by the
// server on every request (ADR-0001), never by the client hiding state.
// The journey ends by signing back into the first tenant and finding
// the activity intact.

import { certTest as test, expect } from './fixtures';
import {
  mintRunTenant,
  readRunTenant,
  signInManager,
  signInRunManager,
  signOutViaMore,
  signUpManagerAndCompany,
} from './helpers';
import { CHAT_TIMELINE } from '../helpers/selectors';

test.describe('J13 — tenant isolation (desktop)', () => {
  test('J13 — a second tenant sees nothing of the first, and the first keeps its activity', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in as the run manager and record tenant activity');
    await signInRunManager(page);
    // Distinctive activity only the FIRST tenant can ever show.
    const marker = `Isolation marker ${runLabel} ${Date.now().toString(36)}`;
    await page.locator('#aurum-chat-input').fill(`Remember this: ${marker}`);
    await page.locator('#aurum-chat-input').press('Enter');
    await expect(
      page.locator(CHAT_TIMELINE).getByText(`Remember this: ${marker}`).first(),
    ).toBeVisible({ timeout: 90_000 });
    await cert.shot('the first tenant — the recorded activity marker');

    await cert.step('sign out through the real button');
    await signOutViaMore(page);

    await cert.step('create the second tenant through the real flow');
    const second = mintRunTenant(`iso${runLabel}`);
    await signUpManagerAndCompany(page, second);
    await cert.shot('the second tenant — created through the real flow');

    await cert.step('no first-tenant data is visible in the conversation list');
    await page.goto('/chat');
    await expect(page.locator('.aurum-chat-app')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(CHAT_TIMELINE).getByText(marker)).toHaveCount(0);
    await expect(page.getByText(`Remember this:`).first()).toBeHidden();
    // The second tenant's honest state: the empty list, the starters.
    await expect(page.locator('.aurum-chat-listempty').first()).toBeVisible();
    await cert.shot('the second tenant — the empty conversation list');

    await cert.step('no first-tenant data on the intelligence or evidence surfaces');
    await page.goto('/intelligence');
    await expect(page.getByRole('heading', { name: 'Intelligence' }).first()).toBeVisible();
    await expect(page.getByText(marker)).toHaveCount(0);
    await page.goto('/evidence');
    await expect(page.getByRole('heading', { name: 'Evidence' }).first()).toBeVisible();
    await expect(page.getByText(marker)).toHaveCount(0);
    await cert.shot('the second tenant — the isolated surfaces');

    await cert.step('sign out and back into the first tenant — the activity is intact');
    await signOutViaMore(page);
    const tenant = await readRunTenant();
    expect(tenant, 'the run tenant record exists (J01 ran first)').not.toBeNull();
    await signInManager(page, tenant!);

    // Open the recorded conversation from the list (a fresh /chat lands on
    // the welcome state — the thread must be opened like a user would).
    const row = page.locator('.aurum-chat-convo', { hasText: /Remember this/i }).first();
    await expect(row, 'the marker conversation is in the list').toBeVisible({ timeout: 60_000 });
    await row.click();
    await expect(
      page.locator(CHAT_TIMELINE).getByText(`Remember this: ${marker}`).first(),
    ).toBeVisible({ timeout: 90_000 });
    await cert.shot('the first tenant — the activity preserved');
    cert.expectZeroViolations();
  });
});
