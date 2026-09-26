// Integration tests for the AI-preferences product surface (W091)
// against the embedded PostgreSQL (PGlite, `:memory:`) through the db
// port.
//
// THE ACCEPTANCE CORE, end to end through the provider-preferences
// module's REAL contract and the surface's own API handlers (the exact
// code the /api/product/ai/preferences route drives — no Next.js boot):
//
//   * ORDINARY MEMBER JOURNEY — a plain member (no claims) opens the
//     surface: the honest empty state (nothing set, the balanced
//     default), sets their own outcome priority through the API,
//     changes it at any time, clears it;
//   * THE COMPANY JOURNEY — an owner sets the company-wide priority and
//     the policy-first posture; a plain member's setTenant is refused
//     (403 — the authority gate), their read of the company state works;
//   * "WHY THIS OPTION?" — the module resolves a real choice (the
//     composition a gateway performs); the ordinary feed shows the
//     jargon-free explanation and NEVER the technical identity, while
//     the claim-gated technical detail (through the advanced view
//     builder) shows it;
//   * THE OVERRIDE — an owner pins a provider through the API with a
//     reason, clears it (reversible), and a plain member's pin is
//     refused (403); the pin is visible ONLY through the advanced view;
//   * JARGON DISCIPLINE — the serialized ordinary view (everything the
//     page can render) contains no provider identity even though the
//     underlying records name providers;
//   * SESSIONLESS/NO-COMPANY — anonymous requests are 401; a session
//     without an active company is 409.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../../scripts/migrate';
import { addTenantMember, provisionTenant } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import {
  PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER,
  resolveProviderChoice,
} from '@/modules/provider-preferences/contract';
import { handlePreferencesAction, handlePreferencesGet } from '../lib/api';
import { buildAdvancedView } from '../lib/views';

/** The session cookie the preferences API resolves (lib/session). */
const SESSION_COOKIE = 'aurum_session';

interface Fixture {
  tenantA: { id: string };
  tenantB: { id: string };
  ownerAToken: string;
  memberAToken: string;
  ownerBToken: string;
  ownerA: TenantContext;
  memberA: TenantContext;
}

let fixture: Fixture;

async function registerSessionUser(label: string): Promise<{ principalId: string; token: string }> {
  const slug = label.toLowerCase().replaceAll(' ', '-');
  const email = [slug, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: label,
    email,
    password: ['ha', 'rbor', '-cr', 'ane-44'].join(''),
  });
  return { principalId: issued.session.principalId, token: issued.token };
}

beforeAll(async () => {
  await runMigrations(getDb());

  const platform = { tenantId: newId(), principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };

  const ownerA = await registerSessionUser('Harbor Owner');
  const plainMember = await registerSessionUser('Harbor Member');
  const ownerB = await registerSessionUser('Initech Owner');

  const tenantA = await provisionTenant(platform, {
    name: 'Harbor Roasters',
    ownerPrincipalId: ownerA.principalId,
    defaultWorkspaceName: 'Company HQ',
  });
  const tenantB = await provisionTenant(platform, {
    name: 'Initech',
    ownerPrincipalId: ownerB.principalId,
  });

  await addTenantMember(
    { tenantId: tenantA.id, principalId: ownerA.principalId, authority: [] },
    { principalId: plainMember.principalId, role: 'member' },
  );
  await selectCompany({ token: ownerA.token, tenantId: tenantA.id });
  await selectCompany({ token: plainMember.token, tenantId: tenantA.id });
  await selectCompany({ token: ownerB.token, tenantId: tenantB.id });

  fixture = {
    tenantA,
    tenantB,
    ownerAToken: ownerA.token,
    memberAToken: plainMember.token,
    ownerBToken: ownerB.token,
    ownerA: {
      tenantId: tenantA.id,
      principalId: ownerA.principalId,
      authority: [PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER],
    },
    memberA: {
      tenantId: tenantA.id,
      principalId: plainMember.principalId,
      authority: [],
    },
  };
});

afterAll(async () => {
  await closeDb();
});

