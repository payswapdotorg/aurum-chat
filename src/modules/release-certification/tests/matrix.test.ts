// W079 — the journey matrix's own consistency proof (the catalog is the
// contract's §5 matrix, verbatim, complete and well-formed).

import { describe, expect, it } from 'vitest';
import {
  JOURNEY_MATRIX,
  JOURNEYS_LEAVING_CHAT,
  journeySpec,
  matrixConsistency,
  requiredBrowserTests,
} from '../matrix';

describe('the J01–J15 production journey matrix', () => {
  it('is consistent (every contract journey exactly once, with contexts and proofs)', () => {
    expect(matrixConsistency()).toEqual([]);
  });

  it('carries all fifteen journeys in contract order', () => {
    expect(JOURNEY_MATRIX.map((journey) => journey.id)).toEqual([
      'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10',
      'J11', 'J12', 'J13', 'J14', 'J15',
    ]);
  });

  it("restates the contract's mandatory proofs verbatim", () => {
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

  it('requires the mobile context for the mobile journey and desktop for the rest', () => {
    const pairs = requiredBrowserTests();
    expect(pairs.filter((pair) => pair.context === 'mobile')).toEqual([{ journeyId: 'J14', context: 'mobile' }]);
    expect(pairs.filter((pair) => pair.context === 'desktop').length).toBe(14);
  });

  it('marks exactly the cross-surface journeys that leave Chat', () => {
    expect(JOURNEYS_LEAVING_CHAT).toEqual([
      'J03', 'J04', 'J05', 'J06', 'J08', 'J09', 'J10', 'J11',
    ]);
  });

  it('throws on an unknown journey id (a matrix bug surfaces loudly)', () => {
    expect(() => journeySpec('J99' as never)).toThrow(/unknown journey id/);
  });
});
