// W079 — J05 · Consequential approval (desktop 1280×800).
//
// The mandatory proof (contract §5): recommendation → comparison →
// explicit human decision → activation → outcome. The whole chain runs
// against production through REAL user surfaces only:
//
//   * the manager invites an employee through the onboarding invite
//     manager (the invitation link is read from the page — base64url
//     codes may contain underscores, so the extraction class is wide);
//   * the employee accepts through the real invitation landing page and
//     sign-up flow (their principal becomes the API-key grantee — the
//     separation-of-duties rule forbids the requester deciding);
//   * the manager mints a tenant API key in the developer console with
//     the approvals:write + missions:write scopes, granted to the
//     employee (the raw key is shown ONCE and read from the reveal);
//   * the integration proposal arrives through the PUBLIC API
//     (POST /api/v1/approvals — a real developer surface, exactly how
//     an external system proposes a consequential action);
//   * the recommendation surfaces in Chat as an approval card carrying
//     its comparison and the human authority gate;
//   * the manager decides it INLINE from the card (the explicit human
//     decision), the outcome is acknowledged in place, and the
//     Approvals surface records the decided request with its
//     append-only decision trail.
//
// The journey ends back in Chat (the cross-surface rule).

import { certTest as test, expect } from './fixtures';
import {
  acceptInviteAsEmployee,
  mintEmployee,
  readIssuedInviteLink,
  readRunEmployee,
  signInRunManager,
  signOutViaMore,
  writeRunEmployee,
} from './helpers';
import { CHAT_CARD, CHAT_TIMELINE } from '../helpers/selectors';

const IMPROVE_QUESTION = 'What should we improve?';

test.describe('J05 — consequential approval (desktop)', () => {
  test('J05 — a proposed action waits at the human gate, is decided inline and recorded', async ({
    cert,
  }) => {
    const { page } = cert;
    const runLabel = process.env.W079_RUN_LABEL ?? 'A';

    await cert.step('sign in as the run manager');
    await signInRunManager(page);

    // ---- the employee (the integration grantee + separation of duties) ----
    let employee = await readRunEmployee();
    if (employee === null) {
      await cert.step('invite an employee through the onboarding manager');
      const credentials = mintEmployee(runLabel);
      await page.goto('/onboarding');
      await expect(page.getByRole('heading', { name: 'Your companies' })).toBeVisible();
      await page.locator('#invite-email').fill(credentials.email);
      await page.locator('#invite-role').selectOption('member');
      await page.getByRole('button', { name: 'Create invitation' }).click();
      const inviteLink = await readIssuedInviteLink(page);
      await cert.shot('the issued invitation — shown once');

      await cert.step('the employee accepts through the real invitation flow');
      await signOutViaMore(page);
      employee = await acceptInviteAsEmployee(page, inviteLink, credentials);
      await writeRunEmployee(employee);
      await cert.shot('the employee joined — landing in the company chat');

      await cert.step('sign back in as the manager');
      await signOutViaMore(page);
      await signInRunManager(page);
    } else {
      await cert.step('the run employee already exists (earlier leg of this run)');
    }

    // ---- the API key: minted for the employee through the real console ----
    await cert.step('mint the integration API key in the developer console');
    await page.goto('/developer');
    await expect(page.getByRole('heading', { name: /developer/i }).first()).toBeVisible();
    await page.getByText('Create an API key').click();
    const keyForm = page.locator('form').filter({ hasText: 'Key label' }).first();
    await keyForm.locator('input[name="label"]').fill(`w079-${runLabel}-integration`);
    await keyForm.locator('input[name="principalId"]').fill(employee.principalId);
    // The grant: propose consequential actions + write missions.
    await keyForm.getByLabel('Approvals · write').check();
    await keyForm.getByLabel('Missions · write').check();
    await keyForm.getByRole('button', { name: 'Create key' }).click();
    const reveal = page.locator('.aurum-dev-reveal-key').first();
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const rawKey = (await reveal.textContent())?.trim() ?? '';
    expect(rawKey.length, 'the raw key is revealed exactly once').toBeGreaterThan(20);
    await cert.shot('the key reveal — the grantee-scoped integration credential');
    // Persist the key in the secrets scratch for J07's mission leg (the
    // scratch directory is wiped by the driver after the run — it never
    // enters the evidence tree).
    await writeRunEmployee({ ...employee, apiKey: rawKey });

    // ---- the proposal through the PUBLIC API (a real developer surface) ----
    await cert.step('the integration proposes a consequential action via the public API');
    const propose = await page.evaluate(
      async ({ key, baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/v1/approvals`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            actionKind: 'employee-messaging',
            authorityLevel: 'EXECUTE',
            payload: {
              channel: 'email',
              audience: 'operations-team',
              subject: 'Weekly freshness digest',
            },
            justification:
              'Send the weekly freshness digest to the operations team. Compared: sending it ' +
              'automatically every Monday (recommended — the data is already verified), asking ' +
              'a person to compile it (slower, no added accuracy), or not sending it at all ' +
              '(the team loses visibility). Requires an explicit human decision: outbound ' +
              'communication is a consequential action.',
          }),
        });
        const body = (await response.json()) as { requestId?: string; id?: string };
        return { status: response.status, requestId: body.requestId ?? body.id ?? null };
      },
      { key: rawKey, baseUrl: process.env.W079_BASE_URL ?? '' },
    );
    expect(propose.status, 'the public API accepts the proposal (200/201)').toBeLessThan(300);
    expect(propose.requestId, 'the proposal returns its action request id').toBeTruthy();

    // ---- the recommendation surfaces in Chat with the human gate ----
    await cert.step('the recommendation arrives in the conversation');
    await page.goto('/chat');
    await page.locator('#aurum-chat-input').fill(IMPROVE_QUESTION);
    await page.locator('#aurum-chat-input').press('Enter');
    const approvalCard = page
      .locator(CHAT_CARD, { hasText: /employee-messaging|Employee messaging/i })
      .first();
    await expect(approvalCard).toBeVisible({ timeout: 90_000 });
    await expect(approvalCard).toContainText(/Needs your decision|Awaiting decision/i);
    await expect(approvalCard).toContainText(/Compared:|recommend/i);
    await cert.shot('the approval card — the comparison, waiting at the human gate');

    // ---- the explicit human decision, cast inline from the card ----
    await cert.step('the manager decides the request inline (explicit human decision)');
    const approve = approvalCard.locator('.aurum-chat-decide[data-decision="approve"]');
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(approvalCard).toContainText(/approved/i, { timeout: 60_000 });
    await expect(approvalCard.locator('.aurum-chat-decide[data-decision="approve"]')).toHaveCount(0);
    await cert.shot('the decision — acknowledged in place');

    // ---- the outcome on the governance surface ----
    await cert.step('the Approvals surface records the decided request (the outcome)');
    await page.goto('/approvals');
    await expect(page.getByText(/Recently decided/i).first()).toBeVisible();
    await expect(
      page.getByText(/employee-messaging|Employee messaging/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    await cert.shot('the Approvals surface — the append-only decision trail');

    await cert.step('return to the conversation (cross-surface rule)');
    await page.goto('/chat');
    await expect(
      page.locator(CHAT_TIMELINE).getByText(IMPROVE_QUESTION).first(),
    ).toBeVisible({ timeout: 30_000 });
    cert.expectZeroViolations();
  });
});
