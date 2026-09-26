// Integration tests for the migration-continuity module against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port. Covers
// the W094 acceptance end-to-end through the REAL contracts:
//
// "customer can run incumbent and Aurum in parallel; conflicts are
//  surfaced; rollback is possible; no silent data loss or duplicate
//  authority."
//
//  * THE FULL LIFECYCLE — staged -> imported -> dual-running ->
//    retiring-incumbent -> retired: the incumbent enters through the
//    real W081 discovery > recommendation > approval > connection
//    chain on a real W082 broker connection; history lands through
//    the owning modules' public writes (conversations, people,
//    observations — kit-declared kinds onto the installed W092 kit,
//    unmapped kinds as raw evidence); every kind retires progressively
//    behind a clean reconcile-based comparison;
//  * IDENTIFIER PRESERVATION — the durable incumbent <-> Aurum map
//    with verified states; an AMBIGUOUS person record stays
//    `unverified-external` and is NEVER auto-merged (the W095
//    discipline) until a claim-gated human resolution;
//  * DUAL-RUN CONFLICTS — the same logical record touched on both
//    sides surfaces a conflict with BOTH versions, timestamps,
//    provenance and the W084 reconciliation diff, and is NEVER
//    auto-resolved (retirement stays gated until the human decides and
//    the systems converge);
//  * BACK-WRITES — Aurum-side advances back-write through the W084
//    transport behind the W083 gate: accepted (the incumbent converges),
//    refused (a surfaced conflict), transient (retried by the next
//    pass), and blocked-by-governance (surfaced, not silent);
//  * NO SILENT DATA LOSS — manifests record counts in/out and content
//    checksums; a mid-batch landing failure is a HARD
//    `import_integrity_mismatch` with the manifest left 'mismatch';
//    re-running replays through the identity map (no duplicates); and
//    the integrity probe re-derives manifest-vs-landed later (a lost
//    row or a corrupted count is the hard refusal);
//  * ROLLBACK — mid-flight (retiring-incumbent -> dual-running, the
//    window rolls back, incumbent authority restored, evidence
//    retained) and from `retired` (the window RE-OPENS as a new row);
//  * INCUMBENT AUTHORITY — during dual-run the incumbent is the
//    authority of record; authority transfers to Aurum EXACTLY at the
//    completed retirement window, per kind (progressive);
//  * COMPARISON THROUGH RECONCILE — the report rows carry the W084
//    OperationReconciliation verdicts verbatim;
//  * TENANT ISOLATION — compact (the W044 sweep carries the full
//    proof);
//  * STATE DISCIPLINE — wrong-phase calls, missing transport, nothing
//    to roll back, bad capability keys.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { runMigrations } from '../../../../scripts/migrate';
import * as sourcesContract from '@/modules/sources/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as deepActionsContract from '@/modules/deep-actions/contract';
import * as verticalKitsContract from '@/modules/vertical-kits/contract';
import * as conversationsContract from '@/modules/conversations/contract';
import * as peopleContract from '@/modules/people/contract';
import * as observationsContract from '@/modules/observations/contract';
import { MigrationContinuityError } from '../errors';
import * as migrationContinuity from '../contract';
import { createScriptedIncumbent, type ScriptedIncumbent } from '../double';
import {
  ScriptedBrokerBackend,
  ScriptedDirectoryTransport,
  ScriptedVerificationTransport,
  connectIncumbent,
  grantWriteCapability,
  memberOf,
} from './doubles';

const {
  stageMigration,
  runImport,
  startDualRun,
  runSyncPass,
  compareMigration,
  openRetirementWindow,
  completeRetirement,
  rollbackMigration,
  resolveMappingAmbiguity,
  resolveConflict,
  getMigration,
  listMigrations,
  getMigrationStatus,
  authorityOf,
  listMigrationTransitions,
  listImportManifests,
  verifyImportIntegrity,
  listIdentityMappings,
  listConflicts,
  listRetirementWindows,
  listMigrationEvents,
} = migrationContinuity;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = newId();
const OTHER_TENANT = newId();

const admin = memberOf(TENANT, ['integration-intelligence:administer']);
const member = memberOf(TENANT, []);
const approver = memberOf(TENANT, ['actions:approve']);
const kitAdmin = memberOf(TENANT, ['vertical-kits:administer']);
const migrationAdmin = memberOf(TENANT, ['migration-continuity:administer']);
const otherMember = memberOf(OTHER_TENANT, ['migration-continuity:administer']);

const READ_CAPABILITY = 'read.customer-records';
const WRITE_CAPABILITY = 'write.customer-records';

let directory: ScriptedDirectoryTransport;
let brokerBackend: ScriptedBrokerBackend;
let incumbent: ScriptedIncumbent;
let system: integrationContract.InventorySystem;
let connection: brokerContract.BrokerConnection;

function conversationRecord(
  incumbentId: string,
  subject: string,
  turns: { turnId: string; text: string; direction?: 'inbound' | 'outbound' }[],
): Record<string, unknown> {
  return {
    incumbentId,
    updatedAt: '2026-10-05T09:00:00Z',
    channel: 'email',
    subject,
    turns: turns.map((turn) => ({
      turnId: turn.turnId,
      direction: turn.direction ?? 'inbound',
      actorLabel: 'Dana Ruiz (customer)',
      sentAt: '2026-10-04T09:00:00Z',
      payload: { text: turn.text },
    })),
  };
}

function personRecord(incumbentId: string, fullName: string, email: string): Record<string, unknown> {
  return { incumbentId, updatedAt: '2026-10-05T09:00:00Z', fullName, email };
}

