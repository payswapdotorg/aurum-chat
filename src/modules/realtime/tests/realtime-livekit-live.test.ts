// The W109 LIVE provider leg (LiveKit Cloud) — credential-gated: it
// runs ONLY when the operator-provisioned environment is present
// (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET /
// LIVEKIT_EGRESS_STREAM_URL) and SKIPS with an explicit label otherwise.
// This is the LIVE counterpart of the deterministic suites — the W112
// classification reads both: deterministic fixtures remain separately
// labeled (realtime-service.test.ts, realtime-provider-failure.test.ts,
// realtime-livekit-transport.test.ts — scripted/stubbed doubles) and
// THIS file proves the same canonical semantics against the real SFU.
//
// The assertions mirror the W109 acceptance:
//   * one live provider path end-to-end (the meeting companion leg);
//   * one realtime path end-to-end (the aurum voice leg);
//   * consent refusal BLOCKS recording; mid-session revocation STOPS it;
//   * live transcript + speaker identity reach canonical evidence;
//   * spoken response + interruption lifecycle is durable;
//   * real disconnect events (Leave reason ROOM_DELETED, room gone);
//   * durable finalization survives the provider teardown (transcript
//     artifact + session-close observation).
//
// Secrets never appear in output: the runner REDACTS the API secret and
// every minted token from the report it returns.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

import { envString } from '@/infra/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  prepareLiveLegDatabase,
  runLivekitLiveLeg,
  teardownLiveLegDatabase,
  type LiveLegReport,
} from './livekit-live-leg';

const LIVE_ENV_PRESENT =
  envString('LIVEKIT_URL') !== undefined &&
  envString('LIVEKIT_API_KEY') !== undefined &&
  envString('LIVEKIT_API_SECRET') !== undefined &&
  envString('LIVEKIT_EGRESS_STREAM_URL') !== undefined;

// The evidence directory (the harness writes the machine-checkable
// report here when set — the committed evidence under
// docs/productization-evidence/W109/live-leg/ comes from these runs).
const EVIDENCE_DIR = envString('LIVEKIT_EVIDENCE_DIR') ?? null;

let report: LiveLegReport;

beforeAll(async () => {
  // The file-level hook runs even when both describes are skipped — only
  // run the leg (and its database) when the operator environment exists.
  if (!LIVE_ENV_PRESENT) return;
  await prepareLiveLegDatabase();
  report = await runLivekitLiveLeg(EVIDENCE_DIR);
}, 240_000);

afterAll(async () => {
  if (!LIVE_ENV_PRESENT) return;
  await teardownLiveLegDatabase();
});

