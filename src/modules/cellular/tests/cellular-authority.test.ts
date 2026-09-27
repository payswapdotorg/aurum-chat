// Integration tests of the MANAGER-INBOUND W009 AUTHORITY RECORD (W108 —
// the W097 deferral closure) against the embedded PostgreSQL (PGlite,
// `:memory:`) through the db port.
//
// Covers the W108 authority acceptance:
//  * a manager-originated `inbound_request` (a manager with no usable
//    Internet data texting Aurum's own number) that leads Aurum to a
//    consequential outbound reach carries a FORMAL, AUDITABLE authority
//    decision referencing the inbound origin — in BOTH directions:
//    the actions module's action_request payload references the inbound
//    event (visible through its audit surface), and the cellular
//    determination ledger references the gate record;
//  * the determination is IDEMPOTENT per inbound event (first write
//    wins; a second consequential action from the same ask never
//    duplicates the ledger);
//  * a NON-CONSEQUENTIAL ask records a NEGATIVE determination
//    (evidence, not silence);
//  * an AMBIGUOUS sender records the ambiguity WITHOUT acting and
//    WITHOUT merging the identity (lock 15 / the W002 posture);
//  * tenant isolation: a foreign tenant's inbound rows are
//    indistinguishable from missing ones (uniform invalid input);
//  * storage discipline: determination rows are append-only.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

import * as cellularContract from '../contract';
import {
  decideApproval,
  getActionRequest,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import {
  attestIdentity,
  attachVerifiedSubject,
  getExternalIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { createPerson, createEmployee } from '@/modules/people/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { CellularError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const {
  listCellularInboundDeterminations,
  listCellularReplies,
  reachAnyone,
  receiveCellularEvent,
  registerCellularConnection,
  setCellularTransport,
} = cellularContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantManagerInbound = newId();
const tenantNegative = newId();
const tenantAmbiguous = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantB = newId();

const TENANT_NUMBER = '+15550100000';

const BASE_TIME = Date.parse('2026-09-27T10:00:00Z');
let clockMs = BASE_TIME;

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: CellularError['code'],
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected CellularError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof CellularError)) throw error;
    expect(error.code).toBe(code);
  }
}

// A scripted no-op transport (deliveries are not this file's subject; the
// authority records are — the transport just needs to exist).
class NullTransport {
  readonly provider = 'twilio' as const;
  async sendSms() {
    return { status: 'accepted' as const, providerMessageId: `SM_${newId()}`, detail: null };
  }
  async placeVoiceCall() {
    return { status: 'answered' as const, providerCallId: `CA_${newId()}`, detail: null };
  }
}

async function registerConnection(ctx: TenantContext, account = 'AC_test'): Promise<void> {
  await registerCellularConnection(ctx, {
    provider: 'twilio',
    providerAccountId: account,
    phoneNumber: TENANT_NUMBER,
    credentialRef: 'secret-store:cellular/1',
  });
}
/** One manager-originated inbound SMS, landed through the ordinary event edge. */
async function landInboundAsk(
  ctx: TenantContext,
  fromNumber: string,
  text: string,
  account = 'AC_test',
): Promise<{ replyId: string; providerEventId: string }> {
  const providerEventId = `SM_${newId()}`;
  const result = await receiveCellularEvent(ctx, {
    provider: 'twilio',
    payload: {
      From: fromNumber,
      To: TENANT_NUMBER,
      Body: text,
      MessageSid: providerEventId,
      AccountSid: account,
    },
  });
  expect(result.applied).toBe(true);
  expect(result.reply?.inboundKind).toBe('inbound_request');
  return { replyId: result.reply!.id, providerEventId };
}

