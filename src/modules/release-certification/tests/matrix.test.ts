// W079/W101 — the journey matrix's own consistency proof (the catalog is
// the W079 contract's §5 matrix verbatim and complete, extended by the
// W101 post-S002 journeys J16–J22 with the J01–J15 prefix frozen).

import { describe, expect, it } from 'vitest';
import {
  JOURNEY_MATRIX,
  JOURNEYS_LEAVING_CHAT,
  PROGRAM_JOURNEYS,
  journeySpec,
  matrixConsistency,
  programJourneys,
  requiredBrowserTests,
} from '../matrix';

describe('the J01–J22 production journey matrix (W079 frozen + W101 extension)', () => {
  it('is consistent (every contract journey exactly once, with contexts and proofs)', () => {
    expect(matrixConsistency()).toEqual([]);
  });

  it('carries all twenty-two journeys in contract order (J01–J15 frozen first)', () => {
    expect(JOURNEY_MATRIX.map((journey) => journey.id)).toEqual([
      'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10',
      'J11', 'J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18', 'J19', 'J20',
      'J21', 'J22',
    ]);
  });

  it("restates the W079 contract's mandatory proofs verbatim (the frozen prefix)", () => {
    expect(journeySpec('J01').mandatoryProof).toBe(
      'anonymous → sign-in → onboarding → company → Chat',
    );
    expect(journeySpec('J05').mandatoryProof).toBe(
      'recommendation → comparison → explicit human decision → activation → outcome',
    );
    expect(journeySpec('J13').mandatoryProof).toBe(
      'manager tenant activity → sign out → second tenant → no first-tenant data visible',
    );
    expect(journeySpec('J14').mandatoryProof).toBe(
      'mobile Chat list → full-screen thread → composer → reply → back to list',
    );
    expect(journeySpec('J15').mandatoryProof).toBe(
      'keyboard/focus/ARIA; task-language discovery; no dead-end/no-match states',
    );
  });

  it('restates the W101 post-S002 journeys’ mandatory proofs', () => {
    expect(journeySpec('J16').mandatoryProof).toBe(
      'connection hub channel surfaces + the v1 public API channel surfaces, real production auth',
    );
    expect(journeySpec('J17').mandatoryProof).toBe(
      'the meetings surface via the v1 API — the meeting-intelligence contract’s user-visible path',
    );
    expect(journeySpec('J18').mandatoryProof).toBe(
      'the cellular surface via the v1 API — the SMS/voice contract’s user-visible path; environment limits recorded as the module reports them',
    );
    expect(journeySpec('J20').mandatoryProof).toBe(
      '/ai/preferences outcome preferences + explanations; /ai/preferences/advanced authorization-gated; provider/billing surfaces',
    );
    expect(journeySpec('J22').mandatoryProof).toBe(
      'the marketplace + installed-kit surfaces — the W092 vertical kits’ user-visible path',
    );
  });

  it('requires the mobile context for the mobile journey and desktop for the rest (W079 program)', () => {
    const pairs = requiredBrowserTests('W079');
    expect(pairs.filter((pair) => pair.context === 'mobile')).toEqual([{ journeyId: 'J14', context: 'mobile' }]);
    expect(pairs.filter((pair) => pair.context === 'desktop').length).toBe(14);
    expect(pairs.length).toBe(15);
  });

  it('requires the W101 program’s full J01–J22 inventory (21 desktop + the J14 mobile pair)', () => {
    const pairs = requiredBrowserTests('W101');
    expect(pairs.filter((pair) => pair.context === 'mobile')).toEqual([{ journeyId: 'J14', context: 'mobile' }]);
    expect(pairs.filter((pair) => pair.context === 'desktop').length).toBe(21);
    expect(pairs.length).toBe(22);
    expect(pairs.map((pair) => pair.journeyId)).toContain('J22');
  });

  it('defaults the required inventory to the frozen W079 program (historical call sites)', () => {
    expect(requiredBrowserTests()).toEqual(requiredBrowserTests('W079'));
  });

  it('the program model keeps J01–J15 mandatory in BOTH programs', () => {
    expect(PROGRAM_JOURNEYS.W079).toEqual([
      'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10',
      'J11', 'J12', 'J13', 'J14', 'J15',
    ]);
    expect(PROGRAM_JOURNEYS.W101.slice(0, 15)).toEqual(PROGRAM_JOURNEYS.W079);
    expect(programJourneys('W101').map((journey) => journey.id)).toEqual([
      'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10',
      'J11', 'J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18', 'J19', 'J20',
      'J21', 'J22',
    ]);
    expect(programJourneys('W079')).toHaveLength(15);
    expect(programJourneys('W101')).toHaveLength(22);
  });

  it('marks exactly the cross-surface journeys that leave Chat', () => {
    expect(JOURNEYS_LEAVING_CHAT).toEqual([
      'J03', 'J04', 'J05', 'J06', 'J08', 'J09', 'J10', 'J11',
      'J16', 'J17', 'J18', 'J19', 'J20', 'J21', 'J22',
    ]);
  });

  it('throws on an unknown journey id (a matrix bug surfaces loudly)', () => {
    expect(() => journeySpec('J99' as never)).toThrow(/unknown journey id/);
  });
});
