// Unit tests for the provider-sdk OSS technology registry (W089): schema
// validation of every committed entry, uniqueness, query functions and the
// Tech-Lead review summary. The registry is seeded from
// spec/TECHNOLOGY-RESEARCH-2026-09-23.md with strict provenance — unknown
// §15 fields are recorded as null/unknown, never invented.

import { describe, expect, it } from 'vitest';
import {
  findTechnologyEntry,
  listTechnologyCapabilities,
  listTechnologyEntries,
  listTechnologyEntriesByAdapterStatus,
  listTechnologyEntriesByCapability,
  listTechnologyEntriesByPriority,
  TECHNOLOGY_REGISTRY_SCHEMA_VERSION,
  technologyRegistryReviewSummary,
  validateTechnologyRegistryEntry,
} from '../contract';
import rawRegistry from '../registry/technologies.json';

describe('provider-sdk registry — committed data is schema-valid', () => {
  it('carries the current schema version and a seed source', () => {
    const file = rawRegistry as { registryVersion: number; seedSource: string; entries: unknown[] };
    expect(file.registryVersion).toBe(TECHNOLOGY_REGISTRY_SCHEMA_VERSION);
    expect(file.seedSource).toBe('spec/TECHNOLOGY-RESEARCH-2026-09-23.md');
    expect(Array.isArray(file.entries)).toBe(true);
    expect(file.entries.length).toBeGreaterThan(20);
  });

  it('validates every committed entry (the §15 due-diligence shape)', () => {
    const file = rawRegistry as { entries: unknown[] };
    for (const entry of file.entries) {
      expect(validateTechnologyRegistryEntry(entry)).toEqual([]);
    }
  });

  it('has unique entry ids', () => {
    const ids = listTechnologyEntries().map((entry) => entry.entryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects malformed entries with precise issues', () => {
    expect(validateTechnologyRegistryEntry(null)).toEqual(['the entry must be an object']);
    expect(validateTechnologyRegistryEntry({}).length).toBeGreaterThan(5);
    expect(
      validateTechnologyRegistryEntry({
        entryId: 'Bad_Id',
        capability: '',
        technology: 'X',
        summary: 's',
        priority: 'P9',
        license: { spdx: 5, source: 'magic', notes: 'n' },
        security: { posture: 'perfect', notes: null },
        maintenance: { health: 'immortal', notes: null },
        operations: { fit: 'great', deployment: null, notes: null },
        dataHandling: { summary: null, notes: null },
        costPerformance: { summary: null, notes: null },
        failureModes: ['ok', ''],
        exitStrategy: { replacementPath: null, notes: null },
        adapterStatus: 'maybe',
        adapterModule: 9,
        lastReviewed: '23-09-2026',
        reviewedBy: '',
        sources: [],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('entryId'),
        expect.stringContaining('capability'),
        expect.stringContaining('priority'),
        expect.stringContaining('license.source'),
        expect.stringContaining('security.posture'),
        expect.stringContaining('maintenance.health'),
        expect.stringContaining('operations.fit'),
        expect.stringContaining('failureModes'),
        expect.stringContaining('adapterStatus'),
        expect.stringContaining('lastReviewed'),
        expect.stringContaining('reviewedBy'),
        expect.stringContaining('sources'),
      ]),
    );
  });
});

describe('provider-sdk registry — seed provenance (TECHNOLOGY-RESEARCH-2026-09-23)', () => {
  it('seeds the research record headline entries', () => {
    const seeded = listTechnologyEntries().map((entry) => entry.entryId);
    // Durable orchestration, connection, meetings, realtime, speech, execution, browser, agent frameworks, Matrix.
    for (const expected of [
      'inngest',
      'triggerdev',
      'temporal',
      'vercel-workflows',
      'nango',
      'composio',
      'pipedream',
      'workato',
      'merge',
      'speakeasy',
      'zoom-rtms',
      'microsoft-teams-graph',
      'google-meet-rest',
      'recall-ai',
      'meeting-baas',
      'livekit',
      'openai-realtime',
      'pipecat',
      'deepgram',
      'assemblyai',
      'openai-stt',
      'whisperx',
      'pyannote',
      'hugging-face-hub',
      'e2b',
      'modal',
      'stagehand',
      'browserbase',
      'smolagents',
      'letta',
      'matrix',
    ]) {
      expect(seeded).toContain(expected);
    }
  });

  it('records only research-record license facts (strict provenance — no invented SPDX ids)', () => {
    const matrix = findTechnologyEntry('matrix')!;
    expect(matrix.license.source).toBe('open-standard');
    expect(matrix.license.notes).toContain('AGPL-3.0');
    expect(matrix.license.notes).toContain('Apache-2.0');
    // LiveKit is described as an open-source stack, but without a verified SPDX id.
    const livekit = findTechnologyEntry('livekit')!;
    expect(livekit.license.source).toBe('open-source');
    expect(livekit.license.spdx).toBeNull();
    // Unassessed entries stay honestly unknown.
    const inngest = findTechnologyEntry('inngest')!;
    expect(inngest.license.source).toBe('unknown');
    expect(inngest.security.posture).toBe('unknown');
  });

  it('records the research record priorities, noting in-source discrepancies', () => {
    expect(findTechnologyEntry('inngest')!.priority).toBe('P0');
    expect(findTechnologyEntry('temporal')!.priority).toBe('P2');
    expect(findTechnologyEntry('temporal')!.operations.notes).toContain('P1 strategic option');
    expect(findTechnologyEntry('e2b')!.priority).toBe('P2');
    expect(findTechnologyEntry('livekit')!.priority).toBe('P0');
    // Adopted entries are not candidate-ranked.
    expect(findTechnologyEntry('vercel-workflows')!.priority).toBeNull();
    expect(findTechnologyEntry('vercel-workflows')!.adapterStatus).toBe('adopted');
  });

  it('records the researched failure modes verbatim in spirit', () => {
    expect(findTechnologyEntry('e2b')!.failureModes.join(' ')).toContain('1 hour');
    expect(findTechnologyEntry('google-meet-rest')!.failureModes.join(' ')).toContain('Developer Preview');
    expect(findTechnologyEntry('matrix')!.failureModes.join(' ')).toContain('no network path');
  });

  it('keeps entries communication-kernel neutral (no CommOS seed, Matrix stays optional interop)', () => {
    const ids = listTechnologyEntries().map((entry) => entry.entryId);
    expect(ids).not.toContain('commos');
    const matrix = findTechnologyEntry('matrix')!;
    expect(matrix.adapterStatus).toBe('monitoring');
    expect(matrix.summary).toContain('Optional interoperability adapter');
  });

  it('requires every entry to cite sources and a review date', () => {
    for (const entry of listTechnologyEntries()) {
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.reviewedBy).not.toBe('');
    }
  });
});

