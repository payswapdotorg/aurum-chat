// WB2 integration (2026-10-07) — Tenant Isolation Verification · sweep for
// the agent-body module (W133: the persistent Aurum Agent Body + model
// binding attachments).
//
// REAL two-tenant service proof in the W044 house style (the manifest v9
// registration): tenant A builds bodies and binding attachments through the
// public contract — with REAL provider-fabric-registered bindings (W132,
// the WB2 composition wiring existence-checks fresh attachments) — and
// tenant B must see none of it:
//
//   * empty-list invisibility — B's listAgentBodies is empty before it
//     creates its own state;
//   * uniform not-found — a FOREIGN body id and a MISSING body id reject
//     identically (`body_not_found`) on every read AND binding surface —
//     no existence leak (ADR-0001);
//   * same natural keys coexist per tenant — the tenant-unique role lives
//     independently in both tenants, and each tenant's binding histories
//     stay fully isolated (a swap in one never reaches the other's active
//     attachment or history);
//   * the fabric seam — both tenants connect their own provider
//     definitions and attach their own bindings; the binding ids the
//     bodies reference are the REAL fabric-minted ids, never fabricated.
//
// Scope rules honored here: agent-body code is imported ONLY through
// '@/modules/agent-body/contract'; the provider-fabric fixtures come
// through '@/modules/provider-fabric/contract' (the W132 seam, exercised
// as real records — never direct SQL writes).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

import {
  AgentBodyError,
  attachModelBinding,
  createAgentBody,
  getActiveBinding,
  getAgentBody,
  getBodyBindings,
  listAgentBodies,
} from '@/modules/agent-body/contract';
import type { AgentBodyErrorCode } from '@/modules/agent-body/contract';
import {
  attachModelBinding as attachFabricBinding,
  connectKnownProvider,
  registerModelManually,
} from '@/modules/provider-fabric/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: AgentBodyErrorCode, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentBodyError);
    expect((error as AgentBodyError).code).toBe(code);
  }
}

