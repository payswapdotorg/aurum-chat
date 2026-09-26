// W097 — the Meeting and Cellular End-to-End Fixture runner.
//
// The interpreter that executes the machine-readable fixture at
// tests/e2e/fixtures/meeting-cellular/meeting-cellular.fixture.json against
// the REAL module services of this repository:
//
//   * the WORLD is materialized through the real people/identity/actions
//     contracts (persons, employees, verified identities, meeting/realtime/
//     cellular connections, cellular + authority policies) into a freshly
//     minted tenant per scenario — registry counts and trail assertions stay
//     deterministic;
//   * the SCRIPT steps drive the real module edges: provider webhook
//     envelopes are fed through receiveMeetingWebhook /
//     receiveRealtimeEvent / receiveCellularEvent (parsed by the modules'
//     PRIVATE zoom/livekit/twilio adapters), domain operations call the
//     contract functions directly, and deliveries go through scripted
//     transports implementing the modules' provider-neutral ports;
//   * the EXPECTATIONS (per-step and final) read DURABLE state back through
//     the contracts — no assertion inspects a double's internals as its
//     primary evidence: every hop is proven by the records the modules
//     persisted (the transport request counts are the one deliberate
//     exception: they ARE the outbound envelope artifacts the
//     recipient-without-Aurum evidence is drawn from).
//
// The provider doubles are contract-faithful by construction: the scripted
// transports implement the transport/delivery PORTS the modules own, and
// every envelope is the documented adapter shape (see the adapters' header
// comments). No live telephony or meeting-provider credentials exist in this
// environment — the live paths stay fixture-covered (environment-dependent).
//
// Per-file isolation: the journey suite boots its own embedded PostgreSQL
// (PGlite `:memory:`) exactly like every other integration suite.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as meetingsContract from '@/modules/meetings/contract';
import * as realtimeContract from '@/modules/realtime/contract';
import * as cellularContract from '@/modules/cellular/contract';
import * as unifiedIdentityContract from '@/modules/unified-identity/contract';
import {
  attestIdentity,
  attachVerifiedSubject,
  registerExternalIdentity,
  type ChannelProvider,
} from '@/modules/identity/contract';
import { createEmployee, createPerson } from '@/modules/people/contract';
import {
  decideApproval,
  getActionRequest,
  listApprovalDecisions,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { listNotifications } from '@/modules/notifications/contract';
import { listMessages } from '@/modules/conversations/contract';
import { getObservation, listObservations } from '@/modules/observations/contract';
import { createWorkflowEngine, getRun, type WorkflowEnginePort } from '@/modules/workflow/contract';
import type {
  CellularProvider,
  CellularReach,
  CellularSmsRequest,
  CellularTransport,
  CellularVoiceRequest,
} from '@/modules/cellular/types';
import type {
  RealtimeEventKind,
  RealtimeRecordingArtifactInfo,
  RealtimeSession,
  RealtimeTransport,
} from '@/modules/realtime/types';
import type { UnifiedUnifySummary } from '@/modules/unified-identity/types';

// ---------------------------------------------------------------------------
// The fixture's TypeScript view (the versioned JSON schema)
// ---------------------------------------------------------------------------

export const FIXTURE_SCHEMA = 'aurum.meeting-cellular-fixture';
export const FIXTURE_VERSION = 1;

export interface FixtureVerifiedIdentity {
  provider: ChannelProvider;
  providerAccountId: string;
  evidence: string;
}

export interface FixturePerson {
  key: string;
  fullName: string;
  employee: { title: string; department: string } | null;
  verifiedIdentities: FixtureVerifiedIdentity[];
}

export interface FixtureConnectionSpec {
  provider: string;
  providerAccountId: string;
  authKind?: string;
  credentialRef: string;
  displayName: string;
  phoneNumber?: string;
}

export interface FixtureWorld {
  people: FixturePerson[];
  connections: {
    meetings: FixtureConnectionSpec | null;
    realtime: FixtureConnectionSpec | null;
    cellular: FixtureConnectionSpec | null;
  };
  cellularPolicy: {
    voiceFallback?: string;
    smsMaxAttempts?: number;
    retryBackoffSeconds?: number;
  } | null;
  authorityPolicy: {
    actionKind?: string | null;
    approvalLevels?: string[];
    forbiddenLevels?: string[];
    note?: string | null;
  } | null;
}

/** One assertion of the fixture's vocabulary (see the fixture README). */
export interface FixtureAssertion {
  kind: string;
  [field: string]: unknown;
}

export interface FixtureStep {
  op: string;
  note?: string;
  expect?: FixtureAssertion[];
  expectError?: { code: string } | null;
  payload?: unknown;
  bindSession?: string | null;
  key?: string;
  meetingSessionKey?: string;
  sessionKey?: string;
  title?: string;
  participant?: string;
  consent?: 'granted' | 'revoked';
  text?: string;
  inReplyToParticipant?: string | null;
  person?: string | null;
  phoneNumber?: string | null;
  kind?: 'tell' | 'ask';
  failureNotification?: { provider: string; providerAccountId: string } | null;
  reachKey?: string;
  decision?: 'approve' | 'reject';
  seconds?: number;
  smsOutcome?: 'accepted' | 'rejected' | 'failed';
  voiceOutcome?: 'answered' | 'no_answer' | 'failed';
  recordingArtifact?: RealtimeRecordingArtifactInfo | null;
  actionKind?: string | null;
  forbiddenLevels?: string[];
  approvalLevels?: string[];
  noteText?: string;
}

export interface FixtureScenario {
  id: string;
  proves: string;
  deferred?: Array<{ note: string; missingContract: string }>;
  world: FixtureWorld;
  baseTime: string;
  script: FixtureStep[];
  final: FixtureAssertion[];
}

export interface FixtureRoot {
  schema: string;
  version: number;
  title: string;
  scenarios: FixtureScenario[];
}

const KNOWN_OPS: ReadonlySet<string> = new Set([
  'ingestMeeting',
  'ingestRealtime',
  'ingestCellular',
  'startCompanion',
  'recordConsent',
  'startRecording',
  'stopRecording',
  'speak',
  'stopSession',
  'finalize',
  'reach',
  'pump',
  'retryReach',
  'elapse',
  'providerScript',
  'unwireCellular',
  'rewireCellular',
  'unifyMeetings',
  'unifyRealtime',
  'setAuthorityPolicy',
  'decideApproval',
  'assert',
]);

const KNOWN_ASSERTION_KINDS: ReadonlySet<string> = new Set([
  'transportSends',
  'selfContainedEnvelopes',
  'reach',
  'attempts',
  'replies',
  'replyInTranscript',
  'actionRequest',
  'notifications',
  'meetings',
  'observations',
  'realtimeSession',
  'realtimeTurns',
  'realtimeEvents',
  'cellularEvents',
  'unifySummary',
  'unifiedResolution',
  'unifiedProfile',
  'ambiguities',
  'foreignInvisible',
]);

const KNOWN_REF_KINDS: ReadonlySet<string> = new Set([
  'room',
  'response',
  'smsMessageId',
  'callId',
]);

/**
 * Structural validation of the parsed fixture — the machine-readability
 * proof: the file must be exactly the versioned schema this runner
 * implements (schema identity, unique scenario ids, known ops, known
 * assertion kinds, known `$ref` kinds), or the suite refuses to run it.
 */
export function validateFixture(root: unknown): FixtureRoot {
  const where = 'meeting-cellular fixture';
  if (typeof root !== 'object' || root === null) {
    throw new Error(`${where}: the fixture file is not a JSON object`);
  }
  const candidate = root as Partial<FixtureRoot>;
  if (candidate.schema !== FIXTURE_SCHEMA) {
    throw new Error(`${where}: schema '${String(candidate.schema)}' is not '${FIXTURE_SCHEMA}'`);
  }
  if (candidate.version !== FIXTURE_VERSION) {
    throw new Error(`${where}: version ${String(candidate.version)} is not ${FIXTURE_VERSION}`);
  }
  if (!Array.isArray(candidate.scenarios) || candidate.scenarios.length === 0) {
    throw new Error(`${where}: no scenarios`);
  }
  const seen = new Set<string>();
  for (const scenario of candidate.scenarios) {
    if (typeof scenario?.id !== 'string' || scenario.id === '') {
      throw new Error(`${where}: a scenario has no id`);
    }
    if (seen.has(scenario.id)) {
      throw new Error(`${where}: duplicate scenario id '${scenario.id}'`);
    }
    seen.add(scenario.id);
    if (typeof scenario.proves !== 'string' || scenario.proves === '') {
      throw new Error(`${where}: scenario '${scenario.id}' has no 'proves'`);
    }
    if (typeof scenario.baseTime !== 'string' || Number.isNaN(Date.parse(scenario.baseTime))) {
      throw new Error(`${where}: scenario '${scenario.id}' has no valid baseTime`);
    }
    if (!Array.isArray(scenario.script) || scenario.script.length === 0) {
      throw new Error(`${where}: scenario '${scenario.id}' has an empty script`);
    }
    if (!Array.isArray(scenario.final)) {
      throw new Error(`${where}: scenario '${scenario.id}' has no final assertions`);
    }
    if (!Array.isArray(scenario.world?.people)) {
      throw new Error(`${where}: scenario '${scenario.id}' has no world.people`);
    }
    for (const person of scenario.world.people) {
      if (typeof person?.key !== 'string' || person.key === '') {
        throw new Error(`${where}: scenario '${scenario.id}' has a person without a key`);
      }
    }
    scenario.script.forEach((step, index) => {
      if (typeof step?.op !== 'string' || !KNOWN_OPS.has(step.op)) {
        throw new Error(
          `${where}: scenario '${scenario.id}' step ${index} has unknown op '${String(step?.op)}'`,
        );
      }
      for (const assertion of step.expect ?? []) {
        if (typeof assertion?.kind !== 'string' || !KNOWN_ASSERTION_KINDS.has(assertion.kind)) {
          throw new Error(
            `${where}: scenario '${scenario.id}' step ${index} has unknown assertion kind ` +
              `'${String(assertion?.kind)}'`,
          );
        }
      }
      checkRefs(step.payload, `${scenario.id} step ${index}`);
    });
    scenario.final.forEach((assertion, index) => {
      if (typeof assertion?.kind !== 'string' || !KNOWN_ASSERTION_KINDS.has(assertion.kind)) {
        throw new Error(
          `${where}: scenario '${scenario.id}' final assertion ${index} has unknown kind ` +
            `'${String(assertion?.kind)}'`,
        );
      }
    });
  }
  return candidate as FixtureRoot;
}

/** Every `$ref` token in a payload must be of a known kind. */
function checkRefs(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) checkRefs(entry, where);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['$ref'] === 'string') {
      if (!KNOWN_REF_KINDS.has(record['$ref'])) {
        throw new Error(`${where}: unknown $ref kind '${record['$ref']}'`);
      }
      return;
    }
    for (const entry of Object.values(record)) checkRefs(entry, where);
  }
}

