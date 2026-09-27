// W106 — J16 · Cross-channel communication (desktop 1280×800).
//
// The mandatory proof (the W101 matrix, unchanged): the connection hub
// channel surfaces + the v1 public API channel surfaces, with real
// production auth (ride the EXISTING routes; do not invent pages).
//
// PRODUCTION REALITY at the certified revision (W103 live): the
// connection hub's channel family is fully provable through the real UI
// — a second channel is registered through the real form with its opaque
// credential reference, verified in the hub state, stable across reload,
// and the hub's session envelope carries the tenant id. The v1 public
// API now owns the channel family (W103): its discovery document lists
// channels.list/get/register/status, and a key minted through the real
// developer console with the channels scopes proves the family live —
// the tenant-scoped roster read, a register (201, created), a get, and
// the status transition (disable → re-enable) — every row carrying THIS
// tenant's id (the tenant-scoping probe on the API surface). The key is
// revoked in-test; nothing minted outlives the journey.
//
// HONESTY DISCIPLINE: if production refuses the channels-scoped key
// creation (the deployed database's own api_keys_scopes_check rejecting
// the scope family its code serves), the journey FAILS with the exact
// production error in the assertion message — a deployment defect is
// FAILED, never laundered to BLOCKED or PASS.

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectPageShellA11y } from './a11y';