/** A request carrying one session cookie (the only scope source, W058). */
function request(path: string, token: string | null, init?: RequestInit): Request {
  return new Request(`https://aurum.test${path}`, {
    ...init,
    headers: {
      ...(token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
      ...(init?.headers ?? {}),
    },
  });
}

interface Envelope {
  surface?: string;
  tenantId?: string;
  view?: {
    resolved?: { source?: string; outcomePriority?: string[]; policyFirst?: boolean };
    personal?: { outcomePriority?: string[] } | null;
    tenant?: { outcomePriority?: string[]; policyFirst?: boolean } | null;
    canAdminister?: boolean;
    recentExplanations?: {
      id?: string;
      decision?: string;
      explanation?: string;
      capabilityLabel?: string;
      budgetExcludedCount?: number;
      decidingOutcomeLabel?: string | null;
    }[];
  };
  action?: string;
  summary?: string;
  error?: string;
  message?: string;
}

async function getView(
  token: string,
  query = '',
): Promise<{ status: number; body: Envelope }> {
  const result = await handlePreferencesGet(request(`/api/product/ai/preferences${query}`, token));
  return { status: result.status, body: result.body as Envelope };
}

async function postAction(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Envelope }> {
  const result = await handlePreferencesAction(
    request('/api/product/ai/preferences', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    body,
  );
  return { status: result.status, body: result.body as Envelope };
}

/** The candidates a gateway would offer (technical identity — the module's business). */
function gatewayCandidates() {
  return [
    {
      provider: 'openai',
      accountRef: 'acct-openai',
      projectedCostMinor: 500,
      outcomes: { cost: 500, speed: 900, quality: 2, privacy: 3 },
    },
    {
      provider: 'anthropic',
      accountRef: 'acct-anthropic',
      projectedCostMinor: 900,
      outcomes: { cost: 900, speed: 300, quality: 2, privacy: 1 },
    },
  ];
}

/** Every provider-ish token the ordinary view must never contain. */
const FORBIDDEN_IDENTITY = ['openai', 'anthropic', 'acct-openai', 'acct-anthropic', 'llm'];

// ---------------------------------------------------------------------------
// The ordinary member journey
// ---------------------------------------------------------------------------

describe('the AI-preferences surface (W091)', () => {
  it('starts honest: a plain member sees the balanced default and the empty why-feed', async () => {
    const { status, body } = await getView(fixture.memberAToken);
    expect(status).toBe(200);
    expect(body.surface).toBe('ai-preferences');
    expect(body.tenantId).toBe(fixture.tenantA.id);
    expect(body.view!.resolved!.source).toBe('default');
    expect(body.view!.resolved!.outcomePriority).toEqual(['quality', 'speed', 'cost', 'privacy']);
    expect(body.view!.personal).toBeNull();
    expect(body.view!.tenant).toBeNull();
    expect(body.view!.canAdminister).toBe(false);
    expect(body.view!.recentExplanations).toEqual([]);
  });

  it('a plain member sets, changes and clears their own priority (any time, no gate)', async () => {
    const set = await postAction(fixture.memberAToken, {
      action: 'preference.setPersonal',
      outcomePriority: ['speed', 'cost', 'quality', 'privacy'],
    });
    expect(set.status).toBe(200);
    expect(set.body.action).toBe('preference.setPersonal');
    expect(set.body.view!.personal!.outcomePriority).toEqual(['speed', 'cost', 'quality', 'privacy']);
    expect(set.body.view!.resolved!.source).toBe('personal-preference');

    const changed = await postAction(fixture.memberAToken, {
      action: 'preference.setPersonal',
      outcomePriority: ['privacy', 'quality'],
    });
    expect(changed.status).toBe(200);
    expect(changed.body.view!.personal!.outcomePriority).toEqual(['privacy', 'quality']);

    const cleared = await postAction(fixture.memberAToken, {
      action: 'preference.clearPersonal',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.view!.personal).toBeNull();
    expect(cleared.body.view!.resolved!.source).toBe('default');
  });

  it('the company preference is claim-gated: a member reads it but cannot set it (403)', async () => {
    const refused = await postAction(fixture.memberAToken, {
      action: 'preference.setTenant',
      outcomePriority: ['cost'],
      policyFirst: false,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('module_error');

    const set = await postAction(fixture.ownerAToken, {
      action: 'preference.setTenant',
      outcomePriority: ['cost', 'speed', 'quality', 'privacy'],
      policyFirst: false,
    });
    expect(set.status).toBe(200);
    expect(set.body.view!.tenant!.outcomePriority).toEqual(['cost', 'speed', 'quality', 'privacy']);
    expect(set.body.view!.canAdminister).toBe(true);

    // The member sees the company state without the claim.
    const member = await getView(fixture.memberAToken);
    expect(member.body.view!.tenant!.outcomePriority).toEqual(['cost', 'speed', 'quality', 'privacy']);
    expect(member.body.view!.canAdminister).toBe(false);
  });

  it('"why this option?": a resolved choice lands on the ordinary feed, jargon-free', async () => {
    // The member asks for privacy first (their own steering).
    await postAction(fixture.memberAToken, {
      action: 'preference.setPersonal',
      outcomePriority: ['privacy', 'cost', 'quality', 'speed'],
    });
    // The gateway composition (the llm route resolving under policy):
    // this is the exact contract call a gateway performs.
    const resolved = await resolveProviderChoice(fixture.memberA, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: gatewayCandidates(),
      dedupeKey: 'integration-why-1',
    });
    // privacy-first: anthropic (privacy 1) beats openai (3).
    expect(resolved.chosen!.provider).toBe('anthropic');
    expect(resolved.explanation).toContain('strongest data protection');

    const { body } = await getView(fixture.memberAToken);
    const feed = body.view!.recentExplanations!;
    expect(feed.length).toBe(1);
    expect(feed[0]!.decision).toBe('preference');
    expect(feed[0]!.capabilityLabel).toBe('Writing and analysis');
    expect(feed[0]!.decidingOutcomeLabel).toBe('Strongest data protection');
    expect(feed[0]!.explanation).toContain('You asked for');
    expect(feed[0]!.explanation).toContain('strongest data protection');

    // THE JARGON LOCK: the whole serialized ordinary view — everything
    // the /ai/preferences page can render — contains no technical
    // identity, even though the underlying record names the provider.
    const serialized = JSON.stringify(body.view);
    for (const token of FORBIDDEN_IDENTITY) {
      expect(serialized.includes(token), `the ordinary view leaked '${token}'`).toBe(false);
    }
  });

  it('the technical detail is claim-gated: the advanced view shows it only to authorized users', async () => {
    const feed = (await getView(fixture.memberAToken)).body.view!.recentExplanations!;
    const recordId = feed[0]!.id!;

    // The member's advanced view: honest unauthorized shape, no data.
    const memberAdvanced = await buildAdvancedView(fixture.memberA, null);
    expect(memberAdvanced.authorized).toBe(false);
    expect(memberAdvanced.providers).toEqual([]);
    expect(memberAdvanced.overrides).toEqual([]);

    // The owner's advanced view: the full technical record.
    const ownerAdvanced = await buildAdvancedView(fixture.ownerA, recordId);
    expect(ownerAdvanced.authorized).toBe(true);
    expect(ownerAdvanced.explanationDetail!.chosenProvider).toBe('anthropic');
    expect(ownerAdvanced.explanationDetail!.chosenAccountRef).toBe('acct-anthropic');
    expect(ownerAdvanced.explanationDetail!.gateway).toBe('llm');
    expect(ownerAdvanced.providers.length).toBeGreaterThan(0);
    expect(ownerAdvanced.providers.map((row) => row.provider)).toContain('openai');

    // A foreign id resolves to the honest missing shape (uniform
    // not-found — no existence leak).
    const missing = await buildAdvancedView(fixture.ownerA, newId());
    expect(missing.explanationDetail).toBeNull();
    expect(missing.explanationMissing).toBe(true);
  });

  it('the override journey: an owner pins and clears (reversible); a member is refused (403)', async () => {
    const refused = await postAction(fixture.memberAToken, {
      action: 'override.set',
      capability: 'text-generation',
      provider: 'openai',
      reason: 'No.',
    });
    expect(refused.status).toBe(403);

    const set = await postAction(fixture.ownerAToken, {
      action: 'override.set',
      capability: 'text-generation',
      provider: 'openai',
      reason: 'Contracted capacity until Q4.',
    });
    expect(set.status).toBe(200);
    expect(set.body.action).toBe('override.set');
    expect(set.body.summary).toContain('reversible');

    // The pin appears ONLY in the advanced view — never the ordinary one.
    const ordinary = (await getView(fixture.memberAToken)).body.view!;
    expect(JSON.stringify(ordinary).includes('Contracted capacity')).toBe(false);
    const advanced = await buildAdvancedView(fixture.ownerA, null);
    expect(advanced.overrides).toHaveLength(1);
    expect(advanced.overrides[0]!.provider).toBe('openai');
    expect(advanced.overrides[0]!.status).toBe('active');

    // The override changes the resolution the gateway performs.
    const overridden = await resolveProviderChoice(fixture.memberA, {
      gateway: 'llm',
      capability: 'text-generation',
      candidates: gatewayCandidates(),
      dedupeKey: 'integration-override-1',
    });
    expect(overridden.decision).toBe('technical-override');
    expect(overridden.chosen!.provider).toBe('openai');
    expect(overridden.explanation).toContain('authorized technical override');

    // Clearing is reversible; the audit feed keeps both moments.
    const cleared = await postAction(fixture.ownerAToken, {
      action: 'override.clear',
      capability: 'text-generation',
    });
    expect(cleared.status).toBe(200);
    const afterClear = await buildAdvancedView(fixture.ownerA, null);
    expect(afterClear.overrides[0]!.status).toBe('retired');

    const reset = await postAction(fixture.ownerAToken, {
      action: 'override.set',
      capability: 'text-generation',
      provider: 'anthropic',
      reason: 'Switched pin after review.',
    });
    expect(reset.status).toBe(200);
    const afterReset = await buildAdvancedView(fixture.ownerA, null);
    expect(afterReset.overrides[0]!.provider).toBe('anthropic');
    expect(afterReset.overrides[0]!.status).toBe('active');
    expect(afterReset.overrides).toHaveLength(1);
  });

  it('an unknown provider is refused before the module call (the registry lock)', async () => {
    const refused = await postAction(fixture.ownerAToken, {
      action: 'override.set',
      capability: 'text-generation',
      provider: 'not-a-real-provider',
      reason: 'Typo.',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('not a provider');
  });

  it('a member of another tenant sees none of tenant A’s state (tenant isolation at the surface)', async () => {
    // Tenant B's owner reads through their own session.
    const view = await getView(fixture.ownerBToken);
    expect(view.status).toBe(200);
    expect(view.body.tenantId).toBe(fixture.tenantB.id);
    expect(view.body.view!.tenant).toBeNull();
    expect(view.body.view!.recentExplanations).toEqual([]);
    // Tenant A's explanation records are invisible: not in the feed.
    const feedA = (await getView(fixture.memberAToken)).body.view!.recentExplanations!;
    expect(feedA.length).toBeGreaterThan(0);
    const serializedB = JSON.stringify(view.body.view);
    expect(serializedB.includes(feedA[0]!.id!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sessionless requests
// ---------------------------------------------------------------------------

describe('sessionless requests', () => {
  it('rejects anonymous GET and POST with 401 (no scope leak)', async () => {
    const get = await handlePreferencesGet(request('/api/product/ai/preferences', null));
    expect(get.status).toBe(401);
    expect((get.body as { error: string }).error).toBe('unauthenticated');
    const post = await handlePreferencesAction(
      request('/api/product/ai/preferences', null, { method: 'POST' }),
      { action: 'preference.clearPersonal' },
    );
    expect(post.status).toBe(401);
  });

  it('rejects malformed bodies with 400', async () => {
    const result = await postAction(fixture.memberAToken, { action: 'nonsense' } as never);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_body');
    const noBody = await handlePreferencesAction(
      request('/api/product/ai/preferences', fixture.memberAToken, { method: 'POST' }),
      null,
    );
    expect(noBody.status).toBe(400);
  });
});
