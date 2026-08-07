const { priceLawnCare } = require('../services/pricing-engine');

// Profit-ordering envelope for the 2026-08-07 lawn cadence frequency discount
// (-4% 9x / -8% 12x off the 6x per-application anchor; codex #3274 r1).
//
// The discount was sized so annual profit RISES with frequency
// (12x > 9x > 6x) at every bracket CELL the caps bind on (>= 5,500 sqft).
// That claim is exact at the cells and this suite enforces it there. Between
// cells and above LAWN_TABLE_MAX_SQFT the ordering is NOT universal:
//
// - Interpolation: each tier column interpolates and rounds independently,
//   so the 9x leg can sag under the exact -4% line and earn up to $4.23/yr
//   less than 6x — measured only within 18,069–19,903 sqft. Accepted:
//   comparable inversions pre-date the discount at ~17.7k (track,size)
//   points (small lawns, where the caps never bind), and lawn floors are
//   report-only (owner 2026-07-17).
// - Extrapolation (> 20,000 sqft): incremental visit cost grows ~$28 per
//   1,000 sqft against ~$18 of capped incremental 9x revenue, so the 9x leg
//   falls behind 6x structurally — no flat -4% implementation can hold the
//   ordering there. Measured -$33.66/yr at 30,000 sqft. Discount policy for
//   >20k sqft lawns is an owner ruling, tracked on PR #3274.
//
// This suite PINS those envelopes. If a grid or cost-model change widens
// them, the numbers here must be re-measured and re-accepted deliberately —
// never loosened to make a red build green.
const TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const TABLE_MAX_SQFT = 20000;
const SWEEP_MAX_SQFT = 30000;

// Bracket cells the caps bind on (>= 5,500 sqft per the 20260807120000
// migration): the discount's sizing claim is exact here. These are the
// actual LAWN_BRACKETS row sizes — lookups at a row return the cell itself,
// no interpolation.
const BINDING_CELL_SIZES = [5500, 6000, 6500, 7000, 7500, 8000, 9000, 10000, 11000, 12000, 15000, 20000];

// Accepted envelope, measured 2026-08-07 against the shipped grid + DENSE
// default cost model.
const TABLE_SAG_MAX_DOLLARS = 4.25;
const TABLE_SAG_SQFT_RANGE = [18000, TABLE_MAX_SQFT];
const EXTRAPOLATED_SAG_MAX_DOLLARS = 34;

function profitsAt(track, lawnSqFt) {
  const result = priceLawnCare({ lawnSqFt, grassType: track }, { tier: 'standard' });
  const byVisits = {};
  for (const tier of result.tiers) {
    byVisits[tier.visits] = tier.annual - tier.costFloorDetails.annualCost;
  }
  return byVisits;
}

describe('lawn cadence frequency discount — profit ordering envelope', () => {
  it.each(TRACKS)('%s: profit rises with frequency at every binding bracket cell', (track) => {
    for (const sqft of BINDING_CELL_SIZES) {
      const p = profitsAt(track, sqft);
      expect(p[9]).toBeGreaterThan(p[6]);
      expect(p[12]).toBeGreaterThan(p[9]);
    }
  });

  it.each(TRACKS)('%s: 12x never earns under 9x at any size', (track) => {
    for (let sqft = 500; sqft <= SWEEP_MAX_SQFT; sqft += 97) {
      const p = profitsAt(track, sqft);
      expect(p[12]).toBeGreaterThanOrEqual(p[9]);
    }
  });

  it.each(TRACKS)('%s: interpolated 9x sag stays inside the accepted envelope', (track) => {
    for (let sqft = 5500; sqft <= TABLE_MAX_SQFT; sqft += 13) {
      const p = profitsAt(track, sqft);
      const sag = p[6] - p[9];
      if (sag <= 0) continue;
      expect(sag).toBeLessThanOrEqual(TABLE_SAG_MAX_DOLLARS);
      expect(sqft).toBeGreaterThanOrEqual(TABLE_SAG_SQFT_RANGE[0]);
      expect(sqft).toBeLessThanOrEqual(TABLE_SAG_SQFT_RANGE[1]);
    }
  });

  it.each(TRACKS)('%s: extrapolated 9x sag stays inside the accepted envelope', (track) => {
    for (let sqft = TABLE_MAX_SQFT + 1; sqft <= SWEEP_MAX_SQFT; sqft += 13) {
      const p = profitsAt(track, sqft);
      expect(p[6] - p[9]).toBeLessThanOrEqual(EXTRAPOLATED_SAG_MAX_DOLLARS);
    }
  });
});
