/**
 * Estimated termite measurements on the enriched profile.
 *
 * The estimator's Perimeter LF / attic / slab autofill (EstimateToolViewV2
 * doLookup) reads estimated* keys from the enriched profile, but
 * buildEnrichedProfile never returned them — so the combined lookup left
 * the Termite Measurements boxes empty. The profile now derives:
 *
 *  - estimatedPerimeterLF: the same 4·√area·layout formula the pricing
 *    engine applies for termite bait and the trenching "estimate from
 *    footprint" checkbox (layout 1.35 for MODERATE/COMPLEX landscape
 *    complexity, 1.25 otherwise), from the ground-floor footprint.
 *  - estimatedAtticSqFt / estimatedSlabSqFt: ≈ the ground-floor footprint.
 *
 * The estimated* naming (matching estimatedTurfSf / estimatedBedAreaSf) is
 * load-bearing: translateV2CallToV1Input forwards profile perimeterLF /
 * atticSqFt / slabSqFt (and their aliases) as AUTHORITATIVE property
 * measurements, which would let headless pricing flows bypass the
 * quote-required gates for trenching/pre-slab. These estimates must reach
 * pricing only via the operator-visible, editable boxes — pinned below.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  buildEnrichedProfile,
  translateV2CallToV1Input,
} = require('../routes/property-lookup-v2');

const expectedPerim = (footprint, factor) => Math.round(4 * Math.sqrt(footprint) * factor);

describe('enriched profile estimatedPerimeterLF', () => {
  test('derives perimeter from footprint with the MODERATE/COMPLEX 1.35 layout factor', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 1623, stories: 1 },
      { landscapeComplexity: 'MODERATE' },
      27.4, -82.4, null,
    );
    expect(profile.footprint).toBe(1623);
    expect(profile.estimatedPerimeterLF).toBe(expectedPerim(1623, 1.35));
  });

  test('uses the ground-floor footprint (living area / stories) for multi-story homes', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 3000, stories: 2 },
      { landscapeComplexity: 'COMPLEX' },
      27.4, -82.4, null,
    );
    expect(profile.footprint).toBe(1500);
    expect(profile.estimatedPerimeterLF).toBe(expectedPerim(1500, 1.35));
  });

  test('SIMPLE complexity uses the 1.25 layout factor', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 1600, stories: 1 },
      { landscapeComplexity: 'SIMPLE' },
      27.4, -82.4, null,
    );
    expect(profile.estimatedPerimeterLF).toBe(expectedPerim(1600, 1.25));
  });

  test('missing landscape complexity defaults to MODERATE (1.35), matching the profile default', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 1600, stories: 1 },
      {},
      27.4, -82.4, null,
    );
    expect(profile.landscapeComplexity).toBe('MODERATE');
    expect(profile.estimatedPerimeterLF).toBe(expectedPerim(1600, 1.35));
  });

  test('no square footage → null estimate', () => {
    const profile = buildEnrichedProfile(null, {}, 27.4, -82.4, null);
    expect(profile.footprint).toBe(0);
    expect(profile.estimatedPerimeterLF).toBeNull();
  });
});

describe('enriched profile attic / slab estimates', () => {
  test('attic and slab default to the ground-floor footprint', () => {
    const profile = buildEnrichedProfile(
      { squareFootage: 3000, stories: 2 },
      {},
      27.4, -82.4, null,
    );
    expect(profile.estimatedAtticSqFt).toBe(1500);
    expect(profile.estimatedSlabSqFt).toBe(1500);
  });

  test('no square footage → null attic/slab estimates', () => {
    const profile = buildEnrichedProfile(null, {}, 27.4, -82.4, null);
    expect(profile.estimatedAtticSqFt).toBeNull();
    expect(profile.estimatedSlabSqFt).toBeNull();
  });
});

describe('estimates never become authoritative pricing measurements (Codex P2s, PR #2283)', () => {
  const enriched = () => buildEnrichedProfile(
    { squareFootage: 1623, stories: 1 },
    { landscapeComplexity: 'SIMPLE' },
    27.4, -82.4, null,
  );

  test('profile does not carry measurement-shaped keys the v1 adapter forwards', () => {
    const profile = enriched();
    for (const key of [
      'perimeterLF', 'perimeterLf', 'perimeter', 'perimeterSource',
      'atticSqFt', 'atticAreaSqFt', 'rawWoodSqFt', 'woodTreatmentSqFt',
      'slabSqFt', 'foundationSqFt', 'buildingSlabSqFt', 'newConstructionSlabSqFt',
    ]) {
      expect(profile[key]).toBeUndefined();
    }
  });

  test('headless trenching pricing from the raw enriched profile gets no phantom measured perimeter', () => {
    const v1Input = translateV2CallToV1Input(enriched(), ['TRENCHING'], {});
    expect(v1Input.perimeterLF).toBeUndefined();
    expect(v1Input.perimeterSource).toBeNull();
    expect(v1Input.services.trenching.measurements.perimeterLF).toBeUndefined();
  });

  test('headless pre-slab / Bora-Care pricing from the raw enriched profile gets no phantom sqft', () => {
    const v1Input = translateV2CallToV1Input(enriched(), ['PRESLAB', 'BORACARE'], {});
    expect(v1Input.slabSqFt).toBeUndefined();
    expect(v1Input.atticSqFt).toBeUndefined();
    expect(v1Input.services.preSlabTermiticide.slabSqFt).toBeUndefined();
    expect(v1Input.services.preSlabTermiticide.measurements.slabSqFt).toBeUndefined();
    expect(v1Input.services.boraCare.atticSqFt).toBeUndefined();
    expect(v1Input.services.boraCare.measurements.atticSqFt).toBeUndefined();
  });

  test('explicit operator overrides still flow through options untouched', () => {
    const v1Input = translateV2CallToV1Input(enriched(), ['TRENCHING', 'PRESLAB'], {
      trenchingPerimeterLF: 210,
      preslabSqft: 1700,
    });
    expect(v1Input.services.trenching.measurements.perimeterLF).toBe(210);
    expect(v1Input.services.preSlabTermiticide.slabSqFt).toBe(1700);
  });
});
