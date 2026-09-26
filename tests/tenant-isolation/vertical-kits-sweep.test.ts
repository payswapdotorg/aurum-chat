// W044 — Tenant Isolation Verification · the vertical-kits sweep (W092).
//
// The vertical-kits module (W092 — Vertical Extension Starter Kits)
// owns tenant-scoped tables for its concepts: the immutable versioned kit
// registry with its signed-manifest digests and append-only verification
// runs, the install lifecycles with their W009 gate records and frozen
// required-capability snapshots, the kit-scoped capability grants, the
// append-only invocation ledger (every gate verdict), the executed edge
// actions, and the append-only install/configure/remove events.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * a tenant's kit versions, installations, grants, invocations, edge
//     actions and events are invisible to the other tenant: every read
//     and every lifecycle call through another tenant's id is uniformly
//     not-found (no existence leak);
//   * cross-tenant lifecycle advances cannot touch another tenant's
//     installation before the not-found refusal (the status never moves);
//   * each tenant's listings show exactly its own kits and installations;
//   * authority claims never widen tenant scope: a principal of tenant B
//     holding EVERY authority claim of the repository (including
//     'vertical-kits:administer' and 'actions:approve') stays blind to
//     tenant A — authority authorizes operations, never tenant scope.
//
// The deep per-phase lifecycle cases live in the module's own suite
// (src/modules/vertical-kits/tests/); this sweep is the two-tenant proof
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
import * as verticalKits from '@/modules/vertical-kits/contract';
import { VerticalKitsError } from '@/modules/vertical-kits/errors';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

/** Every authority claim the vertical-kits surface checks, plus the
 * repository-wide set the W044 harness maintains — the omnipotent probe
 * needs both (authority authorizes operations, never tenant scope). */
const OMNIPOTENT_AUTHORITY = [
  'organizations:provision',
  'identity:attest',
  'identity:link',
  'actions:administer',
  'actions:approve',
  'agents:administer',
  'extensions:administer',
  'llm:administer',
  'notifications:administer',
  'rewards:administer',
  'workforce:decide',
  'briefings:administer',
  'api:administer',
  'marketplace:submit',
  'marketplace:administer',
  'capability-grants:administer',
  'unified-identity:administer',
  'vertical-kits:administer',
];

async function expectCode(
  code: VerticalKitsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected VerticalKitsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof VerticalKitsError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** The fixture double of the edge port (the W088 seam) — scripted, no
 * live network; the sweep exercises the REAL execution path through it. */
class SweepEdge implements verticalKits.VerticalKitEdge {
  readonly edgeId = 'sweep-edge';
  async inspect(): Promise<verticalKits.VerticalKitEdgeState> {
    return { found: false, state: null };
  }
  async execute(): Promise<verticalKits.VerticalKitEdgeReceipt> {
    return { status: 'accepted', receiptId: 'sweep-receipt', detail: null };
  }
}

/** Register + verify + install + review-approve + activate for one tenant
 * and one kit: the full governed walk to a usable installation. */
async function activateKitFor(
  tenantId: string,
  kit: verticalKits.VerticalKitManifest,
): Promise<string> {
  const admin = memberOf(tenantId, ['vertical-kits:administer']);
  const approver = memberOf(tenantId, ['actions:approve']);
  const registered = await verticalKits.registerKitVersion(admin, { manifest: kit });
  await verticalKits.runKitVerification(admin, { kitVersionId: registered.version.id });
  const installed = await verticalKits.installKit(admin, {
    kitKey: kit.kitKey,
    version: kit.version,
  });
  const decided = await verticalKits.decideKitReview(approver, {
    installationId: installed.installation.id,
    decision: 'approve',
  });
  const activated = await verticalKits.activateKit(admin, {
    installationId: decided.installation.id,
  });
  return activated.installation.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  verticalKits.setVerticalKitEdge(null);
  await closeDb();
});

