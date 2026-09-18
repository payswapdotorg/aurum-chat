// W045 — Identity/Channel Verification (end-to-end, part 2: permissions).
//
// "End-to-end test that the same employee can communicate across multiple
//  providers while permissions remain consistent."
//
// Part 1 (employee-across-providers.test.ts) proves the communication half:
// one employee, four providers, one consistent person/employee resolution.
// This file proves the PERMISSION half on the same kind of journey:
//
//   * authority-matrix uniformity — the W009 gate that governs employee
//     messaging (ARCHITECTURE.md §20: "The authority matrix applies
//     uniformly to employee messaging …") evaluates IDENTICALLY whichever
//     provider carries the conversation: same outcome, same resolution
//     trail, before AND after a tenant policy change — authority is
//     application-owned (§2), never channel-derived;
//   * per-identity trust boundaries — revoking ONE provider's verification
//     withdraws exactly that provider's person-attribution (lock 15 flips
//     the account back to `external`), while the SAME rule keeps resolving
//     the employee through every other provider;
//   * the unverified-account rule — no provider's account can be linked to
//     a person before verification (uniform, lock 15);
//   * tenant isolation — the same provider account in another tenant is a
//     DIFFERENT identity that resolves to that tenant's own subject (or
//     nothing), never to Acme's employee; cross-tenant reads fail
//     uniformly (ADR-0001, no existence leak).
//
// Database: embedded PostgreSQL (PGlite, `:memory:`) through the db port —
// this file's module graph gets a private database, migrated in beforeAll.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import {
  deliverIdentityChallenge,
  receiveInbound,
  setChannelTransport,
  ChannelsError,
} from '@/modules/channels/contract';
import {
  ConversationsError,
  getConversation,
  listMessages,
} from '@/modules/conversations/contract';
import {
  attestIdentity,
  IdentityError,
  revokeVerification,
} from '@/modules/identity/contract';
import {
  createPerson,
  getPerson,
  linkExternalIdentity,
  listPersonIdentities,
  resolveIdentity,
  PeopleError,
} from '@/modules/people/contract';
import {
  authorizeAction,
  evaluateActionAuthority,
  listApprovalDecisions,
  setAuthorityPolicy,
  ActionsError,
  AUTHORITY_LEVELS,
  type ActionRequest,
  type AuthorityEvaluation,
} from '@/modules/actions/contract';
import {
  identityAdminContext,
  memberContext,
  onboardEmployeeAcrossProviders,
  policyAdminContext,
  prepareDatabase,
  RecordingTransport,
  slackEvent,
  teardownDatabase,
  type OnboardingFixture,
} from './helpers';

const tenantAcme = newId();
const tenantOther = newId();

let fixture: OnboardingFixture;

beforeAll(async () => {
  await prepareDatabase();
  fixture = await onboardEmployeeAcrossProviders({
    tenantId: tenantAcme,
    fullName: 'Maya Chen',
    email: 'maya.chen@acme.example',
    title: 'Operations Lead',
    department: 'Operations',
  });
});

beforeEach(() => {
  setChannelTransport(new RecordingTransport());
});

afterAll(async () => {
  await teardownDatabase();
});

/** A typed module error: instance carries a string-literal `code`. */
interface TypedError<C extends string> extends Error {
  readonly code: C;
}

/** Asserts `fn` rejects with the given typed error class and code. */
async function expectErrorCode<C extends string, E extends TypedError<C>>(
  errorClass: abstract new (code: C, message: string) => E,
  code: NoInfer<C>,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ${errorClass.name}('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass);
    expect((error as E).code).toBe(code);
  }
}

