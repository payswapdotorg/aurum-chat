// W068 — the demo harness's type surface. Pure shapes: no I/O, no
// framework imports (rule (a) of scripts/check-architecture.ts).

/** The four demo roles of W068, in catalog order. */
export type DemoRole = 'manager' | 'employee' | 'developer' | 'platform-reviewer';

/** How a role's authority reaches the product surface. */
export type DemoCapabilityVia =
  /** Derivable from the role's verified tenant session (W058 claims). */
  | 'session'
  /** Exercisable only through an explicit platform-pipeline context (a
   *  platform claim that, by the frozen auth design, never rides a tenant
   *  session — the harness supplies the context for verification). */
  | 'platform-pipeline';

/**
 * One capability of the product surface, expressed the way the product
 * actually gates it: an authority claim (or none) plus a browser route.
 * The catalog mirrors the REAL product vocabulary (the W057 product
 * areas, the W064 marketplace destinations and the authority-gated
 * operations behind them) — it never invents capabilities.
 */
export interface DemoCapability {
  /** Stable catalog key (part of the tested contract). */
  key: string;
  /** Human label (browser verification copy). */
  label: string;
  /** The browser route where the capability is visible/exercised. */
  href: string;
  /** The authority claims a session must carry to use the capability. */
  requiredClaims: readonly string[];
  /**
   * True when the capability rides a platform claim that never appears on
   * a tenant session (auth/claims.ts) — the pipeline context is the only
   * honest way to exercise it at this base.
   */
  platformClaim: boolean;
  /** Why the capability exists / what journey it serves. */
  rationale: string;
}

/** A capability's visibility for one demo role. */
export interface DemoCapabilityVisibility {
  key: string;
  label: string;
  href: string;
  /** Whether the role can see and exercise the capability. */
  visible: boolean;
  /** How the capability is reached (session claims or platform pipeline). */
  via: DemoCapabilityVia | null;
  /** Why the role does (or does not) see it — plain words, test-asserted. */
  note: string;
}

/** The deterministic account specification of one demo role. */
export interface DemoAccountSpec {
  role: DemoRole;
  displayName: string;
  email: string;
  /** The demo company the account belongs to. */
  company: DemoCompanyId;
  /** The verified tenant role the account holds in that company. */
  tenantRole: 'owner' | 'admin' | 'member';
  /** What this persona verifies in the browser (journey coverage). */
  purpose: string;
}

/** The three demo companies, keyed by their harness role. */
export type DemoCompanyId = 'company' | 'vendor' | 'platform';

/** One demo company's deterministic specification. */
export interface DemoCompanySpec {
  id: DemoCompanyId;
  name: string;
  defaultWorkspaceName: string;
  /** Who the company exists for. */
  purpose: string;
}

/** The resolved account of one demo role after seeding (real ids). */
export interface DemoAccountRef {
  role: DemoRole;
  email: string;
  displayName: string;
  principalId: string;
  companyId: DemoCompanyId;
  tenantId: string;
  tenantName: string;
  tenantRole: 'owner' | 'admin' | 'member';
}

/** The journey anchors of the seeded dataset (real record ids). */
export interface DemoManifest {
  /** When this seed run completed (wall clock — informational only). */
  seededAt: string;
  accounts: Record<DemoRole, DemoAccountRef>;
  companies: Record<DemoCompanyId, { tenantId: string; name: string; workspaces: { id: string; name: string }[] }>;
  /** Journey A — onboarding: the pending invite for the next employee. */
  invite: { email: string; status: string } | null;
  /** Journey B — chat: the deterministic conversation and its turns. */
  conversation: { id: string; title: string; messageCount: number } | null;
  /** Journey C/D — intelligence: goals → unknown → mission → belief. */
  goals: { id: string; title: string; priority: string }[];
  unknown: { id: string; question: string; status: string } | null;
  mission: { id: string; title: string; status: string } | null;
  belief: { id: string; proposition: string; status: string } | null;
  claim: { id: string; proposition: string } | null;
  /** Journey D — process intelligence (evidence-cited findings). */
  process: { id: string; name: string; version: number; findingCount: number } | null;
  /** Journey E — approvals: the pending human gate the manager decides. */
  pendingApprovals: { id: string; actionKind: string; authorityLevel: string }[];
  decidedApprovals: { id: string; actionKind: string; decision: string }[];
  /** Journey F — contribution + reward (the employee's knowledge loop). */
  contribution: { id: string; status: string; summary: string } | null;
  reward: { id: string; status: string; kind: string } | null;
  /** Journey G — connections. */
  channelConnections: { provider: string; displayName: string; status: string }[];
  sources: { id: string; provider: string; displayName: string | null }[];
  destinations: { id: string; provider: string; displayName: string | null }[];
  /** Journey H — BYOA (the tenant's AI provider account + one execution). */
  llmAccount: { id: string; provider: string; label: string; status: string } | null;
  llmExecution: { id: string; status: string; model: string } | null;
  /** Journey I — agents (definition + succeeded execution + recruitment). */
  agent: { id: string; slug: string; status: string } | null;
  agentExecution: { id: string; status: string } | null;
  capability: { id: string; name: string } | null;
  recruitmentProposal: { id: string; title: string; status: string } | null;
  /** Journey J — marketplace (vendor pipeline + installed packages). */
  marketplace: {
    installableExtension: { id: string; packageKey: string; version: string; state: string } | null;
    pendingReview: { id: string; packageKey: string; version: string; state: string } | null;
    installableAgent: { id: string; packageKey: string; version: string; state: string } | null;
    installedExtensionKey: string | null;
    installedExtensionState: string | null;
    installedAgentSlug: string | null;
  };
  /** Journey K — evidence/audit trail of the consequential decisions. */
  auditRecords: { id: string; subjectKind: string; chainStage: string }[];
  /** Journey L — developer integration (API key + webhook). */
  apiKey: { id: string; label: string; status: string } | null;
  webhook: { id: string; label: string; url: string; status: string } | null;
}

/** What `seedDemoHarness` did: which anchors it created vs reused. */
export interface DemoSeedReport {
  /** 'created' — at least one anchor was newly seeded this run. */
  status: 'created' | 'present';
  /** The anchors newly created this run (stable keys, for evidence). */
  createdAnchors: string[];
  /** The anchors that already existed and were reused unchanged. */
  reusedAnchors: string[];
  /** The full dataset manifest (real record ids for browser verification). */
  manifest: DemoManifest;
}
