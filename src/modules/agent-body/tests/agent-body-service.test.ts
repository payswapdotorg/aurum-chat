// Integration tests for the agent-body module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W133
// acceptance (spec/work-items/WORK-ITEM-CATALOG.md §W133:
// "model swap preserves tenant/company/evidence/memory identity; bindings
// are explicit, auditable and policy compatible"):
//
//   * THE CORE ACCEPTANCE — create a body with the full §1 policy
//     payload, attach a cognition binding, then attach a DIFFERENT
//     binding (the swap): the body equals the original BYTE-FOR-BYTE
//     INCLUDING updatedAt (a swap must not even look like a body edit —
//     proven with the service clock pinned forward across the swap), and
//     the history shows both attachments (old superseded, new active);
//   * EXPLICIT + AUDITABLE BINDINGS — append-only attachment history with
//     monotonic per-body positions, one active attachment per
//     (tenant, body, purpose), verbatim policy-check payloads, and the
//     one-way active → superseded | detached lifecycle;
//   * POLICY COMPATIBLE — an 'incompatible' verdict REFUSES the
//     attachment (typed policy_check_failed, nothing appended), and so
//     does an 'unknown' verdict (the honesty ruling: an unverified
//     compatibility can never activate);
//   * TENANT ISOLATION (ADR-0001) — two tenants keep fully independent
//     bodies and binding histories: the same role may exist in both,
//     foreign body ids are uniformly body_not_found, and a swap in one
//     tenant never reaches the other's active binding or history;
//   * STORAGE-LEVEL LAW — the triggers reject DELETE/TRUNCATE and every
//     UPDATE except the one-way lifecycle transition, identity columns
//     are immutable, role rewrites and body deletes are refused, and a
//     direct INSERT of a second active same-purpose row violates the
//     partial unique index.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

import {
  AgentBodyError,
  attachModelBinding,
  createAgentBody,
  detachModelBinding,
  getActiveBinding,
  getAgentBody,
  getBodyBindings,
  listAgentBodies,
  retireAgentBody,
  updateAgentBody,
} from '../contract';
import type {
  AgentBody,
  AgentBodyErrorCode,
  PolicyCheckOutcome,
  PolicyCheckPayload,
} from '../contract';

// Deterministic service-clock pins (the injectable clock discipline —
// same-millisecond writes must not decide what a proof shows).
const T0 = '2026-10-06T10:00:00.000Z';
const T1 = '2026-10-06T11:00:00.000Z';
const T2 = '2026-10-06T12:00:00.000Z';
const T3 = '2026-10-06T13:00:00.000Z';

function pinClock(at: string): () => void {
  const realNow = systemClock.now;
  systemClock.now = () => new Date(at);
  return () => {
    systemClock.now = realNow;
  };
}

function member(tenantId: string, principalId = newId()): TenantContext {
  return { tenantId, principalId, authority: [] };
}

function policyCheck(
  outcome: PolicyCheckOutcome,
  overrides: Partial<PolicyCheckPayload> = {},
): PolicyCheckPayload {
  return {
    outcome,
    basis: 'tenant provider policy v3: openai + anthropic allowed for this purpose',
    checkedBy: 'system:policy-engine',
    checkedAt: '2026-10-06T09:00:00.000Z',
    ...overrides,
  };
}

/** The full §1 payload: every policy descriptor stated, hooks attached. */
function fullBodyInput(role: string) {
  return {
    role,
    label: `${role} body`,
    description: 'The full §1 payload: every policy descriptor stated.',
    communicationBehavior: { tone: 'concise', languages: ['en', 'ja'], clarifies: 'before-acting' },
    informationAcquisitionBehavior: { askBeforeSearching: true, maxSourcesPerQuery: 5 },
    companyContextAccess: { surfaces: ['support-tickets', 'meetings'], readOnly: true },
    memoryPolicy: { retentionDays: 180, shareAcrossConversations: true },
    escalationBehavior: { escalateTo: 'human', afterFailedAttempts: 2 },
    permittedCapabilities: ['company-query:run', 'goals:read'],
    evidenceHooks: [
      { registry: 'observation', ref: newId() },
      { registry: 'epistemics', ref: newId() },
    ],
    learningHooks: [{ registry: 'learning', ref: newId() }],
  };
}

