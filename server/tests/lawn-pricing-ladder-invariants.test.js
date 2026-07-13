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
    const max = {};
    for (let sqft = 2000; sqft <= 22000; sqft += 250) {
      for (const t of soldTiers(track, sqft)) {
        if (max[t.visits] !== undefined) {
          // Same semantics the sweep uses: tolerance vs the running MAX, not
          // the adjacent size — ceil-to-per-app re-rounding can dip monthly by
          // cents (e.g. bermuda $50.25 → $50.00), but a gradual slope must
          // accumulate against the peak instead of resetting every step.
          expect(t.monthly).toBeGreaterThanOrEqual(max[t.visits] - SIZE_MONOTONE_TOLERANCE);
        }
        if (max[t.visits] === undefined || t.monthly > max[t.visits]) max[t.visits] = t.monthly;
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

  test('the mapper stamps the LAWN mechanism version, not the hardcoded engine constant', () => {
    const { v1, mapped } = lawnOnlyMapped();
    // Top-level pricingVersion is a hardcoded constant that equals the
    // pricing_version column default — stamping it is a no-op (Codex #2667
    // r4). A lawn-priced estimate must carry the lawn mechanism token.
    expect(v1.pricingVersion).toBeTruthy();
    expect(mapped.engineVersion).toBe(LAWN_PRICING_V2.pricingVersion);
    expect(mapped.engineVersion).not.toBe(v1.pricingVersion);
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


// Codex #2667 r3: the sweep's failure paths must surface as alert violations,
// never as silent greens — and gradual size-slope drift must accumulate
// against the running max instead of resetting at every adjacent step.
describe('sweep red paths — failures become alert violations, never silent greens', () => {
  // jest.doMock factories registered inside isolateModules stick to their
  // first registration, so the factories below proxy through this mutable
  // holder — each test swaps behavior here instead of re-registering mocks.
  const current = {};

  function makeDbMock() {
    const calls = { updates: [], inserts: [] };
    const dbFn = (table) => {
      const chain = {
        where: () => chain,
        update: async (payload) => {
          calls.updates.push({ table, payload });
          return 1;
        },
        insert: (payload) => ({
          onConflict: () => ({
            merge: (mergeArg) => ({
              returning: async () => {
                calls.inserts.push({ table, payload, mergeArg });
                return [{ id: 42 }];
              },
            }),
          }),
        }),
      };
      return chain;
    };
    dbFn.schema = { hasTable: async () => true };
    dbFn.raw = (sql) => ({ __raw: sql });
    return { dbFn, calls };
  }

  function loadSweep(overrides) {
    const { dbFn, calls } = makeDbMock();
    Object.assign(current, {
      dbFn,
      syncConstantsFromDB: async () => true,
      loadInventoryCostRows: async () => ({ available: false }),
      inventoryCostFromRows: () => ({}),
    }, overrides);
    let sweep;
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => new Proxy(function () {}, {
        apply: (_t, _this, args) => current.dbFn(...args),
        get: (_t, prop) => current.dbFn[prop],
      }));
      jest.doMock('../services/pricing-engine/service-pricing', () => ({
        priceLawnCare: (...args) => current.priceLawnCare(...args),
      }));
      jest.doMock('../services/pricing-engine', () => ({
        syncConstantsFromDB: (...args) => current.syncConstantsFromDB(...args),
      }));
      jest.doMock('../services/estimate-pricing-audit', () => ({
        loadInventoryCostRows: (...args) => current.loadInventoryCostRows(...args),
        inventoryCostFromRows: (...args) => current.inventoryCostFromRows(...args),
      }));
      sweep = require('../services/lawn-pricing-invariant-sweep');
    });
    return { sweep, calls };
  }

  const cleanTiers = ({ lawnSqFt }) => ({
    tiers: SOLD_VISITS.map((visits) => {
      const monthly = 100 + visits + lawnSqFt / 1000;
      return { visits, monthly, annual: monthly * 12, perApp: 50, costFloorAnnual: 600 };
    }),
  });

  test('a gradual downward slope trips size monotonicity even when every adjacent step is in tolerance', () => {
    const { sweep } = loadSweep({
      // Each 500sf step drops $0.25 — inside the $0.30 adjacent tolerance,
      // but $4+ cumulative peak-to-valley across the grid.
      priceLawnCare: ({ lawnSqFt }) => ({
        tiers: SOLD_VISITS.map((visits) => {
          const monthly = 200 + visits - ((lawnSqFt - 2000) / 500) * 0.25;
          return { visits, monthly, annual: monthly * 12, perApp: 50, costFloorAnnual: 600 };
        }),
      }),
    });
    const { violations } = sweep.scanLadderGrid();
    const sizeInversions = violations.filter((v) => v.check === 'monthly_size_inversion');
    expect(sizeInversions.length).toBeGreaterThan(0);
    expect(sizeInversions[0].detail).toContain('running max');
  });

  test('a ladder scan crash writes a critical alert instead of dying in the cron log', async () => {
    const { sweep, calls } = loadSweep({
      priceLawnCare: () => {
        throw new Error('bracket table too short for extrapolation');
      },
    });
    const result = await sweep.runLawnPricingInvariantSweep();
    expect(result.violationDetails.map((v) => v.check)).toContain('ladder_scan_failed');
    expect(calls.updates).toHaveLength(0); // no resolution
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].payload.severity).toBe('critical');
    expect(calls.inserts[0].payload.description).toContain('bracket table too short');
  });

  test('a budget-check failure is a violation — it must never resolve an open alert as a false green', async () => {
    const { sweep, calls } = loadSweep({
      priceLawnCare: cleanTiers,
      loadInventoryCostRows: async () => {
        throw new Error('schema drift: missing selected column');
      },
    });
    const result = await sweep.runLawnPricingInvariantSweep();
    expect(result.budgetCheck).toBe('error');
    expect(result.violationDetails.map((v) => v.check)).toEqual(['budget_check_failed']);
    expect(calls.updates).toHaveLength(0); // the open material-budget alert must NOT resolve
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].payload.severity).toBe('critical');
  });

  test('a clean run still resolves open alerts, and a designed skip stays a skip (control)', async () => {
    const { sweep, calls } = loadSweep({ priceLawnCare: cleanTiers });
    const result = await sweep.runLawnPricingInvariantSweep();
    expect(result.violations).toBe(0);
    expect(result.budgetCheck).toBe('skipped');
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(1); // clean run resolves any open alert
  });

  test('non-finite ladder prices are violations, never a silent clean pass', () => {
    const { sweep } = loadSweep({
      // NaN compares false against every invariant threshold — without an
      // explicit finite check this grid reads as perfectly clean.
      priceLawnCare: () => ({
        tiers: SOLD_VISITS.map((visits) => ({ visits, monthly: NaN, annual: NaN, perApp: NaN, costFloorAnnual: 600 })),
      }),
    });
    const { violations } = sweep.scanLadderGrid();
    expect(violations.length).toBeGreaterThan(0);
    expect(new Set(violations.map((v) => v.check))).toEqual(new Set(['non_finite_price']));
  });

  test('a malformed cost floor is a violation even when the market monthly stays finite', () => {
    const { sweep } = loadSweep({
      // Bad live targetCollectedMarginFloor: market pricing still yields a
      // usable monthly while costFloorAnnual is NaN — floor enforcement is
      // silently OFF and only an explicit check catches it.
      priceLawnCare: ({ lawnSqFt }) => ({
        tiers: SOLD_VISITS.map((visits) => {
          const monthly = 100 + visits + lawnSqFt / 1000;
          return { visits, monthly, annual: monthly * 12, perApp: 50, costFloorAnnual: NaN };
        }),
      }),
    });
    const { violations } = sweep.scanLadderGrid();
    expect(violations.length).toBeGreaterThan(0);
    expect(new Set(violations.map((v) => v.check))).toEqual(new Set(['malformed_cost_floor']));
  });

  test('an ok-status $0-priced rotation is unverified — zero catalog prices verify nothing', async () => {
    const { sweep, calls } = loadSweep({
      priceLawnCare: cleanTiers,
      loadInventoryCostRows: async () => ({ available: true }),
      // costLineFromUsage accepts zero-valued cost_per_unit as a priced line,
      // so this shape is reachable with all-$0 catalog rows.
      inventoryCostFromRows: () => ({ status: 'ok', totalPerVisit: 0, warnings: [] }),
    });
    const result = await sweep.runLawnPricingInvariantSweep();
    expect(result.budgetCheck).toBe('unverified');
    expect(result.violationDetails.map((v) => v.check)).toEqual(['material_budget_unverified']);
    expect(calls.updates).toHaveLength(0);
  });

  test('missing Lawn COGS mappings are unverified — prod carries the rotation, absence is an anomaly', async () => {
    const { sweep, calls } = loadSweep({
      priceLawnCare: cleanTiers,
      loadInventoryCostRows: async () => ({ available: true }),
      inventoryCostFromRows: () => ({
        status: 'missing_cogs',
        totalPerVisit: 0,
        warnings: ['No inventory COGS rows mapped'],
      }),
    });
    const result = await sweep.runLawnPricingInvariantSweep();
    expect(result.budgetCheck).toBe('unverified');
    expect(result.violationDetails.map((v) => v.check)).toEqual(['material_budget_unverified']);
    expect(calls.updates).toHaveLength(0);
  });

  test('partially costed COGS is unverified — it must not vouch for the material budget', async () => {
    const { sweep, calls } = loadSweep({
      priceLawnCare: cleanTiers,
      loadInventoryCostRows: async () => ({ available: true }),
      // status 'warning' = some mapped rows priced at $0; the positive total
      // UNDERSTATES the annual lower bound.
      inventoryCostFromRows: () => ({
        status: 'warning',
        totalPerVisit: 42.5,
        warnings: ['Prodiamine 65 WDG has no normalized cost data'],
      }),
    });
    const result = await sweep.runLawnPricingInvariantSweep();
    expect(result.budgetCheck).toBe('unverified');
    expect(result.violationDetails.map((v) => v.check)).toEqual(['material_budget_unverified']);
    expect(calls.updates).toHaveLength(0); // no false-green resolution
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].payload.severity).toBe('high'); // data-quality exception, not critical
  });

  test('an ALL-zero-cost warning rotation is unverified, not a designed skip', async () => {
    const { sweep, calls } = loadSweep({
      priceLawnCare: cleanTiers,
      loadInventoryCostRows: async () => ({ available: true }),
      // Every mapped product missing cost data: warning status AND $0 total —
      // this must hit the unverified branch, not the zero-total skip.
      inventoryCostFromRows: () => ({
        status: 'warning',
        totalPerVisit: 0,
        warnings: ['every mapped product has no normalized cost data'],
      }),
    });
    const result = await sweep.runLawnPricingInvariantSweep();
    expect(result.budgetCheck).toBe('unverified');
    expect(result.violationDetails.map((v) => v.check)).toEqual(['material_budget_unverified']);
    expect(calls.updates).toHaveLength(0);
  });

  test('a malformed live program minimum is a violation, not a silently disabled floor', () => {
    // Mutate the constants singleton in place (the sweep's lazy require
    // returns this same object) — mirrors exactly what the DB bridge's
    // unvalidated deep-merge does to live config.
    const prior = LAWN_PRICING_V2.programMinimumMonthly;
    LAWN_PRICING_V2.programMinimumMonthly = 'not-a-number';
    try {
      const { sweep } = loadSweep({ priceLawnCare: cleanTiers });
      const { violations } = sweep.scanLadderGrid();
      expect(violations.map((v) => v.check)).toEqual(['malformed_program_minimum']);
      expect(violations[0].detail).toContain('"not-a-number"');
    } finally {
      LAWN_PRICING_V2.programMinimumMonthly = prior;
    }
  });

  test('repeat alerts keep their first detected_at; only a post-resolution re-fire starts a new episode', async () => {
    const { sweep, calls } = loadSweep({
      priceLawnCare: () => {
        throw new Error('persistent ladder breakage');
      },
    });
    await sweep.runLawnPricingInvariantSweep();
    const { mergeArg } = calls.inserts[0];
    // The conflict-merge must not overwrite detected_at with the new run's
    // timestamp while the alert is still open.
    expect(mergeArg.detected_at.__raw).toContain("WHEN admin_alerts.status = 'open' THEN admin_alerts.detected_at");
    expect(mergeArg.resolved_at).toBeNull();
    expect(mergeArg.last_seen_at).toBeInstanceOf(Date);
  });
});
