/**
 * Estimated structure perimeter on the enriched profile.
 *
 * The estimator's Perimeter LF autofill (EstimateToolViewV2 doLookup) has
 * always read ep.perimeterLF, but buildEnrichedProfile never returned one —
 * so the combined lookup left the trenching Perimeter LF box empty. The
 * profile now derives a rough perimeter from the ground-floor footprint
 * using the same 4·√area·layout formula the pricing engine applies for
 * termite bait and the trenching "estimate from footprint" checkbox
 * (client/src/lib/estimateEngine.js): layout 1.35 for MODERATE/COMPLEX
 * landscape complexity, 1.25 otherwise.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

const expectedPerim = (footprint, factor) => Math.round(4 * Math.sqrt(footprint) * factor);

describe('enriched profile perimeterLF', () => {
  test('derives perimeter from footprint with the MODERATE/COMPLEX 1.35 layout factor', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 1623, stories: 1 },
      { landscapeComplexity: 'MODERATE' },
      27.4, -82.4, null,
    );
    expect(profile.footprint).toBe(1623);
    expect(profile.perimeterLF).toBe(expectedPerim(1623, 1.35));
    expect(profile.perimeterLFSource).toBe('estimated_from_footprint');
  });

  test('uses the ground-floor footprint (living area / stories) for multi-story homes', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 3000, stories: 2 },
      { landscapeComplexity: 'COMPLEX' },
      27.4, -82.4, null,
    );
    expect(profile.footprint).toBe(1500);
    expect(profile.perimeterLF).toBe(expectedPerim(1500, 1.35));
  });

  test('SIMPLE complexity uses the 1.25 layout factor', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 1600, stories: 1 },
      { landscapeComplexity: 'SIMPLE' },
      27.4, -82.4, null,
    );
    expect(profile.perimeterLF).toBe(expectedPerim(1600, 1.25));
  });

  test('missing landscape complexity defaults to MODERATE (1.35), matching the profile default', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 1600, stories: 1 },
      {},
      27.4, -82.4, null,
    );
    expect(profile.landscapeComplexity).toBe('MODERATE');
    expect(profile.perimeterLF).toBe(expectedPerim(1600, 1.35));
  });

  test('no square footage → no perimeter, null source', () => {
    const profile = buildEnrichedProfile(null, {}, 27.4, -82.4, null);
    expect(profile.footprint).toBe(0);
    expect(profile.perimeterLF).toBeNull();
    expect(profile.perimeterLFSource).toBeNull();
  });
});

describe('enriched profile attic / slab estimates', () => {
  test('attic and slab default to the ground-floor footprint', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 3000, stories: 2 },
      {},
      27.4, -82.4, null,
    );
    expect(profile.atticSqFt).toBe(1500);
    expect(profile.atticSqFtSource).toBe('estimated_from_footprint');
    expect(profile.slabSqFt).toBe(1500);
    expect(profile.slabSqFtSource).toBe('estimated_from_footprint');
  });

  test('no square footage → null attic/slab, null sources', () => {
    const profile = buildEnrichedProfile(null, {}, 27.4, -82.4, null);
    expect(profile.atticSqFt).toBeNull();
    expect(profile.atticSqFtSource).toBeNull();
    expect(profile.slabSqFt).toBeNull();
    expect(profile.slabSqFtSource).toBeNull();
  });
});
