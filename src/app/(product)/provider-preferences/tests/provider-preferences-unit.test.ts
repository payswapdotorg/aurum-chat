// Unit tests for the provider-choice product surface's PURE logic (W091):
// the label/tone/format vocabularies, the client-safe preference copy
// (locked to the module contract), the JARGON-FREE DEFAULT-SURFACE probe,
// the server-action body parser, and the shell registration seams (command
// destination, capability hub, journey-proof route catalog). No database —
// the integration suite covers the contract compositions.

import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE_LENGTH_COPY,
  PENDING_APPLICATION_NOTE,
  PREFERENCE_OPTIONS_COPY,
  TECHNICAL_CHANGE_PLACEHOLDER,
  accountStatusLabel,
  accountStatusTone,
  ageLabel,
  capabilityLabel,
  classificationLabel,
  eventLabel,
  eventTone,
  formatUsdMinor,
  preferenceDescription,
  preferenceLabel,
  preferenceStateLabel,
  preferenceStateTone,
  providerLabel,
  scopeLabel,
} from '../lib/labels';
import {
  PRIORITY_MAX,
  PRIORITY_MIN,
  PROVIDER_PREFERENCES_ACTIONS,
  isProviderPreferencesAction,
  parseActionBody,
} from '../lib/actions';
import { PROVIDER_PREFERENCES_DESTINATIONS, buildShellCommands } from '../../lib/command-registry';
import { capabilityEntries } from '../../lib/capability-hub';
import { ROUTE_CATALOG } from '@/modules/journey-proof/contract';
import {
  CHANGE_EVENT_KINDS,
  MAX_NOTE_LENGTH,
  PREFERENCE_OPTIONS,
  REJECTION_REASON_PHRASES,
} from '@/modules/provider-preferences/contract';
import {
  DATA_CLASSIFICATIONS,
  LLM_CAPABILITIES,
  LLM_PROVIDERS,
  LLM_SCOPES,
  listLlmModels,
} from '@/modules/llm/contract';

// ---------------------------------------------------------------------------
// The jargon vocabulary (the llm contract's machine words — the default
// surface must never render any of them)
// ---------------------------------------------------------------------------

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

const JARGON_TOKENS: readonly string[] = [
  ...LLM_PROVIDERS,
  ...LLM_PROVIDERS.flatMap((provider) => listLlmModels(provider).map((model) => model.modelId)),
  ...LLM_CAPABILITIES,
  ...LLM_SCOPES,
  ...DATA_CLASSIFICATIONS,
  ...REJECTION_REASONS,
  'maxDataClassification',
  'llm',
  'byoa',
];

