// W079 — J02 · Talk to Aurum (desktop 1280×800).
//
// The mandatory proof (contract §5): conversation list → thread →
// compose → working → answer → evidence. The real production chat
// workflow on the run tenant: a starter question goes through the
// composer, the optimistic member bubble renders, the working indicator
// runs while the inline cognition execution pumps, the deterministic
// answer lands with its citations (every answer carries the recorded
// observation of the question itself — "Your question, recorded as
// evidence"), and the conversation persists in the list under its
// derived title.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import {
  CHAT_COMPOSER,
  CHAT_CONVO,
  CHAT_CITATIONS,
  CHAT_EXPLAIN,
  CHAT_INPUT,
  CHAT_MSG,
  CHAT_THREAD_STATUS,
  CHAT_TIMELINE,
  CHAT_WORKING,
} from '../helpers/selectors';

const ATTENTION_QUESTION = 'What needs my attention?';
const WHY_QUESTION = 'Show me why';

test.describe('J02 — talk to Aurum (desktop)', () => {
  test('J02 — a composer turn runs the real workflow: working, answer and evidence', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in as the run manager through the real form');
    await signInRunManager(page);

    await cert.step('the first-run starter surface is the entry point');
    const starter = page.locator('.aurum-starter', { hasText: ATTENTION_QUESTION }).first();
    await expect(starter).toBeVisible();
    await starter.click();
    // The starter pre-fills the composer (the ?q contract's in-place form).
    await expect(page.locator(CHAT_INPUT)).toHaveValue(ATTENTION_QUESTION);

    await cert.step('send the turn through the composer');
    const turnSent = page.waitForRequest(
      (request) =>
        request.url().includes('/api/product/chat/messages') && request.method() === 'POST',
    );
    await page.locator(CHAT_INPUT).press('Enter');
    await turnSent;

    await cert.step('the optimistic member bubble + the working indicator');
    await expect(
      page.locator(CHAT_TIMELINE).getByText(ATTENTION_QUESTION).first(),
    ).toBeVisible();
    await expect(page.locator(CHAT_WORKING)).toBeVisible();
    await expect(page.locator(CHAT_THREAD_STATUS)).toHaveAttribute('data-working', 'true');
    await cert.shot('the working state — the real execution is running');

    await cert.step('the honest answer lands in the thread');
    // A fresh company honestly has nothing waiting: the deterministic
    // answer says so — a real, evidence-scoped reply, not an error.
    const reply = page.locator(`${CHAT_MSG}[data-side="aurum"]`).first();
    await expect(reply).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(CHAT_THREAD_STATUS)).toHaveAttribute('data-working', 'false');
    await expect(page.locator(CHAT_TIMELINE).getByText(/attention/i).last()).toBeVisible();
    await cert.shot('the answer — honest company state, delivered');

    await cert.step('the answer carries its evidence (the citations block)');
    // Every Aurum answer cites the immutable observation the turn itself
    // recorded — the evidence contract holds on a fresh tenant too.
    const citations = page.locator(CHAT_CITATIONS).first();
    await expect(citations).toBeVisible({ timeout: 30_000 });
    await expect(citations.getByText(/recorded as evidence/i)).toBeVisible();
    await expect(page.locator(CHAT_EXPLAIN).first()).toBeVisible();
    await cert.shot('the evidence-backed answer with its citations');

    await cert.step('a second turn — the why question with its evidence spine');
    await page.locator(CHAT_INPUT).fill(WHY_QUESTION);
    await page.locator(CHAT_INPUT).press('Enter');
    const whyReply = page
      .locator(`${CHAT_MSG}[data-side="aurum"]`)
      .filter({ hasText: /evidence behind Aurum/i })
      .first();
    await expect(whyReply).toBeVisible({ timeout: 90_000 });
    await expect(
      page.locator(CHAT_CITATIONS).filter({ hasText: /recorded as evidence/i }).first(),
    ).toBeVisible();

    await cert.step('the conversation persists in the list under its derived title');
    await expect(page.locator(CHAT_CONVO).first()).toBeVisible();
    await expect(page.locator(CHAT_COMPOSER)).toBeVisible();
    cert.expectZeroViolations();
  });
});
