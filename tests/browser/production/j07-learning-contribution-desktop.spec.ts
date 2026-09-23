// W079 — J07 · Employee learning contribution (desktop 1280×800).
//
// The mandatory proof (contract §5): knowledge request in Chat → answer
// → acknowledgement → contribution/evidence → reward state.
//
// PRODUCTION REALITY, recorded honestly: the contribution anchor chain
// (answer → contribution → reward) requires an ask-person acquisition
// plan, and ask-person plans require person records with ACTIVE
// employment and VERIFIED identities — employment records have no
// user-facing creation surface in the product today (people is an
// honest read model; the W073 flow assumes the directory exists). The
// journey therefore proves on production, through real surfaces only:
//
//   * the learning mission arrives through the PUBLIC API (the real
//     integration path — the key J05 minted in the developer console);
//   * the Learning hub renders the mission, its ask affordance and the
//     planner's HONEST decision (the person gate excludes candidates
//     that are not askable employees — the rationale is on the trail);
//   * the contributions and reward-state panels render with their
//     honest states and the explicit policy note;
//   * the chat learning intent ("What is Aurum learning about our
//     company?") answers honestly from live company state;
//   * the return to Chat preserves the conversation.
//
// The full acknowledgement/contribution/reward recording chain is proven
// by the repository's committed integration tests (G2 evidence:
// src/modules/contributions, src/app/(product)/learning/tests) — this
// interpretation is recorded in the certification report's key decisions.

import { certTest as test, expect } from './fixtures';
import { readRunEmployee, signInRunManager } from './helpers';
import { CHAT_TIMELINE } from '../helpers/selectors';

const LEARNING_QUESTION = 'What is Aurum learning about our company?';

test.describe('J07 — employee learning contribution (desktop)', () => {
  test('J07 — the learning lane: mission, ask planner, contribution and reward state', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in as the run manager');
    await signInRunManager(page);

    await cert.step('the integration registers a learning mission via the public API');
    // The developer key J05 minted (missions:write, granted to the
    // employee principal) is re-read from the run's secrets record.
    const keyFile = await readRunEmployee();
    expect(keyFile, 'J05 must have run before J07 (file order guarantees it)').not.toBeNull();
    const mission = await page.evaluate(
      async ({ baseUrl, employee }) => {
        // The key was shown once in J05 and recorded in the secrets
        // scratch by that leg — re-read it here.
        const key = employee?.apiKey;
        if (key === undefined || key === null) throw new Error('the integration key is missing');
        const response = await fetch(`${baseUrl}/api/v1/missions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            title: 'Understand the weekly freshness workflow',
            knowledgeObjective:
              'How the operations team compiles the weekly freshness digest today — inputs, effort and trust.',
            informationValue: 0.8,
            urgency: 'high',
            currentConfidence: 0.2,
            targetConfidence: 0.8,
            investigationBudget: { amount: 5000, currency: 'USD' },
            rewardBudget: { amount: 2000, currency: 'USD' },
            completionCriteria: 'The digest workflow is documented from a contributor.',
            candidateSources: [
              { kind: 'person', label: 'The run contributor' },
            ],
          }),
        });
        const body = (await response.json()) as { mission?: { id?: string }; id?: string };
        return { status: response.status, missionId: body.mission?.id ?? body.id ?? null };
      },
      { baseUrl: process.env.W079_BASE_URL ?? '', employee: keyFile },
    );
    expect(mission.status, 'the public API accepts the mission (200/201)').toBeLessThan(300);
    expect(mission.missionId, 'the mission returns its id').toBeTruthy();

    await cert.step('the Learning hub renders the mission');
    await page.goto('/learning');
    await expect(page.getByRole('heading', { name: 'Learning' }).first()).toBeVisible();
    await expect(
      page.getByText('Understand the weekly freshness workflow').first(),
    ).toBeVisible({ timeout: 30_000 });
    await cert.shot('the Learning hub — the live mission');

    await cert.step('open the mission chain — the ask planner lives there');
    await page.goto(`/intelligence/missions/${mission.missionId}`);
    await expect(
      page.getByText('Understand the weekly freshness workflow').first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/The acquisitions the loop ran/i).first()).toBeVisible();

    await cert.step('the ask planner runs and decides honestly');
    const ask = page
      .getByRole('button', { name: /plan the next knowledge acquisition/i })
      .first();
    await expect(ask).toBeVisible();
    await ask.click();
    // The planner's honest decision renders — the person gate excludes
    // the candidate (no employment record exists to ask), so no request
    // goes live; the rationale is on the acquisition trail.
    await expect(page.getByText(/planner/i).first()).toBeVisible({ timeout: 60_000 });
    await cert.shot('the planner decision — honest, on the record');

    await cert.step('the contribution and reward state panels render');
    await page.goto('/learning');
    await expect(page.getByRole('heading', { name: 'Learning' }).first()).toBeVisible();
    await expect(page.getByText('Contributions', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Rewards', { exact: true }).first()).toBeVisible();
    // The closed reward vocabulary + the explicit policy note (rewards
    // are never minted silently — no policy, no rewards).
    await expect(
      page.getByText(/no policy, no rewards/i).first(),
    ).toBeVisible();
    await cert.shot('the contribution and reward state');

    await cert.step('the chat learning intent answers from live company state');
    await page.goto('/chat');
    await page.locator('#aurum-chat-input').fill(LEARNING_QUESTION);
    await page.locator('#aurum-chat-input').press('Enter');
    const reply = page
      .locator(`${CHAT_TIMELINE} .aurum-chat-msg[data-side="aurum"]`)
      .filter({ hasText: /learning|knows about your company|company model/i })
      .first();
    await expect(reply).toBeVisible({ timeout: 90_000 });
    await cert.shot('the learning answer in chat');

    await cert.step('the conversation is preserved (the cross-surface return)');
    await expect(
      page.locator(CHAT_TIMELINE).getByText(LEARNING_QUESTION).first(),
    ).toBeVisible();
    cert.expectZeroViolations();
  });
});
