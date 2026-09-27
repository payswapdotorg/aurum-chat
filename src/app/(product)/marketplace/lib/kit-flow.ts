// Product surface (W105) — tenant-side vertical-kit installation.
//
// WHAT THIS IS. The W092 vertical kits have their OWN lifecycle (the
// vertical-kits module: a tenant-scoped registry of immutable,
// digest-signed kit versions; an install that routes the tenant's
// grant review through the actions module's W009 authority gate). They
// are NOT marketplace packages and deliberately do NOT ride the
// extension install composition in ./install.ts (register manifest →
// verify → activate → deploy) — kit versions install through the
// vertical-kits contract's own governed path. This is therefore a
// product composition over the vertical-kits contract ONLY, the same
// sanctioned role ./install.ts plays for extension/agent packages:
// compose existing domain contracts; never write state directly; every
// step reports honestly. No fake success, ever.
//
//   Vertical starter kit install =
//     registerKitVersion     (the shipped signed manifest becomes an
//                             immutable version in THIS tenant's own
//                             kit registry — skipped when the exact
//                             version is already registered)
//   → runKitVerification     (the deterministic checks over the STORED
//                             bytes — the same rules the platform-side
//                             catalog posture derives from; skipped when
//                             the version already carries a VERIFIED
//                             posture)
//   → installKit             (the tenant lifecycle: the W009 gate routes
//                             the grant review — under the default
//                             policy the install lands 'pending-review'
//                             and a human decides; an auto-allow policy
//                             mints the grants at once; a forbidding
//                             policy refuses the install — the gate's
//                             own verdict, recorded not swallowed)
//
// Each step is an existing contract call with its own authority gate
// ('vertical-kits:administer'). The report mirrors InstallReport's
// honest shape so the shared client form renders it the same way:
// done / skipped (already true) / awaiting_approval (the human gate
// holds the install — decide it in Approvals, or here on the kit
// detail surface) / failed (the domain's own words).

import type { TenantContext } from '@/infra/tenant';
import {
  STARTER_KITS,
  installKit,
  listKitVersions,
  registerKitVersion,
  runKitVerification,
} from '@/modules/vertical-kits/contract';
import type { KitInstallationDetail } from '@/modules/vertical-kits/contract';

/** One kit install step's honest outcome (the install.ts vocabulary, reused). */
export type KitInstallStepStatus = 'done' | 'skipped' | 'awaiting_approval' | 'failed';

export interface KitInstallStep {
  step: 'register' | 'verify' | 'install';
  label: string;
  status: KitInstallStepStatus;
  /** What happened, in plain words (the domain evidence's own summary). */
  detail: string;
  /** The pending W009 action request when status is awaiting_approval. */
  actionRequestId?: string;
}

export type KitInstallOutcome = 'installed' | 'awaiting_approval' | 'failed';

export interface KitInstallReport {
  kitKey: string;
  version: string;
  outcome: KitInstallOutcome;
  steps: KitInstallStep[];
  /** The installation id the install landed on (null when it never got there). */
  installationId: string | null;
  /** The installation lifecycle state the gate produced (null on failure). */
  installationStatus: string | null;
}

/**
 * Install one vertical kit into the caller's tenant: a shipped starter
 * kit (the catalog's first-party content — registered from the shipped
 * signed manifest when the tenant registry does not yet hold the exact
 * version) or the tenant's own latest registered kit version.
 *
 * The composition is idempotent in the honest sense: steps already true
 * report 'skipped' with why, the W009 gate is the contract's own (its
 * idempotency is the actions module's), and a domain refusal at any
 * step stops the install with the domain's own message — never
 * swallowed, never retried blindly.
 */
