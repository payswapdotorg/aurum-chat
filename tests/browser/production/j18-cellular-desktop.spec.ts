// W106 — J18 · Cellular reachability (desktop 1280×800).
//
// The mandatory proof (the W101 matrix, unchanged): the cellular surface
// via the v1 API — the SMS/voice contract's user-visible path; honest
// handling if provider credentials make live sends impossible — assert
// the contract-faithful production behavior, record environment limits
// as the module reports them.
//
// PRODUCTION REALITY at the certified revision (W104 live): the cellular
// surface EXISTS as a user-visible path. The More capability hub carries
// the cellular card (task language: "Reach someone by text or voice
// call") and navigates to /cellular; the command search offers the same
// destination; the /cellular page renders the reach feed, the sending
// connections, and the routing/cost policies with their honest states;
// the page carries the shell accessibility contract; and the v1 public
// API lists the cellular family (8 operations), which a key minted
// through the real developer console with the cellular scopes proves
// live with real production auth — the honest reads (reach, policies)
// and the one write the family owns (connection registration: 201,
// created, read-back, and the page reflects the v1-written state after
// reload — the surface and the API agree).
//
// THE ENVIRONMENT LIMIT, recorded exactly as the module reports it: no
// telecom transport is wired by default in this environment, so every
// delivery attempt fails explicitly with provider_unavailable (a
// retryable state recorded on the reach and on each attempt row). The
// page renders that note verbatim; the journey records it as evidence.
// No live send is simulated and none is faked (the honesty law).

import { certTest as test, expect } from './fixtures';
import { signInRunManager } from './helpers';
import { CHAT_TIMELINE, RAIL } from '../helpers/selectors';
import { expectDialogInputLabeled, expectPageShellA11y } from './a11y';