describe('provider-sdk registry — queries', () => {
  it('finds entries by id (and misses cleanly)', () => {
    const nango = findTechnologyEntry('nango')!;
    expect(nango.technology).toBe('Nango');
    expect(nango.capability).toBe('connection-infrastructure');
    expect(nango.adapterStatus).toBe('adapter-planned');
    expect(findTechnologyEntry('does-not-exist')).toBeNull();
  });

  it('filters by capability, priority and adapter status', () => {
    const meetings = listTechnologyEntriesByCapability('meeting-participation').map((e) => e.entryId);
    expect(meetings).toContain('zoom-rtms');
    expect(meetings).toContain('recall-ai');

    const p0 = listTechnologyEntriesByPriority('P0').map((e) => e.entryId);
    expect(p0).toContain('inngest');
    expect(p0).not.toContain('temporal');

    const adopted = listTechnologyEntriesByAdapterStatus('adopted').map((e) => e.entryId);
    expect(adopted).toEqual(['vercel-workflows']);
    const planned = listTechnologyEntriesByAdapterStatus('adapter-planned').map((e) => e.entryId);
    expect(planned).toContain('nango');
    expect(planned).toContain('livekit');
    expect(planned).toContain('zoom-rtms');
  });

  it('returns defensive copies (callers cannot mutate the registry)', () => {
    const entries = listTechnologyEntries();
    (entries[0] as { summary: string }).summary = 'tampered';
    expect(listTechnologyEntries()[0]!.summary).not.toBe('tampered');
    const found = findTechnologyEntry('nango') as { adapterStatus: string };
    found.adapterStatus = 'rejected';
    expect(findTechnologyEntry('nango')!.adapterStatus).toBe('adapter-planned');
  });

  it('lists the capability families', () => {
    const capabilities = listTechnologyCapabilities();
    expect(capabilities).toContain('durable-workflow-orchestration');
    expect(capabilities).toContain('realtime-media');
    expect(capabilities).toContain('speech-to-text');
    expect([...capabilities].sort()).toEqual(capabilities);
  });
});

describe('provider-sdk registry — Tech-Lead review summary', () => {
  it('summarizes counts and the §15 due-diligence backlog', () => {
    const summary = technologyRegistryReviewSummary();
    const total = listTechnologyEntries().length;
    expect(summary.totalEntries).toBe(total);
    expect(summary.byAdapterStatus['adopted']).toBe(1);
    expect(summary.byAdapterStatus['candidate']).toBeGreaterThan(5);
    expect(Object.values(summary.byAdapterStatus).reduce((a, b) => a + b, 0)).toBe(total);
    expect(Object.values(summary.byPriority).reduce((a, b) => a + b, 0)).toBe(total);
    expect(summary.byPriority['unranked']).toBe(1);
    expect(summary.capabilities).toContain('meeting-participation');
    // The seed is honest about unassessed fields: the backlog is non-empty
    // and every pending item lists which §15 fields still need review.
    expect(summary.pendingDueDiligence.length).toBeGreaterThan(0);
    for (const pending of summary.pendingDueDiligence) {
      expect(pending.missingFields.length).toBeGreaterThan(0);
      expect(findTechnologyEntry(pending.entryId)).not.toBeNull();
    }
    // The backlog names the concrete unassessed fields of a known entry.
    const inngestPending = summary.pendingDueDiligence.find((p) => p.entryId === 'inngest');
    expect(inngestPending).toBeDefined();
    expect(inngestPending!.missingFields).toContain('license');
    expect(inngestPending!.missingFields).toContain('security');
    expect(inngestPending!.missingFields).toContain('maintenance');
  });
});
