// The DETERMINISTIC INCUMBENT DOUBLE (W094) — the repository's fixture
// incumbent system (the computer-use scripted-driver and edge-connector
// in-memory-runtime precedent: first-party doubles are exported through
// the contract). NO live network, NO real incumbent (the fixtures/doubles
// doctrine). A REAL incumbent reader is an environment-dependent adapter
// (SaaS incumbents compose broker-backed reads, private/on-prem
// incumbents compose the Edge Connector boundary) — deliberately not
// exercised against any live system by this repository's test suite.
//
// What the double models (deterministically, in memory):
//   * VERSIONED SNAPSHOTS — the incumbent's state advances in numbered
//     immutable versions (`fixsnap-<n>`); a delta read returns the exact
//     diff between the referenced version and the latest committed one,
//     with tombstones for records the incumbent deleted. With no churn
//     between rounds the diff is empty and the reference stands still —
//     the "nothing changed" dual-run window.
//   * CHURN BETWEEN ROUNDS — `churn()` applies a deterministic
//     adds-updates-deletes wave and commits a new version (test-side, the
//     "the incumbent kept moving during dual-run" behavior).
//   * THE READ-ONLY PORT — the double implements MigrationIncumbentReader
//     and NOTHING else: there is no write method to call. Every request
//     is recorded (connectionId, credentialRef, systemKey,
//     readCapabilityKey, sinceSnapshotRef) so tests can prove the W082
//     opaque-credentialRef discipline passes straight through and that
//     delta rounds carry the last committed round's snapshot reference.
//
// The companion NATIVE double models the tenant's native Aurum state for
// comparison rounds, with a `mirror` helper that copies the incumbent's
// current records through a committed identifier map — the dual-run
// test's both-sides setup, with seeded divergences as explicit overrides.

import { MigrationError } from './errors';
import type {
  IncumbentRecord,
  IncumbentSnapshotRequest,
  IncumbentSnapshotResult,
  MigrationIncumbentReader,
  MigrationNativeReader,
  NativeStateReadRequest,
  NativeStateReadResult,
} from './types';

/** One entity of the fixture incumbent's state. */
export interface FixtureIncumbentEntity {
  externalId: string;
  matchKey: string | null;
  entityType: string | null;
  payload: Record<string, unknown>;
}

/** A deterministic churn wave (applied atomically, then versioned). */
export interface FixtureChurn {
  /** Records added or updated by external id. */
  upserts: FixtureIncumbentEntity[];
  /** External ids the incumbent deleted (tombstoned). */
  deletions: string[];
  /** Strict ISO 8601 — the tombstone timestamps (one per deletion). */
  deletedAt: string;
}

const SNAPSHOT_REF_PATTERN = /^fixsnap-(\d+)$/;

/**
 * The deterministic incumbent double — implements the read-only
 * MigrationIncumbentReader port with versioned snapshots, deterministic
 * churn and full request recording. See the file header; NO network, NO
 * real incumbent.
 */
export class FixtureIncumbent implements MigrationIncumbentReader {
  /** Every readSnapshot request, in order (the pass-through proofs). */
  readonly requests: IncumbentSnapshotRequest[] = [];

  private readonly versions: Array<Map<string, FixtureIncumbentEntity>> = [];
  private readonly deletedAtByVersion = new Map<number, Map<string, string>>();
  private working = new Map<string, FixtureIncumbentEntity>();

  constructor(entities: readonly FixtureIncumbentEntity[] = []) {
    for (const entity of entities) {
      this.working.set(entity.externalId, { ...entity });
    }
    this.commitVersion();
  }

  // -- the versioned state (test-side controls) ----------------------------

  /** Commits the current working state as the next immutable version. */
  commitVersion(): string {
    this.versions.push(new Map(this.working));
    return this.currentVersionRef();
  }

  /** The reference of the latest committed version. */
  currentVersionRef(): string {
    return `fixsnap-${this.versions.length - 1}`;
  }

  /** Applies a deterministic churn wave and commits a new version. */
  churn(wave: FixtureChurn): string {
    for (const entity of wave.upserts) {
      this.working.set(entity.externalId, { ...entity });
    }
    const tombstones = new Map<string, string>();
    for (const externalId of wave.deletions) {
      if (this.working.delete(externalId)) {
        tombstones.set(externalId, wave.deletedAt);
      }
    }
    const version = this.versions.length;
    this.deletedAtByVersion.set(version, tombstones);
    return this.commitVersion();
  }

  /** Upserts into the working state WITHOUT committing a version. */
  seed(entities: readonly FixtureIncumbentEntity[]): void {
    for (const entity of entities) {
      this.working.set(entity.externalId, { ...entity });
    }
  }

  /** The live entities of the latest committed version (read-only copy). */
  liveEntities(): FixtureIncumbentEntity[] {
    const latest = this.versions[this.versions.length - 1]!;
    return [...latest.values()].map((entity) => ({ ...entity }));
  }

  /** The entity of the latest committed version (null = absent). */
  entityOf(externalId: string): FixtureIncumbentEntity | null {
    const latest = this.versions[this.versions.length - 1]!;
    const entity = latest.get(externalId);
    return entity === undefined ? null : { ...entity };
  }

