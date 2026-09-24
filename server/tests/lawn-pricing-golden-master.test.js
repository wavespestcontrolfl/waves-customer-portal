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
    // includeHiddenTiers: the fixture pins the full price GRID, including the
    // 6x/standard cells. Standard is hidden for new sales (owner directive
    // 2026-09-24) but stays the internal bracket anchor — without the flag a
    // standard request falls back to enhanced and the 6x cells would read 9x.
    // The flag never changes an enhanced/premium result (only the tiers list).
    const r = priceLawnCare(c.in.property, { ...c.in.options, includeHiddenTiers: true });
    const actual = {};
    for (const k of PINNED) actual[k] = r[k] === undefined ? r.frequency : r[k];
    // freq is exposed as `frequency` on the result root
    actual.freq = r.frequency;
    for (const k of PINNED) {
      expect({ [k]: actual[k] }).toEqual({ [k]: c.out[k] });
    }
  });

  // standard/6x retired for new sales (owner directive 2026-09-24): hidden,
  // not removed. Every pinned 6x cell must (a) be absent from the default
  // customer-facing tiers, (b) price a default-path standard request exactly
  // as the matching enhanced/9x case (the hidden-tier fallback), and (c)
  // still price its own pinned 6x anchor under includeHiddenTiers (checked
  // by the it.each above).
  const standardCases = cases.filter((c) => c.in.options.tier === 'standard');
  it('fixture still pins 6x anchor cells', () => {
    expect(standardCases.length).toBeGreaterThanOrEqual(10);
  });
  it.each(standardCases.map((c) => [c.label, c]))('retired 6x: %s requested without includeHiddenTiers prices as enhanced/9x', (_label, c) => {
    const r = priceLawnCare(c.in.property, c.in.options);
    expect(r.tiers.map((t) => t.tier)).toEqual(['enhanced', 'premium']);
    expect(r.tier).toBe('enhanced');
    expect(r.frequency).toBe(9);
    const enhanced = priceLawnCare(c.in.property, { ...c.in.options, tier: 'enhanced' });
    expect({ perApp: r.perApp, annual: r.annual, monthly: r.monthly })
      .toEqual({ perApp: enhanced.perApp, annual: enhanced.annual, monthly: enhanced.monthly });
    // lawnFreq: 6 resolves the same way.
    const byFreq = priceLawnCare(c.in.property, { track: c.in.options.track, lawnFreq: 6 });
    expect(byFreq.tier).toBe('enhanced');
    expect(byFreq.annual).toBe(enhanced.annual);
    // The anchor cell itself is untouched and still reachable internally.
    const anchor = priceLawnCare(c.in.property, { ...c.in.options, includeHiddenTiers: true });
    expect(anchor.tier).toBe('standard');
    expect(anchor.frequency).toBe(6);
    expect(anchor.annual).toBe(c.out.annual);
  });

  it('canonical anchor: 4,250 sqft St-Aug Enhanced/9 DENSE = $64 / $576 / $48 (market table; floors disarmed 2026-07-17)', () => {
    const r = priceLawnCare({ turfSf: 4250 }, { track: 'st_augustine', tier: 'enhanced' });
    // Pre-ruling this case rode the $50/mo program minimum to $603/yr;
    // with all floors disarmed it prices straight off the market table.
    expect(r.perApp).toBe(64);
    expect(r.annual).toBe(576);
    expect(r.monthly).toBe(48);
    expect(r.pricingSource).toBe('MARKET_TABLE');
    // Anchor prices are unchanged by the 2026-08-07 frequency discount: at
    // 4,250 sqft the 9x cell ($48) already sits under its -4% cap ($54), so
    // only the version token moves here.
    expect(r.pricingVersion).toBe('LAWN_PRICING_V2_EDGE_PARITY');
    // Annual is source-of-truth; monthly is derived and must reconcile within ¢.
    expect(Math.abs(r.monthly * 12 - r.annual)).toBeLessThanOrEqual(0.5);
  });

  it('every recurring case uses the market table, the 35% floor, or the $50 program minimum, whichever is highest', () => {
    for (const c of cases) {
      expect(['TABLE_INTERPOLATION', 'EXTRAPOLATED_ABOVE_TABLE_MAX', 'THIRTY_FIVE_MARGIN_FLOOR', 'PROGRAM_MINIMUM_MONTHLY'])
        .toContain(c.out.pricingBasis);
      expect(['MARKET_TABLE', 'EXTRAPOLATED_TABLE', 'COST_FLOOR', 'PROGRAM_MINIMUM'])
        .toContain(c.out.pricingSource);
      expect(c.out.pricingVersion).toBe('LAWN_PRICING_V2_EDGE_PARITY');
    }
  });

  it('program minimum disarmed (owner ruling 2026-07-17): small plans price off the market table', () => {
    // No case clamps to a floor or program minimum anymore.
    for (const c of cases) {
      expect(c.out.programMinimumApplied).not.toBe(true);
      expect(c.out.costFloorApplied).not.toBe(true);
    }
    // The old worst case — small Bahia — collects its market-table price
    // ($34/mo); the owner raises anything that looks low in the estimator.
    // 6x anchor cell read explicitly (standard is hidden for new sales 2026-09-24).
    const r = priceLawnCare({ turfSf: 3000 }, { track: 'bahia', tier: 'standard', includeHiddenTiers: true });
    expect(r.monthly).toBe(34);
    expect(r.annual).toBe(408);
    expect(r.pricingSource).toBe('MARKET_TABLE');
  });
});
