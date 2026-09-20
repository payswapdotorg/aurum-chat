// W068 — the deterministic demo seed.
//
// WHAT THIS IS: the non-production dataset that makes every major product
// journey (plan §2, Journeys A–L) verifiable in a browser — seeded through
// MODULE CONTRACTS ONLY (the import discipline of IMPLEMENTATION-STACK §2
// and the work item's scope boundaries: "Product surfaces compose existing
// domain contracts; they never become a second source of organizational
// truth"). Nothing here writes a table directly, invents a state machine
// or bypasses a gate: every record is a real contract call with its own
// authority checks, the same way the W050 platform-surface fixture builds
// its chain.
//
// DETERMINISM: the dataset is fully specified by constants — names,
// emails, titles, questions, states, budgets and fixed timestamps (the
// BASE_MS anchor below; no wall-clock value ever enters a business
// record). Re-running the seed against the same database is IDEMPOTENT:
// every anchor is matched by its deterministic key (email, tenant name,
// title, slug, label, idempotency key, dedupe key, provider message id)
// and re-used, never duplicated. Ids are minted by PostgreSQL
// (`gen_random_uuid()`) and stay stable across re-runs through the match,
// not through generation.
//
// NO PRODUCTION BACKDOOR: the first operation is the guard (guard.ts) —
// the seed refuses to run against a server database (DATABASE_URL set) and
// without the explicit AURUM_DEMO_SEED=1 opt-in. The demo accounts are
// ordinary principals: they sign in through the normal auth path with the
// shared demo password (fragments assembled at runtime), their sessions
// derive authority from their verified tenant roles exactly like every
// other user's, and no route, claim or flag anywhere special-cases them.
//
// CONTEXTS the harness uses (all explicit, never ambient):
//   * manager / employee / developer — the demo principals with EXACTLY
//     the claims their W058 session derives (claimsForRole);
//   * aurum-agent — a deterministic member principal representing the
//     Aurum agent acting on the company's behalf (the separation-of-duties
//     requester of the pending approvals);
//   * provisioner — the one-shot platform provisioning context
//     (organizations:provision), the same pattern scripts use;
//   * platform pipeline — the reviewer principal + 'marketplace:administer',
//     the platform claim that never rides a tenant session (auth/claims)
//     and therefore reaches the pipeline only through this harness context;
//   * llm — the manager claims plus 'llm:administer' for the BYOA account
//     registration (the claim is not session-derived at this base — the
//     authority matrix is W009's scope; the harness states that loudly).

