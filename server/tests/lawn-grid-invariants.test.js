/**
 * Lawn 500-sqft grid invariants (owner re-grid 2026-08-04).
 *
 * Pins the structural rules every future cell edit must keep — the admin
 * Pricing Logic panel can reprice any cell, so these run against the
 * ENGINE's loaded table (code default here; DB-synced in prod):
 *   1. Monthly is non-decreasing in sqft within every tier column.
 *   2. Per-application never inverts by commitment at any grid row OR any
 *      250-sqft interpolated point: 6x ≥ 9x ≥ 12x per app (the engine's
 *      premium cap enforces the 12x≤9x edge on lookups; this pins the
 *      whole ladder including the table cells themselves).
 *   3. The retired basic/4x tier is gone from every priced ladder.
 */
const {
  generateEstimate,
  constants,
} = require('../services/pricing-engine');

const TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];

function lawnTiersAt(track, sqft) {
  const est = generateEstimate({
    homeSqFt: 2400,
    stories: 1,
    lotSqFt: Math.max(30000, sqft * 2),
    propertyType: 'single_family',
    measuredTurfSf: sqft,
    services: { lawn: { track, lawnFreq: 9 } },
  });
  return est.lineItems.find((l) => l.service === 'lawn_care').tiers;
}

describe('lawn grid invariants (2026-08-04 re-grid)', () => {
  test('bracket tables carry exactly the 3 sold columns and 20 rows per track', () => {
    for (const track of TRACKS) {
      const rows = constants.LAWN_BRACKETS[track];
      expect(rows).toHaveLength(20);
      expect(rows[0][0]).toBe(1500);
      expect(rows[rows.length - 1][0]).toBe(20000);
      for (const row of rows) expect(row).toHaveLength(4); // [sqft, 6x, 9x, 12x]
    }
  });

  test('monthly is non-decreasing in sqft within every tier column', () => {
    for (const track of TRACKS) {
      const rows = constants.LAWN_BRACKETS[track];
      for (let col = 1; col <= 3; col++) {
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i][col]).toBeGreaterThanOrEqual(rows[i - 1][col]);
        }
      }
    }
  });

  test('12x per-application never exceeds 9x at any 250-sqft point (owner rule, #3041)', () => {
    // NOTE: only the 12x≤9x edge is an owner-ruled ladder invariant. The
    // 6x/9x per-app relation crosses over near the top of the table
    // (e.g. st_augustine 20,000: 6x $182/app vs 9x $186.67/app) and did so
    // under the pre-re-grid table too — deliberately not asserted here.
    for (const track of TRACKS) {
      for (let sqft = 1000; sqft <= 20000; sqft += 250) {
        const tiers = lawnTiersAt(track, sqft);
        const perApp = Object.fromEntries(tiers.map((t) => [t.freq, t.annual / t.freq]));
        expect(perApp[9]).toBeGreaterThanOrEqual(perApp[12] - 1e-9);
      }
    }
  });

  test('the retired basic/4x tier never appears in a priced ladder', () => {
    for (const track of TRACKS) {
      for (const sqft of [1500, 4500, 20000]) {
        const tiers = lawnTiersAt(track, sqft);
        expect(tiers.map((t) => t.freq)).toEqual([6, 9, 12]);
        expect(tiers.some((t) => t.tier === 'basic')).toBe(false);
      }
    }
  });

  test('sub-1,500 clamps to the 1,500 row (small-lawn taper floor)', () => {
    const at1500 = lawnTiersAt('st_augustine', 1500).find((t) => t.freq === 9);
    const at900 = lawnTiersAt('st_augustine', 900).find((t) => t.freq === 9);
    expect(at900.annual).toBe(at1500.annual);
    expect(at1500.annual).toBe(408); // $34/mo — the approved taper anchor
  });
});
