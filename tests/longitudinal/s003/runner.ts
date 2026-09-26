// W100 — the S003 harness runner: the scenario orchestration.
//
// Runs the S002 population (11 industries x 3 sizes) through TWO scenarios
// per firm, composing ONLY real module contracts (their deterministic
// doubles where the live external does not exist — the fixtures/doubles
// doctrine):
//
//   BASELINE — the W056 core intelligence/learning loop ONLY (the
//     pre-S002 capability set): materializeCompany + advanceMonth x4 with
//     recorded learning. Nothing else is composed; the measured manual-
//     path facts are what the loop itself records.
//
//   MATURE — the same loop (same seed → the same monthly information
//     environment) PLUS the post-S002 capabilities composed around it:
//     authorized discovery (W081), the brokered connection lifecycle
//     (W082), progressive capability grants (W083), the full deep-action
//     pipeline with one seeded divergence (W084), staged migration with a
//     dual-run comparison (W094, FixtureIncumbent/FixtureNativeStore),
//     the shipped vertical starter kit where one exists (W092), the
//     cross-channel surface (channels/cellular/meetings), edge jobs for
//     on-prem stacks (W088), the governed browser fallback for no-API
//     systems (W093) and persistent agent supervision (W098).
//
// Every mature-scenario lever's invocation count is MEASURED (asserted >
// 0 by the harness test — a lever that invoked nothing is a broken
// harness, not a quiet assumption). The canonical result carries no ids
// and no timestamps: it is a pure function of the seeds, so the same seed
// reproduces byte-identical raw results.
//
// The runner is NOT a test file (vitest picks up only **/*.test.ts — the
// executor.ts precedent) and follows the import discipline of the sweeps:
// module code only through @/modules/<m>/contract.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as actionsContract from '@/modules/actions/contract';
import * as agentsContract from '@/modules/agents/contract';
import * as supervisionContract from '@/modules/agent-supervision/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as cellularContract from '@/modules/cellular/contract';
import * as channelsContract from '@/modules/channels/contract';
import * as computerUseContract from '@/modules/computer-use/contract';
import * as deepActionsContract from '@/modules/deep-actions/contract';
import * as edgeContract from '@/modules/edge-connector/contract';
import * as grantsContract from '@/modules/capability-grants/contract';
import * as identityContract from '@/modules/identity/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as meetingsContract from '@/modules/meetings/contract';
import * as migrationContract from '@/modules/migration/contract';
import * as peopleContract from '@/modules/people/contract';
import * as qualityContract from '@/modules/quality/contract';
import * as sourcesContract from '@/modules/sources/contract';
import * as verticalKitsContract from '@/modules/vertical-kits/contract';
import * as conversationsContract from '@/modules/conversations/contract';
import type {
  MonthReport,
  SimCompanyView,
  S003ComposedMeasurement,
  S003FirmResult,
  S003FirmScenarioResult,
  S003FirmSpec,
  S003LoopMeasurement,
  S003MonthMeasurement,
  S003Results,
} from '@/modules/simulator/contract';
import {
  S003_BASELINE_COST_MODEL,
  S003_FACTOR_WEIGHTS,
  S003_FIRM_SIZES,
  S003_HETEROGENEITY_SIGMA,
  S003_INDUSTRIES,
  S003_MATURATION_ASSUMPTIONS,
  S003_MATURITY_CREDITS,
  S003_MATURE_LEVERS,
  S003_MATURE_STATE_PROJECTS,
  S003_MONTHS_PER_SCENARIO,
  S003_PROJECTS_PER_MONTH,
  S003_ROLE_EMPLOYEE_INDEX,
  S003_SCORE_INTERCEPT,
  S003_THRESHOLD_ONLY,
  S003_THRESHOLD_PRIMARY,
  S003_CHANNEL_SURFACE,
  advanceMonth,
  aggregateS003Scenario,
  composeS003FirmResult,
  materializeCompany,
  round6,
  s003Cohort,
  scoreS003Scenario,
} from '@/modules/simulator/contract';
import type {
  InvestigationCostPayload,
  MissionResolutionEfficiencyPayload,
  QualityMetricResult,
  RealizedValuePayload,
  RecommendationCalibrationPayload,
  SourceSelectionPayload,
} from '@/modules/quality/types';
import {
  AcceptingCellularTransport,
  AcceptingChannelTransport,
  AllReachableVerificationTransport,
  MigrationVerificationTransport,
  ScriptedBrokerBackend,
  ScriptedDirectoryTransport,
  ScriptedIncumbentStore,
  directoryRecord,
} from './doubles';

// ---------------------------------------------------------------------------
// The pinned tick clock (the W056 discipline)
// ---------------------------------------------------------------------------

let virtualMs = Date.parse('2025-12-15T09:00:00.000Z');
const originalNow = systemClock.now;

/** Pins the clock base at one month of the company's life. */
function pinMonth(month: number): void {
  virtualMs = Date.UTC(2026, month - 1, 1, 0, 0, 0);
}

function installTickClock(): void {
  systemClock.now = () => {
    virtualMs += 60_000;
    return new Date(virtualMs);
  };
}

function restoreClock(): void {
  systemClock.now = originalNow;
}

// ---------------------------------------------------------------------------
// Principals (one tenant per firm-scenario; separation of duties)
// ---------------------------------------------------------------------------

interface FirmContexts {
  tenantId: string;
  /** The administrator: materialization + every administer claim. */
  admin: TenantContext;
  /** The Aurum intelligence employee (member) — composes the flows. */
  member: TenantContext;
  /** The human approver (actions:approve) — separation of duties. */
  approver: TenantContext;
  /** The migration reviewer (migration:review). */
  reviewer: TenantContext;
}

function contextsFor(tenantId: string): FirmContexts {
  return {
    tenantId,
    admin: {
      tenantId,
      principalId: newId(),
      authority: [
        'identity:attest',
        'identity:link',
        'integration-intelligence:administer',
        'vertical-kits:administer',
        'edge-connector:administer',
        'agents:administer',
        'migration:administer',
      ],
    },
    member: { tenantId, principalId: newId(), authority: [] },
    approver: { tenantId, principalId: newId(), authority: ['actions:approve'] },
    reviewer: { tenantId, principalId: newId(), authority: ['migration:review'] },
  };
}

// ---------------------------------------------------------------------------
// The composed-effort tracker (steps, approvals, elapsed simulated time)
// ---------------------------------------------------------------------------

class EffortTracker {
  contractCalls = 0;
  approvals = 0;
  /** W009 action requests awaiting a human decision / decided (the gate ratio). */
  actionRequestsSubmitted = 0;
  actionRequestsDecided = 0;
  private startedAtMs = 0;

