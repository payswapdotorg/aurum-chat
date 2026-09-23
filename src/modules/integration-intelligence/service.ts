// Implementation of the integration-intelligence module's public operations
// (see contract.ts). W081 — Integration Intelligence.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) or `newId()` where a cross-module call needs the id
// first; timestamps come from the injectable clock; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`*_not_found`), no existence
// leak.
//
// W081 acceptance — "admin grants an approved discovery source; Aurum
// identifies systems/capabilities; shows outcome-oriented recommendations
// and scope impact; no uncontrolled network scanning; every discovered
// system is tenant-scoped" — is carried by these deliberate properties,
// all tested:
//
//   1. THE NO-SCAN INVARIANT: `runDiscovery` polls ONLY sources with an
//      ACTIVE admin grant in the caller's tenant. Un-granted, cross-tenant
//      and revoked sources are refused with `discovery_not_authorized`
//      BEFORE any transport interaction — the module has no other network
//      surface at all, and the only fetch path is the sources module's
//      authenticated polling transport (credentialRef-resolved, provider
//      adapter-normalized). Probing, port-scanning and unauthenticated
//      enumeration do not exist here.
//
//   2. TENANT SCOPING: every table carries tenant_id and every query is
//      tenant-filtered; grants, systems, recommendations, batches and
//      verification runs of another tenant are indistinguishable from
//      missing ones. Discovery evidence itself (the observations directory
//      records became) is recorded tenant-scoped by the sources module.
//
//   3. W009 AUTHORITY: connection grants are consequential EXECUTE actions.
//      `submitRecommendationBatch` routes the whole batch through the
//      actions module's authority matrix (`integration-connection` ×
//      EXECUTE); the built-in default gates EXECUTE behind human approval,
//      so nothing connects without an explicit human decision unless
//      tenant policy explicitly allows it. The action request is created
//      BEFORE the batch row: a recommendation may never sit in a gated
//      state without its gate record existing. `decideRecommendationBatch`
//      delegates the decision itself to the actions contract (approve
//      claim + separation of duties enforced there) and mirrors the
//      decided state onto the batch and its recommendations.
//
//   4. DETERMINISTIC INTELLIGENCE: explanations, scores and scope impact
//      are pure functions (explain.ts / recommend.ts) of the discovered
//      capability surface and the org's current goals/unknowns/gaps (read
//      through their contracts). No LLM, no clock, no randomness in the
//      ranking path (lock 10).
//
//   5. HONEST VERIFICATION: connection records an automatic verification
//      run for every promised read capability. With no verification
//      transport wired the run is recorded `pending` — never a fake
//      success (the sources module's `provider_unavailable` discipline);
//      explicit re-verification refuses with `verification_unavailable`.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  decideApproval,
  getActionRequest,
} from '@/modules/actions/contract';
import { analyzeGaps } from '@/modules/capabilities/contract';
import { listUnknowns } from '@/modules/epistemics/contract';
import { listGoals } from '@/modules/goals/contract';
import { getObservation } from '@/modules/observations/contract';
import { getSource, pollSource } from '@/modules/sources/contract';
import { IntegrationError } from './errors';
import {
  classifyDirectoryRecord,
  deriveCapabilitySurface,
  systemKeyOf,
  type DiscoveredSystemManifest,
} from './discovery';
import { explainWhyItMatters } from './explain';
import { buildRecommendationDraft } from './recommend';
import type { ExplanationOrgContext } from './types';
import {
  assertIntegrationTenantContext,
  validateConnectSystemInput,
  validateDecideBatchInput,
  validateGetDiscoveryGrantQuery,
  validateGetRecommendationBatchQuery,
  validateGetRecommendationQuery,
  validateGetSystemQuery,
  validateGrantDiscoverySourceInput,
  validateListDiscoveryGrantsQuery,
  validateListRecommendationBatchesQuery,
  validateListRecommendationsQuery,
  validateListSystemsQuery,
  validateListVerificationRunsQuery,
  validateRevokeDiscoverySourceInput,
  validateRunDiscoveryInput,
  validateSubmitBatchInput,
  validateVerifySystemInput,
  MAX_EVIDENCE_OBSERVATIONS,
} from './validation';
import type {
  CapabilityProbeRequest,
  CapabilityProbeResult,
  ConnectSystemInput,
  ConnectSystemResult,
  DecideBatchInput,
  DiscoveryGrant,
  DiscoveryRunResult,
  DiscoverySourceRun,
  GetDiscoveryGrantQuery,
  GetRecommendationBatchQuery,
  GetRecommendationQuery,
  GetSystemQuery,
  GrantDiscoverySourceInput,
  GrantDiscoverySourceResult,
  InventorySystem,
  ListDiscoveryGrantsQuery,
  ListRecommendationBatchesQuery,
  ListRecommendationsQuery,
  ListSystemsQuery,
  ListVerificationRunsQuery,
  Recommendation,
  RecommendationBatch,
  RevokeDiscoverySourceInput,
  RunDiscoveryInput,
  ScopeImpact,
  SubmitBatchInput,
  SystemCapability,
  SystemHealth,
  VerificationProbeResult,
  VerificationRun,
  VerificationStatus,
  VerificationTransport,
  VerifySystemInput,
  WhyItMatters,
} from './types';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/** Authority claim that administers discovery grants (the admin gate). */
export const INTEGRATION_AUTHORITY_ADMINISTER = 'integration-intelligence:administer';

/** The canonical action kind of a consequential system connection (W009 §20 vocabulary). */
export const INTEGRATION_ACTION_KIND = 'integration-connection';

/** Idempotency-key namespace for batch submissions (first write wins, W009 replay). */
const BATCH_IDEMPOTENCY_PREFIX = 'integration-batch:';

