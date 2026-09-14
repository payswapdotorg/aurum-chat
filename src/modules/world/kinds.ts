// Built-in vocabularies of the world model (W005).
//
// ARCHITECTURE.md §4: "The world model represents internal and external
// reality through extensible entities and relationships. Core entities
// include Person, Employee, Team, Manager, Customer, Supplier,
// Subcontractor, Competitor, Regulator, GovernmentBody, Product, Service,
// Asset, Location, Project, Process, Contract, Market, Industry, Technology,
// Agent, AgentTeam, Extension, Capability, Goal, Risk, Opportunity,
// LearningMission, KnowledgeContribution, Reward, and ExternalIdentity."
//
// That frozen core list is mirrored here EXACTLY (nothing dropped, nothing
// invented) as built-in entity kinds, so every tenant starts with the full
// canonical vocabulary. Extensibility is the second half of the work item:
// tenants additionally register their own kinds at runtime
// (`registerEntityKind`, stored tenant-scoped in world_entity_kinds).
//
// Every kind carries a coarse `category` that maps onto the five areas the
// work item names — company, people, processes, capabilities, environment
// (plus `direction` for the goal/risk/opportunity/mission/reward objects
// whose authoritative records are owned by later modules — W008/W007/W011/
// W042/W043 — but which the frozen core list includes as world entities).
// The category is an organizational label, not a semantic boundary: a
// `technology` is categorized `environment` because ARCHITECTURE.md §12
// lists technologies among the external watch subjects, while `agent`,
// `agent_team` and `extension` are categorized `capability` because §13–§17
// present them as capability suppliers.
//
// Relationship types follow the same scheme: a built-in vocabulary of
// directed edges covering the company/people/process/capability/environment
// semantics of the work item, plus tenant-registered custom types
// (`registerRelationshipType`, stored tenant-scoped in
// world_relationship_types).

/** Coarse organizational category of an entity kind. */
export type EntityKindCategory =
  | 'company' // internal org structure and resources
  | 'people' // humans in and around the organization
  | 'process' // how work happens
  | 'capability' // what can do work / supply capability
  | 'environment' // external reality the company operates in
  | 'direction'; // goal/risk/opportunity/mission/reward references

export const ENTITY_KIND_CATEGORIES = [
  'company',
  'people',
  'process',
  'capability',
  'environment',
  'direction',
] as const;

/** One built-in entity kind of the core world-model vocabulary. */
export interface BuiltinEntityKind {
  readonly kind: string;
  readonly category: EntityKindCategory;
  readonly description: string;
}

/**
 * The frozen core entity vocabulary (ARCHITECTURE.md §4, verbatim list,
 * snake_cased). Sorted by category then kind.
 */
export const BUILTIN_ENTITY_KINDS: readonly BuiltinEntityKind[] = [
  // --- company: internal structure and resources ---
  { kind: 'company', category: 'company', description: 'The tenant company itself' },
  { kind: 'team', category: 'company', description: 'An internal organizational unit of people' },
  { kind: 'location', category: 'company', description: 'A physical or virtual place of the company' },
  { kind: 'asset', category: 'company', description: 'A resource owned or controlled by the company' },
  { kind: 'product', category: 'company', description: 'A product of the company' },
  { kind: 'service', category: 'company', description: 'A service offering of the company' },
  { kind: 'contract', category: 'company', description: 'A binding agreement the company is party to' },
  { kind: 'project', category: 'company', description: 'A temporary piece of internal work' },
  // --- people: humans in and around the organization ---
  { kind: 'person', category: 'people', description: 'A human being represented in the world model' },
  { kind: 'employee', category: 'people', description: 'A person employed by the company' },
  { kind: 'manager', category: 'people', description: 'A person with management responsibility' },
  {
    kind: 'external_identity',
    category: 'people',
    description: 'A channel/provider account of a person (identity module record)',
  },
  // --- process: how work happens ---
  { kind: 'process', category: 'process', description: 'A recurring way work happens in the company' },
  // --- capability: what can supply capability ---
  { kind: 'capability', category: 'capability', description: 'A capability the company has or needs' },
  { kind: 'agent', category: 'capability', description: 'An agent actor that can perform work' },
  { kind: 'agent_team', category: 'capability', description: 'A team of agent actors' },
  { kind: 'extension', category: 'capability', description: 'An installed software capability (extension)' },
  // --- environment: external reality ---
  { kind: 'customer', category: 'environment', description: 'An external customer of the company' },
  { kind: 'supplier', category: 'environment', description: 'An external supplier to the company' },
  { kind: 'subcontractor', category: 'environment', description: 'An external subcontractor of the company' },
  { kind: 'competitor', category: 'environment', description: 'An external competitor of the company' },
  { kind: 'regulator', category: 'environment', description: 'A regulatory body over the company domain' },
  { kind: 'government_body', category: 'environment', description: 'A governmental body relevant to the company' },
  { kind: 'market', category: 'environment', description: 'A market the company operates in' },
  { kind: 'industry', category: 'environment', description: 'An industry the company is part of' },
  { kind: 'technology', category: 'environment', description: 'A technology relevant to the company (watch subject)' },
  // --- direction: intelligence-loop objects owned by other modules ---
  {
    kind: 'goal',
    category: 'direction',
    description: 'A management goal (goals module record; authoritative there)',
  },
  { kind: 'risk', category: 'direction', description: 'A risk to the company' },
  { kind: 'opportunity', category: 'direction', description: 'An opportunity for the company' },
  {
    kind: 'learning_mission',
    category: 'direction',
    description: 'A learning mission (missions module record; authoritative there)',
  },
  {
    kind: 'knowledge_contribution',
    category: 'direction',
    description: 'A knowledge contribution by an employee',
  },
  { kind: 'reward', category: 'direction', description: 'A reward for a knowledge contribution' },
];