/** Assert no jargon token appears (case-insensitive) in a rendered string. */
function expectJargonFree(rendered: string): void {
  const haystack = rendered.toLowerCase();
  for (const token of JARGON_TOKENS) {
    expect(haystack).not.toContain(token.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// The client-safe copies (locked to the module contract — no drift)
// ---------------------------------------------------------------------------

describe('client-safe vocabulary copies locked to the contracts', () => {
  it('PREFERENCE_OPTIONS_COPY deep-matches the contract preference catalog', () => {
    expect([...PREFERENCE_OPTIONS_COPY]).toEqual([...PREFERENCE_OPTIONS]);
    expect(PREFERENCE_OPTIONS_COPY).toHaveLength(5);
  });

  it('MAX_NOTE_LENGTH_COPY matches the contract note cap', () => {
    expect(MAX_NOTE_LENGTH_COPY).toBe(MAX_NOTE_LENGTH);
  });

  it('the rejection-reason phrase table covers exactly the 9 machine reasons', () => {
    expect([...Object.keys(REJECTION_REASON_PHRASES)].sort()).toEqual(
      [...REJECTION_REASONS].sort(),
    );
  });

  it('providerLabel covers every registry provider (labels only — never a ranking)', () => {
    for (const provider of LLM_PROVIDERS) {
      expect(providerLabel(provider).length).toBeGreaterThan(0);
    }
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('anthropic')).toBe('Anthropic');
    expect(providerLabel('deepseek')).toBe('DeepSeek');
    expect(providerLabel('groq')).toBe('Groq');
  });

  it('scopeLabel, classificationLabel and capabilityLabel cover their vocabularies', () => {
    for (const scope of LLM_SCOPES) expect(scopeLabel(scope).length).toBeGreaterThan(0);
    for (const classification of DATA_CLASSIFICATIONS) {
      expect(classificationLabel(classification).length).toBeGreaterThan(0);
    }
    expect(classificationLabel('restricted')).toBe('Restricted data');
    for (const capability of LLM_CAPABILITIES) {
      expect(capabilityLabel(capability).length).toBeGreaterThan(0);
    }
  });

  it('account status maps to plain words and tones', () => {
    expect(accountStatusLabel('active')).toBe('Active');
    expect(accountStatusLabel('disabled')).toBe('Switched off');
    expect(accountStatusTone('active')).toBe('positive');
    expect(accountStatusTone('disabled')).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// The jargon-free default surface (the W091 acceptance probe)
// ---------------------------------------------------------------------------

describe('the default surface renders no provider jargon', () => {
  it('every preference label and description is jargon-free', () => {
    for (const option of PREFERENCE_OPTIONS_COPY) {
      expectJargonFree(`${option.label} ${option.description}`);
    }
  });

  it('every preferenceLabel and preferenceDescription output is jargon-free', () => {
    for (const option of PREFERENCE_OPTIONS) {
      expectJargonFree(preferenceLabel(option.kind));
      expectJargonFree(preferenceDescription(option.kind));
    }
  });

  it('every change-event label is jargon-free', () => {
    for (const kind of CHANGE_EVENT_KINDS) {
      expectJargonFree(eventLabel(kind));
    }
    expect(eventLabel('preference-saved')).toBe('Choice saved');
    expect(eventLabel('preference-applied')).toBe('Choice applied');
    expect(eventLabel('technical-override')).toBe('Technical change');
  });

  it('the state labels, pending note and technical placeholder are jargon-free', () => {
    expectJargonFree(preferenceStateLabel({ saved: false, pendingApplication: false }));
    expectJargonFree(preferenceStateLabel({ saved: true, pendingApplication: false }));
    expectJargonFree(preferenceStateLabel({ saved: true, pendingApplication: true }));
    expectJargonFree(PENDING_APPLICATION_NOTE);
    expectJargonFree(TECHNICAL_CHANGE_PLACEHOLDER);
    expect(PENDING_APPLICATION_NOTE).toContain('administrator');
    expect(TECHNICAL_CHANGE_PLACEHOLDER).toContain('advanced settings');
  });

  it('state and event tones pair with their labels (never color alone)', () => {
    expect(preferenceStateTone({ saved: false, pendingApplication: false })).toBe('neutral');
    expect(preferenceStateTone({ saved: true, pendingApplication: false })).toBe('positive');
    expect(preferenceStateTone({ saved: true, pendingApplication: true })).toBe('warning');
    expect(eventTone('preference-applied')).toBe('positive');
    expect(eventTone('technical-override')).toBe('neutral');
    expect(eventTone('preference-saved')).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('formats integer minor units as USD', () => {
    expect(formatUsdMinor(0)).toBe('$0.00');
    expect(formatUsdMinor(1)).toBe('$0.01');
    expect(formatUsdMinor(1234)).toBe('$12.34');
    expect(formatUsdMinor(1_000_000)).toBe('$10,000.00');
    expect(formatUsdMinor(-5)).toBe('-$0.05');
  });

  it('renders relative ages without locale data', () => {
    const now = '2026-10-10T12:00:00.000Z';
    expect(ageLabel('2026-10-10T11:59:45.000Z', now)).toBe('15s ago');
    expect(ageLabel('2026-10-10T11:30:00.000Z', now)).toBe('30m ago');
    expect(ageLabel('2026-10-09T12:00:00.000Z', now)).toBe('1d ago');
    expect(ageLabel('not-a-date', now)).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// Body parsing (the whole action vocabulary)
// ---------------------------------------------------------------------------

const ACCOUNT_ID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

describe('parseActionBody', () => {
  it('rejects non-object bodies and unknown actions with readable messages', () => {
    expect(parseActionBody(null).ok).toBe(false);
    expect(parseActionBody('x').ok).toBe(false);
    expect(parseActionBody([]).ok).toBe(false);
    const unknown = parseActionBody({ action: 'nope' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toContain(PROVIDER_PREFERENCES_ACTIONS.join(', '));
    }
    expect(parseActionBody({}).ok).toBe(false);
    expect(isProviderPreferencesAction('preference.save')).toBe(true);
    expect(isProviderPreferencesAction('preference.delete')).toBe(false);
  });

  it('parses a complete preference.save body (with and without a reason)', () => {
    const withNote = parseActionBody({
      action: 'preference.save',
      preference: 'privacy-first',
      note: '  compliance review  ',
    });
    expect(withNote).toEqual({
      ok: true,
      value: { action: 'preference.save', preference: 'privacy-first', note: 'compliance review' },
    });
    const bare = parseActionBody({ action: 'preference.save', preference: 'balanced' });
    expect(bare.ok).toBe(true);
    if (bare.ok && bare.value.action === 'preference.save') {
      expect(bare.value.note).toBeNull();
    }
    // A blank reason is no reason (the module re-validates either way).
    expect(parseActionBody({ action: 'preference.save', preference: 'balanced', note: '   ' }).ok)
      .toBe(true);
  });

  it('preference.save rejects bad preferences and bad reasons', () => {
    const badPreference = parseActionBody({ action: 'preference.save', preference: 'cheapest' });
    expect(badPreference.ok).toBe(false);
    if (!badPreference.ok) {
      expect(badPreference.error).toContain('privacy-first');
      expect(badPreference.error).toContain('balanced');
    }
    const longNote = parseActionBody({
      action: 'preference.save',
      preference: 'balanced',
      note: 'x'.repeat(MAX_NOTE_LENGTH + 1),
    });
    expect(longNote.ok).toBe(false);
    if (!longNote.ok) {
      expect(longNote.error).toContain(String(MAX_NOTE_LENGTH));
    }
    expect(
      parseActionBody({ action: 'preference.save', preference: 'balanced', note: 42 }).ok,
    ).toBe(false);
  });

  it('parses preference.apply (no fields)', () => {
    const parsed = parseActionBody({ action: 'preference.apply' });
    expect(parsed).toEqual({ ok: true, value: { action: 'preference.apply' } });
  });

  it('parses override.update with priority and/or status', () => {
    const both = parseActionBody({
      action: 'override.update',
      accountId: ACCOUNT_ID,
      priority: 33,
      status: 'disabled',
    });
    expect(both).toEqual({
      ok: true,
      value: {
        action: 'override.update',
        accountId: ACCOUNT_ID,
        priority: 33,
        status: 'disabled',
      },
    });
    const priorityOnly = parseActionBody({
      action: 'override.update',
      accountId: ACCOUNT_ID,
      priority: 0,
    });
    expect(priorityOnly.ok).toBe(true);
    if (priorityOnly.ok && priorityOnly.value.action === 'override.update') {
      expect(priorityOnly.value.priority).toBe(PRIORITY_MIN);
      expect(priorityOnly.value.status).toBeNull();
    }
    const statusOnly = parseActionBody({
      action: 'override.update',
      accountId: ACCOUNT_ID,
      status: 'active',
    });
    expect(statusOnly.ok).toBe(true);
  });

  it('override.update rejects non-uuid accounts, bad priorities, bad statuses and empty changes', () => {
    const badAccount = parseActionBody({ action: 'override.update', accountId: 'openai-1' });
    expect(badAccount.ok).toBe(false);
    if (!badAccount.ok) {
      expect(badAccount.error).toContain('account');
    }
    // An empty priority field means "no change" (the form sends it raw) —
    // only genuinely bad values are rejected here.
    for (const priority of [-1, PRIORITY_MAX + 1, 1.5, 'low', null]) {
      expect(
        parseActionBody({ action: 'override.update', accountId: ACCOUNT_ID, priority }).ok,
      ).toBe(false);
    }
    const badPriority = parseActionBody({
      action: 'override.update',
      accountId: ACCOUNT_ID,
      priority: 'low',
    });
    expect(badPriority.ok).toBe(false);
    if (!badPriority.ok) {
      expect(badPriority.error).toContain('whole number');
      expect(badPriority.error).toContain(String(PRIORITY_MIN));
      expect(badPriority.error).toContain(String(PRIORITY_MAX));
    }
    expect(
      parseActionBody({ action: 'override.update', accountId: ACCOUNT_ID, status: 'paused' }).ok,
    ).toBe(false);
    const empty = parseActionBody({ action: 'override.update', accountId: ACCOUNT_ID });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error).toContain('priority');
      expect(empty.error).toContain('status');
    }
  });
});

// ---------------------------------------------------------------------------
// Shell registration seams (the destination, the hub entry, the route
// catalog row — all asserted so the seams can never silently regress)
// ---------------------------------------------------------------------------

describe('provider-choice registration in the product shell', () => {
  it('the provider-choice destination rides the command registry exactly once', () => {
    expect(PROVIDER_PREFERENCES_DESTINATIONS).toHaveLength(1);
    expect(PROVIDER_PREFERENCES_DESTINATIONS[0]!.href).toBe('/provider-preferences');
    const commands = buildShellCommands();
    const surfaceCommands = commands.filter((command) =>
      command.id.startsWith('provider-preferences:'),
    );
    expect(surfaceCommands).toHaveLength(1);
    expect(surfaceCommands[0]!.id).toBe('provider-preferences:provider-choice');
    expect(surfaceCommands[0]!.target).toEqual({ kind: 'navigate', href: '/provider-preferences' });
    // Keyboard-reachable by the words a member would actually type.
    for (const query of ['choose', 'preference', 'privacy', 'cost']) {
      const matches = commands.filter(
        (command) =>
          command.title.toLowerCase().includes(query) ||
          command.keywords.some((keyword) => keyword.includes(query)),
      );
      expect(matches.map((command) => command.id)).toContain(
        'provider-preferences:provider-choice',
      );
    }
    // The registry keeps its unique-id invariant with the new command.
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });

  it('the capability hub carries the provider-choice entry', () => {
    const entry = capabilityEntries().find((candidate) => candidate.href === '/provider-preferences');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('provider-choice');
  });

  it('the journey-proof route catalog lists /provider-preferences as a product page', () => {
    const route = ROUTE_CATALOG.find((candidate) => candidate.path === '/provider-preferences');
    expect(route).toBeDefined();
    expect(route!.kind).toBe('page');
    expect(route!.area).toBe('product');
    expect(route!.auth).toBe('required');
  });
});