  private versionOf(ref: string | null): number {
    if (ref === null) return -1;
    const match = SNAPSHOT_REF_PATTERN.exec(ref);
    if (match === null) {
      throw new MigrationError(
        'invalid_reader_result',
        `the fixture incumbent does not know snapshot reference '${ref}'`,
      );
    }
    const version = Number.parseInt(match[1]!, 10);
    if (version < 0 || version >= this.versions.length) {
      throw new MigrationError(
        'invalid_reader_result',
        `the fixture incumbent has no version ${version} (latest is ${this.versions.length - 1})`,
      );
    }
    return version;
  }

  // -- the port (read-only; there is no write method to call) --------------

  async readSnapshot(request: IncumbentSnapshotRequest): Promise<IncumbentSnapshotResult> {
    this.requests.push(request);
    const since = this.versionOf(request.sinceSnapshotRef);
    const latest = this.versions.length - 1;
    const current = this.versions[latest]!;
    const sinceState = since >= 0 ? this.versions[since]! : new Map<string, FixtureIncumbentEntity>();
    const records: IncumbentRecord[] = [];

    // Changed or added records, in deterministic external-id order.
    const changedIds = [...current.keys()]
      .filter((externalId) => {
        const before = sinceState.get(externalId);
        const after = current.get(externalId);
        return before === undefined || JSON.stringify(before) !== JSON.stringify(after);
      })
      .sort();
    for (const externalId of changedIds) {
      const entity = current.get(externalId)!;
      records.push({
        externalId: entity.externalId,
        matchKey: entity.matchKey,
        entityType: entity.entityType,
        payload: { ...entity.payload },
        deletedAt: null,
      });
    }

    // Tombstones: records the incumbent deleted since the base version
    // (deduplicated across waves — a record deleted, re-added and deleted
    // again is one tombstone per read).
    const tombstoned = new Set<string>();
    for (let version = since + 1; version <= latest; version += 1) {
      const tombstones = this.deletedAtByVersion.get(version);
      if (tombstones === undefined) continue;
      for (const [externalId, deletedAt] of [...tombstones.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        if (!tombstoned.has(externalId) && sinceState.has(externalId) && !current.has(externalId)) {
          tombstoned.add(externalId);
          records.push({
            externalId,
            matchKey: null,
            entityType: null,
            payload: null,
            deletedAt,
          });
        }
      }
    }

    return { snapshotRef: this.currentVersionRef(), records };
  }
}

/** A seeded divergence applied by the native mirror (explicit, visible). */
export interface FixtureNativeDivergence {
  /** The incumbent external id whose mirrored native state diverges. */
  externalId: string;
  /** Field overrides merged into the mirrored native state. */
  override: Record<string, unknown>;
  /** Fields removed from the mirrored native state. */
  remove?: string[];
}

/**
 * The deterministic NATIVE-state double — implements the
 * MigrationNativeReader port: the tenant's native Aurum state, in memory.
 * `mirror` copies the fixture incumbent's current records through a
 * committed identifier map (external id → Aurum entity id), optionally
 * seeding explicit divergences — the dual-run comparison's both-sides
 * setup.
 */
export class FixtureNativeStore implements MigrationNativeReader {
  /** Every readNativeStates request, in order. */
  readonly requests: NativeStateReadRequest[] = [];

  private readonly states = new Map<string, Record<string, unknown>>();

  setEntity(aurumEntityId: string, state: Record<string, unknown>): void {
    this.states.set(aurumEntityId, { ...state });
  }

  removeEntity(aurumEntityId: string): void {
    this.states.delete(aurumEntityId);
  }

  entityIds(): string[] {
    return [...this.states.keys()].sort();
  }

  stateOf(aurumEntityId: string): Record<string, unknown> | null {
    const state = this.states.get(aurumEntityId);
    return state === undefined ? null : { ...state };
  }

  /**
   * Mirrors the incumbent's current records into native states through a
   * committed identifier map — with optional seeded divergences (explicit
   * overrides/removals, never silent).
   */
  mirror(
    incumbent: FixtureIncumbent,
    map: ReadonlyArray<{ externalId: string; aurumEntityId: string }>,
    divergences: readonly FixtureNativeDivergence[] = [],
  ): void {
    const overridesByExternalId = new Map(divergences.map((entry) => [entry.externalId, entry]));
    for (const entry of map) {
      const entity = incumbent.entityOf(entry.externalId);
      if (entity === null) continue;
      const state: Record<string, unknown> = { ...entity.payload };
      const divergence = overridesByExternalId.get(entry.externalId);
      if (divergence !== undefined) {
        for (const field of divergence.remove ?? []) {
          delete state[field];
        }
        Object.assign(state, divergence.override);
      }
      this.setEntity(entry.aurumEntityId, state);
    }
  }

  async readNativeStates(request: NativeStateReadRequest): Promise<NativeStateReadResult> {
    this.requests.push(request);
    const ids =
      request.entityIds === null
        ? [...this.states.keys()].sort()
        : [...new Set(request.entityIds)].sort();
    return {
      states: ids
        .filter((id) => this.states.has(id))
        .map((id) => ({ aurumEntityId: id, state: { ...this.states.get(id)! } })),
    };
  }
}
