// The DETERMINISTIC INCUMBENT DOUBLE (W094) — the scripted
// DeepActionTransport fake the repository's tests execute against (the
// W096 executor's ScriptedDeepActionTransport pattern, the W093
// scripted-browser-driver precedent: a PROVIDER-SIDE fake, never a mock
// of domain logic; no live network, no real incumbent system).
//
// The double models an incumbent system of record reached through ONE
// broker connection:
//   * COLLECTION TARGETS — opaque export paths (e.g. 'export/conversations')
//     served as {records: [...]} canonical states: the batch-import and
//     sync-pass read path;
//   * RECORD TARGETS — the incumbent's own record ids, served as the
//     individual canonical record states;
//   * EXECUTE — Aurum back-writes: the payload merges onto the record
//     (or creates it), with OPAQUE receipt ids and the W084 taxonomy
//     ('accepted' / 'rejected' permanent / 'failed' transient);
//   * idempotency — a repeated execute with the same key replays the
//     original receipt without re-applying (an honoring incumbent);
//   * scripted failure modes — permanent refusal and one-shot transient
//     failure per target;
//   * scripted evolution — the test mutates the incumbent between
//     passes (upsert / mutate / delete), exactly like a live incumbent
//     being worked in during dual-run.
//
// Everything is in-memory and deterministic; nothing here touches the
// database, and the module's service never imports this file (it is
// wired through the deep-actions transport port in tests, and exported
// through the contract for the repository's suites — the first-party
// doubles doctrine).

import type {
  DeepActionExecuteRequest,
  DeepActionInspectRequest,
  DeepActionReceipt,
  DeepActionState,
  DeepActionTransport,
} from '@/modules/deep-actions/contract';

/** One scripted incumbent record (a plain-JSON object with an id). */
export type ScriptedIncumbentRecord = Record<string, unknown>;

export interface ScriptedIncumbentOptions {
  /**
   * Targets the incumbent permanently refuses writes on (the W084
   * 'rejected' receipt — a real data-level conflict for the sync pass).
   */
  refuseWriteTargets?: string[];
  /** Targets that fail ONCE transiently (the W084 'failed' receipt). */
  failOnceTargets?: string[];
}

/**
 * The scripted incumbent system of record behind the deep-action
 * transport port. Seeded per broker connection (the transport requests
 * carry the connection id; the double keeps each connection's store
 * isolated, mirroring the W096 double's keying).
 */
export class ScriptedIncumbent implements DeepActionTransport {
  readonly inspectRequests: DeepActionInspectRequest[] = [];
  readonly executeRequests: DeepActionExecuteRequest[] = [];
  /** The applied back-write receipts by idempotency key (replay proof). */
  readonly receiptsByKey = new Map<string, DeepActionReceipt>();

  private readonly records = new Map<string, Map<string, ScriptedIncumbentRecord>>();
  private readonly collections = new Map<string, Map<string, string[]>>();
  private readonly refuse = new Set<string>();
  private readonly failOnce = new Set<string>();
  private receiptCounter = 0;

  constructor(options: ScriptedIncumbentOptions = {}) {
    this.refuse = new Set(options.refuseWriteTargets ?? []);
    this.failOnce = new Set(options.failOnceTargets ?? []);
  }

  // -- seeding + scripted evolution (the test-side surface) ----------

  private store(connectionId: string): Map<string, ScriptedIncumbentRecord> {
    let store = this.records.get(connectionId);
    if (store === undefined) {
      store = new Map();
      this.records.set(connectionId, store);
    }
    return store;
  }

  /** Seeds one collection target with records (the export surface). */
  seedCollection(
    connectionId: string,
    target: string,
    records: ScriptedIncumbentRecord[],
  ): void {
    const store = this.store(connectionId);
    const ids: string[] = [];
    for (const record of records) {
      const id = String(record['incumbentId']);
      store.set(id, record);
      ids.push(id);
    }
    let byConnection = this.collections.get(connectionId);
    if (byConnection === undefined) {
      byConnection = new Map();
      this.collections.set(connectionId, byConnection);
    }
    // Re-seeding MERGES: scripted incumbent-side growth appends records
    // to an already-served collection (a live incumbent's export grows).
    const existing = byConnection.get(target) ?? [];
    byConnection.set(target, [...existing, ...ids.filter((id) => !existing.includes(id))]);
  }

