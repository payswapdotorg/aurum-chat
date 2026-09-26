// The provider-preferences module's service (W091 — User-Friendly Provider
// Choice UX).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record, no existence leak.
//
// THE OUTCOME LAYER, NOT A ROUTER: this service composes the llm and
// provider-billing CONTRACTS only (lock 28 — the llm gateway is the single
// way in; the routing engine stays exactly as-is). It persists the
// tenant's outcome preference, computes the deterministic mapping through
// the pure core (mappings.ts), documents it, and — only for holders of
// the technical authority claim — writes the mapping's priorities through
// the llm contract's EXISTING updateAiProviderAccount input. Nothing else
// in the system is touched, and in-flight executions keep their frozen
// routing snapshots untouched by construction (snapshots are append-only
// evidence owned by the llm module).
//
// Honesty: measured evidence is read through the public contracts and the
// mapping cites it or says it is missing; a degraded read never fakes
// emptiness — the previous mapping stays and a plain note says the option
// list was unavailable.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  LLM_AUTHORITY_ADMINISTER,
  LlmError,
  getLlmExecution,
  getLlmUsageSummary,
  listAiProviderAccounts,
  listLlmExecutions,
  updateAiProviderAccount,
} from '@/modules/llm/contract';
import type {
  AiProviderAccount,
  LlmExecution,
  UpdateAiProviderAccountInput,
} from '@/modules/llm/contract';
import { getUsageSummary } from '@/modules/provider-billing/contract';
import {
  DEFAULT_PREFERENCE,
  computePreferenceOrder,
  explainRoutingSnapshot,
  preferenceLineFor,
  preferenceOption,
} from './mappings';
import { ProviderPreferencesError } from './errors';
import {
  MAX_MAPPED_ACCOUNTS,
  assertProviderPreferencesTenantContext,
  validateExplainQuery,
  validateListChangeEventsQuery,
  validateSavePreferenceInput,
  validateTechnicalOverrideInput,
} from './validation';
import type {
  ValidatedSavePreferenceInput,
  ValidatedTechnicalOverrideInput,
} from './validation';
import type {
  AccountPreferenceFacts,
  ApplyPreferenceProfileResult,
  PreferenceApplication,
  PreferenceAssignment,
  PreferenceChangeEvent,
  PreferenceEvidence,
  PreferenceOrderPlan,
  ProviderPreferenceKind,
  ProviderPreferenceProfile,
  ProviderPreferenceProfileView,
  RoutingDecisionExplanation,
  SavePreferenceProfileResult,
  TechnicalAccountRow,
  TechnicalLayerView,
  TechnicalOverrideResult,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants (re-exported through the contract)
// ---------------------------------------------------------------------------

/**
 * The authority claim that gates the technical layer (advanced settings
 * and the override). Deliberately the SAME claim the llm module enforces
 * on account management — the people who administer AI provider accounts
 * administer the technical provider-choice layer; no new vocabulary.
 */
export const PROVIDER_PREFERENCES_TECHNICAL_CLAIM = LLM_AUTHORITY_ADMINISTER;

function requireTechnicalAuthority(ctx: TenantContext): void {
  if (!ctx.authority.includes(PROVIDER_PREFERENCES_TECHNICAL_CLAIM)) {
    throw new ProviderPreferencesError(
      'unauthorized',
      `advanced provider settings require the '${PROVIDER_PREFERENCES_TECHNICAL_CLAIM}' authority claim`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rows + mappers (DB snake_case → camelCase domain)
// ---------------------------------------------------------------------------

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

interface ProfileRow extends DbRow {
  id: string;
  tenant_id: string;
  preference: string;
  note: string | null;
  updated_by: string;
  applied_preference: string | null;
  applied_at: Date | string | null;
  mapping_notes: string[];
  created_at: Date | string;
  updated_at: Date | string;
}

function mapProfile(row: ProfileRow): ProviderPreferenceProfile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    preference: row.preference as ProviderPreferenceKind, // CHECK-constrained by migration 001
    note: row.note,
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
    createdAt: toIso(row.created_at),
    appliedPreference:
      row.applied_preference === null ? null : (row.applied_preference as ProviderPreferenceKind),
    appliedAt: toIsoOrNull(row.applied_at),
  };
}

interface MappingRow extends DbRow {
  id: string;
  tenant_id: string;
  preference: string;
  account_id: string;
  position: number;
  assigned_priority: number;
  basis: string;
  evidence_available: boolean;
  computed_at: Date | string;
}

function mapMapping(row: MappingRow): PreferenceAssignment {
  return {
    accountId: row.account_id,
    position: Number(row.position),
    assignedPriority: Number(row.assigned_priority),
    basis: row.basis,
    evidenceAvailable: row.evidence_available === true,
  };
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  event: string;
  preference: string | null;
  summary: string;
  actor: string;
  occurred_at: Date | string;
}

function mapEvent(row: EventRow): PreferenceChangeEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    event: row.event as PreferenceChangeEvent['event'], // CHECK-constrained
    preference:
      row.preference === null ? null : (row.preference as ProviderPreferenceKind),
    summary: row.summary,
    actor: row.actor,
    occurredAt: toIso(row.occurred_at),
  };
}

