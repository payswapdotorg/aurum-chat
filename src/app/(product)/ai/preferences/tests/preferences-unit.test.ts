// Unit tests for the AI-preferences product surface's PURE logic (W091):
// the jargon-free label vocabulary (the acceptance's first clause,
// locked at the surface too), the client-safe vocabulary copies (locked
// to the module contract), the API body parsers, the error mapping, and
// the discovery registrations (capability hub + command search + the
// route catalog). No database — the integration suite covers the
// contract compositions through the real API handlers.

import { describe, expect, it } from 'vitest';
import {
  ADVANCED_GATE_NOTE,
  ORDINARY_NOTE,
  PREFERENCE_OUTCOMES,
  OUTCOME_EXPLANATIONS,
  ageLabel,
  capabilityLabel,
  decisionLabel,
  decisionTone,
  outcomeLabel,
  policyFirstNote,
  preferenceSourceLabel,
  priorityPositionLabel,
} from '../lib/labels';
import {
  PREFERENCE_ACTIONS,
  PreferenceActionParseError,
  actionErrorStatus,
  isPreferenceAction,
  parseActionBody,
} from '../lib/actions';
import { buildPreferencesView } from '../lib/views';
import { OverrideForm } from '../components/controls';
import {
  PROVIDER_PREFERENCE_OUTCOMES,
  ProviderPreferencesError,
} from '@/modules/provider-preferences/contract';
import { LLM_PROVIDERS } from '@/modules/llm/contract';
import {
  AI_DESTINATIONS,
  buildShellCommands,
  filterShellCommands,
} from '../../../lib/command-registry';
import { capabilityEntry, capabilityEntries } from '../../../lib/capability-hub';
import { ROUTE_CATALOG } from '@/modules/journey-proof/contract';

// ---------------------------------------------------------------------------
// Jargon discipline — the ordinary surface's vocabulary
// ---------------------------------------------------------------------------

/** Provider-ish tokens that must NEVER appear in ordinary-surface language. */
const FORBIDDEN = [
  ...LLM_PROVIDERS,
  'openai',
  'anthropic',
  'gpt',
  'claude',
  'gemini',
  'llm',
  'sdk',
  'endpoint',
  'adapter',
  'gateway',
  'model',
  'account id',
  'byoa',
];

/** Every ordinary-surface string a user can read. */
function ordinaryStrings(): string[] {
  return [
    ORDINARY_NOTE,
    ADVANCED_GATE_NOTE,
    ...PREFERENCE_OUTCOMES.map((outcome) => outcomeLabel(outcome)),
    ...PREFERENCE_OUTCOMES.map((outcome) => OUTCOME_EXPLANATIONS[outcome]),
    ...['cost', 'privacy', 'quality', 'speed'].map((outcome) =>
      policyFirstNote(outcome === 'privacy'),
    ),
    ...[
      'organizational-policy',
      'tenant-priority',
      'personal-preference',
      'default',
    ].map((source) => preferenceSourceLabel(source as never)),
    ...['technical-override', 'preference', 'single-choice', 'no-choice'].map((decision) =>
      decisionLabel(decision as never),
    ),
    ...['text-generation', 'embedding', 'vision'].map((capability) =>
      capabilityLabel(capability),
    ),
    ...[1, 2, 3, 4].map((position) => priorityPositionLabel(position)),
  ];
}

describe('the ordinary surface speaks outcomes, never jargon', () => {
  it('no ordinary label, note or explanation contains a provider name or technical term', () => {
    for (const text of ordinaryStrings()) {
      const lower = text.toLowerCase();
      for (const token of FORBIDDEN) {
        expect(lower.includes(token), `'${text}' leaked '${token}'`).toBe(false);
      }
    }
  });

  it('the ordinary strings never use the word "provider"', () => {
    // ADVANCED_GATE_NOTE says "which specific AI option is used" — the
    // one place the concept is explained, in task language; the word
    // itself stays out of every ordinary string.
    for (const text of ordinaryStrings()) {
      if (text === ADVANCED_GATE_NOTE) continue;
      expect(text.toLowerCase().includes('provider')).toBe(false);
    }
  });

  it('every outcome has a label, a meaning and a client-safe vocabulary lock', () => {
    expect([...PREFERENCE_OUTCOMES]).toEqual([...PROVIDER_PREFERENCE_OUTCOMES]);
    for (const outcome of PROVIDER_PREFERENCE_OUTCOMES) {
      expect(outcomeLabel(outcome).length).toBeGreaterThan(4);
      expect(OUTCOME_EXPLANATIONS[outcome].length).toBeGreaterThan(20);
    }
  });

  it('decision tones are visual-complementary, never meaning-alone', () => {
    expect(decisionTone('preference')).toBe('positive');
    expect(decisionTone('no-choice')).toBe('warning');
    expect(decisionTone('single-choice')).toBe('info');
    expect(decisionTone('technical-override')).toBe('info');
  });

  it('age labels render without locale data', () => {
    const now = '2026-10-05T12:00:00Z';
    expect(ageLabel('2026-10-05T11:59:40Z', now)).toBe('just now');
    expect(ageLabel('2026-10-05T11:30:00Z', now)).toBe('30 minutes ago');
    expect(ageLabel('2026-10-04T12:00:00Z', now)).toBe('1 day ago');
    expect(ageLabel('garbage', now)).toBe('some time ago');
  });

  it('unknown capabilities degrade to their key, not an error', () => {
    expect(capabilityLabel('vision')).toBe('vision');
    expect(capabilityLabel('text-generation')).toBe('Writing and analysis');
  });
});