async function expectErrorCode(code: AgentBodyErrorCode, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentBodyError);
    expect((error as AgentBodyError).code).toBe(code);
  }
}

const tenantA = newId();
const tenantB = newId();
const principalA = newId();
const principalB = newId();

// Fabric binding ids — OPAQUE references by design: these tests never
// parse them, only store and compare them verbatim.
const FABRIC_COGNITION_1 = `fabric-binding-${newId()}`;
const FABRIC_COGNITION_2 = `fabric-binding-${newId()}`;
const FABRIC_COGNITION_3 = `fabric-binding-${newId()}`;
const FABRIC_CONVERSATION_1 = `fabric-binding-${newId()}`;
const FABRIC_CONVERSATION_2 = `fabric-binding-${newId()}`;
const FABRIC_B_COGNITION = `fabric-binding-${newId()}`;

let bodyA1: AgentBody; // the full-payload body — the core-acceptance body
let bodyA2: AgentBody; // the lifecycle body
let bodyA3: AgentBody; // the history body
let bodyB1: AgentBody; // tenant B's body (same role as A's — tenant-scoped)

beforeAll(async () => {
  await runMigrations(getDb());

  const restore = pinClock(T0);
  try {
    bodyA1 = await createAgentBody(member(tenantA, principalA), fullBodyInput('ride-agent'));
    bodyA2 = await createAgentBody(member(tenantA, principalA), {
      role: 'support-triage',
      label: 'Support triage body',
    });
    bodyB1 = await createAgentBody(member(tenantB, principalB), fullBodyInput('ride-agent'));
  } finally {
    restore();
  }
  const restore3 = pinClock(T1);
  try {
    bodyA3 = await createAgentBody(member(tenantA, principalA), {
      role: 'history-probe',
      label: 'History probe body',
    });
  } finally {
    restore3();
  }
});

afterAll(async () => {
  await closeDb();
});

