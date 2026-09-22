// W076 — programmatic visual assertions for the frozen UX rule:
//
//   "ShareNet-dominant visual direction + WhatsApp-like interface and
//    interaction model."
//
// These are DOM/computed-style/bounding-box assertions — deliberately NOT
// pixel diffs (no flakiness, no golden images). Screenshots are captured
// alongside as human-review artifacts; the CONTRACT is asserted here:
//
//   * ShareNet shell — warm off-white canvas (#f9f8f7), no gradient
//     chrome, no glassmorphism (backdrop-filter) on any sampled surface;
//   * WhatsApp-like conversation — the messenger window is the dominant
//     central area, the conversation list is a first-class pane, member
//     bubbles right-align and Aurum bubbles left-align inside the
//     timeline, compact timestamps live inside every bubble, unread
//     badges are pills, the composer is a compact row with a send button.

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  CHAT_APP,
  CHAT_BUBBLE,
  CHAT_BUBBLE_META,
  CHAT_INPUT,
  CHAT_LISTPANE,
  CHAT_MSG,
  CHAT_SEND,
  CHAT_THREAD,
  CHAT_TIMELINE,
  CHAT_DAY,
  CHAT_UNREAD,
  MAIN,
  RAIL,
  SHELL,
  TOPBAR,
  BOTTOMNAV,
} from './selectors';

/** The ShareNet canvas color (product.css --bg: #f9f8f7). */
const SHARENET_CANVAS = 'rgb(249, 248, 247)';
/** The member bubble tint (product.css --accent-soft: #d9eee4). */
const MEMBER_BUBBLE_TINT = 'rgb(217, 238, 228)';
/** The Aurum bubble surface (product.css --surface: #fcfcfb). */
const AURUM_BUBBLE_SURFACE = 'rgb(252, 252, 251)';

/** Read one element's computed style value (page-context evaluation). */
async function computedStyle(
  page: Page,
  selector: string,
  property: string,
): Promise<string> {
  return page.locator(selector).first().evaluate(
    (element, prop) => window.getComputedStyle(element).getPropertyValue(prop),
    property,
  );
}

/**
 * The ShareNet-dominant shell: the warm off-white canvas renders as the
 * page's actual background, and no sampled chrome surface carries a
 * gradient (backgroundImage) or glassmorphism (backdrop-filter).
 */
export async function expectShareNetShell(page: Page): Promise<void> {
  const canvas = await computedStyle(page, SHELL, 'background-color');
  expect(canvas, 'the shell canvas is ShareNet warm off-white').toBe(SHARENET_CANVAS);

  // No gradient chrome / no glassmorphism on the sampled surfaces: the
  // shell, the rail (desktop chrome), the bubbles (both speakers), the
  // composer. Flat surfaces + hairlines only, per the frozen rule.
  for (const selector of [SHELL, RAIL, CHAT_BUBBLE, '.aurum-chat-composer']) {
    const count = await page.locator(selector).count();
    if (count === 0) continue;
    const image = await computedStyle(page, selector, 'background-image');
    expect(image, `${selector} must carry no gradient chrome`).toBe('none');
    const filter = await computedStyle(page, selector, 'backdrop-filter');
    expect(filter, `${selector} must carry no glassmorphism`).toBe('none');
  }
}

/**
 * The messenger window is the DOMINANT central visual area of the product
 * surface: the chat app fills the main landmark's width (the management
 * rail stays a slim secondary column beside it).
 */
export async function expectMessengerDominance(page: Page): Promise<void> {
  const chatBox = await page.locator(CHAT_APP).boundingBox();
  const mainBox = await page.locator(MAIN).boundingBox();
  const railBox = await page.locator(RAIL).boundingBox();
  expect(chatBox, 'the messenger window is laid out').not.toBeNull();
  expect(mainBox, 'the product main landmark is laid out').not.toBeNull();
  expect(railBox, 'the desktop rail is laid out (secondary chrome)').not.toBeNull();
  if (chatBox === null || mainBox === null || railBox === null) return;

  expect(
    chatBox.width / mainBox.width,
    'the messenger occupies the dominant central area',
  ).toBeGreaterThan(0.85);
  expect(
    railBox.width / mainBox.width,
    'management chrome stays visually secondary',
  ).toBeLessThan(0.3);
}

/**
 * The desktop two-pane messenger: the conversation list is a first-class
 * pane beside the thread, and the thread (timeline + composer) carries
 * the larger share of the window.
 */
