// Implementation of the agent-body module's public operations (see
// contract.ts).
//
// W133 — "Separate persistent Aurum Agent Body from the LLM that
// possesses it." The two sides of that separation live in two tables and
// NEVER touch each other on the swap path:
//
//   * body lifecycle (create/get/list/update/retire) — the persistent,
//     model-agnostic side. Identity (role) is immutable; the update
//     surface has no role key; the lifecycle is one-way active → retired.
//   * binding attachments (attach/detach/history/active) — the possession
//     side, an append-only audit log.
//
// THE SWAP PATH (attachModelBinding) is the work item's acceptance core:
// appending a new attachment and superseding the prior active one (same
// purpose) happen in ONE transaction, under a FOR UPDATE row lock on the
// body, and the agent_bodies row is NOT part of the transaction's writes —
// no UPDATE, no `updated_at` bump. A model swap therefore preserves the
// body byte-for-byte, including `updatedAt`: it must not even LOOK like a
// body edit (test-locked).
//
// THE WB3 COMPOSITION WIRING (the recorded TL ruling, delivered): the
// storage layer keeps `bindingId` OPAQUE — append-only audit evidence that
// must survive fabric-side supersession — but the SERVICE composition
// boundary existence-gates every FRESH attachment against the
// provider-fabric (W132) operational read API, on the BASE connection
// BEFORE the append transaction opens (the W134 transaction law: never
// query inside an open transaction). The gate is EXISTENCE, not activity:
// a since-superseded fabric binding is exactly the audit evidence a fresh
// attachment may legitimately reference; historical rows are never
// re-validated.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); semantic timestamps come from the injectable
// clock and are never caller-supplied — EXCEPT `policyCheck.checkedAt`,
// which is part of the VERBATIM upstream payload this layer records, never
// re-minted; principals (`createdBy`, `attachedBy`) are system-captured
// from the explicit TenantContext; every statement is scoped by tenant
// (ADR-0001) — cross-tenant access is indistinguishable from missing
// records (uniform `body_not_found`, no existence leak).
//
// Concurrency hardening: every mutation runs inside a single transaction
// that takes a FOR UPDATE row lock on the body first. That lock serializes
// (a) role-uniqueness races on create (plus the UNIQUE constraint mapped
// to the typed `body_role_taken`), (b) swap-vs-swap and swap-vs-detach
// races on the same body, and (c) the monotonic per-body `position`
// allocation. The partial UNIQUE index (one active attachment per
// (tenant, body, purpose)) is the structural backstop.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { AgentBodyError } from './errors';
import {
  assertAgentBodyTenantContext,
  isAttachablePolicyOutcome,
  validateAttachModelBindingInput,
  validateCreateAgentBodyInput,
  validateDetachModelBindingInput,
  validateGetActiveBindingQuery,
  validateGetAgentBodyQuery,
  validateGetBodyBindingsQuery,
  validateListAgentBodiesQuery,
  validateRetireAgentBodyInput,
  validateUpdateAgentBodyInput,
} from './validation';
import type {
  ValidatedAttachModelBindingInput,
  ValidatedCreateAgentBodyInput,
  ValidatedDetachModelBindingInput,
  ValidatedGetActiveBindingQuery,
  ValidatedGetAgentBodyQuery,
  ValidatedGetBodyBindingsQuery,
  ValidatedListAgentBodiesQuery,
  ValidatedRetireAgentBodyInput,
  ValidatedUpdateAgentBodyInput,
} from './validation';
import type {
  AgentBody,
  AgentBodyHookRef,
  AttachModelBindingInput,
  BodyModelBinding,
  CreateAgentBodyInput,
  DetachModelBindingInput,
  GetActiveBindingQuery,
  GetAgentBodyQuery,
  GetBodyBindingsQuery,
  ListAgentBodiesQuery,
  PolicyCheckPayload,
  RetireAgentBodyInput,
  UpdateAgentBodyInput,
} from './types';
import type { ModelBindingPurpose } from '@/modules/provider-fabric/contract';
import { listModelBindings, MAX_LIST_LIMIT } from '@/modules/provider-fabric/contract';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface AgentBodyRow extends DbRow {
  id: string;
  tenant_id: string;
  role: string;
  label: string;
  description: string | null;
  communication_behavior: Record<string, unknown> | null;
  information_acquisition_behavior: Record<string, unknown> | null;
  company_context_access: Record<string, unknown> | null;
  memory_policy: Record<string, unknown> | null;
  escalation_behavior: Record<string, unknown> | null;
  permitted_capabilities: string[];
  evidence_hooks: AgentBodyHookRef[];
  learning_hooks: AgentBodyHookRef[];
  status: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  retired_at: Date | string | null;
}