import type { TenantContext } from '@/infra/tenant';
import {
  claimsForRole,
  createInvite,
  listInvites,
  listUserCompanies,
  registerUser,
  selectCompany,
  signIn,
  type AuthError,
} from '@/modules/auth/contract';
import {
  addTenantMember,
  changeTenantMemberRole,
  createWorkspace,
  getTenantMembership,
  listWorkspaces,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
} from '@/modules/organizations/contract';
import type { PlatformContext, TenantRole } from '@/modules/organizations/contract';
import {
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
  resolveIdentity,
  type Person,
} from '@/modules/people/contract';
import {
  registerChannelConnection,
  receiveInbound,
  sendOutbound,
  setChannelTransport,
  type CanonicalDeliveryRequest,
  type ChannelTransport,
  type TransportReceipt,
} from '@/modules/channels/contract';
import {
  getConversation,
  listMessages,
  type Message,
} from '@/modules/conversations/contract';
import { createGoal, listGoals } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import {
  formBelief,
  getBelief,
  listBeliefs,
  listClaims,
  listUnknowns,
  recordClaim,
  recordUnknown,
} from '@/modules/epistemics/contract';
import type { Belief, Claim, Unknown } from '@/modules/epistemics/contract';
import { createMission, listMissions } from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import { listObservations, recordObservation } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import {
  listProcessFindings,
  listProcesses,
  reconstructProcess,
} from '@/modules/processes/contract';
import type { Process } from '@/modules/processes/contract';
import {
  authorizeAction,
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import {
  createNotification,
  listNotifications,
} from '@/modules/notifications/contract';
import {
  listAcquisitionPlans,
  planNextAcquisition,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import type { AcquisitionPlan } from '@/modules/knowledge-acquisition/contract';
import {
  listContributions,
  recordContribution,
  recordImpact,
  validateContribution,
} from '@/modules/contributions/contract';
import type { Contribution } from '@/modules/contributions/contract';
import {
  applyRewardPolicy,
  getRewardPolicy,
  listRewards,
  setRewardPolicy,
  settleReward,
} from '@/modules/rewards/contract';
import type { Reward } from '@/modules/rewards/contract';
import {
  getSourceCheckpoint,
  listSources,
  pollSource,
  registerSource,
  setSourceTransport,
  type SourceFetchRequest,
  type SourceFetchResult,
  type SourceTransport,
} from '@/modules/sources/contract';
import type { Source } from '@/modules/sources/contract';
import {
  listDestinations,
  registerDestination,
} from '@/modules/destinations/contract';
import type { Destination } from '@/modules/destinations/contract';
import {
  invokeLlm,
  listAiProviderAccounts,
  listLlmExecutions,
  registerAiProviderAccount,
  setAiAvailability,
  setLlmTransport,
  type AiProviderAccount,
  type LlmExecution,
  type LlmTransport,
  type LlmTransportReceipt,
  type LlmTransportRequest,
} from '@/modules/llm/contract';
import {
  listAgentExecutions,
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
  type AgentRuntimeTransport,
  type AgentRuntimeTransportReceipt,
  type AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';
import {
  listCapabilities,
  listRequirements,
  listSupplies,
  registerCapability,
  registerRequirement,
  registerSupply,
} from '@/modules/capabilities/contract';
import type { Capability } from '@/modules/capabilities/contract';
import {
  createRecruitmentProposal,
  listRecruitmentProposals,
  requestRecruitmentApproval,
} from '@/modules/agent-recruitment/contract';
import type { AgentRecruitmentProposal } from '@/modules/agent-recruitment/contract';
import {
  createEntity,
  listEntities,
} from '@/modules/world/contract';
import {
  AUDIT_SUBJECT_ACTION_REQUEST,
  listAuditRecords,
  recordAudit,
} from '@/modules/audit/contract';
import {
  createApiKey,
  createWebhookSubscription,
  listApiKeys,
  listWebhookSubscriptions,
  sendWebhookTest,
  setApiWebhookTransport,
  type WebhookTransport,
  type WebhookTransportReceipt,
} from '@/modules/api/contract';
import {
  createPackage,
  getPackage,
  isExtensionPackage,
  listPackages,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '@/modules/marketplace/contract';
import type { MarketplacePackage } from '@/modules/marketplace/contract';
import {
  deployExtensionVersion,
  getExtension,
  isExtensionPermission,
  listManifests,
  registerExtensionManifest,
  runManifestVerification,
  transitionExtension,
} from '@/modules/extensions/contract';
import type { RegisterExtensionManifestInput } from '@/modules/extensions/contract';
import { assertDemoSeedAllowed } from './guard';
import { DemoError } from './errors';
import {
  DEMO_ACCOUNTS,
  DEMO_COMPANIES,
  DEMO_ROLES,
  demoSharedPassword,
} from './roles';
import type {
  DemoAccountRef,
  DemoManifest,
  DemoRole,
  DemoSeedReport,
} from './types';

// ---------------------------------------------------------------------------
// Deterministic anchors
// ---------------------------------------------------------------------------

/**
 * The dataset's fixed epoch — every timestamped record derives from it,
 * so the dataset reads identically on every seed run (no wall clock ever
 * enters a business record).
 */
const BASE_MS = Date.parse('2026-09-12T09:00:00Z'); // the recent past relative to the repo's 2026-09 handoff
const AT = (offsetSeconds: number): string =>
  new Date(BASE_MS + offsetSeconds * 1000).toISOString();
const WHATSAPP_EPOCH = (offsetSeconds: number): string =>
  String(Math.floor((BASE_MS + offsetSeconds * 1000) / 1000));

/** The harness's deterministic platform-provisioning principal. */
const PROVISIONER_PRINCIPAL = '00000000-0000-4000-8000-000000000068';
/** The deterministic principal that owns the demo platform company. */
const PLATFORM_OWNER_PRINCIPAL = '00000000-0000-4000-8000-0000000000b1';
/** The deterministic member principal that acts as the Aurum agent. */
const AURUM_AGENT_PRINCIPAL = '00000000-0000-4000-8000-0000000000a1';

const MERIDIAN_WHATSAPP_NUMBER = '+15550100142';
const DEV_WHATSAPP_ACCOUNT = '+15550102640';

// The deterministic journey content.
const GOAL_RETURNS = {
  title: 'Keep the returns cycle under three days',
  objective: 'Hold end-to-end returns processing at or under three days per case.',
  desiredState: 'Every returns case completes in at most three days',
};
const GOAL_INVOICE = {
  title: 'Hold invoice accuracy at 98 percent',
  objective: 'Keep billed amounts and tax lines accurate across all invoices.',
  desiredState: 'At least 98 of every 100 invoices bill without correction',
};
const GOAL_CARRIER = {
  title: 'Keep carrier on-time delivery above 95 percent',
  objective: 'Sustain on-time delivery across the contracted carrier network.',
  desiredState: 'Contracted carriers deliver 95 percent of shipments on time',
};
const UNKNOWN_QUESTION =
  'Which customs-broker document set is missing for the in-flight returns cases?';
const MISSION_TITLE = 'Close the customs-documentation gap in the returns cycle';
const CLAIM_PROPOSITION =
  'Returns cases RET-2001 through RET-2004 waited three to five days on customs-broker paperwork';
const BELIEF_PROPOSITION =
  'The customs-broker document handoff is the bottleneck of the returns cycle';
const PROCESS_NAME = 'Returns processing';

// Idempotency / dedupe keys (what re-runs match on).
const KEY_PREFIX = 'demo-harness';
const KEYS = {
  messagingAsk: `${KEY_PREFIX}:employee-messaging:customs-question`,
  notification: `${KEY_PREFIX}:notification:customs-question`,
  rewardAudit: '00000000-0686-4000-8000-000000000068', // deterministic uuid (audit correlation ids must be uuids)
  llmExecution: `${KEY_PREFIX}:llm:returns-summary`,
  agentExecution: `${KEY_PREFIX}:agent-execution:returns-triage`,
} as const;

// ---------------------------------------------------------------------------
// Anchor bookkeeping (what a run created vs reused)
// ---------------------------------------------------------------------------

class Anchors {
  readonly created: string[] = [];
  readonly reused: string[] = [];

  async ensure<T>(key: string, existing: T | null, create: () => Promise<T>): Promise<T> {
    if (existing !== null) {
      this.reused.push(key);
      return existing;
    }
    const value = await create();
    this.created.push(key);
    return value;
  }

  note(key: string, created: boolean): void {
    (created ? this.created : this.reused).push(key);
  }
}

// ---------------------------------------------------------------------------
// Stub transports (the deterministic provider side of the demo world)
// ---------------------------------------------------------------------------

/** A short deterministic digest of a delivery's text (stable ids). */
function textDigest(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The demo world's channel provider: every outbound delivery succeeds
 * with a provider message id derived from the content (so distinct turns
 * keep distinct ids and re-runs replay the same deliveries). Wired only
 * while the seed runs — the W050 fixture / W064 seed discipline.
 */
const channelTransport: ChannelTransport = {
  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    return {
      status: 'delivered',
      providerMessageId: `demo-out-${textDigest(request.message.text ?? '')}`,
      detail: null,
    };
  },
};

const sourceTransport: SourceTransport = {
  async fetch(request: SourceFetchRequest): Promise<SourceFetchResult> {
    return {
      records:
        request.cursor === null
          ? [
              {
                providerRecordId: 'demo-invoice-0001',
                kind: 'billing.invoice',
                payload: { invoiceId: 'INV-88201', amountMinor: 184_00, currency: 'USD', status: 'paid' },
                occurredAt: AT(600),
              },
              {
                providerRecordId: 'demo-invoice-0002',
                kind: 'billing.invoice',
                payload: { invoiceId: 'INV-88202', amountMinor: 63_50, currency: 'USD', status: 'open' },
                occurredAt: AT(660),
              },
            ]
          : [],
      nextCursor: request.cursor === null ? 'demo-checkpoint-1' : null,
      hasMore: false,
    };
  },
};

const llmTransport: LlmTransport = {
  async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
    // The provider-neutral receipt carries the adapter's expected envelope
    // shape (openai-style completions): { choices: [{ message: { content } }] }.
    return {
      status: 'delivered',
      payload: {
        id: `demo-llm-${textDigest(String(request.body))}`,
        choices: [{ message: { content: `Demo completion from ${request.model}: the returns-cycle answer stands.` } }],
        usage: { prompt_tokens: 24, completion_tokens: 18 },
      },
      providerExecutionId: `demo-llm-${request.kind}-${textDigest(String(request.body))}`,
      detail: null,
    };
  },
};

const agentTransport: AgentRuntimeTransport = {
  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    // The provider-neutral receipt carries the adapter's expected envelope
    // (langgraph wait-mode): { run_id, output: { result }, usage: {...} }.
    return {
      status: 'delivered',
      payload: {
        run_id: `demo-run-${textDigest(request.runtimeAgentRef)}`,
        output: { result: { triaged: true, agent: request.agentId } },
        usage: { input_tokens: 64, output_tokens: 48, steps: 2 },
      },
      providerTaskId: `demo-agent-${textDigest(request.runtimeAgentRef)}`,
      detail: null,
    };
  },
};

const webhookTransport: WebhookTransport = {
  async deliver(): Promise<WebhookTransportReceipt> {
    return { ok: true, statusCode: 200, latencyMs: 42 };
  },
};

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

export async function seedDemoHarness(): Promise<DemoSeedReport> {
  assertDemoSeedAllowed();
  const anchors = new Anchors();
  const password = demoSharedPassword();

  // --- 1) accounts, companies, memberships --------------------------------
  //
  // The companies are provisioned through the organizations contract:
  // the manager owns the demo company and the developer owns the vendor
  // company (their verified tenant roles are 'owner'). The platform
  // company is provisioned by a deterministic platform-owner principal
  // and the REVIEWER joins it as 'admin' — a platform reviewer is staff,
  // not the company owner. The employee joins the demo company as a plain
  // member. Finally every account SELECTS its demo company as the
  // session's active company, so a browser sign-in lands straight in the
  // product (the normal auth selection path, nothing else).

  const accounts = {} as Record<DemoRole, DemoAccountRef>;
  const principals = {} as Record<DemoRole, string>;
  const tokens = {} as Record<DemoRole, string>;
  for (const role of DEMO_ROLES) {
    const spec = DEMO_ACCOUNTS[role];
    const { principalId, token } = await ensureAccount(role, spec.email, spec.displayName, password, anchors);
    principals[role] = principalId;
    tokens[role] = token;
    if (role === 'employee' || role === 'platform-reviewer') continue; // join below
    const company = await ensureCompany(role, token, spec.company, principalId, anchors);
    accounts[role] = {
      role,
      email: spec.email,
      displayName: spec.displayName,
      principalId,
      companyId: spec.company,
      tenantId: company.tenantId,
      tenantName: company.name,
      tenantRole: spec.tenantRole,
    };
  }

  const meridian = accounts.manager.tenantId;
  const cobalt = accounts.developer.tenantId;

  // The platform company: owned by the deterministic platform-owner
  // principal, joined by the reviewer as admin.
  const platformCompany = await ensurePlatformCompany(anchors, tokens['platform-reviewer']!);
  const platform = platformCompany.tenantId;

  const managerBase: TenantContext = {
    tenantId: meridian,
    principalId: accounts.manager.principalId,
    authority: [...claimsForRole('owner')],
  };
  // The employee joins the demo company as a plain member.
  await ensureMembership(
    meridian,
    principals.employee,
    'member',
    managerBase,
    anchors,
    'account:employee-membership',
  );
  accounts.employee = {
    role: 'employee',
    email: DEMO_ACCOUNTS.employee.email,
    displayName: DEMO_ACCOUNTS.employee.displayName,
    principalId: principals.employee,
    companyId: 'company',
    tenantId: meridian,
    tenantName: accounts.manager.tenantName,
    tenantRole: 'member',
  };

  // The reviewer joins the platform company as an admin.
  const platformOwnerCtx: TenantContext = {
    tenantId: platform,
    principalId: PLATFORM_OWNER_PRINCIPAL,
    authority: [],
  };
  await ensureMembership(
    platform,
    principals['platform-reviewer'],
    'admin',
    platformOwnerCtx,
    anchors,
    'account:reviewer-membership',
  );
  accounts['platform-reviewer'] = {
    role: 'platform-reviewer',
    email: DEMO_ACCOUNTS['platform-reviewer'].email,
    displayName: DEMO_ACCOUNTS['platform-reviewer'].displayName,
    principalId: principals['platform-reviewer'],
    companyId: 'platform',
    tenantId: platform,
    tenantName: platformCompany.name,
    tenantRole: 'admin',
  };

  // Every account selects its demo company as the session's ACTIVE
  // company (the normal selection path: membership-verified, recorded in
  // the principal's company directory — a browser sign-in lands straight
  // in the product, no onboarding detour).
  for (const role of DEMO_ROLES) {
    await selectCompany({ token: tokens[role]!, tenantId: accounts[role].tenantId });
  }

  // The Aurum agent member (the separation-of-duties requester).
  await ensureMembership(meridian, AURUM_AGENT_PRINCIPAL, 'member', managerBase, anchors, 'aurum-agent-member');

  // Contexts (explicit — see the file header).
  const managerCtx = managerBase;
  const employeeCtx: TenantContext = {
    tenantId: meridian,
    principalId: accounts.employee.principalId,
    authority: [...claimsForRole('member')],
  };
  const developerCtx: TenantContext = {
    tenantId: cobalt,
    principalId: accounts.developer.principalId,
    authority: [...claimsForRole('owner')],
  };
  const aurumAgentCtx: TenantContext = { tenantId: meridian, principalId: AURUM_AGENT_PRINCIPAL, authority: [] };
  const platformPipelineCtx: TenantContext = {
    tenantId: platform,
    principalId: accounts['platform-reviewer'].principalId,
    authority: ['marketplace:administer'],
  };
  const llmCtx: TenantContext = {
    tenantId: meridian,
    principalId: accounts.manager.principalId,
    // llm:administer is not session-derived at this base — stated loudly.
    authority: [...claimsForRole('owner'), 'llm:administer'],
  };

  // --- 2) the journey dataset ---------------------------------------------

  const workspaces = await seedWorkspaces(anchors, managerCtx);
  await seedWorldRoster(anchors, managerCtx);
  const people = await seedPeople(anchors, managerCtx);
  const invite = await seedInvite(anchors, managerCtx);
  const conversation = await seedConversation(anchors, managerCtx, people.dev);
  const goals = await seedGoals(anchors, managerCtx, accounts.manager.principalId);
  const observations = await seedObservations(anchors, managerCtx, people.dev);
  const epistemics = await seedEpistemics(anchors, managerCtx, goals.returns, observations);
  const mission = await seedMission(anchors, managerCtx, goals.returns, epistemics.unknown, people.dev);
  const process = await seedProcess(anchors, managerCtx);
  const approvals = await seedApprovals(anchors, managerCtx, aurumAgentCtx, people.dev);
  await seedNotification(anchors, aurumAgentCtx, approvals.messagingRequest);
  const contribution = await seedContributionAndReward(
    anchors,
    managerCtx,
    employeeCtx,
    mission.record,
    goals.returns,
    people.dev,
  );
  const connections = await seedConnections(anchors, managerCtx);
  const llm = await seedLlm(anchors, llmCtx);
  const agents = await seedAgents(anchors, managerCtx, aurumAgentCtx, goals.returns, observations);
  const marketplace = await seedMarketplace(anchors, developerCtx, platformPipelineCtx, managerCtx);
  const integration = await seedDeveloperIntegration(anchors, managerCtx);
  const audit = await seedAudit(anchors, managerCtx, contribution.rewardApprovalId);

  // --- 3) the manifest -----------------------------------------------------

  // The approval snapshot is taken AFTER the whole dataset exists (the
  // recruitment approval is created by the agents section).
  const actionRequests = await listActionRequests(managerCtx, { limit: 500 });

  const manifest: DemoManifest = {
    seededAt: new Date().toISOString(),
    accounts,
    companies: {
      company: { tenantId: meridian, name: accounts.manager.tenantName, workspaces },
      vendor: { tenantId: cobalt, name: accounts.developer.tenantName, workspaces: [] },
      platform: { tenantId: platform, name: accounts['platform-reviewer'].tenantName, workspaces: [] },
    },
    invite,
    conversation,
    goals: goals.list,
    unknown:
      epistemics.unknown === null
        ? null
        : { id: epistemics.unknown.id, question: epistemics.unknown.question, status: epistemics.unknown.status },
    mission:
      mission.record === null
        ? null
        : { id: mission.record.id, title: mission.record.content.title, status: mission.record.content.status },
    belief:
      epistemics.belief === null
        ? null
        : {
            id: epistemics.belief.id,
            proposition: epistemics.belief.statement.proposition,
            status: epistemics.belief.status,
          },
    claim:
      epistemics.claim === null
        ? null
        : { id: epistemics.claim.id, proposition: epistemics.claim.proposition },
    process,
    pendingApprovals: actionRequests
      .filter((request) => request.status === 'pending')
      .map((request) => ({ id: request.id, actionKind: request.actionKind, authorityLevel: request.authorityLevel })),
    decidedApprovals: actionRequests
      .filter((request) => request.status !== 'pending')
      .map((request) => ({ id: request.id, actionKind: request.actionKind, decision: request.status })),
    contribution: contribution.contribution,
    reward: contribution.reward,
    channelConnections: [
      { provider: 'whatsapp', displayName: 'Meridian Ops WhatsApp', status: 'active' },
    ],
    sources: connections.sources,
    destinations: connections.destinations,
    llmAccount: llm.account,
    llmExecution: llm.execution,
    agent: agents.agent,
    agentExecution: agents.execution,
    capability: agents.capability,
    recruitmentProposal: agents.recruitmentProposal,
    marketplace,
    auditRecords: audit,
    apiKey: integration.apiKey,
    webhook: integration.webhook,
  };

  return {
    status: anchors.created.length === 0 ? 'present' : 'created',
    createdAnchors: anchors.created,
    reusedAnchors: anchors.reused,
    manifest,
  };
}

// ---------------------------------------------------------------------------
// Accounts, companies, memberships
// ---------------------------------------------------------------------------

/**
 * Ensure one demo account exists and can sign in. Unknown email and
 * wrong password are indistinguishable by design (invalid_credentials),
 * so the flow is: try sign-in; on failure try registration —
 * `email_taken` then means "exists under a DIFFERENT password", which is
 * an unreconcilable conflict the harness reports loudly.
 */
async function ensureAccount(
  role: DemoRole,
  email: string,
  displayName: string,
  password: string,
  anchors: Anchors,
): Promise<{ principalId: string; token: string }> {
  const attempt = await signIn({ email, password }).catch((error: unknown) => error as AuthError);
  if (!(attempt instanceof Error)) {
    anchors.note(`account:${role}`, false);
    return { principalId: attempt.session.principalId, token: attempt.token };
  }
  if (attempt.code !== 'invalid_credentials') throw attempt;
  try {
    const issued = await registerUser({ displayName, email, password });
    anchors.note(`account:${role}`, true);
    return { principalId: issued.session.principalId, token: issued.token };
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: unknown }).code === 'email_taken'
    ) {
      throw new DemoError(
        'seed_conflict',
        `demo account '${email}' already exists with a different password — refusing to overwrite or duplicate it`,
      );
    }
    throw error;
  }
}

