// W050 — Platform Surface End-to-End Fixture (tests/e2e/platform/).
//
// Work item (spec/work-items/WORK-ITEM-CATALOG.md, W050):
// "Prove: employee identity across channels → conversation → cognition →
//  management finding → API/MCP read → approval → notification → audit."
//
// The synthetic company: Harbor Robotics, a tenant whose returns flow is
// quietly breaching its cycle-time goal. ONE employee — Dana Okafor,
// Returns Operations Lead — talks to Aurum over TWO channel providers
// (WhatsApp and Slack). The fixture runs the whole chain once, end to end,
// through MODULE CONTRACTS ONLY (the import discipline of
// IMPLEMENTATION-STACK §2 / W050's scope boundaries), and then proves
// every hop from the PERSISTED, LINKED records — nothing is asserted from
// in-memory side channels:
//
//   1. EMPLOYEE IDENTITY ACROSS CHANNELS — both provider accounts are
//      registered on sight (channels receiveInbound), verified through
//      the REAL W002+W030 workflow (deliverIdentityChallenge over each
//      channel → the holder replies → completeIdentityChallenge) and
//      linked to one person/employee. Lock 15 is the acceptance: turns
//      from BOTH accounts attribute to the SAME person, and
//      people.resolveIdentity resolves both accounts to one employee.
//   2. CONVERSATION — the inbound turns are immutable transcript turns
//      (conversations), and recordExecutionLink ties the triggering
//      conversation to the cognitive execution (role 'triggered').
//   3. COGNITION — one explicit, resumable canonical-loop execution
//      (cognition startExecution + runNextStage) triggered by the
//      conversation: the employee's turns become observations, claims, a
//      belief, a goal evaluation, and a gated action proposal.
//   4. MANAGEMENT FINDING — the loop's analysis stage records the risk
//      finding on the append-only trace, and the processes module
//      reconstructs the returns flow from the SAME observations into a
//      first-class, deep-linkable ProcessFinding citing the exact
//      observation evidence.
//   5. API/MCP READ — DEVIATION (reported in the delivery): W038 (public
//      API) and W039 (MCP) — and W033/W028 per the dependency DAG — are
//      NOT in repository state at the reviewed base 8f2096a (no
//      src/modules/api, no src/mcp, no src/app/api). The read link is
//      therefore exercised at the CONTRACT SEAM those surfaces are
//      architected to delegate to (IMPLEMENTATION-STACK §5: route
//      handlers / MCP server "authenticate, scope tenant, delegate to
//      module contracts"): the manager reads the finding, the trace and
//      the pending approval through the contracts. No API/MCP surface is
//      fabricated inside this fixture — a test-local mock would prove
//      nothing about the real surface and would silently redesign the
//      architecture (GOVERNANCE.md). When W038/W039 merge, this fixture
//      is the place to route link 5 through them.
//   6. APPROVAL — the tenant's authority matrix (actions) gates the
//      proposed employee-messaging ASK behind human approval; the
//      execution suspends 'awaiting_approval'; an authorized manager
//      principal (a different principal than the requester — separation
//      of duties) decides; the pump releases the suspension and the loop
//      completes with the 'action-authorized' outcome.
//   7. NOTIFICATION — the approval outcome is notified to the employee
//      over the SAME channel she used (notifications → channels
//      sendOutbound): the delivery is authority-gated, transport-receipted
//      and audited, and lands as an immutable outbound transcript turn.
//   8. AUDIT — the whole chain is reconstructable from append-only
//      surfaces by linked ids (§24):
//      conversation turn → observation → claim → belief → trace finding +
//      process finding → action request + approval decision → outcome →
//      notification + audited attempt + outbound turn. Every read in the
//      chain is tenant-scoped: a foreign tenant sees nothing (the
//      platform-surface tenant-scoping requirement, §23/§32, ADR-0001).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  addTenantMember,
  provisionTenant,
  ORGANIZATIONS_AUTHORITY_PROVISION,
} from '@/modules/organizations/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
  listPersonIdentities,
  resolveIdentity,
} from '@/modules/people/contract';
import { IDENTITY_AUTHORITY_LINK } from '@/modules/identity/contract';
import {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  receiveInbound,
  registerChannelConnection,
  setChannelTransport,
  type CanonicalDeliveryRequest,
  type ChannelTransport,
  type InboundResult,
  type TransportReceipt,
} from '@/modules/channels/contract';
import {
  getConversation,
  listExecutionLinks,
  listMessages,
  recordExecutionLink,
  type Message,
} from '@/modules/conversations/contract';
import {
  getExecution,
  getExecutionStep,
  runNextStage,
  startExecution,
  type CognitiveExecutionTrace,
} from '@/modules/cognition/contract';
import { createGoal, type Goal } from '@/modules/goals/contract';
import { getBelief, getClaim } from '@/modules/epistemics/contract';
import { getObservation } from '@/modules/observations/contract';
import {
  getProcessFinding,
  listProcessFindings,
  reconstructProcess,
  type Process,
  type ProcessFinding,
} from '@/modules/processes/contract';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  decideApproval,
  getActionRequest,
  listActionRequests,
  listApprovalDecisions,
  setAuthorityPolicy,
  type ActionRequest,
} from '@/modules/actions/contract';
import {
  createNotification,
  getNotification,
  listNotificationAttempts,
  type Notification,
  type NotificationAttempt,
} from '@/modules/notifications/contract';
import { runMigrations } from '../../../scripts/migrate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A provider-neutral transport that records every delivery request. */
class RecordingTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private static deliveryCounter = 0;

  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    RecordingTransport.deliveryCounter += 1;
    return {
      status: 'delivered',
      providerMessageId: `prov-out-${String(RecordingTransport.deliveryCounter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

const transport = new RecordingTransport();

// The synthetic company. The WhatsApp sending number and the Slack
// workspace/team are the tenant's two channel endpoints.
const TENANT_NAME = 'Harbor Robotics';
const WHATSAPP_SENDING_NUMBER = '+15550100000';
const SLACK_TEAM_ID = 'THARBOROPS';
const SLACK_RETURNS_CHANNEL = 'C7RETURNS';

// Dana Okafor — one employee, two channel accounts.
const DANA_NAME = 'Dana Okafor';
const DANA_WA_ACCOUNT = '+15557010203';
const DANA_SLACK_ACCOUNT = 'U8DANA01';

// Provider webhook payloads (the shapes the private adapters accept).
function whatsappPayload(text: string, wamid: string, epochSeconds: string): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: WHATSAPP_SENDING_NUMBER.replace('+', '') },
              contacts: [{ profile: { name: DANA_NAME }, wa_id: DANA_WA_ACCOUNT.replace('+', '') }],
              messages: [
                {
                  from: DANA_WA_ACCOUNT.replace('+', ''),
                  id: wamid,
                  timestamp: epochSeconds,
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function slackPayload(text: string, ts: string): Record<string, unknown> {
  return {
    type: 'event_callback',
    team_id: SLACK_TEAM_ID,
    event: { type: 'message', user: DANA_SLACK_ACCOUNT, text, ts, channel: SLACK_RETURNS_CHANNEL },
  };
}

/** The single-use verification code of one challenge delivery (never persisted). */
function codeOfDelivery(request: CanonicalDeliveryRequest): string {
  const match = /(\d{6})/.exec(request.message.text);
  if (match === null) throw new Error('transport carried no six-digit verification code');
  return match[1]!;
}

/** The returns-case id a transcript turn reports (e.g. "RET-1042"). */
function caseIdOf(text: string): string {
  const match = /RET-\d+/.exec(text);
  if (match === null) throw new Error(`transcript turn carries no returns-case id: ${text}`);
  return match[0]!;
}

/** The last transport delivery request (challenge deliveries go last-out). */
function lastTransportRequest(): CanonicalDeliveryRequest {
  const request = transport.requests.at(-1);
  if (request === undefined) throw new Error('no transport delivery request recorded');
  return request;
}

// ---------------------------------------------------------------------------
// Chain state — populated once by runPlatformSurfaceChain, asserted by the
// focused `it`s below (every field is a persisted record or its id).
// ---------------------------------------------------------------------------

interface ChainState {
  tenantId: string;
  ownerPrincipalId: string;
  directoryPrincipalId: string;
  managerPrincipalId: string;
  workerPrincipalId: string;
  personId: string;
  employeeId: string;
  waIdentityId: string;
  slackIdentityId: string;
  waFirstContact: InboundResult;
  slackFirstContact: InboundResult;
  evidenceTurnWa1: Message;
  evidenceTurnSlack: Message;
  evidenceTurnWa2: Message;
  goal: Goal;
  executionId: string;
  correlationId: string;
  observationIds: string[];
  claimId: string;
  beliefId: string;
  process: Process;
  processFinding: ProcessFinding;
  pendingRead: ActionRequest;
  actionRequestId: string;
  decidedRequest: ActionRequest;
  completedTrace: CognitiveExecutionTrace;
  notification: Notification;
  attempts: NotificationAttempt[];
  notificationTurn: Message;
}

const state = {} as ChainState;

function ownerCtx(): TenantContext {
  return { tenantId: state.tenantId, principalId: state.ownerPrincipalId, authority: [] };
}
function directoryCtx(): TenantContext {
  return {
    tenantId: state.tenantId,
    principalId: state.directoryPrincipalId,
    authority: [IDENTITY_AUTHORITY_LINK],
  };
}
function managerCtx(): TenantContext {
  return { tenantId: state.tenantId, principalId: state.managerPrincipalId, authority: [] };
}
function managerAdminCtx(): TenantContext {
  return {
    tenantId: state.tenantId,
    principalId: state.managerPrincipalId,
    authority: [ACTIONS_AUTHORITY_ADMINISTER],
  };
}
function approverCtx(): TenantContext {
  return {
    tenantId: state.tenantId,
    principalId: state.managerPrincipalId,
    authority: [ACTIONS_AUTHORITY_APPROVE],
  };
}
function workerCtx(): TenantContext {
  return { tenantId: state.tenantId, principalId: state.workerPrincipalId, authority: [] };
}
function foreignCtx(): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [] };
}

/** The full verified-linking workflow for one channel account (W002 via W030). */
async function verifyAccountOverChannel(provider: 'whatsapp' | 'slack', firstContact: InboundResult): Promise<void> {
  const delivery = await deliverIdentityChallenge(workerCtx(), {
    identityId: firstContact.identity.id,
  });
  expect(delivery.receipt.status).toBe('delivered');
  // The holder replies over her own channel; the reply is a normal turn.
  const code = codeOfDelivery(lastTransportRequest());
  const reply = provider === 'whatsapp'
    ? whatsappPayload(code, `wamid.w050.${String(transport.requests.length).padStart(4, '0')}`, '1760426200')
    : slackPayload(code, '1760426350.000100');
  await receiveInbound(workerCtx(), { provider, payload: reply });
  const verified = await completeIdentityChallenge(workerCtx(), {
    identityId: firstContact.identity.id,
    code,
  });
  expect(verified.status).toBe('verified');
  expect(verified.verificationMethod).toBe('challenge_response');
}

/** Runs the whole W050 chain once, in order, through the module contracts. */
async function runPlatformSurfaceChain(): Promise<void> {
  // --- 0) the tenant, its members and its channel endpoints -------------
  const ownerPrincipalId = newId();
  const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };
  const tenant = await provisionTenant(platform, {
    name: TENANT_NAME,
    ownerPrincipalId,
    defaultWorkspaceName: 'Operations',
  });
  state.tenantId = tenant.id;
  state.ownerPrincipalId = ownerPrincipalId;

  // The owner adds the directory admin (links identities), the manager
  // (administers policy + decides approvals) and the cognition worker.
  state.directoryPrincipalId = newId();
  await addTenantMember(ownerCtx(), { principalId: state.directoryPrincipalId, role: 'admin' });
  state.managerPrincipalId = newId();
  await addTenantMember(ownerCtx(), { principalId: state.managerPrincipalId, role: 'admin' });
  state.workerPrincipalId = newId();
  await addTenantMember(ownerCtx(), { principalId: state.workerPrincipalId, role: 'member' });

  setChannelTransport(transport);
  await registerChannelConnection(workerCtx(), {
    provider: 'whatsapp',
    providerAccountId: WHATSAPP_SENDING_NUMBER,
    displayName: 'Harbor Ops WhatsApp',
    credentialRef: 'secret-store://whatsapp/harbor-ops',
  });
  await registerChannelConnection(workerCtx(), {
    provider: 'slack',
    providerAccountId: SLACK_TEAM_ID,
    displayName: 'Harbor Ops Slack',
    credentialRef: 'secret-store://slack/harbor-ops',
  });

  // --- 1) the employee and her two channel identities -------------------
  const person = await createPerson(directoryCtx(), {
    fullName: DANA_NAME,
    email: 'dana.okafor@harbor.example',
  });
  state.personId = person.id;
  const employee = await createEmployee(directoryCtx(), {
    personId: person.id,
    employeeNumber: 'E-2047',
    title: 'Returns Operations Lead',
    department: 'Operations',
  });
  state.employeeId = employee.id;

  // First contact over WhatsApp: the account is registered on sight and
  // is unverified — its turns stay `external` (lock 15: no pseudo-employees).
  state.waFirstContact = await receiveInbound(workerCtx(), {
    provider: 'whatsapp',
    payload: whatsappPayload(
      'Aurum, this is Dana from returns ops — customs checks are stalling our returns badly.',
      'wamid.w050.0101',
      '1760426100',
    ),
  });
  expect(state.waFirstContact.identity.status).toBe('unverified');
  expect(state.waFirstContact.message.actor.kind).toBe('external');

  // The real verified-linking workflow over WhatsApp, then the link.
  await verifyAccountOverChannel('whatsapp', state.waFirstContact);
  const waLinked = await linkExternalIdentity(directoryCtx(), {
    personId: person.id,
    identityId: state.waFirstContact.identity.id,
  });
  state.waIdentityId = waLinked.identity.id;

  // The same workflow over Slack — a second provider, same employee.
  state.slackFirstContact = await receiveInbound(workerCtx(), {
    provider: 'slack',
    payload: slackPayload(
      'Dana here on Slack too — same problem from my side, returns are piling up at customs.',
      '1760426300.000100',
    ),
  });
  expect(state.slackFirstContact.identity.status).toBe('unverified');
  await verifyAccountOverChannel('slack', state.slackFirstContact);
  const slackLinked = await linkExternalIdentity(directoryCtx(), {
    personId: person.id,
    identityId: state.slackFirstContact.identity.id,
  });
  state.slackIdentityId = slackLinked.identity.id;

  // Dana's evidence turns — now person-attributed on BOTH providers.
  state.evidenceTurnWa1 = (
    await receiveInbound(workerCtx(), {
      provider: 'whatsapp',
      payload: whatsappPayload(
        'RET-1042 update: customs check still waiting on broker paperwork — day four.',
        'wamid.w050.0102',
        '1760426400',
      ),
    })
  ).message;
  state.evidenceTurnSlack = (
    await receiveInbound(workerCtx(), {
      provider: 'slack',
      payload: slackPayload(
        'RET-1043 cleared customs only after I chased the broker manually — three days lost.',
        '1760426500.000100',
      ),
    })
  ).message;
  state.evidenceTurnWa2 = (
    await receiveInbound(workerCtx(), {
      provider: 'whatsapp',
      payload: whatsappPayload(
        'RET-1042 day five: broker says the customs paperwork is still missing.',
        'wamid.w050.0103',
        '1760426600',
      ),
    })
  ).message;

  // --- the management context: the goal the chain is about --------------
  state.goal = await createGoal(managerCtx(), {
    title: 'Keep the returns cycle under three days',
    objective: 'Hold end-to-end returns processing at or under three days per case.',
    desiredState: 'Every returns case completes in at most three days',
    metrics: [{ name: 'returns-cycle-days', unit: 'days', direction: 'at_most', threshold: 3 }],
    horizonEnd: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    owner: { kind: 'person', id: state.managerPrincipalId, label: 'Mara Voss (COO)' },
    priority: 'high',
    evidenceSources: [
      { kind: 'source', label: 'Returns tracker' },
      { kind: 'person', label: 'Returns Operations Lead' },
    ],
    successCriteria: 'All returns cases complete within three days for one full quarter',
    actor: { kind: 'person', id: state.managerPrincipalId, label: 'Mara Voss (COO)' },
    rationale: 'board operations target for the half',
  });

  // Tenant policy: asking employees requires human approval at ASK —
  // the approval gate of the chain (§20 authority matrix).
  await setAuthorityPolicy(managerAdminCtx(), {
    actionKind: 'employee-messaging',
    approvalLevels: ['ASK'],
    note: 'every outbound question to an employee is reviewed by management',
  });

  // --- 3) cognition: one explicit canonical-loop cycle -------------------
  const trace = await startExecution(workerCtx(), {
    trigger: {
      kind: 'conversation',
      id: state.evidenceTurnWa1.conversationId,
      label: 'Dana Okafor — WhatsApp returns report',
    },
    focus: { topics: ['returns', 'customs', 'bottleneck'], entities: [] },
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'employee report of a returns-flow stall — evaluate against the cycle-time goal',
  });
  state.executionId = trace.id;
  state.correlationId = trace.correlationId;

  // Stage 1 — observation: Dana's turns become immutable evidence.
  const turnObservation = (message: Message) => {
    const text = (message.payload as { content: { text: string } }).content.text;
    return {
      kind: 'returns.customs-check',
      payload: {
        caseId: caseIdOf(text),
        conversationId: message.conversationId,
        messageId: message.id,
        channel: message.channel,
        text,
      },
      observedAt: message.sentAt,
      source: { kind: 'person' as const, id: state.personId, label: DANA_NAME },
      channel: message.channel,
      confidence: { value: 0.8, method: 'channel-attribution', basis: 'person-verified channel turn' },
    };
  };
  const observed = await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'observation',
    record: [
      turnObservation(state.evidenceTurnWa1),
      turnObservation(state.evidenceTurnSlack),
      turnObservation(state.evidenceTurnWa2),
    ],
  });
  state.observationIds = (
    observed.steps.find((step) => step.stage === 'observation')!.result as {
      observationIds: string[];
    }
  ).observationIds;

  // Stages 2–3: remember; no world change this cycle.
  await runNextStage(workerCtx(), { executionId: state.executionId, stage: 'evidence-memory' });
  await runNextStage(workerCtx(), { executionId: state.executionId, stage: 'world-update', update: null });

  // Stage 4 — epistemic evaluation: the claim the evidence supports.
  const evaluated = await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'epistemic-evaluation',
    claims: [
      {
        proposition:
          'Returns cases RET-1042 and RET-1043 stalled at the customs check for three to five days',
        subject: { kind: 'goals.goal', id: state.goal.id },
        confidence: { value: 0.85, method: 'channel-evidence', basis: 'three person-attributed channel turns' },
        evidenceObservationIds: state.observationIds,
        rationale: 'direct reports of the returns operations lead over two channels',
      },
    ],
  });
  state.claimId = (
    evaluated.steps.find((step) => step.stage === 'epistemic-evaluation')!.result as {
      claimIds: string[];
    }
  ).claimIds[0]!;

  // Stage 5 — goal evaluation: the focus relates to the active goal.
  await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'goal-evaluation',
    relatedGoalIds: [state.goal.id],
  });

  // Stages 6–7: no unknowns or missions this cycle; no acquisition.
  await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'unknown-mission-evaluation',
    unknowns: [],
    missions: [],
  });
  await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'knowledge-acquisition',
    missionId: null,
  });

  // Stage 8 — model update: the working understanding, with the
  // alternative retained (lock 12: contradictions/alternatives survive).
  const modeled = await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'model-update',
    belief: {
      proposition: 'The customs check is the bottleneck of the returns cycle',
      confidence: { value: 0.8, method: 'channel-evidence', basis: 'claims over three channel turns' },
      supportingObservationIds: state.observationIds,
      supportingClaimIds: [state.claimId],
      alternatives: ['the broker is slow only for these two cases, not generally'],
      disconfirmation: 'a returns case clearing customs within a day',
      subject: { kind: 'goals.goal', id: state.goal.id },
      validFrom: new Date().toISOString(),
      rationale: 'derived from the cycle’s own claim',
    },
  });
  state.beliefId = (
    modeled.steps.find((step) => step.stage === 'model-update')!.result as {
      beliefId: string | null;
    }
  ).beliefId!;

  // Stage 9 — risk/opportunity/capability analysis: THE MANAGEMENT FINDING
  // recorded on the append-only trace, evidence- and goal-linked.
  await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'risk-opportunity-capability-analysis',
    findings: [
      {
        kind: 'risk',
        statement:
          'Returns cycle breaches the three-day goal: the customs check stalls cases for three to five days',
        evidenceObservationIds: state.observationIds,
        affectedGoalIds: [state.goal.id],
      },
    ],
  });

  // Stage 10 — the policy gate: propose the consequential action.
  const gated = await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'recommendation-ask-proposal-action',
    action: {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: {
        to: state.personId,
        channel: 'whatsapp',
        question:
          'Which customs-broker documents are still missing for RET-1042 and RET-1043?',
      },
      justification:
        'close the customs-check evidence gap behind the returns-cycle risk before escalating',
    },
  });
  expect(gated.state).toBe('awaiting_approval');
  state.actionRequestId = gated.pending.requestId!;

  // The conversation ↔ execution link (the trigger provenance of §24).
  await recordExecutionLink(workerCtx(), {
    conversationId: state.evidenceTurnWa1.conversationId,
    executionId: state.executionId,
    role: 'triggered',
  });

  // --- 4) the first-class management finding: process reconstruction -----
  // The processes module reconstructs the returns flow FROM THE SAME
  // observations and derives the evidence-cited finding management reads.
  state.process = await reconstructProcess(workerCtx(), {
    name: 'Returns processing',
    scope: {
      observationKinds: ['returns.customs-check'],
      caseKeyCandidates: ['caseId'],
    },
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'reconstruct the returns flow from the cycle’s observations (W050 fixture)',
  });
  const processFindings = await listProcessFindings(managerCtx(), { processId: state.process.id });
  const manual = processFindings.find((finding) => finding.kind === 'manual_effort');
  if (manual === undefined) throw new Error('no manual_effort process finding was derived');
  state.processFinding = manual;

  // --- 5) the API/MCP read (contract seam — see the DEVIATION header) ----
  // The manager reads the finding, the trace and the pending approval —
  // exactly the surface W038/W039 route handlers would delegate to.
  const analysisStep = await getExecutionStep(managerCtx(), {
    executionId: state.executionId,
    stage: 'risk-opportunity-capability-analysis',
  });
  expect(
    (analysisStep.result as { findings: { statement: string }[] }).findings.length,
  ).toBeGreaterThan(0);
  state.pendingRead = await getActionRequest(managerCtx(), { requestId: state.actionRequestId });
  expect(state.pendingRead.status).toBe('pending');
  const pendingFeed = await listActionRequests(managerCtx(), { status: 'pending' });
  expect(pendingFeed.some((request) => request.id === state.actionRequestId)).toBe(true);

  // --- 6) approval: the human decision releases the gate -----------------
  state.decidedRequest = await decideApproval(approverCtx(), {
    requestId: state.actionRequestId,
    decision: 'approve',
    note: 'targeted question — close the customs gap before escalating',
  });
  expect(state.decidedRequest.status).toBe('approved');

  // The pump resumes: gate stage completes, outcome + learning close the loop.
  await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'recommendation-ask-proposal-action',
  });
  await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'outcome',
    summary:
      'approved targeted follow-up question to the returns operations lead about missing customs-broker documents',
  });
  state.completedTrace = await runNextStage(workerCtx(), {
    executionId: state.executionId,
    stage: 'learning',
    knowledge: {
      title: 'Customs-check documentation is the returns-cycle constraint',
      summary:
        'Two returns cases stalled three to five days at customs pending broker paperwork; the gap is document availability, not transport.',
      topics: ['returns', 'customs', 'bottleneck'],
    },
  });
  expect(state.completedTrace.state).toBe('completed');

  // --- 7) notification: the employee learns the outcome on her channel --
  const notified = await createNotification(workerCtx(), {
    kind: 'approval.decided',
    recipient: {
      provider: 'whatsapp',
      providerAccountId: DANA_WA_ACCOUNT,
      displayName: DANA_NAME,
    },
    subject: 'Approved: customs-check follow-up question',
    body:
      'Mara approved Aurum’s follow-up question about the missing customs-broker documents for RET-1042 and RET-1043. It will reach you on this channel.',
    data: { actionRequestId: state.actionRequestId, executionId: state.executionId },
    correlationId: state.correlationId,
  });
  expect(notified.deduped).toBe(false);
  state.notification = notified.notification;
  expect(state.notification.status).toBe('delivered');
  state.attempts = await listNotificationAttempts(managerCtx(), {
    notificationId: state.notification.id,
  });

  // The notification's immutable outbound transcript turn (what was
  // actually sent — the channels contract recorded it after delivery).
  const outboundTurns = await listMessages(managerCtx(), {
    channel: 'whatsapp',
    direction: 'outbound',
  });
  const turn = outboundTurns.find((message) => {
    const payload = message.payload as { kind: string; content: { text?: string } };
    return payload.kind === 'message' && payload.content.text?.includes('RET-1042') === true;
  });
  if (turn === undefined) throw new Error('the notification transcript turn was not recorded');
  state.notificationTurn = turn;
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await runMigrations(getDb());
  await runPlatformSurfaceChain();
});

afterAll(async () => {
  setChannelTransport(null);
  await closeDb();
});

describe('W050 — Platform Surface End-to-End Fixture', () => {
  // -----------------------------------------------------------------------
  // Link 1 — employee identity across channels (lock 15)
  // -----------------------------------------------------------------------
  it('proves one employee across two channel providers (verified linking, person attribution)', async () => {
    // Both accounts went through the real challenge workflow and are now
    // verified + linked to the one person/employee.
    const identities = await listPersonIdentities(managerCtx(), state.personId);
    expect(identities.map((identity) => identity.provider).sort()).toEqual(['slack', 'whatsapp']);
    for (const identity of identities) {
      expect(identity.status).toBe('verified');
      expect(identity.subjectId).toBe(state.personId);
    }

    // Turns from BOTH providers attribute to the SAME person — channel
    // accounts never became disconnected pseudo-employees (lock 15).
    for (const turn of [state.evidenceTurnWa1, state.evidenceTurnSlack, state.evidenceTurnWa2]) {
      expect(turn.actor.kind).toBe('person');
      expect(turn.actor.id).toBe(state.personId);
    }
    expect(state.evidenceTurnWa1.actor.identityId).toBe(state.waIdentityId);
    expect(state.evidenceTurnSlack.actor.identityId).toBe(state.slackIdentityId);

    // The identity resolution surface agrees: both accounts resolve to
    // the same employee.
    for (const [provider, accountId] of [
      ['whatsapp', DANA_WA_ACCOUNT],
      ['slack', DANA_SLACK_ACCOUNT],
    ] as const) {
      const resolution = await resolveIdentity(managerCtx(), {
        provider,
        providerAccountId: accountId,
      });
      expect(resolution.status).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(resolution.person.id).toBe(state.personId);
      expect(resolution.employee?.id).toBe(state.employeeId);
    }

    // The verification code never reached the DELIVERED transcript turns:
    // the outbound verification turn carries a redaction marker instead of
    // the credential value (IMPLEMENTATION-STACK §8).
    const outboundTurns = await listMessages(managerCtx(), {
      channel: 'whatsapp',
      direction: 'outbound',
    });
    const verificationTurns = outboundTurns.concat(
      await listMessages(managerCtx(), { channel: 'slack', direction: 'outbound' }),
    ).filter((message) => (message.payload as { kind?: string }).kind === 'verification_code');
    expect(verificationTurns).toHaveLength(2); // one per channel challenge
    for (const message of verificationTurns) {
      const serialized = JSON.stringify(message.payload);
      expect(/\b\d{6}\b/.test(serialized)).toBe(false);
      expect(serialized).toContain('redaction');
    }
  });

  // -----------------------------------------------------------------------
  // Link 2 — conversation
  // -----------------------------------------------------------------------
  it('proves the conversation: immutable turns and the triggered-execution link', async () => {
    // Dana's turns live in two provider-threaded conversations. (The
    // outbound challenge deliveries open their own auto-created threads —
    // they are recorded without a caller-supplied conversation.)
    const waConversation = await getConversation(managerCtx(), state.evidenceTurnWa1.conversationId);
    // first contact + challenge reply + 2 evidence turns
    expect(waConversation.messageCount).toBe(4);
    const slackConversation = await getConversation(managerCtx(), state.evidenceTurnSlack.conversationId);
    // first contact + challenge reply + evidence turn
    expect(slackConversation.messageCount).toBe(3);

    // The WhatsApp conversation is what triggered the cognitive execution.
    const links = await listExecutionLinks(managerCtx(), {
      conversationId: waConversation.id,
      role: 'triggered',
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.executionId).toBe(state.executionId);

    // The execution's own trigger points back at the same conversation —
    // the §24 chain closes in both directions.
    const execution = await getExecution(managerCtx(), { executionId: state.executionId });
    expect(execution.trigger.kind).toBe('conversation');
    expect(execution.trigger.id).toBe(waConversation.id);
  });

  // -----------------------------------------------------------------------
  // Link 3 — cognition
  // -----------------------------------------------------------------------
  it('proves the cognition cycle: observations, claim, belief, goal link, full trace', async () => {
    const trace = await getExecution(managerCtx(), { executionId: state.executionId });
    expect(trace.state).toBe('completed');
    expect(trace.completedStages).toBe(12);
    expect(trace.steps).toHaveLength(12);
    expect(trace.startedByPrincipal).toBe(state.workerPrincipalId);

    // The observation stage recorded three immutable observations, each
    // linked back to the transcript turn it came from. (The stage result's
    // id list is SORTED — the linkage is asserted by payload, not order.)
    expect(state.observationIds).toHaveLength(3);
    const observations = await Promise.all(
      state.observationIds.map((id) => getObservation(managerCtx(), id)),
    );
    const waObservation = observations.find(
      (candidate) =>
        (candidate.payload as { messageId?: string }).messageId === state.evidenceTurnWa1.id,
    );
    expect(waObservation).toBeDefined();
    const observation = waObservation!;
    expect(observation.source.kind).toBe('person');
    expect(observation.source.id).toBe(state.personId);
    const payload = observation.payload as {
      messageId: string;
      conversationId: string;
      channel: string;
    };
    expect(payload.conversationId).toBe(state.evidenceTurnWa1.conversationId);
    expect(payload.channel).toBe('whatsapp');
    // one observation per evidence turn — the slack turn too:
    expect(
      observations.some(
        (candidate) =>
          (candidate.payload as { messageId?: string }).messageId === state.evidenceTurnSlack.id,
      ),
    ).toBe(true);

    // The claim cites the observations; the belief cites claim + observations.
    const claim = await getClaim(managerCtx(), { claimId: state.claimId });
    expect(claim.proposition).toContain('RET-1042');
    expect([...claim.evidenceObservationIds].sort()).toEqual([...state.observationIds].sort());
    const belief = await getBelief(managerCtx(), { beliefId: state.beliefId });
    expect(belief.statement.proposition).toContain('customs check');
    expect(belief.provenance.observationIds).toHaveLength(3);
    expect(belief.statement.alternatives).toHaveLength(1);
    expect(belief.statement.supportingClaimIds).toContain(state.claimId);

    // The goal evaluation related the focus to the active goal.
    const goalStep = trace.steps.find((step) => step.stage === 'goal-evaluation')!.result as {
      goalIds: string[];
    };
    expect(goalStep.goalIds).toEqual([state.goal.id]);
  });

  // -----------------------------------------------------------------------
  // Link 4 — management finding
  // -----------------------------------------------------------------------
  it('proves the management finding: on the trace and as a first-class evidence-cited object', async () => {
    // The trace's analysis stage carries the risk finding, evidence- and
    // goal-linked.
    const analysisStep = await getExecutionStep(managerCtx(), {
      executionId: state.executionId,
      stage: 'risk-opportunity-capability-analysis',
    });
    const finding = (analysisStep.result as {
      findings: { kind: string; statement: string; evidenceObservationIds: string[]; affectedGoalIds: string[] }[];
    }).findings[0]!;
    expect(finding.kind).toBe('risk');
    expect(finding.statement).toContain('three-day goal');
    expect(finding.evidenceObservationIds).toHaveLength(3);
    expect(finding.affectedGoalIds).toEqual([state.goal.id]);

    // The processes module reconstructed the returns flow from the SAME
    // observations and derived the first-class finding — deep-linkable,
    // evidence-cited, deterministic.
    const deepLinked = await getProcessFinding(managerCtx(), { findingId: state.processFinding.id });
    expect(deepLinked.kind).toBe('manual_effort');
    expect(deepLinked.subject).toBe('step:returns.customs-check');
    expect(deepLinked.processId).toBe(state.process.id);
    expect(deepLinked.evidenceObservationIds.sort()).toEqual([...state.observationIds].sort());
    expect(deepLinked.confidence).toBeGreaterThan(0.5);
    // The reconstruction scope is exactly the cycle's observations.
    expect(state.process.stats.observationCount).toBe(3);
    expect(state.process.stats.eventCount).toBe(0);
    expect(state.process.stats.manualShare).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Link 5 — the API/MCP read (contract seam; DEVIATION: W038/W039 absent)
  // -----------------------------------------------------------------------
  it('proves the management read surface: finding, trace and approval feed through the contracts', async () => {
    // What the manager read BEFORE deciding (captured during the chain):
    // the pending request with its policy evaluation snapshot.
    expect(state.pendingRead.status).toBe('pending');
    expect(state.pendingRead.actionKind).toBe('employee-messaging');
    expect(state.pendingRead.authorityLevel).toBe('ASK');
    expect(state.pendingRead.evaluation.outcome).toBe('approval_required');
    expect(state.pendingRead.requestedBy).toBe(state.workerPrincipalId);

    // The same records remain readable after the decision — now with the
    // decision landed (the approvals surface, §21).
    const request = await getActionRequest(managerCtx(), { requestId: state.actionRequestId });
    expect(request.status).toBe('approved');
    const approvalsFeed = await listActionRequests(managerCtx(), { status: 'approved' });
    expect(approvalsFeed.some((entry) => entry.id === state.actionRequestId)).toBe(true);

    // The finding and the trace stay readable through the same seam.
    const finding = await getProcessFinding(managerCtx(), { findingId: state.processFinding.id });
    expect(finding.summary).toContain('human-performed');
    const trace = await getExecution(managerCtx(), { executionId: state.executionId });
    expect(trace.outcome?.kind).toBe('action-authorized');
  });

  // -----------------------------------------------------------------------
  // Link 6 — approval
  // -----------------------------------------------------------------------
  it('proves the approval: policy gate, human decision, released execution, authorized outcome', async () => {
    // The request went through the tenant's authority matrix (the policy
    // row the manager administers), not an ad-hoc decision.
    const request = await getActionRequest(managerCtx(), { requestId: state.actionRequestId });
    expect(request.evaluation.outcome).toBe('approval_required');
    expect(request.evaluation.resolvedVia).toBe('kind');

    // The decision trail is append-only and principal-attributed — the
    // manager, not the requesting worker (separation of duties).
    const decisions = await listApprovalDecisions(managerCtx(), { requestId: state.actionRequestId });
    const human = decisions.filter((decision) => decision.decidedBy === 'principal');
    expect(human).toHaveLength(1);
    expect(human[0]!.decision).toBe('approve');
    expect(human[0]!.principalId).toBe(state.managerPrincipalId);
    expect(human[0]!.principalId).not.toBe(request.requestedBy);

    // The gate stage's recorded result: suspended, then resolved approved.
    const gateStep = state.completedTrace.steps.find(
      (step) => step.stage === 'recommendation-ask-proposal-action',
    )!.result as {
      gate: string;
      resolution: string;
      actionRequest: { id: string; status: string };
    };
    expect(gateStep.gate).toBe('approval_required');
    expect(gateStep.resolution).toBe('approved');
    expect(gateStep.actionRequest.id).toBe(state.actionRequestId);
    expect(gateStep.actionRequest.status).toBe('approved');

    // The loop closed with the authorized outcome, linked to the request.
    expect(state.completedTrace.state).toBe('completed');
    expect(state.completedTrace.outcome?.kind).toBe('action-authorized');
    expect(state.completedTrace.outcome?.actionRequestId).toBe(state.actionRequestId);
  });

  // -----------------------------------------------------------------------
  // Link 7 — notification
  // -----------------------------------------------------------------------
  it('proves the notification: policy-snapshotted, gated, delivered on the employee’s channel, audited', async () => {
    // The notification carries the resolved policy snapshot and the
    // correlation identity of the execution's logical flow (§25).
    const notification = await getNotification(managerCtx(), {
      notificationId: state.notification.id,
    });
    expect(notification.status).toBe('delivered');
    expect(notification.deliveryClass).toBe('urgent');
    expect(notification.recipient).toMatchObject({
      provider: 'whatsapp',
      providerAccountId: DANA_WA_ACCOUNT,
    });
    expect(notification.correlationId).toBe(state.correlationId);
    expect((notification.data as { actionRequestId: string }).actionRequestId).toBe(state.actionRequestId);

    // The delivery attempt is audited: authority-gated (approved through
    // the actions matrix under 'notification-delivery'/ASK), delivered,
    // provider-receipted.
    expect(state.attempts).toHaveLength(1);
    const attempt = state.attempts[0]!;
    expect(attempt.attemptKind).toBe('initial');
    expect(attempt.outcome).toBe('delivered');
    expect(attempt.gateStatus).toBe('approved');
    expect(attempt.providerMessageId).not.toBeNull();

    // The transcript records what was actually sent — an immutable
    // outbound turn on Dana's own channel, citing the approved follow-up.
    expect(state.notificationTurn.direction).toBe('outbound');
    expect(state.notificationTurn.channel).toBe('whatsapp');
    expect(state.notificationTurn.providerMessageId).toBe(attempt.providerMessageId);
    const turnPayload = state.notificationTurn.payload as {
      kind: string;
      to: { providerAccountId: string };
      content: { text: string };
    };
    expect(turnPayload.kind).toBe('message');
    expect(turnPayload.to.providerAccountId).toBe(DANA_WA_ACCOUNT);
    expect(turnPayload.content.text).toContain('RET-1042');
  });

  // -----------------------------------------------------------------------
  // Link 8 — audit: the whole chain reconstructable by linked ids (§24)
  // -----------------------------------------------------------------------
  it('proves the audit chain: every hop reconstructable from append-only surfaces', async () => {
    const ctx = managerCtx();

    // conversation → (execution link) → execution
    const links = await listExecutionLinks(ctx, { executionId: state.executionId });
    expect(links[0]!.conversationId).toBe(state.evidenceTurnWa1.conversationId);

    // conversation turn → observation (payload linkage both ways). The
    // stage result's id list is sorted, so the linkage is by payload.
    const observations = await Promise.all(
      state.observationIds.map((id) => getObservation(ctx, id)),
    );
    const observation = observations.find(
      (candidate) =>
        (candidate.payload as { messageId?: string }).messageId === state.evidenceTurnWa1.id,
    )!;
    const linkedTurn = await listMessages(ctx, {
      conversationId: state.evidenceTurnWa1.conversationId,
      limit: 100,
    });
    const referenced = linkedTurn.find(
      (message) => message.id === (observation.payload as { messageId: string }).messageId,
    );
    expect(referenced).toBeDefined();
    expect(referenced?.actor.id).toBe(state.personId);

    // observation → claim → belief (provenance chain, lock 11)
    const claim = await getClaim(ctx, { claimId: state.claimId });
    expect(claim.evidenceObservationIds).toContain(observation.id);
    const belief = await getBelief(ctx, { beliefId: state.beliefId });
    expect(belief.statement.supportingClaimIds).toContain(state.claimId);

    // observations → trace finding + process finding (same evidence)
    const analysisStep = await getExecutionStep(ctx, {
      executionId: state.executionId,
      stage: 'risk-opportunity-capability-analysis',
    });
    const traceFinding = (analysisStep.result as { findings: { evidenceObservationIds: string[] }[] }).findings[0]!;
    const processFinding = await getProcessFinding(ctx, { findingId: state.processFinding.id });
    expect(traceFinding.evidenceObservationIds.sort()).toEqual(processFinding.evidenceObservationIds.sort());
    expect(traceFinding.evidenceObservationIds.sort()).toEqual([...state.observationIds].sort());

    // finding → action request → decision → outcome (the §24 tail)
    const request = await getActionRequest(ctx, { requestId: state.actionRequestId });
    expect(request.payload).toMatchObject({ to: state.personId, channel: 'whatsapp' });
    const decisions = await listApprovalDecisions(ctx, { requestId: state.actionRequestId });
    expect(decisions).toHaveLength(1);
    const execution = await getExecution(ctx, { executionId: state.executionId });
    expect(execution.outcome?.actionRequestId).toBe(request.id);

    // outcome → notification → attempt → outbound turn (§25 correlation).
    // The notification's own delivery went through a SECOND authority gate
    // ('notification-delivery'/ASK) — a distinct request from the approved
    // employee-messaging request the notification reports on.
    const notification = await getNotification(ctx, { notificationId: state.notification.id });
    expect(notification.correlationId).toBe(execution.correlationId);
    expect(notification.actionRequestId).not.toBeNull();
    expect(notification.actionRequestId).not.toBe(request.id);
    const deliveryGate = await getActionRequest(ctx, { requestId: notification.actionRequestId! });
    expect(deliveryGate.actionKind).toBe('notification-delivery');
    expect(deliveryGate.status).toBe('approved');
    const attempts = await listNotificationAttempts(ctx, { notificationId: notification.id });
    expect(attempts[0]!.providerMessageId).toBe(state.notificationTurn.providerMessageId);
    expect(state.notificationTurn.providerMessageId).not.toBeNull();

    // The learning stage captured the durable outcome-linked knowledge.
    const learningStep = execution.steps.find((step) => step.stage === 'learning')!.result as {
      knowledgeEntryId: string | null;
    };
    expect(learningStep.knowledgeEntryId).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Platform-surface tenant scoping (§23/§32, ADR-0001): every read in the
  // chain is invisible to a foreign tenant — no existence leaks.
  // -----------------------------------------------------------------------
  it('keeps every hop of the chain invisible to another tenant', async () => {
    const foreign = foreignCtx();
    // A second tenant with its own channel endpoint proves the reads are
    // tenant-scoped by isolation, not by id accident.
    await registerChannelConnection(foreign, {
      provider: 'whatsapp',
      providerAccountId: '+15550109999',
      credentialRef: 'secret-store://whatsapp/other-tenant',
    });

    // identity resolution: the foreign tenant does not know the account.
    await expect(
      resolveIdentity(foreign, { provider: 'whatsapp', providerAccountId: DANA_WA_ACCOUNT }),
    ).resolves.toMatchObject({ status: 'unknown_identity' });

    // conversation / transcript
    await expect(
      getConversation(foreign, state.evidenceTurnWa1.conversationId),
    ).rejects.toMatchObject({ code: 'conversation_not_found' });

    // cognitive execution trace
    await expect(
      getExecution(foreign, { executionId: state.executionId }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });

    // evidence (observations / claim / belief)
    await expect(getObservation(foreign, state.observationIds[0]!)).rejects.toMatchObject({
      code: 'observation_not_found',
    });
    await expect(getClaim(foreign, { claimId: state.claimId })).rejects.toMatchObject({
      code: 'claim_not_found',
    });
    await expect(getBelief(foreign, { beliefId: state.beliefId })).rejects.toMatchObject({
      code: 'belief_not_found',
    });

    // the management finding
    await expect(
      getProcessFinding(foreign, { findingId: state.processFinding.id }),
    ).rejects.toMatchObject({ code: 'finding_not_found' });

    // the approval surface
    await expect(
      getActionRequest(foreign, { requestId: state.actionRequestId }),
    ).rejects.toMatchObject({ code: 'action_request_not_found' });
    await expect(
      listActionRequests(foreign, { status: 'approved' }),
    ).resolves.toHaveLength(0);

    // the notification and its audit
    await expect(
      getNotification(foreign, { notificationId: state.notification.id }),
    ).rejects.toMatchObject({ code: 'notification_not_found' });
    await expect(
      listNotificationAttempts(foreign, { notificationId: state.notification.id }),
    ).rejects.toMatchObject({ code: 'notification_not_found' });
  });
});
