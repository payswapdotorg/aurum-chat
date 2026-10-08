// Pure validation of the org-lab module's inputs and queries (see
// contract.ts). No database, no clock, no TenantContext reads — the
// agent-body/info-strategy discipline: everything here is unit-testable
// without infrastructure.
//
// VOCABULARY MIRRORING (the agent-body ruling): the cross-module
// vocabularies this file guards against (the fabric's binding purposes,
// the context module's duration/workload/risk unions, the coverage source
// registries) are mirrored as local constants and compiler-pinned to the
// frozen unions with `satisfies` — drift in an owning module fails
// TYPECHECK here, never runtime. The type-only imports keep this file
// runtime-dependency-free (the services own every runtime import).

import type { TenantContext } from '@/infra/tenant';
import type { CoverageSourceRegistry } from '@/modules/coverage/contract';
import type { DurationClass, WorkloadLevel } from '@/modules/context/contract';
import type { ModelBindingPurpose } from '@/modules/provider-fabric/contract';
import { OrgLabError } from './errors';
import type {
  CandidateApplicability,
  CandidateApplicabilityInput,
  CandidateDisposition,
  CandidateEvaluationInput,
  EvaluationConfig,
  EvaluationScore,
  GetCandidateCalibrationQuery,
  GetCandidateQuery,
  GetRecommendationQuery,
  ListCandidatesQuery,
  ListRecommendationsQuery,
  OrgCandidateStatus,
  OrgComposition,
  OrgEdge,
  OrgEdgeKind,
  OrgInformationRoute,
  OrgNode,
  OrgNodeKind,
  OrgRecommendationStatus,
  RecordCalibrationInput,
  RecordRecommendationInput,
  RegisterCandidateInput,
  RetireCandidateInput,
  SearchOrganizationsQuery,
  StaffingProfile,
  RiskTolerance,
} from './types';

// ---------------------------------------------------------------------------
// Limits (bounds every input field — the house discipline)
// ---------------------------------------------------------------------------

export const MAX_SLUG_CHARS = 64;
export const MAX_LABEL_CHARS = 128;
export const MAX_DESCRIPTION_CHARS = 2048;
export const MAX_NODES = 32;
export const MAX_EDGES = 96;
export const MAX_INFORMATION_ROUTES = 16;
export const MAX_PURPOSES_PER_NODE = 4;
export const MAX_SEASON_WINDOWS = 16;
export const MAX_DECLARED_VALUES = 16;
export const MAX_REQUIRED_ITEMS = 32;
export const MAX_ADVISORY_NOTE_CHARS = 512;
export const MAX_ROLE_CHARS = 128;
export const MAX_REF_CHARS = 256;
export const MAX_EDGE_NOTE_CHARS = 512;
export const MAX_KNOWLEDGE_OBJECTIVE_CHARS = 2000;
export const MAX_CRITERIA = 16;
export const MAX_CRITERION_NAME_CHARS = 64;
export const MAX_EVALUATED_CANDIDATES = 32;
export const MIN_EVALUATED_CANDIDATES = 2;
export const MAX_REJECTION_REASONS = 8;
export const MAX_REASON_CHARS = 512;
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_SCORES = 16;
export const MAX_EVIDENCE_REFS = 32;
export const MAX_AGENT_EVALUATION_REFS = 8;
export const MAX_EXPECTED_OUTCOMES = 16;
export const MIN_EXPECTED_OUTCOMES = 1;
export const MAX_NOTE_CHARS = 2000;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

// ---------------------------------------------------------------------------
// Vocabularies (mirrored + compiler-pinned; see the header note)
// ---------------------------------------------------------------------------

export const ORG_NODE_KINDS = [
  'agent-body',
  'tenant-agent',
  'marketplace-agent-package',
  'marketplace-extension-package',
  'human-capability',
  'external-specialist',
] as const satisfies readonly OrgNodeKind[];

export const ORG_EDGE_KINDS = [
  'delegation',
  'review',
  'handoff',
  'escalation',
  'information-feed',
] as const satisfies readonly OrgEdgeKind[];

export const STAFFING_PROFILES = [
  'novice-heavy',
  'intermediate-heavy',
  'expert-heavy',
  'mixed',
] as const satisfies readonly StaffingProfile[];

export const RISK_TOLERANCES = [
  'risk-averse',
  'balanced',
  'risk-tolerant',
] as const satisfies readonly RiskTolerance[];

export const ORG_CANDIDATE_STATUSES = ['active', 'retired'] as const satisfies readonly OrgCandidateStatus[];

