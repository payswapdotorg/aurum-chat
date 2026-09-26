// W096 — the Integration Intelligence fixture executor.
//
// The machinery behind tests/e2e/journeys/integration-intelligence.e2e.test.ts:
// it LOADS the machine-readable chain fixtures
// (tests/e2e/fixtures/integration-intelligence/*.fixture.json), VALIDATES them
// against the versioned fixture.schema.json through a small JSON-Schema
// subset evaluator (the schema file is the contract of record — the
// evaluator refuses to silently skip keywords it does not implement),
// EXECUTES every step's invokes against the REAL W081-W084 module services
// (integration-intelligence, connection-broker, capability-grants,
// deep-actions — plus their W009 actions gate, W036 sources discovery
// transport, W004 observations and the goals/epistemics/capabilities
// grounding contracts), and EVALUATES every expectation against DURABLE
// records: raw table rows in the embedded PostgreSQL (the organizational
// truth), the modules' append-only event ledgers, their contract reads and
// the provider-side state of the deterministic doubles.
//
// PROVIDER DOUBLES (the repo fixture pattern — the "provider side" lives
// behind these in-memory fakes; nothing here is a mock of DOMAIN logic):
//   * ScriptedDirectoryTransport — the discovery source's transport, serving
//     scripted windows of canonical directory records;
//   * ScriptedBrokerBackend — the fake managed-broker server speaking the
//     embedded broker's wire dialect (the same double the W082/W083/W084
//     module suites ride);
//   * ScriptedVerificationTransport — the provider-neutral capability probe
//     port, with scriptable per-capability reachability;
//   * ScriptedDeepActionTransport — the provider behind the deep-action
//     gateway's exit seam: a canonical entity store that applies writes,
//     returns OPAQUE receipt ids and can fail transiently, refuse
//     permanently or skip applying.
//
// The executor is NOT a test file (vitest picks up only **/*.test.ts — the
// tests/tenant-isolation/harness.ts precedent) and follows the same import
// discipline as the sweeps: module code is imported ONLY through
// @/modules/<m>/contract, never internals; infra ports and the migration
// runner are shared infrastructure.
//
// Every browser-evidence and tower-decision hook is INJECTED by the journey
// suite (the SSR harness + the real tower API handler) so this file stays
// free of app-surface imports.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as actionsContract from '@/modules/actions/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as capabilitiesContract from '@/modules/capabilities/contract';
import * as deepActionsContract from '@/modules/deep-actions/contract';
import * as epistemicsContract from '@/modules/epistemics/contract';
import * as goalsContract from '@/modules/goals/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as sourcesContract from '@/modules/sources/contract';
import * as grantsContract from '@/modules/capability-grants/contract';

const FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// The fixture JSON's loose shapes (validated at runtime by the schema)
// ---------------------------------------------------------------------------

export interface FixtureInvoke {
  op: string;
  as: string;
  system?: string;
  capabilityKey?: string;
  decision?: 'approve' | 'reject';
  note?: string;
  via?: 'tower-api' | 'contract';
  persona?: string;
  ofTenant?: string;
  systemOf?: string;
  sourceOf?: string;
  expectError?: string;
  browserEvidence?: BrowserEvidenceSpec[];
}

export interface BrowserEvidenceSpec {
  surface: string;
  persona: string;
  assertions: { kind: 'contains' | 'contains-not' | 'matches'; value: string }[];
}

interface DurableProbe {
  kind?: string;
  table?: string;
  where?: Record<string, string | number | boolean>;
  rows: number | { atLeast: number };
  tenant?: string;
  actionKind?: string;
  decision?: 'approve' | 'reject';
}

interface ContractRead {
  read: string;
  as: string;
  system?: string;
  outcome?: 'allowed' | 'denied';
  ofTenant?: string;
  assert: Record<string, unknown>;
}

interface TransportProbe {
  probe: string;
  system?: string;
  target?: string;
  expect: unknown;
}

interface FixtureStep {
  phase: string;
  title: string;
  invokes: FixtureInvoke[];
  expect?: {
    durable?: DurableProbe[];
    contract?: ContractRead[];
    events?: { read: string; as: string; equalsReversed: string[] };
    transport?: TransportProbe[];
  };
  browserEvidence?: BrowserEvidenceSpec[];
}

interface FixtureShape {
  schemaVersion: number;
  fixtureId: string;
  title: string;
  chain: string[];
  variant: { providerFailure: boolean; deniedScope: boolean; tenantIsolation: boolean };
  tenants: {
    key: string;
    source: 'demo-world' | 'fresh';
    label?: string;
    directorySource: {
      provider: string;
      displayName: string;
      providerAccountId: string;
      authKind: 'oauth' | 'credentials';
    };
    orgContext?: {
      goal: {
        title: string;
        objective: string;
        desiredState: string;
        horizonEnd: string;
        priority: string;
        successCriteria: string;
        ownerLabel: string;
      };
      unknown: { question: string; consequence: string };
      capability: { name: string; description: string };
    };
    directoryWindow: {
      externalId: string;
      displayName: string;
      capabilityClasses: string[];
    }[];
    systems: Record<string, { displayName: string; connectionKey: string }>;
  }[];
  actors: { key: string; tenant: string; authority: string[] }[];
  broker: { adapter: string; provider: string };
  verification: { unreachableCapabilities: string[] };
  deepAction: {
    taskContext: { description: string; requestedFor: string };
    operations: {
      key: string;
      system: string;
      capabilityKey: string;
      target: string;
      payload: Record<string, unknown>;
      expectation: Record<string, unknown>;
    }[];
    seededStates: { system: string; target: string; state: Record<string, unknown> }[];
    transientFailureTargets: string[];
    permanentRefusalTargets: string[];
    skipApplyTargets: string[];
  };
  steps: FixtureStep[];
  finalSteps?: FixtureStep[];
}

// ---------------------------------------------------------------------------
// The JSON-Schema subset evaluator (fixture.schema.json is the contract)
// ---------------------------------------------------------------------------

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  $ref?: string;
}

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'minLength',
  'minimum',
  'enum',
  'const',
  'pattern',
  '$ref',
  'description',
  'title',
  'definitions',
  '$schema',
  '$id',
]);

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`schema evaluator: only internal '#/…' $ref supported, got '${ref}'`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`schema evaluator: broken $ref path '${ref}'`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'object' || node === null) throw new Error(`schema evaluator: $ref '${ref}' resolves to nothing`);
  return node as JsonSchema;
}

