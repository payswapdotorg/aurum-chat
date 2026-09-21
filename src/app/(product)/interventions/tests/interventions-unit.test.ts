// Unit tests for the interventions surface (W063) — the pure logic:
// the labeling vocabulary (tone + label + explanation triples), the
// seven-word comparison coverage derivation, the client-safe form
// validation, the API error mapping, and the contract-pinned mirrors
// (the client-safe constants cannot drift from the owning contracts).
//
// No DB, no DOM — the learning surface's unit-test discipline.

import { describe, expect, it } from 'vitest';
import {
  AGENT_PROVIDERS,
  AGENT_PERMISSIONS,
  InterventionInputError,
  MAX_TEAM_BUDGET_MINOR,
  PROPOSAL_DECISIONS,
  TEAM_LIFECYCLE_ACTIONS,
  TEAM_TOPOLOGIES,
  validateActivationInput,
  validateAgentDecisionInput,
  validateProposalDecisionInput,
  validateTeamComposeInput,
  validateTeamLifecycleInput,
} from '../lib/form';
import {
  AGENT_PERMISSION_SCOPES as CONTRACT_PERMISSIONS,
  AGENT_RUNTIME_PROVIDERS as CONTRACT_PROVIDERS,
} from '@/modules/agents/contract';
import { TEAM_TOPOLOGIES as CONTRACT_TOPOLOGIES } from '@/modules/agent-teams/contract';
import { AGENT_LIFECYCLE_CHANGES as CONTRACT_CHANGES } from '@/modules/agent-evaluation/contract';
import { RECRUITMENT_ALTERNATIVE_KINDS } from '@/modules/agent-recruitment/contract';
import { AUTOMATION_SOLUTION_TYPES } from '@/modules/automation/contract';
import { ALTERNATIVE_KINDS } from '@/modules/workforce/contract';
import {
  ALTERNATIVE_VOCABULARY,
  GATE_NOTE,
  HUMAN_AUTHORIZED_NOTE,
  OUTSOURCE_SOURCES_NOTE,
  UNCERTAINTY_NOTE,
  automationStatusLabel,
  automationStatusTone,
  dateLabel,
  decisionStatusExplanation,
  decisionStatusLabel,
  decisionStatusTone,
  gapStatusLabel,
  gapStatusTone,
  lifecycleChangeLabel,
  moneyLabel,
  outcomeAssessmentLabel,
  outcomeAssessmentTone,
  percentLabel,
  proposalStatusExplanation,
  proposalStatusLabel,
  proposalStatusTone,
  recommendationLabel,
  recommendationTone,
  solutionTypeLabel,
  teamStatusLabel,
  teamStatusTone,
  weeksLabel,
  workforceAlternativeLabel,
} from '../lib/labels';
import type { AutomationStatus } from '@/modules/automation/contract';
import type { TeamStatus } from '@/modules/agent-teams/contract';
import { interventionsApiError } from '../lib/api';
import { InterventionStateError } from '../lib/workflow';
import { suggestedSlugOf, vocabularyCoverage } from '../lib/views';
import { INTERVENTION_DESTINATIONS } from '@/app/(product)/lib/command-registry';

// ---------------------------------------------------------------------------
// The contract-pinned mirrors (the client-safe constants cannot drift)
// ---------------------------------------------------------------------------

describe('the client-safe vocabulary mirrors', () => {
  it('mirror the agents module provider and permission vocabularies exactly', () => {
    expect([...AGENT_PROVIDERS]).toEqual([...CONTRACT_PROVIDERS]);
    expect([...AGENT_PERMISSIONS]).toEqual([...CONTRACT_PERMISSIONS]);
  });

  it('mirrors the agent-teams topology vocabulary exactly', () => {
    expect([...TEAM_TOPOLOGIES]).toEqual([...CONTRACT_TOPOLOGIES]);
  });

  it('mirrors the agent-evaluation lifecycle vocabulary exactly', () => {
    const changes = ['retain', 'modify', 'terminate'] as const;
    expect([...changes]).toEqual([...CONTRACT_CHANGES]);
  });
});

// ---------------------------------------------------------------------------
// The seven-word comparison vocabulary
// ---------------------------------------------------------------------------

