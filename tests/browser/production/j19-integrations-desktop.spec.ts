// W101 — J19 · Integrations (desktop 1280×800).
//
// The mandatory proof (the W101 matrix): the full connection surface —
// the connections hub UI (channels, sources, destinations, identities) +
// the integration capabilities; the W096-proven chain's production
// surface. The human approval gate is the /approvals tower surface (the
// authority dimension carried where it applies).
//
// The real production flow: the run tenant's channels (J08's email
// channel + J16's Slack channel) are on the roster, a SOURCE system is
// registered through the real form (the inbound integration family), a
// DESTINATION is registered through the real form (the outbound family),
// the identity & verification family renders with its honest empty state
// and its lookup + person-creation affordances, the hub's session
// envelope carries the tenant id (the tenant-scoping probe), the
// /approvals surface renders the human authority gate, and the journey
// returns to the originating conversation. The accessibility probes ride
// the hub page (the W101 extension's discipline).

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectPageShellA11y } from './a11y';

test.describe('J19 — integrations (desktop)', () => {
  test('J19 — the full connection surface: channels, a source, a destination, identities and the approval gate', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in and open the Connections hub');
    await signInRunManager(page);
    await page.locator(RAIL).getByRole('link', { name: 'Connections' }).click();
    await page.waitForURL(/\/connections/);
    await expect(page.getByRole('heading', { name: /connections/i }).first()).toBeVisible();
    await cert.shot('the Connections hub — the full connection surface');

    await cert.step('the hub page carries the shell accessibility contract');
    await expectPageShellA11y(page, 'the Connections hub');

    await cert.step('the channel family roster shows the run tenant’s channels');
    await expect(page.getByText('Certification workspace').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Cross-channel certification desk').first()).toBeVisible({
      timeout: 30_000,
    });
    await cert.shot('the channels family — the run tenant’s two channels');

    await cert.step('register a source system through the real form');
    await page.locator('summary', { hasText: 'Connect a source system' }).first().click();
    await page.locator('#source-connect-provider').selectOption('notion');
    await page.locator('#source-connect-account').fill(`w101-${runLabel.toLowerCase()}-workspace`);
    await page.locator('#source-connect-name').fill('Certification knowledge base');
    await page.locator('#source-connect-credential').fill('secret-store://w101/cert/notion');
    await page.locator('#source-auth-credentials').check();
    await page.getByRole('button', { name: /Connect Notion/i }).click();
    // The registration lands: the source roster re-renders with the row
    // carrying the provider label + the account id (the roster renders the
    // canonical account id, not the optional display name).
    await expect(page.getByText(`w101-${runLabel.toLowerCase()}-workspace`).first()).toBeVisible({
      timeout: 60_000,
    });
    await cert.shot('the source system — registered with its opaque credential reference');

    await cert.step('the source appears on the source-systems roster');
    await page.reload();
    await expect(page.getByText(`w101-${runLabel.toLowerCase()}-workspace`).first()).toBeVisible({
      timeout: 60_000,
    });
    await cert.shot('the source-systems family — the registered inbound integration');

    await cert.step('register a destination through the real form');
    await page.locator('summary', { hasText: 'Connect a destination' }).first().click();
    await page.locator('#destination-connect-provider').selectOption('webhook');
    await page.locator('#destination-connect-account').fill(`https://example.test/hooks/w101-${runLabel.toLowerCase()}`);
    await page.locator('#destination-connect-name').fill('Certification export sink');
    await page.locator('#destination-connect-credential').fill('secret-store://w101/cert/webhook');
    await page.locator('#destination-auth-credentials').check();
    await page.getByRole('button', { name: /Connect Webhook/i }).click();
    // The registration lands: the destination roster carries the endpoint
    // address (the canonical webhook account id).
    await expect(
      page.getByText(`https://example.test/hooks/w101-${runLabel.toLowerCase()}`).first(),
    ).toBeVisible({ timeout: 60_000 });
    await cert.shot('the destination — registered with its opaque credential reference');

    await cert.step('the destination appears on the destinations roster');
    await page.reload();
    await expect(
      page.getByText(`https://example.test/hooks/w101-${runLabel.toLowerCase()}`).first(),
    ).toBeVisible({ timeout: 60_000 });
    await cert.shot('the destinations family — the registered outbound integration');

    await cert.step('the identity & verification family renders its honest state and affordances');
    await expect(page.getByText(/Identity & verification/i).first()).toBeVisible();
    await expect(page.getByText(/No channel identities yet/i).first()).toBeVisible();
    await expect(page.getByLabel('Look up an identity by provider account')).toBeVisible();
    await page.locator('summary', { hasText: 'Create a person record' }).first().click();
    await expect(page.locator('#person-full-name')).toBeVisible();
    await expect(page.locator('#person-email')).toBeVisible();
    await cert.shot('the identity family — the honest empty state and its affordances');

    await cert.step('an unknown identity lookup answers honestly (no dead end)');
    await page.locator('#identity-lookup-provider').selectOption('email');
    await page.locator('input[name="identity_account"]').fill('no-such-account@aurum-cert.test');
    await page.getByRole('button', { name: 'Look up', exact: true }).click();
    await page.waitForURL(/identity_account=/);
    await expect(page.getByRole('heading', { name: /connections/i }).first()).toBeVisible();
    await expect(page.getByText(/No channel identities yet|no identity|not found/i).first()).toBeVisible();
    await cert.shot('the identity lookup — the honest miss');

    await cert.step('the hub’s session envelope carries the active tenant id');
    const envelope = await page.evaluate(async () => {
      const response = await fetch('/api/connections', { cache: 'no-store' });
      const body = (await response.json()) as { surface?: string; tenantId?: string };
      return { status: response.status, surface: body.surface ?? null, tenantId: body.tenantId ?? null };
    });
    expect(envelope.status).toBe(200);
    expect(envelope.surface).toBe('connections');
    expect(envelope.tenantId, 'the envelope carries the active tenant id').toBeTruthy();

    await cert.step('the /approvals surface renders the human authority gate');
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { name: /approvals/i }).first()).toBeVisible();
    await expect(page.getByText(/Pending requests/i).first()).toBeVisible();
    await expect(page.getByText(/Recently decided/i).first()).toBeVisible();
    await cert.shot('the Approvals surface — the human authority gate the integration chain rides');

    await cert.step('return to the conversation (cross-surface rule)');
    // The /approvals tower surface is management mode — it carries no
    // product rail (the same discipline J05 applies after /approvals:
    // the return is a direct navigation, not a rail click).
    await page.goto('/chat');
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