test.describe('J18 — cellular reachability (desktop)', () => {
  test('J18 — the cellular surface is proven through the hub, the command search, the page and the v1 API; the environment limit is recorded as the module reports it', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in as the run manager');
    await signInRunManager(page);

    await cert.step('the More capability hub carries the cellular surface');
    await page.goto('/more');
    await expect(page.getByRole('heading', { name: /more/i }).first()).toBeVisible();
    const cellularCard = page
      .locator('.aurum-hub-card')
      .filter({ hasText: 'Reach someone by text or voice call' })
      .first();
    await expect(cellularCard, 'the More hub offers the cellular capability card').toBeVisible();
    await cellularCard.click();
    await page.waitForURL(/\/cellular/);
    await cert.shot('the More hub — the cellular capability navigates to the surface');

    await cert.step('the cellular page renders the reachability state families');
    await expect(
      page.getByRole('heading', { name: 'Cellular reachability' }).first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reach requests' }).first()).toBeVisible();
    await expect(page.getByText('No reach requests recorded').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sending connections' }).first()).toBeVisible();
    await expect(page.getByText('No telecom account is registered').first()).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Routing and cost policies' }).first(),
    ).toBeVisible();
    await expect(page.getByText('No tenant policy rows — the built-in floor governs').first()).toBeVisible();
    // The honest empty states carry their unblocking affordances (no dead
    // ends): the telecom path points at the connection hub.
    await expect(page.getByRole('link', { name: 'Connect a telecom account' }).first()).toBeVisible();
    await cert.shot('the cellular surface — the state families with their honest empty states');

    await cert.step('the module-reported environment limit is on the record, verbatim');
    // The page states the transport note exactly as the cellular module
    // reports it: provider_unavailable, retryable, never a faked delivery.
    await expect(
      page.getByText(/No telecom transport is wired by default/i).first(),
      'the transport note is rendered',
    ).toBeVisible();
    await expect(
      page.getByText(/provider_unavailable/i).first(),
      'the module’s provider_unavailable state is named on the surface',
    ).toBeVisible();
    await cert.shot('the cellular surface — the module-reported environment limit');

    await cert.step('the cellular page carries the shell accessibility contract');
    // The walk runs on a hard-loaded, settled DOM (a soft navigation's
    // React morph can transiently reset focus mid-walk — same surface,
    // deterministic load vehicle).
    await page.goto('/cellular');
    await expect(
      page.getByRole('heading', { name: 'Cellular reachability' }).first(),
    ).toBeVisible();
    await expectPageShellA11y(page, 'the cellular surface');

    await cert.step('the page’s session envelope carries the active tenant id');
    const envelope = await page.evaluate(async () => {
      const response = await fetch('/api/connections', { cache: 'no-store' });
      const body = (await response.json()) as { surface?: string; tenantId?: string };
      return { status: response.status, surface: body.surface ?? null, tenantId: body.tenantId ?? null };
    });
    expect(envelope.status, 'the connections surface answers the session request').toBe(200);
    expect(envelope.tenantId, 'the envelope carries the active tenant id').toBeTruthy();

    await cert.step('the command search speaks task language and offers the cellular destination');
    await page.locator(RAIL).getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Command search' });
    await expect(dialog).toBeVisible();
    await expectDialogInputLabeled(page, 'Command search', 'Search commands');
    const input = dialog.getByLabel('Search commands');
    await input.fill('cellular');
    await expect(
      dialog.locator('[role="option"]').filter({ hasText: 'Reach someone by text or voice call' }),
      'the cellular command is offered by task language',
    ).toBeVisible();
    await cert.shot('command search — the cellular destination');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await cert.step('the v1 public API discovery document lists the cellular family');
    const discovery = await page.evaluate(async () => {
      const response = await fetch('/api/v1', { cache: 'no-store' });
      const body = (await response.json()) as { operations?: { operation?: string; path?: string }[] };
      const operations = body.operations ?? [];
      return {
        status: response.status,
        operationCount: operations.length,
        cellularFamily: operations
          .filter((entry) => /cellular|\bsms\b|voice|reach/i.test(`${entry.operation ?? ''} ${entry.path ?? ''}`))
          .map((entry) => entry.operation ?? entry.path ?? ''),
      };
    });
    expect(discovery.status, 'the discovery document answers').toBe(200);
    expect(discovery.operationCount).toBeGreaterThan(0);
    expect(
      discovery.cellularFamily,
      'the v1 public API lists the cellular-family operations (W104)',
    ).toEqual(
      expect.arrayContaining([
        'cellular.connections.list',
        'cellular.connections.register',
        'cellular.connections.get',
        'cellular.reach.list',
        'cellular.reach.get',
        'cellular.reach.attempts',
        'cellular.reach.replies',
        'cellular.policies.list',
      ]),
    );

    await cert.step('mint a cellular-scoped key through the real developer console');
    await page.goto('/developer');
    await expect(page.getByRole('heading', { name: /developer/i }).first()).toBeVisible();
    await page.getByText('Create an API key').click();
    const keyForm = page.locator('form').filter({ hasText: 'Key label' }).first();
    await keyForm.locator('input[name="label"]').fill(`w106-${runLabel}-cellular-writer`);
    await keyForm.getByLabel('Cellular · read').check();
    await keyForm.getByLabel('Cellular · write').check();
    await keyForm.getByRole('button', { name: 'Create key' }).click();
    const reveal = page.locator('.aurum-dev-reveal-key').first();
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const rawKey = (await reveal.textContent())?.trim() ?? '';
    expect(rawKey.length, 'the raw key is revealed exactly once').toBeGreaterThan(20);
    // No screenshot at the reveal (contract §9 — no secret in evidence).

    await cert.step('the v1 cellular family answers with real production auth (the honest read + the one write)');
    const tenantId = envelope.tenantId ?? '';
    const api = await page.evaluate(async ({ key, tenant }) => {
      const headers = { authorization: `Bearer ${key}` };
      const json = async (response: Response): Promise<Record<string, unknown>> =>
        (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const reach = await fetch('/api/v1/cellular/reach', { cache: 'no-store', headers });
      const reachBody = (await json(reach)) as { items?: unknown[] };
      const policies = await fetch('/api/v1/cellular/policies', { cache: 'no-store', headers });
      const registered = await fetch('/api/v1/cellular/connections', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'twilio',
          providerAccountId: 'w106-cert-twilio',
          phoneNumber: '+15550001234',
          displayName: 'W106 certification telecom',
          credentialRef: 'secret-store://w106/cert/twilio',
        }),
      });
      const registeredBody = (await json(registered)) as {
        connection?: { id?: string; tenantId?: string; status?: string; phoneNumber?: string };
        created?: boolean;
      };
      const connectionId = registeredBody.connection?.id ?? '';
      const fetched = await fetch(`/api/v1/cellular/connections/${connectionId}`, {
        cache: 'no-store',
        headers,
      });
      const fetchedBody = (await json(fetched)) as { tenantId?: string; status?: string };
      const listed = await fetch('/api/v1/cellular/connections', { cache: 'no-store', headers });
      const listedBody = (await json(listed)) as { items?: Record<string, unknown>[] };
      const items = listedBody.items ?? [];
      return {
        reachStatus: reach.status,
        reachItemCount: Array.isArray(reachBody.items) ? reachBody.items.length : null,
        policiesStatus: policies.status,
        registerStatus: registered.status,
        created: registeredBody.created === true,
        registeredTenantId: registeredBody.connection?.tenantId ?? null,
        registeredNumber: registeredBody.connection?.phoneNumber ?? null,
        getStatus: fetched.status,
        getTenantId: fetchedBody.tenantId ?? null,
        listStatus: listed.status,
        listCount: items.length,
        listTenantIds: items.map((item) => String(item['tenantId'] ?? '')),
        certificationTelecomOnList: items.some(
          (item) => String(item['displayName'] ?? '') === 'W106 certification telecom',
        ),
        tenant,
      };
    }, { key: rawKey, tenant: tenantId });
    expect(api.reachStatus, 'the cellular-scoped key reads the reach feed').toBe(200);
    expect(api.reachItemCount, 'the fresh tenant’s reach feed is honestly empty').toBe(0);
    expect(api.policiesStatus, 'the policy rows answer').toBe(200);
    expect(api.registerStatus, 'cellular.connections.register answers 201 (CREATED)').toBe(201);
    expect(api.created, 'the first registration of the account reports created=true').toBe(true);
    expect(api.registeredTenantId, 'the registered connection carries the tenant id').toBeTruthy();
    expect(api.registeredNumber, 'the E.164 sending number is stored as given').toBe('+15550001234');
    expect(api.getStatus, 'cellular.connections.get answers 200 for the registered id').toBe(200);
    expect(api.getTenantId, 'the fetched connection carries the tenant id').toBeTruthy();
    expect(api.listStatus, 'the connection roster answers').toBe(200);
    expect(api.listCount, 'the roster carries the v1-registered connection').toBe(1);
    expect(api.certificationTelecomOnList, 'the registered telecom account is on the roster').toBe(true);
    expect(
      api.listTenantIds.every((id) => id !== '' && id === tenantId),
      'every roster row carries THIS tenant’s id (the v1 tenant-scoping probe)',
    ).toBe(true);
    expect(
      api.registeredTenantId === tenantId && api.getTenantId === tenantId,
      'the registered and fetched connections carry THIS tenant’s id',
    ).toBe(true);
    await cert.shot('the v1 cellular family — the honest read and the registered connection');

    await cert.step('the page reflects the v1-written state (the surface and the API agree)');
    await page.goto('/cellular');
    await expect(
      page.getByText('W106 certification telecom').first(),
      'the v1-registered connection is on the page’s sending roster',
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('+15550001234').first()).toBeVisible();
    await expect(page.getByText('Sending').first()).toBeVisible();
    await cert.shot('the cellular surface — the v1-written state rendered');

    await cert.step('revoke the cellular key (nothing minted outlives the journey)');
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.goto('/developer');
    const keyRow = page.locator('li.aurum-dev-key', { hasText: `w106-${runLabel}-cellular-writer` }).first();
    await expect(keyRow, 'the key row is on the roster').toBeVisible({ timeout: 30_000 });
    await keyRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(keyRow.getByText('Revoked — retained as evidence.')).toBeVisible({ timeout: 30_000 });

    await cert.step('return to the conversation (cross-surface rule)');
    await page.goto('/cellular');
    await page.getByRole('link', { name: 'Back to the conversation' }).first().click();
    await page.waitForURL(/\/chat/);
    await expect(page.locator(CHAT_TIMELINE)).toBeVisible();
    cert.expectZeroViolations();
  });
});