function typeMatches(actual: unknown, expected: string): boolean {
  switch (expected) {
    case 'object':
      return typeof actual === 'object' && actual !== null && !Array.isArray(actual);
    case 'array':
      return Array.isArray(actual);
    case 'string':
      return typeof actual === 'string';
    case 'number':
      return typeof actual === 'number';
    case 'integer':
      return typeof actual === 'number' && Number.isInteger(actual);
    case 'boolean':
      return typeof actual === 'boolean';
    case 'null':
      return actual === null;
    default:
      throw new Error(`schema evaluator: unsupported type '${expected}'`);
  }
}

/** Validate one value against one schema node; collect failures with paths. */
function evaluateSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  failures: string[],
): void {
  if (schema.$ref !== undefined) {
    evaluateSchema(value, resolveRef(root, schema.$ref), root, path, failures);
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`schema evaluator: keyword '${keyword}' at '${path}' is not implemented — keep fixture.schema.json within the supported subset`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      failures.push(`${path}: expected type ${types.join('|')}, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    failures.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    failures.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (schema.pattern !== undefined && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      failures.push(`${path}: '${value}' does not match pattern '${schema.pattern}'`);
    }
  }
  if (typeof value === 'string' && schema.minLength !== undefined) {
    if (value.length < schema.minLength) {
      failures.push(`${path}: minLength ${schema.minLength}, got ${value.length}`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined) {
    if (value < schema.minimum) {
      failures.push(`${path}: minimum ${schema.minimum}, got ${value}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      failures.push(`${path}: minItems ${schema.minItems}, got ${value.length}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        evaluateSchema(item, schema.items!, root, `${path}[${index}]`, failures);
      });
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (!(key in record)) failures.push(`${path}: missing required property '${key}'`);
      }
    }
    if (schema.properties !== undefined) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key in record) {
          evaluateSchema(record[key], child, root, `${path}.${key}`, failures);
        }
      }
    }
    if (schema.additionalProperties !== undefined) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (known.has(key)) continue;
        if (schema.additionalProperties === false) {
          failures.push(`${path}: unexpected property '${key}' (additionalProperties: false)`);
        } else if (typeof schema.additionalProperties === 'object') {
          evaluateSchema(record[key], schema.additionalProperties, root, `${path}.${key}`, failures);
        }
      }
    }
  }
}

/** Load + structurally validate one fixture against the versioned schema. */
export function loadFixture(fixtureFile: string): FixtureShape {
  const fixture = JSON.parse(readFileSync(`${FIXTURE_DIR}/${fixtureFile}`, 'utf8')) as FixtureShape;
  const schema = JSON.parse(readFileSync(`${FIXTURE_DIR}/fixture.schema.json`, 'utf8')) as JsonSchema;
  const failures: string[] = [];
  evaluateSchema(fixture, schema, schema, '$', failures);
  if (failures.length > 0) {
    throw new Error(
      `fixture '${fixtureFile}' violates fixture.schema.json (schemaVersion ${fixture.schemaVersion}):\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  }
  return fixture;
}

// ---------------------------------------------------------------------------
// The deterministic provider doubles (the repo fixture pattern)
// ---------------------------------------------------------------------------

/** A provider-neutral source transport that serves scripted windows. */
class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  readonly requests: unknown[] = [];
  private windows: sourcesContract.SourceFetchResult[] = [];

  script(...windows: sourcesContract.SourceFetchResult[]): void {
    this.windows.push(...windows);
  }

  async fetch(request: unknown): Promise<sourcesContract.SourceFetchResult> {
    this.requests.push(request);
    const next = this.windows.shift();
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

/** A fake managed-broker server (the embedded wire dialect). */
class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  readonly requests: brokerContract.BrokerHttpRequest[] = [];
  private authorizations = new Map<string, string>();
  private counter = 0;

  async request(request: brokerContract.BrokerHttpRequest): Promise<brokerContract.BrokerHttpResponse> {
    this.requests.push(request);
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.unit.example/oauth/${state}`,
          state,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        },
      };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const connectionId = decodeURIComponent(callback[1]!);
      const body = request.body as { state?: string };
      if (this.authorizations.get(connectionId) !== body.state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      this.counter += 1;
      const embId = `emb-${this.counter.toString().padStart(3, '0')}`;
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: [],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

/** A verification transport with scripted per-capability reachability. */
class ScriptedVerificationTransport implements integrationContract.VerificationTransport {
  readonly probes: string[] = [];
  private unreachable = new Set<string>();

  constructor(unreachableCapabilities: string[]) {
    this.unreachable = new Set(unreachableCapabilities);
  }

  async probe(request: {
    capabilityKey: string;
  }): Promise<{ reachable: boolean; detail: string | null }> {
    this.probes.push(request.capabilityKey);
    return this.unreachable.has(request.capabilityKey)
      ? { reachable: false, detail: 'the capability endpoint refused the read probe' }
      : { reachable: true, detail: null };
  }
}

/**
 * A fake deep-action transport — the "provider side" behind the gateway's
 * exit seam: a canonical entity store that applies executed writes, returns
 * OPAQUE receipt ids and can fail transiently, refuse permanently or skip
 * applying (the W084 double, verbatim discipline).
 */
class ScriptedDeepActionTransport implements deepActionsContract.DeepActionTransport {
  readonly inspectRequests: deepActionsContract.DeepActionInspectRequest[] = [];
  readonly executeRequests: deepActionsContract.DeepActionExecuteRequest[] = [];
  private states = new Map<string, unknown>();
  private receiptCounter = 0;
  private readonly failOnce = new Set<string>();
  private readonly refuse = new Set<string>();
  private readonly skipApply = new Set<string>();

  constructor(
    transientFailureTargets: string[],
    permanentRefusalTargets: string[],
    skipApplyTargets: string[],
  ) {
    this.failOnce = new Set(transientFailureTargets);
    this.refuse = new Set(permanentRefusalTargets);
    this.skipApply = new Set(skipApplyTargets);
  }

  private key(connectionId: string, target: string): string {
    return `${connectionId}:${target}`;
  }

  seed(connectionId: string, target: string, state: unknown): void {
    this.states.set(this.key(connectionId, target), state);
  }

  stateOf(connectionId: string, target: string): unknown {
    return this.states.get(this.key(connectionId, target));
  }

  async inspect(
    request: deepActionsContract.DeepActionInspectRequest,
  ): Promise<deepActionsContract.DeepActionState> {
    this.inspectRequests.push(request);
    const state = this.states.get(this.key(request.connectionId, request.target));
    return { found: state !== undefined, state: state ?? null };
  }

  async execute(
    request: deepActionsContract.DeepActionExecuteRequest,
  ): Promise<deepActionsContract.DeepActionReceipt> {
    this.executeRequests.push(request);
    if (this.refuse.has(request.target)) {
      return { status: 'rejected', receiptId: null, detail: 'quota exceeded — permanent refusal' };
    }
    if (this.failOnce.has(request.target)) {
      this.failOnce.delete(request.target);
      return { status: 'failed', receiptId: null, detail: 'upstream timeout — transient' };
    }
    this.receiptCounter += 1;
    const receiptId = `rcpt-${this.receiptCounter.toString().padStart(4, '0')}`;
    if (!this.skipApply.has(request.target)) {
      const current = this.states.get(this.key(request.connectionId, request.target));
      const base =
        typeof current === 'object' && current !== null && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      this.states.set(this.key(request.connectionId, request.target), {
        ...base,
        ...(request.payload as Record<string, unknown>),
      });
    }
    return { status: 'accepted', receiptId, detail: null };
  }
}

// ---------------------------------------------------------------------------
// The run report (machine-readable evidence of record)
// ---------------------------------------------------------------------------

export interface InvokeReport {
  op: string;
  as: string;
  ok: boolean;
  expectedError?: string;
  detail?: string;
}

export interface DurableResult {
  table: string;
  tenant: string;
  where: Record<string, string | number | boolean>;
  expected: string;
  actual: number | string;
  pass: boolean;
}

export interface ContractResult {
  read: string;
  path: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface EventsResult {
  expected: string;
  actual: string;
  pass: boolean;
}

export interface TransportResult {
  probe: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface BrowserResult {
  surface: string;
  persona: string;
  assertion: string;
  pass: boolean;
}

export interface StepReport {
  fixtureId: string;
  tenantKey: string;
  phase: string;
  title: string;
  invokes: InvokeReport[];
  durable: DurableResult[];
  contract: ContractResult[];
  events: EventsResult[];
  transport: TransportResult[];
  browser: BrowserResult[];
  pass: boolean;
}

export interface FixtureRunReport {
  fixtureId: string;
  fixtureFile: string;
  schemaValidated: true;
  tenants: { key: string; tenantId: string }[];
  steps: StepReport[];
  allPass: boolean;
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/** The hooks the journey suite injects (SSR rendering + the real tower API). */
export interface FixtureHooks {
  /** Render one admin surface through the real page SSR; returns the HTML. */
  renderPage: (path: string, persona: string) => Promise<string>;
  /** Drive one W009 decision through the real tower API handler. */
  decideViaTower: (
    requestId: string,
    decision: 'approve' | 'reject',
    note: string | null,
  ) => Promise<{ status: number; body: unknown }>;
}

interface SystemRuntime {
  systemId: string;
  displayName: string;
  connectionId: string | null;
  recommendationId: string | null;
  initiationState: string | null;
  grantRequestId: string | null;
}

interface TenantRuntime {
  key: string;
  tenantId: string;
  sourceId: string | null;
  systems: Map<string, SystemRuntime>;
  taskId: string | null;
  batchId: string | null;
  seededSystems: Set<string>;
}

interface RunState {
  fixture: FixtureShape;
  fixtureFile: string;
  hooks: FixtureHooks;
  demoTenantId: string | null;
  tenants: TenantRuntime[];
  actors: Map<string, { ctx: TenantContext; tenantKey: string }>;
  directoryTransport: ScriptedDirectoryTransport;
  deepTransport: ScriptedDeepActionTransport;
  reports: StepReport[];
}

function freshTenantRuntime(key: string, tenantId: string): TenantRuntime {
  return {
    key,
    tenantId,
    sourceId: null,
    systems: new Map(),
    taskId: null,
    batchId: null,
    seededSystems: new Set(),
  };
}

/** Resolve an actor for the CURRENT tenant: '<key>-<tenantKey>' first, then the bare key. */
function actorFor(state: RunState, actorKey: string, tenantKey: string): TenantContext {
  const suffixed = state.actors.get(`${actorKey}-${tenantKey}`);
  const bare = state.actors.get(actorKey);
  const entry = suffixed ?? bare;
  if (entry === undefined) {
    throw new Error(
      `fixture '${state.fixture.fixtureId}': actor '${actorKey}' (tenant '${tenantKey}') is not declared`,
    );
  }
  return entry.ctx;
}

/** The runtime of a tenant by key. */
function tenantOf(state: RunState, key: string): TenantRuntime {
  const runtime = state.tenants.find((tenant) => tenant.key === key);
  if (runtime === undefined) {
    throw new Error(`fixture '${state.fixture.fixtureId}': unknown tenant key '${key}'`);
  }
  return runtime;
}

// Fake credentials assembled from fragments at runtime (never a realistic
// full token literal in source — GitHub push protection).
function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w096/` + `${label}/` + 'ref';
}

function directoryRecordOf(
  record: { externalId: string; displayName: string; capabilityClasses: string[] },
): sourcesContract.CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${record.externalId}`,
    kind: integrationContract.DISCOVERY_RECORD_KIND,
    payload: {
      externalId: record.externalId,
      displayName: record.displayName,
      capabilityClasses: record.capabilityClasses,
    },
    occurredAt: '2026-09-23T10:00:00Z',
  };
}

/** Read one assert path ('operations.0.state', 'length', '0.a.b.length') from a read result. */
function readPath(value: unknown, path: string): unknown {
  let node: unknown = value;
  if (path === 'length') {
    return Array.isArray(node) ? node.length : undefined;
  }
  for (const segment of path.split('.')) {
    if (node === null || node === undefined) return undefined;
    if (segment === 'length') {
      node = Array.isArray(node) ? node.length : undefined;
      continue;
    }
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      node = node[index];
      continue;
    }
    if (typeof node === 'object') {
      node = (node as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return node;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value) ?? String(value);
}

/** Deep equality for provider-state expectations (JSON-canonical values). */
function deepEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * The fixture executor: validate, wire the doubles, run every step against
 * the real module contracts and evaluate every durable expectation.
 */
export async function runIntegrationFixture(
  fixtureFile: string,
  hooks: FixtureHooks,
  options: { demoTenantId?: string } = {},
): Promise<FixtureRunReport> {
  const fixture = loadFixture(fixtureFile);
  const state: RunState = {
    fixture,
    fixtureFile,
    hooks,
    demoTenantId: options.demoTenantId ?? null,
    tenants: [],
    actors: new Map(),
    directoryTransport: new ScriptedDirectoryTransport(),
    deepTransport: new ScriptedDeepActionTransport(
      fixture.deepAction.transientFailureTargets,
      fixture.deepAction.permanentRefusalTargets,
      fixture.deepAction.skipApplyTargets,
    ),
    reports: [],
  };

  // -- tenants + actors (fresh ids; the demo-world tenant is provided)
  for (const tenant of fixture.tenants) {
    const tenantId =
      tenant.source === 'demo-world'
        ? (state.demoTenantId ?? fail('fixture tenant source is demo-world but no demoTenantId was provided'))
        : newId();
    state.tenants.push(freshTenantRuntime(tenant.key, tenantId));
  }
  for (const actor of fixture.actors) {
    const tenantRuntime = tenantOf(state, actor.tenant);
    state.actors.set(actor.key, {
      ctx: { tenantId: tenantRuntime.tenantId, principalId: newId(), authority: actor.authority },
      tenantKey: actor.tenant,
    });
  }

  // -- wire the deterministic provider doubles (global process wiring)
  const brokerBackend = new ScriptedBrokerBackend();
  sourcesContract.setSourceTransport(state.directoryTransport);
  integrationContract.setVerificationTransport(
    new ScriptedVerificationTransport(fixture.verification.unreachableCapabilities),
  );
  brokerContract.wireConnectionBrokers([
    brokerContract.createEmbeddedBroker({
      baseUrl: 'https://broker.unit.example',
      apiToken: ['emb_', 'test', '_token'].join(''),
      httpClient: brokerBackend,
    }),
  ]);
  deepActionsContract.setDeepActionTransport(state.deepTransport);

  try {
    // The full chain runs once per declared tenant (isolation: twice).
    for (const tenant of fixture.tenants) {
      const runtime = tenantOf(state, tenant.key);
      await runSteps(state, runtime, fixture.steps);
    }
    if (fixture.finalSteps !== undefined) {
      // finalSteps run once, against whichever tenant each invoke/expectation names.
      await runFinalSteps(state, fixture.finalSteps);
    }
  } finally {
    sourcesContract.setSourceTransport(null);
    integrationContract.setVerificationTransport(null);
    brokerContract.wireConnectionBrokers(null);
    deepActionsContract.setDeepActionTransport(null);
  }

  return {
    fixtureId: fixture.fixtureId,
    fixtureFile,
    schemaValidated: true,
    tenants: state.tenants.map((runtime) => ({ key: runtime.key, tenantId: runtime.tenantId })),
    steps: state.reports,
    allPass: state.reports.every((report) => report.pass),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function runSteps(state: RunState, runtime: TenantRuntime, steps: FixtureStep[]): Promise<void> {
  for (const step of steps) {
    const report: StepReport = {
      fixtureId: state.fixture.fixtureId,
      tenantKey: runtime.key,
      phase: step.phase,
      title: step.title,
      invokes: [],
      durable: [],
      contract: [],
      events: [],
      transport: [],
      browser: [],
      pass: true,
    };
    state.reports.push(report);
    for (const invoke of step.invokes) {
      await runInvoke(state, runtime, invoke, report);
      await collectBrowserEvidence(state, invoke.browserEvidence, report);
    }
    await collectBrowserEvidence(state, step.browserEvidence, report);
    await evaluateExpectations(state, runtime, step, report);
    report.pass =
      report.invokes.every((entry) => entry.ok) &&
      report.durable.every((entry) => entry.pass) &&
      report.contract.every((entry) => entry.pass) &&
      report.events.every((entry) => entry.pass) &&
      report.transport.every((entry) => entry.pass) &&
      report.browser.every((entry) => entry.pass);
  }
}

async function runFinalSteps(state: RunState, steps: FixtureStep[]): Promise<void> {
  for (const step of steps) {
    // A final step's default tenant is the FIRST declared tenant; invokes
    // and expectations name their own tenants explicitly.
    const runtime = state.tenants[0]!;
    const report: StepReport = {
      fixtureId: state.fixture.fixtureId,
      tenantKey: 'cross-tenant',
      phase: step.phase,
      title: step.title,
      invokes: [],
      durable: [],
      contract: [],
      events: [],
      transport: [],
      browser: [],
      pass: true,
    };
    state.reports.push(report);
    for (const invoke of step.invokes) {
      await runInvoke(state, runtime, invoke, report);
    }
    await evaluateExpectations(state, runtime, step, report, true);
    report.pass =
      report.invokes.every((entry) => entry.ok) &&
      report.durable.every((entry) => entry.pass) &&
      report.contract.every((entry) => entry.pass) &&
      report.events.every((entry) => entry.pass) &&
      report.transport.every((entry) => entry.pass) &&
      report.browser.every((entry) => entry.pass);
  }
}

// ---------------------------------------------------------------------------
// Invokes — every op is a REAL module-contract call
// ---------------------------------------------------------------------------

async function runInvoke(
  state: RunState,
  runtime: TenantRuntime,
  invoke: FixtureInvoke,
  report: StepReport,
): Promise<void> {
  const fixture = state.fixture;
  const ctx = actorFor(state, invoke.as, runtime.key);
  const tenantSpec = fixture.tenants.find((tenant) => tenant.key === runtime.key)!;
  let ok = true;
  let detail: string | undefined;

  const run = async (): Promise<void> => {
    switch (invoke.op) {
      case 'create-org-context': {
        if (tenantSpec.orgContext === undefined) {
          throw new Error(`fixture '${fixture.fixtureId}': create-org-context without tenant orgContext`);
        }
        const owner = { kind: 'person' as const, label: tenantSpec.orgContext.goal.ownerLabel };
        await goalsContract.createGoal(ctx, {
          title: tenantSpec.orgContext.goal.title,
          objective: tenantSpec.orgContext.goal.objective,
          desiredState: tenantSpec.orgContext.goal.desiredState,
          horizonEnd: tenantSpec.orgContext.goal.horizonEnd,
          owner,
          priority: tenantSpec.orgContext.goal.priority as goalsContract.GoalPriority,
          successCriteria: tenantSpec.orgContext.goal.successCriteria,
          actor: owner,
        });
        await epistemicsContract.recordUnknown(ctx, {
          question: tenantSpec.orgContext.unknown.question,
          consequence: tenantSpec.orgContext.unknown.consequence,
        });
        const capability = await capabilitiesContract.registerCapability(ctx, {
          name: tenantSpec.orgContext.capability.name,
          description: tenantSpec.orgContext.capability.description,
          actor: owner,
        });
        await capabilitiesContract.registerRequirement(ctx, {
          capabilityId: capability.id,
          source: { kind: 'manual', label: 'Ops review' },
          actor: owner,
        });
        return;
      }
      case 'register-directory-source': {
        const source = tenantSpec.directorySource;
        const registered = await sourcesContract.registerSource(ctx, {
          provider: source.provider as sourcesContract.SourceProvider,
          providerAccountId: source.providerAccountId,
          displayName: source.displayName,
          authKind: source.authKind,
          credentialRef: fakeCredentialRef(`${source.provider}-${runtime.key}`),
          oauthScopes: ['directory.read'],
          oauthExpiresAt: '2027-01-01T00:00:00Z',
        });
        runtime.sourceId = registered.source.id;
        return;
      }
      case 'grant-discovery-source': {
        await integrationContract.grantDiscoverySource(ctx, { sourceId: runtime.sourceId! });
        return;
      }
      case 'run-discovery': {
        state.directoryTransport.script({
          records: tenantSpec.directoryWindow.map(directoryRecordOf),
          nextCursor: null,
          hasMore: false,
        });
        await integrationContract.runDiscovery(ctx, { sourceId: runtime.sourceId! });
        // Capture the discovered systems (by displayName) for later steps.
        const systems = await integrationContract.listSystems(ctx, {});
        for (const [key, spec] of Object.entries(tenantSpec.systems)) {
          const found = systems.find((system) => system.displayName === spec.displayName);
          if (found === undefined) {
            throw new Error(
              `fixture '${fixture.fixtureId}': system '${spec.displayName}' was not discovered`,
            );
          }
          runtime.systems.set(key, {
            systemId: found.id,
            displayName: found.displayName,
            connectionId: null,
            recommendationId: null,
            initiationState: null,
            grantRequestId: null,
          });
        }
        return;
      }
      case 'run-discovery-through-source': {
        // The isolation probe: discovery through ANOTHER tenant's source.
        const target = tenantOf(state, invoke.sourceOf ?? fail('sourceOf is required'));
        await integrationContract.runDiscovery(ctx, { sourceId: target.sourceId! });
        return;
      }
      case 'list-recommendations': {
        const recommendations = await integrationContract.listRecommendations(ctx, {});
        for (const system of runtime.systems.values()) {
          const match = recommendations.find((entry) => entry.systemId === system.systemId);
          if (match === undefined) {
            throw new Error(
              `fixture '${fixture.fixtureId}': no recommendation for system '${system.displayName}'`,
            );
          }
          system.recommendationId = match.id;
        }
        return;
      }
      case 'submit-recommendation-batch': {
        const recommendationIds = [...runtime.systems.values()]
          .map((system) => system.recommendationId)
          .filter((id): id is string => id !== null);
        const batch = await integrationContract.submitRecommendationBatch(ctx, {
          recommendationIds,
        });
        runtime.batchId = batch.id;
        return;
      }
      case 'decide-recommendation-batch': {
        await integrationContract.decideRecommendationBatch(ctx, {
          batchId: runtime.batchId!,
          decision: invoke.decision ?? fail('decision is required'),
          note: invoke.note ?? null,
        });
        return;
      }
      case 'connect-system': {
        const system = runtime.systems.get(invoke.system ?? fail('system is required'))!;
        await integrationContract.connectSystem(ctx, {
          recommendationId: system.recommendationId!,
        });
        return;
      }
      case 'initiate-broker-connection': {
        const system = runtime.systems.get(invoke.system ?? fail('system is required'))!;
        const spec = tenantSpec.systems[invoke.system!]!;
        const initiation = await brokerContract.initiateConnection(ctx, {
          provider: fixture.broker.provider as brokerContract.BrokerProvider,
          connectionKey: spec.connectionKey,
          displayName: system.displayName,
          inventorySystemId: system.systemId,
        });
        system.connectionId = initiation.connection.id;
        system.initiationState = initiation.authorization.state;
        return;
      }
      case 'complete-broker-connection': {
        const system = runtime.systems.get(invoke.system ?? fail('system is required'))!;
        await brokerContract.completeConnection(ctx, {
          connectionId: system.connectionId!,
          state: system.initiationState!,
        });
        // Seed the provider double's entity store for this system NOW that
        // the live connection id exists (the states rides the connection).
        for (const seeded of fixture.deepAction.seededStates) {
          if (seeded.system === invoke.system && !runtime.seededSystems.has(invoke.system!)) {
            state.deepTransport.seed(system.connectionId!, seeded.target, seeded.state);
          }
        }
        runtime.seededSystems.add(invoke.system!);
        return;
      }
      case 'verify-system': {
        const system = runtime.systems.get(invoke.system ?? fail('system is required'))!;
        await integrationContract.verifySystem(ctx, { systemId: system.systemId });
        return;
      }
      case 'establish-connection-access': {
        const system = runtime.systems.get(invoke.system ?? fail('system is required'))!;
        await grantsContract.establishConnectionAccess(ctx, { connectionId: system.connectionId! });
        return;
      }
      case 'create-deep-action': {
        const created = await deepActionsContract.createDeepAction(ctx, {
          taskContext: fixture.deepAction.taskContext,
          operations: fixture.deepAction.operations.map((operation) => {
            const system = runtime.systems.get(operation.system)!;
            return {
              key: operation.key,
              connectionId: system.connectionId!,
              capabilityKey: operation.capabilityKey,
              target: operation.target,
              payload: operation.payload,
              expectation: operation.expectation,
            };
          }),
          idempotencyKey: `w096-${runtime.key}`,
        });
        runtime.taskId = created.task.id;
        return;
      }
      case 'discover-execution-surface': {
        await deepActionsContract.discoverExecutionSurface(ctx, { taskId: runtime.taskId! });
        return;
      }
      case 'inspect-targets': {
        await deepActionsContract.inspectTargets(ctx, { taskId: runtime.taskId! });
        return;
      }
      case 'request-capability-authority': {
        const systemKey = invoke.system ?? fail('system is required');
        const system = runtime.systems.get(systemKey)!;
        const capabilityKeys = fixture.deepAction.operations
          .filter((operation) => operation.system === systemKey)
          .map((operation) => operation.capabilityKey);
        const ask = await grantsContract.requestCapabilityAuthority(ctx, {
          connectionId: system.connectionId!,
          capabilityKeys,
          taskContext: fixture.deepAction.taskContext,
        });
        system.grantRequestId = ask.request?.id ?? null;
        return;
      }
      case 'decide-grant-request': {
        const system = runtime.systems.get(invoke.system ?? fail('system is required'))!;
        await grantsContract.decideGrantRequest(ctx, {
          requestId: system.grantRequestId!,
          decision: invoke.decision ?? fail('decision is required'),
          note: invoke.note ?? null,
        });
        return;
      }
      case 'invoke-capability': {
        const system = runtime.systems.get(invoke.system ?? fail('system is required'))!;
        await grantsContract.invokeCapability(ctx, {
          connectionId: system.connectionId!,
          capabilityKey: invoke.capabilityKey ?? fail('capabilityKey is required'),
          taskContext: fixture.deepAction.taskContext,
        });
        return;
      }
      case 'propose-deep-action': {
        const proposed = await deepActionsContract.proposeDeepAction(ctx, {
          taskId: runtime.taskId!,
        });
        if (proposed.task.actionRequestId === null) {
          throw new Error('propose-deep-action produced no action request id');
        }
        return;
      }
      case 'decide-deep-action-gate': {
        const task = (await deepActionsContract.getDeepAction(ctx, { taskId: runtime.taskId! })).task;
        if (task.actionRequestId === null) {
          throw new Error('no pending deep-action gate request to decide');
        }
        if (invoke.via === 'tower-api') {
          const result = await state.hooks.decideViaTower(
            task.actionRequestId,
            invoke.decision ?? fail('decision is required'),
            invoke.note ?? null,
          );
          if (result.status !== 200) {
            throw new Error(
              `tower API decision returned HTTP ${result.status}: ${JSON.stringify(result.body)}`,
            );
          }
          detail = `decided through the real tower API (HTTP 200) by persona '${invoke.persona ?? 'unknown'}'`;
        } else {
          await actionsContract.decideApproval(ctx, {
            requestId: task.actionRequestId,
            decision: invoke.decision ?? fail('decision is required'),
            note: invoke.note ?? null,
          });
        }
        return;
      }
      case 'authorize-deep-action': {
        await deepActionsContract.authorizeDeepAction(ctx, { taskId: runtime.taskId! });
        return;
      }
      case 'execute-deep-action': {
        await deepActionsContract.executeDeepAction(ctx, { taskId: runtime.taskId! });
        return;
      }
      case 'verify-deep-action': {
        await deepActionsContract.verifyDeepAction(ctx, { taskId: runtime.taskId! });
        return;
      }
      case 'reconcile-deep-action': {
        await deepActionsContract.reconcileDeepAction(ctx, { taskId: runtime.taskId! });
        return;
      }
      // ---- the cross-tenant isolation probes (uniform not-found doctrine)
      case 'get-deep-action': {
        const target = tenantOf(state, invoke.ofTenant ?? runtime.key);
        await deepActionsContract.getDeepAction(ctx, { taskId: target.taskId! });
        return;
      }
      case 'get-system': {
        const target = tenantOf(state, invoke.systemOf ?? runtime.key);
        const system = target.systems.get(invoke.system ?? 'crm')!;
        await integrationContract.getSystem(ctx, { systemId: system.systemId });
        return;
      }
      case 'get-broker-connection': {
        const target = tenantOf(state, invoke.systemOf ?? runtime.key);
        const system = target.systems.get(invoke.system ?? 'crm')!;
        await brokerContract.getConnection(ctx, { connectionId: system.connectionId! });
        return;
      }
      case 'get-recommendation-batch': {
        const target = tenantOf(state, invoke.ofTenant ?? runtime.key);
        await integrationContract.getRecommendationBatch(ctx, { batchId: target.batchId! });
        return;
      }
      case 'get-connection-access': {
        const target = tenantOf(state, invoke.systemOf ?? runtime.key);
        const system = target.systems.get(invoke.system ?? 'crm')!;
        await grantsContract.getConnectionAccess(ctx, { connectionId: system.connectionId! });
        return;
      }
      default:
        throw new Error(`fixture '${fixture.fixtureId}': unimplemented invoke op '${invoke.op}'`);
    }
  };

  try {
    await run();
    if (invoke.expectError !== undefined) {
      ok = false;
      detail = `expected error '${invoke.expectError}' but the call succeeded`;
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
    if (invoke.expectError !== undefined && code === invoke.expectError) {
      detail = `refused with the module's uniform '${code}'`;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      // An unexpected failure breaks the chain — surface it loudly.
      throw new Error(
        `fixture '${fixture.fixtureId}' step '${report.phase}' (tenant '${runtime.key}'): invoke '${invoke.op}' as '${invoke.as}' failed: ${message}`,
        { cause: error },
      );
    }
  }
  report.invokes.push({ op: invoke.op, as: invoke.as, ok, expectedError: invoke.expectError, detail });
}

