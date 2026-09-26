// W101 — J17 · Meetings (desktop 1280×800).
//
// The mandatory proof (the W101 matrix): the meetings surface via the v1
// API — the meeting-intelligence contract's user-visible path, with real
// production auth.
//
// PRODUCTION REALITY, recorded honestly: the meeting-intelligence module
// (W085 contract + W097 fixtures) owns NO user-facing route and NO v1
// public API operation in the deployed revision — the repo's own
// discoverability map records that "it owns no user-facing route yet —
// the meeting UX arrives with the realtime companion (W086)". The journey
// therefore EXHAUSTS every legitimate production path a user or
// integration has to a meetings surface — the product rail, the More
// capability hub, the command search (the task-language surface), and the
// v1 public API's own discovery document — proves each answers honestly
// (no dead ends, no partial entries), and records the exact BLOCKED
// reason. Nothing is weakened and no preview evidence is substituted
// (the work-order's honesty law).

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectDialogInputLabeled } from './a11y';

test.describe('J17 — meetings (desktop)', () => {
  test('J17 — every legitimate production path to a meetings surface is exhausted and recorded honestly', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in as the run manager');
    await signInRunManager(page);

    await cert.step('the product rail carries no meetings entry');
    await expect(
      page.locator(RAIL).getByRole('link', { name: /meeting/i }),
      'the rail offers no meetings navigation',
    ).toHaveCount(0);
    await cert.shot('the product rail — no meetings entry');

    await cert.step('the More capability hub carries no meetings surface');
    await page.goto('/more');
    await expect(page.getByRole('heading', { name: /more/i }).first()).toBeVisible();
    await expect(
      page.locator('.aurum-hub-card').filter({ hasText: /meeting/i }),
      'the More hub offers no meetings capability card',
    ).toHaveCount(0);
    await cert.shot('the More hub — no meetings capability');

    await cert.step('the command search speaks task language and offers no meetings entry');
    await page.locator(RAIL).getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    await expectDialogInputLabeled(page, 'Command search', 'Search commands');
    const input = dialog.getByLabel('Search commands');
    await input.fill('meeting');
    await expect(
      dialog.locator('[role="option"]').filter({ hasText: /meeting/i }),
      'no meetings command is offered',
    ).toHaveCount(0);
    await cert.shot('command search — no meetings entry');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await cert.step('the v1 public API discovery document lists no meeting operations');
    const discovery = await page.evaluate(async () => {
      const response = await fetch('/api/v1', { cache: 'no-store' });
      const body = (await response.json()) as { operations?: { operation?: string; path?: string }[] };
      const operations = body.operations ?? [];
      return {
        status: response.status,
        operationCount: operations.length,
        meetingFamily: operations.filter((entry) =>
          /meeting/i.test(`${entry.operation ?? ''} ${entry.path ?? ''}`),
        ).map((entry) => entry.operation ?? entry.path ?? ''),
      };
    });
    expect(discovery.status, 'the discovery document answers').toBe(200);
    expect(discovery.operationCount).toBeGreaterThan(0);
    expect(
      discovery.meetingFamily,
      'the v1 public API lists no meeting operations',
    ).toEqual([]);

    await cert.step('record the honest BLOCKED reason');
    cert.recordBlocked(
      'the meetings surface does not exist in the deployed revision a2db98a: the ' +
        'meeting-intelligence module (W085 contract + W097 fixtures) owns no user-facing route ' +
        'and no v1 public API operation — the repo’s own discoverability map defers the meeting ' +
        'UX to the realtime companion (W086); every legitimate production path was probed and ' +
        `carries no meetings entry (rail, More hub, command search, v1 discovery: ${discovery.operationCount} operations, none meeting-scoped)`,
      {
        v1DiscoveryOperations: discovery.operationCount,
        v1MeetingFamilyOperations: discovery.meetingFamily,
        navigationPathsProbed: ['rail', 'More hub', 'command search', 'v1 discovery'],
      },
    );

    await cert.step('return to the conversation (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
