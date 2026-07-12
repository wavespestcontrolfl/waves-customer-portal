// Lawn ladder invariants + pricing provenance persistence.
//
// Property-tests the sold lawn ladder across the full track × size grid on
// code defaults (pure functions, no DB) and pins the provenance fields that
// must survive engine → v1-legacy-mapper → stored estimate blob. The shape
// invariant "per-app never increases with visits" is intentionally NOT
// asserted here — it fails on today's market bracket config and repricing it
// is an owner decision (Phase 2); the weekly sweep carries it behind
// LAWN_SWEEP_SHAPE_CHECKS until then.
const { priceLawnCare } = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');
const { scanLadderGrid, SIZE_MONOTONE_TOLERANCE } = require('../services/lawn-pricing-invariant-sweep');
const {
  lawnFrequenciesFromResultStats,
  lawnFrequenciesFromEngineResult,
} = require('../routes/estimate-public');

const TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const SOLD_VISITS = [6, 9, 12];
const SIZES = [2000, 3000, 4250, 5500, 6000, 8000, 12000, 18000, 22000];
const KNOWN_SOURCES = ['MARKET_TABLE', 'EXTRAPOLATED_TABLE', 'COST_FLOOR', 'PROGRAM_MINIMUM'];

function soldTiers(track, sqft) {
  // Track must ride the options arg (property.grassType is ignored) — with it
  // in the property, this grid silently tested st_augustine four times over.
  const res = priceLawnCare({ lawnSqFt: sqft }, { track });
  return (res.tiers || [])
    .filter((t) => SOLD_VISITS.includes(t.visits))
    .sort((a, b) => a.visits - b.visits);
}

describe('lawn ladder invariants — full track × size grid (code defaults)', () => {
  const grid = [];
  for (const track of TRACKS) for (const sqft of SIZES) grid.push([track, sqft]);

  it.each(grid)('%s @ %s sqft: three sold cadences, floor respected, monthly monotone in visits', (track, sqft) => {
    const tiers = soldTiers(track, sqft);
    expect(tiers.map((t) => t.visits)).toEqual(SOLD_VISITS);
    const programMin = Number(LAWN_PRICING_V2.programMinimumMonthly);
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      // Internal consistency: monthly and perApp derive from annual.
      expect(t.monthly).toBeCloseTo(Math.round((t.annual / 12) * 100) / 100, 2);
      expect(t.perApp).toBeCloseTo(Math.round((t.annual / t.visits) * 100) / 100, 2);
      // No sold cadence below the program minimum.
      expect(t.monthly).toBeGreaterThanOrEqual(programMin);
      // The engine never prices below its own cost floor — including the
      // cells where the floor BINDS (floor > market), which a min(market,
      // floor) comparison would wave through.
      expect(t.annual).toBeGreaterThanOrEqual(t.costFloorAnnual - 1e-9);
      if (t.costFloorApplied) {
        expect(t.annual).toBeGreaterThanOrEqual(Math.ceil(t.costFloorAnnual / t.visits) * t.visits);
      } else {
        expect(t.annual).toBeGreaterThanOrEqual(t.marketAnnual);
      }
      // Every price carries a known provenance mechanism.
      expect(KNOWN_SOURCES).toContain(t.pricingSource);
      // Monthly must increase (or hold, at the clamp) with more visits.
      if (i > 0) expect(t.monthly).toBeGreaterThanOrEqual(tiers[i - 1].monthly);
    }
  });

  it.each(TRACKS.map((t) => [t]))('%s: monthly never decreases with lawn size (any sold cadence)', (track) => {
    const prev = {};
    for (let sqft = 2000; sqft <= 22000; sqft += 250) {
      for (const t of soldTiers(track, sqft)) {
        if (prev[t.visits] !== undefined) {
          // Same tolerance the sweep uses: ceil-to-per-app re-rounding can dip
          // monthly by cents between adjacent sizes (e.g. bermuda $50.25 →
          // $50.00); anything past it is real drift.
          expect(t.monthly).toBeGreaterThanOrEqual(prev[t.visits] - SIZE_MONOTONE_TOLERANCE);
        }
        prev[t.visits] = t.monthly;
      }
    }
  });

  test('the sweep grid scan is clean on code defaults (hard checks only)', () => {
    const { violations, cellsChecked, shapeChecks } = scanLadderGrid();
    expect(shapeChecks).toBe(false); // per-app shape check stays opt-in until Phase 2 repricing
    expect(cellsChecked).toBeGreaterThan(400);
    expect(violations).toEqual([]);
  });
});

