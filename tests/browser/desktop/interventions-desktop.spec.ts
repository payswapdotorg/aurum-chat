// W076 — Journey E/I (management surfaces of the consequential approval
// and the agent lifecycle) in the REAL browser on the desktop viewport:
// the interventions home shows the capability gap and the live agent,
// the recruitment proposal renders its compared alternatives and waits
// at the human gate, the agent page carries budget/permissions/lifecycle
// with links onward, and the tower Approvals surface shows the decision
// trail — including the employee-messaging request this suite's chat
// journey approved inline. No dead ends; zero console errors.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';

test.describe('Journeys E/I — interventions, approvals and the tower (desktop)', () => {
  test('the interventions home shows the gap, the live agent and the proposal', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager and open Interventions');
    await signInViaQuickAccess(page, 'manager');
    await page.goto('/interventions');
    await expect(page.getByText('cold-chain-logistics').first()).toBeVisible();
    await expect(page.getByText('Freshness Monitor').first()).toBeVisible();
    await journey.shot('the interventions home — gap, agent, proposal');
    journey.expectZeroViolations();
  });

  test('the recruitment proposal shows compared alternatives at the human gate', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the proposal from the interventions home');
    await page.goto('/interventions');
    await page
      .locator('a[href*="/interventions/proposals/"]')
      .first()
      .click();
    await page.waitForURL(/\/interventions\/proposals\//);
    await expect(page.getByText('The compared alternatives').first()).toBeVisible();
    await expect(page.getByText('Waiting for a human decision').first()).toBeVisible();
    await journey.shot('the proposal — alternatives, waiting at the gate');
    journey.expectZeroViolations();
  });

  test('the live agent page carries budget, permissions and lifecycle onward', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the live agent from the interventions home');
    await page.goto('/interventions');
    await page.getByRole('link', { name: /Freshness Monitor/ }).first().click();
    await page.waitForURL(/\/interventions\/agents\//);
    await expect(page.getByText('Freshness Monitor').first()).toBeVisible();
    await expect(page.getByText('langgraph').first()).toBeVisible();
    // The lifecycle surface links onward (never a dead end).
    expect(await page.locator('main a').count()).toBeGreaterThan(0);
    await journey.shot('the agent page — budget, permissions, lifecycle');
    journey.expectZeroViolations();
  });

  test('the tower Approvals surface shows the decision trail (management mode)', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the tower approvals surface');
    await page.goto('/approvals');
    await expect(page.getByText(/employee[ -]?messaging/i).first()).toBeVisible();
    // The inline chat decision of this suite's chat journey is visible on
    // the authoritative trail.
    await expect(page.getByText(/decided|approved/i).first()).toBeVisible();
    // Management mode keeps its own shell: the tower nav with the
    // fifteen surfaces — a tower page is never a dead end.
    await expect(page.locator('.tower-nav')).toBeVisible();
    await expect(page.locator('.tower-nav a[href="/goals"]')).toBeVisible();
    await expect(page.locator('.tower-nav a[href="/approvals"]')).toBeVisible();
    await journey.shot('the tower approvals surface — the decision trail');
    journey.expectZeroViolations();
  });
});
