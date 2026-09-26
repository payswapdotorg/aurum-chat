// Integration tests for the provider-preferences module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W091
// acceptance: "Present provider selection as outcomes such as cost, privacy,
// quality, speed or organizational policy. Persist preferences and reveal
// technical details only in advanced settings."
//
//  * honest defaults — a fresh tenant sees the balanced organizational
//    order with an honest "nothing saved yet" note, never invented state;
//  * the member/administrator split — any member may save (unlimited,
//    always audited; priorities NOT written, requiresAdministrator
//    honestly true); a saver holding the technical authority claim
//    auto-applies the mapping through the llm contract's own input;
//  * the change-anytime audit — append-only events, newest first, plain
//    summaries (the jargon-free probe), unlimited re-saves;
//  * in-flight no-breakage — applying a preference that really reorders
//    priorities never touches a recorded execution's FROZEN routing
//    snapshot;
//  * the explanation surface — no-executions / execution-not-found /
//    found with a jargon-free default rendering and a technical block
//    that carries the provider/model names (advanced settings only);
//  * the technical layer — claim-gated view + override, delegated to the
//    llm contract, audited as technical-override;
//  * cross-tenant boundaries — disjoint audits, independent profiles, the
//    uniform account_not_found (no existence leak);
//  * storage discipline — tenant_id on every table, append-only events.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  DATA_CLASSIFICATIONS,
  LLM_CAPABILITIES,
  LLM_PROVIDERS,
  LLM_SCOPES,
  getLlmExecution,
  invokeLlm,
  listAiProviderAccounts,
  listLlmModels,
  registerAiProviderAccount,
  setLlmTransport,
} from '@/modules/llm/contract';
import type { AiProviderAccount, LlmRoutingSnapshot } from '@/modules/llm/contract';
import { RecordingLlmTransport } from '../../../../tests/provider-hotswap/fakes';
import { runMigrations } from '../../../../scripts/migrate';
import {
  PROVIDER_PREFERENCES_TECHNICAL_CLAIM,
  ProviderPreferencesError,
  allExplanationLines,
  applyPreferenceProfile,
  explainRoutingDecision,
  getProviderPreferenceProfile,
  getTechnicalLayerView,
  listPreferenceChangeEvents,
  savePreferenceProfile,
  updateProviderAccountControls,
} from '../contract';

// ---------------------------------------------------------------------------
// Fixtures: dedicated tenants per group so count/order assertions stay
// deterministic, exactly like the llm / provider-billing suites.
// ---------------------------------------------------------------------------

const tenantDefault = newId();
const tenantMember = newId();
const tenantAdmin = newId();
const tenantAudit = newId();
const tenantInFlight = newId();
const tenantForeignExec = newId();
const tenantAuth = newId();
const tenantX = newId();
const tenantY = newId();
const tenantStorage = newId();

const PREFERENCE_TABLES = [
  'provider_preference_profiles',
  'provider_preference_mappings',
  'provider_preference_events',
] as const;

const REJECTION_REASONS = [
  'account_disabled',
  'scope_not_permitted',
  'capability_not_permitted',
  'data_classification_exceeds_account_policy',
  'budget_exhausted',
  'capability_not_supported_by_model',
  'model_output_limit',
  'unavailable',
  'not_pinned_target',
] as const;

/** Every machine token the DEFAULT surface must never render. */
const JARGON_TOKENS: readonly string[] = [
  ...LLM_PROVIDERS,
  ...listLlmModels().map((model) => model.modelId),
  ...LLM_CAPABILITIES,
  ...LLM_SCOPES,
  ...DATA_CLASSIFICATIONS,
  ...REJECTION_REASONS,
  'maxDataClassification',
  'llm',
  'byoa',
  'priority',
];

function expectJargonFree(text: string, where: string): void {
  const haystack = text.toLowerCase();
  for (const token of JARGON_TOKENS) {
    expect(
      haystack.includes(token.toLowerCase()),
      `jargon token '${token}' leaked into ${where}: ${JSON.stringify(text)}`,
    ).toBe(false);
  }
}

function memberOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** The technical authority holder — the SAME claim the llm module gates on. */
function adminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [PROVIDER_PREFERENCES_TECHNICAL_CLAIM] };
}

async function expectCode(
  code: ProviderPreferencesError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ProviderPreferencesError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ProviderPreferencesError)) throw error;
    expect(error.code).toBe(code);
  }
}

interface AccountSpec {
  provider: 'openai' | 'anthropic' | 'google';
  label: string;
  maxDataClassification: 'public' | 'internal' | 'restricted';
  priority: number;
}

async function registerAccount(ctx: TenantContext, spec: AccountSpec): Promise<AiProviderAccount> {
  const result = await registerAiProviderAccount(ctx, {
    provider: spec.provider,
    label: spec.label,
    credentialRef: `secret-store://${spec.provider}/${spec.label}`,
    scopes: ['conversation'],
    capabilities: ['text-generation'],
    maxDataClassification: spec.maxDataClassification,
    priority: spec.priority,
  });
  return result.account;
}

async function prioritiesOf(ctx: TenantContext): Promise<Map<string, number>> {
  const accounts = await listAiProviderAccounts(ctx, {});
  return new Map(accounts.map((account) => [account.id, account.priority] as const));
}

// A frozen, strictly advancing clock: every now() call moves forward, so
// every appended event carries a distinct, increasing timestamp and the
// newest-first audit ordering is fully deterministic (the two events of one
// save — saved, then applied — must never tie).
let clockMs = Date.parse('2026-11-10T09:00:00Z');
function tick(ms = 1000): void {
  clockMs += ms;
}

beforeAll(async () => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => {
    clockMs += 1;
    return new Date(clockMs);
  });
  setLlmTransport(new RecordingLlmTransport());
  await runMigrations(getDb());
});

afterAll(async () => {
  setLlmTransport(null);
  vi.restoreAllMocks();
  await closeDb();
});

// ---------------------------------------------------------------------------
// Honest defaults (a fresh tenant)
// ---------------------------------------------------------------------------

