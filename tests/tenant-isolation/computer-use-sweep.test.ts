// W044 — Tenant Isolation Verification · the computer-use sweep (W093).
//
// The computer-use module (W093 — Browser and Computer-Use Fallback)
// owns tenant-scoped tables for its concepts: the durable governed
// browser tasks with their frozen allowlists and opaque credential
// references, the frozen step plans with their per-step outcome links
// (allowlist decisions, opaque driver receipts, observed-state evidence,
// screenshot references, redacted action traces, mismatch links), the
// disposable browser sessions bound to per-(tenant,task) isolated
// profiles, and the append-only lifecycle events.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * a task (and its steps, sessions and events) is invisible to the
//     other tenant: every read and every lifecycle call through another
//     tenant's task id is uniformly not-found (no existence leak);
//   * cross-tenant phase advances cannot touch another tenant's task
//     before the not-found refusal (the task status never moves);
//   * the other tenant's isolated browser profile is never touched (the
//     driver materializes credentials only inside each tenant's own
//     per-(tenant,task) profile);
//   * each tenant's listings show exactly its own tasks.
//
// The deep per-phase isolation cases live in the module's own suite
// (src/modules/computer-use/tests/); this sweep is the two-tenant proof
// the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import * as computerUse from '@/modules/computer-use/contract';
import { createScriptedBrowserDriver } from '@/modules/computer-use/contract';
import { ComputerUseError } from '@/modules/computer-use/errors';
import type { BrowserAllowlist, BrowserStepInput } from '@/modules/computer-use/contract';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: ComputerUseError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ComputerUseError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ComputerUseError)) throw error;
    expect(error.code).toBe(code);
  }
}

