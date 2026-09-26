// Implementation of the provider-preferences module's public operations
// (see contract.ts). W091 — User-Friendly Provider Choice UX.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by `newId()` where
// the id is needed before the insert; timestamps come from the
// injectable clock and are never caller-supplied; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access
// is indistinguishable from a missing record, no existence leak.
//
// W091 acceptance — "ordinary user never needs provider jargon;
// preference can be changed at any time; system explains why a provider
// was selected; technical override remains available to authorized
// advanced users" — is carried by these deliberate properties, all
// tested:
//
//   1. THE ORDINARY SURFACE IS JARGON-FREE BY CONSTRUCTION: the
//      explanation strings are BUILT by policy.ts from structured
//      decision fields alone (no code path interpolates a provider key
//      into user language), and the ordinary reads
//      (listSelectionExplanations, the resolveProviderChoice result's
//      `record`) return the view projection that strips the technical
//      identity. The full record is behind the administer claim.
//
//   2. PREFERENCES CHANGE ANY TIME, AT BOTH LEVELS: any member sets,
//      re-sets or clears their personal preference (no gate — the
//      principal comes from the context, never the payload); authorized
//      users change the company-wide setting; every change lands on the
//      append-only audit feed (an UPDATE/DELETE trigger refuses any
//      mutation of history).
//
//   3. THE SYSTEM EXPLAINS WHY, HONESTLY: resolveProviderChoice composes
//      the whole policy chain — the active technical override, the W090
//      billing gateway's budget routing (READ-ONLY consult; provider
//      costs route through the billing gateway, exactly the work order's
//      posture), the resolved outcome profile — ranks the candidates
//      deterministically, and records the append-only explanation,
//      including the honest 'only one option', 'no option' and
//      'a spending limit excluded others' cases, idempotent by dedupe
//      key (first write wins).
//
//   4. THE OVERRIDE IS GATED, REVERSIBLE AND AUDITED: setTechnicalOverride
//      and clearTechnicalOverride require the
//      'provider-preferences:administer' claim; a cleared override can
//      be set again (the scope row re-activates); every change appends
//      to the audit feed; the override never bypasses any authority
//      gate — it is routing policy input the owning gateway honors.
//
//   5. FEEDS, NEVER BYPASSES: this module records policy inputs and
//      explanations; it never invokes a provider, never moves money,
//      never decides a W009 action, and never privileges a provider
//      (lock 30 — the ranker applies the TENANT'S priority).

