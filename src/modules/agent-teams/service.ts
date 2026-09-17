// Implementation of the agent-teams module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and
// are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`team_not_found`).
//
// W023 acceptance — "Create agent-team topology, roles, shared
// objectives, budgets, escalation and team outcomes" — is carried by
// these deliberate properties, all tested:
//   1. TOPOLOGY + ROLES: the roster (agents with per-member roles and
//      reporting lines) is validated by the pure policy functions and
//      enforced again by storage triggers — flat teams have no
//      reporting lines; hierarchical teams have exactly one coordinator
//      (root) and an acyclic reporting tree;
//   2. SHARED OBJECTIVES: at least one keyed objective per version;
//      outcomes reference those keys (validated against the CURRENT
//      version at record time);
//   3. BUDGETS: integer minor units + ISO currency (the house money
//      convention), versioned with the contract;
//   4. ESCALATION: thresholded triggers (member failures, budget
//      fraction) and the authority gap, routed to the coordinator, the
//      owner or management — structurally validated (routes need
//      somewhere to land) and storage-enforced;
//   5. TEAM OUTCOMES: append-only, provenance-bearing records with
//      opaque evidence references;
//   6. LIFECYCLE: activation routes through the W009 authority matrix
//      (kind 'agent-recruitment', level EXECUTE — lock 23: "Agent
//      recruitment and termination obey policy/approval"; a team is
//      recruited as a unit), dissolution through kind
//      'agent-termination'. The built-in default gates EXECUTE behind
//      human approval, so a transition typically returns applied:false
//      with a pending gate request; re-invoking with the SAME
//      idempotency key after `decideApproval` replays the gate (now
//      approved) and applies. Policy rejections are loud
//      (`forbidden_by_policy`); policy auto-allowances apply
//      immediately. Every applied transition appends a surgical
//      version carrying the gate's action request id (§24
//      reconstructability);
//   7. AUDIT: versions are append-only full snapshots (UPDATE/DELETE/
//      TRUNCATE rejected by storage triggers); team identity is never
//      erased (dissolution is the retirement path); the version
//      pointer advance is guarded (concurrent writers conflict loudly).
//
// Claim-gated writes: creating/revising/activating/dissolving teams
// requires the workforce's 'agents:administer' claim (the agents
// module's discipline — minting or re-shaping organizational actors is
// a management action; the claim is imported from the agents contract,
// never duplicated as a magic string). Any tenant member may record
// team outcomes — evidence recording is not administration (the
// learning module's outcome discipline).
//
// Cross-module posture: member agent ids are validated readable
// through the agents contract at write time (the missions module's
// sanctioned-unknown precedent) and checked ACTIVE at activation (a
// live team is composed of live agents); the authority gate goes
// through the actions contract. No other module is imported, and no
// cross-module foreign keys exist.

import { now } from '@/infra/clock';
import { getDb, type DbResult, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getAgent } from '@/modules/agents/contract';
import { AgentsError } from '@/modules/agents/contract';
import type { AgentDefinition } from '@/modules/agents/contract';
import { authorizeAction } from '@/modules/actions/contract';
import { ActionsError } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { AgentTeamsError } from './errors';
import { canAdministerAgentTeams, coordinatorOf } from './policy';
import {
  assertAgentTeamsTenantContext,
  validateActivateTeamInput,
  validateCreateTeamInput,
  validateDissolveTeamInput,
  validateGetTeamQuery,
  validateListTeamOutcomesQuery,
  validateListTeamVersionsQuery,
  validateListTeamsQuery,
  validateRecordTeamOutcomeInput,
  validateReviseTeamInput,
  validateTeamContent,
} from './validation';
import type {
  ValidatedBudget,
  ValidatedCreateTeamInput,
  ValidatedDissolveInput,
  ValidatedListOutcomesQuery,
  ValidatedListTeamsQuery,
  ValidatedListVersionsQuery,
  ValidatedOutcomeInput,
  ValidatedParty,
  ValidatedReviseTeamInput,
  ValidatedTeamContent,
} from './validation';
import type {
  ActivateTeamInput,
  CreateTeamInput,
  CreateTeamResult,
  DissolveTeamInput,
  GetTeamQuery,
  ListTeamOutcomesQuery,
  ListTeamsQuery,
  ListTeamVersionsQuery,
  RecordTeamOutcomeInput,
  ReviseTeamInput,
  Team,
  TeamChangeKind,
  TeamContent,
  TeamEscalationRule,
  TeamEvidenceRef,
  TeamMember,
  TeamOutcome,
  TeamParty,
  TeamTransitionResult,
  TeamVersion,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants (re-exported through the contract)
// ---------------------------------------------------------------------------

/** The W009 action kind that gates team ACTIVATION (lock 23). */
export const AGENT_TEAM_ACTIVATION_ACTION_KIND = 'agent-recruitment';

/** The W009 action kind that gates team DISSOLUTION (lock 23). */
export const AGENT_TEAM_DISSOLUTION_ACTION_KIND = 'agent-termination';

/** Lifecycle transitions are consequential execution decisions. */
export const AGENT_TEAM_AUTHORITY_LEVEL = 'EXECUTE' as const;

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface TeamRow extends DbRow {
  id: string;
  tenant_id: string;
  slug: string;
  current_version: number | string;
  created_at: Date | string;
}

interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  team_id: string;
  version: number | string;
  change_kind: TeamChangeKind;
  display_name: string | null;
  description: string | null;
  topology: 'flat' | 'hierarchical';
  members: unknown;
  objectives: unknown;
  budget_amount_minor: string | number;
  budget_currency: string;
  escalation_rules: unknown;
  owner_principal: string | null;
  status: 'draft' | 'active' | 'dissolved';
  actor_kind: TeamParty['kind'];
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  action_request_id: string | null;
  recorded_at: Date | string;
}

