// Wave D integration (2026-10-08) — Tenant Isolation Verification · sweep
// for the cross-platform module (W139: Cross-Platform Aurum Product — the
// server-issued client-session registry, the cross-device handoff spine
// and the append-only handoff evidence trail).
//
// REAL two-tenant service proof in the W044 house style (the manifest v12
// registration): tenant A builds cross-platform state through the public
// contract — client sessions of all three platform kinds (web canonical,
// desktop, mobile), a handoff session opened over a REAL conversations
// seam thread (context frozen at open), handed off web → mobile, resumed
// EXACTLY on desktop, plus a one-way session revocation — and tenant B
// must see none of it:
//
//   * empty-list invisibility — B's listClientSessions and
//     listHandoffSessions are empty before it creates its own state, and
//     B's background-work feed / company overview hold none of A's
//     missions (the projection seams are scoped too);
//   * uniform not-found — a FOREIGN client-session id and a MISSING one
//     reject identically on every surface (`session_not_found` on the
//     read, the one-way revocation and acting-through-a-foreign-session
//     handoff opens; `handoff_not_found` on the read, the evidence trail,
//     every lifecycle move — handoff, resumption, close), and the mapped
//     `conversation_not_found` / `mission_not_found` / `work_item_not_found`
//     from the consumed seams cover the composition paths (B cannot even
//     open a handoff over A's conversation or mission — the stolen-focus
//     precedent) — no existence leak (ADR-0001);
//   * same natural shapes coexist per tenant — the same device labels,
//     the same conversation title and the same frozen-draft shape live
//     independently in both tenants, each walking its own full lifecycle;
//   * writes never mutate another tenant's rows — B cannot revoke A's
//     session, cannot move, resume or close A's handoff in any way, and
//     cannot target A's session as a handoff receiver through B's own
//     spine.
//
// Scope rules honored here: cross-platform code is imported ONLY through
// '@/modules/cross-platform/contract'; the conversations/missions fixtures
// come through their public contracts (the consumed seams, exercised as
// real records — never direct SQL writes).

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
  closeHandoffSession,
  getBackgroundWorkItem,
  getClientSession,
  getHandoffSession,
  listBackgroundWork,
  listClientSessions,
  listHandoffEvidence,
  listHandoffSessions,
  openHandoffSession,
  readCompanyOverview,
  readConversationState,
  recordHandoff,
  registerClientSession,
  resumeHandoff,
  revokeClientSession,
  CrossPlatformError,
} from '@/modules/cross-platform/contract';
import type { CrossPlatformErrorCode } from '@/modules/cross-platform/contract';
import { createConversation, recordMessage } from '@/modules/conversations/contract';
import type { Conversation } from '@/modules/conversations/contract';
import { createMission } from '@/modules/missions/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(
  code: CrossPlatformErrorCode,
  fn: () => unknown,
): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CrossPlatformError);
    expect((error as CrossPlatformError).code).toBe(code);
  }
}

function missionInput(title: string) {
  return {
    title,
    knowledgeObjective: `Know ${title}`,
    informationValue: 0.8,
    urgency: 'high' as const,
    currentConfidence: 0.2,
    targetConfidence: 0.9,
    investigationBudget: { amount: 100, currency: 'USD' },
    rewardBudget: { amount: 50, currency: 'USD' },
    completionCriteria: 'The knowledge is documented.',
    actor: { kind: 'system' as const, label: 'wd-int-sweep' },
  };
}

/** A REAL conversations-seam thread (the consumed focus seam). */
async function conversationWithMessages(
  ctx: TenantContext,
  title: string,
  turns: number,
): Promise<Conversation> {
  const conversation = await createConversation(ctx, { title });
  for (let index = 0; index < turns; index += 1) {
    const inbound = index % 2 === 0;
    await recordMessage(ctx, {
      conversationId: conversation.id,
      direction: inbound ? 'inbound' : 'outbound',
      actor: inbound
        ? { kind: 'external', label: 'wd-int-sweep-sender' }
        : { kind: 'system', label: 'wd-int-sweep' },
      channel: 'web',
      payload: { text: `turn ${index + 1} of ${title}` },
      sentAt: `2026-10-08T11:00:${String(10 + index).padStart(2, '0')}.000Z`,
    });
  }
  return conversation;
}

