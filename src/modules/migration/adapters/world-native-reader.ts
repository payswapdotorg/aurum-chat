// The REAL native Aurum reader adapter (W111) — behind the W094
// MigrationNativeReader port.
//
// WHAT IT READS: the tenant's REAL Aurum world-model state — the
// world_entities table of the W005 world module (the repo's own
// migrations at the base), through the db port. NOT a fixture: real SQL,
// real schema, whatever backend the deployment pins (the embedded
// PGlite PostgreSQL 16 engine by default; node-postgres against a hosted
// Postgres in staging/production).
//
// KEYING: the comparison's join key is the Aurum entity id, so states are
// keyed by world_entities.id. The migration module's commit mints the
// identifier map's aurum_entity_id values; the native side's catch-up
// (the customer's native-side import tool, or the operator's world-model
// entry) carries THOSE minted ids as world_entities.id — convergence then
// rides the same mirror discipline the W094 fixture-native double models
// (native catch-up carrying the identifier map's minted ids).
//
// THE STATE SHAPE: a world entity's canonical current state is its
// `attributes` object — the W005 "mutable current picture" column (kind,
// category and name are classification metadata, not state; temporal
// versioning of this state is W006's separate scope). The comparison's
// convergence therefore requires world_entities.attributes to equal the
// incumbent-imported payload — exactly what the native catch-up writes.
//
// TENANCY: the port request carries no tenant (the W094 port shape is
// frozen), so the adapter is CONSTRUCTED with its tenant binding — the
// env-driven wiring (env-wiring.ts) wires one native reader per process
// for the tenant under migration (the same per-process wiring posture as
// every other infrastructure seam in this module).
//
// HONESTY: an entity the caller asks for that does not exist is simply
// absent from the answer (the comparison surfaces it as 'native-missing'
// — never faked here). Nothing is wired by default; the module fails
// explicitly with `native_reader_unavailable` when no adapter is set.

import { getDb, type DbRow } from '@/infra/db';
import type {
  MigrationNativeReader,
  NativeStateReadRequest,
  NativeStateReadResult,
} from '../types';

interface WorldEntityRow extends DbRow {
  id: string;
  attributes: Record<string, unknown>;
}

/** The tenant-bound real world-entities native reader. */
export interface WorldEntitiesNativeReader extends MigrationNativeReader {
  /** Every readNativeStates request, in order (the wiring proofs). */
  readonly requests: readonly NativeStateReadRequest[];
}

/**
 * Creates the native reader for ONE tenant's world entities. Reads are
 * tenant-scoped SQL by construction (WHERE tenant_id = $1); entities of
 * other tenants are indistinguishable from absent.
 */
export function createWorldEntitiesNativeReader(tenantId: string): WorldEntitiesNativeReader {
  const requests: NativeStateReadRequest[] = [];
  return {
    requests,
    async readNativeStates(request: NativeStateReadRequest): Promise<NativeStateReadResult> {
      requests.push(request);
      const db = getDb();
      // entityIds null = the COMPLETE current native state set (so
      // native-only entities surface as 'incumbent-missing' divergences).
      const rows =
        request.entityIds === null
          ? (
              await db.query<WorldEntityRow>(
                `SELECT id, attributes FROM world_entities
                   WHERE tenant_id = $1 ORDER BY id`,
                [tenantId],
              )
            ).rows
          : (
              await db.query<WorldEntityRow>(
                `SELECT id, attributes FROM world_entities
                   WHERE tenant_id = $1 AND id::text = ANY($2::text[]) ORDER BY id`,
                [tenantId, [...new Set(request.entityIds)]],
              )
            ).rows;
      return {
        states: rows.map((row) => ({
          aurumEntityId: row.id,
          state: row.attributes ?? {},
        })),
      };
    },
  };
}
