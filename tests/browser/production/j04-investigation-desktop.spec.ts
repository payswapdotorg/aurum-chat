// W079 — J04 · Risk/opportunity/process investigation (desktop 1280×800).
//
// The mandatory proof (contract §5): finding → detail → evidence/action
// → return to originating conversation. On the run tenant the
// investigation chain is real end to end: the chat answer surfaces its
// findings as evidence citations, the citation drill-down lands on the
// Evidence surface (the immutable observation record — every chat turn
// IS an observation), the detail row carries its provenance (source,
// channel, confidence), and the way back returns to the exact
// originating conversation.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE } from '../helpers/selectors';

const CHANGED_QUESTION = 'What changed?';

test.describe('J04 — risk/opportunity/process investigation (desktop)', () => {
  test('J04 — a finding drills down to its evidence and returns to the conversation', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and ask the investigation question');
    await signInRunManager(page);
    await page.locator('#aurum-chat-input').fill(CHANGED_QUESTION);
    await page.locator('#aurum-chat-input').press('Enter');
    const reply = page
      .locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`)
      .filter({ hasText: /observation/i })
      .first();
    await expect(reply).toBeVisible({ timeout: 90_000 });
    await cert.shot('the answer — the finding with its evidence citations');

    await cert.step('follow the evidence citation to the detail surface');
    const citation = reply.locator('.aurum-chat-citation').first();
    await expect(citation).toBeVisible();
    await citation.click();
    await page.waitForURL(/\/evidence/);
    await expect(page.getByRole('heading', { name: 'Evidence' }).first()).toBeVisible();

    await cert.step('the observation detail carries its provenance');
    // The feed renders the recorded chat observations with source,
    // channel and confidence — the investigation's evidence spine.
    await expect(page.getByText('Observation feed')).toBeVisible();
    await expect(page.getByText('chat.message').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Direct|recorded/i).first()).toBeVisible();
    await cert.shot('the Evidence surface — the observation detail');

    await cert.step('return to the originating conversation (cross-surface rule)');
    // The citation drill-down carries the way back (the back parameter).
    await page.goBack();
    await page.waitForURL(/\/chat/, { timeout: 60_000 });
    await expect(
      page.locator(CHAT_TIMELINE).getByText(CHANGED_QUESTION).first(),
    ).toBeVisible({ timeout: 30_000 });
    cert.expectZeroViolations();
  });
});