describe('W045 · the authority matrix governs employee messaging uniformly across providers', () => {
  /**
   * The W009 evaluation for employee messaging, collected "through" each
   * provider the employee communicates over: for every authority level,
   * the gate sees only (tenant policy, kind, level) — the provider that
   * would carry the message cannot participate.
   */
  async function evaluationsPerProvider(): Promise<Map<string, AuthorityEvaluation[]>> {
    const perProvider = new Map<string, AuthorityEvaluation[]>();
    for (const journey of fixture.providers) {
      const evaluations: AuthorityEvaluation[] = [];
      for (const level of AUTHORITY_LEVELS) {
        evaluations.push(
          await evaluateActionAuthority(fixture.member, {
            actionKind: 'employee-messaging',
            authorityLevel: level,
          }),
        );
      }
      perProvider.set(journey.persona.provider, evaluations);
    }
    return perProvider;
  }

  it('evaluates identically through every provider (built-in floor)', async () => {
    const perProvider = await evaluationsPerProvider();
    const reference = [...perProvider.values()][0]!;
    for (const evaluations of perProvider.values()) {
      expect(evaluations).toEqual(reference);
    }
    // the built-in floor: informational levels allowed, EXECUTE gated
    const byLevel = new Map(reference.map((evaluation) => [evaluation.authorityLevel, evaluation]));
    expect(byLevel.get('OBSERVE')!.outcome).toBe('allowed');
    expect(byLevel.get('ANALYZE')!.outcome).toBe('allowed');
    expect(byLevel.get('RECOMMEND')!.outcome).toBe('allowed');
    expect(byLevel.get('ASK')!.outcome).toBe('allowed');
    expect(byLevel.get('PROPOSE')!.outcome).toBe('allowed');
    expect(byLevel.get('EXECUTE')!.outcome).toBe('approval_required');
    for (const evaluation of reference) {
      expect(evaluation.resolvedVia).toBe('built-in');
      expect(evaluation.policy).toBeNull();
    }
  });

  it('gates an employee-messaging action identically whichever provider it targets', async () => {
    // Aurum proposes one outbound employee-messaging ASK per provider.
    const requests: ActionRequest[] = [];
    for (const journey of fixture.providers) {
      requests.push(
        await authorizeAction(fixture.member, {
          actionKind: 'employee-messaging',
          authorityLevel: 'ASK',
          payload: {
            provider: journey.persona.provider,
            to: journey.persona.account,
            text: 'Which vendor renewals land this quarter?',
            conversationId: journey.firstTurn.message.conversationId,
          },
          justification: 'W045 uniformity probe before the tenant tightens policy',
        }),
      );
    }
    // ASK is allowed by the built-in floor → policy auto-approval, and the
    // evaluation snapshot is IDENTICAL for all four provider-targeted asks.
    for (const request of requests) {
      expect(request.status).toBe('approved');
      expect(request.evaluation.outcome).toBe('allowed');
      expect(request.requestedBy).toBe(fixture.member.principalId);
    }
    const [first, ...rest] = requests;
    for (const request of rest) expect(request.evaluation).toEqual(first!.evaluation);
    // the approval trail records the deterministic policy decision
    for (const request of requests) {
      const decisions = await listApprovalDecisions(fixture.member, { requestId: request.id });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.decidedBy).toBe('policy');
      expect(decisions[0]!.decision).toBe('approve');
    }
  });

  it('applies a tenant policy change to EVERY provider uniformly (and only via actions:administer)', async () => {
    // a plain member cannot tighten or weaken the tenant's gates
    await expectErrorCode(
      ActionsError,
      'forbidden',
      () =>
        setAuthorityPolicy(fixture.member, {
          actionKind: 'employee-messaging',
          approvalLevels: ['ASK'],
        }),
    );

    // the tenant's policy administrator gates ASK (and keeps EXECUTE gated)
    await setAuthorityPolicy(policyAdminContext(tenantAcme), {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK', 'EXECUTE'],
      note: 'W045: outbound employee questions require human approval',
    });

    // re-evaluate through every provider: ASK now approval_required via the
    // kind row — IDENTICALLY for all providers.
    const perProvider = await evaluationsPerProvider();
    const reference = [...perProvider.values()][0]!;
    for (const evaluations of perProvider.values()) expect(evaluations).toEqual(reference);
    const byLevel = new Map(reference.map((evaluation) => [evaluation.authorityLevel, evaluation]));
    expect(byLevel.get('ASK')!.outcome).toBe('approval_required');
    expect(byLevel.get('ASK')!.resolvedVia).toBe('kind');
    expect(byLevel.get('ASK')!.policy!.actionKind).toBe('employee-messaging');
    expect(byLevel.get('EXECUTE')!.outcome).toBe('approval_required');
    expect(byLevel.get('OBSERVE')!.outcome).toBe('allowed');

    // and the live gate now routes the SAME provider-targeted asks to pending
    const requests: ActionRequest[] = [];
    for (const journey of fixture.providers) {
      requests.push(
        await authorizeAction(fixture.member, {
          actionKind: 'employee-messaging',
          authorityLevel: 'ASK',
          payload: {
            provider: journey.persona.provider,
            to: journey.persona.account,
            text: 'Follow-up question — after the policy change.',
          },
          justification: 'W045 uniformity probe after the tenant tightened policy',
        }),
      );
    }
    for (const request of requests) {
      expect(request.status).toBe('pending');
      expect(request.decidedAt).toBeNull();
      expect(request.evaluation.outcome).toBe('approval_required');
      expect(request.evaluation.resolvedVia).toBe('kind');
    }
    const [first, ...rest] = requests;
    for (const request of rest) expect(request.evaluation).toEqual(first!.evaluation);
  });
});

