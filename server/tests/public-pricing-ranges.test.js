// public-ranges must price every published service from engine constants
// alone (no DB) — a sweep error here means an engine signature changed and
// the agent-readable pricing surface would silently lose a service.
const { computePublicPricingRanges, _internals } = require('../services/pricing-engine/public-ranges');

const EXPECTED_KEYS = [
  'general_pest_quarterly',
  'cockroach_treatment',
  'german_roach_cleanout',
  // No german_roach_initial: retired 2026-10-25 (owner), never published.
  'bed_bug_treatment',
  'mosquito_program',
  'wasp_hornet_removal',
  'flea_elimination',
  'rodent_bait_program',
  'rodent_trapping',
  'rodent_sanitation',
  'rodent_exclusion',
  'termite_bait_install',
  'termite_bait_monitoring',
  'termite_trenching',
  'pre_slab_termiticide',
  'wdo_inspection',
  'lawn_care_program',
  'one_time_lawn',
  'lawn_pest_knockdown',
  'one_time_pest',
  'one_time_mosquito',
  'bora_care',
  'rodent_wire_mesh',
  'rodent_bird_boxes',
  'trap_only_retainer',
  'recurring_foam',
  'rodent_inspection',
  'rodent_guarantee',
  'dethatching',
  'foam_drill',
  'lawn_plugging',
  // No top_dressing: quote-only since 2026-10-29 (owner), never published.
  'tree_shrub_care',
  'palm_injection',
];

// Services that genuinely bill monthly — the only ones allowed a per-month unit.
const MONTHLY_BILLED_KEYS = new Set([
  'rodent_bait_program',
  'tree_shrub_care',
  'trap_only_retainer',
]);

