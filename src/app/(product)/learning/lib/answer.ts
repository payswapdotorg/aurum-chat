// Learning missions, contributions & rewards (W062) — the write workflows
// of the learning surface: answering a knowledge request, and asking the
// next one.
//
// Both flows are THIN, honest compositions of the frozen domain
// contracts — no second source of truth is created anywhere:
//
//   answerKnowledgeRequest (Journey F steps 2-4, the acceptance's
//     "ask/answer knowledge requests" + "evidence capture" +
//     "contribution acknowledgement"):
//       1. the targeted question must be an OPEN ask-person acquisition
//          plan (W012) — selected, unanswered, action 'ask-person';
//       2. the answer's summary becomes the acquisition's evidence and is
//          recorded as an IMMUTABLE observation (W004) with the asked
//          person as provenance — evidence capture, never authority
//          (lock 5/10);
//       3. the contribution is anchored to the plan (W042) — ONE per
//          plan (UNIQUE), status minted 'pending' — the acknowledgement
//          the employee sees immediately;
//       4. mission-confidence updates, validation, impact measurement
//          and reward conversion stay with their owning flows (W013
//          cognition / management); this surface records, it never
//          assesses.
//
//   requestNextKnowledge (the ask half — "Aurum asks employee a targeted
//     question"): drives the W012 planner over the mission's candidate
//     menu with the SAME deterministic workflow-level signal derivation
//     the cognition loop's knowledge-acquisition stage uses (the
//     cognition contract's exported `deriveAcquisitionSignals` — focus
//     topics from the mission's own subject via the knowledge-acquisition
//     contract's `missionSubjectTopics`, person coverage from the
//     tenant's transactive memory). No signal is invented here: the
//     derivation is the module-owned default, and the planner persists
//     the full ranking rationale. The ask-policy evaluation
//     ('allowed' / 'approval_required' / 'forbidden') stays the actions
//     matrix's call (§7 "when policy permits", §20).
//
// Attribution discipline (lock 15, the W060 chat precedent): an
// authenticated principal has NO verified person linkage, so the audit
// actor is the session's display name — the DOMAIN still anchors the
// contribution's contributor to the plan's chosen person, which is the
// person the question was actually asked of.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  getAcquisitionPlan,
  missionSubjectTopics,
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import type { AcquisitionPlan } from '@/modules/knowledge-acquisition/contract';
import { deriveAcquisitionSignals } from '@/modules/cognition/contract';
import { listTransactiveEntries } from '@/modules/memory/contract';
import { getMission } from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import { recordContribution } from '@/modules/contributions/contract';
import type { Contribution } from '@/modules/contributions/contract';
import type { AnswerStrength, ValidatedAnswerInput } from './form';

// Re-exported for the API layer and the tests (the single definitions).
export {
  ANSWER_CONFIDENCE_OPTIONS,
  ANSWER_STRENGTHS,
  AnswerInputError,
  MAX_ANSWER_NOTE_LENGTH,
  MAX_ANSWER_SUMMARY_LENGTH,
  isAnswerStrength,
  validateAnswerInput,
} from './form';
export type { AnswerStrength } from './form';

// ---------------------------------------------------------------------------
// Input validation + form constants: lib/form.ts (the CLIENT-SAFE pure
// module — the one definition shared by the browser form and this server
// workflow, so the bounds and the strength vocabulary can never drift).
// ---------------------------------------------------------------------------

/**
 * Why a workflow was refused by RECORD STATE (maps to 409): the plan is
 * not an open person question, it already carries its terminal outcome,
 * or the mission is no longer active. The domain's own conflict codes
 * (`outcome_conflict`, `contribution_conflict`, `mission_not_active`)
 * arrive directly from the contracts and are mapped the same way.
 */
export class LearningStateError extends Error {
  readonly code: 'request_state';
  constructor(message: string) {
    super(message);
    this.code = 'request_state';
  }
}

// ---------------------------------------------------------------------------
// The answer workflow (the write path)
// ---------------------------------------------------------------------------

/** The basis line recorded on the answer's evidence confidence. */
export const ANSWER_CONFIDENCE_BASIS =
  'the contributing employee\u2019s own stated certainty, recorded verbatim';

/** The method slug recorded on the answer's evidence confidence. */
export const ANSWER_CONFIDENCE_METHOD = 'member-answer';

/** What one answered request produced (the acknowledgement shape). */
export interface AnswerAcknowledgement {
  planId: string;
  missionId: string;
  missionTitle: string;
  /** The immutable observation carrying the answer (evidence capture). */
  evidenceObservationId: string;
  /** The recorded contribution (status 'pending' — awaiting assessment). */
  contribution: Contribution;
}

/**
 * Answer ONE open knowledge request: record the answer as acquisition
 * evidence (an immutable observation), then anchor the contribution to
 * the plan. Contract errors propagate for the API layer to map
 * (`plan_not_found` / `outcome_conflict` / `invalid_plan_ref` …).
 */