describe.skipIf(!LIVE_ENV_PRESENT)('W109 LIVE provider leg — LiveKit Cloud (credential-gated)', () => {
  it('the leg ran to a LIVE-PROVEN disposition (a BLOCKED report fails loudly, never silently)', () => {
    // A BLOCKED disposition carries the exact failure — assert it loudly
    // so a regression cannot hide behind a skip.
    expect(report.disposition).toBe('LIVE-PROVEN');
  });

  it('the env-driven production wiring wired the livekit transport', () => {
    expect(report.wiring.livekitState).toBe('wired');
    expect(report.wiring.detail).toContain('livekit live transport wired');
  });

  it('exercised exactly the two live paths (meeting companion + realtime voice)', () => {
    expect(report.legs.map((leg) => leg.kind).sort()).toEqual(['aurum_voice', 'meeting_companion']);
  });

  it('the meeting companion session attached to the canonical meeting session (frozen-contract linkage)', () => {
    expect(report.meetingReference.meetingSessionId).not.toBe('');
    expect(report.legs[0]!.kind).toBe('meeting_companion');
  });

  it('the meeting leg ran on a REAL room with a REAL participant join', () => {
    const leg = report.legs[0]!;
    expect(leg.providerRoomId).toMatch(/^aurum-/);
    expect(leg.room?.sid).toMatch(/^RM_/);
    expect(leg.join?.participantSid).toMatch(/^PA_/);
    expect(leg.join?.identity).toBe('w109-live-human');
    // The join grant is ephemeral evidence — the token never appears.
    expect(leg.join?.token).toBe('REDACTED');
    // The real SFU's event stream reached the client.
    expect(leg.signalsReceived.some((signal) => signal.kind === 'join')).toBe(true);
    expect(leg.signalsReceived.some((signal) => signal.kind === 'roomUpdate' || signal.kind === 'update')).toBe(true);
  });

  it('consent refusal BLOCKED the recording (an explicit ledger event, no egress)', () => {
    const floor = report.legs[0]!.consentFloor!;
    expect(floor.blockedBeforeConsent.blocked).toBe(true);
    expect(floor.blockedBeforeConsent.errorCode).toBe('consent_required');
    expect(floor.blockedBeforeConsent.ledgerEventRecorded).toBe(true);
  });

  it('consent granted → a REAL egress started (control plane) and joined the room as a real participant', () => {
    const floor = report.legs[0]!.consentFloor!;
    expect(floor.recordingStart.started).toBe(true);
    expect(floor.recordingStart.egressId).toMatch(/^EG_/);
    expect(floor.recordingStart.egressParticipantObserved).toBe(true);
  });

  it('mid-session consent revocation STOPPED the recording (egress terminal, state recorded)', () => {
    const floor = report.legs[0]!.consentFloor!;
    expect(floor.revocationStop.stopped).toBe(true);
    expect(floor.revocationStop.recordingStateAfter).toBe('recorded');
    // The egress left its starting/active state (ABORTED/COMPLETE/…).
    expect(floor.revocationStop.egressFinalStatus).not.toMatch(/STARTING/);
  });

  it('the live transcript turn carries the REAL speaker identity into canonical evidence', () => {
    const transcript = report.legs[0]!.transcript!;
    expect(transcript.humanTurn).not.toBeNull();
    expect(transcript.humanTurn!.text).toContain('attribute me');
    expect(transcript.humanTurn!.speakerParticipantId).not.toBeNull();
  });

  it('the spoken response lifecycle is durable: completed AND interrupted (barge-in by the real human)', () => {
    const responses = report.legs[0]!.responses!;
    expect(responses).toHaveLength(2);
    const completed = responses.find((r) => r.status === 'completed');
    const interrupted = responses.find((r) => r.status === 'interrupted');
    expect(completed).toBeDefined();
    expect(completed!.completedAt).not.toBeNull();
    expect(interrupted).toBeDefined();
    expect(interrupted!.interruptedByParticipantId).not.toBeNull();
    expect(interrupted!.interruptedAt).not.toBeNull();
  });

  it('Aurum\'s speech was PUBLISHED into the real room (canonical aurum turns exist)', () => {
    const transcript = report.legs[0]!.transcript!;
    expect(transcript.aurumTurns).toHaveLength(2);
  });

  it('the real disconnect events landed (Leave reason ROOM_DELETED = 5, room gone after stop)', () => {
    const disconnect = report.legs[0]!.disconnect!;
    expect(disconnect.leaveReason).toBe(5);
    expect(disconnect.roomGoneAfterStop).toBe(true);
  });

  it('durable finalization survived the teardown: transcript artifact + session-close observation', () => {
    const leg = report.legs[0]!;
    expect(leg.finalization.runStatus).toBe('succeeded');
    expect(leg.finalization.transcriptArtifact).not.toBeNull();
    expect(leg.finalization.transcriptArtifact!.storageRef).toContain('realtime/');
    expect(leg.finalization.transcriptArtifact!.checksum).toMatch(/^sha256:/);
    expect(leg.finalization.observation).not.toBeNull();
    expect(leg.finalization.observation!.kind).toBe('realtime.session');
    expect(leg.finalization.observation!.turnCount).toBeGreaterThanOrEqual(3);
    expect(leg.finalization.observation!.recordingState).toBe('recorded');
  });

  it('the event ledger records the full canonical trail (consent, recording, transcript, lifecycle)', () => {
    const ledger = report.legs[0]!.eventsLedger;
    for (const kind of [
      'participant.joined',
      'consent.granted',
      'consent.revoked',
      'transcript.final',
      'recording.blocked',
      'recording.started',
      'recording.stopped',
      'response.completed',
      'response.interrupted',
      'session.ended',
    ]) {
      expect(ledger).toContain(kind);
    }
  });

  it('the realtime (aurum voice) leg finalized durably end-to-end', () => {
    const leg = report.legs[1]!;
    expect(leg.kind).toBe('aurum_voice');
    expect(leg.finalization.runStatus).toBe('succeeded');
    expect(leg.finalization.transcriptArtifact).not.toBeNull();
    expect(leg.finalization.observation).not.toBeNull();
    expect(leg.eventsLedger).toContain('response.completed');
  });

  it('no secret or token appears in the report (redaction held)', () => {
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(envString('LIVEKIT_API_SECRET') ?? 'SECRET-SENTINEL');
  });
});

describe.skipIf(LIVE_ENV_PRESENT)('W109 LIVE provider leg — SKIPPED (no operator credentials)', () => {
  it('documents the exact prerequisite (never a silent skip)', () => {
    // The W112 classification reads this label: without the operator
    // environment the LIVE leg is ENVIRONMENT-BLOCKED by definition.
    expect(LIVE_ENV_PRESENT).toBe(false);
  });
});