import { now } from '@/infra/clock';
import { getDb } from '@/infra/db';
import type { DbRow, Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { routeWithinBudget } from '@/modules/provider-billing/contract';
import { ProviderPreferencesError } from './errors';
import {
  buildSelectionExplanation,
  rankProviderCandidates,
  resolvePreferenceProfile,
  toOrdinaryExplanationView,
} from './policy';
import {
  assertProviderPreferencesTenantContext,
  mapEventRow,
  mapExplanationRow,
  mapExplanationRowToView,
  mapPersonalPreferenceRow,
  mapTechnicalOverrideRow,
  mapTenantPreferenceRow,
  overrideScopeKey,
  validateClearTechnicalOverrideInput,
  validateGetSelectionExplanationQuery,
  validateGetTechnicalOverrideQuery,
  validateListProviderPreferenceEventsQuery,
  validateListSelectionExplanationsQuery,
  validateListTechnicalOverridesQuery,
  validateRecordSelectionExplanationInput,
  validateResolveProviderChoiceInput,
  validateSetPersonalPreferenceInput,
  validateSetTechnicalOverrideInput,
  validateSetTenantPreferenceInput,
  type ExplanationRow,
} from './validation';
import type {
  PersonalPreference,
  ProviderCandidate,
  ProviderPreferenceEvent,
  ProviderPreferenceOutcome,
  RecordSelectionExplanationResult,
  ResolvedPreferenceProfile,
  ResolveProviderChoiceResult,
  SelectionDecision,
  SelectionExplanationRecord,
  SelectionExplanationView,
  SetTechnicalOverrideResult,
  TenantPreference,
  TechnicalOverride,
} from './types';

// ---------------------------------------------------------------------------
// Authority vocabulary
// ---------------------------------------------------------------------------

/**
 * The claim that gates the management surface: company-wide preference,
 * technical overrides and the advanced explanation detail. The llm
 * module's 'llm:administer' precedent (W066): attaching/pinning external
 * AI endpoints is a management action, and so is steering company-wide
 * provider choice.
 */
export const PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER = 'provider-preferences:administer';

function requireAdminister(ctx: TenantContext): void {
  if (!ctx.authority.includes(PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER)) {
    throw new ProviderPreferencesError(
      'unauthorized',
      `changing the company-wide preference, technical overrides or reading the technical selection detail requires the '${PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rows and mappers (typing)
// ---------------------------------------------------------------------------

interface TenantPreferenceRow extends DbRow {
  id: string;
  tenant_id: string;
  outcome_priority: unknown;
  policy_first: boolean;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PersonalPreferenceRow extends DbRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  outcome_priority: unknown;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OverrideRow extends DbRow {
  id: string;
  tenant_id: string;
  gateway: string;
  capability: string | null;
  scope_key: string;
  provider: string;
  reason: string;
  status: string;
  set_by: string;
  set_at: Date | string;
  retired_by: string | null;
  retired_at: Date | string | null;
}

// ---------------------------------------------------------------------------
// The append-only audit feed
// ---------------------------------------------------------------------------

/** Record one audit event at the next per-tenant position (jargon-free detail). */
async function recordEvent(
  db: Queryable,
  ctx: TenantContext,
  event: ProviderPreferenceEvent['event'],
  detail: string,
  at: Date,
  principalId: string | null = null,
): Promise<void> {
  // Monotonic per-tenant position: the service clock can hold still
  // (test-controllable time), so the audit feed stays ordered.
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM provider_preference_events
       WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  await db.query(
    `INSERT INTO provider_preference_events
       (id, tenant_id, principal_id, position, event, detail, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), ctx.tenantId, principalId, next.rows[0]?.next ?? 1, event, detail, ctx.principalId, at],
  );
}

// ---------------------------------------------------------------------------
// Preferences — the tenant level (company-wide, claim-gated)
// ---------------------------------------------------------------------------

/**
 * Set (or change — any time) the company-wide outcome priority and
 * policy-first posture. Claim-gated: the company's routing posture is a
 * management action. The audit feed keeps every change.
 */
export async function setTenantPreference(
  ctx: TenantContext,
  input: unknown,
): Promise<TenantPreference> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  requireAdminister(validCtx);
  const valid = validateSetTenantPreferenceInput(input);
  const at = now();
  await getDb().transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM provider_preference_settings WHERE tenant_id = $1`,
      [validCtx.tenantId],
    );
    if (existing.rows.length === 0) {
      await tx.query(
        `INSERT INTO provider_preference_settings
           (id, tenant_id, outcome_priority, policy_first, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [
          newId(),
          validCtx.tenantId,
          JSON.stringify(valid.outcomePriority),
          valid.policyFirst,
          validCtx.principalId,
          at,
        ],
      );
    } else {
      await tx.query(
        `UPDATE provider_preference_settings
           SET outcome_priority = $2, policy_first = $3, updated_by = $4, updated_at = $5
         WHERE tenant_id = $1`,
        [
          validCtx.tenantId,
          JSON.stringify(valid.outcomePriority),
          valid.policyFirst,
          validCtx.principalId,
          at,
        ],
      );
    }
    await recordEvent(
      tx,
      validCtx,
      'tenant-preference-set',
      `company preference set: priority ${valid.outcomePriority.join(' > ')}${
        valid.policyFirst ? '; organizational policy decides' : ''
      }`,
      at,
    );
  });
  return (await getTenantPreference(validCtx))!;
}