  begin(): void {
    this.startedAtMs = virtualMs;
  }

  elapsedSimulatedMinutes(): number {
    return Math.round(((virtualMs - this.startedAtMs) / 60_000) * 1000) / 1000;
  }
}

// ---------------------------------------------------------------------------
// The loop measurement (MonthReports + the W055 quality families)
// ---------------------------------------------------------------------------

function payloadsOf(results: QualityMetricResult[]): Map<string, unknown> {
  return new Map(results.map((result) => [result.metricKind, result.payload]));
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function measureLoop(
  ctx: TenantContext,
  view: SimCompanyView,
  reports: readonly MonthReport[],
): Promise<S003LoopMeasurement> {
  const personToRole = new Map<string, keyof S003LoopMeasurement['participationByRole']>();
  for (const [role, index] of Object.entries(S003_ROLE_EMPLOYEE_INDEX)) {
    personToRole.set(view.employees[index]!.personId, role as keyof S003LoopMeasurement['participationByRole']);
  }

  const months: S003MonthMeasurement[] = [];
  const participationCounts: Record<keyof S003LoopMeasurement['participationByRole'], number> = {
    controller: 0,
    operations: 0,
    support: 0,
    fulfillment: 0,
    analyst: 0,
  };

  // The loop's recorded messages (participation + the measured channel).
  const allMessages = await conversationsContract.listMessages(ctx, { limit: 500 });

  for (const report of reports) {
    const snapshot = await qualityContract.getQualitySnapshot(ctx, {
      snapshotId: report.snapshotId!,
    });
    const payloads = payloadsOf(snapshot.results);
    const selection = payloads.get('source-selection') as SourceSelectionPayload | undefined;
    const efficiency = payloads.get('mission-resolution-efficiency') as
      | MissionResolutionEfficiencyPayload
      | undefined;
    const calibration = payloads.get('recommendation-calibration') as
      | RecommendationCalibrationPayload
      | undefined;
    const realized = payloads.get('realized-value') as RealizedValuePayload | undefined;
    const cost = payloads.get('investigation-cost') as InvestigationCostPayload | undefined;
    const evidence = payloads.get('evidence-quality') as
      | { observations: number; meanConfidence: number | null; shareWithConfidenceBasis: number | null }
      | undefined;

    // Measured participation: acquisitions answered by a person + the
    // month's own messages (the recorded rows of this tenant's loop).
    for (const acquisition of report.acquisitions) {
      if (acquisition.chosen.kind === 'person') {
        const role = personToRole.get(acquisition.chosen.id);
        if (role !== undefined) participationCounts[role] += 1;
      }
    }
    const evidenceIds = new Set(report.evidence.messageIds);
    for (const message of allMessages) {
      if (!evidenceIds.has(message.id)) continue;
      if (message.actor.kind === 'person' && message.actor.id !== null) {
        const role = personToRole.get(message.actor.id);
        if (role !== undefined) participationCounts[role] += 1;
      }
    }

    months.push({
      month: report.month,
      topic: report.topic,
      steps: report.steps,
      firstChoiceKind: report.firstChoice?.kind ?? null,
      firstChoiceLabel: report.firstChoice?.label ?? null,
      firstChoiceCorrect: selection ? selection.correctFirstChoice : null,
      firstChoiceTotal: selection ? selection.firstChoiceTotal : 0,
      medianSteps: efficiency ? num(efficiency.medianSteps) : null,
      meanSteps: efficiency ? num(efficiency.meanSteps) : null,
      predictionErrorMean: calibration ? num(calibration.predictionErrorMean) : null,
      metOrExceededRate: calibration ? num(calibration.metOrExceededRate) : null,
      realizedValueSum: realized ? num(realized.realizedValueSum) : null,
      netVarianceSum: realized ? num(realized.netVarianceSum) : null,
      windowPlans: cost ? num(cost.windowPlans) : null,
      windowCostMinor:
        cost !== undefined && cost.windowCostByCurrency.length > 0
          ? num(cost.windowCostByCurrency[0]!.totalCost)
          : null,
      observations: evidence ? num(evidence.observations) : null,
      meanConfidence: evidence ? num(evidence.meanConfidence) : null,
      shareWithConfidenceBasis: evidence ? num(evidence.shareWithConfidenceBasis) : null,
      learningRecorded: report.learningUpdateId !== null,
    });
  }

  // The measured channel surface of the loop's own messages.
  const loopMessageIds = new Set(reports.flatMap((report) => report.evidence.messageIds));
  const loopChannels = new Set(
    allMessages.filter((message) => loopMessageIds.has(message.id)).map((message) => message.channel),
  );

  const totalSteps = reports.reduce((sum, report) => sum + report.steps, 0);
  const judged = months.filter((month) => month.firstChoiceTotal > 0);
  const correct = judged.reduce((sum, month) => sum + (month.firstChoiceCorrect ?? 0), 0);
  const errors = months
    .map((month) => month.predictionErrorMean)
    .filter((value): value is number => value !== null);
  const confidences = months
    .map((month) => month.meanConfidence)
    .filter((value): value is number => value !== null);
  const bases = months
    .map((month) => month.shareWithConfidenceBasis)
    .filter((value): value is number => value !== null);
  const realizedSums = months
    .map((month) => month.realizedValueSum)
    .filter((value): value is number => value !== null);
  const variances = months
    .map((month) => month.netVarianceSum)
    .filter((value): value is number => value !== null);
  const costs = months
    .map((month) => month.windowCostMinor)
    .filter((value): value is number => value !== null);

  return {
    months,
    totalSteps,
    meanSteps: round6(totalSteps / Math.max(1, reports.length)),
    firstChoiceCorrectRate: round6(correct / Math.max(1, judged.length)),
    meanPredictionError: round6(
      errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length),
    ),
    evidenceMeanConfidence: round6(
      confidences.reduce((sum, value) => sum + value, 0) / Math.max(1, confidences.length),
    ),
    evidenceShareWithConfidenceBasis: round6(
      bases.reduce((sum, value) => sum + value, 0) / Math.max(1, bases.length),
    ),
    totalRealizedValueSum: round6(realizedSums.reduce((sum, value) => sum + value, 0)),
    meanNetVariance: round6(
      variances.reduce((sum, value) => sum + value, 0) / Math.max(1, variances.length),
    ),
    totalWindowCostMinor: costs.reduce((sum, value) => sum + value, 0),
    interventionsExecuted: reports.filter((report) => report.intervention !== null).length,
    participationByRole: participationCounts,
    channelsOfLoop: loopChannels.size,
  };
}

// ---------------------------------------------------------------------------
// The baseline's composed shape (measured manual-path facts, nothing else)
// ---------------------------------------------------------------------------

