// Implementation of the briefings module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`briefing_not_found` / `policy_not_found`), no
// existence leak.
//
// W032 acceptance — "Generate policy-controlled proactive briefings for
// changes, goal drift, unknowns, risks, opportunities, capability gaps,
// workforce/agent performance and approvals" — is carried by these
// deliberate properties, all tested:
//   1. POLICY-CONTROLLED: the resolved policy (kind row → tenant default →
//      built-in floor) governs every generation — which sections are on,
//      each section's item cap and lookback, the briefing-level cadence
//      window and the delivery recipient. The snapshot that governed a
//      recorded briefing is frozen onto it (later policy edits never
//      rewrite a recorded briefing, the notifications discipline).
//   2. PROACTIVE: `generateBriefing` is the explicit worker entrypoint
//      (scheduled/system triggers drive it; this module owns no background
//      time). Default windows are CONTINUOUS: each briefing starts where
//      the previous one ended — no gaps, no overlaps (a worker cadence
//      never silently double-covers or skips reality).
//   3. DERIVED, NEVER AUTHORITATIVE (lock 34 / ADR-0010): every section
//      compiles from the sibling contracts (events, goals, epistemics,
//      cognition, capabilities, agents, actions) and every item deep-links
//      the underlying records. The briefing and its sections are immutable
//      history the moment they are written (storage-level triggers) —
//      PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE, except the single
//      one-way NULL→value assignment of the delivery notification id.
//   4. POLICY-CONTROLLED DELIVERY HANDOFF: when the resolved briefing
//      policy carries a delivery recipient, the generated briefing is
//      pushed by creating ONE notification through the notifications
//      contract (kind 'briefing', stable dedupe key `briefing:<id>`), so
//      delivery semantics — urgent/digest/escalation, retries, the W009
//      authority gate, acknowledgment — remain W031's owned machinery.
//      The handoff is replay-safe: a retry with the same idempotency key
//      re-attempts an unfinished delivery without re-generating.
//   5. IDEMPOTENT GENERATION: an idempotency key replays the original
//      briefing (first write wins — the events module's pattern); window
//      defaults keep coverage continuous; generation is deterministic
//      given the same reads and the same policy snapshots.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  createNotification,
  type NotificationRecipient,
} from '@/modules/notifications/contract';
import { BriefingsError } from './errors';
import {
  boundCandidates,
  briefingNotificationDedupeKey,
  briefingWindowFrom,
  BRIEFING_NOTIFICATION_KIND,
  BRIEFING_SECTION_KINDS,
  composeBriefingBody,
  composeBriefingHeadline,
  recipientLabel,
  resolveBriefingPolicySnapshot,
  resolveSectionPolicySnapshot,
} from './policy';
import { compileSection } from './sections';
import {
  assertBriefingsTenantContext,
  canAdministerBriefingPolicies,
  validateGenerateBriefingInput,
  validateGetBriefingQuery,
  validateListBriefingsQuery,
  validateListBriefingPoliciesQuery,
  validatePolicySubjectQuery,
  validateResolvePolicyQuery,
  validateSetBriefingPolicyInput,
  MAX_SECTION_ITEMS_BYTES,
  type ValidatedPolicyInput,
} from './validation';
import type {
  Briefing,
  BriefingItem,
  BriefingPolicy,
  BriefingRecipient,
  BriefingSection,
  BriefingSectionKind,
  BriefingSectionSummary,
  BriefingSummary,
  BriefingTriggerKind,
  GenerateBriefingResult,
  ResolvedSectionPolicy,
} from './types';

// ---------------------------------------------------------------------------
// Rows + mapping
// ---------------------------------------------------------------------------

