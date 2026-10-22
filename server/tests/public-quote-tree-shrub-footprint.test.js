// Public quote: the Tree & Shrub open-parcel bed basis never reads the
// body's homeSqFt (unauthenticated). The route hands the pricer the footprint
// from the SERVER-SIDE lookup row only, and tells it whether such a footprint
// exists at all — absent, the pricer parks the lot-based line for review
// instead of publishing a bed inferred from a number nobody vouched for
// (Codex #6398 security r11: a 50,000 sf lot with a claimed 20,000 sf home
// stayed under the half-lot heuristic and shrank the bed and the price).
const { _internals } = require('../routes/public-quote');

const { trustedTreeShrubFootprintSqFt } = _internals;

describe('trustedTreeShrubFootprintSqFt', () => {
  test('prefers the lookup footprint, then the building, then living area per story', () => {
    expect(trustedTreeShrubFootprintSqFt({ footprintSqFt: 1850, homeSqFt: 3700, stories: 2 }, 1)).toBe(1850);
    expect(trustedTreeShrubFootprintSqFt({ buildingSqFt: 2400, homeSqFt: 9000 }, 1)).toBe(2400);
    expect(trustedTreeShrubFootprintSqFt({ homeSqFt: 3700, stories: 2 }, 1)).toBe(1850);
    expect(trustedTreeShrubFootprintSqFt({ livingAreaSqFt: 3000 }, 3)).toBe(1000);
  });

  test('the lookup row stories win over the body stories; stories clamp to 1–3', () => {
    expect(trustedTreeShrubFootprintSqFt({ homeSqFt: 3000, stories: 1 }, 3)).toBe(3000);
    expect(trustedTreeShrubFootprintSqFt({ homeSqFt: 3000 }, 9)).toBe(1000);
    expect(trustedTreeShrubFootprintSqFt({ homeSqFt: 3000 }, 0)).toBe(3000);
  });

  test('no server-measured building → null (the pricer parks the lot-based line)', () => {
    expect(trustedTreeShrubFootprintSqFt({}, 1)).toBeNull();
    expect(trustedTreeShrubFootprintSqFt(null, 1)).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ footprintSqFt: 0, homeSqFt: 0 }, 1)).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ footprintSqFt: 'n/a', homeSqFt: -5 }, 1)).toBeNull();
  });

  test('the lookup\'s own footprint wins over any derivation', () => {
    expect(trustedTreeShrubFootprintSqFt({ footprint: 1600, footprintSqFt: 1850, homeSqFt: 3700, stories: 2 }, 1)).toBe(1600);
  });

  test('a footprintUnknown lookup yields NO trusted footprint — never a reconstruction from the aggregate homeSqFt (Codex r13 P1)', () => {
    // buildEnrichedProfile suppresses the footprint of an aggregate parcel
    // whose story count is unknown but keeps the summed living area; the
    // body's homeSqFt is not an argument at all, so nothing here reads it.
    expect(trustedTreeShrubFootprintSqFt({ footprint: 0, footprintUnknown: true, homeSqFt: 48000, stories: 1 }, 1)).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ footprintSqFt: 0, footprintUnknown: true }, 1)).toBeNull();
    // A positive footprint does not override the suppression marker.
    expect(trustedTreeShrubFootprintSqFt({ footprint: 2000, footprintUnknown: true }, 1)).toBeNull();
  });
});