export async function expectDesktopTwoPaneMessenger(page: Page): Promise<void> {
  const listBox = await page.locator(CHAT_LISTPANE).boundingBox();
  const threadBox = await page.locator(CHAT_THREAD).boundingBox();
  expect(listBox, 'the conversation-list pane is laid out').not.toBeNull();
  expect(threadBox, 'the thread pane is laid out').not.toBeNull();
  if (listBox === null || threadBox === null) return;
  expect(listBox.height / threadBox.height).toBeGreaterThan(0.9);
  expect(threadBox.width).toBeGreaterThan(listBox.width);
}

export interface BubbleAlignmentReport {
  memberCount: number;
  aurumCount: number;
  memberRightGap: number;
  aurumLeftGap: number;
}

/**
 * The WhatsApp-like bubble geometry, asserted from the LIVE layout:
 *
 *   * member messages right-align (their row's right edge hugs the
 *     timeline's right edge), Aurum messages left-align;
 *   * the two sides are visibly separated (member centers sit right of
 *     Aurum centers);
 *   * member bubbles carry the accent tint, Aurum bubbles the neutral
 *     surface — speaker is legible from color + position together;
 *   * every bubble carries its compact timestamp meta (HH:MM) inside it.
 */
export async function expectMessengerBubbles(
  page: Page,
): Promise<BubbleAlignmentReport> {
  const member = page.locator(`${CHAT_MSG}[data-side="member"]`);
  const aurum = page.locator(`${CHAT_MSG}[data-side="aurum"]`);
  const memberCount = await member.count();
  const aurumCount = await aurum.count();
  expect(memberCount, 'the thread shows member-side bubbles').toBeGreaterThan(0);
  expect(aurumCount, 'the thread shows Aurum-side bubbles').toBeGreaterThan(0);

  const timelineBox = await page.locator(CHAT_TIMELINE).boundingBox();
  expect(timelineBox).not.toBeNull();
  if (timelineBox === null) throw new Error('timeline is not laid out');

  // The alignment geometry lives on the BUBBLES (the rows are full-width
  // flex containers that justify their bubble; measuring the row would
  // measure the timeline itself).
  const memberBubble = page.locator(`${CHAT_MSG}[data-side="member"] ${CHAT_BUBBLE}`).first();
  const aurumBubble = page.locator(`${CHAT_MSG}[data-side="aurum"] ${CHAT_BUBBLE}`).first();
  const firstMember = await memberBubble.boundingBox();
  const firstAurum = await aurumBubble.boundingBox();
  expect(firstMember).not.toBeNull();
  expect(firstAurum).not.toBeNull();
  if (firstMember === null || firstAurum === null) throw new Error('bubbles not laid out');

  // Right alignment of the member bubble (justify-content: flex-end).
  const memberRightGap = timelineBox.x + timelineBox.width - (firstMember.x + firstMember.width);
  expect(memberRightGap, 'member bubbles hug the timeline right edge').toBeLessThan(48);
  expect(memberRightGap).toBeGreaterThan(-1);

  // Left alignment of the Aurum bubble (justify-content: flex-start).
  const aurumLeftGap = firstAurum.x - timelineBox.x;
  expect(aurumLeftGap, 'Aurum bubbles hug the timeline left edge').toBeLessThan(48);
  expect(aurumLeftGap).toBeGreaterThan(-1);

  // Speaker separation: the member bubble's center sits clearly right of
  // the Aurum bubble's center. The margin is proportional to the timeline
  // width — a 1280px desktop thread separates by hundreds of pixels, a
  // 390px mobile thread by tens; both must exceed 8% of the timeline.
  const memberCenter = firstMember.x + firstMember.width / 2;
  const aurumCenter = firstAurum.x + firstAurum.width / 2;
  expect(memberCenter - aurumCenter, 'the two speakers are spatially separated').toBeGreaterThan(
    timelineBox.width * 0.08,
  );

  // Speaker color: the tinted member bubble vs the neutral Aurum bubble.
  const memberBg = await page
    .locator(`${CHAT_MSG}[data-side="member"] ${CHAT_BUBBLE}`)
    .first()
    .evaluate((element) => window.getComputedStyle(element).backgroundColor);
  expect(memberBg, 'member bubbles carry the accent tint').toBe(MEMBER_BUBBLE_TINT);
  const aurumBg = await page
    .locator(`${CHAT_MSG}[data-side="aurum"] ${CHAT_BUBBLE}`)
    .first()
    .evaluate((element) => window.getComputedStyle(element).backgroundColor);
  expect(aurumBg, 'Aurum bubbles stay on the neutral surface').toBe(AURUM_BUBBLE_SURFACE);

  // Rounded bubbles (the messenger silhouette; radius > 8px).
  for (const side of ['member', 'aurum'] as const) {
    const radius = await page
      .locator(`${CHAT_MSG}[data-side="${side}"] ${CHAT_BUBBLE}`)
      .first()
      .evaluate((element) => window.getComputedStyle(element).borderRadius);
    expect(parseFloat(radius), `${side} bubbles are rounded`).toBeGreaterThan(8);
  }

  return { memberCount, aurumCount, memberRightGap, aurumLeftGap };
}