/** Ensure the account's demo company exists (matched by exact name). */
async function ensureCompany(
  role: DemoRole,
  token: string,
  companyId: 'company' | 'vendor' | 'platform',
  principalId: string,
  anchors: Anchors,
): Promise<{ tenantId: string; name: string }> {
  const spec = DEMO_COMPANIES[companyId];
  const companies = await listUserCompanies({ token });
  const existing = companies.find((company) => company.tenantName === spec.name) ?? null;
  if (existing !== null) {
    anchors.note(`company:${companyId}`, false);
    return { tenantId: existing.tenantId, name: existing.tenantName };
  }
  const provisioner: PlatformContext = {
    principalId: PROVISIONER_PRINCIPAL,
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };
  const tenant = await provisionTenant(provisioner, {
    name: spec.name,
    ownerPrincipalId: principalId,
    defaultWorkspaceName: spec.defaultWorkspaceName,
  });
  anchors.note(`company:${companyId}`, true);
  return { tenantId: tenant.id, name: tenant.name };
}

/**
 * The demo platform company — owned by the deterministic platform-owner
 * principal (a platform reviewer is staff, not the owner), matched on
 * re-runs through the reviewer's company directory.
 */
async function ensurePlatformCompany(
  anchors: Anchors,
  reviewerToken: string,
): Promise<{ tenantId: string; name: string }> {
  const spec = DEMO_COMPANIES.platform;
  const companies = await listUserCompanies({ token: reviewerToken });
  const existing = companies.find((company) => company.tenantName === spec.name) ?? null;
  if (existing !== null) {
    anchors.note('company:platform', false);
    return { tenantId: existing.tenantId, name: existing.tenantName };
  }
  const provisioner: PlatformContext = {
    principalId: PROVISIONER_PRINCIPAL,
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };
  const tenant = await provisionTenant(provisioner, {
    name: spec.name,
    ownerPrincipalId: PLATFORM_OWNER_PRINCIPAL,
    defaultWorkspaceName: spec.defaultWorkspaceName,
  });
  anchors.note('company:platform', true);
  return { tenantId: tenant.id, name: tenant.name };
}

/** Ensure a principal holds exactly `role` in the tenant. */
async function ensureMembership(
  tenantId: string,
  principalId: string,
  role: TenantRole,
  ownerCtx: TenantContext,
  anchors: Anchors,
  key: string,
): Promise<void> {
  const existing = await getTenantMembership(ownerCtx, { principalId }).catch(() => null);
  if (existing === null) {
    await addTenantMember(ownerCtx, { principalId, role });
    anchors.note(key, true);
    return;
  }
  if (existing.role !== role) {
    await changeTenantMemberRole(ownerCtx, { principalId, role });
  }
  anchors.note(key, false);
}

// ---------------------------------------------------------------------------
// Journey A — onboarding: workspaces, the world roster, people, the invite
// ---------------------------------------------------------------------------

async function seedWorkspaces(
  anchors: Anchors,
  managerCtx: TenantContext,
): Promise<{ id: string; name: string }[]> {
  const secondName = 'Returns Taskforce';
  const existing = await listWorkspaces(managerCtx);
  const second = existing.find((workspace) => workspace.name === secondName) ?? null;
  if (second === null) {
    await createWorkspace(managerCtx, { name: secondName });
    anchors.note('workspace:returns-taskforce', true);
  } else {
    anchors.note('workspace:returns-taskforce', false);
  }
  const all = await listWorkspaces(managerCtx);
  return all.map((workspace) => ({ id: workspace.id, name: workspace.name }));
}

/**
 * The world-model roster (the People surface's data — W005 owns the
 * declared org chart). Idempotent by exact entity name + kind.
 */
async function seedWorldRoster(
  anchors: Anchors,
  managerCtx: TenantContext,
): Promise<void> {
  const roster = [
    { kind: 'manager', name: 'Mara Ellison', description: 'Operations Manager (demo persona — manager)' },
    { kind: 'employee', name: 'Dev Patel', description: 'Logistics Coordinator (demo persona — employee)' },
    { kind: 'employee', name: 'Iris Calloway', description: 'Returns Specialist' },
    { kind: 'team', name: 'Logistics', description: 'The logistics and returns coordinators' },
  ] as const;
  for (const entry of roster) {
    const entities = await listEntities(managerCtx, { search: entry.name, limit: 50 });
    const existing = entities.find((entity) => entity.name === entry.name && entity.kind === entry.kind) ?? null;
    await anchors.ensure(`world:${entry.name}`, existing, () =>
      createEntity(managerCtx, {
        kind: entry.kind,
        name: entry.name,
        description: entry.description,
      }),
    );
  }
}

/**
 * The people-module records: Dev needs one (the identity / contribution
 * chain anchors on it). Idempotent through the identity resolution (a
 * re-run resolves Dev's verified WhatsApp account to the same person).
 */
async function seedPeople(anchors: Anchors, managerCtx: TenantContext): Promise<{ dev: Person }> {
  const resolution = await resolveIdentity(managerCtx, {
    provider: 'whatsapp',
    providerAccountId: DEV_WHATSAPP_ACCOUNT,
  }).catch(() => null);
  if (resolution !== null && resolution.status === 'resolved') {
    anchors.note('person:dev', false);
    return { dev: resolution.person };
  }
  const person = await createPerson(managerCtx, {
    fullName: 'Dev Patel',
    email: 'dev.patel@meridian-demo.example',
  });
  await createEmployee(managerCtx, {
    personId: person.id,
    employeeNumber: 'E-7002',
    title: 'Logistics Coordinator',
    department: 'Operations',
    hiredAt: AT(-60 * 86_400),
  });
  anchors.note('person:dev', true);
  return { dev: person };
}