/** The tenant's persisted preference (null when the company never set one). */
export async function getTenantPreference(ctx: TenantContext): Promise<TenantPreference | null> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const rows = await getDb().query<TenantPreferenceRow>(
    `SELECT * FROM provider_preference_settings WHERE tenant_id = $1`,
    [validCtx.tenantId],
  );
  return rows.rows.length === 0 ? null : mapTenantPreferenceRow(rows.rows[0]!);
}

// ---------------------------------------------------------------------------
// Preferences — the personal level (any member, any time)
// ---------------------------------------------------------------------------

/**
 * Set (or change — any time) the calling member's own outcome
 * preference. NO authority gate: the principal is taken from the
 * context, never the payload — a member steers their own interactions
 * and nothing else.
 */
export async function setPersonalPreference(
  ctx: TenantContext,
  input: unknown,
): Promise<PersonalPreference> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const valid = validateSetPersonalPreferenceInput(input);
  const at = now();
  await getDb().transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM provider_personal_preferences WHERE tenant_id = $1 AND principal_id = $2`,
      [validCtx.tenantId, validCtx.principalId],
    );
    if (existing.rows.length === 0) {
      await tx.query(
        `INSERT INTO provider_personal_preferences
           (id, tenant_id, principal_id, outcome_priority, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [
          newId(),
          validCtx.tenantId,
          validCtx.principalId,
          JSON.stringify(valid.outcomePriority),
          validCtx.principalId,
          at,
        ],
      );
    } else {
      await tx.query(
        `UPDATE provider_personal_preferences
           SET outcome_priority = $3, updated_by = $4, updated_at = $5
         WHERE tenant_id = $1 AND principal_id = $2`,
        [
          validCtx.tenantId,
          validCtx.principalId,
          JSON.stringify(valid.outcomePriority),
          validCtx.principalId,
          at,
        ],
      );
    }
    await recordEvent(
      tx,
      validCtx,
      'personal-preference-set',
      `personal preference set: priority ${valid.outcomePriority.join(' > ')}`,
      at,
      validCtx.principalId,
    );
  });
  return (await getPersonalPreference(validCtx))!;
}

/** The calling member's own preference (null when never set). */
export async function getPersonalPreference(ctx: TenantContext): Promise<PersonalPreference | null> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const rows = await getDb().query<PersonalPreferenceRow>(
    `SELECT * FROM provider_personal_preferences WHERE tenant_id = $1 AND principal_id = $2`,
    [validCtx.tenantId, validCtx.principalId],
  );
  return rows.rows.length === 0 ? null : mapPersonalPreferenceRow(rows.rows[0]!);
}

