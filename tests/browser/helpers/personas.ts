// W076 — persona authentication through the REAL sign-in surface.
//
// The work item is explicit: "Log in with the seeded demo personas exactly
// as a user does (the /signin quick-access panel) — no token injection, no
// API shortcuts for authentication." Every sign-in in this suite clicks
// the quick-access panel's persona button and waits for the real auth
// round-trip (POST /api/auth/quick-sign-in → session cookie → client
// router.replace to the after-auth target). The persona display names
// come from the demo module's PUBLIC contract (the frozen W068 manifest),
// so the suite cannot drift from the seeded world.

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DEMO_PERSONAS } from '../../../src/modules/demo/contract';
import { AUTH_QUICK, AUTH_QUICK_PERSONA } from './selectors';

/** The seeded demo persona roles (the manifest's role ids). */
export type PersonaRole = (typeof DEMO_PERSONAS)[number]['role'];

/** One persona's display name, from the frozen manifest. */
export function personaName(role: PersonaRole): string {
  const persona = DEMO_PERSONAS.find((candidate) => candidate.role === role);
  if (persona === undefined) {
    throw new Error(`the demo manifest has no persona for role '${role}'`);
  }
  return persona.fullName;
}

/**
 * Sign in as one seeded demo persona through the quick-access panel —
 * the exact clicks a human makes. Ends on the after-auth target (/chat
 * for every persona of the seeded world: each has an active company).
 */
export async function signInViaQuickAccess(page: Page, role: PersonaRole): Promise<void> {
  const name = personaName(role);
  await page.goto('/signin');
  const panel = page.locator(AUTH_QUICK);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Quick access' })).toBeVisible();

  const row = panel.locator(AUTH_QUICK_PERSONA, { hasText: name }).first();
  await expect(row).toBeVisible();
  await row.click();

  // The real auth round-trip: cookie issuance + client-side replace to
  // the after-auth target. Every seeded persona has an active company,
  // so the target is always /chat.
  //
  // HYDRATION RACE GUARD (documented, bounded): a click delivered after
  // first paint but before React hydrates the panel is lost — no state
  // change, no request, no error (provably: zero violations accompany
  // this state). Detect exactly that (still on /signin, no aria-busy
  // pending anywhere) and click ONCE more; then the real flow must run.
  const engaged = await page
    .waitForFunction(
      () =>
        window.location.pathname === '/chat' ||
        document.querySelector('[aria-busy="true"]') !== null,
      { timeout: 8_000, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  if (!engaged) {
    await row.click();
  }
  await page.waitForURL(/\/chat(\?.*)?$/, { timeout: 30_000 });
  await expect(page.locator('.aurum-chat-app')).toBeVisible();
}

/**
 * Sign out through the real affordance (the More hub's Account section →
 * "Sign out"), then land back on the anonymous entry flow.
 */
export async function signOutViaMoreHub(page: Page): Promise<void> {
  await page.goto('/more');
  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(signOut).toBeVisible();
  await signOut.click();
  // The session cookie is cleared and the route gate sends the anonymous
  // visitor to the sign-in surface.
  await page.waitForURL(/\/signin/, { timeout: 30_000 });
}