function compatiblePolicy() {
  return {
    outcome: 'compatible' as const,
    basis: 'tenant provider policy v3: openai + anthropic allowed for this purpose',
    checkedBy: 'system:policy-engine',
    checkedAt: '2026-10-07T08:00:00.000Z',
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 agent-body — the persistent body (W133) is tenant-scoped', () => {
  it("tenant A's bodies and binding histories are invisible to tenant B; the same role and swap semantics coexist per tenant", async () => {
    const ctxA = member(tenantSweepA);
    const ctxB = member(tenantSweepB);

    // ---- Tenant A: a body + REAL fabric bindings (the W132 seam) -------
    const definitionA = await connectKnownProvider(ctxA, { provider: 'openai' });
    await registerModelManually(ctxA, {
      definitionId: definitionA.definitionId,
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
    });
    // Two real fabric bindings for the cognition purpose: attaching the
    // second supersedes the first FABRIC-side, leaving both as existing
    // audit evidence the body may reference (the W133 opacity ruling).
    const fabricA1 = (
      await attachFabricBinding(ctxA, {
        purpose: 'cognition',
        definitionId: definitionA.definitionId,
        modelId: 'gpt-4o-mini',
        accountId: newId(),
      })
    ).binding;
    const fabricA2 = (
      await attachFabricBinding(ctxA, {
        purpose: 'cognition',
        definitionId: definitionA.definitionId,
        modelId: 'gpt-4o-mini',
        accountId: newId(),
      })
    ).binding;

    const bodyA = await createAgentBody(ctxA, {
      role: 'dispatch-body',
      label: 'Dispatch body',
    });
    expect(bodyA.tenantId).toBe(tenantSweepA);
    const attached1 = await attachModelBinding(ctxA, {
      bodyId: bodyA.id,
      bindingId: fabricA1.bindingId,
      purpose: 'cognition',
      policyCheck: compatiblePolicy(),
    });
    expect(attached1.bindingId).toBe(fabricA1.bindingId);
    expect(attached1.status).toBe('active');

    // ---- Tenant B sees none of it -------------------------------------
    expect(await listAgentBodies(ctxB, {})).toHaveLength(0);

    // Uniform not-found: a FOREIGN body id and a MISSING one are
    // indistinguishable, on the body surface AND the binding surface.
    await expectCode('body_not_found', () =>
      getAgentBody(ctxB, { bodyId: bodyA.id }),
    );
    await expectCode('body_not_found', () =>
      getAgentBody(ctxB, { bodyId: newId() }),
    );
    await expectCode('body_not_found', () =>
      getBodyBindings(ctxB, { bodyId: bodyA.id }),
    );
    await expectCode('body_not_found', () =>
      getActiveBinding(ctxB, { bodyId: bodyA.id, purpose: 'cognition' }),
    );

    // Cross-tenant ATTACH is refused the same way: B cannot attach to A's
    // body (and cannot even learn it exists).
    await expectCode('body_not_found', () =>
      attachModelBinding(ctxB, {
        bodyId: bodyA.id,
        bindingId: fabricA1.bindingId,
        purpose: 'cognition',
        policyCheck: compatiblePolicy(),
      }),
    );

    // ---- The same natural key coexists per tenant ----------------------
    // The tenant-unique role 'dispatch-body' lives independently in B.
    const bodyB = await createAgentBody(ctxB, {
      role: 'dispatch-body',
      label: 'Dispatch body (tenant B)',
    });
    expect(bodyB.id).not.toBe(bodyA.id);
    expect(bodyB.tenantId).toBe(tenantSweepB);
    expect((await listAgentBodies(ctxB, {})).map((body) => body.id)).toEqual([bodyB.id]);

    // B attaches its OWN fabric-registered binding (its own definition —
    // the same provider slug coexists per tenant in the fabric too).
    const definitionB = await connectKnownProvider(ctxB, { provider: 'openai' });
    await registerModelManually(ctxB, {
      definitionId: definitionB.definitionId,
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
    });
    const fabricB = (
      await attachFabricBinding(ctxB, {
        purpose: 'cognition',
        definitionId: definitionB.definitionId,
        modelId: 'gpt-4o-mini',
        accountId: newId(),
      })
    ).binding;
    const attachedB = await attachModelBinding(ctxB, {
      bodyId: bodyB.id,
      bindingId: fabricB.bindingId,
      purpose: 'cognition',
      policyCheck: compatiblePolicy(),
    });
    expect(attachedB.bindingId).toBe(fabricB.bindingId);
    expect(attachedB.tenantId).toBe(tenantSweepB);

    // ---- The swap path stays tenant-scoped ------------------------------
    // A swaps to its second REAL fabric binding: the old attachment is
    // superseded, the new one is active — and NONE of it reaches B.
    const swapped = await attachModelBinding(ctxA, {
      bodyId: bodyA.id,
      bindingId: fabricA2.bindingId,
      purpose: 'cognition',
      policyCheck: compatiblePolicy(),
    });
    expect(swapped.status).toBe('active');
    expect(swapped.bindingId).toBe(fabricA2.bindingId);
    const historyA = await getBodyBindings(ctxA, { bodyId: bodyA.id });
    expect(historyA.map((binding) => binding.bindingId)).toEqual([
      fabricA1.bindingId,
      fabricA2.bindingId,
    ]);
    expect(historyA.map((binding) => binding.status)).toEqual(['superseded', 'active']);

    // B's active attachment and history are untouched by A's swap.
    const activeB = await getActiveBinding(ctxB, { bodyId: bodyB.id, purpose: 'cognition' });
    expect(activeB!.id).toBe(attachedB.id);
    expect(activeB!.bindingId).toBe(fabricB.bindingId);
    const historyB = await getBodyBindings(ctxB, { bodyId: bodyB.id });
    expect(historyB).toHaveLength(1);
    expect(historyB[0]!.tenantId).toBe(tenantSweepB);
    // Every row B can read belongs to B — no ambient-tenant leakage.
    expect((await listAgentBodies(ctxB, {})).every((body) => body.tenantId === tenantSweepB)).toBe(
      true,
    );
  });
});
