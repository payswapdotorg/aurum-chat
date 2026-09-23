// W079 — the PRODUCTION authentication and tenant helpers.
//
// The certification contract (G3) is absolute: authentication happens
// through the REAL production auth flow — fresh registration through
// /signup, sign-in through /signin, company creation through /onboarding,
// sign-out through the real button. No quick-access panel (it is
// fail-closed in production by design), no API/token bypass, no seeded
// demo tenant.
//
// TENANT MODEL: every certification RUN (A and B) creates its OWN fresh
// manager + company through the real flow (J01 performs it and records
// the credentials in the run's SECRETS scratch directory — never in the
// evidence tree; the driver wipes the scratch directory after the run).
// A fresh tenant per run is not a convenience: one-shot approvals and
// knowledge requests are consumed by their decisions, so a re-run against
// a recycled tenant would dead-end honestly. The second tenant J13 needs
// is created inside J13 itself the same honest way.
//
// Credentials are assembled from fragments at runtime (the repository's
// fake-credential discipline): nothing realistic is ever a source literal.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SECRETS_DIR } from './fixtures';

/** One certification tenant, created through the real production flow. */
export interface CertTenant {
  managerEmail: string;
  managerPassword: string;
  managerName: string;
  companyName: string;
}

/** The invited employee of the run tenant (J05/J07 — created in-test). */
export interface CertEmployee {
  email: string;
  password: string;
  name: string;
  /** The employee's principal uuid (the API-key grantee input). */
  principalId: string;
  /** The raw integration key J05 minted (secrets scratch ONLY — never evidence). */
  apiKey?: string;
}

/** A runtime-random token fragment (never a source literal). */
function randomToken(length: number): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** A fresh run tenant's credentials (assembled from fragments at runtime). */
export function mintRunTenant(runLabel: string): CertTenant {
  const token = randomToken(8);
  const stamp = Date.now().toString(36);
  return {
    managerEmail: ['w079', 'run', runLabel.toLowerCase(), stamp, token].join('-') +
      '@aurum-cert.test',
    managerPassword: ['Cert', runLabel.toUpperCase(), stamp, token, 'pass'].join('.'),
    managerName: `Run ${runLabel} Certifier`,
    companyName: `Certification ${runLabel} ${token.toUpperCase()} Co`,
  };
}

/** A fresh employee's credentials (assembled from fragments at runtime). */
export function mintEmployee(runLabel: string): { email: string; password: string; name: string } {
  const token = randomToken(6);
  const stamp = Date.now().toString(36);
  return {
    email: ['w079', 'run', runLabel.toLowerCase(), stamp, token, 'emp'].join('-') +
      '@aurum-cert.test',
    password: ['Cert', runLabel.toUpperCase(), stamp, token, 'member'].join('.'),
    name: `Run ${runLabel} Contributor`,
  };
}

/** Read the run's tenant record (null when the tenant was not created yet). */
export async function readRunTenant(): Promise<CertTenant | null> {
  try {
    const raw = await readFile(path.join(SECRETS_DIR, 'tenant.json'), 'utf8');
    return JSON.parse(raw) as CertTenant;
  } catch {
    return null;
  }
}

/** Persist the run's tenant record (the secrets scratch dir — never evidence). */
export async function writeRunTenant(tenant: CertTenant): Promise<void> {
  await writeFile(path.join(SECRETS_DIR, 'tenant.json'), `${JSON.stringify(tenant, null, 2)}\n`, 'utf8');
}

/** Read the run's employee record (null when the employee was not invited yet). */
export async function readRunEmployee(): Promise<CertEmployee | null> {
  try {
    const raw = await readFile(path.join(SECRETS_DIR, 'employee.json'), 'utf8');
    return JSON.parse(raw) as CertEmployee;
  } catch {
    return null;
  }
}