interface OutcomeRow extends DbRow {
  id: string;
  tenant_id: string;
  team_id: string;
  objective_key: string | null;
  headline: string;
  detail: string | null;
  assessment: TeamOutcome['assessment'];
  evidence: unknown;
  actor_kind: TeamParty['kind'];
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toMinor(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

interface StoredMember {
  agentId: string;
  role: string;
  reportsTo: string | null;
}

interface StoredObjective {
  key: string;
  objective: string;
  successCriteria: string | null;
}

interface StoredRule {
  trigger: TeamEscalationRule['trigger'];
  threshold: number | null;
  route: TeamEscalationRule['route'];
}

interface StoredEvidence {
  kind: string;
  id: string | null;
  label: string | null;
}

function mapParty(row: { actor_kind: TeamParty['kind']; actor_id: string | null; actor_label: string | null }): TeamParty {
  return { kind: row.actor_kind, id: row.actor_id, label: row.actor_label };
}

function mapEvidence(refs: unknown): TeamEvidenceRef[] {
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => {
    const stored = ref as Partial<StoredEvidence>;
    return {
      kind: String(stored.kind ?? ''),
      id: stored.id ?? null,
      label: stored.label ?? null,
    };
  });
}

function mapContent(row: VersionRow): TeamContent {
  return {
    displayName: row.display_name,
    description: row.description,
    topology: row.topology,
    members: [...(row.members as StoredMember[])].map((member) => ({
      agentId: member.agentId,
      role: member.role,
      reportsTo: member.reportsTo ?? null,
    })),
    objectives: [...(row.objectives as StoredObjective[])].map((objective) => ({
      key: objective.key,
      objective: objective.objective,
      successCriteria: objective.successCriteria ?? null,
    })),
    budget: {
      amountMinor: toMinor(row.budget_amount_minor),
      currency: row.budget_currency,
    },
    escalationRules: [...(row.escalation_rules as StoredRule[])].map((rule) => ({
      trigger: rule.trigger,
      threshold: rule.threshold ?? null,
      route: rule.route,
    })),
    ownerPrincipal: row.owner_principal,
  };
}

function mapVersion(row: VersionRow): TeamVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    version: toInt(row.version),
    changeKind: row.change_kind,
    content: mapContent(row),
    status: row.status,
    actor: mapParty(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    actionRequestId: row.action_request_id,
    recordedAt: toIso(row.recorded_at),
  };
}

/** The current-view Team object assembled from identity + version rows. */
function teamOf(identity: TeamRow, row: VersionRow): Team {
  const version = mapVersion(row);
  return {
    id: identity.id,
    tenantId: identity.tenant_id,
    slug: identity.slug,
    version: version.version,
    content: version.content,
    status: version.status,
    createdAt: toIso(identity.created_at),
    updatedAt: version.recordedAt,
    lastChange: {
      kind: version.changeKind,
      actor: version.actor,
      changedByPrincipal: version.changedByPrincipal,
      rationale: version.rationale,
      actionRequestId: version.actionRequestId,
      recordedAt: version.recordedAt,
    },
  };
}

