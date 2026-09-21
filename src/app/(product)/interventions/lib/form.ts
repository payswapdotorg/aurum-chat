// Capability, workforce & agent interventions (W063) — the CLIENT-SAFE
// pure module for the surface's write forms: constants, types and input
// validation with ZERO imports (no module contracts — they pull the
// server-only db layer into the browser bundle; the shell's
// client-safety rule, see navigation.ts).
//
// The server workflow (lib/workflow.ts) imports THIS module so the
// bounds and the closed vocabularies have exactly one definition — the
// browser form and the server validation can never drift. Where a
// vocabulary is owned by a domain module (the agents module's runtime
// providers and permission scopes, the agent-teams topology words, the
// agent-evaluation lifecycle changes) the words are mirrored here as
// literal copies and PINNED to the owning contract by the unit tests
// (interventions-unit.test.ts asserts the mirror equals the contract) —
// the established double-declaration discipline for client-safe
// surfaces.

// ---------------------------------------------------------------------------
// The mirrored closed vocabularies (pinned to contracts by unit tests)
// ---------------------------------------------------------------------------

/**
 * The agent runtime providers the activation form offers — a literal
 * mirror of the agents module's AGENT_RUNTIME_PROVIDERS (W021's closed
 * vocabulary; the unit test pins equality).
 */
export const AGENT_PROVIDERS = [
  'openai-assistants',
  'langgraph',
  'crewai',
  'autogen',
  'semantic-kernel',
] as const;
export type AgentProviderOption = (typeof AGENT_PROVIDERS)[number];

/**
 * The permission scopes the activation form can grant — a literal mirror
 * of the agents module's AGENT_PERMISSION_SCOPES (the §20 ladder's scope
 * vocabulary; pinned by the unit test).
 */
export const AGENT_PERMISSIONS = [
  'observe',
  'analyze',
  'recommend',
  'ask',
  'propose',
  'execute',
] as const;
export type AgentPermissionOption = (typeof AGENT_PERMISSIONS)[number];

/** The provider copy for the activation form's select. */
export const AGENT_PROVIDER_OPTIONS: readonly { value: AgentProviderOption; label: string }[] = [
  { value: 'openai-assistants', label: 'OpenAI Assistants' },
  { value: 'langgraph', label: 'LangGraph' },
  { value: 'crewai', label: 'CrewAI' },
  { value: 'autogen', label: 'AutoGen' },
  { value: 'semantic-kernel', label: 'Semantic Kernel' },
];

/** The team topologies the compose form offers (agent-teams' closed pair). */
export const TEAM_TOPOLOGIES = ['flat', 'hierarchical'] as const;
export type TeamTopologyOption = (typeof TEAM_TOPOLOGIES)[number];

/** The agent lifecycle changes the decision form offers (W024's words). */
export const AGENT_LIFECYCLE_CHANGES = ['retain', 'modify', 'terminate'] as const;
export type AgentLifecycleOption = (typeof AGENT_LIFECYCLE_CHANGES)[number];

/** The proposal decisions the approval form offers. */
export const PROPOSAL_DECISIONS = ['approve', 'reject'] as const;
export type ProposalDecisionOption = (typeof PROPOSAL_DECISIONS)[number];