function baselineComposed(loop: S003LoopMeasurement): S003ComposedMeasurement {
  return {
    leverInvocations: {
      'integration-discovery': 0,
      'connection-lifecycle': 0,
      'progressive-grants': 0,
      'deep-action-execution': 0,
      'migration-continuity': 0,
      'vertical-kit': 0,
      'channel-coverage': 0,
      'edge-jobs': 0,
      'browser-fallback': 0,
      'agent-supervision': 0,
    },
    effort: { contractCalls: 0, approvals: 0, elapsedSimulatedMinutes: 0 },
    coverage: {
      systemsDiscovered: 0,
      systemsConnected: 0,
      systemsVerified: 0,
      systemsWithWritePath: 0,
      // The loop's own recorded channels are the measured baseline surface.
      channelsWithEvidence: loop.channelsOfLoop,
    },
    deepAction: {
      tasks: 0,
      operations: 0,
      opsExecuted: 0,
      opsReconciledClean: 0,
      opsMismatched: 0,
      preStateEvidence: 0,
      postStateEvidence: 0,
      mismatchUnknowns: 0,
    },
    migration: {
      roundsCommitted: 0,
      recordsImported: 0,
      identifierMappings: 0,
      conflictsSurfaced: 0,
      divergencesSurfaced: 0,
    },
    kit: { installed: false, active: false, capabilitiesInvoked: 0 },
    browser: { tasks: 0, stepsVerified: 0 },
    edge: { jobsIssued: 0, jobsSucceeded: 0 },
    channels: {
      messagesOutbound: 0,
      smsReachAttempts: 0,
      meetingsIngested: 0,
    },
    supervision: { agentsSupervised: 0, executionsAdmitted: 0, healthObservations: 0 },
    trust: {
      gateDecisionsRecorded: 0,
      actionRequestsSubmitted: 0,
      verificationRunsClean: 0,
      verificationRunsTotal: 0,
      // The loop's own append-only audit surfaces, measured: observations
      // with a confidence basis, oracle quality judgments, and recorded
      // learning updates.
      auditLedgersWithEntries:
        (loop.evidenceShareWithConfidenceBasis > 0 ? 1 : 0) +
        (loop.months.some((month) => month.learningRecorded) ? 1 : 0) +
        (loop.months.some((month) => month.firstChoiceTotal > 0) ? 1 : 0),
    },
  };
}

// ---------------------------------------------------------------------------
// The mature scenario's composed capabilities
// ---------------------------------------------------------------------------

/** One zoom envelope (the meetings adapter's documented wire shape). */
function zoomEnvelope(
  event: string,
  eventId: string,
  accountId: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event,
    event_id: eventId,
    occurredAt: '2026-01-15T09:00:00Z',
    account: { id: accountId },
    meeting: { id: 'mtg-s003', title: 'Monthly operations review' },
    ...overrides,
  };
}

