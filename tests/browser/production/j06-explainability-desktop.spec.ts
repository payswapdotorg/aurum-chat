// W079 — J06 · Explainability (desktop 1280×800).
//
// The mandatory proof (contract §5): answer/action → Why → evidence/
// provenance → return to exact chat message. The real production loop:
// a composer turn produces an answer, the message-level "Why this
// answer?" affordance opens the causal-chain surface (/explain/
// execution/<id> — input, evidence, beliefs, missions, policy, approval,
// execution, outcome, learning), and the W072 return link lands back on
// the EXACT originating message (the #m-<message> anchor).

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_EXPLAIN, CHAT_TIMELINE } from '../helpers/selectors';

const QUESTION = 'What changed?';

test.describe('J06 — explainability (desktop)', () => {
  test('J06 — the Why drill-down opens the causal chain and returns to the exact message', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and produce a real answer');
    await signInRunManager(page);
    await page.locator('#aurum-chat-input').fill(QUESTION);
    await page.locator('#aurum-chat-input').press('Enter');
    const reply = page
      .locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`)
      .first();
    await expect(reply).toBeVisible({ timeout: 90_000 });
    await cert.shot('the answer — carrying its Why affordance');

    await cert.step('follow the Why-this-answer link');
    const why = page.locator(CHAT_EXPLAIN).first();
    await expect(why).toBeVisible();
    await why.click();
    await page.waitForURL(/\/explain\/execution\//);
    // The causal chain renders: the trigger (the question itself) and
    // the evidence spine.
    await expect(page.getByText(QUESTION).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Evidence|causal/i).first()).toBeVisible();
    await cert.shot('the explainability trace — the full causal chain');

    await cert.step('return to the exact originating message (the back link)');
    // The drill-down carries the way back: the back parameter addresses
    // the exact originating message.
    expect(page.url()).toContain('back=');
    const back = page.getByRole('link', { name: 'Back to the conversation' });
    await expect(back).toBeVisible();
    await back.click();
    await page.waitForURL(/\/chat\?c=/);
    // The return link is a message anchor: the conversation reopens with
    // the fragment addressing the exact originating message.
    expect(new URL(page.url()).hash).toMatch(/^#m-/);
    await expect(page.locator(CHAT_TIMELINE).getByText(QUESTION).first()).toBeVisible();
    await cert.shot('the return — anchored on the exact originating message');
    cert.expectZeroViolations();
  });
});