interface PolicyRow extends DbRow {
  id: string;
  tenant_id: string;
  section_kind: string | null;
  enabled: boolean;
  max_items: number;
  window_seconds: number;
  delivery_recipient: unknown;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BriefingRow extends DbRow {
  id: string;
  tenant_id: string;
  trigger_kind: string;
  trigger_label: string | null;
  window_from: Date | string;
  window_to: Date | string;
  generated_by: string;
  generated_at: Date | string;
  headline: string;
  policy_source: string;
  default_window_seconds: number;
  delivery_recipient: unknown;
  delivery_notification_id: string | null;
  idempotency_key: string | null;
  updated_at: Date | string;
}

interface SectionRow extends DbRow {
  id: string;
  tenant_id: string;
  briefing_id: string;
  section_kind: string;
  policy_source: string;
  enabled: boolean;
  max_items: number;
  window_seconds: number;
  window_from: Date | string;
  window_to: Date | string;
  candidate_count: number;
  item_count: number;
  items: unknown;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapRecipient(value: unknown): BriefingRecipient | null {
  if (value === null || value === undefined) return null;
  const raw = value as { provider: string; providerAccountId: string; displayName?: string | null };
  return {
    provider: raw.provider as BriefingRecipient['provider'], // CHECK-constrained at write time
    providerAccountId: raw.providerAccountId,
    displayName: raw.displayName ?? null,
  };
}

/** Canonical JSON of a channel party: a null display name is OMITTED. */
function serializeRecipient(recipient: BriefingRecipient): string {
  const displayName = recipient.displayName ?? null;
  return displayName === null
    ? JSON.stringify({ provider: recipient.provider, providerAccountId: recipient.providerAccountId })
    : JSON.stringify({
        provider: recipient.provider,
        providerAccountId: recipient.providerAccountId,
        displayName,
      });
}

function mapPolicy(row: PolicyRow): BriefingPolicy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sectionKind: row.section_kind,
    enabled: row.enabled,
    maxItems: row.max_items,
    windowSeconds: row.window_seconds,
    deliveryRecipient: mapRecipient(row.delivery_recipient),
    note: row.note,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapBriefingHeader(row: BriefingRow): Briefing {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    trigger: {
      kind: row.trigger_kind as BriefingTriggerKind, // CHECK-constrained
      label: row.trigger_label,
    },
    windowFrom: toIso(row.window_from),
    windowTo: toIso(row.window_to),
    generatedBy: row.generated_by,
    generatedAt: toIso(row.generated_at),
    headline: row.headline,
    policySource: row.policy_source as Briefing['policySource'], // CHECK-constrained
    defaultWindowSeconds: row.default_window_seconds,
    deliveryRecipient: mapRecipient(row.delivery_recipient),
    deliveryNotificationId: row.delivery_notification_id,
    updatedAt: toIso(row.updated_at),
    sections: [],
  };
}

function mapSection(row: SectionRow, withItems: boolean): BriefingSectionSummary | BriefingSection {
  const base: BriefingSectionSummary = {
    id: row.id,
    tenantId: row.tenant_id,
    briefingId: row.briefing_id,
    sectionKind: row.section_kind as BriefingSectionKind, // CHECK-constrained
    policySource: row.policy_source as BriefingSection['policySource'], // CHECK-constrained
    enabled: row.enabled,
    maxItems: row.max_items,
    windowSeconds: row.window_seconds,
    windowFrom: toIso(row.window_from),
    windowTo: toIso(row.window_to),
    candidateCount: row.candidate_count,
    itemCount: row.item_count,
    recordedAt: toIso(row.recorded_at),
  };
  if (!withItems) return base;
  return { ...base, items: (row.items ?? []) as BriefingItem[] };
}

// ---------------------------------------------------------------------------
// Policy reads + resolution helpers
// ---------------------------------------------------------------------------

async function findPolicyRow(
  ctx: TenantContext,
  sectionKind: string | null,
): Promise<PolicyRow | null> {
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM briefing_policies
      WHERE tenant_id = $1 AND section_kind IS NOT DISTINCT FROM $2
      LIMIT 1`,
    [ctx.tenantId, sectionKind],
  );
  return rows.rows[0] ?? null;
}

/** The tenant's DEFAULT policy row (the briefing-level configuration), or null. */
async function findDefaultPolicyRow(ctx: TenantContext): Promise<PolicyRow | null> {
  return findPolicyRow(ctx, null);
}

async function listPolicyRows(ctx: TenantContext, limit: number): Promise<PolicyRow[]> {
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM briefing_policies
      WHERE tenant_id = $1
      ORDER BY section_kind ASC NULLS FIRST, id ASC
      LIMIT $2`,
    [ctx.tenantId, limit],
  );
  return rows.rows;
}

/** Resolve one section's effective policy (kind row → default row → built-in). */
async function resolveSectionPolicy(
  ctx: TenantContext,
  sectionKind: BriefingSectionKind,
): Promise<ResolvedSectionPolicy> {
  const [kindRow, defaultRow] = await Promise.all([
    findPolicyRow(ctx, sectionKind),
    findDefaultPolicyRow(ctx),
  ]);
  return resolveSectionPolicySnapshot(
    sectionKind,
    kindRow === null ? null : mapPolicy(kindRow),
    defaultRow === null ? null : mapPolicy(defaultRow),
  );
}