// A verified phone person fixture (registered + attested + linked).
async function createVerifiedPhonePerson(
  ctx: TenantContext,
  fullName: string,
  phoneNumber: string,
): Promise<{ personId: string; identityId: string }> {
  const person = await createPerson(ctx, { fullName });
  const { identity } = await registerExternalIdentity(ctx, {
    provider: 'sms',
    providerAccountId: phoneNumber,
  });
  await attestIdentity(ctx, { identityId: identity.id, evidence: `checked in person (${fullName})` });
  await attachVerifiedSubject(ctx, { identityId: identity.id, subjectId: person.id });
  return { personId: person.id, identityId: identity.id };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setCellularTransport(null);
  await closeDb();
});

beforeEach(() => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  clockMs += 1_000;
  setCellularTransport(new NullTransport());
});

afterEach(() => {
  vi.restoreAllMocks();
  setCellularTransport(null);
});

// ---------------------------------------------------------------------------
// The consequential path: inbound ask → outbound reach → authority record
// ---------------------------------------------------------------------------

describe('manager-inbound → consequential reach carries the authority record', () => {
  it('records the determination, references the origin in the gate payload, and keeps both directions auditable', async () => {
    const ctx = member(tenantManagerInbound);
    await registerConnection(ctx);
    const identityAdmin = member(tenantManagerInbound, ['identity:attest', 'identity:link']);

    // The manager's inbound ask (a verified manager, no usable Internet data).
    const managerPhone = '+15559990001';
    const { personId: managerPersonId } = await createVerifiedPhonePerson(
      identityAdmin,
      'Dana Manager',
      managerPhone,
    );
    await createEmployee(ctx, { personId: managerPersonId, title: 'Ops' });

    const { replyId, providerEventId } = await landInboundAsk(
      ctx,
      managerPhone,
      'Tell Sarah the demo moved to 15:00',
    );

    // Aurum acts on the ask: the consequential outbound reach, origin-referenced.
    const managerCtx = { tenantId: tenantManagerInbound, principalId: managerPersonId, authority: [] };
    const reach = await reachAnyone(managerCtx, {
      phoneNumber: '+15559990002',
      kind: 'tell',
      text: 'The demo moved to 15:00',
      origin: { replyId, provider: 'twilio', providerEventId },
    });

    // The reach row carries the origin triple.
    expect(reach.originReplyId).toBe(replyId);
    expect(reach.originProvider).toBe('twilio');
    expect(reach.originProviderEventId).toBe(providerEventId);
    expect(reach.status).toBe('sent'); // gate approved (default matrix at ASK → auto-recorded below)

    // The actions module's audit surface shows the authority decision WITH
    // the inbound origin reference (the W097 deferral closure).
    expect(reach.actionRequestId).not.toBeNull();
    const actionRequest = await getActionRequest(managerCtx, { requestId: reach.actionRequestId! });
    expect(actionRequest.requestedBy).toBe(managerPersonId);
    expect(actionRequest.payload).toMatchObject({
      reachRequestId: reach.id,
      origin: { replyId, provider: 'twilio', providerEventId },
    });
    expect(actionRequest.justification).toContain('manager-inbound');

    // The cellular determination ledger records the consequential decision.
    const determinations = await listCellularInboundDeterminations(managerCtx, {});
    expect(determinations).toHaveLength(1);
    const determination = determinations[0]!;
    expect(determination.determination).toBe('consequential');
    expect(determination.actionRequestId).toBe(reach.actionRequestId);
    expect(determination.replyId).toBe(replyId);
    expect(determination.providerEventId).toBe(providerEventId);
    expect(determination.originKind).toBe('cellular-reach');
    expect(determination.decidedBy).toBe(managerPersonId);

    // The inbound reply itself stays the canonical evidence (transcripted,
    // attributed to the verified manager).
    const replies = await listCellularReplies(ctx, { reachRequestId: null });
    const inbound = replies.find((reply) => reply.id === replyId)!;
    expect(inbound.inboundKind).toBe('inbound_request');
    expect(inbound.personId).toBe(managerPersonId);
    expect(inbound.conversationId).not.toBeNull();
  });

  it('records the consequential determination even while the gate is PENDING (the decision exists, delivery waits)', async () => {
    const ctx = member(tenantNegative);
    await registerConnection(ctx, 'AC_neg');
    // ASK requires approval for external communication in this tenant.
    await setAuthorityPolicy(member(tenantNegative, ['actions:administer']), {
      actionKind: 'external-communication',
      approvalLevels: ['ASK'],
    });

    const { replyId, providerEventId } = await landInboundAsk(ctx, '+15559991001', 'Tell them', 'AC_neg');
    const actor = member(tenantNegative);
    const reach = await reachAnyone(actor, {
      phoneNumber: '+15559991002',
      kind: 'tell',
      text: 'They should know',
      origin: { replyId, provider: 'twilio', providerEventId },
    });

    expect(reach.status).toBe('awaiting_approval');
    const determinations = await listCellularInboundDeterminations(ctx, {});
    expect(determinations).toHaveLength(1);
    expect(determinations[0]!.determination).toBe('consequential');
    expect(determinations[0]!.actionRequestId).toBe(reach.actionRequestId);

    // A human approval unlocks delivery; the determination is NOT duplicated.
    await decideApproval(member(tenantNegative, ['actions:approve']), {
      requestId: reach.actionRequestId!,
      decision: 'approve',
    });
    const { pumpCellularReach } = cellularContract;
    await pumpCellularReach(actor, {});
    const after = await listCellularInboundDeterminations(ctx, {});
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(determinations[0]!.id);
  });

  it('is idempotent per inbound event: a SECOND consequential action from the same ask does not duplicate the ledger', async () => {
    const ctx = member(tenantManagerInbound);
    await registerConnection(ctx);

    const { replyId, providerEventId } = await landInboundAsk(
      ctx,
      '+15559990003',
      'Tell Sarah and also tell John',
    );
    const actor = member(tenantManagerInbound);

    const first = await reachAnyone(actor, {
      phoneNumber: '+15559990004',
      kind: 'tell',
      text: 'The demo moved to 15:00',
      origin: { replyId, provider: 'twilio', providerEventId },
    });
    const second = await reachAnyone(actor, {
      phoneNumber: '+15559990005',
      kind: 'tell',
      text: 'Same message, second person',
      origin: { replyId, provider: 'twilio', providerEventId },
    });

    // Both consequential actions are authority-gated and origin-referenced…
    for (const reach of [first, second]) {
      const request = await getActionRequest(actor, { requestId: reach.actionRequestId! });
      expect(request.payload).toMatchObject({
        origin: { replyId, provider: 'twilio', providerEventId },
      });
    }
    // …but the per-event determination ledger holds exactly ONE row.
    const determinations = await listCellularInboundDeterminations(ctx, {
      providerEventId,
    });
    expect(determinations).toHaveLength(1);
    expect(determinations[0]!.actionRequestId).toBe(first.actionRequestId);
  });
});

