// W070 — the walkable journey matrix (desktop + mobile viewports render
// the same server HTML; the viewport-specific navigation proof is the
// mobile suite's job). Every journey of the work item's acceptance list
// is walked here, through the REAL surface code:
//
//   * pages render through the real page components + layouts (the SSR
//     harness) and the assertions check the content the browser sees;
//   * the interactive steps (send a chat turn, decide the proposal,
//     activate the agent, connect a channel, exercise BYOA, create and
//     revoke an API key) go through the real API handler libraries with
//     the persona's session cookie — the same thin-adapter functions the
//     route.ts files delegate to (IMPLEMENTATION-STACK §5);
//   * the walk FOLLOWS REAL ROUTES AND LINKS: hrefs asserted on are
//     extracted from the rendered HTML of the previous step
//     (extractPageLinks), and thread-level navigation uses the surface's
//     documented deep-link contract (`/chat?c=<id>`).
//
// The deterministic W068 demo world provides every journey's data; the
// seeded anchors (via the seed report) give the concrete record ids.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anchorId,
  apiRequest,
  demoWorld,
  renderOk,
  shutdownWorld,
  signInPersona,
  type DemoSeedReport,
  type PersonaSession,
} from './harness';
import { extractPageLinks } from '../../../src/modules/journey-proof/contract';
import {
  handleChatApprovalDecidePost,
  handleChatSendPost,
  handleChatStateGet,
} from '../../../src/app/(product)/chat/lib/chat-api';
import {
  handleProposalActivatePost,
  handleProposalDecidePost,
} from '../../../src/app/(product)/interventions/lib/api';
import { handleTowerSurfaceGet } from '../../../src/app/(tower)/lib/api';
import {
  handleConnectionsAction,
  handleConnectionsGet,
} from '../../../src/app/(product)/connections/lib/api';
import { handleAiAction } from '../../../src/app/(product)/ai/lib/api';
import { handleDeveloperAction } from '../../../src/app/(product)/developer/lib/api';

let report: DemoSeedReport;
let manager: PersonaSession;
let employee: PersonaSession;
let developer: PersonaSession;

beforeAll(async () => {
  report = await demoWorld();
  manager = await signInPersona('manager');
  employee = await signInPersona('employee');
  developer = await signInPersona('developer');
});

afterAll(async () => {
  await shutdownWorld();
});

/** The in-content links of a rendered page, query/hash-stripped. */
function linksOf(html: string): Set<string> {
  return new Set(
    extractPageLinks(html, '/').map((link) => link.resolved.split('?')[0] ?? link.resolved),
  );
}

// ---------------------------------------------------------------------------
// Journey B — manager chat
// ---------------------------------------------------------------------------

describe('Journey B — manager chat', () => {
  const CONVERSATION_TITLE = 'Wholesale freshness — Aurum';
  let conversationId: string;

  it('opens the conversation area from the shell navigation', async () => {
    const { html } = await renderOk('/chat', manager);
    expect(html).toContain(CONVERSATION_TITLE);
    expect(html).toContain('What needs my attention?'); // the discovery starters
    expect(html).toContain('Harbor Grocery'); // the seeded answer preview
    conversationId = anchorId(report, 'employee-chat', 'conversation-freshness');
  });

  it('opens the seeded thread by its deep link and sees the evidence-backed turns', async () => {
    const { html } = await renderOk(`/chat?c=${conversationId}`, manager);
    expect(html).toContain('Aurum, why did our wholesale freshness score drop this month?');
    expect(html).toContain('Harbor Grocery (86%) and Nordic Caf'); // the evidence-backed answer
    expect(html).toContain('customs-broker'); // the reasoning pointer
  });

  it('asks a question through the composer API and receives the real workflow reply', async () => {
    const body = {
      conversationId,
      text: 'What needs my attention?',
      starterId: 'attention',
    };
    const result = await handleChatSendPost(
      apiRequest('/api/product/chat/messages', manager, { body }),
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['chat']).toBe('turn');
      expect(result.body['conversationId']).toBe(conversationId);
      expect(typeof result.body['executionId']).toBe('string'); // a real cognition cycle ran
      const reply = result.body['reply'] as {
        text?: string;
        answer?: { cards?: { href?: string }[] };
      } | undefined;
      expect(reply && typeof reply.text === 'string' && reply.text.length > 0).toBe(true);
      // The attention answer carries approval cards deep-linked into
      // management mode (the conversation → tower bridge).
      const cardHrefs = (reply?.answer?.cards ?? []).map((card) => card.href);
      expect(cardHrefs).toContain('/approvals');
    }
  });

  it('sees the new turn — and its management deep links — in the rendered timeline', async () => {
    const { html } = await renderOk(`/chat?c=${conversationId}`, manager);
    expect(html).toContain('What needs my attention?');
    const links = linksOf(html);
    expect(links.has('/approvals')).toBe(true); // the approval card's deep link
  });

  it('sees the new turns in the polled conversation state', async () => {
    const result = await handleChatStateGet(
      apiRequest(`/api/product/chat/state?conversationId=${conversationId}`, manager),
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      const view = result.body['view'] as { thread?: { messages?: { text: string }[] } };
      const texts = (view.thread?.messages ?? []).map((message) => message.text).join('\n');
      expect(texts).toContain('What needs my attention?');
    }
  });
});