/** Load and validate the fixture file. */
export function loadFixture(): FixtureRoot {
  const file = fileURLToPath(
    new URL('../fixtures/meeting-cellular/meeting-cellular.fixture.json', import.meta.url),
  );
  return validateFixture(JSON.parse(readFileSync(file, 'utf8')));
}

// ---------------------------------------------------------------------------
// The provider doubles (scripted transports on the modules' neutral ports)
// ---------------------------------------------------------------------------

/**
 * The deterministic cellular transport — the provider-neutral delivery
 * port (sendSms + placeVoiceCall) with scriptable outcomes and
 * deterministic provider ids the fixture's carrier envelopes reference.
 */
export class FixtureCellularTransport implements CellularTransport {
  readonly provider: CellularProvider;
  readonly smsRequests: CellularSmsRequest[] = [];
  readonly voiceRequests: CellularVoiceRequest[] = [];
  smsOutcome: 'accepted' | 'rejected' | 'failed' = 'accepted';
  voiceOutcome: 'answered' | 'no_answer' | 'failed' = 'answered';
  private readonly idPrefix = newId().slice(0, 8);
  private messageSeq = 0;
  private callSeq = 0;

  constructor(provider: CellularProvider = 'twilio') {
    this.provider = provider;
  }

  /** The provider message id of this transport's n-th accepted SMS send. */
  messageId(n: number): string {
    return `SM_${this.idPrefix}_${n}`;
  }

  /** The provider call id of this transport's n-th placed call. */
  callId(n: number): string {
    return `CA_${this.idPrefix}_${n}`;
  }