// Fake credentials are assembled from fragments at runtime.
function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w093-sweep/` + `${label}/` + 'ref';
}

const LOGIN_URL = 'https://vendor.example/login';
const ALLOWLIST: BrowserAllowlist = {
  urlGlobs: ['https://vendor.example/*'],
  verbs: ['goto', 'type', 'read'],
};

/** One governed login-flow task per tenant, run to completion. */
function governedPlan(): BrowserStepInput[] {
  return [
    {
      key: 'open-login',
      action: { verb: 'goto', url: LOGIN_URL },
      expectation: { url: LOGIN_URL, title: 'Vendor portal', heading: 'Sign in' },
    },
    {
      key: 'type-username',
      action: { verb: 'type', url: LOGIN_URL, selector: '#username', value: 'ops@example.net' },
      expectation: { '#username': 'ops@example.net' },
    },
  ];
}

let driver: ReturnType<typeof createScriptedBrowserDriver>;

beforeAll(async () => {
  await runMigrations(getDb());
  driver = createScriptedBrowserDriver({
    pages: {
      [LOGIN_URL]: { title: 'Vendor portal', fields: { heading: 'Sign in' } },
    },
  });
  computerUse.setBrowserDriver(driver);
});

afterAll(async () => {
  computerUse.setBrowserDriver(null);
  await closeDb();
});

describe('W044 sweep — computer-use (W093)', () => {
  it('the tasks, steps, sessions and events stay per-tenant (zero leakage)', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    // Each tenant plans and runs its own governed browser task.
    const createdA = await computerUse.createBrowserTask(memberA, {
      taskContext: { description: 'Sweep tenant A vendor login' },
      allowlist: ALLOWLIST,
      steps: governedPlan(),
      credentialRef: fakeCredentialRef(`a-${tenantA.slice(0, 8)}`),
    });
    const createdB = await computerUse.createBrowserTask(memberB, {
      taskContext: { description: 'Sweep tenant B vendor login' },
      allowlist: ALLOWLIST,
      steps: governedPlan(),
      credentialRef: fakeCredentialRef(`b-${tenantB.slice(0, 8)}`),
    });
    expect(createdA.task.tenantId).toBe(tenantA);
    expect(createdB.task.tenantId).toBe(tenantB);

    // Cross-tenant reads and lifecycle calls are uniformly not-found —
    // before any state is touched, no existence leak.
    await expectCode('task_not_found', () =>
      computerUse.getBrowserTask(memberB, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      computerUse.startBrowserTask(memberB, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      computerUse.resumeBrowserTask(memberB, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      computerUse.getBrowserFailureEvidence(memberB, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      computerUse.listBrowserTaskEvents(memberB, { taskId: createdA.task.id }),
    );

    // Each tenant runs its own task to completion.
    const doneA = await computerUse.startBrowserTask(memberA, { taskId: createdA.task.id });
    const doneB = await computerUse.startBrowserTask(memberB, { taskId: createdB.task.id });
    expect(doneA.task.status).toBe('completed');
    expect(doneB.task.status).toBe('completed');

    // A's task never moved for B's probes; listings hold exactly each
    // tenant's own task.
    const stillA = await computerUse.getBrowserTask(memberA, { taskId: createdA.task.id });
    expect(stillA.task.status).toBe('completed');
    expect(await computerUse.listBrowserTasks(memberA, {})).toHaveLength(1);
    expect(await computerUse.listBrowserTasks(memberB, {})).toHaveLength(1);
    expect((await computerUse.listBrowserTasks(memberA, {}))[0]!.id).toBe(createdA.task.id);
    expect((await computerUse.listBrowserTasks(memberB, {}))[0]!.id).toBe(createdB.task.id);

    // The completed reads of one tenant refuse the other's phases too.
    await expectCode('task_not_pending_phase', () =>
      computerUse.startBrowserTask(memberA, { taskId: createdA.task.id }),
    );
    await expectCode('task_not_found', () =>
      computerUse.startBrowserTask(memberB, { taskId: createdA.task.id }),
    );
  });

  it('session credentials are isolated per (tenant, task): each tenant materializes only its own reference, in its own profile', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    const refA = fakeCredentialRef(`iso-a-${tenantA.slice(0, 8)}`);
    const refB = fakeCredentialRef(`iso-b-${tenantB.slice(0, 8)}`);
    const taskA = await computerUse.createBrowserTask(memberA, {
      taskContext: { description: 'Sweep isolation A' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { title: 'Vendor portal' },
        },
      ],
      credentialRef: refA,
    });
    const taskB = await computerUse.createBrowserTask(memberB, {
      taskContext: { description: 'Sweep isolation B' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { title: 'Vendor portal' },
        },
      ],
      credentialRef: refB,
    });
    await computerUse.startBrowserTask(memberA, { taskId: taskA.task.id });
    await computerUse.startBrowserTask(memberB, { taskId: taskB.task.id });

    // The driver-side profiles are distinct per (tenant, task) and each
    // materialized ONLY its own tenant's opaque reference.
    const profileA = computerUse.browserProfileKey(tenantA, taskA.task.id);
    const profileB = computerUse.browserProfileKey(tenantB, taskB.task.id);
    expect(profileA).not.toBe(profileB);
    expect(profileA).toContain(`tenant:${tenantA}:task:`);
    expect(profileB).toContain(`tenant:${tenantB}:task:`);
    expect(driver.materializedRefs.get(profileA)).toBe(refA);
    expect(driver.materializedRefs.get(profileB)).toBe(refB);
    expect(driver.materializedValueOf(profileA, 'password')).not.toBe(
      driver.materializedValueOf(profileB, 'password'),
    );

    // No materialized secret value ever persisted in any tenant's rows.
    const sweep = await getDb().query<{ bad: string }>(`
      SELECT count(*)::text AS bad FROM (
        SELECT to_jsonb(browser_tasks) AS row FROM browser_tasks
        UNION ALL SELECT to_jsonb(browser_task_steps) FROM browser_task_steps
        UNION ALL SELECT to_jsonb(browser_sessions) FROM browser_sessions
        UNION ALL SELECT to_jsonb(browser_task_events) FROM browser_task_events
        UNION ALL SELECT to_jsonb(browser_task_idempotency) FROM browser_task_idempotency
      ) everything WHERE everything.row::text LIKE '%materialized-%'
    `);
    expect(sweep.rows[0]!.bad).toBe('0');
  });

  it('the storage partition itself is intact after the sweep fixtures ran', async () => {
    const { assertTenantPartition } = await import('./harness');
    await assertTenantPartition([tenantA, tenantB]);
  });
});
