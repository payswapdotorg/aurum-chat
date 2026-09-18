// ============================================================================
// mcp/tools/observations — MCP tools over the observations contract (W039).
//
// ARCHITECTURE.md §23: MCP "may expose authorized operations such as ...
// retrieving evidence". Observations are the immutable, provenance-bearing
// evidence records (W004, lock 5). Both tools are READ class (matrix
// evaluation 'mcp.read' @ OBSERVE) and honor the module's
// principal-visibility rules: principal-scoped evidence never leaks into
// another principal's results — the MCP principal is subject to the same
// visibility discipline as every internal reader.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import {
  getObservation,
  listObservations,
} from '@/modules/observations/contract';
import type {
  Observation,
  ObservationSourceKind,
} from '@/modules/observations/contract';
import type { ToolDefinition } from '../types';
import {
  optionalEnum,
  optionalIsoInstant,
  optionalListLimit,
  optionalString,
  requireArgsObject,
  requireUuid,
  rejectUnknownKeys,
} from '../validation';

const OBSERVATION_SOURCE_KIND_VALUES = ['source', 'person', 'agent', 'system', 'external'] as const;

const LIST_OBSERVATIONS_ARGS = [
  'kind',
  'channel',
  'sourceKind',
  'sourceId',
  'observedFrom',
  'observedTo',
  'limit',
] as const;

const GET_OBSERVATION_ARGS = ['observationId'] as const;

function observationSummary(observation: Observation): {
  observationId: string;
  kind: string;
  channel: string;
} {
  return {
    observationId: observation.id,
    kind: observation.kind,
    channel: observation.channel,
  };
}

export const observationsTools: ToolDefinition[] = [
  {
    name: 'list_observations',
    title: 'List evidence observations',
    description:
      "List the tenant's immutable evidence records visible to this principal, filtered by kind, " +
      'channel, source and observed-at window, with provenance and confidence. Evidence is never ' +
      "mutated — corrections are new observations. Read capability (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Canonical classification, e.g. channel.message.' },
        channel: { type: 'string', description: 'Provider-neutral channel key.' },
        sourceKind: {
          type: 'string',
          enum: [...OBSERVATION_SOURCE_KIND_VALUES],
          description: 'Filter by source kind.',
        },
        sourceId: { type: 'string', description: 'Filter by source id (requires sourceKind context).' },
        observedFrom: {
          type: 'string',
          description: 'Inclusive lower bound on observedAt (strict ISO 8601).',
        },
        observedTo: {
          type: 'string',
          description: 'Inclusive upper bound on observedAt (strict ISO 8601).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50).' },
      },
    },
    annotations: { title: 'List evidence observations', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_observations';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_OBSERVATIONS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const kind = optionalString(args, 'kind', tool, 128);
      if (kind !== undefined) query.kind = kind;
      const channel = optionalString(args, 'channel', tool, 64);
      if (channel !== undefined) query.channel = channel;
      const sourceKind = optionalEnum<ObservationSourceKind>(
        args,
        'sourceKind',
        OBSERVATION_SOURCE_KIND_VALUES,
        tool,
      );
      if (sourceKind !== undefined) query.sourceKind = sourceKind;
      const sourceId = optionalString(args, 'sourceId', tool, 128);
      if (sourceId !== undefined) query.sourceId = sourceId;
      const observedFrom = optionalIsoInstant(args, 'observedFrom', tool);
      if (observedFrom !== undefined) query.observedFrom = observedFrom;
      const observedTo = optionalIsoInstant(args, 'observedTo', tool);
      if (observedTo !== undefined) query.observedTo = observedTo;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const observations = await listObservations(ctx, args);
      return { data: observations, summary: { count: observations.length } };
    },
  },
  {
    name: 'get_observation',
    title: 'Retrieve one piece of evidence',
    description:
      'Retrieve one immutable observation by id: content, provenance (source, channel, observed-at ' +
      'time), extraction lineage, permissions and confidence. Access honors principal visibility; ' +
      "another tenant's evidence is indistinguishable from missing. Read capability (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        observationId: { type: 'string', format: 'uuid', description: 'The observation id.' },
      },
      required: ['observationId'],
    },
    annotations: { title: 'Retrieve one piece of evidence', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'get_observation';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, GET_OBSERVATION_ARGS, tool);
      return { observationId: requireUuid(args, 'observationId', tool) };
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const observation = await getObservation(ctx, args.observationId as string);
      return { data: observation, summary: observationSummary(observation) };
    },
  },
];