// ---------------------------------------------------------------------------
// Action parsing + error mapping
// ---------------------------------------------------------------------------

describe('parseActionBody', () => {
  it('rejects non-object bodies and unknown actions', () => {
    expect(() => parseActionBody(null)).toThrow(PreferenceActionParseError);
    expect(() => parseActionBody('preference.setPersonal')).toThrow(PreferenceActionParseError);
    expect(() => parseActionBody({ action: 'preference.setCompany' })).toThrow(
      PreferenceActionParseError,
    );
  });

  it('parses a complete preference.setPersonal body', () => {
    expect(
      parseActionBody({ action: 'preference.setPersonal', outcomePriority: ['cost', 'speed'] }),
    ).toEqual({ action: 'preference.setPersonal', outcomePriority: ['cost', 'speed'] });
  });

  it('rejects bad priority lists (vocabulary, duplicates, length)', () => {
    expect(() =>
      parseActionBody({ action: 'preference.setPersonal', outcomePriority: ['thrift'] }),
    ).toThrow(PreferenceActionParseError);
    expect(() =>
      parseActionBody({ action: 'preference.setPersonal', outcomePriority: ['cost', 'cost'] }),
    ).toThrow(PreferenceActionParseError);
    expect(() =>
      parseActionBody({ action: 'preference.setPersonal', outcomePriority: [] }),
    ).toThrow(PreferenceActionParseError);
  });

  it('preference.clearPersonal takes no fields', () => {
    expect(parseActionBody({ action: 'preference.clearPersonal' })).toEqual({
      action: 'preference.clearPersonal',
    });
  });

  it('preference.setTenant requires the boolean posture', () => {
    expect(
      parseActionBody({
        action: 'preference.setTenant',
        outcomePriority: ['privacy'],
        policyFirst: true,
      }),
    ).toEqual({
      action: 'preference.setTenant',
      outcomePriority: ['privacy'],
      policyFirst: true,
    });
    expect(() =>
      parseActionBody({
        action: 'preference.setTenant',
        outcomePriority: ['privacy'],
        policyFirst: 'yes',
      }),
    ).toThrow(PreferenceActionParseError);
  });

  it('override actions normalize the capability scope (null = whole gateway)', () => {
    expect(
      parseActionBody({
        action: 'override.set',
        capability: 'text-generation',
        provider: 'openai',
        reason: 'Pin reason.',
      }),
    ).toEqual({
      action: 'override.set',
      gateway: 'llm',
      capability: 'text-generation',
      provider: 'openai',
      reason: 'Pin reason.',
    });
    expect(
      parseActionBody({
        action: 'override.set',
        capability: '',
        provider: 'anthropic',
        reason: 'Whole gateway.',
      }),
    ).toEqual({
      action: 'override.set',
      gateway: 'llm',
      capability: null,
      provider: 'anthropic',
      reason: 'Whole gateway.',
    });
    expect(() =>
      parseActionBody({ action: 'override.set', capability: null, provider: 'openai', reason: '' }),
    ).toThrow(PreferenceActionParseError);
    expect(parseActionBody({ action: 'override.clear', capability: 'embedding' })).toEqual({
      action: 'override.clear',
      gateway: 'llm',
      capability: 'embedding',
    });
  });

  it('the action vocabulary is closed', () => {
    expect(PREFERENCE_ACTIONS).toContain('preference.setPersonal');
    expect(isPreferenceAction('override.set')).toBe(true);
    expect(isPreferenceAction('override.delete')).toBe(false);
  });
});

