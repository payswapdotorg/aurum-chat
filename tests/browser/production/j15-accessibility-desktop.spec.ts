// W079 — J15 · Accessibility / discoverability (desktop 1280×800).
//
// The mandatory proof (contract §5): keyboard/focus/ARIA; task-language
// discovery; no dead-end/no-match states. The W076 accessibility
// discipline carried to production: the keyboard walk starts at the
// skip link with visible focus rings on every stop, the document's ARIA
// landmark structure is asserted in the real DOM, the command search
// speaks task language and never dead-ends on a no-match query, and a
// dead invitation link is an honest page with ways forward.
//
// One production difference from W076: the Next.js dev overlay portal
// does not exist in the production runtime, so the first Tab stop is
// the app's own skip link directly.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_INPUT, RAIL, SKIP_LINK } from '../helpers/selectors';

/** The set of tags a keyboard walk may legitimately focus. */
const FOCUSABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);

interface FocusProbe {
  tag: string;
  className: string;
  outlineWidth: string;
  outlineStyle: string;
  outlineColor: string;
  inViewport: boolean;
}

/** Read the live focus treatment of the currently focused element. */
async function focusProbe(page: import('@playwright/test').Page): Promise<FocusProbe> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || !(element instanceof HTMLElement)) {
      return { tag: 'none', className: '', outlineWidth: '', outlineStyle: '', outlineColor: '', inViewport: false };
    }
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      className: element.className,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      inViewport: box.left < window.innerWidth && box.right > 0,
    };
  });
}

test.describe('J15 — accessibility / discoverability (desktop)', () => {
  test('J15 — keyboard, focus, ARIA, task-language discovery and no dead ends', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in and land on the messenger');
    await signInRunManager(page);

    await cert.step('the first Tab reaches the skip link, which becomes visible');
    await page.keyboard.press('Tab');
    const skip = await focusProbe(page);
    expect(skip.tag, 'the production runtime has no dev chrome before the app').toBe('A');
    expect(skip.className).toContain('aurum-skip');
    await expect(page.locator(SKIP_LINK)).toBeVisible();

    await cert.step('the skip link jumps to the content landmark');
    await page.keyboard.press('Enter');
    await page.waitForURL(/#product-main$/);
    await expect(page.locator('main#product-main')).toBeVisible();

    await cert.step('walk the shell by keyboard — every stop focusable and visibly ringed');
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      const probe = await focusProbe(page);
      expect(probe.tag, `keyboard stop ${step + 1} is a focusable element`).toBeTruthy();
      expect(
        FOCUSABLE_TAGS.has(probe.tag),
        `keyboard stop ${step + 1} focused <${probe.tag.toLowerCase()}>`,
      ).toBe(true);
      expect(
        probe.outlineWidth,
        `keyboard stop ${step + 1} shows the focus ring (${probe.className})`,
      ).toBe('2px');
      expect(probe.outlineStyle).toBe('solid');
      expect(probe.inViewport, `keyboard stop ${step + 1} is on screen`).toBe(true);
    }
    await cert.shot('keyboard focus — the visible ring');

    await cert.step('the messenger carries its ARIA landmark structure');
    await expect(page.locator('aside[aria-label="Product navigation"]')).toBeVisible();
    await expect(page.locator('nav[aria-label="Primary"]').first()).toBeVisible();
    await expect(page.locator('main#product-main')).toBeVisible();
    await expect(page.locator('nav[aria-label="Conversations"]')).toBeVisible();
    await expect(page.locator('section[aria-label="Conversation with Aurum"]')).toBeVisible();
    await expect(page.locator('div[role="log"][aria-label="Message timeline"]')).toBeVisible();
    await expect(page.locator('label[for="aurum-chat-input"]')).toHaveText('Message Aurum');
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    await expect(page.locator('.aurum-chat-send')).toHaveAccessibleName(/send message/i);
    await cert.shot('the ARIA landmark structure');

    await cert.step('command search speaks task language and navigates');
    await page.locator(RAIL).getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByLabel('Search commands');
    await expect(input).toBeVisible();
    await input.fill('connect');
    await expect(dialog.locator('[role="option"]').first()).toBeVisible();
    await cert.shot('command search — task language');

    await cert.step('a no-match query offers task-language suggestions (no dead end)');
    await input.fill('zz-nothing-matches-this');
    await expect(dialog.getByRole('group', { name: 'Suggested searches' })).toBeVisible();
    const chip = dialog.getByRole('button', { name: /connect/i }).first();
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(dialog.locator('[role="option"]').first()).toBeVisible();

    await cert.step('escape closes the dialog (keyboard discipline)');
    await expect(dialog.getByLabel('Search commands')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await cert.step('a dead invitation link is an honest page with ways forward');
    await page.goto('/invite/not-a-live-code');
    await expect(
      page.getByRole('heading', { name: 'This invitation is no longer usable' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible();
    await cert.shot('the dead code — the honest no-dead-end page');
    cert.expectZeroViolations();
  });
});