// ---------------------------------------------------------------------------
// Verification transport wiring (sources-transport precedent)
// ---------------------------------------------------------------------------

let verificationTransport: VerificationTransport | null = null;

/** Wires (or clears) the verification transport — infrastructure wiring, not domain state. */
export function setVerificationTransport(transport: VerificationTransport | null): void {
  verificationTransport = transport;
}

/** The currently wired verification transport (null = none). */
export function getVerificationTransport(): VerificationTransport | null {
  return verificationTransport;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface GrantRow extends DbRow {
  id: string;
  tenant_id: string;
  source_id: string;
  status: string;
  granted_by: string;
  granted_at: Date | string;
  revoked_by: string | null;
  revoked_at: Date | string | null;
  note: string | null;
}

interface SystemRow extends DbRow {
  id: string;
  tenant_id: string;
  grant_id: string;
  source_id: string;
  system_key: string;
  external_id: string;
  display_name: string;
  description: string | null;
  capability_classes: string[];
  capabilities: SystemCapability[];
  data_categories: string[];
  health: string;
  connection_status: string;
  why_it_matters: WhyItMatters;
  evidence_observation_ids: string[];
  discovered_by: string;
  discovered_at: Date | string;
  last_observed_at: Date | string | null;
  updated_at: Date | string;
}

interface RecommendationRow extends DbRow {
  id: string;
  tenant_id: string;
  system_id: string;
  system_key: string;
  batch_id: string | null;
  status: string;
  score: number;
  connection_mode: string;
  why_it_matters: WhyItMatters;
  scope_impact: ScopeImpact;
  proposed_by: string;
  proposed_at: Date | string;
  decided_at: Date | string | null;
  connected_at: Date | string | null;
  updated_at: Date | string;
}

interface BatchRow extends DbRow {
  id: string;
  tenant_id: string;
  action_request_id: string | null;
  status: string;
  recommendation_count: number;
  submitted_by: string;
  submitted_at: Date | string;
  decided_at: Date | string | null;
  updated_at: Date | string;
}

interface VerificationRow extends DbRow {
  id: string;
  tenant_id: string;
  system_id: string;
  recommendation_id: string;
  status: string;
  results: VerificationProbeResult[];
  promised_count: number;
  verified_count: number;
  transport_wired: boolean;
  verified_at: Date | string | null;
  created_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return iso(value)!;
}

function mapGrant(row: GrantRow): DiscoveryGrant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceId: row.source_id,
    status: row.status as DiscoveryGrant['status'],
    grantedBy: row.granted_by,
    grantedAt: isoRequired(row.granted_at),
    revokedBy: row.revoked_by,
    revokedAt: iso(row.revoked_at),
    note: row.note,
  };
}

function mapSystem(row: SystemRow): InventorySystem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    grantId: row.grant_id,
    sourceId: row.source_id,
    systemKey: row.system_key,
    externalId: row.external_id,
    displayName: row.display_name,
    description: row.description,
    capabilityClasses: row.capability_classes,
    capabilities: row.capabilities,
    dataCategories: row.data_categories,
    health: row.health as InventorySystem['health'],
    connectionStatus: row.connection_status as InventorySystem['connectionStatus'],
    whyItMatters: row.why_it_matters,
    evidenceObservationIds: row.evidence_observation_ids,
    discoveredBy: row.discovered_by,
    discoveredAt: isoRequired(row.discovered_at),
    lastObservedAt: iso(row.last_observed_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapRecommendation(row: RecommendationRow): Recommendation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    systemId: row.system_id,
    systemKey: row.system_key,
    batchId: row.batch_id,
    status: row.status as Recommendation['status'],
    score: row.score,
    connectionMode: 'read-only',
    whyItMatters: row.why_it_matters,
    scopeImpact: row.scope_impact,
    proposedBy: row.proposed_by,
    proposedAt: isoRequired(row.proposed_at),
    decidedAt: iso(row.decided_at),
    connectedAt: iso(row.connected_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapBatch(row: BatchRow): RecommendationBatch {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actionRequestId: row.action_request_id,
    status: row.status as RecommendationBatch['status'],
    recommendationCount: row.recommendation_count,
    submittedBy: row.submitted_by,
    submittedAt: isoRequired(row.submitted_at),
    decidedAt: iso(row.decided_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapVerification(row: VerificationRow): VerificationRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    systemId: row.system_id,
    recommendationId: row.recommendation_id,
    status: row.status as VerificationRun['status'],
    results: row.results,
    promisedCount: row.promised_count,
    verifiedCount: row.verified_count,
    transportWired: row.transport_wired,
    verifiedAt: iso(row.verified_at),
    createdAt: isoRequired(row.created_at),
  };
}

/** `id IN ($2, $3, …)` placeholder list (portable across both db drivers). */
function inPlaceholders(ids: readonly string[], startIndex: number): { sql: string; params: string[] } {
  const params: string[] = [];
  const placeholders = ids.map((id) => {
    params.push(id);
    return `$${startIndex + params.length}`;
  });
  return { sql: placeholders.join(', '), params };
}

// ---------------------------------------------------------------------------
// Discovery grants (the admin gate — the ONLY authorization to discover)
// ---------------------------------------------------------------------------

export async function grantDiscoverySource(
  ctx: TenantContext,
  input: GrantDiscoverySourceInput,
): Promise<GrantDiscoverySourceResult> {
  assertIntegrationTenantContext(ctx);
  if (!ctx.authority.includes(INTEGRATION_AUTHORITY_ADMINISTER)) {
    throw new IntegrationError(
      'forbidden',
      `granting discovery sources requires the '${INTEGRATION_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateGrantDiscoverySourceInput(input);

  // The source must exist in THIS tenant (the sources contract's uniform
  // cross-tenant not-found discipline applies — a foreign source id is
  // indistinguishable from a missing one).
  await getSource(ctx, valid.sourceId);

  const at = now();
  return getDb().transaction(async (tx) => {
    const existing = await tx.query<GrantRow>(
      `SELECT * FROM integration_discovery_grants
         WHERE tenant_id = $1 AND source_id = $2`,
      [ctx.tenantId, valid.sourceId],
    );
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) {
      // Re-granting is the RE-AUTHORIZATION path: the grant reactivates
      // with a fresh grant trail; a first revocation's history is
      // preserved in the audit log, not on this row (the authority-policy
      // precedent: updatable management controls, not append-only evidence).
      const updated = await tx.query<GrantRow>(
        `UPDATE integration_discovery_grants SET
           status = 'active', granted_by = $3, granted_at = $4,
           revoked_by = NULL, revoked_at = NULL, note = $5
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [ctx.tenantId, existingRow.id, ctx.principalId, at, valid.note],
      );
      return { grant: mapGrant(updated.rows[0]!), created: false };
    }
    const inserted = await tx.query<GrantRow>(
      `INSERT INTO integration_discovery_grants (
         tenant_id, source_id, status, granted_by, granted_at, note
       ) VALUES ($1, $2, 'active', $3, $4, $5)
       RETURNING *`,
      [ctx.tenantId, valid.sourceId, ctx.principalId, at, valid.note],
    );
    return { grant: mapGrant(inserted.rows[0]!), created: true };
  });
}