/** Clear the calling member's own preference (back to company/default). */
export async function clearPersonalPreference(ctx: TenantContext): Promise<void> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const at = now();
  await getDb().transaction(async (tx) => {
    const deleted = await tx.query(
      `DELETE FROM provider_personal_preferences WHERE tenant_id = $1 AND principal_id = $2`,
      [validCtx.tenantId, validCtx.principalId],
    );
    if ((deleted.rowCount ?? 0) > 0) {
      await recordEvent(
        tx,
        validCtx,
        'personal-preference-cleared',
        'personal preference cleared (company setting or balanced default applies)',
        at,
        validCtx.principalId,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The resolved profile (the deterministic fold — the ordinary read)
// ---------------------------------------------------------------------------

/**
 * The effective outcome profile for the calling principal, with its
 * plain-language source attribution. The honest fold: company policy
 * first (policy-first posture), then the member's own choice, then the
 * company's setting, then the documented balanced default.
 */
export async function getResolvedPreference(
  ctx: TenantContext,
): Promise<ResolvedPreferenceProfile> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const tenant = await getTenantPreference(validCtx);
  const personal = await getPersonalPreference(validCtx);
  return resolvePreferenceProfile(tenant, personal);
}

// ---------------------------------------------------------------------------
// Technical overrides (advanced, claim-gated, reversible, audited)
// ---------------------------------------------------------------------------

/** Find the scope row of one (gateway, capability) override slot, tenant-scoped. */
async function findOverrideRow(
  db: Queryable,
  ctx: TenantContext,
  gateway: string,
  capability: string | null,
): Promise<OverrideRow | null> {
  const rows = await db.query<OverrideRow>(
    `SELECT * FROM provider_technical_overrides
       WHERE tenant_id = $1 AND scope_key = $2`,
    [ctx.tenantId, overrideScopeKey(gateway, capability)],
  );
  return rows.rows.length === 0 ? null : rows.rows[0]!;
}

/**
 * Set (or re-set) a technical override: pin a provider for one
 * (gateway, capability) scope with a REQUIRED reason. Claim-gated.
 * Reversible by design: `clearTechnicalOverride` parks the row
 * 'retired' and a later set re-activates the same scope. The reason is
 * human language the advanced surface shows beside the pin.
 */
export async function setTechnicalOverride(
  ctx: TenantContext,
  input: unknown,
): Promise<SetTechnicalOverrideResult> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  requireAdminister(validCtx);
  const valid = validateSetTechnicalOverrideInput(input);
  const at = now();
  const created = await getDb().transaction(async (tx) => {
    const existing = await findOverrideRow(tx, validCtx, valid.gateway, valid.capability);
    if (existing === null) {
      await tx.query(
        `INSERT INTO provider_technical_overrides
           (id, tenant_id, gateway, capability, scope_key, provider, reason,
            status, set_by, set_at, retired_by, retired_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, NULL, NULL)`,
        [
          newId(),
          validCtx.tenantId,
          valid.gateway,
          valid.capability,
          overrideScopeKey(valid.gateway, valid.capability),
          valid.provider,
          valid.reason,
          validCtx.principalId,
          at,
        ],
      );
    } else {
      await tx.query(
        `UPDATE provider_technical_overrides
           SET provider = $2, reason = $3, status = 'active', set_by = $4, set_at = $5,
               retired_by = NULL, retired_at = NULL
         WHERE tenant_id = $1 AND scope_key = $6`,
        [
          validCtx.tenantId,
          valid.provider,
          valid.reason,
          validCtx.principalId,
          at,
          overrideScopeKey(valid.gateway, valid.capability),
        ],
      );
    }
    await recordEvent(
      tx,
      validCtx,
      'override-set',
      `technical override set for one AI route${
        valid.capability === null ? '' : ` (${valid.capability})`
      }: ${valid.reason}`,
      at,
    );
    return existing === null;
  });
  const override = (await findOverrideRow(getDb(), validCtx, valid.gateway, valid.capability))!;
  return { override: mapTechnicalOverrideRow(override), created };
}

/**
 * Clear (retire) a technical override — the reversible half. Claim-gated.
 * A retired override stays on record (its history is audit); the scope
 * can be re-activated by setting it again.
 */
export async function clearTechnicalOverride(
  ctx: TenantContext,
  input: unknown,
): Promise<TechnicalOverride> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  requireAdminister(validCtx);
  const valid = validateClearTechnicalOverrideInput(input);
  const at = now();
  const cleared = await getDb().transaction(async (tx) => {
    const existing = await findOverrideRow(tx, validCtx, valid.gateway, valid.capability);
    if (existing === null || existing.status !== 'active') {
      return null;
    }
    await tx.query(
      `UPDATE provider_technical_overrides
         SET status = 'retired', retired_by = $3, retired_at = $4
       WHERE tenant_id = $1 AND scope_key = $2`,
      [validCtx.tenantId, overrideScopeKey(valid.gateway, valid.capability), validCtx.principalId, at],
    );
    await recordEvent(
      tx,
      validCtx,
      'override-cleared',
      `technical override cleared for one AI route${
        valid.capability === null ? '' : ` (${valid.capability})`
      } — the preference policy chooses again`,
      at,
    );
    return existing;
  });
  if (cleared === null) {
    throw new ProviderPreferencesError(
      'override_not_found',
      `no active technical override for gateway '${valid.gateway}'${
        valid.capability === null ? '' : `, capability '${valid.capability}'`
      } in this tenant`,
    );
  }
  const override = (await findOverrideRow(getDb(), validCtx, valid.gateway, valid.capability))!;
  return mapTechnicalOverrideRow(override);
}

/** One override scope's current state (claim-gated read — advanced surface). */
export async function getTechnicalOverride(
  ctx: TenantContext,
  input: unknown,
): Promise<TechnicalOverride> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  requireAdminister(validCtx);
  const valid = validateGetTechnicalOverrideQuery(input);
  const row = await findOverrideRow(getDb(), validCtx, valid.gateway, valid.capability);
  if (row === null) {
    throw new ProviderPreferencesError(
      'override_not_found',
      `no technical override for gateway '${valid.gateway}'${
        valid.capability === null ? '' : `, capability '${valid.capability}'`
      } in this tenant`,
    );
  }
  return mapTechnicalOverrideRow(row);
}