describe('the acquisition vocabulary', () => {
  it('carries exactly the seven words the work item names, in order', () => {
    expect(ALTERNATIVE_VOCABULARY.map((entry) => entry.word)).toEqual([
      'train',
      'reassign',
      'hire',
      'automate',
      'recruit',
      'install',
      'outsource',
    ]);
  });

  it('maps every recruitment alternative kind onto exactly one word', () => {
    const mapped = ALTERNATIVE_VOCABULARY.flatMap((entry) => entry.recruitmentKinds);
    expect([...mapped].sort()).toEqual([...RECRUITMENT_ALTERNATIVE_KINDS].sort());
  });

  it('maps every automation solution type onto a word except build (W064’s dimension)', () => {
    const mapped = new Set(
      ALTERNATIVE_VOCABULARY.flatMap((entry) => entry.solutionTypes),
    );
    for (const kind of AUTOMATION_SOLUTION_TYPES) {
      // build_extension is the eighth §13 option — the builder/marketplace
      // dimension (W064's surface), honestly beyond this work item's
      // seven-word acceptance vocabulary.
      if (kind === 'build_extension') continue;
      expect(mapped.has(kind)).toBe(true);
    }
    expect(mapped.has('build_extension')).toBe(false);
  });

  it('maps every workforce alternative kind the hub counts onto a word', () => {
    const mapped = new Set(ALTERNATIVE_VOCABULARY.flatMap((entry) => entry.workforceKinds));
    for (const kind of ALTERNATIVE_KINDS) {
      // process_improvement / investigate_further / no_change are
      // honest nulls (not acquisition channels); every other workforce
      // alternative maps onto a compared word.
      if (['process_improvement', 'investigate_further', 'no_change'].includes(kind)) continue;
      expect(mapped.has(kind)).toBe(true);
    }
  });

  it('only the outsource word has no recruitment mapping — and the note says so', () => {
    const outsource = ALTERNATIVE_VOCABULARY.find((entry) => entry.word === 'outsource');
    expect(outsource?.recruitmentKinds).toEqual([]);
    expect(outsource?.solutionTypes).toContain('outsource');
    expect(outsource?.workforceKinds).toContain('outsource');
    expect(OUTSOURCE_SOURCES_NOTE).toContain('Outsourcing is compared');
  });
});