  /** Upserts one incumbent record (a record-level read target too). */
  upsertRecord(connectionId: string, record: ScriptedIncumbentRecord): void {
    this.store(connectionId).set(String(record['incumbentId']), record);
  }

  /** Mutates one incumbent record (scripted incumbent-side evolution). */
  mutateRecord(
    connectionId: string,
    incumbentId: string,
    patch: Record<string, unknown>,
  ): void {
    const store = this.store(connectionId);
    const current = store.get(incumbentId);
    const base: ScriptedIncumbentRecord =
      current === undefined ? {} : { ...current };
    store.set(incumbentId, { ...base, ...patch });
  }

  /** Deletes one incumbent record (the delete-vs-update path). */
  deleteRecord(connectionId: string, incumbentId: string): void {
    this.store(connectionId).delete(incumbentId);
    for (const byConnection of this.collections.values()) {
      for (const [target, ids] of byConnection) {
        byConnection.set(
          target,
          ids.filter((id) => id !== incumbentId),
        );
      }
    }
  }

  /** Scripts a permanent write refusal for one target (runtime). */
  refuseWritesOn(target: string): void {
    this.refuse.add(target);
  }

  /** Scripts a one-shot transient write failure for one target (runtime). */
  failOnceOn(target: string): void {
    this.failOnce.add(target);
  }

  /** The double's current view of one record (test assertions). */
  recordOf(connectionId: string, incumbentId: string): ScriptedIncumbentRecord | undefined {
    return this.records.get(connectionId)?.get(incumbentId);
  }

  /** The double's current view of one collection (test assertions). */
  collectionOf(connectionId: string, target: string): ScriptedIncumbentRecord[] {
    const ids = this.collections.get(connectionId)?.get(target) ?? [];
    const store = this.store(connectionId);
    return ids
      .map((id) => store.get(id))
      .filter((record): record is ScriptedIncumbentRecord => record !== undefined);
  }

  // -- the DeepActionTransport port (the W084 exit seam) --------------

  async inspect(request: DeepActionInspectRequest): Promise<DeepActionState> {
    this.inspectRequests.push(request);
    const store = this.store(request.connectionId);
    const collection = this.collections.get(request.connectionId)?.get(request.target);
    if (collection !== undefined) {
      const records = collection
        .map((id) => store.get(id))
        .filter((record): record is ScriptedIncumbentRecord => record !== undefined);
      return { found: true, state: { records } };
    }
    const record = store.get(request.target);
    return { found: record !== undefined, state: record ?? null };
  }

  async execute(request: DeepActionExecuteRequest): Promise<DeepActionReceipt> {
    this.executeRequests.push(request);
    // An honoring incumbent: a repeated idempotency key replays the
    // original receipt without re-applying the write.
    const replay = this.receiptsByKey.get(request.idempotencyKey);
    if (replay !== undefined) return replay;

    if (this.refuse.has(request.target)) {
      const receipt: DeepActionReceipt = {
        status: 'rejected',
        receiptId: null,
        detail: 'the incumbent system of record refused the write — permanent',
      };
      this.receiptsByKey.set(request.idempotencyKey, receipt);
      return receipt;
    }
    if (this.failOnce.has(request.target)) {
      this.failOnce.delete(request.target);
      return {
        status: 'failed',
        receiptId: null,
        detail: 'the incumbent system of record timed out — transient',
      };
    }
    this.receiptCounter += 1;
    const receiptId = `inc-rcpt-${this.receiptCounter.toString().padStart(4, '0')}`;
    const payload =
      typeof request.payload === 'object' && request.payload !== null && !Array.isArray(request.payload)
        ? (request.payload as Record<string, unknown>)
        : {};
    const store = this.store(request.connectionId);
    const current = store.get(request.target);
    const base: ScriptedIncumbentRecord = current === undefined ? {} : { ...current };
    store.set(request.target, { ...base, ...payload });
    const receipt: DeepActionReceipt = { status: 'accepted', receiptId, detail: null };
    this.receiptsByKey.set(request.idempotencyKey, receipt);
    return receipt;
  }
}

/** Creates the scripted incumbent double (the fixture factory). */
export function createScriptedIncumbent(
  options: ScriptedIncumbentOptions = {},
): ScriptedIncumbent {
  return new ScriptedIncumbent(options);
}