/** The tenant's override scopes (claim-gated read — advanced surface). */
export async function listTechnicalOverrides(
  ctx: TenantContext,
  input: unknown,
): Promise<TechnicalOverride[]> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  requireAdminister(validCtx);
  const valid = validateListTechnicalOverridesQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  if (valid.gateway !== null) {
    params.push(valid.gateway);
    conditions.push(`gateway = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<OverrideRow>(
    `SELECT * FROM provider_technical_overrides WHERE ${conditions.join(' AND ')}
       ORDER BY set_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapTechnicalOverrideRow);
}

// ---------------------------------------------------------------------------
// The audit feed read
// ---------------------------------------------------------------------------

/** The append-only audit feed (user-language details, newest first). */
export async function listProviderPreferenceEvents(
  ctx: TenantContext,
  input: unknown,
): Promise<ProviderPreferenceEvent[]> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const valid = validateListProviderPreferenceEventsQuery(input);
  const rows = await getDb().query<DbRow & Parameters<typeof mapEventRow>[0]>(
    `SELECT * FROM provider_preference_events WHERE tenant_id = $1
       ORDER BY recorded_at DESC, position DESC LIMIT $2`,
    [validCtx.tenantId, valid.limit],
  );
  return rows.rows.map((row) => mapEventRow(row));
}

// ---------------------------------------------------------------------------
// Selection explanations — the append-only "why" ledger
// ---------------------------------------------------------------------------

/** Insert one explanation record (idempotent by (tenant, gateway, dedupe key)). */
async function insertExplanation(
  ctx: TenantContext,
  record: {
    gateway: string;
    capability: string;
    chosenProvider: string | null;
    chosenAccountRef: string | null;
    decision: SelectionDecision;
    preferenceSource: ResolveProviderChoiceResult['preferenceSource'];
    decidingOutcome: ProviderPreferenceOutcome | null;
    candidatesConsidered: number;
    budgetExcludedCount: number;
    overrideUnavailable: boolean;
    dedupeKey: string;
  },
  at: Date,
): Promise<{ row: ExplanationRow; created: boolean }> {
  const explanation = buildSelectionExplanation({
    decision: record.decision,
    preferenceSource: record.preferenceSource,
    decidingOutcome: record.decidingOutcome,
    candidatesConsidered: record.candidatesConsidered,
    budgetExcludedCount: record.budgetExcludedCount,
    overrideUnavailable: record.overrideUnavailable,
  });
  // The house race discipline (the provider-billing usage ledger): the
  // UNIQUE (tenant, gateway, dedupe key) + ON CONFLICT DO NOTHING makes
  // first-write-wins atomic; an empty RETURNING replays the original.
  const inserted = await getDb().query<ExplanationRow>(
    `INSERT INTO provider_selection_explanations
       (id, tenant_id, gateway, capability, chosen_provider, chosen_account_ref,
        decision, preference_source, deciding_outcome, candidates_considered,
        budget_excluded_count, override_unavailable, explanation, dedupe_key,
        recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (tenant_id, gateway, dedupe_key) DO NOTHING
     RETURNING *`,
    [
      newId(),
      ctx.tenantId,
      record.gateway,
      record.capability,
      record.chosenProvider,
      record.chosenAccountRef,
      record.decision,
      record.preferenceSource,
      record.decidingOutcome,
      record.candidatesConsidered,
      record.budgetExcludedCount,
      record.overrideUnavailable,
      explanation,
      record.dedupeKey,
      ctx.principalId,
      at,
    ],
  );
  if (inserted.rows[0] !== undefined) {
    return { row: inserted.rows[0], created: true };
  }
  // First write wins: replay the original record.
  const existing = await getDb().query<ExplanationRow>(
    `SELECT * FROM provider_selection_explanations
       WHERE tenant_id = $1 AND gateway = $2 AND dedupe_key = $3`,
    [ctx.tenantId, record.gateway, record.dedupeKey],
  );
  return { row: existing.rows[0]!, created: false };
}

