// Management Control Tower (W033) — the Agents view.
//
// The agent workforce (W021 — the Agent Gateway): persistent definitions
// (organizational actors with explicit contracts, permissions and
// providers, lock 22) and their recent executions (async, policy-gated,
// evidence- and cost-carrying). Provider-neutral by construction — the
// tower never sees a provider object (lock 24). The full lifecycle
// surfaces (recruitment W022, teams W023, evaluation W024) are not
// delivered at this base.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listAgentExecutions, listAgents } from '@/modules/agents/contract';
import type {
  AgentDefinition,
  AgentExecution,
} from '@/modules/agents/contract';

const AGENT_CAP = 100;
const EXECUTION_CAP = 50;

export interface AgentCard {
  id: string;
  slug: string;
  displayName: string | null;
  role: string;
  provider: AgentDefinition['provider'];
  permissions: AgentDefinition['permissions'];
  status: AgentDefinition['status'];
  updatedAt: string;
}

export interface AgentExecutionItem {
  id: string;
  agentSlug: string | null;
  status: AgentExecution['status'];
  authorityLevel: AgentExecution['authorityLevel'];
  attemptsCount: number;
  costMinor: number;
  costCurrency: AgentExecution['costCurrency'];
  submittedAt: string;
  errorCode: string | null;
}

export interface AgentsView {
  generatedAt: string;
  definitions: { total: number; items: AgentCard[] };
  executions: { total: number; items: AgentExecutionItem[] };
}

/** Build the Agents view (definitions + recent executions). */
export async function buildAgentsView(ctx: TenantContext): Promise<AgentsView> {
  const [agents, executions] = await Promise.all([
    listAgents(ctx, { limit: AGENT_CAP }),
    listAgentExecutions(ctx, { limit: EXECUTION_CAP }),
  ]);
  const slugById = new Map(agents.map((agent) => [agent.id, agent.slug]));
  return {
    generatedAt: now().toISOString(),
    definitions: {
      total: agents.length,
      items: agents.map((agent: AgentDefinition) => ({
        id: agent.id,
        slug: agent.slug,
        displayName: agent.displayName,
        role: agent.role,
        provider: agent.provider,
        permissions: agent.permissions,
        status: agent.status,
        updatedAt: agent.updatedAt,
      })),
    },
    executions: {
      total: executions.length,
      items: executions.map((execution: AgentExecution) => ({
        id: execution.id,
        agentSlug: slugById.get(execution.agentId) ?? null,
        status: execution.status,
        authorityLevel: execution.authorityLevel,
        attemptsCount: execution.attemptsCount,
        costMinor: execution.costMinor,
        costCurrency: execution.costCurrency,
        submittedAt: execution.submittedAt,
        errorCode: execution.errorCode,
      })),
    },
  };
}
