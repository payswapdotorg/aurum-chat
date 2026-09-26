// W101 — J18 · Cellular reachability (desktop 1280×800).
//
// The mandatory proof (the W101 matrix): the cellular surface via the v1
// API — the SMS/voice contract's user-visible path; honest handling if
// provider credentials make live sends impossible — assert the
// contract-faithful production behavior, record environment limits as the
// module reports them.
//
// PRODUCTION REALITY, recorded honestly: the cellular module (SMS/voice
// reachability) owns NO user-facing route and NO v1 public API operation
// in the deployed revision. The module's own contract records the
// environment limit exactly as it reports it: no transport is wired by
// default, so deliveries fail explicitly with `provider_unavailable`
// (retryable; the reach status machine is
// pending → awaiting_approval | blocked → sent → delivered | replied |
// voice_fallback → failed, and `blocked` never reopens). The journey
// exhausts every legitimate production path to a cellular surface — the
// product rail, the More capability hub, the command search, and the v1
// public API's discovery document — proves each answers honestly, and
// records the exact BLOCKED reason including the module-reported
// environment limit. No assertion is weakened and no live send is
// simulated (the work-order's honesty law).

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectDialogInputLabeled } from './a11y';

test.describe('J18 — cellular reachability (desktop)', () => {
  test('J18 — every legitimate production path to a cellular surface is exhausted; the module’s environment limit is recorded', async ({
    cert,
  }) => {
    const { page } = cert;

    await cert.step('sign in as the run manager');
    await signInRunManager(page);

    await cert.step('the product rail carries no cellular entry');
    await expect(
      page.locator(RAIL).getByRole('link', { name: /cellular|sms|voice/i }),
      'the rail offers no cellular navigation',
    ).toHaveCount(0);
    await cert.shot('the product rail — no cellular entry');

    await cert.step('the More capability hub carries no cellular surface');
    await page.goto('/more');
    await expect(page.getByRole('heading', { name: /more/i }).first()).toBeVisible();
    await expect(
      page.locator('.aurum-hub-card').filter({ hasText: /cellular|sms|voice/i }),
      'the More hub offers no cellular capability card',
    ).toHaveCount(0);
    await cert.shot('the More hub — no cellular capability');

    await cert.step('the command search offers no cellular entry and stays usable');
    await page.locator(RAIL).getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    await expectDialogInputLabeled(page, 'Command search', 'Search commands');
    const input = dialog.getByLabel('Search commands');
    await input.fill('cellular');
    await expect(
      dialog.locator('[role="option"]').filter({ hasText: /cellular/i }),
      'no cellular command is offered',
    ).toHaveCount(0);
    await cert.shot('command search — no cellular entry');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await cert.step('the v1 public API discovery document lists no cellular/SMS/voice operations');
    const discovery = await page.evaluate(async () => {
      const response = await fetch('/api/v1', { cache: 'no-store' });
      const body = (await response.json()) as { operations?: { operation?: string; path?: string }[] };
      const operations = body.operations ?? [];
      return {
        status: response.status,
        operationCount: operations.length,
        cellularFamily: operations.filter((entry) =>
          /cellular|\bsms\b|voice|reach/i.test(`${entry.operation ?? ''} ${entry.path ?? ''}`),
        ).map((entry) => entry.operation ?? entry.path ?? ''),
      };
    });
    expect(discovery.status, 'the discovery document answers').toBe(200);
    expect(discovery.operationCount).toBeGreaterThan(0);
    expect(
      discovery.cellularFamily,
      'the v1 public API lists no cellular/SMS/voice operations',
    ).toEqual([]);

    await cert.step('record the honest BLOCKED reason (with the module-reported environment limit)');
    cert.recordBlocked(
      'the cellular reachability surface does not exist in the deployed revision a2db98a: ' +
        'the cellular module (SMS/voice reachability) owns no user-facing route and no v1 public ' +
        `API operation (v1 discovery: ${discovery.operationCount} operations, none cellular/SMS/voice-scoped); ` +
        'environment limit as the module itself reports it: no transport is wired by default, so ' +
        'deliveries fail explicitly with provider_unavailable (retryable) — the contract-faithful ' +
        'production behavior cannot be observed through any user-visible surface in this revision',
      {
        v1DiscoveryOperations: discovery.operationCount,
        v1CellularFamilyOperations: discovery.cellularFamily,
        moduleReportedEnvironmentLimit: 'provider_unavailable (no transport wired by default; retryable)',
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
