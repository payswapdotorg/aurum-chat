// The edge connectivity surface (W088) — contract-level adapters with
// DETERMINISTIC doubles, no live network (IMPLEMENTATION-STACK §7: the
// fixtures/doubles doctrine). A REAL edge runtime composes real adapters
// (an HTTP client for private APIs and OpenAPI-described endpoints, the
// MCP SDK client for MCP servers, a database driver for on-prem
// databases, a file-system bridge for shares, an approved browser
// automation driver); those live CUSTOMER-SIDE, inside the edge runtime.
// This module ships only the canonical adapter CONTRACT the edge
// implements, plus the deterministic doubles the repository's tests (and
// the in-memory simulator) execute against.
//
// The adapter port is deliberately provider-neutral (lock 16): requests
// are canonical (capability key, opaque target, canonical payload, the
// LOCAL secret reference + scopes — values never appear), results are
// canonical receipts in the W084 taxonomy plus, for inspect reads, the
// normalized state. Adapter implementations record what they were asked
// so tests can prove exactly-once execution.

import type { EdgeConnectivityKind, EdgeReceiptStatus } from '../types';

// ---------------------------------------------------------------------------
// The adapter port
// ---------------------------------------------------------------------------

/** What the runtime hands an adapter (canonical, provider-neutral). */
export interface EdgeAdapterRequest {
  connectivity: EdgeConnectivityKind;
  kind: 'inspect' | 'execute';
  capabilityKey: string;
  /** Opaque external entity reference (adapter-specific meaning). */
  target: string;
  /** The canonical write payload for 'execute' (null for 'inspect'). */
  payload: Record<string, unknown> | null;
  /** The LOCAL secret reference the runtime resolved from its allowlist. */
  secretRef: string | null;
  /** The scopes the referenced secret covers. */
  secretScopes: string[];
}

/** The canonical outcome an adapter returns (the W084 taxonomy). */
export interface EdgeAdapterResult {
  receipt: {
    status: EdgeReceiptStatus;
    receiptId: string | null;
    detail: string | null;
  };
  /** The normalized read state (required for accepted inspect calls). */
  state: { found: boolean; state: unknown } | null;
}

/**
 * One connectivity adapter of the edge runtime — the seam where
 * provider-native protocols live, entirely CUSTOMER-SIDE. The doubles
 * below are the repository's deterministic stand-ins.
 */
export interface EdgeConnectivityAdapter {
  readonly connectivity: EdgeConnectivityKind;
  inspect(request: EdgeAdapterRequest): Promise<EdgeAdapterResult>;
  execute(request: EdgeAdapterRequest): Promise<EdgeAdapterResult>;
}

// ---------------------------------------------------------------------------
// The deterministic core shared by all six doubles
// ---------------------------------------------------------------------------

/**
 * A scripted canonical entity store — the deterministic backbone of every
 * double: inspect reads the target's state (found/not-found), execute
 * merges the payload into it and returns an opaque receipt id. Each
 * double brands its receipt ids with its own prefix, so tests can prove
 * WHICH connectivity executed a job; failures are scriptable per target.
 */
export class ScriptedEntityStore {
  private states = new Map<string, Record<string, unknown>>();
  private receiptCounter = 0;
  /** Targets whose executes fail transiently (one-shot — the resume path). */
  readonly failOnce = new Set<string>();
  /** Targets whose executes are permanently refused. */
  readonly refuse = new Set<string>();
  /** Targets whose executes 'succeed' without changing anything (mismatches). */
  readonly skipApply = new Set<string>();

  constructor(private readonly receiptPrefix: string) {}

  seed(target: string, state: Record<string, unknown>): void {
    this.states.set(target, state);
  }

  stateOf(target: string): Record<string, unknown> | undefined {
    return this.states.get(target);
  }

  async inspect(request: EdgeAdapterRequest): Promise<EdgeAdapterResult> {
    if (this.refuse.has(request.target)) {
      return {
        receipt: { status: 'rejected', receiptId: null, detail: 'refused by policy' },
        state: null,
      };
    }
    const state = this.states.get(request.target);
    return {
      receipt: {
        status: 'accepted',
        receiptId: this.nextReceiptId(),
        detail: null,
      },
      state: { found: state !== undefined, state: state ?? null },
    };
  }

  async execute(request: EdgeAdapterRequest): Promise<EdgeAdapterResult> {
    if (this.refuse.has(request.target)) {
      return {
        receipt: { status: 'rejected', receiptId: null, detail: 'refused by policy' },
        state: null,
      };
    }
    if (this.failOnce.has(request.target)) {
      this.failOnce.delete(request.target);
      return {
        receipt: { status: 'failed', receiptId: null, detail: 'connectivity timeout — transient' },
        state: null,
      };
    }
    this.receiptCounter += 1;
    const receiptId = `${this.receiptPrefix}-${this.receiptCounter.toString().padStart(4, '0')}`;
    if (!this.skipApply.has(request.target)) {
      const current = this.states.get(request.target);
      const base =
        typeof current === 'object' && current !== null && !Array.isArray(current) ? current : {};
      this.states.set(request.target, { ...base, ...(request.payload ?? {}) });
    }
    return {
      receipt: { status: 'accepted', receiptId, detail: null },
      state: null,
    };
  }

  private nextReceiptId(): string {
    this.receiptCounter += 1;
    return `${this.receiptPrefix}-${this.receiptCounter.toString().padStart(4, '0')}`;
  }
}