describe('public pricing ranges', () => {
  let payload;

  beforeAll(() => {
    // Compute the baseline with both purchase gates explicitly unset so the
    // expected-key assertions don't depend on the ambient environment.
    const priorBond = process.env.GATE_TERMITE_BOND_OPTION;
    const priorRental = process.env.GATE_TERMITE_STATION_RENTAL;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_STATION_RENTAL;
    try {
      payload = computePublicPricingRanges();
    } finally {
      if (priorBond !== undefined) process.env.GATE_TERMITE_BOND_OPTION = priorBond;
      if (priorRental !== undefined) process.env.GATE_TERMITE_STATION_RENTAL = priorRental;
    }
  });


  test('rodent bait note tracks the live setup fee to the cent and disappears when the fee is disabled (codex #3591 r10 P2)', () => {
    const constants = require('../services/pricing-engine/constants');
    const original = constants.RODENT.baitSetupFee;
    try {
      constants.RODENT.baitSetupFee = 99.5;
      let row = computePublicPricingRanges({ refresh: true }).services.find((svc) => svc.key === 'rodent_bait_program');
      expect(row.notes).toContain('a one-time $99.50 setup applies only without another WaveGuard recurring service');
      constants.RODENT.baitSetupFee = 0;
      row = computePublicPricingRanges({ refresh: true }).services.find((svc) => svc.key === 'rodent_bait_program');
      expect(row.notes).not.toMatch(/setup/);
      expect(row.notes).toMatch(/station allowance by home size\.$/);
    } finally {
      constants.RODENT.baitSetupFee = original;
      computePublicPricingRanges({ refresh: true });
    }
  });

  test('every service sweeps without errors', () => {
    expect(payload.errors).toEqual([]);
  });

  test('all expected services are present exactly once', () => {
    const keys = payload.services.map((s) => s.key);
    expect(keys.sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every range is a non-negative low <= high pair', () => {
    for (const s of payload.services) {
      expect(Number.isFinite(s.low)).toBe(true);
      expect(Number.isFinite(s.high)).toBe(true);
      // Owner ruling 2026-09-27: the sweep no longer merges the $0
      // recurring-plan wasp floor into any row's values, so every published
      // low (wasp_hornet_removal included) must price above zero.
      expect(s.low).toBeGreaterThan(0);
      expect(s.high).toBeGreaterThanOrEqual(s.low);
    }
  });

  test('units obey the owner copy rules', () => {
    for (const s of payload.services) {
      const text = `${s.name} ${s.unit} ${s.notes || ''}`;
      // "per visit" is banned customer-facing copy everywhere (owner rule;
      // only commercial is exempt, and commercial is not published here).
      // Visit COUNTS ("2-visit package") are fine; the unit phrasing is not.
      expect(text).not.toMatch(/per visit|\$\s*\d[\d,.]*\s*\/\s*visit/i);
      if (s.unit === 'per month') {
        expect(MONTHLY_BILLED_KEYS.has(s.key)).toBe(true);
      }
      // No per-year/annual-total units in any spelling: even the termite
      // bond rides quarterly applications (owner copy rule: no combined
      // annual plan totals customer-facing).
      expect(s.unit).not.toMatch(/per year|annual|12[- ]month/i);
      expect(text).toBeTruthy();
    }
    const pest = payload.services.find((s) => s.key === 'general_pest_quarterly');
    expect(pest.unit).toBe('per application');
    const lawn = payload.services.find((s) => s.key === 'lawn_care_program');
    expect(lawn.unit).toBe('per application');
  });

  test('lawn notes name only the sold cadences, grammatically (6x retired 2026-09-24)', () => {
    const lawn = payload.services.find((s) => s.key === 'lawn_care_program');
    expect(lawn.notes).toMatch(/^9x or 12x applications per year by tier;/);
    expect(lawn.notes).not.toMatch(/\b6x\b/);
  });

  test('tree & shrub notes name only the sold cadences (4x/quarterly retired 2026-09-24)', () => {
    const ts = payload.services.find((s) => s.key === 'tree_shrub_care');
    expect(ts.notes).toMatch(/6 or 9 applications per year by tier/);
    expect(ts.notes).not.toMatch(/\b4,?\s*6,?\s*or\s*9\b/);
  });

  test('tree & shrub range never reflects the retired Light tier (codex pre-push P1)', () => {
    // Light (4x/quarterly) is retired and must not be swept, directly or via
    // the bundle sweep's "cheapest combo" input. On the row's own profiles
    // Light prices ABOVE the sold tiers per application (4 visits a year, up to
    // ~$156) and BELOW them per month (as low as ~$24), so a swept Light would
    // lift the published high or drop the averaged monthly low.
    const ts = payload.services.find((s) => s.key === 'tree_shrub_care');
    const sp = require('../services/pricing-engine/service-pricing');
    const light = [5400, 7000, 8900, 12700, 22500].flatMap((lotSqFt) => [
      sp.priceTreeShrub({ footprint: 1865, lotSqFt }, { tier: 'light' }),
      sp.priceTreeShrub({ footprint: 1865, lotSqFt, bedArea: 4000 }, { tier: 'light', treeCount: 6, access: 'moderate' }),
    ]);
    expect(ts.high).toBeLessThan(Math.max(...light.map((r) => r.perApp)));
    const monthlyLow = Number(ts.notes.match(/\$(\d+)-\$\d+ a month/)[1]);
    expect(monthlyLow).toBeGreaterThan(Math.min(...light.map((r) => r.monthly)));
  });

  test('tree & shrub row is priced per application, with the monthly figure only as an average', () => {
    const ts = payload.services.find((s) => s.key === 'tree_shrub_care');
    const sp = require('../services/pricing-engine/service-pricing');
    expect(ts.unit).toBe('per application');
    // Recompute the row's own sweep (standard + enhanced only; light stays retired).
    const results = [5400, 7000, 8900, 12700, 22500].flatMap((lotSqFt) =>
      ['standard', 'enhanced'].flatMap((tier) => [
        sp.priceTreeShrub({ footprint: 1865, lotSqFt }, { tier }),
        sp.priceTreeShrub({ footprint: 1865, lotSqFt, bedArea: 4000 }, { tier, treeCount: 6, access: 'moderate' }),
      ]));
    const perApp = results.map((r) => r.perApp);
    const monthly = results.map((r) => r.monthly);
    expect(ts.low).toBe(Math.floor(Math.min(...perApp)));
    expect(ts.high).toBe(Math.ceil(Math.max(...perApp)));
    const avg = `$${Math.floor(Math.min(...monthly))}-$${Math.ceil(Math.max(...monthly))} a month, averaged over the year`;
    expect(ts.notes).toContain(avg);
    expect(ts.notes).toMatch(/^Billed after each application; 6 or 9 applications per year by tier/);
    expect(ts.notes).not.toMatch(/Monthly-billed/i);
    expect(ts.notes).not.toMatch(/\/\s*mo\b/i);
    // The per-application price is the price: it sits above the monthly average.
    expect(ts.low).toBeGreaterThan(Math.floor(Math.min(...monthly)));
  });

  test('no lawn or pest combined monthly totals are published', () => {
    const lawn = payload.services.find((s) => s.key === 'lawn_care_program');
    const pest = payload.services.find((s) => s.key === 'general_pest_quarterly');
    for (const s of [lawn, pest]) {
      expect(s.unit).not.toMatch(/month/i);
      expect(`${s.name} ${s.notes || ''}`).not.toMatch(/\$\d+\s*\/\s*mo/i);
    }
  });

  test('disclaimer points agents at the exact-quote calculator', () => {
    expect(payload.disclaimer).toContain('/pest-control-calculator/');
    expect(payload.currency).toBe('USD');
    expect(new Date(payload.generatedAt).getTime()).not.toBeNaN();
  });

  test('general-pest range is a typical-home list-price range, not an envelope (owner ruling 2026-09-27)', () => {
    const sp = require('../services/pricing-engine/service-pricing');
    const pest = payload.services.find((s) => s.key === 'general_pest_quarterly');
    // A 6,000 sq ft home loaded with every add-on quotes well above a
    // typical home's price — the published HIGH must stay below it, or the
    // sweep has silently widened back into an envelope of every quote.
    const worstCase = sp.pricePestControl(
      {
        footprint: 6000,
        propertyType: 'single_family',
        attachedGarage: true,
        nearWater: true,
        features: {
          shrubs: 'heavy', trees: 'heavy', complexity: 'complex', indoor: true,
          poolCage: true, poolCageSize: 'oversized',
        },
      },
      { frequency: 'quarterly' },
    );
    const worstCasePerApp = Math.max(...worstCase.tiers.map((t) => t.perApp));
    expect(pest.high).toBeLessThan(worstCasePerApp);

    // The published LOW is the list-price typical minimum — a WaveGuard
    // bundle discount must never lower it.
    // Smallest typical footprint (10th percentile, light landscaping), list price.
    const listMin = Math.min(...sp.pricePestControl(
      { footprint: 1085, propertyType: 'single_family', features: { shrubs: 'light', trees: 'light', complexity: 'simple' } },
      { frequency: 'quarterly' },
    ).tiers.map((t) => t.perApp));
    expect(pest.low).toBe(Math.floor(listMin));
  });

  test('cache serves between syncs and refreshes when a sync applied', () => {
    // Run the identity assertion in the same gate-disabled context used for
    // the baseline, so an ambient gate value can't change the cache key.
    const priorBond = process.env.GATE_TERMITE_BOND_OPTION;
    const priorRental = process.env.GATE_TERMITE_STATION_RENTAL;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_STATION_RENTAL;
    try {
      const a = computePublicPricingRanges();
      const b = computePublicPricingRanges();
      expect(b).toBe(a); // no sync between calls — cached payload is current
      const refreshed = computePublicPricingRanges({ refresh: true });
      expect(refreshed).not.toBe(a);
      expect(refreshed.services.map((s) => s.key)).toEqual(a.services.map((s) => s.key));
    } finally {
      if (priorBond !== undefined) process.env.GATE_TERMITE_BOND_OPTION = priorBond;
      if (priorRental !== undefined) process.env.GATE_TERMITE_STATION_RENTAL = priorRental;
    }
  });

  // Gate tests must not depend on the ambient environment: explicitly unset
  // the gate for the off assertion, and restore the caller's value after.
  function withGate(gate, value, fn) {
    const prior = process.env[gate];
    if (value === undefined) delete process.env[gate];
    else process.env[gate] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[gate];
      else process.env[gate] = prior;
    }
  }

  test('termite bond publishes only while its purchase gate is on', () => {
    withGate('GATE_TERMITE_BOND_OPTION', undefined, () => {
      const ungated = computePublicPricingRanges();
      expect(ungated.services.find((s) => s.key === 'termite_bond')).toBeUndefined();
    });
    withGate('GATE_TERMITE_BOND_OPTION', 'true', () => {
      const gated = computePublicPricingRanges();
      const bond = gated.services.find((s) => s.key === 'termite_bond');
      expect(bond).toBeDefined();
      expect(bond.unit).toBe('per application');
      expect(gated.errors).toEqual([]);
    });
  });

  test('termite station rental publishes only while its purchase gate is on', () => {
    withGate('GATE_TERMITE_STATION_RENTAL', undefined, () => {
      const ungated = computePublicPricingRanges();
      expect(ungated.services.find((s) => s.key === 'termite_station_rental')).toBeUndefined();
    });
    withGate('GATE_TERMITE_STATION_RENTAL', 'true', () => {
      const gated = computePublicPricingRanges();
      const rental = gated.services.find((s) => s.key === 'termite_station_rental');
      expect(rental).toBeDefined();
      expect(rental.unit).toBe('per application');
      expect(gated.errors).toEqual([]);
    });
  });

  test('buildRows exposes sweep errors instead of throwing', () => {
    const { rows, errors } = _internals.buildRows();
    expect(Array.isArray(rows)).toBe(true);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors).toEqual([]);
  });
});