// ---------------------------------------------------------------------------
// Journey B — employee chat
// ---------------------------------------------------------------------------

describe('Journey B — employee chat', () => {
  it('opens the same conversation surface as a plain member (no management claims)', async () => {
    const { html } = await renderOk('/chat', employee);
    expect(html).toContain('Wholesale freshness — Aurum');
  });

  it('reads the seeded thread by its deep link', async () => {
    const conversationId = anchorId(report, 'employee-chat', 'conversation-freshness');
    const { html } = await renderOk(`/chat?c=${conversationId}`, employee);
    expect(html).toContain('Aurum, why did our wholesale freshness score drop this month?');
  });

  it('asks a question through the composer API (deterministic answer, member-scoped)', async () => {
    const body = { text: "What don't we know?" };
    const result = await handleChatSendPost(
      apiRequest('/api/product/chat/messages', employee, { body }),
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['chat']).toBe('turn');
      const reply = result.body['reply'] as { text?: string } | undefined;
      expect(reply && typeof reply.text === 'string' && reply.text.length > 0).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Journey C — goal → unknown → mission
// ---------------------------------------------------------------------------

describe('Journey C — goal → unknown → mission', () => {
  const GOAL_TITLE = 'Keep wholesale delivery freshness above 92%';
  let goalId: string;
  let unknownId: string;
  let missionId: string;

  it('opens the Intelligence briefing and finds the goal chain entry', async () => {
    const { html } = await renderOk('/intelligence', manager);
    expect(html).toContain(GOAL_TITLE);
    expect(html).toContain('What Aurum found on its own'); // the proactive briefing
    const links = linksOf(html);
    goalId = anchorId(report, 'unprompted-discovery', 'goal-freshness');
    expect(links.has(`/intelligence/goals/${goalId}`)).toBe(true);
  });

  it('walks the goal chain: gaps, the promoted unknown and the mission', async () => {
    const { html } = await renderOk(`/intelligence/goals/${goalId}`, manager);
    unknownId = anchorId(report, 'unprompted-discovery', 'unknown-freshness');
    missionId = anchorId(report, 'unprompted-discovery', 'mission-freshness');
    const links = linksOf(html);
    expect(links.has(`/intelligence/unknowns/${unknownId}`)).toBe(true);
    expect(links.has(`/intelligence/missions/${missionId}`)).toBe(true);
  });

  it('opens the unknown: why it matters, and the mission that closes it', async () => {
    const { html } = await renderOk(`/intelligence/unknowns/${unknownId}`, manager);
    expect(html.toLowerCase()).toContain('consequence');
    const links = linksOf(html);
    expect(links.has(`/intelligence/missions/${missionId}`)).toBe(true);
  });

  it('opens the mission: the knowledge objective and the chain upward', async () => {
    const { html } = await renderOk(`/intelligence/missions/${missionId}`, manager);
    expect(html).toContain(GOAL_TITLE);
    const links = linksOf(html);
    expect(links.has(`/intelligence/goals/${goalId}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Journey K — evidence & explainability
// ---------------------------------------------------------------------------

describe('Journey K — evidence & explainability', () => {
  let executionId: string;

  it('opens the explainability index', async () => {
    const { html } = await renderOk('/explain', manager);
    executionId = anchorId(report, 'consequential-approval', 'cognition-execution');
    const links = linksOf(html);
    expect(links.has(`/explain/execution/${executionId}`)).toBe(true);
  });

  it('explains the seeded decision cycle end to end', async () => {
    const { html } = await renderOk(`/explain/execution/${executionId}`, manager);
    // The causal chain renders its spine: the trigger (June's question),
    // the immutable evidence (with the retained contradiction), and the
    // derived understanding.
    expect(html).toContain('June Park');
    expect(html).toContain('Evidence');
    expect(html).toContain('Claims');
    expect(html).toContain(
      'disagree on the October fleet-average freshness',
    ); // contradiction display (W065 acceptance)
    // And the reconstruction links the whole decision flow.
    const links = linksOf(html);
    expect([...links].some((href) => href.startsWith('/explain/correlation/'))).toBe(true);
  });

  it('explains an action request too (the second anchor kind)', async () => {
    const requestId = anchorId(report, 'consequential-approval', 'approval-history');
    const { html } = await renderOk(`/explain/action/${requestId}`, manager);
    expect(html).toMatch(/employee[ -]?messaging/i);
  });
});

// ---------------------------------------------------------------------------
// Journey E — recommendation → approval → outcome
// ---------------------------------------------------------------------------

describe('Journey E — recommendation → approval → outcome', () => {
  let proposalId: string;
  let pendingRequestId: string;
  let activatedAgentId: string;

  it('opens the interventions surface: the gap and its pending recommendation', async () => {
    const { html } = await renderOk('/interventions', manager);
    expect(html).toContain('cold-chain-logistics');
    proposalId = anchorId(report, 'agent-recruitment', 'recruitment-proposal');
    const links = linksOf(html);
    expect(links.has(`/interventions/proposals/${proposalId}`)).toBe(true);
  });

  it('opens the proposal: compared alternatives, waiting at the gate', async () => {
    const { html } = await renderOk(`/interventions/proposals/${proposalId}`, manager);
    expect(html).toContain('The compared alternatives');
    expect(html).toContain('Waiting for a human decision');
  });

  it('approves the proposal through the decision API (human-authorized)', async () => {
    const body = { decision: 'approve', note: 'the cold-chain gap justifies the recruitment' };
    const result = await handleProposalDecidePost(
      apiRequest(`/api/product/interventions/proposals/${proposalId}/decide`, manager, { body }),
      proposalId,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['interventions']).toBe('proposal-decision');
    }
  });

  it('activates the approved intervention — the outcome the surfaces track', async () => {
    const body = {
      slug: 'cold-chain-coordinator',
      displayName: 'Cold-chain Coordinator',
      role: 'cold-chain coordinator',
      description: 'Coordinates customs paperwork for wholesale cold-chain shipments',
      provider: 'langgraph',
      instructions:
        'Track courier customs-broker paperwork and flag delays before the cold chain waits.',
      permissions: ['observe', 'analyze', 'recommend'],
    };
    const result = await handleProposalActivatePost(
      apiRequest(`/api/product/interventions/proposals/${proposalId}/activate`, manager, { body }),
      proposalId,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['interventions']).toBe('agent-activation');
      const agent = result.body['agent'] as { id?: string } | undefined;
      expect(agent?.id).toBeTruthy();
      activatedAgentId = agent?.id ?? '';
    }
  });

  it('sees the activated agent on its own page (the lifecycle surface)', async () => {
    const { html } = await renderOk(`/interventions/agents/${activatedAgentId}`, manager);
    expect(html).toContain('Cold-chain Coordinator');
  });

  it('decides the pending approval inline from the conversation (the chat gate)', async () => {
    // The seeded pending request: the follow-up question the cognition
    // cycle proposed (employee-messaging, ASK authority).
    const pending = report.pendingApprovals.find(
      (request) => request.actionKind === 'employee-messaging',
    );
    expect(pending).toBeDefined();
    pendingRequestId = pending!.requestId;
    const body = { decision: 'approve', note: 'ask June — she has the courier context' };
    const result = await handleChatApprovalDecidePost(
      apiRequest(`/api/product/chat/approvals/${pendingRequestId}/decide`, manager, { body }),
      pendingRequestId,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['chat']).toBe('approval-decision');
    }
  });

  it('sees the decisions in the tower Approvals surface with their trails', async () => {
    const { html } = await renderOk('/approvals', manager);
    expect(html).toMatch(/employee[ -]?messaging/i);
    expect(html.toLowerCase()).toContain('decided');
  });

  it('reads the approvals surface through the tower API as well (the management seam)', async () => {
    const result = await handleTowerSurfaceGet(
      apiRequest('/api/tower/approvals', manager),
      'approvals',
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['surface']).toBe('approvals');
    }
  });
});

// ---------------------------------------------------------------------------
// Journey F — learning contribution & reward
// ---------------------------------------------------------------------------

describe('Journey F — learning contribution & reward', () => {
  it('opens the learning surface as the employee: requests, contributions, rewards', async () => {
    const { html } = await renderOk('/learning', employee);
    // The knowledge request Aurum planned (the ask-person acquisition).
    expect(html).toContain('June Park');
    // The validated contribution, acknowledged.
    expect(html).toContain('The courier customs-broker change in September');
    // The reward state.
    expect(html.toLowerCase()).toContain('recognition');
  });

  it('links the contribution to its mission and the reward to the approval gate', async () => {
    const { html } = await renderOk('/learning', employee);
    const links = linksOf(html);
    const missionId = anchorId(report, 'unprompted-discovery', 'mission-freshness');
    expect(links.has(`/intelligence/missions/${missionId}`)).toBe(true);
    expect(links.has('/approvals')).toBe(true);
    expect(links.has('/evidence')).toBe(true);
  });

  it('shows the same learning state to the manager (visibility without leakage)', async () => {
    const { html } = await renderOk('/learning', manager);
    expect(html).toContain('The courier customs-broker change in September');
  });
});

// ---------------------------------------------------------------------------
// Journey G — connections
// ---------------------------------------------------------------------------

describe('Journey G — connections', () => {
  it('opens the connection hub: the three families with the seeded state', async () => {
    const { html } = await renderOk('/connections', manager);
    expect(html).toContain('WhatsApp');
    expect(html).toContain('Slack');
    expect(html).toContain('HubSpot');
    expect(html).toContain('Stripe');
    expect(html).toContain('Google Sheets');
  });

  it('looks up the verified employee identity in the identity mapping', async () => {
    const { html } = await renderOk(
      '/connections?identity_provider=web&identity_account=june.park',
      manager,
    );
    expect(html).toContain('June Park');
    expect(html.toLowerCase()).toContain('verified');
  });

  it('registers a new channel connection through the hub API and sees it in the hub', async () => {
    const body = {
      action: 'channel.register',
      provider: 'telegram',
      providerAccountId: '10425512', // Telegram accounts are numeric user ids
      displayName: 'Meridian Ops (Telegram)',
      credentialRef: 'secret-store://telegram-meridian-demo',
    };
    const result = await handleConnectionsAction(
      apiRequest('/api/connections', manager, { body }),
      body,
    );
    expect(result.status).toBe(200);
    const readBack = await handleConnectionsGet(apiRequest('/api/connections', manager));
    expect(readBack.status).toBe(200);
    if (readBack.status === 200) {
      const view = JSON.stringify(readBack.body);
      expect(view).toContain('Meridian Ops (Telegram)');
      expect(view).toContain('10425512');
    }
  });
});

// ---------------------------------------------------------------------------
// Journey H — BYOA
// ---------------------------------------------------------------------------

describe('Journey H — BYOA (configure AI)', () => {
  it('opens the AI providers surface: both tenant-owned accounts, no provider privileged', async () => {
    const { html } = await renderOk('/ai', manager);
    expect(html).toContain('Meridian OpenAI (demo)');
    expect(html).toContain('Anthropic'); // the second provider account
  });

  it('exercises a provider action through the surface API (availability)', async () => {
    const accountId = anchorId(report, 'configure-ai', 'llm-account-openai');
    const body = {
      action: 'availability.set',
      accountId,
      model: 'gpt-4o-mini',
      state: 'available',
      reason: 'journey proof availability set',
      expiresAt: null,
    };
    const result = await handleAiAction(apiRequest('/api/product/ai', manager, { body }), body);
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Journey I — agent recruitment
// ---------------------------------------------------------------------------

describe('Journey I — agent recruitment', () => {
  it('sees the capability gap and the live agent in the interventions home', async () => {
    const { html } = await renderOk('/interventions', manager);
    expect(html).toContain('cold-chain-logistics'); // the gap
    expect(html).toContain('Freshness Monitor'); // the live agent
  });

  it('opens the live agent’s page: budget, permissions, lifecycle', async () => {
    const agentId = anchorId(report, 'agent-recruitment', 'agent-freshness-monitor');
    const { html } = await renderOk(`/interventions/agents/${agentId}`, manager);
    expect(html).toContain('Freshness Monitor');
    expect(html).toContain('langgraph');
    const links = linksOf(html);
    expect(links.size).toBeGreaterThan(0);
  });

  it('opens the recruitment proposal with explicit alternatives and uncertainty', async () => {
    const proposalId = anchorId(report, 'agent-recruitment', 'recruitment-proposal');
    const { html } = await renderOk(`/interventions/proposals/${proposalId}`, manager);
    expect(html).toContain('The compared alternatives');
  });
});

// ---------------------------------------------------------------------------
// Journey J — marketplace
// ---------------------------------------------------------------------------

describe('Journey J — marketplace', () => {
  let vendorPackageId: string;

  it('browses the public catalog (anonymous visitors included)', async () => {
    const { html } = await renderOk('/marketplace', null);
    expect(html).toContain('Roast Batch Tracker');
    vendorPackageId = anchorId(report, 'marketplace', 'vendor-package');
    const links = linksOf(html);
    expect(links.has(`/marketplace/package/${vendorPackageId}`)).toBe(true);
  });

  it('opens the package page and inspects permissions and governance', async () => {
    const { html } = await renderOk(`/marketplace/package/${vendorPackageId}`, manager);
    expect(html).toContain('Roast Batch Tracker');
    expect(html.toLowerCase()).toContain('permission');
  });

  it('opens the installed packages: the governed extension', async () => {
    const { html } = await renderOk('/marketplace/installed', manager);
    expect(html).toContain('roast-batch-tracker');
    const links = linksOf(html);
    expect(links.has('/marketplace/installed/roast-batch-tracker')).toBe(true);
  });

  it('opens the installed extension’s governance page', async () => {
    const { html } = await renderOk('/marketplace/installed/roast-batch-tracker', manager);
    expect(html).toContain('roast-batch-tracker');
  });

  it('opens the developer console: the company’s own package pending review', async () => {
    const { html } = await renderOk('/marketplace/developer', developer);
    expect(html).toContain('Freshness ETag Reader');
    expect(html.toLowerCase()).toContain('pending');
  });
});

// ---------------------------------------------------------------------------
// Journey L — developer, API & MCP
// ---------------------------------------------------------------------------

describe('Journey L — developer, API & MCP', () => {
  it('opens the developer console: the seeded key, webhook and MCP guide', async () => {
    const { html } = await renderOk('/developer', developer);
    expect(html).toContain('meridian-ops-integration');
    expect(html).toContain('Ops webhook');
    expect(html.toUpperCase()).toContain('MCP');
  });

  it('creates an API key through the console API', async () => {
    const body = { action: 'key.create', label: 'journey-proof-key', scopes: ['goals:read'] };
    const result = await handleDeveloperAction(
      apiRequest('/api/product/developer', developer, { body }),
      body,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      const view = JSON.stringify(result.body);
      expect(view).toContain('journey-proof-key');
    }
  });

  it('revokes the key it created (auditable lifecycle)', async () => {
    const createBody = {
      action: 'key.create',
      label: 'journey-proof-revoke-me',
      scopes: ['goals:read'],
    };
    const created = await handleDeveloperAction(
      apiRequest('/api/product/developer', developer, { body: createBody }),
      createBody,
    );
    expect(created.status).toBe(200);
    const result = (created.body as { result?: { apiKey?: { id?: string } } }).result;
    const keyId = result?.apiKey?.id;
    expect(keyId).toBeTruthy();
    const revokeBody = { action: 'key.revoke', keyId };
    const revoked = await handleDeveloperAction(
      apiRequest('/api/product/developer', developer, { body: revokeBody }),
      revokeBody,
    );
    expect(revoked.status).toBe(200);
  });
});
