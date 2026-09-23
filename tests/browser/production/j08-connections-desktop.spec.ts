// W079 — J08 · Company connections (desktop 1280×800).
//
// The mandatory proof (contract §5): Chat/contextual prompt → Connections
// → configure/verify → return to investigation. The real production
// flow: the chat answer's honest note points at connecting channels and
// sources, the Connections hub (reached through the rail) carries the
// channel registration form, a channel endpoint is configured with its
// opaque credential reference (never a credential value), the hub
// verifies and renders the connection with its health state, and the
// journey returns to the originating conversation.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';

const CHANGED_QUESTION = 'What changed?';

test.describe('J08 — company connections (desktop)', () => {
  test('J08 — a contextual prompt leads to Connections, a channel is configured and verified', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and ask the contextual question in Chat');
    await signInRunManager(page);
    await page.locator('#aurum-chat-input').fill(CHANGED_QUESTION);
    await page.locator('#aurum-chat-input').press('Enter');
    const reply = page
      .locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`)
      .filter({ hasText: /channels and sources are connected|observation/i })
      .first();
    await expect(reply).toBeVisible({ timeout: 90_000 });
    await cert.shot('the contextual prompt — connect your systems');

    await cert.step('open the Connections hub from the rail');
    await page.locator(RAIL).getByRole('link', { name: 'Connections' }).click();
    await page.waitForURL(/\/connections/);
    await expect(page.getByRole('heading', { name: /connections/i }).first()).toBeVisible();
    // The hub's honest sections: channels, sources, identity.
    await expect(page.getByText(/Channels/i).first()).toBeVisible();
    await cert.shot('the Connections hub');

    await cert.step('configure a channel endpoint through the real form');
    await page.locator('summary', { hasText: 'Connect a channel' }).first().click();
    // The email channel: the canonical account id is the mailbox address
    // (the provider adapters normalize their own id vocabularies).
    await page.locator('#channel-connect-provider').selectOption('email');
    await page.locator('#channel-connect-account').fill('w079-cert@aurum-cert.test');
    await page.locator('#channel-connect-name').fill('Certification workspace');
    await page.locator('#channel-connect-credential').fill('secret-store://w079/cert/email');
    await page.getByRole('button', { name: /Connect Email/i }).click();
    // The registration lands: the summary line confirms and the roster
    // re-renders with the connected endpoint.
    await expect(page.getByText(/connected|registered|active/i).first()).toBeVisible({
      timeout: 60_000,
    });
    await cert.shot('the configured channel — registered with its opaque credential reference');

    await cert.step('the connection is verified in the hub state');
    await expect(
      page.getByText('Certification workspace').first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(page.getByText('Certification workspace').first()).toBeVisible({
      timeout: 60_000,
    });
    await cert.shot('the verified connection — the hub state after reload');

    await cert.step('return to the investigation (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(
      page.locator(CHAT_TIMELINE).getByText(CHANGED_QUESTION).first(),
    ).toBeVisible({ timeout: 30_000 });
    cert.expectZeroViolations();
  });
});