/** Built-in entity kinds as a plain set (fast membership checks). */
const BUILTIN_KIND_SET: ReadonlySet<string> = new Set(BUILTIN_ENTITY_KINDS.map((entry) => entry.kind));

const BUILTIN_KIND_BY_NAME: ReadonlyMap<string, BuiltinEntityKind> = new Map(
  BUILTIN_ENTITY_KINDS.map((entry) => [entry.kind, entry] as const),
);

export function isBuiltinEntityKind(value: unknown): value is string {
  return typeof value === 'string' && BUILTIN_KIND_SET.has(value);
}

/** Category of a built-in kind; undefined for non-built-in kinds. */
export function builtinEntityKindCategory(kind: string): EntityKindCategory | undefined {
  return BUILTIN_KIND_BY_NAME.get(kind)?.category;
}

/** Description of a built-in kind; undefined for non-built-in kinds. */
export function builtinEntityKindDescription(kind: string): string | undefined {
  return BUILTIN_KIND_BY_NAME.get(kind)?.description;
}

/** One built-in relationship type of the core world-model vocabulary. */
export interface BuiltinRelationshipType {
  readonly type: string;
  readonly description: string;
}

/**
 * Built-in relationship vocabulary: directed edges covering company, people,
 * process, capability and environment semantics. These are vocabulary, not
 * type-system restrictions — the world model does not hard-forbid novel
 * kind pairs (extensibility beats prescriptiveness here); callers express
 * structure, meaning stays in the type names.
 */
export const BUILTIN_RELATIONSHIP_TYPES: readonly BuiltinRelationshipType[] = [
  { type: 'member_of', description: 'Subject belongs to the object collective (person → team, team → team)' },
  { type: 'reports_to', description: 'Subject reports to the object (employee → manager)' },
  { type: 'employed_by', description: 'Subject is employed by the object (employee → company)' },
  { type: 'works_on', description: 'Subject is engaged in the object (person/team → project/process)' },
  { type: 'participates_in', description: 'Subject takes part in the object (person/agent → process)' },
  { type: 'owns', description: 'Subject owns the object (person/team → asset/process/contract)' },
  { type: 'requires', description: 'Subject requires the object (process/project → capability)' },
  { type: 'provides', description: 'Subject provides the object (person/team/agent/technology → capability)' },
  { type: 'supplies', description: 'Subject supplies the object to the company (supplier → product/service)' },
  { type: 'contracts_with', description: 'Subject has a contract with the object (company → supplier/customer)' },
  { type: 'serves', description: 'Subject serves the object (company/team → customer)' },
  { type: 'competes_with', description: 'Subject competes with the object (competitor → company/product)' },
  { type: 'operates_in', description: 'Subject is active in the object (company/product → market/industry)' },
  { type: 'uses', description: 'Subject uses the object (company/process → technology/asset)' },
  { type: 'regulates', description: 'Subject regulates the object (regulator/government_body → market/industry)' },
  { type: 'located_at', description: 'Subject is situated at the object (company/person/asset → location)' },
  { type: 'part_of', description: 'Subject is a constituent of the object (team → team, product → product line)' },
  { type: 'depends_on', description: 'Subject depends on the object (process → process, capability → capability)' },
];

const BUILTIN_RELATIONSHIP_TYPE_SET: ReadonlySet<string> = new Set(
  BUILTIN_RELATIONSHIP_TYPES.map((entry) => entry.type),
);

const BUILTIN_RELATIONSHIP_TYPE_BY_NAME: ReadonlyMap<string, BuiltinRelationshipType> = new Map(
  BUILTIN_RELATIONSHIP_TYPES.map((entry) => [entry.type, entry] as const),
);

export function isBuiltinRelationshipType(value: unknown): value is string {
  return typeof value === 'string' && BUILTIN_RELATIONSHIP_TYPE_SET.has(value);
}

/** Description of a built-in relationship type; undefined for others. */
export function builtinRelationshipTypeDescription(type: string): string | undefined {
  return BUILTIN_RELATIONSHIP_TYPE_BY_NAME.get(type)?.description;
}