describe('W133 agent-body — the persistent body', () => {
  it('creates a body with the full §1 policy payload and round-trips it verbatim', async () => {
    const body = await getAgentBody(member(tenantA, principalA), { bodyId: bodyA1.id });
    expect(body.id).toBe(bodyA1.id);
    expect(body.tenantId).toBe(tenantA);
    expect(body.role).toBe('ride-agent');
    expect(body.label).toBe('ride-agent body');
    expect(body.description).toBe('The full §1 payload: every policy descriptor stated.');
    // The five §1 descriptors, stored as honest plain JSON, verbatim.
    expect(body.communicationBehavior).toEqual({
      tone: 'concise',
      languages: ['en', 'ja'],
      clarifies: 'before-acting',
    });
    expect(body.informationAcquisitionBehavior).toEqual({
      askBeforeSearching: true,
      maxSourcesPerQuery: 5,
    });
    expect(body.companyContextAccess).toEqual({
      surfaces: ['support-tickets', 'meetings'],
      readOnly: true,
    });
    expect(body.memoryPolicy).toEqual({ retentionDays: 180, shareAcrossConversations: true });
    expect(body.escalationBehavior).toEqual({ escalateTo: 'human', afterFailedAttempts: 2 });
    expect(body.permittedCapabilities).toEqual(['company-query:run', 'goals:read']);
    expect(body.evidenceHooks).toHaveLength(2);
    expect(body.evidenceHooks[0]!.registry).toBe('observation');
    expect(body.learningHooks).toHaveLength(1);
    // System-stamped provenance, never caller-supplied.
    expect(body.createdBy).toBe(principalA);
    expect(body.createdAt).toBe(T0);
    expect(body.updatedAt).toBe(T0);
    expect(body.status).toBe('active');
    expect(body.retiredAt).toBeNull();
  });

  it('rejects a duplicate role in the SAME tenant (body_role_taken) — but the same role lives independently in another tenant', async () => {
    await expectErrorCode('body_role_taken', () =>
      createAgentBody(member(tenantA, principalA), {
        role: 'ride-agent',
        label: 'Impostor body',
      }),
    );
    // The tenant-scoped uniqueness proof: tenant B already owns the same
    // role, created in beforeAll, and both bodies coexist.
    const foreign = await getAgentBody(member(tenantB, principalB), { bodyId: bodyB1.id });
    expect(foreign.role).toBe('ride-agent');
    expect(foreign.tenantId).toBe(tenantB);
    expect(foreign.id).not.toBe(bodyA1.id);
  });

  it('reads a foreign body id as uniformly body_not_found (no existence leak)', async () => {
    await expectErrorCode('body_not_found', () =>
      getAgentBody(member(tenantB, principalB), { bodyId: bodyA1.id }),
    );
    await expectErrorCode('body_not_found', () =>
      getAgentBody(member(tenantA, principalA), { bodyId: newId() }),
    );
  });

  it('listAgentBodies takes a query object and stays tenant-scoped', async () => {
    const ownerA = member(tenantA, principalA);
    const activeInA = await listAgentBodies(ownerA, { status: 'active' });
    expect(activeInA.map((body) => body.role).sort()).toEqual([
      'history-probe',
      'ride-agent',
      'support-triage',
    ]);
    const retiredInA = await listAgentBodies(ownerA, { status: 'retired' });
    expect(retiredInA).toHaveLength(0);
    const limited = await listAgentBodies(ownerA, { limit: 1 });
    expect(limited).toHaveLength(1);
    const unfiltered = await listAgentBodies(ownerA);
    expect(unfiltered).toHaveLength(3);
    // Tenant B sees ONLY its own body.
    const inB = await listAgentBodies(member(tenantB, principalB), {});
    expect(inB.map((body) => body.id)).toEqual([bodyB1.id]);
  });

  it('updates the mutable controls and bumps updatedAt — but the role is immutable and untouched fields survive', async () => {
    const restore = pinClock(T1);
    try {
      const updated = await updateAgentBody(member(tenantA, principalA), {
        bodyId: bodyA2.id,
        label: 'Support triage body (revised)',
        memoryPolicy: { retentionDays: 30 },
        description: null,
      });
      expect(updated.label).toBe('Support triage body (revised)');
      expect(updated.memoryPolicy).toEqual({ retentionDays: 30 });
      expect(updated.description).toBeNull();
      expect(updated.role).toBe('support-triage');
      expect(updated.createdAt).toBe(T0);
      expect(updated.updatedAt).toBe(T1);
      // A caller that tries to smuggle the role into an update is refused
      // before anything is recorded.
      await expectErrorCode('invalid_body_input', () =>
        updateAgentBody(member(tenantA, principalA), {
          bodyId: bodyA2.id,
          role: 'renamed-agent',
          label: 'Rename attempt',
        } as unknown as Parameters<typeof updateAgentBody>[1]),
      );
      // An update with no mutable field at all is malformed, not recorded.
      await expectErrorCode('invalid_body_input', () =>
        updateAgentBody(member(tenantA, principalA), { bodyId: bodyA2.id }),
      );
      const reread = await getAgentBody(member(tenantA, principalA), { bodyId: bodyA2.id });
      expect(reread.role).toBe('support-triage');
      expect(reread.updatedAt).toBe(T1);
    } finally {
      restore();
    }
  });

  it('retires one-way: edits and new attachments are refused afterwards, but the history stays readable', async () => {
    const ownerA = member(tenantA, principalA);
    const restore = pinClock(T2);
    try {
      const retired = await retireAgentBody(ownerA, { bodyId: bodyA2.id });
      expect(retired.status).toBe('retired');
      expect(retired.retiredAt).toBe(T2);
      expect(retired.updatedAt).toBe(T2);

      await expectErrorCode('body_retired', () =>
        updateAgentBody(ownerA, { bodyId: bodyA2.id, label: 'Zombie edit' }),
      );
      await expectErrorCode('body_retired', () =>
        retireAgentBody(ownerA, { bodyId: bodyA2.id }),
      );
      await expectErrorCode('body_retired', () =>
        attachModelBinding(ownerA, {
          bodyId: bodyA2.id,
          bindingId: FABRIC_COGNITION_1,
          purpose: 'cognition',
          policyCheck: policyCheck('compatible'),
        }),
      );
      // The retired body stays readable and its (empty) history reachable.
      const stillThere = await getAgentBody(ownerA, { bodyId: bodyA2.id });
      expect(stillThere.status).toBe('retired');
      expect(await getBodyBindings(ownerA, { bodyId: bodyA2.id })).toEqual([]);
      // And the retired filter now finds it.
      const retiredList = await listAgentBodies(ownerA, { status: 'retired' });
      expect(retiredList.map((body) => body.id)).toEqual([bodyA2.id]);
    } finally {
      restore();
    }
  });
});