export async function revokeDiscoverySource(
  ctx: TenantContext,
  input: RevokeDiscoverySourceInput,
): Promise<DiscoveryGrant> {
  assertIntegrationTenantContext(ctx);
  if (!ctx.authority.includes(INTEGRATION_AUTHORITY_ADMINISTER)) {
    throw new IntegrationError(
      'forbidden',
      `revoking discovery sources requires the '${INTEGRATION_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateRevokeDiscoverySourceInput(input);
  const result = await getDb().query<GrantRow>(
    `UPDATE integration_discovery_grants SET
       status = 'revoked', revoked_by = $3, revoked_at = $4, updated_at = $4
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     RETURNING *`,
    [ctx.tenantId, valid.grantId, ctx.principalId, now()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Uniform not-found: a foreign/missing grant and an already-revoked
    // one are both reported through the load path (idempotent revocation).
    const current = await getDb().query<GrantRow>(
      `SELECT * FROM integration_discovery_grants WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.grantId],
    );
    const existing = current.rows[0];
    if (existing === undefined) {
      throw new IntegrationError(
        'discovery_grant_not_found',
        `no discovery grant '${valid.grantId}' exists in this tenant`,
      );
    }
    return mapGrant(existing);
  }
  return mapGrant(row);
}

export async function getDiscoveryGrant(
  ctx: TenantContext,
  query: GetDiscoveryGrantQuery,
): Promise<DiscoveryGrant> {
  assertIntegrationTenantContext(ctx);
  const valid = validateGetDiscoveryGrantQuery(query);
  return loadGrant(ctx, valid.grantId);
}

export async function listDiscoveryGrants(
  ctx: TenantContext,
  query: ListDiscoveryGrantsQuery,
): Promise<DiscoveryGrant[]> {
  assertIntegrationTenantContext(ctx);
  const valid = validateListDiscoveryGrantsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<GrantRow>(
    `SELECT * FROM integration_discovery_grants WHERE ${conditions.join(' AND ')}
       ORDER BY granted_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapGrant);
}

async function loadGrant(ctx: TenantContext, grantId: string): Promise<DiscoveryGrant> {
  const rows = await getDb().query<GrantRow>(
    `SELECT * FROM integration_discovery_grants WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, grantId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new IntegrationError(
      'discovery_grant_not_found',
      `no discovery grant '${grantId}' exists in this tenant`,
    );
  }
  return mapGrant(row);
}

// ---------------------------------------------------------------------------
// Discovery — the no-scan-gated authorized survey
// ---------------------------------------------------------------------------

export async function runDiscovery(
  ctx: TenantContext,
  input: RunDiscoveryInput,
): Promise<DiscoveryRunResult> {
  assertIntegrationTenantContext(ctx);
  const valid = validateRunDiscoveryInput(input);

  // THE NO-SCAN GATE: resolve the grant(s) FIRST. An un-granted,
  // cross-tenant or revoked source is refused here — before a single byte
  // of transport I/O can happen. This is the invariant the work item
  // demands ("no uncontrolled network scanning") and the test asserts by
  // counting transport fetches.
  let grants: DiscoveryGrant[];
  if (valid.sourceId !== null) {
    const rows = await getDb().query<GrantRow>(
      `SELECT * FROM integration_discovery_grants
         WHERE tenant_id = $1 AND source_id = $2 AND status = 'active'`,
      [ctx.tenantId, valid.sourceId],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw new IntegrationError(
        'discovery_not_authorized',
        `source '${valid.sourceId}' has no active discovery grant in this tenant — discovery happens only through admin-granted sources`,
      );
    }
    grants = [mapGrant(row)];
  } else {
    const rows = await getDb().query<GrantRow>(
      `SELECT * FROM integration_discovery_grants
         WHERE tenant_id = $1 AND status = 'active'
         ORDER BY granted_at ASC, id ASC`,
      [ctx.tenantId],
    );
    grants = rows.rows.map(mapGrant);
  }

  if (grants.length === 0) {
    return { runs: [] };
  }

  // The org context every explanation is grounded in — read ONCE per run
  // through the contracts (goals W008, unknowns W007, gaps W017). Pure
  // inputs to a pure function; nothing here participates in authority.
  const orgContext = await loadExplanationOrgContext(ctx);

  const runs: DiscoverySourceRun[] = [];
  for (const grant of grants) {
    runs.push(await discoverThroughGrant(ctx, grant, valid.maxRecords, orgContext));
  }
  return { runs };
}