/** Persist the run's employee record (the secrets scratch dir — never evidence). */
export async function writeRunEmployee(employee: CertEmployee): Promise<void> {
  await writeFile(
    path.join(SECRETS_DIR, 'employee.json'),
    `${JSON.stringify(employee, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Register a fresh manager through the REAL /signup form and create the
 * company through the REAL /onboarding form. Ends on /chat with the
 * messenger rendered. This is J01's journey body — every other journey
 * signs the recorded tenant back in instead.
 */
export async function signUpManagerAndCompany(page: Page, tenant: CertTenant): Promise<void> {
  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: 'Get started with Aurum' })).toBeVisible();
  // Production discipline: the quick-access panel must NOT exist here.
  await expect(page.locator('.aurum-auth-quick')).toHaveCount(0);
  await page.locator('#signup-name').fill(tenant.managerName);
  await page.locator('#signup-email').fill(tenant.managerEmail);
  await page.locator('#signup-password').fill(tenant.managerPassword);
  await page.getByRole('button', { name: 'Create account' }).click();
  // The fresh principal has no company: onboarding is the next surface.
  await page.waitForURL(/\/onboarding/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Welcome to Aurum' })).toBeVisible();
  await page.locator('#company-name').fill(tenant.companyName);
  await page.getByRole('button', { name: 'Create company' }).click();
  await page.waitForURL(/\/chat/, { timeout: 60_000 });
  await expect(page.locator('.aurum-chat-app')).toBeVisible({ timeout: 60_000 });
}

/**
 * Ensure the run tenant exists (create it through the real flow when this
 * is the first test of the run — J01 — or a single-journey dev run), then
 * SIGN IN as its manager through the real /signin form. Ends on /chat.
 */
export async function signInRunManager(page: Page): Promise<CertTenant> {
  const existing = await readRunTenant();
  const tenant = existing ?? mintRunTenant(process.env.W079_RUN_LABEL ?? 'dev');
  if (existing === null) {
    await signUpManagerAndCompany(page, tenant);
    await writeRunTenant(tenant);
    return tenant;
  }
  await signInManager(page, tenant);
  return tenant;
}

/**
 * Sign in as the run tenant's manager through the REAL /signin form
 * (email + password — the production authentication path). Ends on /chat.
 */
export async function signInManager(page: Page, tenant: CertTenant): Promise<void> {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  // Production discipline: the quick-access panel must NOT exist here.
  await expect(page.locator('.aurum-auth-quick')).toHaveCount(0);
  await page.locator('#signin-email').fill(tenant.managerEmail);
  await page.locator('#signin-password').fill(tenant.managerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/chat/, { timeout: 60_000 });
  await expect(page.locator('.aurum-chat-app')).toBeVisible({ timeout: 60_000 });
}

/** Sign out through the real button on the More hub. */
export async function signOutViaMore(page: Page): Promise<void> {
  await page.goto('/more');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/signin/, { timeout: 60_000 });
}

/**
 * The currently authenticated principal's id — read from the app's own
 * session surface while the browser session is live (the same endpoint
 * every page hydrates from; a read of the caller's own session, never an
 * authentication bypass). Used to fill the API-key grantee input honestly.
 */
export async function currentPrincipalId(page: Page): Promise<string> {
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    return (await response.json()) as { principal?: { id?: string } };
  });
  const id = body.principal?.id;
  expect(id, 'the session surface reports the authenticated principal id').toBeTruthy();
  return id as string;
}

/**
 * Read the invite link the InviteManager shows exactly once. The invite
 * code is base64url — underscores and dashes are legal characters, so the
 * extraction class is deliberately wide ([A-Za-z0-9_-]+): a narrow class
 * would silently truncate codes and dead-end the employee journey (the
 * session-3 landmine, honored).
 */
export async function readIssuedInviteLink(page: Page): Promise<string> {
  const codeElement = page.locator('.aurum-auth-code').first();
  await expect(codeElement).toBeVisible({ timeout: 30_000 });
  const link = (await codeElement.textContent())?.trim() ?? '';
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(link);
  expect(match, `the issued invitation link is readable (${link.slice(0, 48)}…)`).toBeTruthy();
  return match?.[0] ?? '';
}

/**
 * Accept an invitation as a fresh employee through the REAL flow: follow
 * the link anonymously, create the account (the invite pre-fills the
 * bound email), land in the joining company's chat. Returns the employee
 * record including the principal id for the API-key grantee input.
 */
export async function acceptInviteAsEmployee(
  page: Page,
  invitePath: string,
  employee: { email: string; password: string; name: string },
): Promise<CertEmployee> {
  await page.goto(invitePath);
  await expect(page.getByRole('heading', { name: /invited/i })).toBeVisible({
    timeout: 60_000,
  });
  // The invitation binds the email — follow the REAL pre-filled signup
  // link the landing page renders for the invited address.
  await page.getByRole('link', { name: /Create an account with/ }).click();
  await page.waitForURL(/\/signup\?invite=/, { timeout: 60_000 });
  await page.locator('#signup-name').fill(employee.name);
  await expect(page.locator('#signup-email')).toHaveValue(employee.email, { timeout: 10_000 });
  await page.locator('#signup-password').fill(employee.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  // The redemption selects the joining company: chat is the destination.
  await page.waitForURL(/\/chat/, { timeout: 60_000 });
  await expect(page.locator('.aurum-chat-app')).toBeVisible({ timeout: 60_000 });
  const principalId = await currentPrincipalId(page);
  return { ...employee, principalId };
}