/** A recording wrapper: every adapter call is captured for test proofs. */
export class RecordingAdapter implements EdgeConnectivityAdapter {
  readonly requests: EdgeAdapterRequest[] = [];
  private inspectCount = 0;
  private executeCount = 0;

  constructor(
    readonly connectivity: EdgeConnectivityKind,
    private readonly inner: EdgeConnectivityAdapter,
  ) {}

  async inspect(request: EdgeAdapterRequest): Promise<EdgeAdapterResult> {
    this.requests.push(request);
    this.inspectCount += 1;
    return this.inner.inspect(request);
  }

  async execute(request: EdgeAdapterRequest): Promise<EdgeAdapterResult> {
    this.requests.push(request);
    this.executeCount += 1;
    return this.inner.execute(request);
  }

  get counts(): { inspect: number; execute: number } {
    return { inspect: this.inspectCount, execute: this.executeCount };
  }
}

// ---------------------------------------------------------------------------
// The six deterministic doubles (one per connectivity kind)
// ---------------------------------------------------------------------------

/**
 * A deterministic double with its scriptable store exposed (tests seed
 * states and script `failOnce` / `refuse` / `skipApply` behavior through
 * `store`).
 */
export interface ScriptedConnectivityDouble extends EdgeConnectivityAdapter {
  readonly store: ScriptedEntityStore;
}

export interface ConnectivityDoubleOptions {
  /** Pre-seeded canonical states, keyed by opaque target. */
  states?: Record<string, Record<string, unknown>>;
}

function doubleOf(
  connectivity: EdgeConnectivityKind,
  options: ConnectivityDoubleOptions,
): ScriptedConnectivityDouble {
  const store = new ScriptedEntityStore(receiptPrefixOf(connectivity));
  for (const [target, state] of Object.entries(options.states ?? {})) {
    store.seed(target, state);
  }
  return {
    connectivity,
    store,
    inspect: (request) => store.inspect(request),
    execute: (request) => store.execute(request),
  };
}

/** Private (on-prem) HTTP APIs — the plain request/reply double. */
export function createPrivateApiDouble(
  options: ConnectivityDoubleOptions = {},
): ScriptedConnectivityDouble {
  return doubleOf('private-api', options);
}

/** OpenAPI-described endpoints — operation-mapped, receipt-branded double. */
export function createOpenApiDouble(
  options: ConnectivityDoubleOptions = {},
): ScriptedConnectivityDouble {
  return doubleOf('openapi', options);
}

/** MCP servers — tool-call double (the tool surface is the capability). */
export function createMcpDouble(options: ConnectivityDoubleOptions = {}): ScriptedConnectivityDouble {
  return doubleOf('mcp', options);
}

/** On-prem databases — the row read / row update double. */
export function createDatabaseDouble(
  options: ConnectivityDoubleOptions = {},
): ScriptedConnectivityDouble {
  return doubleOf('database', options);
}

/** File shares — the file read / file write double. */
export function createFileShareDouble(
  options: ConnectivityDoubleOptions = {},
): ScriptedConnectivityDouble {
  return doubleOf('file-share', options);
}

/** Approved browser adapters — the scripted-session double (W093's seam). */
export function createBrowserDouble(
  options: ConnectivityDoubleOptions = {},
): ScriptedConnectivityDouble {
  return doubleOf('browser', options);
}

function receiptPrefixOf(connectivity: EdgeConnectivityKind): string {
  switch (connectivity) {
    case 'private-api':
      return 'edge-api';
    case 'openapi':
      return 'edge-openapi';
    case 'mcp':
      return 'edge-mcp';
    case 'database':
      return 'edge-db';
    case 'file-share':
      return 'edge-file';
    case 'browser':
      return 'edge-browser';
  }
}

/**
 * The full deterministic adapter set — one double per connectivity kind,
 * each independently seeded/scriptable. The simulator defaults to this
 * set; tests override individual kinds to script behavior.
 */
export function createDeterministicConnectivityAdapters(
  options: Record<EdgeConnectivityKind, ConnectivityDoubleOptions> = {
    'private-api': {},
    openapi: {},
    mcp: {},
    database: {},
    'file-share': {},
    browser: {},
  },
): Record<EdgeConnectivityKind, EdgeConnectivityAdapter> {
  return {
    'private-api': createPrivateApiDouble(options['private-api']),
    openapi: createOpenApiDouble(options.openapi),
    mcp: createMcpDouble(options.mcp),
    database: createDatabaseDouble(options.database),
    'file-share': createFileShareDouble(options['file-share']),
    browser: createBrowserDouble(options.browser),
  };
}

/**
 * Convenience: wraps a set of adapters with call RECORDING (the
 * exactly-once / never-executed proofs). Tests read `records`.
 */
export function recordAdapters(
  adapters: Partial<Record<EdgeConnectivityKind, EdgeConnectivityAdapter>>,
): {
  wrapped: Partial<Record<EdgeConnectivityKind, EdgeConnectivityAdapter>>;
  records: Map<EdgeConnectivityKind, EdgeAdapterRequest[]>;
} {
  const records = new Map<EdgeConnectivityKind, EdgeAdapterRequest[]>();
  const wrapped: Partial<Record<EdgeConnectivityKind, EdgeConnectivityAdapter>> = {};
  for (const [kind, adapter] of Object.entries(adapters) as Array<[EdgeConnectivityKind, EdgeConnectivityAdapter]>) {
    const recorder = new RecordingAdapter(kind, adapter);
    wrapped[kind] = recorder;
    records.set(kind, recorder.requests);
  }
  return { wrapped, records };
}