async function discoverThroughGrant(
  ctx: TenantContext,
  grant: DiscoveryGrant,
  maxRecords: number,
  orgContext: ExplanationOrgContext,
): Promise<DiscoverySourceRun> {
  // The ONLY fetch path: the sources module's authenticated polling
  // transport, over the granted source's own credentials (opaque
  // credentialRef — never seen here). Provider outages surface as the
  // sources module's canonical errors.
  const poll = await pollSource(ctx, { sourceId: grant.sourceId, maxRecords });

  const run: DiscoverySourceRun = {
    grantId: grant.id,
    sourceId: grant.sourceId,
    fetched: poll.fetched,
    ingested: poll.ingested,
    duplicates: poll.duplicates,
    ignored: 0,
    systemsCreated: 0,
    systemsUpdated: 0,
    recommendationsCreated: 0,
  };

  for (const ingested of poll.observations) {
    // Directory records became immutable observations (W004) — the
    // evidence every inventory row cites. Read the payload back through
    // the observations contract (tenant-scoped, tenant-visible).
    const observation = await getObservation(ctx, ingested.observationId);
    const manifest = classifyDirectoryRecord({
      kind: observation.kind,
      payload: observation.payload,
    });
    if (manifest === null) {
      run.ignored += 1;
      continue;
    }
    const created = await upsertDiscoveredSystem(ctx, grant, manifest, observation.id, orgContext);
    if (created) {
      run.systemsCreated += 1;
    } else {
      run.systemsUpdated += 1;
    }
    if (await proposeRecommendationIfAbsent(ctx, manifest, grant, orgContext)) {
      run.recommendationsCreated += 1;
    }
  }
  return run;
}

/** Upserts one discovered system; returns true when the system was created. */
async function upsertDiscoveredSystem(
  ctx: TenantContext,
  grant: DiscoveryGrant,
  manifest: DiscoveredSystemManifest,
  observationId: string,
  orgContext: ExplanationOrgContext,
): Promise<boolean> {
  const db = getDb();
  const systemKey = systemKeyOf(grant.sourceId, manifest.externalId);
  const capabilities = deriveCapabilitySurface(manifest.capabilityClasses);
  const explanation = explainWhyItMatters(manifest, orgContext);
  const at = now();

  const existing = await db.query<{ id: string; health: string; evidence_observation_ids: string[] }>(
    `SELECT id, health, evidence_observation_ids FROM integration_systems
       WHERE tenant_id = $1 AND system_key = $2`,
    [ctx.tenantId, systemKey],
  );
  const existingRow = existing.rows[0];

  if (existingRow === undefined) {
    await db.query(
      `INSERT INTO integration_systems (
         tenant_id, grant_id, source_id, system_key, external_id, display_name,
         description, capability_classes, capabilities, data_categories, health,
         connection_status, why_it_matters, evidence_observation_ids,
         discovered_by, discovered_at, last_observed_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11,
         'discovered', $12::jsonb, $13::jsonb, $14, $15, $15, $15
       )`,
      [
        ctx.tenantId,
        grant.id,
        grant.sourceId,
        systemKey,
        manifest.externalId,
        manifest.displayName,
        manifest.description,
        JSON.stringify(manifest.capabilityClasses),
        JSON.stringify(capabilities),
        JSON.stringify(manifest.dataCategories),
        manifest.health,
        JSON.stringify(explanation),
        JSON.stringify([observationId]),
        ctx.principalId,
        at,
      ],
    );
    return true;
  }

  // Latest directory evidence wins, EXCEPT health: an explicit directory
  // health statement (healthy/degraded/unreachable) applies, while
  // 'unknown' never overwrites a verification-derived health value.
  const nextHealth: SystemHealth =
    manifest.health === 'unknown'
      ? (existingRow.health as SystemHealth)
      : manifest.health;
  const evidence = [observationId, ...existingRow.evidence_observation_ids].slice(
    0,
    MAX_EVIDENCE_OBSERVATIONS,
  );
  await db.query(
    `UPDATE integration_systems SET
       display_name = $3, description = $4, capability_classes = $5::jsonb,
       capabilities = $6::jsonb, data_categories = $7::jsonb, health = $8,
       why_it_matters = $9::jsonb, evidence_observation_ids = $10::jsonb,
       last_observed_at = $11, updated_at = $11
     WHERE tenant_id = $1 AND id = $2`,
    [
      ctx.tenantId,
      existingRow.id,
      manifest.displayName,
      manifest.description,
      JSON.stringify(manifest.capabilityClasses),
      JSON.stringify(capabilities),
      JSON.stringify(manifest.dataCategories),
      nextHealth,
      JSON.stringify(explanation),
      JSON.stringify(evidence),
      at,
    ],
  );
  return false;
}

/**
 * Creates the safe-by-default recommendation for a freshly observed system
 * when (and only when) it carries no live recommendation — a rejected
 * proposal is a standing human decision and is never re-proposed
 * automatically. Returns true when a recommendation was created.
 */