describe('W133 agent-body — model binding attachments', () => {
  const ownerA = member(tenantA, principalA);

  it('attaches the first binding as the active attachment (position 1, verbatim policy check)', async () => {
    const restore = pinClock(T1);
    try {
      const attached = await attachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        bindingId: FABRIC_COGNITION_1,
        purpose: 'cognition',
        policyCheck: policyCheck('compatible'),
      });
      expect(attached.status).toBe('active');
      expect(attached.position).toBe(1);
      expect(attached.bindingId).toBe(FABRIC_COGNITION_1);
      expect(attached.purpose).toBe('cognition');
      expect(attached.attachedBy).toBe(principalA);
      expect(attached.attachedAt).toBe(T1);
      expect(attached.supersededAt).toBeNull();
      expect(attached.detachedAt).toBeNull();
      // The verbatim payload: recorded exactly as supplied.
      expect(attached.policyCheck).toEqual(policyCheck('compatible'));
      const active = await getActiveBinding(ownerA, { bodyId: bodyA1.id, purpose: 'cognition' });
      expect(active!.id).toBe(attached.id);
    } finally {
      restore();
    }
  });

  it('THE CORE ACCEPTANCE — a model swap preserves the body byte-for-byte (including updatedAt) and supersedes the old attachment', async () => {
    // The body as it stands AFTER the first attachment: its updatedAt is
    // still the creation stamp (the first attach already did not touch
    // the body row).
    const before = await getAgentBody(ownerA, { bodyId: bodyA1.id });
    expect(before.updatedAt).toBe(T0);

    // The swap, with the service clock pinned FORWARD: even as time moves,
    // the body row must not change at all.
    const restore = pinClock(T2);
    try {
      const swapped = await attachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        bindingId: FABRIC_COGNITION_2,
        purpose: 'cognition',
        policyCheck: policyCheck('compatible', {
          basis: 'tenant provider policy v4: anthropic preferred for cognition',
          checkedAt: '2026-10-06T11:30:00.000Z',
        }),
      });
      expect(swapped.status).toBe('active');
      expect(swapped.bindingId).toBe(FABRIC_COGNITION_2);
      expect(swapped.position).toBe(2);

      // BYTE-FOR-BYTE: the swap must not even look like a body edit.
      const after = await getAgentBody(ownerA, { bodyId: bodyA1.id });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(after.updatedAt).toBe(T0); // explicitly: not even the timestamp moved

      // The history shows BOTH attachments: old superseded, new active.
      const history = await getBodyBindings(ownerA, { bodyId: bodyA1.id });
      expect(history).toHaveLength(2);
      const [oldBinding, newBinding] = history;
      expect(oldBinding!.status).toBe('superseded');
      expect(oldBinding!.bindingId).toBe(FABRIC_COGNITION_1);
      expect(oldBinding!.supersededAt).toBe(T2);
      expect(oldBinding!.position).toBe(1);
      expect(newBinding!.status).toBe('active');
      expect(newBinding!.bindingId).toBe(FABRIC_COGNITION_2);
      expect(newBinding!.supersededAt).toBeNull();
      expect(newBinding!.position).toBe(2);
      const active = await getActiveBinding(ownerA, { bodyId: bodyA1.id, purpose: 'cognition' });
      expect(active!.id).toBe(newBinding!.id);
    } finally {
      restore();
    }
  });

  it('keeps ONE active attachment per PURPOSE (a second purpose attaches alongside)', async () => {
    const restore = pinClock(T2);
    try {
      const conversation = await attachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        bindingId: FABRIC_CONVERSATION_1,
        purpose: 'conversation',
        policyCheck: policyCheck('compatible'),
      });
      expect(conversation.status).toBe('active');
      const cognition = await getActiveBinding(ownerA, {
        bodyId: bodyA1.id,
        purpose: 'cognition',
      });
      expect(cognition!.bindingId).toBe(FABRIC_COGNITION_2); // untouched by the other purpose
      expect(conversation.position).toBe(3); // per-body position: cognition 1, cognition 2, conversation 3
    } finally {
      restore();
    }
  });

  it("REFUSES an 'incompatible' policy verdict — typed policy_check_failed and NOTHING appended", async () => {
    await expectErrorCode('policy_check_failed', () =>
      attachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        bindingId: FABRIC_COGNITION_3,
        purpose: 'analysis',
        policyCheck: policyCheck('incompatible', {
          basis: 'tenant policy forbids analysis-grade models on this body',
        }),
      }),
    );
    // Nothing was appended: no analysis history, no active analysis binding.
    expect(await getBodyBindings(ownerA, { bodyId: bodyA1.id, purpose: 'analysis' })).toEqual([]);
    expect(await getActiveBinding(ownerA, { bodyId: bodyA1.id, purpose: 'analysis' })).toBeNull();
    // And the existing attachments are untouched.
    const history = await getBodyBindings(ownerA, { bodyId: bodyA1.id });
    expect(history).toHaveLength(3);
  });

  it("treats an 'unknown' verdict exactly as incompatible (an unverified compatibility never activates)", async () => {
    await expectErrorCode('policy_check_failed', () =>
      attachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        bindingId: FABRIC_COGNITION_3,
        purpose: 'analysis',
        policyCheck: policyCheck('unknown', { basis: 'policy engine unreachable' }),
      }),
    );
    expect(await getBodyBindings(ownerA, { bodyId: bodyA1.id, purpose: 'analysis' })).toEqual([]);
  });

  it('refuses re-attaching the binding that is ALREADY active for the purpose (no no-op swaps)', async () => {
    await expectErrorCode('invalid_binding_input', () =>
      attachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        bindingId: FABRIC_COGNITION_2,
        purpose: 'cognition',
        policyCheck: policyCheck('compatible'),
      }),
    );
    const history = await getBodyBindings(ownerA, { bodyId: bodyA1.id, purpose: 'cognition' });
    expect(history).toHaveLength(2); // unchanged: the refused attach appended nothing
  });

  it('detaches the active attachment with a recorded reason — and re-attachment works afterwards', async () => {
    const restore = pinClock(T3);
    try {
      const detached = await detachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        purpose: 'conversation',
        reason: 'tenant paused conversational possession pending policy review',
      });
      expect(detached.status).toBe('detached');
      expect(detached.detachedAt).toBe(T3);
      expect(detached.detachReason).toBe(
        'tenant paused conversational possession pending policy review',
      );
      expect(detached.supersededAt).toBeNull();
      expect(
        await getActiveBinding(ownerA, { bodyId: bodyA1.id, purpose: 'conversation' }),
      ).toBeNull();

      // Detaching again: history exists but nothing is active.
      await expectErrorCode('binding_inactive', () =>
        detachModelBinding(ownerA, {
          bodyId: bodyA1.id,
          purpose: 'conversation',
          reason: 'double detach',
        }),
      );
      // Detaching a purpose that was never attached: nothing exists at all.
      await expectErrorCode('binding_not_found', () =>
        detachModelBinding(ownerA, {
          bodyId: bodyA1.id,
          purpose: 'background',
          reason: 'never attached',
        }),
      );

      // A fresh attachment for the detached purpose re-activates it.
      const reattached = await attachModelBinding(ownerA, {
        bodyId: bodyA1.id,
        bindingId: FABRIC_CONVERSATION_2,
        purpose: 'conversation',
        policyCheck: policyCheck('compatible'),
      });
      expect(reattached.status).toBe('active');
      expect(reattached.position).toBe(4);
    } finally {
      restore();
    }
  });

  it('reads a foreign body id on the binding surface as uniformly body_not_found', async () => {
    await expectErrorCode('body_not_found', () =>
      getBodyBindings(member(tenantB, principalB), { bodyId: bodyA1.id }),
    );
    await expectErrorCode('body_not_found', () =>
      getActiveBinding(member(tenantB, principalB), {
        bodyId: bodyA1.id,
        purpose: 'cognition',
      }),
    );
  });

  it('keeps two tenants\' binding histories fully isolated — a swap in one never reaches the other', async () => {
    const ownerB = member(tenantB, principalB);
    const restore = pinClock(T1);
    try {
      const bAttached = await attachModelBinding(ownerB, {
        bodyId: bodyB1.id,
        bindingId: FABRIC_B_COGNITION,
        purpose: 'cognition',
        policyCheck: policyCheck('compatible', { checkedBy: 'tenant-b-policy-engine' }),
      });
      expect(bAttached.status).toBe('active');

      // Tenant A's history does not contain tenant B's attachment.
      const historyA = await getBodyBindings(ownerA, { bodyId: bodyA1.id });
      expect(historyA.map((binding) => binding.id)).not.toContain(bAttached.id);
      expect(historyA.every((binding) => binding.tenantId === tenantA)).toBe(true);

      // A swap in tenant A does not disturb tenant B's active binding.
      const restoreA = pinClock(T3);
      try {
        await attachModelBinding(ownerA, {
          bodyId: bodyA1.id,
          bindingId: FABRIC_COGNITION_3,
          purpose: 'cognition',
          policyCheck: policyCheck('compatible'),
        });
      } finally {
        restoreA();
      }
      const activeB = await getActiveBinding(ownerB, { bodyId: bodyB1.id, purpose: 'cognition' });
      expect(activeB!.id).toBe(bAttached.id);
      expect(activeB!.bindingId).toBe(FABRIC_B_COGNITION);
      const historyB = await getBodyBindings(ownerB, { bodyId: bodyB1.id });
      expect(historyB).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('enforces the append-only law at the STORAGE level (triggers + partial unique index)', async () => {
    // Rewriting an attachment's identity is rejected (the guard fires on
    // any UPDATE that is not the one-way lifecycle transition).
    await expect(
      getDb().query(
        `UPDATE agent_body_model_bindings SET binding_id = 'rewritten'
           WHERE tenant_id = $1 AND status = 'active'`,
        [tenantA],
      ),
    ).rejects.toThrowError(/append-only|one-way/);
    // Rewriting the verbatim policy check is rejected.
    await expect(
      getDb().query(
        `UPDATE agent_body_model_bindings SET policy_check = '{"outcome":"compatible"}'::jsonb
           WHERE tenant_id = $1 AND status = 'active'`,
        [tenantA],
      ),
    ).rejects.toThrowError(/append-only|one-way/);
    // Reviving a superseded attachment is rejected (one-way lifecycle).
    await expect(
      getDb().query(
        `UPDATE agent_body_model_bindings SET status = 'active'
           WHERE tenant_id = $1 AND status = 'superseded'`,
        [tenantA],
      ),
    ).rejects.toThrowError(/one-way/);
    // DELETE and TRUNCATE are rejected outright.
    await expect(
      getDb().query(`DELETE FROM agent_body_model_bindings WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrowError(/append-only/);
    await expect(
      getDb().query(`TRUNCATE agent_body_model_bindings`),
    ).rejects.toThrowError(/append-only/);
  });

  it('keeps exactly ONE active attachment per (tenant, body, purpose) — the partial unique index refuses a direct second INSERT', async () => {
    await expect(
      getDb().query(
        `INSERT INTO agent_body_model_bindings
           (tenant_id, body_id, binding_id, purpose, policy_check, status, position, attached_by, attached_at)
         VALUES ($1, $2, 'direct-insert-probe', 'cognition', '{}'::jsonb, 'active', 999, 'probe', now())`,
        [tenantA, bodyA1.id],
      ),
    ).rejects.toThrowError(/agent_body_bindings_one_active/);
  });

  it('guards the bodies at the STORAGE level too: role rewrites, deletes and truncates are refused', async () => {
    await expect(
      getDb().query(`UPDATE agent_bodies SET role = 'rewritten-role' WHERE tenant_id = $1`, [
        tenantA,
      ]),
    ).rejects.toThrowError(/immutable/);
    await expect(
      getDb().query(`DELETE FROM agent_bodies WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrowError(/lifecycle-managed/);
    await expect(getDb().query(`TRUNCATE agent_bodies`)).rejects.toThrowError(
      /lifecycle-managed/,
    );
  });

  it('builds a monotonic, deterministic history across a full lifecycle (attach → swap → swap → detach → attach)', async () => {
    const restore = pinClock(T1);
    try {
      await attachModelBinding(ownerA, {
        bodyId: bodyA3.id,
        bindingId: 'fabric-h-1',
        purpose: 'background',
        policyCheck: policyCheck('compatible'),
      });
      await attachModelBinding(ownerA, {
        bodyId: bodyA3.id,
        bindingId: 'fabric-h-2',
        purpose: 'background',
        policyCheck: policyCheck('compatible'),
      });
      await attachModelBinding(ownerA, {
        bodyId: bodyA3.id,
        bindingId: 'fabric-h-3',
        purpose: 'background',
        policyCheck: policyCheck('compatible'),
      });
      await detachModelBinding(ownerA, {
        bodyId: bodyA3.id,
        purpose: 'background',
        reason: 'probe sequence: detach before the final attach',
      });
      const final = await attachModelBinding(ownerA, {
        bodyId: bodyA3.id,
        bindingId: 'fabric-h-4',
        purpose: 'background',
        policyCheck: policyCheck('compatible'),
      });
      expect(final.position).toBe(4);

      const history = await getBodyBindings(ownerA, { bodyId: bodyA3.id });
      expect(history.map((binding) => binding.position)).toEqual([1, 2, 3, 4]);
      expect(history.map((binding) => binding.status)).toEqual([
        'superseded',
        'superseded',
        'detached',
        'active',
      ]);
      expect(history.map((binding) => binding.bindingId)).toEqual([
        'fabric-h-1',
        'fabric-h-2',
        'fabric-h-3',
        'fabric-h-4',
      ]);
      // The body itself was never touched by any of it.
      const body = await getAgentBody(ownerA, { bodyId: bodyA3.id });
      expect(body.updatedAt).toBe(T1);
    } finally {
      restore();
    }
  });
});