  async sendSms(request: CellularSmsRequest) {
    this.smsRequests.push(request);
    return {
      status: this.smsOutcome,
      providerMessageId:
        this.smsOutcome === 'accepted' ? this.messageId(++this.messageSeq) : null,
      detail: this.smsOutcome === 'accepted' ? null : `scripted ${this.smsOutcome}`,
    };
  }

  async placeVoiceCall(request: CellularVoiceRequest) {
    this.voiceRequests.push(request);
    return {
      status: this.voiceOutcome,
      providerCallId: this.callId(++this.callSeq),
      detail: null,
    };
  }
}

/**
 * The deterministic realtime transport — the provider-neutral transport
 * port, minting rooms exactly like the module's own doubles so the
 * fixture's livekit envelopes resolve onto the session's room.
 */
export class FixtureRealtimeTransport implements RealtimeTransport {
  readonly provider = 'livekit' as const;
  recordingArtifact: RealtimeRecordingArtifactInfo | null = null;

  async startRoom(request: Parameters<RealtimeTransport['startRoom']>[0]) {
    return {
      providerRoomId: `room-${this.provider}-${request.sessionId}`,
      agentParticipantId: request.agentParticipantId,
    };
  }

  async stopRoom(): Promise<void> {}

  async speak(): Promise<void> {}

  async startRecording(): Promise<void> {}

  async stopRecording(): Promise<{ artifact: RealtimeRecordingArtifactInfo | null }> {
    return { artifact: this.recordingArtifact };
  }

  async dial(request: Parameters<RealtimeTransport['dial']>[0]) {
    return { providerParticipantId: `sip-${request.phoneNumber.replace('+', '')}` };
  }

  async createJoinGrant(request: Parameters<RealtimeTransport['createJoinGrant']>[0]) {
    return {
      url: `wss://example.invalid/realtime/${request.sessionId}`,
      token: `grant_${newId()}`,
      expiresAt: new Date(systemClock.now().getTime() + 300_000).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// The scenario interpreter
// ---------------------------------------------------------------------------

interface PersonBinding {
  personId: string;
  employeeId: string | null;
}

interface SessionBinding {
  sessionId: string;
  providerRoomId: string;
}

interface RunState {
  scenario: FixtureScenario;
  requester: TenantContext;
  admin: TenantContext;
  persons: Map<string, PersonBinding>;
  meetingSessions: Map<string, string>;
  lastMeetingSessionKey: string | null;
  sessions: Map<string, SessionBinding>;
  responses: Map<string, string>;
  reaches: Map<string, CellularReach>;
  lastUnify: { pass: 'meetings' | 'realtime'; summary: UnifiedUnifySummary } | null;
  cellularTransport: FixtureCellularTransport;
  realtimeTransport: FixtureRealtimeTransport;
  cellularConnectionId: string | null;
  meetingConnectionId: string | null;
  realtimeConnectionId: string | null;
}

let clockMs = Date.now();

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

/** Resolve the fixture's `$ref` tokens inside one provider payload. */
function resolveRefs(value: unknown, state: RunState): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveRefs(entry, state));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['$ref'] === 'string') {
      const kind = record['$ref'];
      if (kind === 'room') {
        return boundSession(state, String(record['key']), `$ref room '${String(record['key'])}'`)
          .providerRoomId;
      }
      if (kind === 'response') {
        const responseId = state.responses.get(String(record['key']));
        if (responseId === undefined) {
          throw new Error(`$ref response '${String(record['key'])}' is not a bound spoken response`);
        }
        return responseId;
      }
      if (kind === 'smsMessageId') {
        return state.cellularTransport.messageId(Number(record['n']));
      }
      if (kind === 'callId') {
        return state.cellularTransport.callId(Number(record['n']));
      }
      throw new Error(`unknown $ref kind '${kind}'`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      out[key] = resolveRefs(entry, state);
    }
    return out;
  }
  return value;
}

/** Materialize the scenario's world through the real contracts. */
async function materializeWorld(state: RunState): Promise<void> {
  const { world } = state.scenario;
  const { requester, admin } = state;

  for (const person of world.people) {
    const created = await createPerson(requester, { fullName: person.fullName });
    let employeeId: string | null = null;
    if (person.employee !== null && person.employee !== undefined) {
      const employment = await createEmployee(requester, {
        personId: created.id,
        title: person.employee.title,
        department: person.employee.department,
      });
      employeeId = employment.id;
    }
    for (const identitySpec of person.verifiedIdentities) {
      const { identity } = await registerExternalIdentity(requester, {
        provider: identitySpec.provider,
        providerAccountId: identitySpec.providerAccountId,
      });
      await attestIdentity(admin, { identityId: identity.id, evidence: identitySpec.evidence });
      await attachVerifiedSubject(admin, { identityId: identity.id, subjectId: created.id });
    }
    state.persons.set(person.key, { personId: created.id, employeeId });
  }

  const meetings = world.connections.meetings;
  if (meetings !== null && meetings !== undefined) {
    const { connection } = await meetingsContract.registerMeetingConnection(requester, {
      provider: meetings.provider as 'zoom',
      providerAccountId: meetings.providerAccountId,
      displayName: meetings.displayName,
      authKind: (meetings.authKind ?? 'credentials') as 'credentials',
      credentialRef: meetings.credentialRef,
    });
    state.meetingConnectionId = connection.id;
  }

  const realtime = world.connections.realtime;
  if (realtime !== null && realtime !== undefined) {
    const { connection } = await realtimeContract.registerRealtimeConnection(requester, {
      provider: realtime.provider as 'livekit',
      providerAccountId: realtime.providerAccountId,
      authKind: (realtime.authKind ?? 'api_key') as 'api_key',
      credentialRef: realtime.credentialRef,
      displayName: realtime.displayName,
    });
    state.realtimeConnectionId = connection.id;
  }

  const cellular = world.connections.cellular;
  if (cellular !== null && cellular !== undefined) {
    const { connection } = await cellularContract.registerCellularConnection(requester, {
      provider: cellular.provider as 'twilio',
      providerAccountId: cellular.providerAccountId,
      phoneNumber: cellular.phoneNumber ?? '',
      credentialRef: cellular.credentialRef,
      displayName: cellular.displayName,
    });
    state.cellularConnectionId = connection.id;
  }

  if (world.cellularPolicy !== null && world.cellularPolicy !== undefined) {
    const policy = world.cellularPolicy;
    await cellularContract.setCellularPolicy(admin, {
      voiceFallback: policy.voiceFallback as 'on_sms_failure' | undefined,
      smsMaxAttempts: policy.smsMaxAttempts,
      retryBackoffSeconds: policy.retryBackoffSeconds,
    });
  }

  if (world.authorityPolicy !== null && world.authorityPolicy !== undefined) {
    await setAuthorityPolicy(admin, {
      actionKind: world.authorityPolicy.actionKind ?? null,
      approvalLevels: (world.authorityPolicy.approvalLevels ?? []) as AuthorityLevelList,
      forbiddenLevels: (world.authorityPolicy.forbiddenLevels ?? []) as AuthorityLevelList,
      note: world.authorityPolicy.note ?? null,
    });
  }
}

