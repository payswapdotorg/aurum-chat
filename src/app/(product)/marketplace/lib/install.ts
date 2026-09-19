// Product surface (W064) — tenant-side package installation.
//
// WHAT THIS IS. The governed marketplace catalog (W028) deliberately
// stops at INSTALLABLE: "publication never implies tenant installation
// or activation" (lock 26) and the marketplace contract has no
// tenant-side install operation. Installation is therefore a PRODUCT
// composition over existing domain contracts — exactly the sanctioned
// role of a product surface ("they compose existing domain contracts;
// they never become a second source of organizational truth"):
//
//   Extension package install =
//     registerExtensionManifest   (the frozen package content becomes a
//                                  manifest version in THIS tenant's own
//                                  registry — W025)
//   → runManifestVerification    (the same deterministic checks the
//                                  platform ran — one semantics)
//   → transitionExtension        (activate — the W025 authority-gated
//                                  lifecycle transition)
//   → deployExtensionVersion     (the runtime deployment with the
//                                  tenant-narrowed permission grant —
//                                  W026, matrix-gated)
//
//   Agent package install =
//     registerAgent              (the blueprint becomes a tenant agent
//                                  definition — the agents module's own
//                                  first-write-wins registration)
//
// Every step is an existing contract call with its own authority gate;
// nothing here writes state directly, invents a new state machine, or
// bypasses a gate. Each step reports honestly: done / skipped (already
// true) / awaiting-approval (the §20 human gate holds the step — the
// caller decides in the Approvals surface, then re-runs install and the
// deterministic idempotency keys replay the SAME gate requests) /
// failed (the step's domain error, verbatim). No fake success, ever.

import type { TenantContext } from '@/infra/tenant';
import { ExtensionsError } from '@/modules/extensions/contract';
import {
  deployExtensionVersion,
  getExtension,
  isExtensionPermission,
  listManifests,
  registerExtensionManifest,
  runManifestVerification,
  transitionExtension,
} from '@/modules/extensions/contract';
import { registerAgent } from '@/modules/agents/contract';
import type { MarketplacePackage } from '@/modules/marketplace/contract';
import { isAgentPackage, isExtensionPackage } from '@/modules/marketplace/contract';

/** One install step's honest outcome. */
export type InstallStepStatus = 'done' | 'skipped' | 'awaiting_approval' | 'failed';

export interface InstallStep {
  step: 'register' | 'verify' | 'activate' | 'deploy';
  label: string;
  status: InstallStepStatus;
  /** What happened, in plain words (the domain evidence's own summary). */
  detail: string;
  /** The pending action request when status is awaiting_approval. */
  actionRequestId?: string;
}

export type InstallOutcome = 'installed' | 'awaiting_approval' | 'failed';

export interface InstallReport {
  packageId: string;
  kind: 'extension' | 'agent';
  outcome: InstallOutcome;
  steps: InstallStep[];
  /** The extension key / agent slug the install landed on. */
  targetKey: string;
  /** The deployment id when the deploy step applied (extension packages). */
  deploymentId: string | null;
}

/** Deterministic idempotency keys — a retried install replays the SAME gate requests. */
function activateKey(packageId: string): string {
  return `product-install-activate:${packageId}`;
}
function deployKey(packageId: string): string {
  return `product-install:${packageId}`;
}

const STEP_LABELS: Record<InstallStep['step'], string> = {
  register: 'Register the version in your registry',
  verify: 'Run the deterministic verification checks',
  activate: 'Activate the extension',
  deploy: 'Deploy with the granted permissions',
};

function fail(step: InstallStep['step'], detail: string): InstallStep {
  return { step, label: STEP_LABELS[step], status: 'failed', detail };
}

function awaiting(
  step: InstallStep['step'],
  detail: string,
  actionRequestId: string,
): InstallStep {
  return { step, label: STEP_LABELS[step], status: 'awaiting_approval', detail, actionRequestId };
}

function done(step: InstallStep['step'], detail: string): InstallStep {
  return { step, label: STEP_LABELS[step], status: 'done', detail };
}

function skipped(step: InstallStep['step'], detail: string): InstallStep {
  return { step, label: STEP_LABELS[step], status: 'skipped', detail };
}

function summarize(steps: InstallStep[]): InstallOutcome {
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  if (steps.some((step) => step.status === 'awaiting_approval')) return 'awaiting_approval';
  return 'installed';
}

// ---------------------------------------------------------------------------
// Extension packages
// ---------------------------------------------------------------------------

