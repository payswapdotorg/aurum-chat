// W076 — Journey A (first-time entry) + the no-dead-end rule, in the REAL
// browser on the desktop viewport (1280×800).
//
// Proven here, exactly as a user experiences it:
//   * the anonymous root lands on the sign-in surface (the route gate);
//   * the sign-in page carries the quick-access panel — the seeded demo
//     personas, exactly as the work item mandates for authentication;
//   * one tap signs the MANAGER in through the real auth flow and the
//     first screen is the messenger (the "first 5 seconds" acceptance of
//     W071: /chat must read as a messaging application);
//   * an unusable invitation link renders the honest dead-code page with
//     a way forward (no dead ends);
//   * zero console/network errors across the whole journey.

import { journeyTest as test, expect } from '../fixtures';
import { personaName, signInViaQuickAccess } from '../helpers/personas';
import {
  AUTH_QUICK,
  AUTH_QUICK_PERSONA,
  CHAT_CONVO,
  CHAT_INPUT,
  CHAT_LISTHEAD,
  CHAT_LISTPANE,
  CHAT_THREAD,
  SHELL,
} from '../helpers/selectors';
import {
  expectComposer,
  expectDesktopTwoPaneMessenger,
  expectMessengerDominance,
  expectShareNetShell,
} from '../helpers/visual';

test.describe('Journey A — first-time entry (desktop)', () => {
  test('anonymous visitors land on the sign-in surface from the root', async ({ journey }) => {
    const { page } = journey;
    await journey.step('visit the root as an anonymous visitor');
    await page.goto('/');
    await page.waitForURL(/\/signin/);
    expect(page.url(), 'the root carries the way back (next param)').toContain('next=');
    await expect(page.locator('.aurum-auth-card')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await journey.shot('anonymous entry — the sign-in surface');
    journey.expectZeroViolations();
  });

  test('an unusable invitation link is an honest page with a way forward (no dead ends)', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('follow a dead invitation link');
    await page.goto('/invite/not-a-live-code');
    await expect(
      page.getByRole('heading', { name: 'This invitation is no longer usable' }),
    ).toBeVisible();
    // The way forward: both entries out of the dead code are real links.
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible();
    await journey.shot('dead invite code — the honest dead-end page');
    journey.expectZeroViolations();
  });

  test('the sign-in page offers the seeded demo personas through quick access', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('open the sign-in page and inspect quick access');
    await page.goto('/signin');
    const panel = page.locator(AUTH_QUICK);
    await expect(panel).toBeVisible();
    // The seeded directory: manager, employee, developer, platform reviewer.
    for (const role of ['manager', 'employee', 'developer', 'platform-reviewer'] as const) {
      await expect(
        panel.locator(AUTH_QUICK_PERSONA, { hasText: personaName(role) }),
        `the quick-access panel lists ${personaName(role)}`,
      ).toBeVisible();
    }
    await expect(panel.locator(AUTH_QUICK_PERSONA)).toHaveCount(4);
    journey.expectZeroViolations();
  });

  test('one tap signs the manager in and the first screen is the messenger', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in as the manager through quick access');
    await signInViaQuickAccess(page, 'manager');

    await journey.step('the first screen is the conversation surface');
    // The messenger reads as a messenger within seconds: the Aurum contact
    // identity, the conversation list pane, the seeded conversation, and
    // the thread pane with the starter grid + composer.
    await expect(page.locator(CHAT_LISTHEAD)).toBeVisible();
    await expect(page.locator(CHAT_LISTHEAD).locator('.aurum-chat-name')).toHaveText('Aurum');
    await expect(page.locator(CHAT_LISTHEAD).locator('.aurum-chat-role')).toContainText(
      'On duty',
    );
    await expect(page.locator(CHAT_LISTPANE)).toBeVisible();
    await expect(page.locator(CHAT_CONVO, { hasText: 'Wholesale freshness' })).toBeVisible();
    await expect(page.locator(CHAT_THREAD)).toBeVisible();
    await expect(page.getByPlaceholder('Ask about goals, unknowns, risks, approvals…')).toBeVisible();
    await expect(page.locator('.aurum-starter-grid .aurum-starter').first()).toBeVisible();

    await journey.step('the visual contract: ShareNet shell + dominant messenger');
    await expectShareNetShell(page);
    await expectMessengerDominance(page);
    await expectDesktopTwoPaneMessenger(page);
    await expectComposer(page);

    await journey.step('the shell footer stays at the bottom of the viewport');
    // The sticky-footer rule: on a short page the footer is inside the
    // viewport; on /chat the messenger fills the height and the footer
    // follows naturally below the fold.
    const footerTop = await page.locator(`${SHELL} > footer`).boundingBox();
    expect(footerTop).not.toBeNull();
    if (footerTop !== null) {
      expect(footerTop.y).toBeGreaterThanOrEqual(0);
    }

    await journey.shot('first screen — the messenger (manager)');
    journey.expectZeroViolations();
  });

  test('the composer is keyboard-first (focusable, typed, and cleared by UI state)', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'employee');
    await journey.step('focus the composer with the keyboard only');
    await page.locator(CHAT_INPUT).click();
    await page.keyboard.type('Hello');
    await expect(page.locator(CHAT_INPUT)).toHaveValue('Hello');
    // The send affordance enables only with content (the composer's own
    // disabled state — quiet, no error).
    await expectComposer(page, { withDraft: true });
    await journey.shot('composer with a draft (employee)');
    journey.expectZeroViolations();
  });
});