async function proposeRecommendationIfAbsent(
  ctx: TenantContext,
  manifest: DiscoveredSystemManifest,
  grant: DiscoveryGrant,
  orgContext: ExplanationOrgContext,
): Promise<boolean> {
  const db = getDb();
  const systemKey = systemKeyOf(grant.sourceId, manifest.externalId);
  const systemRows = await db.query<{ id: string }>(
    `SELECT id FROM integration_systems WHERE tenant_id = $1 AND system_key = $2`,
    [ctx.tenantId, systemKey],
  );
  const systemId = systemRows.rows[0]?.id;
  if (systemId === undefined) return false; // defensive — upsert ran first

  // The status list is a compile-time module constant — literal interpolation
  // is safe here (no caller input reaches this statement).
  const live = await db.query<{ id: string }>(
    `SELECT id FROM integration_recommendations
       WHERE tenant_id = $1 AND system_id = $2
         AND status IN ('proposed', 'pending_approval', 'approved', 'connected')`,
    [ctx.tenantId, systemId],
  );
  if (live.rows.length > 0) return false;

  const draft = buildRecommendationDraft(manifest, orgContext);
  await db.query(
    `INSERT INTO integration_recommendations (
       tenant_id, system_id, system_key, status, score, connection_mode,
       why_it_matters, scope_impact, proposed_by, proposed_at, updated_at
     ) VALUES ($1, $2, $3, 'proposed', $4, 'read-only', $5::jsonb, $6::jsonb, $7, $8, $8)`,
    [
      ctx.tenantId,
      systemId,
      systemKey,
      draft.score,
      JSON.stringify(draft.whyItMatters),
      JSON.stringify(draft.scopeImpact),
      ctx.principalId,
      now(),
    ],
  );
  return true;
}

/**
 * Loads the org context explanations are grounded in, through the public
 * contracts only: active goals (W008), open unknowns (W007) and capability
 * gaps (W017 — the non-covered ones). All read-only; sibling errors
 * propagate honestly.
 */
async function loadExplanationOrgContext(ctx: TenantContext): Promise<ExplanationOrgContext> {
  const [goals, unknowns, gaps] = await Promise.all([
    listGoals(ctx, { status: 'active', limit: 500 }),
    listUnknowns(ctx, { status: 'open', limit: 500 }),
    analyzeGaps(ctx, { limit: 500 }),
  ]);
  return {
    goals: goals.map((goal) => ({
      id: goal.id,
      title: goal.content.title,
      text: `${goal.content.objective} ${goal.content.desiredState}`,
    })),
    unknowns: unknowns.map((unknown) => ({
      id: unknown.id,
      question: unknown.question,
      text: unknown.consequence,
    })),
    gaps: gaps
      .filter((gap) => gap.status !== 'covered')
      .map((gap) => ({
        capabilityId: gap.capability.id,
        capabilityName: gap.capability.name,
      })),
  };
}

// ---------------------------------------------------------------------------
// Tool & System Inventory reads
// ---------------------------------------------------------------------------

export async function getSystem(ctx: TenantContext, query: GetSystemQuery): Promise<InventorySystem> {
  assertIntegrationTenantContext(ctx);
  const valid = validateGetSystemQuery(query);
  return loadSystem(ctx, valid.systemId);
}

export async function listSystems(
  ctx: TenantContext,
  query: ListSystemsQuery,
): Promise<InventorySystem[]> {
  assertIntegrationTenantContext(ctx);
  const valid = validateListSystemsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.connectionStatus !== null) {
    params.push(valid.connectionStatus);
    conditions.push(`connection_status = $${params.length}`);
  }
  if (valid.health !== null) {
    params.push(valid.health);
    conditions.push(`health = $${params.length}`);
  }
  if (valid.capabilityClass !== null) {
    params.push(JSON.stringify([valid.capabilityClass]));
    conditions.push(`capability_classes @> $${params.length}::jsonb`);
  }
  if (valid.dataCategory !== null) {
    params.push(JSON.stringify([valid.dataCategory]));
    conditions.push(`data_categories @> $${params.length}::jsonb`);
  }
  if (valid.search !== null) {
    params.push(`%${valid.search}%`);
    conditions.push(`display_name ILIKE $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<SystemRow>(
    `SELECT * FROM integration_systems WHERE ${conditions.join(' AND ')}
       ORDER BY discovered_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapSystem);
}