async function expectCode(
  code: MigrationContinuityError['code'],
  fn: () => Promise<unknown>,
): Promise<MigrationContinuityError> {
  try {
    await fn();
    throw new Error(`expected MigrationContinuityError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof MigrationContinuityError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

/** Stages + imports + starts the dual run of one fresh migration. */
async function migrationAt(
  batches: { target: string; entityKind: string }[],
  options: { writeCapability?: boolean; idempotencyKey?: string } = {},
): Promise<string> {
  const staged = await stageMigration(member, {
    systemId: system.id,
    connectionId: connection.id,
    readCapabilityKey: READ_CAPABILITY,
    writeCapabilityKey: options.writeCapability === false ? null : WRITE_CAPABILITY,
    taskContext: {
      description: 'the W094 integration migration of the incumbent system of record',
      requestedFor: 'the migration program',
    },
    batches,
    idempotencyKey: options.idempotencyKey ?? null,
  });
  await runImport(member, { migrationId: staged.migration.id });
  await startDualRun(member, { migrationId: staged.migration.id });
  return staged.migration.id;
}

/** Records one Aurum-side turn into a mapped conversation (live Aurum use). */
async function recordAurumSideTurn(
  conversationId: string,
  providerMessageId: string,
  text: string,
): Promise<void> {
  await conversationsContract.recordMessage(member, {
    conversationId,
    direction: 'outbound',
    actor: { kind: 'system', label: 'Aurum workplace' },
    channel: 'email',
    payload: { text },
    sentAt: '2026-10-06T12:00:00Z',
    providerMessageId,
  });
}

// ---------------------------------------------------------------------------
// The setup: migrations, the wired doubles, the REAL entry chain, the kit
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await runMigrations(getDb());

  directory = new ScriptedDirectoryTransport();
  brokerBackend = new ScriptedBrokerBackend();
  incumbent = createScriptedIncumbent();

  sourcesContract.setSourceTransport(directory);
  integrationContract.setVerificationTransport(new ScriptedVerificationTransport());
  brokerContract.wireConnectionBrokers([
    brokerContract.createEmbeddedBroker({
      baseUrl: 'https://broker.unit.example',
      apiToken: ['emb_', 'test', '_token'].join(''),
      httpClient: brokerBackend,
    }),
  ]);
  deepActionsContract.setDeepActionTransport(incumbent);

  // The incumbent enters through the REAL W081/W082/W083 chain (the
  // W096 fixture chain verbatim).
  const connected = await connectIncumbent(
    { admin, member, approver },
    {
      externalId: 'inc-legacy-suite',
      displayName: 'Legacy Suite',
      capabilityClasses: ['customer-records'],
    },
    { connectionKey: 'legacy-suite', directory },
  );
  system = connected.system;
  connection = connected.connection;
  expect(connection.status).toBe('connected');

  // The write capability the back-writes invoke (W083 ask + W009 grant).
  await grantWriteCapability(
    { member, approver },
    {
      connectionId: connection.id,
      capabilityKey: WRITE_CAPABILITY,
      taskDescription: 'the W094 integration migration of the incumbent system of record',
    },
  );

  // The vertical kit that declares the 'matter' entity kind (W092).
  const registered = await verticalKitsContract.registerKitVersion(kitAdmin, {
    manifest: verticalKitsContract.LEGAL_CASE_MANAGEMENT_KIT,
  });
  const verification = await verticalKitsContract.runKitVerification(kitAdmin, {
    kitVersionId: registered.version.id,
  });
  expect(verification.outcome).toBe('verified');
  const installed = await verticalKitsContract.installKit(kitAdmin, {
    kitKey: registered.version.kitKey,
    version: registered.version.version,
    justification: 'the incumbent matters map onto the legal case management kit',
  });
  await verticalKitsContract.decideKitReview(approver, {
    installationId: installed.installation.id,
    decision: 'approve',
    note: 'the kit declares the entity kinds the migration maps onto',
  });
  await verticalKitsContract.activateKit(kitAdmin, { installationId: installed.installation.id });
});

afterAll(async () => {
  sourcesContract.setSourceTransport(null);
  integrationContract.setVerificationTransport(null);
  brokerContract.wireConnectionBrokers(null);
  deepActionsContract.setDeepActionTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

describe('W094 — the full lifecycle through the real contracts', () => {
  it('stages through the real W081/W082 seams (idempotently), imports through the owning contracts, dual-runs, retires progressively and transfers authority exactly at the windows', async () => {
    incumbent.seedCollection(connection.id, 'export/conversations', [
      conversationRecord('C-101', 'Renewal discussion', [{ turnId: 'C-101#1', text: 'Can we renew?' }]),
    ]);
    incumbent.seedCollection(connection.id, 'export/people', [
      personRecord('P-9', 'Dana Ruiz', 'dana@ruiz.example'),
    ]);
    incumbent.seedCollection(connection.id, 'export/matters', [
      { incumbentId: 'M-77', updatedAt: '2026-10-05T09:00:00Z', title: 'Acme v. Beta', status: 'open' },
    ]);
    incumbent.seedCollection(connection.id, 'export/warehouse-slots', [
      { incumbentId: 'W-1', updatedAt: '2026-10-05T09:00:00Z', rack: 'A7', bin: '3' },
    ]);

    // STAGED — the manifests are drafted; the replay is idempotent.
    const staged = await stageMigration(member, {
      systemId: system.id,
      connectionId: connection.id,
      readCapabilityKey: READ_CAPABILITY,
      writeCapabilityKey: WRITE_CAPABILITY,
      taskContext: { description: 'the W094 lifecycle migration', requestedFor: 'the migration program' },
      batches: [
        { target: 'export/conversations', entityKind: 'conversation' },
        { target: 'export/people', entityKind: 'person' },
        { target: 'export/matters', entityKind: 'matter' },
        { target: 'export/warehouse-slots', entityKind: 'warehouse-slot' },
      ],
      idempotencyKey: 'w094-lifecycle',
    });
    expect(staged.migration.state).toBe('staged');
    expect(staged.batches).toHaveLength(4);
    expect(staged.batches.every((batch) => batch.status === 'planned')).toBe(true);
    const replay = await stageMigration(member, {
      systemId: system.id,
      connectionId: connection.id,
      readCapabilityKey: READ_CAPABILITY,
      taskContext: { description: 'the W094 lifecycle migration' },
      batches: [{ target: 'export/conversations', entityKind: 'conversation' }],
      idempotencyKey: 'w094-lifecycle',
    });
    expect(replay.migration.id).toBe(staged.migration.id);

    // IMPORTED — history landed through the REAL owning contracts.
    const imported = await runImport(member, { migrationId: staged.migration.id });
    expect(imported.migration.state).toBe('imported');
    const manifests = imported.batches;
    const byKind = new Map(manifests.map((manifest) => [manifest.entityKind, manifest]));
    expect(byKind.get('conversation')).toMatchObject({
      status: 'ok',
      resolution: 'conversation',
      contractWrite: 'conversations.recordMessage',
      expectedCount: 1,
      landedCount: 1,
      sourceChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      landedChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(byKind.get('person')).toMatchObject({
      status: 'ok',
      resolution: 'person',
      contractWrite: 'people.createPerson',
      expectedCount: 1,
      landedCount: 1,
    });
    expect(byKind.get('matter')).toMatchObject({
      status: 'ok',
      resolution: 'kit-kind',
      kitKey: 'legal-case-management',
      kitEntity: 'matter',
    });
    expect(byKind.get('warehouse-slot')).toMatchObject({ status: 'ok', resolution: 'raw-evidence' });

    // The landed rows are REAL rows in the owning modules' tables.
    const mappings = await listIdentityMappings(member, { migrationId: staged.migration.id });
    expect(mappings).toHaveLength(4);
    expect(mappings.every((mapping) => mapping.verificationState === 'verified')).toBe(true);
    const convMapping = mappings.find((mapping) => mapping.incumbentId === 'C-101')!;
    expect(convMapping.aurumKind).toBe('conversation');
    const messages = await conversationsContract.listMessages(member, {
      conversationId: convMapping.aurumId!,
      limit: 10,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.providerMessageId).toBe('C-101#1');
    expect(messages[0]!.actor.label).toBe('Dana Ruiz (customer)');

    const personMapping = mappings.find((mapping) => mapping.incumbentId === 'P-9')!;
    const person = await peopleContract.getPerson(member, personMapping.aurumId!);
    expect(person.fullName).toBe('Dana Ruiz');

    const matterMapping = mappings.find((mapping) => mapping.incumbentId === 'M-77')!;
    const matter = await observationsContract.getObservation(member, matterMapping.aurumId!);
    expect(matter.kind).toBe('vertical-kit.legal-case-management.matter');

    const slotMapping = mappings.find((mapping) => mapping.incumbentId === 'W-1')!;
    const slot = await observationsContract.getObservation(member, slotMapping.aurumId!);
    expect(slot.kind).toBe('migration-continuity.raw');
    expect((slot.payload as { incumbentKind: string }).incumbentKind).toBe('warehouse-slot');

    // The integrity probe re-derives manifest-vs-landed: clean.
    const integrity = await verifyImportIntegrity(member, { migrationId: staged.migration.id });
    expect(integrity.ok).toBe(true);
    expect(integrity.manifestsChecked).toBe(4);
    expect(integrity.landedRecordsChecked).toBe(4);

    // DUAL-RUNNING — the incumbent remains the authority of record.
    const dual = await startDualRun(member, { migrationId: staged.migration.id });
    expect(dual.migration.state).toBe('dual-running');
    for (const kind of ['conversation', 'person', 'matter', 'warehouse-slot']) {
      const authority = await authorityOf(member, { migrationId: staged.migration.id, entityKind: kind });
      expect(authority.authority).toBe('incumbent');
    }
    const sync = await runSyncPass(member, { migrationId: staged.migration.id });
    expect(sync.recordsRead).toBe(4);
    expect(sync.conflictsDetected).toBe(0);

    // RETIRING — progressive, per kind, behind clean comparisons.
    const conversationReport = await compareMigration(member, {
      migrationId: staged.migration.id,
      entityKind: 'conversation',
    });
    expect(conversationReport.clean).toBe(true);
    expect(conversationReport.matchedCount).toBe(1);

    const window = await openRetirementWindow(member, {
      migrationId: staged.migration.id,
      entityKind: 'conversation',
    });
    expect(window.status).toBe('open');
    expect((await getMigration(member, { migrationId: staged.migration.id })).migration.state).toBe(
      'retiring-incumbent',
    );
    // The window is OPEN: the incumbent is STILL the authority.
    expect(
      (await authorityOf(member, { migrationId: staged.migration.id, entityKind: 'conversation' })).authority,
    ).toBe('incumbent');

    const retiredConversation = await completeRetirement(member, {
      migrationId: staged.migration.id,
      entityKind: 'conversation',
    });
    expect(retiredConversation.window.status).toBe('retired');
    expect(retiredConversation.migration.state).toBe('retiring-incumbent'); // other kinds remain
    // Authority transferred EXACTLY at the completed window — per kind.
    expect(
      (await authorityOf(member, { migrationId: staged.migration.id, entityKind: 'conversation' })).authority,
    ).toBe('aurum');
    expect(
      (await authorityOf(member, { migrationId: staged.migration.id, entityKind: 'person' })).authority,
    ).toBe('incumbent');

    for (const kind of ['person', 'matter', 'warehouse-slot']) {
      const report = await compareMigration(member, { migrationId: staged.migration.id, entityKind: kind });
      expect(report.clean).toBe(true);
      await openRetirementWindow(member, { migrationId: staged.migration.id, entityKind: kind });
      await completeRetirement(member, { migrationId: staged.migration.id, entityKind: kind });
    }

    // RETIRED — Aurum holds every kind; the ledger holds the trail.
    const final = await getMigrationStatus(member, { migrationId: staged.migration.id });
    expect(final.migration.state).toBe('retired');
    expect(final.authorityByKind.every((entry) => entry.authority === 'aurum')).toBe(true);
    const transitions = await listMigrationTransitions(member, { migrationId: staged.migration.id });
    expect(transitions.map((transition) => `${transition.fromState}->${transition.toState}`)).toEqual([
      'null->staged',
      'staged->imported',
      'imported->dual-running',
      'dual-running->retiring-incumbent',
      'retiring-incumbent->retired',
    ]);
    const events = await listMigrationEvents(member, { migrationId: staged.migration.id });
    expect(events.some((event) => event.event === 'authority-transferred')).toBe(true);
    expect(events.some((event) => event.event === 'retired')).toBe(true);
  });
});

describe('W094 — rollback, mid-flight and from retired', () => {
  it('a mid-flight rollback restores dual-running, rolls the window back, restores incumbent authority and retains the evidence', async () => {
    incumbent.seedCollection(connection.id, 'export/rollback-conversations', [
      conversationRecord('C-201', 'Pricing', [{ turnId: 'C-201#1', text: 'The quote looks good.' }]),
    ]);
    const migrationId = await migrationAt([{ target: 'export/rollback-conversations', entityKind: 'conversation' }]);

    const report = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(report.clean).toBe(true);
    await openRetirementWindow(member, { migrationId, entityKind: 'conversation' });
    expect((await getMigration(member, { migrationId })).migration.state).toBe('retiring-incumbent');

    // MID-FLIGHT ROLLBACK (claim-gated).
    const rolled = await rollbackMigration(migrationAdmin, {
      migrationId,
      reason: 'the incumbent reported a data issue during the retirement window',
    });
    expect(rolled.migration.state).toBe('dual-running');
    const windows = await listRetirementWindows(member, { migrationId });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.status).toBe('rolled-back');
    // Incumbent authority RESTORED for the kind.
    expect((await authorityOf(member, { migrationId, entityKind: 'conversation' })).authority).toBe(
      'incumbent',
    );
    // The evidence trail is RETAINED (the rollback is itself a row).
    const transitions = await listMigrationTransitions(member, { migrationId });
    const lastTransition = transitions[transitions.length - 1]!;
    expect(lastTransition.kind).toBe('rollback');
    expect(lastTransition.fromState).toBe('retiring-incumbent');
    expect(lastTransition.toState).toBe('dual-running');
    expect(lastTransition.evidence).toMatchObject({
      windowsRolledBack: [{ entityKind: 'conversation', sequence: 1 }],
    });
    const events = await listMigrationEvents(member, { migrationId });
    expect(events.some((event) => event.event === 'rollback')).toBe(true);
    expect(events.some((event) => event.event === 'retirement-window-opened')).toBe(true);

    // Re-open and complete: the window retires on the next sequence.
    const fresh = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(fresh.clean).toBe(true);
    const reopened = await openRetirementWindow(member, { migrationId, entityKind: 'conversation' });
    expect(reopened.sequence).toBe(2);
    const completed = await completeRetirement(member, { migrationId, entityKind: 'conversation' });
    expect(completed.window.sequence).toBe(2);
    expect(completed.window.status).toBe('retired');
    expect(completed.migration.state).toBe('retired');
  });

  it('a rollback from retired re-opens the window as a NEW row and restores incumbent authority for that kind', async () => {
    incumbent.seedCollection(connection.id, 'export/retired-rollback-conversations', [
      conversationRecord('C-301', 'Onboarding', [{ turnId: 'C-301#1', text: 'Welcome aboard.' }]),
    ]);
    const migrationId = await migrationAt([
      { target: 'export/retired-rollback-conversations', entityKind: 'conversation' },
    ]);
    await compareMigration(member, { migrationId, entityKind: 'conversation' });
    await openRetirementWindow(member, { migrationId, entityKind: 'conversation' });
    const completed = await completeRetirement(member, { migrationId, entityKind: 'conversation' });
    expect(completed.migration.state).toBe('retired');
    expect((await authorityOf(member, { migrationId, entityKind: 'conversation' })).authority).toBe('aurum');

    // ROLLBACK FROM RETIRED: the last retired window re-opens.
    const rolled = await rollbackMigration(migrationAdmin, {
      migrationId,
      reason: 'the incumbent must resume as the authority of record for this kind',
    });
    expect(rolled.migration.state).toBe('retiring-incumbent');
    const windows = await listRetirementWindows(member, { migrationId });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ sequence: 1, status: 'retired' });
    expect(windows[1]).toMatchObject({ sequence: 2, status: 'open' });
    expect((await authorityOf(member, { migrationId, entityKind: 'conversation' })).authority).toBe(
      'incumbent',
    );
    // The full trail is retained: both windows, both transitions.
    const transitions = await listMigrationTransitions(member, { migrationId });
    expect(transitions.filter((transition) => transition.kind === 'rollback')).toHaveLength(1);
    expect(transitions[transitions.length - 1]!.evidence).toMatchObject({
      reopenedWindow: { entityKind: 'conversation', sequence: 2 },
    });

    // The kind retires again through the re-opened window.
    const report = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(report.clean).toBe(true);
    await completeRetirement(member, { migrationId, entityKind: 'conversation' });
    expect((await getMigration(member, { migrationId })).migration.state).toBe('retired');
  });
});

describe('W094 — no silent data loss', () => {
  it('a mid-batch landing failure is a HARD failure with a mismatch manifest, and re-running replays without duplicates', async () => {
    incumbent.seedCollection(connection.id, 'export/bad-people', [
      personRecord('P-601', 'Ada Lovelace', 'ada@lovelace.example'),
      { incumbentId: 'P-602', updatedAt: '2026-10-05T09:00:00Z', fullName: 'Grace Hopper', email: 'not-an-email' },
    ]);
    const staged = await stageMigration(member, {
      systemId: system.id,
      connectionId: connection.id,
      readCapabilityKey: READ_CAPABILITY,
      taskContext: { description: 'the W094 bad-batch migration' },
      batches: [{ target: 'export/bad-people', entityKind: 'person' }],
    });
    const failure = await expectCode('import_integrity_mismatch', () =>
      runImport(member, { migrationId: staged.migration.id }),
    );
    expect(failure.message).toContain('landed 1 of 2');
    // The migration stays staged; the manifest holds the mismatch.
    expect((await getMigration(member, { migrationId: staged.migration.id })).migration.state).toBe('staged');
    const manifest = (await listImportManifests(member, { migrationId: staged.migration.id }))[0]!;
    expect(manifest.status).toBe('mismatch');
    expect(manifest.expectedCount).toBe(2);
    expect(manifest.landedCount).toBe(1);
    // The good record landed and is mapped (the replay dedupe).
    const mapped = await listIdentityMappings(member, { migrationId: staged.migration.id });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.incumbentId).toBe('P-601');

    // Fix the incumbent record; re-run: the good record REPLAYS (same
    // person), the fixed record lands, the import completes.
    incumbent.mutateRecord(connection.id, 'P-602', { email: 'grace@hopper.example' });
    const imported = await runImport(member, { migrationId: staged.migration.id });
    expect(imported.migration.state).toBe('imported');
    const remapped = await listIdentityMappings(member, { migrationId: staged.migration.id });
    expect(remapped).toHaveLength(2);
    const replayed = remapped.find((mapping) => mapping.incumbentId === 'P-601')!;
    expect(replayed.aurumId).toBe(mapped[0]!.aurumId); // the SAME person row — no duplicate
    const manifestAfter = (await listImportManifests(member, { migrationId: staged.migration.id }))[0]!;
    expect(manifestAfter.status).toBe('ok');
    expect(manifestAfter.landedCount).toBe(2);
  });

  it('the integrity probe re-derives manifest-vs-landed later: a lost mapping or a corrupted count is the hard refusal', async () => {
    incumbent.seedCollection(connection.id, 'export/lost-people', [
      personRecord('P-701', 'Kay McNulty', 'kay@mcnulty.example'),
    ]);
    const migrationId = await migrationAt([{ target: 'export/lost-people', entityKind: 'person' }]);
    expect((await verifyImportIntegrity(member, { migrationId })).ok).toBe(true);

    // Fault injection: a mapping row vanishes (simulated data loss).
    await getDb().query(
      `DELETE FROM migration_identity_mappings WHERE tenant_id = $1 AND migration_id = $2 AND incumbent_id = 'P-701'`,
      [TENANT, migrationId],
    );
    await expectCode('import_integrity_mismatch', () =>
      verifyImportIntegrity(member, { migrationId }),
    );

    // Fault injection: a corrupted manifest landing ledger (a second
    // migration) — the ledger disagrees with the counted landings.
    incumbent.seedCollection(connection.id, 'export/corrupted-count', [
      personRecord('P-801', 'Betty Holberton', 'betty@holberton.example'),
    ]);
    const corruptedId = await migrationAt([{ target: 'export/corrupted-count', entityKind: 'person' }]);
    await getDb().query(
      `UPDATE migration_import_manifests SET landed_records = '[]'::jsonb WHERE tenant_id = $1 AND migration_id = $2`,
      [TENANT, corruptedId],
    );
    await expectCode('import_integrity_mismatch', () =>
      verifyImportIntegrity(member, { migrationId: corruptedId }),
    );
  });
});

describe('W094 — identifier preservation (the W095 discipline)', () => {
  it('an AMBIGUOUS person record stays unverified-external and is NEVER auto-merged until a claim-gated human resolution', async () => {
    incumbent.seedCollection(connection.id, 'export/ambiguous-people', [
      personRecord('P-901', 'Dana Ruiz', 'shared@ruiz.example'),
      personRecord('P-902', 'D. Ruiz', 'shared@ruiz.example'),
    ]);
    const migrationId = await migrationAt([{ target: 'export/ambiguous-people', entityKind: 'person' }]);

    const mappings = await listIdentityMappings(member, { migrationId });
    expect(mappings).toHaveLength(2);
    const first = mappings.find((mapping) => mapping.incumbentId === 'P-901')!;
    const second = mappings.find((mapping) => mapping.incumbentId === 'P-902')!;
    expect(first.verificationState).toBe('verified');
    expect(first.aurumKind).toBe('person');
    // NEVER auto-merged: the clashing record stays unverified-external
    // with the candidates surfaced.
    expect(second.verificationState).toBe('unverified-external');
    expect(second.matchBasis).toBe('ambiguous-candidates');
    expect(second.aurumId).toBeNull();
    expect(second.candidates).toHaveLength(2);
    expect(second.candidates.map((candidate) => candidate.incumbentId).sort()).toEqual(['P-901', 'P-902']);

    // The comparison surfaces it: the kind is NOT clean while the
    // ambiguity stands (incumbent-only), so retirement is gated.
    const report = await compareMigration(member, { migrationId, entityKind: 'person' });
    expect(report.clean).toBe(false);
    expect(report.incumbentOnlyCount).toBe(1);
    await expectCode('retirement_not_clean', () =>
      openRetirementWindow(member, { migrationId, entityKind: 'person' }),
    );

    // The human resolution (claim-gated; never automatic).
    await expectCode('forbidden', () =>
      resolveMappingAmbiguity(member, {
        mappingId: second.id,
        aurumId: first.aurumId!,
        note: 'the operator confirmed both records are the same person',
      }),
    );
    const resolved = await resolveMappingAmbiguity(migrationAdmin, {
      mappingId: second.id,
      aurumId: first.aurumId!,
      note: 'the operator confirmed both records are the same person',
    });
    expect(resolved.verificationState).toBe('verified');
    expect(resolved.matchBasis).toBe('human-resolution');
    expect(resolved.aurumId).toBe(first.aurumId);
    // A resolved mapping cannot be resolved again.
    await expectCode('mapping_not_ambiguous', () =>
      resolveMappingAmbiguity(migrationAdmin, {
        mappingId: second.id,
        aurumId: first.aurumId!,
        note: 'a second resolution attempt',
      }),
    );

    // The operator aligns the incumbent record; the next sync lands the
    // advance and the kind converges (clean comparison, retirement ok).
    incumbent.mutateRecord(connection.id, 'P-902', { fullName: 'Dana Ruiz' });
    const sync = await runSyncPass(member, { migrationId });
    expect(sync.conflictsDetected).toBe(0);
    const clean = await compareMigration(member, { migrationId, entityKind: 'person' });
    expect(clean.clean).toBe(true);
    await openRetirementWindow(member, { migrationId, entityKind: 'person' });
    await completeRetirement(member, { migrationId, entityKind: 'person' });
    expect((await authorityOf(member, { migrationId, entityKind: 'person' })).authority).toBe('aurum');
  });
});

describe('W094 — dual-run conflicts are surfaced, never auto-resolved', () => {
  it('the same logical record touched on BOTH sides records a conflict with both versions and the W084 diff, and retirement stays gated until the human decides', async () => {
    incumbent.seedCollection(connection.id, 'export/conflict-conversations', [
      conversationRecord('C-401', 'Support', [{ turnId: 'C-401#1', text: 'The printer jams.' }]),
    ]);
    const migrationId = await migrationAt([
      { target: 'export/conflict-conversations', entityKind: 'conversation' },
    ]);
    const mappings = await listIdentityMappings(member, { migrationId });
    const conversationId = mappings.find((mapping) => mapping.incumbentId === 'C-401')!.aurumId!;

    // BOTH sides advance independently: the incumbent adds its turn...
    incumbent.mutateRecord(connection.id, 'C-401', {
      updatedAt: '2026-10-07T09:00:00Z',
      turns: [
        { turnId: 'C-401#1', direction: 'inbound', actorLabel: 'Dana Ruiz (customer)', sentAt: '2026-10-04T09:00:00Z', payload: { text: 'The printer jams.' } },
        { turnId: 'C-401#2', direction: 'inbound', actorLabel: 'Dana Ruiz (customer)', sentAt: '2026-10-07T08:00:00Z', payload: { text: 'Still jamming.' } },
      ],
    });
    // ...and Aurum records its own turn in the same conversation.
    await recordAurumSideTurn(conversationId, 'C-401#aurum-1', 'We dispatched a technician.');
    const sync = await runSyncPass(member, { migrationId });
    expect(sync.conflictsDetected).toBe(1);

    const conflicts = await listConflicts(member, { migrationId, status: 'open' });
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    const conflict = conflicts[0]!;
    expect(conflict.taxonomy).toBe('concurrent-update');
    expect(conflict.status).toBe('open');
    expect(conflict.resolution).toBe('none'); // NEVER auto-resolved
    // BOTH versions, with the divergent content visible on each side.
    const incumbentTurns = (conflict.incumbentVersion as { turns: { turnId: string }[] }).turns;
    const aurumTurns = (conflict.aurumVersion as { turns: { turnId: string }[] }).turns;
    expect(incumbentTurns.map((turn) => turn.turnId)).toContain('C-401#2');
    expect(aurumTurns.map((turn) => turn.turnId)).toContain('C-401#aurum-1');
    expect(new Date(conflict.incumbentUpdatedAt!).getTime()).toBe(
      new Date('2026-10-07T09:00:00Z').getTime(),
    );
    expect(conflict.aurumUpdatedAt).not.toBeNull();
    // The W084 reconciliation diff rides the conflict row.
    expect((conflict.reconciliation as { matched: boolean }).matched).toBe(false);
    const mismatches = (conflict.reconciliation as { mismatches: { path: string }[] }).mismatches;
    expect(mismatches.some((mismatch) => mismatch.path === 'turns')).toBe(true);

    // A further sync pass does NOT clear it (never auto-resolved) and
    // lands nothing for the conflicted record.
    await runSyncPass(member, { migrationId });
    const stillOpen = await listConflicts(member, { migrationId, status: 'open' });
    expect(stillOpen.length).toBeGreaterThanOrEqual(1);

    // Retirement is GATED on the open conflict queue.
    const report = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(report.clean).toBe(false);
    await expectCode('retirement_conflicts_open', () =>
      openRetirementWindow(member, { migrationId, entityKind: 'conversation' }),
    );

    // The human decision (claim-gated) — EVERY re-surfaced row of the
    // still-unresolved divergence is decided (each pass surfaces it
    // again while it stands; the operator resolves them all).
    await expectCode('forbidden', () =>
      resolveConflict(member, { conflictId: conflict.id, resolution: 'aurum', note: 'the Aurum version wins' }),
    );
    const openConflicts = await listConflicts(member, { migrationId, status: 'open' });
    for (const open of openConflicts) {
      const resolvedRow = await resolveConflict(migrationAdmin, {
        conflictId: open.id,
        resolution: 'aurum',
        note: 'the Aurum version wins — the incumbent will adopt it',
      });
      expect(resolvedRow.status).toBe('resolved');
      expect(resolvedRow.resolution).toBe('aurum');
    }
    await expectCode('conflict_not_open', () =>
      resolveConflict(migrationAdmin, { conflictId: conflict.id, resolution: 'incumbent', note: 'twice' }),
    );

    // The operator acts on the decision: the incumbent adopts the Aurum
    // version; the next pass CONVERGES (no new conflicts, checkpoints
    // refreshed) and the kind retires.
    incumbent.mutateRecord(connection.id, 'C-401', {
      updatedAt: '2026-10-08T09:00:00Z',
      turns: [
        { turnId: 'C-401#1', direction: 'inbound', actorLabel: 'Dana Ruiz (customer)', sentAt: '2026-10-04T09:00:00Z', payload: { text: 'The printer jams.' } },
        { turnId: 'C-401#aurum-1', direction: 'outbound', actorLabel: 'Aurum workplace', sentAt: '2026-10-06T12:00:00Z', payload: { text: 'We dispatched a technician.' } },
      ],
    });
    const converge = await runSyncPass(member, { migrationId });
    expect(converge.conflictsDetected).toBe(0);
    const clean = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(clean.clean).toBe(true);
    await openRetirementWindow(member, { migrationId, entityKind: 'conversation' });
    await completeRetirement(member, { migrationId, entityKind: 'conversation' });
  });
});

describe('W094 — back-writes through the W084 transport behind the W083 gate', () => {
  it('an Aurum-side advance back-writes into the incumbent (receipt accepted) and the systems converge', async () => {
    incumbent.seedCollection(connection.id, 'export/backwrite-conversations', [
      conversationRecord('C-501', 'Logistics', [{ turnId: 'C-501#1', text: 'The shipment left.' }]),
    ]);
    const migrationId = await migrationAt([
      { target: 'export/backwrite-conversations', entityKind: 'conversation' },
    ]);
    const mappings = await listIdentityMappings(member, { migrationId });
    const conversationId = mappings.find((mapping) => mapping.incumbentId === 'C-501')!.aurumId!;

    // Aurum-side activity during dual-run.
    await recordAurumSideTurn(conversationId, 'C-501#aurum-1', 'The shipment arrived.');

    const sync = await runSyncPass(member, { migrationId });
    expect(sync.backWritesAttempted).toBe(1);
    expect(sync.backWritesAccepted).toBe(1);
    expect(sync.backWritesRefused).toBe(0);
    expect(sync.conflictsDetected).toBe(0);
    // The incumbent double APPLIED the back-write (the payload merged).
    const incumbentRecord = incumbent.recordOf(connection.id, 'C-501')!;
    expect((incumbentRecord['subject'] as string)).toBe('Logistics');
    expect((incumbentRecord['turns'] as unknown[]).length).toBe(2);

    // Converged: the next pass moves nothing.
    const second = await runSyncPass(member, { migrationId });
    expect(second.backWritesAttempted).toBe(0);
    expect(second.conflictsDetected).toBe(0);
    const report = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(report.clean).toBe(true);
  });

  it('a PERMANENTLY REFUSED back-write is a surfaced conflict (the receipt is the provenance)', async () => {
    incumbent.seedCollection(connection.id, 'export/refused-conversations', [
      conversationRecord('C-601', 'Billing', [{ turnId: 'C-601#1', text: 'The invoice is wrong.' }]),
    ]);
    const migrationId = await migrationAt([
      { target: 'export/refused-conversations', entityKind: 'conversation' },
    ]);
    const mappings = await listIdentityMappings(member, { migrationId });
    const conversationId = mappings.find((mapping) => mapping.incumbentId === 'C-601')!.aurumId!;
    incumbent.refuseWritesOn('C-601');

    await recordAurumSideTurn(conversationId, 'C-601#aurum-1', 'We credited the invoice.');
    const sync = await runSyncPass(member, { migrationId });
    expect(sync.backWritesAttempted).toBe(1);
    expect(sync.backWritesRefused).toBe(1);
    expect(sync.conflictsDetected).toBe(1);

    const conflicts = await listConflicts(member, { migrationId, status: 'open' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.taxonomy).toBe('back-write-refused');
    const provenance = conflicts[0]!.provenance as { incumbent: { detail: string | null } };
    expect(provenance.incumbent.detail).toContain('refused');
  });

  it('a TRANSIENT back-write failure retries on the next pass and then converges', async () => {
    incumbent.seedCollection(connection.id, 'export/transient-conversations', [
      conversationRecord('C-701', 'Scheduling', [{ turnId: 'C-701#1', text: 'Tuesday works.' }]),
    ]);
    const migrationId = await migrationAt([
      { target: 'export/transient-conversations', entityKind: 'conversation' },
    ]);
    const mappings = await listIdentityMappings(member, { migrationId });
    const conversationId = mappings.find((mapping) => mapping.incumbentId === 'C-701')!.aurumId!;
    incumbent.failOnceOn('C-701');

    await recordAurumSideTurn(conversationId, 'C-701#aurum-1', 'Confirmed for Tuesday.');
    const first = await runSyncPass(member, { migrationId });
    expect(first.backWritesFailed).toBe(1);
    expect(first.conflictsDetected).toBe(0); // transient — not a conflict
    const retry = await runSyncPass(member, { migrationId });
    expect(retry.backWritesAccepted).toBe(1);
    const report = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(report.clean).toBe(true);
  });

  it('a migration with NO write capability surfaces the divergence instead of silently dropping it', async () => {
    incumbent.seedCollection(connection.id, 'export/readonly-conversations', [
      conversationRecord('C-801', 'Notices', [{ turnId: 'C-801#1', text: 'Maintenance window.' }]),
    ]);
    const migrationId = await migrationAt(
      [{ target: 'export/readonly-conversations', entityKind: 'conversation' }],
      { writeCapability: false },
    );
    const mappings = await listIdentityMappings(member, { migrationId });
    const conversationId = mappings.find((mapping) => mapping.incumbentId === 'C-801')!.aurumId!;

    await recordAurumSideTurn(conversationId, 'C-801#aurum-1', 'Rescheduled.');
    const sync = await runSyncPass(member, { migrationId });
    expect(sync.backWritesBlocked).toBe(1);
    // Surfaced: the event + the comparison report carry the divergence.
    const events = await listMigrationEvents(member, { migrationId });
    expect(events.some((event) => event.event === 'back-write-blocked')).toBe(true);
    const report = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(report.clean).toBe(false);
    expect(report.divergedCount).toBe(1);
  });
});

describe('W094 — comparison rides reconcileOperation (the W084 outcomes)', () => {
  it('the report rows carry the W084 OperationReconciliation verdicts verbatim (diverged paths enumerated)', async () => {
    incumbent.seedCollection(connection.id, 'export/reconcile-people', [
      personRecord('P-1001', 'Marie Curie', 'marie@curie.example'),
    ]);
    const migrationId = await migrationAt([{ target: 'export/reconcile-people', entityKind: 'person' }]);

    // Diverge the incumbent attribute: the Aurum person stays as
    // imported while the incumbent record changes.
    incumbent.mutateRecord(connection.id, 'P-1001', { fullName: 'Maria Skłodowska-Curie' });
    const report = await compareMigration(member, { migrationId, entityKind: 'person' });
    expect(report.clean).toBe(false);
    expect(report.divergedCount).toBe(1);
    const outcome = report.outcomes.find((row) => row.incumbentId === 'P-1001')!;
    expect(outcome.outcome).toBe('diverged');
    const reconciliation = outcome.reconciliation as {
      matched: boolean;
      mismatches: { path: string; expected: unknown; actual: unknown }[];
      stateUnchanged: boolean;
    };
    // The W084 shape, verbatim: enumerated (path, expected, actual).
    expect(reconciliation.matched).toBe(false);
    expect(reconciliation.mismatches).toHaveLength(1);
    expect(reconciliation.mismatches[0]!.path).toBe('fullName');
    expect(reconciliation.mismatches[0]!.expected).toBe('Marie Curie');
    expect(reconciliation.mismatches[0]!.actual).toBe('Maria Skłodowska-Curie');
    expect(typeof reconciliation.stateUnchanged).toBe('boolean');

    // A matched row carries the same W084 shape with matched=true.
    const cleanSync = await runSyncPass(member, { migrationId }); // lands the advance
    expect(cleanSync.conflictsDetected).toBe(0);
    const clean = await compareMigration(member, { migrationId, entityKind: 'person' });
    expect(clean.clean).toBe(true);
    const matchedOutcome = clean.outcomes.find((row) => row.incumbentId === 'P-1001')!;
    expect((matchedOutcome.reconciliation as { matched: boolean }).matched).toBe(true);
  });
});

describe('W094 — dual-run sync lands NEW incumbent records', () => {
  it('a record that appears in the incumbent collection after import lands through the ladder on the next pass', async () => {
    incumbent.seedCollection(connection.id, 'export/growing-people', [
      personRecord('P-1101', 'Alan Turing', 'alan@turing.example'),
    ]);
    const migrationId = await migrationAt([{ target: 'export/growing-people', entityKind: 'person' }]);

    // The incumbent grows (a live incumbent being worked in).
    incumbent.seedCollection(connection.id, 'export/growing-people', [
      personRecord('P-1102', 'Joan Clarke', 'joan@clarke.example'),
    ]);
    const sync = await runSyncPass(member, { migrationId });
    expect(sync.recordsRead).toBe(2);
    expect(sync.recordsLanded).toBe(1);
    const mappings = await listIdentityMappings(member, { migrationId });
    expect(mappings).toHaveLength(2);
    const fresh = mappings.find((mapping) => mapping.incumbentId === 'P-1102')!;
    expect(fresh.verificationState).toBe('verified');
    expect(fresh.matchBasis).toBe('sync-created');
    const person = await peopleContract.getPerson(member, fresh.aurumId!);
    expect(person.fullName).toBe('Joan Clarke');
  });
});

describe('W094 — delete-vs-update', () => {
  it('an incumbent deletion while Aurum advanced surfaces a delete-vs-update conflict', async () => {
    incumbent.seedCollection(connection.id, 'export/deleted-conversations', [
      conversationRecord('C-1201', 'Archive', [{ turnId: 'C-1201#1', text: 'Old thread.' }]),
    ]);
    const migrationId = await migrationAt([
      { target: 'export/deleted-conversations', entityKind: 'conversation' },
    ]);
    const mappings = await listIdentityMappings(member, { migrationId });
    const conversationId = mappings.find((mapping) => mapping.incumbentId === 'C-1201')!.aurumId!;

    // The incumbent deleted the record; Aurum advanced it.
    incumbent.deleteRecord(connection.id, 'C-1201');
    await recordAurumSideTurn(conversationId, 'C-1201#aurum-1', 'Still relevant.');

    const sync = await runSyncPass(member, { migrationId });
    expect(sync.conflictsDetected).toBe(1);
    const conflicts = await listConflicts(member, { migrationId, status: 'open' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.taxonomy).toBe('delete-vs-update');
    expect(conflicts[0]!.incumbentVersion).toBeNull();
    expect(conflicts[0]!.aurumVersion).not.toBeNull();
    // The comparison surfaces the aurum-only orphan; retirement gated.
    const report = await compareMigration(member, { migrationId, entityKind: 'conversation' });
    expect(report.aurumOnlyCount).toBe(1);
    expect(report.clean).toBe(false);
  });
});

describe('W094 — tenant isolation (compact; the W044 sweep carries the full proof)', () => {
  it("tenant B cannot see, resume or roll back tenant A's migration", async () => {
    incumbent.seedCollection(connection.id, 'export/isolated-people', [
      personRecord('P-1301', 'Edsger Dijkstra', 'edsger@dijkstra.example'),
    ]);
    const migrationId = await migrationAt([{ target: 'export/isolated-people', entityKind: 'person' }]);

    await expectCode('migration_not_found', () =>
      getMigration(otherMember, { migrationId }),
    );
    await expectCode('migration_not_found', () =>
      runSyncPass(otherMember, { migrationId }),
    );
    await expectCode('migration_not_found', () =>
      rollbackMigration(otherMember, { migrationId, reason: 'a cross-tenant rollback attempt' }),
    );
    await expectCode('migration_not_found', () =>
      compareMigration(otherMember, { migrationId, entityKind: 'person' }),
    );
    expect(await listMigrations(otherMember, {})).toHaveLength(0);
    expect((await listMigrations(member, {})).length).toBeGreaterThanOrEqual(1);
  });
});

describe('W094 — state discipline', () => {
  it('refuses the wrong-phase calls, the missing transport, the empty rollback and the bad capability keys', async () => {
    incumbent.seedCollection(connection.id, 'export/discipline-people', [
      personRecord('P-1401', 'Kurt Gödel', 'kurt@godel.example'),
    ]);
    const migrationId = await migrationAt([{ target: 'export/discipline-people', entityKind: 'person' }]);

    // Wrong phase: importing a dual-running migration.
    await expectCode('migration_not_pending_phase', () => runImport(member, { migrationId }));
    // Wrong phase: completing a retirement without a window refuses
    // (the state check comes first — a dual-running migration holds no
    // windows at all).
    await expectCode('migration_not_pending_phase', () =>
      completeRetirement(member, { migrationId, entityKind: 'person' }),
    );
    // Nothing to roll back at... (this migration CAN roll back; use a
    // fresh staged one for the nothing_to_rollback refusal).
    incumbent.seedCollection(connection.id, 'export/staged-only-people', [
      personRecord('P-1501', 'Rosalind Franklin', 'rosalind@franklin.example'),
    ]);
    const stagedOnly = await stageMigration(member, {
      systemId: system.id,
      connectionId: connection.id,
      readCapabilityKey: READ_CAPABILITY,
      taskContext: { description: 'the W094 staged-only migration' },
      batches: [{ target: 'export/staged-only-people', entityKind: 'person' }],
    });
    await expectCode('nothing_to_rollback', () =>
      rollbackMigration(migrationAdmin, { migrationId: stagedOnly.migration.id, reason: 'nothing to unwind yet' }),
    );
    // A bad capability key never stages (validated against the LIVE surface).
    await expectCode('invalid_input', () =>
      stageMigration(member, {
        systemId: system.id,
        connectionId: connection.id,
        readCapabilityKey: 'read.nonexistent-class',
        taskContext: { description: 'the W094 bad-capability migration' },
        batches: [{ target: 'export/staged-only-people', entityKind: 'person' }],
      }),
    );
    // A write key that is not a write capability refuses too.
    await expectCode('invalid_input', () =>
      stageMigration(member, {
        systemId: system.id,
        connectionId: connection.id,
        readCapabilityKey: READ_CAPABILITY,
        writeCapabilityKey: READ_CAPABILITY,
        taskContext: { description: 'the W094 bad-write-key migration' },
        batches: [{ target: 'export/staged-only-people', entityKind: 'person' }],
      }),
    );
    // Missing transport: the module refuses to fake incumbent reads.
    deepActionsContract.setDeepActionTransport(null);
    try {
      await expectCode('transport_unavailable', () =>
        compareMigration(member, { migrationId, entityKind: 'person' }),
      );
    } finally {
      deepActionsContract.setDeepActionTransport(incumbent);
    }
    // An unknown migration is uniformly not-found (no existence leak).
    const unknown = newId();
    await expectCode('migration_not_found', () => getMigration(member, { migrationId: unknown }));
  });

  it('the append-only ledgers refuse mutation at the storage level', async () => {
    await expect(getDb().query(`UPDATE migration_transitions SET reason = 'tampered' WHERE tenant_id = $1`, [TENANT])).rejects.toThrow();
    await expect(getDb().query(`DELETE FROM migration_events WHERE tenant_id = $1`, [TENANT])).rejects.toThrow();
  });
});