export const ORG_RECOMMENDATION_STATUSES = [
  'recorded',
  'calibrated',
] as const satisfies readonly OrgRecommendationStatus[];

export const CANDIDATE_DISPOSITIONS = [
  'recommended',
  'rejected',
] as const satisfies readonly CandidateDisposition[];

/** The W132 purpose vocabulary, mirrored (the agent-body precedent). */
export const MODEL_BINDING_PURPOSES = [
  'cognition',
  'conversation',
  'analysis',
  'background',
] as const satisfies readonly ModelBindingPurpose[];

/** The W134 duration vocabulary, mirrored. */
export const DURATION_CLASSES = [
  'short',
  'medium',
  'long',
  'ongoing',
] as const satisfies readonly DurationClass[];

/** The W134 workload vocabulary, mirrored. */
export const WORKLOAD_LEVELS = [
  'light',
  'normal',
  'heavy',
  'overloaded',
] as const satisfies readonly WorkloadLevel[];

/** The coverage source-registry vocabulary, mirrored (the W134 precedent). */
export const COVERAGE_SOURCE_REGISTRIES = [
  'source',
  'channel',
  'meeting',
  'integration',
] as const satisfies readonly CoverageSourceRegistry[];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isOrgNodeKind(value: unknown): value is OrgNodeKind {
  return typeof value === 'string' && (ORG_NODE_KINDS as readonly string[]).includes(value);
}

export function isOrgEdgeKind(value: unknown): value is OrgEdgeKind {
  return typeof value === 'string' && (ORG_EDGE_KINDS as readonly string[]).includes(value);
}

export function isStaffingProfile(value: unknown): value is StaffingProfile {
  return typeof value === 'string' && (STAFFING_PROFILES as readonly string[]).includes(value);
}

export function isRiskTolerance(value: unknown): value is RiskTolerance {
  return typeof value === 'string' && (RISK_TOLERANCES as readonly string[]).includes(value);
}

export function isOrgCandidateStatus(value: unknown): value is OrgCandidateStatus {
  return typeof value === 'string' && (ORG_CANDIDATE_STATUSES as readonly string[]).includes(value);
}