function mapOutcome(row: OutcomeRow): TeamOutcome {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    objectiveKey: row.objective_key,
    headline: row.headline,
    detail: row.detail,
    assessment: row.assessment,
    evidence: mapEvidence(row.evidence),
    actor: mapParty(row),
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

/** True when `error` is a PostgreSQL unique violation naming `table`. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

/** Storage → loose content view used as the merge base of a revision. */
function contentRecordOf(content: TeamContent): Record<string, unknown> {
  return {
    displayName: content.displayName,
    description: content.description,
    topology: content.topology,
    members: content.members,
    objectives: content.objectives,
    budget: content.budget,
    escalationRules: content.escalationRules,
    ownerPrincipal: content.ownerPrincipal,
  };
}

// ---------------------------------------------------------------------------
// Tenant-scoped lookups
// ---------------------------------------------------------------------------

function teamNotFound(identifier: string): AgentTeamsError {
  return new AgentTeamsError(
    'team_not_found',
    `no agent team '${identifier}' exists in this tenant`,
  );
}

async function findTeamRow(
  db: Queryable,
  ctx: TenantContext,
  query: { teamId: string | null; slug: string | null },
): Promise<TeamRow | null> {
  const rows =
    query.teamId !== null
      ? await db.query<TeamRow>(`SELECT * FROM agent_teams WHERE tenant_id = $1 AND id = $2`, [
          ctx.tenantId,
          query.teamId,
        ])
      : await db.query<TeamRow>(`SELECT * FROM agent_teams WHERE tenant_id = $1 AND slug = $2`, [
          ctx.tenantId,
          query.slug,
        ]);
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

/** Loads the current version row of one team (tenant-scoped). */
async function loadCurrentVersionRow(
  db: Queryable,
  ctx: TenantContext,
  teamId: string,
): Promise<VersionRow | null> {
  const rows = await db.query<VersionRow>(
    `SELECT v.* FROM agent_team_versions v
       INNER JOIN agent_teams t ON t.id = v.team_id AND t.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.team_id = $2 AND v.version = t.current_version`,
    [ctx.tenantId, teamId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

/**
 * Locks the team identity (FOR UPDATE — concurrent writers serialize
 * here, which is what keeps the version chain gapless) and returns the
 * identity row, or `team_not_found` (uniform for missing, malformed
 * and foreign-tenant ids).
 */
async function lockTeam(tx: Queryable, ctx: TenantContext, teamId: string): Promise<TeamRow> {
  const locked = await tx.query<TeamRow>(
    `SELECT * FROM agent_teams WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.tenantId, teamId],
  );
  const identity = locked.rows[0];
  if (identity === undefined) throw teamNotFound(teamId);
  return identity;
}

/**
 * Advances the current-version pointer exactly one step from the
 * version this mutation was based on. 0 rows → a concurrent writer won
 * (defense in depth on top of the row lock) → `team_conflict`.
 */
async function advancePointer(
  tx: Queryable,
  ctx: TenantContext,
  teamId: string,
  fromVersion: number,
  toVersion: number,
): Promise<void> {
  const moved = await tx.query(
    `UPDATE agent_teams SET current_version = $3
      WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
    [ctx.tenantId, teamId, toVersion, fromVersion],
  );
  if (moved.rowCount === 0) {
    throw new AgentTeamsError(
      'team_conflict',
      'a concurrent change moved this team forward; re-read the team and retry',
    );
  }
}

/** The version a given authority-gate request applied, if any (the replay probe). */
async function findVersionByRequestId(
  db: Queryable,
  ctx: TenantContext,
  actionRequestId: string,
): Promise<VersionRow | null> {
  const rows = await db.query<VersionRow>(
    `SELECT * FROM agent_team_versions WHERE tenant_id = $1 AND action_request_id = $2`,
    [ctx.tenantId, actionRequestId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

// ---------------------------------------------------------------------------
// The version insert (the shared append path)
// ---------------------------------------------------------------------------

/**
 * The SQL value tuple of one version row (content + audit + gate
 * linkage), shared by every append path: create, revise, activate,
 * dissolve.
 */
function versionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    teamId: string;
    version: number;
    changeKind: TeamChangeKind;
    content: ValidatedTeamContent;
    status: Team['status'];
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    actionRequestId: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<VersionRow>> {
  return tx.query<VersionRow>(
    `INSERT INTO agent_team_versions (
       tenant_id, team_id, version, change_kind,
       display_name, description, topology, members, objectives,
       budget_amount_minor, budget_currency, escalation_rules, owner_principal,
       status, actor_kind, actor_id, actor_label, changed_by_principal,
       rationale, action_request_id, recorded_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8::jsonb, $9::jsonb,
       $10, $11, $12::jsonb, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.teamId,
      params.version,
      params.changeKind,
      params.content.displayName,
      params.content.description,
      params.content.topology,
      JSON.stringify(params.content.members),
      JSON.stringify(params.content.objectives),
      params.content.budget.amountMinor,
      params.content.budget.currency,
      JSON.stringify(params.content.escalationRules),
      params.content.ownerPrincipal,
      params.status,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.actionRequestId,
      params.recordedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// Claim gate + cross-module member validation
// ---------------------------------------------------------------------------

function requireAdministerClaim(ctx: TenantContext): void {
  if (!canAdministerAgentTeams(ctx.authority)) {
    throw new AgentTeamsError(
      'forbidden',
      "this operation requires the 'agents:administer' authority claim — administering the agent workforce's teams is a management action",
    );
  }
}

/** The calling principal as the default acting party. */
function principalParty(principalId: string): ValidatedParty {
  return { kind: 'person', id: principalId, label: null };
}

/**
 * Reads one member's agent definition through the agents contract (the
 * sanctioned W021 dependency — never its tables). Missing, malformed
 * and foreign-tenant agent ids are uniformly `invalid_agent_ref` (no
 * existence leak).
 */
async function readMemberAgent(ctx: TenantContext, agentId: string): Promise<AgentDefinition> {
  try {
    return await getAgent(ctx, { agentId });
  } catch (error) {
    if (error instanceof AgentsError) {
      if (error.code === 'agent_not_found') {
        throw new AgentTeamsError(
          'invalid_agent_ref',
          `agent '${agentId}' is not available in this tenant to this principal — roster members must be readable agent definitions`,
        );
      }
      throw new Error(
        `the agents contract rejected a pre-validated member lookup (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Cross-module member validation at write time (the missions
 * unknown-refs precedent): every roster member must be a readable
 * agent definition in this tenant.
 */
async function validateMemberRefs(ctx: TenantContext, members: TeamMember[]): Promise<void> {
  for (const member of members) {
    await readMemberAgent(ctx, member.agentId);
  }
}

/**
 * The activation-time liveness invariant: an ACTIVE team is composed of
 * ACTIVE agents — every member definition must currently be enabled.
 * (Drift AFTER activation — an agent disabled while its team runs — is
 * W024's evaluation concern; this is the compose-time gate.)
 */
async function assertMembersActive(ctx: TenantContext, members: TeamMember[]): Promise<void> {
  for (const member of members) {
    const agent = await readMemberAgent(ctx, member.agentId);
    if (agent.status !== 'active') {
      throw new AgentTeamsError(
        'member_agent_inactive',
        `member agent '${agent.slug}' (${agent.id}) is ${agent.status} — an active team is composed of active agents (replace or enable the member first)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The W009 authority gate (lifecycle transitions)
// ---------------------------------------------------------------------------

/**
 * Brings one lifecycle transition to the actions authority gate:
 * activation is kind 'agent-recruitment' (a team is recruited as a
 * unit — the canonical §20 kind), dissolution is kind
 * 'agent-termination'; both at level EXECUTE (the extensions module's
 * lifecycle precedent). The gate inputs are pre-validated here, so an
 * ActionsError contradicts the actions contract — stay loud rather
 * than silently unmoved. A caller-supplied idempotency key replays the
 * original request (first write wins).
 */
async function authorizeTransition(
  ctx: TenantContext,
  identity: TeamRow,
  current: VersionRow,
  transition: 'activate' | 'dissolve',
  idempotencyKey: string | null,
): Promise<ActionRequest> {
  const actionKind =
    transition === 'activate'
      ? AGENT_TEAM_ACTIVATION_ACTION_KIND
      : AGENT_TEAM_DISSOLUTION_ACTION_KIND;
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind,
      authorityLevel: AGENT_TEAM_AUTHORITY_LEVEL,
      payload: {
        teamId: identity.id,
        teamSlug: identity.slug,
        transition,
        fromStatus: current.status,
        toStatus: transition === 'activate' ? 'active' : 'dissolved',
        memberCount: (current.members as StoredMember[]).length,
        budgetAmountMinor: toMinor(current.budget_amount_minor),
        budgetCurrency: current.budget_currency,
      },
      justification: `${transition} agent team '${identity.slug}' (${current.status} → ${transition === 'activate' ? 'active' : 'dissolved'})`,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      if (error.code === 'invalid_context') {
        throw new AgentTeamsError('invalid_context', error.message);
      }
      if (error.code === 'invalid_action_input') {
        throw new AgentTeamsError('invalid_team_input', error.message);
      }
      throw new Error(
        `the authority gate rejected a pre-validated agent-team transition (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  return request;
}

// ---------------------------------------------------------------------------
// createTeam
// ---------------------------------------------------------------------------

export async function createTeam(
  ctx: TenantContext,
  input: CreateTeamInput,
): Promise<CreateTeamResult> {
  assertAgentTeamsTenantContext(ctx);
  // Minting organizational actors is a management action (authorization
  // before parsing — unauthorized callers learn nothing about shapes).
  requireAdministerClaim(ctx);
  const valid: ValidatedCreateTeamInput = validateCreateTeamInput(input);
  await validateMemberRefs(ctx, valid.content.members);
  const actor = valid.actor ?? principalParty(ctx.principalId);
  const recordedAt = now();

  // Idempotent per slug (the agents/llm discipline): a recorded slug
  // replays the first registration — identity is stable; a new team
  // needs a new slug.
  const existing = await findTeamRow(getDb(), ctx, { teamId: null, slug: valid.slug });
  if (existing !== null) {
    const currentRow = await loadCurrentVersionRow(getDb(), ctx, existing.id);
    if (currentRow !== null) {
      return { team: teamOf(existing, currentRow), created: false };
    }
  }

  try {
    return await getDb().transaction(async (tx) => {
      // Identity row first (id minted by PostgreSQL); version 1 follows
      // in the same transaction — a team never exists without its
      // initial contract. created_at comes from the injectable clock
      // (IMPLEMENTATION-STACK §8), never from the database clock.
      const created = await tx.query<TeamRow>(
        `INSERT INTO agent_teams (tenant_id, slug, created_at) VALUES ($1, $2, $3) RETURNING *`,
        [ctx.tenantId, valid.slug, recordedAt],
      );
      const identity = created.rows[0]!;

      const inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        teamId: identity.id,
        version: 1,
        changeKind: 'created',
        content: valid.content,
        status: 'draft',
        actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        actionRequestId: null,
        recordedAt,
      });

      return { team: teamOf(identity, inserted.rows[0]!), created: true };
    });
  } catch (error) {
    // A concurrent creation of the same slug won the race (the whole
    // transaction rolled back atomically): replay the winner.
    if (isDuplicateKeyOn(error, 'agent_teams')) {
      const winner = await findTeamRow(getDb(), ctx, { teamId: null, slug: valid.slug });
      if (winner !== null) {
        const currentRow = await loadCurrentVersionRow(getDb(), ctx, winner.id);
        if (currentRow !== null) {
          return { team: teamOf(winner, currentRow), created: false };
        }
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// reviseTeam
// ---------------------------------------------------------------------------

export async function reviseTeam(ctx: TenantContext, input: ReviseTeamInput): Promise<Team> {
  assertAgentTeamsTenantContext(ctx);
  requireAdministerClaim(ctx);
  const valid: ValidatedReviseTeamInput = validateReviseTeamInput(input);

  // A member-changing revision carries the FINAL roster (arrays replace
  // wholesale), so the cross-module validation runs on the patch before
  // the transaction — contract calls never happen inside ours (the
  // embedded database's single connection would starve).
  if (valid.patch.members !== undefined) {
    await validateMemberRefs(ctx, valid.patch.members);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const identity = await lockTeam(tx, ctx, valid.teamId);
    const fromVersion = toInt(identity.current_version);

    const currentRow = await loadCurrentVersionRow(tx, ctx, valid.teamId);
    if (currentRow === null) throw teamNotFound(valid.teamId);
    const current = mapVersion(currentRow);

    // --- lifecycle gate: only draft and active teams accept revisions ---
    if (current.status === 'dissolved') {
      throw new AgentTeamsError(
        'invalid_transition',
        `team '${identity.slug}' is dissolved — a dissolved team is terminal; define a new team instead`,
      );
    }

    // --- merge patch into the current content ---
    const patch = valid.patch;
    const merged = {
      displayName: patch.displayName !== undefined ? patch.displayName : current.content.displayName,
      description:
        patch.description !== undefined ? patch.description : current.content.description,
      topology: patch.topology ?? current.content.topology,
      members: patch.members ?? current.content.members,
      objectives: patch.objectives ?? current.content.objectives,
      budget: (patch.budget as ValidatedBudget | undefined) ?? current.content.budget,
      escalationRules: patch.escalationRules ?? current.content.escalationRules,
      ownerPrincipal:
        patch.ownerPrincipal !== undefined ? patch.ownerPrincipal : current.content.ownerPrincipal,
    };
    // The merged snapshot passes the SAME validator as a fresh create
    // (the missions discipline). A merged-content violation is reported
    // as a revision problem.
    let content: ValidatedTeamContent;
    try {
      content = validateTeamContent(contentRecordOf(merged as TeamContent));
    } catch (error) {
      if (error instanceof AgentTeamsError && error.code === 'invalid_team_input') {
        throw new AgentTeamsError('invalid_team_input', `the revised team content is invalid: ${error.message}`);
      }
      throw error;
    }

    const nextVersion = fromVersion + 1;
    await advancePointer(tx, ctx, valid.teamId, fromVersion, nextVersion);

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        teamId: valid.teamId,
        version: nextVersion,
        changeKind: 'revised',
        content,
        status: current.status, // revisions carry the status forward
        actor: valid.actor ?? principalParty(ctx.principalId),
        principalId: ctx.principalId,
        rationale: valid.rationale,
        actionRequestId: null,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'agent_team_versions')) {
        throw new AgentTeamsError(
          'team_conflict',
          'a concurrent change appended this version number first; re-read the team and retry',
        );
      }
      throw error;
    }

    return teamOf(identity, inserted.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// The gated lifecycle transitions (activate / dissolve)
// ---------------------------------------------------------------------------

/**
 * The shared gated-transition core (the extensions module's
 * transitionExtension shape): fail fast on nonsense, authorize through
 * the matrix, then apply under the identity lock with a guarded
 * pointer advance and the replay probes.
 */
async function gatedTransition(
  ctx: TenantContext,
  valid: { teamId: string; idempotencyKey: string | null },
  transition: 'activate' | 'dissolve',
  reason: string | null,
): Promise<TeamTransitionResult> {
  const db = getDb();
  const identity = await findTeamRow(db, ctx, { teamId: valid.teamId, slug: null });
  if (identity === null) throw teamNotFound(valid.teamId);
  const currentRow = await loadCurrentVersionRow(db, ctx, valid.teamId);
  if (currentRow === null) throw teamNotFound(valid.teamId);

  const targetStatus = transition === 'activate' ? 'active' : 'dissolved';

  // Fail fast on nonsense (the pure state machine), re-checked at apply
  // time inside the transaction. One caller error is NOT nonsense: an
  // idempotent RETRY of a transition that already applied (a crash
  // between commit and response must replay the recorded outcome, not
  // fail). Such a retry finds the team already at the target and a
  // version linked to the replayed gate request.
  if (currentRow.status === targetStatus) {
    if (valid.idempotencyKey !== null) {
      const replayRequest = await authorizeTransition(
        ctx,
        identity,
        currentRow,
        transition,
        valid.idempotencyKey,
      );
      const appliedRow = await findVersionByRequestId(db, ctx, replayRequest.id);
      if (appliedRow !== null) {
        const refreshedIdentity = (await findTeamRow(db, ctx, {
          teamId: valid.teamId,
          slug: null,
        }))!;
        return {
          team: teamOf(refreshedIdentity, appliedRow),
          applied: true,
          gate: { actionRequestId: replayRequest.id, status: 'approved' },
        };
      }
    }
    throw new AgentTeamsError(
      'invalid_transition',
      `cannot ${transition} team '${identity.slug}' — it is already ${targetStatus}`,
    );
  }

  // Terminal teams never move again (a returning need is a NEW team).
  if (currentRow.status === 'dissolved') {
    throw new AgentTeamsError(
      'invalid_transition',
      `team '${identity.slug}' is dissolved — a dissolved team is terminal; define a new team instead`,
    );
  }

  // The activation-time liveness invariant: an active team is composed
  // of active agents (checked BEFORE anything is gated or recorded).
  if (transition === 'activate') {
    await assertMembersActive(ctx, mapVersion(currentRow).content.members);
  }

  // The authority gate (§20, uniform): activation is an
  // 'agent-recruitment' EXECUTE, dissolution an 'agent-termination'
  // EXECUTE. allowed → policy auto-approval, approval_required → the
  // transition waits for a human decision, forbidden → policy
  // rejection (recorded by the actions module as evidence).
  const fromStatus = currentRow.status;
  const request = await authorizeTransition(ctx, identity, currentRow, transition, valid.idempotencyKey);

  if (request.status === 'rejected') {
    throw new AgentTeamsError(
      'forbidden_by_policy',
      `the tenant's authority policy forbids ${transition} of agent team '${identity.slug}' (action request ${request.id})`,
    );
  }

  if (request.status === 'pending') {
    // The gate holds the transition. The team is unchanged; the gate
    // request id is returned so the caller re-invokes with the same
    // idempotency key once a human decides.
    return {
      team: teamOf(identity, currentRow),
      applied: false,
      gate: { actionRequestId: request.id, status: 'pending' },
    };
  }

  const recordedAt = now();
  return db.transaction(async (tx) => {
    const locked = await lockTeam(tx, ctx, valid.teamId);
    const fromVersion = toInt(locked.current_version);

    const row = await loadCurrentVersionRow(tx, ctx, valid.teamId);
    if (row === null) throw teamNotFound(valid.teamId);

    if (row.status !== fromStatus) {
      // The state moved while the transition was at the gate. One
      // explanation is benign: this gate request already applied (an
      // idempotent replay after a crash between commit and response).
      if (row.status === targetStatus) {
        const appliedRow = await findVersionByRequestId(tx, ctx, request.id);
        if (appliedRow !== null) {
          return {
            team: teamOf(locked, appliedRow),
            applied: true,
            gate: { actionRequestId: request.id, status: 'approved' as const },
          };
        }
      }
      throw new AgentTeamsError(
        'invalid_transition',
        `cannot ${transition} team '${locked.slug}' from ${row.status} — the state moved while the transition was at the gate`,
      );
    }

    const nextVersion = fromVersion + 1;
    await advancePointer(tx, ctx, valid.teamId, fromVersion, nextVersion);

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        teamId: valid.teamId,
        version: nextVersion,
        changeKind: transition === 'activate' ? 'activated' : 'dissolved',
        content: validateTeamContent(
          contentRecordOf(mapVersion(row).content),
        ),
        status: targetStatus,
        actor: principalParty(ctx.principalId),
        principalId: ctx.principalId,
        rationale: reason, // dissolution records its why; activation records none
        actionRequestId: request.id,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'agent_team_versions')) {
        throw new AgentTeamsError(
          'team_conflict',
          'a concurrent change appended this version number first; re-read the team and retry',
        );
      }
      throw error;
    }

    return {
      team: teamOf(locked, inserted.rows[0]!),
      applied: true,
      gate: { actionRequestId: request.id, status: 'approved' as const },
    };
  });
}

export async function activateTeam(
  ctx: TenantContext,
  input: ActivateTeamInput,
): Promise<TeamTransitionResult> {
  assertAgentTeamsTenantContext(ctx);
  requireAdministerClaim(ctx);
  const valid = validateActivateTeamInput(input);
  return gatedTransition(ctx, valid, 'activate', null);
}

export async function dissolveTeam(
  ctx: TenantContext,
  input: DissolveTeamInput,
): Promise<TeamTransitionResult> {
  assertAgentTeamsTenantContext(ctx);
  requireAdministerClaim(ctx);
  const valid: ValidatedDissolveInput = validateDissolveTeamInput(input);
  return gatedTransition(ctx, valid, 'dissolve', valid.reason);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTeam(ctx: TenantContext, query: GetTeamQuery): Promise<Team> {
  assertAgentTeamsTenantContext(ctx);
  const valid = validateGetTeamQuery(query);
  const identity = await findTeamRow(getDb(), ctx, valid);
  if (identity === null) {
    throw teamNotFound(valid.teamId ?? valid.slug ?? '');
  }
  const currentRow = await loadCurrentVersionRow(getDb(), ctx, identity.id);
  if (currentRow === null) throw teamNotFound(identity.id);
  return teamOf(identity, currentRow);
}

interface TeamListRow extends DbRow {
  t_id: string;
  t_tenant_id: string;
  t_slug: string;
  t_created_at: Date | string;
}

export async function listTeams(ctx: TenantContext, query: ListTeamsQuery): Promise<Team[]> {
  assertAgentTeamsTenantContext(ctx);
  const valid: ValidatedListTeamsQuery = validateListTeamsQuery(query);

  const conditions: string[] = ['v.tenant_id = $1', 'v.version = t.current_version'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`v.status = $${params.length}`);
  }
  params.push(valid.limit);

  const rows = await getDb().query<TeamListRow & VersionRow>(
    `SELECT t.id AS t_id, t.tenant_id AS t_tenant_id, t.slug AS t_slug, t.created_at AS t_created_at, v.*
       FROM agent_team_versions v
       INNER JOIN agent_teams t ON t.id = v.team_id AND t.tenant_id = v.tenant_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.slug ASC
      LIMIT $${params.length}`,
    params,
  );

  return rows.rows.map((row) =>
    teamOf(
      {
        id: row.t_id,
        tenant_id: row.t_tenant_id,
        slug: row.t_slug,
        current_version: row.version,
        created_at: row.t_created_at,
      },
      row,
    ),
  );
}

export async function listTeamVersions(
  ctx: TenantContext,
  query: ListTeamVersionsQuery,
): Promise<TeamVersion[]> {
  assertAgentTeamsTenantContext(ctx);
  const valid: ValidatedListVersionsQuery = validateListTeamVersionsQuery(query);

  // A team always has at least one version; zero rows means the team is
  // missing, malformed or foreign — uniformly not-found (no leak).
  const identity = await findTeamRow(getDb(), ctx, { teamId: valid.teamId, slug: null });
  if (identity === null) throw teamNotFound(valid.teamId);

  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM agent_team_versions
      WHERE tenant_id = $1 AND team_id = $2
      ORDER BY version ASC`,
    [ctx.tenantId, valid.teamId],
  );
  return rows.rows.map(mapVersion);
}

// ---------------------------------------------------------------------------
// Team outcomes
// ---------------------------------------------------------------------------

export async function recordTeamOutcome(
  ctx: TenantContext,
  input: RecordTeamOutcomeInput,
): Promise<TeamOutcome> {
  assertAgentTeamsTenantContext(ctx);
  const valid: ValidatedOutcomeInput = validateRecordTeamOutcomeInput(input);

  const db = getDb();
  const identity = await findTeamRow(db, ctx, { teamId: valid.teamId, slug: null });
  if (identity === null) throw teamNotFound(valid.teamId);
  const currentRow = await loadCurrentVersionRow(db, ctx, valid.teamId);
  if (currentRow === null) throw teamNotFound(valid.teamId);

  // A draft team has performed no work — outcomes record work performed
  // (active teams and dissolved teams both have history worth recording).
  if (currentRow.status === 'draft') {
    throw new AgentTeamsError(
      'invalid_transition',
      `team '${identity.slug}' is still a draft — a draft team has performed no work; activate it before recording outcomes`,
    );
  }

  // The objective reference resolves against the CURRENT version's
  // shared objectives (an outcome names what it measures).
  if (valid.objectiveKey !== null) {
    const objectives = currentRow.objectives as StoredObjective[];
    if (!objectives.some((objective) => objective.key === valid.objectiveKey)) {
      throw new AgentTeamsError(
        'invalid_objective_ref',
        `objective '${valid.objectiveKey}' is not one of team '${identity.slug}'s current shared objectives`,
      );
    }
  }

  const actor = valid.actor ?? principalParty(ctx.principalId);
  const inserted = await db.query<OutcomeRow>(
    `INSERT INTO agent_team_outcomes (
       tenant_id, team_id, objective_key, headline, detail, assessment, evidence,
       actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::timestamptz)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.teamId,
      valid.objectiveKey,
      valid.headline,
      valid.detail,
      valid.assessment,
      JSON.stringify(valid.evidence),
      actor.kind,
      actor.id,
      actor.label,
      ctx.principalId,
      now(),
    ],
  );
  return mapOutcome(inserted.rows[0]!);
}

export async function listTeamOutcomes(
  ctx: TenantContext,
  query: ListTeamOutcomesQuery,
): Promise<TeamOutcome[]> {
  assertAgentTeamsTenantContext(ctx);
  const valid: ValidatedListOutcomesQuery = validateListTeamOutcomesQuery(query);

  const conditions: string[] = ['tenant_id = $1', 'team_id = $2'];
  const params: unknown[] = [ctx.tenantId, valid.teamId];
  if (valid.objectiveKey !== null) {
    params.push(valid.objectiveKey);
    conditions.push(`objective_key = $${params.length}`);
  }
  params.push(valid.limit);

  const rows = await getDb().query<OutcomeRow>(
    `SELECT * FROM agent_team_outcomes
      WHERE ${conditions.join(' AND ')}
      ORDER BY recorded_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapOutcome);
}

// ---------------------------------------------------------------------------
// Derived views (pure helpers over current content — re-exported for
// the control tower / downstream modules)
// ---------------------------------------------------------------------------

/** The team's coordinator member (hierarchical only) — where coordinator-routed escalations land. */
export function teamCoordinator(team: Team): TeamMember | null {
  return coordinatorOf(team.content.topology, team.content.members);
}