async function composeMatureCapabilities(
  firm: S003FirmSpec,
  ctx: FirmContexts,
  view: SimCompanyView,
  loop: S003LoopMeasurement,
): Promise<S003ComposedMeasurement> {
  const effort = new EffortTracker();
  const leverInvocations: Record<string, number> = {
    'integration-discovery': 0,
    'connection-lifecycle': 0,
    'progressive-grants': 0,
    'deep-action-execution': 0,
    'migration-continuity': 0,
    'vertical-kit': 0,
    'channel-coverage': 0,
    'edge-jobs': 0,
    'browser-fallback': 0,
    'agent-supervision': 0,
  };
  const track = <T>(lever: string, fn: () => Promise<T>): Promise<T> => {
    leverInvocations[lever] = (leverInvocations[lever] ?? 0) + 1;
    effort.contractCalls += 1;
    return fn();
  };

  // -- The deterministic provider doubles of this run.
  const directoryTransport = new ScriptedDirectoryTransport();
  const brokerBackend = new ScriptedBrokerBackend(() => new Date(virtualMs));
  const verificationTransport = new AllReachableVerificationTransport();
  // The seeded divergence: the second deep-action target's write is
  // acknowledged but not applied — the reconciliation must surface it.
  const incumbentStore = new ScriptedIncumbentStore(['inc-record-002']);
  const channelTransport = new AcceptingChannelTransport();
  const cellularTransport = new AcceptingCellularTransport();
  const migrationVerification = new MigrationVerificationTransport();

  effort.begin();
  sourcesContract.setSourceTransport(directoryTransport);
  integrationContract.setVerificationTransport(verificationTransport);
  brokerContract.wireConnectionBrokers([
    brokerContract.createEmbeddedBroker({
      baseUrl: 'https://broker.s003.example',
      apiToken: ['emb_', 's003', '_token'].join(''),
      httpClient: brokerBackend,
    }),
  ]);
  deepActionsContract.setDeepActionTransport(incumbentStore);
  channelsContract.setChannelTransport(channelTransport);
  cellularContract.setCellularTransport(cellularTransport);

  // =====================================================================
  // LEVER: channel-coverage (channels + cellular + meetings)
  // =====================================================================
  const controller = view.employees[S003_ROLE_EMPLOYEE_INDEX.controller]!;
  const controllerGiven = controller.fullName.split(' ')[0]!.toLowerCase();

  await track('channel-coverage', () =>
    channelsContract.registerChannelConnection(ctx.member, {
      provider: 'email',
      providerAccountId: `ops@${firm.key}.s003.example`,
      credentialRef: `secret-store://s003/${firm.key}/email`,
    }),
  );
  const sent = await track('channel-coverage', () =>
    channelsContract.sendOutbound(ctx.member, {
      provider: 'email',
      to: {
        providerAccountId: `${controllerGiven}@${firm.key}.s003.example`,
        displayName: controller.fullName,
      },
      content: {
        text: 'The monthly reconciliation is ready for your sign-off.',
        attachments: [],
      },
    }),
  );

  // The SMS leg reaches the controller as a verified cross-channel
  // identity (W095's verified phone identity — the employee-messaging
  // gate the default matrix allows).
  const phoneIdentity = await track('channel-coverage', () =>
    identityContract.registerExternalIdentity(ctx.admin, {
      provider: 'sms',
      providerAccountId: `+1555${String(1000 + firm.industryIndex * 10 + firm.sizeIndex)}`,
      displayName: controller.fullName,
    }),
  );
  await track('channel-coverage', () =>
    identityContract.attestIdentity(ctx.admin, {
      identityId: phoneIdentity.identity.id,
      evidence: `S003 verified in person (${controller.fullName})`,
    }),
  );
  await track('channel-coverage', () =>
    peopleContract.linkExternalIdentity(ctx.admin, {
      personId: controller.personId,
      identityId: phoneIdentity.identity.id,
    }),
  );
  await track('channel-coverage', () =>
    cellularContract.registerCellularConnection(ctx.member, {
      provider: 'twilio',
      providerAccountId: `AC-s003-${firm.industryIndex}${firm.sizeIndex}`,
      phoneNumber: '+15550100000',
      credentialRef: `secret-store://s003/${firm.key}/sms`,
    }),
  );
  const reach = await track('channel-coverage', () =>
    cellularContract.reachAnyone(ctx.member, {
      personId: controller.personId,
      kind: 'tell',
      text: 'The monthly reconciliation is ready for your sign-off.',
    }),
  );

  const meetingAccount = `zoom-s003-${firm.industryIndex}${firm.sizeIndex}`;
  await track('channel-coverage', () =>
    meetingsContract.registerMeetingConnection(ctx.member, {
      provider: 'zoom',
      providerAccountId: meetingAccount,
      displayName: `${firm.industry.label} meetings`,
      authKind: 'credentials',
      credentialRef: `secret-store://s003/${firm.key}/zoom`,
    }),
  );
  const meetingMeta = await track('channel-coverage', () =>
    meetingsContract.receiveMeetingWebhook(ctx.member, {
      provider: 'zoom',
      payload: zoomEnvelope('meeting.updated', 'ev-s003-meta', meetingAccount, {
        meeting: {
          id: 'mtg-s003',
          title: 'Monthly operations review',
          agenda: 'The monthly reconciliation and the incumbent sync',
          scheduled_start: '2026-01-15T09:00:00Z',
          scheduled_end: '2026-01-15T10:00:00Z',
          host: { id: 'host-1', name: controller.fullName, email: null },
        },
      }),
    }),
  );
  const meetingTranscript = await track('channel-coverage', () =>
    meetingsContract.receiveMeetingWebhook(ctx.member, {
      provider: 'zoom',
      payload: zoomEnvelope('recording.transcript_completed', 'ev-s003-tr', meetingAccount, {
        session: { id: 'occ-s003' },
        transcript: {
          id: 'tr-s003',
          language: 'en-US',
          segments: [
            {
              participant_id: 'host-1',
              speaker_name: controllerGiven,
              started_at: '2026-01-15T09:01:00Z',
              ended_at: '2026-01-15T09:01:20Z',
              text: 'Let us walk through the monthly numbers.',
              confidence: 0.97,
            },
          ],
        },
      }),
    }),
  );

  // =====================================================================
  // LEVER: integration-discovery (the admin-gated authorized survey)
  // =====================================================================
  const directorySource = await track('integration-discovery', () =>
    sourcesContract.registerSource(ctx.admin, {
      provider: 'notion',
      providerAccountId: `s003-dir-${firm.industryIndex}${firm.sizeIndex}`,
      displayName: `${firm.industry.label} tooling directory`,
      authKind: 'oauth',
      credentialRef: `secret-store://s003/${firm.key}/directory`,
      oauthScopes: ['directory.read'],
      oauthExpiresAt: '2028-12-31T00:00:00Z',
    }),
  );
  await track('integration-discovery', () =>
    integrationContract.grantDiscoverySource(ctx.admin, {
      sourceId: directorySource.source.id,
    }),
  );
  directoryTransport.scriptListing(
    firm.industry.systems.map((system) =>
      directoryRecord(system.key, system.displayName, system.capabilityClasses),
    ),
  );
  await track('integration-discovery', () =>
    integrationContract.runDiscovery(ctx.member, { sourceId: directorySource.source.id }),
  );
  const inventory = await track('integration-discovery', () =>
    integrationContract.listSystems(ctx.member, {}),
  );
  const discoveredSystems = firm.industry.systems.map((spec) => {
    const found = inventory.find((entry) => entry.displayName === spec.displayName);
    if (found === undefined) {
      throw new Error(`S003 ${firm.key}: the directory did not surface '${spec.displayName}'`);
    }
    return { spec, system: found };
  });

  const recommendations = await track('integration-discovery', () =>
    integrationContract.listRecommendations(ctx.member, {}),
  );
  const batch = await track('integration-discovery', () =>
    integrationContract.submitRecommendationBatch(ctx.member, {
      recommendationIds: discoveredSystems.map(
        ({ system }) => recommendations.find((entry) => entry.systemId === system.id)!.id,
      ),
    }),
  );
  effort.actionRequestsSubmitted += 1;
  await track('integration-discovery', () =>
    integrationContract.decideRecommendationBatch(ctx.approver, {
      batchId: batch.id,
      decision: 'approve',
      note: 'S003: connect the incumbent stack',
    }),
  );
  effort.actionRequestsDecided += 1;
  effort.approvals += 1;

  // =====================================================================
  // LEVERS: connection-lifecycle + progressive-grants (per system)
  // =====================================================================
  const writeKeyOf = (classes: readonly string[]): string => `write.${classes[0]}`;
  const readKeyOf = (classes: readonly string[]): string => `read.${classes[0]}`;
  const connections: Array<{ connectionId: string; writeKey: string; readKey: string }> = [];
  for (const { spec, system } of discoveredSystems) {
    const recommendation = recommendations.find((entry) => entry.systemId === system.id)!;
    await track('integration-discovery', () =>
      integrationContract.connectSystem(ctx.member, { recommendationId: recommendation.id }),
    );
    const initiation = await track('connection-lifecycle', () =>
      brokerContract.initiateConnection(ctx.member, {
        provider: spec.provider as brokerContract.BrokerProvider,
        connectionKey: `s003-${firm.key}-${spec.key}`,
        displayName: spec.displayName,
        inventorySystemId: system.id,
      }),
    );
    const completion = await track('connection-lifecycle', () =>
      brokerContract.completeConnection(ctx.member, {
        connectionId: initiation.connection.id,
        state: initiation.authorization.state,
      }),
    );
    const writeKey = writeKeyOf(spec.capabilityClasses);
    connections.push({ connectionId: completion.connection.id, writeKey, readKey: readKeyOf(spec.capabilityClasses) });

    await track('progressive-grants', () =>
      grantsContract.establishConnectionAccess(ctx.member, {
        connectionId: completion.connection.id,
      }),
    );
    const ask = await track('progressive-grants', () =>
      grantsContract.requestCapabilityAuthority(ctx.member, {
        connectionId: completion.connection.id,
        capabilityKeys: [writeKey],
        taskContext: {
          description: 'S003: composed multi-system reconciliation write authority',
          requestedFor: `S003 ${firm.key}`,
        },
      }),
    );
    if (ask.request !== null) {
      effort.actionRequestsSubmitted += 1;
      await track('progressive-grants', () =>
        grantsContract.decideGrantRequest(ctx.approver, {
          requestId: ask.request!.id,
          decision: 'approve',
          note: 'S003: write authority for the composed task',
        }),
      );
      effort.actionRequestsDecided += 1;
      effort.approvals += 1;
    }
    const invocation = await track('progressive-grants', () =>
      grantsContract.invokeCapability(ctx.member, {
        connectionId: completion.connection.id,
        capabilityKey: writeKey,
        taskContext: {
          description: 'S003: composed multi-system reconciliation write authority',
          requestedFor: `S003 ${firm.key}`,
        },
      }),
    );
    if (invocation.outcome !== 'allowed') {
      throw new Error(`S003 ${firm.key}: the gated write invocation was not allowed`);
    }
  }

  // =====================================================================
  // LEVER: deep-action-execution (with one seeded divergence)
  // =====================================================================
  const [systemA, systemB] = [connections[0]!, connections[1]!];
  incumbentStore.seed(systemA.connectionId, 'inc-record-001', { stage: 'pending' });
  incumbentStore.seed(systemB.connectionId, 'inc-record-002', { stage: 'stale' });
  const deepTaskContext = {
    description: 'Reconcile the monthly records across the incumbent stack',
    requestedFor: `S003 ${firm.key}`,
  };
  const deepCreated = await track('deep-action-execution', () =>
    deepActionsContract.createDeepAction(ctx.member, {
      taskContext: deepTaskContext,
      operations: [
        {
          key: 'sync-record',
          connectionId: systemA.connectionId,
          capabilityKey: systemA.writeKey,
          target: 'inc-record-001',
          payload: { stage: 'reconciled' },
          expectation: { stage: 'reconciled' },
        },
        {
          key: 'update-status',
          connectionId: systemB.connectionId,
          capabilityKey: systemB.writeKey,
          target: 'inc-record-002',
          payload: { stage: 'updated' },
          expectation: { stage: 'updated' },
        },
      ],
      idempotencyKey: `s003-${firm.key}-deep-1`,
    }),
  );
  const taskId = deepCreated.task.id;
  await track('deep-action-execution', () =>
    deepActionsContract.discoverExecutionSurface(ctx.member, { taskId }),
  );
  await track('deep-action-execution', () =>
    deepActionsContract.inspectTargets(ctx.member, { taskId }),
  );
  await track('deep-action-execution', () =>
    deepActionsContract.proposeDeepAction(ctx.member, { taskId }),
  );
  effort.actionRequestsSubmitted += 1;
  const proposed = await track('deep-action-execution', () =>
    deepActionsContract.getDeepAction(ctx.member, { taskId }),
  );
  await track('deep-action-execution', () =>
    actionsContract.decideApproval(ctx.approver, {
      requestId: proposed.task.actionRequestId!,
      decision: 'approve',
      note: 'S003: governed multi-system write',
    }),
  );
  effort.actionRequestsDecided += 1;
  effort.approvals += 1;
  await track('deep-action-execution', () =>
    deepActionsContract.authorizeDeepAction(ctx.member, { taskId }),
  );
  await track('deep-action-execution', () =>
    deepActionsContract.executeDeepAction(ctx.member, { taskId }),
  );
  await track('deep-action-execution', () =>
    deepActionsContract.verifyDeepAction(ctx.member, { taskId }),
  );
  await track('deep-action-execution', () =>
    deepActionsContract.reconcileDeepAction(ctx.member, { taskId }),
  );
  const deepDetail = await track('deep-action-execution', () =>
    deepActionsContract.getDeepAction(ctx.member, { taskId }),
  );

  // =====================================================================
  // LEVER: migration-continuity (staged import + dual-run comparison)
  // =====================================================================
  const incumbentSpec = discoveredSystems[0]!.spec;
  const incumbentEntities = [1, 2, 3].map((recordIndex) => ({
    externalId: `${incumbentSpec.key.toUpperCase()}-R${recordIndex}`,
    matchKey: `${incumbentSpec.key}-natural-${recordIndex}`,
    entityType: 'record',
    payload: { stage: 'active', system: incumbentSpec.key, recordIndex },
  }));
  const fixtureIncumbent = new migrationContract.FixtureIncumbent(incumbentEntities);
  for (const entity of incumbentEntities) {
    migrationVerification.seedByExternalId(entity.externalId, entity.payload);
  }
  const nativeStore = new migrationContract.FixtureNativeStore();
  migrationContract.setMigrationIncumbentReader(fixtureIncumbent);
  migrationContract.setMigrationNativeReader(nativeStore);
  migrationContract.setMigrationVerificationTransport(migrationVerification);
  const migration = (
    await track('migration-continuity', () =>
      migrationContract.createMigration(ctx.admin, {
        incumbentSystemId: discoveredSystems[0]!.system.id,
        incumbentConnectionId: systemA.connectionId,
        incumbentReadCapabilityKey: systemA.readKey,
      }),
    )
  ).migration;
  const captured = await track('migration-continuity', () =>
    migrationContract.captureSnapshot(ctx.member, { migrationId: migration.id }),
  );
  await track('migration-continuity', () =>
    migrationContract.transformImportRound(ctx.member, { roundId: captured.round.id }),
  );
  await track('migration-continuity', () =>
    migrationContract.reviewImportRound(ctx.reviewer, { roundId: captured.round.id }),
  );
  effort.approvals += 1;
  const commit = await track('migration-continuity', () =>
    migrationContract.commitImportRound(ctx.admin, { roundId: captured.round.id }),
  );
  effort.approvals += 1;
  const mappings = await track('migration-continuity', () =>
    migrationContract.listIdentifierMappings(ctx.member, { migrationId: migration.id }),
  );
  nativeStore.mirror(
    fixtureIncumbent,
    mappings.map((entry) => ({
      externalId: entry.externalId,
      aurumEntityId: entry.aurumEntityId,
    })),
    [{ externalId: mappings[0]!.externalId, override: { stage: 'diverged' } }],
  );
  const comparison = await track('migration-continuity', () =>
    migrationContract.runComparisonRound(ctx.member, {
      migrationId: migration.id,
      note: 'S003 dual-run comparison',
    }),
  );
  const conflicts = await track('migration-continuity', () =>
    migrationContract.listIdentityConflicts(ctx.member, { migrationId: migration.id }),
  );

  // =====================================================================
  // LEVER: vertical-kit (only where a real starter kit ships)
  // =====================================================================
  let kitInstalled = false;
  let kitActive = false;
  let kitInvocations = 0;
  if (firm.industry.verticalKitKey !== null) {
    const manifest =
      firm.industry.verticalKitKey === 'legal-case-management'
        ? verticalKitsContract.LEGAL_CASE_MANAGEMENT_KIT
        : verticalKitsContract.ACCOUNTING_LEDGER_ERP_KIT;
    const registeredKit = await track('vertical-kit', () =>
      verticalKitsContract.registerKitVersion(ctx.admin, { manifest }),
    );
    await track('vertical-kit', () =>
      verticalKitsContract.runKitVerification(ctx.admin, { kitVersionId: registeredKit.version.id }),
    );
    const installed = await track('vertical-kit', () =>
      verticalKitsContract.installKit(ctx.admin, {
        kitKey: manifest.kitKey,
        version: manifest.version,
        justification: `S003: ${firm.industry.label} specialist operations`,
      }),
    );
    effort.actionRequestsSubmitted += 1;
    const decided = await track('vertical-kit', () =>
      verticalKitsContract.decideKitReview(ctx.approver, {
        installationId: installed.installation.id,
        decision: 'approve',
        note: 'S003: kit approved for the walk',
      }),
    );
    effort.actionRequestsDecided += 1;
    effort.approvals += 1;
    const activated = await track('vertical-kit', () =>
      verticalKitsContract.activateKit(ctx.admin, { installationId: decided.installation.id }),
    );
    kitInstalled = true;
    kitActive = activated.installation.status === 'active';
    const invocation = await track('vertical-kit', () =>
      verticalKitsContract.invokeKitCapability(ctx.member, {
        installationId: activated.installation.id,
        capabilityKey: manifest.requiredCapabilities[0]!.key,
        taskContext: {
          description: 'S003: invoke the kit first required capability',
          requestedFor: `S003 ${firm.key}`,
        },
      }),
    );
    kitInvocations = invocation.outcome === 'allowed' ? 1 : 0;
  }

  // =====================================================================
  // LEVER: browser-fallback (the no-API incumbent system)
  // =====================================================================
  let browserTasks = 0;
  let browserStepsVerified = 0;
  if (firm.industry.browserFallbackSystem !== null) {
    const portalUrl = 'https://portal.s003.example/login';
    const appUrl = 'https://portal.s003.example/app';
    computerUseContract.setBrowserDriver(
      computerUseContract.createScriptedBrowserDriver({
        pages: {
          [portalUrl]: { title: 'Vendor portal', fields: { heading: 'Sign in' } },
          [appUrl]: { title: 'Dashboard', fields: { loggedIn: true } },
        },
      }),
    );
    const browserTask = await track('browser-fallback', () =>
      computerUseContract.createBrowserTask(ctx.member, {
        taskContext: {
          description: `Post the monthly update in the ${firm.industry.browserFallbackSystem} portal (no API)`,
          requestedFor: `S003 ${firm.key}`,
        },
        allowlist: { urlGlobs: ['https://portal.s003.example/*'], verbs: ['goto', 'type', 'read'] },
        steps: [
          {
            key: 'open-portal',
            action: { verb: 'goto', url: portalUrl },
            expectation: { url: portalUrl, title: 'Vendor portal' },
          },
          {
            key: 'fill-reference',
            action: {
              verb: 'type',
              url: portalUrl,
              selector: '#reference',
              value: `s003-${firm.key}`,
            },
            expectation: { '#reference': `s003-${firm.key}` },
          },
          {
            key: 'enter-app',
            action: { verb: 'goto', url: appUrl },
            expectation: { url: appUrl, title: 'Dashboard', loggedIn: true },
          },
        ],
      }),
    );
    const started = await track('browser-fallback', () =>
      computerUseContract.startBrowserTask(ctx.member, { taskId: browserTask.task.id }),
    );
    browserTasks = 1;
    browserStepsVerified = started.steps.filter((step) => step.state === 'verified').length;
  }

  // =====================================================================
  // LEVER: edge-jobs (the on-prem incumbent system)
  // =====================================================================
  let edgeJobsIssued = 0;
  let edgeJobsSucceeded = 0;
  if (firm.industry.onPrem) {
    const keyId = 'key-s003';
    const keyMaterial = ['edge-enroll-', 's003', '-material'].join('');
    edgeContract.wireEdgeSigner(
      edgeContract.createHmacSigner({ secretKeys: { [keyId]: keyMaterial } }),
    );
    const edgeWriteKey =
      connections[2] !== undefined ? connections[2]!.writeKey : connections[0]!.writeKey;
    const allowlist = [
      {
        capabilityKey: edgeWriteKey,
        mode: 'write' as const,
        connectivity: 'private-api' as const,
        secretRef: 'edge-vault://s003-write',
        secretScopes: ['s003.write'],
      },
    ];
    const edge = await track('edge-jobs', () =>
      edgeContract.registerEdgeRuntime(ctx.admin, {
        name: `${firm.key} plant edge`,
        signingKeyId: keyId,
        connectivity: ['private-api'],
        allowlist,
        staleAfterSeconds: 300,
      }),
    );
    const privateApi = edgeContract.createPrivateApiDouble({
      states: { 'edge-target-001': { stage: 'onboarding' } },
    });
    const { wrapped } = edgeContract.recordAdapters({ 'private-api': privateApi });
    const runtime = edgeContract.createInMemoryEdgeRuntime({
      tenantId: ctx.tenantId,
      edgeId: edge.runtime.id,
      keyId,
      secretKey: keyMaterial,
      localAllowlist: allowlist,
      localSecrets: { 'edge-vault://s003-write': 'local-write-material' },
      adapters: { 'private-api': wrapped['private-api'] },
    });
    await track('edge-jobs', () =>
      runtime.heartbeat({ version: '1.2.0', capabilities: ['private-api'] }),
    );
    const issued = await track('edge-jobs', () =>
      edgeContract.issueEdgeJob(ctx.member, {
        edgeId: edge.runtime.id,
        kind: 'execute',
        capabilityKey: edgeWriteKey,
        target: 'edge-target-001',
        payload: { stage: 'edge-complete' },
      }),
    );
    edgeJobsIssued = 1;
    await runtime.dialHomeOnce();
    const job = await track('edge-jobs', () =>
      edgeContract.getEdgeJob(ctx.member, { jobId: issued.job.id }),
    );
    edgeJobsSucceeded = job.state === 'succeeded' ? 1 : 0;
    edgeContract.wireEdgeSigner(null);
  }

  // =====================================================================
  // LEVER: agent-supervision (persistent supervised specialist)
  // =====================================================================
  const agent = await track('agent-supervision', () =>
    agentsContract.registerAgent(ctx.admin, {
      slug: `s003-${firm.key}-specialist`,
      displayName: `${firm.industry.label} reconciliation specialist`,
      role: 'operations',
      description: 'The supervised specialist agent of the S003 mature scenario',
      provider: 'langgraph',
      instructions: 'Reconcile the monthly incumbent records under supervision.',
      runtimeConfig: { assistantId: `asst_s003_${firm.industryIndex}${firm.sizeIndex}` },
      permissions: ['observe', 'analyze', 'recommend'],
    }),
  );
  await track('agent-supervision', () =>
    supervisionContract.registerSupervisedAgent(ctx.admin, {
      agentId: agent.agent.id,
      reviewIntervalSeconds: 3_600,
      budgetMinor: 10_000,
      ownerPrincipal: 's003-owner',
    }),
  );
  const supervisedExecution = await track('agent-supervision', () =>
    supervisionContract.submitSupervisedExecution(ctx.member, {
      agentId: agent.agent.id,
      task: { duty: 'Summarize the incumbent reconciliation' },
      requestedPermissions: ['observe', 'analyze'],
      idempotencyKey: `s003-${firm.key}-sup-1`,
    }),
  );
  await track('agent-supervision', () =>
    supervisionContract.observeSupervisedAgentHealth(ctx.admin, { agentId: agent.agent.id }),
  );

  // =====================================================================
  // The measured reads (contract reads over the recorded rows)
  // =====================================================================
  const inventoryAfter = await integrationContract.listSystems(ctx.member, {});
  const connectedCount = inventoryAfter.filter(
    (entry) => entry.connectionStatus === 'connected',
  ).length;
  const verificationRuns = await integrationContract.listVerificationRuns(ctx.member, {});
  const verifiedCount = verificationRuns.filter((run) => run.status === 'verified').length;

  const deepOperations = deepDetail.operations;
  const opsExecuted = deepOperations.filter((op) => op.receiptStatus === 'accepted').length;
  const opsClean = deepOperations.filter((op) => op.state === 'matched').length;
  const opsMismatched = deepOperations.filter((op) => op.state === 'mismatched').length;
  const preEvidence = deepOperations.filter((op) => op.preStateObservationId !== null).length;
  const postEvidence = deepOperations.filter((op) => op.postStateObservationId !== null).length;
  const mismatchUnknowns = deepOperations.filter((op) => op.mismatchUnknownId !== null).length;

  // The distinct incumbent systems a composed write path actually covered:
  // the deep-action systems, the browser-fallback system and the edge
  // target's system — all measured.
  const writePathKeys = new Set<number>([0, 1]);
  if (firm.industry.browserFallbackSystem !== null && browserStepsVerified > 0) {
    writePathKeys.add(
      firm.industry.systems.findIndex((s) => s.key === firm.industry.browserFallbackSystem),
    );
  }
  if (firm.industry.onPrem && edgeJobsSucceeded > 0) {
    writePathKeys.add(connections[2] !== undefined ? 2 : 0);
  }
  const systemsWithWritePath = [...writePathKeys].filter((index) => index >= 0).length;

  return {
    leverInvocations: leverInvocations as S003ComposedMeasurement['leverInvocations'],
    effort: {
      contractCalls: effort.contractCalls,
      approvals: effort.approvals,
      elapsedSimulatedMinutes: effort.elapsedSimulatedMinutes(),
    },
    coverage: {
      systemsDiscovered: discoveredSystems.length,
      systemsConnected: connectedCount,
      systemsVerified: verifiedCount,
      systemsWithWritePath,
      channelsWithEvidence:
        loop.channelsOfLoop +
        (sent.receipt.status === 'delivered' ? 1 : 0) +
        (reach.status === 'sent' || reach.smsAttemptsCount > 0 ? 1 : 0) +
        (meetingMeta.ingested + meetingTranscript.ingested > 0 ? 1 : 0),
    },
    deepAction: {
      tasks: 1,
      operations: deepOperations.length,
      opsExecuted,
      opsReconciledClean: opsClean,
      opsMismatched,
      preStateEvidence: preEvidence,
      postStateEvidence: postEvidence,
      mismatchUnknowns,
    },
    migration: {
      roundsCommitted: commit.round.status === 'committed' ? 1 : 0,
      recordsImported: commit.records.length,
      identifierMappings: mappings.length,
      conflictsSurfaced: conflicts.length,
      divergencesSurfaced: comparison.round.divergenceCount,
    },
    kit: { installed: kitInstalled, active: kitActive, capabilitiesInvoked: kitInvocations },
    browser: { tasks: browserTasks, stepsVerified: browserStepsVerified },
    edge: { jobsIssued: edgeJobsIssued, jobsSucceeded: edgeJobsSucceeded },
    channels: {
      messagesOutbound: sent.receipt.status === 'delivered' ? 1 : 0,
      smsReachAttempts: reach.smsAttemptsCount,
      meetingsIngested: meetingMeta.ingested + meetingTranscript.ingested,
    },
    supervision: {
      agentsSupervised: 1,
      executionsAdmitted: supervisedExecution.status === 'queued' ? 1 : 0,
      healthObservations: 1,
    },
    trust: {
      gateDecisionsRecorded: effort.actionRequestsDecided,
      actionRequestsSubmitted: effort.actionRequestsSubmitted,
      verificationRunsClean: verifiedCount,
      verificationRunsTotal: verificationRuns.length,
      auditLedgersWithEntries:
        (loop.evidenceShareWithConfidenceBasis > 0 ? 1 : 0) +
        (loop.months.some((month) => month.learningRecorded) ? 1 : 0) +
        (loop.months.some((month) => month.firstChoiceTotal > 0) ? 1 : 0) +
        (effort.actionRequestsDecided > 0 ? 1 : 0) +
        (preEvidence > 0 && postEvidence > 0 ? 1 : 0),
    },
  };
}