async function seedInvite(
  anchors: Anchors,
  managerCtx: TenantContext,
): Promise<{ email: string; status: string } | null> {
  const email = 'new-hire@meridian-demo.example';
  const invites = await listInvites(managerCtx, {});
  const existing = invites.find((invite) => invite.email === email) ?? null;
  if (existing !== null) {
    anchors.note('invite:new-hire', false);
    return { email, status: existing.status };
  }
  await createInvite(managerCtx, { email, role: 'member' });
  anchors.note('invite:new-hire', true);
  return { email, status: 'pending' };
}

// ---------------------------------------------------------------------------
// Journey B — the conversation (channel identity + transcript)
// ---------------------------------------------------------------------------

function whatsappPayload(text: string, wamid: string, offsetSeconds: number): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: MERIDIAN_WHATSAPP_NUMBER.replace('+', '') },
              contacts: [{ profile: { name: 'Dev Patel' }, wa_id: DEV_WHATSAPP_ACCOUNT.replace('+', '') }],
              messages: [
                {
                  from: DEV_WHATSAPP_ACCOUNT.replace('+', ''),
                  id: wamid,
                  timestamp: WHATSAPP_EPOCH(offsetSeconds),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function seedConversation(
  anchors: Anchors,
  managerCtx: TenantContext,
  devPerson: Person,
): Promise<{ id: string; title: string; messageCount: number } | null> {
  // The channel endpoint (the company's WhatsApp sending number).
  const connection = await registerChannelConnection(managerCtx, {
    provider: 'whatsapp',
    providerAccountId: MERIDIAN_WHATSAPP_NUMBER,
    displayName: 'Meridian Ops WhatsApp',
    credentialRef: 'secret-store://demo/whatsapp/meridian',
  });
  anchors.note('channel:whatsapp-connection', connection.created);

  // Dev's channel identity: register, attest (identity:attest rides the
  // manager's session claims), link to the person (identity:link).
  const identity = await registerExternalIdentity(managerCtx, {
    provider: 'whatsapp',
    providerAccountId: DEV_WHATSAPP_ACCOUNT,
    displayName: 'Dev Patel',
  });
  if (identity.identity.status !== 'verified') {
    await attestIdentity(managerCtx, {
      identityId: identity.identity.id,
      evidence: 'demo harness: account holder confirmed in person (W068 deterministic seed)',
    });
  }
  const resolution = await resolveIdentity(managerCtx, {
    provider: 'whatsapp',
    providerAccountId: DEV_WHATSAPP_ACCOUNT,
  });
  if (resolution.status === 'resolved' && resolution.person.id === devPerson.id) {
    anchors.note('identity:dev-whatsapp', false);
  } else {
    await linkExternalIdentity(managerCtx, { personId: devPerson.id, identityId: identity.identity.id });
    anchors.note('identity:dev-whatsapp', true);
  }

  // The deterministic transcript: three inbound turns from Dev (deduped
  // by provider message id on re-runs) and two outbound Aurum turns.
  setChannelTransport(channelTransport);
  try {
    const inbound: { text: string; wamid: string; at: number }[] = [
      {
        text: 'Aurum, this is Dev from logistics — customs paperwork is stalling our returns badly again.',
        wamid: 'demo.w068.inbound.1',
        at: 0,
      },
      {
        text: 'RET-2001 update: the broker is still waiting on the commercial invoice — day four now.',
        wamid: 'demo.w068.inbound.2',
        at: 1800,
      },
      {
        text: 'RET-2002 cleared only after I chased the broker manually — three days lost.',
        wamid: 'demo.w068.inbound.3',
        at: 3600,
      },
    ];
    let conversationId: string | null = null;
    for (const turn of inbound) {
      const result = await receiveInbound(managerCtx, {
        provider: 'whatsapp',
        payload: whatsappPayload(turn.text, turn.wamid, turn.at),
      });
      conversationId = result.message.conversationId;
    }
    const outbound: string[] = [
      'Thanks Dev — I have logged RET-2001 and RET-2002 as customs-documentation delays and opened a learning mission on the gap.',
      'I have asked for approval to send you a targeted question about the missing document set — it will reach this thread once management signs off.',
    ];
    for (const text of outbound) {
      await sendOutbound(managerCtx, {
        provider: 'whatsapp',
        to: { providerAccountId: DEV_WHATSAPP_ACCOUNT, displayName: 'Dev Patel' },
        content: { text, attachments: [] },
        conversationId,
      });
    }

    const conversation = conversationId === null ? null : await getConversation(managerCtx, conversationId).catch(() => null);
    if (conversation === null) return null;
    const messages: Message[] = await listMessages(managerCtx, {
      conversationId: conversation.id,
      limit: 500,
    });
    return {
      id: conversation.id,
      title: conversation.title ?? '',
      messageCount: messages.length,
    };
  } finally {
    setChannelTransport(null);
  }
}

// ---------------------------------------------------------------------------
// Journey C/D — goals, observations, epistemics, mission, process
// ---------------------------------------------------------------------------

async function seedGoals(
  anchors: Anchors,
  managerCtx: TenantContext,
  managerPrincipalId: string,
): Promise<{ list: DemoManifest['goals']; returns: { id: string; title: string } }> {
  const specs = [
    {
      ...GOAL_RETURNS,
      priority: 'high' as const,
      metric: { name: 'returns-cycle-days', unit: 'days', direction: 'at_most' as const, threshold: 3 },
    },
    {
      ...GOAL_INVOICE,
      priority: 'medium' as const,
      metric: { name: 'invoice-accuracy-percent', unit: 'percent', direction: 'at_least' as const, threshold: 98 },
    },
    {
      ...GOAL_CARRIER,
      priority: 'medium' as const,
      metric: { name: 'carrier-ontime-percent', unit: 'percent', direction: 'at_least' as const, threshold: 95 },
    },
  ];
  const list: DemoManifest['goals'] = [];
  let returns: Goal | null = null;
  for (const spec of specs) {
    const existing = (await listGoals(managerCtx, { search: spec.title, limit: 10 })).find(
      (goal) => goal.content.title === spec.title,
    ) ?? null;
    const goal = await anchors.ensure(`goal:${spec.metric.name}`, existing, () =>
      createGoal(managerCtx, {
        title: spec.title,
        objective: spec.objective,
        desiredState: spec.desiredState,
        metrics: [spec.metric],
        horizonStart: AT(0),
        horizonEnd: '2027-03-31T23:59:59.999Z',
        owner: { kind: 'person', id: managerPrincipalId, label: 'Mara Ellison (Operations Manager)' },
        priority: spec.priority,
        evidenceSources: [
          { kind: 'source', label: 'Returns tracker (demo)' },
          { kind: 'person', label: 'Dev Patel (Logistics Coordinator)' },
        ],
        successCriteria: `${spec.desiredState} for one full quarter`,
        actor: { kind: 'person', id: managerPrincipalId, label: 'Mara Ellison (Operations Manager)' },
        rationale: 'W068 deterministic demo dataset — board operations target',
      }),
    );
    if (spec.metric.name === 'returns-cycle-days') returns = goal;
    list.push({ id: goal.id, title: goal.content.title, priority: goal.content.priority });
  }
  return { list, returns: { id: returns!.id, title: returns!.content.title } };
}

/** The returns-case evidence observations (person-reported + system samples). */
async function seedObservations(
  anchors: Anchors,
  managerCtx: TenantContext,
  devPerson: Person,
): Promise<Observation[]> {
  const cases: { caseId: string; stage: string; at: number; byPerson: boolean }[] = [
    { caseId: 'RET-2001', stage: 'customs-check', at: 0, byPerson: true },
    { caseId: 'RET-2001', stage: 'broker-followup', at: 7200, byPerson: true },
    { caseId: 'RET-2002', stage: 'customs-check', at: 5400, byPerson: true },
    { caseId: 'RET-2002', stage: 'released', at: 9000, byPerson: true },
    { caseId: 'RET-2003', stage: 'customs-check', at: 10800, byPerson: false },
    { caseId: 'RET-2004', stage: 'customs-check', at: 12600, byPerson: false },
  ];
  const existing = await listObservations(managerCtx, {
    kind: 'returns.stage',
    observedFrom: AT(0),
    observedTo: AT(20000),
    limit: 500,
  });
  const out: Observation[] = [];
  for (const entry of cases) {
    const match =
      existing.find(
        (observation) =>
          (observation.payload as { caseId?: string }).caseId === entry.caseId &&
          (observation.payload as { stage?: string }).stage === entry.stage,
      ) ?? null;
    const observation = await anchors.ensure(`observation:${entry.caseId}:${entry.stage}`, match, () =>
      recordObservation(managerCtx, {
        kind: 'returns.stage',
        payload: { caseId: entry.caseId, stage: entry.stage, note: 'W068 deterministic returns-flow evidence' },
        observedAt: AT(entry.at),
        source: entry.byPerson
          ? { kind: 'person', id: devPerson.id, label: 'Dev Patel' }
          : { kind: 'system', label: 'returns-tracker (demo)' },
        channel: 'ingestion',
        confidence: {
          value: entry.byPerson ? 0.8 : 0.7,
          method: 'channel-attribution',
          basis: entry.byPerson ? 'person-verified channel turn' : 'deterministic demo ingestion',
        },
      }),
    );
    out.push(observation);
  }
  return out;
}

async function seedEpistemics(
  anchors: Anchors,
  managerCtx: TenantContext,
  returnsGoal: { id: string; title: string },
  observations: Observation[],
): Promise<{
  claim: Claim | null;
  belief: Belief | null;
  unknown: Unknown | null;
}> {
  const evidenceIds = observations.map((observation) => observation.id).slice(0, 4);

  const existingClaim =
    (await listClaims(managerCtx, { limit: 500 })).find((claim) => claim.proposition === CLAIM_PROPOSITION) ?? null;
  const claim = await anchors.ensure('claim:customs-wait', existingClaim, () =>
    recordClaim(managerCtx, {
      proposition: CLAIM_PROPOSITION,
      subject: { kind: 'goals.goal', id: returnsGoal.id },
      confidence: { value: 0.85, method: 'channel-evidence', basis: 'four person-attributed returns-case updates' },
      evidenceObservationIds: evidenceIds,
      rationale: 'W068 deterministic demo dataset — the returns-cycle evidence',
    }),
  );

  // Beliefs resolve their statement per read; the match walks the active
  // anchors and resolves each one (few beliefs, deterministic match).
  const beliefAnchors = await listBeliefs(managerCtx, { limit: 500 });
  let existingBelief: Belief | null = null;
  for (const anchor of beliefAnchors) {
    const belief = await getBelief(managerCtx, {
      beliefId: anchor.id,
      // resolve at a fixed instant after the demo belief's validFrom — the
      // match must not depend on the wall clock.
      asOf: '2027-06-30T00:00:00.000Z',
    }).catch(() => null);
    if (belief !== null && belief.statement.proposition === BELIEF_PROPOSITION) {
      existingBelief = belief;
      break;
    }
  }
  const belief = await anchors.ensure('belief:customs-bottleneck', existingBelief, () =>
    formBelief(managerCtx, {
      proposition: BELIEF_PROPOSITION,
      confidence: { value: 0.8, method: 'channel-evidence', basis: 'claims over four returns-case updates' },
      supportingObservationIds: evidenceIds,
      supportingClaimIds: [claim.id],
      alternatives: ['the broker is slow only for these cases, not generally'],
      disconfirmation: 'a returns case clearing customs within a day',
      subject: { kind: 'goals.goal', id: returnsGoal.id },
      validFrom: '2026-09-12T12:00:00.000Z',
      rationale: 'derived from the demo chain’s own claim',
    }),
  );

  const existingUnknown =
    (await listUnknowns(managerCtx, { limit: 500 })).find((unknown) => unknown.question === UNKNOWN_QUESTION) ?? null;
  const unknown = await anchors.ensure('unknown:customs-documents', existingUnknown, () =>
    recordUnknown(managerCtx, {
      question: UNKNOWN_QUESTION,
      consequence:
        'Without knowing which documents are missing, the returns cycle keeps breaching the three-day goal and broker follow-ups stay manual.',
      subject: { kind: 'goals.goal', id: returnsGoal.id },
      relatedObservationIds: evidenceIds,
      relatedClaimIds: [claim.id],
      note: 'W068 deterministic demo dataset — the first-class unknown the mission closes',
    }),
  );

  return { claim, belief, unknown };
}

async function seedMission(
  anchors: Anchors,
  managerCtx: TenantContext,
  returnsGoal: { id: string; title: string },
  unknown: Unknown | null,
  devPerson: Person,
): Promise<{ record: Mission }> {
  const existing =
    (await listMissions(managerCtx, { search: MISSION_TITLE, limit: 10 })).find(
      (mission) => mission.content.title === MISSION_TITLE,
    ) ?? null;
  const mission = await anchors.ensure('mission:customs-gap', existing, () =>
    createMission(managerCtx, {
      title: MISSION_TITLE,
      knowledgeObjective:
        'Identify exactly which customs-broker documents stall the returns cycle and what closes the gap.',
      affectedGoals: [{ goalId: returnsGoal.id, label: returnsGoal.title }],
      unknownIds: unknown === null ? [] : [unknown.id],
      informationValue: 0.9,
      urgency: 'high',
      currentConfidence: 0.35,
      targetConfidence: 0.85,
      investigationBudget: { amount: 250_00, currency: 'USD' },
      rewardBudget: { amount: 500_00, currency: 'USD' },
      rewardTerms: 'Recognition gifts under the demo reward policy',
      candidateSources: [{ kind: 'person', id: devPerson.id, label: 'Dev Patel (Logistics Coordinator)' }],
      completionCriteria: 'A validated document checklist with confidence >= 0.85',
      actor: { kind: 'person', label: 'Mara Ellison (Operations Manager)' },
      rationale: 'W068 deterministic demo dataset — goal-gap-driven learning mission',
    }),
  );
  return { record: mission };
}

async function seedProcess(
  anchors: Anchors,
  managerCtx: TenantContext,
): Promise<DemoManifest['process']> {
  const existing = (await listProcesses(managerCtx, { name: PROCESS_NAME, limit: 10 }))[0] ?? null;
  const process: Process = await anchors.ensure('process:returns', existing, () =>
    reconstructProcess(managerCtx, {
      name: PROCESS_NAME,
      scope: { observationKinds: ['returns.stage'], caseKeyCandidates: ['caseId'] },
      actor: { kind: 'system', label: 'aurum-demo-harness' },
      rationale: 'W068 deterministic demo dataset — reconstruct the returns flow from the case evidence',
    }),
  );
  const findings = await listProcessFindings(managerCtx, { processId: process.id, limit: 100 });
  return {
    id: process.id,
    name: process.name,
    version: process.version,
    findingCount: findings.length,
  };
}

// ---------------------------------------------------------------------------
// Journey E — approvals (the human gate)
// ---------------------------------------------------------------------------

async function seedApprovals(
  anchors: Anchors,
  managerCtx: TenantContext,
  aurumAgentCtx: TenantContext,
  devPerson: Person,
): Promise<{
  messagingRequest: ActionRequest;
}> {
  // The tenant's authority policies (deterministic demo posture):
  //  * asking an employee over a channel requires human approval at ASK;
  //  * package deployments are pre-authorized so the installed-package
  //    journey lands deterministically (governance stays on the
  //    installed surface).
  await setAuthorityPolicy(managerCtx, {
    actionKind: 'employee-messaging',
    approvalLevels: ['ASK'],
    note: 'W068 demo policy: every outbound question to an employee is reviewed by management',
  });
  await setAuthorityPolicy(managerCtx, {
    actionKind: 'extension-deployment',
    approvalLevels: [],
    forbiddenLevels: [],
    note: 'W068 demo policy: package deployments are pre-authorized for the demo company',
  });

  // The flagship pending approval: Aurum's targeted question to Dev,
  // requested by the Aurum agent member (never the decider herself).
  const preExisting =
    (await listActionRequests(managerCtx, { actionKind: 'employee-messaging', status: 'pending', limit: 100 })).find(
      (request) => (request.payload as { question?: string } | null)?.question === UNKNOWN_QUESTION,
    ) ?? null;
  const messagingRequest = await authorizeAction(aurumAgentCtx, {
    actionKind: 'employee-messaging',
    authorityLevel: 'ASK',
    payload: { to: devPerson.id, channel: 'whatsapp', question: UNKNOWN_QUESTION },
    justification:
      'close the customs-documentation evidence gap behind the returns-cycle risk before escalating (W068 demo)',
    idempotencyKey: KEYS.messagingAsk,
  });
  anchors.note('approval:employee-messaging', preExisting === null);
  return { messagingRequest };
}

async function seedNotification(
  anchors: Anchors,
  aurumAgentCtx: TenantContext,
  messagingRequest: ActionRequest,
): Promise<void> {
  const existing = await listNotifications(aurumAgentCtx, { dedupeKey: KEYS.notification, limit: 10 });
  if (existing.length > 0) {
    anchors.note('notification:customs-question', false);
    return;
  }
  setChannelTransport(channelTransport);
  try {
    await createNotification(aurumAgentCtx, {
      kind: 'approval.requested',
      recipient: { provider: 'whatsapp', providerAccountId: DEV_WHATSAPP_ACCOUNT, displayName: 'Dev Patel' },
      subject: 'Pending approval: Aurum has a customs question for you',
      body:
        'Aurum asked management for approval to send you one targeted question about the missing customs-broker documents. You will see it here once it is approved.',
      data: { actionRequestId: messagingRequest.id },
      dedupeKey: KEYS.notification,
    });
  } finally {
    setChannelTransport(null);
  }
  anchors.note('notification:customs-question', true);
}

// ---------------------------------------------------------------------------
// Journey F — the employee's knowledge contribution and its reward
// ---------------------------------------------------------------------------

async function seedContributionAndReward(
  anchors: Anchors,
  managerCtx: TenantContext,
  employeeCtx: TenantContext,
  mission: Mission,
  returnsGoal: { id: string; title: string },
  devPerson: Person,
): Promise<{
  contribution: DemoManifest['contribution'];
  reward: DemoManifest['reward'];
  rewardApprovalId: string | null;
}> {
  // 1) The acquisition plan: Aurum asks Dev (the mission's person
  //    candidate). The ask is policy-gated but the plan is committed.
  const plans = await listAcquisitionPlans(managerCtx, {
    missionId: mission.id,
    action: 'ask-person',
    limit: 50,
  });
  let plan: AcquisitionPlan | null = plans.find((candidate) => candidate.outcome !== null) ?? null;
  if (plan === null) {
    const planned = await planNextAcquisition(managerCtx, {
      missionId: mission.id,
      candidates: [
        {
          kind: 'person',
          id: devPerson.id,
          label: 'Dev Patel (Logistics Coordinator)',
          relevance: 0.9,
          reliability: 0.8,
          freshness: 0.7,
          authority: 0.8,
          expectedQuality: 0.85,
          priorContributionValue: 0.5,
          cost: 0,
          access: 'allowed',
        },
      ],
      actor: { kind: 'system', label: 'aurum-demo-harness' },
      rationale: 'W068 deterministic demo dataset — the targeted employee question',
    });
    plan = await recordAcquisitionOutcome(managerCtx, {
      planId: planned.id,
      outcome: 'answered',
      evidence: {
        payload: {
          answer:
            'The customs broker needs the commercial invoice AND the packing list before filing. RET-2001 is missing the packing list; RET-2003 is missing the commercial invoice.',
        },
        confidence: { value: 0.85, method: 'source_trust', basis: 'direct account of the logistics coordinator' },
        observedAt: AT(15000),
      },
    });
    anchors.note('acquisition:customs-question', true);
  } else {
    anchors.note('acquisition:customs-question', false);
  }

  // 2) The contribution anchored to the answered plan.
  let contribution: Contribution | null = (
    await listContributions(managerCtx, { missionId: mission.id, limit: 50 })
  ).find((entry) => entry.contributor.id === devPerson.id) ?? null;
  if (contribution === null) {
    contribution = await recordContribution(managerCtx, {
      planId: plan.id,
      summary:
        'Named the exact missing customs-broker documents per case (packing list for RET-2001, commercial invoice for RET-2003).',
      note: 'W068 deterministic demo dataset — Dev’s targeted answer',
      actor: { kind: 'person', id: devPerson.id, label: 'Dev Patel' },
    });
    anchors.note('contribution:customs-documents', true);
  } else {
    anchors.note('contribution:customs-documents', false);
  }

  // 3) Validation + measured impact (the learning link of the chain).
  if (contribution.status === 'pending') {
    await validateContribution(managerCtx, {
      contributionId: contribution.id,
      outcome: 'validated',
      quality: 0.9,
      evidence: [
        {
          kind: 'observation',
          id: plan.outcome?.evidenceObservationId ?? '',
          label: 'the answered acquisition evidence',
        },
      ],
      note: 'cross-checked against the case tracker updates',
      actor: { kind: 'person', label: 'Mara Ellison (Operations Manager)' },
    });
  }
  if (contribution.status === 'validated' || contribution.status === 'pending') {
    contribution = (await listContributions(managerCtx, { missionId: mission.id, limit: 50 })).find(
      (entry) => entry.id === contribution!.id,
    )!;
  }
  if (contribution.status === 'validated') {
    await recordImpact(managerCtx, {
      contributionId: contribution.id,
      missionImpact: 'advanced',
      confidenceBefore: 0.35,
      confidenceAfter: 0.7,
      affectedGoals: [{ goalId: returnsGoal.id, label: returnsGoal.title }],
      avoidedCost: 120_00,
      avoidedPaths: [
        { action: 'ask-person', label: 'A second broker follow-up round', estimatedCost: 40_00 },
        { action: 'retrieve-document', label: 'Manual customs filing audit', estimatedCost: 80_00 },
      ],
      note: 'W068 deterministic demo dataset — measured mission impact',
      actor: { kind: 'system', label: 'aurum-demo-harness' },
    });
    contribution = (await listContributions(managerCtx, { missionId: mission.id, limit: 50 })).find(
      (entry) => entry.id === contribution!.id,
    )!;
  }

  // 4) The reward policy + the reward (applied by the contributor, decided
  //    by the manager — separation of duties — then settled to granted).
  const policy = await getRewardPolicy(managerCtx);
  if (policy === null) {
    await setRewardPolicy(managerCtx, {
      tiers: [
        { name: 'Bronze recognition', minValueScore: 0.2, kind: 'recognition', amount: 0 },
        { name: 'Silver gift', minValueScore: 0.5, kind: 'gift', amount: 25_00 },
        { name: 'Gold voucher', minValueScore: 0.75, kind: 'voucher', amount: 75_00 },
      ],
      rewardCurrency: 'USD',
      qualifyingStatuses: ['validated', 'measured'],
      note: 'W068 deterministic demo policy — non-compensation recognition only',
    });
    anchors.note('reward-policy:meridian', true);
  } else {
    anchors.note('reward-policy:meridian', false);
  }

  let reward: Reward | null = (await listRewards(managerCtx, { missionId: mission.id, limit: 50 }))[0] ?? null;
  if (reward === null) {
    const application = await applyRewardPolicy(employeeCtx, {
      contribution: {
        kind: 'knowledge-contribution',
        id: contribution.id,
        contributor: { personId: devPerson.id, label: 'Dev Patel' },
      },
      missionId: mission.id,
      value: {
        status: contribution.status,
        knowledgeGain: 0.35,
        missionImpact: 'advanced',
        affectedGoals: [{ goalId: returnsGoal.id, label: returnsGoal.title }],
        costAvoided: { amount: 120_00, currency: 'USD' },
      },
      actor: { kind: 'person', id: devPerson.id, label: 'Dev Patel' },
      rationale: 'W068 deterministic demo dataset — the contributor’s reward application',
    });
    reward = application.reward;
    if (reward === null) {
      throw new DemoError(
        'seed_conflict',
        'the demo contribution did not qualify for a reward under the demo policy',
      );
    }
    anchors.note('reward:customs-documents', true);
  } else {
    anchors.note('reward:customs-documents', false);
  }
  const rewardApprovalId: string = reward.actionRequestId;

  if (reward.status === 'proposed') {
    await decideApproval(managerCtx, {
      requestId: rewardApprovalId,
      decision: 'approve',
      note: 'W068 demo decision: the answer closed the document gap for two cases',
    });
    reward = await settleReward(managerCtx, { rewardId: reward.id });
  }

  return {
    contribution: { id: contribution.id, status: contribution.status, summary: contribution.summary },
    reward: { id: reward.id, status: reward.status, kind: reward.tier.kind },
    rewardApprovalId,
  };
}

// ---------------------------------------------------------------------------
// Journey G — connections (channel + source + destination)
// ---------------------------------------------------------------------------

async function seedConnections(
  anchors: Anchors,
  managerCtx: TenantContext,
): Promise<{
  sources: DemoManifest['sources'];
  destinations: DemoManifest['destinations'];
}> {
  const registeredSource = await registerSource(managerCtx, {
    provider: 'stripe',
    providerAccountId: 'meridian-demo-stripe',
    displayName: 'Stripe billing (demo)',
    authKind: 'oauth',
    credentialRef: 'secret-store://demo/stripe/meridian',
    oauthScopes: ['read:invoices'],
  });
  anchors.note('source:stripe', registeredSource.created);

  // One deterministic ingestion pass (the checkpoint + billing evidence).
  const checkpoint = await getSourceCheckpoint(managerCtx, { sourceId: registeredSource.source.id });
  if (checkpoint === null) {
    setSourceTransport(sourceTransport);
    try {
      await pollSource(managerCtx, { sourceId: registeredSource.source.id });
    } finally {
      setSourceTransport(null);
    }
    anchors.note('source:stripe-poll', true);
  } else {
    anchors.note('source:stripe-poll', false);
  }

  const registeredDestination = await registerDestination(managerCtx, {
    provider: 'webhook',
    providerAccountId: 'https://demo.meridian.example/hooks/warehouse',
    displayName: 'Warehouse sync (demo)',
    authKind: 'credentials',
    credentialRef: 'secret-store://demo/webhook/warehouse',
  });
  anchors.note('destination:warehouse-webhook', registeredDestination.created);

  const sources = await listSources(managerCtx, { limit: 50 });
  const destinations = await listDestinations(managerCtx, { limit: 50 });
  return {
    sources: sources.map((source: Source) => ({
      id: source.id,
      provider: source.provider,
      displayName: source.displayName,
    })),
    destinations: destinations.map((destination: Destination) => ({
      id: destination.id,
      provider: destination.provider,
      displayName: destination.displayName,
    })),
  };
}

// ---------------------------------------------------------------------------
// Journey H — BYOA (the tenant's AI provider account)
// ---------------------------------------------------------------------------

async function seedLlm(
  anchors: Anchors,
  llmCtx: TenantContext,
): Promise<{
  account: DemoManifest['llmAccount'];
  execution: DemoManifest['llmExecution'];
}> {
  const label = 'Demo OpenAI account';
  const existing =
    (await listAiProviderAccounts(llmCtx, { provider: 'openai', limit: 50 })).find(
      (account) => account.label === label,
    ) ?? null;
  const account: AiProviderAccount = await anchors.ensure('llm-account:openai', existing, async () =>
    (
      await registerAiProviderAccount(llmCtx, {
        provider: 'openai',
        label,
        credentialRef: 'secret-store://demo/openai/meridian',
        scopes: ['conversation', 'analysis'],
        capabilities: ['text-generation'],
        maxDataClassification: 'restricted',
        priority: 1,
      })
    ).account,
  );

  const model = 'gpt-4o-mini'; // a registry model of the provider
  await setAiAvailability(llmCtx, { accountId: account.id, model, state: 'available' });

  let execution: LlmExecution | null =
    (await listLlmExecutions(llmCtx, { accountId: account.id, limit: 50 }))[0] ?? null;
  if (execution === null) {
    setLlmTransport(llmTransport);
    try {
      execution = await invokeLlm(llmCtx, {
        capability: 'text-generation',
        scope: 'conversation',
        dataClassification: 'internal',
        messages: [
          { role: 'system', content: 'You are Aurum, an organizational intelligence employee. Answer with evidence.' },
          { role: 'user', content: 'Summarize the returns-cycle bottleneck in two sentences.' },
        ],
        idempotencyKey: KEYS.llmExecution,
      });
    } finally {
      setLlmTransport(null);
    }
    anchors.note('llm-execution:returns-summary', true);
  } else {
    anchors.note('llm-execution:returns-summary', false);
  }

  return {
    account: { id: account.id, provider: account.provider, label: account.label, status: account.status },
    execution: { id: execution.id, status: execution.status, model: execution.model },
  };
}

// ---------------------------------------------------------------------------
// Journey I — agents, capability gap, recruitment proposal
// ---------------------------------------------------------------------------

async function seedAgents(
  anchors: Anchors,
  managerCtx: TenantContext,
  aurumAgentCtx: TenantContext,
  returnsGoal: { id: string; title: string },
  observations: Observation[],
): Promise<{
  agent: DemoManifest['agent'];
  execution: DemoManifest['agentExecution'];
  capability: DemoManifest['capability'];
  recruitmentProposal: DemoManifest['recruitmentProposal'];
}> {
  // The company's own agent (I: "monitor an agent").
  const slug = 'returns-triage';
  const registered = await registerAgent(managerCtx, {
    slug,
    displayName: 'Returns Triage Assistant',
    role: 'triage inbound returns cases',
    description: 'Reads returns-case updates, tags the delay stage and drafts the broker follow-up.',
    provider: 'langgraph',
    instructions: 'Triage each returns case by its delay stage; never message employees without approval.',
    runtimeConfig: { assistantId: 'asst_returns_triage_v1' },
    permissions: ['observe', 'analyze', 'recommend'],
  });
  anchors.note('agent:returns-triage', registered.created);

  let execution = (await listAgentExecutions(managerCtx, { agentId: registered.agent.id, limit: 50 }))[0] ?? null;
  if (execution === null) {
    const submitted = await submitAgentExecution(managerCtx, {
      agentId: registered.agent.id,
      task: { cases: ['RET-2001', 'RET-2003'], action: 'tag-delay-stage' },
      requestedPermissions: ['analyze'],
      maxAttempts: 1,
      idempotencyKey: KEYS.agentExecution,
    });
    setAgentTransport(agentTransport);
    try {
      execution = await runAgentExecution(managerCtx, { executionId: submitted.id });
    } finally {
      setAgentTransport(null);
    }
    anchors.note('agent-execution:returns-triage', true);
  } else {
    anchors.note('agent-execution:returns-triage', false);
  }

  // The capability gap (Journey D's capability leg + I's entry point).
  const capabilityName = 'Customs documentation handling';
  const existingCapability =
    (await listCapabilities(managerCtx, { limit: 500 })).find((capability) => capability.name === capabilityName) ??
    null;
  const capability: Capability = await anchors.ensure('capability:customs-docs', existingCapability, () =>
    registerCapability(managerCtx, {
      name: capabilityName,
      description: 'Prepare and verify the customs-broker document set for international returns.',
      actor: { kind: 'person', label: 'Mara Ellison (Operations Manager)' },
      rationale: 'W068 deterministic demo dataset — the capability the returns cycle depends on',
    }),
  );
  await anchors.ensure(
    `requirement:${capability.id}:goal`,
    (await listRequirements(managerCtx, { capabilityId: capability.id, limit: 50 }))[0] ?? null,
    () =>
      registerRequirement(managerCtx, {
        capabilityId: capability.id,
        source: { kind: 'goal', id: returnsGoal.id, label: returnsGoal.title },
        level: 0.8,
        note: 'the returns-cycle goal needs reliable document handling',
        actor: { kind: 'person', label: 'Mara Ellison (Operations Manager)' },
      }),
  );
  await anchors.ensure(
    `supply:${capability.id}:logistics`,
    (await listSupplies(managerCtx, { capabilityId: capability.id, limit: 50 }))[0] ?? null,
    () =>
      registerSupply(managerCtx, {
        capabilityId: capability.id,
        supplier: { kind: 'team', label: 'Logistics' },
        level: 0.4,
        evidenceObservationIds: observations.slice(0, 4).map((observation) => observation.id),
        note: 'manual handling only — the current supply',
        actor: { kind: 'person', label: 'Mara Ellison (Operations Manager)' },
      }),
  );

  // The recruitment proposal awaiting the human gate (requested by the
  // Aurum agent member so the manager can decide it in the browser).
  const proposalTitle = 'Add a customs-documentation agent';
  const existingProposal =
    (await listRecruitmentProposals(managerCtx, { limit: 100 })).find(
      (proposal) => proposal.title === proposalTitle,
    ) ?? null;
  let proposal: AgentRecruitmentProposal;
  if (existingProposal === null) {
    proposal = await createRecruitmentProposal(managerCtx, {
      title: proposalTitle,
      capabilityId: capability.id,
      rationale:
        'The customs-documentation capability is supplied at 0.4 against a requirement of 0.8 — compare closing the gap before the returns goal slips further.',
      evidenceObservationIds: observations.slice(0, 4).map((observation) => observation.id),
      alternatives: [
        {
          kind: 'recruit',
          summary: 'Recruit a governed customs-documentation agent package',
          note: 'drafts and verifies the document set automatically',
          estimatedCostMinor: 90_00,
          estimatedCostCurrency: 'USD',
          estimatedWeeks: 2,
          expectedLevel: 0.75,
          expectedCapacity: 500,
          recommended: true,
          agentPermissions: ['observe', 'analyze', 'recommend', 'ask'],
        },
        {
          kind: 'train',
          summary: 'Train the logistics coordinators on the document set',
          note: 'raises the human supply level over a quarter',
          estimatedCostMinor: 30_00,
          estimatedCostCurrency: 'USD',
          estimatedWeeks: 12,
          expectedLevel: 0.6,
          expectedCapacity: 100,
        },
        {
          kind: 'automate',
          summary: 'Automate the broker document exchange in the process',
          note: 'process automation opportunity from the returns-flow findings',
          estimatedCostMinor: 55_00,
          estimatedCostCurrency: 'USD',
          estimatedWeeks: 6,
          expectedLevel: 0.7,
          expectedCapacity: 300,
        },
      ],
    });
    await requestRecruitmentApproval(aurumAgentCtx, {
      proposalId: proposal.id,
      justification: 'W068 demo: the comparison recommends recruiting the governed agent package',
    });
    anchors.note('recruitment:customs-agent', true);
  } else {
    proposal = existingProposal;
    anchors.note('recruitment:customs-agent', false);
  }

  return {
    agent: { id: registered.agent.id, slug: registered.agent.slug, status: registered.agent.status },
    execution: { id: execution.id, status: execution.status },
    capability: { id: capability.id, name: capability.name },
    recruitmentProposal: { id: proposal.id, title: proposal.title, status: proposal.status },
  };
}

// ---------------------------------------------------------------------------
// Journey J — marketplace (vendor pipeline + the demo company's installs)
// ---------------------------------------------------------------------------

/** The deterministic extension manifest of the demo vendor. */
function demoManifestInput(version: string): RegisterExtensionManifestInput {
  return {
    extensionKey: 'returns-doc-classifier',
    version,
    manifestSchemaVersion: 1,
    displayName: 'Returns Document Classifier',
    description: 'Classifies customs-broker documents attached to returns cases.',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant' as const,
    uiSurfaces: ['control-tower-panel'],
    schedules: [{ name: 'nightly-classify', cron: '0 3 * * *' }],
    eventSubscriptions: ['returns.case.updated'],
    externalParticipants: [{ label: 'Broker Documents API', origin: 'https://api.broker-docs.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
  };
}

async function seedMarketplace(
  anchors: Anchors,
  developerCtx: TenantContext,
  platformPipelineCtx: TenantContext,
  managerCtx: TenantContext,
): Promise<DemoManifest['marketplace']> {
  // --- the vendor side (Cobalt Labs) --------------------------------------

  // v1 — the full governed chain to INSTALLABLE.
  const v1Manifest = await ensureManifest(anchors, developerCtx, '1.0.0');
  const v1Package = await ensurePackage(anchors, developerCtx, 'returns-doc-classifier', '1.0.0', v1Manifest.id);
  await driveChain(anchors, developerCtx, platformPipelineCtx, v1Package, 'installable');

  // v2 — submitted + verified, deliberately parked in PENDING_REVIEW (the
  // platform reviewer's deterministic queue item).
  const v2Manifest = await ensureManifest(anchors, developerCtx, '1.1.0');
  const v2Package = await ensurePackage(anchors, developerCtx, 'returns-doc-classifier', '1.1.0', v2Manifest.id);
  await driveChain(anchors, developerCtx, platformPipelineCtx, v2Package, 'pending-review');

  // An agent package through the same governance chain to INSTALLABLE.
  const agentPackage = await ensureAgentPackage(anchors, developerCtx);
  await driveChain(anchors, developerCtx, platformPipelineCtx, agentPackage, 'installable');

  // --- the demo company side (Meridian installs) ---------------------------

  const installed = await installExtension(anchors, managerCtx, v1Package);
  const installedAgent = await registerAgent(managerCtx, {
    slug: agentPackage.packageKey,
    displayName: 'Returns Negotiator',
    role: 'negotiate outstanding returns credits politely',
    description: 'The installed marketplace agent package (demo).',
    provider: 'langgraph',
    instructions: 'Be polite, be firm, escalate stuck cases to the operations manager.',
    permissions: ['observe', 'analyze', 'recommend', 'propose'],
  });
  anchors.note('marketplace:installed-agent', installedAgent.created);

  // The chains may have advanced the packages since they were loaded —
  // read the final states through the contract.
  const [v1Final, v2Final, agentFinal] = await Promise.all([
    getPackage(developerCtx, { packageId: v1Package.id }),
    getPackage(developerCtx, { packageId: v2Package.id }),
    getPackage(developerCtx, { packageId: agentPackage.id }),
  ]);

  return {
    installableExtension: {
      id: v1Final.id,
      packageKey: v1Final.packageKey,
      version: v1Final.version,
      state: v1Final.state,
    },
    pendingReview: {
      id: v2Final.id,
      packageKey: v2Final.packageKey,
      version: v2Final.version,
      state: v2Final.state,
    },
    installableAgent: {
      id: agentFinal.id,
      packageKey: agentFinal.packageKey,
      version: agentFinal.version,
      state: agentFinal.state,
    },
    installedExtensionKey: installed.key,
    installedExtensionState: installed.state,
    installedAgentSlug: installedAgent.agent.slug,
  };
}

async function ensureManifest(
  anchors: Anchors,
  developerCtx: TenantContext,
  version: string,
): Promise<{ id: string }> {
  const manifests = await listManifests(developerCtx, { extensionKey: 'returns-doc-classifier', limit: 100 });
  const existing = manifests.find((manifest) => manifest.version === version) ?? null;
  if (existing !== null) {
    anchors.note(`manifest:${version}`, false);
    return { id: existing.id };
  }
  const registered = await registerExtensionManifest(developerCtx, demoManifestInput(version));
  await runManifestVerification(developerCtx, { manifestId: registered.manifest.id });
  anchors.note(`manifest:${version}`, true);
  return { id: registered.manifest.id };
}

async function ensurePackage(
  anchors: Anchors,
  developerCtx: TenantContext,
  packageKey: string,
  version: string,
  manifestId: string,
): Promise<MarketplacePackage> {
  const packages = await listPackages(developerCtx, { limit: 200 });
  const existing = packages.find((pkg) => pkg.packageKey === packageKey && pkg.version === version) ?? null;
  if (existing !== null) {
    anchors.note(`package:${packageKey}@${version}`, false);
    return existing;
  }
  const pkg = await createPackage(developerCtx, { kind: 'extension', manifestId });
  anchors.note(`package:${packageKey}@${version}`, true);
  return pkg;
}

async function ensureAgentPackage(
  anchors: Anchors,
  developerCtx: TenantContext,
): Promise<MarketplacePackage> {
  const packageKey = 'returns-negotiator';
  const packages = await listPackages(developerCtx, { limit: 200 });
  const existing = packages.find((pkg) => pkg.packageKey === packageKey && pkg.version === '1.0.0') ?? null;
  if (existing !== null) {
    anchors.note(`package:${packageKey}@1.0.0`, false);
    return existing;
  }
  const pkg = await createPackage(developerCtx, {
    kind: 'agent',
    packageKey,
    version: '1.0.0',
    displayName: 'Returns Negotiator',
    description: 'Negotiates outstanding returns credits politely.',
    role: 'negotiate outstanding returns credits',
    instructions: 'Be polite, be firm, escalate stuck cases to the operations manager.',
    provider: 'langgraph',
    permissions: ['observe', 'analyze', 'recommend', 'propose'],
  });
  anchors.note(`package:${packageKey}@1.0.0`, true);
  return pkg;
}

/**
 * Drive one package along the governed chain until it reaches `target`
 * ('pending-review' stops after automated verification; 'installable' runs
 * the full platform decision + publication). Only performed transitions
 * count as created anchors — an already-advanced chain is reused as-is.
 */
async function driveChain(
  anchors: Anchors,
  developerCtx: TenantContext,
  platformPipelineCtx: TenantContext,
  pkg: MarketplacePackage,
  target: 'pending-review' | 'installable',
): Promise<void> {
  const fresh = await getPackage(developerCtx, { packageId: pkg.id });
  const before = fresh.state;
  let current = before;
  if (current === 'DRAFT') {
    await submitPackage(developerCtx, { packageId: pkg.id });
    current = 'SUBMITTED';
  }
  if (current === 'SUBMITTED') {
    await runAutomatedVerification(platformPipelineCtx, { packageId: pkg.id });
    current = 'PENDING_REVIEW';
  }
  if (target === 'pending-review') {
    anchors.note(`chain:${pkg.packageKey}@${pkg.version}`, before !== current);
    return;
  }
  if (current === 'PENDING_REVIEW') {
    await reviewPackage(platformPipelineCtx, {
      packageId: pkg.id,
      decision: 'approve',
      reason: 'W068 demo review: checks passed, permissions justified by the declaration',
    });
    current = 'APPROVED';
  }
  if (current === 'APPROVED') {
    await publishPackage(platformPipelineCtx, { packageId: pkg.id });
    current = 'PUBLISHED';
  }
  if (current === 'PUBLISHED') {
    await makePackageInstallable(platformPipelineCtx, { packageId: pkg.id });
    current = 'INSTALLABLE';
  }
  anchors.note(`chain:${pkg.packageKey}@${pkg.version}`, before !== current);
}

/**
 * The install composition — the same contract sequence the product's
 * install performs (register the frozen version in the company's own
 * registry → verify → activate → deploy with the narrowed grant).
 */
async function installExtension(
  anchors: Anchors,
  managerCtx: TenantContext,
  pkg: MarketplacePackage,
): Promise<{ key: string; state: string }> {
  const extensionKey = pkg.packageKey;
  const existing = await getExtension(managerCtx, { extensionKey }).catch(() => null);
  if (existing !== null) {
    anchors.note('marketplace:installed-extension', false);
    return { key: extensionKey, state: existing.lifecycleState };
  }

  const subject = isExtensionPackage(pkg) ? pkg.payload.subject : null;
  if (subject === null) {
    throw new DemoError('seed_conflict', 'the demo extension package payload is not an extension payload');
  }
  const registered = await registerExtensionManifest(managerCtx, {
    extensionKey,
    version: pkg.version,
    manifestSchemaVersion: subject.manifestSchemaVersion,
    displayName: pkg.displayName,
    description: pkg.description,
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
  await runManifestVerification(managerCtx, { manifestId: registered.manifest.id });
  const activation = await transitionExtension(managerCtx, {
    extensionKey,
    transition: 'activate',
    idempotencyKey: `${KEY_PREFIX}:extension-activate:${pkg.id}`,
  });
  if (!activation.applied) {
    throw new DemoError(
      'seed_conflict',
      `the demo extension activation is waiting on the approval gate (${activation.gate.actionRequestId}) — decide it and re-run the seed`,
    );
  }
  const deploy = await deployExtensionVersion(managerCtx, {
    extensionKey,
    manifestId: registered.manifest.id,
    installKey: 'default',
    grantedPermissions: ['state:read', 'state:write'],
    idempotencyKey: `${KEY_PREFIX}:extension-deploy:${pkg.id}`,
  });
  if (!deploy.applied) {
    throw new DemoError(
      'seed_conflict',
      `the demo extension deployment is waiting on the approval gate (${deploy.gate.actionRequestId}) — decide it and re-run the seed`,
    );
  }
  const extension = await getExtension(managerCtx, { extensionKey });
  anchors.note('marketplace:installed-extension', true);
  return { key: extensionKey, state: extension.lifecycleState };
}

// ---------------------------------------------------------------------------
// Journey K — the audit trail of the consequential decision
// ---------------------------------------------------------------------------

async function seedAudit(
  anchors: Anchors,
  managerCtx: TenantContext,
  rewardApprovalId: string | null,
): Promise<DemoManifest['auditRecords']> {
  if (rewardApprovalId !== null) {
    const existing = await listAuditRecords(managerCtx, { correlationId: KEYS.rewardAudit, limit: 10 });
    if (existing.length === 0) {
      await recordAudit(managerCtx, {
        subjectKind: AUDIT_SUBJECT_ACTION_REQUEST,
        subjectId: rewardApprovalId,
        event: 'demo-seed.reward-approved',
        chainStage: 'approval',
        correlationId: KEYS.rewardAudit,
        summary:
          'The manager approved the employee’s knowledge-contribution reward after the measured mission impact (W068 deterministic demo decision).',
        detail: { rewardApprovalId, note: 'decided through the actions contract with separation of duties' },
      });
      anchors.note('audit:reward-decision', true);
    } else {
      anchors.note('audit:reward-decision', false);
    }
  }
  return (await listAuditRecords(managerCtx, { correlationId: KEYS.rewardAudit, limit: 10 })).map((record) => ({
    id: record.id,
    subjectKind: record.subject.kind,
    chainStage: record.chainStage,
  }));
}

// ---------------------------------------------------------------------------
// Journey L — developer integration (API key + webhook)
// ---------------------------------------------------------------------------

async function seedDeveloperIntegration(
  anchors: Anchors,
  managerCtx: TenantContext,
): Promise<{
  apiKey: DemoManifest['apiKey'];
  webhook: DemoManifest['webhook'];
}> {
  const keyLabel = 'Demo warehouse integration';
  let apiKey = (await listApiKeys(managerCtx)).find((key) => key.label === keyLabel) ?? null;
  if (apiKey === null) {
    await createApiKey(managerCtx, {
      label: keyLabel,
      scopes: ['goals:read', 'missions:read', 'approvals:read', 'evidence:read'],
      authority: [],
    });
    anchors.note('api-key:warehouse', true);
    apiKey = (await listApiKeys(managerCtx)).find((key) => key.label === keyLabel) ?? null;
  } else {
    anchors.note('api-key:warehouse', false);
  }

  const webhookLabel = 'Demo warehouse events';
  let webhook =
    (await listWebhookSubscriptions(managerCtx)).find((subscription) => subscription.label === webhookLabel) ??
    null;
  if (webhook === null) {
    const subscription = await createWebhookSubscription(managerCtx, {
      label: webhookLabel,
      url: 'https://demo.meridian.example/hooks/aurum-events',
      eventTypes: ['goal.*', 'mission.*'],
      secretRef: 'secret-store://demo/webhook/aurum-events',
      maxAttempts: 5,
    });
    setApiWebhookTransport(webhookTransport);
    try {
      await sendWebhookTest(managerCtx, { subscriptionId: subscription.id });
    } finally {
      setApiWebhookTransport(null);
    }
    anchors.note('webhook:warehouse-events', true);
    webhook = subscription;
  } else {
    anchors.note('webhook:warehouse-events', false);
  }

  return {
    apiKey: apiKey === null ? null : { id: apiKey.id, label: apiKey.label, status: apiKey.status },
    webhook:
      webhook === null
        ? null
        : { id: webhook.id, label: webhook.label, url: webhook.url, status: webhook.status },
  };
}
