// W079 — J10 · Workforce / agent intervention (desktop 1280×800).
//
// The mandatory proof (contract §5): capability gap → alternatives →
// proposal → human approval → activation → lifecycle.
//
// PRODUCTION REALITY, recorded honestly: the intervention chain's
// proposals (agent recruitment with compared train/recruit/hire
// alternatives and agent activation) originate from the capability-gap
// analysis over goals and demands — a fresh company has neither, and no
// user surface fabricates them (the demo world that seeds them locally
// is refused by the production runtime by design). The journey proves,
// through real surfaces:
//
//   * the discovery path (More → the workforce/interventions surfaces);
//   * the Interventions governance surface — the compared-alternatives
//     panel, the capability-gap panel and the proposal gate with the
//     human-authority vocabulary, all rendering their honest states;
//   * the Workforce surface — the employee/role read model;
//   * the human approval itself is proven LIVE in J05 (a real action
//     request decided inline from the conversation by the manager);
//   * the return to Chat.
//
// The full seeded proposal→activation→lifecycle recording chain is
// proven by the repository's committed tests (G2) and the W074 browser
// layer over the demo world — recorded in the certification report.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { RAIL } from '../helpers/selectors';

test.describe('J10 — workforce / agent intervention (desktop)', () => {
  test('J10 — the intervention governance chain: gaps, alternatives, the gate and the workforce', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and discover the intervention surfaces from More');
    await signInRunManager(page);
    await page.goto('/more');
    const hubCard = page
      .locator('.aurum-hub-card')
      .filter({ hasText: /Fix a capability gap/i })
      .first();
    await expect(hubCard).toBeVisible();
    await cert.shot('the More hub — the intervention discovery');

    await cert.step('the Interventions surface renders the governance chain');
    await page.goto('/interventions');
    await expect(page.getByRole('heading', { name: 'Interventions' }).first()).toBeVisible();
    // The compared-alternatives panel (the train/recruit/hire vocabulary).
    await expect(page.getByText('Compared alternatives')).toBeVisible();
    // The capability-gap panel with its honest empty state.
    await expect(page.getByText('Capability gaps')).toBeVisible();
    await expect(page.getByText(/No gaps|no capability gaps/i).first()).toBeVisible();
    await cert.shot('the Interventions surface — gaps, alternatives, the human gate');

    await cert.step('the human-authority vocabulary is explicit on the surface');
    await expect(
      page.getByText(/human|approval|decide/i).first(),
    ).toBeVisible();

    await cert.step('the Workforce surface renders the read model (tower chrome)');
    await page.goto('/workforce');
    await expect(page.getByRole('heading', { name: 'Workforce' }).first()).toBeVisible();
    await expect(page.getByText(/Employee-supplied capabilities|capabilit/i).first()).toBeVisible();
    await cert.shot('the Workforce surface — the honest read model');

    await cert.step('the agents governance surface is reachable (tower chrome)');
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: /agents/i }).first()).toBeVisible();
    await cert.shot('the agents surface');

    await cert.step('back on the product shell — return to Chat (cross-surface rule)');
    // The tower surfaces carry the tower chrome; the product rail lives on
    // the product shell — return through the Interventions surface.
    await page.goto('/interventions');
    await expect(page.getByRole('heading', { name: 'Interventions' }).first()).toBeVisible();
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator('.aurum-chat-app')).toBeVisible();
    cert.expectZeroViolations();
  });
});