describe('vocabularyCoverage', () => {
  const proposals = [
    {
      alternatives: [
        { kind: 'train' },
        { kind: 'recruit' },
        { kind: 'hire' },
      ],
    },
    {
      alternatives: [
        { kind: 'install' },
        { kind: 'automate' },
      ],
    },
  ];
  const opportunities = [
    { solutionTypes: ['outsource', 'recruit_agent_team'] },
    { solutionTypes: ['train_employee'] },
  ];
  const assessments = [
    {
      content: {
        alternatives: [
          { kind: 'outsource' },
          { kind: 'reassign' },
        ],
      },
    },
  ];

  it('counts where each word is compared across the three families', () => {
    const coverage = vocabularyCoverage(proposals, opportunities, assessments);
    const byWord = new Map(coverage.map((entry) => [entry.word, entry]));

    expect(byWord.get('train')).toMatchObject({
      proposalCount: 1,
      automationCount: 1,
      workforceCount: 0,
      total: 2,
    });
    expect(byWord.get('reassign')).toMatchObject({
      proposalCount: 0,
      automationCount: 0,
      workforceCount: 1,
      total: 1,
    });
    expect(byWord.get('hire')).toMatchObject({ proposalCount: 1, total: 1 });
    expect(byWord.get('automate')).toMatchObject({ proposalCount: 1, total: 1 });
    expect(byWord.get('recruit')).toMatchObject({
      proposalCount: 1,
      automationCount: 1,
      workforceCount: 0,
      total: 2,
    });
    expect(byWord.get('install')).toMatchObject({ proposalCount: 1, total: 1 });
    expect(byWord.get('outsource')).toMatchObject({
      proposalCount: 0,
      automationCount: 1,
      workforceCount: 1,
      total: 2,
    });
  });

  it('returns all seven words with zeroed counts over empty inputs', () => {
    const coverage = vocabularyCoverage([], [], []);
    expect(coverage).toHaveLength(7);
    expect(coverage.every((entry) => entry.total === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The labeling vocabulary (tone + label pairs are distinct and honest)
// ---------------------------------------------------------------------------

describe('the labeling vocabulary', () => {
  it('proposal status labels are distinct and tones are valid', () => {
    const statuses = [
      'proposed',
      'awaiting_approval',
      'approved',
      'rejected',
      'withdrawn',
    ] as const;
    const labels = statuses.map((status) => proposalStatusLabel(status));
    expect(new Set(labels).size).toBe(labels.length);
    for (const status of statuses) {
      expect(proposalStatusTone(status)).toMatch(/positive|warning|error|neutral|info/);
      expect(proposalStatusExplanation(status).length).toBeGreaterThan(20);
    }
  });

  it('gap status labels and tones cover the four classifications', () => {
    const statuses = ['uncovered', 'level_shortfall', 'capacity_shortfall', 'covered'] as const;
    const labels = statuses.map((status) => gapStatusLabel(status));
    expect(new Set(labels).size).toBe(4);
    expect(gapStatusTone('uncovered')).toBe('error');
    expect(gapStatusTone('covered')).toBe('positive');
  });

  it('automation and team labels are distinct', () => {
    const automationStatuses: AutomationStatus[] = ['candidate', 'accepted', 'dismissed'];
    const teamStatuses: TeamStatus[] = ['draft', 'active', 'dissolved'];
    expect(new Set(automationStatuses.map((status) => automationStatusLabel(status))).size).toBe(3);
    expect(new Set(teamStatuses.map((status) => teamStatusLabel(status))).size).toBe(3);
    expect(automationStatusTone('accepted')).toBe('positive');
    expect(teamStatusTone('draft')).toBe('info');
  });

  it('recommendation labels cover the workforce vocabulary with honest tones', () => {
    expect(recommendationLabel('termination')).toBe('Termination');
    expect(recommendationTone('termination')).toBe('error');
    expect(recommendationTone('training')).toBe('info');
    expect(recommendationTone('monitor')).toBe('neutral');
    expect(recommendationLabel('no_action')).toBe('No action');
  });

  it('workforce alternative labels cover the closed vocabulary', () => {
    expect(workforceAlternativeLabel('outsource')).toBe('Outsource');
    expect(workforceAlternativeLabel('recruit_agent')).toBe('Recruit an agent');
    for (const kind of ALTERNATIVE_KINDS) {
      expect(workforceAlternativeLabel(kind).length).toBeGreaterThan(0);
    }
  });

  it('lifecycle and decision labels are distinct with honest tones', () => {
    expect(lifecycleChangeLabel('retain')).toBe('Retain');
    expect(lifecycleChangeLabel('modify')).toBe('Modify');
    expect(lifecycleChangeLabel('terminate')).toBe('Terminate');
    const statuses = [
      'recorded',
      'awaiting_approval',
      'approved',
      'applied',
      'refused',
    ] as const;
    const labels = statuses.map((status) => decisionStatusLabel(status));
    expect(new Set(labels).size).toBe(labels.length);
    expect(decisionStatusTone('refused')).toBe('error');
    expect(decisionStatusTone('awaiting_approval')).toBe('warning');
    for (const status of statuses) {
      expect(decisionStatusExplanation(status).length).toBeGreaterThan(20);
    }
  });

  it('team outcome assessments carry tone + label pairs', () => {
    expect(outcomeAssessmentTone('met')).toBe('positive');
    expect(outcomeAssessmentTone('missed')).toBe('error');
    expect(outcomeAssessmentLabel('partial')).toBe('Partially met');
  });

  it('solution type labels cover the automation vocabulary', () => {
    for (const kind of AUTOMATION_SOLUTION_TYPES) {
      expect(solutionTypeLabel(kind).length).toBeGreaterThan(0);
    }
    expect(solutionTypeLabel('outsource')).toBe('Outsource');
  });

  it('formatters are calm and total', () => {
    expect(moneyLabel(123_456, 'USD')).toBe('1,234.56 USD');
    expect(percentLabel(0.42)).toBe('42%');
    expect(weeksLabel(null)).toBe('unknown timeline');
    expect(weeksLabel(1)).toBe('1 week');
    expect(weeksLabel(3)).toBe('3 weeks');
    expect(dateLabel('not-a-date')).toBe('not-a-date');
  });

  it('the policy notes say the binding things', () => {
    expect(HUMAN_AUTHORIZED_NOTE).toContain('never autonomously terminates');
    expect(UNCERTAINTY_NOTE).toContain('confidence');
    expect(GATE_NOTE).toContain('never be the one who decides');
  });
});

// ---------------------------------------------------------------------------
// The form validation (client-safe, pure)
// ---------------------------------------------------------------------------

describe('the proposal decision validation', () => {
  it('accepts approve and reject with an optional note', () => {
    expect(validateProposalDecisionInput({ decision: 'approve' })).toEqual({
      decision: 'approve',
      note: null,
    });
    expect(validateProposalDecisionInput({ decision: 'reject', note: ' too costly ' })).toEqual({
      decision: 'reject',
      note: 'too costly',
    });
  });

  it('refuses an unknown decision', () => {
    expect(() => validateProposalDecisionInput({ decision: 'maybe' })).toThrow(InterventionInputError);
  });

  it('refuses non-string notes', () => {
    expect(() => validateProposalDecisionInput({ decision: 'approve', note: 42 })).toThrow(
      InterventionInputError,
    );
  });
});

describe('the activation validation', () => {
  const base = {
    slug: 'cold-chain-monitor',
    role: 'Monitor the cold chain',
    provider: 'langgraph',
    instructions: 'Watch freshness signals and flag breaches.',
    permissions: ['observe', 'analyze'],
  };

  it('accepts a well-formed activation and trims it', () => {
    const validated = validateActivationInput({ ...base, displayName: '  Cold Chain  ' });
    expect(validated.displayName).toBe('Cold Chain');
    expect(validated.permissions).toEqual(['observe', 'analyze']);
  });

  it('refuses a malformed slug', () => {
    expect(() => validateActivationInput({ ...base, slug: 'Bad Slug!' })).toThrow(InterventionInputError);
    expect(() => validateActivationInput({ ...base, slug: '' })).toThrow(InterventionInputError);
  });

  it('refuses an unknown provider and empty permissions', () => {
    expect(() => validateActivationInput({ ...base, provider: 'skynet' })).toThrow(InterventionInputError);
    expect(() => validateActivationInput({ ...base, permissions: [] })).toThrow(InterventionInputError);
  });

  it('refuses unknown permission scopes and duplicates collapse', () => {
    expect(() =>
      validateActivationInput({ ...base, permissions: ['observe', 'root'] }),
    ).toThrow(InterventionInputError);
    expect(
      validateActivationInput({ ...base, permissions: ['observe', 'observe'] }).permissions,
    ).toEqual(['observe']);
  });
});

describe('the team compose validation', () => {
  const agentId = '1a2b3c4d-0000-4000-8000-000000000001';
  const base = {
    displayName: 'Cold-chain cell',
    topology: 'flat',
    members: [{ agentId, role: 'watcher' }],
    objective: 'Keep freshness above the floor.',
    budgetAmount: '1500.50',
    budgetCurrency: 'USD',
  };

  it('converts the decimal budget to integer minor units', () => {
    const validated = validateTeamComposeInput(base);
    expect(validated.budgetAmountMinor).toBe(150_050);
    expect(validated.budgetCurrency).toBe('USD');
  });

  it('refuses an empty roster and duplicate agents', () => {
    expect(() => validateTeamComposeInput({ ...base, members: [] })).toThrow(InterventionInputError);
    expect(() =>
      validateTeamComposeInput({
        ...base,
        members: [
          { agentId, role: 'a' },
          { agentId, role: 'b' },
        ],
      }),
    ).toThrow(InterventionInputError);
  });

  it('refuses a bad member id, a missing objective and a bad currency', () => {
    expect(() =>
      validateTeamComposeInput({ ...base, members: [{ agentId: 'nope', role: 'x' }] }),
    ).toThrow(InterventionInputError);
    expect(() => validateTeamComposeInput({ ...base, objective: '   ' })).toThrow(InterventionInputError);
    expect(() => validateTeamComposeInput({ ...base, budgetCurrency: 'usd' })).toThrow(InterventionInputError);
  });

  it('refuses a negative or non-numeric budget and over-max amounts', () => {
    expect(() => validateTeamComposeInput({ ...base, budgetAmount: '-5' })).toThrow(InterventionInputError);
    expect(() => validateTeamComposeInput({ ...base, budgetAmount: 'abc' })).toThrow(InterventionInputError);
    expect(() =>
      validateTeamComposeInput({ ...base, budgetAmount: `${MAX_TEAM_BUDGET_MINOR + 1}` }),
    ).toThrow(InterventionInputError);
  });
});

describe('the team lifecycle validation', () => {
  it('requires a reason to dissolve', () => {
    expect(validateTeamLifecycleInput({ action: 'activate' })).toEqual({
      action: 'activate',
      reason: null,
    });
    expect(() => validateTeamLifecycleInput({ action: 'dissolve' })).toThrow(InterventionInputError);
    expect(validateTeamLifecycleInput({ action: 'dissolve', reason: 'objective retired' })).toEqual({
      action: 'dissolve',
      reason: 'objective retired',
    });
    expect(() => validateTeamLifecycleInput({ action: 'pause' })).toThrow(InterventionInputError);
  });
});

describe('the agent lifecycle decision validation', () => {
  it('accepts a retain decision with a rationale', () => {
    expect(
      validateAgentDecisionInput({ change: 'retain', rationale: ' performing well ' }),
    ).toEqual({ change: 'retain', rationale: 'performing well', note: null, modificationSummary: null, replacementOptionId: null });
  });

  it('requires a modification summary on modify', () => {
    expect(() =>
      validateAgentDecisionInput({ change: 'modify', rationale: 'narrow the scopes' }),
    ).toThrow(InterventionInputError);
    expect(
      validateAgentDecisionInput({
        change: 'modify',
        rationale: 'narrow the scopes',
        modificationSummary: 'drop the execute scope',
      }).modificationSummary,
    ).toBe('drop the execute scope');
  });

  it('validates the cited replacement option id on terminate', () => {
    expect(() =>
      validateAgentDecisionInput({ change: 'terminate', rationale: 'x', replacementOptionId: 'nope' }),
    ).toThrow(InterventionInputError);
    const optionId = '1a2b3c4d-0000-4000-8000-000000000002';
    expect(
      validateAgentDecisionInput({
        change: 'terminate',
        rationale: 'retire it',
        replacementOptionId: optionId,
      }).replacementOptionId,
    ).toBe(optionId);
  });

  it('refuses an unknown change and an empty rationale', () => {
    expect(() => validateAgentDecisionInput({ change: 'promote', rationale: 'x' })).toThrow(InterventionInputError);
    expect(() => validateAgentDecisionInput({ change: 'retain', rationale: '' })).toThrow(InterventionInputError);
  });
});

// ---------------------------------------------------------------------------
// The API error mapping
// ---------------------------------------------------------------------------

describe('interventionsApiError', () => {
  it('maps the surface errors first', () => {
    const input = new InterventionInputError('bad input');
    expect(interventionsApiError(input)).toEqual({
      status: 400,
      body: { error: 'invalid_intervention_input', message: 'bad input' },
    });
    const state = new InterventionStateError('wrong state');
    expect(interventionsApiError(state).status).toBe(409);
  });

  it('maps code-carrying domain errors to honest statuses', () => {
    const notFound = Object.assign(new Error('no such proposal'), { code: 'proposal_not_found' });
    expect(interventionsApiError(notFound).status).toBe(404);
    const forbidden = Object.assign(new Error('no claim'), { code: 'forbidden' });
    expect(interventionsApiError(forbidden).status).toBe(403);
    const policyForbidden = Object.assign(new Error('policy forbids'), {
      code: 'forbidden_by_policy',
    });
    expect(interventionsApiError(policyForbidden).status).toBe(403);
    const transition = Object.assign(new Error('already dissolved'), {
      code: 'invalid_transition',
    });
    expect(interventionsApiError(transition).status).toBe(409);
    const badInput = Object.assign(new Error('bad shape'), { code: 'invalid_team_input' });
    expect(interventionsApiError(badInput).status).toBe(400);
  });

  it('maps unknown failures to 500', () => {
    expect(interventionsApiError(new Error('boom')).status).toBe(500);
    expect(interventionsApiError('nope').status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The pure view derivations
// ---------------------------------------------------------------------------

describe('suggestedSlugOf', () => {
  it('slugifies proposal titles into agent slugs', () => {
    expect(suggestedSlugOf('Cold-chain coverage for the Q4 peak!')).toBe(
      'cold-chain-coverage-for-the-q4-peak',
    );
    expect(suggestedSlugOf('   ')).toBe('recruited-agent');
    expect(suggestedSlugOf('Ünïcode Tïtles')).toBe('n-code-t-tles');
  });
});

// ---------------------------------------------------------------------------
// The command-registry destination (keyboard discoverability)
// ---------------------------------------------------------------------------

describe('the interventions command destination', () => {
  it('is registered once with the acceptance vocabulary in its keywords', () => {
    expect(INTERVENTION_DESTINATIONS).toHaveLength(1);
    const destination = INTERVENTION_DESTINATIONS[0]!;
    expect(destination.href).toBe('/interventions');
    const keywords = destination.keywords.join(' ');
    for (const word of ['train', 'reassign', 'hire', 'automate', 'recruit', 'install', 'outsource']) {
      expect(keywords).toContain(word);
    }
    for (const word of ['proposal', 'approval', 'activate', 'topology', 'budget', 'terminate', 'outcomes']) {
      expect(keywords).toContain(word);
    }
  });

  it('the proposal decision and team action vocabularies stay closed', () => {
    expect([...PROPOSAL_DECISIONS]).toEqual(['approve', 'reject']);
    expect([...TEAM_LIFECYCLE_ACTIONS]).toEqual(['activate', 'dissolve']);
  });
});