// ---------------------------------------------------------------------------
// One firm-scenario
// ---------------------------------------------------------------------------

async function runFirmScenario(
  firm: S003FirmSpec,
  scenario: 'baseline' | 'mature',
): Promise<{ result: S003FirmScenarioResult; tenantId: string }> {
  const ctx = contextsFor(newId());

  const view = await materializeCompany(ctx.admin, { seed: firm.seed });
  const reports: MonthReport[] = [];
  for (let month = 1; month <= S003_MONTHS_PER_SCENARIO; month += 1) {
    pinMonth(month);
    reports.push(await advanceMonth(ctx.member, { companyId: view.id, learning: true }));
  }

  const loop = await measureLoop(ctx.member, view, reports);
  const composed =
    scenario === 'mature'
      ? await composeMatureCapabilities(firm, ctx, view, loop)
      : baselineComposed(loop);

  return {
    result: scoreS003Scenario(firm, scenario, loop, composed),
    tenantId: ctx.tenantId,
  };
}

// ---------------------------------------------------------------------------
// The cohort (the full S003 run)
// ---------------------------------------------------------------------------

export interface S003RunOptions {
  /** Restrict to specific firm keys (dev iteration; default: all 33). */
  firmKeys?: readonly string[];
  /**
   * Re-run these firm keys a SECOND time (fresh tenants, same seeds) and
   * return their canonical JSON for the byte-identical determinism
   * assertion. Default: none.
   */
  determinismFirmKeys?: readonly string[];
}