// ---------------------------------------------------------------------------
// Expectation evaluation — durable records, contract reads, events, provider
// ---------------------------------------------------------------------------

async function evaluateExpectations(
  state: RunState,
  runtime: TenantRuntime,
  step: FixtureStep,
  report: StepReport,
  globalTransportProbes = false,
): Promise<void> {
  const expect = step.expect;
  if (expect === undefined) return;

  for (const probe of expect.durable ?? []) {
    report.durable.push(await evaluateDurable(state, runtime, probe));
  }
  for (const read of expect.contract ?? []) {
    await evaluateContractRead(state, runtime, read, report);
  }
  if (expect.events !== undefined) {
    const ctx = actorFor(state, expect.events.as, runtime.key);
    const events = await deepActionsContract.listDeepActionEvents(ctx, {
      taskId: runtime.taskId!,
    });
    const actual = events.map((event) => event.event).reverse();
    const expected = expect.events.equalsReversed;
    report.events.push({
      expected: expected.join(' > '),
      actual: actual.join(' > '),
      pass: JSON.stringify(actual) === JSON.stringify(expected),
    });
  }
  for (const probe of expect.transport ?? []) {
    report.transport.push(evaluateTransport(state, runtime, probe, globalTransportProbes));
  }
}

async function evaluateDurable(
  state: RunState,
  runtime: TenantRuntime,
  probe: DurableProbe,
): Promise<DurableResult> {
  const tenantKey = probe.tenant ?? runtime.key;
  const tenantId = tenantOf(state, tenantKey).tenantId;
  const where = probe.where ?? {};

  if (probe.kind === 'action-kind-decisions') {
    const rows = await getDb().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM action_approval_decisions d
         JOIN action_requests r ON d.request_id = r.id AND d.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.action_kind = $2 AND d.decision = $3`,
      [tenantId, probe.actionKind ?? fail('actionKind is required'), probe.decision ?? fail('decision is required')],
    );
    return durableResult('action_approval_decisions', tenantKey, where, probe.rows, Number(rows.rows[0]?.count ?? 0));
  }

  const table = probe.table ?? fail(`fixture '${state.fixture.fixtureId}': durable probe without table`);
  const columns = await tableColumnsFor(table);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  for (const [column, value] of Object.entries(where)) {
    if (!columns.has(column)) {
      return {
        table,
        tenant: tenantKey,
        where,
        expected: describeRows(probe.rows),
        actual: `unknown column '${column}' (valid: ${[...columns].join(', ')})`,
        pass: false,
      };
    }
    params.push(value);
    conditions.push(`${column} = $${params.length}`);
  }
  const rows = await getDb().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return durableResult(table, tenantKey, where, probe.rows, Number(rows.rows[0]?.count ?? 0));
}

function describeRows(rows: number | { atLeast: number }): string {
  return typeof rows === 'number' ? String(rows) : `at least ${rows.atLeast}`;
}

function durableResult(
  table: string,
  tenant: string,
  where: Record<string, string | number | boolean>,
  expected: number | { atLeast: number },
  actual: number,
): DurableResult {
  const pass =
    typeof expected === 'number' ? actual === expected : Number.isInteger(actual) && actual >= expected.atLeast;
  return { table, tenant, where, expected: describeRows(expected), actual, pass };
}

async function evaluateContractRead(
  state: RunState,
  runtime: TenantRuntime,
  read: ContractRead,
  report: StepReport,
): Promise<void> {
  const ctx = actorFor(state, read.as, runtime.key);
  const ofTenant = read.ofTenant ?? runtime.key;
  const target = tenantOf(state, ofTenant);
  const system = read.system !== undefined ? target.systems.get(read.system) : undefined;

  let result: unknown;
  switch (read.read) {
    case 'list-systems':
      result = await integrationContract.listSystems(ctx, {});
      break;
    case 'get-system':
      result = await integrationContract.getSystem(ctx, { systemId: system!.systemId });
      break;
    case 'list-recommendations':
      result = await integrationContract.listRecommendations(ctx, {});
      break;
    case 'get-recommendation-batch':
      result = await integrationContract.getRecommendationBatch(ctx, { batchId: target.batchId! });
      break;
    case 'list-verification-runs':
      result = await integrationContract.listVerificationRuns(ctx, { systemId: system!.systemId });
      break;
    case 'get-connection-access':
      result = await grantsContract.getConnectionAccess(ctx, { connectionId: system!.connectionId! });
      break;
    case 'list-capability-grants': {
      const query: Record<string, unknown> = {};
      if (system?.connectionId !== undefined && system.connectionId !== null) {
        query['connectionId'] = system.connectionId;
      }
      result = await grantsContract.listCapabilityGrants(ctx, query);
      break;
    }
    case 'list-capability-invocations': {
      const query: Record<string, unknown> = {};
      if (system?.connectionId !== undefined && system.connectionId !== null) {
        query['connectionId'] = system.connectionId;
      }
      if (read.outcome !== undefined) {
        query['outcome'] = read.outcome;
      }
      result = await grantsContract.listCapabilityInvocations(ctx, query);
      break;
    }
    case 'get-deep-action':
      result = await deepActionsContract.getDeepAction(ctx, { taskId: target.taskId! });
      break;
    case 'list-deep-actions':
      result = await deepActionsContract.listDeepActions(ctx, {});
      break;
    case 'list-deep-action-events':
      result = await deepActionsContract.listDeepActionEvents(ctx, { taskId: target.taskId! });
      break;
    default:
      throw new Error(`fixture '${state.fixture.fixtureId}': unimplemented contract read '${read.read}'`);
  }

  for (const [path, expected] of Object.entries(read.assert)) {
    const actual = readPath(result, path);
    const pass = assertValueMatches(state, runtime, actual, expected);
    report.contract.push({
      read: read.read,
      path,
      expected: describeValue(expected),
      actual: describeValue(actual),
      pass,
    });
  }
}

function assertValueMatches(
  state: RunState,
  runtime: TenantRuntime,
  actual: unknown,
  expected: unknown,
): boolean {
  if (
    typeof expected === 'object' &&
    expected !== null &&
    !Array.isArray(expected) &&
    Object.keys(expected).length > 0 &&
    Object.keys(expected).every((key) =>
      ['contains', 'containsAll', 'pattern', 'notNull', 'systemRef', 'actorRef'].includes(key),
    )
  ) {
    const matcher = expected as Record<string, unknown>;
    if (matcher['contains'] !== undefined) {
      return typeof actual === 'string' && actual.includes(String(matcher['contains']));
    }
    if (matcher['containsAll'] !== undefined) {
      const fragments = matcher['containsAll'];
      return (
        typeof actual === 'string' &&
        Array.isArray(fragments) &&
        fragments.every((fragment) => actual.includes(String(fragment)))
      );
    }
    if (matcher['pattern'] !== undefined) {
      return typeof actual === 'string' && new RegExp(String(matcher['pattern'])).test(actual);
    }
    if (matcher['notNull'] !== undefined) {
      return actual !== null && actual !== undefined;
    }
    if (matcher['systemRef'] !== undefined) {
      const system = runtime.systems.get(String(matcher['systemRef']));
      return system !== undefined && actual === system.systemId;
    }
    if (matcher['actorRef'] !== undefined) {
      const entry = state.actors.get(`${String(matcher['actorRef'])}-${runtime.key}`) ?? state.actors.get(String(matcher['actorRef']));
      return entry !== undefined && actual === entry.ctx.principalId;
    }
  }
  return deepEqual(actual, expected);
}

function evaluateTransport(
  state: RunState,
  runtime: TenantRuntime,
  probe: TransportProbe,
  global: boolean,
): TransportResult {
  const transport = state.deepTransport;
  // Provider-side probes are scoped to the CURRENT tenant's connections
  // (cross-tenant final steps probe the provider double globally).
  const connectionIds = new Set(
    [...runtime.systems.values()]
      .map((system) => system.connectionId)
      .filter((id): id is string => id !== null),
  );
  const scopedInspect = global
    ? transport.inspectRequests
    : transport.inspectRequests.filter((request) => connectionIds.has(request.connectionId));
  const scopedExecute = global
    ? transport.executeRequests
    : transport.executeRequests.filter((request) => connectionIds.has(request.connectionId));
  switch (probe.probe) {
    case 'execute-call-count': {
      const actual = scopedExecute.length;
      return {
        probe: probe.probe,
        expected: describeValue(probe.expect),
        actual: String(actual),
        pass: actual === probe.expect,
      };
    }
    case 'inspect-call-count': {
      const actual = scopedInspect.length;
      return {
        probe: probe.probe,
        expected: describeValue(probe.expect),
        actual: String(actual),
        pass: actual === probe.expect,
      };
    }
    case 'provider-state': {
      const system = runtime.systems.get(probe.system ?? 'crm');
      const actual =
        system?.connectionId !== undefined && system.connectionId !== null && probe.target !== undefined
          ? transport.stateOf(system.connectionId, probe.target)
          : undefined;
      return {
        probe: `${probe.probe} ${probe.system ?? ''}/${probe.target ?? ''}`,
        expected: describeValue(probe.expect),
        actual: describeValue(actual),
        pass: deepEqual(actual, probe.expect),
      };
    }
    case 'execute-requests-for-target': {
      const requests = scopedExecute.filter((request) => request.target === probe.target);
      const expectation = probe.expect as { count?: number; sameIdempotencyKey?: boolean };
      const first = requests[0];
      const sameKey =
        requests.length >= 2 && requests.every((request) => request.idempotencyKey === first?.idempotencyKey);
      const pass =
        (expectation.count === undefined || requests.length === expectation.count) &&
        (expectation.sameIdempotencyKey !== true || sameKey);
      return {
        probe: `${probe.probe} ${probe.target ?? ''}`,
        expected: describeValue(probe.expect),
        actual: describeValue({ count: requests.length, sameIdempotencyKey: sameKey }),
        pass,
      };
    }
    default:
      return {
        probe: probe.probe,
        expected: describeValue(probe.expect),
        actual: 'unimplemented probe',
        pass: false,
      };
  }
}

async function collectBrowserEvidence(
  state: RunState,
  evidence: BrowserEvidenceSpec[] | undefined,
  report: StepReport,
): Promise<void> {
  if (evidence === undefined) return;
  for (const spec of evidence) {
    let html: string;
    try {
      html = await state.hooks.renderPage(spec.surface, spec.persona);
    } catch (error) {
      report.browser.push({
        surface: spec.surface,
        persona: spec.persona,
        assertion: 'the surface rendered',
        pass: false,
      });
      report.browser.push({
        surface: spec.surface,
        persona: spec.persona,
        assertion: `render error: ${error instanceof Error ? error.message : String(error)}`,
        pass: false,
      });
      continue;
    }
    for (const assertion of spec.assertions) {
      let pass: boolean;
      if (assertion.kind === 'contains') pass = html.includes(assertion.value);
      else if (assertion.kind === 'contains-not') pass = !html.includes(assertion.value);
      else pass = new RegExp(assertion.value).test(html);
      report.browser.push({
        surface: spec.surface,
        persona: spec.persona,
        assertion: `${assertion.kind} ${assertion.value}`,
        pass,
      });
    }
  }
}

/** The column inventory of one table (validates fixture where-clauses). */
async function tableColumnsFor(table: string): Promise<Set<string>> {
  if (TABLE_COLUMNS_CACHE === null) {
    TABLE_COLUMNS_CACHE = new Map();
  }
  const cached = TABLE_COLUMNS_CACHE.get(table);
  if (cached !== undefined) return cached;
  const rows = await getDb().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const columns = new Set(rows.rows.map((row) => row.column_name.toLowerCase()));
  if (columns.size === 0) {
    throw new Error(`durable probe: table '${table}' does not exist in the migrated schema`);
  }
  if (!columns.has('tenant_id')) {
    throw new Error(`durable probe: table '${table}' carries no tenant_id column`);
  }
  TABLE_COLUMNS_CACHE.set(table, columns);
  return columns;
}

// Module-level cache of table columns (the schema is migrated once per file).
let TABLE_COLUMNS_CACHE: Map<string, Set<string>> | null = null;

// ---------------------------------------------------------------------------
// A tiny machine-readable dump for failure diagnostics
// ---------------------------------------------------------------------------

export function formatRunReport(report: FixtureRunReport): string {
  const lines: string[] = [
    `fixture ${report.fixtureId} (${report.fixtureFile}) — schema validated: ${report.schemaValidated}`,
    `tenants: ${report.tenants.map((tenant) => `${tenant.key}=${tenant.tenantId}`).join(', ')}`,
  ];
  for (const step of report.steps) {
    lines.push(`  [${step.tenantKey}/${step.phase}] ${step.title} — ${step.pass ? 'PASS' : 'FAIL'}`);
    for (const invoke of step.invokes) {
      if (!invoke.ok) lines.push(`    invoke FAIL ${invoke.op} as ${invoke.as}: ${invoke.detail ?? ''}`);
    }
    for (const durable of step.durable) {
      if (!durable.pass) {
        lines.push(
          `    durable FAIL ${durable.table}[${durable.tenant}] where ${JSON.stringify(durable.where)}: expected ${durable.expected}, got ${durable.actual}`,
        );
      }
    }
    for (const contract of step.contract) {
      if (!contract.pass) {
        lines.push(
          `    contract FAIL ${contract.read}.${contract.path}: expected ${contract.expected}, got ${contract.actual}`,
        );
      }
    }
    for (const events of step.events) {
      if (!events.pass) {
        lines.push(`    events FAIL expected ${events.expected}, got ${events.actual}`);
      }
    }
    for (const transport of step.transport) {
      if (!transport.pass) {
        lines.push(`    transport FAIL ${transport.probe}: expected ${transport.expected}, got ${transport.actual}`);
      }
    }
    for (const browser of step.browser) {
      if (!browser.pass) {
        lines.push(`    browser FAIL ${browser.surface} as ${browser.persona}: ${browser.assertion}`);
      }
    }
  }
  return lines.join('\n');
}