async function loadSystem(ctx: TenantContext, systemId: string): Promise<InventorySystem> {
  const rows = await getDb().query<SystemRow>(
    `SELECT * FROM integration_systems WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, systemId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new IntegrationError(
      'system_not_found',
      `no inventory system '${systemId}' exists in this tenant`,
    );
  }
  return mapSystem(row);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export async function getRecommendation(
  ctx: TenantContext,
  query: GetRecommendationQuery,
): Promise<Recommendation> {
  assertIntegrationTenantContext(ctx);
  const valid = validateGetRecommendationQuery(query);
  return loadRecommendation(ctx, valid.recommendationId);
}

export async function listRecommendations(
  ctx: TenantContext,
  query: ListRecommendationsQuery,
): Promise<Recommendation[]> {
  assertIntegrationTenantContext(ctx);
  const valid = validateListRecommendationsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.systemId !== null) {
    params.push(valid.systemId);
    conditions.push(`system_id = $${params.length}`);
  }
  if (valid.batchId !== null) {
    params.push(valid.batchId);
    conditions.push(`batch_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<RecommendationRow>(
    `SELECT * FROM integration_recommendations WHERE ${conditions.join(' AND ')}
       ORDER BY score DESC, system_key ASC, id ASC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapRecommendation);
}

async function loadRecommendation(
  ctx: TenantContext,
  recommendationId: string,
): Promise<Recommendation> {
  const rows = await getDb().query<RecommendationRow>(
    `SELECT * FROM integration_recommendations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, recommendationId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new IntegrationError(
      'recommendation_not_found',
      `no recommendation '${recommendationId}' exists in this tenant`,
    );
  }
  return mapRecommendation(row);
}

// ---------------------------------------------------------------------------
// Batches — bulk approval through the actions authority (W009)
// ---------------------------------------------------------------------------

export async function submitRecommendationBatch(
  ctx: TenantContext,
  input: SubmitBatchInput,
): Promise<RecommendationBatch> {
  assertIntegrationTenantContext(ctx);
  const valid = validateSubmitBatchInput(input);

  // Load every recommendation in one tenant-scoped pass; every id must
  // exist (uniform not-found) and be 'proposed' (a live proposal that has
  // not been gated yet — resubmission of decided/batched proposals is a
  // status conflict, the goals module's surgical-transition discipline).
  const { sql: inList, params: idParams } = inPlaceholders(valid.recommendationIds, 2);
  const rows = await getDb().query<RecommendationRow>(
    `SELECT * FROM integration_recommendations
       WHERE tenant_id = $1 AND id IN (${inList})`,
    [ctx.tenantId, ...idParams],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  for (const id of valid.recommendationIds) {
    const row = byId.get(id);
    if (row === undefined) {
      throw new IntegrationError(
        'recommendation_not_found',
        `no recommendation '${id}' exists in this tenant`,
      );
    }
    if (row.status !== 'proposed') {
      throw new IntegrationError(
        'recommendation_status_conflict',
        `recommendation '${id}' is '${row.status}' — only proposed recommendations can be submitted for approval`,
      );
    }
  }

  // The approver-facing payload: exactly what a human is approving, per
  // recommendation — the outcome-oriented explanation and the explicit
  // scope impact (§10: outcomes and scope, never provider mechanics).
  const systemIds = [...new Set([...byId.values()].map((row) => row.system_id))];
  const { sql: systemIn, params: systemParams } = inPlaceholders(systemIds, 2);
  const systemRows = await getDb().query<SystemRow>(
    `SELECT * FROM integration_systems WHERE tenant_id = $1 AND id IN (${systemIn})`,
    [ctx.tenantId, ...systemParams],
  );
  const systemNames = new Map(systemRows.rows.map((row) => [row.id, row.display_name]));

  const batchId = newId();
  const payload = {
    batchId,
    actionKind: INTEGRATION_ACTION_KIND,
    connectionMode: 'read-only',
    recommendations: valid.recommendationIds.map((id) => {
      const row = byId.get(id)!;
      return {
        recommendationId: row.id,
        systemId: row.system_id,
        systemKey: row.system_key,
        displayName: systemNames.get(row.system_id) ?? row.system_key,
        whyItMatters: row.why_it_matters.summary,
        scopeImpact: row.scope_impact,
        score: row.score,
      };
    }),
  };
  const names = payload.recommendations.map((entry) => entry.displayName);
  const justification =
    valid.justification ??
    `Connect ${valid.recommendationIds.length} discovered system(s) read-only: ${names.join(', ')}`;

  // The W009 gate FIRST: the action request must exist before any
  // recommendation may sit in a gated state. The batch id doubles as the
  // idempotency key, so a retried submission replays the original request
  // instead of duplicating gate history.
  const request = await authorizeAction(ctx, {
    actionKind: INTEGRATION_ACTION_KIND,
    authorityLevel: 'EXECUTE',
    payload,
    justification,
    idempotencyKey: `${BATCH_IDEMPOTENCY_PREFIX}${batchId}`,
  });

  const status = batchStatusForRequestStatus(request.status);
  const at = now();
  // A policy-decided request (auto-allowed / auto-forbidden) carries its
  // own decidedAt — mirror that, not our clock.
  const decidedAt = request.status === 'pending' ? null : request.decidedAt ?? at;
  // Re-generate the IN list for THIS statement's placeholder numbering
  // ($1..$5 are fixed; the ids follow).
  const { sql: updateIn, params: updateIds } = inPlaceholders(valid.recommendationIds, 6);
  return getDb().transaction(async (tx) => {
    const inserted = await tx.query<BatchRow>(
      `INSERT INTO integration_recommendation_batches (
         id, tenant_id, action_request_id, status, recommendation_count,
         submitted_by, submitted_at, decided_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)
       RETURNING *`,
      [
        batchId,
        ctx.tenantId,
        request.id,
        status,
        valid.recommendationIds.length,
        ctx.principalId,
        at,
        decidedAt,
      ],
    );
    await tx.query(
      `UPDATE integration_recommendations SET
         batch_id = $2, status = $3, decided_at = $4, updated_at = $5
       WHERE tenant_id = $1 AND id IN (${updateIn})`,
      [
        ctx.tenantId,
        batchId,
        recommendationStatusForRequestStatus(request.status),
        decidedAt,
        at,
        ...updateIds,
      ],
    );
    return mapBatch(inserted.rows[0]!);
  });
}

export async function decideRecommendationBatch(
  ctx: TenantContext,
  input: DecideBatchInput,
): Promise<RecommendationBatch> {
  assertIntegrationTenantContext(ctx);
  const valid = validateDecideBatchInput(input);

  const existingRows = await getDb().query<BatchRow>(
    `SELECT * FROM integration_recommendation_batches WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.batchId],
  );
  const existing = existingRows.rows[0];
  if (existing === undefined) {
    throw new IntegrationError(
      'batch_not_found',
      `no recommendation batch '${valid.batchId}' exists in this tenant`,
    );
  }
  if (existing.status !== 'pending_approval' || existing.action_request_id === null) {
    throw new IntegrationError(
      'batch_not_pending',
      `recommendation batch '${valid.batchId}' is '${existing.status}' — only a pending batch can be decided`,
    );
  }

  let request;
  try {
    // The human decision itself flows through the actions contract: the
    // approve claim, the separation of duties (the requester never decides
    // its own request) and first-decision-wins are enforced THERE (W009).
    request = await decideApproval(ctx, {
      requestId: existing.action_request_id,
      decision: valid.decision,
      note: valid.note,
    });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'not_pending') {
      // Crash-recovery sync: the request was already decided (a prior
      // decide succeeded but our state update was interrupted, or another
      // approver won the race). Re-read the authoritative request state
      // and sync this batch onto it — first decision wins, always.
      request = await getActionRequest(ctx, { requestId: existing.action_request_id });
      if (request.status === 'pending') throw error;
    } else {
      throw error;
    }
  }

  return syncBatchState(ctx, valid.batchId, existing.action_request_id, request.status);
}

/** Mirrors a decided action-request status onto the batch + its recommendations. */
async function syncBatchState(
  ctx: TenantContext,
  batchId: string,
  actionRequestId: string,
  requestStatus: string,
): Promise<RecommendationBatch> {
  const status = batchStatusForRequestStatus(requestStatus);
  const at = now();
  return getDb().transaction(async (tx) => {
    const updated = await tx.query<BatchRow>(
      `UPDATE integration_recommendation_batches SET
         status = $3, decided_at = $4, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending_approval'
       RETURNING *`,
      [ctx.tenantId, batchId, status, at],
    );
    const row = updated.rows[0];
    if (row !== undefined) {
      await tx.query(
        `UPDATE integration_recommendations SET
           status = $3, decided_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND batch_id = $2 AND status = 'pending_approval'`,
        [ctx.tenantId, batchId, recommendationStatusForRequestStatus(requestStatus), at],
      );
      return mapBatch(row);
    }
    // Someone else synced first — return the current state.
    const current = await tx.query<BatchRow>(
      `SELECT * FROM integration_recommendation_batches WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, batchId],
    );
    return mapBatch(current.rows[0]!);
  });
}