type AuthorityLevelList = Array<'OBSERVE' | 'ANALYZE' | 'RECOMMEND' | 'ASK' | 'PROPOSE' | 'EXECUTE'>;

/** Find a realtime session participant row id by its provider participant id. */
async function realtimeParticipantId(
  state: RunState,
  sessionKey: string,
  providerParticipantId: string,
): Promise<string> {
  const binding = boundSession(state, sessionKey, `participant '${providerParticipantId}'`);
  const participants = await realtimeContract.listRealtimeParticipants(state.requester, {
    sessionId: binding.sessionId,
  });
  const participant = participants.find(
    (entry) => entry.providerParticipantId === providerParticipantId,
  );
  if (participant === undefined) {
    throw new Error(`participant '${providerParticipantId}' is not in session '${sessionKey}'`);
  }
  return participant.id;
}

/** Drive one finalization run to a terminal state through a fresh engine. */
async function driveFinalization(state: RunState, runId: string): Promise<void> {
  const engine: WorkflowEnginePort = createWorkflowEngine(
    realtimeContract.createRealtimeWorkflowBindings(),
  );
  for (let pump = 0; pump < 24; pump += 1) {
    await engine.pump(state.requester);
    const run = await getRun(state.requester, { runId });
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      expect(run.status, 'the finalization run must succeed').toBe('succeeded');
      return;
    }
  }
  throw new Error('the finalization run did not reach a terminal state in 24 pumps');
}