describe('W045 · trust boundaries are per-identity and uniform across providers', () => {
  it('refuses to link an UNVERIFIED account on any provider (lock 15)', async () => {
    // a brand-new account (Signal) makes first contact — unverified
    const firstContact = await receiveInbound(fixture.member, {
      provider: 'signal',
      payload: {
        envelope: {
          sourceNumber: '+15550900011',
          sourceName: 'Maya C.',
          timestamp: 1_760_426_500_000, // signal-cli envelopes carry unix MILLISECONDS
          message: 'Hi from my Signal account — same Maya, new number.',
        },
      },
    });
    expect(firstContact.identityCreated).toBe(true);
    expect(firstContact.identity.status).toBe('unverified');
    expect(firstContact.message.actor.kind).toBe('external');

    // even the identity admin cannot link an unverified account
    await expectErrorCode(
      IdentityError,
      'identity_not_verified',
      () =>
        linkExternalIdentity(fixture.identityAdmin, {
          personId: fixture.person.id,
          identityId: firstContact.identity.id,
        }),
    );

    // and the account does not resolve to the employee
    const resolution = await resolveIdentity(fixture.member, {
      provider: 'signal',
      providerAccountId: '+15550900011',
    });
    expect(resolution.status).toBe('unresolved_identity');
  });

  it('revokes exactly ONE provider: that channel falls back to external, the others keep the employee', async () => {
    const whatsapp = fixture.providers.find((p) => p.persona.provider === 'whatsapp')!;
    const others = fixture.providers.filter((p) => p.persona.provider !== 'whatsapp');

    // the tenant's identity administrator withdraws the WhatsApp trust
    const revoked = await revokeVerification(fixture.identityAdmin, {
      identityId: whatsapp.firstTurn.identity.id,
      reason: 'phone handed back during device replacement (W045 scenario)',
    });
    expect(revoked.status).toBe('revoked');
    expect(revoked.subjectId).toBeNull(); // the link died with the trust

    // WhatsApp turns are external again — lock 15, same rule as first contact
    const afterRevoke = await receiveInbound(fixture.member, {
      provider: 'whatsapp',
      payload: whatsapp.persona.inbound('Sent from the replacement phone…', 900),
    });
    expect(afterRevoke.identity.id).toBe(whatsapp.firstTurn.identity.id);
    expect(afterRevoke.identity.status).toBe('revoked');
    expect(afterRevoke.message.actor.kind).toBe('external');
    expect(afterRevoke.message.actor.id).toBeNull();

    // WhatsApp no longer resolves to the employee…
    const whatsappResolution = await resolveIdentity(fixture.member, {
      provider: 'whatsapp',
      providerAccountId: whatsapp.persona.account,
    });
    expect(whatsappResolution.status).toBe('unresolved_identity');

    // …while every other provider still resolves the SAME employee
    for (const journey of others) {
      const resolution = await resolveIdentity(fixture.member, {
        provider: journey.persona.provider,
        providerAccountId: journey.persona.account,
      });
      expect(resolution.status).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(resolution.person.id).toBe(fixture.person.id);
      expect(resolution.employee!.id).toBe(fixture.employee.id);
      expect(resolution.employee!.status).toBe('active');
    }

    // the employee keeps communicating over an unaffected provider
    const telegram = fixture.providers.find((p) => p.persona.provider === 'telegram')!;
    const stillTalking = await receiveInbound(fixture.member, {
      provider: 'telegram',
      payload: telegram.persona.inbound('WhatsApp is offline for me — continuing here.', 910),
    });
    expect(stillTalking.message.actor.kind).toBe('person');
    expect(stillTalking.message.actor.id).toBe(fixture.person.id);

    // the revoked identity left the employee's channel footprint
    const identities = await listPersonIdentities(fixture.member, fixture.person.id);
    expect(identities.map((identity) => identity.provider).sort()).toEqual([
      'email',
      'slack',
      'telegram',
    ]);

    // re-verification of the revoked account needs an explicit attestation:
    // the challenge path is closed uniformly (identity_revoked → not eligible)
    await expectErrorCode(
      ChannelsError,
      'identity_not_eligible',
      () =>
        deliverIdentityChallenge(fixture.member, {
          identityId: whatsapp.firstTurn.identity.id,
        }),
    );
  });
});