describe('pricing provenance — engine → mapper → stored estimate shape', () => {
  function lawnOnlyMapped(sqft = 5500) {
    const v1 = generateEstimate({
      lawnSqFt: sqft,
      lotSqFt: 10000,
      propertyType: 'single_family',
      services: { lawn: { track: 'st_augustine', tier: 'enhanced' } },
      paymentMethod: 'card',
    });
    const mapped = mapV1ToLegacyShape(v1);
    return { v1, mapped, R: mapped.results };
  }

  test('the mapper carries the engine version for the pricing_version column stamp', () => {
    const { v1, mapped } = lawnOnlyMapped();
    expect(v1.pricingVersion).toBeTruthy();
    expect(mapped.engineVersion).toBe(v1.pricingVersion);
  });

  test('every stored lawn tier row carries mechanism + dollar provenance', () => {
    const { R } = lawnOnlyMapped();
    expect(R.lawn.length).toBeGreaterThanOrEqual(3);
    for (const row of R.lawn) {
      expect(KNOWN_SOURCES).toContain(row.pricingSource);
      expect(row.prov).toEqual(expect.objectContaining({
        marketMonthly: expect.any(Number),
        marketAnnual: expect.any(Number),
        costFloorAnnual: expect.any(Number),
        programMinimumApplied: expect.any(Boolean),
      }));
      expect(row.prov.margin).toEqual(expect.any(Number));
    }
  });

  test('lawnMeta persists version, mode, market reference, cost breakdown and margin', () => {
    const { R } = lawnOnlyMapped();
    expect(R.lawnMeta).toEqual(expect.objectContaining({
      pricingVersion: LAWN_PRICING_V2.pricingVersion,
      pricingMode: LAWN_PRICING_V2.pricingMode,
      costFloorApplied: expect.any(Boolean),
      programMinimumApplied: expect.any(Boolean),
      margin: expect.any(Number),
    }));
    expect(R.lawnMeta.marketReference).toEqual(expect.objectContaining({
      monthly: expect.any(Number),
      annual: expect.any(Number),
      source: expect.any(String),
    }));
    expect(R.lawnMeta.costs).toEqual(expect.objectContaining({
      annualMaterial: expect.any(Number),
      annualLabor: expect.any(Number),
      total: expect.any(Number),
    }));
  });
});

describe('healthy lawn estimate shows all three sold cadences end-to-end', () => {
  // The audit found no test walked a REAL engine result (not a hand-built
  // fixture) through to the customer-facing cadence ladder. Both display
  // paths — live engine result and stored legacy rows — must offer 6/9/12.
  function realEngineRun(sqft) {
    return generateEstimate({
      lawnSqFt: sqft,
      lotSqFt: 12000,
      propertyType: 'single_family',
      services: { lawn: { track: 'st_augustine', tier: 'enhanced' } },
      paymentMethod: 'card',
    });
  }

  it.each([[3000], [5500], [12000]])('engine-result path @ %s sqft offers 6/9/12 with positive prices', (sqft) => {
    const freqs = lawnFrequenciesFromEngineResult(realEngineRun(sqft));
    expect(freqs.map((f) => f.visitsPerYear)).toEqual([6, 9, 12]);
    for (const f of freqs) {
      expect(f.monthly).toBeGreaterThan(0);
      expect(f.annual).toBeGreaterThan(0);
      expect(f.perTreatment).toBeGreaterThan(0);
    }
    expect(freqs.filter((f) => f.selected)).toHaveLength(1);
  });

  it.each([[3000], [5500], [12000]])('stored-rows path @ %s sqft offers 6/9/12 with positive prices', (sqft) => {
    const { results } = mapV1ToLegacyShape(realEngineRun(sqft));
    const freqs = lawnFrequenciesFromResultStats({ results: { lawn: results.lawn } });
    expect(freqs.map((f) => f.visitsPerYear)).toEqual([6, 9, 12]);
    for (const f of freqs) {
      expect(f.monthly).toBeGreaterThan(0);
      expect(f.annual).toBeGreaterThan(0);
    }
  });
});
