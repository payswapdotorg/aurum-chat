// ============================================================================
// simulator — the W056 service. The synthetic company engine and the
// month driver that runs the canonical intelligence loop over it.
//
// THE TWO DISCIPLINES THIS MODULE EXISTS TO PROVE (LONGITUDINAL-BENCHMARK.md):
//
//  1. IMPROVEMENT THROUGH RECORDED LEARNING ONLY. advanceMonth drives the
//     real cognition stack through its contracts — observation → claim →
//     goal-gap discovery (W051) → mission (W011) → acquisition planning
//     (W012, signals composed from the public design plus the W053
//     CompanyModel's learned priors via rankCandidates) → world answers →
//     mission outcome (W040) → capability intervention realized through
//     the outcomes module (W054) → recorded CompanyModel learning update
//     (W053) → ground-truth judgments and the quality snapshot (W055).
//     The experienced instance (learning: true) improves because — and
//     only because — it records those learning updates; the no-learning
//     control instance runs the identical months and stays at cold-start
//     behavior, which is exactly what the benchmark's failure conditions
//     require the harness to be able to show.
//
//  2. NO GROUND-TRUTH LEAKAGE. The hidden consequential facts live in
//     sim_hidden_facts and are consumed ONLY here, at three sanctioned
//     seams: (a) the world ORACLE — when a plan asks a source, the world
//     answers from the hidden quality of that source (the acquisition
//     channel is how knowledge legitimately enters the loop); (b) the
//     ground-truth EVALUATOR — quality judgments recorded through the
//     quality contract with oracle provenance; (c) the REVEAL surface —
//     benchmark verification. The planner-signal composition
//     (world.ts composePlannerSignals) is a pure function of the PUBLIC
//     design and the CompanyModel ranking; it structurally cannot see the
//     hidden tables. The benchmark's leakage assertions scan every
//     cognition surface for the hidden marker sentinels.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's company — and its
// hidden facts — are indistinguishable from missing ones
// (`company_not_found`, no existence leak).
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W053 + W054 + W055 →
// W056): this module imports ONLY module contracts — people, identity,
// world, sources, suppliers, goals, events, processes, observations,
// epistemics, conversations, attention, missions, knowledge-acquisition,
// learning, outcomes, quality — plus the infra port (db, clock, ids). The
// W052 evidence-derived ranking is deliberately NOT used to compose the
// planner signals: the benchmark requires improvement to arise from
// recorded CompanyModel updates only, so the learned-signal channel is
// W053's rankCandidates surface (the W053 longitudinal fixture's
// precedent); W052's rankMissionSources remains the production derivation
// this benchmark driver does not need to invoke for its claim.
// ============================================================================

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
} from '@/modules/people/contract';
import { createEntity } from '@/modules/world/contract';
import { registerSource } from '@/modules/sources/contract';
import { registerSupplier } from '@/modules/suppliers/contract';
import { createGoal } from '@/modules/goals/contract';
import { appendEvent } from '@/modules/events/contract';
import { reconstructProcess } from '@/modules/processes/contract';
import { recordObservation } from '@/modules/observations/contract';
import { recordClaim } from '@/modules/epistemics/contract';
import { recordMessage } from '@/modules/conversations/contract';
import { runGoalGapDiscovery } from '@/modules/attention/contract';
import { completeMission, getMission, reviseMission } from '@/modules/missions/contract';
import {
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import {
  defineOutcome,
  listCompanyModelAssertions,
  rankCandidates,
  recordLearningUpdate,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';
import type { AssertionDeltaInput } from '@/modules/learning/contract';
import { realizeIntervention, recordIntervention } from '@/modules/outcomes/contract';
import { computeQualitySnapshot, recordJudgment } from '@/modules/quality/contract';
import { SimulatorError } from './errors';
import type {
  AdvanceMonthInput,
  GroundTruthReveal,
  MaterializeCompanyInput,
  MonthAcquisition,
  MonthReport,
  SimCompanyView,
} from './types';
import {
  assertSimulatorTenantContext,
  validateAdvanceInput,
  validateCompanyQuery,
  validateMaterializeInput,
  validateRevealQuery,
  round4,
} from './validation';
import {
  BOTTLENECK_THRESHOLD_SECONDS,
  composePlannerSignals,
  deriveCompanyDesign,
  interventionExpectation,
  MATERIALITY_POLICY,
  nextPriorConfidence,
  SOURCE_RANK_POLICY,
  TOTAL_MONTHS,
  type CompanyDesign,
} from './world';

/** The driver identity — the simulated "Aurum instance" acting through contracts. */
const DRIVER = { kind: 'system', label: 'simulator-driver' } as const;
/** The oracle identity — the ground-truth evaluator recording quality judgments. */
const ORACLE = { kind: 'system', label: 'simulator-oracle' } as const;

/** The historical base instant of the seeded order-to-cash event pattern. */
const PROCESS_EVENT_BASE = Date.parse('2025-12-01T08:00:00Z');

// ---------------------------------------------------------------------------
// Storage rows
// ---------------------------------------------------------------------------

interface SimCompanyRow extends DbRow {
  id: string;
  tenant_id: string;
  seed: number;
  name: string;
  current_month: number;
  goal_id: string;
  process_id: string;
  manifest: {
    employees: Array<{ personId: string; fullName: string; title: string; department: string }>;
    systems: Array<{
      sourceId: string;
      key: string;
      label: string;
      provider: string;
      costMinor: number;
    }>;
    supplierIds: string[];
    projectEntityIds: string[];
    teamEntityIds: string[];
  };
  created_by_principal: string;
  created_at: Date | string;
}

interface SimHiddenFactRow extends DbRow {
  id: string;
  tenant_id: string;
  company_id: string;
  month: number;
  topic: string;
  marker: string;
  answer_text: string;
  consequential: boolean;
  first_choice_threshold: string | number;
  intervention_base_expectation: string | number;
  intervention_realized: string | number;
}

interface SimMonthReportRow extends DbRow {
  id: string;
  tenant_id: string;
  company_id: string;
  month: number;
  report: MonthReport;
  learning_update_id: string | null;
  snapshot_id: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

async function loadCompanyRow(ctx: TenantContext, companyId: string): Promise<SimCompanyRow> {
  const rows = await getDb().query<SimCompanyRow>(
    `SELECT * FROM sim_companies WHERE id = $1 AND tenant_id = $2`,
    [companyId, ctx.tenantId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new SimulatorError('company_not_found', 'company does not exist in this tenant');
  }
  return row;
}

function companyView(row: SimCompanyRow): SimCompanyView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    seed: row.seed,
    name: row.name,
    currentMonth: row.current_month,
    employees: row.manifest.employees.map((employee) => ({
      personId: employee.personId,
      fullName: employee.fullName,
      title: employee.title,
      department: employee.department,
    })),
    systems: row.manifest.systems.map((system) => ({
      sourceId: system.sourceId,
      key: system.key,
      label: system.label,
      provider: system.provider,
      costMinor: system.costMinor,
    })),
    goalId: row.goal_id,
    processId: row.process_id,
    supplierIds: [...row.manifest.supplierIds],
    projectEntityIds: [...row.manifest.projectEntityIds],
    teamEntityIds: [...row.manifest.teamEntityIds],
    createdAt: toIso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// The acquisition menu (public design → planner menu)
// ---------------------------------------------------------------------------

interface MenuEntry {
  kind: 'person' | 'system';
  id: string;
  label: string;
  authority: number;
  costMinor: number;
}

function menuOf(design: CompanyDesign, row: SimCompanyRow): MenuEntry[] {
  const menu: MenuEntry[] = [];
  design.employees.forEach((employee, index) => {
    const personId = row.manifest.employees[index]!.personId;
    menu.push({
      kind: 'person',
      id: personId,
      label: employee.fullName,
      authority: employee.authority,
      costMinor: 0,
    });
  });
  for (const system of design.systems) {
    const entry = row.manifest.systems.find((candidate) => candidate.key === system.key);
    if (entry === undefined) {
      throw new SimulatorError(
        'scenario_failed',
        `company manifest is missing system '${system.key}'`,
      );
    }
    menu.push({
      kind: 'system',
      id: entry.sourceId,
      label: system.label,
      authority: system.authority,
      costMinor: system.costMinor,
    });
  }
  return menu;
}

/** The hidden answer quality of one menu candidate (ground truth lookup). */
function hiddenQualityOf(design: CompanyDesign, row: SimCompanyRow, chosen: {
  kind: string;
  id: string;
}): number {
  if (chosen.kind === 'person') {
    const index = row.manifest.employees.findIndex((e) => e.personId === chosen.id);
    if (index >= 0) return design.employees[index]!.hiddenQuality;
  } else if (chosen.kind === 'system') {
    const entry = row.manifest.systems.find((s) => s.sourceId === chosen.id);
    if (entry !== undefined) {
      return design.systems.find((s) => s.key === entry.key)!.hiddenQuality;
    }
  }
  throw new SimulatorError('scenario_failed', `unknown menu candidate '${chosen.kind}:${chosen.id}'`);
}

// ---------------------------------------------------------------------------
// materializeCompany
// ---------------------------------------------------------------------------

export async function materializeCompany(
  ctx: TenantContext,
  input: MaterializeCompanyInput,
): Promise<SimCompanyView> {
  assertSimulatorTenantContext(ctx);
  const valid = validateMaterializeInput(input);

  // Materialization links verified channel identities — the caller's
  // principal must hold the identity authorities (fail fast with a clear
  // code rather than failing deep inside the identity contract).
  if (
    !ctx.authority.includes(IDENTITY_AUTHORITY_ATTEST) ||
    !ctx.authority.includes(IDENTITY_AUTHORITY_LINK)
  ) {
    throw new SimulatorError(
      'identity_authority_required',
      'materializeCompany requires the identity attest and link authorities (it creates verified employee channel identities)',
    );
  }

  const db = getDb();
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM sim_companies WHERE tenant_id = $1 AND seed = $2`,
    [ctx.tenantId, valid.seed],
  );
  if (existing.rows.length > 0) {
    throw new SimulatorError(
      'company_already_exists',
      'a company with this seed already exists in this tenant',
    );
  }

  const design = deriveCompanyDesign(valid.seed);
  const name = valid.name ?? design.companyName;
  const slug = `sim-c${valid.seed.toString(16)}`;
  const at = now().toISOString();

  // 1 — Employees: persons + active employments + verified linked identities.
  const employees: SimCompanyRow['manifest']['employees'] = [];
  for (let index = 0; index < design.employees.length; index += 1) {
    const employee = design.employees[index]!;
    const person = await createPerson(ctx, {
      fullName: employee.fullName,
      email: `${slug}-e${index + 1}@example.invalid`,
    });
    await createEmployee(ctx, {
      personId: person.id,
      title: employee.title,
      department: employee.department,
      hiredAt: at,
    });
    const registered = await registerExternalIdentity(ctx, {
      provider: 'slack',
      providerAccountId: `${slug}-e${index + 1}`,
      displayName: employee.fullName,
    });
    const attested = await attestIdentity(ctx, {
      identityId: registered.identity.id,
      evidence: `simulator attestation for ${employee.fullName}`,
    });
    await linkExternalIdentity(ctx, { personId: person.id, identityId: attested.id });
    employees.push({
      personId: person.id,
      fullName: employee.fullName,
      title: employee.title,
      department: employee.department,
    });
  }

  // 2 — Teams and projects (world entities).
  const teamEntityIds: string[] = [];
  for (const team of design.teams) {
    const entity = await createEntity(ctx, {
      kind: 'team',
      name: team,
      description: `Simulated team ${team}`,
      attributes: { origin: 'simulator' },
    });
    teamEntityIds.push(entity.id);
  }
  const projectEntityIds: string[] = [];
  for (const project of design.projects) {
    const entity = await createEntity(ctx, {
      kind: 'project',
      name: project,
      description: `Simulated project ${project}`,
      attributes: { origin: 'simulator' },
    });
    projectEntityIds.push(entity.id);
  }

  // 3 — Suppliers: world entities + the supplier registry (W020).
  const supplierIds: string[] = [];
  for (const supplier of design.suppliers) {
    const entity = await createEntity(ctx, {
      kind: supplier.kind,
      name: supplier.name,
      description: `Simulated ${supplier.kind} ${supplier.name}`,
      attributes: { origin: 'simulator' },
    });
    const registered = await registerSupplier(ctx, {
      name: supplier.name,
      kind: supplier.kind,
      description: `Simulated ${supplier.kind} of ${name}`,
      worldEntityId: entity.id,
      actor: DRIVER,
      rationale: 'simulator materialization',
    });
    supplierIds.push(registered.id);
  }

  // 4 — Systems of record: registered source connections (W036). The
  //     credential is an OPAQUE REFERENCE only — never a real credential.
  //     Provider account ids follow each adapter's normalization rules
  //     (quickbooks company ids are digits-only).
  const systems: SimCompanyRow['manifest']['systems'] = [];
  for (const system of design.systems) {
    const providerAccountId =
      system.provider === 'quickbooks'
        ? `${valid.seed * 10 + 1}`
        : `${slug}-${system.key}`;
    const registered = await registerSource(ctx, {
      provider: system.provider,
      providerAccountId,
      displayName: system.label,
      authKind: 'credentials',
      credentialRef: `secret-ref://simulator/${slug}/${system.key}`,
    });
    systems.push({
      sourceId: registered.source.id,
      key: system.key,
      label: system.label,
      provider: system.provider,
      costMinor: system.costMinor,
    });
  }

  // 5 — The management goal (W008).
  const controller = employees[0]!;
  const goal = await createGoal(ctx, {
    title: design.goal.title,
    objective: design.goal.objective,
    desiredState: design.goal.desiredState,
    metrics: [
      {
        name: design.goal.metricName,
        unit: design.goal.metricUnit,
        direction: 'at_most',
        threshold: design.goal.threshold,
      },
    ],
    horizonEnd: design.goal.horizonEnd,
    owner: { kind: 'person', id: controller.personId, label: controller.fullName },
    priority: 'critical',
    evidenceSources: [
      { kind: 'source', id: systems[0]!.sourceId, label: systems[0]!.label },
      { kind: 'person', id: controller.personId, label: controller.fullName },
    ],
    successCriteria: 'Monthly churn at or below the threshold for a full quarter',
    actor: { kind: 'person', id: controller.personId, label: controller.fullName },
    rationale: 'simulator materialization',
  });

  // 6 — The order-to-cash event history + process reconstruction (W016):
  //     the bottleneck finding is what the monthly intervention targets.
  const opsLead = employees[1]!;
  for (const flow of design.process.flows) {
    const correlationId = newId();
    for (let step = 0; step < design.process.eventTypes.length; step += 1) {
      await appendEvent(ctx, {
        type: design.process.eventTypes[step]!,
        payload: { flow: correlationId, step: step + 1, origin: 'simulator' },
        occurredAt: new Date(PROCESS_EVENT_BASE + flow[step]! * 60_000).toISOString(),
        actor: { kind: 'person', id: opsLead.personId, label: opsLead.fullName },
        source: { kind: 'source', label: systems[0]!.label },
        correlationId,
      });
    }
  }
  const process = await reconstructProcess(ctx, {
    name: design.process.name,
    scope: {
      eventTypes: [...design.process.eventTypes],
      occurredFrom: new Date(PROCESS_EVENT_BASE).toISOString(),
      occurredTo: new Date(PROCESS_EVENT_BASE + 7 * 86_400_000).toISOString(),
    },
    options: { bottleneckThresholdSeconds: BOTTLENECK_THRESHOLD_SECONDS },
    actor: DRIVER,
    rationale: 'simulator materialization',
  });

  // 7 — Persist the company and its hidden consequential facts.
  const manifest: SimCompanyRow['manifest'] = {
    employees,
    systems,
    supplierIds,
    projectEntityIds,
    teamEntityIds,
  };
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO sim_companies
        (tenant_id, seed, name, current_month, goal_id, process_id, manifest, created_by_principal, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz)
       RETURNING id`,
    [
      ctx.tenantId,
      valid.seed,
      name,
      valid.startMonth - 1,
      goal.id,
      process.id,
      JSON.stringify(manifest),
      ctx.principalId,
      at,
    ],
  );
  const companyId = inserted.rows[0]!.id;

  const factValues: unknown[][] = design.months.map((scenario) => [
    ctx.tenantId,
    companyId,
    scenario.month,
    scenario.topic,
    scenario.hidden.marker,
    scenario.hidden.answerText,
    scenario.hidden.consequential,
    scenario.hidden.firstChoiceCorrectThreshold,
    design.intervention.baseExpectation,
    design.intervention.realizedValue,
    at,
  ]);
  await db.query(
    `INSERT INTO sim_hidden_facts
        (tenant_id, company_id, month, topic, marker, answer_text, consequential,
         first_choice_threshold, intervention_base_expectation, intervention_realized, recorded_at)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[],
         $7::boolean[], $8::numeric[], $9::numeric[], $10::numeric[], $11::timestamptz[])`,
    [
      factValues.map((values) => values[0]),
      factValues.map((values) => values[1]),
      factValues.map((values) => values[2]),
      factValues.map((values) => values[3]),
      factValues.map((values) => values[4]),
      factValues.map((values) => values[5]),
      factValues.map((values) => values[6]),
      factValues.map((values) => values[7]),
      factValues.map((values) => values[8]),
      factValues.map((values) => values[9]),
      factValues.map((values) => values[10]),
    ],
  );

  const row = await loadCompanyRow(ctx, companyId);
  return companyView(row);
}

// ---------------------------------------------------------------------------
// advanceMonth — one month of world + intelligence loop
// ---------------------------------------------------------------------------

export async function advanceMonth(
  ctx: TenantContext,
  input: AdvanceMonthInput,
): Promise<MonthReport> {
  assertSimulatorTenantContext(ctx);
  const valid = validateAdvanceInput(input);

  const row = await loadCompanyRow(ctx, valid.companyId);
  const design = deriveCompanyDesign(row.seed);
  const month = row.current_month + 1;
  if (month > TOTAL_MONTHS) {
    throw new SimulatorError(
      'month_unavailable',
      `the company has already lived all ${TOTAL_MONTHS} months`,
    );
  }
  const scenario = design.months[month - 1]!;
  const menu = menuOf(design, row);
  const firstClockMs = now().getTime();

  const evidence: MonthReport['evidence'] = {
    readingObservationId: '',
    readingClaimId: '',
    messageIds: [],
    externalEventId: '',
  };

  // -- OBSERVE: the month's public evidence, all through contracts.
  const readingObservation = await recordObservation(ctx, {
    kind: 'metric.sample',
    payload: {
      metric: design.goal.metricName,
      value: scenario.readingValue,
      topic: scenario.topic,
      month,
    },
    observedAt: now().toISOString(),
    source: { kind: 'source', label: row.manifest.systems[0]!.label },
    channel: 'ingestion',
    confidence: { value: 0.9, method: 'system_of_record', basis: 'monthly export' },
  });
  evidence.readingObservationId = readingObservation.id;

  const claim = await recordClaim(ctx, {
    proposition: `Monthly churn rate is ${scenario.readingValue} percent in month ${month} (${scenario.topic})`,
    subject: { kind: 'goals.goal', id: row.goal_id },
    confidence: { value: 0.9, method: 'system_of_record', basis: 'monthly export' },
    evidenceObservationIds: [readingObservation.id],
    rationale: `simulated month ${month} reading`,
  });
  evidence.readingClaimId = claim.id;

  for (let index = 0; index < scenario.messages.length; index += 1) {
    const message = scenario.messages[index]!;
    const sender = row.manifest.employees[message.senderIndex]!;
    const recorded = await recordMessage(ctx, {
      direction: 'inbound',
      actor: { kind: 'person', personId: sender.personId },
      channel: 'slack',
      payload: { text: message.text, topic: scenario.topic },
      sentAt: now().toISOString(),
      conversationTitle: `Month ${month} — ${scenario.topic}`,
      providerMessageId: `sim-${row.id}-m${month}-msg${index + 1}`,
    });
    evidence.messageIds.push(recorded.id);
  }

  const externalEvent = await appendEvent(ctx, {
    type: scenario.externalEvent.type,
    payload: { topic: scenario.topic, month, note: scenario.externalEvent.label },
    occurredAt: now().toISOString(),
    actor: { kind: 'external', label: 'world-sim' },
    source: { kind: 'external', label: 'world-sim' },
  });
  evidence.externalEventId = externalEvent.id;

  // -- ATTEND: unprompted goal-gap discovery over the month's evidence.
  const discovery = await runGoalGapDiscovery(ctx, {
    trigger: { kind: 'scheduled', label: `simulator month ${month} goal-gap sweep` },
    goalIds: [row.goal_id],
    policy: MATERIALITY_POLICY,
    readings: [
      {
        goalId: row.goal_id,
        metricName: design.goal.metricName,
        value: scenario.readingValue,
        driverConfidence: design.goal.driverConfidence,
        evidenceClaimIds: [claim.id],
      },
    ],
    investigationBudget: { ...design.missionBudget },
    rewardBudget: { ...design.rewardBudget },
    actor: DRIVER,
    rationale: `simulated month ${month}`,
  });
  const promoted = discovery.candidates.filter((candidate) => candidate.disposition === 'promoted');
  if (promoted.length !== 1) {
    throw new SimulatorError(
      'scenario_failed',
      `month ${month} produced ${promoted.length} promoted candidates (expected exactly 1)`,
    );
  }
  const candidate = promoted[0]!;
  const missionId = candidate.missionId!;

  // -- The full candidate menu on the launched mission.
  await reviseMission(ctx, {
    missionId,
    candidateSources: menu.map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      label: entry.label,
    })),
    actor: DRIVER,
    rationale: `simulator month ${month}: the standard candidate menu`,
  });
  const mission = await getMission(ctx, missionId);
  const targetConfidence = mission.content.targetConfidence;

  // -- PLAN/ACQUIRE: the walk. Signals are composed from the PUBLIC design
  //    plus the CompanyModel's learned priors (the only learning channel —
  //    see the module header). The same frozen policy object on every call.
  const ranking = await rankCandidates(ctx, {
    domain: 'source_selection',
    candidates: menu.map((entry) => ({
      kind: entry.kind === 'person' ? ('employee' as const) : ('source' as const),
      id: entry.id,
      label: entry.label,
    })),
    policy: SOURCE_RANK_POLICY,
  });
  const learnedByKey = new Map(ranking.candidates.map((ranked) => [ranked.key, ranked.score]));

  const acquisitions: MonthAcquisition[] = [];
  const answerEvidenceByCandidate = new Map<string, Array<{ observationId: string; quality: number }>>();
  let currentConfidence = mission.content.currentConfidence;
  let firstChoice: MonthReport['firstChoice'] = null;
  let resolution: MonthReport['resolution'] = null;

  for (let step = 0; step < menu.length; step += 1) {
    const signals = composePlannerSignals(menu, learnedByKey);
    const plan = await planNextAcquisition(ctx, {
      missionId,
      candidates: signals,
      actor: DRIVER,
      rationale: `simulated month ${month} acquisition ${step + 1}`,
    });
    if (plan.decision !== 'selected' || plan.chosen === null) break;
    if (firstChoice === null) {
      firstChoice = {
        kind: plan.chosen.kind as 'person' | 'system',
        id: plan.chosen.id!,
        label: plan.chosen.label ?? plan.chosen.id!,
      };
    }

    // The world answers from the hidden quality of the chosen source — the
    // sanctioned ground-truth seam (an acquisition is how knowledge enters).
    const quality = hiddenQualityOf(design, row, {
      kind: plan.chosen.kind,
      id: plan.chosen.id ?? '',
    });
    const answered = await recordAcquisitionOutcome(ctx, {
      planId: plan.id,
      outcome: 'answered',
      evidence: {
        payload: { answer: scenario.hidden.answerText, topic: scenario.topic, month },
        confidence: {
          value: quality,
          method: 'world_answer',
          basis: 'synthetic company oracle',
        },
      },
    });
    acquisitions.push({
      planId: plan.id,
      chosen: {
        kind: plan.chosen.kind as 'person' | 'system',
        id: plan.chosen.id ?? '',
        label: plan.chosen.label ?? plan.chosen.id ?? '',
      },
      action: plan.action ?? 'query-system',
      outcome: 'answered',
      evidenceObservationId: answered.outcome?.evidenceObservationId ?? null,
    });
    const evidenceKey = `${plan.chosen.kind}:${plan.chosen.id}`;
    const tracked = answerEvidenceByCandidate.get(evidenceKey) ?? [];
    tracked.push({ observationId: answered.outcome?.evidenceObservationId ?? '', quality });
    answerEvidenceByCandidate.set(evidenceKey, tracked);

    const newConfidence = Math.max(currentConfidence, quality);
    if (newConfidence >= targetConfidence) {
      await completeMission(ctx, {
        missionId,
        achievedConfidence: newConfidence,
        outcome: scenario.hidden.answerText,
        actor: DRIVER,
      });
      resolution = { missionId, achievedConfidence: newConfidence, missionOutcomeId: '' };
      break;
    }
    if (newConfidence > currentConfidence) {
      await reviseMission(ctx, {
        missionId,
        currentConfidence: newConfidence,
        actor: DRIVER,
        rationale: `simulator month ${month}: evidence raised confidence`,
      });
      currentConfidence = newConfidence;
    }
  }

  if (resolution === null) {
    throw new SimulatorError(
      'scenario_failed',
      `month ${month} did not resolve its mission (walk exhausted)`,
    );
  }

  // -- The mission outcome (W040): every answered acquisition is a
  //    measurement; the settlement is grounded in the final evidence.
  const missionOutcome = await defineOutcome(ctx, {
    subject: { kind: 'mission', id: missionId, label: mission.content.title },
    metricName: 'investigation evidence confidence',
    metricUnit: 'confidence',
    direction: 'at_least',
    baseline: design.goal.driverConfidence,
    expected: targetConfidence,
    horizon: null,
    affectedGoals: [{ goalId: row.goal_id, label: design.goal.title }],
    originExecutionId: null,
    actor: DRIVER,
    rationale: `simulated month ${month} mission outcome`,
  });
  let lastMeasurementId = '';
  for (const entry of acquisitions) {
    const quality = hiddenQualityOf(design, row, { kind: entry.chosen.kind, id: entry.chosen.id });
    const measurement = await recordMeasurement(ctx, {
      outcomeId: missionOutcome.id,
      value: quality,
      note: `${entry.chosen.label} answer`,
      evidence: [{ kind: 'observation', id: entry.evidenceObservationId ?? null, label: entry.chosen.label }],
      actor: DRIVER,
    });
    lastMeasurementId = measurement.id;
  }
  await settleOutcome(ctx, {
    outcomeId: missionOutcome.id,
    measurementId: lastMeasurementId,
    note: `simulated month ${month} resolved in ${acquisitions.length} steps`,
    actor: DRIVER,
  });
  resolution.missionOutcomeId = missionOutcome.id;

  // -- INTERVENE: the month's capability change on the recurring bottleneck.
  //    The expectation is the recommendation-quality leg: the cold start
  //    expects the base in full; the experienced instance blends the
  //    learned intervention prior (W053 rankCandidates, intervention domain).
  const interventionRanking = await rankCandidates(ctx, {
    domain: 'intervention',
    candidates: [{ kind: 'intervention', name: design.intervention.name, baseScore: 1 }],
  });
  const expected = interventionExpectation(
    design.intervention.baseExpectation,
    interventionRanking.candidates[0]!.score,
  );
  const recommendationOutcome = await defineOutcome(ctx, {
    subject: {
      kind: 'recommendation',
      id: newId(),
      label: design.intervention.recommendationLabel,
    },
    metricName: design.intervention.metricName,
    metricUnit: design.intervention.metricUnit,
    direction: 'at_least',
    baseline: 0,
    expected,
    horizon: null,
    affectedGoals: [{ goalId: row.goal_id, label: design.goal.title }],
    originExecutionId: null,
    actor: DRIVER,
    rationale: `simulated month ${month} recommendation`,
  });
  const intervention = await recordIntervention(ctx, {
    kind: design.intervention.kind,
    capabilityLabel: design.intervention.capabilityLabel,
    target: { kind: 'process', id: row.process_id, label: design.process.name },
    originGoalIds: [{ goalId: row.goal_id, label: design.goal.title }],
    originRecommendationId: recommendationOutcome.subject.id,
    authorizationRef: { kind: 'approval', id: newId(), label: 'simulated management approval' },
    outcomeId: recommendationOutcome.id,
    actor: DRIVER,
    rationale: `simulated month ${month} intervention`,
  });
  const realizedMeasurement = await recordMeasurement(ctx, {
    outcomeId: recommendationOutcome.id,
    value: design.intervention.realizedValue,
    note: 'automation telemetry',
    evidence: [{ kind: 'metric', label: 'automation telemetry' }],
    actor: DRIVER,
  });
  await settleOutcome(ctx, {
    outcomeId: recommendationOutcome.id,
    measurementId: realizedMeasurement.id,
    note: `simulated month ${month} realized`,
    actor: DRIVER,
  });
  await realizeIntervention(ctx, { interventionId: intervention.id, actor: DRIVER });
  const interventionReport: MonthReport['intervention'] = {
    recommendationOutcomeId: recommendationOutcome.id,
    interventionId: intervention.id,
    expected,
  };

  // -- LEARN (experienced instances only): ONE recorded CompanyModel
  //    update teaching every queried source's reliability and the
  //    intervention's effectiveness, each linked to the month's settled
  //    outcomes and answer evidence — the only improvement channel.
  let learningUpdateId: string | null = null;
  if (valid.learning) {
    const changes: AssertionDeltaInput[] = [];
    for (const [key, entries] of answerEvidenceByCandidate) {
      const [kind, id] = key.split(':') as ['person' | 'system', string];
      const subjectKind = kind === 'person' ? ('employee' as const) : ('source' as const);
      const existing = await listCompanyModelAssertions(ctx, {
        subjectKey: `${subjectKind}:${id}`,
        topic: 'reliability',
        limit: 500,
      });
      changes.push({
        area: 'source_reliability',
        subject: {
          kind: subjectKind,
          id,
          label: menu.find((entry) => entry.id === id)?.label ?? null,
        },
        topic: 'reliability',
        statement: { score: entries[entries.length - 1]!.quality },
        confidence: nextPriorConfidence(existing.length),
        evidence: entries
          .filter((entry) => entry.observationId !== '')
          .map((entry) => ({
            kind: 'observation' as const,
            id: entry.observationId,
            label: `month ${month} answer evidence`,
          })),
        outcomeId: missionOutcome.id,
      });
    }
    const interventionSubjectKey = `intervention:${design.intervention.name}`;
    const existingIntervention = await listCompanyModelAssertions(ctx, {
      subjectKey: interventionSubjectKey,
      topic: 'effectiveness',
      limit: 500,
    });
    changes.push({
      area: 'intervention_prior',
      subject: { kind: 'intervention', name: design.intervention.name },
      topic: 'effectiveness',
      // The learned effectiveness: the realized share of the BASE
      // expectation — a stable property of the intervention (ADR-0016's
      // "intervention effectiveness priors"), so blending it into the
      // base converges the expectation toward the hidden realized value
      // as confidence grows (a realized/current-expected ratio would
      // instead drift toward 1 as expectations calibrate and would
      // never converge).
      statement: { score: round4(design.intervention.realizedValue / design.intervention.baseExpectation) },
      confidence: nextPriorConfidence(existingIntervention.length),
      evidence: [{ kind: 'metric' as const, label: 'automation telemetry' }],
      outcomeId: recommendationOutcome.id,
    });
    const update = await recordLearningUpdate(ctx, {
      changes,
      rationale: `simulated month ${month}: source reliabilities and intervention effectiveness learned from mission and recommendation outcomes`,
      actor: DRIVER,
    });
    learningUpdateId = update.id;
  }

  // -- JUDGE: the oracle records the month's ground truth (evaluation
  //    evidence with evaluator provenance — the quality contract's
  //    designed purpose).
  const judgmentIds: string[] = [];
  if (valid.judgments) {
    const consequentiality = await recordJudgment(ctx, {
      kind: 'unknown-consequentiality',
      gapKey: candidate.gapKey,
      candidateId: candidate.id,
      verdict: scenario.hidden.consequential ? 'consequential' : 'not_consequential',
      evaluator: ORACLE,
      note: 'simulator oracle ground truth',
    });
    judgmentIds.push(consequentiality.id);
    if (firstChoice !== null) {
      const firstQuality = hiddenQualityOf(design, row, {
        kind: firstChoice.kind,
        id: firstChoice.id,
      });
      const selection = await recordJudgment(ctx, {
        kind: 'source-selection',
        planId: acquisitions[0]!.planId,
        verdict:
          firstQuality >= scenario.hidden.firstChoiceCorrectThreshold ? 'correct' : 'incorrect',
        evaluator: ORACLE,
        note: 'simulator oracle ground truth',
      });
      judgmentIds.push(selection.id);
    }
  }

  // -- MEASURE: the end-of-month quality snapshot (W055) over the month's
  //    own clock span (the caller pins the clock per month; the window is
  //    derived from this call's own first/last readings).
  const windowFrom = new Date(firstClockMs - 1).toISOString();
  const windowTo = new Date(now().getTime() + 3_600_000).toISOString();
  let snapshotId: string | null = null;
  if (valid.snapshot) {
    const snapshot = await computeQualitySnapshot(ctx, {
      windowFrom,
      windowTo,
      metricKinds: [
        'unknown-discovery',
        'source-selection',
        'mission-resolution-efficiency',
        'evidence-quality',
        'recommendation-calibration',
        'intervention-success',
        'realized-value',
        'investigation-cost',
        'time-to-useful-understanding',
      ],
      originExecutionId: null,
      actor: { kind: 'system', label: 'simulator-benchmark' },
      rationale: `simulated month ${month} quality snapshot`,
    });
    snapshotId = snapshot.id;
  }

  // -- Record the month (own tables only; the cursor and the report commit
  //    together).
  const report: MonthReport = {
    companyId: row.id,
    tenantId: ctx.tenantId,
    month,
    topic: scenario.topic,
    windowFrom,
    windowTo,
    evidence,
    discoveryRunId: discovery.id,
    promotedCandidates: [
      {
        candidateId: candidate.id,
        gapKey: candidate.gapKey,
        missionId,
        unknownId: candidate.epistemicsUnknownId ?? '',
      },
    ],
    acquisitions,
    resolution,
    intervention: interventionReport,
    learningUpdateId,
    judgmentIds,
    snapshotId,
    steps: acquisitions.length,
    firstChoice,
  };
  await getDb().transaction(async (tx) => {
    await tx.query(
      `UPDATE sim_companies SET current_month = $2 WHERE id = $1 AND tenant_id = $3`,
      [row.id, month, ctx.tenantId],
    );
    await tx.query(
      `INSERT INTO sim_month_reports
          (tenant_id, company_id, month, report, learning_update_id, snapshot_id,
           recorded_by_principal, recorded_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz)`,
      [
        ctx.tenantId,
        row.id,
        month,
        JSON.stringify(report),
        learningUpdateId,
        snapshotId,
        ctx.principalId,
        now().toISOString(),
      ],
    );
  });

  return report;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCompany(
  ctx: TenantContext,
  input: { companyId: string },
): Promise<SimCompanyView> {
  assertSimulatorTenantContext(ctx);
  const valid = validateCompanyQuery(input);
  const row = await loadCompanyRow(ctx, valid.companyId);
  return companyView(row);
}

export async function revealGroundTruth(
  ctx: TenantContext,
  input: { companyId: string; month: number },
): Promise<GroundTruthReveal> {
  assertSimulatorTenantContext(ctx);
  const valid = validateRevealQuery(input);
  const row = await loadCompanyRow(ctx, valid.companyId);
  const design = deriveCompanyDesign(row.seed);

  const rows = await getDb().query<SimHiddenFactRow>(
    `SELECT * FROM sim_hidden_facts WHERE company_id = $1 AND tenant_id = $2 AND month = $3`,
    [valid.companyId, ctx.tenantId, valid.month],
  );
  const fact = rows.rows[0];
  if (fact === undefined) {
    throw new SimulatorError(
      'company_not_found',
      'hidden fact does not exist in this tenant',
    );
  }

  const hiddenQualities: Array<GroundTruthReveal['hiddenQualities'][number]> = [];
  row.manifest.employees.forEach((employee, index) => {
    hiddenQualities.push({
      key: 'person',
      id: employee.personId,
      label: employee.fullName,
      quality: design.employees[index]!.hiddenQuality,
    });
  });
  for (const system of row.manifest.systems) {
    const systemDesign = design.systems.find((entry) => entry.key === system.key)!;
    hiddenQualities.push({
      key: 'system',
      id: system.sourceId,
      label: system.label,
      quality: systemDesign.hiddenQuality,
    });
  }

  return {
    companyId: row.id,
    tenantId: ctx.tenantId,
    month: valid.month,
    topic: fact.topic,
    marker: fact.marker,
    answerText: fact.answer_text,
    consequential: fact.consequential,
    firstChoiceCorrectThreshold: toNumber(fact.first_choice_threshold),
    hiddenQualities,
    intervention: {
      baseExpectation: toNumber(fact.intervention_base_expectation),
      realizedValue: toNumber(fact.intervention_realized),
      name: design.intervention.name,
    },
  };
}

/** The recorded month reports of one company (benchmark bookkeeping). */
export async function listMonthReports(
  ctx: TenantContext,
  input: { companyId: string },
): Promise<MonthReport[]> {
  assertSimulatorTenantContext(ctx);
  const valid = validateCompanyQuery(input);
  await loadCompanyRow(ctx, valid.companyId);
  const rows = await getDb().query<SimMonthReportRow>(
    `SELECT * FROM sim_month_reports
       WHERE company_id = $1 AND tenant_id = $2
       ORDER BY month ASC`,
    [valid.companyId, ctx.tenantId],
  );
  return rows.rows.map((row) => row.report);
}