/**
 * Record one selection explanation for a choice a gateway already made
 * on its own (the standalone recorder). The user-language explanation is
 * BUILT here from the structured fields — jargon-free by construction.
 * Idempotent by dedupe key (first write wins; a replay returns the
 * original record).
 */
export async function recordSelectionExplanation(
  ctx: TenantContext,
  input: unknown,
): Promise<RecordSelectionExplanationResult> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const valid = validateRecordSelectionExplanationInput(input);
  const at = now();
  const { row, created } = await insertExplanation(
    validCtx,
    {
      gateway: valid.gateway,
      capability: valid.capability,
      chosenProvider: valid.chosenProvider,
      chosenAccountRef: valid.chosenAccountRef,
      decision: valid.decision,
      preferenceSource: valid.preferenceSource,
      decidingOutcome: valid.decidingOutcome,
      candidatesConsidered: valid.candidatesConsidered,
      budgetExcludedCount: valid.budgetExcludedCount,
      overrideUnavailable: valid.overrideUnavailable,
      dedupeKey: valid.dedupeKey,
    },
    at,
  );
  return { record: mapExplanationRow(row), created };
}

/** The ORDINARY explanation feed — jargon-free (no technical identity). */
export async function listSelectionExplanations(
  ctx: TenantContext,
  input: unknown,
): Promise<SelectionExplanationView[]> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const valid = validateListSelectionExplanationsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [validCtx.tenantId];
  if (valid.capability !== null) {
    params.push(valid.capability);
    conditions.push(`capability = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<ExplanationRow>(
    `SELECT * FROM provider_selection_explanations WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapExplanationRowToView);
}

/**
 * The FULL explanation record — claim-gated (the advanced surface's
 * technical detail: the chosen provider, the account reference, the
 * gateway). Cross-tenant ids are uniformly not-found.
 */
export async function getSelectionExplanation(
  ctx: TenantContext,
  input: unknown,
): Promise<SelectionExplanationRecord> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  requireAdminister(validCtx);
  const valid = validateGetSelectionExplanationQuery(input);
  const rows = await getDb().query<ExplanationRow>(
    `SELECT * FROM provider_selection_explanations WHERE id = $1 AND tenant_id = $2`,
    [valid.explanationId, validCtx.tenantId],
  );
  if (rows.rows.length === 0) {
    throw new ProviderPreferencesError(
      'explanation_not_found',
      'no selection explanation with that id in this tenant',
    );
  }
  return mapExplanationRow(rows.rows[0]!);
}

// ---------------------------------------------------------------------------
// resolveProviderChoice — the composed policy resolution
// ---------------------------------------------------------------------------