/**
 * Install one INSTALLABLE extension package for the caller's tenant.
 * `grantedPermissions` narrows the effective runtime grant (subset of
 * the package's requested ceiling — the runtime enforces the bound);
 * the full requested set is the default.
 */
export async function installExtensionPackage(
  ctx: TenantContext,
  pkg: MarketplacePackage,
  grantedPermissions: string[] | null,
): Promise<InstallReport> {
  const subject = isExtensionPackage(pkg) ? pkg.payload.subject : null;
  if (subject === null) {
    return {
      packageId: pkg.id,
      kind: 'extension',
      outcome: 'failed',
      steps: [fail('register', 'the package payload is not an extension payload')],
      targetKey: pkg.packageKey,
      deploymentId: null,
    };
  }

  const steps: InstallStep[] = [];
  let manifestId: string | null = null;
  let manifestVersion = pkg.version;

  // --- 1. register the frozen version in THIS tenant's registry ------
  try {
    const registered = await registerExtensionManifest(ctx, {
      extensionKey: pkg.packageKey,
      version: pkg.version,
      manifestSchemaVersion: subject.manifestSchemaVersion,
      displayName: pkg.displayName,
      description: pkg.description,
      // The frozen subject's requested set IS the closed vocabulary; the
      // filter keeps a malformed stored payload from becoming a cast.
      requestedPermissions: subject.requestedPermissions.filter(isExtensionPermission),
      stateScope: subject.capabilities.stateScope,
      uiSurfaces: subject.capabilities.uiSurfaces,
      schedules: subject.capabilities.schedules,
      eventSubscriptions: subject.capabilities.eventSubscriptions,
      externalParticipants: subject.capabilities.externalParticipants,
      telemetry: subject.capabilities.telemetry,
      quotas: subject.quotas,
      hostRuntime: {
        minVersion: subject.hostCompatibility.minVersion,
        maxVersion: subject.hostCompatibility.maxVersion,
      },
    });
    manifestId = registered.manifest.id;
    manifestVersion = registered.manifest.version;
    steps.push(done('register', `version ${registered.manifest.version} of '${pkg.packageKey}' is registered in your registry`));
  } catch (error) {
    // An identical version already registered is a SKIP (idempotent
    // install), not a failure — the same artifact, already in place.
    if (error instanceof ExtensionsError && error.code === 'version_not_monotonic') {
      const manifests = await listManifests(ctx, { extensionKey: pkg.packageKey, limit: 500 });
      const existing = manifests.find((manifest) => manifest.version === pkg.version) ?? null;
      if (existing === null) {
        steps.push(fail('register', error.message));
      } else {
        manifestId = existing.id;
        manifestVersion = existing.version;
        steps.push(skipped('register', `version ${pkg.version} is already registered in your registry — installing over it`));
      }
    } else {
      steps.push(fail('register', error instanceof Error ? error.message : 'registration failed'));
    }
  }

  if (manifestId === null) {
    return {
      packageId: pkg.id,
      kind: 'extension',
      outcome: summarize(steps),
      steps,
      targetKey: pkg.packageKey,
      deploymentId: null,
    };
  }

  // --- 2. verify: the same deterministic checks the platform ran ------
  try {
    const verification = await runManifestVerification(ctx, { manifestId });
    steps.push(
      done('verify', `verification ${verification.state === 'VERIFIED' ? 'passed' : 'did not pass'} — the manifest's derived state is ${verification.state}`),
    );
  } catch (error) {
    steps.push(fail('verify', error instanceof Error ? error.message : 'verification failed'));
    return {
      packageId: pkg.id,
      kind: 'extension',
      outcome: summarize(steps),
      steps,
      targetKey: pkg.packageKey,
      deploymentId: null,
    };
  }

  // --- 3. activate (only from REGISTERED; any other state is honest) --
  try {
    const extension = await getExtension(ctx, { extensionKey: pkg.packageKey });
    if (extension.lifecycleState === 'ACTIVE') {
      steps.push(skipped('activate', `'${pkg.packageKey}' is already ACTIVE — no activation needed`));
    } else if (extension.lifecycleState === 'REGISTERED') {
      const result = await transitionExtension(ctx, {
        extensionKey: pkg.packageKey,
        transition: 'activate',
        idempotencyKey: activateKey(pkg.id),
      });
      if (result.applied) {
        steps.push(done('activate', `'${pkg.packageKey}' is now ACTIVE`));
      } else {
        steps.push(
          awaiting('activate', 'activation is waiting for the human approval gate', result.gate.actionRequestId),
        );
      }
    } else {
      steps.push(
        skipped('activate', `'${pkg.packageKey}' is ${extension.lifecycleState} — activate or resume it from the installed surface instead`),
      );
    }
  } catch (error) {
    steps.push(fail('activate', error instanceof Error ? error.message : 'activation failed'));
  }

  // --- 4. deploy (only when the extension is ACTIVE right now) -------
  let deploymentId: string | null = null;
  try {
    const extension = await getExtension(ctx, { extensionKey: pkg.packageKey });
    if (extension.lifecycleState !== 'ACTIVE') {
      steps.push(
        skipped('deploy', `'${pkg.packageKey}' is ${extension.lifecycleState} — deployments need an ACTIVE extension; finish activation first, then re-run install`),
      );
    } else {
      const result = await deployExtensionVersion(ctx, {
        extensionKey: pkg.packageKey,
        manifestId,
        installKey: 'default',
        // The user-narrowed grant: only keys from the closed vocabulary
        // pass (the runtime enforces the manifest ceiling regardless).
        grantedPermissions:
          grantedPermissions === null
            ? undefined
            : grantedPermissions.filter(isExtensionPermission),
        idempotencyKey: deployKey(pkg.id),
      });
      if (result.applied && result.deployment !== null) {
        deploymentId = result.deployment.id;
        steps.push(
          done('deploy', `version ${manifestVersion} is deployed to install 'default' with ${result.deployment.grantedPermissions.length} granted permission${result.deployment.grantedPermissions.length === 1 ? '' : 's'}`),
        );
      } else {
        steps.push(
          awaiting('deploy', 'the deployment is waiting for the human approval gate', result.gate.actionRequestId),
        );
      }
    }
  } catch (error) {
    steps.push(fail('deploy', error instanceof Error ? error.message : 'deployment failed'));
  }

  return {
    packageId: pkg.id,
    kind: 'extension',
    outcome: summarize(steps),
    steps,
    targetKey: pkg.packageKey,
    deploymentId,
  };
}