/**
 * The frozen working context BOTH tenants will open over their OWN
 * conversation (the same shape — the coexistence proof; only focusRef
 * differs, being each tenant's own thread id).
 */
function sweepWorkingContext(conversationId: string) {
  return {
    focusKind: 'conversation' as const,
    focusRef: conversationId,
    draft: 'Half-written sweep reply',
    navigation: { area: 'chat' as const, towerSurface: null, focusRef: conversationId },
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 cross-platform — the client sessions and handoff evidence (W139) are tenant-scoped', () => {
  it("tenant A's client sessions, handoff sessions and evidence trails are invisible to tenant B; the same shapes coexist per tenant", async () => {
    const userA = member(tenantSweepA);
    const userB = member(tenantSweepB);

    // ---- Tenant A: the cross-platform state, through the real seams -----
    const conversationA = await conversationWithMessages(userA, 'Sweep field briefing', 2);
    const missionA = await createMission(userA, missionInput('Verify the sweep site roster'));
    const webA = await registerClientSession(userA, {
      platform: 'web',
      deviceLabel: 'Sweep browser — canonical',
    });
    const desktopA = await registerClientSession(userA, {
      platform: 'desktop',
      deviceLabel: 'Sweep workstation',
    });
    const mobileA = await registerClientSession(userA, {
      platform: 'mobile',
      deviceLabel: 'Sweep field phone',
    });
    const doomedA = await registerClientSession(userA, {
      platform: 'web',
      deviceLabel: 'Sweep soon-revoked browser',
    });
    expect(webA.tenantId).toBe(tenantSweepA);
    expect(webA.state).toBe('active');
    expect(webA.platform).toBe('web');

    // The evidenced handoff lifecycle over A's own conversation focus.
    const frozenContextA = sweepWorkingContext(conversationA.id);
    const handoffA = await openHandoffSession(userA, {
      clientSessionId: webA.id,
      context: frozenContextA,
    });
    expect(handoffA.tenantId).toBe(tenantSweepA);
    expect(handoffA.status).toBe('open');
    expect(handoffA.context).toEqual(frozenContextA);
    expect(handoffA.originClientSessionId).toBe(webA.id);
    expect(handoffA.openOnPlatform).toBe('web');
    expect(handoffA.anchorRevision).toBe(1);
    const movedA = await recordHandoff(userA, {
      handoffSessionId: handoffA.id,
      toClientSessionId: mobileA.id,
    });
    expect(movedA.activeClientSessionId).toBe(mobileA.id);
    expect(movedA.openOnPlatform).toBe('mobile');
    expect(movedA.context).toEqual(frozenContextA);
    expect(movedA.anchorRevision).toBe(2);
    const resumedA = await resumeHandoff(userA, {
      handoffSessionId: handoffA.id,
      clientSessionId: desktopA.id,
      clientRevision: null,
    });
    expect(resumedA.restoredContext).toEqual(frozenContextA);
    expect(resumedA.session.activeClientSessionId).toBe(desktopA.id);
    expect(resumedA.session.openOnPlatform).toBe('desktop');
    expect(resumedA.conflict).toBeNull();
    // anchorRevision ≡ the evidence count (the module's own law).
    expect(resumedA.session.anchorRevision).toBe(3);

    // The one-way session revocation over A's own doomed session.
    const revokedA = await revokeClientSession(userA, { clientSessionId: doomedA.id });
    expect(revokedA.state).toBe('revoked');

    // ---- Tenant B sees none of it ---------------------------------------
    expect(await listClientSessions(userB, {})).toHaveLength(0);
    expect(await listHandoffSessions(userB, {})).toHaveLength(0);
    expect(await listHandoffSessions(userB, { status: 'open' })).toHaveLength(0);
    // The projection seams are scoped too: B's background-work feed and
    // company overview hold none of A's mission (empty, not leaked).
    expect(await listBackgroundWork(userB, {})).toEqual([]);
    const overviewB = await readCompanyOverview(userB, {});
    expect(overviewB.goals).toEqual([]);
    expect(overviewB.missions).toEqual([]);

    // Uniform not-founds: a FOREIGN client-session id and a MISSING one
    // are indistinguishable on the read and the one-way revocation.
    await expectCode('session_not_found', () =>
      getClientSession(userB, { clientSessionId: webA.id }),
    );
    await expectCode('session_not_found', () =>
      getClientSession(userB, { clientSessionId: newId() }),
    );
    await expectCode('session_not_found', () =>
      revokeClientSession(userB, { clientSessionId: webA.id }),
    );

    // A FOREIGN handoff id and a MISSING one are indistinguishable on
    // the read, the evidence trail and every lifecycle move.
    await expectCode('handoff_not_found', () =>
      getHandoffSession(userB, { handoffSessionId: handoffA.id }),
    );
    await expectCode('handoff_not_found', () =>
      getHandoffSession(userB, { handoffSessionId: newId() }),
    );
    await expectCode('handoff_not_found', () =>
      listHandoffEvidence(userB, { handoffSessionId: handoffA.id }),
    );
    await expectCode('handoff_not_found', () =>
      listHandoffEvidence(userB, { handoffSessionId: newId() }),
    );
    await expectCode('handoff_not_found', () =>
      recordHandoff(userB, {
        handoffSessionId: handoffA.id,
        toClientSessionId: newId(),
      }),
    );
    await expectCode('handoff_not_found', () =>
      resumeHandoff(userB, {
        handoffSessionId: handoffA.id,
        clientSessionId: newId(),
        clientRevision: null,
      }),
    );
    await expectCode('handoff_not_found', () =>
      closeHandoffSession(userB, { handoffSessionId: handoffA.id }),
    );

    // B cannot COMPOSE over A's records either: not through A's client
    // session (the acting-session gate fires first), not over A's
    // conversation or mission (the honest-focus gate over the consumed
    // seams' uniform not-found — the stolen-focus precedent), and the
    // projection reads refuse A's ids the same way.
    await expectCode('session_not_found', () =>
      openHandoffSession(userB, {
        clientSessionId: webA.id,
        context: {
          focusKind: 'conversation',
          focusRef: conversationA.id,
          draft: null,
          navigation: { area: 'chat' },
        },
      }),
    );
    await expectCode('conversation_not_found', () =>
      readConversationState(userB, { conversationId: conversationA.id }),
    );
    const webB = await registerClientSession(userB, {
      platform: 'web',
      deviceLabel: 'Sweep browser — canonical',
    });
    await expectCode('conversation_not_found', () =>
      openHandoffSession(userB, {
        clientSessionId: webB.id,
        context: {
          focusKind: 'conversation',
          focusRef: conversationA.id,
          draft: 'stolen focus probe',
          navigation: { area: 'chat' },
        },
      }),
    );
    await expectCode('mission_not_found', () =>
      openHandoffSession(userB, {
        clientSessionId: webB.id,
        context: {
          focusKind: 'mission',
          focusRef: missionA.id,
          draft: null,
          navigation: { area: 'intelligence' },
        },
      }),
    );
    await expectCode('work_item_not_found', () =>
      getBackgroundWorkItem(userB, { seam: 'mission', workRef: missionA.id }),
    );

    // ---- B's own state first (the coexistence shapes) -------------------
    // The SAME conversation title, device labels and frozen-draft shape
    // live independently in B even though A already used them — per-tenant
    // namespaces only.
    const conversationB = await conversationWithMessages(userB, 'Sweep field briefing', 2);
    const desktopB = await registerClientSession(userB, {
      platform: 'desktop',
      deviceLabel: 'Sweep workstation',
    });
    const mobileB = await registerClientSession(userB, {
      platform: 'mobile',
      deviceLabel: 'Sweep field phone',
    });
    const frozenContextB = sweepWorkingContext(conversationB.id);
    const handoffB = await openHandoffSession(userB, {
      clientSessionId: webB.id,
      context: frozenContextB,
    });
    expect(handoffB.tenantId).toBe(tenantSweepB);
    expect(handoffB.id).not.toBe(handoffA.id);
    expect(handoffB.context).toEqual(frozenContextB);
    expect(handoffB.context.draft).toBe(frozenContextA.draft);

    // B cannot target A's session as a handoff receiver through B's OWN
    // spine (the receiving-session gate — a foreign session is uniformly
    // not-found, never a leak).
    await expectCode('session_not_found', () =>
      recordHandoff(userB, {
        handoffSessionId: handoffB.id,
        toClientSessionId: webA.id,
      }),
    );

    // B walks its own full lifecycle (the surface serves B normally —
    // isolation is not breakage): handoff → resume → close.
    const movedB = await recordHandoff(userB, {
      handoffSessionId: handoffB.id,
      toClientSessionId: mobileB.id,
    });
    expect(movedB.openOnPlatform).toBe('mobile');
    const resumedB = await resumeHandoff(userB, {
      handoffSessionId: handoffB.id,
      clientSessionId: desktopB.id,
      clientRevision: null,
    });
    expect(resumedB.restoredContext).toEqual(frozenContextB);
    expect(resumedB.reprojection.projectionKind).toBe('conversation-state');
    expect(resumedB.reprojection.tenantId).toBe(tenantSweepB);
    const closedB = await closeHandoffSession(userB, { handoffSessionId: handoffB.id });
    expect(closedB.status).toBe('closed');
    expect(closedB.context).toEqual(frozenContextB);

    // Each tenant's lists hold exactly their own rows.
    expect((await listClientSessions(userA, {})).map((s) => s.id).sort()).toEqual(
      [webA.id, desktopA.id, mobileA.id, doomedA.id].sort(),
    );
    expect((await listClientSessions(userB, {})).map((s) => s.id).sort()).toEqual(
      [webB.id, desktopB.id, mobileB.id].sort(),
    );
    expect((await listClientSessions(userB, { platform: 'web' })).map((s) => s.id)).toEqual([
      webB.id,
    ]);
    expect((await listClientSessions(userA, { state: 'revoked' })).map((s) => s.id)).toEqual([
      doomedA.id,
    ]);
    expect(await listClientSessions(userB, { state: 'revoked' })).toEqual([]);
    expect((await listHandoffSessions(userA, {})).map((h) => h.id)).toEqual([handoffA.id]);
    expect((await listHandoffSessions(userB, {})).map((h) => h.id)).toEqual([handoffB.id]);
    expect((await listHandoffSessions(userA, { status: 'open' })).map((h) => h.id)).toEqual([
      handoffA.id,
    ]);
    expect(await listHandoffSessions(userB, { status: 'open' })).toEqual([]);
    expect(
      (await listHandoffSessions(userB, { focusKind: 'conversation', status: 'closed' })).map(
        (h) => h.id,
      ),
    ).toEqual([handoffB.id]);

    // ---- The evidence trails stay tenant-scoped --------------------------
    // A's trail carries exactly its own lifecycle (open → handoff →
    // resume); B's carries its own (open → handoff → resume → close).
    const trailA = await listHandoffEvidence(userA, { handoffSessionId: handoffA.id });
    expect(trailA.map((e) => e.kind)).toEqual(['session-opened', 'handoff-recorded', 'resumed']);
    expect(trailA.every((e) => e.tenantId === tenantSweepA)).toBe(true);
    const trailB = await listHandoffEvidence(userB, { handoffSessionId: handoffB.id });
    expect(trailB.map((e) => e.kind)).toEqual([
      'session-opened',
      'handoff-recorded',
      'resumed',
      'session-closed',
    ]);
    expect(trailB.every((e) => e.tenantId === tenantSweepB)).toBe(true);
    // anchorRevision ≡ the evidence count on both spines.
    expect((await getHandoffSession(userA, { handoffSessionId: handoffA.id })).anchorRevision).toBe(
      trailA.length,
    );
    expect((await getHandoffSession(userB, { handoffSessionId: handoffB.id })).anchorRevision).toBe(
      trailB.length,
    );

    // A's state is untouched by any of B's probes: the session B tried to
    // revoke is still active, the handoff B tried to move/resume/close is
    // still open on A's desktop, and the trail still holds exactly three
    // records.
    expect((await getClientSession(userA, { clientSessionId: webA.id })).state).toBe('active');
    const afterA = await getHandoffSession(userA, { handoffSessionId: handoffA.id });
    expect(afterA.status).toBe('open');
    expect(afterA.activeClientSessionId).toBe(desktopA.id);
    expect(afterA.context).toEqual(frozenContextA);
    expect(await listHandoffEvidence(userA, { handoffSessionId: handoffA.id })).toHaveLength(3);
  });
});