export async function getRecommendationBatch(
  ctx: TenantContext,
  query: GetRecommendationBatchQuery,
): Promise<RecommendationBatch> {
  assertIntegrationTenantContext(ctx);
  const valid = validateGetRecommendationBatchQuery(query);
  const rows = await getDb().query<BatchRow>(
    `SELECT * FROM integration_recommendation_batches WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.batchId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new IntegrationError(
      'batch_not_found',
      `no recommendation batch '${valid.batchId}' exists in this tenant`,
    );
  }
  return mapBatch(row);
}

export async function listRecommendationBatches(
  ctx: TenantContext,
  query: ListRecommendationBatchesQuery,
): Promise<RecommendationBatch[]> {
  assertIntegrationTenantContext(ctx);
  const valid = validateListRecommendationBatchesQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<BatchRow>(
    `SELECT * FROM integration_recommendation_batches WHERE ${conditions.join(' AND ')}
       ORDER BY submitted_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapBatch);
}

function batchStatusForRequestStatus(requestStatus: string): RecommendationBatch['status'] {
  switch (requestStatus) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending_approval';
  }
}

function recommendationStatusForRequestStatus(
  requestStatus: string,
): Recommendation['status'] {
  switch (requestStatus) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending_approval';
  }
}

// ---------------------------------------------------------------------------
// Connection + automatic verification
// ---------------------------------------------------------------------------

export async function connectSystem(
  ctx: TenantContext,
  input: ConnectSystemInput,
): Promise<ConnectSystemResult> {
  assertIntegrationTenantContext(ctx);
  const valid = validateConnectSystemInput(input);

  const recommendationRows = await getDb().query<RecommendationRow>(
    `SELECT * FROM integration_recommendations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.recommendationId],
  );
  const recommendationRow = recommendationRows.rows[0];
  if (recommendationRow === undefined) {
    throw new IntegrationError(
      'recommendation_not_found',
      `no recommendation '${valid.recommendationId}' exists in this tenant`,
    );
  }
  if (recommendationRow.status !== 'approved') {
    throw new IntegrationError(
      'recommendation_status_conflict',
      `recommendation '${valid.recommendationId}' is '${recommendationRow.status}' — only an approved recommendation can be connected`,
    );
  }

  const at = now();
  const transitioned = await getDb().transaction(async (tx) => {
    // Guarded transition: only an APPROVED recommendation moves (the
    // sources module's NULL-guard discipline — a concurrent connector
    // loses the race and surfaces the conflict honestly).
    const updated = await tx.query<RecommendationRow>(
      `UPDATE integration_recommendations SET
         status = 'connected', connected_at = $3, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'approved'
       RETURNING *`,
      [ctx.tenantId, valid.recommendationId, at],
    );
    const row = updated.rows[0];
    if (row === undefined) return null;
    await tx.query(
      `UPDATE integration_systems SET connection_status = 'connected', updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, row.system_id, at],
    );
    return row;
  });
  if (transitioned === null) {
    throw new IntegrationError(
      'recommendation_status_conflict',
      `recommendation '${valid.recommendationId}' is no longer approved (concurrent transition)`,
    );
  }

  // AUTOMATIC VERIFICATION: connection records, for every promised read
  // capability, whether it actually verified reachable — no further human
  // action required (§11: approve → automatic authentication → automatic
  // verification).
  const system = await loadSystem(ctx, transitioned.system_id);
  const verification = await executeVerification(ctx, system, mapRecommendation(transitioned));
  const refreshed = await loadSystem(ctx, transitioned.system_id);
  return {
    recommendation: mapRecommendation(transitioned),
    system: refreshed,
    verification,
  };
}