// ---------------------------------------------------------------------------
// Policy operations (public)
// ---------------------------------------------------------------------------

/** Upsert one briefing policy row by section-kind key (claim-gated write). */
export async function setBriefingPolicy(
  ctx: TenantContext,
  input: unknown,
): Promise<BriefingPolicy> {
  assertBriefingsTenantContext(ctx);
  const valid: ValidatedPolicyInput = validateSetBriefingPolicyInput(input);
  if (!canAdministerBriefingPolicies(ctx.authority)) {
    throw new BriefingsError(
      'forbidden',
      `this operation requires the '${'briefings:administer'}' authority claim`,
    );
  }

  const at = now();
  const inserted = await getDb().query<PolicyRow>(
    `INSERT INTO briefing_policies AS p (
       tenant_id, section_kind, enabled, max_items, window_seconds,
       delivery_recipient, note, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (tenant_id, section_kind) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       max_items = EXCLUDED.max_items,
       window_seconds = EXCLUDED.window_seconds,
       delivery_recipient = EXCLUDED.delivery_recipient,
       note = EXCLUDED.note,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      ctx.tenantId,
      valid.sectionKind,
      valid.enabled,
      valid.maxItems,
      valid.windowSeconds,
      valid.deliveryRecipient === null ? null : serializeRecipient(valid.deliveryRecipient),
      valid.note,
      at,
    ],
  );
  return mapPolicy(inserted.rows[0]!);
}

/** Read one policy row by exact key (null = the default row); not-found when absent. */
export async function getBriefingPolicy(
  ctx: TenantContext,
  query: unknown,
): Promise<BriefingPolicy> {
  assertBriefingsTenantContext(ctx);
  const valid = validatePolicySubjectQuery(query);
  const row = await findPolicyRow(ctx, valid.sectionKind);
  if (row === null) {
    throw new BriefingsError(
      'policy_not_found',
      `no briefing policy for ${valid.sectionKind === null ? 'the tenant default' : `section '${valid.sectionKind}'`} exists in this tenant`,
    );
  }
  return mapPolicy(row);
}

/** List the tenant's policy rows (default row first, then by section kind). */
export async function listBriefingPolicies(
  ctx: TenantContext,
  query: unknown,
): Promise<BriefingPolicy[]> {
  assertBriefingsTenantContext(ctx);
  const valid = validateListBriefingPoliciesQuery(query);
  const rows = await listPolicyRows(ctx, valid.limit);
  return rows.map(mapPolicy);
}

/** Resolve one section kind's effective policy (pure resolution over the rows). */
export async function resolveBriefingPolicy(
  ctx: TenantContext,
  query: unknown,
): Promise<ResolvedSectionPolicy> {
  assertBriefingsTenantContext(ctx);
  const valid = validateResolvePolicyQuery(query);
  return resolveSectionPolicy(ctx, valid.sectionKind);
}

// ---------------------------------------------------------------------------
// Briefing reads (public)
// ---------------------------------------------------------------------------

interface SectionRowsByBriefing {
  [briefingId: string]: SectionRow[];
}

async function loadSectionRows(
  ctx: TenantContext,
  briefingIds: readonly string[],
  withItems: boolean,
): Promise<SectionRowsByBriefing> {
  const byBriefing: SectionRowsByBriefing = {};
  if (briefingIds.length === 0) return byBriefing;
  // Briefing ids are system-minted uuids (never caller text) — the IN list
  // is still parameterized one placeholder per id (no dynamic SQL values).
  const placeholders = briefingIds.map((_, index) => `$${index + 2}`).join(', ');
  const columns = withItems ? '*' : `id, tenant_id, briefing_id, section_kind, policy_source,
      enabled, max_items, window_seconds, window_from, window_to,
      candidate_count, item_count, NULL AS items, recorded_at`;
  const rows = await getDb().query<SectionRow>(
    `SELECT ${columns} FROM briefing_sections
      WHERE tenant_id = $1 AND briefing_id IN (${placeholders})
      ORDER BY section_kind ASC`,
    [ctx.tenantId, ...briefingIds],
  );
  for (const row of rows.rows) {
    const bucket = byBriefing[row.briefing_id];
    if (bucket === undefined) {
      byBriefing[row.briefing_id] = [row];
    } else {
      bucket.push(row);
    }
  }
  return byBriefing;
}

/** Canonical W032 section order for read models. */
function orderedSections(
  rows: readonly SectionRow[],
  withItems: boolean,
): (BriefingSectionSummary | BriefingSection)[] {
  const byKind = new Map<string, SectionRow>();
  for (const row of rows) byKind.set(row.section_kind, row);
  const ordered: (BriefingSectionSummary | BriefingSection)[] = [];
  for (const kind of BRIEFING_SECTION_KINDS) {
    const row = byKind.get(kind);
    if (row !== undefined) ordered.push(mapSection(row, withItems));
  }
  // Unknown kinds cannot occur (CHECK-constrained); any residual rows keep
  // their stored order after the canonical kinds.
  for (const row of rows) {
    if (!(BRIEFING_SECTION_KINDS as readonly string[]).includes(row.section_kind)) {
      ordered.push(mapSection(row, withItems));
    }
  }
  return ordered;
}

/** Read one briefing with its full sections (items included). */
export async function getBriefing(ctx: TenantContext, query: unknown): Promise<Briefing> {
  assertBriefingsTenantContext(ctx);
  const valid = validateGetBriefingQuery(query);
  const rows = await getDb().query<BriefingRow>(
    `SELECT * FROM briefings WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [ctx.tenantId, valid.briefingId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new BriefingsError(
      'briefing_not_found',
      `no briefing '${valid.briefingId}' exists in this tenant`,
    );
  }
  const sectionRows = (await loadSectionRows(ctx, [row.id], true))[row.id] ?? [];
  const briefing = mapBriefingHeader(row);
  briefing.sections = orderedSections(sectionRows, true) as BriefingSection[];
  return briefing;
}

/** List briefings (newest first), with section summaries (no items). */
export async function listBriefings(ctx: TenantContext, query: unknown): Promise<BriefingSummary[]> {
  assertBriefingsTenantContext(ctx);
  const valid = validateListBriefingsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.triggerKind !== null) {
    params.push(valid.triggerKind);
    conditions.push(`trigger_kind = $${params.length}`);
  }
  if (valid.windowFrom !== null) {
    params.push(valid.windowFrom);
    conditions.push(`window_to >= $${params.length}`);
  }
  if (valid.windowTo !== null) {
    params.push(valid.windowTo);
    conditions.push(`window_from <= $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<BriefingRow>(
    `SELECT * FROM briefings WHERE ${conditions.join(' AND ')}
       ORDER BY generated_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  const sectionRowsByBriefing = await loadSectionRows(
    ctx,
    rows.rows.map((row) => row.id),
    false,
  );
  return rows.rows.map((row) => {
    const briefing: BriefingSummary = {
      ...mapBriefingHeader(row),
      sections: orderedSections(sectionRowsByBriefing[row.id] ?? [], false),
    };
    return briefing;
  });
}

// ---------------------------------------------------------------------------
// Generation (public)
// ---------------------------------------------------------------------------

/** The idempotency-key lookup (first write wins — the events module's pattern). */
async function findBriefingByKey(ctx: TenantContext, idempotencyKey: string): Promise<BriefingRow | null> {
  const rows = await getDb().query<BriefingRow>(
    `SELECT * FROM briefings WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [ctx.tenantId, idempotencyKey],
  );
  return rows.rows[0] ?? null;
}

async function findLatestBriefingRow(ctx: TenantContext): Promise<BriefingRow | null> {
  const rows = await getDb().query<BriefingRow>(
    `SELECT * FROM briefings WHERE tenant_id = $1
       ORDER BY window_to DESC, generated_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId],
  );
  return rows.rows[0] ?? null;
}

interface CompiledSectionRecord {
  sectionKind: BriefingSectionKind;
  policySource: ResolvedSectionPolicy['source'];
  enabled: boolean;
  maxItems: number;
  windowSeconds: number;
  windowFrom: Date;
  windowTo: Date;
  candidateCount: number;
  items: BriefingItem[];
}

/**
 * Compile every section for one generation: resolve the section policy
 * (kind → default → built-in), derive the section's effective window —
 * the INTERSECTION of the briefing's coverage window and the section's
 * lookback policy (a section never reaches beyond what its briefing
 * covers, and never re-covers what a previous briefing already did) —
 * and bound the compiled candidates by the policy's item cap. Disabled
 * sections compile to the documented empty row.
 */
async function compileAllSections(
  ctx: TenantContext,
  briefingWindow: { from: Date; to: Date },
): Promise<CompiledSectionRecord[]> {
  const records: CompiledSectionRecord[] = [];
  for (const sectionKind of BRIEFING_SECTION_KINDS) {
    const policy = await resolveSectionPolicy(ctx, sectionKind);
    const lookbackFrom = new Date(
      briefingWindow.to.getTime() - policy.windowSeconds * 1_000,
    );
    const sectionFrom =
      lookbackFrom.getTime() > briefingWindow.from.getTime()
        ? lookbackFrom
        : briefingWindow.from;
    const record: CompiledSectionRecord = {
      sectionKind,
      policySource: policy.source,
      enabled: policy.enabled,
      maxItems: policy.maxItems,
      windowSeconds: policy.windowSeconds,
      windowFrom: sectionFrom,
      windowTo: briefingWindow.to,
      candidateCount: 0,
      items: [],
    };
    if (policy.enabled) {
      const candidates = await compileSection(ctx, sectionKind, {
        from: sectionFrom,
        to: briefingWindow.to,
      });
      const bounded = boundCandidates(candidates, policy.maxItems);
      record.candidateCount = bounded.candidateCount;
      record.items = bounded.items;
      const serialized = JSON.stringify(record.items);
      if (serialized.length > MAX_SECTION_ITEMS_BYTES) {
        throw new BriefingsError(
          'invalid_briefing_input',
          `section '${sectionKind}' serialized items exceed the ${MAX_SECTION_ITEMS_BYTES}-byte bound (${serialized.length} bytes) — lower the section's maxItems policy`,
        );
      }
    }
    records.push(record);
  }
  return records;
}

/**
 * Create the delivery notification through the notifications contract
 * (W031): kind 'briefing', stable dedupe key, the composed subject/body,
 * and the briefing reference in `data`. The notification module owns
 * every delivery semantic from here (class, retries, the W009 gate).
 */
async function deliverBriefing(
  ctx: TenantContext,
  briefing: Briefing,
  recipient: BriefingRecipient,
): Promise<string> {
  const notificationRecipient: NotificationRecipient = {
    provider: recipient.provider,
    providerAccountId: recipient.providerAccountId,
    displayName: recipient.displayName ?? null,
  };
  try {
    const result = await createNotification(ctx, {
      kind: BRIEFING_NOTIFICATION_KIND,
      recipient: notificationRecipient,
      subject: briefing.headline,
      body: composeBriefingBody(
        briefing.sections.map((section) => ({
          sectionKind: section.sectionKind,
          enabled: section.enabled,
          itemCount: section.itemCount,
          candidateCount: section.candidateCount,
          items: section.items,
        })),
        briefing.windowTo,
      ),
      data: { briefingId: briefing.id },
      dedupeKey: briefingNotificationDedupeKey(briefing.id),
      correlationId: briefing.id,
    });
    return result.notification.id;
  } catch (error) {
    // The briefing record stands; the handoff failed. Wrap with the
    // module's own error so the caller sees the delivery failure loudly —
    // a retry with the same idempotency key re-attempts the handoff.
    const reason = error instanceof Error ? error.message : String(error);
    throw new BriefingsError(
      'delivery_failed',
      `the briefing '${briefing.id}' was generated but its delivery handoff to ${recipientLabel(recipient)} failed: ${reason}`,
    );
  }
}

/** Fill the one-way delivery link (storage-guarded NULL→value assignment). */
async function recordDeliveryNotificationId(briefingId: string, tenantId: string, notificationId: string): Promise<void> {
  await getDb().query(
    `UPDATE briefings
       SET delivery_notification_id = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2 AND delivery_notification_id IS NULL`,
    [tenantId, briefingId, notificationId, now()],
  );
}

/**
 * Generate one management briefing (W032's core operation): resolve the
 * policy, compute the coverage window, compile every section from the
 * dependency contracts, record the immutable briefing + sections, and —
 * when the policy carries a delivery recipient — hand the briefing to
 * the notifications module (W031) for policy-controlled delivery.
 */
export async function generateBriefing(
  ctx: TenantContext,
  input: unknown,
): Promise<GenerateBriefingResult> {
  assertBriefingsTenantContext(ctx);
  const valid = validateGenerateBriefingInput(input);

  // Idempotent replay: a recorded key returns the original briefing and
  // re-attempts an unfinished delivery (the events module's pattern).
  if (valid.idempotencyKey !== null) {
    const existing = await findBriefingByKey(ctx, valid.idempotencyKey);
    if (existing !== null) {
      const briefing = await getBriefing(ctx, { briefingId: existing.id });
      let delivered: string | null = briefing.deliveryNotificationId;
      if (delivered === null && briefing.deliveryRecipient !== null) {
        delivered = await deliverBriefing(ctx, briefing, briefing.deliveryRecipient);
        await recordDeliveryNotificationId(briefing.id, ctx.tenantId, delivered);
      }
      return { briefing: await getBriefing(ctx, { briefingId: existing.id }), deduped: true, deliveredNotificationId: delivered };
    }
  }

  // Resolve the briefing-level policy (default row → built-in floor).
  const defaultRow = await findDefaultPolicyRow(ctx);
  const levelPolicy = resolveBriefingPolicySnapshot(
    defaultRow === null ? null : mapPolicy(defaultRow),
  );

  // Compute the coverage window: explicit bounds win; the default lower
  // bound is continuous with the previous briefing (or the cadence window).
  const windowTo = valid.windowTo === null ? now() : new Date(valid.windowTo);
  const windowFrom =
    valid.windowFrom === null
      ? await (async () => {
          const latest = await findLatestBriefingRow(ctx);
          return briefingWindowFrom(
            latest === null ? null : toIso(latest.window_to),
            windowTo,
            levelPolicy.windowSeconds,
          );
        })()
      : new Date(valid.windowFrom);
  if (windowFrom.getTime() >= windowTo.getTime()) {
    throw new BriefingsError(
      'invalid_briefing_input',
      'the computed briefing window is empty (windowFrom must be strictly before windowTo)',
    );
  }

  // Compile every section under its resolved policy snapshot.
  const sections = await compileAllSections(ctx, { from: windowFrom, to: windowTo });
  const headline = composeBriefingHeadline(
    sections.map((section) => ({
      sectionKind: section.sectionKind,
      enabled: section.enabled,
      itemCount: section.items.length,
      candidateCount: section.candidateCount,
      items: section.items,
    })),
  );

  // Record the briefing and its sections atomically.
  const at = now();
  const briefingId = await getDb().transaction(async (tx) => {
    const briefingRows = await tx.query<BriefingRow>(
      `INSERT INTO briefings (
         tenant_id, trigger_kind, trigger_label, window_from, window_to,
         generated_by, generated_at, headline, policy_source,
         default_window_seconds, delivery_recipient, delivery_notification_id,
         idempotency_key, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $7)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.trigger.kind,
        valid.trigger.label,
        windowFrom,
        windowTo,
        ctx.principalId,
        at,
        headline,
        levelPolicy.source,
        levelPolicy.windowSeconds,
        levelPolicy.deliveryRecipient === null
          ? null
          : serializeRecipient(levelPolicy.deliveryRecipient),
        valid.idempotencyKey,
      ],
    );
    const briefingRow = briefingRows.rows[0]!;
    for (const section of sections) {
      await tx.query(
        `INSERT INTO briefing_sections (
           tenant_id, briefing_id, section_kind, policy_source, enabled,
           max_items, window_seconds, window_from, window_to,
           candidate_count, item_count, items, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          ctx.tenantId,
          briefingRow.id,
          section.sectionKind,
          section.policySource,
          section.enabled,
          section.maxItems,
          section.windowSeconds,
          section.windowFrom,
          section.windowTo,
          section.candidateCount,
          section.items.length,
          JSON.stringify(section.items),
          at,
        ],
      );
    }
    return briefingRow.id;
  });

  // Policy-controlled delivery handoff (W031) — after the record stands,
  // so a handoff failure never loses the generated briefing.
  let delivered: string | null = null;
  if (levelPolicy.deliveryRecipient !== null) {
    const briefing = await getBriefing(ctx, { briefingId });
    delivered = await deliverBriefing(ctx, briefing, levelPolicy.deliveryRecipient);
    await recordDeliveryNotificationId(briefingId, ctx.tenantId, delivered);
  }

  return {
    briefing: await getBriefing(ctx, { briefingId }),
    deduped: false,
    deliveredNotificationId: delivered,
  };
}