export function isOrgRecommendationStatus(value: unknown): value is OrgRecommendationStatus {
  return (
    typeof value === 'string' && (ORG_RECOMMENDATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isCandidateDisposition(value: unknown): value is CandidateDisposition {
  return typeof value === 'string' && (CANDIDATE_DISPOSITIONS as readonly string[]).includes(value);
}

export function isModelBindingPurposeValue(value: unknown): value is ModelBindingPurpose {
  return typeof value === 'string' && (MODEL_BINDING_PURPOSES as readonly string[]).includes(value);
}

export function isDurationClassValue(value: unknown): value is DurationClass {
  return typeof value === 'string' && (DURATION_CLASSES as readonly string[]).includes(value);
}

export function isWorkloadLevelValue(value: unknown): value is WorkloadLevel {
  return typeof value === 'string' && (WORKLOAD_LEVELS as readonly string[]).includes(value);
}

export function isCoverageSourceRegistryValue(value: unknown): value is CoverageSourceRegistry {
  return (
    typeof value === 'string' && (COVERAGE_SOURCE_REGISTRIES as readonly string[]).includes(value)
  );
}

/** The explicit TenantContext is asserted, never ambient (ADR-0001). */
export function assertOrgLabTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.tenantId !== 'string' ||
    ctx.tenantId.length === 0 ||
    typeof ctx.principalId !== 'string' ||
    ctx.principalId.length === 0 ||
    !Array.isArray(ctx.authority)
  ) {
    throw new OrgLabError('invalid_context', 'an explicit TenantContext with tenant and principal is required');
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: 'invalid_candidate_input' | 'invalid_recommendation_input' = 'invalid_candidate_input',
): string {
  if (typeof value !== 'string') {
    throw new OrgLabError(code, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new OrgLabError(
      code,
      `${field} must be ${min}..${max} characters (after trim), got ${trimmed.length}`,
    );
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: 'invalid_candidate_input' | 'invalid_recommendation_input',
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new OrgLabError(code, `${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length < min || trimmed.length > max) {
    throw new OrgLabError(code, `${field} must be ${min}..${max} characters (after trim)`);
  }
  return trimmed;
}

/** Normalizes a matching token: trim + lowercase (the single definition). */
function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

/** A bounded, de-duplicated, normalized string list. */
function stringList(
  value: unknown,
  field: string,
  max: number,
  code: 'invalid_candidate_input' | 'invalid_recommendation_input',
  maxItemChars: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new OrgLabError(code, `${field} must be an array of strings`);
  }
  if (value.length > max) {
    throw new OrgLabError(code, `${field} may hold at most ${max} entries, got ${value.length}`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new OrgLabError(code, `${field} entries must be strings`);
    }
    const token = normalizeToken(entry);
    if (token.length === 0 || token.length > maxItemChars) {
      throw new OrgLabError(
        code,
        `${field} entries must be 1..${maxItemChars} characters (after trim)`,
      );
    }
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** A bounded vocabulary list, validated + de-duplicated (order preserved). */
function vocabularyList<T extends string>(
  value: unknown,
  field: string,
  guard: (entry: unknown) => entry is T,
  max: number,
): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new OrgLabError('invalid_candidate_input', `${field} must be an array`);
  }
  if (value.length > max) {
    throw new OrgLabError('invalid_candidate_input', `${field} may hold at most ${max} entries`);
  }
  const out: T[] = [];
  for (const entry of value) {
    if (!guard(entry)) {
      throw new OrgLabError('invalid_candidate_input', `${field} contains an unknown value '${String(entry)}'`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new OrgLabError('invalid_query', `limit must be an integer in 1..${MAX_LIST_LIMIT}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// registerCandidate
// ---------------------------------------------------------------------------

export interface ValidatedRegisterCandidateInput {
  slug: string;
  label: string;
  description: string | null;
  composition: OrgComposition;
  applicability: CandidateApplicability;
}

function validateNode(value: unknown, index: number): OrgNode {
  const field = `composition.nodes[${index}]`;
  if (!isRecord(value)) {
    throw new OrgLabError('invalid_candidate_input', `${field} must be an object`);
  }
  const nodeId = value.nodeId;
  if (typeof nodeId !== 'string' || !SLUG_PATTERN.test(nodeId)) {
    throw new OrgLabError(
      'invalid_candidate_input',
      `${field}.nodeId must match ${SLUG_PATTERN} (unique node identity)`,
    );
  }
  if (!isOrgNodeKind(value.kind)) {
    throw new OrgLabError('invalid_candidate_input', `${field}.kind must be an organization node kind`);
  }
  const role = requireString(value.role, `${field}.role`, 1, MAX_ROLE_CHARS);
  let ref: string | null = null;
  if (value.ref !== undefined && value.ref !== null) {
    if (typeof value.ref !== 'string') {
      throw new OrgLabError('invalid_candidate_input', `${field}.ref must be a string or null`);
    }
    ref = value.ref.trim();
    if (ref.length === 0) ref = null;
    else if (ref.length > MAX_REF_CHARS) {
      throw new OrgLabError('invalid_candidate_input', `${field}.ref must be at most ${MAX_REF_CHARS} characters`);
    }
  }
  if (value.kind === 'agent-body' && (ref === null || !isUuid(ref))) {
    throw new OrgLabError(
      'invalid_candidate_input',
      `${field}.ref must be the uuid of an agent body for 'agent-body' nodes`,
    );
  }
  const label = optionalString(value.label, `${field}.label`, 1, MAX_LABEL_CHARS, 'invalid_candidate_input');
  const rawPurposes = value.purposes === undefined || value.purposes === null ? [] : value.purposes;
  if (!Array.isArray(rawPurposes)) {
    throw new OrgLabError('invalid_candidate_input', `${field}.purposes must be an array`);
  }
  if (rawPurposes.length > MAX_PURPOSES_PER_NODE) {
    throw new OrgLabError(
      'invalid_candidate_input',
      `${field}.purposes may hold at most ${MAX_PURPOSES_PER_NODE} entries`,
    );
  }
  if (value.kind !== 'agent-body' && rawPurposes.length > 0) {
    throw new OrgLabError(
      'invalid_candidate_input',
      `${field}: model-occupancy purposes are declared on 'agent-body' nodes only (the W133 seam)`,
    );
  }
  const purposes: ModelBindingPurpose[] = [];
  for (const purpose of rawPurposes) {
    if (!isModelBindingPurposeValue(purpose)) {
      throw new OrgLabError('invalid_candidate_input', `${field}.purposes contains an unknown purpose`);
    }
    if (!purposes.includes(purpose)) purposes.push(purpose);
  }
  return { nodeId, kind: value.kind, role, ref, label, purposes };
}

function validateEdge(value: unknown, index: number, nodeIds: Set<string>): OrgEdge {
  const field = `composition.edges[${index}]`;
  if (!isRecord(value)) {
    throw new OrgLabError('invalid_candidate_input', `${field} must be an object`);
  }
  if (typeof value.fromNodeId !== 'string' || !nodeIds.has(value.fromNodeId)) {
    throw new OrgLabError('invalid_candidate_input', `${field}.fromNodeId must reference a declared node`);
  }
  if (typeof value.toNodeId !== 'string' || !nodeIds.has(value.toNodeId)) {
    throw new OrgLabError('invalid_candidate_input', `${field}.toNodeId must reference a declared node`);
  }
  if (value.fromNodeId === value.toNodeId) {
    throw new OrgLabError('invalid_candidate_input', `${field}: an edge cannot loop a node onto itself`);
  }
  if (!isOrgEdgeKind(value.kind)) {
    throw new OrgLabError('invalid_candidate_input', `${field}.kind must be a topology edge kind`);
  }
  const note = optionalString(value.note, `${field}.note`, 1, MAX_EDGE_NOTE_CHARS, 'invalid_candidate_input');
  return { fromNodeId: value.fromNodeId, toNodeId: value.toNodeId, kind: value.kind, note };
}

function validateRoute(value: unknown, index: number): OrgInformationRoute {
  const field = `composition.informationRoutes[${index}]`;
  if (!isRecord(value)) {
    throw new OrgLabError('invalid_candidate_input', `${field} must be an object`);
  }
  if (!isCoverageSourceRegistryValue(value.registry)) {
    throw new OrgLabError('invalid_candidate_input', `${field}.registry must be a coverage source registry`);
  }
  const ref = requireString(value.ref, `${field}.ref`, 1, MAX_REF_CHARS);
  const note = optionalString(value.note, `${field}.note`, 1, MAX_EDGE_NOTE_CHARS, 'invalid_candidate_input');
  return { registry: value.registry, ref, note };
}

function validateApplicability(value: unknown): CandidateApplicability {
  if (value === undefined || value === null) {
    return {
      seasonWindows: [],
      durationClasses: [],
      staffingProfiles: [],
      workloadLevels: [],
      requiredCapabilities: [],
      requiredEnvironmentFactors: [],
      riskTolerances: [],
      requiredVerificationRequirements: [],
      freshSurfaces: [],
      budgetNote: null,
      qualityTarget: null,
      slaNote: null,
    };
  }
  if (!isRecord(value)) {
    throw new OrgLabError('invalid_candidate_input', 'applicability must be an object');
  }
  return {
    seasonWindows: stringList(
      value.seasonWindows,
      'applicability.seasonWindows',
      MAX_SEASON_WINDOWS,
      'invalid_candidate_input',
      MAX_LABEL_CHARS,
    ),
    durationClasses: vocabularyList(
      value.durationClasses,
      'applicability.durationClasses',
      isDurationClassValue,
      MAX_DECLARED_VALUES,
    ),
    staffingProfiles: vocabularyList(
      value.staffingProfiles,
      'applicability.staffingProfiles',
      isStaffingProfile,
      MAX_DECLARED_VALUES,
    ),
    workloadLevels: vocabularyList(
      value.workloadLevels,
      'applicability.workloadLevels',
      isWorkloadLevelValue,
      MAX_DECLARED_VALUES,
    ),
    requiredCapabilities: stringList(
      value.requiredCapabilities,
      'applicability.requiredCapabilities',
      MAX_REQUIRED_ITEMS,
      'invalid_candidate_input',
      MAX_LABEL_CHARS,
    ),
    requiredEnvironmentFactors: stringList(
      value.requiredEnvironmentFactors,
      'applicability.requiredEnvironmentFactors',
      MAX_REQUIRED_ITEMS,
      'invalid_candidate_input',
      MAX_LABEL_CHARS,
    ),
    riskTolerances: vocabularyList(
      value.riskTolerances,
      'applicability.riskTolerances',
      isRiskTolerance,
      MAX_DECLARED_VALUES,
    ),
    requiredVerificationRequirements: stringList(
      value.requiredVerificationRequirements,
      'applicability.requiredVerificationRequirements',
      MAX_REQUIRED_ITEMS,
      'invalid_candidate_input',
      MAX_LABEL_CHARS,
    ),
    freshSurfaces: stringList(
      value.freshSurfaces,
      'applicability.freshSurfaces',
      MAX_REQUIRED_ITEMS,
      'invalid_candidate_input',
      MAX_LABEL_CHARS,
    ),
    budgetNote: optionalString(
      value.budgetNote,
      'applicability.budgetNote',
      1,
      MAX_ADVISORY_NOTE_CHARS,
      'invalid_candidate_input',
    ),
    qualityTarget: optionalString(
      value.qualityTarget,
      'applicability.qualityTarget',
      1,
      MAX_ADVISORY_NOTE_CHARS,
      'invalid_candidate_input',
    ),
    slaNote: optionalString(
      value.slaNote,
      'applicability.slaNote',
      1,
      MAX_ADVISORY_NOTE_CHARS,
      'invalid_candidate_input',
    ),
  };
}

export function validateRegisterCandidateInput(input: unknown): ValidatedRegisterCandidateInput {
  if (!isRecord(input)) {
    throw new OrgLabError('invalid_candidate_input', 'the candidate input must be an object');
  }
  const slug = requireString(input.slug, 'slug', 1, MAX_SLUG_CHARS);
  if (!SLUG_PATTERN.test(slug)) {
    throw new OrgLabError('invalid_candidate_input', `slug must match ${SLUG_PATTERN}`);
  }
  const label = requireString(input.label, 'label', 1, MAX_LABEL_CHARS);
  const description = optionalString(
    input.description,
    'description',
    1,
    MAX_DESCRIPTION_CHARS,
    'invalid_candidate_input',
  );

  const composition = input.composition;
  if (!isRecord(composition)) {
    throw new OrgLabError('invalid_candidate_input', 'composition must be an object');
  }
  if (!Array.isArray(composition.nodes) || composition.nodes.length < 1) {
    throw new OrgLabError('invalid_candidate_input', 'composition.nodes must hold at least one node');
  }
  if (composition.nodes.length > MAX_NODES) {
    throw new OrgLabError(
      'invalid_candidate_input',
      `composition.nodes may hold at most ${MAX_NODES} nodes`,
    );
  }
  const nodes = composition.nodes.map((node, index) => validateNode(node, index));
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.nodeId)) {
      throw new OrgLabError(
        'invalid_candidate_input',
        `composition.nodes: nodeId '${node.nodeId}' is declared twice`,
      );
    }
    nodeIds.add(node.nodeId);
  }

  const rawEdges = composition.edges === undefined || composition.edges === null ? [] : composition.edges;
  if (!Array.isArray(rawEdges)) {
    throw new OrgLabError('invalid_candidate_input', 'composition.edges must be an array');
  }
  if (rawEdges.length > MAX_EDGES) {
    throw new OrgLabError('invalid_candidate_input', `composition.edges may hold at most ${MAX_EDGES} edges`);
  }
  const edges = rawEdges.map((edge, index) => validateEdge(edge, index, nodeIds));

  const rawRoutes =
    composition.informationRoutes === undefined || composition.informationRoutes === null
      ? []
      : composition.informationRoutes;
  if (!Array.isArray(rawRoutes)) {
    throw new OrgLabError('invalid_candidate_input', 'composition.informationRoutes must be an array');
  }
  if (rawRoutes.length > MAX_INFORMATION_ROUTES) {
    throw new OrgLabError(
      'invalid_candidate_input',
      `composition.informationRoutes may hold at most ${MAX_INFORMATION_ROUTES} routes`,
    );
  }
  const informationRoutes = rawRoutes.map((route, index) => validateRoute(route, index));

  return {
    slug,
    label,
    description,
    composition: { nodes, edges, informationRoutes },
    applicability: validateApplicability(input.applicability),
  };
}

// ---------------------------------------------------------------------------
// Candidate queries / lifecycle
// ---------------------------------------------------------------------------

export interface ValidatedGetCandidateQuery {
  candidateId: string;
}

export function validateGetCandidateQuery(query: unknown): ValidatedGetCandidateQuery {
  if (!isRecord(query) || !isUuid(query.candidateId)) {
    throw new OrgLabError('invalid_query', 'candidateId must be a uuid');
  }
  return { candidateId: query.candidateId };
}

export interface ValidatedListCandidatesQuery {
  status: OrgCandidateStatus | null;
  limit: number;
}

export function validateListCandidatesQuery(query?: unknown): ValidatedListCandidatesQuery {
  if (query === undefined || query === null) return { status: null, limit: DEFAULT_LIST_LIMIT };
  if (!isRecord(query)) {
    throw new OrgLabError('invalid_query', 'the list query must be an object');
  }
  let status: OrgCandidateStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isOrgCandidateStatus(query.status)) {
      throw new OrgLabError('invalid_query', 'status must be an organization candidate status');
    }
    status = query.status;
  }
  return { status, limit: requireLimit(query.limit) };
}

export interface ValidatedRetireCandidateInput {
  candidateId: string;
  reason: string;
}

export function validateRetireCandidateInput(input: unknown): ValidatedRetireCandidateInput {
  if (!isRecord(input) || !isUuid(input.candidateId)) {
    throw new OrgLabError('invalid_candidate_input', 'candidateId must be a uuid');
  }
  const reason = requireString(input.reason, 'reason', 1, MAX_REASON_CHARS);
  return { candidateId: input.candidateId, reason };
}

// ---------------------------------------------------------------------------
// searchOrganizations
// ---------------------------------------------------------------------------

export interface ValidatedSearchOrganizationsQuery {
  goalId: string;
  fingerprintId: string;
  limit: number;
}

export function validateSearchOrganizationsQuery(query: unknown): ValidatedSearchOrganizationsQuery {
  if (!isRecord(query) || !isUuid(query.goalId) || !isUuid(query.fingerprintId)) {
    throw new OrgLabError('invalid_query', 'goalId and fingerprintId must be uuids');
  }
  return { goalId: query.goalId, fingerprintId: query.fingerprintId, limit: requireLimit(query.limit) };
}

// ---------------------------------------------------------------------------
// recordRecommendation
// ---------------------------------------------------------------------------

export interface ValidatedCandidateEvaluation {
  candidateId: string;
  disposition: CandidateDisposition;
  rejectionReasons: string[];
  summary: string;
  scores: EvaluationScore[];
  evidenceRefs: string[];
  agentEvaluationIds: string[];
}

export interface ValidatedRecordRecommendationInput {
  goalId: string;
  fingerprintId: string;
  strategyId: string | null;
  knowledgeObjective: string;
  evaluationConfig: EvaluationConfig;
  candidates: ValidatedCandidateEvaluation[];
  expectedOutcomeIds: string[];
  derivedFrom: string[];
  note: string | null;
}

function uuidList(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string[] {
  if (value === undefined || value === null) {
    if (min > 0) {
      throw new OrgLabError('invalid_recommendation_input', `${field} must hold at least ${min} uuid(s)`);
    }
    return [];
  }
  if (!Array.isArray(value)) {
    throw new OrgLabError('invalid_recommendation_input', `${field} must be an array of uuids`);
  }
  if (value.length < min || value.length > max) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      `${field} must hold ${min}..${max} uuid(s), got ${value.length}`,
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    if (!isUuid(entry)) {
      throw new OrgLabError('invalid_recommendation_input', `${field} entries must be uuids`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function validateEvaluationConfig(value: unknown): EvaluationConfig {
  if (!isRecord(value) || !Array.isArray(value.criteria) || value.criteria.length < 1) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      'evaluationConfig.criteria must hold at least one criterion',
    );
  }
  if (value.criteria.length > MAX_CRITERIA) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      `evaluationConfig.criteria may hold at most ${MAX_CRITERIA} criteria`,
    );
  }
  const names = new Set<string>();
  const criteria = value.criteria.map((criterion, index) => {
    const field = `evaluationConfig.criteria[${index}]`;
    if (!isRecord(criterion)) {
      throw new OrgLabError('invalid_recommendation_input', `${field} must be an object`);
    }
    const name = requireString(
      criterion.name,
      `${field}.name`,
      1,
      MAX_CRITERION_NAME_CHARS,
      'invalid_recommendation_input',
    );
    if (names.has(name)) {
      throw new OrgLabError('invalid_recommendation_input', `${field}.name '${name}' is declared twice`);
    }
    names.add(name);
    let weight: number | null = null;
    if (criterion.weight !== undefined && criterion.weight !== null) {
      if (
        typeof criterion.weight !== 'number' ||
        !Number.isFinite(criterion.weight) ||
        criterion.weight < 0 ||
        criterion.weight > 1
      ) {
        throw new OrgLabError('invalid_recommendation_input', `${field}.weight must be a number in [0, 1]`);
      }
      weight = criterion.weight;
    }
    return { name, weight };
  });
  const note = optionalString(
    value.note,
    'evaluationConfig.note',
    1,
    MAX_NOTE_CHARS,
    'invalid_recommendation_input',
  );
  return { criteria, note };
}

function validateCandidateEvaluation(
  value: unknown,
  index: number,
  criterionNames: Set<string>,
): ValidatedCandidateEvaluation {
  const field = `candidates[${index}]`;
  if (!isRecord(value)) {
    throw new OrgLabError('invalid_recommendation_input', `${field} must be an object`);
  }
  if (!isUuid(value.candidateId)) {
    throw new OrgLabError('invalid_recommendation_input', `${field}.candidateId must be a uuid`);
  }
  if (!isCandidateDisposition(value.disposition)) {
    throw new OrgLabError('invalid_recommendation_input', `${field}.disposition must be 'recommended' or 'rejected'`);
  }
  const disposition = value.disposition;

  const rawReasons = value.rejectionReasons === undefined || value.rejectionReasons === null ? [] : value.rejectionReasons;
  if (!Array.isArray(rawReasons)) {
    throw new OrgLabError('invalid_recommendation_input', `${field}.rejectionReasons must be an array`);
  }
  if (rawReasons.length > MAX_REJECTION_REASONS) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      `${field}.rejectionReasons may hold at most ${MAX_REJECTION_REASONS} reasons`,
    );
  }
  const rejectionReasons = rawReasons.map((reason, reasonIndex) =>
    requireString(
      reason,
      `${field}.rejectionReasons[${reasonIndex}]`,
      1,
      MAX_REASON_CHARS,
      'invalid_recommendation_input',
    ),
  );
  if (disposition === 'rejected' && rejectionReasons.length === 0) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      `${field}: a rejected candidate REQUIRES at least one rejection reason (retained evidence)`,
    );
  }
  if (disposition === 'recommended' && rejectionReasons.length > 0) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      `${field}: a recommended candidate carries no rejection reasons`,
    );
  }

  const summary = requireString(value.summary, `${field}.summary`, 1, MAX_SUMMARY_CHARS, 'invalid_recommendation_input');

  const rawScores = value.scores === undefined || value.scores === null ? [] : value.scores;
  if (!Array.isArray(rawScores)) {
    throw new OrgLabError('invalid_recommendation_input', `${field}.scores must be an array`);
  }
  if (rawScores.length > MAX_SCORES) {
    throw new OrgLabError('invalid_recommendation_input', `${field}.scores may hold at most ${MAX_SCORES} scores`);
  }
  const scoredNames = new Set<string>();
  const scores = rawScores.map((score, scoreIndex) => {
    const sField = `${field}.scores[${scoreIndex}]`;
    if (!isRecord(score)) {
      throw new OrgLabError('invalid_recommendation_input', `${sField} must be an object`);
    }
    const name = requireString(
      score.name,
      `${sField}.name`,
      1,
      MAX_CRITERION_NAME_CHARS,
      'invalid_recommendation_input',
    );
    if (!criterionNames.has(name)) {
      throw new OrgLabError(
        'invalid_recommendation_input',
        `${sField}.name '${name}' is not a criterion of the evaluation config`,
      );
    }
    if (scoredNames.has(name)) {
      throw new OrgLabError('invalid_recommendation_input', `${sField}.name '${name}' is scored twice`);
    }
    scoredNames.add(name);
    if (typeof score.value !== 'number' || !Number.isFinite(score.value) || score.value < 0 || score.value > 1) {
      throw new OrgLabError('invalid_recommendation_input', `${sField}.value must be a number in [0, 1]`);
    }
    return { name, value: score.value };
  });

  const evidenceRefs = stringList(
    value.evidenceRefs,
    `${field}.evidenceRefs`,
    MAX_EVIDENCE_REFS,
    'invalid_recommendation_input',
    MAX_REF_CHARS,
  );
  const agentEvaluationIds = uuidList(value.agentEvaluationIds, `${field}.agentEvaluationIds`, 0, MAX_AGENT_EVALUATION_REFS);

  return { candidateId: value.candidateId, disposition, rejectionReasons, summary, scores, evidenceRefs, agentEvaluationIds };
}