describe('provider-preferences service — honest defaults', () => {
  it('returns the balanced organizational order with honest "nothing saved yet" state', async () => {
    const view = await getProviderPreferenceProfile(memberOf(tenantDefault));
    expect(view.preference).toBe('balanced');
    expect(view.saved).toBe(false);
    expect(view.note).toBeNull();
    expect(view.updatedAt).toBeNull();
    expect(view.appliedPreference).toBeNull();
    expect(view.appliedAt).toBeNull();
    expect(view.pendingApplication).toBe(false);
    expect(view.mappings).toEqual([]);
    expect(view.mappingNotes.length).toBeGreaterThan(0);
    expect(view.mappingNotes.join(' ')).toContain('No choice saved yet');
    expect(view.changeEventCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Any member may save; only the technical authority applies
// ---------------------------------------------------------------------------

describe('provider-preferences service — a member save records but never writes routing', () => {
  it('saves the choice, documents the mapping and leaves the real priorities untouched', async () => {
    const admin = adminOf(tenantMember);
    tick();
    const openai = await registerAccount(admin, {
      provider: 'openai',
      label: 'ops',
      maxDataClassification: 'restricted',
      priority: 10,
    });
    tick();
    const anthropic = await registerAccount(admin, {
      provider: 'anthropic',
      label: 'research',
      maxDataClassification: 'public',
      priority: 20,
    });

    const member = memberOf(tenantMember);
    tick();
    const saved = await savePreferenceProfile(member, { preference: 'privacy-first' });
    expect(saved.profile.preference).toBe('privacy-first');
    expect(saved.profile.tenantId).toBe(tenantMember);
    expect(saved.application.applied).toBe(false);
    expect(saved.application.requiresAdministrator).toBe(true);
    expect(saved.application.written).toBe(0);
    expect(saved.application.summary.length).toBeGreaterThan(0);

    // The audit carries the save.
    tick();
    const events = await listPreferenceChangeEvents(member, { limit: 20 });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('preference-saved');
    expect(events[0]!.preference).toBe('privacy-first');
    expect(events[0]!.actor).toBe(member.principalId);

    // The ACTUAL account priorities are unchanged (llm contract read).
    const priorities = await prioritiesOf(member);
    expect(priorities.get(openai.id)).toBe(10);
    expect(priorities.get(anthropic.id)).toBe(20);

    // The profile view honestly reports the pending application and the
    // documented order: the public-ceiling option first, not yet written.
    tick();
    const view = await getProviderPreferenceProfile(member);
    expect(view.saved).toBe(true);
    expect(view.preference).toBe('privacy-first');
    expect(view.pendingApplication).toBe(true);
    expect(view.appliedPreference).toBeNull();
    expect(view.mappings).toHaveLength(2);
    expect(view.mappings[0]!.position).toBe(1);
    expect(view.mappings[0]!.accountId).toBe(anthropic.id);
    expect(view.mappings[0]!.assignedPriority).toBe(10);
    expect(view.mappings[1]!.position).toBe(2);
    expect(view.mappings[1]!.accountId).toBe(openai.id);
    expect(view.changeEventCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A saver holding the technical claim auto-applies
// ---------------------------------------------------------------------------

describe('provider-preferences service — an administrator save applies through the llm contract', () => {
  it('auto-applies the mapping, rewrites the priorities and audits both steps', async () => {
    expect(PROVIDER_PREFERENCES_TECHNICAL_CLAIM).toBe('llm:administer');

    const admin = adminOf(tenantAdmin);
    tick();
    const openai = await registerAccount(admin, {
      provider: 'openai',
      label: 'ops',
      maxDataClassification: 'restricted',
      priority: 10,
    });
    tick();
    const anthropic = await registerAccount(admin, {
      provider: 'anthropic',
      label: 'research',
      maxDataClassification: 'public',
      priority: 20,
    });

    tick();
    const saved = await savePreferenceProfile(admin, { preference: 'privacy-first' });
    expect(saved.application.applied).toBe(true);
    expect(saved.application.requiresAdministrator).toBe(false);
    expect(saved.application.written).toBe(2);
    expect(saved.profile.appliedPreference).toBe('privacy-first');

    // The llm contract now carries the reordered priorities: the
    // public-ceiling option first (10), the restricted one second (20).
    tick();
    const priorities = await prioritiesOf(admin);
    expect(priorities.get(anthropic.id)).toBe(10);
    expect(priorities.get(openai.id)).toBe(20);

    // Both steps are audited.
    tick();
    let events = await listPreferenceChangeEvents(admin, { limit: 50 });
    expect(events.filter((event) => event.event === 'preference-saved')).toHaveLength(1);
    expect(events.filter((event) => event.event === 'preference-applied')).toHaveLength(1);
    const applied = events.find((event) => event.event === 'preference-applied');
    expect(applied?.preference).toBe('privacy-first');
    expect(applied?.actor).toBe(admin.principalId);

    // The profile view reports the applied state.
    tick();
    const view = await getProviderPreferenceProfile(admin);
    expect(view.pendingApplication).toBe(false);
    expect(view.appliedPreference).toBe('privacy-first');
    expect(view.appliedAt).not.toBeNull();
    expect(view.mappings[0]!.accountId).toBe(anthropic.id);

    // Re-saving the SAME preference writes nothing and stays applied —
    // no duplicate applied event beyond the state.
    tick();
    const reSaved = await savePreferenceProfile(admin, { preference: 'privacy-first' });
    expect(reSaved.application.applied).toBe(true);
    expect(reSaved.application.written).toBe(0);
    tick();
    events = await listPreferenceChangeEvents(admin, { limit: 50 });
    expect(events.filter((event) => event.event === 'preference-saved')).toHaveLength(2);
    expect(events.filter((event) => event.event === 'preference-applied')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The change-anytime audit
// ---------------------------------------------------------------------------

describe('provider-preferences service — the change-anytime audit', () => {
  it('records every save (unlimited), newest first, with plain summaries', async () => {
    const admin = adminOf(tenantAudit);

    tick();
    await savePreferenceProfile(admin, { preference: 'privacy-first' });
    tick();
    await savePreferenceProfile(admin, { preference: 'fastest' });
    tick();
    await savePreferenceProfile(admin, { preference: 'balanced' });

    tick();
    let view = await getProviderPreferenceProfile(memberOf(tenantAudit));
    expect(view.preference).toBe('balanced');
    expect(view.saved).toBe(true);

    tick();
    let events = await listPreferenceChangeEvents(admin, { limit: 100 });
    const savedEvents = events.filter((event) => event.event === 'preference-saved');
    expect(savedEvents).toHaveLength(3);
    expect(new Set(savedEvents.map((event) => event.preference))).toEqual(
      new Set(['privacy-first', 'fastest', 'balanced']),
    );

    // Newest first, always — and strictly so: within one save the applied
    // event is appended AFTER the saved event and must therefore list first.
    for (let index = 1; index < events.length; index += 1) {
      expect(Date.parse(events[index - 1]!.occurredAt)).toBeGreaterThan(
        Date.parse(events[index]!.occurredAt),
      );
    }
    expect(events[0]!.event).toBe('preference-applied');
    expect(events[0]!.preference).toBe('balanced');
    expect(events[1]!.event).toBe('preference-saved');
    expect(events[1]!.preference).toBe('balanced');

    // Unlimited re-saves — change your mind as often as you like.
    tick();
    await savePreferenceProfile(admin, { preference: 'balanced' });
    tick();
    await savePreferenceProfile(admin, { preference: 'most-reliable' });
    tick();
    await savePreferenceProfile(admin, { preference: 'balanced' });
    tick();
    view = await getProviderPreferenceProfile(memberOf(tenantAudit));
    expect(view.preference).toBe('balanced');
    events = await listPreferenceChangeEvents(admin, { limit: 100 });
    expect(events.filter((event) => event.event === 'preference-saved')).toHaveLength(6);

    // Every audited summary stays plain language — the jargon-free probe
    // over the machine vocabulary of the llm contract.
    for (const event of events) {
      expect(event.summary.length).toBeGreaterThan(0);
      if (event.event === 'preference-saved' || event.event === 'preference-applied') {
        expectJargonFree(event.summary, `a '${event.event}' event summary`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// In-flight executions keep their frozen snapshots; the explanation surface
// ---------------------------------------------------------------------------

describe('provider-preferences service — in-flight executions and the explanation surface', () => {
  const admin = adminOf(tenantInFlight);
  let executionId = '';
  let openaiId = '';
  let anthropicId = '';
  let googleId = '';

  it('seeds a real execution with a frozen routing snapshot', async () => {
    tick();
    const openai = await registerAccount(admin, {
      provider: 'openai',
      label: 'ops',
      maxDataClassification: 'restricted',
      priority: 10,
    });
    openaiId = openai.id;
    tick();
    const anthropic = await registerAccount(admin, {
      provider: 'anthropic',
      label: 'public-only',
      maxDataClassification: 'public',
      priority: 20,
    });
    anthropicId = anthropic.id;
    tick();
    const google = await registerAccount(admin, {
      provider: 'google',
      label: 'internal-use',
      maxDataClassification: 'internal',
      priority: 30,
    });
    googleId = google.id;

    const member = memberOf(tenantInFlight);
    tick();
    const execution = await invokeLlm(member, {
      capability: 'text-generation',
      scope: 'conversation',
      dataClassification: 'internal',
      messages: [{ role: 'user', content: 'Summarize the quarterly plan in one sentence.' }],
    });
    executionId = execution.id;
    expect(execution.status).toBe('completed');
    expect(execution.accountId).toBe(openai.id);
  });

  it('keeps the frozen routing snapshot untouched when a preference really reorders the priorities', async () => {
    const member = memberOf(tenantInFlight);
    tick();
    const before = await getLlmExecution(member, { executionId });
    const frozen: LlmRoutingSnapshot = structuredClone(before.routing);
    expect(frozen.chosen).not.toBeNull();
    expect(frozen.candidates.length).toBeGreaterThanOrEqual(3);

    // Apply a preference that genuinely reorders all three options.
    tick();
    const saved = await savePreferenceProfile(admin, { preference: 'privacy-first' });
    expect(saved.application.applied).toBe(true);
    expect(saved.application.written).toBe(3);

    // The reorder really happened: most restrictive data policy first.
    tick();
    const priorities = await prioritiesOf(member);
    expect(priorities.get(anthropicId)).toBe(10); // public ceiling
    expect(priorities.get(googleId)).toBe(20); // internal ceiling
    expect(priorities.get(openaiId)).toBe(30); // restricted ceiling

    // The recorded execution's evidence is append-only and untouched.
    tick();
    const after = await getLlmExecution(member, { executionId });
    expect(after.routing).toEqual(frozen);
    expect(after.invokedAt).toBe(before.invokedAt);
  });

  it('explains honestly when no AI task has run yet', async () => {
    const none = await explainRoutingDecision(memberOf(tenantAudit), {});
    expect(none.found).toBe(false);
    if (none.found === false) {
      expect(none.reason).toBe('no-executions');
      expect(none.note.length).toBeGreaterThan(0);
    }
  });

  it('explains the latest execution jargon-free while the technical block carries the provider/model', async () => {
    const member = memberOf(tenantInFlight);
    tick();
    const explained = await explainRoutingDecision(member, {});
    expect(explained.found).toBe(true);
    if (explained.found === false) return;
    expect(explained.executionId).toBe(executionId);
    expect(explained.status).toBe('completed');
    expect(explained.explanation.chosen).not.toBeNull();
    expect(explained.preferenceLine).toContain('privacy first');

    // The central probe: the plain lines + preference line contain NO
    // machine vocabulary, even though the frozen routing itself carried
    // provider and model names.
    const plainBlob = JSON.stringify({
      lines: allExplanationLines(explained.explanation),
      preferenceLine: explained.preferenceLine,
    });
    expect(explained.technical.chosen).not.toBeNull();
    expect(JSON.stringify(explained.technical)).toContain(explained.technical.chosen!.provider);
    for (const token of JARGON_TOKENS) {
      expect(
        plainBlob.toLowerCase().includes(token.toLowerCase()),
        `jargon token '${token}' leaked into the explanation surface`,
      ).toBe(false);
    }

    // The technical block (advanced settings only) carries the real facts.
    expect((LLM_PROVIDERS as readonly string[]).includes(explained.technical.chosen!.provider)).toBe(true);
    expect(listLlmModels().some((model) => model.modelId === explained.technical.chosen!.model)).toBe(true);
    expect(explained.technical.candidates.length).toBeGreaterThanOrEqual(3);
    expect(explained.technical.pinned).toBe(false);

    // Explaining the SAME execution by id agrees.
    tick();
    const byId = await explainRoutingDecision(member, { executionId });
    expect(byId.found).toBe(true);
    if (byId.found === false) return;
    expect(byId.executionId).toBe(executionId);
  });

  it('treats a foreign tenant’s execution exactly like a missing one', async () => {
    // A second tenant runs its own execution first.
    const foreignAdmin = adminOf(tenantForeignExec);
    tick();
    await registerAccount(foreignAdmin, {
      provider: 'openai',
      label: 'ops',
      maxDataClassification: 'restricted',
      priority: 10,
    });
    const foreignMember = memberOf(tenantForeignExec);
    tick();
    const foreignExecution = await invokeLlm(foreignMember, {
      capability: 'text-generation',
      scope: 'conversation',
      dataClassification: 'internal',
      messages: [{ role: 'user', content: 'Draft a one-line status update.' }],
    });
    expect(foreignExecution.status).toBe('completed');

    const member = memberOf(tenantInFlight);
    const foreign = await explainRoutingDecision(member, { executionId: foreignExecution.id });
    expect(foreign.found).toBe(false);
    const missing = await explainRoutingDecision(member, { executionId: newId() });
    expect(missing.found).toBe(false);
    // Foreign and missing are indistinguishable — same reason, same note.
    if (foreign.found === false && missing.found === false) {
      expect(foreign.reason).toBe('execution-not-found');
      expect(missing.reason).toBe('execution-not-found');
      expect(missing.note).toBe(foreign.note);
      expect(foreign.note.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected both the foreign and the missing execution to be not-found');
    }
  });
});

// ---------------------------------------------------------------------------
// The technical layer (advanced settings — claim-gated)
// ---------------------------------------------------------------------------

describe('provider-preferences service — the technical layer is claim-gated', () => {
  it('refuses members with the typed unauthorized error', async () => {
    const member = memberOf(tenantAuth);
    await expectCode('unauthorized', () => getTechnicalLayerView(member));
    await expectCode('unauthorized', () =>
      updateProviderAccountControls(member, { accountId: newId(), priority: 5 }),
    );
    // Even with no profile saved yet, the claim gate comes first.
    await expectCode('unauthorized', () => applyPreferenceProfile(member, {}));
  });

  it('serves the authorized view and the override through the llm contract', async () => {
    const admin = adminOf(tenantAuth);
    tick();
    const first = await registerAccount(admin, {
      provider: 'openai',
      label: 'ops',
      maxDataClassification: 'internal',
      priority: 10,
    });
    tick();
    const second = await registerAccount(admin, {
      provider: 'google',
      label: 'fast',
      maxDataClassification: 'internal',
      priority: 25,
    });
    tick();
    const saved = await savePreferenceProfile(admin, { preference: 'fastest' });
    expect(saved.application.applied).toBe(true);

    tick();
    const technical = await getTechnicalLayerView(admin);
    expect(technical.accounts).toHaveLength(2);
    expect(technical.accounts.map((account) => account.routingPosition)).toEqual([1, 2]);
    expect(technical.accounts[0]!.priority).toBeLessThanOrEqual(technical.accounts[1]!.priority);
    expect(technical.accounts[0]!.provider).toBe('openai');
    expect(technical.mappings).toHaveLength(2);
    expect(technical.preference).toBe('fastest');
    expect(technical.appliedPreference).toBe('fastest');

    // The override delegates to the llm contract and lands in the audit.
    tick();
    const overridden = await updateProviderAccountControls(admin, {
      accountId: second.id,
      priority: 55,
    });
    expect(overridden.account.priority).toBe(55);
    tick();
    const priorities = await prioritiesOf(admin);
    expect(priorities.get(second.id)).toBe(55);
    expect(priorities.get(first.id)).toBe(10);
    tick();
    const events = await listPreferenceChangeEvents(admin, { limit: 50 });
    const overrides = events.filter((event) => event.event === 'technical-override');
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.actor).toBe(admin.principalId);

    // The apply endpoint re-runs the SAVED preference on demand.
    tick();
    const applied = await applyPreferenceProfile(admin, {});
    expect(applied.application.applied).toBe(true);
    expect(applied.profile.preference).toBe('fastest');
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant boundaries
// ---------------------------------------------------------------------------

describe('provider-preferences service — cross-tenant boundaries', () => {
  it('keeps audits, profiles and account control strictly per-tenant', async () => {
    const adminX = adminOf(tenantX);
    tick();
    const accountX = await registerAccount(adminX, {
      provider: 'openai',
      label: 'shared-label',
      maxDataClassification: 'internal',
      priority: 10,
    });
    tick();
    await savePreferenceProfile(adminX, { preference: 'privacy-first' });

    // Tenant Y sees none of tenant X's audit and no profile of its own.
    const memberY = memberOf(tenantY);
    tick();
    expect(await listPreferenceChangeEvents(memberY, { limit: 100 })).toEqual([]);
    const viewY = await getProviderPreferenceProfile(memberY);
    expect(viewY.saved).toBe(false);
    expect(viewY.preference).toBe('balanced');
    expect(viewY.changeEventCount).toBe(0);

    // Tenant Y's own choice is independent of tenant X's.
    const adminY = adminOf(tenantY);
    tick();
    await savePreferenceProfile(adminY, { preference: 'fastest' });
    tick();
    const viewX = await getProviderPreferenceProfile(adminX);
    expect(viewX.preference).toBe('privacy-first');
    expect(viewX.saved).toBe(true);
    const viewY2 = await getProviderPreferenceProfile(memberY);
    expect(viewY2.preference).toBe('fastest');

    // The audits are disjoint.
    tick();
    const eventsX = await listPreferenceChangeEvents(adminX, { limit: 100 });
    const eventsY = await listPreferenceChangeEvents(memberY, { limit: 100 });
    expect(eventsX.length).toBeGreaterThan(0);
    expect(eventsY.length).toBeGreaterThan(0);
    const idsX = new Set(eventsX.map((event) => event.id));
    for (const event of eventsY) {
      expect(idsX.has(event.id), `tenant X event leaked to tenant Y: ${event.id}`).toBe(false);
    }
    for (const event of eventsX) expect(event.tenantId).toBe(tenantX);
    for (const event of eventsY) expect(event.tenantId).toBe(tenantY);

    // Authority never crosses the tenant boundary: tenant Y's admin cannot
    // even see tenant X's account (uniform not-found, no existence leak).
    await expectCode('account_not_found', () =>
      updateProviderAccountControls(adminY, { accountId: accountX.id, priority: 5 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (migration + append-only guard)
// ---------------------------------------------------------------------------

describe('provider-preferences service — storage discipline', () => {
  it('carries a NOT NULL uuid tenant_id on every module table', async () => {
    const result = await getDb().query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND column_name = 'tenant_id'
           AND table_name IN ('provider_preference_profiles',
                              'provider_preference_mappings',
                              'provider_preference_events')`,
    );
    expect(result.rows).toHaveLength(PREFERENCE_TABLES.length);
    for (const table of PREFERENCE_TABLES) {
      const column = result.rows.find((row) => row.table_name === table);
      expect(column, `${table} must carry a tenant_id column`).toBeDefined();
      expect(column?.data_type).toBe('uuid');
      expect(column?.is_nullable).toBe('NO');
    }
  });

  it('rejects UPDATE, DELETE and TRUNCATE on the append-only event audit', async () => {
    const member = memberOf(tenantStorage);
    tick();
    await savePreferenceProfile(member, { preference: 'most-reliable' });

    const probes: Array<{ op: string; sql: string; params: unknown[] }> = [
      {
        op: 'UPDATE',
        sql: `UPDATE provider_preference_events SET summary = 'x' WHERE tenant_id = $1`,
        params: [tenantStorage],
      },
      {
        op: 'DELETE',
        sql: `DELETE FROM provider_preference_events WHERE tenant_id = $1`,
        params: [tenantStorage],
      },
      { op: 'TRUNCATE', sql: `TRUNCATE provider_preference_events`, params: [] },
    ];
    for (const probe of probes) {
      let rejected = false;
      let message = '';
      try {
        await getDb().query(probe.sql, probe.params);
      } catch (error) {
        rejected = true;
        message = error instanceof Error ? error.message : String(error);
      }
      expect(rejected, `${probe.op} on the event audit must be rejected`).toBe(true);
      expect(message, `${probe.op} must be explained as append-only`).toMatch(/append-only/i);
    }

    // The audit row itself is intact after the refused mutations.
    tick();
    const events = await listPreferenceChangeEvents(member, { limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).not.toBe('x');
  });
});