describe('W045 · the same provider account in another tenant is a different, isolated identity', () => {
  let otherIdentityId: string;

  it('registers Maya’s Slack account in the other tenant as a NEW unverified identity', async () => {
    const otherMember = memberContext(tenantOther);

    // before any webhook lands there, the account is utterly unknown in the
    // other tenant — Acme's registration is invisible across the boundary
    expect(
      (await resolveIdentity(otherMember, { provider: 'slack', providerAccountId: 'U9MAYA01' }))
        .status,
    ).toBe('unknown_identity');

    // the same Slack user id posts in ANOTHER tenant's workspace
    const inbound = await receiveInbound(otherMember, {
      provider: 'slack',
      payload: slackEvent({
        userId: 'U9MAYA01',
        channelId: 'COTHER01',
        text: 'Hello from the same Slack account — different workspace.',
        ts: '1760426500.000100',
        teamId: 'TOTHER99',
      }),
    });
    otherIdentityId = inbound.identity.id;
    expect(inbound.identityCreated).toBe(true);
    // a DIFFERENT identity row than Acme's — tenant-scoped from birth
    expect(inbound.identity.id).not.toBe(
      fixture.providers.find((p) => p.persona.provider === 'slack')!.firstTurn.identity.id,
    );
    expect(inbound.identity.status).toBe('unverified');
    expect(inbound.message.actor.kind).toBe('external');

    // …and in the OTHER tenant the account stays unresolved — known there
    // (registered on sight by that tenant's own webhook), unverified, and
    // resolving to NOTHING, let alone to Acme's employee.
    const resolution = await resolveIdentity(otherMember, {
      provider: 'slack',
      providerAccountId: 'U9MAYA01',
    });
    expect(resolution.status).toBe('unresolved_identity');
    if (resolution.status === 'unresolved_identity') {
      expect(resolution.identity.id).toBe(otherIdentityId); // the OTHER tenant's row
      expect(resolution.identity.status).toBe('unverified');
      expect(resolution.identity.subjectId).toBeNull();
    }
  });

  it('resolves to the OTHER tenant’s own subject after that tenant verifies it — never to Acme’s employee', async () => {
    // the other tenant's identity administrator — its own claims, its own tenant
    const otherAdmin = identityAdminContext(tenantOther);
    const otherMember = memberContext(tenantOther);

    // the other tenant attests and links the account to ITS OWN person
    const otherPerson = await createPerson(otherMember, { fullName: 'Rival Rita' });
    const attested = await attestIdentity(otherAdmin, {
      identityId: otherIdentityId,
      evidence: 'W045 cross-tenant probe: HR badge scan at Other Corp',
    });
    expect(attested.status).toBe('verified');
    await linkExternalIdentity(otherAdmin, {
      personId: otherPerson.id,
      identityId: otherIdentityId,
    });

    // in the OTHER tenant the account now resolves to that tenant's person…
    const otherResolution = await resolveIdentity(otherMember, {
      provider: 'slack',
      providerAccountId: 'U9MAYA01',
    });
    expect(otherResolution.status).toBe('resolved');
    if (otherResolution.status === 'resolved') {
      expect(otherResolution.person.id).toBe(otherPerson.id);
      expect(otherResolution.person.fullName).toBe('Rival Rita');
      expect(otherResolution.employee).toBeNull(); // no employment there
    }

    // …while in ACME the SAME provider key still resolves to Maya, unchanged
    const acmeResolution = await resolveIdentity(fixture.member, {
      provider: 'slack',
      providerAccountId: 'U9MAYA01',
    });
    expect(acmeResolution.status).toBe('resolved');
    if (acmeResolution.status !== 'resolved') return;
    expect(acmeResolution.person.id).toBe(fixture.person.id);
    expect(acmeResolution.employee!.id).toBe(fixture.employee.id);
  });

  it('blocks cross-tenant access uniformly (no existence leak, ADR-0001)', async () => {
    const otherMember = memberContext(tenantOther);
    const slackJourney = fixture.providers.find((p) => p.persona.provider === 'slack')!;
    const acmeConversationId = slackJourney.firstTurn.message.conversationId;

    // the other tenant cannot deliver a challenge for Acme's identity…
    await expectErrorCode(
      ChannelsError,
      'invalid_provenance',
      () => deliverIdentityChallenge(otherMember, { identityId: slackJourney.firstTurn.identity.id }),
    );

    // …cannot read Acme's conversation…
    await expectErrorCode(
      ConversationsError,
      'conversation_not_found',
      () => getConversation(otherMember, acmeConversationId),
    );
    expect(
      await listMessages(otherMember, { conversationId: acmeConversationId }),
    ).toEqual([]);

    // …and cannot see Acme's employee directory record
    await expectErrorCode(
      PeopleError,
      'person_not_found',
      () => getPerson(otherMember, fixture.person.id),
    );
  });
});