export function validateRecordRecommendationInput(
  input: unknown,
): ValidatedRecordRecommendationInput {
  if (!isRecord(input)) {
    throw new OrgLabError('invalid_recommendation_input', 'the recommendation input must be an object');
  }
  if (!isUuid(input.goalId) || !isUuid(input.fingerprintId)) {
    throw new OrgLabError('invalid_recommendation_input', 'goalId and fingerprintId must be uuids');
  }
  let strategyId: string | null = null;
  if (input.strategyId !== undefined && input.strategyId !== null) {
    if (!isUuid(input.strategyId)) {
      throw new OrgLabError('invalid_recommendation_input', 'strategyId must be a uuid or null');
    }
    strategyId = input.strategyId;
  }
  const knowledgeObjective = requireString(
    input.knowledgeObjective,
    'knowledgeObjective',
    1,
    MAX_KNOWLEDGE_OBJECTIVE_CHARS,
    'invalid_recommendation_input',
  );
  const evaluationConfig = validateEvaluationConfig(input.evaluationConfig);

  if (!Array.isArray(input.candidates)) {
    throw new OrgLabError('invalid_recommendation_input', 'candidates must be an array');
  }
  if (
    input.candidates.length < MIN_EVALUATED_CANDIDATES ||
    input.candidates.length > MAX_EVALUATED_CANDIDATES
  ) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      `candidates must hold ${MIN_EVALUATED_CANDIDATES}..${MAX_EVALUATED_CANDIDATES} evaluations`,
    );
  }
  const criterionNames = new Set(evaluationConfig.criteria.map((criterion) => criterion.name));
  const candidates = input.candidates.map((candidate, index) =>
    validateCandidateEvaluation(candidate, index, criterionNames),
  );
  const seen = new Set<string>();
  let recommended = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateId)) {
      throw new OrgLabError(
        'invalid_recommendation_input',
        `candidate '${candidate.candidateId}' is evaluated twice in this recommendation`,
      );
    }
    seen.add(candidate.candidateId);
    if (candidate.disposition === 'recommended') recommended += 1;
  }
  if (recommended > 1) {
    throw new OrgLabError(
      'invalid_recommendation_input',
      'at most one evaluated candidate may be recommended (zero is the honest no-winner case)',
    );
  }

  const expectedOutcomeIds = uuidList(
    input.expectedOutcomeIds,
    'expectedOutcomeIds',
    MIN_EXPECTED_OUTCOMES,
    MAX_EXPECTED_OUTCOMES,
  );
  const derivedFrom = stringList(
    input.derivedFrom,
    'derivedFrom',
    MAX_EVIDENCE_REFS,
    'invalid_recommendation_input',
    MAX_REF_CHARS,
  );
  const note = optionalString(input.note, 'note', 1, MAX_NOTE_CHARS, 'invalid_recommendation_input');

  return {
    goalId: input.goalId,
    fingerprintId: input.fingerprintId,
    strategyId,
    knowledgeObjective,
    evaluationConfig,
    candidates,
    expectedOutcomeIds,
    derivedFrom,
    note,
  };
}

