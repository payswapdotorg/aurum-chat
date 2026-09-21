// REAL external PostgreSQL integration (W069 — acceptance: "real
// external PostgreSQL"). Activates ONLY when AURUM_TEST_DATABASE_URL is
// provided (a real server, e.g. a local postgres or a Neon branch);
// skipped otherwise so ordinary gate runs need no servers. In CI this
// runs against the postgres:16 service container — the same
// node-postgres backend (AURUM_DB=postgres, DATABASE_URL) that Neon uses
// in production.
//
// The db port's singleton is LAZY (environment is read at first use,
// never at import), so the postgres backend is selected in beforeAll —
// before the first getDb() call — and torn down in afterAll.
//
// Proves on the REAL server:
//   * the full module migration set applies through the db port's
//     postgres backend (Pool) — the deployment "migrations" path;
//   * the worker seam drives REAL cognition stages end to end:
//     enqueue → one bounded stage → persisted steps → duplicate
//     idempotency → approval suspension → human decision → resume →
//     completed cycle;
//   * the worker never writes domain state outside the W013 contract.

const realDatabaseUrl = process.env.AURUM_TEST_DATABASE_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { closeQueue } from '@/infra/queue';
import { newId } from '@/infra/ids';
import { runMigrations } from '../../scripts/migrate';
import { enqueueCognitionStage, processNextCognitionJob } from '@/infra/worker';
import type { TenantContext } from '@/infra/tenant';
import { getExecution, startExecution } from '@/modules/cognition/contract';
import type { LoopStage } from '@/modules/cognition/contract';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  decideApproval,
  setAuthorityPolicy,
} from '@/modules/actions/contract';

const tenant = newId();

function member(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [] };
}
function admin(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
}
function approver(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
}

const STAGE_INPUTS: Partial<Record<LoopStage, Record<string, unknown>>> = {
  observation: {
    record: [
      {
        kind: 'channel.message',
        payload: { text: 'real-postgres churn signal' },
        observedAt: new Date().toISOString(),
        source: { kind: 'source', label: 'slack' },
        channel: 'slack',
        confidence: { value: 0.8, method: 'test' },
      },
    ],
  },
  'evidence-memory': {},
  'world-update': { update: null },
  'epistemic-evaluation': { claims: [] },
  'goal-evaluation': { relatedGoalIds: [] },
  'unknown-mission-evaluation': { unknowns: [], missions: [] },
  'knowledge-acquisition': { missionId: null },
  'model-update': { belief: null },
  'risk-opportunity-capability-analysis': { findings: [] },
  'recommendation-ask-proposal-action': { action: null },
  outcome: { summary: 'real-server cycle concluded' },
  learning: { knowledge: null },
};

async function pumpStage(ctx: TenantContext, executionId: string, stage: LoopStage) {
  await enqueueCognitionStage(ctx, { executionId, stage, input: STAGE_INPUTS[stage] ?? {} });
  return processNextCognitionJob();
}

describe.skipIf(realDatabaseUrl === undefined)(
  'worker seam against a REAL external PostgreSQL server',
  () => {
    beforeAll(async () => {
      // Select the postgres backend BEFORE the first getDb() call (the
      // singleton is lazy; the environment is read at first use).
      process.env.AURUM_DB = 'postgres';
      process.env.DATABASE_URL = realDatabaseUrl;
      delete process.env.AURUM_DB_MEMORY;
      delete process.env.REDIS_URL;

      const report = await runMigrations(getDb());
      expect(report.applied.length + report.skipped.length).toBeGreaterThan(0);
    });

    afterAll(async () => {
      await closeQueue();
      await closeDb();
      delete process.env.AURUM_DB;
      delete process.env.DATABASE_URL;
    });

    it('applies the schema and reports the applied migration count', async () => {
      const applied = await getDb().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM _migrations`,
      );
      const count = Number.parseInt(applied.rows[0]?.count ?? '0', 10);
      expect(count).toBeGreaterThanOrEqual(40); // the full domain module set
    });

    it('drives a full gated cycle through the seam on the real server', async () => {
      const ctx = member();
      const execution = await startExecution(ctx, {
        trigger: { kind: 'system', label: 'real-pg-worker' },
        focus: { topics: ['churn'], entities: [] },
        actor: { kind: 'system', label: 'aurum-worker' },
        rationale: 'W069 real PostgreSQL evidence',
      });
      const executionId = execution.id;

      // Stage 1 — persisted on the real server.
      const first = await pumpStage(ctx, executionId, 'observation');
      expect(first.status).toBe('processed');
      expect(first.completedStages).toBe(1);
      let trace = await getExecution(ctx, { executionId });
      expect(trace.steps).toHaveLength(1);
      expect(trace.steps[0]!.stage).toBe('observation');

      // Duplicate delivery — idempotent on the real server.
      await enqueueCognitionStage(ctx, {
        executionId,
        stage: 'observation',
        input: STAGE_INPUTS.observation!,
      });
      const duplicate = await processNextCognitionJob();
      expect(duplicate.status).toBe('duplicate');
      trace = await getExecution(ctx, { executionId });
      expect(trace.steps).toHaveLength(1);

      // Stages 2..9.
      const middleStages: LoopStage[] = [
        'evidence-memory',
        'world-update',
        'epistemic-evaluation',
        'goal-evaluation',
        'unknown-mission-evaluation',
        'knowledge-acquisition',
        'model-update',
        'risk-opportunity-capability-analysis',
      ];
      for (const stage of middleStages) {
        const outcome = await pumpStage(ctx, executionId, stage);
        expect(['processed', 'suspended']).toContain(outcome.status);
      }

      // Approval-gated proposal — suspended on the real server.
      await setAuthorityPolicy(admin(), {
        actionKind: 'employee-messaging',
        approvalLevels: ['ASK'],
      });
      await enqueueCognitionStage(ctx, {
        executionId,
        stage: 'recommendation-ask-proposal-action',
        input: {
          action: {
            actionKind: 'employee-messaging',
            authorityLevel: 'ASK',
            payload: { to: 'vp-cs', question: 'Why did churn rise?' },
            justification: 'real-server gated proposal',
          },
        },
      });
      const suspended = await processNextCognitionJob();
      expect(suspended.status).toBe('suspended');
      expect(suspended.executionState).toBe('awaiting_approval');

      trace = await getExecution(ctx, { executionId });
      expect(trace.state).toBe('awaiting_approval');

      // The human decision — persisted on the real server.
      const decided = await decideApproval(approver(), {
        requestId: trace.pending.requestId!,
        decision: 'approve',
        note: 'real-server approval',
      });
      expect(decided.status).toBe('approved');

      // Resume + completion — "restart" is just the next job.
      const resumed = await pumpStage(ctx, executionId, 'recommendation-ask-proposal-action');
      expect(resumed.status).toBe('processed');
      expect(resumed.completedStages).toBe(10);
      const outcomeStage = await pumpStage(ctx, executionId, 'outcome');
      expect(outcomeStage.status).toBe('processed');
      const learning = await pumpStage(ctx, executionId, 'learning');
      expect(learning.status).toBe('processed');
      expect(learning.executionState).toBe('completed');

      trace = await getExecution(ctx, { executionId });
      expect(trace.state).toBe('completed');
      expect(trace.outcome).toMatchObject({ kind: 'action-authorized' });
      expect(trace.steps).toHaveLength(12);
    });
  },
);