export async function answerKnowledgeRequest(
  ctx: TenantContext,
  planId: string,
  input: ValidatedAnswerInput,
  /** The answering session's display name (audit-trail actor, lock 15). */
  answeringDisplayName: string,
): Promise<AnswerAcknowledgement> {
  const plan: AcquisitionPlan = await getAcquisitionPlan(ctx, planId);
  if (plan.decision !== 'selected' || plan.action !== 'ask-person') {
    throw new LearningStateError(
      'this plan carries no targeted person question — there is nothing to answer here',
    );
  }
  if (plan.outcome !== null) {
    throw new LearningStateError(
      `this knowledge request was already ${plan.outcome.outcome} — its outcome is terminal`,
    );
  }

  // 1 — the answer becomes the acquisition's evidence (immutable
  //     observation, the asked person as provenance — the W012 service
  //     records it through the observations contract).
  await recordAcquisitionOutcome(ctx, {
    planId,
    outcome: 'answered',
    evidence: {
      payload: {
        summary: input.summary,
        ...(input.note === null ? {} : { note: input.note }),
      },
      confidence: {
        value: answerConfidenceOf(input.confidence),
        method: ANSWER_CONFIDENCE_METHOD,
        basis: ANSWER_CONFIDENCE_BASIS,
      },
      observedAt: now().toISOString(),
    },
  });

  // 2 — the contribution anchors to the plan (ONE per plan; the W042
  //     service derives the contributor, mission, question, evidence
  //     observation and budget currency from the plan).
  const contribution = await recordContribution(ctx, {
    planId,
    summary: input.summary,
    note: input.note,
    actor: { kind: 'external', label: answeringDisplayName },
  });

  const refreshed = await getAcquisitionPlan(ctx, planId);
  const evidenceObservationId = refreshed.outcome?.evidenceObservationId ?? '';
  const mission = await getMission(ctx, plan.missionId);

  return {
    planId,
    missionId: plan.missionId,
    missionTitle: mission.content.title,
    evidenceObservationId,
    contribution,
  };
}

function answerConfidenceOf(strength: AnswerStrength): number {
  switch (strength) {
    case 'high':
      return 0.9;
    case 'medium':
      return 0.7;
    case 'low':
      return 0.4;
  }
}

// ---------------------------------------------------------------------------
// The ask workflow (the planner trigger)
// ---------------------------------------------------------------------------

/** How many transactive-memory rows the signal derivation reads. */
export const ASK_MEMORY_LIMIT = 500;

/** What one ask trigger produced. */
export interface AskOutcome {
  planId: string;
  missionId: string;
  missionTitle: string;
  /** 'selected' (a knowledge request exists) or 'no_candidate'. */
  decision: AcquisitionPlan['decision'];
  /** The chosen candidate ('selected' only). */
  chosen: { kind: string; label: string | null } | null;
  /** The composed targeted question ('ask-person' selections only). */
  question: string | null;
  /** The ask-policy evaluation that governed person candidates. */
  askPolicy: string | null;
}

/**
 * Request the NEXT knowledge acquisition for one active mission — the
 * "ask" half of the acceptance. Drives the W012 planner over the
 * mission's candidate menu with the cognition module's exported
 * workflow-level signal derivation (the same default the loop's
 * knowledge-acquisition stage applies), so no signal value is invented
 * by this surface. Contract errors propagate (`mission_not_found`,
 * inactive missions, budget rejections …).
 */
export async function requestNextKnowledge(
  ctx: TenantContext,
  missionId: string,
  /** The requesting session's display name (audit-trail actor). */
  requestingDisplayName: string,
): Promise<AskOutcome> {
  const mission: Mission = await getMission(ctx, missionId);
  if (mission.content.status !== 'active') {
    throw new LearningStateError(
      `mission '${missionId}' is ${mission.content.status} — only an active mission can acquire knowledge`,
    );
  }

  const focusTopics = missionSubjectTopics(
    mission.content.title,
    mission.content.knowledgeObjective,
  );
  const transactive = await listTransactiveEntries(ctx, {
    topics: focusTopics,
    limit: ASK_MEMORY_LIMIT,
  });
  const candidates = deriveAcquisitionSignals({
    focusTopics,
    menu: mission.content.candidateSources,
    transactive: transactive.map((entry) => ({
      actorKind: entry.actor.kind,
      actorId: entry.actor.id ?? null,
      topics: entry.topics,
    })),
  });

  const plan = await planNextAcquisition(ctx, {
    missionId,
    candidates,
    actor: { kind: 'external', label: requestingDisplayName },
    rationale: `the learning surface requested the next acquisition for '${mission.content.title}'`,
  });

  return {
    planId: plan.id,
    missionId,
    missionTitle: mission.content.title,
    decision: plan.decision,
    chosen:
      plan.decision === 'selected' && plan.chosen !== null
        ? { kind: plan.chosen.kind, label: plan.chosen.label }
        : null,
    question: plan.decision === 'selected' ? plan.question : null,
    askPolicy: plan.askPolicy === null ? null : plan.askPolicy.outcome,
  };
}