// ---------------------------------------------------------------------------
// recordCalibration + recommendation queries
// ---------------------------------------------------------------------------

export interface ValidatedRecordCalibrationInput {
  recommendationId: string;
  note: string | null;
}

export function validateRecordCalibrationInput(input: unknown): ValidatedRecordCalibrationInput {
  if (!isRecord(input) || !isUuid(input.recommendationId)) {
    throw new OrgLabError('invalid_calibration_input', 'recommendationId must be a uuid');
  }
  const note = optionalString(input.note, 'note', 1, MAX_NOTE_CHARS, 'invalid_calibration_input');
  return { recommendationId: input.recommendationId, note };
}

export interface ValidatedGetRecommendationQuery {
  recommendationId: string;
}

export function validateGetRecommendationQuery(query: unknown): ValidatedGetRecommendationQuery {
  if (!isRecord(query) || !isUuid(query.recommendationId)) {
    throw new OrgLabError('invalid_query', 'recommendationId must be a uuid');
  }
  return { recommendationId: query.recommendationId };
}

export interface ValidatedListRecommendationsQuery {
  goalId: string | null;
  fingerprintId: string | null;
  candidateId: string | null;
  status: OrgRecommendationStatus | null;
  limit: number;
}

export function validateListRecommendationsQuery(query?: unknown): ValidatedListRecommendationsQuery {
  if (query === undefined || query === null) {
    return { goalId: null, fingerprintId: null, candidateId: null, status: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isRecord(query)) {
    throw new OrgLabError('invalid_query', 'the list query must be an object');
  }
  const checkUuid = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (!isUuid(value)) {
      throw new OrgLabError('invalid_query', `${field} must be a uuid`);
    }
    return value;
  };
  let status: OrgRecommendationStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isOrgRecommendationStatus(query.status)) {
      throw new OrgLabError('invalid_query', 'status must be a recommendation status');
    }
    status = query.status;
  }
  return {
    goalId: checkUuid(query.goalId, 'goalId'),
    fingerprintId: checkUuid(query.fingerprintId, 'fingerprintId'),
    candidateId: checkUuid(query.candidateId, 'candidateId'),
    status,
    limit: requireLimit(query.limit),
  };
}

export interface ValidatedGetCandidateCalibrationQuery {
  candidateId: string;
}

export function validateGetCandidateCalibrationQuery(
  query: unknown,
): ValidatedGetCandidateCalibrationQuery {
  if (!isRecord(query) || !isUuid(query.candidateId)) {
    throw new OrgLabError('invalid_query', 'candidateId must be a uuid');
  }
  return { candidateId: query.candidateId };
}
