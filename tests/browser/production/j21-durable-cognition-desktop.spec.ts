// W101 — J21 · Durable cognition (desktop 1280×800).
//
// The mandatory proof (the W101 matrix): learning/contributions surfaces
// + the v1 missions surface — the company-learning journey.
//
// The real production flow: the Learning hub renders the run tenant's
// live learning state (the mission J07 registered through the public API
// earlier in this run — durable cognition state that SURVIVED the
// journey boundaries), the mission chain page renders its objective,
// acquisitions and beliefs panels, the contributions and rewards panels
// render with their honest states and the explicit no-policy-no-rewards
// note, and the durable-cognition state is machine-reachable with REAL
// production auth: a read key minted through the real developer console
// reads the v1 missions surface live (the mission list + one mission),
// then the key is revoked in-test (nothing minted outlives the journey).
// The journey returns to Chat.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectPageShellA11y } from './a11y';

test.describe('J21 — durable cognition (desktop)', () => {
  test('J21 — the learning surfaces, the mission chain and the v1 missions read with real auth', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in and open the Learning hub');
    await signInRunManager(page);
    await page.goto('/learning');
    await expect(page.getByRole('heading', { name: 'Learning' }).first()).toBeVisible();
    await cert.shot('the Learning hub — the company-learning surface');

    await cert.step('the learning page carries the shell accessibility contract');
    await expectPageShellA11y(page, 'the Learning hub');

    await cert.step('the run tenant’s live mission is on the hub (durable state)');
    await expect(
      page.getByText('Understand the weekly freshness workflow').first(),
      'the mission J07 registered through the public API renders (durable cognition state)',
    ).toBeVisible({ timeout: 30_000 });
    await cert.shot('the live mission — durable across the journey boundaries');

    await cert.step('the contributions and rewards panels render with their honest states');
    await expect(page.getByText('Contributions', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Rewards', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/no policy, no rewards/i).first()).toBeVisible();
    await cert.shot('the contributions and reward state — the honest policy note');

    await cert.step('open the mission chain page');
    const missionLink = page.getByRole('link', {
      name: /Understand the weekly freshness workflow/i,
    }).first();
    await expect(missionLink).toBeVisible();
    await missionLink.click();
    await page.waitForURL(/\/intelligence\/missions\//, { timeout: 60_000 });
    await expect(
      page.getByText('Understand the weekly freshness workflow').first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/The acquisitions the loop ran/i).first()).toBeVisible();
    await expect(page.getByText(/The resulting beliefs/i).first()).toBeVisible();
    await cert.shot('the mission chain — the objective, acquisitions and beliefs');

    await cert.step('mint a read key through the real developer console');
    await page.goto('/developer');
    await expect(page.getByRole('heading', { name: /developer/i }).first()).toBeVisible();
    await page.getByText('Create an API key').click();
    const keyForm = page.locator('form').filter({ hasText: 'Key label' }).first();
    await keyForm.locator('input[name="label"]').fill(`w101-${runLabel}-cognition-reader`);
    await keyForm.getByLabel('Missions · read').check();
    await keyForm.getByRole('button', { name: 'Create key' }).click();
    const reveal = page.locator('.aurum-dev-reveal-key').first();
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const rawKey = (await reveal.textContent())?.trim() ?? '';
    expect(rawKey.length, 'the raw key is revealed exactly once').toBeGreaterThan(20);
    // No screenshot at the reveal (contract §9 — no secret in evidence).

    await cert.step('the v1 missions surface answers with real production auth');
    const missions = await page.evaluate(async (key) => {
      const response = await fetch('/api/v1/missions', {
        cache: 'no-store',
        headers: { authorization: `Bearer ${key}` },
      });
      const body = (await response.json()) as {
        items?: { id?: string; title?: string; content?: { title?: string } }[];
      };
      const list = body.items ?? [];
      return {
        status: response.status,
        count: list.length,
        // The mission read model nests the title under `content`.
        hasRunMission: list.some((entry) =>
          /weekly freshness/i.test(entry.content?.title ?? entry.title ?? ''),
        ),
        firstId: list[0]?.id ?? null,
      };
    }, rawKey);
    expect(missions.status, 'the minted key authorizes on the v1 missions surface').toBe(200);
    expect(missions.hasRunMission, 'the run tenant’s mission is readable through the public API').toBe(true);

    await cert.step('one mission is readable by id through the public API');
    const mission = await page.evaluate(async ({ key, id }) => {
      const response = await fetch(`/api/v1/missions/${id}`, {
        cache: 'no-store',
        headers: { authorization: `Bearer ${key}` },
      });
      return { status: response.status };
    }, { key: rawKey, id: missions.firstId });
    expect(mission.status, 'the mission reads by id').toBe(200);
    await cert.shot('the developer console — the cognition reader grant recorded');

    await cert.step('revoke the read key (nothing minted outlives the journey)');
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.reload();
    const keyRow = page.locator('li.aurum-dev-key', { hasText: `w101-${runLabel}-cognition-reader` }).first();
    await expect(keyRow, 'the key row is on the roster').toBeVisible({ timeout: 30_000 });
    await keyRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(keyRow.getByText('Revoked — retained as evidence.')).toBeVisible({ timeout: 30_000 });

    await cert.step('return to the conversation (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
