// ============================================================================
// mcp/tools/epistemics — MCP tools over the epistemics contract (W039).
//
// ARCHITECTURE.md §23: MCP "may expose authorized operations such as
// querying company knowledge ... unknowns ... reviewing findings". The
// epistemics surface is the company's knowledge layer (W007): claims
// (immutable evidence-derived propositions), beliefs (versioned working
// understanding) and unknowns (consequential gaps — lock 7). All three
// tools are READ class (matrix evaluation 'mcp.read' @ OBSERVE) and call
// exactly one contract operation each.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import {
  getBelief,
  listBeliefs,
  listClaims,
  listUnknowns,
} from '@/modules/epistemics/contract';
import type {
  Belief,
  BeliefStatus,
  Claim,
  Unknown,
  UnknownStatus,
} from '@/modules/epistemics/contract';
import type { ToolDefinition } from '../types';
import {
  optionalEnum,
  optionalListLimit,
  optionalString,
  optionalUuid,
  requireArgsObject,
  requireUuid,
  rejectUnknownKeys,
} from '../validation';

const UNKNOWN_STATUS_VALUES = ['open', 'resolved'] as const;
const BELIEF_STATUS_VALUES = ['active', 'retired'] as const;

const LIST_UNKNOWN_ARGS = ['status', 'subjectKind', 'subjectId', 'limit'] as const;
const LIST_BELIEFS_ARGS = ['status', 'subjectKind', 'subjectId', 'limit'] as const;
const LIST_CLAIMS_ARGS = ['subjectKind', 'subjectId', 'evidenceObservationId', 'limit'] as const;
const GET_BELIEF_ARGS = ['beliefId', 'asOf'] as const;

function unknownSummary(unknown: Unknown): { unknownId: string; question: string; status: string } {
  return { unknownId: unknown.id, question: unknown.question, status: unknown.status };
}

function beliefSummary(belief: Belief): {
  beliefId: string;
  proposition: string;
  version: number;
} {
  return {
    beliefId: belief.id,
    proposition: belief.statement.proposition,
    version: belief.version,
  };
}

function claimSummary(claim: Claim): { claimId: string; proposition: string } {
  return { claimId: claim.id, proposition: claim.proposition };
}

export const epistemicsTools: ToolDefinition[] = [
  {
    name: 'list_unknowns',
    title: 'List knowledge gaps (unknowns)',
    description:
      "List the tenant's first-class unknowns: questions Aurum cannot answer plus why the gap " +
      'matters (the consequence), filtered by status and subject. Unknowns are the input to ' +
      "learning missions. Read capability over the epistemics module (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...UNKNOWN_STATUS_VALUES],
          description: 'Filter by resolution status (default: all).',
        },
        subjectKind: { type: 'string', description: 'Filter by subject kind.' },
        subjectId: { type: 'string', format: 'uuid', description: 'Filter by subject id.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 100).' },
      },
    },
    annotations: { title: 'List knowledge gaps (unknowns)', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_unknowns';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_UNKNOWN_ARGS, tool);
      const query: Record<string, unknown> = {};
      const status = optionalEnum<UnknownStatus>(args, 'status', UNKNOWN_STATUS_VALUES, tool);
      if (status !== undefined) query.status = status;
      const subjectKind = optionalString(args, 'subjectKind', tool, 128);
      if (subjectKind !== undefined) query.subjectKind = subjectKind;
      const subjectId = optionalUuid(args, 'subjectId', tool);
      if (subjectId !== undefined) query.subjectId = subjectId;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const unknowns = await listUnknowns(ctx, args);
      return { data: unknowns, summary: { count: unknowns.length } };
    },
  },
  {
    name: 'list_beliefs',
    title: 'List current company beliefs',
    description:
      'List the tenant beliefs: the versioned current working understanding of the company and ' +
      'its environment, with confidence, alternatives and supporting evidence links. Beliefs are ' +
      "understanding, not facts (facts are observations). Read capability (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...BELIEF_STATUS_VALUES],
          description: 'Filter by anchor lifecycle (default: all).',
        },
        subjectKind: { type: 'string', description: 'Filter by subject kind.' },
        subjectId: { type: 'string', format: 'uuid', description: 'Filter by subject id.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 100).' },
      },
    },
    annotations: { title: 'List current company beliefs', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_beliefs';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_BELIEFS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const status = optionalEnum<BeliefStatus>(args, 'status', BELIEF_STATUS_VALUES, tool);
      if (status !== undefined) query.status = status;
      const subjectKind = optionalString(args, 'subjectKind', tool, 128);
      if (subjectKind !== undefined) query.subjectKind = subjectKind;
      const subjectId = optionalUuid(args, 'subjectId', tool);
      if (subjectId !== undefined) query.subjectId = subjectId;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const beliefs = await listBeliefs(ctx, args);
      return { data: beliefs, summary: { count: beliefs.length } };
    },
  },
  {
    name: 'list_claims',
    title: 'List evidence-derived claims',
    description:
      'List the tenant claims: immutable propositions derived from recorded evidence, with the ' +
      'confidence they were derived at and links to the supporting observations. Conflicting ' +
      "derivations coexist (they are retained, never merged). Read capability (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        subjectKind: { type: 'string', description: 'Filter by subject kind.' },
        subjectId: { type: 'string', format: 'uuid', description: 'Filter by subject id.' },
        evidenceObservationId: {
          type: 'string',
          format: 'uuid',
          description: 'Filter to claims whose evidence includes this observation.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 100).' },
      },
    },
    annotations: { title: 'List evidence-derived claims', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_claims';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_CLAIMS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const subjectKind = optionalString(args, 'subjectKind', tool, 128);
      if (subjectKind !== undefined) query.subjectKind = subjectKind;
      const subjectId = optionalUuid(args, 'subjectId', tool);
      if (subjectId !== undefined) query.subjectId = subjectId;
      const evidenceObservationId = optionalUuid(args, 'evidenceObservationId', tool);
      if (evidenceObservationId !== undefined) query.evidenceObservationId = evidenceObservationId;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const claims = await listClaims(ctx, args);
      return { data: claims, summary: { count: claims.length } };
    },
  },
  {
    name: 'get_belief',
    title: 'Inspect one belief (as of a time)',
    description:
      'Retrieve one belief by id: its statement (proposition, confidence, alternatives, what ' +
      'evidence could change the conclusion), supporting observations and validity window, as of ' +
      'an optional point in time ("what did we believe as of <time>"). Read capability ' +
      "(action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        beliefId: { type: 'string', format: 'uuid', description: 'The belief anchor id.' },
        asOf: {
          type: 'string',
          description: 'Strict ISO 8601 instant; resolves the version valid at that time (default: now).',
        },
      },
      required: ['beliefId'],
    },
    annotations: { title: 'Inspect one belief', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'get_belief';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, GET_BELIEF_ARGS, tool);
      const query: Record<string, unknown> = {
        beliefId: requireUuid(args, 'beliefId', tool),
      };
      const asOf = optionalString(args, 'asOf', tool, 64);
      if (asOf !== undefined) query.asOf = asOf;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const belief = await getBelief(ctx, {
        beliefId: args.beliefId as string,
        asOf: args.asOf as string | undefined,
      });
      return { data: belief, summary: beliefSummary(belief) };
    },
  },
];

// Re-exported for the unit tests' summary assertions.
export { unknownSummary, beliefSummary, claimSummary };
