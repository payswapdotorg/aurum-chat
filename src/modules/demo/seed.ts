// The seeding orchestration of the demo harness (W068) — ONE function
// that materializes the deterministic demo world through MODULE
// CONTRACTS ONLY (the import discipline of IMPLEMENTATION-STACK §2: this
// module never writes another module's tables and never imports an app
// surface).
//
// What "deterministic" means here:
//   * every tenant name/slug, persona name/email, natural key, budget and
//     timestamp comes from the fixed manifest (manifest.ts) — never from
//     `Date.now()` or randomness;
//   * the world is built by REAL domain flows (the same contracts the
//     product uses), so every seeded record is legitimate domain state —
//     a discovery run that promotes a real unknown and a real mission, a
//     canonical cognition cycle that records real evidence and suspends
//     at the real approval gate, a governed marketplace chain, a real
//     contribution anchored to a real ask-person plan;
//   * re-running the harness is a NO-OP per anchor (the
//     demo_journey_anchors registry): the second run skips every anchor
//     the first run recorded, so record ids and counts stay stable.
//
// What "no production backdoor" means here:
//   * the gate (gate.ts) is checked FIRST and fails closed against
//     server databases and production runtimes;
//   * the personas are REAL users signing in through the REAL auth flow —
//     there is no bypass, no seeded session cookie, no ambient authority;
//   * the only extra claims in play are SEED-TIME contract contexts for
//     the platform/harness-scoped capabilities ('marketplace:administer',
//     'llm:administer' — claims that never ride a tenant session at this
//     base, by W058's interim design), and they exist only inside this
//     function's lifetime.
//
// ANCHOR PLACEMENT. Every anchor row lives in the demo COMPANY's anchor
// space — the harness's bookkeeping home. The company tenant itself is
// resolved through the manager persona's verified company directory (the
// auth contract's own natural-key lookup: the demo slug), so the
// bootstrap needs no out-of-band state. If seeding is interrupted in the
// single-await window between provisioning a tenant and recording its
// anchor, re-running cannot recover that tenant — reset the demo
// database and re-seed (documented in scripts/seed-demo-harness.ts).
//
// The narrative (one coherent company): Meridian Roasters' wholesale
// delivery freshness slipped to 87% against a 92% goal. Aurum notices
// unprompted (discovery), investigates (cognition, process, capability
// gap, a retained contradiction), proposes a follow-up question (the
// approval gate), asks June Park the operations lead (approved outreach
// → her answer → contribution → reward), while the company runs an
// installed marketplace extension, submits its own package for platform
// review, configures two AI providers and holds an agent recruitment
// proposal at the gate.