export async function verifySystem(
  ctx: TenantContext,
  input: VerifySystemInput,
): Promise<VerificationRun> {
  assertIntegrationTenantContext(ctx);
  const valid = validateVerifySystemInput(input);

  const system = await loadSystem(ctx, valid.systemId);
  if (system.connectionStatus !== 'connected') {
    throw new IntegrationError(
      'system_not_connected',
      `system '${valid.systemId}' is '${system.connectionStatus}' — verification is post-connection`,
    );
  }

  // The most recent connected recommendation of this system carries the
  // currently promised capability surface.
  const rows = await getDb().query<RecommendationRow>(
    `SELECT * FROM integration_recommendations
       WHERE tenant_id = $1 AND system_id = $2 AND status = 'connected'
       ORDER BY connected_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, valid.systemId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new IntegrationError(
      'recommendation_not_found',
      `connected system '${valid.systemId}' has no connected recommendation (internal invariant violation)`,
    );
  }

  // Explicit verification refuses without a wired transport — never a
  // fake success and never another meaningless pending row (the sources
  // module's provider_unavailable discipline).
  if (getVerificationTransport() === null) {
    throw new IntegrationError(
      'verification_unavailable',
      'no verification transport is wired — connect-time verification records a pending run; explicit verification requires a transport',
    );
  }
  return executeVerification(ctx, system, mapRecommendation(row));
}

export async function listVerificationRuns(
  ctx: TenantContext,
  query: ListVerificationRunsQuery,
): Promise<VerificationRun[]> {
  assertIntegrationTenantContext(ctx);
  const valid = validateListVerificationRunsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.systemId !== null) {
    params.push(valid.systemId);
    conditions.push(`system_id = $${params.length}`);
  }
  if (valid.recommendationId !== null) {
    params.push(valid.recommendationId);
    conditions.push(`recommendation_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<VerificationRow>(
    `SELECT * FROM integration_verification_runs WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapVerification);
}

/**
 * Runs the capability probes for one connected recommendation's promised
 * (read) capabilities and records the verification run. With no transport
 * wired the run is recorded `pending` — honest, never a fake success.
 */
async function executeVerification(
  ctx: TenantContext,
  system: InventorySystem,
  recommendation: Recommendation,
): Promise<VerificationRun> {
  const transport = getVerificationTransport();
  const promised = recommendation.scopeImpact.wouldRead;

  if (transport === null || promised.length === 0) {
    if (transport === null) {
      const run = await insertVerificationRun(ctx, system.id, recommendation.id, {
        status: 'pending',
        results: promised.map((capability) => ({
          capabilityKey: capability.key,
          outcome: 'pending' as const,
          detail: null,
        })),
        promisedCount: promised.length,
        verifiedCount: 0,
        transportWired: false,
        verifiedAt: null,
      });
      return run;
    }
    // A recommendation always promises ≥ 1 read capability (every registry
    // class carries one); zero promised is defensive only.
    const run = await insertVerificationRun(ctx, system.id, recommendation.id, {
      status: 'verified',
      results: [],
      promisedCount: 0,
      verifiedCount: 0,
      transportWired: true,
      verifiedAt: now(),
    });
    return run;
  }

  const results: VerificationProbeResult[] = [];
  for (const capability of promised) {
    const request: CapabilityProbeRequest = {
      systemId: system.id,
      systemKey: system.systemKey,
      displayName: system.displayName,
      capabilityKey: capability.key,
      capabilityLabel: capability.label,
      dataCategories: [...capability.dataCategories],
    };
    let probe: CapabilityProbeResult;
    try {
      probe = await transport.probe(request);
    } catch (error) {
      // A failed probe is not a failed connection: the capability simply
      // did not VERIFY reachable, and the detail says why.
      probe = {
        reachable: false,
        detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    results.push({
      capabilityKey: capability.key,
      outcome: probe.reachable ? 'verified' : 'unreachable',
      detail: probe.detail ?? null,
    });
  }
  const verifiedCount = results.filter((result) => result.outcome === 'verified').length;
  const status: VerificationStatus =
    verifiedCount === promised.length
      ? 'verified'
      : verifiedCount > 0
        ? 'partial'
        : 'failed';

  const run = await insertVerificationRun(ctx, system.id, recommendation.id, {
    status,
    results,
    promisedCount: promised.length,
    verifiedCount,
    transportWired: true,
    verifiedAt: now(),
  });

  // Health is verification-derived (latest evidence wins): all reachable
  // → healthy, some → degraded, none → unreachable.
  const health: SystemHealth =
    status === 'verified' ? 'healthy' : status === 'partial' ? 'degraded' : 'unreachable';
  await getDb().query(
    `UPDATE integration_systems SET health = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, system.id, health, now()],
  );
  return run;
}

async function insertVerificationRun(
  ctx: TenantContext,
  systemId: string,
  recommendationId: string,
  run: {
    status: VerificationStatus;
    results: VerificationProbeResult[];
    promisedCount: number;
    verifiedCount: number;
    transportWired: boolean;
    verifiedAt: Date | null;
  },
): Promise<VerificationRun> {
  const createdAt = now();
  const rows = await getDb().query<VerificationRow>(
    `INSERT INTO integration_verification_runs (
       tenant_id, system_id, recommendation_id, status, results,
       promised_count, verified_count, transport_wired, verified_at, created_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      ctx.tenantId,
      systemId,
      recommendationId,
      run.status,
      JSON.stringify(run.results),
      run.promisedCount,
      run.verifiedCount,
      run.transportWired,
      run.verifiedAt,
      createdAt,
    ],
  );
  return mapVerification(rows.rows[0]!);
}
