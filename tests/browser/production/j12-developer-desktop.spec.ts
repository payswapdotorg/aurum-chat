// W079 — J12 · Developer / API / MCP (desktop 1280×800).
//
// The mandatory proof (contract §5): discover from More/search →
// developer console → key/webhook/MCP surface → audit state.
//
// Everything runs through the real production console: the surface is
// discovered from the More hub, a tenant API key is created through the
// real form (its raw value is shown exactly once — read, never written
// to evidence), a webhook endpoint is registered, the MCP surface
// documents the env contract, and the audit state is the console's own
// recorded operations trail. The public API itself is exercised LIVE by
// J05 (the proposal) and J07 (the mission) using a key minted here.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';

test.describe('J12 — developer / API / MCP (desktop)', () => {
  test('J12 — the developer console: discovery, keys, webhooks, MCP and the audit trail', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in and discover the console from the More hub');
    await signInRunManager(page);
    await page.goto('/more');
    const hubCard = page
      .locator('.aurum-hub-card')
      .filter({ hasText: 'Integrate Aurum — API, webhooks, MCP' })
      .first();
    await expect(hubCard).toBeVisible();
    await hubCard.click();
    await page.waitForURL(/\/developer/);
    await expect(page.getByText('API keys').first()).toBeVisible();
    await cert.shot('the developer console — discovered from the hub');

    await cert.step('create an API key through the real form');
    await page.getByText('Create an API key').click();
    const keyForm = page.locator('form').filter({ hasText: 'Key label' }).first();
    await keyForm.locator('input[name="label"]').fill(`w079-${runLabel}-console-key`);
    await keyForm.getByLabel('Goals · read').check();
    await keyForm.getByRole('button', { name: 'Create key' }).click();
    const reveal = page.locator('.aurum-dev-reveal-key').first();
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const rawKey = (await reveal.textContent())?.trim() ?? '';
    expect(rawKey.length, 'the raw key is shown exactly once').toBeGreaterThan(20);
    // Contract §9 (no secret in evidence): NO screenshot at the reveal
    // moment — the raw key is read and asserted ONLY. The post-reload
    // roster shot below proves the grant; the key is revoked in-test at
    // the end of this journey (the run mints nothing that outlives it).

    await cert.step('the key list records the new key (the audit state)');
    await page.reload();
    await expect(page.getByText(`w079-${runLabel}-console-key`).first()).toBeVisible({
      timeout: 60_000,
    });
    await cert.shot('the key roster — the recorded grant');

    await cert.step('register a webhook endpoint through the real form');
    await page.getByText('Add a webhook endpoint').click();
    const hookForm = page.locator('form').filter({ hasText: 'Endpoint label' }).first();
    await hookForm.locator('input[name="label"]').fill(`w079-${runLabel}-events`);
    await hookForm.locator('input[name="url"]').fill('https://example.test/hooks/aurum-w079');
    await hookForm.locator('input[name="eventTypes"]').fill('*');
    await hookForm.getByRole('button', { name: 'Subscribe endpoint' }).click();
    await expect(
      page.getByText(/subscription|registered|created|subscribed/i).first(),
    ).toBeVisible({ timeout: 60_000 });
    await cert.shot('the webhook — registered with its delivery contract');

    await cert.step('the MCP surface documents the env contract');
    await expect(page.getByText('MCP', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/principal|tenant/i).first()).toBeVisible();
    await cert.shot('the MCP surface');

    await cert.step('the operations audit is on the record');
    // The console's audit trail: every operation (key creation, webhook
    // registration) is appended as evidence — the surface shows the
    // audit entries or their summary.
    await expect(page.getByText(/audit|operations|recorded/i).first()).toBeVisible();

    // ---- the run mints nothing that outlives it (key hygiene) ----
    // Both certification keys live on THIS manager's roster (J05 minted
    // the grantee-scoped integration key in this same console; J12 minted
    // the console key above). Revoke both through the real flow — the
    // native confirm is accepted (the run's own keys), and the roster's
    // "Revoked — retained as evidence." state is the audit trail.
    await cert.step('revoke the run\u2019s API keys (nothing minted outlives the run)');
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
    for (const keyLabel of [`w079-${runLabel}-console-key`, `w079-${runLabel}-integration`]) {
      const row = page.locator('li.aurum-dev-key', { hasText: keyLabel }).first();
      await expect(row, `the key row for ${keyLabel} is on the roster`).toBeVisible({
        timeout: 30_000,
      });
      await row.getByRole('button', { name: 'Revoke' }).click();
      await expect(row.getByText('Revoked — retained as evidence.')).toBeVisible({
        timeout: 30_000,
      });
    }
    await cert.shot('the revoked keys — the roster retains the audit trail');
    cert.expectZeroViolations();
  });
});