// ---------------------------------------------------------------------------
// Row lookups (tenant-scoped; uniform not-found, no existence leak)
// ---------------------------------------------------------------------------

async function findProfileRow(ctx: TenantContext): Promise<ProfileRow | null> {
  const rows = await getDb().query<ProfileRow>(
    `SELECT * FROM provider_preference_profiles WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  return rows.rows[0] ?? null;
}

async function listMappingRows(ctx: TenantContext): Promise<MappingRow[]> {
  const rows = await getDb().query<MappingRow>(
    `SELECT * FROM provider_preference_mappings WHERE tenant_id = $1 ORDER BY position ASC`,
    [ctx.tenantId],
  );
  return rows.rows;
}

async function countEvents(ctx: TenantContext): Promise<number> {
  const rows = await getDb().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM provider_preference_events WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  return Number(rows.rows[0]?.n ?? '0');
}

async function appendEvent(
  ctx: TenantContext,
  entry: {
    event: PreferenceChangeEvent['event'];
    preference: ProviderPreferenceKind | null;
    summary: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await getDb().query(
    `INSERT INTO provider_preference_events
       (tenant_id, event, preference, summary, detail, actor, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      ctx.tenantId,
      entry.event,
      entry.preference,
      entry.summary,
      JSON.stringify(entry.detail),
      ctx.principalId,
      now(),
    ],
  );
}