test.describe('J16 — cross-channel communication (desktop)', () => {
  test('J16 — the connection hub channel family and the v1 channel surfaces are proven with real production auth', async ({
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
    // The walk runs on a hard-loaded, settled DOM (a soft navigation's
    // React morph can transiently reset focus mid-walk — the probe
    // discipline: same surface, deterministic load vehicle).
    await page.goto('/connections');
    await expect(page.getByRole('heading', { name: /connections/i }).first()).toBeVisible();
    await expectPageShellA11y(page, 'the Connections hub');

    await cert.step('register a second channel through the real form');
    await page.locator('summary', { hasText: 'Connect a channel' }).first().click();
    await page.locator('#channel-connect-provider').selectOption('slack');
    // The Slack provider's canonical account id is its U-prefixed,
    // uppercase-alphanumeric member id (the adapter's own contract).
    await page.locator('#channel-connect-account').fill(`W106${runLabel.toUpperCase()}DESK`);
    await page.locator('#channel-connect-name').fill('Cross-channel certification desk');
    await page.locator('#channel-connect-credential').fill('secret-store://w106/cert/slack');
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

    await cert.step('the v1 discovery document lists the channel family');
    const discovery = await page.evaluate(async () => {
      const response = await fetch('/api/v1', { cache: 'no-store' });
      const body = (await response.json()) as { operations?: { operation?: string; path?: string }[] };
      const operations = body.operations ?? [];
      return {
        status: response.status,
        operationCount: operations.length,
        channelFamily: operations
          .filter((entry) => /channel/i.test(`${entry.operation ?? ''} ${entry.path ?? ''}`))
          .map((entry) => entry.operation ?? entry.path ?? ''),
      };
    });
    expect(discovery.status, 'the discovery document answers').toBe(200);
    expect(discovery.operationCount, 'the discovery document lists its operations').toBeGreaterThan(0);
    expect(
      discovery.channelFamily,
      'the v1 public API lists the channel-family operations (W103)',
    ).toEqual(
      expect.arrayContaining(['channels.list', 'channels.get', 'channels.register', 'channels.status']),
    );
    await cert.shot('the v1 discovery — the channel family listed');

    await cert.step('mint a channels-scoped key through the real developer console');
    await page.goto('/developer');
    await expect(page.getByRole('heading', { name: /developer/i }).first()).toBeVisible();
    await page.getByText('Create an API key').click();
    const keyForm = page.locator('form').filter({ hasText: 'Key label' }).first();
    await keyForm.locator('input[name="label"]').fill(`w106-${runLabel}-channel-writer`);
    await keyForm.getByLabel('Channels · read').check();
    await keyForm.getByLabel('Channels · write').check();
    const [keyResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes('/api/product/developer') && response.request().method() === 'POST',
      ),
      keyForm.getByRole('button', { name: 'Create key' }).click(),
    ]);
    const keyErrorBody = await keyResponse.text();
    expect(
      keyResponse.status(),
      'the channels-scoped key creation must succeed through the real developer console — ' +
        `production answered: ${keyErrorBody.slice(0, 300)}`,
    ).toBe(200);
    const reveal = page.locator('.aurum-dev-reveal-key').first();
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const rawKey = (await reveal.textContent())?.trim() ?? '';
    expect(rawKey.length, 'the raw key is revealed exactly once').toBeGreaterThan(20);
    // No screenshot at the reveal (contract §9 — no secret in evidence).
    await cert.shot('the developer console — the channels-scoped key grant recorded');

    await cert.step('the v1 channel family answers with real production auth (the tenant-scoped round-trip)');
    const tenantId = envelope.tenantId ?? '';
    const channelEmail = `w106.${runLabel.toLowerCase()}.api@aurum-cert.test`;
    const api = await page.evaluate(
      async ({ key, email }) => {
        const authorization = { authorization: `Bearer ${key}` };
        const json = async (response: Response): Promise<Record<string, unknown>> =>
          (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const initial = await fetch('/api/v1/channels', { cache: 'no-store', headers: authorization });
        const initialBody = (await json(initial)) as { items?: Record<string, unknown>[] };
        const items = initialBody.items ?? [];
        const registered = await fetch('/api/v1/channels', {
          method: 'POST',
          headers: { ...authorization, 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'email',
            providerAccountId: email,
            displayName: 'W106 v1 certification inbox',
            credentialRef: 'secret-store://w106/cert/email',
          }),
        });
        const registeredBody = (await json(registered)) as {
          connection?: { id?: string; tenantId?: string; status?: string };
          created?: boolean;
        };
        const connectionId = registeredBody.connection?.id ?? '';
        const fetched = await fetch(`/api/v1/channels/${connectionId}`, {
          cache: 'no-store',
          headers: authorization,
        });
        const fetchedBody = (await json(fetched)) as { tenantId?: string; status?: string };
        const disabled = await fetch(`/api/v1/channels/${connectionId}/status`, {
          method: 'PATCH',
          headers: { ...authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'disabled' }),
        });
        const disabledBody = (await json(disabled)) as { status?: string };
        const reEnabled = await fetch(`/api/v1/channels/${connectionId}/status`, {
          method: 'PATCH',
          headers: { ...authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        });
        const reEnabledBody = (await json(reEnabled)) as { status?: string };
        const finalList = await fetch('/api/v1/channels', { cache: 'no-store', headers: authorization });
        const finalBody = (await json(finalList)) as { items?: Record<string, unknown>[] };
        const finalItems = finalBody.items ?? [];
        return {
          listStatus: initial.status,
          initialCount: items.length,
          initialTenantIds: items.map((item) => String(item['tenantId'] ?? '')),
          slackRegisteredViaHub: items.some(
            (item) => String(item['displayName'] ?? '') === 'Cross-channel certification desk',
          ),
          registerStatus: registered.status,
          created: registeredBody.created === true,
          registeredTenantId: registeredBody.connection?.tenantId ?? null,
          getStatus: fetched.status,
          getTenantId: fetchedBody.tenantId ?? null,
          disableStatus: disabled.status,
          disabledState: disabledBody.status ?? null,
          reEnableStatus: reEnabled.status,
          reEnabledState: reEnabledBody.status ?? null,
          finalCount: finalItems.length,
          finalTenantIds: finalItems.map((item) => String(item['tenantId'] ?? '')),
          v1InboxOnRoster: finalItems.some(
            (item) => String(item['displayName'] ?? '') === 'W106 v1 certification inbox',
          ),
        };
      },
      { key: rawKey, email: channelEmail },
    );
    expect(api.listStatus, 'the channels-scoped key reads the tenant roster').toBe(200);
    expect(api.initialCount, 'the roster carries the hub-registered channels').toBeGreaterThanOrEqual(2);
    expect(api.slackRegisteredViaHub, 'the Slack channel registered through the hub UI is on the v1 roster').toBe(true);
    expect(
      api.initialTenantIds.every((id) => id === tenantId && id !== ''),
      'every roster row carries THIS tenant’s id (the v1 tenant-scoping probe)',
    ).toBe(true);
    expect(api.registerStatus, 'channels.register answers 201 (CREATED)').toBe(201);
    expect(api.created, 'the first registration of the endpoint reports created=true').toBe(true);
    expect(api.registeredTenantId, 'the registered connection carries THIS tenant’s id').toBe(tenantId);
    expect(api.getStatus, 'channels.get answers 200 for the registered id').toBe(200);
    expect(api.getTenantId, 'the fetched connection carries THIS tenant’s id').toBe(tenantId);
    expect(api.disableStatus, 'channels.status answers 200 on the disable transition').toBe(200);
    expect(api.disabledState, 'the connection reports the disabled state').toBe('disabled');
    expect(api.reEnableStatus, 'channels.status answers 200 on the re-enable transition').toBe(200);
    expect(api.reEnabledState, 'the connection reports the active state again').toBe('active');
    expect(api.finalCount, 'the roster carries the v1-registered channel after the round-trip').toBe(
      api.initialCount + 1,
    );
    expect(api.v1InboxOnRoster, 'the v1-registered inbox is on the final roster').toBe(true);
    expect(
      api.finalTenantIds.every((id) => id === tenantId && id !== ''),
      'every final roster row still carries THIS tenant’s id',
    ).toBe(true);
    await cert.shot('the v1 channel family — the tenant-scoped round-trip recorded');

    await cert.step('revoke the channels key (nothing minted outlives the journey)');
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.reload();
    const keyRow = page.locator('li.aurum-dev-key', { hasText: `w106-${runLabel}-channel-writer` }).first();
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
