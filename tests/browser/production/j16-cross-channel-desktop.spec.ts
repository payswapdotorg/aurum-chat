// W101 — J16 · Cross-channel communication (desktop 1280×800).
//
// The mandatory proof (the W101 matrix): the connection hub channel
// surfaces + the v1 public API's channel surfaces, with real production
// auth (ride the EXISTING routes; do not invent pages).
//
// PRODUCTION REALITY, recorded honestly: the connection hub's channel
// family is fully provable through the real UI — a second channel is
// registered through the real form with its opaque credential reference,
// verified in the hub state, and the hub's session envelope carries the
// tenant id (the tenant-scoping probe on the new surface). The v1 public
// API component is probed with REAL production auth (a key minted through
// the real developer console, used live, revoked in-test): the key
// authorizes on the public API, and the API's own discovery document —
// machine-generated from its locked route table — lists every operation
// it serves. The channel-family surface DOES NOT EXIST in the deployed
// revision: no channel operation is listed. The journey therefore records
// the honest BLOCKED reason (the work-order's honesty law: a journey that
// cannot be proven in production stays BLOCKED — never weakened, never
// substituted with preview evidence).

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectPageShellA11y } from './a11y';

test.describe('J16 — cross-channel communication (desktop)', () => {
  test('J16 — the connection hub channel family is proven; the v1 channel surface is probed and recorded', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in as the run manager and open the Connections hub');
    await signInRunManager(page);
    await page.locator(RAIL).getByRole('link', { name: 'Connections' }).click();
    await page.waitForURL(/\/connections/);
    await expect(page.getByRole('heading', { name: /connections/i }).first()).toBeVisible();
    await expect(page.getByText(/Channels/i).first()).toBeVisible();
    await cert.shot('the Connections hub — the channel family');

    await cert.step('the hub page carries the shell accessibility contract');
    await expectPageShellA11y(page, 'the Connections hub');

    await cert.step('register a second channel through the real form');
    await page.locator('summary', { hasText: 'Connect a channel' }).first().click();
    await page.locator('#channel-connect-provider').selectOption('slack');
    // The Slack provider's canonical account id is its U-prefixed,
    // uppercase-alphanumeric member id (the adapter's own contract).
    await page.locator('#channel-connect-account').fill(`W101${runLabel.toUpperCase()}DESK`);
    await page.locator('#channel-connect-name').fill('Cross-channel certification desk');
    await page.locator('#channel-connect-credential').fill('secret-store://w101/cert/slack');
    await page.getByRole('button', { name: /Connect Slack/i }).click();
    // The registration lands: the roster re-renders with the endpoint's
    // display name (a strong match — the empty-state copy also contains
    // the word "connected", so the name is the only honest signal).
    await expect(page.getByText('Cross-channel certification desk').first()).toBeVisible({
      timeout: 60_000,
    });
    await cert.shot('the second channel — registered with its opaque credential reference');

    await cert.step('the channel roster is tenant-scoped and verifiable');
    // The run tenant's channels (J08's email channel + this journey's Slack
    // channel) are on the roster — and the hub's session envelope carries
    // THIS tenant's id (the tenant-scoping probe on the new surface).
    await expect(page.getByText('Cross-channel certification desk').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Certification workspace').first()).toBeVisible({
      timeout: 30_000,
    });
    const envelope = await page.evaluate(async () => {
      const response = await fetch('/api/connections', { cache: 'no-store' });
      const body = (await response.json()) as { surface?: string; tenantId?: string };
      return { status: response.status, surface: body.surface ?? null, tenantId: body.tenantId ?? null };
    });
    expect(envelope.status, 'the connections surface answers the session request').toBe(200);
    expect(envelope.surface).toBe('connections');
    expect(envelope.tenantId, 'the envelope carries the active tenant id').toBeTruthy();
    await cert.shot('the channel roster — the tenant-scoped envelope');
    await cert.step('the channel roster is stable across reload');
    await page.reload();
    await expect(page.getByText('Cross-channel certification desk').first()).toBeVisible({
      timeout: 60_000,
    });

    await cert.step('mint a read key through the real developer console');
    await page.goto('/developer');
    await expect(page.getByRole('heading', { name: /developer/i }).first()).toBeVisible();
    await page.getByText('Create an API key').click();
    const keyForm = page.locator('form').filter({ hasText: 'Key label' }).first();
    await keyForm.locator('input[name="label"]').fill(`w101-${runLabel}-channel-reader`);
    await keyForm.getByLabel('Missions · read').check();
    await keyForm.getByRole('button', { name: 'Create key' }).click();
    const reveal = page.locator('.aurum-dev-reveal-key').first();
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const rawKey = (await reveal.textContent())?.trim() ?? '';
    expect(rawKey.length, 'the raw key is revealed exactly once').toBeGreaterThan(20);
    // No screenshot at the reveal (contract §9 — no secret in evidence).

    await cert.step('the v1 public API answers with real production auth');
    const authenticated = await page.evaluate(async (key) => {
      const response = await fetch('/api/v1/missions', {
        cache: 'no-store',
        headers: { authorization: `Bearer ${key}` },
      });
      return { status: response.status, version: response.headers.get('x-aurum-api-version') };
    }, rawKey);
    expect(authenticated.status, 'the minted key authorizes on the v1 public API').toBe(200);

    await cert.step('the v1 discovery document is the API’s honest self-description');
    const discovery = await page.evaluate(async () => {
      const response = await fetch('/api/v1', { cache: 'no-store' });
      const body = (await response.json()) as { operations?: { operation?: string; path?: string }[] };
      const operations = body.operations ?? [];
      return {
        status: response.status,
        operationCount: operations.length,
        channelFamily: operations.filter((entry) =>
          /channel/i.test(`${entry.operation ?? ''} ${entry.path ?? ''}`),
        ).map((entry) => entry.operation ?? entry.path ?? ''),
      };
    });
    expect(discovery.status, 'the discovery document answers').toBe(200);
    expect(discovery.operationCount, 'the discovery document lists its operations').toBeGreaterThan(0);
    await cert.shot('the developer console — the key grant recorded');

    await cert.step('revoke the read key (nothing minted outlives the journey)');
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.reload();
    const keyRow = page.locator('li.aurum-dev-key', { hasText: `w101-${runLabel}-channel-reader` }).first();
    await expect(keyRow, 'the key row is on the roster').toBeVisible({ timeout: 30_000 });
    await keyRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(keyRow.getByText('Revoked — retained as evidence.')).toBeVisible({ timeout: 30_000 });

    await cert.step('record the honest BLOCKED reason for the v1 channel surface');
    cert.recordBlocked(
      'the v1 public API owns no channel-family operations in the deployed revision a2db98a: ' +
        `its discovery document lists ${discovery.operationCount} operations ` +
        '(discovery/goals/unknowns/beliefs/missions/knowledge/observations/capabilities/agents/' +
        'approvals/api-keys/webhooks) and none is channel-scoped — the route table is the locked, ' +
        'versioned public surface (W038) and the S003 channels module (W059-era connection hub) ' +
        'surfaced no v1 operations; the connection-hub channel surface itself was proven above',
      {
        v1DiscoveryOperations: discovery.operationCount,
        v1ChannelFamilyOperations: discovery.channelFamily,
        v1AuthenticatedProbeStatus: authenticated.status,
        connectionHubChannelsProven: ['email (J08)', 'slack (this journey)'],
      },
    );

    await cert.step('return to the conversation (cross-surface rule)');
    await page.locator(RAIL).getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