export async function installVerticalKit(
  ctx: TenantContext,
  kitKey: string,
  justification: string | null,
): Promise<KitInstallReport> {
  const steps: KitInstallStep[] = [];
  const shipped = STARTER_KITS.find((kit) => kit.kitKey === kitKey) ?? null;

  // --- step 1: the registry (immutable, strictly increasing versions) ---
  let kitVersionId: string;
  let version: string;
  let verificationState: 'unverified' | 'verified' | 'failed';
  try {
    const registered = await listKitVersions(ctx, { kitKey });
    if (shipped !== null) {
      const exact = registered.find((row) => row.version === shipped.version) ?? null;
      version = shipped.version;
      if (exact !== null) {
        kitVersionId = exact.id;
        verificationState = exact.verificationState;
        steps.push({
          step: 'register',
          label: 'Register the shipped kit version',
          status: 'skipped',
          detail: `version ${shipped.version} is already in your kit registry (digest ${exact.manifestDigest.slice(0, 16)}…)`,
        });
      } else {
        const result = await registerKitVersion(ctx, { manifest: shipped });
        kitVersionId = result.version.id;
        verificationState = 'unverified';
        steps.push({
          step: 'register',
          label: 'Register the shipped kit version',
          status: 'done',
          detail: `version ${shipped.version} registered as an immutable kit version in your registry (digest ${result.version.manifestDigest.slice(0, 16)}…)`,
        });
      }
    } else if (registered.length > 0) {
      // The tenant's own registered kit (not shipped content): the
      // latest registered version is the install target — the registry
      // is the authority, the surface only composes.
      const latest = registered[0]!;
      kitVersionId = latest.id;
      version = latest.version;
      verificationState = latest.verificationState;
      steps.push({
        step: 'register',
        label: 'Resolve the registered kit version',
        status: 'skipped',
        detail: `version ${latest.version} is already in your kit registry (digest ${latest.manifestDigest.slice(0, 16)}…)`,
      });
    } else {
      return {
        kitKey,
        version: '',
        outcome: 'failed',
        steps: [
          {
            step: 'register',
            label: 'Resolve the kit version to install',
            status: 'failed',
            detail: `'${kitKey}' is neither a shipped starter kit nor a version registered in your kit registry — there is nothing to install`,
          },
        ],
        installationId: null,
        installationStatus: null,
      };
    }
  } catch (error) {
    return {
      kitKey,
      version: shipped?.version ?? '',
      outcome: 'failed',
      steps: [
        ...steps,
        {
          step: 'register',
          label: 'Register the kit version',
          status: 'failed',
          detail: error instanceof Error ? error.message : 'the registry refused the kit version',
        },
      ],
      installationId: null,
      installationStatus: null,
    };
  }

  // --- step 2: the deterministic verification over the STORED bytes ---
  try {
    if (verificationState === 'verified') {
      steps.push({
        step: 'verify',
        label: 'Run the deterministic kit verification',
        status: 'skipped',
        detail: 'the registered version already carries a VERIFIED posture (the latest append-only run)',
      });
    } else {
      // 'unverified' (never run) or 'failed' (drift) — either way the
      // honest move is a FRESH append-only run over the stored bytes;
      // the latest run decides.
      const run = await runKitVerification(ctx, { kitVersionId });
      if (run.outcome === 'verified') {
        steps.push({
          step: 'verify',
          label: 'Run the deterministic kit verification',
          status: 'done',
          detail: run.summary,
        });
      } else {
        return {
          kitKey,
          version,
          outcome: 'failed',
          steps: [
            ...steps,
            {
              step: 'verify',
              label: 'Run the deterministic kit verification',
              status: 'failed',
              detail: run.summary,
            },
          ],
          installationId: null,
          installationStatus: null,
        };
      }
    }
  } catch (error) {
    return {
      kitKey,
      version,
      outcome: 'failed',
      steps: [
        ...steps,
        {
          step: 'verify',
          label: 'Run the deterministic kit verification',
          status: 'failed',
          detail: error instanceof Error ? error.message : 'the verification run was refused',
        },
      ],
      installationId: null,
      installationStatus: null,
    };
  }

  // --- step 3: the tenant install lifecycle (the W009 gate) ---
  try {
    const detail: KitInstallationDetail = await installKit(ctx, {
      kitKey,
      version,
      justification,
    });
    if (detail.installation.status === 'pending-review') {
      steps.push({
        step: 'install',
        label: 'Install through the grant-review gate',
        status: 'awaiting_approval',
        detail: 'the authority gate holds the install at pending-review — a human decides whether the declared capabilities are minted',
        actionRequestId: detail.installation.actionRequestId,
      });
      return {
        kitKey,
        version,
        outcome: 'awaiting_approval',
        steps,
        installationId: detail.installation.id,
        installationStatus: detail.installation.status,
      };
    }
    if (detail.installation.status === 'granted') {
      steps.push({
        step: 'install',
        label: 'Install through the grant-review gate',
        status: 'done',
        detail: `the tenant policy auto-allowed the install — ${detail.grants.filter((grant) => grant.status === 'active').length} capability grant(s) minted`,
      });
      return {
        kitKey,
        version,
        outcome: 'installed',
        steps,
        installationId: detail.installation.id,
        installationStatus: detail.installation.status,
      };
    }
    // The gate's own refusal (a policy that forbids the kind) — recorded
    // on the installation as 'rejected', returned as data.
    steps.push({
      step: 'install',
      label: 'Install through the grant-review gate',
      status: 'failed',
      detail: 'the tenant authority policy refused vertical-kit-deployment — the gate\'s own verdict, recorded on the installation',
    });
    return {
      kitKey,
      version,
      outcome: 'failed',
      steps,
      installationId: detail.installation.id,
      installationStatus: detail.installation.status,
    };
  } catch (error) {
    return {
      kitKey,
      version,
      outcome: 'failed',
      steps: [
        ...steps,
        {
          step: 'install',
          label: 'Install through the grant-review gate',
          status: 'failed',
          detail: error instanceof Error ? error.message : 'the install was refused',
        },
      ],
      installationId: null,
      installationStatus: null,
    };
  }
}

/** The gate's action request id of an installation (the Approvals deep link). */
export function kitInstallActionRequestId(detail: KitInstallationDetail): string | null {
  return detail.installation.actionRequestId;
}