/** Replace the tenant's mapping rows with a freshly computed plan. */
async function replaceMappings(
  ctx: TenantContext,
  plan: PreferenceOrderPlan,
  at: Date,
): Promise<void> {
  await getDb().transaction(async (tx: Queryable) => {
    await tx.query(`DELETE FROM provider_preference_mappings WHERE tenant_id = $1`, [
      ctx.tenantId,
    ]);
    for (const assignment of plan.assignments) {
      await tx.query(
        `INSERT INTO provider_preference_mappings
           (tenant_id, preference, account_id, position, assigned_priority,
            basis, evidence_available, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ctx.tenantId,
          plan.preference,
          assignment.accountId,
          assignment.position,
          assignment.assignedPriority,
          assignment.basis,
          assignment.evidenceAvailable,
          at,
        ],
      );
    }
  });
}

async function setAppliedState(
  ctx: TenantContext,
  preference: ProviderPreferenceKind,
  at: Date,
): Promise<void> {
  await getDb().query(
    `UPDATE provider_preference_profiles
       SET applied_preference = $2, applied_at = $3, updated_at = $3
     WHERE tenant_id = $1`,
    [ctx.tenantId, preference, at],
  );
}

// ---------------------------------------------------------------------------
// Contract reads (safe: a failed read degrades, never fakes emptiness)
// ---------------------------------------------------------------------------

async function safe<T>(family: string, degraded: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

interface LoadedFacts {
  accounts: AiProviderAccount[];
  evidence: PreferenceEvidence;
  degraded: string[];
}

/**
 * Load the routing facts (the tenant's active AI options) and the measured
 * evidence (W090 billing attribution first, then the llm gateway's usage
 * aggregates) — each read degraded-safe.
 */
async function loadFacts(ctx: TenantContext): Promise<LoadedFacts> {
  const degraded: string[] = [];
  const accountsRead = await safe('ai-option-list', degraded, () =>
    listAiProviderAccounts(ctx, { limit: MAX_MAPPED_ACCOUNTS }),
  );
  const usage = await safe('recorded-usage', degraded, () => getLlmUsageSummary(ctx, {}));
  const billingRead = await safe('billing-attribution', degraded, () =>
    getUsageSummary(ctx, { gateway: 'llm' }),
  );
  return {
    accounts: accountsRead ?? [],
    evidence: {
      usage: usage ?? [],
      billing: billingRead?.rows ?? [],
    },
    degraded,
  };
}

function toFacts(account: AiProviderAccount): AccountPreferenceFacts {
  return {
    accountId: account.id,
    provider: account.provider,
    priority: account.priority,
    maxDataClassification: account.maxDataClassification,
    status: account.status,
    createdAt: account.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Applying a preference to routing (authorized; the existing llm input)
// ---------------------------------------------------------------------------

/**
 * Write the plan's priorities through the llm contract's EXISTING
 * updateAiProviderAccount input — the only routing fact this module ever
 * touches. Returns how many priorities actually changed.
 */
async function writePlanPriorities(
  ctx: TenantContext,
  plan: PreferenceOrderPlan,
  accounts: readonly AiProviderAccount[],
): Promise<number> {
  if (!plan.changed) return 0;
  let written = 0;
  for (const assignment of plan.assignments) {
    const account = accounts.find((entry) => entry.id === assignment.accountId);
    if (account === undefined) continue;
    if (account.priority === assignment.assignedPriority) continue;
    await updateAiProviderAccount(ctx, {
      accountId: assignment.accountId,
      priority: assignment.assignedPriority,
    });
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// The profile view (the default surface's data — honest defaults)
// ---------------------------------------------------------------------------

const NO_PROFILE_NOTE = 'No choice saved yet — Aurum uses your organization’s configured order.';

async function buildProfileView(
  ctx: TenantContext,
): Promise<{ view: ProviderPreferenceProfileView; row: ProfileRow | null }> {
  const row = await findProfileRow(ctx);
  const mappings = await listMappingRows(ctx).catch(() => [] as MappingRow[]);
  const events = await countEvents(ctx).catch(() => 0);

  if (row === null) {
    return {
      row: null,
      view: {
        preference: DEFAULT_PREFERENCE,
        saved: false,
        note: null,
        updatedBy: '',
        updatedAt: null,
        appliedPreference: null,
        appliedAt: null,
        pendingApplication: false,
        mappings: [],
        mappingNotes: [NO_PROFILE_NOTE],
        changeEventCount: events,
      },
    };
  }

  const preference = row.preference as ProviderPreferenceKind;
  const appliedPreference = row.applied_preference as ProviderPreferenceKind | null;
  return {
    row,
    view: {
      preference,
      saved: true,
      note: row.note,
      updatedBy: row.updated_by,
      updatedAt: toIso(row.updated_at),
      appliedPreference,
      appliedAt: toIsoOrNull(row.applied_at),
      pendingApplication: appliedPreference !== preference,
      mappings: mappings.map(mapMapping),
      mappingNotes: [...row.mapping_notes],
      changeEventCount: events,
    },
  };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * The tenant's preference profile for the DEFAULT surface: the saved
 * choice (or the honest default), its application state, the current
 * mapping guidance in plain language, and the audit size. Never throws
 * for a missing profile — absence is an honest state, not an error.
 */
export async function getProviderPreferenceProfile(
  ctx: TenantContext,
): Promise<ProviderPreferenceProfileView> {
  assertProviderPreferencesTenantContext(ctx);
  const { view } = await buildProfileView(ctx);
  return view;
}

/**
 * Save (or re-save — unlimited, always audited) the tenant's outcome
 * preference. Any member may save; the choice and its deterministic
 * mapping guidance are recorded immediately. When the saver holds the
 * technical authority claim the choice is ALSO applied to routing right
 * away (it takes effect for the NEXT routing decision; in-flight
 * executions keep their frozen snapshots — they are append-only evidence
 * owned by the llm module). Otherwise the honest requiresAdministrator
 * state is returned.
 */
export async function savePreferenceProfile(
  ctx: TenantContext,
  input: unknown,
): Promise<SavePreferenceProfileResult> {
  assertProviderPreferencesTenantContext(ctx);
  const valid: ValidatedSavePreferenceInput = validateSavePreferenceInput(input);
  const at = now();
  const label = preferenceOption(valid.preference).label;

  const rows = await getDb().query<ProfileRow>(
    `INSERT INTO provider_preference_profiles
       (tenant_id, preference, note, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       preference = EXCLUDED.preference,
       note = EXCLUDED.note,
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [ctx.tenantId, valid.preference, valid.note, ctx.principalId, at],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('provider preference profile upsert returned no row (internal invariant violation)');
  }

  // Recompute + store the deterministic mapping guidance.
  const facts = await loadFacts(ctx);
  const plan = computePreferenceOrder(
    valid.preference,
    facts.accounts.filter((account) => account.status === 'active').map(toFacts),
    facts.evidence,
  );
  const notes = [...plan.notes];
  if (facts.degraded.includes('ai-option-list')) {
    notes.push(
      'The option list could not be read just now — the previous mapping stays until the next save.',
    );
  } else {
    await replaceMappings(ctx, plan, at);
  }
  await getDb().query(
    `UPDATE provider_preference_profiles SET mapping_notes = $2 WHERE tenant_id = $1`,
    [ctx.tenantId, notes],
  );

  await appendEvent(ctx, {
    event: 'preference-saved',
    preference: valid.preference,
    summary:
      valid.note === null
        ? `Choice saved: ${label}.`
        : `Choice saved: ${label} — “${valid.note}”.`,
    detail: {
      preference: valid.preference,
      note: valid.note,
      positions: plan.assignments.length,
      degradedReads: facts.degraded,
    },
  });

  // Apply immediately when the saver administers the technical layer.
  const authorized = ctx.authority.includes(PROVIDER_PREFERENCES_TECHNICAL_CLAIM);
  let application: PreferenceApplication;
  if (authorized) {
    application = await applyToRouting(ctx, valid.preference, facts, plan);
  } else {
    const alreadyInEffect = row.applied_preference === valid.preference;
    application = {
      applied: alreadyInEffect,
      requiresAdministrator: !alreadyInEffect,
      summary: alreadyInEffect
        ? 'Saved — this choice is already in effect.'
        : 'Saved — an administrator of your company applies new choices in the advanced settings.',
      written: 0,
    };
  }

  const saved = await buildProfileView(ctx);
  return { profile: mapProfile(saved.row ?? row), application };
}

/**
 * Apply the SAVED preference to routing (claim-gated): recompute the
 * deterministic mapping from the current facts and evidence, write the
 * changed priorities through the llm contract's existing input, and
 * record the application in the audit. Re-runnable at any time.
 */
export async function applyPreferenceProfile(
  ctx: TenantContext,
  _input?: unknown,
): Promise<ApplyPreferenceProfileResult> {
  assertProviderPreferencesTenantContext(ctx);
  requireTechnicalAuthority(ctx);
  const row = await findProfileRow(ctx);
  if (row === null) {
    throw new ProviderPreferencesError(
      'invalid_input',
      'no preference has been saved yet — save one first (savePreferenceProfile)',
    );
  }
  const preference = row.preference as ProviderPreferenceKind;
  const facts = await loadFacts(ctx);
  const plan = computePreferenceOrder(
    preference,
    facts.accounts.filter((account) => account.status === 'active').map(toFacts),
    facts.evidence,
  );
  const application = await applyToRouting(ctx, preference, facts, plan);
  const saved = await buildProfileView(ctx);
  return { profile: mapProfile(saved.row ?? row), application };
}

/** Shared apply step: writes priorities, records the audit, sets state. */
async function applyToRouting(
  ctx: TenantContext,
  preference: ProviderPreferenceKind,
  facts: LoadedFacts,
  plan: PreferenceOrderPlan,
): Promise<PreferenceApplication> {
  const previous = await findProfileRow(ctx);
  const previouslyApplied = previous?.applied_preference ?? null;
  const label = preferenceOption(preference).label;

  if (facts.degraded.includes('ai-option-list')) {
    // Honest unavailable: never apply a mapping computed over a failed read.
    return {
      applied: previouslyApplied === preference,
      requiresAdministrator: false,
      summary:
        'The option list could not be read just now — nothing was changed; apply again in a moment.',
      written: 0,
    };
  }

  const written = await writePlanPriorities(ctx, plan, facts.accounts);
  const stateChanged = previouslyApplied !== preference;
  if (stateChanged) {
    await setAppliedState(ctx, preference, now());
  }
  if (written > 0 || stateChanged) {
    await appendEvent(ctx, {
      event: 'preference-applied',
      preference,
      summary:
        written > 0
          ? `Applied: ${label} — ${String(written)} option${written === 1 ? '' : 's'} reordered.`
          : `Applied: ${label} — the order already matched; nothing to rewrite.`,
      detail: { preference, written, positions: plan.assignments.length },
    });
  }

  return {
    applied: true,
    requiresAdministrator: false,
    summary:
      written > 0
        ? `Applied: ${label} — ${String(written)} option${written === 1 ? '' : 's'} reordered. It takes effect for the next task.`
        : `Applied: ${label} — the order already matched, nothing to rewrite.`,
    written,
  };
}

/**
 * The append-only change audit, newest first (saves, applications,
 * technical overrides). Preference summaries are plain language;
 * technical-override summaries are rendered only by the advanced view.
 */
export async function listPreferenceChangeEvents(
  ctx: TenantContext,
  input?: unknown,
): Promise<PreferenceChangeEvent[]> {
  assertProviderPreferencesTenantContext(ctx);
  const valid = validateListChangeEventsQuery(input ?? {});
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM provider_preference_events WHERE tenant_id = $1
       ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map(mapEvent);
}

/**
 * "Why was this option selected?" — the plain-language explanation of the
 * latest (or a given) AI task's FROZEN routing snapshot, read through the
 * llm contract. Foreign and missing execution ids are indistinguishable;
 * unknown machine reasons render as honest unexplained lines.
 */
export async function explainRoutingDecision(
  ctx: TenantContext,
  input?: unknown,
): Promise<RoutingDecisionExplanation> {
  assertProviderPreferencesTenantContext(ctx);
  const valid = validateExplainQuery(input ?? {});

  let execution: LlmExecution;
  if (valid.executionId !== null) {
    try {
      execution = await getLlmExecution(ctx, { executionId: valid.executionId });
    } catch (error) {
      if (error instanceof LlmError && error.code === 'execution_not_found') {
        return {
          found: false,
          reason: 'execution-not-found',
          note: 'No AI task matches this address in your company — missing and foreign addresses look the same by design.',
        };
      }
      throw new ProviderPreferencesError(
        'mapping_unavailable',
        'the AI task read is unavailable right now (llm contract read failed) — retry in a moment',
      );
    }
  } else {
    let latest: LlmExecution | undefined;
    try {
      const rows = await listLlmExecutions(ctx, { purpose: 'invocation', limit: 1 });
      latest = rows[0];
    } catch {
      throw new ProviderPreferencesError(
        'mapping_unavailable',
        'the AI task read is unavailable right now (llm contract read failed) — retry in a moment',
      );
    }
    if (latest === undefined) {
      return {
        found: false,
        reason: 'no-executions',
        note: 'No AI task has run yet — once one has, its explanation appears here.',
      };
    }
    execution = latest;
  }

  const row = await findProfileRow(ctx).catch(() => null);
  const preference = (row?.preference ?? DEFAULT_PREFERENCE) as ProviderPreferenceKind;

  return {
    found: true,
    executionId: execution.id,
    invokedAt: execution.invokedAt,
    status: execution.status,
    explanation: explainRoutingSnapshot(execution.routing),
    preferenceLine: preferenceLineFor(preference),
    technical: {
      pinned: execution.routing.pinned,
      chosen: execution.routing.chosen,
      candidates: [...execution.routing.candidates],
    },
  };
}

/**
 * The authorized technical view: the tenant's AI options in routing order
 * with their technical controls, plus the current mapping guidance.
 * Members without the technical authority claim get a typed unauthorized
 * error — the default surface never renders this data.
 */
export async function getTechnicalLayerView(
  ctx: TenantContext,
): Promise<TechnicalLayerView> {
  assertProviderPreferencesTenantContext(ctx);
  requireTechnicalAuthority(ctx);

  const row = await findProfileRow(ctx);
  let accounts: AiProviderAccount[];
  try {
    accounts = await listAiProviderAccounts(ctx, { limit: MAX_MAPPED_ACCOUNTS });
  } catch {
    throw new ProviderPreferencesError(
      'mapping_unavailable',
      'the AI option list is unavailable right now (llm contract read failed) — retry in a moment',
    );
  }
  const mappings = await listMappingRows(ctx);

  const rows: TechnicalAccountRow[] = accounts.map((account, index) => ({
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    status: account.status,
    scopes: [...account.scopes],
    capabilities: [...account.capabilities],
    maxDataClassification: account.maxDataClassification,
    priority: account.priority,
    routingPosition: index + 1,
    budgetMinor: account.budgetMinor,
  }));

  return {
    generatedAt: now().toISOString(),
    preference: (row?.preference ?? DEFAULT_PREFERENCE) as ProviderPreferenceKind,
    appliedPreference:
      row?.applied_preference === null || row?.applied_preference === undefined
        ? null
        : (row.applied_preference as ProviderPreferenceKind),
    appliedAt: row?.applied_at === null || row?.applied_at === undefined ? null : toIso(row.applied_at),
    mappings: mappings.map(mapMapping),
    mappingNotes: row === null ? [NO_PROFILE_NOTE] : [...row.mapping_notes],
    accounts: rows,
  };
}

/**
 * The technical override (claim-gated): a thin projection onto the llm
 * module's EXISTING updateAiProviderAccount input — priority, status,
 * scopes, capabilities, data-policy ceiling, budget. Reversible at any
 * time (call again with new values); every override lands in the audit.
 */
export async function updateProviderAccountControls(
  ctx: TenantContext,
  input: unknown,
): Promise<TechnicalOverrideResult> {
  assertProviderPreferencesTenantContext(ctx);
  requireTechnicalAuthority(ctx);
  const valid: ValidatedTechnicalOverrideInput = validateTechnicalOverrideInput(input);

  const payload: UpdateAiProviderAccountInput = {
    accountId: valid.accountId,
    ...(valid.priority !== null ? { priority: valid.priority } : {}),
    ...(valid.status !== null ? { status: valid.status } : {}),
    ...(valid.scopes !== null ? { scopes: valid.scopes } : {}),
    ...(valid.capabilities !== null ? { capabilities: valid.capabilities } : {}),
    ...(valid.maxDataClassification !== null
      ? { maxDataClassification: valid.maxDataClassification }
      : {}),
    ...(valid.budgetProvided ? { budgetMinor: valid.budgetMinor } : {}),
  };

  let account: AiProviderAccount;
  try {
    account = await updateAiProviderAccount(ctx, payload);
  } catch (error) {
    if (error instanceof LlmError) {
      if (error.code === 'account_not_found') {
        throw new ProviderPreferencesError(
          'account_not_found',
          `the AI option '${valid.accountId}' does not exist in this tenant`,
        );
      }
      if (error.code === 'forbidden') {
        throw new ProviderPreferencesError(
          'unauthorized',
          `advanced provider settings require the '${PROVIDER_PREFERENCES_TECHNICAL_CLAIM}' authority claim`,
        );
      }
    }
    throw new ProviderPreferencesError(
      'invalid_input',
      `the AI service rejected the override: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const changes: string[] = [];
  if (valid.priority !== null) changes.push('priority');
  if (valid.status !== null) changes.push('status');
  if (valid.scopes !== null) changes.push('scopes');
  if (valid.capabilities !== null) changes.push('capabilities');
  if (valid.maxDataClassification !== null) changes.push('data policy ceiling');
  if (valid.budgetProvided) changes.push('budget');

  await appendEvent(ctx, {
    event: 'technical-override',
    preference: null,
    summary: `Technical override on “${account.label}”: ${changes.join(', ')} changed.`,
    detail: { accountId: valid.accountId, changes },
  });

  return {
    account,
    summary: `Saved — ${changes.join(', ')} updated for “${account.label}”.`,
  };
}
