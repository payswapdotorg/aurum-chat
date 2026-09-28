// Env-driven reader wiring (W111) — the Family A infrastructure wiring
// of the migration module's REAL reader adapters, in the W108 cellular
// precedent's exact discipline (src/infra/cellular.ts): a
// globalThis-guarded lazy singleton computed once per process at first
// use (Next dev compiles route bundles into separate module registries —
// a module-level variable would diverge per registry, the W058 incident).
//
// ENVIRONMENT CONTRACT (documented for the operator; see
// docs/productization-evidence/W111/):
//
//   MIGRATION_CSV_EXPORT_ROOT  — the private/on-prem incumbent's export
//                                share root (the directory holding the
//                                csv-export-<NNN>/ version directories).
//                                Wires the CSV export-library incumbent
//                                reader into the W094 incumbent-reader
//                                port.
//   MIGRATION_NATIVE_TENANT_ID — the uuid of the tenant whose REAL
//                                world_entities state the native reader
//                                serves (the tenant under migration).
//                                Wires the world-entities native reader
//                                into the W094 native-reader port.
//
// HONESTY CONTRACT: unset, partial or invalid configuration leaves the
// matching port UNWIRED — migration reads then fail explicitly with
// `reader_unavailable` / `native_reader_unavailable` (visible, retryable
// by fixing the environment; never a faked success). The wiring is
// additive: it only ever SETS a port when the environment fully
// describes it, and an explicit setMigration* call after wiring wins
// (tests and specialized deployments compose their own adapters).
//
// INVOCATION: `ensureMigrationReadersWired()` is idempotent per process.
// The resident worker's migration pump composition is the W112
// certification frontier; today the operator (or a deployment entry
// point) invokes it before driving migration lifecycles.

import { envString } from '@/infra/config';
import { setMigrationIncumbentReader, setMigrationNativeReader } from '../service';
import { createCsvExportIncumbentReader } from './csv-export-incumbent-reader';
import { createWorldEntitiesNativeReader } from './world-native-reader';

/** The per-reader wiring outcome (machine-readable, operator-auditable). */
export interface MigrationReaderWiringState {
  reader: 'incumbent-csv-export' | 'native-world-entities';
  state: 'wired' | 'unwired' | 'incomplete';
  detail: string;
}

export interface MigrationReadersWiringReport {
  readers: MigrationReaderWiringState[];
}

interface MigrationReadersWiringGlobal {
  __aurumMigrationReadersWiring?: MigrationReadersWiringReport;
}

const wiringGlobal = globalThis as unknown as MigrationReadersWiringGlobal;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wires the configured real readers ONCE per process (idempotent; the
 * globalThis guard survives Next's per-bundle module registries). Unset
 * or invalid env → the port stays unwired (honest
 * `reader_unavailable` / `native_reader_unavailable`), never
 * half-constructed.
 */
export function ensureMigrationReadersWired(): MigrationReadersWiringReport {
  wiringGlobal.__aurumMigrationReadersWiring ??= wireFromEnv();
  return wiringGlobal.__aurumMigrationReadersWiring;
}

/** Resets the wiring (tests and process shutdown). */
export function resetMigrationReadersWiring(): void {
  wiringGlobal.__aurumMigrationReadersWiring = undefined;
  setMigrationIncumbentReader(null);
  setMigrationNativeReader(null);
}

function wireFromEnv(): MigrationReadersWiringReport {
  const readers: MigrationReaderWiringState[] = [];

  const exportRoot = envString('MIGRATION_CSV_EXPORT_ROOT');
  if (exportRoot === undefined) {
    readers.push({
      reader: 'incumbent-csv-export',
      state: 'unwired',
      detail:
        'no csv export configuration present (MIGRATION_CSV_EXPORT_ROOT unset) — incumbent reads fail honestly with reader_unavailable',
    });
  } else {
    setMigrationIncumbentReader(createCsvExportIncumbentReader({ exportRoot }));
    readers.push({
      reader: 'incumbent-csv-export',
      state: 'wired',
      detail: `csv export-library incumbent reader wired over '${exportRoot}' (versioned csv-export-<NNN> directories, per-row rejection ledger discipline)`,
    });
  }

  const tenantId = envString('MIGRATION_NATIVE_TENANT_ID');
  if (tenantId === undefined) {
    readers.push({
      reader: 'native-world-entities',
      state: 'unwired',
      detail:
        'no native reader configuration present (MIGRATION_NATIVE_TENANT_ID unset) — comparison rounds fail honestly with native_reader_unavailable',
    });
  } else if (!UUID_PATTERN.test(tenantId)) {
    // Invalid configuration is LOUD but safe: the port stays unwired.
    readers.push({
      reader: 'native-world-entities',
      state: 'incomplete',
      detail:
        'MIGRATION_NATIVE_TENANT_ID is set but is not a uuid — the native reader stays unwired (honest native_reader_unavailable); fix the tenant id',
    });
  } else {
    setMigrationNativeReader(createWorldEntitiesNativeReader(tenantId));
    readers.push({
      reader: 'native-world-entities',
      state: 'wired',
      detail: `world-entities native reader wired for tenant '${tenantId}' (reads the real W005 world_entities schema through the db port)`,
    });
  }

  return { readers };
}