// ---------------------------------------------------------------------------
// Agent packages
// ---------------------------------------------------------------------------

/**
 * Install one INSTALLABLE agent package for the caller's tenant: the
 * frozen blueprint (role, instructions, canonical provider, permission
 * scopes) becomes a tenant agent definition. The agents module's own
 * first-write-wins registration makes re-installing idempotent.
 */
export async function installAgentPackage(
  ctx: TenantContext,
  pkg: MarketplacePackage,
): Promise<InstallReport> {
  const payload = isAgentPackage(pkg) ? pkg.payload : null;
  if (payload === null) {
    return {
      packageId: pkg.id,
      kind: 'agent',
      outcome: 'failed',
      steps: [fail('register', 'the package payload is not an agent payload')],
      targetKey: pkg.packageKey,
      deploymentId: null,
    };
  }
  try {
    const result = await registerAgent(ctx, {
      slug: pkg.packageKey,
      displayName: pkg.displayName,
      role: payload.role,
      description: pkg.description,
      provider: payload.provider,
      instructions: payload.instructions,
      permissions: payload.permissions,
    });
    const step: InstallStep = result.created
      ? done('register', `the '${pkg.packageKey}' agent is registered in your tenant with ${payload.permissions.length} permission scope${payload.permissions.length === 1 ? '' : 's'}`)
      : skipped('register', `an agent with slug '${pkg.packageKey}' already exists in your tenant — first registration wins, nothing was overwritten`);
    return {
      packageId: pkg.id,
      kind: 'agent',
      outcome: 'installed',
      steps: [step],
      targetKey: pkg.packageKey,
      deploymentId: null,
    };
  } catch (error) {
    return {
      packageId: pkg.id,
      kind: 'agent',
      outcome: 'failed',
      steps: [fail('register', error instanceof Error ? error.message : 'registration failed')],
      targetKey: pkg.packageKey,
      deploymentId: null,
    };
  }
}

/** Dispatch an install by package kind. */
export async function installPackage(
  ctx: TenantContext,
  pkg: MarketplacePackage,
  grantedPermissions: string[] | null,
): Promise<InstallReport> {
  return isAgentPackage(pkg)
    ? installAgentPackage(ctx, pkg)
    : installExtensionPackage(ctx, pkg, grantedPermissions);
}
