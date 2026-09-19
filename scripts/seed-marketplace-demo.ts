// W064 smoke-test seed — populates the file-backed embedded dev database
// with a complete, real governed marketplace state so the product
// surfaces can be rendered against live data in the browser:
//
//   * vendor tenant (Acme Software) + platform tenant + installer tenant;
//   * a verified manifest frozen as an INSTALLABLE extension package;
//   * an INSTALLABLE agent package (the same governance chain);
//   * a SUBMITTED package sitting in the platform review queue;
//   * the installer tenant has installed invoice-ocr v1 (narrowed grant)
//     and has a deployed builder session.
//
// Everything goes through module contracts only. The printed tenant ids
// feed the ?tenant= scope parameter of the dev seam.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_FILE = process.env.AURUM_DB_FILE ?? '.data/aurum-dev.db';
process.env.AURUM_DB_MEMORY = '';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { getDb, closeDb } from '../src/infra/db';
import { runMigrations } from './migrate';
import { newId } from '../src/infra/ids';
import type { TenantContext } from '../src/infra/tenant';
import { provisionTenant } from '../src/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '../src/modules/organizations/contract';
import { setAuthorityPolicy } from '../src/modules/actions/contract';
import { registerAgent, setAgentTransport } from '../src/modules/agents/contract';
import type { AgentRuntimeTransport } from '../src/modules/agents/contract';
import {
  registerExtensionManifest,
  runManifestVerification,
} from '../src/modules/extensions/contract';
import type { RegisterExtensionManifestInput } from '../src/modules/extensions/contract';
import {
  createPackage,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '../src/modules/marketplace/contract';
import { installPackage } from '../src/app/(product)/marketplace/lib/install';

const alwaysOk: AgentRuntimeTransport = {
  async send() {
    return { status: 'delivered', payload: null, providerTaskId: 'seed-1', detail: null };
  },
};

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function main(): Promise<void> {
  const db = getDb();
  await runMigrations(db);

  const platformProvisioner = {
    principalId: newId(),
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };
  const vendor = await provisionTenant(platformProvisioner, {
    name: 'Acme Software',
    ownerPrincipalId: newId(),
  });
  const platform = await provisionTenant(platformProvisioner, {
    name: 'Aurum Platform Ops',
    ownerPrincipalId: newId(),
  });
  const installer = await provisionTenant(platformProvisioner, {
    name: 'Northwind Traders',
    ownerPrincipalId: newId(),
  });

  const vendorCtx = member(vendor.id, ['marketplace:submit', 'extensions:administer']);
  const platformCtx = member(platform.id, ['marketplace:administer']);
  const installerCtx = member(installer.id, ['extensions:administer', 'agents:administer']);

  await setAuthorityPolicy(member(installer.id, ['actions:administer', 'extensions:administer']), {
    actionKind: 'extension-deployment',
    approvalLevels: [],
    forbiddenLevels: [],
  });

  const manifestInput: RegisterExtensionManifestInput = {
    extensionKey: 'invoice-ocr',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [
      { label: 'Invoices API', origin: 'https://api.invoices.example.com' },
    ],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
  };

  const registered = await registerExtensionManifest(vendorCtx, manifestInput);
  await runManifestVerification(vendorCtx, { manifestId: registered.manifest.id });

  const extensionPkg = await createPackage(vendorCtx, {
    kind: 'extension',
    manifestId: registered.manifest.id,
  });
  await submitPackage(vendorCtx, { packageId: extensionPkg.id });
  await runAutomatedVerification(platformCtx, { packageId: extensionPkg.id });
  await reviewPackage(platformCtx, {
    packageId: extensionPkg.id,
    decision: 'approve',
    reason: 'checks passed, permissions justified by the declaration',
  });
  await publishPackage(platformCtx, { packageId: extensionPkg.id });
  const installableExtension = await makePackageInstallable(platformCtx, {
    packageId: extensionPkg.id,
  });

  const agentPkg = await createPackage(vendorCtx, {
    kind: 'agent',
    packageKey: 'collections-negotiator',
    version: '1.0.0',
    displayName: 'Collections Negotiator',
    description: 'Negotiates outstanding invoices politely.',
    role: 'negotiate outstanding invoices',
    instructions: 'Be polite, be firm, escalate stuck cases to the owner.',
    provider: 'langgraph',
    permissions: ['observe', 'analyze', 'recommend', 'propose'],
  });
  await submitPackage(vendorCtx, { packageId: agentPkg.id });
  await runAutomatedVerification(platformCtx, { packageId: agentPkg.id });
  await reviewPackage(platformCtx, {
    packageId: agentPkg.id,
    decision: 'approve',
    reason: 'blueprint scopes stay below execute',
  });
  await publishPackage(platformCtx, { packageId: agentPkg.id });
  const installableAgent = await makePackageInstallable(platformCtx, {
    packageId: agentPkg.id,
  });

  // A second vendor version, sitting SUBMITTED in the platform queue.
  const registeredV2 = await registerExtensionManifest(vendorCtx, {
    ...manifestInput,
    version: '1.1.0',
  });
  await runManifestVerification(vendorCtx, { manifestId: registeredV2.manifest.id });
  const v2Pkg = await createPackage(vendorCtx, {
    kind: 'extension',
    manifestId: registeredV2.manifest.id,
  });
  await submitPackage(vendorCtx, { packageId: v2Pkg.id });

  // The installer installs both packages (narrowed extension grant).
  setAgentTransport(alwaysOk);
  const report = await installPackage(installerCtx, installableExtension, [
    'state:read',
    'state:write',
  ]);
  if (report.outcome !== 'installed') {
    throw new Error(`extension install failed: ${JSON.stringify(report.steps)}`);
  }
  const agentReport = await installPackage(installerCtx, installableAgent, null);
  if (agentReport.outcome !== 'installed') {
    throw new Error(`agent install failed: ${JSON.stringify(agentReport.steps)}`);
  }
  await registerAgent(installerCtx, {
    slug: 'extension-designer',
    displayName: 'Extension Designer',
    role: 'extension design and build',
    description: 'Designs extension manifests from build briefs.',
    provider: 'langgraph',
    instructions: 'Design extensions as JSON design documents.',
    runtimeConfig: { assistantId: 'asst_builder_1' },
    permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose'],
  });
  setAgentTransport(null);

  console.log('--- seeded ---');
  console.log(`VENDOR_TENANT=${vendor.id}`);
  console.log(`PLATFORM_TENANT=${platform.id}`);
  console.log(`INSTALLER_TENANT=${installer.id}`);
  console.log(`EXTENSION_PACKAGE=${installableExtension.id}`);
  console.log(`AGENT_PACKAGE=${installableAgent.id}`);
  console.log(`SUBMITTED_PACKAGE=${v2Pkg.id}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