/** Execute one script step (op + expected-error + per-step assertions). */
async function runStep(state: RunState, step: FixtureStep, index: number): Promise<void> {
  const { requester, admin } = state;
  const label = `scenario '${state.scenario.id}' step ${index} (${step.op}${step.note ? `: ${step.note}` : ''})`;

  const execute = async (): Promise<void> => {
    switch (step.op) {
      case 'ingestMeeting': {
        expect(state.meetingConnectionId, `${label}: the world has no meetings connection`).toBeTruthy();
        const result = await meetingsContract.receiveMeetingWebhook(requester, {
          provider: 'zoom',
          payload: step.payload,
        });
        expect(result.ingested, `${label}: the zoom envelope ingested`).toBeGreaterThan(0);
        if (step.bindSession !== undefined && step.bindSession !== null && step.bindSession !== '') {
          const payload = step.payload as { session?: { id?: string } };
          const providerSessionId = payload.session?.id;
          expect(providerSessionId, `${label}: the envelope carries a session`).toBeTruthy();
          const sessions = await meetingsContract.listMeetingSessions(requester, {});
          const session = sessions.find((entry) => entry.providerSessionId === providerSessionId);
          expect(session, `${label}: the canonical meeting session exists`).toBeDefined();
          state.meetingSessions.set(step.bindSession, session!.id);
          state.lastMeetingSessionKey = step.bindSession;
        }
        return;
      }
      case 'ingestRealtime': {
        expect(state.realtimeConnectionId, `${label}: the world has no realtime connection`).toBeTruthy();
        await realtimeContract.receiveRealtimeEvent(requester, {
          provider: 'livekit',
          payload: resolveRefs(step.payload, state),
        });
        return;
      }
      case 'ingestCellular': {
        expect(state.cellularConnectionId, `${label}: the world has no cellular connection`).toBeTruthy();
        await cellularContract.receiveCellularEvent(requester, {
          provider: 'twilio',
          payload: resolveRefs(step.payload, state),
        });
        return;
      }
      case 'startCompanion': {
        expect(step.key, `${label}: needs a session key`).toBeTruthy();
        expect(state.realtimeConnectionId, `${label}: the world has no realtime connection`).toBeTruthy();
        const meetingSessionKey = step.meetingSessionKey ?? state.lastMeetingSessionKey;
        const meetingSessionId = meetingSessionKey
          ? state.meetingSessions.get(meetingSessionKey)
          : undefined;
        expect(
          meetingSessionId,
          `${label}: meetingSessionKey '${String(meetingSessionKey)}' is not bound`,
        ).toBeTruthy();
        const { session } = await realtimeContract.startRealtimeSession(requester, {
          connectionId: state.realtimeConnectionId!,
          kind: 'meeting_companion',
          meetingSessionId: meetingSessionId!,
          title: step.title ?? null,
        });
        expect(session.status, `${label}: the companion session is live`).toBe('live');
        expect(session.meetingSessionId).toBe(meetingSessionId);
        state.sessions.set(step.key!, {
          sessionId: session.id,
          providerRoomId: session.providerRoomId ?? '',
        });
        return;
      }
      case 'recordConsent': {
        const sessionKey = step.sessionKey ?? '';
        const participantId = await realtimeParticipantId(state, sessionKey, step.participant ?? '');
        await realtimeContract.recordRealtimeConsent(requester, {
          sessionId: boundSession(state, sessionKey, label).sessionId,
          participantId,
          consent: step.consent ?? 'granted',
        });
        return;
      }
      case 'startRecording': {
        await realtimeContract.startRealtimeRecording(requester, {
          sessionId: boundSession(state, step.sessionKey ?? '', label).sessionId,
        });
        return;
      }
      case 'stopRecording': {
        await realtimeContract.stopRealtimeRecording(requester, {
          sessionId: boundSession(state, step.sessionKey ?? '', label).sessionId,
        });
        return;
      }
      case 'speak': {
        const binding = boundSession(state, step.sessionKey ?? '', label);
        let inReplyToTurnId: string | null = null;
        if (step.inReplyToParticipant !== null && step.inReplyToParticipant !== undefined) {
          const turns = await realtimeContract.listRealtimeTurns(requester, {
            sessionId: binding.sessionId,
            kind: 'human_speech' as 'human_speech' | 'aurum_response',
          });
          const participants = await realtimeContract.listRealtimeParticipants(requester, {
            sessionId: binding.sessionId,
          });
          const speaker = participants.find(
            (entry) => entry.providerParticipantId === step.inReplyToParticipant,
          );
          expect(speaker, `${label}: the in-reply-to participant exists`).toBeDefined();
          const wanted = [...turns].reverse().find((entry) => entry.speakerParticipantId === speaker?.id);
          expect(wanted, `${label}: the in-reply-to turn exists`).toBeDefined();
          inReplyToTurnId = wanted?.id ?? null;
        }
        const response = await realtimeContract.speakRealtimeResponse(requester, {
          sessionId: binding.sessionId,
          text: step.text ?? '',
          inReplyToTurnId,
        });
        expect(response.status, `${label}: the response is speaking`).toBe('speaking');
        state.responses.set(step.key ?? '', response.id);
        return;
      }
      case 'stopSession': {
        const binding = boundSession(state, step.sessionKey ?? '', label);
        const stopped = await realtimeContract.stopRealtimeSession(requester, {
          sessionId: binding.sessionId,
        });
        expect(stopped.session.status, `${label}: the session ended`).toBe('ended');
        expect(stopped.finalizeRunId, `${label}: the finalization run exists`).toBeTruthy();
        return;
      }
      case 'finalize': {
        const binding = boundSession(state, step.sessionKey ?? '', label);
        const session = await realtimeContract.getRealtimeSession(requester, binding.sessionId);
        const runId = session.finalizeRunId;
        expect(runId, `${label}: the session has a finalization run`).toBeTruthy();
        await driveFinalization(state, runId!);
        return;
      }
      case 'reach': {
        expect(step.key, `${label}: needs a reach key`).toBeTruthy();
        const personId =
          step.person !== null && step.person !== undefined
            ? boundPerson(state, step.person, label)
            : null;
        const reach = await cellularContract.reachAnyone(requester, {
          personId,
          phoneNumber: step.phoneNumber ?? null,
          kind: step.kind ?? 'tell',
          text: step.text ?? '',
          failureNotification: step.failureNotification ?? null,
        });
        state.reaches.set(step.key!, reach);
        return;
      }
      case 'pump': {
        await cellularContract.pumpCellularReach(requester, {});
        return;
      }
      case 'retryReach': {
        const reachKey = step.reachKey ?? '';
        const reachId = boundReach(state, reachKey, label);
        const retried = await cellularContract.retryCellularReach(requester, {
          reachRequestId: reachId,
        });
        state.reaches.set(reachKey, retried);
        return;
      }
      case 'elapse': {
        clockMs += (step.seconds ?? 0) * 1_000;
        return;
      }
      case 'providerScript': {
        if (step.smsOutcome !== undefined) state.cellularTransport.smsOutcome = step.smsOutcome;
        if (step.voiceOutcome !== undefined) state.cellularTransport.voiceOutcome = step.voiceOutcome;
        if (step.recordingArtifact !== undefined) {
          state.realtimeTransport.recordingArtifact = step.recordingArtifact ?? null;
        }
        return;
      }
      case 'unwireCellular': {
        cellularContract.setCellularTransport(null);
        return;
      }
      case 'rewireCellular': {
        cellularContract.setCellularTransport(state.cellularTransport);
        return;
      }
      case 'unifyMeetings': {
        const summary = await unifiedIdentityContract.unifyMeetingIdentities(requester, {});
        state.lastUnify = { pass: 'meetings', summary };
        return;
      }
      case 'unifyRealtime': {
        const sessionKey = step.sessionKey ?? null;
        const sessionId = sessionKey ? state.sessions.get(sessionKey)?.sessionId : undefined;
        const summary = await unifiedIdentityContract.unifyRealtimeIdentities(
          requester,
          sessionId ? { sessionId } : {},
        );
        state.lastUnify = { pass: 'realtime', summary };
        return;
      }
      case 'setAuthorityPolicy': {
        await setAuthorityPolicy(admin, {
          actionKind: step.actionKind ?? null,
          approvalLevels: (step.approvalLevels ?? []) as AuthorityLevelList,
          forbiddenLevels: (step.forbiddenLevels ?? []) as AuthorityLevelList,
          note: step.noteText ?? null,
        });
        return;
      }
      case 'decideApproval': {
        const reach = state.reaches.get(step.reachKey ?? '');
        expect(reach?.actionRequestId, `${label}: the reach has an action request`).toBeTruthy();
        await decideApproval(admin, {
          requestId: reach!.actionRequestId!,
          decision: step.decision ?? 'approve',
        });
        return;
      }
      case 'assert': {
        return;
      }
      default:
        throw new Error(`${label}: unknown op '${step.op}'`);
    }
  };

  try {
    await execute();
    if (step.expectError !== null && step.expectError !== undefined) {
      throw new Error(
        `${label}: expected a typed error '${step.expectError.code}' but the step succeeded`,
      );
    }
  } catch (error) {
    if (
      step.expectError !== null &&
      step.expectError !== undefined &&
      error instanceof Error &&
      'code' in error
    ) {
      expect((error as { code: unknown }).code, `${label}: the expected error code`).toBe(
        step.expectError.code,
      );
    } else {
      throw error instanceof Error ? new Error(`${label}: ${error.message}`) : error;
    }
  }

  for (const assertion of step.expect ?? []) {
    await checkAssertion(state, assertion, label);
  }
}

// ---------------------------------------------------------------------------
// The assertion vocabulary (every check reads durable state back)
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{6,14}$/;
const URLISH = /([a-z][a-z0-9+.-]*:\/\/|\bwww\.)/i;