/**
 * Resolve WHICH candidate option to use for one (gateway, capability)
 * route, under the tenant's full policy chain, and record the honest
 * user-language explanation. This is the POLICY-INPUT read the owning
 * gateway composes its routing around — it never invokes a provider,
 * never bypasses the W009 authority gate, and routes COST through the
 * W090 billing gateway's own budget evaluation (read-only consult).
 *
 * The chain, in order:
 *   1. the active technical override for the scope (claim-gated when
 *      set; honored here): its provider wins if a matching candidate is
 *      available — otherwise the resolution says so honestly and the
 *      preference chooses instead;
 *   2. the W090 budget routing: candidates that carry a projected cost
 *      are filtered through `routeWithinBudget` (a candidate without a
 *      projected cost cannot be budget-evaluated — the billing gateway
 *      only blocks what it can price);
 *   3. the resolved outcome profile (policy-first → personal → tenant →
 *      default) applied by the deterministic ranker;
 *   4. the honest terminal cases: exactly one option ('single-choice'),
 *      none at all ('no-choice' — recorded, never swallowed).
 *
 * Idempotent by dedupe key per (tenant, gateway): a replay returns the
 * ORIGINAL resolution (first write wins).
 */
export async function resolveProviderChoice(
  ctx: TenantContext,
  input: unknown,
): Promise<ResolveProviderChoiceResult> {
  const validCtx = assertProviderPreferencesTenantContext(ctx);
  const valid = validateResolveProviderChoiceInput(input);

  // The dedupe replay short-circuit (first write wins).
  const existing = await getDb().query<ExplanationRow>(
    `SELECT * FROM provider_selection_explanations
       WHERE tenant_id = $1 AND gateway = $2 AND dedupe_key = $3`,
    [validCtx.tenantId, valid.gateway, valid.dedupeKey],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    return {
      chosen:
        row.chosen_provider === null
          ? null
          : { provider: row.chosen_provider, accountRef: row.chosen_account_ref },
      explanation: row.explanation,
      decision: mapExplanationRow(row).decision,
      preferenceSource: mapExplanationRow(row).preferenceSource,
      decidingOutcome: mapExplanationRow(row).decidingOutcome,
      candidatesConsidered: row.candidates_considered,
      budgetExcludedCount: row.budget_excluded_count,
      overrideUnavailable: row.override_unavailable === true,
      record: mapExplanationRowToView(row),
      created: false,
    };
  }

  // 1. The active technical override for this scope.
  const overrideRow = await findOverrideRow(getDb(), validCtx, valid.gateway, valid.capability);
  const activeOverride =
    overrideRow !== null && overrideRow.status === 'active'
      ? mapTechnicalOverrideRow(overrideRow)
      : null;

  // 2. The W090 budget routing (read-only consult; costs route through
  //    the billing gateway, never around it).
  let available = valid.candidates;
  let budgetExcludedCount = 0;
  const priced = valid.candidates.filter(
    (candidate) => typeof candidate.projectedCostMinor === 'number',
  );
  if (priced.length > 0) {
    const routing = await routeWithinBudget(validCtx, {
      candidates: priced.map((candidate) => ({
        gateway: valid.gateway,
        provider: candidate.provider,
        capability: valid.capability,
        projectedCostMinor: candidate.projectedCostMinor as number,
      })),
    });
    const blocked = new Set(routing.blocked.map((candidate) => candidate.provider));
    budgetExcludedCount = blocked.size;
    available = valid.candidates.filter((candidate) => !blocked.has(candidate.provider));
  }

  const candidatesConsidered = valid.candidates.length;
  const profile = await getResolvedPreference(validCtx);

  // 4. The honest terminal cases first: nothing, or exactly one option.
  if (available.length === 0) {
    const { row } = await insertExplanation(
      validCtx,
      {
        gateway: valid.gateway,
        capability: valid.capability,
        chosenProvider: null,
        chosenAccountRef: null,
        decision: 'no-choice',
        preferenceSource: profile.source,
        decidingOutcome: null,
        candidatesConsidered,
        budgetExcludedCount,
        overrideUnavailable: activeOverride !== null,
        dedupeKey: valid.dedupeKey,
      },
      now(),
    );
    return {
      chosen: null,
      explanation: row.explanation,
      decision: 'no-choice',
      preferenceSource: profile.source,
      decidingOutcome: null,
      candidatesConsidered,
      budgetExcludedCount,
      overrideUnavailable: activeOverride !== null,
      record: mapExplanationRowToView(row),
      created: true,
    };
  }
  if (available.length === 1) {
    const only = available[0]!;
    const { row } = await insertExplanation(
      validCtx,
      {
        gateway: valid.gateway,
        capability: valid.capability,
        chosenProvider: only.provider,
        chosenAccountRef: only.accountRef ?? null,
        decision: 'single-choice',
        preferenceSource: profile.source,
        decidingOutcome: null,
        candidatesConsidered,
        budgetExcludedCount,
        overrideUnavailable: activeOverride !== null,
        dedupeKey: valid.dedupeKey,
      },
      now(),
    );
    return {
      chosen: { provider: only.provider, accountRef: only.accountRef ?? null },
      explanation: row.explanation,
      decision: 'single-choice',
      preferenceSource: profile.source,
      decidingOutcome: null,
      candidatesConsidered,
      budgetExcludedCount,
      overrideUnavailable: activeOverride !== null,
      record: mapExplanationRowToView(row),
      created: true,
    };
  }

  // 1 (revisited). The override decides among the available options.
  if (activeOverride !== null) {
    const pinned = available.find((candidate) => candidate.provider === activeOverride.provider);
    if (pinned !== undefined) {
      const { row } = await insertExplanation(
        validCtx,
        {
          gateway: valid.gateway,
          capability: valid.capability,
          chosenProvider: pinned.provider,
          chosenAccountRef: pinned.accountRef ?? null,
          decision: 'technical-override',
          preferenceSource: profile.source,
          decidingOutcome: null,
          candidatesConsidered,
          budgetExcludedCount,
          overrideUnavailable: false,
          dedupeKey: valid.dedupeKey,
        },
        now(),
      );
      return {
        chosen: { provider: pinned.provider, accountRef: pinned.accountRef ?? null },
        explanation: row.explanation,
        decision: 'technical-override',
        preferenceSource: profile.source,
        decidingOutcome: null,
        candidatesConsidered,
        budgetExcludedCount,
        overrideUnavailable: false,
        record: mapExplanationRowToView(row),
        created: true,
      };
    }
  }

  // 3. The preference ranker decides (deterministic; stable on ties).
  const ranking = rankProviderCandidates(available, profile.outcomePriority);
  const winner = ranking.ordered[0]!;
  const { row } = await insertExplanation(
    validCtx,
    {
      gateway: valid.gateway,
      capability: valid.capability,
      chosenProvider: winner.candidate.provider,
      chosenAccountRef: winner.candidate.accountRef ?? null,
      decision: 'preference',
      preferenceSource: profile.source,
      decidingOutcome: ranking.decidingOutcome,
      candidatesConsidered,
      budgetExcludedCount,
      overrideUnavailable: activeOverride !== null,
      dedupeKey: valid.dedupeKey,
    },
    now(),
  );
  return {
    chosen: {
      provider: winner.candidate.provider,
      accountRef: winner.candidate.accountRef ?? null,
    },
    explanation: row.explanation,
    decision: 'preference',
    preferenceSource: profile.source,
    decidingOutcome: ranking.decidingOutcome,
    candidatesConsidered,
    budgetExcludedCount,
    overrideUnavailable: activeOverride !== null,
    record: mapExplanationRowToView(row),
    created: true,
  };
}

/** Re-exported pure helper for the contract surface (policy.ts). */
export { toOrdinaryExplanationView, rankProviderCandidates, resolvePreferenceProfile };

/** Narrow re-export of the candidate type used by the resolution input. */
export type { ProviderCandidate };
