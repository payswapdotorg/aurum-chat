// Page-render smoke tests for the provider-choice surface (W091): the
// REAL page component server-rendered to HTML (the e2e-harness approach —
// renderToReadableStream with the session resolved through next/headers)
// so the rendered surface itself, not just its view model, is probed.
//
// THE ACCEPTANCE CORE:
//   * a MEMBER's rendered page carries the plain-language surface and NO
//     provider names / model ids / machine codes anywhere in the HTML;
//   * an ADMINISTRATOR's rendered page reveals the technical layer (the
//     provider names ARE the point there);
//   * both personas' pages render the choice form, the explanation and
//     the history without crashing (server + client components together).

import { vi } from 'vitest';

const holder: { token: string | null } = { token: null };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'aurum_session' && holder.token !== null ? { value: holder.token } : undefined,
  }),
}));

vi.mock('next/navigation', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useRouter: () => ({
      push: () => undefined,
      replace: () => undefined,
      refresh: () => undefined,
      prefetch: () => undefined,
      back: () => undefined,
      forward: () => undefined,
    }),
  };
});

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import {
  ORGANIZATIONS_AUTHORITY_PROVISION,
  addTenantMember,
  provisionTenant,
} from '@/modules/organizations/contract';
import { invokeLlm, registerAiProviderAccount, setLlmTransport } from '@/modules/llm/contract';
import { RecordingLlmTransport } from '../../../../../tests/provider-hotswap/fakes';

import ProviderPreferencesPage from '../page';

// The jargon vocabulary (the llm contract's machine words — a member's
// RENDERED page must not carry any of them).
const JARGON_TOKENS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'cohere',
  'deepseek',
  'groq',
  'text-generation',
  'embedding',
  'cognition',
  'conversation',
  'analysis',
  'background',
  'public',
  'internal',
  'restricted',
  'maxDataClassification',
  'llm',
  'byoa',
] as const;

/** Assembled at runtime (the secret-scanner discipline of the fakes). */
const PERSONA_PASSWORD = ['ha', 'rbor', '-cr', 'ane-44'].join('');

const db = getDb();

let ownerToken = '';
let memberToken = '';

beforeAll(async () => {
  await runMigrations(db);

  const platform: TenantContext = {
    tenantId: newId(),
    principalId: newId(),
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };
  const owner = await registerUser({
    displayName: 'Northwind Owner',
    email: `owner.${newId().slice(0, 8)}@example.test`,
    password: PERSONA_PASSWORD,
  });
  const plainMember = await registerUser({
    displayName: 'Northwind Member',
    email: `member.${newId().slice(0, 8)}@example.test`,
    password: PERSONA_PASSWORD,
  });
  const ownerPrincipalId = owner.session.principalId;
  const memberPrincipalId = plainMember.session.principalId;
  const tenant = await provisionTenant(platform, {
    name: 'Northwind Traders',
    ownerPrincipalId,
    defaultWorkspaceName: 'Company HQ',
  });
  await addTenantMember(
    { tenantId: tenant.id, principalId: ownerPrincipalId, authority: [] },
    { principalId: memberPrincipalId, role: 'member' },
  );
  await selectCompany({ token: owner.token, tenantId: tenant.id });
  await selectCompany({ token: plainMember.token, tenantId: tenant.id });
  ownerToken = owner.token;
  memberToken = plainMember.token;

  const adminCtx: TenantContext = {
    tenantId: tenant.id,
    principalId: ownerPrincipalId,
    authority: ['llm:administer'],
  };
  await registerAiProviderAccount(adminCtx, {
    provider: 'openai',
    label: 'Primary workspace key',
    credentialRef: 'secret-store://byoa/openai/primary',
    scopes: ['cognition', 'conversation', 'analysis', 'background'],
    capabilities: ['text-generation', 'embedding'],
    maxDataClassification: 'restricted',
    priority: 10,
  });
  const transport = new RecordingLlmTransport();
  transport.serve('openai', { text: 'ready' });
  setLlmTransport(transport);
  const execution = await invokeLlm(
    { tenantId: tenant.id, principalId: memberPrincipalId, authority: [] },
    {
      capability: 'text-generation',
      scope: 'cognition',
      dataClassification: 'internal',
      messages: [{ role: 'user', content: 'Is the gateway provider-neutral?' }],
      temperature: 0,
      maxOutputTokens: 16,
    },
  );
  expect(execution.status).toBe('completed');
});

afterAll(async () => {
  setLlmTransport(null);
  await closeDb();
});

async function renderPage(): Promise<string> {
  const stream = await renderToReadableStream(createElement(ProviderPreferencesPage));
  return new Response(stream).text();
}

it('renders the member page: plain surface, no provider names in the HTML', async () => {
  holder.token = memberToken;
  const html = await renderPage();
  expect(html).toContain('Choose what Aurum optimizes for');
  expect(html).toContain('Your choice');
  expect(html).toContain('Why this option was used');
  expect(html).toContain('Change history');
  expect(html).toContain('Advanced settings');
  // The member branch: the plain ask-an-admin sentence, no technical data.
  expect(html).toContain('Technical settings are for administrators');
  // The choice form renders with the plain options.
  expect(html).toContain('Prioritize privacy');
  expect(html).toContain('Lowest cost');
  expect(html).toContain('Balanced');
  // The explanation renders the frozen decision in plain words.
  expect(html).toContain('Your choice:');
  expect(html).toContain('Not used:');
  // THE JARGON PROBE on the rendered HTML: no provider names, model ids,
  // machine codes or enum values anywhere on the member's page.
  const haystack = html.toLowerCase();
  for (const token of JARGON_TOKENS) {
    expect(haystack).not.toContain(token.toLowerCase());
  }
});

it('renders the administrator page: the technical layer is revealed', async () => {
  holder.token = ownerToken;
  const html = await renderPage();
  expect(html).toContain('Choose what Aurum optimizes for');
  expect(html).toContain('Advanced settings (technical)');
  // The authorized reveal: the accounts table carries the provider name
  // and the account label (the <details> content renders even collapsed).
  expect(html).toContain('OpenAI');
  expect(html).toContain('Primary workspace key');
  expect(html).toContain('Restricted data');
  expect(html).toContain('Apply the saved choice now');
  expect(html).toContain('The last AI task, technically');
  expect(html).toContain('No pin — your routing order decided.');
});
