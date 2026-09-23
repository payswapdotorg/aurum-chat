// W079 — J09 · AI/BYOA (desktop 1280×800).
//
// The mandatory proof (contract §5): unavailable capability/model →
// provider configuration → usable route → return to task. The real
// production flow: the chat answer's honest note ("For open-ended
// conversation, connect an AI provider in Connections; both modes stay
// evidence-backed") is the contextual prompt, the AI surface (the
// provider registry) carries the BYOA registration form, a provider
// account is registered with an opaque credential reference, the routing
// panel reflects the usable route, and the journey returns to the task
// in Chat.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';

const OPEN_QUESTION = 'Where do we stand overall?';

test.describe('J09 — AI/BYOA (desktop)', () => {
  test('J09 — an unavailable provider becomes a configured, usable route and the task resumes', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and hit the unavailable-capability prompt');
    await signInRunManager(page);
    await page.locator('#aurum-chat-input').fill(OPEN_QUESTION);
    await page.locator('#aurum-chat-input').press('Enter');
    const reply = page
      .locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`)
      .filter({ hasText: /company stands|connect an AI provider/i })
      .first();
    await expect(reply).toBeVisible({ timeout: 90_000 });
    // The honest degradation note IS the contextual prompt: the LLM
    // gateway is not wired, and the answer says where to change that.
    await expect(reply.getByText(/connect an AI provider/i)).toBeVisible();
    await cert.shot('the honest answer — the provider prompt');

    await cert.step('open the AI provider surface');
    await page.locator(RAIL).getByRole('link', { name: 'More' }).click();
    await page.waitForURL(/\/more/);
    await page
      .locator('.aurum-hub-card')
      .filter({ hasText: 'Add your own AI provider' })
      .first()
      .click();
    await page.waitForURL(/\/ai/);
    await expect(page.getByRole('heading', { name: /AI/i }).first()).toBeVisible();
    // The registry catalog renders with its providers.
    await expect(page.getByText(/No AI provider accounts yet/i).first()).toBeVisible();
    await cert.shot('the AI surface — no accounts yet (the unavailable state)');

    await cert.step('register a provider account through the BYOA form');
    await page.getByText('Add an AI provider account (BYOA)').click();
    const form = page.locator('form').filter({ hasText: 'Account label' }).first();
    await form.locator('input[name="label"]').fill('Certification workspace key');
    await form.locator('input[name="credentialRef"]').fill('secret-store://w079/cert/llm');
    await form.getByRole('button', { name: /register|add|create/i }).click();
    await expect(page.getByText(/registered|added|stored/i).first()).toBeVisible({
      timeout: 60_000,
    });
    await cert.shot('the registered BYOA account — opaque reference only');

    await cert.step('the usable route is reflected in routing and policy');
    await page.reload();
    await expect(
      page.getByText('Certification workspace key').first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Routing & policy/i).first()).toBeVisible();
    await cert.shot('the routing panel — the usable route');

    await cert.step('return to the task in Chat (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await page.locator('#aurum-chat-input').fill('What changed?');
    await page.locator('#aurum-chat-input').press('Enter');
    const second = page
      .locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`)
      .filter({ hasText: /observation/i })
      .last();
    await expect(second).toBeVisible({ timeout: 90_000 });
    await cert.shot('back to the task — the answer still evidence-backed');
    cert.expectZeroViolations();
  });
});