interface BodyBindingRow extends DbRow {
  id: string;
  tenant_id: string;
  body_id: string;
  binding_id: string;
  purpose: string;
  policy_check: PolicyCheckPayload;
  status: string;
  position: number;
  attached_by: string;
  attached_at: Date | string;
  superseded_at: Date | string | null;
  detached_at: Date | string | null;
  detach_reason: string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapBody(row: AgentBodyRow): AgentBody {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    role: row.role,
    label: row.label,
    description: row.description,
    communicationBehavior: row.communication_behavior,
    informationAcquisitionBehavior: row.information_acquisition_behavior,
    companyContextAccess: row.company_context_access,
    memoryPolicy: row.memory_policy,
    escalationBehavior: row.escalation_behavior,
    permittedCapabilities: row.permitted_capabilities ?? [],
    evidenceHooks: row.evidence_hooks ?? [],
    learningHooks: row.learning_hooks ?? [],
    status: row.status as AgentBody['status'],
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
  };
}

function mapBinding(row: BodyBindingRow): BodyModelBinding {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bodyId: row.body_id,
    bindingId: row.binding_id,
    purpose: row.purpose as ModelBindingPurpose,
    policyCheck: row.policy_check,
    status: row.status as BodyModelBinding['status'],
    position: Number(row.position),
    attachedBy: row.attached_by,
    attachedAt: toIso(row.attached_at),
    supersededAt: row.superseded_at === null ? null : toIso(row.superseded_at),
    detachedAt: row.detached_at === null ? null : toIso(row.detached_at),
    detachReason: row.detach_reason,
  };
}

/** PostgreSQL unique-violation (23505) from either db backend. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * A §1 descriptor as a jsonb parameter: SQL NULL when "not stated" (the
 * honest absence — never a JSON 'null' literal, which the schema's CHECK
 * correctly refuses as neither object nor absent), the serialized object
 * otherwise.
 */
function descriptorParam(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

/**
 * The tenant-scoped body lookup with the uniform not-found discipline:
 * a foreign id and a missing id are indistinguishable (`body_not_found`).
 * `FOR UPDATE` when the caller is about to mutate (the concurrency
 * hardening — see the header note).
 */
async function findBodyRow(
  db: Queryable,
  ctx: TenantContext,
  bodyId: string,
  forUpdate: boolean,
): Promise<AgentBodyRow | null> {
  const result = await db.query<AgentBodyRow>(
    `SELECT * FROM agent_bodies WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, bodyId],
  );
  return result.rows[0] ?? null;
}

/**
 * The WB3 composition gate: a FRESH attachment's `bindingId` must EXIST in
 * the tenant's provider-fabric registry. Checked through the fabric's
 * operational read API (its contract — the only legal cross-module import)
 * on the BASE connection, before the caller opens its append transaction.
 *
 * EXISTENCE, not activity: the registry read spans BOTH statuses, so a
 * since-superseded fabric binding passes (the opacity ruling — attachments
 * are audit evidence that survives fabric-side supersession). And
 * existence only: which fabric purpose the binding was minted under is the
 * fabric's own semantics; this layer records the reference verbatim either
 * way (a recorded open design question for the TL, not silently tightened
 * here).
 *
 * Read-window honesty: the fabric's operational API has no by-id read; its
 * list surface is bounded (MAX_LIST_LIMIT, newest first). A tenant holding
 * more fabric bindings than that bound makes older ids unresolvable through
 * the operational API — such an attachment is refused conservatively,
 * never fabricated (noted in WORK-NOTES.md; a fabric-side by-id read would
 * close it).
 */
async function requireFabricBindingExists(
  ctx: TenantContext,
  bindingId: string,
): Promise<void> {
  const registry = await listModelBindings(ctx, { limit: MAX_LIST_LIMIT });
  if (!registry.some((binding) => binding.bindingId === bindingId)) {
    throw new AgentBodyError(
      'fabric_binding_not_found',
      `binding '${bindingId}' does not exist in this tenant's provider-fabric registry — attach the binding through the provider-fabric service first (a fresh body attachment must reference an existing fabric binding; superseded fabric bindings qualify — historical attachments are never re-validated)`,
    );
  }
}

