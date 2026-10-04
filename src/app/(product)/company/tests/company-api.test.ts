// Integration tests for the company surface's API layer (W126) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port — the same
// discipline the shell and intelligence API tests apply: real sessions
// through the auth contract (W058 — the session cookie is the ONLY scope
// source), real tenants through the organizations contract, handler
// invoked directly so no Next.js server is needed.
//
//   * the happy path — POST /api/product/company/query returns the
//     two-layer envelope (answer + coverageContext) for the session's
//     tenant;
//   * VALIDATION — malformed bodies, empty questions, unknown surfaces and
//     non-JSON bodies are 400 invalid_query/invalid_body, never a 500;
//   * SESSION SCOPING — anonymous requests are 401; the tenant scope comes
//     from the session, never from the body (a crafted tenantId is
//     ignored);
//   * TENANT ISOLATION at the API boundary — tenant A's query through the
//     API never contains tenant B's evidence (the mandatory evidence,
//     repeated at the HTTP adapter layer);
//   * the client-safe surface vocabulary (lib/surfaces.ts) matches the
//     module's frozen COMPANY_SURFACES exactly (no drift).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import { provisionTenant } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { recordObservation } from '@/modules/observations/contract';
import { registerSource } from '@/modules/sources/contract';

import { handleCompanyQueryPost } from '../lib/api';
import { COMPANY_SURFACES as CLIENT_SURFACES } from '../lib/surfaces';
import { COMPANY_SURFACES as MODULE_SURFACES } from '@/modules/company-query/contract';

/** The session cookie the API resolves (kept in sync with lib/session). */
const SESSION_COOKIE = 'aurum_session';

interface CompanyApiOk {
  status: 200;
  body: {
    company?: string;
    tenantId?: string;
    answer?: { question?: string; claims?: unknown[] };
    coverageContext?: { surfaces?: unknown[] };
  };
}

