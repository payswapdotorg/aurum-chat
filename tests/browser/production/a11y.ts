// W101 — the shared accessibility probes for the post-S002 journeys
// (J16–J22). The W079 discipline (J15) carried to every NEW user-facing
// page the matrix added: the product shell's skip link and landmarks must
// be present, a keyboard walk must land on focusable elements with
// visible focus rings, and every probe reads the REAL production DOM
// (computed styles, never source assumptions). J15's own file is frozen
// (W079 evidence law); these probes are the W101 extension's shared layer
// and are imported only by the J16+ specs.

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** The set of tags a keyboard walk may legitimately focus (the J15 vocabulary). */
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
async function focusProbe(page: Page): Promise<FocusProbe> {
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

/**
 * Assert one NEW page's shell accessibility: the skip link exists, the
 * content landmark is present, and a short keyboard walk from the top
 * lands on focusable elements carrying the visible focus ring. Runs
 * against the page as currently loaded (call after the page settled).
 */
export async function expectPageShellA11y(page: Page, label: string): Promise<void> {
  // The skip link + the content landmark (the product shell contract —
  // the same selectors J15 pins: '.aurum-skip' and 'main#product-main').
  await expect(
    page.locator('.aurum-skip').first(),
    `${label}: the skip link is present`,
  ).toBeVisible();
  await expect(
    page.locator('main#product-main'),
    `${label}: the content landmark is present`,
  ).toBeVisible();

  // A keyboard walk from the document top: every stop focusable and
  // visibly ringed (the J15 discipline, bounded to keep journeys fast).
  await page.keyboard.press('Tab');
  for (let stop = 0; stop < 4; stop += 1) {
    const probe = await focusProbe(page);
    expect(
      probe.tag !== 'none' && FOCUSABLE_TAGS.has(probe.tag),
      `${label}: keyboard stop ${stop + 1} focused a focusable element (<${probe.tag.toLowerCase()}>)`,
    ).toBe(true);
    expect(
      probe.outlineWidth,
      `${label}: keyboard stop ${stop + 1} shows the focus ring (${probe.className})`,
    ).toBe('2px');
    expect(probe.outlineStyle).toBe('solid');
    expect(probe.inViewport, `${label}: keyboard stop ${stop + 1} is on screen`).toBe(true);
    await page.keyboard.press('Tab');
  }
}

/**
 * Assert a dialog's input is properly labeled (the command-search probes
 * of the absence journeys — the no-match state must stay usable).
 */
export async function expectDialogInputLabeled(
  page: Page,
  dialogName: string,
  inputLabel: string,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(inputLabel)).toBeVisible();
}