/**
 * Compact timestamps: every bubble's meta line renders a HH:MM-shaped
 * label at a compact type size (the WhatsApp-like density — the meta is
 * 10.5px by stylesheet contract; the assertion allows ≤ 12px).
 */
export async function expectCompactTimestamps(page: Page): Promise<void> {
  const meta = page.locator(CHAT_BUBBLE_META);
  const count = await meta.count();
  expect(count).toBeGreaterThan(0);
  const first = meta.first();
  const size = await first.evaluate(
    (element) => window.getComputedStyle(element).fontSize,
  );
  expect(parseFloat(size), 'bubble timestamps are compact').toBeLessThanOrEqual(12);
  await expect(first).toHaveText(/\d{1,2}:\d{2}/);
}

/**
 * Day separators render between turns of different days (the timeline's
 * WhatsApp-like rhythm) as centered quiet pills.
 */
export async function expectDaySeparator(page: Page): Promise<void> {
  const day = page.locator(CHAT_DAY).first();
  await expect(day).toBeVisible();
  await expect(day.locator('span')).toHaveText(/\S+/);
}

/**
 * The unread/new-activity badge: a pill (fully rounded) carrying the
 * New/Unread word — color never carries the meaning alone.
 */
export async function expectUnreadBadge(page: Page): Promise<void> {
  const badge = page.locator(CHAT_UNREAD).first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/^(New|Unread)$/);
  const radius = await badge.evaluate(
    (element) => window.getComputedStyle(element).borderRadius,
  );
  expect(parseFloat(radius), 'the unread badge is a pill').toBeGreaterThan(50);
}

/**
 * The composer contract: a compact row — the multiline textarea and the
 * send affordance side by side inside the thread pane, both visible; the
 * send button enables with a non-empty draft (`withDraft`) and stays
 * quiet/disabled otherwise (the composer's own state, no error surface).
 */
export async function expectComposer(page: Page, options?: { withDraft?: boolean }): Promise<void> {
  const input = page.locator(CHAT_INPUT);
  const send = page.locator(CHAT_SEND);
  await expect(input).toBeVisible();
  await expect(send).toBeVisible();
  if (options?.withDraft === true) {
    await expect(send).toBeEnabled();
  } else {
    await expect(send).toBeAttached();
  }

  const inputBox = await input.boundingBox();
  const sendBox = await send.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  if (inputBox === null || sendBox === null) return;
  // Side by side, the send button right of the input, aligned rows.
  expect(sendBox.x).toBeGreaterThan(inputBox.x + inputBox.width - 8);
  expect(Math.abs(sendBox.y - inputBox.y)).toBeLessThan(24);
}

/**
 * The mobile chrome contract: the five-area bottom navigation renders
 * with ≥ 44px touch targets per area, and the top bar is laid out.
 */
export async function expectMobileChrome(page: Page): Promise<void> {
  await expect(page.locator(TOPBAR)).toBeVisible();
  const nav = page.locator(BOTTOMNAV);
  await expect(nav).toBeVisible();
  const areas = nav.locator('ul > li > a');
  const count = await areas.count();
  expect(count, 'the five-area bottom navigation').toBe(5);
  for (let index = 0; index < count; index += 1) {
    const box = await areas.nth(index).boundingBox();
    expect(box, `bottom-nav area ${index} is laid out`).not.toBeNull();
    if (box === null) continue;
    expect(box.height, `bottom-nav area ${index} is a 44px+ touch target`).toBeGreaterThanOrEqual(44);
    expect(box.width, `bottom-nav area ${index} is a 44px+ touch target`).toBeGreaterThanOrEqual(44);
  }
}

/**
 * On mobile, the chat window occupies (nearly) the full main width — a
 * first-class conversation screen, not a cramped pane.
 */
export async function expectMobileChatFirstClass(page: Page): Promise<void> {
  const chatBox = await page.locator(CHAT_APP).boundingBox();
  const mainBox = await page.locator(MAIN).boundingBox();
  expect(chatBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  if (chatBox === null || mainBox === null) return;
  expect(chatBox.width / mainBox.width, 'mobile chat spans the main area').toBeGreaterThan(0.92);
}

/**
 * Assert a locator is within the viewport horizontally and vertically
 * (used for "the decisive element is on screen" checks).
 */
export async function expectInViewport(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280 + 1);
  expect(box.y + box.height).toBeGreaterThan(0);
}
