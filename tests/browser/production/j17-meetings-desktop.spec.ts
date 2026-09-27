// W106 — J17 · Meetings (desktop 1280×800).
//
// The mandatory proof (the W101 matrix, unchanged): the meetings surface
// via the v1 API — the meeting-intelligence contract's user-visible
// path, with real production auth.
//
// PRODUCTION REALITY at the certified revision (W104 live): the meetings
// surface EXISTS as a user-visible path. The More capability hub carries
// the meetings card (task language: "Review what happened in a meeting")
// and navigates to /meetings; the command search offers the same
// destination by task language; the /meetings page renders the
// meeting-intelligence registry families with their honest empty states
// for a fresh tenant (captured meetings, capture connections,
// participants, access history — every empty state names its unblocking
// path, no dead ends); the page carries the shell accessibility
// contract; and the v1 public API lists the meeting family (9 read
// operations), which a key minted through the real developer console
// with the meetings scope proves live with real production auth — the
// registry reads answer 200 with the honest empty arrays for this
// tenant. The key is revoked in-test.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectDialogInputLabeled, expectPageShellA11y } from './a11y';

test.describe('J17 — meetings (desktop)', () => {
  test('J17 — the meetings surface is proven through the hub, the command search, the page and the v1 API', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in as the run manager');
    await signInRunManager(page);

    await cert.step('the More capability hub carries the meetings surface');
    await page.goto('/more');
    await expect(page.getByRole('heading', { name: /more/i }).first()).toBeVisible();
    const meetingsCard = page
      .locator('.aurum-hub-card')
      .filter({ hasText: 'Review what happened in a meeting' })
      .first();
    await expect(meetingsCard, 'the More hub offers the meetings capability card').toBeVisible();
    await meetingsCard.click();
    await page.waitForURL(/\/meetings/);
    await cert.shot('the More hub — the meetings capability navigates to the surface');

    await cert.step('the meetings page renders the meeting-intelligence registry families');
    await expect(page.getByRole('heading', { name: 'Meetings' }).first()).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Captured meetings' }).first(),
    ).toBeVisible();
    await expect(page.getByText('No meetings captured yet').first()).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Capture connections' }).first(),
    ).toBeVisible();
    await expect(page.getByText('No meeting capture is registered').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Participants' }).first()).toBeVisible();
    await expect(page.getByText('No participants captured yet').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Access history' }).first()).toBeVisible();
    await expect(page.getByText('No access failures recorded').first()).toBeVisible();
    // The honest empty states carry their unblocking affordances (no dead
    // ends): the capture path points at the connection hub.
    await expect(page.getByRole('link', { name: 'Connect a meeting source' }).first()).toBeVisible();
    await cert.shot('the meetings surface — the registry families with their honest empty states');

    await cert.step('the meetings page carries the shell accessibility contract');
    // The walk runs on a hard-loaded, settled DOM (a soft navigation's
    // React morph can transiently reset focus mid-walk — same surface,
    // deterministic load vehicle).
    await page.goto('/meetings');
    await expect(page.getByRole('heading', { name: 'Meetings' }).first()).toBeVisible();
    await expectPageShellA11y(page, 'the meetings surface');

    await cert.step('the command search speaks task language and offers the meetings destination');
    await page.locator(RAIL).getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    await expectDialogInputLabeled(page, 'Command search', 'Search commands');
    const input = dialog.getByLabel('Search commands');
    await input.fill('meeting');
    await expect(
      dialog.locator('[role="option"]').filter({ hasText: 'Review what happened in a meeting' }),
      'the meetings command is offered by task language',
    ).toBeVisible();
    await cert.shot('command search — the meetings destination');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await cert.step('the v1 public API discovery document lists the meeting family');
    const discovery = await page.evaluate(async () => {
      const response = await fetch('/api/v1', { cache: 'no-store' });
      const body = (await response.json()) as { operations?: { operation?: string; path?: string }[] };
      const operations = body.operations ?? [];
      return {
        status: response.status,
        operationCount: operations.length,
        meetingFamily: operations
          .filter((entry) => /meeting/i.test(`${entry.operation ?? ''} ${entry.path ?? ''}`))
          .map((entry) => entry.operation ?? entry.path ?? ''),
      };
    });
    expect(discovery.status, 'the discovery document answers').toBe(200);
    expect(discovery.operationCount).toBeGreaterThan(0);
    expect(
      discovery.meetingFamily,
      'the v1 public API lists the meeting-family operations (W104)',
    ).toEqual(
      expect.arrayContaining([
        'meetings.list',
        'meetings.get',
        'meetings.sessions',
        'meetings.session',
        'meetings.transcripts',
        'meetings.artifacts',
        'meetings.participants',
        'meetings.connections',
        'meetings.accessEvents',
      ]),
    );

    await cert.step('mint a meetings-scoped key through the real developer console');
    await page.goto('/developer');
    await expect(page.getByRole('heading', { name: /developer/i }).first()).toBeVisible();
    await page.getByText('Create an API key').click();
    const keyForm = page.locator('form').filter({ hasText: 'Key label' }).first();
    await keyForm.locator('input[name="label"]').fill(`w106-${runLabel}-meeting-reader`);
    await keyForm.getByLabel('Meetings · read').check();
    await keyForm.getByRole('button', { name: 'Create key' }).click();
    const reveal = page.locator('.aurum-dev-reveal-key').first();
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const rawKey = (await reveal.textContent())?.trim() ?? '';
    expect(rawKey.length, 'the raw key is revealed exactly once').toBeGreaterThan(20);
    // No screenshot at the reveal (contract §9 — no secret in evidence).

    await cert.step('the v1 meeting family answers with real production auth (the honest read)');
    const api = await page.evaluate(async (key) => {
      const headers = { authorization: `Bearer ${key}` };
      const read = async (path: string) => {
        const response = await fetch(path, { cache: 'no-store', headers });
        const body = (await response.json().catch(() => ({}))) as { items?: unknown[] };
        return {
          status: response.status,
          version: response.headers.get('x-aurum-api-version'),
          itemCount: Array.isArray(body.items) ? body.items.length : null,
        };
      };
      return {
        meetings: await read('/api/v1/meetings'),
        participants: await read('/api/v1/meetings/participants'),
        connections: await read('/api/v1/meetings/connections'),
        accessEvents: await read('/api/v1/meetings/access-events'),
      };
    }, rawKey);
    expect(api.meetings.status, 'the meetings-scoped key reads the capture registry').toBe(200);
    expect(api.meetings.version, 'the v1 surface stamps its API version').toBeTruthy();
    expect(api.meetings.itemCount, 'the fresh tenant’s capture registry is honestly empty').toBe(0);
    expect(api.participants.status, 'the participant registry answers').toBe(200);
    expect(api.participants.itemCount, 'the fresh tenant’s participant registry is honestly empty').toBe(0);
    expect(api.connections.status, 'the capture-connection registry answers').toBe(200);
    expect(api.connections.itemCount, 'the fresh tenant’s capture connections are honestly empty').toBe(0);
    expect(api.accessEvents.status, 'the access-failure history answers').toBe(200);
    expect(api.accessEvents.itemCount, 'the fresh tenant’s access history is honestly empty').toBe(0);
    await cert.shot('the developer console — the meetings-scoped key grant recorded');

    await cert.step('revoke the meetings key (nothing minted outlives the journey)');
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.reload();
    const keyRow = page.locator('li.aurum-dev-key', { hasText: `w106-${runLabel}-meeting-reader` }).first();
    await expect(keyRow, 'the key row is on the roster').toBeVisible({ timeout: 30_000 });
    await keyRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(keyRow.getByText('Revoked — retained as evidence.')).toBeVisible({ timeout: 30_000 });

    await cert.step('return to the conversation (cross-surface rule)');
    await page.goto('/meetings');
    await page.getByRole('link', { name: 'Back to the conversation' }).first().click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