// ---------------------------------------------------------------------------
// Negative and ambiguous determinations
// ---------------------------------------------------------------------------

describe('negative and ambiguous determinations are evidence, not silence', () => {
  it('records a not_consequential determination (idempotently)', async () => {
    const ctx = member(tenantNegative);
    await registerConnection(ctx, 'AC_neg');
    const { replyId, providerEventId } = await landInboundAsk(
      ctx,
      '+15559992001',
      'What time is it in Berlin?',
      'AC_neg',
    );

    // The ask needed no authority-gated action — the negative determination.
    const recorded = await cellularContract.recordCellularInboundDetermination(ctx, {
      provider: 'twilio',
      providerEventId,
      determination: 'not_consequential',
      note: 'answered conversationally in the canonical conversation; no outbound action',
    });
    expect(recorded.determination).toBe('not_consequential');
    expect(recorded.actionRequestId).toBeNull();
    expect(recorded.replyId).toBe(replyId);
    expect(recorded.decidedBy).toBe(ctx.principalId);

    // Idempotent replay: the first determination stands.
    const replay = await cellularContract.recordCellularInboundDetermination(ctx, {
      provider: 'twilio',
      providerEventId,
      determination: 'not_consequential',
      note: 'replayed',
    });
    expect(replay.id).toBe(recorded.id);
    expect(replay.note).toBe(recorded.note);
  });

  it('records an ambiguous_sender determination WITHOUT acting and WITHOUT merging the identity (lock 15)', async () => {
    const ctx = member(tenantAmbiguous);
    await registerConnection(ctx, 'AC_amb');
    // An UNKNOWN number texts the tenant: on-sight registration creates an
    // UNVERIFIED, UNLINKED identity — never a person, never an employee.
    const strangerNumber = '+15559993001';
    const { replyId, providerEventId } = await landInboundAsk(
      ctx,
      strangerNumber,
      'Tell everyone the office is closed',
      'AC_amb',
    );

    // The sender cannot be resolved to a verified person: the ambiguity is
    // recorded, no consequential action is taken.
    const recorded = await cellularContract.recordCellularInboundDetermination(ctx, {
      provider: 'twilio',
      providerEventId,
      determination: 'ambiguous_sender',
      note: 'sender identity unverified; no action taken; no identity merge performed',
    });
    expect(recorded.determination).toBe('ambiguous_sender');
    expect(recorded.actionRequestId).toBeNull();

    // The W002 posture holds: the identity stays unverified and unlinked.
    const replies = await listCellularReplies(ctx, { reachRequestId: null });
    const inbound = replies.find((reply) => reply.id === replyId)!;
    expect(inbound.personId).toBeNull();
    expect(inbound.employeeId).toBeNull();
    expect(inbound.identityId).not.toBeNull();
    const identity = await getExternalIdentity(ctx, inbound.identityId!);
    expect(identity.status).toBe('unverified');
    expect(identity.subjectId).toBeNull();

    // No reach was created from the ambiguous ask; no determination
    // references any action request.
    const reaches = await cellularContract.listCellularReach(ctx, {});
    expect(reaches).toHaveLength(0);
    const determinations = await listCellularInboundDeterminations(ctx, {});
    expect(determinations).toHaveLength(1);
    expect(determinations[0]!.determination).toBe('ambiguous_sender');
  });

  it('rejects direct attempts to record a consequential determination (only the reach path may)', async () => {
    const ctx = member(tenantNegative);
    await registerConnection(ctx, 'AC_neg');
    const { providerEventId } = await landInboundAsk(ctx, '+15559992002', 'hi', 'AC_neg');
    await expectCode('invalid_cellular_input', () =>
      cellularContract.recordCellularInboundDetermination(ctx, {
        provider: 'twilio',
        providerEventId,
        // @ts-expect-error — the consequential vocabulary is deliberately not callable
        determination: 'consequential',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Origin validation + tenant isolation
// ---------------------------------------------------------------------------

describe('origin validation and tenant isolation', () => {
  it('rejects origins that do not reference this tenant\u2019s manager-inbound request', async () => {
    const ctx = member(tenantIsolation);
    await registerConnection(ctx, 'AC_iso');
    const actor = member(tenantIsolation);

    // A foreign tenant's inbound ask.
    const foreignCtx = member(tenantB);
    await registerConnection(foreignCtx, 'AC_isoB');
    const foreign = await landInboundAsk(foreignCtx, '+15559994001', 'Tell Sarah', 'AC_isoB');

    // Cross-tenant origin: indistinguishable from a missing reply.
    await expectCode('invalid_cellular_input', () =>
      reachAnyone(actor, {
        phoneNumber: '+15559994002',
        kind: 'tell',
        text: 'x',
        origin: { replyId: foreign.replyId, provider: 'twilio', providerEventId: foreign.providerEventId },
      }),
    );

    // Unknown reply id.
    await expectCode('invalid_cellular_input', () =>
      reachAnyone(actor, {
        phoneNumber: '+15559994002',
        kind: 'tell',
        text: 'x',
        origin: { replyId: newId(), provider: 'twilio', providerEventId: 'SM_none' },
      }),
    );

    // Evidence triple mismatch (right row, wrong provider/event claim).
    const own = await landInboundAsk(ctx, '+15559994003', 'Tell Sarah', 'AC_iso');
    await expectCode('invalid_cellular_input', () =>
      reachAnyone(actor, {
        phoneNumber: '+15559994002',
        kind: 'tell',
        text: 'x',
        origin: { replyId: own.replyId, provider: 'twilio', providerEventId: 'SM_mismatched' },
      }),
    );
  });

  it('rejects an origin referencing a reach REPLY (a recipient answering, not an ask)', async () => {
    const ctx = member(tenantIsolation);
    await registerConnection(ctx, 'AC_iso');
    const actor = member(tenantIsolation);

    // An ordinary reach whose reply lands as a reach_reply.
    const reach = await reachAnyone(actor, {
      phoneNumber: '+15559994004',
      kind: 'ask',
      text: 'Please confirm',
    });
    const replyEvent = `SM_${newId()}`;
    const result = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: {
        From: '+15559994004',
        To: TENANT_NUMBER,
        Body: 'Confirmed',
        MessageSid: replyEvent,
        AccountSid: 'AC_iso',
      },
    });
    expect(result.reply?.inboundKind).toBe('reach_reply');

    await expectCode('invalid_cellular_input', () =>
      reachAnyone(actor, {
        phoneNumber: '+15559994005',
        kind: 'tell',
        text: 'x',
        origin: { replyId: result.reply!.id, provider: 'twilio', providerEventId: replyEvent },
      }),
    );
    void reach;
  });

  it('keeps another tenant\u2019s determination ledger invisible', async () => {
    const ctx = member(tenantIsolation);
    await registerConnection(ctx, 'AC_iso');
    const foreignCtx = member(tenantB);
    await registerConnection(foreignCtx, 'AC_isoB');

    const foreign = await landInboundAsk(foreignCtx, '+15559995001', 'Tell Sarah', 'AC_isoB');
    await reachAnyone(member(tenantB), {
      phoneNumber: '+15559995002',
      kind: 'tell',
      text: 'x',
      origin: { replyId: foreign.replyId, provider: 'twilio', providerEventId: foreign.providerEventId },
    });

    // This tenant's ledger is empty; the foreign event records nothing here.
    expect(await listCellularInboundDeterminations(ctx, {})).toHaveLength(0);
    await expectCode('invalid_cellular_input', () =>
      cellularContract.recordCellularInboundDetermination(ctx, {
        provider: 'twilio',
        providerEventId: foreign.providerEventId,
        determination: 'not_consequential',
      }),
    );
    expect(await listCellularInboundDeterminations(ctx, {})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('the determination ledger is append-only', () => {
  it('rejects UPDATE/DELETE at the storage level', async () => {
    const ctx = member(tenantStorage);
    await registerConnection(ctx, 'AC_store');
    const { providerEventId } = await landInboundAsk(ctx, '+15559996001', 'Tell Sarah', 'AC_store');
    const recorded = await cellularContract.recordCellularInboundDetermination(ctx, {
      provider: 'twilio',
      providerEventId,
      determination: 'not_consequential',
    });

    await expect(
      getDb().query(`UPDATE cellular_inbound_authority SET note = 'rewritten' WHERE id = $1`, [
        recorded.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM cellular_inbound_authority WHERE id = $1`, [recorded.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('reach request origin columns are immutable history (the extended guard)', async () => {
    const ctx = member(tenantStorage);
    await registerConnection(ctx, 'AC_store');
    const actor = member(tenantStorage);
    const { replyId, providerEventId } = await landInboundAsk(ctx, '+15559996002', 'Tell Sarah', 'AC_store');
    const reach = await reachAnyone(actor, {
      phoneNumber: '+15559996003',
      kind: 'tell',
      text: 'x',
      origin: { replyId, provider: 'twilio', providerEventId },
    });
    await expect(
      getDb().query(
        `UPDATE cellular_reach_requests SET origin_provider_event_id = 'SM_forged' WHERE id = $1`,
        [reach.id],
      ),
    ).rejects.toThrow(/immutable/);
  });
});