describe('W044 sweep — vertical-kits (W092)', () => {
  it('the registry, installations, grants and ledgers stay per-tenant (zero leakage)', async () => {
    const adminA = memberOf(tenantA, ['vertical-kits:administer']);
    const memberA = memberOf(tenantA);
    const adminB = memberOf(tenantB, ['vertical-kits:administer']);
    const memberB = memberOf(tenantB);

    // Each tenant installs its OWN vertical kit: A the legal kit, B the
    // accounting kit (the content independence also proves the kit layer
    // carries the verticals — core stays industry-independent).
    const installationA = await activateKitFor(tenantA, verticalKits.LEGAL_CASE_MANAGEMENT_KIT);
    const installationB = await activateKitFor(tenantB, verticalKits.ACCOUNTING_LEDGER_ERP_KIT);

    // Each tenant's registry holds exactly its own versions.
    const versionsA = await verticalKits.listKitVersions(adminA, {});
    const versionsB = await verticalKits.listKitVersions(adminB, {});
    expect(versionsA.map((v) => v.kitKey)).toEqual(['legal-case-management']);
    expect(versionsB.map((v) => v.kitKey)).toEqual(['accounting-ledger-erp']);
    expect(versionsA[0]!.tenantId).toBe(tenantA);
    expect(versionsB[0]!.tenantId).toBe(tenantB);

    // Cross-tenant reads and lifecycle calls are uniformly not-found —
    // before any state is touched, no existence leak.
    await expectCode('installation_not_found', () =>
      verticalKits.getKitInstallation(memberB, { installationId: installationA }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.decideKitReview(memberB, { installationId: installationA, decision: 'approve' }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.activateKit(adminB, { installationId: installationA }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.suspendKit(adminB, { installationId: installationA }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.removeKit(adminB, { installationId: installationA }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.getKitStatus(memberB, { installationId: installationA }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.listKitEvents(memberB, { installationId: installationA }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.listKitInvocations(memberB, { installationId: installationA }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.listKitEdgeActions(memberB, { installationId: installationA }),
    );
    // A's kit version is invisible to B through the registry read too.
    const versionA = versionsA[0]!;
    await expectCode('kit_version_not_found', () =>
      verticalKits.getKitVersion(memberB, { kitVersionId: versionA.id }),
    );
    await expectCode('kit_version_not_found', () =>
      verticalKits.runKitVerification(adminB, { kitVersionId: versionA.id }),
    );

    // The installation itself never moved and B's own listing holds
    // exactly B's own installation.
    const stillA = await verticalKits.getKitInstallation(memberA, {
      installationId: installationA,
    });
    expect(stillA.installation.status).toBe('active');
    expect(await verticalKits.listKitInstallations(adminB, {})).toHaveLength(1);
    expect((await verticalKits.listKitInstallations(adminB, {}))[0]!.id).toBe(installationB);
    expect(await verticalKits.listKitInstallations(adminA, {})).toHaveLength(1);
  });

  it('the executed evidence and gate verdicts of one tenant are invisible to the other', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    // Tenant A walks the runtime path: an allowed invocation and a real
    // edge execution through the fixture double.
    verticalKits.setVerticalKitEdge(new SweepEdge());
    const installationA = (
      await verticalKits.listKitInstallations(memberA, { status: 'active' })
    ).find((installation) => installation.tenantId === tenantA)!;
    expect(installationA).toBeDefined();

    const allowed = await verticalKits.invokeKitCapability(memberA, {
      installationId: installationA.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Sweep read for tenant A' },
    });
    expect(allowed.outcome).toBe('allowed');
    const executed = await verticalKits.executeKitIntegration(memberA, {
      installationId: installationA.id,
      integrationKey: 'case-management-sor',
      target: 'matter-sweep-a',
      payload: { status: 'swept' },
      taskContext: { description: 'Sweep write for tenant A' },
    });
    expect(executed.receipt!.receiptStatus).toBe('accepted');

    // A's invocation is denied through B's context — the cross-tenant call
    // is not-found, never a silent allow.
    await expectCode('installation_not_found', () =>
      verticalKits.invokeKitCapability(memberB, {
        installationId: installationA.id,
        capabilityKey: 'read.case-matters',
        taskContext: { description: 'Cross-tenant invocation attempt' },
      }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.executeKitIntegration(memberB, {
        installationId: installationA.id,
        integrationKey: 'case-management-sor',
        target: 'matter-sweep-a',
        payload: { status: 'hijacked' },
        taskContext: { description: 'Cross-tenant execution attempt' },
      }),
    );

    // The evidence stayed in A: A's invocation ledger grew by exactly the
    // two allowed verdicts, A's edge action is recorded, and B sees none
    // of it.
    const invocationsA = await verticalKits.listKitInvocations(memberA, {
      installationId: installationA.id,
    });
    expect(invocationsA).toHaveLength(2);
    expect(invocationsA.every((i) => i.tenantId === tenantA)).toBe(true);
    expect(
      await verticalKits.listKitEdgeActions(memberA, { installationId: installationA.id }),
    ).toHaveLength(1);
    const statusA = await verticalKits.getKitStatus(memberA, {
      installationId: installationA.id,
    });
    expect(statusA.invocations.allowed).toBe(2);
    expect(statusA.grants.active).toBe(
      verticalKits.LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.length,
    );

    // Storage-level: every vertical_kits row in this sweep carries one of
    // the two tenant ids (the repository boundary half of the doctrine).
    const db = getDb();
    for (const table of [
      'vertical_kit_versions',
      'vertical_kit_verifications',
      'vertical_kit_installations',
      'vertical_kit_grants',
      'vertical_kit_invocations',
      'vertical_kit_edge_actions',
      'vertical_kit_events',
    ]) {
      const rows = await db.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM ${table}`,
      );
      for (const row of rows.rows) {
        expect([tenantA, tenantB]).toContain(row.tenant_id);
      }
    }
  });

  it('authority claims never widen tenant scope (the omnipotent probe)', async () => {
    const memberA = memberOf(tenantA);
    const omnipotentB = memberOf(tenantB, OMNIPOTENT_AUTHORITY);

    // A principal of tenant B holding EVERY authority claim of the
    // repository — including this module's own 'vertical-kits:administer'
    // and the 'actions:approve' claim — stays completely blind to tenant
    // A's kit versions and installations: uniformly not-found.
    const versionsA = await verticalKits.listKitVersions(memberA, {});
    expect(versionsA).toHaveLength(1);
    await expectCode('kit_version_not_found', () =>
      verticalKits.getKitVersion(omnipotentB, { kitVersionId: versionsA[0]!.id }),
    );
    const installationsA = await verticalKits.listKitInstallations(memberA, {});
    expect(installationsA).toHaveLength(1);
    await expectCode('installation_not_found', () =>
      verticalKits.getKitInstallation(omnipotentB, { installationId: installationsA[0]!.id }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.removeKit(omnipotentB, { installationId: installationsA[0]!.id }),
    );
    // B's own registry is still exactly B's.
    expect(await verticalKits.listKitVersions(omnipotentB, {})).toHaveLength(1);
    expect(
      (await verticalKits.listKitVersions(omnipotentB, {}))[0]!.tenantId,
    ).toBe(tenantB);
  });
});