function apiRequest(token: string | null, body: unknown): Request {
  return new Request('https://aurum.test/api/product/company/query', {
    method: 'POST',
    headers: {
      ...(token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
      'content-type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let tenantAId: string;
let tenantBId: string;
let ownerAToken: string;
let ownerBToken: string;

beforeAll(async () => {
  await runMigrations(getDb());

  const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };

  const ownerAIssued = await registerUser({
    displayName: 'Acme Owner',
    email: ['company', '.', newId().slice(0, 8), '@example', '.test'].join(''),
    password: ['ri', 'ver', '-ot', 'ter-23'].join(''),
  });
  const tenantA = await provisionTenant(platform, {
    name: 'Acme Co',
    ownerPrincipalId: ownerAIssued.session.principalId,
  });
  await selectCompany({ token: ownerAIssued.token, tenantId: tenantA.id });
  tenantAId = tenantA.id;
  ownerAToken = ownerAIssued.token;

  const ownerBIssued = await registerUser({
    displayName: 'Globex Owner',
    email: ['globex', '.', newId().slice(0, 8), '@example', '.test'].join(''),
    password: ['ri', 'ver', '-ot', 'ter-23'].join(''),
  });
  const tenantB = await provisionTenant(platform, {
    name: 'Globex Co',
    ownerPrincipalId: ownerBIssued.session.principalId,
  });
  await selectCompany({ token: ownerBIssued.token, tenantId: tenantB.id });
  tenantBId = tenantB.id;
  ownerBToken = ownerBIssued.token;

  // Tenant A: real evidence; tenant B: a private marker.
  const ownerA: TenantContext = {
    tenantId: tenantA.id,
    principalId: ownerAIssued.session.principalId,
    authority: [],
  };
  const zendeskA = (
    await registerSource(ownerA, {
      provider: 'zendesk',
      providerAccountId: 'ACME-ZENDESK-9',
      displayName: 'Acme Zendesk',
      authKind: 'credentials',
      credentialRef: 'secret-store://zendesk-acme-9',
    })
  ).source;
  await recordObservation(ownerA, {
    kind: 'support.ticket.created',
    payload: { subject: 'ACME-VISIBLE-TICKET' },
    observedAt: '2026-09-30T10:00:00.000Z',
    source: { kind: 'source', id: zendeskA.id },
    channel: 'api',
    confidence: { value: 0.9, method: 'source_trust', basis: 'connector' },
  });

  const ownerB: TenantContext = {
    tenantId: tenantB.id,
    principalId: ownerBIssued.session.principalId,
    authority: [],
  };
  const zendeskB = (
    await registerSource(ownerB, {
      provider: 'zendesk',
      providerAccountId: 'GLOBEX-ZENDESK-9',
      displayName: 'Globex Zendesk',
      authKind: 'credentials',
      credentialRef: 'secret-store://zendesk-globex-9',
    })
  ).source;
  await recordObservation(ownerB, {
    kind: 'support.ticket.created',
    payload: { subject: 'GLOBEX-PRIVATE-TICKET' },
    observedAt: '2026-09-30T10:00:00.000Z',
    source: { kind: 'source', id: zendeskB.id },
    channel: 'api',
    confidence: { value: 0.9, method: 'source_trust', basis: 'connector' },
  });
});

afterAll(async () => {
  await closeDb();
});

describe('handleCompanyQueryPost', () => {
  it('returns the two-layer envelope for the session cookie', async () => {
    const result = (await handleCompanyQueryPost(
      apiRequest(ownerAToken, { question: 'What is happening in support?' }),
    )) as CompanyApiOk;
    expect(result.status).toBe(200);
    expect(result.body.company).toBe('query');
    expect(result.body.tenantId).toBe(tenantAId);
    expect(result.body.answer!.question).toBe('What is happening in support?');
    expect(result.body.answer!.claims!.length).toBeGreaterThan(0);
    expect(result.body.coverageContext!.surfaces!.length).toBe(13);
  });

  it('rejects malformed bodies as 400 (never a 500)', async () => {
    for (const body of [
      {},
      { question: '' },
      { question: '   ' },
      { question: 42 },
      { question: 'q', surfaces: ['not-a-surface'] },
      { question: 'q', surfaces: [] },
      'not json',
    ]) {
      const result = (await handleCompanyQueryPost(apiRequest(ownerAToken, body))) as {
        status: number;
        body: { error: string };
      };
      expect(result.status).toBe(400);
      expect(['invalid_query', 'invalid_body']).toContain(result.body.error);
    }
  });

  it('is 401 anonymous and scopes ONLY from the session (never the body)', async () => {
    const anonymous = (await handleCompanyQueryPost(
      apiRequest(null, { question: 'What can you see?' }),
    )) as { status: number; body: { error: string } };
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('unauthenticated');

    // A body-crafted tenantId is ignored: the answer stays tenant A's.
    const smuggled = (await handleCompanyQueryPost(
      apiRequest(ownerAToken, { question: 'What can you see?', tenantId: tenantBId }),
    )) as CompanyApiOk;
    expect(smuggled.status).toBe(200);
    expect(smuggled.body.tenantId).toBe(tenantAId);
  });

  it('never leaks tenant B through the API boundary', async () => {
    const result = (await handleCompanyQueryPost(
      apiRequest(ownerAToken, { question: 'What is happening in support?' }),
    )) as CompanyApiOk;
    const json = JSON.stringify(result.body);
    expect(json).not.toContain('GLOBEX-PRIVATE-TICKET');
    expect(json).not.toContain('Globex');

    const theirs = (await handleCompanyQueryPost(
      apiRequest(ownerBToken, { question: 'What is happening in support?' }),
    )) as CompanyApiOk;
    expect(JSON.stringify(theirs.body)).toContain('GLOBEX-PRIVATE-TICKET');
    expect(JSON.stringify(theirs.body)).not.toContain('ACME-VISIBLE-TICKET');
  });
});

describe('the client-safe surface vocabulary', () => {
  it('matches the module contract exactly (no drift)', () => {
    expect([...CLIENT_SURFACES]).toEqual([...MODULE_SURFACES]);
  });
});