export interface S003RunOutcome {
  results: S003Results;
  /** The re-run canonical JSON per requested firm key. */
  determinismFirmJson: Record<string, string>;
  /** Wall-clock runtime of the run (milliseconds) — reported, not scored. */
  wallClockMs: number;
  /**
   * The tenant ids per firm scenario (NOT part of the canonical results —
   * ids are non-deterministic; exposed for the harness test's
   * failure-condition sweeps: frozen-policy discovery runs, ground-truth
   * marker leakage, tenant isolation probes).
   */
  tenants: Record<string, { baseline: string; mature: string }>;
}

export async function runS003Cohort(options: S003RunOptions = {}): Promise<S003RunOutcome> {
  const startedAt = Date.now();
  installTickClock();
  try {
    const allFirms = s003Cohort();
    const cohort = allFirms.filter(
      (firm) => options.firmKeys === undefined || options.firmKeys.includes(firm.key),
    );
    const firms: S003FirmResult[] = [];
    const tenants: Record<string, { baseline: string; mature: string }> = {};
    for (const firm of cohort) {
      const baseline = await runFirmScenario(firm, 'baseline');
      const mature = await runFirmScenario(firm, 'mature');
      tenants[firm.key] = { baseline: baseline.tenantId, mature: mature.tenantId };
      firms.push(composeS003FirmResult(firm, baseline.result, mature.result));
    }

    const determinismFirmJson: Record<string, string> = {};
    for (const key of options.determinismFirmKeys ?? []) {
      const firm = allFirms.find((entry) => entry.key === key)!;
      const baseline = await runFirmScenario(firm, 'baseline');
      const mature = await runFirmScenario(firm, 'mature');
      determinismFirmJson[key] = canonicalJson(
        composeS003FirmResult(firm, baseline.result, mature.result),
      );
    }

    const baselineAggregate = aggregateS003Scenario(firms, 'baseline');
    const matureAggregate = aggregateS003Scenario(firms, 'mature');
    const results: S003Results = {
      schemaVersion: 1,
      benchmarkId: 's003-longitudinal-conversion',
      study: 'S003 — re-run of the S002 multi-industry switching study with capabilities measured',
      interpretation:
        'This is a synthetic agent simulation for architectural and product prioritization — NOT a forecast of real customer conversion. The baseline scenario is the W056 core intelligence/learning loop (the pre-S002 capability set); the mature scenario composes the post-S002 capabilities that are actually implemented at the base SHA (their deterministic doubles where the live external does not exist). Maturation assumptions without a full real implementation stay at or near their baseline contribution and are labeled as partial-maturity per firm. The S002 baseline anchors were used to calibrate the committed factor weights, which were then frozen for both scenarios.',
      design: {
        monthsPerScenario: S003_MONTHS_PER_SCENARIO,
        projectsPerMonth: S003_PROJECTS_PER_MONTH,
        matureStateProjects: S003_MATURE_STATE_PROJECTS,
        cohort: {
          industries: S003_INDUSTRIES.length,
          sizes: S003_FIRM_SIZES.length,
          firms: firms.length,
          professionals: firms.reduce((sum, firm) => sum + firm.baseline.professionals.length, 0),
        },
        factorWeights: S003_FACTOR_WEIGHTS,
        scoreIntercept: S003_SCORE_INTERCEPT,
        thresholdOnly: S003_THRESHOLD_ONLY,
        thresholdPrimary: S003_THRESHOLD_PRIMARY,
        heterogeneitySigma: S003_HETEROGENEITY_SIGMA,
        baselineCostModel: S003_BASELINE_COST_MODEL,
        maturityCredits: S003_MATURITY_CREDITS,
        channelSurface: S003_CHANNEL_SURFACE,
        maturationAssumptions: S003_MATURATION_ASSUMPTIONS,
        matureLevers: S003_MATURE_LEVERS,
      },
      firms,
      cohort: {
        baseline: baselineAggregate,
        mature: matureAggregate,
        headline: {
          aurumOnlyShare: {
            baseline: baselineAggregate.aurumOnlyShare,
            mature: matureAggregate.aurumOnlyShare,
            delta: round6(matureAggregate.aurumOnlyShare - baselineAggregate.aurumOnlyShare),
          },
          aurumPrimaryShare: {
            baseline: baselineAggregate.aurumPrimaryShare,
            mature: matureAggregate.aurumPrimaryShare,
            delta: round6(matureAggregate.aurumPrimaryShare - baselineAggregate.aurumPrimaryShare),
          },
          contextSwitchingReduction: {
            baseline: baselineAggregate.contextSwitchingReductionMean,
            mature: matureAggregate.contextSwitchingReductionMean,
            delta: round6(
              matureAggregate.contextSwitchingReductionMean -
                baselineAggregate.contextSwitchingReductionMean,
            ),
          },
          setupEffortMinutes: {
            baseline: baselineAggregate.setupEffortMinutesMean,
            mature: matureAggregate.setupEffortMinutesMean,
            delta: round6(
              matureAggregate.setupEffortMinutesMean - baselineAggregate.setupEffortMinutesMean,
            ),
          },
          trust: {
            baseline: baselineAggregate.trustMean,
            mature: matureAggregate.trustMean,
            delta: round6(matureAggregate.trustMean - baselineAggregate.trustMean),
          },
          attributableRealizedShare: {
            baseline: baselineAggregate.attributableRealizedShareMean,
            mature: matureAggregate.attributableRealizedShareMean,
            delta: round6(
              matureAggregate.attributableRealizedShareMean -
                baselineAggregate.attributableRealizedShareMean,
            ),
          },
        },
      },
    };
    return { results, determinismFirmJson, wallClockMs: Date.now() - startedAt, tenants };
  } finally {
    // Unwire every global transport the composed flows wired.
    sourcesContract.setSourceTransport(null);
    integrationContract.setVerificationTransport(null);
    brokerContract.wireConnectionBrokers(null);
    deepActionsContract.setDeepActionTransport(null);
    channelsContract.setChannelTransport(null);
    cellularContract.setCellularTransport(null);
    computerUseContract.setBrowserDriver(null);
    edgeContract.wireEdgeSigner(null);
    migrationContract.setMigrationIncumbentReader(null);
    migrationContract.setMigrationNativeReader(null);
    migrationContract.setMigrationVerificationTransport(null);
    restoreClock();
  }
}

/** Deterministic canonical JSON (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
  }
  return value;
}