describe('actionErrorStatus mapping', () => {
  it('maps parse errors, module authority gates and not-founds to honest statuses', () => {
    expect(actionErrorStatus(new PreferenceActionParseError('x'))).toMatchObject({ status: 400 });
    expect(
      actionErrorStatus(new ProviderPreferencesError('unauthorized', 'no claim')),
    ).toMatchObject({ status: 403 });
    expect(
      actionErrorStatus(new ProviderPreferencesError('invalid_input', 'bad')),
    ).toMatchObject({ status: 400 });
    expect(
      actionErrorStatus(new ProviderPreferencesError('override_not_found', 'gone')),
    ).toMatchObject({ status: 404 });
    expect(actionErrorStatus(new Error('boom'))).toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// Discovery registrations (the W091 surface is findable)
// ---------------------------------------------------------------------------

describe('discovery registrations', () => {
  it('the capability hub carries the preferences entries (More → the AI family)', () => {
    expect(capabilityEntry('ai-preferences').href).toBe('/ai/preferences');
    expect(capabilityEntry('ai-preferences').label).toMatch(/what matters/i);
    expect(capabilityEntry('ai-preferences-advanced').href).toBe('/ai/preferences/advanced');
    expect(capabilityEntry('ai-preferences-advanced').note).toBe('authorized administrators');
    const hubHrefs = new Set(capabilityEntries().map((entry) => entry.href));
    expect(hubHrefs.has('/ai/preferences')).toBe(true);
    expect(hubHrefs.has('/ai/preferences/advanced')).toBe(true);
  });

  it('the command search reaches both surfaces by task language', () => {
    const commands = buildShellCommands();
    const navigateHrefs = new Set(
      commands
        .filter((command) => command.target.kind === 'navigate')
        .map((command) => (command.target as { href: string }).href),
    );
    expect(navigateHrefs.has('/ai/preferences')).toBe(true);
    expect(navigateHrefs.has('/ai/preferences/advanced')).toBe(true);
    expect(AI_DESTINATIONS.map((destination) => destination.href)).toContain('/ai');
  });

  it('task queries find the destinations that do them', () => {
    const commands = buildShellCommands();
    const firstHref = (query: string): string => {
      const results = filterShellCommands(commands, query);
      expect(results.length, `query '${query}' must match something`).toBeGreaterThan(0);
      const target = results[0]!.command.target;
      return target.kind === 'navigate' ? target.href : '';
    };
    expect(firstHref('choose what matters')).toBe('/ai/preferences');
    expect(firstHref('cheap ai')).toBe('/ai/preferences');
    expect(firstHref('spending limit')).toBe('/ai/preferences');
    expect(firstHref('data protection')).toBe('/ai/preferences');
    expect(firstHref('advanced ai')).toBe('/ai/preferences/advanced');
    // The W066 destinations still own their tasks (no regression).
    expect(firstHref('add ai')).toBe('/ai');
    expect(firstHref('no model')).toBe('/ai');
    expect(firstHref('connect')).toBe('/connections');
    expect(firstHref('install')).toBe('/marketplace');
    expect(firstHref('api key')).toBe('/developer');
    expect(firstHref('company')).toBe('/onboarding');
  });

  it('the route catalog carries both pages and the API surface', () => {
    const paths = new Set(ROUTE_CATALOG.map((route) => route.path));
    expect(paths.has('/ai/preferences')).toBe(true);
    expect(paths.has('/ai/preferences/advanced')).toBe(true);
    expect(paths.has('/api/product/ai/preferences')).toBe(true);
  });

  it('the hub and command labels stay task-language (no module-first prefixes)', () => {
    const moduleFirst =
      /^(Marketplace|Intelligence|Learning|Interventions|AI providers|Evidence & audit|Developer)\s*[—-]/;
    for (const entry of capabilityEntries()) {
      expect(moduleFirst.test(entry.label), entry.label).toBe(false);
    }
    for (const command of buildShellCommands()) {
      expect(moduleFirst.test(command.title), command.title).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The view helper's shape contract (no database — the pure projection)
// ---------------------------------------------------------------------------

describe('view model shape', () => {
  it('buildPreferencesView is the module-composed read (server-only, exercised by the integration suite)', () => {
    // The pure contract: the view builder exists and the labels module
    // stays importable from client components (the controls import it).
    expect(typeof buildPreferencesView).toBe('function');
  });

  it('the client controls are client components that render from the labels only', () => {
    // The controls module must stay importable WITHOUT a database —
    // importing it here proves no server-only import leaked into it.
    expect(typeof OverrideForm).toBe('function');
  });
});