import { envFlag, envString, getAurumDb, getDatabaseUrl, isDbMemory } from '@/infra/config';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  AuthError,
  claimsForRole,
  createInvite,
  listUserCompanies,
  registerUser,
  selectCompany,
  signIn,
  type IssuedSession,
} from '@/modules/auth/contract';
import {
  addTenantMember,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
  type PlatformContext,
} from '@/modules/organizations/contract';
import { OrganizationsError } from '@/modules/organizations/contract';
import {
  attestIdentity,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { createEmployee, createPerson, linkExternalIdentity } from '@/modules/people/contract';
import { createGoal } from '@/modules/goals/contract';
import { recordClaim, registerContradiction } from '@/modules/epistemics/contract';
import { recordObservation } from '@/modules/observations/contract';
import { runGoalGapDiscovery } from '@/modules/attention/contract';
import {
  registerCapability,
  registerRequirement,
  registerSupply,
} from '@/modules/capabilities/contract';
import { reconstructProcess } from '@/modules/processes/contract';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  authorizeAction,
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import {
  runNextStage,
  startExecution,
  type AdvanceExecutionInput,
} from '@/modules/cognition/contract';
import {
  createConversation,
  recordExecutionLink,
  recordMessage,
} from '@/modules/conversations/contract';
import {
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import { recordContribution, validateContribution } from '@/modules/contributions/contract';
import { applyRewardPolicy, setRewardPolicy } from '@/modules/rewards/contract';
import { registerChannelConnection } from '@/modules/channels/contract';
import { registerSource } from '@/modules/sources/contract';
import { registerDestination } from '@/modules/destinations/contract';
import { registerAiProviderAccount } from '@/modules/llm/contract';
import { registerAgent } from '@/modules/agents/contract';
import {
  createRecruitmentProposal,
  requestRecruitmentApproval,
} from '@/modules/agent-recruitment/contract';
import {
  createPackage,
  getPackage,
  isExtensionPackage,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '@/modules/marketplace/contract';
import {
  deployExtensionVersion,
  isExtensionPermission,
  registerExtensionManifest,
  runManifestVerification,
  transitionExtension,
  type ExtensionPermission,
  type RegisterExtensionManifestInput,
} from '@/modules/extensions/contract';
import { createApiKey, createWebhookSubscription } from '@/modules/api/contract';
import { DemoError } from './errors';
import { evaluateDemoSeedGate } from './gate';
import { demoJourney } from './journeys';
import {
  demoPersonaPassword,
  demoPersonaSpec,
  demoTenantSpec,
  DEMO_KEYS,
  DEMO_PERSONAS,
  DEMO_TIME,
} from './manifest';
import type {
  DemoAnchor,
  DemoJourneyId,
  DemoSeedPersona,
  DemoSeedReport,
  DemoSeedTenant,
} from './types';

// ---------------------------------------------------------------------------
// The anchor registry (idempotency + the seeded directory)
// ---------------------------------------------------------------------------

interface AnchorRow extends DbRow {
  id: string;
  tenant_id: string;
  journey_id: string;
  anchor_key: string;
  record_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Counters of one seeding run (fresh vs. already-present anchors). */
interface RunCounters {
  created: number;
  skipped: number;
}

function assertDemoContext(ctx: TenantContext): void {
  if (
    typeof ctx?.tenantId !== 'string' ||
    ctx.tenantId.trim() === '' ||
    typeof ctx?.principalId !== 'string' ||
    ctx.principalId.trim() === ''
  ) {
    throw new DemoError('invalid_input', 'the demo harness needs a shaped TenantContext');
  }
}

async function findAnchor(
  ctx: TenantContext,
  journeyId: DemoJourneyId,
  anchorKey: string,
): Promise<AnchorRow | null> {
  const rows = await getDb().query<AnchorRow>(
    `SELECT id, tenant_id, journey_id, anchor_key, record_id, metadata, created_at
       FROM demo_journey_anchors
      WHERE tenant_id = $1 AND journey_id = $2 AND anchor_key = $3`,
    [ctx.tenantId, journeyId, anchorKey],
  );
  return rows.rows[0] ?? null;
}

/**
 * Run `fn` exactly once per (tenant, journey, anchor): the first call
 * records the produced record id; every later call replays the stored
 * row. This is what makes the whole harness idempotent.
 */
async function ensureAnchor(
  ctx: TenantContext,
  counters: RunCounters,
  journeyId: DemoJourneyId,
  anchorKey: string,
  fn: () => Promise<{ recordId: string; metadata?: Record<string, unknown> }>,
): Promise<AnchorRow> {
  assertDemoContext(ctx);
  const existing = await findAnchor(ctx, journeyId, anchorKey);
  if (existing !== null) {
    counters.skipped += 1;
    return existing;
  }
  const produced = await fn();
  const inserted = await getDb().query<AnchorRow>(
    `INSERT INTO demo_journey_anchors (tenant_id, journey_id, anchor_key, record_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (tenant_id, journey_id, anchor_key) DO NOTHING
     RETURNING id, tenant_id, journey_id, anchor_key, record_id, metadata, created_at`,
    [ctx.tenantId, journeyId, anchorKey, produced.recordId, JSON.stringify(produced.metadata ?? {})],
  );
  if (inserted.rows[0] !== undefined) {
    counters.created += 1;
    return inserted.rows[0];
  }
  // A concurrent run recorded the anchor first — replay it.
  const raced = await findAnchor(ctx, journeyId, anchorKey);
  if (raced === null) {
    throw new DemoError('seed_failed', `anchor '${journeyId}/${anchorKey}' vanished after insert`);
  }
  counters.skipped += 1;
  return raced;
}

function toDemoAnchor(row: AnchorRow): DemoAnchor {
  return {
    journeyId: row.journey_id as DemoJourneyId,
    anchorKey: row.anchor_key,
    recordId: row.record_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** The non-production gate as the seeding entry point applies it. */
function gateDecision() {
  return evaluateDemoSeedGate({
    backend: getAurumDb(),
    databaseUrl: getDatabaseUrl(),
    memoryMode: isDbMemory(),
    optIn: envFlag('AURUM_DEMO_SEED'),
    nodeEnv: envString('NODE_ENV'),
  });
}

// ---------------------------------------------------------------------------
// Personas (real users, resolved idempotently by email)
// ---------------------------------------------------------------------------

/**
 * Resolve one persona's principal: sign in when the account exists,
 * register it when it does not. The demo password is assembled from the
 * manifest's fragments at runtime — never a single literal in source.
 */
async function resolvePersona(
  role: DemoSeedPersona['role'],
): Promise<{ principalId: string; token: string }> {
  const spec = demoPersonaSpec(role);
  const password = demoPersonaPassword();
  let session: IssuedSession;
  try {
    session = await signIn({ email: spec.email, password });
  } catch (error) {
    if (!(error instanceof AuthError) || error.code !== 'invalid_credentials') throw error;
    try {
      session = await registerUser({
        displayName: spec.fullName,
        email: spec.email,
        password,
      });
    } catch (registrationError) {
      if (
        registrationError instanceof AuthError &&
        registrationError.code === 'email_taken'
      ) {
        throw new DemoError(
          'seed_failed',
          `demo persona '${spec.email}' already exists with a different password — reset the demo database and re-seed`,
          { cause: registrationError },
        );
      }
      throw registrationError;
    }
  }
  return { principalId: session.session.principalId, token: session.token };
}

// ---------------------------------------------------------------------------
// The seeding
// ---------------------------------------------------------------------------

/** Seed the deterministic demo world (idempotent; gate-checked). */
export async function seedDemoHarness(): Promise<DemoSeedReport> {
  const gate = gateDecision();
  if (!gate.allowed) {
    throw new DemoError(gate.code, gate.reason);
  }
  const counters: RunCounters = { created: 0, skipped: 0 };

  // --- the personas (idempotent by email) --------------------------------
  const personas = new Map<DemoSeedPersona['role'], { principalId: string; token: string }>();
  for (const spec of DEMO_PERSONAS) {
    personas.set(spec.role, await resolvePersona(spec.role));
  }
  const manager = personas.get('manager')!;
  const employee = personas.get('employee')!;
  const developer = personas.get('developer')!;
  const platformReviewer = personas.get('platform-reviewer')!;

  // The platform provisioner (the one explicit platform operation; scoped
  // to the provisionTenant calls below, never ambient).
  const provisioner: PlatformContext = {
    principalId: manager.principalId,
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };

  // --- the demo company (natural-key resolution through the manager's
  //     verified company directory — the auth contract's own lookup) ------
  const companySpec = demoTenantSpec('company');
  const directory = await listUserCompanies({ token: manager.token });
  const knownCompany = directory.find((entry) => entry.tenantSlug === companySpec.slug);
  let companyTenantId: string;
  if (knownCompany !== undefined) {
    companyTenantId = knownCompany.tenantId;
  } else {
    let provisioned;
    try {
      provisioned = await provisionTenant(provisioner, {
        name: companySpec.name,
        slug: companySpec.slug,
        ownerPrincipalId: manager.principalId,
        defaultWorkspaceName: companySpec.defaultWorkspaceName,
      });
    } catch (error) {
      if (error instanceof OrganizationsError && error.code === 'tenant_slug_taken') {
        throw new DemoError(
          'seed_failed',
          `tenant slug '${companySpec.slug}' exists but the manager's company directory does not carry it — the demo database is in a partial state; reset it and re-seed`,
          { cause: error },
        );
      }
      throw error;
    }
    await selectCompany({ token: manager.token, tenantId: provisioned.id });
    companyTenantId = provisioned.id;
  }

  // The harness's bookkeeping home: every anchor lives in the company's
  // anchor space (see the file header — ANCHOR PLACEMENT).
  const anchorCtx = (): TenantContext => ({
    tenantId: companyTenantId,
    principalId: manager.principalId,
    authority: [],
  });

  // The contexts the harness ACTS through. Session-derived claims come
  // from the auth contract's own interim mapping (claimsForRole) so the
  // harness can never hand a persona more than its session would derive.
  const ownerAuthority = claimsForRole('owner');
  const adminAuthority = claimsForRole('admin');
  const companyCtx = (principalId: string, authority: string[] = []): TenantContext => ({
    tenantId: companyTenantId,
    principalId,
    authority,
  });
  const managerCtx = (authority: string[] = ownerAuthority): TenantContext =>
    companyCtx(manager.principalId, authority);
  const workerCtx = (): TenantContext => companyCtx(newId(), []);
  const juneCtx = (): TenantContext => companyCtx(employee.principalId, []);
  const developerCtx = (authority: string[] = adminAuthority): TenantContext =>
    companyCtx(developer.principalId, authority);

  // A dedicated cognition-worker principal per run (the W050 seam: the
  // loop's requester is a worker, so the MANAGER can decide its proposals
  // — separation of duties). Only the first run's requests persist.
  const workerPrincipalId = newId();

  // --- demo-world: the three tenants -------------------------------------
  const company = await ensureAnchor(anchorCtx(), counters, 'demo-world', 'tenant-company', async () => ({
    recordId: companyTenantId,
    metadata: { name: companySpec.name, slug: companySpec.slug },
  }));
  if (company.record_id !== companyTenantId) {
    // A previous run anchored a different company tenant — trust the anchor.
    companyTenantId = company.record_id;
  }
  const vendor = await ensureAnchor(anchorCtx(), counters, 'demo-world', 'tenant-vendor', async () => {
    const tenant = await provisionTenant(provisioner, {
      name: demoTenantSpec('vendor').name,
      slug: demoTenantSpec('vendor').slug,
      ownerPrincipalId: newId(),
      defaultWorkspaceName: demoTenantSpec('vendor').defaultWorkspaceName,
    });
    return {
      recordId: tenant.id,
      metadata: { name: tenant.name, slug: tenant.slug },
    };
  });
  const platform = await ensureAnchor(anchorCtx(), counters, 'demo-world', 'tenant-platform', async () => {
    const ownerPrincipalId = newId();
    const tenant = await provisionTenant(provisioner, {
      name: demoTenantSpec('platform').name,
      slug: demoTenantSpec('platform').slug,
      ownerPrincipalId,
      defaultWorkspaceName: demoTenantSpec('platform').defaultWorkspaceName,
    });
    return {
      recordId: tenant.id,
      metadata: { name: tenant.name, slug: tenant.slug, ownerPrincipalId },
    };
  });
  const vendorTenantId = vendor.record_id;
  const platformTenantId = platform.record_id;

  // The marketplace vendor acts with its own tenant + the claims a vendor
  // company carries. The vendor's owner principal is opaque to the
  // harness — any principal of that tenant with the submit/administer
  // claims is the vendor's publisher (the marketplace contract checks
  // claims, not membership).
  const vendorCtx = (): TenantContext => ({
    tenantId: vendorTenantId,
    principalId: newId(),
    authority: ['marketplace:submit', 'extensions:administer'],
  });
  // The platform side: the reviewer persona's tenant with the PLATFORM
  // claim. 'marketplace:administer' never rides a session at this base
  // (W058 interim model) — this context exists only inside the harness.
  const platformCtx = (): TenantContext => ({
    tenantId: platformTenantId,
    principalId: platformReviewer.principalId,
    authority: ['marketplace:administer'],
  });
  // The platform tenant's provisioned owner (adds the reviewer as admin).
  const platformOwnerPrincipalId =
    typeof platform.metadata['ownerPrincipalId'] === 'string'
      ? (platform.metadata['ownerPrincipalId'] as string)
      : newId();
  const platformOwnerCtx = (): TenantContext => ({
    tenantId: platformTenantId,
    principalId: platformOwnerPrincipalId,
    authority: [],
  });

  // --- demo-world: persona anchors + memberships + company selection ----
  for (const spec of DEMO_PERSONAS) {
    await ensureAnchor(anchorCtx(), counters, 'demo-world', `persona-${spec.role}`, async () => ({
      recordId: personas.get(spec.role)!.principalId,
      metadata: { email: spec.email, fullName: spec.fullName, tenantRole: spec.tenantRole },
    }));
  }

  /** addTenantMember, tolerant of the already-member case (idempotent). */
  const addMember = async (
    caller: TenantContext,
    principalId: string,
    role: 'admin' | 'member',
  ): Promise<string> => {
    try {
      const membership = await addTenantMember(caller, { principalId, role });
      return membership.id;
    } catch (error) {
      if (error instanceof OrganizationsError && error.code === 'tenant_member_exists') {
        return '';
      }
      throw error;
    }
  };
  await ensureAnchor(anchorCtx(), counters, 'demo-world', 'membership-employee', async () => ({
    recordId: await addMember(managerCtx(), employee.principalId, 'member'),
    metadata: { principalId: employee.principalId, role: 'member' },
  }));
  await ensureAnchor(anchorCtx(), counters, 'demo-world', 'membership-developer', async () => ({
    recordId: await addMember(managerCtx(), developer.principalId, 'admin'),
    metadata: { principalId: developer.principalId, role: 'admin' },
  }));
  await ensureAnchor(anchorCtx(), counters, 'demo-world', 'membership-worker', async () => ({
    recordId: await addMember(managerCtx(), workerPrincipalId, 'member'),
    metadata: { role: 'member', note: 'the cognition worker principal of the first seed run' },
  }));
  await ensureAnchor(
    anchorCtx(),
    counters,
    'demo-world',
    'membership-platform-reviewer',
    async () => ({
      recordId: await addMember(platformOwnerCtx(), platformReviewer.principalId, 'admin'),
      metadata: { principalId: platformReviewer.principalId, role: 'admin', tenant: 'platform' },
    }),
  );

  // Company selection: every persona lands in its company on sign-in
  // (idempotent — re-selecting is always allowed).
  await selectCompany({ token: manager.token, tenantId: companyTenantId });
  await selectCompany({ token: employee.token, tenantId: companyTenantId });
  await selectCompany({ token: developer.token, tenantId: companyTenantId });
  await selectCompany({ token: platformReviewer.token, tenantId: platformTenantId });

  // --- demo-world: the employee's people/identity records ----------------
  const employeePerson = await ensureAnchor(
    anchorCtx(),
    counters,
    'demo-world',
    'person-employee',
    async () => {
      const person = await createPerson(managerCtx(), {
        fullName: demoPersonaSpec('employee').fullName,
        email: DEMO_KEYS.employeePersonEmail,
      });
      return { recordId: person.id, metadata: { fullName: person.fullName } };
    },
  );
  const employeePersonId = employeePerson.record_id;
  await ensureAnchor(anchorCtx(), counters, 'demo-world', 'employee-record', async () => {
    const employment = await createEmployee(managerCtx(), {
      personId: employeePersonId,
      employeeNumber: DEMO_KEYS.employeeNumber,
      title: demoPersonaSpec('employee').title,
      department: 'Operations',
      hiredAt: '2024-03-11T00:00:00.000Z',
    });
    return { recordId: employment.id, metadata: { employeeNumber: employment.employeeNumber } };
  });
  await ensureAnchor(anchorCtx(), counters, 'demo-world', 'identity-web', async () => {
    const registered = await registerExternalIdentity(managerCtx(), {
      provider: 'web',
      providerAccountId: DEMO_KEYS.webIdentityAccount,
      displayName: `${demoPersonaSpec('employee').fullName} (web)`,
    });
    const attested = await attestIdentity(managerCtx([IDENTITY_AUTHORITY_ATTEST]), {
      identityId: registered.identity.id,
      evidence: 'demo harness attestation — June Park verified in person at the roastery',
    });
    await linkExternalIdentity(managerCtx([IDENTITY_AUTHORITY_LINK]), {
      personId: employeePersonId,
      identityId: attested.id,
    });
    return {
      recordId: attested.id,
      metadata: { provider: 'web', account: DEMO_KEYS.webIdentityAccount },
    };
  });

  // --- journey A: the pending invitation ---------------------------------
  await ensureAnchor(anchorCtx(), counters, 'manager-onboarding', 'invite-pending', async () => {
    const issued = await createInvite(managerCtx(), {
      email: DEMO_KEYS.inviteEmail,
      role: 'member',
    });
    return {
      recordId: issued.invite.id,
      metadata: { email: issued.invite.email, role: issued.invite.role },
    };
  });

  // --- journey B: the conversation with Aurum ----------------------------
  const conversation = await ensureAnchor(
    anchorCtx(),
    counters,
    'employee-chat',
    'conversation-freshness',
    async () => {
      const recording = juneCtx();
      const created = await createConversation(recording, {
        title: 'Wholesale freshness — Aurum',
      });
      const turn = (
        i: number,
        direction: 'inbound' | 'outbound',
        text: string,
        sentAt: string,
      ) =>
        recordMessage(recording, {
          conversationId: created.id,
          direction,
          actor:
            direction === 'inbound'
              ? { kind: 'person', personId: employeePersonId }
              : { kind: 'system', label: 'Aurum' },
          channel: 'web',
          payload: { text },
          sentAt,
          providerMessageId: `demo-chat-${String(i).padStart(4, '0')}`,
        });
      await turn(
        1,
        'inbound',
        'Aurum, why did our wholesale freshness score drop this month?',
        DEMO_TIME.chatTurn1,
      );
      await turn(
        2,
        'outbound',
        'October samples average 87% against your 92% goal. Two flagship accounts — Harbor Grocery and Nordic Café — fell below the 90% floor, and the dip lines up with a customs-clearance delay. I have opened a learning mission and flagged the risk.',
        DEMO_TIME.chatTurn2,
      );
      await turn(3, 'inbound', 'Which accounts are worst, and what is driving it?', DEMO_TIME.chatTurn3);
      await turn(
        4,
        'outbound',
        'Harbor Grocery (86%) and Nordic Café (88%). The evidence points at the courier customs-broker change in September — I have proposed a follow-up question to June at the approval gate, and the evidence surface walks through the reasoning.',
        DEMO_TIME.chatTurn4,
      );
      return { recordId: created.id, metadata: { title: created.title, turns: 4 } };
    },
  );
  const conversationId = conversation.record_id;

  // --- journey C: goals, evidence, the unprompted discovery --------------
  const freshnessGoal = await ensureAnchor(
    anchorCtx(),
    counters,
    'unprompted-discovery',
    'goal-freshness',
    async () => {
      const goal = await createGoal(managerCtx(), {
        title: 'Keep wholesale delivery freshness above 92%',
        objective: 'Hold wholesale delivery freshness at or above 92% across all flagship accounts.',
        desiredState: 'Every wholesale delivery scores at least 92% freshness on arrival',
        metrics: [
          { name: DEMO_KEYS.freshnessMetric, unit: 'percent', direction: 'at_least', threshold: 92 },
        ],
        horizonStart: DEMO_TIME.weekStart,
        horizonEnd: DEMO_TIME.goalHorizonEnd,
        owner: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
        priority: 'high',
        evidenceSources: [
          { kind: 'person', id: employeePersonId, label: demoPersonaSpec('employee').fullName },
          { kind: 'source', label: 'Roastery WMS' },
        ],
        successCriteria: 'All flagship wholesale accounts average at least 92% freshness for one full quarter',
        actor: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
        rationale: 'the board operations target for the half',
      });
      return { recordId: goal.id, metadata: { title: goal.content.title } };
    },
  );
  const freshnessGoalId = freshnessGoal.record_id;
  await ensureAnchor(anchorCtx(), counters, 'unprompted-discovery', 'goal-shiptime', async () => {
    const goal = await createGoal(managerCtx(), {
      title: 'Cut order-to-ship time to 48 hours',
      objective: 'Reduce wholesale order-to-ship time to at most 48 hours.',
      desiredState: 'Every wholesale order ships within 48 hours of receipt',
      metrics: [
        { name: DEMO_KEYS.shipTimeMetric, unit: 'hours', direction: 'at_most', threshold: 48 },
      ],
      horizonStart: DEMO_TIME.weekStart,
      horizonEnd: DEMO_TIME.goalHorizonEnd,
      owner: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
      priority: 'medium',
      evidenceSources: [{ kind: 'source', label: 'Roastery WMS' }],
      successCriteria: 'Median order-to-ship time stays at or below 48 hours for one full quarter',
      actor: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
      rationale: 'downstream of the freshness goal — faster shipping protects freshness',
    });
    return { recordId: goal.id, metadata: { title: goal.content.title } };
  });

  /** One WMS freshness sample (immutable evidence). */
  const freshnessObservation = (
    anchorKey: string,
    observedAt: string,
    accountId: string,
    score: number,
  ) =>
    ensureAnchor(anchorCtx(), counters, 'unprompted-discovery', anchorKey, async () => {
      const observation = await recordObservation(workerCtx(), {
        kind: 'freshness.sample',
        payload: { month: '2026-10', accountId, score },
        observedAt,
        source: { kind: 'system', label: 'Roastery WMS' },
        channel: 'ingestion',
        confidence: { value: 0.9, method: 'system-report', basis: 'wholesale WMS export' },
      });
      return { recordId: observation.id, metadata: { accountId, score } };
    });
  const sample1 = await freshnessObservation(
    'observation-freshness-1',
    DEMO_TIME.freshnessSample1,
    'harbor-grocery',
    86,
  );
  const sample2 = await freshnessObservation(
    'observation-freshness-2',
    DEMO_TIME.freshnessSample2,
    'nordic-cafe',
    88,
  );
  const sample3 = await freshnessObservation(
    'observation-freshness-3',
    DEMO_TIME.freshnessSample3,
    'fleet-average',
    87,
  );
  const freshnessObservationIds = [sample1.record_id, sample2.record_id, sample3.record_id];

  const freshnessClaim = await ensureAnchor(
    anchorCtx(),
    counters,
    'unprompted-discovery',
    'claim-freshness-dip',
    async () => {
      const claim = await recordClaim(managerCtx(), {
        proposition:
          'Wholesale delivery freshness averaged 87% in the first week of October 2026, against the 92% goal',
        subject: { kind: 'goals.goal', id: freshnessGoalId },
        confidence: { value: 0.9, method: 'system-evidence', basis: 'three Roastery WMS freshness samples' },
        evidenceObservationIds: freshnessObservationIds,
        rationale: 'the weekly WMS export — the goal\u2019s declared evidence source',
      });
      return { recordId: claim.id, metadata: { proposition: claim.proposition } };
    },
  );

  const discoveryRun = await ensureAnchor(
    anchorCtx(),
    counters,
    'unprompted-discovery',
    'discovery-run',
    async () => {
      const run = await runGoalGapDiscovery(workerCtx(), {
        trigger: { kind: 'scheduled', label: 'weekly freshness review' },
        goalIds: [freshnessGoalId],
        readings: [
          {
            goalId: freshnessGoalId,
            metricName: DEMO_KEYS.freshnessMetric,
            value: 87,
            driverConfidence: 0.4,
            evidenceClaimIds: [freshnessClaim.record_id],
            evidenceBeliefIds: [],
          },
        ],
        // The operator's materiality policy for the demo pass: the
        // freshness shortfall (87 vs 92, drivers half-known) is material
        // at these thresholds — the deterministic derivation then
        // promotes exactly one gap candidate.
        policy: { impactThreshold: 0.3, valueThreshold: 0.1 },
        investigationBudget: { amount: 400_00, currency: 'USD' },
        rewardBudget: { amount: 80_00, currency: 'USD' },
        actor: { kind: 'system', label: 'aurum-attention' },
        rationale: 'the weekly sweep — no one asked, the goal gap did',
      });
      const promoted = run.candidates.find((candidate) => candidate.disposition === 'promoted');
      if (promoted === undefined) {
        throw new DemoError(
          'seed_failed',
          'the discovery pass promoted no candidate — the deterministic freshness gap did not materialize',
        );
      }
      return {
        recordId: run.id,
        metadata: {
          promoted: 1,
          unknownId: promoted.epistemicsUnknownId,
          missionId: promoted.missionId,
        },
      };
    },
  );
  const discoveryUnknownId = discoveryRun.metadata['unknownId'] as string;
  const discoveryMissionId = discoveryRun.metadata['missionId'] as string;
  await ensureAnchor(anchorCtx(), counters, 'unprompted-discovery', 'unknown-freshness', async () => ({
    recordId: discoveryUnknownId,
    metadata: { fromDiscoveryRun: discoveryRun.record_id },
  }));
  await ensureAnchor(anchorCtx(), counters, 'unprompted-discovery', 'mission-freshness', async () => ({
    recordId: discoveryMissionId,
    metadata: { fromDiscoveryRun: discoveryRun.record_id },
  }));

  // --- journey D: capability gap, process findings, contradiction --------
  const coldChainCapability = await ensureAnchor(
    anchorCtx(),
    counters,
    'risk-investigation',
    'capability-cold-chain',
    async () => {
      const capability = await registerCapability(managerCtx(), {
        name: DEMO_KEYS.capabilityName,
        description: 'Keeping temperature-sensitive wholesale goods cold from roastery to customer shelf',
        actor: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
        rationale: 'the freshness goal depends on it — register the graph node',
      });
      return { recordId: capability.id, metadata: { name: capability.name } };
    },
  );
  const coldChainCapabilityId = coldChainCapability.record_id;
  await ensureAnchor(
    anchorCtx(),
    counters,
    'risk-investigation',
    'requirement-cold-chain',
    async () => {
      const requirement = await registerRequirement(managerCtx(), {
        capabilityId: coldChainCapabilityId,
        source: {
          kind: 'goal',
          id: freshnessGoalId,
          label: 'Keep wholesale delivery freshness above 92%',
        },
        level: 0.8,
        capacity: 40,
        note: 'peak-season wholesale cold-chain demand implied by the freshness goal',
        actor: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
        rationale: 'the freshness goal requires strong cold-chain capacity in Q4',
      });
      return { recordId: requirement.id, metadata: { level: requirement.level, capacity: requirement.capacity } };
    },
  );
  await ensureAnchor(anchorCtx(), counters, 'risk-investigation', 'supply-june', async () => {
    const supply = await registerSupply(managerCtx(), {
      capabilityId: coldChainCapabilityId,
      supplier: { kind: 'employee', id: employeePersonId, label: demoPersonaSpec('employee').fullName },
      level: 0.6,
      capacity: 24,
      evidenceObservationIds: freshnessObservationIds,
      note: 'June coordinates cold-chain shipments manually today',
      actor: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
      rationale: 'the current human-coordinated supply — below peak demand',
    });
    return { recordId: supply.id, metadata: { level: supply.level, capacity: supply.capacity } };
  });

  /** One fulfillment case's five steps (the process evidence). */
  const fulfillmentCase = (caseIndex: 1 | 2, caseId: string, times: readonly string[]) =>
    ensureAnchor(anchorCtx(), counters, 'risk-investigation', `observation-case-${caseIndex}`, async () => {
      const steps = [
        { kind: DEMO_KEYS.fulfillmentKinds[0], at: times[0]! },
        { kind: DEMO_KEYS.fulfillmentKinds[1], at: times[1]! },
        { kind: DEMO_KEYS.fulfillmentKinds[2], at: times[2]! },
        { kind: DEMO_KEYS.fulfillmentKinds[3], at: times[3]! },
        { kind: DEMO_KEYS.fulfillmentKinds[4], at: times[4]! },
      ];
      const ids: string[] = [];
      for (const step of steps) {
        const observation = await recordObservation(workerCtx(), {
          kind: step.kind,
          payload: { caseId, stage: step.kind.split('.').pop() },
          observedAt: step.at,
          source: { kind: 'system', label: 'Roastery WMS' },
          channel: 'ingestion',
          confidence: { value: 0.95, method: 'system-report', basis: 'fulfillment event export' },
        });
        ids.push(observation.id);
      }
      return { recordId: ids[0]!, metadata: { caseId, observationIds: ids } };
    });
  await fulfillmentCase(1, DEMO_KEYS.fulfillmentCases[0], [
    DEMO_TIME.case1Order,
    DEMO_TIME.case1Roast,
    DEMO_TIME.case1Pack,
    DEMO_TIME.case1Ship,
    DEMO_TIME.case1Deliver,
  ]);
  await fulfillmentCase(2, DEMO_KEYS.fulfillmentCases[1], [
    DEMO_TIME.case2Order,
    DEMO_TIME.case2Roast,
    DEMO_TIME.case2Pack,
    DEMO_TIME.case2Ship,
    DEMO_TIME.case2Deliver,
  ]);

  await ensureAnchor(anchorCtx(), counters, 'risk-investigation', 'process-fulfillment', async () => {
    const process = await reconstructProcess(workerCtx(), {
      name: DEMO_KEYS.processName,
      scope: {
        observationKinds: [...DEMO_KEYS.fulfillmentKinds],
        caseKeyCandidates: ['caseId'],
      },
      options: { bottleneckThresholdSeconds: 86_400, minEdgeInstances: 1 },
      actor: { kind: 'system', label: 'aurum-processes' },
      rationale: 'weekly fulfillment reconstruction — the roast-to-pack wait looks structural',
    });
    return { recordId: process.id, metadata: { name: process.name, version: process.version } };
  });

  const contradiction = await ensureAnchor(
    anchorCtx(),
    counters,
    'risk-investigation',
    'contradiction-freshness',
    async () => {
      // The conflicting courier-portal reading (91% vs the WMS's 87%) —
      // contradictory evidence is RETAINED (lock 12), never merged away.
      const courier = await recordObservation(workerCtx(), {
        kind: 'freshness.sample',
        payload: { month: '2026-10', accountId: 'fleet-average', score: 91, reportedBy: 'courier-portal' },
        observedAt: DEMO_TIME.courierReading,
        source: { kind: 'external', label: 'Courier Portal' },
        channel: 'ingestion',
        confidence: { value: 0.7, method: 'system-report', basis: 'courier portal export' },
      });
      const record = await registerContradiction(workerCtx(), {
        left: { kind: 'observation', id: sample3.record_id },
        right: { kind: 'observation', id: courier.id },
        note: 'Roastery WMS (87%) and the Courier Portal (91%) disagree on the October fleet-average freshness — retained until the divergence is explained',
      });
      return {
        recordId: record.id,
        metadata: { courierObservationId: courier.id, wmsObservationId: sample3.record_id },
      };
    },
  );

  // --- journey E: policies, the cognition cycle, the approval gate -------
  await ensureAnchor(
    anchorCtx(),
    counters,
    'consequential-approval',
    'policy-employee-messaging',
    async () => {
      await setAuthorityPolicy(managerCtx([ACTIONS_AUTHORITY_ADMINISTER]), {
        actionKind: 'employee-messaging',
        approvalLevels: ['ASK'],
        note: 'every outbound question to an employee is reviewed by management (the demo company\u2019s policy)',
      });
      return { recordId: 'employee-messaging', metadata: { approvalLevels: ['ASK'] } };
    },
  );
  await ensureAnchor(
    anchorCtx(),
    counters,
    'consequential-approval',
    'policy-extension-deployment',
    async () => {
      // The demo company pre-authorized extension deployments (the W064
      // seed precedent): installing a governed package completes without
      // a second gate, so the installed surface shows a working
      // deployment. Employee messaging stays gated — approvals have data.
      await setAuthorityPolicy(managerCtx([ACTIONS_AUTHORITY_ADMINISTER]), {
        actionKind: 'extension-deployment',
        approvalLevels: [],
        note: 'extension deployments from the governed marketplace are pre-authorized for the demo company',
      });
      return { recordId: 'extension-deployment', metadata: { approvalLevels: [] } };
    },
  );

  const cognitionExecution = await ensureAnchor(
    anchorCtx(),
    counters,
    'consequential-approval',
    'cognition-execution',
    async () => {
      const driving = workerCtx();
      const trace = await startExecution(driving, {
        trigger: {
          kind: 'conversation',
          id: conversationId,
          label: 'June Park — wholesale freshness question',
        },
        focus: { topics: ['freshness', 'wholesale', 'customs'], entities: [] },
        actor: { kind: 'system', label: 'aurum-cognition' },
        rationale: 'the employee\u2019s freshness question — evaluate against the freshness goal',
      });
      const executionId = trace.id;
      const advance = (input: AdvanceExecutionInput) => runNextStage(driving, input);

      // 1 — evidence: the already-recorded freshness samples.
      const observed = await advance({
        executionId,
        stage: 'observation',
        reference: freshnessObservationIds,
      });
      const observationIds = (
        observed.steps.find((step) => step.stage === 'observation')!.result as {
          observationIds: string[];
        }
      ).observationIds;

      // 2–3 — remember; the world gains the flagship wholesale account.
      await advance({ executionId, stage: 'evidence-memory' });
      await advance({
        executionId,
        stage: 'world-update',
        update: {
          kind: 'create-entity',
          entity: {
            kind: 'customer',
            name: 'Harbor Grocery',
            description: 'Flagship wholesale account — the freshness dip\u2019s worst case',
            attributes: { segment: 'grocery', freshnessScore: 86 },
          },
        },
      });

      // 4 — the claim the evidence supports.
      const evaluated = await advance({
        executionId,
        stage: 'epistemic-evaluation',
        claims: [
          {
            proposition:
              'Harbor Grocery and Nordic Café received wholesale coffee below the 90% freshness floor in October 2026',
            subject: { kind: 'goals.goal', id: freshnessGoalId },
            confidence: {
              value: 0.85,
              method: 'system-evidence',
              basis: 'WMS freshness samples attributed per account',
            },
            evidenceObservationIds: observationIds,
            rationale: 'account-level freshness samples from the goal\u2019s declared source',
          },
        ],
      });
      const claimId = (
        evaluated.steps.find((step) => step.stage === 'epistemic-evaluation')!.result as {
          claimIds: string[];
        }
      ).claimIds[0]!;

      // 5–7 — the goal relation; no new unknowns/missions (discovery owns
      // those); no acquisition this cycle.
      await advance({ executionId, stage: 'goal-evaluation', relatedGoalIds: [freshnessGoalId] });
      await advance({ executionId, stage: 'unknown-mission-evaluation', unknowns: [], missions: [] });
      await advance({ executionId, stage: 'knowledge-acquisition', missionId: null });

      // 8 — the working belief, alternatives retained (lock 12).
      const modeled = await advance({
        executionId,
        stage: 'model-update',
        belief: {
          proposition:
            'The courier customs-broker change in September is the dominant driver of the wholesale freshness dip',
          confidence: {
            value: 0.75,
            method: 'evidence-reasoning',
            basis: 'the freshness claim plus the fulfillment bottleneck',
          },
          supportingObservationIds: observationIds,
          supportingClaimIds: [claimId],
          alternatives: ['seasonal demand peaks alone explain the dip'],
          disconfirmation: 'freshness recovering while the customs broker stays unchanged',
          subject: { kind: 'goals.goal', id: freshnessGoalId },
          validFrom: DEMO_TIME.beliefValidFrom,
          rationale: 'the cycle\u2019s own claim, joined with the fulfillment wait',
        },
      });
      const beliefId = (
        modeled.steps.find((step) => step.stage === 'model-update')!.result as {
          beliefId: string | null;
        }
      ).beliefId;

      // 9 — the management findings (risk + opportunity + capability gap).
      await advance({
        executionId,
        stage: 'risk-opportunity-capability-analysis',
        findings: [
          {
            kind: 'risk',
            statement:
              'Wholesale delivery freshness averaged 87% in October, breaching the 92% goal — two flagship accounts fell below the 90% floor',
            evidenceObservationIds: observationIds,
            affectedGoalIds: [freshnessGoalId],
          },
          {
            kind: 'opportunity',
            statement:
              'A direct-to-store courier lane could recover three to five freshness points for the two affected wholesale accounts',
            evidenceObservationIds: observationIds,
            affectedGoalIds: [freshnessGoalId],
          },
          {
            kind: 'capability-gap',
            statement:
              'Cold-chain logistics is stretched: peak-season wholesale demand exceeds the human-coordinated supply',
            evidenceObservationIds: observationIds,
            affectedGoalIds: [freshnessGoalId],
          },
        ],
      });

      // 10 — the policy gate: the proposed follow-up question suspends the
      // cycle awaiting approval (the honest state — the worker resumes it
      // after the decision; the durable-worker seam is W069's scope).
      const gated = await advance({
        executionId,
        stage: 'recommendation-ask-proposal-action',
        action: {
          actionKind: 'employee-messaging',
          authorityLevel: 'ASK',
          payload: {
            to: employeePersonId,
            channel: 'web',
            question:
              'Which courier customs-broker documents are still missing for the Harbor Grocery and Nordic Café shipments?',
          },
          justification:
            'close the customs paperwork evidence gap behind the freshness risk before escalating to the courier',
        },
      });
      if (gated.state !== 'awaiting_approval' || gated.pending.requestId == null) {
        throw new DemoError(
          'seed_failed',
          `the cognition cycle did not suspend at the approval gate (state '${String(gated.state)}')`,
        );
      }

      return {
        recordId: executionId,
        metadata: {
          pendingRequestId: gated.pending.requestId,
          observationIds,
          claimId,
          beliefId,
          correlationId: trace.correlationId,
        },
      };
    },
  );
  const executionId = cognitionExecution.record_id;
  const pendingQuestionRequestId = cognitionExecution.metadata['pendingRequestId'] as string;

  await ensureAnchor(anchorCtx(), counters, 'employee-chat', 'execution-link', async () => {
    const link = await recordExecutionLink(workerCtx(), {
      conversationId,
      executionId,
      role: 'triggered',
    });
    return { recordId: link.id, metadata: { conversationId, executionId, role: link.role } };
  });

  // The decided request (approval history): the outreach to June that the
  // manager already approved — requester is the worker, decider the
  // manager (separation of duties holds).
  const decidedRequest = await ensureAnchor(
    anchorCtx(),
    counters,
    'consequential-approval',
    'approval-history',
    async () => {
      const request = await authorizeAction(workerCtx(), {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: {
          to: employeePersonId,
          channel: 'web',
          question: 'Can you walk me through the customs-broker change you noticed in September?',
        },
        justification: 'the approved outreach behind the freshness investigation',
        idempotencyKey: 'demo-approval-history',
      });
      if (request.status !== 'pending') {
        throw new DemoError('seed_failed', 'the history approval request was not gated as expected');
      }
      const decided = await decideApproval(managerCtx([ACTIONS_AUTHORITY_APPROVE]), {
        requestId: request.id,
        decision: 'approve',
        note: 'approved — June has the operational context we need',
      });
      return {
        recordId: decided.id,
        metadata: { decision: 'approve', actionKind: decided.actionKind },
      };
    },
  );

  // --- journey F: the ask, the answer, the contribution, the reward ------
  const acquisitionPlan = await ensureAnchor(
    anchorCtx(),
    counters,
    'employee-contribution',
    'acquisition-plan',
    async () => {
      const plan = await planNextAcquisition(workerCtx(), {
        missionId: discoveryMissionId,
        candidates: [
          {
            kind: 'person',
            id: employeePersonId,
            label: demoPersonaSpec('employee').fullName,
            relevance: 0.9,
            reliability: 0.85,
            freshness: 0.8,
            authority: 0.8,
            expectedQuality: 0.85,
            priorContributionValue: 0.7,
            cost: 0,
            access: 'allowed',
          },
          {
            kind: 'system',
            label: 'Roastery WMS',
            relevance: 0.4,
            reliability: 0.5,
            freshness: 0.9,
            authority: 0.3,
            expectedQuality: 0.4,
            priorContributionValue: 0.2,
            cost: 50_00,
            access: 'allowed',
          },
        ],
        actor: { kind: 'system', label: 'aurum-cognition' },
        rationale:
          'the discovery mission\u2019s first acquisition — the operations lead knows the courier change',
      });
      if (plan.decision !== 'selected' || plan.chosen?.kind !== 'person') {
        throw new DemoError(
          'seed_failed',
          `the acquisition plan did not select the person candidate (decision '${String(plan.decision)}')`,
        );
      }
      return {
        recordId: plan.id,
        metadata: { missionId: plan.missionId, chosen: plan.chosen.label ?? null, action: plan.action },
      };
    },
  );
  await ensureAnchor(
    anchorCtx(),
    counters,
    'employee-contribution',
    'acquisition-answer',
    async () => {
      const answered = await recordAcquisitionOutcome(workerCtx(), {
        planId: acquisitionPlan.record_id,
        outcome: 'answered',
        evidence: {
          payload: {
            answer:
              'The courier switched to a cheaper customs broker in September — per-shipment paperwork now takes two to three days, and the cold chain waits at the port.',
          },
          confidence: { value: 0.85, method: 'person-account', basis: 'direct operational knowledge' },
        },
      });
      return { recordId: answered.id, metadata: { outcome: 'answered' } };
    },
  );
  const contribution = await ensureAnchor(
    anchorCtx(),
    counters,
    'employee-contribution',
    'contribution',
    async () => {
      const recorded = await recordContribution(workerCtx(), {
        planId: acquisitionPlan.record_id,
        summary:
          'The courier customs-broker change in September is the root cause of the freshness dip — paperwork delays hold the cold chain at the port',
        actor: { kind: 'person', id: employeePersonId, label: demoPersonaSpec('employee').fullName },
      });
      return { recordId: recorded.id, metadata: { summary: recorded.summary } };
    },
  );
  await ensureAnchor(
    anchorCtx(),
    counters,
    'employee-contribution',
    'contribution-validation',
    async () => {
      const validation = await validateContribution(managerCtx(), {
        contributionId: contribution.record_id,
        outcome: 'validated',
        quality: 0.8,
        note: 'consistent with the WMS samples and the fulfillment bottleneck — specific and actionable',
        actor: { kind: 'person', id: manager.principalId, label: demoPersonaSpec('manager').fullName },
      });
      return {
        recordId: validation.id,
        metadata: { outcome: validation.outcome, quality: validation.quality },
      };
    },
  );
  await ensureAnchor(
    anchorCtx(),
    counters,
    'employee-contribution',
    'reward-policy',
    async () => {
      const policy = await setRewardPolicy(managerCtx(['rewards:administer']), {
        qualifyingStatuses: ['validated'],
        minKnowledgeGain: 0,
        minAffectedGoals: 0,
        tiers: [{ name: 'thank-you-recognition', minValueScore: 0, kind: 'recognition', amount: 0 }],
        rewardCurrency: 'USD',
        note: 'the demo company\u2019s reward policy — validated contributions earn recognition',
      });
      return {
        recordId: `reward-policy-v${String(policy.version)}`,
        metadata: { currency: policy.rewardCurrency, version: policy.version },
      };
    },
  );
  const reward = await ensureAnchor(anchorCtx(), counters, 'employee-contribution', 'reward', async () => {
    // The worker applies the policy (the system converts validated
    // contributions) — so the MANAGER can decide the gated reward.
    const application = await applyRewardPolicy(workerCtx(), {
      contribution: {
        kind: 'knowledge-contribution',
        id: contribution.record_id,
        label: 'Customs broker root cause',
        contributor: { personId: employeePersonId, label: demoPersonaSpec('employee').fullName },
      },
      missionId: discoveryMissionId,
      value: {
        status: 'validated',
        knowledgeGain: 0.25,
        missionImpact: 'advanced',
        affectedGoals: [{ goalId: freshnessGoalId, label: 'Keep wholesale delivery freshness above 92%' }],
        costAvoided: { amount: 120_00, currency: 'USD' },
      },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'the validated root-cause answer advanced the freshness mission',
    });
    if (application.reward === null) {
      throw new DemoError(
        'seed_failed',
        'the reward policy produced no reward for the validated contribution',
      );
    }
    return {
      recordId: application.reward.id,
      metadata: {
        status: application.reward.status,
        actionRequestId: application.reward.actionRequestId,
      },
    };
  });

  // --- journey G: channels, sources, destinations ------------------------
  await ensureAnchor(anchorCtx(), counters, 'connect-company', 'channel-whatsapp', async () => {
    const registered = await registerChannelConnection(managerCtx(), {
      provider: 'whatsapp',
      providerAccountId: '+15550100',
      displayName: 'Meridian Ops WhatsApp',
      credentialRef: 'secret-store://demo/whatsapp-meridian',
    });
    return {
      recordId: registered.connection.id,
      metadata: { provider: 'whatsapp', created: registered.created },
    };
  });
  await ensureAnchor(anchorCtx(), counters, 'connect-company', 'channel-slack', async () => {
    const registered = await registerChannelConnection(managerCtx(), {
      provider: 'slack',
      providerAccountId: 'T01MERIDIAN',
      displayName: 'Meridian Roasters Slack',
      credentialRef: 'secret-store://demo/slack-meridian',
    });
    return {
      recordId: registered.connection.id,
      metadata: { provider: 'slack', created: registered.created },
    };
  });
  await ensureAnchor(anchorCtx(), counters, 'connect-company', 'source-hubspot', async () => {
    const registered = await registerSource(managerCtx(), {
      provider: 'hubspot',
      providerAccountId: '24681357',
      displayName: 'HubSpot CRM (demo)',
      authKind: 'credentials',
      credentialRef: 'secret-store://demo/hubspot-meridian',
    });
    return {
      recordId: registered.source.id,
      metadata: { provider: 'hubspot', created: registered.created },
    };
  });
  await ensureAnchor(anchorCtx(), counters, 'connect-company', 'source-stripe', async () => {
    const registered = await registerSource(managerCtx(), {
      provider: 'stripe',
      providerAccountId: 'acct_demo_meridian',
      displayName: 'Stripe (demo)',
      authKind: 'credentials',
      credentialRef: 'secret-store://demo/stripe-meridian',
    });
    return {
      recordId: registered.source.id,
      metadata: { provider: 'stripe', created: registered.created },
    };
  });
  await ensureAnchor(anchorCtx(), counters, 'connect-company', 'destination-sheets', async () => {
    const registered = await registerDestination(managerCtx(), {
      provider: 'google-sheets',
      providerAccountId: 'meridian-demo-reporting',
      displayName: 'Ops Reporting Sheet (demo)',
      authKind: 'credentials',
      credentialRef: 'secret-store://demo/sheets-meridian',
    });
    return {
      recordId: registered.destination.id,
      metadata: { provider: 'google-sheets', created: registered.created },
    };
  });

  // --- journey H: two BYOA accounts (no provider privileged) -------------
  const llmAuthority = [...ownerAuthority, 'llm:administer'];
  await ensureAnchor(
    managerCtx(llmAuthority),
    counters,
    'configure-ai',
    'llm-account-openai',
    async () => {
      const registered = await registerAiProviderAccount(managerCtx(llmAuthority), {
        provider: 'openai',
        label: 'Meridian OpenAI (demo)',
        credentialRef: 'secret-store://demo/openai-meridian',
        scopes: ['conversation', 'analysis'],
        capabilities: ['text-generation'],
        maxDataClassification: 'internal',
        priority: 1,
        budgetMinor: 500_000,
      });
      return {
        recordId: registered.account.id,
        metadata: { provider: 'openai', created: registered.created },
      };
    },
  );
  await ensureAnchor(
    managerCtx(llmAuthority),
    counters,
    'configure-ai',
    'llm-account-anthropic',
    async () => {
      const registered = await registerAiProviderAccount(managerCtx(llmAuthority), {
        provider: 'anthropic',
        label: 'Meridian Anthropic (demo)',
        credentialRef: 'secret-store://demo/anthropic-meridian',
        scopes: ['conversation', 'background'],
        capabilities: ['text-generation'],
        maxDataClassification: 'internal',
        priority: 2,
        budgetMinor: 300_000,
      });
      return {
        recordId: registered.account.id,
        metadata: { provider: 'anthropic', created: registered.created },
      };
    },
  );

  // --- journey I: the agent and the recruitment proposal -----------------
  await ensureAnchor(
    managerCtx(['agents:administer']),
    counters,
    'agent-recruitment',
    'agent-freshness-monitor',
    async () => {
      const registered = await registerAgent(managerCtx(['agents:administer']), {
        slug: DEMO_KEYS.agentSlug,
        displayName: 'Freshness Monitor',
        role: 'watch wholesale freshness signals',
        description: 'Watches WMS freshness samples and flags goal breaches early',
        provider: 'langgraph',
        instructions:
          'Read the daily WMS freshness export, compare against the active freshness goal, and open a finding when an account crosses its floor.',
        permissions: ['observe', 'analyze'],
      });
      return {
        recordId: registered.agent.id,
        metadata: { slug: registered.agent.slug, created: registered.created },
      };
    },
  );
  const recruitmentProposal = await ensureAnchor(
    anchorCtx(),
    counters,
    'agent-recruitment',
    'recruitment-proposal',
    async () => {
      // Aurum proposes (the worker requests); the manager decides.
      const proposal = await createRecruitmentProposal(workerCtx(), {
        title: 'Cold-chain coverage for the Q4 peak',
        capabilityId: coldChainCapabilityId,
        rationale:
          'Peak-season cold-chain demand exceeds the human-coordinated supply; the freshness goal depends on closing the gap',
        evidenceObservationIds: freshnessObservationIds,
        alternatives: [
          {
            kind: 'train',
            summary: 'Coach June on customs paperwork and courier coordination',
            estimatedCostMinor: 40_000,
            estimatedCostCurrency: 'USD',
            estimatedWeeks: 4,
            expectedLevel: 0.15,
          },
          {
            kind: 'recruit',
            summary: 'Recruit a cold-chain monitoring agent from the governed marketplace',
            estimatedCostMinor: 90_000,
            estimatedCostCurrency: 'USD',
            estimatedWeeks: 1,
            expectedLevel: 0.3,
            recommended: true,
            agentPermissions: ['observe', 'analyze'],
          },
          {
            kind: 'hire',
            summary: 'Hire a seasonal cold-chain coordinator for the Q4 peak',
            estimatedCostMinor: 250_000,
            estimatedCostCurrency: 'USD',
            estimatedWeeks: 6,
            expectedLevel: 0.25,
          },
        ],
      });
      const submitted = await requestRecruitmentApproval(workerCtx(), {
        proposalId: proposal.id,
        justification: 'the recommended agent recruitment covers the peak-season gap fastest at the lowest cost',
      });
      return {
        recordId: proposal.id,
        metadata: {
          approvalRequestId: submitted.approval.actionRequestId,
          recommended: 'recruit',
        },
      };
    },
  );

  // --- journey J: the governed marketplace chain -------------------------
  const vendorManifestInput: RegisterExtensionManifestInput = {
    extensionKey: DEMO_KEYS.vendorExtensionKey,
    version: DEMO_KEYS.vendorExtensionVersion,
    manifestSchemaVersion: 1,
    displayName: 'Roast Batch Tracker',
    description: 'Tracks roast batches through the wholesale fulfillment flow',
    // The closed permission set the declared capabilities require — the
    // extensions module's consistency rules check both directions.
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'telemetry:emit',
    ] as ExtensionPermission[],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: [],
    externalParticipants: [],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 0,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
  };

  const vendorPackage = await ensureAnchor(
    anchorCtx(),
    counters,
    'marketplace',
    'vendor-package',
    async () => {
      const registered = await registerExtensionManifest(vendorCtx(), vendorManifestInput);
      await runManifestVerification(vendorCtx(), { manifestId: registered.manifest.id });
      const pkg = await createPackage(vendorCtx(), {
        kind: 'extension',
        manifestId: registered.manifest.id,
      });
      await submitPackage(vendorCtx(), { packageId: pkg.id });
      return {
        recordId: pkg.id,
        metadata: { packageKey: pkg.packageKey, version: pkg.version },
      };
    },
  );
  await ensureAnchor(
    anchorCtx(),
    counters,
    'marketplace',
    'vendor-package-governance',
    async () => {
      // The platform side of the chain — the harness-only administer claim.
      await runAutomatedVerification(platformCtx(), { packageId: vendorPackage.record_id });
      const reviewed = await reviewPackage(platformCtx(), {
        packageId: vendorPackage.record_id,
        decision: 'approve',
        reason: 'checks passed — permissions are justified by the nightly-sync declaration',
      });
      await publishPackage(platformCtx(), { packageId: vendorPackage.record_id });
      const installable = await makePackageInstallable(platformCtx(), {
        packageId: vendorPackage.record_id,
      });
      return {
        recordId: reviewed.package.id,
        metadata: { state: installable.state, packageKey: installable.packageKey },
      };
    },
  );

  await ensureAnchor(
    anchorCtx(),
    counters,
    'marketplace',
    'install-roast-batch-tracker',
    async () => {
      // The tenant-side install composition (the product's own install
      // flow, re-composed through contracts — the demo module may not
      // import the app surface): register the frozen version in the
      // company registry, verify, activate (pre-authorized by the demo
      // policy) and deploy with a narrowed grant.
      const installer = developerCtx();
      const pkg = await getPackage(installer, { packageId: vendorPackage.record_id });
      if (!isExtensionPackage(pkg)) {
        throw new DemoError('seed_failed', 'the vendor package is not an extension package');
      }
      const subject = pkg.payload.subject;
      const registered = await registerExtensionManifest(installer, {
        extensionKey: pkg.packageKey,
        version: pkg.version,
        manifestSchemaVersion: subject.manifestSchemaVersion,
        displayName: pkg.displayName,
        description: pkg.description,
        // The frozen subject's requested set IS the closed vocabulary; the
        // filter keeps a malformed stored payload from becoming a cast
        // (the product install composition's own discipline).
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
      await runManifestVerification(installer, { manifestId: registered.manifest.id });
      const activated = await transitionExtension(installer, {
        extensionKey: pkg.packageKey,
        transition: 'activate',
        idempotencyKey: 'demo-install-activate',
      });
      if (!activated.applied) {
        throw new DemoError('seed_failed', 'the extension activation did not apply (policy gate?)');
      }
      const deployed = await deployExtensionVersion(installer, {
        extensionKey: pkg.packageKey,
        manifestId: registered.manifest.id,
        installKey: 'default',
        grantedPermissions: ['state:read'],
        idempotencyKey: 'demo-install-deploy',
      });
      if (!deployed.applied || deployed.deployment === null) {
        throw new DemoError('seed_failed', 'the extension deployment did not apply');
      }
      return {
        recordId: deployed.deployment.id,
        metadata: {
          extensionKey: pkg.packageKey,
          manifestId: registered.manifest.id,
          grantedPermissions: deployed.deployment.grantedPermissions,
        },
      };
    },
  );

  const developerPackage = await ensureAnchor(
    anchorCtx(),
    counters,
    'marketplace',
    'developer-package',
    async () => {
      // The company's own package, walked to PENDING_REVIEW — the
      // platform reviewer's queue item.
      const publisher = developerCtx();
      const registered = await registerExtensionManifest(publisher, {
        extensionKey: DEMO_KEYS.developerExtensionKey,
        version: DEMO_KEYS.developerExtensionVersion,
        manifestSchemaVersion: 1,
        displayName: 'Freshness ETag Reader',
        description: 'Reads courier freshness ETags into the world model',
        requestedPermissions: ['state:read', 'state:write', 'ui:render'] as ExtensionPermission[],
        stateScope: 'tenant',
        uiSurfaces: ['control-tower-panel'],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [],
        telemetry: false,
        quotas: {
          maxStateBytes: 262_144,
          maxScheduleInvocationsPerDay: 0,
          maxExternalCallsPerDay: 0,
        },
        hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
      });
      await runManifestVerification(publisher, { manifestId: registered.manifest.id });
      const pkg = await createPackage(publisher, {
        kind: 'extension',
        manifestId: registered.manifest.id,
      });
      await submitPackage(publisher, { packageId: pkg.id });
      const verified = await runAutomatedVerification(platformCtx(), { packageId: pkg.id });
      return {
        recordId: pkg.id,
        metadata: {
          packageKey: pkg.packageKey,
          version: pkg.version,
          state: verified.package.state,
        },
      };
    },
  );

  // --- journey L: the developer integration surface ----------------------
  await ensureAnchor(
    developerCtx(['api:administer']),
    counters,
    'developer-console',
    'api-key',
    async () => {
      const issuance = await createApiKey(developerCtx(['api:administer']), {
        label: DEMO_KEYS.apiKeyLabel,
        scopes: ['goals:read', 'missions:read', 'evidence:read', 'approvals:read'],
      });
      // The RAW key is shown exactly once at creation and never persisted —
      // the anchor records the key's identity only.
      return {
        recordId: issuance.apiKey.id,
        metadata: { label: issuance.apiKey.label, scopes: issuance.apiKey.scopes },
      };
    },
  );
  await ensureAnchor(
    developerCtx(['api:administer']),
    counters,
    'developer-console',
    'webhook-subscription',
    async () => {
      const subscription = await createWebhookSubscription(developerCtx(['api:administer']), {
        label: DEMO_KEYS.webhookLabel,
        url: DEMO_KEYS.webhookUrl,
        eventTypes: [...DEMO_KEYS.webhookEventTypes],
      });
      return {
        recordId: subscription.id,
        metadata: { url: subscription.url, eventTypes: subscription.eventTypes },
      };
    },
  );

  // --- journey K: the evidence-chain index -------------------------------
  await ensureAnchor(anchorCtx(), counters, 'explainability', 'evidence-chain', async () => ({
    recordId: executionId,
    metadata: {
      conversationId,
      observationIds: cognitionExecution.metadata['observationIds'],
      claimId: cognitionExecution.metadata['claimId'],
      beliefId: cognitionExecution.metadata['beliefId'],
      pendingRequestId: pendingQuestionRequestId,
      decidedRequestId: decidedRequest.record_id,
      discoveryRunId: discoveryRun.record_id,
      unknownId: discoveryUnknownId,
      missionId: discoveryMissionId,
      contributionId: contribution.record_id,
      rewardId: reward.record_id,
      recruitmentProposalId: recruitmentProposal.record_id,
      pendingDeveloperPackageId: developerPackage.record_id,
      courierObservationId: contradiction.metadata['courierObservationId'],
    },
  }));

  // --- the report ---------------------------------------------------------
  const pendingRequests = await listActionRequests(managerCtx(), { status: 'pending', limit: 50 });
  const tenants: DemoSeedTenant[] = (
    [
      ['company', company],
      ['vendor', vendor],
      ['platform', platform],
    ] as const
  ).map(([key, anchor]) => ({
    key,
    id: anchor.record_id,
    name: String(anchor.metadata['name'] ?? ''),
    slug: String(anchor.metadata['slug'] ?? ''),
  }));
  const seedPersonas: DemoSeedPersona[] = DEMO_PERSONAS.map((spec) => ({
    role: spec.role,
    email: spec.email,
    principalId: personas.get(spec.role)!.principalId,
    tenantKey: spec.tenantKey,
    tenantRole: spec.tenantRole,
  }));

  const anchorRows = await getDb().query<AnchorRow>(
    `SELECT id, tenant_id, journey_id, anchor_key, record_id, metadata, created_at
       FROM demo_journey_anchors WHERE tenant_id = $1 ORDER BY journey_id, anchor_key`,
    [companyTenantId],
  );
  const journeys = new Map<DemoJourneyId, DemoAnchor[]>();
  for (const row of anchorRows.rows) {
    const journeyId = row.journey_id as DemoJourneyId;
    const list = journeys.get(journeyId) ?? [];
    list.push(toDemoAnchor(row));
    journeys.set(journeyId, list);
  }

  return {
    seededAt: new Date().toISOString(),
    tenants,
    personas: seedPersonas,
    journeys: [...journeys.entries()]
      .map(([id, anchors]) => ({
        id,
        title: demoJourney(id).title,
        anchors: anchors.sort((a, b) => a.anchorKey.localeCompare(b.anchorKey)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    pendingApprovals: pendingRequests.map((request) => ({
      actionKind: request.actionKind,
      requestId: request.id,
    })),
    created: counters.created,
    skipped: counters.skipped,
  };
}

/** Read one tenant's seeded journey anchors (the demo directory's dynamic half). */
export async function readDemoJourneyAnchors(ctx: TenantContext): Promise<DemoAnchor[]> {
  assertDemoContext(ctx);
  const rows = await getDb().query<AnchorRow>(
    `SELECT id, tenant_id, journey_id, anchor_key, record_id, metadata, created_at
       FROM demo_journey_anchors WHERE tenant_id = $1 ORDER BY journey_id, anchor_key`,
    [ctx.tenantId],
  );
  return rows.rows.map(toDemoAnchor);
}
