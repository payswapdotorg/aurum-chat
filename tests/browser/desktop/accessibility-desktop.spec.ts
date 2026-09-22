// W076 — the accessibility smoke in the REAL browser DOM (desktop):
// keyboard traversal of the live product shell, VISIBLE keyboard focus
// (the shell's :focus-visible ring, asserted from computed styles), the
// ARIA landmark structure of the real document, and the keyboard
// discipline of the command-search dialog (Escape closes, focus returns
// to the opener). Touch-target sizes (44px+) are asserted in the mobile
// suite, where the touch chrome is the primary navigation.

import { journeyTest as test, expect } from '../fixtures';
import { signInViaQuickAccess } from '../helpers/personas';
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
      return {
        tag: 'none',
        className: '',
        outlineWidth: '',
        outlineStyle: '',
        outlineColor: '',
        inViewport: false,
      };
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

test.describe('Accessibility smoke — keyboard, focus, landmarks (desktop)', () => {
  test('the keyboard walk starts at the skip link and focus is always visible', async ({
    journey,
  }) => {
    const { page } = journey;
    await journey.step('sign in and land on the messenger');
    await signInViaQuickAccess(page, 'manager');

    await journey.step('the first Tab reaches the skip link, which becomes visible');
    // In the dev runtime the Next.js overlay portal (<nextjs-portal>) is a
    // focusable dev-chrome element ahead of the app — Tab through it
    // (documented: dev chrome, not app content) until the APP's first
    // focusable element, the skip link, takes focus.
    for (let hop = 0; hop < 6; hop += 1) {
      await page.keyboard.press('Tab');
      const probe = await focusProbe(page);
      if (probe.tag === 'A' && probe.className.includes('aurum-skip')) break;
      expect(
        probe.tag === 'NEXTJS-PORTAL',
        `the pre-app focus stop ${hop + 1} is dev chrome (<${probe.tag}>)`,
      ).toBe(true);
    }
    const skip = await focusProbe(page);
    expect(skip.tag).toBe('A');
    expect(skip.className).toContain('aurum-skip');
    // The skip link's :focus rule pulls it on-screen (left 12px).
    const skipLeft = await page.locator(SKIP_LINK).evaluate(
      (element) => window.getComputedStyle(element).left,
    );
    expect(skipLeft, 'the focused skip link is visible on screen').not.toBe('-9999px');
    await expect(page.locator(SKIP_LINK)).toBeVisible();

    await journey.step('the skip link jumps to the content landmark');
    await page.keyboard.press('Enter');
    await page.waitForURL(/#product-main$/);
    await expect(page.locator('main#product-main')).toBeVisible();

    await journey.step('walk the shell by keyboard — every stop focusable and visibly ringed');
    // A real keyboard traversal through the shell: each Tab lands on a
    // focusable element carrying the shell's 2px solid focus ring
    // (the :focus-visible treatment — keyboard focus, so it applies).
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
      expect(probe.outlineColor, 'the ring is the calm green accent').toContain('92, 178, 143');
      expect(probe.inViewport, `keyboard stop ${step + 1} is on screen`).toBe(true);
    }
    await journey.shot('keyboard focus — the visible ring');
    journey.expectZeroViolations();
  });

  test('the messenger carries its ARIA landmark structure in the real DOM', async ({ journey }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('assert the document’s landmark structure');
    // The product shell: navigation aside, primary nav, main, footer.
    await expect(page.locator('aside[aria-label="Product navigation"]')).toBeVisible();
    await expect(page.locator('nav[aria-label="Primary"]').first()).toBeVisible();
    await expect(page.locator('main#product-main')).toBeVisible();
    await expect(page.locator('footer.aurum-footer')).toBeVisible();
    // The messenger panes are labeled regions.
    await expect(page.locator('nav[aria-label="Conversations"]')).toBeVisible();
    await expect(page.locator('section[aria-label="Conversation with Aurum"]')).toBeVisible();
    // The timeline is a live log; the composer is a labeled field.
    await expect(page.locator('div[role="log"][aria-label="Message timeline"]')).toBeVisible();
    await expect(page.locator('label[for="aurum-chat-input"]')).toHaveText('Message Aurum');
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    // The send affordance carries its accessible name.
    await expect(page.locator('.aurum-chat-send')).toHaveAccessibleName(/send message/i);
    // The document carries exactly one h1 (the messenger's screen-reader
    // heading) plus the pane headers.
    expect(await page.locator('h1').count()).toBe(1);
    await expect(page.locator('h1')).toHaveText('Chat with Aurum');
    await journey.shot('the messenger’s landmark structure');
    journey.expectZeroViolations();
  });

  test('the command-search dialog obeys Escape and returns focus to its opener', async ({
    journey,
  }) => {
    const { page } = journey;
    await signInViaQuickAccess(page, 'manager');
    await journey.step('open the command search from the rail (keyboard-adjacent path)');
    const opener = page.locator(RAIL).getByRole('button', { name: 'Search' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    // The dialog's input takes focus (the accessible entry point).
    await expect(dialog.getByLabel('Search commands')).toBeFocused();

    await journey.step('arrow keys move the selection inside the dialog');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(dialog.getByLabel('Search commands')).toBeFocused();

    await journey.step('Escape closes the dialog and restores the opener’s focus');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    journey.expectZeroViolations();
  });
});