// ---------------------------------------------------------------------------
// createAgentBody / getAgentBody / listAgentBodies
// ---------------------------------------------------------------------------

export async function createAgentBody(
  ctx: TenantContext,
  input: CreateAgentBodyInput,
): Promise<AgentBody> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedCreateAgentBodyInput = validateCreateAgentBodyInput(input);
  const db = getDb();

  // The friendly pre-check keeps the common path's error message precise;
  // the UNIQUE constraint (mapped below) is the truth under races.
  const existing = await db.query<AgentBodyRow>(
    `SELECT * FROM agent_bodies WHERE tenant_id = $1 AND role = $2`,
    [ctx.tenantId, valid.role],
  );
  if (existing.rows.length > 0) {
    throw new AgentBodyError(
      'body_role_taken',
      `role '${valid.role}' is already taken by a body in this tenant`,
    );
  }

  const stampedAt = now();
  try {
    const result = await db.query<AgentBodyRow>(
      `INSERT INTO agent_bodies
         (tenant_id, role, label, description,
          communication_behavior, information_acquisition_behavior,
          company_context_access, memory_policy, escalation_behavior,
          permitted_capabilities, evidence_hooks, learning_hooks,
          status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
               $10, $11::jsonb, $12::jsonb, 'active', $13, $14, $15)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.role,
        valid.label,
        valid.description,
        descriptorParam(valid.communicationBehavior),
        descriptorParam(valid.informationAcquisitionBehavior),
        descriptorParam(valid.companyContextAccess),
        descriptorParam(valid.memoryPolicy),
        descriptorParam(valid.escalationBehavior),
        valid.permittedCapabilities,
        JSON.stringify(valid.evidenceHooks),
        JSON.stringify(valid.learningHooks),
        ctx.principalId,
        stampedAt,
        stampedAt,
      ],
    );
    return mapBody(result.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AgentBodyError(
        'body_role_taken',
        `role '${valid.role}' is already taken by a body in this tenant`,
      );
    }
    throw error;
  }
}

export async function getAgentBody(
  ctx: TenantContext,
  query: GetAgentBodyQuery,
): Promise<AgentBody> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedGetAgentBodyQuery = validateGetAgentBodyQuery(query);
  const row = await findBodyRow(getDb(), ctx, valid.bodyId, false);
  if (row === null) {
    throw new AgentBodyError(
      'body_not_found',
      `no body '${valid.bodyId}' exists in this tenant`,
    );
  }
  return mapBody(row);
}

export async function listAgentBodies(
  ctx: TenantContext,
  query?: ListAgentBodiesQuery,
): Promise<AgentBody[]> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedListAgentBodiesQuery = validateListAgentBodiesQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT * FROM agent_bodies WHERE tenant_id = $1`;
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY role ASC LIMIT $${params.length}`;
  const rows = await getDb().query<AgentBodyRow>(sql, params);
  return rows.rows.map(mapBody);
}

// ---------------------------------------------------------------------------
// updateAgentBody / retireAgentBody
// ---------------------------------------------------------------------------

export async function updateAgentBody(
  ctx: TenantContext,
  input: UpdateAgentBodyInput,
): Promise<AgentBody> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedUpdateAgentBodyInput = validateUpdateAgentBodyInput(input);
  const db = getDb();

  return db.transaction(async (tx) => {
    const row = await findBodyRow(tx, ctx, valid.bodyId, true);
    if (row === null) {
      throw new AgentBodyError(
        'body_not_found',
        `no body '${valid.bodyId}' exists in this tenant`,
      );
    }
    if (row.status !== 'active') {
      throw new AgentBodyError(
        'body_retired',
        `body '${valid.bodyId}' is retired — the lifecycle is one-way and a retired body no longer accepts edits`,
      );
    }

    // Partial semantics: `undefined` stays unchanged; the SQL SET list is
    // built only from the fields the caller actually sent. There is no
    // role fragment anywhere — identity is immutable.
    const sets: string[] = ['updated_at = $2'];
    const params: unknown[] = [ctx.tenantId, now()];
    const add = (fragment: string, value: unknown): void => {
      params.push(value);
      sets.push(fragment.replace('$#', `$${params.length}`));
    };
    if (valid.label !== undefined) add('label = $#', valid.label);
    if (valid.description !== undefined) add('description = $#', valid.description);
    if (valid.communicationBehavior !== undefined) {
      add('communication_behavior = $#::jsonb', descriptorParam(valid.communicationBehavior));
    }
    if (valid.informationAcquisitionBehavior !== undefined) {
      add('information_acquisition_behavior = $#::jsonb', descriptorParam(valid.informationAcquisitionBehavior));
    }
    if (valid.companyContextAccess !== undefined) {
      add('company_context_access = $#::jsonb', descriptorParam(valid.companyContextAccess));
    }
    if (valid.memoryPolicy !== undefined) {
      add('memory_policy = $#::jsonb', descriptorParam(valid.memoryPolicy));
    }
    if (valid.escalationBehavior !== undefined) {
      add('escalation_behavior = $#::jsonb', descriptorParam(valid.escalationBehavior));
    }
    if (valid.permittedCapabilities !== undefined) {
      add('permitted_capabilities = $#', valid.permittedCapabilities);
    }
    if (valid.evidenceHooks !== undefined) {
      add('evidence_hooks = $#::jsonb', JSON.stringify(valid.evidenceHooks));
    }
    if (valid.learningHooks !== undefined) {
      add('learning_hooks = $#::jsonb', JSON.stringify(valid.learningHooks));
    }
    params.push(valid.bodyId);

    const updated = await tx.query<AgentBodyRow>(
      `UPDATE agent_bodies SET ${sets.join(', ')}
         WHERE tenant_id = $1 AND id = $${params.length}
         RETURNING *`,
      params,
    );
    return mapBody(updated.rows[0]!);
  });
}

export async function retireAgentBody(
  ctx: TenantContext,
  input: RetireAgentBodyInput,
): Promise<AgentBody> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedRetireAgentBodyInput = validateRetireAgentBodyInput(input);
  const db = getDb();

  return db.transaction(async (tx) => {
    const row = await findBodyRow(tx, ctx, valid.bodyId, true);
    if (row === null) {
      throw new AgentBodyError(
        'body_not_found',
        `no body '${valid.bodyId}' exists in this tenant`,
      );
    }
    if (row.status !== 'active') {
      throw new AgentBodyError(
        'body_retired',
        `body '${valid.bodyId}' is already retired — the lifecycle is one-way`,
      );
    }
    // The binding attachment history is deliberately left untouched: it is
    // append-only evidence about what POSSESSED the body, and retiring the
    // body is recorded on the body (see WORK-NOTES.md).
    const updated = await tx.query<AgentBodyRow>(
      `UPDATE agent_bodies
         SET status = 'retired', retired_at = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
      [ctx.tenantId, valid.bodyId, now(), now()],
    );
    return mapBody(updated.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// attachModelBinding — THE SWAP PATH
// ---------------------------------------------------------------------------

export async function attachModelBinding(
  ctx: TenantContext,
  input: AttachModelBindingInput,
): Promise<BodyModelBinding> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedAttachModelBindingInput = validateAttachModelBindingInput(input);
  const db = getDb();

  // (0) The composition gates, BOTH on the BASE connection BEFORE the
  // append transaction opens (the W134 transaction law — never query
  // inside an open transaction):
  //   (a) a friendly tenant-scoped body pre-check so a foreign or missing
  //       body rejects with the uniform `body_not_found` FIRST — before
  //       any fabric query can say anything (ADR-0001: no existence leak;
  //       the authoritative re-check under the FOR UPDATE lock below is
  //       unchanged);
  //   (b) the WB3 fabric-registry existence gate — a FRESH attachment
  //       must reference a binding that exists in the tenant's
  //       provider-fabric registry (EXISTENCE, not activity — a
  //       since-superseded fabric binding qualifies).
  const bodyRow = await findBodyRow(db, ctx, valid.bodyId, false);
  if (bodyRow === null) {
    throw new AgentBodyError(
      'body_not_found',
      `no body '${valid.bodyId}' exists in this tenant`,
    );
  }
  await requireFabricBindingExists(ctx, valid.bindingId);

  return db.transaction(async (tx) => {
    // (1) Serialize on the body row. The lock orders concurrent swaps and
    // detaches on the same body and makes the position allocation below
    // monotonic. A foreign/missing body is uniformly `body_not_found`.
    const body = await findBodyRow(tx, ctx, valid.bodyId, true);
    if (body === null) {
      throw new AgentBodyError(
        'body_not_found',
        `no body '${valid.bodyId}' exists in this tenant`,
      );
    }
    if (body.status !== 'active') {
      throw new AgentBodyError(
        'body_retired',
        `body '${valid.bodyId}' is retired — a retired body no longer accepts model bindings`,
      );
    }

    // (2) The recorded policy ruling: only a 'compatible' verdict may
    // activate. 'incompatible' AND 'unknown' both refuse the attachment
    // outright — nothing is appended, and this layer never fabricates a
    // friendlier verdict (recorded as reversible at TL discretion).
    if (!isAttachablePolicyOutcome(valid.policyCheck.outcome)) {
      throw new AgentBodyError(
        'policy_check_failed',
        `the policy check verdict '${valid.policyCheck.outcome}' refuses the attachment of binding '${valid.bindingId}' (purpose '${valid.purpose}'): only a 'compatible' verdict may activate — basis: ${valid.policyCheck.basis}`,
      );
    }

    // (3) The current active attachment for this purpose, if any.
    const active = await tx.query<BodyBindingRow>(
      `SELECT * FROM agent_body_model_bindings
         WHERE tenant_id = $1 AND body_id = $2 AND purpose = $3 AND status = 'active'`,
      [ctx.tenantId, valid.bodyId, valid.purpose],
    );
    const prior = active.rows[0] ?? null;
    if (prior !== null && prior.binding_id === valid.bindingId) {
      // A no-op swap would only pollute the audit history with an
      // attachment identical to the one it supersedes.
      throw new AgentBodyError(
        'invalid_binding_input',
        `binding '${valid.bindingId}' is already the active '${valid.purpose}' attachment of this body`,
      );
    }

    // (4) Monotonic per-body position (safe under the body row lock; the
    // UNIQUE (tenant, body, position) index is the structural backstop).
    const next = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM agent_body_model_bindings
         WHERE tenant_id = $1 AND body_id = $2`,
      [ctx.tenantId, valid.bodyId],
    );
    const position = Number(next.rows[0]!.next);
    const stampedAt = now();

    // (5) Supersede the prior active attachment IN THE SAME TRANSACTION.
    // This is the only UPDATE the binding history ever accepts (the
    // trigger enforces the one-way active → superseded transition).
    if (prior !== null) {
      await tx.query(
        `UPDATE agent_body_model_bindings
           SET status = 'superseded', superseded_at = $4
           WHERE tenant_id = $1 AND body_id = $2 AND id = $3`,
        [ctx.tenantId, valid.bodyId, prior.id, stampedAt],
      );
    }

    // (6) Append the new active attachment. The agent_bodies row is NOT
    // touched — no UPDATE, no updated_at bump: a model swap must not even
    // look like a body edit (test-locked byte-for-byte).
    const appended = await tx.query<BodyBindingRow>(
      `INSERT INTO agent_body_model_bindings
         (tenant_id, body_id, binding_id, purpose, policy_check,
          status, position, attached_by, attached_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'active', $6, $7, $8)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.bodyId,
        valid.bindingId,
        valid.purpose,
        JSON.stringify(valid.policyCheck),
        position,
        ctx.principalId,
        stampedAt,
      ],
    );
    return mapBinding(appended.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// detachModelBinding / getBodyBindings / getActiveBinding
// ---------------------------------------------------------------------------

export async function detachModelBinding(
  ctx: TenantContext,
  input: DetachModelBindingInput,
): Promise<BodyModelBinding> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedDetachModelBindingInput = validateDetachModelBindingInput(input);
  const db = getDb();

  return db.transaction(async (tx) => {
    // Serialize on the body row (swap-vs-detach races). A RETIRED body
    // still accepts detachments: the attachment history is append-only
    // audit evidence, and completing it is not a body edit (a retired body
    // merely never accepts NEW possessions — see WORK-NOTES.md).
    const body = await findBodyRow(tx, ctx, valid.bodyId, true);
    if (body === null) {
      throw new AgentBodyError(
        'body_not_found',
        `no body '${valid.bodyId}' exists in this tenant`,
      );
    }

    const active = await tx.query<BodyBindingRow>(
      `SELECT * FROM agent_body_model_bindings
         WHERE tenant_id = $1 AND body_id = $2 AND purpose = $3 AND status = 'active'`,
      [ctx.tenantId, valid.bodyId, valid.purpose],
    );
    const current = active.rows[0] ?? null;
    if (current === null) {
      // Distinguish the two honest absences: never attached at all vs.
      // history that ended in superseded/detached.
      const any = await tx.query<BodyBindingRow>(
        `SELECT * FROM agent_body_model_bindings
           WHERE tenant_id = $1 AND body_id = $2 AND purpose = $3
           LIMIT 1`,
        [ctx.tenantId, valid.bodyId, valid.purpose],
      );
      if (any.rows.length === 0) {
        throw new AgentBodyError(
          'binding_not_found',
          `no '${valid.purpose}' binding attachment exists for body '${valid.bodyId}'`,
        );
      }
      throw new AgentBodyError(
        'binding_inactive',
        `the '${valid.purpose}' binding history of body '${valid.bodyId}' has no active attachment to detach`,
      );
    }

    const updated = await tx.query<BodyBindingRow>(
      `UPDATE agent_body_model_bindings
         SET status = 'detached', detached_at = $4, detach_reason = $5
         WHERE tenant_id = $1 AND body_id = $2 AND id = $3
         RETURNING *`,
      [ctx.tenantId, valid.bodyId, current.id, now(), valid.reason],
    );
    return mapBinding(updated.rows[0]!);
  });
}

export async function getBodyBindings(
  ctx: TenantContext,
  query: GetBodyBindingsQuery,
): Promise<BodyModelBinding[]> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedGetBodyBindingsQuery = validateGetBodyBindingsQuery(query);
  const db = getDb();

  // The body existence check is tenant-scoped: a foreign body id is
  // uniformly `body_not_found` (no existence leak).
  const body = await findBodyRow(db, ctx, valid.bodyId, false);
  if (body === null) {
    throw new AgentBodyError(
      'body_not_found',
      `no body '${valid.bodyId}' exists in this tenant`,
    );
  }

  const params: unknown[] = [ctx.tenantId, valid.bodyId];
  let sql = `SELECT * FROM agent_body_model_bindings WHERE tenant_id = $1 AND body_id = $2`;
  if (valid.purpose !== null) {
    params.push(valid.purpose);
    sql += ` AND purpose = $${params.length}`;
  }
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(valid.limit);
  // Deterministic history order: the monotonic per-body position.
  sql += ` ORDER BY position ASC LIMIT $${params.length}`;
  const rows = await db.query<BodyBindingRow>(sql, params);
  return rows.rows.map(mapBinding);
}

export async function getActiveBinding(
  ctx: TenantContext,
  query: GetActiveBindingQuery,
): Promise<BodyModelBinding | null> {
  assertAgentBodyTenantContext(ctx);
  const valid: ValidatedGetActiveBindingQuery = validateGetActiveBindingQuery(query);
  const db = getDb();

  const body = await findBodyRow(db, ctx, valid.bodyId, false);
  if (body === null) {
    throw new AgentBodyError(
      'body_not_found',
      `no body '${valid.bodyId}' exists in this tenant`,
    );
  }

  const rows = await db.query<BodyBindingRow>(
    `SELECT * FROM agent_body_model_bindings
       WHERE tenant_id = $1 AND body_id = $2 AND purpose = $3 AND status = 'active'
       LIMIT 1`,
    [ctx.tenantId, valid.bodyId, valid.purpose],
  );
  return rows.rows[0] === undefined ? null : mapBinding(rows.rows[0]);
}