async function checkAssertion(
  state: RunState,
  spec: FixtureAssertion,
  label: string,
): Promise<void> {
  const { requester } = state;
  switch (spec.kind) {
    case 'transportSends': {
      expect(state.cellularTransport.smsRequests.length, `${label} transportSends.sms`).toBe(
        spec.sms,
      );
      expect(state.cellularTransport.voiceRequests.length, `${label} transportSends.voice`).toBe(
        spec.voice,
      );
      return;
    }
    case 'selfContainedEnvelopes': {
      const legs = (spec.legs as string[]) ?? [];
      for (const leg of legs) {
        if (leg === 'sms') {
          for (const request of state.cellularTransport.smsRequests) {
            expect(E164.test(request.toNumber), `${label} sms.toNumber is E.164`).toBe(true);
            expect(E164.test(request.fromNumber), `${label} sms.fromNumber is E.164`).toBe(true);
            expect(request.text.length, `${label} the SMS text is non-empty`).toBeGreaterThan(0);
            expect(
              URLISH.test(request.text),
              `${label} the SMS text carries no URL or deep link (plain PSTN only)`,
            ).toBe(false);
          }
        }
        if (leg === 'voice') {
          for (const request of state.cellularTransport.voiceRequests) {
            expect(E164.test(request.toNumber), `${label} voice.toNumber is E.164`).toBe(true);
            expect(E164.test(request.fromNumber), `${label} voice.fromNumber is E.164`).toBe(true);
            expect(request.text.length, `${label} the spoken text is non-empty`).toBeGreaterThan(0);
            expect(
              URLISH.test(request.text),
              `${label} the spoken text carries no URL or deep link (plain PSTN only)`,
            ).toBe(false);
          }
        }
      }
      return;
    }
    case 'reach': {
      const reach = await cellularContract.getCellularReach(requester, {
        reachRequestId: boundReach(state, String(spec.key), label),
      });
      if (spec.status !== undefined) expect(reach.status, `${label} reach.status`).toBe(spec.status);
      if (spec.failureCode !== undefined) {
        expect(reach.failureCode, `${label} reach.failureCode`).toBe(spec.failureCode);
      }
      if (spec.recipientKind !== undefined) {
        expect(reach.recipientKind, `${label} reach.recipientKind`).toBe(spec.recipientKind);
      }
      if (spec.person !== undefined) {
        expect(reach.personId, `${label} reach.personId`).toBe(
          boundPerson(state, String(spec.person), label),
        );
      }
      if (spec.actionKind !== undefined) {
        expect(reach.actionKind, `${label} reach.actionKind`).toBe(spec.actionKind);
      }
      if (spec.policySource !== undefined) {
        expect(reach.policySource, `${label} reach.policySource`).toBe(spec.policySource);
      }
      if (spec.voiceFallback !== undefined) {
        expect(reach.voiceFallback, `${label} reach.voiceFallback`).toBe(spec.voiceFallback);
      }
      if (spec.smsAttemptsCount !== undefined) {
        expect(reach.smsAttemptsCount, `${label} reach.smsAttemptsCount`).toBe(spec.smsAttemptsCount);
      }
      if (spec.voiceAttemptsCount !== undefined) {
        expect(reach.voiceAttemptsCount, `${label} reach.voiceAttemptsCount`).toBe(
          spec.voiceAttemptsCount,
        );
      }
      if (spec.cycle !== undefined) {
        expect(reach.cycle, `${label} reach.cycle`).toBe(spec.cycle);
      }
      for (const field of ['sentAt', 'deliveredAt', 'repliedAt', 'nextAttemptAt'] as const) {
        if (spec[field] !== undefined) {
          const expected = spec[field] === true;
          expect(
            (reach[field] !== null) === expected,
            `${label} reach.${field} is ${expected ? 'set' : 'null'}`,
          ).toBe(true);
        }
      }
      if (spec.actionRequestId !== undefined) {
        expect(reach.actionRequestId !== null, `${label} reach.actionRequestId recorded`).toBe(
          spec.actionRequestId === true,
        );
      }
      return;
    }
    case 'attempts': {
      const attempts = await cellularContract.listCellularAttempts(requester, {
        reachRequestId: boundReach(state, String(spec.reachKey), label),
      });
      expect(
        attempts.map((attempt) => `${attempt.leg}:${attempt.status}`).sort(),
        `${label} the attempt trail`,
      ).toEqual([...((spec.legs as string[]) ?? [])].sort());
      if (spec.providerAcks === true) {
        for (const attempt of attempts) {
          if (attempt.leg === 'sms' && (attempt.status === 'sent' || attempt.status === 'delivered')) {
            expect(attempt.providerMessageId, `${label} the SMS provider ack is recorded`).toBeTruthy();
          }
          if (attempt.leg === 'voice') {
            expect(attempt.providerCallId, `${label} the voice provider ack is recorded`).toBeTruthy();
          }
        }
      }
      return;
    }
    case 'replies': {
      const reachKey = typeof spec.reachKey === 'string' ? spec.reachKey : null;
      const replies = await cellularContract.listCellularReplies(requester, {
        ...(reachKey ? { reachRequestId: boundReach(state, reachKey, label) } : {}),
      });
      if (spec.count !== undefined) {
        expect(replies.length, `${label} the reply count`).toBe(spec.count);
      }
      const entries = (spec.entries as Array<Record<string, unknown>>) ?? [];
      const unmatched = [...replies];
      for (const entry of entries) {
        const index = unmatched.findIndex((reply) => {
          if (reply.inboundKind !== entry['inboundKind']) return false;
          if (entry['channel'] !== undefined && reply.channel !== entry['channel']) return false;
          if (entry['person'] !== undefined) {
            if (reply.personId !== boundPerson(state, String(entry['person']), label)) return false;
          }
          if (entry['reachKey'] !== undefined && entry['reachKey'] !== null) {
            if (reply.reachRequestId !== boundReach(state, String(entry['reachKey']), label)) {
              return false;
            }
          }
          if (
            entry['textContains'] !== undefined &&
            !reply.text.includes(String(entry['textContains']))
          ) {
            return false;
          }
          return true;
        });
        expect(
          index,
          `${label} a recorded reply matches ${JSON.stringify(entry)}`,
        ).toBeGreaterThanOrEqual(0);
        if (index >= 0) unmatched.splice(index, 1);
      }
      return;
    }
    case 'replyInTranscript': {
      const personId = boundPerson(state, String(spec.person), label);
      const messages = await listMessages(requester, {
        channel: String(spec.channel) as 'sms' | 'voice',
        actorKind: 'person',
        actorId: personId,
        limit: 100,
      });
      const texts = messages.map((message) => {
        const payload = message.payload as { content?: { text?: string | null } } | null;
        return payload?.content?.text ?? '';
      });
      expect(
        texts.some((text) => text.includes(String(spec.textContains))),
        `${label} the reply continuity: the canonical conversation transcript carries the message`,
      ).toBe(true);
      return;
    }
    case 'actionRequest': {
      const reach = await cellularContract.getCellularReach(requester, {
        reachRequestId: boundReach(state, String(spec.reachKey), label),
      });
      expect(reach.actionRequestId, `${label} the reach carries an action request`).toBeTruthy();
      const request = await getActionRequest(requester, { requestId: reach.actionRequestId! });
      expect(request.status, `${label} actionRequest.status`).toBe(spec.status);
      expect(request.evaluation.outcome, `${label} actionRequest.evaluation.outcome`).toBe(
        spec.evaluationOutcome,
      );
      const decisions = await listApprovalDecisions(requester, {
        requestId: reach.actionRequestId!,
      });
      const expected = ((spec.decisions as Array<{ by: string; decision: string }>) ?? []).map(
        (decision) => `${decision.by}:${decision.decision}`,
      );
      expect(
        decisions.map((decision) => `${decision.decidedBy}:${decision.decision}`).sort(),
        `${label} the append-only decision trail`,
      ).toEqual([...expected].sort());
      return;
    }
    case 'notifications': {
      const notifications = await listNotifications(requester, {
        notificationKind: String(spec.kindOf),
      });
      expect(notifications.length, `${label} the notification count`).toBe(spec.count);
      if (spec.reachKey !== undefined && spec.reachKey !== null) {
        const reachId = boundReach(state, String(spec.reachKey), label);
        expect(
          notifications.some((notification) => notification.correlationId === reachId),
          `${label} the failure notification correlates to the reach`,
        ).toBe(true);
      }
      return;
    }
    case 'meetings': {
      const sessionKey =
        typeof spec.sessionKey === 'string' ? spec.sessionKey : state.lastMeetingSessionKey;
      const sessionId = sessionKey ? state.meetingSessions.get(sessionKey) : undefined;
      if (spec.meetings !== undefined) {
        expect(
          (await meetingsContract.listMeetings(requester, {})).length,
          `${label} meetings`,
        ).toBe(spec.meetings);
      }
      if (spec.sessions !== undefined) {
        expect(
          (await meetingsContract.listMeetingSessions(requester, {})).length,
          `${label} meeting sessions`,
        ).toBe(spec.sessions);
      }
      if (spec.transcripts !== undefined) {
        expect(sessionId, `${label} a meeting session is bound`).toBeTruthy();
        expect(
          (
            await meetingsContract.listMeetingTranscripts(requester, { sessionId: sessionId! })
          ).length,
          `${label} meeting transcripts`,
        ).toBe(spec.transcripts);
      }
      if (spec.artifacts !== undefined) {
        expect(sessionId, `${label} a meeting session is bound`).toBeTruthy();
        expect(
          (
            await meetingsContract.listMeetingArtifacts(requester, { sessionId: sessionId! })
          ).length,
          `${label} meeting artifacts`,
        ).toBe(spec.artifacts);
      }
      if (spec.accessEvents !== undefined) {
        expect(
          (await meetingsContract.listMeetingAccessEvents(requester, {})).length,
          `${label} meeting access events`,
        ).toBe(spec.accessEvents);
      }
      if (spec.participants !== undefined) {
        expect(
          (await meetingsContract.listMeetingParticipants(requester, {})).length,
          `${label} meeting participants`,
        ).toBe(spec.participants);
      }
      return;
    }
    case 'observations': {
      const observations = await listObservations(requester, { channel: String(spec.channel) });
      expect(
        observations.map((observation) => observation.kind).sort(),
        `${label} the captured evidence kinds`,
      ).toEqual([...((spec.kinds as string[]) ?? [])].sort());
      return;
    }
    case 'realtimeSession': {
      const binding = boundSession(state, String(spec.key), label);
      const session: RealtimeSession = await realtimeContract.getRealtimeSession(
        requester,
        binding.sessionId,
      );
      if (spec.status !== undefined) {
        expect(session.status, `${label} realtimeSession.status`).toBe(spec.status);
      }
      if (spec.endedReason !== undefined) {
        expect(session.endedReason, `${label} realtimeSession.endedReason`).toBe(spec.endedReason);
      }
      if (spec.errorCode !== undefined) {
        expect(session.errorCode, `${label} realtimeSession.errorCode`).toBe(spec.errorCode);
      }
      if (spec.recordingState !== undefined) {
        expect(session.recordingState, `${label} realtimeSession.recordingState`).toBe(
          spec.recordingState,
        );
      }
      if (spec.evidenceObservationKind !== undefined) {
        expect(session.evidenceObservationId, `${label} the session-close observation exists`).toBeTruthy();
        const observation = await getObservation(requester, session.evidenceObservationId!);
        expect(observation.kind, `${label} the session-close observation kind`).toBe(
          spec.evidenceObservationKind,
        );
      }
      if (spec.artifactKinds !== undefined) {
        const artifacts = await realtimeContract.listRealtimeArtifacts(requester, {
          sessionId: binding.sessionId,
        });
        expect(
          artifacts.map((artifact) => artifact.kind).sort(),
          `${label} the durable session artifacts`,
        ).toEqual([...((spec.artifactKinds as string[]) ?? [])].sort());
      }
      return;
    }
    case 'realtimeTurns': {
      const binding = boundSession(state, String(spec.sessionKey), label);
      const turns = await realtimeContract.listRealtimeTurns(requester, {
        sessionId: binding.sessionId,
      });
      if (spec.humanTexts !== undefined) {
        expect(
          turns.filter((turn) => turn.kind === 'human_speech').map((turn) => turn.text),
          `${label} the human transcript turns`,
        ).toEqual(spec.humanTexts);
      }
      if (spec.aurumResponseTexts !== undefined) {
        expect(
          turns.filter((turn) => turn.kind === 'aurum_response').map((turn) => turn.text),
          `${label} the spoken Aurum responses`,
        ).toEqual(spec.aurumResponseTexts);
      }
      return;
    }
    case 'realtimeEvents': {
      const binding = boundSession(state, String(spec.sessionKey), label);
      const events = await realtimeContract.listRealtimeEvents(requester, {
        sessionId: binding.sessionId,
        kind: String(spec.eventKind) as RealtimeEventKind,
      });
      expect(events.length, `${label} realtimeEvents '${String(spec.eventKind)}'`).toBe(spec.count);
      if (spec.source !== undefined) {
        expect(events.every((event) => event.source === spec.source), `${label} every event source`).toBe(
          true,
        );
      }
      return;
    }
    case 'cellularEvents': {
      const events = await cellularContract.listCellularEvents(requester, { provider: 'twilio' });
      expect(
        events.map((event) => event.kind).sort(),
        `${label} the provider-event ledger kinds`,
      ).toEqual([...((spec.kinds as string[]) ?? [])].sort());
      return;
    }
    case 'unifySummary': {
      const last = state.lastUnify;
      expect(last, `${label} a unification pass has run`).not.toBeNull();
      expect(last!.pass, `${label} unifySummary.pass`).toBe(spec.pass);
      for (const field of [
        'considered',
        'created',
        'linked',
        'ambiguous',
        'linkRetained',
        'skipped',
      ] as const) {
        if (spec[field] !== undefined) {
          expect(last!.summary[field], `${label} unifySummary.${field}`).toBe(spec[field]);
        }
      }
      return;
    }
    case 'unifiedResolution': {
      const resolution = await unifiedIdentityContract.resolveUnifiedIdentity(requester, {
        modality: String(spec.modality) as 'meeting' | 'realtime' | 'sms' | 'messaging',
        provider: String(spec.provider),
        providerAccountId: String(spec.account),
      });
      expect(resolution.status, `${label} unifiedResolution.status`).toBe(spec.expect);
      if (spec.person !== undefined && resolution.status === 'resolved') {
        expect(resolution.person.id, `${label} unifiedResolution.person`).toBe(
          boundPerson(state, String(spec.person), label),
        );
      }
      return;
    }
    case 'unifiedProfile': {
      const profile = await unifiedIdentityContract.getUnifiedSubjectProfile(
        requester,
        boundPerson(state, String(spec.person), label),
      );
      if (spec.verifiedModalities !== undefined) {
        expect(profile.verifiedModalityCount, `${label} verifiedModalityCount`).toBe(
          spec.verifiedModalities,
        );
      }
      if (spec.modalities !== undefined) {
        expect(
          profile.modalities.map((reach) => reach.modality),
          `${label} the verified modality reach`,
        ).toEqual(spec.modalities);
      }
      return;
    }
    case 'ambiguities': {
      const ambiguities = await unifiedIdentityContract.listUnifiedAmbiguities(requester, {
        status: String(spec.status) as 'open',
      });
      expect(ambiguities.length, `${label} the open ambiguity count`).toBe(spec.count);
      if (spec.persons !== undefined) {
        const persons = (spec.persons as string[]).map((person) =>
          boundPerson(state, person, label),
        );
        expect(
          ambiguities[0]?.candidates.map((candidate) => candidate.personId).sort(),
          `${label} the ambiguity's candidate persons`,
        ).toEqual([...persons].sort());
      }
      return;
    }
    case 'foreignInvisible': {
      const foreign = member(newId());
      if (spec.reachKey !== undefined && spec.reachKey !== null) {
        const reachId = boundReach(state, String(spec.reachKey), label);
        await expectForeignCode(
          () => cellularContract.getCellularReach(foreign, { reachRequestId: reachId }),
          'reach_not_found',
          `${label} a foreign tenant cannot read the reach request`,
        );
      }
      if (spec.sessionKey !== undefined && spec.sessionKey !== null) {
        const sessionId = boundSession(state, String(spec.sessionKey), label).sessionId;
        await expectForeignCode(
          () => realtimeContract.getRealtimeSession(foreign, sessionId),
          'session_not_found',
          `${label} a foreign tenant cannot read the companion session`,
        );
      }
      if (spec.person !== undefined && spec.person !== null) {
        const personId = boundPerson(state, String(spec.person), label);
        await expectForeignCode(
          () => unifiedIdentityContract.getUnifiedSubjectProfile(foreign, personId),
          'person_not_found',
          `${label} a foreign tenant cannot read the person`,
        );
      }
      return;
    }
    default:
      throw new Error(`${label}: unknown assertion kind '${spec.kind}'`);
  }
}

