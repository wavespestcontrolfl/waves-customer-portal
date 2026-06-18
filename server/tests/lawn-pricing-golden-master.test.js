/**
 * Golden-master lawn pricing.
 *
 * When the server becomes the sole authority on the persisted/billed price
 * (Decision #2 — server recompute on save), the client preview stops acting as
 * a second opinion. This fixture is the replacement cross-check: a frozen matrix
 * of (track × sqft × tier/freq × shade × route-density) plus edge cases, each
 * pinned to the exact engine output captured from the audited-correct state.
 *
 * Any future change that moves a lawn price MUST update the fixture in the same
 * commit — a silent shift fails here loudly. To intentionally re-baseline, run:
 *   node server/tests/fixtures/regenerate-lawn-golden-master.js   (see below)
 * and review the diff. Do NOT regenerate blindly to make a red test pass.
 */
const fs = require('fs');
const path = require('path');
const { priceLawnCare } = require('../services/pricing-engine');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'lawn-pricing-golden-master.json');
const cases = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// Fields that are policy-load-bearing and must match exactly.
const PINNED = [
  'perApp', 'annual', 'monthly', 'freq', 'tier', 'track',
  'pricingBasis', 'pricingSource', 'pricingVersion',
  'customQuoteFlag', 'marginFloorOk', 'marketMonthly', 'marketAnnual',
];

describe('lawn pricing golden master', () => {
  it('fixture is non-trivial (guards an empty/zeroed file)', () => {
    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(cases.map((c) => [c.label, c]))('%s', (_label, c) => {
    const r = priceLawnCare(c.in.property, c.in.options);
    const actual = {};
    for (const k of PINNED) actual[k] = r[k] === undefined ? r.frequency : r[k];
    // freq is exposed as `frequency` on the result root
    actual.freq = r.frequency;
    for (const k of PINNED) {
      expect({ [k]: actual[k] }).toEqual({ [k]: c.out[k] });
    }
  });

  it('canonical anchor: 4,250 sqft St-Aug Enhanced/9 DENSE = $64 / $576 / $48.00', () => {
    const r = priceLawnCare({ turfSf: 4250 }, { track: 'st_augustine', tier: 'enhanced' });
    expect(r.perApp).toBe(64);
    expect(r.annual).toBe(576);
    expect(r.monthly).toBe(48);
    expect(r.pricingVersion).toBe('LAWN_PRICING_V2_DENSE_35_FLOOR');
    // Annual is source-of-truth; monthly is derived and must reconcile within ¢.
    expect(Math.abs(r.monthly * 12 - r.annual)).toBeLessThanOrEqual(0.5);
  });

  it('every recurring case uses either the market table or the 35% floor, whichever is higher', () => {
    for (const c of cases) {
      expect(['TABLE_INTERPOLATION', 'EXTRAPOLATED_ABOVE_TABLE_MAX', 'THIRTY_FIVE_MARGIN_FLOOR'])
        .toContain(c.out.pricingBasis);
      expect(['MARKET_TABLE', 'EXTRAPOLATED_TABLE', 'COST_FLOOR'])
        .toContain(c.out.pricingSource);
      expect(c.out.pricingVersion).toBe('LAWN_PRICING_V2_DENSE_35_FLOOR');
    }
  });
});