/** The team lifecycle actions the team form offers. */
export const TEAM_LIFECYCLE_ACTIONS = ['activate', 'dissolve'] as const;
export type TeamLifecycleOption = (typeof TEAM_LIFECYCLE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Input bounds (the owning contracts' bounds, mirrored)
// ---------------------------------------------------------------------------

/** The agents module's slug/role/instructions bounds (activation form). */
export const MAX_AGENT_SLUG_LENGTH = 64;
export const MIN_AGENT_SLUG_LENGTH = 2;
export const MAX_AGENT_ROLE_CHARS = 128;
export const MAX_AGENT_INSTRUCTIONS_CHARS = 32_000;
export const MAX_AGENT_DISPLAY_NAME_CHARS = 128;

/** The agent-teams module's compose bounds. */
export const MAX_TEAM_DISPLAY_NAME_CHARS = 128;
export const MAX_TEAM_DESCRIPTION_CHARS = 2_000;
export const MAX_TEAM_ROLE_CHARS = 128;
export const MAX_TEAM_OBJECTIVE_CHARS = 2_000;
export const MAX_TEAM_SUCCESS_CRITERIA_CHARS = 2_000;
export const MAX_TEAM_MEMBERS = 32;
export const MAX_TEAM_OWNER_PRINCIPAL_CHARS = 200;
/** The largest minor-unit amount the teams policy accepts. */
export const MAX_TEAM_BUDGET_MINOR = 9_007_199_254_740_991;

/** The agent-evaluation module's decision bounds. */
export const MAX_DECISION_RATIONALE_CHARS = 2_000;
export const MAX_DECISION_NOTE_CHARS = 2_000;
export const MAX_MODIFICATION_SUMMARY_CHARS = 2_000;

/** The note bound shared by the approval and dissolution forms. */
export const MAX_NOTE_CHARS = 2_000;

// ---------------------------------------------------------------------------
// The error (one honest code — maps to 400)
// ---------------------------------------------------------------------------

/** Why an intervention INPUT was refused (honest, never silent). */
export class InterventionInputError extends Error {
  readonly code: 'invalid_intervention_input';
  constructor(message: string) {
    super(message);
    this.code = 'invalid_intervention_input';
  }
}

// ---------------------------------------------------------------------------
// Type guards (pure)
// ---------------------------------------------------------------------------

export function isAgentProvider(value: string): value is AgentProviderOption {
  return (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export function isAgentPermission(value: string): value is AgentPermissionOption {
  return (AGENT_PERMISSIONS as readonly string[]).includes(value);
}

export function isTeamTopology(value: string): value is TeamTopologyOption {
  return value === 'flat' || value === 'hierarchical';
}

export function isAgentLifecycleChange(value: string): value is AgentLifecycleOption {
  return (AGENT_LIFECYCLE_CHANGES as readonly string[]).includes(value);
}

export function isProposalDecision(value: string): value is ProposalDecisionOption {
  return value === 'approve' || value === 'reject';
}

export function isTeamLifecycleAction(value: string): value is TeamLifecycleOption {
  return value === 'activate' || value === 'dissolve';
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

function requiredText(
  input: Record<string, unknown>,
  key: string,
  what: string,
  max: number,
): string {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new InterventionInputError(`${what} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new InterventionInputError(`${what} must not be empty`);
  }
  if (trimmed.length > max) {
    throw new InterventionInputError(`${what} must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalText(
  input: Record<string, unknown>,
  key: string,
  what: string,
  max: number,
): string | null {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new InterventionInputError(`${what} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    throw new InterventionInputError(`${what} must be at most ${max} characters`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// The proposal decision form (approve / reject the human gate)
// ---------------------------------------------------------------------------

export interface ValidatedProposalDecisionInput {
  decision: ProposalDecisionOption;
  note: string | null;
}

/** Validate the proposal approval form's payload. */
export function validateProposalDecisionInput(input: {
  decision?: unknown;
  note?: unknown;
}): ValidatedProposalDecisionInput {
  const record = input as Record<string, unknown>;
  const decision = record.decision === undefined ? '' : record.decision;
  if (typeof decision !== 'string' || !isProposalDecision(decision)) {
    throw new InterventionInputError(
      `the decision must be one of ${PROPOSAL_DECISIONS.join(', ')}`,
    );
  }
  const note = optionalText(record, 'note', 'the decision note', MAX_NOTE_CHARS);
  return { decision, note };
}

// ---------------------------------------------------------------------------
// The agent activation form (proposal → approval → activation)
// ---------------------------------------------------------------------------

export interface ValidatedActivationInput {
  slug: string;
  displayName: string | null;
  role: string;
  description: string | null;
  provider: AgentProviderOption;
  instructions: string;
  permissions: AgentPermissionOption[];
}

const AGENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Validate the agent activation form's payload. */
export function validateActivationInput(input: {
  slug?: unknown;
  displayName?: unknown;
  role?: unknown;
  description?: unknown;
  provider?: unknown;
  instructions?: unknown;
  permissions?: unknown;
}): ValidatedActivationInput {
  const record = input as Record<string, unknown>;
  const slug = requiredText(record, 'slug', 'the agent slug', MAX_AGENT_SLUG_LENGTH);
  if (!AGENT_SLUG_PATTERN.test(slug)) {
    throw new InterventionInputError(
      'the agent slug must be lowercase letters, digits and hyphens (it starts with a letter or digit)',
    );
  }
  const role = requiredText(record, 'role', 'the agent role', MAX_AGENT_ROLE_CHARS);
  const instructions = requiredText(
    record,
    'instructions',
    'the agent instructions',
    MAX_AGENT_INSTRUCTIONS_CHARS,
  );
  const provider = record.provider === undefined ? '' : record.provider;
  if (typeof provider !== 'string' || !isAgentProvider(provider)) {
    throw new InterventionInputError(
      `the agent provider must be one of ${AGENT_PROVIDERS.join(', ')}`,
    );
  }
  const permissionsRaw = record.permissions === undefined ? [] : record.permissions;
  if (!Array.isArray(permissionsRaw)) {
    throw new InterventionInputError('the agent permissions must be a list');
  }
  const permissions: AgentPermissionOption[] = [];
  for (const entry of permissionsRaw) {
    if (typeof entry !== 'string' || !isAgentPermission(entry)) {
      throw new InterventionInputError(
        `every permission must be one of ${AGENT_PERMISSIONS.join(', ')}`,
      );
    }
    if (!permissions.includes(entry)) permissions.push(entry);
  }
  if (permissions.length === 0) {
    throw new InterventionInputError('the agent needs at least one permission scope');
  }
  return {
    slug,
    displayName: optionalText(record, 'displayName', 'the display name', MAX_AGENT_DISPLAY_NAME_CHARS),
    role,
    description: optionalText(record, 'description', 'the description', MAX_TEAM_DESCRIPTION_CHARS),
    provider,
    instructions,
    permissions,
  };
}

// ---------------------------------------------------------------------------
// The team compose form (team topology/budget authoring)
// ---------------------------------------------------------------------------

export interface ValidatedTeamMemberChoice {
  agentId: string;
  role: string;
}

export interface ValidatedTeamComposeInput {
  displayName: string;
  description: string | null;
  topology: TeamTopologyOption;
  members: ValidatedTeamMemberChoice[];
  objective: string;
  successCriteria: string | null;
  budgetAmountMinor: number;
  budgetCurrency: string;
  ownerPrincipal: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Validate the team compose form's payload. */
export function validateTeamComposeInput(input: {
  displayName?: unknown;
  description?: unknown;
  topology?: unknown;
  members?: unknown;
  objective?: unknown;
  successCriteria?: unknown;
  budgetAmount?: unknown;
  budgetCurrency?: unknown;
  ownerPrincipal?: unknown;
}): ValidatedTeamComposeInput {
  const record = input as Record<string, unknown>;
  const displayName = requiredText(
    record,
    'displayName',
    'the team display name',
    MAX_TEAM_DISPLAY_NAME_CHARS,
  );
  const topology = record.topology === undefined ? '' : record.topology;
  if (typeof topology !== 'string' || !isTeamTopology(topology)) {
    throw new InterventionInputError('the team topology must be flat or hierarchical');
  }
  const membersRaw = record.members === undefined ? [] : record.members;
  if (!Array.isArray(membersRaw)) {
    throw new InterventionInputError('the team members must be a list');
  }
  if (membersRaw.length === 0) {
    throw new InterventionInputError('a team needs at least one member');
  }
  if (membersRaw.length > MAX_TEAM_MEMBERS) {
    throw new InterventionInputError(`a team carries at most ${MAX_TEAM_MEMBERS} members`);
  }
  const members: ValidatedTeamMemberChoice[] = [];
  const seen = new Set<string>();
  for (const entry of membersRaw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InterventionInputError('every team member must be an object');
    }
    const memberRecord = entry as Record<string, unknown>;
    const agentId = memberRecord.agentId;
    if (typeof agentId !== 'string' || !UUID_PATTERN.test(agentId)) {
      throw new InterventionInputError('every team member needs a valid agent id');
    }
    if (seen.has(agentId)) {
      throw new InterventionInputError('an agent may fill one roster slot at most');
    }
    seen.add(agentId);
    const role = requiredText(memberRecord, 'role', "the member's team role", MAX_TEAM_ROLE_CHARS);
    members.push({ agentId, role });
  }
  const objective = requiredText(
    record,
    'objective',
    'the shared objective',
    MAX_TEAM_OBJECTIVE_CHARS,
  );
  const budgetCurrencyRaw =
    record.budgetCurrency === undefined || record.budgetCurrency === null
      ? 'USD'
      : record.budgetCurrency;
  if (typeof budgetCurrencyRaw !== 'string' || !CURRENCY_PATTERN.test(budgetCurrencyRaw)) {
    throw new InterventionInputError('the budget currency must be a 3-letter ISO code');
  }
  const budgetAmountRaw = record.budgetAmount;
  if (typeof budgetAmountRaw !== 'string' || budgetAmountRaw.trim() === '') {
    throw new InterventionInputError('the budget amount must be entered');
  }
  const parsed = Number.parseFloat(budgetAmountRaw.replace(/,/g, '.'));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InterventionInputError('the budget amount must be a non-negative number');
  }
  const budgetAmountMinor = Math.round(parsed * 100);
  if (budgetAmountMinor > MAX_TEAM_BUDGET_MINOR) {
    throw new InterventionInputError('the budget amount is too large');
  }
  return {
    displayName,
    description: optionalText(record, 'description', 'the description', MAX_TEAM_DESCRIPTION_CHARS),
    topology,
    members,
    objective,
    successCriteria: optionalText(
      record,
      'successCriteria',
      'the success criteria',
      MAX_TEAM_SUCCESS_CRITERIA_CHARS,
    ),
    budgetAmountMinor,
    budgetCurrency: budgetCurrencyRaw,
    ownerPrincipal: optionalText(
      record,
      'ownerPrincipal',
      'the owner principal',
      MAX_TEAM_OWNER_PRINCIPAL_CHARS,
    ),
  };
}

// ---------------------------------------------------------------------------
// The team lifecycle form (request activation / dissolve)
// ---------------------------------------------------------------------------

export interface ValidatedTeamLifecycleInput {
  action: TeamLifecycleOption;
  reason: string | null;
}

/** Validate the team lifecycle form's payload. */
export function validateTeamLifecycleInput(input: {
  action?: unknown;
  reason?: unknown;
}): ValidatedTeamLifecycleInput {
  const record = input as Record<string, unknown>;
  const action = record.action === undefined ? '' : record.action;
  if (typeof action !== 'string' || !isTeamLifecycleAction(action)) {
    throw new InterventionInputError(`the team action must be one of ${TEAM_LIFECYCLE_ACTIONS.join(', ')}`);
  }
  const reason = optionalText(record, 'reason', 'the reason', MAX_NOTE_CHARS);
  if (action === 'dissolve' && reason === null) {
    throw new InterventionInputError('dissolving a team requires a reason');
  }
  return { action, reason };
}

// ---------------------------------------------------------------------------
// The agent lifecycle decision form (retain / modify / terminate)
// ---------------------------------------------------------------------------

export interface ValidatedAgentDecisionInput {
  change: AgentLifecycleOption;
  rationale: string;
  note: string | null;
  modificationSummary: string | null;
  replacementOptionId: string | null;
}

/** Validate the agent lifecycle decision form's payload. */
export function validateAgentDecisionInput(input: {
  change?: unknown;
  rationale?: unknown;
  note?: unknown;
  modificationSummary?: unknown;
  replacementOptionId?: unknown;
}): ValidatedAgentDecisionInput {
  const record = input as Record<string, unknown>;
  const change = record.change === undefined ? '' : record.change;
  if (typeof change !== 'string' || !isAgentLifecycleChange(change)) {
    throw new InterventionInputError(
      `the lifecycle change must be one of ${AGENT_LIFECYCLE_CHANGES.join(', ')}`,
    );
  }
  const rationale = requiredText(
    record,
    'rationale',
    'the rationale',
    MAX_DECISION_RATIONALE_CHARS,
  );
  const modificationSummary = optionalText(
    record,
    'modificationSummary',
    'the modification summary',
    MAX_MODIFICATION_SUMMARY_CHARS,
  );
  if (change === 'modify' && modificationSummary === null) {
    throw new InterventionInputError('a modify decision requires a summary of what will change');
  }
  const replacementRaw = record.replacementOptionId;
  let replacementOptionId: string | null = null;
  if (replacementRaw !== undefined && replacementRaw !== null && replacementRaw !== '') {
    if (typeof replacementRaw !== 'string' || !UUID_PATTERN.test(replacementRaw)) {
      throw new InterventionInputError('the chosen replacement option must be a valid id');
    }
    replacementOptionId = replacementRaw;
  }
  return {
    change,
    rationale,
    note: optionalText(record, 'note', 'the note', MAX_DECISION_NOTE_CHARS),
    modificationSummary,
    replacementOptionId,
  };
}