function boundPerson(state: RunState, key: string, label: string): string {
  const person = state.persons.get(key);
  if (person === undefined) {
    throw new Error(`${label}: person '${key}' is not bound`);
  }
  return person.personId;
}

function boundReach(state: RunState, key: string, label: string): string {
  const reach = state.reaches.get(key);
  if (reach === undefined) {
    throw new Error(`${label}: reach '${key}' is not bound`);
  }
  return reach.id;
}

function boundSession(state: RunState, key: string, label: string): SessionBinding {
  const binding = state.sessions.get(key);
  if (binding === undefined) {
    throw new Error(`${label}: realtime session '${key}' is not bound`);
  }
  return binding;
}

async function expectForeignCode(
  fn: () => Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`${label}: expected code '${code}' but the read succeeded`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`${label}: expected code`) &&
      !(typeof (error as { code?: unknown }).code === 'string')
    ) {
      throw error;
    }
    expect((error as { code?: unknown }).code, label).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// The public entry: run one scenario end-to-end
// ---------------------------------------------------------------------------

/**
 * Execute one fixture scenario against the real module services: a fresh
 * tenant, the deterministic transports wired through the modules' ports,
 * the scenario's service clock, every script step with its per-step
 * assertions, then the final assertions.
 */
export async function runScenario(scenario: FixtureScenario): Promise<void> {
  clockMs = Date.parse(scenario.baseTime);
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));

  const tenantId = newId();
  const state: RunState = {
    scenario,
    requester: member(tenantId),
    admin: member(tenantId, [
      'identity:attest',
      'identity:link',
      'cellular:administer',
      'actions:administer',
      'actions:approve',
    ]),
    persons: new Map(),
    meetingSessions: new Map(),
    lastMeetingSessionKey: null,
    sessions: new Map(),
    responses: new Map(),
    reaches: new Map(),
    lastUnify: null,
    cellularTransport: new FixtureCellularTransport('twilio'),
    realtimeTransport: new FixtureRealtimeTransport(),
    cellularConnectionId: null,
    meetingConnectionId: null,
    realtimeConnectionId: null,
  };

  cellularContract.setCellularTransport(state.cellularTransport);
  realtimeContract.setRealtimeTransport(state.realtimeTransport);
  try {
    await materializeWorld(state);
    for (const [index, step] of scenario.script.entries()) {
      await runStep(state, step, index);
    }
    for (const assertion of scenario.final) {
      await checkAssertion(state, assertion, `scenario '${scenario.id}' final`);
    }
  } finally {
    cellularContract.setCellularTransport(null);
    realtimeContract.setRealtimeTransport(null);
    vi.restoreAllMocks();
  }
}
